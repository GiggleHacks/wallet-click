import { bytesToHex } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { encodeFunctionData, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ChainUnavailable, chainFetch, rpcAt } from '../chain.js';
import { config } from '../config.js';
import { patience } from '../egress.js';
import { ed25519KeyAt, keyAt } from '../wallets/seed.js';
import * as xmr from '../wallets/xmr.js';
import { ed25519Public, ed25519Sign } from './ed25519.js';
import { stashPath, type Asset } from './assets.js';

/**
 * Reading and spending one Wallet address, per kind of chain. Like the hot wallet (server/wallets), a spend is
 * signed first and broadcast separately, so the signed transaction can be saved in between (and broadcast again
 * after a crash, never rebuilt). A spend always empties the address into exactly one output: the deposit address of
 * a swap order that was just created and checked. Nothing here picks a destination.
 */

export interface Ref {
  asset: Asset;
  index: number;
  address: string;
}

export interface StashScan {
  /** Everything at the address, confirmed or not (base units). */
  seen: bigint;
  /** The part that has enough confirmations to move. */
  spendable: bigint;
  txids: string[];
  /** Every payment there has its confirmations. */
  confirmed: boolean;
  /** One of our own sends from here isn't settled yet. */
  busy: boolean;
}

export interface Quote {
  /** What arrives at the destination if everything spendable goes, and the network fee for that. */
  amount: bigint;
  fee: bigint;
  /** UTXO: exactly the coins counted. EVM: the gas limit and fee per gas it assumed. */
  inputs?: string[];
  gas?: string;
  maxFee?: string;
}

export interface Signed {
  txids: string[];
  /** Signed transactions. Secret: never sent to the browser. */
  raw: string[];
  amount: bigint;
  fee: bigint;
  /** Solana: the blockhash it was signed against (after it expires, the transaction can never land). */
  blockhash?: string;
}

export interface Chain {
  address(index: number): Promise<{ index: number; address: string }>;
  scan(r: Ref): Promise<StashScan>;
  quote(r: Ref): Promise<Quote | null>;
  prepare(r: Ref, to: string, q: Quote): Promise<Signed>;
  broadcast(raw: string): Promise<void>;
  status(r: Ref, txid: string): Promise<{ confirmations: number } | null>;
  /** The signed transaction can never be mined now (Solana: its blockhash expired): it's safe to sign a new one. */
  expired?(s: Signed): Promise<boolean>;
}

const timeout = (ms = 15_000) => AbortSignal.timeout(patience(ms, 'chain'));

// ---------------------------------------------------------------- Bitcoin and Litecoin (Esplora)

const LTC_NETWORK = { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 };
const DUST = 546n;
/** The fee assumes the largest common output type (taproot / P2WSH, 43 vbytes). */
const vsize = (inputs: number) => 11 + 68 * inputs + 43;

interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

function utxoChain(asset: Asset): Chain {
  const net = asset.id === 'LTC' ? LTC_NETWORK : btc.NETWORK;
  const apis = () => (asset.id === 'LTC' ? config.stash.ltcApis : config.chains.btcApis);
  /** Fee ceilings, whatever an API claims: 0.005 BTC, 0.05 LTC. */
  const maxFee = asset.id === 'LTC' ? 5_000_000n : 500_000n;
  const minRate = asset.id === 'LTC' ? 10 : 2;
  const pay = (index: number) => {
    const key = keyAt(stashPath(asset, index));
    return { key, own: btc.p2wpkh(key.publicKey!, net) };
  };

  async function esplora<T>(pathname: string, init?: RequestInit, as: 'json' | 'text' = 'json'): Promise<T> {
    let last: unknown;
    for (const base of apis()) {
      try {
        const res = await chainFetch(`${base}${pathname}`, { ...init, signal: timeout() });
        if ((res.status === 404 || res.status === 400) && !init) return null as T;
        if (!res.ok) throw new ChainUnavailable(`${new URL(base).host} answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        return (as === 'json' ? await res.json() : await res.text()) as T;
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof ChainUnavailable ? last : new ChainUnavailable(String((last as Error)?.message ?? `No ${asset.name} API answered`));
  }
  const tip = async () => Number(await esplora<string>('/blocks/tip/height', undefined, 'text'));
  async function feeRate(): Promise<number> {
    try {
      const f = await esplora<{ halfHourFee?: number }>('/v1/fees/recommended');
      if (f?.halfHourFee) return Math.max(minRate, Math.ceil(f.halfHourFee));
    } catch {
      /* Esplora's own estimates below */
    }
    const est = await esplora<Record<string, number>>('/fee-estimates');
    return Math.max(minRate, Math.ceil(est?.['3'] ?? est?.['6'] ?? 10));
  }
  const list = async (address: string) => (await esplora<Utxo[]>(`/address/${address}/utxo`)) ?? [];
  const outpoint = (u: { txid: string; vout: number }) => `${u.txid}:${u.vout}`;
  const confsOf = (u: Utxo, height: number) => (u.status.confirmed ? (u.status.block_height && height ? height - u.status.block_height + 1 : 1) : 0);

  return {
    async address(index) {
      return { index, address: pay(index).own.address! };
    },
    async scan(r) {
      const utxos = await list(r.address);
      const height = utxos.some((u) => u.status.confirmed) ? await tip().catch(() => 0) : 0;
      const ripe = utxos.filter((u) => confsOf(u, height) >= asset.confirmations);
      const sum = (l: Utxo[]) => l.reduce((s, u) => s + BigInt(u.value), 0n);
      return { seen: sum(utxos), spendable: sum(ripe), txids: [...new Set(utxos.map((u) => u.txid))], confirmed: ripe.length === utxos.length, busy: false };
    },
    async quote(r) {
      const utxos = await list(r.address);
      const height = await tip();
      const ripe = utxos.filter((u) => confsOf(u, height) >= asset.confirmations);
      if (!ripe.length) return null;
      const total = ripe.reduce((s, u) => s + BigInt(u.value), 0n);
      const fee = BigInt(vsize(ripe.length) * (await feeRate()));
      if (total - fee < DUST) return null;
      return { amount: total - fee, fee, inputs: ripe.map(outpoint) };
    },
    async prepare(r, to, q) {
      const want = q.inputs ?? [];
      if (!want.length) throw new Error(`No coins were chosen for this ${asset.name} send.`);
      const unspent = new Map((await list(r.address)).map((u) => [outpoint(u), u]));
      const inputs = want.map((o) => unspent.get(o));
      if (inputs.some((u) => !u)) throw new Error('Some of the quoted coins are no longer unspent; quoting again.');
      const total = inputs.reduce((s, u) => s + BigInt(u!.value), 0n);
      const fee = total - q.amount;
      if (fee <= 0n || fee > total / 5n || fee > maxFee) throw new Error(`Refusing a ${asset.name} fee of ${fee} for ${q.amount}.`);
      const { key, own } = pay(r.index);
      if (own.address !== r.address) throw new Error('The Wallet address does not match the wallet key.');
      const tx = new btc.Transaction();
      for (const u of inputs as Utxo[]) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: own.script, amount: BigInt(u.value) }, sequence: 0xfffffffd });
      tx.addOutputAddress(to, q.amount, net); // throws on an address of another network
      tx.sign(key.privateKey!);
      tx.finalize();
      return { txids: [tx.id], raw: [tx.hex], amount: q.amount, fee };
    },
    async broadcast(raw) {
      await esplora<string>('/tx', { method: 'POST', body: raw, headers: { 'content-type': 'text/plain' } }, 'text');
    },
    async status(_r, txid) {
      const s = await esplora<{ confirmed: boolean; block_height?: number } | null>(`/tx/${txid}/status`);
      if (!s) return null;
      if (!s.confirmed || !s.block_height) return { confirmations: 0 };
      return { confirmations: (await tip()) - s.block_height + 1 };
    },
  };
}

// ---------------------------------------------------------------- Ethereum and EVM chains

const GWEI = 1_000_000_000n;
/** Most a send may cost in gas (the coin's own units): 0.01 ETH on mainnet, much less on the L2s. */
const MAX_TOTAL_FEE: Record<string, bigint> = { ETH: 10n ** 16n, POL: 5n * 10n ** 18n, BNB: 5n * 10n ** 15n };
const L2_MAX_FEE = 2n * 10n ** 15n;
const OP_GAS_ORACLE = '0x420000000000000000000000000000000000000F';
const GET_L1_FEE = [{ type: 'function', name: 'getL1Fee', stateMutability: 'view', inputs: [{ name: '_data', type: 'bytes' }], outputs: [{ type: 'uint256' }] }] as const;
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

function evmChain(asset: Asset): Chain {
  const urls = () => asset.rpcUrls!();
  const cap = MAX_TOTAL_FEE[asset.id] ?? L2_MAX_FEE;
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let last: unknown;
    for (const url of urls()) {
      try {
        return await rpcAt<T>(url, method, params);
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof ChainUnavailable ? last : new ChainUnavailable(String((last as Error)?.message ?? `No ${asset.network} RPC answered`));
  }
  const account = (index: number) => privateKeyToAccount(`0x${bytesToHex(keyAt(stashPath(asset, index)).privateKey!)}`);
  async function fees(): Promise<{ maxFee: bigint; tip: bigint }> {
    const [block, tipHex, priceHex] = await Promise.all([
      call<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false]),
      call<string>('eth_maxPriorityFeePerGas', []).catch(() => '0x0'),
      call<string>('eth_gasPrice', []).catch(() => '0x0'),
    ]);
    const base = BigInt(block.baseFeePerGas ?? '0x0');
    let tip = BigInt(tipHex);
    if (tip <= 0n) tip = asset.id === 'ETH' ? GWEI : asset.id === 'POL' ? 30n * GWEI : GWEI / 1000n;
    if (asset.id === 'ETH' && tip > 5n * GWEI) tip = 5n * GWEI;
    let maxFee = base * 2n + tip;
    const price = BigInt(priceHex);
    if (price > maxFee) maxFee = price; // chains without a base fee (BNB) quote a plain gas price
    return { maxFee, tip: tip < maxFee ? tip : maxFee };
  }
  /** OP Stack: the L1 data fee for a transaction this size, charged on top of gas. */
  async function l1Fee(raw: `0x${string}`): Promise<bigint> {
    if (!asset.opStack) return 0n;
    const data = encodeFunctionData({ abi: GET_L1_FEE, functionName: 'getL1Fee', args: [raw] });
    return BigInt(await call<string>('eth_call', [{ to: OP_GAS_ORACLE, data }, 'latest']));
  }
  async function balances(address: string) {
    const latest = Number(BigInt(await call<string>('eth_blockNumber', [])));
    const [now, settled, pending, nonceLatest, noncePending] = await Promise.all([
      call<string>('eth_getBalance', [address, 'latest']),
      call<string>('eth_getBalance', [address, hex(Math.max(0, latest - (asset.confirmations - 1)))]),
      call<string>('eth_getBalance', [address, 'pending']).catch(() => '0x0'),
      call<string>('eth_getTransactionCount', [address, 'latest']),
      call<string>('eth_getTransactionCount', [address, 'pending']).catch(() => '0x0'),
    ]);
    return { now: BigInt(now), settled: BigInt(settled), pending: BigInt(pending), busy: BigInt(noncePending) > BigInt(nonceLatest) };
  }
  const draft = (index: number, to: `0x${string}`, value: bigint, gas: bigint, maxFee: bigint, tip: bigint, nonce: number) =>
    account(index).signTransaction({ type: 'eip1559', chainId: asset.chainId!, nonce, to, value, gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip });

  return {
    async address(index) {
      return { index, address: account(index).address };
    },
    async scan(r) {
      const b = await balances(r.address);
      const seen = b.pending > b.now ? b.pending : b.now;
      const spendable = b.settled < b.now ? b.settled : b.now;
      return { seen, spendable, txids: [], confirmed: spendable >= seen, busy: b.busy };
    },
    async quote(r) {
      const b = await balances(r.address);
      const spendable = b.settled < b.now ? b.settled : b.now;
      if (b.busy || spendable <= 0n) return null;
      const { maxFee, tip } = await fees();
      // Arbitrum's gas limit includes its L1 cost, so ask rather than assume 21k; a little headroom either way.
      const estimated = BigInt(await call<string>('eth_estimateGas', [{ from: r.address, to: r.address, value: hex(1) }]));
      const gas = estimated <= 21_000n ? 21_000n : (estimated * 13n) / 10n;
      const nonce = Number(BigInt(await call<string>('eth_getTransactionCount', [r.address, 'pending'])));
      const l1 = asset.opStack ? (await l1Fee(await draft(r.index, r.address as `0x${string}`, spendable / 2n, gas, maxFee, tip, nonce))) * 2n : 0n;
      const fee = gas * maxFee + l1;
      if (fee > cap) throw new Error(`${asset.network} gas is unusually expensive right now; waiting.`);
      if (spendable <= fee * 10n) return null; // the fee would eat more than a tenth: too little to move
      return { amount: spendable - fee, fee, gas: gas.toString(), maxFee: maxFee.toString() };
    },
    async prepare(r, to, q) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error(`Not a ${asset.network} address.`);
      const acct = account(r.index);
      if (acct.address.toLowerCase() !== r.address.toLowerCase()) throw new Error('The Wallet address does not match the wallet key.');
      const [balance, nonce, f] = await Promise.all([
        call<string>('eth_getBalance', [r.address, 'latest']).then(BigInt),
        call<string>('eth_getTransactionCount', [r.address, 'pending']).then((n) => Number(BigInt(n))),
        fees(),
      ]);
      const estimated = BigInt(await call<string>('eth_estimateGas', [{ from: r.address, to, value: hex(q.amount) }]));
      const gas = BigInt(q.gas ?? '21000') > estimated ? BigInt(q.gas ?? '21000') : (estimated * 13n) / 10n;
      const raw0 = await draft(r.index, to as `0x${string}`, q.amount, gas, f.maxFee, f.tip, nonce);
      const l1 = (await l1Fee(raw0)) * 2n;
      // Fit gas into what's left after the exact amount (and the L1 fee).
      const room = (balance - q.amount - l1) / gas;
      const maxFee = room < f.maxFee ? room : f.maxFee;
      if (maxFee <= 0n || maxFee < f.tip / 2n) throw new Error(`Not enough ${asset.symbol} left for gas right now; quoting again.`);
      const fee = gas * maxFee + l1;
      if (fee > cap || fee * 10n > q.amount) throw new Error(`Refusing a ${asset.network} fee of up to ${fee} for ${q.amount}.`);
      const raw = await draft(r.index, to as `0x${string}`, q.amount, gas, maxFee, f.tip < maxFee ? f.tip : maxFee, nonce);
      return { txids: [keccak256(raw)], raw: [raw], amount: q.amount, fee };
    },
    async broadcast(raw) {
      try {
        await call<string>('eth_sendRawTransaction', [raw]);
      } catch (e) {
        if (/already known|nonce too low|known transaction/i.test((e as Error).message)) return; // it's out there already
        throw e;
      }
    },
    async status(_r, txid) {
      const tx = await call<{ blockNumber: string | null } | null>('eth_getTransactionByHash', [txid]);
      if (!tx) return null;
      if (!tx.blockNumber) return { confirmations: 0 };
      return { confirmations: Number(BigInt(await call<string>('eth_blockNumber', [])) - BigInt(tx.blockNumber)) + 1 };
    },
  };
}

// ---------------------------------------------------------------- Solana

const SYSTEM_PROGRAM = new Uint8Array(32);
/** One signature: Solana's base fee. No priority fee. */
const SOL_FEE = 5000n;

/** Solana's compact-u16 length prefix. */
function shortVec(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (!v) return [...out, b];
    b |= 0x80;
    out.push(b);
  }
}

/** A legacy transaction with one System Program transfer of `lamports` from `from` to `to`, signed by `from`. */
export function solTransfer(secret: Uint8Array, to: string, lamports: bigint, blockhash: string): { raw: Uint8Array; signature: string } {
  const from = ed25519Public(secret);
  const dest = base58.decode(to);
  if (dest.length !== 32) throw new Error('Not a Solana address.');
  if (bytesToHex(dest) === bytesToHex(from)) throw new Error('Refusing to send to the same address.');
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // SystemInstruction::Transfer
  view.setBigUint64(4, lamports, true);
  const message = Uint8Array.from([
    1, 0, 1, // one signer (writable), no read-only signers, one read-only account (the System Program)
    ...shortVec(3),
    ...from,
    ...dest,
    ...SYSTEM_PROGRAM,
    ...base58.decode(blockhash),
    ...shortVec(1),
    2, // program: account 2
    ...shortVec(2),
    0,
    1,
    ...shortVec(data.length),
    ...data,
  ]);
  const sig = ed25519Sign(message, secret);
  return { raw: Uint8Array.from([...shortVec(1), ...sig, ...message]), signature: base58.encode(sig) };
}

function solChain(asset: Asset): Chain {
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let last: unknown;
    for (const url of asset.rpcUrls!()) {
      try {
        const res = await chainFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: timeout() });
        if (!res.ok) throw new ChainUnavailable(`Solana RPC answered ${res.status}`);
        const json = (await res.json()) as { result?: T; error?: { message: string } };
        if (json.error) throw new ChainUnavailable(json.error.message);
        return json.result as T;
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof ChainUnavailable ? last : new ChainUnavailable(String((last as Error)?.message ?? 'No Solana RPC answered'));
  }
  const secret = (index: number) => ed25519KeyAt(stashPath(asset, index));
  const bal = async (address: string, commitment: 'processed' | 'finalized') => BigInt((await call<{ value: number }>('getBalance', [address, { commitment }])).value);

  return {
    async address(index) {
      return { index, address: base58.encode(ed25519Public(secret(index))) };
    },
    async scan(r) {
      const [seen, spendable, sigs] = await Promise.all([
        bal(r.address, 'processed'),
        bal(r.address, 'finalized'),
        call<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [r.address, { limit: 10, commitment: 'confirmed' }]).catch(() => []),
      ]);
      return { seen, spendable, txids: sigs.filter((s) => !s.err).map((s) => s.signature), confirmed: spendable >= seen, busy: false };
    },
    async quote(r) {
      const spendable = await bal(r.address, 'finalized');
      if (spendable <= SOL_FEE * 10n) return null;
      return { amount: spendable - SOL_FEE, fee: SOL_FEE }; // everything goes: the account closes, so no rent is left behind
    },
    async prepare(r, to, q) {
      const key = secret(r.index);
      if (base58.encode(ed25519Public(key)) !== r.address) throw new Error('The Wallet address does not match the wallet key.');
      // Everything goes, so the account closes and no rent is left behind (whatever arrived since the quote too).
      const amount = (await bal(r.address, 'finalized')) - SOL_FEE;
      if (amount < q.amount) throw new Error('The Solana balance dropped since the quote; quoting again.');
      const { value } = await call<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'finalized' }]);
      const tx = solTransfer(key, to, amount, value.blockhash);
      return { txids: [tx.signature], raw: [base64.encode(tx.raw)], amount, fee: SOL_FEE, blockhash: value.blockhash };
    },
    async broadcast(raw) {
      await call<string>('sendTransaction', [raw, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]);
    },
    async status(_r, txid) {
      const { value } = await call<{ value: ({ confirmations: number | null; confirmationStatus?: string; err: unknown } | null)[] }>('getSignatureStatuses', [[txid], { searchTransactionHistory: true }]);
      const s = value[0];
      if (!s || s.err) return null;
      return { confirmations: s.confirmationStatus === 'finalized' ? 32 : (s.confirmations ?? 0) + 1 };
    },
    async expired(s) {
      if (!s.blockhash) return false;
      const { value } = await call<{ value: boolean }>('isBlockhashValid', [s.blockhash, { commitment: 'processed' }]);
      return !value;
    },
  };
}

// ---------------------------------------------------------------- Monero (the Wallet's own account)

const xmrChain: Chain = {
  async address() {
    return xmr.newSubaddress('wallet', 'stash');
  },
  async scan(r) {
    const [rows, b] = await Promise.all([xmr.incoming(r.index, 'stash'), xmr.balance(r.index, 'stash')]);
    return {
      seen: b.total,
      spendable: b.unlocked,
      txids: rows.filter((t) => t.pool || t.confirmations < 60).map((t) => t.txid),
      confirmed: b.unlocked >= b.total,
      busy: false,
    };
  },
  async quote(r) {
    const b = await xmr.balance(r.index, 'stash');
    if (b.unlocked <= 0n || b.unlocked < b.total) return null;
    // A sweep to our own address, never relayed: only its fee matters.
    const dry = await xmr.prepareSweep(r.index, r.address, 'stash');
    return { amount: dry.amount, fee: dry.fee };
  },
  async prepare(r, to) {
    const s = await xmr.prepareSweep(r.index, to, 'stash');
    return { txids: s.txids, raw: s.metadata, amount: s.amount, fee: s.fee };
  },
  async broadcast(raw) {
    await xmr.relay(raw);
  },
  async status(_r, txid) {
    const s = await xmr.sent(txid, 'stash');
    return s && !s.failed ? { confirmations: s.confirmations } : null;
  },
};

const cache = new Map<string, Chain>();

export function chainOf(asset: Asset): Chain {
  let c = cache.get(asset.id);
  if (!c) {
    c = asset.kind === 'utxo' ? utxoChain(asset) : asset.kind === 'evm' ? evmChain(asset) : asset.kind === 'sol' ? solChain(asset) : xmrChain;
    cache.set(asset.id, c);
  }
  return c;
}
