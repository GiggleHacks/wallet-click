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
  privacy?: { delays: number[]; testDelayMin: number | null };
  version: string;
}

/** A saved USDT (ERC-20) payout address. */
export interface Destination {
  id: string;
  label: string;
  address: string;
  createdAt: number;
  builtIn?: boolean;
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
  /** What comes out ('USDT' or 'XMR') and the name of where it goes ("Coinbase"). */
  toCcy?: 'USDT' | 'XMR';
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
  updatedAt: number;
}

export type TransferState = 'collect' | 'open1' | 'send1' | 'swap1' | 'xmr-in' | 'churn' | 'wait' | 'open2' | 'send2' | 'swap2' | 'done' | 'refunded';
export type TransferStage = 'waiting' | 'received' | 'swapping' | 'holding' | 'sending' | 'done' | 'refunded' | 'expired' | 'attention';

export interface TransferStep {
  key: string;
  label: string;
  status: 'done' | 'active' | 'pending' | 'failed';
  detail: string | null;
  link: string | null;
}

/** A Privacy Enhanced transfer, or a payment that came in through a permanent address. */
export interface Transfer {
  id: string;
  createdAt: number;
  coin: Coin;
  coinName: string;
  privacy: boolean;
  delayHours: number | null;
  routeId: string | null;
  routeLabel: string | null;
  destinationId: string;
  destinationLabel: string;
  destinationAddress: string;
  state: TransferState;
  stage: TransferStage;
  received: string | null;
  usdt: string | null;
  payoutTxUrl: string | null;
  releaseAt: number | null;
  unlockedAt: number | null;
  xmr: string | null;
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
  destinationId: string;
  destinationLabel: string;
  destinationAddress: string;
  address: string;
  createdAt: number;
  archived: boolean;
}

export interface Quote {
  coin: Coin;
  amount: string;
  usdtEstimate: string;
  minAmount: string;
  minUsd: number;
}
