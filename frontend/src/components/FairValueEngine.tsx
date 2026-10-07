/**
 * Fair Value Engine — what the same burn is worth on each chain, right now, and why.
 *
 * v1 used fixed per-chain weights (CWF). v2 weighs every chain by its own XEN market, so weights move
 * by themselves with price, market depth and the week's burns:
 *   counted value = XEN × price × L / (L + V)
 *   L = XEN-side liquidity of the chain's eligible pools, V = everything burned on that chain in the epoch
 *   (this burn included). Every burn of the same chain and week gets the same factor: order never matters.
 * L / (L + V) is also what selling V dollars into an AMM pool of depth L returns at best, which gives the
 * fair weekly capacity: a burn beats selling while the epoch pays at least 1 XNT-dollar per counted dollar.
 * Data refreshes every 5 minutes (lib/market.ts, computed like the oracle); the oracle's exact inputs per
 * burn (burn-hour price = median of 24 hourly closes) are published in each epoch file.
 */
import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Scale } from 'lucide-react';
import { Link } from 'react-router-dom';
import { CHAINS, EVM_CHAINS, isPortalDeployed } from '../lib/constants';
import { countedUsd, useChainMarkets, weekCapacity } from '../lib/market';
import { P, toXnt } from '../lib/protocol';
import { useProtocol } from '../lib/hooks';
import { fetchXntUsd } from './ROICalculator';

const PRESETS = [1e9, 1e11, 1e12, 1e13, 1e14];
const compactXen = (n: number) => (n >= 1e12 ? `${n / 1e12}T` : n >= 1e9 ? `${n / 1e9}B` : n >= 1e6 ? `${n / 1e6}M` : `${n}`);
export const money = (v: number) => (v === 0 ? '$0' : v >= 100 ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : `$${v.toPrecision(2)}`);
const pct = (f: number) => `${(f * 100).toFixed(f > 0.999 ? 2 : 1)}%`;
const big = (n: number | null) => (n === null ? '--' : n >= 1e12 ? `${(n / 1e12).toFixed(1)}T` : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n.toLocaleString('en-US', { maximumFractionDigits: 0 }));
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

export default function FairValueEngine({ compact = false }: { compact?: boolean }) {
    const proto = useProtocol(60_000);
    const { rows, updatedAt, refresh } = useChainMarkets();
    const [xntUsd, setXntUsd] = useState<number | null>(null);
    const [amount, setAmount] = useState(1e12);
    const [tier, setTier] = useState(0);
    useEffect(() => { fetchXntUsd().then(setXntUsd).catch(() => undefined); }, [updatedAt]);

    const budgetXnt = proto.data ? toXnt(proto.data.nextEpochBudget) : null;
    const cap = weekCapacity(rows, budgetXnt, xntUsd, P.rateCapK);
    const mult = P.tiers[tier].multiplier;
    const calc = useMemo(() => EVM_CHAINS.map((k) => {
        const r = rows[k];
        if (r === 'loading' || !r.market) return { k, r, ok: false as const };
        const m = r.market, price = m.spotUsd, L = m.liquidityUsd;
        const weekUsd = (r.burnedWeek ?? 0) * price;
        const marketValue = amount * price;
        const counted = countedUsd(m, r.burnedWeek ?? 0, amount);
        const factor = marketValue > 0 ? counted / marketValue : 0;
        const capXnt = xntUsd ? (P.rateCapK * mult * counted) / xntUsd : null;
        return { k, r, ok: true as const, m, price, L, weekUsd, marketValue, factor, counted, capXnt };
    }), [rows, amount, mult, xntUsd]);
    const best = Math.max(0, ...calc.map((c) => (c.ok ? c.counted : 0)));
    const example = calc.filter((c) => c.ok && isPortalDeployed(c.k)).sort((a, b) => (b.ok && a.ok ? b.counted - a.counted : 0))[0];
    const loadingAny = EVM_CHAINS.some((k) => rows[k] === 'loading');

    return (
        <div className="glass-card space-y-4">
            <div className="flex flex-wrap items-center gap-2">
                <Scale className="w-5 h-5 text-forge-gold" />
                <h3 className="font-space text-lg">Fair Value Engine · chain weights, live</h3>
                <span className="ml-auto text-xs text-lunar-500">
                    {loadingAny ? 'Reading every chain…' : updatedAt ? `Updated ${hhmm(updatedAt)} UTC · refreshes every 5 min` : ''}
                </span>
                <button onClick={refresh} className="text-xs text-forge-orange hover:underline inline-flex items-center gap-1" aria-label="Refresh market data"><RefreshCw className="w-3 h-3" />Refresh</button>
            </div>
            <p className="text-sm text-lunar-400">
                XEN is the same token on every chain, but it is not worth the same: each chain has its own market, with its own price, depth and supply.
                Moon Forge credits a burn with what that XEN is really worth on its own market, so the same amount weighs differently on each chain,
                and the weights move by themselves as markets and burns change. Type an amount to see what it would count for right now.
            </p>

            {cap && (
                <div className={`rounded-xl p-3 text-sm ${cap.remainingUsd > 1 ? 'bg-green-500/10 text-green-200' : 'bg-amber-500/10 text-amber-200'}`}>
                    <strong>Fair capacity this week:</strong> the budget ({money(cap.budgetUsd)}) can pay at least the value of a sale for up to {money(cap.budgetUsd)} of counted value in total.
                    {' '}Already burned this week: {money(cap.countedWeekUsd)}. <strong>Left: {money(cap.remainingUsd)}.</strong>
                    {' '}Burns beyond that are still paid, but pro-rata, so they would likely earn less than selling. The capacity grows with the reward pool
                    (every game stake, Artifact sale and donation adds to it).
                </div>
            )}

            <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-lunar-400">If I burn</span>
                {PRESETS.map((v) => (
                    <button key={v} onClick={() => setAmount(v)}
                        className={`px-2.5 py-1 rounded-lg border font-mono ${amount === v ? 'border-forge-orange text-white bg-forge-orange/10' : 'border-white/10 text-lunar-300'}`}>
                        {compactXen(v)}
                    </button>
                ))}
                <input aria-label="XEN amount" className="input-forge !py-1 !w-40 font-mono" inputMode="numeric" value={amount.toLocaleString('en-US')}
                    onChange={(e) => { const v = Number(e.target.value.replace(/[^0-9]/g, '')); if (v > 0) setAmount(v); }} />
                <span className="text-lunar-400">XEN as</span>
                <select aria-label="Tier" className="input-forge !py-1 !w-auto" value={tier} onChange={(e) => setTier(Number(e.target.value))}>
                    {P.tiers.map((t, i) => <option key={t.name} value={i}>{t.name} ({t.multiplier}×)</option>)}
                </select>
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[860px]">
                    <thead>
                        <tr className="text-left text-lunar-400 border-b border-white/10 text-xs">
                            <th className="py-2 pr-3 font-normal">Chain</th>
                            <th className="py-2 pr-3 font-normal text-right">Market value of the burn</th>
                            <th className="py-2 pr-3 font-normal text-right">Market depth (L)</th>
                            <th className="py-2 pr-3 font-normal text-right">Burned there this week (V)</th>
                            <th className="py-2 pr-3 font-normal text-right">Counts</th>
                            <th className="py-2 pr-3 font-normal text-right">Counted value</th>
                            <th className="py-2 pr-3 font-normal">Weight</th>
                            <th className="py-2 pr-3 font-normal text-right">Up to (XNT)</th>
                            <th className="py-2 font-normal text-right">Market activity 24 h</th>
                        </tr>
                    </thead>
                    <tbody>
                        {calc.map((c) => {
                            const ch = CHAINS[c.k];
                            const live = isPortalDeployed(c.k);
                            const loading = c.r === 'loading';
                            const stale = c.r !== 'loading' && c.r.stale;
                            const w = c.ok && best > 0 ? c.counted / best : 0;
                            return (
                                <tr key={c.k} className="border-b border-white/5">
                                    <td className="py-2 pr-3 whitespace-nowrap">
                                        <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: ch.color }} />{ch.name}
                                        <div className="text-[11px] text-lunar-500">
                                            {live ? <span className="text-green-400">portal live</span> : <span className="text-amber-300">comparison · portal coming</span>}
                                            {c.r !== 'loading' && c.r.supply !== null ? ` · supply ${big(c.r.supply)}` : ''}
                                            {stale ? <span className="text-amber-300"> · source busy, last value shown</span> : ''}
                                        </div>
                                    </td>
                                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{loading ? '…' : c.ok ? money(c.marketValue) : 'no market'}</td>
                                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{c.ok ? money(c.L) : loading ? '…' : '--'}</td>
                                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{c.ok ? (live ? money(c.weekUsd) : '—') : loading ? '…' : '--'}</td>
                                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{c.ok ? pct(c.factor) : loading ? '…' : '--'}</td>
                                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-white">{c.ok ? money(c.counted) : loading ? '…' : '--'}</td>
                                    <td className="py-2 pr-3 min-w-[110px]">
                                        {c.ok && best > 0 ? (
                                            <div className="flex items-center gap-2">
                                                <div className="h-2 flex-1 rounded bg-space-600 overflow-hidden"><div className="h-full bg-forge-orange" style={{ width: `${Math.max(2, w * 100)}%` }} /></div>
                                                <span className="font-mono text-xs tabular-nums w-10 text-right">{w >= 0.01 ? `${(w * 100).toFixed(0)}%` : '<1%'}</span>
                                            </div>
                                        ) : <span className="text-lunar-500">{loading ? '…' : '--'}</span>}
                                    </td>
                                    <td className="py-2 pr-3 text-right font-mono tabular-nums">{c.ok && c.capXnt !== null ? c.capXnt.toLocaleString('en-US', { maximumFractionDigits: c.capXnt < 10 ? 2 : 0 }) : loading ? '…' : '--'}</td>
                                    <td className="py-2 text-right text-xs text-lunar-400 whitespace-nowrap">{c.ok ? `${c.m.trades24h} trades · ${money(c.m.volume24hUsd)}` : loading ? '…' : '--'}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <p className="text-xs text-lunar-500">
                "Up to" = {P.rateCapK} × counted value × {mult} ({P.tiers[tier].name}), converted at today's XNT price{xntUsd ? ` ($${xntUsd.toFixed(3)})` : ''}: the most an epoch can pay for this burn.
                The real payout is your share of the week's budget{budgetXnt !== null ? ` (now at most ${budgetXnt.toFixed(2)} XNT for everyone together)` : ''}, split by counted value among all burners.
                Ethereum and PulseChain are shown for comparison until their portals launch (XEN Prime is announced for Ethereum XEN only).
                A quiet market (few trades) keeps a still price: the price shown is always the pools' current state.
            </p>

            {!compact && example && example.ok && (
                <div className="bg-space-700/40 rounded-xl p-4 text-sm text-lunar-300 space-y-1">
                    <div className="text-white font-medium mb-1">Worked example with today's numbers ({CHAINS[example.k].name})</div>
                    <div>1. Market value: {amount.toLocaleString('en-US')} XEN × ${example.price.toPrecision(3)} = <strong className="text-white">{money(example.marketValue)}</strong></div>
                    <div>2. Liquidity factor: L / (L + V) = {money(example.L)} / ({money(example.L)} + {money(example.weekUsd)} already burned this week + {money(example.marketValue)} this burn) = <strong className="text-white">{pct(example.factor)}</strong>. That is also about what selling it into that market would return.</div>
                    <div>3. Counted value: {money(example.marketValue)} × {pct(example.factor)} = <strong className="text-white">{money(example.counted)}</strong></div>
                    <div>4. Most an epoch can pay for it: {P.rateCapK} × {money(example.counted)} × {mult} = {money(P.rateCapK * mult * example.counted)}{example.capXnt !== null ? <> ≈ <strong className="text-white">{example.capXnt.toLocaleString('en-US', { maximumFractionDigits: 2 })} XNT</strong></> : ''}</div>
                    <div>5. But never more than the week's budget{budgetXnt !== null ? ` (${budgetXnt.toFixed(2)} XNT now)` : ''}, shared by counted value with everyone who burns that week. Within the fair capacity above, that is at least what a sale would give.</div>
                </div>
            )}

            {!compact && (
                <div className="text-sm text-lunar-300 space-y-2">
                    <div className="text-white font-medium">Why the weights go up or down</div>
                    <ul className="list-disc list-inside space-y-1 text-lunar-400">
                        <li><strong className="text-lunar-200">Price.</strong> Each chain's own market sets it. When XEN gets scarcer or more wanted on a chain, its price rises and every XEN burned there counts for more.</li>
                        <li><strong className="text-lunar-200">Market depth (L).</strong> A deeper market can really absorb more, so a burn there is discounted less.</li>
                        <li><strong className="text-lunar-200">Burns in the same week (V).</strong> All burns on one chain in one epoch share a single factor, L / (L + V), where V is everything burned on that chain that week. More burns lower it for all of them equally: the order does not matter and there is no prize for being first. A burn on a quiet chain keeps more of its value.</li>
                        <li><strong className="text-lunar-200">Supply.</strong> Every burn removes XEN for good. Less XEN on a chain's market can lift its price over time, which feeds back into the first point.</li>
                        <li><strong className="text-lunar-200">The reward pool.</strong> It sets the week's fair capacity. Game stakes, Artifact sales, early-exit penalties and donations all add XNT to it, so more activity of any kind lets more XEN be burned at a better-than-selling rate.</li>
                    </ul>
                    <p className="text-xs text-lunar-500">
                        This table refreshes every 5 minutes from the same sources the oracle uses (only pools against liquid quote assets, junk pools filtered; supply and portal
                        totals read directly from each chain). The oracle credits each burn at its burn-hour price (median of 24 hourly closes in the deepest eligible pool) and
                        publishes every input in the epoch file, so the exact numbers can be recomputed by anyone. Rules: <Link className="text-forge-orange hover:underline" to="/whitepaper">Whitepaper</Link>.
                    </p>
                </div>
            )}
            {compact && (
                <p className="text-xs text-lunar-500">Step-by-step example, fair capacity and why the weights move: <Link className="text-forge-orange hover:underline" to="/transparency">Transparency</Link>.</p>
            )}
        </div>
    );
}
