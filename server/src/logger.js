const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const current = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info

const ts = () => new Date().toISOString().slice(11, 23)

function emit(level, args) {
  if (LEVELS[level] < current) return
  const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level]
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](`${ts()} ${tag}`, ...args)
}

export const logger = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a)
}