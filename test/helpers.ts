import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import * as btc from '@scure/btc-signer';
import type { Transport } from '../server/fixedfloat.js';

/** A valid (bech32 P2WSH) Bitcoin address that nobody controls, different for every seed. */
export const btcAddress = (seed: number | string) => btc.Address(btc.NETWORK).encode({ type: 'wsh', hash: sha256(utf8ToBytes(`wc-test-${seed}`)) });

/** Where swaps pay out: Coinbase's USDC-on-Base deposit address (the built-in "Coinbase (USDC on Base)"). */
export const PAYOUT = '0xBA5eba5EBa5EbA5eBA5EBA5eBa5EBa5ebA5ebA5E';
export const PAYOUT_BASE = PAYOUT;
/** The old Coinbase USDT (ERC-20) address: no longer offered, but older records and permanent addresses still pay it. */
export const PAYOUT_USDT = '0x7E577e577e577E577e577E577E577E577e577E57';
/** A well-formed (fake) Monero subaddress: 8 + 94 base58 characters. */
export const xmrAddress = (seed: number | string, lead = '8') => `${lead}${String(seed).replace(/[^1-9A-HJ-NP-Za-km-z]/g, '').padEnd(94, 'x').slice(0, 94)}`;

export interface FfCall {
  method: string;
  body: Record<string, unknown>;
  rawBody: string;
  headers: Record<string, string>;
}

/** A fake FixedFloat: each handler gets the parsed body and returns `data` (or throws {code,msg}). */
export function fakeFixedFloat(handlers: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: FfCall[] = [];
  const transport: Transport = async (url, init) => {
    const method = url.split('/').pop()!;
    const rawBody = String(init.body);
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    calls.push({ method, body, rawBody, headers: init.headers as Record<string, string> });
    const handler = handlers[method];
    if (!handler) return new Response(JSON.stringify({ code: 404, msg: `no fake for ${method}`, data: null }));
    try {
      return new Response(JSON.stringify({ code: 0, msg: 'OK', data: handler(body) }));
    } catch (e) {
      const err = e as { code?: number; msg?: string };
      return new Response(JSON.stringify({ code: err.code ?? 500, msg: err.msg ?? String(e), data: null }));
    }
  };
  return { transport, calls };
}

const tx = (over: Record<string, unknown> = {}) => ({ id: null, amount: null, fee: null, ccyfee: null, timeReg: null, timeBlock: null, confirmations: null, ...over });

let seq = 0;
/** A FixedFloat order shaped like the real API's answer (captured from a live ETH order). */
export function ffOrder(over: {
  id?: string;
  coin?: 'ETH' | 'BTC' | 'XMR';
  status?: string;
  address?: string;
  payout?: string;
  toCode?: string;
  toNetwork?: string;
  toAmount?: string;
  type?: string;
  fromTx?: Record<string, unknown>;
  toTx?: Record<string, unknown>;
  emergency?: { status: string[]; choice: string; repeat: string };
  fromAmount?: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const coin = over.coin ?? 'ETH';
  seq++;
  return {
    id: over.id ?? `ORD${seq}`,
    token: `tok-${seq}-SECRET`,
    type: over.type ?? 'float',
    email: '',
    status: over.status ?? 'NEW',
    time: { reg: now, start: null, finish: null, update: now, expiration: now + 1800, left: 1800 },
    from: {
      code: coin,
      coin,
      network: coin,
      name: { ETH: 'Ethereum', BTC: 'Bitcoin', XMR: 'Monero' }[coin],
      alias: coin.toLowerCase(),
      amount: over.fromAmount ?? { ETH: '0.01500000', BTC: '0.00037290', XMR: '0.05600000' }[coin],
      address: over.address ?? { ETH: `0x${seq.toString(16).padStart(40, 'a')}`, BTC: btcAddress(seq), XMR: xmrAddress(`FF${seq}`, '4') }[coin],
      tag: '',
      reqConfirmations: { ETH: 4, BTC: 2, XMR: 20 }[coin],
      maxConfirmations: 30,
      tx: tx(over.fromTx),
    },
    to: {
      code: over.toCode ?? 'USDCBASE',
      coin: over.toCode === 'XMR' ? 'XMR' : over.toCode === 'USDT' ? 'USDT' : 'USDC',
      network: over.toNetwork ?? (over.toCode === 'XMR' ? 'XMR' : over.toCode === 'USDT' ? 'ETH' : 'BASE'),
      name: over.toCode === 'XMR' ? 'Monero' : over.toCode === 'USDT' ? 'Tether (ERC20)' : 'USD Coin (Base)',
      alias: over.toCode === 'XMR' ? 'xmr' : over.toCode === 'USDT' ? 'usdt' : 'usdcbase',
      amount: over.toAmount ?? '37.86900000',
      address: over.payout ?? PAYOUT,
      tag: '',
      tx: tx(over.toTx),
    },
    back: { code: '', amount: null, address: '', tag: '', tx: tx() },
    emergency: over.emergency ?? { status: [], choice: 'NONE', repeat: '0' },
  };
}

const PRICES = {
  ETH: { amount: 0.05, min: 0.005, usd: 127.16, out: 126.5 },
  BTC: { amount: 0.001, min: 0.0001243, usd: 83.86, out: 83.4 },
  XMR: { amount: 0.1, min: 0.0184, usd: 54.17, out: 53.9 },
};
/** FixedFloat's answer to `price` for the probe amount. Into XMR, the minimum is about $109 (as on the real exchange). */
export const priceAnswer = (coin: 'ETH' | 'BTC' | 'XMR', to: 'USDT' | 'USDCBASE' | 'XMR' = 'USDCBASE') => {
  const p = PRICES[coin];
  const min = to === 'XMR' ? Math.round((109 / (p.usd / p.amount)) * 1e8) / 1e8 : p.min;
  const out = to === 'XMR' ? Math.round((p.usd / 541.68) * 1e8) / 1e8 : p.out;
  return {
    from: { code: coin, network: coin, coin, amount: p.amount, rate: out / p.amount, precision: 8, min, max: 45, usd: p.usd },
    to: { code: to, network: to === 'XMR' ? 'XMR' : to === 'USDT' ? 'ETH' : 'BASE', coin: to, amount: out, rate: p.amount / out, precision: 8, min: 10, max: 113866, usd: p.usd },
    errors: [] as string[],
  };
};
