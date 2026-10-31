/**
 * The Forge from the switch epoch (rewards = 3): the binding v3 quote (lib/quote.ts, the oracle's own math) next to the
 * real market route, fail-closed.
 *
 *  (a) the quote: what the epoch pays this burn at its arrival if it lands inside today's remaining capacity;
 *  (b) the market route: sell the XEN into its chain's pools now, bridge ($1 fee, $10 minimum), buy XNT (3% slippage).
 * A red confirmation is required when (a) < (b), when (b) could not be loaded (the page cannot compare them; while (b)
 * is loading the burn stays disabled), or when the burn does not fit today's capacity. Before signing the
 * quote is recomputed from fresh data and the burn is refused if it got worse (re-quote before signing).
 *
 * Inputs: the hourly week-so-far file written by the v3 oracle (lib/quote.ts WeekSoFarFeed, the kit's FEED CONTRACT v1:
 * Σ senior, each chain's curve, L and the current price readings), served with the site at feed/week-so-far.json by the
 * keeper workflow once the feed is live (dormant until the switch). While that file is missing (HTTP 404), stale or
 * inconsistent there is no quote, and the site does not offer the burn (fail-closed); burns from other clients are still
 * scored under the published rules.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ethers } from 'ethers';
import { Notice, Row, TxLink } from '../../components/ui';
import { formatNumber, PROGRAM_ID_B58 } from '../../lib/constants';
import { fetchEpochFile } from '../../lib/protocol';
import { xenMarketLive } from '../../lib/market';
import { fetchXntUsd } from '../../components/BurnVsSell';
import { quoteFromWeek, weekStateFromFeed, type QuoteOk, type QuoteResult, type WeekSoFarFeed } from '../../lib/quote';
import { useDetection } from '../detect';
import { boundaryText, githubDependence, rewardsV3 } from '../facts-v3';

/**
 * The boundary notice (X-034, T9-25), rendered by TheForge whenever V3_BOUNDARY is set, before and after the boundary:
 * the UTC date and, once it exists, the last v2 publish transaction; never an epoch number (WORDING §1).
 */
export function BoundaryNotice({ boundary, className = '' }: { boundary: { date: string; lastV2PublishTx: string | null }; className?: string }) {
    const t = boundaryText(boundary);
    return (
        <Notice kind="info" className={className}>
            {boundary.lastV2PublishTx ? <>{t.lead} <TxLink sig={boundary.lastV2PublishTx} /> {t.rest}</> : t.rest}
        </Notice>
    );
}

/**
 * Where the hourly week-so-far file is served: the site's own origin, next to the epoch files (keeper.yml job `feed`,
 * deployed with the site; no CORS, no new host in the CSP or links.json). The file exists only while the feed is live
 * (from the switch); before that, and whenever a site deploy has not carried it yet, the fetch is a 404: no quote, no
 * burn from this site. Null = never fetch.
 */
export const WEEK_SO_FAR_URL: string | null = `${import.meta.env.BASE_URL}feed/week-so-far.json`;
/** A fresh quote may be at most this much below the one shown before the burn is refused (rounding of a re-read). */
const REQUOTE_TOLERANCE_BPS = 10n;
const WARP_FEE_USD = 1;
const WARP_MIN_USD = 10;
const ROUTE_SLIPPAGE = 0.03;

/** C-14: after the boundary and before the upgraded program is live there is no feed and no quote; the burn waits for v3. */
const UPGRADE_PENDING = 'The final program upgrade is not live yet. A burn made now keeps its own time and waits for the first epoch built under the v3 rules: no epoch under the current rules pays it. No binding quote exists until the upgraded program and the hourly week-so-far file are live, so this page does not offer the burn.';

async function loadState(newestEpoch: number | null, rules: 2 | 3 | 'unknown') {
    if (rules === 2) throw new Error(UPGRADE_PENDING);
    if (rules !== 3) throw new Error('This page could not confirm the upgraded program on X1 yet (the read is pending or failed), so no binding quote is computed. It checks again every few minutes.');
    if (!WEEK_SO_FAR_URL) throw new Error('The hourly week-so-far file is not published yet, so no binding quote can be computed.');
    if (newestEpoch === null) throw new Error('No published epoch file.');
    const [newest, feedRes] = await Promise.all([fetchEpochFile(newestEpoch), fetch(WEEK_SO_FAR_URL, { cache: 'no-store' })]);
    if (feedRes.status === 404) throw new Error('The hourly week-so-far file is not published yet, so no binding quote can be computed.');
    if (!feedRes.ok) throw new Error(`week-so-far file: HTTP ${feedRes.status}`);
    const feed = (await feedRes.json()) as WeekSoFarFeed;
    // D-13: the newest file itself gives each chain's frozen L (and the feed's Lprev must be its twin)
    const state = weekStateFromFeed(feed, { epoch: newest.epoch, dataHash: newest.dataHash }, PROGRAM_ID_B58, newest);
    if (!state) throw new Error('The week-so-far file does not continue the newest epoch file, or its fields disagree (fail-closed).');
    return { state, readings: feed.readings ?? null };
}

export interface V3Gate {
    /** a quote exists and every confirmation it needs is ticked */
    ok: boolean;
    /** re-quote from fresh data right before signing: false = refuse the burn */
    requote: () => Promise<boolean>;
}

export function QuotePanel({ chainKey, chainId, amountWei, tier, busy, onGate, x1 = null }: {
    chainKey: string; chainId: number; amountWei: bigint | null; tier: number; busy: boolean; onGate: (g: V3Gate) => void;
    /** the burn's X1 destination (valid), for the D-18 operator-wallet rule; null = not entered yet */
    x1?: string | null;
}) {
    const det = useDetection();
    const [q, setQ] = useState<QuoteResult | null>(null);
    const [held, setHeld] = useState(false);
    const [loadErr, setLoadErr] = useState<string | null>(null);
    const [routeXnt, setRouteXnt] = useState<number | null>(null);
    // the selling estimate: 'loading' and 'failed' both keep the burn closed (fail-closed); 'failed' asks for a red confirmation
    const [routeState, setRouteState] = useState<'idle' | 'loading' | 'ok' | 'failed'>('idle');
    const [belowAck, setBelowAck] = useState(false);
    const [capAck, setCapAck] = useState(false);
    const [routeAck, setRouteAck] = useState(false);
    const shown = useRef<QuoteOk | null>(null);

    const compute = useCallback(async (): Promise<QuoteResult> => {
        if (!amountWei) return { ok: false, reason: 'Enter an amount.' };
        const { state, readings } = await loadState(det.newestEpoch, det.rules);
        setHeld(state.anomalyHold === true);
        return quoteFromWeek(state, readings, { chainId, amountWei, tier, x1 }, Math.floor(Date.now() / 1000));
    }, [amountWei, chainId, tier, x1, det.rules, det.newestEpoch]);

    useEffect(() => {
        let alive = true;
        setBelowAck(false);
        setCapAck(false);
        setRouteAck(false);
        setLoadErr(null);
        compute().then((r) => { if (alive) { setQ(r); shown.current = r.ok ? r : null; } }).catch((e) => { if (alive) { setQ(null); shown.current = null; setLoadErr(String(e?.message ?? e)); } });
        return () => { alive = false; };
    }, [compute]);

    // (b) the market route, same estimate as BurnVsSell (sell into the chain's pools, bridge, buy XNT)
    useEffect(() => {
        let alive = true;
        setRouteXnt(null);
        setRouteAck(false);
        if (!amountWei) { setRouteState('idle'); return; }
        setRouteState('loading');
        Promise.all([xenMarketLive(chainKey), fetchXntUsd()]).then(([m, x]) => {
            if (!alive) return;
            if (!m || !x) { setRouteState('failed'); return; }
            const value = Number(ethers.formatUnits(amountWei, 18)) * m.spotUsd;
            const real = m.liquidityUsd > 0 ? (value * m.liquidityUsd) / (m.liquidityUsd + value) : 0;
            setRouteXnt(real < WARP_MIN_USD ? 0 : ((real - WARP_FEE_USD) * (1 - ROUTE_SLIPPAGE)) / x);
            setRouteState('ok');
        }).catch(() => { if (alive) setRouteState('failed'); });
        return () => { alive = false; };
    }, [chainKey, amountWei]);

    const ok = !!q && q.ok;
    const quoteXnt = ok ? Number((q as QuoteOk).paidAtArrival) / 1e9 : null;
    const below = ok && routeXnt !== null && quoteXnt !== null && quoteXnt < routeXnt;
    const beyond = ok && (q as QuoteOk).beyondCapacity;
    // F4: without the selling estimate the page cannot compare the quote with selling: never a silent pass
    const routeLoading = ok && amountWei !== null && routeState === 'loading';
    const routeUnknown = ok && amountWei !== null && routeState === 'failed';
    const gateOk = ok && !routeLoading && (!below || belowAck) && (!beyond || capAck) && (!routeUnknown || routeAck);

    useEffect(() => {
        onGate({
            ok: gateOk,
            requote: async () => {
                const prev = shown.current;
                if (!prev) return false;
                const fresh = await compute().catch(() => null);
                if (!fresh || !fresh.ok) return false;
                return fresh.paidAtArrival * 10_000n >= prev.paidAtArrival * (10_000n - REQUOTE_TOLERANCE_BPS);
            },
        });
    }, [gateOk, compute, onGate]);

    const r = ok ? (q as QuoteOk) : null;
    return (
        <div className="mb-4 space-y-3">
            {amountWei !== null && (loadErr || (q && !q.ok)) && (
                <Notice kind="warn">
                    <div className="font-bold text-white">No binding quote right now</div>
                    <div>{loadErr ?? (q as { reason: string }).reason}</div>
                    <div className="text-xs mt-1">Burning from this page stays disabled until a quote can be computed (fail-closed). Nothing here stops a burn you send from another client, and such a burn is scored under the published rules.</div>
                </Notice>
            )}
            {r && (
                <div className="grid sm:grid-cols-2 gap-3">
                    <div className={`rounded-xl p-3 border ${below ? 'border-red-500/50' : 'border-green-500/40'} bg-space-700/40`}>
                        <div className="text-xs text-lunar-400">Paid at arrival if it fits today (binding)</div>
                        <div className="font-space text-2xl text-forge-gold">{formatNumber(quoteXnt!)} XNT</div>
                        <div className="text-[11px] text-lunar-400">
                            {r.leafTier > 0 ? `locked on ${['Launchpad', 'Orbit', 'Moon Landing'][r.leafTier]} and vesting` : r.converted ? 'paid as Launchpad (the vesting piece did not fit)' : 'Launchpad, at claim'}
                            {r.junior > 0n && <> · {formatNumber(Number(r.junior) / 1e9)} XNT more only from the week’s leftover, if any (not promised)</>}
                        </div>
                    </div>
                    <div className="rounded-xl p-3 border border-white/10 bg-space-700/40">
                        <div className="text-xs text-lunar-400">Selling it instead (estimate)</div>
                        <div className="font-space text-2xl text-white">{routeXnt !== null ? `${formatNumber(routeXnt)} XNT` : routeState === 'loading' ? 'loading…' : routeState === 'failed' ? 'could not load' : '--'}</div>
                        <div className="text-[11px] text-lunar-400">sell into the chain’s pools, bridge ($1 fee, $10 minimum), buy XNT (3% slippage); gas not included</div>
                    </div>
                </div>
            )}
            {r && (
                <div className="text-xs text-lunar-400">
                    <Row label="Counted value (at most, until this chain-hour closes)">${formatNumber(Number(r.value) / 1e6)}</Row>
                    <Row label="Today’s capacity left / this week’s">{formatNumber(Number(r.roomToday) / 1e9)} / {formatNumber(Number(r.roomWeek) / 1e9)} XNT</Row>
                    <Row label="Epoch / day of the week">#{r.epoch} / day {r.day + 1}</Row>
                </div>
            )}
            {routeLoading && (
                <p className="text-xs text-lunar-400">Loading the selling estimate: the burn stays disabled until this page can compare the quote with selling.</p>
            )}
            {routeUnknown && (
                <label className="flex items-start gap-2 p-2 rounded-lg border border-red-500/60 bg-red-500/10 text-xs text-red-200 cursor-pointer">
                    <input type="checkbox" className="mt-0.5" checked={routeAck} onChange={(e) => setRouteAck(e.target.checked)} disabled={busy} />
                    <span>The selling estimate could not be loaded, so this page cannot compare the quote with selling. I still want to burn.</span>
                </label>
            )}
            {below && (
                <label className="flex items-start gap-2 p-2 rounded-lg border border-red-500/60 bg-red-500/10 text-xs text-red-200 cursor-pointer">
                    <input type="checkbox" className="mt-0.5" checked={belowAck} onChange={(e) => setBelowAck(e.target.checked)} disabled={busy} />
                    <span>Selling looks better right now: this chain’s curve still remembers recent burns and recovers over the next days. I still want to burn.</span>
                </label>
            )}
            {beyond && (
                <label className="flex items-start gap-2 p-2 rounded-lg border border-red-500/60 bg-red-500/10 text-xs text-red-200 cursor-pointer">
                    <input type="checkbox" className="mt-0.5" checked={capAck} onChange={(e) => setCapAck(e.target.checked)} disabled={busy} />
                    <span>Today’s capacity is used: this burn is NOT paid at arrival, only from the week’s leftover if any is left (it can be nothing). I still want to burn.</span>
                </label>
            )}
            {r && held && (
                <p className="text-xs text-amber-300">This week’s build is held by the published anomaly gate: the epoch is published no sooner than 24 hours after the hold began, rebuilt from fresh reads, and the project account can keep it held longer.</p>
            )}
            <p className="text-[11px] text-lunar-500">{rewardsV3.quote} {rewardsV3.order} {githubDependence}</p>
        </div>
    );
}

export function HowV3Card() {
    return (
        <div className="glass-card">
            <h3 className="font-space text-lg text-forge-gold mb-3">How your payout is computed</h3>
            <ul className="text-sm text-lunar-300 space-y-2 list-disc list-inside">
                <li>{rewardsV3.capacity}</li>
                <li>{rewardsV3.order}</li>
                <li>{rewardsV3.valuation}</li>
                <li>{rewardsV3.tiers}</li>
                <li>{rewardsV3.leftover}</li>
                <li>{rewardsV3.dust}</li>
                <li>{rewardsV3.tranches}</li>
                <li>{rewardsV3.noBoost}</li>
            </ul>
        </div>
    );
}
