/**
 * Rules-3 protocol constants: the UPGRADED program's compile-time values, mirrored from
 * programs/moon-forge/src/constants.rs (mainnet values, not the `localnet` ones). test/v3/constants.test.ts parses that
 * file and fails on any difference, so a change in the program build is caught here before it reaches a page.
 *
 * Nothing in this file may be shown before rules detection reads 3 (WP-frontend must-not: never show PX prices, the new
 * split, chips 0 or the market before the upgrade). lib/protocol.ts keeps the live (rules 2) values.
 */
export const XNT = 1_000_000_000n;
export const BPS = 10_000n;
const DAY = 86_400;

/** Forge price split (constants.rs FORGE_*_BPS): floor inside the NFT / base pot (reward_vault) / extra pot (extra_vault) / Burn Lottery / architect. */
export const FORGE_SPLIT_BPS = { backing: 5_000n, pool: 2_000n, extra: 2_500n, draw: 0n, architect: 500n } as const;
export const FORGE_SPLIT_PCT = { floorPct: 50, basePotPct: 20, extraPotPct: 25, lotteryPct: 0, architectPct: 5 } as const;

/** PX pricing (constants.rs ARTIFACT_PRICE … PRICE_LAUNCH_TS). Index = tier (Lunar Dust, Cosmic Shard, Solar Core, Void Anomaly). */
export const ARTIFACT_PRICE: readonly bigint[] = [10n * XNT, 25n * XNT, 60n * XNT, 200n * XNT];
export const ARTIFACT_SUPPLY: readonly number[] = [600, 300, 90, 10];
export const PRICE_UP_NUM: readonly bigint[] = [51n, 21n, 21n, 21n];
export const PRICE_UP_DEN: readonly bigint[] = [50n, 20n, 20n, 20n];
export const PRICE_DECAY_PERIOD: readonly number[] = [DAY, 3 * DAY, 7 * DAY, 14 * DAY];
export const MIN_PRICE_BPS: readonly bigint[] = [3_000n, 5_000n, 5_000n, 5_000n];
export const MAX_PRICE_MULTIPLE = 10n;
export const PRICE_MAX_STEPS = 180;
/** 2026-11-25 00:00 UTC: a never-forged tier decays from here. */
export const PRICE_LAUNCH_TS = 1_795_564_800;
export const ARTIFACT_WEEKLY_CHIPS: readonly number[] = [0, 0, 0, 0];

/** Claims: tip, tip minimum, the 48 h hold after a publication (base and extra). */
export const KEEPER_TIP = 2_000_000n;
export const KEEPER_TIP_MIN_CLAIM = 200_000_000n;
export const CLAIM_HOLD_SECONDS = 2 * DAY;

/** Extra pot (constants.rs EXTRA_*). */
export const EXTRA_RELEASE_BPS = 800n;
export const EXTRA_BACKING_BOUND_BPS = 400n;
export const EXTRA_MAX_LEAVES = 1_000;
/** The backing bound is per 7-day week of the extra epoch's window, at most this many weeks (extra.rs extra_bound). */
export const EXTRA_MAX_WEEKS = 13;
export const LEAF_DOMAIN_EXTRA = 'MOONFORGE_V3_EXTRA';

/** Native market (constants.rs MARKET_*): 5% royalty to the architect, 2% to the base pot, nothing to the extra pot. */
export const MARKET_ROYALTY_BPS = 500n;
export const MARKET_POOL_BPS = 200n;
export const MARKET_MIN_PRICE = 100_000_000n;
export const MARKET_MAX_LISTING_SECONDS = 90 * DAY;
export const SECONDARY_ROYALTY_BPS = 500n;

/** Games (constants.rs): keeper seat bond floor, Jackpot pot cap, edges and rakes, exposure and loss limits. */
export const KEEPER_BOND_MIN = 20n * XNT;
/** G-2 (round 4): settle_bet_v2 pays the registered keeper min(this, half the bet's 1% pool share, the free pool); never on a refund. */
export const KEEPER_SETTLE_TIP = 500_000n;
export const JACKPOT_MAX_POT = 20n * XNT;
export const HOUSE_EDGE_BPS = 200n;
export const EDGE_TO_POOL_BPS = 100n;
export const EDGE_TO_ARCHITECT_BPS = 50n;
export const P2P_RAKE_BPS = 200n;
export const RAKE_TO_POOL_BPS = 150n;
export const RAKE_TO_ARCHITECT_BPS = 50n;
export const MAX_EXPOSURE_BPS = 25n;
export const MAX_TOTAL_EXPOSURE_BPS = 500n;
export const MAX_DAILY_LOSS_BPS = 300n;
export const MAX_WEEKLY_LOSS_BPS = 1_500n;
export const HOUSE_WITHDRAW_DELAY_SECONDS = DAY;
export const HOUSE_WITHDRAW_WINDOW_SECONDS = DAY;

/**
 * Genesis claims stay open through 2027-03-31 and close at 2027-04-01 00:00 UTC in the upgraded binary (constants.rs
 * AIRDROP_DEADLINE: the live binary's 2027-01-01 00:00 UTC extended by 90 days; the live value is lib/protocol.ts).
 */
export const AIRDROP_DEADLINE = 1_806_537_600;

/** ORIGIN_* of ArtifactRecord.origin (state.rs). */
export const ORIGIN_FORGED = 0;
export const ORIGIN_GENESIS = 1;
export const ORIGIN_DROP = 2;

/** PDAs of the accounts the upgrade adds (constants.rs comments; recomputed in test/v3/constants.test.ts). */
export const V3_PDAS = {
    extraState: 'FF4CHxw1XgCMYv9Q48yB8qX4W19oDcGK2wrqZhEEvYrE',
    extraVault: 'GRGxMQDjNg4DwoL69y2p1x14fSzeaKeCHVLkAb67Z9d2',
    houseKeeper: 'Hb8Er2uoJKEWDgkJPncFQa5sVidqr34NEatqEDqnhj85',
    oracleSeat: 'EQ5BTUsYou2ndMw8SXdJVwNSz4nLABSuX6WxwT2doVGq',
} as const;
