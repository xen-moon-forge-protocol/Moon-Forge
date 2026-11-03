/**
 * Sealed Artifact Duel (rules 3): real XNT, player versus player, no Artifact needed and no keeper involved.
 * create_duel (sealed element) → join_duel_sealed (sealed element) → reveal_duel_join (the joiner opens, within 10 min)
 * → reveal_duel (the creator reveals, within ~1 h); timeouts and cancels are permissionless or the creator's.
 * The element and salt of each side are kept in this browser (src/v3/sealed.ts) and can be backed up (SecretsBackup).
 * `exitsOnly`: only this wallet's own duels (open, reveal, timeout, cancel), never a new stake.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { Swords } from 'lucide-react';
import { useNow, usePoll, useTx } from '../../lib/hooks';
import { formatDuration } from '../../lib/constants';
import { AddrLink, Notice, TxStatus, Xnt } from '../../components/ui';
import { ELEMENT_ICONS, type GameCtx } from '../../components/games/types';
import { cancelDuelV3, claimDuelTimeoutV3, createDuelV3, creatorSecretV3, fetchDuelsV3, joinDuelV3, revealDuelJoinV3, revealDuelV3 } from '../games';
import { beats, browserSecrets, duelPhase, ELEMENTS, IF_STOPS } from '../sealed';
import { DUEL_MIN_STAKE } from '../games-constants';
import { P2P_RAKE_BPS, RAKE_TO_ARCHITECT_BPS, RAKE_TO_POOL_BPS } from '../constants';
import SecretsBackup from './SecretsBackup';

const pct = (bps: bigint) => Number(bps) / 100;
const toLamports = (s: string) => { const n = Number(s); return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e9)) : 0n; };

export default function DuelV3({ ctx, exitsOnly = false }: { ctx: GameCtx; exitsOnly?: boolean }) {
    const { provider, owner, player, refresh } = ctx;
    const duels = usePoll(() => fetchDuelsV3(owner), [owner?.toBase58()], 10_000);
    const tx = useTx();
    const now = useNow(1000);
    const [stake, setStake] = useState('0.1');
    const [element, setElement] = useState<number | null>(null);
    const [joinEl, setJoinEl] = useState<Record<string, number>>({});
    const store = browserSecrets();
    const canStore = store.available();
    const balance = player ? BigInt(player.balance.toString()) : 0n;
    const stakeL = toLamports(stake);
    const reload = () => { duels.reload(); refresh(); };
    // a creator who is on the page when the joiner opens reveals at once (one wallet signature, asked once per duel):
    // a creator who never reveals loses the pot
    const asked = useRef(new Set<string>());
    useEffect(() => {
        if (!provider || !owner || tx.busy) return;
        for (const d of duels.data ?? []) {
            const k = d.publicKey.toBase58();
            if (asked.current.has(k) || !d.account.creator.equals(owner)) continue;
            if (duelPhase(d.account, owner, Math.floor(Date.now() / 1000)).action !== 'reveal' || !creatorSecretV3(d.publicKey, store)) continue;
            asked.current.add(k);
            void tx.run('The joiner opened: revealing your element', () => revealDuelV3(provider, d.publicKey), reload);
            break;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [duels.data, provider, owner?.toBase58(), tx.busy]);

    const all = duels.data ?? [];
    const mine = all.filter((d) => owner && (d.account.creator.equals(owner) || (d.account.state >= 1 && d.account.opponent.equals(owner))));
    const open = all.filter((d) => d.account.state === 0 && !(owner && d.account.creator.equals(owner)) && (Number(d.account.deadline.toString()) === 0 || now <= Number(d.account.deadline.toString())));
    if (exitsOnly && mine.length === 0) return null;

    const canCreate = !!provider && canStore && element !== null && stakeL >= DUEL_MIN_STAKE && stakeL <= balance && !tx.busy;

    return (
        <div className="glass-card space-y-5">
            <div className="flex items-center gap-2">
                <Swords className="w-5 h-5 text-forge-gold" />
                <h3 className="font-space text-lg">{exitsOnly ? 'Your Artifact Duels' : 'Artifact Duel · real XNT'}</h3>
            </div>

            {!exitsOnly && (
                <>
                    <p className="text-sm text-lunar-300">
                        Both players stake the same XNT from their game wallets and pick one of four elements, sealed: neither side can see the other's choice
                        before both are locked. No Artifact is needed and no keeper is involved: only the two choices decide. Lunar beats Void, Void beats Solar,
                        Solar beats Cosmic, Cosmic beats Lunar; the same or the opposite element is a draw with a full refund. The winner receives both stakes minus
                        {' '}{pct(P2P_RAKE_BPS)}% ({pct(RAKE_TO_POOL_BPS)}% to the burners' reward pool, {pct(RAKE_TO_ARCHITECT_BPS)}% to the architect). Against a hidden
                        choice every element has the same odds: 1 in 4 win, 1 in 4 loss, 2 in 4 draw. You can lose the whole stake. Not for anyone under 18
                        and not where such games are prohibited.
                    </p>
                    <ElementTable />
                    <Notice kind="warn">
                        <strong>If the other player stops.</strong> {IF_STOPS.duelOffer} {IF_STOPS.duelJoiner} {IF_STOPS.duelCreator}
                    </Notice>
                    {!canStore && <Notice kind="error">This browser does not allow the site to store data, so it cannot keep your sealed element: duels are not offered here. Allow site data or use another browser.</Notice>}
                    <div className="grid md:grid-cols-2 gap-6">
                        <div>
                            <div className="text-xs text-lunar-400 mb-2">Create a duel (stake from your game balance, min {Number(DUEL_MIN_STAKE) / 1e9} XNT)</div>
                            <div className="grid grid-cols-4 gap-1 mb-2">
                                {ELEMENTS.map((e, i) => (
                                    <button key={e} onClick={() => setElement(i)}
                                        className={`py-2 rounded-lg border text-xs ${element === i ? 'border-forge-gold text-forge-gold bg-forge-gold/10' : 'border-white/10 text-lunar-300'}`}>
                                        {ELEMENT_ICONS[i]} {e}
                                    </button>
                                ))}
                            </div>
                            <div className="flex gap-2">
                                <input className="input-forge !py-2" inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} aria-label="Duel stake in XNT" />
                                <button className="btn-forge !px-4 !py-2 text-sm whitespace-nowrap" disabled={!canCreate}
                                    onClick={() => provider && element !== null && tx.run('Creating the duel', () => createDuelV3(provider, stakeL, element), reload)}>
                                    Create
                                </button>
                            </div>
                            {provider && stakeL > balance && <p className="text-xs text-amber-400 mt-1">Above your game balance. Deposit first.</p>}
                        </div>
                        <div className="text-xs text-lunar-400 space-y-2">
                            <p>Your element and a random salt are written to this browser before the transaction is sent, and only a hash of them goes on chain. Back them up (below): without them you cannot reveal, and a sealed choice that is never revealed loses.</p>
                            <p>Only the wallet owner can create or join (bot session keys cannot). Your opponent may be an automated agent: the project's kit is public.</p>
                        </div>
                    </div>
                </>
            )}

            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
            {duels.error && <Notice kind="error">{duels.error}</Notice>}

            {mine.length > 0 && (
                <div className="space-y-2">
                    <div className="text-xs text-lunar-400">Your duels ({mine.length})</div>
                    {mine.map((d) => {
                        const a = d.account;
                        const ph = duelPhase(a, owner, now);
                        const isCreator = !!owner && a.creator.equals(owner);
                        const joinRec = store.get('duel-join', d.publicKey.toBase58());
                        const secret = isCreator ? creatorSecretV3(d.publicKey, store) : joinRec ? { element: joinRec.element as number } : null;
                        return (
                            <div key={d.publicKey.toBase58()} className="bg-space-700/30 rounded-lg p-3 text-sm space-y-2">
                                <div className="flex flex-wrap items-center gap-3">
                                    <span className="text-lunar-400">{isCreator ? 'You created' : 'You joined'}</span>
                                    <Xnt lamports={Number(a.stake.toString())} /> <span className="text-lunar-500">each</span>
                                    {secret && <span className="text-xs text-lunar-400">your element: {ELEMENT_ICONS[secret.element]} {ELEMENTS[secret.element]}</span>}
                                    {a.state >= 1 && a.opponentElement < 4 && <span className="text-xs text-lunar-400">joiner opened {ELEMENT_ICONS[a.opponentElement]} {ELEMENTS[a.opponentElement]}</span>}
                                    {ph.deadline > 0 && a.state <= 1 && <span className="ml-auto font-mono text-xs">{now <= ph.deadline ? `${formatDuration(ph.deadline - now)} left` : 'deadline passed'}</span>}
                                </div>
                                <p className="text-xs text-lunar-400">{ph.text}</p>
                                <div className="flex flex-wrap gap-2">
                                    {ph.action === 'cancel' && provider && (
                                        <button className="btn-outline !px-3 !py-1 text-xs" disabled={!!tx.busy} onClick={() => tx.run('Cancelling the duel', () => cancelDuelV3(provider, d.publicKey), reload)}>Cancel (full refund)</button>
                                    )}
                                    {ph.action === 'open' && provider && (secret
                                        ? <button className="btn-forge !px-3 !py-1 text-xs" disabled={!!tx.busy} onClick={() => tx.run('Opening your element', () => revealDuelJoinV3(provider, d.publicKey), reload)}>Open your element now</button>
                                        : <span className="text-xs text-red-400">Your sealed element is not in this browser: restore your backup below before the deadline.</span>)}
                                    {ph.action === 'reveal' && provider && (secret
                                        ? <button className="btn-forge !px-3 !py-1 text-xs" disabled={!!tx.busy} onClick={() => tx.run('Revealing', () => revealDuelV3(provider, d.publicKey), reload)}>Reveal {ELEMENTS[secret.element]}</button>
                                        : <span className="text-xs text-red-400">Your sealed element is not in this browser: restore your backup below before the deadline.</span>)}
                                    {ph.action === 'timeout' && provider && (
                                        <button className="btn-outline !px-3 !py-1 text-xs" disabled={!!tx.busy} onClick={() => tx.run('Closing on time', () => claimDuelTimeoutV3(provider, d.publicKey), reload)}>Close on time</button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {!exitsOnly && (
                <div>
                    <div className="text-xs text-lunar-400 mb-2">Open duels ({open.length})</div>
                    <div className="space-y-2">
                        {duels.data && open.length === 0 && <p className="text-sm text-lunar-500">No open duels right now.</p>}
                        {open.map((d) => {
                            const key = d.publicKey.toBase58();
                            const je = joinEl[key];
                            const stakeD = BigInt(d.account.stake.toString());
                            const dl = Number(d.account.deadline.toString());
                            return (
                                <div key={key} className="flex flex-wrap items-center gap-3 bg-space-700/30 rounded-lg p-3 text-sm">
                                    <div className="min-w-[140px]"><div className="text-xs text-lunar-400">Creator</div><AddrLink address={d.account.creator} /></div>
                                    <div><div className="text-xs text-lunar-400">Stake each</div><Xnt lamports={Number(stakeD)} /></div>
                                    {dl > 0 && <div className="text-xs text-lunar-400">joinable for {formatDuration(dl - now)}</div>}
                                    {provider && (
                                        <div className="ml-auto flex items-center gap-2">
                                            <select className="input-forge !py-1 !px-2 !w-auto text-xs" value={je ?? ''} aria-label="Your sealed element"
                                                onChange={(e) => setJoinEl({ ...joinEl, [key]: Number(e.target.value) })}>
                                                <option value="" disabled>Element</option>
                                                {ELEMENTS.map((e, i) => <option key={e} value={i}>{e}</option>)}
                                            </select>
                                            <button className="btn-forge !px-3 !py-1 text-xs" disabled={!!tx.busy || !canStore || je === undefined || stakeD > balance}
                                                title="Two signatures: the sealed join, then opening your element a second later"
                                                onClick={() => je !== undefined && tx.run('Joining (sealed), then opening your element', () => joinDuelV3(provider, new PublicKey(key), je), reload)}>
                                                Join
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <p className="text-xs text-lunar-500 mt-2">Joining asks for two signatures: the sealed join, then opening your element one second later. If the second one is rejected, open it from "Your duels" within 10 minutes.</p>
                </div>
            )}
            <SecretsBackup compact={exitsOnly} />
        </div>
    );
}

function ElementTable() {
    return (
        <div className="grid grid-cols-5 gap-1 text-[11px] text-center max-w-md">
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
    );
}
