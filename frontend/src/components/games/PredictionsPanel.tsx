/**
 * Predictions — exits only. The "XNT up or down" rounds (instructions/predictions.rs) are no longer offered on
 * this site (decision of 2026-10-22, known issue GAM-3): there is no entry button here. A wallet that entered a
 * round before that date can still lock or settle the round, claim a win or take a refund. Every one of these
 * calls is permissionless; the public keeper may make the lock/settle ones (its runs are irregular).
 */
import { LineChart } from 'lucide-react';
import {
    advancePrediction, claimPrediction, fetchMyPredEntries, fetchPredRound, NEXT_UPGRADE_LIVE, PRED, predPayout, predTimes, x32ToUsd,
} from '../../lib/protocol';
import { formatDuration } from '../../lib/constants';
import { useNow, usePoll, useTx } from '../../lib/hooks';
import { Notice, Row, TxStatus, Xnt } from '../ui';
import KnownIssues from './KnownIssues';
import type { GameCtx } from './types';

const STATE = ['Taking entries', 'Locked, waiting for the end price', 'Settled', 'Refunded'];
const usd = (v: number) => `$${v.toFixed(4)}`;

/** Read-only view of the connected wallet's old Predictions entries, with their exits. */
export default function PredictionExits({ ctx }: { ctx: GameCtx }) {
    const { owner, refresh } = ctx;
    const mine = usePoll(() => (owner ? fetchMyPredEntries(owner) : Promise.resolve([])), [owner?.toBase58()], 30_000);
    const entries = mine.data ?? [];

    return (
        <div className="glass-card space-y-4">
            <div className="flex items-center gap-2">
                <LineChart className="w-5 h-5 text-mission-launchpad" />
                <h3 className="font-space text-lg">Predictions · old entries only</h3>
                <span className="ml-auto text-xs px-2 py-1 rounded-full bg-space-600 text-lunar-300">No new entries</span>
            </div>
            <p className="text-sm text-lunar-400">
                XNT up/down rounds are no longer offered on this site (since 2026-10-22; see GAM-3 below). They still exist in the program, so this view only lets
                you finish what you already entered: lock or settle the round when it is due, claim a win to your game balance or take a refund. Nothing can be
                staked here.
            </p>
            {mine.error && <Notice kind="error">{mine.error}</Notice>}
            {!owner && <p className="text-sm text-lunar-500">Connect your X1 wallet to see its entries.</p>}
            {owner && mine.data && entries.length === 0 && <p className="text-sm text-lunar-500">No Predictions entries for this wallet.</p>}
            {entries.length > 0 && (
                <div className="space-y-2">
                    {entries.map((e) => <Entry key={e.publicKey.toBase58()} e={e} ctx={ctx} onDone={() => { mine.reload(); refresh(); }} />)}
                </div>
            )}
            <KnownIssues ids={['GAM-3']} />
        </div>
    );
}

function Entry({ e, ctx, onDone }: { e: { publicKey: any; account: any }; ctx: GameCtx; onDone: () => void }) {
    const id = Number(e.account.round);
    const now = useNow(1000);
    const t = predTimes(id);
    const round = usePoll(() => fetchPredRound(id), [id], 30_000);
    const tx = useTx();
    const r = round.data;
    const resolved = r && (r.state === PRED.state.SETTLED || r.state === PRED.state.REFUND);
    const due = r && ((r.state === PRED.state.OPEN && now >= t.lock) || (r.state === PRED.state.LOCKED && now >= t.end));
    const payout = r ? predPayout(r, e.account) : 0n;
    return (
        <div className="bg-space-700/30 rounded-lg p-3 text-sm space-y-1">
            <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-xs text-lunar-500">#{id}</span>
                <span className={e.account.side === PRED.side.UP ? 'text-green-300' : 'text-red-300'}>{e.account.side === PRED.side.UP ? 'UP' : 'DOWN'}</span>
                <Xnt lamports={Number(e.account.amount)} digits={2} />
                <span className="text-lunar-400">{r ? STATE[r.state] : round.error ? 'round not found' : '--'}</span>
                {resolved && <span>pays <Xnt lamports={Number(payout)} digits={4} /></span>}
                {due && ctx.provider && NEXT_UPGRADE_LIVE && (
                    <button className="btn-outline !px-3 !py-1 text-xs ml-auto" disabled={!!tx.busy}
                        onClick={() => tx.run(r!.state === PRED.state.OPEN ? 'Locking the round' : 'Settling the round', () => advancePrediction(ctx.provider!, id), () => { round.reload(); onDone(); })}>
                        {r!.state === PRED.state.OPEN ? 'Lock round' : 'Settle round'}
                    </button>
                )}
                {resolved && ctx.provider && NEXT_UPGRADE_LIVE && (
                    <button className="btn-forge !px-3 !py-1 text-xs ml-auto" disabled={!!tx.busy}
                        onClick={() => tx.run(payout > 0n ? 'Claiming' : 'Closing the entry', () => claimPrediction(ctx.provider!, e), onDone)}>
                        {payout > 0n ? (r!.state === PRED.state.REFUND ? 'Take the refund' : 'Claim to game balance') : 'Close entry'}
                    </button>
                )}
            </div>
            {r && (
                <div className="text-xs text-lunar-500">
                    {r.state === PRED.state.OPEN && now < t.lock && <>Entries close in {formatDuration(t.lock - now)}; </>}
                    {r.state <= PRED.state.LOCKED && now < t.end && <>resolves in {formatDuration(t.end - now)}. </>}
                    {r.state >= PRED.state.LOCKED && Number(r.startPriceX32) > 0 && <Row label="Start price (TWAP)">{usd(x32ToUsd(r.startPriceX32))}</Row>}
                    {r.state === PRED.state.SETTLED && <Row label="End price (TWAP)">{usd(x32ToUsd(r.endPriceX32))} · {r.outcome === PRED.side.UP ? 'UP won' : 'DOWN won'}</Row>}
                </div>
            )}
            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
        </div>
    );
}
