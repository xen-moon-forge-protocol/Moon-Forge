/**
 * Rewards v3 unit tests (no network): curve math and memory, the decay constant, price cap, L clamp,
 * FCFS daily tranches, leftover pass, vesting conversion, the two-pot base (no Artifact term, no drop reserve:
 * A13.1), encoding (claims = targets), determinism, verify round-trip and tamper detection.
 *   npm test
 */
import assert from "assert";
import { PublicKey } from "@solana/web3.js";
import { baseScore, buildTree, ChainSnapshot, computeLeaves, dataHash as dataHashV2, EpochBody, EpochFile, epochRateCap, rateCapFor, toE18 } from "../src/epoch";
import { Burn } from "../src/evm";
import {
  allocateBurns, allocItem, AnyEpochFile, buildLimit, BurnInputV3, EPOCH_ACCOUNT_SIZE, EPOCH_RENT, ORACLE_ALLOWANCE_BOUND_BPS, ORACLE_ALLOWANCE_MAX, oracleAllowanceMax, ORACLE_TOPUP_MAX, ORACLE_TOPUP_TARGET, buildEpochFileV3, clampL, CLOCK_SKEW_MAX, computeEpochV3, computeEpochV3SkippingUnpriced, curve, curvePot,
  dataHashV3, dayOf, decay, decayFactor, DECAY_Q, encodeLeaves, EpochFileV3, EpochInputsV3, globalOrder, tieKeyV3,
  fitClaim, isoSeconds, lamportsOf, limitGate, medianE18, MIN_WINDOW, NoXenPriceError, ORIGIN_DROP, ORIGIN_FORGED, ORIGIN_GENESIS, pinnedSwitchError, plannedOutflow,
  priceReadings, programClaims, protoPath, PublishedEpochV3, rebuildReason, retiredBaseTerms, runCurve, SnapshotRecord, snapshotWindowEnd, spotMicro, SwitchRefV3,
  switchRefsFromV2, TargetV3, verifyAny, verifyChainLinkV3, verifyChainSetV3, verifyEpochV3, verifyPublishedV3,
  verifySnapshotTimeV3, verifySnapshotV3, xenPrice, xntPrice, xntReference,
} from "../src/rewards";

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

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────
const PROGRAM = "57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9";
const XNT = 1_000_000_000n;
const DAY = 86_400;
const HOUR = 3_600;
const WEEK = 7 * DAY;
const T0 = 1_790_208_000; // a UTC midnight
const MAX_PUBLISH_LAG_T = 6 * HOUR; // rewards.MAX_PUBLISH_LAG
const XEN = 10n ** 18n;
/** XEN at $0.000001: the spot value in µUSD is the number of whole XEN burned */
const P6 = 10n ** 12n;
/** XNT at $1: 1 µUSD = 1,000 lamports */
const X1 = 10n ** 18n;
/** a market so deep that value ≈ spot */
const BIG_L = 10n ** 30n;

const key = (tag: number, i: number) => {
  const b = new Uint8Array(32);
  b[0] = tag;
  b[1] = i & 255;
  b[2] = (i >> 8) & 255;
  b[31] = 7;
  return new PublicKey(b).toBase58();
};
const W = (i: number) => key(1, i);
const ASSET = (i: number) => key(2, i);
const blockAt = (ts: number) => ts - T0 + 1_000;
const iso = (ts: number) => new Date(ts * 1000).toISOString();
const publishedAt = (f: AnyEpochFile) => Math.floor(Date.parse(f.createdAt) / 1000) + 60;

let seq = 0;
interface BurnOpt {
  chainId?: number;
  tier?: number;
  /** XEN readings (median, last close) or source "fallback" */
  median?: bigint;
  last?: bigint;
  source?: "candles" | "fallback";
  /** XNT readings at the burn (A1) */
  xnt?: bigint;
  xntLast?: bigint;
  xntSource?: "candles" | "fallback";
  block?: number;
  logIndex?: number;
  wei?: bigint;
}
function burn(x1: string, ts: number, xen: bigint, o: BurnOpt = {}): BurnInputV3 {
  seq++;
  const fb = o.source === "fallback";
  const xfb = o.xntSource === "fallback";
  return {
    chainId: o.chainId ?? 10, txHash: "0x" + seq.toString(16).padStart(64, "0"), logIndex: o.logIndex ?? seq, blockNumber: o.block ?? blockAt(ts),
    missionId: String(seq), pilot: "0x" + "ab".repeat(20), amountWei: (o.wei ?? xen * XEN).toString(), tier: o.tier ?? 0, x1, timestamp: ts,
    medianE18: fb ? "0" : (o.median ?? P6).toString(), lastCloseE18: fb ? "0" : (o.last ?? o.median ?? P6).toString(), priceSource: o.source ?? "candles",
    xntMedianE18: xfb ? "0" : (o.xnt ?? X1).toString(), xntLastCloseE18: xfb ? "0" : (o.xntLast ?? o.xnt ?? X1).toString(), xntSource: o.xntSource ?? "candles",
  };
}

interface ChainOpt {
  L?: bigint;
  spot?: bigint;
  ref?: bigint;
}
interface Build {
  epoch: number;
  endTs: number;
  startTs?: number;
  F: bigint;
  /** F_ref, the pool right after the previous publication (defaults to F when there is a previous file) */
  open?: bigint;
  burns: BurnInputV3[];
  records?: SnapshotRecord[];
  /** build-time XNT price (api; twap defaults to it): only the fallback burns and the no-burn reference use it */
  x?: bigint;
  twap?: bigint;
  chains?: Record<number, ChainOpt>;
  skip?: number[];
  switchRefs?: SwitchRefV3[] | null;
}

function mk(b: Build, prev: AnyEpochFile | null): EpochInputsV3 {
  const ids = new Set<number>([...b.burns.map((x) => x.chainId), ...Object.keys(b.chains ?? {}).map(Number)]);
  if (prev) for (const c of prev.chains) ids.add(c.chainId);
  for (const s of b.skip ?? []) ids.delete(s);
  const chains = [...ids].map((id) => {
    const o = b.chains?.[id] ?? {};
    const pc = prev?.chains.find((c) => c.chainId === id);
    const from = pc ? pc.toBlock : 0;
    return {
      chainId: id, name: `chain-${id}`, portal: "0xportal", fromBlockExclusive: from, toBlock: blockAt(b.endTs),
      market: { spotE18: (o.spot ?? P6).toString(), refUsdE18: (o.ref ?? P6).toString(), priceSource: "test", pools: [] },
      liquidityNowMicro: (o.L ?? BIG_L).toString(), totalSupply: "0",
      burns: b.burns.filter((x) => x.chainId === id && x.blockNumber > from && x.blockNumber <= blockAt(b.endTs)),
    };
  });
  const x = b.x ?? X1;
  return {
    programId: PROGRAM, epoch: b.epoch, createdAt: iso(b.endTs),
    window: { startTs: b.startTs ?? (prev ? publishedAt(prev) : b.endTs - WEEK), endTs: b.endTs },
    chains, snapshot: { slot: 100 + b.epoch, records: b.records ?? [] },
    freePool: { lamports: b.F.toString(), slot: 99 + b.epoch, open: prev ? (b.open ?? b.F).toString() : null },
    xnt: { twapE18: (b.twap ?? x).toString(), apiE18: x.toString(), source: "test" },
    switchRefs: b.switchRefs !== undefined ? b.switchRefs : prev?.version === 2 ? prev.chains.map((c) => ({ chainId: c.chainId, readings: [c.xenUsdE18] })) : null,
  };
}

function build(b: Build, prev: AnyEpochFile | null): EpochFileV3 {
  const f = buildEpochFileV3(mk(b, prev), prev);
  assert(f, `epoch ${b.epoch} unexpectedly empty`);
  return JSON.parse(JSON.stringify(f));
}

const record = (asset: string, tier: number, owner: string, backing: bigint, origin = ORIGIN_FORGED): SnapshotRecord => ({ asset, tier, owner, backing: backing.toString(), origin });
const targetOf = (f: EpochFileV3, player: string, tier: number) => BigInt(f.targets.find((t) => t.player === player && t.tier === tier)?.target ?? "0");
const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const min = (a: bigint, b: bigint) => (a < b ? a : b);

/** Independent mirror of the upgraded forge.rs publish_epoch + claim (u64/u128 integer floors): drop_reserve = 0 (A13.1). */
function publishMirror(free: bigint, totalScore: bigint, leaves: number, rateCap = 1n) {
  if (totalScore <= 0n || leaves <= 0 || rateCap <= 0n) throw new Error("EmptyEpoch");
  let budget = (free * 1_000n) / 10_000n;
  const capped = totalScore * rateCap;
  if (capped < budget) budget = capped;
  if (budget <= 0n) throw new Error("PoolEmpty");
  const dropReserve = 0n;
  return { totalScore, budget: budget - dropReserve, dropReserve, claimed: 0n };
}
function claimMirror(e: ReturnType<typeof publishMirror>, score: bigint) {
  if (score >= 2n ** 64n || score > e.totalScore) throw new Error("InvalidProof");
  const amount = (score * e.budget) / e.totalScore;
  if (amount <= 0n) throw new Error("AmountTooSmall");
  if (e.claimed + amount > e.budget) throw new Error("BudgetExhausted");
  e.claimed += amount;
  return amount;
}

// ── 1. units ───────────────────────────────────────────────────────────────────────────────────
test("lamportsOf: µUSD → lamports with 1e21 (S1 / ENC-1)", () => {
  assert.strictEqual(lamportsOf(1_000_000n, 153_000_000_000_000_000n), 6_535_947_712n); // $1 at XNT $0.153 = 6.536 XNT
  assert.strictEqual(lamportsOf(1_000_000n, BigInt(toE18(0.1855))), 5_390_835_579n);
  assert.strictEqual(lamportsOf(63_000n, 153_000_000_000_000_000n), 411_764_705n); // the opXEN burn ≈ 0.4118 XNT
  for (const x of [1n, 7n, 10n ** 15n, 153_000_000_000_000_000n, BigInt(toE18(0.1855)), 3n * 10n ** 18n, 10n ** 21n]) {
    const viaBase = (lamportsOf(1n, x) * 12_500n) / 10_000n;
    const v2 = rateCapFor(12_500, x.toString());
    assert(viaBase <= v2 && v2 - viaBase <= 1n, `v2 rateCapFor agreement at x=${x}`);
  }
  assert.strictEqual(spotMicro(63_000n * XEN, P6), 63_000n);
  assert.strictEqual(spotMicro(1n, P6), 0n);
});

// ── 2. decay constant ──────────────────────────────────────────────────────────────────────────
/** floor(2^(−1/336) × 10^40), 40-digit reference */
const R40 = 9_979_391_883_568_344_081_002_966_948_635_637_101_097n;
const isFloorRoot = (y: bigint, digits: number, h = 1n) => {
  const one = 10n ** BigInt(digits * 336);
  return y ** 336n * 2n ** h <= one && (y + 1n) ** 336n * 2n ** h > one;
};
/** floor(10^18 × 2^(−h/336)) by bisection on Y^336 × 2^h ≤ 10^(18·336) */
function exactFactor(h: number): bigint {
  const one = 10n ** (18n * 336n);
  const p = 2n ** BigInt(h);
  let lo = 0n;
  let hi = 10n ** 18n + 1n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (mid ** 336n * p <= one) lo = mid;
    else hi = mid;
  }
  return lo;
}

test("decay constant is the exact floor of 2^(−1/336) (40-digit reference)", () => {
  assert(isFloorRoot(R40, 40), "40-digit reference");
  assert(isFloorRoot(DECAY_Q, 18), "DECAY_Q");
  assert.strictEqual(R40 / 10n ** 22n, DECAY_Q);
  assert(Math.abs(Number(DECAY_Q) / 1e18 - Math.pow(2, -1 / 336)) < 1e-15);
});

test("decayFactor: never above the exact value, below it only by the constant's truncation and the floors", () => {
  assert.strictEqual(decayFactor(0), 10n ** 18n);
  assert.strictEqual(decayFactor(1), DECAY_Q);
  let last = 10n ** 18n + 1n;
  for (const h of [0, 1, 2, 3, 7, 24, 168, 335, 336, 337, 485, 672, 1_000, 2_016, 5_000]) {
    const got = decayFactor(h);
    const exact = exactFactor(h);
    // q is 1 ulp short at most: q^h loses about h × 2^(−h/336) ulps, plus 2 floors per bit of h
    const bound = ceilDiv(BigInt(h) * exact, 10n ** 18n) + 2n * BigInt(h.toString(2).length) + 2n;
    assert(got <= exact && exact - got <= bound, `h=${h}: ${got} vs exact ${exact} (bound ${bound})`);
    assert(got < last, "strictly decreasing");
    last = got;
  }
  const half = decayFactor(336);
  assert(half <= 5n * 10n ** 17n && 5n * 10n ** 17n - half < 200n, `half-life: ${half}`);
  assert.strictEqual(decay(123_456_789n, 0), 123_456_789n);
  assert.strictEqual(decay(0n, 9_999), 0n);
  assert.strictEqual(decay(10n ** 8n, 1), 99_793_918n);
  assert.throws(() => decayFactor(-1));
});

// ── 3. curve ───────────────────────────────────────────────────────────────────────────────────
test("curve f(x) = L·x/(L+x), zero-safe (S5)", () => {
  assert.strictEqual(curve(0n, 0n), 0n);
  assert.strictEqual(curve(0n, 5n), 0n);
  assert.strictEqual(curve(5n, 0n), 0n);
  assert.strictEqual(curve(1_000n, 1_000n), 500n);
});

test("curve: same-hour pot shared pro rata, order-free; a later hour never changes an earlier value (S10)", () => {
  const L = 1_000_000_000n; // $1,000
  const start = { S: 0n, hour: 0 };
  const alone = runCurve([{ hour: 10, spot: 100_000_000n }], L, start);
  assert.strictEqual(alone.values[0], 90_909_090n); // $90.91
  const shared = runCurve([{ hour: 10, spot: 100_000_000n }, { hour: 10, spot: 1_000_000_000n }], L, start);
  assert.deepStrictEqual(shared.values, [47_619_047n, 476_190_476n]); // Alice $47.62 once Bob burns in the same hour
  assert(shared.values[0] + shared.values[1] <= curvePot(L, 0n, 1_100_000_000n), "the shares never exceed the exact pot");
  const swapped = runCurve([{ hour: 10, spot: 1_000_000_000n }, { hour: 10, spot: 100_000_000n }], L, start);
  assert.deepStrictEqual(swapped.values, [476_190_476n, 47_619_047n]);
  const later = runCurve([{ hour: 10, spot: 100_000_000n }, { hour: 11, spot: 1_000_000_000n }], L, start);
  assert.strictEqual(later.values[0], 90_909_090n);
  const s = decay(100_000_000n, 1);
  assert.strictEqual(later.values[1], curvePot(L, s, 1_000_000_000n));
  const exact = (L * L * 1_000_000_000n) / ((L + s) * (L + s + 1_000_000_000n));
  assert.strictEqual(later.values[1], exact, "f(S + V) − f(S) = L²V / ((L + S)(L + S + V)), floored once");
  assert.strictEqual(later.after.S, s + 1_000_000_000n);
  assert.strictEqual(later.after.hour, 11);
});

test("curve memory: a whale lowers later burns and the chain recovers over weeks", () => {
  const L = 1_000_000_000n;
  const fresh = runCurve([{ hour: 0, spot: 100_000_000n }], L, { S: 0n, hour: 0 }).values[0];
  let prevValue = 0n;
  for (const gap of [1, 168, 336, 672, 1_344, 2_688]) {
    const v = runCurve([{ hour: 0, spot: 1_000_000_000n }, { hour: gap, spot: 100_000_000n }], L, { S: 0n, hour: 0 }).values[1];
    assert(v > prevValue && v < fresh, `gap ${gap}: ${v}`);
    prevValue = v;
  }
  const atHalfLife = runCurve([{ hour: 0, spot: 1_000_000_000n }, { hour: 336, spot: 100_000_000n }], L, { S: 0n, hour: 0 }).values[1];
  const S = decay(1_000_000_000n, 336);
  assert.strictEqual(atHalfLife, curvePot(L, S, 100_000_000n));
  const diff = curve(L, S + 100_000_000n) - curve(L, S);
  assert(diff - atHalfLife >= 0n && diff - atHalfLife <= 1n, "⌊a − b⌋ ≤ ⌊a⌋ − ⌊b⌋ ≤ ⌊a − b⌋ + 1");
  // memory carried across epochs = one continuous run
  const one = runCurve([{ hour: 5, spot: 7n * 10n ** 8n }, { hour: 200, spot: 3n * 10n ** 8n }], L, { S: 0n, hour: 0 });
  const first = runCurve([{ hour: 5, spot: 7n * 10n ** 8n }], L, { S: 0n, hour: 0 });
  const second = runCurve([{ hour: 200, spot: 3n * 10n ** 8n }], L, first.after);
  assert.deepStrictEqual([first.values[0], second.values[0]], one.values);
  assert.deepStrictEqual(second.after, one.after);
});

test("curve: V = 0 and L = 0 never divide by zero; S still accumulates without a market (S5)", () => {
  const zero = runCurve([{ hour: 3, spot: 0n }], 1_000n, { S: 0n, hour: 0 });
  assert.deepStrictEqual(zero.values, [0n]);
  const noMarket = runCurve([{ hour: 3, spot: 500n }, { hour: 4, spot: 500n }], 0n, { S: 0n, hour: 0 });
  assert.deepStrictEqual(noMarket.values, [0n, 0n]);
  assert(noMarket.after.S > 500n, "a dump with no market still weighs on the curve");
});

// ── 4. prices ──────────────────────────────────────────────────────────────────────────────────
test("medianE18: positive values only, even count = floor of the middle mean", () => {
  assert.strictEqual(medianE18([]), 0n);
  assert.strictEqual(medianE18([3n, 1n, 2n]), 2n);
  assert.strictEqual(medianE18([1n, 4n]), 2n);
  assert.strictEqual(medianE18([0n, 5n, 0n]), 5n);
  assert.strictEqual(medianE18([10n, 1n, 1_000n, 7n]), 8n);
});

test("burn price = min(median, last close, 1.25 × ref) (A5), no lower clamp; fallback = min(build spot, cap); the history is carried", () => {
  const H = W(1);
  const f1 = build({
    epoch: 1, endTs: T0 + WEEK, F: 10_000n * XNT, chains: { 10: { spot: 3n * P6, ref: P6 }, 56: { spot: P6 / 2n, ref: P6 } },
    burns: [
      burn(H, T0 + 10 * HOUR, 1_000_000n, { median: 2n * P6 }), burn(H, T0 + 20 * HOUR, 1_000_000n, { median: P6 / 2n }),
      burn(H, T0 + 30 * HOUR, 1_000_000n, { median: P6, last: (P6 * 8n) / 10n }), burn(H, T0 + 40 * HOUR, 1_000_000n, { source: "fallback" }),
      burn(H, T0 + 50 * HOUR, 1_000_000n, { chainId: 56, source: "fallback" }),
    ],
  }, null);
  const [hi, lo, lastLow, fb, fbSpot] = f1.burns;
  assert.deepStrictEqual([hi.priceE18, hi.priceRule], [((P6 * 12_500n) / 10_000n).toString(), "cap"]);
  assert.deepStrictEqual([lo.priceE18, lo.priceRule], [(P6 / 2n).toString(), "median"]);
  assert.deepStrictEqual([lastLow.priceE18, lastLow.priceRule], [((P6 * 8n) / 10n).toString(), "last"], "a last close 20% below the median sets the price");
  assert.deepStrictEqual([fb.priceE18, fb.priceRule], [((P6 * 12_500n) / 10_000n).toString(), "cap"], "fallback: the build spot (3 × ref), capped");
  assert.deepStrictEqual([fbSpot.priceE18, fbSpot.priceRule], [(P6 / 2n).toString(), "spot"]);
  assert.deepStrictEqual(xenPrice([P6, P6], P6, 5n * P6), { priceE18: P6, rule: "median" });
  const c1 = f1.chains[0];
  assert.strictEqual(c1.ref, P6.toString());
  assert.strictEqual(c1.xenUsdE18, ((P6 * 12_500n) / 10_000n).toString(), "recorded reference = min(build spot, cap)");
  const f2 = build({ epoch: 2, endTs: T0 + 2 * WEEK, F: 10_000n * XNT, burns: [burn(H, T0 + WEEK + DAY, 1_000_000n)] }, f1);
  assert.deepStrictEqual(f2.chains[0].refInputs, [c1.xenUsdE18]);
  assert.strictEqual(f2.chains[0].ref, c1.xenUsdE18);
});

test("L growth clamp with an additive step; recovery from a zero reading is bounded (S7)", () => {
  assert.strictEqual(clampL(5n, null), 5n);
  assert.strictEqual(clampL(5_950_000_000n, 1_340_766_800n), 1_524_843_480n);
  assert.strictEqual(clampL(100n, 1_000_000_000n), 100n);
  let L = 0n;
  let epochs = 0;
  while (L < 1_344_000_000n) {
    L = clampL(1_344_000_000n, L);
    epochs++;
    assert(epochs <= 16, "recovery must be bounded");
  }
  const H = W(1);
  const f1 = build({ epoch: 1, endTs: T0 + WEEK, F: 1_000n * XNT, chains: { 10: { L: 1_000_000_000n } }, burns: [burn(H, T0 + HOUR, 1_000n)] }, null);
  // D-13 (a): a genesis build (no previous file) takes the statistic of its window (here the build's one reading) and
  // freezes the next window's L from it; the next build's reading of $1M moves only the L frozen for the window after
  assert.deepStrictEqual(f1.chains[0].L, { now: "1000000000", onChain: null, prev: null, used: "1000000000", rule: "genesis", stat: "1000000000", next: "1000000000", cap: null });
  const f2 = build({ epoch: 2, endTs: T0 + 2 * WEEK, F: 1_000n * XNT, chains: { 10: { L: 10n ** 12n } }, burns: [burn(H, T0 + WEEK + HOUR, 1_000n)] }, f1);
  assert.deepStrictEqual(f2.chains[0].L, { now: "1000000000000", onChain: null, prev: "1000000000", used: "1000000000", rule: "frozen", stat: "1000000000000", next: "1150000000", cap: null });
});

test("XNT per burn (A1, A3.2, A5): max(median, last close, 0.6 × previous x), no upper cap; fallback = max(twap, api)", () => {
  assert.deepStrictEqual(xntPrice([X1, 2n * X1], 5n * X1, 0n), { xE18: 2n * X1, rule: "last" });
  assert.deepStrictEqual(xntPrice([2n * X1, X1], 5n * X1, 0n), { xE18: 2n * X1, rule: "median" });
  assert.deepStrictEqual(xntPrice([X1, X1], 5n * X1, 3n * X1), { xE18: 3n * X1, rule: "floor" });
  assert.deepStrictEqual(xntPrice(null, 5n * X1, X1), { xE18: 5n * X1, rule: "build" });
  assert.deepStrictEqual(xntPrice(null, X1, 3n * X1), { xE18: 3n * X1, rule: "floor" });
  const H = W(1);
  const x170 = 170_000_000_000_000_000n;
  const mk1 = (buildX: bigint) =>
    build({ epoch: 1, endTs: T0 + WEEK, F: 1_000n * XNT, x: buildX, twap: 2n * buildX, burns: [burn(H, T0 + HOUR, 1_000_000n, { xnt: x170, xntLast: (x170 * 9n) / 10n }), burn(H, T0 + 2 * HOUR, 1_000n, { xntSource: "fallback" })] }, null);
  const f1 = mk1(X1);
  const [b0, b1] = f1.burns;
  assert.deepStrictEqual([b0.xntE18, b0.xntRule, b0.base], [x170.toString(), "median", lamportsOf(BigInt(b0.valueMicro), x170).toString()]);
  assert.deepStrictEqual([b1.xntE18, b1.xntRule], [(2n * X1).toString(), "build"], "fallback = max(twap, api) at build");
  assert.strictEqual(f1.xnt.usdE18, x170.toString(), "the epoch's reference = value-weighted median of the burns' 24-hour medians");
  assert.strictEqual(mk1(10n * X1).burns[0].base, b0.base, "a candle-priced burn ignores the XNT price at build (A1)");
  const double = build({ epoch: 1, endTs: T0 + WEEK, F: 1_000n * XNT, burns: [burn(H, T0 + HOUR, 1_000_000n, { xnt: 2n * x170 })] }, null).burns[0];
  assert(BigInt(double.base) * 2n <= BigInt(b0.base) && BigInt(b0.base) - BigInt(double.base) * 2n <= 2n, "base scales inversely with x_i");
  const ref = BigInt(f1.xnt.usdE18);
  const f2 = build({ epoch: 2, endTs: T0 + 2 * WEEK, F: 1_000n * XNT, burns: [burn(H, T0 + WEEK + HOUR, 1_000n, { xnt: 10n ** 15n }), burn(H, T0 + WEEK + 2 * HOUR, 1_000n, { xnt: 100n * ref })] }, f1);
  assert.strictEqual(f2.xnt.prevE18, ref.toString());
  assert.strictEqual(f2.xnt.floorE18, ((ref * 6_000n) / 10_000n).toString());
  assert.deepStrictEqual([f2.burns[0].xntE18, f2.burns[0].xntRule], [f2.xnt.floorE18, "floor"], "a crash below 0.6 × the reference is credited at the floor");
  assert.deepStrictEqual([f2.burns[1].xntE18, f2.burns[1].xntRule], [(100n * ref).toString(), "median"], "no upper cap: a rally is never over-credited");
});

// ── 5. allocation ──────────────────────────────────────────────────────────────────────────────
test("FCFS daily tranches: C/7 per day, the first (C mod 7) days one lamport more, unused capacity rolls forward (F3)", () => {
  const ws = [allocItem(0, 0, 3_000n, 0n), allocItem(0, 1, 500n, 0n), allocItem(0, 1, 2_000n, 0n), allocItem(0, 6, 10_000n, 0n)];
  const a = allocateBurns(ws, 7_000n);
  assert.deepStrictEqual(ws.map((w) => w.senior), [1_000n, 500n, 500n, 5_000n]);
  assert.deepStrictEqual(ws.map((w) => w.basePaid), [1_000n, 500n, 500n, 5_000n]);
  assert.strictEqual(a.tau, 1_000n);
  assert.strictEqual(a.left, 0n);
  const r = [allocItem(0, 6, 10_000n, 0n)];
  allocateBurns(r, 7_006n);
  assert.strictEqual(r[0].senior, 7_006n);
  const d5 = [allocItem(0, 5, 10_000n, 0n)];
  allocateBurns(d5, 7_006n);
  assert.strictEqual(d5[0].senior, 6_006n, "days 0–5 each release τ + 1 when C mod 7 = 6");
  const d1 = [allocItem(0, 1, 10_000n, 0n)];
  allocateBurns(d1, 7_003n);
  assert.strictEqual(d1[0].senior, 2_002n);
});

test("leftover pass pays the week's unused capacity to the earliest overflow", () => {
  const ws = [allocItem(0, 0, 3_000n, 0n), allocItem(0, 3, 1_000n, 0n)];
  const a = allocateBurns(ws, 7_000n);
  assert.deepStrictEqual(ws.map((w) => [w.senior, w.basePaid]), [[1_000n, 3_000n], [1_000n, 1_000n]]);
  assert.strictEqual(a.left, 3_000n);
  const huge = [allocItem(0, 0, 10n ** 15n, 0n)];
  allocateBurns(huge, 7_000n);
  assert.deepStrictEqual([huge[0].senior, huge[0].basePaid], [1_000n, 7_000n], "a lone huge day-0 burn gets the whole week");
});

test("A12 mission lock piece (RE-2): a vesting burn claims lp + band FCFS at its arrival and locks, at its full multiplier, exactly the piece of its mission the claim covers; the rest of the layer is a Launchpad piece", () => {
  // small numbers: the dust rule (F6) is switched off with minVestEnt = 0
  const row = (w: ReturnType<typeof allocItem>) => [w.senior, w.basePaid, w.bandPaid, w.lockedLp, w.leafTier, w.converted];
  const fits = [allocItem(2, 6, 2_000n, 4_000n)]; // day 6: the whole week is released
  const a = allocateBurns(fits, 7_000n, 0n);
  assert.deepStrictEqual(row(fits[0]), [6_000n, 2_000n, 4_000n, 2_000n, 2, false], "a lone ML within the released capacity gets ent on tier 2");
  assert.deepStrictEqual([a.locked, a.split, a.converted, a.bandTotal, a.bandPaid, a.left, a.base], [1, 0, 0, 4_000n, 4_000n, 1_000n, 2_000n]);
  // the same burn on day 0 sees only day 0's tranche (1,000): it locks the piece 1,000 covers (lp 333 at 3x = 999, the
  // rounding lamport on the Launchpad piece), and the leftover completes the Launchpad piece (2,000 − 333 − 1)
  const early = [allocItem(2, 0, 2_000n, 4_000n)];
  const e = allocateBurns(early, 7_000n, 0n);
  assert.deepStrictEqual(row(early[0]), [1_000n, 2_000n, 666n, 333n, 2, false]);
  assert.deepStrictEqual([e.locked, e.split, e.converted, e.left, e.base], [1, 1, 0, 4_334n, 2_000n]);
  // no threshold: 62.5%, exactly 50% and one lamport less of the band all lock a piece at the full multiplier, and the
  // piece shrinks one step at a time with the claim (no cliff, nothing ever locked below 3x)
  const at = (C: bigint) => {
    const ws = [allocItem(2, 6, 2_000n, 4_000n)];
    const r = allocateBurns(ws, C, 0n);
    return [...row(ws[0]), r.left];
  };
  assert.deepStrictEqual(at(4_500n), [4_500n, 1_500n, 3_000n, 1_500n, 2, false, 0n]);
  assert.deepStrictEqual(at(4_000n), [4_000n, 1_334n, 2_666n, 1_333n, 2, false, 0n]);
  assert.deepStrictEqual(at(3_999n), [3_999n, 1_333n, 2_666n, 1_333n, 2, false, 0n]);
  for (let C = 1n; C <= 6_000n; C += 7n) {
    const ws = [allocItem(2, 6, 2_000n, 4_000n)];
    allocateBurns(ws, C, 0n);
    const w = ws[0];
    assert(w.senior === C && w.lockedLp * 2n >= w.bandPaid && w.bandPaid >= w.lockedLp * 2n - 2n && w.basePaid >= w.lockedLp && w.basePaid - w.lockedLp <= 2n, `C ${C}: piece ${w.lockedLp}/${w.bandPaid}, cash ${w.basePaid - w.lockedLp}`);
  }
  // FCFS among missions: the first locks in full, the second the piece its partial cover pays (1,700: lp 850 at 2x), the
  // third finds nothing and holds its Launchpad layer only
  const three = [allocItem(2, 6, 2_000n, 4_000n), allocItem(1, 6, 1_000n, 1_000n), allocItem(2, 6, 1_000n, 2_000n)];
  const t = allocateBurns(three, 7_700n, 0n);
  assert.deepStrictEqual(three.map(row), [[6_000n, 2_000n, 4_000n, 2_000n, 2, false], [1_700n, 850n, 850n, 850n, 1, false], [0n, 0n, 0n, 0n, 0, true]]);
  assert.deepStrictEqual([t.locked, t.split, t.converted, t.bandTotal, t.bandPaid, t.left], [2, 1, 1, 7_000n, 4_850n, 0n]);
  // a Launchpad burn after a mission on day 0: the mission's piece took day 0's tranche (3,000 = lp 1,000 at 3x), the
  // leftover completes the Launchpad layers only, in order (the piece's 1,000, then the tier-0 burn's 3,000)
  const mixed = [allocItem(2, 0, 2_000n, 4_000n), allocItem(0, 0, 3_000n, 0n), allocItem(0, 3, 500n, 0n)];
  const m = allocateBurns(mixed, 21_000n, 0n);
  assert.deepStrictEqual(mixed.map((w) => [w.senior, w.basePaid, w.bandPaid, w.lockedLp, w.leafTier]), [[3_000n, 2_000n, 2_000n, 1_000n, 2], [0n, 3_000n, 0n, 0n, 0], [500n, 500n, 0n, 0n, 0]]);
  assert.deepStrictEqual([m.senior, m.base, m.left], [3_500n, 5_500n, 13_500n]);
  // nothing consumed is paid to nobody: what a mission takes at arrival is exactly what it is paid then
  const tight = [allocItem(2, 6, 2_000n, 4_000n), allocItem(0, 6, 3_000n, 0n)];
  const tt = allocateBurns(tight, 3_500n, 0n);
  assert.deepStrictEqual(tight.map(row), [[3_500n, 1_167n, 2_333n, 1_167n, 2, false], [0n, 0n, 0n, 0n, 0, false]]);
  assert.deepStrictEqual([tt.senior, tt.left], [3_500n, 0n]);
  // a band of 0 never locks
  const zero = [allocItem(1, 6, 10n, 0n)];
  allocateBurns(zero, 100n, 0n);
  assert.deepStrictEqual([zero[0].basePaid, zero[0].leafTier, zero[0].converted], [10n, 0, true]);
});

test("RE-2 regression: splitting one mission into transactions sized to the capacity gains nothing (the threshold bypass is gone)", () => {
  // review a9-attacks §2: C = 150 XNT released by day 6, one tier-2 mission lp 100 XNT vs the same XEN as lp 50 + 50
  const leaves = (ws: ReturnType<typeof allocItem>[]) => [sum(ws.map((w) => w.lockedLp + w.bandPaid)), sum(ws.map((w) => w.basePaid - w.lockedLp))];
  const one = [allocItem(2, 6, 100n * XNT, 200n * XNT)];
  const two = [allocItem(2, 6, 50n * XNT, 100n * XNT), allocItem(2, 6, 50n * XNT, 100n * XNT)];
  const [a1, a2] = [allocateBurns(one, 150n * XNT), allocateBurns(two, 150n * XNT)];
  assert.deepStrictEqual(leaves(one), [150n * XNT, 0n], "the naive burner locks the 150 XNT piece (lp 50 at 3x), as the split would");
  assert.deepStrictEqual(leaves(two), leaves(one));
  assert.deepStrictEqual([a1.senior, a1.left], [a2.senior, a2.left], "the capacity consumed is the same");
  // random sweep: a mission vs the same mission in 2–3 pieces at one instant, any capacity: the tier-leaf and tier-0
  // amounts differ only by the pieces' rounding (a few lamports per piece)
  let r = 5;
  const next = (n: number) => {
    r = (r * 1_103_515_245 + 12_345) % 2_147_483_648;
    return r % n;
  };
  for (let k = 0; k < 2_000; k++) {
    const tier = 1 + next(2);
    const parts = Array.from({ length: 2 + next(2) }, () => BigInt(1_000 + next(100_000)));
    const lp = sum(parts);
    const C = BigInt(next(Number(lp) * 4));
    const whole = [allocItem(tier, 6, lp, lp * BigInt(tier))];
    const pieces = parts.map((x) => allocItem(tier, 6, x, x * BigInt(tier)));
    allocateBurns(whole, C, 0n);
    allocateBurns(pieces, C, 0n);
    const [w, p] = [leaves(whole), leaves(pieces)];
    const slack = BigInt(3 * parts.length);
    assert(w[0] - p[0] <= slack && p[0] - w[0] <= slack && w[1] - p[1] <= slack && p[1] - w[1] <= slack, `case ${k} (tier ${tier}, C ${C}): whole ${w} vs pieces ${p}`);
  }
});

test("RE-3 regression: the cumulative cap never falls at a week boundary, so a burn's claim never shrinks with its day", () => {
  // review a9-attacks §3: C = 700 XNT, an early 50 XNT burn, a tier-2 mission lp 150 on day 6 or day 7: the same lock
  const at = (day: number) => {
    const ws = [allocItem(0, 0, 50n * XNT, 0n), allocItem(2, day, 150n * XNT, 300n * XNT)];
    allocateBurns(ws, 700n * XNT);
    return [ws[1].senior, ws[1].lockedLp, ws[1].bandPaid, ws[1].leafTier];
  };
  assert.deepStrictEqual(at(7), at(6));
  assert.deepStrictEqual(at(6), [450n * XNT, 150n * XNT, 300n * XNT, 2]);
  // a lone burn's claim is non-decreasing in its day, over three weeks and any C
  for (const C of [0n, 1n, 6n, 7n, 13n, 700n, 7_001n, 123_456n]) {
    let prev = -1n;
    for (let day = 0; day < 22; day++) {
      const ws = [allocItem(0, 0, C / 3n, 0n), allocItem(0, day, 10n ** 12n, 0n)];
      allocateBurns(ws, C);
      assert(ws[1].senior >= prev, `C ${C}, day ${day}: claim ${ws[1].senior} < ${prev}`);
      if (day >= 6) assert.strictEqual(ws[1].senior, C - ws[0].senior, `C ${C}, day ${day}: after day 6 the whole C is open`);
      prev = ws[1].senior;
    }
  }
});

test("layered rule is monotone in C (S2 counterexample) and Launchpad ignores other tiers (S4)", () => {
  const j = () => allocItem(2, 0, 733_333_332n, 1_466_666_665n);
  const i = () => allocItem(0, 0, 1_000_000_000n, 0n);
  const k = () => allocItem(0, 6, 100_000_000_000n, 0n);
  const a = [j(), i(), k()];
  const b = [j(), i(), k()];
  allocateBurns(a, 7n * XNT);
  allocateBurns(b, 7_700_000_000n);
  assert(b[1].basePaid >= a[1].basePaid, "more capacity never lowers a burn");
  // A9: a later burner's tier never moves what alice was promised at her arrival (day 0's tranche, 1 XNT); bob's band,
  // reserved inside day 1's tranche like any FCFS claim, only takes from the leftover alice's claim beyond her tranche was
  // waiting for, by exactly what bob reserves more
  const alice = () => allocItem(0, 0, 10n * XNT, 0n);
  for (const bob of [allocItem(0, 1, 500_000_000n, 0n), allocItem(2, 1, 500_000_000n, 1_000_000_000n), allocItem(1, 1, 500_000_000n, 500_000_000n)]) {
    const ws = [alice(), bob];
    allocateBurns(ws, 7n * XNT);
    assert.strictEqual(ws[0].senior, XNT);
    assert.strictEqual(ws[0].basePaid, 7n * XNT - ws[1].senior);
    assert.strictEqual(ws[1].senior, bob.tier === 0 ? 500_000_000n : XNT, "bob's claim inside day 1's tranche (1 XNT left of 2)");
    assert.strictEqual(ws[1].leafTier, bob.tier, "bob locks: at least half his band is covered at his arrival");
  }
});

test("splitting a burn across wallets in the same position never raises its allocation (S3a), but by the pieces' own rounding (A12)", () => {
  const whole = [allocItem(2, 0, 2n * XNT, 4n * XNT)];
  allocateBurns(whole, 7n * XNT);
  const pieces = [allocItem(2, 0, 666_666_666n, 1_333_333_334n), allocItem(2, 0, 1_333_333_334n, 2_666_666_666n)];
  allocateBurns(pieces, 7n * XNT);
  const tot = (ws: typeof whole) => sum(ws.map((w) => w.basePaid + w.bandPaid));
  // a piece whose own band/lp ratio was rounded up (1,333,333,334 / 666,666,666 > 2) gains that lamport in its lock piece
  assert(tot(pieces) <= tot(whole) + BigInt(pieces.length - 1), `${tot(pieces)} vs ${tot(whole)}`);
  const tight = [allocItem(2, 0, 1_250_000_000n, 2_500_000_000n)];
  allocateBurns(tight, 1_700_000_000n);
  const tightSplit = [allocItem(2, 0, 566_666_667n, 1_133_333_333n), allocItem(2, 0, 683_333_333n, 1_366_666_667n)];
  allocateBurns(tightSplit, 1_700_000_000n);
  assert(tot(tightSplit) <= tot(tight));
});

test("global order (D-14): (timestamp, keccak256(txHash ‖ logIndex)) is total and chain-neutral (S16)", () => {
  const ts = T0 + DAY;
  const a = burn(W(1), ts, 1n, { chainId: 56, block: 500, logIndex: 5 });
  const b = burn(W(2), ts, 1n, { chainId: 56, block: 501, logIndex: 0 });
  const c = burn(W(3), ts, 1n, { chainId: 10, block: 9_999, logIndex: 9 });
  const d = burn(W(4), ts - 1, 1n, { chainId: 8453, block: 1, logIndex: 0 });
  const byKey = [a, b, c].sort((x, y) => (tieKeyV3(x.txHash, x.logIndex) < tieKeyV3(y.txHash, y.logIndex) ? -1 : 1));
  assert.deepStrictEqual([b, a, c, d].sort(globalOrder), [d, ...byKey], "the earlier second first, then the hash order, whatever the chain or block");
  // the key: keccak256 of the 32-byte hash and the 32-byte big-endian log index (abi.encodePacked(bytes32, uint256))
  assert.strictEqual(tieKeyV3("0x" + "11".repeat(32), 5), "ac00b23a846b2a9258ef918be58333f931a077ed9d20285597a29c7a7d0357cc");
  assert.notStrictEqual(tieKeyV3("0x" + "11".repeat(32), 5), tieKeyV3("0x" + "11".repeat(32), 6));
  assert.throws(() => tieKeyV3("0xabc", 0), /32 bytes/);
  // swapping the chain ids of two same-second burns never changes which one is served first (CF-17 property)
  for (let k = 0; k < 20; k++) {
    const t = T0 + DAY + k * HOUR;
    const x = burn(W(10 + k), t, 10_000_000n, { chainId: 10, block: blockAt(t) });
    const y = burn(W(40 + k), t, 10_000_000n, { chainId: 56, block: blockAt(t) });
    const swapped = [{ ...x, chainId: 56 }, { ...y, chainId: 10 }];
    const tight = 2n * XNT; // C = 0.16 XNT: the first one served takes the day
    const f = build({ epoch: 1, endTs: T0 + WEEK, F: tight, burns: [x, y] }, null);
    const g = build({ epoch: 1, endTs: T0 + WEEK, F: tight, burns: swapped }, null);
    assert.deepStrictEqual(f.burns.map((q) => q.x1), g.burns.map((q) => q.x1), "the same burn first after the chain swap");
    assert.deepStrictEqual(f.burns.map((q) => q.senior), g.burns.map((q) => q.senior));
    const first = tieKeyV3(x.txHash, x.logIndex) < tieKeyV3(y.txHash, y.logIndex) ? x : y;
    assert.strictEqual(f.burns[0].x1, first.x1, "the lower hash is served first");
  }
});

test("window: 7 fixed daily tranches whatever the build time; days is informational (S11)", () => {
  const prev = build({ epoch: 1, endTs: T0 + WEEK, F: 100n * XNT, burns: [burn(W(1), T0 + HOUR, 1_000n)] }, null);
  const start = publishedAt(prev);
  const end = start + WEEK + 8 * 60; // eight minutes past a week
  const f = build({ epoch: 2, endTs: end, F: 100n * XNT, burns: [burn(W(1), start - 30, 1_000n), burn(W(2), end - 1, 1_000n)] }, prev);
  assert.strictEqual(f.window.days, 8);
  assert.strictEqual(f.capacity.tranche, (BigInt(f.capacity.cash) / 7n).toString());
  assert.deepStrictEqual(f.burns.map((b) => b.day), [0, 7], "minutes past the 7th day open a further week");
  assert.strictEqual(f.burns[1].alloc, f.burns[1].lp);
  assert.throws(() => computeEpochV3(mk({ epoch: 2, endTs: end, startTs: T0, F: 100n * XNT, burns: [] }, prev), prev), /window start/);
});

// ── 6. Artifacts never reach the base pot (A13.1, the two-pot base) ──────────────────────────────
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const H = W(1);
const O = W(2);
const B = W(3);
const V = ASSET(1); // Void Anomaly, forged
const G = ASSET(2); // Genesis Lunar Dust
const D = ASSET(3); // Forge Drop Lunar Dust
const CS = ASSET(4); // Cosmic Shard, forged, recycled in epoch 3
const F10K = 10_000n * XNT;
const weekBurns = (e: number, who: string[]) => who.map((w, i) => burn(w, T0 + (e - 1) * WEEK + DAY + i * HOUR, w === H ? 2_000_000n : 1_000_000n));
const snap = (vOwner: string, withCosmic: boolean) => [
  record(V, 3, vOwner, 100n * XNT), record(G, 0, H, 0n, ORIGIN_GENESIS), record(D, 0, B, 5n * XNT, ORIGIN_DROP),
  ...(withCosmic ? [record(CS, 1, O, 12_500_000_000n)] : []),
];
const e1 = build({ epoch: 1, endTs: T0 + WEEK, F: F10K, burns: weekBurns(1, [H, B]), records: snap(H, true) }, null);
const e2 = build({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, burns: weekBurns(2, [H, B]), records: snap(H, true) }, e1);
const e3 = build({ epoch: 3, endTs: T0 + 3 * WEEK, F: F10K, burns: weekBurns(3, [H, B]), records: snap(O, false) }, e2);
const e4 = build({ epoch: 4, endTs: T0 + 4 * WEEK, F: F10K, burns: weekBurns(4, [H, O, B]), records: [...snap(O, false), record(CS, 1, O, 12_500_000_000n)] }, e3);
const e5 = build({ epoch: 5, endTs: T0 + 5 * WEEK, F: F10K, burns: weekBurns(5, [H, O, B]), records: snap(O, false) }, e4);
/** a file without the members that may differ with the Artifacts: the snapshot and the hashes that cover it */
const blind = (f: EpochFileV3) => {
  const { snapshot: _s, dataHash: _h, prevDataHash: _p, ...rest } = clone(f) as EpochFileV3 & Record<string, unknown>;
  return JSON.stringify(rest);
};
const CAPACITY_KEYS = ["bandPaid", "bandTotal", "base", "cash", "convertedMissions", "left", "lockedMissions", "planCash", "senior", "shortfall", "splitMissions", "tranche", "trancheCap"];

test("A13.1: a v3 base file carries no Artifact term (no ledger, lane, boost) and no drop policy; the snapshot is recorded as read, for the extra pot", () => {
  for (const f of [e1, e2, e3, e4, e5]) {
    assert.deepStrictEqual(retiredBaseTerms(f), [], `epoch ${f.epoch}`);
    for (const k of ["ledger", "lanes", "boosts", "drops", "dropsGross"]) assert(!(k in f), `epoch ${f.epoch} has ${k}`);
    assert(f.burns.every((b) => !("lane" in b)), "no burn carries a lane");
    assert.deepStrictEqual(Object.keys(f.capacity).sort(), CAPACITY_KEYS);
    assert.strictEqual(f.capacity.cash, ((BigInt(f.freePool.ref) * 800n) / 10_000n).toString(), "C = 8% of F_ref: no earmark, no 9/10 cash factor");
    assert.strictEqual(sum(f.targets.map((t) => BigInt(t.target))), sum(f.burns.map((b) => BigInt(b.alloc))), "the targets are exactly the burners' allocations");
    assert.deepStrictEqual(f.leaves.map((l) => l.score), f.targets.map((t) => t.target), "score = target (no drop gross-up)");
  }
  assert.deepStrictEqual(e1.snapshot.records.map((r) => r.asset), [V, G, D, CS].sort(), "the snapshot is kept, sorted, for S(n) of the extra (A12.6)");
  assert.deepStrictEqual(e3.snapshot.records.find((r) => r.asset === V)!.owner, O);
});

test("A13.1: the base pot never depends on any Artifact: the same burns give the same file but the snapshot, whatever exists and whoever holds it", () => {
  const variants: SnapshotRecord[][] = [
    [],
    snap(H, true),
    snap(B, false),
    [record(V, 3, B, 100n * XNT), record(ASSET(9), 3, H, 400n * XNT), record(ASSET(10), 2, O, 30n * XNT)],
    [record(G, 0, H, 0n, ORIGIN_GENESIS), record(D, 0, H, 5n * XNT, ORIGIN_DROP)],
  ];
  const [w1, w2, w3] = [weekBurns(1, [H, B]), weekBurns(2, [H, B]), weekBurns(3, [H, O, B])];
  const histories = variants.map((recs) => {
    const a = build({ epoch: 1, endTs: T0 + WEEK, F: F10K, burns: w1, records: recs }, null);
    const b = build({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, burns: w2, records: recs.slice(0, 1) }, a);
    const c = build({ epoch: 3, endTs: T0 + 3 * WEEK, F: F10K, burns: w3, records: [...recs].reverse() }, b);
    return [a, b, c];
  });
  for (const h of histories) {
    for (let e = 0; e < 3; e++) {
      assert.strictEqual(blind(h[e]), blind(histories[0][e]), `epoch ${e + 1}: an Artifact changed the base file`);
      assert.deepStrictEqual(h[e].proofs, histories[0][e].proofs);
    }
    assert.deepStrictEqual(verifyEpochV3(h[2], h[1]), []);
  }
});

test("A13.1: a holder and a non-holder get the same base allocation for the same burn", () => {
  const N = W(77); // holds nothing
  const recs = [record(V, 3, H, 100n * XNT), record(CS, 1, H, 12_500_000_000n)];
  // a tight week (C = 80 XNT, day 0 releases 11.43): the burn at index 1 claims against what index 0 left, and a mission locks a piece
  const [first, mid, last] = [burn(B, T0 + HOUR, 9_000_000n), burn(H, T0 + 2 * HOUR, 6_000_000n), burn(O, T0 + 3 * HOUR, 4_000_000n)];
  const at = (who: string, tier: number) => build({ epoch: 1, endTs: T0 + WEEK, F: 1_000n * XNT, records: recs, burns: [first, { ...mid, x1: who, tier }, last] }, null);
  for (const tier of [0, 1, 2]) {
    const holder = at(H, tier);
    const other = at(N, tier);
    const strip = (f: EpochFileV3) => f.burns.map((b) => JSON.stringify({ ...b, x1: undefined }));
    assert.deepStrictEqual(strip(holder), strip(other), `tier ${tier}: the burn's allocation depends on its burner holding an Artifact`);
    const mine = (f: EpochFileV3, who: string) => f.targets.filter((t) => t.player === who).map((t) => [t.tier, t.target]);
    assert.deepStrictEqual(mine(holder, H), mine(other, N));
    assert.deepStrictEqual(holder.capacity, other.capacity);
    if (tier === 2) assert(holder.burns[1].leafTier === 2, "the mission locks a piece on its tier, holder or not");
  }
});

test("A13.1: every file of the chain verifies against its predecessor; a file or a previous file with a retired term is refused", () => {
  assert.deepStrictEqual(verifyEpochV3(e1, null), []);
  for (const [prev, cur] of [[e1, e2], [e2, e3], [e3, e4], [e4, e5]] as const) {
    assert.deepStrictEqual(verifyEpochV3(cur, prev), []);
    assert.deepStrictEqual(verifyAny(cur, prev), []);
  }
  const rehash = (f: EpochFileV3) => ({ ...f, dataHash: dataHashV3(f) });
  const forged: [string, (f: Record<string, unknown>) => void][] = [
    ["ledger", (f) => (f.ledger = [])],
    ["lanes", (f) => (f.lanes = [{ player: H, asset: V, tier: 0, amount: "1" }])],
    ["boosts", (f) => (f.boosts = [])],
    ["drops", (f) => (f.drops = { seal: false })],
    ["dropsGross", (f) => (f.dropsGross = true)],
    ["capacity.earmarked", (f) => ((f.capacity as Record<string, unknown>).earmarked = "0")],
    ["burns[].lane", (f) => ((f.burns as Record<string, unknown>[])[0].lane = "0")],
  ];
  for (const [what, add] of forged) {
    const f = clone(e2) as unknown as Record<string, unknown>;
    add(f);
    const bad = rehash(f as unknown as EpochFileV3);
    assert.deepStrictEqual(retiredBaseTerms(bad), [what]);
    assert(verifyEpochV3(bad, e1).some((e) => /retired base terms/.test(e) && e.includes(what)), `verify accepts a file with ${what}`);
    assert.throws(() => computeEpochV3(mk({ epoch: 3, endTs: T0 + 3 * WEEK, F: F10K, burns: weekBurns(3, [H, B]) }, bad), bad), /retired base terms/, `a build on a file with ${what}`);
    assert(verifyEpochV3(e3, bad).length > 0);
  }
});

test("A2: the week's capacity comes from F_ref (the pool right after the previous publication), never from the pool at build", () => {
  const cashOf = (Fref: bigint) => ((Fref * 800n) / 10_000n).toString();
  const lower = build({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, open: 5_000n * XNT, burns: weekBurns(2, [H, B]), records: snap(H, true) }, e1);
  assert.deepStrictEqual([lower.freePool.ref, lower.capacity.cash], [(5_000n * XNT).toString(), cashOf(5_000n * XNT)]);
  const higher = build({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, open: 20_000n * XNT, burns: weekBurns(2, [H, B]), records: snap(H, true) }, e1);
  assert.deepStrictEqual([higher.freePool.ref, higher.capacity.cash], [(20_000n * XNT).toString(), cashOf(20_000n * XNT)], "C = 8% of F_ref (SC-11, A13.1)");
  assert.throws(() => computeEpochV3({ ...mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, burns: [] }, e1), freePool: { lamports: F10K.toString(), slot: 1, open: null } }, e1), /freePool.open/);
});

// ── 7. v2 → v3 ────────────────────────────────────────────────────────────────────────────────
function v2File(epoch: number, endTs: number, burns: Burn[], chains: ChainSnapshot[], holders: { owner: string; asset: string; tier: number }[], xE18: bigint): EpochFile {
  const leaves = computeLeaves(burns, chains, []);
  const t = buildTree(epoch, leaves);
  const body: EpochBody = {
    version: 2, programId: PROGRAM, epoch, createdAt: iso(endTs), chains, xnt: { usd: Number(xE18) / 1e18, usdE18: xE18.toString(), source: "test" }, kBps: 12_500,
    rateCap: epochRateCap(12_500, xE18.toString(), baseScore(burns, chains), BigInt(t.totalScore)).toString(),
    artifacts: { slot: 1, holders, eligible: [] }, burns, leaves, totalScore: t.totalScore, root: t.root,
  };
  return { ...body, dataHash: dataHashV2(body), proofs: t.proofs };
}
const V2_L = 1_340_766_800n;
const v2chain: ChainSnapshot = {
  chainId: 10, name: "Optimism", portal: "0xportal", fromBlockExclusive: 0, toBlock: blockAt(T0), xenUsd: 1e-6, xenUsdE18: P6.toString(), priceSource: "test",
  clamped: false, liquidityUsdMicro: V2_L.toString(), pools: [], totalSupply: "0",
};
const v2burn: Burn = {
  chainId: 10, txHash: "0x" + "77".repeat(32), logIndex: 1, blockNumber: blockAt(T0 - DAY), missionId: "1", pilot: "0x" + "ab".repeat(20),
  amountWei: (63_000n * XEN).toString(), tier: 0, x1: B, timestamp: T0 - DAY, priceE18: P6.toString(), priceSource: "test",
};
const v2 = v2File(1, T0, [v2burn], [v2chain], [{ owner: H, asset: V, tier: 3 }], 153_000_000_000_000_000n);
const s2burns = weekBurns(1, [H, B]);
const s2 = build({ epoch: 2, endTs: T0 + WEEK, F: F10K, x: X1 / 2n, chains: { 10: { L: 5_950_000_000n } }, burns: s2burns, records: [record(V, 3, H, 100n * XNT), record(CS, 1, O, 12_500_000_000n)] }, v2);

test("v2 → v3: the switch epoch maps L, x, the curve and the snapshot from the v2 file (TR-3); the v2 holders change nothing in the base (A13.1)", () => {
  assert.deepStrictEqual(verifyAny(v2, null), [], "v2 files keep verifying with the v2 rules");
  const c = s2.chains.find((x) => x.chainId === 10)!;
  // D-13 (a): the switch window is valued at the v2 file's reading (known from its first hour); the build freezes the next one
  assert.deepStrictEqual(c.L, { now: "5950000000", onChain: null, prev: V2_L.toString(), used: V2_L.toString(), rule: "switch", stat: "5950000000", next: clampL(5_950_000_000n, V2_L).toString(), cap: null });
  assert.deepStrictEqual(c.curveBefore, { S: "63000", hour: Math.floor((T0 - DAY) / HOUR) });
  assert.strictEqual(s2.xnt.prevE18, "153000000000000000");
  assert.strictEqual(s2.xnt.floorE18, ((153_000_000_000_000_000n * 6_000n) / 10_000n).toString(), "the floor comes from the v2 price (A1)");
  assert.strictEqual(s2.xnt.usdE18, X1.toString(), "the burns' own XNT prices, not the build price");
  assert.deepStrictEqual(s2.switchRefs, [{ chainId: 10, readings: [P6.toString()] }]);
  assert.strictEqual(s2.v3FirstEpoch, 2);
  assert.strictEqual(s2.prevDataHash, v2.dataHash);
  const bare = build({ epoch: 2, endTs: T0 + WEEK, F: F10K, x: X1 / 2n, chains: { 10: { L: 5_950_000_000n } }, burns: s2burns, records: [] }, v2);
  assert.strictEqual(blind(s2), blind(bare), "an Artifact held at the v2 snapshot earns nothing in the base (no Forge Right, A13.1)");
  assert.deepStrictEqual(verifyEpochV3(s2, v2), []);
  assert.deepStrictEqual(verifyAny(s2, v2), []);
});

test("version chain: v3FirstEpoch is carried, a v2 interlude is rejected, the switch can be pinned (TR-2)", () => {
  const s3 = build({ epoch: 3, endTs: T0 + 2 * WEEK, F: F10K, burns: weekBurns(2, [H, B]), records: [record(V, 3, H, 100n * XNT), record(CS, 1, O, 12_500_000_000n)] }, s2);
  assert.strictEqual(s3.v3FirstEpoch, 2);
  assert.deepStrictEqual(verifyAny(s3, s2), []);
  const bad = JSON.parse(JSON.stringify(s3)) as EpochFileV3;
  bad.v3FirstEpoch = 3;
  assert(verifyEpochV3(bad, s2).some((e) => /v3FirstEpoch/.test(e)));
  const interlude = v2File(3, T0 + 2 * WEEK, [{ ...v2burn, blockNumber: blockAt(T0 + 2 * WEEK - DAY), timestamp: T0 + 2 * WEEK - DAY }], [{ ...v2chain, fromBlockExclusive: blockAt(T0 + WEEK), toBlock: blockAt(T0 + 2 * WEEK) }], [], X1);
  assert(verifyAny(interlude, s2).some((e) => /backwards/.test(e)));
  assert(verifyAny({ ...s3, version: 4 } as unknown as EpochFileV3, s2).some((e) => /unknown/.test(e)));
  assert.strictEqual(pinnedSwitchError(2, null), null);
  assert.strictEqual(pinnedSwitchError(2, 2), null);
  assert.match(pinnedSwitchError(7, 2) ?? "", /pinned at epoch 2/);
  const withLedger = { ...clone(s2), ledger: [] } as unknown as EpochFileV3;
  const rehashed = { ...withLedger, dataHash: dataHashV3(withLedger) };
  assert.throws(() => computeEpochV3(mk({ epoch: 3, endTs: T0 + 2 * WEEK, F: F10K, burns: weekBurns(3, [H]) }, rehashed), rehashed), /retired base terms \(ledger\)/);
  assert.throws(() => computeEpochV3(mk({ epoch: 5, endTs: T0 + 2 * WEEK, F: F10K, burns: weekBurns(3, [H]) }, s2), s2), /expected 4/);
});

// ── 8. eject ───────────────────────────────────────────────────────────────────────────────────
test("end to end: a holder's ML piece vests like anyone's, and ejecting at once still pays less than Launchpad (I10)", () => {
  // C = 80 XNT, day 0 releases 11.43; B's Launchpad layer (6.625) leaves 4.8 for H's mission (lp 2.5 + band 5) at its arrival:
  // it locks the piece 4.8 covers at 3x (A12); the week's leftover completes its Launchpad piece on the tier-0 leaf
  const prev = build({ epoch: 1, endTs: T0 + WEEK, F: 1_000n * XNT, burns: [burn(B, T0 + HOUR, 10n)], records: [record(V, 3, H, 100n * XNT)] }, null);
  const bB = burn(B, T0 + WEEK + HOUR, 5_300_000n);
  const bH = burn(H, T0 + WEEK + 2 * HOUR, 2_000_000n);
  const run = (tier: number, records: SnapshotRecord[] = [record(V, 3, H, 100n * XNT)]) =>
    build({ epoch: 2, endTs: T0 + 2 * WEEK, F: 1_000n * XNT, records, burns: [{ ...bB, tier: 0 }, { ...bH, tier }] }, prev);
  const ml = run(2);
  const lp = run(0);
  const hb = ml.burns.find((b) => b.x1 === H)!;
  assert.strictEqual(hb.leafTier, 2);
  assert(hb.split && BigInt(hb.bandPaid) < BigInt(hb.band) && BigInt(hb.bandPaid) * BigInt(hb.lp) <= BigInt(hb.lockedLp) * BigInt(hb.band), `piece ${hb.lockedLp} + ${hb.bandPaid} of ${hb.lp} + ${hb.band}`);
  assert.strictEqual(hb.basePaid, hb.lp, "the week's leftover completed the Launchpad piece");
  assert.strictEqual(blind(ml), blind(run(2, [])), "without the Void the mission is paid exactly the same");
  const claims = (f: EpochFileV3) => {
    const e = publishMirror(BigInt(f.freePool.lamports), BigInt(f.totalScore), f.leaves.length);
    return new Map(f.leaves.map((l) => [`${l.player}:${l.tier}`, claimMirror(e, BigInt(l.score))]));
  };
  const cm = claims(ml);
  const eject = (cm.get(`${H}:0`) ?? 0n) + ((cm.get(`${H}:2`) ?? 0n) * 2_500n) / 10_000n;
  const cl = claims(lp);
  assert(eject < (cl.get(`${H}:0`) ?? 0n), `eject ${eject} vs Launchpad ${cl.get(`${H}:0`)}`);
});

// ── 9. encoding ────────────────────────────────────────────────────────────────────────────────
let rs = 42;
const rnd = () => {
  rs = (rs * 1_103_515_245 + 12_345) % 2_147_483_648;
  return rs / 2_147_483_648;
};
const player = (i: number) => W(200 + i);

test("encoding (A13.1): score = target, and on the upgraded program (drop_reserve = 0) every claim is exactly its target (I9, I12)", () => {
  for (let k = 0; k < 2_000; k++) {
    const n = 1 + Math.floor(rnd() * 40);
    const scale = [1, 1e3, 1e6, 1e9, 1e12, 3e13][Math.floor(rnd() * 6)];
    const targets: TargetV3[] = Array.from({ length: n }, (_, i) => ({ player: player(i), tier: 0, target: BigInt(1 + Math.floor(rnd() * scale)).toString() }));
    const enc = encodeLeaves(targets);
    assert.strictEqual(enc.totalScore, enc.T);
    assert.deepStrictEqual(enc.leaves.map((l) => l.score), targets.map((t) => t.target));
    const e = publishMirror(enc.totalScore * 10n + BigInt(Math.floor(rnd() * 1e6)), enc.totalScore, n);
    assert.deepStrictEqual([e.budget, e.dropReserve], [enc.totalScore, 0n], "budget = totalScore, no drop reserve");
    enc.leaves.forEach((l, i) => assert.strictEqual(claimMirror(e, BigInt(l.score)), BigInt(targets[i].target)));
    assert.strictEqual(e.claimed, e.budget, "the whole budget is claimed: nothing is left in the epoch");
    const { budget, claims } = programClaims(enc.leaves.map((l) => BigInt(l.score)), enc.totalScore, enc.totalScore * 10n);
    assert.strictEqual(budget, enc.totalScore);
    assert.deepStrictEqual(claims.map(String), targets.map((t) => t.target));
  }
  const dust = encodeLeaves(Array.from({ length: 100 }, (_, i) => ({ player: player(i), tier: 0, target: "1" })));
  const ed = publishMirror(10_000n, dust.totalScore, 100);
  for (const l of dust.leaves) assert.strictEqual(claimMirror(ed, BigInt(l.score)), 1n);
  assert.strictEqual(encodeLeaves([]).totalScore, 0n);
  assert.throws(() => encodeLeaves([{ player: player(1), tier: 0, target: (2n ** 64n).toString() }]), /out of range/);
});

test("rebuildReason (A13.1): the planned outflow is Σ score + keeper tips (no drop luck); the pool may move by the drift only", () => {
  const F = BigInt(e2.freePool.lamports);
  assert.strictEqual(rebuildReason(e2, F), null);
  assert.strictEqual(rebuildReason(e2, F - (F * 50n) / 10_000n), null, "the tolerated drift");
  assert.match(rebuildReason(e2, F - (F * 51n) / 10_000n) ?? "", /rebuild drift/);
  const planned = plannedOutflow(e2.leaves.map((l) => BigInt(l.score)), BigInt(e2.totalScore));
  assert.strictEqual(planned, BigInt(e2.totalScore) + 2_000_000n * BigInt(e2.leaves.filter((l) => BigInt(l.score) >= 20_000_000n).length));
});

// ── 10. epoch-level properties ─────────────────────────────────────────────────────────────────
test("sybil and dust: splitting one burn across 10 wallets in its hour never pays more; dust has no leaf", () => {
  const ts = T0 + DAY + 600;
  const one = build({ epoch: 1, endTs: T0 + WEEK, F: 50n * XNT, chains: { 10: { L: 3_000_000_000n } }, burns: [burn(W(9), ts, 100_000_000n, { tier: 2, logIndex: 100 })] }, null);
  const split = build({ epoch: 1, endTs: T0 + WEEK, F: 50n * XNT, chains: { 10: { L: 3_000_000_000n } }, burns: Array.from({ length: 10 }, (_, i) => burn(W(20 + i), ts, 10_000_000n, { tier: 2, logIndex: 100 + i })) }, null);
  for (const k of ["valueMicro", "ent", "alloc"] as const) {
    assert(sum(split.burns.map((b) => BigInt(b[k]))) <= sum(one.burns.map((b) => BigInt(b[k]))), `split ${k}`);
  }
  assert(sum(split.targets.map((t) => BigInt(t.target))) <= sum(one.targets.map((t) => BigInt(t.target))));
  assert.strictEqual(computeEpochV3(mk({ epoch: 1, endTs: T0 + WEEK, F: 50n * XNT, burns: [burn(W(9), ts, 0n, { wei: 1n })] }, null), null), null, "1 wei: value 0, nothing to publish (S5/S17)");
  const mixed = build({ epoch: 1, endTs: T0 + WEEK, F: 50n * XNT, burns: [burn(W(9), ts, 0n, { wei: 1n }), burn(W(8), ts + HOUR, 1_000_000n)] }, null);
  assert.deepStrictEqual(mixed.targets.map((t) => t.player), [W(8)]);
});

test("a chain without a market values its burns at 0 and never blocks the other chains (S5)", () => {
  const f = build({ epoch: 1, endTs: T0 + WEEK, F: 50n * XNT, chains: { 56: { L: 0n } }, burns: [burn(W(1), T0 + DAY, 1_000_000n, { chainId: 56 }), burn(W(2), T0 + DAY, 1_000_000n)] }, null);
  assert.deepStrictEqual(f.burns.map((b) => [b.chainId, b.valueMicro === "0"]), [[10, false], [56, true]]);
  assert(BigInt(f.chains.find((c) => c.chainId === 56)!.curveAfter.S) > 0n);
});

test("T = 0: nothing is published and the next build reuses the same previous file (S17)", () => {
  const prev = build({ epoch: 1, endTs: T0 + WEEK, F: 50n * XNT, burns: [burn(W(1), T0 + DAY, 1_000_000n)], records: [record(V, 3, H, 100n * XNT)] }, null);
  assert.strictEqual(computeEpochV3(mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: 50n * XNT, burns: [], records: [record(V, 3, H, 100n * XNT)] }, prev), prev), null);
  const later = build({ epoch: 2, endTs: T0 + 3 * WEEK, F: 50n * XNT, burns: [burn(W(1), T0 + 2 * WEEK + DAY, 1_000_000n)], records: [record(V, 3, H, 100n * XNT)] }, prev);
  assert.strictEqual(later.window.startTs, publishedAt(prev));
  assert.deepStrictEqual(later.snapshot.records, prev.snapshot.records, "the snapshot is read again, nothing is carried from it (A13.1)");
  assert.deepStrictEqual(verifyEpochV3(later, prev), []);
});

test("a skipped chain keeps its cursor, L and curve; its burns are read when it comes back (S18)", () => {
  const f1 = build({ epoch: 1, endTs: T0 + WEEK, F: 100n * XNT, chains: { 56: { L: 2_000_000_000n } }, burns: [burn(W(1), T0 + DAY, 1_000_000n, { chainId: 56 }), burn(W(2), T0 + DAY, 1_000_000n)] }, null);
  const late = burn(W(3), T0 + WEEK + DAY, 1_000_000n, { chainId: 56 });
  const f2 = build({ epoch: 2, endTs: T0 + 2 * WEEK, F: 100n * XNT, skip: [56], burns: [late, burn(W(2), T0 + WEEK + DAY, 1_000_000n)] }, f1);
  const c1 = f1.chains.find((c) => c.chainId === 56)!;
  const c2 = f2.chains.find((c) => c.chainId === 56)!;
  assert.deepStrictEqual([c2.skipped, c2.fromBlockExclusive, c2.toBlock, c2.L.used, c2.xenUsdE18], [true, c1.toBlock, c1.toBlock, c1.L.used, "0"]);
  assert.deepStrictEqual([c2.curveBefore, c2.curveAfter], [c1.curveAfter, c1.curveAfter]);
  assert(!f2.burns.some((b) => b.chainId === 56));
  const f3 = build({ epoch: 3, endTs: T0 + 3 * WEEK, F: 100n * XNT, chains: { 56: { L: 10n ** 13n } }, burns: [late, burn(W(2), T0 + 2 * WEEK + DAY, 1_000_000n)] }, f2);
  const c3 = f3.chains.find((c) => c.chainId === 56)!;
  // D-13 (a): the skipped week carried the frozen L; the comeback week is valued at it, and freezes the next one
  assert.deepStrictEqual([c2.L.rule, c2.L.next], ["carried", c1.L.next]);
  assert.deepStrictEqual([c3.L.prev, c3.L.used, c3.L.rule, c3.L.next], [c1.L.used, c1.L.next, "frozen", clampL(10n ** 13n, BigInt(c1.L.next!)).toString()]);
  assert.deepStrictEqual(c3.curveBefore, c1.curveAfter);
  assert.deepStrictEqual(c3.refInputs, ["0", c1.xenUsdE18]);
  const lateBurn = f3.burns.find((b) => b.txHash === late.txHash)!;
  // D-12: the burn from the skipped week is backlog: after every burn of the window, at the window's end day
  assert.deepStrictEqual([lateBurn.backlog, lateBurn.operator, lateBurn.exception], [true, false, null]);
  assert.strictEqual(lateBurn.day, dayOf(f3.window.endTs + CLOCK_SKEW_MAX, f3.window.startTs), "a backlog burn claims at the window's end");
  assert.strictEqual(f3.burns[f3.burns.length - 1].txHash, late.txHash, "ranked after the window's burns");
  assert(f3.burns.filter((b) => b.txHash !== late.txHash).every((b) => !b.backlog));
  assert.deepStrictEqual(verifyEpochV3(f2, f1), []);
  assert.deepStrictEqual(verifyEpochV3(f3, f2), []);
});

test("determinism: identical inputs in any order give the same file (I11)", () => {
  const input = mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, burns: [...weekBurns(2, [H, B, O]), burn(O, T0 + WEEK + 3 * DAY, 77_000n, { chainId: 56, tier: 1 })], records: snap(H, true) }, e1);
  const a = buildEpochFileV3(input, e1)!;
  const shuffled: EpochInputsV3 = JSON.parse(JSON.stringify(input));
  shuffled.chains.reverse();
  for (const c of shuffled.chains) c.burns.reverse();
  shuffled.snapshot.records.reverse();
  const b = buildEpochFileV3(shuffled, e1)!;
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  assert.strictEqual(a.dataHash, buildEpochFileV3(input, e1)!.dataHash);
});

test("verify: round trip passes, and every tampering is reported", () => {
  assert.deepStrictEqual(verifyEpochV3(e2, e1), []);
  const tamper = (fn: (f: EpochFileV3) => void, pattern: RegExp, prev: AnyEpochFile | null = e1) => {
    const t = JSON.parse(JSON.stringify(e2)) as EpochFileV3;
    fn(t);
    const errors = verifyEpochV3(t, prev);
    assert(errors.some((e) => pattern.test(e)), `expected ${pattern}, got ${JSON.stringify(errors)}`);
  };
  tamper((f) => (f.burns[0].amountWei = "1"), /burns does not match/);
  tamper((f) => ((f.capacity as unknown as Record<string, unknown>).earmarked = "0"), /retired base terms \(capacity\.earmarked\)/);
  tamper((f) => (f.snapshot.records[0].owner = O), /dataHash mismatch/);
  tamper((f) => (f.leaves[0].score = (BigInt(f.leaves[0].score) + 1n).toString()), /leaves does not match|root mismatch/);
  tamper((f) => (f.freePool.slot += 1), /dataHash mismatch/);
  tamper((f) => (f.freePool.lamports = XNT.toString()), /does not match the recomputation/); // a pool at build that forces a shortfall
  tamper((f) => (f.capacity.cash = "1"), /capacity does not match/);
  tamper((f) => (f.dataHash = "00" + f.dataHash.slice(2)), /dataHash mismatch/);
  tamper((f) => (f.prevDataHash = "ff"), /prevDataHash/);
  tamper((f) => ((f as unknown as Record<string, unknown>).note = "hi"), /note does not match/);
  tamper((f) => (f.proofs[Object.keys(f.proofs)[0]] = []), /proofs do not match/);
  tamper((f) => (f.rateCap = "2"), /rateCap/);
  tamper(() => undefined, /is required/, null);
  tamper(() => undefined, /expected 1/, e2);
});

test("verifyPublishedV3: budget = totalScore and no drop reserve; a reserve or a budget below totalScore is reported (ENC-3, SC-8, A13.1)", () => {
  const ts = BigInt(e2.totalScore);
  const at = e2.window.endTs + 120;
  const pub = { epoch: e2.epoch, root: e2.root, dataHash: e2.dataHash, leaves: e2.leaves.length };
  assert.deepStrictEqual(verifyPublishedV3(e2, { ...pub, budget: ts, dropReserve: 0n, totalScore: ts, freePoolBefore: F10K, rateCap: 1n, netBudget: ts, publishedAt: at }), []);
  assert.deepStrictEqual(verifyPublishedV3(e2, { ...pub, budget: ts, dropReserve: 0n, totalScore: ts }), [], "the event alone (budget, drop_reserve, total_score) is enough");
  const reserve = ts / 10n;
  const old = verifyPublishedV3(e2, { ...pub, budget: ts, dropReserve: reserve, totalScore: ts, netBudget: ts - reserve });
  assert(old.some((e) => /I9 broken: a drop reserve/.test(e)), "a v3 epoch published by a binary that still reserves drops is reported");
  assert(verifyPublishedV3(e2, { ...pub, budget: ts, dropReserve: 0n, totalScore: ts, netBudget: ts - 1n }).some((e) => /net|drop reserve/.test(e)));
  const capped = verifyPublishedV3(e2, { ...pub, budget: ts / 2n, dropReserve: 0n, totalScore: ts, rateCap: 1n, freePoolBefore: ts * 5n });
  assert(capped.some((e) => /I9 broken: the on-chain budget/.test(e)) && capped.some((e) => /below 10 × totalScore/.test(e)));
  assert(verifyPublishedV3(e2, { ...pub, budget: ts, dropReserve: 0n, totalScore: ts, publishedAt: e2.window.endTs + 7 * HOUR }).some((e) => /published at/.test(e)), "a publication long after the build is reported (F2)");
});

// ── 12. round-1 attack regressions ─────────────────────────────────────────────────────────────

test("SC-1: a build without its previous file, or with a tampered one, is refused", () => {
  const e3in = (prev: AnyEpochFile | null) => mk({ epoch: 3, endTs: T0 + 3 * WEEK, F: F10K, burns: weekBurns(3, [H, B]), records: snap(O, false) }, prev);
  assert.throws(() => computeEpochV3(e3in(null), null), /epoch-2.json is required/);
  const bad = clone(e2);
  bad.burns[0].alloc = "1";
  assert.throws(() => computeEpochV3(e3in(bad), bad), /does not match its data hash/);
  const badV2 = clone(v2);
  badV2.xnt.usdE18 = "1";
  assert.throws(() => computeEpochV3(mk({ epoch: 2, endTs: T0 + WEEK, F: F10K, burns: weekBurns(1, [H]) }, badV2), badV2), /does not match its data hash/);
});

test("SC-2 / RE-3: after a quiet (unpublished) week the whole C left is open first come first served (the cap never falls at day 7)", () => {
  const p1 = build({ epoch: 1, endTs: T0 + WEEK, F: 1_000n * XNT, burns: [burn(W(1), T0 + HOUR, 1_000n)] }, null);
  const start = publishedAt(p1);
  assert.strictEqual(computeEpochV3(mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: 1_000n * XNT, burns: [] }, p1), p1), null, "the quiet week publishes nothing");
  const f = build({ epoch: 2, endTs: T0 + 3 * WEEK, F: 1_000n * XNT, burns: [burn(W(2), T0 + 2 * WEEK + HOUR, 200_000_000n), burn(W(3), T0 + 2 * WEEK + DAY + HOUR, 800_000n)] }, p1);
  assert.deepStrictEqual([f.window.startTs, f.window.dayOrigin], [start, start], "day 0 is the window start, whatever the build time");
  const [whale, small] = f.burns;
  assert.deepStrictEqual([whale.day, small.day], [7, 8]);
  assert.strictEqual(whale.senior, f.capacity.cash, "after day 6 the whole C is open: the day-7 whale takes it, as a day-6 whale would");
  assert.deepStrictEqual([small.senior, small.alloc], ["0", "0"], "the next day's burner finds the capacity taken, first come first served");
  assert.deepStrictEqual([dayOf(start - 30, start), dayOf(start + DAY - 1, start), dayOf(start + 2 * WEEK, start)], [0, 0, 14]);
  assert.deepStrictEqual(verifyEpochV3(f, p1), []);
});

/** FCFS on one day at a reduced capacity: a prefix of the burns is paid in full, then at most one partial, then nothing */
/** rewards.KEEPER_TIP */
const KEEPER_TIP_T = 2_000_000n;
/** what a burn takes at its own arrival (A9, A12): its claim, its lock piece and its leaf; the leftover top-up is not part of it (A4) */
const arrivalOf = (b: EpochFileV3["burns"][number]) => ({ senior: b.senior, lockedLp: b.lockedLp, bandPaid: b.bandPaid, leafTier: b.leafTier, converted: b.converted });
const prefixPaid = (f: EpochFileV3) => {
  const cut = f.burns.findIndex((b) => b.alloc !== b.lp);
  return cut < 0 || f.burns.slice(cut + 1).every((b) => b.alloc === "0");
};
/** the lowest free pool the publication accepts without a rebuild (0.5% below the build reading) */
const lowestPublish = (F: bigint) => F - (F * 50n) / 10_000n;

test("SC-3 / R1-4 (A2, A13.2): a pool that shrank during the week keeps the quoted capacity; a real shortfall cuts the latest claims literally", () => {
  const p1 = build({ epoch: 1, endTs: T0 + WEEK, F: 1_000n * XNT, burns: [burn(W(1), T0 + HOUR, 1_000n)] }, null);
  // P2: A on day 0, B and Z on day 6; Z fits the quoted capacity by half a lamport per XNT
  const burns = [burn(W(2), T0 + WEEK + HOUR, 40_000_000n), burn(W(3), T0 + WEEK + 6 * DAY + HOUR, 18_000_000n), burn(W(4), T0 + WEEK + 6 * DAY + 2 * HOUR, 400_000n)];
  const at = (F: bigint) => build({ epoch: 2, endTs: T0 + 2 * WEEK, F, open: 1_000n * XNT, burns }, p1);
  const full = at(1_000n * XNT);
  const shrunk = at(990n * XNT);
  assert.strictEqual(shrunk.capacity.cash, (80n * XNT).toString(), "C is fixed by F_ref (8%, A13.1)");
  assert.deepStrictEqual(shrunk.targets, full.targets, "every burner gets the quoted amount");
  assert.strictEqual(targetOf(shrunk, W(4), 0), BigInt(shrunk.burns.find((b) => b.x1 === W(4))!.lp), "Z gets its whole Launchpad layer");
  assert.strictEqual(shrunk.capacity.shortfall, null);
  // 30 tipped burns on day 0 and a pool at build far below F_ref: day 0's tranche pays the first nine at arrival, the
  // leftover the rest in order, and the shortfall cuts the leftover top-ups from the last one back (A13.2): the
  // earliest burns are paid in full, one is cut, the latest ones get nothing
  const many = Array.from({ length: 30 }, (_, i) => burn(W(400 + i), T0 + WEEK + HOUR + i, 1_000_000n));
  const pool = 350n * XNT;
  const sf = build({ epoch: 2, endTs: T0 + 2 * WEEK, F: pool, open: 1_000n * XNT, burns: many }, p1);
  assert(sf.capacity.shortfall, "shortfall recorded");
  const s = sf.capacity.shortfall!;
  assert.deepStrictEqual(Object.keys(s).sort(), ["claim", "kept", "planned", "stage", "wanted"]);
  assert.strictEqual(s.stage, "leftover", "every arrival claim fits: the window's last claims, the top-ups, are cut");
  assert.strictEqual(sf.capacity.cash, (80n * XNT).toString(), "C and the schedule are never cut (A13.2)");
  assert.strictEqual(sf.capacity.tranche, (80n * XNT / 7n).toString());
  assert.strictEqual(s.planned, sum(sf.burns.map((b) => BigInt(b.lp))).toString(), "the plan pays every Launchpad layer");
  assert(BigInt(s.claim) < BigInt(s.wanted) && sf.burns[s.kept].alloc === (BigInt(sf.burns[s.kept].senior) + BigInt(s.claim)).toString());
  assert(sf.burns.every((b, i) => (i < s.kept ? b.alloc === b.lp : i > s.kept ? b.alloc === b.senior : true)), "burns before the cut whole, after it their arrival claim only");
  assert(prefixPaid(sf) && sf.burns[0].alloc === sf.burns[0].lp && sf.burns[29].alloc === "0", "FCFS: the latest claims are cut first");
  assert.strictEqual(sum(sf.targets.map((t) => BigInt(t.target))), sum(sf.burns.map((b) => BigInt(b.alloc))), "targets are the allocations: nothing is scaled after the fact");
  const limit = buildLimit(pool);
  const out = plannedOutflow(sf.leaves.map((l) => BigInt(l.score)), BigInt(sf.totalScore));
  assert(out <= limit && limit - out < KEEPER_TIP_T, `Σ score + keeper tips within the build limit, the cut takes the room left (${limit - out} spare)`);
  const e = publishMirror(lowestPublish(pool), BigInt(sf.totalScore), sf.leaves.length);
  sf.leaves.forEach((l, i) => assert(claimMirror(e, BigInt(l.score)) >= BigInt(sf.targets[i].target)));
  assert.deepStrictEqual(verifyEpochV3(sf, p1), []);
  // 200 dust leaves (no claim reaches the 0.02 XNT tip minimum) in a pool that halved: no tip is reserved for a leaf that
  // cannot reach the minimum, so the whole build limit is paid, FCFS: the arrival claims past it are cut, and the leftover
  // pass with them
  const q1 = build({ epoch: 1, endTs: T0 + WEEK, F: XNT, burns: [burn(W(1), T0 + HOUR, 10n)] }, null);
  const dust = Array.from({ length: 200 }, (_, i) => burn(W(600 + i), T0 + WEEK + HOUR + i * 2_000, 1_000n));
  const half = build({ epoch: 2, endTs: T0 + 2 * WEEK, F: XNT / 2n, open: XNT, burns: dust }, q1);
  assert(half.capacity.shortfall && half.capacity.shortfall.stage === "arrival", JSON.stringify(half.capacity.shortfall));
  assert(half.targets.every((t) => BigInt(t.target) < 20_000_000n) && half.targets.length > 0);
  assert.strictEqual(sum(half.burns.map((b) => BigInt(b.alloc))), buildLimit(XNT / 2n), "the whole limit is paid: no dust leaf keeps a tip in reserve");
  assert(half.burns.every((b) => b.alloc === b.senior), "an arrival cut cancels the leftover pass");
  for (let d = 0; d < 7; d++) {
    const day = half.burns.filter((b) => b.day === d);
    const cut = day.findIndex((b) => b.senior !== b.lp);
    assert(cut < 0 || day.slice(cut + 1).every((b) => b.senior === "0"), `FCFS inside day ${d}`);
  }
  assert(half.burns.slice(half.capacity.shortfall.kept + 1).every((b) => b.alloc === "0"), "every claim after the cut is 0");
  assert(plannedOutflow(half.leaves.map((l) => BigInt(l.score)), BigInt(half.totalScore)) <= buildLimit(XNT / 2n));
  const eh = publishMirror(lowestPublish(XNT / 2n), BigInt(half.totalScore), half.leaves.length);
  half.leaves.forEach((l, i) => assert(claimMirror(eh, BigInt(l.score)) >= BigInt(half.targets[i].target)));
  assert.deepStrictEqual(verifyEpochV3(half, q1), []);
});

test("SC-5: a new chain's curve starts at {S: 0, hour of its first burn} (hour 0 when it has none yet)", () => {
  const ts = T0 + DAY + 5 * HOUR;
  const f = build({ epoch: 1, endTs: T0 + WEEK, F: 100n * XNT, chains: { 56: {} }, burns: [burn(W(1), ts, 1_000n), burn(W(2), ts + 3 * HOUR, 1_000n)] }, null);
  assert.deepStrictEqual(f.chains.find((c) => c.chainId === 10)!.curveBefore, { S: "0", hour: Math.floor(ts / HOUR) });
  assert.deepStrictEqual(f.chains.find((c) => c.chainId === 56)!.curveBefore, { S: "0", hour: 0 });
});

test("SC-6: decayFactor squares from the most significant bit (the order is part of the spec)", () => {
  const one = 10n ** 18n;
  const msb = (h: number) => {
    let p = one;
    for (const bit of h.toString(2)) {
      p = (p * p) / one;
      if (bit === "1") p = (p * DECAY_Q) / one;
    }
    return p;
  };
  const lsb = (h: number) => {
    let r = one;
    let b = DECAY_Q;
    for (let k = h; k > 0; k >>= 1) {
      if (k & 1) r = (r * b) / one;
      b = (b * b) / one;
    }
    return r;
  };
  for (const h of [0, 1, 2, 3, 7, 24, 168, 336, 1_000, 5_000]) assert.strictEqual(decayFactor(h), msb(h));
  assert.strictEqual(decayFactor(168), 707_106_781_186_547_457n);
  assert.notStrictEqual(decayFactor(168), lsb(168), "an LSB-first reading gives other digits");
});

test("SC-7: verify proves I9 on the published leaves, independently of the encoder", () => {
  const t = clone(e2);
  // an encoder that scores one leaf a lamport under its target: with budget = totalScore that claim is short (A13.1)
  t.leaves = t.targets.map((x, i) => ({ player: x.player, tier: x.tier, score: i === 0 ? (BigInt(x.target) - 1n).toString() : x.target }));
  const tree = buildTree(t.epoch, t.leaves);
  t.totalScore = tree.totalScore;
  t.root = tree.root;
  t.proofs = tree.proofs;
  t.dataHash = dataHashV3(t);
  const errors = verifyEpochV3(t, e1);
  assert(errors.some((e) => /I9 broken/.test(e)), JSON.stringify(errors));
  const { claims } = programClaims(e2.leaves.map((l) => BigInt(l.score)), BigInt(e2.totalScore), BigInt(e2.totalScore) * 10n);
  e2.targets.forEach((x, i) => assert(claims[i] >= BigInt(x.target)));
});

test("SC-9: a candle price of 0 is refused; missing candles must be recorded as a fallback", () => {
  const one = (b: BurnInputV3, chains?: Record<number, ChainOpt>) => () => computeEpochV3(mk({ epoch: 1, endTs: T0 + WEEK, F: 100n * XNT, burns: [b], chains }, null), null);
  assert.throws(one(burn(W(1), T0 + DAY, 1_000n, { median: 0n })), /no candle price/);
  assert.throws(one(burn(W(1), T0 + DAY, 1_000n, { xnt: 0n })), /no candle price/);
  assert.throws(one({ ...burn(W(1), T0 + DAY, 1_000n, { source: "fallback" }), medianE18: P6.toString() }), /no candle readings/);
  assert.throws(one(burn(W(1), T0 + DAY, 1_000n, { source: "fallback" }), { 10: { spot: 0n } }), /no XEN price/);
  assert.throws(() => priceReadings("1", "1", "test", "x"), /unknown price source/);
});

test("SC-10: the switch epoch's reference is the median of the last 4 v2 readings, recorded and checked", () => {
  const hi = (P6 * 3n) / 2n;
  const v2hi = v2File(4, T0, [v2burn], [{ ...v2chain, xenUsd: 1.5e-6, xenUsdE18: hi.toString() }], [], 153_000_000_000_000_000n);
  const refs = [{ chainId: 10, readings: [hi.toString(), P6.toString(), P6.toString(), P6.toString()] }];
  const inp = (switchRefs: SwitchRefV3[] | null) => mk({ epoch: 5, endTs: T0 + WEEK, F: F10K, burns: weekBurns(1, [H]), switchRefs }, v2hi);
  const sw = build({ epoch: 5, endTs: T0 + WEEK, F: F10K, burns: weekBurns(1, [H]), switchRefs: refs }, v2hi);
  const c = sw.chains.find((x) => x.chainId === 10)!;
  assert.deepStrictEqual([c.refInputs, c.ref, c.priceCapE18], [refs[0].readings, P6.toString(), ((P6 * 12_500n) / 10_000n).toString()], "cap 1.25 × the 4-epoch median, not 1.875×");
  assert.deepStrictEqual(sw.switchRefs, refs);
  assert.deepStrictEqual(verifyAny(sw, v2hi), []);
  assert.throws(() => computeEpochV3(inp(null), v2hi), /needs switchRefs/);
  assert.throws(() => computeEpochV3(inp([{ chainId: 10, readings: [P6.toString()] }]), v2hi), /first reading/);
  assert.throws(() => computeEpochV3(inp([...refs, { chainId: 56, readings: ["1"] }]), v2hi), /not in the v2 file/);
  assert.throws(() => computeEpochV3(inp([{ chainId: 10, readings: [hi.toString(), "1", "1", "1", "1"] }]), v2hi), /1 to 4 readings/);
  assert.throws(() => computeEpochV3(mk({ epoch: 3, endTs: T0 + 2 * WEEK, F: F10K, burns: weekBurns(2, [H]), switchRefs: refs }, s2), s2), /only at the v2 → v3 switch/);
  assert.deepStrictEqual(switchRefsFromV2([v2hi, v2]), [{ chainId: 10, readings: [hi.toString(), P6.toString()] }]);
});

test("F2: the window start is pinned below by the previous window end and exactly by the on-chain publication; the end is the snapshot block time (A8, A12)", () => {
  const created = Math.floor(Date.parse(e1.createdAt) / 1000);
  const inp = (startTs: number) => mk({ epoch: 2, endTs: T0 + 2 * WEEK, startTs, F: F10K, burns: weekBurns(2, [H, B]), records: snap(H, true) }, e1);
  assert(computeEpochV3(inp(created + 6 * HOUR), e1));
  assert(computeEpochV3(inp(created + 6 * HOUR + 1), e1), "RE-1: a late publication of epoch 1 never blocks epoch 2");
  assert(computeEpochV3(inp(created + 18 * HOUR), e1), "RE-1: however late (the window only has to stay publishable)");
  // L-WIN / R2-7: inside the lag, startTs = endTs and any window shorter than MIN_EPOCH_INTERVAL − MAX_PUBLISH_LAG are
  // refused: publish_epoch needs 6 days since the last publication, and SC-8 allows at most 6 h after the build
  const short = (len: number) => () => computeEpochV3(mk({ epoch: 2, endTs: created + 30 + len, startTs: created + 30, F: F10K, burns: [], records: snap(H, true) }, e1), e1);
  for (const len of [0, 60, 5 * DAY, MIN_WINDOW - 1]) assert.throws(short(len), /could never be published/, `window of ${len} s`);
  assert.strictEqual(short(MIN_WINDOW)(), null, "a window of exactly 5 d 18 h is accepted (empty here)");
  assert.strictEqual(MIN_WINDOW, 6 * DAY - 6 * HOUR);
  assert(computeEpochV3({ ...inp(publishedAt(e1)), createdAt: iso(T0 + 2 * WEEK + 1) }, e1), "A8: createdAt is provenance, a second off the X1 instant is fine");
  assert.throws(() => computeEpochV3({ ...inp(publishedAt(e1)), createdAt: iso(T0 + 2 * WEEK + CLOCK_SKEW_MAX + 1) }, e1), /build time/);
  assert.throws(() => computeEpochV3({ ...mk({ epoch: 1, endTs: T0 + WEEK, F: F10K, burns: weekBurns(1, [H]) }, null), window: { startTs: T0 + 1, endTs: T0 + WEEK } }, null), /one week before/);
  const ts = BigInt(e1.totalScore);
  const link = { publishedAt: publishedAt(e1), budget: ts, freePoolBefore: F10K + ts };
  assert.deepStrictEqual(verifyChainLinkV3(e2, link), []);
  assert(verifyChainLinkV3(e2, { ...link, publishedAt: link.publishedAt + 1 }).some((e) => /window start/.test(e)));
  assert(verifyChainLinkV3(e2, { ...link, budget: ts - 1n }).some((e) => /freePool.open/.test(e)));
  assert.deepStrictEqual(verifyChainLinkV3(e1, null), []);
  assert(verifyChainLinkV3(e2, null).length > 0);
});

/**
 * A12 (RE-2, RE-3, RE-4): with the lock piece there is no threshold any more, and the cumulative cap never falls, so every
 * burn's claim, senior and allocation and the total paid are exactly non-decreasing in C (minVestEnt = 0; the dust edge is
 * the only residual, below VEST_MIN_ENT). A mission whose piece grows with C takes more inside its own tranche, and a
 * burn waiting on the leftover gets more, never less: the leftover C − Σ senior never shrinks when C grows.
 */
function monotoneInC(lo: { alloc: bigint; locked: boolean; bandPaid: bigint; senior?: bigint }[], hi: { alloc: bigint; locked: boolean; bandPaid: bigint; senior?: bigint }[], what: string) {
  assert(sum(hi.map((v) => v.alloc)) >= sum(lo.map((v) => v.alloc)), `${what}: the total paid fell`);
  hi.forEach((v, i) => {
    assert(v.alloc >= lo[i].alloc, `${what}: burn ${i} gets ${v.alloc} < ${lo[i].alloc}`);
    if (v.senior !== undefined) assert(v.senior >= lo[i].senior!, `${what}: burn ${i}'s senior ${v.senior} < ${lo[i].senior}`);
    assert(!(lo[i].locked && !v.locked), `${what}: burn ${i} lost its lock`);
  });
  return { flips: hi.filter((v, i) => v.locked !== lo[i].locked).length };
}

test("F3 / RE-4: every burn's allocation is exactly monotone in C (random sweep, small and large deltas)", () => {
  let r = 7;
  const next = (n: number) => {
    r = (r * 1_103_515_245 + 12_345) % 2_147_483_648;
    return r % n;
  };
  const caseOf = () =>
    Array.from({ length: 1 + next(6) }, () => ({ tier: next(3), day: next(7), lp: BigInt(1 + next(80)) }))
      .sort((a, b) => a.day - b.day);
  let flips = 0;
  for (let k = 0; k < 3_000; k++) {
    const spec = caseOf();
    const alloc = (C: bigint) => {
      const ws = spec.map((s) => allocItem(s.tier, s.day, s.lp, s.lp * BigInt(s.tier)));
      allocateBurns(ws, C, 0n);
      return ws.map((w) => ({ alloc: w.basePaid + w.bandPaid, locked: w.leafTier > 0, bandPaid: w.bandPaid, senior: w.senior }));
    };
    const C0 = BigInt(next(400));
    const lo = alloc(C0);
    for (const d of [1n, 2n, 5n, 6n, 13n, 35n, 36n, 100n]) flips += monotoneInC(lo, alloc(C0 + d), `case ${k}, C ${C0} + ${d}`).flips;
  }
  assert(flips > 0, "coverage: some mission locks a piece only with the larger C");
  const pair = (a: [number, number], b: [number, number], C: bigint) => {
    const ws = [allocItem(0, a[0], BigInt(a[1]), 0n), allocItem(0, b[0], BigInt(b[1]), 0n)];
    allocateBurns(ws, C);
    return ws.map((w) => w.basePaid);
  };
  assert.deepStrictEqual([pair([5, 100], [6, 100], 6n), pair([5, 100], [6, 100], 7n)], [[6n, 0n], [6n, 1n]], "t1 A1");
  assert.deepStrictEqual([pair([0, 1_000], [5, 1_000], 6n), pair([0, 1_000], [5, 1_000], 7n)], [[1n, 5n], [2n, 5n]], "t1 A3");
});

test("F4 (I4 restated): a split moves other burns only by rounding; each later burn of the chain gains at most the δ µUSD the pieces lost", () => {
  // t3 world 3, minimised: a $1-deep chain, a 40,831.76 XEN burn alone in its hour, four burns in the next hours
  const ts = T0 + DAY + 100;
  const aWei = 40_831_760_896_000_000_000_000n;
  const later = [22_395n, 5_334n, 23_879n, 6_881n].map((x, j) => burn(W(20 + j), ts + (j + 1) * HOUR, x));
  const elsewhere = burn(W(30), ts, 9_000n, { chainId: 56 });
  const at = (pieces: bigint[]) =>
    build({ epoch: 1, endTs: T0 + WEEK, F: 1_000_000n * XNT, chains: { 10: { L: 1_000_000n } }, burns: [...pieces.map((w, j) => burn(W(10 + j), ts, 0n, { wei: w })), ...later, elsewhere] }, null);
  const whole = at([aWei]);
  const split = at([aWei - aWei / 2n, aWei / 2n]);
  const get = (f: EpochFileV3, x1: string) => f.burns.find((b) => b.x1 === x1)!;
  const pieces = split.burns.filter((b) => b.x1 === W(10) || b.x1 === W(11));
  const delta = BigInt(get(whole, W(10)).spotMicro) - sum(pieces.map((b) => BigInt(b.spotMicro)));
  assert.strictEqual(delta, 1n, "the per-piece floors lose 1 µUSD of spot");
  for (const fld of ["valueMicro", "ent", "lp", "basePaid"] as const) assert(sum(pieces.map((b) => BigInt(b[fld]))) <= BigInt(get(whole, W(10))[fld]), `pieces' ${fld}`);
  for (const b of later) {
    const [v0, v1] = [get(whole, b.x1), get(split, b.x1)];
    const dv = BigInt(v1.valueMicro) - BigInt(v0.valueMicro);
    assert(dv >= 0n && dv <= delta, `a later burn gains between 0 and δ (F-I4R: the exact pot never lowers it), got ${dv}`);
    assert(BigInt(v1.ent) - BigInt(v0.ent) <= ceilDiv(ceilDiv(delta * 10n ** 21n, BigInt(v1.xntE18)) * 37_500n, 10_000n));
  }
  assert.deepStrictEqual([get(split, W(30)).valueMicro, get(split, W(30)).ent], [get(whole, W(30)).valueMicro, get(whole, W(30)).ent], "another chain is untouched (I3)");
  const total = (f: EpochFileV3) => sum(f.burns.map((b) => BigInt(b.valueMicro)));
  assert(total(split) - total(whole) <= delta * BigInt(later.length), "the epoch total grows by at most δ per later burn of the chain");
  assert.deepStrictEqual([verifyEpochV3(whole, null), verifyEpochV3(split, null)], [[], []]);
});

test("A9 (replaces F5): a late burn, whatever its tier or size, never changes an earlier mission's lock or band; the F5 numbers now touch the late burn only", () => {
  const ws = (late: bigint | null) => [allocItem(2, 0, 10n * XNT, 20n * XNT), allocItem(1, 1, 10n * XNT, 10n * XNT), ...(late === null ? [] : [allocItem(2, 6, late, 2n * late)])];
  const outcome = (w: ReturnType<typeof allocItem>) => [w.senior, w.basePaid, w.bandPaid, w.leafTier, w.converted];
  // C = 210 XNT releases 30 XNT on day 0 and 60 by day 1: both early missions lock in full at their arrival
  const before = ws(null);
  const a = allocateBurns(before, 210n * XNT);
  assert(a.locked === 2 && before.every((w) => w.leafTier === w.tier && w.bandPaid === w.band), "both missions locked in full");
  for (const late of [XNT, 100n * XNT, 10_000n * XNT]) {
    const after = ws(late);
    const b = allocateBurns(after, 210n * XNT);
    assert.deepStrictEqual(after.slice(0, 2).map(outcome), before.map(outcome), `late mission of ${late} lamports: the earlier missions are untouched`);
    assert(b.locked >= 2 && b.bandPaid >= a.bandPaid);
    // day 6 has 160 XNT left: the late mission takes min(3 × late, 160) and locks the piece that covers (A12): the whole
    // mission when late ≤ 53.33 XNT, else lp 53.33 at 3x with the rest of its layer as a Launchpad piece
    const z = after[2];
    assert.strictEqual(z.senior, min(late * 3n, 160n * XNT), `late ${late}: the late burn takes what day 6 has left of its claim`);
    assert.deepStrictEqual([z.leafTier, z.converted], [2, false]);
    assert(z.lockedLp + z.bandPaid <= z.senior && z.senior - z.lockedLp - z.bandPaid <= 2n && z.bandPaid <= 2n * z.lockedLp, `late ${late}: the piece is at its full multiplier`);
    if (late * 3n <= 160n * XNT) assert.deepStrictEqual([z.lockedLp, z.bandPaid, z.basePaid], [late, 2n * late, late]);
    assert.strictEqual(b.left, 160n * XNT - z.senior, `late ${late}: nothing consumed is paid to nobody`);
  }
  // the old F5 case (C = 36 XNT): day 0 releases only 5.14 XNT, so each early mission locks the piece its own tranche
  // covers (lp 1.71 at 3x, lp 2.57 at 2x), late burn or not, and the leftover completes both Launchpad layers
  const tight0 = ws(null);
  allocateBurns(tight0, 36n * XNT);
  const tight1 = ws(XNT);
  const t = allocateBurns(tight1, 36n * XNT);
  assert.deepStrictEqual(tight1.slice(0, 2).map(outcome), tight0.map(outcome));
  assert.deepStrictEqual(tight0.map((w) => [w.basePaid, w.lockedLp, w.bandPaid, w.leafTier, w.converted]), [[10n * XNT, 1_714_285_714n, 3_428_571_428n, 2, false], [10n * XNT, 2_571_428_571n, 2_571_428_571n, 1, false]]);
  assert.deepStrictEqual([tight1[2].leafTier, tight1[2].bandPaid, t.locked, t.split, t.converted], [2, 2n * XNT, 3, 2, 0], "the late small mission fits day 6 and locks in full");
});

test("F6: a vesting burn entitled to less than 0.02 XNT is paid as Launchpad, so no dust mission can be ejected", () => {
  const f = build({ epoch: 1, endTs: T0 + WEEK, F: 1_000n * XNT, burns: [burn(W(1), T0 + DAY, 4n, { tier: 2, xnt: 1_000n * X1 }), burn(W(2), T0 + DAY + HOUR, 1_000_000n, { tier: 2 })] }, null);
  const [dust, big] = f.burns;
  assert(BigInt(dust.ent) > 0n && BigInt(dust.ent) < 20_000_000n);
  assert.deepStrictEqual([dust.converted, dust.leafTier, dust.bandPaid], [true, 0, "0"]);
  assert.deepStrictEqual([big.converted, big.leafTier, f.capacity.lockedMissions, f.capacity.convertedMissions], [false, 2, 1, 1]);
  assert(!f.targets.some((t) => t.player === W(1) && t.tier > 0));
  const ws = [allocItem(2, 6, 10n, 20n), allocItem(2, 6, 10n * XNT, 20n * XNT)];
  allocateBurns(ws, 100n * XNT);
  assert.deepStrictEqual(ws.map((w) => [w.converted, w.leafTier]), [[true, 0], [false, 2]]);
});

test("R1-1: chain ids, blocks, log indexes and timestamps must be safe integers: no replay under \"10\" or 10.5", () => {
  const base = mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, burns: weekBurns(2, [H, B]), records: snap(H, true) }, e1);
  const bad = (edit: (i: EpochInputsV3) => void, re: RegExp) => {
    const i = clone(base);
    edit(i);
    assert.throws(() => computeEpochV3(i, e1), re);
  };
  for (const id of ["10", 10.5, -10, 2 ** 53] as unknown as number[]) {
    bad((i) => i.chains.push({ ...clone(i.chains[0]), chainId: id, fromBlockExclusive: 0, burns: i.chains[0].burns.map((b) => ({ ...b, chainId: id })) }), /safe non-negative integer/);
  }
  bad((i) => i.chains.push(clone(i.chains[0])), /twice/);
  bad((i) => (i.chains[0].burns[0].blockNumber += 0.5), /safe non-negative integer/);
  bad((i) => ((i.chains[0].burns[0] as unknown as Record<string, unknown>).logIndex = "1"), /safe non-negative integer/);
  bad((i) => (i.chains[0].burns[0].timestamp = T0 + 2 * WEEK + CLOCK_SKEW_MAX + 1), /after the build/);
  bad((i) => (i.chains[0].burns[0].chainId = 56), /listed under chain 10/);
  bad((i) => (i.snapshot.slot = -1), /safe non-negative integer/);
  // --full: a valid but unconfigured chain id (or a foreign portal) is an error, not a silent skip
  const cfg = [{ chainId: 10, portal: "0xPORTAL", startBlock: 1 }];
  assert.deepStrictEqual(verifyChainSetV3(e2, e1, cfg), []);
  assert(verifyChainSetV3(e2, e1, [{ chainId: 56, portal: "0xportal", startBlock: 1 }]).some((e) => /not a configured chain/.test(e)));
  assert(verifyChainSetV3(e2, e1, [{ chainId: 10, portal: "0xother", startBlock: 1 }]).some((e) => /not the configured/.test(e)));
});

test("R1-2: recorded integers must be canonical decimal strings; negative or malformed readings are refused", () => {
  const base = mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, burns: weekBurns(2, [H, B]), records: snap(H, true) }, e1);
  const bad = (edit: (i: EpochInputsV3) => void, re = /canonical unsigned integer/) => {
    const i = clone(base);
    edit(i);
    assert.throws(() => computeEpochV3(i, e1), re);
  };
  bad((i) => (i.chains[0].liquidityNowMicro = "-1000001"));
  bad((i) => (i.chains[0].burns[0].medianE18 = "-1000000000000"));
  bad((i) => (i.chains[0].burns[0].xntLastCloseE18 = "-1"));
  bad((i) => (i.chains[0].market.refUsdE18 = "-1"));
  bad((i) => (i.chains[0].market.spotE18 = "1e12"));
  bad((i) => (i.freePool.open = ""));
  for (const w of ["0x10", " 1000", "+1000", "01000", "1_000"]) bad((i) => (i.chains[0].burns[0].amountWei = w));
  bad((i) => ((i.chains[0].burns[0] as unknown as Record<string, unknown>).amountWei = 1e30));
  bad((i) => (i.freePool.lamports = (2n ** 64n).toString()), /out of range/);
  bad((i) => (i.snapshot.records[0].backing = "-5"));
});

test("R1-3: snapshot keys, owners and burn recipients must be canonical; --full compares the snapshot with the chain", () => {
  const one = (records: SnapshotRecord[], burns = weekBurns(1, [H])) => () => computeEpochV3(mk({ epoch: 1, endTs: T0 + WEEK, F: F10K, burns, records }, null), null);
  assert.throws(one([record(V, 3, H, 100n * XNT), record(V + " ", 3, H, 100n * XNT)]), /canonical base58/);
  assert.throws(one([record(V, 3, H.slice(0, -1) + "0", 100n * XNT)]), /canonical base58/, "'0' is not a base58 digit");
  assert.throws(one([record(V, 3, "1" + H, 100n * XNT)]), /canonical base58/, "a leading '1' is an extra zero byte");
  assert.throws(one([], [{ ...burn(H, T0 + DAY, 1_000n), x1: " " + H }]), /canonical base58/);
  assert.deepStrictEqual(verifySnapshotV3(e2, e2.snapshot.records), []);
  assert(verifySnapshotV3(e2, e2.snapshot.records.slice(1)).some((e) => /not on-chain/.test(e)), "a fabricated record is reported");
  assert(verifySnapshotV3(e2, [...e2.snapshot.records, record(ASSET(9), 0, O, 0n, ORIGIN_GENESIS)]).some((e) => /missing/.test(e)), "a hidden record is reported");
  assert.strictEqual(verifySnapshotV3(e2, e2.snapshot.records.map((r) => (r.asset === V ? { ...r, backing: "1" } : r))).length, 2, "a changed backing is reported");
});

// ── 13. round-2 attack regressions ─────────────────────────────────────────────────────────────
/** XEN at $0.00001 (the attackers' unit): 1 XEN = 10 µUSD */
const P5 = 10n ** 13n;

test("F-DRIFT / R2-1: the build leaves room for the 0.5% drift the rebuild rule tolerates, so the on-chain budget is always totalScore (I9)", () => {
  const p1 = build({ epoch: 1, endTs: T0 + WEEK, F: 1_000n * XNT, burns: [burn(W(1), T0 + HOUR, 1_000n)] }, null);
  const burns = [burn(W(2), T0 + WEEK + HOUR, 40_000_000n), burn(W(3), T0 + WEEK + 2 * HOUR, 30_000_000n), burn(W(4), T0 + WEEK + 3 * HOUR, 20_000_000n)];
  const at = (F: bigint) => build({ epoch: 2, endTs: T0 + 2 * WEEK, F, open: 1_000n * XNT, burns }, p1);
  const roomy = at(1_000n * XNT);
  const planned = plannedOutflow(roomy.leaves.map((l) => BigInt(l.score)), BigInt(roomy.totalScore));
  // p1-publish-drift: a shortfall (F_build 750 XNT) and a pool that fits the plan exactly under the old ⌊F/10⌋ bound
  for (const F of [750n * XNT, 10n * planned + 9n]) {
    const f = at(F);
    assert(f.capacity.shortfall !== null, "both are shortfalls under the drift-adjusted limit");
    assert(plannedOutflow(f.leaves.map((l) => BigInt(l.score)), BigInt(f.totalScore)) <= buildLimit(F));
    const low = lowestPublish(F);
    assert.strictEqual(rebuildReason(f, low), null, "a 0.5% drop is published without a rebuild");
    assert.match(rebuildReason(f, low - 1n) ?? "", /rebuild drift/);
    const e = publishMirror(low, BigInt(f.totalScore), f.leaves.length);
    assert.strictEqual(e.budget + e.dropReserve, BigInt(f.totalScore), "the on-chain budget is not capped");
    f.leaves.forEach((l, i) => assert(claimMirror(e, BigInt(l.score)) >= BigInt(f.targets[i].target), "I9 at the lowest accepted pool"));
    assert.deepStrictEqual(verifyEpochV3(f, p1), []);
  }
  // 10% of the pool less the 0.5% drift (99.5 XNT), less the D-47 oracle allowance (the Epoch rent + 0.05 XNT)
  assert.strictEqual(buildLimit(1_000n * XNT), 99_500_000_000n - 52_331_600n);
  assert.match(rebuildReason(roomy, (planned * 10n) - 1n) ?? "", /moved/);
  // a file packed to the old ⌊F/10⌋ bound no longer verifies
  const packed = clone(roomy);
  packed.freePool.lamports = (10n * planned).toString();
  packed.dataHash = dataHashV3(packed);
  assert(verifyEpochV3(packed, p1).some((e) => /less the rebuild drift/.test(e)));
});

test("F-XREF: the next XNT reference is the value-weighted median of the 24-hour medians; dust and one pumped close cannot set it", () => {
  const x19 = 190_000_000_000_000_000n;
  const honest = Array.from({ length: 3 }, (_, i) => burn(W(10 + i), T0 + DAY + i * HOUR, 1_000_000n, { xnt: x19 }));
  const dust = Array.from({ length: 4 }, (_, i) => burn(W(20), T0 + 2 * DAY + i * 60, 0n, { wei: 1n, xnt: x19, xntLast: 10n * x19 }));
  const f1 = build({ epoch: 1, endTs: T0 + WEEK, F: 1_000n * XNT, x: x19, burns: [...honest, ...dust] }, null);
  assert(f1.burns.filter((b) => b.valueMicro === "0").every((b) => b.xntRule === "last"), "the dust burns read the pumped close");
  assert.strictEqual(f1.xnt.usdE18, x19.toString(), "value-0 burns weigh nothing");
  const f2 = build({ epoch: 2, endTs: T0 + 2 * WEEK, F: 1_000n * XNT, x: x19, burns: [burn(W(30), T0 + WEEK + DAY, 10_000_000n, { xnt: x19 })] }, f1);
  assert.deepStrictEqual([f2.xnt.floorE18, f2.burns[0].xntE18, f2.burns[0].xntRule], [((x19 * 6_000n) / 10_000n).toString(), x19.toString(), "median"], "next week's burner is credited at the market");
  // a valued burn after one pumped close: its own credit takes the higher reading (A5), the reference only its median
  const pumped = build({ epoch: 1, endTs: T0 + WEEK, F: 1_000n * XNT, x: x19, burns: [burn(W(40), T0 + DAY, 1_000_000n, { xnt: x19, xntLast: 10n * x19 })] }, null);
  assert.deepStrictEqual([pumped.burns[0].xntRule, pumped.xnt.usdE18], ["last", x19.toString()]);
  assert.strictEqual(xntReference([{ weight: 1n, xE18: 5n }, { weight: 3n, xE18: 1n }, { weight: 0n, xE18: 99n }]), 1n);
  assert.strictEqual(xntReference([{ weight: 2n, xE18: 5n }, { weight: 2n, xE18: 1n }]), 1n, "the lower median at an exact half");
  assert.strictEqual(xntReference([{ weight: 1n, xE18: 5n }, { weight: 2n, xE18: 1n }, { weight: 4n, xE18: 3n }]), 3n);
  assert.strictEqual(xntReference([{ weight: 0n, xE18: 5n }]), null);
  assert.deepStrictEqual([verifyEpochV3(f1, null), verifyEpochV3(f2, f1), verifyEpochV3(pumped, null)], [[], [], []]);
});

test("F-SHORTFALL (A13.2): a shortfall cuts the latest claims literally, so I2, I7 and I10 hold exactly for what is paid", () => {
  const p1 = build({ epoch: 1, endTs: T0 + WEEK, F: 2_000n * XNT, burns: [burn(W(99), T0 + WEEK - DAY, 10_000n)] }, null);
  const t2 = publishedAt(p1);
  const ep2 = (F: bigint, burns: BurnInputV3[]) => build({ epoch: 2, endTs: t2 + WEEK - 60, F, open: 2_000n * XNT, burns }, p1); // C 160, τ 22.86
  const [A, Bw, Z] = [W(1), W(2), W(3)];
  const bA = burn(A, t2 + HOUR, 16_000_000n); // lp 20 XNT, inside day 0's tranche
  const fixed = (b: BurnInputV3, tag: string, logIndex: number) => ({ ...b, txHash: "0x" + tag.repeat(32), logIndex });
  // I2: B burns 5 days later and the pool at build shrank 50%: A, inside its tranche, keeps its whole allocation
  const alone = ep2(1_000n * XNT, [bA]);
  const both = ep2(1_000n * XNT, [bA, burn(Bw, t2 + 5 * DAY, 99_200_000n)]);
  assert(alone.capacity.shortfall === null && both.capacity.shortfall !== null);
  assert.strictEqual(targetOf(both, A, 0), targetOf(alone, A, 0));
  assert.strictEqual(targetOf(alone, A, 0), BigInt(alone.burns[0].lp));
  // I7: a later burner's tier never moves what an earlier burn takes at its arrival, in a shortfall too (A13.2: exactly)
  const bB = burn(Bw, t2 + 2 * DAY, 48_000_000n); // lp 60
  const z = (tier: number) => fixed(burn(Z, t2 + 6 * DAY, 16_000_000n, { tier }), "ff", 7);
  const asLp = ep2(1_000n * XNT, [bA, bB, z(0)]);
  const asMl = ep2(1_000n * XNT, [bA, bB, z(2)]);
  assert(asLp.capacity.shortfall !== null && asMl.capacity.shortfall !== null);
  const byW = (f: EpochFileV3, p: string) => f.burns.find((b) => b.x1 === p)!;
  // as Launchpad every arrival claim fits and the leftover is cut at B; as Moon Landing z's own claim is the one cut
  assert.deepStrictEqual([asLp.capacity.shortfall!.stage, asMl.capacity.shortfall!.stage, asMl.capacity.shortfall!.kept], ["leftover", "arrival", 2]);
  let lost = 0n;
  for (const p of [A, Bw]) {
    assert.deepStrictEqual(arrivalOf(byW(asMl, p)), arrivalOf(byW(asLp, p)), `I7 (arrival) for ${p}`);
    lost += BigInt(byW(asLp, p).basePaid) - BigInt(byW(asMl, p).basePaid);
  }
  // the leftover is not promised (A4): B's top-up, the window's last claim, goes first, and the others lose to z's tier
  // choice at most what z reserves more at its arrival and the keeper tips its cut claim sets aside
  const extra = BigInt(byW(asMl, Z).senior) - BigInt(byW(asLp, Z).senior);
  assert(lost >= 0n && lost <= extra + 2n * KEEPER_TIP_T, `A and B lost ${lost} of leftover, z reserved ${extra} more`);
  assert.deepStrictEqual([byW(asMl, Z).leafTier, byW(asMl, Z).split], [2, true], "z locks the piece its cut claim covers");
  // I10 (A12): a lone Moon Landing burn in a deep shortfall locks the piece its claim covers at the full multiplier (never a
  // lamport below 3x), so ejecting it at once pays less than Launchpad would
  const zb = (tier: number) => fixed(burn(Z, t2 + 3 * DAY, 48_000_000n, { tier }), "ee", 9);
  const ml = ep2(600n * XNT, [zb(2)]);
  const lp = ep2(600n * XNT, [zb(0)]);
  const b = ml.burns[0];
  assert.deepStrictEqual([b.converted, b.leafTier, b.split, ml.capacity.lockedMissions, ml.capacity.splitMissions], [false, 2, true, 1, 1]);
  const ejectNow = targetOf(ml, Z, 0) + (targetOf(ml, Z, 2) * 2_500n) / 10_000n;
  assert(ejectNow < targetOf(lp, Z, 0), `eject ${ejectNow} vs Launchpad ${targetOf(lp, Z, 0)}`);
  assert(BigInt(b.senior) >= BigInt(lp.burns[0].senior), "the mission's cut claim is at least the Launchpad one (own tier)");
  for (const f of [alone, both, asLp, asMl, ml, lp]) {
    assert.deepStrictEqual(verifyEpochV3(f, p1), []);
    for (const b2 of f.burns) if (b2.leafTier > 0) assert(BigInt(b2.bandPaid) * BigInt(b2.lp) <= BigInt(b2.lockedLp) * BigInt(b2.band), "a locked piece is never above its multiplier");
    const e = publishMirror(lowestPublish(BigInt(f.freePool.lamports)), BigInt(f.totalScore), f.leaves.length);
    f.leaves.forEach((l, i) => assert(claimMirror(e, BigInt(l.score)) >= BigInt(f.targets[i].target)));
  }
});

test("F-SHORTFALL (A13.1, A13.2): a shortfall cuts the latest claims only, a holder and a non-holder alike", () => {
  const holder = W(1);
  const records = [record(V, 3, holder, 400n * XNT)];
  const p1 = build({ epoch: 1, endTs: T0 + WEEK, F: 10_000n * XNT, burns: [burn(W(2), T0 + HOUR, 1_000n)], records }, null);
  const burns = [burn(holder, T0 + WEEK + HOUR, 300_000_000n), burn(W(2), T0 + WEEK + 2 * HOUR, 300_000_000n)];
  const at = (F: bigint, recs: SnapshotRecord[]) => build({ epoch: 2, endTs: T0 + 2 * WEEK, F, open: 10_000n * XNT, burns, records: recs }, p1);
  const roomy = at(10_000n * XNT, records);
  assert.strictEqual(roomy.capacity.shortfall, null);
  for (const F of [6_000n, 4_000n, 2_000n]) {
    const cut = at(F * XNT, records);
    const s = cut.capacity.shortfall!;
    assert(s && BigInt(s.claim) < BigInt(s.wanted) && cut.capacity.cash === roomy.capacity.cash, `F ${F}: ${JSON.stringify(s)}`);
    assert.deepStrictEqual(Object.keys(s).sort(), ["claim", "kept", "planned", "stage", "wanted"]);
    assert.strictEqual(s.planned, sum(roomy.burns.map((b) => BigInt(b.alloc))).toString(), "the plan is what the roomy pool pays");
    assert.strictEqual(blind(cut), blind(at(F * XNT, [])), `F ${F}: the Void changed the cut`);
    // the holder burned first: FCFS cuts the later burner first, whoever holds what
    const [h, x] = [cut.burns.find((b) => b.x1 === holder)!, cut.burns.find((b) => b.x1 === W(2))!];
    assert(BigInt(h.alloc) >= BigInt(x.alloc));
    assert.deepStrictEqual(verifyEpochV3(cut, p1), []);
  }
});

test("F-SHORTFALL stages (A13.2): the cut moves from the window's last claims (the top-ups) to the latest arrival claim, never to an earlier one", () => {
  const p1 = build({ epoch: 1, endTs: T0 + WEEK, F: 2_000n * XNT, burns: [burn(W(99), T0 + WEEK - DAY, 10_000n)] }, null);
  const t2 = publishedAt(p1);
  const [A, Z] = [W(1), W(2)];
  // A: Launchpad on day 0, lp 40 (day 0 releases 20.57 of C = 144, so half of A's layer is a leftover claim);
  // Z: Moon Landing on day 6, lp 20 + band 40, inside day 6's cumulative tranche
  const burns = [burn(A, t2 + HOUR, 32_000_000n), burn(Z, t2 + 6 * DAY + HOUR, 16_000_000n, { tier: 2 })];
  const at = (F: bigint) => build({ epoch: 2, endTs: t2 + WEEK - 60, F, open: 2_000n * XNT, burns }, p1); // C 144
  const of = (f: EpochFileV3, p: string) => f.burns.find((b) => b.x1 === p)!;
  const roomy = at(2_000n * XNT);
  assert(roomy.capacity.shortfall === null && roomy.capacity.lockedMissions === 1);
  assert.deepStrictEqual([of(roomy, A).basePaid, of(roomy, Z).basePaid, of(roomy, Z).bandPaid, of(roomy, Z).leafTier], [of(roomy, A).lp, of(roomy, Z).lp, of(roomy, Z).band, 2]);
  const tranche0 = BigInt(roomy.capacity.cash) / 7n + (BigInt(roomy.capacity.cash) % 7n > 0n ? 1n : 0n);
  // F 1,000: every arrival claim fits. Z's claim, inside its day's tranche, was made before the window's end, where the
  // part of A's layer beyond day 0's tranche is claimed (A4 never promised it): A's top-up is the claim cut, Z stays
  // locked in full, and A holds day 0's tranche of the quoted C at its arrival
  const part = at(1_000n * XNT);
  const s = part.capacity.shortfall!;
  assert(s && s.stage === "leftover" && s.kept === 0 && BigInt(s.claim) < BigInt(s.wanted), JSON.stringify(s));
  const [pa, pz] = [of(part, A), of(part, Z)];
  assert.deepStrictEqual([pz.leafTier, pz.bandPaid, pz.basePaid, BigInt(pa.senior)], [2, pz.band, pz.lp, tranche0]);
  assert(BigInt(pa.basePaid) < BigInt(pa.lp) && BigInt(pa.basePaid) === BigInt(pa.senior) + BigInt(s.claim), `A ${pa.basePaid} of ${pa.lp}`);
  assert.strictEqual(s.planned, sum(roomy.burns.map((b) => BigInt(b.alloc))).toString());
  // deeper cuts: once the room is below the arrival claims, the latest one (Z's) is cut, the whole leftover pass with it;
  // A's arrival claim never moves. Z locks the piece its cut claim covers at the full multiplier (A12: nothing locked below
  // 3x), smaller as the pool shrinks; the total paid never grows at a lower pool
  let [prevT, prevZ] = [BigInt(part.totalScore), BigInt(pz.alloc)];
  const seen = new Set<string>([pz.split ? "split" : "whole"]);
  for (const F of [800n, 700n, 600n, 500n, 400n, 300n]) {
    const f = at(F * XNT);
    const [a, z] = [of(f, A), of(f, Z)];
    const sf = f.capacity.shortfall!;
    assert(sf.stage === "arrival" && sf.kept === 1, `F ${F}: ${JSON.stringify(sf)}`);
    assert.deepStrictEqual(arrivalOf(a), arrivalOf(pa), `F ${F}: A's arrival outcome moved`);
    assert.strictEqual(a.alloc, a.senior, "an arrival cut cancels the leftover pass");
    assert(BigInt(f.totalScore) < prevT && BigInt(z.alloc) < prevZ, `F ${F}: total ${f.totalScore} (was ${prevT}), Z ${z.alloc} (was ${prevZ})`);
    assert.strictEqual(f.capacity.tranche, (BigInt(f.capacity.cash) / 7n).toString(), "the schedule is never cut");
    [prevT, prevZ] = [BigInt(f.totalScore), BigInt(z.alloc)];
    assert(z.leafTier === 2 && !z.converted && BigInt(z.bandPaid) <= 2n * BigInt(z.lockedLp) && BigInt(z.senior) - BigInt(z.lockedLp) - BigInt(z.bandPaid) <= 2n, `F ${F}: Z's piece is at its full multiplier`);
    seen.add(z.split ? "split" : "whole");
    const out = plannedOutflow(f.leaves.map((l) => BigInt(l.score)), BigInt(f.totalScore));
    assert(out <= buildLimit(F * XNT) && buildLimit(F * XNT) - out <= 2n * KEEPER_TIP_T, `F ${F}: the cut takes the room left but its spare tips`);
    assert.deepStrictEqual(verifyEpochV3(f, p1), []);
    const e = publishMirror(lowestPublish(BigInt(f.freePool.lamports)), BigInt(f.totalScore), f.leaves.length);
    f.leaves.forEach((l, i) => assert(claimMirror(e, BigInt(l.score)) >= BigInt(f.targets[i].target)));
  }
  assert(seen.has("whole") && seen.has("split"), `both regimes exercised: ${[...seen]}`);
  assert.deepStrictEqual(verifyEpochV3(part, p1), []);
});

test("R2-2 (superseded, A13.2): the cut takes the whole room left; only a leaf that can still reach the tip minimum keeps a tip in reserve", () => {
  const p1 = build({ epoch: 1, endTs: T0 + WEEK, F: 1_000n * XNT, burns: [burn(W(1), T0 + HOUR, 1_000n)] }, null);
  const burns = Array.from({ length: 12 }, (_, i) => burn(W(500 + i), T0 + WEEK + HOUR + i * 60, 20_000_000_000n));
  const f = build({ epoch: 2, endTs: T0 + 2 * WEEK, F: 140_000n * XNT, open: 200_000n * XNT, burns }, p1);
  const limit = buildLimit(140_000n * XNT);
  const out = plannedOutflow(f.leaves.map((l) => BigInt(l.score)), BigInt(f.totalScore));
  // FCFS pays one wallet: day 0's tranche at arrival, then its top-up, the claim cut (its leaf already takes a tip)
  assert.deepStrictEqual([f.leaves.length, f.capacity.shortfall!.stage, f.capacity.shortfall!.kept], [1, "leftover", 0]);
  assert(out <= limit && limit - out < KEEPER_TIP_T, `headroom ${limit - out} lamports`);
  assert(BigInt(f.totalScore) > (limit * 9n) / 10n, "more than the old (limit − …) × 9/10 room");
  const e = publishMirror(lowestPublish(140_000n * XNT), BigInt(f.totalScore), f.leaves.length);
  f.leaves.forEach((l, i) => assert(claimMirror(e, BigInt(l.score)) >= BigInt(f.targets[i].target)));
  assert.deepStrictEqual(verifyEpochV3(f, p1), []);
});

test("F-DAYORIGIN: day 0 never moves with the build time, and after a null week every burn keeps the day it was quoted on", () => {
  const p1 = build({ epoch: 1, endTs: T0 + WEEK, F: 2_000n * XNT, burns: [burn(W(99), T0 + WEEK - DAY, 10_000n)] }, null);
  const t2 = publishedAt(p1);
  const [A, Bw] = [W(1), W(2)];
  // (a) one second of build time around the old 10.5-day threshold changes nothing
  const burns = [burn(A, t2 + HOUR, 112_000_000n), burn(Bw, t2 + 8 * DAY, 32_914_280n)];
  const at = (end: number) => build({ epoch: 2, endTs: end, F: 2_000n * XNT, burns }, p1);
  const [early, late] = [at(t2 + 10 * DAY + 12 * HOUR - 1), at(t2 + 10 * DAY + 12 * HOUR)];
  assert.deepStrictEqual(early.burns.map((b) => [b.day, b.senior, b.alloc]), late.burns.map((b) => [b.day, b.senior, b.alloc]));
  assert.deepStrictEqual([early.window.dayOrigin, early.burns.map((b) => b.day)], [t2, [0, 8]]);
  // (b) a null week (chain 56 had no market), then a 14-day build: A keeps the day-3 tranche it was shown
  const bA = burn(A, t2 + 3 * DAY + HOUR, 65_828_570n, { chainId: 56 }); // lp 82.2857 XNT = 4τ
  assert.strictEqual(computeEpochV3(mk({ epoch: 2, endTs: t2 + WEEK - 60, F: 2_000n * XNT, skip: [56], burns: [bA] }, p1), p1), null);
  const f = build({ epoch: 2, endTs: t2 + 2 * WEEK - 60, F: 2_000n * XNT, burns: [bA, burn(Bw, t2 + 13 * DAY, 115_200_000n, { chainId: 56 })] }, p1);
  const a = f.burns.find((b) => b.x1 === A)!;
  assert.deepStrictEqual([a.day, a.senior, a.alloc], [3, a.lp, a.lp], "A is paid its quote");
  assert(BigInt(a.lp) <= 4n * BigInt(f.capacity.tranche) + 4n);
  assert.deepStrictEqual([verifyEpochV3(early, p1), verifyEpochV3(late, p1), verifyEpochV3(f, p1)], [[], [], []]);
});

test("F3 (weekly cycles) / RE-3: every burn's allocation stays exactly monotone in C when the window runs past 7 days", () => {
  let r = 11;
  const next = (n: number) => {
    r = (r * 1_103_515_245 + 12_345) % 2_147_483_648;
    return r % n;
  };
  let flips = 0;
  for (let k = 0; k < 2_000; k++) {
    const spec = Array.from({ length: 1 + next(7) }, () => ({ tier: next(3), day: next(22), lp: BigInt(1 + next(80)) })).sort((a, b) => a.day - b.day);
    const alloc = (C: bigint) => {
      const ws = spec.map((s) => allocItem(s.tier, s.day, s.lp, s.lp * BigInt(s.tier)));
      allocateBurns(ws, C, 0n);
      return ws.map((w) => ({ alloc: w.basePaid + w.bandPaid, locked: w.leafTier > 0, bandPaid: w.bandPaid, senior: w.senior }));
    };
    const C0 = BigInt(next(400));
    const lo = alloc(C0);
    for (const d of [1n, 2n, 6n, 7n, 13n, 50n]) flips += monotoneInC(lo, alloc(C0 + d), `case ${k}, C ${C0} + ${d}`).flips;
  }
  assert(flips > 0, "coverage: some mission locks a piece only with the larger C across the weekly cycles");
  // RE-3: after day 6 the whole C is open, first come first served (the cap never falls at a week boundary): the day-7
  // burn takes what week 0 left (6,000), the day-13 burn finds nothing
  const ws = [allocItem(0, 2, 1_000n, 0n), allocItem(0, 7, 10_000n, 0n), allocItem(0, 13, 10_000n, 0n)];
  allocateBurns(ws, 7_000n);
  assert.deepStrictEqual(ws.map((w) => w.senior), [1_000n, 6_000n, 0n]);
  assert.throws(() => allocateBurns([allocItem(0, 3, 1n, 0n), allocItem(0, 2, 1n, 0n)], 7n), /global order/);
});

test("F-I4R: with the exact pot a split never lowers a later burn's value, so the pieces never gain Launchpad layer", () => {
  const F = 8_750_000n; // C = 8% = 700,000 lamports (A13.1)
  const ts = T0 + DAY - 600; // the last hour of day 0
  const later = burn(W(30), ts + HOUR, 0n, { chainId: 56, wei: 10n ** 19n, median: P5 }); // spot 100 µUSD, day 1
  const at = (pieces: bigint[]) =>
    build({
      epoch: 1, endTs: T0 + WEEK, F, chains: { 56: { L: 1_997n, spot: P5, ref: P5 } },
      burns: [...pieces.map((w, j) => burn(W(10 + j), ts, 0n, { chainId: 56, wei: w, median: P5, logIndex: 100 + j })), later],
    }, null);
  const whole = at([10n ** 20n]); // spot 1,000 µUSD
  const split = at([5_005n * 10n ** 16n, 4_995n * 10n ** 16n]); // δ = 1 µUSD
  assert.strictEqual(whole.capacity.cash, "700000");
  const get = (f: EpochFileV3, x1: string) => f.burns.find((b) => b.x1 === x1)!;
  const pieces = split.burns.filter((b) => b.x1 !== W(30));
  assert(BigInt(get(split, W(30)).valueMicro) >= BigInt(get(whole, W(30)).valueMicro), "the later burn never loses value");
  for (const fld of ["valueMicro", "ent", "lp", "basePaid"] as const) assert(sum(pieces.map((b) => BigInt(b[fld]))) <= BigInt(get(whole, W(10))[fld]), `pieces' ${fld}`);
  assert.deepStrictEqual([curvePot(1_997n, 997n, 100n), curve(1_997n, 1_097n) - curve(1_997n, 997n)], [43n, 44n], "the old difference of floors overstated the whole's later burn");
  for (let k = 0; k < 2_000; k++) {
    const Lk = BigInt(1 + ((k * 7_919) % 5_000));
    const Sk = BigInt((k * 104_729) % 20_000);
    const Vk = BigInt(1 + ((k * 1_299_709) % 3_000));
    const p = curvePot(Lk, Sk, Vk);
    assert(p <= Vk && curvePot(Lk, Sk + 1n, Vk) <= p, "pot ≤ V and non-increasing in S");
    // fairness seed 7, world 75: inside one hour, splitting a later burn (losing δ ≤ 1 of spot) never lowers an
    // earlier burn's share, and the pieces never get more than the whole
    const a = BigInt(1 + ((k * 31_337) % 4_000));
    const b = BigInt(2 + ((k * 7_727) % 4_000));
    const d = BigInt(k % 2);
    const b1 = (b - d) / 2n;
    const start = { S: Sk, hour: 0 };
    const whole = runCurve([{ hour: 3, spot: a }, { hour: 3, spot: b }], Lk, start).values;
    const split = runCurve([{ hour: 3, spot: a }, { hour: 3, spot: b1 }, { hour: 3, spot: b - d - b1 }], Lk, start).values;
    assert(split[0] >= whole[0] && split[1] + split[2] <= whole[1], `same-hour split L ${Lk} S ${Sk} a ${a} b ${b} δ ${d}`);
  }
  assert.deepStrictEqual([verifyEpochV3(whole, null), verifyEpochV3(split, null)], [[], []]);
});

test("R2-SC-3: a burn without a XEN price skips its chain (typed error), never the whole epoch", () => {
  const inp = mk({ epoch: 1, endTs: T0 + WEEK, F: 100n * XNT, chains: { 56: { spot: 0n } }, burns: [burn(W(1), T0 + DAY, 1_000_000n), burn(W(2), T0 + DAY, 1_000_000n, { chainId: 56, source: "fallback" })] }, null);
  let err: unknown = null;
  try {
    computeEpochV3(inp, null);
  } catch (e) {
    err = e;
  }
  assert(err instanceof NoXenPriceError && err.chainId === 56 && /no XEN price/.test(err.message), String(err));
  const r1 = computeEpochV3SkippingUnpriced(inp, null);
  assert.deepStrictEqual(r1.skipped, [56]);
  assert(r1.body && r1.body.burns.length === 1 && r1.body.burns[0].chainId === 10 && !r1.body.chains.some((c) => c.chainId === 56));
  // a chain of the previous file is carried with its cursor; its burns are read when it has a price again
  const f1 = build({ epoch: 1, endTs: T0 + WEEK, F: 100n * XNT, burns: [burn(W(1), T0 + DAY, 1_000_000n), burn(W(2), T0 + DAY, 1_000_000n, { chainId: 56 })] }, null);
  const inp2 = mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: 100n * XNT, chains: { 56: { spot: 0n } }, burns: [burn(W(1), T0 + WEEK + DAY, 1_000_000n), burn(W(2), T0 + WEEK + DAY, 1_000_000n, { chainId: 56, source: "fallback" })] }, f1);
  const r2 = computeEpochV3SkippingUnpriced(inp2, f1);
  const body = r2.body!;
  const c56 = body.chains.find((c) => c.chainId === 56)!;
  assert.deepStrictEqual([r2.skipped, c56.skipped, c56.toBlock], [[56], true, f1.chains.find((c) => c.chainId === 56)!.toBlock]);
  const f2: EpochFileV3 = { ...body, dataHash: dataHashV3(body), proofs: buildTree(body.epoch, body.leaves).proofs };
  assert.deepStrictEqual(verifyEpochV3(f2, f1), []);
});

test("R2-SC-4 / R2-6: verifyPublishedV3 binds the publication to this file (epoch, root, data hash, leaf count)", () => {
  const ts = BigInt(e2.totalScore);
  const ev: PublishedEpochV3 = { epoch: BigInt(e2.epoch), root: Buffer.from(e2.root, "hex"), dataHash: "0x" + e2.dataHash.toUpperCase(), leaves: e2.leaves.length, budget: ts, dropReserve: 0n, totalScore: ts };
  assert.deepStrictEqual(verifyPublishedV3(e2, ev), [], "bytes or hex, any case");
  assert(verifyPublishedV3(e2, { ...ev, root: "ff".repeat(32) }).some((e) => /root/.test(e)));
  assert(verifyPublishedV3(e2, { ...ev, dataHash: "ee".repeat(32) }).some((e) => /data hash/.test(e)));
  assert(verifyPublishedV3(e2, { ...ev, leaves: 99 }).some((e) => /leaf count/.test(e)));
  assert(verifyPublishedV3(e2, { ...ev, epoch: 7 }).some((e) => /epoch 7/.test(e)));
  // p9: another file with the same totalScore (two burns' recipients swapped) is not the publication
  const input = mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, burns: weekBurns(2, [H, B]), records: snap(H, true) }, e1);
  const swapped = clone(input);
  const bs = swapped.chains[0].burns;
  [bs[0].x1, bs[1].x1] = [bs[1].x1, bs[0].x1];
  const fake = buildEpochFileV3(swapped, e1)!;
  assert.deepStrictEqual(verifyEpochV3(fake, e1), []);
  assert(verifyPublishedV3(fake, ev).some((e) => /root/.test(e)));
});

test("R2-SC-5: a chain read for the first time must start at its configured start block", () => {
  const cfg = (startBlock: number) => [{ chainId: 10, portal: "0xportal", startBlock }, { chainId: 137, portal: "0xportal", startBlock }];
  assert.deepStrictEqual(verifyChainSetV3(e1, null, cfg(1)), [], "epoch 1: every chain from startBlock − 1");
  assert(verifyChainSetV3(e1, null, cfg(500)).some((e) => /first time from block 0, not from its start block \(499\)/.test(e)));
  const added = build({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, chains: { 137: {} }, burns: weekBurns(2, [H, B]), records: snap(H, true) }, e1);
  assert.deepStrictEqual(verifyChainSetV3(added, e1, cfg(0)), []);
  // P6: chain 137 added after a $9 burn's block: verify alone cannot see it, the configuration can
  const late = clone(added);
  late.chains.find((c) => c.chainId === 137)!.fromBlockExclusive = 692_200;
  assert(verifyChainSetV3(late, e1, cfg(0)).some((e) => /chain 137 is read for the first time from block 692200/.test(e)));
  assert.deepStrictEqual(verifyChainSetV3(e2, e1, cfg(9_999_999)), [], "a chain of the previous file continues its cursor (checked by verify)");
});

test("R2-3: createdAt must be the canonical toISOString form: one spelling per instant, no local time zone", () => {
  const inp = mk({ epoch: 1, endTs: T0 + WEEK, F: F10K, burns: weekBurns(1, [H]) }, null);
  const canon = iso(T0 + WEEK);
  for (const s of [canon.replace(".000Z", "Z"), canon.replace(".000Z", "+00:00"), canon.replace(".000Z", ""), canon.replace(".000Z", ".000z"), "2026-10-01T09:00:00+09:00"]) {
    assert.throws(() => computeEpochV3({ ...inp, createdAt: s }, null), /canonical ISO-8601/, s);
  }
  assert(computeEpochV3({ ...inp, createdAt: new Date((T0 + WEEK) * 1000 + 999).toISOString() }, null), "milliseconds are allowed");
  assert.strictEqual(isoSeconds(iso(T0), "t"), T0);
  assert.throws(() => isoSeconds(1_790_208_000, "t"), /canonical/);
  const bad = clone(e1);
  bad.createdAt = bad.createdAt.replace(".000Z", "Z");
  bad.dataHash = dataHashV3(bad);
  assert.throws(() => computeEpochV3(mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, burns: weekBurns(2, [H]) }, bad), bad), /createdAt.*canonical ISO-8601/);
});

test("R2-4: a \"__proto__\" member is never outside the hash: verify and the build refuse it", () => {
  const raw = JSON.stringify(e2);
  const inBurn = JSON.parse(raw.replace('"burns":[{', '"burns":[{"__proto__":{"alloc":"999000000000","note":"pay me"},')) as EpochFileV3;
  assert(Object.keys(inBurn.burns[0]).includes("__proto__"));
  assert.notStrictEqual(dataHashV3(inBurn), e2.dataHash, "the member is hashed");
  assert(verifyEpochV3(inBurn, e1).some((e) => /"__proto__" member at \$\.burns\[0\]/.test(e)));
  const top = JSON.parse(raw.replace(/^\{/, '{"__proto__":{},')) as EpochFileV3;
  assert(verifyEpochV3(top, e1).some((e) => /__proto__/.test(e)));
  const prev3 = JSON.parse(JSON.stringify(e1).replace('"burns":[', '"__proto__":{"x":1},"burns":[')) as EpochFileV3;
  assert.throws(() => computeEpochV3(mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, burns: weekBurns(2, [H, B]), records: snap(H, true) }, e1), prev3), /__proto__/);
  const v2bad = JSON.parse(JSON.stringify(v2).replace('"burns":[{', '"burns":[{"__proto__":{"amountWei":"1"},')) as EpochFile;
  assert.strictEqual(dataHashV2(v2bad), v2.dataHash, "the frozen v2 hash drops the member, so the v3 build refuses the file");
  assert.throws(() => computeEpochV3(mk({ epoch: 2, endTs: T0 + WEEK, F: F10K, burns: weekBurns(1, [H, B]) }, v2bad), v2bad), /__proto__/);
  const inp = mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, burns: weekBurns(2, [H, B]), records: snap(H, true) }, e1);
  const badInp = JSON.parse(JSON.stringify(inp).replace('"market":{', '"market":{"__proto__":{"spotE18":"1"},')) as EpochInputsV3;
  assert.throws(() => computeEpochV3(badInp, e1), /inputs have a "__proto__" member/);
  assert.strictEqual(protoPath({ a: [{ b: 1 }], c: null }), null);
});

// ── 14. B-2 / A8: one clock for the window ─────────────────────────────────────────────────────
/** the real epoch-1 numbers: frontend/public/epochs/epoch-1.json and the Epoch(1) account (read-only probe, 2026-10-22) */
const REAL = { createdAt: "2026-10-18T01:38:05.469Z", publishedAt: 1_792_287_484, snapshotSlot: 86_728_912, snapshotBlockTime: 1_792_287_472, publishSlot: 86_728_945, publishBlockTime: 1_792_287_484 };
const pubOf = (f: EpochFileV3, publishedAt: number): PublishedEpochV3 => {
  const ts = BigInt(f.totalScore);
  return { epoch: f.epoch, root: f.root, dataHash: f.dataHash, leaves: f.leaves.length, budget: ts, dropReserve: 0n, totalScore: ts, publishedAt };
};

test("B-2 (X-002): the real epoch 1, published 1 s before its own createdAt, no longer blocks the first v3 build; the live skew is bounded", () => {
  const created = isoSeconds(REAL.createdAt, "createdAt");
  assert.strictEqual(REAL.publishedAt, created - 1, "live: X1's clock behind the runner's at the publication");
  assert.strictEqual(REAL.publishBlockTime, REAL.publishedAt, "published_at is the Clock sysvar = the publish slot's block time");
  assert(REAL.snapshotBlockTime < REAL.publishedAt && created - REAL.snapshotBlockTime === 13, "the snapshot slot's block time is 13 s before the runner's createdAt");
  const real: EpochFile = { ...v2File(1, created, [v2burn], [{ ...v2chain, toBlock: blockAt(created) }], [{ owner: H, asset: V, tier: 3 }], 153_000_000_000_000_000n), createdAt: REAL.createdAt };
  real.dataHash = dataHashV2(real);
  assert.strictEqual(real.createdAt, REAL.createdAt);
  assert.deepStrictEqual(verifyAny(real, null), [], "the v2 file with the live createdAt verifies under the v2 rules");
  const end = REAL.publishedAt + WEEK + 600; // the next build's snapshot block time, a week later
  const burns = [burn(H, REAL.publishedAt + DAY, 1_000_000n), burn(B, REAL.publishedAt + 2 * DAY, 500_000n)];
  const inp = (startTs: number) => mk({ epoch: 2, endTs: end, startTs, F: F10K, burns, records: [record(V, 3, H, 100n * XNT)] }, real);
  const f = buildEpochFileV3(inp(REAL.publishedAt), real);
  assert(f, "the live numbers build");
  assert.deepStrictEqual([f.window.startTs, f.window.endTs, f.window.dayOrigin], [REAL.publishedAt, end, REAL.publishedAt]);
  assert.deepStrictEqual(verifyAny(f, real), []);
  assert.deepStrictEqual(verifyChainLinkV3(f, { publishedAt: REAL.publishedAt, budget: 1n, freePoolBefore: F10K + 1n }), []);
  // a v2 previous file holds no X1 instant: its createdAt anchors the bound with the clock tolerance, the lag above
  assert(computeEpochV3(inp(created - CLOCK_SKEW_MAX), real));
  assert.throws(() => computeEpochV3(inp(created - CLOCK_SKEW_MAX - 1), real), /window start/);
  assert(computeEpochV3(inp(created + 6 * HOUR), real));
  assert(computeEpochV3(inp(created + 6 * HOUR + 1), real), "RE-1: a late v2 publication never blocks the switch epoch");
});

test("A8: the runner's clock ahead of X1 by 0–20 min, or behind, changes only createdAt; beyond CLOCK_SKEW_MAX the build is refused", () => {
  const end = T0 + 2 * WEEK;
  const at = (skew: number) => ({ ...mk({ epoch: 2, endTs: end, F: F10K, burns: weekBurns(2, [H, B]), records: snap(H, true) }, e1), createdAt: iso(end + skew) });
  const ref = buildEpochFileV3(at(0), e1)!;
  for (const skew of [0, 1, 60, 5 * 60, 20 * 60, CLOCK_SKEW_MAX, -1, -60, -5 * 60, -20 * 60, -CLOCK_SKEW_MAX]) {
    const f = buildEpochFileV3(at(skew), e1);
    assert(f, `skew ${skew}`);
    assert.strictEqual(f.createdAt, iso(end + skew));
    assert.deepStrictEqual(
      [f.window.endTs, f.window.startTs, f.window.days, f.root, f.totalScore, f.capacity.cash],
      [end, ref.window.startTs, ref.window.days, ref.root, ref.totalScore, ref.capacity.cash],
      `skew ${skew}: the runner's clock changes no leaf and no window`,
    );
    assert.deepStrictEqual(verifyAny(f, e1), [], `skew ${skew} verifies`);
    // the publication is bounded on X1's clock alone, whatever the runner's clock said: same second, +12 s, +6 h
    for (const pub of [end, end + 12, end + MAX_PUBLISH_LAG_T]) assert.deepStrictEqual(verifyPublishedV3(f, pubOf(f, pub)), [], `skew ${skew}, published at +${pub - end}`);
    assert(verifyPublishedV3(f, pubOf(f, end - 1)).some((e) => /published at/.test(e)), "a publication before the snapshot's block time is impossible on one clock");
    assert(verifyPublishedV3(f, pubOf(f, end + MAX_PUBLISH_LAG_T + 1)).some((e) => /published at/.test(e)));
  }
  for (const skew of [CLOCK_SKEW_MAX + 1, -(CLOCK_SKEW_MAX + 1), DAY, -DAY]) assert.throws(() => computeEpochV3(at(skew), e1), /build time/, `skew ${skew}`);
  // the next epoch chains on the X1 instant, not on createdAt: a 20-min-ahead runner, then a publication 12 s after the snapshot
  const prev = buildEpochFileV3(at(20 * 60), e1)!;
  const next = (startTs: number) => computeEpochV3(mk({ epoch: 3, endTs: end + WEEK, startTs, F: F10K, burns: weekBurns(3, [H, B]), records: snap(H, true) }, prev), prev);
  assert(next(end + 12));
  assert(next(end), "published in the snapshot's own second");
  assert.throws(() => next(end - 1), /window start/, "before the previous snapshot's block time: not the same clock");
  assert(next(end + MAX_PUBLISH_LAG_T));
  assert(next(end + MAX_PUBLISH_LAG_T + 1), "RE-1: a late publication is reported by verify --full on its own epoch, it never blocks the next one");
  // a tampered window end (still near createdAt) breaks the hash chain and the --full block-time check
  const t = { ...prev, window: { ...prev.window, endTs: prev.window.endTs + 1 } };
  assert(verifyAny(t, e1).some((e) => /dataHash|window/.test(e)));
  assert(verifySnapshotTimeV3(t, prev.window.endTs).some((e) => /window end/.test(e)));
});

test("RE-1 regression: epoch n−1 published 6 h + 1 s after its snapshot: epoch n builds on that published_at, verifies its chain link, and only n−1's publication is reported late", () => {
  const end1 = T0 + WEEK;
  const prev = build({ epoch: 1, endTs: end1, F: F10K, burns: weekBurns(1, [H, B]), records: snap(H, true) }, null);
  const late = end1 + MAX_PUBLISH_LAG_T + 1; // review clock-attacks C1: X1 halt, a stalled run, an old build re-sent
  const f = build({ epoch: 2, endTs: late + WEEK, startTs: late, F: F10K, burns: weekBurns(2, [H, B]), records: snap(H, true) }, prev);
  assert.deepStrictEqual([f.window.startTs, f.window.dayOrigin], [late, late], "the window starts at the on-chain published_at, however late");
  assert.deepStrictEqual(verifyAny(f, prev), []);
  const ts = BigInt(prev.totalScore);
  assert.deepStrictEqual(verifyChainLinkV3(f, { publishedAt: late, budget: ts, freePoolBefore: F10K + ts }), [], "verify --full: the chain link holds");
  assert(verifyChainLinkV3(f, { publishedAt: late + 1, budget: ts, freePoolBefore: F10K + ts }).some((e) => /window start/.test(e)), "and is still exact");
  const report = verifyPublishedV3(prev, pubOf(prev, late));
  assert(report.length === 1 && /published at .* a late publication, reported on its own epoch; it never blocks the next one/.test(report[0]), report.join("; "));
  assert.deepStrictEqual(verifyPublishedV3(prev, pubOf(prev, end1 + MAX_PUBLISH_LAG_T)), []);
  // the lower bound stays exact: a publication before the snapshot is impossible on one clock
  assert.throws(() => computeEpochV3(mk({ epoch: 2, endTs: late + WEEK, startTs: end1 - 1, F: F10K, burns: weekBurns(2, [H, B]), records: snap(H, true) }, prev), prev), /window start/);
  // RE-1 (b): the oracle never sends a late build itself: rebuildReason sees the clock of the slot the pool was read at
  const pool = BigInt(prev.freePool.lamports);
  assert.strictEqual(rebuildReason(prev, pool), null, "without a clock: the pool rules only (unchanged)");
  assert.strictEqual(rebuildReason(prev, pool, end1 + MAX_PUBLISH_LAG_T), null);
  assert.match(rebuildReason(prev, pool, end1 + MAX_PUBLISH_LAG_T + 1) ?? "", /older than MAX_PUBLISH_LAG/);
  // A13.5 (N5, supersedes "an unknown block time never blocks a publication"): a failed block-time read fails CLOSED
  assert.match(rebuildReason(prev, pool, null) ?? "", /block time of the free-pool read is unknown.*not published \(A13\.5\)/);
});

test("RE-4 regression: the total paid and every senior are non-decreasing in C, also with the dust rule (FCFS at C; A13.2 no longer bisects C)", () => {
  // review a9-attacks §4 found 32 decreases of the total paid in 180,000 (world, C) pairs under A9's threshold
  let r = 13;
  const next = (n: number) => {
    r = (r * 1_103_515_245 + 12_345) % 2_147_483_648;
    return r % n;
  };
  let decreases = 0;
  let dustEdge = 0n;
  for (let k = 0; k < 6_000; k++) {
    const tiny = k % 10 === 0; // some worlds with Launchpad layers below VEST_MIN_ENT (the dust edge)
    const spec = Array.from({ length: 1 + next(6) }, () => ({ tier: next(3), day: next(9), lp: tiny ? BigInt(1 + next(30_000_000)) : BigInt(20_000_000 + next(50) * 100_000_000) }))
      .sort((a, b) => a.day - b.day);
    const at = (C: bigint) => {
      const ws = spec.map((s) => allocItem(s.tier, s.day, s.lp, s.lp * BigInt(s.tier)));
      allocateBurns(ws, C);
      return { total: sum(ws.map((w) => w.basePaid + w.bandPaid)), seniors: ws.map((w) => w.senior) };
    };
    const C0 = BigInt(next(2_000)) * 10_000_000n;
    const [lo, hi] = [at(C0), at(C0 + BigInt(1 + next(500)) * 1_000_000n)];
    if (hi.total < lo.total) {
      decreases++;
      if (!tiny) assert.fail(`world ${k}: total ${lo.total} -> ${hi.total} with every Launchpad layer at or above VEST_MIN_ENT`);
      if (lo.total - hi.total > dustEdge) dustEdge = lo.total - hi.total;
    }
    if (!tiny) lo.seniors.forEach((s, i) => assert(hi.seniors[i] >= s, `world ${k}: burn ${i}'s senior ${s} -> ${hi.seniors[i]}`));
  }
  assert(dustEdge < 20_000_000n, `a decrease only across the dust edge, below VEST_MIN_ENT (${dustEdge})`);
});

test("RE-6 (2) regression: burning 1 XNT less no longer pays a patient burner more nominal (review a9 §8: 1.46x tier 1, 1.92x tier 2 under A9)", () => {
  for (const [tier, lps] of [[1, [34_333_333_333n, 33_333_333_333n]], [2, [26n * XNT, 25n * XNT]]] as const) {
    const out = lps.map((lp) => {
      const ws = [allocItem(0, 0, 50n * XNT, 0n), allocItem(tier, 6, lp, lp * BigInt(tier))];
      allocateBurns(ws, 100n * XNT); // the early 50 XNT burn leaves 50 XNT of capacity for the mission at day 6
      return ws[1];
    });
    const [larger, smaller] = out;
    assert(larger.basePaid + larger.bandPaid >= smaller.basePaid + smaller.bandPaid, `tier ${tier}: larger ${larger.basePaid + larger.bandPaid} < smaller ${smaller.basePaid + smaller.bandPaid}`);
    assert(larger.leafTier === tier && smaller.leafTier === tier, "both lock a piece at the full multiplier");
  }
});

test("A8: a null block time never anchors a window, and verify --full confirms the window end against the snapshot slot", () => {
  assert.strictEqual(snapshotWindowEnd(REAL.snapshotSlot, REAL.snapshotBlockTime), REAL.snapshotBlockTime);
  assert.throws(() => snapshotWindowEnd(REAL.snapshotSlot, null), /no block time for snapshot slot 86728912/);
  assert.throws(() => snapshotWindowEnd(REAL.snapshotSlot, undefined), /no block time/);
  assert.throws(() => snapshotWindowEnd(REAL.snapshotSlot, -1), /block time of snapshot slot/);
  assert.throws(() => snapshotWindowEnd(REAL.snapshotSlot, 1.5), /block time of snapshot slot/);
  assert.throws(() => snapshotWindowEnd(-1, REAL.snapshotBlockTime), /snapshot.slot/);
  assert.deepStrictEqual(verifySnapshotTimeV3(e2, e2.window.endTs), []);
  assert(verifySnapshotTimeV3(e2, e2.window.endTs + 1).some((e) => /window end .* is not the block time/.test(e)));
  assert(verifySnapshotTimeV3(e2, e2.window.endTs - 1).some((e) => /window end .* is not the block time/.test(e)));
  assert(verifySnapshotTimeV3(e2, null).some((e) => /cannot be confirmed/.test(e)), "null is reported, never a pass");
  assert(verifySnapshotTimeV3(e2, undefined).some((e) => /cannot be confirmed/.test(e)));
});

test("A8: a burn stamped after the window end on its chain's own clock is kept within CLOCK_SKEW_MAX and refused beyond", () => {
  const end = T0 + WEEK;
  const one = (ts: number) => computeEpochV3(mk({ epoch: 1, endTs: end, F: 100n * XNT, burns: [burn(W(1), ts, 1_000_000n, { block: blockAt(end) })] }, null), null);
  for (const ts of [end, end + 1, end + 30, end + CLOCK_SKEW_MAX]) {
    const f = one(ts);
    assert(f && BigInt(f.targets[0].target) > 0n, `burn at end + ${ts - end} is paid`);
    assert.strictEqual(f.burns[0].day, dayOf(ts, end - WEEK));
  }
  assert.throws(() => one(end + CLOCK_SKEW_MAX + 1), /after the build/);
});

// ── 15. A13.2: the literal latest-claims cut (OWNER-A12-1) ────────────────────────────────────
/** epoch 2 of review a9 §6: F_ref 1,000 XNT (C = 80 XNT), the pool at build 500 XNT; two day-0 burns, then a day-6 burn */
const a9s6 = (lateTier: number, n = 3) => {
  const open = 1_000n * XNT;
  const e1 = build({ epoch: 1, endTs: T0 + WEEK, F: open, burns: [burn(W(9), T0 + DAY, 1_000_000n)] }, null);
  const S2 = publishedAt(e1);
  const burns = [burn(W(1), S2 + 100, 8_000_000n), burn(W(2), S2 + 200, 8_000_000n), burn(W(3), S2 + 6 * DAY + 100, 16_000_000n, { tier: lateTier })].slice(0, n);
  return { e1, f: build({ epoch: 2, endTs: T0 + 2 * WEEK, F: 500n * XNT, open, burns }, e1) };
};

test("A13.2 (review a9 §6): a late Moon Landing in a shortfall week never lowers an earlier burn (was 9.999999 → 6.395400 and → 0 XNT)", () => {
  const { f: asLp } = a9s6(0);
  const { e1, f: asMl } = a9s6(2);
  const by = (f: EpochFileV3, i: number) => f.burns.find((b) => b.x1 === W(i))!;
  assert.strictEqual(asLp.capacity.shortfall, null, "as Launchpad the plan fits");
  assert(asMl.capacity.shortfall !== null, "as Moon Landing the plan does not fit");
  // the first burn keeps its whole Launchpad layer (9.999999 XNT), the second its whole arrival claim (day 0's tranche left)
  assert.strictEqual(by(asMl, 1).alloc, by(asLp, 1).alloc, `first burn ${by(asLp, 1).alloc} → ${by(asMl, 1).alloc}`);
  assert.strictEqual(by(asLp, 1).alloc, by(asLp, 1).lp, "the first burn is paid its whole Launchpad layer");
  for (const i of [1, 2]) assert.deepStrictEqual(arrivalOf(by(asMl, i)), arrivalOf(by(asLp, i)), `burn ${i}'s arrival outcome moved with the late burn's tier`);
  // prefix: each earlier burn is paid at least what it takes at arrival with no later burn at all
  for (const k of [1, 2]) {
    const { f: alone } = a9s6(0, k);
    for (let i = 1; i <= k; i++) assert.deepStrictEqual(arrivalOf(by(asMl, i)), arrivalOf(by(alone, i)), `burn ${i}: arrival outcome depends on a later burn`);
  }
  // the late mission takes what is left, at its own place in the order, and only it is cut
  const z = by(asMl, 3);
  assert(BigInt(z.alloc) > 0n && BigInt(z.alloc) < BigInt(z.ent) && z.leafTier === 2, `late mission ${z.alloc} of ${z.ent} on tier ${z.leafTier}`);
  assert(BigInt(z.bandPaid) * BigInt(z.lp) <= BigInt(z.lockedLp) * BigInt(z.band), "never locked below its multiplier");
  assert(plannedOutflow(asMl.leaves.map((l) => BigInt(l.score)), BigInt(asMl.totalScore)) <= buildLimit(500n * XNT));
  assert.deepStrictEqual(verifyEpochV3(asMl, e1), []);
});

/** a deterministic sweep of allocateBurns with the build-limit gate (A13.2): up to 10 burns of up to 4 wallets, any tier */
function a132Sweep(seed: number, cases: number, fn: (sp: { tier: number; day: number; lp: bigint; wallet: number }[], C: bigint, limit: bigint, r: () => number) => void) {
  let x = seed >>> 0;
  const r = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let it = 0; it < cases; it++) {
    const n = 1 + Math.floor(r() * 10);
    const scale = [1e7, 3e7, 1e8, 1e9, 1e10][Math.floor(r() * 5)];
    let day = 0;
    const sp = Array.from({ length: n }, () => {
      if (r() < 0.3) day += Math.floor(r() * 3);
      return { tier: Math.floor(r() * 3), day: Math.min(day, 8), lp: BigInt(Math.floor(r() * scale)) + 1n, wallet: Math.floor(r() * 4) };
    });
    fn(sp, BigInt(Math.floor(r() * scale * n)), BigInt(Math.floor(r() * scale * n * 0.8)), r);
  }
}
const gated = (sp: { tier: number; day: number; lp: bigint; wallet: number }[], C: bigint, limit: bigint) => {
  const ws = sp.map((x) => allocItem(x.tier, x.day, x.lp, x.lp * BigInt(x.tier)));
  const a = allocateBurns(ws, C, KEEPER_TIP_T * 10n, limitGate(limit, (i) => `w${sp[i].wallet}`));
  return { ws, a };
};
const arrivalItem = (w: ReturnType<typeof allocItem>) => `${w.senior}/${w.lockedLp}/${w.bandPaid}/${w.leafTier}/${w.converted}`;
const allocOf = (w: ReturnType<typeof allocItem>) => w.basePaid + w.bandPaid;

test("A13.2 fitClaim: the largest a with a + one keeper tip per threshold reached ≤ room", () => {
  const T = KEEPER_TIP_T;
  const M = 10n * T;
  assert.strictEqual(fitClaim(0n, [M]), 0n);
  assert.strictEqual(fitClaim(M - 1n, [M, M]), M - 1n, "below the minimum no tip is set aside");
  assert.strictEqual(fitClaim(M + T, [M, M]), M - 1n, "M + T cannot carry two tips");
  assert.strictEqual(fitClaim(M + 2n * T, [M, M]), M, "exactly two tips");
  assert.strictEqual(fitClaim(M + 2n * T + 5n, [M]), M + T + 5n);
  assert.strictEqual(fitClaim(7n, []), 7n);
  assert.strictEqual(fitClaim(5n * M, [3n, M]), 5n * M - 2n * T);
  for (let room = 0n; room < 3n * M; room += 977_777n) {
    for (const th of [[M], [M, M], [M / 2n, M], [1n, M]]) {
      const a = fitClaim(room, th);
      const f = (v: bigint) => v + T * BigInt(th.filter((t) => t <= v).length);
      assert(a >= 0n && f(a) <= room && f(a + 1n) > room, `room ${room} thresholds ${th}: ${a}`);
    }
  }
});

test("A13.2 prefix-stability (allocateBurns with the gate): the first k burns' arrival outcome never depends on burns k+1..n, in shortfall weeks too, and adding later burns never raises an earlier payout", () => {
  let cuts = 0;
  let arrivalCuts = 0;
  a132Sweep(132_001, 6_000, (sp, C, limit, r) => {
    const full = gated(sp, C, limit);
    if (full.a.cut) {
      cuts++;
      if (full.a.cut.stage === "arrival") arrivalCuts++;
    }
    const k = Math.floor(r() * (sp.length + 1));
    const pre = gated(sp.slice(0, k), C, limit);
    for (let i = 0; i < k; i++) {
      assert.strictEqual(arrivalItem(full.ws[i]), arrivalItem(pre.ws[i]), `burn ${i} of ${sp.length} (k ${k}): arrival outcome depends on a later burn`);
      assert(allocOf(full.ws[i]) <= allocOf(pre.ws[i]), `burn ${i}: later burns raised its payout ${allocOf(pre.ws[i])} → ${allocOf(full.ws[i])}`);
    }
    // the literal cut: every claim before the cut whole, the cut one partial, every later one 0
    const c = full.a.cut;
    if (c) {
      assert(c.claim < c.wanted, "the cut claim is below the claim");
      full.ws.forEach((w, i) => {
        if (i > c.kept) assert(c.stage === "leftover" ? w.basePaid + w.bandPaid === w.senior : w.senior === 0n && allocOf(w) === 0n, `burn ${i} after the cut (${c.stage} at ${c.kept}) is paid`);
      });
      if (c.stage === "arrival") assert(full.ws.every((w) => allocOf(w) === w.senior), "an arrival cut cancels the leftover pass");
    }
  });
  assert(cuts > 1_000 && arrivalCuts > 300, `coverage: ${cuts} cuts, ${arrivalCuts} at the arrival stage`);
});

test("A13.2 own size and own tier (allocateBurns with the gate): a larger burn is never paid less, and a mission never takes less at its arrival than the same burn as Launchpad, in shortfall weeks too", () => {
  let cutAtOwn = 0;
  a132Sweep(132_002, 6_000, (sp, C, limit, r) => {
    const base = gated(sp, C, limit);
    const j = Math.floor(r() * sp.length);
    // a larger burn: a few lamports more (the tip and dust edges) or a lot more
    const more = r() < 0.5 ? BigInt(1 + Math.floor(r() * 2_000)) : BigInt(1 + Math.floor(r() * Number(sp[j].lp + 10n ** 8n)));
    const big = gated(sp.map((x, i) => (i === j ? { ...x, lp: x.lp + more } : x)), C, limit);
    const [small, large] = [base.ws[j], big.ws[j]];
    if ((base.a.cut && base.a.cut.kept === j) || (big.a.cut && big.a.cut.kept === j)) cutAtOwn++;
    // across the dust edge (a mission entitled to less than VEST_MIN_ENT is paid as Launchpad, F6) only the lock may move
    const dustEdge = sp[j].tier > 0 && (sp[j].lp * BigInt(sp[j].tier + 1) < KEEPER_TIP_T * 10n) !== ((sp[j].lp + more) * BigInt(sp[j].tier + 1) < KEEPER_TIP_T * 10n);
    if (!dustEdge) {
      assert(allocOf(large) >= allocOf(small), `burn ${j} +${more}: paid ${allocOf(small)} → ${allocOf(large)}`);
      assert(large.senior >= small.senior, `burn ${j} +${more}: arrival ${small.senior} → ${large.senior}`);
    }
    // own tier: the same burn as Launchpad takes at most what it takes as a mission at its arrival
    if (sp[j].tier > 0) {
      const lp = gated(sp.map((x, i) => (i === j ? { ...x, tier: 0 } : x)), C, limit);
      assert(base.ws[j].senior >= lp.ws[j].senior, `burn ${j}: as a mission ${base.ws[j].senior} < as Launchpad ${lp.ws[j].senior}`);
      for (let i = 0; i < j; i++) assert.strictEqual(arrivalItem(lp.ws[i]), arrivalItem(base.ws[i]), `burn ${j}'s tier moved burn ${i}`);
    }
  });
  assert(cutAtOwn > 300, `coverage: ${cutAtOwn} cases with the cut on the burn itself`);
});

test("A13.2 the pool never breaks: with the gate, Σ target + the keeper tips of the leaves at the minimum never exceed the limit", () => {
  a132Sweep(132_003, 6_000, (sp, C, limit) => {
    const { ws } = gated(sp, C, limit);
    const t = new Map<string, bigint>();
    ws.forEach((w, i) => {
      const add = (tier: number, v: bigint) => v > 0n && t.set(`w${sp[i].wallet}:${tier}`, (t.get(`w${sp[i].wallet}:${tier}`) ?? 0n) + v);
      add(w.leafTier, w.lockedLp + w.bandPaid);
      add(0, w.basePaid - w.lockedLp);
    });
    const scores = [...t.values()];
    assert(plannedOutflow(scores, sum(scores)) <= limit, "planned outflow above the limit");
    assert(sum(ws.map(allocOf)) <= C, "paid above C");
  });
});

test("A13.2 epoch level: shortfall weeks keep C, the schedule and the arrival outcome of every burn before the cut; verify recomputes the cut", () => {
  const { e1, f } = a9s6(2);
  const s = f.capacity.shortfall!;
  assert.deepStrictEqual(Object.keys(s).sort(), ["claim", "kept", "planned", "stage", "wanted"]);
  assert.deepStrictEqual([s.stage, s.kept, f.capacity.cash, f.capacity.tranche], ["arrival", 2, (80n * XNT).toString(), (80n * XNT / 7n).toString()]);
  assert.strictEqual(BigInt(f.burns[2].senior) <= BigInt(s.claim) && BigInt(s.claim) < BigInt(s.wanted), true);
  assert(BigInt(s.planned) > BigInt(f.totalScore), "the plan pays more than the cut week");
  assert.strictEqual(BigInt(f.capacity.left), BigInt(f.capacity.cash) - BigInt(f.capacity.base) - BigInt(f.capacity.bandPaid));
  // a tampered cut is refused: the recomputation is the only valid file
  for (const edit of [(g: EpochFileV3) => (g.capacity.shortfall!.kept = 1), (g: EpochFileV3) => (g.capacity.shortfall!.claim = "1"), (g: EpochFileV3) => (g.capacity.shortfall = null)]) {
    const g = clone(f);
    edit(g);
    g.dataHash = dataHashV3(g);
    assert(verifyEpochV3(g, e1).some((e) => /capacity does not match the recomputation/.test(e)), "a tampered shortfall record verifies");
  }
});

test("D-47: the build keeps the oracle allowance (the Epoch rent back + at most 0.05 XNT, at most a tenth of the bound) inside the 10% bound", () => {
  // the program's constants and the Epoch account size (constants.rs, forge.rs epoch_account_size_is_pinned)
  const prog = (f: string): string => require("fs").readFileSync(require("path").join(__dirname, "../../programs/moon-forge/src", f), "utf8");
  // the mirror lines need the program source of the final upgrade (it has instructions/seat.rs); a tree that still carries
  // the live v2 source (main before the review commit) skips them and says so; the rest of the test needs no program file
  if (require("fs").existsSync(require("path").join(__dirname, "../../programs/moon-forge/src/instructions/seat.rs"))) {
    for (const line of ["pub const ORACLE_TOPUP_TARGET: u64 = 250_000_000;", "pub const ORACLE_TOPUP_MAX: u64 = 50_000_000;", "pub const ORACLE_ALLOWANCE_BOUND_BPS: u64 = 1_000;"]) {
      assert.ok(prog("constants.rs").includes(line), `mirrors constants.rs: ${line}`);
    }
    assert.ok(prog("instructions/forge.rs").includes(`assert_eq!(8 + Epoch::INIT_SPACE, ${EPOCH_ACCOUNT_SIZE});`), "mirrors the Epoch account size");
  } else console.log("  (D-47: the live v2 program source is in this tree: the constants.rs and forge.rs mirror lines are skipped)");
  assert.deepStrictEqual([ORACLE_TOPUP_TARGET, ORACLE_TOPUP_MAX, ORACLE_ALLOWANCE_BOUND_BPS, EPOCH_RENT, ORACLE_ALLOWANCE_MAX], [250_000_000n, 50_000_000n, 1_000n, 2_331_600n, 52_331_600n]);
  // forge.rs oracle_allowance, line for line
  const minB = (a: bigint, b: bigint) => (a < b ? a : b);
  const sat = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
  const share = (bound: bigint) => (bound * ORACLE_ALLOWANCE_BOUND_BPS) / 10_000n;
  const programAllowance = (bound: bigint, budget: bigint, rent: bigint, balance: bigint) =>
    minB(rent + minB(sat(ORACLE_TOPUP_TARGET, balance + rent), ORACLE_TOPUP_MAX), minB(sat(bound, budget), share(bound)));
  assert.strictEqual(oracleAllowanceMax(100n * XNT), ORACLE_ALLOWANCE_MAX);
  assert.strictEqual(oracleAllowanceMax(10n * ORACLE_ALLOWANCE_MAX), ORACLE_ALLOWANCE_MAX, "the share binds below a bound of 0.523 XNT only");
  assert.strictEqual(oracleAllowanceMax(10n * ORACLE_ALLOWANCE_MAX - 10n), ORACLE_ALLOWANCE_MAX - 1n);
  assert.strictEqual(buildLimit(XNT / 2n), 49_750_000n - 4_975_000n, "a small pool keeps 90% of its bound for the burners");
  // every pool the publication accepts (within the 0.5% rebuild drift of the build reading): a build at its limit
  // (Σ score + tips = buildLimit) still leaves the whole allowance the program can pay, so it is never cut and
  // budget + tips + allowance ≤ 10% of the pool at publication; the budget itself is never lowered
  let seed = 0x0d47n;
  const rnd = (m: bigint) => (seed = (seed * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % 2n ** 64n) % m;
  const pools = [1n, 999n, 10_000_000n, XNT / 2n, XNT, 5n * XNT, 5_233_160_000n, 5_233_170_000n, 6n * XNT, 1_000n * XNT, 140_000n * XNT];
  for (let k = 0; k < 4_000; k++) pools.push(1n + rnd(200_000n * XNT));
  for (const F of pools) {
    const L = buildLimit(F);
    assert(L >= 0n && L <= (F * 995n) / 10_000n, `F ${F}: the limit`);
    for (const P of [F - (F * 50n) / 10_000n, F, F + (F * 50n) / 10_000n]) {
      const bound = (P * 1_000n) / 10_000n;
      const tips = L > 0n ? rnd(L + 1n) : 0n; // the part of the room the keeper tips take, the budget takes the rest
      const budget = L - tips;
      if (budget === 0n) continue; // PoolEmpty: nothing is published
      for (const balance of [0n, rnd(ORACLE_TOPUP_TARGET), ORACLE_TOPUP_TARGET + rnd(XNT)]) {
        const a = programAllowance(bound, budget, EPOCH_RENT, balance);
        const whole = minB(EPOCH_RENT + minB(sat(ORACLE_TOPUP_TARGET, balance + EPOCH_RENT), ORACLE_TOPUP_MAX), share(bound));
        assert.strictEqual(a, whole, `F ${F}, P ${P}: the allowance is never cut by the budget`);
        assert(budget + tips + a <= bound, `F ${F}, P ${P}: inside the 10% bound`);
        assert(a <= oracleAllowanceMax(bound) && a <= ORACLE_ALLOWANCE_MAX);
      }
    }
  }
  // rebuildReason counts the allowance: a planned outflow that fills the whole 10% leaves no room for it
  const p1 = build({ epoch: 1, endTs: T0 + WEEK, F: 1_000n * XNT, burns: [burn(W(1), T0 + HOUR, 1_000n)] }, null);
  const planned = plannedOutflow(p1.leaves.map((l) => BigInt(l.score)), BigInt(p1.totalScore));
  const tight = clone(p1);
  tight.freePool.lamports = (10n * planned).toString();
  assert.match(rebuildReason(tight, 10n * planned) ?? "", /plus the oracle allowance \d+ above 10% of the free pool/);
  tight.freePool.lamports = (10n * (planned + ORACLE_ALLOWANCE_MAX)).toString();
  assert.strictEqual(rebuildReason(tight, 10n * (planned + ORACLE_ALLOWANCE_MAX)), null, "room for the plan and the allowance");
  // a v3 file packed to 10% without the allowance's room does not verify
  const packed = clone(p1);
  packed.freePool.lamports = (10n * planned).toString();
  packed.dataHash = dataHashV3(packed);
  assert(verifyEpochV3(packed, null).some((e) => /less the rebuild drift and the oracle allowance/.test(e)), "a file without the allowance's room verifies");
});

console.log(`rewards v3 unit tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
