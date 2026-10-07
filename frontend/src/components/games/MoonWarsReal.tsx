/**
 * Moon Wars for real XNT — player vs player, every move validated by the program (instructions/wars.rs).
 * Same rules as the free practice. Both decks are shuffled by the hash of a block produced after both
 * players joined, and the draw order is public to both (perfect information, like chess).
 * Moves are signed by a key generated in this browser (funded with a few thousandths of XNT for fees),
 * so a move needs no wallet pop-up; the wallet itself can always move too.
 */
import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { Swords } from 'lucide-react';
import {
    cancelWar, claimWarTimeout, createWar, fetchMyArtifacts, fetchWars, joinWar, NEXT_UPGRADE_LIVE, P, settleWar, startWar,
    WAR, warAttack, warEndTurn, warMoveKey, warSummon,
} from '../../lib/protocol';
import { formatDuration } from '../../lib/constants';
import { useNow, usePoll, useTx } from '../../lib/hooks';
import { AddrLink, Notice, TxStatus, Xnt } from '../ui';
import { ELEMENT_ICONS, type GameCtx } from './types';

const STATE_LABEL = ['Waiting for an opponent', 'Starting (waiting for the seed block)', 'In progress', 'Finished, waiting for payout'];

function Card({ element, defense, ready, onClick, selected, dim }: { element: number; defense?: number; ready?: boolean; onClick?: () => void; selected?: boolean; dim?: boolean }) {
    const c = WAR.cards[element];
    return (
        <button type="button" onClick={onClick} disabled={!onClick}
            className={`w-[86px] rounded-lg border p-2 text-left text-xs transition ${selected ? 'border-forge-gold bg-forge-gold/10' : 'border-white/10 bg-space-700/60'} ${dim ? 'opacity-50' : ''} ${onClick ? 'hover:border-forge-orange' : 'cursor-default'}`}>
            <div className="flex justify-between"><span>{ELEMENT_ICONS[element]}</span><span className="text-mission-launchpad">{c.cost}◆</span></div>
            <div className="text-lunar-200 truncate mt-1">{c.name}</div>
            <div className="font-mono text-lunar-300 mt-1">{c.power}⚔ {defense ?? c.defense}🛡</div>
            {ready !== undefined && <div className={`mt-1 ${ready ? 'text-green-400' : 'text-lunar-500'}`}>{ready ? 'ready' : 'resting'}</div>}
        </button>
    );
}

function Match({ ctx, w, onDone }: { ctx: GameCtx; w: { publicKey: PublicKey; account: any }; onDone: () => void }) {
    const { provider, owner } = ctx;
    const tx = useTx();
    const now = useNow(1000);
    const [attacker, setAttacker] = useState<number | null>(null);
    const a = w.account;
    const meIdx = owner ? (a.creator.equals(owner) ? 0 : a.opponent.equals(owner) ? 1 : -1) : -1;
    const deadline = Number(a.deadline);
    const myTurn = a.state === WAR.state.ACTIVE && a.turn === meIdx;
    const canAct = !!provider && myTurn && now <= deadline && !tx.busy && NEXT_UPGRADE_LIVE;
    const me = meIdx >= 0 ? a.sides[meIdx] : a.sides[0];
    const foe = meIdx >= 0 ? a.sides[1 - meIdx] : a.sides[1];
    const hasKey = !!warMoveKey(w.publicKey);
    const run = (label: string, f: () => Promise<any>) => provider && tx.run(label, f, () => { setAttacker(null); onDone(); });

    const field = (s: any) => Array.from({ length: s.fieldLen }, (_, i) => s.field[i]);
    const hand = (s: any) => Array.from({ length: s.handLen }, (_, i) => s.hand[i]);

    return (
        <div className="bg-space-700/30 rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="text-lunar-400">Stake each</span><Xnt lamports={Number(a.stake)} />
                <span className="text-lunar-400">Round</span><span className="font-mono">{a.round}</span>
                <span className="text-lunar-400">{STATE_LABEL[a.state]}</span>
                {a.state === WAR.state.ACTIVE && (
                    <span className={`ml-auto font-mono ${myTurn ? 'text-forge-gold' : 'text-lunar-300'}`}>
                        {myTurn ? 'Your turn' : meIdx >= 0 ? "Opponent's turn" : `Player ${a.turn + 1} to move`} · {now <= deadline ? formatDuration(deadline - now) : 'time is up'}
                    </span>
                )}
            </div>

            {a.state >= WAR.state.ACTIVE && (
                <>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-lunar-400">
                        <span>Opponent <AddrLink address={meIdx === 1 ? a.creator : a.opponent} /></span>
                        <span className="font-mono text-red-300">{foe.health} HP</span>
                        <span>{foe.handLen} cards in hand · {foe.deckLeft} in deck</span>
                        {attacker !== null && foe.fieldLen === 0 && canAct && (
                            <button className="btn-forge !px-3 !py-1 text-xs" onClick={() => run('Attacking the player', () => warAttack(provider!, w.publicKey, attacker, 255))}>Attack the player</button>
                        )}
                    </div>
                    <div className="flex flex-wrap gap-2 min-h-[96px]">
                        {field(foe).map((u: any, i: number) => (
                            <Card key={i} element={u.element} defense={u.defense} ready={u.ready}
                                onClick={attacker !== null && canAct ? () => run('Attacking', () => warAttack(provider!, w.publicKey, attacker, i)) : undefined} />
                        ))}
                        {foe.fieldLen === 0 && <span className="text-xs text-lunar-500 self-center">No enemy units: ready units can hit the player directly.</span>}
                    </div>
                    <div className="border-t border-white/10" />
                    <div className="flex flex-wrap gap-2 min-h-[96px]">
                        {field(me).map((u: any, i: number) => (
                            <Card key={i} element={u.element} defense={u.defense} ready={u.ready} selected={attacker === i}
                                onClick={canAct && u.ready ? () => setAttacker(attacker === i ? null : i) : undefined} />
                        ))}
                        {me.fieldLen === 0 && <span className="text-xs text-lunar-500 self-center">Your field is empty.</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-lunar-400">
                        <span className="font-mono text-green-300">{me.health} HP</span>
                        <span className="font-mono text-mission-launchpad">{me.mana} mana</span>
                        <span>{me.deckLeft} in deck · field {me.fieldLen}/{WAR.fieldMax}</span>
                        {canAct && <button className="btn-outline !px-3 !py-1 text-xs ml-auto" onClick={() => run('Ending turn', () => warEndTurn(provider!, w.publicKey))}>End turn</button>}
                    </div>
                    {meIdx >= 0 && (
                        <div className="flex flex-wrap gap-2">
                            {hand(me).map((el: number, i: number) => (
                                <Card key={i} element={el} dim={WAR.cards[el].cost > me.mana}
                                    onClick={canAct && WAR.cards[el].cost <= me.mana && me.fieldLen < WAR.fieldMax ? () => run('Summoning', () => warSummon(provider!, w.publicKey, i)) : undefined} />
                            ))}
                        </div>
                    )}
                    {canAct && <p className="text-xs text-lunar-500">Click a card in your hand to summon it. Click a ready unit, then an enemy unit (or "Attack the player") to attack.</p>}
                    {meIdx >= 0 && !hasKey && a.state === WAR.state.ACTIVE && (
                        <Notice kind="info">This browser has no move key for this match, so each move asks your wallet to sign.</Notice>
                    )}
                </>
            )}

            {a.state === WAR.state.DONE && (
                <div className="text-sm">
                    {a.draw ? 'Draw: both stakes are refunded in full.' : <>Winner <AddrLink address={a.winner} />{owner && a.winner.equals(owner) && <span className="text-forge-gold"> (you)</span>}{a.timeout && ' (the other player ran out of time)'}</>}
                </div>
            )}

            <div className="flex flex-wrap gap-2">
                {a.state === WAR.state.STARTING && provider && NEXT_UPGRADE_LIVE && (
                    <button className="btn-forge !px-3 !py-1 text-xs" disabled={!!tx.busy} onClick={() => run('Starting the match', () => startWar(provider, w.publicKey))}>Start match</button>
                )}
                {a.state === WAR.state.ACTIVE && now > deadline && provider && NEXT_UPGRADE_LIVE && (
                    <button className="btn-outline !px-3 !py-1 text-xs" disabled={!!tx.busy} onClick={() => run('Claiming the timeout', () => claimWarTimeout(provider, w.publicKey))}>
                        {meIdx >= 0 && a.turn !== meIdx ? 'Claim win (timeout)' : 'Resolve timeout'}
                    </button>
                )}
                {a.state === WAR.state.DONE && provider && NEXT_UPGRADE_LIVE && (
                    <button className="btn-forge !px-3 !py-1 text-xs" disabled={!!tx.busy} onClick={() => run('Paying out', () => settleWar(provider, w.publicKey))}>Pay out</button>
                )}
                {a.state === WAR.state.OPEN && meIdx === 0 && provider && NEXT_UPGRADE_LIVE && (
                    <button className="btn-outline !px-3 !py-1 text-xs" disabled={!!tx.busy} onClick={() => run('Cancelling', () => cancelWar(provider, w.publicKey))}>Cancel (full refund)</button>
                )}
            </div>
            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
        </div>
    );
}

export default function MoonWarsReal({ ctx }: { ctx: GameCtx }) {
    const { provider, owner, player, refresh } = ctx;
    const wars = usePoll(() => fetchWars(owner), [owner?.toBase58()], 4000);
    const arts = usePoll(() => (owner ? fetchMyArtifacts(owner) : Promise.resolve([])), [owner?.toBase58()], 60_000);
    const tx = useTx();
    const [stake, setStake] = useState('0.1');
    const ticket = (arts.data ?? [])[0]?.asset ?? null;
    const stakeNum = Number(stake);
    const balance = player ? Number(player.balance) : 0;
    const canCreate = NEXT_UPGRADE_LIVE && !!provider && !!ticket && stakeNum >= WAR.minStakeXnt && Math.round(stakeNum * 1e9) <= balance && !tx.busy;
    const reload = () => { wars.reload(); refresh(); };
    const list = wars.data ?? [];
    const mine = list.filter((w) => owner && (w.account.creator.equals(owner) || (w.account.state > 0 && w.account.opponent.equals(owner))));
    const open = list.filter((w) => w.account.state === WAR.state.OPEN && !(owner && w.account.creator.equals(owner)));

    return (
        <div className="glass-card space-y-5">
            <div className="flex items-center gap-2">
                <Swords className="w-5 h-5 text-forge-gold" />
                <h3 className="font-space text-lg">Moon Wars · real XNT</h3>
                {!NEXT_UPGRADE_LIVE && <span className="ml-auto text-xs px-2 py-1 rounded-full bg-space-600 text-lunar-300">Next upgrade</span>}
            </div>

            {!NEXT_UPGRADE_LIVE && (
                <Notice kind="info">
                    Real matches are written and tested in the program, and go live with the next program upgrade. Until then nothing can be staked here; the free practice uses the same rules.
                </Notice>
            )}
            {provider && arts.data && !ticket && (
                <Notice kind="warn">An Artifact (any tier) is your ticket to the arena. Forge one on the Artifacts page to create or join a match.</Notice>
            )}

            <div className="grid md:grid-cols-2 gap-6">
                <div className="text-sm text-lunar-300 space-y-2">
                    <p>Both players stake the same amount from their game wallets. Each side plays the same 10 cards (4 Lunar Dust, 3 Cosmic Shard, 2 Solar Core, 1 Void Anomaly), shuffled by the hash of a block produced after both joined. The draw order is public to both, so skill decides.</p>
                    <p>{WAR.startHp} HP each. Mana = min(10, ⌈round ÷ 2⌉ + 1). Units attack from the next turn, enemy units must fall before the player can be hit, a Solar Core burns {WAR.solarBurn} HP when summoned, an empty deck deals 1 fatigue damage. Field limit {WAR.fieldMax} units.</p>
                    <p>A player who does not finish their turn within {WAR.turnSeconds / 60} minutes loses. After {WAR.maxRounds} rounds the match is a draw and both stakes are refunded.</p>
                </div>
                <div>
                    <div className="text-xs text-lunar-400 mb-2">Create a match (stake from game balance, min {WAR.minStakeXnt} XNT)</div>
                    <div className="flex gap-2">
                        <input className="input-forge !py-2" inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} aria-label="Stake in XNT" />
                        <button className="btn-forge !px-4 !py-2 text-sm whitespace-nowrap" disabled={!canCreate}
                            onClick={() => provider && ticket && tx.run('Creating match', () => createWar(provider, stakeNum, ticket), reload)}>
                            Create
                        </button>
                    </div>
                    <p className="text-xs text-lunar-500 mt-2">
                        Creating or joining also sends {WAR.moveKeyFundXnt} XNT to a move key kept in this browser, which pays the fees of your moves. What is left goes back to your wallet at payout.
                        Only the wallet owner can create or join (bot session keys cannot).
                    </p>
                    <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
                </div>
            </div>

            {wars.error && <Notice kind="error">{wars.error}</Notice>}

            {mine.length > 0 && (
                <div className="space-y-3">
                    <div className="text-xs text-lunar-400">Your matches ({mine.length})</div>
                    {mine.map((w) => <Match key={w.publicKey.toBase58()} ctx={ctx} w={w} onDone={reload} />)}
                </div>
            )}

            <div>
                <div className="text-xs text-lunar-400 mb-2">Open matches ({open.length})</div>
                <div className="space-y-2">
                    {wars.data && open.length === 0 && <p className="text-sm text-lunar-500">No open matches right now.</p>}
                    {open.map((w) => (
                        <div key={w.publicKey.toBase58()} className="flex flex-wrap items-center gap-3 bg-space-700/30 rounded-lg p-3 text-sm">
                            <div className="min-w-[140px]"><div className="text-xs text-lunar-400">Creator</div><AddrLink address={w.account.creator} /></div>
                            <div><div className="text-xs text-lunar-400">Stake each</div><Xnt lamports={Number(w.account.stake)} /></div>
                            {provider && (
                                <button className="btn-forge !px-3 !py-1 text-xs ml-auto"
                                    disabled={!NEXT_UPGRADE_LIVE || !!tx.busy || !ticket || Number(w.account.stake) > balance}
                                    title={!ticket ? 'You need an Artifact (any tier) to join' : undefined}
                                    onClick={() => ticket && tx.run('Joining match', () => joinWar(provider, w.publicKey, ticket), reload)}>
                                    Join
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            <p className="text-xs text-lunar-500">
                The winner takes both stakes minus a {P.p2pRakePct}% rake ({P.rakeToPoolPct}% reward pool, {P.rakeToArchitectPct}% architect, {P.rakeToDrawPct}% Burn Lottery).
                Starting, timeouts and payouts are permissionless: either player, the public keeper or anyone can push them. Paid-out matches are closed on-chain.
            </p>
        </div>
    );
}
