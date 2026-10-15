import { motion } from 'motion/react';
import { AppMark, BookIcon, CoinIcon, HouseIcon, PlayIcon, ShieldIcon, UsdtIcon } from '../components/art';
import { transferStatus } from '../components/JourneyDialog';
import { Window } from '../components/Win98';
import { shortAddr, timeAgo, trimAmount, usdt } from '../lib/format';
import type { Coin, Destination, Meta, Order, Stage, Transfer } from '../types';

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
  stage: string;
  label: string;
  privacy: boolean;
  route: string | null;
  open(): void;
}

function OrderList({ orders, transfers, onOpen, onOpenTransfer }: { orders: Order[]; transfers: Transfer[]; onOpen(o: Order): void; onOpenTransfer(t: Transfer): void }) {
  const rows: Row[] = [
    ...orders.map((o) => ({
      key: o.id,
      coin: o.coin,
      createdAt: o.createdAt,
      paid: o.received,
      usdt: o.usdt,
      stage: o.stage,
      label: o.stage === 'refunded' && !o.refundTx ? 'Refund requested' : STAGE_LABEL[o.stage],
      privacy: false,
      route: null,
      open: () => onOpen(o),
    })),
    ...transfers.map((t) => ({
      key: t.id,
      coin: t.coin,
      createdAt: t.createdAt,
      paid: t.received,
      usdt: t.usdt,
      stage: t.stage === 'holding' ? 'received' : t.stage,
      label: transferStatus(t),
      privacy: t.privacy,
      route: t.routeLabel,
      open: () => onOpenTransfer(t),
    })),
  ].sort((a, b) => b.createdAt - a.createdAt);
  const visible = rows.filter((o) => o.stage !== 'expired').slice(0, 12);
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
    <div className="listview">
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
                </span>
              </td>
              <td>{o.paid ? trimAmount(o.paid) : '—'}</td>
              <td>{o.usdt ? usdt(o.usdt) : '—'}</td>
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
  onPrivacy(): void;
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

export function Home({ meta, orders, transfers, onOpenTransfer, onPrivacy, onAddresses, destinations, destinationId, onDestination, onAddressBook, creating, offline, pressing, onCreate, onOpen, onDemo }: Props) {
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
            <span className="coin-sub">New {c} address</span>
          </motion.button>
        ))}
      </div>
      <div className="extra-row">
        <button type="button" className="btn98 extra-btn" onClick={onPrivacy}>
          <ShieldIcon size={30} />
          <span>
            <b>Privacy Enhanced…</b>
            <small>Through Monero, with a wait</small>
          </span>
        </button>
        <button type="button" className="btn98 extra-btn" onClick={onAddresses}>
          <HouseIcon size={30} />
          <span>
            <b>My Addresses…</b>
            <small>Permanent addresses for your phone</small>
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
        {payoutAddress && <code title={payoutAddress}>{shortAddr(payoutAddress)}</code>}
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
