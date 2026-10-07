/**
 * Artifact Duel — commit-reveal PvP. A live Artifact (any tier) is the ticket to the arena. The creator
 * commits a hidden element (any of the four), an opponent joins in the open with any element, and the
 * creator reveals within 1 hour (or loses). The element is free on purpose: if it were tied to the
 * Artifacts a creator holds (which are public), the opponent could always pick an element that never loses.
 * Cycle: Lunar > Void > Solar > Cosmic > Lunar. Same or opposite element = draw (full refund).
 */
import { Fragment, useState } from 'react';
import { Swords } from 'lucide-react';
import {
    beats, cancelDuel, claimDuelTimeout, createDuel, duelSecret, fetchMyArtifacts, fetchOpenDuels, joinDuel, P, revealDuel,
} from '../../lib/protocol';
import { formatDuration } from '../../lib/constants';
import { useNow, usePoll, useTx } from '../../lib/hooks';
import { AddrLink, Notice, TxStatus, Xnt } from '../ui';
import { ELEMENTS, ELEMENT_ICONS, GameCtx } from './types';

export default function DuelPanel({ ctx }: { ctx: GameCtx }) {
    const { provider, owner, player, refresh } = ctx;
    const duels = usePoll(() => fetchOpenDuels(), [], 15_000);
    const arts = usePoll(() => (owner ? fetchMyArtifacts(owner) : Promise.resolve([])), [owner?.toBase58()], 60_000);
    const tx = useTx();
    const now = useNow(5000);
    const [stake, setStake] = useState('0.1');
    const [element, setElement] = useState(0);
    const [joinEl, setJoinEl] = useState<Record<string, number>>({});

    // any live Artifact is a ticket; use the first one
    const ticket = (arts.data ?? [])[0]?.asset ?? null;

    const stakeNum = Number(stake);
    const balance = player ? Number(player.balance) : 0;
    const canCreate = !!provider && !!ticket && stakeNum >= P.duelMinStake && Math.round(stakeNum * 1e9) <= balance && !tx.busy;

    const reload = () => { duels.reload(); refresh(); };
    const list = duels.data ?? [];

    return (
        <div className="glass-card">
            <div className="flex items-center gap-2 mb-4">
                <Swords className="w-5 h-5 text-forge-gold" />
                <h3 className="font-space text-lg">Artifact Duel</h3>
            </div>

            {provider && arts.data && !ticket && (
                <Notice kind="warn" className="mb-4">An Artifact (any tier) is your ticket to the arena. Forge one on the Artifacts page to create or join duels.</Notice>
            )}

            <div className="grid md:grid-cols-2 gap-6 mb-6">
                <div>
                    <div className="text-xs text-lunar-400 mb-2">Element cycle (choose any element; it stays hidden until you reveal)</div>
                    <div className="grid grid-cols-5 gap-1 text-[11px] text-center">
                        <div />
                        {ELEMENTS.map((e, i) => <div key={e} className="text-lunar-400">{ELEMENT_ICONS[i]} {e}</div>)}
                        {ELEMENTS.map((a, i) => (
                            <Fragment key={a}>
                                <div className="text-lunar-400 text-left">{ELEMENT_ICONS[i]} {a}</div>
                                {ELEMENTS.map((b, j) => {
                                    const r = i === j || (i + 2) % 4 === j ? 'draw' : beats(i, j) ? 'wins' : 'loses';
                                    return <div key={`${a}${b}`} className={`rounded py-1 ${r === 'wins' ? 'bg-green-500/20 text-green-300' : r === 'loses' ? 'bg-red-500/20 text-red-300' : 'bg-space-700 text-lunar-400'}`}>{r}</div>;
                                })}
                            </Fragment>
                        ))}
                    </div>
                    <p className="text-xs text-lunar-500 mt-2">
                        Row vs column. Lunar beats Void, Void beats Solar, Solar beats Cosmic, Cosmic beats Lunar. Same or opposite element
                        (Lunar–Solar, Cosmic–Void) = draw, both stakes refunded. Against a hidden choice every element has the same odds:
                        1 in 4 win, 1 in 4 loss, 2 in 4 draw.
                    </p>
                </div>

                <div>
                    <div className="text-xs text-lunar-400 mb-2">Create a duel (stake from game balance, min {P.duelMinStake} XNT)</div>
                    <div className="grid grid-cols-4 gap-1 mb-2">
                        {ELEMENTS.map((e, i) => (
                            <button key={e} onClick={() => setElement(i)}
                                className={`py-2 rounded-lg border text-xs ${element === i ? 'border-forge-gold text-forge-gold bg-forge-gold/10' : 'border-white/10 text-lunar-300'}`}>
                                {ELEMENT_ICONS[i]} {e}
                            </button>
                        ))}
                    </div>
                    <div className="flex gap-2">
                        <input className="input-forge !py-2" inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} />
                        <button className="btn-forge !px-4 !py-2 text-sm whitespace-nowrap" disabled={!canCreate}
                            onClick={() => provider && ticket && tx.run('Creating duel', () => createDuel(provider, stakeNum, element, ticket), reload)}>
                            Create
                        </button>
                    </div>
                    <Notice kind="warn" className="mt-3">
                        Your hidden element and salt are stored only in <strong>this browser</strong> (localStorage). If you clear it or switch device
                        before revealing, you cannot reveal and you lose the duel {P.duelRevealMinutes} minutes after someone joins.
                        Only the wallet owner can create or join duels (bot session keys cannot).
                    </Notice>
                </div>
            </div>

            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
            {duels.error && <Notice kind="error">{duels.error}</Notice>}

            <div className="text-xs text-lunar-400 mb-2 mt-4">Open and joined duels ({list.length})</div>
            <div className="space-y-2">
                {duels.data && list.length === 0 && <p className="text-sm text-lunar-500">No open duels right now.</p>}
                {list.map((d: any) => {
                    const a = d.account;
                    const key = d.publicKey.toBase58();
                    const isMine = !!owner && a.creator.equals(owner);
                    const iAmOpponent = !!owner && a.state === 1 && a.opponent.equals(owner);
                    const deadline = Number(a.deadline);
                    const secret = isMine ? duelSecret(d.publicKey) : null;
                    const je = joinEl[key] ?? 0;
                    return (
                        <div key={key} className="flex flex-wrap items-center gap-3 bg-space-700/30 rounded-lg p-3 text-sm">
                            <div className="min-w-[140px]">
                                <div className="text-xs text-lunar-400">Creator {isMine && <span className="text-forge-gold">(you)</span>}</div>
                                <AddrLink address={a.creator} />
                            </div>
                            <div><div className="text-xs text-lunar-400">Stake each</div><Xnt lamports={Number(a.stake)} /></div>
                            <div>
                                <div className="text-xs text-lunar-400">State</div>
                                {a.state === 0 ? 'Waiting for opponent'
                                    : <>Joined with {ELEMENT_ICONS[a.opponentElement]} {ELEMENTS[a.opponentElement]} · {now <= deadline ? `reveal in ${formatDuration(deadline - now)}` : 'reveal deadline passed'}</>}
                            </div>
                            <div className="ml-auto flex flex-wrap gap-2 items-center">
                                {!isMine && a.state === 0 && provider && (
                                    <>
                                        <select className="input-forge !py-1 !px-2 !w-auto text-xs" value={je} onChange={(e) => setJoinEl({ ...joinEl, [key]: Number(e.target.value) })}>
                                            {ELEMENTS.map((e, i) => <option key={e} value={i}>{ELEMENTS[i]}</option>)}
                                        </select>
                                        <button className="btn-forge !px-3 !py-1 text-xs"
                                            disabled={!!tx.busy || !ticket || Number(a.stake) > (player ? Number(player.balance) : 0)}
                                            title={!ticket ? 'You need an Artifact (any tier) to join' : undefined}
                                            onClick={() => ticket && tx.run('Joining duel', () => joinDuel(provider, d.publicKey, je, ticket), reload)}>
                                            Join
                                        </button>
                                    </>
                                )}
                                {isMine && a.state === 0 && provider && (
                                    <button className="btn-outline !px-3 !py-1 text-xs" disabled={!!tx.busy}
                                        onClick={() => tx.run('Cancelling duel', () => cancelDuel(provider, d.publicKey), reload)}>Cancel</button>
                                )}
                                {isMine && a.state === 1 && provider && now <= deadline && (
                                    secret ? (
                                        <button className="btn-forge !px-3 !py-1 text-xs" disabled={!!tx.busy}
                                            onClick={() => tx.run('Revealing', () => revealDuel(provider, d.publicKey), reload)}>
                                            Reveal {ELEMENTS[secret.element]}
                                        </button>
                                    ) : <span className="text-xs text-red-400">Secret not in this browser</span>
                                )}
                                {a.state === 1 && now > deadline && provider && (
                                    <button className="btn-outline !px-3 !py-1 text-xs" disabled={!!tx.busy}
                                        onClick={() => tx.run('Claiming timeout', () => claimDuelTimeout(provider, d.publicKey), reload)}>
                                        {iAmOpponent ? 'Claim win (timeout)' : 'Resolve timeout'}
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>

            <p className="text-xs text-lunar-500 mt-4">
                The winner takes both stakes minus a {P.p2pRakePct}% rake ({P.rakeToPoolPct}% reward pool, {P.rakeToArchitectPct}% architect, {P.rakeToDrawPct}% Burn Lottery).
                Draws are refunded in full with no rake. If the creator does not reveal within {P.duelRevealMinutes} minutes, anyone can resolve the duel and the opponent wins.
                Resolved duels are closed on-chain, so they disappear from this list; results are credited to game balances.
            </p>
        </div>
    );
}
