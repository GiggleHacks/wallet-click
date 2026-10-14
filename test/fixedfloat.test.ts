import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeFixedFloat } from './helpers.js';

process.env.FF_API_KEY = 'test-key';
process.env.FF_API_SECRET = 'test-secret';

const { call, ff, setTransport, sign } = await import('../server/fixedfloat.js');
const { isChecksumAddress } = await import('../server/config.js');

afterEach(() => setTransport(null));

describe('FixedFloat client', () => {
  it('signs the exact bytes it sends (HMAC-SHA256 with the secret, hex)', async () => {
    const fake = fakeFixedFloat({ price: () => ({ from: {}, to: {}, errors: [] }) });
    setTransport(fake.transport);
    await ff.price('BTC', 'USDT', 0.001);
    const [req] = fake.calls;
    expect(req.method).toBe('price');
    expect(req.headers['X-API-KEY']).toBe('test-key');
    expect(req.headers['X-API-SIGN']).toBe(crypto.createHmac('sha256', 'test-secret').update(req.rawBody).digest('hex'));
    expect(req.headers['X-API-SIGN']).toBe(sign(req.rawBody, 'test-secret'));
    expect(req.body).toEqual({ type: 'float', fromCcy: 'BTC', toCcy: 'USDT', direction: 'from', amount: 0.001 });
  });

  it('turns a non-zero code into an error', async () => {
    setTransport(fakeFixedFloat({ order: () => { throw { code: 301, msg: 'Order not found' }; } }).transport);
    await expect(ff.order('NOPE', 'x')).rejects.toThrow('FixedFloat: Order not found');
  });

  it('keeps under the 250-per-minute weight limit on its own', async () => {
    setTransport(fakeFixedFloat({ create: () => ({}) }).transport);
    for (let i = 0; i < 4; i++) await call('create', {}, 50);
    await expect(call('create', {}, 50)).rejects.toThrow(/Too many requests/);
  });
});

describe('payout address', () => {
  it('the Coinbase address passes its EIP-55 checksum (no typo)', () => {
    expect(isChecksumAddress('0x7E577e577e577E577e577E577E577E577e577E57')).toBe(true);
  });
  it('a one-character typo fails the checksum', () => {
    expect(isChecksumAddress('0x7E577e577e577E577e577E577E577E577e577e57')).toBe(false);
    expect(isChecksumAddress('0x7E577e577e577E577e577E577E577E577e577E5')).toBe(false);
  });
});
