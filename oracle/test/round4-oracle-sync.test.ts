/**
 * Round 4 oracle sync (no network): the quiet-month heartbeat base epoch (the program's forge.rs epoch_shape), the oracle
 * seat client's pure rules (void_epoch / void_extra_epoch / take_seat, seat.rs mirrors), the foreign-publisher health
 * rule and the keeper's anchoring urgency under the bond-paid stalls (keeper.rs, review F1).
 *   npm test
 */
import assert from "assert";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { PDA } from "../src/x1";
import { PDA_V3, programV3, publishEpochTxV3 } from "../src/x1-v3";
import {
  AnyEpochFile, BurnInputV3, buildEpochFileV3, computeEpochV3, dataHashV3, EpochFileV3, EpochInputsV3, HEARTBEAT_ROOT, isHeartbeatV3, publishableError, rebuildReason,
  verifyAny, verifyChainLinkV3, verifyEpochV3, verifyPublishedV3,
} from "../src/rewards";
import { assembleInputsV3, buildExtraAfterBaseV3, buildV3, extraCreatedAtV3, extraPoolV3, fixtureSources, heartbeatAllowedV3, RecordedSourcesV3, verifyPriceSidecarV3 } from "../src/flow-v3";
import * as fs from "fs";
import * as path from "path";
import { CHAINS } from "../src/config";
import { EpochFile } from "../src/epoch";
import { verifyExtraFile } from "../src/extra";
import { heartbeatText, xLength } from "../src/announce";
import {
  extraVoidFullBudgetV3, isColdV3, seatBondV3, seatWalkV3, takeDelayV3, takeKeysErrorV3, takeSeatIxV3, VOID_BOND_MIN, voidBondV3, voidDecisionV3, voidGateErrorV3, voidIxV3,
  voidRequiredV3,
} from "../src/seat-v3";
import { anchorDueOf, betPack, oracleSeatLivenessV3, PairViewV3 } from "../src/keeper-v3";
import { epochVerdict, oraclePublicationsVerdict, publicationClassOf, PublicationView } from "../src/health-rules";

let passed = 0;
let failed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  const done = (e?: unknown) => {
    if (e === undefined) passed++;
    else {
      failed++;
      console.error(`FAIL ${name}\n  ${(e as Error).stack ?? String(e)}`);
    }
  };
  try {
    const r = fn();
    if (r && typeof (r as Promise<void>).then === "function") pending.push((r as Promise<void>).then(() => done(), (e) => done(e ?? new Error("rejected"))));
    else done();
  } catch (e) {
    done(e);
  }
}

// ── fixtures (the rewards.test.ts conventions) ─────────────────────────────────────────────────
const PROGRAM = "57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9";
const XNT = 1_000_000_000n;
const DAY = 86_400;
const HOUR = 3_600;
const WEEK = 7 * DAY;
const T0 = 1_790_208_000;
const XEN = 10n ** 18n;
const P6 = 10n ** 12n;
const X1 = 10n ** 18n;
const BIG_L = 10n ** 30n;
const F10K = 10_000n * XNT;
const key = (tag: number, i: number) => {
  const b = new Uint8Array(32);
  b[0] = tag;
  b[1] = i & 255;
  b[31] = 9;
  return new PublicKey(b).toBase58();
};
const W = (i: number) => key(1, i);
const blockAt = (ts: number) => ts - T0 + 1_000;
const iso = (ts: number) => new Date(ts * 1000).toISOString();
const publishedAt = (f: AnyEpochFile) => Math.floor(Date.parse(f.createdAt) / 1000) + 60;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
let seq = 0;
function burn(x1: string, ts: number, xen: bigint, chainId = 10): BurnInputV3 {
  seq++;
  return {
    chainId, txHash: "0x" + seq.toString(16).padStart(64, "0"), logIndex: seq, blockNumber: blockAt(ts), missionId: String(seq), pilot: "0x" + "ab".repeat(20),
    amountWei: (xen * XEN).toString(), tier: 0, x1, timestamp: ts, medianE18: P6.toString(), lastCloseE18: P6.toString(), priceSource: "candles",
    xntMedianE18: X1.toString(), xntLastCloseE18: X1.toString(), xntSource: "candles",
  };
}
function mk(b: { epoch: number; endTs: number; F: bigint; burns: BurnInputV3[]; chains?: number[] }, prev: AnyEpochFile | null): EpochInputsV3 {
  const ids = new Set<number>([...b.burns.map((x) => x.chainId), ...(b.chains ?? [])]);
  if (prev) for (const c of prev.chains) ids.add(c.chainId);
  const chains = [...ids].map((id) => {
    const pc = prev?.chains.find((c) => c.chainId === id);
    const from = pc ? pc.toBlock : 0;
    return {
      chainId: id, name: `chain-${id}`, portal: "0xportal", fromBlockExclusive: from, toBlock: blockAt(b.endTs),
      market: { spotE18: P6.toString(), refUsdE18: P6.toString(), priceSource: "test", pools: [] }, liquidityNowMicro: BIG_L.toString(), totalSupply: "0",
      burns: b.burns.filter((x) => x.chainId === id && x.blockNumber > from && x.blockNumber <= blockAt(b.endTs)),
    };
  });
  return {
    programId: PROGRAM, epoch: b.epoch, createdAt: iso(b.endTs),
    window: { startTs: prev ? publishedAt(prev) : b.endTs - WEEK, endTs: b.endTs },
    chains, snapshot: { slot: 100 + b.epoch, records: [] },
    freePool: { lamports: b.F.toString(), slot: 99 + b.epoch, open: prev ? b.F.toString() : null },
    xnt: { twapE18: X1.toString(), apiE18: X1.toString(), source: "test" }, switchRefs: null,
  };
}
const asFile = (f: EpochFileV3 | null): EpochFileV3 => {
  assert(f, "unexpectedly empty");
  return JSON.parse(JSON.stringify(f));
};

// a paying epoch 1, a quiet week 2, a paying epoch 3 on top of the heartbeat
const e1 = asFile(buildEpochFileV3(mk({ epoch: 1, endTs: T0 + WEEK, F: F10K, burns: [burn(W(1), T0 + DAY, 1_000_000n), burn(W(2), T0 + 2 * DAY, 500_000n, 56)] }, null), null));
const in2 = mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, burns: [] }, e1);
const hb = asFile(buildEpochFileV3(in2, e1, { heartbeat: true }));
const e3 = asFile(buildEpochFileV3(mk({ epoch: 3, endTs: T0 + 3 * WEEK, F: F10K, burns: [burn(W(3), T0 + 2 * WEEK + DAY, 2_000_000n)] }, hb), hb));

// ── 1. the heartbeat base epoch ─────────────────────────────────────────────────────────────────
test("heartbeat: off by default (a window without a valued burn is still null), on request the program's shape", () => {
  assert.strictEqual(computeEpochV3(in2, e1), null, "the default stays null: nothing is published unless the run asks");
  assert.strictEqual(buildEpochFileV3(in2, e1), null);
  assert.strictEqual(hb.heartbeat, true);
  assert.strictEqual(isHeartbeatV3(hb), true);
  assert.strictEqual(isHeartbeatV3(e1), false);
  // forge.rs epoch_shape: total 0, no leaf, rate cap 0, the all-zero root (else EmptyEpoch)
  assert.strictEqual(hb.totalScore, "0");
  assert.strictEqual(hb.leaves.length, 0);
  assert.strictEqual(hb.targets.length, 0);
  assert.strictEqual(hb.burns.length, 0);
  assert.strictEqual(hb.rateCap, "0");
  assert.strictEqual(hb.root, HEARTBEAT_ROOT);
  assert.strictEqual(HEARTBEAT_ROOT, "00".repeat(32));
  assert.deepStrictEqual(hb.proofs, {});
  assert.strictEqual(hb.dataHash, dataHashV3(hb), "the heartbeat member is hashed with the file");
  assert.strictEqual(hb.prevDataHash, e1.dataHash);
});

test("heartbeat: every chain's cursor, L and curve move on exactly as a paying build would record them", () => {
  for (const c of hb.chains) {
    const p = e1.chains.find((x) => x.chainId === c.chainId)!;
    assert.strictEqual(c.fromBlockExclusive, p.toBlock, `chain ${c.chainId} continues the previous cursor`);
    assert.strictEqual(c.toBlock, blockAt(T0 + 2 * WEEK), `chain ${c.chainId} read up to the window end`);
    assert.strictEqual(c.skipped, false);
    assert.deepStrictEqual(c.curveBefore, p.curveAfter, `chain ${c.chainId}: the curve memory is carried`);
  }
  assert.strictEqual(hb.capacity.base, "0");
  assert.strictEqual(hb.capacity.senior, "0");
  assert.strictEqual(hb.window.startTs, publishedAt(e1));
});

test("heartbeat: verifies (verifyEpochV3 / verifyAny), and the next paying epoch builds and verifies on top of it", () => {
  assert.deepStrictEqual(verifyEpochV3(hb, e1), []);
  assert.deepStrictEqual(verifyAny(hb, e1), []);
  assert.deepStrictEqual(verifyEpochV3(e3, hb), []);
  assert.strictEqual(e3.prevDataHash, hb.dataHash);
  assert.strictEqual(e3.window.startTs, publishedAt(hb), "the next window starts at the heartbeat's publication");
  assert(BigInt(e3.totalScore) > 0n && e3.heartbeat === undefined);
  for (const c of e3.chains) assert.strictEqual(c.fromBlockExclusive, hb.chains.find((x) => x.chainId === c.chainId)!.toBlock);
  // F2 chain link: the heartbeat's budget is 0, so F_ref of the next window is the heartbeat's free_pool_before
  assert.deepStrictEqual(verifyChainLinkV3(e3, { publishedAt: publishedAt(hb), budget: 0n, freePoolBefore: F10K }), []);
});

test("heartbeat: a paying window is byte-identical with and without the option (no heartbeat member, same hash)", () => {
  const inputs = mk({ epoch: 3, endTs: T0 + 3 * WEEK, F: F10K, burns: [burn(W(4), T0 + 2 * WEEK + 2 * DAY, 3_000_000n)] }, hb);
  const a = asFile(buildEpochFileV3(inputs, hb));
  const b = asFile(buildEpochFileV3(inputs, hb, { heartbeat: true }));
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  assert.strictEqual(a.heartbeat, undefined);
  assert.strictEqual(a.rateCap, "1");
  const viaFlow = buildV3(inputs, hb, { heartbeat: true }).file!;
  assert.strictEqual(viaFlow.dataHash, a.dataHash);
});

test("heartbeat: a window with a valued burn that pays nothing (empty pool) is never a heartbeat (the burn waits)", () => {
  const dry = mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: 0n, burns: [burn(W(5), T0 + WEEK + DAY, 1_000_000n)] }, e1);
  assert.strictEqual(computeEpochV3(dry, e1, { heartbeat: true }), null, "a valued burn is never consumed by an epoch that pays nothing");
  assert.strictEqual(buildV3(dry, e1, { heartbeat: true }).file, null);
  // the empty pool alone does not stop a heartbeat: nothing is reserved (forge.rs epoch_budget)
  const hb0 = asFile(buildEpochFileV3(mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: 0n, burns: [] }, e1), e1, { heartbeat: true }));
  assert.deepStrictEqual(verifyEpochV3(hb0, e1), []);
  assert.strictEqual(rebuildReason(hb0, 0n), null, "the publish gate lets a heartbeat out of an empty pool");
});

test("heartbeat: a chain skipped for an unpriced burn keeps its cursor (its burns are read again next epoch)", () => {
  const unpriced = { ...burn(W(6), T0 + WEEK + DAY, 1_000_000n, 56), medianE18: "0", lastCloseE18: "0", priceSource: "fallback" };
  const inputs = mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, burns: [unpriced] }, e1);
  const built = buildV3({ ...inputs, chains: inputs.chains.map((c) => (c.chainId === 56 ? { ...c, market: { ...c.market, spotE18: "0", refUsdE18: "0" } } : c)) }, e1, { heartbeat: true });
  if (built.file) {
    assert.strictEqual(built.file.heartbeat, true);
    const c56 = built.file.chains.find((c) => c.chainId === 56)!;
    assert.strictEqual(c56.skipped, true, "the unpriced chain is skipped");
    assert.strictEqual(c56.toBlock, e1.chains.find((c) => c.chainId === 56)!.toBlock, "its cursor stays: the burn is not consumed");
    assert.deepStrictEqual(built.unpriced, [56]);
  } else assert.fail("a window whose only burn is unpriced still keeps the seat alive with a heartbeat");
});

test("heartbeat: tampering is refused (rate cap, root, member, a dropped burn)", () => {
  const rehash = (f: EpochFileV3) => ({ ...f, dataHash: dataHashV3(f) });
  const cap = rehash({ ...clone(hb), rateCap: "1" });
  assert(verifyEpochV3(cap, e1).some((e) => /rateCap/.test(e)));
  const root = rehash({ ...clone(hb), root: "11".repeat(32) });
  assert(verifyEpochV3(root, e1).some((e) => /root/.test(e)));
  const off = clone(hb) as EpochFileV3 & { heartbeat?: unknown };
  delete off.heartbeat;
  assert(verifyEpochV3(rehash(off), e1).some((e) => /empty epoch/.test(e)), "without the member it is an empty epoch nobody should publish");
  const bad = rehash({ ...clone(hb), heartbeat: false as unknown as true });
  assert(verifyEpochV3(bad, e1).some((e) => /heartbeat is true or absent/.test(e)));
  // a paying window published as a heartbeat (its burns kept in the file): the recomputation is a paying body
  const withBurn = asFile(buildEpochFileV3(mk({ epoch: 2, endTs: T0 + 2 * WEEK, F: F10K, burns: [burn(W(7), T0 + WEEK + DAY, 1_000_000n)] }, e1), e1));
  const fake = rehash({ ...clone(withBurn), leaves: [], targets: [], totalScore: "0", root: HEARTBEAT_ROOT, rateCap: "0", heartbeat: true, proofs: {} });
  assert(verifyEpochV3(fake, e1).length > 0, "a heartbeat over a valued burn never verifies");
});

test("heartbeat: the publication check wants rate cap 0, budget 0, no leaf and the zero root", () => {
  const ev = {
    epoch: 2, root: HEARTBEAT_ROOT, dataHash: hb.dataHash, leaves: 0, budget: 0n, dropReserve: 0n, totalScore: 0n, freePoolBefore: F10K,
    rateCap: 0n, netBudget: 0n, publishedAt: hb.window.endTs + 60,
  };
  assert.deepStrictEqual(verifyPublishedV3(hb, ev), []);
  assert(verifyPublishedV3(hb, { ...ev, rateCap: 1n }).some((e) => /rate cap is not 0/.test(e)));
  assert(verifyPublishedV3(e1, { ...ev, epoch: 1, root: e1.root, dataHash: e1.dataHash, leaves: e1.leaves.length, totalScore: BigInt(e1.totalScore), budget: BigInt(e1.totalScore), netBudget: BigInt(e1.totalScore), rateCap: 0n, publishedAt: e1.window.endTs + 60 }).some((e) => /rate cap is not 1/.test(e)), "a paying epoch still wants 1");
  assert.strictEqual(publishableError(hb), null);
});

test("heartbeat: allowed only on the upgraded binary, for a publishable window, never for a provisional preview", () => {
  assert.strictEqual(heartbeatAllowedV3({ verdict: "upgraded", provisional: null, due: true }).ok, true);
  assert.strictEqual(heartbeatAllowedV3({ verdict: "legacy", provisional: null, due: true }).ok, false, "never on the live v2 binary");
  assert.strictEqual(heartbeatAllowedV3({ verdict: "unknown", provisional: null, due: true }).ok, false, "an unknown verdict fails closed");
  assert.strictEqual(heartbeatAllowedV3({ verdict: "upgraded", provisional: "short", due: true }).ok, false);
  assert.strictEqual(heartbeatAllowedV3({ verdict: "upgraded", provisional: null, due: false }).ok, false);
});

test("heartbeat: the extra epoch of the same id builds on it (budget 0: nobody's use to count)", () => {
  const read = (b: EpochFileV3) => ({ slot: b.snapshot.slot, blockTime: b.window.endTs, records: [] });
  const x1 = buildExtraAfterBaseV3(e1, null, read(e1), {}, extraPoolV3(e1, "0"), extraCreatedAtV3(e1));
  assert.deepStrictEqual(verifyExtraFile(x1, e1, null), []);
  const x2 = buildExtraAfterBaseV3(hb, x1, read(hb), {}, extraPoolV3(hb, "0"), extraCreatedAtV3(hb));
  assert.deepStrictEqual(verifyExtraFile(x2, hb, x1), []);
  assert.strictEqual(x2.epoch, 2);
  assert.strictEqual(x2.totals.budget, "0");
});

test("heartbeat: the announcement says what happened, nothing more (no entry, budget 0, fits a post)", () => {
  const t = heartbeatText(hb);
  assert(/heartbeat/.test(t) && /budget 0 XNT/.test(t) && /nothing paid/.test(t), t);
  assert(xLength(t) <= 280, `${xLength(t)} characters`);
  assert(!/yield|profit|return|earn|invest/i.test(t), "no investment wording");
});

// ── 2. the oracle seat client (seat.rs mirrors) ────────────────────────────────────────────────────
const NOW = T0 + 10 * WEEK;
const pv = (o: Partial<PublicationView> = {}): PublicationView => ({ kind: "base", id: 9, publishedAt: NOW - 3_600 * 5, closed: false, dataHash: "aa".repeat(32), local: null, bond: VOID_BOND_MIN, ...o });

test("seat client: bonds mirror utils.rs (void 10% of the full budget, min 0.05 XNT; seat 10% of the free pool, min 1 XNT)", () => {
  assert.strictEqual(voidBondV3(0n), 50_000_000n);
  assert.strictEqual(voidBondV3(400_000_000n), 50_000_000n);
  assert.strictEqual(voidBondV3(100n * XNT), 10n * XNT);
  assert.strictEqual(voidRequiredV3(true, 100n * XNT), 0n, "the cold key voids for free");
  assert.strictEqual(extraVoidFullBudgetV3(5n, 7n, 3n), 10n, "S-1: max(extra budget, base budget + drop reserve)");
  assert.strictEqual(seatBondV3(0n), XNT);
  assert.strictEqual(seatBondV3(5n * XNT), XNT);
  assert.strictEqual(seatBondV3(100n * XNT), 10n * XNT);
  const def = PublicKey.default.toBase58();
  assert.strictEqual(isColdV3(def, def), false, "the default key is never the cold key");
  assert.strictEqual(isColdV3(W(1), W(1)), true);
  assert.strictEqual(takeDelayV3(W(1), W(1)), 28 * DAY);
  assert.strictEqual(takeDelayV3(W(1), W(2)), 29 * DAY);
  assert.strictEqual(takeDelayV3(def, def), 29 * DAY, "no priority taker: everyone waits 28 d + 24 h");
});

test("seat client: void gate and take keys mirror seat.rs (HoldOver, EpochClosed, InvalidTarget)", () => {
  assert.strictEqual(voidGateErrorV3({ closed: false, publishedAt: NOW - DAY }, NOW), null);
  assert(/HoldOver/.test(voidGateErrorV3({ closed: false, publishedAt: NOW - 2 * DAY }, NOW)!), "exactly 48 h after: over");
  assert(/EpochClosed/.test(voidGateErrorV3({ closed: true, publishedAt: NOW - DAY }, NOW)!));
  const ok = { hot: W(1), cold: W(2), refund: W(3), architect: W(4), seat: W(5) };
  assert.strictEqual(takeKeysErrorV3(ok), null);
  assert(takeKeysErrorV3({ ...ok, hot: PublicKey.default.toBase58() }));
  assert(takeKeysErrorV3({ ...ok, cold: W(1) }));
  assert(takeKeysErrorV3({ ...ok, hot: W(4) }), "never the architect payee");
  assert(takeKeysErrorV3({ ...ok, refund: W(5) }), "never the seat PDA");
});

test("seat client: the walk mirrors walk_is_dead and lists exactly the pairs the program reads", () => {
  const pairs = new Map<number, PairViewV3>([
    [5, { id: 5, publishedAt: NOW - 3 * DAY, closed: true, extra: null }],
    [4, { id: 4, publishedAt: NOW - 10 * DAY, closed: false, extra: { publishedAt: NOW - 10 * DAY, closed: false } }],
    [3, { id: 3, publishedAt: NOW - 17 * DAY, closed: false, extra: null }],
  ]);
  const alive = seatWalkV3(NOW - 60 * DAY, 5, (id) => pairs.get(id) ?? null, NOW, 28 * DAY);
  assert.deepStrictEqual(alive, { dead: false, ids: [5, 4], error: null }, "epoch 5 voided, epoch 4 survived: alive, two pairs read");
  // 20 days later the cutoff passed epoch 4: the voided epoch 5 does not count, the walk stops at epoch 4 (dead)
  const later = seatWalkV3(NOW - 60 * DAY, 5, (id) => pairs.get(id) ?? null, NOW + 20 * DAY, 28 * DAY);
  assert.deepStrictEqual(later, { dead: true, ids: [5, 4], error: null });
  // 26 days later even epoch 5 is past the cutoff: the first pair read closes the walk
  assert.deepStrictEqual(seatWalkV3(NOW - 60 * DAY, 5, (id) => pairs.get(id) ?? null, NOW + 26 * DAY, 28 * DAY), { dead: true, ids: [5], error: null });
  assert.deepStrictEqual(seatWalkV3(NOW - DAY, 5, () => null, NOW, 28 * DAY), { dead: false, ids: [], error: null }, "a recent take: alive, no pair read");
  assert(seatWalkV3(NOW - 60 * DAY, 5, () => null, NOW, 28 * DAY).error, "an unreadable pair is never guessed");
  // the oracle's weekly heartbeats keep it alive through a quiet month (each one survives its hold)
  const quiet = new Map<number, PairViewV3>([1, 2, 3, 4, 5].map((k) => [10 + k, { id: 10 + k, publishedAt: NOW - (5 - k) * WEEK - 3 * DAY, closed: false, extra: null }]));
  assert.strictEqual(seatWalkV3(NOW - 90 * DAY, 15, (id) => quiet.get(id) ?? null, NOW, 28 * DAY).dead, false);
  assert.strictEqual(oracleSeatLivenessV3(NOW - 90 * DAY, [...quiet.values()], NOW).state, "ok");
});

test("seat client: a void is sent only for a publication the repository does not hold, inside its hold", () => {
  assert.strictEqual(voidDecisionV3(pv(), NOW, false).ok, true, "no file 5 h after the publication: foreign");
  assert.strictEqual(voidDecisionV3(pv({ local: "aa".repeat(32) }), NOW, false).ok, false, "the repository's own file is never voided by default");
  assert.strictEqual(voidDecisionV3(pv({ local: "aa".repeat(32) }), NOW, true).ok, true, "--even-if-ours");
  assert.strictEqual(voidDecisionV3(pv({ local: "bb".repeat(32) }), NOW, false).ok, true, "another data hash than the repository's");
  assert.strictEqual(voidDecisionV3(pv({ publishedAt: NOW - 600 }), NOW, false).ok, false, "10 min old: the commit may be pending");
  assert.strictEqual(voidDecisionV3(pv({ publishedAt: NOW - 3 * DAY }), NOW, true).ok, false, "after the hold nothing can be voided");
  assert.strictEqual(voidDecisionV3(pv({ closed: true }), NOW, true).ok, false);
});

test("health: oracle publications row (n/a before the upgrade; foreign red with the void command; pending amber)", () => {
  assert.strictEqual(oraclePublicationsVerdict("legacy", [pv()], NOW).detail.startsWith("n/a until upgrade"), true);
  assert.strictEqual(oraclePublicationsVerdict("upgraded", [], NOW).state, "ok");
  const red = oraclePublicationsVerdict("upgraded", [pv({ local: "aa".repeat(32), id: 8 }), pv()], NOW);
  assert.strictEqual(red.state, "fail");
  assert(/FOREIGN/.test(red.detail) && /npm run void-epoch -- 9 --yes/.test(red.detail) && /0\.0500 XNT/.test(red.detail), red.detail);
  const x = oraclePublicationsVerdict("upgraded", [pv({ kind: "extra" })], NOW);
  assert(/void-epoch -- 9 --extra --yes/.test(x.detail));
  assert.strictEqual(oraclePublicationsVerdict("upgraded", [pv({ publishedAt: NOW - 600 })], NOW).state, "warn");
  assert.strictEqual(oraclePublicationsVerdict("upgraded", [pv({ local: "aa".repeat(32) })], NOW).state, "ok");
  assert.strictEqual(oraclePublicationsVerdict("upgraded", [pv({ local: "bb".repeat(32) })], NOW).state, "fail");
  assert.strictEqual(oraclePublicationsVerdict("upgraded", [pv({ publishedAt: NOW - 3 * DAY })], NOW).state, "ok", "out of its hold: only reconciliation reports it");
  assert.strictEqual(publicationClassOf(pv(), NOW).voidBy, pv().publishedAt + 2 * DAY);
});

// ── 3. the transactions, built offline with the upgraded IDL and decoded back ─────────────────────────────────────
const prog = programV3(new anchor.AnchorProvider({} as never, new anchor.Wallet(Keypair.generate()), {}));
const decode = (ix: TransactionInstruction) => (prog.coder.instruction as any).decode(ix.data) as { name: string; data: any };
const idlIx = (name: string) => ((prog.rawIdl as anchor.Idl).instructions ?? []).find((i) => i.name === name)!;

test("heartbeat publication: publish_epoch carries forge.rs epoch_shape's heartbeat (total 0, 0 leaves, rate cap 0, zero root), 108 B, the vault writable", async () => {
  const oracle = Keypair.generate().publicKey;
  const tx = await publishEpochTxV3(prog, oracle, hb);
  const ix = tx.instructions[tx.instructions.length - 1];
  const d = decode(ix);
  assert.strictEqual(d.name, "publishEpoch");
  assert.strictEqual(d.data.epochId.toString(), "2");
  assert.strictEqual(Buffer.from(d.data.root).toString("hex"), HEARTBEAT_ROOT);
  assert.strictEqual(Buffer.from(d.data.dataHash).toString("hex"), hb.dataHash);
  assert.strictEqual(d.data.totalScore.toString(), "0");
  assert.strictEqual(d.data.leaves, 0);
  assert.strictEqual(d.data.rateCap.toString(), "0");
  assert.strictEqual(ix.data.length, 108, "the live binary's 108-byte data");
  assert.strictEqual(ix.keys.length, 5);
  assert(ix.keys.find((k) => k.pubkey.equals(PDA.rewardVault()))!.isWritable, "D-47: the vault writable");
  // a paying file: the same builder, rate cap 1
  const p = decode((await publishEpochTxV3(prog, oracle, e1)).instructions[0]);
  assert.strictEqual(p.data.rateCap.toString(), "1");
  assert.strictEqual(p.data.leaves, e1.leaves.length);
});

test("seat client: void_epoch / void_extra_epoch / take_seat follow the IDL (accounts in order, the waiver and walk pairs as remaining accounts)", async () => {
  const voider = Keypair.generate().publicKey;
  const v = await voidIxV3(prog, { epoch: 7, extra: false, bond: 50_000_000n, voider });
  const dv = decode(v);
  assert.strictEqual(dv.name, "voidEpoch");
  assert.strictEqual(dv.data.epochId.toString(), "7");
  assert.strictEqual(dv.data.bond.toString(), "50000000");
  const want = [PDA.config(), PDA.epoch(7), PDA_V3.oracleSeat(), PDA.rewardVault(), voider, SystemProgram.programId];
  assert.strictEqual(idlIx("void_epoch").accounts.length, want.length);
  want.forEach((k, i) => assert(v.keys[i].pubkey.equals(k), `void_epoch account ${i}`));
  assert(v.keys[4].isSigner && v.keys[4].isWritable, "the voider signs and pays the bond");
  assert(v.keys[6].pubkey.equals(PDA.epoch(6)) && !v.keys[6].isWritable, "Epoch(n − 1) for the S-2 waiver, read-only");
  assert.strictEqual((await voidIxV3(prog, { epoch: 1, extra: false, bond: 0n, voider })).keys.length, 6, "epoch 1 has no predecessor");
  const x = await voidIxV3(prog, { epoch: 7, extra: true, bond: 60_000_000n, voider });
  assert.strictEqual(decode(x).name, "voidExtraEpoch");
  const wantX = [PDA.config(), PDA_V3.extraState(), PDA_V3.extraEpoch(7), PDA.epoch(7), PDA_V3.oracleSeat(), PDA.rewardVault(), voider, SystemProgram.programId];
  assert.strictEqual(x.keys.length, wantX.length);
  wantX.forEach((k, i) => assert(x.keys[i].pubkey.equals(k), `void_extra_epoch account ${i}`));
  const [hot, cold, refund, taker] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  const t = await takeSeatIxV3(prog, { hot, cold, refund, taker, walkIds: [9, 8] });
  const dt = decode(t);
  assert.strictEqual(dt.name, "takeSeat");
  assert(dt.data.newHot.equals(hot) && dt.data.newCold.equals(cold) && dt.data.newRefund.equals(refund));
  const wantT = [PDA.config(), PDA_V3.oracleSeat(), PDA.rewardVault(), taker, SystemProgram.programId, PDA.epoch(9), PDA_V3.extraEpoch(9), PDA.epoch(8), PDA_V3.extraEpoch(8)];
  assert.strictEqual(t.keys.length, wantT.length);
  wantT.forEach((k, i) => assert(t.keys[i].pubkey.equals(k), `take_seat account ${i}`));
  // the longest walk (SEAT_WALK_PAIRS = 11 pairs) still fits one transaction
  const long = await takeSeatIxV3(prog, { hot, cold, refund, taker, walkIds: Array.from({ length: 11 }, (_, i) => 20 - i) });
  const size = new Transaction({ feePayer: taker, recentBlockhash: PublicKey.default.toBase58() }).add(long).serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  assert(size <= 1_232, `take_seat with 11 walk pairs is ${size} B`);
});

test("keeper: an anchor is due for an unanchored keeper bet whose block is in SlotHashes, never for an anchored, legacy, excluded or expired one", () => {
  const sh = (from: bigint, n: number) => {
    const d = Buffer.alloc(8 + n * 40);
    d.writeBigUInt64LE(BigInt(n), 0);
    for (let i = 0; i < n; i++) d.writeBigUInt64LE(from - BigInt(i), 8 + i * 40);
    return d;
  };
  const S = 1_000_000n;
  const hashes = sh(S, 512);
  const bet = (pk: string, game: number, anchorSlot: bigint) => ({ pk, game, targetSlot: betPack(3n, anchorSlot) });
  assert.strictEqual(anchorDueOf([bet("a", 0x80, S - 3n)], hashes), "a");
  assert.strictEqual(anchorDueOf([bet("a", 0x80 | 0x40, S - 3n)], hashes), null, "anchored already");
  assert.strictEqual(anchorDueOf([bet("a", 0x01, S - 3n)], hashes), null, "a legacy bet has no anchor");
  assert.strictEqual(anchorDueOf([bet("a", 0x80, S - 600n)], hashes), null, "its block left SlotHashes: a refund, not an anchor");
  assert.strictEqual(anchorDueOf([bet("a", 0x80, S + 5n)], hashes), null, "its block does not exist yet");
  assert.strictEqual(anchorDueOf([bet("a", 0x80, S - 3n), bet("b", 0x80, S - 4n)], hashes, new Set(["a"])), "b", "a bet anchored earlier in the pass is skipped");
});

test("heartbeat on the recorded switch fixture (real epoch-1.json, every source replayed): a quiet window builds, verifies and keeps its sidecar", async () => {
  const FIX = path.join(__dirname, "fixtures");
  const epoch1: EpochFile = JSON.parse(fs.readFileSync(path.join(FIX, "epoch-1.json"), "utf8"));
  const rec: RecordedSourcesV3 = JSON.parse(fs.readFileSync(path.join(FIX, "flow-v3-epoch2.json"), "utf8")).recording;
  const chains = CHAINS.map((c) => ({ ...c, portal: epoch1.chains.some((x) => x.chainId === c.chainId) ? epoch1.chains[0].portal : "" }));
  const a = await assembleInputsV3(2, epoch1, fixtureSources(rec), chains, [epoch1], () => {});
  // the same week with no burn on any chain (the portal counters then record nothing new: null at the v2 switch)
  const quiet = { ...a.inputs, chains: a.inputs.chains.map((c) => ({ ...c, burns: [], missionsAt: null, burnedAt: null })) };
  assert.strictEqual(buildV3(quiet, epoch1).file, null, "without the option: nothing, as before");
  const f = buildV3(quiet, epoch1, { heartbeat: true }).file!;
  assert(f && f.heartbeat === true && f.v3FirstEpoch === 2 && f.leaves.length === 0);
  assert.deepStrictEqual(verifyAny(f, epoch1), []);
  assert.deepStrictEqual(verifyPriceSidecarV3(f, a.sidecar ?? null), []);
  const byId = (xs: { chainId: number }[], k: (x: any) => number) => xs.map((x) => [x.chainId, k(x)]).sort((p, q) => p[0] - q[0]);
  assert.deepStrictEqual(byId(f.chains, (c) => c.fromBlockExclusive), byId(epoch1.chains, (c) => c.toBlock), "the cursors continue from the real file");
  assert(f.chains.every((c) => !c.skipped && c.toBlock > c.fromBlockExclusive), "every chain read up to its final head");
  // the paying build of the real week is untouched by the option
  assert.strictEqual(buildV3(a.inputs, epoch1, { heartbeat: true }).file!.dataHash, buildV3(a.inputs, epoch1).file!.dataHash);
});

test("health: a quiet overdue slot says the heartbeat is missing on the upgraded program, and keeps the v2 text otherwise", () => {
  const sunday = 1_792_368_000 + 3 * DAY; // a Thursday, days into its weekly slot (Sunday 00:00 UTC): overdue
  const v2 = epochVerdict(4, sunday - 10 * DAY, sunday, 0);
  assert.strictEqual(v2.detail, `quiet week: no burn since epoch 4 (${new Date((sunday - 10 * DAY) * 1000).toISOString().slice(0, 16)}Z), nothing to publish`, "the v2 text, unchanged");
  const v3 = epochVerdict(4, sunday - 10 * DAY, sunday, 0, "", null, true);
  assert.strictEqual(v3.state, "warn");
  assert(/heartbeat epoch 5/.test(v3.detail), v3.detail);
});

test("seat liveness: the warning text now names the heartbeat (a quiet week publishes one)", () => {
  const l = oracleSeatLivenessV3(NOW - 90 * DAY, [{ id: 3, publishedAt: NOW - 20 * DAY, closed: false, extra: null }], NOW);
  assert(/heartbeat/.test(l.detail) && !/publishes nothing/.test(l.detail), l.detail);
});

// ── done ──────────────────────────────────────────────────────────────────────────────────────
Promise.all(pending).then(() => {
  console.log(`round 4 oracle sync: ${passed} tests passed${failed ? `, ${failed} FAILED` : ""}`);
  if (failed) process.exit(1);
});
