import { motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { AppMark, BookIcon, ClockIcon, CoinIcon, EyeIcon, HouseIcon, PlayIcon, ShieldIcon, UsdtIcon } from '../components/art';
import { transferStatus } from '../components/JourneyDialog';
import { Window } from '../components/Win98';
import { setPref, usePref } from '../lib/prefs';
import { shortAddr, timeAgo, trimAmount, usdt } from '../lib/format';
import { costText } from '../lib/cost';
import { coinSub, optionsSummary, type SendOptions } from '../lib/sendOptions';
import { usdText, useMinimums } from '../lib/minimums';
import { safeForAll } from '../components/SendOptions';
import type { Coin, Cost, Destination, Meta, Order, Stage, Transfer } from '../types';

export const STAGE_LABEL: Record<Stage, string> = {
  waiting: 'Waiting',
  received: 'Confirming',
  swapping: 'Swapping',
  sending: 'Sending',
  done: 'Done',
  refunded: 'Sent back',
  expired: 'Expired',
  attention: 'Needs you',
};

const COINS: Coin[] = ['BTC', 'ETH', 'XMR'];
export const COIN_NAME: Record<Coin, string> = { BTC: 'Bitcoin', ETH: 'Ethereum', XMR: 'Monero' };
const TILT: Record<Coin, number> = { BTC: -10, ETH: 10, XMR: -6 };

interface Row {
  key: string;
  coin: Coin;
  createdAt: number;
  paid: string | null;
  usdt: string | null;
  cost: Cost | null;
  stage: string;
  label: string;
  privacy: boolean;
  route: string | null;
  pieces: number;
  open(): void;
}

const LIST_MIN = 150;
const LIST_MAX = 430;

/** On a computer the list is as tall as fits (up to LIST_MAX), so the window never runs under the taskbar. */
function useFitAboveTaskbar(ref: React.RefObject<HTMLDivElement | null>) {
  const fit = () => {
    const el = ref.current;
    const win = el?.closest('.win');
    const bar = document.querySelector('.taskbar');
    if (!el || !win || !bar) return;
    if (window.innerWidth <= 560) {
      el.style.maxHeight = ''; // phones scroll the page instead
      return;
    }
    const list = el.getBoundingClientRect();
    const below = win.getBoundingClientRect().bottom - list.bottom;
    // Above the taskbar, and inside the workspace's bottom padding (so the page itself doesn't scroll).
    const pad = parseFloat(getComputedStyle(win.closest('.workspace') ?? document.body).paddingBottom) || 0;
    const room = Math.min(bar.getBoundingClientRect().top - 10, window.innerHeight - pad) - below - list.top;
    el.style.maxHeight = `${Math.round(Math.max(LIST_MIN, Math.min(LIST_MAX, room)))}px`;
  };
  useLayoutEffect(fit);
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  });
}

function OrderList({ orders, transfers, onOpen, onOpenTransfer }: { orders: Order[]; transfers: Transfer[]; onOpen(o: Order): void; onOpenTransfer(t: Transfer): void }) {
  const box = useRef<HTMLDivElement>(null);
  useFitAboveTaskbar(box);
  const rows: Row[] = [
    ...orders.map((o) => ({
      key: o.id,
      coin: o.coin,
      createdAt: o.createdAt,
      paid: o.received,
      usdt: o.usdt,
      cost: o.cost ?? null,
      stage: o.stage,
      label: o.stage === 'refunded' && !o.refundTx ? 'Refund requested' : STAGE_LABEL[o.stage],
      privacy: false,
      route: null,
      pieces: 1,
      open: () => onOpen(o),
    })),
    ...transfers.map((t) => ({
      key: t.id,
      coin: t.coin,
      createdAt: t.createdAt,
      paid: t.received,
      usdt: t.usdt,
      cost: t.cost ?? null,
      stage: t.stage === 'holding' ? 'received' : t.stage,
      label: transferStatus(t),
      privacy: t.privacy,
      route: t.routeLabel,
      pieces: t.pieces ?? 1,
      open: () => onOpenTransfer(t),
    })),
  ].sort((a, b) => b.createdAt - a.createdAt);
  const visible = rows.filter((o) => o.stage !== 'expired').slice(0, 100);
  const hidden = rows.filter((o) => o.stage === 'expired').length;
  if (!visible.length) {
    return (
      <div className="listview is-empty">
        <p>Nothing yet. Pick a coin above to get an address.</p>
        {hidden > 0 && <p className="line-sub">{hidden} unused address{hidden === 1 ? '' : 'es'} expired.</p>}
      </div>
    );
  }
  return (
    <div className="listview" ref={box}>
      <table>
        <thead>
          <tr>
            <th>Coin</th>
            <th>Paid</th>
            <th>USDT</th>
            <th>Status</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((o) => (
            <tr key={o.key} onClick={o.open} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && o.open()} title={o.route ? `Paid to "${o.route}"` : undefined}>
              <td>
                <span className="cell-coin">
                  <CoinIcon coin={o.coin} size={16} /> {o.coin}
                  {o.privacy && (
                    <span className="tag" title="Privacy Enhanced">
                      <ShieldIcon size={14} />
                    </span>
                  )}
                  {o.route && (
                    <span className="tag" title={`Permanent address "${o.route}"`}>
                      <HouseIcon size={14} />
                    </span>
                  )}
                  {o.pieces > 1 && (
                    <span className="tag tag-pieces" title={`Sent in ${o.pieces} pieces`}>
                      ×{o.pieces}
                    </span>
                  )}
                </span>
              </td>
              <td>{o.paid ? trimAmount(o.paid) : '—'}</td>
              <td title={o.cost ? costText(o.cost) : undefined}>{o.usdt ? usdt(o.usdt) : '—'}</td>
              <td>
                <span className={`stage-pill stage-${o.stage}`}>{o.label}</span>
              </td>
              <td className="cell-time">{timeAgo(o.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 && <p className="list-foot">+ {hidden} unused address{hidden === 1 ? '' : 'es'} (expired)</p>}
    </div>
  );
}

interface Props {
  meta: Meta | null;
  orders: Order[];
  transfers: Transfer[];
  onOpenTransfer(t: Transfer): void;
  /** How the coin buttons send (route, wait, pieces), and the button that changes it. */
  sendOptions: SendOptions;
  onSendOptions(): void;
  onAddresses(): void;
  destinations: Destination[];
  destinationId: string;
  onDestination(id: string): void;
  onAddressBook(): void;
  creating: Coin | null;
  offline?: boolean;
  /** The demo is "clicking" this coin button. */
  pressing: Coin | null;
  onCreate(coin: Coin): void;
  onOpen(o: Order): void;
  onDemo(): void;
}

export function Home({ meta, orders, transfers, onOpenTransfer, sendOptions, onSendOptions, onAddresses, destinations, destinationId, onDestination, onAddressBook, creating, offline, pressing, onCreate, onOpen, onDemo }: Props) {
  const hideFigures = usePref('hideFigures');
  const safe = safeForAll(useMinimums(), sendOptions);
  const toggleHide = () => setPref('hideFigures', !hideFigures);
  const dest = destinations.find((d) => d.id === destinationId) ?? destinations[0];
  const payoutAddress = dest?.address ?? meta?.payout.address;
  const active =
    orders.filter((o) => ['waiting', 'received', 'swapping', 'sending'].includes(o.stage)).length +
    transfers.filter((t) => ['waiting', 'received', 'swapping', 'holding', 'sending'].includes(t.stage)).length;
  return (
    <Window
      title="Wallet Click"
      icon={<AppMark />}
      full
      className="win-home"
      statusBar={
        <>
          <span className={`status-cell grow ${offline ? 'is-offline' : ''}`}>
            {offline ? "Can't reach the server. Retrying…" : active ? `Watching ${active} transfer${active === 1 ? '' : 's'}` : 'Ready'}
          </span>
          <span className="status-cell">{meta ? (meta.swapConfigured ? 'FixedFloat: connected' : 'FixedFloat: no API key') : '…'}</span>
        </>
      }
    >
      <div className="intro-row">
        <p className="intro">Get paid in:</p>
        <button type="button" className="btn98 btn-small" onClick={onDemo}>
          <PlayIcon size={16} /> How it works
        </button>
      </div>
      <div className="coin-grid">
        {COINS.map((c) => (
          <motion.button
            key={c}
            type="button"
            data-coin={c}
            className={`btn98 coin-btn ${pressing === c ? 'is-pressed' : ''}`}
            onClick={() => onCreate(c)}
            disabled={creating !== null}
            whileHover="hover"
            whileTap="tap"
          >
            <motion.span className="coin-art" variants={{ hover: { y: -5, rotate: TILT[c] }, tap: { y: 0, scale: 0.94 } }} transition={{ type: 'spring', stiffness: 500, damping: 14 }}>
              <CoinIcon coin={c} size={60} />
            </motion.span>
            <span className="coin-name">{creating === c ? 'Getting address…' : COIN_NAME[c]}</span>
            <span className="coin-sub">{coinSub(sendOptions, c)}</span>
          </motion.button>
        ))}
      </div>
      <div className="extra-row">
        <div className="send-box">
          {sendOptions.route === 'monero' ? <ShieldIcon size={30} /> : <ClockIcon size={30} />}
          <span className="send-box-text">
            <b>Send options</b>
            <small>{optionsSummary(sendOptions)}</small>
            {safe !== null && <small className="send-box-min">To be safe, send at least {usdText(safe)}</small>}
          </span>
          <button type="button" className="btn98 btn-small" onClick={onSendOptions}>
            Change…
          </button>
        </div>
        <button type="button" className="btn98 extra-btn" onClick={onAddresses}>
          <HouseIcon size={30} />
          <span>
            <b>My Addresses…</b>
            <small>Save once, pay any time</small>
          </span>
        </button>
      </div>
      <div className="payout-line">
        <UsdtIcon size={20} />
        <label htmlFor="dest-pick">
          Everything arrives as <b>USDT</b> in
        </label>
        {destinations.length > 1 ? (
          <select id="dest-pick" className="input98 select98" value={dest?.id ?? ''} onChange={(e) => onDestination(e.target.value)}>
            {destinations.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        ) : (
          <b>{dest?.label ?? meta?.payout.label ?? 'Coinbase'}</b>
        )}
        {payoutAddress && (
          <>
            <code title={hideFigures ? undefined : payoutAddress}>{shortAddr(payoutAddress)}</code>
            <button
              type="button"
              className="btn98 btn-icon"
              onClick={toggleHide}
              aria-pressed={hideFigures}
              title={hideFigures ? 'Show amounts and addresses' : 'Hide amounts and addresses'}
              aria-label={hideFigures ? 'Show amounts and addresses' : 'Hide amounts and addresses'}
            >
              <EyeIcon size={16} off={hideFigures} />
            </button>
          </>
        )}
        <button type="button" className="btn98 btn-icon" onClick={onAddressBook} title="Address Book" aria-label="Address Book">
          <BookIcon size={16} />
        </button>
      </div>
      <fieldset className="group98">
        <legend>Recent transfers</legend>
        <OrderList orders={orders} transfers={transfers} onOpen={onOpen} onOpenTransfer={onOpenTransfer} />
      </fieldset>
    </Window>
  );
}
