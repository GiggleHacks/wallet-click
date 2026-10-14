import crypto from 'node:crypto';
import { config } from './config.js';

/** FixedFloat API v2: https://ff.io/api. Every call is a signed JSON POST. */

export type FfStatus = 'NEW' | 'PENDING' | 'EXCHANGE' | 'WITHDRAW' | 'DONE' | 'EXPIRED' | 'EMERGENCY';
type Num = string | number | null;

export interface FfTx {
  id: string | null;
  amount: Num;
  fee: Num;
  ccyfee: Num;
  timeReg: number | null;
  timeBlock: number | null;
  confirmations: Num;
}

export interface FfSide {
  code: string;
  coin: string;
  network: string;
  name: string;
  alias?: string;
  amount: Num;
  address: string;
  tag?: string | null;
  addressMix?: string;
  reqConfirmations?: number;
  maxConfirmations?: number;
  tx: FfTx;
}

export interface FfOrder {
  id: string;
  token?: string;
  type: 'fixed' | 'float';
  email?: string;
  status: FfStatus;
  time: { reg: number; start: number | null; finish: number | null; update: number | null; expiration: number; left: number };
  from: FfSide;
  to: FfSide;
  back?: { amount: Num; address: string | null; tag: string | null; tx: FfTx | null };
  emergency?: { status: string[] | null; choice: 'NONE' | 'EXCHANGE' | 'REFUND' | null; repeat: string | number | boolean | null };
}

export interface FfPriceSide {
  code: string;
  network: string;
  coin: string;
  amount: Num;
  rate: Num;
  precision: number;
  min: Num;
  max: Num;
  usd: Num;
}

export interface FfPrice {
  from: FfPriceSide;
  to: FfPriceSide;
  errors: string[];
}

export class FfError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

export const sign = (body: string, secret: string) => crypto.createHmac('sha256', secret).update(body).digest('hex');

// FixedFloat allows 250 weight units per minute (create = 50, everything else = 1); exceeding it
// blocks the key for a while. We keep our own tally and stay comfortably below.
const WINDOW_MS = 60_000;
const BUDGET = 220;
let spent: { at: number; weight: number }[] = [];

export function budgetLeft(now = Date.now()): number {
  spent = spent.filter((s) => now - s.at < WINDOW_MS);
  return BUDGET - spent.reduce((sum, s) => sum + s.weight, 0);
}

export type Transport = (url: string, init: RequestInit) => Promise<Response>;
let transport: Transport = (url, init) => fetch(url, init);
/** Tests swap the network for a fake FixedFloat. */
export function setTransport(t: Transport | null): void {
  transport = t ?? ((url, init) => fetch(url, init));
  spent = [];
}

export async function call<T>(method: string, data: object, weight = 1): Promise<T> {
  const { apiKey, apiSecret, baseUrl } = config.ff;
  if (!apiKey || !apiSecret) throw new FfError(-2, 'The FixedFloat API key is not set up (FF_API_KEY and FF_API_SECRET).');
  if (budgetLeft() < weight) throw new FfError(-1, 'Too many requests to FixedFloat this minute. Try again shortly.');
  spent.push({ at: Date.now(), weight });

  const body = JSON.stringify(data);
  const res = await transport(`${baseUrl}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-API-KEY': apiKey, 'X-API-SIGN': sign(body, apiSecret) },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => null)) as { code: number; msg: string; data: T } | null;
  if (!json || typeof json.code !== 'number') throw new FfError(res.status, `FixedFloat answered with HTTP ${res.status}`);
  if (json.code !== 0) throw new FfError(json.code, `FixedFloat: ${json.msg}`);
  return json.data;
}

export const ff = {
  price: (fromCcy: string, toCcy: string, amount: number) =>
    call<FfPrice>('price', { type: 'float', fromCcy, toCcy, direction: 'from', amount }),
  create: (fromCcy: string, toCcy: string, amount: number, toAddress: string) =>
    call<FfOrder>('create', { type: 'float', fromCcy, toCcy, direction: 'from', amount, toAddress }, 50),
  order: (id: string, token: string) => call<FfOrder>('order', { id, token }),
  emergency: (id: string, token: string, choice: 'EXCHANGE' | 'REFUND', address?: string) =>
    call<boolean>('emergency', { id, token, choice, ...(address ? { address } : {}) }),
};
