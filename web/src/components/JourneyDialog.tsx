import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { trimAmount, usdt } from '../lib/format';
import { sfx } from '../lib/sound';
import type { Order, Transfer, TransferStep } from '../types';
import { AppMark, CheckBadge, CoinIcon, CoinbaseIcon, HouseIcon, Hourglass, ShieldIcon, SwapMachine, UsdtIcon, VaultIcon, WarnIcon, XmrIcon } from './art';
import { DelaySlider, untilText } from './DelaySlider';
import { Burst, Flyers, RefundForm, Station } from './TransferDialog';
import { ModalLayer, Window } from './Win98';

type Spot = 'coin' | 'swap1' | 'vault' | 'swap2' | 'dest';

/** Which station the money is at right now. */
function spotOf(t: Transfer): Spot {
  if (t.state === 'done') return 'dest';
  if (t.state === 'collect' || t.state === 'open1' || t.state === 'send1') return 'coin';
  if (t.state === 'swap1') return t.leg1 && ['swapping', 'sending', 'done'].includes(t.leg1.stage) ? 'swap1' : 'coin';
  if (t.state === 'xmr-in' || t.state === 'churn' || t.state === 'wait') return 'vault';
  return 'swap2';
}

function JourneyStrip({ t }: { t: Transfer }) {
  const spot = spotOf(t);
  const order: Spot[] = t.privacy ? ['coin', 'swap1', 'vault', 'swap2', 'dest'] : ['coin', 'swap1', 'dest'];
  const x: Record<Spot, number> = t.privacy ? { coin: 9, swap1: 29.5, vault: 50, swap2: 70.5, dest: 91 } : { coin: 13, swap1: 50, swap2: 50, vault: 50, dest: 87 };
  const at = order.indexOf(spot);
  const past = (s: Spot) => order.indexOf(s) < at;
  const prev = useRef(spot);
  const [fx, setFx] = useState(0);
  useEffect(() => {
    if (prev.current !== spot) setFx(Date.now());
    prev.current = spot;
  }, [spot]);
  const coinbase = t.destinationId === 'coinbase';
  // Coins only fly while something is moving them: not while waiting for a payment, nor while they sit in the vault.
  const flying = !t.attention && spot !== 'vault' && spot !== 'dest' && t.state !== 'collect' && !(t.state === 'swap1' && spot === 'coin');
  return (
    <div className={`strip journey-strip ${t.privacy ? 'is-five' : ''}`} aria-hidden="true">
      <div className="track" style={{ left: `${x.coin}%`, right: `${100 - x.dest}%` }} />
      <Station x={x.coin} label={t.coinName} dim={past('coin')} pulse={spot === 'coin'}>
        {t.routeId ? (
          <span className="stack-icon">
            <CoinIcon coin={t.coin} size={40} />
            <span className="stack-badge">
              <HouseIcon size={18} />
            </span>
          </span>
        ) : (
          <CoinIcon coin={t.coin} size={40} />
        )}
      </Station>
      <Station x={x.swap1} label="Swap" working={spot === 'swap1'} dim={past('swap1')}>
        <SwapMachine size={t.privacy ? 46 : 58} spinning={spot === 'swap1'} />
      </Station>
      {t.privacy && (
        <Station x={x.vault} label={spot === 'vault' && t.releaseAt ? 'Waiting' : 'Monero'} working={spot === 'vault'} dim={past('vault')} pulse={spot === 'vault'}>
          <VaultIcon size={44} />
          {spot === 'vault' && (
            <span className="station-badge">
              <Hourglass size={16} />
            </span>
          )}
        </Station>
      )}
      {t.privacy && (
        <Station x={x.swap2} label="Swap" working={spot === 'swap2'} dim={past('swap2')}>
          <SwapMachine size={46} spinning={spot === 'swap2'} />
        </Station>
      )}
      <Station x={x.dest} label={t.destinationLabel} pulse={spot === 'dest'}>
        {coinbase ? <CoinbaseIcon size={40} /> : <UsdtIcon size={40} />}
        {spot === 'dest' && fx > 0 && <Burst key={fx} color="#0052ff" center />}
        {t.state === 'done' && (
          <motion.span className="station-badge" initial={{ scale: 0 }} animate={{ scale: 1 }}>
            <CheckBadge />
          </motion.span>
        )}
      </Station>
      {flying && (
        <Flyers from={x[spot] + 4} to={x[order[at + 1]] - 5} count={3}>
          {spot === 'coin' ? <CoinIcon coin={t.coin} size={20} /> : spot === 'swap1' && t.privacy ? <XmrIcon size={20} /> : <UsdtIcon size={20} />}
        </Flyers>
      )}
    </div>
  );
}

const MARK: Record<TransferStep['status'], string> = { done: '✔', active: '►', pending: '○', failed: '!' };

function Steps({ steps, releaseAt }: { steps: TransferStep[]; releaseAt: number | null }) {
  return (
    <ol className="steps98">
      {steps.map((s) => (s.key === 'wait' && !s.detail && releaseAt ? { ...s, detail: `until ${new Date(releaseAt).toLocaleString()}` } : s)).map((s) => (
        <li key={s.key} className={`step is-${s.status}`}>
          <span className="step-mark" aria-hidden="true">
            {MARK[s.status]}
          </span>
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

interface Props {
  transfer: Transfer;
  delays: number[];
  onClose(): void;
  onUpdate(t: Transfer): void;
  /** Shows a first-swap order's own window (its address, or its refund form). */
  onOpenOrder?(o: Order): void;
}

export function JourneyDialog({ transfer: t, delays, onClose, onUpdate, onOpenOrder }: Props) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [editDelay, setEditDelay] = useState(false);
  const [delay, setDelay] = useState(t.delayHours && delays.includes(t.delayHours) ? t.delayHours : delays[0]);

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
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

  const left = t.releaseAt !== null ? t.releaseAt - now : null;
  const waiting = t.state === 'wait' && left !== null && left > 0;
  const title = t.state === 'done' ? 'Transfer complete' : t.privacy ? 'Privacy Enhanced transfer' : `Payment to "${t.routeLabel ?? 'permanent address'}"`;
  const leg1Needs = t.leg1?.stage === 'attention' && t.leg1.emergency?.choice === 'NONE';
  const finished = t.state === 'done' || t.state === 'refunded';

  return (
    <ModalLayer>
      <Window title={title} icon={t.privacy ? <ShieldIcon size={16} /> : <AppMark />} onClose={onClose} className="win-dialog win-journey" role="dialog">
        <JourneyStrip t={t} />
        <div className="lines">
          <p className="line-main">
            {t.state === 'done' ? (
              <>
                Done! <b>{t.usdt ? `${usdt(t.usdt)} USDT` : 'USDT'}</b> sent to {t.destinationLabel}.
              </>
            ) : t.state === 'refunded' ? (
              'FixedFloat sent the payment back.'
            ) : waiting ? (
              <>
                <Hourglass size={16} /> Holding <b>{t.xmr ? `${trimAmount(t.xmr)} XMR` : 'Monero'}</b> for another {untilText(left!)}
              </>
            ) : (
              <>
                {t.received ? `${trimAmount(t.received)} ${t.coin}` : t.coinName} → {t.privacy ? 'Monero → ' : ''}USDT for {t.destinationLabel}
              </>
            )}
          </p>
          {waiting && <p className="line-sub">Swaps to USDT at {new Date(t.releaseAt!).toLocaleString()}.</p>}
          {!waiting && t.waitingFor && !finished && <p className="line-sub">Waiting for {t.waitingFor}…</p>}
          {t.error && !t.attention && <p className="line-sub">Retrying: {t.error}</p>}
        </div>

        <Steps steps={t.steps} releaseAt={t.releaseAt} />

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

        {editDelay && (
          <fieldset className="group98">
            <legend>
              Wait in Monero: <b>{delay} hours</b> (counted from when it unlocked)
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
          {t.leg1 && !t.routeId && t.leg1.stage === 'waiting' && onOpenOrder && (
            <button type="button" className="btn98" onClick={() => onOpenOrder(t.leg1!)}>
              Show address
            </button>
          )}
          {t.canChangeDelay && !editDelay && (
            <button type="button" className="btn98" onClick={() => setEditDelay(true)}>
              Change wait…
            </button>
          )}
          {t.canRelease && (
            <button type="button" className="btn98" disabled={busy} onClick={() => void act(() => api.release(t.id))}>
              Release now
            </button>
          )}
          {t.canRetry && (
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
  if (t.stage === 'holding') return t.releaseAt && t.releaseAt > now && t.state === 'wait' ? `Waiting ${untilText(t.releaseAt - now)}` : 'In Monero';
  return { waiting: 'Waiting', received: t.routeId ? 'Received' : 'Confirming', swapping: 'Swapping', sending: 'Sending', done: 'Done', refunded: 'Sent back', expired: 'Expired', attention: 'Needs you' }[t.stage];
}
