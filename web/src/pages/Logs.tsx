import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api';
import { LevelIcon, LogIcon } from '../components/art';
import { ModalLayer, Window } from '../components/Win98';
import { clientLines } from '../lib/devlog';
import { sfx } from '../lib/sound';
import type { LogLine } from '../types';

type Filter = 'all' | 'warn' | 'error';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'warn', label: 'Warnings' },
  { id: 'error', label: 'Errors' },
];
const KEEP = 2000;

interface Row {
  key: string;
  at: number;
  level: LogLine['level'];
  msg: string;
  count: number;
  detail?: string;
  browser: boolean;
}

const time = (ms: number) => {
  const d = new Date(ms);
  const hms = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return d.toDateString() === new Date().toDateString() ? hms : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${hms}`;
};

/** Adds new server lines; a repeat replaces the line it repeats (same `run`). */
function merge(have: LogLine[], incoming: LogLine[]): LogLine[] {
  if (!incoming.length) return have;
  const runs = new Set(incoming.map((l) => l.run));
  return [...have.filter((l) => !runs.has(l.run)), ...incoming].slice(-KEEP);
}

/** The server's log (what it did, warnings, errors) and this browser's, newest at the bottom, updating live. */
export function Logs({ onClose }: { onClose(): void }) {
  const [server, setServer] = useState<LogLine[]>([]);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [browser, setBrowser] = useState(clientLines);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [follow, setFollow] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const lastId = useRef(0);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = await api.logs(lastId.current);
        if (!alive) return;
        if (r.lines.length) lastId.current = Math.max(lastId.current, ...r.lines.map((l) => l.id));
        setServer((have) => merge(have, r.lines));
        setStartedAt(r.startedAt);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Can't reach the server");
      }
      if (alive) {
        setBrowser(clientLines());
        timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows: Row[] = [
    ...server.map((l) => ({ key: `s${l.run}`, at: l.at, level: l.level, msg: l.msg, count: l.count, detail: l.detail, browser: false })),
    ...browser.map((l) => ({ key: `b${l.id}`, at: l.at, level: l.level, msg: l.msg, count: l.count, browser: true })),
  ]
    .filter((r) => filter === 'all' || r.level === 'error' || (filter === 'warn' && r.level === 'warn'))
    .sort((a, b) => a.at - b.at);

  // Stay on the newest line, unless you scrolled up to read.
  useLayoutEffect(() => {
    if (follow && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [rows.length, follow, filter]);
  const onScroll = () => {
    const el = list.current;
    if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  const copy = async () => {
    const text = rows.map((r) => `${new Date(r.at).toISOString()} ${r.level.toUpperCase().padEnd(5)} ${r.browser ? '[browser] ' : ''}${r.msg}${r.count > 1 ? ` (×${r.count})` : ''}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      sfx.copy();
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("Couldn't copy (the browser said no)");
    }
  };

  const warnings = server.filter((l) => l.level === 'warn').length + browser.filter((l) => l.level === 'warn').length;
  const errors = server.filter((l) => l.level === 'error').length + browser.filter((l) => l.level === 'error').length;

  return (
    <ModalLayer>
      <Window
        title="Logs"
        icon={<LogIcon size={16} />}
        onClose={onClose}
        className="win-logs"
        role="dialog"
        statusBar={
          <>
            <span className={`status-cell grow ${error ? 'is-offline' : ''}`}>
              {error ?? (copied ? 'Copied to the clipboard' : startedAt ? `Since the server started, ${time(startedAt)}` : 'Loading…')}
            </span>
            <span className="status-cell log-tally" title={`${warnings} warning${warnings === 1 ? '' : 's'}, ${errors} error${errors === 1 ? '' : 's'}`}>
              <LevelIcon level="warn" size={12} /> {warnings} <LevelIcon level="error" size={12} /> {errors}
            </span>
          </>
        }
      >
        <div className="logs-bar">
          <div className="seg98" role="radiogroup" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" role="radio" aria-checked={filter === f.id} className={`btn98 seg-btn ${filter === f.id ? 'is-pressed' : ''}`} onClick={() => setFilter(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
          <label className="check98">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            <span className="check98-box" aria-hidden="true" />
            <span className="check98-text">Follow newest</span>
          </label>
          <button type="button" className="btn98" onClick={() => void copy()} disabled={!rows.length}>
            Copy
          </button>
        </div>
        <ol ref={list} className="log-list" onScroll={onScroll} aria-label="Log lines" aria-live="off">
          {rows.length === 0 && <li className="log-empty">{filter === 'all' ? 'Nothing logged yet.' : `No ${filter === 'warn' ? 'warnings or errors' : 'errors'}. All good.`}</li>}
          {rows.map((r) => (
            <li
              key={r.key}
              className={`log-row is-${r.level} ${r.detail ? 'has-detail' : ''}`}
              onClick={() => r.detail && setOpen(open === r.key ? null : r.key)}
            >
              <time dateTime={new Date(r.at).toISOString()}>{time(r.at)}</time>
              <LevelIcon level={r.level} />
              <span className="log-msg">
                {r.browser && <span className="log-src">browser</span>}
                {r.msg}
                {r.count > 1 && <span className="log-count">×{r.count}</span>}
                {open === r.key && r.detail && <pre className="log-detail">{r.detail}</pre>}
              </span>
            </li>
          ))}
        </ol>
      </Window>
    </ModalLayer>
  );
}
