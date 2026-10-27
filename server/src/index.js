/**
 * 实时协作白板 —— 信令服务入口
 *
 * 职责：
 *  1. WebSocket 端点 /ws?room=<name>  —— Yjs sync + awareness 中继
 *  2. HTTP 端点：房间状态、快照、历史回放、压测辅助
 *  3. 优雅退出：停止收新连接 -> 等待存量 -> 关闭总线
 */
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { createBus } from './bus.js'
import { RoomManager } from './rooms.js'
import { Connection } from './room.js'
import { config } from './config.js'
import { logger } from './logger.js'
import * as Y from 'yjs'

const bus = await createBus()
const manager = new RoomManager(bus)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }

  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  try {
    // 健康检查
    if (url.pathname === '/health') {
      return json(200, { ok: true, bus: bus.kind, uptimeMs: Math.round(process.uptime() * 1000) })
    }

    // 房间列表 + 状态
    if (url.pathname === '/api/rooms') {
      return json(200, manager.stats())
    }

    // 房间详情：/api/rooms/:name
    const detail = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,64})$/)
    if (detail) {
      const room = manager.getRoom(detail[1], { create: false })
      if (!room) return json(404, { error: 'room not found' })
      return json(200, room.snapshot())
    }

    // 增量拉取：断线重连时用 ?since=<opsIndex> 只补差量
    const incr = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,64})\/ops$/)
    if (incr) {
      const room = manager.getRoom(incr[1], { create: false })
      if (!room) return json(404, { error: 'room not found' })
      const since = Number(url.searchParams.get('since') ?? 0)
      const from = Number.isFinite(since) && since > 0 ? since : 0
      const ops = room.ops.slice(from).map((o, i) => ({
        index: from + i,
        ts: o.ts,
        update: Buffer.from(o.update).toString('base64')
      }))
      return json(200, { room: room.name, from, ops })
    }

    // 历史回放：/api/rooms/:name/history?n=<最近N帧> 返回按时间排列的更新序列
    const hist = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,64})\/history$/)
    if (hist) {
      const room = manager.getRoom(hist[1], { create: false })
      if (!room) return json(404, { error: 'room not found' })
      const n = Math.min(Number(url.searchParams.get('n') ?? 200) || 200, 5000)
      const tail = room.ops.slice(-n)
      return json(200, {
        room: room.name,
        total: room.ops.length,
        frames: tail.map((o, i) => ({
          index: room.ops.length - tail.length + i,
          ts: o.ts,
          size: o.update.length,
          update: Buffer.from(o.update).toString('base64')
        }))
      })
    }

    // 回放校验：把历史帧重放到一个新文档，返回收敛后的状态（用于验证无损合并）
    const verify = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9_-]{1,64})\/verify$/)
    if (verify) {
      const room = manager.getRoom(verify[1], { create: false })
      if (!room) return json(404, { error: 'room not found' })
      const replay = new Y.Doc()
      for (const op of room.ops) Y.applyUpdate(replay, op.update, 'load')
      const live = Y.encodeStateAsUpdate(room.doc)
      const copy = new Y.Doc()
      Y.applyUpdate(copy, live)
      const a = Buffer.from(Y.encodeStateAsUpdate(replay)).toString('base64')
      const b = Buffer.from(Y.encodeStateAsUpdate(copy)).toString('base64')
      return json(200, {
        room: room.name,
        frames: room.ops.length,
        converged: a === b,
        replayHash: hash(a),
        liveHash: hash(b)
      })
    }

    return json(404, { error: 'not found' })
  } catch (err) {
    logger.error('[http] 处理失败', err)
    return json(500, { error: err.message })
  }
})

function hash(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(16)
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

  // 支持两种寻址方式，兼容不同Yjs 客户端的 URL 约定：
  //   1) /ws?room=<name>          —— 自定义客户端（本项目 web 前端）
  //   2) /ws/<name>               —— y-websocket 官方约定（自动追加 /<roomname>）
  let roomName = null
  if (url.pathname === '/ws') {
    roomName = url.searchParams.get('room') ?? 'lobby'
  } else {
    const m = url.pathname.match(/^\/ws\/([A-Za-z0-9_-]{1,64})$/)
    if (m) roomName = decodeURIComponent(m[1])
  }

  if (!roomName || !manager.validName(roomName)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, roomName)
  })
})

wss.on('connection', (ws, req, roomName) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  const room = manager.getRoom(roomName)
  const meta = {
    userId: url.searchParams.get('userId') ?? undefined,
    userName: url.searchParams.get('userName') ?? undefined,
    color: url.searchParams.get('color') ?? undefined
  }
  const conn = new Connection(ws, room, meta)
  ws._conn = conn
})

// 心跳：清掉半开连接（对协作场景很重要，否则"幽灵用户"会一直占位）
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws._conn?.close(1001, 'heartbeat timeout')
      ws.terminate()
      continue
    }
    ws.isAlive = false
    try { ws.ping() } catch { /* 忽略 */ }
  }
}, config.heartbeatMs)
heartbeat.unref?.()

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.port} 已被占用。`)
    logger.error('请先停止占用该端口的进程，或用 PORT=<其他端口> npm run start 换一个端口。')
    process.exit(1)
  }
  logger.error('服务启动失败:', err)
  process.exit(1)
})

server.listen(config.port, config.host, () => {
  logger.info(`信令服务已启动 ws://${config.host}:${config.port}  (HTTP 状态: /api/rooms)`)
  logger.info(`总线类型: ${bus.kind} | 历史回放: ${config.enableHistory ? '开' : '关'}`)
})

// ---------- 优雅退出 ----------
let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.info(`收到 ${signal}，开始优雅退出…`)
  clearInterval(heartbeat)
  for (const ws of wss.clients) ws._conn?.close(1001, 'server shutdown')
  server.close()
  manager.destroyAll()
  await bus.close()
  setTimeout(() => process.exit(0), 200).unref?.()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('uncaughtException', (err) => {
  logger.error('未捕获异常', err)
})

export { server, manager, bus }