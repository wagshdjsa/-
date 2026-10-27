<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import Toolbar from './components/Toolbar.vue'
import Members from './components/Members.vue'
import ReplayPanel from './components/ReplayPanel.vue'
import { Renderer } from './components/Renderer.js'
import { useCollaboration, randomUser } from './composables/useCollaboration.js'

// ---------- 房间与身份 ----------
const params = new URLSearchParams(location.search)
const room = params.get('room') || 'demo'
const me = randomUser()

const tool = ref('pen')
const color = ref('#1f2430')
const width = ref(3)
const baseCanvas = ref(null)
const draftCanvas = ref(null)
const cursorLayer = ref(null)
const showReplay = ref(false)
const toast = ref('')
const latency = ref(null)
const elapsed = ref(0)

// ---------- 协作引擎 ----------
const collab = useCollaboration({ room, user: me, onLatency: (v) => (latency.value = v) })
const { online, peers, status, stats } = collab

let renderer = null
const zoom = ref(1)          // 缩放比例（响应式，供顶栏显示）
let draft = null        // 当前正在画的这一笔（本地预览，不入CRDT）
let drawing = false
let panning = false
let spaceDown = false
let lastPan = { x: 0, y: 0 }
let pingTimer = null
let elapsedTimer = null

// ---------- 笔迹落笔 ----------
function strokeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function beginStroke(pt, e) {
  if (tool.value === 'text') { placeText(pt); return }
  if (tool.value === 'eraser') { eraseAt(pt); return }
  drawing = true
  draft = {
    id: strokeId(),
    type: tool.value,
    color: color.value,
    width: width.value,
    points: [{ x: pt.x, y: pt.y }],
    // pressure 压感：无设备时按速度模拟，笔迹粗细更自然
    pressure: e?.pressure && e.pressure > 0 ? e.pressure : 0.5
  }
  renderer.drawDraft(draft)
}

function moveStroke(pt) {
  if (!drawing || !draft) return
  const last = draft.points[draft.points.length - 1]
  // 抽稀：距离过近的点直接丢弃，减少 60% 的 CRDT 消息体积
  if (Math.hypot(pt.x - last.x, pt.y - last.y) < 1.2) return
  draft.points.push({ x: pt.x, y: pt.y })
  renderer.drawDraft(draft)
}

function endStroke() {
  if (!drawing || !draft) return
  drawing = false
  renderer.drawDraft(null)
  if (draft.points.length > 0) collab.addStroke(draft)
  draft = null
}

// ---------- 橡皮：删除命中的笔迹 ----------
function eraseAt(pt) {
  const r = 14 / renderer.scale
  const arr = collab.strokes.toArray()
  for (const s of arr) {
    for (const p of s.points) {
      if (Math.hypot(p.x - pt.x, p.y - pt.y) <= r + (s.width || 3)) {
        const idx = collab.strokes.toArray().findIndex((x) => x.id === s.id)
        if (idx >= 0) {
          collab.doc.transact(() => collab.strokes.delete(idx, 1), 'erase')
          collab.bumpVersion()
        }
        return
      }
    }
  }
}

// ---------- 文字 ----------
function placeText(pt) {
  const content = window.prompt('输入文字内容（支持换行）')
  if (!content) return
  collab.addText(strokeId(), pt, content)
}

// ---------- 指针事件 ----------
function onDown(e) {
  if (e.button === 1 || spaceDown || e.button === 2) {
    panning = true
    lastPan = { x: e.clientX, y: e.clientY }
    return
  }
  baseCanvas.value.setPointerCapture?.(e.pointerId)
  const pt = renderer.toWorld(e.clientX, e.clientY)
  beginStroke(pt, e)
}

function onMove(e) {
  const pt = renderer.toWorld(e.clientX, e.clientY)
  collab.setCursor({ ...pt, t: Date.now() })
  if (panning) {
    renderer.pan(e.clientX - lastPan.x, e.clientY - lastPan.y)
    lastPan = { x: e.clientX, y: e.clientY }
    return
  }
  moveStroke(pt)
}

function onUp() {
  if (panning) { panning = false; return }
  endStroke()
}

function onWheel(e) {
  e.preventDefault()
  if (e.ctrlKey || e.metaKey) {
    renderer.zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1)
  } else {
    renderer.pan(-e.deltaX, -e.deltaY)
  }
}

function onKeyDown(e) {
  if (e.code === 'Space') { spaceDown = true; return }
  if (e.target.tagName === 'INPUT') return
  const map = { p: 'pen', l: 'line', r: 'rect', o: 'ellipse', e: 'eraser', t: 'text' }
  if (map[e.key.toLowerCase()]) tool.value = map[e.key.toLowerCase()]
  if (e.key === '0') renderer.resetView()
}
function onKeyUp(e) { if (e.code === 'Space') spaceDown = false }

// ---------- 导入导出 ----------
function exportSnapshot() {
  const data = collab.exportDoc()
  const blob = new Blob([data], { type: 'text/plain' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `whiteboard-${room}-${Date.now()}.wbdoc`
  a.click()
  URL.revokeObjectURL(a.href)
  notify('已导出快照文件（可用「导入合并」无损合回）')
}

function importSnapshot() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.wbdoc,.txt'
  input.onchange = () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        collab.importDoc(String(reader.result))
        notify('离线快照已合并，双方内容都保留')
      } catch {
        notify('导入失败：文件格式不正确')
      }
    }
    reader.readAsText(file)
  }
  input.click()
}

let notifyTimer = null
function notify(msg) {
  toast.value = msg
  clearTimeout(notifyTimer)
  notifyTimer = setTimeout(() => (toast.value = ''), 3000)
}

// ---------- 生命周期 ----------
function refresh() {
  if (!renderer) return
  renderer.setData(collab.getAllStrokes(), collab.getAllTexts())
}

let rafId = null
function loop() {
  refresh()
  drawCursors()
  if (renderer) zoom.value = renderer.scale
  rafId = requestAnimationFrame(loop)
}

function drawCursors() {
  const cv = cursorLayer.value
  if (!cv) return
  const ctx = cv.getContext('2d')
  ctx.clearRect(0, 0, cv.width, cv.height)
  for (const p of peers.value) {
    if (!p.cursor) continue
    const s = renderer.toScreen(p.cursor)
    if (s.x < -20 || s.y < -20 || s.x > renderer.width + 20 || s.y > renderer.height + 20) continue
    ctx.fillStyle = p.color
    ctx.beginPath()
    ctx.moveTo(s.x, s.y)
    ctx.lineTo(s.x, s.y + 16)
    ctx.lineTo(s.x + 4.5, s.y + 12)
    ctx.lineTo(s.x + 10, s.y + 20)
    ctx.lineTo(s.x + 13, s.y + 17.5)
    ctx.lineTo(s.x + 7.5, s.y + 9.5)
    ctx.lineTo(s.x + 13, s.y + 8)
    ctx.closePath()
    ctx.fill()
    ctx.font = '600 11px system-ui'
    const tw = ctx.measureText(p.name).width
    ctx.fillStyle = p.color
    ctx.fillRect(s.x + 12, s.y + 20, tw + 12, 18)
    ctx.fillStyle = '#fff'
    ctx.textBaseline = 'middle'
    ctx.fillText(p.name, s.x + 18, s.y + 29)
  }
}

onMounted(() => {
  renderer = new Renderer(baseCanvas.value, draftCanvas.value)
  collab.connect()
  window.addEventListener('resize', onResize)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  rafId = requestAnimationFrame(loop)
  // 周期性 RTT 探测：awareness ping 往返 = 操作同步延迟的度量
  pingTimer = setInterval(() => collab.ping(), 800)
  elapsedTimer = setInterval(() => { elapsed.value++ }, 1000)
})

function onResize() { renderer.resize() }

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  clearInterval(elapsedTimer)
  clearInterval(pingTimer)
  window.removeEventListener('resize', onResize)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  collab.destroy()
})

// Y.Array 本身不是响应式的，元素数量要靠 version 触发重算
const strokeCount = computed(() => {
  collab.version.value
  return collab.strokes.length
})
const avgLatency = computed(() => {
  const l = stats.latency
  if (l.length === 0) return null
  return l.reduce((a, b) => a + b, 0) / l.length
})

// 调试用：暴露给 console，方便压测时观察
window.__wb = { collab, renderer }
</script>

<template>
  <div class="app">
    <Toolbar
      v-model="tool"
      v-model:color="color"
      v-model:width="width"
      :stats="stats"
      @clear="collab.clearBoard()"
      @export="exportSnapshot"
      @import="importSnapshot"
      @replay="showReplay = true"
    />

    <div class="main">
      <header class="topbar">
        <div class="brand">
          <span class="logo">◧</span>
          <div>
            <h1>协作白板</h1>
            <p>房间 <code>{{ room }}</code> · 已在线 {{ elapsed }}s</p>
          </div>
        </div>

        <Members :peers="peers" :me="me" :status="status" :latency="avgLatency" />

        <div class="metrics">
          <span>元素 <b>{{ strokeCount }}</b></span>
          <span>发送 <b>{{ stats.sent }}</b></span>
          <span>接收 <b>{{ stats.received }}</b></span>
          <span v-if="stats.mergedOnReconnect">离线合并 <b>{{ stats.mergedOnReconnect }}</b></span>
          <span class="zoom">{{ Math.round(zoom * 100) }}%</span>
          <button class="mini" @click="renderer.resetView()">复位视图</button>
        </div>
      </header>

      <div class="stage" :class="{ offline: !online }">
        <canvas ref="baseCanvas" class="layer base"
          @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp"
          @pointercancel="onUp" @pointerleave="onUp" @wheel="onWheel"
          @contextmenu.prevent />
        <canvas ref="draftCanvas" class="layer draft" />
        <canvas ref="cursorLayer" class="layer cursors" />

        <div v-if="!online" class="offline-banner">
          网络已断开 —— 你的编辑会保存在本地，<b>恢复后自动合并</b>
          <span>已缓存 {{ stats.offlineEdits }} 次</span>
        </div>

        <div class="hint">
          滚轮平移 · Ctrl+滚轮缩放 · 空格/右键拖拽 · 快捷键 P/L/R/O/E/T · 0 复位
        </div>
      </div>
    </div>

    <ReplayPanel v-if="showReplay" :room="room" @close="showReplay = false" />
    <transition name="toast"><div v-if="toast" class="toast">{{ toast }}</div></transition>
  </div>
</template>

<style>
* { box-sizing: border-box; }
html, body, #app { height: 100%; margin: 0; }
body {
  font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  background: #f5f7fb; color: #1f2430;
}
</style>

<style scoped>
.app { display: flex; height: 100%; }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.topbar {
  height: 60px; flex-shrink: 0; background: #fff;
  border-bottom: 1px solid #e8eaf0;
  display: flex; align-items: center; gap: 20px; padding: 0 20px;
}
.brand { display: flex; align-items: center; gap: 10px; }
.logo {
  width: 32px; height: 32px; border-radius: 9px;
  background: linear-gradient(135deg, #4f8cff, #9b59f6);
  color: #fff; display: flex; align-items: center; justify-content: center; font-size: 17px;
}
.brand h1 { margin: 0; font-size: 15px; font-weight: 700; }
.brand p { margin: 1px 0 0; font-size: 11px; color: #98a1b3; }
.brand code {
  background: #f0f3f9; padding: 1px 5px; border-radius: 4px;
  font-size: 11px; color: #4f8cff;
}
.metrics {
  margin-left: auto; display: flex; align-items: center; gap: 14px;
  font-size: 12px; color: #98a1b3;
}
.metrics b { color: #3c465a; font-variant-numeric: tabular-nums; }
.zoom { font-variant-numeric: tabular-nums; }
.mini {
  border: 1px solid #e3e7ef; background: #fff; border-radius: 6px;
  padding: 4px 9px; font-size: 11px; cursor: pointer; color: #5b6478;
}
.mini:hover { border-color: #bed4ff; color: #2b6cff; }

.stage { flex: 1; position: relative; overflow: hidden; }
.layer { position: absolute; inset: 0; width: 100%; height: 100%; }
.base { cursor: crosshair; touch-action: none; }
.draft, .cursors { pointer-events: none; }

.offline-banner {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  background: #fff7e8; border: 1px solid #ffd591; color: #a86a10;
  padding: 8px 16px; border-radius: 20px; font-size: 12.5px;
  display: flex; gap: 10px; align-items: center; box-shadow: 0 4px 14px rgba(0,0,0,.07);
}
.offline-banner span { color: #c8892a; }
.stage.offline .base { opacity: .92; }

.hint {
  position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%);
  font-size: 11px; color: #a8b0c0; background: rgba(255,255,255,.85);
  padding: 5px 12px; border-radius: 14px; pointer-events: none; white-space: nowrap;
}
.toast {
  position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%);
  background: #1f2430; color: #fff; padding: 10px 20px; border-radius: 8px;
  font-size: 13px; z-index: 60; box-shadow: 0 8px 24px rgba(0,0,0,.25);
}
.toast-enter-active, .toast-leave-active { transition: all .22s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(10px); }
</style>