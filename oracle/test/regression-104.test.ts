/**
 * The 104-week regression of the FINAL engine (rewards v3 with F5 and the liquidity rule fixes of 2026-10-26, the two-pot
 * extra rule with OD-9 and the backlog carry), no network.
 *
 * Each scenario is one seeded world run for 104 weekly builds. Every week the real engine builds the base epoch
 * (buildEpochFileV3, a heartbeat when nothing is valued) and the extra epoch on it (buildExtraFile); both are verified
 * (verifyEpochV3, verifyExtraFile) and "published" through a mirror of the upgraded program's money rules: the base
 * budget (≤ 10% of the free pool), the D-47 oracle allowance, the keeper tips, the extra budget (≤ min(8% of X,
 * k × 4% of the live forged backing)), claims, 90-day expiries. The pots move only by the program's flows:
 *   base pot  F: + 20% of each forge, + 1% of the house volume; − budgets, allowance, keeper tips; + expiries
 *   extra pot X: + 25% of each forge; − extra budgets; + expiries
 *   floor vault: + 50% of each forge (the backing); − the backing of each recycle
 *   bankroll   B: + LP deposits, ± the house result; − LP exits (games only)
 * Scenarios: baseline (with a quiet month of heartbeats and one-week chain skips),
 * no new NFT buyers from week 26, a mass recycle at week 26, an LP run on the bankroll, XNT × 0.25 (with a 50% crash
 * week) and × 3, owner gone (no keeper from week 40, no oracle for weeks 60–65, then a successor publishes the long
 * window), oracle-key theft within the B-1 bound (weeks 30–31: one foreign publication per week on each pot, at the
 * program's bound, after F_ref was fixed; the honest history goes on as if those epochs were voided), and the Legacy Pilot
 * rule (legacy.ts) in force with half of 30 burning addresses listed: every week, LEGACY-1 (the base file without the rule,
 * from the same inputs and previous file, has the same burns, capacity and normal targets) and LEGACY-2 (the extra file
 * without it has the same holder rows and leaves).
 *
 * Invariants checked every week of every scenario:
 *   R1 every pot and vault ≥ 0;
 *   R2 base: Σ score ≤ 10% of the free pool at build, planned outflow ≤ buildLimit, and budget + allowance + tips ≤ 10%
 *      of the free pool at publication; a theft takes at most the B-1 bound;
 *   R3 capacity = the quote: C = min(⌊8% × F_ref⌋, tranche cap) with F_ref the ledger's pool right after the previous
 *      publication, Σ paid ≤ C, and the claims of each tranche day within the cumulative daily schedule;
 *   R4 extra: release = ⌊8% × X⌋ with X the ledger's free_after, budget ≤ release, budget ≤ weeks × 4% of the eligible
 *      backing and ≤ the program's bound on the live forged backing, budget ≤ 2 × counted (rho ≤ 2), every pay ≥ MIN_PAY;
 *   R5 every file verifies (base and extra) and every claim is exactly its leaf;
 *   R6 no inter-pot transfer: each pot's ledger closes exactly (start + inflows − outflows = end), and the base files are
 *      byte-identical when only the extra pot's inflows change (the base never reads X);
 *   R7 reproducible: the same seed gives the same digest twice, and the digests are pinned in
 *      test/fixtures/regression-104.json (REG104_UPDATE=1 rewrites it, after a review of the new trajectory table).
 *   npm test                         (REG104_ONLY=<scenario> for one scenario)
 */
import assert from "assert";
import bs58 from "bs58";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { baseScore, buildTree, ChainSnapshot, computeLeaves, dataHash as dataHashV2, EpochBody, EpochFile, epochRateCap } from "../src/epoch";
import { Burn } from "../src/evm";
import {
  AnyEpochFile, buildEpochFileV3, buildLimit, BurnInputV3, ChainInputV3, DEFAULT_RULES_V3, EPOCH_RENT, EpochFileV3, EpochInputsV3, KEEPER_TIP,
  KEEPER_TIP_MIN_CLAIM, oracleAllowanceMax, ORACLE_TOPUP_MAX, ORACLE_TOPUP_TARGET, ORIGIN_FORGED, ORIGIN_GENESIS, plannedOutflow, rebuildReason, RULES_ID_V3,
  RulesBlockV3, SnapshotRecord, verifyEpochV3, XNT_POOL_DEFAULT,
} from "../src/rewards";
import { buildExtraFile, EXTRA_BACKLOG_CARRY_WEEKS, EXTRA_MAX_WEEKS, ExtraFileV1, ExtraSnapshotRecord, MIN_PAY, verifyExtraFile } from "../src/extra";
import { legacyPilotRules } from "../src/legacy";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${(e as Error).stack ?? String(e)}`);
  }
}

// ── constants ────────────────────────────────────────────────────────────────────────────────
const PROGRAM = "57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9";
const XNT = 1_000_000_000n;
const BPS = 10_000n;
const HOUR = 3_600;
const DAY = 86_400;
const WEEK = 7 * DAY;
const WEEKS = 104;
/** Sunday 2026-11-15 00:00 UTC, a fixed test origin (no live meaning): the first v3 epoch's slot in this simulation (window end of week 1 = T0 + 1 week) */
const T0 = 1_794_700_800;
/** a stand-in for the last v2 epoch before the switch (the number is a label; live: epoch 1, epoch 2 published nothing) */
const V2_EPOCH = 4;
/** programs/moon-forge/src/constants.rs */
const EPOCH_BUDGET_BPS = 1_000n;
const CLAIM_WINDOW_WEEKS = 13; // CLAIM_WINDOW = 90 days: an unclaimed budget is expired back to its pot after it
const EXTRA_RELEASE_BPS = 800n;
const EXTRA_BOUND_BPS = 400n;
/** forge price split (nft-extra REPORT A1): 50% floor (backing), 20% base pot, 25% extra pot, 5% architect */
const PRICE = [10n * XNT, 25n * XNT, 60n * XNT, 200n * XNT];
/** the live free pool, 2026-10-25: 6.4309 XNT */
const F0 = 6_430_900_000n;
/** the owner-seeded bankroll (market model decision 13) */
const B0 = 38_400_000_000n;
/** OD-9: init_extra one day before the first v3 window ends; Artifacts forged before it never enter the extra pot */
const INIT = { ts: T0 - DAY, tx: "" };
const CHAIN_IDS = [10, 56, 137];
const FIXTURE = path.join(__dirname, "fixtures", "regression-104.json");

// ── deterministic randomness (integer only: the same on every platform) ─────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}
class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** 0 … n − 1 */
  int(n: number): number {
    return Number(BigInt(this.next()) % BigInt(n));
  }
  chance(perMille: number): boolean {
    return this.int(1000) < perMille;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)];
  }
  /** v × (lo … hi)/100, integer */
  jitter(v: bigint, lo: number, hi: number): bigint {
    return (v * BigInt(lo + this.int(hi - lo + 1))) / 100n;
  }
}

const key = (tag: number, i: number) => {
  const b = new Uint8Array(32);
  b[0] = 0xe5;
  b[1] = tag;
  b[2] = i & 255;
  b[3] = (i >> 8) & 255;
  b[31] = 3;
  return new PublicKey(b).toBase58();
};
const sig = (i: number) => {
  const b = new Uint8Array(64);
  b[0] = i & 255;
  b[1] = (i >> 8) & 255;
  b[2] = (i >> 16) & 255;
  b[63] = 5;
  return bs58.encode(b);
};
INIT.tx = sig(999_999);
const iso = (ts: number) => new Date(ts * 1000).toISOString();
const blockAt = (ts: number) => ts - T0 + 50_000_000;
const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const max0 = (v: bigint) => (v > 0n ? v : 0n);

// ── scenarios ─────────────────────────────────────────────────────────────────────────────────────
interface Scenario {
  name: string;
  seed: number;
  /** XNT/USD at week 104 relative to week 0, as a fraction num/den (linear path, ±6% noise) */
  xntEnd: [number, number];
  /** a week in which XNT falls by half (and stays there) */
  crash?: number;
  /** no Artifact is forged from this week on */
  forgeStop?: number;
  /** every live Artifact is recycled in this week */
  massRecycle?: number;
  /** every LP leaves the bankroll in this week; the house closes */
  lpRun?: number;
  /** no keeper from this week on: no keeper claims (holders claim half the leaves themselves), no house, no tips */
  keeperOff?: number;
  /** no publication in the weeks [from, to): the next build has the long window */
  oracleGap?: [number, number];
  /** a foreign publication at the B-1 bound on each pot in these weeks, after F_ref was fixed */
  theft?: number[];
  /** weeks with no burn at all (heartbeat base epochs) */
  quiet?: [number, number];
  /** extra-pot inflows × this (R6: the base files must not change) */
  extraInflowMul?: bigint;
  /** backlog carry weeks for the extra files (default: EXTRA_BACKLOG_CARRY_WEEKS, the rule in force) */
  carryWeeks?: number;
  /**
   * Legacy Pilot: "on" = the rule in force (the burns' EVM addresses drawn from 30, the even ones listed); "off" = the same
   * world without the rule (the cross-week comparison); absent = every burn from one address, no rule (the pinned worlds)
   */
  legacy?: "on" | "off";
}
/** Legacy Pilot: the 30 burning addresses of the legacy worlds (no randomness drawn: the other worlds are unchanged) and the listed half */
const regPilot = (seq: number) => "0x" + ((seq % 30) + 16).toString(16) + "5e".repeat(19);
const REG_LISTED = new Set(Array.from({ length: 30 }, (_, i) => regPilot(i)).filter((_, i) => i % 2 === 0));
const REG_SHA = createHash("sha256").update("regression-104 legacy snapshot").digest("hex");
const SCENARIOS: Scenario[] = [
  { name: "baseline", seed: 104_001, xntEnd: [1, 1], quiet: [70, 74] },
  { name: "no-new-buyers", seed: 104_002, xntEnd: [1, 1], forgeStop: 26 },
  { name: "mass-recycle-w26", seed: 104_003, xntEnd: [1, 1], massRecycle: 26 },
  { name: "lp-run", seed: 104_004, xntEnd: [1, 1], lpRun: 20 },
  { name: "xnt-x0.25", seed: 104_005, xntEnd: [1, 4], crash: 50 },
  { name: "xnt-x3", seed: 104_006, xntEnd: [3, 1] },
  { name: "owner-gone", seed: 104_007, xntEnd: [1, 1], keeperOff: 40, oracleGap: [60, 66] },
  { name: "oracle-theft", seed: 104_008, xntEnd: [1, 1], theft: [30, 31] },
  { name: "legacy-pilots", seed: 104_009, xntEnd: [1, 1], legacy: "on" },
];

// ── the world ─────────────────────────────────────────────────────────────────────────────────────
interface Art {
  asset: string;
  tier: number;
  origin: number;
  owner: string;
  backing: bigint;
  forgedAt: number;
  sig: number;
}
interface Reservation {
  pot: "base" | "extra";
  week: number;
  left: bigint;
}
interface WeekRow {
  week: number;
  epoch: number | null;
  F: bigint;
  X: bigint;
  B: bigint;
  floor: bigint;
  baseOut: bigint;
  extraOut: bigint;
  baseRelBps: bigint;
  extraRelBps: bigint;
  heartbeat: boolean;
  shortfall: boolean;
}
interface Result {
  rows: WeekRow[];
  digest: string;
  baseHashes: string[];
  stats: Record<string, number>;
  ledger: { F: bigint; X: bigint; floor: bigint; B: bigint };
  /** per week (null: no publication): Σ alloc of the burns, Σ holder pays, the Legacy Pilot top-ups and payments */
  paidNormal: (bigint | null)[];
  paidHolders: (bigint | null)[];
  paidLegacy: bigint[];
  paidLegacyBase: bigint[];
}

function fail(s: Scenario, week: number, what: string): never {
  throw new Error(`${s.name} week ${week}: ${what}`);
}
function check(s: Scenario, week: number, cond: boolean, what: () => string) {
  if (!cond) fail(s, week, what());
}

/** the cumulative daily tranche schedule (CapacityV3.tranche): τ = ⌊C/7⌋, the first (C mod 7) days release τ + 1, all of C from day 6 */
function scheduleOpen(C: bigint, day: number): bigint {
  if (day >= 6) return C;
  const tau = C / 7n;
  const rem = C % 7n;
  const d = BigInt(day + 1);
  return d * tau + (d < rem ? d : rem);
}

/** a v2 file standing for the live epoch 4 (the switch's previous file), with its last 4 liquidity readings per chain */
function v2File(rng: Rng, wallets: string[], xenE18: Map<number, bigint>, L: Map<number, bigint>): EpochFile {
  const createdTs = T0 - 6 * DAY;
  const burns: Burn[] = CHAIN_IDS.map((chainId, i) => ({
    chainId, txHash: "0x" + `ab${i}`.padStart(64, "0"), logIndex: 0, blockNumber: blockAt(createdTs - DAY), missionId: String(9_000 + i), pilot: "0x" + "cd".repeat(20),
    amountWei: ((1_000_000_000n * 10n ** 30n) / xenE18.get(chainId)!).toString(), tier: 0, x1: rng.pick(wallets), timestamp: createdTs - DAY,
    priceE18: xenE18.get(chainId)!.toString(), priceSource: "t",
  }));
  const chains: ChainSnapshot[] = CHAIN_IDS.map((chainId) => ({
    chainId, name: `chain-${chainId}`, portal: "0xportal", fromBlockExclusive: blockAt(createdTs - WEEK), toBlock: blockAt(createdTs), xenUsd: Number(xenE18.get(chainId)!) / 1e18,
    xenUsdE18: xenE18.get(chainId)!.toString(), priceSource: "t", clamped: false, liquidityUsdMicro: L.get(chainId)!.toString(), pools: [], totalSupply: "0",
  }));
  const leaves = computeLeaves(burns, chains, []);
  const t = buildTree(V2_EPOCH, leaves);
  const xUsd = 153_000_000_000_000_000n;
  const body: EpochBody = {
    version: 2, programId: PROGRAM, epoch: V2_EPOCH, createdAt: iso(createdTs), chains, xnt: { usd: 0.153, usdE18: xUsd.toString(), source: "t" },
    kBps: 12_500, rateCap: epochRateCap(12_500, xUsd.toString(), baseScore(burns, chains), BigInt(t.totalScore)).toString(),
    artifacts: { slot: 1, holders: [], eligible: [] }, burns, leaves, totalScore: t.totalScore, root: t.root,
  };
  return { ...body, dataHash: dataHashV2(body), proofs: t.proofs };
}

function runScenario(s: Scenario): Result {
  const rng = new Rng(s.seed);
  const extraMul = s.extraInflowMul ?? 1n;
  const wallets = Array.from({ length: 40 }, (_, i) => key(1, i));
  const operator = key(3, 0);
  const rules0: RulesBlockV3 = { ...DEFAULT_RULES_V3, operatorWallets: { rule: "rank-last", wallets: [operator], exceptions: [] } };
  const rules: RulesBlockV3 = s.legacy === "on" ? { ...rules0, legacyPilot: legacyPilotRules(REG_SHA) } : rules0;
  assert.strictEqual(rules.rulesId, RULES_ID_V3, "the regression runs the rules in force (rulesId 2: F5 and the liquidity rule fixes of 2026-10-26)");

  // market paths: XEN per chain (USD × 1e18), liquidity per chain (µUSD), XNT (USD × 1e18) with the scenario's end point
  const xen0 = new Map<number, bigint>(CHAIN_IDS.map((c) => [c, BigInt(20 + rng.int(400)) * 1_000_000_000n]));
  const L0 = new Map<number, bigint>(CHAIN_IDS.map((c) => [c, BigInt(5_000 + rng.int(150_000)) * 1_000_000n]));
  const x0 = 153_000_000_000_000_000n;
  const xntAt = (w: number) => {
    const [num, den] = s.xntEnd;
    const end = (x0 * BigInt(num)) / BigInt(den);
    let x = x0 + ((end - x0) * BigInt(w)) / BigInt(WEEKS);
    if (s.crash !== undefined && w >= s.crash) x /= 2n;
    return x;
  };
  const xntWeek: bigint[] = Array.from({ length: WEEKS + 1 }, (_, w) => rng.jitter(xntAt(w), 94, 106));
  const xenWeek = new Map<number, bigint[]>(CHAIN_IDS.map((c) => [c, Array.from({ length: WEEKS + 1 }, () => rng.jitter(xen0.get(c)!, 70, 140))]));
  const Lweek = new Map<number, bigint[]>(CHAIN_IDS.map((c) => [c, Array.from({ length: WEEKS + 1 }, (_, w) => rng.jitter(L0.get(c)!, 60 + (w % 7), 150))]));

  // the time line: window ends and publications (X1 clock)
  const endTs = Array.from({ length: WEEKS + 1 }, (_, w) => T0 + w * WEEK + (w === 0 ? 0 : rng.int(2 * HOUR)));
  const published = (w: number) => !(s.oracleGap && w >= s.oracleGap[0] && w < s.oracleGap[1]);

  // chain skips (D-12 backlog next week): one-week skips, never two in a row, never in the first or last weeks
  const skip = new Map<number, Set<number>>(CHAIN_IDS.map((c) => [c, new Set<number>()]));
  for (const c of CHAIN_IDS) for (let w = 3; w < WEEKS - 2; w++) if (!skip.get(c)!.has(w - 1) && rng.chance(30)) skip.get(c)!.add(w);

  // burns on chain, generated week by week up front (they exist whether or not a build reads them)
  const chainBurns = new Map<number, BurnInputV3[]>(CHAIN_IDS.map((c) => [c, []]));
  let seq = 0;
  const holderWallets = wallets.slice(0, 16);
  for (let w = 1; w <= WEEKS; w++) {
    const quiet = s.quiet && w >= s.quiet[0] && w < s.quiet[1];
    const n = quiet ? 0 : 3 + rng.int(14);
    const lo = endTs[w - 1] + 2 * HOUR;
    const hi = endTs[w] - 60;
    for (let j = 0; j < n; j++) {
      const chainId = rng.pick(CHAIN_IDS);
      const ts = lo + rng.int(hi - lo);
      const price = xenWeek.get(chainId)![w];
      const usdMicro = 10n ** BigInt(3 + rng.int(7)) * BigInt(1 + rng.int(9));
      const amountWei = (usdMicro * 10n ** 30n) / price + BigInt(rng.int(1_000));
      const median = rng.jitter(price, 85, 115);
      const xm = rng.jitter(xntWeek[w], 95, 105);
      const isOp = rng.chance(40);
      const x1 = isOp ? operator : rng.chance(500) ? rng.pick(holderWallets) : rng.pick(wallets);
      seq++;
      chainBurns.get(chainId)!.push({
        chainId, txHash: "0x" + seq.toString(16).padStart(64, "0"), logIndex: 0, blockNumber: blockAt(ts), missionId: String(seq), pilot: s.legacy ? regPilot(seq) : "0x" + "ab".repeat(20),
        amountWei: amountWei.toString(), tier: rng.int(3), x1, timestamp: ts, medianE18: median.toString(), lastCloseE18: rng.jitter(median, 95, 105).toString(), priceSource: "candles",
        xntMedianE18: xm.toString(), xntLastCloseE18: rng.jitter(xm, 98, 102).toString(), xntSource: "candles",
      });
    }
  }
  for (const list of chainBurns.values()) list.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  // Artifacts: 5 forged before init_extra (OD-9: never in the extra pot) and 3 Genesis keys, then weekly forges
  const arts: Art[] = [];
  let artSeq = 0;
  let sigSeq = 0;
  const newArt = (tier: number, origin: number, forgedAt: number, backing: bigint): Art => {
    const a = { asset: key(2, artSeq++), tier, origin, owner: rng.pick(holderWallets), backing, forgedAt, sig: ++sigSeq };
    arts.push(a);
    return a;
  };
  for (let i = 0; i < 5; i++) newArt(rng.pick([0, 0, 1, 2]), ORIGIN_FORGED, INIT.ts - 3 * DAY - i, PRICE[0] / 2n);
  for (let i = 0; i < 3; i++) newArt(0, ORIGIN_GENESIS, INIT.ts - 30 * DAY, 0n);

  // the pots: free balances, open reservations (published, not yet claimed or expired) and what left each one
  let F = F0;
  let X = 0n;
  let floor = sum(arts.map((a) => a.backing));
  const floor0 = floor;
  let B = B0;
  let oracleBal = 490_362_000n;
  const flows = { baseIn: 0n, baseOut: 0n, extraIn: 0n, extraOut: 0n, floorIn: 0n, floorOut: 0n, bIn: 0n, bOut: 0n, bResult: 0n };
  const reservations: Reservation[] = [];
  const reserved = (pot: "base" | "extra") => sum(reservations.filter((r) => r.pot === pot).map((r) => r.left));
  const stats: Record<string, number> = {
    builds: 0, heartbeats: 0, extraPaying: 0, burns: 0, backlogBurns: 0, operatorBurns: 0, shortfalls: 0, carried: 0, tranchePinned: 0, theft: 0, expiredBase: 0,
    expiredExtra: 0, selfClaims: 0, longWindows: 0, preUpgradeExcluded: 0, extraCarry: 0, extraCarryFields: 0,
    legacy1Epochs: 0, legacy1Burns: 0, legacyTopUps: 0, legacy2Epochs: 0, legacy2Rows: 0, legacyClaims: 0, legacyPayments: 0,
  };
  const rows: WeekRow[] = [];
  const paidNormal: (bigint | null)[] = [];
  const paidHolders: (bigint | null)[] = [];
  const paidLegacy: bigint[] = [];
  const paidLegacyBase: bigint[] = [];
  const digest = createHash("sha256");
  const baseHashes: string[] = [];

  // the switch: the v2 file (epoch 4) paid by the live binary, and F_ref of the first v3 window right after it
  let prev: AnyEpochFile = v2File(rng, wallets, xen0, L0);
  const v2Budget = (F * EPOCH_BUDGET_BPS) / BPS / 2n;
  F -= v2Budget;
  flows.baseOut += v2Budget;
  let Fref = F;
  let pubAt = Math.floor(Date.parse(prev.createdAt) / 1000) - 1;
  let prevExtra: ExtraFileV1 | null = null;
  /** X = free_after of the previous extra publication (X at init_extra, 0, for the first extra epoch) */
  let Xopen = 0n;
  let epoch = V2_EPOCH;
  let houseOpen = true;
  const keeperOn = (w: number) => s.keeperOff === undefined || w < s.keeperOff;
  /** the keeper claims every leaf; without one, each holder claims with a 50% chance and the rest waits for its expiry */
  const claimOrReserve = (pot: "base" | "extra", w: number, amounts: bigint[]): bigint => {
    let out = 0n;
    let left = 0n;
    for (const a of amounts) {
      const byKeeper = keeperOn(w);
      const self = !byKeeper && rng.chance(500);
      if (self) stats.selfClaims++;
      if (byKeeper || self) out += a;
      else left += a;
    }
    if (left > 0n) reservations.push({ pot, week: w, left });
    return out;
  };

  for (let w = 1; w <= WEEKS; w++) {
    // ── the week's flows before the build: forges, transfers, recycles, games, expiries ──
    const forging = s.forgeStop === undefined || w < s.forgeStop;
    const forges = forging ? rng.int(4) + (w < 30 ? rng.int(3) : 0) : 0;
    for (let i = 0; i < forges; i++) {
      const tier = rng.pick([0, 0, 0, 0, 1, 1, 2, 3]);
      const price = PRICE[tier];
      newArt(tier, ORIGIN_FORGED, endTs[w - 1] + HOUR + rng.int(5 * DAY), price / 2n);
      floor += price / 2n;
      flows.floorIn += price / 2n;
      const toBase = (price * 2_000n) / BPS;
      const toExtra = ((price * 2_500n) / BPS) * extraMul;
      F += toBase;
      flows.baseIn += toBase;
      X += toExtra;
      flows.extraIn += toExtra;
    }
    const alive = arts.filter((a) => a.owner !== "");
    for (const a of alive) {
      if (rng.chance(40)) {
        a.owner = rng.pick(holderWallets.filter((x) => x !== a.owner));
        a.sig = ++sigSeq;
      }
    }
    const recycleAll = s.massRecycle === w;
    for (const a of alive) {
      if (a.origin === ORIGIN_GENESIS && !recycleAll) continue;
      if (recycleAll || rng.chance(20)) {
        floor -= a.backing;
        flows.floorOut += a.backing;
        a.owner = "";
      }
    }
    // games (bankroll only): LP deposits, the house result (edge 1.5% ± luck), 1% of the volume to the base pot
    if (s.lpRun === w) {
      const out = B > B0 ? B - B0 : 0n;
      B -= out;
      flows.bOut += out;
      houseOpen = false;
    }
    if (!keeperOn(w)) houseOpen = false;
    if (houseOpen) {
      const dep = BigInt(rng.int(3)) * XNT;
      B += dep;
      flows.bIn += dep;
      const volume = (B * BigInt(5 + rng.int(20))) / 100n;
      const result0 = (volume * 150n) / BPS + (volume * BigInt(rng.int(401))) / BPS - (volume * 200n) / BPS;
      const result = result0 > -B ? result0 : -B;
      B += result;
      flows.bResult += result;
      const toPool = (volume * 100n) / BPS;
      F += toPool;
      flows.baseIn += toPool;
    }
    // CLAIM_WINDOW expiries: what nobody claimed goes back to its own pot, never the other one
    for (const r of reservations) {
      if (r.left === 0n || w - r.week < CLAIM_WINDOW_WEEKS) continue;
      if (r.pot === "base") {
        F += r.left;
        stats.expiredBase++;
      } else {
        X += r.left;
        stats.expiredExtra++;
      }
      r.left = 0n;
    }

    // ── no publication while no oracle publishes: the next build's window spans the gap ──
    if (!published(w)) {
      rows.push({ week: w, epoch: null, F, X, B, floor, baseOut: 0n, extraOut: 0n, baseRelBps: 0n, extraRelBps: 0n, heartbeat: false, shortfall: false });
      digest.update(`${w}|-|${F}|${X}|${B}|${floor}\n`);
      paidNormal.push(null);
      paidHolders.push(null);
      paidLegacy.push(0n);
      paidLegacyBase.push(0n);
      continue;
    }

    // ── the base build ──
    epoch++;
    const end = endTs[w];
    const startTs = pubAt;
    if (end - startTs > 2 * WEEK) stats.longWindows++;
    const chains: ChainInputV3[] = [];
    for (const c of CHAIN_IDS) {
      if (skip.get(c)!.has(w)) continue;
      const from = prev.chains.find((x) => x.chainId === c)?.toBlock ?? 0;
      const to = blockAt(end);
      // F5: a full feed has 6 samples a day; now and then a thin one (2 a day) carries the chain's L
      const thin = rng.chance(60);
      const samples: { hour: number; micro: string }[] = [];
      for (let h = Math.ceil(startTs / HOUR); h * HOUR <= end - HOUR; h += thin ? 12 : 4) samples.push({ hour: h, micro: rng.jitter(Lweek.get(c)![w], 90, 110).toString() });
      chains.push({
        chainId: c, name: `chain-${c}`, portal: "0xportal", fromBlockExclusive: from, toBlock: to,
        market: { spotE18: xenWeek.get(c)![w].toString(), refUsdE18: xen0.get(c)!.toString(), priceSource: "test", pools: [{ address: "0xpool", reserveUsd: "50000.0", createdAt: iso(T0 - 400 * DAY) }] },
        liquidityNowMicro: Lweek.get(c)![w].toString(), liquiditySamples: samples, poolCreatedAt: T0 - 400 * DAY, totalSupply: "0",
        burns: chainBurns.get(c)!.filter((b) => b.blockNumber > from && b.blockNumber <= to),
      });
    }
    const live = arts.filter((a) => a.owner !== "");
    const records: SnapshotRecord[] = live.map((a) => ({ asset: a.asset, tier: a.tier, owner: a.owner, backing: a.backing.toString(), origin: a.origin }));
    const slot = 1_000_000 + w * 1_000;
    const reserveXnt = BigInt(100 + rng.int(5_000)) * XNT;
    const inputs: EpochInputsV3 = {
      programId: PROGRAM, epoch, createdAt: iso(end + rng.int(600)), window: { startTs, endTs: end }, chains, snapshot: { slot, records },
      freePool: { lamports: F.toString(), slot: slot - 1, open: Fref.toString() },
      xnt: { twapE18: rng.jitter(xntWeek[w], 99, 101).toString(), apiE18: xntWeek[w].toString(), source: "test" },
      // r6-review 2: the switch window is valued at the median of the last 4 v2 liquidity readings
      switchRefs: prev.version === 2
        ? prev.chains.map((c) => ({ chainId: c.chainId, readings: [c.xenUsdE18, c.xenUsdE18, c.xenUsdE18, c.xenUsdE18], liquidity: [0, 1, 2, 3].map((k) => (k === 0 ? c.liquidityUsdMicro : rng.jitter(BigInt(c.liquidityUsdMicro), 80 + k, 120).toString())) }))
        : null,
      rulesBlock: rules,
      ...(s.legacy === "on" ? { legacyPilot: { snapshotSha256: REG_SHA, listed: [...new Set(chains.flatMap((c) => c.burns.map((b) => b.pilot)))].filter((a) => REG_LISTED.has(a)).sort() } } : {}),
      xdex: { pool: XNT_POOL_DEFAULT, slot: slot - 2, wxntReserveLamports: reserveXnt.toString(), usdcReserveMicro: ((reserveXnt * xntWeek[w]) / 10n ** 21n).toString(), feeBps: 25 },
    };
    let built = buildEpochFileV3(inputs, prev);
    let heartbeat = false;
    if (!built) {
      built = buildEpochFileV3(inputs, prev, { heartbeat: true });
      heartbeat = true;
    }
    check(s, w, !!built, () => "neither a paying build nor a heartbeat");
    const f = JSON.parse(JSON.stringify(built)) as EpochFileV3;
    stats.builds++;
    if (heartbeat) stats.heartbeats++;

    // R5: the file verifies against its previous file
    const verr = verifyEpochV3(f, prev);
    check(s, w, verr.length === 0, () => `base epoch ${epoch} does not verify: ${verr.slice(0, 3).join("; ")}`);
    // LEGACY-1: the same epoch without the rule (same inputs, same previous file) has the same burns, capacity and every
    // member but the rule's own; its targets are the file's less the top-ups, each on its burner's tier-0 leaf
    const legacyPaidBase = BigInt(f.legacy?.paid ?? "0");
    if (s.legacy === "on") {
      const { legacyPilot: _lp, ...plainInputs } = inputs;
      const plain = buildEpochFileV3({ ...plainInputs, rulesBlock: rules0 }, prev, { heartbeat });
      check(s, w, !!plain, () => "LEGACY-1: the build without the rule is empty");
      const p = JSON.parse(JSON.stringify(plain)) as EpochFileV3;
      for (const k of Object.keys(f) as (keyof EpochFileV3)[]) {
        if (["legacy", "targets", "leaves", "totalScore", "root", "rulesBlock", "dataHash", "proofs"].includes(k)) continue;
        check(s, w, JSON.stringify(f[k]) === JSON.stringify(p[k]), () => `LEGACY-1: ${k} differs with the rule`);
      }
      const add = new Map<string, bigint>();
      for (const t of f.legacy!.topUps) add.set(t.x1, (add.get(t.x1) ?? 0n) + BigInt(t.paid));
      const norm = new Map(p.targets.map((t) => [`${t.player}:${t.tier}`, BigInt(t.target)]));
      for (const t of f.targets) {
        const want = norm.get(`${t.player}:${t.tier}`) ?? 0n;
        check(s, w, BigInt(t.target) - (t.tier === 0 ? add.get(t.player) ?? 0n : 0n) === want, () => `LEGACY-1: target ${t.player}:${t.tier}`);
        norm.delete(`${t.player}:${t.tier}`);
      }
      check(s, w, norm.size === 0, () => "LEGACY-1: a normal target is missing with the rule");
      stats.legacy1Epochs++;
      stats.legacy1Burns += f.burns.length;
      stats.legacyTopUps += f.legacy!.topUps.filter((t) => t.paid !== "0").length;
    }

    // R2 at the build
    const Fbuild = BigInt(f.freePool.lamports);
    const TS = BigInt(f.totalScore);
    check(s, w, TS <= (Fbuild * EPOCH_BUDGET_BPS) / BPS, () => `Σ score ${TS} above 10% of ${Fbuild}`);
    const planned = plannedOutflow(f.leaves.map((l) => BigInt(l.score)), TS);
    check(s, w, planned <= buildLimit(Fbuild), () => `planned outflow ${planned} above the build limit ${buildLimit(Fbuild)}`);
    check(s, w, rebuildReason(f, F) === null, () => `rebuild reason at publication: ${rebuildReason(f, F)}`);

    // R3: the capacity is the quote
    const planCash = (Fref * 800n) / BPS;
    check(s, w, f.freePool.ref === Fref.toString(), () => `F_ref ${f.freePool.ref} is not the ledger's ${Fref}`);
    check(s, w, f.capacity.planCash === planCash.toString(), () => `planCash ${f.capacity.planCash} is not 8% of F_ref (${planCash})`);
    const C = BigInt(f.capacity.cash);
    const cap = f.capacity.trancheCap === null ? null : BigInt(f.capacity.trancheCap);
    check(s, w, C === (cap === null ? planCash : min(planCash, cap)), () => `C ${C} is not min(planCash, trancheCap ${cap})`);
    if (cap !== null && cap < planCash) stats.tranchePinned++;
    const paid = sum(f.burns.map((b) => BigInt(b.alloc)));
    check(s, w, paid + legacyPaidBase <= C, () => `burners paid ${paid} (+ ${legacyPaidBase} Legacy Pilot top-ups) above C ${C}`);
    for (let d = 0; d < 7; d++) {
      const seniorTo = sum(f.burns.filter((b) => b.day <= d).map((b) => BigInt(b.senior)));
      check(s, w, seniorTo <= scheduleOpen(C, d), () => `arrival claims up to day ${d} (${seniorTo}) above the schedule ${scheduleOpen(C, d)}`);
    }
    if (f.capacity.shortfall !== null) stats.shortfalls++;
    stats.burns += f.burns.length;
    stats.backlogBurns += f.burns.filter((b) => b.backlog).length;
    stats.operatorBurns += f.burns.filter((b) => b.operator).length;
    stats.carried += f.chains.filter((c) => c.L.nextRule === "carried" && !c.skipped).length;

    // the publication (program mirror): budget, the D-47 allowance, then the claims with their keeper tips
    const Fpub = F;
    const bound = (Fpub * EPOCH_BUDGET_BPS) / BPS;
    const budget = min(bound, TS);
    check(s, w, budget === TS, () => `on-chain budget ${budget} capped below totalScore ${TS} (I9)`);
    F -= budget;
    const nextFref = F; // A2: free_pool_before − budget
    const topUp = oracleBal < ORACLE_TOPUP_TARGET ? min(ORACLE_TOPUP_MAX, ORACLE_TOPUP_TARGET - oracleBal) : 0n;
    const allowance = min(EPOCH_RENT + topUp, oracleAllowanceMax(bound));
    F -= allowance;
    flows.baseOut += allowance;
    oracleBal = max0(oracleBal + allowance - EPOCH_RENT - 5_000n * BigInt(1 + f.leaves.length));
    for (const l of f.leaves) {
      const amount = TS === 0n ? 0n : (BigInt(l.score) * budget) / TS;
      check(s, w, amount === BigInt(l.score), () => `claim ${amount} is not its leaf ${l.score}`);
    }
    const amounts = f.leaves.map((l) => BigInt(l.score));
    const claimed = claimOrReserve("base", w, amounts);
    const tips = keeperOn(w) ? KEEPER_TIP * BigInt(amounts.filter((a) => a >= KEEPER_TIP_MIN_CLAIM).length) : 0n;
    F -= tips;
    flows.baseOut += claimed + tips;
    check(s, w, budget + allowance + tips <= bound, () => `budget ${budget} + allowance ${allowance} + tips ${tips} above 10% of ${Fpub}`);
    pubAt = end + 60 + rng.int(1_800);
    Fref = nextFref;

    // ── the extra epoch on this base ──
    const xrecords: ExtraSnapshotRecord[] = live.map((a) => ({ asset: a.asset, tier: a.tier, owner: a.owner, backing: a.backing.toString(), origin: a.origin, forgedAt: a.forgedAt, signature: sig(a.sig) }));
    const xf = buildExtraFile(f, prevExtra, { slot, blockTime: end, records: xrecords }, { open: Xopen.toString(), lamports: X.toString(), slot: slot + 5, createdAt: iso(end + 30), init: INIT }, s.carryWeeks);
    const xerr = verifyExtraFile(JSON.parse(JSON.stringify(xf)), f, prevExtra, s.carryWeeks);
    // LEGACY-2: the same extra epoch without the rule has the same holder rows; each leaf differs by the wallet's Legacy
    // Pilot payments only
    const legacyPaidExtra = BigInt(xf.legacy?.paid ?? "0");
    if (s.legacy === "on") {
      const plainX = buildExtraFile(f, prevExtra, { slot, blockTime: end, records: xrecords }, { open: Xopen.toString(), lamports: X.toString(), slot: slot + 5, createdAt: iso(end + 30), init: INIT }, s.carryWeeks, { legacy: false });
      check(s, w, JSON.stringify(xf.rows) === JSON.stringify(plainX.rows), () => "LEGACY-2: a holder row differs with the rule");
      const extra = new Map<string, bigint>();
      for (const x of xf.legacy!.payments) extra.set(x.wallet, (extra.get(x.wallet) ?? 0n) + BigInt(x.paid));
      for (const wl of new Set([...xf.leaves, ...plainX.leaves].map((l) => l.wallet))) {
        const a = BigInt(xf.leaves.find((l) => l.wallet === wl)?.amount ?? "0");
        const b = BigInt(plainX.leaves.find((l) => l.wallet === wl)?.amount ?? "0");
        check(s, w, a - (extra.get(wl) ?? 0n) === b, () => `LEGACY-2: wallet ${wl}`);
      }
      stats.legacy2Epochs++;
      stats.legacy2Rows += xf.rows.length;
      stats.legacyClaims += xf.legacy!.claims.length;
      stats.legacyPayments += xf.legacy!.payments.length;
    }
    // the backlog carry was really used (a backlog burn counted against last week's unused need)
    stats.extraCarryFields += xf.rows.filter((r) => r.carry !== undefined || r.useBacklog !== undefined).length;
    stats.extraCarry += xf.rows.filter((r) => {
      if (r.carry === undefined || r.useBacklog === undefined) return false;
      const ub = BigInt(r.useBacklog);
      return BigInt(r.carry) > 0n && ub > 0n && BigInt(r.counted) > min(BigInt(r.use) - ub, BigInt(r.need));
    }).length;
    check(s, w, xerr.length === 0, () => `extra epoch ${epoch} does not verify: ${xerr.slice(0, 3).join("; ")}`);
    const xb = BigInt(xf.totals.budget);
    const release = (Xopen * EXTRA_RELEASE_BPS) / BPS;
    check(s, w, xf.totals.release === release.toString(), () => `release ${xf.totals.release} is not 8% of X ${Xopen}`);
    check(s, w, xb <= release, () => `extra budget ${xb} above the release ${release}`);
    const k = BigInt(xf.window.weeks);
    check(s, w, xb - legacyPaidExtra <= k * ((BigInt(xf.totals.eligibleBacking) * EXTRA_BOUND_BPS) / BPS), () => `extra budget ${xb} above ${k} × 4% of the eligible backing`);
    const liveForged = sum(live.filter((a) => a.origin === ORIGIN_FORGED && a.forgedAt >= INIT.ts).map((a) => a.backing));
    const onChainBound = min(release, k * ((liveForged * EXTRA_BOUND_BPS) / BPS));
    check(s, w, xb <= onChainBound, () => `extra budget ${xb} above the program's bound ${onChainBound}`);
    check(s, w, xb - legacyPaidExtra <= 2n * BigInt(xf.totals.counted), () => `rho above 2: budget ${xb}, counted ${xf.totals.counted}`);
    check(s, w, xf.leaves.every((l) => BigInt(l.amount) >= MIN_PAY), () => "an extra pay below MIN_PAY");
    check(s, w, k >= 1n && k <= BigInt(EXTRA_MAX_WEEKS), () => `extra weeks ${k}`);
    const preUpgrade = live.filter((a) => a.origin === ORIGIN_FORGED && a.forgedAt < INIT.ts).length;
    check(s, w, prevExtra === null || xf.excluded.filter((e) => e.reason === "pre-upgrade").length === preUpgrade, () => "OD-9: a pre-upgrade Artifact is not excluded");
    stats.preUpgradeExcluded += xf.excluded.filter((e) => e.reason === "pre-upgrade").length;
    if (xb > 0n) stats.extraPaying++;
    paidNormal.push(paid);
    paidHolders.push(sum(xf.rows.map((r) => BigInt(r.pay))));
    paidLegacy.push(legacyPaidBase + legacyPaidExtra);
    paidLegacyBase.push(legacyPaidBase);
    X -= xb;
    flows.extraOut += claimOrReserve("extra", w, xf.leaves.map((l) => BigInt(l.amount)));
    Xopen = X;

    // ── oracle-key theft (B-1): one foreign publication per pot in the week, at the program's bound, after F_ref ──
    let stolenBase = 0n;
    if (s.theft?.includes(w)) {
      const before = F;
      stolenBase = (F * EPOCH_BUDGET_BPS) / BPS; // its budget and the allowance share one 10% bound
      F -= stolenBase;
      flows.baseOut += stolenBase;
      const xBound = min((X * EXTRA_RELEASE_BPS) / BPS, (liveForged * EXTRA_BOUND_BPS) / BPS);
      X -= xBound;
      flows.extraOut += xBound;
      Xopen = X;
      stats.theft++;
      check(s, w, stolenBase * BPS <= before * EPOCH_BUDGET_BPS, () => "a theft above 10% of the free pool");
    }

    // R1: no pot or vault below 0; the floor vault holds exactly the live backing
    check(s, w, F >= 0n && X >= 0n && B >= 0n && floor >= 0n, () => `a pot below 0: F ${F}, X ${X}, B ${B}, floor ${floor}`);
    check(s, w, floor === sum(arts.filter((a) => a.owner !== "").map((a) => a.backing)), () => "the floor vault is not the live backing");

    digest.update(`${w}|${f.dataHash}|${xf.dataHash}|${F}|${X}|${B}|${floor}\n`);
    baseHashes.push(f.dataHash);
    rows.push({
      week: w, epoch, F, X, B, floor, baseOut: budget + allowance + tips, extraOut: xb, baseRelBps: Fpub > 0n ? ((budget + allowance + tips) * BPS) / Fpub : 0n,
      extraRelBps: release > 0n ? (xb * EXTRA_RELEASE_BPS) / release : 0n, heartbeat, shortfall: f.capacity.shortfall !== null,
    });
    prev = f;
    prevExtra = JSON.parse(JSON.stringify(xf)) as ExtraFileV1;
  }

  // R6: every ledger closes exactly (free + reserved = start + inflows − outflows), each pot on its own
  assert.strictEqual(F + reserved("base"), F0 + flows.baseIn - flows.baseOut, `${s.name}: the base pot's ledger does not close`);
  assert.strictEqual(X + reserved("extra"), flows.extraIn - flows.extraOut, `${s.name}: the extra pot's ledger does not close`);
  assert.strictEqual(floor, floor0 + flows.floorIn - flows.floorOut, `${s.name}: the floor vault's ledger does not close`);
  assert.strictEqual(B, B0 + flows.bIn + flows.bResult - flows.bOut, `${s.name}: the bankroll's ledger does not close`);
  return { rows, digest: digest.digest("hex"), baseHashes, stats, ledger: { F, X, floor, B }, paidNormal, paidHolders, paidLegacy, paidLegacyBase };
}

// ── the run ───────────────────────────────────────────────────────────────────────────────────────
const started = Date.now();
const only = process.env.REG104_ONLY;
const results = new Map<string, Result>();
for (const s of SCENARIOS) {
  if (only && s.name !== only) continue;
  test(`regression ${s.name}: 104 weeks, every invariant`, () => {
    results.set(s.name, runScenario(s));
  });
}

const xntOf = (v: bigint) => (Number(v) / 1e9).toFixed(3);
const table: string[] = [];
for (const [name, r] of results) {
  const at = (w: number) => r.rows.find((x) => x.week === w)!;
  const maxBase = r.rows.reduce((m, x) => (x.baseRelBps > m ? x.baseRelBps : m), 0n);
  const maxExtra = r.rows.reduce((m, x) => (x.extraRelBps > m ? x.extraRelBps : m), 0n);
  const outBase = sum(r.rows.map((x) => x.baseOut));
  const outExtra = sum(r.rows.map((x) => x.extraOut));
  const W = [13, 26, 52, 78, 104];
  table.push(
    `${name.padEnd(17)} | F w13/26/52/78/104 ${W.map((w) => xntOf(at(w).F)).join(" / ")} | X ${W.map((w) => xntOf(at(w).X)).join(" / ")} | B w104 ${xntOf(at(104).B)} | ` +
      `paid base ${xntOf(outBase)} extra ${xntOf(outExtra)} | max base ${(Number(maxBase) / 100).toFixed(2)}% of F, extra ${(Number(maxExtra) / 100).toFixed(2)}% of X`,
  );
}

test("regression coverage: every path the scenarios are meant to reach was reached", () => {
  if (only) return;
  const st = (n: string) => results.get(n)!.stats;
  const all = (k: string) => [...results.values()].reduce((s, r) => s + r.stats[k], 0);
  assert(all("heartbeats") >= 4, `heartbeat base epochs: ${all("heartbeats")}`);
  assert(all("backlogBurns") > 0, "no D-12 backlog burn (one-week chain skips)");
  assert(all("operatorBurns") > 0, "no D-18 operator burn");
  assert(all("carried") > 0, "no F5 carried chain");
  assert(all("tranchePinned") > 0, "the XDEX tranche cap never bound");
  assert(all("extraPaying") > 50, `extra epochs paying: ${all("extraPaying")}`);
  assert(all("preUpgradeExcluded") > 0, "OD-9 never excluded an Artifact");
  // the rule in force; the backlog carry off records no carry at all (its own run is the next test)
  if (EXTRA_BACKLOG_CARRY_WEEKS > 0) assert(all("extraCarry") > 0, "the backlog carry is on but no backlog burn used a carried need");
  else assert.deepStrictEqual([all("extraCarry"), all("extraCarryFields")], [0, 0], "the backlog carry is off: no row records or uses a carry");
  assert(st("owner-gone").longWindows === 1 && st("owner-gone").selfClaims > 0 && st("owner-gone").expiredBase > 0, "owner-gone: the long window, self-claims and expiries");
  assert(st("oracle-theft").theft === 2, "oracle-theft: two foreign publications");
  assert(results.get("mass-recycle-w26")!.rows.find((x) => x.week === 26)!.floor === 0n, "mass recycle: the floor vault is empty at week 26");
});

test("Legacy Pilot (legacy-pilots): LEGACY-1 and LEGACY-2 held every week; the cross-week effect on everyone else is bounded by what the rule paid", () => {
  if (only && only !== "legacy-pilots") return;
  const on = results.get("legacy-pilots")!;
  const st = on.stats;
  assert(st.legacy1Epochs >= 100 && st.legacy2Epochs >= 100, `LEGACY-1 ${st.legacy1Epochs} / LEGACY-2 ${st.legacy2Epochs} weeks`);
  assert(st.legacyTopUps > 0 && st.legacyClaims > 0 && st.legacyPayments > 0, "the rule paid top-ups and Artifact rebates");
  for (const r of results.values()) if (r !== on) assert.strictEqual(r.stats.legacy1Epochs + r.stats.legacyTopUps, 0, "no rule in the other worlds");
  // the same world without the rule: within a week nothing differs (LEGACY-1/2 above); across weeks the pool keeps what
  // the rule paid, so a later capacity-bound week can quote a slightly larger C. Measured, and bounded by what was paid.
  const off = runScenario({ ...SCENARIOS.find((x) => x.name === "legacy-pilots")!, legacy: "off" });
  const paidRule = sum(on.paidLegacy);
  let lessNormal = 0n;
  let lessHolders = 0n;
  let weeksMoved = 0;
  let firstMoved = 0;
  for (let i = 0; i < on.paidNormal.length; i++) {
    const dn = (off.paidNormal[i] ?? 0n) - (on.paidNormal[i] ?? 0n);
    const dh = (off.paidHolders[i] ?? 0n) - (on.paidHolders[i] ?? 0n);
    if (dn !== 0n || dh !== 0n) {
      weeksMoved++;
      if (!firstMoved) firstMoved = i + 1;
    }
    lessNormal += dn;
    lessHolders += dh;
  }
  const firstPaid = on.paidLegacy.findIndex((x) => x > 0n) + 1;
  assert(firstMoved === 0 || firstMoved > firstPaid, "nothing moves before the rule first pays (and never within the week it pays)");
  assert(lessNormal + lessHolders <= paidRule, `everyone else together received ${lessNormal + lessHolders} less over 104 weeks, above the ${paidRule} the rule paid`);
  console.log(
    `  legacy-pilots: the rule paid ${(Number(paidRule) / 1e9).toFixed(3)} XNT over 104 weeks (${(Number(sum(on.paidLegacyBase)) / 1e9).toFixed(3)} in burn top-ups, the rest in Artifact rebates); without it the burners would have received ` +
      `${(Number(lessNormal) / 1e9).toFixed(3)} XNT more and the holders ${(Number(lessHolders) / 1e9).toFixed(3)} XNT more, in ${weeksMoved} later weeks (pool memory, first at week ${firstMoved || "-"})`,
  );
});

test("the backlog carry switched on is reached in the model (a backlog burn uses a carried need) and keeps every invariant; the base files do not change", () => {
  if (only && only !== "baseline") return;
  const base = results.get("baseline")!;
  const on = runScenario({ ...SCENARIOS[0], carryWeeks: 1 });
  assert(on.stats.extraCarry > 0, `backlog carry rows: ${on.stats.extraCarry}`);
  assert(on.stats.extraCarryFields > 0);
  assert.deepStrictEqual(on.baseHashes, base.baseHashes, "the carry is an extra-pot rule: the base files are the same");
  if (EXTRA_BACKLOG_CARRY_WEEKS === 0) assert.notStrictEqual(on.digest, base.digest, "the carry changed the extra history");
});

test("regression: the base files do not change when only the extra pot's inflows do (the base never reads X)", () => {
  if (only && only !== "baseline") return;
  const base = results.get("baseline")!;
  const doubled = runScenario({ ...SCENARIOS[0], extraInflowMul: 2n });
  assert.deepStrictEqual(doubled.baseHashes, base.baseHashes, "a base file changed with the extra pot's inflows");
  assert.notStrictEqual(doubled.digest, base.digest, "the extra pot did not change at all");
});

test("regression: the same seed gives the same history (reproducible)", () => {
  const s = SCENARIOS.find((x) => x.name === (only ?? "owner-gone"))!;
  assert.strictEqual(runScenario(s).digest, results.get(s.name)!.digest);
});

test("regression: the digests are the pinned ones (test/fixtures/regression-104.json)", () => {
  if (only) return;
  const now = { kind: "moon-forge-regression-104", weeks: WEEKS, scenarios: Object.fromEntries([...results].map(([n, r]) => [n, r.digest])), table };
  if (process.env.REG104_UPDATE === "1") {
    fs.writeFileSync(FIXTURE, JSON.stringify(now, null, 2) + "\n");
    console.log("regression-104: test/fixtures/regression-104.json rewritten");
    return;
  }
  assert(fs.existsSync(FIXTURE), "test/fixtures/regression-104.json is missing (REG104_UPDATE=1 writes it)");
  const pinned = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  for (const [n, d] of Object.entries(now.scenarios)) {
    assert.strictEqual(d, pinned.scenarios[n], `${n}: the 104-week history changed (engine or model). Review the table below, then REG104_UPDATE=1 npm test rewrites the pin.\n${table.join("\n")}`);
  }
});

console.log(`regression-104: ${results.size} scenario(s) × ${WEEKS} weeks, ${((Date.now() - started) / 1000).toFixed(1)} s`);
for (const line of table) console.log(`  ${line}`);
for (const [n, r] of results) console.log(`  ${n.padEnd(17)} ${Object.entries(r.stats).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`regression-104 tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

