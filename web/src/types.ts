export type Coin = 'BTC' | 'ETH' | 'XMR';
export type Stage = 'waiting' | 'received' | 'swapping' | 'sending' | 'done' | 'refunded' | 'expired' | 'attention';

export interface Status {
  ready: boolean;
  authed: boolean;
  lockedUntil: number;
  /** Lockout time left, relative (the browser's clock may differ from the server's). */
  retryAfterMs: number;
  triesLeft: number;
  version?: string;
}

export interface Meta {
  payout: { address: string; label: string; ccy: string; network: string };
  coins: Record<Coin, { name: string; network: string }>;
  swapConfigured: boolean;
  /** monero: the VPS Monero wallet is connected; wallet: the BTC/ETH hot wallet is unlocked. */
  features?: { monero: boolean; wallet?: boolean; seedBackupPending?: boolean; walletError?: string | null };
  privacy?: { delays: number[]; piecesMax?: number; testDelayMin: number | null };
  version: string;
}

/** What a destination is paid in: FixedFloat's currency code. */
export type Stable = 'USDT' | 'USDCBASE';

/** A saved payout address: USDT on Ethereum (ERC-20), or USDC on Base. */
export interface Destination {
  id: string;
  label: string;
  address: string;
  /** Older servers send none: USDT. */
  ccy?: Stable;
  createdAt: number;
  builtIn?: boolean;
}

/** Roughly what a finished swap cost: FixedFloat's cut plus network fees, in dollars and as a share of what went in. */
export interface Cost {
  usd: number;
  pct: number;
  inUsd: number;
  /** Privacy Enhanced: how much the Monero price moved while it waited (not a cost). */
  drift?: number;
}

export interface Order {
  id: string;
  coin: Coin;
  coinName: string;
  network: string;
  address: string;
  createdAt: number;
  stage: Stage;
  status: string;
  min: string;
  max: string | null;
  minUsd: number | null;
  /** How long the server keeps watching this address for late payments. */
  watchDays: number;
  expiresAt: number | null;
  received: string | null;
  /** When the server spotted the payment on-chain itself (before FixedFloat reported it). */
  seenAt: number | null;
  confirmations: number;
  requiredConfirmations: number | null;
  blockMinutes: number;
  depositTx: string | null;
  depositTxUrl: string | null;
  usdt: string | null;
  usdtFinal: boolean;
  payoutTx: string | null;
  payoutTxUrl: string | null;
  payoutAddress: string;
  /** What comes out ('USDT', 'USDCBASE' or 'XMR') and the name of where it goes ("Coinbase"). */
  toCcy?: Stable | 'XMR';
  payoutLabel?: string;
  destinationId?: string | null;
  transferId?: string | null;
  refundTx: string | null;
  refundTxUrl: string | null;
  /** Where a payment that couldn't be swapped is being sent back to. */
  refundTo: string | null;
  /** 'sender' = going back to the wallet that paid, 'manual' = an address the owner typed, 'own' = back to our own wallet. */
  refundSource: 'sender' | 'manual' | 'own' | null;
  /** Set when automatic refund isn't possible for this payment: the owner has to give an address. */
  autoRefundError: string | null;
  /** A temporary problem while sending a refund back; the server keeps retrying. */
  refundRetry: string | null;
  emergency: { flags: string[]; choice: string } | null;
  autoContinued: boolean;
  autoError: string | null;
  reusedAddress: boolean;
  pollError: string | null;
  cost?: Cost | null;
  updatedAt: number;
}

export type TransferState = 'collect' | 'hold' | 'split' | 'open1' | 'send1' | 'swap1' | 'xmr-in' | 'churn' | 'wait' | 'pieces' | 'open2' | 'send2' | 'swap2' | 'done' | 'refunded';
export type TransferStage = 'waiting' | 'received' | 'swapping' | 'holding' | 'sending' | 'done' | 'refunded' | 'expired' | 'attention';

export interface TransferStep {
  key: string;
  label: string;
  status: 'done' | 'active' | 'pending' | 'failed';
  detail: string | null;
  link: string | null;
}

/** One piece of a split payment. */
export interface Piece {
  id: string;
  n: number;
  of: number;
  /** What the piece holds: Monero for a split inside Monero, else the coin paid in. */
  coin: Coin;
  amount: string | null;
  stage: 'waiting' | 'sending' | 'done' | 'refunded' | 'attention';
  /** When it goes (null: once the piece before it has finished). */
  releaseAt: number | null;
  usdt: string | null;
  payoutTxUrl: string | null;
  attention: string | null;
  waitingFor: string | null;
}

/** A Privacy Enhanced transfer, or a payment that came in through a permanent (or one-time) address. */
export interface Transfer {
  id: string;
  createdAt: number;
  coin: Coin;
  coinName: string;
  privacy: boolean;
  /** What the destination is paid in. */
  payoutCcy?: Stable;
  /** The money waits in Monero (Privacy Enhanced, or a Monero payment with a wait or pieces). */
  monero?: boolean;
  delayHours: number | null;
  /** How many pieces it goes out in. */
  pieces?: number;
  routeId: string | null;
  routeLabel: string | null;
  /** Paid to a one-time address of our own wallet (a coin button with a wait or pieces). */
  oneTime?: boolean;
  destinationId: string;
  destinationLabel: string;
  destinationAddress: string;
  state: TransferState;
  stage: TransferStage;
  received: string | null;
  usdt: string | null;
  payoutTxUrl: string | null;
  releaseAt: number | null;
  /** A direct payment's wait started here (when it was confirmed). */
  heldAt?: number | null;
  unlockedAt: number | null;
  /** When the next piece goes. */
  nextPieceAt?: number | null;
  pieceList?: Piece[];
  /** Released early (the bomb still goes off). */
  released?: boolean;
  xmr: string | null;
  /** The XMR has reached the vault (it then unlocks over 10 blocks). */
  xmrArrived?: boolean;
  xmrConfirmations?: number;
  /** Roughly what it's worth in US dollars right now (the Monero held, or what was paid in). */
  usdValue?: number | null;
  cost?: Cost | null;
  steps: TransferStep[];
  attention: string | null;
  error: string | null;
  waitingFor: string | null;
  canRelease: boolean;
  canChangeDelay: boolean;
  canRetry: boolean;
  /** The FixedFloat orders (first swap, and the Monero → USDT one for Privacy Enhanced). */
  leg1: Order | null;
  leg2: Order | null;
  log: { at: number; text: string }[];
  updatedAt: number;
}

/** A permanent address. */
export interface Route {
  id: string;
  label: string;
  coin: Coin;
  coinName: string;
  mode: 'direct' | 'privacy';
  delayHours: number | null;
  pieces?: number;
  /** Made by a coin button for one payment (watched until expiresAt). */
  oneTime?: boolean;
  expiresAt?: number | null;
  destinationId: string;
  destinationLabel: string;
  destinationAddress: string;
  destinationCcy?: Stable;
  address: string;
  createdAt: number;
  archived: boolean;
}

/** FixedFloat's minimums in dollars: per coin straight to USDT and into Monero; each piece is at least pieceFactor × that. */
export interface Minimums {
  BTC: { direct: number | null; intoMonero: number | null };
  ETH: { direct: number | null; intoMonero: number | null };
  XMR: { direct: number | null; intoMonero: number | null };
  pieceFactor: number;
}

export interface Quote {
  coin: Coin;
  amount: string;
  usdtEstimate: string;
  minAmount: string;
  minUsd: number;
}

/** One line of the server's log (a message repeating straight away is one line with a count). */
export interface LogLine {
  id: number;
  run: number;
  count: number;
  at: number;
  first: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  detail?: string;
}
