import { motion } from 'motion/react';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../api';
import { minutesText, shortAddr, trimAmount, usdt } from '../lib/format';
import { sfx } from '../lib/sound';
import { useTheme } from '../lib/themes';
import type { Order, Stage } from '../types';
import { AppMark, CheckBadge, CoinIcon, CoinbaseIcon, Hourglass, ModernPC, SwapMachine, UsdtIcon, WarnIcon } from './art';
import { PasswordField } from './PasswordField';
import { ModalLayer, ProgressBar, SpeedGraph, Window } from './Win98';

const FLOW: Stage[] = ['waiting', 'received', 'swapping', 'sending', 'done'];
const DWELL_MS = 1800;

/** Steps through the flow one stage at a time, so every animation gets its moment even when FixedFloat is quick. */
export function useDisplayedStage(stage: Stage, startFrom?: Stage): Stage {
  const [shown, setShown] = useState<Stage>(startFrom ?? stage);
  const since = useRef(Date.now());
  useEffect(() => {
    if (shown === stage) return;
    const a = FLOW.indexOf(shown);
    const b = FLOW.indexOf(stage);
    if (a < 0 || b < 0 || b < a) {
      setShown(stage);
      since.current = Date.now();
      return;
    }
    const wait = a === 0 ? 250 : Math.max(0, DWELL_MS - (Date.now() - since.current));
    const t = setTimeout(() => {
      setShown(FLOW[a + 1]);
      since.current = Date.now();
    }, wait);
    return () => clearTimeout(t);
  }, [stage, shown]);
  return shown;
}

const STAGE_SOUND: Partial<Record<Stage, () => void>> = {
  received: sfx.ding,
  swapping: sfx.swap,
  sending: sfx.send,
  done: sfx.tada,
  attention: sfx.error,
  refunded: sfx.open,
};

// Station positions across the animation strip, in percent.
const X = { coin: 13, swap: 50, coinbase: 87 };

/**
 * Coins travelling straight down a lane at a steady speed. Each runner is as wide as the lane and slides
 * by its own width (translateX 100%): a pure GPU transform, so it stays smooth at full frame rate.
 */
export function Flyers({ from, to, children, count = 4, duration = 1.6 }: { from: number; to: number; children: ReactNode; count?: number; duration?: number }) {
  return (
    <div className="lane" style={{ left: `${from}%`, width: `${to - from}%` }}>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="lane-runner" style={{ '--dur': `${duration}s`, '--delay': `${(-i * duration) / count}s` } as CSSProperties}>
          <span className="lane-coin">{children}</span>
        </span>
      ))}
    </div>
  );
}

/** The coin spinning in 3D inside the machine: the paid coin on one face, USDT on the other, a metal edge between. */
function SpinCoin({ coin }: { coin: Order['coin'] }) {
  return (
    <div className="spin3d">
      <div className="spin3d-coin">
        <span className="spin3d-face is-front">
          <CoinIcon coin={coin} size={30} />
        </span>
        <span className="spin3d-edge" />
        <span className="spin3d-face is-back">
          <UsdtIcon size={30} />
        </span>
      </div>
    </div>
  );
}

/** Sparks orbiting the machine on a tilted ring: a back half (behind the machine) and a front half. */
function Sparkles({ side, count = 6 }: { side: 'back' | 'front'; count?: number }) {
  return (
    <div className={`sparkles is-${side}`}>
      {Array.from({ length: count }, (_, i) => (
        <i key={i} style={{ animationDelay: `${(-i * 1.8) / count}s` }} />
      ))}
    </div>
  );
}

/** A one-shot burst (ring + flying dots). Give it a new key to play it again. */
export function Burst({ color, center }: { color: string; center?: boolean }) {
  return (
    <div className={`burst ${center ? 'is-center' : ''}`} style={{ '--burst': color } as CSSProperties}>
      <span className="burst-ring" />
      {Array.from({ length: 10 }, (_, i) => (
        <i key={i} style={{ '--a': `${i * 36}deg` } as CSSProperties} />
      ))}
    </div>
  );
}

export function Station({ x, label, children, pulse, dim, working }: { x: number; label: string; children: ReactNode; pulse?: boolean; dim?: boolean; working?: boolean }) {
  return (
    <div className={`station ${dim ? 'is-dim' : ''} ${working ? 'is-working' : ''}`} style={{ left: `${x}%` }}>
      <motion.div className="station-icon" animate={pulse ? { scale: [1, 1.15, 1] } : { scale: 1 }} transition={{ duration: 0.45, ease: 'easeOut' }}>
        {children}
      </motion.div>
      <span className="station-label">{label}</span>
    </div>
  );
}

type Fx = { key: number; kind: 'in' | 'out' | 'done' };

/** Where the USDT goes: "Coinbase" unless another destination was picked. */
export const payoutName = (order: Order) => order.payoutLabel ?? 'Coinbase';
const isCoinbase = (order: Order) => !order.destinationId || order.destinationId === 'coinbase';

export function TransferStrip({ order, shown }: { order: Order; shown: Stage }) {
  const theme = useTheme();
  const done = shown === 'done';
  const busy = shown === 'swapping' || shown === 'received' || shown === 'sending';
  const swapping = shown === 'swapping';
  const after = (s: Stage) => FLOW.indexOf(shown) > FLOW.indexOf(s);

  // One-shot effects on the moments that matter: the coin going in, the USDT popping out, arrival.
  const prev = useRef(shown);
  const [fx, setFx] = useState<Fx | null>(null);
  useEffect(() => {
    const from = prev.current;
    prev.current = shown;
    if (from === shown) return;
    if (shown === 'swapping') setFx({ key: Date.now(), kind: 'in' });
    else if (shown === 'sending') setFx({ key: Date.now(), kind: 'out' });
    else if (shown === 'done') setFx({ key: Date.now(), kind: 'done' });
  }, [shown]);
  useEffect(() => {
    if (!fx) return;
    const t = setTimeout(() => setFx(null), 900);
    return () => clearTimeout(t);
  }, [fx]);

  return (
    <div className={`strip stage-${shown}`} aria-hidden="true">
      <div className="track" />
      <Station x={X.coin} label={order.coinName} dim={after('received')}>
        <CoinIcon coin={order.coin} size={44} />
      </Station>
      <Station x={X.swap} label="Swap" working={swapping}>
        {swapping && <span className="swap-glow" />}
        {swapping && <Sparkles side="back" />}
        <span className="station-machine">
          {theme.shell === 'classic' ? <SwapMachine size={60} spinning={busy} /> : <ModernPC size={60} spinning={busy} variant={theme.shell} />}
        </span>
        {swapping && <SpinCoin coin={order.coin} />}
        {swapping && <Sparkles side="front" />}
        {fx?.kind === 'in' && <span key={fx.key} className="swap-flash" />}
        {fx?.kind === 'out' && <Burst key={fx.key} color="#26a17b" />}
      </Station>
      <Station x={X.coinbase} label={payoutName(order)} pulse={done}>
        {isCoinbase(order) ? <CoinbaseIcon size={44} /> : <UsdtIcon size={44} />}
        {fx?.kind === 'done' && <Burst key={fx.key} color="#0052ff" center />}
        {done && (
          <motion.span className="station-badge" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 420, damping: 16 }}>
            <CheckBadge />
          </motion.span>
        )}
      </Station>
      {shown === 'received' && (
        <Flyers from={X.coin + 5} to={X.swap - 6}>
          <CoinIcon coin={order.coin} size={24} />
        </Flyers>
      )}
      {shown === 'sending' && (
        <Flyers from={X.swap + 6} to={X.coinbase - 5}>
          <UsdtIcon size={24} />
        </Flyers>
      )}
    </div>
  );
}

function progressFor(shown: Stage, order: Order, elapsedMs: number): number {
  switch (shown) {
    case 'waiting':
      return 0;
    case 'received': {
      const req = order.requiredConfirmations || 1;
      return 6 + 38 * Math.min(1, order.confirmations / req);
    }
    case 'swapping':
      return 48 + 22 * (1 - Math.exp(-elapsedMs / 60_000));
    case 'sending':
      return 74 + 22 * (1 - Math.exp(-elapsedMs / 45_000));
    case 'done':
      return 100;
    case 'refunded':
      return order.refundTx ? 100 : 70; // requested, not sent yet
    default:
      return 0;
  }
}

function etaFor(shown: Stage, order: Order, elapsedMs: number): string | null {
  const min = elapsedMs / 60_000;
  switch (shown) {
    case 'received': {
      const left = Math.max(0, (order.requiredConfirmations ?? 1) - order.confirmations);
      return minutesText(left * order.blockMinutes + 3);
    }
    case 'swapping':
      return minutesText(Math.max(0.5, 3 - min));
    case 'sending':
      return minutesText(Math.max(0.4, 1.5 - min));
    default:
      return null;
  }
}

export function RefundForm({ order, onUpdate }: { order: Order; onUpdate(o: Order): void }) {
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setBusy(true);
    setError('');
    try {
      onUpdate(await api.refund(order.id, address.trim(), password));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refund failed');
      sfx.error();
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="refund" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <label className="lbl">
        Refund to your {order.coinName} address:
        <input className="input98 mono" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} autoComplete="off" />
      </label>
      <PasswordField value={password} onChange={setPassword} label="Password:" />
      {error && <p className="error-text">{error}</p>}
      <button type="submit" className="btn98" disabled={busy || !address.trim() || !password}>
        {busy ? 'Sending…' : 'Refund'}
      </button>
    </form>
  );
}

function Lines({ order, shown, onUpdate }: { order: Order; shown: Stage; onUpdate(o: Order): void }) {
  const paid = order.received ? `${trimAmount(order.received)} ${order.coin}` : order.coinName;
  const req = order.requiredConfirmations ?? 1;
  switch (shown) {
    case 'waiting':
      return (
        <>
          <p className="line-main">
            <Hourglass size={16} /> Waiting for your {order.coinName} payment…
          </p>
          <p className="line-sub">
            Any amount from {trimAmount(order.min)} {order.coin} works.
          </p>
        </>
      );
    case 'received': {
      const belowMin = order.received !== null && Number(order.received) < Number(order.min);
      return (
        <>
          <p className="line-main">
            {order.confirmations > 0 ? 'Payment received' : 'Payment detected'}: <b>{paid}</b>
          </p>
          <p className="line-sub">
            {belowMin
              ? `That's below the ${trimAmount(order.min)} ${order.coin} minimum, so it will be sent back to the sender.`
              : `Waiting for network confirmations (${Math.min(order.confirmations, req)} of ${req})…`}
          </p>
        </>
      );
    }
    case 'swapping':
      return (
        <>
          <p className="line-main">
            Swapping <b>{paid}</b> to USDT…
          </p>
          <p className="line-sub">FixedFloat is exchanging it at the market rate.</p>
        </>
      );
    case 'sending':
      return (
        <>
          <p className="line-main">
            Sending <b>{order.usdt ? `≈ ${usdt(order.usdt)} USDT` : 'USDT'}</b> to {payoutName(order)}…
          </p>
          <p className="line-sub">To {order.payoutAddress ? shortAddr(order.payoutAddress) : payoutName(order)} on Ethereum.</p>
        </>
      );
    case 'done':
      return (
        <>
          <p className="line-main">
            Done! <b>{order.usdt ? `${usdt(order.usdt)} USDT` : 'USDT'}</b> sent to {payoutName(order)}.
          </p>
          <p className="line-sub">
            {paid} in, USDT out to {order.payoutAddress ? shortAddr(order.payoutAddress) : payoutName(order)}.{' '}
            {order.payoutTxUrl && (
              <a href={order.payoutTxUrl} target="_blank" rel="noreferrer">
                View payout
              </a>
            )}
          </p>
        </>
      );
    case 'refunded':
      return (
        <>
          <p className="line-main">
            {order.refundTx ? 'Sent back' : 'Refund requested'}
            {order.received ? <> : <b>{paid}</b></> : ''}
          </p>
          <p className="line-sub">
            {order.refundTo ? (
              <>
                {order.refundTx ? 'To' : 'Going to'} {shortAddr(order.refundTo)}
                {order.refundSource === 'sender'
                  ? ', the wallet it came from'
                  : order.refundSource === 'manual'
                    ? ', the address you entered'
                    : order.refundSource === 'own'
                      ? ', your own wallet'
                      : ''}
                .{' '}
              </>
            ) : null}
            FixedFloat returns it minus the network fee.{' '}
            {order.refundTxUrl && (
              <a href={order.refundTxUrl} target="_blank" rel="noreferrer">
                View refund
              </a>
            )}
          </p>
        </>
      );
    case 'expired':
      return (
        <>
          <p className="line-main">This address expired without a payment.</p>
          <p className="line-sub">Make a new address for the next payment.</p>
        </>
      );
    case 'attention': {
      const flags = order.emergency?.flags ?? [];
      const outOfLimits = flags.includes('LIMIT');
      const why = outOfLimits
        ? flags.includes('MORE')
          ? `The payment (${paid}) is above FixedFloat's maximum${order.max ? ` of ${trimAmount(order.max)} ${order.coin}` : ''}, so it can't be swapped. Choose where to send it back.`
          : `The payment (${paid}) is below FixedFloat's minimum of ${trimAmount(order.min)} ${order.coin}, so it can't be swapped.`
        : `FixedFloat needs a decision on this transfer (${flags.join(', ') || 'unknown'}). Order ID ${order.id}.`;
      // Out-of-limit payments go back to the sender by themselves, unless the sender couldn't be worked out safely.
      // Below-minimum payments go back to the sender by themselves, unless that can't be done safely.
      const automatic = outOfLimits && flags.includes('LESS') && !flags.includes('MORE') && !order.autoRefundError;
      return (
        <div className="attention">
          <div className="attention-head">
            <WarnIcon size={32} />
            <div>
              <p>{why}</p>
              {automatic && (
                <p className="line-sub">
                  <Hourglass size={14} /> Sending it back to the address it came from…
                </p>
              )}
              {order.refundRetry && <p className="line-sub">{order.refundRetry}</p>}
              {order.autoRefundError && <p className="error-text">{order.autoRefundError}</p>}
            </div>
          </div>
          {order.emergency?.choice === 'NONE' && !automatic && <RefundForm order={order} onUpdate={onUpdate} />}
        </div>
      );
    }
  }
}

interface DialogProps {
  order: Order;
  /** Opened by the watcher when a payment landed: start from "waiting" so the whole flow plays. */
  autoplay?: boolean;
  onClose(): void;
  onUpdate(o: Order): void;
}

export function TransferDialog({ order, autoplay, onClose, onUpdate }: DialogProps) {
  const shown = useDisplayedStage(order.stage, autoplay ? 'waiting' : undefined);
  const prev = useRef(shown);
  const enteredAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (prev.current === shown) return;
    prev.current = shown;
    enteredAt.current = Date.now();
    STAGE_SOUND[shown]?.();
  }, [shown]);

  useEffect(() => {
    if (shown === 'done') return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [shown]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Not while typing (the refund form), and not when another dialog is open on top.
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select')) return;
      if (document.querySelectorAll('.modal-layer').length > 1) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const theme = useTheme();
  const modern = theme.shell !== 'classic';
  const elapsed = now - enteredAt.current;
  const eta = etaFor(shown, order, elapsed);
  const finished = shown === 'done' || shown === 'expired' || (shown === 'refunded' && Boolean(order.refundTx));
  const percent = progressFor(shown, order, elapsed);
  const showProgress = shown !== 'attention' && shown !== 'expired';
  // Windows 10/11 copy dialogs title themselves with the percentage.
  const title =
    shown === 'done' ? 'Transfer complete' : modern && showProgress && shown !== 'waiting' ? `${Math.round(percent)}% complete` : `Swapping ${order.coinName} to USDT`;

  return (
    <ModalLayer>
      <Window title={title} icon={<AppMark />} onClose={onClose} className="win-dialog" role="dialog">
        {modern && (
          <p className="modern-head">
            Swapping {order.received ? `${trimAmount(order.received)} ${order.coin}` : order.coinName} from <b>{order.coinName}</b> to <b>{payoutName(order)}</b>
          </p>
        )}
        <TransferStrip order={order} shown={shown} />
        <div className="lines">
          <Lines order={order} shown={shown} onUpdate={onUpdate} />
        </div>
        {showProgress && (
          <>
            {modern && <p className="modern-pct">{shown === 'done' ? 'Complete' : `${Math.round(percent)}% complete`}</p>}
            {modern && <SpeedGraph percent={percent} seed={order.id + order.address} />}
            <ProgressBar percent={percent} />
            <p className="eta">{finished ? 'Finished.' : eta ? `${modern ? 'Time remaining' : 'Estimated time left'}: ${eta}` : ' '}</p>
          </>
        )}
        {order.autoError && <p className="error-text">Couldn't tell FixedFloat to continue yet: {order.autoError}</p>}
        {order.pollError && <p className="line-sub">Last check failed: {order.pollError}</p>}
        <div className="btn-row">
          {order.depositTxUrl && (
            <a className="btn98 btn-link" href={order.depositTxUrl} target="_blank" rel="noreferrer">
              Payment tx
            </a>
          )}
          <button type="button" className="btn98 is-default" onClick={onClose} autoFocus>
            {finished ? 'OK' : 'Hide'}
          </button>
        </div>
      </Window>
    </ModalLayer>
  );
}
