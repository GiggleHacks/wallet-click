import { motion } from 'motion/react';
import { AppMark, CoinIcon, PlayIcon, UsdtIcon } from '../components/art';
import { Window } from '../components/Win98';
import { shortAddr, timeAgo, trimAmount, usdt } from '../lib/format';
import type { Coin, Meta, Order, Stage } from '../types';

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

const COINS: Coin[] = ['BTC', 'ETH'];

function OrderList({ orders, onOpen }: { orders: Order[]; onOpen(o: Order): void }) {
  const visible = orders.filter((o) => o.stage !== 'expired').slice(0, 12);
  const hidden = orders.filter((o) => o.stage === 'expired').length;
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
            <tr key={o.id} onClick={() => onOpen(o)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(o)}>
              <td>
                <span className="cell-coin">
                  <CoinIcon coin={o.coin} size={16} /> {o.coin}
                </span>
              </td>
              <td>{o.received ? trimAmount(o.received) : '—'}</td>
              <td>{o.usdt ? usdt(o.usdt) : '—'}</td>
              <td>
                <span className={`stage-pill stage-${o.stage}`}>{o.stage === 'refunded' && !o.refundTx ? 'Refund requested' : STAGE_LABEL[o.stage]}</span>
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
  creating: Coin | null;
  offline?: boolean;
  /** The demo is "clicking" this coin button. */
  pressing: Coin | null;
  onCreate(coin: Coin): void;
  onOpen(o: Order): void;
  onDemo(): void;
}

export function Home({ meta, orders, creating, offline, pressing, onCreate, onOpen, onDemo }: Props) {
  const active = orders.filter((o) => ['waiting', 'received', 'swapping', 'sending'].includes(o.stage)).length;
  return (
    <Window
      title="Wallet Click"
      icon={<AppMark />}
      full
      className="win-home"
      statusBar={
        <>
          <span className={`status-cell grow ${offline ? 'is-offline' : ''}`}>
            {offline ? "Can't reach the server. Retrying…" : active ? `Watching ${active} address${active === 1 ? '' : 'es'}` : 'Ready'}
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
            <motion.span className="coin-art" variants={{ hover: { y: -5, rotate: c === 'BTC' ? -10 : 10 }, tap: { y: 0, scale: 0.94 } }} transition={{ type: 'spring', stiffness: 500, damping: 14 }}>
              <CoinIcon coin={c} size={60} />
            </motion.span>
            <span className="coin-name">{creating === c ? 'Getting address…' : c === 'BTC' ? 'Bitcoin' : 'Ethereum'}</span>
            <span className="coin-sub">New {c} address</span>
          </motion.button>
        ))}
      </div>
      <div className="payout-line">
        <UsdtIcon size={20} />
        <span>
          Everything arrives as <b>USDT</b> in <b>Coinbase</b>
        </span>
        {meta && <code title={meta.payout.address}>{shortAddr(meta.payout.address)}</code>}
      </div>
      <fieldset className="group98">
        <legend>Recent transfers</legend>
        <OrderList orders={orders} onOpen={onOpen} />
      </fieldset>
    </Window>
  );
}
