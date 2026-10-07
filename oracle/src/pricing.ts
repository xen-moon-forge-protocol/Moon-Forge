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
  const p = new ethers.JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true });
  const c = new ethers.Contract(chain.xen, ["function totalSupply() view returns (uint256)"], p);
  return (await c.totalSupply({ blockTag })).toString();
}

export async function xntUsd(): Promise<PricePoint> {
  if (XNT_USD_OVERRIDE) return { usd: Number(XNT_USD_OVERRIDE), source: "env:XNT_USD_OVERRIDE" };
  try {
    const j = await getJson("https://x1report.com/api/xnt");
    const p = Number(j?.price ?? j?.usd ?? j?.data?.price);
    if (p > 0) return { usd: p, source: "https://x1report.com/api/xnt" };
  } catch {
    /* fall through */
  }
  const j = await getJson("https://api.xdex.xyz/api/xendex/pool/list?network=X1%20Mainnet");
  const pools: any[] = j?.data?.list || j?.data || [];
  const main = pools.find((p) => String(p.pool_address || p.address) === "CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR");
  const p = Number(main?.token1_price ?? main?.price);
  if (!(p > 0)) throw new Error("XNT price unavailable — set XNT_USD_OVERRIDE");
  return { usd: p, source: "https://api.xdex.xyz (pool CAJeVE…xRvR)" };
}
