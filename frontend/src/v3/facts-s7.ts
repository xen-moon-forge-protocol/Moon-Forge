/**
 * Facts AFTER THE FINAL UPGRADE (rules 3). Shown only when rules detection reads 3 (src/v3/detect.ts); the live facts
 * (src/facts.ts, rules 2) are untouched until then. The static texts (prerender, llms.txt, llms-full.txt, JSON-LD) are
 * regenerated from these at the S7 event (scripts/prerender.mjs --facts=s7, which refuses while S7_PROGRAM_TAG is null).
 *
 * Every number mirrors src/v3/constants.ts (itself checked against programs/moon-forge/src/constants.rs by the tests).
 * Wording: docs/WORDING.md (no earn/yield/profit/guarantee/invest; the rebate is tied to the holder’s own burns, not promised,
 * can stop (WORDING "Artifacts and the rebate"); market fees never go to the extra pot). Pure data: no React, no web3.
 */
import { ARTIFACT_PRICE, FORGE_SPLIT_PCT, JACKPOT_MAX_POT, KEEPER_BOND_MIN, KEEPER_SETTLE_TIP, MARKET_MIN_PRICE, MIN_PRICE_BPS, XNT } from './constants';

/** Filled at S7 with the git tag of the deployed source (the upgrade transaction is cited in UPGRADE-2026-11.md). */
export const S7_PROGRAM_TAG: string | null = null;
/** Filled at S7: the date the upgrade transaction landed (YYYY-MM-DD, UTC). */
export const S7_VALID_FROM: string | null = null;

const xnt = (l: bigint, digits = 2) => (Number(l) / Number(XNT)).toLocaleString('en-US', { maximumFractionDigits: digits });
const minOf = (t: number) => xnt((ARTIFACT_PRICE[t] * MIN_PRICE_BPS[t]) / 10_000n);

export const forgeSplitS7 = { ...FORGE_SPLIT_PCT } as const;

export const artifactRulesS7 = {
    split: `Where the forge price goes: ${FORGE_SPLIT_PCT.floorPct}% stays inside the Artifact as its floor (you take it back by recycling), ${FORGE_SPLIT_PCT.basePotPct}% goes to the base pot (the reward pool burners are paid from), ${FORGE_SPLIT_PCT.extraPotPct}% to the extra pot and ${FORGE_SPLIT_PCT.architectPct}% to the architect. Nothing goes to the Burn Lottery.`,
    pricing: `Every tier is priced by the program from its own state (no oracle): a forge raises the tier’s price (+2% Lunar Dust, +5% the other tiers); each full period without a forge (1 day / 3 / 7 / 14 days by tier) lowers it by the same ratio, down to a fixed minimum (${minOf(0)} / ${minOf(1)} / ${minOf(2)} / ${minOf(3)} XNT) and never above 10× base. A full tier does not decay. You sign the price you see as your maximum: if it moved, the transaction fails instead of charging more.`,
    floors: 'Floors by origin: forged = half of the price paid (written on-chain as "Floor XNT"); Lunar Dust from a past Forge Drop = the drop value; Genesis airdrop = none. Recycling gives the floor back and frees the supply slot.',
    extraPot: 'Each week the extra pot can pay a forged Artifact’s holder a rebate tied to the holder’s own burns: only in a week in which the holder burned XEN that the base pot did not fully pay, counting only burns whose X1 destination is the wallet that holds the Artifact; counted use is at most 1% of the price paid per eligible Artifact per week, and the rebate at most 2 XNT per counted XNT, so at most 2% of the price paid per Artifact per week; only in the first 52 weeks after the Artifact was forged; while the pot lasts. A holder who does not burn receives nothing from it; it is not promised and it can stop. The base pot pays every burner by the same rule, Artifact or not.',
    noTicket: 'Artifacts give no burn boost, no lottery chips and no game ticket: games need no Artifact.',
    trading: 'Artifacts can be sold on the site’s native market, escrow-free: the Artifact stays in your wallet until a buyer pays. Each sale pays a 5% royalty to the architect and 2% to the base pot; nothing goes to the extra pot. The seller receives the other 93% and never less than the Artifact’s floor. Other Core marketplaces may also list them.',
    marketLimits: `Smallest list price ${xnt(MARKET_MIN_PRICE)} XNT; a listing expires after at most 90 days; a private sale can be reserved for one buyer.`,
    genesis: 'Genesis Lunar Dust is a collectible with no floor and a cosmetic badge: no rebate and no game ticket. Recycling it gives back only the record’s rent. The only official Genesis claim page is this site’s Artifacts page; any other "claim" link is not ours.',
    walletBurn: 'Burning an Artifact in a wallet app sends its floor to the reward pool: recycle it through Moon Forge instead.',
} as const;

/**
 * r9: house games and the Jackpot are offered only while the chain shows a live keeper (src/v3/keeper.ts keeperLiveness:
 * seat armed, bond of at least 20 XNT, not idle for 28 days, its service levels kept on the bets now pending). No constant or
 * later site release decides it: after the freeze nobody may change the site.
 */
const LIVE_GATE = `only while the chain shows a live keeper: armed, bonded with at least ${xnt(KEEPER_BOND_MIN)} XNT, not idle for 28 days and keeping its service levels on the bets pending now, with no bond withdrawal announced and no more than 32 draws waiting for a reveal (checked from X1 on every visit, never a setting)`;

export const gamesS7 = {
    intro: `Every XNT game is an instruction of the Moon Forge program on X1. Since the final upgrade house bets and the Jackpot are drawn from the house keeper’s hash chain (values the keeper committed to before the bet) mixed with a later block hash; the Artifact Duel and Moon Wars are sealed player-versus-player games that need no keeper. A house bet the keeper does not draw in time is paid to the player from the keeper’s bond (the stake back, or the payout if the keeper had anchored it); a Jackpot round it does not draw in time is refunded and the keeper’s bond can be penalized. Part of every stake feeds the burners’ reward pool. This site offers house games and the Jackpot ${LIVE_GATE}.`,
    house: `House games (Coin Flip, High-Low, Void Rush) are drawn on the house keeper’s hash chain since the final upgrade; a bet the keeper does not draw in time is paid for by the keeper’s bond: the player gets the payout from the bond if the bet was anchored and not revealed, or its whole stake back if it was never anchored, and the bond then loses the stake too. This site shows new house bets ${LIVE_GATE}; without a keeper seat the program takes no house bet. Bets placed before the upgrade settle under their own rules.`,
    jackpot: `The Jackpot is drawn on the house keeper’s hash chain, its pot is capped at ${xnt(JACKPOT_MAX_POT)} XNT, and a single-player round is refunded. This site offers it ${LIVE_GATE}.`,
    jackpotOff: 'The Jackpot is hidden on this site while the chain shows no live keeper (the reasons are listed above). Without a keeper seat, a Jackpot round that ends refunds every entry. Refunds and rounds already entered stay available below.',
    lottery: 'The Burn Lottery takes no new entries since the final upgrade. A round that was open at the upgrade still closes, draws and pays under its own rules: those steps stay here.',
    duel: 'Artifact Duels use sealed choices since the final upgrade: both players lock a hidden element, the joiner opens it within 10 minutes and the creator reveals within about an hour. No Artifact and no keeper are needed.',
    wars: 'Real-XNT Moon Wars matches start sealed since the final upgrade: each player locks half of the seed before seeing the other half, then both play under a chess clock. No Artifact and no keeper are needed; the free practice uses the same rules.',
    predictions: 'Predictions are in the program but not offered on this site or in the agent kit; only the exits (lock, settle, claim, refund) of rounds entered before remain. The program still accepts entries sent to it directly and takes the same 2% rake when someone wins (1.5% reward pool, 0.5% architect).',
    fees: `House edge 2% (1% reward pool, 0.5% architect, 0.5% bankroll; a little more at most Void Rush targets, whose win chance is rounded down to 0.01%). The registered house keeper receives a settle tip of at most ${xnt(KEEPER_SETTLE_TIP, 4)} XNT per settled bet, never more than half of that bet’s 1% pool share: a running cost of the pool, never paid on a refund. P2P rake 2% only when someone wins: 1.5% to the reward pool and 0.5% to the architect; nothing to the lottery.`,
    limits: 'A bet can win at most 0.25% of the free bankroll; all unsettled payouts stay under 5% of it; counting every unsettled bet as won, the bankroll may lose at most 3% per UTC day and 15% over 7 days.',
    houseWithdraw: 'Be the House withdrawals: request, wait 24 h, then withdraw within the next 24 h (an expired request is renewed).',
    /** Shown above Be the House whenever house games are not offered (src/v3/keeper.ts houseNoBetsNoticeShown). */
    houseNoBets: `No house bet is accepted while no house keeper is armed, and this site lists house games ${LIVE_GATE}; that may not happen. A deposit made now may see no new house bets; you can withdraw it at any time (request, wait 24 h, withdraw within the next 24 h).`,
} as const;

export const noticesS7 = [
    { id: 'upgrade-live', text: 'The final program upgrade is live. The texts on this page describe the upgraded program.' },
] as const;
