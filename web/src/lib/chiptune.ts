import { audioOut } from './sound';

/**
 * The money map's sound effects, 8-bit style: only pulse, triangle and noise voices, like an old console's sound chip.
 * A coin when coins arrive somewhere, a blip as they set off, a power-up for a swap, a jump for a hop, a clunk for the
 * vault, a fanfare at the end. (No music: just the moments.)
 */

type Out = NonNullable<ReturnType<typeof audioOut>>;

const pulses = new WeakMap<AudioContext, Record<number, PeriodicWave>>();
const noises = new WeakMap<AudioContext, AudioBuffer>();

/** A pulse wave with this duty cycle (0.125, 0.25 or 0.5): thinner duties are the classic reedy 8-bit lead. */
function pulse(c: AudioContext, duty: number): PeriodicWave {
  const cache = pulses.get(c) ?? {};
  pulses.set(c, cache);
  if (!cache[duty]) {
    const n = 48;
    const real = new Float32Array(n);
    const imag = new Float32Array(n);
    for (let k = 1; k < n; k++) {
      real[k] = Math.sin(2 * Math.PI * k * duty) / (k * Math.PI);
      imag[k] = (1 - Math.cos(2 * Math.PI * k * duty)) / (k * Math.PI);
    }
    cache[duty] = c.createPeriodicWave(real, imag);
  }
  return cache[duty];
}

/** Crunchy noise: random values held for a few samples, like the chips' noise channel. */
function noiseBuffer(c: AudioContext): AudioBuffer {
  let b = noises.get(c);
  if (!b) {
    b = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = b.getChannelData(0);
    let v = 0;
    for (let i = 0; i < d.length; i++) {
      if (i % 4 === 0) v = Math.random() * 2 - 1;
      d[i] = v;
    }
    noises.set(c, b);
  }
  return b;
}

interface NoteOpts {
  /** A pulse duty cycle, or the triangle (the chips' bass voice). */
  wave?: number | 'triangle';
  gain?: number;
  slideTo?: number;
  /** Fades out over the note (a pluck); otherwise it holds and stops short. */
  pluck?: boolean;
}

function note(a: Out, freq: number, at: number, dur: number, { wave = 0.25, gain = 0.05, slideTo, pluck = true }: NoteOpts = {}) {
  const osc = a.c.createOscillator();
  if (wave === 'triangle') osc.type = 'triangle';
  else osc.setPeriodicWave(pulse(a.c, wave));
  osc.frequency.setValueAtTime(freq, at);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
  const env = a.c.createGain();
  env.gain.setValueAtTime(gain, at);
  if (pluck) env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  else env.gain.setValueAtTime(0.0001, at + dur);
  osc.connect(env).connect(a.out);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

function noise(a: Out, at: number, dur: number, { gain = 0.04, from = 6000, to }: { gain?: number; from?: number; to?: number } = {}) {
  const src = a.c.createBufferSource();
  src.buffer = noiseBuffer(a.c);
  const filter = a.c.createBiquadFilter();
  filter.type = to ? 'bandpass' : 'highpass';
  filter.frequency.setValueAtTime(from, at);
  if (to) filter.frequency.exponentialRampToValueAtTime(to, at + dur);
  const env = a.c.createGain();
  env.gain.setValueAtTime(gain, at);
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(filter).connect(env).connect(a.out);
  src.start(at, Math.random() * 0.5);
  src.stop(at + dur + 0.02);
}

const play = (fn: (a: Out, t: number) => void) => () => {
  const a = audioOut();
  if (a) fn(a, a.c.currentTime + 0.01);
};

/** Note frequencies, by name. */
const N = { C5: 523.25, E5: 659.25, G5: 783.99, B5: 987.77, C6: 1046.5, E6: 1318.51, G6: 1567.98, C7: 2093 };

export const chip = {
  /** Coins arrive somewhere: the two-note coin pickup. */
  coin: play((a, t) => {
    note(a, N.B5, t, 0.07, { wave: 0.5, gain: 0.05, pluck: false });
    note(a, N.E6, t + 0.07, 0.42, { wave: 0.5, gain: 0.05 });
  }),
  /** Coins set off: a quick upward blip. */
  dash: play((a, t) => {
    note(a, 520, t, 0.09, { wave: 0.125, gain: 0.03, slideTo: 1240 });
    noise(a, t, 0.06, { gain: 0.015, from: 3000 });
  }),
  /** FixedFloat swaps: a power-up run up three octaves. */
  powerUp: play((a, t) => {
    [N.C5, N.E5, N.G5, N.C6, N.E6, N.G6, N.C7].forEach((f, i) => note(a, f, t + i * 0.045, 0.07, { wave: 0.25, gain: 0.035, pluck: false }));
  }),
  /** A piece moves once more on its own: a jump. */
  jump: play((a, t) => note(a, 300, t, 0.2, { wave: 0.25, gain: 0.04, slideTo: 980 })),
  /** The vault locks: a low clunk. */
  lock: play((a, t) => {
    note(a, 220, t, 0.16, { wave: 'triangle', gain: 0.16, slideTo: 55 });
    noise(a, t, 0.1, { gain: 0.05, from: 900, to: 200 });
  }),
  /** The vault opens for a piece: a rising sweep. */
  open: play((a, t) => {
    note(a, 330, t, 0.26, { wave: 0.125, gain: 0.035, slideTo: 1760 });
    noise(a, t + 0.04, 0.2, { gain: 0.02, from: 1200, to: 6000 });
  }),
  /** Everything has arrived: a short fanfare. */
  fanfare: play((a, t) => {
    [N.G5, N.C6, N.E6, N.G6].forEach((f, i) => note(a, f, t + i * 0.09, 0.09, { wave: 0.25, gain: 0.04, pluck: false }));
    [N.C7, N.G6, N.E6].forEach((f) => note(a, f, t + 0.38, 0.75, { wave: 0.5, gain: 0.025 }));
    note(a, 130.81, t + 0.38, 0.75, { wave: 'triangle', gain: 0.14 });
    noise(a, t + 0.38, 0.3, { gain: 0.03, from: 5000 });
  }),
};
