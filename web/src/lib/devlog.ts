/** What went wrong in this browser (failed requests, script errors), for the Logs window next to the server's log. */

export interface ClientLine {
  id: number;
  at: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
  count: number;
}

const KEEP = 300;
const lines: ClientLine[] = [];
let nextId = 1;

/** Adds a line; the same message again straight away just counts up (an offline poll fails every 2 s). */
export function clientLog(level: ClientLine['level'], msg: string): void {
  const last = lines[lines.length - 1];
  if (last && last.level === level && last.msg === msg) {
    last.count++;
    last.at = Date.now();
    return;
  }
  lines.push({ id: nextId++, at: Date.now(), level, msg, count: 1 });
  if (lines.length > KEEP) lines.splice(0, lines.length - KEEP);
}

export const clientLines = (): ClientLine[] => lines.map((l) => ({ ...l }));

/** Catches script errors and rejected promises nobody handled. */
export function installClientLog(version: string): void {
  clientLog('info', `Opened Wallet Click v${version} (${navigator.userAgent.match(/(Firefox|Edg|Chrome|Safari)\/[\d.]+/)?.[0] ?? 'browser'}, ${innerWidth}×${innerHeight})`);
  window.addEventListener('error', (e) => clientLog('error', `${e.message}${e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''}`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string } | undefined;
    clientLog('error', `Unhandled: ${r?.message ?? String(e.reason)}`);
  });
}
