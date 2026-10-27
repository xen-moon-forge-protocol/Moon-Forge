/**
 * Market data used to value burns. Every value and its source is written into the epoch file,
 * so `npm run verify` can recompute the result without calling any API.
 *
 *  - Only pools whose other token is a liquid quote asset on QUOTE_ALLOWLIST (wrapped native token,
 *    major stablecoins, WETH) count, for price AND liquidity: a pool against a token the attacker
 *    controls costs nothing to fake.
 *  - Price pool = the eligible pool with the largest XEN-side liquidity (liquidity needs real
 *    capital to fake; volume only needs gas).
 *  - Burn-time price = MEDIAN of that pool's hourly closes over the 24 h ending at the burn hour
 *    (a brief spike moves the median by nothing).
 *  - Liquidity of each chain's XEN market: XEN-side USD reserves of its eligible pools. Used to
 *    discount what the market could really absorb (see epoch.ts — liquidity factor).
 *  - Clamps (index.ts): each chain's prices within ±50% of the median of its last 4 epoch
 *    references (first epoch of a chain: ±50% of the aggregator's token price); XNT within ±50%
 *    of the previous epoch's.
 *  - Total supply of each XEN contract at the epoch's last block (recorded for auditors).
 *  - XNT price: XDEX WXNT/USDC.X pool via x1report / XDEX APIs (GeckoTerminal misprices USDC.X
 *    on X1, so it is NOT used for XNT), or XNT_USD_OVERRIDE.
 */
import { ethers } from "ethers";
import { ChainConfig, MAX_PRICE_MOVE, XNT_USD_OVERRIDE } from "./config";
import { withFailover } from "./evm";

const GT = "https://api.geckoterminal.com/api/v2";
let lastCall = 0;
async function getJson(url: string): Promise<any> {
  // GeckoTerminal public API: 30 requests/minute
  const wait = lastCall + 2100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (r.ok) return r.json();
    if (r.status !== 429 && r.status < 500) throw new Error(`${url} -> HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, 5000 * (i + 1)));
  }
  throw new Error(`${url} -> unavailable`);
}

export interface PricePoint {
  usd: number;
  source: string;
  clamped?: boolean;
}

/** Liquid quote assets per GeckoTerminal network (lowercase addresses), verified 2026-10-07. */
export const QUOTE_ALLOWLIST: Record<string, string[]> = {
  eth: ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7", "0x6b175474e89094c44da98b954eedeac495271d0f"],
  optimism: ["0x4200000000000000000000000000000000000006", "0x0b2c639c533813f4aa9d7837caf62653d097ff85", "0x7f5c764cbc14f9669b88837ca1490cca17c31607", "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58"],
  bsc: ["0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", "0x55d398326f99059ff775485246999027b3197955", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", "0xe9e7cea3dedca5984780bafc599bd69add087d56", "0x2170ed0880ac9a755fd29b2688956bd959f933f8"],
  polygon_pos: ["0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"],
  avax: ["0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7", "0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664"],
  base: ["0x4200000000000000000000000000000000000006", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca"],
  pulsechain: ["0xa1077a294dde1b09bb078844df40758a5d0f9a27", "0xefd766ccb38eaf1dfd701853bfce31359239f305", "0x15d38573d2feeb82e7ad5187ab8c1d52810b1f07", "0x0cb6f5a34ad42ec934882a05265a7d5f59b51a2f"],
};

export function median(xs: number[]): number {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export interface XenMarket {
  /** aggregator token price (GeckoTerminal price_usd), the sanity reference */
  refUsd: number;
  spotUsd: number;
  liquidityUsd: number; // XEN-side USD liquidity (≈ half of each pool's reserves)
  topPool: string;
  xenIsBase: boolean;
  pools: { address: string; reserveUsd: number }[];
}

/**
 * XEN pools of one chain. Pool lists contain junk (fake tokens with absurd "reserves", stale
 * thin pools), so:
 *  - only pools against an allowlisted quote asset are considered;
 *  - the reference price is the aggregator's token price (GeckoTerminal `price_usd`);
 *  - pools priced more than 3× away from it are ignored for price AND liquidity;
 *  - the price pool is the eligible pool with the largest liquidity.
 */
export async function xenMarket(chain: ChainConfig): Promise<XenMarket> {
  const token = await getJson(`${GT}/networks/${chain.gecko}/tokens/${chain.xen}`);
  const ref = Number(token?.data?.attributes?.price_usd);
  if (!(ref > 0)) throw new Error(`no XEN price for ${chain.name}`);
  const j = await getJson(`${GT}/networks/${chain.gecko}/tokens/${chain.xen}/pools?page=1`);
  const xenId = `${chain.gecko}_${chain.xen.toLowerCase()}`;
  const allow = new Set((QUOTE_ALLOWLIST[chain.gecko] ?? []).map((a) => `${chain.gecko}_${a}`));
  const pools: { address: string; reserveUsd: number; price: number; volume: number; xenIsBase: boolean }[] = [];
  for (const p of j?.data ?? []) {
    const reserveUsd = Number(p.attributes.reserve_in_usd);
    const baseId = String(p.relationships?.base_token?.data?.id).toLowerCase();
    const quoteId = String(p.relationships?.quote_token?.data?.id).toLowerCase();
    const xenIsBase = baseId === xenId;
    const xenIsQuote = quoteId === xenId;
    if (!(reserveUsd >= 50) || (!xenIsBase && !xenIsQuote)) continue;
    if (!allow.has(xenIsBase ? quoteId : baseId)) continue; // other side must be a liquid quote asset
    const price = Number(xenIsBase ? p.attributes.base_token_price_usd : p.attributes.quote_token_price_usd);
    if (!(price > 0) || price > ref * 3 || price < ref / 3) continue;
    pools.push({ address: p.attributes.address, reserveUsd, price, volume: Number(p.attributes.volume_usd?.h24 ?? 0), xenIsBase });
  }
  if (!pools.length) throw new Error(`no XEN market found for ${chain.name}`);
  const totalReserve = pools.reduce((s, p) => s + p.reserveUsd, 0);
  const spotUsd = pools.reduce((s, p) => s + p.price * p.reserveUsd, 0) / totalReserve;
  pools.sort((a, b) => b.reserveUsd - a.reserveUsd);
  const pricePool = pools[0];
  return {
    refUsd: ref,
    spotUsd,
    liquidityUsd: totalReserve / 2,
    topPool: pricePool.address,
    xenIsBase: pricePool.xenIsBase,
    pools: pools.map((p) => ({ address: p.address, reserveUsd: Math.round(p.reserveUsd * 100) / 100 })),
  };
}

const priceCache = new Map<string, number>();

/** Median of the hourly closes of XEN on its chain's deepest eligible pool over the 24 h ending at the hour of `timestamp`. */
export async function burnTimePrice(chain: ChainConfig, m: XenMarket, timestamp: number): Promise<PricePoint> {
  const hourEnd = Math.floor(timestamp / 3600) * 3600 + 3600;
  const key = `${chain.chainId}:${hourEnd}`;
  const source = `median24h ${chain.gecko}/${m.topPool} until ${new Date(hourEnd * 1000).toISOString()}`;
  if (priceCache.has(key)) return { usd: priceCache.get(key)!, source };
  try {
    const j = await getJson(
      `${GT}/networks/${chain.gecko}/pools/${m.topPool}/ohlcv/hour?aggregate=1&limit=24&currency=usd` +
        `&token=${m.xenIsBase ? "base" : "quote"}&before_timestamp=${hourEnd}`,
    );
    const candles: number[][] = j?.data?.attributes?.ohlcv_list ?? [];
    // median of hourly closes: a brief spike (even inside a high-volume candle) changes nothing
    const usd = median(candles.map((c) => Number(c[4])));
    if (usd > 0) {
      priceCache.set(key, usd);
      return { usd, source };
    }
  } catch {
    /* fall back to spot */
  }
  return { usd: m.spotUsd, source: `spot ${chain.gecko} (no candles for that hour)` };
}

/** Clamp a price to ±MAX_PRICE_MOVE of a reference (previous epoch) to blunt manipulation. */
export function clamp(p: PricePoint, reference?: number): PricePoint {
  if (!reference || !(reference > 0)) return p;
  const lo = reference * (1 - MAX_PRICE_MOVE);
  const hi = reference * (1 + MAX_PRICE_MOVE);
  return p.usd < lo || p.usd > hi ? { usd: Math.min(hi, Math.max(lo, p.usd)), source: p.source, clamped: true } : p;
}

export async function xenTotalSupply(chain: ChainConfig, blockTag: number): Promise<string> {
  return withFailover(chain, "totalSupply", async (p) => {
    const c = new ethers.Contract(chain.xen, ["function totalSupply() view returns (uint256)"], p);
    return (await c.totalSupply({ blockTag })).toString();
  });
}

export async function xntUsd(): Promise<PricePoint> {
  if (XNT_USD_OVERRIDE) return { usd: Number(XNT_USD_OVERRIDE), source: "env:XNT_USD_OVERRIDE" };
  try {
    const j = await getJson("https://x1report.com/api/xnt");
    const p = Number(j?.priceUsd ?? j?.price ?? j?.usd ?? j?.data?.price);
    if (p > 0) return { usd: p, source: "https://x1report.com/api/xnt" };
  } catch {
    /* fall through */
  }
  try {
    const j = await getJson("https://api.xdex.xyz/api/xendex/pool/list?network=X1%20Mainnet");
    const pools: any[] = j?.data?.list || j?.data || [];
    const main = pools.find((p) => String(p.pool_address || p.address) === "CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR");
    const p = Number(main?.token1_price ?? main?.price);
    if (p > 0) return { usd: p, source: "https://api.xdex.xyz (pool CAJeVE…xRvR)" };
  } catch {
    /* fall through */
  }
  // last resort, with no third party at all: the 15-minute TWAP the XDEX WXNT/USDC.X pool keeps on-chain
  // (the same account and formula the program uses for Predictions)
  const p = await xntTwapOnChain();
  if (!(p > 0)) throw new Error("XNT price unavailable — set XNT_USD_OVERRIDE");
  return { usd: p, source: "XDEX on-chain TWAP (4oUvUg…pkPZ)" };
}

/** USD per XNT from the XDEX observation ring: token 0 = WXNT (9 decimals), token 1 = USDC.X (6 decimals), price × 2^32. */
export async function xntTwapOnChain(window = 900): Promise<number> {
  const { PublicKey } = await import("@solana/web3.js");
  const { x1Connection } = await import("./x1-rpc");
  const info = await x1Connection("confirmed").getAccountInfo(new PublicKey("4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ"));
  if (!info || info.data.length < 43 + 100 * 40) return 0;
  const d = info.data;
  const obs: { ts: number; cum: bigint }[] = [];
  for (let i = 0; i < 100; i++) {
    const o = 43 + i * 40;
    const ts = Number(d.readBigUInt64LE(o));
    if (ts) obs.push({ ts, cum: d.readBigUInt64LE(o + 8) | (d.readBigUInt64LE(o + 16) << 64n) });
  }
  if (obs.length < 2) return 0;
  obs.sort((a, b) => a.ts - b.ts);
  const hi = obs[obs.length - 1];
  const lo = [...obs].reverse().find((x) => x.ts <= hi.ts - window) ?? obs[0];
  if (hi.ts <= lo.ts) return 0;
  const x32 = (hi.cum - lo.cum) / BigInt(hi.ts - lo.ts);
  return (Number(x32) / 2 ** 32) * 1e3;
}

// ── v3 (A1, A5): the closed hourly candles before a burn's hour ────────────────────────────────
/** The XDEX WXNT/USDC.X pool on X1 (GeckoTerminal network x1-network); priced in USDC.X (currency=token, 1 USDC.X = $1). */
export const XNT_POOL_X1 = "CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR";
export const GT_X1_NETWORK = "x1-network";

/** Closes (USD × 1e18, oldest first) of the up to 24 hourly candles that closed at or before `hourStart`; null when there are none. */
async function closedHourlyCloses(url: string, hourStart: number, sink?: (r: RawCandlesV3) => void): Promise<string[] | null> {
  const j = await getJsonV3(url);
  const candles: number[][] = Array.isArray(j?.data?.attributes?.ohlcv_list) ? j.data.attributes.ohlcv_list : [];
  const closes = closesFromOhlcvV3(candles, hourStart);
  // D-23 (phase 1): the raw candle array as the API returned it, for the epoch's price sidecar
  if (sink) sink({ url, hourStart, ohlcv: candles, closes });
  return closes;
}

/** D-23: one candle request as answered (the sidecar records it whole, so verify re-derives every reading offline). */
export interface RawCandlesV3 {
  url: string;
  hourStart: number;
  ohlcv: number[][];
  closes: string[] | null;
}

/**
 * The closes (USD × 1e18, oldest first) of the hourly candles that closed in [hourStart − 24 h, hourStart), from a raw
 * GeckoTerminal ohlcv_list ([ts, open, high, low, close, volume]); null when none. Pure: verify re-derives the sidecar's.
 */
export function closesFromOhlcvV3(candles: unknown, hourStart: number): string[] | null {
  if (!Array.isArray(candles)) return null;
  const closed = candles
    .map((c) => ({ ts: Number((c as number[])?.[0]), close: Number((c as number[])?.[4]) }))
    .filter((c) => Number.isFinite(c.ts) && c.ts < hourStart && c.ts >= hourStart - 24 * 3600 && c.close > 0)
    .sort((a, b) => a.ts - b.ts);
  return closed.length ? closed.map((c) => toE18Local(c.close)) : null;
}

/** decimal → integer × 1e18 string, without float drift beyond the source precision (same rule as epoch.ts toE18) */
function toE18Local(usd: number): string {
  const s = usd.toFixed(18);
  const [i, f = ""] = s.split(".");
  return (BigInt(i) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18))).toString();
}

/**
 * A12 (P9): GeckoTerminal's before_timestamp is INCLUSIVE (live probe 2026-10-22: the newest candle returned was the one
 * stamped hourStart, still open), so the query ends one second before the burn's hour: limit=24 then returns the 24
 * closed candles hourStart − 24 h … hourStart − 1 h that A5 describes, and the ts < hourStart filter stays as a guard.
 */
export function candleWindowV3(hourStart: number): string {
  return `limit=24&before_timestamp=${hourStart - 1}`;
}

/** XEN on the chain's deepest eligible pool: the closes of the hourly candles closed before the burn's hour (candle timestamps < hourStart). */
export async function xenHourlyClosesV3(chain: ChainConfig, m: XenMarket, hourStart: number, sink?: (r: RawCandlesV3) => void): Promise<string[] | null> {
  return closedHourlyCloses(
    `${GT}/networks/${chain.gecko}/pools/${m.topPool}/ohlcv/hour?aggregate=1&${candleWindowV3(hourStart)}&currency=usd&token=${m.xenIsBase ? "base" : "quote"}`,
    hourStart,
    sink,
  );
}

/** XNT on the XDEX pool, in USDC.X units (GeckoTerminal misprices USDC.X in USD on X1): the same closed-candle rule. */
export async function xntHourlyClosesV3(hourStart: number, sink?: (r: RawCandlesV3) => void, pool = XNT_POOL_X1): Promise<string[] | null> {
  // D-22 (b): the active XNT price pool (XNT_POOL_X1 until a switch is announced)
  return closedHourlyCloses(`${GT}/networks/${GT_X1_NETWORK}/pools/${pool}/ohlcv/hour?aggregate=1&${candleWindowV3(hourStart)}&currency=token&token=base`, hourStart, sink);
}

// ── v3 (round 4): the market read with what D-13, A5-c and the kit's route need; v2 above is unchanged ─────────
/**
 * T1-9 / O-22: GeckoTerminal with its Retry-After honoured. A 429 (or a 5xx) waits what the server asks (seconds or an
 * HTTP date, at most 60 s), else the backoff of getJson; the same 30-requests-a-minute pacing. v3 readers only.
 */
export async function getJsonV3(url: string, fetcher: typeof fetch = fetch, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<any> {
  const wait = lastCall + 2100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  for (let i = 0; i < 4; i++) {
    const r = await fetcher(url, { headers: { accept: "application/json" } });
    if (r.ok) return r.json();
    if (r.status !== 429 && r.status < 500) throw new Error(`${url} -> HTTP ${r.status}`);
    await sleep(retryAfterMs(r.headers?.get?.("retry-after") ?? null, 5000 * (i + 1)));
  }
  throw new Error(`${url} -> unavailable`);
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date, at most 60 s; `fallback` when absent or unreadable. */
export function retryAfterMs(v: string | null, fallback: number, now = Date.now()): number {
  if (v === null || v.trim() === "") return fallback;
  const s = Number(v.trim());
  if (Number.isFinite(s) && s >= 0) return Math.min(60_000, Math.ceil(s * 1000));
  const t = Date.parse(v);
  if (Number.isFinite(t)) return Math.min(60_000, Math.max(0, t - now));
  return fallback;
}

/** A pool's fee from its GeckoTerminal name ("XEN / WETH 0.3%"), in basis points; 30 (a v2 pool) when the name says none. */
export function poolFeeBpsV3(name: unknown): number {
  const m = typeof name === "string" ? name.match(/(\d+(?:\.\d+)?)\s*%\s*$/) : null;
  if (!m) return 30;
  const bps = Math.round(Number(m[1]) * 100);
  return bps > 0 && bps < 10_000 ? bps : 30;
}

export interface XenMarketDetailV3 extends XenMarket {
  /** D-13: the price pool's creation time (unix s), null when GeckoTerminal does not say */
  poolCreatedAt: number | null;
  /** A5-c / the kit's route: the price pool's other token, its USD price as GeckoTerminal states it, and the pool fee */
  quote: { address: string; usd: number; feeBps: number };
}

/** xenMarket's rule (allowlisted quote, ±3× band, deepest pool prices), read with getJsonV3, plus the price pool's details. */
export async function xenMarketV3(chain: ChainConfig): Promise<XenMarketDetailV3> {
  const token = await getJsonV3(`${GT}/networks/${chain.gecko}/tokens/${chain.xen}`);
  const ref = Number(token?.data?.attributes?.price_usd);
  if (!(ref > 0)) throw new Error(`no XEN price for ${chain.name}`);
  const j = await getJsonV3(`${GT}/networks/${chain.gecko}/tokens/${chain.xen}/pools?page=1`);
  return xenMarketOfV3(chain, ref, j);
}

/** The pure part of xenMarketV3 (one GeckoTerminal pool list): the same eligibility and spot as xenMarket. */
export function xenMarketOfV3(chain: ChainConfig, ref: number, j: any): XenMarketDetailV3 {
  const xenId = `${chain.gecko}_${chain.xen.toLowerCase()}`;
  const allow = new Set((QUOTE_ALLOWLIST[chain.gecko] ?? []).map((a) => `${chain.gecko}_${a}`));
  const pools: { address: string; reserveUsd: number; price: number; xenIsBase: boolean; createdAt: number | null; quote: string; quoteUsd: number; feeBps: number }[] = [];
  for (const p of j?.data ?? []) {
    const reserveUsd = Number(p.attributes.reserve_in_usd);
    const baseId = String(p.relationships?.base_token?.data?.id).toLowerCase();
    const quoteId = String(p.relationships?.quote_token?.data?.id).toLowerCase();
    const xenIsBase = baseId === xenId;
    const xenIsQuote = quoteId === xenId;
    if (!(reserveUsd >= 50) || (!xenIsBase && !xenIsQuote)) continue;
    const other = xenIsBase ? quoteId : baseId;
    if (!allow.has(other)) continue;
    const price = Number(xenIsBase ? p.attributes.base_token_price_usd : p.attributes.quote_token_price_usd);
    if (!(price > 0) || price > ref * 3 || price < ref / 3) continue;
    const created = Date.parse(String(p.attributes.pool_created_at ?? ""));
    pools.push({
      address: p.attributes.address, reserveUsd, price, xenIsBase, createdAt: Number.isFinite(created) ? Math.floor(created / 1000) : null,
      quote: other.slice(chain.gecko.length + 1), quoteUsd: Number(xenIsBase ? p.attributes.quote_token_price_usd : p.attributes.base_token_price_usd), feeBps: poolFeeBpsV3(p.attributes.name),
    });
  }
  if (!pools.length) throw new Error(`no XEN market found for ${chain.name}`);
  const totalReserve = pools.reduce((s, p) => s + p.reserveUsd, 0);
  const spotUsd = pools.reduce((s, p) => s + p.price * p.reserveUsd, 0) / totalReserve;
  pools.sort((a, b) => b.reserveUsd - a.reserveUsd);
  const top = pools[0];
  return {
    refUsd: ref, spotUsd, liquidityUsd: totalReserve / 2, topPool: top.address, xenIsBase: top.xenIsBase,
    pools: pools.map((p) => ({ address: p.address, reserveUsd: Math.round(p.reserveUsd * 100) / 100 })),
    poolCreatedAt: top.createdAt,
    quote: { address: top.quote, usd: top.quoteUsd > 0 ? top.quoteUsd : 0, feeBps: top.feeBps },
  };
}

/** The kit's market route of one chain (FEED CONTRACT `route`): the price pool's reserves at the build. */
export interface XenRouteV3 {
  pool: string;
  xenReserveWei: string;
  quoteReserveMicro: string;
  feeBps: number;
  /** the X1 bridge's fee and minimum for USDC (WHITEPAPER: a $10 minimum and a $1 fee) */
  bridgeFeeMicro: string;
  bridgeMinMicro: string;
}
export const BRIDGE_FEE_MICRO = 1_000_000n;
export const BRIDGE_MIN_MICRO = 10_000_000n;

/**
 * D-13: the XEN-side depth of the eligible pools read on-chain at `block` (Σ XEN.balanceOf(pool) × the build spot, µUSD),
 * and the price pool's route (its XEN and quote balances; the quote side in µUSD at its stated USD price). A pool whose
 * address is not a 20-byte account (a Uniswap v4 pool id) has no balance to read and is left out of the sum (so the
 * on-chain reading can only be lower: min(GeckoTerminal, on-chain) stays the safe side). Null when nothing could be read.
 */
export async function xenDepthV3(chain: ChainConfig, m: XenMarketDetailV3, block: number): Promise<{ micro: string | null; route: XenRouteV3 | null }> {
  const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
  const readable = m.pools.filter((p) => /^0x[0-9a-fA-F]{40}$/.test(p.address));
  if (!readable.length) return { micro: null, route: null };
  return withFailover(chain, `XEN depth@${block}`, async (p) => {
    const xen = new ethers.Contract(chain.xen, ERC20, p);
    let wei = 0n;
    let topWei: bigint | null = null;
    for (const pool of readable) {
      const b: bigint = await xen.balanceOf(pool.address, { blockTag: block });
      wei += b;
      if (pool.address.toLowerCase() === m.topPool.toLowerCase()) topWei = b;
    }
    const spotE18 = BigInt(toE18Local(m.spotUsd));
    const micro = ((wei * spotE18) / 10n ** 30n).toString();
    let route: XenRouteV3 | null = null;
    if (topWei !== null && /^0x[0-9a-fA-F]{40}$/.test(m.quote.address) && m.quote.usd > 0) {
      const q = new ethers.Contract(m.quote.address, ERC20, p);
      const qBal: bigint = await q.balanceOf(m.topPool, { blockTag: block });
      const dec = Number(await q.decimals());
      const usdE18 = BigInt(toE18Local(m.quote.usd));
      route = {
        pool: m.topPool, xenReserveWei: topWei.toString(), quoteReserveMicro: ((qBal * usdE18) / 10n ** BigInt(dec + 12)).toString(), feeBps: m.quote.feeBps,
        bridgeFeeMicro: BRIDGE_FEE_MICRO.toString(), bridgeMinMicro: BRIDGE_MIN_MICRO.toString(),
      };
    }
    return { micro, route };
  });
}

// ── v3 (round 4, A5-c): the quote token's USD price against Chainlink ───────────────────────────────────────────
/**
 * Chainlink USD feeds for the allowlisted quote tokens of each chain (lowercase token → feed), every one checked read-only
 * on 2026-10-25 (its description() is the pair named here, 8 decimals, a round of that day). The XEN candles are in USD
 * as GeckoTerminal converts them through the price pool's quote token; at the build, GeckoTerminal's USD price of that
 * token must agree with Chainlink's within QUOTE_USD_MAX_DIFF_BPS, or the chain is skipped this epoch (its cursor kept):
 * the GeckoTerminal fault seen on X1 (USDC.X at $1.38) can then never price a chain's burns.
 */
export const CHAINLINK_QUOTE_FEEDS_V3: Record<number, Record<string, { feed: string; pair: string }>> = {
  10: {
    "0x4200000000000000000000000000000000000006": { feed: "0x13e3Ee699D1909E989722E753853AE30b17e08c5", pair: "ETH / USD" },
    "0x0b2c639c533813f4aa9d7837caf62653d097ff85": { feed: "0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3", pair: "USDC / USD" },
    "0x7f5c764cbc14f9669b88837ca1490cca17c31607": { feed: "0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3", pair: "USDC / USD" },
    "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": { feed: "0xECef79E109e997bCA29c1c0897ec9d7b03647F5E", pair: "USDT / USD" },
  },
  56: {
    "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": { feed: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE", pair: "BNB / USD" },
    "0x55d398326f99059ff775485246999027b3197955": { feed: "0xB97Ad0E74fa7d920791E90258A6E2085088b4320", pair: "USDT / USD" },
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": { feed: "0x51597f405303C4377E36123cBc172b13269EA163", pair: "USDC / USD" },
    "0xe9e7cea3dedca5984780bafc599bd69add087d56": { feed: "0xcBb98864Ef56E9042e7d2efef76141f15731B82f", pair: "BUSD / USD" },
    "0x2170ed0880ac9a755fd29b2688956bd959f933f8": { feed: "0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e", pair: "ETH / USD" },
  },
  137: {
    "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": { feed: "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0", pair: "MATIC / USD" },
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { feed: "0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7", pair: "USDC / USD" },
    "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": { feed: "0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7", pair: "USDC / USD" },
    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { feed: "0x0A6513e40db6EB1b165753AD52E80663aeA50545", pair: "USDT / USD" },
    "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": { feed: "0xF9680D99D6C9589e2a93a78A04A279e509205945", pair: "ETH / USD" },
  },
  43114: {
    "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7": { feed: "0x0A77230d17318075983913bC2145DB16C7366156", pair: "AVAX / USD" },
    "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": { feed: "0xF096872672F44d6EBA71458D74fe67F9a77a23B9", pair: "USDC / USD" },
    "0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664": { feed: "0xF096872672F44d6EBA71458D74fe67F9a77a23B9", pair: "USDC / USD" },
    "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7": { feed: "0xEBE676ee90Fe1112671f19b6B7459bC678B67e8a", pair: "USDT / USD" },
  },
  8453: {
    "0x4200000000000000000000000000000000000006": { feed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", pair: "ETH / USD" },
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { feed: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", pair: "USDC / USD" },
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": { feed: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", pair: "USDC / USD" },
  },
};
/** A5-c: GeckoTerminal's USD price of the quote token may differ from Chainlink's by at most this (3%) */
export const QUOTE_USD_MAX_DIFF_BPS = 300;
/** a Chainlink round older than this (two days: the stablecoin feeds' 24-h heartbeat, twice) is not a reading */
export const CHAINLINK_MAX_AGE_S = 2 * 86_400;

/** A5-c: the difference between GeckoTerminal's stated USD price and Chainlink's, in basis points of Chainlink's (pure). */
export function quoteUsdDiffBpsV3(statedE18: bigint, chainlinkE18: bigint): number {
  if (chainlinkE18 <= 0n) return Number.POSITIVE_INFINITY;
  const d = statedE18 > chainlinkE18 ? statedE18 - chainlinkE18 : chainlinkE18 - statedE18;
  return Number((d * 10_000n) / chainlinkE18);
}

/**
 * A5-c: Chainlink's USD price of a quote token at `block` (USD × 1e18), or null when the token has no listed feed, the
 * feed's description is not the listed pair, its answer is not positive, or its round is older than CHAINLINK_MAX_AGE_S
 * at that block (the check is then "not made", never a pass).
 */
export async function chainlinkUsdV3(chain: ChainConfig, token: string | undefined, block: number): Promise<{ feed: string; pair: string; usdE18: string } | null> {
  const f = token ? CHAINLINK_QUOTE_FEEDS_V3[chain.chainId]?.[token.toLowerCase()] : undefined;
  if (!f) return null;
  const ABI = ["function description() view returns (string)", "function decimals() view returns (uint8)", "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"];
  return withFailover(chain, `Chainlink ${f.pair}@${block}`, async (p) => {
    const c = new ethers.Contract(f.feed, ABI, p);
    const [desc, dec, round, blk] = await Promise.all([c.description({ blockTag: block }), c.decimals({ blockTag: block }), c.latestRoundData({ blockTag: block }), p.getBlock(block)]);
    if (desc !== f.pair) return null;
    const answer = BigInt(round[1]);
    const updated = Number(round[3]);
    if (answer <= 0n || !blk || blk.timestamp - updated > CHAINLINK_MAX_AGE_S) return null;
    const d = Number(dec);
    return { feed: f.feed, pair: f.pair, usdE18: (d <= 18 ? answer * 10n ** BigInt(18 - d) : answer / 10n ** BigInt(d - 18)).toString() };
  });
}
