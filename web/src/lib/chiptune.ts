import { audioOut } from './sound';

/**
 * The money map's soundtrack, 8-bit style: only pulse, triangle and noise voices, like an old console's sound chip.
 * While the coins move a minor bass line pulses under a hi-hat and a quiet arpeggio; the moments get effects: a coin
 * when coins arrive somewhere, a power-up for a swap, a jump for a hop, a clunk for the vault, a fanfare at the end.
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
const N = { E2: 82.41, F2: 87.31, A2: 110, E4: 329.63, F4: 349.23, Gs4: 415.3, A4: 440, B4: 493.88, C5: 523.25, E5: 659.25, G5: 783.99, B5: 987.77, C6: 1046.5, E6: 1318.51, G6: 1567.98, C7: 2093 };

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

/** The loop: four bars (A minor, A minor, F, E), eighth notes. The E bar leans back into A, so it never settles. */
const BPM = 140;
const STEP = 60 / BPM / 2;
const BARS = [
  { root: N.A2, arp: [N.A4, N.C5, N.E5, N.C5] },
  { root: N.A2, arp: [N.A4, N.C5, N.E5, N.C5] },
  { root: N.F2, arp: [N.F4, N.A4, N.C5, N.A4] },
  { root: N.E2, arp: [N.E4, N.Gs4, N.B4, N.Gs4] },
];
/** The bass under each eighth: root, root, octave, root, fifth, root, octave, fifth. */
const BASS = [1, 1, 2, 1, 1.5, 1, 2, 1.5];

let beatTimer: ReturnType<typeof setInterval> | null = null;
let nextAt = 0;
let step = 0;

function scheduleBeat() {
  const a = audioOut();
  if (!a) return;
  const ahead = a.c.currentTime + 0.25;
  if (nextAt < a.c.currentTime) nextAt = a.c.currentTime + 0.05;
  while (nextAt < ahead) {
    const bar = BARS[Math.floor(step / 8) % BARS.length];
    const i = step % 8;
    // The pulse: a triangle bass on every eighth, a kick on the beat, a snare on 2 and 4, a hi-hat between.
    note(a, bar.root * BASS[i], nextAt, STEP * 0.9, { wave: 'triangle', gain: 0.13 });
    if (i % 4 === 0) note(a, 160, nextAt, 0.09, { wave: 'triangle', gain: 0.2, slideTo: 45 });
    if (i % 4 === 2) noise(a, nextAt, 0.09, { gain: 0.035, from: 1800, to: 1200 });
    noise(a, nextAt, i % 2 ? 0.05 : 0.025, { gain: i % 2 ? 0.018 : 0.01, from: 7000 });
    // A quiet arpeggio on top, one note per eighth.
    note(a, bar.arp[i % 4] * (i < 4 ? 1 : 2), nextAt, STEP * 0.8, { wave: 0.125, gain: 0.014 });
    nextAt += STEP;
    step++;
  }
}

/** Starts or stops the loop (it keeps time on the audio clock, so it doesn't stutter when the page is busy). */
export function beat(on: boolean): void {
  if (on && !beatTimer) {
    step = 0;
    nextAt = 0;
    scheduleBeat();
    beatTimer = setInterval(scheduleBeat, 60);
  } else if (!on && beatTimer) {
    clearInterval(beatTimer);
    beatTimer = null;
  }
}
