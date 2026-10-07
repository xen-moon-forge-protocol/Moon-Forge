/**
 * Live XEN market per chain, computed exactly like the oracle (oracle/src/pricing.ts::xenMarket):
 * only pools quoted in an allowlisted liquid asset count; pools priced more than 3× away from the
 * aggregator price are ignored; spot = reserve-weighted price; XEN-side liquidity = half the reserves.
 * Plus on-chain state per chain: XEN supply and XEN burned through the Moon Forge portal.
 * Results are cached for 5 minutes; GeckoTerminal calls are queued and retried when throttled.
 */
import { useEffect, useState } from 'react';
import { ethers } from 'ethers';
import { CHAINS, EVM_CHAINS, isPortalDeployed } from './constants';
import { fetchEpochFile, fetchEpochIndex, PORTAL_ABI } from './protocol';

const GT = 'https://api.geckoterminal.com/api/v2';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GeckoTerminal's free API allows about 30 calls a minute and answers 429 to bursts:
 *  calls go out one at a time, spaced, and a throttled call is retried with backoff. */
let gtQueue: Promise<unknown> = Promise.resolve();
function gtJson(url: string): Promise<any> {
    const run = async () => {
        for (let i = 0; i < 4; i++) {
            const r = await fetch(url, { headers: { accept: 'application/json' } }).catch(() => null);
            if (r && r.status === 429) { await sleep(2500 * 2 ** i); continue; }
            return r && r.ok ? r.json() : null;
        }
        return null;
    };
    const p = gtQueue.then(run);
    gtQueue = p.then(() => sleep(1200), () => sleep(1200));
    return p;
}

/** Same list as oracle/src/pricing.ts QUOTE_ALLOWLIST (wrapped native token, major stablecoins, WETH). */
const QUOTE_ALLOWLIST: Record<string, string[]> = {
    eth: ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xdac17f958d2ee523a2206206994597c13d831ec7', '0x6b175474e89094c44da98b954eedeac495271d0f'],
    optimism: ['0x4200000000000000000000000000000000000006', '0x0b2c639c533813f4aa9d7837caf62653d097ff85', '0x7f5c764cbc14f9669b88837ca1490cca17c31607', '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58'],
    bsc: ['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0xe9e7cea3dedca5984780bafc599bd69add087d56', '0x2170ed0880ac9a755fd29b2688956bd959f933f8'],
    polygon_pos: ['0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619'],
    avax: ['0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7', '0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664'],
    base: ['0x4200000000000000000000000000000000000006', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', '0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca'],
    pulsechain: ['0xa1077a294dde1b09bb078844df40758a5d0f9a27', '0xefd766ccb38eaf1dfd701853bfce31359239f305', '0x15d38573d2feeb82e7ad5187ab8c1d52810b1f07', '0x0cb6f5a34ad42ec934882a05265a7d5f59b51a2f'],
};

export interface XenMarketLive {
    /** reserve-weighted XEN price over the eligible pools, USD */
    spotUsd: number;
    /** XEN-side USD liquidity of the eligible pools (L in the liquidity factor) */
    liquidityUsd: number;
    pools: number;
    /** trades and USD volume over the last 24 h in the eligible pools (a still market keeps a still price) */
    trades24h: number;
    volume24hUsd: number;
    /** when this was read (ms) */
    at: number;
}

/** Forgets cached market and chain data so the next read goes to the sources again. */
export function invalidateMarketCache() {
    for (const k of [...cache.keys()]) if (k.startsWith('mkt:') || k.startsWith('burn:') || k.startsWith('epochs:')) cache.delete(k);
}

const cache = new Map<string, { at: number; value: Promise<any> }>();
function cached<T>(key: string, f: () => Promise<T>, ttlMs = 300_000): Promise<T> {
    const c = cache.get(key);
    if (c && Date.now() - c.at < ttlMs) return c.value;
    const value = f().catch((e) => { cache.delete(key); throw e; });
    cache.set(key, { at: Date.now(), value });
    return value;
}

export function xenMarketLive(chainKey: string): Promise<XenMarketLive | null> {
    return cached(`mkt:${chainKey}`, async () => {
        const c = CHAINS[chainKey];
        const token = await gtJson(`${GT}/networks/${c.gecko}/tokens/${c.xenToken}`);
        const ref = Number(token?.data?.attributes?.price_usd);
        if (!(ref > 0)) return null;
        const j = await gtJson(`${GT}/networks/${c.gecko}/tokens/${c.xenToken}/pools?page=1`);
        const xenId = `${c.gecko}_${c.xenToken.toLowerCase()}`;
        const allow = new Set((QUOTE_ALLOWLIST[c.gecko] ?? []).map((a) => `${c.gecko}_${a}`));
        let reserve = 0, weighted = 0, n = 0, trades = 0, volume = 0;
        for (const p of j?.data ?? []) {
            const reserveUsd = Number(p.attributes.reserve_in_usd);
            const baseId = String(p.relationships?.base_token?.data?.id).toLowerCase();
            const quoteId = String(p.relationships?.quote_token?.data?.id).toLowerCase();
            const xenIsBase = baseId === xenId;
            if (!(reserveUsd >= 50) || (!xenIsBase && quoteId !== xenId)) continue;
            if (!allow.has(xenIsBase ? quoteId : baseId)) continue;
            const price = Number(xenIsBase ? p.attributes.base_token_price_usd : p.attributes.quote_token_price_usd);
            if (!(price > 0) || price > ref * 3 || price < ref / 3) continue;
            reserve += reserveUsd;
            weighted += price * reserveUsd;
            trades += (p.attributes.transactions?.h24?.buys ?? 0) + (p.attributes.transactions?.h24?.sells ?? 0);
            volume += Number(p.attributes.volume_usd?.h24 ?? 0);
            n++;
        }
        if (!n) return null;
        return { spotUsd: weighted / reserve, liquidityUsd: reserve / 2, pools: n, trades24h: trades, volume24hUsd: volume, at: Date.now() };
    });
}

/** XEN supply of the chain's contract and XEN burned through the portal, all time (both in XEN). */
export function chainBurnState(chainKey: string): Promise<{ supply: number | null; burnedAllTime: number | null }> {
    return cached(`burn:${chainKey}`, async () => {
        const c = CHAINS[chainKey];
        const p = new ethers.JsonRpcProvider(c.rpcUrl, c.chainId, { staticNetwork: true });
        const xen = new ethers.Contract(c.xenToken, ['function totalSupply() view returns (uint256)'], p);
        const supply = await xen.totalSupply().then((v: bigint) => Number(ethers.formatUnits(v, 18))).catch(() => null);
        let burnedAllTime: number | null = 0;
        if (isPortalDeployed(chainKey)) {
            const portal = new ethers.Contract(c.portalAddress, PORTAL_ABI, p);
            burnedAllTime = await portal.totalBurned().then((v: bigint) => Number(ethers.formatUnits(v, 18))).catch(() => null);
        }
        return { supply, burnedAllTime };
    });
}

/** XEN already counted in published epochs, per chain id (to know what the current week has burned so far). */
export function burnedInPublishedEpochs(): Promise<Map<number, number>> {
    return cached('epochs:burned', async () => {
        const out = new Map<number, number>();
        const idx = await fetchEpochIndex();
        for (const e of idx.epochs) {
            const f = await fetchEpochFile(e.epoch).catch(() => null);
            for (const b of f?.burns ?? []) out.set(b.chainId, (out.get(b.chainId) ?? 0) + Number(ethers.formatUnits(BigInt(b.amountWei), 18)));
        }
        return out;
    });
}

// ─── shared live view of every chain + the week's fair burn capacity ───────────────────────────

export type ChainMarket = { market: XenMarketLive | null; supply: number | null; burnedWeek: number | null; stale: boolean };

/** All chains' market and burn state, refreshed every `refreshMs`. A source that fails keeps its last good
 *  value, marked stale, instead of going blank. */
export function useChainMarkets(refreshMs = 300_000) {
    const [rows, setRows] = useState<Record<string, ChainMarket | 'loading'>>(() => Object.fromEntries(EVM_CHAINS.map((k) => [k, 'loading' as const])));
    const [updatedAt, setUpdatedAt] = useState<number | null>(null);
    const [tick, setTick] = useState(0);
    useEffect(() => {
        const id = setInterval(() => { invalidateMarketCache(); setTick((t) => t + 1); }, refreshMs);
        return () => clearInterval(id);
    }, [refreshMs]);
    useEffect(() => {
        let alive = true;
        (async () => {
            const counted = await burnedInPublishedEpochs().catch(() => new Map<number, number>());
            for (const k of EVM_CHAINS) {
                const [market, state] = await Promise.all([
                    xenMarketLive(k).catch(() => null),
                    chainBurnState(k).catch(() => ({ supply: null, burnedAllTime: null })),
                ]);
                if (!alive) return;
                const burnedWeek = state.burnedAllTime === null ? null : Math.max(0, state.burnedAllTime - (counted.get(CHAINS[k].chainId) ?? 0));
                setRows((prev) => {
                    const old = prev[k];
                    if (!market && old !== 'loading' && old.market) return { ...prev, [k]: { ...old, stale: true } };
                    return { ...prev, [k]: { market, supply: state.supply ?? (old !== 'loading' ? old.supply : null), burnedWeek, stale: false } };
                });
            }
            if (alive) setUpdatedAt(Date.now());
        })();
        return () => { alive = false; };
    }, [tick]);
    const refresh = () => { invalidateMarketCache(); setTick((t) => t + 1); };
    return { rows, updatedAt, refresh };
}

/** Liquidity-adjusted ("counted") USD value of `xen` burned on a chain this week, with the week's other burns. */
export function countedUsd(m: XenMarketLive, burnedWeekXen: number, xen: number) {
    const v = (burnedWeekXen + xen) * m.spotUsd;
    return v === 0 ? 0 : (xen * m.spotUsd * m.liquidityUsd) / (m.liquidityUsd + v);
}

/**
 * Fair burn capacity of the week. The liquidity factor L / (L + V) is what selling V dollars of XEN into an AMM
 * pool of depth L returns at best (before pool fees, bridge costs and buying XNT back), so a burn beats selling
 * whenever the epoch pays at least 1 dollar of XNT per counted dollar (score dollar for vesting tiers).
 * capacity = this epoch's budget in USD; remaining = capacity − counted value already burned this week.
 * Approximate before the epoch: other people's tiers and the burn-hour prices are known only when it is built.
 */
export function weekCapacity(rows: Record<string, ChainMarket | 'loading'>, budgetXnt: number | null, xntUsd: number | null, rateCapK: number) {
    if (budgetXnt === null || !xntUsd) return null;
    let counted = 0;
    for (const k of EVM_CHAINS) {
        if (!isPortalDeployed(k)) continue;
        const r = rows[k];
        if (r === 'loading' || !r.market || !r.burnedWeek) continue;
        counted += countedUsd(r.market, 0, r.burnedWeek);
    }
    const budgetUsd = budgetXnt * xntUsd;
    return {
        budgetUsd,
        countedWeekUsd: counted,
        remainingUsd: Math.max(0, budgetUsd - counted),
        /** XNT-dollars paid per counted dollar if nothing else is burned this week (capped at K) */
        rateNow: counted > 0 ? Math.min(rateCapK, budgetUsd / counted) : rateCapK,
    };
}
