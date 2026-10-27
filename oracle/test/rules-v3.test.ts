/**
 * The v3 rules of round 4 (2026-10-25): the hashed rules block (T2-RULES), D-12 backlog ranking, D-14 keccak tie-break,
 * D-18 operator wallets with a PROOF_BURN_RULE (c) dated exception, X-010 portal counters, T1-34 totalSupply, CF-22 the
 * publish-age guard, the rules registry (rules-v3.ts) and the golden vectors (test/fixtures/rules-v3-vectors.json).
 */
import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { ethers } from "ethers";
import { PublicKey } from "@solana/web3.js";
import {
  allocateBurns, allocItem, AnyEpochFile, BACKLOG_RULE_V3, buildEpochFileV3, CLOCK_SKEW_MAX, computeEpochV3, countersErrorV3, dataHashV3, DEFAULT_RULES_V3, EpochFileV3,
  EpochInputsV3, globalOrder, KEEPER_TIP_MIN_CLAIM, MAX_PUBLISH_LAG, operatorOfV3, publishAgeError, rankOrderV3, RULES_ID_V3, rulesBlockOf, RulesBlockV3, TIE_BREAK_V3,
  tieKeyV3, verifyEpochV3, VEST_MIN_ENT, windowStateV3, PRICE_RULES_V3,
} from "../src/rewards";
import { countersMissingV3, RULES_V3_VERSIONS, rulesForEpochV3, rulesInForceErrorV3, rulesRegistryErrorV3, RulesVersionV3 } from "../src/rules-v3";
import { vectorWorlds, wallet } from "./fixtures/make-rules-vectors";

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
const doc: { engineSha256: string; worlds: { name: string; epochs: { inputs: EpochInputsV3; file: EpochFileV3 }[] }[] } = JSON.parse(fs.readFileSync(VECTORS, "utf8"));
const world = (name: string) => doc.worlds.find((w) => w.name === name)!;

// ── golden vectors ─────────────────────────────────────────────────────────────────────────────
test("golden vectors: every recorded file is rebuilt byte for byte from its inputs and verifies; the generator gives the same vectors", () => {
  assert.strictEqual(doc.worlds.length, 8);
  for (const w of doc.worlds) {
    let prev: AnyEpochFile | null = null;
    for (const e of w.epochs) {
      const again = buildEpochFileV3(clone(e.inputs), prev);
      assert(again, `${w.name} epoch ${e.inputs.epoch}`);
      assert.strictEqual(JSON.stringify(again), JSON.stringify(e.file), `${w.name} epoch ${e.inputs.epoch}: the engine changed a golden file (regenerate on purpose: npx ts-node test/fixtures/make-rules-vectors.ts)`);
      assert.strictEqual(e.file.dataHash, dataHashV3(e.file));
      assert.deepStrictEqual(verifyEpochV3(e.file, prev), [], `${w.name} epoch ${e.inputs.epoch} verifies`);
      prev = e.file;
    }
  }
  assert.strictEqual(JSON.stringify(vectorWorlds()), JSON.stringify(doc.worlds), "make-rules-vectors.ts reproduces the stored vectors");
  const engine = createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", "src", "rewards.ts"), "utf8").replace(/\r\n/g, "\n")).digest("hex");
  if (engine !== doc.engineSha256) console.log(`  (note: rewards.ts changed since the vectors were written, ${doc.engineSha256.slice(0, 12)}… → ${engine.slice(0, 12)}…; the files are unchanged)`);
});

test("golden D-14: same-second burns on four chains are served in the keccak256(txHash ‖ logIndex) order (ethers solidityPackedKeccak256 agrees)", () => {
  const f = world("d14-same-second").epochs[0].file;
  const keys = f.burns.map((b) => tieKeyV3(b.txHash, b.logIndex));
  assert.deepStrictEqual(keys, [...keys].sort(), "the file lists them in key order");
  for (const b of f.burns) assert.strictEqual("0x" + tieKeyV3(b.txHash, b.logIndex), ethers.solidityPackedKeccak256(["bytes32", "uint256"], [b.txHash, b.logIndex]));
  assert.deepStrictEqual(new Set(f.burns.map((b) => b.timestamp)).size, 1);
  assert.deepStrictEqual(f.burns.map((b) => b.chainId), [56, 10, 10, 137, 8453], "not the chain order, not the block order");
  assert.deepStrictEqual(f.burns.map((b) => b.senior), ["6248750", "2751250", "0", "0", "0"], "the day-0 tranche (9,000,000) serves the lowest key first");
});

test("golden D-12: the skipped chain's burn is backlog: after the window's burns at the arrival (window end day), first in the leftover", () => {
  const w = world("d12-backlog");
  const [, f2, f3] = w.epochs.map((e) => e.file);
  assert.strictEqual(f2.chains.find((c) => c.chainId === 56)!.skipped, true);
  const late = f3.burns[2];
  assert.deepStrictEqual([late.chainId, late.backlog, late.operator, late.exception], [56, true, false, null]);
  assert(late.timestamp < f3.window.startTs, "stamped before the window start");
  assert.strictEqual(late.day, 5, "a 5.8-day window: its end day (endTs + CLOCK_SKEW_MAX) is day 5, which releases 6/7 of C");
  assert.deepStrictEqual(f3.burns.map((b) => b.backlog), [false, false, true], "ranked after every burn of the window");
  const C = BigInt(f3.capacity.cash);
  assert.strictEqual(BigInt(late.senior), (6n * C) / 7n - BigInt(f3.burns[0].senior) - BigInt(f3.burns[1].senior), "its arrival claim is what the window's burns left of the day-5 release");
  // the leftover (C/7 never released at the arrival) goes to the backlog's unmet Launchpad layer first
  const topUp = (b: (typeof f3.burns)[number]) => BigInt(b.alloc) - BigInt(b.senior);
  assert.strictEqual(topUp(late), C / 7n, "the whole leftover to the backlog first");
  assert.strictEqual(topUp(f3.burns[0]), 0n, "the window's mission waits behind it in the leftover");
  assert.strictEqual(f3.capacity.left, "0");
  // without the backlog, the window's burns are paid exactly the same at their arrival
  const inp = clone(w.epochs[2].inputs);
  const c56 = inp.chains.find((c) => c.chainId === 56)!;
  c56.burns = c56.burns.filter((b) => b.timestamp >= inp.window.startTs);
  c56.missionsAt = null;
  c56.burnedAt = null;
  const alone = computeEpochV3(inp, f2)!;
  for (const b of alone.burns) {
    const o = f3.burns.find((x) => x.txHash === b.txHash)!;
    assert.deepStrictEqual([b.senior, b.lockedLp, b.bandPaid, b.leafTier], [o.senior, o.lockedLp, o.bandPaid, o.leafTier], "the backlog never moves a window burn's arrival outcome");
  }
});

test("golden D-18 + PROOF_BURN_RULE (c): the operator claims only what every other claim left; the exception burn competes like any other", () => {
  const f = world("d18-operator-exception").epochs[0].file;
  const [W1, W2, W7, W8] = [wallet(1), wallet(2), wallet(7), wallet(8)];
  assert.deepStrictEqual(f.burns.map((b) => [b.x1, b.operator, b.exception]), [
    [W1, false, null], [W8, false, "proof plan 2026-11"], [W2, false, null], [W7, true, null], [W8, true, null],
  ]);
  assert(f.burns[3].timestamp < f.burns[0].timestamp, "the operator burned first and is served last");
  assert.deepStrictEqual([f.burns[3].day, f.burns[4].day], [7, 7], "operator burns claim on the window's end day");
  const C = BigInt(f.capacity.cash);
  const others = f.burns.slice(0, 3).reduce((s, b) => s + BigInt(b.alloc), 0n);
  assert.strictEqual(BigInt(f.burns[3].alloc), C - others, "after every other burn's arrival claim AND top-up");
  assert(f.burns.slice(0, 3).every((b) => b.alloc === b.lp), "every other Launchpad layer is whole first");
  assert.strictEqual(f.burns[4].alloc, "0", "the proof wallet outside its dated range ranks last too");
  assert.strictEqual(f.rulesBlock.operatorWallets.exceptions[0].published, "2026-11-24");
});

test("golden X-010 / T1-34: the counters continue the previous record (a skipped chain carries them); a failed totalSupply is null with its reason", () => {
  const [f1, f2] = world("x010-counters-t134-supply").epochs.map((e) => e.file);
  const c = (f: EpochFileV3, id: number) => f.chains.find((x) => x.chainId === id)!;
  assert.deepStrictEqual([c(f1, 10).missionsAt, c(f2, 10).missionsAt], ["2", "3"]);
  assert.strictEqual(BigInt(c(f2, 10).burnedAt!) - BigInt(c(f1, 10).burnedAt!), BigInt(f2.burns[0].amountWei));
  assert.deepStrictEqual([c(f2, 56).skipped, c(f2, 56).missionsAt, c(f2, 56).burnedAt, c(f2, 56).totalSupply], [true, "1", c(f1, 56).burnedAt, null]);
  assert.match(String(c(f2, 56).totalSupplyError), /could not be read/);
  // a counter that does not continue the previous record is refused by the engine
  const inp = clone(world("x010-counters-t134-supply").epochs[1].inputs);
  inp.chains[0].missionsAt = "4";
  assert.throws(() => computeEpochV3(inp, f1), /the last mission id read is 3, but the portal counts 4 missions/);
  inp.chains[0].missionsAt = "3";
  inp.chains[0].burnedAt = (BigInt(inp.chains[0].burnedAt!) + 1n).toString();
  assert.throws(() => computeEpochV3(inp, f1), /not the previous record's .* \+ the .* wei read/);
});

// ── the rules block ────────────────────────────────────────────────────────────────────────────
test("T2-RULES: the default block (rules 1) and every pinned member", () => {
  const r = rulesBlockOf(DEFAULT_RULES_V3);
  assert.deepStrictEqual(r, {
    programRules: 3, programHash: null, rulesId: RULES_ID_V3, tipMin: "200000000", autoClaimMin: "0", dustRule: { vestMinEnt: "20000000" },
    tieBreak: TIE_BREAK_V3, backlogRule: BACKLOG_RULE_V3, operatorWallets: { rule: "rank-last", wallets: [], exceptions: [] }, priceRules: PRICE_RULES_V3,
  });
  assert.strictEqual(KEEPER_TIP_MIN_CLAIM, 200_000_000n, "the 0.2 XNT keeper-tip minimum is final (constants.rs KEEPER_TIP_MIN_CLAIM)");
  assert.strictEqual(VEST_MIN_ENT, 20_000_000n);
  const bad = (patch: Record<string, unknown>, re: RegExp) => assert.throws(() => rulesBlockOf({ ...DEFAULT_RULES_V3, ...patch }), re);
  bad({ programRules: 2 }, /only on the upgraded program/);
  bad({ programHash: "AB".repeat(32) }, /lowercase sha256 hex/);
  bad({ rulesId: 0 }, /version number/);
  bad({ tipMin: "20000000" }, /not the upgraded program's keeper-tip minimum/);
  bad({ autoClaimMin: "1" }, /the only value is "0"/);
  bad({ dustRule: { vestMinEnt: "-1" } }, /canonical unsigned integer/);
  bad({ dustRule: { vestMinEnt: "1", more: 1 } }, /exactly the members/);
  bad({ tieBreak: "chainId" }, /is not keccak256/);
  bad({ backlogRule: "first" }, /is not after-current-senior/);
  bad({ extra: 1 }, /exactly the members/);
  // D-13 / D-22 / D-17: the price, liquidity and gate parameters are pinned (a change is a new rulesId)
  bad({ priceRules: { ...PRICE_RULES_V3, xntTranche: { maxReserveBps: 300 } } }, /rulesBlock.priceRules .* is not this engine's/);
  bad({ priceRules: { ...PRICE_RULES_V3, liquidity: { ...PRICE_RULES_V3.liquidity, dropBps: 4_000 } } }, /rulesBlock.priceRules/);
  bad({ priceRules: undefined }, /exactly the members|rulesBlock.priceRules/);
  assert.throws(() => rulesBlockOf({ ...DEFAULT_RULES_V3, operatorWallets: { rule: "leftover-only", wallets: [], exceptions: [] } }), /is not rank-last/);
  // the engine reads the dust rule from the block
  const ws = [allocItem(1, 0, 10_000_000n, 10_000_000n)];
  allocateBurns(ws, 140_000_000n, BigInt(DEFAULT_RULES_V3.dustRule.vestMinEnt));
  assert.strictEqual(ws[0].leafTier, 1, "a whole 0.02 XNT mission locks under the default dust rule");
  const dust = [allocItem(1, 0, 10_000_000n, 9_999_999n)];
  allocateBurns(dust, 140_000_000n, BigInt(DEFAULT_RULES_V3.dustRule.vestMinEnt));
  assert.deepStrictEqual([dust[0].leafTier, dust[0].converted], [0, true], "just below vestMinEnt it is paid as Launchpad");
});

test("D-18 / PROOF_BURN_RULE (c): operator wallets and dated, named exceptions are canonical and never ambiguous", () => {
  const [a, b, c] = [wallet(1), wallet(2), wallet(3)].sort();
  const T = 1_800_000_000;
  const ow = (wallets: string[], exceptions: RulesBlockV3["operatorWallets"]["exceptions"]) => ({ ...DEFAULT_RULES_V3, operatorWallets: { rule: "rank-last" as const, wallets, exceptions } });
  const ex = (o: Partial<RulesBlockV3["operatorWallets"]["exceptions"][number]> = {}) => ({ name: "proof plan", wallets: [c], fromTs: T, untilTs: T + 86_400, published: "2027-01-15", ...o });
  assert.doesNotThrow(() => rulesBlockOf(ow([a, b], [ex()])));
  assert.throws(() => rulesBlockOf(ow([b, a], [])), /strictly ascending/);
  assert.throws(() => rulesBlockOf(ow([a, a], [])), /strictly ascending/);
  assert.throws(() => rulesBlockOf(ow(["not-a-key"], [])), /canonical base58/);
  assert.throws(() => rulesBlockOf(ow([], [ex({ published: "2027-01-16" })])), /published 2027-01-16, after the exception starts/);
  assert.throws(() => rulesBlockOf(ow([], [ex({ published: "2027-1-15" })])), /YYYY-MM-DD/);
  assert.throws(() => rulesBlockOf(ow([], [ex({ untilTs: T })])), /must be before untilTs/);
  assert.throws(() => rulesBlockOf(ow([], [ex({ name: " padded" })])), /trimmed line/);
  assert.throws(() => rulesBlockOf(ow([], [ex({ wallets: [] })])), /at least one wallet/);
  assert.throws(() => rulesBlockOf(ow([], [ex({ name: "b" }), ex({ name: "a" })])), /by name/);
  assert.throws(() => rulesBlockOf(ow([], [ex({ name: "a" }), ex({ name: "b", fromTs: T + 3_600 })])), /overlapping exceptions "a" and "b"/);
  assert.doesNotThrow(() => rulesBlockOf(ow([], [ex({ name: "a" }), ex({ name: "b", fromTs: T + 86_400, untilTs: T + 2 * 86_400 })])), "back to back");
  const o = rulesBlockOf(ow([a], [ex()])).operatorWallets;
  assert.deepStrictEqual(operatorOfV3(o, a, T), { operator: true, exception: null });
  assert.deepStrictEqual(operatorOfV3(o, c, T), { operator: false, exception: "proof plan" });
  assert.deepStrictEqual(operatorOfV3(o, c, T + 86_399), { operator: false, exception: "proof plan" });
  assert.deepStrictEqual(operatorOfV3(o, c, T + 86_400), { operator: true, exception: null }, "outside its range, an operator wallet");
  assert.deepStrictEqual(operatorOfV3(o, c, T - 1), { operator: true, exception: null });
  assert.deepStrictEqual(operatorOfV3(o, b, T), { operator: false, exception: null });
});

test("T2-RULES: a rules version never goes back from one epoch to the next", () => {
  const w = world("x010-counters-t134-supply");
  const r2 = { ...DEFAULT_RULES_V3, rulesId: 2 };
  const i1 = { ...clone(w.epochs[0].inputs), rulesBlock: r2 };
  const f1 = buildEpochFileV3(i1, null)!;
  assert.strictEqual(f1.rulesBlock.rulesId, 2);
  const i2 = clone(w.epochs[1].inputs);
  assert.throws(() => computeEpochV3({ ...i2, rulesBlock: DEFAULT_RULES_V3 }, f1), /rulesId 1 is below the previous file's 2/);
  assert(computeEpochV3({ ...i2, rulesBlock: r2 }, f1));
  // a file written without the block is recomputed under the default and fails verification
  const { rulesBlock: _r, ...stripped } = clone(w.epochs[0].file) as EpochFileV3 & { rulesBlock?: unknown };
  const noBlock = { ...stripped, dataHash: "" } as unknown as EpochFileV3;
  noBlock.dataHash = dataHashV3(noBlock);
  assert(verifyEpochV3(noBlock, null).some((e) => /rulesBlock does not match the recomputation/.test(e)));
});

test("D-14: the tie key is keccak256(bytes32 txHash ‖ uint256 logIndex); a tx hash must be 32 bytes", () => {
  const h = "0x" + "11".repeat(32);
  assert.strictEqual(tieKeyV3(h, 5), "ac00b23a846b2a9258ef918be58333f931a077ed9d20285597a29c7a7d0357cc");
  assert.strictEqual("0x" + tieKeyV3(h, 2 ** 40), ethers.solidityPackedKeccak256(["bytes32", "uint256"], [h, 2 ** 40]));
  const a = { chainId: 10, txHash: h, logIndex: 1, blockNumber: 1, timestamp: 100 } as never;
  const b = { chainId: 56, txHash: h, logIndex: 1, blockNumber: 9, timestamp: 100 } as never;
  assert(globalOrder(a, b) < 0, "the same hash and index on two chains (a replayed transaction): the chain id breaks the tie");
  assert.throws(() => tieKeyV3("0x1234", 0), /32 bytes of hex/);
  const inp = clone(world("d14-same-second").epochs[0].inputs);
  inp.chains[0].burns[0].txHash = inp.chains[0].burns[0].txHash.toUpperCase().replace("0X", "0x");
  assert.throws(() => computeEpochV3(inp, null), /bad txHash \(0x and 64 lowercase hex digits\)/);
});

test("D-12 / D-18: the plan: stage 1 = the window's burns then the backlog (arrival), the backlog then the window's burns (leftover); stage 2 = the operator burns", () => {
  const ws = [
    { id: "w1", backlog: false, operator: false }, { id: "op1", backlog: false, operator: true }, { id: "b1", backlog: true, operator: false },
    { id: "w2", backlog: false, operator: false }, { id: "b2", backlog: true, operator: true },
  ];
  const r = rankOrderV3(ws);
  assert.deepStrictEqual(r.arrival.map((x) => x.id), ["w1", "w2", "b1", "op1", "b2"]);
  assert.deepStrictEqual(r.plan, { stages: [{ arrival: [0, 1, 2], leftover: [2, 0, 1] }, { arrival: [3, 4], leftover: [3, 4] }] });
  assert.throws(() => allocateBurns([allocItem(0, 0, 1n, 0n)], 7n, VEST_MIN_ENT, undefined, { stages: [{ arrival: [0], leftover: [] }] }), /every item exactly once/);
  // with no backlog and no operator burn, the plan is the plain FCFS run
  const a = [allocItem(0, 0, 5n, 0n), allocItem(1, 2, 5n, 5n)];
  const b = [allocItem(0, 0, 5n, 0n), allocItem(1, 2, 5n, 5n)];
  allocateBurns(a, 70n, 0n);
  allocateBurns(b, 70n, 0n, undefined, { stages: [{ arrival: [0, 1], leftover: [0, 1] }, { arrival: [], leftover: [] }] });
  assert.deepStrictEqual(a.map((x) => [x.senior, x.basePaid, x.bandPaid]), b.map((x) => [x.senior, x.basePaid, x.bandPaid]));
});

test("D-12 / D-18: the week-so-far senior a new burn of the window claims after excludes the backlog and the operator burns", () => {
  const w = world("d18-operator-exception");
  const st = windowStateV3(clone(w.epochs[0].inputs), null, { limit: false });
  const window = st.works.filter((x) => !x.backlog && !x.operator).reduce((s, x) => s + x.senior, 0n);
  assert.strictEqual(st.seniorAhead, window);
  assert(st.alloc.senior > st.seniorAhead, "the operator's arrival claim is in the total, not ahead of a new burn");
  const d12 = world("d12-backlog");
  const s3 = windowStateV3(clone(d12.epochs[2].inputs), d12.epochs[1].file, { limit: false });
  assert.strictEqual(s3.seniorAhead, BigInt(d12.epochs[2].file.burns[0].senior) + BigInt(d12.epochs[2].file.burns[1].senior));
});

test("X-010: countersErrorV3 (shared by the reader and the engine)", () => {
  const b = (id: string, wei = "5") => ({ missionId: id, amountWei: wei });
  assert.strictEqual(countersErrorV3([b("3"), b("2")], 3n, 10n, 1n, 0n), null);
  assert.match(String(countersErrorV3([b("2"), b("4")], 4n, null, null, null)), /do not run contiguously/);
  assert.match(String(countersErrorV3([b("2")], 3n, null, null, null)), /the last mission id read is 2, but the portal counts 3/);
  assert.match(String(countersErrorV3([b("3")], 3n, null, 1n, null)), /not the previous record's missionsAt \+ 1 \(2\)/);
  assert.match(String(countersErrorV3([], 2n, null, 1n, null)), /no MissionStarted read, but the portal counts 2/);
  assert.strictEqual(countersErrorV3([], 1n, 7n, 1n, 7n), null);
  assert.match(String(countersErrorV3([b("1", "9")], 1n, 8n, null, null)), /below the 9 wei read/);
  assert.match(String(countersErrorV3([b("2", "9")], 2n, 17n, 1n, 9n)), /not the previous record's 9 \+ the 9 wei read/);
  assert.match(String(countersErrorV3([b("x")], 1n, null, null, null)), /not a canonical integer/);
  assert.strictEqual(countersErrorV3([b("x")], null, null, null, null), null, "nothing recorded, nothing checked (the week-so-far feed)");
  const f = world("x010-counters-t134-supply").epochs[1].file;
  assert.deepStrictEqual(countersMissingV3(f), []);
  assert.deepStrictEqual(countersMissingV3({ chains: [{ chainId: 10, skipped: false, missionsAt: "1", burnedAt: null }, { chainId: 56, skipped: true }] }), ["chain 10 records no portal counters (missionsAt / burnedAt, X-010)"]);
});

test("CF-22: publishAgeError refuses a publication more than MAX_PUBLISH_LAG after the build, and an unknown clock", () => {
  const f = { epoch: 9, window: { endTs: 2_000_000_000 } };
  assert.strictEqual(MAX_PUBLISH_LAG, 6 * 3_600);
  assert.strictEqual(publishAgeError(f, f.window.endTs), null);
  assert.strictEqual(publishAgeError(f, f.window.endTs + MAX_PUBLISH_LAG), null, "6 h exactly is still in time");
  assert.match(String(publishAgeError(f, f.window.endTs + MAX_PUBLISH_LAG + 1)), /more than MAX_PUBLISH_LAG 21600 s, so it is never published/);
  assert.strictEqual(publishAgeError(f, f.window.endTs - CLOCK_SKEW_MAX), null);
  assert.match(String(publishAgeError(f, f.window.endTs - CLOCK_SKEW_MAX - 1)), /before the build's snapshot/);
  for (const v of [null, undefined, NaN, 1.5, -1, "2000000000"]) assert.match(String(publishAgeError(f, v as never)), /could not be read.*fail closed/);
  assert.match(String(publishAgeError({ epoch: 9 }, 1)), /no window end/);
});

test("rules-v3.ts: the registry is append-only, versioned, and says which block an epoch carries", () => {
  assert.strictEqual(rulesRegistryErrorV3(), null);
  assert.strictEqual(RULES_V3_VERSIONS.length, 1, "rules 1 only today");
  assert.deepStrictEqual(rulesForEpochV3(17, null), rulesBlockOf(DEFAULT_RULES_V3));
  assert.strictEqual(rulesForEpochV3(17, "ab".repeat(32)).programHash, "ab".repeat(32), "the pinned binary's hash");
  assert.strictEqual(RULES_V3_VERSIONS[0].rules.operatorWallets.wallets.length, 0, "no operator wallet is listed until the operator publishes one");
  const v2: RulesVersionV3 = { fromEpoch: 20, announced: "2027-02-01", rules: { ...RULES_V3_VERSIONS[0].rules, rulesId: 2, operatorWallets: { rule: "rank-last", wallets: [wallet(9)], exceptions: [] } } };
  const reg = [...RULES_V3_VERSIONS, v2];
  assert.strictEqual(rulesRegistryErrorV3(reg), null);
  assert.strictEqual(rulesForEpochV3(19, null, reg).rulesId, 1);
  assert.strictEqual(rulesForEpochV3(20, null, reg).rulesId, 2);
  assert.match(String(rulesRegistryErrorV3([...RULES_V3_VERSIONS, { ...v2, rules: { ...v2.rules, rulesId: 3 } }])), /has rulesId 3/);
  assert.match(String(rulesRegistryErrorV3([...RULES_V3_VERSIONS, { ...v2, announced: null }])), /YYYY-MM-DD/);
  assert.match(String(rulesRegistryErrorV3([{ ...RULES_V3_VERSIONS[0], fromEpoch: 3 }])), /from the first v3 epoch/);
  assert.match(String(rulesRegistryErrorV3([...RULES_V3_VERSIONS, v2, { ...v2, rules: { ...v2.rules, rulesId: 3 } }])), /not after the previous version's/);
  // a file carries exactly the version in force for its epoch
  const f = world("x010-counters-t134-supply").epochs[1].file;
  assert.strictEqual(rulesInForceErrorV3(f, null), null);
  assert.strictEqual(rulesInForceErrorV3(f, null, reg), null, "epoch 2 is before version 2's first epoch");
  assert.match(String(rulesInForceErrorV3({ ...f, epoch: 20 }, null, reg)), /records rules 1, not the rules version in force for it \(2\)/);
  assert.match(String(rulesInForceErrorV3(world("d18-operator-exception").epochs[0].file, null)), /not the rules version in force/, "a block that is not a published version");
  assert.match(String(rulesInForceErrorV3({ epoch: 3 }, null)), /has no rules block/);
});

console.log(`rules v3 tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
