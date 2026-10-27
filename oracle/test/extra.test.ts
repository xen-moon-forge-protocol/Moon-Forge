/**
 * Extra epoch (two-pot NFT model, amendment A10) tests, no network:
 *   units (need, use, release, leaf bytes, tree, data hash), the REPORT §C3 worked week, eligibility (origin,
 *   two snapshots, season), heartbeat, MIN_PAY, bounds, chain rules, verify round trip and tamper detection, a
 *   real-engine base file, and a property suite on random worlds: a sybil split never helps, per-XNT parity across
 *   tiers, cap by need, burning more never pays less, base pot untouched, rate ≤ 2x, bounds, deterministic and
 *   byte-identical on shuffled input, a transfer or recycle inside the window gives no claim.
 *   npm test                         (EXTRA_WORLDS=3000 npm test for a longer run)
 */
import assert from "assert";
import bs58 from "bs58";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { verifyProof } from "../src/merkle";
import { buildEpochFileV3, BurnInputV3, dataHashV3, EpochFileV3, EpochInputsV3, ORIGIN_DROP, ORIGIN_FORGED, ORIGIN_GENESIS } from "../src/rewards";
import {
  budgetMaxOf, buildExtraFile, computeExtraEpoch, dataHashExtra, EMPTY_ROOT, EXTRA_BACKING_BOUND_BPS, EXTRA_LEAF_DOMAIN, EXTRA_MAX_LEAVES, EXTRA_RELEASE_BPS,
  extraClaimArgs, ExtraFileV1, extraLeaf, ExtraPoolInfo, extraPublishArgs, ExtraSnapshot, ExtraSnapshotRecord, extraTree, MIN_PAY, NEED_BPS, needOf,
  pinnedExtraError, pricePaid, releaseOf, RHO_MAX_BPS, SEASON_WEEKS, seasonAfterOf, uncovered, verifyExtraChainLink, verifyExtraFile, verifyPublishedExtra,
  baseNftTermsError, needWeeksOf, preUpgradePotError, backingBoundOf, buildSkipExtraFile, skipExtraEpoch, skipReasonOf, NEED_WEEK_SLACK,
  checkedInitMark, EXTRA_EXCLUDE_PRE_UPGRADE, isPreUpgrade,
} from "../src/extra";
import { catchUpExtrasV3, extraCreatedAtV3, extraInitV3, extraPoolV3, ExtraRecoverySourcesV3, rebuildExtraV3, buildExtraAfterBaseV3 } from "../src/flow-v3";
import { EXTRA_MAX_WEEKS } from "../src/extra";
import { PDA } from "../src/x1";
import { extraBoundV3, extraPublishArgsError, extraPublishErrorV3, extraWeeksMaxV3, initExtraMarkOfTxV3, PDA_V3, programV3, publishExtraEpochIxV3 } from "../src/x1-v3";

let passed = 0;
let failed = 0;
/** async tests (A13.6 / A13.7) run alongside the synchronous ones; the summary waits for them */
const pending: Promise<void>[] = [];
function testAsync(name: string, fn: () => Promise<void>) {
  pending.push(fn().then(() => void passed++, (e) => {
    failed++;
    console.error(`FAIL ${name}\n  ${(e as Error).stack ?? String(e)}`);
  }));
}
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
const HOUR = 3_600;
const DAY = 86_400;
const WEEK = 7 * DAY;
const T0 = 1_790_208_000;
const BPS = 10_000n;
/** ArtifactRecord backing per tier (50% of the 10 / 25 / 60 / 200 XNT price) */
const BACKING = [5n * XNT, 12_500_000_000n, 30n * XNT, 100n * XNT];

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
const sig = (i: number) => {
  const b = new Uint8Array(64);
  b[0] = i & 255;
  b[1] = (i >> 8) & 255;
  b[63] = 9;
  return bs58.encode(b);
};
const iso = (ts: number) => new Date(ts * 1000).toISOString();
/** rewards.ts MIN_WINDOW: 6 days − 6 h */
const MIN_WINDOW_T = 6 * 86_400 - 6 * 3_600;
const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const abs = (x: bigint) => (x < 0n ? -x : x);
/** JSON clone of a file (strings only, like the published form) */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
/** BigInt-safe serialisation of a test world (inputs are bigint; files are strings) */
const stringifyBig = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x));

/** A v3 base file stub carrying exactly what the extra reads (version, epoch, hashes, window, burns), hashed like a real one. */
interface BaseBurn {
  x1: string;
  base: bigint;
  lp?: bigint;
  basePaid?: bigint;
  tier?: number;
}
interface BaseOpt {
  epoch: number;
  endTs: number;
  startTs?: number;
  burns?: BaseBurn[];
  prev?: EpochFileV3 | null;
  /** the base snapshot (A12/X2: S(n) is exactly this slot and these records); none = an empty snapshot at slot 0 */
  snapshot?: { slot: number; records: ExtraSnapshotRecord[] };
  v3FirstEpoch?: number;
}
/** deterministic: the same (epoch, burns, prev) always gives the same base file, so a world can be rebuilt and compared */
function mkBase(o: BaseOpt): EpochFileV3 {
  const startTs = o.startTs ?? o.endTs - WEEK;
  const burns = (o.burns ?? []).map((b, i) => {
    const lp = b.lp ?? (b.base * 12_500n) / BPS;
    const id = o.epoch * 1_000_000 + i;
    return {
      chainId: 10, txHash: "0x" + id.toString(16).padStart(64, "0"), logIndex: i, blockNumber: 1_000 + i, missionId: String(id), pilot: "0x" + "ab".repeat(20),
      amountWei: "0", tier: b.tier ?? 0, x1: b.x1, timestamp: startTs + i, base: b.base.toString(), lp: lp.toString(), basePaid: (b.basePaid ?? 0n).toString(),
    };
  });
  const snapshot = {
    slot: o.snapshot?.slot ?? 0,
    records: (o.snapshot?.records ?? []).map((r) => ({ asset: r.asset, tier: r.tier, owner: r.owner, backing: r.backing, origin: r.origin })).sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0)),
  };
  const body = {
    version: 3, programId: PROGRAM, epoch: o.epoch, createdAt: iso(o.endTs), v3FirstEpoch: o.v3FirstEpoch ?? 1, prevDataHash: o.prev ? o.prev.dataHash : null, kBps: 12_500,
    window: { startTs, endTs: o.endTs, days: 7, dayOrigin: startTs }, snapshot, burns, leaves: [], targets: [], totalScore: "0", root: "",
  } as unknown as EpochFileV3;
  return { ...body, dataHash: dataHashV3(body), proofs: {} };
}

interface RecOpt {
  origin?: number;
  forgedAt?: number;
  backing?: bigint;
  sig?: number;
}
const rec = (asset: string, tier: number, owner: string, o: RecOpt = {}): ExtraSnapshotRecord => ({
  asset, tier, owner, backing: (o.backing ?? BACKING[tier]).toString(), origin: o.origin ?? ORIGIN_FORGED, forgedAt: o.forgedAt ?? T0 - DAY, signature: sig(o.sig ?? 1),
});
const snap = (slot: number, blockTime: number, records: ExtraSnapshotRecord[]): ExtraSnapshot => ({ slot, blockTime, records });
/** OD-9: the pot's init_extra mark of the test worlds, long before every Artifact's forgedAt (nothing is pre-upgrade) */
const INIT = { ts: 1_000_000_000, tx: sig(65_000) };
const pool = (open: bigint, createdAtTs: number, lamports = open, slot = 1): ExtraPoolInfo => ({ open: open.toString(), lamports: lamports.toString(), slot, createdAt: iso(createdAtTs), init: INIT });

/** base epochs 1..k from T0 with the extra chained on top; week i has snapshot S(i) at endTs_i and pot X_i */
interface Week {
  records: ExtraSnapshotRecord[];
  burns?: BaseBurn[];
  X?: bigint;
}
function run(weeks: Week[]): { bases: EpochFileV3[]; extras: ExtraFileV1[] } {
  const bases: EpochFileV3[] = [];
  const extras: ExtraFileV1[] = [];
  weeks.forEach((w, i) => {
    const epoch = i + 1;
    const endTs = T0 + epoch * WEEK;
    const base = mkBase({ epoch, endTs, startTs: i ? bases[i - 1].window.endTs + 60 : undefined, burns: w.burns, prev: i ? bases[i - 1] : null, snapshot: { slot: 1_000 * epoch, records: w.records } });
    const extra = buildExtraFile(base, i ? extras[i - 1] : null, snap(1_000 * epoch, endTs, w.records), pool(w.X ?? 0n, endTs + 30, w.X ?? 0n, 1_000 * epoch + 5));
    bases.push(base);
    extras.push(clone(extra));
  });
  return { bases, extras };
}
const rowOf = (f: ExtraFileV1, wallet: string) => f.rows.find((r) => r.wallet === wallet);
const payOf = (f: ExtraFileV1, wallet: string) => BigInt(rowOf(f, wallet)?.pay ?? "0");

// ── 1. policy constants and units ──────────────────────────────────────────────────────────────
test("policy constants are the adopted ones (REPORT §A3, §B2.8)", () => {
  assert.deepStrictEqual([NEED_BPS, RHO_MAX_BPS, MIN_PAY, EXTRA_RELEASE_BPS, EXTRA_BACKING_BOUND_BPS, EXTRA_MAX_LEAVES, SEASON_WEEKS], [100n, 20_000n, 1_000_000n, 800n, 400n, 1_000, 52]);
  assert.strictEqual(EXTRA_LEAF_DOMAIN.toString(), "MOONFORGE_V3_EXTRA");
  assert.strictEqual(EMPTY_ROOT, "0".repeat(64));
  assert.strictEqual(pinnedExtraError(3, null), null);
  assert.match(pinnedExtraError(4, 3)!, /pinned at 3/);
});

test("price paid and weekly need per tier: Lunar 0.10, Cosmic 0.25, Solar 0.60, Void 2.00 XNT; Genesis and Drops 0", () => {
  const r = (tier: number, origin = ORIGIN_FORGED) => ({ origin, backing: BACKING[tier].toString() });
  assert.deepStrictEqual([0, 1, 2, 3].map((t) => pricePaid(r(t))), [10n * XNT, 25n * XNT, 60n * XNT, 200n * XNT]);
  assert.deepStrictEqual([0, 1, 2, 3].map((t) => needOf(r(t))), [100_000_000n, 250_000_000n, 600_000_000n, 2n * XNT]);
  assert.strictEqual(needOf(r(3, ORIGIN_GENESIS)), 0n);
  assert.strictEqual(needOf(r(0, ORIGIN_DROP)), 0n);
  assert.strictEqual(needOf({ origin: ORIGIN_FORGED, backing: "7" }), 0n, "floor: 14 × 100 / 10,000 = 0");
  assert.throws(() => needOf({ origin: ORIGIN_FORGED, backing: "0x10" }), /canonical unsigned integer/);
});

test("uncovered use: base × (lp − basePaid) / lp, floored; 0 when the base pot paid the whole Launchpad layer", () => {
  const u = (base: bigint, lp: bigint, paid: bigint) => uncovered({ base: base.toString(), lp: lp.toString(), basePaid: paid.toString() });
  assert.strictEqual(u(XNT, 1_250_000_000n, 0n), XNT);
  assert.strictEqual(u(XNT, 1_250_000_000n, 250_000_000n), 800_000_000n);
  assert.strictEqual(u(XNT, 1_250_000_000n, 1_250_000_000n), 0n);
  assert.strictEqual(u(XNT, 1_250_000_000n, 2n * XNT), 0n, "over-paid (impossible, but never negative)");
  assert.strictEqual(u(XNT, 0n, 0n), 0n, "lp 0");
  assert.strictEqual(u(7n, 8n, 5n), 2n, "7 × 3 / 8 = 2.625 → 2");
  assert.strictEqual(u(0n, 0n, 0n), 0n);
});

test("release and budget max: R = 8% of X, B = min(R, 2W), 0 when W = 0", () => {
  assert.strictEqual(releaseOf(80n * XNT), 6_400_000_000n);
  assert.strictEqual(releaseOf(12n), 0n);
  assert.strictEqual(budgetMaxOf(6_400_000_000n, 2_900_000_000n), 5_800_000_000n);
  assert.strictEqual(budgetMaxOf(3_200_000_000n, 2_900_000_000n), 3_200_000_000n);
  assert.strictEqual(budgetMaxOf(6_400_000_000n, 0n), 0n);
  assert.strictEqual(seasonAfterOf(T0), T0 - 52 * WEEK);
});

test("leaf bytes: keccak(domain ‖ epoch u64 LE ‖ index u32 LE ‖ wallet ‖ amount u64 LE); proofs verify on the sorted-pair tree", () => {
  const { keccak_256 } = require("@noble/hashes/sha3") as typeof import("@noble/hashes/sha3");
  const epoch = 3;
  const amount = 123_456_789n;
  const manual = Buffer.concat([
    Buffer.from("MOONFORGE_V3_EXTRA"), Buffer.from([3, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([2, 0, 0, 0]), new PublicKey(W(1)).toBuffer(),
    Buffer.from([0x15, 0xcd, 0x5b, 0x07, 0, 0, 0, 0]),
  ]);
  assert.strictEqual(extraLeaf(epoch, 2, W(1), amount).toString("hex"), Buffer.from(keccak_256(manual)).toString("hex"));
  assert.throws(() => extraLeaf(epoch, -1, W(1), amount), /u32/);
  assert.throws(() => extraLeaf(epoch, 0, W(1), 2n ** 64n), /u64/);
  const leaves = [W(1), W(2), W(3)].sort().map((w, i) => ({ index: i, wallet: w, amount: (XNT * BigInt(i + 1)).toString() }));
  const t = extraTree(epoch, leaves);
  assert.strictEqual(Object.keys(t.proofs).length, 3);
  for (const l of leaves) assert(verifyProof(t.proofs[l.wallet].map((h) => Buffer.from(h, "hex")), Buffer.from(t.root, "hex"), extraLeaf(epoch, l.index, l.wallet, BigInt(l.amount))));
  assert(!verifyProof(t.proofs[leaves[0].wallet].map((h) => Buffer.from(h, "hex")), Buffer.from(t.root, "hex"), extraLeaf(epoch, 1, leaves[0].wallet, BigInt(leaves[0].amount))), "the index is part of the leaf");
  assert.deepStrictEqual(extraTree(epoch, []), { root: EMPTY_ROOT, proofs: {} });
  assert.strictEqual(extraTree(epoch, [leaves[0]]).root, extraLeaf(epoch, 0, leaves[0].wallet, BigInt(leaves[0].amount)).toString("hex"), "a single leaf is the root");
});

// ── 2. the REPORT §C3 week ─────────────────────────────────────────────────────────────────────
const ANA = W(11);
const BRUNO = W(12);
const CARLA = W(13);
const DAVI = W(14);
const EVA = W(15);
const EXAMPLE = [rec(ASSET(1), 0, ANA), rec(ASSET(2), 1, BRUNO), rec(ASSET(3), 2, CARLA), rec(ASSET(4), 3, DAVI)];
const exampleBurns: BaseBurn[] = [
  { x1: EVA, base: 400_000_000n, basePaid: 500_000_000n },
  { x1: ANA, base: 100_000_000n },
  { x1: BRUNO, base: 200_000_000n },
  { x1: CARLA, base: 800_000_000n, lp: XNT, basePaid: 250_000_000n },
  { x1: DAVI, base: 3n * XNT },
];

test("REPORT §C3 week at X = 80: rate at the 2x cap, 0.60 XNT stays in the pot, Eva (no NFT) gets nothing", () => {
  const { bases, extras } = run([{ records: EXAMPLE }, { records: EXAMPLE, burns: exampleBurns, X: 80n * XNT }]);
  const f = extras[1];
  assert.deepStrictEqual(f.rows.map((r) => [r.wallet, r.need, r.use, r.counted, r.pay]).sort(), [
    [ANA, "100000000", "100000000", "100000000", "200000000"],
    [BRUNO, "250000000", "200000000", "200000000", "400000000"],
    [CARLA, "600000000", "600000000", "600000000", "1200000000"],
    [DAVI, "2000000000", "3000000000", "2000000000", "4000000000"],
  ].sort());
  assert.deepStrictEqual([f.totals.release, f.totals.counted, f.totals.budgetMax, f.totals.budget, f.totals.unpaid], ["6400000000", "2900000000", "5800000000", "5800000000", "600000000"]);
  assert.strictEqual(rowOf(f, EVA), undefined);
  assert.strictEqual(f.leaves.length, 4);
  assert.deepStrictEqual(f.leaves.map((l) => l.wallet), [ANA, BRUNO, CARLA, DAVI].sort());
  assert.deepStrictEqual(f.leaves.map((l) => l.index), [0, 1, 2, 3]);
  assert.deepStrictEqual(verifyExtraFile(f, bases[1], extras[0]), []);
  // the same world rebuilt from scratch gives the same bytes
  const again = run([{ records: EXAMPLE }, { records: EXAMPLE, burns: exampleBurns, X: 80n * XNT }]);
  assert.strictEqual(JSON.stringify(again.extras[1]), JSON.stringify(f));
  assert.deepStrictEqual(verifyExtraFile(f, again.bases[1], again.extras[0]), []);
});

test("REPORT §C3 week at X = 40: the rate falls to 1.10x (Ana 0.11, Bruno 0.22, Carla 0.66, Davi 2.21)", () => {
  const { extras } = run([{ records: EXAMPLE }, { records: EXAMPLE, burns: exampleBurns, X: 40n * XNT }]);
  const f = extras[1];
  assert.deepStrictEqual([payOf(f, ANA), payOf(f, BRUNO), payOf(f, CARLA), payOf(f, DAVI)], [110_344_827n, 220_689_655n, 662_068_965n, 2_206_896_551n]);
  assert.strictEqual(f.totals.budgetMax, "3200000000");
  assert.strictEqual(BigInt(f.totals.budget), 3_199_999_998n, "two lamports of rounding dust stay in the pot");
  assert.strictEqual(f.totals.unpaid, "2");
});

// ── 3. eligibility, season, heartbeat, MIN_PAY ─────────────────────────────────────────────────
test("first extra epoch: no S(n−1), so nothing is eligible; a heartbeat with budget 0 and the all-zero root", () => {
  const { bases, extras } = run([{ records: EXAMPLE, burns: exampleBurns, X: 80n * XNT }]);
  const f = extras[0];
  assert.deepStrictEqual([f.epoch, f.firstEpoch, f.prevDataHash, f.rows.length, f.leaves.length, f.totals.budget, f.root], [1, 1, null, 0, 0, "0", EMPTY_ROOT]);
  assert.strictEqual(f.excluded.length, 4);
  assert(f.excluded.every((e) => e.reason === "new"));
  assert.strictEqual(f.totals.release, "6400000000", "R is known even when nothing is paid");
  assert.deepStrictEqual(f.proofs, {});
  assert.deepStrictEqual(verifyExtraFile(f, bases[0], null), []);
  assert.deepStrictEqual(extraPublishArgs(f), { epoch: 1, root: EMPTY_ROOT, dataHash: f.dataHash, total: "0", leaves: 0, weeks: 1 });
});

test("eligibility: FORGED only, alive in both snapshots with the same owner; new and moved are excluded with a reason, gone is absent", () => {
  const H = W(21);
  const K = W(22);
  const open = [
    rec(ASSET(1), 3, H), rec(ASSET(2), 0, H, { origin: ORIGIN_GENESIS }), rec(ASSET(3), 0, H, { origin: ORIGIN_DROP }), rec(ASSET(4), 1, H), rec(ASSET(5), 2, H),
    rec(ASSET(6), 0, K),
  ];
  const close = [
    rec(ASSET(1), 3, H, { sig: 2 }), rec(ASSET(2), 0, H, { origin: ORIGIN_GENESIS }), rec(ASSET(3), 0, H, { origin: ORIGIN_DROP }), rec(ASSET(4), 1, K, { sig: 3 }),
    rec(ASSET(7), 0, H, { forgedAt: T0 + WEEK + DAY }), rec(ASSET(6), 0, K, { sig: 4 }),
  ];
  const burns: BaseBurn[] = [{ x1: H, base: 10n * XNT }, { x1: K, base: 10n * XNT }];
  const { bases, extras } = run([{ records: open }, { records: close, burns, X: 1_000n * XNT }]);
  const f = extras[1];
  assert.deepStrictEqual(f.excluded, [{ asset: ASSET(4), reason: "moved" }, { asset: ASSET(7), reason: "new" }].sort((a, b) => (a.asset < b.asset ? -1 : 1)));
  assert.deepStrictEqual(rowOf(f, H)!.artifacts.map((a) => a.asset), [ASSET(1)], "Void only: Genesis and Drop never count, the Solar was recycled, the Cosmic moved to K");
  assert.deepStrictEqual([rowOf(f, H)!.need, rowOf(f, H)!.counted, rowOf(f, H)!.pay], ["2000000000", "2000000000", "4000000000"]);
  assert.deepStrictEqual(rowOf(f, K)!.artifacts.map((a) => a.asset), [ASSET(6)], "K's own Lunar counts; the Cosmic it received counts from next week");
  assert.deepStrictEqual([rowOf(f, K)!.need, rowOf(f, K)!.pay], ["100000000", "200000000"]);
  assert.strictEqual(f.totals.eligibleArtifacts, 2);
  assert.strictEqual(f.totals.eligibleBacking, (105n * XNT).toString());
  // the next week: the Cosmic now counts for K, the new Lunar for H
  const close3 = close.map((r) => ({ ...r, signature: sig(9) }));
  const base3 = mkBase({ epoch: 3, endTs: T0 + 3 * WEEK, startTs: bases[1].window.endTs + 60, burns, prev: bases[1], snapshot: { slot: 3_000, records: close3 } });
  const f3 = buildExtraFile(base3, f, snap(3_000, T0 + 3 * WEEK, close3), pool(1_000n * XNT, T0 + 3 * WEEK + 30));
  assert.deepStrictEqual(rowOf(f3, K)!.artifacts.map((a) => a.asset).sort(), [ASSET(4), ASSET(6)].sort());
  assert.deepStrictEqual(rowOf(f3, H)!.artifacts.map((a) => a.asset).sort(), [ASSET(1), ASSET(7)].sort());
  assert.deepStrictEqual(f3.excluded, []);
  assert.deepStrictEqual(verifyExtraFile(f3, base3, f), []);
});

test("season: an Artifact counts while forgedAt + 52 weeks > the week's start; the boundary week is out", () => {
  const H = W(31);
  const startTs2 = T0 + WEEK + 60; // run(): week 2 starts 60 s after base 1's end
  const edge = (forgedAt: number) => {
    const records = [rec(ASSET(1), 3, H, { forgedAt })];
    const { extras } = run([{ records }, { records, burns: [{ x1: H, base: 5n * XNT }], X: 1_000n * XNT }]);
    return extras[1];
  };
  const out = edge(startTs2 - SEASON_WEEKS * WEEK);
  assert.deepStrictEqual(out.excluded, [{ asset: ASSET(1), reason: "season" }]);
  assert.deepStrictEqual([out.rows.length, out.totals.budget], [0, "0"]);
  const inSeason = edge(startTs2 - SEASON_WEEKS * WEEK + 1);
  assert.strictEqual(payOf(inSeason, H), 4n * XNT);
  assert.strictEqual(inSeason.window.seasonAfter, startTs2 - SEASON_WEEKS * WEEK);
});

test("MIN_PAY: a pay below 0.001 XNT becomes 0, is no leaf and stays in the pot", () => {
  const H = W(41);
  const K = W(42);
  const records = [rec(ASSET(1), 0, H), rec(ASSET(2), 3, K)];
  // H's counted use is 1 lamport; the rate is at the 2x cap, so its pay is 2 lamports → dropped
  const { bases, extras } = run([{ records }, { records, burns: [{ x1: H, base: 1n }, { x1: K, base: 1n * XNT }], X: 1_000n * XNT }]);
  const f = extras[1];
  assert.deepStrictEqual([rowOf(f, H)!.counted, rowOf(f, H)!.pay], ["1", "0"]);
  assert.strictEqual(payOf(f, K), 2n * XNT);
  assert.deepStrictEqual(f.leaves.map((l) => l.wallet), [K]);
  assert.strictEqual(f.totals.budget, (2n * XNT).toString());
  assert.strictEqual(BigInt(f.totals.unpaid), 80n * XNT - 2n * XNT);
  assert.deepStrictEqual(verifyExtraFile(f, bases[1], extras[0]), []);
  // exactly MIN_PAY is paid
  const g = run([{ records }, { records, burns: [{ x1: H, base: 500_000n }, { x1: K, base: 1n * XNT }], X: 1_000n * XNT }]).extras[1];
  assert.strictEqual(payOf(g, H), MIN_PAY);
});

test("heartbeat: X = 0 (before init_extra) gives R = 0 and budget 0 even with eligible use; the file still verifies", () => {
  const { bases, extras } = run([{ records: EXAMPLE }, { records: EXAMPLE, burns: exampleBurns, X: 0n }]);
  const f = extras[1];
  assert.deepStrictEqual([f.totals.release, f.totals.counted, f.totals.budgetMax, f.totals.budget, f.leaves.length, f.root], ["0", "2900000000", "0", "0", 0, EMPTY_ROOT]);
  assert.strictEqual(f.rows.length, 4, "the rows still show the need and the counted use");
  assert.deepStrictEqual(verifyExtraFile(f, bases[1], extras[0]), []);
});

test("rate cap: 2W > R pays R pro rata (rho < 2); 2W ≤ R pays exactly 2 × counted", () => {
  const H = W(51);
  const K = W(52);
  const records = [rec(ASSET(1), 3, H), rec(ASSET(2), 3, K)];
  const burns: BaseBurn[] = [{ x1: H, base: 2n * XNT }, { x1: K, base: 1n * XNT }];
  const tight = run([{ records }, { records, burns, X: 30n * XNT }]).extras[1]; // R = 2.4, W = 3
  assert.deepStrictEqual([payOf(tight, H), payOf(tight, K)], [1_600_000_000n, 800_000_000n]);
  assert.strictEqual(tight.totals.budget, tight.totals.release);
  const loose = run([{ records }, { records, burns, X: 100n * XNT }]).extras[1]; // R = 8, W = 3
  assert.deepStrictEqual([payOf(loose, H), payOf(loose, K)], [4n * XNT, 2n * XNT]);
  assert.strictEqual(loose.totals.unpaid, (2n * XNT).toString());
});

// ── 4. chain rules and refused inputs ──────────────────────────────────────────────────────────
test("chain rules: base hash, base version, prev epoch, prev tie to the base's previous epoch, snapshot order, pot reading", () => {
  const { bases, extras } = run([{ records: EXAMPLE }, { records: EXAMPLE, burns: exampleBurns, X: 80n * XNT }]);
  const [b1, b2] = bases;
  const [x1] = extras;
  const endTs = b2.window.endTs;
  const ok = () => buildExtraFile(b2, x1, snap(2_000, endTs, EXAMPLE), pool(80n * XNT, endTs + 30, 80n * XNT, 2_005));
  assert.strictEqual(ok().dataHash, extras[1].dataHash, "the same inputs (run() records pool slot 2005) give the same hash");
  assert.notStrictEqual(buildExtraFile(b2, x1, snap(2_000, endTs, EXAMPLE), pool(80n * XNT, endTs + 30)).dataHash, extras[1].dataHash, "the pool slot is part of the hashed body");
  const badBase = clone(b2);
  badBase.burns[1].basePaid = "1";
  assert.throws(() => buildExtraFile(badBase, x1, snap(2_000, endTs, EXAMPLE), pool(80n * XNT, endTs + 30)), /does not match its own dataHash/);
  assert.throws(() => buildExtraFile({ ...clone(b2), version: 2 } as unknown as EpochFileV3, x1, snap(2_000, endTs, EXAMPLE), pool(80n * XNT, endTs + 30)), /not a v3 epoch file/);
  // X4: without a previous extra file only the first v3 epoch starts the history (a restart would withhold a week)
  assert.throws(() => buildExtraFile(b2, null, snap(2_000, endTs, EXAMPLE), pool(80n * XNT, endTs + 30)), /never restarted/);
  const b2first = mkBase({ epoch: 2, endTs, startTs: b1.window.endTs + 60, burns: exampleBurns, prev: b1, snapshot: { slot: 2_000, records: EXAMPLE }, v3FirstEpoch: 2 });
  assert.strictEqual(buildExtraFile(b2first, null, snap(2_000, endTs, EXAMPLE), pool(80n * XNT, endTs + 30)).firstEpoch, 2, "the history starts with the v3 history");
  assert.throws(() => buildExtraFile(b1, x1, snap(2_000, endTs, EXAMPLE), pool(80n * XNT, endTs + 30)), /expected 0/);
  const b3 = mkBase({ epoch: 3, endTs: endTs + WEEK, startTs: endTs + 60, prev: b2, snapshot: { slot: 3_000, records: EXAMPLE } });
  assert.throws(() => buildExtraFile(b3, x1, snap(3_000, endTs + WEEK, EXAMPLE), pool(80n * XNT, endTs + WEEK)), /never skipped/);
  const b2other = mkBase({ epoch: 2, endTs, startTs: b1.window.endTs + 60, burns: exampleBurns, prev: mkBase({ epoch: 1, endTs: T0 + WEEK, burns: [{ x1: EVA, base: 1n }] }), snapshot: { slot: 2_000, records: EXAMPLE } });
  assert.throws(() => buildExtraFile(b2other, x1, snap(2_000, endTs, EXAMPLE), pool(80n * XNT, endTs + 30)), /built on a base file other than/);
  const badPrev = clone(x1);
  badPrev.totals.release = "1";
  assert.throws(() => buildExtraFile(b2, badPrev, snap(2_000, endTs, EXAMPLE), pool(80n * XNT, endTs + 30)), /extra-1.json does not match its own dataHash/);
  const b2low = mkBase({ epoch: 2, endTs, startTs: b1.window.endTs + 60, burns: exampleBurns, prev: b1, snapshot: { slot: 1_000, records: EXAMPLE } });
  assert.throws(() => buildExtraFile(b2low, x1, snap(1_000, endTs, EXAMPLE), pool(80n * XNT, endTs + 30)), /not after the previous extra snapshot/);
  assert.throws(() => buildExtraFile(b2, x1, snap(2_000, endTs - 1, EXAMPLE), pool(80n * XNT, endTs + 30)), /not the base window end/);
  assert.throws(() => buildExtraFile(b2, x1, snap(2_000, endTs, EXAMPLE), pool(80n * XNT, endTs - 1)), /build time .* before the base window end/);
  assert.throws(() => buildExtraFile(b2, x1, snap(2_000, endTs, EXAMPLE), pool(80n * XNT, endTs + 30, 80n * XNT - 1n)), /below X/);
  assert.throws(() => buildExtraFile(b2, x1, snap(2_000, endTs, EXAMPLE), { ...pool(80n * XNT, endTs + 30), open: "80000000000 " }), /canonical unsigned integer/);
  assert.throws(() => buildExtraFile(b2, x1, snap(2_000, endTs, EXAMPLE), { ...pool(80n * XNT, endTs + 30), createdAt: "2026-11-01 00:00:00" }), /canonical ISO-8601/);
});

test("refused snapshots: duplicate asset, bad signature, non-canonical key, bad tier or origin, a __proto__ member", () => {
  const { bases, extras } = run([{ records: EXAMPLE }]);
  const endTs = T0 + 2 * WEEK;
  const b2 = mkBase({ epoch: 2, endTs, startTs: bases[0].window.endTs + 60, burns: exampleBurns, prev: bases[0], snapshot: { slot: 2_000, records: EXAMPLE } });
  const mk = (records: ExtraSnapshotRecord[]) => buildExtraFile(b2, extras[0], snap(2_000, endTs, records), pool(80n * XNT, endTs + 30));
  assert.throws(() => mk([...EXAMPLE, rec(ASSET(1), 0, EVA)]), /twice/);
  assert.throws(() => mk([{ ...EXAMPLE[0], signature: "abc" }]), /transaction signature/);
  assert.throws(() => mk([{ ...EXAMPLE[0], signature: bs58.encode(new Uint8Array(63)) }]), /transaction signature/);
  assert.throws(() => mk([{ ...EXAMPLE[0], owner: "1" + EVA }]), /public key/, "33 bytes");
  assert.throws(() => mk([{ ...EXAMPLE[0], owner: "0x" + "ab".repeat(20) }]), /public key/, "not base58");
  assert.throws(() => mk([{ ...EXAMPLE[0], tier: 4 }]), /tier 4/);
  assert.throws(() => mk([{ ...EXAMPLE[0], origin: 3 }]), /origin 3/);
  assert.throws(() => mk([{ ...EXAMPLE[0], backing: "-1" }]), /canonical unsigned integer/);
  assert.throws(() => mk([{ ...EXAMPLE[0], forgedAt: 1.5 }]), /safe non-negative integer/);
  const proto = JSON.parse('{"slot":2000,"blockTime":' + endTs + ',"records":[],"__proto__":{"x":1}}') as ExtraSnapshot;
  assert.throws(() => buildExtraFile(b2, extras[0], proto, pool(80n * XNT, endTs + 30)), /__proto__/);
});

// ── 5. verify round trip and tamper detection ──────────────────────────────────────────────────
test("verify: round trip, then every tamper is caught (pay, leaf order, root, proofs, prev link, base link, dataHash)", () => {
  const { bases, extras } = run([{ records: EXAMPLE }, { records: EXAMPLE, burns: exampleBurns, X: 80n * XNT }]);
  const [b1, b2] = bases;
  const [x1, x2] = extras;
  assert.deepStrictEqual(verifyExtraFile(x1, b1, null), []);
  assert.deepStrictEqual(verifyExtraFile(x2, b2, x1), []);
  const re = (f: ExtraFileV1) => ({ ...f, dataHash: dataHashExtra(f) });
  const t1 = clone(x2);
  t1.rows[0].pay = (BigInt(t1.rows[0].pay) + 1n).toString();
  assert(verifyExtraFile(re(t1), b2, x1).some((e) => /rows does not match/.test(e)));
  assert(verifyExtraFile(t1, b2, x1).some((e) => /dataHash mismatch/.test(e)));
  const t2 = clone(x2);
  t2.leaves[0].amount = (BigInt(t2.leaves[0].amount) + 1n).toString();
  const e2 = verifyExtraFile(re(t2), b2, x1);
  assert(e2.some((e) => /leaves does not match/.test(e)) && e2.some((e) => /not the sum of the leaves/.test(e)) && e2.some((e) => /root mismatch/.test(e)), e2.join("; "));
  const t3 = clone(x2);
  [t3.leaves[0], t3.leaves[1]] = [{ ...t3.leaves[1], index: 0 }, { ...t3.leaves[0], index: 1 }];
  assert(verifyExtraFile(re(t3), b2, x1).some((e) => /is not after leaf/.test(e)));
  const t4 = clone(x2);
  t4.root = EMPTY_ROOT;
  assert(verifyExtraFile(re(t4), b2, x1).some((e) => /root mismatch/.test(e)));
  const t5 = clone(x2);
  t5.proofs[x2.leaves[0].wallet] = [];
  assert(verifyExtraFile(t5, b2, x1).some((e) => /proofs do not match/.test(e)));
  assert(verifyExtraFile(x2, b2, null).some((e) => /extra-1.json is required/.test(e)));
  assert(verifyExtraFile(x2, b1, x1).some((e) => /base file is epoch 1/.test(e)));
  assert(verifyExtraFile(x2, b2, x2).some((e) => /previous extra file is epoch 2/.test(e)));
  const t6 = clone(x2);
  t6.pool.open = "1";
  assert(verifyExtraFile(re(t6), b2, x1).some((e) => /8% of the free extra pot/.test(e)));
  assert.deepStrictEqual(verifyExtraFile({ ...clone(x2), kind: "epoch" } as unknown as ExtraFileV1, b2, x1), ["not an extra file (kind epoch, version 1)"]);
  const badProto = JSON.parse(JSON.stringify(x2).replace('"policy":{', '"policy":{"__proto__":{"a":1},')) as ExtraFileV1;
  assert.match(verifyExtraFile(badProto, b2, x1)[0], /__proto__/);
});

test("published event and chain link rules (pure; the plumbing reads the chain after the upgrade)", () => {
  const { extras } = run([{ records: EXAMPLE }, { records: EXAMPLE, burns: exampleBurns, X: 80n * XNT }]);
  const f = extras[1];
  const ev = { epoch: 2, root: f.root, dataHash: f.dataHash, total: f.totals.budget, leaves: 4, freeBefore: (90n * XNT).toString(), freeAfter: (90n * XNT - 5_800_000_000n).toString() };
  assert.deepStrictEqual(verifyPublishedExtra(f, ev), []);
  assert.deepStrictEqual(verifyPublishedExtra(f, { ...ev, freeBefore: (79n * XNT).toString() }), ["free_before is below the X the file was built on", "free_after != free_before − total"]);
  assert.deepStrictEqual(verifyPublishedExtra(f, { ...ev, leaves: 3, total: "1" }), ["published total 1 != budget 5800000000", "published leaf count 3 != 4"]);
  assert.deepStrictEqual(verifyExtraChainLink(f, { freeAfter: f.pool.open }), []);
  assert.deepStrictEqual(verifyExtraChainLink(f, { freeAfter: "1" }), [`pool.open ${f.pool.open} != previous free_after 1`]);
  assert.deepStrictEqual(verifyExtraChainLink(f, null), ["the previous extra publication is required"]);
  assert.deepStrictEqual(verifyExtraChainLink(extras[0], null), []);
  const c = extraClaimArgs(f, ANA)!;
  assert.deepStrictEqual([c.epoch, c.index, c.wallet, c.amount], [2, f.leaves.findIndex((l) => l.wallet === ANA), ANA, "200000000"]);
  assert(verifyProof(c.proof.map((h) => Buffer.from(h, "hex")), Buffer.from(f.root, "hex"), extraLeaf(2, c.index, ANA, 200_000_000n)));
  assert.strictEqual(extraClaimArgs(f, EVA), null);
});

// ── 6. a real v3 base file ─────────────────────────────────────────────────────────────────────
test("real engine: the extra reads base / lp / basePaid of a computeEpochV3 file and the uncovered part is what the base pot left", () => {
  const XEN = 10n ** 18n;
  const P6 = 10n ** 12n;
  const X1 = 10n ** 18n;
  const BIG_L = 10n ** 30n;
  const blockAt = (ts: number) => ts - T0 + 1_000;
  let n = 0;
  const rburn = (x1: string, ts: number, xen: bigint): BurnInputV3 => {
    n++;
    return {
      chainId: 10, txHash: "0x" + n.toString(16).padStart(64, "0"), logIndex: n, blockNumber: blockAt(ts), missionId: String(n), pilot: "0x" + "ab".repeat(20),
      amountWei: (xen * XEN).toString(), tier: 0, x1, timestamp: ts, medianE18: P6.toString(), lastCloseE18: P6.toString(), priceSource: "candles",
      xntMedianE18: X1.toString(), xntLastCloseE18: X1.toString(), xntSource: "candles",
    };
  };
  const realBase = (epoch: number, endTs: number, prev: EpochFileV3 | null, burns: BurnInputV3[], F: bigint, records: ExtraSnapshotRecord[] = []): EpochFileV3 => {
    const from = prev ? prev.chains[0].toBlock : 0;
    const inputs: EpochInputsV3 = {
      programId: PROGRAM, epoch, createdAt: iso(endTs),
      window: { startTs: prev ? Math.floor(Date.parse(prev.createdAt) / 1000) + 60 : endTs - WEEK, endTs },
      chains: [{
        chainId: 10, name: "chain-10", portal: "0xportal", fromBlockExclusive: from, toBlock: blockAt(endTs),
        market: { spotE18: P6.toString(), refUsdE18: P6.toString(), priceSource: "test", pools: [] }, liquidityNowMicro: BIG_L.toString(), totalSupply: "0", burns,
      }],
      snapshot: { slot: 100 + epoch, records: records.map((r) => ({ asset: r.asset, tier: r.tier, owner: r.owner, backing: r.backing, origin: r.origin })) },
      freePool: { lamports: F.toString(), slot: 99 + epoch, open: prev ? F.toString() : null },
      xnt: { twapE18: X1.toString(), apiE18: X1.toString(), source: "test" }, switchRefs: null,
    };
    const f = buildEpochFileV3(inputs, prev);
    assert(f, "real base epoch is empty");
    return clone(f);
  };
  const H = W(61);
  const K = W(62);
  // F = 10 XNT: cash capacity 0.8 XNT (A13.1); H burns 1 XNT of value on day 0 and K 2 XNT on day 3: both are only partly paid
  const records = [rec(ASSET(1), 3, H), rec(ASSET(2), 2, K)];
  const b1 = realBase(1, T0 + WEEK, null, [rburn(H, T0 + DAY, 1_000_000n)], 10n * XNT, records);
  const b2 = realBase(2, T0 + 2 * WEEK, b1, [rburn(H, T0 + WEEK + HOUR, 1_000_000n), rburn(K, T0 + WEEK + 3 * DAY, 2_000_000n)], 10n * XNT, records);
  // the uncovered part of every real burn is what the base pot left, below its market value
  for (const b of b2.burns) {
    const u = uncovered(b);
    assert.strictEqual(u, (BigInt(b.base) * (BigInt(b.lp) - BigInt(b.basePaid) > 0n ? BigInt(b.lp) - BigInt(b.basePaid) : 0n)) / BigInt(b.lp));
    assert(u <= BigInt(b.base));
  }
  // epoch 1: nothing is eligible yet, the extra starts (every Artifact "new")
  assert.strictEqual(baseNftTermsError(b1), null);
  const x1 = buildExtraFile(b1, null, snap(b1.snapshot.slot, b1.window.endTs, records), pool(0n, b1.window.endTs + 30));
  assert.deepStrictEqual(verifyExtraFile(x1, b1, null), []);
  // X1 regression (review a2), A13.1: the base engine is the two-pot base, so a real base file never carries an NFT term,
  // the holders are paid in the base exactly as non-holders, and the extra of epoch 2 builds and verifies on it
  assert.strictEqual(baseNftTermsError(b2), null);
  for (const k of ["ledger", "lanes", "boosts", "drops", "dropsGross"]) assert(!(k in b2), `the base file has ${k}`);
  const b2none = realBase(2, T0 + 2 * WEEK, b1, [rburn(H, T0 + WEEK + HOUR, 1_000_000n), rburn(K, T0 + WEEK + 3 * DAY, 2_000_000n)], 10n * XNT, []);
  const alloc = (f: EpochFileV3) => f.burns.map((b) => [b.x1, b.base, b.lp, b.basePaid, b.alloc].join());
  assert.deepStrictEqual(alloc(b2), alloc(b2none).map((s, i) => s.replace(/^[^,]+/, b2.burns[i].x1)), "the base pays the holders exactly as if no Artifact existed");
  const x2 = buildExtraFile(b2, x1, snap(b2.snapshot.slot, b2.window.endTs, records), pool(0n, b2.window.endTs + 30));
  assert.deepStrictEqual(verifyExtraFile(x2, b2, x1), []);
  // the base file is untouched and still verifies on its own
  assert.strictEqual(dataHashV3(b2), b2.dataHash);
});

test("X1 / A13.1: a base file with any NFT term (a ledger, a lane, a boost, a burn's lane, an earmark) or a drop policy is refused by build and verify", () => {
  const H = W(71);
  const records = [rec(ASSET(1), 3, H)];
  const { bases, extras } = run([{ records }, { records, burns: [{ x1: H, base: 5n * XNT }], X: 0n }]);
  assert.deepStrictEqual(verifyExtraFile(extras[1], bases[1], extras[0]), []);
  const rehash = (b: EpochFileV3) => ({ ...b, dataHash: dataHashV3(b) });
  const withLane = rehash({ ...clone(bases[1]), burns: clone(bases[1]).burns.map((b) => ({ ...b, lane: "1" })) } as EpochFileV3);
  const withLanes = rehash({ ...clone(bases[1]), lanes: [{ player: H, asset: ASSET(1), tier: 0, amount: "1" }] } as EpochFileV3);
  const withBoost = rehash({ ...clone(bases[1]), boosts: [{ player: H, asset: ASSET(1), amount: "1" }] } as EpochFileV3);
  // A13.1: present at all is enough, even empty or "0": the engine cannot write any of them
  const withLaneZero = rehash({ ...clone(bases[1]), burns: clone(bases[1]).burns.map((b) => ({ ...b, lane: "0" })) } as EpochFileV3);
  const withEmpty = ["ledger", "lanes", "boosts"].map((k) => rehash({ ...clone(bases[1]), [k]: [] } as unknown as EpochFileV3));
  const withDrops = rehash({ ...clone(bases[1]), drops: { seal: false }, dropsGross: true } as unknown as EpochFileV3);
  const withEarmark = rehash({ ...clone(bases[1]), capacity: { earmarked: "0" } } as unknown as EpochFileV3);
  for (const b of [withLane, withLanes, withBoost, withLaneZero, ...withEmpty, withDrops, withEarmark]) {
    assert.match(baseNftTermsError(b) ?? "", /NFT terms/);
    assert.throws(() => buildExtraFile(b, extras[0], extras[1].snapshot, pool(0n, b.window.endTs + 30, 0n, 2_005)), /NFT terms/);
    assert(verifyExtraFile(extras[1], b, extras[0]).some((e) => /NFT terms|baseDataHash/.test(e)));
  }
});

test("X2: S(n) is the base file's snapshot: another slot, a ghost asset, a changed owner, backing, origin or forgedAt are refused", () => {
  const [H, K] = [W(81), W(82)];
  const records = [rec(ASSET(1), 3, H), rec(ASSET(2), 2, K), rec(ASSET(3), 0, K, { origin: ORIGIN_GENESIS })];
  const { bases, extras } = run([{ records }, { records, burns: [{ x1: H, base: 5n * XNT }, { x1: K, base: 2n * XNT }], X: 0n }]);
  const [b2, x1] = [bases[1], extras[0]];
  const endTs = b2.window.endTs;
  const at = (s: ExtraSnapshot) => () => buildExtraFile(b2, x1, s, pool(0n, endTs + 30, 0n, 2_005));
  assert.doesNotThrow(at(snap(2_000, endTs, records)));
  // review a1: 1a another slot (K's Solar shown moved), 1b a ghost Void, 1c backing/forgedAt/origin mutations, 1d owner
  // disagreement at the base slot, 1e a snapshot a week after the window end
  assert.throws(at(snap(2_777, endTs, records.map((r) => (r.asset === ASSET(2) ? { ...r, owner: H } : r)))), /not the base file's snapshot slot/);
  assert.throws(at(snap(2_000, endTs, [...records, rec(ASSET(9), 3, K)])), /4 assets, the base snapshot 3/);
  assert.throws(at(snap(2_000, endTs, records.map((r) => (r.asset === ASSET(1) ? { ...r, backing: (400n * XNT).toString() } : r)))), /differs from the base snapshot/);
  assert.throws(at(snap(2_000, endTs, records.map((r) => (r.asset === ASSET(3) ? { ...r, origin: ORIGIN_FORGED, tier: 3 } : r)))), /differs from the base snapshot/);
  assert.throws(at(snap(2_000, endTs, records.map((r) => (r.asset === ASSET(1) ? { ...r, forgedAt: endTs - DAY } : r)))), /forgedAt changed since S\(n−1\)/);
  assert.throws(at(snap(2_000, endTs, records.map((r) => (r.asset === ASSET(2) ? { ...r, owner: H } : r)))), /differs from the base snapshot/);
  assert.throws(at(snap(9_999_999, endTs + WEEK, records)), /not the base file's snapshot slot/);
  // a backing that grew since S(n−1) is refused even when the base agrees (a backing only ever falls)
  const grown = records.map((r) => (r.asset === ASSET(2) ? { ...r, backing: (31n * XNT).toString() } : r));
  const b2g = mkBase({ epoch: 2, endTs, startTs: bases[0].window.endTs + 60, burns: [{ x1: H, base: 5n * XNT }], prev: bases[0], snapshot: { slot: 2_000, records: grown } });
  assert.throws(() => buildExtraFile(b2g, x1, snap(2_000, endTs, grown), pool(0n, endTs + 30)), /backing .* above S\(n−1\)/);
});

test("X3: a base window of two weeks (an empty or aborted week before it) carries two weeks of need", () => {
  // A13.3: k = max(1, ⌊(len + 6 h)/1 w⌋): a 13-day window is one week now (was two under A12.7's 1-day slack)
  assert.deepStrictEqual([needWeeksOf(0, WEEK + 600), needWeeksOf(0, 6 * DAY), needWeeksOf(0, 2 * WEEK - 60), needWeeksOf(0, 13 * DAY), needWeeksOf(0, 3 * WEEK)], [1, 1, 2, 1, 3]);
  const [H, K] = [W(91), W(92)];
  // H's Void: need 2 XNT per week; K's Void, idle, only widens the 4% backing bound (the on-chain bound per publication)
  const records = [rec(ASSET(1), 3, H), rec(ASSET(2), 3, K)];
  const b1 = mkBase({ epoch: 1, endTs: T0 + WEEK, snapshot: { slot: 1_000, records } });
  const x1 = buildExtraFile(b1, null, snap(1_000, T0 + WEEK, records), pool(0n, T0 + WEEK + 30));
  // review a3 3a: window T0 + 1 w + 60 .. T0 + 3 w, H burns 5 XNT uncovered
  const b2 = mkBase({ epoch: 2, endTs: T0 + 3 * WEEK, startTs: T0 + WEEK + 60, burns: [{ x1: H, base: 5n * XNT }], prev: b1, snapshot: { slot: 3_000, records } });
  const x2 = buildExtraFile(b2, x1, snap(3_000, T0 + 3 * WEEK, records), pool(1_000n * XNT, T0 + 3 * WEEK + 30));
  assert.deepStrictEqual([x2.window.weeks, rowOf(x2, H)!.need, rowOf(x2, H)!.counted, rowOf(x2, H)!.pay], [2, "4000000000", "4000000000", "8000000000"], "two weeks of need: 8 XNT, as two 7-day windows would pay");
  assert.strictEqual(x2.totals.release, (80n * XNT).toString(), "R is one release per publication");
  assert.deepStrictEqual(verifyExtraFile(x2, b2, x1), []);
  // A13.3 (OWNER-A12-3): alone, H is now paid both weeks in full: the backing bound per publication is two weeks' worth
  // (2 × 4 XNT), so it no longer holds a two-week window at one week's maximum (was 4 XNT under A12.7)
  const solo = [rec(ASSET(1), 3, H)];
  const s1 = mkBase({ epoch: 1, endTs: T0 + WEEK, snapshot: { slot: 1_000, records: solo } });
  const sx1 = buildExtraFile(s1, null, snap(1_000, T0 + WEEK, solo), pool(0n, T0 + WEEK + 30));
  const s2 = mkBase({ epoch: 2, endTs: T0 + 3 * WEEK, startTs: T0 + WEEK + 60, burns: [{ x1: H, base: 5n * XNT }], prev: s1, snapshot: { slot: 3_000, records: solo } });
  const sx2 = buildExtraFile(s2, sx1, snap(3_000, T0 + 3 * WEEK, solo), pool(1_000n * XNT, T0 + 3 * WEEK + 30));
  assert.deepStrictEqual([rowOf(sx2, H)!.counted, sx2.totals.backingBound, sx2.totals.budgetMax, rowOf(sx2, H)!.pay], ["4000000000", "8000000000", "8000000000", "8000000000"]);
  assert.deepStrictEqual(verifyExtraFile(sx2, s2, sx1), []);
});

test("A13.3 (OWNER-A12-3): need and the backing bound are per 7-day week; 7, 13 and 14-day windows pay 1, 1 and 2 weeks' worth, never more than one release", () => {
  assert.strictEqual(NEED_WEEK_SLACK, 6 * HOUR, "the tolerance is the publication lag MAX_PUBLISH_LAG");
  const H = W(97);
  const solo = [rec(ASSET(1), 3, H)];
  const b1 = mkBase({ epoch: 1, endTs: T0 + WEEK, snapshot: { slot: 1_000, records: solo } });
  const x1 = buildExtraFile(b1, null, snap(1_000, T0 + WEEK, solo), pool(0n, T0 + WEEK + 30));
  const start = T0 + WEEK + 60;
  /** extra epoch 2 on a base window of `len` seconds, H burning 5 XNT uncovered (more than any need below), pot X */
  const window = (len: number, X: bigint) => {
    const b2 = mkBase({ epoch: 2, endTs: start + len, startTs: start, burns: [{ x1: H, base: 5n * XNT }], prev: b1, snapshot: { slot: 3_000, records: solo } });
    const x2 = buildExtraFile(b2, x1, snap(3_000, start + len, solo), pool(X, start + len + 30));
    assert.deepStrictEqual(verifyExtraFile(x2, b2, x1), []);
    return { b2, x2 };
  };
  const rows: [number, number, string, string, string, string][] = [];
  for (const days of [7, 13, 14]) {
    const { x2 } = window(days * DAY, 1_000n * XNT);
    const r = rowOf(x2, H)!;
    rows.push([days, x2.window.weeks, r.need, x2.totals.backingBound, x2.totals.release, r.pay]);
    assert.strictEqual(x2.window.weeks, Math.max(1, Math.floor(days / 7)), `${days} days: ⌊days/7⌋ weeks`);
    assert.strictEqual(extraPublishArgs(x2).weeks, x2.window.weeks, "the program bounds the publication with the same weeks");
    assert.strictEqual(BigInt(x2.totals.budget) <= BigInt(x2.totals.release), true, "never more than one release");
  }
  assert.deepStrictEqual(rows, [
    [7, 1, "2000000000", "4000000000", "80000000000", "4000000000"],
    [13, 1, "2000000000", "4000000000", "80000000000", "4000000000"],
    [14, 2, "4000000000", "8000000000", "80000000000", "8000000000"],
  ]);
  // a skipped week published up to 6 h late is still two weeks; one second short of the tolerance is one
  assert.deepStrictEqual([needWeeksOf(start, start + 2 * WEEK - 6 * HOUR), needWeeksOf(start, start + 2 * WEEK - 6 * HOUR - 1), needWeeksOf(start, start + 5 * DAY)], [2, 1, 1]);
  // the 14-day pay equals two 7-day publications (4 + 4 XNT) when the release does not bind ...
  const { x2: twoWeeks } = window(14 * DAY, 1_000n * XNT);
  assert.strictEqual(payOf(twoWeeks, H), 2n * payOf(window(7 * DAY, 1_000n * XNT).x2, H));
  // ... and the release is ONE per published base epoch: a small pot (R = 4 XNT) holds the 14-day window at R
  const { x2: smallPot, b2: smallBase } = window(14 * DAY, 50n * XNT);
  assert.deepStrictEqual([smallPot.totals.release, smallPot.totals.budgetMax, smallPot.totals.budget], ["4000000000", "4000000000", "4000000000"]);
  assert.strictEqual(backingBoundOf(100n * XNT, 2), 8n * XNT);
  assert.throws(() => backingBoundOf(1n, 0), /at least one week/);
  // property, 300 random windows of 5.75 to 40 days, pots and burns: k = max(1, ⌊(len + 6 h)/1 w⌋); the budget never
  // exceeds one release nor k weeks of the backing bound; with use and pot to spare a solo Void is paid exactly k weeks
  const rnd = mulberry32(20_261_023);
  let bound = 0;
  for (let i = 0; i < 300; i++) {
    const len = Math.floor(MIN_WINDOW_T + rnd() * (40 * DAY - MIN_WINDOW_T));
    const X = BigInt(Math.floor(rnd() * 2_000)) * XNT;
    const burn = BigInt(1 + Math.floor(rnd() * 20)) * XNT;
    const b2 = mkBase({ epoch: 2, endTs: start + len, startTs: start, burns: [{ x1: H, base: burn }], prev: b1, snapshot: { slot: 3_000, records: solo } });
    const x2 = buildExtraFile(b2, x1, snap(3_000, start + len, solo), pool(X, start + len + 30));
    const k = Math.max(1, Math.floor((len + 6 * HOUR) / WEEK));
    assert.strictEqual(x2.window.weeks, k);
    const R = (X * EXTRA_RELEASE_BPS) / BPS;
    assert(BigInt(x2.totals.budget) <= R && BigInt(x2.totals.budget) <= BigInt(k) * 4n * XNT, `window ${len} s: one release, k weeks of the bound`);
    if (R >= BigInt(k) * 4n * XNT && uncovered({ base: burn.toString(), lp: ((burn * 12_500n) / BPS).toString(), basePaid: "0" }) >= BigInt(k) * 2n * XNT) {
      assert.strictEqual(payOf(x2, H), BigInt(k) * 4n * XNT, `window ${len} s: ${k} weeks in full`);
      bound++;
    }
    assert.deepStrictEqual(verifyExtraFile(x2, b2, x1), []);
  }
  assert(bound > 20, `coverage: ${bound} windows paid in full`);
  // the recorded weeks are recomputed: a file claiming three weeks (to lift the bound) is refused
  const forged = clone(smallPot);
  forged.window.weeks = 3;
  forged.dataHash = dataHashExtra(forged);
  assert(verifyExtraFile(forged, smallBase, x1).some((e) => /window does not match/.test(e)));
});

// ── W2-3: the program's final publish_extra_epoch (weeks u8, prev_epoch) and its bound, on the same inputs ─────────
testAsync("W2-3: extraPublishArgs encode with the v3 IDL exactly as publish_extra_epoch takes them, and the program's bound formula accepts the file on the same inputs", async () => {
  const u64 = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const H = W(96);
  const solo = [rec(ASSET(1), 3, H)];
  const b1 = mkBase({ epoch: 1, endTs: T0 + WEEK, snapshot: { slot: 1_000, records: solo } });
  const x1 = buildExtraFile(b1, null, snap(1_000, T0 + WEEK, solo), pool(0n, T0 + WEEK + 30));
  const start = T0 + WEEK + 60;
  const end = start + 14 * DAY;
  const X = 1_000n * XNT;
  const b2 = mkBase({ epoch: 2, endTs: end, startTs: start, burns: [{ x1: H, base: 5n * XNT }], prev: b1, snapshot: { slot: 3_000, records: solo } });
  const x2 = buildExtraFile(b2, x1, snap(3_000, end, solo), pool(X, end + 30));
  assert.deepStrictEqual(verifyExtraFile(x2, b2, x1), []);
  const a = extraPublishArgs(x2);
  assert.deepStrictEqual([a.epoch, a.weeks, a.total, a.leaves, x2.totals.eligibleBacking], [2, 2, "8000000000", 1, "100000000000"], "the W2-3 file: a 14-day window, 2 weeks, 8 XNT");
  assert.strictEqual(extraPublishArgsError(a), null);

  // the encoding: discriminator ‖ epoch_id u64 ‖ root ‖ data_hash ‖ total u64 ‖ leaves u32 ‖ weeks u8 = 93 bytes, v3 IDL
  const program = programV3(new anchor.AnchorProvider({} as never, new anchor.Wallet(Keypair.generate()), {}));
  const oracle = Keypair.generate().publicKey;
  const ix = await publishExtraEpochIxV3(program, oracle, a);
  const want = Buffer.concat([Buffer.from("58472b582480adff", "hex"), u64(a.epoch), Buffer.from(a.root, "hex"), Buffer.from(a.dataHash, "hex"), u64(BigInt(a.total)), u32(a.leaves), Buffer.from([a.weeks])]);
  assert.strictEqual(ix.data.length, 93);
  assert.strictEqual(ix.data.toString("hex"), want.toString("hex"));
  const dec = (program.coder.instruction as anchor.BorshInstructionCoder).decode(ix.data) as { name: string; data: any };
  assert.strictEqual(dec.name, "publishExtraEpoch");
  assert.deepStrictEqual([dec.data.epochId.toString(), Buffer.from(dec.data.root).toString("hex"), Buffer.from(dec.data.dataHash).toString("hex"), dec.data.total.toString(), dec.data.leaves, dec.data.weeks],
    [String(a.epoch), a.root, a.dataHash, a.total, a.leaves, a.weeks], "the program reads back the file's numbers");
  assert.deepStrictEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isWritable, k.isSigner]), [
    [PDA.config().toBase58(), false, false], [PDA_V3.extraState().toBase58(), true, false], [PDA_V3.extraEpoch(2).toBase58(), true, false],
    [PDA.epoch(2).toBase58(), false, false], [PDA.epoch(1).toBase58(), false, false], [oracle.toBase58(), true, true], ["11111111111111111111111111111111", false, false],
  ], "config, extra_state, extra_epoch, base_epoch, prev_epoch = Epoch(id − 1), oracle, system_program");
  // the v2 (live) client has no such instruction: the builder refuses it
  const { programV2 } = await import("../src/x1");
  await assert.rejects(publishExtraEpochIxV3(programV2(new anchor.AnchorProvider({} as never, new anchor.Wallet(Keypair.generate()), {})), oracle, a), /not built from moon_forge\.v3\.json/);

  // the on-chain bound on the same inputs: the pot the file was built on (free = X) and the eligible backing, the base
  // epochs published at the window start and up to 6 h after its end
  const state = (free: bigint, backing: bigint, last = 1n) => ({ lastEpoch: last, lastPublishTs: 0n, accounted: free, reserved: 0n, liveForgedBacking: backing, outSincePublish: 0n });
  const x = state(X, BigInt(x2.totals.eligibleBacking));
  for (const lag of [0, 6 * HOUR]) {
    const weeksMax = extraWeeksMaxV3(end + lag, start);
    assert.strictEqual(weeksMax, 2);
    assert.strictEqual(extraPublishErrorV3(x, a, { baseLastEpoch: 2, weeksMax }), null, "the program accepts the file");
    assert.strictEqual(extraBoundV3(x, a.weeks).bound, BigInt(a.total), "bound = min(8% of 1,000, 2 × 4% of 100) = 8 XNT, the file's budget");
    assert.strictEqual(extraBoundV3(x, a.weeks).bound, min(releaseOf(X), backingBoundOf(BigInt(x2.totals.eligibleBacking), a.weeks)), "the oracle's releaseOf / backingBoundOf");
    assert.strictEqual(extraPublishErrorV3(x, { ...a, weeks: 1 }, { baseLastEpoch: 2, weeksMax }), "ExtraBudgetExceeded", "the pre-W2-3 one-week bound refuses it");
    assert.strictEqual(extraPublishErrorV3(x, { ...a, weeks: 3 }, { baseLastEpoch: 2, weeksMax }), "BadEpochWindow", "over-claimed weeks");
    assert.strictEqual(extraPublishErrorV3(x, { ...a, total: (BigInt(a.total) + 1n).toString() }, { baseLastEpoch: 2, weeksMax }), "ExtraBudgetExceeded", "+1 lamport");
  }
  // the program's order of checks (extra_publish_core)
  assert.strictEqual(extraPublishErrorV3(state(X, 100n * XNT, 0n), a, { baseLastEpoch: 2, weeksMax: 2 }), "ExtraEpochOrder");
  assert.strictEqual(extraPublishErrorV3(x, a, { baseLastEpoch: 1, weeksMax: 2 }), "ExtraEpochOrder");
  assert.strictEqual(extraPublishErrorV3({ ...x, lastPublishTs: BigInt(end) }, a, { baseLastEpoch: 2, weeksMax: 2, now: end + 6 * DAY - 1 }), "ExtraEpochOrder", "6 days between paying publications");
  assert.strictEqual(extraPublishErrorV3({ ...x, lastPublishTs: BigInt(end) }, { ...a, total: "0", leaves: 0, root: EMPTY_ROOT }, { baseLastEpoch: 2, weeksMax: 2, now: end + 1 }), null, "a heartbeat needs no interval");
  assert.strictEqual(extraPublishErrorV3(x, { ...a, leaves: 0 }, { baseLastEpoch: 2, weeksMax: 2 }), "EmptyEpoch");
  assert.strictEqual(extraPublishErrorV3(x, { ...a, leaves: EXTRA_MAX_LEAVES + 1 }, { baseLastEpoch: 2, weeksMax: 2 }), "InvalidProof");
  assert.strictEqual(extraPublishErrorV3(x, { ...a, weeks: 0, total: "0", leaves: 0 }, { baseLastEpoch: 2, weeksMax: 2 }), "BadEpochWindow", "heartbeats are checked too");

  // extra.rs unit-test vectors (weeks_one_week_window, weeks_two_week_window, weeks_over_claimed_refused, extra_bound_table)
  const D = DAY;
  const tp = 100 * D;
  assert.deepStrictEqual([extraWeeksMaxV3(tp + 7 * D, tp), extraWeeksMaxV3(tp + 2 * WEEK - 6 * HOUR, tp), extraWeeksMaxV3(tp + 2 * WEEK - 6 * HOUR - 1, tp), extraWeeksMaxV3(tp + 13 * D, tp), extraWeeksMaxV3(tp + 21 * D, tp)], [1, 2, 1, 1, 3]);
  assert.deepStrictEqual([extraWeeksMaxV3(tp + 14 * D, null), extraWeeksMaxV3(tp + 40 * WEEK, tp), extraWeeksMaxV3(tp, tp + 14 * D)], [1, EXTRA_MAX_WEEKS, 1], "epoch 1, the cap, out-of-order timestamps");
  assert.strictEqual(EXTRA_MAX_WEEKS, 13);
  assert.deepStrictEqual(extraBoundV3(state(1_000n * XNT, 100n * XNT), 1), { free: 1_000n * XNT, bound: 4n * XNT });
  assert.strictEqual(extraBoundV3(state(1_000n * XNT, 100n * XNT), 2).bound, 8n * XNT);
  assert.strictEqual(extraBoundV3(state(50n * XNT, 1_000n * XNT), 1).bound, 4n * XNT, "ONE release per publication");
  assert.strictEqual(extraBoundV3(state(50n * XNT, 1_000n * XNT), 2).bound, 4n * XNT);
  assert.strictEqual(extraBoundV3(state(1_000n * XNT, 25n * XNT - 1n), 2).bound, 2n * (((25n * XNT - 1n) * 400n) / 10_000n), "floor per week, then multiplied");
  assert.strictEqual(extraBoundV3(state(100n * XNT, 1_000n * XNT), 1).bound, 8n * XNT);
  assert.strictEqual(extraBoundV3(state(100n * XNT, 50n * XNT), 1).bound, 2n * XNT);
  assert.strictEqual(extraBoundV3({ ...state(100n * XNT, 0n), outSincePublish: 50n * XNT }, 1).bound, 2n * XNT, "the week of a mass exit still counts what left");
  assert.throws(() => extraBoundV3({ ...state(1n, 0n), reserved: 2n }, 1), /MathOverflow/);
  for (const w of [0, 14, 1.5]) assert.match(String(extraPublishArgsError({ ...a, weeks: w })), /outside 1\.\.=13/);
  assert.match(String(extraPublishArgsError({ ...a, total: "18446744073709551616" })), /not a u64/);

  // the cap is the engine's too: a window after a 40-week silence carries 13 weeks, which the program allows
  assert.deepStrictEqual([needWeeksOf(0, 40 * WEEK), needWeeksOf(0, 13 * WEEK - 6 * HOUR), needWeeksOf(0, 14 * WEEK)], [13, 13, 13]);

  // property (weeks_match_the_oracle_formula): 10k random windows [published_at(id − 1), snapshot], published up to 6 h
  // after the snapshot: the oracle's k is within 1..=the chain's max (equal on an immediate publish), the bound is exactly
  // min(releaseOf(free), backingBoundOf(backing, k)), a file at the bound is accepted and one lamport more refused
  const rnd = mulberry32(20_261_023);
  for (let i = 0; i < 10_000; i++) {
    const prev = 1_000 * D + Math.floor(rnd() * 1_000 * D);
    const len = MIN_WINDOW_T + Math.floor(rnd() * 100 * D);
    const snapshotTs = prev + len;
    const published = snapshotTs + Math.floor(rnd() * (6 * HOUR + 1));
    const k = needWeeksOf(prev, snapshotTs);
    const max = extraWeeksMaxV3(published, prev);
    assert(k >= 1 && k <= max, `len ${len}: oracle k ${k}, chain max ${max}`);
    if (published === snapshotTs) assert.strictEqual(max, k);
    const free = BigInt(Math.floor(rnd() * 100_000)) * XNT + BigInt(Math.floor(rnd() * 1e9));
    const backing = BigInt(Math.floor(rnd() * 100_000)) * XNT + BigInt(Math.floor(rnd() * 1e9));
    const s = state(free, backing);
    const bound = min(releaseOf(free), backingBoundOf(backing, k));
    assert.strictEqual(extraBoundV3(s, k).bound, bound);
    const at = { ...a, weeks: k, total: bound.toString(), leaves: bound > 0n ? 1 : 0 };
    assert.strictEqual(extraPublishErrorV3(s, at, { baseLastEpoch: 2, weeksMax: max }), null);
    assert.strictEqual(extraPublishErrorV3(s, { ...at, total: (bound + 1n).toString(), leaves: 1 }, { baseLastEpoch: 2, weeksMax: max }), "ExtraBudgetExceeded");
  }
});

test("A13.6 (N6): one bad week never blocks the extra history: a skip heartbeat, then a heartbeat, then pay again", () => {
  const H = W(98);
  const recs = [rec(ASSET(1), 3, H)];
  const X = 1_000n * XNT;
  const bases: EpochFileV3[] = [];
  const extras: ExtraFileV1[] = [];
  const BAD = 3;
  for (let e = 1; e <= 6; e++) {
    const endTs = T0 + e * WEEK;
    const base = mkBase({ epoch: e, endTs, startTs: e > 1 ? bases[e - 2].window.endTs + 60 : undefined, burns: e > 1 ? [{ x1: H, base: 5n * XNT }] : [], prev: e > 1 ? bases[e - 2] : null, snapshot: { slot: 1_000 * e, records: recs } });
    bases.push(base);
    const prev = e > 1 ? extras[e - 2] : null;
    // week BAD cannot be built (here: a snapshot read at the wrong slot, every time it is tried)
    const s = snap(e === BAD ? 1_000 * e + 1 : 1_000 * e, endTs, recs);
    let f: ExtraFileV1;
    try {
      f = buildExtraFile(base, prev, s, pool(X, endTs + 30));
    } catch (err) {
      assert.strictEqual(e, BAD);
      f = buildSkipExtraFile(base, prev, `the build failed: ${(err as Error).message}`, pool(X, endTs + 30));
    }
    assert.deepStrictEqual(verifyExtraFile(f, base, prev), [], `extra ${e} verifies`);
    extras.push(clone(f));
  }
  const budgets = extras.map((f) => f.totals.budget);
  assert.deepStrictEqual(budgets, ["0", "4000000000", "0", "0", "4000000000", "4000000000"], "week 3 skipped, week 4 a heartbeat (everything new), paid again from week 5");
  const skip = extras[BAD - 1];
  assert.match(skip.skip!.reason, /not the base file's snapshot slot/);
  assert.deepStrictEqual([skip.snapshot.records.length, skip.rows.length, skip.leaves.length, skip.root, skip.totals.unpaid, skip.totals.release], [0, 0, 0, EMPTY_ROOT, (80n * XNT).toString(), (80n * XNT).toString()], "budget 0: the release stays in the pot");
  assert.deepStrictEqual([skip.prevDataHash, extras[BAD].prevDataHash, skip.firstEpoch], [extras[BAD - 2].dataHash, skip.dataHash, 1], "the history goes on, never restarted");
  assert.deepStrictEqual(extras[BAD].excluded, [{ asset: ASSET(1), reason: "new" }]);
  assert.strictEqual("skip" in extras[BAD], false, "only the skipped week carries `skip`");
  // tampering: an added row, a skip on another epoch without its previous file, a malformed skip
  const t1 = clone(skip);
  t1.rows = clone(extras[1].rows);
  t1.dataHash = dataHashExtra(t1);
  assert(verifyExtraFile(t1, bases[BAD - 1], extras[BAD - 2]).some((e) => /rows does not match/.test(e)));
  const t2 = clone(skip) as unknown as Record<string, unknown>;
  t2.skip = 5;
  assert.deepStrictEqual(verifyExtraFile(t2 as unknown as ExtraFileV1, bases[BAD - 1], extras[BAD - 2]), ["skip is not {reason: string}"]);
  assert.throws(() => skipExtraEpoch(bases[BAD - 1], null, "x", pool(X, T0 + BAD * WEEK + 30)), /never restarts/);
  assert.strictEqual(skipReasonOf("  a\n  b  "), "a b");
  assert.strictEqual(skipReasonOf("x".repeat(900)).length, 500);
  // never blocked forever: a skip after a skip (two bad weeks in a row) still chains, and the week after pays nothing
  // (its S(n−1) is empty) while the next one pays again
  const s4 = buildSkipExtraFile(bases[BAD], skip, "again", pool(X, T0 + (BAD + 1) * WEEK + 30));
  assert.deepStrictEqual(verifyExtraFile(s4, bases[BAD], skip), []);
  const n5 = buildExtraFile(bases[BAD + 1], s4, snap(1_000 * (BAD + 2), T0 + (BAD + 2) * WEEK, recs), pool(X, T0 + (BAD + 2) * WEEK + 30));
  assert.strictEqual(n5.totals.budget, "0");
});

testAsync("A13.6 / A13.7: the catch-up rebuilds a missing extra file byte for byte, or writes a skip heartbeat when it cannot be rebuilt", async () => {
  const H = W(99);
  // a world of 4 base epochs; S(n) is the base snapshot with forgedAt and a signature per asset per week
  const assets = [ASSET(11), ASSET(12)];
  const history = new Map<string, { slot: number; signature: string }[]>();
  const forged = new Map<string, number>(assets.map((a, i) => [a, T0 - (i + 1) * DAY]));
  const bases: EpochFileV3[] = [];
  const extras: ExtraFileV1[] = [];
  for (let e = 1; e <= 4; e++) {
    const endTs = T0 + e * WEEK;
    const records = assets.map((a, i) => rec(a, 1 + i, H, { forgedAt: forged.get(a), sig: e * 10 + i }));
    records.forEach((r) => history.set(r.asset, [...(history.get(r.asset) ?? []), { slot: 1_000 * e - 3, signature: r.signature }]));
    const stub = mkBase({ epoch: e, endTs, startTs: e > 1 ? bases[e - 2].window.endTs + 60 : undefined, burns: e > 1 ? [{ x1: H, base: 3n * XNT }] : [], prev: e > 1 ? bases[e - 2] : null, snapshot: { slot: 1_000 * e, records } });
    // the stub with the pool block a real base file has (the extra records its slot)
    const withPool = { ...stub, freePool: { lamports: "0", slot: 1_000 * e + 5, open: null, ref: "0" } } as unknown as EpochFileV3;
    const fixed = { ...withPool, dataHash: dataHashV3(withPool) } as EpochFileV3;
    bases.push(fixed);
    const read = { slot: 1_000 * e, blockTime: endTs, records: records.map((r) => ({ asset: r.asset, tier: r.tier, owner: r.owner, backing: r.backing, origin: r.origin, forgedAt: r.forgedAt })) };
    const sigs = Object.fromEntries(records.map((r) => [r.asset, r.signature]));
    extras.push(buildExtraAfterBaseV3(fixed, e > 1 ? extras[e - 2] : null, read, sigs, extraPoolV3(fixed, "0"), extraCreatedAtV3(fixed)));
  }
  const src = (o: { recycled?: string[]; published?: Record<number, string>; deadSigs?: boolean } = {}): ExtraRecoverySourcesV3 => ({
    forgedAt: async (as) => Object.fromEntries(as.filter((a) => !(o.recycled ?? []).includes(a) && forged.has(a)).map((a) => [a, forged.get(a)!])),
    assetSignatures: async (as, slot) => {
      if (o.deadSigs) throw new Error("getSignaturesForAddress: 503");
      const out: Record<string, string> = {};
      for (const a of as) {
        const at = (history.get(a) ?? []).filter((h) => h.slot <= slot).pop();
        if (at) out[a] = at.signature;
      }
      return out;
    },
    publishedExtra: async (e) => (o.published && o.published[e] ? { dataHash: o.published[e], freeAfter: "0" } : null),
  });
  // a lost extra-3.json is rebuilt byte for byte (the build instant and the pot are functions of the base file)
  const r3 = await rebuildExtraV3(bases[2], extras[1], src(), { next: extras[3] });
  assert.deepStrictEqual(r3.file, extras[2]);
  assert.deepStrictEqual(r3.confirmedBy, ["next file"]);
  assert.deepStrictEqual((await rebuildExtraV3(bases[2], extras[1], src({ published: { 3: extras[2].dataHash } }))).confirmedBy, ["chain"]);
  // refused: a data hash other than the program's record, or than extra-4.json's prevDataHash
  await assert.rejects(rebuildExtraV3(bases[2], extras[1], src({ published: { 3: "ab".repeat(32) } })), /^Error: refused: .*the program recorded/);
  const wrongNext = { ...extras[3], prevDataHash: "cd".repeat(32) };
  await assert.rejects(rebuildExtraV3(bases[2], extras[1], src(), { next: wrongNext }), /^Error: refused: .*extra-4\.json was built on/);
  // an asset recycled since keeps its forgedAt from S(n−1); in the first extra epoch it cannot be recovered
  assert.deepStrictEqual((await rebuildExtraV3(bases[2], extras[1], src({ recycled: [assets[0]] }))).file, extras[2]);
  await assert.rejects(rebuildExtraV3(bases[0], null, src({ recycled: [assets[0]] })), /forgedAt cannot be recovered/);
  // catch-up: extra-2 and extra-3 lost; extra-2 is rebuilt, extra-3 too, and extra-4 builds on them as before
  const missing = new Set([2, 3]);
  const up = await catchUpExtrasV3({ upTo: 3, firstEpoch: 1, baseOf: (e) => bases[e - 1] ?? null, extraOf: (e) => (missing.has(e) ? null : extras[e - 1] ?? null), src: src() });
  assert.deepStrictEqual(up.written.map((w) => [w.epoch, w.how]), [[2, "rebuilt"], [3, "rebuilt"]]);
  assert.deepStrictEqual(up.prev, extras[2]);
  // when the reads fail at the next base run, the missing week becomes a skip heartbeat and the history goes on
  const skipped = await catchUpExtrasV3({ upTo: 3, firstEpoch: 1, baseOf: (e) => bases[e - 1] ?? null, extraOf: (e) => (e === 3 ? null : extras[e - 1]), src: src({ deadSigs: true }) });
  assert.deepStrictEqual(skipped.written.map((w) => [w.epoch, w.how]), [[3, "skipped"]]);
  const s3 = skipped.written[0].file;
  assert.match(s3.skip!.reason, /503/);
  assert.deepStrictEqual(verifyExtraFile(s3, bases[2], extras[1]), []);
  const read4 = { slot: 4_000, blockTime: bases[3].window.endTs, records: extras[3].snapshot.records.map((r) => ({ asset: r.asset, tier: r.tier, owner: r.owner, backing: r.backing, origin: r.origin, forgedAt: r.forgedAt })) };
  const x4 = buildExtraAfterBaseV3(bases[3], s3, read4, Object.fromEntries(extras[3].snapshot.records.map((r) => [r.asset, r.signature])), extraPoolV3(bases[3], "0"), extraCreatedAtV3(bases[3]));
  // OD-9: before the pot exists (no init_extra mark) every FORGED Artifact is pre-upgrade, the permanent reason first
  assert.deepStrictEqual([verifyExtraFile(x4, bases[3], s3), x4.excluded.map((x) => x.reason)], [[], ["pre-upgrade", "pre-upgrade"]]);
  // a published extra epoch is never replaced by a skip, and a refused rebuild is never skipped over
  await assert.rejects(catchUpExtrasV3({ upTo: 3, firstEpoch: 1, baseOf: (e) => bases[e - 1], extraOf: (e) => (e === 3 ? null : extras[e - 1]), src: { ...src({ deadSigs: true }), publishedExtra: async (e) => (e === 3 ? { dataHash: extras[2].dataHash, freeAfter: "0" } : null) } }), /published on-chain but cannot be rebuilt/);
  await assert.rejects(catchUpExtrasV3({ upTo: 3, firstEpoch: 1, baseOf: (e) => bases[e - 1], extraOf: (e) => (e === 3 ? null : extras[e - 1]), src: src({ published: { 3: "ef".repeat(32) } }) }), /refused/);
  await assert.rejects(catchUpExtrasV3({ upTo: 3, firstEpoch: 1, baseOf: (e) => (e === 3 ? null : bases[e - 1]), extraOf: (e) => (e === 3 ? null : extras[e - 1]), src: src() }), /epoch-3\.json is missing/);
  // A13.8 (review R1, case E1): extra-2.json is lost, extra-3.json (built on it) is present and the rebuild fails for a
  // reason other than a hash mismatch: a skip would fork the history (extra-3 would no longer verify), so nothing is
  // written and the run says to restore or rebuild extra-2.json
  const lostUnder = (lost: number[], s: ExtraRecoverySourcesV3, upTo = 3, potLive?: boolean) =>
    catchUpExtrasV3({ upTo, firstEpoch: 1, baseOf: (e) => bases[e - 1] ?? null, extraOf: (e) => (lost.includes(e) ? null : extras[e - 1] ?? null), src: s, potLive });
  await assert.rejects(lostUnder([2], src({ deadSigs: true })), /^Error: extra-3\.json was built on the lost extra-2\.json .*rebuild-extra 2.*A13\.8/);
  await assert.rejects(lostUnder([1], src({ recycled: assets })), /extra-2\.json was built on the lost extra-1\.json/, "an unrecoverable forgedAt (first extra epoch, assets recycled) is not a reason to skip under a later file either");
  // the nearest later file two epochs up counts the same (extra-3 was built on extra-2, which was built on extra-1)
  await assert.rejects(lostUnder([1, 2], src({ deadSigs: true })), /extra-3\.json was built on the lost extra-1\.json/);
  // the later file built on a skip with exactly this reason: the skip is that very file, so it is written again
  const why = "extra epoch 2 could not be built or rebuilt: getSignaturesForAddress: 503";
  const skip2 = buildSkipExtraFile(bases[1], extras[0], why, { ...extraPoolV3(bases[1], "0"), createdAt: extraCreatedAtV3(bases[1]) });
  const read3 = { slot: 3_000, blockTime: bases[2].window.endTs, records: extras[2].snapshot.records.map((r) => ({ asset: r.asset, tier: r.tier, owner: r.owner, backing: r.backing, origin: r.origin, forgedAt: r.forgedAt })) };
  const onSkip3 = buildExtraAfterBaseV3(bases[2], skip2, read3, Object.fromEntries(extras[2].snapshot.records.map((r) => [r.asset, r.signature])), extraPoolV3(bases[2], "0"), extraCreatedAtV3(bases[2]));
  const again = await catchUpExtrasV3({ upTo: 3, firstEpoch: 1, baseOf: (e) => bases[e - 1], extraOf: (e) => (e === 2 ? null : e === 3 ? onSkip3 : extras[e - 1]), src: src({ deadSigs: true }) });
  assert.deepStrictEqual([again.written.map((w) => [w.epoch, w.how]), again.written[0].file.dataHash, again.prev], [[[2, "skipped"]], onSkip3.prevDataHash, onSkip3]);
  // with no later file the skip is still written (the A13.6 case above), and once the program is upgraded the FIRST extra
  // epoch is never skipped with X assumed to be 0 (review R1, case E5): its X comes from init_extra
  assert.deepStrictEqual((await lostUnder([3], src({ deadSigs: true }), 3)).written.map((w) => [w.epoch, w.how]), [[3, "skipped"]]);
  await assert.rejects(lostUnder([1], src(), 1, true), /extra-1\.json cannot be skipped either: .*first extra epoch.*never assumed to be 0/);
  await assert.rejects(lostUnder([1], src({ deadSigs: true }), 1, true), /extra-1\.json cannot be skipped either/);
});

test("X5 / X6: amounts at or above 2^64 are refused; before the upgrade a file claiming a pot is refused by verify", () => {
  const big = (2n ** 70n).toString();
  assert.throws(() => uncovered({ base: big, lp: "1250000000", basePaid: "0" }), /out of range/);
  const H = W(95);
  const records = [rec(ASSET(1), 3, H)];
  assert.throws(() => run([{ records }, { records, burns: [{ x1: H, base: 2n ** 70n, lp: 2n ** 70n }], X: 1_000n * XNT }]));
  const { extras } = run([{ records }, { records, burns: [{ x1: H, base: 5n * XNT }], X: 0n }]);
  assert.strictEqual(preUpgradePotError({ pool: { ...extras[1].pool, init: null } }), null, "a heartbeat passes");
  assert.match(preUpgradePotError(extras[1])!, /has no init_extra \(OD-9\)/, "OD-9: an init_extra mark before the upgrade is refused");
  const claimed = run([{ records }, { records, burns: [{ x1: H, base: 5n * XNT }], X: 1_000n * XNT }]).extras[1];
  assert.match(preUpgradePotError(claimed)!, /does not exist before the program upgrade/, "review a3 3f: X claimed before init_extra");
  assert.strictEqual(preUpgradePotError(claimed, true), null, "after the upgrade the chain link checks X");
});

// ── OD-9: an Artifact forged before the upgrade never enters the extra pot ───────────────────────────
test("OD-9: an Artifact forged before init_extra is excluded as pre-upgrade in every week, by default; the switch reverts it", () => {
  assert.strictEqual(EXTRA_EXCLUDE_PRE_UPGRADE, true, "the owner sheet's default (OD-9 / D-28)");
  const [H, K] = [W(81), W(82)];
  const mark = { ts: T0 - 10 * DAY, tx: sig(64_000) };
  const mk = (forged: number[]) => forged.map((at, i) => rec(ASSET(40 + i), 3, i === 2 ? K : H, { forgedAt: at }));
  // A: one second before init_extra (the old binary); B: in init_extra's second (counted after it); C: K's, a week later
  const records = mk([mark.ts - 1, mark.ts, mark.ts + WEEK]);
  const b1 = mkBase({ epoch: 1, endTs: T0 + WEEK, snapshot: { slot: 1_000, records } });
  const p = (open: bigint, at: number, init: { ts: number; tx: string } | null = mark): ExtraPoolInfo => ({ ...pool(open, at), init });
  const x1 = buildExtraFile(b1, null, snap(1_000, T0 + WEEK, records), p(0n, T0 + WEEK + 30));
  assert.deepStrictEqual(x1.excluded.map((x) => [x.asset, x.reason]), [[ASSET(40), "pre-upgrade"], [ASSET(41), "new"], [ASSET(42), "new"]], "pre-upgrade first: a permanent reason");
  assert.deepStrictEqual([x1.policy.preUpgradeExcluded, x1.pool.init], [true, mark], "the switch and the boundary are recorded");
  const burns = [{ x1: H, base: 50n * XNT }, { x1: K, base: 50n * XNT }];
  const b2 = mkBase({ epoch: 2, endTs: T0 + 2 * WEEK, startTs: T0 + WEEK + 60, burns, prev: b1, snapshot: { slot: 2_000, records } });
  const x2 = buildExtraFile(b2, x1, snap(2_000, T0 + 2 * WEEK, records), p(1_000n * XNT, T0 + 2 * WEEK + 30));
  assert.deepStrictEqual(x2.excluded, [{ asset: ASSET(40), reason: "pre-upgrade" }], "A stays out, with the same owner and in season");
  assert.deepStrictEqual(rowOf(x2, H)!.artifacts.map((a) => a.asset), [ASSET(41)], "H is paid for B only");
  assert.deepStrictEqual([x2.totals.eligibleArtifacts, x2.totals.eligibleBacking], [2, (2n * BACKING[3]).toString()], "A's backing is not in the bound either (live_forged_backing)");
  assert(payOf(x2, H) > 0n && payOf(x2, K) > 0n, "B and C are paid");
  assert.deepStrictEqual(verifyExtraFile(x2, b2, x1), []);
  // tamper: A slipped into H's row is caught by the recomputation AND by the independent row check
  const bad = clone(x2);
  bad.rows.find((r) => r.wallet === H)!.artifacts.push({ asset: ASSET(40), tier: 3, backing: BACKING[3].toString(), pricePaid: (2n * BACKING[3]).toString(), need: "0" });
  const errs = verifyExtraFile(bad, b2, x1);
  assert(errs.some((e) => /pre-upgrade \(forged before init_extra, OD-9\)/.test(e)), errs.join("; "));
  // the boundary is the pot's creation, carried unchanged: another mark, or none, after a file with one is refused
  assert.throws(() => buildExtraFile(b2, x1, snap(2_000, T0 + 2 * WEEK, records), p(1_000n * XNT, T0 + 2 * WEEK + 30, { ts: mark.ts - 3 * DAY, tx: mark.tx })), /created once \(OD-9\)/);
  assert.throws(() => buildExtraFile(b2, x1, snap(2_000, T0 + 2 * WEEK, records), p(1_000n * XNT, T0 + 2 * WEEK + 30, null)), /created once/);
  assert.throws(() => buildSkipExtraFile(b2, x1, "x", p(0n, T0 + 2 * WEEK + 30, { ts: mark.ts, tx: sig(1) })), /created once/);
  const moved = clone(x2);
  moved.pool.init = { ts: mark.ts - 3 * DAY, tx: mark.tx };
  assert(verifyExtraFile(moved, b2, x1).length > 0, "a file that moves the boundary does not verify");
  // a history that started before the pot existed (no mark) takes the first mark
  const h1 = buildExtraFile(b1, null, snap(1_000, T0 + WEEK, records), p(0n, T0 + WEEK + 30, null));
  assert.deepStrictEqual(h1.excluded.map((x) => x.reason), ["pre-upgrade", "pre-upgrade", "pre-upgrade"], "no pot yet: every FORGED Artifact is pre-upgrade");
  assert.deepStrictEqual(verifyExtraFile(buildExtraFile(b2, h1, snap(2_000, T0 + 2 * WEEK, records), p(1_000n * XNT, T0 + 2 * WEEK + 30)), b2, h1), []);
  // the mark's shape
  for (const v of [{ ts: -1, tx: mark.tx }, { ts: 1, tx: "x" }, { ts: 1, tx: mark.tx, slot: 3 }, [1], "m"]) {
    assert.throws(() => checkedInitMark(v, null), /pool\.init/, JSON.stringify(v));
  }
  assert.strictEqual(checkedInitMark(undefined, null), null);
  // the revert switch (the owner's alternative (b)): with it off nothing is pre-upgrade; with the pot absent, everything is
  assert.deepStrictEqual([isPreUpgrade(mark.ts - 1, mark), isPreUpgrade(mark.ts, mark), isPreUpgrade(mark.ts - 1, mark, false), isPreUpgrade(T0, null), isPreUpgrade(T0, null, false)], [true, false, false, true, false]);
});

test("OD-9: the init_extra mark comes from the chain once the pot is live, never assumed", () => {
  const mark = { ts: T0 - 10 * DAY, tx: sig(64_000) };
  const records = [rec(ASSET(50), 0, W(83))];
  const b1 = mkBase({ epoch: 1, endTs: T0 + WEEK, snapshot: { slot: 1_000, records } });
  const x1 = buildExtraFile(b1, null, snap(1_000, T0 + WEEK, records), { ...pool(0n, T0 + WEEK + 30), init: mark });
  const noMark = buildExtraFile(b1, null, snap(1_000, T0 + WEEK, records), { ...pool(0n, T0 + WEEK + 30), init: null });
  assert.strictEqual(extraInitV3(2, x1, { live: false, init: mark }), null, "not live: no mark");
  assert.deepStrictEqual(extraInitV3(2, x1, { live: true }), mark, "carried from the previous file");
  assert.deepStrictEqual(extraInitV3(2, x1, { live: true, init: mark }), mark);
  assert.throws(() => extraInitV3(2, x1, { live: true, init: { ts: mark.ts + 1, tx: mark.tx } }), /differs/);
  assert.throws(() => extraInitV3(1, null, { live: true }), /not read from the chain/);
  assert.throws(() => extraInitV3(2, noMark, { live: true, init: null }), /not read from the chain/);
  assert.deepStrictEqual(extraInitV3(1, null, { live: true, init: mark }), mark);
  const withPool = { ...b1, freePool: { lamports: "0", slot: 77 } } as unknown as EpochFileV3;
  assert.deepStrictEqual(extraPoolV3(withPool, "5", mark), { open: "5", lamports: "5", slot: 77, init: mark });
});

test("OD-9: the init_extra transaction is recognised by this program's discriminator, with its block time", () => {
  const program = programV3(new anchor.AnchorProvider({} as never, new anchor.Wallet(Keypair.generate()), {}));
  const disc = Buffer.from(((program.rawIdl as anchor.Idl).instructions.find((i) => i.name === "init_extra")!).discriminator);
  const other = Buffer.from(((program.rawIdl as anchor.Idl).instructions.find((i) => i.name === "publish_extra_epoch")!).discriminator);
  const payer = Keypair.generate().publicKey;
  const keys = [payer, PDA_V3.extraState(), program.programId, new PublicKey("11111111111111111111111111111111")];
  const tx = (data: Buffer, o: { err?: unknown; blockTime?: number | null; inner?: boolean; programIndex?: number } = {}) => ({
    blockTime: o.blockTime === undefined ? T0 : o.blockTime,
    transaction: {
      message: {
        getAccountKeys: () => ({ get: (i: number) => keys[i] }),
        compiledInstructions: o.inner
          ? [{ programIdIndex: 3, accountKeyIndexes: [0], data: new Uint8Array(4) }]
          : [{ programIdIndex: o.programIndex ?? 2, accountKeyIndexes: [1, 0, 3], data: new Uint8Array(data) }],
      },
    },
    meta: { err: o.err ?? null, innerInstructions: o.inner ? [{ index: 0, instructions: [{ programIdIndex: 2, accounts: [1, 0], data: bs58.encode(data) }] }] : [] },
  });
  const s = sig(64_001);
  assert.deepStrictEqual(initExtraMarkOfTxV3(program, s, tx(disc)), { ts: T0, tx: s });
  assert.deepStrictEqual(initExtraMarkOfTxV3(program, s, tx(disc, { inner: true })), { ts: T0, tx: s }, "by CPI too");
  assert.strictEqual(initExtraMarkOfTxV3(program, s, tx(other)), null, "another instruction");
  assert.strictEqual(initExtraMarkOfTxV3(program, s, tx(disc, { programIndex: 3 })), null, "another program");
  assert.strictEqual(initExtraMarkOfTxV3(program, s, tx(disc, { err: { InstructionError: [0, "x"] } })), null, "a failed transaction");
  assert.strictEqual(initExtraMarkOfTxV3(program, s, null), null);
  assert.throws(() => initExtraMarkOfTxV3(program, s, tx(disc, { blockTime: null })), /no block time/);
});

// ── 7. property suite ──────────────────────────────────────────────────────────────────────────
const WORLDS = Number(process.env.EXTRA_WORLDS || 400);
const SEED = 20_261_022;
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
const int = (n: number) => Math.floor(rand() * n);
const pick = <T>(xs: T[]): T => xs[int(xs.length)];
const big = (max: bigint) => (BigInt(Math.floor(rand() * 2 ** 48)) * max) / 2n ** 48n;
function shuffled<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = int(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

interface World {
  wallets: string[];
  open: ExtraSnapshotRecord[];
  close: ExtraSnapshotRecord[];
  burns: BaseBurn[];
  X: bigint;
}
function genWorld(id: number): World {
  rand = mulberry32((SEED ^ Math.imul(id + 1, 2_654_435_761)) >>> 0);
  const nW = 1 + int(10);
  const wallets = Array.from({ length: nW }, (_, i) => W(100 + i));
  const outsider = W(99);
  const startTs2 = T0 + WEEK + 60;
  const open: ExtraSnapshotRecord[] = [];
  const close: ExtraSnapshotRecord[] = [];
  let a = 0;
  for (const w of wallets) {
    const n = int(6);
    for (let i = 0; i < n; i++) {
      a++;
      const tier = int(4);
      const origin = rand() < 0.15 ? pick([ORIGIN_GENESIS, ORIGIN_DROP]) : ORIGIN_FORGED;
      const forgedAt = rand() < 0.1 ? startTs2 - SEASON_WEEKS * WEEK - int(3) + 1 : T0 - int(100 * DAY);
      const backing = rand() < 0.1 ? big(200n * XNT) : BACKING[tier];
      const r = rec(ASSET(a), tier, w, { origin, forgedAt, backing, sig: a });
      const fate = rand();
      if (fate < 0.7) {
        open.push(r);
        close.push({ ...r, signature: sig(a + 5_000) });
      } else if (fate < 0.8) open.push(r); // recycled during the week
      else if (fate < 0.9) {
        open.push(r);
        close.push({ ...r, owner: pick([...wallets, outsider]), signature: sig(a + 7_000) }); // transferred (maybe to itself)
      } else close.push(r); // forged during the week
    }
  }
  const burns: BaseBurn[] = [];
  const nB = int(26);
  for (let i = 0; i < nB; i++) {
    const base = rand() < 0.2 ? big(10n * XNT) : rand() < 0.5 ? big(3n * XNT) : big(20_000_000n);
    const lp = (base * 12_500n) / BPS;
    const f = rand();
    const basePaid = f < 0.3 ? 0n : f < 0.5 ? lp : big(lp + 1n);
    burns.push({ x1: rand() < 0.1 ? outsider : pick(wallets), base, lp, basePaid, tier: int(3) });
  }
  const X = rand() < 0.1 ? 0n : rand() < 0.5 ? big(1_000_000n * XNT) : big(100n * XNT);
  return { wallets, open, close, burns, X };
}

/** independent mirror of A10.3–A10.5 */
function mirror(w: World, bases: EpochFileV3[]) {
  const startTs = bases[1].window.startTs;
  const prevOwner = new Map(w.open.map((r) => [r.asset, r.owner]));
  const need = new Map<string, bigint>();
  const backing = new Map<string, bigint>();
  const eligible: string[] = [];
  for (const r of w.close) {
    if (r.origin !== ORIGIN_FORGED || prevOwner.get(r.asset) !== r.owner || r.forgedAt + SEASON_WEEKS * WEEK <= startTs) continue;
    eligible.push(r.asset);
    need.set(r.owner, (need.get(r.owner) ?? 0n) + (2n * BigInt(r.backing)) / 100n);
    backing.set(r.owner, (backing.get(r.owner) ?? 0n) + BigInt(r.backing));
  }
  const use = new Map<string, bigint>();
  for (const b of bases[1].burns) {
    const lp = BigInt(b.lp);
    const paid = BigInt(b.basePaid);
    const u = lp > 0n && paid < lp ? (BigInt(b.base) * (lp - paid)) / lp : 0n;
    use.set(b.x1, (use.get(b.x1) ?? 0n) + u);
  }
  const counted = new Map<string, bigint>();
  let Wsum = 0n;
  for (const [o, nd] of need) {
    const c = min(use.get(o) ?? 0n, nd);
    counted.set(o, c);
    Wsum += c;
  }
  const R = (w.X * 8n) / 100n;
  const B = Wsum > 0n ? min(R, 2n * Wsum) : 0n;
  const pay = new Map<string, bigint>();
  for (const [o, c] of counted) {
    const p = Wsum > 0n ? (c * B) / Wsum : 0n;
    pay.set(o, p < MIN_PAY ? 0n : p);
  }
  return { eligible: eligible.sort(), need, use, counted, pay, W: Wsum, R, B, backing };
}

const stats = { worlds: 0, rows: 0, leaves: 0, paid: 0, sybil: 0, sybilGain: 0n, burnSplits: 0, burnSplitExcess: 0n, parity: 0, cap: 0, more: 0, capped: 0, moved: 0, gone: 0, season: 0, zeroX: 0, rateCapped: 0 };
const started = Date.now();

function buildWorld(w: World, close = w.close, burns = w.burns, open = w.open): { bases: EpochFileV3[]; extras: ExtraFileV1[] } {
  return run([{ records: open }, { records: close, burns, X: w.X }]);
}

for (let id = 0; id < WORLDS; id++) {
  const w = genWorld(id);
  stats.worlds++;
  if (w.X === 0n) stats.zeroX++;
  const frozen = deepFreeze(structuredClone(w));
  const before = stringifyBig(frozen);
  const { bases, extras } = buildWorld(frozen);
  assert.strictEqual(stringifyBig(frozen), before, `world ${id}: inputs changed`);
  const base2 = deepFreeze(bases[1]);
  const base2Json = JSON.stringify(base2);
  const f = extras[1];
  stats.rows += f.rows.length;
  stats.leaves += f.leaves.length;
  stats.paid += f.leaves.length;

  // 7.1 verify round trip, bounds, rate ≤ 2x, mirror agreement
  assert.deepStrictEqual(verifyExtraFile(f, base2, extras[0]), [], `world ${id}: verify`);
  assert.deepStrictEqual(verifyExtraFile(extras[0], bases[0], null), [], `world ${id}: verify first`);
  assert.strictEqual(JSON.stringify(base2), base2Json, `world ${id}: base file changed by the extra`);
  assert.strictEqual(dataHashV3(base2), base2.dataHash);
  const m = mirror(w, bases);
  const budget = BigInt(f.totals.budget);
  assert(budget <= (w.X * EXTRA_RELEASE_BPS) / BPS, `world ${id}: budget above 8% of X`);
  assert(budget <= (BigInt(f.totals.eligibleBacking) * EXTRA_BACKING_BOUND_BPS) / BPS, `world ${id}: budget above 4% of the eligible backing`);
  assert(budget <= min(m.R, 2n * m.W), `world ${id}: budget above min(R, 2W)`);
  assert(f.leaves.length <= EXTRA_MAX_LEAVES);
  assert.deepStrictEqual(f.rows.flatMap((r) => r.artifacts.map((x) => x.asset)).sort(), m.eligible, `world ${id}: eligible set`);
  for (const r of f.rows) {
    assert.strictEqual(BigInt(r.need), m.need.get(r.wallet), `world ${id}: need ${r.wallet}`);
    assert.strictEqual(BigInt(r.use), m.use.get(r.wallet) ?? 0n, `world ${id}: use ${r.wallet}`);
    assert.strictEqual(BigInt(r.counted), m.counted.get(r.wallet), `world ${id}: counted ${r.wallet}`);
    assert.strictEqual(BigInt(r.pay), m.pay.get(r.wallet), `world ${id}: pay ${r.wallet}`);
    assert(BigInt(r.pay) <= (BigInt(r.counted) * RHO_MAX_BPS) / BPS, `world ${id}: rate above 2x for ${r.wallet}`);
    assert(BigInt(r.pay) === 0n || BigInt(r.pay) >= MIN_PAY);
    if (BigInt(r.counted) === BigInt(r.need) && BigInt(r.use) > BigInt(r.need)) stats.capped++;
  }
  if (m.W > 0n && m.B === m.R && 2n * m.W > m.R) stats.rateCapped++;
  // the moved / gone / season Artifacts give no claim
  const closeOwner = new Map(w.close.map((r) => [r.asset, r.owner]));
  for (const r of w.open) {
    if (r.origin !== ORIGIN_FORGED) continue;
    const now = closeOwner.get(r.asset);
    if (now === undefined) stats.gone++;
    else if (now !== r.owner) stats.moved++;
    if (now === undefined || now !== r.owner) assert(!m.eligible.includes(r.asset) && !f.rows.some((x) => x.artifacts.some((y) => y.asset === r.asset)), `world ${id}: ${r.asset} claims after a move or recycle`);
  }
  stats.season += f.excluded.filter((e) => e.reason === "season").length;

  // 7.2 per-XNT parity: equal counted ⇒ equal pay, and any two paid rows share the rate up to the floor
  const paidRows = f.rows.filter((r) => BigInt(r.pay) > 0n);
  for (let i = 0; i < paidRows.length; i++) {
    for (let j = i + 1; j < paidRows.length; j++) {
      const [pi, ci] = [BigInt(paidRows[i].pay), BigInt(paidRows[i].counted)];
      const [pj, cj] = [BigInt(paidRows[j].pay), BigInt(paidRows[j].counted)];
      assert(abs(pi * cj - pj * ci) < (ci > cj ? ci : cj), `world ${id}: rate differs between ${paidRows[i].wallet} and ${paidRows[j].wallet}`);
      stats.parity++;
    }
  }
  // tier mix: a wallet with Void → 20 Lunar, Solar → 6 Lunar (same need, same burns) is paid the same
  const holder = f.rows.find((r) => r.artifacts.some((x) => (x.tier === 3 || x.tier === 2) && BigInt(x.backing) === BACKING[x.tier]));
  if (holder) {
    const twin = W(200);
    let k = 9_000;
    const lunarize = (r: ExtraSnapshotRecord): ExtraSnapshotRecord[] => {
      if (r.origin !== ORIGIN_FORGED || !(r.tier === 3 || r.tier === 2) || BigInt(r.backing) !== BACKING[r.tier]) return [{ ...r, asset: ASSET(++k), owner: twin }];
      return Array.from({ length: r.tier === 3 ? 20 : 6 }, () => ({ ...r, asset: ASSET(++k), owner: twin, tier: 0, backing: BACKING[0].toString() }));
    };
    const twinOpen = w.open.filter((r) => r.owner === holder.wallet && closeOwner.get(r.asset) === holder.wallet).flatMap(lunarize);
    const ids = new Map(twinOpen.map((r, i) => [i, r.asset]));
    k = 9_000;
    const twinClose = w.close.filter((r) => r.owner === holder.wallet && w.open.some((o) => o.asset === r.asset && o.owner === holder.wallet)).flatMap(lunarize);
    assert.strictEqual(twinClose.length, twinOpen.length);
    twinClose.forEach((r, i) => assert.strictEqual(r.asset, ids.get(i)));
    const twinBurns = w.burns.filter((b) => b.x1 === holder.wallet).map((b) => ({ ...b, x1: twin }));
    const g = buildWorld(w, [...w.close, ...twinClose], [...w.burns, ...twinBurns], [...w.open, ...twinOpen]).extras[1];
    assert.strictEqual(rowOf(g, twin)!.need, holder.need, `world ${id}: lunarized need`);
    assert.strictEqual(rowOf(g, twin)!.counted, rowOf(g, holder.wallet)!.counted);
    assert.strictEqual(rowOf(g, twin)!.pay, rowOf(g, holder.wallet)!.pay, `world ${id}: a Void and 20 Lunars with the same use are paid the same`);
    stats.parity++;
  }

  // 7.3 sybil: splitting a wallet's Artifacts and burns over k wallets (held the same way in both snapshots) never pays the group more
  const victim = f.rows.find((r) => r.artifacts.length > 0);
  if (victim) {
    const kk = 2 + int(3);
    const parts = Array.from({ length: kk }, (_, i) => W(300 + i));
    const where = new Map<string, string>();
    for (const r of w.open) if (r.owner === victim.wallet) where.set(r.asset, pick(parts));
    const move = (r: ExtraSnapshotRecord) => (r.owner === victim.wallet ? { ...r, owner: where.get(r.asset) ?? pick(parts) } : r);
    const sOpen = w.open.map(move);
    const sClose = w.close.map(move);
    const sBurns = w.burns.map((b) => (b.x1 === victim.wallet ? { ...b, x1: pick(parts) } : b));
    const g = buildWorld(w, sClose, sBurns, sOpen).extras[1];
    const group = sum(parts.map((p) => payOf(g, p)));
    assert(group <= BigInt(victim.pay), `world ${id}: a split of ${victim.wallet} into ${kk} wallets pays ${group} > ${victim.pay}`);
    stats.sybil++;
    if (BigInt(victim.pay) > group) stats.sybilGain += BigInt(victim.pay) - group;
    // splitting one burn into engine-like pieces (lp = ⌊1.25 × base⌋, FCFS basePaid): at most 1 lamport of counted per piece
    const vb = w.burns.map((b, i) => [b, i] as const).filter(([b]) => b.x1 === victim.wallet && b.base > 3n);
    if (vb.length) {
      const [b, i] = pick(vb);
      const pieces = 2 + int(3);
      let left = b.base;
      let paidLeft = b.basePaid ?? 0n;
      const parts2: BaseBurn[] = [];
      for (let p = 0; p < pieces; p++) {
        const part = p === pieces - 1 ? left : min(left, 1n + big(left));
        left -= part;
        const lp = (part * 12_500n) / BPS;
        const paid = min(lp, paidLeft);
        paidLeft -= paid;
        parts2.push({ x1: b.x1, base: part, lp, basePaid: paid, tier: b.tier });
      }
      const pBurns = [...w.burns.slice(0, i), ...parts2, ...w.burns.slice(i + 1)];
      const g2 = buildWorld(w, w.close, pBurns).extras[1];
      const uWhole = BigInt(victim.use);
      const uPieces = BigInt(rowOf(g2, victim.wallet)!.use);
      assert(uPieces <= uWhole + BigInt(pieces - 1), `world ${id}: burn split gains ${uPieces - uWhole} lamports of use`);
      if (uPieces > uWhole) stats.burnSplitExcess = uPieces - uWhole > stats.burnSplitExcess ? uPieces - uWhole : stats.burnSplitExcess;
      stats.burnSplits++;
    }
  }

  // 7.4 cap by need and monotonicity: more use never pays less; above the need it pays nothing more
  if (victim) {
    const extra = { x1: victim.wallet, base: 1n + big(3n * XNT), basePaid: 0n };
    const g = buildWorld(w, w.close, [...w.burns, extra]).extras[1];
    const pv = BigInt(victim.pay);
    const pg = payOf(g, victim.wallet);
    assert(pg >= pv, `world ${id}: burning more paid ${victim.wallet} less (${pg} < ${pv})`);
    stats.more++;
    if (BigInt(victim.use) >= BigInt(victim.need)) {
      assert.deepStrictEqual(g.rows.map((r) => [r.wallet, r.counted, r.pay]), f.rows.map((r) => [r.wallet, r.counted, r.pay]), `world ${id}: a burn above the need changed a pay`);
      assert.strictEqual(g.totals.budget, f.totals.budget);
      stats.cap++;
    }
  }

  // 7.5 determinism: shuffled records give byte-identical files; shuffled base burns change only the base hash
  const d = buildWorld(w, shuffled(w.close), w.burns, shuffled(w.open));
  assert.strictEqual(JSON.stringify(d.extras[0]), JSON.stringify(extras[0]), `world ${id}: first extra differs on shuffled input`);
  assert.strictEqual(JSON.stringify(d.extras[1]), JSON.stringify(f), `world ${id}: extra differs on shuffled input`);
  const e = buildWorld(w, w.close, shuffled(w.burns));
  const strip = (x: ExtraFileV1) => JSON.stringify({ ...x, baseDataHash: null, dataHash: null });
  assert.strictEqual(strip(e.extras[1]), strip(f), `world ${id}: extra differs on shuffled burns`);
}

assert(stats.sybil > 0 && stats.burnSplits > 0 && stats.parity > 0 && stats.cap > 0 && stats.more > 0, "coverage: every property was exercised");
assert(stats.capped > 0 && stats.moved > 0 && stats.gone > 0 && stats.season > 0 && stats.zeroX > 0 && stats.rateCapped > 0 && stats.paid > 0, "coverage: capped wallets, moves, recycles, season exits, X = 0, rate below 2x");
console.log(
  `extra property suite: ${stats.worlds} worlds (seed ${SEED}), ${stats.rows} rows, ${stats.leaves} leaves, ${((Date.now() - started) / 1000).toFixed(1)} s\n` +
    `  coverage: ${stats.capped} wallets capped by need, ${stats.moved} moved / ${stats.gone} recycled Artifacts, ${stats.season} season exits, ${stats.zeroX} empty pots, ${stats.rateCapped} weeks with rho < 2\n` +
    `  checked: sybil ${stats.sybil} wallet splits (merged − split max gain kept by the pot: ${stats.sybilGain} lamports total), ${stats.burnSplits} burn splits (max use excess ${stats.burnSplitExcess} lamports), ` +
    `parity ${stats.parity}, cap ${stats.cap}, monotone ${stats.more}`,
);

Promise.all(pending).then(() => {
  console.log(`extra tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
});
