/**
 * F5, the D-13 "carried" rule (owner approval 2026-10-25; the round-4 review's finding 5, the frozen L failing open): a chain read
 * this epoch whose window feed is missing or thin (fewer than L_MIN_SAMPLES_PER_DAY = 4 RECORDED hourly samples on more
 * than L_MAX_THIN_DAYS = 2 of the 7 stat days, the build's own reading not counted, or no recorded sample at all) keeps
 * its L for the next window (next = used, L.nextRule "carried"), and the anomaly gate holds the epoch
 * ("liquidity-samples-missing"). Covered here: every branch of liquidityCarriedV3, the engine's records on the golden
 * world d13-f5-carried, verification, the gate and its hold, the rules block (the two priceRules members, rulesId 2,
 * rulesId 1 refused) and the one line the e2e localnet profile substitutes.
 */
import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {
  AnyEpochFile, anomalyGateV3, buildEpochFileV3, computeEpochV3, dataHashV3, DEFAULT_RULES_V3, EpochFileV3, EpochInputsV3, GATE_HOLD_SECONDS, HOUR, L_MAX_THIN_DAYS,
  L_MIN_SAMPLES_PER_DAY, L_STAT_DAYS, liquidityCarriedV3, liquidityDaysV3, liquidityStatOfV3, liquidityStatV3, nextLiquidityV3, PRICE_RULES_V3, recordedLiquiditySamplesV3,
  RULES_ID_RETIRED_V3, RULES_ID_V3, rulesBlockOf, verifyEpochV3, windowStateV3,
} from "../src/rewards";
import { gateDecisionV3 } from "../src/flow-v3";
import { FIRST_RULES_ID_V3, RULES_V3_VERSIONS, rulesForEpochV3, rulesRegistryErrorV3 } from "../src/rules-v3";
import { daySamples } from "./fixtures/make-rules-vectors";

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
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

const VECTORS = path.join(__dirname, "fixtures", "rules-v3-vectors.json");
const doc: { worlds: { name: string; epochs: { inputs: EpochInputsV3; file: EpochFileV3 }[] }[] } = JSON.parse(fs.readFileSync(VECTORS, "utf8"));
const world = (name: string) => doc.worlds.find((w) => w.name === name)!;
const L = (f: EpochFileV3, id: number) => f.chains.find((c) => c.chainId === id)!.L;
const chainOf = (f: EpochFileV3, id: number) => f.chains.find((c) => c.chainId === id)!;

// a window end on an hour, and its samples by stat day (daySamples: counts[d] samples on day d, the end's hour left free)
const END = 1_800_000_000 - (1_800_000_000 % HOUR);
const endH = END / HOUR;
const week = (counts: number[], micro = 2_000_000_000n) => daySamples(END, micro, counts).map((s) => ({ hour: s.hour, micro: BigInt(s.micro) }));
const cov = (counts: number[], orphan = false) => liquidityCarriedV3(week(counts), END, orphan);
const FULL = [23, 23, 23, 23, 23, 23, 23];

// ── the parameters and the rules block ─────────────────────────────────────────────────────────
test("F5: the published parameters (4 samples a day, more than 2 thin days of the 7) are priceRules members; rulesId 2", () => {
  assert.strictEqual(L_MIN_SAMPLES_PER_DAY, 4);
  assert.strictEqual(L_MAX_THIN_DAYS, 2);
  assert.strictEqual(L_STAT_DAYS, 7);
  assert.strictEqual(PRICE_RULES_V3.liquidity.minSamplesPerDay, L_MIN_SAMPLES_PER_DAY);
  assert.strictEqual(PRICE_RULES_V3.liquidity.maxThinDays, L_MAX_THIN_DAYS);
  assert.deepStrictEqual(Object.keys(PRICE_RULES_V3.liquidity).sort(), [
    "dropBps", "firstBaseMicro", "firstMaxDays", "firstPerDayMicro", "freeze", "growthBps", "maxThinDays", "minSamplesPerDay", "reading", "stat", "statDays", "stepMicro", "switchL", "switchMinFullDays",
  ]);
  assert.deepStrictEqual([RULES_ID_V3, RULES_ID_RETIRED_V3, DEFAULT_RULES_V3.rulesId, FIRST_RULES_ID_V3], [2, 1, 2, 2]);
  assert.strictEqual(rulesBlockOf(DEFAULT_RULES_V3).rulesId, 2);
  assert.strictEqual(rulesRegistryErrorV3(), null);
  assert.deepStrictEqual(RULES_V3_VERSIONS.map((v) => v.rules.rulesId), [2]);
  assert.strictEqual(rulesForEpochV3(1, null).rulesId, 2, "the first v3 epoch is built under rulesId 2");
  assert.deepStrictEqual(rulesForEpochV3(1, null).priceRules.liquidity, PRICE_RULES_V3.liquidity);
});

test("F5: the round-4 block (rulesId 1, no F5 members) is never accepted, and no F5 value can be changed without a new rulesId", () => {
  const { minSamplesPerDay: _m, maxThinDays: _t, ...round4 } = PRICE_RULES_V3.liquidity;
  const block = (patch: Record<string, unknown>) => ({ ...DEFAULT_RULES_V3, ...patch });
  assert.throws(() => rulesBlockOf(block({ rulesId: 1 })), /rulesId 1 was replaced before any v3 epoch was built/);
  assert.throws(() => rulesBlockOf(block({ rulesId: 1, priceRules: { ...PRICE_RULES_V3, liquidity: round4 } })), /rulesId 1 was replaced/);
  assert.throws(() => rulesBlockOf(block({ priceRules: { ...PRICE_RULES_V3, liquidity: round4 } })), /rulesBlock.priceRules .* is not this engine's/);
  for (const [k, v] of [["minSamplesPerDay", 3], ["minSamplesPerDay", 5], ["minSamplesPerDay", "4"], ["maxThinDays", 1], ["maxThinDays", 3], ["maxThinDays", null]] as const) {
    assert.throws(() => rulesBlockOf(block({ priceRules: { ...PRICE_RULES_V3, liquidity: { ...PRICE_RULES_V3.liquidity, [k]: v } } })), /rulesBlock.priceRules/, `${k} = ${String(v)}`);
  }
  // a registry that starts at the retired id, or skips the first one, is refused
  const first = RULES_V3_VERSIONS[0];
  assert.match(String(rulesRegistryErrorV3([{ ...first, rules: { ...first.rules, rulesId: 1 } }])), /rules version 2: .*rulesId 1 was replaced/);
  assert.match(String(rulesRegistryErrorV3([{ ...first, rules: { ...first.rules, rulesId: 3 } }])), /rules version 2 has rulesId 3/);
  // a previous v3 file under the retired block is refused as epoch n−1 (the data hash made right, only the id changed)
  const w = world("d13-f5-carried");
  const old = clone(w.epochs[0].file) as EpochFileV3;
  old.rulesBlock.rulesId = 1;
  old.dataHash = dataHashV3(old);
  assert.throws(() => computeEpochV3(clone(w.epochs[1].inputs), old), /rulesId 1 was replaced/);
});

// ── liquidityCarriedV3, every branch ───────────────────────────────────────────────────────────
test("F5: a full feed is never carried; no recorded sample at all (no feed) is always carried", () => {
  assert.deepStrictEqual(cov(FULL), { carried: false, samples: 161, thinDays: 0 });
  assert.deepStrictEqual(liquidityCarriedV3([], END, false), { carried: true, samples: 0, thinDays: 7 });
  assert.deepStrictEqual(cov([0, 0, 0, 0, 0, 0, 0]), { carried: true, samples: 0, thinDays: 7 });
});

test("F5: thin = fewer than 4 samples in a day (4 is not thin); carried = more than 2 thin days (exactly 2 is not)", () => {
  assert.deepStrictEqual(cov([4, 4, 4, 4, 4, 4, 4]), { carried: false, samples: 28, thinDays: 0 }, "4 samples a day: no day is thin");
  assert.deepStrictEqual(cov([3, 3, 3, 3, 3, 3, 3]), { carried: true, samples: 21, thinDays: 7 }, "3 samples a day: every day is thin");
  assert.deepStrictEqual(cov([23, 23, 23, 0, 23, 4, 3]), { carried: false, samples: 99, thinDays: 2 }, "exactly 2 thin days: clamped");
  assert.deepStrictEqual(cov([3, 3, 4, 4, 4, 4, 4]), { carried: false, samples: 26, thinDays: 2 });
  assert.deepStrictEqual(cov([4, 4, 4, 4, 4, 0, 0]), { carried: false, samples: 20, thinDays: 2 }, "two empty days: still clamped");
  assert.deepStrictEqual(cov([23, 23, 23, 23, 3, 3, 0]), { carried: true, samples: 98, thinDays: 3 }, "3 thin days: carried");
  assert.deepStrictEqual(cov([4, 4, 4, 4, 3, 3, 3]), { carried: true, samples: 25, thinDays: 3 });
  assert.deepStrictEqual(cov([23, 23, 23, 23, 0, 0, 0]), { carried: true, samples: 92, thinDays: 3 }, "a feed that started 4 days before the build (the first v3 window)");
  assert.deepStrictEqual(cov([0, 23, 23, 23, 23, 0, 0]), { carried: true, samples: 92, thinDays: 3 }, "a feed that stopped a day before the build");
});

test("F5: a sample is a sample whatever it reads (a pull to 0 counts); the orphan exemption; the build's own reading never counts", () => {
  assert.deepStrictEqual(liquidityCarriedV3(week(FULL, 0n), END, false), { carried: false, samples: 161, thinDays: 0 }, "readings of 0 are recorded readings");
  // D-21: an orphaned chain has no market and reads 0 by rule (no LP can move it): never carried, its frozen L keeps halving
  assert.deepStrictEqual(liquidityCarriedV3([], END, true), { carried: false, samples: 0, thinDays: 7 });
  assert.strictEqual(cov([3, 3, 3, 3, 3, 3, 3], true).carried, false);
  // r6-review 3: the build's own reading is the statistic only when nothing is recorded, and never a coverage sample
  assert.strictEqual(liquidityStatOfV3([], END, 5n), 5n, "no feed: the statistic is the build's own reading");
  assert.deepStrictEqual(liquidityCarriedV3(recordedLiquiditySamplesV3([], END, "c"), END, false), { carried: true, samples: 0, thinDays: 7 }, "the coverage does not");
  // a sample RECORDED for the end's hour is a feed sample like any other
  const atEnd = [{ hour: endH, micro: "7" }];
  assert.deepStrictEqual(liquidityCarriedV3(recordedLiquiditySamplesV3(atEnd, END, "c"), END, false), { carried: true, samples: 1, thinDays: 7 });
  assert.deepStrictEqual(liquidityCarriedV3(recordedLiquiditySamplesV3(null, END, "c"), END, false).samples, 0, "null = none recorded");
});

test("F5: the coverage counts the statistic's own 7 day buckets (liquidityDaysV3): older samples and the 7-day edge do not count", () => {
  // day d = ⌊(endTs − hour start) / DAY⌋: the hour starting exactly 7 days before the end is day 7, outside the window
  const edge = [{ hour: endH - 168, micro: 1n }, { hour: endH - 167, micro: 2n }];
  assert.deepStrictEqual([...liquidityDaysV3(edge, END).entries()], [[6, [2n]]]);
  assert.deepStrictEqual(liquidityCarriedV3(edge, END, false), { carried: true, samples: 1, thinDays: 7 });
  assert.deepStrictEqual(liquidityCarriedV3([{ hour: endH - 24 * 8, micro: 1n }], END, false), { carried: true, samples: 0, thinDays: 7 }, "a late window's old samples: recorded, not counted");
  // the statistic and the coverage group the same samples the same way
  const xs = week([5, 23, 1, 0, 9, 4, 23]);
  const days = liquidityDaysV3(xs, END);
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6].map((d) => days.get(d)?.length ?? 0), [5, 23, 1, 0, 9, 4, 23]);
  assert.strictEqual(liquidityStatV3(xs, END), 2_000_000_000n);
  // the hour at the end itself is day 0, the 23 hours before it too; the 24th hour back is day 1
  assert.deepStrictEqual([...liquidityDaysV3([{ hour: endH - 24, micro: 1n }, { hour: endH - 23, micro: 1n }, { hour: endH, micro: 1n }], END).entries()].map(([d, v]) => [d, v.length]), [[1, 1], [0, 2]]);
});

// ── the engine (golden world d13-f5-carried) ──────────────────────────────────────────────────
test("golden d13-f5-carried: carried chains keep the L in force; full or 2-thin-day feeds are clamped; a skipped chain keeps its next", () => {
  const w = world("d13-f5-carried");
  const [f1, f2, f3] = w.epochs.map((e) => e.file);
  for (const id of [10, 56, 137, 250, 8453, 42161]) assert.deepStrictEqual([L(f1, id).rule, L(f1, id).nextRule, L(f1, id).next], ["genesis", "clamp", "2000000000"], `epoch 1 chain ${id}`);
  const row = (f: EpochFileV3, id: number) => [L(f, id).rule, L(f, id).used, L(f, id).stat, L(f, id).nextRule, L(f, id).next];
  assert.deepStrictEqual(row(f2, 10), ["frozen", "2000000000", "2000000000", "clamp", "2000000000"], "a full feed: the JIT build reading is one sample");
  assert.deepStrictEqual(row(f2, 56), ["frozen", "2000000000", "3000000000", "clamp", "2250000000"], "exactly 2 thin days: clamped (+10% + $50)");
  assert.deepStrictEqual(row(f2, 137), ["frozen", "2000000000", "3000000000", "carried", "2000000000"], "3 thin days: carried");
  assert.deepStrictEqual(row(f2, 8453), ["frozen", "2000000000", "100000000000", "carried", "2000000000"], "no feed: the build's own $100k reading is the whole statistic, and moves nothing");
  assert.deepStrictEqual(row(f2, 42161), ["frozen", "2000000000", "3000000000", "carried", "2000000000"], "a feed of the last 4 days only: carried");
  assert.strictEqual(nextLiquidityV3(BigInt(L(f2, 8453).stat!), 2_000_000_000n), 2_250_000_000n, "without F5 the build's own reading would have raised the next L");
  assert.deepStrictEqual([chainOf(f2, 250).skipped, L(f2, 250).rule, L(f2, 250).nextRule, L(f2, 250).next], [true, "carried", "carried", "2000000000"]);
  // epoch 3: the carried L is the L in force; a full feed now moves it by the clamp; a skipped chain keeps the next it had
  assert.deepStrictEqual(row(f3, 137), ["frozen", "2000000000", "3000000000", "clamp", "2250000000"]);
  assert.deepStrictEqual([chainOf(f3, 56).skipped, L(f3, 56).used, L(f3, 56).nextRule, L(f3, 56).next], [true, "2000000000", "carried", "2250000000"], "skipped: its previous next, as before F5");
  for (const [i, e] of w.epochs.entries()) {
    assert.deepStrictEqual(verifyEpochV3(e.file, i ? w.epochs[i - 1].file : null), [], `epoch ${e.file.epoch} verifies`);
    assert.strictEqual(JSON.stringify(buildEpochFileV3(clone(e.inputs), i ? w.epochs[i - 1].file : null)), JSON.stringify(e.file), `epoch ${e.file.epoch} rebuilds byte for byte`);
  }
  // every L record of every golden file states how its next was set
  for (const v of doc.worlds) for (const e of v.epochs) for (const c of e.file.chains) assert(c.L.nextRule === "clamp" || c.L.nextRule === "carried", `${v.name} epoch ${e.file.epoch} chain ${c.chainId}`);
});

test("F5 changes only the next window's L: this window's values, claims, leaves and root are those of a full feed", () => {
  const w = world("d13-f5-carried");
  const [f1, f2] = w.epochs.map((e) => e.file);
  const full = clone(w.epochs[1].inputs);
  for (const c of full.chains) c.liquiditySamples = daySamples(full.window.endTs, 3_000_000_000n, FULL);
  const g = buildEpochFileV3(full, f1)!;
  for (const id of [137, 8453, 42161]) assert.strictEqual(L(g, id).nextRule, "clamp", `chain ${id} with a full feed`);
  assert.deepStrictEqual(g.burns.map((b) => [b.valueMicro, b.alloc, b.senior]), f2.burns.map((b) => [b.valueMicro, b.alloc, b.senior]));
  assert.deepStrictEqual([g.root, g.totalScore, g.leaves], [f2.root, f2.totalScore, f2.leaves]);
  // the window's own values never depend on its feed (option a): only next and nextRule move
  const st = windowStateV3(clone(w.epochs[1].inputs), f1);
  assert.deepStrictEqual(st.works.map((x) => x.value.toString()), windowStateV3(full, f1).works.map((x) => x.value.toString()));
});

test("F5: one sample fewer on a day with exactly 4 makes it thin: 3 thin days, so the chain is carried", () => {
  const w = world("d13-f5-carried");
  const f1 = w.epochs[0].file;
  const inp = clone(w.epochs[1].inputs);
  const c56 = inp.chains.find((c) => c.chainId === 56)!;
  const endTs = inp.window.endTs;
  const day5 = c56.liquiditySamples!.filter((s) => Math.floor((endTs - s.hour * HOUR) / 86_400) === 5);
  assert.strictEqual(day5.length, 4);
  c56.liquiditySamples = c56.liquiditySamples!.filter((s) => s !== day5[0]);
  const b = computeEpochV3(inp, f1)!;
  assert.deepStrictEqual([L(b as EpochFileV3, 56).nextRule, L(b as EpochFileV3, 56).next], ["carried", "2000000000"]);
});

test("r6-review 3 (AR-5): the feed stops in the last 24 h and an LP pulls the pool at the build: the next L is not halved", () => {
  const w = world("d13-f5-carried");
  const f1 = w.epochs[0].file;
  const inp = clone(w.epochs[1].inputs);
  const c10 = inp.chains.find((c) => c.chainId === 10)!;
  const endTs = inp.window.endTs;
  // 6 full days at $2,000, day 0 (the last 24 h) empty: 1 thin day, so the chain is clamped, not carried
  c10.liquiditySamples = daySamples(endTs, 2_000_000_000n, [0, 23, 23, 23, 23, 23, 23]);
  c10.liquidityNowMicro = "0";
  c10.liquidityOnChainMicro = "0";
  const f = computeEpochV3(inp, f1) as EpochFileV3;
  const l = L(f, 10);
  assert.deepStrictEqual([l.nextRule, l.stat, l.next], ["clamp", "2000000000", nextLiquidityV3(2_000_000_000n, BigInt(l.used!)).toString()], "the build's $0 reading is not a sample");
  assert.notStrictEqual(l.next, (BigInt(l.used!) / 2n).toString(), "(before r6-review 3 the stat was the build's $0 and the next L halved)");
  assert.strictEqual(liquidityStatV3([...recordedLiquiditySamplesV3(c10.liquiditySamples, endTs, "c"), { hour: endTs / HOUR, micro: 0n }], endTs), 0n, "the old statistic over every day, the build reading included");
  // the feed came back for 3 hours on day 0 at $1: a thin day never decides while full days exist
  c10.liquiditySamples = [...daySamples(endTs, 2_000_000_000n, [0, 23, 23, 23, 23, 23, 23]), ...[3, 2, 1].map((k) => ({ hour: endTs / HOUR - k, micro: "1000000" }))];
  assert.strictEqual(L(computeEpochV3(inp, f1) as EpochFileV3, 10).stat, "2000000000");
  assert.deepStrictEqual(anomalyGateV3(f, f1, [f1]).filter((r) => r.code === "liquidity-samples-missing" && r.text.startsWith("chain 10:")), [], "and no F5 reason (it is clamped)");
});

test("F5: a file whose L.nextRule or carried next was edited fails verification", () => {
  const w = world("d13-f5-carried");
  const [f1, f2] = w.epochs.map((e) => e.file);
  const tamper = (fn: (g: EpochFileV3) => void) => {
    const g = clone(f2);
    fn(g);
    g.dataHash = dataHashV3(g);
    return verifyEpochV3(g, f1);
  };
  assert(tamper((g) => (L(g, 137).nextRule = "clamp")).some((e) => /chains does not match the recomputation/.test(e)));
  assert(tamper((g) => (L(g, 137).next = "2250000000")).some((e) => /chains does not match the recomputation/.test(e)), "the clamp value on a carried chain");
  assert(tamper((g) => (L(g, 56).nextRule = "carried")).some((e) => /chains does not match the recomputation/.test(e)));
  assert(tamper((g) => (L(g, 56).next = "2000000000")).some((e) => /chains does not match the recomputation/.test(e)), "a carried value on a clamped chain");
  assert(tamper((g) => delete (L(g, 10) as { nextRule?: unknown }).nextRule).length > 0, "the member is required");
  // the recorded samples are hashed inputs: dropping one after the build breaks the published data hash
  const g = clone(f2);
  chainOf(g, 137).liquiditySamples.splice(0, 1);
  assert(verifyEpochV3(g, f1).some((e) => /dataHash mismatch/.test(e)));
});

test("D-21 + F5: an orphaned chain with no feed is not carried: its frozen L still halves each week", () => {
  const w = world("d21-orphaned-chain");
  const f7 = w.epochs[6].file;
  const c = chainOf(f7, 56);
  assert.deepStrictEqual([c.skipped, c.orphan !== null, c.liquiditySamples.length, c.L.nextRule], [false, true, 0, "clamp"]);
  assert.strictEqual(c.L.next, (BigInt(c.L.used!) / 2n).toString());
  assert(!anomalyGateV3(f7, w.epochs[5].file, [w.epochs[5].file]).some((r) => r.code === "liquidity-samples-missing" && r.text.startsWith("chain 56:")), "and it does not trip the gate");
});

// ── the anomaly gate ────────────────────────────────────────────────────────────────────────────
test("F5 gate: one liquidity-samples-missing reason per carried chain read this epoch (none for a skipped or clamped chain)", () => {
  const w = world("d13-f5-carried");
  const [f1, f2, f3] = w.epochs.map((e) => e.file);
  const mine = (f: EpochFileV3, p: AnyEpochFile | null, h: AnyEpochFile[]) => anomalyGateV3(f, p, h).filter((r) => r.code === "liquidity-samples-missing");
  assert.deepStrictEqual(mine(f1, null, []), [], "a full feed everywhere");
  const r2 = mine(f2, f1, [f1]);
  assert.deepStrictEqual(r2.map((r) => r.text.split(":")[0]), ["chain 137", "chain 8453", "chain 42161"]);
  assert.match(r2[0].text, /^chain 137: 98 recorded hourly liquidity samples in the last 7 days, 3 of the 7 days with fewer than 4 \(more than 2, or none\): its next L is carried/);
  assert.match(r2[1].text, /^chain 8453: 0 recorded hourly liquidity samples in the last 7 days, 7 of the 7 days/);
  assert.match(r2[2].text, /^chain 42161: 92 recorded hourly liquidity samples in the last 7 days, 3 of the 7 days/);
  assert.deepStrictEqual(anomalyGateV3(f2, f1, [f1]).map((r) => r.code), ["liquidity-samples-missing", "liquidity-samples-missing", "liquidity-samples-missing"], "nothing else trips");
  assert.deepStrictEqual(mine(f3, f2, [f2, f1]), [], "epoch 3: chain 137 is clamped again; the skipped chains are not read");
});

test("F5 gate: the hold is a plain D-17 hold (24 h, then released when the rebuild trips nothing new); a heartbeat is never held", () => {
  const w = world("d13-f5-carried");
  const [f1, f2] = w.epochs.map((e) => e.file);
  const reasons = anomalyGateV3(f2, f1, [f1]);
  const t0 = 1_800_000_000;
  const h = gateDecisionV3(reasons, null, t0, false, 2, f2.dataHash);
  assert.deepStrictEqual([h.action, h.record!.until], ["hold", t0 + GATE_HOLD_SECONDS]);
  assert.strictEqual(gateDecisionV3(reasons, h.record, t0 + GATE_HOLD_SECONDS - 1, false, 2, f2.dataHash).action, "wait");
  // the feed is still thin at the rebuild: the same reason, so the epoch is released (it is never blocked by F5 alone)
  assert.strictEqual(gateDecisionV3(reasons, h.record, t0 + GATE_HOLD_SECONDS, false, 2, "rebuilt").action, "release");
  assert.strictEqual(gateDecisionV3(reasons, h.record, t0 + GATE_HOLD_SECONDS, true, 2, "rebuilt").action, "blocked", "GATE_BLOCK still keeps it held");
  assert.strictEqual(gateDecisionV3(reasons, null, t0, true, 2, "hb", true).action, "publish", "a heartbeat pays nothing: never held");
});

// ── the e2e localnet profile (tests/e2e-oracle/preload.cjs) ───────────────────────────────────────
test("the one day-bucket line the e2e localnet profile substitutes is still in rewards.ts exactly once (statistic and coverage share it)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "rewards.ts"), "utf8");
  const line = "const d = Math.floor((endTs - s.hour * HOUR) / DAY);";
  assert.strictEqual(src.split(line).length - 1, 1);
  assert.strictEqual(src.split("export const DAY = 86_400;").length - 1, 1);
  const body = (name: string) => src.slice(src.indexOf(`export function ${name}(`), src.indexOf("\n}\n", src.indexOf(`export function ${name}(`)));
  assert(body("liquidityCarriedV3").includes("liquidityDaysV3(") && !body("liquidityCarriedV3").includes("/ DAY"), "the coverage buckets through liquidityDaysV3");
  assert(body("liquidityStatV3").includes("liquidityDaysV3(") && !body("liquidityStatV3").includes("/ DAY"), "so does the statistic");
});

console.log(`F5 carried-L tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
