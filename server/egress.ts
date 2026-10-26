import { fetch as proxiedFetch, Socks5ProxyAgent } from 'undici';
import { config } from './config.js';

/**
 * Outbound traffic to FixedFloat and the public blockchain APIs, optionally through a SOCKS5 proxy (Tor), so those
 * services see the proxy's address and not the VPS's. DNS is resolved by the proxy. When EGRESS_PROXY is set there is
 * no direct fallback: a proxy that is down makes the call fail, it never goes out from the VPS address instead.
 * (monero-wallet-rpc is local and talks to its Monero node itself: give that its own `--proxy`.)
 */

export type EgressGroup = 'ff' | 'chain';
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

let agent: Socks5ProxyAgent | null = null;

function dispatcher(): Socks5ProxyAgent {
  // Tor circuits take a while to build, so each stage gets far longer than undici's 5 seconds.
  agent ??= new Socks5ProxyAgent(config.egress.proxy!.replace(/^socks5h:/i, 'socks5:'), { connectTimeout: 45_000 });
  return agent;
}

/** Whether this kind of traffic goes through the proxy. */
export const viaProxy = (group: EgressGroup): boolean => Boolean(config.egress.proxy) && config.egress.via.includes(group);

/** Tor is slower than a direct connection: give requests that much longer before giving up. */
export const patience = (ms: number, group: EgressGroup): number => (viaProxy(group) ? ms * 3 : ms);

/** fetch for one kind of traffic: direct, or through the proxy. */
export const egressFetch =
  (group: EgressGroup): Fetch =>
  (url, init) =>
    viaProxy(group) ? (proxiedFetch(url, { ...init, dispatcher: dispatcher() } as Parameters<typeof proxiedFetch>[1]) as unknown as Promise<Response>) : fetch(url, init);

/** One line for the start-up log. */
export const egressSummary = (): string =>
  config.egress.proxy ? `through ${config.egress.proxy.replace(/\/\/.*@/, '//')} for ${config.egress.via.map((v) => (v === 'ff' ? 'FixedFloat' : 'Esplora/Ethereum RPC')).join(' and ')}` : 'direct (no EGRESS_PROXY): FixedFloat and the public blockchain APIs see the VPS address';
