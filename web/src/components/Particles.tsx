import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { isCalm, isRetro } from '../lib/motion';
import { PX } from './pixelArt';

/**
 * A canvas of particles laid over an animation strip: bursts, sparks, confetti and slow drifting motes.
 *
 * One pre-allocated pool, no allocation per frame, drawn with cached glow sprites. The loop runs only while
 * something is alive (or an ambient emitter is on), and stops when the tab is hidden or Animations is set to Calm.
 * Positions are given like the strip's stations: x in percent of the strip's width, y in pixels from its top.
 * Retro draws every particle as solid 2x2-pixel blocks on a half-resolution canvas: no glow, no fading (they flicker out).
 */

export type Shape = 'dot' | 'spark' | 'confetti' | 'mote';

export interface EmitOptions {
  count: number;
  colors: string[];
  shape?: Shape;
  /** px/s, picked at random between the two. */
  speed?: [number, number];
  /** Direction in degrees (0 = right, -90 = up) and the spread around it. */
  angle?: number;
  spread?: number;
  /** px/s², downwards. Negative floats up. */
  gravity?: number;
  /** ms */
  life?: [number, number];
  size?: [number, number];
  /** Fraction of speed lost per second. */
  drag?: number;
  /** Start on a ring this many px out, heading in (a swirl into a machine). */
  inward?: number;
}

export interface Ambient extends EmitOptions {
  x: number;
  y: number;
  /** Particles per second. */
  rate: number;
  /** Spawn anywhere within ±jitter px of the point. */
  jitter?: number;
}

export interface ParticleApi {
  emit(x: number, y: number, o: EmitOptions): void;
}

/** How far the canvas reaches past the strip, so bursts aren't cut off at its edges. */
const PAD = 28;
const MAX = 360;

interface P {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  color: string;
  shape: Shape;
  gravity: number;
  drag: number;
  spin: number;
  rot: number;
  wobble: number;
}

const blank = (): P => ({ alive: false, x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1, size: 1, color: '#fff', shape: 'dot', gravity: 0, drag: 0, spin: 0, rot: 0, wobble: 0 });

/** A soft glowing dot per colour (#rrggbb), drawn once. */
const sprites = new Map<string, HTMLCanvasElement>();
function sprite(color: string): HTMLCanvasElement {
  let c = sprites.get(color);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.22, color);
  grad.addColorStop(0.55, `${color}66`);
  grad.addColorStop(1, `${color}00`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  sprites.set(color, c);
  return c;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: T[]) => xs[(Math.random() * xs.length) | 0];

export const ParticleLayer = forwardRef<ParticleApi, { ambient?: Ambient[] }>(function ParticleLayer({ ambient }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const parts = useRef<P[]>(Array.from({ length: MAX }, blank));
  const size = useRef({ w: 0, h: 0, dpr: 1, pixel: false });
  const tick = useRef(0);
  const raf = useRef(0);
  const last = useRef(0);
  const alive = useRef(0);
  const ambientRef = useRef<Ambient[]>([]);
  const carry = useRef<number[]>([]);
  ambientRef.current = ambient ?? [];

  const spawn = (px: number, py: number, o: EmitOptions) => {
    const list = parts.current;
    const [s0, s1] = o.speed ?? [60, 180];
    const [l0, l1] = o.life ?? [500, 900];
    const [z0, z1] = o.size ?? [2, 4];
    const dir = ((o.angle ?? 0) * Math.PI) / 180;
    const spread = ((o.spread ?? 360) * Math.PI) / 180;
    for (let n = 0, i = 0; n < o.count && i < list.length; i++) {
      const p = list[i];
      if (p.alive) continue;
      n++;
      const a = dir + (Math.random() - 0.5) * spread;
      const sp = rand(s0, s1);
      p.alive = true;
      p.age = 0;
      p.life = rand(l0, l1);
      p.size = rand(z0, z1);
      p.color = pick(o.colors);
      p.shape = o.shape ?? 'dot';
      p.gravity = o.gravity ?? 0;
      p.drag = o.drag ?? 0.8;
      p.rot = Math.random() * Math.PI * 2;
      p.spin = rand(-9, 9);
      p.wobble = Math.random() * Math.PI * 2;
      if (o.inward) {
        // Start on a ring, fly in with a twist.
        p.x = px + Math.cos(a) * o.inward;
        p.y = py + Math.sin(a) * o.inward * 0.6;
        const t = a + Math.PI + 0.9;
        p.vx = Math.cos(t) * sp;
        p.vy = Math.sin(t) * sp * 0.6;
      } else {
        p.x = px;
        p.y = py;
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp;
      }
      alive.current++;
    }
  };

  const frame = (t: number) => {
    raf.current = 0;
    const c = canvas.current;
    if (!c || document.hidden || isCalm()) {
      parts.current.forEach((p) => (p.alive = false));
      alive.current = 0;
      c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
      return;
    }
    const g = c.getContext('2d');
    if (!g) return; // no canvas here (an old browser, a test): just no particles
    const dt = Math.min(1 / 30, last.current ? (t - last.current) / 1000 : 1 / 60);
    last.current = t;
    const { w, h, dpr } = size.current;

    // Ambient emitters: a steady trickle.
    ambientRef.current.forEach((a, i) => {
      carry.current[i] = (carry.current[i] ?? Math.random()) + a.rate * dt;
      while (carry.current[i] >= 1) {
        carry.current[i] -= 1;
        const j = a.jitter ?? 0;
        spawn(((a.x / 100) * (w - 2 * PAD)) + PAD + rand(-j, j), a.y + PAD + rand(-j / 2, j / 2), { ...a, count: 1 });
      }
    });

    const pixel = size.current.pixel;
    tick.current++;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(pixel ? 1 / PX : dpr, 0, 0, pixel ? 1 / PX : dpr, 0, 0);
    g.imageSmoothingEnabled = !pixel;
    let n = 0;
    for (const p of parts.current) {
      if (!p.alive) continue;
      p.age += dt * 1000;
      if (p.age >= p.life) {
        p.alive = false;
        continue;
      }
      n++;
      const k = Math.max(0, 1 - p.drag * dt);
      p.vx *= k;
      p.vy = p.vy * k + p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      const life = p.age / p.life;
      const fade = life < 0.15 ? life / 0.15 : 1 - Math.pow((life - 0.15) / 0.85, 1.6);
      if (pixel) {
        // solid blocks on the pixel grid; the last of a particle's life flickers instead of fading
        if (life > 0.15 && fade < 0.35 && (tick.current + n) % 2) continue;
        const snap = (v: number) => Math.round(v / PX) * PX;
        const blocks = p.shape === 'spark' || p.shape === 'mote' ? 1 : p.shape === 'confetti' ? 2 : p.size > 2.6 ? 2 : 1;
        const flat = p.shape === 'confetti' && Math.cos(p.rot * 1.7) < 0;
        g.globalAlpha = 1;
        g.fillStyle = p.color;
        g.fillRect(snap(p.x), snap(p.y), (flat ? 1 : blocks) * PX, (p.shape === 'confetti' && !flat ? 1 : blocks) * PX);
        continue;
      }
      g.globalAlpha = Math.max(0, fade);
      if (p.shape === 'confetti') {
        const flip = Math.cos(p.rot * 1.7);
        g.setTransform(dpr * Math.cos(p.rot), dpr * Math.sin(p.rot) * flip, -dpr * Math.sin(p.rot), dpr * Math.cos(p.rot) * flip, p.x * dpr, p.y * dpr);
        g.fillStyle = p.color;
        g.fillRect(-p.size, -p.size * 0.45, p.size * 2, p.size * 0.9);
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
      } else if (p.shape === 'spark') {
        const len = Math.min(14, Math.hypot(p.vx, p.vy) * 0.045) + 1;
        const a = Math.atan2(p.vy, p.vx);
        g.strokeStyle = p.color;
        g.lineWidth = p.size * 0.6 * (1 - life * 0.5);
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(p.x - Math.cos(a) * len, p.y - Math.sin(a) * len);
        g.stroke();
      } else {
        const x = p.shape === 'mote' ? p.x + Math.sin(p.wobble + p.age / 380) * 3 : p.x;
        const s = p.size * (p.shape === 'mote' ? 3 : 2.6) * (p.shape === 'dot' ? 1 - life * 0.4 : 1);
        g.drawImage(sprite(p.color), x - s, p.y - s, s * 2, s * 2);
      }
    }
    g.globalAlpha = 1;
    alive.current = n;
    if (n > 0 || ambientRef.current.length) raf.current = requestAnimationFrame(frame);
    else last.current = 0;
  };

  const wake = () => {
    if (!raf.current && !document.hidden && !isCalm() && canvas.current?.getContext('2d')) {
      last.current = 0;
      raf.current = requestAnimationFrame(frame);
    }
  };

  useImperativeHandle(ref, () => ({
    emit(x, y, o) {
      if (isCalm() || document.hidden) return;
      const { w } = size.current;
      spawn((x / 100) * (w - 2 * PAD) + PAD, y + PAD, o);
      wake();
    },
  }));

  // Sized to the strip (plus its margin), sharp on high-DPI screens.
  useEffect(() => {
    const c = canvas.current;
    const host = c?.parentElement;
    if (!c || !host) return;
    const fit = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = host.clientWidth + 2 * PAD;
      const h = host.clientHeight + 2 * PAD;
      const pixel = isRetro();
      size.current = { w, h, dpr, pixel };
      c.width = pixel ? Math.ceil(w / PX) : Math.round(w * dpr);
      c.height = pixel ? Math.ceil(h / PX) : Math.round(h * dpr);
      c.style.imageRendering = pixel ? 'pixelated' : '';
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(host);
    const onVis = () => wake();
    const onPrefs = () => {
      if (isRetro() !== size.current.pixel) fit(); // Smooth and Retro draw at different resolutions
      wake();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('wc:prefs', onPrefs);
    return () => {
      ro?.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('wc:prefs', onPrefs);
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An ambient emitter starts the loop on its own.
  const ambientKey = (ambient ?? []).map((a) => `${a.x}:${a.y}:${a.rate}`).join('|');
  useEffect(() => {
    carry.current = [];
    if (ambientKey) wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ambientKey]);

  return <canvas ref={canvas} className="particles" aria-hidden="true" style={{ left: -PAD, top: -PAD }} />;
});

/** Ready-made effects, so every strip feels the same. */
export const FX = {
  /** A coin landing: a small splash, low and quick. */
  land: (colors: string[]): EmitOptions => ({ count: 9, colors, shape: 'spark', speed: [70, 150], angle: -90, spread: 150, gravity: 380, life: [280, 480], size: [2, 3], drag: 2 }),
  /** Something arriving with force: a ring of sparks plus glowing dots. */
  burst: (colors: string[]): EmitOptions => ({ count: 26, colors, shape: 'spark', speed: [110, 260], life: [420, 760], size: [2, 3.4], drag: 2.4, gravity: 60 }),
  glow: (colors: string[]): EmitOptions => ({ count: 14, colors, shape: 'dot', speed: [30, 110], life: [500, 900], size: [1.6, 2.8], drag: 1.6, gravity: -20 }),
  /** The finish: confetti thrown up, falling back. */
  confetti: (colors: string[]): EmitOptions => ({ count: 70, colors, shape: 'confetti', speed: [140, 330], angle: -90, spread: 110, gravity: 420, life: [1300, 2100], size: [2.5, 4.2], drag: 1.1 }),
  /** One Monero block: a small twinkle. */
  tick: (colors: string[]): EmitOptions => ({ count: 10, colors, shape: 'dot', speed: [40, 90], life: [380, 620], size: [1.4, 2.4], drag: 2.2 }),
  /** A slow glowing mote drifting up (ambient life while money waits). */
  mote: (colors: string[]): EmitOptions => ({ count: 1, colors, shape: 'mote', speed: [6, 18], angle: -90, spread: 50, gravity: -10, life: [2000, 3200], size: [0.7, 1.4], drag: 0.15 }),
  /** Particles spiralling into a machine. */
  swirl: (colors: string[]): EmitOptions => ({ count: 1, colors, shape: 'dot', speed: [70, 110], life: [380, 520], size: [1.4, 2.4], drag: 0.6, inward: 34 }),
};
