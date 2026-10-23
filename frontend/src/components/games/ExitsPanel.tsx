/**
 * R1: "Your balances and exits". Everything here gets the wallet's own XNT out or closes what it already started,
 * so it is never hidden by the play notice (PlayGate) or by a break: withdraw the game balance, leave Be the House,
 * settle a placed house bet, cancel / reveal / resolve the wallet's own duels and Moon Wars matches, close a
 * Jackpot or Burn Lottery round it entered, take a Jackpot or Predictions refund. Nothing here places a bet,
 * enters a round, creates or joins a match, or deposits.
 */
import { LogOut } from 'lucide-react';
import GameWallet from './GameWallet';
import BeTheHouse from './BeTheHouse';
import DuelPanel from './DuelPanel';
import JackpotPanel from './JackpotPanel';
import LotteryPanel from './LotteryPanel';
import MoonWarsReal from './MoonWarsReal';
import PredictionExits from './PredictionsPanel';
import { PendingHouseBets } from './HouseGames';
import type { GameCtx } from './types';

export default function ExitsPanel({ ctx }: { ctx: GameCtx }) {
    return (
        <section className="mt-6 space-y-4" aria-labelledby="exits-title">
            <div className="glass-card">
                <div className="flex items-center gap-2 mb-2">
                    <LogOut className="w-5 h-5 text-forge-gold" />
                    <h2 id="exits-title" className="font-space text-lg">Your balances and exits</h2>
                </div>
                <p className="text-sm text-lunar-400">
                    Withdrawing your own balance, leaving Be the House, settling a bet you already placed, cancelling or finishing your own open duels and
                    matches, closing a round you entered and taking a refund never need the notice above and stay available during a break.
                    Nothing here places a new stake.
                </p>
                {!ctx.owner && <p className="text-sm text-lunar-500 mt-2">Connect your X1 wallet (button above) to see its balances and exits.</p>}
            </div>
            {ctx.owner && (
                <>
                    <GameWallet ctx={ctx} exitsOnly />
                    <PendingHouseBets ctx={ctx} />
                    <BeTheHouse ctx={ctx} exitsOnly />
                    <DuelPanel ctx={ctx} exitsOnly />
                    <MoonWarsReal ctx={ctx} exitsOnly />
                    <JackpotPanel ctx={ctx} exitsOnly />
                    <LotteryPanel ctx={ctx} exitsOnly />
                    <PredictionExits ctx={ctx} />
                </>
            )}
        </section>
    );
}
