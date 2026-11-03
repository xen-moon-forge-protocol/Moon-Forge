/**
 * Games after the final upgrade (rules 3 only; pages/GamesPage.tsx keeps the live panels otherwise):
 *  - house games (place_bet_v2) and the Jackpot: offered only while the chain shows a live keeper (src/v3/keeper.ts
 *    keeperLiveness, read by KeeperGate every 30 s); otherwise the page says which check failed and how anyone can become
 *    the keeper; bets and entries already made keep their exits;
 *  - Artifact Duel and Moon Wars: sealed real-XNT games that need no keeper (DuelV3, WarsV3), with the secrets kept in
 *    this browser and an explicit backup;
 *  - Burn Lottery: no new entries; only the exits of a round that was open at the upgrade; Predictions: still off the site.
 */
import { Notice } from '../../components/ui';
import JackpotPanel from '../../components/games/JackpotPanel';
import LotteryPanel from '../../components/games/LotteryPanel';
import BeTheHouse from '../../components/games/BeTheHouse';
import MoonWarsBattle from '../../components/MoonWarsBattle';
import { PendingHouseBets } from '../../components/games/HouseGames';
import type { GameCtx } from '../../components/games/types';
import { houseNoBetsNoticeShown, jackpotOffered, newHouseBetsOffered } from '../keeper';
import { gamesS7 } from '../facts-s7';
import { gateLiveness, KeeperStatusCard, useKeeperGate } from './KeeperGate';
import HouseV3, { MyKeeperBets } from './HouseV3';
import DuelV3 from './DuelV3';
import WarsV3 from './WarsV3';

export function GamesNoticeV3() {
    return (
        <Notice kind="info" className="mb-6">
            <ul className="list-disc list-inside space-y-1">
                <li>{gamesS7.house}</li>
                <li>{gamesS7.jackpot}</li>
                <li>{gamesS7.fees} {gamesS7.limits}</li>
                <li>{gamesS7.lottery}</li>
                <li>{gamesS7.duel} {gamesS7.wars}</li>
                <li>{gamesS7.predictions}</li>
                <li>Games of chance and player-versus-player stakes: you can lose the whole stake. Not for anyone under 18 and not where such games are prohibited.</li>
            </ul>
        </Notice>
    );
}

export function HouseTabV3({ ctx }: { ctx: GameCtx }) {
    const gate = useKeeperGate();
    const offered = newHouseBetsOffered(gateLiveness(gate));
    const seat = gate.data?.seat ?? null;
    return (
        <>
            <KeeperStatusCard gate={gate} what="house games" />
            {offered && seat ? <HouseV3 ctx={ctx} seat={seat} /> : <Notice kind="warn">{gamesS7.house}</Notice>}
            {ctx.owner && <MyKeeperBets ctx={ctx} seat={seat} />}
            {ctx.owner && <PendingHouseBets ctx={ctx} />}
        </>
    );
}

export function JackpotTabV3({ ctx }: { ctx: GameCtx }) {
    const gate = useKeeperGate();
    const offered = jackpotOffered(gateLiveness(gate));
    return (
        <>
            <KeeperStatusCard gate={gate} what="the Jackpot" />
            <Notice kind={offered ? 'info' : 'warn'}>{offered ? gamesS7.jackpot : gamesS7.jackpotOff}</Notice>
            {offered ? <JackpotPanel ctx={ctx} keeperDraws /> : <JackpotPanel ctx={ctx} exitsOnly keeperDraws />}
        </>
    );
}

export function LotteryTabV3({ ctx }: { ctx: GameCtx }) {
    return (
        <>
            <Notice kind="info">{gamesS7.lottery}</Notice>
            <LotteryPanel ctx={ctx} exitsOnly />
        </>
    );
}

export function DuelTabV3({ ctx }: { ctx: GameCtx }) {
    return (
        <>
            <Notice kind="info">{gamesS7.duel}</Notice>
            <DuelV3 ctx={ctx} />
        </>
    );
}

export function BankTabV3({ ctx }: { ctx: GameCtx }) {
    // the withdrawal window, the limits and the breaker of the upgraded program are in the panel's own notice (BeTheHouse, rules 3);
    // while no live keeper is shown no house bet reaches the bankroll, so a depositor is told before depositing
    const gate = useKeeperGate();
    return (
        <>
            {houseNoBetsNoticeShown(gateLiveness(gate)) && <Notice kind="warn">{gamesS7.houseNoBets}</Notice>}
            <BeTheHouse ctx={ctx} />
        </>
    );
}

/** Moon Wars under rules 3: the free practice (outside the play notice) or sealed real-XNT matches (inside it). */
export function WarsTabV3({ ctx, mode }: { ctx: GameCtx; mode: 'practice' | 'real' }) {
    return (
        <>
            <Notice kind="info">{gamesS7.wars}</Notice>
            {mode === 'practice' ? <MoonWarsBattle /> : <WarsV3 ctx={ctx} />}
        </>
    );
}

/** The wallet's own rules-3 exits (ExitsPanel): open house bets, sealed duels and matches, and the secrets backup. */
export function ExitsV3({ ctx }: { ctx: GameCtx }) {
    const gate = useKeeperGate();
    return (
        <>
            <MyKeeperBets ctx={ctx} seat={gate.data?.seat ?? null} />
            <DuelV3 ctx={ctx} exitsOnly />
            <WarsV3 ctx={ctx} exitsOnly />
        </>
    );
}
