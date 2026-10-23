/**
 * Be the House — deposit XNT into the game bankroll and take the house side: your share of the bankroll rises
 * when players lose and falls when they win. No rate, no promised return; the number shown is the realised result.
 * Withdrawals need a request and a 24 h cooldown and are priced at withdrawal time, so LPs cannot dodge pending bets.
 */
import { useState } from 'react';
import { Landmark } from 'lucide-react';
import { fetchHouseShare, houseDeposit, houseRequestWithdraw, houseShareValue, houseWithdraw, P } from '../../lib/protocol';
import { formatDuration, formatNumber } from '../../lib/constants';
import { useNow, usePoll, useTx } from '../../lib/hooks';
import { Notice, Row, TxStatus, Xnt } from '../ui';
import KnownIssues from './KnownIssues';
import { fetchOpenBets, LP_RESERVED_WARN_BPS, LP_RESULTS_URL, reservedBps, settleReadyBets } from '../../lib/protocol';
import type { GameCtx } from './types';

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const signed = (bps: number) => `${bps >= 0 ? '+' : ''}${(bps / 100).toFixed(2)}%`;

/** Realised result of the bankroll: shown only once the oracle publishes the feed (LP_RESULTS_URL). */
function LpResults() {
    const r = usePoll(async () => {
        if (!LP_RESULTS_URL) return null;
        const res = await fetch(LP_RESULTS_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error(`results ${res.status}`);
        return (await res.json()) as { asOf: number; change7dBps: number; change30dBps: number; maxDrawdown30dBps: number; breakerTrips30d: number };
    }, [], 120_000);
    return (
        <div className="bg-space-700/30 rounded-xl p-3 mt-4">
            <div className="text-xs text-lunar-400 mb-1">Result of the bankroll (realised, per share; not a rate and not a forecast)</div>
            {LP_RESULTS_URL && r.data ? (
                <>
                    <Row label="Last 7 days">{signed(r.data.change7dBps)}</Row>
                    <Row label="Last 30 days">{signed(r.data.change30dBps)}</Row>
                    <Row label="Worst drawdown (30 days)">{pct(r.data.maxDrawdown30dBps)}</Row>
                    <Row label="Daily breaker trips (30 days)">{r.data.breakerTrips30d}</Row>
                    <div className="text-xs text-lunar-500 mt-1">as of {new Date(r.data.asOf * 1000).toUTCString().slice(5, 22)} UTC</div>
                </>
            ) : (
                <p className="text-xs text-lunar-500">
                    Not published yet: the oracle does not record the bankroll's history, so the only number here is the live value of your shares above.
                    When published it shows the 7-day and 30-day change per share, the worst drawdown and how often the daily breaker tripped; never a projection.
                </p>
            )}
            <p className="text-xs text-lunar-500 mt-2">
                This is not staking and has no rate: native X1 staking, with its own risks, is a different thing. Here, players
                winning means your share falls.
            </p>
        </div>
    );
}

/** `exitsOnly` (R1): your shares, Request withdraw and Withdraw only (no deposit), for "Your balances and exits". */
export default function BeTheHouse({ ctx, exitsOnly = false }: { ctx: GameCtx; exitsOnly?: boolean }) {
    const { provider, owner, proto, refresh } = ctx;
    const share = usePoll(() => (owner ? fetchHouseShare(owner) : Promise.resolve(null)), [owner?.toBase58()], 30_000);
    const tx = useTx();
    const now = useNow(5000);
    const [dep, setDep] = useState('');
    const [wdPct, setPct] = useState('100');
    const [override, setOverride] = useState(false);

    const cfg = proto?.config;
    const totalShares = cfg ? cfg.houseTotalShares.toString() : '0';
    const protocolShares = cfg ? Number(cfg.houseProtocolShares) : 0;
    const s = share.data;
    const myShares = s ? BigInt(s.shares.toString()) : 0n;
    const pending = s ? BigInt(s.pendingShares.toString()) : 0n;
    const unlock = s ? Number(s.unlockTs) : 0;
    const myValue = proto && s ? houseShareValue(myShares, totalShares, proto.bankrollFree) : null;
    const pendingValue = proto && s ? houseShareValue(pending, totalShares, proto.bankrollFree) : null;
    const ownership = proto && s && BigInt(totalShares) > 0n ? Number((myShares * 1_000_000n) / BigInt(totalShares)) / 10_000 : null;

    // H2 guard: while open bets reserve more than 1% of the bankroll, a deposit overpays and a withdrawal underpays.
    const rBps = proto ? reservedBps(proto.bankrollFree, proto.bankrollReserved) : 0;
    const guard = rBps > LP_RESERVED_WARN_BPS;
    const blocked = guard && !override;
    const openBets = usePoll(() => (guard ? fetchOpenBets() : Promise.resolve([])), [guard], 20_000);
    const ready = (openBets.data ?? []).filter((b) => b.ready);

    const depVal = Number(dep);
    const pctVal = Math.min(100, Math.max(0, Number(wdPct) || 0));
    const reqShares = (myShares * BigInt(Math.round(pctVal * 100))) / 10_000n;

    const reload = () => { share.reload(); openBets.reload(); refresh(); };

    // Nothing to exit: no shares and no pending request.
    if (exitsOnly && myShares <= 0n && pending <= 0n) return null;

    return (
        <div className="glass-card">
            <div className="flex items-center gap-2 mb-4">
                <Landmark className="w-5 h-5 text-forge-gold" />
                <h3 className="font-space text-lg">Be the House</h3>
            </div>
            <div className="grid md:grid-cols-2 gap-6">
                <div>
                    <Row label="Free bankroll"><Xnt lamports={proto ? proto.bankrollFree : null} /></Row>
                    <Row label="Reserved for open bets"><Xnt lamports={proto ? proto.bankrollReserved : null} />{proto && <span className="text-lunar-500 text-xs"> ({pct(rBps)})</span>}</Row>
                    <Row label="Total shares">{cfg ? formatNumber(Number(totalShares), 0) : '--'}</Row>
                    <Row label="Protocol floor shares (never withdrawable)">{cfg ? formatNumber(protocolShares, 0) : '--'}</Row>
                    <hr className="border-white/10 my-2" />
                    <Row label="Your shares">{s ? formatNumber(Number(myShares), 0) : owner ? '0' : '--'}</Row>
                    <Row label="Your value now">{myValue !== null ? <Xnt lamports={myValue} /> : '--'}</Row>
                    <Row label="Your ownership">{ownership !== null ? `${ownership.toFixed(4)}%` : '--'}</Row>
                    {pending > 0n && (
                        <Row label="Pending withdrawal (value now; priced when you withdraw)">
                            <Xnt lamports={pendingValue} /> · {now >= unlock ? <span className="text-green-400">unlocked</span> : `unlocks in ${formatDuration(unlock - now)}`}
                        </Row>
                    )}
                    {!exitsOnly && <LpResults />}
                </div>
                <div className="space-y-3">
                    {guard && (
                        <Notice kind="warn">
                            Open bets reserve {pct(rBps)} of the bankroll (guard: {pct(LP_RESERVED_WARN_BPS)}). Right now a deposit would overpay (priced as if every open
                            bet loses) and a withdrawal would underpay (priced as if every open bet wins), and the 1% slippage limit cannot protect you from that
                            (known issue GAM-2). Settle the open bets first and retry, or wait: bets settle or expire within about 3 minutes.
                            <div className="mt-2 flex flex-wrap gap-2 items-center">
                                <button className="btn-outline !px-3 !py-1 text-xs" disabled={!provider || ready.length === 0 || !!tx.busy}
                                    onClick={() => provider && tx.run(`Settling ${ready.length} open bet${ready.length === 1 ? '' : 's'}`, async () => (await settleReadyBets(provider, ready)) ?? '', reload)}>
                                    Settle {ready.length} ready bet{ready.length === 1 ? '' : 's'} first{openBets.data && openBets.data.length > ready.length ? ` (${openBets.data.length - ready.length} not ready yet)` : ''}
                                </button>
                                <label className="flex items-center gap-1 text-xs cursor-pointer">
                                    <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> proceed anyway, I accept the worse price
                                </label>
                            </div>
                        </Notice>
                    )}
                    {!exitsOnly && (
                        <div className="flex gap-2">
                            <input className="input-forge !py-2" inputMode="decimal" placeholder="Deposit XNT (min 1)" value={dep} onChange={(e) => setDep(e.target.value)} />
                            <button className="btn-forge !px-4 !py-2 text-sm whitespace-nowrap" disabled={!provider || !(depVal >= 1) || !!tx.busy || !proto?.initialized || blocked}
                                title={blocked ? 'Blocked while open bets reserve more than 1% of the bankroll' : undefined}
                                onClick={() => provider && tx.run(`Depositing ${depVal} XNT into the bankroll`, () => houseDeposit(provider, depVal), () => { setDep(''); reload(); })}>
                                Deposit
                            </button>
                        </div>
                    )}
                    <div className="flex gap-2 items-center">
                        <input className="input-forge !py-2" inputMode="decimal" value={wdPct} onChange={(e) => setPct(e.target.value)} aria-label="Share of your shares to withdraw, in percent" />
                        <span className="text-xs text-lunar-400">%</span>
                        <button className="btn-outline !px-4 !py-2 text-sm whitespace-nowrap" disabled={!provider || reqShares <= 0n || !!tx.busy}
                            onClick={() => provider && tx.run('Requesting withdrawal', () => houseRequestWithdraw(provider, reqShares), reload)}>
                            Request withdraw
                        </button>
                    </div>
                    <button className="btn-forge w-full !py-2 text-sm" disabled={!provider || pending <= 0n || now < unlock || !!tx.busy || blocked}
                        title={blocked ? 'Blocked while open bets reserve more than 1% of the bankroll' : undefined}
                        onClick={() => provider && tx.run('Withdrawing from the bankroll', () => houseWithdraw(provider), reload)}>
                        Withdraw (after cooldown)
                    </button>
                    {pending > 0n && now >= unlock && !blocked && (
                        <p className="text-xs text-lunar-500">Priced now at the conservative value (every open bet counted as won), with a 1% slippage limit: the transaction fails rather than paying less.</p>
                    )}
                    <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
                </div>
            </div>
            {!exitsOnly && <Notice kind="warn" className="mt-4">
                You take the house side: your share rises when players lose and falls when they win. There is no rate and no promised return; you can lose part
                of your deposit, and in a bad run most of it. Deposits are priced as if every open bet loses (nobody can buy shares cheaply while bets are open).
                Withdrawals need a request and a {P.houseWithdrawHours} h cooldown; the amount is priced when you withdraw (not when you request), as if every
                open bet wins, so nobody leaves with money owed to winners. A new request replaces the old one and restarts the {P.houseWithdrawHours} h timer.
                This page sets a 1% slippage limit on deposits and withdrawals and blocks both while open bets reserve more than {pct(LP_RESERVED_WARN_BPS)} of
                the bankroll (you can override). All unsettled payouts together can never exceed {P.maxTotalExposurePct}% of the bankroll, and a daily circuit
                breaker refuses new house bets until the next UTC day once the bankroll (net of LP deposits and withdrawals) has lost {P.maxDailyLossPct}% since
                the start of the UTC day. The first deposit mints permanent protocol shares for the value already in the bankroll (bankroll donations made before
                the first LP included); later donations raise the value of every share. Until the final upgrade, a house bet nobody settles within about
                3 minutes counts as lost and its stake stays in the bankroll, so LPs gain from missed settlements (GAM-X151 below).
            </Notice>}
            {exitsOnly && (
                <p className="text-xs text-lunar-500 mt-3">
                    Withdrawals need a request and a {P.houseWithdrawHours} h cooldown; the amount is priced when you withdraw, as if every open bet wins, with a
                    1% slippage limit. A new request replaces the old one and restarts the timer.
                </p>
            )}
            <KnownIssues ids={exitsOnly ? ['GAM-2', 'GAM-M3'] : ['GAM-2', 'GAM-M3', 'GAM-L1', 'GAM-1', 'GAM-X151']} className="mt-4" />
        </div>
    );
}
