import { useEffect, useLayoutEffect, useRef } from 'react';
import { isCalm, isRetro } from '../lib/motion';
import { PX, darker, pixelSprite, pixelTwinkle } from './pixelArt';
import { CoinbaseIcon, StableIcon, CoinIcon } from './art';

/**
 * The coin courier: coins thrown from one station to the next like the pages of the Windows 95 copy dialog, and,
 * while a swap runs, two coins circling the computer (what goes in, what comes out).
 *
 * Everything is drawn on two canvases at the screen's own refresh rate (60, 120, 144 Hz…): a back one under the
 * stations, for the half of the orbit behind the computer, and a front one over them. Each coin's place is worked
 * out from the clock, not stepped frame by frame, so a slow frame never makes it stutter or jump.
 *
 *  - a flight: coins pop out of the source, fly a high arc while they flip (a trail of after-images behind them,
 *    their shadow running along the track), and dive into the target, where `onLand` fires;
 *  - an orbit: two coins on a tilted ring round a station, 180° apart, swelling as they swing to the front and
 *    dimming behind the machine, with glowing comet tails; it spirals out when it starts and back in when it stops.
 *
 * Positions follow the strip's stations: x in percent of the strip's width, y in px from its top.
 */

export type CourierCoin = 'BTC' | 'ETH' | 'XMR' | 'USDC' | 'USDT' | 'CB';

export interface Flight {
  /** Stable while the stream runs: a new key is a new stream. */
  id: string;
  from: number;
  to: number;
  coin: CourierCoin;
  onLand?(): void;
}

export interface Orbit {
  x: number;
  a: CourierCoin;
  b: CourierCoin;
  /** Ring radius in px (across). */
  r?: number;
}

/** What a payout currency looks like as a coin. */
export const courierCoin = (ccy?: string | null): CourierCoin => (ccy === 'USDT' ? 'USDT' : ccy === 'XMR' ? 'XMR' : ccy === 'BTC' ? 'BTC' : ccy === 'ETH' ? 'ETH' : 'USDC');

const KINDS: CourierCoin[] = ['BTC', 'ETH', 'XMR', 'USDC', 'USDT', 'CB'];
/** Each coin's edge (seen as it turns) and its glow. */
const LOOK: Record<CourierCoin, { edge: string; glow: string }> = {
  BTC: { edge: '#b8650a', glow: '#ffb347' },
  ETH: { edge: '#3c55b8', glow: '#9fb0ff' },
  XMR: { edge: '#b34700', glow: '#ff8c3a' },
  USDC: { edge: '#194d8c', glow: '#6fb0ff' },
  USDT: { edge: '#167257', glow: '#5fe0b5' },
  CB: { edge: '#0036a8', glow: '#5b8cff' },
};

const PAD = 48;
const ICON_Y = 36;
const SIZE = 28;
/** A new coin leaves this often (s). */
const GAP = 0.36;
const SPRITE = 128;
let sparkN = 0;

// ------------------------------------------------------------------------------------------------ sprites

/** The coins, rasterised once from the same SVG art the stations use. */
const art = new Map<CourierCoin, HTMLCanvasElement>();

function rasterise(kind: CourierCoin, svg: SVGSVGElement) {
  if (art.has(kind) || typeof Image === 'undefined') return;
  const markup = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = c.height = SPRITE;
    c.getContext('2d')?.drawImage(img, 0, 0, SPRITE, SPRITE);
    art.set(kind, c);
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}

/** A soft glow, per colour. */
const glows = new Map<string, HTMLCanvasElement>();
function glow(color: string): HTMLCanvasElement {
  let c = glows.get(color);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, '#ffffffcc');
    grad.addColorStop(0.18, `${color}cc`);
    grad.addColorStop(0.5, `${color}44`);
    grad.addColorStop(1, `${color}00`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  glows.set(color, c);
  return c;
}

/** A four-point glint. */
let star: HTMLCanvasElement | null = null;
function glint(): HTMLCanvasElement {
  if (star) return star;
  star = document.createElement('canvas');
  star.width = star.height = 32;
  const g = star.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.3, '#fff6c2aa');
    grad.addColorStop(1, '#fff6c200');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(16, 0);
    g.quadraticCurveTo(18, 14, 32, 16);
    g.quadraticCurveTo(18, 18, 16, 32);
    g.quadraticCurveTo(14, 18, 0, 16);
    g.quadraticCurveTo(14, 14, 16, 0);
    g.fill();
  }
  return star;
}

// ------------------------------------------------------------------------------------------------ easing and drawing

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t: number) => {
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

/**
 * One coin: its edge shows as it turns (`flip`, radians), a highlight sweeps its face, and it can lean (`lean`).
 */
function drawCoin(g: CanvasRenderingContext2D, kind: CourierCoin, x: number, y: number, size: number, flip: number, lean: number, alpha: number, shade = 0) {
  const img = art.get(kind);
  if (!img || alpha <= 0.01 || size <= 0.5) return;
  const c = Math.cos(flip);
  const w = Math.max(0.08, Math.abs(c));
  const r = size / 2;
  const thick = size * 0.1 * Math.sin(flip);
  g.save();
  g.globalAlpha = alpha;
  g.translate(x, y);
  g.rotate(lean);
  // the edge: the coin's thickness, between its two faces
  if (Math.abs(thick) > 0.25) {
    g.fillStyle = LOOK[kind].edge;
    g.beginPath();
    g.ellipse(thick, 0, r * w, r, 0, 0, Math.PI * 2);
    g.fill();
    g.fillRect(Math.min(0, thick), -r, Math.abs(thick), size);
  }
  g.scale(w, 1);
  g.drawImage(img, -r, -r, size, size);
  // a highlight that sweeps across as it turns, and darkening behind the machine
  const shine = Math.pow(Math.max(0, Math.cos(flip - 0.7)), 10) * 0.55;
  if (shine > 0.02 || shade > 0.02) {
    g.beginPath();
    g.arc(0, 0, r * 0.97, 0, Math.PI * 2);
    g.clip();
    if (shine > 0.02) {
      g.globalAlpha = alpha * shine;
      g.fillStyle = '#ffffff';
      g.fillRect(-r, -r, size, size);
    }
    if (shade > 0.02) {
      g.globalAlpha = alpha * shade;
      g.fillStyle = '#10142a';
      g.fillRect(-r, -r, size, size);
    }
  }
  g.restore();
}

// ------------------------------------------------------------------------------------------------ painters

/**
 * How things are drawn, in strip coordinates (CSS px): Smooth (glows, after-images, a lean into the flight) or Retro
 * (pixel sprites on a half-resolution canvas, dithered ghosts, dotted trails, stepped twinkles). The flights and the
 * orbit are the same either way.
 */
interface Painter {
  begin(g: CanvasRenderingContext2D, c: HTMLCanvasElement): void;
  coin(g: CanvasRenderingContext2D, kind: CourierCoin, x: number, y: number, size: number, flip: number, lean: number, alpha: number, shade?: number): void;
  /** A faint copy left behind (motion blur). */
  ghost(g: CanvasRenderingContext2D, kind: CourierCoin, x: number, y: number, size: number, flip: number, alpha: number): void;
  /** One piece of a trail or a comet tail (`i` counts back from the coin). */
  trail(g: CanvasRenderingContext2D, color: string, x: number, y: number, r: number, alpha: number, i: number): void;
  halo(g: CanvasRenderingContext2D, color: string, x: number, y: number, r: number, alpha: number): void;
  shadow(g: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, alpha: number): void;
  spark(g: CanvasRenderingContext2D, x: number, y: number, size: number, f: number, n: number): void;
}

const smooth = (dpr: () => number): Painter => ({
  begin(g, c) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    g.imageSmoothingEnabled = true;
  },
  coin: (g, kind, x, y, size, flip, lean, alpha, shade = 0) => drawCoin(g, kind, x, y, size, flip, lean, alpha, shade),
  ghost: (g, kind, x, y, size, flip, alpha) => drawCoin(g, kind, x, y, size, flip, 0, alpha),
  trail(g, color, x, y, r, alpha) {
    g.globalAlpha = alpha;
    g.drawImage(glow(color), x - r, y - r, r * 2, r * 2);
    g.globalAlpha = 1;
  },
  halo(g, color, x, y, r, alpha) {
    g.globalAlpha = alpha;
    g.drawImage(glow(color), x - r, y - r, r * 2, r * 2);
    g.globalAlpha = 1;
  },
  shadow(g, x, y, rx, ry, alpha) {
    g.globalAlpha = alpha;
    g.fillStyle = '#000';
    g.beginPath();
    g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  },
  spark(g, x, y, size, f) {
    const s = size * (f < 0.2 ? f / 0.2 : 1 - (f - 0.2) / 0.8);
    g.globalAlpha = 0.9 * (1 - f);
    g.drawImage(glint(), x - s, y - s, s * 2, s * 2);
    g.globalAlpha = 1;
  },
});

/** Strip px to retro pixels. */
const L = (v: number) => Math.round(v / PX);
/** Eight frames to a turn, like a sprite sheet: face, three-quarter, edge-on, three-quarter, and round again. */
const FRAME_W = [1, 0.62, 0, 0.62, 1, 0.62, 0, 0.62];

const retro: Painter = {
  begin(g, c) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.imageSmoothingEnabled = false;
    g.globalAlpha = 1;
  },
  coin(g, kind, x, y, size, flip, _lean, alpha) {
    const a = art.get(kind);
    if (!a || alpha < 0.25) return;
    const sp = pixelSprite(kind, a, Math.max(3, Math.min(22, L(size))), darker(LOOK[kind].edge));
    if (!sp) return;
    const turn = ((flip % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const frame = Math.round(turn / (Math.PI / 4)) % 8;
    const fw = FRAME_W[frame];
    const cx = L(x);
    const top = L(y) - (sp.n >> 1);
    if (fw === 0) {
      // edge-on: a thin bar of rim with a lit line down it
      g.fillStyle = darker(LOOK[kind].edge);
      g.fillRect(cx - 1, top, 3, sp.n);
      g.fillStyle = LOOK[kind].edge;
      g.fillRect(cx, top + 1, 1, sp.n - 2);
      return;
    }
    const w = Math.max(3, Math.round(sp.n * fw));
    if (fw < 1) {
      // three-quarter: the rim shows on the side it's turning away from
      g.fillStyle = LOOK[kind].edge;
      g.fillRect(frame < 4 ? cx + (w >> 1) - 1 : cx - (w >> 1) - 1, top + 1, 2, sp.n - 2);
    }
    g.drawImage(alpha < 0.6 ? sp.ghost : sp.img, cx - (w >> 1), top, w, sp.n);
  },
  ghost(g, kind, x, y, size) {
    const a = art.get(kind);
    if (!a) return;
    const sp = pixelSprite(kind, a, Math.max(3, Math.min(22, L(size))), darker(LOOK[kind].edge));
    if (sp) g.drawImage(sp.ghost, L(x) - (sp.n >> 1), L(y) - (sp.n >> 1));
  },
  trail(g, color, x, y, r, alpha, i) {
    if (i % 2 || alpha < 0.12) return; // dotted
    g.fillStyle = color;
    const s = r > 9 ? 2 : 1;
    g.fillRect(L(x) - (s >> 1), L(y) - (s >> 1), s, s);
  },
  halo() {},
  shadow(g, x, y, rx, _ry, alpha) {
    if (alpha < 0.05) return;
    g.fillStyle = '#000';
    g.globalAlpha = 0.45;
    const cx = L(x);
    const cy = L(y);
    const half = Math.max(1, L(rx));
    for (let i = -half; i <= half; i++) if ((i + cx) % 2 === 0) g.fillRect(cx + i, cy, 1, 1);
    for (let i = -half + 2; i <= half - 2; i++) if ((i + cx) % 2 !== 0) g.fillRect(cx + i, cy + 1, 1, 1);
    g.globalAlpha = 1;
  },
  spark(g, x, y, _size, f, n) {
    pixelTwinkle(g, L(x), L(y), f, n % 3 === 0 ? '#ffff00' : '#ffffff');
  },
};

// ------------------------------------------------------------------------------------------------ for the money map

/**
 * One coin facing you, the same art the courier throws: its pixel sprite in Retro (dithered when faint), its smooth
 * coin otherwise. Coordinates in CSS px; a Retro canvas is at half resolution, a Smooth one is already scaled.
 */
export function paintCoin(g: CanvasRenderingContext2D, kind: CourierCoin, x: number, y: number, size: number, pixel: boolean, alpha = 1) {
  if (!pixel) return drawCoin(g, kind, x, y, size, 0, 0, alpha);
  if (alpha < 0.25) return;
  if (alpha < 0.6) retro.ghost(g, kind, x, y, size, 0, alpha);
  else retro.coin(g, kind, x, y, size, 0, 0, 1);
}

/** One dot of a coin's trail (`i` counts back from the coin): dotted pixels in Retro, a soft glow otherwise. */
export function paintTrail(g: CanvasRenderingContext2D, kind: CourierCoin, x: number, y: number, r: number, alpha: number, i: number, pixel: boolean) {
  if (pixel) retro.trail(g, LOOK[kind].glow, x, y, r, alpha, i);
  else {
    g.globalAlpha = alpha;
    g.drawImage(glow(LOOK[kind].glow), x - r, y - r, r * 2, r * 2);
    g.globalAlpha = 1;
  }
}

/** The coin art, rasterised once for `paintCoin` (the courier does the same when it mounts). */
export function CoinArt() {
  const icons = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    icons.current?.querySelectorAll<SVGSVGElement>('[data-coin] > svg').forEach((svg) => rasterise((svg.parentElement as HTMLElement).dataset.coin as CourierCoin, svg));
  }, []);
  return (
    <div ref={icons} className="courier-art" aria-hidden="true">
      {KINDS.map((k) => (
        <span key={k} data-coin={k}>
          {k === 'CB' ? <CoinbaseIcon size={SPRITE} /> : k === 'USDC' || k === 'USDT' ? <StableIcon ccy={k} size={SPRITE} /> : <CoinIcon coin={k} size={SPRITE} />}
        </span>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ the scene

interface Thrown {
  stream: string;
  /** The flight it left on (its onLand, if the stream has gone by the time it lands). */
  flight: Flight;
  coin: CourierCoin;
  from: number;
  to: number;
  born: number;
  dur: number;
  spin: number;
  landed: boolean;
}

interface Stream {
  flight: Flight;
  next: number;
}

interface Spark {
  n: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  size: number;
}

interface Ring {
  orbit: Orbit;
  born: number;
  /** When it started winding down (it spirals back into the machine), or 0. */
  ending: number;
}

export function Courier({ flights = [], orbit = null }: { flights?: Flight[]; orbit?: Orbit | null }) {
  const back = useRef<HTMLCanvasElement>(null);
  const front = useRef<HTMLCanvasElement>(null);
  const icons = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 0, h: 0, dpr: 1, pixel: false });
  const painter = useRef<Painter>(smooth(() => size.current.dpr));
  const raf = useRef(0);
  const streams = useRef(new Map<string, Stream>());
  const coins = useRef<Thrown[]>([]);
  const sparks = useRef<Spark[]>([]);
  const ring = useRef<Ring | null>(null);
  const draw = useRef<(now: number) => boolean>(() => false);

  // The coin art, rasterised from the hidden SVGs.
  useLayoutEffect(() => {
    icons.current?.querySelectorAll<SVGSVGElement>('[data-coin] > svg').forEach((svg) => {
      const kind = (svg.parentElement as HTMLElement).dataset.coin as CourierCoin;
      rasterise(kind, svg);
    });
  }, []);

  const wake = () => {
    if (raf.current || typeof requestAnimationFrame !== 'function') return;
    if (isCalm()) {
      draw.current(performance.now());
      return;
    }
    if (document.hidden) return;
    raf.current = requestAnimationFrame(function loop(t) {
      raf.current = 0;
      if (document.hidden || isCalm()) return;
      if (draw.current(t)) raf.current = requestAnimationFrame(loop);
    });
  };

  // Keep the streams and the ring in step with the props.
  const flightKey = flights.map((f) => `${f.id}:${f.from}:${f.to}:${f.coin}`).join('|');
  useEffect(() => {
    const now = performance.now() / 1000;
    const live = new Set(flights.map((f) => f.id));
    for (const id of streams.current.keys()) if (!live.has(id)) streams.current.delete(id);
    flights.forEach((f) => {
      const s = streams.current.get(f.id);
      if (s) s.flight = f;
      else streams.current.set(f.id, { flight: f, next: now });
    });
    wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flightKey]);
  // The latest onLand callbacks, without restarting the streams.
  flights.forEach((f) => {
    const s = streams.current.get(f.id);
    if (s) s.flight = f;
  });

  const orbitKey = orbit ? `${orbit.x}:${orbit.a}:${orbit.b}:${orbit.r ?? ''}` : '';
  useEffect(() => {
    const now = performance.now() / 1000;
    const r = ring.current;
    if (orbit) {
      if (!r || r.ending || r.orbit.x !== orbit.x) ring.current = { orbit, born: now, ending: 0 };
      else r.orbit = orbit;
    } else if (r && !r.ending) {
      // Calm draws no frames to wind it down in: it just goes.
      if (isCalm()) ring.current = null;
      else r.ending = now;
    }
    wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orbitKey]);

  draw.current = (t: number): boolean => {
    const now = t / 1000;
    const calm = isCalm();
    const { w, pixel } = size.current;
    const gb = back.current?.getContext('2d');
    const gf = front.current?.getContext('2d');
    if (!gb || !gf || !w || !back.current || !front.current) return false;
    const P = pixel ? retro : painter.current;
    const inner = w - 2 * PAD;
    const X = (pct: number) => PAD + (pct / 100) * inner;
    const Y = ICON_Y + PAD;

    P.begin(gb, back.current);
    P.begin(gf, front.current);

    // ---- new coins leave on time
    if (!calm) {
      for (const s of streams.current.values()) {
        if (s.next < now - 1) s.next = now; // back from a hidden tab: don't send a backlog
        while (s.next <= now) {
          const f = s.flight;
          const dist = Math.abs(X(f.to) - X(f.from));
          coins.current.push({ stream: f.id, flight: f, coin: f.coin, from: f.from, to: f.to, born: s.next, dur: Math.min(1.5, 0.82 + dist / 480), spin: (Math.random() < 0.5 ? -1 : 1) * (0.9 + Math.random() * 0.5), landed: false });
          s.next += GAP + Math.random() * 0.08;
        }
      }
    }

    // ---- the orbit
    const rg = ring.current;
    let ringAlive = false;
    if (rg) {
      const { x, a, b, r = 46 } = rg.orbit;
      const age = now - rg.born;
      const grow = calm ? 1 : easeOutBack(clamp01(age / 0.7));
      const shrink = rg.ending ? 1 - clamp01((now - rg.ending) / 0.45) : 1;
      const k = Math.max(0, grow * (rg.ending ? easeInOutCubic(shrink) : 1));
      if (rg.ending && shrink <= 0) ring.current = null;
      else {
        ringAlive = true;
        const cx = X(x);
        const cy = Y - 2;
        const rx = r * k;
        const ry = r * 0.3 * k;
        const tilt = -0.2;
        const speed = (Math.PI * 2) / 1.45;
        const base = calm ? 0.6 : age * speed;
        const ct = Math.cos(tilt);
        const st = Math.sin(tilt);
        const at = (th: number) => {
          const ex = rx * Math.cos(th);
          const ey = ry * Math.sin(th);
          return { x: cx + ex * ct - ey * st, y: cy + ex * st + ey * ct, z: Math.sin(th) };
        };
        const items: { th: number; kind: CourierCoin }[] = [
          { th: base, kind: a },
          { th: base + Math.PI, kind: b },
        ];
        // comet tails first, each piece on the side of the machine it's on
        for (const it of items) {
          const col = LOOK[it.kind].glow;
          for (let i = 14; i >= 1; i--) {
            const p = at(it.th - i * 0.075);
            const f = 1 - i / 15;
            const s = (7 + 9 * f) * (0.75 + 0.3 * (p.z + 1) * 0.5) * k;
            P.trail(p.z >= 0 ? gf : gb, col, p.x, p.y, s, 0.5 * f * (0.55 + 0.45 * (p.z + 1) * 0.5) * shrink, i);
          }
        }
        // then the coins, far one first
        items
          .map((it) => ({ ...it, p: at(it.th) }))
          .sort((m, n) => m.p.z - n.p.z)
          .forEach(({ kind, th, p }) => {
            const g = p.z >= 0 ? gf : gb;
            const depth = (p.z + 1) * 0.5;
            const s = SIZE * (0.66 + 0.42 * depth) * Math.min(1, k * 1.1);
            P.halo(g, LOOK[kind].glow, p.x, p.y, s * 0.95, 0.55 * shrink);
            P.coin(g, kind, p.x, p.y, s, calm ? 0.35 : now * (pixel ? 2 : 4.2) + th, Math.cos(th) * 0.18, Math.min(1, shrink * 1.4), (1 - depth) * 0.38);
            if (!calm && depth > 0.6 && Math.random() < 0.18) sparks.current.push({ n: sparkN++, x: p.x + (Math.random() - 0.5) * s * 0.6, y: p.y + (Math.random() - 0.5) * s * 0.6, vx: (Math.random() - 0.5) * 20, vy: 10 + Math.random() * 18, born: now, life: 0.45 + Math.random() * 0.3, size: 3 + Math.random() * 4 });
          });
      }
    }

    // ---- thrown coins
    const still: Thrown[] = [];
    const list = calm ? [...streams.current.values()].map((s) => ({ stream: s.flight.id, flight: s.flight, coin: s.flight.coin, from: s.flight.from, to: s.flight.to, born: now - 0.5, dur: 1, spin: 1, landed: true })) : coins.current;
    for (const c of list) {
      const t = (now - c.born) / c.dur;
      if (t >= 1) {
        if (!c.landed) {
          c.landed = true;
          (streams.current.get(c.stream)?.flight ?? c.flight).onLand?.();
        }
        continue;
      }
      if (t < 0) {
        still.push(c);
        continue;
      }
      still.push(c);
      const x0 = X(c.from) + 14;
      const x1 = X(c.to) - 2;
      const dir = x1 >= x0 ? 1 : -1;
      const dist = Math.abs(x1 - x0);
      const arc = 26 + dist * 0.07;
      const path = (tt: number) => {
        const u = 0.3 * tt + 0.7 * easeInOutCubic(clamp01(tt));
        const x = x0 + (x1 - x0) * u;
        const y = Y - arc * 4 * u * (1 - u);
        return { x, y, u };
      };
      // size: pops out of the source, swells at the top of the arc, dives small into the target
      const pop = easeOutBack(clamp01(t / 0.16));
      const dive = 1 - easeInOutCubic(clamp01((t - 0.8) / 0.2)) * 0.62;
      const here = path(t);
      const lift = Math.sin(Math.PI * here.u);
      const s = SIZE * pop * dive * (0.86 + 0.3 * lift);
      const fade = t > 0.93 ? 1 - (t - 0.93) / 0.07 : 1;
      const flip = c.spin * Math.PI * 2 * here.u;

      // its shadow on the track
      P.shadow(gb, here.x, Y + 13, s * 0.5 * (1 - lift * 0.35), 2.4 * (1 - lift * 0.3), 0.2 * (1 - lift * 0.6) * fade * Math.min(1, pop));

      // after-images and a glow trail: motion blur, drawn at its own earlier places
      if (!calm) {
        for (let i = 8; i >= 1; i--) {
          const tt = t - i * 0.016;
          if (tt <= 0) continue;
          const p = path(tt);
          const f = 1 - i / 9;
          P.trail(gf, LOOK[c.coin].glow, p.x, p.y, s * (0.35 + 0.35 * f), 0.42 * f * fade, i);
        }
        // retro leaves one dithered ghost a little way back; smooth, a few faint copies close behind
        for (let i = pixel ? 1 : 3; i >= 1; i--) {
          const tt = t - i * (pixel ? 0.07 : 0.022);
          if (tt <= 0) continue;
          const p = path(tt);
          P.ghost(gf, c.coin, p.x, p.y, s * (1 - i * 0.06), c.spin * Math.PI * 2 * p.u, 0.16 * (1 - i / 4) * fade);
        }
      }
      // the coin, leaning into its flight
      const ahead = path(Math.min(1, t + 0.02));
      const lean = Math.atan2(ahead.y - here.y, ahead.x - here.x) * 0.35;
      P.coin(gf, c.coin, here.x, here.y, s, flip, lean, fade);
      if (!calm && Math.random() < (pixel ? 0.14 : 0.35)) sparks.current.push({ n: sparkN++, x: here.x - dir * s * 0.3, y: here.y + (Math.random() - 0.5) * s * 0.5, vx: -dir * (10 + Math.random() * 25), vy: 8 + Math.random() * 20, born: now, life: 0.35 + Math.random() * 0.3, size: 2.5 + Math.random() * 4 });
    }
    if (!calm) coins.current = still;

    // ---- glints left behind
    const keep: Spark[] = [];
    for (const p of sparks.current) {
      const age = now - p.born;
      if (age >= p.life) continue;
      keep.push(p);
      P.spark(gf, p.x + p.vx * age, p.y + p.vy * age, p.size, age / p.life, p.n);
    }
    sparks.current = keep.length > 120 ? keep.slice(-120) : keep;
    gb.globalAlpha = 1;
    gf.globalAlpha = 1;

    return !calm && (streams.current.size > 0 || coins.current.length > 0 || ringAlive || sparks.current.length > 0);
  };

  // Sized to the strip plus a margin (arcs fly above it), sharp on high-DPI screens.
  useEffect(() => {
    const host = back.current?.parentElement;
    if (!host) return;
    const fit = () => {
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const pixel = isRetro();
      const w = host.clientWidth + 2 * PAD;
      const h = host.clientHeight + 2 * PAD;
      size.current = { w, h, dpr, pixel };
      for (const c of [back.current, front.current]) {
        if (!c) continue;
        // retro: half resolution, blown up without smoothing (every pixel a 2x2 block)
        c.width = pixel ? Math.ceil(w / PX) : Math.round(w * dpr);
        c.height = pixel ? Math.ceil(h / PX) : Math.round(h * dpr);
        c.style.width = `${w}px`;
        c.style.height = `${h}px`;
        c.style.imageRendering = pixel ? 'pixelated' : '';
      }
      if (isCalm()) draw.current(performance.now());
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(host);
    const onWake = () => wake();
    const onPrefs = () => {
      if (isRetro() !== size.current.pixel) fit(); // Smooth and Retro draw at different resolutions
      wake();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('wc:prefs', onPrefs);
    // the art loads a moment after mount: draw again once it's there
    const late = setTimeout(onWake, 120);
    return () => {
      ro?.disconnect();
      clearTimeout(late);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('wc:prefs', onPrefs);
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <canvas ref={back} className="courier is-back" aria-hidden="true" style={{ left: -PAD, top: -PAD }} />
      <canvas ref={front} className="courier is-front" aria-hidden="true" style={{ left: -PAD, top: -PAD }} />
      <div ref={icons} className="courier-art" aria-hidden="true">
        {KINDS.map((k) => (
          <span key={k} data-coin={k}>
            {k === 'CB' ? <CoinbaseIcon size={SPRITE} /> : k === 'USDC' || k === 'USDT' ? <StableIcon ccy={k} size={SPRITE} /> : <CoinIcon coin={k} size={SPRITE} />}
          </span>
        ))}
      </div>
    </>
  );
}
