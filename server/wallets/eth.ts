import { bytesToHex } from '@noble/hashes/utils.js';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { rpc } from '../chain.js';
import type { HotWallet, RouteRef, Scan } from './index.js';
import { keyAt } from './seed.js';

/**
 * Ethereum hot wallet: m/44'/60'/0'/0/i from the seed, EIP-1559 transactions signed locally, sent through the
 * public RPCs already configured. A forward sends exactly the FixedFloat order amount; enough is kept back for gas,
 * and whatever gas isn't used stays behind as dust for the next forward.
 */

const CONFIRMATIONS = 12;
const GWEI = 1_000_000_000n;
/** Ceilings, whatever a public RPC claims: a bad answer must not turn the payment into gas. */
const MAX_TIP = 5n * GWEI;
const MAX_FEE_PER_GAS = 300n * GWEI;
const MAX_FEE = 10n ** 16n; // 0.01 ETH per forward
/** Gas kept back when quoting: a plain transfer needs 21k; a deposit contract may need more. */
const GAS_RESERVE = 60_000n;
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

export const ethPath = (index: number) => `m/44'/60'/0'/0/${index}`;
const account = (index: number) => privateKeyToAccount(`0x${bytesToHex(keyAt(ethPath(index)).privateKey!)}`);
export const ethAddress = (index: number) => account(index).address;

async function fees(): Promise<{ maxFee: bigint; tip: bigint }> {
  const [block, tipHex] = await Promise.all([
    rpc<{ baseFeePerGas?: string }>('eth_getBlockByNumber', ['latest', false]),
    rpc<string>('eth_maxPriorityFeePerGas', []).catch(() => hex(1_000_000_000n)),
  ]);
  const base = BigInt(block.baseFeePerGas ?? '0x0');
  const asked = BigInt(tipHex) > 0n ? BigInt(tipHex) : GWEI;
  const tip = asked < MAX_TIP ? asked : MAX_TIP;
  const maxFee = base * 2n + tip;
  if (maxFee > MAX_FEE_PER_GAS) throw new Error(`Ethereum gas is unusually expensive right now (${maxFee / GWEI} gwei); waiting.`);
  return { maxFee, tip };
}

/** What a plain transfer (21k gas) would pay right now (base fee + tip), in wei: for the fee estimates. */
export async function ethTransferFee(): Promise<bigint> {
  const { maxFee, tip } = await fees();
  return 21_000n * ((maxFee - tip) / 2n + tip);
}

async function balances(address: string) {
  const latest = Number(BigInt(await rpc<string>('eth_blockNumber', [])));
  const [now, settled, pending, nonceLatest, noncePending] = await Promise.all([
    rpc<string>('eth_getBalance', [address, 'latest']),
    rpc<string>('eth_getBalance', [address, hex(Math.max(0, latest - (CONFIRMATIONS - 1)))]),
    rpc<string>('eth_getBalance', [address, 'pending']),
    rpc<string>('eth_getTransactionCount', [address, 'latest']),
    rpc<string>('eth_getTransactionCount', [address, 'pending']),
  ]);
  return { latest, now: BigInt(now), settled: BigInt(settled), pending: BigInt(pending), busy: BigInt(noncePending) > BigInt(nonceLatest) };
}

export const ethWallet: HotWallet = {
  coin: 'ETH',
  decimals: 18,

  async scan(r: RouteRef) {
    const b = await balances(r.address);
    const seen = b.pending > b.now ? b.pending : b.now;
    // Spendable = what has been there for 12 blocks and is still there.
    const spendable = b.settled < b.now ? b.settled : b.now;
    return {
      seen,
      spendable,
      txids: [],
      confirmations: spendable >= seen ? CONFIRMATIONS : b.now >= seen ? Math.floor(CONFIRMATIONS / 2) : 0,
      required: CONFIRMATIONS,
      busy: b.busy,
    } satisfies Scan;
  },

  async quote(r) {
    const b = await balances(r.address);
    if (b.busy) return null;
    const spendable = b.settled < b.now ? b.settled : b.now;
    const { maxFee } = await fees();
    const fee = GAS_RESERVE * maxFee;
    if (spendable <= fee) return null;
    return { amount: spendable - fee, fee };
  },

  async prepare(r, to, amount) {
    const acct = account(r.index);
    if (acct.address.toLowerCase() !== r.address.toLowerCase()) throw new Error('The permanent address does not match the wallet key.');
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('Not an Ethereum address.');
    const [balance, nonce, { maxFee, tip }] = await Promise.all([
      rpc<string>('eth_getBalance', [r.address, 'latest']).then(BigInt),
      rpc<string>('eth_getTransactionCount', [r.address, 'pending']).then((n) => Number(BigInt(n))),
      fees(),
    ]);
    const estimated = BigInt(await rpc<string>('eth_estimateGas', [{ from: r.address, to, value: hex(amount) }]));
    const gas = estimated <= 21_000n ? 21_000n : (estimated * 5n) / 4n;
    if (gas > GAS_RESERVE) throw new Error(`Refusing a forward that needs ${gas} gas.`);
    // Fit the fee into what's left after the exact order amount.
    const room = (balance - amount) / gas;
    const maxFeePerGas = room < maxFee ? room : maxFee;
    if (maxFeePerGas < tip) throw new Error('Not enough ETH left for gas right now; trying again shortly.');
    const fee = gas * maxFeePerGas;
    if (fee > MAX_FEE || fee * 10n > amount) throw new Error(`Refusing an Ethereum fee of up to ${fee} wei for ${amount} wei.`);
    const raw = await acct.signTransaction({ type: 'eip1559', chainId: 1, nonce, to: to as `0x${string}`, value: amount, gas, maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas });
    return { txids: [keccak256(raw)], raw: [raw], amount, fee: gas * maxFeePerGas };
  },

  async broadcast(raw) {
    await rpc<string>('eth_sendRawTransaction', [raw]);
  },

  async status(txid) {
    const tx = await rpc<{ blockNumber: string | null } | null>('eth_getTransactionByHash', [txid]);
    if (!tx) return null;
    if (!tx.blockNumber) return { confirmations: 0 };
    return { confirmations: Number(BigInt(await rpc<string>('eth_blockNumber', [])) - BigInt(tx.blockNumber)) + 1 };
  },
};
