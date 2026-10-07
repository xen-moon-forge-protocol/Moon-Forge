/**
 * Jackpot — multiplayer pot. Closes ~10 min after the first entry; one winner drawn
 * proportionally to the amount entered; 2% rake only when someone wins; a round with a single player is
 * refunded in full. Owner-only entry (session keys cannot enter).
 */
import { useState } from 'react';
import { Trophy } from 'lucide-react';
import { advanceRound, enterJackpot, fetchJackpot, fetchPendingRefunds, P, refundJackpotEntry } from '../../lib/protocol';
import { formatDuration } from '../../lib/constants';
import { useNow, usePoll, useTx } from '../../lib/hooks';
import { AddrLink, Notice, Row, TxStatus, Xnt } from '../ui';
import type { GameCtx } from './types';

const STATE = ['Open', 'Drawing', 'Settled', 'Refunded'];

export default function JackpotPanel({ ctx }: { ctx: GameCtx }) {
    const { provider, owner, player, refresh } = ctx;
    const jp = usePoll(() => fetchJackpot(), [], 10_000);
    const refunds = usePoll(() => fetchPendingRefunds(), [], 60_000);
    const tx = useTx();
    const now = useNow(1000);
    const [amount, setAmount] = useState('0.1');

    const d = jp.data;
    const round = d?.round;
    const total = round ? Number(round.total) : 0;
    const endTs = round ? Number(round.endTs) : 0;
    const open = !round || (round.state === 0 && (endTs === 0 || now < endTs));
    const ended = !!round && round.state === 0 && endTs !== 0 && now >= endTs;
    const drawing = !!round && round.state === 1;
    const mine = owner && d ? d.entries.filter((e: any) => e.player.equals(owner)).reduce((a: number, e: any) => a + Number(e.amount), 0) : 0;

    const amt = Number(amount);
    const lamports = Math.round((amt || 0) * 1e9);
    const balance = player ? Number(player.balance) : 0;
    const canEnter = !!provider && open && amt >= P.minStake && lamports <= balance && !tx.busy;

    const prev = d?.previous;

    return (
        <div className="glass-card">
            <div className="flex items-center gap-2 mb-4">
                <Trophy className="w-5 h-5 text-forge-gold" />
                <h3 className="font-space text-lg">Jackpot</h3>
                <span className="ml-auto text-xs text-lunar-400">Round #{d ? d.roundId : '--'}</span>
            </div>
            {jp.error && <Notice kind="error">{jp.error}</Notice>}
            {d === null && !jp.loading && <Notice kind="warn">Program config not initialized on X1 yet.</Notice>}

            <div className="grid md:grid-cols-2 gap-6">
                <div>
                    <div className="grid grid-cols-2 gap-3 mb-4">
                        <div className="bg-space-700/40 rounded-xl p-3">
                            <div className="text-xs text-lunar-400">Pot</div>
                            <div className="font-space text-xl text-forge-gold"><Xnt lamports={d ? total : null} /></div>
                        </div>
                        <div className="bg-space-700/40 rounded-xl p-3">
                            <div className="text-xs text-lunar-400">Time left</div>
                            <div className="font-space text-xl text-white">
                                {!d ? '--' : !round || endTs === 0 ? 'starts at 1st entry' : round.state !== 0 ? STATE[round.state] : now < endTs ? formatDuration(endTs - now) : 'ended'}
                            </div>
                        </div>
                    </div>
                    <Row label="State">{d ? (round ? STATE[round.state] : 'Open (no entries)') : '--'}</Row>
                    <Row label="Entries">{d ? (round ? round.entries : 0) : '--'}</Row>
                    <Row label="Your stake / chance">{d && owner ? (mine > 0 ? <><Xnt lamports={mine} /> · {((mine / Math.max(1, total)) * 100).toFixed(2)}%</> : '--') : '--'}</Row>
                    <Row label="Winner receives">{d && total > 0 ? <Xnt lamports={total - Math.floor((total * P.p2pRakePct) / 100)} /> : '--'}</Row>

                    <div className="flex gap-2 mt-4">
                        <input className="input-forge !py-2" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="XNT" />
                        <button className="btn-forge !px-4 !py-2 text-sm whitespace-nowrap" disabled={!canEnter}
                            onClick={() => provider && tx.run(`Entering jackpot with ${amt} XNT`, () => enterJackpot(provider, amt), () => { jp.reload(); refresh(); })}>
                            Enter
                        </button>
                    </div>
                    {provider && lamports > balance && <p className="text-xs text-amber-400 mt-1">Above your game balance. Deposit first.</p>}
                    {(ended || drawing) && (
                        <button className="btn-outline !px-4 !py-2 text-sm mt-3 w-full" disabled={!provider || !!tx.busy}
                            onClick={() => provider && tx.run(ended ? 'Closing the round' : 'Settling the round', async () => {
                                const sig = await advanceRound(provider, 'jackpot');
                                if (!sig) throw new Error('Nothing to do yet — wait a few seconds for the target slot and retry.');
                                return sig;
                            }, () => { jp.reload(); refresh(); })}>
                            {ended ? 'Close round (draw)' : 'Settle: pay the winner'}
                        </button>
                    )}
                    {refunds.data && refunds.data.length > 0 && (
                        <button className="btn-outline !px-4 !py-2 text-sm mt-3 w-full" disabled={!provider || !!tx.busy}
                            onClick={() => provider && tx.run('Paying back refunded entries', async () => {
                                let last = '';
                                for (const r of refunds.data!) last = await refundJackpotEntry(provider, r);
                                return last;
                            }, () => { refunds.reload(); refresh(); })}>
                            Pay back {refunds.data.length} refunded entr{refunds.data.length === 1 ? 'y' : 'ies'} (permissionless)
                        </button>
                    )}
                    <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
                </div>

                <div>
                    <div className="text-xs text-lunar-400 mb-2">Entries this round</div>
                    <div className="max-h-48 overflow-y-auto space-y-1">
                        {d && d.entries.length === 0 && <p className="text-sm text-lunar-500">No entries yet.</p>}
                        {d?.entries.map((e: any) => (
                            <div key={e.index} className="flex justify-between text-xs bg-space-700/30 rounded px-2 py-1">
                                <AddrLink address={e.player} />
                                <span><Xnt lamports={Number(e.amount)} /> · {((Number(e.amount) / Math.max(1, total)) * 100).toFixed(1)}%</span>
                            </div>
                        ))}
                    </div>
                    <div className="mt-4 text-xs text-lunar-400">
                        Previous round: {prev ? (
                            prev.state === 2
                                ? <>{prev.multiPlayer ? 'winner' : 'refunded to'} <AddrLink address={prev.winner} /> · pot <Xnt lamports={Number(prev.total)} /></>
                                : STATE[prev.state]
                        ) : '--'}
                    </div>
                </div>
            </div>

            <p className="text-xs text-lunar-500 mt-4">
                Rules: the round closes {P.jackpotMinutes} minutes after the first entry. Then anyone can close it; one winner is drawn with
                probability proportional to the amount entered, from the hash of a future slot. Rake {P.p2pRakePct}% only when there is a winner
                ({P.rakeToPoolPct}% reward pool, {P.rakeToArchitectPct}% architect, {P.rakeToDrawPct}% Burn Lottery). If only one player entered, the pot is fully refunded.
                If nobody settles within ~3 minutes of the draw (the block hash leaves the chain's window), the whole round is refunded entry by
                entry instead of re-drawn, so nobody can wait for a "better" block; anyone (the public keeper included, when it is running) can pay
                the refunds back.
                Entries come from your game balance; prizes are credited to the winner's game balance. Only the wallet owner can enter: session
                keys (bots) cannot.
            </p>
        </div>
    );
}
