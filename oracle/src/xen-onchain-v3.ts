/**
 * A second XEN price source (FEATURE-MATRIX gap 3): when GeckoTerminal cannot answer for a chain, its XEN market is read
 * from the chain itself, at the build's toBlock, so a GeckoTerminal outage (or an API change) can no longer stop burner
 * payouts for good. Anyone can re-read it: `verify --full` re-reads the same pools at the same block (index.ts).
 *
 * Which pools: the eligible pools the chain's last VALUED record lists (market.pools of the newest published v3 epoch
 * file that valued the chain: the pools GeckoTerminal identified then, deepest first; at most ONCHAIN_MAX_POOLS). Pools
 * are not discovered here: without GeckoTerminal the oracle only re-reads pools it already knew.
 *
 * The same rules as the GeckoTerminal read (pricing.ts xenMarketOfV3), applied to on-chain data:
 *   - a pool counts only when its other token (read from the pool: token0 / token1) is on QUOTE_ALLOWLIST, its reserves
 *     are worth at least $50, and its XEN price is within 3× of the reference;
 *   - the reference is the one the engine itself uses for the chain this epoch: the median of the record's xenUsdE18 and
 *     its last references (rewards.ts prevState / medianE18). GeckoTerminal's token price is unavailable by definition;
 *   - a pool's XEN price = its quote per XEN (Uniswap v2 getReserves, else Uniswap v3 slot0) × Chainlink's USD price of
 *     the quote token at the same block (the A5-c feeds, pricing.ts chainlinkUsdV3); a pool whose quote has no listed
 *     feed or no fresh round is left out;
 *   - spot = the reserve-weighted price, liquidity = half the reserves, the price pool = the deepest: the same formulas.
 * And the engine's own rules apply unchanged (rewards.ts): no hourly candle is read for such a chain (GeckoTerminal's
 * candles need its base/quote orientation, unknown without it), so every burn is priced by the existing "fallback" rule,
 * the build spot never above the cap of 1.25 × the reference; then the clamps and the per-chain curve, as always.
 *
 * Nothing is weakened: a chain with no valued record, no reference, no eligible pool or no Chainlink round is skipped
 * with its cursor kept, exactly as before, and the GeckoTerminal error stays the reason (so the D-21 "no market"
 * classification is unchanged). The record says where its market came from: market.priceSource is the market's `source`
 * (ONCHAIN_SOURCE_PREFIX …) once flow-v3.ts marketV3 writes `(m as { source?: string }).source ?? <the GeckoTerminal
 * text>`; `verify --full` and the health row key on that prefix.
 */
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { ChainConfig, EPOCHS_DIR } from "./config";
import { toE18 } from "./epoch";
import { withFailover } from "./evm";
import { chainlinkUsdV3, QUOTE_ALLOWLIST, XenMarketDetailV3 } from "./pricing";
import { medianE18 } from "./rewards";

/** the start of market.priceSource for a market read on-chain */
export const ONCHAIN_SOURCE_PREFIX = "on-chain:";
/** the most pools re-read per chain (the recorded list is deepest first) */
export const ONCHAIN_MAX_POOLS = 8;
/** the GeckoTerminal rule's minimum reserve (reserve_in_usd >= 50), in USD × 1e18 */
export const ONCHAIN_MIN_RESERVE_E18 = 50n * 10n ** 18n;
/** the ±3× band around the reference */
export const ONCHAIN_BAND = 3n;
const E18 = 10n ** 18n;
const Q192 = 1n << 192n;

/** What the newest published v3 files say about a chain: the pools to re-read and the engine's reference for it. */
export interface OnChainPriorV3 {
  /** the epoch of the record the pools come from */
  epoch: number;
  /** the engine's reference for the chain in the next epoch (USD × 1e18): median of [xenUsdE18, …refInputs[0..3]] */
  refE18: bigint;
  /** 20-byte pool addresses, deepest first */
  pools: string[];
  /** the price pool of that record and its creation time (D-13), carried when the same pool is the price pool again */
  topPool: string | null;
  poolCreatedAt: number | null;
}

interface ChainRecLite {
  chainId?: unknown;
  skipped?: unknown;
  xenUsdE18?: unknown;
  refInputs?: unknown;
  poolCreatedAt?: unknown;
  market?: { pools?: { address?: unknown }[] } | null;
}
interface FileLite {
  version?: unknown;
  epoch?: unknown;
  publish?: { tx?: unknown } | null;
  chains?: ChainRecLite[];
}

const big = (v: unknown): bigint => {
  try {
    return typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : 0n;
  } catch {
    return 0n;
  }
};
const isPoolAddress = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

/**
 * The prior of chain `chainId` from published v3 epoch files (pure). The reference comes from the NEWEST file's record of
 * the chain (valued or skipped: its xenUsdE18 and refInputs are what the engine reads next); the pools from the newest
 * record that valued the chain. null when either is missing or the reference is 0.
 */
export function onChainPriorOfV3(files: unknown[], chainId: number): OnChainPriorV3 | null {
  const v3 = (files as FileLite[])
    .filter((f) => f && f.version === 3 && typeof f.epoch === "number" && !!f.publish && typeof f.publish.tx === "string" && Array.isArray(f.chains))
    .sort((a, b) => (b.epoch as number) - (a.epoch as number));
  const recOf = (f: FileLite) => (f.chains ?? []).find((c) => c && c.chainId === chainId) ?? null;
  const newest = v3.map(recOf).find((r) => r !== null) ?? null;
  if (!newest) return null;
  const refInputs = Array.isArray(newest.refInputs) ? newest.refInputs.slice(0, 3) : [];
  const refE18 = medianE18([big(newest.xenUsdE18), ...refInputs.map(big)]);
  if (refE18 === 0n) return null;
  for (const f of v3) {
    const r = recOf(f);
    if (!r || r.skipped === true || !r.market || !Array.isArray(r.market.pools)) continue;
    const pools = r.market.pools.map((p) => p?.address).filter(isPoolAddress).slice(0, ONCHAIN_MAX_POOLS);
    if (!pools.length) continue;
    const created = typeof r.poolCreatedAt === "number" && Number.isSafeInteger(r.poolCreatedAt) ? r.poolCreatedAt : null;
    return { epoch: f.epoch as number, refE18, pools, topPool: pools[0], poolCreatedAt: created };
  }
  return null;
}

/** The published epoch files of a directory (any version; unreadable files skipped). */
export function publishedEpochFilesOf(dir: string = EPOCHS_DIR): unknown[] {
  if (!fs.existsSync(dir)) return [];
  const out: unknown[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^epoch-\d+\.json$/.test(name)) continue;
    try {
      const f = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (f && f.publish) out.push(f);
    } catch {
      /* a broken file is not a prior */
    }
  }
  return out;
}

/** One pool as read at the block (raw integers as decimal strings, so a reading can be recorded and replayed). */
export interface OnChainPoolReadV3 {
  address: string;
  /** the pool's other token (lowercase) and whether XEN is token0 */
  quote: string;
  xenIsToken0: boolean;
  xenDecimals: number;
  quoteDecimals: number;
  kind: "v2" | "v3";
  /** v2: the two reserves (token0, token1); v3: sqrtPriceX96 */
  reserve0?: string;
  reserve1?: string;
  sqrtPriceX96?: string;
  /** v3: the pool fee in hundredths of a basis point (3000 = 0.3%) */
  fee?: number;
  /** the pool's balances of XEN and of the quote token */
  xenBalance: string;
  quoteBalance: string;
  /** Chainlink's USD price of the quote token at the block (USD × 1e18); null = no listed feed or no fresh round */
  quoteUsdE18: string | null;
}

/** quote per XEN, × 1e18, in whole tokens (pure); 0 when the pool holds no XEN side. */
export function quotePerXenE18V3(r: OnChainPoolReadV3): bigint {
  const scaleUp = 10n ** BigInt(18 + r.xenDecimals);
  const scaleDown = 10n ** BigInt(r.quoteDecimals);
  if (r.kind === "v2") {
    const r0 = big(r.reserve0);
    const r1 = big(r.reserve1);
    const rx = r.xenIsToken0 ? r0 : r1;
    const rq = r.xenIsToken0 ? r1 : r0;
    return rx === 0n ? 0n : (rq * scaleUp) / (rx * scaleDown);
  }
  const s = big(r.sqrtPriceX96);
  const p = s * s; // token1 per token0 (raw units) × 2^192
  if (p === 0n) return 0n;
  return r.xenIsToken0 ? (p * scaleUp) / (Q192 * scaleDown) : (Q192 * scaleUp) / (p * scaleDown);
}

/** A pool's XEN price and reserves in USD × 1e18, and whether it counts (the GeckoTerminal rules), pure. */
export function poolValueV3(r: OnChainPoolReadV3, gecko: string, refE18: bigint): { xenUsdE18: bigint; reserveUsdE18: bigint; eligible: boolean; why: string | null } {
  const allow = new Set((QUOTE_ALLOWLIST[gecko] ?? []).map((a) => a.toLowerCase()));
  if (!allow.has(r.quote.toLowerCase())) return { xenUsdE18: 0n, reserveUsdE18: 0n, eligible: false, why: "its other token is not an allowlisted quote" };
  if (r.quoteUsdE18 === null) return { xenUsdE18: 0n, reserveUsdE18: 0n, eligible: false, why: "no fresh Chainlink round for its quote token" };
  const q = big(r.quoteUsdE18);
  const xenUsdE18 = (quotePerXenE18V3(r) * q) / E18;
  const reserveUsdE18 = (big(r.xenBalance) * xenUsdE18) / 10n ** BigInt(r.xenDecimals) + (big(r.quoteBalance) * q) / 10n ** BigInt(r.quoteDecimals);
  if (reserveUsdE18 < ONCHAIN_MIN_RESERVE_E18) return { xenUsdE18, reserveUsdE18, eligible: false, why: "reserves under $50" };
  if (xenUsdE18 === 0n || xenUsdE18 > refE18 * ONCHAIN_BAND || xenUsdE18 * ONCHAIN_BAND < refE18) return { xenUsdE18, reserveUsdE18, eligible: false, why: "priced more than 3× away from the reference" };
  return { xenUsdE18, reserveUsdE18, eligible: true, why: null };
}

/** the market's source text (recorded as market.priceSource) */
export const onChainSourceTextV3 = (n: number, block: number) => `${ONCHAIN_SOURCE_PREFIX} reserve-weighted spot of ${n} eligible pools at block ${block} (GeckoTerminal unavailable)`;
export const isOnChainSourceV3 = (s: unknown): boolean => typeof s === "string" && s.startsWith(ONCHAIN_SOURCE_PREFIX);

export type OnChainMarketV3 = XenMarketDetailV3 & { source: string; block: number };

/**
 * The market of a chain from its pools as read at `block` (pure; the GeckoTerminal formulas): throws when no pool counts
 * (the message never contains the D-21 "no XEN market" words: the caller keeps GeckoTerminal's error).
 */
export function onChainMarketOfV3(chain: ChainConfig, reads: OnChainPoolReadV3[], prior: Pick<OnChainPriorV3, "refE18" | "topPool" | "poolCreatedAt">, block: number): OnChainMarketV3 {
  const why: string[] = [];
  const pools: { r: OnChainPoolReadV3; xenUsdE18: bigint; reserveUsdE18: bigint }[] = [];
  for (const r of reads) {
    const v = poolValueV3(r, chain.gecko, prior.refE18);
    if (v.eligible) pools.push({ r, xenUsdE18: v.xenUsdE18, reserveUsdE18: v.reserveUsdE18 });
    else why.push(`${r.address}: ${v.why}`);
  }
  if (!pools.length) throw new Error(`no eligible on-chain pool for ${chain.name} at block ${block}${why.length ? ` (${why.join("; ").slice(0, 300)})` : ""}`);
  pools.sort((a, b) => (a.reserveUsdE18 > b.reserveUsdE18 ? -1 : a.reserveUsdE18 < b.reserveUsdE18 ? 1 : a.r.address.toLowerCase() < b.r.address.toLowerCase() ? -1 : 1));
  const total = pools.reduce((s, p) => s + p.reserveUsdE18, 0n);
  const spotE18 = pools.reduce((s, p) => s + p.xenUsdE18 * p.reserveUsdE18, 0n) / total;
  const top = pools[0];
  const feeBps = top.r.kind === "v3" && typeof top.r.fee === "number" && top.r.fee > 0 && top.r.fee < 1_000_000 ? Math.round(top.r.fee / 100) : 30;
  return {
    refUsd: Number(prior.refE18) / 1e18,
    spotUsd: Number(spotE18) / 1e18,
    liquidityUsd: Number(total) / 2 / 1e18,
    topPool: top.r.address,
    xenIsBase: top.r.xenIsToken0,
    pools: pools.map((p) => ({ address: p.r.address, reserveUsd: Math.round(Number(p.reserveUsdE18) / 1e16) / 100 })),
    poolCreatedAt: prior.topPool !== null && prior.topPool.toLowerCase() === top.r.address.toLowerCase() ? prior.poolCreatedAt : null,
    quote: { address: top.r.quote, usd: Number(big(top.r.quoteUsdE18)) / 1e18, feeBps },
    source: onChainSourceTextV3(pools.length, block),
    block,
  };
}

const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
const POOL = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function slot0() view returns (uint160, int24)",
  "function fee() view returns (uint24)",
];

/** The prior's pools read at `block` through the chain's RPCs (one provider for the whole reading; read-only eth_calls). */
export async function readOnChainPoolsV3(chain: ChainConfig, pools: string[], block: number, quoteUsd = chainlinkUsdV3): Promise<OnChainPoolReadV3[]> {
  const readable = pools.filter(isPoolAddress).slice(0, ONCHAIN_MAX_POOLS);
  if (!readable.length) return [];
  const raw = await withFailover(chain, `XEN pools@${block}`, async (p) => {
    const at = { blockTag: block };
    const xen = new ethers.Contract(chain.xen, ERC20, p);
    const xenDecimals = Number(await xen.decimals(at));
    const out: Omit<OnChainPoolReadV3, "quoteUsdE18">[] = [];
    for (const address of readable) {
      const pool = new ethers.Contract(address, POOL, p);
      let t0: string;
      let t1: string;
      try {
        [t0, t1] = [String(await pool.token0(at)).toLowerCase(), String(await pool.token1(at)).toLowerCase()];
      } catch {
        continue; // not a pool contract (or gone): left out
      }
      const x = chain.xen.toLowerCase();
      if (t0 !== x && t1 !== x) continue;
      const xenIsToken0 = t0 === x;
      const quote = xenIsToken0 ? t1 : t0;
      const q = new ethers.Contract(quote, ERC20, p);
      let r: Pick<OnChainPoolReadV3, "kind" | "reserve0" | "reserve1" | "sqrtPriceX96" | "fee">;
      try {
        const res = await pool.getReserves(at);
        r = { kind: "v2", reserve0: BigInt(res[0]).toString(), reserve1: BigInt(res[1]).toString() };
      } catch {
        try {
          const s0 = await pool.slot0(at);
          const fee = await pool.fee(at).then((f: bigint) => Number(f)).catch(() => undefined);
          r = { kind: "v3", sqrtPriceX96: BigInt(s0[0]).toString(), ...(fee === undefined ? {} : { fee }) };
        } catch {
          continue; // neither a v2 pair nor a v3 pool: its price cannot be read
        }
      }
      out.push({
        address, quote, xenIsToken0, xenDecimals, quoteDecimals: Number(await q.decimals(at)), ...r,
        xenBalance: BigInt(await xen.balanceOf(address, at)).toString(), quoteBalance: BigInt(await q.balanceOf(address, at)).toString(),
      });
    }
    return out;
  });
  const usd = new Map<string, string | null>();
  const reads: OnChainPoolReadV3[] = [];
  for (const r of raw) {
    if (!usd.has(r.quote)) usd.set(r.quote, (await quoteUsd(chain, r.quote, block).catch(() => null))?.usdE18 ?? null);
    reads.push({ ...r, quoteUsdE18: usd.get(r.quote) ?? null });
  }
  return reads;
}

/** The chain's XEN market read on-chain at `block` from the prior's pools (live). */
export async function xenMarketOnChainV3(chain: ChainConfig, prior: Pick<OnChainPriorV3, "refE18" | "pools" | "topPool" | "poolCreatedAt">, block: number): Promise<OnChainMarketV3> {
  return onChainMarketOfV3(chain, await readOnChainPoolsV3(chain, prior.pools, block), prior, block);
}

/**
 * GeckoTerminal first; when it fails for this chain, the on-chain market (above) at the chain's toBlock. When the
 * fallback cannot price the chain either, GeckoTerminal's own error is thrown (its text first), so the run skips the
 * chain with its cursor kept and classifies the skip exactly as before (D-21: isNoMarketErrorV3 reads that text).
 */
export async function xenMarketWithFallbackV3(
  chain: ChainConfig,
  o: {
    gecko: () => Promise<XenMarketDetailV3>;
    onChain: (prior: OnChainPriorV3, block: number) => Promise<OnChainMarketV3>;
    prior: () => OnChainPriorV3 | null;
    /** the chain's toBlock (its final head as read by this run); undefined: not read yet */
    head: () => number | undefined;
    log?: (m: string) => void;
  },
): Promise<XenMarketDetailV3 | OnChainMarketV3> {
  try {
    return await o.gecko();
  } catch (e) {
    const gecko = String((e as Error)?.message ?? e).slice(0, 200);
    const prior = o.prior();
    const block = o.head();
    let why: string;
    if (!prior) why = "no published v3 record of this chain to take its pools and reference from";
    else if (block === undefined) why = "the chain's final block was not read";
    else {
      try {
        const m = await o.onChain(prior, block);
        o.log?.(`  ${chain.name}: GeckoTerminal failed (${gecko}): priced from on-chain reserves of ${m.pools.length} pool(s) at block ${block}, Chainlink quote prices; every burn at the build spot (the existing fallback rule)`);
        return m;
      } catch (f) {
        why = String((f as Error)?.message ?? f).slice(0, 300);
      }
    }
    throw new Error(`${gecko}; on-chain fallback: ${why}`);
  }
}

/** `verify --full` (pure): what differs between a record's on-chain market and the same pools re-read at its toBlock. */
export function onChainMarketMismatchV3(
  rec: { name: string; market: { spotE18: string; refUsdE18: string; priceSource: string; pools: { address: string; reserveUsd: string }[] } | null; L: { now: string | null } },
  again: OnChainMarketV3,
): string[] {
  const out: string[] = [];
  const m = rec.market;
  if (!m) return [`${rec.name}: no market recorded`];
  if (m.priceSource !== again.source) out.push(`${rec.name}: price source "${m.priceSource}", the re-read says "${again.source}"`);
  if (m.spotE18 !== toE18(again.spotUsd)) out.push(`${rec.name}: on-chain spot ${m.spotE18}, the re-read gives ${toE18(again.spotUsd)}`);
  if (m.refUsdE18 !== toE18(again.refUsd)) out.push(`${rec.name}: reference ${m.refUsdE18}, the engine's is ${toE18(again.refUsd)}`);
  const pools = (x: { address: string; reserveUsd: string | number }[]) => JSON.stringify(x.map((p) => [p.address.toLowerCase(), String(p.reserveUsd)]));
  if (pools(m.pools) !== pools(again.pools)) out.push(`${rec.name}: the eligible pools or their reserves differ from the re-read`);
  const now = BigInt(Math.floor(again.liquidityUsd * 1e6)).toString();
  if (rec.L.now !== now) out.push(`${rec.name}: liquidity now ${rec.L.now}, the re-read gives ${now}`);
  return out;
}
