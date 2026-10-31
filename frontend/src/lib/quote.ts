/**
 * The v3 quote: what the epoch pays for ONE prospective burn under the rewards v3 rules, computed with the oracle's own
 * integer math (oracle/src/rewards.ts, read-only). Byte-for-byte mirror of decayFactor, curve shares (runCurve), xenPrice,
 * xntPrice, lamportsOf, the tier entitlement, the daily tranches (allocateBurns `release`) and the arrival rule
 * (lockPiece / settleArrival). test/v3/quote.test.ts runs the oracle engine (computeEpochV3) on seeded worlds and checks
 * every burn's arrival outcome against this mirror, and test/v3/golden/quote-vectors.json pins the shared vectors.
 *
 * Fail-closed: quoteBurn() returns {ok:false, reason} whenever an input is missing, stale or out of range; the site then
 * shows no number and does not offer the burn. A quote is binding only for the part paid at arrival, and only if the burn
 * lands inside today's remaining capacity; burns on the same chain in the same hour share that hour's curve pot, and
 * an unseen earlier burn, or the USDC.X guard at the weekly build (D-22 c), can lower it, so the value is "at most" until
 * the epoch is built (A13.12, WORDING §3). Used only when rules detection reads rewards = 3.
 *
 * Round 4 and F5 (rules block 2, mirrored from rewards.ts): the window's liquidity L is the one epoch n−1's build froze
 * (D-13, the feed's option a; liquidityRule), so the live quote is given only for a chain whose L is frozen (or, at the
 * switch, the median of the chain's last 4 v2 readings that the feed's switchRefs carry: r6-review 2, switchLiquidity); the
 * build's statistic counts the full stat days only (r6-review 3, liquidityStatOf); a build whose hourly feed was missing or
 * thin for a chain (more than 2 of the 7 days with fewer than 4 recorded samples, or none; at the switch epoch fewer than
 * 2 full days) carries that chain's L to the next window unchanged (F5, liquidityCarried;
 * the frozen value is still L.next, so the live quote reads it the same way); rules block 1 (round 4, without F5) is
 * refused (rulesOf); C is capped by 7 × 2% of the XDEX XNT reserve read at that build (D-22 a); a USDC.X premium
 * above 3% raises every XNT pool reading (D-22 c); an orphaned chain is valued at half its reference (D-21); same-second
 * burns are ordered by keccak256(txHash ‖ logIndex) (D-14); a skipped chain's backlog and the operator's wallets rank
 * after every burn of the window (D-12, D-18), so a burn quoted now claims after the window's burns only. test/v3/
 * rules-vectors.test.ts replays oracle/test/fixtures/rules-v3-vectors.json (the engine's own vectors) on these functions.
 *
 * Pure: no React, no network.
 */
import { solidityPackedKeccak256 } from 'ethers';

export const BPS = 10_000n;
export const K_BPS = 12_500n;
export const PLAN_BPS = 800n;
export const PRICE_CAP_BPS = 12_500n;
export const L_GROWTH_BPS = 11_000n;
export const L_STEP_MICRO = 50_000_000n;
export const XNT_FLOOR_BPS = 6_000n;
export const EPOCH_DAYS = 7;
export const DAY = 86_400;
export const HOUR = 3_600;
/**
 * A vesting burn entitled to less than this (0.02 XNT) is paid as Launchpad: rewards.ts VEST_MIN_ENT = 10 × KEEPER_TIP,
 * an engine policy of its own since 2026-10-23. It is no longer the keeper-tip minimum (rewards.ts KEEPER_TIP_MIN_CLAIM
 * = 100 × KEEPER_TIP = 0.2 XNT under the upgraded program; src/v3/constants.ts KEEPER_TIP_MIN_CLAIM), which no quote reads.
 */
export const VEST_MIN_ENT = 20_000_000n;
export const TIER_MULTIPLIER = [1n, 2n, 3n] as const;
/** 2^(−1/336) in 1e18 fixed point, floored (half-life 336 h). */
export const DECAY_Q = 997_939_188_356_834_408n;
export const FP = 10n ** 18n;
/** A week state older than this is not quoted (the feed is rewritten hourly). */
export const STATE_MAX_AGE_S = 2 * HOUR;
/** Closer than this to the end of the hour the burn may land in the next hour and be priced on its readings (the kit's HOUR_EDGE_SEC). */
export const HOUR_EDGE_S = 180;
/** rewards.ts CLOCK_SKEW_MAX: a backlog or operator burn claims on the day of (window end + this) (D-12, D-18). */
export const CLOCK_SKEW_MAX = HOUR;
/** D-13 (rules block priceRules.liquidity): the 50% floor of the next L, the statistic's days, the first-reading cap. */
export const L_DROP_BPS = 5_000n;
export const L_STAT_DAYS = 7;
/**
 * D-13, F5 (rewards.ts L_MIN_SAMPLES_PER_DAY, the rules block's priceRules.liquidity.minSamplesPerDay): a stat day with
 * fewer RECORDED hourly samples than this is thin (the build's own reading is not one of them).
 */
export const L_MIN_SAMPLES_PER_DAY = 4;
/** D-13, F5 (rewards.ts L_MAX_THIN_DAYS, priceRules.liquidity.maxThinDays): more thin days than this, or no recorded sample, carries the L. */
export const L_MAX_THIN_DAYS = 2;
/** D-13, r6-review 2 (rewards.ts L_SWITCH_MIN_FULL_DAYS, priceRules.liquidity.switchMinFullDays): at the switch epoch this many full days clamp the next L. */
export const L_SWITCH_MIN_FULL_DAYS = 2;
export const L_FIRST_BASE_MICRO = 500_000_000n;
export const L_FIRST_PER_DAY_MICRO = 50_000_000n;
export const L_FIRST_MAX_DAYS = 90;
/** D-22 (a): a daily tranche is at most 2% of the XDEX XNT reserve read at the week start. */
export const XDEX_TRANCHE_BPS = 200n;
/** D-22 (c): the USDC.X peg band (x1report's USD price over the XDEX TWAP in USDC.X). */
export const PEG_GUARD_BPS = 300n;
/** D-21: an orphaned chain's burns are valued at this share of the reference recorded at its orphaning. */
export const ORPHAN_PRICE_BPS = 5_000n;
/** The pinned rules of the rules block (rewards.ts TIE_BREAK_V3, BACKLOG_RULE_V3, OPERATOR_RULE_V3). */
export const TIE_BREAK = 'keccak256(txHash,logIndex)';
export const BACKLOG_RULE = 'after-current-senior,first-leftover';
export const OPERATOR_RULE = 'rank-last';
/** rewards.ts RULES_ID_V3: the rules of the first v3 epoch (F5, the D-13 "carried" rule). */
export const RULES_ID = 2;
/** rewards.ts RULES_ID_RETIRED_V3: the round-4 block, replaced before any v3 epoch was built; a block claiming it (or lower) is refused. */
export const RULES_ID_RETIRED = 1;

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const U = (v: unknown, what: string): bigint => {
    if (typeof v === 'bigint') { if (v < 0n) throw new Error(`${what} is negative`); return v; }
    if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) throw new Error(`${what}: not a canonical unsigned integer`);
    return BigInt(v);
};

// ── the engine functions (rewards.ts) ────────────────────────────────────────────────────────────────────────────
export function decayFactor(hours: number): bigint {
    if (!Number.isSafeInteger(hours) || hours < 0) throw new Error(`bad decay interval ${hours}`);
    let p = FP;
    for (const bit of hours.toString(2)) {
        p = (p * p) / FP;
        if (bit === '1') p = (p * DECAY_Q) / FP;
    }
    return p;
}
export const decay = (s: bigint, hours: number) => (hours === 0 || s === 0n ? s : (s * decayFactor(hours)) / FP);
export const lamportsOf = (micro: bigint, xE18: bigint) => (micro * 10n ** 21n) / xE18;
export const spotMicro = (amountWei: bigint, priceE18: bigint) => (amountWei * priceE18) / 10n ** 30n;
export function medianE18(values: bigint[]): bigint {
    const v = values.filter((x) => x > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (!v.length) return 0n;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2n;
}
export const clampL = (now: bigint, prev: bigint | null) => (prev === null ? now : min(now, (prev * L_GROWTH_BPS) / BPS + L_STEP_MICRO));

// ── D-13: the liquidity L of a window (rewards.ts liquidityReadingV3 … liquidityRuleV3) ──────────────────────────────
/** A reading is the lower of GeckoTerminal's and the on-chain depth (null on-chain: GeckoTerminal alone). */
export const liquidityReading = (gecko: bigint, onChain: bigint | null) => (onChain === null ? gecko : min(gecko, onChain));
function medianWithZeros(xs: bigint[]): bigint {
    const v = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2n;
}
/**
 * The samples RECORDED for a window (rewards.ts recordedLiquiditySamplesV3: the week-so-far feed's hourly readings),
 * checked: strictly ascending unix hours, each at or before the window end. The build's own reading is not one of them.
 */
export function recordedLiquiditySamples(recorded: { hour: number; micro: string | bigint }[] | null | undefined, endTs: number): { hour: number; micro: bigint }[] {
    const out: { hour: number; micro: bigint }[] = [];
    for (const s of recorded ?? []) {
        if (!Number.isSafeInteger(s.hour) || s.hour < 0) throw new Error('liquiditySamples: bad hour');
        if (out.length && s.hour <= out[out.length - 1].hour) throw new Error('liquiditySamples: not strictly ascending');
        if (s.hour * HOUR > endTs) throw new Error('liquiditySamples: a sample after the window end');
        out.push({ hour: s.hour, micro: U(s.micro, 'liquiditySamples.micro') });
    }
    return out;
}
/**
 * The samples by stat day, day d = ⌊(endTs − hour start) / 1 day⌋ (0 = the last 24 h), only d < L_STAT_DAYS (rewards.ts
 * liquidityDaysV3). The statistic (liquidityStat) and the F5 coverage (liquidityCarried) bucket by this one function.
 */
export function liquidityDays(samples: { hour: number; micro: bigint }[], endTs: number): Map<number, bigint[]> {
    const days = new Map<number, bigint[]>();
    for (const s of samples) {
        const d = Math.floor((endTs - s.hour * HOUR) / DAY);
        if (d < 0 || d >= L_STAT_DAYS) continue;
        days.set(d, [...(days.get(d) ?? []), s.micro]);
    }
    return days;
}
/** How the NEXT window's L (L.next) was set (rewards.ts LiquidityNextRuleV3): 'clamp' = nextLiquidity, 'carried' = kept. */
export type LNextRule = 'clamp' | 'carried';
/**
 * D-13, F5 (rewards.ts liquidityCarriedV3): whether a VALUED chain's next L is carried (next = the L in force) instead of
 * clamped (nextLiquidity). `recorded` = the window's samples as recorded (recordedLiquiditySamples; the build's own
 * reading is not one of them). A stat day with fewer than L_MIN_SAMPLES_PER_DAY recorded samples is thin; the L is carried
 * when more than L_MAX_THIN_DAYS of the L_STAT_DAYS days are thin, or when no sample is recorded in them at all (no feed).
 * An orphaned chain (D-21) is never carried: its reading is 0 by rule, so its frozen L keeps halving each week.
 */
export function liquidityCarried(recorded: { hour: number; micro: bigint }[], endTs: number, orphan: boolean, switchEpoch = false): { carried: boolean; samples: number; thinDays: number } {
    const days = liquidityDays(recorded, endTs);
    let samples = 0;
    let thinDays = 0;
    for (let d = 0; d < L_STAT_DAYS; d++) {
        const n = days.get(d)?.length ?? 0;
        samples += n;
        if (n < L_MIN_SAMPLES_PER_DAY) thinDays++;
    }
    // r6-review 2: at the switch epoch (epoch n−1 is a v2 file), at least L_SWITCH_MIN_FULL_DAYS full days clamp the next L
    const thin = switchEpoch ? L_STAT_DAYS - thinDays < L_SWITCH_MIN_FULL_DAYS : thinDays > L_MAX_THIN_DAYS;
    return { carried: !orphan && (samples === 0 || thin), samples, thinDays };
}
function minOfDayMedians(days: Iterable<bigint[]>): bigint {
    let out: bigint | null = null;
    for (const v of days) {
        const m = medianWithZeros(v);
        if (out === null || m < out) out = m;
    }
    if (out === null) throw new Error('the liquidity statistic has no sample');
    return out;
}
/** The minimum over the last 7 days (day d = ⌊(endTs − hour start) / 1 day⌋) of each day's median reading, zeros included. */
export function liquidityStat(samples: { hour: number; micro: bigint }[], endTs: number): bigint {
    const days = liquidityDays(samples, endTs);
    return minOfDayMedians(days.values());
}
/**
 * D-13, r6-review 3 (rewards.ts liquidityStatOfV3): the statistic the build records. Over the FULL stat days only (at least
 * L_MIN_SAMPLES_PER_DAY recorded samples) when there is one; else over every stat day with a recorded sample; the build's
 * own reading only when no sample is recorded in the 7 days. It is never added to recorded samples.
 */
export function liquidityStatOf(recorded: { hour: number; micro: bigint }[], endTs: number, buildReading: bigint): bigint {
    const days = liquidityDays(recorded, endTs);
    const full = [...days.values()].filter((v) => v.length >= L_MIN_SAMPLES_PER_DAY);
    if (full.length) return minOfDayMedians(full);
    if (days.size) return minOfDayMedians(days.values());
    return buildReading;
}
/**
 * D-13, r6-review 2 (rewards.ts switchLiquidityV3): the switch window's L, the median (zeros excluded: a v2 "0" is no
 * reading) of the chain's last (up to) 4 v2 liquidity readings; null when none is above 0.
 */
export function switchLiquidity(readings: bigint[]): bigint | null {
    const v = readings.filter((x) => x > 0n);
    return v.length ? medianWithZeros(v) : null;
}
/** The first-reading cap: $500 + $50 per whole day of the price pool's age at the window start (at most 90 days; unknown = 0). */
export function firstLiquidityCap(poolCreatedAt: number | null, startTs: number): bigint {
    const age = poolCreatedAt === null || poolCreatedAt > startTs ? 0 : Math.floor((startTs - poolCreatedAt) / DAY);
    return L_FIRST_BASE_MICRO + L_FIRST_PER_DAY_MICRO * BigInt(Math.min(age, L_FIRST_MAX_DAYS));
}
/**
 * The L the build freezes for the next window when the feed covered the window (rule 'clamp'): the statistic within
 * [50% × L, 1.1 × L + $50] of the L in force. A carried chain (liquidityCarried) keeps the L in force instead.
 */
export const nextLiquidity = (stat: bigint, used: bigint) => max((used * L_DROP_BPS) / BPS, min(stat, (used * L_GROWTH_BPS) / BPS + L_STEP_MICRO));
/**
 * How the window's L is set: 'frozen' = epoch n−1's L.next, 'switch' = the median of the chain's last (up to) 4 v2
 * liquidity readings (switchRefs; the v2 file's own reading when none is given), both known from the first
 * hour (a binding quote); 'legacy' (a v3 record written before D-13) and 'first' (no L in epoch n−1's file: a new chain)
 * need the build's statistic; 'genesis' = no previous file at all.
 */
export type LRule = 'frozen' | 'switch' | 'legacy' | 'first' | 'genesis';
export function liquidityRule(
    prev: { L: bigint | null; next: bigint | null | undefined; v2: boolean; switchL?: bigint | null } | null, hasPrevFile: boolean, stat: bigint, cap: bigint,
): { used: bigint; rule: LRule; cap: bigint | null } {
    if (prev && prev.next !== undefined && prev.next !== null) return { used: prev.next, rule: 'frozen', cap: null };
    // r6-review 2: at the switch, the median of the last (up to) 4 v2 liquidity readings (switchL), else the v2 file's own
    if (prev && prev.v2 && prev.L !== null) return { used: prev.switchL ?? prev.L, rule: 'switch', cap: null };
    if (prev && prev.next === undefined && !prev.v2 && prev.L !== null) return { used: clampL(stat, prev.L), rule: 'legacy', cap: null };
    if (!hasPrevFile) return { used: stat, rule: 'genesis', cap: null };
    return { used: min(stat, cap), rule: 'first', cap };
}
/** A chain's record in a published epoch file as liquidityRule reads it (rewards.ts prevState): v3 L.used / L.next, or the v2 reading. */
export function prevLiquidityOf(file: any, chainId: number): { L: bigint | null; next: bigint | null | undefined; v2: boolean } | null {
    const c = (file?.chains ?? []).find((x: any) => x?.chainId === chainId);
    if (!c) return null;
    if (file.version === 3) {
        const L = c.L?.used === null || c.L?.used === undefined ? null : U(c.L.used, 'L.used');
        const has = !!c.L && Object.prototype.hasOwnProperty.call(c.L, 'next');
        return { L, next: !has ? undefined : c.L.next === null ? null : U(c.L.next, 'L.next'), v2: false };
    }
    const L = U(c.liquidityUsdMicro || '0', 'liquidityUsdMicro');
    return { L: L > 0n ? L : null, next: undefined, v2: true };
}
/**
 * The switch window's L of a chain from the feed's switchRefs (rewards.ts applySwitchRefs, r6-review 2): the median of its
 * last (up to) 4 v2 liquidity readings, the first of which must be the v2 file's own liquidityUsdMicro (`ownL`, 0 = none);
 * null when the feed carries no valid history for the chain (no binding quote then).
 */
export function switchLOf(switchRefs: unknown, chainId: number, ownL: bigint): bigint | null {
    try {
        if (!Array.isArray(switchRefs)) return null;
        const r = switchRefs.find((x: any) => x?.chainId === chainId) as { readings?: unknown; liquidity?: unknown } | undefined;
        if (!r || !Array.isArray(r.readings) || !Array.isArray(r.liquidity) || r.liquidity.length !== r.readings.length || r.liquidity.length < 1 || r.liquidity.length > 4) return null;
        const liq = r.liquidity.map((x, i) => U(x, `switchRefs liquidity[${i}]`));
        if (liq[0] !== ownL) return null;
        return switchLiquidity(liq);
    } catch {
        return null;
    }
}
/**
 * D-13 option (a) from the newest published file alone: the L that values the NEXT window on each chain, when it is
 * already known (rules 'frozen' and 'switch'); null for a chain whose L the build sets from its own statistic ('legacy',
 * 'first'), which gets no binding quote. `prevL` is the record's own L (the feed's Lprev twin). F5: L.next is read the
 * same way whatever the record's L.nextRule says ('carried': L.next = L.used, kept; 'clamp': moved by the statistic).
 * r6-review 2: a v2 file (the switch) values the window at the median of the chain's last 4 v2 readings, which only the
 * feed's switchRefs carry: without `switchRefs` (or with an invalid one) a v2 chain has no known L (no binding quote).
 */
export function windowLOf(file: any, chainId: number, switchRefs?: unknown): { L: bigint | null; rule: LRule; prevL: bigint | null } {
    const p = prevLiquidityOf(file, chainId);
    if (p && p.next !== undefined && p.next !== null) return { L: p.next, rule: 'frozen', prevL: p.L };
    if (p && p.v2 && p.L !== null) return { L: switchLOf(switchRefs, chainId, p.L), rule: 'switch', prevL: p.L };
    if (p && p.next === undefined && !p.v2 && p.L !== null) return { L: null, rule: 'legacy', prevL: p.L };
    return { L: null, rule: 'first', prevL: p?.L ?? null };
}

// ── D-22 (a, c) and D-21 ─────────────────────────────────────────────────────────────────────────────────────────
/** D-22 (c), rewards.ts xntPegV3: the factor (× 1e18) every XNT pool reading takes; 1e18 unless USDC.X reads more than 3% above $1. */
export function xntPeg(twapE18: bigint, apiE18: bigint): { guard: 'ok' | 'high' | 'low' | 'unread'; factorE18: bigint } {
    if (twapE18 === 0n || apiE18 === 0n) return { guard: 'unread', factorE18: FP };
    const usdcx = (apiE18 * FP) / twapE18;
    if (usdcx * BPS > FP * (BPS + PEG_GUARD_BPS)) return { guard: 'high', factorE18: usdcx };
    if (usdcx * BPS < FP * (BPS - PEG_GUARD_BPS)) return { guard: 'low', factorE18: FP };
    return { guard: 'ok', factorE18: FP };
}
export const pegged = (x: bigint, factorE18: bigint) => (factorE18 === FP ? x : (x * factorE18) / FP);
/** D-22 (a), rewards.ts trancheCapV3: 7 daily tranches of 2% of the XDEX XNT reserve (null: no reading, no cap). */
export const trancheCap = (capReserve: bigint | null) => (capReserve === null ? null : BigInt(EPOCH_DAYS) * ((capReserve * XDEX_TRANCHE_BPS) / BPS));
/** The reserve that caps the window after a v3 file: its XDEX reading at its build, else its own cap reserve (null: none). */
export function capReserveOf(file: any): bigint | null {
    if (!file || file.version !== 3 || !file.xdex) return null;
    if (file.xdex.atBuild) return U(file.xdex.atBuild.wxntReserveLamports, 'xdex.atBuild.wxntReserveLamports');
    return file.xdex.capReserve === null || file.xdex.capReserve === undefined ? null : U(file.xdex.capReserve, 'xdex.capReserve');
}
/** D-21: an orphaned chain's XEN price (half the reference recorded at its orphaning). */
export const orphanPrice = (refE18: bigint) => (refE18 * ORPHAN_PRICE_BPS) / BPS;

// ── D-14, D-12, D-18: the order of the burns and their rank classes ────────────────────────────────────────────
/** keccak256(txHash ‖ logIndex as a 32-byte big-endian integer), lowercase hex without 0x (rewards.ts tieKeyV3). */
export function tieKey(txHash: string, logIndex: number): string {
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('tie-break: txHash is not 32 bytes of hex');
    if (!Number.isSafeInteger(logIndex) || logIndex < 0) throw new Error('tie-break: bad logIndex');
    return solidityPackedKeccak256(['bytes32', 'uint256'], [txHash, BigInt(logIndex)]).slice(2).toLowerCase();
}
export interface BurnOrderKey { timestamp: number; txHash: string; logIndex: number; chainId: number; blockNumber: number }
/** rewards.ts globalOrder: (timestamp, tie key), then chainId, block, log index (only for a hash tie). */
export function globalOrder(a: BurnOrderKey, b: BurnOrderKey): number {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    const ka = tieKey(a.txHash, a.logIndex);
    const kb = tieKey(b.txHash, b.logIndex);
    return (ka < kb ? -1 : ka > kb ? 1 : 0) || a.chainId - b.chainId || a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
}
/** 0 = a burn of the window, 1 = a skipped chain's backlog, 2 = an operator burn (rewards.ts rankClassV3). */
export const rankClass = (w: { backlog: boolean; operator: boolean }): 0 | 1 | 2 => (w.operator ? 2 : w.backlog ? 1 : 0);
export interface OperatorWallets {
    rule: typeof OPERATOR_RULE;
    wallets: string[];
    exceptions: { name: string; wallets: string[]; fromTs: number; untilTs: number; published: string }[];
}
/** rewards.ts operatorOfV3: inside an exception's [fromTs, untilTs) a listed wallet is ordinary; any other listed wallet ranks last. */
export function operatorOf(ow: OperatorWallets, x1: string, ts: number): { operator: boolean; exception: string | null } {
    let listed = ow.wallets.includes(x1);
    for (const e of ow.exceptions) {
        if (!e.wallets.includes(x1)) continue;
        if (e.fromTs <= ts && ts < e.untilTs) return { operator: false, exception: e.name };
        listed = true;
    }
    return { operator: listed, exception: null };
}
/** D-21: an orphaned chain's skips before its price falls to ORPHAN_PRICE_BPS of its reference (the rules block's orphan.skips). */
export const ORPHAN_SKIPS = 4;
/** The rules block's tipMin and autoClaimMin this mirror implements (rewards.ts KEEPER_TIP_MIN_CLAIM = 0.2 XNT, AUTO_CLAIM_MIN = 0). */
export const TIP_MIN = 200_000_000n;
export const AUTO_CLAIM_MIN = 0n;
/**
 * D-13, D-22 (a, c), D-21, D-22 (b), D-17: the price rules this mirror implements, exactly rewards.ts PRICE_RULES_V3 (=
 * the kit's quote-v3.mjs PRICE_RULES_V3), hashed in every v3 file. rulesOf refuses a block with any other (r4-fix, review
 * r4 finding 7: a new rulesId with other cap numbers must stop the site's binding quotes, as it stops the kit's).
 */
export const PRICE_RULES = Object.freeze({
    liquidity: {
        reading: 'min(geckoterminal,on-chain)', stat: 'min-of-full-day-medians', statDays: L_STAT_DAYS, freeze: 'previous-build', growthBps: Number(L_GROWTH_BPS),
        stepMicro: L_STEP_MICRO.toString(), dropBps: Number(L_DROP_BPS), firstBaseMicro: L_FIRST_BASE_MICRO.toString(), firstPerDayMicro: L_FIRST_PER_DAY_MICRO.toString(),
        firstMaxDays: L_FIRST_MAX_DAYS, minSamplesPerDay: L_MIN_SAMPLES_PER_DAY, maxThinDays: L_MAX_THIN_DAYS,
        switchL: 'median-of-v2-readings', switchMinFullDays: L_SWITCH_MIN_FULL_DAYS,
    },
    xntTranche: { maxReserveBps: Number(XDEX_TRANCHE_BPS) },
    xntPeg: { guardBps: Number(PEG_GUARD_BPS) },
    orphan: { skips: ORPHAN_SKIPS, priceBps: Number(ORPHAN_PRICE_BPS), notice: 'one-epoch' },
    xntPool: { metric: 'median-tvl', epochs: 4, switchX: 2, weeks: 2, notice: 'one-epoch' },
    gate: { walletShareBps: 6_000, leafCountX: 5, scoreX: 3, fallbackShareBps: 5_000, historyEpochs: 4, holdSeconds: DAY, firstChain: true, xntSourceChange: true },
});
/** Canonical JSON with every object's keys sorted (the kit's sortedJson): equal values give equal strings. */
export function sortedJson(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
    return JSON.stringify(v ?? null);
}

/**
 * The members of a rules block the quote reads (T2-RULES), or null when the block is not one this mirror implements
 * (fail-closed): programRules 3, the pinned tie-break, backlog and operator rules, a canonical dust minimum, the
 * operator wallets with their exceptions, and (r4-fix, review r4 finding 7) exactly this mirror's price rules, tipMin and
 * autoClaimMin. F5: a rulesId of RULES_ID_RETIRED (1, the round-4 block without the carried rule) or lower is refused,
 * as rewards.ts rulesBlockOf refuses it. The oracle's rulesBlockOf checks the rest of the block.
 */
export function rulesOf(v: unknown): { rulesId: number; vestMinEnt: bigint; operatorWallets: OperatorWallets } | null {
    try {
        const o = v as any;
        if (!o || typeof o !== 'object' || o.programRules !== 3 || o.tieBreak !== TIE_BREAK || o.backlogRule !== BACKLOG_RULE) return null;
        if (sortedJson(o.priceRules) !== sortedJson(PRICE_RULES)) return null;
        if (String(o.tipMin) !== TIP_MIN.toString() || String(o.autoClaimMin) !== AUTO_CLAIM_MIN.toString()) return null;
        if (!Number.isSafeInteger(o.rulesId) || o.rulesId <= RULES_ID_RETIRED) return null;
        const ow = o.operatorWallets;
        if (!ow || ow.rule !== OPERATOR_RULE || !Array.isArray(ow.wallets) || !Array.isArray(ow.exceptions)) return null;
        if (!ow.wallets.every((w: unknown) => typeof w === 'string')) return null;
        const exceptions = ow.exceptions.map((e: any) => {
            if (!e || typeof e.name !== 'string' || !Array.isArray(e.wallets) || !e.wallets.every((w: unknown) => typeof w === 'string')) throw new Error('bad exception');
            if (!Number.isSafeInteger(e.fromTs) || !Number.isSafeInteger(e.untilTs) || !(e.fromTs < e.untilTs) || typeof e.published !== 'string') throw new Error('bad exception');
            return { name: e.name, wallets: [...e.wallets], fromTs: e.fromTs, untilTs: e.untilTs, published: e.published };
        });
        return { rulesId: o.rulesId, vestMinEnt: U(o.dustRule?.vestMinEnt, 'dustRule.vestMinEnt'), operatorWallets: { rule: OPERATOR_RULE, wallets: [...ow.wallets], exceptions } };
    } catch {
        return null;
    }
}

export type XenRule = 'median' | 'last' | 'cap' | 'spot' | 'orphan';
export type XntRule = 'median' | 'last' | 'floor' | 'build';
export function xenPrice(r: [bigint, bigint] | null, spotE18: bigint, capE18: bigint): { priceE18: bigint; rule: XenRule } {
    const low = r === null ? spotE18 : min(r[0], r[1]);
    if (capE18 < low) return { priceE18: capE18, rule: 'cap' };
    if (r === null) return { priceE18: spotE18, rule: 'spot' };
    return r[1] < r[0] ? { priceE18: r[1], rule: 'last' } : { priceE18: r[0], rule: 'median' };
}
export function xntPrice(r: [bigint, bigint] | null, buildE18: bigint, floorE18: bigint): { xE18: bigint; rule: XntRule } {
    const high = r === null ? buildE18 : max(r[0], r[1]);
    if (floorE18 > high) return { xE18: floorE18, rule: 'floor' };
    if (r === null) return { xE18: buildE18, rule: 'build' };
    return r[1] > r[0] ? { xE18: r[1], rule: 'last' } : { xE18: r[0], rule: 'median' };
}
export const dayOf = (timestamp: number, startTs: number) => Math.max(0, Math.floor((timestamp - startTs) / DAY));
/** Cumulative cap after k of 7 days that release R (the first R mod 7 days release one extra lamport). */
export const release = (R: bigint, k: number) => (R / BigInt(EPOCH_DAYS)) * BigInt(k) + min(BigInt(k), R % BigInt(EPOCH_DAYS));
export const dayCap = (C: bigint, day: number) => (day < EPOCH_DAYS ? release(C, day + 1) : C);

export function lockPiece(lp: bigint, band: bigint, claim: bigint, minVestEnt: bigint): { lp: bigint; band: bigint; cash: bigint } | null {
    if (band <= 0n || lp <= 0n || claim <= 0n) return null;
    if (claim >= lp + band) return { lp, band, cash: 0n };
    const band1 = (claim * band) / (lp + band);
    const lp1 = band1 === 0n ? 0n : ceilDiv(band1 * lp, band);
    if (lp1 === 0n || lp1 > lp || lp1 + band1 > claim || lp1 + band1 < minVestEnt) return null;
    const cash = min(claim - lp1 - band1, lp - lp1);
    return { lp: lp1, band: band1, cash };
}

/** settleArrival of rewards.ts for one burn: what its claim locks and pays at its own arrival. */
export function arrival(tier: number, lp: bigint, band: bigint, claim: bigint, minVestEnt = VEST_MIN_ENT) {
    const vests = tier > 0 && lp + band >= minVestEnt;
    const piece = vests ? lockPiece(lp, band, claim, minVestEnt) : null;
    if (piece) {
        return { vests, senior: piece.lp + piece.band + piece.cash, lockedLp: piece.lp, bandPaid: piece.band, basePaid: piece.lp + piece.cash, leafTier: tier, converted: false };
    }
    const senior = min(lp, claim);
    return { vests, senior, lockedLp: 0n, bandPaid: 0n, basePaid: senior, leafTier: 0, converted: tier > 0 };
}

// ── the week state a quote reads ────────────────────────────────────────────────────────────────────────────────
export interface QuoteChainState {
    chainId: number;
    /** this week's L before the build clamp: min(live reading, 1.1 × previous L + $50) is applied by quoteBurn */
    Lprev: bigint | null;
    /** the live L reading (µUSD) the quote assumes for the build (the build may read less: value is "at most") */
    Lnow: bigint;
    /** curve state after every burn of earlier hours this week: S (µUSD) at `hour` */
    S: bigint;
    hour: number;
    /** Σ spot (µUSD) of the burns already in the current hour on this chain (they share its pot) */
    hourSpot: bigint;
    /** price cap 1.25 × ref (USD × 1e18) and the build spot fallback */
    capE18: bigint;
    spotE18: bigint;
    /**
     * D-13: the L that values this window (µUSD) and how it was set (liquidityRule). Absent = the pre-D-13 estimate
     * clampL(Lnow, Lprev). Set from the newest file it is binding ('frozen', 'switch').
     */
    Lwindow?: bigint;
    Lrule?: LRule;
    /** D-21: the reference recorded at the chain's orphaning; set = every burn is valued at half of it (no candles) */
    orphanRefE18?: bigint;
}
export interface QuoteWeekState {
    /** the epoch this week builds and the window start (epoch n−1's on-chain published_at) */
    epoch: number;
    startTs: number;
    /** C = ⌊F_ref × 8%⌋ and Σ senior already taken this week */
    C: bigint;
    senior: bigint;
    xFloorE18: bigint;
    xBuildE18: bigint;
    chains: Map<number, QuoteChainState>;
    /** when the state was read (unix s) */
    asOf: number;
    /** chains the oracle skipped (no market): never quoted */
    skipped: number[];
    /** chains the feed marks quarantined or sunset (still valued by the build, but they may not be valued this week): never quoted */
    held?: number[];
    /** D-13: chains whose L for this window is set only at the weekly build ('legacy', 'first'): no binding quote */
    unfrozen?: number[];
    /** D-22 (c): the factor (× 1e18) every XNT pool reading takes this window (absent = 1e18) */
    xntPegE18?: bigint;
    /** T2-RULES: the rules block's dust minimum (absent = VEST_MIN_ENT) and operator wallets (D-18) */
    vestMinEnt?: bigint;
    operatorWallets?: OperatorWallets;
    rulesId?: number;
    /** D-17: the feed says epoch n is held by the anomaly gate (published later, rebuilt from fresh reads) */
    anomalyHold?: boolean;
}

export interface QuoteInput {
    chainId: number;
    amountWei: bigint;
    tier: number;
    /** the burn's expected timestamp (now) */
    timestamp: number;
    /** 24-hour median and last close of the chain's XEN (USD × 1e18) before the burn's hour, or null = none */
    xen: [bigint, bigint] | null;
    /** the same two readings of XNT/USDC.X, or null */
    xnt: [bigint, bigint] | null;
}

export interface QuoteOk {
    ok: true;
    epoch: number;
    priceE18: bigint;
    priceRule: XenRule;
    xE18: bigint;
    xntRule: XntRule;
    L: bigint;
    /** D-13: how L was set ('estimate' = the pre-D-13 clampL of the live reading); binding only for 'frozen' and 'switch' */
    Lrule: LRule | 'estimate';
    spot: bigint;
    /** counted value (µUSD): an upper bound until the burn's chain-hour closes */
    value: bigint;
    base: bigint;
    lp: bigint;
    ent: bigint;
    band: bigint;
    day: number;
    /** what is left of today's cumulative capacity before this burn, and of the week */
    roomToday: bigint;
    roomWeek: bigint;
    /** what the burn is entitled to: lp + band for a vesting burn of at least VEST_MIN_ENT, else lp (the kit's `entitlement`) */
    entitlement: bigint;
    claim: bigint;
    /** the arrival outcome: paid from today's capacity (binding part) */
    paidAtArrival: bigint;
    basePaid: bigint;
    bandPaid: bigint;
    lockedLp: bigint;
    leafTier: number;
    converted: boolean;
    /** the Launchpad layer not covered at arrival: paid only from the week's leftover, if any (not promised) */
    junior: bigint;
    /** the whole entitlement fits today's capacity */
    fitsWhole: boolean;
    /** nothing fits today: the burn is paid only from the leftover, if any */
    beyondCapacity: boolean;
}
export type QuoteResult = QuoteOk | { ok: false; reason: string };

/** The quote of one burn against the week state (fail-closed). */
export function quoteBurn(w: QuoteWeekState | null, b: QuoteInput, now = Math.floor(Date.now() / 1000)): QuoteResult {
    try {
        if (!w) return { ok: false, reason: 'The week state is not available, so no quote can be computed.' };
        if (now - w.asOf > STATE_MAX_AGE_S) return { ok: false, reason: 'The week state is more than 2 hours old: no quote until it refreshes.' };
        if (b.timestamp < w.startTs) return { ok: false, reason: 'The burn time is before the current window.' };
        if (w.skipped.includes(b.chainId)) return { ok: false, reason: 'This chain is skipped this week (no eligible market or no XEN price): no quote; its burns wait for a later epoch.' };
        if (w.held?.includes(b.chainId)) return { ok: false, reason: 'This chain is held this week (quarantined, or orphaned after weeks without a market and valued at half its last reference): no quote from this page.' };
        if (w.unfrozen?.includes(b.chainId)) return { ok: false, reason: 'This chain’s liquidity for this week is set only at the weekly build (its first week with a reading under the v3 rules), so no binding quote can be given this week.' };
        const c = w.chains.get(b.chainId);
        if (!c) return { ok: false, reason: 'No market state for this chain.' };
        if (!Number.isInteger(b.tier) || b.tier < 0 || b.tier > 2) return { ok: false, reason: 'Bad tier.' };
        if (b.amountWei <= 0n) return { ok: false, reason: 'Enter an amount.' };
        if (b.xnt === null && w.xBuildE18 === 0n) return { ok: false, reason: 'No XNT price.' };
        // D-21: an orphaned chain is valued at half its recorded reference, without candles
        const xen = c.orphanRefE18 !== undefined ? { priceE18: orphanPrice(c.orphanRefE18), rule: 'orphan' as XenRule } : xenPrice(b.xen, c.spotE18, c.capE18);
        if (xen.priceE18 === 0n) return { ok: false, reason: 'No XEN price for this chain.' };
        // D-22 (c): the window's USDC.X factor on both XNT pool readings (the build price already carries it)
        const pegF = w.xntPegE18 ?? FP;
        const xntRead: [bigint, bigint] | null = b.xnt === null ? null : [pegged(b.xnt[0], pegF), pegged(b.xnt[1], pegF)];
        const xnt = xntPrice(xntRead, w.xBuildE18, w.xFloorE18);
        if (xnt.xE18 === 0n) return { ok: false, reason: 'No XNT price.' };
        // D-13: the L frozen at epoch n−1's build (or the v2 reading at the switch); without one, the pre-D-13 estimate
        const L = c.Lwindow ?? clampL(c.Lnow, c.Lprev);
        const Lrule: LRule | 'estimate' = c.Lwindow !== undefined ? c.Lrule ?? 'frozen' : 'estimate';
        const minVestEnt = w.vestMinEnt ?? VEST_MIN_ENT;
        const H = Math.floor(b.timestamp / HOUR);
        if (H < c.hour && (c.S > 0n || c.hourSpot > 0n)) return { ok: false, reason: 'The chain state is newer than the burn time.' };
        // runCurve: the current hour's group shares one pot; earlier groups are folded into S and decay per hour
        const S = H === c.hour ? c.S : decay(c.S + c.hourSpot, Math.max(0, H - c.hour));
        const sameHour = H === c.hour ? c.hourSpot : 0n;
        const spot = spotMicro(b.amountWei, xen.priceE18);
        const V = sameHour + spot;
        const value = L === 0n || V === 0n ? 0n : (L * L * spot) / ((L + S) * (L + S + V));
        const base = lamportsOf(value, xnt.xE18);
        const lp = (base * K_BPS) / BPS;
        const ent = (base * K_BPS * TIER_MULTIPLIER[b.tier]) / BPS;
        const band = ent - lp;
        const day = dayOf(b.timestamp, w.startTs);
        const cap = dayCap(w.C, day);
        const roomToday = max(0n, cap - w.senior);
        const roomWeek = max(0n, w.C - w.senior);
        const vests = b.tier > 0 && lp + band >= minVestEnt;
        const want = vests ? lp + band : lp;
        const claim = min(want, roomToday);
        const a = arrival(b.tier, lp, band, claim, minVestEnt);
        return {
            ok: true, epoch: w.epoch, priceE18: xen.priceE18, priceRule: xen.rule, xE18: xnt.xE18, xntRule: xnt.rule, L, Lrule, spot, value, base, lp, ent, band, day,
            roomToday, roomWeek, entitlement: want, claim, paidAtArrival: a.basePaid + a.bandPaid, basePaid: a.basePaid, bandPaid: a.bandPaid, lockedLp: a.lockedLp,
            leafTier: a.leafTier, converted: a.converted, junior: lp - a.basePaid, fitsWhole: claim === want && want > 0n, beyondCapacity: claim === 0n,
        };
    } catch (e: any) {
        return { ok: false, reason: `No quote: ${String(e?.message ?? e).slice(0, 160)}` };
    }
}

/** Books a burn (its arrival senior and spot) into the week state, as the build will (used by the planner and the tests). */
export function applyBurn(w: QuoteWeekState, b: QuoteInput, q: QuoteOk): QuoteWeekState {
    const c = w.chains.get(b.chainId)!;
    const H = Math.floor(b.timestamp / HOUR);
    const chains = new Map(w.chains);
    if (c.S === 0n && c.hourSpot === 0n) chains.set(b.chainId, { ...c, S: 0n, hour: H, hourSpot: q.spot }); // a chain's first burn starts its curve
    else if (H === c.hour) chains.set(b.chainId, { ...c, hourSpot: c.hourSpot + q.spot });
    else chains.set(b.chainId, { ...c, S: decay(c.S + c.hourSpot, Math.max(0, H - c.hour)), hour: Math.max(H, c.hour), hourSpot: q.spot });
    return { ...w, senior: w.senior + (q.basePaid + q.bandPaid), chains };
}

/**
 * The state at the START of epoch n's week, from the newest published v3 file (epoch n−1) and its publication record:
 * window start = published_at, C = min(8% of (free_pool_before − budget), 7 × 2% of the XDEX XNT reserve the file read at
 * its build) (D-22 a), each chain's frozen L (D-13: L.next; a chain without one is listed in `unfrozen`), curve, price cap
 * and orphaning (D-21) carried as rewards.ts prevState() does. `xntPegE18` = this window's USDC.X factor (D-22 c) when
 * known. Returns null (fail-closed) for anything but a published v3 file. Lnow = each chain's live reading (information).
 */
export function weekStartFromFile(f: any, Lnow: Map<number, bigint>, xBuildE18: bigint, asOf: number, opts: { xntPegE18?: bigint } = {}): QuoteWeekState | null {
    if (!f || f.version !== 3 || !f.publish) return null;
    const pub = f.publish;
    if (!Number.isSafeInteger(pub.publishedAt) || typeof pub.freePoolBefore !== 'string') return null;
    const budget = U(pub.fullBudget ?? pub.budget, 'publish.budget');
    const Fref = U(pub.freePoolBefore, 'publish.freePoolBefore') - budget;
    if (Fref < 0n) return null;
    const chains = new Map<number, QuoteChainState>();
    const skipped: number[] = [];
    const unfrozen: number[] = [];
    for (const c of f.chains ?? []) {
        const refInputs = [c.xenUsdE18, ...(c.refInputs ?? []).slice(0, 3)].map((x: string) => U(x, 'refInputs'));
        const refUsd = c.market ? U(c.market.refUsdE18, 'refUsdE18') : 0n;
        // D-21: an orphaning in force for epoch n values every burn at half the recorded reference
        const orphan = c.orphan && Number.isSafeInteger(c.orphan.from) && c.orphan.from <= f.epoch + 1 ? U(c.orphan.refE18, 'orphan.refE18') : undefined;
        const ref = orphan ?? (medianE18(refInputs) || refUsd);
        const L = Lnow.get(c.chainId);
        if (L === undefined || ref === 0n) { skipped.push(c.chainId); continue; }
        const wl = windowLOf(f, c.chainId);
        if (wl.L === null) unfrozen.push(c.chainId);
        chains.set(c.chainId, {
            chainId: c.chainId, Lprev: wl.prevL, Lnow: L,
            S: U(c.curveAfter.S, 'curveAfter.S'), hour: c.curveAfter.hour, hourSpot: 0n, capE18: (ref * PRICE_CAP_BPS) / BPS,
            spotE18: c.market ? min(U(c.market.spotE18, 'spotE18'), (ref * PRICE_CAP_BPS) / BPS) : 0n,
            ...(wl.L !== null ? { Lwindow: wl.L, Lrule: wl.rule } : {}),
            ...(orphan !== undefined ? { orphanRefE18: orphan } : {}),
        });
    }
    const prevX = U(f.xnt?.usdE18, 'xnt.usdE18');
    const planCash = (Fref * PLAN_BPS) / BPS;
    const tc = trancheCap(capReserveOf(f));
    const rules = f.rulesBlock === undefined ? null : rulesOf(f.rulesBlock);
    if (f.rulesBlock !== undefined && !rules) return null;
    return {
        epoch: f.epoch + 1, startTs: pub.publishedAt, C: tc === null ? planCash : min(planCash, tc), senior: 0n, xFloorE18: (prevX * XNT_FLOOR_BPS) / BPS, xBuildE18,
        chains, asOf, skipped, unfrozen, ...(opts.xntPegE18 !== undefined ? { xntPegE18: opts.xntPegE18 } : {}),
        ...(rules ? { vestMinEnt: rules.vestMinEnt, operatorWallets: rules.operatorWallets, rulesId: rules.rulesId } : {}),
    };
}

/**
 * The week state from the hourly week-so-far feed v1 (written by the v3 oracle, oracle/src/feed-v3.ts, and served with
 * the site at feed/week-so-far.json; dormant until the switch). ONE schema for every client: the FEED CONTRACT of
 * agents/kit/burn.mjs, whose example agents/kit/test/vectors/week-so-far.v1.json test/v3/week-so-far.test.ts quotes.
 * The site reads the derived part (Σ senior, each chain's curve state, capacity, XNT floor and build price, the current
 * hour's readings); the raw window (burns[], market, current) is what the kit and the oracle value, and the two forms
 * of each duplicated field must agree. A skipped chain stays in chains[] as { chainId, name, portal, status: 'skipped' }
 * with no derived fields and is never quoted. Every field is checked; the feed must continue the newest file (epoch
 * n−1's data hash) or nothing is quoted.
 */
export type FeedChainStatus = 'ok' | 'skipped' | 'quarantined' | 'sunset';
export interface WeekSoFarFeedChain {
    chainId: number;
    name?: string;
    portal?: string;
    /** absent = 'ok' */
    status?: FeedChainStatus;
    /** the derived fields (absent on a skipped chain) */
    Lprev?: string | null;
    Lnow?: string;
    S?: string;
    hour?: number;
    hourSpot?: string;
    capE18?: string;
    spotE18?: string;
    /** the raw twins of Lnow and readings.xen (the kit's form) */
    liquidityNowMicro?: string;
    current?: { hour: number; medianE18: string; lastCloseE18: string; priceSource?: string };
}
export interface WeekSoFarFeed {
    kind: 'week-so-far';
    version: 1;
    programId?: string;
    rules?: number;
    epoch: number;
    prevDataHash: string;
    prevEpoch?: { epoch: number; dataHash: string };
    asOf: number;
    window: { startTs: number };
    capacity: { cash: string; senior: string };
    /** twapE18 / apiE18: the raw XNT readings of the hour (D-22 c reads their ratio); buildE18 = max(pegged TWAP, api) */
    xnt: { twapE18?: string; apiE18?: string; floorE18: string; buildE18: string; current?: { hour: number; medianE18: string; lastCloseE18: string; source?: string } };
    chains: WeekSoFarFeedChain[];
    skipped: number[];
    /** T2-RULES: the rules block epoch `epoch` is built under (absent: the site's defaults, with no operator wallet) */
    rulesBlock?: unknown;
    /** at the v2 → v3 switch only: each v2 chain's last (up to) 4 readings and liquidity readings (r6-review 2: the switch L) */
    switchRefs?: unknown;
    /** D-17: epoch n is held by the anomaly gate (the build publishes nothing for up to 24 h) */
    flags?: { anomalyHold?: boolean };
    /**
     * The price readings a burn in hour `hour` (unix hours) is valued with: per chain the XEN 24-hour median and last
     * closed hourly close before that hour, and the same two for XNT (USD × 1e18 strings; null = no candles, the build
     * spot applies). A quote is refused when the current hour is not `hour`.
     */
    readings?: { hour: number; xen: Record<string, [string, string] | null>; xnt: [string, string] | null };
}
const isTs = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
/**
 * A readings pair and its raw twin agree, as the kit's normalizeFeed requires: the same hour, and either the same
 * [median, last close] read from candles or, for null (no candles), the raw form's 'fallback' reading "0", "0".
 */
function sameReading(pair: [string, string] | null | undefined, cur: { hour: number; medianE18: string; lastCloseE18: string; priceSource?: string; source?: string }, hour: number): boolean {
    if (pair === undefined) return true;
    const [m, l, src] = pair === null ? ['0', '0', 'fallback'] : Array.isArray(pair) && pair.length === 2 ? [String(pair[0]), String(pair[1]), 'candles'] : [null, null, null];
    return m !== null && cur.hour === hour && String(cur.medianE18) === m && String(cur.lastCloseE18) === l && (cur.priceSource ?? cur.source) === src;
}
/**
 * The week state of a week-so-far feed v1, or null (fail-closed) when the feed is not v1 for this program under rules 3,
 * does not continue `newest`, or any duplicated field disagrees with its twin. `programId` = the site's pinned id.
 *
 * `newestFile` = the newest published epoch file itself (epoch n−1, the one `newest` names). With it the state follows
 * D-13 option (a): each valued chain is valued at the L that file froze (L.next) or, at the switch, the median of its
 * last (up to) 4 v2 liquidity readings (switchRefs),
 * and a chain whose L is set only at the build is listed in `unfrozen` (no binding quote); the feed's Lprev must equal
 * the file's record. Without it (older callers) L is the pre-D-13 estimate clampL(Lnow, Lprev). The rules block
 * (dust minimum, operator wallets) and the USDC.X factor of D-22 (c) (from the raw XNT readings; buildE18 is their twin)
 * are read in both cases.
 */
export function weekStateFromFeed(feed: WeekSoFarFeed, newest: { epoch: number; dataHash: string } | null, programId?: string, newestFile?: any): QuoteWeekState | null {
    try {
        if (!feed || feed.kind !== 'week-so-far' || feed.version !== 1) return null;
        if (feed.rules !== 3) return null;
        if (programId !== undefined && feed.programId !== programId) return null;
        if (!isTs(feed.epoch) || !isTs(feed.asOf) || !isTs(feed.window?.startTs)) return null;
        if (!newest || feed.epoch !== newest.epoch + 1 || feed.prevDataHash !== newest.dataHash) return null;
        if (newestFile !== undefined && (!newestFile || newestFile.epoch !== newest.epoch || newestFile.dataHash !== newest.dataHash)) return null;
        const rules = feed.rulesBlock === undefined ? null : rulesOf(feed.rulesBlock);
        if (feed.rulesBlock !== undefined && !rules) return null;
        // D-22 (c): the factor of this hour's readings; the build price is max(pegged TWAP, x1report) (its twin)
        const twap = U(feed.xnt?.twapE18, 'xnt.twapE18');
        const api = U(feed.xnt?.apiE18, 'xnt.apiE18');
        const peg = xntPeg(twap, api);
        if (U(feed.xnt.buildE18, 'buildE18') !== max(pegged(twap, peg.factorE18), api)) return null;
        if (feed.prevEpoch !== undefined && (feed.prevEpoch?.epoch !== feed.epoch - 1 || feed.prevEpoch?.dataHash !== feed.prevDataHash)) return null;
        if (!Array.isArray(feed.chains)) return null;
        const listedSkipped = Array.isArray(feed.skipped);
        const skipped = new Set<number>(listedSkipped ? feed.skipped.map(Number) : []);
        const readings = feed.readings;
        if (readings !== undefined && (!readings || !isTs(readings.hour))) return null;
        const chains = new Map<number, QuoteChainState>();
        const held: number[] = [];
        const unfrozen: number[] = [];
        for (const c of feed.chains) {
            if (!Number.isSafeInteger(c?.chainId) || chains.has(c.chainId)) return null;
            // skipped[] and each chain's status are one fact written twice: they must agree (the kit's normalizeFeed rule)
            const listed = skipped.has(c.chainId);
            if (listed && c.status !== undefined && c.status !== 'skipped') return null;
            if (!listed && c.status === 'skipped' && listedSkipped) return null;
            const status = listed ? 'skipped' : (c.status ?? 'ok');
            if (status === 'skipped') { skipped.add(c.chainId); continue; }
            if (status !== 'ok' && status !== 'quarantined' && status !== 'sunset') return null;
            if (!isTs(c.hour)) return null;
            if (c.liquidityNowMicro !== undefined && String(c.liquidityNowMicro) !== String(c.Lnow)) return null;
            if (readings && c.current && !sameReading(readings.xen?.[String(c.chainId)], c.current, readings.hour)) return null;
            const Lprev = c.Lprev === null ? null : U(c.Lprev, 'Lprev');
            // D-13 (a): the L epoch n−1's build froze for this window; the feed's Lprev is the twin of the file's own L
            let frozen: { Lwindow: bigint; Lrule: LRule } | null = null;
            if (newestFile !== undefined) {
                const wl = windowLOf(newestFile, c.chainId, feed.switchRefs);
                if (wl.prevL !== Lprev) return null;
                if (wl.L === null) unfrozen.push(c.chainId);
                else frozen = { Lwindow: wl.L, Lrule: wl.rule };
            }
            chains.set(c.chainId, {
                chainId: c.chainId, Lprev, Lnow: U(c.Lnow, 'Lnow'), S: U(c.S, 'S'), hour: c.hour,
                hourSpot: U(c.hourSpot, 'hourSpot'), capE18: U(c.capE18, 'capE18'), spotE18: U(c.spotE18, 'spotE18'), ...(frozen ?? {}),
            });
            if (status !== 'ok') held.push(c.chainId);
        }
        if (readings && feed.xnt?.current && !sameReading(readings.xnt, feed.xnt.current, readings.hour)) return null;
        const C = U(feed.capacity.cash, 'cash');
        const senior = U(feed.capacity.senior, 'senior');
        if (senior > C) return null;
        return {
            epoch: feed.epoch, startTs: feed.window.startTs, C, senior,
            xFloorE18: U(feed.xnt.floorE18, 'floorE18'), xBuildE18: U(feed.xnt.buildE18, 'buildE18'), chains, asOf: feed.asOf, held,
            // a chain listed in skipped[] but absent from chains[] is skipped too (never quoted)
            skipped: [...skipped],
            ...(newestFile !== undefined ? { unfrozen } : {}),
            ...(peg.factorE18 !== FP ? { xntPegE18: peg.factorE18 } : {}),
            ...(rules ? { vestMinEnt: rules.vestMinEnt, operatorWallets: rules.operatorWallets, rulesId: rules.rulesId } : {}),
            ...(feed.flags?.anomalyHold === true ? { anomalyHold: true } : {}),
        };
    } catch {
        return null;
    }
}

/**
 * The site's quote of one burn made now, from a feed's week state and its current-hour readings (QuotePanel; the
 * cross-client check in test/v3/week-so-far.test.ts). Fail-closed, with the kit's live rules (burn.mjs quoteBurn): no
 * readings for this hour, a valued chain with no reading of its own in this hour's file, a device clock behind the
 * file (the burn would be ranked before burns already in it), or a burn within HOUR_EDGE_S of the hour's end gives
 * no quote. `x1` = the burn's X1 destination: a wallet the rules block lists as an operator wallet ranks after every
 * other burn of the week (D-18), so it gets no binding quote (inside a dated exception it is an ordinary burn).
 */
export function quoteFromWeek(
    w: QuoteWeekState | null,
    readings: WeekSoFarFeed['readings'] | null | undefined,
    b: { chainId: number; amountWei: bigint; tier: number; x1?: string | null },
    now = Math.floor(Date.now() / 1000),
): QuoteResult {
    if (w && now < w.asOf) return { ok: false, reason: 'This device’s clock is behind the week-so-far file: no quote until the clock is right.' };
    if (w?.operatorWallets && b.x1 && operatorOf(w.operatorWallets, b.x1, now).operator) {
        return { ok: false, reason: 'This X1 destination is listed as an operator wallet in the published rules: its burns rank after every other burn of the week, so no binding quote is given.' };
    }
    if (!readings || readings.hour !== Math.floor(now / HOUR)) return { ok: false, reason: 'The price readings for this hour are not published yet: no quote until they are.' };
    if (HOUR - (now % HOUR) < HOUR_EDGE_S) return { ok: false, reason: 'The hour is about to end: a burn sent now may land in the next hour and be priced on its readings. Wait a few minutes for the next quote.' };
    const own = !!readings.xen && Object.prototype.hasOwnProperty.call(readings.xen, String(b.chainId));
    const valued = !!w && w.chains.has(b.chainId) && !w.skipped.includes(b.chainId);
    if (valued && !own) return { ok: false, reason: 'This hour’s file carries no price reading for this chain: no quote.' };
    if (readings.xnt === undefined) return { ok: false, reason: 'This hour’s file carries no XNT reading: no quote.' };
    const xen = own ? readings.xen[String(b.chainId)] : null;
    const pair = (p: [string, string] | null): [bigint, bigint] | null => (p === null ? null : [U(p[0], 'reading'), U(p[1], 'reading')]);
    try {
        return quoteBurn(w, { chainId: b.chainId, amountWei: b.amountWei, tier: b.tier, timestamp: now, xen: pair(xen), xnt: pair(readings.xnt) }, now);
    } catch (e: any) {
        return { ok: false, reason: `No quote: ${String(e?.message ?? e).slice(0, 160)}` };
    }
}

/** When today's tranche opens (unix s) and how much of the week each day has released (planner, D-19 disclosure). */
export function trancheSchedule(w: Pick<QuoteWeekState, 'startTs' | 'C'>) {
    return Array.from({ length: EPOCH_DAYS }, (_, d) => ({ day: d, opensAt: w.startTs + d * DAY, cumulative: release(w.C, d + 1) }));
}
