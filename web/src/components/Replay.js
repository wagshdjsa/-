/**
 * 历史回放 —— 从服务端拉取操作日志，渐进式重放到独立 Y.Doc。
 *
 * 关键点：不复用当前协作文档，否则回放会污染线上状态。
 * 每步之间用 rAF 让浏览器有机会绘制，形成"重放动画"。
 */
import * as Y from 'yjs'

export async function fetchFrames(room, n = 300) {
  const res = await fetch(`/api/rooms/${encodeURIComponent(room)}/history?n=${n}`)
  if (!res.ok) throw new Error(`拉取历史失败: ${res.status}`)
  return res.json()
}

export class ReplaySession {
  /**
   * @param {object} frames fetchFrames 返回的 frames 数组
   * @param {Function} onStep 每步回调(stepIndex, total, docSnapshot, meta)
   */
  constructor(frames, onStep, onDone) {
    this.frames = frames
    this.onStep = onStep
    this.onDone = onDone
    this.doc = new Y.Doc()
    this.step = 0
    this.playing = false
    this.timer = null
    this.speed = 8 // 每秒帧数
    this.startedAt = 0
  }

  get total() { return this.frames.length }

  play() {
    if (this.playing || this.total === 0) return
    this.playing = true
    this.startedAt = performance.now()
    const tick = () => {
      if (!this.playing) return
      if (this.step >= this.total) {
        this.pause()
        this.onDone?.()
        return
      }
      const f = this.frames[this.step]
      Y.applyUpdate(this.doc, new Uint8Array(atob(f.update)))
      this.step++
      this.onStep?.(this.step, this.total, this.snapshot(), f)
      this.timer = setTimeout(tick, 1000 / this.speed)
    }
    this.timer = setTimeout(tick, 0)
  }

  pause() {
    this.playing = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  stepOnce() {
    if (this.step >= this.total) return
    const f = this.frames[this.step]
    Y.applyUpdate(this.doc, new Uint8Array(atob(f.update)))
    this.step++
    this.onStep?.(this.step, this.total, this.snapshot(), f)
  }

  seek(targetStep) {
    // 回退需要重建：CRDT 文档无法"撤销"已合并的更新
    const target = Math.max(0, Math.min(targetStep, this.total))
    if (target < this.step) {
      this.doc = new Y.Doc()
      this.step = 0
      while (this.step < target) {
        Y.applyUpdate(this.doc, new Uint8Array(atob(this.frames[this.step].update)))
        this.step++
      }
    } else {
      while (this.step < target) this.stepOnce()
    }
    this.onStep?.(this.step, this.total, this.snapshot(), this.frames[this.step - 1])
  }

  snapshot() {
    return {
      strokes: this.doc.getArray('strokes').toArray(),
      texts: collectTexts(this.doc.getMap('texts'))
    }
  }

  destroy() {
    this.pause()
    this.doc.destroy()
  }
}

function collectTexts(textsMap) {
  const out = []
  textsMap.forEach((v, k) => {
    if (k.endsWith('__pos')) return
    out.push({ id: k, text: v.toString(), pos: textsMap.get(`${k}__pos`) ?? { x: 0, y: 0 } })
  })
  return out
}