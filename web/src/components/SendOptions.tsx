import { minimumFor, usdText, useMinimums } from '../lib/minimums';
import { throughMonero, type SendOptions } from '../lib/sendOptions';
import type { Coin, Minimums } from '../types';
import { ShieldIcon, WarnIcon } from './art';
import { DelaySlider } from './DelaySlider';

const NAME: Record<Coin, string> = { BTC: 'Bitcoin', ETH: 'Ethereum', XMR: 'Monero' };

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
      <WarnIcon size={18} />
      <p>
        To be safe, send at least{' '}
        {rows.length === 1 ? (
          <b>{usdText(rows[0].v!.safe)}</b>
        ) : (
          rows.map((r, i) => (
            <span key={r.c}>
              {i ? ' · ' : ''}
              {NAME[r.c]} <b>{usdText(r.v!.safe)}</b>
            </span>
          ))
        )}
        .{' '}
        <span className="line-sub">
          {why}
          {less} Prices and fees move, so leave some room.
        </span>
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
}

/** Route, wait and pieces: the same three choices on the main window and for a permanent address. */
export function SendOptionsFields({ value: o, onChange, delays, piecesMax = 4, moneroOk, walletOk = true, coin }: Props) {
  const minimums = useMinimums();
  const set = (patch: Partial<SendOptions>) => onChange({ ...o, ...patch });
  const isXmr = coin === 'XMR';
  const monero = o.route === 'monero' && !isXmr;
  const holds = Boolean(o.delayHours) || o.pieces > 1;
  return (
    <div className="sendopts">
      {!isXmr && (
        <fieldset className="group98">
          <legend>Route</legend>
          <div className="seg98" role="radiogroup" aria-label="Route">
            <button type="button" role="radio" aria-checked={!monero} className={`btn98 seg-btn ${!monero ? 'is-pressed' : ''}`} onClick={() => set({ route: 'direct' })}>
              Straight to USDT
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={monero}
              className={`btn98 seg-btn ${monero ? 'is-pressed' : ''}`}
              onClick={() => set({ route: 'monero' })}
              disabled={!moneroOk}
              title={moneroOk ? undefined : "The VPS Monero wallet isn't connected (MONERO_RPC_URL)"}
            >
              <ShieldIcon size={18} /> Through Monero
            </button>
          </div>
        </fieldset>
      )}

      <fieldset className="group98">
        <legend>
          Wait {monero || isXmr ? 'in Monero' : 'before it goes on'}: <b>{o.delayHours ? `${o.delayHours} hours` : 'none'}</b>
        </legend>
        <DelaySlider value={o.delayHours} delays={delays} onChange={(h) => set({ delayHours: h })} />
      </fieldset>

      <fieldset className="group98">
        <legend>
          Send in: <b>{o.pieces === 1 ? 'one piece' : `${o.pieces} pieces`}</b>
        </legend>
        <div className="seg98 pieces98" role="radiogroup" aria-label="Pieces">
          {Array.from({ length: piecesMax }, (_, i) => i + 1).map((n) => (
            <button key={n} type="button" role="radio" aria-checked={o.pieces === n} className={`btn98 seg-btn ${o.pieces === n ? 'is-pressed' : ''}`} onClick={() => set({ pieces: n })}>
              {n}
            </button>
          ))}
        </div>
      </fieldset>

      <ul className="hints">
        {monero && (
          <li>
            Swapped to <b>Monero</b> first and held in your own wallet. FixedFloat only swaps <b>about $110 or more</b> into Monero.
          </li>
        )}
        {!monero && holds && !isXmr && <li>{coin ? 'Payments land' : 'With a wait or pieces, the coin buttons give you a one-time address: the payment lands'} in your server's own wallet first, then goes on.</li>}
        {o.delayHours > 0 && <li>The wait gets a random extra of up to 30 minutes, so its length isn't a fingerprint.</li>}
        {o.pieces > 1 && (monero || isXmr) && <li>Split inside Monero, where the pieces can't be linked to each other. Each one goes 5 min–2 h after the one before has finished, in a random, unequal amount.</li>}
        {o.pieces > 1 && !monero && !isXmr && (
          <li>
            Pieces go 5 min–2 h apart, in random, unequal amounts. That hides the amounts and the timing from {coin ? 'the destination' : 'Coinbase'}, but on the blockchain the pieces are still linked:
            for that, use <b>Through Monero</b>{coin ? '' : ' (or pay in Monero)'}.
          </li>
        )}
        {o.pieces > 1 && <li>Each piece pays its own FixedFloat and network fees.</li>}
      </ul>
      <MinimumNote m={minimums} o={o} coin={coin} />
      {!monero && holds && !walletOk && coin !== 'XMR' && (
        <p className="error-text">A wait or pieces on Bitcoin and Ethereum needs the hot wallet on the server (WALLET_KEY and wallet:init).</p>
      )}
    </div>
  );
}
