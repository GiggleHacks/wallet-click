import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { minutesText, shortAddr, trimAmount, usdt } from '../lib/format';
import { COST_HELP, costText, driftText } from '../lib/cost';
import { sfx } from '../lib/sound';
import { useTheme } from '../lib/themes';
import type { Order, Piece, Transfer, TransferStep } from '../types';
import { isCoinbaseId, networkOf, symbolOf } from '../lib/assets';
import { AppMark, CheckBadge, CoinIcon, CoinbaseIcon, HouseIcon, Hourglass, ModernPC, ShieldIcon, StableIcon, SwapMachine, WarnIcon, XmrIcon } from './art';
import { DelaySlider, untilText } from './DelaySlider';
import { Burst, Flyers, RefundForm, Sparkles, SpinFaces, Station } from './TransferDialog';
import { ModalLayer, ProgressBar, SpeedGraph, Window } from './Win98';

/**
 * The window for a Privacy Enhanced transfer or a payment to a permanent address. Like the copy dialog for a
 * plain swap, it plays each moment in turn (with its own sound), even when the server is a few steps ahead:
 *
 *   paying → confirming → swap1 → vault-in → locked → churn → waiting → release → swap2 → sending → done
 *
 * (a direct payment to a permanent address skips the vault: paying → confirming → [held] → swap1 → sending → done).
 * A split payment goes round again for each piece: waiting/held → swap → sending → waiting/held → …
 */

export type Phase = 'paying' | 'confirming' | 'held' | 'swap1' | 'vault-in' | 'locked' | 'churn' | 'waiting' | 'release' | 'swap2' | 'sending' | 'done' | 'attention' | 'refunded';
const PRIVACY_FLOW: Phase[] = ['paying', 'confirming', 'swap1', 'vault-in', 'locked', 'churn', 'waiting', 'release', 'swap2', 'sending', 'done'];
const DIRECT_FLOW: Phase[] = ['paying', 'confirming', 'swap1', 'sending', 'done'];
/** A direct payment with a wait or pieces: it's held at our address first. */
const HELD_FLOW: Phase[] = ['paying', 'confirming', 'held', 'swap1', 'sending', 'done'];

/** Whether the money waits in Monero (the five-station journey). */
export const viaMonero = (t: Transfer) => t.monero ?? t.privacy;
const flowOf = (t: Transfer) => (viaMonero(t) ? PRIVACY_FLOW : t.delayHours || t.heldAt || (t.pieces ?? 1) > 1 ? HELD_FLOW : DIRECT_FLOW);
/** What the countdown counts down to: the end of the wait, or the next piece. */
export const wakeAt = (t: Transfer) => (t.state === 'pieces' ? (t.nextPieceAt ?? null) : t.releaseAt);

/** How long each moment stays on screen at least, so its animation gets its turn. */
const DWELL: Partial<Record<Phase, number>> = { confirming: 1800, held: 1200, swap1: 2200, 'vault-in': 1500, locked: 1900, churn: 2400, waiting: 1200, release: 1500, swap2: 2200, sending: 1800 };

const SOUND: Partial<Record<Phase, () => void>> = {
  confirming: () => sfx.ding(),
  swap1: () => sfx.swap(),
  'vault-in': () => sfx.send(),
  locked: () => sfx.vaultLock(),
  churn: () => sfx.shuffle(),
  release: () => sfx.vaultOpen(),
  swap2: () => sfx.swap(),
  sending: () => sfx.send(),
  done: () => sfx.tada(),
  attention: () => sfx.error(),
};

/** Where the transfer really is. */
export function phaseOf(t: Transfer, now: number): Phase {
  if (t.attention) return 'attention';
  if (t.state === 'refunded') return 'refunded';
  if (t.state === 'done') return 'done';
  if (t.state === 'collect') return t.received ? 'confirming' : 'paying';
  if (t.state === 'hold') return 'held';
  if (t.state === 'split') return 'confirming';
  if (t.state === 'pieces') {
    const sending = t.pieceList?.some((p) => p.stage === 'sending');
    if (viaMonero(t)) return sending ? 'swap2' : 'waiting';
    return sending ? 'swap1' : 'held';
  }
  if (t.state === 'open1' || t.state === 'send1') return 'confirming';
  if (t.state === 'swap1') {
    const s = t.leg1?.stage;
    if (!t.routeId && (!s || s === 'waiting' || s === 'expired')) return 'paying';
    if (s === 'received') return 'confirming';
    if (s === 'sending' || s === 'done') return viaMonero(t) ? 'vault-in' : s === 'done' ? 'done' : 'sending';
    if (s === 'refunded') return 'refunded';
    return 'swap1';
  }
  if (t.state === 'xmr-in') return t.xmrArrived ? 'locked' : 'vault-in';
  if (t.state === 'churn') return 'churn';
  if (t.state === 'wait') return t.releaseAt !== null && t.releaseAt > now ? 'waiting' : 'release';
  if (t.state === 'open2' || t.state === 'send2') return 'release';
  return t.leg2?.stage === 'sending' ? 'sending' : t.leg2?.stage === 'done' ? 'done' : 'swap2';
}

/** Steps through the flow one moment at a time. */
function useStepped(phase: Phase, flow: Phase[], startFrom?: Phase): Phase {
  const [shown, setShown] = useState<Phase>(startFrom ?? phase);
  const since = useRef(Date.now());
  useEffect(() => {
    if (shown === phase) return;
    const a = flow.indexOf(shown);
    const b = flow.indexOf(phase);
    if (a < 0 || b < 0 || b < a) {
      setShown(phase);
      since.current = Date.now();
      return;
    }
    const wait = a === 0 ? 250 : Math.max(0, (DWELL[shown] ?? 1200) - (Date.now() - since.current));
    const timer = setTimeout(() => {
      setShown(flow[a + 1]);
      since.current = Date.now();
    }, wait);
    return () => clearTimeout(timer);
  }, [phase, shown, flow]);
  return shown;
}

/** "21h 10m" for the vault's label. */
const shortUntil = (ms: number) => {
  const min = Math.max(0, Math.ceil(ms / 60_000));
  const h = Math.floor(min / 60);
  return h ? `${h}h ${String(min % 60).padStart(2, '0')}m` : `${min} min`;
};

function LockBadge() {
  return (
    <svg viewBox="0 0 12 14" width="12" height="14" aria-hidden="true">
      <path d="M3 6V4.2a3 3 0 0 1 6 0V6" fill="none" stroke="#4c4c4c" strokeWidth="1.6" />
      <rect x="1" y="6" width="10" height="7.5" rx="1.2" fill="#ffc83a" stroke="#805300" strokeWidth=".8" />
      <circle cx="6" cy="9.4" r="1.1" fill="#805300" />
    </svg>
  );
}

/** The Monero vault: its door swings shut and open, the dial turns, a ring counts the unlock and the wait. */
function Vault({ door, turning, coins, churning, ring }: { door: 'open' | 'closed'; turning: boolean; coins: boolean; churning: boolean; ring: { fraction: number; kind: 'unlock' | 'wait' } | null }) {
  const C = 2 * Math.PI * 29;
  return (
    <span className={`vault3d is-${door} ${turning ? 'is-turning' : ''} ${coins ? 'has-coins' : ''}`}>
      {ring && (
        <svg className={`vault-ring is-${ring.kind}`} viewBox="0 0 64 64" width="64" height="64">
          <circle className="vault-ring-track" cx="32" cy="32" r="29" />
          <circle className="vault-ring-fill" cx="32" cy="32" r="29" strokeDasharray={C} strokeDashoffset={C * (1 - Math.min(1, Math.max(0, ring.fraction)))} />
        </svg>
      )}
      <svg className="vault-body" viewBox="0 0 48 44" width="48" height="44">
        <rect x="1" y="1" width="46" height="40" rx="3" fill="#5b5b5b" />
        <rect x="2.5" y="2.5" width="43" height="37" rx="2" fill="#8a8a8a" />
        <rect x="6" y="6" width="36" height="30" rx="1.5" fill="#262626" />
        <g className="vault-inside">
          <circle cx="17" cy="29" r="5" fill="#e65c00" />
          <circle cx="29" cy="29.5" r="5" fill="#ff6600" />
          <circle cx="23" cy="24" r="5" fill="#ff7a1f" stroke="#b34700" strokeWidth=".6" />
        </g>
        <rect x="8" y="41" width="6" height="3" fill="#3a3a3a" />
        <rect x="34" y="41" width="6" height="3" fill="#3a3a3a" />
      </svg>
      <span className="vault-door">
        <svg viewBox="0 0 36 30" width="36" height="30">
          <rect x=".5" y=".5" width="35" height="29" rx="1.5" fill="#a3a3a3" stroke="#4c4c4c" />
          <g className="vault-dial">
            <circle cx="17" cy="15" r="8" fill="#ff6600" stroke="#4c4c4c" strokeWidth="1.2" />
            <path d="M17 8.5v13M10.5 15h13M12.4 10.4l9.2 9.2M21.6 10.4l-9.2 9.2" stroke="#fff" strokeWidth="1.1" />
            <circle cx="17" cy="15" r="2.4" fill="#4c4c4c" />
          </g>
          <rect x="30" y="10" width="3" height="10" rx="1" fill="#4c4c4c" />
        </svg>
      </span>
      {churning && (
        <span className="churn-hop">
          <i>
            <XmrIcon size={14} />
          </i>
          <i>
            <XmrIcon size={14} />
          </i>
        </span>
      )}
      {door === 'closed' && (
        <span className="vault-lock">
          <LockBadge />
        </span>
      )}
    </span>
  );
}

function JourneyStrip({ t, shown, now }: { t: Transfer; shown: Phase; now: number }) {
  const theme = useTheme();
  const five = viaMonero(t);
  const flow = flowOf(t);
  const until = wakeAt(t);
  const X = five ? { coin: 9, swap1: 29.5, vault: 50, swap2: 70.5, dest: 91 } : { coin: 13, swap1: 50, vault: 50, swap2: 50, dest: 87 };
  const at = flow.indexOf(shown);
  const after = (p: Phase) => at >= 0 && at > flow.indexOf(p);

  // One-shot effects on the moments that matter.
  const prev = useRef(shown);
  const [fx, setFx] = useState<{ key: number; phase: Phase } | null>(null);
  useEffect(() => {
    if (prev.current === shown) return;
    prev.current = shown;
    setFx({ key: Date.now(), phase: shown });
  }, [shown]);
  useEffect(() => {
    if (!fx) return;
    const timer = setTimeout(() => setFx(null), 900);
    return () => clearTimeout(timer);
  }, [fx]);

  const size = five ? 48 : 60;
  const machine = (spinning: boolean) => (theme.shell === 'classic' ? <SwapMachine size={size} spinning={spinning} /> : <ModernPC size={size} spinning={spinning} variant={theme.shell} />);
  const coinbase = isCoinbaseId(t.destinationId);
  const holding = shown === 'locked' || shown === 'churn' || shown === 'waiting';
  const coinLabel = shown === 'held' && until ? shortUntil(until - now) : t.coinName;

  // The ring around the vault: filling while it unlocks, draining while it waits.
  let ring: { fraction: number; kind: 'unlock' | 'wait' } | null = null;
  if (shown === 'locked') ring = { fraction: Math.min(t.xmrConfirmations ?? 0, 10) / 10, kind: 'unlock' };
  if (shown === 'waiting' && until && t.unlockedAt) ring = { fraction: (until - now) / Math.max(1, until - t.unlockedAt), kind: 'wait' };
  const vaultLabel =
    shown === 'locked'
      ? 'Unlocking'
      : shown === 'churn'
        ? 'Shuffling'
        : shown === 'waiting' && until
          ? shortUntil(until - now)
          : shown === 'release'
            ? 'Opening'
            : 'Vault';

  const fly = (from: number, to: number, icon: React.ReactNode) => (
    <Flyers from={from + 5} to={to - 6} count={3}>
      {icon}
    </Flyers>
  );

  return (
    <div className={`strip journey-strip ${five ? 'is-five' : ''} phase-${shown}`} aria-hidden="true">
      <div className="track" style={{ left: `${X.coin}%`, right: `${100 - X.dest}%` }} />
      <Station x={X.coin} label={coinLabel} dim={after(flow.includes('held') ? 'held' : 'confirming')} pulse={shown === 'confirming' || shown === 'held'}>
        <span className="stack-icon">
          <CoinIcon coin={t.coin} size={five ? 40 : 44} />
          {shown === 'held' && (
            <span className="stack-badge">
              <Hourglass size={18} />
            </span>
          )}
          {t.routeId && shown !== 'held' && !t.oneTime && (
            <span className="stack-badge">
              <HouseIcon size={18} />
            </span>
          )}
        </span>
      </Station>

      <Station x={X.swap1} label="Swap" working={shown === 'swap1'} dim={after('swap1')}>
        {shown === 'swap1' && <span className="swap-glow" />}
        {shown === 'swap1' && <Sparkles side="back" />}
        <span className="station-machine">{machine(shown === 'swap1')}</span>
        {shown === 'swap1' && <SpinFaces front={<CoinIcon coin={t.coin} size={30} />} back={five ? <XmrIcon size={30} /> : <StableIcon ccy={t.payoutCcy} size={30} />} />}
        {shown === 'swap1' && <Sparkles side="front" />}
        {fx?.phase === 'swap1' && <span key={fx.key} className="swap-flash" />}
        {fx && fx.phase === (five ? 'vault-in' : 'sending') && <Burst key={fx.key} color={five ? '#ff6600' : '#26a17b'} />}
      </Station>

      {five && (
        <Station x={X.vault} label={vaultLabel} working={shown === 'churn'} pulse={shown === 'locked' || shown === 'release'} dim={after('release')}>
          <Vault
            door={holding ? 'closed' : 'open'}
            turning={shown === 'locked' || shown === 'churn' || shown === 'release'}
            coins={holding || shown === 'vault-in' || shown === 'release'}
            churning={shown === 'churn'}
            ring={ring}
          />
          {fx?.phase === 'release' && <Burst key={fx.key} color="#ff6600" />}
        </Station>
      )}

      {five && (
        <Station x={X.swap2} label="Swap" working={shown === 'swap2'} dim={after('swap2')}>
          {shown === 'swap2' && <span className="swap-glow" />}
          {shown === 'swap2' && <Sparkles side="back" />}
          <span className="station-machine">{machine(shown === 'swap2')}</span>
          {shown === 'swap2' && <SpinFaces front={<XmrIcon size={30} />} back={<StableIcon ccy={t.payoutCcy} size={30} />} />}
          {shown === 'swap2' && <Sparkles side="front" />}
          {fx?.phase === 'swap2' && <span key={fx.key} className="swap-flash" />}
          {fx?.phase === 'sending' && <Burst key={fx.key} color="#26a17b" />}
        </Station>
      )}

      <Station x={X.dest} label={t.destinationLabel} pulse={shown === 'done'}>
        {coinbase ? <CoinbaseIcon size={five ? 40 : 44} /> : <StableIcon ccy={t.payoutCcy} size={five ? 40 : 44} />}
        {fx?.phase === 'done' && <Burst key={fx.key} color="#0052ff" center />}
        {shown === 'done' && (
          <motion.span className="station-badge" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 16 }}>
            <CheckBadge />
          </motion.span>
        )}
      </Station>

      {(shown === 'confirming' || (shown === 'swap1' && t.state === 'pieces')) && fly(X.coin, X.swap1, <CoinIcon coin={t.coin} size={22} />)}
      {shown === 'vault-in' && fly(X.swap1, X.vault, <XmrIcon size={22} />)}
      {shown === 'release' && fly(X.vault, X.swap2, <XmrIcon size={22} />)}
      {shown === 'sending' && fly(five ? X.swap2 : X.swap1, X.dest, <StableIcon ccy={t.payoutCcy} size={22} />)}
    </div>
  );
}

function progressOf(t: Transfer, shown: Phase, now: number, elapsed: number): number {
  const ease = (from: number, to: number, ms: number) => from + (to - from) * (1 - Math.exp(-elapsed / ms));
  const conf = (from: number, to: number) => {
    // A permanent address: confirming at the address, then forwarding to FixedFloat.
    if (t.routeId) return t.state === 'collect' ? from + (to - from) * 0.3 : from + (to - from) * 0.8;
    const req = t.leg1?.requiredConfirmations || 1;
    return from + (to - from) * Math.min(1, (t.leg1?.confirmations ?? 0) / req);
  };
  // A split payment: the share of its pieces that have landed (once the first one has gone).
  const list = t.pieceList ?? [];
  const sent = list.filter((p) => p.stage === 'done').length;
  if (t.state === 'pieces' && list.length && (!viaMonero(t) || list.some((p) => p.stage !== 'waiting'))) {
    const share = (sent + (list.some((p) => p.stage === 'sending') ? 0.5 : 0)) / list.length;
    return viaMonero(t) ? 82 + 16 * share : 48 + 48 * share;
  }
  if (!viaMonero(t)) {
    const held = t.releaseAt && t.heldAt ? 40 + 8 * (1 - Math.max(0, t.releaseAt - now) / Math.max(1, t.releaseAt - t.heldAt)) : 44;
    return { paying: 0, confirming: conf(6, 40), held, swap1: ease(48, 70, 60_000), sending: ease(74, 96, 45_000), done: 100 }[shown as 'paying'] ?? 0;
  }
  switch (shown) {
    case 'paying':
      return 0;
    case 'confirming':
      return conf(4, 14);
    case 'swap1':
      return ease(16, 28, 60_000);
    case 'vault-in':
      return 30;
    case 'locked':
      return 32 + 8 * (Math.min(t.xmrConfirmations ?? 0, 10) / 10);
    case 'churn':
      return 42;
    case 'waiting': {
      const until = wakeAt(t);
      return until && t.unlockedAt ? 45 + 35 * (1 - Math.max(0, until - now) / Math.max(1, until - t.unlockedAt)) : 45;
    }
    case 'release':
      return 82;
    case 'swap2':
      return ease(84, 92, 60_000);
    case 'sending':
      return ease(94, 98, 45_000);
    case 'done':
      return 100;
    default:
      return 0;
  }
}

/** A tiny fast-forward sign for the time-lapse (an SVG: emoji render in another font, or in colour on phones). */
const FastForward = () => (
  <svg viewBox="0 0 16 12" width="16" height="12" aria-hidden="true">
    <path d="M1 1l6.5 5L1 11zM8 1l6.5 5L8 11z" fill="currentColor" />
  </svg>
);

function Steps({ steps, releaseAt }: { steps: TransferStep[]; releaseAt: number | null }) {
  return (
    <ol className="steps98">
      {steps
        .map((s) => (s.key === 'wait' && !s.detail && releaseAt ? { ...s, detail: `until ${new Date(releaseAt).toLocaleString()}` } : s))
        .map((s) => (
          <li key={s.key} className={`step is-${s.status}`}>
            <span className="step-mark" aria-hidden="true" />
            <span className="step-text">
              <span className="step-label">{s.label}</span>
              {s.detail && <span className="step-detail"> · {s.detail}</span>}
              {s.link && (
                <>
                  {' '}
                  <a href={s.link} target="_blank" rel="noreferrer">
                    view
                  </a>
                </>
              )}
            </span>
          </li>
        ))}
    </ol>
  );
}

/** A split payment's pieces: what each one holds, and where it is. */
function PieceList({ pieces, now, sym }: { pieces: Piece[]; now: number; sym: string }) {
  const state = (p: Piece) => {
    if (p.stage === 'done') return `Sent: ${p.usdt ? `${usdt(p.usdt)} ${sym}` : sym}`;
    if (p.stage === 'refunded') return 'Sent back';
    if (p.stage === 'attention') return `Needs you: ${p.attention ?? ''}`;
    if (p.stage === 'sending') return 'Swapping…';
    if (p.releaseAt && p.releaseAt > now) return `Goes in ${untilText(p.releaseAt - now)}`;
    if (p.releaseAt) return 'Its turn now';
    return p.n > 1 ? `A random 5 min–2 h after piece ${p.n - 1}` : 'Waiting';
  };
  return (
    <ul className="pieces-list" aria-label="Pieces">
      {pieces.map((p) => (
        <li key={p.id} className={`is-${p.stage}`}>
          <span className="piece-n">
            {p.n} of {p.of}
          </span>
          <span className="piece-amt">{p.amount ? `${trimAmount(p.amount)} ${p.coin}` : '…'}</span>
          <span className="piece-state">
            {state(p)}
            {p.payoutTxUrl && (
              <>
                {' '}
                <a href={p.payoutTxUrl} target="_blank" rel="noreferrer">
                  view
                </a>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The "How it works" run fast-forwards the wait: virtual time runs `speed` times faster from `realStart`. */
export interface TimeLapse {
  realStart: number;
  virtualStart: number;
  speed: number;
}

interface Props {
  transfer: Transfer;
  delays: number[];
  /** Opened because money just arrived: play the whole flow from the start. */
  autoplay?: boolean;
  /** "How it works": no buttons that talk to the server. */
  demo?: boolean;
  timeLapse?: TimeLapse | null;
  onClose(): void;
  onUpdate(t: Transfer): void;
  /** Shows a first-swap order's own window (its address, or its refund form). */
  onOpenOrder?(o: Order): void;
}

export function JourneyDialog({ transfer: t, delays, autoplay, demo, timeLapse, onClose, onUpdate, onOpenOrder }: Props) {
  const clock = () => (timeLapse ? timeLapse.virtualStart + (Date.now() - timeLapse.realStart) * timeLapse.speed : Date.now());
  const [now, setNow] = useState(clock);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editDelay, setEditDelay] = useState(false);
  const [delay, setDelay] = useState(t.delayHours && delays.includes(t.delayHours) ? t.delayHours : delays[0]);
  const flow = flowOf(t);
  const shown = useStepped(phaseOf(t, now), flow, autoplay ? 'paying' : undefined);
  const enteredAt = useRef(Date.now());
  const prevShown = useRef(shown);
  const theme = useTheme();
  const modern = theme.shell !== 'classic';

  useEffect(() => {
    const iv = setInterval(() => setNow(clock()), timeLapse ? 100 : 500);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeLapse]);
  useEffect(() => {
    if (prevShown.current === shown) return;
    prevShown.current = shown;
    enteredAt.current = Date.now();
    SOUND[shown]?.();
  }, [shown]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement | null)?.closest?.('input, select') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function act(fn: () => Promise<Transfer>) {
    setBusy(true);
    setError('');
    try {
      onUpdate(await fn());
      sfx.tap();
      setEditDelay(false);
    } catch (e) {
      sfx.error();
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  const until = wakeAt(t);
  const left = until !== null ? until - now : null;
  const monero = viaMonero(t);
  const sym = symbolOf(t.payoutCcy);
  const split = (t.pieces ?? 1) > 1;
  const pieceList = t.pieceList ?? [];
  const sentPieces = pieceList.filter((p) => p.stage === 'done').length;
  const nextPiece = pieceList.find((p) => p.stage === 'waiting');
  const finished = shown === 'done' || shown === 'refunded';
  const percent = progressOf(t, shown, now, Date.now() - enteredAt.current);
  const showProgress = shown !== 'attention' && shown !== 'refunded';
  const paid = t.received ? `${trimAmount(t.received)} ${t.coin}` : t.coinName;
  const xmr = t.xmr ? `${trimAmount(t.xmr)} XMR` : 'the Monero';
  const out = t.usdt ?? t.leg2?.usdt ?? (monero ? null : t.leg1?.usdt);
  const leg1Needs = t.leg1?.stage === 'attention' && t.leg1.emergency?.choice === 'NONE' && !demo;
  const name = t.privacy ? 'Privacy Enhanced' : t.oneTime || !t.routeLabel ? `${t.coinName} payment` : `Payment to "${t.routeLabel}"`;
  const title = shown === 'done' ? 'Transfer complete' : modern && showProgress && shown !== 'paying' ? `${Math.round(percent)}% complete` : demo ? `${name} (demo)` : name;

  let eta: string | null = null;
  if ((shown === 'waiting' || shown === 'held') && left !== null && left > 0) eta = untilText(left);
  else if (shown === 'locked') eta = minutesText(Math.max(1, (10 - Math.min(t.xmrConfirmations ?? 0, 10)) * 2));
  else if (shown === 'confirming' || shown === 'swap1' || shown === 'swap2') eta = minutesText(shown === 'confirming' ? 10 : 3);
  else if (shown === 'sending' || shown === 'release' || shown === 'vault-in') eta = 'about a minute';

  const lines: Partial<Record<Phase, [React.ReactNode, React.ReactNode]>> = {
    paying: [
      <>
        <Hourglass size={16} /> Waiting for your {t.coinName} payment…
      </>,
      t.privacy ? `It goes through Monero first, then to ${sym}.` : null,
    ],
    confirming: [
      <>
        {t.routeLabel ? `Payment at "${t.routeLabel}"` : 'Payment received'}: <b>{paid}</b>
      </>,
      t.state === 'split'
        ? `Splitting it into ${t.pieces} pieces at fresh addresses of your own wallet…`
        : t.state === 'open1' || t.state === 'send1'
        ? 'Confirmed: forwarding it to a fresh FixedFloat order…'
        : t.leg1 && t.leg1.requiredConfirmations && !t.routeId
          ? `Waiting for network confirmations (${Math.min(t.leg1.confirmations, t.leg1.requiredConfirmations)} of ${t.leg1.requiredConfirmations})…`
          : 'Waiting for network confirmations…',
    ],
    held: [
      <>
        <Hourglass size={16} />{' '}
        {t.state === 'pieces' ? (
          <>
            {sentPieces} of {pieceList.length} pieces sent{left !== null && left > 0 ? <>; the next one goes in {untilText(left)}</> : nextPiece ? <>; the next one waits a random 5 min–2 h</> : null}
          </>
        ) : (
          <>
            Holding <b>{paid}</b>
            {left !== null && left > 0 ? <> for another {untilText(left)}</> : null}
          </>
        )}
      </>,
      t.state === 'pieces' ? 'Each piece is forwarded to FixedFloat on its own, in a random, unequal amount.' : until ? `Goes on at ${new Date(until).toLocaleString()}${split ? `, in ${t.pieces} pieces` : ''}.` : null,
    ],
    swap1: [
      <>
        Swapping <b>{t.state === 'pieces' ? `piece ${pieceList.find((p) => p.stage === 'sending')?.n ?? ''} of ${pieceList.length}` : paid}</b> to {t.privacy ? 'Monero' : sym}…
      </>,
      t.privacy ? 'FixedFloat pays the Monero into your own wallet.' : 'FixedFloat is exchanging it at the market rate.',
    ],
    'vault-in': [<>Monero on its way into your vault…</>, 'A fresh address in your own Monero wallet.'],
    locked: [
      <>
        <b>{xmr}</b> is in the vault
      </>,
      `Unlocking: ${Math.min(t.xmrConfirmations ?? 0, 10)} of 10 confirmations.`,
    ],
    churn: [
      <>{split ? `Splitting it into ${t.pieces} pieces within your wallet…` : 'Moving it to a fresh spot in your wallet…'}</>,
      split ? 'One fresh address per piece; each piece moves once more on its own.' : "So FixedFloat's own coins never go straight back to it.",
    ],
    waiting: [
      <>
        <Hourglass size={16} />{' '}
        {t.state === 'pieces' && sentPieces ? (
          <>
            {sentPieces} of {pieceList.length} pieces sent{left !== null && left > 0 ? <>; the next one goes in {untilText(left)}</> : <>; the next one waits a random 5 min–2 h</>}
          </>
        ) : (
          <>
            Holding <b>{xmr}</b> for another {left !== null ? untilText(Math.max(0, left)) : '…'}
          </>
        )}
      </>,
      until ? `${t.state === 'pieces' && sentPieces ? 'Next piece swaps' : 'Swaps'} to ${sym} at ${new Date(until).toLocaleString()}${split && !sentPieces ? `, in ${t.pieces} pieces` : ''}.` : null,
    ],
    release: [<>Wait over: opening the vault…</>, `${xmr} heads to the swap.`],
    swap2: [
      <>
        Swapping <b>{t.state === 'pieces' ? `piece ${pieceList.find((p) => p.stage === 'sending')?.n ?? ''} of ${pieceList.length}` : xmr}</b> to {sym}…
      </>,
      'FixedFloat is exchanging it at the market rate.',
    ],
    sending: [
      <>
        Sending <b>{out ? `≈ ${usdt(out)} ${sym}` : sym}</b> to {t.destinationLabel}…
      </>,
      `To ${shortAddr(t.destinationAddress)} on ${networkOf(t.payoutCcy)}.`,
    ],
    done: [
      <>
        Done! <b>{out ? `${usdt(out)} ${sym}` : sym}</b> sent to {t.destinationLabel}.
      </>,
      t.payoutTxUrl ? (
        <a href={t.payoutTxUrl} target="_blank" rel="noreferrer">
          View payout
        </a>
      ) : null,
    ],
    refunded: [<>FixedFloat sent the payment back.</>, null],
  };
  const [main, sub] = lines[shown] ?? [null, null];

  return (
    <ModalLayer>
      <Window title={title} icon={monero ? <ShieldIcon size={16} /> : <AppMark />} onClose={onClose} className="win-dialog win-journey" role="dialog">
        {modern && (
          <p className="modern-head">
            {monero ? (
              <>
                <b>{t.coinName}</b> → Monero → <b>{t.destinationLabel}</b>
              </>
            ) : (
              <>
                <b>{t.coinName}</b> to <b>{t.destinationLabel}</b>
              </>
            )}
          </p>
        )}
        {demo && (
          <div className="warn-box demo-box">
            <WarnIcon size={20} /> Demo. No real money moves{timeLapse ? '; the wait runs as a time-lapse' : ''}.
          </div>
        )}
        <JourneyStrip t={t} shown={shown} now={now} />
        <div className="lines">
          {main && <p className="line-main">{main}</p>}
          {shown === 'done' && t.cost && (
            <p className="line-cost" title={COST_HELP}>
              {costText(t.cost)}
              {driftText(t.cost) && <span className="line-drift">{driftText(t.cost)}</span>}
            </p>
          )}
          {sub && <p className="line-sub">{sub}</p>}
          {(shown === 'waiting' || shown === 'held') && timeLapse && (
            <p className="line-sub timelapse">
              <FastForward /> Time-lapse: a day in a few seconds.
            </p>
          )}
          {!finished && t.waitingFor && shown !== 'waiting' && shown !== 'held' && <p className="line-sub">Waiting for {t.waitingFor}…</p>}
          {t.error && !t.attention && <p className="line-sub">Retrying: {t.error}</p>}
        </div>

        {showProgress && (
          <>
            {modern && <p className="modern-pct">{shown === 'done' ? 'Complete' : `${Math.round(percent)}% complete`}</p>}
            {modern && <SpeedGraph percent={percent} seed={t.id} />}
            <ProgressBar percent={percent} />
            <p className="eta">{finished ? 'Finished.' : eta ? `${modern ? 'Time remaining' : 'Estimated time left'}: ${eta}` : ' '}</p>
          </>
        )}

        <Steps steps={t.steps} releaseAt={t.releaseAt} />
        {pieceList.length > 0 && <PieceList pieces={pieceList} now={now} sym={sym} />}

        {t.attention && (
          <div className="attention">
            <div className="attention-head">
              <WarnIcon size={28} />
              <p>{t.attention}</p>
            </div>
          </div>
        )}
        {leg1Needs && t.leg1 && (
          <div className="attention">
            <p className="line-sub">FixedFloat needs a decision on order {t.leg1.id}.</p>
            {t.leg1.autoRefundError && <p className="error-text">{t.leg1.autoRefundError}</p>}
            <RefundForm order={t.leg1} onUpdate={() => undefined} />
          </div>
        )}

        {editDelay && !demo && (
          <fieldset className="group98">
            <legend>
              {monero ? 'Wait in Monero' : 'Wait before it goes on'}: <b>{delay ? `${delay} hours` : 'none'}</b> (counted from when it {monero ? 'unlocked' : 'was confirmed'})
            </legend>
            <DelaySlider value={delay} delays={delays} onChange={setDelay} />
            <div className="btn-row">
              <button type="button" className="btn98 is-default" disabled={busy} onClick={() => void act(() => api.changeDelay(t.id, delay))}>
                Save
              </button>
              <button type="button" className="btn98" onClick={() => setEditDelay(false)}>
                Cancel
              </button>
            </div>
          </fieldset>
        )}
        {error && <p className="error-text">{error}</p>}

        <div className="btn-row">
          {t.leg1 && !t.routeId && shown === 'paying' && onOpenOrder && (
            <button type="button" className="btn98" onClick={() => onOpenOrder(t.leg1!)}>
              Show address
            </button>
          )}
          {!demo && t.canChangeDelay && !editDelay && (
            <button type="button" className="btn98" onClick={() => setEditDelay(true)}>
              Change wait…
            </button>
          )}
          {!demo && t.canRelease && (
            <button type="button" className="btn98" disabled={busy} onClick={() => void act(() => api.release(t.id))}>
              Release now
            </button>
          )}
          {!demo && t.canRetry && (
            <button type="button" className="btn98" disabled={busy} onClick={() => void act(() => api.retry(t.id))}>
              Retry
            </button>
          )}
          <button type="button" className="btn98 is-default" onClick={onClose} autoFocus>
            {finished ? 'OK' : 'Hide'}
          </button>
        </div>
      </Window>
    </ModalLayer>
  );
}

/** One word for the transfer list. */
export function transferStatus(t: Transfer, now = Date.now()): string {
  const until = wakeAt(t);
  if (t.state === 'pieces' && t.pieceList?.length) {
    const sent = t.pieceList.filter((p) => p.stage === 'done').length;
    if (t.stage === 'sending' || !until || until <= now) return `${sent} of ${t.pieceList.length} sent`;
    return sent ? `${sent} of ${t.pieceList.length} sent · next ${untilText(until - now)}` : `Waiting ${untilText(until - now)}`;
  }
  if (t.stage === 'holding') {
    if (until && until > now && (t.state === 'wait' || t.state === 'hold')) return `Waiting ${untilText(until - now)}`;
    return viaMonero(t) ? 'In Monero' : t.state === 'split' ? 'Splitting' : 'Holding';
  }
  return { waiting: 'Waiting', received: t.routeId ? 'Received' : 'Confirming', swapping: 'Swapping', sending: 'Sending', done: 'Done', refunded: 'Sent back', expired: 'Expired', attention: 'Needs you' }[t.stage];
}
