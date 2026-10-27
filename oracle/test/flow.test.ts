/**
 * Rewards v3 plumbing (src/flow-v3.ts, amendment A11): a dry build against recorded fixtures (the REAL epoch-1.json
 * plus synthetic burns, test/fixtures), chain skipping with the cursor carried, mission-id gap detection against the
 * portal counter, the version switch from the real epoch-1 file, the window-end retry, the publish record and the
 * extra heartbeat. No network: every source is replayed from test/fixtures/flow-v3-epoch2.json.
 */
import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { CHAINS, ChainConfig } from "../src/config";
import { Burn } from "../src/evm";
import { EpochFile } from "../src/epoch";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { baseSnapshotSkipReason, computeExtraEpoch, verifyExtraFile } from "../src/extra";
import { MPL_CORE, PDA } from "../src/x1";
import { artifactSnapshotV3, assetSignaturesV3 } from "../src/x1-v3";
import { catchUpExtrasV3, extraCreatedAtV3, extraPoolV3, ExtraRecoverySourcesV3, publishGateV3, readPublishClockV3, rebuildExtraV3 } from "../src/flow-v3";
import { publishEpochV3 } from "../src/x1-v3";
import { computeEpochV3, dataHashV3, EpochFileV3, MAX_PUBLISH_LAG, MIN_WINDOW, provisionalReasonOf, rebuildReason } from "../src/rewards";
import {
  assembleInputsV3, buildExtraAfterBaseV3, buildV3, candleReadings, claimPlanV3, emptyRecording, fixtureSources, lastMissionIds, missionContinuity, prevCursor,
  publishDecisionV3, publishRecordV3, PublishedRecordV3, RecordedSourcesV3, recordingSources, rewardsVersionFor, rewardsVersionGatedV3, V2_BOUNDARY_TS_DEFAULT, V2_CLOSED_TEXT, v2BoundaryTsV3, v2ClosedV3, baseDueAfterExtraV3, EXTRA_LAG_MARGIN, sealAllowedV3, SourcesV3, toPublishedEpochV3, v2SwitchFiles, withRetries,
  claimsLineV3, dailyReleaseV3, gatedSealActionV3, gatedSealDueAt, historyFor, keeperFilesV3, NotDueV3, postPublishReport, refreshSnapshotIfOldV3, rpcOrderV3, SLOT_HASHES_DEPTH,
  snapshotTooOld, staleEpochs,
} from "../src/flow-v3";
import { oldestSignature, signaturePages, sweepableEpoch } from "../src/x1-v3";
import { candleWindowV3 } from "../src/pricing";
import { claimsVerdict, DUST_CLAIMS_WARN } from "../src/health-rules";
import { AnyEpochFile, DEFAULT_RULES_V3, KEEPER_TIP_MIN_CLAIM, MIN_EPOCH_INTERVAL, programClaims, retiredBaseTerms, switchRefsFromV2, verifyAny, verifyChainLinkV3, verifyChainSetV3, verifyPublishedV3, WEEK } from "../src/rewards";
import { countersMissingV3, rulesForEpochV3, rulesInForceErrorV3 } from "../src/rules-v3";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${(e as Error).stack ?? String(e)}`);
  }
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────
const FIX = path.join(__dirname, "fixtures");
const epoch1: EpochFile = JSON.parse(fs.readFileSync(path.join(FIX, "epoch-1.json"), "utf8"));
const fixture: { recording: RecordedSourcesV3; expect?: { root: string; totalScore: string; leaves: number } } = JSON.parse(fs.readFileSync(path.join(FIX, "flow-v3-epoch2.json"), "utf8"));
/** real: published_at, slot and the full budget of epoch 1; synthetic: the pool before the publication (the fixture's 300 XNT) */
const REAL = { publishedAt: 1_792_287_484, publishSlot: 86_728_945, fullBudget: 431_510_418n, freePoolBefore: 300_000_000_000n };
/** the configured chains with the real portal of the epoch-1 file on the five live chains */
const PORTAL = epoch1.chains[0].portal;
const chains: ChainConfig[] = CHAINS.map((c) => ({ ...c, portal: epoch1.chains.some((x) => x.chainId === c.chainId) ? PORTAL : "" }));
const live = chains.filter((c) => c.portal);
const rec = (): RecordedSourcesV3 => JSON.parse(JSON.stringify(fixture.recording));
const quiet = () => {};
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** fixture sources with some calls overridden */
const withOverrides = (r: RecordedSourcesV3, o: Partial<SourcesV3>): SourcesV3 => ({ ...fixtureSources(r), ...o });

async function main() {
  await test("the fixture's epoch-1.json is the real published file (when the repository copy is next to the oracle)", () => {
    const real = path.join(__dirname, "..", "..", "frontend", "public", "epochs", "epoch-1.json");
    if (fs.existsSync(real)) assert.strictEqual(fs.readFileSync(real, "utf8"), fs.readFileSync(path.join(FIX, "epoch-1.json"), "utf8"));
    assert.strictEqual(epoch1.version, 2);
    assert.strictEqual(epoch1.publish!.slot, REAL.publishSlot);
    assert.deepStrictEqual(verifyAny(epoch1, null), [], "the real v2 file verifies under the v2 rules");
  });

  // ── version switch ───────────────────────────────────────────────────────────────────────────
  await test("A11.1: REWARDS_VERSION / V3_FIRST_EPOCH select v3 from the switch epoch on; a v3 previous file forces v3", () => {
    assert.strictEqual(rewardsVersionFor(2, epoch1, {}, null), 2, "default: v2, byte-for-byte the live path");
    assert.strictEqual(rewardsVersionFor(2, epoch1, { REWARDS_VERSION: "2" }, null), 2);
    assert.strictEqual(rewardsVersionFor(2, epoch1, { REWARDS_VERSION: "3" }, null), 3);
    assert.strictEqual(rewardsVersionFor(2, epoch1, { V3_FIRST_EPOCH: "3" }, null), 2, "before the first v3 epoch: v2");
    assert.strictEqual(rewardsVersionFor(3, epoch1, { V3_FIRST_EPOCH: "3" }, null), 3);
    assert.strictEqual(rewardsVersionFor(9, epoch1, { V3_FIRST_EPOCH: "3", REWARDS_VERSION: "2" }, null), 3, "the first-epoch setting wins over REWARDS_VERSION");
    assert.strictEqual(rewardsVersionFor(2, epoch1, { REWARDS_VERSION: "3" }, 3), 2, "the pinned constant wins over the environment");
    assert.strictEqual(rewardsVersionFor(3, null, {}, 3), 3);
    const v3prev = { version: 3, epoch: 2 };
    assert.throws(() => rewardsVersionFor(3, v3prev, { REWARDS_VERSION: "2" }, null), /never goes back/);
    assert.throws(() => rewardsVersionFor(3, v3prev, {}, null), /never goes back/, "a v3 history is never continued as v2 by default either");
    assert.strictEqual(rewardsVersionFor(3, v3prev, { REWARDS_VERSION: "3" }, null), 3);
    assert.throws(() => rewardsVersionFor(2, epoch1, { REWARDS_VERSION: "4" }, null), /expected 2 or 3/);
    assert.throws(() => rewardsVersionFor(2, epoch1, { V3_FIRST_EPOCH: "x" }, null), /not an epoch number/);
  });

  await test("R-2: the base epoch waits until the last paying extra is 6 days + 2 h old, so the extra sent minutes after it is never refused; jitter and a late extra cannot start the one-week lag", () => {
    const D = 86_400;
    assert.strictEqual(EXTRA_LAG_MARGIN, 2 * 3_600);
    assert.deepStrictEqual(baseDueAfterExtraV3(0, 5), { ready: 0, wait: 0 }, "no paying extra yet: due");
    // the review's case: extra n−1 landed 40 min after its base; the late week's re-dispatch would publish base n at
    // 6 days + 3 min, and extra n 5 min later, 35 min sooner than the program allows: now the base waits
    const b1 = 1_800_000_000;
    const x1 = b1 + 40 * 60;
    const early = baseDueAfterExtraV3(x1, b1 + 6 * D + 180);
    assert.strictEqual(early.ready, x1 + 6 * D + 2 * 3_600);
    assert(early.wait > 0);
    // published at `ready`, its extra lands minutes later: at least MIN_EPOCH_INTERVAL after extra n−1, whatever the delay
    for (const delay of [0, 60, 300, 3_600]) assert(early.ready + delay >= x1 + 6 * D, `extra n ${delay} s after its base`);
    // a pending extra published late (just before base n): base n waits a whole interval, then the lag is gone
    const late = b1 + 7 * D - 600;
    assert.strictEqual(baseDueAfterExtraV3(late, b1 + 7 * D).wait, 6 * D + 2 * 3_600 - 600);
    assert.strictEqual(baseDueAfterExtraV3(late, late + 6 * D + 2 * 3_600).wait, 0);
  });

  await test("R-3: the version is gated by the live program's verdict (v3 only on the upgraded binary; v2 while S6 is late; never a v2 epoch on the upgraded binary; fail closed on unknown)", () => {
    // a fixed time before the C-14 boundary, so the R-3 cases below do not change meaning when the calendar passes it
    const BEFORE = V2_BOUNDARY_TS_DEFAULT - 86_400;
    const g = (epoch: number, prev: any, verdict: "upgraded" | "legacy" | "unknown", env: Record<string, string> = {}, pinned: number | null = null) => rewardsVersionGatedV3(epoch, prev, verdict, env, pinned, BEFORE);
    // the live v2 binary: exactly main's v2 path, whatever the selection says (S6 late: a warning, no refused runs)
    assert.deepStrictEqual(g(2, epoch1, "legacy"), { version: 2, warning: null, v2Closed: false }, "legacy, nothing selected: v2, silent");
    const late = g(5, epoch1, "legacy", {}, 5);
    assert.strictEqual(late.version, 2);
    assert.match(late.warning!, /S6 is not live yet/);
    assert.match(g(5, epoch1, "legacy", { REWARDS_VERSION: "3" }).warning!, /S6 is not live yet/);
    // the upgraded binary: v3 when selected; by detection when nothing is selected
    assert.deepStrictEqual(g(5, epoch1, "upgraded", {}, 5), { version: 3, warning: null, v2Closed: false });
    const det = g(5, epoch1, "upgraded");
    assert.strictEqual(det.version, 3, "nothing pinned: the detection switches the rules on by itself");
    assert.match(det.warning!, /first v3 epoch, switched on by the detection/);
    // never a v2 epoch on the upgraded binary (claims on hold, no drop reserve, no extra epoch: the pot's chain would stop)
    assert.throws(() => g(4, epoch1, "upgraded", {}, 6), /Re-pin V3_FIRST_EPOCH to 4/);
    assert.throws(() => g(4, epoch1, "upgraded", { REWARDS_VERSION: "2" }), /environment selects the v2 rules/);
    assert.throws(() => g(4, epoch1, "upgraded", { V3_FIRST_EPOCH: "7" }), /environment selects the v2 rules/);
    // unknown (an RPC error, a half-done upgrade): v3 refused, v2 as main
    assert.throws(() => g(5, epoch1, "unknown", {}, 5), /verdict is unknown/);
    assert.throws(() => g(5, epoch1, "unknown", { REWARDS_VERSION: "3" }), /fail closed/);
    assert.deepStrictEqual(g(5, epoch1, "unknown"), { version: 2, warning: null, v2Closed: false });
    // a v3 history continues as v3 with nothing set; a selection of v2 for it is still refused; a rollback reaches
    // publishEpochV3, which refuses a binary that is not the upgraded one
    const v3prev = { version: 3, epoch: 5 };
    assert.deepStrictEqual(g(6, v3prev, "upgraded"), { version: 3, warning: null, v2Closed: false });
    assert.deepStrictEqual(g(6, v3prev, "legacy"), { version: 3, warning: null, v2Closed: false });
    assert.deepStrictEqual(g(6, v3prev, "upgraded", {}, 5), { version: 3, warning: null, v2Closed: false });
    assert.throws(() => g(6, v3prev, "upgraded", { REWARDS_VERSION: "2" }), /never goes back/);
    assert.throws(() => g(6, v3prev, "upgraded", {}, 7), /never goes back/);
    // C-14 (r4-fix, review r4 finding 2): from the v2 boundary (Monday 2026-11-09 06:00 UTC) no v2 epoch is built, also
    // when S6 slips: every outcome that would be v2 is v2Closed; the upgraded binary and a v3 history are unaffected
    const AT = V2_BOUNDARY_TS_DEFAULT;
    const gAt = (now: number, epoch: number, prev: any, verdict: "upgraded" | "legacy" | "unknown", env: Record<string, string> = {}, pinned: number | null = null) => rewardsVersionGatedV3(epoch, prev, verdict, env, pinned, now);
    assert.strictEqual(V2_BOUNDARY_TS_DEFAULT, Date.UTC(2026, 10, 9, 6, 0, 0) / 1000, "Monday 2026-11-09 06:00 UTC");
    assert.strictEqual(gAt(AT - 1, 2, epoch1, "legacy").v2Closed, false, "one second before: the last v2 epoch may still be built");
    for (const [verdict, pin] of [["legacy", null], ["legacy", 5], ["unknown", null]] as ["legacy" | "unknown", number | null][]) {
      const c = gAt(AT, 5, epoch1, verdict, {}, pin);
      assert.deepStrictEqual([c.version, c.v2Closed], [2, true], `${verdict} pin ${pin}`);
      assert.match(c.warning!, new RegExp(V2_CLOSED_TEXT));
      assert.strictEqual(V2_CLOSED_TEXT, "v2 closed at the boundary: later burns wait for the first v3 epoch with their own time");
    }
    assert.deepStrictEqual(gAt(AT + 30 * 86_400, 5, epoch1, "upgraded", {}, 5), { version: 3, warning: null, v2Closed: false }, "the upgraded binary: v3 as before");
    assert.deepStrictEqual(gAt(AT + 30 * 86_400, 6, v3prev, "legacy"), { version: 3, warning: null, v2Closed: false }, "a v3 history is never v2");
    assert.throws(() => gAt(AT, 5, epoch1, "unknown", {}, 5), /verdict is unknown/, "unknown + v3 still fails closed");
    // the rehearsal override (localnet only; no workflow sets it), and a malformed value keeps the default
    assert.strictEqual(v2ClosedV3(AT, { V2_BOUNDARY_TS: String(AT + 10) }), false);
    assert.strictEqual(v2ClosedV3(AT, { V2_BOUNDARY_TS: "soon" }), true);
    assert.strictEqual(v2BoundaryTsV3({}), V2_BOUNDARY_TS_DEFAULT);
  });

  // ── file helpers ─────────────────────────────────────────────────────────────────────────────
  await test("lastMissionIds, v2SwitchFiles and prevCursor read the local files", () => {
    const last = lastMissionIds([epoch1]);
    assert.deepStrictEqual([...last.entries()], [[10, 1n]], "the real epoch 1 paid mission 1 on Optimism only");
    const v3ish = { ...clone(epoch1), version: 3, epoch: 2 } as unknown as AnyEpochFile;
    assert.deepStrictEqual(v2SwitchFiles([v3ish, epoch1], 1).map((f) => f.epoch), [1]);
    assert.deepStrictEqual(v2SwitchFiles([epoch1], 0), []);
    assert.strictEqual(prevCursor(epoch1, 56), 128_273_320);
    assert.strictEqual(prevCursor(epoch1, 369), undefined);
    assert.strictEqual(prevCursor(null, 10), undefined);
  });

  // ── mission continuity ───────────────────────────────────────────────────────────────────────
  await test("A11.3: mission ids must run contiguously from the last paid id up to portal.totalMissions, else the chain is skipped", () => {
    const ids = (...xs: number[]) => xs.map((x) => ({ missionId: String(x) }));
    assert.deepStrictEqual(missionContinuity(ids(2, 3), 1n, 3n, "1"[0] === "1" ? 1n : null), { error: null, warning: null, probe: null });
    assert.deepStrictEqual(missionContinuity(ids(3, 2), 1n, 3n, null), { error: null, warning: null, probe: null }, "order does not matter");
    assert.deepStrictEqual(missionContinuity([], 1n, 1n, 1n), { error: null, warning: null, probe: null }, "a quiet week");
    assert.match(missionContinuity(ids(2, 4), 1n, 4n, null).error ?? "", /omitted logs/, "a missing log shows as a short read");
    assert.match(missionContinuity(ids(2, 4), 1n, 4n, 1n).error ?? "", /omitted logs/);
    assert.match(missionContinuity(ids(2, 2, 3), 1n, 3n, null).error ?? "", /duplicate ids/);
    assert.match(missionContinuity(ids(2, 3, 3), 1n, 3n, null).error ?? "", /duplicate ids/, "a duplicate id");
    assert.match(missionContinuity(ids(2, 2), 1n, 3n, null).error ?? "", /contiguously/, "a duplicate in place of a missing id");
    assert.match(missionContinuity(ids(3, 4), 1n, 4n, null).error ?? "", /omitted logs/, "the first id after the cursor is missing");
    assert.match(missionContinuity(ids(2), 1n, 1n, null).error ?? "", /duplicate ids or a wrong counter/, "a log the counter does not know: wrong RPC state");
    assert.match(missionContinuity([], 3n, 2n, null).error ?? "", /below/, "the counter went backwards");
    assert.match(missionContinuity([], 3n, 3n, 2n).error ?? "", /below the last mission already paid/, "the counter at the cursor contradicts the files");
    const w = missionContinuity(ids(4), 1n, 4n, 3n);
    assert.strictEqual(w.error, null);
    assert.match(w.warning ?? "", /never paid/, "missions before the cursor that no file paid are reported, not re-read");
  });

  await test("P5: without the counter at the cursor, one probe for mission lastPaid + 1 tells a lost mission before the cursor from omitted logs", () => {
    const ids = (...xs: number[]) => xs.map((x) => ({ missionId: String(x) }));
    // review repro R3: Optimism, mission 1 paid by v2, mission 2 before the cursor and in no file, mission 3 in range
    const unprobed = missionContinuity(ids(3), 1n, 3n, null);
    assert(unprobed.error && /omitted logs/.test(unprobed.error) && unprobed.probe === 2n, `${unprobed.error} / probe ${unprobed.probe}`);
    const found = missionContinuity(ids(3), 1n, 3n, null, true);
    assert.strictEqual(found.error, null, "found before the cursor: the chain is paid");
    assert.match(found.warning ?? "", /missions 2\.\.2 are before the cursor .* never paid/, "the same A11-b warning an archive RPC gives");
    assert.deepStrictEqual(found, missionContinuity(ids(3), 1n, 3n, 2n), "the same outcome as with the counter at the cursor");
    assert.match(missionContinuity(ids(3), 1n, 3n, null, false).error ?? "", /omitted logs/, "not found: the logs were omitted");
    assert.strictEqual(missionContinuity(ids(2, 4), 1n, 4n, null).probe, null, "a gap inside the range is never a mission before the cursor");
    // hosts that refuse historical state are tried last (live probe: publicnode 403 on every blockTag, blxrbdn beyond 128 blocks)
    assert.deepStrictEqual(rpcOrderV3(["https://bsc-rpc.publicnode.com", "https://bsc.rpc.blxrbdn.com", "https://bsc-mainnet.nodereal.io/v1/x"]), ["https://bsc-mainnet.nodereal.io/v1/x", "https://bsc-rpc.publicnode.com", "https://bsc.rpc.blxrbdn.com"]);
    assert.deepStrictEqual(rpcOrderV3(["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"]), ["https://mainnet.optimism.io", "https://optimism-rpc.publicnode.com"]);
  });

  await test("candle readings: the engine's median and last close, or fallback", () => {
    assert.deepStrictEqual(candleReadings(null), { medianE18: "0", lastCloseE18: "0", source: "fallback" });
    assert.deepStrictEqual(candleReadings([]), { medianE18: "0", lastCloseE18: "0", source: "fallback" });
    assert.deepStrictEqual(candleReadings(["3", "1", "2"]), { medianE18: "2", lastCloseE18: "2", source: "candles" });
    assert.deepStrictEqual(candleReadings(["4", "1", "2", "3"]), { medianE18: "2", lastCloseE18: "3", source: "candles" });
    assert.deepStrictEqual(candleReadings(["4", "0"]), { medianE18: "0", lastCloseE18: "0", source: "fallback" }, "a zero close is no reading");
    assert.deepStrictEqual(candleReadings(["4", "x"]).source, "fallback");
  });

  // ── the dry build on the recorded fixture: the switch from the real epoch-1.json ─────────────
  const base = await assembleInputsV3(2, epoch1, fixtureSources(rec()), chains, [epoch1], quiet);
  const built = buildV3(base.inputs, epoch1);

  await test("A11.2: the dry build on the fixture: window on X1's clock, cursors from the real file, switch refs, every chain read", () => {
    assert.deepStrictEqual(base.skipped, []);
    assert.deepStrictEqual(base.warnings, []);
    const i = base.inputs;
    assert.deepStrictEqual(i.window, { startTs: REAL.publishedAt, endTs: fixture.recording.snapshot[0].blockTime }, "start = epoch 1's published_at, end = the snapshot slot's block time (A8)");
    assert.strictEqual(i.freePool.open, (REAL.freePoolBefore - REAL.fullBudget).toString(), "F_ref = free_pool_before − the full budget (A2)");
    assert.strictEqual(i.epoch, 2);
    assert.strictEqual(i.programId, epoch1.programId);
    assert.deepStrictEqual(i.switchRefs, switchRefsFromV2([epoch1]), "the switch epoch carries the v2 reference history");
    assert.deepStrictEqual(i.chains.map((c) => [c.chainId, c.fromBlockExclusive]), epoch1.chains.map((c) => [c.chainId, c.toBlock]), "every cursor continues from the real file's toBlock");
    for (const c of i.chains) assert(c.toBlock > c.fromBlockExclusive);
    assert.strictEqual(i.snapshot.records.length, 1);
    assert(!("pendingLuck" in i), "A13.1: a v3 epoch has no drop reserve, so no drop luck enters the build");
    assert.strictEqual(i.createdAt, fixture.recording.now);
    assert.deepStrictEqual(publishDecisionV3(i.window), { ok: true, reason: "" });
  });

  await test("A11.2: the built file verifies against the real previous file, pins the switch, prices burns by the recorded candles", () => {
    assert(built.file, "the fixture pays somebody");
    const f = built.file!;
    assert.deepStrictEqual(built.unpriced, []);
    assert.deepStrictEqual(verifyAny(f, epoch1), []);
    assert.deepStrictEqual(verifyChainSetV3(f, epoch1, live), []);
    assert.strictEqual(f.v3FirstEpoch, 2);
    assert.strictEqual(f.prevDataHash, epoch1.dataHash);
    assert.deepStrictEqual(f.chains.map((c) => c.skipped), [false, false, false, false, false]);
    assert.strictEqual(f.burns.length, 4);
    const avax = f.burns.find((b) => b.chainId === 43114)!;
    assert.deepStrictEqual([avax.priceSource, avax.priceRule], ["fallback", "spot"], "no candles: the build spot (A5)");
    const op = f.burns.filter((b) => b.chainId === 10);
    assert(op.every((b) => b.priceSource === "candles" && b.xntSource === "candles"));
    assert.deepStrictEqual(retiredBaseTerms(f), [], "A13.1: the two-pot base: no Forge Right ledger, lane, boost or drop policy");
    assert.deepStrictEqual(f.leaves.map((l) => l.score), f.targets.map((t) => t.target), "score = target (no drop gross-up)");
    assert.strictEqual(f.capacity.cash, ((BigInt(f.freePool.ref) * 800n) / 10_000n).toString(), "C = 8% of F_ref");
    assert.strictEqual(f.leaves.length, 4, "two wallets on tier 0, one locked Orbit and one locked Moon Landing mission");
    assert.deepStrictEqual([f.capacity.lockedMissions, f.capacity.convertedMissions], [2, 0]);
    assert.deepStrictEqual(verifyChainLinkV3(f, { publishedAt: REAL.publishedAt, budget: REAL.fullBudget, freePoolBefore: REAL.freePoolBefore }), []);
    // deterministic: the same inputs give the same file
    const again = buildV3(clone(base.inputs), clone(epoch1));
    assert.strictEqual(again.file!.root, f.root);
    assert.strictEqual(again.file!.dataHash, f.dataHash);
    if (fixture.expect) {
      assert.strictEqual(f.root, fixture.expect.root, "golden root");
      assert.strictEqual(f.totalScore, fixture.expect.totalScore, "golden total score");
      assert.strictEqual(f.leaves.length, fixture.expect.leaves, "golden leaf count");
    } else console.log(`  (no golden values yet: root ${f.root}, totalScore ${f.totalScore}, leaves ${f.leaves.length})`);
  });

  await test("A11.6: the publish record carries the event and the publish slot, or {tx} alone; dust leaves are counted, not advertised as tips", () => {
    const f = built.file!;
    const plan = claimPlanV3(f);
    assert.strictEqual(plan.tipped.length + plan.dust.length, f.leaves.length);
    const ts = BigInt(f.totalScore);
    const { claims } = programClaims(f.leaves.map((l) => BigInt(l.score)), ts, ts * 10n);
    f.leaves.forEach((l, i) => assert.strictEqual(plan.tipped.includes(l), claims[i] >= KEEPER_TIP_MIN_CLAIM));
    assert(plan.dust.length >= 1, "the 50 million XEN Avalanche burn (about $0.0013) is dust: paid, no keeper tip");
    const read: PublishedRecordV3 = {
      tx: "5".repeat(64), slot: 88_374_200, blockTime: f.window.endTs + 70, epoch: 2, root: f.root, dataHash: f.dataHash, totalScore: f.totalScore, leaves: f.leaves.length,
      budget: f.totalScore, dropReserve: "0", dropSlot: "88374202", freePoolBefore: f.freePool.lamports,
      publishedAt: f.window.endTs + 70, netBudget: f.totalScore, rateCap: "1",
    };
    const full = publishRecordV3(read.tx, read, { tipped: plan.tipped.length, dust: plan.dust.length });
    assert.deepStrictEqual(full, {
      tx: read.tx, slot: 88_374_200, budget: read.netBudget!, fullBudget: f.totalScore, dropReserve: read.dropReserve, dropSlot: "88374202", freePoolBefore: f.freePool.lamports,
      publishedAt: read.publishedAt!, blockTime: f.window.endTs + 70, claims: { tipped: plan.tipped.length, dust: plan.dust.length },
    });
    assert.deepStrictEqual(publishRecordV3(read.tx, null), { tx: read.tx }, "post-publish reads failed: {tx} alone");
    assert.deepStrictEqual(publishRecordV3(read.tx, null, { tipped: 1, dust: 2 }), { tx: read.tx, claims: { tipped: 1, dust: 2 } });
    assert.deepStrictEqual(verifyPublishedV3(f, toPublishedEpochV3(read)), [], "the verify rules accept the record of this file");
    assert(verifyPublishedV3(f, toPublishedEpochV3({ ...read, budget: (BigInt(f.totalScore) - 1n).toString() })).some((e) => /I9/.test(e)));
    assert(verifyPublishedV3(f, toPublishedEpochV3({ ...read, publishedAt: f.window.endTs - 1 })).some((e) => /published at/.test(e)));
    // A13.1: a publication with a drop reserve (an old binary) is reported: it cuts every claim below its target
    assert(verifyPublishedV3(f, toPublishedEpochV3({ ...read, dropReserve: (BigInt(f.totalScore) / 10n).toString(), netBudget: null })).some((e) => /drop reserve/.test(e)));
    // the publish field is outside the data hash, so writing it never breaks the file
    const withPublish = { ...f, publish: full };
    assert.deepStrictEqual(verifyAny(withPublish, epoch1), []);
  });

  await test("A11.8: the extra epoch right after the base epoch is a heartbeat with budget 0 before the upgrade (pot X = 0)", () => {
    const f = built.file!;
    const r = fixture.recording;
    const ef = buildExtraAfterBaseV3(f, null, r.snapshot[0], r.assetSignatures, { open: "0", lamports: "0", slot: f.freePool.slot }, f.createdAt);
    assert.deepStrictEqual(verifyExtraFile(ef, f, null), []);
    assert.deepStrictEqual([ef.epoch, ef.firstEpoch, ef.baseDataHash, ef.prevDataHash], [2, 2, f.dataHash, null]);
    assert.deepStrictEqual([ef.totals.budget, ef.leaves.length, ef.snapshot.slot, ef.snapshot.blockTime], ["0", 0, f.snapshot.slot, f.window.endTs]);
    // OD-9: built before the pot exists (no init_extra mark), so the FORGED Artifact is "pre-upgrade" (nothing eligible, A10-a)
    assert.deepStrictEqual(ef.excluded, [{ asset: r.snapshot[0].records[0].asset, reason: "pre-upgrade" }], "first extra epoch: nothing eligible (A10-a)");
    assert.throws(() => buildExtraAfterBaseV3(f, null, r.snapshot[0], {}, { open: "0", lamports: "0", slot: 1 }, f.createdAt), /no Core signature/);
    assert.throws(() => buildExtraAfterBaseV3(f, null, { ...r.snapshot[0], slot: r.snapshot[0].slot + 1 }, r.assetSignatures, { open: "0", lamports: "0", slot: 1 }, f.createdAt), /not the base snapshot slot/);
  });

  // ── A13.7: rebuild-extra on the fixtures ───────────────────────────────────────────────────────
  await test("A13.7: a lost extra-2.json is rebuilt byte for byte from epoch-2.json and X1 reads at the recorded slot; a data-hash mismatch is refused", async () => {
    const f = built.file!;
    const r = fixture.recording;
    // what runEpochV3 writes right after the base epoch (buildExtraV3): the pot and the instant are functions of the base file
    const original = buildExtraAfterBaseV3(f, null, r.snapshot[0], r.assetSignatures, extraPoolV3(f, "0"), extraCreatedAtV3(f));
    assert.deepStrictEqual(verifyExtraFile(original, f, null), []);
    assert.deepStrictEqual([original.createdAt >= new Date(f.window.endTs * 1000).toISOString(), original.pool], [true, { open: "0", lamports: "0", slot: f.freePool.slot, init: null }], "before the pot: X 0, no init_extra mark (OD-9)");
    // the recovery sources answer from the recording: the ArtifactRecords (forged_at is immutable) and the signature history
    const forgedAt = Object.fromEntries(r.snapshot[0].records.map((x) => [x.asset, x.forgedAt]));
    const src = (o: Partial<ExtraRecoverySourcesV3> = {}): ExtraRecoverySourcesV3 => ({
      forgedAt: async (assets) => Object.fromEntries(assets.filter((a) => a in forgedAt).map((a) => [a, forgedAt[a]])),
      assetSignatures: (assets, slot) => fixtureSources(r).assetSignatures(assets, slot),
      publishedExtra: async () => null,
      ...o,
    });
    const again = await rebuildExtraV3(f, null, src());
    assert.strictEqual(JSON.stringify(again.file), JSON.stringify(original), "the same bytes");
    assert.deepStrictEqual(again.confirmedBy, [], "before the upgrade nothing on-chain records an extra epoch: unchecked");
    // once the program records it: the same hash is confirmed, another one is refused
    assert.deepStrictEqual((await rebuildExtraV3(f, null, src({ publishedExtra: async (e) => (e === 2 ? { dataHash: original.dataHash, freeAfter: "0" } : null) }))).confirmedBy, ["chain"]);
    await assert.rejects(rebuildExtraV3(f, null, src({ publishedExtra: async (e) => (e === 2 ? { dataHash: "00".repeat(32), freeAfter: "0" } : null) })), /refused: the rebuilt extra-2\.json has data hash/);
    // the reads must still answer: a lost signature, a recycled asset in the first extra epoch
    await assert.rejects(rebuildExtraV3(f, null, src({ assetSignatures: async () => ({}) })), /no Core signature/);
    await assert.rejects(rebuildExtraV3(f, null, src({ forgedAt: async () => ({}) })), /forgedAt cannot be recovered/);
    // the next run's catch-up (A13.6): the lost file is rebuilt; when it cannot be, a verified skip heartbeat is written
    const up = await catchUpExtrasV3({ upTo: 2, firstEpoch: 2, baseOf: (e) => (e === 2 ? f : null), extraOf: () => null, src: src() });
    assert.deepStrictEqual([up.written.length, up.written[0].how, JSON.stringify(up.written[0].file) === JSON.stringify(original)], [1, "rebuilt", true]);
    const dead = await catchUpExtrasV3({ upTo: 2, firstEpoch: 2, baseOf: (e) => (e === 2 ? f : null), extraOf: () => null, src: src({ forgedAt: async () => ({}) }) });
    const skip = dead.written[0].file;
    assert.deepStrictEqual([dead.written[0].how, skip.totals.budget, skip.snapshot.records.length, verifyExtraFile(skip, f, null)], ["skipped", "0", 0, []]);
  });

  // ── A13.4 (N3): a dry run before MIN_WINDOW prints a provisional file ─────────────────────────────
  await test("A13.4: a window shorter than MIN_WINDOW builds only as a labelled provisional file that nothing publishes, verifies or builds on", async () => {
    const r = rec();
    const endTs = r.snapshot[0].blockTime!;
    // the live probe of 2026-10-22: 4.3 days after epoch 1's publication
    const early = { ...r.published["1"]!, publishedAt: endTs - Math.round(4.3 * 86_400) };
    const a = await assembleInputsV3(2, epoch1, withOverrides(r, { published: async () => early }), chains, [epoch1], quiet);
    assert.throws(() => buildV3(a.inputs, epoch1), /shorter than .* it could never be published/, "without the label the engine still refuses");
    const reason = provisionalReasonOf(a.inputs.window)!;
    assert.match(reason, /4\.30 days\) is shorter than MIN_WINDOW 496800 s \(5\.75 days\)/);
    const p = buildV3(a.inputs, epoch1, { provisional: reason }).file!;
    assert.deepStrictEqual(p.provisional, { reason, publishable: false });
    assert.deepStrictEqual(verifyAny(p, epoch1), [`a provisional dry-run file (A13.4) is never an epoch and never publishable: ${reason}`]);
    // stripping the label and re-hashing does not make it an epoch: the window is recomputed and refused
    const stripped = clone(p) as EpochFileV3;
    delete stripped.provisional;
    stripped.dataHash = dataHashV3(stripped);
    assert(verifyAny(stripped, epoch1).some((e) => /shorter than/.test(e)));
    // never a previous file, never an extra base, never published
    assert.throws(() => computeEpochV3({ ...a.inputs, epoch: 3 }, p), /the previous file: a provisional dry-run file/);
    assert.throws(() => buildExtraAfterBaseV3(p, null, r.snapshot[0], r.assetSignatures, extraPoolV3(p, "0"), extraCreatedAtV3(p)), /provisional/);
    await assert.rejects(publishEpochV3(null as never, null as never, p), /refusing to publish epoch 2: a provisional dry-run file/);
    // A13.11 (review R5): publishEpochV3 checks the window itself, so the stripped (and re-hashed) file never reaches the
    // RPC either; neither does a v3 file without a window. A normal file passes the guard (it fails later on the null program)
    await assert.rejects(publishEpochV3(null as never, null as never, stripped), /^Error: refusing to publish epoch 2: window of \d+ s is shorter than MIN_WINDOW 496800 s/);
    const noWindow = clone(stripped) as unknown as Record<string, unknown>;
    delete noWindow.window;
    await assert.rejects(publishEpochV3(null as never, null as never, noWindow as never), /refusing to publish epoch 2: a v3 file without a window/);
    // the golden file passes the file guard; with the null program it then stops at the W2-4 client check (a v3 client is
    // required, and the upgraded-binary probe comes after it), never at a file refusal
    const fileRefusal = /refusing to publish epoch 2: (a provisional dry-run file|window of|a v3 file without a window)/;
    await assert.rejects(publishEpochV3(null as never, null as never, built.file!), (e: Error) => !fileRefusal.test(String(e)) && /not built from moon_forge\.v3\.json/.test(String(e)), "the golden file passes the guard");
    // a window of MIN_WINDOW or more is never labelled, and the golden file has no such member
    assert.strictEqual(provisionalReasonOf({ startTs: 0, endTs: MIN_WINDOW }), null);
    assert.strictEqual(provisionalReasonOf(built.file!.window), null);
    assert.strictEqual("provisional" in built.file!, false);
  });

  // ── A13.5 (N5): the publish gate fails closed on an unknown clock ─────────────────────────────────
  await test("A13.5: an unreadable block time refuses the publication (never a rebuild, never a pass); a readable one gates as before", async () => {
    const f = built.file!;
    const F = BigInt(f.freePool.lamports);
    let calls = 0;
    assert.strictEqual(await readPublishClockV3({}, 5, 3, 0), null, "sources that cannot tell time");
    assert.strictEqual(await readPublishClockV3({ blockTime: async () => (calls++, null) }, 5, 3, 0), null);
    assert.strictEqual(calls, 3, "three tries");
    assert.strictEqual(await readPublishClockV3({ blockTime: async () => { throw new Error("429"); } }, 5, 3, 0), null);
    let k = 0;
    assert.strictEqual(await readPublishClockV3({ blockTime: async () => (++k < 3 ? null : f.window.endTs + 60) }, 5, 3, 0), f.window.endTs + 60, "a transient miss is retried");
    const refused = publishGateV3(f, F, null, 86_800_000);
    assert.strictEqual(refused.action, "refuse");
    assert.match(refused.reason, /block time of the free-pool read is unknown \(slot 86800000\).*NOT published \(A13\.5\)/);
    assert.deepStrictEqual(publishGateV3(f, F, f.window.endTs + 60), { action: "publish", reason: "" });
    assert.strictEqual(publishGateV3(f, F, f.window.endTs + MAX_PUBLISH_LAG + 1).action, "rebuild");
    assert.strictEqual(publishGateV3(f, F / 2n, f.window.endTs + 60).action, "rebuild", "the pool rules are unchanged");
    // the engine's own check fails closed too, for any caller that passes the failed reading
    assert.match(rebuildReason(f, F, null)!, /cannot be checked against MAX_PUBLISH_LAG/);
    assert.strictEqual(rebuildReason(f, F), null, "no clock given (the suites' pure pool check): the pool rules only");
    // A13.11 (review R5): a reading that is not a block time (NaN, a fraction, a negative number, a string) is a failed
    // try, and a gate given one refuses like an unknown clock: the lag comparison can never pass by being false
    for (const bad of [NaN, 1.5, -1, Infinity, "1792900000"] as unknown[]) {
      let tries = 0;
      assert.strictEqual(await readPublishClockV3({ blockTime: async () => (tries++, bad as number) }, 5, 3, 0), null, `reader: ${String(bad)}`);
      assert.strictEqual(tries, 3, `reader: ${String(bad)} counts as a failed try`);
      assert.strictEqual(publishGateV3(f, F, bad as number).action, "refuse", `gate: ${String(bad)}`);
      assert.match(rebuildReason(f, F, bad as number)!, /cannot be checked against MAX_PUBLISH_LAG/, `engine: ${String(bad)}`);
    }
    let j = 0;
    assert.strictEqual(await readPublishClockV3({ blockTime: async () => (++j < 3 ? NaN : f.window.endTs + 60) }, 5, 3, 0), f.window.endTs + 60, "a NaN is retried like a miss");
  });

  // ── A13.9 (review R2): the base run never waits on an Artifact read ───────────────────────────────
  await test("A13.9: a snapshot read that throws or a refused record never stops the base: it is built without the records, and that extra week is a skip", async () => {
    const r = rec();
    const good = r.snapshot[0];
    const golden = built.file!;
    const except = (f: EpochFileV3) => {
      const { snapshot: _s, dataHash: _h, proofs: _p, ...rest } = f;
      return JSON.stringify(rest);
    };
    // the read throws every time (X-015 with X1_RPC_2 set; a getProgramAccounts timeout): retried 3 times, then the window
    // is anchored alone; with the anchor at the fixture's slot every member but `snapshot` (and the hashes) is the golden one
    let reads = 0;
    const x015 = "the two X1 RPCs disagree on the ArtifactRecord set: snapshot refused (X-015)";
    const throwing = withOverrides(r, { snapshot: async () => { reads++; throw new Error(x015); }, anchor: async () => ({ slot: good.slot, blockTime: good.blockTime }) });
    const a = await assembleInputsV3(2, epoch1, throwing, chains, [epoch1], quiet);
    assert.strictEqual(reads, 3, "three tries");
    assert.deepStrictEqual(a.inputs.snapshot, { slot: good.slot, records: [], unavailable: { reason: `the Artifact records could not be read (3 tries): ${x015}` } });
    const f = buildV3(a.inputs, epoch1).file!;
    assert.deepStrictEqual(verifyAny(f, epoch1), [], "verify recomputes the file, the reason included");
    assert.strictEqual(except(f), except(golden), "the base is the golden base but for its snapshot (NFT-1)");
    assert.deepStrictEqual([f.root, f.totalScore, f.leaves.length], [golden.root, golden.totalScore, golden.leaves.length]);
    // its extra file is the skip heartbeat, rebuilt byte for byte from the base alone; a normal extra on it is refused
    const ex = buildExtraAfterBaseV3(f, null, a.snapshotRead, {}, extraPoolV3(f, "0"), extraCreatedAtV3(f));
    assert.deepStrictEqual([ex.totals.budget, ex.snapshot.records.length, ex.skip], ["0", 0, { reason: `the base snapshot S(2) is unavailable (A13.9): the Artifact records could not be read (3 tries): ${x015}` }]);
    assert.strictEqual(ex.skip!.reason, baseSnapshotSkipReason(f));
    assert.deepStrictEqual(verifyExtraFile(ex, f, null), []);
    assert.throws(() => computeExtraEpoch(f, null, { slot: good.slot, blockTime: good.blockTime!, records: [] }, { open: "0", lamports: "0", slot: 1, createdAt: extraCreatedAtV3(f) }), /base snapshot of epoch 2 is unavailable/);
    const noRecovery: ExtraRecoverySourcesV3 = { forgedAt: async () => ({}), assetSignatures: async () => ({}), publishedExtra: async () => null };
    assert.deepStrictEqual((await rebuildExtraV3(f, null, noRecovery)).file, ex, "rebuild-extra gives the same skip");
    // a transient failure is retried and the normal snapshot is used
    let k = 0;
    const once = await assembleInputsV3(2, epoch1, withOverrides(r, { snapshot: async () => { if (k++ === 0) throw new Error("timeout"); return good; } }), chains, [epoch1], quiet);
    assert.deepStrictEqual(once.inputs.snapshot, base.inputs.snapshot);
    // a record the engine refuses (a future tier or origin, a backing ≥ 2^64, a duplicate) makes the snapshot unavailable at its own slot
    const variants: [string, SourcesV3["snapshot"], RegExp][] = [
      ["tier 4", async () => ({ ...good, records: [{ ...good.records[0], tier: 4 }] }), /bad tier 4/],
      ["origin 3", async () => ({ ...good, records: [{ ...good.records[0], origin: 3 }] }), /bad origin 3/],
      ["backing 2^64", async () => ({ ...good, records: [{ ...good.records[0], backing: (2n ** 64n).toString() }] }), /out of range/],
      ["duplicate", async () => ({ ...good, records: [good.records[0], good.records[0]] }), /twice in the snapshot/],
    ];
    for (const [what, snapshot, why] of variants) {
      const v = await assembleInputsV3(2, epoch1, withOverrides(r, { snapshot }), chains, [epoch1], quiet);
      assert.deepStrictEqual([v.inputs.snapshot.slot, v.inputs.snapshot.records], [good.slot, []], what);
      assert.match(v.inputs.snapshot.unavailable!.reason, why, what);
      const vf = buildV3(v.inputs, epoch1).file!;
      assert.deepStrictEqual(verifyAny(vf, epoch1), [], what);
      assert.strictEqual(except(vf), except(golden), `${what}: the base does not change`);
    }
    // the P4 refresh in the publish loop takes the same path
    const refreshed = await refreshSnapshotIfOldV3(base.inputs, base.snapshotRead, throwing, quiet, true);
    assert.deepStrictEqual(refreshed.inputs.snapshot.unavailable, a.inputs.snapshot.unavailable);
    // only a window that cannot be anchored at all stops the run (no anchor source, or no block time for it)
    const dead = async (): Promise<never> => {
      throw new Error(x015);
    };
    await assert.rejects(assembleInputsV3(2, epoch1, withOverrides(r, { snapshot: dead }), chains, [epoch1], quiet), /could anchor the window alone/);
    await assert.rejects(assembleInputsV3(2, epoch1, withOverrides(r, { snapshot: dead, anchor: async () => ({ slot: 5, blockTime: null }) }), chains, [epoch1], quiet), /could anchor the window alone/);
    // the member is hashed and recomputed: a changed reason, a record next to it, or a malformed member is refused
    const tamper = (fn: (x: EpochFileV3) => void) => {
      const t = clone(f);
      fn(t);
      t.dataHash = dataHashV3(t);
      return verifyAny(t, epoch1);
    };
    assert(tamper((x) => (x.snapshot.unavailable = { reason: "  two\n lines " })).some((e) => /snapshot does not match/.test(e)), "a reason not in its recorded form");
    assert(tamper((x) => (x.snapshot.records = clone(golden.snapshot.records))).some((e) => /records no Artifact/.test(e)));
    assert(tamper((x) => ((x.snapshot as unknown as { unavailable: unknown }).unavailable = { reason: 5 })).some((e) => /not \{reason: string\}/.test(e)));
    assert.strictEqual("unavailable" in golden.snapshot, false, "a snapshot that was read has no such member");
  });

  // ── A13.10 (review R3): the snapshot slot is the record list's own finalized context slot ─────────
  await test("A13.10: an Artifact forged after the first finalized slot the run saw is in the snapshot only at a slot where it exists", async () => {
    // a v3 path: the upgraded program's IDL (IDL split, W2-4; ArtifactRecord is the same in both)
    const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "idl", "moon_forge.v3.json"), "utf8"));
    const owner = new PublicKey(new Uint8Array(32).fill(7));
    const asset = (i: number) => new PublicKey(Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? 40 + i : j === 31 ? 3 : 0)));
    // two Artifacts forged by slot 3,990, a third at slot 4,003. getSlot("finalized") answers 4,000 when the run starts;
    // by the time the record list is served the finalized slot is 4,005 (the race of review R3, case E6)
    const forgedSlot = [3_980, 3_990, 4_003];
    const T = 1_792_900_000;
    const program = new anchor.Program(idl, new anchor.AnchorProvider({} as never, new anchor.Wallet(Keypair.generate()), {}));
    const datas = await Promise.all(forgedSlot.map((s, i) => program.coder.accounts.encode("artifactRecord", {
      asset: asset(i), tier: 1, serial: i, backing: new anchor.BN(12_500_000_000), origin: 0, forgedAt: new anchor.BN(T + s), lastChipWeek: new anchor.BN(0), bump: 255,
    })));
    const core = Buffer.alloc(66);
    core[0] = 1;
    owner.toBuffer().copy(core, 1);
    core[33] = 2;
    PDA.collection().toBuffer().copy(core, 34);
    const finalizedAtList = 4_005;
    const info = { owner: MPL_CORE, data: core, lamports: 1, executable: false };
    const connection = {
      getSlot: async () => 4_000,
      getProgramAccounts: async (_id: PublicKey, cfg: { withContext?: boolean }) => {
        const value = datas.map((data) => ({ pubkey: PublicKey.unique(), account: { data, owner: program.programId, lamports: 1, executable: false } }));
        return cfg.withContext ? { context: { slot: finalizedAtList }, value } : value;
      },
      getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(() => info),
      // A10.11: the per-asset reader asks for the Core assets with their context slot (from the snapshot slot on)
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[], cfg: { minContextSlot?: number }) => ({ context: { slot: Math.max(finalizedAtList, cfg?.minContextSlot ?? 0) }, value: keys.map(() => info) }),
      getAccountInfo: async () => info,
      getBlockTime: async (slot: number) => T + slot,
      getSignaturesForAddress: async (a: PublicKey) => {
        const i = [0, 1, 2].find((j) => asset(j).equals(a))!;
        return [{ signature: `sig${i}`, slot: forgedSlot[i], err: null }];
      },
    };
    const snap = await artifactSnapshotV3(connection as never, program, "");
    assert.deepStrictEqual([snap.slot, snap.blockTime], [finalizedAtList, T + finalizedAtList], "the slot is the context slot of the finalized list, and the window end its block time");
    assert.deepStrictEqual(snap.records.map((x) => x.forgedAt), forgedSlot.map((s) => T + s), "the late Artifact is in, and it exists at the slot");
    const sigs = await assetSignaturesV3(connection as never, snap.records.map((x) => x.asset), snap.slot);
    assert.strictEqual(Object.keys(sigs).length, 3, "every asset of the snapshot has a transaction at or before the slot, so the week's extra builds");
  });

  // ── A13.12 (review R4): the A2 batch is the one exception to "a later burn never lowers an earlier one" ─────
  await test("A13.12: a later burn in the same chain-hour shares that hour's curve pot (the quote is an upper bound); in a later hour or on another chain it changes nothing for the earlier burn", () => {
    const id = (x: { chainId: number; txHash: string; logIndex: number }) => `${x.chainId}:${x.txHash}:${x.logIndex}`;
    const golden = built.file!;
    const op = base.inputs.chains.find((c) => c.chainId === 10)!;
    const first = [...op.burns].sort((p, q) => p.timestamp - q.timestamp)[0];
    const before = golden.burns.find((b) => id(b) === id(first))!;
    const other = golden.burns.map((b) => b.x1).find((x) => x !== first.x1)!;
    const later = (o: { chainId?: number; timestamp: number; times: bigint }) => ({
      ...first, chainId: o.chainId ?? first.chainId, txHash: "0x" + "ee".repeat(32), logIndex: first.logIndex + 500, timestamp: o.timestamp, x1: other, amountWei: (BigInt(first.amountWei) * o.times).toString(),
      blockNumber: o.chainId ? base.inputs.chains.find((c) => c.chainId === o.chainId)!.toBlock : first.blockNumber,
    });
    const withLater = (b: ReturnType<typeof later>) => {
      const inp = clone(base.inputs);
      const c = inp.chains.find((x) => x.chainId === b.chainId)!;
      // X-010: the added burn is the portal's next mission, so the recorded counters move with it
      const next = BigInt(c.missionsAt!) + 1n;
      c.burns.push({ ...b, missionId: next.toString() });
      c.missionsAt = next.toString();
      if (c.burnedAt) c.burnedAt = (BigInt(c.burnedAt) + BigInt(b.amountWei)).toString();
      const f = computeEpochV3(inp, epoch1)!;
      return f.burns.find((x) => id(x) === id(first))!;
    };
    // the same chain and hour (review B4): the earlier burn's value and payout go down, never up, and further for a bigger burn
    let last = BigInt(before.valueMicro);
    for (const times of [1n, 20n, 1_000n]) {
      const same = withLater(later({ timestamp: first.timestamp + 1, times }));
      assert(BigInt(same.valueMicro) < last && BigInt(same.alloc) <= BigInt(before.alloc), `same hour, ×${times}`);
      last = BigInt(same.valueMicro);
    }
    assert.deepStrictEqual([withLater(later({ timestamp: first.timestamp + 1, times: 20n })).valueMicro, before.valueMicro], ["56288", "56341"], "the review's numbers");
    // the next hour on the same chain, and the same second on another chain: the earlier burn is unchanged (its value, its arrival claim, its payout)
    const nextHour = (Math.floor(first.timestamp / 3_600) + 1) * 3_600;
    for (const [what, b] of [["next hour", later({ timestamp: nextHour, times: 1_000n })], ["another chain, same second", later({ chainId: 56, timestamp: first.timestamp + 1, times: 1_000n })]] as const) {
      const after = withLater(b);
      assert.deepStrictEqual([after.valueMicro, after.senior, after.lockedLp, after.leafTier, after.alloc], [before.valueMicro, before.senior, before.lockedLp, before.leafTier, before.alloc], what);
    }
  });

  // ── chain skipping with the cursor carried ───────────────────────────────────────────────────
  await test("A11.3: a chain whose market, head or RPC read fails is skipped with its cursor carried; the epoch is built for the others", async () => {
    const r = rec();
    const s = withOverrides(r, {
      market: async (c) => {
        if (c.chainId === 56) throw new Error("GeckoTerminal -> HTTP 429");
        return fixtureSources(r).market(c);
      },
      finalHead: async (c) => {
        if (c.chainId === 10) throw new Error("Optimism head: every RPC failed");
        return fixtureSources(r).finalHead(c);
      },
      readChain: async (c, from, to) => {
        if (c.chainId === 137) throw new Error("final head 96000000 below 96023504: this RPC lags behind");
        return fixtureSources(r).readChain(c, from, to);
      },
    });
    const a = await assembleInputsV3(2, epoch1, s, chains, [epoch1], quiet);
    assert.deepStrictEqual(a.skipped.map((x) => x.chainId).sort((x, y) => x - y), [10, 56, 137]);
    assert.match(a.skipped.find((x) => x.chainId === 56)!.reason, /429/);
    assert.match(a.skipped.find((x) => x.chainId === 137)!.reason, /lags behind/);
    assert.deepStrictEqual(a.inputs.chains.map((c) => c.chainId), [43114, 8453]);
    const b = buildV3(a.inputs, epoch1);
    assert(b.file, "Avalanche's burn is still paid");
    const f = b.file!;
    for (const id of [10, 56, 137]) {
      const c = f.chains.find((x) => x.chainId === id)!;
      const pc = epoch1.chains.find((x) => x.chainId === id)!;
      assert.strictEqual(c.skipped, true);
      assert.deepStrictEqual([c.fromBlockExclusive, c.toBlock], [pc.toBlock, pc.toBlock], `${c.name}: the cursor stays exactly at the previous toBlock`);
      assert.strictEqual(c.L.used, pc.liquidityUsdMicro, "the liquidity memory is carried");
      assert.strictEqual(prevCursor(f, id), pc.toBlock, "the next epoch continues from the same block: no block skipped, none read twice");
    }
    assert.deepStrictEqual(verifyAny(f, epoch1), []);
    assert.deepStrictEqual(verifyChainSetV3(f, epoch1, live), []);
    assert(f.burns.every((x) => x.chainId === 43114), "only the readable chain's burns are in the file");
  });

  await test("A11.3: a chain read for the first time that fails is simply absent (its first read starts at its start block)", async () => {
    const r = rec();
    // D-53 removed the PulseChain entry from config.ts: a chain added later is a new configured entry (a test chain here)
    const more: ChainConfig[] = [...chains, { ...chains.find((c) => c.chainId === 10)!, chainId: 369, name: "PulseChain (test)", gecko: "pulsechain", portal: PORTAL, startBlock: 25_000_000 }];
    const a = await assembleInputsV3(2, epoch1, fixtureSources(r), more, [epoch1], quiet);
    assert.deepStrictEqual(a.skipped.map((x) => [x.chainId, /fixture has no finalHead 369/.test(x.reason)]), [[369, true]]);
    const f = buildV3(a.inputs, epoch1).file!;
    assert(!f.chains.some((c) => c.chainId === 369));
    // when it answers, it starts at max(0, startBlock − 1) and the configured-chain check passes
    r.finalHead[369] = 25_300_000;
    r.readChain["369:24999999:25300000"] = { burns: [], totalMissions: "0", totalMissionsBefore: null };
    r.market[369] = r.market[10];
    r.totalSupply["369:25300000"] = "0";
    const a2 = await assembleInputsV3(2, epoch1, fixtureSources(r), more, [epoch1], quiet);
    assert.deepStrictEqual(a2.skipped, []);
    const f2 = buildV3(a2.inputs, epoch1).file!;
    const pulse = f2.chains.find((c) => c.chainId === 369)!;
    assert.deepStrictEqual([pulse.fromBlockExclusive, pulse.toBlock, pulse.skipped], [24_999_999, 25_300_000, false]);
    assert.deepStrictEqual(verifyChainSetV3(f2, epoch1, more.filter((c) => c.portal)), []);
    assert(verifyChainSetV3({ ...f2, chains: f2.chains.map((c) => (c.chainId === 369 ? { ...c, fromBlockExclusive: 25_000_500 } : c)) }, epoch1, more.filter((c) => c.portal)).some((e) => /start block/.test(e)));
  });

  await test("A11.3: a silent log omission (mission-id gap, duplicate, counter mismatch) skips the chain instead of moving its cursor", async () => {
    const r = rec();
    const key = "10:158343717:158646117";
    const good = r.readChain[key];
    const variants: [string, Burn[], string, RegExp][] = [
      ["one log missing", [good.burns[0]], good.totalMissions, /omitted logs/],
      ["ids 2 and 4 with the counter at 4", [good.burns[0], { ...good.burns[1], missionId: "4" }], "4", /omitted logs/],
      ["ids 2 and 4 with the counter at 3", [good.burns[0], { ...good.burns[1], missionId: "4" }], "3", /contiguously/],
      ["a duplicate id", [good.burns[0], { ...good.burns[1], missionId: "2", txHash: "0x" + "9".repeat(64) }], good.totalMissions, /contiguously/],
      ["three logs for two missions", [...good.burns, { ...good.burns[1], missionId: "3", txHash: "0x" + "8".repeat(64), logIndex: 11 }], good.totalMissions, /duplicate ids/],
      ["the counter below the paid ids", good.burns, "0", /below|duplicate/],
      ["a burn outside the block range", [{ ...good.burns[0], blockNumber: 158_343_717 }, good.burns[1]], good.totalMissions, /outside/],
      ["a burn stamped two hours after the window end", [{ ...good.burns[0], timestamp: r.snapshot[0].blockTime! + 7_200 }, good.burns[1]], good.totalMissions, /after the window end/],
    ];
    for (const [what, burns, total, re] of variants) {
      const r2 = rec();
      r2.readChain[key] = { burns, totalMissions: total, totalMissionsBefore: good.totalMissionsBefore };
      const a = await assembleInputsV3(2, epoch1, fixtureSources(r2), chains, [epoch1], quiet);
      assert.deepStrictEqual(a.skipped.map((x) => x.chainId), [10], what);
      assert.match(a.skipped[0].reason, re, what);
      const f = buildV3(a.inputs, epoch1).file!;
      const op = f.chains.find((c) => c.chainId === 10)!;
      assert.deepStrictEqual([op.skipped, op.fromBlockExclusive, op.toBlock], [true, 158_343_717, 158_343_717], what);
      assert.deepStrictEqual(verifyAny(f, epoch1), [], what);
    }
    // the honest read with the counter served at the cursor, and without it (a non-archive RPC: the local files decide)
    const r3 = rec();
    r3.readChain[key] = { ...good, totalMissionsBefore: null };
    const a3 = await assembleInputsV3(2, epoch1, fixtureSources(r3), chains, [epoch1], quiet);
    assert.deepStrictEqual(a3.skipped, []);
    // the counter at the cursor above the files' last id: a warning (burns before the cursor that nobody paid), not a skip
    const r4 = rec();
    r4.readChain[key] = { burns: [{ ...good.burns[1], missionId: "4" }], totalMissions: "4", totalMissionsBefore: "3" };
    const a4 = await assembleInputsV3(2, epoch1, fixtureSources(r4), chains, [epoch1], quiet);
    assert.deepStrictEqual(a4.skipped, []);
    assert.match(a4.warnings[0], /Optimism: missions 2..3 .* never paid/);
  });

  // ── the window end ───────────────────────────────────────────────────────────────────────────
  await test("A8 plumbing: a null block time re-reads the snapshot; three nulls abort the build, never fall back to the runner's clock", async () => {
    const r = rec();
    const snap = r.snapshot[0];
    let reads = 0;
    const s = withOverrides(r, { snapshot: async () => (reads++ === 0 ? { ...snap, blockTime: null, slot: snap.slot - 5 } : snap) });
    const a = await assembleInputsV3(2, epoch1, s, chains, [epoch1], quiet);
    assert.strictEqual(reads, 2);
    assert.deepStrictEqual([a.inputs.snapshot.slot, a.inputs.window.endTs], [snap.slot, snap.blockTime]);
    const dead = withOverrides(r, { snapshot: async () => ({ ...snap, blockTime: null }) });
    await assert.rejects(() => assembleInputsV3(2, epoch1, dead, chains, [epoch1], quiet), /cannot be anchored/);
    const noPub = withOverrides(r, { published: async () => null });
    await assert.rejects(() => assembleInputsV3(2, epoch1, noPub, chains, [epoch1], quiet), /EpochPublished record of epoch 1/);
  });

  await test("A11.4: publication only when the window is at least 6 days long", () => {
    const end = REAL.publishedAt + MIN_EPOCH_INTERVAL;
    assert.strictEqual(publishDecisionV3({ startTs: REAL.publishedAt, endTs: end }).ok, true);
    assert.match(publishDecisionV3({ startTs: REAL.publishedAt, endTs: end - 1 }).reason, /shorter than 518400 s \(6 days\): not due/);
    assert.strictEqual(publishDecisionV3({ startTs: REAL.publishedAt, endTs: REAL.publishedAt + WEEK }).ok, true);
    // the live probe of 2026-10-22 (4.3 days after epoch 1): not due
    assert.strictEqual(publishDecisionV3({ startTs: REAL.publishedAt, endTs: 1_792_659_183 }).ok, false);
  });

  await test("A11.5 / A13.1: the keeper never seals a v3 epoch (it has no drop reserve); v2 files keep sealing", () => {
    const f = built.file!;
    assert.strictEqual(sealAllowedV3([f], 2), false, "a v3 epoch: never sealed (a pending seed can only come from a binary that was not upgraded: it is cancelled)");
    assert.strictEqual(sealAllowedV3([{ ...f, drops: { seal: true } } as typeof f], 2), false, "a forged drop policy changes nothing");
    assert.strictEqual(sealAllowedV3([epoch1], 1), true, "a v2 file says nothing");
    assert.strictEqual(sealAllowedV3([f], 3), true, "no file: the keeper seals as today");
  });

  await test("P1: an unpublished epoch-2.json next to epoch-1.json changes nothing (it is not history), and is reported as stale", async () => {
    const stale = clone(built.file!) as unknown as AnyEpochFile; // what a run that died before publish_epoch leaves behind
    assert.strictEqual((stale as { publish?: unknown }).publish, undefined);
    const again = await assembleInputsV3(2, epoch1, fixtureSources(rec()), chains, [epoch1, stale], quiet);
    assert.deepStrictEqual(again.skipped, [], "review R1: every chain is still read (before the fix Optimism, BSC and Avalanche were skipped)");
    assert.deepStrictEqual(again.inputs, base.inputs);
    assert.strictEqual(buildV3(again.inputs, epoch1).file!.root, built.file!.root, "and the rebuilt file pays the same");
    assert.deepStrictEqual(staleEpochs([epoch1, stale], 1), [2]);
    assert.deepStrictEqual(staleEpochs([epoch1], 1), []);
    assert.deepStrictEqual(historyFor([epoch1, stale], 2).map((f) => f.epoch), [1]);
  });

  await test("P3: the keeper works on files the program published even without a publish record; the previous publication is returned for the backfill", () => {
    const noRecord = clone(built.file!) as unknown as { epoch: number; publish?: unknown };
    assert.deepStrictEqual(keeperFilesV3([epoch1, noRecord], 2).map((f) => f.epoch), [1, 2], "on-chain (epoch ≤ last_epoch): kept");
    assert.deepStrictEqual(keeperFilesV3([epoch1, noRecord], 1).map((f) => f.epoch), [1], "not on-chain: left out");
    assert.strictEqual(base.prevPublished!.publishedAt, REAL.publishedAt);
    assert.strictEqual(base.prevPublished!.tx, fixture.recording.published["1"]!.tx);
  });

  await test("P4: a slow assemble re-reads the snapshot, so the build stays within CLOCK_SKEW_MAX of the window end", async () => {
    const r = rec();
    const first = r.snapshot[0];
    const later = { ...clone(first), slot: first.slot + 7_500, blockTime: first.blockTime! + 3_000 };
    let reads = 0;
    const slowNow = new Date((first.blockTime! + 3_601) * 1000).toISOString();
    const s = withOverrides(r, { snapshot: async () => (reads++ === 0 ? first : later), now: () => slowNow });
    assert(snapshotTooOld(slowNow, first.blockTime!) && !snapshotTooOld(slowNow, later.blockTime));
    // review repro R2: before the fix the same inputs (window end = the first snapshot) threw 'build time ... more than 3600 s'
    assert.throws(() => buildV3({ ...base.inputs, createdAt: slowNow }, epoch1), /build time/);
    const a = await assembleInputsV3(2, epoch1, s, chains, [epoch1], quiet);
    assert.strictEqual(reads, 2);
    assert.deepStrictEqual([a.inputs.window.endTs, a.inputs.snapshot.slot, a.snapshotRead.slot], [later.blockTime, later.slot, later.slot]);
    assert(buildV3(a.inputs, epoch1).file, "the slow run still builds");
    // the publish loop's rebuild uses the same refresh
    const fresh = await refreshSnapshotIfOldV3({ ...base.inputs, createdAt: slowNow }, first, withOverrides(rec(), { snapshot: async () => later, now: () => slowNow }), quiet);
    assert(fresh.refreshed && fresh.inputs.window.endTs === later.blockTime);
    const kept = await refreshSnapshotIfOldV3(base.inputs, first, fixtureSources(rec()), quiet);
    assert(!kept.refreshed && kept.inputs === base.inputs);
  });

  await test("P8: a run that is not due stops after the previous publication, before any chain or candle is read", async () => {
    const r = rec();
    let chainReads = 0;
    const endTs = r.snapshot[0].blockTime!;
    const early = { ...r.published["1"]!, publishedAt: endTs - 5 * 86_400 };
    const s = withOverrides(r, { published: async () => early, readChain: async (c, f, t) => { chainReads++; return fixtureSources(r).readChain(c, f, t); }, finalHead: async (c) => { chainReads++; return fixtureSources(r).finalHead(c); } });
    await assert.rejects(assembleInputsV3(2, epoch1, s, chains, [epoch1], quiet, { stopIfNotDue: true }), (e: unknown) => e instanceof NotDueV3 && /not due/.test((e as Error).message));
    assert.strictEqual(chainReads, 0, "no chain was read");
    await assembleInputsV3(2, epoch1, s, chains, [epoch1], quiet).catch(() => null);
    assert(chainReads > 0, "a dry run still assembles everything");
  });

  await test("P2: a seed the gate left unsealed is cancelled once its SlotHashes window passed; the keeper waits for that, not 'now'", () => {
    const at = (currentSlot: number, sealAllowed = false) => gatedSealActionV3({ dropState: 1, sealAllowed, dropSlot: 1_000, currentSlot });
    assert.deepStrictEqual([at(1_001), at(1_000 + SLOT_HASHES_DEPTH), at(1_000 + SLOT_HASHES_DEPTH + 17), at(1_001, true)], ["wait", "wait", "cancel", "seal"]);
    assert.strictEqual(gatedSealActionV3({ dropState: 2, sealAllowed: false, dropSlot: 1_000, currentSlot: 9_999 }), "none");
    const now = 1_800_000_000;
    assert.strictEqual(gatedSealDueAt({ dropState: 1, sealAllowed: false, dropSlot: 1_000, currentSlot: 1_000 }, now), now + Math.ceil((SLOT_HASHES_DEPTH + 17) * 0.5), "about 4.4 minutes later, not now");
    assert.strictEqual(gatedSealDueAt({ dropState: 1, sealAllowed: false, dropSlot: 1_000, currentSlot: 2_000 }, now), now);
    assert.strictEqual(gatedSealDueAt({ dropState: 1, sealAllowed: true, dropSlot: 1_000, currentSlot: 1_000 }, now), now);
    assert.strictEqual(gatedSealDueAt({ dropState: 3, sealAllowed: false, dropSlot: 1_000, currentSlot: 1_000 }, now), null);
    // the fixture's own epoch 2 (v3): never sealed, so a seed left by an old binary is cancelled after ~4 minutes instead of 90 days
    assert.strictEqual(sealAllowedV3([built.file!], 2), false);
  });

  await test("P6 / P10 / P9: paging to the publish transaction; the sweep takes closed epochs only; candles end one second before the hour", async () => {
    const sigs = Array.from({ length: 2_500 }, (_, i) => ({ signature: `s${2_499 - i}`, err: null as unknown }));
    const pages = await signaturePages(async (before) => {
      const from = before === undefined ? 0 : sigs.findIndex((x) => x.signature === before) + 1;
      return sigs.slice(from, from + 1_000);
    });
    assert.strictEqual(pages.length, 2_500);
    assert.strictEqual(oldestSignature(pages), "s0", "the publish transaction is the oldest, past the first 1,000");
    assert.strictEqual(oldestSignature([{ signature: "a", err: null }, { signature: "b", err: { x: 1 } }]), "a", "a failed transaction is never the publication");
    assert.deepStrictEqual([sweepableEpoch({ closed: true }), sweepableEpoch({ closed: false })], [true, false], "close_receipt requires epoch.closed");
    assert.strictEqual(candleWindowV3(1_792_000_800), "limit=24&before_timestamp=1792000799");
  });

  await test("P7 / P11 / RE-5: soft post-publish problems keep the run green; the claim line and health read what the claims did; the daily release is the one applied", () => {
    const r = postPublishReport(["claims: 1 of 4 leaves failed"]);
    assert.deepStrictEqual([r.exitCode, r.annotations.length], [0, 1]);
    assert.match(r.annotations[0], /^::error title=post-publish::claims/);
    assert.match(claimsLineV3({ claims: { claimed: 4, failed: 0 } }, 4), /Every leaf claimed/);
    assert.match(claimsLineV3({ claims: { claimed: 3, failed: 1 } }, 4), /3 of 4 leaves claimed .*1 failed/);
    assert.match(claimsLineV3({ claims: { tipped: 3, dust: 1 } as { claimed?: number } }, 4), /being sent/, "the plan alone never says 'every leaf claimed'");
    assert.strictEqual(claimsVerdict(2, { tipped: 3, dust: 1, claimed: 4, failed: 0 })!.state, "ok");
    assert.strictEqual(claimsVerdict(2, { tipped: 3, dust: 1, claimed: 3, failed: 1 })!.state, "fail");
    assert.strictEqual(claimsVerdict(2, { tipped: 3, dust: DUST_CLAIMS_WARN + 1, claimed: DUST_CLAIMS_WARN + 4, failed: 0 })!.state, "warn");
    assert.strictEqual(claimsVerdict(2, { tipped: 3, dust: 1 })!.state, "warn", "only the plan recorded");
    assert.strictEqual(claimsVerdict(2, undefined), null);
    assert.strictEqual(dailyReleaseV3({ cash: "7000", tranche: "666" }), 666, "review a9 §6: the tranche applied in a cash cut");
    assert.strictEqual(dailyReleaseV3({ cash: "7000", shortfall: { to: "4669" } }), 667);
    assert.strictEqual(dailyReleaseV3(built.file!.capacity), Number(BigInt(built.file!.capacity.cash) / 7n));
  });

  await test("withRetries: retries, then gives up with null (the file keeps {tx} alone)", async () => {
    let n = 0;
    const v = await withRetries(async () => {
      if (++n < 3) throw new Error("not yet");
      return "ok";
    }, 4, 0, quiet);
    assert.deepStrictEqual([v, n], ["ok", 3]);
    assert.strictEqual(await withRetries(async () => { throw new Error("never"); }, 3, 0, quiet), null);
  });

  // ── recording ────────────────────────────────────────────────────────────────────────────────
  await test("recordingSources: a run recorded from the fixture replays to the same inputs (how a live dry run becomes a fixture)", async () => {
    const r = rec();
    const out = emptyRecording();
    const a = await assembleInputsV3(2, epoch1, recordingSources(fixtureSources(r), out), chains, [epoch1], quiet);
    const b = await assembleInputsV3(2, epoch1, fixtureSources(out), chains, [epoch1], quiet);
    assert.deepStrictEqual(b.inputs, a.inputs);
    assert.deepStrictEqual(out.errors, {});
    assert.strictEqual(buildV3(b.inputs, epoch1).file!.root, built.file!.root);
    // a failure is recorded too, and the replay skips the same chain
    const failing = withOverrides(r, { market: async (c) => { if (c.chainId === 8453) throw new Error("down"); return fixtureSources(r).market(c); } });
    const out2 = emptyRecording();
    const a2 = await assembleInputsV3(2, epoch1, recordingSources(failing, out2), chains, [epoch1], quiet);
    assert.match(out2.errors["market:8453"], /down/);
    const b2 = await assembleInputsV3(2, epoch1, fixtureSources(out2), chains, [epoch1], quiet);
    assert.deepStrictEqual(b2.skipped.map((x) => x.chainId), a2.skipped.map((x) => x.chainId));
  });

  // ── round 4: the rules block, the portal counters and their second provider, totalSupply (T2-RULES, X-010, T1-34) ──
  await test("T2-RULES / X-010: the reader records the rules block in force and the portal counters at toBlock (the logs' RPC)", () => {
    const i = base.inputs;
    assert.deepStrictEqual(i.rulesBlock, rulesForEpochV3(2, null), "the rules version in force, no pin");
    assert.deepStrictEqual(built.file!.rulesBlock, { ...DEFAULT_RULES_V3 }, "rules 1: tip minimum 0.2 XNT, every leaf claimed, no operator wallet");
    assert.strictEqual(built.file!.rulesBlock.tipMin, KEEPER_TIP_MIN_CLAIM.toString());
    assert.strictEqual(rulesInForceErrorV3(built.file!, null), null);
    assert.match(String(rulesInForceErrorV3(built.file!, "ab".repeat(32))), /not the pinned binary's/);
    const recorded = Object.values(fixture.recording.readChain);
    assert.deepStrictEqual(i.chains.map((c) => c.missionsAt).sort(), recorded.map((r) => r.totalMissions).sort(), "missionsAt = portal.totalMissions() at toBlock");
    // the recording predates totalBurned: burnedAt is null there, and a file without it is refused by the self-check
    assert(i.chains.every((c) => c.burnedAt === null));
    assert.deepStrictEqual(countersMissingV3(built.file!).length, 5, "a build of the live path always records both counters");
    assert(built.file!.burns.every((b) => b.backlog === false && b.operator === false && b.exception === null), "no backlog, no operator wallet in the fixture");
  });

  await test("X-010 / X-022: a second provider that disagrees skips the chain (cursor kept); none answering is a warning; agreeing changes nothing; the feed asks none", async () => {
    const r0 = rec();
    const missionsOf = (chainId: number) => Object.entries(r0.readChain).find(([k]) => k.startsWith(`${chainId}:`))![1].totalMissions;
    let calls = 0;
    const agree = await assembleInputsV3(2, epoch1, withOverrides(rec(), { counters: async (c, _to, except) => { calls++; assert.strictEqual(except, null, "the recording names no RPC"); return { totalMissions: missionsOf(c.chainId), totalBurned: "1", rpc: "second.example" }; } }), chains, [epoch1], quiet);
    assert.deepStrictEqual([agree.skipped, agree.warnings, calls], [[], [], 5]);
    assert.deepStrictEqual(agree.inputs, base.inputs, "agreeing counters change nothing (the primary's totalBurned is the recorded one)");
    const lying = await assembleInputsV3(2, epoch1, withOverrides(rec(), { counters: async (c) => ({ totalMissions: (BigInt(missionsOf(c.chainId)) + (c.chainId === 10 ? 1n : 0n)).toString(), totalBurned: "1", rpc: "second.example" }) }), chains, [epoch1], quiet);
    assert.deepStrictEqual(lying.skipped.map((s) => s.chainId), [10]);
    assert.match(lying.skipped[0].reason, /second\.example reads .* \(a lagging or lying RPC\)/);
    assert(!lying.inputs.chains.some((c) => c.chainId === 10), "the chain is left out (the engine carries its cursor)");
    const none = await assembleInputsV3(2, epoch1, withOverrides(rec(), { counters: async () => null }), chains, [epoch1], quiet);
    assert.deepStrictEqual(none.skipped, []);
    assert.strictEqual(none.warnings.filter((w) => /not confirmed by a second provider/.test(w)).length, 5);
    calls = 0;
    await assembleInputsV3(2, epoch1, withOverrides(rec(), { counters: async () => { calls++; return null; } }), chains, [epoch1], quiet, { reconcile: false });
    assert.strictEqual(calls, 0, "reconcile: false (the week-so-far feed) asks no second provider");
    // the primary's totalBurned is recorded and checked: below the burns read, the chain is skipped
    const short = withOverrides(rec(), {
      readChain: async (c, from, to) => {
        const r = await fixtureSources(rec()).readChain(c, from, to);
        const sum = r.burns.reduce((s, b) => s + BigInt(b.amountWei), 0n);
        return { ...r, totalBurned: (c.chainId === 10 ? sum - 1n : sum).toString(), rpc: "first.example" };
      },
    });
    const s = await assembleInputsV3(2, epoch1, short, chains, [epoch1], quiet);
    assert.deepStrictEqual(s.skipped.map((x) => x.chainId), [10]);
    assert.match(s.skipped[0].reason, /portal counters: portal\.totalBurned at toBlock is .* below the .* wei read/);
    assert(s.inputs.chains.every((c) => typeof c.burnedAt === "string"));
  });

  await test("T1-34: a failed totalSupply read is recorded as null with its reason (never \"0\"), the build goes on and verifies", async () => {
    const a = await assembleInputsV3(2, epoch1, withOverrides(rec(), { totalSupply: async (c, b) => { if (c.chainId === 56) throw new Error("every RPC failed"); return fixtureSources(rec()).totalSupply(c, b); } }), chains, [epoch1], quiet);
    const c56 = a.inputs.chains.find((c) => c.chainId === 56)!;
    assert.strictEqual(c56.totalSupply, null);
    assert.match(String(c56.totalSupplyError), /totalSupply at block \d+ could not be read: every RPC failed/);
    assert(a.warnings.some((w) => /could not be read/.test(w)));
    const f = buildV3(a.inputs, epoch1).file!;
    const r56 = f.chains.find((c) => c.chainId === 56)!;
    assert.deepStrictEqual([r56.totalSupply, typeof r56.totalSupplyError], [null, "string"]);
    assert.deepStrictEqual(verifyAny(f, epoch1), []);
    assert.strictEqual(f.root, built.file!.root, "informative only: the leaves are the same");
    // the engine refuses a null without its reason, and a reason with a reading
    const bad = clone(a.inputs);
    delete bad.chains.find((c) => c.chainId === 56)!.totalSupplyError;
    assert.throws(() => buildV3(bad, epoch1), /records why the read failed/);
    const bad2 = clone(base.inputs);
    bad2.chains[0].totalSupplyError = "x";
    assert.throws(() => buildV3(bad2, epoch1), /only with a totalSupply of null/);
  });

  console.log(`flow v3 plumbing tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
