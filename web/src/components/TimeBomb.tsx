import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useReducer, useRef } from 'react';
import { trimAmount, usdt } from '../lib/format';
import { sfx } from '../lib/sound';
import type { Transfer } from '../types';
import { BombIcon, BoomBurst, UsdtIcon } from './art';

/**
 * A Privacy Enhanced transfer with a long wait shows up on the desktop as a cartoon time bomb: a red LED
 * countdown over a black bomb, with the money's dollar value underneath. The fuse lights when the wait starts;
 * when it runs out the bomb goes BOOM and turns into a USDT coin until the money lands.
 */

const H = 3_600_000;
/** Waits this long or longer get a bomb. */
export const BOMB_HOURS = 4;
const BOOM_MS = 2600;

const LIVE = ['received', 'swapping', 'holding', 'sending', 'attention'];
const PAST_RELEASE = ['open2', 'send2', 'swap2', 'done'];

/** A transfer to show as a bomb, with its clock (the "How it works" run fast-forwards time). */
export interface Fused {
  transfer: Transfer;
  now(): number;
  fast?: boolean;
}

export type BombPhase = 'armed' | 'ticking' | 'swapping' | 'attention';

export interface Bomb {
  transfer: Transfer;
  phase: BombPhase;
  /** Time left on the timer, ms. */
  left: number;
  /** It just went off (shows the burst for a moment). */
  boom: boolean;
}

export function isBomb(t: Transfer): boolean {
  if (!t.privacy || !LIVE.includes(t.stage)) return false;
  // Released early during the wait: it still goes off.
  return (t.delayHours ?? 0) >= BOMB_HOURS || (t.delayHours === 0 && t.releaseAt !== null);
}

function phaseOf(t: Transfer, now: number): BombPhase {
  if (t.stage === 'attention') return 'attention';
  if (PAST_RELEASE.includes(t.state)) return 'swapping';
  if (t.state === 'wait' && t.releaseAt !== null) return t.releaseAt > now ? 'ticking' : 'swapping';
  return 'armed';
}

/** 86 399 000 → "23:59:59" (hours keep going past 24: "41:59:59"). */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

export const usdText = (t: Transfer) =>
  t.usdValue ? `≈ $${usdt(String(t.usdValue))}` : t.xmr ? `${trimAmount(t.xmr)} XMR` : t.received ? `${trimAmount(t.received)} ${t.coin}` : '';

/**
 * Works out every bomb's timer, and makes the noises: a tick in the last ten seconds, and BOOM when one runs
 * out while you watch. `testDelayMin` = the server's short test wait, shown before the real wait starts.
 */
export function useBombs(fused: Fused[], testDelayMin: number | null = null): Bomb[] {
  const [, render] = useReducer((n: number) => n + 1, 0);
  const fast = fused.some((f) => f.fast);
  useEffect(() => {
    if (!fused.length) return;
    const iv = setInterval(render, fast ? 100 : 1000);
    return () => clearInterval(iv);
  }, [fused.length, fast]);

  const prev = useRef(new Map<string, BombPhase>());
  const boomUntil = useRef(new Map<string, number>());
  const lastTick = useRef(new Map<string, number>());

  const bombs = fused.map(({ transfer: t, now: clock }): Bomb => {
    const now = clock();
    const phase = phaseOf(t, now);
    const full = testDelayMin !== null ? testDelayMin * 60_000 : (t.delayHours ?? 0) * H;
    const left = phase === 'ticking' ? t.releaseAt! - now : phase === 'swapping' ? 0 : full;
    return { transfer: t, phase, left, boom: (boomUntil.current.get(t.id) ?? 0) > Date.now() };
  });

  useEffect(() => {
    let boomed = false;
    for (const b of bombs) {
      const id = b.transfer.id;
      const was = prev.current.get(id);
      prev.current.set(id, b.phase);
      if (was === 'ticking' && b.phase === 'swapping') {
        boomUntil.current.set(id, Date.now() + BOOM_MS);
        boomed = true;
      }
      const secs = Math.ceil(b.left / 1000);
      if (b.phase === 'ticking' && !fast && secs <= 10 && lastTick.current.get(id) !== secs) {
        lastTick.current.set(id, secs);
        sfx.tick();
      }
    }
    if (boomed) {
      sfx.boom();
      render();
      setTimeout(render, BOOM_MS + 50);
    }
  });

  return bombs;
}

const label = (b: Bomb) => {
  const t = b.transfer;
  const what = `Privacy transfer${t.received ? ` of ${trimAmount(t.received)} ${t.coin}` : ''} to ${t.destinationLabel}`;
  if (b.phase === 'attention') return `${what}: needs you`;
  if (b.phase === 'swapping') return `${what}: the wait is over, swapping to USDT`;
  if (b.phase === 'armed') return `${what}: a ${countdown(b.left)} wait starts once the Monero unlocks`;
  return `${what}: ${countdown(b.left)} left`;
};

function Art({ b, size }: { b: Bomb; size: number }) {
  if (b.boom) return <BoomBurst size={size} />;
  if (b.phase === 'swapping') return <UsdtIcon size={Math.round(size * 0.8)} />;
  return <BombIcon size={size} lit={b.phase === 'ticking'} />;
}

/** The bombs on the desktop, under the other icons. */
export function DesktopBombs({ bombs, onOpen }: { bombs: Bomb[]; onOpen(t: Transfer): void }) {
  return (
    <AnimatePresence>
      {bombs.map((b) => {
        const critical = b.phase === 'ticking' && b.left <= 60_000;
        return (
          <motion.button
            key={b.transfer.id}
            type="button"
            className={`desk-icon bomb-icon is-${b.phase} ${critical ? 'is-critical' : ''} ${b.boom ? 'is-boom' : ''}`}
            onClick={() => onOpen(b.transfer)}
            title={label(b)}
            aria-label={label(b)}
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.4 }}
            transition={{ type: 'spring', stiffness: 420, damping: 22 }}
          >
            <b className="bomb-timer" aria-hidden="true">
              {countdown(b.left)}
            </b>
            <em className="bomb-art" aria-hidden="true">
              <motion.i key={b.boom ? 'boom' : b.phase} initial={b.boom ? { scale: 0.2, rotate: -20 } : false} animate={{ scale: b.boom ? 1.35 : 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 12 }}>
                <Art b={b} size={48} />
              </motion.i>
            </em>
            <span>
              {usdText(b.transfer) || 'Privacy transfer'}
              <small>{b.phase === 'attention' ? 'Needs you' : b.phase === 'swapping' ? 'Swapping…' : `→ ${b.transfer.destinationLabel}`}</small>
            </span>
          </motion.button>
        );
      })}
    </AnimatePresence>
  );
}

/** Phones hide the desktop icons, so the soonest bomb sits in the taskbar by the clock. */
export function TrayBomb({ bombs, onOpen }: { bombs: Bomb[]; onOpen(t: Transfer): void }) {
  if (!bombs.length) return null;
  const order = (b: Bomb) => (b.boom ? -1 : b.phase === 'ticking' ? b.left : Number.MAX_SAFE_INTEGER);
  const b = [...bombs].sort((x, y) => order(x) - order(y))[0];
  return (
    <button type="button" className={`tray-btn tray-bomb is-${b.phase} ${b.boom ? 'is-boom' : ''}`} onClick={() => onOpen(b.transfer)} title={label(b)} aria-label={label(b)}>
      <Art b={b} size={20} />
      <span className="tray-bomb-text">
        <b>{countdown(b.left)}</b>
        <small>{usdText(b.transfer)}</small>
      </span>
      {bombs.length > 1 && <sup>{bombs.length}</sup>}
    </button>
  );
}
