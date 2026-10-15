import { getPref } from './prefs';

/** All sounds are synthesized with Web Audio, so there are no audio files to ship. */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function audio(): { c: AudioContext; out: GainNode } | null {
  if (!getPref('sound')) return null;
  try {
    if (!ctx) {
      ctx = new AudioContext();
      const comp = ctx.createDynamicsCompressor();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return { c: ctx, out: master! };
  } catch {
    return null;
  }
}

/** 'off' = muted by the user, 'locked' = the browser is still waiting for a click before it allows audio. */
export function audioState(): 'off' | 'locked' | 'ready' {
  if (!getPref('sound')) return 'off';
  return ctx?.state === 'running' ? 'ready' : 'locked';
}

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  slideTo?: number;
  /** Low-pass cutoff in Hz, to tame buzzy waveforms into something brassy. */
  lowpass?: number;
}

function tone(freq: number, start: number, dur: number, { type = 'sine', gain = 0.12, attack = 0.006, slideTo, lowpass }: ToneOpts = {}) {
  const a = audio();
  if (!a) return;
  const t0 = a.c.currentTime + start;
  const osc = a.c.createOscillator();
  const env = a.c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  if (lowpass) {
    const filter = a.c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lowpass;
    osc.connect(filter).connect(env).connect(a.out);
  } else {
    osc.connect(env).connect(a.out);
  }
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

function whoosh(start: number, dur: number, from: number, to: number, gain = 0.1) {
  const a = audio();
  if (!a) return;
  const t0 = a.c.currentTime + start;
  const buffer = a.c.createBuffer(1, Math.ceil(a.c.sampleRate * dur), a.c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = a.c.createBufferSource();
  src.buffer = buffer;
  const filter = a.c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 0.9;
  filter.frequency.setValueAtTime(from, t0);
  filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const env = a.c.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + dur * 0.35);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(env).connect(a.out);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

const coins = (at: number, gain = 0.06) =>
  [1318.5, 1661.2, 1975.5, 2637].forEach((f, i) => {
    tone(f, at + i * 0.07, 0.6, { gain });
    tone(f * 2.01, at + i * 0.07, 0.3, { gain: gain / 4 });
  });

type Voice = Record<'ding' | 'swap' | 'send' | 'tada' | 'error' | 'unlock', () => void>;

/** Each theme has its own set of sounds for the moments that matter. */
const VOICES: Record<'win95' | 'win98' | 'win10' | 'win11', Voice> = {
  win98: {
    /** Payment detected: a bright bell, then a shimmer of coins. */
    ding: () => {
      tone(1568, 0, 1.2, { gain: 0.14 });
      tone(2093, 0, 0.9, { gain: 0.04 });
      tone(3136, 0, 0.45, { gain: 0.03 });
      coins(0.32);
    },
    swap: () => {
      whoosh(0, 0.4, 400, 2600, 0.08);
      tone(660, 0.12, 0.12, { type: 'square', gain: 0.03 });
      tone(990, 0.24, 0.16, { type: 'square', gain: 0.03 });
    },
    send: () => {
      whoosh(0, 0.5, 260, 4200, 0.12);
      tone(440, 0.05, 0.32, { gain: 0.05, slideTo: 1320 });
    },
    tada: () => {
      [523.25, 659.25, 783.99].forEach((f, i) => tone(f, i * 0.09, 0.3, { type: 'triangle', gain: 0.08 }));
      [523.25, 659.25, 783.99, 1046.5].forEach((f) => tone(f, 0.34, 1.3, { type: 'triangle', gain: 0.06 }));
      tone(2093, 0.34, 0.8, { gain: 0.02 });
    },
    error: () => {
      tone(233, 0, 0.12, { type: 'square', gain: 0.04 });
      tone(175, 0.13, 0.2, { type: 'square', gain: 0.04 });
    },
    unlock: () => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.06, 0.34, { type: 'triangle', gain: 0.07 })),
  },
  win95: {
    /** A big major chord, then coins. */
    ding: () => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f) => tone(f, 0, 1.1, { type: 'sawtooth', gain: 0.028, lowpass: 2400 }));
      tone(1046.5, 0, 0.9, { type: 'triangle', gain: 0.06 });
      coins(0.42, 0.05);
    },
    swap: () => {
      whoosh(0, 0.35, 500, 2200, 0.07);
      tone(523.25, 0.1, 0.14, { type: 'square', gain: 0.03, lowpass: 1800 });
      tone(783.99, 0.22, 0.18, { type: 'square', gain: 0.03, lowpass: 1800 });
    },
    send: () => {
      whoosh(0, 0.55, 200, 3600, 0.11);
      tone(392, 0.05, 0.36, { type: 'triangle', gain: 0.05, slideTo: 1175 });
    },
    /** The classic brassy "ta-da": a short pickup chord, then the big one. */
    tada: () => {
      [392, 493.88, 587.33].forEach((f) => tone(f, 0, 0.16, { type: 'sawtooth', gain: 0.035, lowpass: 2600 }));
      [523.25, 659.25, 783.99, 1046.5].forEach((f) => tone(f, 0.19, 1.5, { type: 'sawtooth', gain: 0.03, lowpass: 2600 }));
      [523.25, 1046.5].forEach((f) => tone(f, 0.19, 1.5, { type: 'triangle', gain: 0.05 }));
    },
    error: () => {
      tone(196, 0, 0.18, { type: 'square', gain: 0.045, lowpass: 1200 });
      tone(185, 0.2, 0.25, { type: 'square', gain: 0.045, lowpass: 1200 });
    },
    unlock: () => {
      [261.63, 392, 523.25, 659.25, 783.99].forEach((f, i) => tone(f, i * 0.12, 1.4 - i * 0.12, { type: 'triangle', gain: 0.05 }));
    },
  },
  win10: {
    /** A soft two-note notification. */
    ding: () => {
      tone(1318.5, 0, 0.45, { gain: 0.1 });
      tone(2637, 0, 0.2, { gain: 0.02 });
      tone(1760, 0.13, 0.7, { gain: 0.1 });
      tone(3520, 0.13, 0.25, { gain: 0.015 });
      coins(0.5, 0.035);
    },
    swap: () => {
      whoosh(0, 0.3, 700, 2400, 0.05);
      tone(880, 0.08, 0.18, { gain: 0.05 });
    },
    send: () => {
      whoosh(0, 0.45, 300, 3000, 0.07);
      tone(660, 0.05, 0.3, { gain: 0.04, slideTo: 1320 });
    },
    tada: () => {
      [1046.5, 1318.5, 1568].forEach((f, i) => tone(f, i * 0.11, 0.9, { gain: 0.07 }));
      tone(2093, 0.33, 1.1, { gain: 0.04 });
    },
    error: () => {
      tone(220, 0, 0.18, { gain: 0.12 });
      tone(196, 0.16, 0.3, { gain: 0.1 });
    },
    unlock: () => [659.25, 987.77, 1318.5].forEach((f, i) => tone(f, i * 0.09, 0.7, { gain: 0.07 })),
  },
  win11: {
    /** A rounder, airy chime. */
    ding: () => {
      tone(784, 0, 0.9, { gain: 0.09 });
      tone(786.5, 0, 0.9, { gain: 0.05 });
      tone(1174.7, 0.09, 1.0, { gain: 0.08 });
      tone(1568, 0.18, 1.1, { gain: 0.05 });
      coins(0.55, 0.03);
    },
    swap: () => {
      whoosh(0, 0.35, 600, 2000, 0.045);
      tone(1046.5, 0.1, 0.25, { gain: 0.045, slideTo: 1318.5 });
    },
    send: () => {
      whoosh(0, 0.5, 260, 2600, 0.06);
      tone(587.33, 0.05, 0.4, { gain: 0.04, slideTo: 1174.7 });
    },
    tada: () => {
      [659.25, 830.61, 987.77, 1244.5].forEach((f, i) => tone(f, i * 0.08, 1.3, { gain: 0.06 }));
      tone(1661.2, 0.32, 1.4, { gain: 0.03 });
    },
    error: () => {
      tone(293.66, 0, 0.25, { gain: 0.1 });
      tone(246.94, 0.18, 0.35, { gain: 0.09 });
    },
    unlock: () => [523.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone(f, i * 0.08, 0.9, { gain: 0.055 })),
  },
};

let voice: Voice = VOICES.win98;
export function setSoundTheme(id: keyof typeof VOICES): void {
  voice = VOICES[id] ?? VOICES.win98;
}

export const sfx = {
  tap: () => tone(1500, 0, 0.035, { gain: 0.04 }),
  open: () => tone(880, 0, 0.07, { type: 'triangle', gain: 0.05, slideTo: 1320 }),
  copy: () => {
    tone(1320, 0, 0.06, { gain: 0.06 });
    tone(1980, 0.055, 0.09, { gain: 0.05 });
  },
  /** Payment detected. */
  ding: () => voice.ding(),
  /** Coin enters the swap machine. */
  swap: () => voice.swap(),
  /** USDT heads out to Coinbase. */
  send: () => voice.send(),
  /** Done: a little fanfare. */
  tada: () => voice.tada(),
  error: () => voice.error(),
  unlock: () => voice.unlock(),
  /** Privacy Enhanced: the Monero is in, the vault door swings shut (a heavy thud, then the latch). */
  vaultLock: () => {
    tone(110, 0, 0.42, { type: 'triangle', gain: 0.18, slideTo: 52 });
    whoosh(0, 0.2, 320, 110, 0.07);
    tone(1750, 0.22, 0.05, { type: 'square', gain: 0.03, lowpass: 3000 });
    tone(1320, 0.29, 0.06, { type: 'square', gain: 0.03, lowpass: 3000 });
  },
  /** The coins move to a fresh spot inside the vault (the churn): a quick jingle. */
  shuffle: () =>
    [0, 0.08, 0.19, 0.26, 0.36].forEach((t, i) => {
      tone(2400 + i * 260, t, 0.11, { gain: 0.035 });
      tone(4900 + i * 310, t, 0.05, { gain: 0.01 });
    }),
  /** The wait is over: the dial clicks round and the door swings open. */
  vaultOpen: () => {
    [0, 0.07, 0.14].forEach((t) => tone(1600, t, 0.03, { type: 'square', gain: 0.025, lowpass: 2600 }));
    whoosh(0.22, 0.42, 160, 900, 0.06);
    tone(196, 0.24, 0.5, { type: 'triangle', gain: 0.08, slideTo: 392 });
  },
};

/** Browsers only allow audio after a user gesture; warm the context on the first tap. */
export function primeAudio(): void {
  const prime = () => {
    audio();
    window.dispatchEvent(new Event('wc:audio'));
    window.removeEventListener('pointerdown', prime);
    window.removeEventListener('keydown', prime);
  };
  window.addEventListener('pointerdown', prime);
  window.addEventListener('keydown', prime);
}
