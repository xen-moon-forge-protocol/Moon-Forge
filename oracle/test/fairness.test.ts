/**
 * Rewards v3 property suite (SPEC-v3 §11, with the spec-review amendments).
 *
 * Randomized worlds (fixed seed) chained over 1–4 epochs: free pools from 1 to 1e6 XNT, 0–8 Artifacts of
 * every tier and origin (transfers, recycles, a v2 → v3 switch now and then), 0–30 burns per week across
 * 2–3 chains with same-hour clusters, skipped chains, XNT moves and thin or empty markets. Every epoch is
 * built with the real computeEpochV3 and paid through an independent TS mirror of the upgraded program's
 * publish_epoch / claim math (forge.rs: drop_reserve = 0, A13.1). The pool evolves with the payouts; now and then
 * it loses 5–65% during a week after F_ref was fixed (shortfalls), and it often falls by the whole tolerated 0.5%
 * between the build and the publication. F_ref is free_pool_before − the budget.
 * The base pot is the two-pot base (A13.1): an Artifact enters it only as the base share of its forge (an inflow);
 * the snapshot is recorded for the extra pot and never read, which the suite checks exactly, per epoch and across
 * whole histories (NFT-1), and per burn, holder against non-holder (NFT-2).
 *   npm test                         (FAIRNESS_WORLDS=3000 npm test for a longer run)
 */
import assert from "assert";
import { PublicKey } from "@solana/web3.js";
import { baseScore, buildTree, ChainSnapshot, computeLeaves, dataHash as dataHashV2, EpochBody, EpochFile, epochRateCap } from "../src/epoch";
import { Burn } from "../src/evm";
import {
  AnyEpochFile, buildLimit, BurnInputV3, BurnV3, buildEpochFileV3, ChainInputV3, computeEpochV3, DEFAULT_RULES_V3, EpochBodyV3, EpochFileV3, EpochInputsV3, globalOrder,
  operatorOfV3, ORIGIN_DROP, ORIGIN_FORGED, ORIGIN_GENESIS, plannedOutflow, rankClassV3, rankOrderV3, rebuildReason, retiredBaseTerms, RulesBlockV3, SnapshotRecord, verifyAny,
} from "../src/rewards";

const WORLDS = Number(process.env.FAIRNESS_WORLDS || 500);
const SEED = 20_261_016;
const XNT = 1_000_000_000n;
const XEN = 10n ** 18n;
const DAY = 86_400;
const HOUR = 3_600;
const WEEK = 7 * DAY;
const T0 = 1_790_208_000;
const PROGRAM = "57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9";

// programs/moon-forge/src/constants.rs
const EPOCH_BUDGET_BPS = 1_000n;
/** the recycle floor of a Forge Drop Lunar Dust (a legacy Artifact origin) */
const DROP_BACKING = 5n * XNT;
const KEEPER_TIP = 2_000_000n;
/** the UPGRADED program's keeper-tip minimum (forge.rs keeper_tip_due, SPEC-UPGRADE-v2 2.11): v3 files publish only there (W2-4) */
const KEEPER_TIP_MIN_CLAIM = 100n * KEEPER_TIP;
/** the engine's dust line (rewards.ts VEST_MIN_ENT, 0.02 XNT): a vesting burn entitled to less is paid as Launchpad */
const VEST_MIN_ENT = 10n * KEEPER_TIP;
const TIER_PENALTY_BPS = [0n, 6_000n, 7_500n];
const ARTIFACT_PRICE = [10n * XNT, 25n * XNT, 60n * XNT, 200n * XNT];

// ── program mirror (the upgraded forge.rs publish_epoch / verify_and_book: drop_reserve = 0) ──────────────
interface OnChainEpoch {
  totalScore: bigint;
  budget: bigint;
  dropReserve: bigint;
  claimed: bigint;
}
function publishMirror(free: bigint, totalScore: bigint, leaves: number, rateCap = 1n): OnChainEpoch {
  if (totalScore <= 0n || leaves <= 0 || rateCap <= 0n) throw new Error("EmptyEpoch");
  let budget = (free * EPOCH_BUDGET_BPS) / 10_000n;
  const capped = totalScore * rateCap;
  if (capped < budget) budget = capped;
  if (budget <= 0n) throw new Error("PoolEmpty");
  // Forge Drops are off for every epoch the upgraded program publishes (A13.1)
  const dropReserve = 0n;
  return { totalScore, budget: budget - dropReserve, dropReserve, claimed: 0n };
}
function claimMirror(e: OnChainEpoch, score: bigint): bigint {
  if (score >= 2n ** 64n || score > e.totalScore) throw new Error("InvalidProof");
  const amount = (score * e.budget) / e.totalScore;
  if (amount <= 0n) throw new Error("AmountTooSmall");
  if (e.claimed + amount > e.budget) throw new Error("BudgetExhausted");
  e.claimed += amount;
  return amount;
}

// ── deterministic randomness ─────────────────────────────────────────────────────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
let rand = mulberry32(SEED);
const ri = (n: number) => Math.floor(rand() * n);
const chance = (p: number) => rand() < p;
const pick = <T>(xs: readonly T[]) => xs[ri(xs.length)];
const logU = (lo: number, hi: number) => Math.exp(Math.log(lo) + rand() * (Math.log(hi) - Math.log(lo)));
const big = (x: number) => BigInt(Math.floor(x));
const shuffle = <T>(xs: T[]) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = ri(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);
const max0 = (v: bigint) => (v > 0n ? v : 0n);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const keyOf = (tag: number, i: number) => {
  const b = new Uint8Array(32);
  b[0] = 0xf0;
  b[1] = tag & 255;
  b[2] = (tag >> 8) & 255;
  b[3] = (tag >> 16) & 255;
  b[4] = i;
  return new PublicKey(b).toBase58();
};
const blockAt = (ts: number) => ts - T0 + 2 * WEEK;
const iso = (ts: number) => new Date(ts * 1000).toISOString();
/** epoch n−1's on-chain published_at on X1's clock (A8): 60 s after its snapshot block time; a v2 file (the live epoch 1) 1 s BEFORE its createdAt */
const publishedAt = (f: AnyEpochFile) => (f.version === 3 ? f.window.endTs + 60 : Math.floor(Date.parse(f.createdAt) / 1000) - 1);
const burnId = (b: { chainId: number; txHash: string; logIndex: number }) => `${b.chainId}:${b.txHash}:${b.logIndex}`;
const leafKey = (player: string, tier: number) => `${player}:${tier}`;

// ── worlds ─────────────────────────────────────────────────────────────────────────────────────
interface ArtSpec {
  asset: string;
  tier: number;
  origin: number;
  backing: bigint;
  /** the base pot's 20% of the forge price (= 0.4 × backing, nft-extra REPORT A1): an inflow, nothing else */
  poolShare: bigint;
  /** 0 = before the first build */
  forgedIn: number;
  /** owners[e] = owner at build e's snapshot (0 = the v2 snapshot); a self-transfer is invisible */
  owners: string[];
  recycledIn: number | null;
}
interface ChainSpec {
  chainId: number;
  p0: bigint;
  spot: bigint[];
  L: bigint[];
  skip: Set<number>;
}
interface World {
  id: number;
  builds: number;
  exact: boolean;
  v2Start: boolean;
  /** v2 epochs published before the switch, each paying 10% of the free pool (F1) */
  v2Epochs: number;
  F0: bigint;
  inflow: bigint[];
  /**
   * lamports that leave the free pool during week e after F_ref was fixed (third-party tips, an earlier epoch's drop
   * luck): shortfalls. An absolute amount, the same in every history of the world, as those payouts are.
   */
  shrink: bigint[];
  /** the pool drops by the whole tolerated 0.5% between build e and its publication */
  drift: boolean[];
  xnt: { twap: bigint; api: bigint }[];
  /** window ends: the X1 block time of each build's snapshot slot */
  endTs: number[];
  /** the runner's clock minus X1's at each build, −20…+20 min: createdAt only (A8) */
  skew: number[];
  wallets: string[];
  chains: ChainSpec[];
  arts: ArtSpec[];
  burns: BurnInputV3[];
  v2burns: Burn[];
  /** D-18 / PROOF_BURN_RULE (c): the rules block with operator wallets (and now and then a dated exception), or null (the default block) */
  rules: RulesBlockV3 | null;
}

const CHAIN_IDS = [10, 56, 137, 8453, 43114];

function genWorld(id: number): World {
  rand = mulberry32((SEED ^ Math.imul(id + 1, 2_654_435_761)) >>> 0);
  const builds = 1 + ri(4);
  const exact = chance(0.5);
  const F0 = big(logU(1, 1e6) * 1e9);
  const wallets = Array.from({ length: 4 + ri(7) }, (_, i) => keyOf(id, i));
  const endTs = Array.from({ length: builds + 1 }, (_, e) => (e === 0 ? T0 : T0 + e * WEEK + ri(3 * HOUR)));
  const skew = Array.from({ length: builds + 1 }, () => ri(40 * 60 + 1) - 20 * 60);
  const xnt = Array.from({ length: builds + 1 }, () => {
    const api = big(0.153 * logU(0.5, 2) * 1e18);
    return { api, twap: big(Number(api) * logU(0.9, 1.1)) };
  });
  const inflow = Array.from({ length: builds + 1 }, () => (chance(0.3) ? big(Number(F0) * logU(0.001, 0.05)) : 0n));
  const chains: ChainSpec[] = shuffle(CHAIN_IDS).slice(0, 2 + ri(2)).map((chainId) => {
    const p0 = exact ? BigInt(1 + ri(1_000)) * 10n ** 13n : big(logU(1e-10, 1e-5) * 1e18);
    const spot = Array.from({ length: builds + 1 }, () => (exact ? p0 : big(Number(p0) * logU(0.5, 2))));
    const L = Array.from({ length: builds + 1 }, () => {
      const r = rand();
      const base = big(logU(50, 20_000) * 1e6);
      return r < 0.08 ? 0n : r < 0.16 ? base * 5n : base;
    });
    const skip = new Set<number>();
    for (let e = 1; e <= builds; e++) if (chance(0.08)) skip.add(e);
    return { chainId, p0, spot, L, skip };
  });

  const arts: ArtSpec[] = Array.from({ length: ri(9) }, (_, k) => {
    const tier = pick([0, 0, 0, 1, 1, 2, 3]);
    const r = rand();
    const origin = r < 0.7 ? ORIGIN_FORGED : r < 0.9 ? ORIGIN_GENESIS : ORIGIN_DROP;
    let price = ARTIFACT_PRICE[tier];
    for (let m = ri(6); m > 0; m--) price = (price * 21n) / 20n;
    const backing = origin === ORIGIN_FORGED ? price / 2n : origin === ORIGIN_DROP ? DROP_BACKING : 0n;
    const forgedIn = chance(0.4) ? 0 : 1 + ri(builds);
    const owners: string[] = [];
    let o = pick(wallets);
    for (let e = 0; e <= builds; e++) {
      if (e > 0 && chance(0.15)) o = pick(wallets.filter((x) => x !== o));
      owners.push(o);
    }
    const recycledIn = chance(0.15) ? forgedIn + 1 + ri(builds) : null;
    return { asset: keyOf(id, 100 + k), tier, origin, backing, poolShare: origin === ORIGIN_FORGED ? (backing * 2n) / 5n : 0n, forgedIn, owners, recycledIn };
  });

  const logCount = new Map<string, number>();
  let counter = 0;
  const mkBurn = (c: ChainSpec, e: number, ts: number): BurnInputV3 => {
    const block = blockAt(ts);
    const slot = `${c.chainId}:${block}`;
    const n = logCount.get(slot) ?? 0;
    logCount.set(slot, n + 1);
    const usd = logU(0.000_5, 3_000);
    const median = exact ? (c.p0 * BigInt(5 + ri(8))) / 10n : big(Number(c.spot[Math.max(0, e)]) * logU(0.3, 3));
    // exact worlds keep every reading a multiple of 1e12, so spot = whole XEN × price / 1e12 has no floor
    const last = exact ? (c.p0 * BigInt(5 + ri(8))) / 10n : big(Number(median) * logU(0.8, 1.25));
    const fallback = !exact && chance(0.1);
    const xen = usd / (Number(median) / 1e18);
    const amountWei = exact ? BigInt(Math.max(1, Math.floor(xen))) * XEN : big(xen * 1e18) + BigInt(ri(1_000_000));
    // XNT at the burn (A1): around the epoch's market, now and then without candles
    const xm = big(Number(xnt[Math.max(0, e)].api) * logU(0.85, 1.15));
    const xl = big(Number(xm) * logU(0.95, 1.05));
    const xFallback = chance(0.1);
    const seq = ++counter;
    return {
      chainId: c.chainId, txHash: "0x" + `${id.toString(16)}f${seq.toString(16)}`.padStart(64, "0"), logIndex: 100 * n, blockNumber: block,
      missionId: String(seq), pilot: "0x" + "cd".repeat(20), amountWei: amountWei.toString(), tier: ri(3), x1: pick(wallets), timestamp: ts,
      medianE18: fallback ? "0" : median.toString(), lastCloseE18: fallback ? "0" : last.toString(), priceSource: fallback ? "fallback" : "candles",
      xntMedianE18: xFallback ? "0" : xm.toString(), xntLastCloseE18: xFallback ? "0" : xl.toString(), xntSource: xFallback ? "fallback" : "candles",
    };
  };
  const burns: BurnInputV3[] = [];
  for (let e = 1; e <= builds; e++) {
    const n = ri(31);
    const week: BurnInputV3[] = [];
    for (let j = 0; j < n; j++) {
      let c = pick(chains);
      let ts = endTs[e - 1] + 1 + ri(endTs[e] - endTs[e - 1]);
      if (week.length && chance(0.3)) {
        const prior = pick(week);
        c = chains.find((x) => x.chainId === prior.chainId)!;
        const hourStart = Math.floor(prior.timestamp / HOUR) * HOUR;
        ts = Math.min(endTs[e], Math.max(endTs[e - 1] + 1, hourStart + ri(HOUR)));
      }
      week.push(mkBurn(c, e, ts));
    }
    burns.push(...week);
  }
  const v2Start = chance(0.15);
  const v2Epochs = v2Start ? 1 + ri(5) : 1;
  const v2burns: Burn[] = [];
  if (v2Start) {
    for (const c of chains) {
      if (!chance(0.7)) continue;
      v2burns.push(v2Of(mkBurn(c, 0, T0 - 1 - ri(WEEK - 10)), c.spot[0]));
    }
  }
  // drawn last so that every earlier draw (and so every world) stays as it was
  // one loss in a week after the first: 5–60% of a lower bound of every history's pool at that build (each v2
  // publication pays at most 11%, each v3 one at most 10% plus the 0.5% drift), so it is never clamped
  const shrinkAt = builds >= 2 && chance(0.4) ? 2 + ri(builds - 1) : 0;
  const shrinkBps = BigInt(500 + ri(5_500));
  let floorPool = F0;
  for (let k = 0; v2Start && k < v2Epochs; k++) floorPool -= (floorPool * 1_100n) / 10_000n;
  for (let e = 1; e < shrinkAt; e++) floorPool -= (floorPool * 1_100n) / 10_000n;
  const shrink = Array.from({ length: builds + 1 }, (_, e) => (e === shrinkAt ? (floorPool * shrinkBps) / 10_000n : 0n));
  const drift = Array.from({ length: builds + 1 }, () => chance(0.3));
  // drawn after everything else (every earlier draw stays as it was): D-18 operator wallets in a quarter of the worlds,
  // half of them with a dated, named exception (PROOF_BURN_RULE c) for another wallet over part of the history
  let rules: RulesBlockV3 | null = null;
  if (chance(0.25)) {
    const ops = shuffle(wallets).slice(0, 1 + ri(2));
    const exceptions: RulesBlockV3["operatorWallets"]["exceptions"] = [];
    const others = wallets.filter((x) => !ops.includes(x));
    if (chance(0.5) && others.length) {
      const fromTs = T0 + ri(builds) * WEEK + ri(3 * DAY);
      const untilTs = fromTs + DAY + ri(2 * WEEK);
      exceptions.push({ name: "proof plan test", wallets: [pick(others)], fromTs, untilTs, published: iso(fromTs - DAY).slice(0, 10) });
    }
    rules = { ...DEFAULT_RULES_V3, operatorWallets: { rule: "rank-last", wallets: [...ops].sort(), exceptions } };
  }
  return { id, builds, exact, v2Start, v2Epochs, F0, inflow, shrink, drift, xnt, endTs, skew, wallets, chains, arts, burns, v2burns, rules };
}

/** a v2 burn record (v2 prices it at its own median; the build spot when it had no candles) */
function v2Of(b: BurnInputV3, spot: bigint): Burn {
  return {
    chainId: b.chainId, txHash: b.txHash, logIndex: b.logIndex, blockNumber: b.blockNumber, missionId: b.missionId, pilot: b.pilot, amountWei: b.amountWei,
    tier: b.tier, x1: b.x1, timestamp: b.timestamp, priceE18: b.medianE18 === "0" ? spot.toString() : b.medianE18, priceSource: "t",
  };
}

function v2FileFor(w: World, arts: ArtSpec[]): EpochFile | null {
  const chains: ChainSnapshot[] = w.chains.map((c) => ({
    chainId: c.chainId, name: `chain-${c.chainId}`, portal: "0xportal", fromBlockExclusive: blockAt(T0 - WEEK), toBlock: blockAt(T0), xenUsd: Number(c.p0) / 1e18,
    xenUsdE18: c.p0.toString(), priceSource: "t", clamped: false, liquidityUsdMicro: c.L[0].toString(), pools: [], totalSupply: "0",
  }));
  const leaves = computeLeaves(w.v2burns, chains, []);
  if (!leaves.length) return null;
  const t = buildTree(w.v2Epochs, leaves);
  const holders = arts.filter((a) => a.forgedIn === 0).map((a) => ({ owner: a.owners[0], asset: a.asset, tier: a.tier }));
  const body: EpochBody = {
    version: 2, programId: PROGRAM, epoch: w.v2Epochs, createdAt: iso(T0), chains, xnt: { usd: Number(w.xnt[0].api) / 1e18, usdE18: w.xnt[0].api.toString(), source: "t" },
    kBps: 12_500, rateCap: epochRateCap(12_500, w.xnt[0].api.toString(), baseScore(w.v2burns, chains), BigInt(t.totalScore)).toString(),
    artifacts: { slot: 1, holders, eligible: [] }, burns: w.v2burns, leaves, totalScore: t.totalScore, root: t.root,
  };
  return { ...body, dataHash: dataHashV2(body), proofs: t.proofs };
}

const alive = (a: ArtSpec, e: number) => a.forgedIn <= e && (a.recycledIn === null || e < a.recycledIn);

function inputsFor(w: World, arts: ArtSpec[], e: number, prev: AnyEpochFile | null, pool: bigint, open: bigint | null): EpochInputsV3 {
  const endTs = w.endTs[e];
  const chains: ChainInputV3[] = [];
  for (const c of w.chains) {
    if (c.skip.has(e)) continue;
    const from = prev?.chains.find((x) => x.chainId === c.chainId)?.toBlock ?? 0;
    const to = blockAt(endTs);
    chains.push({
      chainId: c.chainId, name: `chain-${c.chainId}`, portal: "0xportal", fromBlockExclusive: from, toBlock: to,
      market: { spotE18: c.spot[e].toString(), refUsdE18: c.p0.toString(), priceSource: "test", pools: [{ address: "0xpool", reserveUsd: "1234.5", createdAt: iso(T0 - 30 * DAY) }] },
      liquidityNowMicro: c.L[e].toString(), totalSupply: "0", burns: w.burns.filter((b) => b.chainId === c.chainId && b.blockNumber > from && b.blockNumber <= to),
    });
  }
  const records: SnapshotRecord[] = arts.filter((a) => alive(a, e)).map((a) => ({ asset: a.asset, tier: a.tier, owner: a.owners[e], backing: a.backing.toString(), origin: a.origin }));
  return {
    programId: PROGRAM, epoch: (prev?.epoch ?? 0) + 1, createdAt: iso(endTs + w.skew[e]), window: { startTs: prev ? publishedAt(prev) : endTs - WEEK, endTs },
    chains, snapshot: { slot: 5_000 + e, records }, freePool: { lamports: pool.toString(), slot: 4_999 + e, open: open === null ? null : open.toString() },
    xnt: { twapE18: w.xnt[e].twap.toString(), apiE18: w.xnt[e].api.toString(), source: "test" },
    switchRefs: prev?.version === 2 ? prev.chains.map((c) => ({ chainId: c.chainId, readings: [c.xenUsdE18] })) : null,
    ...(w.rules ? { rulesBlock: w.rules } : {}),
  };
}

interface Paid {
  build: number;
  inputs: EpochInputsV3;
  prev: AnyEpochFile | null;
  raw: string;
  file: EpochFileV3;
  /** the free pool at publication (the build reading, or 0.5% less) */
  pool: bigint;
  chain: OnChainEpoch;
  claims: Map<string, bigint>;
}

/**
 * One history of the world with the Artifacts `keep` selects in the snapshots (the others were never forged), whose
 * base share of the forge entered the pool for the Artifacts `inflow` selects (by default the same ones). `drift` lets
 * the pool fall by the whole tolerated 0.5% before each publication the world draws: a proportional loss, so the
 * counterfactual comparisons run without it, the external payouts being the same in both histories.
 */
function run(w: World, keep: (a: ArtSpec) => boolean, drift = true, inflow: (a: ArtSpec) => boolean = keep): (Paid | null)[] {
  const arts = w.arts.filter(keep);
  const paidIn = w.arts.filter(inflow);
  let pool = w.F0 + sum(paidIn.filter((a) => a.forgedIn === 0).map((a) => a.poolShare));
  let prev: AnyEpochFile | null = w.v2Start ? v2FileFor(w, arts) : null;
  // each v2 epoch paid 10% of the free pool as budget and, at worst, 1% more as drop luck beyond the reserve,
  // the pool share of the v2-era Artifacts included (F1)
  if (prev) for (let k = 0; k < w.v2Epochs; k++) pool -= (pool * 1_100n) / 10_000n;
  let open: bigint | null = prev ? pool : null;
  const out: (Paid | null)[] = [];
  for (let e = 1; e <= w.builds; e++) {
    pool += w.inflow[e] + sum(paidIn.filter((a) => a.forgedIn === e).map((a) => a.poolShare));
    pool -= w.shrink[e] < pool ? w.shrink[e] : pool;
    const inputs = inputsFor(w, arts, e, prev, pool, open);
    const built = buildEpochFileV3(inputs, prev);
    if (!built) {
      out.push(null);
      continue;
    }
    const raw = JSON.stringify(built);
    const file = JSON.parse(raw) as EpochFileV3;
    // the pool may fall by the whole drift the rebuild rule tolerates before publish_epoch (F-DRIFT)
    if (drift && w.drift[e]) pool -= (pool * 50n) / 10_000n;
    if (rebuildReason(file, pool) !== null) throw new Error(`world ${w.id} build ${e}: ${rebuildReason(file, pool)}`);
    const chain = publishMirror(pool, BigInt(file.totalScore), file.leaves.length);
    const claims = new Map<string, bigint>();
    for (const l of file.leaves) claims.set(leafKey(l.player, l.tier), claimMirror(chain, BigInt(l.score)));
    out.push({ build: e, inputs, prev, raw, file, pool, chain, claims });
    pool -= chain.budget;
    open = pool; // F_ref (A2) = free_pool_before − the budget, read right after the publication
    prev = file;
  }
  return out;
}

// ── statistics ─────────────────────────────────────────────────────────────────────────────────
const stats = {
  worlds: 0, published: 0, nulls: 0, burns: 0, leaves: 0, v2Starts: 0, recycles: 0, transfers: 0, skippedChains: 0, converted: 0, locked: 0,
  scaledDown: 0, arrivalCuts: 0, planChecks: 0, prefix: 0, prefixShortfall: 0, a9SizeShortfall: 0, a9Shortfall: 0, driftPublishes: 0, i2: 0, i2Shortfall: 0, i3: 0, i4: 0, i4Inexact: 0, i4ValueGrowth: 0n, i4EntGrowth: 0n, i4Flips: 0,
  i4MaxExcess: 0n, i4Shortfall: 0, i7: 0, i7Shortfall: 0, i7Own: 0, i9Shortfall: 0, i10: 0, i10Shortfall: 0, i11: 0, plannedMax: 0,
  a9Attacks: 0, a9AttackLocks: 0, a9Sabotage: 0, a9Size: 0, a9SizeFlips: 0, i2KeptFlips: 0, i2ReservedMore: 0, locksSplit: 0,
  nft1Epochs: 0, nft1Histories: 0, nft1Holders: 0, nft2: 0, nft2Missions: 0, nft2Shortfall: 0, inflow: 0, inflowWallets: 0, inflowFlips: 0, inflowMisaligned: 0,
  backlogBurns: 0, operatorBurns: 0, exceptionBurns: 0, d12: 0, d18: 0, rankedAfter: 0,
};
/** D-12 / D-18: a burn that ranks after the window's burns (a skipped chain's backlog, or an operator burn) */
const late = (b: BurnV3) => rankClassV3(b) !== 0;
/** a shortfall week: the latest claims were cut literally (A13.2; C and the schedule never are) */
const isCut = (f: EpochBodyV3) => f.capacity.shortfall !== null;
/** what a burn takes at its own arrival (A9, A12): claim, lock piece, leaf; the leftover top-up is not part of it (A4) */
const arrivalOf = (b: BurnV3) => `${b.senior}/${b.lockedLp}/${b.bandPaid}/${b.leafTier}/${b.converted}`;
/** a file without the members that may differ with the Artifacts: the snapshot and the hashes that cover it (NFT-1) */
const blind = (f: EpochBodyV3) => {
  const { snapshot: _s, prevDataHash: _p, dataHash: _h, ...rest } = f as EpochFileV3;
  return JSON.stringify(rest);
};

function fail(w: World, label: string, msg: string): never {
  throw new Error(`world ${w.id} (builds ${w.builds}, exact ${w.exact}, v2 ${w.v2Start}) ${label}: ${msg}`);
}
function check(w: World, label: string, cond: boolean, msg: () => string) {
  if (!cond) fail(w, label, msg());
}

const targetsBy = (f: { targets: { player: string; target: string }[] }) => {
  const m = new Map<string, bigint>();
  for (const t of f.targets) m.set(t.player, (m.get(t.player) ?? 0n) + BigInt(t.target));
  return m;
};
/** the burns locked on their own tier (A9: decided per burn at its arrival) */
const lockedIds = (f: EpochBodyV3) => new Set(f.burns.filter((b) => b.leafTier > 0).map(burnId));
/** what a burn takes at its arrival (A9): its senior, lp + the band cover when locked, at most lp otherwise */
const netOf = (b: BurnV3) => BigInt(b.senior);
/** the band the missions locked in `a` take there while converted (taking their Launchpad layer only) in `b` (A9 residual) */
const lockedFlips = (a: EpochBodyV3, b: EpochBodyV3) => {
  const lb = lockedIds(b);
  return sum(a.burns.filter((x) => x.leafTier > 0 && !lb.has(burnId(x))).map((x) => BigInt(x.bandPaid)));
};
/** `a` locks a mission that `b` does not */
const locksMore = (a: EpochBodyV3, b: EpochBodyV3) => {
  const lb = lockedIds(b);
  return [...lockedIds(a)].some((id) => !lb.has(id));
};
const paidFromC = (f: EpochBodyV3) => sum(f.burns.map((b) => BigInt(b.basePaid) + BigInt(b.bandPaid)));

// ── per-epoch invariants ─────────────────────────────────────────────────────────────────────────
function checkEpoch(w: World, p: Paid) {
  const f = p.file;
  const label = `build ${p.build} (epoch ${f.epoch})`;
  const F = BigInt(f.freePool.lamports);
  const TS = BigInt(f.totalScore);
  const limit = (F * EPOCH_BUDGET_BPS) / 10_000n;
  stats.published++;
  stats.burns += f.burns.length;
  stats.leaves += f.leaves.length;
  if (f.capacity.shortfall !== null) {
    stats.scaledDown++;
    if (f.capacity.shortfall.stage === "arrival") stats.arrivalCuts++;
  }
  if (p.pool < F) stats.driftPublishes++;

  // I1: planned outflow (Σ score + keeper tips: a v3 epoch has no drop reserve and no drop luck, A13.1) within 10% of the
  // pool at build less the rebuild drift, and within 10% of the pool at publication
  check(w, label, TS <= limit, () => `I1: totalScore ${TS} > 10% of ${F}`);
  check(w, label, plannedOutflow(f.leaves.map((l) => BigInt(l.score)), TS) <= buildLimit(F), () => "I1: Σ score + keeper tips above the build limit (A3.1, F-DRIFT)");
  // I9 precondition, also when the pool fell by the whole tolerated drift before publication
  check(w, label, p.chain.budget === TS && p.chain.dropReserve === 0n, () => `I9 precondition: on-chain budget capped below totalScore (pool ${p.pool} vs build ${F})`);
  if (f.capacity.shortfall !== null) stats.i9Shortfall++;
  const tipped = BigInt([...p.claims.values()].filter((c) => c >= KEEPER_TIP_MIN_CLAIM).length);
  const planned = p.chain.budget + KEEPER_TIP * tipped;
  check(w, label, planned <= (p.pool * EPOCH_BUDGET_BPS) / 10_000n, () => `I1: planned outflow ${planned} > 10% of the pool at publication ${p.pool}`);
  stats.plannedMax = Math.max(stats.plannedMax, Number(planned) / Number(F));

  // I9 / I12 (A13.1, exact): score = target and budget = totalScore, so every claim is exactly its target
  const T = sum(f.targets.map((t) => BigInt(t.target)));
  check(w, label, f.targets.length === f.leaves.length && f.targets.every((t, i) => f.leaves[i].player === t.player && f.leaves[i].tier === t.tier && f.leaves[i].score === t.target), () => "leaves differ from targets");
  for (const t of f.targets) {
    const c = p.claims.get(leafKey(t.player, t.tier))!;
    check(w, label, c === BigInt(t.target), () => `I9 / I12: claim ${c} is not the target ${t.target}`);
  }
  check(w, label, p.chain.claimed === p.chain.budget, () => "the claims do not add up to the budget");

  // allocation bookkeeping: nothing is scaled after the fact, a shortfall included, and nothing is added (no lane, no
  // boost): the targets are exactly the burners' allocations
  const cash = BigInt(f.capacity.cash);
  check(w, label, cash === (BigInt(f.freePool.ref) * 800n) / 10_000n, () => `C ${cash} is not 8% of F_ref ${f.freePool.ref}`);
  check(w, label, paidFromC(f) <= cash, () => "burners received more than the cash capacity");
  check(w, label, T === paidFromC(f), () => "targets != the burners' allocations");
  if (f.capacity.shortfall !== null) {
    // A13.2: the literal cut. burns[0..kept) keep that stage's claim whole, burns[kept] is cut, every later claim is 0; an
    // arrival cut cancels the whole leftover pass. C and the schedule are never cut
    const s = f.capacity.shortfall;
    const bs = f.burns;
    check(
      w, label,
      Object.keys(s).sort().join() === "claim,kept,planned,stage,wanted" && (s.stage === "arrival" || s.stage === "leftover") && s.kept >= 0 && s.kept < bs.length &&
        BigInt(s.claim) >= 0n && BigInt(s.claim) < BigInt(s.wanted) && BigInt(s.planned) > paidFromC(f) && BigInt(s.planned) <= cash,
      () => `shortfall bookkeeping ${JSON.stringify(s)}`,
    );
    // D-12 / D-18: the claims are made in the plan's order (stage 1: the window's burns and the backlog, arrival then
    // leftover; stage 2: the operator burns, arrival then leftover); the cut is literal over that whole sequence
    const ranked = rankOrderV3(bs);
    check(w, label, JSON.stringify(ranked.arrival.map(burnId)) === JSON.stringify(bs.map(burnId)), () => "the file's burns are not in the arrival order");
    const seq = ranked.plan.stages.flatMap((st) => [...st.arrival.map((i) => ({ i, k: "arrival" as const })), ...st.leftover.map((i) => ({ i, k: "leftover" as const }))]);
    const at = seq.findIndex((x) => x.i === s.kept && x.k === s.stage);
    const topUp = (b: BurnV3) => BigInt(b.alloc) - BigInt(b.senior);
    check(w, label, at >= 0 && seq.slice(at + 1).every((x) => (x.k === "arrival" ? bs[x.i].senior === "0" : topUp(bs[x.i]) === 0n)), () => `${s.stage} cut at ${s.kept}: a later claim or top-up is paid`);
    if (s.stage === "arrival") check(w, label, BigInt(bs[s.kept].senior) <= BigInt(s.claim), () => `arrival cut at ${s.kept}: more than the cut claim`);
    else check(w, label, topUp(bs[s.kept]) === BigInt(s.claim), () => `leftover cut at ${s.kept}: the top-up is not the cut claim`);
    // against the plan (the same week with a pool that carries it: C is fixed by F_ref, so only the limit moves)
    if (p.inputs.freePool.open !== null) {
      const plan = rebuild(p, (inp) => (inp.freePool.lamports = (2n ** 63n).toString()));
      check(w, label, plan !== null && plan.capacity.shortfall === null && paidFromC(plan) === BigInt(s.planned) && plan.capacity.cash === f.capacity.cash, () => `the plan ${plan && paidFromC(plan)} is not the recorded ${s.planned}`);
      const pb = plan!.burns;
      // every claim before the cut in the sequence is the planned one, whole
      for (const x of seq.slice(0, at)) {
        if (x.k === "arrival") check(w, label, arrivalOf(bs[x.i]) === arrivalOf(pb[x.i]), () => `burn ${x.i} before the cut (${s.stage} at ${s.kept}) does not keep its planned arrival outcome`);
        else check(w, label, topUp(bs[x.i]) === topUp(pb[x.i]), () => `burn ${x.i} before the ${s.stage} cut at ${s.kept} does not keep its planned top-up`);
      }
      stats.planChecks++;
    }
  }
  // NFT-1 (structure, A13.1): no Artifact term and no drop policy can be in a base file
  check(w, label, retiredBaseTerms(f).length === 0, () => `retired base terms ${retiredBaseTerms(f)}`);

  // I10 (structure, A12): every burn's FCFS claim is met at its arrival up to its entitlement; a locked mission holds, on its
  // own tier, a piece of its mission at the full multiplier (never a lamport below it: band paid × lp ≤ piece × band), the
  // rest of its layer being a Launchpad piece on tier 0; a converted one takes and is paid its Launchpad layer only; a
  // vesting burn entitled to less than 0.02 XNT is always paid as Launchpad (F6); the capacity block adds up
  let sSenior = 0n;
  let sBase = 0n;
  let sBand = 0n;
  let sBandPaid = 0n;
  let nLocked = 0;
  let nSplit = 0;
  let nConverted = 0;
  for (const b of f.burns) {
    const [ent, lp, band, senior, basePaid, bandPaid] = [b.ent, b.lp, b.band, b.senior, b.basePaid, b.bandPaid].map(BigInt);
    sSenior += senior;
    sBase += basePaid;
    sBandPaid += bandPaid;
    const vesting = b.tier > 0 && ent >= VEST_MIN_ENT;
    check(w, label, senior <= (vesting ? ent : lp) && basePaid <= lp && basePaid + bandPaid === BigInt(b.alloc), () => `I10: ${burnId(b)} claim or allocation out of bounds`);
    if (b.tier === 0) check(w, label, b.leafTier === 0 && bandPaid === 0n && !b.converted && basePaid >= senior, () => "Launchpad burn with a band");
    else if (!b.converted) {
      stats.locked++;
      nLocked++;
      sBand += band;
      const piece = BigInt(b.lockedLp);
      if (b.split) {
        nSplit++;
        stats.locksSplit++;
      }
      check(
        w, label,
        vesting && b.leafTier === b.tier && piece > 0n && piece <= lp && b.split === piece < lp && bandPaid <= band && bandPaid * lp <= piece * band &&
          basePaid >= piece && senior >= piece + bandPaid && senior - piece - bandPaid <= 3n && BigInt(b.launchpadPaid) === basePaid - piece,
        () => `I10: locked burn ${burnId(b)} off its piece (${b.lockedLp} + ${b.bandPaid} of ${b.lp} + ${b.band}, senior ${b.senior})`,
      );
    } else {
      stats.converted++;
      nConverted++;
      if (vesting) sBand += band;
      check(w, label, b.leafTier === 0 && bandPaid === 0n && senior <= lp && basePaid >= senior, () => `I10: converted burn ${burnId(b)} took more than its Launchpad layer, or lost it`);
    }
  }
  const cap = f.capacity;
  const cashUsed = cash; // A13.2: a shortfall never cuts C or the schedule
  check(
    w, label,
    BigInt(cap.senior) === sSenior && BigInt(cap.base) === sBase && BigInt(cap.bandTotal) === sBand && BigInt(cap.bandPaid) === sBandPaid && cap.splitMissions === nSplit &&
      cap.lockedMissions === nLocked && cap.convertedMissions === nConverted && BigInt(cap.left) === cashUsed - sBase - sBandPaid && BigInt(cap.left) >= 0n &&
      BigInt(cap.tranche) === cashUsed / 7n,
    () => "capacity block does not add up (A9)",
  );
  // nothing consumed is paid to nobody: the leftover is unused only when every Launchpad layer (pieces included) is whole,
  // or when a shortfall cut the claims (A13.2: what is cut stays in the pool)
  if (BigInt(cap.left) > 0n && cap.shortfall === null) check(w, label, f.burns.every((b) => b.basePaid === b.lp), () => "capacity left unused while a Launchpad layer is unmet");

  // the snapshot is recorded as read, sorted by asset, for the extra pot (A12.6)
  check(w, label, JSON.stringify(f.snapshot.records.map((r) => r.asset)) === JSON.stringify(p.inputs.snapshot.records.map((r) => r.asset).sort()), () => "the snapshot is not the one read");

  // §10: the published file verifies against its predecessor
  const errors = verifyAny(f, p.prev);
  check(w, label, errors.length === 0, () => `verify: ${errors.join("; ")}`);
}

// ── variations of one epoch (same prev, same pool) ─────────────────────────────────────────────────
function rebuild(p: Paid, edit: (inp: EpochInputsV3) => void): EpochBodyV3 | null {
  const inp = clone(p.inputs);
  edit(inp);
  return computeEpochV3(inp, p.prev);
}
const allInputBurns = (inp: EpochInputsV3) => inp.chains.flatMap((c) => c.burns);

function checkVariations(w: World, p: Paid) {
  const f = p.file;
  const label = `build ${p.build} (epoch ${f.epoch})`;
  const bs = f.burns;

  // I11: the same inputs in any order give a byte-identical file
  {
    const inp = clone(p.inputs);
    for (const c of inp.chains) c.burns = shuffle(c.burns);
    inp.chains = shuffle(inp.chains);
    inp.snapshot.records = shuffle(inp.snapshot.records);
    const again = buildEpochFileV3(inp, p.prev);
    check(w, label, JSON.stringify(again) === p.raw, () => "I11: shuffled inputs changed the file");
    stats.i11++;
  }

  // the burns in time order (the global order); the file lists them in the arrival order (D-12 / D-18)
  const tbs = [...bs].sort(globalOrder);
  for (const b of bs) {
    if (b.backlog) stats.backlogBurns++;
    if (b.operator) stats.operatorBurns++;
    if (b.exception !== null) stats.exceptionBurns++;
  }

  // I2: removing burns of later clock hours never changes an earlier value or entitlement, nor the senior of an earlier
  // burn of the window (a backlog or operator burn claims after every burn of the window, D-12 / D-18)
  if (tbs.length >= 2) {
    const i = ri(tbs.length - 1);
    const later = tbs.filter((b) => b.hour > tbs[i].hour);
    if (later.length) {
      const drop = new Set(later.filter(() => chance(0.6)).map(burnId));
      if (!drop.size) drop.add(burnId(pick(later)));
      const body = rebuild(p, (inp) => inp.chains.forEach((c) => (c.burns = c.burns.filter((b) => !drop.has(burnId(b))))));
      if (body) {
        const m = new Map(body.burns.map((b) => [burnId(b), b]));
        // A13.2: a shortfall cuts the latest claims literally, so the earlier burns' arrival outcomes are exact in a
        // shortfall week too; only the leftover (A4: not promised) can move
        const cut = isCut(f) || isCut(body);
        if (cut) stats.i2Shortfall++;
        const keptFlip = body.burns.some((b) => (b.leafTier > 0) !== (bs.find((x) => burnId(x) === burnId(b))!.leafTier > 0));
        if (keptFlip) stats.i2KeptFlips++;
        const m0 = new Map(bs.map((b) => [burnId(b), b]));
        // the leftover is not promised (A4): with burns before them gone from the chain's curve, the kept later burns' value and
        // lp grow (F-I4R in reverse) and they take more at their arrival than the removed burns had taken (a removed burn whose
        // tranche was exhausted took nothing there), so the leftover an earlier burn's beyond-tranche claim was waiting for can
        // shrink, by at most what the kept later burns reserve more at arrival, Launchpad layer and band alike
        // D-12 / D-18: the backlog and operator burns claim after the window's burns, so the capacity the dropped burns
        // freed can go to them at their arrival: what they reserve more counts as the kept later burns' does
        const reservedMore = sum(body.burns.filter((b) => m0.has(burnId(b)) && (late(b) || later.some((x) => burnId(x) === burnId(b)))).map((b) => max0(netOf(b) - netOf(m0.get(burnId(b))!))));
        if (reservedMore > 0n) stats.i2ReservedMore++;
        for (let k = 0; k <= i; k++) {
          const a = tbs[k];
          const b = m.get(burnId(a));
          check(w, label, !!b && b.valueMicro === a.valueMicro && b.ent === a.ent, () => `I2: earlier burn ${burnId(a)}'s value changed`);
          if (late(a)) continue;
          // A9, A13.2: the whole arrival outcome is fixed (senior, lock, band, leaf), shortfall or not; the leftover can only
          // grow when later burns go
          check(w, label, arrivalOf(b!) === arrivalOf(a), () => `I2${cut ? " (shortfall)" : ""}: earlier burn ${burnId(a)}'s arrival outcome changed (${arrivalOf(a)} → ${arrivalOf(b!)})`);
          if (!cut && !keptFlip) check(w, label, BigInt(b!.basePaid) + reservedMore >= BigInt(a.basePaid) && BigInt(b!.alloc) + reservedMore >= BigInt(a.alloc), () => `I2: earlier burn ${burnId(a)} lost ${a.alloc} → ${b!.alloc} when later burns were removed (the kept later burns reserve ${reservedMore} more at arrival)`);
        }
        stats.i2++;
      }
    }
  }

  // A13.2 prefix-stability: the first k burns (k at an hour boundary, so no later burn shares their hour's curve pot) are
  // valued, quoted and locked exactly as in the epoch without any later burn, a shortfall week included, and no later
  // burn ever raises an earlier burn's payout: removing all of them can only add leftover
  // (in time order; D-12 / D-18: for the window's burns only, the backlog and the operator burns claiming after all of them,
  // and with them the leftover is the backlog's first: the payout bound then holds only without a late burn)
  if (tbs.length >= 2) {
    const ks = tbs.map((b, i) => i).filter((i) => i > 0 && tbs[i].hour > tbs[i - 1].hour);
    if (ks.length) {
      const k = pick(ks);
      const later = new Set(tbs.slice(k).map(burnId));
      const body = rebuild(p, (inp) => inp.chains.forEach((c) => (c.burns = c.burns.filter((b) => !later.has(burnId(b))))));
      if (body) {
        const m = new Map(body.burns.map((b) => [burnId(b), b]));
        const anyLate = body.burns.some(late);
        for (const a of tbs.slice(0, k)) {
          const b = m.get(burnId(a));
          check(w, label, !!b && b.valueMicro === a.valueMicro, () => `prefix: ${burnId(a)}'s value depends on a later burn`);
          if (late(a)) continue;
          check(w, label, arrivalOf(b!) === arrivalOf(a), () => `prefix: ${burnId(a)}'s arrival outcome depends on a later burn (${arrivalOf(a)} → ${b && arrivalOf(b)})`);
          if (!anyLate) check(w, label, BigInt(b!.alloc) >= BigInt(a.alloc), () => `prefix: later burns raised ${burnId(a)}'s payout (${b!.alloc} → ${a.alloc})`);
        }
        stats.prefix++;
        if (isCut(f) || isCut(body)) stats.prefixShortfall++;
      }
    }
  }

  // D-12 / D-18: every burn of the window claims before every backlog and operator burn. Removing all of those never
  // changes a value on a chain that had none of them, and never changes the arrival outcome of a burn of the window as
  // long as no earlier burn of the window changed value (a backlog or operator burn still enters its own chain's curve
  // at its own hour, so it can lower the value of the later burns of that chain: valuation is by time, seniority is not)
  if (bs.some(late)) {
    const gone = new Set(bs.filter(late).map(burnId));
    const touched = new Set(bs.filter(late).map((b) => b.chainId));
    const body = rebuild(p, (inp) => inp.chains.forEach((c) => (c.burns = c.burns.filter((b) => !gone.has(burnId(b))))));
    if (body) {
      const m = new Map(body.burns.map((b) => [burnId(b), b]));
      check(w, label, body.burns.every((b) => !late(b)), () => "D-12 / D-18: a late burn is left after removing them all");
      let clean = true;
      for (const a of bs) {
        if (late(a)) continue;
        const b = m.get(burnId(a))!;
        if (!touched.has(a.chainId)) check(w, label, b.valueMicro === a.valueMicro, () => `D-12 / D-18: ${burnId(a)} on a chain without a late burn changed value`);
        if (b.valueMicro !== a.valueMicro) clean = false;
        if (clean) check(w, label, arrivalOf(b) === arrivalOf(a), () => `D-12 / D-18: ${burnId(a)}'s arrival outcome depends on a backlog or operator burn (${arrivalOf(a)} → ${arrivalOf(b)})`);
        stats.rankedAfter++;
      }
      if (bs.some((b) => b.backlog)) stats.d12++;
      if (bs.some((b) => b.operator)) stats.d18++;
    }
  }

  // I3: a chain's values ignore every other chain
  {
    const chainsWithBurns = [...new Set(bs.map((b) => b.chainId))];
    if (chainsWithBurns.length >= 2) {
      const c = pick(chainsWithBurns);
      const body = rebuild(p, (inp) => inp.chains.forEach((x) => x.chainId !== c && (x.burns = [])));
      if (body) {
        const m = new Map(body.burns.map((b) => [burnId(b), b]));
        for (const a of bs.filter((b) => b.chainId === c)) check(w, label, m.get(burnId(a))?.valueMicro === a.valueMicro, () => `I3: ${burnId(a)} depends on another chain`);
        const ca = f.chains.find((x) => x.chainId === c)!;
        const cb = body.chains.find((x) => x.chainId === c)!;
        check(w, label, JSON.stringify(ca.curveAfter) === JSON.stringify(cb.curveAfter), () => "I3: curve depends on another chain");
        stats.i3++;
      }
    }
  }

  // I4 (restated, F4): splitting a burn into k pieces at its own position (any wallets) never gives the pieces more
  // value, entitlement or Launchpad layer than the whole burn. The pieces lose δ ≤ k − 1 µUSD of spot to the
  // per-piece floors, and that is the only way other burns are touched: on the same chain, from the split's hour
  // on, the smaller volume (and so the lower curve state) lets each other burn gain at most δ µUSD of value, hence
  // at most ⌈3.75 × ⌈lamportsOf(δ) at its own x⌉⌉ of entitlement; every other burn is unchanged. With exact
  // prices δ = 0 and nothing else moves.
  {
    const candidates = bs.filter((b) => BigInt(b.amountWei) >= 2n * XEN);
    if (candidates.length) {
      const s = pick(candidates);
      const unit = w.exact ? XEN : 1n;
      const whole = BigInt(s.amountWei) / unit;
      const k = Number(whole < 4n ? whole : BigInt(2 + ri(3)));
      const cuts = new Set<bigint>();
      while (cuts.size < k - 1) cuts.add(1n + BigInt(Math.floor(rand() * Number(whole - 1n))));
      const points = [0n, ...[...cuts].sort((a, b) => (a < b ? -1 : 1)), whole];
      const pieceIds: string[] = [];
      const body = rebuild(p, (inp) => {
        for (const c of inp.chains) {
          const idx = c.burns.findIndex((b) => burnId(b) === burnId(s));
          if (idx < 0) continue;
          const orig = c.burns[idx];
          // D-18: a piece moved to a wallet of another rank (an operator wallet, or out of one) is not the same burn split,
          // so such a draw keeps the original wallet (the draw itself is kept: the random stream is unchanged)
          const rankOf = (x1: string) => (w.rules ? operatorOfV3(w.rules.operatorWallets, x1, orig.timestamp).operator : false);
          const pieces = points.slice(1).map((end, j) => {
            const drawn = j === 0 ? orig.x1 : pick(w.wallets);
            return { ...orig, logIndex: orig.logIndex + j, x1: rankOf(drawn) === rankOf(orig.x1) ? drawn : orig.x1, amountWei: ((end - points[j]) * unit).toString() };
          });
          pieces.forEach((x) => pieceIds.push(burnId(x)));
          c.burns.splice(idx, 1, ...pieces);
        }
      });
      if (body) {
        const pieces = body.burns.filter((b) => pieceIds.includes(burnId(b)));
        const tot = (xs: BurnV3[], fld: "spotMicro" | "valueMicro" | "ent" | "lp" | "basePaid" | "alloc") => sum(xs.map((b) => BigInt(b[fld])));
        // in a shortfall (A13.2) each piece's claim keeps in reserve the keeper tips of its own wallet's leaves: pieces in
        // wallets that already take a tip set less aside, so what the burners get grows by at most two tips per piece
        const tipTol = isCut(f) || isCut(body) ? 2n * KEEPER_TIP * BigInt(k) : 0n;
        if (tipTol) stats.i4Shortfall++;
        // A12: a dust piece (below VEST_MIN_ENT = 0.02 XNT) is paid as Launchpad, so a split can take up to that much of the
        // whole's locked piece as cash instead, 1:1 (never more in total; tier 0 pays the same): bounded per piece
        const dustTol = BigInt(pieces.filter((b) => b.converted).length) * VEST_MIN_ENT;
        // A12 (lockPiece): a split mission pays the rounding rest of its claim (a lamport or so) as Launchpad cash instead of
        // band, so split pieces can carry up to one lamport of basePaid each more than the whole (the allocation bound below
        // keeps the same k lamports): found when D-13 moved the switch worlds' L (round 4)
        const splitTol = s.split || pieces.some((b) => b.split) ? BigInt(k) : 0n;
        for (const fld of ["valueMicro", "ent", "lp", "basePaid"] as const) {
          const tol = fld === "basePaid" ? tipTol + dustTol + splitTol : 0n;
          const show = (b: BurnV3) => `[t${b.tier}/${b.leafTier}${b.converted ? "c" : ""}${b.split ? "s" : ""} ent ${b.ent} lp ${b.lp} sen ${b.senior} base ${b.basePaid} piece ${b.lockedLp} band ${b.bandPaid}]`;
          check(w, label, tot(pieces, fld) <= BigInt(s[fld]) + tol, () => `I4: pieces' ${fld} ${tot(pieces, fld)} > ${s[fld]}: whole ${show(s)} pieces ${pieces.map(show).join(" ")}`);
        }
        const delta = BigInt(s.spotMicro) - tot(pieces, "spotMicro");
        check(w, label, delta >= 0n && delta < BigInt(k) && (!w.exact || delta === 0n), () => `I4: the pieces lost ${delta} µUSD of spot`);
        const orig = new Map(bs.map((b) => [burnId(b), b]));
        let entBound = 0n;
        for (const b of body.burns) {
          if (pieceIds.includes(burnId(b))) continue;
          const o = orig.get(burnId(b))!;
          const dv = BigInt(b.valueMicro) - BigInt(o.valueMicro);
          const de = BigInt(b.ent) - BigInt(o.ent);
          if (b.chainId === s.chainId && b.hour >= s.hour) {
            const eb = ceilDiv(ceilDiv(delta * 10n ** 21n, BigInt(b.xntE18)) * 37_500n, 10_000n);
            entBound += eb;
            check(w, label, dv <= delta && de <= eb, () => `I4: burn ${burnId(b)} gained ${dv} µUSD / ${de} lamports > ${delta} / ${eb}`);
          } else check(w, label, dv === 0n && de === 0n, () => `I4: burn ${burnId(b)} on another chain or at an earlier hour changed`);
        }
        const dValue = tot(body.burns, "valueMicro") - tot(bs, "valueMicro");
        const dEnt = tot(body.burns, "ent") - tot(bs, "ent");
        if (dValue > stats.i4ValueGrowth) stats.i4ValueGrowth = dValue;
        if (dEnt > stats.i4EntGrowth) stats.i4EntGrowth = dEnt;
        if (!w.exact) stats.i4Inexact++;
        // A9: the lock is per burn. The pieces lose δ of spot, so they can claim less than the whole and a piece (or a
        // later mission, seeing a lamport more) can lock where the whole did not: the band then paid is vesting, not a
        // Launchpad layer (I4 bounds the Launchpad layer above), and such flips are counted, not compared
        const wholeLocked = s.leafTier > 0;
        const [lf, lb] = [lockedIds(f), lockedIds(body)];
        const flip = pieces.some((b) => (b.leafTier > 0) !== wholeLocked) || body.burns.some((b) => !pieceIds.includes(burnId(b)) && lb.has(burnId(b)) !== lf.has(burnId(b)));
        if (flip) stats.i4Flips++;
        else {
          const excess = tot(pieces, "alloc") - BigInt(s.alloc);
          if (excess > stats.i4MaxExcess) stats.i4MaxExcess = excess;
          check(w, label, excess <= BigInt(k) + tipTol, () => `I4: pieces' allocation exceeds the whole by ${excess}`);
          check(w, label, tot(body.burns, "alloc") <= tot(bs, "alloc") + BigInt(body.burns.length) + entBound + tipTol, () => "I4: the epoch's allocation grew");
        }
        stats.i4++;
      }
    }
  }

  // I7 (A9): a burn's arrival outcome never depends on a later burn's tier. A later mission reserves its band inside the
  // schedule like any FCFS claim, so the only thing it can take from an earlier burn is the leftover that burn's claim
  // beyond its day's tranche was waiting for (A4 never promised it), and by at most what the later burns reserve more.
  if (bs.length) {
    const i = ri(bs.length);
    const target = bs[i];
    const after = new Set(bs.slice(i + 1).map(burnId));
    const body = rebuild(p, (inp) => allInputBurns(inp).forEach((b) => after.has(burnId(b)) && (b.tier = ri(3))));
    if (body) {
      const m = new Map(body.burns.map((b) => [burnId(b), b]));
      const cut = isCut(f) || isCut(body);
      if (cut) stats.i7Shortfall++;
      let lost = 0n;
      let reserved = 0n;
      for (const a of bs) {
        const b = m.get(burnId(a))!;
        if (after.has(burnId(a))) {
          if (netOf(b) > netOf(a)) reserved += netOf(b) - netOf(a);
          continue;
        }
        // A13.2: exact in a shortfall week too (the latest claims are cut, never an earlier one)
        check(w, label, arrivalOf(b) === arrivalOf(a), () => `I7${cut ? " (shortfall)" : ""}: ${burnId(a)}'s arrival outcome depends on a later burn's tier`);
        if (BigInt(a.basePaid) > BigInt(b.basePaid)) lost += BigInt(a.basePaid) - BigInt(b.basePaid);
      }
      // the leftover (not promised, A4) lost to the later tiers is at most what the later burns reserve more at arrival; in a
      // shortfall week also the keeper tips the later burns' new leaves take and the cut claim sets aside
      const tol = cut ? KEEPER_TIP * (BigInt(after.size) + 2n) : 0n;
      check(w, label, lost <= reserved + tol, () => `I7: the earlier burns lost ${lost} of leftover while the later burns kept only ${reserved} more`);
      stats.i7++;
    }
    // own tier: a burn's Launchpad layer is the same whatever tier it picks (a converted mission is paid exactly what
    // Launchpad pays, a locked one holds its whole layer), and the burns before it are untouched; its larger reservation
    // can only take the leftover of earlier burns' beyond-tranche claims, by at most what it reserves more
    const own = (target.tier + 1 + ri(2)) % 3;
    const mine = rebuild(p, (inp) => allInputBurns(inp).forEach((b) => burnId(b) === burnId(target) && (b.tier = own)));
    if (mine) {
      const cutOwn = isCut(f) || isCut(mine);
      const m = new Map(mine.burns.map((b) => [burnId(b), b]));
      const t = m.get(burnId(target))!;
      // A12: its own tier changes only its own outcome: a mission takes at least what Launchpad takes at arrival and locks
      // the piece that covers at the full multiplier
      check(w, label, t.lp === target.lp && t.tier === own, () => `I7 (own tier): ${burnId(target)}'s Launchpad layer moved with its own tier (${target.lp} → ${t.lp})`);
      if (own === 0) check(w, label, t.alloc === t.basePaid && t.leafTier === 0, () => "I7: a Launchpad burn with a band");
      else check(w, label, BigInt(t.bandPaid) * BigInt(t.lp) <= BigInt(t.lockedLp) * BigInt(t.band) && (target.tier !== 0 || BigInt(t.senior) >= BigInt(target.senior)), () => `I7 (own tier): ${burnId(target)} as a mission is off its piece or took less than as Launchpad`);
      let lost = 0n;
      for (const a of bs.slice(0, i)) {
        const b = m.get(burnId(a))!;
        check(w, label, arrivalOf(b) === arrivalOf(a), () => `I7 (own tier${cutOwn ? ", shortfall" : ""}): ${burnId(a)} depends on a later burn's tier`);
        if (BigInt(a.basePaid) > BigInt(b.basePaid)) lost += BigInt(a.basePaid) - BigInt(b.basePaid);
      }
      const extra = netOf(t) > netOf(target) ? netOf(t) - netOf(target) : 0n;
      check(w, label, lost <= extra + (cutOwn ? 3n * KEEPER_TIP : 0n), () => `I7 (own tier): the earlier burns lost ${lost} of leftover while ${burnId(target)} kept only ${extra} more`);
      stats.i7Own++;
    }
  }

  // A9 (V3-3): a late burn by anyone, of any size and tier, never changes an earlier burn's arrival outcome; it can only
  // take, FCFS, the leftover the earlier burns' beyond-tranche claims were waiting for, by at most what it reserves; and
  // its own Launchpad layer is the same whatever tier it picks, so a mission choice is never a sabotage tool
  {
    const endHour = Math.floor(f.window.endTs / HOUR) * HOUR;
    const free = p.inputs.chains.filter((c) => c.burns.every((b) => b.timestamp < endHour));
    if (free.length && bs.length) {
      const c = pick(free);
      const tpl = pick(allInputBurns(p.inputs));
      const amount = big(logU(0.5, 2e7) * 1e18);
      // the same wallet for the three tiers (D-18: an operator wallet ranks last, so the wallet must not change with the
      // tier); three draws as before, so the random stream of the suite is unchanged
      const zx = [0, 1, 2].map(() => pick(w.wallets))[0];
      const z = (tier: number): BurnInputV3 => ({
        ...tpl, chainId: c.chainId, txHash: "0x" + "a9".repeat(32), logIndex: 0, blockNumber: blockAt(f.window.endTs), missionId: "a9", amountWei: amount.toString(), tier,
        x1: zx, timestamp: f.window.endTs,
      });
      const attacks = [0, 1, 2].map((tier) => rebuild(p, (inp) => inp.chains.find((x) => x.chainId === c.chainId)!.burns.push(z(tier))));
      if (attacks.every((b) => b !== null)) {
        // A13.2: in a shortfall week too, the late burn never moves an earlier arrival outcome; its leftover and sabotage
        // bounds then also allow the keeper tips its cut claim sets aside and its new leaves take
        const cutA = isCut(f) || attacks.some((b) => isCut(b!));
        const tipTol = cutA ? 3n * KEEPER_TIP : 0n;
        if (cutA) stats.a9Shortfall++;
        const zs = attacks.map((b) => b!.burns.find((x) => x.missionId === "a9")!);
        const asLaunchpad = new Map(attacks[0]!.burns.map((b) => [burnId(b), b]));
        for (const [tier, body] of attacks.entries()) {
          const m = new Map(body!.burns.map((b) => [burnId(b), b]));
          let lost = 0n;
          for (const a of bs) {
            const b = m.get(burnId(a))!;
            // D-12 / D-18: a backlog or operator burn claims after the late burn of the window
            if (late(a)) {
              check(w, label, b.valueMicro === a.valueMicro, () => `A9: the late burn (tier ${tier}) changed ${burnId(a)}'s value`);
              continue;
            }
            check(w, label, b.valueMicro === a.valueMicro && arrivalOf(b) === arrivalOf(a), () => `A9: the late burn (tier ${tier}) changed ${burnId(a)}'s arrival outcome`);
            if (BigInt(a.basePaid) > BigInt(b.basePaid)) lost += BigInt(a.basePaid) - BigInt(b.basePaid);
            // a converted late mission is, to everyone, exactly the Launchpad burn it would have been
            if (zs[tier].converted && !cutA) check(w, label, b.basePaid === asLaunchpad.get(burnId(a))!.basePaid, () => `A9: a converted late mission moved ${burnId(a)} (${asLaunchpad.get(burnId(a))!.basePaid} → ${b.basePaid})`);
          }
          check(w, label, lost <= netOf(zs[tier]) + tipTol, () => `A9: the late burn took ${lost} of leftover but took only ${netOf(zs[tier])} at its arrival`);
        }
        // A12: a mission takes at least what the same burn takes as Launchpad at its arrival, and locks it at its full multiplier
        check(w, label, zs.every((x) => BigInt(x.senior) >= BigInt(zs[0].senior) && BigInt(x.bandPaid) * BigInt(x.lp) <= BigInt(x.lockedLp) * BigInt(x.band)), () => `A12: the late burn's claim or piece is off (${zs.map((x) => `${x.senior}/${x.lockedLp}/${x.bandPaid}`)})`);
        // sabotage never pays: the attacker's gain over burning as Launchpad is at most the band it locks for itself (vesting,
        // under the eject penalty; exactly that band once the leftover completes its Launchpad piece), and what the others lose
        // to that choice is at most that band of leftover; it can take nothing from anyone without paying for it with its own
        // lock, and it can convert nobody
        for (const [tier, body] of attacks.entries()) {
          const x = zs[tier];
          const gain = BigInt(x.alloc) - BigInt(zs[0].alloc);
          check(w, label, gain >= -tipTol && gain <= BigInt(x.bandPaid) + tipTol && (cutA || x.basePaid !== x.lp || gain === BigInt(x.bandPaid)), () => `A12 (sabotage): the late mission's gain over Launchpad (${gain}) is outside [0, its own locked band ${x.bandPaid}]`);
          let lostToLock = 0n;
          for (const a of bs) {
            const [asIs, asLp] = [BigInt(body!.burns.find((b) => burnId(b) === burnId(a))!.basePaid), BigInt(asLaunchpad.get(burnId(a))!.basePaid)];
            if (asLp > asIs) lostToLock += asLp - asIs;
          }
          check(w, label, lostToLock <= BigInt(x.bandPaid) + tipTol, () => `A9 (sabotage): the others lost ${lostToLock} to the late mission's tier choice, more than the band it locked (${x.bandPaid})`);
          if (tier > 0 && x.leafTier > 0) stats.a9Sabotage++;
        }
        if (!cutA) check(w, label, zs.every((x) => x.converted || x.tier === 0 ? x.alloc === zs[0].alloc : BigInt(x.alloc) >= BigInt(zs[0].alloc)), () => "A9: a converted late mission is not paid exactly as Launchpad");
        if (zs.some((x) => x.leafTier > 0)) stats.a9AttackLocks++;
        stats.a9Attacks++;
      }
    }
  }

  // A9: burning less never pays more (own size). A burn alone in its hour on its chain, shrunk, never gets a larger Launchpad
  // layer, nor a larger allocation unless the smaller burn locks where the larger is converted; then the larger burn's cash is
  // at least the eject value of the smaller lock (I10) and at least the smaller burn's cash
  {
    const alone = bs.filter((b) => BigInt(b.amountWei) >= 2n * XEN && !bs.some((o) => o !== b && o.chainId === b.chainId && o.hour === b.hour));
    if (alone.length) {
      const s = pick(alone);
      const unit = w.exact ? XEN : 1n;
      const whole = BigInt(s.amountWei) / unit;
      const smaller = 1n + BigInt(Math.floor(rand() * Number(whole - 1n)));
      const body = rebuild(p, (inp) => allInputBurns(inp).forEach((b) => burnId(b) === burnId(s) && (b.amountWei = (smaller * unit).toString())));
      if (body) {
        // A13.2: in a shortfall week too: the cut claim's room depends on neither the burn's own size nor its tier
        if (isCut(f) || isCut(body)) stats.a9SizeShortfall++;
        const t = body.burns.find((b) => burnId(b) === burnId(s))!;
        check(w, label, BigInt(t.lp) <= BigInt(s.lp) && BigInt(t.ent) <= BigInt(s.ent), () => `A9 (size): a smaller burn is entitled to more (${t.ent} > ${s.ent})`);
        check(w, label, BigInt(t.basePaid) <= BigInt(s.basePaid), () => `A9 (size): burning less pays a larger Launchpad layer (${t.basePaid} > ${s.basePaid})`);
        if (t.leafTier > 0 && s.leafTier === 0) {
          check(w, label, BigInt(s.basePaid) * 10_000n >= BigInt(t.alloc) * (10_000n - TIER_PENALTY_BPS[t.leafTier]) && BigInt(s.basePaid) >= BigInt(t.basePaid), () => `A9 (size): converting the larger burn pays ${s.basePaid} cash, less than ejecting the smaller lock of ${t.alloc}`);
          stats.a9SizeFlips++;
        } else check(w, label, BigInt(t.alloc) <= BigInt(s.alloc), () => `A9 (size): burning less pays more (${t.alloc} > ${s.alloc})`);
        stats.a9Size++;
      }
    }
  }

  // I10 (eject): a wallet with a locked mission, ejecting at once, gets less than as Launchpad
  {
    const lockedPlayers = [...new Set(f.targets.filter((t) => t.tier > 0).map((t) => t.player))];
    if (lockedPlayers.length) {
      const who = pick(lockedPlayers);
      const body = rebuild(p, (inp) => allInputBurns(inp).forEach((b) => b.x1 === who && (b.tier = 0)));
      assert(body);
      const value = (fb: EpochBodyV3, ejectNow: boolean) => {
        const e = publishMirror(p.pool, BigInt(fb.totalScore), fb.leaves.length);
        let v = 0n;
        for (const l of fb.leaves) {
          const c = claimMirror(e, BigInt(l.score));
          if (l.player !== who) continue;
          v += ejectNow ? (c * (10_000n - TIER_PENALTY_BPS[l.tier])) / 10_000n : c;
        }
        return v;
      };
      const eject = value(f, true);
      const launchpad = value(body, false);
      check(w, label, eject < launchpad, () => `I10: eject ${eject} >= Launchpad ${launchpad} for ${who}`);
      stats.i10++;
      if (f.capacity.shortfall !== null || body.capacity.shortfall !== null) stats.i10Shortfall++;
    }
  }

  // NFT-1 (A13.1): the base pot never depends on any Artifact. Whatever the snapshot holds (nothing, every record moved to
  // another owner, a Void Anomaly given to a burner), the file is the same but the snapshot and the hash over it: every
  // value, allocation, leaf, root and capacity, a shortfall included
  {
    const bare = blind({ ...f, proofs: undefined } as unknown as EpochFileV3);
    const edits: ((inp: EpochInputsV3) => void)[] = [
      (inp) => (inp.snapshot.records = []),
      (inp) => inp.snapshot.records.forEach((r) => (r.owner = pick(w.wallets))),
      (inp) => inp.snapshot.records.push({ asset: keyOf(w.id, 203), tier: 3, owner: bs.length ? pick(bs).x1 : w.wallets[0], backing: (200n * XNT).toString(), origin: ORIGIN_FORGED }),
    ];
    for (const edit of edits) {
      const body = rebuild(p, edit);
      check(w, label, body !== null && blind(body) === bare, () => "NFT-1: an Artifact in the snapshot changed the base file");
    }
    stats.nft1Epochs++;
  }

  // NFT-2 (A13.1): a holder and a non-holder get the same base allocation for the same burn. The burn is given to one of two
  // fresh wallets (no other burn, so the same leaves): one holds a Void Anomaly, the other nothing
  if (bs.length) {
    const target = pick(bs);
    const [hw, nw] = [keyOf(w.id, 200), keyOf(w.id, 201)];
    const art: SnapshotRecord = { asset: keyOf(w.id, 202), tier: 3, owner: hw, backing: (100n * XNT).toString(), origin: ORIGIN_FORGED };
    const as = (who: string) =>
      rebuild(p, (inp) => {
        allInputBurns(inp).forEach((b) => burnId(b) === burnId(target) && (b.x1 = who));
        inp.snapshot.records.push(art);
      });
    const [bh, bn] = [as(hw), as(nw)];
    check(w, label, (bh === null) === (bn === null), () => "NFT-2: one of them publishes and the other does not");
    if (bh && bn) {
      const strip = (fb: EpochBodyV3) => JSON.stringify(fb.burns.map((b) => ({ ...b, x1: b.x1 === hw || b.x1 === nw ? "*" : b.x1 })));
      const own = (fb: EpochBodyV3, who: string) => fb.targets.filter((t) => t.player === who).map((t) => `${t.tier}:${t.target}`).join();
      check(w, label, strip(bh) === strip(bn) && JSON.stringify(bh.capacity) === JSON.stringify(bn.capacity), () => `NFT-2: burn ${burnId(target)} is paid differently to a holder`);
      check(w, label, own(bh, hw) === own(bn, nw) && (own(bh, hw) !== "") === BigInt(bh.burns.find((b) => b.x1 === hw)!.alloc) > 0n, () => `NFT-2: the holder's leaves ${own(bh, hw)} vs the non-holder's ${own(bn, nw)}`);
      stats.nft2++;
      if (target.tier > 0) stats.nft2Missions++;
      if (isCut(bh)) stats.nft2Shortfall++;
    }
  }
}

// ── counterfactual comparisons ───────────────────────────────────────────────────────────────────
/**
 * NFT-1 across whole histories (A13.1): `a` and `b` differ only in which Artifacts exist and who holds them, with the same
 * pool (every forge's base share counted in both). Every base file is the same but the snapshot and the hashes over it,
 * epoch after epoch, and every claim is the same: the base pot never depends on any Artifact.
 */
function compareBlind(w: World, a: (Paid | null)[], b: (Paid | null)[]) {
  for (let e = 0; e < w.builds; e++) {
    const [x, y] = [a[e], b[e]];
    const label = `NFT-1 build ${e + 1}`;
    check(w, label, (x === null) === (y === null), () => "one history published and the other did not");
    if (!x || !y) continue;
    check(w, label, blind(x.file) === blind(y.file), () => "an Artifact changed the base file");
    check(w, label, [...x.claims].map(([k, v]) => `${k}=${v}`).join() === [...y.claims].map(([k, v]) => `${k}=${v}`).join() && x.pool === y.pool, () => "an Artifact changed a claim or the pool");
    stats.nft1Epochs++;
  }
  stats.nft1Histories++;
}

/**
 * Forge inflow (I5 restated for the two-pot base): `more` received the base share of some forges that `less` did not, and
 * nothing else differs (NFT-1 makes the snapshots irrelevant). The share only ever raises the capacity, and so every
 * burner's payout, until the two histories cross a threshold differently: a mission that locks only with the larger C
 * (A9: per burn), or a shortfall that cuts the burners. That epoch pays more now, from the pool of later epochs, so a
 * later burner can receive less than without the forge; from then on the assertion is on the total the burners'
 * capacity paid, summed over the epochs so far (unless a later lock flips back the other way, which is counted).
 */
function compareInflow(w: World, more: (Paid | null)[], less: (Paid | null)[]) {
  let flipped = false;
  let reverse = false;
  let aggMore = 0n;
  let aggLess = 0n;
  let aggTol = 0n;
  for (let e = 0; e < w.builds; e++) {
    const a = more[e];
    const b = less[e];
    if (!a || !b) {
      if (a || b) {
        stats.inflowMisaligned++;
        return;
      }
      continue;
    }
    const label = `inflow build ${a.build}`;
    if (a.file.epoch !== b.file.epoch) return;
    const dC = BigInt(a.file.capacity.cash) - BigInt(b.file.capacity.cash);
    if (!flipped) check(w, label, dC >= 0n, () => `capacity ${a.file.capacity.cash} below the counterfactual ${b.file.capacity.cash}`);
    // A9 residual, bounded and disclosed: a mission that locks only with the larger C takes the band it took no part of
    // without the inflow, so a player after it can receive up to that much less in that epoch
    const flipTol = lockedFlips(a.file, b.file);
    // A13.2: in a shortfall week each history pays what its own limit carries, earliest claims first; the larger C quotes the
    // earlier burners more, so a later burner can receive less with the forge. From then on the totals are compared
    const cutNow = isCut(a.file) || isCut(b.file);
    if (cutNow && !flipped) {
      stats.inflowFlips++;
      flipped = true;
    }
    if (cutNow) aggTol += KEEPER_TIP * BigInt(a.file.leaves.length + b.file.leaves.length + 4);
    if (dC >= 0n && !flipped) {
      const [ta, tb] = [targetsBy(a.file), targetsBy(b.file)];
      for (const pl of new Set([...ta.keys(), ...tb.keys()])) {
        check(w, label, (ta.get(pl) ?? 0n) + flipTol >= (tb.get(pl) ?? 0n), () => `${pl} receives ${ta.get(pl) ?? 0n} < ${tb.get(pl) ?? 0n} without the forge's inflow (dC ${dC}, flip tolerance ${flipTol})`);
        stats.inflowWallets++;
      }
    }
    aggMore += paidFromC(a.file);
    aggLess += paidFromC(b.file);
    aggTol += BigInt(4 * (a.file.burns.length + b.file.burns.length));
    if (flipped && locksMore(b.file, a.file)) reverse = true;
    if (flipped && !reverse) check(w, label, aggMore + aggTol >= aggLess, () => `after a flip, the burners' capacity paid ${aggMore} in total < ${aggLess} without the forge`);
    if (locksMore(a.file, b.file) || ((isCut(a.file) || isCut(b.file)) && paidFromC(a.file) > paidFromC(b.file))) {
      if (!flipped) stats.inflowFlips++;
      flipped = true;
    }
    stats.inflow++;
  }
}

// ── boundary worlds (§11) ────────────────────────────────────────────────────────────────────────
function boundaryWorld(id: number, o: Partial<World> & { burns: BurnInputV3[]; arts?: ArtSpec[] }): World {
  rand = mulberry32(id);
  const builds = o.builds ?? 1;
  const chains: ChainSpec[] = o.chains ?? [{ chainId: 10, p0: 10n ** 13n, spot: Array(builds + 1).fill(10n ** 13n), L: Array(builds + 1).fill(10n ** 30n), skip: new Set() }];
  return {
    id, builds, exact: true, v2Start: false, v2Epochs: o.v2Epochs ?? 1, F0: o.F0 ?? 1_000n * XNT, inflow: Array(builds + 1).fill(0n),
    shrink: o.shrink ?? Array(builds + 1).fill(0n), drift: o.drift ?? Array(builds + 1).fill(false),
    xnt: Array(builds + 1).fill({ twap: 10n ** 18n, api: 10n ** 18n }), endTs: Array.from({ length: builds + 1 }, (_, e) => T0 + e * WEEK), skew: Array(builds + 1).fill(0),
    wallets: o.wallets ?? [keyOf(id, 0), keyOf(id, 1), keyOf(id, 2)], chains, arts: o.arts ?? [], burns: o.burns, v2burns: [], rules: o.rules ?? null,
  };
}
/** a boundary burn: XEN at $0.00001 and XNT at $1 on both closed readings */
const bBurn = (w: { id: number }, i: number, x1: string, ts: number, xen: bigint, tier = 0, logIndex = 0): BurnInputV3 => ({
  chainId: 10, txHash: "0x" + `b${w.id}e${i}`.padStart(64, "0"), logIndex, blockNumber: blockAt(ts), missionId: String(i), pilot: "0x" + "ef".repeat(20),
  amountWei: (xen * XEN).toString(), tier, x1, timestamp: ts, medianE18: (10n ** 13n).toString(), lastCloseE18: (10n ** 13n).toString(), priceSource: "candles",
  xntMedianE18: (10n ** 18n).toString(), xntLastCloseE18: (10n ** 18n).toString(), xntSource: "candles",
});

function boundaryTests() {
  const all = (w: World) => {
    const r = run(w, () => true);
    for (const p of r) if (p) checkEpoch(w, p);
    return r;
  };

  // capacity a few lamports from demand: Σ Launchpad layer = C + d. The mission arrives with day 0's tranche already taken
  // by the first burn (A9: nothing can cover its band at its arrival), so it is converted and its Launchpad layer, like the
  // first burn's rest, comes from the leftover
  for (const d of [-3n, -1n, 0n, 1n, 3n]) {
    const id = 900_001;
    const ws = [keyOf(id, 0), keyOf(id, 1), keyOf(id, 2)];
    const burns = [bBurn({ id }, 1, ws[0], T0 + 2 * HOUR, 40_000n), bBurn({ id }, 2, ws[1], T0 + 3 * HOUR, 25_000n, 2), bBurn({ id }, 3, ws[2], T0 + 6 * DAY + HOUR, 70_000n)];
    const probe = run(boundaryWorld(id, { burns, F0: 1_000_000n * XNT }), () => true)[0]!;
    const demand = sum(probe.file.burns.map((b) => BigInt(b.lp)));
    let F = ((demand + d) * 10_000n) / 800n;
    while ((F * 800n) / 10_000n < demand + d) F++;
    const w = boundaryWorld(id, { burns, F0: F });
    const p = all(w)[0]!;
    check(w, `demand ${d}`, BigInt(p.file.capacity.cash) === demand + d, () => `cash ${p.file.capacity.cash} vs ${demand + d}`);
    const paid = sum(p.file.burns.map((b) => BigInt(b.basePaid)));
    check(w, `demand ${d}`, paid === (d < 0n ? demand + d : demand), () => `Launchpad layer paid ${paid}`);
    check(w, `demand ${d}`, p.file.capacity.convertedMissions === 1 && p.file.capacity.lockedMissions === 0, () => "a band this far below 50% cannot lock");
  }

  // a single huge burn on day 0: it takes the week's whole capacity; a lone ML burn with ent <= C gets ent on tier 2
  {
    const id = 900_002;
    const w = boundaryWorld(id, { burns: [bBurn({ id }, 1, keyOf(id, 0), T0 + HOUR, 10n ** 12n)], F0: 100n * XNT });
    const b = all(w)[0]!.file.burns[0];
    check(w, "huge", b.basePaid === all(w)[0]!.file.capacity.cash && BigInt(b.senior) < BigInt(b.basePaid), () => "the lone burn did not get the week's leftover");
    const w2 = boundaryWorld(id + 1, { burns: [bBurn({ id: id + 1 }, 1, keyOf(id + 1, 0), T0 + HOUR, 1_000n, 2)], F0: 100n * XNT });
    const b2 = all(w2)[0]!.file.burns[0];
    check(w2, "lone ML", b2.alloc === b2.ent && b2.leafTier === 2, () => `lone ML burn got ${b2.alloc} of ${b2.ent}`);
    const w3 = boundaryWorld(id + 2, { burns: [bBurn({ id: id + 2 }, 1, keyOf(id + 2, 0), T0 + HOUR, 1_000_000n, 2)], F0: 100n * XNT });
    const b3 = all(w3)[0]!.file.burns[0];
    // A12: no 50% threshold any more: the lone mission locks the piece day 0's tranche covers, at the full multiplier, and
    // the week's leftover goes to its Launchpad piece on tier 0 (here the whole C is paid to it)
    const f3 = all(w3)[0]!.file;
    check(
      w3, "piece",
      !b3.converted && b3.leafTier === 2 && b3.split && BigInt(b3.bandPaid) * BigInt(b3.lp) <= BigInt(b3.lockedLp) * BigInt(b3.band) && b3.alloc === f3.capacity.cash,
      () => `a vesting burn short of its band must lock the piece it covers: ${b3.lockedLp} + ${b3.bandPaid} of ${b3.lp} + ${b3.band}`,
    );
  }

  // splitting into k wallets in one hour never raises Σ allocation
  for (const k of [2, 3, 5, 8]) {
    const id = 900_010 + k;
    const ws = Array.from({ length: k }, (_, i) => keyOf(id, i));
    const ts = T0 + 6 * DAY + 900; // day 6: the whole week is released at the mission's arrival (A9)
    const other = bBurn({ id }, 99, keyOf(id, 50), T0 + DAY, 300_000n);
    // C ≈ Σ Launchpad layer + 70% of the band: the whole mission locks on a partial band
    const whole = run(boundaryWorld(id, { burns: [other, bBurn({ id }, 1, ws[0], ts, 1_000_003n, 2)], F0: 423n * XNT, wallets: ws }), () => true)[0]!;
    const q = 1_000_003n / BigInt(k);
    const pieces = Array.from({ length: k }, (_, i) => bBurn({ id }, 10 + i, ws[i], ts + i * 60, i === 0 ? 1_000_003n - q * BigInt(k - 1) : q, 2, i));
    const split = run(boundaryWorld(id, { burns: [other, ...pieces], F0: 423n * XNT, wallets: ws }), () => true)[0]!;
    const wb = whole.file.burns.find((b) => b.tier === 2)!;
    check(boundaryWorld(id, { burns: [] }), `split ${k}`, wb.leafTier === 2 && wb.split && BigInt(wb.bandPaid) < BigInt(wb.band), () => "the band must be partially paid (a piece)");
    const tot = (p: Paid) => sum(p.file.burns.map((b) => BigInt(b.alloc)));
    // A12: the pieces' own entitlement roundings can give each piece's lock one lamport more than the whole's
    check(boundaryWorld(id, { burns: [] }), `split ${k}`, tot(split) <= tot(whole) + BigInt(k), () => `split pays ${tot(split)} > ${tot(whole)} + ${k}`);
  }

  // a Void holder and a non-holder burn the same amount in the same hour (equal value, A13.1): with room for both they are
  // paid the same; in a tight week the earlier one is paid first, whichever of them holds the Artifact
  {
    const id = 900_020;
    const [h, x] = [keyOf(id, 0), keyOf(id, 1)];
    const void0: ArtSpec = { asset: keyOf(id, 100), tier: 3, origin: ORIGIN_FORGED, backing: 100n * XNT, poolShare: 0n, forgedIn: 0, owners: [h, h], recycledIn: null };
    for (const F0 of [1_000n * XNT, 3n * XNT]) {
      for (const holderFirst of [true, false]) {
        const [first, second] = holderFirst ? [h, x] : [x, h];
        const burns = [bBurn({ id }, 1, first, T0 + HOUR + 60, 100_000n, 2, 0), bBurn({ id }, 2, second, T0 + HOUR + 120, 100_000n, 2, 1)];
        const w = boundaryWorld(id, { burns, arts: [void0], F0, wallets: [h, x] });
        const f = all(w)[0]!.file;
        const [b1, b2] = [f.burns.find((b) => b.x1 === first)!, f.burns.find((b) => b.x1 === second)!];
        check(w, `same burn F0 ${F0}`, b1.valueMicro === b2.valueMicro && b1.ent === b2.ent, () => "same-hour burns of the same size must have the same value");
        if (F0 > 100n * XNT) check(w, `same burn F0 ${F0}`, b1.alloc === b2.alloc && b1.leafTier === b2.leafTier, () => `holder and non-holder paid ${b1.alloc} vs ${b2.alloc}`);
        else check(w, `same burn F0 ${F0}`, BigInt(b1.senior) >= BigInt(b2.senior), () => "FCFS: the earlier burn first, whoever holds the Void");
        compareBlind(w, run(w, () => true, false), run(w, () => false, false, () => true));
      }
    }
  }

  // recycle mid-history, transfer between snapshots, self-transfer (invisible), v2 → v3: one world with all of them. The
  // base files are the same as in a world where no Artifact exists (A13.1), the forges' base shares counted in both
  {
    const id = 900_030;
    const [h, o, x] = [keyOf(id, 0), keyOf(id, 1), keyOf(id, 2)];
    const arts: ArtSpec[] = [
      { asset: keyOf(id, 100), tier: 2, origin: ORIGIN_FORGED, backing: 30n * XNT, poolShare: 12n * XNT, forgedIn: 0, owners: [h, h, o, o, o], recycledIn: null },
      { asset: keyOf(id, 101), tier: 1, origin: ORIGIN_FORGED, backing: 12_500_000_000n, poolShare: 5n * XNT, forgedIn: 0, owners: [o, o, o, o, o], recycledIn: 3 },
      { asset: keyOf(id, 102), tier: 0, origin: ORIGIN_GENESIS, backing: 0n, poolShare: 0n, forgedIn: 0, owners: [x, x, x, x, x], recycledIn: null },
    ];
    const burns = [1, 2, 3, 4].flatMap((e) => [bBurn({ id }, 10 * e, h, T0 + (e - 1) * WEEK + DAY, 50_000n), bBurn({ id }, 10 * e + 1, o, T0 + (e - 1) * WEEK + 2 * DAY, 80_000n, 2), bBurn({ id }, 10 * e + 2, x, T0 + (e - 1) * WEEK + 3 * DAY, 20_000n, 1)]);
    const w = boundaryWorld(id, { builds: 4, burns, arts, F0: 5_000n * XNT, wallets: [h, o, x] });
    w.v2Start = true;
    w.v2burns = [{ ...bBurn({ id }, 1, x, T0 - DAY, 10_000n), priceE18: (10n ** 13n).toString(), priceSource: "t" }];
    const r = all(w);
    check(w, "recycle", !r[2]!.file.snapshot.records.some((s) => s.asset === arts[1].asset) && r[1]!.file.snapshot.records.some((s) => s.asset === arts[1].asset), () => "the recycled Artifact must leave the snapshot");
    check(w, "transfer", r[1]!.file.snapshot.records.find((s) => s.asset === arts[0].asset)!.owner === o, () => "the snapshot records the new owner");
    check(w, "v2", r[0]!.file.prevDataHash !== null && r[0]!.file.v3FirstEpoch === 2, () => "v2 → v3 switch");
    compareBlind(w, r, run(w, () => false, true, () => true));
    compareInflow(w, run(w, () => true, false), run(w, () => false, false));
  }

  // shortfall (R2-8, F-SHORTFALL): the pool loses 21–60% during week 2 and another 0.5% before the publication, while a Void
  // holder burns too. Only the cash capacity is cut (A13.1), the holder exactly as a non-holder would be, and every claim is
  // its target (I9)
  {
    const id = 900_060;
    const [h, x] = [keyOf(id, 0), keyOf(id, 1)];
    const arts: ArtSpec[] = [{ asset: keyOf(id, 100), tier: 3, origin: ORIGIN_FORGED, backing: 400n * XNT, poolShare: 160n * XNT, forgedIn: 0, owners: [h, h, h], recycledIn: null }];
    const burns = [1, 2].flatMap((e) => [bBurn({ id }, 10 * e, h, T0 + (e - 1) * WEEK + DAY, 30_000_000n), bBurn({ id }, 10 * e + 1, x, T0 + (e - 1) * WEEK + 2 * DAY, 30_000_000n)]);
    for (const loss of [2_100n, 3_000n, 6_000n]) {
      const w = boundaryWorld(id, { builds: 2, burns, arts, F0: 10_000n * XNT, wallets: [h, x], shrink: [0n, 0n, loss * XNT], drift: [false, true, true] });
      const r = all(w);
      const s = r[1]!.file.capacity.shortfall;
      check(w, `shortfall ${loss} XNT`, s !== null && BigInt(s.claim) < BigInt(s.wanted), () => "expected a literal cut of the latest claims");
      compareBlind(w, r, run(w, () => false, true, () => true));
      const none = run(w, () => false, false);
      for (const p of none) if (p) checkEpoch(w, p);
      compareInflow(w, run(w, () => true, false), none);
    }
  }
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────
const started = Date.now();
if (!process.env.FAIRNESS_RANDOM_ONLY) boundaryTests();
for (let id = 0; id < WORLDS; id++) {
  const w = genWorld(id);
  stats.worlds++;
  stats.recycles += w.arts.filter((a) => a.recycledIn !== null && a.recycledIn <= w.builds).length;
  stats.transfers += w.arts.reduce((s, a) => s + a.owners.filter((o, i) => i > 0 && o !== a.owners[i - 1]).length, 0);
  stats.skippedChains += w.chains.reduce((s, c) => s + c.skip.size, 0);
  const all = run(w, () => true);
  if (all.some((p) => p?.prev?.version === 2)) stats.v2Starts++;
  for (const p of all) {
    if (!p) {
      stats.nulls++;
      continue;
    }
    checkEpoch(w, p);
    checkVariations(w, p);
  }
  if (!w.arts.length) continue;
  // NFT-1 across the whole history: no Artifact at all, the same pool (the forges' base shares still flow in)
  compareBlind(w, all, run(w, () => false, true, () => true));
  if (w.arts.some((a) => a.forgedIn > 0 || a.recycledIn !== null || a.owners.some((o) => o !== a.owners[0]))) stats.nft1Holders++;
  const forged = w.arts.filter((a) => a.origin === ORIGIN_FORGED);
  if (!forged.length) continue;
  // the forges' base shares only ever raise the capacity (I5 restated)
  const base = w.drift.some((d) => d) ? run(w, () => true, false) : all;
  const none = run(w, (a) => a.origin !== ORIGIN_FORGED, false);
  for (const p of none) if (p) checkEpoch(w, p);
  compareInflow(w, base, none);
}

assert(stats.published >= WORLDS, "most worlds must publish at least one epoch");
assert(stats.v2Starts > 0 && stats.recycles > 0 && stats.transfers > 0 && stats.skippedChains > 0, "coverage: v2 switches, recycles, transfers and skipped chains");
assert(stats.locked > 0 && stats.converted > 0, "coverage: locked and converted missions");
assert(stats.i2 > 0 && stats.i3 > 0 && stats.i4 > 0 && stats.i7 > 0 && stats.i7Own > 0 && stats.i10 > 0, "every property was exercised");
assert(stats.nft1Epochs > 0 && stats.nft1Histories > 0 && stats.nft1Holders > 0 && stats.nft2 > 0 && stats.nft2Missions > 0 && stats.nft2Shortfall > 0, "coverage: NFT-1 (per epoch and per history) and NFT-2 (missions and shortfalls included)");
assert(stats.inflow > 0 && stats.inflowWallets > 0, "coverage: forge inflows compared");
// A12: no lock threshold any more, so an own-size shrink can flip a lock only across the dust edge (VEST_MIN_ENT)
assert(stats.a9Attacks > 0 && stats.a9AttackLocks > 0 && stats.a9Sabotage > 0 && stats.a9Size > 0, "coverage: A9 late-burn attacks (some locking, some paying for their lock), own-size shrinks");
assert(stats.locksSplit > 0, "coverage: missions locked in part (A12 pieces)");
assert(stats.backlogBurns > 0 && stats.operatorBurns > 0 && stats.exceptionBurns > 0 && stats.d12 > 0 && stats.d18 > 0 && stats.rankedAfter > 0, "coverage: D-12 backlog, D-18 operator and PROOF_BURN_RULE (c) exception burns, and their ranking checked");
assert(stats.i4Inexact > 0, "coverage: I4 with floored (inexact) prices");
assert(stats.scaledDown > 0 && stats.arrivalCuts > 0 && stats.scaledDown > stats.arrivalCuts && stats.planChecks > 0 && stats.driftPublishes > 0, "coverage: shortfalls cut at both stages, checked against the plan, and publications at the lowest tolerated pool (R2-8)");
assert(stats.i2Shortfall > 0 && stats.i7Shortfall > 0 && stats.i9Shortfall > 0, "coverage: I2, I7 and I9 in the shortfall regime");
assert(stats.prefix > 0 && stats.prefixShortfall > 0 && stats.a9SizeShortfall > 0 && stats.a9Shortfall > 0, "coverage (A13.2): prefix-stability, own size and late burns in shortfall weeks");

const pct = (x: number) => `${(100 * x).toFixed(3)}%`;
console.log(
  `fairness: ${stats.worlds} worlds (seed ${SEED}), ${stats.published} epochs, ${stats.burns} burns, ${stats.leaves} leaves, ${((Date.now() - started) / 1000).toFixed(1)} s\n` +
    `  coverage: ${stats.v2Starts} v2 switches, ${stats.recycles} recycles, ${stats.transfers} transfers, ${stats.skippedChains} skipped chain-weeks, ${stats.nulls} empty builds, ` +
    `${stats.locked} locked (${stats.locksSplit} in part, A12) / ${stats.converted} converted missions, ` +
    `${stats.scaledDown} shortfalls (${stats.arrivalCuts} cut at the arrival claims, the rest at the top-ups; ${stats.planChecks} checked against the plan), ${stats.driftPublishes} published 0.5% below the build pool\n` +
    `  checked: prefix-stability ${stats.prefix} (${stats.prefixShortfall} in a shortfall week), I2 ${stats.i2} (${stats.i2Shortfall} in a shortfall week), I3 ${stats.i3}, I4 ${stats.i4} (${stats.i4Inexact} with floored prices, epoch growth max ${stats.i4ValueGrowth} µUSD / ${stats.i4EntGrowth} lamports, ` +
    `lock flips ${stats.i4Flips}, pieces' max excess ${stats.i4MaxExcess} lamports, ${stats.i4Shortfall} in a shortfall week), ` +
    `I7 ${stats.i7} (${stats.i7Shortfall} in a shortfall week, own tier ${stats.i7Own}), I9 = I12 exact (claim = target) in every epoch, ${stats.i9Shortfall} of them shortfalls, I10 eject ${stats.i10} (${stats.i10Shortfall} in a shortfall), I11 ${stats.i11}, ` +
    `A9 late-burn attacks ${stats.a9Attacks} (${stats.a9AttackLocks} locking, ${stats.a9Sabotage} mission choices paid for with their own lock, ${stats.a9Shortfall} in a shortfall week), own-size shrinks ${stats.a9Size} (${stats.a9SizeFlips} across the dust edge, ${stats.a9SizeShortfall} in a shortfall week), ` +
    `I2 kept-mission flips ${stats.i2KeptFlips} and removals where the kept later burns reserve more ${stats.i2ReservedMore}\n` +
    `  D-12 / D-18: ${stats.backlogBurns} backlog burns, ${stats.operatorBurns} operator burns, ${stats.exceptionBurns} burns under a dated exception; ranking checked in ${stats.d12} backlog and ${stats.d18} operator epochs (${stats.rankedAfter} window burns)\n` +
    `  A13.1: NFT-1 (the base never depends on any Artifact) ${stats.nft1Epochs} epochs, ${stats.nft1Histories} whole histories (${stats.nft1Holders} with forges, recycles or transfers); ` +
    `NFT-2 (holder = non-holder for the same burn) ${stats.nft2} (${stats.nft2Missions} missions, ${stats.nft2Shortfall} in a shortfall week); ` +
    `forge inflows ${stats.inflow} epochs / ${stats.inflowWallets} wallets (threshold flips ${stats.inflowFlips}, misaligned ${stats.inflowMisaligned})\n` +
    `  I1: planned outflow max ${pct(stats.plannedMax)} of F (Σ score + keeper tips; no drop reserve, no drop luck)`,
);
console.log("fairness tests: all passed");
