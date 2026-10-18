import { clientLog } from './lib/devlog';
import type { Coin, Destination, LogLine, Meta, Order, Quote, Route, Status, Transfer } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'x-wallet': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    clientLog('error', `${method} ${path.split('?')[0]}: no connection`);
    throw new ApiError(0, "Can't reach the Wallet Click server. Check your connection.", {});
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401 && path !== '/api/login' && !path.endsWith('/refund')) window.dispatchEvent(new Event('wc:locked'));
  if (!res.ok) {
    const message = String(data.error ?? `Request failed (${res.status})`);
    clientLog(res.status >= 500 ? 'error' : 'warn', `${method} ${path.split('?')[0]} → ${res.status}: ${message}`);
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

export const api = {
  status: () => request<Status>('GET', '/api/status'),
  login: (password: string, remember: boolean) => request<{ ok: true }>('POST', '/api/login', { password, remember }),
  logout: () => request<{ ok: true }>('POST', '/api/logout', {}),
  meta: () => request<Meta>('GET', '/api/meta'),
  orders: () => request<{ orders: Order[]; transfers?: Transfer[] }>('GET', '/api/orders'),
  createOrder: (coin: Coin, destinationId?: string) => request<Order>('POST', '/api/orders', destinationId && destinationId !== 'coinbase' ? { coin, destinationId } : { coin }),
  refund: (id: string, address: string, password: string) => request<Order>('POST', `/api/orders/${id}/refund`, { address, password }),
  destinations: () => request<{ destinations: Destination[] }>('GET', '/api/destinations'),
  addDestination: (label: string, address: string, password: string) => request<{ destinations: Destination[] }>('POST', '/api/destinations', { label, address, password }),
  removeDestination: (id: string, password: string) => request<{ destinations: Destination[] }>('POST', `/api/destinations/${id}/delete`, { password }),
  createPrivacy: (coin: Coin, delayHours: number, destinationId: string, pieces = 1) => request<Transfer>('POST', '/api/transfers', { coin, delayHours, destinationId, pieces }),
  /** A one-time address of our own wallet, for a coin button with a wait or pieces. */
  createOnce: (coin: Coin, delayHours: number, pieces: number, destinationId: string) => request<Route>('POST', '/api/addresses/once', { coin, delayHours, pieces, destinationId }),
  release: (id: string) => request<Transfer>('POST', `/api/transfers/${id}/release`, {}),
  changeDelay: (id: string, delayHours: number) => request<Transfer>('POST', `/api/transfers/${id}/delay`, { delayHours }),
  retry: (id: string) => request<Transfer>('POST', `/api/transfers/${id}/retry`, {}),
  addresses: () => request<{ addresses: Route[]; available: Record<Coin | 'privacy', boolean> }>('GET', '/api/addresses'),
  createAddress: (body: { coin: Coin; mode: 'direct' | 'privacy'; delayHours: number | null; pieces?: number; destinationId: string; label: string }) => request<Route>('POST', '/api/addresses', body),
  updateAddress: (id: string, patch: { label?: string; delayHours?: number; pieces?: number; archived?: boolean }) => request<Route>('POST', `/api/addresses/${id}`, patch),
  logs: (after: number) => request<{ lines: LogLine[]; startedAt: number }>('GET', `/api/logs?after=${after}`),
  quote: (coin: Coin, usd: number, mode: 'direct' | 'privacy') => request<Quote>('GET', `/api/quote?coin=${coin}&usd=${usd}&mode=${mode}`),
};
