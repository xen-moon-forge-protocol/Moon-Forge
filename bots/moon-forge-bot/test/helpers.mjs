// Shared fakes for the tests: a quote shaped like the kit's, a fake EVM RPC, a fake key, a logger that keeps its lines.
import crypto from 'node:crypto';
import { bs58 } from '../../../agents/kit/burn.mjs';
import { DEFAULTS, merge, validateConfig } from '../src/config.mjs';
import { createLogger } from '../src/log.mjs';

export const XEN = 10n ** 18n;
export const LAMPORTS = 1_000_000_000n;

/** A fresh on-curve X1 address (an ed25519 public key in base58). */
export function x1Address() {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  return bs58.encode(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'));
}

/** A valid config for tests (dry run), with overrides merged in. */
export function testConfig(over = {}) {
  const x1 = over.x1Destination ?? x1Address();
  const cfg = merge(structuredClone(DEFAULTS), {
    x1Destination: x1, x1DestinationConfirm: x1.slice(-6), stateFile: null, logFile: null, killSwitchFile: null,
    burn: { limits: { maxXenPerBurn: '1000000', maxXenPerDay: '3000000' }, chains: { 10: { rpcs: ['https://rpc.invalid'] }, 8453: { rpcs: ['https://rpc.invalid'] } } },
    claims: { enabled: false }, artifacts: { alerts: false },
  });
  const full = merge(cfg, over);
  const v = validateConfig(full);
  if (!v.ok) throw new Error(`test config invalid: ${v.errors.join('; ')}`);
  return { cfg: full, limits: v.limits };
}

/**
 * A quote in the kit's shape. rate: lamports paid per whole XEN; remaining: today's slice in lamports;
 * market: lamports selling would fetch per whole XEN (null = unknown).
 */
export function fakeQuote({ amountWei, rate = 10n, remaining = 1_000n * LAMPORTS, market = 5n, ok = true, refusals = [] }) {
  const xen = BigInt(amountWei) / XEN;
  const binding = xen * rate;
  return {
    ok, refusals, amountWei: String(amountWei), bindingNow: binding, bindingNowXnt: Number(binding) / 1e9, entitlement: binding,
    marketRoute: market === null ? null : xen * market, marketRouteXnt: market === null ? null : Number(xen * market) / 1e9,
    tranche: { remainingToday: remaining, remainingTodayXnt: Number(remaining) / 1e9 },
  };
}

export function sinkLogger() {
  const lines = [];
  return { lines, log: createLogger({ quiet: true, sink: lines }) };
}

/** A fake EVM RPC. state: { chainId, latest, pending, fee, balance, xenBalance, revert, receipts, known, block } */
export function fakeRpc(over = {}) {
  const st = {
    chainId: 10n, latest: 5n, pending: 5n, fee: { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, gasPrice: 1_000_000_000n },
    balance: 10n ** 18n, xenBalance: 10n ** 30n, revert: false, receipts: new Map(), known: new Set(), block: 100, broadcastFails: false, sent: [],
    ...over,
  };
  return {
    st,
    chainId: async () => st.chainId,
    call: async (req) => {
      if (st.revert) throw new Error('execution reverted');
      if (String(req.data).startsWith('0x70a08231')) return `0x${st.xenBalance.toString(16)}`; // balanceOf
      return '0x';
    },
    getTransactionCount: async (_a, tag) => (tag === 'pending' ? st.pending : st.latest),
    getFeeData: async () => st.fee,
    estimateGas: async () => 100_000n,
    getBalance: async () => st.balance,
    blockNumber: async () => st.block,
    broadcast: async (signed) => {
      st.sent.push(signed);
      if (st.broadcastFails === 'known') { st.known.add(`h:${signed}`); throw new Error('timeout'); }
      if (st.broadcastFails) throw new Error('connection reset');
      st.known.add(`h:${signed}`);
      return `h:${signed}`;
    },
    getTransaction: async (h) => (st.known.has(h) ? { hash: h } : null),
    getReceipt: async (h) => st.receipts.get(h) ?? null,
  };
}

export const fakeKey = { address: '0x00000000000000000000000000000000000000aa', sign: async (req) => `signed-${req.nonce}-${String(req.data).slice(0, 10)}`, hashOf: (s) => `h:${s}` };
