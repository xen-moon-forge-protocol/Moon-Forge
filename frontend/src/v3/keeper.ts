/**
 * House keeper seat (rules 3): the hash-chain keeper that draws house bets and the Jackpot after the upgrade.
 *
 * Gating rules for the site (WP-frontend S7, D-38/D-39, F1-b of the owner answers of 2026-10-25):
 *  - no house keeper is armed at the upgrade and no keeper bond is posted then: a bond posted while no keeper runs could
 *    be drained at no cost (house bets that nobody anchors are refunded in full and cost the bond the whole stake). With
 *    no keeper seat the program takes no house bet, and a Jackpot round that ends refunds every entry;
 *  - house games, the Jackpot and real-XNT Moon Wars stay hidden on the site until a keeper that runs continuously has met
 *    the published service levels for a week (anchor within 150 slots, reveal within 10 minutes). That is an announced
 *    decision, not something the chain can show, so it is a constant here (KEEPER_SLA_MET) that a later site release flips;
 *  - even then, the Jackpot is offered only while the seat exists, decodes, has a keeper key and holds a bond of at least
 *    KEEPER_BOND_MIN (20 XNT, which also covers the largest Jackpot pot, JACKPOT_MAX_POT);
 *  - the exits (settle, refund, withdraw) stay available whatever it says.
 * Nothing in the site places a new house bet (place_bet_v2) yet: the release that flips KEEPER_SLA_MET must also add that UI.
 */
import { Connection } from '@solana/web3.js';
import { decodeHouseKeeper, type HouseKeeperView } from './layout';
import { V3_PDA } from './extra';
import { KEEPER_BOND_MIN } from './constants';
import { PROGRAM_PK } from './detect';

/** Flipped only by a site release after a keeper that runs continuously met the §7.2 service levels for a week (announced). */
export const KEEPER_SLA_MET = false;

export async function fetchHouseKeeper(connection: Connection): Promise<HouseKeeperView | null> {
    const info = await connection.getAccountInfo(V3_PDA.houseKeeper());
    if (!info || !info.owner.equals(PROGRAM_PK)) return null;
    return decodeHouseKeeper(new Uint8Array(info.data));
}

/** Pure: does the seat hold what the Jackpot needs? A seat with a keeper key set and a bond ≥ 20 XNT. */
export function keeperSeatReady(k: HouseKeeperView | null): boolean {
    if (!k) return false;
    if (k.keeper.toBase58() === '11111111111111111111111111111111') return false;
    return k.bond >= KEEPER_BOND_MIN;
}

/**
 * Pure: may the Jackpot be offered? Only after the announced service-level week (KEEPER_SLA_MET; `slaMet` exists for the
 * tests) and while the seat is ready (keeperSeatReady). Before that the Jackpot tab shows the exits only.
 */
export function jackpotOffered(k: HouseKeeperView | null, slaMet: boolean = KEEPER_SLA_MET): boolean {
    return slaMet && keeperSeatReady(k);
}

/** Pure: may new house bets / real Moon Wars matches be offered? The same gate as the Jackpot: never before the announced service level. */
export const newHouseBetsOffered = (k: HouseKeeperView | null, slaMet: boolean = KEEPER_SLA_MET) => jackpotOffered(k, slaMet);

/** Pure (r7 audit F8): Be the House shows the "no house bet yet" notice (gamesS7.houseNoBets) until the announced service-level week. */
export const houseNoBetsNoticeShown = (slaMet: boolean = KEEPER_SLA_MET) => !slaMet;
