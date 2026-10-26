import { motion } from 'motion/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { beat, chip } from '../lib/chiptune';
import { useAnimStyle } from '../lib/motion';
import { clockText, momentsOf, spotsAt, type Column, type Holder, type MoneyPath, type Token } from '../lib/moneyPath';
import { useTheme } from '../lib/themes';
import { CoinIcon, CoinbaseIcon, Hourglass, ModernPC, ServerIcon, SmallKey, SwapMachine, UsdcIcon, VaultIcon } from './art';
import { CoinArt, paintCoin, paintTrail } from './Courier';
import { PX } from './pixelArt';
import { Tip } from './Tip';

/**
 * "How it works": the money map. Every stop the money makes for the chosen Send options, laid out left to right
 * (top to bottom on a phone), one lane per piece, with the coins moving along it on a clock. Waits play as a
 * time-lapse: each stretch of the timeline gets a few seconds however long it really is, and the clock shows the real
 * time. Everything is drawn from `MoneyPath` (lib/moneyPath.ts), so it can be scrubbed and jumped around.
 */

const HOLDER: Record<Holder, string> = { you: 'You', fixedfloat: 'FixedFloat', server: 'Your server', exchange: '' };
const MIN = 60_000;

/** Real playback time for a stretch of `ms` of the timeline: a move gets most of a second, a day gets a few seconds. */
const realFor = (ms: number) => Math.min(2600, 520 + 260 * Math.log2(1 + ms / MIN));

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

/** The 8-bit sounds for what happened between `from` and `to` on the timeline (the same sound at once plays once). */
function cue(p: MoneyPath, from: number, to: number) {
  if (to <= from) return;
  const fx = new Set<() => void>();
  const began = (at: number) => (at > from || (from <= 0 && at === 0)) && at <= to;
  for (const l of p.legs) {
    if (l.kind === 'travel' && l.end > from && l.end <= to) fx.add(to >= p.end ? chip.fanfare : chip.coin);
    if (!began(l.start)) continue;
    if (l.kind === 'swap') fx.add(chip.powerUp);
    else if (l.kind === 'stay') fx.add(chip.lock);
    else if (l.kind === 'hop') fx.add(chip.jump);
    else if (l.kind === 'travel') fx.add(p.columns[l.from].kind === 'vault' && p.columns[l.to].kind === 'swap' ? chip.open : chip.dash);
  }
  if (fx.has(chip.fanfare)) fx.delete(chip.coin);
  [...fx].slice(0, 2).forEach((play) => play());
}

interface Tok {
  key: string;
  x: number;
  y: number;
  /** 1 = full size: a moving coin grows out of the stop it leaves and shrinks into the next. */
  size: number;
  /** A coin that has just arrived fades in. */
  alpha: number;
  coin: Token;
  count: number;
  /** A moving coin's line, and how far along it is (for its trail). */
  line?: { a: { x: number; y: number }; b: { x: number; y: number }; progress: number };
}

/** Along a line: mostly eased in and out, never quite stopping (the courier's flights move the same way). */
const glide = (x: number) => 0.3 * x + 0.7 * (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const COIN = 20;

const TokenIcon = ({ coin, size }: { coin: Token; size: number }) => (coin === 'USDC' ? <UsdcIcon size={size} /> : <CoinIcon coin={coin} size={size} />);

/** A tab beside "Steps" under the map (What it costs, Compare). */
export interface MapPanel {
  key: string;
  label: ReactNode;
  body: ReactNode;
}

interface Props {
  path: MoneyPath;
  amountUsd: number;
  dest?: string;
  /** Next to the clock: what this setup does, in one line. */
  head?: ReactNode;
  panels?: MapPanel[];
}

export function MoneyMap({ path: p, amountUsd, dest = 'Coinbase', head, panels = [] }: Props) {
  const style = useAnimStyle();
  const theme = useTheme();
  const w = useMemo(() => warp(p), [p]);
  const moments = useMemo(() => momentsOf(p), [p]);
  const [real, setReal] = useState(0);
  const [playing, setPlaying] = useState(style !== 'calm');
  /** The playhead. While it plays it moves every frame; React hears about it only when something it draws changes. */
  const realRef = useRef(0);
  const seek = (v: number) => {
    realRef.current = v;
    setReal(v);
  };

  // A new path starts again from the beginning.
  useEffect(() => {
    seek(0);
    setPlaying(style !== 'calm');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p]);

  const t = w.toVirtual(real);
  const spots = spotsAt(p, t);
  const n = p.shares.length;
  const now = [...moments].reverse().find((m) => m.at <= t + 1) ?? moments[0];

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
      // The window zooms in as it opens: undo its scale, so a map measured mid-zoom still lines up.
      const sx = box.width / el.offsetWidth || 1;
      const sy = box.height / el.offsetHeight || 1;
      const next: Record<string, { x: number; y: number }> = {};
      for (const [key, node] of nodes.current) {
        const icon = node.querySelector('.mm-icon') ?? node;
        const r = icon.getBoundingClientRect();
        next[key] = { x: (r.left - box.left + r.width / 2) / sx, y: (r.top - box.top + r.height / 2) / sy };
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

  /**
   * Every coin at `at` on the timeline. A moving coin goes straight along its line from one stop to the next (a jump
   * in Calm), growing out of the stop it leaves and shrinking into the one it reaches. Coins standing still sit on
   * their stop's corner, drawn once with how many are there, and fade in as they arrive.
   */
  const calm = style === 'calm';
  const pixel = style === 'retro';
  /** Where the coins waiting at a stop sit: its top corner (the left one on a phone, where its words are on the right). */
  const corner = (c: { x: number; y: number }) => ({ x: c.x + (vertical ? -16 : 14), y: c.y - 14 });
  const tokensAt = (at: number): Tok[] => {
    const list: Tok[] = [];
    const resting = new Map<string, { coin: Token; count: number; alpha: number }>();
    const realAt = w.toReal(at);
    for (const s of spotsAt(p, at)) {
      const x = s.progress;
      if (s.leg.kind === 'travel' && x > 0 && x < 1) {
        const a = center(s.leg.from, s.lane);
        const b = center(s.leg.to, s.lane);
        if (!a || !b) continue;
        const f = calm ? (x < 0.5 ? 0 : 1) : glide(x);
        const size = calm ? 1 : Math.min(1, 0.55 + (x / 0.15) * 0.45, 0.55 + ((1 - x) / 0.15) * 0.45);
        list.push({ key: `m${s.lane}`, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, size, alpha: 1, coin: s.leg.coin, count: 1, line: { a, b, progress: x } });
      } else {
        const col = s.leg.kind === 'travel' && x <= 0 ? s.leg.from : s.leg.to;
        const k = keyOf(col, s.lane);
        const came = p.legs.filter((l) => l.lane === s.lane && l.kind === 'travel' && l.to === col && l.end <= at).at(-1);
        const alpha = calm || !came ? 1 : Math.min(1, (realAt - w.toReal(came.end)) / 220);
        const r = resting.get(k);
        if (r) {
          r.count++;
          r.alpha = Math.max(r.alpha, alpha);
        } else resting.set(k, { coin: s.leg.coin, count: 1, alpha });
      }
    }
    for (const [k, r] of resting) {
      const c = centers[k];
      if (c) list.push({ key: `r${k}#${r.count}`, ...corner(c), size: 1, alpha: r.alpha, coin: r.coin, count: r.count });
    }
    return list;
  };

  /** The coins are painted on a canvas over the map: at half resolution in Retro (chunky pixels), sharp otherwise. */
  const canvas = useRef<HTMLCanvasElement>(null);
  const dpr = useRef(1);
  const fitCanvas = () => {
    const c = canvas.current;
    const el = grid.current;
    if (!c || !el) return;
    dpr.current = pixel ? 1 : Math.min(3, window.devicePixelRatio || 1);
    c.width = pixel ? Math.ceil(el.offsetWidth / PX) : Math.round(el.offsetWidth * dpr.current);
    c.height = pixel ? Math.ceil(el.offsetHeight / PX) : Math.round(el.offsetHeight * dpr.current);
    c.style.width = `${el.offsetWidth}px`;
    c.style.height = `${el.offsetHeight}px`;
  };
  useLayoutEffect(fitCanvas, [pixel, centers]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Puts the coins, the clock's hands and the timeline's thumb where they are at `r`, straight onto the page. */
  const hands = useRef<(HTMLElement | null)[]>([]);
  const scrub = useRef<HTMLInputElement>(null);
  const draw = (r: number, list = tokensAt(w.toVirtual(r))) => {
    const v = w.toVirtual(r);
    const c = canvas.current;
    const g = c?.getContext('2d');
    if (c && g) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, c.width, c.height);
      if (!pixel) g.setTransform(dpr.current, 0, 0, dpr.current, 0, 0);
      g.imageSmoothingEnabled = !pixel;
      for (const k of list) {
        if (k.line && !calm) {
          // A dotted trail along the line behind it, and in Retro one dithered after-image, like the courier's.
          const { a, b, progress } = k.line;
          const at = (x: number) => ({ x: a.x + (b.x - a.x) * glide(x), y: a.y + (b.y - a.y) * glide(x) });
          for (let i = 8; i >= 1; i--) {
            const back = progress - i * 0.022;
            if (back <= 0) continue;
            const q = at(back);
            paintTrail(g, k.coin, q.x, q.y, COIN * k.size * (0.2 + 0.25 * (1 - i / 9)), 0.42 * (1 - i / 9), i, pixel);
          }
          if (pixel && progress > 0.08) {
            const q = at(progress - 0.06);
            paintCoin(g, k.coin, q.x, q.y, COIN * k.size, true, 0.4);
          }
        }
        paintCoin(g, k.coin, k.x, k.y, COIN * k.size, pixel, k.alpha);
      }
    }
    const [hour, minute] = hands.current;
    if (hour) hour.style.transform = `rotate(${(v / (12 * 3_600_000)) * 360}deg)`;
    if (minute) minute.style.transform = `rotate(${(v / 3_600_000) * 360}deg)`;
    if (scrub.current) scrub.current.value = String(Math.round(r));
  };
  useLayoutEffect(() => draw(realRef.current));
  // The coin art loads a moment after the map opens: paint again once it's there.
  useEffect(() => {
    const late = setTimeout(() => latest.current.draw(realRef.current), 150);
    return () => clearTimeout(late);
  }, [p, style]);
  const latest = useRef({ draw, tokensAt });
  latest.current = { draw, tokensAt };

  // Every frame: move the playhead, play what happened, draw the coins. React redraws the stops, captions and
  // countdowns only when a coin sets off or lands or a step begins, and otherwise about twelve times a second.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let committed = last;
    let sig = '';
    const loop = (now: number) => {
      const from = w.toVirtual(realRef.current);
      const r = Math.min(w.total, realRef.current + (now - last));
      last = now;
      realRef.current = r;
      const v = w.toVirtual(r);
      cue(p, from, v);
      const list = latest.current.tokensAt(v);
      const next = `${list.map((k) => k.key).join()}|${p.legs.filter((l) => l.start <= v).length}`;
      if (next !== sig || now - committed > 80 || r >= w.total) {
        sig = next;
        committed = now;
        setReal(r);
      }
      latest.current.draw(r, list);
      if (r >= w.total) return setPlaying(false);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, w, p]);

  // The 8-bit beat pulses while it plays.
  useEffect(() => {
    beat(playing);
    return () => beat(false);
  }, [playing]);

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
          <span className="mm-text">
            <span className="mm-label">{c.lanes ? `${c.kind === 'swap' ? 'Order' : c.kind === 'vault' ? 'Subaddress' : 'Address'} ${lane + 1}` : c.label}</span>
            {!c.lanes && <span className="mm-sub">{c.sub}</span>}
            {c.lanes && amountUsd > 0 && <span className="mm-sub">≈ ${Math.round(amountUsd * share)}</span>}
            {s.left !== null && (
              <span className="mm-wait">
                <Hourglass size={12} /> {clockText(s.left)}
              </span>
            )}
            {!c.lanes && HOLDER[c.holder] && c.holder !== 'server' && s.left === null && <span className={`mm-holder holder-${c.holder}`}>{HOLDER[c.holder]}</span>}
          </span>
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
    seek(w.toReal(v));
    setPlaying(false);
  };

  // The tabs under the map: the steps, then the caller's. The steps list keeps the current step in view.
  const [tab, setTab] = useState('steps');
  const tabs: { key: string; label: ReactNode }[] = [{ key: 'steps', label: 'Steps' }, ...panels];
  const list = useRef<HTMLOListElement>(null);
  const nowIndex = moments.indexOf(now);
  useEffect(() => {
    const ol = list.current;
    const li = ol?.children[nowIndex] as HTMLElement | undefined;
    if (!ol || !li || ol.hidden) return;
    if (li.offsetTop < ol.scrollTop) ol.scrollTop = li.offsetTop;
    else if (li.offsetTop + li.offsetHeight > ol.scrollTop + ol.clientHeight) ol.scrollTop = li.offsetTop + li.offsetHeight - ol.clientHeight;
  }, [nowIndex, tab]);

  return (
    <div className={`money-map ${vertical ? 'is-vertical' : ''}`}>
      <CoinArt />
      <div className="mm-head">
        {head && <div className="mm-head-text">{head}</div>}
        <div className="mm-clock" aria-live="off">
          <span className="mm-clock-face" aria-hidden="true">
            <i ref={(el) => void (hands.current[0] = el)} />
            <i className="is-min" ref={(el) => void (hands.current[1] = el)} />
          </span>
          <span>
            <b>{done ? 'All there' : `After ${clockText(t)}`}</b>
            <small>{done ? `in about ${clockText(p.end)} (an example)` : 'example times'}</small>
          </span>
        </div>
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
        <canvas ref={canvas} className="mm-coins" aria-hidden="true" />
        <div className="mm-tokens" aria-hidden="true">
          {tokensAt(t)
            .filter((k) => k.count > 1)
            .map((k) => (
              <b key={k.key} className="mm-count" style={{ transform: `translate(${k.x}px, ${k.y}px)` }}>
                ×{k.count}
              </b>
            ))}
        </div>
      </div>

      <div className="mm-now">
        {/* The new caption fades in where it stands; the old one goes at once, so the two never overlap. */}
        <motion.p key={now.caption} className="line-main" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
          {now.caption}
        </motion.p>
        <p className="line-sub">Held by: {holdText}</p>
      </div>

      <div className="mm-controls">
        <button type="button" className="btn98" onClick={() => (done ? (seek(0), setPlaying(true)) : setPlaying((v) => !v))}>
          {done ? 'Replay' : playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          className="mm-scrub"
          min={0}
          max={Math.round(w.total)}
          defaultValue={0}
          ref={scrub}
          onChange={(e) => {
            seek(Number(e.target.value));
            setPlaying(false);
          }}
          aria-label="Timeline"
          aria-valuetext={clockText(t)}
        />
      </div>

      <div className="tabs98 mm-tabs" role="tablist">
        {tabs.map((k) => (
          <button key={k.key} type="button" role="tab" aria-selected={tab === k.key} className={`tab98 ${tab === k.key ? 'is-active' : ''}`} onClick={() => setTab(k.key)}>
            {k.label}
          </button>
        ))}
      </div>
      <div className="tab-panel mm-panel">
        <ol className="mm-moments" role="tabpanel" aria-label="What happens, in order" hidden={tab !== 'steps'} ref={list}>
          {moments.map((m, i) => (
            <li key={i} className={`${m.at <= t + 1 ? 'is-past' : ''} ${m === now ? 'is-now' : ''}`}>
              <button type="button" onClick={() => jump(m.at)}>
                <span className="mm-at">{clockText(m.at)}</span> {m.caption}
              </button>
            </li>
          ))}
        </ol>
        {panels.map((k) => (
          <div key={k.key} className="mm-panel-body" role="tabpanel" hidden={tab !== k.key}>
            {k.body}
          </div>
        ))}
      </div>
    </div>
  );
}
