export type Coin = 'BTC' | 'ETH';
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
  version: string;
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
  refundTx: string | null;
  refundTxUrl: string | null;
  /** Where a payment that couldn't be swapped is being sent back to. */
  refundTo: string | null;
  /** 'sender' = going back to the wallet that paid, 'manual' = an address the owner typed. */
  refundSource: 'sender' | 'manual' | null;
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
