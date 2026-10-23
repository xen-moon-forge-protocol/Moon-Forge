/**
 * Moon Forge Games — every XNT game here is an on-chain instruction of the Moon Forge program.
 * No outcome is computed in this page: results come from settled transactions and can be re-verified.
 * Real-XNT panels and Be the House sit behind a one-time self-attested notice (PlayGate); the free practice does not.
 * The gate covers entry actions only: the wallet's own exits (withdraw, leave Be the House, settle, cancel, refunds)
 * are rendered outside it by ExitsPanel whenever the gate or a break hides the panels (R1).
 */
import { useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { Gamepad2 } from 'lucide-react';
import { useWallet } from '../context/WalletContext';
import { usePoll, useProtocol } from '../lib/hooks';
import { fetchPlayer, NEXT_UPGRADE_LIVE, P, WARS_REAL_PAUSED } from '../lib/protocol';
import { PROJECT_LINKS } from '../lib/constants';
import { Notice } from '../components/ui';
import GameWallet from '../components/games/GameWallet';
import HouseGames from '../components/games/HouseGames';
import JackpotPanel from '../components/games/JackpotPanel';
import DuelPanel from '../components/games/DuelPanel';
import LotteryPanel from '../components/games/LotteryPanel';
import BeTheHouse from '../components/games/BeTheHouse';
import MoonWarsBattle from '../components/MoonWarsBattle';
import MoonWarsReal from '../components/games/MoonWarsReal';
import PredictionExits from '../components/games/PredictionsPanel';
import PlayGate from '../components/games/PlayGate';
import ExitsPanel from '../components/games/ExitsPanel';
import type { GameCtx } from '../components/games/types';

// Predictions (XNT up/down rounds) are off this site since 2026-10-22: no tab, only the exits view below (T4-24).
const TABS = [
    { id: 'house', label: 'Coin Flip · High-Low · Void Rush', icon: '🎲' },
    { id: 'jackpot', label: 'Jackpot', icon: '🏆' },
    { id: 'duel', label: 'Artifact Duel', icon: '⚔️' },
    { id: 'lottery', label: 'Burn Lottery', icon: '🎟️' },
    { id: 'bank', label: 'Be the House', icon: '🏦' },
    { id: 'wars', label: 'Moon Wars', icon: '🃏' },
] as const;

export default function GamesPage() {
    const { x1Provider, x1Address, x1Connected, connectX1, isConnecting } = useWallet();
    const [tab, setTab] = useState<(typeof TABS)[number]['id']>('house');
    // Real-XNT Moon Wars stays paused (WARS_REAL_PAUSED) until the move-key fix ships and the keeper meets its SLA.
    const [warsMode, setWarsMode] = useState<'practice' | 'real'>(NEXT_UPGRADE_LIVE && !WARS_REAL_PAUSED ? 'real' : 'practice');
    const owner = x1Connected && x1Address ? new PublicKey(x1Address) : null;
    const player = usePoll(() => (owner ? fetchPlayer(owner) : Promise.resolve(null)), [x1Address, x1Connected], 15_000);
    const proto = useProtocol(15_000);

    const ctx: GameCtx = {
        provider: x1Connected ? x1Provider : null,
        owner,
        player: player.data ?? null,
        proto: proto.data,
        refresh: () => { player.reload(); proto.reload(); },
    };
    const practice = tab === 'wars' && warsMode === 'practice';
    const needsWallet = !practice;

    const panels = (
        <>
            {proto.data && !proto.data.initialized && needsWallet && (
                <Notice kind="warn" className="mb-6">The program config is not initialized on X1 yet: games are not playable until it is.</Notice>
            )}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className={needsWallet ? 'lg:col-span-2 space-y-6' : 'lg:col-span-3 space-y-6'}>
                    {tab === 'house' && <HouseGames ctx={ctx} />}
                    {tab === 'jackpot' && <JackpotPanel ctx={ctx} />}
                    {tab === 'duel' && <DuelPanel ctx={ctx} />}
                    {tab === 'lottery' && <LotteryPanel ctx={ctx} />}
                    {tab === 'bank' && <BeTheHouse ctx={ctx} />}
                    {tab === 'wars' && (
                        <>
                            <div className="flex gap-2">
                                {(['practice', 'real'] as const).map((m) => (
                                    <button key={m} onClick={() => setWarsMode(m)}
                                        className={`px-3 py-1.5 rounded-lg border text-sm ${warsMode === m ? 'border-forge-gold bg-forge-gold/10 text-white' : 'border-white/10 text-lunar-300'}`}>
                                        {m === 'practice' ? 'Free practice' : `Real XNT${NEXT_UPGRADE_LIVE ? (WARS_REAL_PAUSED ? ' (paused)' : '') : ' (next upgrade)'}`}
                                    </button>
                                ))}
                            </div>
                            {warsMode === 'practice' ? <MoonWarsBattle /> : <MoonWarsReal ctx={ctx} />}
                        </>
                    )}
                </div>
                {needsWallet && (
                    <div className="space-y-6">
                        <GameWallet ctx={ctx} />
                    </div>
                )}
            </div>
            {needsWallet && owner && (
                <div className="mt-6">
                    <PredictionExits ctx={ctx} />
                </div>
            )}
        </>
    );

    return (
        <div className="max-w-6xl mx-auto">
            <div className="text-center mb-8">
                <h1 className="font-space text-4xl font-bold mb-2"><Gamepad2 className="inline w-9 h-9 text-forge-orange mr-2" />Games</h1>
                <p className="text-lunar-400 max-w-3xl mx-auto">
                    Every XNT game is an instruction of the Moon Forge program on X1. House-game outcomes come from the hash of the slot after the bet
                    (not known to the player or the protocol when betting) and are verifiable by anyone; the producer of the drawing slot can influence the roll
                    (until the upgrade; see the known issues on each panel). Part of every stake feeds the burners' reward pool.
                </p>
            </div>

            <Notice kind="info" className="mb-6">
                <ul className="list-disc list-inside space-y-1">
                    <li>
                        House games: {P.houseEdgePct}% edge ({P.edgeToPoolPct}% → burners' pool, {P.edgeToArchitectPct}% → architect, {P.edgeToBankrollPct}% → bankroll).
                        A bet not settled within ~3 min counts as lost even if its roll was a win (this site settles immediately; the keeper is a safety net).
                        Circuit breaker: if the bankroll has lost {P.maxDailyLossPct}% since the start of the UTC day (net of LP deposits and withdrawals), new house bets are refused until the next day.
                    </li>
                    <li>
                        Jackpot, Artifact Duel and Moon Wars: {P.p2pRakePct}% rake only when someone wins ({P.rakeToPoolPct}% pool, {P.rakeToArchitectPct}% architect, {P.rakeToDrawPct}% lottery).
                        Duel: any live Artifact is your ticket; you pick any of the 4 elements, hidden by commit-reveal; same or opposite element is a draw with a full refund and no rake; the creator must reveal within 1 h or the opponent wins.
                    </li>
                    <li>
                        Burn Lottery tickets pay {P.p2pRakePct}% at purchase ({P.rakeToPoolPct}% pool, {P.rakeToArchitectPct}% architect, {P.rakeToDrawPct}% back to the lottery vault).
                        If nobody settles a round in time there is no winner: the would-be prize goes to the burners' reward pool (never rolled over, never re-drawn).
                    </li>
                    <li>
                        Jackpot, Burn Lottery, Duels and Moon Wars can only be entered by the wallet owner. Bots play house games only, through session keys that can never withdraw
                        (<a href={PROJECT_LINKS.botsMd} target="_blank" rel="noopener noreferrer" className="underline">docs/BOTS.md</a>). In player-vs-player games your opponent may be an automated agent: the project's kit is public.
                    </li>
                    <li>
                        Predictions (XNT up/down rounds) are no longer offered on this site since 2026-10-22. If you entered a round before that, the exits (lock, settle, claim, refund) are at the bottom of this page.
                        Real-XNT Moon Wars matches are paused on this site until the move-key fix ships; the free practice is open.
                    </li>
                    <li>The program is upgradeable during the test period, and the known unfixed issues are listed on every panel: play only with amounts you can afford to lose.</li>
                </ul>
            </Notice>

            <div className="flex flex-wrap gap-2 mb-6">
                {TABS.map((t) => (
                    <button key={t.id} onClick={() => setTab(t.id)}
                        className={`px-3 py-2 rounded-xl border text-sm ${tab === t.id ? 'border-forge-orange bg-forge-orange/10 text-white' : 'border-white/10 text-lunar-300 hover:border-white/20'}`}>
                        {t.icon} {t.label}
                    </button>
                ))}
            </div>

            {needsWallet && !x1Connected && (
                <div className="glass-card text-center mb-6">
                    <p className="text-lunar-300 mb-3">Connect your X1 wallet to play. You can browse the live state below without connecting.</p>
                    <button onClick={connectX1} disabled={isConnecting} className="btn-forge">{isConnecting ? 'Connecting…' : 'Connect X1 Wallet'}</button>
                </div>
            )}

            {/* R1: the gate covers entry actions only; the wallet's own exits stay reachable during a break or without the acknowledgement. */}
            {practice ? panels : <PlayGate exits={<ExitsPanel ctx={ctx} />}>{panels}</PlayGate>}
        </div>
    );
}
