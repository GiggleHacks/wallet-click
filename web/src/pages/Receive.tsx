import { useEffect, useState } from 'react';
import { CoinIcon, Hourglass, WarnIcon } from '../components/art';
import { QrCode } from '../components/QrCode';
import { Window } from '../components/Win98';
import { clock, trimAmount, usdt } from '../lib/format';
import { sfx } from '../lib/sound';
import type { Order } from '../types';
import { STAGE_LABEL } from './Home';

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

interface Props {
  order: Order;
  /** The browser can't reach the server right now. */
  offline?: boolean;
  /** The "How it works" run: fake address, nothing to pay. */
  demo?: boolean;
  creating: boolean;
  onNew(): void;
  onBack(): void;
  onShowProgress(): void;
}

export function Receive({ order, demo, offline, creating, onNew, onBack, onShowProgress }: Props) {
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setCopied(false), [order.id]);

  const left = order.expiresAt ? order.expiresAt - now : null;
  const waiting = order.stage === 'waiting' || order.stage === 'expired';

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
              {order.max ? `, maximum ${trimAmount(order.max)} ${order.coin}` : ''}. Less than the minimum is sent back to the sender.
            </li>
            <li>Arrives as USDT in your Coinbase.</li>
            <li>
              {left !== null && left > 0 ? (
                <>
                  Pay within <b>{clock(left)}</b>. Late payments still go through for {order.watchDays} days.
                </>
              ) : (
                `The 30-minute window has passed. A payment in the next ${order.watchDays} days still goes through, but a new address is better.`
              )}
            </li>
          </ul>
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
                ? `Done: ${order.usdt ? `${usdt(order.usdt)} USDT` : 'USDT'} sent to Coinbase.`
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
