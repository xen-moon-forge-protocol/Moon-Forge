/**
 * Burn vs Sell — honest estimator.
 *
 *  Market route : sell XEN on its chain → bridge USD value to X1 with Warp ($1 fee, $10 minimum)
 *                 → buy XNT. Pool slippage is an input (estimate).
 *  Moon Forge   : UPPER BOUND = 1.25 × liquidity-adjusted value × tier × (1 + Artifact boost), converted at the
 *                 XNT price. The epoch total is capped WITHOUT boosts, so a boost only shifts shares between
 *                 burners of the same epoch (alone it gains nothing). The real payout is your share of the epoch
 *                 budget and can be lower.
 *
 * Prices: XEN from GeckoTerminal (same source the oracle uses), XNT from x1report.com.
 * If a price cannot be fetched, the corresponding numbers show "--".
 */

import { useEffect, useState } from 'react';
import { Calculator } from 'lucide-react';
import { ARTIFACTS, P } from '../lib/protocol';
import { CHAINS, EVM_CHAINS, formatNumber, formatUSD } from '../lib/constants';
import { useProtocol } from '../lib/hooks';
import { Row } from './ui';

const WARP_FEE_USD = 1;
const WARP_MIN_USD = 10;

/**
 * Rough approximation of the oracle's market logic (oracle/src/pricing.ts): aggregated spot price as reference,
 * pools priced >3× away ignored, XEN-side liquidity = half of the sane pools' reserves. The oracle itself uses only
 * allowlisted quote pools, the 24 h median of the largest pool's hourly closes and ±50% clamps.
 */
async function fetchXenMarket(chainKey: string): Promise<{ price: number; liquidity: number } | null> {
    const c = CHAINS[chainKey];
    const GT = 'https://api.geckoterminal.com/api/v2';
    const t = await fetch(`${GT}/networks/${c.gecko}/tokens/${c.xenToken}`, { headers: { accept: 'application/json' } });
    if (!t.ok) return null;
    const price = Number((await t.json())?.data?.attributes?.price_usd);
    if (!(price > 0)) return null;
    const r = await fetch(`${GT}/networks/${c.gecko}/tokens/${c.xenToken}/pools?page=1`, { headers: { accept: 'application/json' } });
    if (!r.ok) return { price, liquidity: 0 };
    const id = `${c.gecko}_${c.xenToken.toLowerCase()}`;
    let reserve = 0;
    for (const p of (await r.json())?.data ?? []) {
        const isBase = String(p.relationships?.base_token?.data?.id).toLowerCase() === id;
        const isQuote = String(p.relationships?.quote_token?.data?.id).toLowerCase() === id;
        const px = Number(isBase ? p.attributes.base_token_price_usd : p.attributes.quote_token_price_usd);
        const res = Number(p.attributes.reserve_in_usd);
        if ((isBase || isQuote) && res >= 50 && px <= price * 3 && px >= price / 3) reserve += res;
    }
    return { price, liquidity: reserve / 2 };
}

async function fetchXntUsd(): Promise<number | null> {
    const r = await fetch('https://x1report.com/api/xnt', { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    const v = Number(j?.price ?? j?.usd ?? j?.data?.price);
    return v > 0 ? v : null;
}

interface Props {
    chainKey?: string;
    xenAmount?: string;
    tier?: number;
    compact?: boolean;
}

export default function BurnVsSell({ chainKey: chainProp, xenAmount: amountProp, tier: tierProp, compact }: Props) {
    const [chainKey, setChainKey] = useState(chainProp ?? 'ethereum');
    const [amount, setAmount] = useState(amountProp ?? '');
    const [tier, setTier] = useState(tierProp ?? 0);
    const [boostTier, setBoostTier] = useState(-1);
    const [slippage, setSlippage] = useState('3');
    const [xenUsd, setXenUsd] = useState<number | null>(null);
    const [liquidity, setLiquidity] = useState<number | null>(null);
    const [xntUsd, setXntUsd] = useState<number | null>(null);
    const [priceErr, setPriceErr] = useState<string | null>(null);
    const { data: proto } = useProtocol(60_000);

    // follow the parent form when embedded in The Forge
    useEffect(() => { if (chainProp) setChainKey(chainProp); }, [chainProp]);
    useEffect(() => { if (amountProp !== undefined) setAmount(amountProp); }, [amountProp]);
    useEffect(() => { if (tierProp !== undefined) setTier(tierProp); }, [tierProp]);

    useEffect(() => {
        let alive = true;
        setXenUsd(null);
        setLiquidity(null);
        setPriceErr(null);
        fetchXenMarket(chainKey)
            .then((m) => { if (alive) { setXenUsd(m?.price ?? null); setLiquidity(m?.liquidity ?? null); if (!m) setPriceErr('XEN market unavailable'); } })
            .catch(() => { if (alive) setPriceErr('XEN price unavailable'); });
        return () => { alive = false; };
    }, [chainKey]);
    useEffect(() => {
        let alive = true;
        fetchXntUsd().then((v) => { if (alive) setXntUsd(v); }).catch(() => { if (alive) setXntUsd(null); });
        return () => { alive = false; };
    }, []);

    const xen = Number(amount.replace(/,/g, '')) || 0;
    const s = Math.min(50, Math.max(0, Number(slippage) || 0)) / 100;
    const value = xenUsd !== null && xen > 0 ? xen * xenUsd : null;
    const boost = boostTier >= 0 ? ARTIFACTS[boostTier].boostPct / 100 : 0;
    const mult = P.tiers[tier].multiplier;

    // what this chain's XEN liquidity could really absorb (constant-product AMM) — used by BOTH routes
    const realValue = value !== null && liquidity !== null ? (liquidity > 0 ? (value * liquidity) / (liquidity + value) : 0) : null;

    // market route: sell XEN into its pools (AMM) → Warp bridge ($1 fee, $10 min) → buy XNT (slippage input)
    const afterSell = realValue;
    const belowMin = afterSell !== null && afterSell < WARP_MIN_USD;
    const marketUsd = afterSell !== null && !belowMin ? Math.max(0, (afterSell - WARP_FEE_USD) * (1 - s)) : null;
    const marketXnt = marketUsd !== null && xntUsd ? marketUsd / xntUsd : null;

    // Moon Forge cap: 1.25 × real value × tier × boost (upper bound; real value assumes the only burn on that chain;
    // the boost part is reachable only when other, unboosted burners share the epoch — alone it gains nothing)
    const capUsd = realValue !== null ? realValue * P.rateCapK * mult * (1 + boost) : null;
    const capXnt = capUsd !== null && xntUsd ? capUsd / xntUsd : null;
    const ratio = capXnt !== null && marketXnt ? capXnt / marketXnt : null;

    return (
        <div className="glass-card">
            <div className="flex items-center gap-2 mb-3">
                <Calculator className="w-5 h-5 text-forge-gold" />
                <h3 className="font-space text-lg text-forge-gold">Burn vs Sell (estimate)</h3>
            </div>

            {!compact && (
                <div className="grid grid-cols-2 gap-3 mb-3">
                    <label className="text-xs text-lunar-400 col-span-2">XEN amount
                        <input className="input-forge mt-1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 100000000" />
                    </label>
                    <label className="text-xs text-lunar-400">Chain
                        <select className="input-forge mt-1" value={chainKey} onChange={(e) => setChainKey(e.target.value)}>
                            {EVM_CHAINS.map((k) => <option key={k} value={k}>{CHAINS[k].name}</option>)}
                        </select>
                    </label>
                    <label className="text-xs text-lunar-400">Tier
                        <select className="input-forge mt-1" value={tier} onChange={(e) => setTier(Number(e.target.value))}>
                            {P.tiers.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.multiplier}×)</option>)}
                        </select>
                    </label>
                </div>
            )}
            <div className="grid grid-cols-2 gap-3 mb-3">
                <label className="text-xs text-lunar-400">Artifact boost (raises your share only)
                    <select className="input-forge mt-1 !py-2" value={boostTier} onChange={(e) => setBoostTier(Number(e.target.value))}>
                        <option value={-1}>None</option>
                        {ARTIFACTS.map((a) => <option key={a.tier} value={a.tier}>{a.name} (+{a.boostPct}%)</option>)}
                    </select>
                </label>
                <label className="text-xs text-lunar-400">XNT buy slippage on XDEX (%)
                    <input className="input-forge mt-1 !py-2" inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
                </label>
            </div>

            <Row label={`XEN spot price (${CHAINS[chainKey].shortName})`}>{xenUsd !== null ? formatUSD(xenUsd) : '--'}</Row>
            <Row label="XNT price">{xntUsd !== null ? formatUSD(xntUsd) : '--'}</Row>
            <Row label={`${CHAINS[chainKey].shortName}-XEN liquidity (XEN side)`}>{liquidity !== null ? formatUSD(liquidity) : '--'}</Row>
            <Row label="Spot value of your XEN">{formatUSD(value)}</Row>
            <Row label="Real value (liquidity-adjusted; assumes yours is the only burn on this chain this epoch)">{formatUSD(realValue)}</Row>
            <hr className="border-white/10 my-2" />
            <Row label="Market route (sell → Warp → buy XNT)">
                {belowMin ? <span className="text-amber-400">below the $10 Warp minimum</span> : marketXnt !== null ? `≈ ${formatNumber(marketXnt)} XNT` : '--'}
            </Row>
            <Row label={`Moon Forge cap (${P.rateCapK} × real value × ${mult}${boost ? ` × up to ${1 + boost}` : ''})`}>
                {capXnt !== null ? `≤ ${formatNumber(capXnt)} XNT` : '--'}
            </Row>
            {ratio !== null && (
                <Row label="Cap vs market route">{ratio.toFixed(2)}×</Row>
            )}
            <Row label="Next epoch budget (max, all burners)">
                {proto ? `${formatNumber(proto.nextEpochBudget / 1e9)} XNT` : '--'}
            </Row>

            <p className="text-xs text-lunar-500 mt-3">
                Estimate only. The market route ignores gas and uses your slippage guess. Moon Forge pays your share of the epoch budget,
                never more than the cap above; if many burners share a small budget, or others burn on the same chain, you receive less.
                The oracle prices each burn at the burn-hour price of this chain's XEN (a 24 h median), which can differ from the spot price.
                An Artifact boost only raises your share of the same epoch, never the total: if you are the only burner, it gains nothing.
                Forge Drops (part of the budget, drawn at random) make individual results vary.
                {tier > 0 && ` ${P.tiers[tier].name} pays over ${P.tiers[tier].vestingDays} days.`}
                {priceErr && ` (${priceErr})`}
            </p>
        </div>
    );
}
