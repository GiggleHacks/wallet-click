import type { Coin, Meta, Order, Status } from './types';

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
    throw new ApiError(0, "Can't reach the Wallet Click server. Check your connection.", {});
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401 && path !== '/api/login' && !path.endsWith('/refund')) window.dispatchEvent(new Event('wc:locked'));
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? `Request failed (${res.status})`), data);
  return data as T;
}

export const api = {
  status: () => request<Status>('GET', '/api/status'),
  login: (password: string, remember: boolean) => request<{ ok: true }>('POST', '/api/login', { password, remember }),
  logout: () => request<{ ok: true }>('POST', '/api/logout', {}),
  meta: () => request<Meta>('GET', '/api/meta'),
  orders: () => request<{ orders: Order[] }>('GET', '/api/orders'),
  createOrder: (coin: Coin) => request<Order>('POST', '/api/orders', { coin }),
  refund: (id: string, address: string, password: string) => request<Order>('POST', `/api/orders/${id}/refund`, { address, password }),
};
