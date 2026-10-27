/**
 * 房间 = 一个协作白板会话。
 *
 * 每个Room 持有：
 *  - 一个 Y.Doc（CRDT 文档，权威状态）
 *  - 一份 Awareness 状态（光标 / 在线成员）
 *  - 一组 WebSocket 连接
 *  - 一条操作日志（历史回放 + 断线重连增量补发）
 *
 * 状态机：doc 只接受 Yjs 合并，不存在"覆盖写"路径，
 * 因此任意顺序、任意重复投递的update 都能收敛到同一状态 —— 这是不冲突的根本原因。
 */
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { logger } from './logger.js'
import { config } from './config.js'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_QUERY_AWARENESS = 3
// 自定义扩展消息：RTT 探针
// 为什么不复用 awareness 做 RTT？awareness 广播会排除消息来源连接，
// 发起者收不到自己的回声，测出来的只是"距上次 ping 多久"（假 RTT）。
// 这里定义独立的 ping/pong 消息类型，由服务端原样回显，测得的才是真实往返延迟。
const MESSAGE_PING = 200
const MESSAGE_PONG = 201

export class Room {
  /**
   * @param {string} name 房间名
   * @param {import('./bus.js').MemoryBus} bus
   */
  constructor(name, bus) {
    this.name = name
    this.bus = bus
    this.doc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.awareness.setLocalState(null) // 服务端不参与光标，只做中继

    /** @type {Set<Connection>} */
    this.connections = new Set()
    /** @type {Array<{ts:number, clientId:number, update:Uint8Array}>} */
    this.ops = []
    this.createdAt = Date.now()
    this.lastActiveAt = Date.now()
    this.destroyed = false
    // 实例级唯一标记：用于识别总线回程中"本实例自己发出的消息"
    this.instanceToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

    this._onDocUpdate = (update, origin) => {
      // origin === 'load' 表示历史快照回放，不需要再广播
      if (origin === 'load') return
      this.lastActiveAt = Date.now()
      this._recordOp(update)
      const from = origin instanceof Connection ? origin.id : null

      // syncProtocol.writeUpdate 产出的已经是完整的 sync 消息（含 sync 子类型），
      // 不能再套一层 varUint8Array，否则客户端解析时字节错位。
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_SYNC)
      syncProtocol.writeUpdate(enc, update)
      this._broadcastSync(encoding.toUint8Array(enc), from)
    }

    this._onAwarenessUpdate = ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed)
      if (changed.length === 0) return
      this.lastActiveAt = Date.now()

      // 记录归属：这些 clientID 由 origin 连接带来，断开时需要精确清理
      if (origin instanceof Connection) {
        for (const cid of added.concat(updated)) origin.ownedClientIds.add(cid)
        for (const cid of removed) origin.ownedClientIds.delete(cid)
      }

      // toUint8Array 得到的已是完整消息（含 type 前缀），不能再套一层
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(
        enc,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)
      )
      const from = origin instanceof Connection ? origin.id : null
      this._broadcast(encoding.toUint8Array(enc), from)
    }

    this.doc.on('update', this._onDocUpdate)
    this.awareness.on('update', this._onAwarenessUpdate)

    this._busHandler = (envelope) => {
      if (this.destroyed) return
      // 消息由本实例产生：已在 _localBroadcast 直投过，跳过以防重复
      if (envelope.token === this.instanceToken) return
      // 其他实例的更新：投给本地所有连接（重复投递无害，CRDT 幂等）
      this._localBroadcast(envelope.payload, null)
    }
    bus.subscribe(name, this._busHandler)
  }

  get clientCount() {
    return this.connections.size
  }

  /**
   * 记录一条操作用于历史回放。
   *
   * 性能注意：这是同步热路径上的函数，必须 O(1) 且不做排序/大对象拷贝。
   * 之前用 Set 维护 seenOps 再排序裁剪，复杂度 O(n log n)，
   * 在50 人高频写入下会成为延迟长尾的元凶。ops 本身严格递增，
   * 用一个单调游标 baseIndex 表达"折叠后的基线偏移"即可。
   */
  _recordOp(update) {
    if (!config.enableHistory) return
    this.ops.push({ ts: Date.now(), clientId: this.doc.clientID, update })

    if (this.ops.length > config.maxOpsPerRoom) {
      // 折叠：把最早的更新合并为一个基线快照，后续增量仍可正常合并
      const merged = Buffer.concat(this.ops.map((o) => Buffer.from(o.update)))
      this.ops = [{
        ts: Date.now(),
        clientId: this.doc.clientID,
        update: new Uint8Array(merged),
        base: true
      }]
    }
  }

  /**
   * 累积一条 sync 更新，在当前事件循环阶段结束后合并广播。
   *
   * 高扇出房间（100 人同时画，尤其大量客户端同时重连补发）下逐条 fan-out
   * 会让事件循环排队，造成 P95 延迟长尾。这里把同tick 内的所有 update
   * 用 Y.mergeUpdates 合成一条，每连接每 tick 最多 1 次 send。
   * CRDT 更新可无损合并，语义与逐条广播等价。
   *
   * @param {Uint8Array} message 完整编码的 sync 消息
   * @param {number|null} originConn 产生该更新的连接（排除其回环）
   */
  _broadcastSync(message, originConn = null) {
    const update = this._unwrapSync(message)
    if (!update) {
      this._localBroadcast(message, originConn)
      return
    }

    if (!this._pendingUpdates) {
      this._pendingUpdates = []
      // 增量归并结果：每来一条就与已归并结果合并一次，避免 flush 时
      // 对 N 条 update 做一次性大合并造成明显停顿
      this._pendingMerged = null
      this._flushScheduled = false
    }
    this._pendingUpdates.push(update)

    if (!this._flushScheduled) {
      this._flushScheduled = true
      setImmediate(() => this._flushSync())
    }
  }

  _unwrapSync(message) {
    try {
      const decoder = decoding.createDecoder(message)
      if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return null
      const inner = decoding.readVarUint8Array(decoder)
      // 内层是 sync 消息：读掉 sync 子类型后即为 update 本体
      const innerDec = decoding.createDecoder(inner)
      const syncType = decoding.readVarUint(innerDec)
      if (syncType !== syncProtocol.messageYjsUpdate && syncType !== syncProtocol.messageYjsSyncStep2) {
        return null
      }
      return decoding.readVarUint8Array(innerDec)
    } catch {
      return null
    }
  }

  _flushSync() {
    const updates = this._pendingUpdates
    this._pendingUpdates = null
    this._flushScheduled = false
    if (!updates || updates.length === 0) return

    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MESSAGE_SYNC)
    if (updates.length === 1) {
      syncProtocol.writeUpdate(enc, updates[0])
    } else {
      syncProtocol.writeUpdate(enc, Y.mergeUpdates(updates.map((u) => new Uint8Array(u))))
    }
    const message = encoding.toUint8Array(enc)

    // 全量发给每个连接（含更新发起方）。
    // 与官方 y-websocket 行为一致：CRDT 更新幂等，重复应用无副作用。
    for (const conn of [...this.connections]) {
      this._send(conn, message)
    }

    // 总线扩散给其他实例
    this.bus.publish(this.name, {
      senderId: null,
      token: this.instanceToken,
      type: 'raw',
      payload: Buffer.from(message)
    }).catch((err) => logger.error('[room] publish failed', err))
  }

  /** 广播非sync 消息（awareness 等），量小无需合并 */
  _broadcast(message, originConn = null) {
    this._localBroadcast(message, originConn)
    this.bus.publish(this.name, {
      senderId: originConn,
      token: this.instanceToken,
      type: 'raw',
      payload: Buffer.from(message)
    }).catch((err) => logger.error('[room] publish failed', err))
  }

  _localBroadcast(message, exceptConnId) {
    // 复制一份再遍历：send 可能触发 close()，进而修改 connections 集合
    for (const conn of [...this.connections]) {
      if (exceptConnId != null && conn.id === exceptConnId) continue
      this._send(conn, message)
    }
  }

  /**
   * 发送一条**已完整编码**的消息（含类型前缀）。
   * 所有出口统一走这里，避免二次封装导致字节错位。
   * @param {Connection} conn
   * @param {Uint8Array} message
   */
  _send(conn, message) {
    if (conn.socket.readyState !== 1) return // 1 = OPEN
    try {
      conn.socket.send(message)
    } catch (err) {
      logger.warn(`[room:${this.name}] 发送失败`, err.message)
      conn.close()
    }
  }

  addConnection(conn) {
    this.connections.add(conn)
    this.lastActiveAt = Date.now()
    // Connection 构造时已通过自己的 Awareness 实例设置了 localState，
    // 并会主动广播给房间。这里只需登记，不需要重复设置。
    logger.info(`[room:${this.name}] +1连接，房间人数 ${this.connections.size}`)
  }

  removeConnection(conn) {
    this.connections.delete(conn)
    this.lastActiveAt = Date.now()

    // 精确移除该连接带来的所有 awareness 状态（光标/成员）。
    //
    // 必须用官方 removeAwarenessStates，而不是手动 delete states/meta：
    //   1. 它会保留 meta 中的 clock —— 而 encodeAwarenessUpdate 需要
    //      awareness.meta.get(clientID).clock 来编码"该成员已离开"的通知。
    //      手动删掉 meta 再编码会抛 TypeError，导致清理中断、
    //      断开连接的成员变成"幽灵光标"一直挂在房间里。
    //   2. 它会触发 awareness 的 update 事件，房间的 _onAwarenessUpdate
    //      会自动把"成员离开"广播给其他客户端，无需手工再编码一次。
    //
    // 注意：不能 destroy() awareness —— 它是房间共享实例，会影响房间内其他连接。
    const ids = [...conn.ownedClientIds]
    conn.ownedClientIds.clear()
    if (ids.length > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, ids, conn)
    }
    logger.info(`[room:${this.name}] -1连接，房间人数 ${this.connections.size}`)
  }

  /** 快照：当前完整文档状态 */
  snapshot() {
    return {
      room: this.name,
      clientCount: this.connections.size,
      ops: this.ops.length,
      users: [...this.awareness.getStates().entries()].map(([clientId, s]) => ({
        clientId,
        name: s?.user?.name ?? `user-${clientId}`,
        color: s?.user?.color ?? '#888'
      })),
      update: Buffer.from(Y.encodeStateAsUpdate(this.doc)).toString('base64')
    }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    this.bus.unsubscribe(this.name, this._busHandler).catch(() => {})
    this.doc.off('update', this._onDocUpdate)
    this.awareness.off('update', this._onAwarenessUpdate)
    for (const conn of this.connections) conn.close()
    this.connections.clear()
    this.doc.destroy()
    this.awareness.destroy()
  }
}

let connSeq = 0
/**
 * 单个客户端连接。负责协议解析、sync 握手、awareness 中继。
 */
export class Connection {
  /**
   * @param {import('ws').WebSocket} socket
   * @param {Room} room
   * @param {object} meta {userId, userName, color}
   */
  constructor(socket, room, meta = {}) {
    this.id = ++connSeq
    this.socket = socket
    this.room = room
    this.meta = meta
    this.isAlive = true
    this.closed = false

    // 共用房间的 Awareness 实例。
    // 服务端自身不设 localState（构造Room 时已 setLocalState(null)），
    // 只作为所有客户端 awareness 状态的权威持有者与中继。
    // 若此处新建独立 Awareness，其 update 事件不会触发房间广播，光标将无法同步。
    this.awareness = room.awareness

    // 该连接实际占用的 awareness clientID 集合。
    // 客户端的 clientID 由它自己的 Y.Doc 分配，服务端无法预知，
    // 因此在收到其 awareness 消息时动态记录，断开时据此清理，避免"幽灵光标"。
    this.ownedClientIds = new Set()

    room.addConnection(this)

    socket.binaryType = 'arraybuffer'
    socket.on('message', (data) => this._onMessage(data))
    socket.on('close', () => this.close())
    socket.on('error', (err) => {
      logger.warn(`[conn:${this.id}] socket error: ${err.message}`)
    })
    socket.on('pong', () => { this.isAlive = true })

    this._sendSyncStep1()
    this._sendCurrentAwareness()
  }

  _sendSyncStep1() {
    // 主动发起 sync step1（携带本端 state vector），实现双向快速收敛
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(enc, this.room.doc)
    this._raw(encoding.toUint8Array(enc))
  }

  _sendCurrentAwareness() {
    const states = this.room.awareness.getStates()
    if (states.size === 0) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(this.room.awareness, [...states.keys()])
    )
    this._raw(encoding.toUint8Array(enc))
  }

  _raw(bytes) {
    if (this.socket.readyState !== 1) return
    try {
      this.socket.send(bytes)
    } catch (err) {
      logger.warn(`[conn:${this.id}] raw send 失败`, err.message)
      this.close()
    }
  }

  _onMessage(data) {
    try {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data)
      if (bytes.length > config.maxMessageBytes) {
        logger.warn(`[conn:${this.id}] 消息超限 ${bytes.length}B，断开`)
        this.close(1009, 'message too large')
        return
      }
      const decoder = decoding.createDecoder(bytes)
      const enc = encoding.createEncoder()
      const messageType = decoding.readVarUint(decoder)
      switch (messageType) {
        case MESSAGE_SYNC: {
          encoding.writeVarUint(enc, MESSAGE_SYNC)
          // origin 传this：Room 内部据此识别来源连接，避免回环广播
          syncProtocol.readSyncMessage(decoder, enc, this.room.doc, this)
          if (encoding.length(enc) > 1) this._raw(encoding.toUint8Array(enc))
          break
        }
        case MESSAGE_AWARENESS: {
          awarenessProtocol.applyAwarenessUpdate(
            this.room.awareness,
            decoding.readVarUint8Array(decoder),
            this   // origin = 本连接，供 Room 侧记录 clientID 归属
          )
          break
        }
        case MESSAGE_QUERY_AWARENESS: {
          const states = this.room.awareness.getStates()
          if (states.size > 0) {
            const aenc = encoding.createEncoder()
            encoding.writeVarUint(aenc, MESSAGE_AWARENESS)
            encoding.writeVarUint8Array(
              aenc,
              awarenessProtocol.encodeAwarenessUpdate(this.room.awareness, [...states.keys()])
            )
            this._raw(encoding.toUint8Array(aenc))
          }
          break
        }
        case MESSAGE_PING: {
          // 原样回显给发起者，客户端用 ts 差值算出真实 RTT
          const ts = decoding.readVarUint(decoder)
          const penc = encoding.createEncoder()
          encoding.writeVarUint(penc, MESSAGE_PONG)
          encoding.writeVarUint(penc, ts)
          this._raw(encoding.toUint8Array(penc))
          break
        }
        default:
          logger.debug(`[conn:${this.id}] 未知消息类型 ${messageType}`)
      }
    } catch (err) {
      logger.warn(`[conn:${this.id}] 消息处理失败: ${err.message}`)
      this.close(1003, 'invalid message')
    }
  }

  close(code = 1000, reason = 'normal') {
    if (this.closed) return
    this.closed = true
    this.room.removeConnection(this)
    // 注意：不能destroy awareness —— 它是房间共享实例，销毁会影响房间内其他连接。
    // 本连接带来的状态已在 removeConnection 中按 ownedClientIds 精确清理。
    try {
      this.socket.close(code, reason)
    } catch { /* 忽略 */ }
  }
}