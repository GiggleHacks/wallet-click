import type { Coin } from '../types';

/**
 * "How it works": where a payment's money really is, moment by moment, for a set of Send options. It follows what
 * the server does (the big comment at the top of server/transfers.ts is the source of truth; keep the two in step):
 *
 *  - a coin button with no wait and one piece: a FixedFloat deposit address. The money never touches the server.
 *  - straight, with a wait or pieces, or any permanent address: an address of the server's own wallet first.
 *      Bitcoin pieces: one split transaction to a fresh change address per piece, each forwarded on its own.
 *      Ethereum pieces: no split; each share is forwarded from the same address, one after another.
 *  - through Monero: swapped to XMR into a fresh vault subaddress, unlocked, moved once (to one fresh subaddress, or
 *    one per piece), each piece moved once more on its own, then the wait, then a swap to USDC per piece.
 *  - a Monero payment with a wait or pieces: its own one-time subaddress is the vault, then the same.
 * Piece 1 goes when the wait is over; each later one a random 5 min–2 h after the one before has landed.
 *
 * The times are examples (the real random parts are random); `txs` lists every transaction, for the fee estimate.
 */

export type Holder = 'you' | 'fixedfloat' | 'server' | 'exchange';
export type Token = Coin | 'USDC';
export type ColumnKind = 'wallet' | 'address' | 'vault' | 'swap' | 'dest';

export interface PathOptions {
  coin: Coin;
  route: 'direct' | 'monero';
  delayHours: number;
  pieces: number;
  /** A coin button's address, or one of your permanent addresses. */
  entry: 'button' | 'permanent';
  /** Where the USDC goes. */
  dest?: string;
}

export interface Column {
  key: string;
  kind: ColumnKind;
  /** One stop per piece (drawn as lanes), or one stop everything passes through. */
  lanes: boolean;
  label: string;
  sub: string;
  holder: Holder;
  tip: string;
}

/** One stretch of one piece's journey: staying at a column, or travelling from one column to the next. */
export interface Leg {
  lane: number;
  from: number;
  to: number;
  start: number;
  end: number;
  coin: Token;
  kind: 'travel' | 'stay' | 'wait' | 'swap' | 'hop';
  caption: string;
}

export type Tx =
  | { kind: 'swap'; from: Coin; to: 'USDC' | 'XMR'; share: number }
  | { kind: 'forward'; coin: Coin; count: number }
  | { kind: 'split'; coin: 'BTC'; pieces: number }
  | { kind: 'xmr'; count: number };

export interface MoneyPath {
  columns: Column[];
  legs: Leg[];
  /** Each piece's share of the money (unequal on purpose, like the real ones). */
  shares: number[];
  /** When the last piece has landed. */
  end: number;
  txs: Tx[];
  notes: string[];
  /** One line: where it waits. */
  summary: string;
}

const MIN = 60_000;
const H = 60 * MIN;
/** About how long a payment takes to confirm (FixedFloat's or the server's confirmations). */
const CONFIRM: Record<Coin, number> = { BTC: 20 * MIN, ETH: 3 * MIN, XMR: 20 * MIN };
const SWAP = 10 * MIN;
const PAYOUT = 2 * MIN;
const XMR_MOVE = 2 * MIN;
/** Ten blocks before Monero can move again. */
const UNLOCK = 20 * MIN;
/** An example of the random extra on a wait (up to 30 minutes). */
const JITTER = 12 * MIN;
/** Examples of the random 5 min–2 h between pieces. */
const GAPS = [0, 47 * MIN, 86 * MIN, 18 * MIN];
const SHARES: Record<number, number[]> = { 1: [1], 2: [0.57, 0.43], 3: [0.38, 0.27, 0.35], 4: [0.31, 0.22, 0.28, 0.19] };

const NAME: Record<Coin, string> = { BTC: 'Bitcoin', ETH: 'Ethereum', XMR: 'Monero' };
const hours = (h: number) => `${h} hour${h === 1 ? '' : 's'}`;

export function moneyPath(o: PathOptions): MoneyPath {
  const { coin, entry } = o;
  const n = Math.min(4, Math.max(1, Math.round(o.pieces)));
  const dest = o.dest ?? 'Coinbase';
  const viaMonero = o.route === 'monero' && coin !== 'XMR';
  const xmrHeld = coin === 'XMR' && (o.delayHours > 0 || n > 1);
  const moneroPath = viaMonero || xmrHeld;
  /** It lands at an address of the server's own wallet first. */
  const serverIn = entry === 'permanent' || xmrHeld || (!viaMonero && (o.delayHours > 0 || n > 1));
  const wait = o.delayHours * H + (o.delayHours ? JITTER : 0);
  const shares = SHARES[n];
  const piece = (k: number) => (n > 1 ? `Piece ${k + 1} of ${n}` : 'It');

  const columns: Column[] = [];
  const add = (c: Column) => columns.push(c) - 1;
  const ff = (from: Token, to: Token, lanes: boolean): Column => ({
    key: `ff-${from}-${to}`,
    kind: 'swap',
    lanes,
    label: 'FixedFloat',
    sub: `${from} → ${to}`,
    holder: 'fixedfloat',
    tip: lanes ? `Every piece is its own FixedFloat order, at its own fresh deposit address. FixedFloat holds each piece only while it swaps it.` : 'A fresh FixedFloat deposit address. FixedFloat holds the money only while it swaps it.',
  });
  const own = (lanes: boolean, label: string, sub: string, tip: string, kind: ColumnKind = 'address'): Column => ({ key: `own-${columns.length}`, kind, lanes, label, sub, holder: 'server', tip });

  const cYou = add({ key: 'you', kind: 'wallet', lanes: false, label: 'Your wallet', sub: NAME[coin], holder: 'you', tip: 'Where you send from: your phone, an exchange, anyone paying you.' });
  const legs: Leg[] = [];
  const txs: Tx[] = [];
  const lane = (k: number) => {
    let t = 0;
    let at = cYou;
    return {
      get t() {
        return t;
      },
      get at() {
        return at;
      },
      go(to: number, ms: number, coinNow: Token, caption: string) {
        legs.push({ lane: k, from: at, to, start: t, end: t + ms, coin: coinNow, kind: 'travel', caption });
        t += ms;
        at = to;
      },
      stay(ms: number, coinNow: Token, kind: Leg['kind'], caption: string) {
        if (ms <= 0) return;
        legs.push({ lane: k, from: at, to: at, start: t, end: t + ms, coin: coinNow, kind, caption });
        t += ms;
      },
      until(when: number, coinNow: Token, kind: Leg['kind'], caption: string) {
        this.stay(when - t, coinNow, kind, caption);
      },
    };
  };
  type Lane = ReturnType<typeof lane>;
  const lanes: Lane[] = shares.map((_, k) => lane(k));
  const all = (fn: (l: Lane, k: number) => void) => lanes.forEach(fn);
  /** When piece k may go: piece 1 at `first`, each later one a random pause after the one before has landed. */
  const releaseOf = (k: number, first: number, landed: number[]) => (k === 0 ? first : Math.max(first + GAPS.slice(1, k + 1).reduce((s, g) => s + g, 0), landed[k - 1] + GAPS[k]));

  let summary: string;
  const notes = ["Your own wallet's fee for sending the payment isn't counted."];

  if (!serverIn && !viaMonero) {
    // A plain FixedFloat address: no wait, no pieces, the server never holds it.
    const cSwap = add(ff(coin, 'USDC', false));
    const cDest = add({ key: 'dest', kind: 'dest', lanes: false, label: dest, sub: 'USDC', holder: 'exchange', tip: `Your ${dest} account.` });
    const l = lanes[0];
    l.go(cSwap, CONFIRM[coin], coin, `You send ${coin} straight to a fresh FixedFloat address. It confirms on the ${NAME[coin]} network.`);
    l.stay(SWAP, coin, 'swap', `FixedFloat swaps the ${coin} to USDC.`);
    l.go(cDest, PAYOUT, 'USDC', `FixedFloat sends the USDC to ${dest}. Done.`);
    txs.push({ kind: 'swap', from: coin, to: 'USDC', share: 1 });
    summary = 'Straight to FixedFloat: your server never holds it.';
  } else if (!moneroPath) {
    // Straight, but held at an address of the server's own wallet first.
    const where = entry === 'permanent' ? 'your permanent address' : 'a one-time address';
    const cAddr = add(
      own(
        false,
        entry === 'permanent' ? 'Permanent address' : 'One-time address',
        `on your server · ${coin}`,
        `An address of your server's own ${NAME[coin]} wallet (its key is on your server). ${entry === 'permanent' ? 'The same address every time.' : 'Made fresh for this payment, watched for 30 days.'}`,
      ),
    );
    const btcSplit = coin === 'BTC' && n > 1;
    const cSplit = btcSplit ? add(own(true, 'Fresh change address', `on your server · one per piece`, 'One transaction splits the Bitcoin into a fresh address per piece, all in your own wallet.')) : -1;
    const cSwap = add(ff(coin, 'USDC', n > 1));
    const cDest = add({ key: 'dest', kind: 'dest', lanes: false, label: dest, sub: 'USDC', holder: 'exchange', tip: `Your ${dest} account. ${n > 1 ? 'The pieces arrive as unequal amounts at different times.' : ''}` });
    all((l) => l.go(cAddr, CONFIRM[coin], coin, `You send ${coin} to ${where} on your server. It confirms on the ${NAME[coin]} network.`));
    const confirmed = lanes[0].t;
    if (wait) all((l) => l.stay(wait, coin, 'wait', `It sits at ${where} on your server for ${hours(o.delayHours)}, plus a random few minutes.`));
    let first = confirmed + wait;
    if (btcSplit) {
      all((l) => l.go(cSplit, CONFIRM.BTC, 'BTC', `One Bitcoin transaction splits it into ${n} fresh addresses of your own, in unequal amounts.`));
      first = lanes[0].t;
    }
    const landed: number[] = [];
    lanes.forEach((l, k) => {
      const go = releaseOf(k, first, landed);
      l.until(go, coin, 'wait', btcSplit ? `${piece(k)} waits at its own address for its turn.` : `${piece(k)}'s share waits at ${where} for its turn.`);
      l.go(cSwap, CONFIRM[coin], coin, n > 1 ? `${piece(k)} is forwarded to its own FixedFloat order.` : 'Your server forwards it to a fresh FixedFloat order.');
      l.stay(SWAP, coin, 'swap', `FixedFloat swaps ${n > 1 ? `piece ${k + 1}` : 'it'} to USDC.`);
      l.go(cDest, PAYOUT, 'USDC', `${n > 1 ? `Piece ${k + 1} of ${n}` : 'The USDC'} lands at ${dest}.${n > 1 && k < n - 1 ? ' The next piece goes a random 5 min–2 h later.' : ' Done.'}`);
      landed.push(l.t);
    });
    if (btcSplit) txs.push({ kind: 'split', coin: 'BTC', pieces: n });
    if (coin === 'XMR') txs.push({ kind: 'xmr', count: n });
    else txs.push({ kind: 'forward', coin, count: n });
    shares.forEach((share) => txs.push({ kind: 'swap', from: coin, to: 'USDC', share }));
    if (n > 1 && coin !== 'XMR') notes.push(`The pieces are hidden from ${dest}, but still linked on the ${NAME[coin]} blockchain. Through Monero they can't be linked.`);
    summary = `Waits at ${where} on your server${btcSplit ? `, then in ${n} fresh addresses` : ''}.`;
  } else {
    // Through Monero (or a Monero payment with a wait or pieces): the server's Monero wallet holds it.
    const cPerm = viaMonero && entry === 'permanent' ? add(own(false, 'Permanent address', `on your server · ${coin}`, `An address of your server's own ${NAME[coin]} wallet. Whatever lands there is forwarded to FixedFloat.`)) : -1;
    const cIn = viaMonero ? add(ff(coin, 'XMR', false)) : -1;
    const cVault = add(
      own(
        false,
        'Monero vault',
        xmrHeld ? 'one-time subaddress' : 'fresh subaddress',
        `A fresh subaddress of your server's own Monero wallet. FixedFloat ${viaMonero ? 'pays the XMR here' : "isn't involved yet"}.`,
        'vault',
      ),
    );
    const cSubs = add(
      own(
        n > 1,
        'Fresh subaddress',
        n > 1 ? 'one per piece' : 'moved once',
        n > 1
          ? "One Monero transaction splits it into a fresh subaddress per piece; each piece moves once more on its own. Inside Monero the pieces can't be linked."
          : "It moves once more inside your wallet, so FixedFloat's own coins never go straight back to it.",
        'vault',
      ),
    );
    const cSwap = add(ff('XMR', 'USDC', n > 1));
    const cDest = add({ key: 'dest', kind: 'dest', lanes: false, label: dest, sub: 'USDC', holder: 'exchange', tip: `Your ${dest} account.` });

    if (viaMonero) {
      if (entry === 'permanent') {
        all((l) => l.go(cPerm, CONFIRM[coin], coin, `You send ${coin} to your permanent address on your server.`));
        all((l) => l.go(cIn, CONFIRM[coin], coin, `Your server forwards it to a fresh FixedFloat order (${coin} → XMR).`));
        txs.push({ kind: 'forward', coin, count: 1 });
      } else {
        all((l) => l.go(cIn, CONFIRM[coin], coin, `You send ${coin} to a fresh FixedFloat address. It confirms on the ${NAME[coin]} network.`));
      }
      all((l) => l.stay(SWAP, coin, 'swap', `FixedFloat swaps the ${coin} to Monero.`));
      all((l) => l.go(cVault, XMR_MOVE, 'XMR', "FixedFloat pays the XMR into a fresh vault subaddress of your server's Monero wallet."));
      txs.push({ kind: 'swap', from: coin, to: 'XMR', share: 1 });
    } else {
      all((l) => l.go(cVault, XMR_MOVE, 'XMR', 'You send XMR to a one-time subaddress of your server’s Monero wallet.'));
    }
    all((l) => l.stay(UNLOCK, 'XMR', 'stay', 'The XMR unlocks: 10 Monero blocks.'));
    const unlocked = lanes[0].t;
    all((l) => l.go(cSubs, XMR_MOVE, 'XMR', n > 1 ? `One Monero transaction splits it into ${n} fresh subaddresses, in unequal amounts.` : "It moves once more, to another fresh subaddress of yours, so FixedFloat's coins don't go straight back."));
    const churned = lanes[0].t;
    const first = Math.max(unlocked + wait, churned + UNLOCK);
    const landed: number[] = [];
    lanes.forEach((l, k) => {
      let go = releaseOf(k, first, landed);
      if (n > 1) {
        // Each piece moves once more on its own, at a random time before its turn.
        const hopAt = Math.max(churned + UNLOCK, Math.round((churned + go) / 2 / MIN) * MIN - XMR_MOVE);
        l.until(hopAt, 'XMR', 'wait', wait ? `Waiting in Monero: ${hours(o.delayHours)} from when it unlocked, plus a random few minutes.` : `${piece(k)} waits in its own subaddress.`);
        l.stay(XMR_MOVE, 'XMR', 'hop', `${piece(k)} moves once more on its own, to another fresh subaddress.`);
        go = Math.max(go, l.t + UNLOCK);
      }
      l.until(go, 'XMR', 'wait', k === 0 && wait ? `Waiting in Monero: ${hours(o.delayHours)} from when it unlocked, plus a random few minutes.` : `${piece(k)} waits in Monero for ${n > 1 ? 'its turn' : 'its time'}.`);
      l.go(cSwap, XMR_MOVE, 'XMR', n > 1 ? `${piece(k)} goes to its own FixedFloat order (XMR → USDC).` : 'Your server pays a fresh FixedFloat order (XMR → USDC).');
      l.stay(SWAP, 'XMR', 'swap', `FixedFloat swaps ${n > 1 ? `piece ${k + 1}` : 'the XMR'} to USDC.`);
      l.go(cDest, PAYOUT, 'USDC', `${n > 1 ? `Piece ${k + 1} of ${n}` : 'The USDC'} lands at ${dest}.${n > 1 && k < n - 1 ? ' The next piece goes a random 5 min–2 h later.' : ' Done.'}`);
      landed.push(l.t);
    });
    // The churn (or split), each piece's own move, and each send to FixedFloat.
    txs.push({ kind: 'xmr', count: 1 + (n > 1 ? n : 0) + n });
    shares.forEach((share) => txs.push({ kind: 'swap', from: 'XMR', to: 'USDC', share }));
    notes.push('While it waits in Monero, the XMR price can move up or down. That isn’t a fee, but what arrives can be more or less.');
    summary = `Waits in your server's Monero wallet${n > 1 ? `, split into ${n} fresh subaddresses` : ''}.`;
  }

  legs.sort((a, b) => a.start - b.start || a.lane - b.lane);
  return { columns, legs, shares, end: Math.max(...lanes.map((l) => l.t)), txs, notes, summary };
}

/** Where piece `lane` is at `t`: a column, or between two. `progress` is 0–1 along a travel leg. */
export interface Spot {
  lane: number;
  leg: Leg;
  progress: number;
}

export function spotsAt(p: MoneyPath, t: number): Spot[] {
  return p.shares.map((_, lane) => {
    const mine = p.legs.filter((l) => l.lane === lane);
    const leg = mine.find((l) => t >= l.start && t < l.end) ?? (t < mine[0].start ? mine[0] : mine[mine.length - 1]);
    const progress = leg.end > leg.start ? Math.min(1, Math.max(0, (t - leg.start) / (leg.end - leg.start))) : 1;
    return { lane, leg, progress: t >= p.end ? 1 : progress };
  });
}

/** The moments to mark on the timeline: each leg that starts something new (identical legs of several pieces count once). */
export function momentsOf(p: MoneyPath): { at: number; caption: string; lane: number }[] {
  const seen = new Set<string>();
  const out: { at: number; caption: string; lane: number }[] = [];
  for (const l of p.legs) {
    const key = `${l.start}|${l.caption}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ at: l.start, caption: l.caption, lane: l.lane });
  }
  out.push({ at: p.end, caption: 'Everything has arrived.', lane: -1 });
  return out;
}

/** "4 h 12 min", "35 min" on the map's clock. */
export function clockText(ms: number): string {
  const min = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(min / 60);
  return h ? `${h} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`;
}
