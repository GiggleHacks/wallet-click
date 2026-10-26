import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-notify-'));
process.env.WC_NOTIFY_DIR = dataDir;
process.env.WC_NOTIFY_TEST = '1';

const { formatNotice, noteHotSend, noteOrderMoney, noteRouteReceived, resetNotify } = await import('../server/notify.js');

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetNotify();
  fs.rmSync(path.join(dataDir, 'notify-keys.json'), { force: true });
  fs.rmSync(path.join(dataDir, 'telegram-outbox.jsonl'), { force: true });
});

const lines = () => fs.readFileSync(path.join(dataDir, 'telegram-outbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { key: string; text: string });

describe('telegram notices', () => {
  const notice = {
    kind: 'received' as const,
    key: 'k',
    amount: '0.015',
    asset: 'BTC',
    label: 'Phone',
    address: 'bc1qexample',
    txUrl: 'https://mempool.space/tx/abc',
    at: Date.UTC(2026, 9, 20, 0, 22),
  };

  it('says only that something arrived, and which coin: no amount, address, link or time', () => {
    expect(formatNotice(notice)).toBe(['📥 Received', 'BTC', 'Phone'].join('\n'));
    expect(formatNotice({ ...notice, kind: 'sent', detail: 'To the swap', label: null })).toBe(['📤 Sent', 'BTC', 'To the swap'].join('\n'));
  });

  it('puts the address, amount, link and UTC time back only when NOTIFY_DETAIL=full', () => {
    process.env.NOTIFY_DETAIL = 'full';
    try {
      expect(formatNotice(notice)).toBe(['📥 Received', '0.015 BTC', 'Phone', 'To: bc1qexample', 'https://mempool.space/tx/abc', '2026-10-20 00:22 UTC'].join('\n'));
    } finally {
      delete process.env.NOTIFY_DETAIL;
    }
  });

  it('pings an external deposit once, and a USDC payout once', () => {
    noteOrderMoney({
      id: 'ORD1',
      coin: 'ETH',
      depositAddress: '0xdeposit',
      toCcy: 'USDCBASE',
      toAddress: '0xBA5eba5EBa5EbA5eBA5EBA5eBa5EBa5ebA5ebA5E',
      toLabel: 'Coinbase (USDC on Base)',
      seen: { at: 1, amount: '0.02' },
      seenNew: true,
      hadFrom: false,
      hadTo: true,
      hadRefund: true,
      at: 1,
    });
    noteOrderMoney({
      id: 'ORD1',
      coin: 'ETH',
      depositAddress: '0xdeposit',
      toCcy: 'USDCBASE',
      toAddress: '0xBA5eba5EBa5EbA5eBA5EBA5eBa5EBa5ebA5ebA5E',
      toLabel: 'Coinbase (USDC on Base)',
      seen: { at: 1, amount: '0.02' },
      fromAmount: '0.02',
      fromTxId: '0xfrom',
      toTxId: '0xpayout',
      toAmount: '61.5',
      hadFrom: false,
      hadTo: false,
      hadRefund: true,
      at: 2,
    });
    const got = lines();
    expect(got.map((g) => g.key)).toEqual(['recv:order:ORD1', 'send:payout:0xpayout']);
    expect(got[0].text).toBe('📥 Received\nETH');
    expect(got[1].text).toBe('📤 Sent\nUSDC\nCoinbase (USDC on Base)');
    // Nothing that could join the legs up leaves the server.
    for (const g of got) expect(g.text).not.toMatch(/0\.02|61\.5|0x|https?:/);
  });

  it('does not treat our own wallet paying FixedFloat as a new receipt, or a Monero vault payout as sent', () => {
    noteOrderMoney({
      id: 'ORD2',
      coin: 'BTC',
      depositAddress: 'bc1qff',
      ownRefund: 'bc1qours',
      toCcy: 'XMR',
      toAddress: '8vault',
      toLabel: 'Monero vault',
      seen: { at: 1, amount: '0.01' },
      fromAmount: '0.01',
      toTxId: 'xmrtx',
      toAmount: '1.2',
      hadFrom: false,
      hadTo: false,
      hadRefund: true,
      at: 1,
    });
    expect(fs.existsSync(path.join(dataDir, 'telegram-outbox.jsonl'))).toBe(false);
  });

  it('pings a permanent address and a hot-wallet send, once each', () => {
    noteRouteReceived({ routeId: 'r1', label: 'Phone', coin: 'BTC', address: 'bc1qphone', amount: '0.004', txids: ['aaa'], at: 3 });
    noteRouteReceived({ routeId: 'r1', label: 'Phone', coin: 'BTC', address: 'bc1qphone', amount: '0.004', txids: ['aaa'], at: 4 });
    noteHotSend({ txid: 'bbb', amount: '0.004', coin: 'BTC', to: 'bc1qff', at: 5 });
    const got = lines();
    expect(got).toHaveLength(2);
    expect(got[0].text).toBe('📥 Received\nBTC\nPhone');
    expect(got[1].text).toBe('📤 Sent\nBTC\nTo the swap');
    for (const g of got) expect(g.text).not.toMatch(/bc1q|0\.004|https?:/);
  });
});
