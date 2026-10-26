import { estimate, feeUsd, pctText, useFeeAmount, useFees } from '../lib/fees';
import { minimumFor, usdText, useMinimums } from '../lib/minimums';
import type { PathOptions } from '../lib/moneyPath';
import { throughMonero, type SendOptions } from '../lib/sendOptions';
import type { Coin, Fees, Minimums } from '../types';
import { ShieldIcon, WarnIcon } from './art';
import { DelaySlider } from './DelaySlider';
import { Tip } from './Tip';

/** The highest "send at least" across the coin buttons (they share one set of Send options). */
export function safeForAll(m: Minimums | null, o: SendOptions): number | null {
  const all = (['BTC', 'ETH', 'XMR'] as Coin[]).map((c) => minimumFor(m, c, o)?.safe).filter((v): v is number => v !== undefined);
  return all.length ? Math.max(...all) : null;
}

/**
 * How much to send for these options: the minimum (every piece is its own FixedFloat swap, so pieces raise it) and
 * what we suggest, with room for prices and fees to move. For one coin, or for every coin button.
 */
export function MinimumNote({ m, o, coin }: { m: Minimums | null; o: SendOptions; coin?: Coin }) {
  const coins = coin ? [coin] : (['BTC', 'ETH', 'XMR'] as Coin[]);
  const rows = coins.map((c) => ({ c, v: minimumFor(m, c, o) })).filter((r) => r.v);
  if (!rows.length) return null;
  const top = rows.reduce((a, b) => (b.v!.min > a.v!.min ? b : a));
  const why =
    o.pieces > 1
      ? `Each of the ${o.pieces} pieces is its own FixedFloat swap, so the minimum is about ${usdText(top.v!.min)}${throughMonero(o, top.c) ? ' (and about $110 to get into Monero)' : ''}.`
      : `FixedFloat's minimum is about ${usdText(top.v!.min)}.`;
  const less = top.v!.single !== null ? ` Less goes in fewer pieces; below about ${usdText(top.v!.single)} it waits for more.` : ' Less waits for more (or, at a FixedFloat address, is sent back).';
  return (
    <div className="min-note" role="note">
      <WarnIcon size={16} />
      <p>
        Send ≥{' '}
        {rows.length === 1 ? (
          <b>{usdText(rows[0].v!.safe)}</b>
        ) : (
          rows.map((r, i) => (
            <span key={r.c}>
              {i ? ' · ' : ''}
              {r.c} <b>{usdText(r.v!.safe)}</b>
            </span>
          ))
        )}
        <Tip tip={`${why}${less} Prices and fees move, so this leaves some room.`} />
      </p>
    </div>
  );
}

/** The highest estimated loss across `coins` for these options (the coin buttons share one set of Send options). */
function lossFor(fees: Fees | null, amount: number, coins: Coin[], o: SendOptions, entry: PathOptions['entry']): number {
  return Math.max(...coins.map((c) => estimate({ coin: c, route: o.route, delayHours: o.delayHours, pieces: o.pieces, entry }, fees, amount).pct));
}

/** Roughly what these options lose on the way, per coin, with a way into the full picture. */
export function FeeNote({ o, coin, entry, onExplain }: { o: SendOptions; coin?: Coin; entry: PathOptions['entry']; onExplain?(): void }) {
  const fees = useFees();
  const [amount] = useFeeAmount();
  const coins = coin ? [coin] : (['BTC', 'ETH', 'XMR'] as Coin[]);
  const rows = coins.map((c) => ({ c, e: estimate({ coin: c, route: o.route, delayHours: o.delayHours, pieces: o.pieces, entry }, fees, amount) }));
  return (
    <div className="min-note fee-note" role="note">
      <span className="fee-note-mark" aria-hidden="true">
        %
      </span>
      <p>
        Lose ≈{' '}
        {rows.map((r, i) => (
          <span key={r.c}>
            {i ? ' · ' : ''}
            {rows.length > 1 ? `${r.c} ` : ''}
            <b>{pctText(r.e.pct)}</b>
            {rows.length === 1 ? ` (${feeUsd(r.e.usd)})` : ''}
          </span>
        ))}{' '}
        on ${amount.toLocaleString('en-US')}
        <Tip tip={`FixedFloat's cut for each swap plus the network fee for each transaction your server makes${fees ? ', at today’s rates' : ' (typical numbers: today’s weren’t available)'}. Through Monero swaps twice; each piece is its own swap and its own transaction. The amount is set in How it works.`} />
        {onExplain && (
          <>
            {' '}
            <button type="button" className="link-btn" onClick={onExplain}>
              See where it goes
            </button>
          </>
        )}
      </p>
    </div>
  );
}

interface Props {
  value: SendOptions;
  onChange(o: SendOptions): void;
  delays: number[];
  piecesMax?: number;
  /** The VPS Monero wallet is connected. */
  moneroOk: boolean;
  /** The Bitcoin/Ethereum hot wallet is unlocked (a wait or pieces without Monero needs it). */
  walletOk?: boolean;
  /** For one coin (a permanent address); unset on the main window, where it applies to every coin button. */
  coin?: Coin;
  /** What the destination is paid in ("USDC"). */
  sym?: string;
  /** A coin button's address, or a permanent one (the default when `coin` is set). */
  entry?: PathOptions['entry'];
  /** The "Lose ≈ x%" line under the options (How it works shows its own). */
  showFees?: boolean;
  /** Opens How it works with these options. */
  onExplain?(): void;
}

/** Route, wait and pieces: the same three choices on the main window and for a permanent address. */
export function SendOptionsFields({ value: o, onChange, delays, piecesMax = 4, moneroOk, walletOk = true, coin, sym = 'USDC', entry = coin ? 'permanent' : 'button', showFees = true, onExplain }: Props) {
  const minimums = useMinimums();
  const fees = useFees();
  const [amount] = useFeeAmount();
  const loss = (patch: Partial<SendOptions>) => <small className="seg-fee">≈ {pctText(lossFor(fees, amount, coin ? [coin] : ['BTC', 'ETH', 'XMR'], { ...o, ...patch }, entry))}</small>;
  const set = (patch: Partial<SendOptions>) => onChange({ ...o, ...patch });
  const isXmr = coin === 'XMR';
  const monero = o.route === 'monero' && !isXmr;
  const holds = Boolean(o.delayHours) || o.pieces > 1;
  return (
    <div className="sendopts">
      {!isXmr && (
        <fieldset className="group98">
          <legend>
            Route
            {monero && <Tip tip="Swapped to Monero first and held in your own wallet. FixedFloat only swaps about $110 or more into Monero." />}
            {!monero && holds && <Tip tip={`${coin ? 'Payments land' : 'With a wait or pieces, the coin buttons give you a one-time address: the payment lands'} in your server's own wallet first, then goes on.`} />}
          </legend>
          <div className="seg98" role="radiogroup" aria-label="Route">
            <button type="button" role="radio" aria-checked={!monero} className={`btn98 seg-btn has-fee ${!monero ? 'is-pressed' : ''}`} onClick={() => set({ route: 'direct' })}>
              <span>Straight to {sym}</span>
              {loss({ route: 'direct' })}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={monero}
              className={`btn98 seg-btn has-fee ${monero ? 'is-pressed' : ''}`}
              onClick={() => set({ route: 'monero' })}
              disabled={!moneroOk}
              title={moneroOk ? undefined : "The VPS Monero wallet isn't connected (MONERO_RPC_URL)"}
            >
              <span>
                <ShieldIcon size={18} /> Through Monero
              </span>
              {loss({ route: 'monero' })}
            </button>
          </div>
        </fieldset>
      )}

      <fieldset className="group98">
        <legend>
          Wait{monero || isXmr ? ' in Monero' : ''}: <b>{o.delayHours ? `${o.delayHours} h` : 'none'}</b>
          {o.delayHours > 0 && <Tip tip="Plus a random extra of up to 30 minutes, so its length isn't a fingerprint." />}
        </legend>
        <DelaySlider value={o.delayHours} delays={delays} onChange={(h) => set({ delayHours: h })} />
      </fieldset>

      <fieldset className="group98">
        <legend>
          Pieces: <b>{o.pieces}</b>
          {o.pieces > 1 && (
            <Tip
              tip={
                monero || isXmr
                  ? "Split inside Monero, where the pieces can't be linked. Each goes 5 min–2 h after the last, in random, unequal amounts. Each pays its own fees."
                  : `5 min–2 h apart, in random, unequal amounts: hidden from ${coin ? 'the destination' : 'Coinbase'}, but still linked on-chain (use Through Monero${coin ? '' : ' or pay in Monero'} for that). Each pays its own fees.`
              }
            />
          )}
        </legend>
        <div className="seg98 pieces98" role="radiogroup" aria-label="Pieces">
          {Array.from({ length: piecesMax }, (_, i) => i + 1).map((n) => (
            <button key={n} type="button" role="radio" aria-checked={o.pieces === n} className={`btn98 seg-btn has-fee ${o.pieces === n ? 'is-pressed' : ''}`} onClick={() => set({ pieces: n })}>
              <span>{n}</span>
              {loss({ pieces: n })}
            </button>
          ))}
        </div>
      </fieldset>

      <MinimumNote m={minimums} o={o} coin={coin} />
      {showFees && <FeeNote o={o} coin={coin} entry={entry} onExplain={onExplain} />}
      {!monero && holds && !walletOk && coin !== 'XMR' && (
        <p className="error-text">
          Needs the hot wallet <Tip tip="A wait or pieces on Bitcoin and Ethereum needs the hot wallet on the server (WALLET_KEY and wallet:init)." />
        </p>
      )}
    </div>
  );
}
