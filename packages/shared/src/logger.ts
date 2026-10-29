import { redactString } from './redaction.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Keys that may carry page content or secrets; never logged. */
const DROP_KEYS = /^(text|html|dom|body|content|value|values|headers|cookie|screenshot|data|args|result)$/i;

function sanitize(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (DROP_KEYS.test(k)) out[k] = '[omitted]';
    else if (typeof v === 'string') out[k] = redactString(v).slice(0, 300);
    else if (v instanceof Error) out[k] = redactString(v.message).slice(0, 300);
    else out[k] = v;
  }
  return out;
}

/** Logs to stderr only (stdout is reserved for the MCP stdio protocol). */
export function createLogger(level: LogLevel = 'info', sink: (line: string) => void = (l) => process.stderr.write(l + '\n')): Logger {
  const emit = (lvl: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg: redactString(msg), ...(sanitize(meta) ?? {}) }));
  };
  return {
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
  };
}
