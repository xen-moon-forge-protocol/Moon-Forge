/**
 * Rewards v3 for the kit: a line-by-line port of the oracle engine's valuation and allocation (oracle/src/rewards.ts
 * windowStateV3, the part of computeEpochV3 up to the targets: the rules block, curve with memory, closed-candle prices,
 * the frozen liquidity L (D-13, with the F5 "carried" rule of rulesId 2), entitlement at each burn's own XNT price with the USDC.X guard (D-22 c), the orphan
 * price (D-21), the keccak tie-break (D-14), the backlog and operator ranks (D-12, D-18), FCFS daily tranches capped by
 * the XDEX reserve (D-22 a), the mission piece rule, the leftover pass and the build-limit cut), so the kit computes
 * exactly what the oracle will pay. The golden vectors in test/vectors/quote-v3.json are produced by the oracle engine
 * itself (test/vectors/gen-quote-vectors.cjs) and checked byte for byte by test/unit/quote-v3.test.mjs, with a sha256
 * checksum the oracle, the site and the kit compare; test/unit/rules-vectors.test.mjs replays the oracle's own round-4
 * vectors (oracle/test/fixtures/rules-v3-vectors.json) the same way.
 *
 * NOTHING HERE APPLIES TODAY. The v3 rules are decided, not live: they apply from the epoch published on or after the
 * dated switch (announced at least one full epoch ahead). Until then the live v2 oracle pays an estimate and the kit
 * refuses to quote (burn.mjs fails closed).
 *
 * Inputs (all on X1's clock, amounts as decimal strings like the epoch files):
 *   prev    the previous epoch file (n − 1), v2 or v3, checked against its data hash
 *   inputs  { programId, epoch, window: { startTs, endTs }, freePool: { open, lamports? }, xnt: { twapE18, apiE18 },
 *             chains: [{ chainId, name, portal, market: { spotE18, refUsdE18 }, liquidityNowMicro, liquidityOnChainMicro?,
 *             liquiditySamples?, poolCreatedAt?, orphan?, burns: [BurnInputV3] }], switchRefs?, rulesBlock?, noMarket? }
 *             the shape of oracle/src/rewards.ts EpochInputsV3 for the window so far
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { PublicKey } from '@solana/web3.js';
import { dataHashBody, dataHashV2, protoPath } from './verify-leaf.mjs';

// ── policy constants (rewards.ts) ─────────────────────────────────────────────
export const BPS = 10_000n;
export const K_BPS = 12_500n;
export const PLAN_BPS = 800n;
export const PRICE_CAP_BPS = 12_500n;
export const L_GROWTH_BPS = 11_000n;
export const L_STEP_MICRO = 50_000_000n;
/** D-13: the next window's L is never below this share of the L in force (50%) */
export const L_DROP_BPS = 5_000n;
/** D-13: the statistic looks back this many day buckets from the window end (the minimum of the daily medians) */
export const L_STAT_DAYS = 7;
/**
 * D-13, F5 (the "carried" rule, rewards.ts L_MIN_SAMPLES_PER_DAY): a stat day with fewer than this many RECORDED hourly
 * samples (the week-so-far feed's; the build's own reading is not one of them) is a thin day
 */
export const L_MIN_SAMPLES_PER_DAY = 4;
/** D-13, F5 (rewards.ts L_MAX_THIN_DAYS): a valued chain with more than this many thin days of the L_STAT_DAYS (or no recorded sample) carries its L */
export const L_MAX_THIN_DAYS = 2;
/**
 * D-13, r6-review 2 (rewards.ts L_SWITCH_MIN_FULL_DAYS): at the switch epoch (epoch n−1 is a v2 file) the feed starts inside
 * the window, so the next L is clamped (not carried) when at least this many of the 7 stat days are full
 */
export const L_SWITCH_MIN_FULL_DAYS = 2;
/** D-13 first-reading clamp: $500 plus $50 per whole day of the price pool's age, counted up to 90 days */
export const L_FIRST_BASE_MICRO = 500_000_000n;
export const L_FIRST_PER_DAY_MICRO = 50_000_000n;
export const L_FIRST_MAX_DAYS = 90;
/** D-22 (a): a daily tranche is never more than 2% of the XDEX pool's XNT reserve read at the week start */
export const XDEX_TRANCHE_BPS = 200n;
/** D-22 (c): USDC.X more than 3% above $1 raises every XNT pool reading to the pool-safe price */
export const PEG_GUARD_BPS = 300n;
/** D-21: an orphaned chain's burns are valued at 50% of the reference recorded at its orphaning */
export const ORPHAN_SKIPS = 4;
export const ORPHAN_PRICE_BPS = 5_000n;
export const XNT_FLOOR_BPS = 6_000n;
export const EPOCH_DAYS = 7;
export const DAY = 86_400;
export const HOUR = 3_600;
/** a backlog or operator burn claims on the day of (window end + this) (D-12, D-18) */
export const CLOCK_SKEW_MAX = HOUR;
export const EPOCH_BUDGET_BPS = 1_000n;
export const REBUILD_DRIFT_BPS = 50n;
export const KEEPER_TIP = 2_000_000n;
/**
 * the upgraded program's keeper-tip minimum (rewards.ts KEEPER_TIP_MIN_CLAIM, forge.rs keeper_tip_due): a claim pays a
 * keeper tip from the free pool only from 100 × KEEPER_TIP = 0.2 XNT; the build limit sets one tip aside per such leaf
 */
export const KEEPER_TIP_MIN_CLAIM = 100n * KEEPER_TIP;
/** a vesting burn entitled to less than this (0.02 XNT) is paid as Launchpad (rewards.ts VEST_MIN_ENT; the rules block's dustRule.vestMinEnt) */
export const VEST_MIN_ENT = 10n * KEEPER_TIP;
export const TIER_MULTIPLIER = Object.freeze([1n, 2n, 3n]);
export const DECAY_Q = 997_939_188_356_834_408n;
export const FP = 10n ** 18n;
const U64 = 2n ** 64n;
const U256 = 2n ** 256n;

// ── the rules block (T2-RULES, D-12, D-14, D-18; rewards.ts) ──────────────────
export const TIE_BREAK_V3 = 'keccak256(txHash,logIndex)';
export const BACKLOG_RULE_V3 = 'after-current-senior,first-leftover';
export const OPERATOR_RULE_V3 = 'rank-last';
/**
 * the rules version this port implements (rewards.ts RULES_ID_V3). 2 since F5: rulesId 1 was the round-4 block, without
 * the D-13 "carried" rule (priceRules.liquidity had no minSamplesPerDay / maxThinDays); it was replaced before any v3
 * epoch was built and never applies to any epoch (RULES_ID_RETIRED_V3)
 */
export const RULES_ID_V3 = 2;
/** F5 (rewards.ts RULES_ID_RETIRED_V3): the rulesId replaced before the first v3 epoch: a block that claims it (or a lower one) is refused */
export const RULES_ID_RETIRED_V3 = 1;
export const AUTO_CLAIM_MIN_V3 = 0n;
export const EXCEPTION_NAME_MAX = 80;
/** D-13, D-22 (a, c), D-21, D-22 (b), D-17: the price rules this port implements (rewards.ts PRICE_RULES_V3, hashed in every v3 file) */
export const PRICE_RULES_V3 = Object.freeze({
  liquidity: Object.freeze({
    reading: 'min(geckoterminal,on-chain)', stat: 'min-of-full-day-medians', statDays: L_STAT_DAYS, freeze: 'previous-build', growthBps: Number(L_GROWTH_BPS),
    stepMicro: L_STEP_MICRO.toString(), dropBps: Number(L_DROP_BPS), firstBaseMicro: L_FIRST_BASE_MICRO.toString(), firstPerDayMicro: L_FIRST_PER_DAY_MICRO.toString(),
    firstMaxDays: L_FIRST_MAX_DAYS, minSamplesPerDay: L_MIN_SAMPLES_PER_DAY, maxThinDays: L_MAX_THIN_DAYS,
    switchL: 'median-of-v2-readings', switchMinFullDays: L_SWITCH_MIN_FULL_DAYS,
  }),
  xntTranche: Object.freeze({ maxReserveBps: Number(XDEX_TRANCHE_BPS) }),
  xntPeg: Object.freeze({ guardBps: Number(PEG_GUARD_BPS) }),
  orphan: Object.freeze({ skips: ORPHAN_SKIPS, priceBps: Number(ORPHAN_PRICE_BPS), notice: 'one-epoch' }),
  xntPool: Object.freeze({ metric: 'median-tvl', epochs: 4, switchX: 2, weeks: 2, notice: 'one-epoch' }),
  gate: Object.freeze({ walletShareBps: 6_000, leafCountX: 5, scoreX: 3, fallbackShareBps: 5_000, historyEpochs: 4, holdSeconds: DAY, firstChain: true, xntSourceChange: true }),
});
/** The rules block with nothing pinned and no operator wallet listed (rewards.ts DEFAULT_RULES_V3): what a file without one is valued under. */
export const DEFAULT_RULES_V3 = Object.freeze({
  programRules: 3, programHash: null, rulesId: RULES_ID_V3, tipMin: KEEPER_TIP_MIN_CLAIM.toString(), autoClaimMin: AUTO_CLAIM_MIN_V3.toString(),
  dustRule: Object.freeze({ vestMinEnt: VEST_MIN_ENT.toString() }), tieBreak: TIE_BREAK_V3, backlogRule: BACKLOG_RULE_V3,
  operatorWallets: Object.freeze({ rule: OPERATOR_RULE_V3, wallets: Object.freeze([]), exceptions: Object.freeze([]) }), priceRules: PRICE_RULES_V3,
});

/**
 * The switch, once announced: { date, firstEpoch, afterPublishTx } of the first v3 epoch: `date` the announced UTC date
 * (YYYY-MM-DD, the boundary notice's FIRST_V3_EPOCH_DATE), `afterPublishTx` the last v2 publish transaction (WORDING: a
 * date and that transaction, never an epoch number in public text). Null until the boundary announcement; a one-line change.
 */
export const V3_SWITCH = null;
/**
 * The opening words of every kit sentence about what the v3 oracle rules bring (WORDING §1: a sentence about the future
 * carries a date). Before the announcement the planned month; after it the announced date.
 */
export const V3_FROM = V3_SWITCH?.date
  ? `From the epoch published on or after ${V3_SWITCH.date} (UTC)`
  : 'From the first v3 epoch (planned for November 2026, announced at least one full epoch ahead)';

const min = (a, b) => (a < b ? a : b);
const max = (a, b) => (a > b ? a : b);
const ceilDiv = (a, b) => (a + b - 1n) / b;
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function uint(v, what, bound = U256) {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) throw new Error(`${what}: ${JSON.stringify(v)} is not a canonical unsigned integer`);
  const x = BigInt(v);
  if (x >= bound) throw new Error(`${what}: ${v} out of range`);
  return x;
}
export function nat(v, what) {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`${what}: ${JSON.stringify(v)} is not a safe non-negative integer`);
  return v;
}
const optUint = (v, what, bound) => (v === undefined || v === null ? null : uint(v, what, bound));
const exactKeys = (v, keys, what) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} is not an object`);
  const have = Object.keys(v).sort();
  const want = [...keys].sort();
  if (have.length !== want.length || have.some((k, i) => k !== want[i])) throw new Error(`${what} must have exactly the members ${want.join(', ')} (has ${have.join(', ')})`);
  return v;
};
const strictlyAscending = (xs, what) => {
  for (let i = 1; i < xs.length; i++) if (!(xs[i - 1] < xs[i])) throw new Error(`${what} must be strictly ascending (no duplicate): ${xs[i - 1]} before ${xs[i]}`);
};
const sortedJson = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const canonicalKeys = new Set();
/** A recorded address: the canonical base58 form of a 32-byte public key. */
export function pubkey(v, what) {
  if (typeof v === 'string' && canonicalKeys.has(v)) return v;
  let ok = false;
  try { ok = typeof v === 'string' && new PublicKey(v).toBase58() === v; } catch { ok = false; }
  if (!ok) throw new Error(`${what}: ${JSON.stringify(v)} is not a canonical base58 public key`);
  if (canonicalKeys.size > 100_000) canonicalKeys.clear();
  canonicalKeys.add(v);
  return v;
}

/**
 * The rules block `v` as the engine uses it, or a throw naming what is wrong (rewards.ts rulesBlockOf): programRules 3,
 * tipMin 0.2 XNT, autoClaimMin "0", the D-14 tie-break, the D-12 backlog rule, the D-18 rank-last rule and the price
 * rules are pinned; read from it: dustRule.vestMinEnt and the operator wallets with their dated exceptions.
 */
export function rulesBlockOf(v) {
  const o = exactKeys(v, ['autoClaimMin', 'backlogRule', 'dustRule', 'operatorWallets', 'priceRules', 'programHash', 'programRules', 'rulesId', 'tieBreak', 'tipMin'], 'rulesBlock');
  if (o.programRules !== 3) throw new Error(`rulesBlock.programRules ${JSON.stringify(o.programRules)}: a v3 file is published only on the upgraded program (3)`);
  if (o.programHash !== null && (typeof o.programHash !== 'string' || !/^[0-9a-f]{64}$/.test(o.programHash))) throw new Error(`rulesBlock.programHash ${JSON.stringify(o.programHash)} is not null or a lowercase sha256 hex`);
  if (typeof o.rulesId !== 'number' || !Number.isSafeInteger(o.rulesId) || o.rulesId < 1) throw new Error(`rulesBlock.rulesId ${JSON.stringify(o.rulesId)} is not a version number (1, 2, …)`);
  if (o.rulesId <= RULES_ID_RETIRED_V3) throw new Error(`rulesBlock.rulesId ${o.rulesId} was replaced before any v3 epoch was built (F5, the D-13 "carried" rule, is rulesId ${RULES_ID_V3}): it never applies to any epoch`);
  if (uint(o.tipMin, 'rulesBlock.tipMin', U64) !== KEEPER_TIP_MIN_CLAIM) throw new Error(`rulesBlock.tipMin ${String(o.tipMin)} is not the upgraded program's keeper-tip minimum ${KEEPER_TIP_MIN_CLAIM}`);
  if (uint(o.autoClaimMin, 'rulesBlock.autoClaimMin', U64) !== AUTO_CLAIM_MIN_V3) throw new Error(`rulesBlock.autoClaimMin ${String(o.autoClaimMin)}: the oracle claims every leaf, so the only value is "0"`);
  const dust = exactKeys(o.dustRule, ['vestMinEnt'], 'rulesBlock.dustRule');
  uint(dust.vestMinEnt, 'rulesBlock.dustRule.vestMinEnt', U64);
  if (o.tieBreak !== TIE_BREAK_V3) throw new Error(`rulesBlock.tieBreak ${JSON.stringify(o.tieBreak)} is not ${TIE_BREAK_V3}`);
  if (o.backlogRule !== BACKLOG_RULE_V3) throw new Error(`rulesBlock.backlogRule ${JSON.stringify(o.backlogRule)} is not ${BACKLOG_RULE_V3}`);
  const ow = exactKeys(o.operatorWallets, ['exceptions', 'rule', 'wallets'], 'rulesBlock.operatorWallets');
  if (ow.rule !== OPERATOR_RULE_V3) throw new Error(`rulesBlock.operatorWallets.rule ${JSON.stringify(ow.rule)} is not ${OPERATOR_RULE_V3}`);
  if (!Array.isArray(ow.wallets)) throw new Error('rulesBlock.operatorWallets.wallets is not an array');
  const wallets = ow.wallets.map((w, i) => pubkey(w, `rulesBlock.operatorWallets.wallets[${i}]`));
  strictlyAscending(wallets, 'rulesBlock.operatorWallets.wallets');
  if (!Array.isArray(ow.exceptions)) throw new Error('rulesBlock.operatorWallets.exceptions is not an array');
  const exceptions = ow.exceptions.map((x, i) => {
    const what = `rulesBlock.operatorWallets.exceptions[${i}]`;
    const e = exactKeys(x, ['fromTs', 'name', 'published', 'untilTs', 'wallets'], what);
    // eslint-disable-next-line no-control-regex
    if (typeof e.name !== 'string' || !e.name || e.name.length > EXCEPTION_NAME_MAX || e.name !== e.name.trim() || /[\u0000-\u001f\u007f]/.test(e.name)) {
      throw new Error(`${what}.name must be one trimmed line of 1 to ${EXCEPTION_NAME_MAX} characters`);
    }
    if (!Array.isArray(e.wallets) || !e.wallets.length) throw new Error(`${what}.wallets must list at least one wallet`);
    const ws = e.wallets.map((w, j) => pubkey(w, `${what}.wallets[${j}]`));
    strictlyAscending(ws, `${what}.wallets`);
    const fromTs = nat(e.fromTs, `${what}.fromTs`);
    const untilTs = nat(e.untilTs, `${what}.untilTs`);
    if (!(fromTs < untilTs)) throw new Error(`${what}: fromTs ${fromTs} must be before untilTs ${untilTs}`);
    const day = typeof e.published === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.published) ? Date.parse(`${e.published}T00:00:00.000Z`) : NaN;
    if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== e.published) throw new Error(`${what}.published ${JSON.stringify(e.published)} is not a YYYY-MM-DD date`);
    if (day / 1000 > fromTs) throw new Error(`${what}: published ${e.published}, after the exception starts (${fromTs}): an exception is published before its first burn`);
    return { name: e.name, wallets: ws, fromTs, untilTs, published: e.published };
  });
  if (sortedJson(o.priceRules) !== sortedJson(PRICE_RULES_V3)) throw new Error(`rulesBlock.priceRules ${String(sortedJson(o.priceRules)).slice(0, 200)} is not the price rules this kit implements`);
  strictlyAscending(exceptions.map((e) => e.name), 'rulesBlock.operatorWallets.exceptions (by name)');
  const spans = new Map();
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
    programRules: 3, programHash: o.programHash, rulesId: o.rulesId, tipMin: o.tipMin, autoClaimMin: o.autoClaimMin, dustRule: { vestMinEnt: dust.vestMinEnt },
    tieBreak: TIE_BREAK_V3, backlogRule: BACKLOG_RULE_V3, operatorWallets: { rule: OPERATOR_RULE_V3, wallets, exceptions }, priceRules: JSON.parse(JSON.stringify(PRICE_RULES_V3)),
  };
}

/**
 * D-18 with PROOF_BURN_RULE (c) (rewards.ts operatorOfV3): a wallet of a dated exception, inside [fromTs, untilTs), is an
 * ordinary burn recorded with the exception's name; any other listed wallet is an operator burn, ranked last.
 */
export function operatorOfV3(ow, x1, ts) {
  let listed = ow.wallets.includes(x1);
  for (const e of ow.exceptions) {
    if (!e.wallets.includes(x1)) continue;
    if (e.fromTs <= ts && ts < e.untilTs) return { operator: false, exception: e.name };
    listed = true;
  }
  return { operator: listed, exception: null };
}

const tieKeys = new Map();
/**
 * D-14 (rewards.ts tieKeyV3): keccak256(txHash ‖ logIndex as a 32-byte big-endian integer) as lowercase hex
 * (abi.encodePacked(bytes32, uint256)), compared as strings.
 */
export function tieKeyV3(txHash, logIndex) {
  const k = `${txHash}:${logIndex}`;
  const hit = tieKeys.get(k);
  if (hit !== undefined) return hit;
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error(`tie-break: txHash ${JSON.stringify(txHash)} is not 32 bytes of hex`);
  if (!Number.isSafeInteger(logIndex) || logIndex < 0) throw new Error(`tie-break: logIndex ${JSON.stringify(logIndex)} is not a safe non-negative integer`);
  const bytes = Buffer.concat([Buffer.from(txHash.slice(2), 'hex'), Buffer.from(BigInt(logIndex).toString(16).padStart(64, '0'), 'hex')]);
  const out = Buffer.from(keccak_256(bytes)).toString('hex');
  if (tieKeys.size > 200_000) tieKeys.clear();
  tieKeys.set(k, out);
  return out;
}

/** The quoted burn (no transaction yet, so no hash): it ranks after every burn stamped in the same second. */
const CANDIDATE = Symbol('the quoted burn');

// ── curve, prices, conversion ────────────────────────────────────────────────
export function decayFactor(hours) {
  if (!Number.isSafeInteger(hours) || hours < 0) throw new Error(`bad decay interval ${hours}`);
  let p = FP;
  for (const bit of hours.toString(2)) {
    p = (p * p) / FP;
    if (bit === '1') p = (p * DECAY_Q) / FP;
  }
  return p;
}
export const decay = (s, hours) => (hours === 0 || s === 0n ? s : (s * decayFactor(hours)) / FP);
export const curve = (L, x) => (L === 0n || x === 0n ? 0n : (L * x) / (L + x));
export const curvePot = (L, S, V) => (L === 0n || V === 0n ? 0n : (L * L * V) / ((L + S) * (L + S + V)));
export const lamportsOf = (micro, xE18) => (micro * 10n ** 21n) / xE18;
export function medianE18(values) {
  const v = values.filter((x) => x > 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (!v.length) return 0n;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2n;
}
export const clampL = (now, prev) => (prev === null ? now : min(now, (prev * L_GROWTH_BPS) / BPS + L_STEP_MICRO));
/** D-13: a reading is the lower of GeckoTerminal's and the on-chain depth (null on-chain: GeckoTerminal alone). */
export const liquidityReadingV3 = (gecko, onChain) => (onChain === null ? gecko : min(gecko, onChain));
function medianWithZeros(xs) {
  const v = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2n;
}
/**
 * D-13 (rewards.ts recordedLiquiditySamplesV3): the samples RECORDED for a window (the week-so-far feed's), checked:
 * strictly ascending unix hours, each at or before the window end. The build's own reading is not one of them.
 */
export function recordedLiquiditySamplesV3(recorded, endTs, what) {
  const list = recorded === undefined || recorded === null ? [] : recorded;
  if (!Array.isArray(list)) throw new Error(`${what} liquiditySamples is not an array`);
  const out = [];
  for (const [i, s] of list.entries()) {
    const o = exactKeys(s, ['hour', 'micro'], `${what} liquiditySamples[${i}]`);
    const hour = nat(o.hour, `${what} liquiditySamples[${i}].hour`);
    const micro = uint(o.micro, `${what} liquiditySamples[${i}].micro`);
    if (out.length && hour <= out[out.length - 1].hour) throw new Error(`${what} liquiditySamples: hour ${hour} after ${out[out.length - 1].hour} (strictly ascending)`);
    if (hour * HOUR > endTs) throw new Error(`${what} liquiditySamples: hour ${hour} is after the window end ${endTs}`);
    // a sample more than L_STAT_DAYS days before the end (a window longer than a week) is recorded and not counted
    out.push({ hour, micro });
  }
  return out;
}
/**
 * D-13 (rewards.ts liquidityDaysV3): the samples by stat day, day d = ⌊(endTs − hour start) / DAY⌋ (0 = the last 24 h),
 * only d < L_STAT_DAYS. The statistic (liquidityStatV3) and the F5 coverage (liquidityCarriedV3) bucket by this one function.
 */
export function liquidityDaysV3(samples, endTs) {
  const days = new Map();
  for (const s of samples) {
    const d = Math.floor((endTs - s.hour * HOUR) / DAY);
    if (d < 0 || d >= L_STAT_DAYS) continue;
    days.set(d, [...(days.get(d) ?? []), s.micro]);
  }
  return days;
}
/**
 * D-13, F5 (rewards.ts liquidityCarriedV3): whether a VALUED chain's next L is carried (next = L) instead of clamped
 * (nextLiquidityV3). `recorded` = the window's samples as recorded (recordedLiquiditySamplesV3; the build's own reading is
 * NOT one of them, it is the one reading taken at a known time). A stat day with fewer than L_MIN_SAMPLES_PER_DAY
 * recorded samples is thin; the next L is carried when more than L_MAX_THIN_DAYS of the L_STAT_DAYS days are thin, or
 * when no sample is recorded in them at all (no feed). An orphaned chain (D-21, `orphan`) is never carried: it has no
 * market and its reading is 0 by rule, so its frozen L keeps halving each week.
 */
export function liquidityCarriedV3(recorded, endTs, orphan, switchEpoch = false) {
  const days = liquidityDaysV3(recorded, endTs);
  let samples = 0;
  let thinDays = 0;
  for (let d = 0; d < L_STAT_DAYS; d++) {
    const n = days.get(d)?.length ?? 0;
    samples += n;
    if (n < L_MIN_SAMPLES_PER_DAY) thinDays++;
  }
  // r6-review 2: at the switch epoch, at least L_SWITCH_MIN_FULL_DAYS full days clamp the next L
  const thin = switchEpoch ? L_STAT_DAYS - thinDays < L_SWITCH_MIN_FULL_DAYS : thinDays > L_MAX_THIN_DAYS;
  return { carried: !orphan && (samples === 0 || thin), samples, thinDays };
}
function minOfDayMedians(days) {
  let out = null;
  for (const v of days) {
    const m = medianWithZeros(v);
    if (out === null || m < out) out = m;
  }
  if (out === null) throw new Error('the liquidity statistic has no sample');
  return out;
}
/** D-13 (rewards.ts liquidityStatV3): the minimum over the last 7 day buckets (counted back from the end) of each day's median reading, zeros included. */
export function liquidityStatV3(samples, endTs) {
  const days = liquidityDaysV3(samples, endTs);
  return minOfDayMedians(days.values());
}
/**
 * D-13, r6-review 3 (rewards.ts liquidityStatOfV3): the statistic the build records. Over the FULL stat days only (at least
 * L_MIN_SAMPLES_PER_DAY recorded samples) when there is one; else over every stat day with a recorded sample; the build's
 * own reading only when no sample is recorded in the 7 days. It is never added to recorded samples.
 */
export function liquidityStatOfV3(recorded, endTs, buildReading) {
  const days = liquidityDaysV3(recorded, endTs);
  const full = [...days.values()].filter((v) => v.length >= L_MIN_SAMPLES_PER_DAY);
  if (full.length) return minOfDayMedians(full);
  if (days.size) return minOfDayMedians(days.values());
  return buildReading;
}
/**
 * D-13, r6-review 2 (rewards.ts switchLiquidityV3): the switch window's L, the median (zeros excluded: a v2 "0" is no
 * reading) of the chain's last (up to) 4 v2 liquidity readings; null when none is above 0.
 */
export function switchLiquidityV3(readings) {
  const v = readings.filter((x) => x > 0n);
  return v.length ? medianWithZeros(v) : null;
}
/** D-13 first-reading cap: $500 + $50 per whole day of the price pool's age at the window start (at most 90 days; unknown = 0). */
export function firstLiquidityCapV3(poolCreatedAt, startTs) {
  const age = poolCreatedAt === null || poolCreatedAt > startTs ? 0 : Math.floor((startTs - poolCreatedAt) / DAY);
  return L_FIRST_BASE_MICRO + L_FIRST_PER_DAY_MICRO * BigInt(Math.min(age, L_FIRST_MAX_DAYS));
}
/** D-13: the L frozen for the next window: the statistic within [50% × L, 1.1 × L + $50]. */
export const nextLiquidityV3 = (stat, used) => max((used * L_DROP_BPS) / BPS, min(stat, (used * L_GROWTH_BPS) / BPS + L_STEP_MICRO));
/**
 * D-13 with the feed's option (a) (rewards.ts liquidityRuleV3): the L that values window n and why. `prev` = the chain's
 * record in epoch n−1's file { L, next, v2, switchL }. frozen: its L.next; switch: switchL, the median of the chain's
 * last (up to) 4 v2 liquidity readings (the v2 file's own reading when it is not given); legacy: a v3 record
 * written before D-13, min(stat, 1.1 × L + $50); genesis: no previous file at all; first: no L there, min(stat, cap).
 * Only 'frozen' and 'switch' are known before the build, so only they give a binding quote.
 */
export function liquidityRuleV3(prev, hasPrevFile, stat, cap) {
  if (prev && prev.next !== undefined && prev.next !== null) return { used: prev.next, rule: 'frozen', cap: null };
  // r6-review 2: at the switch, the median of the last (up to) 4 v2 liquidity readings (prev.switchL), else the v2 file's own
  if (prev && prev.v2 && prev.L !== null) return { used: prev.switchL ?? prev.L, rule: 'switch', cap: null };
  if (prev && prev.next === undefined && !prev.v2 && prev.L !== null) return { used: clampL(stat, prev.L), rule: 'legacy', cap: null };
  if (!hasPrevFile) return { used: stat, rule: 'genesis', cap: null };
  return { used: min(stat, cap), rule: 'first', cap };
}
/** The L rules a quote can be binding on: the L is known before the build (D-13 option a). */
export const BINDING_L_RULES = Object.freeze(['frozen', 'switch']);
/** D-22 (c) (rewards.ts xntPegV3): the USDC.X guard from the build's two XNT prices. */
export function xntPegV3(twapE18, apiE18) {
  if (twapE18 === 0n || apiE18 === 0n) return { usdcxUsdE18: null, guard: 'unread', factorE18: FP.toString() };
  const usdcx = (apiE18 * FP) / twapE18;
  if (usdcx * BPS > FP * (BPS + PEG_GUARD_BPS)) return { usdcxUsdE18: usdcx.toString(), guard: 'high', factorE18: usdcx.toString() };
  if (usdcx * BPS < FP * (BPS - PEG_GUARD_BPS)) return { usdcxUsdE18: usdcx.toString(), guard: 'low', factorE18: FP.toString() };
  return { usdcxUsdE18: usdcx.toString(), guard: 'ok', factorE18: FP.toString() };
}
/** D-22 (a): the week's cap on C from the XDEX XNT reserve at the week start: 7 daily tranches of 2% of it (null: no cap). */
export const trancheCapV3 = (capReserve) => (capReserve === null ? null : BigInt(EPOCH_DAYS) * ((capReserve * XDEX_TRANCHE_BPS) / BPS));
/** A recorded XDEX reading (D-22 a), checked; null for null or absent. */
export function xdexReadingOf(v, what) {
  if (v === undefined || v === null) return null;
  const o = exactKeys(v, ['feeBps', 'pool', 'slot', 'usdcReserveMicro', 'wxntReserveLamports'], what);
  const feeBps = nat(o.feeBps, `${what}.feeBps`);
  if (feeBps >= 10_000) throw new Error(`${what}.feeBps ${feeBps} is not below 100%`);
  return {
    pool: pubkey(o.pool, `${what}.pool`), slot: nat(o.slot, `${what}.slot`),
    wxntReserveLamports: uint(o.wxntReserveLamports, `${what}.wxntReserveLamports`, U64).toString(),
    usdcReserveMicro: uint(o.usdcReserveMicro, `${what}.usdcReserveMicro`, U64).toString(), feeBps,
  };
}
/** The XDEX reserve that caps the window after `prev` (D-22 a): its reading at its build, else its own capReserve, else none. */
export function capReserveOf(prev) {
  if (!prev || prev.version !== 3) return null;
  const px = prev.xdex;
  const atBuild = px ? xdexReadingOf(px.atBuild, `epoch-${prev.epoch}.json xdex.atBuild`) : null;
  return atBuild ? BigInt(atBuild.wxntReserveLamports) : px ? optUint(px.capReserve, `epoch-${prev.epoch}.json xdex.capReserve`, U64) : null;
}
/** The week's cash capacity after `prev` with F_ref: ⌊8% F_ref⌋, never above the D-22 (a) cap. */
export function weekCapacityV3(Fref, prev) {
  const planCash = (BigInt(Fref) * PLAN_BPS) / BPS;
  const trancheCap = trancheCapV3(capReserveOf(prev ?? null));
  return { planCash, trancheCap, C: trancheCap === null ? planCash : min(planCash, trancheCap) };
}
export function priceReadings(median, last, source, what) {
  if (source === 'fallback') {
    if (median !== '0' || last !== '0') throw new Error(`${what}: a fallback price records no candle readings ("0")`);
    return null;
  }
  if (source !== 'candles') throw new Error(`${what}: unknown price source ${JSON.stringify(source)}`);
  const m = uint(median, `${what} median`), l = uint(last, `${what} last close`);
  if (m === 0n || l === 0n) throw new Error(`${what}: no candle price (record it as "fallback")`);
  return [m, l];
}
export function xenPrice(r, spotE18, capE18) {
  const low = r === null ? spotE18 : min(r[0], r[1]);
  if (capE18 < low) return { priceE18: capE18, rule: 'cap' };
  if (r === null) return { priceE18: spotE18, rule: 'spot' };
  return r[1] < r[0] ? { priceE18: r[1], rule: 'last' } : { priceE18: r[0], rule: 'median' };
}
export function xntPrice(r, buildE18, floorE18) {
  const high = r === null ? buildE18 : max(r[0], r[1]);
  if (floorE18 > high) return { xE18: floorE18, rule: 'floor' };
  if (r === null) return { xE18: buildE18, rule: 'build' };
  return r[1] > r[0] ? { xE18: r[1], rule: 'last' } : { xE18: r[0], rule: 'median' };
}
export const spotMicro = (amountWei, priceE18) => (amountWei * priceE18) / 10n ** 30n;
export function runCurve(burns, L, start) {
  let S = start.S;
  let hour = start.hour;
  const values = burns.map(() => 0n);
  for (let i = 0; i < burns.length;) {
    const H = burns[i].hour;
    let j = i;
    let V = 0n;
    while (j < burns.length && burns[j].hour === H) V += burns[j++].spot;
    S = decay(S, Math.max(0, H - hour));
    const den = (L + S) * (L + S + V);
    for (let k = i; k < j; k++) values[k] = L === 0n || V === 0n ? 0n : (L * L * burns[k].spot) / den;
    S += V;
    hour = Math.max(hour, H);
    i = j;
  }
  return { values, after: { S, hour } };
}
/**
 * Global order (D-14): (timestamp, keccak256(txHash ‖ logIndex)); chainId, blockNumber and logIndex only break a tie of
 * the hash itself. The quoted burn has no hash yet: it ranks after every burn of its second (its number never relies
 * on arriving before a burn already stamped the same second).
 */
export function globalOrder(a, b) {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  const qa = a[CANDIDATE] === true, qb = b[CANDIDATE] === true;
  if (qa !== qb) return qa ? 1 : -1;
  const ka = tieKeyV3(a.txHash, a.logIndex);
  const kb = tieKeyV3(b.txHash, b.logIndex);
  return cmpStr(ka, kb) || a.chainId - b.chainId || a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
}
export const dayOf = (timestamp, startTs) => Math.max(0, Math.floor((timestamp - startTs) / DAY));
/** the cumulative cash cap after k of 7 days that release R (the first R mod 7 days release one lamport more) */
export const release = (R, k) => (R / BigInt(EPOCH_DAYS)) * BigInt(k) + min(BigInt(k), R % BigInt(EPOCH_DAYS));
/** the cumulative cap open on tranche day `day` (0-based): after day 6 the whole C is open */
export const capOnDay = (C, day) => (day < EPOCH_DAYS ? release(C, day + 1) : C);
/** ⌊8% of F_ref⌋ before the D-22 (a) cap (weekCapacityV3 applies it) */
export const capacityOf = (Fref) => (Fref * PLAN_BPS) / BPS;
// D-47: the oracle allowance (rent + top-up, capped at 1% of the free pool) is paid out of the bound, so the build limit is bound - min(allowance, bound/10).
export const ORACLE_ALLOWANCE = 52_331_600n;
export const buildLimit = (freePool) => { const bound = (((freePool * (BPS - REBUILD_DRIFT_BPS)) / BPS) * EPOCH_BUDGET_BPS) / BPS; const a = bound / 10n; return bound - (ORACLE_ALLOWANCE < a ? ORACLE_ALLOWANCE : a); };

// ── allocation (rewards.ts allocateBurns, lockPiece, limitGate, fitClaim, rankOrderV3) ─────
export const allocItem = (tier, day, lp, band) => ({ tier, day, lp, band, senior: 0n, basePaid: 0n, bandPaid: 0n, lockedLp: 0n, converted: false, leafTier: 0 });
export function lockPiece(lp, band, claim, minVestEnt) {
  if (band <= 0n || lp <= 0n || claim <= 0n) return null;
  if (claim >= lp + band) return { lp, band, cash: 0n };
  const band1 = (claim * band) / (lp + band);
  const lp1 = band1 === 0n ? 0n : ceilDiv(band1 * lp, band);
  if (lp1 === 0n || lp1 > lp || lp1 + band1 > claim || lp1 + band1 < minVestEnt) return null;
  const cash = min(claim - lp1 - band1, lp - lp1);
  return { lp: lp1, band: band1, cash };
}
function settleArrival(w, claim, vests, minVestEnt) {
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
    w.senior = min(w.lp, claim);
    w.basePaid = w.senior;
    w.converted = w.tier > 0;
  }
}
const spareTips = (a, thresholds) => BigInt(thresholds.filter((t) => t <= a).length);
export function fitClaim(room, thresholds) {
  const ts = [...thresholds].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  for (let j = ts.length; j >= 0; j--) {
    const lo = j === 0 ? 0n : ts[j - 1];
    let cand = room - KEEPER_TIP * BigInt(j);
    if (j < ts.length) cand = min(cand, ts[j] - 1n);
    if (cand >= lo && cand >= 0n) return cand;
  }
  return 0n;
}
export function limitGate(limit, walletOf) {
  const targets = new Map();
  let paid = 0n;
  let tipped = 0n;
  const k = (x1, tier) => `${x1}:${tier}`;
  return {
    room: () => limit - paid - KEEPER_TIP * tipped,
    launchpad: (i) => targets.get(k(walletOf(i), 0)) ?? 0n,
    add: (i, leafTier, toTier, toZero) => {
      const x1 = walletOf(i);
      for (const [tier, v] of [[leafTier, toTier], [0, toZero]]) {
        if (v <= 0n) continue;
        const before = targets.get(k(x1, tier)) ?? 0n;
        targets.set(k(x1, tier), before + v);
        paid += v;
        if (before < KEEPER_TIP_MIN_CLAIM && before + v >= KEEPER_TIP_MIN_CLAIM) tipped++;
      }
    },
  };
}
/**
 * rewards.ts allocateBurns with its D-12 / D-18 plan (stages of an arrival pass then a leftover pass, each claiming only
 * what the earlier ones left; the identity plan when absent). Every item also keeps `arrival` (its outcome at its own
 * arrival, before any leftover top-up) and `roomAtArrival` (the room of its day when it arrived).
 */
export function allocateBurns(ws, C, minVestEnt = VEST_MIN_ENT, gate, plan) {
  const stages = plan?.stages ?? [{ arrival: ws.map((_, i) => i), leftover: ws.map((_, i) => i) }];
  for (const pass of ['arrival', 'leftover']) {
    const all = stages.flatMap((st) => st[pass]);
    if (all.length !== ws.length || new Set(all).size !== ws.length || all.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= ws.length)) {
      throw new Error(`the allocation plan's ${pass} lists must hold every item exactly once`);
    }
  }
  if (stages.some((st) => new Set(st.arrival).size !== new Set([...st.arrival, ...st.leftover]).size || st.arrival.length !== st.leftover.length)) {
    throw new Error('each stage of the allocation plan pays the same items at the arrival and in the leftover');
  }
  const tau = C / BigInt(EPOCH_DAYS);
  const vests = (w) => w.tier > 0 && w.lp + w.band >= minVestEnt;
  let senior = 0n, consumed = 0n, lastDay = 0, bandTotal = 0n, bandPaid = 0n, locked = 0, split = 0, converted = 0;
  let cut = null;
  for (const stage of stages) {
    for (const i of stage.arrival) {
      const w = ws[i];
      if (w.day < lastDay) throw new Error('allocation items must be in global order');
      lastDay = w.day;
      const cap = capOnDay(C, w.day);
      const v = vests(w);
      if (v) bandTotal += w.band;
      const room = max(0n, cap - consumed);
      const claim = cut ? 0n : min(v ? w.lp + w.band : w.lp, room);
      w.roomAtArrival = room;
      settleArrival(w, claim, v, minVestEnt);
      if (gate && !cut && w.senior > 0n) {
        const r = gate.room();
        const t0 = gate.launchpad(i);
        const th = [...(t0 < KEEPER_TIP_MIN_CLAIM ? [KEEPER_TIP_MIN_CLAIM - t0] : []), max(1n, min(KEEPER_TIP_MIN_CLAIM, minVestEnt))];
        if (w.senior + KEEPER_TIP * spareTips(w.senior, th) > r) {
          const take = fitClaim(r, th);
          settleArrival(w, take, v, minVestEnt);
          cut = { stage: 'arrival', kept: i, wanted: claim, claim: take };
        }
        gate.add(i, w.leafTier, w.lockedLp + w.bandPaid, w.basePaid - w.lockedLp);
      }
      w.arrival = { senior: w.senior, basePaid: w.basePaid, bandPaid: w.bandPaid, lockedLp: w.lockedLp, converted: w.converted, leafTier: w.leafTier, claim };
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
        const r = gate.room();
        const t0 = gate.launchpad(i);
        const th = t0 < KEEPER_TIP_MIN_CLAIM ? [KEEPER_TIP_MIN_CLAIM - t0] : [];
        if (take + KEEPER_TIP * spareTips(take, th) > r) {
          const wanted = take;
          take = fitClaim(r, th);
          cut = { stage: 'leftover', kept: i, wanted, claim: take };
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
/** D-12 / D-18: 0 = a burn of the window, 1 = a skipped chain's backlog, 2 = an operator burn. */
export const rankClassV3 = (w) => (w.operator ? 2 : w.backlog ? 1 : 0);
/**
 * D-12 / D-18 (rewards.ts rankOrderV3): the arrival order (the window's burns, the backlog, the operator burns, each in the
 * order given) and the plan: stage 1 = the window's burns then the backlog at the arrival, the backlog then the window's
 * burns in the leftover; stage 2 = the operator burns, after every other claim.
 */
export function rankOrderV3(globalSorted) {
  const arrival = [0, 1, 2].flatMap((k) => globalSorted.filter((w) => rankClassV3(w) === k));
  const idx = (k) => arrival.flatMap((w, i) => (rankClassV3(w) === k ? [i] : []));
  return { arrival, plan: { stages: [{ arrival: [...idx(0), ...idx(1)], leftover: [...idx(1), ...idx(0)] }, { arrival: idx(2), leftover: idx(2) }] } };
}

// ── the previous file → carried state (rewards.ts prevState, v2 and v3) ────────
function v2Curve(burns) {
  const sorted = [...burns].sort((a, b) => a.timestamp - b.timestamp || a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  let S = 0n;
  let hour = sorted.length ? Math.floor(sorted[0].timestamp / HOUR) : 0;
  for (const b of sorted) {
    const H = Math.floor(b.timestamp / HOUR);
    S = decay(S, Math.max(0, H - hour));
    S += spotMicro(BigInt(b.amountWei), BigInt(b.priceE18 ?? '0'));
    hour = Math.max(hour, H);
  }
  return { S, hour };
}
/**
 * The state the engine carries from the previous file: per chain L (the one in force and the one frozen for this window,
 * D-13), curve, reference inputs (and the v2 reading for the switch), whether it was skipped (D-12), its run of skips and
 * orphaning (D-21); the XNT reference, the rules version and the XDEX reserve that caps this window (D-22 a). Checks the
 * file against its own data hash, so a tampered previous file is refused. A heartbeat file (round 4) is read like any v3 file.
 */
export function prevState(prev) {
  const chains = new Map();
  if (!prev) return { version: null, epoch: 0, chains, x: null, rulesId: null, capReserve: null };
  const proto = protoPath(prev);
  if (proto) throw new Error(`epoch-${prev.epoch}.json has a "__proto__" member at ${proto}`);
  if (prev.version === 3) {
    for (const c of prev.chains) {
      const at = `epoch-${prev.epoch}.json chain ${c.chainId}`;
      const nx = c.L?.next;
      const run = c.noMarketRun;
      const o = c.orphan;
      chains.set(nat(c.chainId, 'previous chain id'), {
        chainId: c.chainId, name: c.name, toBlock: c.toBlock,
        L: c.L.used === null ? null : BigInt(c.L.used),
        next: nx === undefined ? undefined : optUint(nx, `${at} L.next`),
        v2: false,
        curve: { S: BigInt(c.curveAfter.S), hour: c.curveAfter.hour },
        refInputs: [c.xenUsdE18, ...c.refInputs.slice(0, 3)].map(BigInt),
        v2Reading: null,
        skipped: c.skipped === true,
        noMarketRun: run ? { skips: nat(run.skips, `${at} noMarketRun.skips`), refE18: uint(run.refE18, `${at} noMarketRun.refE18`) } : null,
        orphan: o ? { refE18: uint(o.refE18, `${at} orphan.refE18`), from: nat(o.from, `${at} orphan.from`) } : null,
      });
    }
    if (dataHashBody(prev) !== prev.dataHash) throw new Error(`epoch-${prev.epoch}.json does not match its data hash`);
    const rulesId = prev.rulesBlock === undefined ? null : rulesBlockOf(prev.rulesBlock).rulesId;
    return { version: 3, epoch: prev.epoch, chains, x: BigInt(prev.xnt.usdE18), rulesId, capReserve: capReserveOf(prev) };
  }
  if (prev.version === 2) {
    for (const c of prev.chains) {
      const L = BigInt(c.liquidityUsdMicro || '0');
      chains.set(nat(c.chainId, 'previous chain id'), {
        chainId: c.chainId, name: c.name, toBlock: c.toBlock,
        L: L > 0n ? L : null, next: undefined, v2: true,
        curve: v2Curve(prev.burns.filter((b) => b.chainId === c.chainId)),
        refInputs: [],
        v2Reading: BigInt(c.xenUsdE18 || '0'),
        skipped: false, noMarketRun: null, orphan: null,
      });
    }
    if (dataHashV2(prev) !== prev.dataHash) throw new Error(`epoch-${prev.epoch}.json (v2) does not match its data hash`);
    const x = BigInt(prev.xnt.usdE18 || '0');
    return { version: 2, epoch: prev.epoch, chains, x: x > 0n ? x : null, rulesId: null, capReserve: null };
  }
  throw new Error(`unknown version of epoch file ${prev?.epoch}`);
}
function applySwitchRefs(p, refs) {
  if (p.version !== 2) {
    if (refs !== null && refs !== undefined) throw new Error('switchRefs are recorded only at the v2 → v3 switch');
    return;
  }
  if (!Array.isArray(refs)) throw new Error('the v2 → v3 switch needs switchRefs: the last (up to) 4 v2 readings of every chain');
  let last = null;
  let n = 0;
  for (const r of refs.map((x) => ({ chainId: nat(x.chainId, 'switchRefs chain id'), readings: x.readings, liquidity: x.liquidity })).sort((a, b) => a.chainId - b.chainId)) {
    const pc = p.chains.get(r.chainId);
    if (!pc) throw new Error(`switchRefs: chain ${r.chainId} is not in the v2 file`);
    if (last === r.chainId) throw new Error(`switchRefs: chain ${r.chainId} twice`);
    if (!Array.isArray(r.readings) || r.readings.length < 1 || r.readings.length > 4) throw new Error(`switchRefs ${r.chainId}: 1 to 4 readings`);
    const readings = r.readings.map((x, i) => uint(x, `switchRefs ${r.chainId}[${i}]`));
    if (readings[0] !== pc.v2Reading) throw new Error(`switchRefs ${r.chainId}: the first reading must be epoch ${p.epoch}'s xenUsdE18`);
    // r6-review 2 (rewards.ts applySwitchRefs): the v2 liquidity readings of the same files; the switch L is their median
    if (!Array.isArray(r.liquidity) || r.liquidity.length !== readings.length) throw new Error(`switchRefs ${r.chainId}: one liquidity reading per reading (the v2 files' liquidityUsdMicro)`);
    const liquidity = r.liquidity.map((x, i) => uint(x, `switchRefs ${r.chainId} liquidity[${i}]`));
    if (liquidity[0] !== (pc.L ?? 0n)) throw new Error(`switchRefs ${r.chainId}: the first liquidity reading must be epoch ${p.epoch}'s liquidityUsdMicro`);
    pc.refInputs = readings;
    pc.switchL = switchLiquidityV3(liquidity);
    last = r.chainId;
    n++;
  }
  if (n !== p.chains.size) throw new Error('switchRefs must list every chain of the v2 file');
}

/** A burn of this chain has no XEN price (no candles and a build spot of 0): the engine skips the chain this epoch. */
export class NoXenPriceError extends Error {
  constructor(chainId, burnId) {
    super(`burn ${burnId}: no XEN price (no candles and a build spot of 0): skip chain ${chainId} this epoch`);
    this.name = 'NoXenPriceError';
    this.chainId = chainId;
  }
}

function checkBurn(b, chainId, endTs) {
  const id = `${String(b.chainId)}:${String(b.txHash)}:${String(b.logIndex)}`;
  if (b.chainId !== chainId) throw new Error(`burn ${id} listed under chain ${chainId}`);
  if (b[CANDIDATE] !== true && (typeof b.txHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(b.txHash))) throw new Error(`burn ${id}: bad txHash (0x and 64 lowercase hex digits)`);
  nat(b.blockNumber, `burn ${id} blockNumber`);
  nat(b.logIndex, `burn ${id} logIndex`);
  if (nat(b.timestamp, `burn ${id} timestamp`) > endTs + CLOCK_SKEW_MAX) throw new Error(`burn ${id} is after the build (more than ${CLOCK_SKEW_MAX} s past the window end ${endTs})`);
  if (!Number.isInteger(b.tier) || b.tier < 0 || b.tier > 2) throw new Error(`burn ${id}: bad tier`);
  uint(b.amountWei, `burn ${id} amountWei`);
  pubkey(b.x1, `burn ${id} x1`);
  return b;
}

/**
 * The window's valuation and allocation (rewards.ts windowStateV3): every burn's price, value, entitlement and payout,
 * in the ARRIVAL order (the window's burns in the global order, then the backlog, then the operator burns), and the
 * capacity. `inputs.freePool.lamports`, when given, applies the build limit (the shortfall cut) exactly as the build
 * does (applyLimit); without it the plain FCFS run is returned. `candidate` (quoteBurn) is one burn more, with no hash
 * yet. Returns { C, tau, Fref, planCash, trancheCap, startTs, endTs, xBuild, xFloor, peg, rulesBlock, chains:
 * Map(chainId → { L, Lprev, Lrule, Lstat, Lnext, LnextRule, Lcoverage, Lcap, curveStart, curveAfter, priceCapE18, ref,
 * spotE18, xenUsdE18, orphan }), plan, cut, shortfall, capacity: {...}, burns: [...] }. LnextRule (F5): 'clamp' (Lnext =
 * nextLiquidityV3) or 'carried' (the window feed was missing or thin: Lnext = L); Lcoverage = liquidityCarriedV3's result.
 */
export function allocateWindow(prev, inputs, { applyLimit = true, candidate = null } = {}) {
  const proto = protoPath(inputs);
  if (proto) throw new Error(`inputs have a "__proto__" member at ${proto}`);
  const p = prevState(prev ?? null);
  const epoch = inputs.epoch === undefined ? p.epoch + 1 : nat(inputs.epoch, 'epoch');
  const rulesBlock = rulesBlockOf(inputs.rulesBlock ?? DEFAULT_RULES_V3);
  if (p.rulesId !== null && rulesBlock.rulesId < p.rulesId) throw new Error(`rulesBlock.rulesId ${rulesBlock.rulesId} is below the previous file's ${p.rulesId}: a rules version never goes back`);
  const minVestEnt = BigInt(rulesBlock.dustRule.vestMinEnt);
  const startTs = nat(inputs.window.startTs, 'window.startTs');
  const cand = candidate ? Object.assign({ ...candidate }, { [CANDIDATE]: true }) : null;
  const allTs = [...inputs.chains.flatMap((c) => c.burns.map((b) => b.timestamp)), ...(cand ? [cand.timestamp] : [])];
  // the window end (an X1 instant at the build; the feed's asOf); a quote at a later second extends it to the quote's time
  let endTs = inputs.window.endTs === undefined || inputs.window.endTs === null ? Math.max(startTs, ...allTs) : nat(inputs.window.endTs, 'window.endTs');
  if (cand) endTs = Math.max(endTs, nat(cand.timestamp, 'candidate timestamp'));
  const twap = uint(inputs.xnt.twapE18, 'xnt.twapE18'), api = uint(inputs.xnt.apiE18, 'xnt.apiE18');
  // D-22 (c): a USDC.X premium above 3% raises every pool reading (the TWAP and the candles) to the pool-safe price
  const peg = xntPegV3(twap, api);
  const pegF = BigInt(peg.factorE18);
  const pegged = (x) => (pegF === FP ? x : (x * pegF) / FP);
  const xBuild = max(pegged(twap), api);
  if (xBuild === 0n) throw new Error('no XNT price');
  const xFloor = p.x === null ? 0n : (p.x * XNT_FLOOR_BPS) / BPS;
  applySwitchRefs(p, inputs.switchRefs);
  const noMarket = new Set((inputs.noMarket ?? []).map((x) => nat(x, 'noMarket chain id')));
  const works = [];
  const chains = new Map();
  const events = new Set();
  for (const c of [...inputs.chains].sort((a, b) => a.chainId - b.chainId)) {
    if (chains.has(c.chainId)) throw new Error(`chain ${c.chainId} twice`);
    if (noMarket.has(c.chainId)) throw new Error(`${c.name}: listed in noMarket and valued`);
    const pc = p.chains.get(c.chainId);
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
    // D-13: the reading (min of GeckoTerminal and on-chain), the window's hourly samples and the pool's age
    const Lchain = optUint(c.liquidityOnChainMicro, `${c.name} liquidityOnChainMicro`);
    const poolCreatedAt = c.poolCreatedAt === undefined || c.poolCreatedAt === null ? null : nat(c.poolCreatedAt, `${c.name} poolCreatedAt`);
    const recorded = recordedLiquiditySamplesV3(c.liquiditySamples, endTs, c.name);
    const list = cand && cand.chainId === c.chainId ? [...c.burns, cand] : c.burns;
    const burns = list.map((b) => checkBurn(b, c.chainId, endTs)).sort(globalOrder);
    if (burns.length && ref === 0n) throw new Error(`${c.name}: burns but no price reference`);
    // D-12: the burns of a chain the previous file skipped (or did not list) stamped before the window start are its backlog
    const backlogChain = p.version !== null && (pc === undefined || pc.skipped);
    const cw = burns.map((b) => {
      const id = `${b.chainId}:${b.txHash}:${b.logIndex}`;
      if (b[CANDIDATE] !== true) {
        for (const k of [`${b.chainId}:${b.txHash}:${b.logIndex}`, `${b.chainId}:#${b.blockNumber}:${b.logIndex}`]) {
          if (events.has(k)) throw new Error(`duplicate burn event ${k}`);
          events.add(k);
        }
      }
      if (orphan && (b.priceSource !== 'orphan' || b.medianE18 !== '0' || b.lastCloseE18 !== '0')) throw new Error(`burn ${id}: a burn of an orphaned chain records priceSource "orphan" and no readings`);
      if (!orphan && b.priceSource === 'orphan') throw new Error(`burn ${id}: priceSource "orphan" on a chain that is not orphaned`);
      const xen = orphan ? { priceE18: (orphan.refE18 * ORPHAN_PRICE_BPS) / BPS, rule: 'orphan' } : xenPrice(priceReadings(b.medianE18, b.lastCloseE18, b.priceSource, `burn ${id} XEN`), spotE18, cap);
      if (xen.priceE18 === 0n) throw new NoXenPriceError(c.chainId, id);
      const xr = priceReadings(b.xntMedianE18, b.xntLastCloseE18, b.xntSource, `burn ${id} XNT`);
      const xnt = xntPrice(xr === null ? null : [pegged(xr[0]), pegged(xr[1])], xBuild, xFloor);
      const op = operatorOfV3(rulesBlock.operatorWallets, b.x1, b.timestamp);
      return {
        ...allocItem(b.tier, dayOf(b.timestamp, startTs), 0n, 0n), b, priceE18: xen.priceE18, priceRule: xen.rule, x: xnt.xE18, xntRule: xnt.rule,
        hour: Math.floor(b.timestamp / HOUR), spot: spotMicro(uint(b.amountWei, `burn ${id} amountWei`), xen.priceE18), value: 0n, base: 0n, ent: 0n,
        backlog: backlogChain && b.timestamp < startTs, operator: op.operator, exception: op.exception, candidate: b[CANDIDATE] === true,
      };
    });
    const prevL = pc?.L ?? null;
    // D-13 + option (a): this window's L was frozen at epoch n−1's build; this build freezes the next window's
    // r6-review 3: the statistic over the full stat days (the build's own reading only when nothing is recorded)
    const stat = liquidityStatOfV3(recorded, endTs, liquidityReadingV3(Lnow, Lchain));
    const lr = liquidityRuleV3(pc ? { L: pc.L, next: pc.next, v2: pc.v2, switchL: pc.switchL } : null, p.version !== null, stat, firstLiquidityCapV3(poolCreatedAt, startTs));
    const L = lr.used;
    // F5: a window whose feed was missing or thin carries its L (the build's own reading alone never moves the next L);
    // r6-review 2: at the switch epoch, at least L_SWITCH_MIN_FULL_DAYS full days clamp it instead
    const coverage = liquidityCarriedV3(recorded, endTs, orphan !== null, p.version === 2);
    const start = pc?.curve ?? { S: 0n, hour: cw.length ? cw[0].hour : 0 };
    const run = runCurve(cw, L, start);
    cw.forEach((w, i) => (w.value = run.values[i]));
    works.push(...cw);
    chains.set(c.chainId, {
      L, Lprev: prevL, Lrule: lr.rule, Lstat: stat, Lnext: coverage.carried ? L : nextLiquidityV3(stat, L), LnextRule: coverage.carried ? 'carried' : 'clamp', Lcoverage: coverage,
      Lcap: lr.cap, Lnow, LonChain: Lchain,
      curveStart: start, curveAfter: run.after, priceCapE18: cap, ref, spotE18, xenUsdE18: min(spotE18, cap), orphan,
    });
  }
  for (const id of noMarket) if (!p.chains.has(id)) throw new Error(`noMarket lists chain ${id}, which no previous record carries`);
  // D-12 / D-18: the arrival order; the backlog and the operator burns claim on the day of (window end + CLOCK_SKEW_MAX)
  works.sort((a, b) => globalOrder(a.b, b.b));
  const ranked = rankOrderV3(works);
  works.splice(0, works.length, ...ranked.arrival);
  const lateDay = dayOf(endTs + CLOCK_SKEW_MAX, startTs);
  for (const w of works) if (rankClassV3(w) !== 0) w.day = lateDay;
  for (const w of works) {
    w.base = lamportsOf(w.value, w.x);
    w.lp = (w.base * K_BPS) / BPS;
    w.ent = (w.base * K_BPS * TIER_MULTIPLIER[w.b.tier]) / BPS;
    w.band = w.ent - w.lp;
  }
  const open = inputs.freePool.open ?? null;
  if (p.version !== null && open === null) throw new Error('freePool.open (the free pool right after epoch n−1 was published) is required');
  const Fref = open === null ? uint(inputs.freePool.lamports, 'freePool.lamports', U64) : uint(open, 'freePool.open', U64);
  // D-22 (a): never more than 7 daily tranches of 2% of the XDEX XNT reserve read at the week start (epoch n−1's build)
  const planCash = (Fref * PLAN_BPS) / BPS;
  const trancheCap = trancheCapV3(p.capReserve);
  const C = trancheCap === null ? planCash : min(planCash, trancheCap);
  const Fbuild = inputs.freePool.lamports === undefined || inputs.freePool.lamports === null ? null : uint(inputs.freePool.lamports, 'freePool.lamports', U64);
  const gate = applyLimit && Fbuild !== null ? limitGate(buildLimit(Fbuild), (i) => works[i].b.x1) : undefined;
  const a = allocateBurns(works, C, minVestEnt, gate, ranked.plan);
  const planned = () => {
    const shadow = works.map((w) => allocItem(w.tier, w.day, w.lp, w.band));
    const r = allocateBurns(shadow, C, minVestEnt, undefined, ranked.plan);
    return r.base + r.bandPaid;
  };
  const shortfall = a.cut === null ? null : { stage: a.cut.stage, kept: a.cut.kept, wanted: a.cut.wanted, claim: a.cut.claim, planned: planned() };
  // the senior a new burn of the window arriving now claims after (the backlog and the operator burns rank after it)
  const seniorAhead = works.reduce((s, w) => (rankClassV3(w) === 0 && !w.candidate ? s + w.senior : s), 0n);
  return {
    C, tau: C / BigInt(EPOCH_DAYS), Fref, planCash, trancheCap, startTs, endTs, xBuild, xFloor, peg, rulesBlock, chains, plan: ranked.plan, cut: a.cut, shortfall,
    capacity: {
      cash: C, planCash, trancheCap, tranche: C / BigInt(EPOCH_DAYS), senior: a.senior, seniorAhead, base: a.base, bandTotal: a.bandTotal, bandPaid: a.bandPaid, left: a.left,
      lockedMissions: a.locked, splitMissions: a.split, convertedMissions: a.converted,
    },
    burns: works.map((w) => ({
      chainId: w.b.chainId, txHash: w.b.txHash, logIndex: w.b.logIndex, blockNumber: w.b.blockNumber, timestamp: w.b.timestamp, tier: w.b.tier, x1: w.b.x1,
      amountWei: w.b.amountWei, hour: w.hour, day: w.day, priceE18: w.priceE18, priceRule: w.priceRule, xntE18: w.x, xntRule: w.xntRule,
      backlog: w.backlog, operator: w.operator, exception: w.exception, rankClass: rankClassV3(w), candidate: w.candidate,
      spotMicro: w.spot, valueMicro: w.value, base: w.base, lp: w.lp, ent: w.ent, band: w.band, senior: w.senior, basePaid: w.basePaid, bandPaid: w.bandPaid,
      lockedLp: w.lockedLp, converted: w.converted, leafTier: w.leafTier, arrival: w.arrival, roomAtArrival: w.roomAtArrival,
    })),
  };
}

/** The burns of a window as the engine pays them (per-burn fields as decimal strings, the shape of an epoch file's burns[]). */
export function windowResult(prev, inputs, opts) {
  const r = allocateWindow(prev, inputs, opts);
  const s = (x) => (typeof x === 'bigint' ? x.toString() : x);
  const { seniorAhead: _a, ...cap } = r.capacity;
  return {
    capacity: Object.fromEntries(Object.entries(cap).map(([k, v]) => [k, s(v)])),
    burns: r.burns.map((b) => ({
      chainId: b.chainId, txHash: b.txHash, logIndex: b.logIndex, priceE18: s(b.priceE18), priceRule: b.priceRule, xntE18: s(b.xntE18), xntRule: b.xntRule,
      hour: b.hour, day: b.day, backlog: b.backlog, operator: b.operator, exception: b.exception, spotMicro: s(b.spotMicro), valueMicro: s(b.valueMicro),
      base: s(b.base), lp: s(b.lp), ent: s(b.ent), band: s(b.band), senior: s(b.senior), basePaid: s(b.basePaid), bandPaid: s(b.bandPaid), lockedLp: s(b.lockedLp),
      converted: b.converted, leafTier: b.leafTier,
    })),
    shortfall: r.shortfall ? { stage: r.shortfall.stage, kept: r.shortfall.kept, wanted: s(r.shortfall.wanted), claim: s(r.shortfall.claim), planned: s(r.shortfall.planned) } : null,
    xnt: { buildE18: s(r.xBuild), floorE18: s(r.xFloor), peg: r.peg },
    chains: [...r.chains.entries()].map(([chainId, c]) => ({
      chainId, L: { used: s(c.L), rule: c.Lrule, stat: s(c.Lstat), next: s(c.Lnext), nextRule: c.LnextRule, cap: c.Lcap === null ? null : s(c.Lcap) }, priceCapE18: s(c.priceCapE18), xenUsdE18: s(c.xenUsdE18),
      curveAfter: { S: s(c.curveAfter.S), hour: c.curveAfter.hour },
    })),
  };
}

/**
 * The quote of one prospective burn: the window so far (prev + inputs) with the candidate added at `timestamp` on its
 * chain, valued and allocated by the engine. The candidate's own readings are those of its hour (closed candles before
 * it). It has no transaction yet, so it ranks after every burn of its second (D-14: the hash order is unknown until
 * then). Returns the candidate's arrival outcome (what the epoch pays it, given every burn before it) in lamports:
 *   bindingNow   paid at arrival from today's tranche (lp, or the locked mission piece + its cash)
 *   leftoverMaybe the rest of the Launchpad layer, paid only if the window's leftover reaches it (not promised)
 *   notPaid      the rest of the entitlement
 * plus the capacity (C, tranche, cumulative cap today, room before this burn), the chain's L and the rule that set it
 * (D-13: binding only when 'frozen' or 'switch'), the candidate's rank class (2 = an operator wallet: it claims after
 * every other burn, D-18) and the flag that makes the number an upper bound: other burns of the same chain in the same
 * hour (they share the hour's curve pot).
 */
export function quoteBurn(prev, inputs, candidate) {
  const c = {
    chainId: candidate.chainId, txHash: 'quote', logIndex: 0, blockNumber: Number.MAX_SAFE_INTEGER, missionId: '0', pilot: '0x',
    amountWei: String(candidate.amountWei), tier: Number(candidate.tier), x1: candidate.x1, timestamp: Number(candidate.timestamp),
    medianE18: candidate.medianE18, lastCloseE18: candidate.lastCloseE18, priceSource: candidate.priceSource,
    xntMedianE18: candidate.xntMedianE18, xntLastCloseE18: candidate.xntLastCloseE18, xntSource: candidate.xntSource,
  };
  if (!inputs.chains.some((x) => x.chainId === c.chainId)) throw new Error(`chain ${c.chainId} has no market in the window inputs (skipped or unknown): no quote`);
  const r = allocateWindow(prev, inputs, { applyLimit: false, candidate: c });
  const q = r.burns.find((b) => b.candidate);
  if (!q) throw new Error('the quoted burn is missing from the allocation');
  const arrival = q.arrival;
  const capToday = capOnDay(r.C, q.day);
  const others = r.burns.filter((b) => b !== q);
  const sameHour = others.filter((b) => b.chainId === q.chainId && b.hour === q.hour).length;
  const sameSecond = others.filter((b) => b.timestamp === q.timestamp).length;
  const minVestEnt = BigInt(r.rulesBlock.dustRule.vestMinEnt);
  const leftoverMaybe = q.lp - arrival.basePaid > 0n ? q.lp - arrival.basePaid : 0n;
  const entitlement = q.tier > 0 && q.lp + q.band >= minVestEnt ? q.lp + q.band : q.lp;
  const ch = r.chains.get(q.chainId);
  return {
    tier: q.tier, day: q.day, hour: q.hour, priceE18: q.priceE18, priceRule: q.priceRule, xntE18: q.xntE18, xntRule: q.xntRule,
    spotMicro: q.spotMicro, valueMicro: q.valueMicro, base: q.base, lp: q.lp, band: q.band, ent: q.ent, entitlement,
    bindingNow: arrival.senior, launchpadNow: arrival.basePaid - arrival.lockedLp, lockedLp: arrival.lockedLp, bandLocked: arrival.bandPaid,
    leafTier: arrival.leafTier, converted: arrival.converted, leftoverMaybe, notPaid: entitlement > arrival.senior + leftoverMaybe ? entitlement - arrival.senior - leftoverMaybe : 0n,
    fitsWhole: arrival.senior >= entitlement,
    rankClass: q.rankClass, operator: q.operator, exception: q.exception,
    capacity: {
      C: r.C, planCash: r.planCash, trancheCap: r.trancheCap, tranche: r.tau, Fref: r.Fref, day: q.day, capToday, roomBefore: q.roomAtArrival,
      seniorBefore: capToday - q.roomAtArrival > 0n ? capToday - q.roomAtArrival : 0n, seniorAhead: r.capacity.seniorAhead,
    },
    chain: { L: ch.L, Lrule: ch.Lrule, Lbinding: BINDING_L_RULES.includes(ch.Lrule), Lprev: ch.Lprev, priceCapE18: ch.priceCapE18, orphan: ch.orphan !== null },
    xnt: { buildE18: r.xBuild, floorE18: r.xFloor, peg: r.peg },
    upperBound: sameHour > 0, sameHour, sameSecond, sameSecondOtherChain: others.filter((b) => b.timestamp === q.timestamp && b.chainId !== q.chainId).length,
  };
}
