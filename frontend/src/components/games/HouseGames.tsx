/**
 * House games — Coin Flip, High-Low, Void Rush. One instruction pair on-chain:
 *   place_bet (stake locked, target slot = next slot)  →  settle_bet (permissionless)
 *   roll = keccak("MOONFORGE_RNG" || slotHash(target) || betPubkey || seed) mod 10000
 */
import { useEffect, useMemo, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { Loader2, ShieldCheck, Smartphone } from 'lucide-react';
import { BetResult, errorMessage, GAME, gameOdds, P, playHouse, rollFrom } from '../../lib/protocol';
import { formatDuration, formatNumber } from '../../lib/constants';
import { usePoll } from '../../lib/hooks';
import { Notice, Row, TxLink, Xnt } from '../ui';
import KnownIssues from './KnownIssues';
import { clearPendingBet, isMobileDevice, KEEPER_STATUS_URL, lamportsToInput, maxStakeFor, pendingBets, pendingBetStatus, settleBetNow } from '../../lib/protocol';
import { useTx } from '../../lib/hooks';
import { TxStatus } from '../ui';
import type { GameCtx } from './types';

const GAMES = [
    { id: GAME.COINFLIP, name: 'Coin Flip', icon: '🪙' },
    { id: GAME.HIGHLOW, name: 'High-Low', icon: '🎯' },
    { id: GAME.VOIDRUSH, name: 'Void Rush', icon: '🕳️' },
];

const hexToBytes = (h: string) => Uint8Array.from(h.match(/.{2}/g) ?? [], (b) => parseInt(b, 16));
/** the stake this page proposes when the bankroll and balance allow it */
const DEFAULT_STAKE_LAMPORTS = 100_000_000n; // 0.1 XNT
const MIN_STAKE_LAMPORTS = BigInt(Math.round(P.minStake * 1e9));

/** Keeper status line: static until the oracle publishes a feed (KEEPER_STATUS_URL). */
function KeeperStatus() {
    const st = usePoll(async () => {
        if (!KEEPER_STATUS_URL) return null;
        const r = await fetch(KEEPER_STATUS_URL, { cache: 'no-store' });
        if (!r.ok) throw new Error(`keeper status ${r.status}`);
        return (await r.json()) as { asOf: number; lastPassTs: number; ok: boolean };
    }, [], 60_000);
    const now = Math.floor(Date.now() / 1000);
    if (KEEPER_STATUS_URL && st.data) {
        return (
            <p><strong className="text-white">Public keeper:</strong> last pass {formatDuration(Math.max(0, now - st.data.lastPassTs))} ago{st.data.ok ? '' : ' (reported a failure)'}. It is a safety net only: this page settles your own bet.</p>
        );
    }
    return (
        <p><strong className="text-white">Public keeper:</strong> a best-effort scheduled job with no service level yet: it is scheduled, but in practice its runs are often hours apart, so never count on it within the 3-minute settle window. This page settles your own bet right after the next slot.</p>
    );
}

/**
 * R1/R3: the wallet's own placed-but-unsettled house bets (kept in this browser by playHouse), with "Settle now".
 * Settling is an exit, not a new bet: this block is shown in "Your balances and exits", outside the play notice.
 */
export function PendingHouseBets({ ctx }: { ctx: GameCtx }) {
    const { provider, owner, refresh } = ctx;
    const ownerKey = owner?.toBase58() ?? null;
    const list = usePoll(async () => {
        const mine = pendingBets(ownerKey);
        const out: BetResult[] = [];
        for (const pb of mine) {
            const st = await pendingBetStatus(pb);
            if (st.settled || st.expired) clearPendingBet(pb.bet);
            else out.push(st);
        }
        return out;
    }, [ownerKey], 10_000);
    const tx = useTx();
    const open = list.data ?? [];
    if (!owner || open.length === 0) return null;
    return (
        <div className="glass-card">
            <h3 className="font-space text-lg mb-2">Unsettled house bets</h3>
            <p className="text-xs text-amber-300 mb-3">
                Placed from this browser and not settled yet. Settle each within about 3 minutes of placing it, or it counts as lost even on a winning roll.
            </p>
            <div className="space-y-2">
                {open.map((b) => (
                    <div key={b.bet} className="flex flex-wrap items-center gap-3 bg-space-700/30 rounded-lg p-3 text-sm">
                        <span>{b.stake} XNT</span>
                        <span className="text-lunar-400">{b.roll >= 0 ? `roll ${b.roll} · ${b.won ? `wins ${formatNumber(b.payoutIfWin, 4)} XNT if settled in time` : 'loss'}` : 'roll not known yet'}</span>
                        <TxLink sig={b.placeTx} />
                        <button className="btn-forge !px-3 !py-1 text-xs ml-auto" disabled={!provider || !!tx.busy}
                            onClick={() => provider && tx.run('Settling the bet', async () => (await settleBetNow(provider, new PublicKey(b.bet))).tx ?? '', () => { list.reload(); refresh(); })}>
                            Settle now
                        </button>
                    </div>
                ))}
            </div>
            <TxStatus busy={tx.busy} error={tx.error} lastTx={tx.lastTx} />
        </div>
    );
}

export default function HouseGames({ ctx }: { ctx: GameCtx }) {
    const { provider, owner, player, proto, refresh } = ctx;
    const [game, setGame] = useState<number>(GAME.COINFLIP);
    const [stakeInput, setStakeInput] = useState<string | null>(null); // null = the computed default
    const [side, setSide] = useState(0); // coin: 0 heads 1 tails · high-low: 0 under 1 over
    const [chancePct, setChancePct] = useState(50);
    const [target, setTarget] = useState('2');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [res, setRes] = useState<BetResult | null>(null);
    const [resGame, setResGame] = useState<{ game: number; choice: number } | null>(null);
    const [verify, setVerify] = useState<string | null>(null);
    const [settling, setSettling] = useState(false);
    const mobile = useMemo(isMobileDevice, []);

    // parameters exactly as the program expects them
    const targetBps = Math.round((Number(target) || 0) * 10_000);
    const param = game === GAME.HIGHLOW ? Math.round(chancePct * 100) : game === GAME.VOIDRUSH ? targetBps : 0;
    const paramOk = game === GAME.COINFLIP || (game === GAME.HIGHLOW ? param >= 100 && param <= 9500 : param >= 10_500 && param <= 1_000_000);
    const [chanceBps, payoutBps] = paramOk ? gameOdds(game, param) : [0, 0];
    const choice = game === GAME.VOIDRUSH ? 0 : side;

    const balance = player ? Number(player.balance) : 0;
    // T4-40: the largest stake place_bet accepts right now (per-bet 0.25% cap, 20% aggregate cap, then the game balance)
    const bankrollMax = proto && paramOk ? maxStakeFor(payoutBps, proto.bankrollFree, proto.bankrollReserved) : 0n;
    const balanceMax = (BigInt(Math.max(0, Math.floor(balance))) / 100_000n) * 100_000n;
    const maxStakeL = player ? (bankrollMax < balanceMax ? bankrollMax : balanceMax) : bankrollMax;
    const defaultStakeL = bankrollMax < DEFAULT_STAKE_LAMPORTS ? bankrollMax : DEFAULT_STAKE_LAMPORTS;
    const stake = stakeInput ?? lamportsToInput(defaultStakeL);

    const stakeNum = Number(stake);
    const stakeLamports = isFinite(stakeNum) && stakeNum > 0 ? Math.round(stakeNum * 1e9) : 0;
    // same integer math as games.rs: payout = stake * payout_bps / 10000
    const netWin = paramOk ? Number((BigInt(stakeLamports) * BigInt(payoutBps)) / 10_000n) - stakeLamports : 0;
    const overCap = proto ? netWin > proto.maxNetWin : false;
    const overMax = proto ? BigInt(stakeLamports) > bankrollMax : false;
    const tooSmall = !(stakeNum >= P.minStake);
    const noFunds = stakeLamports > balance;
    const bankrollTooSmall = !!proto && paramOk && bankrollMax < MIN_STAKE_LAMPORTS;
    const canPlay = !!provider && paramOk && !tooSmall && !noFunds && !overCap && !overMax && !busy && !!proto?.initialized;

    const play = async () => {
        if (!provider) return;
        setBusy(true);
        setErr(null);
        setRes(null);
        setVerify(null);
        try {
            const r = await playHouse(provider, game, param, choice, stakeNum);
            setRes(r);
            setResGame({ game, choice });
        } catch (e) {
            setErr(errorMessage(e));
        } finally {
            setBusy(false);
            refresh();
        }
    };

    // R3: a bet placed by this browser but not seen settled (second pop-up rejected, wallet timeout, reload) is kept in
    // localStorage by playHouse; bring the newest one back so its "Settle now" path survives.
    useEffect(() => {
        let alive = true;
        const mine = pendingBets(owner?.toBase58() ?? null);
        const last = mine[mine.length - 1];
        if (!last || res) return;
        pendingBetStatus(last).then((st) => {
            if (!alive) return;
            if (st.settled) { clearPendingBet(last.bet); return; }
            if (st.expired) clearPendingBet(last.bet); // shown once, then forgotten: it counts as lost either way
            setRes(st);
            setResGame({ game: last.game, choice: last.choice });
            setGame(last.game);
        });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [owner?.toBase58()]);

    // X-100: a bet this page could not settle (tab suspended, wallet app in front, pop-up rejected) can be settled by
    // hand, and is retried as soon as the page is visible again. An expired bet needs no settle from the player.
    const pendingSettle = !!res && !res.settled && !res.expired;
    const settleNow = async () => {
        if (!provider || !res || settling) return;
        setSettling(true);
        setErr(null);
        try {
            const out = await settleBetNow(provider, new PublicKey(res.bet));
            let next: BetResult = { ...res, settled: out.settled, settleTx: out.tx ?? res.settleTx, settleError: undefined };
            if (next.roll < 0 && resGame) {
                // the roll was not known yet: recompute it from the stored seed and the target slot
                const st = await pendingBetStatus({
                    bet: res.bet, seed: res.seed, targetSlot: res.targetSlot, game: resGame.game, choice: resGame.choice, param: 0, stake: res.stake,
                    placeTx: res.placeTx, chanceBps: res.chanceBps, payoutIfWin: res.payoutIfWin, placedAt: 0, owner: '',
                });
                next = { ...next, roll: st.roll, won: st.won, payout: st.payout, slotHash: st.slotHash };
            }
            setRes(next);
        } catch (e) {
            setErr(errorMessage(e));
        } finally {
            setSettling(false);
            refresh();
        }
    };
    useEffect(() => {
        if (!pendingSettle) return;
        const onVisible = () => { if (document.visibilityState === 'visible') void settleNow(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [pendingSettle, res?.bet]);

    const runVerify = () => {
        if (!res || !res.slotHash) return;
        const roll = Number(rollFrom(hexToBytes(res.slotHash), new PublicKey(res.bet).toBytes(), hexToBytes(res.seed)) % 10000n);
        setVerify(roll === res.roll ? `Recomputed in your browser: ${roll} — matches.` : `Recomputed ${roll} ≠ shown ${res.roll}`);
    };

    const winRule = (g: number, c: number, chance: number) =>
        g === GAME.COINFLIP ? (c === 0 ? 'heads wins if roll < 5000' : 'tails wins if roll ≥ 5000')
            : g === GAME.HIGHLOW ? (c === 0 ? `under wins if roll < ${chance}` : `over wins if roll ≥ ${10000 - chance}`)
                : `wins if roll < ${chance}`;

    return (
        <div className="glass-card">
            <div className="flex flex-wrap gap-2 mb-5">
                {GAMES.map((g) => (
                    <button key={g.id} onClick={() => { setGame(g.id); setStakeInput(null); setRes(null); setErr(null); }}
                        className={`px-4 py-2 rounded-xl border-2 text-sm ${game === g.id ? 'border-forge-orange bg-forge-orange/10 text-white' : 'border-white/10 text-lunar-300 hover:border-white/20'}`}>
                        {g.icon} {g.name}
                    </button>
                ))}
            </div>

            <div className="grid md:grid-cols-2 gap-6">
                <div className="space-y-4">
                    {game === GAME.COINFLIP && (
                        <div className="grid grid-cols-2 gap-2">
                            {['Heads', 'Tails'].map((l, i) => (
                                <button key={l} onClick={() => setSide(i)} className={`py-3 rounded-xl border-2 ${side === i ? 'border-forge-gold bg-forge-gold/10 text-forge-gold' : 'border-white/10 text-lunar-300'}`}>{l}</button>
                            ))}
                        </div>
                    )}
                    {game === GAME.HIGHLOW && (
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
                    {game === GAME.VOIDRUSH && (
                        <label className="block text-xs text-lunar-400">Target multiplier (1.05× – 100×)
                            <input className="input-forge mt-1" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
                            {!paramOk && <span className="text-red-400">Target must be between 1.05 and 100</span>}
                        </label>
                    )}
                    <label className="block text-xs text-lunar-400">Stake (XNT, min {P.minStake}) — from your game balance
                        <div className="flex gap-2 mt-1">
                            <input className="input-forge" inputMode="decimal" value={stake} onChange={(e) => setStakeInput(e.target.value)} aria-label="Stake in XNT" />
                            <button type="button" className="btn-outline !px-3 !py-1 text-xs whitespace-nowrap" disabled={!proto || !paramOk || maxStakeL < MIN_STAKE_LAMPORTS}
                                title="The largest stake the bankroll and your balance allow for these odds right now"
                                onClick={() => setStakeInput(lamportsToInput(maxStakeL))}>
                                Max
                            </button>
                        </div>
                        {proto && paramOk && (
                            <span className="block mt-1 text-lunar-500">
                                Max for these odds now: {lamportsToInput(bankrollMax)} XNT{player ? ` · with your balance: ${lamportsToInput(maxStakeL)} XNT` : ''}
                            </span>
                        )}
                    </label>

                    <div className="bg-space-700/40 rounded-xl p-3">
                        <Row label="Win chance">{paramOk ? `${(chanceBps / 100).toFixed(2)}%` : '--'}</Row>
                        <Row label="Payout multiplier">{paramOk ? `${(payoutBps / 10_000).toFixed(4)}×` : '--'}</Row>
                        <Row label="Pays on win">{paramOk && stakeNum > 0 ? <Xnt lamports={stakeLamports + netWin} /> : '--'}</Row>
                        <Row label="Max net win allowed now">{proto ? <Xnt lamports={proto.maxNetWin} /> : '--'}</Row>
                        <Row label="Your game balance"><Xnt lamports={player ? balance : null} /></Row>
                    </div>
                    {bankrollTooSmall && <Notice kind="warn">The bankroll is too small for these odds right now: no stake of at least {P.minStake} XNT fits the {P.maxExposurePct}% net-win cap. Try a lower multiplier or come back later.</Notice>}
                    {!bankrollTooSmall && (overCap || overMax) && <Notice kind="warn">This stake is above what the bankroll accepts for these odds right now (max {lamportsToInput(bankrollMax)} XNT: net win capped at {P.maxExposurePct}% of the free bankroll, all open payouts at {P.maxTotalExposurePct}%). Lower the stake or the multiplier.</Notice>}
                    {noFunds && provider && <Notice kind="info">Deposit XNT into your game wallet first.</Notice>}
                    {mobile && provider && (
                        <Notice kind="warn">
                            <div className="flex items-start gap-2">
                                <Smartphone className="w-4 h-4 flex-shrink-0 mt-0.5" />
                                <span>
                                    On a phone, keep this page open and in front until the result shows. Switching to the wallet app or locking the screen can suspend
                                    the page, and a bet not settled within about 3 minutes counts as lost even on a winning roll. Each bet needs two signatures (place,
                                    then settle); if the page falls behind, a "Settle now" button appears when you come back, and the page retries by itself.
                                    A session key (Game wallet) lets a bot of yours place and settle without pop-ups.
                                </span>
                            </div>
                        </Notice>
                    )}

                    <button onClick={play} disabled={!canPlay} className="w-full btn-forge flex items-center justify-center gap-2">
                        {busy ? <><Loader2 className="w-5 h-5 animate-spin" /> Placing and settling…</> : 'Place bet'}
                    </button>
                    {busy && <p className="text-xs text-lunar-400">Sign the bet, then this page waits for the next slot and settles it (one more signature). Takes a few seconds.</p>}
                    {err && <Notice kind="error">{err}</Notice>}
                </div>

                <div>
                    {res && resGame ? (
                        <div className={`rounded-xl p-4 border ${!res.settled && !res.expired ? 'border-amber-500/40' : res.won ? 'border-green-500/40 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
                            <div className="text-center mb-3">
                                {res.expired ? (
                                    <div className="text-xl font-bold text-red-400">Expired unsettled — counts as lost</div>
                                ) : res.roll < 0 ? (
                                    <div className="text-xl font-bold text-amber-400">Waiting for the slot hash…</div>
                                ) : (
                                    <>
                                        <div className="text-xs text-lunar-400">Roll</div>
                                        <div className="font-space text-4xl text-white">{res.roll}</div>
                                        <div className={`text-2xl font-bold mt-1 ${res.won ? 'text-green-400' : 'text-red-400'}`}>
                                            {res.won
                                                ? `WIN: ${formatNumber(res.payout, 4)} XNT ${res.settled ? 'paid' : 'if settled in time'} (net +${formatNumber(res.payout - res.stake, 4)})`
                                                : 'LOSS'}
                                        </div>
                                        <div className="text-xs text-lunar-400 mt-1">{winRule(resGame.game, resGame.choice, res.chanceBps)}</div>
                                    </>
                                )}
                                {!res.settled && !res.expired && (
                                    <div className="mt-2 space-y-2">
                                        <p className="text-xs text-amber-300">
                                            <strong>Bet placed: settle it within about 3 minutes of placing it, or it counts as lost</strong>, even if its roll was a win.
                                            Your stake is already locked. Anyone can settle it (the public keeper is only a safety net and is not there in time).
                                        </p>
                                        {res.settleError && <p className="text-xs text-red-300">This page could not settle it: {res.settleError}</p>}
                                        {provider && (
                                            <button onClick={settleNow} disabled={settling} className="btn-forge !px-4 !py-2 text-sm flex items-center justify-center gap-2 mx-auto">
                                                {settling ? <><Loader2 className="w-4 h-4 animate-spin" /> Settling…</> : 'Settle now'}
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                            <Row label="Stake">{res.stake} XNT</Row>
                            <Row label="Place tx"><TxLink sig={res.placeTx} /></Row>
                            <Row label="Settle tx">{res.settleTx ? <TxLink sig={res.settleTx} /> : res.settled ? 'settled by someone else' : '--'}</Row>
                            <div className="mt-3 p-3 rounded-lg bg-black/30 text-xs font-mono break-all space-y-1">
                                <div className="flex items-center gap-1 text-lunar-300 font-sans"><ShieldCheck className="w-4 h-4 text-green-400" /> Verify</div>
                                <div className="text-lunar-400">roll = keccak256("MOONFORGE_RNG" ‖ slotHash ‖ betPubkey ‖ seed) as u64 LE mod 10000</div>
                                <div>target slot: {res.targetSlot}</div>
                                <div>slotHash: {res.slotHash || '--'}</div>
                                <div>bet: {res.bet}</div>
                                <div>seed: {res.seed}</div>
                                {res.slotHash && <button onClick={runVerify} className="font-sans text-forge-orange hover:underline">Recompute now</button>}
                                {verify && <div className="font-sans text-green-400">{verify}</div>}
                            </div>
                        </div>
                    ) : (
                        <div className="text-sm text-lunar-400 space-y-2">
                            <p><strong className="text-white">How it works:</strong> your stake is locked first; the outcome comes from the hash of the <em>next</em> slot, which is not known to you or the protocol when you bet, mixed with your bet address and a random seed from your browser. Disclosure: the block producer of that slot can influence or withhold its hash (known issue GAM-1 below).</p>
                            <p><strong className="text-white">Settle in time:</strong> this page settles your bet immediately after the next slot. Settlement is permissionless, so the public keeper or anyone can also do it, but the keeper is only a safety net. A bet not settled within about 3 minutes (the slot hash leaves the on-chain window) counts as lost, even if its roll was a win, so nobody can skip a bad result.</p>
                            <KeeperStatus />
                            <p><strong className="text-white">Limits:</strong> the max net win per bet is {P.maxExposurePct}% of the free bankroll, and a bet is refused if all unsettled payouts together would exceed {P.maxTotalExposurePct}% of the bankroll. The default stake and the Max button already respect both. Circuit breaker: if the bankroll (net of LP deposits and withdrawals) has lost 10% since the start of the UTC day, new house bets are refused until the next UTC day.</p>
                            <p><strong className="text-white">Edge:</strong> {P.houseEdgePct}% built into the odds. From every stake: {P.edgeToPoolPct}% to the burners' reward pool, {P.edgeToArchitectPct}% to the architect, the remaining {P.edgeToBankrollPct}% edge stays in the bankroll.</p>
                        </div>
                    )}
                </div>
            </div>
            <KnownIssues ids={['GAM-1', 'GAM-7', 'GAM-L1', 'GAM-L3', 'GAM-X151']} className="mt-5" />
        </div>
    );
}
