/**
 * House games on the keeper's hash chain (rules 3): Coin Flip, High-Low, Void Rush through place_bet_v2.
 *   place_bet_v2 (stake debited, keeper chain position and anchor slot fixed) → anchor_bet (anyone, within ~3 min: mixes
 *   the next block's hash into the seed) → settle_bet_v2 (the keeper's next preimage decides the roll) → win credited to
 *   the game wallet. If nobody anchors in time the whole stake comes back; if the keeper does not reveal within about a
 *   day, or skips the position, the bet is paid as a win from the keeper's bond (refund_stalled_bet, permissionless).
 * Rendered only while the chain shows a live keeper (src/v3/keeper.ts keeperLiveness); MyKeeperBets (the exits) always.
 */
import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { Loader2, ShieldCheck } from 'lucide-react';
import { usePoll, useTx } from '../../lib/hooks';
import { readConnection } from '../../lib/protocol';
import { Notice, Row, TxLink, TxStatus, Xnt } from '../../components/ui';
import type { GameCtx } from '../../components/games/types';
import {
    anchorBetV3, fetchBankrollV3, fetchBetOutcome, fetchMyKeeperBets, GAME_ID, houseIsWin, houseOdds, maxStakeV3, placeBetV3, refundStalledBetV3,
} from '../games';
import { keeperBetWait, lastKeeperActivity } from '../keeper';
import { EDGE_TO_ARCHITECT_BPS, EDGE_TO_POOL_BPS, HOUSE_EDGE_BPS, MAX_DAILY_LOSS_BPS, MAX_EXPOSURE_BPS, MAX_TOTAL_EXPOSURE_BPS, MAX_WEEKLY_LOSS_BPS } from '../constants';
import { MIN_STAKE } from '../games-constants';
import type { HouseKeeperView } from '../layout';

const pct = (bps: bigint) => Number(bps) / 100;
const GAMES = [
    { id: GAME_ID.COINFLIP, name: 'Coin Flip', icon: '🪙' },
    { id: GAME_ID.HIGHLOW, name: 'High-Low', icon: '🎯' },
    { id: GAME_ID.VOIDRUSH, name: 'Void Rush', icon: '🕳️' },
];
const toInput = (l: bigint) => { const w = l / 1_000_000_000n; const f = (l % 1_000_000_000n).toString().padStart(9, '0').slice(0, 4).replace(/0+$/, ''); return f ? `${w}.${f}` : `${w}`; };
const toLamports = (s: string) => { const n = Number(s); return Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e9)) : 0n; };

/** This wallet's open keeper bets with their exits (anchor, refund). Never hidden by the keeper gate or the play notice. */
export function MyKeeperBets({ ctx, seat }: { ctx: GameCtx; seat: HouseKeeperView | null }) {
    const { provider, owner, refresh } = ctx;
    const bets = usePoll(async () => {
        if (!owner) return null;
        const [list, slot] = await Promise.all([fetchMyKeeperBets(owner), readConnection.getSlot('confirmed')]);
        return { list, slot: BigInt(slot) };
    }, [owner?.toBase58()], 8_000);
    const tx = useTx();
    const d = bets.data;
    if (!owner || !d || d.list.length === 0) return null;
    const revealed = seat ? seat.revealed : 0n;
    return (
        <div className="glass-card space-y-2">
            <h3 className="font-space text-lg">Your open house bets</h3>
            <p className="text-xs text-lunar-400">Last keeper activity: {lastKeeperActivity(seat)}.</p>
            {d.list.map((b) => {
                const w = keeperBetWait({ game: b.account.game, targetSlot: BigInt(b.account.targetSlot.toString()) }, revealed, d.slot);
                const reason = w.refundable ? (w.anchored || w.index < revealed ? 'paid as a win (the payout) from the keeper bond' : 'the whole stake back') : null;
                return (
                    <div key={b.publicKey.toBase58()} className="flex flex-wrap items-center gap-3 bg-space-700/30 rounded-lg p-3 text-sm">
                        <span><Xnt lamports={Number(b.account.stake.toString())} /> → <Xnt lamports={Number(b.account.payout.toString())} /> if it wins</span>
                        <span className="text-xs text-lunar-400">
                            {w.refundable ? `Refundable: ${reason}.`
                                : !w.anchored ? 'Not anchored yet: anyone can anchor it; if nobody does within about 3 minutes, the whole stake comes back.'
                                    : `Waiting for the keeper's reveal (${(w.index - revealed).toString()} position(s) ahead incl. this one). If it never comes within about a day, the bet is paid as a win from the keeper bond.`}
                        </span>
                        <div className="ml-auto flex gap-2">
                            {!w.anchored && !w.refundable && provider && (
                                <button className="btn-forge !px-3 !py-1 text-xs" disabled={!!tx.busy} onClick={() => tx.run('Anchoring the bet', async () => (await anchorBetV3(provider, b.publicKey)) ?? '', () => { bets.reload(); refresh(); })}>Anchor</button>
                            )}
                            {w.refundable && provider && (
                                <button className="btn-forge !px-3 !py-1 text-xs" disabled={!!tx.busy} onClick={() => tx.run('Refunding the stalled bet', () => refundStalledBetV3(provider, b.publicKey), () => { bets.reload(); refresh(); })}>Refund</button>
                            )}
                        </div>
                    </div>
                );
            })}
            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
        </div>
    );
}

type Last = { bet: string; placeTx: string; anchorTx: string | null; game: number; choice: number; stake: bigint; payout: bigint; chanceBps: number; anchorError?: string };

export default function HouseV3({ ctx, seat }: { ctx: GameCtx; seat: HouseKeeperView }) {
    const { provider, player, refresh } = ctx;
    const [game, setGame] = useState<number>(GAME_ID.COINFLIP);
    const [side, setSide] = useState(0);
    const [chancePct, setChancePct] = useState(50);
    const [target, setTarget] = useState('2');
    const [stakeInput, setStakeInput] = useState('0.1');
    const [busy, setBusy] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [last, setLast] = useState<Last | null>(null);
    const bank = usePoll(() => fetchBankrollV3(), [], 20_000);
    const outcome = usePoll(async () => (last ? { open: !!(await readConnection.getAccountInfo(new PublicKey(last.bet))), result: await fetchBetOutcome(new PublicKey(last.bet)) } : null), [last?.bet], 4_000);

    const param = game === GAME_ID.HIGHLOW ? Math.round(chancePct * 100) : game === GAME_ID.VOIDRUSH ? Math.round((Number(target) || 0) * 10_000) : 0;
    const choice = game === GAME_ID.VOIDRUSH ? 0 : side;
    const odds = houseOdds(game, param, choice);
    const [chanceBps, payoutBps] = odds ?? [0, 0];
    const stake = toLamports(stakeInput);
    const balance = player ? BigInt(player.balance.toString()) : 0n;
    const maxBank = odds && bank.data ? maxStakeV3(payoutBps, bank.data.vault, bank.data.reserved, seat.bond, seat.jackpotReserved) : 0n;
    const maxStake = player && balance < maxBank ? (balance / 100_000n) * 100_000n : maxBank;
    const payout = odds ? (stake * BigInt(payoutBps)) / 10_000n : 0n;
    const canPlay = !!provider && !!odds && stake >= MIN_STAKE && stake <= balance && stake <= maxBank && !busy;

    const play = async () => {
        if (!provider || !odds) return;
        setErr(null);
        setLast(null);
        try {
            setBusy('Sign the bet…');
            const { tx, bet } = await placeBetV3(provider, game, param, choice, stake);
            const l: Last = { bet: bet.toBase58(), placeTx: tx, anchorTx: null, game, choice, stake, payout, chanceBps };
            setLast(l);
            setBusy('Sign the anchor (mixes the next block into your bet)…');
            try { setLast({ ...l, anchorTx: (await anchorBetV3(provider, bet)) ?? 'by someone else' }); } catch (e: any) {
                setLast({ ...l, anchorError: String(e?.message ?? e).slice(0, 160) });
            }
        } catch (e: any) {
            setErr(String(e?.message ?? e));
        } finally {
            setBusy(null);
            refresh();
            bank.reload();
        }
    };

    const res = outcome.data?.result ?? null;
    return (
        <div className="glass-card">
            <p className="text-xs text-lunar-400 mb-3">Last keeper activity: {lastKeeperActivity(seat)} (arm, reveal or settle; information only: a keeper with no bet to settle has nothing to do).</p>
            <div className="flex flex-wrap gap-2 mb-5">
                {GAMES.map((g) => (
                    <button key={g.id} onClick={() => { setGame(g.id); setErr(null); }}
                        className={`px-4 py-2 rounded-xl border-2 text-sm ${game === g.id ? 'border-forge-orange bg-forge-orange/10 text-white' : 'border-white/10 text-lunar-300 hover:border-white/20'}`}>
                        {g.icon} {g.name}
                    </button>
                ))}
            </div>
            <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-4">
                    {game === GAME_ID.COINFLIP && (
                        <div className="grid grid-cols-2 gap-2">
                            {['Heads (roll < 5000)', 'Tails (roll ≥ 5000)'].map((l, i) => (
                                <button key={l} onClick={() => setSide(i)} className={`py-3 rounded-xl border-2 text-sm ${side === i ? 'border-forge-gold bg-forge-gold/10 text-forge-gold' : 'border-white/10 text-lunar-300'}`}>{l}</button>
                            ))}
                        </div>
                    )}
                    {game === GAME_ID.HIGHLOW && (
                        <>
                            <div className="grid grid-cols-2 gap-2">
                                {['Under', 'Over'].map((l, i) => (
                                    <button key={l} onClick={() => setSide(i)} className={`py-2 rounded-xl border-2 ${side === i ? 'border-forge-gold bg-forge-gold/10 text-forge-gold' : 'border-white/10 text-lunar-300'}`}>{l}</button>
                                ))}
                            </div>
                            <label className="block text-xs text-lunar-400">Win chance: <span className="text-white">{chancePct}%</span>
                                <input type="range" min={1} max={95} step={1} value={chancePct} onChange={(e) => setChancePct(Number(e.target.value))} className="w-full mt-2" />
                            </label>
                        </>
                    )}
                    {game === GAME_ID.VOIDRUSH && (
                        <label className="block text-xs text-lunar-400">Target multiplier (1.05× – 100×)
                            <input className="input-forge mt-1" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
                            {!odds && <span className="text-red-400">Target must be between 1.05 and 100</span>}
                        </label>
                    )}
                    <label className="block text-xs text-lunar-400">Stake (XNT, min {Number(MIN_STAKE) / 1e9}) from your game balance
                        <div className="flex gap-2 mt-1">
                            <input className="input-forge" inputMode="decimal" value={stakeInput} onChange={(e) => setStakeInput(e.target.value)} aria-label="Stake in XNT" />
                            <button type="button" className="btn-outline !px-3 !py-1 text-xs" disabled={maxStake < MIN_STAKE} onClick={() => setStakeInput(toInput(maxStake))}>Max</button>
                        </div>
                        {odds && bank.data && <span className="block mt-1 text-lunar-500">Max for these odds now: {toInput(maxBank)} XNT</span>}
                    </label>
                    <div className="bg-space-700/40 rounded-xl p-3">
                        <Row label="Win chance">{odds ? `${(chanceBps / 100).toFixed(2)}%` : '--'}</Row>
                        <Row label="Payout multiplier">{odds ? `${(payoutBps / 10_000).toFixed(4)}×` : '--'}</Row>
                        <Row label="Pays on win">{odds && stake > 0n ? <Xnt lamports={Number(payout)} /> : '--'}</Row>
                        <Row label="Your game balance"><Xnt lamports={player ? Number(balance) : null} /></Row>
                    </div>
                    {odds && bank.data && maxBank < MIN_STAKE && <Notice kind="warn">The bankroll or the keeper bond is too small for these odds right now: no stake of at least 0.01 XNT fits the limits. Try lower odds or come back later.</Notice>}
                    {odds && stake > maxBank && maxBank >= MIN_STAKE && <Notice kind="warn">This stake is above what the program accepts for these odds now (max {toInput(maxBank)} XNT).</Notice>}
                    {provider && stake > balance && <Notice kind="info">Deposit XNT into your game wallet first.</Notice>}
                    <button onClick={play} disabled={!canPlay} className="w-full btn-forge flex items-center justify-center gap-2">
                        {busy ? <><Loader2 className="w-5 h-5 animate-spin" /> {busy}</> : 'Place bet'}
                    </button>
                    {err && <Notice kind="error">{err}</Notice>}
                </div>
                <div className="text-sm text-lunar-400 space-y-2">
                    {last ? (
                        <div className="rounded-xl p-4 border border-white/10 space-y-2">
                            {res?.kind === 'settled' ? (
                                <div className={`text-center text-xl font-bold ${res.won ? 'text-green-400' : 'text-red-400'}`}>
                                    Roll {res.roll}: {res.won ? `WIN, ${Number(res.payout) / 1e9} XNT credited to your game wallet` : 'LOSS'}
                                    {houseIsWin(last.game, last.choice, last.chanceBps, res.roll) !== res.won && <div className="text-xs text-red-300">(this page's own check disagrees: report it)</div>}
                                </div>
                            ) : res?.kind === 'refunded' ? (
                                <div className="text-center text-lg text-amber-300">{res.reason === 0 ? 'Refunded: nobody anchored it in time, your whole stake is back.' : 'Paid as a win from the keeper bond: the keeper stalled or skipped it.'}</div>
                            ) : (
                                <div className="text-center text-amber-300">
                                    {last.anchorTx ? 'Anchored. Waiting for the keeper\'s reveal (service level: within 10 minutes)…' : 'Placed, not anchored yet: anchor it below (or the keeper will). If nobody anchors within about 3 minutes, the whole stake comes back.'}
                                </div>
                            )}
                            {last.anchorError && <p className="text-xs text-red-300">The anchor was not sent: {last.anchorError}</p>}
                            <Row label="Stake"><Xnt lamports={Number(last.stake)} /></Row>
                            <Row label="Place tx"><TxLink sig={last.placeTx} /></Row>
                            <Row label="Anchor tx">{last.anchorTx && last.anchorTx !== 'by someone else' ? <TxLink sig={last.anchorTx} /> : last.anchorTx ?? '--'}</Row>
                            <Row label="Result tx">{res ? <TxLink sig={res.tx} /> : '--'}</Row>
                        </div>
                    ) : (
                        <>
                            <p><strong className="text-white">How a result is made:</strong> before any bet the keeper committed a hash chain (each value is the hash of the next, so it cannot change them). Your bet takes the chain's next position and fixes an anchor block that does not exist yet. Once anchored, the keeper reveals that position; roll = keccak("MOONFORGE_RNG" ‖ reveal ‖ bet ‖ anchored seed) mod 10,000. Neither you, the keeper nor the block producer alone can steer it; a keeper colluding with the anchor block's producer could, which the limits below and the bond bound.</p>
                            <p><strong className="text-white">If the keeper stops:</strong> a bet nobody anchors within about 3 minutes gives you the whole stake back; an anchored bet the keeper does not reveal within about a day (235,000 slots), or skips, is paid as a win from the keeper bond. Anyone can trigger either refund, and this page lists yours.</p>
                            <p><strong className="text-white">Edge:</strong> {pct(HOUSE_EDGE_BPS)}% built into the odds (a few Void Rush targets about 3% because of rounding). From every stake {pct(EDGE_TO_POOL_BPS)}% goes to the burners' reward pool and {pct(EDGE_TO_ARCHITECT_BPS)}% to the architect; on average players as a group lose. Each bet needs two signatures (place, then anchor).</p>
                            <p><strong className="text-white">Limits:</strong> a bet can win at most {pct(MAX_EXPOSURE_BPS)}% of the free bankroll; all unsettled payouts stay under {pct(MAX_TOTAL_EXPOSURE_BPS)}% of it; counting every unsettled bet as won, the bankroll may lose at most {pct(MAX_DAILY_LOSS_BPS)}% per UTC day and {pct(MAX_WEEKLY_LOSS_BPS)}% over 7 days; the keeper bond must cover every pending payout. A refused bet moves nothing.</p>
                        </>
                    )}
                    <div className="p-3 rounded-lg bg-black/30 text-xs flex items-start gap-2"><ShieldCheck className="w-4 h-4 text-green-400 flex-shrink-0" /><span>Wins are credited to your game wallet; withdraw them at any time (owner signature). You can lose the whole stake. Not for anyone under 18 and not where such games are prohibited.</span></div>
                </div>
            </div>
        </div>
    );
}
