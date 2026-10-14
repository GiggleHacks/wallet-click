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

/** The user's Coinbase USDT (ERC-20) deposit address. Every swap pays out here and nowhere else. */
const payoutAddress = env.PAYOUT_ADDRESS?.trim() || '0x7E577e577e577E577e577E577E577E577e577E57';
if (!isChecksumAddress(payoutAddress)) {
  throw new Error(`PAYOUT_ADDRESS "${payoutAddress}" is not a valid checksummed Ethereum address. Copy it again from Coinbase.`);
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
} as const;
export type Coin = keyof typeof COINS;
export const COIN_IDS = Object.keys(COINS) as Coin[];

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
};
