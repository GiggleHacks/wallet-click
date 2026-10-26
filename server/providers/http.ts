import { egressFetch, patience } from '../egress.js';
import { SwapApiError } from './types.js';

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

/** Swap-provider traffic follows the same EGRESS_PROXY / EGRESS_VIA=ff setting as FixedFloat's. */
const real: Transport = (url, init) => egressFetch('ff')(url, init);
let transport: Transport = real;
/** Tests swap the network for fakes. */
export function setProviderTransport(t: Transport | null): void {
  transport = t ?? real;
}

/** One JSON request. Errors say what the provider said, never the URL (it can carry an address or a key). */
export async function api<T>(label: string, url: string, init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
  const res = await transport(url, {
    method: init.method ?? 'GET',
    headers: { accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(patience(20_000, 'ff')),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON: handled below */
  }
  const said = (json as { error?: unknown; message?: unknown } | null) ?? {};
  if (!res.ok) throw new SwapApiError(res.status, `${label}: ${String(said.error ?? said.message ?? `HTTP ${res.status}`).slice(0, 200)}`);
  if (json === null) throw new SwapApiError(res.status || 502, `${label} answered something that isn't JSON`);
  return json as T;
}
