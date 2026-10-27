/**
 * Rewards v3: epoch construction and verification as a PURE function of the previous epoch file
 * plus this epoch's recorded inputs (design/SPEC-v3 with the spec-review amendments and A1–A5), so that
 * `verifyEpochV3(file, prev)` reproduces every allocation, leaf, root and data hash.
 *
 *  Valuation, per chain (I3):
 *    price_i  = min(median of the 24 closed hourly closes before the burn's hour, the last closed close,
 *               1.25 × ref_c)                                                     (A5)
 *    spot_i   = amount × price_i                                                  (µUSD)
 *    value_i  = spot_i × (f(S + V) − f(S)) / V  for the (chain, hour) group of the burn,
 *               f(x) = L·x/(L + x), S = the chain's curve state (half-life 14 days), V = Σ spot;
 *               computed as ⌊L²·spot_i / ((L + S)(L + S + V))⌋, one floor per burn
 *    L        = D-13 with the feed's option (a): the L of the window is FROZEN at epoch n−1's build (its `L.next`), so
 *               it is known from the window's first hour and the site's quote is exact. Each build computes the next
 *               window's L from this window's hourly readings: stat = the minimum over the last 7 days (counted back
 *               from the window end) of each day's median reading, a reading being min(GeckoTerminal, on-chain); then
 *               next = max(50% × L, min(stat, 1.1 × L + $50)) (the symmetric 50% clamp below, the +10% + $50 step
 *               above). A chain with no L yet takes min(stat, $500 + $50 per day of its price pool's age, at most 90
 *               days) (the first-reading clamp); the v2 → v3 switch freezes the v2 file's reading (liquidityNowMicro
 *               rules below: liquidityRuleV3)
 *  Entitlement, at the burn's own XNT price (A1): x_i = max(XNT median, XNT last close, 0.6 × previous x)
 *    (A3.2, A5), every XNT reading of the pool in USDC.X raised to the pool-safe price when USDC.X reads more than 3%
 *    above $1 (D-22 c, xntPegV3); base = value in lamports at x_i; lp = 1.25 × base (Launchpad); band = (multiplier − 1) × lp.
 *    The next epoch's x is the value-weighted median of the burns' 24-hour XNT medians.
 *  Allocation from the week's cash capacity C = ⌊8% × F_ref⌋, with F_ref the free pool right after epoch n−1 was
 *    published, fixed for the whole week (A2), and never more than 7 daily tranches of 2% of the XDEX pool's XNT
 *    reserve read at epoch n−1's build (D-22 a, the week start: known in advance too). The base pot is the two-pot base (A13.1, nft-extra REPORT A2): no
 *    Artifact term of any kind (no Forge Right earmark, lane or boost) and no drop reserve, so C is the whole 8%:
 *    1. every burn claims its whole entitlement first come first served (I2): daily tranches of C/7 counted
 *       from the window start (epoch n−1's publication, so the schedule is known in advance; unused capacity
 *       rolls forward, and after day 6 the whole C is open: the cumulative cap never falls, A12).
 *       A tier-0 burn claims its Launchpad layer; a vesting burn claims lp + band and locks, at its own arrival,
 *       exactly the piece of its mission whose whole entitlement the claim covers (A12, replacing A9's 50%
 *       threshold): the full lock when the claim is lp + band, a split (a locked piece at the full multiplier
 *       on its tier plus a Launchpad piece for the rest of the layer) for any smaller claim, and the Launchpad
 *       layer only (converted, on the tier-0 leaf, exactly as a tier-0 burn would) when the covered piece would
 *       be dust (below VEST_MIN_ENT, F6). No lamport is ever locked below its full multiplier (I10), no later
 *       burn ever moves what a burn is promised at its own arrival, and a burn always consumes what it is paid
 *       at arrival (I2, I7);
 *    2. the window's leftover pays the unmet Launchpad layers (pieces included) in the same order; no band is
 *       paid from it.
 *  Artifacts: the base pot never reads them (A13.1). The snapshot is recorded in the file for the extra pot only
 *    (extra.ts, A10 / A12.6): a holder and a non-holder get exactly the same base allocation for the same burn, and
 *    every leaf, root and capacity is the same whatever Artifacts exist, whoever holds them. The base RUN does not
 *    wait on them either (A13.9): when the records cannot be read or one is refused, the snapshot is recorded empty
 *    with `unavailable: {reason}` at the window-anchor slot, the base is built as usual, and that extra week is a skip.
 *  Encoding: leaf score = target lamports, rate_cap = 1. The upgraded program writes drop_reserve = 0 for every
 *    epoch (Forge Drops are off from the switch, A13.1), so with budget = totalScore every claim is exactly its
 *    target (I9). Σ score + keeper tips must fit in 10% of the free pool at build less the 0.5% rebuild drift and
 *    the D-47 oracle allowance (oracleAllowanceMax, paid from the same 10% bound at publication). If
 *    the plan does not (shortfall), the claims are cut literally from the latest one backwards (A13.2, OWNER-A12-1):
 *    the leftover top-ups first, then the arrival claims from the last burn back; the first claim that does not fit
 *    takes the room left (a mission locking the smaller piece it covers) and every later claim is 0. C and the daily
 *    tranches stay as quoted, so every burn's arrival outcome depends only on the burns before it (prefix-stable, in
 *    a shortfall too) and no later burn, of any tier, can lower what an earlier burn is paid at its arrival, with ONE
 *    exception (A13.12, the A2 batch, an owner decision): burns on the same chain in the same hour share that hour's
 *    curve pot, so a later burn in the same chain-hour lowers the value (and so the payout) of the earlier burns of that
 *    hour. Prefix-stability is therefore exact for a prefix that ends at a chain-hour boundary; the site's quote for a
 *    burn is an upper bound until its hour closes. The global order is (timestamp, keccak256(txHash ‖ logIndex)), each
 *    timestamp on its own chain's clock (D-14: of two burns stamped the same second, the one with the lower hash arrives
 *    first, whatever their chains; chainId, blockNumber, logIndex only break a tie of the hash itself).
 *  Rules block (T2-RULES): every v3 file records the one hashed `rulesBlock` it was built under (RulesBlockV3: program
 *    rules and hash, rulesId, tip and auto-claim minimums, dust rule, tie-break, backlog rule, operator wallets); the
 *    engine reads its dust rule, its operator wallets and checks the rest, and rules-v3.ts says which block is in force.
 *  Ranking (D-12, D-18): the arrival (senior) pass takes the window's burns in the global order, then the BACKLOG of a
 *    chain the previous file skipped (or did not list: burns stamped before the window start, `backlog: true`); the
 *    leftover pass then pays the backlog first, then the window's burns. Only after all of that do the OPERATOR burns
 *    (`operator: true`, a wallet of rulesBlock.operatorWallets outside a dated exception) claim, arrival then leftover,
 *    from what every other burn left. The backlog and operator burns claim on the window's end day (the day of endTs +
 *    CLOCK_SKEW_MAX). So no backlog or operator burn ever lowers what a burn of the window is paid at its arrival, and
 *    no operator burn lowers anything any other burn is paid. Valuation stays by time: a backlog or operator burn
 *    enters its chain's curve memory at its own hour.
 */
import { createHash } from "crypto";
import { keccak_256 } from "@noble/hashes/sha3";
import { PublicKey } from "@solana/web3.js";
import { TIER_MULTIPLIER } from "./config";
import { Burn } from "./evm";
import { buildTree, dataHash as dataHashV2, EpochFile, Leaf, verifyEpochFile } from "./epoch";

// ── policy constants (v3) ──────────────────────────────────────────────────────────────────────
export const BPS = 10_000n;
export const XNT = 1_000_000_000n;
export const K_BPS = 12_500n;
/**
 * C = ⌊F_ref × PLAN_BPS / BPS⌋: the week's cash capacity is the whole 8% of F_ref (A13.1: no Forge Right earmark and,
 * with drop_reserve = 0 on the upgraded program, no 9/10 cash factor). The 10% bound of the program stays the outer cap.
 */
export const PLAN_BPS = 800n;
export const HALF_LIFE_HOURS = 336;
export const PRICE_CAP_BPS = 12_500n;
export const L_GROWTH_BPS = 11_000n;
/** additive term of the liquidity growth clamp, so a chain recovers from a low (or zero) reading */
export const L_STEP_MICRO = 50_000_000n;
/** D-13: the symmetric clamp's lower side: the next window's L is never below this share of the L in force (50%) */
export const L_DROP_BPS = 5_000n;
/** D-13: the statistic looks back this many day buckets from the window end (the minimum of the daily medians) */
export const L_STAT_DAYS = 7;
/** D-13 first-reading clamp: a chain with no L yet takes at most $500 plus $50 per whole day of its price pool's age */
export const L_FIRST_BASE_MICRO = 500_000_000n;
export const L_FIRST_PER_DAY_MICRO = 50_000_000n;
/** … counted up to 90 days (so the first-reading cap is at most $5,000) */
export const L_FIRST_MAX_DAYS = 90;
/** D-22 (a): a daily tranche is never more than this share of the XDEX pool's XNT reserve at the week start (2%) */
export const XDEX_TRANCHE_BPS = 200n;
/** D-22 (c): USDC.X more than this far from $1 (3%) is a depeg; above $1, every pool reading takes the pool-safe price */
export const PEG_GUARD_BPS = 300n;
/**
 * D-22 (b): the XNT price pool. The deepest XNT/USD pool by its median TVL over the last XNT_POOL_TVL_EPOCHS readings (one a
 * build, about 30 days) takes over when it is more than XNT_POOL_SWITCH_X × the active pool's for XNT_POOL_SWITCH_WEEKS
 * builds in a row, announced one epoch ahead (`xntPool.next`). The program's Predictions keep their frozen pool.
 */
export const XNT_POOL_DEFAULT = "CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR";
export const XNT_POOL_TVL_EPOCHS = 4;
export const XNT_POOL_SWITCH_X = 2n;
export const XNT_POOL_SWITCH_WEEKS = 2;
/** D-21: a chain skipped this many epochs in a row for lack of an eligible market is orphaned (announced one epoch ahead) */
export const ORPHAN_SKIPS = 4;
/** D-21: an orphaned chain's burns are valued at this share (50%) of its reference price when it was orphaned */
export const ORPHAN_PRICE_BPS = 5_000n;
/** A3.2: an XNT price is never below 0.6 × the previous epoch's reference; there is no upper cap */
export const XNT_FLOOR_BPS = 6_000n;
export const EPOCH_DAYS = 7;
export const REBUILD_DRIFT_BPS = 50n;
/** Artifact tiers (Lunar Dust, Cosmic Shard, Solar Core, Void Anomaly): a snapshot record's tier is below this */
export const ARTIFACT_TIERS = 4;
/**
 * The first v3 epoch, pinned here when the oracle switches (null until then). Once pinned, a v3 history
 * can only start at that epoch, so a v2 interlude can never restart the curve memory, the cursors or the extra history.
 * Pin it only once the program that writes drop_reserve = 0 is live (A13.1).
 */
export const V3_FIRST_EPOCH: number | null = null;
export const DAY = 86_400;
export const HOUR = 3_600;
export const WEEK = EPOCH_DAYS * DAY;
/**
 * The oracle publishes a build at most this long after its snapshot (rebuildReason refuses to send an older one), and
 * verify --full reports a later publication. A late publication never blocks the next epoch (A12 / RE-1): the next
 * window simply starts at the on-chain published_at, however late it was.
 */
export const MAX_PUBLISH_LAG = 6 * HOUR;
/** programs/moon-forge/src/constants.rs: publications are at least this far apart */
export const MIN_EPOCH_INTERVAL = 6 * DAY;
/** a shorter window is never built: the oracle publishes within MAX_PUBLISH_LAG of the snapshot, and the program needs MIN_EPOCH_INTERVAL */
export const MIN_WINDOW = MIN_EPOCH_INTERVAL - MAX_PUBLISH_LAG;
/**
 * A8 (B-2): every window bound is an X1 instant. window.endTs is the X1 block time of snapshot.slot, window.startTs
 * is epoch n−1's on-chain published_at. Instants read on other clocks (createdAt on the runner's wall clock, a burn's
 * EVM block timestamp) may differ from X1's by up to this much, in either direction: finality lag, the build's own
 * duration and a wrong runner clock. Within it nothing about a leaf changes; beyond it the inputs are stale or wrong.
 */
export const CLOCK_SKEW_MAX = 1 * HOUR;

// ── program constants (programs/moon-forge/src/constants.rs), mirrored for encoding ────────────
export const EPOCH_BUDGET_BPS = 1_000n;
export const KEEPER_TIP = 2_000_000n;
/**
 * D-47 (forge.rs oracle_allowance): on the upgraded program publish_epoch pays the oracle key, from the free pool and
 * inside the same 10% bound as the budget (after it, never lowering it), the Epoch account's rent back plus a top-up
 * towards ORACLE_TOPUP_TARGET of at most ORACLE_TOPUP_MAX. It is a running cost of the pool (stats.keeper_tips),
 * never architect income. The build keeps the most it can be (oracleAllowanceMax) out of the burners' room
 * (buildLimit), so Σ score + keeper tips + the allowance always fit in 10% of the free pool.
 */
export const ORACLE_TOPUP_TARGET = 250_000_000n;
export const ORACLE_TOPUP_MAX = 50_000_000n;
/** the Epoch account: 8 + Epoch::INIT_SPACE bytes (forge.rs epoch_account_size_is_pinned) */
export const EPOCH_ACCOUNT_SIZE = 207;
/** its rent at X1's rate (6,960 lamports per byte, the 128-B account header included): 2,331,600 lamports */
export const EPOCH_RENT = BigInt((EPOCH_ACCOUNT_SIZE + 128) * 6_960);
/** the most publish_epoch pays the oracle per epoch: the Epoch rent back + the largest top-up (0.0523316 XNT) */
export const ORACLE_ALLOWANCE_MAX = EPOCH_RENT + ORACLE_TOPUP_MAX;
/** and never more than this share of the 10% bound (1% of the free pool; binds below a free pool of about 5.24 XNT) */
export const ORACLE_ALLOWANCE_BOUND_BPS = 1_000n;
/**
 * The keeper-tip rule of the UPGRADED program (forge.rs keeper_tip_due, SPEC-UPGRADE-v2 2.11): a claim pays KEEPER_TIP
 * from the free pool only when it is at least 100 × KEEPER_TIP = 0.2 XNT and its payer is neither the player nor the
 * oracle. A v3 file is published only on the upgraded binary (W2-4), so this is the rule every v3 file's claims meet:
 * the engine keeps one tip in reserve per leaf at or above it (plannedOutflow, the A13.2 gate) and the claim reports
 * count a tip only where the program pays one (keeperTipDue). Each tip comes from the free pool, never from a claim.
 * FINAL (round 4, 2026-10-25, owner default "0.2 XNT keeper-tip minimum in rewards.ts final"): it is the program's
 * constants.rs KEEPER_TIP_MIN_CLAIM (pinned there by a unit test at 200_000_000) and every v3 file records it as
 * rulesBlock.tipMin, which the engine refuses to be anything else.
 */
export const KEEPER_TIP_MIN_CLAIM = 100n * KEEPER_TIP;
/** The live (v2) binary's rule, kept for v2 files: a claim of at least 10 × KEEPER_TIP = 0.02 XNT whose payer is not the player (the oracle included). */
export const KEEPER_TIP_MIN_CLAIM_LIVE = 10n * KEEPER_TIP;
export const TIER_PENALTY_BPS: readonly bigint[] = [0n, 6_000n, 7_500n];
export const ORIGIN_FORGED = 0;
export const ORIGIN_GENESIS = 1;
export const ORIGIN_DROP = 2;
/**
 * a vesting burn entitled to less than this is paid as Launchpad: dust never opens a Mission account (I10, F6). A
 * policy of the engine (0.02 XNT, = 10 × KEEPER_TIP), no longer tied to the keeper-tip minimum, which the upgrade raised.
 */
export const VEST_MIN_ENT = 10n * KEEPER_TIP;

/**
 * Whether a claim pays the keeper tip, by the rule of the binary the file's version is published on: v3 files on the
 * upgraded program (≥ 0.2 XNT, payer neither the player nor the oracle), v2 files on the live one (≥ 0.02 XNT, payer
 * not the player). `oracle` null = a planned claim by a third-party keeper (never the oracle).
 */
export function keeperTipDue(o: { version: number; payer: string | null; player: string; oracle: string | null; claim: bigint }): boolean {
  if (o.payer !== null && o.payer === o.player) return false;
  if (o.version === 3) return (o.payer === null || o.oracle === null || o.payer !== o.oracle) && o.claim >= KEEPER_TIP_MIN_CLAIM;
  return o.claim >= KEEPER_TIP_MIN_CLAIM_LIVE;
}

/**
 * 2^(−1/336) in 1e18 fixed point, rounded down: the curve memory's decay per hour (half-life 336 h).
 * It is the exact floor: q^336 · 2 ≤ 10^(18·336) < (q + 1)^336 · 2. 40-digit reference:
 * 2^(−1/336) = 0.9979391883568344081002966948635637101097… (both checked in test/rewards.test.ts).
 */
export const DECAY_Q = 997_939_188_356_834_408n;
export const FP = 10n ** 18n;
const U64 = 2n ** 64n;
const U256 = 2n ** 256n;

// ── the rules block (T2-RULES, D-12, D-14, D-18, CF-26) ─────────────────────────────────────────
/** D-14: the same-second tie-break, keccak256 of the 32-byte tx hash followed by the log index as a 32-byte big-endian integer */
export const TIE_BREAK_V3 = "keccak256(txHash,logIndex)" as const;
/** D-12: a skipped chain's backlog ranks after every burn of the window in the arrival pass, and first in the leftover pass */
export const BACKLOG_RULE_V3 = "after-current-senior,first-leftover" as const;
/** D-18: operator wallets rank after every other burn of the week, in both passes */
export const OPERATOR_RULE_V3 = "rank-last" as const;
/** the version of the rules this engine writes by default (rules-v3.ts holds the versions in force, by epoch) */
export const RULES_ID_V3 = 1;
/** CF-26 / A11: the oracle (and the keeper) claim every leaf for its burner, dust included: no minimum */
export const AUTO_CLAIM_MIN_V3 = 0n;
/** an exception's name: one line, at most this many characters */
export const EXCEPTION_NAME_MAX = 80;

/**
 * PROOF_BURN_RULE option (c) (s7 MANIFEST R1, round-4 default): a dated, named exception to the operator rule,
 * published in POLICY-CHANGES.md on `published` (YYYY-MM-DD, UTC) before its first burn. A burn of one of `wallets`
 * stamped in [fromTs, untilTs) (its own chain's clock) competes for the week's capacity like any other burn and is
 * recorded with `exception: name`; outside that range the wallets are operator wallets (ranked last).
 */
export interface OperatorExceptionV3 {
  name: string;
  wallets: string[];
  fromTs: number;
  untilTs: number;
  published: string;
}

/** D-18: wallets controlled by the operator (roles only, never a funding link): ranked last, flagged `operator: true`. */
export interface OperatorWalletsV3 {
  rule: typeof OPERATOR_RULE_V3;
  /** canonical base58, strictly ascending */
  wallets: string[];
  /** strictly ascending by name */
  exceptions: OperatorExceptionV3[];
}

/**
 * The price, liquidity and gate parameters of the rules (D-13, D-22 a/c, D-17), hashed in every v3 file's rules block. The
 * engine implements exactly these values (rulesBlockOf pins them): a change is a new rulesId, announced (D-20).
 */
export interface PriceRulesV3 {
  /** D-13 + the feed's option (a) */
  liquidity: {
    reading: "min(geckoterminal,on-chain)";
    stat: "min-of-daily-medians";
    statDays: number;
    freeze: "previous-build";
    growthBps: number;
    stepMicro: string;
    dropBps: number;
    firstBaseMicro: string;
    firstPerDayMicro: string;
    firstMaxDays: number;
  };
  /** D-22 (a): the daily tranche at most maxReserveBps of the XDEX XNT reserve read at the week start */
  xntTranche: { maxReserveBps: number };
  /** D-22 (c): the USDC.X depeg guard (x1report's USD price against the XDEX TWAP in USDC.X) */
  xntPeg: { guardBps: number };
  /** D-21: the orphaned-chain end state */
  orphan: { skips: number; priceBps: number; notice: "one-epoch" };
  /** D-22 (b): the XNT price pool's switch rule */
  xntPool: { metric: "median-tvl"; epochs: number; switchX: number; weeks: number; notice: "one-epoch" };
  /** D-17: the anomaly gate's published thresholds (anomalyGateV3) */
  gate: {
    walletShareBps: number;
    leafCountX: number;
    scoreX: number;
    fallbackShareBps: number;
    historyEpochs: number;
    holdSeconds: number;
    firstChain: boolean;
    xntSourceChange: boolean;
  };
}

/** The D-17 anomaly gate's published thresholds (the rules block's priceRules.gate). */
export const GATE_WALLET_SHARE_BPS = 6_000;
export const GATE_LEAF_COUNT_X = 5;
export const GATE_SCORE_X = 3;
export const GATE_FALLBACK_SHARE_BPS = 5_000;
export const GATE_HISTORY_EPOCHS = 4;
/** 24 h (one DAY: the localnet profile of tests/e2e-oracle, where DAY is 1 s, holds for 1 s) */
export const GATE_HOLD_SECONDS = DAY;

export const PRICE_RULES_V3: PriceRulesV3 = Object.freeze({
  liquidity: {
    reading: "min(geckoterminal,on-chain)" as const,
    stat: "min-of-daily-medians" as const,
    statDays: L_STAT_DAYS,
    freeze: "previous-build" as const,
    growthBps: Number(L_GROWTH_BPS),
    stepMicro: L_STEP_MICRO.toString(),
    dropBps: Number(L_DROP_BPS),
    firstBaseMicro: L_FIRST_BASE_MICRO.toString(),
    firstPerDayMicro: L_FIRST_PER_DAY_MICRO.toString(),
    firstMaxDays: L_FIRST_MAX_DAYS,
  },
  xntTranche: { maxReserveBps: Number(XDEX_TRANCHE_BPS) },
  xntPeg: { guardBps: Number(PEG_GUARD_BPS) },
  orphan: { skips: ORPHAN_SKIPS, priceBps: Number(ORPHAN_PRICE_BPS), notice: "one-epoch" as const },
  xntPool: { metric: "median-tvl" as const, epochs: XNT_POOL_TVL_EPOCHS, switchX: Number(XNT_POOL_SWITCH_X), weeks: XNT_POOL_SWITCH_WEEKS, notice: "one-epoch" as const },
  gate: {
    walletShareBps: GATE_WALLET_SHARE_BPS,
    leafCountX: GATE_LEAF_COUNT_X,
    scoreX: GATE_SCORE_X,
    fallbackShareBps: GATE_FALLBACK_SHARE_BPS,
    historyEpochs: GATE_HISTORY_EPOCHS,
    holdSeconds: GATE_HOLD_SECONDS,
    firstChain: true,
    xntSourceChange: true,
  },
}) as PriceRulesV3;

/**
 * T2-RULES (CF-13, X-259, CF-19): the single rules block every v3 file records (hashed with the file). A rules change is
 * a new rulesId (rules-v3.ts, announced at least two epochs ahead, D-20 / WORDING), never a silent edit.
 */
export interface RulesBlockV3 {
  /** the program binary the file is published on: 3 = the final upgrade (drop_reserve 0, the 48-h claim hold, 0.2 XNT tip minimum) */
  programRules: 3;
  /** sha256 (hex) of that binary's ELF as pinned after S2 (x1-v3.ts UPGRADED_ELF, R-7); null while nothing is pinned */
  programHash: string | null;
  /** the rules version: 1 for the rules of the first v3 epoch */
  rulesId: number;
  /** lamports: a claim pays the keeper tip only from this amount (the program's KEEPER_TIP_MIN_CLAIM, 0.2 XNT) */
  tipMin: string;
  /** lamports: the smallest leaf the oracle and the keeper claim for its burner ("0": every leaf, dust included, A11) */
  autoClaimMin: string;
  /** a vesting burn, or the piece its claim covers, entitled to less than vestMinEnt lamports is paid as Launchpad (F6) */
  dustRule: { vestMinEnt: string };
  tieBreak: typeof TIE_BREAK_V3;
  backlogRule: typeof BACKLOG_RULE_V3;
  operatorWallets: OperatorWalletsV3;
  /** D-13, D-22 (a, c), D-17: the price, liquidity and gate parameters (pinned to PRICE_RULES_V3) */
  priceRules: PriceRulesV3;
}

/** The rules block of this engine with nothing pinned and no operator wallet listed (rules-v3.ts fills the values in force). */
export const DEFAULT_RULES_V3: RulesBlockV3 = Object.freeze({
  programRules: 3 as const,
  programHash: null,
  rulesId: RULES_ID_V3,
  tipMin: KEEPER_TIP_MIN_CLAIM.toString(),
  autoClaimMin: AUTO_CLAIM_MIN_V3.toString(),
  dustRule: { vestMinEnt: VEST_MIN_ENT.toString() },
  tieBreak: TIE_BREAK_V3,
  backlogRule: BACKLOG_RULE_V3,
  operatorWallets: { rule: OPERATOR_RULE_V3, wallets: [], exceptions: [] },
  priceRules: PRICE_RULES_V3,
}) as RulesBlockV3;

const RULES_KEYS = ["autoClaimMin", "backlogRule", "dustRule", "operatorWallets", "priceRules", "programHash", "programRules", "rulesId", "tieBreak", "tipMin"];
/** canonical JSON (sorted keys) of a plain value, for the pinned members of the rules block */
const sortedJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));
const exactKeys = (v: unknown, keys: string[], what: string): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} is not an object`);
  const have = Object.keys(v).sort();
  const want = [...keys].sort();
  if (have.length !== want.length || have.some((k, i) => k !== want[i])) throw new Error(`${what} must have exactly the members ${want.join(", ")} (has ${have.join(", ")})`);
  return v as Record<string, unknown>;
};
const strictlyAscending = (xs: string[], what: string) => {
  for (let i = 1; i < xs.length; i++) if (!(xs[i - 1] < xs[i])) throw new Error(`${what} must be strictly ascending (no duplicate): ${xs[i - 1]} before ${xs[i]}`);
};

/**
 * The rules block `v` as the engine uses it, or a throw naming what is wrong (T2-RULES). The values this engine does not
 * implement in any other way are pinned: programRules 3, tipMin = KEEPER_TIP_MIN_CLAIM (the upgraded program's), autoClaimMin
 * "0", the D-14 tie-break, the D-12 backlog rule and the D-18 rank-last rule. Read from it: dustRule.vestMinEnt and the
 * operator wallets with their exceptions.
 */
export function rulesBlockOf(v: unknown): RulesBlockV3 {
  const o = exactKeys(v, RULES_KEYS, "rulesBlock");
  if (o.programRules !== 3) throw new Error(`rulesBlock.programRules ${JSON.stringify(o.programRules)}: a v3 file is published only on the upgraded program (3)`);
  if (o.programHash !== null && (typeof o.programHash !== "string" || !/^[0-9a-f]{64}$/.test(o.programHash))) throw new Error(`rulesBlock.programHash ${JSON.stringify(o.programHash)} is not null or a lowercase sha256 hex`);
  if (typeof o.rulesId !== "number" || !Number.isSafeInteger(o.rulesId) || o.rulesId < 1) throw new Error(`rulesBlock.rulesId ${JSON.stringify(o.rulesId)} is not a version number (1, 2, …)`);
  if (uint(o.tipMin, "rulesBlock.tipMin", U64) !== KEEPER_TIP_MIN_CLAIM) throw new Error(`rulesBlock.tipMin ${String(o.tipMin)} is not the upgraded program's keeper-tip minimum ${KEEPER_TIP_MIN_CLAIM}`);
  if (uint(o.autoClaimMin, "rulesBlock.autoClaimMin", U64) !== AUTO_CLAIM_MIN_V3) throw new Error(`rulesBlock.autoClaimMin ${String(o.autoClaimMin)}: the oracle claims every leaf (A11), so the only value is "0"`);
  const dust = exactKeys(o.dustRule, ["vestMinEnt"], "rulesBlock.dustRule");
  uint(dust.vestMinEnt, "rulesBlock.dustRule.vestMinEnt", U64);
  if (o.tieBreak !== TIE_BREAK_V3) throw new Error(`rulesBlock.tieBreak ${JSON.stringify(o.tieBreak)} is not ${TIE_BREAK_V3}`);
  if (o.backlogRule !== BACKLOG_RULE_V3) throw new Error(`rulesBlock.backlogRule ${JSON.stringify(o.backlogRule)} is not ${BACKLOG_RULE_V3}`);
  const ow = exactKeys(o.operatorWallets, ["exceptions", "rule", "wallets"], "rulesBlock.operatorWallets");
  if (ow.rule !== OPERATOR_RULE_V3) throw new Error(`rulesBlock.operatorWallets.rule ${JSON.stringify(ow.rule)} is not ${OPERATOR_RULE_V3}`);
  if (!Array.isArray(ow.wallets)) throw new Error("rulesBlock.operatorWallets.wallets is not an array");
  const wallets = ow.wallets.map((w, i) => pubkey(w, `rulesBlock.operatorWallets.wallets[${i}]`));
  strictlyAscending(wallets, "rulesBlock.operatorWallets.wallets");
  if (!Array.isArray(ow.exceptions)) throw new Error("rulesBlock.operatorWallets.exceptions is not an array");
  const exceptions = ow.exceptions.map((x, i): OperatorExceptionV3 => {
    const what = `rulesBlock.operatorWallets.exceptions[${i}]`;
    const e = exactKeys(x, ["fromTs", "name", "published", "untilTs", "wallets"], what);
    if (typeof e.name !== "string" || !e.name || e.name.length > EXCEPTION_NAME_MAX || e.name !== e.name.trim() || /[\u0000-\u001f\u007f]/.test(e.name)) {
      throw new Error(`${what}.name must be one trimmed line of 1 to ${EXCEPTION_NAME_MAX} characters`);
    }
    if (!Array.isArray(e.wallets) || !e.wallets.length) throw new Error(`${what}.wallets must list at least one wallet`);
    const ws = e.wallets.map((w, j) => pubkey(w, `${what}.wallets[${j}]`));
    strictlyAscending(ws, `${what}.wallets`);
    const fromTs = nat(e.fromTs, `${what}.fromTs`);
    const untilTs = nat(e.untilTs, `${what}.untilTs`);
    if (!(fromTs < untilTs)) throw new Error(`${what}: fromTs ${fromTs} must be before untilTs ${untilTs}`);
    const day = typeof e.published === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.published) ? Date.parse(`${e.published}T00:00:00.000Z`) : NaN;
    if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== e.published) throw new Error(`${what}.published ${JSON.stringify(e.published)} is not a YYYY-MM-DD date`);
    // "published in POLICY-CHANGES.md before their first burn": the publication day starts at or before the range
    if (day / 1000 > fromTs) throw new Error(`${what}: published ${e.published}, after the exception starts (${fromTs}): an exception is published before its first burn`);
    return { name: e.name, wallets: ws, fromTs, untilTs, published: e.published as string };
  });
  // D-13, D-22, D-17: the engine implements exactly these parameters (a change is a new rulesId)
  if (sortedJson(o.priceRules) !== sortedJson(PRICE_RULES_V3)) throw new Error(`rulesBlock.priceRules ${sortedJson(o.priceRules)?.slice(0, 200)} is not this engine's ${sortedJson(PRICE_RULES_V3)}`);
  strictlyAscending(exceptions.map((e) => e.name), "rulesBlock.operatorWallets.exceptions (by name)");
  // one wallet, one exception at any instant: the burn's recorded exception name is never ambiguous
  const spans = new Map<string, { fromTs: number; untilTs: number; name: string }[]>();
  for (const e of exceptions) {
    for (const w of e.wallets) {
      const seen = spans.get(w) ?? [];
      const clash = seen.find((s) => e.fromTs < s.untilTs && s.fromTs < e.untilTs);
      if (clash) throw new Error(`rulesBlock.operatorWallets: wallet ${w} is in the overlapping exceptions "${clash.name}" and "${e.name}"`);
      seen.push({ fromTs: e.fromTs, untilTs: e.untilTs, name: e.name });
      spans.set(w, seen);
    }
  }
  return {
    programRules: 3, programHash: o.programHash as string | null, rulesId: o.rulesId, tipMin: o.tipMin as string, autoClaimMin: o.autoClaimMin as string,
    dustRule: { vestMinEnt: dust.vestMinEnt as string }, tieBreak: TIE_BREAK_V3, backlogRule: BACKLOG_RULE_V3,
    operatorWallets: { rule: OPERATOR_RULE_V3, wallets, exceptions },
    priceRules: JSON.parse(JSON.stringify(PRICE_RULES_V3)) as PriceRulesV3,
  };
}

/**
 * D-18 with PROOF_BURN_RULE (c): how a burn of `x1` stamped `ts` ranks. A wallet of an exception, inside its range,
 * is an ordinary burn recorded with the exception's name; any other listed wallet (operatorWallets.wallets, or an
 * exception's wallet outside its range) is an operator burn, ranked last.
 */
export function operatorOfV3(ow: OperatorWalletsV3, x1: string, ts: number): { operator: boolean; exception: string | null } {
  let listed = ow.wallets.includes(x1);
  for (const e of ow.exceptions) {
    if (!e.wallets.includes(x1)) continue;
    if (e.fromTs <= ts && ts < e.untilTs) return { operator: false, exception: e.name };
    listed = true;
  }
  return { operator: listed, exception: null };
}

const tieKeys = new Map<string, string>();
/**
 * D-14: the tie-break key of a burn, keccak256(txHash ‖ logIndex) as lowercase hex: the 32 bytes of the tx hash, then
 * the log index as a 32-byte big-endian unsigned integer (Solidity abi.encodePacked(bytes32, uint256); ethers
 * solidityPackedKeccak256(["bytes32","uint256"], [txHash, logIndex])). Compared as strings (= as unsigned integers).
 */
export function tieKeyV3(txHash: string, logIndex: number): string {
  const k = `${txHash}:${logIndex}`;
  const hit = tieKeys.get(k);
  if (hit !== undefined) return hit;
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error(`tie-break: txHash ${JSON.stringify(txHash)} is not 32 bytes of hex`);
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) throw new Error(`tie-break: logIndex ${JSON.stringify(logIndex)} is not a safe non-negative integer`);
  const bytes = Buffer.concat([Buffer.from(txHash.slice(2), "hex"), Buffer.from(BigInt(logIndex).toString(16).padStart(64, "0"), "hex")]);
  const out = Buffer.from(keccak_256(bytes)).toString("hex");
  if (tieKeys.size > 200_000) tieKeys.clear();
  tieKeys.set(k, out);
  return out;
}

// ── types ──────────────────────────────────────────────────────────────────────────────────────
export interface SnapshotRecord {
  asset: string;
  tier: number;
  owner: string;
  /** lamports held by the ArtifactRecord (the recycle floor) */
  backing: string;
  /** ORIGIN_FORGED | ORIGIN_GENESIS | ORIGIN_DROP */
  origin: number;
}

export interface ArtifactSnapshotV3 {
  /**
   * the finalized X1 slot the records were read at (A13.10: the context slot of the finalized record list); its block
   * time is window.endTs (A8)
   */
  slot: number;
  records: SnapshotRecord[];
  /**
   * A13.9 (review R2): present only when the Artifact records could not be read (three tries) or a record was refused:
   * `records` is then empty, `slot` is the window anchor alone, and the reason is hashed with the file. The base pot
   * never reads the records (A13.1), so the base is built as usual; the extra week on such a base is a skip heartbeat.
   */
  unavailable?: { reason: string };
}

/** A13.9: a recorded reason is one line of at most this many characters */
export const REASON_MAX = 500;
/** A13.9: a reason as recorded (whitespace runs collapsed to one space, trimmed, cut to REASON_MAX; "unknown" when empty). */
export function reasonLineOf(v: unknown, max = REASON_MAX): string {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
  return s || "unknown";
}

/** informational (L_now is already derived from the eligible pools); strings keep floats out of the hashed body */
export interface PoolInfo {
  address: string;
  reserveUsd: string;
  createdAt: string | null;
}

export interface MarketV3 {
  /** build-time spot (USD × 1e18): this chain's reference value for later epochs and the burns' fallback price */
  spotE18: string;
  /** aggregator token price, the reference while the chain has no history */
  refUsdE18: string;
  priceSource: string;
  pools: PoolInfo[];
}

export type BurnEvent = Omit<Burn, "priceE18" | "priceSource" | "clamped">;

/** "candles": both readings are closed hourly candles; "fallback": no candles, both readings are "0". */
export type PriceSource = "candles" | "fallback";

export interface BurnInputV3 extends BurnEvent {
  /** XEN (USD × 1e18) on the chain's pool: median of the 24 closed hourly closes before the burn's hour */
  medianE18: string;
  /** XEN: the last closed hourly close before the burn's hour */
  lastCloseE18: string;
  /** "fallback" prices the burn at the chain's build spot (§3.4) */
  priceSource: string;
  /** the same two readings on the XNT/USDC.X pool (A1, A5) */
  xntMedianE18: string;
  xntLastCloseE18: string;
  /** "fallback" prices the burn's XNT at the build price max(twap, api) */
  xntSource: string;
}

export interface ChainInputV3 {
  chainId: number;
  name: string;
  portal: string;
  fromBlockExclusive: number;
  toBlock: number;
  market: MarketV3;
  /** GeckoTerminal's XEN-side liquidity of the eligible pools at the build (µUSD) */
  liquidityNowMicro: string;
  /**
   * D-13: the same depth read on-chain at toBlock (Σ XEN.balanceOf(pool) of the eligible pools × the build spot, µUSD);
   * null or absent = not read (the GeckoTerminal reading is then used alone)
   */
  liquidityOnChainMicro?: string | null;
  /** D-13: the window's hourly readings (the week-so-far feed's), strictly ascending hours; absent = none */
  liquiditySamples?: LiquiditySampleV3[];
  /** D-13: the creation time (unix s) of the chain's price pool, for the first-reading cap; null or absent = unknown (age 0) */
  poolCreatedAt?: number | null;
  /**
   * D-21: the chain is orphaned (the previous record announced it) and still has no eligible market: its burns are valued
   * at ORPHAN_PRICE_BPS of the reference recorded at its orphaning (priceSource "orphan", readings "0"), its market is
   * recorded as none (spot and reference "0", no pool) and its liquidity reading is 0 (the frozen L then halves each week)
   */
  orphan?: true;
  /**
   * XEN totalSupply at toBlock (informative only). T1-34: null when the read failed, with the reason in
   * totalSupplyError; a failed read is never recorded as "0"
   */
  totalSupply: string | null;
  totalSupplyError?: string;
  /**
   * X-010 / X-022: portal.totalMissions() and portal.totalBurned() at toBlock, read with the logs and reconciled through
   * a second provider where one serves that state. When recorded, the burns' mission ids run contiguously up to
   * missionsAt (from the previous record's missionsAt + 1 when it has one) and burnedAt = the previous burnedAt + Σ
   * amountWei (≥ Σ amountWei without one). Null (or absent) = not read: the week-so-far feed; every build records both.
   */
  missionsAt?: string | null;
  burnedAt?: string | null;
  burns: BurnInputV3[];
}

/** D-13: one hourly liquidity reading (min(GeckoTerminal, on-chain), µUSD) of unix hour `hour` */
export interface LiquiditySampleV3 {
  hour: number;
  micro: string;
}

/**
 * D-13: how the window's L was set. frozen: epoch n−1's L.next (option a); switch: the v2 file's reading at the v2 → v3
 * switch; legacy: a previous v3 record written before D-13 (no `next`): min(stat, 1.1 × L + $50); first: a chain with no
 * L in the previous file: min(stat, first-reading cap); genesis: no previous file at all (a fresh deployment only): stat;
 * carried: a skipped chain (nothing valued, the frozen value kept).
 */
export type LiquidityRuleV3 = "frozen" | "switch" | "legacy" | "first" | "genesis" | "carried";

/** D-22 (a) / D-23: the XDEX WXNT/USDC.X pool read at the build (Raydium-CPMM vaults less the fees owed) */
export interface XdexReadingV3 {
  pool: string;
  /** X1 slot of the read */
  slot: number;
  wxntReserveLamports: string;
  usdcReserveMicro: string;
  feeBps: number;
}

/** a v2 chain's xenUsdE18 in the last (up to) 4 v2 files, most recent first: the switch epoch's reference */
export interface SwitchRefV3 {
  chainId: number;
  readings: string[];
}

export interface EpochInputsV3 {
  programId: string;
  epoch: number;
  /** build time (ISO) on the runner's wall clock: provenance only, within CLOCK_SKEW_MAX of window.endTs (A8) */
  createdAt: string;
  /**
   * both on X1's clock (A8): startTs = on-chain published_at of epoch n−1 (endTs − 7 days without a previous file);
   * endTs = the block time of snapshot.slot (snapshotWindowEnd), never the runner's clock
   */
  window: { startTs: number; endTs: number };
  /** chains with a market this epoch; a chain of the previous file missing here is carried (skipped) */
  chains: ChainInputV3[];
  snapshot: ArtifactSnapshotV3;
  /**
   * lamports = free pool at build; open = F_ref, the free pool right after epoch n−1 was published
   * (EpochPublished.free_pool_before − budget), required with a previous file and null without one
   */
  freePool: { lamports: string; slot: number; open: string | null };
  xnt: { twapE18: string; apiE18: string; source: string };
  /** at the v2 → v3 switch only (null otherwise): every chain of the v2 file */
  switchRefs?: SwitchRefV3[] | null;
  /** T2-RULES: the rules block the epoch is built under (rules-v3.ts rulesForEpochV3); absent = DEFAULT_RULES_V3 */
  rulesBlock?: RulesBlockV3;
  /** D-22 (a): the XDEX pool read at this build (the next window's tranche cap); null or absent = not read */
  xdex?: XdexReadingV3 | null;
  /** D-23 (phase 1): the price sidecar this build wrote next to the file (its name and sha256); null or absent = none */
  sidecar?: PriceSidecarRefV3 | null;
  /** D-21: the chains skipped this epoch for lack of an eligible market (their run of skips grows); absent = none */
  noMarket?: number[];
  /** D-22 (b): the TVL (µUSD, 2 × the USDC.X side) of every candidate XNT/USD pool at this build; absent = not read */
  xntPools?: { pool: string; tvlMicro: string }[];
}

/**
 * D-22 (b): the XNT price pool of a file. active = the pool its XNT candles are read from; pools = each candidate's TVL
 * readings, most recent first (at most XNT_POOL_TVL_EPOCHS); deeper = the candidate whose median TVL is more than 2× the
 * active's this build (null: none); weeks = the builds in a row it has been; next = the pool the next epoch reads (the
 * notice), null = no switch.
 */
export interface XntPoolV3 {
  active: string;
  pools: { pool: string; tvl: string[] }[];
  deeper: string | null;
  weeks: number;
  next: string | null;
}

/** D-23 (phase 1): the hashed reference of a file's price sidecar (epoch-<n>.prices.json: raw candles and route inputs). */
export interface PriceSidecarRefV3 {
  file: string;
  sha256: string;
}

export interface CurveV3 {
  S: string;
  hour: number;
}

export interface ChainRecordV3 {
  chainId: number;
  name: string;
  portal: string;
  fromBlockExclusive: number;
  toBlock: number;
  skipped: boolean;
  market: MarketV3 | null;
  /** T1-34: null when the read failed (totalSupplyError says why); a skipped chain carries its last reading */
  totalSupply: string | null;
  totalSupplyError?: string;
  /** X-010: the portal counters at toBlock (a skipped chain carries them); null = not recorded */
  missionsAt: string | null;
  burnedAt: string | null;
  /**
   * now: GeckoTerminal's reading at the build; onChain: the on-chain one (null: not read); prev: epoch n−1's L; used: the L
   * of this window; rule: how it was set; stat: the D-13 statistic of this window's readings; next: the L frozen for the
   * next window; cap: the first-reading cap (rule "first" only, else null)
   */
  L: { now: string | null; onChain: string | null; prev: string | null; used: string | null; rule: LiquidityRuleV3 | null; stat: string | null; next: string | null; cap: string | null };
  /** D-13: the window's hourly readings as recorded ([] for none, and for a skipped chain) */
  liquiditySamples: LiquiditySampleV3[];
  /** D-13: the price pool's creation time used for the first-reading cap (null: unknown) */
  poolCreatedAt: number | null;
  /**
   * D-21: the run of epochs in a row this chain was skipped for lack of an eligible market, with the reference it had when
   * the run began (the median of its reference inputs then); null once it is valued on a market again (or never skipped so)
   */
  noMarketRun: { skips: number; refE18: string } | null;
  /**
   * D-21: set by the record whose skip run reaches ORPHAN_SKIPS (refE18 = the median of its reference inputs then, from = the
   * next epoch: the notice); carried while the chain has no market, cleared when it is valued on a market again
   */
  orphan: { refE18: string; from: number } | null;
  /** reference values of up to the last 4 epochs (most recent first); "0" = no reading */
  refInputs: string[];
  ref: string;
  priceCapE18: string;
  /** this epoch's reference value for the next epochs: min(build spot, price cap) */
  xenUsdE18: string;
  curveBefore: CurveV3;
  curveAfter: CurveV3;
}

/** which reading set the price: XEN = min(median, last, cap) or the build spot; XNT = max(median, last, floor) or the build price */
export type XenRule = "median" | "last" | "cap" | "spot" | "orphan";
export type XntRule = "median" | "last" | "floor" | "build";

export interface BurnV3 extends BurnInputV3 {
  priceE18: string;
  priceRule: XenRule;
  xntE18: string;
  xntRule: XntRule;
  hour: number;
  /** the tranche day its arrival claim was made on: dayOf(timestamp), or the window's end day for a backlog or operator burn */
  day: number;
  /** D-12: a burn of a chain the previous file skipped (or did not list), stamped before the window start */
  backlog: boolean;
  /** D-18: a burn of an operator wallet (rulesBlock.operatorWallets) outside any exception: ranked last */
  operator: boolean;
  /** PROOF_BURN_RULE (c): the name of the dated exception this burn was made under (an ordinary burn), else null */
  exception: string | null;
  spotMicro: string;
  valueMicro: string;
  base: string;
  lp: string;
  ent: string;
  band: string;
  senior: string;
  basePaid: string;
  bandPaid: string;
  /** basePaid + bandPaid: what this burn receives from the cash capacity (its whole base payout: nothing else is added, A13.1) */
  alloc: string;
  /**
   * A12: the part of the Launchpad layer locked on the burn's tier with its full band (lp for a full lock, 0 when
   * nothing locks); launchpadPaid = basePaid − lockedLp is what the tier-0 leaf carries; split = 0 < lockedLp < lp
   */
  lockedLp: string;
  launchpadPaid: string;
  split: boolean;
  converted: boolean;
  leafTier: number;
}

export interface TargetV3 {
  player: string;
  tier: number;
  target: string;
}

export interface CapacityV3 {
  /**
   * C = min(planCash, trancheCap), the week's cash capacity for burners (the quoted capacity, also in a shortfall; A13.1:
   * the whole 8% unless the XDEX cap binds)
   */
  cash: string;
  /** ⌊F_ref × 8%⌋ */
  planCash: string;
  /** D-22 (a): 7 × ⌊2% × the XDEX pool's XNT reserve at the week start⌋ (xdex.capReserve); null without a week-start reading */
  trancheCap: string | null;
  /** τ = ⌊C/7⌋, the daily release (a shortfall never cuts it, A13.2); the first (C mod 7) days release τ + 1 */
  tranche: string;
  /** Σ senior: every burn's FCFS claim met at its arrival (lp, or up to lp + band for a vesting burn) */
  senior: string;
  /** Σ basePaid: the Launchpad layers paid, the leftover pass included */
  base: string;
  /** Σ band of the vesting burns (the band demand) */
  bandTotal: string;
  /** Σ bandPaid of the locked pieces */
  bandPaid: string;
  /** what the week's schedule left unused after the leftover pass, or a shortfall cut (C − base − bandPaid): back in the pool */
  left: string;
  /** vesting burns with a piece locked on their own tier this epoch (the whole mission, or a split) */
  lockedMissions: number;
  /** of them, the missions locked in part only (0 < lockedLp < lp): the rest of the layer is a Launchpad piece (A12) */
  splitMissions: number;
  /** tier > 0 burns paid as Launchpad only this epoch (the claim did not exceed the Launchpad layer, or dust) */
  convertedMissions: number;
  /**
   * When the free pool at build could not carry the plan (A13.2, OWNER-A12-1): the claims are cut literally from the latest
   * one backwards, C and the schedule unchanged. `stage` is the pass of the first claim that did not fit, "arrival" or
   * "leftover", and burns[kept] (an index into burns, which are in the arrival order) takes `claim` of the `wanted` claim
   * (the room left with its spare keeper tips set aside). The claims are made in the order of the allocation plan
   * (D-12 / D-18, rankOrderV3): stage 1 = the window's burns then the backlog at the arrival, then the backlog then the
   * window's burns in the leftover; stage 2 = the operator burns, arrival then leftover. Every claim before the cut one in
   * that sequence is whole, every later one is 0. `planned` is what FCFS at C would have paid with nothing cut (Σ alloc
   * is what is paid). Null otherwise.
   */
  shortfall: { stage: "arrival" | "leftover"; kept: number; wanted: string; claim: string; planned: string } | null;
}

export interface EpochBodyV3 {
  version: 3;
  programId: string;
  epoch: number;
  createdAt: string;
  v3FirstEpoch: number;
  prevDataHash: string | null;
  kBps: number;
  /** T2-RULES: the rules block this file was built under (hashed with the file) */
  rulesBlock: RulesBlockV3;
  /** dayOrigin: day 0 of the daily tranches, always startTs (never the build time); days is informational */
  window: { startTs: number; endTs: number; days: number; dayOrigin: number };
  /** ref = F_ref (open, or the build reading for a first epoch): the capacity's base */
  freePool: { lamports: string; slot: number; open: string | null; ref: string };
  /**
   * usdE18 = value-weighted median of the burns' 24-hour XNT medians: the next epoch's reference for the floor; peg = the
   * D-22 (c) guard (xntPegV3)
   */
  xnt: { twapE18: string; apiE18: string; source: string; buildE18: string; prevE18: string | null; floorE18: string; usdE18: string; peg: XntPegV3 };
  /**
   * D-22 (a): atBuild = the XDEX pool read at this build (null: not read); capReserve = the WXNT reserve that caps THIS
   * window's tranches: epoch n−1's atBuild (or its own capReserve when it read none); null at the switch and without one
   */
  xdex: { atBuild: XdexReadingV3 | null; capReserve: string | null };
  /** D-23 (phase 1): the price sidecar (raw candle arrays and route inputs) as written next to the file; null = none */
  sidecar: PriceSidecarRefV3 | null;
  /** D-21: the chains skipped this epoch for lack of an eligible market (sorted) */
  noMarket: number[];
  /** D-22 (b): the pool record, and the candidates' TVL readings of this build it was made from (sorted by pool) */
  xntPool: XntPoolV3;
  xntPoolReadings: { pool: string; tvlMicro: string }[];
  switchRefs: SwitchRefV3[] | null;
  capacity: CapacityV3;
  chains: ChainRecordV3[];
  /**
   * The Artifact snapshot at the window end, recorded for the extra pot (S(n) of A12.6) and the public: the base
   * allocation never reads it (A13.1). There is no ledger, lane, boost or drop policy in a v3 base file.
   */
  snapshot: ArtifactSnapshotV3;
  burns: BurnV3[];
  targets: TargetV3[];
  leaves: Leaf[];
  totalScore: string;
  root: string;
  rateCap: string;
  /**
   * Round 4: present (true) only on a HEARTBEAT base epoch (ComputeOptsV3.heartbeat): a window that valued no burn,
   * published with no leaves, total 0, rate cap 0 and the all-zero root (budget 0 on chain), so a quiet week keeps the
   * oracle seat alive. Everything else in the file is what a paying build records; the next file continues from it.
   */
  heartbeat?: true;
  /**
   * A13.4: present only on the provisional file a dry run prints for a window shorter than MIN_WINDOW. Such a file is
   * never written to the epochs directory, never published (publishEpochV3 refuses it), never verified as an epoch and
   * never a previous file or an extra base (provisionalError).
   */
  provisional?: { reason: string; publishable: false };
}

export interface EpochFileV3 extends EpochBodyV3 {
  dataHash: string;
  proofs: Record<string, string[]>;
  /**
   * The publication record (A11), outside the data hash: {tx} alone when every post-publish read failed, otherwise the
   * publish slot, the Epoch account's net budget, the EpochPublished fields and the claims the oracle sends (with a
   * keeper tip, and dust without one).
   */
  publish?: {
    tx: string;
    slot?: number;
    budget?: string;
    fullBudget?: string;
    dropReserve?: string;
    dropSlot?: string;
    freePoolBefore?: string;
    publishedAt?: number;
    blockTime?: number | null;
    claims?: { tipped: number; dust: number };
    /** D-17: the anomaly gate held this epoch from heldAt (X1 time) and released it at releasedAt, with these reasons */
    gate?: { heldAt: number; releasedAt: number; reasons: string[] };
  };
}

export type AnyEpochFile = EpochFile | EpochFileV3;

// ── integer helpers ────────────────────────────────────────────────────────────────────────────
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const leafKey = (player: string, tier: number) => `${player}:${tier}`;

/** A recorded integer: a canonical decimal string (no sign, no leading zero, no spaces) below `bound`. */
export function uint(v: unknown, what: string, bound = U256): bigint {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]*)$/.test(v)) throw new Error(`${what}: ${JSON.stringify(v)} is not a canonical unsigned integer`);
  const x = BigInt(v);
  if (x >= bound) throw new Error(`${what}: ${v} out of range`);
  return x;
}

/** A recorded counter (chain id, block, log index, timestamp, slot, epoch): a safe non-negative integer number. */
export function nat(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new Error(`${what}: ${JSON.stringify(v)} is not a safe non-negative integer`);
  return v;
}

/**
 * A recorded instant: exactly the form Date.toISOString() writes (UTC, milliseconds, "Z"), so one instant has one
 * spelling and no machine reads it in its local time zone (R2-3). Returns the whole seconds.
 */
export function isoSeconds(v: unknown, what: string): number {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== v) throw new Error(`${what}: ${JSON.stringify(v)} is not a canonical ISO-8601 UTC time (toISOString)`);
  return Math.floor(ms / 1000);
}

/**
 * The window end of a build whose Artifact snapshot was read at `slot`: that slot's X1 block time (A8, B-2). A null
 * block time (getBlockTime of a skipped slot, or of a block the node does not have) never anchors a window and never
 * falls back to the runner's clock: the plumbing re-reads the snapshot at another finalized slot.
 */
export function snapshotWindowEnd(slot: number, blockTime: number | null | undefined): number {
  nat(slot, "snapshot.slot");
  if (blockTime === null || blockTime === undefined) {
    throw new Error(`no block time for snapshot slot ${slot}: the window end cannot be anchored (re-read the snapshot at another finalized slot)`);
  }
  return nat(blockTime, `block time of snapshot slot ${slot}`);
}

/** The path of an own "__proto__" member anywhere in v (JSON.parse creates them), or null (R2-4). */
export function protoPath(v: unknown, at = "$"): string | null {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const p = protoPath(v[i], `${at}[${i}]`);
      if (p) return p;
    }
  } else if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      if (k === "__proto__") return `${at}.__proto__`;
      const p = protoPath((v as Record<string, unknown>)[k], `${at}.${k}`);
      if (p) return p;
    }
  }
  return null;
}

/**
 * The 10% bound at the lowest free pool the publication step accepts without a rebuild (F_build − 0.5%), so a
 * drift the rebuild rule tolerates can never cap the on-chain budget below totalScore (F-DRIFT), less the most the
 * same bound pays the oracle at publication (D-47 oracleAllowanceMax: the Epoch rent + 0.05 XNT, at most a tenth of
 * the bound): the room for Σ score + keeper tips.
 */
export function buildLimit(freePool: bigint): bigint {
  const bound = (((freePool * (BPS - REBUILD_DRIFT_BPS)) / BPS) * EPOCH_BUDGET_BPS) / BPS;
  return bound - oracleAllowanceMax(bound);
}

/**
 * D-47, forge.rs oracle_allowance: the most publish_epoch can pay the oracle out of a 10% bound of `bound` lamports,
 * min(ORACLE_ALLOWANCE_MAX, a tenth of the bound). bound − oracleAllowanceMax(bound) never decreases as the bound
 * grows, so room kept at the lowest accepted pool is room at any pool the publication accepts.
 */
export function oracleAllowanceMax(bound: bigint): bigint {
  const share = (bound * ORACLE_ALLOWANCE_BOUND_BPS) / BPS;
  return share < ORACLE_ALLOWANCE_MAX ? share : ORACLE_ALLOWANCE_MAX;
}

const canonicalKeys = new Set<string>();
/** A recorded address: the canonical base58 form of a 32-byte public key, so one key has one spelling. */
export function pubkey(v: unknown, what: string): string {
  if (typeof v === "string" && canonicalKeys.has(v)) return v;
  let ok = false;
  try {
    ok = typeof v === "string" && new PublicKey(v).toBase58() === v;
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`${what}: ${JSON.stringify(v)} is not a canonical base58 public key`);
  canonicalKeys.add(v as string);
  return v as string;
}

/**
 * 2^(−h/336) in 1e18 fixed point, by square-and-multiply over the bits of h from the MOST significant one,
 * flooring after every product: p = 1e18; for each bit b of h: p = ⌊p·p/1e18⌋; if b = 1: p = ⌊p·DECAY_Q/1e18⌋.
 * The bit order changes the last digits, so an independent verifier must use exactly this order.
 */
export function decayFactor(hours: number): bigint {
  if (!Number.isSafeInteger(hours) || hours < 0) throw new Error(`bad decay interval ${hours}`);
  let p = FP;
  for (const bit of hours.toString(2)) {
    p = (p * p) / FP;
    if (bit === "1") p = (p * DECAY_Q) / FP;
  }
  return p;
}

export function decay(s: bigint, hours: number): bigint {
  return hours === 0 || s === 0n ? s : (s * decayFactor(hours)) / FP;
}

/** f(x) = L·x/(L + x): what a market of depth L pays for x of spot value (0 without a market). */
export function curve(L: bigint, x: bigint): bigint {
  return L === 0n || x === 0n ? 0n : (L * x) / (L + x);
}

/**
 * f(S + V) − f(S) = L²·V / ((L + S)(L + S + V)), floored once (F-I4R): never above V, and never larger when S is
 * larger. runCurve floors each burn's share L²·spot_i / ((L + S)(L + S + V)) the same way, so a smaller S or V
 * (a split loses δ of spot) can only raise another burn's value; a difference of two floors could lower it.
 */
export function curvePot(L: bigint, S: bigint, V: bigint): bigint {
  return L === 0n || V === 0n ? 0n : (L * L * V) / ((L + S) * (L + S + V));
}

/** µUSD → lamports at XNT price xE18 (USD × 1e18): µUSD × 1e-6 / (x / 1e18) × 1e9. */
export function lamportsOf(micro: bigint, xE18: bigint): bigint {
  return (micro * 10n ** 21n) / xE18;
}

/** Median of the positive values (an even count takes the floor of the mean of the middle two). */
export function medianE18(values: bigint[]): bigint {
  const v = values.filter((x) => x > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!v.length) return 0n;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2n;
}

/**
 * The next epoch's XNT reference (F-XREF): the lower value-weighted median of the burns' 24-hour XNT medians
 * (the build price for a burn without candles): the smallest reading at which the cumulative value reaches half
 * of the total. Value-0 burns weigh nothing, and the last close, which one pumped candle moves, is never used.
 * Null when no burn has value.
 */
export function xntReference(items: { weight: bigint; xE18: bigint }[]): bigint | null {
  const v = items.filter((i) => i.weight > 0n).sort((a, b) => (a.xE18 < b.xE18 ? -1 : a.xE18 > b.xE18 ? 1 : 0));
  const total = v.reduce((s, i) => s + i.weight, 0n);
  let cum = 0n;
  for (const i of v) {
    cum += i.weight;
    if (2n * cum >= total) return i.xE18;
  }
  return null;
}

export function clampL(now: bigint, prev: bigint | null): bigint {
  return prev === null ? now : min(now, (prev * L_GROWTH_BPS) / BPS + L_STEP_MICRO);
}

/** D-13: a reading is the lower of GeckoTerminal's and the on-chain depth (null on-chain: GeckoTerminal alone). */
export function liquidityReadingV3(gecko: bigint, onChain: bigint | null): bigint {
  return onChain === null ? gecko : min(gecko, onChain);
}

/** The median of a non-empty list, zeros included (an even count takes the floor of the mean of the middle two). */
function medianWithZeros(xs: bigint[]): bigint {
  const v = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2n;
}

/**
 * D-13: the samples of a window as the engine uses them (checked): strictly ascending unix hours, each at or before the
 * window end (liquidityStatV3 counts only the last L_STAT_DAYS days), plus the build's own reading as the sample of the
 * end's hour when none is recorded for it. Throws on a sample after the end or out of order.
 */
export function liquiditySamplesV3(recorded: unknown, endTs: number, buildReading: bigint, what: string): { hour: number; micro: bigint }[] {
  const list = recorded === undefined || recorded === null ? [] : recorded;
  if (!Array.isArray(list)) throw new Error(`${what} liquiditySamples is not an array`);
  const out: { hour: number; micro: bigint }[] = [];
  for (const [i, s] of list.entries()) {
    const o = exactKeys(s, ["hour", "micro"], `${what} liquiditySamples[${i}]`);
    const hour = nat(o.hour, `${what} liquiditySamples[${i}].hour`);
    const micro = uint(o.micro, `${what} liquiditySamples[${i}].micro`);
    if (out.length && hour <= out[out.length - 1].hour) throw new Error(`${what} liquiditySamples: hour ${hour} after ${out[out.length - 1].hour} (strictly ascending)`);
    if (hour * HOUR > endTs) throw new Error(`${what} liquiditySamples: hour ${hour} is after the window end ${endTs}`);
    // a sample more than L_STAT_DAYS days before the end (a window longer than a week) is recorded and not counted
    out.push({ hour, micro });
  }
  const endHour = Math.floor(endTs / HOUR);
  if (!out.some((s) => s.hour === endHour)) out.push({ hour: endHour, micro: buildReading });
  return out;
}

/**
 * D-13: the minimum over the last L_STAT_DAYS days (day d = ⌊(endTs − hour start) / DAY⌋, 0 = the last 24 h) of each
 * day's median reading, zeros included: raising it takes a deeper pool for more than half of EVERY day of the week; one
 * build-time reading (a JIT deposit, or a pull for some minutes) moves one sample of one day. Days without a sample do
 * not count; at least the build's own reading is always there.
 */
export function liquidityStatV3(samples: { hour: number; micro: bigint }[], endTs: number): bigint {
  const days = new Map<number, bigint[]>();
  for (const s of samples) {
    const d = Math.floor((endTs - s.hour * HOUR) / DAY);
    if (d < 0 || d >= L_STAT_DAYS) continue;
    days.set(d, [...(days.get(d) ?? []), s.micro]);
  }
  let out: bigint | null = null;
  for (const v of days.values()) {
    const m = medianWithZeros(v);
    if (out === null || m < out) out = m;
  }
  if (out === null) throw new Error("the liquidity statistic has no sample");
  return out;
}

/** D-13 first-reading cap: $500 + $50 per whole day of the price pool's age at the window start (at most 90 days; unknown = 0). */
export function firstLiquidityCapV3(poolCreatedAt: number | null, startTs: number): bigint {
  const age = poolCreatedAt === null || poolCreatedAt > startTs ? 0 : Math.floor((startTs - poolCreatedAt) / DAY);
  return L_FIRST_BASE_MICRO + L_FIRST_PER_DAY_MICRO * BigInt(Math.min(age, L_FIRST_MAX_DAYS));
}

/** D-13: the L frozen for the next window: the statistic within [50% × L, 1.1 × L + $50] of the L in force. */
export function nextLiquidityV3(stat: bigint, used: bigint): bigint {
  return max((used * L_DROP_BPS) / BPS, min(stat, (used * L_GROWTH_BPS) / BPS + L_STEP_MICRO));
}

/**
 * D-13 with option (a): the L that values window n, and why. `prev` = the chain's record in epoch n−1's file: its
 * frozen `next` (a v3 record written by this engine), the v2 reading (the switch), or the L of a v3 record written before
 * D-13 (no `next` member: the old build-time rule, min(stat, 1.1 × L + $50)); a chain with no L there takes the
 * first-reading cap, and only a build with no previous file at all (a fresh deployment) takes the statistic as it is.
 */
export function liquidityRuleV3(
  prev: { L: bigint | null; next: bigint | null | undefined; v2: boolean } | null, hasPrevFile: boolean, stat: bigint, cap: bigint,
): { used: bigint; rule: Exclude<LiquidityRuleV3, "carried">; cap: bigint | null } {
  if (prev && prev.next !== undefined && prev.next !== null) return { used: prev.next, rule: "frozen", cap: null };
  if (prev && prev.v2 && prev.L !== null) return { used: prev.L, rule: "switch", cap: null };
  if (prev && prev.next === undefined && !prev.v2 && prev.L !== null) return { used: clampL(stat, prev.L), rule: "legacy", cap: null };
  if (!hasPrevFile) return { used: stat, rule: "genesis", cap: null };
  return { used: min(stat, cap), rule: "first", cap };
}

/** D-22 (c): the USDC.X peg as the engine reads it from the build's two XNT prices. */
export interface XntPegV3 {
  /** x1report's USD price over the XDEX TWAP in USDC.X (USD per USDC.X × 1e18); null when either is missing */
  usdcxUsdE18: string | null;
  /** ok: within 3% of $1; high: above (every pool reading takes the pool-safe factor); low: below (already pool-safe); unread */
  guard: "ok" | "high" | "low" | "unread";
  /** the factor (× 1e18) applied to every XNT reading of the pool (candles and TWAP): usdcxUsdE18 when high, else 1e18 */
  factorE18: string;
}

/**
 * D-22 (c): the depeg guard. The pool prices XNT in USDC.X, counted as $1. x1report's USD price over the pool's TWAP
 * says what one USDC.X is worth: more than 3% above $1 means the pool readings undervalue XNT, so every pool reading is
 * raised by that factor (the pool-safe price: a burner is never paid more XNT because of a USDC.X premium); more than 3%
 * below $1 needs nothing (counting USDC.X as $1 already prices XNT high), and is flagged.
 */
export function xntPegV3(twapE18: bigint, apiE18: bigint): XntPegV3 {
  if (twapE18 === 0n || apiE18 === 0n) return { usdcxUsdE18: null, guard: "unread", factorE18: FP.toString() };
  const usdcx = (apiE18 * FP) / twapE18;
  if (usdcx * BPS > FP * (BPS + PEG_GUARD_BPS)) return { usdcxUsdE18: usdcx.toString(), guard: "high", factorE18: usdcx.toString() };
  if (usdcx * BPS < FP * (BPS - PEG_GUARD_BPS)) return { usdcxUsdE18: usdcx.toString(), guard: "low", factorE18: FP.toString() };
  return { usdcxUsdE18: usdcx.toString(), guard: "ok", factorE18: FP.toString() };
}

/** D-22 (b): the pool the XNT candles of epoch n are read from: epoch n−1's announced switch, else its active pool. */
export function xntPoolActiveV3(prev: XntPoolV3 | null): string {
  return prev?.next ?? prev?.active ?? XNT_POOL_DEFAULT;
}

/**
 * D-22 (b) (pure): this build's pool record from epoch n−1's and the candidates' TVL readings (unread candidates keep their
 * history, a reading of 0 counts). The candidate with the highest median above XNT_POOL_SWITCH_X × the active pool's median
 * is `deeper`; the second build in a row with the same deeper pool announces it as `next` (in force from the next epoch).
 */
export function xntPoolRecordV3(prev: XntPoolV3 | null, readings: { pool: string; tvlMicro: string }[] | undefined): XntPoolV3 {
  const active = xntPoolActiveV3(prev);
  const hist = new Map<string, string[]>((prev?.pools ?? []).map((x) => [x.pool, x.tvl]));
  const seen = new Set<string>();
  for (const [i, r] of (readings ?? []).entries()) {
    const pool = pubkey(r.pool, `xntPools[${i}].pool`);
    if (seen.has(pool)) throw new Error(`xntPools: pool ${pool} twice`);
    seen.add(pool);
    const v = uint(r.tvlMicro, `xntPools[${i}].tvlMicro`, U64).toString();
    hist.set(pool, [v, ...(hist.get(pool) ?? [])].slice(0, XNT_POOL_TVL_EPOCHS));
  }
  const pools = [...hist.entries()].sort((a, b) => cmpStr(a[0], b[0])).map(([pool, tvl]) => ({ pool, tvl }));
  const med = (p: string) => {
    const v = hist.get(p);
    return v && v.length ? medianWithZeros(v.map(BigInt)) : 0n;
  };
  const a = med(active);
  let deeper: string | null = null;
  let best = 0n;
  for (const { pool } of pools) {
    if (pool === active) continue;
    const m = med(pool);
    if (m > XNT_POOL_SWITCH_X * a && m > best) {
      best = m;
      deeper = pool;
    }
  }
  // a build counts toward the 2 builds only when it read both pools (a build without readings changes nothing)
  const fresh = deeper !== null && seen.has(active) && seen.has(deeper);
  const weeks = deeper === null ? 0 : prev?.deeper === deeper && prev.active === active ? prev.weeks + (fresh ? 1 : 0) : fresh ? 1 : 0;
  return { active, pools, deeper, weeks, next: deeper !== null && fresh && weeks >= XNT_POOL_SWITCH_WEEKS ? deeper : null };
}

/** D-22 (a): the week's cap on C from the XDEX pool's XNT reserve at the week start: 7 daily tranches of 2% of it. */
export function trancheCapV3(capReserve: bigint | null): bigint | null {
  return capReserve === null ? null : BigInt(EPOCH_DAYS) * ((capReserve * XDEX_TRANCHE_BPS) / BPS);
}

/** A recorded XDEX reading (D-22 a), checked; null for null or absent. */
export function xdexReadingOf(v: unknown, what: string): XdexReadingV3 | null {
  if (v === undefined || v === null) return null;
  const o = exactKeys(v, ["feeBps", "pool", "slot", "usdcReserveMicro", "wxntReserveLamports"], what);
  const feeBps = nat(o.feeBps, `${what}.feeBps`);
  if (feeBps >= 10_000) throw new Error(`${what}.feeBps ${feeBps} is not below 100%`);
  return {
    pool: pubkey(o.pool, `${what}.pool`), slot: nat(o.slot, `${what}.slot`),
    wxntReserveLamports: uint(o.wxntReserveLamports, `${what}.wxntReserveLamports`, U64).toString(),
    usdcReserveMicro: uint(o.usdcReserveMicro, `${what}.usdcReserveMicro`, U64).toString(), feeBps,
  };
}

/** A burn's two closed-candle readings [median, last close], or null for source "fallback" (both "0"). */
export function priceReadings(median: unknown, last: unknown, source: unknown, what: string): [bigint, bigint] | null {
  if (source === "fallback") {
    if (median !== "0" || last !== "0") throw new Error(`${what}: a fallback price records no candle readings ("0")`);
    return null;
  }
  if (source !== "candles") throw new Error(`${what}: unknown price source ${JSON.stringify(source)}`);
  const m = uint(median, `${what} median`);
  const l = uint(last, `${what} last close`);
  if (m === 0n || l === 0n) throw new Error(`${what}: no candle price (record it as "fallback")`);
  return [m, l];
}

/** XEN burn price (§3.4, A5): the lower closed reading, never above the cap; without candles, the build spot. */
export function xenPrice(r: [bigint, bigint] | null, spotE18: bigint, capE18: bigint): { priceE18: bigint; rule: XenRule } {
  const low = r === null ? spotE18 : min(r[0], r[1]);
  if (capE18 < low) return { priceE18: capE18, rule: "cap" };
  if (r === null) return { priceE18: spotE18, rule: "spot" };
  return r[1] < r[0] ? { priceE18: r[1], rule: "last" } : { priceE18: r[0], rule: "median" };
}

/** XNT price of a burn (A1, A3.2, A5): the higher closed reading, never below the floor; without candles, the build price. */
export function xntPrice(r: [bigint, bigint] | null, buildE18: bigint, floorE18: bigint): { xE18: bigint; rule: XntRule } {
  const high = r === null ? buildE18 : max(r[0], r[1]);
  if (floorE18 > high) return { xE18: floorE18, rule: "floor" };
  if (r === null) return { xE18: buildE18, rule: "build" };
  return r[1] > r[0] ? { xE18: r[1], rule: "last" } : { xE18: r[0], rule: "median" };
}

export function spotMicro(amountWei: bigint, priceE18: bigint): bigint {
  return (amountWei * priceE18) / 10n ** 30n;
}

/** Runs one chain's curve over its burns (sorted by time): values per burn and the state after. */
export function runCurve(burns: { hour: number; spot: bigint }[], L: bigint, start: { S: bigint; hour: number }) {
  let S = start.S;
  let hour = start.hour;
  const values: bigint[] = burns.map(() => 0n);
  for (let i = 0; i < burns.length; ) {
    const H = burns[i].hour;
    let j = i;
    let V = 0n;
    while (j < burns.length && burns[j].hour === H) V += burns[j++].spot;
    S = decay(S, Math.max(0, H - hour));
    // each burn's exact share of the pot, floored once: never larger when S or V is larger (F-I4R)
    const den = (L + S) * (L + S + V);
    for (let k = i; k < j; k++) values[k] = L === 0n || V === 0n ? 0n : (L * L * burns[k].spot) / den;
    S += V;
    hour = Math.max(hour, H);
    i = j;
  }
  return { values, after: { S, hour } };
}

/**
 * Global order (D-14): (timestamp, keccak256(txHash ‖ logIndex)), so a same-second tie never favours a chain; the
 * remaining keys (chainId, blockNumber, logIndex) only order two events whose hash ties too (one transaction replayed on
 * two chains), so the order stays total and unique per event.
 */
export function globalOrder(a: BurnEvent, b: BurnEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  const ka = tieKeyV3(a.txHash, a.logIndex);
  const kb = tieKeyV3(b.txHash, b.logIndex);
  return cmpStr(ka, kb) || a.chainId - b.chainId || a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
}

/**
 * X-010 / X-022 (pure, shared by the build's reader and the engine): null when a chain's recorded portal counters agree
 * with its burns, else why not. `prev*` = the previous record's counters (null: none recorded, e.g. after a v2 file):
 * with them the ids must be exactly prevMissionsAt + 1 … missionsAt and burnedAt = prevBurnedAt + Σ amount; without them
 * the ids must run contiguously up to missionsAt and burnedAt cover Σ amount.
 */
export function countersErrorV3(
  burns: { missionId: string; amountWei: string }[], missionsAt: bigint | null, burnedAt: bigint | null, prevMissionsAt: bigint | null, prevBurnedAt: bigint | null,
): string | null {
  if (missionsAt !== null) {
    let ids: bigint[];
    try {
      ids = burns.map((b) => uint(b.missionId, "missionId")).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    } catch (e) {
      return `a mission id is not a canonical integer (${(e as Error).message})`;
    }
    for (let i = 1; i < ids.length; i++) if (ids[i] !== ids[0] + BigInt(i)) return `mission ids do not run contiguously (${ids[i - 1]} then ${ids[i]})`;
    if (prevMissionsAt !== null && missionsAt < prevMissionsAt) return `missionsAt ${missionsAt} is below the previous record's ${prevMissionsAt}`;
    if (ids.length) {
      if (ids[ids.length - 1] !== missionsAt) return `the last mission id read is ${ids[ids.length - 1]}, but the portal counts ${missionsAt} missions at toBlock`;
      if (ids[0] < 1n) return "mission ids start at 1";
      if (prevMissionsAt !== null && ids[0] !== prevMissionsAt + 1n) return `the first mission id read is ${ids[0]}, not the previous record's missionsAt + 1 (${prevMissionsAt + 1n})`;
    } else if (prevMissionsAt !== null && missionsAt !== prevMissionsAt) {
      return `no MissionStarted read, but the portal counts ${missionsAt} missions at toBlock (the previous record ${prevMissionsAt})`;
    }
  }
  if (burnedAt !== null) {
    let sum = 0n;
    try {
      for (const b of burns) sum += uint(b.amountWei, "amountWei");
    } catch (e) {
      return `an amount is not a canonical integer (${(e as Error).message})`;
    }
    if (prevBurnedAt !== null) {
      if (burnedAt !== prevBurnedAt + sum) return `portal.totalBurned at toBlock is ${burnedAt}, not the previous record's ${prevBurnedAt} + the ${sum} wei read`;
    } else if (burnedAt < sum) return `portal.totalBurned at toBlock is ${burnedAt}, below the ${sum} wei read`;
  }
  return null;
}

/**
 * CF-22 / X-160 / T8-4: null when a v3 file may still be sent to publish_epoch at X1 time `nowTs`, else why not: a
 * publication more than MAX_PUBLISH_LAG after the build's snapshot (window.endTs, the X1 block time of the build) is
 * refused, as is an unknown clock (fail closed) and a clock before the snapshot (impossible on X1: a wrong reading).
 * publishEpochV3 asks this right before sending, whatever path built the file; the run's gate (rebuildReason) rebuilds
 * such a file on a fresh snapshot instead.
 */
export function publishAgeError(f: { epoch?: unknown; window?: { endTs?: unknown } }, nowTs: number | null | undefined): string | null {
  const endTs = f?.window?.endTs;
  if (!isBlockTime(endTs)) return `epoch ${String(f?.epoch)}: no window end, so the build's age cannot be checked`;
  if (nowTs === null || nowTs === undefined || !isBlockTime(nowTs)) return `epoch ${String(f.epoch)}: the X1 clock (a finalized slot's block time) could not be read, so the build's age cannot be checked against MAX_PUBLISH_LAG (fail closed)`;
  if (nowTs < endTs - CLOCK_SKEW_MAX) return `epoch ${String(f.epoch)}: the X1 clock ${nowTs} is before the build's snapshot ${endTs}: a wrong clock reading`;
  if (nowTs > endTs + MAX_PUBLISH_LAG) return `epoch ${String(f.epoch)} was built at ${endTs} (X1), ${nowTs - endTs} s ago: more than MAX_PUBLISH_LAG ${MAX_PUBLISH_LAG} s, so it is never published (rebuild it on a fresh snapshot)`;
  return null;
}

/**
 * A burn's tranche day: whole days since the window start (epoch n−1's publication), 0 for a burn before it
 * (a skipped chain's backlog). It never depends on the build time (F-DAYORIGIN); days ≥ 7 are a further week.
 */
export function dayOf(timestamp: number, startTs: number): number {
  return Math.max(0, Math.floor((timestamp - startTs) / DAY));
}

// ── encoding (§7) ──────────────────────────────────────────────────────────────────────────────
export interface Encoding {
  leaves: Leaf[];
  T: bigint;
  totalScore: bigint;
}

/**
 * Lamport targets → leaf scores: score = target (A13.1). The upgraded program writes drop_reserve = 0 for every epoch,
 * so with budget = totalScore and rate_cap = 1 every claim floor(score × budget / totalScore) is exactly its target:
 * no gross-up for a drop reserve, no rounding excess (I9, I12 exact).
 */
export function encodeLeaves(targets: TargetV3[]): Encoding {
  const T = targets.reduce((s, t) => s + BigInt(t.target), 0n);
  if (T === 0n) return { leaves: [], T, totalScore: 0n };
  const leaves = targets.map((t) => {
    const score = BigInt(t.target);
    if (score <= 0n || score >= 2n ** 64n) throw new Error(`leaf score out of range for ${t.player}:${t.tier}`);
    return { player: t.player, tier: t.tier, score: score.toString() };
  });
  return { leaves, T, totalScore: T };
}

/**
 * The upgraded program's publish_epoch + claim math (forge.rs) for rate_cap = 1: budget = min(10% of the free pool,
 * totalScore), drop_reserve = 0 (Forge Drops are off for every epoch it publishes, A13.1), claim = ⌊score × budget /
 * totalScore⌋.
 */
export function programClaims(scores: bigint[], totalScore: bigint, freePool: bigint) {
  let budget = (freePool * EPOCH_BUDGET_BPS) / BPS;
  if (totalScore < budget) budget = totalScore;
  return { budget, claims: scores.map((s) => (totalScore === 0n ? 0n : (s * budget) / totalScore)) };
}

/**
 * Σ score + the keeper tip of every claim at or above the tip minimum, with budget = totalScore (A3.1). The upgraded
 * program's minimum (0.2 XNT, KEEPER_TIP_MIN_CLAIM): every claim is counted as if a third-party keeper submitted it,
 * the most the program can pay out of the free pool for the epoch's claims.
 */
export function plannedOutflow(scores: bigint[], totalScore: bigint): bigint {
  const { claims } = programClaims(scores, totalScore, totalScore * 10n);
  return totalScore + KEEPER_TIP * BigInt(claims.filter((c) => c >= KEEPER_TIP_MIN_CLAIM).length);
}

/**
 * Before publish_epoch, with the free pool re-read just before sending it: null when the file may be published,
 * otherwise why it must be rebuilt. The pool may not have moved more than the rebuild drift, and the planned
 * outflow (Σ score + keeper tips: a v3 epoch has no drop reserve and no drop luck, A13.1) plus the most the program
 * pays the oracle at publication (D-47 oracleAllowanceMax) must fit in 10% of the pool now, so the on-chain budget
 * is exactly totalScore (I9) and the allowance is paid in full. The build's drift margin makes the second rule follow
 * from the first.
 * A12 (RE-1): with `nowTs` (the X1 block time of the finalized slot the pool was read at), a build whose snapshot is
 * older than MAX_PUBLISH_LAG is rebuilt instead of sent, so the oracle itself never makes a late publication (the
 * next epoch would still build on it: a late publication is reported by verify, never a deadlock).
 */
export function rebuildReason(f: EpochBodyV3, freePoolNow: bigint, nowTs?: number | null): string | null {
  // A13.5 (N5): a block-time read that failed (null) fails CLOSED: the snapshot's age is unknown, so the build is not
  // sent. `undefined` (no clock given) is the pure pool check the suites use; the publish path always passes a reading
  // (flow-v3 publishGateV3, which refuses outright on null instead of rebuilding)
  // A13.11 (review R5): a reading that is not a block time (NaN, a fraction, a negative or non-number value) is unknown
  // too, so the lag comparison below can never pass by being false
  if (nowTs === null || (nowTs !== undefined && !isBlockTime(nowTs))) return `${CLOCK_UNKNOWN}: the snapshot's age cannot be checked against MAX_PUBLISH_LAG, so the build is not published (A13.5)`;
  if (nowTs !== undefined && nowTs > f.window.endTs + MAX_PUBLISH_LAG) {
    return `snapshot older than MAX_PUBLISH_LAG (window end ${f.window.endTs}, now ${nowTs}): rebuild on a fresh snapshot`;
  }
  const F = BigInt(f.freePool.lamports);
  const drift = freePoolNow > F ? freePoolNow - F : F - freePoolNow;
  if (drift * BPS > F * REBUILD_DRIFT_BPS) return `the free pool moved from ${F} to ${freePoolNow}, more than the rebuild drift`;
  const planned = plannedOutflow(f.leaves.map((l) => BigInt(l.score)), BigInt(f.totalScore));
  const boundNow = (freePoolNow * EPOCH_BUDGET_BPS) / BPS;
  const allowance = oracleAllowanceMax(boundNow);
  if (planned + allowance > boundNow) return `planned outflow ${planned} plus the oracle allowance ${allowance} above 10% of the free pool ${freePoolNow}`;
  return null;
}

/** A13.5: the start of rebuildReason's fail-closed answer (the X1 block time of the pool read is unknown) */
export const CLOCK_UNKNOWN = "the X1 block time of the free-pool read is unknown";

/** A13.11: a usable X1 block time: a safe non-negative integer number of unix seconds (anything else is an unknown clock). */
export function isBlockTime(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/**
 * A13.11 (review R5): null when this oracle may send `f` to publish_epoch, else why not. A provisional member (A13.4),
 * and also, whatever members the file carries, a window shorter than MIN_WINDOW (a provisional file stripped of its
 * member and re-hashed) or a v3 file without a usable window. A v2 file has no window and is not concerned.
 */
export function publishableError(f: unknown): string | null {
  const provisional = provisionalError(f);
  if (provisional) return provisional;
  if (!f || typeof f !== "object") return "not an epoch file";
  const o = f as { version?: unknown; window?: { startTs?: unknown; endTs?: unknown } };
  if (o.window === undefined && o.version !== 3) return null;
  const w = o.window;
  if (!w || typeof w !== "object" || !isBlockTime(w.startTs) || !isBlockTime(w.endTs)) return "a v3 file without a window (startTs, endTs) is never published (A13.11)";
  const len = w.endTs - w.startTs;
  if (len < MIN_WINDOW) return `window of ${len} s is shorter than MIN_WINDOW ${MIN_WINDOW} s: it can never be an epoch, so it is never published (A13.11)`;
  return null;
}

/**
 * A13.4 (N3): null unless `f` is (or claims to be) a provisional dry-run file. Presence of the member is enough, even
 * `null` or `{}`: such a file is never an epoch, never a previous file, never an extra base and never published.
 */
export function provisionalError(f: unknown): string | null {
  if (!f || typeof f !== "object" || !Object.prototype.hasOwnProperty.call(f, "provisional")) return null;
  const p = (f as { provisional?: { reason?: unknown } }).provisional;
  const why = p && typeof p === "object" && typeof p.reason === "string" ? `: ${p.reason}` : "";
  return `a provisional dry-run file (A13.4) is never an epoch and never publishable${why}`;
}

/** A13.4: why a dry run's window is too short to be an epoch (null when it is long enough to build normally). */
export function provisionalReasonOf(window: { startTs: number; endTs: number }): string | null {
  const len = window.endTs - window.startTs;
  if (len >= MIN_WINDOW) return null;
  return `window of ${len} s (${(len / DAY).toFixed(2)} days) is shorter than MIN_WINDOW ${MIN_WINDOW} s (${MIN_WINDOW / DAY} days): a dry-run preview, it can never be published (MIN_EPOCH_INTERVAL)`;
}

/**
 * A13.1: the members an A7 base file carried and a two-pot base file never has: the Forge Right ledger (`ledger`,
 * `capacity.assigned` / `earmarked`), its spending (`lanes`, `boosts`, a burn's `lane`) and the drop policy (`drops`,
 * `dropsGross`). The engine cannot write any of them; a file that has one is not a base file of this engine (a forged or
 * pre-A13 file) and is refused by verify, by the next build and by the extra pot. Returns the members found.
 */
export function retiredBaseTerms(f: unknown): string[] {
  const found: string[] = [];
  if (!f || typeof f !== "object") return found;
  const o = f as Record<string, unknown>;
  for (const k of ["ledger", "lanes", "boosts", "drops", "dropsGross"]) if (Object.prototype.hasOwnProperty.call(o, k)) found.push(k);
  const cap = o.capacity;
  if (cap && typeof cap === "object") for (const k of ["assigned", "earmarked", "plan"]) if (Object.prototype.hasOwnProperty.call(cap, k)) found.push(`capacity.${k}`);
  if (Array.isArray(o.burns) && o.burns.some((b) => b && typeof b === "object" && Object.prototype.hasOwnProperty.call(b, "lane"))) found.push("burns[].lane");
  return found;
}

/** null when a v3 history starting at `v3FirstEpoch` is allowed by the pinned switch epoch. */
export function pinnedSwitchError(v3FirstEpoch: number, pinned: number | null = V3_FIRST_EPOCH): string | null {
  return pinned === null || v3FirstEpoch === pinned ? null : `v3 history starts at epoch ${v3FirstEpoch}, but the switch is pinned at epoch ${pinned}`;
}

// ── previous file → carried state ──────────────────────────────────────────────────────────────
interface PrevChain {
  chainId: number;
  name: string;
  portal: string;
  toBlock: number;
  totalSupply: string | null;
  totalSupplyError?: string;
  L: bigint | null;
  /** D-13: the L frozen for this window (L.next of a v3 record); undefined = a v3 record written before D-13, or a v2 record */
  next: bigint | null | undefined;
  /** the record is a v2 file's (the switch) */
  v2: boolean;
  curve: { S: bigint; hour: number };
  /** reference inputs for THIS epoch (most recent first, at most 4) */
  refInputs: bigint[];
  /** v2 only: the chain's xenUsdE18 in the v2 file (the first switch reading) */
  v2Reading: bigint | null;
  /** D-12: the previous file carried this chain without reading it (a v2 file never skips a chain) */
  skipped: boolean;
  /** X-010: the previous record's portal counters (null: none recorded) */
  missionsAt: bigint | null;
  burnedAt: bigint | null;
  /** D-21 (null for a v2 record, or a v3 record written before D-21) */
  noMarketRun: { skips: number; refE18: bigint } | null;
  orphan: { refE18: bigint; from: number } | null;
}

interface PrevState {
  version: 2 | 3 | null;
  epoch: number;
  chains: Map<number, PrevChain>;
  x: bigint | null;
  v3FirstEpoch: number | null;
  dataHash: string | null;
  /** T2-RULES: the previous v3 file's rulesId (null: a v2 file, or a v3 file written before the rules block) */
  rulesId: number | null;
  /** D-22 (a): the XDEX WXNT reserve that caps this window (epoch n−1's reading at its build, else its own capReserve) */
  capReserve: bigint | null;
  /** D-22 (b): the previous file's XNT pool record (null: a v2 file, or a v3 file written before D-22 b) */
  xntPool: XntPoolV3 | null;
}

const optUint = (v: unknown, what: string, bound?: bigint): bigint | null => (v === undefined || v === null ? null : uint(v, what, bound));

/** The v2 → v3 curve seed: §3.6 a, b, f over a v2 file's burns of one chain (recorded prices as spot). */
function v2Curve(burns: Burn[]): { S: bigint; hour: number } {
  const sorted = [...burns].sort((a, b) => a.timestamp - b.timestamp || a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  let S = 0n;
  let hour = sorted.length ? Math.floor(sorted[0].timestamp / HOUR) : 0;
  for (const b of sorted) {
    const H = Math.floor(b.timestamp / HOUR);
    S = decay(S, Math.max(0, H - hour));
    S += spotMicro(BigInt(b.amountWei), BigInt(b.priceE18 ?? "0"));
    hour = Math.max(hour, H);
  }
  return { S, hour };
}

function prevState(prev: AnyEpochFile | null): PrevState {
  const chains = new Map<number, PrevChain>();
  if (!prev) return { version: null, epoch: 0, chains, x: null, v3FirstEpoch: null, dataHash: null, rulesId: null, capReserve: null, xntPool: null };
  // the frozen v2 hash drops such a member, so a file could carry unhashed data (R2-4)
  const proto = protoPath(prev);
  if (proto) throw new Error(`epoch-${prev.epoch}.json has a "__proto__" member at ${proto}`);
  if (prev.version === 3) {
    for (const c of prev.chains) {
      // a v3 file written before the rules block (the kit's vectors) has no counters: read as "none recorded"
      const r = c as ChainRecordV3 & { missionsAt?: unknown; burnedAt?: unknown };
      // D-13: a record written before D-13 has no L.next member (undefined: the legacy rule); null = nothing frozen
      const nx = (c.L as { next?: unknown }).next;
      chains.set(nat(c.chainId, "previous chain id"), {
        chainId: c.chainId, name: c.name, portal: c.portal, toBlock: c.toBlock, totalSupply: c.totalSupply,
        ...(c.totalSupplyError !== undefined ? { totalSupplyError: c.totalSupplyError } : {}),
        L: c.L.used === null ? null : BigInt(c.L.used),
        next: nx === undefined ? undefined : optUint(nx, `epoch-${prev.epoch}.json chain ${c.chainId} L.next`),
        v2: false,
        curve: { S: BigInt(c.curveAfter.S), hour: c.curveAfter.hour },
        refInputs: [c.xenUsdE18, ...c.refInputs.slice(0, 3)].map(BigInt),
        v2Reading: null,
        skipped: c.skipped === true,
        missionsAt: optUint(r.missionsAt, `epoch-${prev.epoch}.json chain ${c.chainId} missionsAt`, U64),
        burnedAt: optUint(r.burnedAt, `epoch-${prev.epoch}.json chain ${c.chainId} burnedAt`),
        noMarketRun: (() => {
          const r = (c as { noMarketRun?: { skips?: unknown; refE18?: unknown } | null }).noMarketRun;
          return r ? { skips: nat(r.skips, `epoch-${prev.epoch}.json chain ${c.chainId} noMarketRun.skips`), refE18: uint(r.refE18, `epoch-${prev.epoch}.json chain ${c.chainId} noMarketRun.refE18`) } : null;
        })(),
        orphan: (() => {
          const o = (c as { orphan?: { refE18?: unknown; from?: unknown } | null }).orphan;
          return o ? { refE18: uint(o.refE18, `epoch-${prev.epoch}.json chain ${c.chainId} orphan.refE18`), from: nat(o.from, `epoch-${prev.epoch}.json chain ${c.chainId} orphan.from`) } : null;
        })(),
      });
    }
    // A13.1: a v3 previous file is a two-pot base file; one with a Forge Right ledger, a lane, a boost or a drop policy
    // was not written by this engine, and nothing is ever built on it
    const retired = retiredBaseTerms(prev);
    if (retired.length) throw new Error(`epoch-${prev.epoch}.json carries retired base terms (${retired.join(", ")}): not a two-pot base file (A13.1)`);
    if (dataHashV3(prev) !== prev.dataHash) throw new Error(`epoch-${prev.epoch}.json does not match its data hash`);
    const rb = (prev as { rulesBlock?: unknown }).rulesBlock;
    const rulesId = rb === undefined ? null : rulesBlockOf(rb).rulesId;
    // D-22 (a): this window's cap reads epoch n−1's XDEX reading at its build (its own cap reserve when it read none)
    const px = (prev as { xdex?: { atBuild?: unknown; capReserve?: unknown } }).xdex;
    const atBuild = px ? xdexReadingOf(px.atBuild, `epoch-${prev.epoch}.json xdex.atBuild`) : null;
    const capReserve = atBuild ? BigInt(atBuild.wxntReserveLamports) : px ? optUint(px.capReserve, `epoch-${prev.epoch}.json xdex.capReserve`, U64) : null;
    const xp = (prev as { xntPool?: XntPoolV3 }).xntPool ?? null;
    return { version: 3, epoch: prev.epoch, chains, x: BigInt(prev.xnt.usdE18), v3FirstEpoch: prev.v3FirstEpoch, dataHash: prev.dataHash, rulesId, capReserve, xntPool: xp };
  }
  if (prev.version === 2) {
    for (const c of prev.chains) {
      const L = BigInt(c.liquidityUsdMicro || "0");
      chains.set(nat(c.chainId, "previous chain id"), {
        chainId: c.chainId, name: c.name, portal: c.portal, toBlock: c.toBlock, totalSupply: c.totalSupply,
        L: L > 0n ? L : null,
        next: undefined,
        v2: true,
        curve: v2Curve(prev.burns.filter((b) => b.chainId === c.chainId)),
        refInputs: [],
        v2Reading: BigInt(c.xenUsdE18 || "0"),
        // v2 reads every chain or aborts the epoch, and records no portal counter
        skipped: false,
        missionsAt: null,
        burnedAt: null,
        noMarketRun: null,
        orphan: null,
      });
    }
    if (dataHashV2(prev) !== prev.dataHash) throw new Error(`epoch-${prev.epoch}.json (v2) does not match its data hash`);
    const x = BigInt(prev.xnt.usdE18 || "0");
    return { version: 2, epoch: prev.epoch, chains, x: x > 0n ? x : null, v3FirstEpoch: null, dataHash: prev.dataHash, rulesId: null, capReserve: null, xntPool: null };
  }
  throw new Error(`unknown version of epoch file ${(prev as { epoch?: number }).epoch}`);
}

/** The switch epoch's reference history (SC-10): each v2 chain's last (up to) 4 readings become its refInputs. */
function applySwitchRefs(p: PrevState, refs: SwitchRefV3[] | null | undefined): SwitchRefV3[] | null {
  if (p.version !== 2) {
    if (refs !== null && refs !== undefined) throw new Error("switchRefs are recorded only at the v2 → v3 switch");
    return null;
  }
  if (!Array.isArray(refs)) throw new Error("the v2 → v3 switch needs switchRefs: the last (up to) 4 v2 readings of every chain");
  const out: SwitchRefV3[] = [];
  for (const r of refs.map((x) => ({ chainId: nat(x.chainId, "switchRefs chain id"), readings: x.readings })).sort((a, b) => a.chainId - b.chainId)) {
    const pc = p.chains.get(r.chainId);
    if (!pc) throw new Error(`switchRefs: chain ${r.chainId} is not in the v2 file`);
    if (out.length && out[out.length - 1].chainId === r.chainId) throw new Error(`switchRefs: chain ${r.chainId} twice`);
    if (!Array.isArray(r.readings) || r.readings.length < 1 || r.readings.length > 4) throw new Error(`switchRefs ${r.chainId}: 1 to 4 readings`);
    const readings = r.readings.map((x, i) => uint(x, `switchRefs ${r.chainId}[${i}]`));
    if (readings[0] !== pc.v2Reading) throw new Error(`switchRefs ${r.chainId}: the first reading must be epoch ${p.epoch}'s xenUsdE18`);
    pc.refInputs = readings;
    out.push({ chainId: r.chainId, readings: readings.map(String) });
  }
  if (out.length !== p.chains.size) throw new Error("switchRefs must list every chain of the v2 file");
  return out;
}

/** --full helper: the switchRefs of the first v3 epoch from the v2 files, most recent first (v2's own 4-epoch rule). */
export function switchRefsFromV2(files: EpochFile[]): SwitchRefV3[] {
  if (!files.length) return [];
  return files[0].chains
    .map((c) => ({ chainId: c.chainId, readings: files.slice(0, 4).map((f) => f.chains.find((x) => x.chainId === c.chainId)?.xenUsdE18 || "0") }))
    .sort((a, b) => a.chainId - b.chainId);
}

// ── allocation (§5, layered rule) ──────────────────────────────────────────────────────────────
/** One burn as seen by the allocation; the last five fields are written by allocateBurns. */
export interface AllocItem {
  tier: number;
  day: number;
  lp: bigint;
  band: bigint;
  senior: bigint;
  basePaid: bigint;
  bandPaid: bigint;
  /** A12: the part of the Launchpad layer locked on the burn's tier with its full band (lp = the whole mission, 0 = nothing) */
  lockedLp: bigint;
  converted: boolean;
  leafTier: number;
}

export const allocItem = (tier: number, day: number, lp: bigint, band: bigint): AllocItem => ({
  tier, day, lp, band, senior: 0n, basePaid: 0n, bandPaid: 0n, lockedLp: 0n, converted: false, leafTier: 0,
});

/**
 * A12 (RE-2): the piece of a mission (lp, band) that locks on a claim below its whole entitlement: the claim's band
 * share band₁ = ⌊claim × band / (lp + band)⌋ and the smallest layer lp₁ = ⌈band₁ × lp / band⌉ whose full band covers it,
 * so the piece is never locked above its full multiplier and is short of it by at most ⌈band/lp⌉ lamports; the rounding
 * rest of the claim (a few lamports) pays the Launchpad piece lp − lp₁ as cash, so the burn consumes what it is paid at
 * arrival. Any claim locks a piece, whether it is above lp or not: a lamport is never locked below the multiplier the
 * burner chose and never converted when it could vest (A12, replacing A9's 50% threshold). The whole mission locks
 * when the claim is lp + band. Null when the band is 0 or when the piece would be dust (below minVestEnt: F6 per
 * piece): then the burn is paid as Launchpad. The piece grows with the claim (and the Launchpad piece shrinks with it),
 * so every burn's allocation is monotone in C (exactly with minVestEnt = 0; across the dust edge a burn's senior can
 * jump by less than minVestEnt), and a mission split into several transactions sized to the capacity locks the same
 * as the whole mission, so nothing depends on who knows that (RE-2).
 */
export function lockPiece(lp: bigint, band: bigint, claim: bigint, minVestEnt: bigint): { lp: bigint; band: bigint; cash: bigint } | null {
  if (band <= 0n || lp <= 0n || claim <= 0n) return null;
  if (claim >= lp + band) return { lp, band, cash: 0n };
  const band1 = (claim * band) / (lp + band);
  const lp1 = band1 === 0n ? 0n : ceilDiv(band1 * lp, band);
  if (lp1 === 0n || lp1 > lp || lp1 + band1 > claim || lp1 + band1 < minVestEnt) return null;
  // the rounding rest (0 ≤ claim − lp₁ − band₁ < (lp + band)/band) pays the Launchpad piece, never beyond it: a burn
  // never consumes more than it is paid at arrival
  const cash = min(claim - lp1 - band1, lp - lp1);
  return { lp: lp1, band: band1, cash };
}

/**
 * The arrival outcome of a claim (A12): the piece of the mission it covers in full, locked on the burn's tier with the
 * rest of its layer as Launchpad cash (`lockPiece`), or, for a tier-0 burn, dust or a claim that covers no piece, the
 * Launchpad layer only (converted when tier > 0). Sets every output field of `w` but the leftover top-up.
 */
function settleArrival(w: AllocItem, claim: bigint, vests: boolean, minVestEnt: bigint) {
  w.bandPaid = 0n;
  w.converted = false;
  w.leafTier = 0;
  w.lockedLp = 0n;
  const piece = vests ? lockPiece(w.lp, w.band, claim, minVestEnt) : null;
  if (piece) {
    w.senior = piece.lp + piece.band + piece.cash;
    w.lockedLp = piece.lp;
    w.bandPaid = piece.band;
    w.basePaid = piece.lp + piece.cash;
    w.leafTier = w.tier;
  } else {
    // tier 0, dust, or a mission whose claim covers no piece: it takes its Launchpad layer only, so to every later burn
    // it is exactly a Launchpad burn
    w.senior = min(w.lp, claim);
    w.basePaid = w.senior;
    w.converted = w.tier > 0;
  }
}

/**
 * A13.2: the build limit, consulted claim by claim in the global order by `allocateBurns`. `room()` is the limit less the
 * outflow booked so far (Σ paid + one keeper tip per leaf at or above the tip minimum: the exact planned outflow of the
 * claims booked, never above the limit); `launchpad(i)` the target booked so far on burn i's (x1, 0) leaf; `add` books
 * what burn i was given: `toTier` on its (x1, leafTier) leaf, `toZero` on its (x1, 0) leaf.
 */
export interface ClaimGate {
  room(): bigint;
  launchpad(i: number): bigint;
  add(i: number, leafTier: number, toTier: bigint, toZero: bigint): void;
}

/**
 * A13.2: the keeper tips a claim of `a` lamports keeps in reserve: one per threshold θ ≤ a, a threshold being the amount
 * that brings one of the claim's leaves to the tip minimum. So a + KEEPER_TIP × spare(a) is non-decreasing in a.
 */
const spareTips = (a: bigint, thresholds: bigint[]) => BigInt(thresholds.filter((t) => t <= a).length);

/**
 * A13.2: the largest a ≥ 0 with a + KEEPER_TIP × spare(a) ≤ room (room ≥ 0): the regimes between the thresholds, tried
 * from the highest down (the first feasible one holds the largest a, the left side being non-decreasing).
 */
export function fitClaim(room: bigint, thresholds: bigint[]): bigint {
  const ts = [...thresholds].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  for (let j = ts.length; j >= 0; j--) {
    const lo = j === 0 ? 0n : ts[j - 1];
    let cand = room - KEEPER_TIP * BigInt(j);
    if (j < ts.length) cand = min(cand, ts[j] - 1n);
    if (cand >= lo && cand >= 0n) return cand;
  }
  return 0n;
}

/** A13.2: the gate of a build limit, `walletOf(i)` the x1 wallet of burn i. */
export function limitGate(limit: bigint, walletOf: (i: number) => string): ClaimGate {
  const targets = new Map<string, bigint>();
  let paid = 0n;
  let tipped = 0n;
  return {
    room: () => limit - paid - KEEPER_TIP * tipped,
    launchpad: (i) => targets.get(leafKey(walletOf(i), 0)) ?? 0n,
    add: (i, leafTier, toTier, toZero) => {
      const x1 = walletOf(i);
      for (const [tier, v] of [[leafTier, toTier], [0, toZero]] as const) {
        if (v <= 0n) continue;
        const k = leafKey(x1, tier);
        const before = targets.get(k) ?? 0n;
        targets.set(k, before + v);
        paid += v;
        if (before < KEEPER_TIP_MIN_CLAIM && before + v >= KEEPER_TIP_MIN_CLAIM) tipped++;
      }
    },
  };
}

/** A13.2: where a shortfall cut the week: burns[0..kept) keep that stage's claim whole, burns[kept] takes `claim` of its `wanted`, every later claim is 0 */
export interface AllocCut {
  stage: "arrival" | "leftover";
  kept: number;
  wanted: bigint;
  claim: bigint;
}

/**
 * A9 / A12 (§5.2–5.3 restated per burn): every burn claims its whole entitlement first come first served against the
 * week's daily release: the Launchpad layer lp for a tier-0 burn, lp + band for a vesting burn. A mission's outcome
 * is therefore decided at its own arrival and never moves with a later burn (I2 extended to the band). The first
 * (C mod 7) days release one extra lamport each, so every day's cumulative cap grows with C and no burn ever loses
 * when C grows (F3); from day 7 on (a longer window) the whole C is open, first come first served: the cumulative cap
 * never falls (A12 / RE-3). A vesting burn locks the piece of its mission that its claim covers in full (`lockPiece`):
 * the whole mission, a split (the locked piece on its tier, the rest of the layer as a Launchpad piece), or nothing,
 * when the covered piece would be dust; then it is converted: it takes and is paid its Launchpad layer only, exactly
 * as a tier-0 burn would. A burn always consumes what it is paid at arrival, so to every later burn only the capacity
 * it took matters. The leftover pass then pays the week's unused schedule to the unmet Launchpad layers
 * (pieces included), in the same order: no band is ever paid from it, and nothing consumed is paid to nobody. A vesting
 * burn entitled to less than `minVestEnt` claims and is paid its Launchpad layer only. What a burn is promised at its
 * own arrival never depends on a later burn (I2); the one way a mission touches later burns is by locking, which it
 * pays for with the lock.
 *
 * A13.2 (OWNER-A12-1), with a `gate` (the build limit): the claims are paid in the order they are made, the arrival
 * claims in the global order and then the leftover top-ups (made at the window's end) in the same order, so a shortfall
 * cuts LITERALLY from the latest claim backwards. Each claim is kept whole when it fits the room left with a keeper tip
 * set aside for every leaf it could bring to the tip minimum: its Launchpad leaf (from that leaf's current target) and,
 * for an arrival claim, one tier leaf whatever its tier (`spareTips`); the first claim that does not fit is cut to the
 * largest amount that does (`fitClaim`; a mission through the same piece rule: it locks the smaller piece its cut claim
 * covers, or is paid as Launchpad when that piece would be dust: it converts only itself), and every later claim of the
 * week is 0: an arrival cut cancels the whole leftover pass. So every burn's arrival outcome depends only on the burns
 * before it, on C and on the limit (prefix-stable), the cut depends on neither the burn's own size nor its tier, and no
 * later burn, of any tier, can lower what an earlier burn is paid at its arrival. Without a gate, or when every claim
 * fits, it is the plain FCFS run.
 *
 * D-12 / D-18: `plan` (the identity, one stage, when absent) runs the claims in STAGES, each an arrival pass then a
 * leftover pass over its own items (indices into ws), every stage claiming only what the earlier ones left:
 *   stage 1: the window's burns then the backlog at the arrival, the backlog then the window's burns in the leftover;
 *   stage 2: the operator burns (arrival, then leftover), after every claim of every other burn, top-ups included.
 * Every item is in exactly one stage, once in its arrival list and once in its leftover list; the arrival lists, read in
 * stage order, are in day order. A13.2 holds over the whole sequence: a cut makes every later claim, of any stage, 0.
 */
export interface AllocPlanV3 {
  stages: { arrival: number[]; leftover: number[] }[];
}

export function allocateBurns(ws: AllocItem[], C: bigint, minVestEnt = VEST_MIN_ENT, gate?: ClaimGate, plan?: AllocPlanV3) {
  const stages = plan?.stages ?? [{ arrival: ws.map((_, i) => i), leftover: ws.map((_, i) => i) }];
  for (const pass of ["arrival", "leftover"] as const) {
    const all = stages.flatMap((st) => st[pass]);
    if (all.length !== ws.length || new Set(all).size !== ws.length || all.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= ws.length)) {
      throw new Error(`the allocation plan's ${pass} lists must hold every item exactly once`);
    }
  }
  if (stages.some((st) => new Set(st.arrival).size !== new Set([...st.arrival, ...st.leftover]).size || st.arrival.length !== st.leftover.length)) {
    throw new Error("each stage of the allocation plan pays the same items at the arrival and in the leftover");
  }
  const days = BigInt(EPOCH_DAYS);
  const tau = C / days;
  /** the cumulative cap after k of 7 days that release R */
  const release = (R: bigint, k: number) => (R / days) * BigInt(k) + min(BigInt(k), R % days);
  const vests = (w: AllocItem) => w.tier > 0 && w.lp + w.band >= minVestEnt;
  let senior = 0n;
  /** what the claims made so far consumed of C: every arrival claim and every top-up (a later stage claims after both) */
  let consumed = 0n;
  let lastDay = 0;
  let bandTotal = 0n;
  let bandPaid = 0n;
  let locked = 0;
  let split = 0;
  let converted = 0;
  let cut: AllocCut | null = null;
  for (const stage of stages) {
    for (const i of stage.arrival) {
      const w = ws[i];
      if (w.day < lastDay) throw new Error("allocation items must be in global order");
      lastDay = w.day;
      // the cumulative cap at this burn's day: week 0 releases C over its 7 days; after day 6 the whole C is open (RE-3)
      const cap = w.day < EPOCH_DAYS ? release(C, w.day + 1) : C;
      const v = vests(w);
      if (v) bandTotal += w.band;
      // after a cut every later claim of the week is 0 (A13.2)
      const claim: bigint = cut ? 0n : min(v ? w.lp + w.band : w.lp, max(0n, cap - consumed));
      settleArrival(w, claim, v, minVestEnt);
      if (gate && !cut && w.senior > 0n) {
        // its Launchpad leaf reaches the tip minimum at θ₀ (none once it has), a tier leaf at θ₁ whatever its tier: a
        // locked piece is never below minVestEnt, so a tier leaf below the minimum can only cross it with a ≥ minVestEnt
        const room = gate.room();
        const t0 = gate.launchpad(i);
        const th = [...(t0 < KEEPER_TIP_MIN_CLAIM ? [KEEPER_TIP_MIN_CLAIM - t0] : []), max(1n, min(KEEPER_TIP_MIN_CLAIM, minVestEnt))];
        if (w.senior + KEEPER_TIP * spareTips(w.senior, th) > room) {
          // senior ≤ claim, and the cut fits: its outcome is at most the cut claim, with at most its spare tips
          const take = fitClaim(room, th);
          settleArrival(w, take, v, minVestEnt);
          cut = { stage: "arrival", kept: i, wanted: claim, claim: take };
        }
        gate.add(i, w.leafTier, w.lockedLp + w.bandPaid, w.basePaid - w.lockedLp);
      }
      if (w.leafTier > 0) {
        bandPaid += w.bandPaid;
        locked++;
        if (w.lockedLp < w.lp) split++;
      } else if (w.converted) converted++;
      senior += w.senior;
      consumed += w.senior;
    }
    for (const i of stage.leftover) {
      const w = ws[i];
      let take = cut ? 0n : min(w.lp - w.basePaid, max(0n, C - consumed));
      if (gate && !cut && take > 0n) {
        const room = gate.room();
        const t0 = gate.launchpad(i);
        const th = t0 < KEEPER_TIP_MIN_CLAIM ? [KEEPER_TIP_MIN_CLAIM - t0] : [];
        if (take + KEEPER_TIP * spareTips(take, th) > room) {
          const wanted = take;
          take = fitClaim(room, th);
          cut = { stage: "leftover", kept: i, wanted, claim: take };
        }
        gate.add(i, 0, 0n, take);
      }
      w.basePaid += take;
      consumed += take;
    }
  }
  const left = C - consumed;
  const base = ws.reduce((s, w) => s + w.basePaid, 0n);
  return { tau, senior, base, left, bandTotal, bandPaid, locked, split, converted, cut };
}

interface Work extends AllocItem {
  b: BurnInputV3;
  priceE18: bigint;
  priceRule: XenRule;
  x: bigint;
  xntRule: XntRule;
  /** the 24-hour XNT median (the build price without candles): this burn's input to the next reference */
  xMedian: bigint;
  hour: number;
  spot: bigint;
  value: bigint;
  base: bigint;
  ent: bigint;
  /** D-12 / D-18 (see BurnV3) */
  backlog: boolean;
  operator: boolean;
  exception: string | null;
}

/** D-12 / D-18: a burn's rank class: 0 = a burn of the window, 1 = a skipped chain's backlog, 2 = an operator burn. */
export function rankClassV3(w: { backlog: boolean; operator: boolean }): 0 | 1 | 2 {
  return w.operator ? 2 : w.backlog ? 1 : 0;
}

/**
 * D-12 / D-18: the arrival order (stable: the window's burns, the backlog, the operator burns, each in the order given)
 * and the allocation plan over it (indices into the arrival order): stage 1 = the window's burns then the backlog at the
 * arrival, the backlog then the window's burns in the leftover; stage 2 = the operator burns, after every other claim.
 */
export function rankOrderV3<T extends { backlog: boolean; operator: boolean }>(globalSorted: T[]): { arrival: T[]; plan: AllocPlanV3 } {
  const arrival = [0, 1, 2].flatMap((k) => globalSorted.filter((w) => rankClassV3(w) === k));
  const idx = (k: number) => arrival.flatMap((w, i) => (rankClassV3(w) === k ? [i] : []));
  return { arrival, plan: { stages: [{ arrival: [...idx(0), ...idx(1)], leftover: [...idx(1), ...idx(0)] }, { arrival: idx(2), leftover: idx(2) }] } };
}

/**
 * A13.9 (review R2): null when the engine accepts these snapshot records, else why it refuses them (a tier at or above
 * ARTIFACT_TIERS, an unknown origin, a backing ≥ 2^64, a duplicate asset, a bad key). The plumbing asks this before a
 * build, so a refused record makes the snapshot unavailable instead of stopping the base epoch.
 */
export function snapshotRecordsError(records: unknown): string | null {
  try {
    if (!Array.isArray(records)) return "the snapshot records are not an array";
    checkSnapshot(records as SnapshotRecord[]);
    return null;
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
}

/** A13.9: the recorded `unavailable` member of a snapshot input (normalized), or null when the snapshot was read. */
function snapshotUnavailableOf(s: ArtifactSnapshotV3): { reason: string } | null {
  if (!Object.prototype.hasOwnProperty.call(s, "unavailable")) return null;
  const u = (s as { unavailable?: unknown }).unavailable;
  if (!u || typeof u !== "object" || Array.isArray(u) || typeof (u as { reason?: unknown }).reason !== "string" || Object.keys(u).length !== 1) {
    throw new Error("snapshot.unavailable is not {reason: string} (A13.9)");
  }
  if (!Array.isArray(s.records) || s.records.length) throw new Error("an unavailable snapshot (A13.9) records no Artifact: records must be []");
  return { reason: reasonLineOf((u as { reason: string }).reason) };
}

function checkSnapshot(records: SnapshotRecord[]): SnapshotRecord[] {
  const sorted = records
    .map((r) => ({ asset: pubkey(r.asset, "snapshot asset"), tier: r.tier, owner: pubkey(r.owner, `asset ${r.asset} owner`), backing: r.backing, origin: r.origin }))
    .sort((a, b) => cmpStr(a.asset, b.asset));
  sorted.forEach((r, i) => {
    if (i > 0 && sorted[i - 1].asset === r.asset) throw new Error(`asset ${r.asset} twice in the snapshot`);
    if (!Number.isInteger(r.tier) || r.tier < 0 || r.tier >= ARTIFACT_TIERS) throw new Error(`asset ${r.asset}: bad tier ${r.tier}`);
    if (![ORIGIN_FORGED, ORIGIN_GENESIS, ORIGIN_DROP].includes(r.origin)) throw new Error(`asset ${r.asset}: bad origin ${r.origin}`);
    uint(r.backing, `asset ${r.asset} backing`, U64);
  });
  return sorted;
}

function checkBurn(b: BurnInputV3, chainId: number, endTs: number): BurnInputV3 {
  const id = `${String(b.chainId)}:${String(b.txHash)}:${String(b.logIndex)}`;
  if (b.chainId !== chainId) throw new Error(`burn ${id} listed under chain ${chainId}`);
  // D-14: the tie-break hashes the 32 bytes of the tx hash; one spelling per hash (lowercase, as the EVM RPCs return it)
  if (typeof b.txHash !== "string" || !/^0x[0-9a-f]{64}$/.test(b.txHash)) throw new Error(`burn ${id}: bad txHash (0x and 64 lowercase hex digits)`);
  nat(b.blockNumber, `burn ${id} blockNumber`);
  nat(b.logIndex, `burn ${id} logIndex`);
  // the burn's chain stamps it on its own clock (A8): inclusion is by block range, this only bounds a wrong range
  if (nat(b.timestamp, `burn ${id} timestamp`) > endTs + CLOCK_SKEW_MAX) throw new Error(`burn ${id} is after the build (more than ${CLOCK_SKEW_MAX} s past the window end ${endTs})`);
  if (!Number.isInteger(b.tier) || b.tier < 0 || b.tier > 2) throw new Error(`burn ${id}: bad tier`);
  uint(b.amountWei, `burn ${id} amountWei`);
  pubkey(b.x1, `burn ${id} x1`);
  return b;
}

/**
 * A burn of this chain has no XEN price: no candles, and the chain's build spot is 0 (for example its only pools
 * are younger than POOL_MIN_AGE_DAYS). The build refuses rather than value the burn at 0 for good; the plumbing
 * skips the chain (its cursor is kept) and its burns are valued once it has a price (R2-SC-3).
 */
export class NoXenPriceError extends Error {
  constructor(readonly chainId: number, burnId: string) {
    super(`burn ${burnId}: no XEN price (no candles and a build spot of 0): skip chain ${chainId} this epoch`);
    this.name = "NoXenPriceError";
  }
}

// ── the epoch (§2–§9) ──────────────────────────────────────────────────────────────────────────
/**
 * computeEpochV3, skipping every chain that has a burn without a XEN price (NoXenPriceError) instead of
 * aborting the epoch for all chains. The skipped chains are carried (cursor, L and curve kept) if the
 * previous file has them, and simply absent otherwise.
 */
export function computeEpochV3SkippingUnpriced(inputs: EpochInputsV3, prev?: AnyEpochFile | null, opts: ComputeOptsV3 = {}): { body: EpochBodyV3 | null; skipped: number[] } {
  const skipped: number[] = [];
  let current = inputs;
  for (;;) {
    try {
      return { body: computeEpochV3(current, prev, opts), skipped };
    } catch (e) {
      if (!(e instanceof NoXenPriceError) || skipped.includes(e.chainId)) throw e;
      skipped.push(e.chainId);
      // D-21: a burn without a XEN price is a skip for lack of an eligible market (for a chain the previous file carries)
      const carried = !!prev && prev.chains.some((c) => c.chainId === e.chainId);
      current = { ...current, chains: current.chains.filter((c) => c.chainId !== e.chainId), ...(carried ? { noMarket: [...(current.noMarket ?? []), e.chainId] } : {}) };
    }
  }
}

/**
 * A13.4: `provisional` (a dry run only) builds a window shorter than MIN_WINDOW instead of refusing it, and labels the
 * body with `provisional: {reason, publishable: false}`. Nothing else changes; no other caller passes it.
 */
export interface ComputeOptsV3 {
  provisional?: string | null;
  /**
   * Round 4 (quiet-month seat liveness): with nothing to pay AND no burn valued in the window (every chain read had no
   * burn, or was skipped with its cursor kept), build the program's HEARTBEAT base epoch instead of null: the same body
   * (cursors, curves, L, snapshot, capacity, all carried forward exactly as a paying build would) with burns, targets
   * and leaves empty, totalScore "0", rateCap "0", the all-zero root and `heartbeat: true`. publish_epoch accepts exactly
   * that shape on the upgraded binary only (forge.rs epoch_shape: budget 0, no claim), and a heartbeat that survives its
   * 48-h hold keeps the oracle seat alive. A window with a valued burn is never a heartbeat (that burn would be consumed
   * for nothing): it stays null, as before. Off by default: only the weekly run on the upgraded binary asks for it.
   */
  heartbeat?: boolean;
}

/** Round 4: forge.rs epoch_shape's heartbeat root (32 zero bytes) */
export const HEARTBEAT_ROOT = "0".repeat(64);

/** A v3 file that claims to be a heartbeat base epoch (the member alone; verifyEpochV3 checks the rest). */
export function isHeartbeatV3(f: unknown): boolean {
  return !!f && typeof f === "object" && (f as { heartbeat?: unknown }).heartbeat === true;
}

/** windowStateV3's options: ComputeOptsV3 and whether the build limit is consulted. */
export interface WindowOptsV3 extends ComputeOptsV3 {
  /**
   * true (the default, and always for computeEpochV3): the build limit is consulted claim by claim (A13.2). false: the
   * plain FCFS run at C, the number the site and the kit quote (the week-so-far feed, feed-v3.ts), which only a shortfall
   * at the build can cut.
   */
  limit?: boolean;
}

/** One burn as the engine values and allocates it (the working record of computeEpochV3). */
export type WorkV3 = Work;

/**
 * The window valued and allocated: computeEpochV3 up to the targets, with every check it makes on the inputs. The
 * epoch build (computeEpochV3) and the hourly week-so-far feed (feed-v3.ts) both run this one function, so the feed's
 * numbers are the build's numbers on the same inputs.
 */
export interface WindowStateV3 {
  epoch: number;
  v3FirstEpoch: number;
  prevDataHash: string | null;
  startTs: number;
  endTs: number;
  days: number;
  twap: bigint;
  api: bigint;
  xBuild: bigint;
  xFloor: bigint;
  /** epoch n−1's XNT reference (null without one) */
  prevX: bigint | null;
  xRef: bigint;
  switchRefs: SwitchRefV3[] | null;
  /** T2-RULES: the rules block the window is valued under (checked) */
  rulesBlock: RulesBlockV3;
  chains: ChainRecordV3[];
  /** every burn in the arrival order (D-12 / D-18: the window's burns, the backlog, the operator burns), valued and allocated */
  works: WorkV3[];
  /** D-12 / D-18: the allocation plan over works (rankOrderV3): stage 1 the window's burns and the backlog, stage 2 the operator burns */
  plan: AllocPlanV3;
  /**
   * Σ senior of the window's burns (rank class 0): the capacity a new burn of the window arriving now claims after, the
   * backlog and the operator burns ranking after it (the week-so-far feed's capacity.senior). alloc.senior is the total.
   */
  seniorAhead: bigint;
  snapshot: SnapshotRecord[];
  unavailable: { reason: string } | null;
  Fbuild: bigint;
  open: string | null;
  Fref: bigint;
  /** ⌊F_ref × 8%⌋ and the D-22 (a) cap (null: none this window); C = the lower */
  planCash: bigint;
  trancheCap: bigint | null;
  C: bigint;
  /** D-22 (c) */
  peg: XntPegV3;
  /** D-22 (a): this build's XDEX reading and the reserve capping this window */
  xdex: { atBuild: XdexReadingV3 | null; capReserve: string | null };
  /** D-22 (b) */
  xntPool: XntPoolV3;
  limit: bigint;
  alloc: ReturnType<typeof allocateBurns>;
  shortfall: CapacityV3["shortfall"];
  provisional: string | null;
}

export function windowStateV3(inputs: EpochInputsV3, prev?: AnyEpochFile | null, opts: WindowOptsV3 = {}): WindowStateV3 {
  const pv = prev ?? null;
  const inputProto = protoPath(inputs);
  if (inputProto) throw new Error(`inputs have a "__proto__" member at ${inputProto}`);
  const provisional = opts.provisional ?? null;
  // A13.4: a provisional file is never a previous file
  const pvProvisional = provisionalError(pv);
  if (pvProvisional) throw new Error(`the previous file: ${pvProvisional}`);
  const epoch = nat(inputs.epoch, "epoch");
  if (epoch < 1) throw new Error("epochs start at 1");
  if (!pv && epoch !== 1) throw new Error(`epoch-${epoch - 1}.json is required to build epoch ${epoch}`);
  if (pv && pv.epoch !== epoch - 1) throw new Error(`previous file is epoch ${pv.epoch}, expected ${epoch - 1}`);
  const p = prevState(pv);
  const v3FirstEpoch = p.version === 3 ? p.v3FirstEpoch! : epoch;
  const pinError = pinnedSwitchError(v3FirstEpoch);
  if (pinError) throw new Error(pinError);
  pubkey(inputs.programId, "programId");
  // T2-RULES: the rules block is checked first; a rules version never goes back (a change is a new rulesId, announced)
  const rulesBlock = rulesBlockOf(inputs.rulesBlock ?? DEFAULT_RULES_V3);
  if (p.rulesId !== null && rulesBlock.rulesId < p.rulesId) throw new Error(`rulesBlock.rulesId ${rulesBlock.rulesId} is below the previous file's ${p.rulesId}: a rules version never goes back`);
  const minVestEnt = BigInt(rulesBlock.dustRule.vestMinEnt);

  // window (§2, F2, A8): one clock. The end is the X1 block time of the snapshot slot, the start is epoch n−1's
  // on-chain publication; createdAt (the runner's clock) is provenance and only has to be near the end (B-2).
  const endTs = nat(inputs.window.endTs, "window.endTs");
  const created = isoSeconds(inputs.createdAt, "createdAt");
  if (Math.abs(created - endTs) > CLOCK_SKEW_MAX) {
    throw new Error(`build time ${inputs.createdAt} is more than ${CLOCK_SKEW_MAX} s from the window end ${endTs} (the snapshot slot's block time)`);
  }
  const startTs = nat(inputs.window.startTs, "window.startTs");
  if (pv) {
    // epoch n−1 was published after its own snapshot slot (X1's clock never runs backwards) and at most
    // MAX_PUBLISH_LAG later. A v2 file holds no X1 instant: its createdAt (the runner's clock) anchors the bound
    // with the clock tolerance (the live epoch 1 was published 1 s before its createdAt).
    const prevCreated = isoSeconds(pv.createdAt, `epoch-${pv.epoch}.json createdAt`); // R2-3 holds for the previous file too
    const prevEnd = pv.version === 3 ? nat(pv.window.endTs, `epoch-${pv.epoch}.json window.endTs`) : prevCreated;
    const slack = pv.version === 3 ? 0 : CLOCK_SKEW_MAX;
    // A12 (RE-1): only the lower bound is exact; a publication later than MAX_PUBLISH_LAG after its snapshot is reported
    // by verify --full on epoch n−1 and never blocks epoch n (the window start IS the on-chain published_at)
    if (!(prevEnd - slack <= startTs)) {
      throw new Error(`window start ${startTs} before the previous window end ${prevEnd}${slack ? ` − ${slack} s` : ""} (epoch ${pv.epoch}'s publication cannot precede its snapshot)`);
    }
    if (endTs - startTs < MIN_WINDOW && provisional === null) throw new Error(`window of ${endTs - startTs} s: shorter than ${MIN_WINDOW} s, it could never be published (MIN_EPOCH_INTERVAL)`);
  } else if (startTs !== endTs - WEEK) throw new Error("without a previous file the window starts one week before the build");
  const days = Math.max(1, Math.ceil((endTs - startTs) / DAY));

  const twap = uint(inputs.xnt.twapE18, "xnt.twapE18");
  const api = uint(inputs.xnt.apiE18, "xnt.apiE18");
  // D-22 (c): a USDC.X premium above 3% raises every pool reading (the TWAP and the candles) to the pool-safe price
  const peg = xntPegV3(twap, api);
  const pegF = BigInt(peg.factorE18);
  const pegged = (x: bigint) => (pegF === FP ? x : (x * pegF) / FP);
  const xBuild = max(pegged(twap), api);
  if (xBuild === 0n) throw new Error("no XNT price");
  const xdexAtBuild = xdexReadingOf(inputs.xdex, "xdex");
  const xFloor = p.x === null ? 0n : (p.x * XNT_FLOOR_BPS) / BPS;
  const switchRefs = applySwitchRefs(p, inputs.switchRefs);

  // valuation per chain (§3)
  const chainIds = new Set<number>();
  const chains: ChainRecordV3[] = [];
  const works: Work[] = [];
  const events = new Set<string>();
  const chainInputs = inputs.chains
    .map((c) => {
      if (nat(c.chainId, "chain id") === 0) throw new Error("chain id 0");
      nat(c.fromBlockExclusive, `chain ${c.chainId} fromBlockExclusive`);
      nat(c.toBlock, `chain ${c.chainId} toBlock`);
      return c;
    })
    .sort((a, b) => a.chainId - b.chainId);
  // D-21: the chains skipped this epoch for lack of an eligible market (each grows its run of skips)
  const noMarket = new Set((inputs.noMarket ?? []).map((x) => nat(x, "noMarket chain id")));
  for (const c of chainInputs) {
    if (chainIds.has(c.chainId)) throw new Error(`chain ${c.chainId} twice`);
    chainIds.add(c.chainId);
    if (noMarket.has(c.chainId)) throw new Error(`${c.name}: listed in noMarket and valued`);
    const pc = p.chains.get(c.chainId);
    if (pc && c.fromBlockExclusive !== pc.toBlock) throw new Error(`${c.name}: block cursor ${c.fromBlockExclusive} does not continue the previous epoch (${pc.toBlock})`);
    if (c.toBlock < c.fromBlockExclusive) throw new Error(`${c.name}: toBlock before fromBlock`);
    // D-21: an orphaned chain (announced by the previous record, from this epoch on) with still no market
    const orphan = c.orphan === true ? pc?.orphan ?? null : null;
    if (c.orphan === true && (!orphan || orphan.from > epoch)) throw new Error(`${c.name}: valued as orphaned, but the previous record announces no orphaning in force for epoch ${epoch} (D-21)`);
    if (c.orphan !== undefined && c.orphan !== true) throw new Error(`${c.name}: orphan is true or absent`);
    const refInputs = pc?.refInputs ?? [];
    const refUsd = uint(c.market.refUsdE18, `${c.name} refUsdE18`);
    const ref = orphan ? orphan.refE18 : medianE18(refInputs) || refUsd;
    const cap = (ref * PRICE_CAP_BPS) / BPS;
    const spotE18 = uint(c.market.spotE18, `${c.name} spotE18`);
    const Lnow = uint(c.liquidityNowMicro, `${c.name} liquidityNowMicro`);
    // D-13: the build's reading (min of GeckoTerminal and on-chain), the window's hourly samples and the pool's age
    const Lchain = optUint(c.liquidityOnChainMicro, `${c.name} liquidityOnChainMicro`);
    const poolCreatedAt = c.poolCreatedAt === undefined || c.poolCreatedAt === null ? null : nat(c.poolCreatedAt, `${c.name} poolCreatedAt`);
    const samples = liquiditySamplesV3(c.liquiditySamples, endTs, liquidityReadingV3(Lnow, Lchain), c.name);
    // T1-34: a failed totalSupply read is recorded as null with its reason, never as "0"
    const supply = totalSupplyOf(c.totalSupply, c.totalSupplyError, c.name);
    const burns = c.burns.map((b) => checkBurn(b, c.chainId, endTs)).sort(globalOrder);
    if (burns.length && ref === 0n) throw new Error(`${c.name}: burns but no price reference`);
    // X-010 / X-022: the recorded portal counters agree with the burns read and continue the previous record
    const missionsAt = optUint(c.missionsAt, `${c.name} missionsAt`, U64);
    const burnedAt = optUint(c.burnedAt, `${c.name} burnedAt`);
    const counters = countersErrorV3(burns, missionsAt, burnedAt, pc?.missionsAt ?? null, pc?.burnedAt ?? null);
    if (counters) throw new Error(`${c.name}: ${counters} (X-010)`);
    // D-12: the burns of a chain the previous file skipped (or did not list) stamped before the window start are its backlog
    const backlogChain = pv !== null && (pc === undefined || pc.skipped);
    const cw: Work[] = burns.map((b) => {
      const id = `${b.chainId}:${b.txHash}:${b.logIndex}`;
      if (!(b.blockNumber > c.fromBlockExclusive && b.blockNumber <= c.toBlock)) throw new Error(`burn ${id} outside the block range`);
      for (const k of [`${b.chainId}:${b.txHash}:${b.logIndex}`, `${b.chainId}:#${b.blockNumber}:${b.logIndex}`]) {
        if (events.has(k)) throw new Error(`duplicate burn event ${k}`);
        events.add(k);
      }
      // D-21: an orphaned chain's burn is valued at half the reference recorded at its orphaning (no market, no candle)
      if (orphan && (b.priceSource !== "orphan" || b.medianE18 !== "0" || b.lastCloseE18 !== "0")) throw new Error(`burn ${id}: a burn of an orphaned chain records priceSource "orphan" and no readings`);
      if (!orphan && b.priceSource === "orphan") throw new Error(`burn ${id}: priceSource "orphan" on a chain that is not orphaned`);
      const xen = orphan ? { priceE18: (orphan.refE18 * ORPHAN_PRICE_BPS) / BPS, rule: "orphan" as XenRule } : xenPrice(priceReadings(b.medianE18, b.lastCloseE18, b.priceSource, `burn ${id} XEN`), spotE18, cap);
      if (xen.priceE18 === 0n) throw new NoXenPriceError(c.chainId, id);
      const xntRead = priceReadings(b.xntMedianE18, b.xntLastCloseE18, b.xntSource, `burn ${id} XNT`);
      // D-22 (c): the pool's readings at the pool-safe price when USDC.X reads above the peg band
      const xntReadings: [bigint, bigint] | null = xntRead === null ? null : [pegged(xntRead[0]), pegged(xntRead[1])];
      const xnt = xntPrice(xntReadings, xBuild, xFloor);
      const op = operatorOfV3(rulesBlock.operatorWallets, b.x1, b.timestamp);
      return {
        ...allocItem(b.tier, dayOf(b.timestamp, startTs), 0n, 0n), b, priceE18: xen.priceE18, priceRule: xen.rule, x: xnt.xE18, xntRule: xnt.rule,
        xMedian: xntReadings === null ? xBuild : xntReadings[0],
        hour: Math.floor(b.timestamp / HOUR), spot: spotMicro(BigInt(b.amountWei), xen.priceE18), value: 0n, base: 0n, ent: 0n,
        backlog: backlogChain && b.timestamp < startTs, operator: op.operator, exception: op.exception,
      };
    });
    const prevL = pc?.L ?? null;
    // D-13 + option (a): this window's L was frozen at epoch n−1's build; this build freezes the next window's
    const stat = liquidityStatV3(samples, endTs);
    const lr = liquidityRuleV3(pc ? { L: pc.L, next: pc.next, v2: pc.v2 } : null, pv !== null, stat, firstLiquidityCapV3(poolCreatedAt, startTs));
    const L = lr.used;
    const next = nextLiquidityV3(stat, L);
    const start = pc?.curve ?? { S: 0n, hour: cw.length ? cw[0].hour : 0 };
    const run = runCurve(cw, L, start);
    cw.forEach((w, i) => (w.value = run.values[i]));
    works.push(...cw);
    chains.push({
      chainId: c.chainId, name: c.name, portal: c.portal, fromBlockExclusive: c.fromBlockExclusive, toBlock: c.toBlock, skipped: false,
      market: c.market, ...supply, missionsAt: missionsAt === null ? null : missionsAt.toString(), burnedAt: burnedAt === null ? null : burnedAt.toString(),
      L: {
        now: Lnow.toString(), onChain: Lchain === null ? null : Lchain.toString(), prev: prevL === null ? null : prevL.toString(), used: L.toString(), rule: lr.rule,
        stat: stat.toString(), next: next.toString(), cap: lr.cap === null ? null : lr.cap.toString(),
      },
      liquiditySamples: (Array.isArray(c.liquiditySamples) ? c.liquiditySamples : []).map((s) => ({ hour: s.hour, micro: s.micro })), poolCreatedAt,
      // D-21: valued on a market again: the run of skips ends and the orphaning is lifted; valued as orphaned: both carried
      noMarketRun: orphan && pc!.noMarketRun ? { skips: pc!.noMarketRun.skips, refE18: pc!.noMarketRun.refE18.toString() } : null,
      orphan: orphan ? { refE18: orphan.refE18.toString(), from: orphan.from } : null,
      refInputs: refInputs.map(String), ref: ref.toString(), priceCapE18: cap.toString(), xenUsdE18: min(spotE18, cap).toString(),
      curveBefore: { S: start.S.toString(), hour: start.hour }, curveAfter: { S: run.after.S.toString(), hour: run.after.hour },
    });
  }
  // a chain without market data this epoch keeps its state (cursor, L, curve); its reference reading is "0"
  for (const id of noMarket) if (!p.chains.has(id)) throw new Error(`noMarket lists chain ${id}, which no previous record carries`);
  for (const pc of [...p.chains.values()].sort((a, b) => a.chainId - b.chainId)) {
    if (chainIds.has(pc.chainId)) continue;
    const ref = medianE18(pc.refInputs);
    const curveState = { S: pc.curve.S.toString(), hour: pc.curve.hour };
    // D-21: a skip for lack of a market grows the run (a read failure leaves it as it is); the record that reaches
    // ORPHAN_SKIPS announces the orphaning from the next epoch, at half of the reference it then has
    const run = noMarket.has(pc.chainId) ? { skips: (pc.noMarketRun?.skips ?? 0) + 1, refE18: pc.noMarketRun?.refE18 ?? ref } : pc.noMarketRun;
    const orph = pc.orphan ?? (run && run.skips >= ORPHAN_SKIPS && run.refE18 > 0n ? { refE18: run.refE18, from: epoch + 1 } : null);
    chains.push({
      chainId: pc.chainId, name: pc.name, portal: pc.portal, fromBlockExclusive: pc.toBlock, toBlock: pc.toBlock, skipped: true,
      market: null, totalSupply: pc.totalSupply, ...(pc.totalSupplyError !== undefined ? { totalSupplyError: pc.totalSupplyError } : {}),
      missionsAt: pc.missionsAt === null ? null : pc.missionsAt.toString(), burnedAt: pc.burnedAt === null ? null : pc.burnedAt.toString(),
      // D-13: nothing is valued, so the frozen L is kept for the next window (a record without one freezes its L)
      L: {
        now: null, onChain: null, prev: pc.L === null ? null : pc.L.toString(), used: pc.L === null ? null : pc.L.toString(), rule: "carried", stat: null,
        next: pc.next !== undefined && pc.next !== null ? pc.next.toString() : pc.L === null ? null : pc.L.toString(), cap: null,
      },
      liquiditySamples: [], poolCreatedAt: null,
      noMarketRun: run ? { skips: run.skips, refE18: run.refE18.toString() } : null, orphan: orph ? { refE18: orph.refE18.toString(), from: orph.from } : null,
      refInputs: pc.refInputs.map(String), ref: ref.toString(), priceCapE18: ((ref * PRICE_CAP_BPS) / BPS).toString(), xenUsdE18: "0",
      curveBefore: curveState, curveAfter: curveState,
    });
  }
  chains.sort((a, b) => a.chainId - b.chainId);

  // D-12 / D-18: the arrival order is the global order of the window's burns, then the backlog, then the operator burns
  // (both claim at the window's end: the day of endTs + CLOCK_SKEW_MAX, at or after every burn of the window); the plan
  // pays the window's burns and the backlog first (the leftover: the backlog first), and only then the operator burns
  works.sort((a, b) => globalOrder(a.b, b.b));
  const ranked = rankOrderV3(works);
  works.splice(0, works.length, ...ranked.arrival);
  const plan = ranked.plan;
  const lateDay = dayOf(endTs + CLOCK_SKEW_MAX, startTs);
  for (const w of works) if (rankClassV3(w) !== 0) w.day = lateDay;
  // entitlement (§4, A1): each burn at its own XNT price
  for (const w of works) {
    w.base = lamportsOf(w.value, w.x);
    w.lp = (w.base * K_BPS) / BPS;
    w.ent = (w.base * K_BPS * TIER_MULTIPLIER[w.b.tier]) / BPS;
    w.band = w.ent - w.lp;
  }
  const xRef = xntReference(works.map((w) => ({ weight: w.value, xE18: w.xMedian }))) ?? max(xBuild, xFloor);

  // capacity (§6, A2, A13.1): C is fixed by F_ref, the pool at the week's start, and is the whole 8% of it. The
  // snapshot is checked and recorded for the extra pot; nothing below reads it: the base pot never depends on any
  // Artifact, so a holder and a non-holder get the same allocation for the same burn
  // A13.9 (review R2): when the records could not be read (or one was refused) the snapshot is recorded empty with the
  // reason; nothing below changes, because nothing below reads it
  const unavailable = snapshotUnavailableOf(inputs.snapshot);
  const snapshot = unavailable ? [] : checkSnapshot(inputs.snapshot.records);
  nat(inputs.snapshot.slot, "snapshot.slot");
  const Fbuild = uint(inputs.freePool.lamports, "freePool.lamports", U64);
  nat(inputs.freePool.slot, "freePool.slot");
  const open = inputs.freePool.open ?? null;
  if (pv && open === null) throw new Error("freePool.open (the free pool right after epoch n−1 was published) is required");
  if (!pv && open !== null) throw new Error("freePool.open must be null without a previous epoch");
  const Fref = open === null ? Fbuild : uint(open, "freePool.open", U64);
  const planCash = (Fref * PLAN_BPS) / BPS;
  // D-22 (a): never more than 7 daily tranches of 2% of the XDEX XNT reserve read at the week start (epoch n−1's build)
  const trancheCap = trancheCapV3(p.capReserve);
  const C = trancheCap === null ? planCash : min(planCash, trancheCap);

  // allocation (§5.2–5.6, A9, A12, A13.2) at the quoted capacity C, with the build limit consulted claim by claim: Σ score
  // + keeper tips must fit in 10% of the free pool at build less the rebuild drift and the D-47 oracle allowance (§7).
  // When the plan does not fit (shortfall), the claims are cut LITERALLY from the latest one backwards (A13.2,
  // OWNER-A12-1): the leftover top-ups
  // (the window's last claims) first, then the arrival claims from the last burn back; the first claim that does not fit
  // takes the room left and every later claim is 0. C itself and every daily tranche stay as quoted, so no later burn,
  // of any tier, can lower what an earlier burn is paid at its arrival.
  const limit = buildLimit(Fbuild);
  const a = allocateBurns(works, C, minVestEnt, opts.limit === false ? undefined : limitGate(limit, (i) => works[i].b.x1), plan);
  /** what FCFS at C would pay with nothing cut (the plan), recorded with a cut: Σ alloc is what is paid */
  const planned = () => {
    const shadow = works.map((w) => allocItem(w.tier, w.day, w.lp, w.band));
    const r = allocateBurns(shadow, C, minVestEnt, undefined, plan);
    return r.base + r.bandPaid;
  };
  const shortfall: CapacityV3["shortfall"] =
    a.cut === null ? null : { stage: a.cut.stage, kept: a.cut.kept, wanted: a.cut.wanted.toString(), claim: a.cut.claim.toString(), planned: planned().toString() };
  const seniorAhead = works.reduce((s, w) => (rankClassV3(w) === 0 ? s + w.senior : s), 0n);
  return {
    epoch, v3FirstEpoch, prevDataHash: p.dataHash, startTs, endTs, days, twap, api, xBuild, xFloor, prevX: p.x, xRef, switchRefs, rulesBlock, chains, works,
    plan, seniorAhead, snapshot, unavailable, Fbuild, open, Fref, planCash, trancheCap, C, peg,
    xdex: { atBuild: xdexAtBuild, capReserve: p.capReserve === null ? null : p.capReserve.toString() }, xntPool: xntPoolRecordV3(p.xntPool, inputs.xntPools), limit, alloc: a, shortfall, provisional,
  };
}

/** T1-34: a recorded totalSupply: a canonical integer, or null with the reason of the failed read (never "0" for a failure). */
function totalSupplyOf(v: unknown, err: unknown, what: string): { totalSupply: string | null; totalSupplyError?: string } {
  if (v === null) {
    if (typeof err !== "string") throw new Error(`${what}: a totalSupply of null records why the read failed (totalSupplyError)`);
    return { totalSupply: null, totalSupplyError: reasonLineOf(err) };
  }
  if (err !== undefined) throw new Error(`${what}: totalSupplyError is recorded only with a totalSupply of null`);
  uint(v, `${what} totalSupply`);
  return { totalSupply: v as string };
}

/** Builds the v3 body, or null when nothing would be paid (T = 0: nothing is published, prev stays). */
export function computeEpochV3(inputs: EpochInputsV3, prev?: AnyEpochFile | null, opts: ComputeOptsV3 = {}): EpochBodyV3 | null {
  // the build always consults the build limit, whatever the caller passes
  const {
    epoch, v3FirstEpoch, prevDataHash, startTs, endTs, days, twap, api, xBuild, xFloor, prevX, xRef, switchRefs, rulesBlock, chains, works,
    snapshot, unavailable, Fbuild, open, Fref, planCash, trancheCap, C, peg, xdex, xntPool, limit, alloc: a, shortfall, provisional,
  } = windowStateV3(inputs, prev, { provisional: opts.provisional ?? null, limit: true });
  // targets: the locked piece on the burn's tier, the Launchpad piece on tier 0; nothing else is added to any leaf (A13.1)
  const sums = new Map<string, bigint>();
  const add = (player: string, tier: number, v: bigint) => {
    if (v > 0n) sums.set(leafKey(player, tier), (sums.get(leafKey(player, tier)) ?? 0n) + v);
  };
  for (const w of works) {
    add(w.b.x1, w.leafTier, w.lockedLp + w.bandPaid);
    add(w.b.x1, 0, w.basePaid - w.lockedLp);
  }
  const targets: TargetV3[] = [...sums.entries()]
    .map(([k, v]) => {
      const i = k.lastIndexOf(":");
      return { player: k.slice(0, i), tier: Number(k.slice(i + 1)), target: v.toString() };
    })
    .sort((t1, t2) => cmpStr(t1.player, t2.player) || t1.tier - t2.tier);
  const enc = encodeLeaves(targets);
  // round 4: nothing to pay is null (nothing published, the window grows), unless the caller asks for the heartbeat and
  // the window valued no burn at all (ComputeOptsV3.heartbeat); a provisional preview is never a heartbeat
  const heartbeat = enc.T === 0n && opts.heartbeat === true && works.length === 0 && provisional === null;
  if (enc.T === 0n && !heartbeat) return null;

  // post-conditions: they hold by construction for valid inputs, so a breach means bad inputs or a bug
  const paidFromC = works.reduce((s, w) => s + w.basePaid + w.bandPaid, 0n);
  for (const w of works) {
    if (w.value < 0n || w.value > w.spot || w.basePaid < 0n || w.bandPaid < 0n) throw new Error(`burn ${w.b.chainId}:${w.b.txHash}:${w.b.logIndex}: allocation out of bounds`);
  }
  if (paidFromC > C) throw new Error("burners received more than the cash capacity");
  if (enc.T !== paidFromC) throw new Error("targets are not exactly the burners' allocations");
  if (plannedOutflow(enc.leaves.map((l) => BigInt(l.score)), enc.totalScore) > limit) throw new Error("cannot fit the epoch within the build limit");
  // a heartbeat has no tree: forge.rs epoch_shape wants the all-zero root, total 0 and rate cap 0
  const tree = heartbeat ? { root: HEARTBEAT_ROOT, totalScore: "0" } : buildTree(epoch, enc.leaves);

  return {
    version: 3,
    programId: inputs.programId,
    epoch,
    createdAt: inputs.createdAt,
    v3FirstEpoch,
    prevDataHash,
    kBps: Number(K_BPS),
    rulesBlock,
    window: { startTs, endTs, days, dayOrigin: startTs },
    freePool: { lamports: Fbuild.toString(), slot: inputs.freePool.slot, open: open === null ? null : Fref.toString(), ref: Fref.toString() },
    xnt: {
      twapE18: twap.toString(), apiE18: api.toString(), source: inputs.xnt.source, buildE18: xBuild.toString(),
      prevE18: prevX === null ? null : prevX.toString(), floorE18: xFloor.toString(), usdE18: xRef.toString(), peg,
    },
    xdex,
    sidecar: sidecarRefOf(inputs.sidecar, epoch),
    noMarket: [...new Set(inputs.noMarket ?? [])].sort((x, y) => x - y),
    xntPool,
    xntPoolReadings: [...(inputs.xntPools ?? [])].map((r) => ({ pool: r.pool, tvlMicro: r.tvlMicro })).sort((x, y) => cmpStr(x.pool, y.pool)),
    switchRefs,
    capacity: {
      // tranche: the daily release applied (RE-5), ⌊C/7⌋: a shortfall never cuts the schedule (A13.2)
      cash: C.toString(), planCash: planCash.toString(), trancheCap: trancheCap === null ? null : trancheCap.toString(),
      tranche: (C / BigInt(EPOCH_DAYS)).toString(), senior: a.senior.toString(),
      base: a.base.toString(), bandTotal: a.bandTotal.toString(), bandPaid: a.bandPaid.toString(), left: a.left.toString(),
      lockedMissions: a.locked, splitMissions: a.split, convertedMissions: a.converted, shortfall,
    },
    chains,
    snapshot: { slot: inputs.snapshot.slot, records: snapshot, ...(unavailable ? { unavailable } : {}) },
    burns: works.map((w) => ({
      chainId: w.b.chainId, txHash: w.b.txHash, logIndex: w.b.logIndex, blockNumber: w.b.blockNumber, missionId: w.b.missionId, pilot: w.b.pilot,
      amountWei: w.b.amountWei, tier: w.b.tier, x1: w.b.x1, timestamp: w.b.timestamp,
      medianE18: w.b.medianE18, lastCloseE18: w.b.lastCloseE18, priceSource: w.b.priceSource, priceE18: w.priceE18.toString(), priceRule: w.priceRule,
      xntMedianE18: w.b.xntMedianE18, xntLastCloseE18: w.b.xntLastCloseE18, xntSource: w.b.xntSource, xntE18: w.x.toString(), xntRule: w.xntRule,
      hour: w.hour, day: w.day, backlog: w.backlog, operator: w.operator, exception: w.exception, spotMicro: w.spot.toString(), valueMicro: w.value.toString(),
      base: w.base.toString(), lp: w.lp.toString(), ent: w.ent.toString(), band: w.band.toString(), senior: w.senior.toString(),
      basePaid: w.basePaid.toString(), bandPaid: w.bandPaid.toString(), alloc: (w.basePaid + w.bandPaid).toString(),
      lockedLp: w.lockedLp.toString(), launchpadPaid: (w.basePaid - w.lockedLp).toString(), split: w.lockedLp > 0n && w.lockedLp < w.lp,
      converted: w.converted, leafTier: w.leafTier,
    })),
    targets,
    leaves: enc.leaves,
    totalScore: tree.totalScore,
    root: tree.root,
    rateCap: heartbeat ? "0" : "1",
    ...(heartbeat ? { heartbeat: true as const } : {}),
    ...(provisional !== null ? { provisional: { reason: provisional, publishable: false as const } } : {}),
  };
}

/** The proofs of a v3 body: none for a heartbeat (no leaf), else the tree's (epoch.ts buildTree refuses an empty tree). */
export function proofsOfV3(body: { epoch: number; leaves: Leaf[]; heartbeat?: true }): Record<string, string[]> {
  return body.heartbeat === true ? {} : buildTree(body.epoch, body.leaves).proofs;
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    // no prototype: a "__proto__" key stays an own member instead of silently setting the prototype (R2-4)
    const o: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(v as object).sort()) o[k] = canonical((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

const canonicalJson = (v: unknown) => JSON.stringify(canonical(v));

/** sha256 of the canonical JSON of the whole body (everything except dataHash, proofs and publish). */
export function dataHashV3(f: EpochBodyV3): string {
  const { dataHash: _h, proofs: _p, publish: _u, ...body } = f as EpochFileV3;
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export function buildEpochFileV3(inputs: EpochInputsV3, prev?: AnyEpochFile | null, opts: ComputeOptsV3 = {}): EpochFileV3 | null {
  const body = computeEpochV3(inputs, prev, opts);
  if (!body) return null;
  return { ...body, dataHash: dataHashV3(body), proofs: proofsOfV3(body) };
}

/** The recorded inputs of a v3 file (what computeEpochV3 consumed). */
export function inputsOf(f: EpochBodyV3): EpochInputsV3 {
  return {
    programId: f.programId,
    epoch: f.epoch,
    createdAt: f.createdAt,
    window: { startTs: f.window.startTs, endTs: f.window.endTs },
    chains: f.chains
      .filter((c) => !c.skipped)
      .map((c) => ({
        chainId: c.chainId, name: c.name, portal: c.portal, fromBlockExclusive: c.fromBlockExclusive, toBlock: c.toBlock,
        market: c.market as MarketV3, liquidityNowMicro: c.L.now ?? "0", totalSupply: c.totalSupply,
        ...(c.totalSupplyError !== undefined ? { totalSupplyError: c.totalSupplyError } : {}),
        missionsAt: c.missionsAt, burnedAt: c.burnedAt,
        // D-13 (a file written before D-13 has none of them, and so fails verification under this engine)
        liquidityOnChainMicro: c.L.onChain ?? null, liquiditySamples: c.liquiditySamples ?? [], poolCreatedAt: c.poolCreatedAt ?? null,
        // D-21: a valued record that keeps an orphaning was valued as orphaned
        ...(c.orphan ? { orphan: true as const } : {}),
        burns: f.burns
          .filter((b) => b.chainId === c.chainId)
          .map((b) => ({
            chainId: b.chainId, txHash: b.txHash, logIndex: b.logIndex, blockNumber: b.blockNumber, missionId: b.missionId, pilot: b.pilot,
            amountWei: b.amountWei, tier: b.tier, x1: b.x1, timestamp: b.timestamp, medianE18: b.medianE18, lastCloseE18: b.lastCloseE18,
            priceSource: b.priceSource, xntMedianE18: b.xntMedianE18, xntLastCloseE18: b.xntLastCloseE18, xntSource: b.xntSource,
          })),
      })),
    snapshot: f.snapshot,
    freePool: { lamports: f.freePool.lamports, slot: f.freePool.slot, open: f.freePool.open },
    xnt: { twapE18: f.xnt.twapE18, apiE18: f.xnt.apiE18, source: f.xnt.source },
    switchRefs: f.switchRefs,
    // a v3 file without the block (written before T2-RULES) is recomputed under the default and so fails verification
    rulesBlock: f.rulesBlock,
    xdex: f.xdex?.atBuild ?? null,
    sidecar: f.sidecar ?? null,
    noMarket: f.noMarket ?? [],
    // D-22 (b): the candidates' TVL readings of this build
    xntPools: f.xntPoolReadings ?? [],
  };
}

/** D-23: the sidecar file of epoch n, next to epoch-<n>.json */
export const sidecarFileV3 = (epoch: number) => `epoch-${epoch}.prices.json`;

/** D-23: a recorded sidecar reference, checked (a file name of this form and a sha256), or null. */
export function sidecarRefOf(v: unknown, epoch?: number): PriceSidecarRefV3 | null {
  if (v === undefined || v === null) return null;
  const o = exactKeys(v, ["file", "sha256"], "sidecar");
  if (typeof o.file !== "string" || !/^epoch-[1-9][0-9]*\.prices\.json$/.test(o.file)) throw new Error(`sidecar.file ${JSON.stringify(o.file)} is not epoch-<n>.prices.json`);
  if (epoch !== undefined && o.file !== sidecarFileV3(epoch)) throw new Error(`sidecar.file ${o.file} is not this epoch's (${sidecarFileV3(epoch)})`);
  if (typeof o.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.sha256)) throw new Error("sidecar.sha256 is not a lowercase sha256 hex");
  return { file: o.file, sha256: o.sha256 };
}

// ── verification (§10) ─────────────────────────────────────────────────────────────────────────
export function verifyEpochV3(f: EpochFileV3, prev?: AnyEpochFile | null): string[] {
  const errors: string[] = [];
  const pv = prev ?? null;
  try {
    if (f.version !== 3) return [`not a v3 file (version ${String((f as { version?: unknown }).version)})`];
    const proto = protoPath(f);
    if (proto) return [`the file has a "__proto__" member at ${proto}`];
    const retired = retiredBaseTerms(f);
    if (retired.length) return [`the file carries retired base terms (${retired.join(", ")}): a v3 base file has no Forge Right ledger, lane, boost or drop policy (A13.1)`];
    const provisional = provisionalError(f);
    if (provisional) return [provisional];
    if (provisionalError(pv)) return [`the previous file: ${provisionalError(pv)}`];
    const pinError = pinnedSwitchError(f.v3FirstEpoch);
    if (pinError) errors.push(pinError);
    if (!pv) {
      if (f.epoch !== 1) errors.push(`epoch-${f.epoch - 1}.json is required to verify a v3 epoch`);
    } else {
      if (pv.epoch !== f.epoch - 1) errors.push(`previous file is epoch ${pv.epoch}, expected ${f.epoch - 1}`);
      if (pv.version === 2) {
        if (f.v3FirstEpoch !== f.epoch) errors.push(`a v3 file may follow a v2 file only at the switch epoch (v3FirstEpoch ${f.v3FirstEpoch})`);
        if (dataHashV2(pv) !== pv.dataHash) errors.push("the previous (v2) file does not match its data hash");
      } else if (pv.version === 3) {
        const retired = retiredBaseTerms(pv);
        if (retired.length) errors.push(`the previous v3 file carries retired base terms (${retired.join(", ")}): not a two-pot base file (A13.1)`);
        if (f.v3FirstEpoch !== pv.v3FirstEpoch) errors.push("v3FirstEpoch differs from the previous file");
        if (dataHashV3(pv) !== pv.dataHash) errors.push("the previous file does not match its data hash");
      } else errors.push(`unknown version of the previous file`);
      if (f.prevDataHash !== pv.dataHash) errors.push("prevDataHash does not match the previous file");
    }
    if (errors.length) return errors;

    // round 4: a file marked as a heartbeat is recomputed as one (the recomputation is a heartbeat only when the window
    // valued no burn; a heartbeat that swallowed a valued burn recomputes as null or as a paying body, and fails)
    const hb = isHeartbeatV3(f);
    if ((f as { heartbeat?: unknown }).heartbeat !== undefined && !hb) errors.push("heartbeat is true or absent");
    const body = computeEpochV3(inputsOf(f), pv, { heartbeat: hb });
    if (!body) errors.push(hb ? "a heartbeat over a window with a valued burn: that burn is never consumed by an epoch that pays nothing" : "recomputation gives an empty epoch: nothing should have been published");
    else {
      const keys = new Set([...Object.keys(body), ...Object.keys(f)].filter((k) => k !== "dataHash" && k !== "proofs" && k !== "publish"));
      for (const k of [...keys].sort()) {
        if (canonicalJson((body as unknown as Record<string, unknown>)[k]) !== canonicalJson((f as unknown as Record<string, unknown>)[k])) errors.push(`${k} does not match the recomputation`);
      }
    }
    if (BigInt(f.capacity.cash) > (BigInt(f.freePool.ref) * PLAN_BPS) / BPS) errors.push("capacity above 8% of F_ref");
    // I1 and I9 checked on the published numbers, independently of the encoder
    const TS = BigInt(f.totalScore);
    const scores = f.leaves.map((l) => BigInt(l.score));
    if (scores.reduce((s, x) => s + x, 0n) !== TS) errors.push("totalScore is not the sum of the leaf scores");
    if (plannedOutflow(scores, TS) > buildLimit(BigInt(f.freePool.lamports))) errors.push("total score plus keeper tips above 10% of the free pool less the rebuild drift and the oracle allowance");
    if (f.targets.length !== f.leaves.length) errors.push("leaves and targets differ in number");
    else {
      const { claims } = programClaims(scores, TS, TS * 10n);
      f.targets.forEach((t, i) => {
        const l = f.leaves[i];
        if (l.player !== t.player || l.tier !== t.tier) errors.push(`leaf ${i} (${l.player}:${l.tier}) is not target ${i} (${t.player}:${t.tier})`);
        else if (claims[i] < BigInt(t.target)) errors.push(`I9 broken: ${t.player}:${t.tier} claims ${claims[i]} < target ${t.target}`);
      });
    }
    if (hb) {
      // forge.rs epoch_shape: exactly total 0, no leaf, rate cap 0 and the all-zero root (anything else is EmptyEpoch)
      if (f.rateCap !== "0") errors.push("a heartbeat's rateCap must be 0");
      if (TS !== 0n || f.leaves.length || f.targets.length || f.burns.length) errors.push("a heartbeat has no burn, no target, no leaf and a total score of 0");
      if (f.root !== HEARTBEAT_ROOT) errors.push("a heartbeat's root must be 32 zero bytes");
      if (canonicalJson(f.proofs ?? null) !== "{}") errors.push("a heartbeat has no proofs");
    } else {
      if (f.rateCap !== "1") errors.push("rateCap must be 1");
      const t = buildTree(f.epoch, f.leaves);
      if (t.root !== f.root) errors.push(`root mismatch: computed ${t.root}`);
      if (canonicalJson(t.proofs) !== canonicalJson(f.proofs)) errors.push("proofs do not match the leaves");
    }
    const h = dataHashV3(f);
    if (h !== f.dataHash) errors.push(`dataHash mismatch: computed ${h}`);
  } catch (e) {
    errors.push(`verification aborted: ${(e as Error).message}`);
  }
  return errors;
}

// ── D-17: the anomaly gate (published thresholds: rulesBlock.priceRules.gate) ─────────────────────────────
/** One reason the gate holds an epoch: a stable code and the numbers behind it. */
export interface GateReasonV3 {
  code: "wallet-share" | "leaf-count" | "score-jump" | "fallback-share" | "first-chain" | "xnt-source";
  text: string;
}

/**
 * D-17 (CF-44): the published thresholds a built v3 epoch is checked against before it is sent (pure). Any hit holds the
 * publication up to GATE_HOLD_SECONDS (24 h), then it is released with a rebuild unless GATE_BLOCK is set (flow-v3.ts
 * gateDecisionV3). The checks:
 *  - wallet-share: one X1 wallet's targets above 60% of the week's capacity C;
 *  - leaf-count: more than 5× the median leaf count of the last (up to) 4 published files (v2 or v3);
 *  - score-jump: a total score above 3× the median of the last (up to) 4 v3 files (lamports: v2 scores are not comparable);
 *  - fallback-share: more than 50% of the burns priced at the cap or the build spot (XEN), or at the floor or the build price (XNT);
 *  - first-chain: a burn on a chain the previous file does not list (a chain's first epoch);
 *  - xnt-source: the XNT price source differs from the previous v3 file's (its first source), or the USDC.X guard reads a depeg.
 * `history` = the previous published files, most recent first (only the last GATE_HISTORY_EPOCHS are read).
 */
export function anomalyGateV3(f: EpochBodyV3, prev: AnyEpochFile | null, history: AnyEpochFile[]): GateReasonV3[] {
  const out: GateReasonV3[] = [];
  const C = BigInt(f.capacity.cash);
  const byWallet = new Map<string, bigint>();
  for (const t of f.targets) byWallet.set(t.player, (byWallet.get(t.player) ?? 0n) + BigInt(t.target));
  for (const [w, v] of [...byWallet.entries()].sort((a, b) => cmpStr(a[0], b[0]))) {
    if (C > 0n && v * BPS > C * BigInt(GATE_WALLET_SHARE_BPS)) out.push({ code: "wallet-share", text: `wallet ${w} takes ${v} of the capacity ${C} lamports (more than ${GATE_WALLET_SHARE_BPS / 100}%)` });
  }
  const recent = history.slice(0, GATE_HISTORY_EPOCHS);
  const leafCounts = recent.map((h) => BigInt(h.leaves.length)).filter((x) => x > 0n);
  if (leafCounts.length) {
    const m = medianWithZeros(leafCounts);
    if (BigInt(f.leaves.length) > BigInt(GATE_LEAF_COUNT_X) * m) out.push({ code: "leaf-count", text: `${f.leaves.length} leaves, more than ${GATE_LEAF_COUNT_X}× the median ${m} of the last ${leafCounts.length} epochs` });
  }
  const scores = recent.filter((h) => h.version === 3).map((h) => BigInt(h.totalScore)).filter((x) => x > 0n);
  if (scores.length) {
    const m = medianWithZeros(scores);
    if (BigInt(f.totalScore) > BigInt(GATE_SCORE_X) * m) out.push({ code: "score-jump", text: `total score ${f.totalScore}, more than ${GATE_SCORE_X}× the median ${m} of the last ${scores.length} v3 epochs` });
  }
  if (f.burns.length) {
    const fb = f.burns.filter((b) => b.priceRule === "cap" || b.priceRule === "spot" || b.xntRule === "floor" || b.xntRule === "build").length;
    if (fb * Number(BPS) > f.burns.length * GATE_FALLBACK_SHARE_BPS) out.push({ code: "fallback-share", text: `${fb} of ${f.burns.length} burns priced at a clamp or a fallback (more than ${GATE_FALLBACK_SHARE_BPS / 100}%)` });
  }
  const listed = new Set((prev?.chains ?? []).map((c) => c.chainId));
  for (const id of [...new Set(f.burns.map((b) => b.chainId))].sort((a, b) => a - b)) {
    if (!listed.has(id)) out.push({ code: "first-chain", text: `chain ${id}: its first epoch (the previous file does not list it)` });
  }
  const firstSource = (s: string) => s.split(";")[0].trim();
  if (prev && prev.version === 3 && firstSource(prev.xnt.source) !== firstSource(f.xnt.source)) {
    out.push({ code: "xnt-source", text: `the XNT price source changed: "${firstSource(prev.xnt.source)}" → "${firstSource(f.xnt.source)}"` });
  }
  if (f.xnt.peg.guard === "high" || f.xnt.peg.guard === "low") out.push({ code: "xnt-source", text: `the USDC.X guard reads ${f.xnt.peg.usdcxUsdE18} USD per USDC.X (${f.xnt.peg.guard}, D-22 c)` });
  const prevPool = prev && prev.version === 3 ? (prev as { xntPool?: XntPoolV3 }).xntPool : undefined;
  if (prevPool && prevPool.active !== f.xntPool.active) out.push({ code: "xnt-source", text: `the XNT price pool switched: ${prevPool.active} → ${f.xntPool.active} (D-22 b)` });
  return out;
}

/** Dispatcher: v2 files verify forever with the v2 rules; versions never go backwards. */
export function verifyAny(f: AnyEpochFile, prev?: AnyEpochFile | null): string[] {
  const v = (f as { version?: unknown }).version;
  if (v !== 2 && v !== 3) return [`unknown epoch file version ${String(v)}`];
  if (prev) {
    const pv = (prev as { version?: unknown }).version;
    if (pv !== 2 && pv !== 3) return [`unknown version ${String(pv)} of the previous file`];
    if (pv > v) return [`version went backwards: epoch ${prev.epoch} is v${pv}, epoch ${f.epoch} is v${v}`];
  }
  if (f.version === 2) return verifyEpochFile(f, (prev as EpochFile | null) ?? undefined);
  return verifyEpochV3(f, prev);
}

// ── --full checks against the chain (the plumbing reads the accounts; the rules live here) ─────────
/** This epoch's publication: the EpochPublished event, plus the Epoch account fields when read. */
export interface PublishedEpochV3 {
  /** EpochPublished.epoch */
  epoch: number | bigint;
  /** EpochPublished.root and .data_hash (32 bytes, or their hex) */
  root: string | Uint8Array;
  dataHash: string | Uint8Array;
  /** EpochPublished.leaves */
  leaves: number;
  /** EpochPublished.budget: the FULL budget, drop reserve included */
  budget: bigint;
  /** EpochPublished.drop_reserve */
  dropReserve: bigint;
  /** EpochPublished.total_score */
  totalScore: bigint;
  /** EpochPublished.free_pool_before */
  freePoolBefore?: bigint;
  /** Epoch account .rate_cap */
  rateCap?: bigint;
  /** Epoch account .budget, which is NET of drop_reserve */
  netBudget?: bigint;
  /** Epoch account .published_at */
  publishedAt?: number;
}

/**
 * The publication must be this file (epoch, root, data hash, leaf count), and the on-chain budget must be exactly
 * totalScore, otherwise the 10% cap cut every claim below its target (I9).
 */
export function verifyPublishedV3(f: EpochFileV3, ev: PublishedEpochV3): string[] {
  const errors: string[] = [];
  const hex = (x: string | Uint8Array) => (typeof x === "string" ? x.toLowerCase().replace(/^0x/, "") : Buffer.from(x).toString("hex"));
  if (BigInt(ev.epoch) !== BigInt(f.epoch)) errors.push(`on-chain epoch ${ev.epoch} is not the file's epoch ${f.epoch}`);
  if (hex(ev.root) !== f.root) errors.push(`on-chain root ${hex(ev.root)} is not the file's root ${f.root}`);
  if (hex(ev.dataHash) !== f.dataHash) errors.push(`on-chain data hash ${hex(ev.dataHash)} is not the file's ${f.dataHash}`);
  if (ev.leaves !== f.leaves.length) errors.push(`on-chain leaf count ${ev.leaves} is not the file's ${f.leaves.length}`);
  const ts = BigInt(f.totalScore);
  if (ev.totalScore !== ts) errors.push("on-chain total score differs");
  if (ev.budget !== ts) errors.push("I9 broken: the on-chain budget is not totalScore (budget capped by the free pool)");
  // A13.1: the upgraded program writes drop_reserve = 0 for every epoch; a reserve means an older binary published the
  // file, and every claim is cut by it below its target
  if (ev.dropReserve !== 0n) errors.push("I9 broken: a drop reserve on a v3 epoch (the v3 base has no drop reserve: the program was not upgraded)");
  if (ev.netBudget !== undefined && ev.netBudget !== ev.budget - ev.dropReserve) errors.push("Epoch account budget != event budget − drop reserve");
  // round 4: a heartbeat is published with rate cap 0 (forge.rs epoch_shape), every paying v3 epoch with 1
  const cap = isHeartbeatV3(f) ? 0n : 1n;
  if (ev.rateCap !== undefined && ev.rateCap !== cap) errors.push(`on-chain rate cap is not ${cap}`);
  if (ev.freePoolBefore !== undefined) {
    if ((ev.freePoolBefore * EPOCH_BUDGET_BPS) / BPS < ts) errors.push("I9 broken: free pool before publication below 10 × totalScore");
    const F = BigInt(f.freePool.lamports);
    const drift = ev.freePoolBefore > F ? ev.freePoolBefore - F : F - ev.freePoolBefore;
    if (drift * BPS > F * REBUILD_DRIFT_BPS) errors.push("free pool moved more than the rebuild drift between build and publication");
  }
  if (ev.publishedAt !== undefined && !(f.window.endTs <= ev.publishedAt && ev.publishedAt <= f.window.endTs + MAX_PUBLISH_LAG)) {
    errors.push(`published at ${ev.publishedAt}, not within ${MAX_PUBLISH_LAG} s after the window end ${f.window.endTs} (both on X1's clock, A8): a late publication, reported on its own epoch; it never blocks the next one (A12)`);
  }
  return errors;
}

/** Epoch n−1's publication pins epoch n's window start and F_ref (F2, A2); null for a first epoch. */
export function verifyChainLinkV3(f: EpochBodyV3, prevPublished: { publishedAt: number; budget: bigint; freePoolBefore: bigint } | null): string[] {
  const errors: string[] = [];
  if (!prevPublished) {
    if (f.epoch !== 1 || f.freePool.open !== null) errors.push("only a first epoch has no previous publication");
    return errors;
  }
  if (f.window.startTs !== prevPublished.publishedAt) errors.push(`window start ${f.window.startTs} != epoch ${f.epoch - 1} published_at ${prevPublished.publishedAt}`);
  const ref = prevPublished.freePoolBefore - prevPublished.budget;
  if (f.freePool.open !== ref.toString()) errors.push(`freePool.open ${f.freePool.open} != epoch ${f.epoch - 1} free_pool_before − budget = ${ref}`);
  return errors;
}

/** The snapshot must list exactly the live ArtifactRecords (with their Core owner) at snapshot.slot (R1-3). */
export function verifySnapshotV3(f: EpochBodyV3, onChain: SnapshotRecord[]): string[] {
  const errors: string[] = [];
  // A13.9: an unavailable snapshot lists nothing by construction (its records could not be read when it was built)
  if (f.snapshot.unavailable) return errors;
  const key = (r: SnapshotRecord) => JSON.stringify([r.asset, r.tier, r.owner, r.backing, r.origin]);
  const mine = new Set(f.snapshot.records.map(key));
  const chain = new Set(onChain.map(key));
  for (const r of onChain) if (!mine.has(key(r))) errors.push(`snapshot: on-chain record ${r.asset} missing or different`);
  for (const r of f.snapshot.records) if (!chain.has(key(r))) errors.push(`snapshot: record ${r.asset} not on-chain at slot ${f.snapshot.slot}`);
  return errors;
}

/** --full: the window end must be the X1 block time of snapshot.slot (A8); a null reading leaves it unconfirmed. */
export function verifySnapshotTimeV3(f: EpochBodyV3, blockTime: number | null | undefined): string[] {
  if (blockTime === null || blockTime === undefined) return [`snapshot: no block time for slot ${f.snapshot.slot}: the window end ${f.window.endTs} cannot be confirmed`];
  if (blockTime !== f.window.endTs) return [`window end ${f.window.endTs} is not the block time ${blockTime} of snapshot slot ${f.snapshot.slot}`];
  return [];
}

/**
 * Every chain of the file must be a configured chain with its configured portal (R1-1): --full re-reads the
 * burns from the configured portal, so an unknown chain id must be an error there, never a silent skip.
 * A chain read for the first time (not in the previous file, v2 or v3) must start at its configured start
 * block, as v2 does (from = max(0, startBlock − 1)), so no burn before the first range is lost (R2-SC-5).
 * Kept out of computeEpochV3 so old files keep verifying when the configuration changes.
 */
export function verifyChainSetV3(f: EpochBodyV3, prev: AnyEpochFile | null, configured: { chainId: number; portal: string; startBlock: number }[]): string[] {
  const errors: string[] = [];
  const byId = new Map(configured.map((c) => [c.chainId, c]));
  const known = new Set((prev?.chains ?? []).map((c) => c.chainId));
  for (const c of f.chains) {
    const cfg = byId.get(c.chainId);
    if (cfg === undefined) errors.push(`chain ${JSON.stringify(c.chainId)} is not a configured chain`);
    else {
      if (cfg.portal.toLowerCase() !== c.portal.toLowerCase()) errors.push(`chain ${c.chainId}: portal ${c.portal} is not the configured ${cfg.portal.toLowerCase()}`);
      const from = Math.max(0, cfg.startBlock - 1);
      if (!c.skipped && !known.has(c.chainId) && c.fromBlockExclusive !== from) {
        errors.push(`chain ${c.chainId} is read for the first time from block ${c.fromBlockExclusive}, not from its start block (${from})`);
      }
    }
  }
  return errors;
}
