import { useEffect, useState } from 'react';
import { CoinIcon, Hourglass, WarnIcon } from '../components/art';
import { QrCode } from '../components/QrCode';
import { Window } from '../components/Win98';
import { clock, trimAmount, usdt } from '../lib/format';
import { sfx } from '../lib/sound';
import type { Order, Route, Transfer } from '../types';
import { transferStatus } from '../components/JourneyDialog';
import { MinimumNote } from '../components/SendOptions';
import { useMinimums } from '../lib/minimums';
import { STAGE_LABEL } from './Home';

const NETWORK: Record<Route['coin'], string> = { BTC: 'Bitcoin', ETH: 'Ethereum mainnet', XMR: 'Monero' };

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs HTTPS; fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy') ?? false;
    ta.remove();
    return ok;
  }
}

interface OnceProps {
  route: Route;
  /** The payment that came in to it, once there is one. */
  transfer?: Transfer;
  offline?: boolean;
  creating: boolean;
  onNew(): void;
  onBack(): void;
  onShowProgress(t: Transfer): void;
}

/** A coin button with a wait or pieces: a one-time address of our own wallet, which holds the payment for a while. */
export function ReceiveOnce({ route, transfer, offline, creating, onNew, onBack, onShowProgress }: OnceProps) {
  const [copied, setCopied] = useState(false);
  const minimums = useMinimums();
  const wait = route.delayHours ? `waits ${route.delayHours} hours (plus up to 30 minutes)` : 'goes on once it is confirmed';
  const pieces = (route.pieces ?? 1) > 1 ? ` in ${route.pieces} pieces, at random times` : '';
  async function copy() {
    if (await copyText(route.address)) {
      sfx.copy();
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }
  return (
    <Window
      title={`Receive ${route.coinName}`}
      icon={<CoinIcon coin={route.coin} size={16} />}
      onClose={onBack}
      className="win-receive"
      statusBar={
        <>
          <span className="status-cell grow">{transfer ? transferStatus(transfer) : 'Waiting'}</span>
          <span className="status-cell">One-time address</span>
        </>
      }
    >
      <div className="receive-grid">
        <div className="qr-box">
          <QrCode value={route.address} size={200} logo={<CoinIcon coin={route.coin} size={40} />} />
        </div>
        <div className="receive-info">
          <span className="lbl">
            Send {route.coinName} ({route.coin}) to:
          </span>
          <div className="address-box" onClick={() => void copy()} title="Click to copy">
            {route.address}
          </div>
          <button type="button" className="btn98 is-default" onClick={() => void copy()}>
            {copied ? 'Copied!' : 'Copy address'}
          </button>
          <ul className="hints">
            <li>
              <b>{NETWORK[route.coin]} only.</b>
              {route.coin === 'ETH' && ' Not Base, Arbitrum or any other network.'}
            </li>
            <li>
              A one-time address of your own wallet. The payment {wait}, then goes to <b>{route.destinationLabel}</b> as USDT{pieces}.
            </li>
            <li>It's watched for 30 days.</li>
          </ul>
          <MinimumNote m={minimums} o={{ route: 'direct', delayHours: route.delayHours ?? 0, pieces: route.pieces ?? 1 }} coin={route.coin} />
        </div>
      </div>
      <div className={`wait-row ${transfer ? 'is-live' : ''}`}>
        {transfer ? (
          <>
            <CoinIcon coin={route.coin} size={18} />
            <span>
              {transferStatus(transfer)}
              {transfer.received ? `: ${trimAmount(transfer.received)} ${route.coin}` : ''}
            </span>
            <button type="button" className="btn98" onClick={() => onShowProgress(transfer)}>
              Show progress
            </button>
          </>
        ) : (
          <>
            <Hourglass size={18} />
            <span>
              Waiting for payment<span className="dots" />
            </span>
          </>
        )}
      </div>
      {offline && (
        <p className="error-text" role="status">
          Can't reach the Wallet Click server right now. Retrying…
        </p>
      )}
      <div className="btn-row">
        <button type="button" className="btn98" onClick={onNew} disabled={creating}>
          {creating ? 'Getting address…' : 'New address'}
        </button>
        <button type="button" className="btn98" onClick={onBack}>
          Back
        </button>
      </div>
    </Window>
  );
}

interface Props {
  order: Order;
  /** A Privacy transfer that goes on in pieces: how many. */
  pieces?: number;
  /** The browser can't reach the server right now. */
  offline?: boolean;
  /** The "How it works" run: fake address, nothing to pay. */
  demo?: boolean;
  creating: boolean;
  onNew(): void;
  onBack(): void;
  onShowProgress(): void;
}

export function Receive({ order, pieces = 1, demo, offline, creating, onNew, onBack, onShowProgress }: Props) {
  const [copied, setCopied] = useState(false);
  const minimums = useMinimums();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setCopied(false), [order.id]);

  const left = order.expiresAt ? order.expiresAt - now : null;
  const waiting = order.stage === 'waiting' || order.stage === 'expired';
  const payout = order.payoutLabel ?? 'Coinbase';

  async function copy() {
    if (await copyText(order.address)) {
      sfx.copy();
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  return (
    <Window
      title={demo ? `Receive ${order.coinName} (demo)` : `Receive ${order.coinName}`}
      icon={<CoinIcon coin={order.coin} size={16} />}
      onClose={onBack}
      className="win-receive"
      statusBar={
        <>
          <span className="status-cell grow">{STAGE_LABEL[order.stage]}</span>
          <span className="status-cell">{demo ? 'Demo: no real money' : `Order ${order.id}`}</span>
        </>
      }
    >
      {demo && (
        <div className="warn-box demo-box">
          <WarnIcon size={20} /> Demo. This isn't a real address and no money moves. Watch what happens when a payment arrives.
        </div>
      )}
      {order.reusedAddress && (
        <div className="warn-box">
          <WarnIcon size={20} /> FixedFloat has handed out this address before. Make a new one if you need a never-used address.
        </div>
      )}
      <div className="receive-grid">
        <div className="qr-box">
          <QrCode value={demo ? 'Wallet Click demo: not a real address' : order.address} size={200} logo={<CoinIcon coin={order.coin} size={40} />} />
        </div>
        <div className="receive-info">
          <span className="lbl">
            Send {order.coinName} ({order.coin}) to:
          </span>
          <div className="address-box" onClick={() => void copy()} title="Click to copy">
            {order.address}
          </div>
          <button type="button" className="btn98 is-default" onClick={() => void copy()}>
            {copied ? 'Copied!' : 'Copy address'}
          </button>
          <ul className="hints">
            <li>
              <b>{order.network} only.</b>
              {order.coin === 'ETH' && ' Not Base, Arbitrum or any other network.'}
            </li>
            <li>
              Minimum <b>{trimAmount(order.min)} {order.coin}</b>
              {order.minUsd ? ` (≈ $${order.minUsd.toFixed(2)})` : ''}
              {order.max ? `, maximum ${trimAmount(order.max)} ${order.coin}` : ''}.{' '}
              {order.coin === 'XMR'
                ? "Less than the minimum can't be swapped; Monero hides who paid, so you'd give a refund address."
                : 'Less than the minimum is sent back to the sender.'}
            </li>
            <li>{order.toCcy === 'XMR' ? `Becomes Monero first, then USDT (Privacy Enhanced)${pieces > 1 ? `, in ${pieces} pieces` : ''}.` : `Arrives as USDT in ${payout}.`}</li>
            <li>
              {left !== null && left > 0 ? (
                <>
                  Pay within <b>{clock(left)}</b>. FixedFloat still takes a late payment up to 24 hours after the address was made.
                </>
              ) : (
                'The 30-minute window has passed. A payment within 24 hours of making this address still goes through at the market rate, but a new address is better.'
              )}
            </li>
          </ul>
          {!demo && pieces > 1 && <MinimumNote m={minimums} o={{ route: order.toCcy === 'XMR' ? 'monero' : 'direct', delayHours: 0, pieces }} coin={order.coin} />}
        </div>
      </div>
      <div className={`wait-row ${waiting ? '' : 'is-live'}`}>
        {waiting ? (
          <>
            <Hourglass size={18} />
            <span>
              Waiting for payment<span className="dots" />
            </span>
          </>
        ) : (
          <>
            <CoinIcon coin={order.coin} size={18} />
            <span>
              {order.stage === 'done'
                ? `Done: ${order.usdt ? `${usdt(order.usdt)} USDT` : 'USDT'} sent to ${payout}.`
                : `${STAGE_LABEL[order.stage]}${order.received ? `: ${trimAmount(order.received)} ${order.coin}` : ''}`}
            </span>
            <button type="button" className="btn98" onClick={onShowProgress}>
              Show progress
            </button>
          </>
        )}
      </div>
      {(offline || order.pollError) && (
        <p className="error-text" role="status">
          {offline ? "Can't reach the Wallet Click server right now. Retrying…" : `Couldn't check this transfer just now: ${order.pollError} Retrying…`}
        </p>
      )}
      <div className="btn-row">
        <button type="button" className="btn98" onClick={onNew} disabled={creating}>
          {demo ? 'Play again' : creating ? 'Getting address…' : 'New address'}
        </button>
        <button type="button" className="btn98" onClick={onBack}>
          Back
        </button>
      </div>
    </Window>
  );
}
