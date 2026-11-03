/**
 * Sealed Moon Wars (rules 3): the card battle of the free practice for real XNT, player versus player. No Artifact and no
 * keeper: create_war_sealed (entropy committed) → join_war_sealed (secret committed) → seed_war (creator, 10 min) →
 * reveal_war (joiner, 2 min: the match starts) → moves under a chess clock → settle_war (permissionless).
 * The entropy / secret and a move key are created in this browser before the transaction that commits to them; the move
 * key, funded once with WAR_MOVE_KEY_FUND, signs the seed, the reveal and every move (no pop-up inside the short windows);
 * this page sends this wallet's seed or reveal by itself as soon as it is due. `exitsOnly`: this wallet's matches only.
 */
import { useEffect, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { Swords } from 'lucide-react';
import { useNow, usePoll, useTx } from '../../lib/hooks';
import { formatDuration } from '../../lib/constants';
import { WAR } from '../../lib/protocol';
import { AddrLink, Notice, TxStatus, Xnt } from '../../components/ui';
import { ELEMENT_ICONS, type GameCtx } from '../../components/games/types';
import {
    cancelWarV3, claimWarTimeoutV3, createWarV3, fetchWarsV3, joinWarV3, revealWarV3, seedWarV3, settleWarV3, sweepMoveKeyV3, WAR_MOVE_KEY_FUND,
    warMoveKeyV3, warMoveV3, type Keyed, type WarV3,
} from '../games';
import { browserSecrets, IF_STOPS, warClockBanks, warPhase } from '../sealed';
import { WAR_MIN_STAKE } from '../games-constants';
import { P2P_RAKE_BPS, RAKE_TO_ARCHITECT_BPS, RAKE_TO_POOL_BPS } from '../constants';
import SecretsBackup from './SecretsBackup';

const pct = (bps: bigint) => Number(bps) / 100;
const toLamports = (s: string) => { const n = Number(s); return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e9)) : 0n; };
const STEP_LABEL: Record<string, string> = {
    open: 'Waiting for an opponent', 'expired-offer': 'Offer expired', seed: 'Starting: the creator opens its entropy', reveal: 'Starting: the joiner opens its secret',
    active: 'In progress', done: 'Finished, waiting for payout', legacy: 'Match from before the upgrade',
};

function Card({ element, defense, ready, onClick, selected, dim }: { element: number; defense?: number; ready?: boolean; onClick?: () => void; selected?: boolean; dim?: boolean }) {
    const c = WAR.cards[element];
    return (
        <button type="button" onClick={onClick} disabled={!onClick}
            className={`w-[86px] rounded-lg border p-2 text-left text-xs ${selected ? 'border-forge-gold bg-forge-gold/10' : 'border-white/10 bg-space-700/60'} ${dim ? 'opacity-50' : ''} ${onClick ? 'hover:border-forge-orange' : 'cursor-default'}`}>
            <div className="flex justify-between"><span>{ELEMENT_ICONS[element]}</span><span className="text-mission-launchpad">{c.cost}◆</span></div>
            <div className="text-lunar-200 truncate mt-1">{c.name}</div>
            <div className="font-mono text-lunar-300 mt-1">{c.power}⚔ {defense ?? c.defense}🛡</div>
            {ready !== undefined && <div className={`mt-1 ${ready ? 'text-green-400' : 'text-lunar-500'}`}>{ready ? 'ready' : 'resting'}</div>}
        </button>
    );
}

function Match({ ctx, w, onDone }: { ctx: GameCtx; w: Keyed<WarV3>; onDone: () => void }) {
    const { provider, owner } = ctx;
    const tx = useTx();
    const now = useNow(1000);
    const [attacker, setAttacker] = useState<number | null>(null);
    const a = w.account;
    const store = browserSecrets();
    const ph = warPhase(a, owner, now);
    const meIdx = owner ? (a.creator.equals(owner) ? 0 : a.state >= 1 && a.opponent.equals(owner) ? 1 : -1) : -1;
    const hasKey = !!warMoveKeyV3(w.publicKey, store);
    const run = (label: string, f: () => Promise<any>) => provider && tx.run(label, f, () => { setAttacker(null); onDone(); });
    const canAct = !!provider && ph.step === 'active' && ph.myStep && !tx.busy;
    const banks = ph.step === 'active' ? warClockBanks(BigInt(a.targetSlot.toString())) : null;

    // the seed and the reveal have short windows: send this wallet's step by itself once, as soon as it is due
    const tried = useRef<string | null>(null);
    useEffect(() => {
        if (!provider || tx.busy || !ph.myStep || (ph.step !== 'seed' && ph.step !== 'reveal')) return;
        const tag = `${w.publicKey.toBase58()}:${ph.step}`;
        if (tried.current === tag) return;
        const has = store.get(ph.step === 'seed' ? 'war-create' : 'war-join', w.publicKey.toBase58());
        if (!has) return;
        tried.current = tag;
        void run(ph.step === 'seed' ? 'Opening your entropy' : 'Opening your secret: the match starts', () => (ph.step === 'seed' ? seedWarV3(provider, w.publicKey) : revealWarV3(provider, w.publicKey)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ph.step, ph.myStep, provider, w.publicKey.toBase58()]);

    const me = meIdx >= 0 ? a.sides[meIdx] : a.sides[0];
    const foe = meIdx >= 0 ? a.sides[1 - meIdx] : a.sides[1];
    const field = (s: any) => Array.from({ length: s.fieldLen }, (_, i) => s.field[i]);
    const hand = (s: any) => Array.from({ length: s.handLen }, (_, i) => s.hand[i]);
    const stepSecret = ph.step === 'seed' ? store.get('war-create', w.publicKey.toBase58()) : ph.step === 'reveal' ? store.get('war-join', w.publicKey.toBase58()) : null;

    return (
        <div className="bg-space-700/30 rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
                <span className="text-lunar-400">Stake each</span><Xnt lamports={Number(a.stake.toString())} />
                {ph.step === 'active' && <><span className="text-lunar-400">Round</span><span className="font-mono">{a.round}</span></>}
                <span className="text-lunar-400">{STEP_LABEL[ph.step]}</span>
                {(ph.step === 'seed' || ph.step === 'reveal' || ph.step === 'active' || ph.step === 'open') && (
                    <span className={`ml-auto font-mono ${ph.myStep ? 'text-forge-gold' : 'text-lunar-300'}`}>
                        {ph.step === 'active' ? (ph.myStep ? 'Your turn' : meIdx >= 0 ? "Opponent's turn" : `Player ${a.turn + 1} to move`) + ' · ' : ''}
                        {now <= ph.deadline ? formatDuration(ph.deadline - now) : 'time is up'}
                    </span>
                )}
            </div>
            <p className="text-xs text-lunar-400">{ph.text}</p>
            {banks && <p className="text-xs text-lunar-500">Chess-clock banks: creator {banks[0]} s · joiner {banks[1]} s.</p>}

            {ph.step === 'active' && (
                <>
                    <div className="flex flex-wrap items-center gap-3 text-xs text-lunar-400">
                        <span>Opponent <AddrLink address={meIdx === 1 ? a.creator : a.opponent} /></span>
                        <span className="font-mono text-red-300">{foe.health} HP</span>
                        <span>{foe.handLen} cards in hand · {foe.deckLeft} in deck</span>
                        {attacker !== null && foe.fieldLen === 0 && canAct && (
                            <button className="btn-forge !px-3 !py-1 text-xs" onClick={() => run('Attacking the player', () => warMoveV3(provider!, w.publicKey, { kind: 'attack', attacker, target: 255 }))}>Attack the player</button>
                        )}
                    </div>
                    <div className="flex flex-wrap gap-2 min-h-[96px]">
                        {field(foe).map((u: any, i: number) => (
                            <Card key={i} element={u.element} defense={u.defense} ready={u.ready}
                                onClick={attacker !== null && canAct ? () => run('Attacking', () => warMoveV3(provider!, w.publicKey, { kind: 'attack', attacker, target: i })) : undefined} />
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
                        {canAct && <button className="btn-outline !px-3 !py-1 text-xs ml-auto" onClick={() => run('Ending the turn', () => warMoveV3(provider!, w.publicKey, { kind: 'end' }))}>End turn</button>}
                    </div>
                    {meIdx >= 0 && (
                        <div className="flex flex-wrap gap-2">
                            {hand(me).map((el: number, i: number) => (
                                <Card key={i} element={el} dim={WAR.cards[el].cost > me.mana}
                                    onClick={canAct && WAR.cards[el].cost <= me.mana && me.fieldLen < WAR.fieldMax ? () => run('Summoning', () => warMoveV3(provider!, w.publicKey, { kind: 'summon', hand: i })) : undefined} />
                            ))}
                        </div>
                    )}
                    {meIdx >= 0 && !hasKey && <Notice kind="info">This browser has no move key for this match, so each move asks your wallet to sign. Restore your backup to move without pop-ups.</Notice>}
                </>
            )}

            {a.state === 3 && (
                <div className="text-sm">
                    {a.draw ? 'Draw: both stakes are refunded in full.' : <>Winner <AddrLink address={a.winner} />{owner && a.winner.equals(owner) && <span className="text-forge-gold"> (you)</span>}{a.timeout && ' (the other player ran out of time)'}</>}
                </div>
            )}

            <div className="flex flex-wrap gap-2">
                {ph.myStep && (ph.step === 'seed' || ph.step === 'reveal') && provider && (stepSecret
                    ? <button className="btn-forge !px-3 !py-1 text-xs" disabled={!!tx.busy} onClick={() => run(ph.step === 'seed' ? 'Opening your entropy' : 'Opening your secret', () => (ph.step === 'seed' ? seedWarV3(provider, w.publicKey) : revealWarV3(provider, w.publicKey)))}>
                        {ph.step === 'seed' ? 'Open your entropy now' : 'Open your secret now'}
                    </button>
                    : <span className="text-xs text-red-400">Your secret for this match is not in this browser: restore your backup below before the deadline.</span>)}
                {ph.timeout && provider && (
                    <button className="btn-outline !px-3 !py-1 text-xs" disabled={!!tx.busy} onClick={() => run('Closing on time', () => claimWarTimeoutV3(provider, w.publicKey))}>Close on time</button>
                )}
                {a.state === 3 && provider && (
                    <button className="btn-forge !px-3 !py-1 text-xs" disabled={!!tx.busy} onClick={() => run('Paying out', () => settleWarV3(provider, w.publicKey))}>Pay out</button>
                )}
                {a.state === 0 && meIdx === 0 && provider && (
                    <button className="btn-outline !px-3 !py-1 text-xs" disabled={!!tx.busy} onClick={() => run('Cancelling', () => cancelWarV3(provider, w.publicKey))}>Cancel (full refund)</button>
                )}
            </div>
            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
        </div>
    );
}

export default function WarsV3({ ctx, exitsOnly = false }: { ctx: GameCtx; exitsOnly?: boolean }) {
    const { provider, owner, player, refresh } = ctx;
    const wars = usePoll(() => fetchWarsV3(owner), [owner?.toBase58()], exitsOnly ? 10_000 : 3_000);
    const tx = useTx();
    const now = useNow(5000);
    const [stake, setStake] = useState('0.1');
    const store = browserSecrets();
    const canStore = store.available();
    const stakeL = toLamports(stake);
    const balance = player ? BigInt(player.balance.toString()) : 0n;
    const reload = () => { wars.reload(); refresh(); };
    const list = wars.data ?? [];
    const mine = list.filter((w) => owner && (w.account.creator.equals(owner) || (w.account.state > 0 && w.account.opponent.equals(owner))));
    const open = list.filter((w) => w.account.state === 0 && !(owner && w.account.creator.equals(owner)) && warPhase(w.account, owner, now).step === 'open');
    // a finished match's move key may still hold XNT (e.g. paid out by someone else): offer to sweep it
    // (only once the list is loaded, and never a key made in the last 10 minutes: its match may be landing right now)
    const orphanKeys = !wars.data ? [] : store.list().filter((r) => r.kind === 'war-key' && !list.some((w) => w.publicKey.toBase58() === r.account)
        && Date.now() - Date.parse(r.createdAt) > 600_000);
    if (exitsOnly && mine.length === 0 && orphanKeys.length === 0) return null;
    const canCreate = !!provider && canStore && stakeL >= WAR_MIN_STAKE && stakeL <= balance && !tx.busy;
    const fund = Number(WAR_MOVE_KEY_FUND) / 1e9;

    return (
        <div className="glass-card space-y-5">
            <div className="flex items-center gap-2">
                <Swords className="w-5 h-5 text-forge-gold" />
                <h3 className="font-space text-lg">{exitsOnly ? 'Your Moon Wars matches' : 'Moon Wars · real XNT'}</h3>
            </div>
            {!exitsOnly && (
                <>
                    <div className="grid md:grid-cols-2 gap-6">
                        <div className="text-sm text-lunar-300 space-y-2">
                            <p>Same rules as the free practice. Both players stake the same XNT from their game wallets. Each side plays the same 10 cards (4 Lunar Dust, 3 Cosmic Shard, 2 Solar Core, 1 Void Anomaly), shuffled from a seed both players sealed before either could see the other's half; the first mover is a fair coin from the same seed. Once the match starts both decks are public (perfect information): the better player wins. No Artifact and no keeper are involved.</p>
                            <p>{WAR.startHp} HP each. Mana = min(10, ⌈round ÷ 2⌉ + 1). Units attack from the next turn, enemy units must fall before the player can be hit, a Solar Core burns {WAR.solarBurn} HP when summoned, an empty deck deals 1 fatigue damage, field limit {WAR.fieldMax}. After {WAR.maxRounds} rounds the match is a draw (both refunded).</p>
                            <p>The winner receives both stakes minus {pct(P2P_RAKE_BPS)}% ({pct(RAKE_TO_POOL_BPS)}% reward pool, {pct(RAKE_TO_ARCHITECT_BPS)}% architect); a draw refunds both in full. You can lose the whole stake. Not for anyone under 18 and not where such games are prohibited.</p>
                        </div>
                        <div>
                            <div className="text-xs text-lunar-400 mb-2">Create a match (stake from your game balance, min {Number(WAR_MIN_STAKE) / 1e9} XNT)</div>
                            <div className="flex gap-2">
                                <input className="input-forge !py-2" inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} aria-label="Match stake in XNT" />
                                <button className="btn-forge !px-4 !py-2 text-sm whitespace-nowrap" disabled={!canCreate}
                                    onClick={() => provider && tx.run('Creating the match', () => createWarV3(provider, stakeL), reload)}>Create</button>
                            </div>
                            {provider && stakeL > balance && <p className="text-xs text-amber-400 mt-1">Above your game balance. Deposit first.</p>}
                            <p className="text-xs text-lunar-500 mt-2">
                                Creating or joining also sends {fund} XNT from your wallet to a move key kept in this browser: it pays the fees of your seed, reveal
                                and moves (about 0.0002 XNT each), so no wallet pop-up interrupts the clock. What is left comes back to your wallet at payout or
                                cancel. Only the wallet owner can create or join (bot session keys cannot); your opponent may be an automated agent.
                            </p>
                            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
                        </div>
                    </div>
                    <Notice kind="warn">
                        <strong>If the other player stops.</strong> {IF_STOPS.warOffer} {IF_STOPS.warSeed} {IF_STOPS.warReveal} {IF_STOPS.warClock} Keep this page open while a match starts: it sends your seed or reveal by itself.
                    </Notice>
                    {!canStore && <Notice kind="error">This browser does not allow the site to store data, so it cannot keep your sealed secret and move key: matches are not offered here.</Notice>}
                </>
            )}
            {wars.error && <Notice kind="error">{wars.error}</Notice>}
            {mine.length > 0 && (
                <div className="space-y-3">
                    <div className="text-xs text-lunar-400">Your matches ({mine.length})</div>
                    {mine.map((w) => <Match key={w.publicKey.toBase58()} ctx={ctx} w={w} onDone={reload} />)}
                </div>
            )}
            {orphanKeys.length > 0 && provider && (
                <div className="text-xs text-lunar-400 space-y-1">
                    {orphanKeys.map((r) => (
                        <div key={r.account} className="flex flex-wrap items-center gap-2">
                            <span>Move key of a closed match <AddrLink address={r.account} /></span>
                            <button className="btn-outline !px-2 !py-0.5 text-xs" disabled={!!tx.busy}
                                onClick={() => tx.run('Returning the move key balance', async () => { const s = await sweepMoveKeyV3(provider, new PublicKey(r.account)); store.remove('war-key', r.account); return s ?? ''; }, reload)}>
                                Return its XNT to my wallet
                            </button>
                        </div>
                    ))}
                </div>
            )}
            {!exitsOnly && (
                <div>
                    <div className="text-xs text-lunar-400 mb-2">Open matches ({open.length})</div>
                    <div className="space-y-2">
                        {wars.data && open.length === 0 && <p className="text-sm text-lunar-500">No open matches right now.</p>}
                        {open.map((w) => (
                            <div key={w.publicKey.toBase58()} className="flex flex-wrap items-center gap-3 bg-space-700/30 rounded-lg p-3 text-sm">
                                <div className="min-w-[140px]"><div className="text-xs text-lunar-400">Creator</div><AddrLink address={w.account.creator} /></div>
                                <div><div className="text-xs text-lunar-400">Stake each</div><Xnt lamports={Number(w.account.stake.toString())} /></div>
                                {provider && (
                                    <button className="btn-forge !px-3 !py-1 text-xs ml-auto" disabled={!!tx.busy || !canStore || BigInt(w.account.stake.toString()) > balance}
                                        onClick={() => tx.run('Joining the match (sealed)', () => joinWarV3(provider, w.publicKey), reload)}>Join</button>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
            <SecretsBackup compact={exitsOnly} />
        </div>
    );
}
