/**
 * Facts FROM THE SWITCH EPOCH (rewards v3). Shown only when rules detection reads rewards = 3, that is once the newest
 * published epoch file is a version-3 file (src/v3/detect.ts); src/facts.ts keeps the live (v2) texts until then. The
 * static texts are regenerated from these at the switch (scripts/prerender.mjs --facts=v3, which refuses while
 * V3_BOUNDARY is null).
 *
 * Wording: docs/WORDING.md §3 "The binding quote" and "The oracle" (binding only for the part inside today's capacity,
 * "at most" until the epoch is built, not a price of XNT, depends on the oracle publishing) and docs/CLAIMS.md A7, A8,
 * A12 (revised 2026-10-24 against oracle/src/rewards.ts lockPiece and the final program source: every leaf is created,
 * dust included; a vesting burn locks the covered piece; the 48-hour hold and the oracle seat). These texts are shown
 * only under rules 3, which only the upgraded program can publish, so they may state the upgrade's rules as current.
 * Pure data: no React, no web3.
 */

/**
 * The boundary, announced at least one full epoch ahead (SCHEDULE.md, 2026-10-23 change note; WORDING §1): burns made
 * after the publish transaction of the last epoch built under the v2 rules are scored under v3 (the v3 window starts at
 * that epoch's on-chain published_at, oracle/src/rewards.ts). Never an epoch number:
 *  - `date`: the UTC date (YYYY-MM-DD) of that last v2 publication (the planned date while the transaction does not exist);
 *  - `lastV2PublishTx`: its X1 transaction signature once it exists, null until then;
 *  - `releaseUtc`: the planned UTC time ("YYYY-MM-DD HH:MM") of the site release that names that transaction (round-4
 *    default: Monday 2026-11-09 06:00, after the quiet period), disclosed by the Forge while it holds burns; null = not given.
 * While V3_BOUNDARY is null the site behaves exactly as today and the dated interim notice (src/content/interim.ts) is
 * the only boundary text. From 00:00 UTC of `date` the Forge holds the burn until a release sets the transaction (it
 * cannot see the last v2 publication before then); once the transaction is set, rules detection reads rewards 3 as soon
 * as epochs/index.json lists it (src/v3/detect.ts boundaryHold), and the Forge never offers the v2 estimate again
 * (fail-closed on any read failure). C-14 (round 4): burns made after that transaction are never paid under the v2
 * rules; if the final upgrade is late they wait for the first v3 epoch with their own time, and the texts say so.
 * Set it (date and releaseUtc, transaction null) in a release before the quiet period that starts the day before `date`.
 */
export const V3_BOUNDARY: { date: string; lastV2PublishTx: string | null; releaseUtc?: string | null } | null = null;

/** The boundary sentence (TheForge, rules banner): dated, names the transaction once it exists, no epoch number. */
export function boundaryText(b: { date: string; lastV2PublishTx: string | null; releaseUtc?: string | null }): { lead: string; rest: string } {
    const rules = 'are paid under the v3 rules: first come, first served inside each day’s capacity, with a quote shown before you sign that binds the part of the burn that fits that day’s capacity.';
    // C-14: never paid under the current rules; a late upgrade only delays them
    const late = 'If the final program upgrade comes later than planned, those burns keep their own time and wait for the first epoch built under the v3 rules: no epoch under the current rules pays them.';
    const hold = `From 00:00 UTC on ${b.date} this page holds new burns until a release of this site names that transaction${b.releaseUtc ? ` (planned for ${b.releaseUtc} UTC)` : ''}.`;
    return b.lastV2PublishTx
        ? { lead: 'Since the publish transaction', rest: `of ${b.date} (UTC), new burns ${rules} Burns made before that transaction keep the rules of the epoch they fall in. ${late}` }
        : { lead: '', rest: `The last epoch under the current reward rules is planned to be published on ${b.date} (UTC). Burns made after its publish transaction ${rules} ${late} ${hold} The transaction is named here once it exists.` };
}

export const githubDependence = 'If the GitHub account falls, the site, the oracle, the keeper and the epoch files stop; payouts pause; the pools stay locked in the program; once no epoch has survived its hold for 28 days, the largest voider can take the oracle seat from day 28 and anyone from day 29, with a bond.';

export const rewardsV3 = {
    capacity: 'Each week has a fixed cash capacity: 8% of the free reward pool right after the previous epoch was published, and never more than seven daily tranches of 2% of the XNT reserve of the XDEX pool read at the previous epoch’s build. It opens in seven daily tranches counted from that publication; capacity a day does not use rolls into the next day, and from day 7 the rest of the week is open.',
    order: 'Burns are paid first come, first served inside that capacity, at their own arrival (two burns in the same second are ordered by a hash of their transaction, never by chain): a later burn never lowers what an earlier one was promised, except that burns on the same chain in the same hour share that hour’s value. Burns of a chain the previous epoch skipped, made before the week began, claim after every burn of the week (and first in the week’s leftover); burns from wallets the published rules list as the operator’s claim after every other burn, leftover included. A quote is "at most" until the epoch is built: a later burn on the same chain in the same hour, an earlier burn the site had not seen yet, or the check of the XNT price pool’s USDC.X at the weekly build can lower it. The liquidity each chain is valued with is fixed at the previous epoch’s build, so it is known before you burn; in a chain’s first week with a reading it is set only at the build, and this site gives no quote for that chain that week. When a chain’s hourly liquidity readings were missing during a week (fewer than 4 on more than 2 of its last 7 days, or none at all), the build keeps that chain’s liquidity unchanged for the next week instead of moving it on its own single reading (an orphaned chain excepted: its liquidity keeps halving). Only days with at least 4 hourly readings set the next week’s liquidity, and the build’s own reading is used only when no reading was recorded at all. In the first week under these rules, each chain is valued with the median of its last 4 weekly readings under the previous rules, and two full days of hourly readings are enough to move its liquidity for the week after.',
    valuation: 'Each burn is valued at its chain’s XEN price (the lower of the 24-hour median and the last closed hourly close, capped at 1.25× the chain’s reference) with a liquidity curve that remembers recent burns on that chain (half-life 14 days), and converted to XNT at the higher of the XNT 24-hour median and last close, never below 0.6× the previous epoch’s XNT reference; when USDC.X reads more than 3% above $1, every XNT pool reading is raised by that premium, so a burner is never paid more XNT because of it. A chain skipped four epochs in a row for lack of an eligible market (a failed read does not count) is announced as orphaned one epoch ahead, and its burns are then valued at half its reference.',
    tiers: 'Launchpad claims 1.25× the counted value in XNT, paid at claim. Orbit and Moon Landing claim 2× and 3× of that and vest over 45 and 180 days. A vesting burn that fits today’s capacity whole locks its whole mission; one that fits in part locks the part that fits at its tier’s full multiplier, and the rest of its Launchpad layer can only come from the week’s leftover; if nothing fits, or what fits is under 0.02 XNT, it is treated as Launchpad.',
    leftover: 'At the week’s end, capacity nobody used pays the uncovered Launchpad layers in the same order. That part is not promised.',
    quote: 'The number shown before you sign for the part of your burn that fits today’s remaining capacity is the most the epoch pays for it, at your burn’s own prices, if the oracle publishes. It is not a price of XNT in dollars and says nothing about the value of XNT at claim time; the part that does not fit today’s capacity is paid only from the week’s leftover, first come first served, which is not promised and can be less than selling.',
    dust: 'No payout is dropped for being small: every burner’s leaf is created, dust included. Claims open 48 hours after the epoch is published; the public keeper or the oracle then usually claims each leaf for its burner and pays the fee and the receipt rent, and you can always claim your own.',
    tranches: 'Tranches open at fixed times counted from the previous publication; scripted burns can take a tranche first. Spreading burns over several days is the simple way to get a share of each.',
    noBoost: 'Artifacts do not change what the base pot pays for a burn: a holder and a non-holder are paid the same for the same burn.',
} as const;

export const noticesV3 = [
    { id: 'rules-v3', text: 'The weekly rewards follow the v3 rules since the switch epoch; earlier epochs keep the rules they were built with.' },
] as const;
