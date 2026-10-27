/**
 * Canvas 渲染器 —— 双层设计
 *
 * 为什么不直接用一个 canvas？
 *   本地正在拖动的笔迹必须 60fps 跟手，一旦被网络更新打断就会卡顿；
 *   所以拆成两层：
 *     - base：只画已提交到 CRDT 的笔迹，仅在远端更新 / 本地提交时重绘（节流）
 *     - draft：画当前这一笔的预览，每帧重绘，不参与重绘调度
 *
 * 另外做了：
 *   - devicePixelRatio 适配，避免高分屏模糊
 *   - 视口裁剪：只绘制可视区域内的笔迹，笔迹多了也不掉帧
 *   - 缩放平移：wheel + space 拖拽
 */
export class Renderer {
  constructor(baseCanvas, draftCanvas) {
    this.base = baseCanvas
    this.draft = draftCanvas
    this.bctx = baseCanvas.getContext('2d')
    this.dctx = draftCanvas.getContext('2d')
    this.scale = 1
    this.offset = { x: 0, y: 0 }
    this.dpr = window.devicePixelRatio || 1
    this.strokes = []
    this.texts = []
    this._pending = false
    this.resize()
  }

  resize() {
    const rect = this.base.getBoundingClientRect()
    const w = rect.width
    const h = rect.height
    this.width = w
    this.height = h
    this.dpr = window.devicePixelRatio || 1
    for (const c of [this.base, this.draft]) {
      c.width = Math.floor(w * this.dpr)
      c.height = Math.floor(h * this.dpr)
    }
    this.bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.dctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.schedule()
  }

  toWorld(clientX, clientY) {
    const r = this.base.getBoundingClientRect()
    return {
      x: (clientX - r.left - this.offset.x) / this.scale,
      y: (clientY - r.top - this.offset.y) / this.scale
    }
  }

  toScreen(pt) {
    return {
      x: pt.x * this.scale + this.offset.x,
      y: pt.y * this.scale + this.offset.y
    }
  }

  zoomAt(clientX, clientY, factor) {
    const before = this.toWorld(clientX, clientY)
    this.scale = Math.min(4, Math.max(0.2, this.scale * factor))
    const after = this.toWorld(clientX, clientY)
    this.offset.x += (after.x - before.x) * this.scale
    this.offset.y += (after.y - before.y) * this.scale
    this.schedule()
  }

  pan(dx, dy) {
    this.offset.x += dx
    this.offset.y += dy
    this.schedule()
  }

  resetView() {
    this.scale = 1
    this.offset = { x: 0, y: 0 }
    this.schedule()
  }

  /** 合并一帧内的多次数据变更，避免高频更新打爆主线程 */
  schedule() {
    if (this._pending) return
    this._pending = true
    requestAnimationFrame(() => {
      this._pending = false
      this.drawBase()
    })
  }

  setData(strokes, texts) {
    this.strokes = strokes
    this.texts = texts
    this.schedule()
  }

  drawBase() {
    const ctx = this.bctx
    ctx.save()
    ctx.clearRect(0, 0, this.width, this.height)
    ctx.translate(this.offset.x, this.offset.y)
    ctx.scale(this.scale, this.scale)

    // 可视区域裁剪
    const view = {
      x0: -this.offset.x / this.scale,
      y0: -this.offset.y / this.scale,
      x1: (this.width - this.offset.x) / this.scale,
      y1: (this.height - this.offset.y) / this.scale
    }

    for (const s of this.strokes) {
      if (!inView(s, view)) continue
      drawStroke(ctx, s)
    }

    for (const t of this.texts) {
      ctx.fillStyle = t.color || '#1f2430'
      ctx.font = `${t.size || 20}px system-ui, sans-serif`
      ctx.textBaseline = 'top'
      t.text.split('\n').forEach((line, i) => {
        ctx.fillText(line, t.pos.x, t.pos.y + i * (t.size || 20) * 1.3)
      })
    }
    ctx.restore()
  }

  /** 预览层：只画当前这一笔，每帧清空重画 */
  drawDraft(stroke) {
    const ctx = this.dctx
    ctx.save()
    ctx.clearRect(0, 0, this.width, this.height)
    ctx.translate(this.offset.x, this.offset.y)
    ctx.scale(this.scale, this.scale)
    if (stroke) drawStroke(ctx, stroke)
    ctx.restore()
  }
}

function inView(s, v) {
  if (s.points.length === 0) return false
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of s.points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const pad = (s.width || 3) + 20
  return !(maxX + pad < v.x0 || minX - pad > v.x1 || maxY + pad < v.y0 || minY - pad > v.y1)
}

function drawStroke(ctx, s) {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = s.color || '#1f2430'
  ctx.lineWidth = s.width || 3
  ctx.globalAlpha = s.opacity ?? 1

  const pts = s.points
  if (pts.length === 1) {
    ctx.beginPath()
    ctx.arc(pts[0].x, pts[0].y, (s.width || 3) / 2, 0, Math.PI * 2)
    ctx.fillStyle = s.color || '#1f2430'
    ctx.fill()
    return
  }

  if (s.type === 'rect' || s.type === 'ellipse') {
    const x = Math.min(pts[0].x, pts[pts.length - 1].x)
    const y = Math.min(pts[0].y, pts[pts.length - 1].y)
    const w = Math.abs(pts[pts.length - 1].x - pts[0].x)
    const h = Math.abs(pts[pts.length - 1].y - pts[0].y)
    ctx.beginPath()
    if (s.type === 'rect') ctx.rect(x, y, w, h)
    else ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
    ctx.stroke()
    return
  }

  if (s.type === 'line') {
    ctx.beginPath()
    ctx.moveTo(pts[0].x, pts[0].y)
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y)
    ctx.stroke()
    return
  }

  // 自由笔迹：用二次贝塞尔平滑，避免锯齿
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2
    const my = (pts[i].y + pts[i + 1].y) / 2
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my)
  }
  const last = pts[pts.length - 1]
  ctx.lineTo(last.x, last.y)
  ctx.stroke()
  ctx.globalAlpha = 1
}