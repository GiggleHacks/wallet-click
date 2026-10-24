import fs from 'node:fs';
import path from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** EIP-55: a mixed-case Ethereum address carries its own checksum, which catches typos. */
export function isChecksumAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const lower = address.slice(2).toLowerCase();
  const hash = bytesToHex(keccak_256(utf8ToBytes(lower)));
  const expected = [...lower].map((c, i) => (parseInt(hash[i], 16) >= 8 ? c.toUpperCase() : c)).join('');
  return address.slice(2) === expected;
}

/**
 * LEGACY: the Coinbase USDT (ERC-20) deposit address that payouts used before USDC on Base. New payouts never go
 * here; it is only used to read old records and to keep finishing transfers that were started with it.
 */
const payoutAddress = env.PAYOUT_ADDRESS?.trim() || '';
if (payoutAddress && !isChecksumAddress(payoutAddress)) {
  throw new Error(`PAYOUT_ADDRESS "${payoutAddress}" is not a valid checksummed Ethereum address. Copy it again from Coinbase.`);
}
/** The Coinbase USDC-on-Base deposit address: the built-in destination, and where every swap pays out by default. */
const payoutBaseAddress = env.PAYOUT_ADDRESS_USDC_BASE?.trim() || '';
if (!payoutBaseAddress) {
  throw new Error('PAYOUT_ADDRESS_USDC_BASE is not set. Put your own USDC-on-Base deposit address in .env (see .env.example).');
}
if (!isChecksumAddress(payoutBaseAddress)) {
  throw new Error(`PAYOUT_ADDRESS_USDC_BASE "${payoutBaseAddress}" is not a valid checksummed address. Copy it again from Coinbase.`);
}

export const COINS = {
  BTC: {
    code: 'BTC',
    name: 'Bitcoin',
    network: 'Bitcoin',
    /** What FixedFloat is asked to price when we only need its limits. */
    probeAmount: 0.001,
    blockMinutes: 10,
    explorerTx: (h: string) => `https://mempool.space/tx/${h}`,
  },
  ETH: {
    code: 'ETH',
    name: 'Ethereum',
    network: 'Ethereum mainnet',
    probeAmount: 0.05,
    blockMinutes: 0.2,
    explorerTx: (h: string) => `https://etherscan.io/tx/${h}`,
  },
  XMR: {
    code: 'XMR',
    name: 'Monero',
    network: 'Monero',
    probeAmount: 0.1,
    blockMinutes: 2,
    explorerTx: (h: string) => `https://xmrchain.net/tx/${h}`,
  },
} as const;
export type Coin = keyof typeof COINS;
export const COIN_IDS = Object.keys(COINS) as Coin[];

/**
 * What a FixedFloat order can pay out: a stablecoin (USDT on Ethereum, or USDC on Base) to a saved destination, or
 * XMR to one of our own subaddresses. The keys are FixedFloat's own currency codes, which name the network too.
 */
export const PAYOUTS = {
  USDT: { network: 'ETH', symbol: 'USDT', label: 'USDT on Ethereum', explorerTx: (h: string) => `https://etherscan.io/tx/${h}` },
  USDCBASE: { network: 'BASE', symbol: 'USDC', label: 'USDC on Base', explorerTx: (h: string) => `https://basescan.org/tx/${h}` },
  XMR: { network: 'XMR', symbol: 'XMR', label: 'Monero', explorerTx: (h: string) => `https://xmrchain.net/tx/${h}` },
} as const;
export type PayoutCcy = keyof typeof PAYOUTS;
/** The payouts that go to an address book destination (the others are our own Monero). */
export type Stable = 'USDT' | 'USDCBASE';
export const STABLES: readonly Stable[] = ['USDT', 'USDCBASE'];
/**
 * What a new payout can be. USDT on Ethereum is no longer offered, but older orders, transfers and permanent
 * addresses that already pay it keep working (they carry their own destination), so it stays a Stable.
 */
export const PAYOUT_CHOICES: readonly Stable[] = ['USDCBASE'];
/** Both are worth one US dollar here, for prices and costs. */
export const isStable = (c: string): c is Stable => c === 'USDT' || c === 'USDCBASE';

/** How long a payment waits before it goes on (hours). Privacy Enhanced: in Monero, between the two swaps. */
export const DELAYS = [0, 4, 12, 24, 42] as const;
/** A payment can go out in up to this many pieces, at random times. */
export const PIECES_MAX = 4;
/** Each piece is at least this many times FixedFloat's minimum: room for fees and prices moving while it waits. */
export const PIECE_MIN_FACTOR = 1.5;

const num = (v: string | undefined) => (v && Number.isFinite(Number(v)) ? Number(v) : null);

export const config = {
  host: env.HOST ?? '127.0.0.1',
  port: Number(env.PORT ?? 8787),
  dataDir: path.resolve(env.DATA_DIR ?? 'data'),
  /** Optional Host header allowlist (comma separated). Empty = accept any host. */
  allowedHosts: list(env.ALLOWED_HOSTS).map((h) => h.toLowerCase()),
  /** The login password. Hashed into data/auth.json at boot. */
  appPassword: env.APP_PASSWORD || null,
  cookieSecure: (env.COOKIE_SECURE ?? 'auto') as 'auto' | 'true' | 'false',
  /** "Remember this device": how long a sign-in lasts, renewed while it's used. */
  rememberDays: Number(env.REMEMBER_DAYS ?? 365),
  /** Without "remember": the sign-in ends after this many hours (or when the browser closes). */
  sessionHours: Number(env.SESSION_HOURS ?? 12),

  ff: {
    baseUrl: env.FF_API_URL ?? 'https://ff.io/api/v2',
    apiKey: env.FF_API_KEY ?? '',
    apiSecret: env.FF_API_SECRET ?? '',
  },

  /** Only used to find who paid, for automatic refunds of payments FixedFloat can't swap. */
  chains: {
    ethRpcUrls: list(env.ETH_RPC_URLS).length ? list(env.ETH_RPC_URLS) : ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
    /** Two independent Esplora APIs: refunds need both to agree on who paid. */
    btcApis: list(env.BTC_API_URLS).length ? list(env.BTC_API_URLS) : ['https://mempool.space/api', 'https://blockstream.info/api'],
  },

  payout: {
    address: payoutAddress,
    /** FixedFloat's code for USDT on Ethereum (ERC-20). */
    ccy: 'USDT',
    label: 'Coinbase',
    network: 'Ethereum (ERC-20)',
    explorerTx: (h: string) => `https://etherscan.io/tx/${h}`,
  },
  /** The built-in Coinbase destination: USDC on Base. */
  payoutBase: { address: payoutBaseAddress, ccy: 'USDCBASE' as const, label: 'Coinbase (USDC on Base)', network: 'Base' },

  /** The VPS's monero-wallet-rpc. Unset = Monero wallet features (Privacy Enhanced, permanent XMR addresses) are off. */
  monero: {
    rpcUrl: env.MONERO_RPC_URL?.trim() || null,
    user: env.MONERO_RPC_USER || null,
    password: env.MONERO_RPC_PASSWORD || null,
    /** The wallet account Wallet Click keeps to itself (created on first use). Never account 0. */
    accountLabel: env.MONERO_ACCOUNT_LABEL?.trim() || 'wallet-click',
  },

  /** Unlocks data/wallet.enc (the BTC/ETH hot wallet seed). Unset = permanent BTC/ETH addresses are off. */
  walletKey: env.WALLET_KEY || null,

  /** Testing only: every wait is this many minutes instead of the chosen hours (and pieces are seconds apart). */
  privacyTestDelayMin: num(env.PRIVACY_TEST_DELAY_MIN),
};
