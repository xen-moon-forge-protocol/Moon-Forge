/**
 * Dated interim notices (2026-10-22): what still applies under the live program and the current
 * oracle rules, what is scheduled to change, and when.
 *
 * Every flag defaults to the live (v2) behaviour. A flag flips only at the moment the change is
 * live on chain (the v3 batch flips `oracleRulesChanged` when the first epoch under the new rules
 * is published; the upgrade batch flips `programUpgraded` when rules detection reads 3), never at
 * merge. Nothing here describes the new rules themselves: the notices only say that the current
 * rule still applies, that it is scheduled to be replaced, and when that is announced.
 * scripts/prerender.mjs (RULES3_LEAK) fails the build when a page or a generated file states a rules-3
 * fact (chips 0, ticket removal, the end date of a current rule) before rules detection reads 3.
 */
export const INTERIM = {
    /** Date of the notice shown with every interim text. */
    noticeDate: '2026-10-22',
    /** Forging and the Genesis claim are paused on this site until the final program upgrade (T3-21). Recycling stays open. */
    forgePaused: true,
    genesisClaimPaused: true,
    /** false until the first epoch under the new oracle rules is published. */
    oracleRulesChanged: false,
    /** false until the final program upgrade is live. */
    programUpgraded: false,
    /** When the oracle rules change: a planned window, announced ahead, never a promise. */
    rulesChangeWhen: 'planned for November 2026 and announced on this page and on the project\u2019s X account at least one full epoch ahead, with the date and the last publish transaction under the current rules',
    /** When the final program upgrade happens. */
    upgradeWhen: 'not before mid-November 2026; its code hash and full changelog are published at least 7 days before it',
    /** When the upgrade key is burned (IMMUTABILITY.md: a separate, conditional step after the final upgrade). */
    freezeWhen: 'after the final upgrade, on the published freeze conditions (no later than 2026-12-31)',
} as const;

/**
 * Neutral dated forms (R2/R6c): one disclosure policy for every surface (React pages and src/facts.ts). They say
 * which current rule still applies and when its replacement is published, never what replaces it.
 */
export const NEUTRAL = {
    /** Oracle rules (Artifact boost, Forge Drops). */
    oracleRules: `Forge Drops and the Artifact boost are rules of the current oracle and apply to every epoch it builds. They are scheduled to be replaced at the oracle rules change (${INTERIM.rulesChangeWhen}); what replaces them is published with that announcement, not before.`,
    /** Program rules (chips, weekly Artifact chips, arena ticket). */
    programRules: `Chips, the weekly Artifact chips and the arena ticket are rules of the live program and keep working as described until the final upgrade (${INTERIM.upgradeWhen}); what changes is published with the upgrade changelog, not before.`,
    /** Genesis claim deadline while the claim is paused. */
    genesisDeadline: 'Claims close on 31 December 2026 (00:00 UTC on 1 January 2027) under the live program; the deadline may be extended by the final upgrade, and any new date is published with its changelog.',
} as const;

/** Prefix for every interim notice. */
export const DATED = `Notice dated ${INTERIM.noticeDate}`;
