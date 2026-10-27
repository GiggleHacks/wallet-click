import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-hardening-'));
afterAll(() => fs.rmSync(process.env.DATA_DIR!, { recursive: true, force: true }));

const H = 3_600_000;

describe('sampled waits', () => {
  it('draws the real wait around the chosen hours instead of using the choice itself', async () => {
    delete process.env.PRIVACY_TEST_DELAY_MIN;
    vi.resetModules();
    const { sampleWait } = await import('../server/transfers.js');
    expect(sampleWait(0)).toBe(0);
    expect(sampleWait(null)).toBe(0);

    for (const hours of [4, 12, 24, 42]) {
      const draws = Array.from({ length: 3000 }, () => sampleWait(hours));
      const mean = draws.reduce((s, v) => s + v, 0) / draws.length / H;
      // Never under a quarter of the choice or over three times it.
      expect(Math.min(...draws)).toBeGreaterThanOrEqual((hours * H) / 4);
      expect(Math.max(...draws)).toBeLessThanOrEqual(hours * 3 * H);
      // Averages out near the choice, a bit under it because the long tail is cut off.
      expect(mean).toBeGreaterThan(hours * 0.8);
      expect(mean).toBeLessThan(hours * 1.05);
      // Not the old "the choice plus up to 30 minutes".
      expect(draws.filter((d) => d >= hours * H && d <= hours * H + 30 * 60_000).length).toBeLessThan(draws.length * 0.2);
      expect(new Set(draws).size).toBeGreaterThan(2900);
    }
  });

  it('keeps the short, fixed test wait when PRIVACY_TEST_DELAY_MIN is set', async () => {
    process.env.PRIVACY_TEST_DELAY_MIN = '2';
    vi.resetModules();
    try {
      const { sampleWait } = await import('../server/transfers.js');
      for (let i = 0; i < 50; i++) {
        const w = sampleWait(24);
        expect(w).toBeGreaterThanOrEqual(2 * 60_000);
        expect(w).toBeLessThan(2 * 60_000 + 30_000);
      }
    } finally {
      delete process.env.PRIVACY_TEST_DELAY_MIN;
    }
  });
});

// ---------------------------------------------------------------- outbound traffic through a SOCKS5 proxy

/** The target server: counts what reaches it directly. */
async function target() {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.end('hello from the target');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, hits, port: (server.address() as net.AddressInfo).port };
}

/** A minimal SOCKS5 proxy (no auth): records what it was asked to connect to, and forwards to `to`. */
async function socks(to: { host: string; port: number }) {
  const asked: { atyp: number; host: string; port: number }[] = [];
  const server = net.createServer((c) => {
    c.once('data', () => {
      c.write(Buffer.from([5, 0])); // no authentication
      c.once('data', (req) => {
        const atyp = req[3];
        let host = '';
        let off = 4;
        if (atyp === 3) {
          host = req.subarray(5, 5 + req[4]).toString();
          off = 5 + req[4];
        }
        const port = req.readUInt16BE(off);
        asked.push({ atyp, host, port });
        const up = net.connect(to.port, to.host, () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          c.pipe(up);
          up.pipe(c);
        });
        up.on('error', () => c.destroy());
        c.on('error', () => up.destroy());
      });
    });
    c.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, asked, port: (server.address() as net.AddressInfo).port };
}

const closeAll = (...servers: (http.Server | net.Server)[]) => Promise.all(servers.map((s) => new Promise((r) => s.close(r))));

describe('egress proxy', () => {
  afterEach(() => {
    delete process.env.EGRESS_PROXY;
    delete process.env.EGRESS_VIA;
  });

  it('goes direct when no proxy is set', async () => {
    const t = await target();
    vi.resetModules();
    const { egressFetch, viaProxy } = await import('../server/egress.js');
    expect(viaProxy('ff')).toBe(false);
    expect(await (await egressFetch('chain')(`http://127.0.0.1:${t.port}/direct`)).text()).toBe('hello from the target');
    expect(t.hits).toEqual(['/direct']);
    await closeAll(t.server);
  });

  it('sends FixedFloat and chain traffic through the proxy, naming the host rather than resolving it here', async () => {
    const t = await target();
    const p = await socks({ host: '127.0.0.1', port: t.port });
    process.env.EGRESS_PROXY = `socks5h://127.0.0.1:${p.port}`;
    vi.resetModules();
    const { egressFetch, viaProxy } = await import('../server/egress.js');
    expect(viaProxy('ff') && viaProxy('chain')).toBe(true);
    for (const group of ['ff', 'chain'] as const) {
      const res = await egressFetch(group)('http://some-esplora.invalid:8080/api/tx', { method: 'POST', body: 'rawhex' });
      expect(await res.text()).toBe('hello from the target');
    }
    expect(p.asked).toEqual([
      { atyp: 3, host: 'some-esplora.invalid', port: 8080 },
      { atyp: 3, host: 'some-esplora.invalid', port: 8080 },
    ]);
    expect(t.hits).toEqual(['/api/tx', '/api/tx']);
    await closeAll(t.server, p.server);
  });

  it('never falls back to a direct connection when the proxy is down', async () => {
    const t = await target();
    const dead = net.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const deadPort = (dead.address() as net.AddressInfo).port;
    await closeAll(dead); // nothing listens here now
    process.env.EGRESS_PROXY = `socks5h://127.0.0.1:${deadPort}`;
    vi.resetModules();
    const { egressFetch } = await import('../server/egress.js');
    await expect(egressFetch('ff')(`http://127.0.0.1:${t.port}/leak`)).rejects.toThrow();
    await expect(egressFetch('chain')(`http://127.0.0.1:${t.port}/leak`)).rejects.toThrow();
    expect(t.hits).toEqual([]);
    await closeAll(t.server);
  });

  it('EGRESS_VIA picks which traffic uses the proxy', async () => {
    const t = await target();
    const p = await socks({ host: '127.0.0.1', port: t.port });
    process.env.EGRESS_PROXY = `socks5h://127.0.0.1:${p.port}`;
    process.env.EGRESS_VIA = 'chain';
    vi.resetModules();
    const { egressFetch, viaProxy } = await import('../server/egress.js');
    expect(viaProxy('ff')).toBe(false);
    expect(viaProxy('chain')).toBe(true);
    await egressFetch('ff')(`http://127.0.0.1:${t.port}/ff`);
    expect(p.asked).toHaveLength(0);
    await egressFetch('chain')(`http://127.0.0.1:${t.port}/chain`);
    expect(p.asked).toHaveLength(1);
    expect(t.hits).toEqual(['/ff', '/chain']);
    await closeAll(t.server, p.server);
  });

  it('refuses a proxy setting that is not SOCKS5', async () => {
    process.env.EGRESS_PROXY = 'http://127.0.0.1:8118';
    vi.resetModules();
    await expect(import('../server/config.js')).rejects.toThrow(/EGRESS_PROXY/);
    process.env.EGRESS_PROXY = 'socks5h://127.0.0.1:9050';
    process.env.EGRESS_VIA = 'monero';
    vi.resetModules();
    await expect(import('../server/config.js')).rejects.toThrow(/EGRESS_VIA/);
  });
});
