/**
 * House games — Coin Flip, High-Low, Void Rush. One instruction pair on-chain:
 *   place_bet (stake locked, target slot = next slot)  →  settle_bet (permissionless)
 *   roll = keccak("MOONFORGE_RNG" || slotHash(target) || betPubkey || seed) mod 10000
 */
import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { Loader2, ShieldCheck } from 'lucide-react';
import { BetResult, errorMessage, GAME, gameOdds, P, playHouse, rollFrom } from '../../lib/protocol';
import { formatNumber } from '../../lib/constants';
import { Notice, Row, TxLink, Xnt } from '../ui';
import type { GameCtx } from './types';

const GAMES = [
    { id: GAME.COINFLIP, name: 'Coin Flip', icon: '🪙' },
    { id: GAME.HIGHLOW, name: 'High-Low', icon: '🎯' },
    { id: GAME.VOIDRUSH, name: 'Void Rush', icon: '🕳️' },
];

const hexToBytes = (h: string) => Uint8Array.from(h.match(/.{2}/g) ?? [], (b) => parseInt(b, 16));

export default function HouseGames({ ctx }: { ctx: GameCtx }) {
    const { provider, player, proto, refresh } = ctx;
    const [game, setGame] = useState<number>(GAME.COINFLIP);
    const [stake, setStake] = useState('0.1');
    const [side, setSide] = useState(0); // coin: 0 heads 1 tails · high-low: 0 under 1 over
    const [chancePct, setChancePct] = useState(50);
    const [target, setTarget] = useState('2');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [res, setRes] = useState<BetResult | null>(null);
    const [resGame, setResGame] = useState<{ game: number; choice: number } | null>(null);
    const [verify, setVerify] = useState<string | null>(null);

    // parameters exactly as the program expects them
    const targetBps = Math.round((Number(target) || 0) * 10_000);
    const param = game === GAME.HIGHLOW ? Math.round(chancePct * 100) : game === GAME.VOIDRUSH ? targetBps : 0;
    const paramOk = game === GAME.COINFLIP || (game === GAME.HIGHLOW ? param >= 100 && param <= 9500 : param >= 10_500 && param <= 1_000_000);
    const [chanceBps, payoutBps] = paramOk ? gameOdds(game, param) : [0, 0];
    const choice = game === GAME.VOIDRUSH ? 0 : side;

    const stakeNum = Number(stake);
    const stakeLamports = isFinite(stakeNum) && stakeNum > 0 ? Math.round(stakeNum * 1e9) : 0;
    // same integer math as games.rs: payout = stake * payout_bps / 10000
    const netWin = paramOk ? Number((BigInt(stakeLamports) * BigInt(payoutBps)) / 10_000n) - stakeLamports : 0;
    const balance = player ? Number(player.balance) : 0;
    const overCap = proto ? netWin > proto.maxNetWin : false;
    const tooSmall = !(stakeNum >= P.minStake);
    const noFunds = stakeLamports > balance;
    const canPlay = !!provider && paramOk && !tooSmall && !noFunds && !overCap && !busy && !!proto?.initialized;

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
                    <button key={g.id} onClick={() => { setGame(g.id); setRes(null); setErr(null); }}
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
                        <input className="input-forge mt-1" inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value)} />
                    </label>

                    <div className="bg-space-700/40 rounded-xl p-3">
                        <Row label="Win chance">{paramOk ? `${(chanceBps / 100).toFixed(2)}%` : '--'}</Row>
                        <Row label="Payout multiplier">{paramOk ? `${(payoutBps / 10_000).toFixed(4)}×` : '--'}</Row>
                        <Row label="Pays on win">{paramOk && stakeNum > 0 ? <Xnt lamports={stakeLamports + netWin} /> : '--'}</Row>
                        <Row label="Max net win allowed now">{proto ? <Xnt lamports={proto.maxNetWin} /> : '--'}</Row>
                        <Row label="Your game balance"><Xnt lamports={player ? balance : null} /></Row>
                    </div>
                    {overCap && <Notice kind="warn">This bet's net win could exceed {P.maxExposurePct}% of the free bankroll. Lower the stake or the multiplier.</Notice>}
                    {noFunds && provider && <Notice kind="info">Deposit XNT into your game wallet first.</Notice>}

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
                                    <p className="text-xs text-amber-300 mt-2">
                                        Not settled yet. Anyone can settle it (the public keeper is only a safety net), but a bet not settled within
                                        about 3 minutes counts as lost, even if its roll was a win.
                                    </p>
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
                            <p><strong className="text-white">How it is fair:</strong> your stake is locked first; the outcome comes from the hash of the <em>next</em> slot, which is not known to you or the protocol when you bet, mixed with your bet address and a random seed from your browser. Disclosure: the block producer of that slot could in theory influence its hash.</p>
                            <p><strong className="text-white">Settle in time:</strong> this page settles your bet immediately after the next slot. Settlement is permissionless, so the public keeper or anyone can also do it, but the keeper is only a safety net. A bet not settled within about 3 minutes (the slot hash leaves the on-chain window) counts as lost, even if its roll was a win, so nobody can skip a bad result.</p>
                            <p><strong className="text-white">Limits:</strong> the max net win per bet is {P.maxExposurePct}% of the free bankroll, and a bet is refused if all unsettled payouts together would exceed {P.maxTotalExposurePct}% of the bankroll. Circuit breaker: if the bankroll (net of LP deposits and withdrawals) has lost 10% since the start of the UTC day, new house bets are refused until the next UTC day.</p>
                            <p><strong className="text-white">Edge:</strong> {P.houseEdgePct}% built into the odds. From every stake: {P.edgeToPoolPct}% to the burners' reward pool, {P.edgeToArchitectPct}% to the architect, the remaining {P.edgeToBankrollPct}% edge stays in the bankroll.</p>
                            <p>Every {P.chipPerWageredXnt} XNT wagered earns 1 Burn Lottery chip.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
