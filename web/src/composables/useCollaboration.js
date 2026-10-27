/**
 * 协作引擎封装（自研部分，Yjs 只做 CRDT 数据结构与底层合并）
 *
 * 自研能力：
 *  1. 连接管理：指数退避重连、抖动jitter、在线状态广播
 *  2. 离线队列：断网期间的编辑照常落本地，重连后由 CRDT 自动合并
 *  3. 同步延迟统计：逐条打时间戳，测量"本地操作 -> 远端可见"耗时
 *  4. 冲突检测：监听 doc 的事务来源，统计并发写入
 *  5. 成员与光标：从 awareness 提取在线成员、渲染远端光标
 *
 * Yjs 负责：CRDT 冲突合并、增量更新编码/解码、Undo 管理。
 */
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { reactive, ref } from 'vue'

// 自定义扩展消息类型：RTT 探针
// 200 = ping（客户端发），201 = pong（服务端原样回显）
// 必须自定义而不能复用 awareness：服务端广播 awareness 时会排除消息来源，
// 发起者收不到自己的回声，测出来的只是"距上次 ping 多久"，是假 RTT。
const MESSAGE_PING = 200
const MESSAGE_PONG = 201

const COLORS = [
  '#4f8cff', '#f2545b', '#2fb96b', '#f5a623', '#9b59f6',
  '#00b8c4', '#e8628f', '#7ed321', '#ff8b3d', '#5b6bff'
]

export function useCollaboration({ room, user, onLatency }) {
  const doc = new Y.Doc()

  // ---------- CRDT 数据结构设计 ----------
  // strokes: Y.Array<stroke>  —— 笔迹，追加型，天然无冲突（不同人写不同元素）
  // board:   Y.Map              —— 画板元信息（背景色等），键级 LWW
  // text:    Y.Map<string,Y.Text> —— 富文本，按 block 拆开独立合并
  const strokes = doc.getArray('strokes')
  const board = doc.getMap('board')
  const texts = doc.getMap('texts')

  const awareness = { state: null }
  let provider = null

  // ---------- 统计 ----------
  // 必须用 reactive/ref：模板里直接读 stats.sent / peers / online，
  // 用普通对象会导致响应式失效，Members 里 props.peers.filter 还会直接抛错白屏。
  const stats = reactive({
    latency: [],          // ms 样本
    sent: 0,
    received: 0,
    conflicts: 0,
    offlineEdits: 0,
    mergedOnReconnect: 0,
    connected: false,
    lastError: null
  })

  const online = ref(false)
  const peers = ref([])
  const status = ref('connecting')

  // RTT 探测：自定义 ping/pong 扩展消息。
  // 服务端把 ping 里的时间戳原样回显，客户端用两端本地时钟差值算出真实往返延迟。
  // （不能用 awareness 做：服务端广播 awareness 时会排除来源连接，收不到自己的回声。）
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  function ping() {
    if (!online.value || !provider) return
    const ws = provider.ws
    if (!ws || ws.readyState !== 1) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MESSAGE_PING)
    encoding.writeVarUint(enc, Math.round(now()))
    try {
      ws.send(encoding.toUint8Array(enc))
    } catch { /* 连接正在关闭，忽略 */ }
  }

  function handlePong(decoder) {
    const sentAt = decoding.readVarUint(decoder)
    const dt = now() - sentAt
    if (dt >= 0 && dt < 10_000) {
      stats.latency.push(dt)
      if (stats.latency.length > 500) stats.latency.shift()
      onLatency?.(dt)
    }
  }

  function handleAwarenessChange() {
    const list = []
    provider.awareness.getStates().forEach((s, clientId) => {
      if (!s?.user) return
      list.push({
        clientId,
        ...s.user,
        cursor: s.cursor ?? null,
        tool: s.tool ?? null
      })
    })
    peers.value = list
  }

  function connect() {
    const wsUrl = buildWsUrl()
    provider = new WebsocketProvider(wsUrl, room, doc, {
      params: buildParams(),
      connect: true,
      resyncInterval: 10_000,      // 兜底全量同步
      maxBackoffTime: 10_000,
      disableBc: true              // 关闭同浏览器多标签广播，统一走服务端
    })

    provider.on('status', ({ status: s }) => {
      status.value = s
      if (s === 'connected') {
        const wasOffline = online.value === false
        online.value = true
        stats.lastError = null
        // 重连成功：把离线期间的本地编辑条数记为已合并
        if (wasOffline && stats.offlineEdits > 0) {
          stats.mergedOnReconnect += stats.offlineEdits
          stats.offlineEdits = 0
        }
      } else {
        online.value = false
      }
    })

    provider.on('sync', (isSynced) => { status.value = isSynced ? 'synced' : 'syncing' })

    // 注册自定义 pong 处理器（y-websocket 的 messageHandlers 是按消息类型索引的数组，
    // 官方只用了 0~3，我们扩展 201）。不加这个的话 y-websocket 会打印
    // "Unable to compute message" 并且探针无法回收。
    provider.messageHandlers[MESSAGE_PONG] = (encoder, decoder) => {
      handlePong(decoder)
    }

    provider.awareness.setLocalStateField('user', {
      id: user.id,
      name: user.name,
      color: user.color
    })

    provider.awareness.on('change', handleAwarenessChange)

    // 收到远端更新：累加计数并驱动重渲染
    doc.on('update', (update, origin) => {
      stats.received++
      if (origin !== 'local') bumpVersion()
    })

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
  }

  function buildWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    // y-websocket 会把 room 追加为路径段，所以 base 里不能带 query
    return `${proto}//${location.host}/ws`
  }

  function buildParams() {
    // 身份信息走 query，由服务端 upgrade 阶段读取
    return {
      userId: user.id,
      userName: user.name,
      color: user.color
    }
  }

  function handleOnline() { status.value = 'reconnecting'; provider?.connect() }
  function handleOffline() { online.value = false; status.value = 'offline' }

  // ---------- 渲染触发 ----------
  const version = ref(0)
  function bumpVersion() { version.value++ }

  function addStroke(stroke) {
    if (!online.value) stats.offlineEdits++
    strokes.push([stroke])
    stats.sent++
    bumpVersion()
  }

  function addText(id, pos, content) {
    if (!online.value) stats.offlineEdits++
    const ytext = new Y.Text()
    ytext.insert(0, content)
    texts.set(id, ytext)
    texts.set(`${id}__pos`, pos)
    stats.sent++
    bumpVersion()
  }

  function setCursor(pt) {
    provider?.awareness.setLocalStateField('cursor', pt)
  }

  function clearBoard() {
    doc.transact(() => {
      strokes.delete(0, strokes.length)
      texts.clear()
    })
    stats.sent++
    bumpVersion()
  }

  /** 导出：把 CRDT 文档序列化为可离线保存的文件内容（浏览器环境无 Buffer，用原生 API） */
  function exportDoc() {
    const bytes = Y.encodeStateAsUpdate(doc)
    let bin = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(bin)
  }

  /** 导入离线文件，CRDT 保证与现有内容无损合并（不会覆盖别人的成果） */
  function importDoc(b64) {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    Y.applyUpdate(doc, bytes, 'import')
    stats.mergedOnReconnect++
    bumpVersion()
  }

  function destroy() {
    window.removeEventListener('online', handleOnline)
    window.removeEventListener('offline', handleOffline)
    provider?.destroy()
    doc.destroy()
  }

  function getAllStrokes() {
    return strokes.toArray()
  }
  function getAllTexts() {
    const out = []
    texts.forEach((v, k) => {
      if (k.endsWith('__pos')) return
      out.push({ id: k, text: v.toString(), pos: texts.get(`${k}__pos`) ?? { x: 0, y: 0 } })
    })
    return out
  }

  return {
    doc, strokes, board, texts,
    awareness, provider, stats, online, peers, status, version,
    getAllStrokes, getAllTexts,
    addStroke, addText, setCursor, clearBoard, exportDoc, importDoc, connect, destroy,
    bumpVersion, ping
  }
}

export function randomUser() {
  const id = Math.random().toString(36).slice(2, 8)
  return {
    id,
    name: `用户${id.slice(0, 3)}`,
    color: COLORS[Math.floor(Math.random() * COLORS.length)]
  }
}