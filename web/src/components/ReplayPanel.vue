<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { fetchFrames, ReplaySession } from './Replay.js'

const cv = ref(null)

/** 把回放快照画到预览canvas上（与主画板共用同一套绘制规则） */
function paint(canvas, snap) {
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth || 900
  const h = canvas.clientHeight || 420
  canvas.width = Math.floor(w * dpr)
  canvas.height = Math.floor(h * dpr)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)

  // 自动缩放以容纳全部内容
  const all = snap.strokes
  if (all.length === 0) {
    ctx.fillStyle = '#c2c9d6'
    ctx.font = '13px system-ui'
    ctx.textAlign = 'center'
    ctx.fillText('（该时间点画板为空）', w / 2, h / 2)
    ctx.textAlign = 'left'
    return
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of all) {
    for (const p of s.points) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  for (const t of snap.texts) {
    minX = Math.min(minX, t.pos.x); minY = Math.min(minY, t.pos.y)
    maxX = Math.max(maxX, t.pos.x + 200); maxY = Math.max(maxY, t.pos.y + 30)
  }
  const pad = 40
  const scale = Math.min(
    (w - pad * 2) / Math.max(1, maxX - minX),
    (h - pad * 2) / Math.max(1, maxY - minY),
    2
  )
  ctx.translate((w - (maxX - minX) * scale) / 2 - minX * scale,
    (h - (maxY - minY) * scale) / 2 - minY * scale)
  ctx.scale(scale, scale)

  drawStrokeList(ctx, all)
  ctx.fillStyle = '#1f2430'
  for (const t of snap.texts) {
    ctx.font = `${t.size || 20}px system-ui`
    ctx.textBaseline = 'top'
    t.text.split('\n').forEach((line, i) => ctx.fillText(line, t.pos.x, t.pos.y + i * 26))
  }
}

function drawStrokeList(ctx, list) {
  for (const s of list) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.strokeStyle = s.color || '#1f2430'
    ctx.lineWidth = s.width || 3
    const pts = s.points
    if (pts.length === 1) {
      ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, (s.width || 3) / 2, 0, Math.PI * 2)
      ctx.fillStyle = s.color || '#1f2430'; ctx.fill(); continue
    }
    if (s.type === 'rect' || s.type === 'ellipse') {
      const x = Math.min(pts[0].x, pts[pts.length - 1].x)
      const y = Math.min(pts[0].y, pts[pts.length - 1].y)
      const wd = Math.abs(pts[pts.length - 1].x - pts[0].x)
      const ht = Math.abs(pts[pts.length - 1].y - pts[0].y)
      ctx.beginPath()
      if (s.type === 'rect') ctx.rect(x, y, wd, ht)
      else ctx.ellipse(x + wd / 2, y + ht / 2, wd / 2, ht / 2, 0, 0, Math.PI * 2)
      ctx.stroke(); continue
    }
    if (s.type === 'line') {
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y)
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y); ctx.stroke(); continue
    }
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.quadraticCurveTo(pts[i].x, pts[i].y,
        (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2)
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y)
    ctx.stroke()
  }
}

watch(preview, async () => {
  await nextTick()
  paint(cv.value, preview.value)
}, { deep: false })

const props = defineProps({ room: { type: String, required: true } })
const emit = defineEmits(['close'])

const open = ref(false)
const loading = ref(false)
const err = ref('')
const session = ref(null)
const step = ref(0)
const total = ref(0)
const playing = ref(false)
const speed = ref(8)
const preview = ref({ strokes: [], texts: [] })
const frameInfo = ref(null)

async function load() {
  loading.value = true
  err.value = ''
  try {
    const data = await fetchFrames(props.room, 300)
    total.value = data.frames.length
    if (data.frames.length === 0) {
      err.value = '该房间暂无操作记录，先在画板上画几笔再回来看看。'
      return
    }
    session.value = new ReplaySession(
      data.frames,
      (s, t, snap, f) => { step.value = s; preview.value = snap; frameInfo.value = f },
      () => { playing.value = false }
    )
    // 先跳到最终态，用户可以播放或拖动
    session.value.seek(data.frames.length)
  } catch (e) {
    err.value = e.message
  } finally {
    loading.value = false
  }
}

function togglePlay() {
  if (!session.value) return
  if (playing.value) { session.value.pause(); playing.value = false }
  else {
    if (step.value >= total.value) session.value.seek(0)
    session.value.speed = speed.value
    session.value.play()
    playing.value = true
  }
}

function onSeek(e) {
  if (!session.value) return
  session.value.pause(); playing.value = false
  session.value.seek(Number(e.target.value))
}

function reset() {
  session.value?.pause()
  session.value?.seek(0)
  playing.value = false
}

const progress = computed(() => total.value ? Math.round((step.value / total.value) * 100) : 0)
const timeText = computed(() => frameInfo.value ? new Date(frameInfo.value.ts).toLocaleTimeString() : '—')

watch(open, (v) => { if (v && !session.value) load() })

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  session.value?.destroy()
})

function onKey(e) {
  if (!open.value) return
  if (e.key === 'Escape') emit('close')
}
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('close')">
    <div class="panel">
      <header>
        <h3>历史回放 · {{ room }}</h3>
        <button class="x" @click="emit('close')">✕</button>
      </header>

      <div class="canvas-wrap">
        <canvas ref="cv" width="900" height="420"></canvas>
        <div v-if="!total && !loading" class="empty">{{ err || '暂无数据' }}</div>
      </div>

      <div class="controls">
        <button class="btn" @click="reset">⏮ 回到起点</button>
        <button class="btn primary" @click="togglePlay">
          {{ playing ? '⏸ 暂停' : '▶ 播放' }}
        </button>
        <input type="range" min="0" :max="total" :value="step" @input="onSeek" />
        <span class="step">{{ step }} / {{ total }}（{{ progress }}%）</span>
        <label class="speed">
          速度
          <select v-model.number="speed">
            <option :value="2">0.5x</option>
            <option :value="8">2x</option>
            <option :value="20">5x</option>
            <option :value="50">12x</option>
          </select>
        </label>
      </div>

      <footer>
        <span>帧时间 {{ timeText }}</span>
        <span v-if="frameInfo">体积 {{ (frameInfo.size / 1024).toFixed(2) }} KB</span>
        <span class="tip">提示：回放在独立文档中进行，不影响线上协作状态</span>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; background: rgba(20,25,35,.55);
  display: flex; align-items: center; justify-content: center; z-index: 50;
  backdrop-filter: blur(3px);
}
.panel {
  background: #fff; border-radius: 14px; width: min(960px, 94vw);
  box-shadow: 0 24px 60px rgba(0,0,0,.28); overflow: hidden;
}
header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px; border-bottom: 1px solid #eef0f5;
}
header h3 { margin: 0; font-size: 16px; color: #1f2430; }
.x { border: none; background: none; font-size: 16px; cursor: pointer; color: #98a1b3; }
.canvas-wrap { padding: 16px 20px; background: #fafbfd; }
canvas {
  width: 100%; height: 420px; background: #fff;
  border: 1px solid #e8eaf0; border-radius: 10px; display: block;
}
.empty {
  position: absolute; text-align: center; color: #98a1b3; font-size: 13px;
  left: 0; right: 0; margin-top: -180px;
}
.controls {
  display: flex; align-items: center; gap: 12px; padding: 14px 20px;
  border-top: 1px solid #eef0f5; flex-wrap: wrap;
}
.btn {
  padding: 7px 14px; border: 1px solid #e3e7ef; background: #fff;
  border-radius: 8px; cursor: pointer; font-size: 13px; color: #3c465a;
}
.btn.primary { background: #4f8cff; border-color: #4f8cff; color: #fff; }
input[type=range] { flex: 1; min-width: 160px; accent-color: #4f8cff; }
.step { font-size: 12px; color: #5b6478; font-variant-numeric: tabular-nums; }
.speed { font-size: 12px; color: #5b6478; display: flex; align-items: center; gap: 6px; }
footer {
  display: flex; gap: 18px; padding: 10px 20px; background: #fafbfd;
  font-size: 11px; color: #98a1b3; border-top: 1px solid #eef0f5;
}
footer .tip { margin-left: auto; }
</style>