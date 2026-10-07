/**
 * Burn Lottery — a round lasts 7 days from its first entry. Weight = chips + tickets (1 XNT each).
 * Prize = 50% of the draw vault at settlement. If nobody settles in time there is no winner and the
 * would-be prize goes to the reward pool (round.prize = amount sent, round.winner = default pubkey).
 */
import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { Ticket } from 'lucide-react';
import { advanceRound, enterDraw, fetchDraw, P } from '../../lib/protocol';
import { formatDuration, formatNumber } from '../../lib/constants';
import { useNow, usePoll, useTx } from '../../lib/hooks';
import { AddrLink, Notice, Row, TxStatus, Xnt } from '../ui';
import type { GameCtx } from './types';

const STATE = ['Open', 'Drawing', 'Settled'];

export default function LotteryPanel({ ctx }: { ctx: GameCtx }) {
    const { provider, player, proto, refresh } = ctx;
    const dr = usePoll(() => fetchDraw(), [], 20_000);
    const tx = useTx();
    const now = useNow(1000);
    const [chips, setChips] = useState('');
    const [tickets, setTickets] = useState('');

    const d = dr.data;
    const round = d?.round;
    const endTs = round ? Number(round.endTs) : 0;
    const open = !round || (round.state === 0 && now < endTs);
    const ended = !!round && round.state === 0 && now >= endTs;
    const drawing = !!round && round.state === 1;
    const prev = d?.previous;

    const myChips = player ? Number(player.chips) : 0;
    const c = Math.floor(Number(chips) || 0);
    const t = Math.floor(Number(tickets) || 0);
    const cost = t * P.ticketPrice * 1e9;
    const balance = player ? Number(player.balance) : 0;
    const valid = c >= 0 && t >= 0 && c + t > 0 && c <= myChips && cost <= balance;

    return (
        <div className="glass-card">
            <div className="flex items-center gap-2 mb-4">
                <Ticket className="w-5 h-5 text-forge-gold" />
                <h3 className="font-space text-lg">Burn Lottery</h3>
                <span className="ml-auto text-xs text-lunar-400">Round #{d ? d.roundId : '--'}</span>
            </div>
            {dr.error && <Notice kind="error">{dr.error}</Notice>}

            <div className="grid md:grid-cols-2 gap-6">
                <div>
                    <div className="grid grid-cols-2 gap-3 mb-4">
                        <div className="bg-space-700/40 rounded-xl p-3">
                            <div className="text-xs text-lunar-400">Prize if drawn now (50% of vault)</div>
                            <div className="font-space text-xl text-forge-gold"><Xnt lamports={proto ? Math.floor(proto.drawVault * P.drawPrizePct / 100) : null} /></div>
                        </div>
                        <div className="bg-space-700/40 rounded-xl p-3">
                            <div className="text-xs text-lunar-400">Ends in</div>
                            <div className="font-space text-xl text-white">
                                {!d ? '--' : !round ? 'starts at 1st entry' : round.state !== 0 ? STATE[round.state] : now < endTs ? formatDuration(endTs - now) : 'ended'}
                            </div>
                        </div>
                    </div>
                    <Row label="Draw vault"><Xnt lamports={proto ? proto.drawVault : null} /></Row>
                    <Row label="Total weight (chips + tickets)">{d ? (round ? formatNumber(Number(round.totalWeight)) : 0) : '--'}</Row>
                    <Row label="Entries">{d ? (round ? round.entries : 0) : '--'}</Row>
                    <Row label="Your chips">{player ? formatNumber(myChips) : '--'}</Row>

                    <div className="grid grid-cols-2 gap-2 mt-4">
                        <label className="text-xs text-lunar-400">Chips
                            <div className="flex gap-1 mt-1">
                                <input className="input-forge !py-2" inputMode="numeric" value={chips} onChange={(e) => setChips(e.target.value)} placeholder="0" />
                                <button className="text-xs text-forge-orange" onClick={() => setChips(String(myChips))}>all</button>
                            </div>
                        </label>
                        <label className="text-xs text-lunar-400">Tickets ({P.ticketPrice} XNT each)
                            <input className="input-forge !py-2 mt-1" inputMode="numeric" value={tickets} onChange={(e) => setTickets(e.target.value)} placeholder="0" />
                        </label>
                    </div>
                    {c > myChips && <p className="text-xs text-red-400 mt-1">You only have {myChips} chips.</p>}
                    {cost > balance && <p className="text-xs text-amber-400 mt-1">Tickets are paid from your game balance. Deposit first.</p>}
                    <button className="btn-forge w-full !py-2 mt-3" disabled={!provider || !open || !valid || !!tx.busy}
                        onClick={() => provider && tx.run(`Entering with ${c} chips + ${t} tickets`, () => enterDraw(provider, c, t), () => { setChips(''); setTickets(''); dr.reload(); refresh(); })}>
                        Enter the draw
                    </button>
                    {(ended || drawing) && (
                        <button className="btn-outline w-full !py-2 mt-2 text-sm" disabled={!provider || !!tx.busy}
                            onClick={() => provider && tx.run(ended ? 'Closing the round' : 'Settling the draw', async () => {
                                const sig = await advanceRound(provider, 'draw');
                                if (!sig) throw new Error('Nothing to do yet — wait a few seconds for the target slot and retry.');
                                return sig;
                            }, () => { dr.reload(); refresh(); })}>
                            {ended ? 'Close the round (draw)' : 'Settle: pay the winner'}
                        </button>
                    )}
                    <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
                </div>

                <div className="text-sm text-lunar-400 space-y-3">
                    <div>
                        <div className="text-white font-bold mb-1">Where chips come from</div>
                        <ul className="list-disc list-inside space-y-1">
                            <li>{P.chipPerClaimedXnt} chip per XNT you actually receive from burns (Launchpad at claim; Orbit / Moon Landing as vested XNT is withdrawn or at eject, never on the part lost to a penalty)</li>
                            <li>1 chip per {P.chipPerWageredXnt} XNT wagered in house games</li>
                            <li>Weekly chips for each Artifact you hold (5 / 15 / 40 / 150 by tier; weeks reset Thursdays 00:00 UTC and missed weeks do not accumulate)</li>
                        </ul>
                        <p className="text-xs mt-1">Chips are non-transferable entries that cost nothing to use: 1 chip = same weight as 1 ticket.</p>
                    </div>
                    <div>
                        <div className="text-white font-bold mb-1">Rules</div>
                        <p className="text-xs">
                            A round starts with its first entry and lasts {P.drawDays} days. Then anyone can close it; a winner is drawn by weight (chips + tickets) from the hash of a future slot.
                            The winner receives {P.drawPrizePct}% of the prize vault (credited to the game balance); the rest stays in the vault.
                            Each ticket: {100 - P.rakeToPoolPct - P.rakeToArchitectPct}% goes to the prize vault, {P.rakeToPoolPct}% to the reward pool and {P.rakeToArchitectPct}% to the
                            architect ({P.p2pRakePct}% is taken at purchase and {P.rakeToDrawPct}% of it goes back to the vault).
                            If nobody settles within ~3 minutes of the draw, the round has no winner: the would-be prize ({P.drawPrizePct}% of the vault) goes to the burners' reward pool.
                            It is never rolled over and never re-drawn, and that round's chips and tickets are spent.
                            Only the wallet owner can enter: session keys (bots) cannot.
                        </p>
                    </div>
                    <div className="text-xs">
                        Previous round: {prev ? (prev.state === 2
                            ? (Number(prev.totalWeight) === 0 ? 'no entries'
                                : new PublicKey(prev.winner).equals(PublicKey.default)
                                    ? <>No winner (draw expired) — <Xnt lamports={Number(prev.prize)} /> sent to the reward pool</>
                                    : <>winner <AddrLink address={prev.winner} /> · prize <Xnt lamports={Number(prev.prize)} /></>)
                            : STATE[prev.state]) : '--'}
                    </div>
                </div>
            </div>
        </div>
    );
}
