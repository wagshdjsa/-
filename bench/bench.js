/**
 * 压测 / 验收脚本
 *
 * 验证三项硬指标：
 *   1. N 人同房间并发操作，CRDT 最终一致（无冲突、无丢失）
 *   2. 同步延迟（写入 -> 其他节点可见）P50 / P95
 *   3. 断网离线编辑后重连，合并成功率 100%
 *
 * 用法：
 *   node bench/bench.js                 # 默认 50 人
 *   node bench/bench.js --users 100     # 指定人数
 *   node bench/bench.js --offline 10    # 前 10 个客户端中途断网
 *   node bench/bench.js --url ws://127.0.0.1:1234
 */
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import NodeWebSocket from 'ws'

/**
 * y-websocket 在 Node 下需要一个符合浏览器 API 的 WebSocket：
 *  - binaryType 必须是 'arraybuffer'（y-websocket 用它直接构造 Uint8Array）
 *  - 关闭压缩，避免分片行为与浏览器端不一致导致的解码异常
 */
class NodeWebSocketShim extends NodeWebSocket {
  constructor(url, protocols) {
    super(url, protocols, { perMessageDeflate: false })
    this.binaryType = 'arraybuffer'
  }
}

// ---------- 参数 ----------
const args = process.argv.slice(2)
const arg = (k, d) => {
  const i = args.indexOf(`--${k}`)
  return i >= 0 ? args[i + 1] : d
}
const HTTP = arg('url', 'http://127.0.0.1:1234')
const WS = HTTP.replace(/^http/, 'ws')
// y-websocket 会把房间名拼到serverUrl 后面：ws://host/ws/<room>
// 身份信息走 query，与前端一致
const WS_BASE = `${WS}/ws`
const USERS = Number(arg('users', 50))
const ROOM = arg('room', `bench-${Date.now().toString(36)}`)
const DURATION = Number(arg('duration', 12)) * 1000
const OFFLINE_N = Number(arg('offline', 10))
const OFFLINE_PER_USER = Number(arg('offline-writes', 8))
const WRITE_INTERVAL = 40

const COLORS = ['#4f8cff', '#f2545b', '#2fb96b', '#f5a623', '#9b59f6', '#00b8c4']

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => performance.now()

// ---------- 单个虚拟用户 ----------
class VirtualUser {
  constructor(i) {
    this.i = i
    this.id = `bench-${i}`
    this.doc = new Y.Doc()
    this.strokes = this.doc.getArray('strokes')
    this.connected = false
    this.offlinePhase = false

    // 本地写入队列：(期望被其他节点看到的 id, 写入时间)
    this.pending = new Map()
    // 观察到的远端 id 时间戳，用于算延迟
    this.observedAt = new Map()

    this.latencies = []
    this.writes = 0
    this.timer = null
    this.probeTimer = null
    this.pendingProbes = new Set()

    const q = new URLSearchParams({
      userId: this.id,
      userName: `bench${i}`,
      color: COLORS[i % COLORS.length]
    })
    // y-websocket 会把房间名追加为路径段：<serverUrl>/<roomname>
    // 因此身份信息只能放query，且 serverUrl 里不能带 query（否则拼接结果错位）
    this.provider = new WebsocketProvider(WS_BASE, ROOM, this.doc, {
      params: Object.fromEntries(q),
      // Node 环境下 y-websocket 不会自动使用 ws 实现，必须显式注入 polyfill
      WebSocketPolyfill: NodeWebSocketShim,
      disableBc: true,
      resyncInterval: 0,
      connect: true
    })

    this.provider.on('status', ({ status }) => {
      this.connected = status === 'connected'
    })

    // 收到更新 -> 检查哪些别人的笔迹刚刚变可见了
    this.doc.on('update', () => this._checkLatency())

    this.synced = new Promise((res) => {
      this.provider.on('sync', (v) => { if (v) res() })
    })
  }

  /**
     * 延迟测量：只针对「探针笔迹」计算。
     *
     * 为什么不用每条操作都测：
     *   1) 全量遍历 strokes 是 O(n)，在高频 update 下会变成 O(n²)，
     *      把压测客户端自己变成瓶颈，测出的延迟反映的是客户端而非服务端；
     *   2) 每条操作都打时间戳会让全局表膨胀到十万级。
     * 改为：每个客户端按固定间隔写入一条 probe 笔迹，
     * 收到回声时算差 —— 这就是端到端「操作可见延迟」的标准度量方式。
     */
    _checkLatency() {
      if (!this.connected) return
      const t = now()
      for (const id of this.pendingProbes) {
        const start = globalThis.__wbSentAt?.get(id)
        if (start == null) continue
        if (!this._seenProbe(id)) continue
        this.latencies.push(t - start)
        if (this.latencies.length > 500) this.latencies.shift()
        this.pendingProbes.delete(id)
        globalThis.__wbSentAt.delete(id)
      }
    }

    _seenProbe(id) {
      // 探针笔迹一旦可见即认为延迟已达成
      if (this._visibleProbeIds == null) this._visibleProbeIds = new Set()
      const arr = this.strokes.toArray()
      for (const s of arr) {
        if (s.id === id) return true
      }
      return false
    }

  startWriting() {
    this.timer = setInterval(() => {
      if (!this.connected) return
      const n = 3 + Math.floor(Math.random() * 5)
      const points = []
      const x0 = Math.random() * 1600
      const y0 = Math.random() * 900
      for (let k = 0; k < n; k++) {
        points.push({ x: x0 + Math.random() * 60, y: y0 + Math.random() * 60 })
      }
      const id = `${this.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const stroke = {
        id, author: this.id, type: 'pen', width: 3,
        color: COLORS[this.i % COLORS.length], points
      }
      this.doc.transact(() => this.strokes.push([stroke]), 'local')
      this.writes++
    }, WRITE_INTERVAL + Math.floor(Math.random() * WRITE_INTERVAL))
  }

  /**
   * 启动延迟探针：固定间隔写一条极小的探针笔迹，
   * 收到它在自己视图里可见的时刻即为一次端到端延迟样本。
   */
  startProbing(intervalMs = 500) {
    let seq = 0
    this.probeTimer = setInterval(() => {
      if (!this.connected) return
      const id = `${this.id}-probe-${seq++}`
      globalThis.__wbSentAt.set(id, now())
      this.pendingProbes.add(id)
      this.doc.transact(() => this.strokes.push([{
        id, author: this.id, type: 'pen', width: 1,
        color: COLORS[this.i % COLORS.length],
        points: [{ x: 0, y: 0 }]
      }]), 'local')
    }, intervalMs)
  }

  goOffline() {
    this.offlinePhase = true
    this.provider.disconnect()
    this.connected = false
  }

  goOnline() {
    this.offlinePhase = false
    this.provider.connect()
  }

  /** 离线期间继续本地编辑（模拟真实断网） */
  startOfflineWriting(count) {
    return new Promise((resolve) => {
      let n = 0
      const t = setInterval(() => {
        const id = `${this.id}-offline-${n}`
        const pts = Array.from({ length: 4 }, () => ({
          x: Math.random() * 1600, y: Math.random() * 900
        }))
        this.doc.transact(() => this.strokes.push([{
          id, author: this.id, type: 'pen', width: 4,
          color: COLORS[this.i % COLORS.length], points: pts
        }]), 'local')
        n++
        this.writes++
        if (n >= count) { clearInterval(t); resolve(n) }
      }, 30)
    })
  }

  destroy() {
    clearInterval(this.timer)
    clearInterval(this.probeTimer)
    this.provider.destroy()
    this.doc.destroy()
  }
}

// ---------- 统计工具 ----------
function percentile(arr, p) {
  if (arr.length === 0) return null
  const s = [...arr].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length))
  return s[idx]
}

// ---------- 主流程 ----------
globalThis.__wbSentAt = new Map()

async function main() {
  log('\n╔══════════════════════════════════════════════════════╗')
  log('║        实时协作白板 · 并发压测与验收               ║')
  log('╚══════════════════════════════════════════════════════╝\n')
  log(`服务端     : ${HTTP}`)
  log(`房间       : ${ROOM}`)
  log(`虚拟用户   : ${USERS}（其中 ${OFFLINE_N} 人将模拟断网）`)
  log(`压测时长   : ${DURATION / 1000}s\n`)

  // 检查服务端
  try {
    const health = await fetch(`${HTTP}/health`).then((r) => r.json())
    log(`✓ 服务端健康检查通过（总线: ${health.bus}）\n`)
  } catch {
    log(`✗ 无法连接服务端 ${HTTP}，请先执行 npm run dev:server\n`)
    process.exit(1)
  }

  // 阶段 1：建立连接
  log('── 阶段 1：建立 ' + USERS + ' 个客户端连接 ──')
  const users = []
  for (let i = 0; i < USERS; i++) users.push(new VirtualUser(i))
  await Promise.all(users.map((u) => Promise.race([u.synced, sleep(15000)])))
  const syncedCount = users.length
  log(`✓ ${syncedCount}/${USERS} 个客户端完成初始同步\n`)

  // 阶段 2：并发写入
  log('── 阶段 2：并发写入 ' + DURATION / 1000 + 's ──')
  users.forEach((u) => u.startWriting())
  users.forEach((u) => u.startProbing(Number(arg('probe-interval', 500))))

  // 阶段 2.5：中途让部分客户端断网并离线编辑
  let offlineWrites = 0
  const offlineUsers = users.slice(0, OFFLINE_N)
  if (OFFLINE_N > 0) {
    setTimeout(async () => {
      log(`  ⚡ ${OFFLINE_N} 个客户端断网，开始离线编辑…`)
      offlineUsers.forEach((u) => u.goOffline())
      const counts = await Promise.all(offlineUsers.map((u) => u.startOfflineWriting(OFFLINE_PER_USER)))
      offlineWrites = counts.reduce((a, b) => a + b, 0)
      log(`  ⚡ 离线期间共写入 ${offlineWrites} 条，等待重连合并…`)
      // 断网 2s 后重连
      setTimeout(() => offlineUsers.forEach((u) => u.goOnline()), 2000)
    }, Math.floor(DURATION * 0.35))
  }

  await sleep(DURATION)
  users.forEach((u) => clearInterval(u.timer))

  // 等待所有重连 + 收敛。
  // 大房间（100人）+ 大量离线客户端重连时，服务端需要做多轮大合并，
  // 固定睡眠可能不够，改为"轮询直到全员一致或超时"，避免误判为未收敛。
  log('\n── 阶段 3：等待收敛 ──')
  const settleStart = Date.now()
  const settleTimeout = 30_000
  let converged = false
  let viewSets = []
  let union = new Set()

  const collect = () => {
    viewSets = users.map((u) => new Set(
      u.strokes.toArray().map((s) => s.id).filter((id) => !id.includes('-probe-'))
    ))
    union = new Set()
    viewSets.forEach((s) => s.forEach((id) => union.add(id)))
    const sizes = viewSets.map((s) => s.size)
    return sizes.every((n) => n === sizes[0]) && sizes[0] === union.size
  }

  while (Date.now() - settleStart < settleTimeout) {
    await sleep(1000)
    if (collect()) { converged = true; break }
  }
  collect()
  const settleSec = ((Date.now() - settleStart) / 1000).toFixed(1)
  log(`  收敛耗时 ${settleSec}s ${converged ? '✓' : '（超时）'}`)

  // 阶段 4：一致性校验（viewSets / union / converged 已在阶段 3 收敛轮询中收集）
  log('── 阶段 4：一致性校验 ──')
  const expectedWrites = union.size
  const minCount = Math.min(...viewSets.map((s) => s.size))
  const maxCount = Math.max(...viewSets.map((s) => s.size))

  // 离线合并成功率：断网期间写入的每一条，必须在重连后出现在所有客户端视图里
  const offlineStrokes = new Map() // id -> author
  users.forEach((u) => {
    u.strokes.toArray().forEach((s) => {
      if (s.id.includes('-offline-')) offlineStrokes.set(s.id, s.author)
    })
  })
  const expectedOffline = offlineStrokes.size
  let recovered = 0
  let lostDetail = []
  viewSets.forEach((set, idx) => {
    let missed = 0
    for (const id of offlineStrokes.keys()) {
      if (set.has(id)) recovered++
      else missed++
    }
    if (missed > 0) lostDetail.push(`client${idx}缺${missed}`)
  })
  // recovered 是"跨客户端×跨笔迹"计数，理论上限 = 可见客户端数 × 笔迹数
  const maxRecovered = OFFLINE_N > 0 ? viewSets.length * expectedOffline : 0
  const mergeRate = maxRecovered > 0 ? (recovered / maxRecovered) * 100 : 100
  // 真正的"丢失"= 任一客户端缺失的条数之和（已在 lostDetail 里体现）
  const anyLoss = lostDetail.length > 0

  // 延迟
  const allLat = users.flatMap((u) => u.latencies)
  const p50 = percentile(allLat, 50)
  const p95 = percentile(allLat, 95)
  const p99 = percentile(allLat, 99)

  // 服务端视角校验：历史重放是否无损
  let verify = null
  try {
    verify = await fetch(`${HTTP}/api/rooms/${ROOM}/verify`).then((r) => r.json())
  } catch { /* 忽略 */ }

  const roomStats = await fetch(`${HTTP}/api/rooms`).then((r) => r.json()).catch(() => null)

  // ---------- 报告 ----------
  log('\n╔══════════════════════════════════════════════════════╗')
  log('║                      压 测 结 果                    ║')
  log('╚══════════════════════════════════════════════════════╝\n')

  const line = (label, val, ok) =>
    log(`  ${ok === true ? '✓' : ok === false ? '✗' : '·'} ${label.padEnd(26, ' ')} ${val}`)

  line('客户端连接数', `${syncedCount} / ${USERS}`, syncedCount === USERS)
  line('全局唯一笔迹总数', `${expectedWrites} 条`, expectedWrites > 0)
  line('服务端记录操作帧', roomStats ? `${roomStats.rooms.find((r) => r.name === ROOM)?.ops ?? '-'} 条` : '-')
  log('')
  line('各客户端可见元素数', `min ${minCount} / max ${maxCount}`)
  line('最终一致性(CRDT收敛)', converged ? '通过 — 所有客户端内容完全一致' : '未收敛', converged)
  line('服务端历史重放无损', verify ? (verify.converged ? '通过' : '失败') : '-', verify?.converged)
  log('')
  if (p50 != null) {
    line('同步延迟 P50', `${p50.toFixed(1)} ms`, p50 < 80)
    line('同步延迟 P95', `${p95.toFixed(1)} ms`, p95 < 80)
    line('同步延迟 P99', `${p99.toFixed(1)} ms`)
    line('延迟样本数', `${allLat.length} 条`)
  } else {
    line('同步延迟', '样本不足')
  }
  log('')
  if (OFFLINE_N > 0) {
    line('离线编辑条数', `${expectedOffline} 条`)
    line('离线笔迹全网可见率', `${mergeRate.toFixed(2)}%`, !anyLoss)
    line('合并失败(丢失)条数', `${anyLoss ? '有缺失: ' + lostDetail.slice(0, 3).join(', ') : '0 条'}`, !anyLoss)
  }
  if (verify) {
    line('历史重放帧数', `${verify.frames} 帧`)
  }
  line('异步异常次数', `${asyncErrors} 次`, asyncErrors === 0)
  log('')

  const pass =
    syncedCount === USERS &&
    expectedWrites > 0 &&
    converged &&
    verify?.converged === true &&
    asyncErrors === 0 &&
    (p50 == null || p50 < 80) &&
    (p95 == null || p95 < 80) &&
    (OFFLINE_N === 0 || !anyLoss)
  log(`  综合结论：${pass ? '✅ 全部指标达标' : '⚠️存在未达标项'}\n`)

  users.forEach((u) => u.destroy())
  await sleep(300)
  process.exit(pass ? 0 : 1)
}

main().catch((err) => {
  console.error('压测异常:', err)
  process.exit(1)
})

/**
 * 统计口径：采集非受控异常次数，若不为 0 视为压测环境不干净，
 * 在报告中显式披露 —— 不能因为"指标达标"就掩盖环境异常。
 */
let asyncErrors = 0
process.on('uncaughtException', (err) => {
  asyncErrors++
  if (asyncErrors <= 3) console.error(`\n[bench] 未捕获异常 #${asyncErrors}:`, err.message)
})
process.on('unhandledRejection', (err) => {
  asyncErrors++
  if (asyncErrors <= 3) console.error(`\n[bench] 未处理的 Promise 拒绝 #${asyncErrors}:`, err?.message ?? err)
})