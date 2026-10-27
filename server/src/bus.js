/**
 * 广播总线抽象。
 *
 * 两种实现，接口一致：
 *  - RedisBus   : 基于 Redis Pub/Sub，允许多个 server 实例共享同一批房间，
 *                 任意实例收到更新后广播给本实例的本地连接（横向扩展）。
 *  - MemoryBus  : 单进程 EventEmitter，零外部依赖，本地开发 / 测试默认路径。
 *
 * 业务代码只依赖 publish / subscribe / close 三个方法，
 * 通过 createBus() 依据 REDIS_URL 决定用哪个。
 *
 * 消息格式统一为 Buffer：{ room, senderId, type, payload }
 */
import { EventEmitter } from 'node:events'
import { config } from './config.js'
import { logger } from './logger.js'

const CHANNEL = (room) => `${config.redisPrefix}:room:${room}`

class MemoryBus {
  constructor() {
    this.emitter = new EventEmitter()
    this.emitter.setMaxListeners(0)
    this.kind = 'memory'
  }

  async publish(room, message) {
    this.emitter.emit(CHANNEL(room), message)
  }

  async subscribe(room, handler) {
    this.emitter.on(CHANNEL(room), handler)
  }

  async unsubscribe(room, handler) {
    this.emitter.off(CHANNEL(room), handler)
  }

  async close() {}
}

class RedisBus {
  constructor(pub, sub) {
    this.pub = pub
    this.sub = sub
    this.handlers = new Map() // room -> Set<handler>
    this.kind = 'redis'
    this.sub.on('message', (channel, raw) => {
      const room = channel.slice(`${config.redisPrefix}:room:`.length)
      const set = this.handlers.get(room)
      if (!set || set.size === 0) return
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      const payload = msg.payload == null ? null : Buffer.from(msg.payload, 'base64')
      const envelope = {
        room,
        senderId: msg.senderId ?? null,
        token: msg.token ?? null,
        type: msg.type,
        payload
      }
      for (const h of set) {
        try {
          h(envelope)
        } catch (err) {
          logger.error('[bus] handler error', err)
        }
      }
    })
  }

  async publish(room, message) {
    const out = {
      senderId: message.senderId ?? null,
      token: message.token ?? null,
      type: message.type,
      payload: message.payload ? message.payload.toString('base64') : null
    }
    await this.pub.publish(CHANNEL(room), JSON.stringify(out))
  }

  async subscribe(room, handler) {
    let set = this.handlers.get(room)
    if (!set) {
      set = new Set()
      this.handlers.set(room, set)
      await this.sub.subscribe(CHANNEL(room))
    }
    set.add(handler)
  }

  async unsubscribe(room, handler) {
    const set = this.handlers.get(room)
    if (!set) return
    set.delete(handler)
    if (set.size === 0) {
      this.handlers.delete(room)
      try {
        await this.sub.unsubscribe(CHANNEL(room))
      } catch { /* 忽略 */ }
    }
  }

  async close() {
    try {
      await this.sub.quit()
      await this.pub.quit()
    } catch { /* 忽略 */ }
  }
}

export async function createBus() {
  if (!config.redisUrl) {
    logger.info('[bus] 使用内存总线（单进程模式）。设置 REDIS_URL 可开启多实例广播。')
    return new MemoryBus()
  }
  try {
    const { default: Redis } = await import('ioredis')
    const pub = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 })
    const sub = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 })
    pub.on('error', (e) => logger.warn('[bus] redis pub error:', e.message))
    sub.on('error', (e) => logger.warn('[bus] redis sub error:', e.message))
    await pub.connect()
    await sub.connect()
    logger.info('[bus] Redis 总线已连接:', config.redisUrl.replace(/:\/\/.*@/, '://***@'))
    return new RedisBus(pub, sub)
  } catch (err) {
    logger.warn('[bus] Redis 连接失败，降级为内存总线:', err.message)
    return new MemoryBus()
  }
}