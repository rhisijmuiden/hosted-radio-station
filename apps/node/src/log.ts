/** One line per message on stdout; journald adds the time. */
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const min = order[(process.env.HRS_NODE_LOG as Level) ?? 'info'] ?? 1;

function write(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (order[level] < min) return;
  const tail = extra && Object.keys(extra).length ? ` ${JSON.stringify(extra, (_k, v) => (v instanceof Error ? v.message : v))}` : '';
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${level.toUpperCase().padEnd(5)} ${msg}${tail}\n`);
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => write('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => write('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write('error', msg, extra),
};
