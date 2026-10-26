import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAnimStyle } from '../lib/motion';
import { clockText, momentsOf, spotsAt, type Column, type Holder, type MoneyPath, type Spot, type Token } from '../lib/moneyPath';
import { sfx } from '../lib/sound';
import { useTheme } from '../lib/themes';
import { CoinIcon, CoinbaseIcon, Hourglass, ModernPC, ServerIcon, SmallKey, SwapMachine, UsdcIcon, VaultIcon } from './art';
import { Tip } from './Tip';

/**
 * "How it works": the money map. Every stop the money makes for the chosen Send options, laid out left to right
 * (top to bottom on a phone), one lane per piece, with the coins moving along it on a clock. Waits play as a
 * time-lapse: each stretch of the timeline gets a few seconds however long it really is, and the clock shows the real
 * time. Everything is drawn from `MoneyPath` (lib/moneyPath.ts), so it can be scrubbed and jumped around.
 */

const HOLDER: Record<Holder, string> = { you: 'You', fixedfloat: 'FixedFloat', server: 'Your server', exchange: '' };
const MIN = 60_000;

/** Real playback time for a stretch of `ms` of the timeline: short moves still get a moment, a day gets a few seconds. */
const realFor = (ms: number) => Math.min(2600, 380 + 250 * Math.log2(1 + ms / MIN));

/** The timeline in real playback time: breakpoints at every leg's start and end. */
function warp(p: MoneyPath) {
  const at = [...new Set([0, ...p.legs.flatMap((l) => [l.start, l.end]), p.end])].sort((a, b) => a - b);
  const real = [0];
  for (let i = 1; i < at.length; i++) real.push(real[i - 1] + realFor(at[i] - at[i - 1]));
  const total = real[real.length - 1];
  const toVirtual = (r: number) => {
    if (r <= 0) return 0;
    if (r >= total) return p.end;
    let i = 1;
    while (real[i] < r) i++;
    return at[i - 1] + ((r - real[i - 1]) / (real[i] - real[i - 1])) * (at[i] - at[i - 1]);
  };
  const toReal = (v: number) => {
    if (v <= 0) return 0;
    if (v >= p.end) return total;
    let i = 1;
    while (at[i] < v) i++;
    return real[i - 1] + ((v - at[i - 1]) / (at[i] - at[i - 1])) * (real[i] - real[i - 1]);
  };
  return { total, toVirtual, toReal };
}

const TokenIcon = ({ coin, size }: { coin: Token; size: number }) => (coin === 'USDC' ? <UsdcIcon size={size} /> : <CoinIcon coin={coin} size={size} />);

interface Props {
  path: MoneyPath;
  amountUsd: number;
  dest?: string;
}

export function MoneyMap({ path: p, amountUsd, dest = 'Coinbase' }: Props) {
  const style = useAnimStyle();
  const theme = useTheme();
  const w = useMemo(() => warp(p), [p]);
  const moments = useMemo(() => momentsOf(p), [p]);
  const [real, setReal] = useState(0);
  const [playing, setPlaying] = useState(style !== 'calm');
  const realRef = useRef(0);
  realRef.current = real;

  // A new path starts again from the beginning.
  useEffect(() => {
    setReal(0);
    setPlaying(style !== 'calm');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const next = Math.min(w.total, realRef.current + (now - last));
      last = now;
      setReal(next);
      if (next >= w.total) return setPlaying(false);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, w]);

  const t = w.toVirtual(real);
  const spots = spotsAt(p, t);
  const n = p.shares.length;
  const now = [...moments].reverse().find((m) => m.at <= t + 1) ?? moments[0];

  // A little sound as each piece lands, and at the end.
  const landed = spots.filter((s) => s.leg.to === p.columns.length - 1 && s.progress >= 1).length;
  const lastLanded = useRef(landed);
  useEffect(() => {
    if (landed > lastLanded.current && playing) (landed === n ? sfx.tada : sfx.send)();
    lastLanded.current = landed;
  }, [landed, n, playing]);

  // Where each stop is drawn, measured, so the coins can travel between them.
  const grid = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());
  const [centers, setCenters] = useState<Record<string, { x: number; y: number }>>({});
  const [vertical, setVertical] = useState(false);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const measure = () => {
      const box = el.getBoundingClientRect();
      const next: Record<string, { x: number; y: number }> = {};
      for (const [key, node] of nodes.current) {
        const icon = node.querySelector('.mm-icon') ?? node;
        const r = icon.getBoundingClientRect();
        next[key] = { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
      }
      setCenters(next);
      setVertical(el.offsetWidth < 560);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [p]);
  const keyOf = (col: number, lane: number) => (p.columns[col].lanes ? `${col}:${lane}` : `${col}:*`);
  const center = (col: number, lane: number) => centers[keyOf(col, lane)];

  // Steps rather than glides in Retro; a jump in Calm.
  const ease = (x: number) => (style === 'calm' ? (x < 0.5 ? 0 : 1) : style === 'retro' ? Math.floor(x * 6) / 6 : x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);

  /** Coins standing still at a stop are drawn once, with how many pieces are there. */
  const tokens: { key: string; x: number; y: number; coin: Token; count: number; moving: boolean }[] = [];
  const resting = new Map<string, { s: Spot; count: number }>();
  for (const s of spots) {
    const travelling = s.leg.kind === 'travel' && s.progress > 0 && s.progress < 1;
    if (travelling) {
      const a = center(s.leg.from, s.lane);
      const b = center(s.leg.to, s.lane);
      if (!a || !b) continue;
      const f = ease(s.progress);
      tokens.push({ key: `m${s.lane}`, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, coin: s.leg.coin, count: 1, moving: true });
    } else {
      const col = s.leg.kind === 'travel' && s.progress <= 0 ? s.leg.from : s.leg.to;
      const k = keyOf(col, s.lane);
      const r = resting.get(k);
      if (r) r.count++;
      else resting.set(k, { s: { ...s, leg: { ...s.leg, from: col, to: col } }, count: 1 });
    }
  }
  for (const [k, { s, count }] of resting) {
    const c = centers[k];
    if (c) tokens.push({ key: `r${k}`, x: c.x, y: c.y, coin: s.leg.coin, count, moving: false });
  }

  /** What each stop is doing right now. */
  const state = (col: number, lane: number) => {
    const here = spots.filter((s) => (p.columns[col].lanes ? s.lane === lane : true) && s.leg.from === col && s.leg.to === col && t >= s.leg.start && t < s.leg.end);
    const waiting = here.filter((s) => s.leg.kind === 'wait');
    return {
      busy: here.length > 0,
      swapping: here.some((s) => s.leg.kind === 'swap'),
      hopping: here.some((s) => s.leg.kind === 'hop'),
      left: waiting.length ? Math.min(...waiting.map((s) => s.leg.end - t)) : null,
      reached: p.legs.some((l) => l.to === col && (!p.columns[col].lanes || l.lane === lane) && l.kind === 'travel' && t >= l.end),
    };
  };

  // The lines between stops: one per lane between two lane columns, otherwise shared.
  const lines: { key: string; a: { x: number; y: number }; b: { x: number; y: number }; lit: boolean; flowing: boolean }[] = [];
  const seenLine = new Set<string>();
  for (const l of p.legs) {
    if (l.kind !== 'travel') continue;
    const key = `${keyOf(l.from, l.lane)}>${keyOf(l.to, l.lane)}`;
    const a = center(l.from, l.lane);
    const b = center(l.to, l.lane);
    if (!a || !b) continue;
    const lit = t >= l.end;
    const flowing = t >= l.start && t < l.end;
    if (seenLine.has(key)) {
      const prev = lines.find((x) => x.key === key)!;
      prev.lit ||= lit;
      prev.flowing ||= flowing;
      continue;
    }
    seenLine.add(key);
    lines.push({ key, a, b, lit, flowing });
  }

  // Your server: a frame around every run of stops it holds.
  const serverRuns: [number, number][] = [];
  p.columns.forEach((c, i) => {
    if (c.holder !== 'server') return;
    const last = serverRuns[serverRuns.length - 1];
    if (last && last[1] === i - 1) last[1] = i;
    else serverRuns.push([i, i]);
  });

  const icon = (c: Column, col: number, lane: number, s: ReturnType<typeof state>): ReactNode => {
    if (c.kind === 'wallet') return <TokenIcon coin={p.legs[0].coin} size={34} />;
    if (c.kind === 'dest') return /coinbase/i.test(dest) ? <CoinbaseIcon size={34} /> : <UsdcIcon size={34} />;
    if (c.kind === 'swap') return theme.shell === 'classic' ? <SwapMachine size={40} spinning={s.swapping} /> : <ModernPC size={40} spinning={s.swapping} variant={theme.shell} />;
    if (c.kind === 'vault') return <VaultIcon size={c.lanes ? 28 : 34} />;
    const coin = p.legs.find((l) => l.to === col && (l.lane === lane || !c.lanes))?.coin ?? 'BTC';
    return (
      <span className="mm-addr">
        <TokenIcon coin={coin} size={c.lanes ? 16 : 18} />
        <SmallKey size={11} />
      </span>
    );
  };

  const cells: ReactNode[] = [];
  p.columns.forEach((c, col) => {
    const laneList = c.lanes ? p.shares.map((_, k) => k) : [0];
    for (const lane of laneList) {
      const s = state(col, lane);
      const share = c.lanes ? p.shares[lane] : 1;
      cells.push(
        <div
          key={`${col}:${lane}`}
          ref={(el) => {
            const k = keyOf(col, lane);
            if (el) nodes.current.set(k, el);
            else nodes.current.delete(k);
          }}
          className={`mm-node is-${c.kind} holder-${c.holder} ${s.busy ? 'is-busy' : ''} ${s.reached ? 'is-reached' : ''} ${c.lanes ? 'is-lane' : 'is-single'}`}
          style={{ '--col': col + 1, '--lane': lane + 1 } as React.CSSProperties}
        >
          <Tip tip={c.tip}>
            <span className="mm-icon">
              {icon(c, col, lane, s)}
              {s.hopping && <span className="mm-hop" />}
            </span>
          </Tip>
          <span className="mm-label">
            {c.lanes ? `${c.kind === 'swap' ? 'Order' : c.kind === 'vault' ? 'Subaddress' : 'Address'} ${lane + 1}` : c.label}
          </span>
          {!c.lanes && <span className="mm-sub">{c.sub}</span>}
          {c.lanes && amountUsd > 0 && <span className="mm-sub">≈ ${Math.round(amountUsd * share)}</span>}
          {s.left !== null && (
            <span className="mm-wait">
              <Hourglass size={12} /> {clockText(s.left)}
            </span>
          )}
          {!c.lanes && HOLDER[c.holder] && c.holder !== 'server' && <span className={`mm-holder holder-${c.holder}`}>{HOLDER[c.holder]}</span>}
        </div>,
      );
    }
  });

  const done = t >= p.end;
  const holders = new Map<string, number>();
  for (const s of spots) {
    const c = p.columns[s.leg.kind === 'travel' && s.progress < 1 ? s.leg.from : s.leg.to];
    const who = c.holder === 'exchange' ? dest : c.holder === 'server' ? 'your server' : c.holder === 'you' ? 'you' : 'FixedFloat';
    holders.set(who, (holders.get(who) ?? 0) + 1);
  }
  const holdText = [...holders].map(([who, k]) => (n > 1 ? `${who} (${k} of ${n})` : who)).join(' · ');

  const jump = (v: number) => {
    setReal(w.toReal(v));
    setPlaying(false);
  };

  return (
    <div className={`money-map ${vertical ? 'is-vertical' : ''}`}>
      <div className="mm-clock" aria-live="off">
        <span className="mm-clock-face" aria-hidden="true">
          <i style={{ transform: `rotate(${(t / (12 * 3_600_000)) * 360}deg)` }} />
          <i className="is-min" style={{ transform: `rotate(${(t / 3_600_000) * 360}deg)` }} />
        </span>
        <span>
          <b>{done ? 'All there' : `After ${clockText(t)}`}</b>
          <small>{done ? `in about ${clockText(p.end)} (an example)` : 'example times'}</small>
        </span>
      </div>

      <div className="mm-grid" ref={grid} style={{ '--cols': p.columns.length, '--lanes': n } as React.CSSProperties}>
        {serverRuns.map(([a, b]) => (
          <div key={a} className="mm-server" style={{ '--from': a + 1, '--to': b + 2 } as React.CSSProperties}>
            <span className="mm-server-tag">
              <ServerIcon size={18} busy={spots.some((s) => p.columns[s.leg.to].holder === 'server' && s.progress < 1 && t >= s.leg.start)} /> Your server
              <Tip tip="Your own VPS. The addresses here belong to its wallet: the keys are on the server, encrypted, and nobody else can move the money." />
            </span>
          </div>
        ))}
        <svg className="mm-lines" aria-hidden="true">
          {lines.map((l) => (
            <line key={l.key} x1={l.a.x} y1={l.a.y} x2={l.b.x} y2={l.b.y} className={`${l.lit ? 'is-lit' : ''} ${l.flowing ? 'is-flowing' : ''}`} />
          ))}
        </svg>
        {cells}
        <div className="mm-tokens" aria-hidden="true">
          {tokens.map((k) => (
            <span key={k.key} className={`mm-token ${k.moving ? 'is-moving' : ''}`} style={{ transform: `translate(${k.x}px, ${k.y}px)` }}>
              <TokenIcon coin={k.coin} size={20} />
              {k.count > 1 && <b>×{k.count}</b>}
            </span>
          ))}
        </div>
      </div>

      <div className="mm-now">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.p key={now.caption} className="line-main" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            {now.caption}
          </motion.p>
        </AnimatePresence>
        <p className="line-sub">Held by: {holdText}</p>
      </div>

      <div className="mm-controls">
        <button type="button" className="btn98" onClick={() => (done ? (setReal(0), setPlaying(true)) : setPlaying((v) => !v))}>
          {done ? 'Replay' : playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          className="mm-scrub"
          min={0}
          max={Math.round(w.total)}
          value={Math.round(real)}
          onChange={(e) => {
            setReal(Number(e.target.value));
            setPlaying(false);
          }}
          aria-label="Timeline"
          aria-valuetext={clockText(t)}
        />
      </div>

      <ol className="mm-moments" aria-label="What happens, in order">
        {moments.map((m, i) => (
          <li key={i} className={`${m.at <= t + 1 ? 'is-past' : ''} ${m === now ? 'is-now' : ''}`}>
            <button type="button" onClick={() => jump(m.at)}>
              <span className="mm-at">{clockText(m.at)}</span> {m.caption}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
