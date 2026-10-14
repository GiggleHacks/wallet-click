import type { Transport } from '../server/fixedfloat.js';

export const PAYOUT = '0x7E577e577e577E577e577E577E577E577e577E57';

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
  coin?: 'ETH' | 'BTC';
  status?: string;
  address?: string;
  payout?: string;
  toCode?: string;
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
    type: 'float',
    email: '',
    status: over.status ?? 'NEW',
    time: { reg: now, start: null, finish: null, update: now, expiration: now + 1800, left: 1800 },
    from: {
      code: coin,
      coin,
      network: coin,
      name: coin === 'ETH' ? 'Ethereum' : 'Bitcoin',
      alias: coin.toLowerCase(),
      amount: over.fromAmount ?? (coin === 'ETH' ? '0.01500000' : '0.00037290'),
      address: over.address ?? (coin === 'ETH' ? `0x${seq.toString(16).padStart(40, 'a')}` : `bc1qfake${seq}xxxxxxxxxxxxxxxxxxxxxxxxxxxx`),
      tag: '',
      reqConfirmations: coin === 'ETH' ? 4 : 2,
      maxConfirmations: 30,
      tx: tx(over.fromTx),
    },
    to: {
      code: over.toCode ?? 'USDT',
      coin: 'USDT',
      network: 'ETH',
      name: 'Tether (ERC20)',
      alias: 'usdt',
      amount: '37.86900000',
      address: over.payout ?? PAYOUT,
      tag: '',
      tx: tx(over.toTx),
    },
    back: { code: '', amount: null, address: '', tag: '', tx: tx() },
    emergency: over.emergency ?? { status: [], choice: 'NONE', repeat: '0' },
  };
}

export const priceAnswer = (coin: 'ETH' | 'BTC') => ({
  from: { code: coin, network: coin, coin, amount: coin === 'ETH' ? 0.05 : 0.001, rate: 2530, precision: 8, min: coin === 'ETH' ? 0.005 : 0.0001243, max: 45, usd: coin === 'ETH' ? 127.16 : 83.86 },
  to: { code: 'USDT', network: 'ETH', coin: 'USDT', amount: 126.5, rate: 0.0004, precision: 8, min: 10, max: 113866, usd: 126.5 },
  errors: [],
});
