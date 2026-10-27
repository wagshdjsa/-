const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

export const config = {
  // 端口可通过环境变量覆盖，避免与本机其他项目抢占同一端口。
  //   PORT / SERVER_PORT  信令服务端口（默认 1234）
  port: num(process.env.PORT || process.env.SERVER_PORT, 1234),
  host: process.env.HOST || '0.0.0.0',

  // Redis Pub/Sub：用于多实例水平扩展时跨进程广播 Yjs 更新与awareness。
  // 未配置时自动降级为单进程内存总线（见 bus.js），单机开发零依赖。
  redisUrl: process.env.REDIS_URL || '',
  redisPrefix: process.env.REDIS_PREFIX || 'wb',

  // 房间内存中最多保留的更新条数（超出后折叠为快照，控制长房间内存增长）
  maxOpsPerRoom: num(process.env.MAX_OPS_PER_ROOM, 20000),

  // 空房间回收延迟
  roomIdleGcMs: num(process.env.ROOM_IDLE_GC_MS, 60_000),

  // 单条Yjs 消息体积上限（防滥用）
  maxMessageBytes: num(process.env.MAX_MESSAGE_BYTES, 4 * 1024 * 1024),

  // 心跳：ping 间隔
  heartbeatMs: num(process.env.HEARTBEAT_MS, 25_000),

  // 是否启用操作日志（历史回放数据源）
  enableHistory: process.env.ENABLE_HISTORY !== 'false'
}