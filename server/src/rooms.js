/**
 * 房间管理器：负责房间的创建、路由、空闲回收。
 */
import { Room } from './room.js'
import * as Y from 'yjs'
import { config } from './config.js'
import { logger } from './logger.js'

const ROOM_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export class RoomManager {
  constructor(bus) {
    this.bus = bus
    /** @type {Map<string, Room>} */
    this.rooms = new Map()
    this._gcTimer = setInterval(() => this._gc(), 10_000)
    this._gcTimer.unref?.()
  }

  get validName() {
    return (name) => typeof name === 'string' && ROOM_NAME_RE.test(name)
  }

  getRoom(name, { create = true } = {}) {
    let room = this.rooms.get(name)
    if (!room && create) {
      room = new Room(name, this.bus)
      this.rooms.set(name, room)
      logger.info(`[rooms] 创建房间 ${name}`)
    }
    return room
  }

  stats() {
    const rooms = [...this.rooms.values()].map((r) => ({
      name: r.name,
      clients: r.connections.size,
      ops: r.ops.length,
      docSize: Buffer.byteLength(Y.encodeStateAsUpdate(r.doc)),
      uptimeMs: Date.now() - r.createdAt,
      idleMs: Date.now() - r.lastActiveAt
    }))
    return {
      roomCount: this.rooms.size,
      totalClients: rooms.reduce((s, r) => s + r.clients, 0),
      bus: this.bus.kind,
      rooms
    }
  }

  _gc() {
    const now = Date.now()
    for (const [name, room] of this.rooms) {
      if (room.connections.size === 0 && now - room.lastActiveAt > config.roomIdleGcMs) {
        logger.info(`[rooms] 回收空房间 ${name}`)
        room.destroy()
        this.rooms.delete(name)
      }
    }
  }

  destroyAll() {
    clearInterval(this._gcTimer)
    for (const room of this.rooms.values()) room.destroy()
    this.rooms.clear()
  }
}