import pino from 'pino';

/**
 * The server's log. Lines still go to stdout (docker logs) as JSON, and the newest ones are also kept in
 * memory, readable, for the Logs window. Secrets are blanked before a line is written anywhere.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  id: number;
  /** The same message repeating straight away is one line with a count; `run` is that line's first id. */
  run: number;
  count: number;
  /** When it (last) happened, and when the run started. */
  at: number;
  first: number;
  level: LogLevel;
  msg: string;
  /** A stack trace, for errors. */
  detail?: string;
}

const KEEP = 2000;
const lines: LogLine[] = [];
let nextId = 1;
const startedAt = Date.now();
let echo = !process.env.VITEST;

const LEVELS: Record<number, LogLevel> = { 10: 'debug', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'error' };
/** Fields every pino line has, or that only matter to machines. */
const PLAIN = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'v', 'reqId', 'err']);

const short = (v: unknown, max = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Adds a line (or counts a repeat of the last one). */
export function addLine(level: LogLevel, msg: string, at = Date.now(), detail?: string): void {
  const last = lines[lines.length - 1];
  if (last && last.level === level && last.msg === msg) {
    lines.pop();
    lines.push({ ...last, id: nextId++, count: last.count + 1, at });
    return;
  }
  const id = nextId++;
  lines.push({ id, run: id, count: 1, at, first: at, level, msg, ...(detail ? { detail } : {}) });
  if (lines.length > KEEP) lines.splice(0, lines.length - KEEP);
}

/** Turns one pino JSON line into a readable one (the message, then any extra fields as key=value). Returns its level. */
function capture(json: string): number {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return 50;
  }
  const err = o.err as { message?: string; stack?: string } | undefined;
  let msg = String(o.msg ?? '');
  if (err?.message && !msg.includes(err.message)) msg = msg ? `${msg}: ${err.message}` : err.message;
  const extra = Object.entries(o)
    .filter(([k, v]) => !PLAIN.has(k) && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${short(v)}`);
  if (extra.length) msg = `${msg}  ${extra.join(' ')}`;
  const stack = err?.stack?.split('\n').slice(1, 7).join('\n');
  addLine(LEVELS[Number(o.level)] ?? 'info', short(msg, 2000), typeof o.time === 'number' ? o.time : Date.now(), stack);
  return Number(o.level) || 30;
}

/** Fields that must never be printed or kept, wherever they turn up. */
const SECRETS = ['token', '*.token', 'password', '*.password', 'apiKey', 'apiSecret', 'secret', '*.secret', 'mnemonic', '*.mnemonic', 'seed', 'walletKey', 'req.headers.cookie', 'req.headers.authorization'];

/** LOG_LEVEL only decides what's printed (docker logs); the Logs window always keeps info and up. */
const PRINT_FROM = ({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as Record<string, number>)[process.env.LOG_LEVEL ?? 'info'] ?? 30;

export const logger = pino(
  { level: PRINT_FROM < 30 ? 'debug' : 'info', redact: { paths: SECRETS, censor: '[hidden]' } },
  {
    write(line: string) {
      const level = capture(line);
      if (echo && level >= PRINT_FROM) process.stdout.write(line);
    },
  },
);

/** Stops printing to stdout (lines are still kept). */
export function quiet(): void {
  echo = false;
}

/** The kept lines newer than `after`, oldest first (at most `limit`, the newest ones). */
export function logLines(after = 0, limit = 1000): { lines: LogLine[]; startedAt: number } {
  const newer = lines.filter((l) => l.id > after);
  return { lines: newer.slice(-limit), startedAt };
}

/** Empties the log (tests). */
export function clearLogs(): void {
  lines.length = 0;
}
