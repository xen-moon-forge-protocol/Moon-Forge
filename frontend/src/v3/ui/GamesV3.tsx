/**
 * Games after the final upgrade (rules 3 only; pages/GamesPage.tsx keeps the live panels otherwise):
 *  - house games: new bets stay hidden on the site until a keeper that runs continuously meets its published service levels
 *    for a week (KEEPER_SLA_MET, F1-b: no keeper is armed at the upgrade); placed bets keep their exits;
 *  - Jackpot: hidden (exits only) until the same service-level week, and then offered only while the keeper seat holds a
 *    bond ≥ 20 XNT (src/v3/keeper.ts jackpotOffered); the keeper draws and settles;
 *  - Burn Lottery: no new entries; only the exits of a round that was open at the upgrade;
 *  - Duel: no new duels from this site yet (sealed joins); own duels keep their exits;
 *  - Moon Wars real matches: still paused (WarsTabV3: the free practice and the exits of the wallet's own matches only);
 *    Predictions: still off the site.
 */
import { Notice } from '../../components/ui';
import { usePoll } from '../../lib/hooks';
import { readConnection } from '../../lib/protocol';
import JackpotPanel from '../../components/games/JackpotPanel';
import LotteryPanel from '../../components/games/LotteryPanel';
import DuelPanel from '../../components/games/DuelPanel';
import BeTheHouse from '../../components/games/BeTheHouse';
import MoonWarsReal from '../../components/games/MoonWarsReal';
import MoonWarsBattle from '../../components/MoonWarsBattle';
import { PendingHouseBets } from '../../components/games/HouseGames';
import type { GameCtx } from '../../components/games/types';
import { fetchHouseKeeper, houseNoBetsNoticeShown, jackpotOffered, KEEPER_SLA_MET } from '../keeper';
import { gamesS7 } from '../facts-s7';

export function useHouseKeeper() {
    return usePoll(() => fetchHouseKeeper(readConnection), [], 60_000);
}

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
    return (
        <>
            <Notice kind="warn">{gamesS7.house}</Notice>
            {ctx.owner && <PendingHouseBets ctx={ctx} />}
        </>
    );
}

export function JackpotTabV3({ ctx }: { ctx: GameCtx }) {
    const k = useHouseKeeper();
    // F1-b: before the announced service-level week the Jackpot is hidden whatever the seat holds, so the exits never wait for the seat read
    if (KEEPER_SLA_MET) {
        if (k.loading && !k.data && !k.error) return <div className="glass-card text-sm text-lunar-400">Reading the keeper seat…</div>;
        if (k.error) return <Notice kind="warn">Could not read the keeper seat on X1 ({k.error}): the Jackpot is not offered until it can be checked.</Notice>;
    }
    const offered = jackpotOffered(k.data ?? null);
    return (
        <>
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
            <DuelPanel ctx={ctx} exitsOnly />
        </>
    );
}

export function BankTabV3({ ctx }: { ctx: GameCtx }) {
    // the withdrawal window, the limits and the breaker of the upgraded program are in the panel's own notice (BeTheHouse, rules 3);
    // r7 audit F8: until the service-level week no house bet is accepted, so a depositor is told before depositing
    return (
        <>
            {houseNoBetsNoticeShown() && <Notice kind="warn">{gamesS7.houseNoBets}</Notice>}
            <BeTheHouse ctx={ctx} />
        </>
    );
}

/** Moon Wars under rules 3: real matches stay paused on this site (gamesS7.wars); the free practice and the exits of the wallet's own matches. */
export function WarsTabV3({ ctx }: { ctx: GameCtx }) {
    return (
        <>
            <Notice kind="info">{gamesS7.wars}</Notice>
            <MoonWarsBattle />
            {ctx.owner && <MoonWarsReal ctx={ctx} exitsOnly />}
        </>
    );
}
