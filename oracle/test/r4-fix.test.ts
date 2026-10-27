/**
 * r4-fix (no network): regression tests for the round-4 review's findings fixed in the oracle.
 *   - finding 3: the heartbeat void bond (seat.rs void_required, SEAT_BOND_MIN) and its priority rule (book_void), and the
 *     health row "our epochs voided";
 *   - finding 4: the anomaly gate releases a rebuild only when it trips nothing the hold has not seen (one re-hold, then an
 *     operator decides);
 *   - finding 12: a heartbeat is never held, GATE_BLOCK included; the health row "anomaly gate block";
 *   - finding 2 (C-14): the weekly epoch row after the v2 boundary on the v2 binary (the gate itself: flow.test.ts R-3);
 *   - finding 14: a malformed key never echoes its bytes (x1.ts loadKeypair, scripts/upgrade/lib.mjs loadKeyFile).
 *   npm test
 */
import assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { SEAT_BOND_MIN, VOID_BOND_MIN, voidBondV3, voidRequiredV3, voidTakesPriorityV3 } from "../src/seat-v3";
import { epochVerdict, gateBlockVerdict, ourVoidedVerdict, VoidedView, VOIDED_LOOKBACK_S } from "../src/health-rules";
import { gateDecisionV3, GateRecordV3, V2_BOUNDARY_TS_DEFAULT } from "../src/flow-v3";
import { GATE_HOLD_SECONDS, GateReasonV3 } from "../src/rewards";
import { KEY_FORMAT_ERROR, loadKeypair } from "../src/x1";

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

const XNT = 1_000_000_000n;
const DAY = 86_400;
const NOW = 1_800_000_000;

// ── finding 3: the heartbeat void bond ─────────────────────────────────────────────────────────────────────────────
test("finding 3: a non-cold void of an epoch with nothing to protect costs SEAT_BOND_MIN; the cold key voids free; paying epochs as before", () => {
  assert.strictEqual(SEAT_BOND_MIN, XNT);
  assert.strictEqual(voidRequiredV3(false, 0n), SEAT_BOND_MIN, "a heartbeat (full budget 0)");
  assert.strictEqual(voidRequiredV3(true, 0n), 0n, "the cold key, free");
  assert.strictEqual(voidRequiredV3(false, 1n), VOID_BOND_MIN, "one lamport of budget: the 0.05-XNT minimum, as before");
  assert.strictEqual(voidRequiredV3(false, 100n * XNT), 10n * XNT);
  assert.strictEqual(voidBondV3(0n), VOID_BOND_MIN, "utils.rs void_bond itself is unchanged");
  // book_void: no priority from a heartbeat void, whatever the bond; a paying epoch's larger bond takes it
  assert.strictEqual(voidTakesPriorityV3(false, 0n, 0, 9n * XNT, 0n), false);
  assert.strictEqual(voidTakesPriorityV3(false, 10n * XNT, 0, XNT, 0n), true);
  assert.strictEqual(voidTakesPriorityV3(true, 10n * XNT, 0, XNT, 0n), false, "never the cold key");
  assert.strictEqual(voidTakesPriorityV3(false, 10n * XNT, NOW, 2n * XNT, 0n), false, "never on an open seat");
  assert.strictEqual(voidTakesPriorityV3(false, 10n * XNT, 0, XNT, XNT), false, "only a larger bond");
});

test("finding 3: health row 'our epochs voided': red for ours voided by a stranger (voider and bond), amber by the cold key, green otherwise", () => {
  const v = (o: Partial<VoidedView> = {}): VoidedView => ({ kind: "base", id: 7, publishedAt: NOW - 3 * DAY, ours: true, voider: "Squatter1111111111111111111111111111111111", bond: XNT, byCold: false, ...o });
  assert(ourVoidedVerdict("legacy", [v()], NOW).detail.startsWith("n/a until upgrade"));
  assert.strictEqual(ourVoidedVerdict("upgraded", [], NOW).state, "ok");
  const red = ourVoidedVerdict("upgraded", [v(), v({ kind: "extra" })], NOW);
  assert.strictEqual(red.state, "fail");
  assert(/epoch 7 .* was VOIDED by Squatter1+ with a bond of 1\.0000 XNT/.test(red.detail), red.detail);
  assert(/extra epoch 7/.test(red.detail) && /does not keep the oracle seat alive/.test(red.detail), red.detail);
  const cold = ourVoidedVerdict("upgraded", [v({ byCold: true })], NOW);
  assert.strictEqual(cold.state, "warn");
  assert(/the seat's cold key/.test(cold.detail), cold.detail);
  assert.strictEqual(ourVoidedVerdict("upgraded", [v({ voider: null, bond: null, byCold: null })], NOW).state, "fail", "voider unknown: still red");
  const foreign = ourVoidedVerdict("upgraded", [v({ ours: false })], NOW);
  assert.strictEqual(foreign.state, "ok", "a foreign publication voided is the defence working");
  assert(/none of them the repository's/.test(foreign.detail));
  assert.strictEqual(ourVoidedVerdict("upgraded", [v({ publishedAt: NOW - VOIDED_LOOKBACK_S - 1 })], NOW).state, "ok", "older than the lookback");
});

// ── findings 4 and 12: the anomaly gate ────────────────────────────────────────────────────────────────────────────
const R = (code: GateReasonV3["code"], text: string = code): GateReasonV3 => ({ code, text });
const held = (reasons: GateReasonV3[], o: Partial<GateRecordV3> = {}): GateRecordV3 => ({ kind: "anomaly-gate", epoch: 9, heldAt: NOW - GATE_HOLD_SECONDS - 10, until: NOW - 10, reasons, dataHash: "aa", ...o });

test("finding 4: after a hold runs out, a rebuild is released only when every reason code was already in the hold", () => {
  const rec = held([R("fallback-share", "6 of 10 burns at a fallback")]);
  // the same kind of reason (its numbers may differ: a fresh rebuild): released by the timer
  const same = gateDecisionV3([R("fallback-share", "7 of 10 burns at a fallback")], rec, NOW, false, 9, "bb");
  assert.strictEqual(same.action, "release");
  assert.strictEqual(same.record!.released!.by, "timer");
  // a NEW kind at the predictable second build: held once more (24 h), with the union of the reasons
  const fresh = gateDecisionV3([R("fallback-share"), R("xnt-source", "the USDC.X guard reads a depeg")], rec, NOW, false, 9, "bb");
  assert.strictEqual(fresh.action, "hold");
  assert.strictEqual(fresh.record!.rehold, 1);
  assert.strictEqual(fresh.record!.until, NOW + GATE_HOLD_SECONDS);
  assert.deepStrictEqual(fresh.record!.reasons.map((r) => r.code), ["fallback-share", "xnt-source"]);
  assert.strictEqual(fresh.record!.released, undefined);
  assert(/new kind of reason \(xnt-source\)/.test(fresh.reason), fresh.reason);
  // while that second hold runs: wait
  assert.strictEqual(gateDecisionV3([R("xnt-source")], fresh.record, NOW + 60, false, 9, "cc").action, "wait");
  // after it: only seen kinds → released; another new kind → blocked for an operator
  const after = NOW + GATE_HOLD_SECONDS + 1;
  assert.strictEqual(gateDecisionV3([R("xnt-source"), R("fallback-share")], fresh.record, after, false, 9, "cc").action, "release");
  const blocked = gateDecisionV3([R("score-jump")], fresh.record, after, false, 9, "cc");
  assert.strictEqual(blocked.action, "blocked");
  assert(/an operator decides/.test(blocked.reason) && /gate\/epoch-9\.json/.test(blocked.reason), blocked.reason);
  // the operator accepts the new kind by adding it to the record: the next rebuild is released
  const accepted = { ...fresh.record!, reasons: [...fresh.record!.reasons, R("score-jump")] };
  assert.strictEqual(gateDecisionV3([R("score-jump")], accepted, after, false, 9, "cc").action, "release");
  // unchanged: no reason with a record → publish (clear); GATE_BLOCK after the hold → blocked; no clock → wait
  assert.strictEqual(gateDecisionV3([], rec, NOW, false, 9, "bb").record!.released!.by, "clear");
  assert.strictEqual(gateDecisionV3([R("fallback-share")], rec, NOW, true, 9, "bb").action, "blocked");
  assert.strictEqual(gateDecisionV3([R("fallback-share")], rec, null, false, 9, "bb").action, "wait");
  assert.strictEqual(gateDecisionV3([R("leaf-count")], null, NOW, false, 9, "bb").action, "hold");
});

test("finding 12: a heartbeat is never held or blocked by the anomaly gate (GATE_BLOCK included); a record of its epoch is released 'heartbeat'", () => {
  const reasons = [R("xnt-source", "the XNT price source changed")];
  const a = gateDecisionV3(reasons, null, NOW, false, 9, "hb", true);
  assert.deepStrictEqual([a.action, a.record], ["publish", null]);
  assert(/never holds it/.test(a.reason) && /xnt-source/.test(a.reason), a.reason);
  const b = gateDecisionV3(reasons, null, NOW, true, 9, "hb", true);
  assert.strictEqual(b.action, "publish", "GATE_BLOCK set: still published");
  const c = gateDecisionV3(reasons, held(reasons, { until: NOW + 999 }), NOW, true, 9, "hb", true);
  assert.strictEqual(c.action, "publish", "inside a running hold: still published");
  assert.strictEqual(c.record!.released!.by, "heartbeat");
  assert.strictEqual(gateDecisionV3(reasons, null, null, true, 9, "hb", true).action, "publish", "no clock: a heartbeat pays nothing");
  // health: amber while GATE_BLOCK is set
  assert.strictEqual(gateBlockVerdict("true").state, "warn");
  assert(/heartbeats still publish/.test(gateBlockVerdict("true").detail));
  for (const v of [undefined, "", "false", "TRUE"]) assert.strictEqual(gateBlockVerdict(v).state, "ok", String(v));
});

// ── finding 2 (C-14): the weekly epoch row past the v2 boundary ───────────────────────────────────────────────────
test("finding 2: past the v2 boundary on the v2 binary the overdue weekly epoch warns 'v2 closed at the boundary' (never red); before it, as before", () => {
  const after = V2_BOUNDARY_TS_DEFAULT + 9 * DAY + 3 * 3_600; // Wednesday 09:00 UTC: the slot of Sunday 2026-11-15 is 57 h old (overdue)
  const lastTs = V2_BOUNDARY_TS_DEFAULT - DAY;
  const closed = epochVerdict(5, lastTs, after, 3, "BSC", null, false, true);
  assert.strictEqual(closed.state, "warn");
  assert(/^v2 closed at the boundary: later burns wait for the first v3 epoch with their own time/.test(closed.detail), closed.detail);
  assert(/3 burn\(s\) waiting on BSC/.test(closed.detail), closed.detail);
  assert.strictEqual(epochVerdict(5, lastTs, after, 3, "BSC", null, false, false).state, "fail", "not closed: the late epoch is red, as on main");
  assert.strictEqual(epochVerdict(5, lastTs, after, 3, "BSC", null, true, true).state, "fail", "the upgraded program is not closed by C-14");
});

// ── finding 14: a malformed key never echoes its bytes ─────────────────────────────────────────────────────────────
test("finding 14: x1.ts loadKeypair throws one fixed text for any malformed key, never the parser's message", () => {
  const marker = "[17,203,99,MARKER";
  for (const bad of [marker, `${marker}]`, "[1,2,3]", "not-base58-0OIl", "[" + "7,".repeat(63) + "x]"]) {
    let msg = "";
    try {
      loadKeypair(bad);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert.strictEqual(msg, KEY_FORMAT_ERROR, bad.slice(0, 12));
    assert(!/MARKER|17,203|0OIl/.test(msg));
  }
  const kp = Keypair.generate();
  assert(loadKeypair(JSON.stringify(Array.from(kp.secretKey))).publicKey.equals(kp.publicKey));
  assert(loadKeypair(bs58.encode(kp.secretKey)).publicKey.equals(kp.publicKey));
  assert.throws(() => loadKeypair("0xabc"), /EVM key/);
});

test("finding 14: scripts/upgrade/lib.mjs loadKeyFile refuses a malformed key file without quoting it", () => {
  const lib = path.resolve(__dirname, "..", "..", "scripts", "upgrade", "lib.mjs");
  if (!fs.existsSync(lib)) return console.log("  (scripts/upgrade/lib.mjs absent: skipped)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r4fix-"));
  try {
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "[17,203,99,MARKERSEED");
    const script = `import { loadKeyFile } from ${JSON.stringify("file:///" + lib.replace(/\\/g, "/"))};\ntry { loadKeyFile(${JSON.stringify(file)}, "--keeper-key"); console.log("LOADED"); } catch (e) { console.log("REFUSED " + e.message); }`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert(/^REFUSED --keeper-key: the key file is not a 64-byte JSON array/.test(out.trim()), out);
    assert(!/MARKER|17,203/.test(out), out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── done ───────────────────────────────────────────────────────────────────────────────────────────────────────────
Promise.all(pending).then(() => {
  console.log(`r4-fix: ${passed} tests passed${failed ? `, ${failed} FAILED` : ""}`);
  if (failed) process.exit(1);
});
