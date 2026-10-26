import { useMemo, useState } from 'react';
import { CoinIcon, HouseIcon, PlayIcon } from '../components/art';
import { MoneyMap } from '../components/MoneyMap';
import { SendOptionsFields } from '../components/SendOptions';
import { Tip } from '../components/Tip';
import { ModalLayer, Window } from '../components/Win98';
import { compareGrid, estimate, feeUsd, pctText, useFeeAmount, useFees } from '../lib/fees';
import { moneyPath, type PathOptions } from '../lib/moneyPath';
import { saveSendOptions, type SendOptions } from '../lib/sendOptions';
import { sfx } from '../lib/sound';
import type { Coin } from '../types';

interface Props {
  /** Starts from these (your saved Send options). */
  initial: SendOptions;
  delays: number[];
  piecesMax?: number;
  moneroOk: boolean;
  walletOk: boolean;
  /** Where the USDC goes ("Coinbase"). */
  dest: string;
  sym?: string;
  onAnimations(): void;
  onClose(): void;
}

const COINS: Coin[] = ['BTC', 'ETH', 'XMR'];

/** "How it works": set the options, watch where the money goes and who holds it, and see what it costs. Nothing is sent. */
export function HowItWorks({ initial, delays, piecesMax = 4, moneroOk, walletOk, dest, sym = 'USDC', onAnimations, onClose }: Props) {
  const [o, setO] = useState<SendOptions>(initial);
  const [coin, setCoin] = useState<Coin>('BTC');
  const [entry, setEntry] = useState<PathOptions['entry']>('button');
  const [amount, setAmount] = useFeeAmount();
  const [amountText, setAmountText] = useState(String(amount));
  const fees = useFees();
  const opts: PathOptions = { coin, route: o.route, delayHours: o.delayHours, pieces: o.pieces, entry, dest };
  const path = useMemo(() => moneyPath(opts), [coin, o.route, o.delayHours, o.pieces, entry, dest]); // eslint-disable-line react-hooks/exhaustive-deps
  const cost = estimate(opts, fees, amount);
  const grid = compareGrid(opts, fees, amount, piecesMax);
  const changed = entry === 'button' && (o.route !== initial.route || o.delayHours !== initial.delayHours || o.pieces !== initial.pieces);
  const seg = <T extends string>(value: T, current: T, set: (v: T) => void, label: React.ReactNode) => (
    <button type="button" role="radio" aria-checked={value === current} className={`btn98 seg-btn ${value === current ? 'is-pressed' : ''}`} onClick={() => (sfx.tap(), set(value))}>
      {label}
    </button>
  );

  return (
    <ModalLayer>
      <Window title="How it works" icon={<PlayIcon size={16} />} onClose={onClose} className="win-how" role="dialog">
        <p className="line-sub how-intro">
          Pick the options, then watch where the money goes, who holds it, and what it costs. <Tip tip="Nothing is sent and nothing is created. The times are examples: the real waits between pieces are random." />
        </p>

        <div className="how-settings">
          <fieldset className="group98">
            <legend>Paid to</legend>
            <div className="seg98" role="radiogroup" aria-label="Paid to">
              {seg('button', entry, setEntry, 'A coin button')}
              {seg(
                'permanent',
                entry,
                setEntry,
                <>
                  <HouseIcon size={16} /> Permanent address
                </>,
              )}
            </div>
          </fieldset>
          <fieldset className="group98">
            <legend>Coin and amount</legend>
            <div className="how-coin-row">
              <div className="seg98" role="radiogroup" aria-label="Coin">
                {COINS.map((c) =>
                  seg(
                    c,
                    coin,
                    setCoin,
                    <>
                      <CoinIcon coin={c} size={16} /> {c}
                    </>,
                  ),
                )}
              </div>
              <label className="how-amount">
                $
                <input
                  className="input98"
                  inputMode="decimal"
                  value={amountText}
                  onChange={(e) => {
                    setAmountText(e.target.value);
                    const v = Number(e.target.value.replace(/[$,\s]/g, ''));
                    if (Number.isFinite(v) && v > 0 && v < 10_000_000) setAmount(v);
                  }}
                  aria-label="Amount in dollars"
                />
              </label>
            </div>
          </fieldset>
          <SendOptionsFields value={o} onChange={setO} delays={delays} piecesMax={piecesMax} moneroOk={moneroOk} walletOk={walletOk} coin={coin} entry={entry} sym={sym} showFees={false} />
        </div>

        <p className="how-summary">
          <b>{path.summary}</b>
        </p>
        <MoneyMap path={path} amountUsd={amount} dest={dest} />

        <div className="how-fees">
          <fieldset className="group98">
            <legend>
              What it costs on <b>${amount.toLocaleString('en-US')}</b>
              <Tip tip="FixedFloat's cut for every swap and the network fee for every transaction your server makes, from today's rates. An estimate: rates move, and FixedFloat measures its cut on a small amount." />
            </legend>
            <table className="fee-table">
              <tbody>
                {cost.lines.map((l) => (
                  <tr key={l.label}>
                    <td>
                      {l.label}
                      {l.count > 1 && <span className="fee-count"> ×{l.count}</span>}
                      {l.typical && <span className="fee-typical" title="Today's number wasn't available: a typical one"> *</span>}
                    </td>
                    <td className="num">{feeUsd(l.usd)}</td>
                    <td className="num">{pctText(l.pct)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>You lose about</td>
                  <td className="num">{feeUsd(cost.usd)}</td>
                  <td className="num">{pctText(cost.pct)}</td>
                </tr>
              </tfoot>
            </table>
            <ul className="fee-notes">
              {path.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              {cost.typical && <li>* A typical number: today’s wasn’t available.</li>}
            </ul>
          </fieldset>

          <fieldset className="group98">
            <legend>Compare: what you lose</legend>
            <table className="fee-grid">
              <thead>
                <tr>
                  <th />
                  {Array.from({ length: piecesMax }, (_, i) => (
                    <th key={i}>
                      {i + 1} piece{i ? 's' : ''}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.map((row) => (
                  <tr key={row.route}>
                    <th>{row.route === 'monero' ? 'Through Monero' : coin === 'XMR' ? 'Monero' : `Straight to ${sym}`}</th>
                    {row.pcts.map((pct, i) => {
                      const on = (coin === 'XMR' || row.route === o.route) && o.pieces === i + 1;
                      const off = row.route === 'monero' && !moneroOk;
                      return (
                        <td key={i}>
                          <button
                            type="button"
                            className={`btn98 fee-cell ${on ? 'is-pressed' : ''}`}
                            disabled={off}
                            aria-pressed={on}
                            onClick={() => (sfx.tap(), setO({ ...o, route: row.route, pieces: i + 1 }))}
                          >
                            {pctText(pct)}
                            <small>{feeUsd((pct / 100) * amount)}</small>
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="line-sub">
              {coin === 'XMR'
                ? 'Monero is private already: pieces only add pennies of Monero fees.'
                : 'Through Monero means two swaps, so about twice FixedFloat’s cut. More pieces mean more transactions, which costs most on Bitcoin.'}{' '}
              The wait costs nothing.
            </p>
          </fieldset>
        </div>

        <div className="btn-row">
          {changed && (
            <button
              type="button"
              className="btn98"
              onClick={() => {
                saveSendOptions(o);
                sfx.tap();
                onClose();
              }}
            >
              Use these as my Send options
            </button>
          )}
          <button type="button" className="btn98" onClick={onAnimations}>
            <PlayIcon size={16} /> Animations…
          </button>
          <button type="button" className="btn98 is-default" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </Window>
    </ModalLayer>
  );
}
