/**
 * 端到端验收：验证完整协作链路。
 *
 * 覆盖三个核心能力：
 *   1. 多人连接与 awareness 成员同步（在线状态、光标载体）
 *   2. 笔迹实时互见（CRDT 收敛）
 *   3. 断网离线编辑后重连合并，且他人内容不丢失
 *
 * 用法：
 *   node bench/e2e.js                        # 直连信令服务
 *   node bench/e2e.js http://localhost:5173  # 经 Vite 代理（贴近浏览器真实路径）
 */
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import NodeWebSocket from 'ws'

const ORIGIN = process.argv[2] || 'http://127.0.0.1:1234'
const WS = ORIGIN.replace(/^http/, 'ws') + '/ws'
const ROOM = `e2e-${Date.now().toString(36)}`
const N = 3
const COLORS = ['#4f8cff', '#f2545b', '#2fb96b']

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Node 环境适配：y-websocket 不会自动使用 ws 实现，
 * 必须显式注入 polyfill 并关闭压缩、设置 arraybuffer。
 */
class NodeWebSocketShim extends NodeWebSocket {
  constructor(url, protocols) {
    super(url, protocols, { perMessageDeflate: false })
    this.binaryType = 'arraybuffer'
  }
}

const checkResults = []
function check(label, pass, detail = '') {
  checkResults.push({ label, pass })
  console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? ' — ' + detail : ''}`)
  return pass
}

function connect(index) {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(WS, ROOM, doc, {
    params: { userId: `e2e${index}`, userName: `用户${index}`, color: COLORS[index % COLORS.length] },
    WebSocketPolyfill: NodeWebSocketShim,
    disableBc: true,
    connect: true
  })
  return {
    doc,
    provider,
    strokes: doc.getArray('strokes'),
    index,
    draw(id, extra = {}) {
      doc.transact(() => {
        doc.getArray('strokes').push([{
          id,
          author: `用户${index}`,
          type: 'pen',
          width: 3,
          color: COLORS[index % COLORS.length],
          points: [{ x: 100 * (index + 1), y: 100 }],
          ...extra
        }])
      }, 'local')
    }
  }
}

async function main() {
  console.log(`\n端到端验收 · ${ORIGIN} · 房间 ${ROOM}\n`)

  // ---------- 阶段 1：建立连接与成员同步 ----------
  console.log('── 阶段 1：连接与在线成员同步 ──')
  const users = []
  for (let i = 0; i < N; i++) users.push(connect(i))

  await Promise.all(users.map((u) => new Promise((resolve) => {
    u.provider.on('sync', (v) => { if (v) resolve() })
  })))
  check(`${N} 个客户端完成初始同步`, true)

  users.forEach((u) => u.provider.awareness.setLocalStateField('user', {
    id: `e2e${u.index}`,
    name: `用户${u.index}`,
    color: COLORS[u.index % COLORS.length]
  }))
  await wait(1200)

  const visible = users.map((u) => u.provider.awareness.getStates().size)
  check(
    'awareness 成员全网可见',
    visible.every((c) => c === N),
    `各端可见 ${visible.join(' / ')}`
  )

  // ---------- 阶段 2：笔迹实时互见 ----------
  console.log('\n── 阶段 2：笔迹实时同步 ──')
  users.forEach((u) => u.draw(`e2e-${u.index}`))
  await wait(1800)

  const counts = users.map((u) => u.strokes.length)
  check(
    '三人笔迹互相可见',
    counts.every((c) => c === N),
    `各端可见 ${counts.join(' / ')} 条`
  )

  // ---------- 阶段 3：离线编辑与合并 ----------
  console.log('\n── 阶段 3：断网离线编辑与重连合并 ──')
  const offline = users[0]
  offline.provider.disconnect()
  await wait(500)
  offline.draw('e2e-offline', { color: '#f2545b' })
  offline.draw('e2e-offline-2', { color: '#f2545b' })
  await wait(1500)

  const othersDuringOffline = users.slice(1).map((u) =>
    u.strokes.toArray().some((s) => s.id.startsWith('e2e-offline'))
  )
  check(
    '离线期间他人看不到离线内容',
    othersDuringOffline.every((v) => v === false)
  )

  offline.provider.connect()
  await new Promise((resolve) => {
    offline.provider.on('sync', (v) => { if (v) resolve() })
    setTimeout(resolve, 6000) // 兜底，避免重连失败导致挂起
  })
  await wait(1500)

  const finalCounts = users.map((u) => u.strokes.length)
  check(
    '重连后三方收敛',
    finalCounts.every((c) => c === N + 2),
    `各端可见 ${finalCounts.join(' / ')} 条（应为 ${N + 2}）`
  )

  const allHaveOffline = users.every((u) =>
    u.strokes.toArray().filter((s) => s.id.startsWith('e2e-offline')).length === 2
  )
  check('离线笔迹全员可见，无丢失', allHaveOffline)

  const keptOnline = users.every((u) =>
    u.strokes.toArray().some((s) => s.id === `e2e-${u.index}`)
  )
  check('合并未覆盖他人原有内容', keptOnline)

  // ---------- 汇总 ----------
  const results = checkResults
  const passed = results.filter((c) => c.pass).length
  const allOk = passed === results.length
  const title = ` ${allOk ? '✅' : '⚠️'} ${passed}/${results.length} 项检查通过 `
  const pad = Math.max(0, 44 - title.length - 2)
  console.log('\n╔' + '═'.repeat(46) + '╗')
  console.log('║' + title + ' '.repeat(pad) + '║')
  console.log('╚' + '═'.repeat(46) + '╝\n')

  users.forEach((u) => u.provider.destroy())
  await wait(200)
  process.exit(allOk ? 0 : 1)
}

setTimeout(() => {
  console.error('\n[e2e] 执行超时')
  process.exit(1)
}, 30000)

main()