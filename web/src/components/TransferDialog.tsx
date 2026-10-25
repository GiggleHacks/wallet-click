import { motion, useAnimate } from 'motion/react';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../api';
import { isCalm } from '../lib/motion';
import { FX, ParticleLayer, type ParticleApi } from './Particles';
import { Courier, courierCoin, type Flight } from './Courier';
import { minutesText, shortAddr, trimAmount, usdt } from '../lib/format';
import { COST_HELP, costText } from '../lib/cost';
import { sfx } from '../lib/sound';
import { useTheme } from '../lib/themes';
import type { Order, Stage } from '../types';
import { networkOf, symbolOf, isCoinbaseId } from '../lib/assets';
import { AppMark, CheckBadge, CoinIcon, CoinbaseIcon, Hourglass, ModernPC, StableIcon, SwapMachine, WarnIcon } from './art';
import { PasswordField } from './PasswordField';
import { Tip } from './Tip';
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
/** The middle of a station's icon, in px from the top of the strip (where the track runs). */
export const ICON_Y = 36;

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

/**
 * A stop on the strip. `pulse` pops it once; `catches` (a counter) squashes it like it just caught a coin;
 * `idle` makes it bob gently while it waits; `ping` sends radar rings out while it waits for money.
 */
export function Station({ x, label, children, pulse, dim, working, catches, idle, ping, glow }: { x: number; label: ReactNode; children: ReactNode; pulse?: boolean; dim?: boolean; working?: boolean; catches?: number; idle?: boolean; ping?: boolean; glow?: string }) {
  const [scope, animate] = useAnimate();
  useEffect(() => {
    if (pulse && !isCalm()) void animate(scope.current, { scale: [1, 1.18, 0.97, 1] }, { duration: 0.55, ease: [0.22, 1, 0.36, 1] });
  }, [pulse, animate, scope]);
  useEffect(() => {
    if (catches && !isCalm()) void animate(scope.current, { scaleX: [1, 1.14, 0.96, 1], scaleY: [1, 0.84, 1.06, 1] }, { duration: 0.38, ease: 'easeOut' });
  }, [catches, animate, scope]);
  return (
    <div className={`station ${dim ? 'is-dim' : ''} ${working ? 'is-working' : ''} ${idle ? 'is-idle' : ''}`} style={{ left: `${x}%`, ...(glow ? ({ '--station-glow': glow } as CSSProperties) : null) }}>
      {ping && (
        <span className="station-ping" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      {glow && <span className="station-halo" aria-hidden="true" />}
      <div ref={scope} className="station-icon">
        <span className="station-bob">{children}</span>
      </div>
      <span className="station-label">{label}</span>
    </div>
  );
}

/** The track between stations: lit where the money has been, flowing where it's going now. */
export function Track({ from, to, flowFrom, flowTo, litTo, slow }: { from: number; to: number; flowFrom?: number; flowTo?: number; litTo?: number; slow?: boolean }) {
  return (
    <>
      <div className="track" style={{ left: `${from}%`, right: `${100 - to}%` }} />
      {litTo !== undefined && litTo > from && <div className="track-lit" style={{ left: `${from}%`, width: `${litTo - from}%` }} />}
      {flowFrom !== undefined && flowTo !== undefined && flowTo > flowFrom && (
        <div className={`track-flow ${slow ? 'is-slow' : ''}`} style={{ left: `${flowFrom}%`, width: `${flowTo - flowFrom}%` }}>
          <span />
        </div>
      )}
    </>
  );
}

/** Coin colours for particles. */
export const COIN_COLORS: Record<string, string[]> = {
  BTC: ['#f7931a', '#ffc46b', '#ffffff'],
  ETH: ['#7b8ff7', '#b6c2ff', '#ffffff'],
  XMR: ['#ff6600', '#ffa25c', '#ffffff'],
  USDC: ['#2775ca', '#7fb3ef', '#ffffff'],
  USDT: ['#26a17b', '#7ad6b6', '#ffffff'],
  DONE: ['#0052ff', '#2775ca', '#ffc83a', '#26a17b', '#ff6600', '#ffffff'],
};
export const stableColors = (ccy?: string | null) => (ccy === 'USDT' ? COIN_COLORS.USDT : ccy === 'XMR' ? COIN_COLORS.XMR : COIN_COLORS.USDC);

/** Fires `fn` every `ms` while `on` (for little moments inside a long phase). */
export function useEvery(on: boolean, ms: number, fn: () => void) {
  const cb = useRef(fn);
  cb.current = fn;
  useEffect(() => {
    if (!on) return;
    const iv = setInterval(() => !document.hidden && cb.current(), ms);
    return () => clearInterval(iv);
  }, [on, ms]);
}

type Fx = { key: number; kind: 'in' | 'out' | 'done' };

/** Where the payout goes: "Coinbase" unless another destination was picked. */
export const payoutName = (order: Order) => order.payoutLabel ?? 'Coinbase';
const isCoinbase = (order: Order) => isCoinbaseId(order.destinationId);

export function TransferStrip({ order, shown }: { order: Order; shown: Stage }) {
  const theme = useTheme();
  const done = shown === 'done';
  const busy = shown === 'swapping' || shown === 'received' || shown === 'sending';
  const swapping = shown === 'swapping';
  const after = (s: Stage) => FLOW.indexOf(shown) > FLOW.indexOf(s);

  const parts = useRef<ParticleApi>(null);
  const [caught, setCaught] = useState({ swap: 0, dest: 0 });
  const coinColors = COIN_COLORS[order.coin] ?? COIN_COLORS.ETH;
  const outColors = stableColors(order.toCcy);

  // One-shot effects on the moments that matter: the coin going in, the USDC popping out, arrival.
  const prev = useRef(shown);
  const [fx, setFx] = useState<Fx | null>(null);
  useEffect(() => {
    const from = prev.current;
    prev.current = shown;
    if (from === shown) return;
    const p = parts.current;
    if (shown === 'swapping') {
      setFx({ key: Date.now(), kind: 'in' });
      p?.emit(X.swap, ICON_Y, FX.glow(coinColors));
    } else if (shown === 'sending') {
      setFx({ key: Date.now(), kind: 'out' });
      p?.emit(X.swap, ICON_Y, FX.burst(outColors));
    } else if (shown === 'done') {
      setFx({ key: Date.now(), kind: 'done' });
      p?.emit(X.coinbase, ICON_Y, FX.burst(COIN_COLORS.DONE));
      p?.emit(X.coinbase, ICON_Y - 8, FX.confetti(COIN_COLORS.DONE));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  useEffect(() => {
    if (!fx) return;
    const t = setTimeout(() => setFx(null), 900);
    return () => clearTimeout(t);
  }, [fx]);

  const land = (at: 'swap' | 'dest') => () => {
    parts.current?.emit(at === 'swap' ? X.swap - 4 : X.coinbase - 3, ICON_Y + 4, FX.land(at === 'swap' ? coinColors : outColors));
    setCaught((c) => ({ ...c, [at]: c[at] + 1 }));
  };
  const flow = shown === 'waiting' || shown === 'received' ? [X.coin, X.swap] : shown === 'swapping' || shown === 'sending' ? [X.swap, X.coinbase] : null;
  const out = courierCoin(order.toCcy);
  const flights: Flight[] = [];
  if (shown === 'received') flights.push({ id: 'in', from: X.coin, to: X.swap, coin: order.coin, onLand: land('swap') });
  if (shown === 'sending') flights.push({ id: 'out', from: X.swap, to: X.coinbase, coin: out, onLand: land('dest') });

  return (
    <div className={`strip stage-${shown}`} aria-hidden="true">
      <Track from={X.coin} to={X.coinbase} litTo={done ? X.coinbase : after('received') ? X.swap : undefined} flowFrom={flow?.[0]} flowTo={flow?.[1]} />
      <Courier flights={flights} orbit={swapping ? { x: X.swap, a: order.coin, b: out, r: 50 } : null} />
      <ParticleLayer ref={parts} ambient={swapping ? [{ x: X.swap, y: ICON_Y, rate: 24, ...FX.swirl([...coinColors, ...outColors]) }] : undefined} />
      <Station x={X.coin} label={order.coinName} dim={after('received')} ping={shown === 'waiting'} idle={shown === 'waiting'}>
        <CoinIcon coin={order.coin} size={44} />
      </Station>
      <Station x={X.swap} label="Swap" working={swapping} catches={caught.swap}>
        {swapping && <span className="swap-glow" />}
        <span className="station-machine">
          {theme.shell === 'classic' ? <SwapMachine size={60} spinning={busy} /> : <ModernPC size={60} spinning={busy} variant={theme.shell} />}
        </span>
        {fx?.kind === 'in' && <span key={fx.key} className="swap-flash" />}
        {fx?.kind === 'out' && <Burst key={fx.key} color="#26a17b" />}
      </Station>
      <Station x={X.coinbase} label={payoutName(order)} pulse={done} catches={caught.dest} glow={done ? '#2775ca' : undefined}>
        {isCoinbase(order) ? <CoinbaseIcon size={44} /> : <StableIcon ccy={order.toCcy} size={44} />}
        {fx?.kind === 'done' && <Burst key={fx.key} color="#0052ff" center />}
        {done && (
          <motion.span className="station-badge" initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 14 }}>
            <CheckBadge />
          </motion.span>
        )}
      </Station>
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
            Min {trimAmount(order.min)} {order.coin}
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
              ? `Below the ${trimAmount(order.min)} ${order.coin} minimum: going back to the sender.`
              : `Confirmations ${Math.min(order.confirmations, req)}/${req}`}
          </p>
        </>
      );
    }
    case 'swapping':
      return (
        <>
          <p className="line-main">
            Swapping <b>{paid}</b> to {symbolOf(order.toCcy)}…
          </p>
        </>
      );
    case 'sending':
      return (
        <>
          <p className="line-main">
            Sending <b>{order.usdt ? `≈ ${usdt(order.usdt)} ${symbolOf(order.toCcy)}` : symbolOf(order.toCcy)}</b> to {payoutName(order)}…
          </p>
          <p className="line-sub">
            {order.payoutAddress ? shortAddr(order.payoutAddress) : payoutName(order)} · {networkOf(order.toCcy)}
          </p>
        </>
      );
    case 'done':
      return (
        <>
          <p className="line-main">
            Done! <b>{order.usdt ? `${usdt(order.usdt)} ${symbolOf(order.toCcy)}` : symbolOf(order.toCcy)}</b> sent to {payoutName(order)}.
          </p>
          {order.cost && (
            <p className="line-cost" title={COST_HELP}>
              {costText(order.cost)}
            </p>
          )}
          {order.payoutTxUrl && (
            <p className="line-sub">
              <a href={order.payoutTxUrl} target="_blank" rel="noreferrer">
                View payout
              </a>
            </p>
          )}
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
            <Tip tip="FixedFloat returns it minus the network fee." />{' '}
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
          <p className="line-main">Expired without a payment.</p>
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
    shown === 'done' ? 'Transfer complete' : modern && showProgress && shown !== 'waiting' ? `${Math.round(percent)}% complete` : `Swapping ${order.coinName} to ${symbolOf(order.toCcy)}`;

  return (
    <ModalLayer>
      <Window title={title} icon={<AppMark />} onClose={onClose} className={`win-dialog ${shown === 'done' ? 'is-done' : ''}`} role="dialog">
        {modern && (
          <p className="modern-head">
            Swapping {order.received ? `${trimAmount(order.received)} ${order.coin}` : order.coinName} from <b>{order.coinName}</b> to <b>{payoutName(order)}</b>
          </p>
        )}
        <TransferStrip order={order} shown={shown} />
        <div className="lines">
          <motion.div key={shown} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}>
            <Lines order={order} shown={shown} onUpdate={onUpdate} />
          </motion.div>
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
