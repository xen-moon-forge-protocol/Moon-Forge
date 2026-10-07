/**
 * Predictions — pari-mutuel "XNT up or down" rounds (instructions/predictions.rs).
 * Round k opens at k × 24 h UTC, takes entries for 12 h, and is resolved 24 h after the lock. Start and end
 * prices are the 15-minute TWAP that the XDEX WXNT/USDC.X pool records on-chain; the page reads the same
 * observation account and computes the live TWAP the same way the program does.
 */
import { useState } from 'react';
import { LineChart } from 'lucide-react';
import {
    advancePrediction, claimPrediction, currentPredRound, enterPrediction, fetchLiveTwap, fetchMyPredEntries, fetchPredRound,
    NEXT_UPGRADE_LIVE, P, PRED, predPayout, predTimes, x32ToUsd,
} from '../../lib/protocol';
import { formatDuration } from '../../lib/constants';
import { useNow, usePoll, useTx } from '../../lib/hooks';
import { Notice, Row, TxStatus, Xnt } from '../ui';
import type { GameCtx } from './types';

const STATE = ['Taking entries', 'Locked, waiting for the end price', 'Settled', 'Refunded'];
const usd = (v: number) => `$${v.toFixed(4)}`;

function RoundCard({ id, ctx, now, title }: { id: number; ctx: GameCtx; now: number; title: string }) {
    const round = usePoll(() => fetchPredRound(id), [id], 15_000);
    const tx = useTx();
    const t = predTimes(id);
    const r = round.data;
    const totals = r ? [Number(r.totals[0]), Number(r.totals[1])] : [0, 0];
    const pot = totals[0] + totals[1];
    const due = r && ((r.state === PRED.state.OPEN && now >= t.lock) || (r.state === PRED.state.LOCKED && now >= t.end));
    return (
        <div className="bg-space-700/30 rounded-xl p-4 text-sm space-y-1">
            <div className="flex items-center gap-2 mb-1">
                <span className="font-space text-lunar-200">{title}</span>
                <span className="text-xs text-lunar-500 font-mono">#{id}</span>
                <span className="ml-auto text-xs text-lunar-400">{r ? STATE[r.state] : now < t.lock ? 'Taking entries (no entries yet)' : 'No entries'}</span>
            </div>
            <Row label="Entries close">{now < t.lock ? `in ${formatDuration(t.lock - now)}` : new Date(t.lock * 1000).toUTCString().slice(5, 22)}</Row>
            <Row label="Resolved at">{now < t.end ? `in ${formatDuration(t.end - now)}` : new Date(t.end * 1000).toUTCString().slice(5, 22)}</Row>
            <Row label="UP / DOWN"><><Xnt lamports={totals[1]} digits={2} /> / <Xnt lamports={totals[0]} digits={2} /></></Row>
            <Row label="Pot (cap 200 XNT)"><Xnt lamports={pot} digits={2} /></Row>
            {r && r.state >= PRED.state.LOCKED && Number(r.startPriceX32) > 0 && <Row label="Start price (TWAP)">{usd(x32ToUsd(r.startPriceX32))}</Row>}
            {r && r.state === PRED.state.SETTLED && <Row label="End price (TWAP)">{usd(x32ToUsd(r.endPriceX32))} · {r.outcome === PRED.side.UP ? 'UP won' : 'DOWN won'}</Row>}
            {due && ctx.provider && NEXT_UPGRADE_LIVE && (
                <button className="btn-outline !px-3 !py-1 text-xs mt-2" disabled={!!tx.busy}
                    onClick={() => tx.run(r!.state === PRED.state.OPEN ? 'Locking the round' : 'Settling the round', () => advancePrediction(ctx.provider!, id), () => round.reload())}>
                    {r!.state === PRED.state.OPEN ? 'Lock round' : 'Settle round'}
                </button>
            )}
            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
        </div>
    );
}

export default function PredictionsPanel({ ctx }: { ctx: GameCtx }) {
    const { provider, owner, player, refresh } = ctx;
    const now = useNow(1000);
    const id = currentPredRound(now);
    const t = predTimes(id);
    const twap = usePoll(() => fetchLiveTwap(), [], 30_000);
    const mine = usePoll(() => (owner ? fetchMyPredEntries(owner) : Promise.resolve([])), [owner?.toBase58()], 20_000);
    const tx = useTx();
    const [amount, setAmount] = useState('1');
    const amt = Number(amount);
    const balance = player ? Number(player.balance) : 0;
    const open = now < t.lock;
    const already = (mine.data ?? []).some((e) => Number(e.account.round) === id);
    const canEnter = NEXT_UPGRADE_LIVE && !!provider && open && !already && amt >= PRED.minStakeXnt && Math.round(amt * 1e9) <= balance && !tx.busy;
    const enter = (side: 0 | 1) => provider && tx.run(side ? 'Entering UP' : 'Entering DOWN', () => enterPrediction(provider, side, amt), () => { mine.reload(); refresh(); });

    return (
        <div className="glass-card space-y-5">
            <div className="flex items-center gap-2">
                <LineChart className="w-5 h-5 text-mission-launchpad" />
                <h3 className="font-space text-lg">Predictions · XNT up or down</h3>
                {!NEXT_UPGRADE_LIVE && <span className="ml-auto text-xs px-2 py-1 rounded-full bg-space-600 text-lunar-300">Next upgrade</span>}
            </div>
            {!NEXT_UPGRADE_LIVE && (
                <Notice kind="info">Rounds are written and tested in the program and go live with the next program upgrade. The live price below is real; nothing can be staked yet.</Notice>
            )}

            <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-2 text-sm">
                    <Row label="XNT now (15-min TWAP, XDEX on-chain)">{twap.data ? usd(twap.data.usd) : twap.error ? 'unavailable' : '--'}</Row>
                    {twap.data && <Row label="Last observation">{formatDuration(Math.max(0, now - twap.data.asOf))} ago</Row>}
                    <p className="text-xs text-lunar-500">
                        Read from the XDEX WXNT/USDC.X pool's observation account (4oUvUg…pkPZ), the same account and formula the program uses.
                    </p>
                </div>
                <div>
                    <div className="text-xs text-lunar-400 mb-2">
                        Round #{id}: {open ? `entries close in ${formatDuration(t.lock - now)}` : `entries closed; next round opens in ${formatDuration(predTimes(id + 1).open - now)}`}
                    </div>
                    <div className="flex gap-2">
                        <input className="input-forge !py-2" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in XNT" />
                        <button className="btn-forge !px-4 !py-2 text-sm" disabled={!canEnter} onClick={() => enter(1)}>UP</button>
                        <button className="btn-outline !px-4 !py-2 text-sm" disabled={!canEnter} onClick={() => enter(0)}>DOWN</button>
                    </div>
                    {already && <p className="text-xs text-lunar-400 mt-2">You are in this round (one entry per wallet per round).</p>}
                    <p className="text-xs text-lunar-500 mt-2">Stake from your game balance. Only the wallet owner can enter (bot session keys cannot).</p>
                    <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
                </div>
            </div>

            <div className="grid md:grid-cols-2 gap-4">
                <RoundCard id={id} ctx={ctx} now={now} title="This round" />
                <RoundCard id={id - 1} ctx={ctx} now={now} title="Previous round" />
            </div>

            {owner && (mine.data ?? []).length > 0 && (
                <div>
                    <div className="text-xs text-lunar-400 mb-2">Your entries</div>
                    <div className="space-y-2">
                        {(mine.data ?? []).map((e) => <Entry key={e.publicKey.toBase58()} e={e} ctx={ctx} onDone={() => { mine.reload(); refresh(); }} />)}
                    </div>
                </div>
            )}

            <p className="text-xs text-lunar-500">
                The start price is the 15-minute TWAP ending at the lock, the end price the 15-minute TWAP ending {PRED.horizonSeconds / 3600} h later. If the end price is higher, UP wins; lower, DOWN wins.
                Winners share the pot pro-rata minus a {P.p2pRakePct}% rake ({P.rakeToPoolPct}% reward pool, {P.rakeToArchitectPct}% architect, {P.rakeToDrawPct}% Burn Lottery).
                A tie, a round with one side empty, or price data that is missing or has left the on-chain window refunds everyone in full.
                Locking, settling and paying out are permissionless (the public keeper usually does them). A TWAP can only be moved by holding a distorted price for minutes against arbitrage, and the pot is capped at {PRED.maxPotXnt} XNT.
            </p>
        </div>
    );
}

function Entry({ e, ctx, onDone }: { e: { publicKey: any; account: any }; ctx: GameCtx; onDone: () => void }) {
    const id = Number(e.account.round);
    const round = usePoll(() => fetchPredRound(id), [id], 30_000);
    const tx = useTx();
    const r = round.data;
    const resolved = r && (r.state === PRED.state.SETTLED || r.state === PRED.state.REFUND);
    const payout = r ? predPayout(r, e.account) : 0n;
    return (
        <div className="flex flex-wrap items-center gap-3 bg-space-700/30 rounded-lg p-3 text-sm">
            <span className="font-mono text-xs text-lunar-500">#{id}</span>
            <span className={e.account.side === PRED.side.UP ? 'text-green-300' : 'text-red-300'}>{e.account.side === PRED.side.UP ? 'UP' : 'DOWN'}</span>
            <Xnt lamports={Number(e.account.amount)} digits={2} />
            <span className="text-lunar-400">{r ? STATE[r.state] : '--'}</span>
            {resolved && <span>pays <Xnt lamports={Number(payout)} digits={4} /></span>}
            {resolved && ctx.provider && NEXT_UPGRADE_LIVE && (
                <button className="btn-forge !px-3 !py-1 text-xs ml-auto" disabled={!!tx.busy}
                    onClick={() => tx.run(payout > 0n ? 'Claiming' : 'Closing the entry', () => claimPrediction(ctx.provider!, e), onDone)}>
                    {payout > 0n ? 'Claim to game balance' : 'Close entry'}
                </button>
            )}
            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
        </div>
    );
}
