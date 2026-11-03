/**
 * Legacy Pilot (oracle/src/legacy.ts, owner item 19): the rule block, the snapshot (the real script against a local mock
 * JSON-RPC, no outside network), the listing, benefit 1 on the base pot (rewards.ts) and benefit 2 on the extra pot
 * (extra.ts), verify reproduction and tamper detection, and the fairness proofs on random chained worlds:
 *   LEGACY-1: every burn record, the capacity and every normal target of every epoch are IDENTICAL with and without the
 *             rule (same inputs, same previous file); only the top-ups are added, on the tier-0 leaves, after them;
 *   LEGACY-2: every holder row (need, use, counted, pay) of every extra epoch and every non-rebated wallet's leaf are
 *             IDENTICAL with and without it.
 * The 104-week regression runs both on its "legacy-pilots" scenario; the fairness suite runs LEGACY-1 on its worlds.
 *   npm test                         (LEGACY_WORLDS=1000 npm test for a longer run)
 */
import assert from "assert";
import bs58 from "bs58";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { CHAINS } from "../src/config";
import {
  anomalyGateV3, buildEpochFileV3, BurnInputV3, ChainInputV3, computeEpochV3, computeEpochV3SkippingUnpriced, DEFAULT_RULES_V3, EpochBodyV3, EpochFileV3, EpochInputsV3, inputsOf, KEEPER_TIP_MIN_CLAIM,
  legacyRecordErrorsV3, ORIGIN_FORGED, rulesBlockOf, RulesBlockV3, SnapshotRecord, verifyEpochV3, windowStateV3,
} from "../src/rewards";
import {
  buildExtraFile, buildSkipExtraFile, computeExtraEpoch, ExtraFileV1, ExtraSnapshotRecord, legacyRecordErrorsV1, MIN_PAY, verifyExtraFile,
} from "../src/extra";
import {
  LEGACY_ARTIFACT_REBATE_BPS, LEGACY_BURN_TOPUP_BPS, LEGACY_CUTOFF_TS, LEGACY_LEFTOVER_BPS, LEGACY_SNAPSHOT_SHA256, LEGACY_SOURCES, legacyListingCheckV3, legacyListingOf, legacyPilotInputsV3,
  legacyPilotRules, legacyPilotRulesOf, legacyRulesPatch, legacySnapshotError, legacySnapshotSetOf, legacySnapshotSha256, LegacySnapshotDoc, verifyLegacyListingV3,
} from "../src/legacy";
import { RULES_V3_VERSIONS, rulesForEpochV3, rulesInForceErrorV3, RulesVersionV3 } from "../src/rules-v3";

let passed = 0;
let failed = 0;
const pending: (() => Promise<void>)[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${(e as Error).stack ?? String(e)}`);
  }
}
function testAsync(name: string, fn: () => Promise<void>) {
  pending.push(async () => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      console.error(`FAIL ${name}\n  ${(e as Error).stack ?? String(e)}`);
    }
  });
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────
const PROGRAM = "57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9";
const XNT = 1_000_000_000n;
const HOUR = 3_600;
const DAY = 86_400;
const WEEK = 7 * DAY;
/** a fixed test origin (Sunday 2026-11-22 00:00 UTC, no live meaning) */
const T0 = 1_795_305_600;
const XEN_E18 = 200_000_000_000n;
const XNT_E18 = 153_000_000_000_000_000n;
const L_MICRO = 100_000_000_000n;
const CHAIN_A = 10;
const CHAIN_B = 56;
const SHA = createHash("sha256").update("legacy test snapshot").digest("hex");
const RULE = legacyPilotRules(SHA);
const BACKING = [5n * XNT, 12_500_000_000n, 30n * XNT, 100n * XNT];
const sum = (xs: bigint[]) => xs.reduce((s, x) => s + x, 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const iso = (ts: number) => new Date(ts * 1000).toISOString();
const blockAt = (ts: number) => ts - T0 + 50_000_000;
const key = (tag: number, i: number) => {
  const b = new Uint8Array(32);
  b[0] = 0x4c;
  b[1] = tag;
  b[2] = i & 255;
  b[31] = 11;
  return new PublicKey(b).toBase58();
};
const sig = (i: number) => {
  const b = new Uint8Array(64);
  b[0] = i & 255;
  b[1] = (i >> 8) & 255;
  b[63] = 13;
  return bs58.encode(b);
};
const W = (i: number) => key(1, i);
const ASSET = (i: number) => key(2, i);
const OPERATOR = key(3, 0);
/** an EVM address with a mixed-case (checksum-like) spelling: the engine lowers it */
const pilot = (i: number) => "0x" + (0xa0 + i).toString(16) + "Ab".repeat(19);
const low = (a: string) => a.toLowerCase();
const RULES: RulesBlockV3 = { ...DEFAULT_RULES_V3, operatorWallets: { rule: "rank-last", wallets: [OPERATOR], exceptions: [] } };
const RULES_L: RulesBlockV3 = { ...RULES, legacyPilot: RULE };

interface B {
  day: number;
  /** the burn's market value in µUSD */
  usd: bigint;
  x1: string;
  pilot: string;
  tier?: number;
  chain?: number;
}
let seq = 0;
function burnInput(b: B, startTs: number): BurnInputV3 {
  seq++;
  const ts = startTs + b.day * DAY + HOUR + (seq % 600) * 5;
  return {
    chainId: b.chain ?? CHAIN_A, txHash: "0x" + seq.toString(16).padStart(64, "0"), logIndex: 0, blockNumber: blockAt(ts), missionId: String(seq), pilot: b.pilot,
    amountWei: ((b.usd * 10n ** 30n) / XEN_E18).toString(), tier: b.tier ?? 0, x1: b.x1, timestamp: ts, medianE18: XEN_E18.toString(), lastCloseE18: XEN_E18.toString(),
    priceSource: "candles", xntMedianE18: XNT_E18.toString(), xntLastCloseE18: XNT_E18.toString(), xntSource: "candles",
  };
}
interface EpochOpt {
  epoch: number;
  prev: EpochFileV3 | null;
  burns: B[];
  /** the free pool at the build and F_ref (open) */
  F: bigint;
  open?: bigint;
  rules?: RulesBlockV3;
  /** the listed set (any case); null = no listing recorded; default: every pilot of LISTED */
  listed?: Set<string> | null;
  records?: SnapshotRecord[];
  /** the week the window ends in (default: the epoch number; later after a build that paid nothing) */
  week?: number;
}
const LISTED = new Set([1, 2, 3, 4, 5, 6].map((i) => low(pilot(i))));
function inputs(o: EpochOpt): EpochInputsV3 {
  const endTs = T0 + (o.week ?? o.epoch) * WEEK;
  const startTs = o.prev ? o.prev.window.endTs + 60 : endTs - WEEK;
  const chains: ChainInputV3[] = [CHAIN_A, CHAIN_B].map((chainId) => {
    const from = o.prev ? o.prev.chains.find((c) => c.chainId === chainId)!.toBlock : blockAt(startTs) - 1;
    const samples: { hour: number; micro: string }[] = [];
    for (let h = Math.ceil(startTs / HOUR); h * HOUR <= endTs - HOUR; h += 4) samples.push({ hour: h, micro: L_MICRO.toString() });
    return {
      chainId, name: `chain-${chainId}`, portal: "0xportal", fromBlockExclusive: from, toBlock: blockAt(endTs),
      market: { spotE18: XEN_E18.toString(), refUsdE18: XEN_E18.toString(), priceSource: "test", pools: [{ address: "0xpool", reserveUsd: "50000.0", createdAt: iso(T0 - 400 * DAY) }] },
      liquidityNowMicro: L_MICRO.toString(), liquiditySamples: samples, poolCreatedAt: T0 - 400 * DAY, totalSupply: "0",
      burns: o.burns.filter((b) => (b.chain ?? CHAIN_A) === chainId).map((b) => burnInput(b, startTs)),
    };
  });
  const rules = o.rules ?? RULES_L;
  const listedSet = o.listed === undefined ? LISTED : o.listed;
  const pilots = [...new Set(chains.flatMap((c) => c.burns.map((b) => low(b.pilot))))];
  return {
    programId: PROGRAM, epoch: o.epoch, createdAt: iso(endTs + 30), window: { startTs, endTs }, chains,
    snapshot: { slot: 1_000_000 + o.epoch * 1_000, records: o.records ?? [] },
    freePool: { lamports: o.F.toString(), slot: 1_000_000 + o.epoch * 1_000 - 1, open: o.prev ? (o.open ?? o.F).toString() : null },
    xnt: { twapE18: XNT_E18.toString(), apiE18: XNT_E18.toString(), source: "test" }, switchRefs: null, rulesBlock: rules,
    ...(rules.legacyPilot && listedSet !== null ? { legacyPilot: { snapshotSha256: rules.legacyPilot.snapshotSha256, listed: pilots.filter((p) => listedSet.has(p)).sort() } } : {}),
  };
}
const build = (o: EpochOpt) => {
  const f = buildEpochFileV3(inputs(o), o.prev);
  assert(f, "the epoch pays something");
  return clone(f!);
};
/** the same epoch without the rule: same inputs (no listing), same previous file */
const withoutRule = (inp: EpochInputsV3, prev: EpochFileV3 | null) => {
  const { legacyPilot: _l, ...rest } = inp;
  const { legacyPilot: _r, ...rules } = inp.rulesBlock!;
  return computeEpochV3({ ...rest, rulesBlock: rules as RulesBlockV3 }, prev);
};
const tier0 = (f: EpochBodyV3, x1: string) => BigInt(f.targets.find((t) => t.player === x1 && t.tier === 0)?.target ?? "0");

/**
 * LEGACY-1 on one epoch: the build with the rule and the one without, from the same inputs and the same previous file,
 * have the same burns, capacity, chains and every member but the rule's own; the targets differ exactly by the paid
 * top-ups, each on its burner's tier-0 leaf. Returns the burns compared.
 */
function legacy1(withF: EpochBodyV3, inp: EpochInputsV3, prev: EpochFileV3 | null, label: string): { burns: number; candidates: number; paid: bigint } {
  const without = withoutRule(inp, prev);
  assert(without, `${label}: the build without the rule pays something too`);
  for (const k of Object.keys(withF) as (keyof EpochBodyV3)[]) {
    if (["legacy", "targets", "leaves", "totalScore", "root", "rulesBlock"].includes(k)) continue;
    assert.deepStrictEqual(withF[k], (without as unknown as Record<string, unknown>)[k], `${label}: ${k} differs with the rule`);
  }
  const { legacyPilot: _r, ...rb } = withF.rulesBlock;
  assert.deepStrictEqual(rb, without!.rulesBlock, `${label}: the rules block differs by more than the Legacy Pilot member`);
  const add = new Map<string, bigint>();
  for (const t of withF.legacy?.topUps ?? []) add.set(t.x1, (add.get(t.x1) ?? 0n) + BigInt(t.paid));
  const norm = new Map(without!.targets.map((t) => [`${t.player}:${t.tier}`, BigInt(t.target)]));
  for (const t of withF.targets) {
    const extra = t.tier === 0 ? add.get(t.player) ?? 0n : 0n;
    assert.strictEqual(BigInt(t.target) - extra, norm.get(`${t.player}:${t.tier}`) ?? 0n, `${label}: target ${t.player}:${t.tier} is not the normal one plus its top-up`);
    norm.delete(`${t.player}:${t.tier}`);
  }
  assert.strictEqual(norm.size, 0, `${label}: a normal target is missing with the rule`);
  const candidates = new Set((withF.legacy?.topUps ?? []).map((t) => t.burn));
  return { burns: withF.burns.filter((_, i) => !candidates.has(i)).length, candidates: candidates.size, paid: BigInt(withF.legacy?.paid ?? "0") };
}

// ── the rule block and the registry ─────────────────────────────────────────────────────────────
test("the rule: parameters pinned (cutoff 2026-11-01 00:00 UTC, six source chains, +50%, 25% of the leftover, mission order, 20%), the sha256 named", () => {
  assert.strictEqual(new Date(LEGACY_CUTOFF_TS * 1000).toISOString(), "2026-11-01T00:00:00.000Z");
  assert.deepStrictEqual(RULE, { cutoffTs: LEGACY_CUTOFF_TS, sourceChains: [1, 10, 56, 137, 8453, 43114], snapshotSha256: SHA, burnTopUpBps: 5_000, leftoverBps: 2_500, order: "mission-order", artifactRebateBps: 2_000 });
  assert.deepStrictEqual([LEGACY_BURN_TOPUP_BPS, LEGACY_LEFTOVER_BPS, LEGACY_ARTIFACT_REBATE_BPS], [5_000n, 2_500n, 2_000n]);
  assert.deepStrictEqual(legacyPilotRulesOf(clone(RULE)), RULE);
  for (const [patch, re] of [
    [{ burnTopUpBps: 10_000 }, /is not this engine's rule/],
    [{ leftoverBps: 5_000 }, /is not this engine's rule/],
    [{ cutoffTs: LEGACY_CUTOFF_TS + 1 }, /is not this engine's rule/],
    [{ sourceChains: [10, 56, 137, 8453, 43114] }, /is not this engine's rule/],
    [{ order: "pro-rata" }, /is not this engine's rule/],
    [{ snapshotSha256: "AB".repeat(32) }, /lowercase sha256/],
    [{ snapshotSha256: null }, /lowercase sha256/],
    [{ extra: 1 }, /exactly the members/],
  ] as [Record<string, unknown>, RegExp][]) {
    assert.throws(() => legacyPilotRulesOf({ ...RULE, ...patch }), re);
    assert.throws(() => rulesBlockOf({ ...RULES, legacyPilot: { ...RULE, ...patch } }), re);
  }
  // the block keeps the member when present and is exactly the old one without it
  assert.deepStrictEqual(rulesBlockOf(RULES_L).legacyPilot, RULE);
  assert.strictEqual("legacyPilot" in rulesBlockOf(RULES), false);
  assert.strictEqual(JSON.stringify(rulesBlockOf(DEFAULT_RULES_V3)), JSON.stringify(rulesBlockOf(clone(DEFAULT_RULES_V3))));
});

test("the registry: unarmed until the snapshot is pinned (the rules of the first v3 epoch unchanged); armed, they carry it and verify requires it", () => {
  assert.strictEqual(LEGACY_SNAPSHOT_SHA256, null, "pinned only once the workflow has built the snapshot");
  assert.deepStrictEqual(legacyRulesPatch(null), {});
  assert.strictEqual("legacyPilot" in RULES_V3_VERSIONS[0].rules, false);
  assert.strictEqual("legacyPilot" in rulesForEpochV3(1, null), false);
  // armed (the pin): the rules of the first v3 epoch carry the member, and a file without it is not the rules in force
  const { legacyPilot: _x, ...first } = RULES_V3_VERSIONS[0].rules as RulesBlockV3;
  const armed: RulesVersionV3[] = [{ fromEpoch: null, announced: null, rules: { ...first, ...legacyRulesPatch(SHA) } }];
  assert.deepStrictEqual(rulesForEpochV3(1, null, armed).legacyPilot, RULE);
  const f = build({ epoch: 1, prev: null, burns: [{ day: 1, usd: 1_000_000n, x1: W(1), pilot: pilot(1) }], F: 2_000n * XNT, rules: rulesForEpochV3(1, null, armed) });
  assert.strictEqual(rulesInForceErrorV3(f, null, armed), null);
  const plain = build({ epoch: 1, prev: null, burns: [{ day: 1, usd: 1_000_000n, x1: W(1), pilot: pilot(1) }], F: 2_000n * XNT, rules: rulesForEpochV3(1, null) });
  assert.match(String(rulesInForceErrorV3(plain, null, armed)), /not the rules version in force/);
});

test("the source table: the five Moon Forge XEN contracts (config.ts) plus Ethereum's", () => {
  assert.deepStrictEqual(LEGACY_SOURCES.map((s) => s.chainId), [1, 10, 56, 137, 8453, 43114]);
  assert.strictEqual(LEGACY_SOURCES[0].xen, "0x06450dee7fd2fb8e39061434babcfc05599a6fb8");
  for (const c of CHAINS) assert.strictEqual(LEGACY_SOURCES.find((s) => s.chainId === c.chainId)?.xen, c.xen.toLowerCase(), `chain ${c.chainId}`);
});

// ── benefit 1: the burn ─────────────────────────────────────────────────────────────────────────
test("benefit 1: the first burn of a listed address gets +50% of its base payout (1.5x), from the leftover only; its second burn, an unlisted address and an operator burn get nothing", () => {
  const f = build({
    epoch: 1, prev: null, F: 5_000n * XNT,
    burns: [
      { day: 0, usd: 2_000_000n, x1: W(1), pilot: pilot(1) },
      { day: 1, usd: 1_000_000n, x1: W(1), pilot: pilot(1), chain: CHAIN_B },
      { day: 1, usd: 1_000_000n, x1: W(2), pilot: pilot(20) },
      { day: 2, usd: 1_000_000n, x1: OPERATOR, pilot: pilot(2) },
      { day: 3, usd: 3_000_000n, x1: W(3), pilot: pilot(3), tier: 2 },
    ],
  });
  assert.deepStrictEqual(verifyEpochV3(f, null), []);
  const L = f.legacy!;
  assert.strictEqual(L.leftover, f.capacity.left);
  assert(BigInt(L.leftover) > 0n, "a week with leftover");
  assert.strictEqual(BigInt(L.cap), (BigInt(L.leftover) * 2_500n) / 10_000n);
  assert.deepStrictEqual(L.topUps.map((t) => [f.burns[t.burn].x1, t.pilot]), [[W(1), low(pilot(1))], [W(3), low(pilot(3))]], "the first burn per listed address, operators excluded, in the arrival order");
  for (const t of L.topUps) {
    const b = f.burns[t.burn];
    assert.strictEqual(BigInt(t.want), (BigInt(b.alloc) * 5_000n) / 10_000n);
    assert.strictEqual(t.paid, t.want, "the cap is ample: whole");
  }
  assert.deepStrictEqual(L.used, [low(pilot(1)), low(pilot(3))]);
  // 1.5x in total on the burn; the locked mission keeps its own leaf, the top-up is Launchpad cash
  const b3 = f.burns[L.topUps[1].burn];
  assert(b3.leafTier === 2, "the tier-2 burn locked its mission");
  assert.strictEqual(tier0(f, W(3)), BigInt(b3.launchpadPaid) + BigInt(L.topUps[1].paid));
  // within C, and verify's own record check passes
  assert(sum(f.burns.map((b) => BigInt(b.alloc))) + BigInt(L.paid) <= BigInt(f.capacity.cash));
  assert.deepStrictEqual(legacyRecordErrorsV3(f), []);
});

test("benefit 1, mission order: a short cap pays the earlier candidates whole, one in part, then 0; a 0 keeps the address eligible, served in a later epoch; a paid one is never again", () => {
  // four candidates (two small, then two large, one chain-hour); the leftover is sized so that its 25% holds the two
  // small top-ups whole and half of the third: whole, whole, partial, 0
  const burns: B[] = [
    { day: 0, usd: 200_000n, x1: W(1), pilot: pilot(1) },
    { day: 0, usd: 200_000n, x1: W(2), pilot: pilot(2) },
    { day: 0, usd: 2_400_000n, x1: W(3), pilot: pilot(3) },
    { day: 0, usd: 2_400_000n, x1: W(4), pilot: pilot(4) },
  ];
  const probe = computeEpochV3(inputs({ epoch: 1, prev: null, burns, F: 100_000n * XNT }), null)!;
  const lps = probe.burns.map((b) => BigInt(b.lp));
  const extra = 2n * lps[0] + 2n * lps[1] + lps[2];
  const F = ((sum(lps) + extra) * 10_000n) / 800n + 13n;
  const f1 = build({ epoch: 1, prev: null, burns, F });
  assert.deepStrictEqual(f1.burns.map((b) => b.lp), probe.burns.map((b) => b.lp));
  const L1 = f1.legacy!;
  const paid = L1.topUps.map((t) => BigInt(t.paid));
  const want = L1.topUps.map((t) => BigInt(t.want));
  assert(BigInt(L1.cap) < sum(want), "the cap is short");
  assert.strictEqual(sum(paid), BigInt(L1.cap), "the whole cap is used");
  const k = paid.findIndex((p, i) => p < want[i]);
  assert(k >= 1, "the first candidate is whole");
  for (let i = 0; i < k; i++) assert.strictEqual(paid[i], want[i]);
  assert(paid[k] > 0n || k === 0);
  for (let i = k + 1; i < paid.length; i++) assert.strictEqual(paid[i], 0n, "after the partial one, 0");
  const zero = L1.topUps.filter((t) => t.paid === "0").map((t) => t.pilot);
  assert(zero.length >= 1, "at least one candidate got 0");
  assert.deepStrictEqual(L1.used, L1.topUps.filter((t) => t.paid !== "0").map((t) => t.pilot).sort());
  assert.deepStrictEqual(verifyEpochV3(f1, null), []);
  // epoch 2: every address burns again, with ample leftover: only the ones paid 0 are candidates
  const f2 = build({ epoch: 2, prev: f1, F: 50_000n * XNT, burns: burns.map((b) => ({ ...b, usd: 1_000_000n })) });
  assert.deepStrictEqual(f2.legacy!.topUps.map((t) => t.pilot).sort(), zero.sort(), "a paid address is never a candidate again; a 0 keeps its eligibility");
  assert(f2.legacy!.topUps.every((t) => t.paid === t.want));
  assert.deepStrictEqual(f2.legacy!.used, [...L1.used, ...zero].sort());
  assert.deepStrictEqual(verifyEpochV3(f2, f1), []);
  // epoch 3: nobody left
  const f3 = build({ epoch: 3, prev: f2, F: 50_000n * XNT, burns: burns.map((b) => ({ ...b, usd: 1_000_000n })) });
  assert.deepStrictEqual(f3.legacy!.topUps, []);
  assert.deepStrictEqual(f3.legacy!.used, f2.legacy!.used, "carried");
  assert.deepStrictEqual(verifyEpochV3(f3, f2), []);
});

test("benefit 1, leftover-only: a capacity-bound week pays no top-up; a shortfall week pays none (cap 0) and the normal cut is the one without the rule", () => {
  const burns: B[] = [1, 2, 3, 4, 5].map((i) => ({ day: 0, usd: 3_000_000n, x1: W(i), pilot: pilot(i) }));
  const bound = build({ epoch: 1, prev: null, burns, F: 200n * XNT });
  assert.strictEqual(bound.capacity.left, "0");
  assert.strictEqual(bound.legacy!.cap, "0");
  assert(bound.legacy!.topUps.length > 0 && bound.legacy!.topUps.every((t) => t.paid === "0"));
  assert.deepStrictEqual(bound.legacy!.used, [], "nobody's eligibility is used up by a week without leftover");
  // a shortfall: the pool at the build fell below the plan; the rule pays nothing and changes nothing
  const f1 = build({ epoch: 1, prev: null, burns: [{ day: 0, usd: 100_000n, x1: W(9), pilot: pilot(30) }], F: 5_000n * XNT });
  const inp = inputs({ epoch: 2, prev: f1, F: 30n * XNT, open: 5_000n * XNT, burns });
  const cut = clone(computeEpochV3(inp, f1)!);
  assert(cut.capacity.shortfall !== null, "a shortfall week");
  assert.strictEqual(cut.legacy!.cap, "0");
  assert.strictEqual(cut.legacy!.paid, "0");
  legacy1(cut, inp, f1, "shortfall");
});

test("benefit 1 never cuts a normal claim: when the build limit leaves room for the normal plan only, the top-ups take what fits (spare keeper tips kept) and the normal plan is the one without the rule", () => {
  const f1 = build({ epoch: 1, prev: null, burns: [{ day: 0, usd: 100_000n, x1: W(9), pilot: pilot(30) }], F: 5_000n * XNT });
  // F_ref large (C large, leftover large), the pool at the build just above what the normal plan needs
  const burns: B[] = [{ day: 0, usd: 1_000_000n, x1: W(1), pilot: pilot(1) }, { day: 1, usd: 1_000_000n, x1: W(2), pilot: pilot(2) }];
  let found = false;
  for (const pct of [101n, 102n, 103n, 105n, 108n, 112n, 120n]) {
    const probe = computeEpochV3(inputs({ epoch: 2, prev: f1, F: 5_000n * XNT, open: 5_000n * XNT, burns }), f1)!;
    const need = sum(probe.burns.map((b) => BigInt(b.alloc)));
    const F = ((need * 10_000n) / 1_000n) * pct / 100n + 60_000_000n * 10n;
    const inp = inputs({ epoch: 2, prev: f1, F, open: 5_000n * XNT, burns });
    const f = clone(computeEpochV3(inp, f1)!);
    if (f.capacity.shortfall !== null) continue;
    legacy1(f, inp, f1, `limit ${pct}`);
    const L = f.legacy!;
    if (sum(L.topUps.map((t) => BigInt(t.paid))) < sum(L.topUps.map((t) => min(BigInt(t.want), BigInt(L.cap))))) found = true;
  }
  assert(found, "some limit cut the top-ups (and only them)");
});

test("benefit 1, once per address whatever the chain: two chains in one week, the earlier burn in the global order is the candidate", () => {
  const f = build({
    epoch: 1, prev: null, F: 5_000n * XNT,
    burns: [{ day: 2, usd: 1_000_000n, x1: W(1), pilot: pilot(1), chain: CHAIN_A }, { day: 1, usd: 2_000_000n, x1: W(2), pilot: pilot(1).toLowerCase(), chain: CHAIN_B }],
  });
  assert.strictEqual(f.legacy!.topUps.length, 1);
  assert.strictEqual(f.burns[f.legacy!.topUps[0].burn].chainId, CHAIN_B, "the day-1 burn on the second chain comes first");
  assert.strictEqual(f.legacy!.topUps[0].x1, W(2), "paid to the x1 named in that burn");
});

test("benefit 1, verify: reproduced from the previous file; every tampering is caught (paid up, used edited, a listing added, the section removed or added)", () => {
  const f1 = build({ epoch: 1, prev: null, F: 5_000n * XNT, burns: [{ day: 0, usd: 1_000_000n, x1: W(1), pilot: pilot(1) }] });
  const f2 = build({ epoch: 2, prev: f1, F: 5_000n * XNT, burns: [{ day: 0, usd: 1_000_000n, x1: W(2), pilot: pilot(2) }, { day: 1, usd: 1_000_000n, x1: W(1), pilot: pilot(1) }] });
  assert.deepStrictEqual(verifyEpochV3(f2, f1), []);
  assert.deepStrictEqual(f2.legacy!.topUps.map((t) => t.pilot), [low(pilot(2))], "pilot 1 was used in epoch 1");
  const bad: [string, (f: EpochFileV3) => void, RegExp][] = [
    ["paid up", (f) => { f.legacy!.topUps[0].paid = (BigInt(f.legacy!.topUps[0].paid) + 1n).toString(); }, /legacy|does not match/],
    ["used edited", (f) => { f.legacy!.used = f.legacy!.used.filter((a) => a !== low(pilot(1))); }, /legacy does not match/],
    ["listing added", (f) => { f.legacy!.listing.listed = [...f.legacy!.listing.listed, "0x" + "f".repeat(40)].sort(); }, /not the pilot of a burn|legacy does not match/],
    ["removed", (f) => { delete (f as { legacy?: unknown }).legacy; }, /records its listing/],
    ["rule removed", (f) => { delete (f.rulesBlock as { legacyPilot?: unknown }).legacyPilot; }, /only under a rules block that carries the rule|without the rule/],
  ];
  for (const [what, edit, re] of bad) {
    const t = clone(f2);
    edit(t);
    const errs = verifyEpochV3(t, f1);
    assert(errs.length > 0 && errs.some((e) => re.test(e)), `${what}: ${errs.join("; ")}`);
  }
  // the previous file's used list is read: a forged one that drops pilot 1 makes epoch 2 pay it again, and verify sees it
  const forgedPrev = clone(f1);
  forgedPrev.legacy!.used = [];
  assert(verifyEpochV3(f2, forgedPrev).some((e) => /data hash/.test(e)));
});

test("benefit 1, the feed and the build: a build under the rule must record its listing; the week-so-far window tolerates none (nobody listed); a listing without the rule is refused", () => {
  const o: EpochOpt = { epoch: 1, prev: null, F: 5_000n * XNT, burns: [{ day: 0, usd: 1_000_000n, x1: W(1), pilot: pilot(1) }], listed: null };
  assert.throws(() => computeEpochV3(inputs(o), null), /records its listing/);
  const ws = windowStateV3(inputs(o), null, { limit: false });
  assert.strictEqual(ws.legacy, null);
  const withListing = inputs({ ...o, listed: undefined });
  assert.throws(() => computeEpochV3({ ...withListing, rulesBlock: RULES }, null), /only under a rules block that carries the rule/);
  assert.throws(() => computeEpochV3({ ...withListing, legacyPilot: { ...withListing.legacyPilot!, snapshotSha256: "0".repeat(64) } }, null), /not the rule's/);
  // an unavailable listing: nobody is listed, the reason is recorded, nothing is used up
  const un = inputs({ ...o, listed: new Set() });
  un.legacyPilot = { snapshotSha256: SHA, listed: [], unavailable: { reason: "the Legacy Pilot snapshot could not be read: missing" } };
  const f = clone(computeEpochV3(un, null)!);
  assert.deepStrictEqual([f.legacy!.topUps, f.legacy!.used, f.legacy!.listing.unavailable?.reason], [[], [], "the Legacy Pilot snapshot could not be read: missing"]);
});

test("benefit 1 and a chain skipped for an unpriced burn: the listing keeps only the pilots of the burns left in the window (the skipped ones wait with their burns)", () => {
  const inp = inputs({ epoch: 1, prev: null, F: 5_000n * XNT, burns: [{ day: 0, usd: 1_000_000n, x1: W(1), pilot: pilot(1) }, { day: 1, usd: 1_000_000n, x1: W(2), pilot: pilot(2), chain: CHAIN_B }] });
  const b = inp.chains.find((c) => c.chainId === CHAIN_B)!;
  b.market = { ...b.market, spotE18: "0" };
  b.burns = b.burns.map((x) => ({ ...x, medianE18: "0", lastCloseE18: "0", priceSource: "fallback" }));
  assert.deepStrictEqual(inp.legacyPilot!.listed, [low(pilot(1)), low(pilot(2))].sort());
  const { body, skipped } = computeEpochV3SkippingUnpriced(inp, null);
  assert.deepStrictEqual(skipped, [CHAIN_B]);
  assert.deepStrictEqual(body!.legacy!.listing.listed, [low(pilot(1))]);
  assert.deepStrictEqual(body!.legacy!.used, [low(pilot(1))], "pilot 2 is not used: its burn waits for its chain's price");
});

test("benefit 1 never holds an epoch: the anomaly gate reads the normal plan (a top-up that lifts a wallet over 60% of C is not a wallet-share hit)", () => {
  // one wallet's normal targets about 50% of C; its +50% top-up would lift it above 60%
  const usd = 3_000_000n;
  const lp = (usd * 10n ** 21n) / XNT_E18 * 12_500n / 10_000n;
  const F = (2n * lp * 10_000n) / 800n;
  const f = build({ epoch: 1, prev: null, F, burns: [{ day: 0, usd, x1: W(1), pilot: pilot(1) }] });
  const C = BigInt(f.capacity.cash);
  const total = sum(f.targets.filter((t) => t.player === W(1)).map((t) => BigInt(t.target)));
  assert(total * 10_000n > C * 6_000n, `with its top-up the wallet takes ${total} of ${C}`);
  assert.deepStrictEqual(anomalyGateV3(f, null, []).filter((r) => r.code === "wallet-share"), []);
  // the same wallet share without any top-up holds as before
  const g = clone(f);
  g.legacy!.topUps = [];
  assert.strictEqual(anomalyGateV3(g, null, []).filter((r) => r.code === "wallet-share").length, 1);
});

// ── the listing against the snapshot ─────────────────────────────────────────────────────────────
function snapshotDoc(addresses: string[], cutoff = LEGACY_CUTOFF_TS): LegacySnapshotDoc {
  const chains = LEGACY_SOURCES.map((s, i) => ({ chainId: s.chainId, xen: s.xen, fromBlock: 100 * i, toBlock: 100 * i + 50, events: addresses.length, addresses: addresses.length }));
  const body = { cutoff, chains, addresses: [...new Set(addresses.map(low))].sort() };
  return { ...body, sha256: legacySnapshotSha256(body) };
}

test("the listing: the window's pilots the snapshot lists (any case), the snapshot's sha256 checked; a missing or other snapshot is recorded unavailable, never a throw", () => {
  const doc = snapshotDoc([pilot(1), pilot(2), pilot(7)]);
  assert.strictEqual(legacySnapshotError(doc), null);
  const set = legacySnapshotSetOf(doc);
  const rule = legacyPilotRules(doc.sha256);
  assert.deepStrictEqual(legacyListingOf(rule, [pilot(2), pilot(1), pilot(9), pilot(1)], set).listed, [low(pilot(1)), low(pilot(2))]);
  const other = legacyPilotRules(SHA);
  assert.match(String(legacyListingOf(other, [pilot(1)], set).unavailable?.reason), /not the rule's/);
  const chains = [{ burns: [{ pilot: pilot(1) }, { pilot: pilot(5) }] }];
  assert.deepStrictEqual(legacyPilotInputsV3({}, chains), {}, "no rule, no member");
  assert.deepStrictEqual(legacyPilotInputsV3({ legacyPilot: rule }, chains, () => set).legacyPilot, { snapshotSha256: doc.sha256, listed: [low(pilot(1))] });
  const missing = legacyPilotInputsV3({ legacyPilot: rule }, chains, () => {
    throw new Error("ENOENT legacy-burners.json");
  }).legacyPilot!;
  assert.deepStrictEqual(missing.listed, []);
  assert.match(String(missing.unavailable?.reason), /could not be read: ENOENT/);
  // verify --full with the document: the listing is exactly the snapshot's
  const rules = { ...RULES, legacyPilot: rule };
  const f = build({ epoch: 1, prev: null, F: 5_000n * XNT, rules, listed: new Set([low(pilot(1))]), burns: [{ day: 0, usd: 1_000_000n, x1: W(1), pilot: pilot(1) }, { day: 1, usd: 1_000_000n, x1: W(5), pilot: pilot(5) }] });
  assert.deepStrictEqual(verifyLegacyListingV3(f, doc), []);
  const g = build({ epoch: 1, prev: null, F: 5_000n * XNT, rules, listed: new Set([low(pilot(1)), low(pilot(5))]), burns: [{ day: 0, usd: 1_000_000n, x1: W(1), pilot: pilot(1) }, { day: 1, usd: 1_000_000n, x1: W(5), pilot: pilot(5) }] });
  assert.match(verifyLegacyListingV3(g, doc).join(" "), /listed but not in it: 0x/);
  const h = build({ epoch: 1, prev: null, F: 5_000n * XNT, rules, listed: new Set(), burns: [{ day: 0, usd: 1_000_000n, x1: W(1), pilot: pilot(1) }] });
  assert.match(verifyLegacyListingV3(h, doc).join(" "), /in it but not listed: 0x/);
  assert.match(verifyLegacyListingV3(f, snapshotDoc([pilot(1)])).join(" "), /names snapshot/);
});

test("verify --full (legacyListingCheckV3): a file without the rule is unaffected; a missing snapshot makes the run incomplete with where to get it; a listing that differs is an error", () => {
  const doc = snapshotDoc([pilot(1), pilot(7)]);
  const rules = { ...RULES, legacyPilot: legacyPilotRules(doc.sha256) };
  const burns: B[] = [{ day: 0, usd: 1_000_000n, x1: W(1), pilot: pilot(1) }, { day: 1, usd: 1_000_000n, x1: W(5), pilot: pilot(5) }];
  const good = build({ epoch: 1, prev: null, F: 5_000n * XNT, rules, listed: new Set([low(pilot(1))]), burns });
  const wrong = build({ epoch: 1, prev: null, F: 5_000n * XNT, rules, listed: new Set([low(pilot(1)), low(pilot(5))]), burns });
  const plain = build({ epoch: 1, prev: null, F: 5_000n * XNT, rules: RULES, burns });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-verify-"));
  try {
    const file = path.join(dir, "legacy-burners.json");
    assert.deepStrictEqual(legacyListingCheckV3(plain, file), { errors: [], unreadable: [] }, "no rule: nothing to check, even without the file");
    const missing = legacyListingCheckV3(good, file);
    assert.deepStrictEqual(missing.errors, []);
    assert.match(missing.unreadable.join(" "), /deployments\/legacy-burners\.json is missing .*legacy-snapshot workflow.*unconfirmed/);
    fs.writeFileSync(file, "{ not json");
    assert.match(legacyListingCheckV3(good, file).errors.join(" "), /is not valid JSON/);
    fs.writeFileSync(file, JSON.stringify(doc));
    assert.deepStrictEqual(legacyListingCheckV3(good, file), { errors: [], unreadable: [] });
    assert.match(legacyListingCheckV3(wrong, file).errors.join(" "), /listed but not in it/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the snapshot document: the cutoff, the six chains in order, sorted unique lowercase addresses and its own sha256 (any change is caught)", () => {
  const doc = snapshotDoc([pilot(3), pilot(1)]);
  assert.strictEqual(legacySnapshotError(doc), null);
  const bad: [string, (d: LegacySnapshotDoc) => void][] = [
    ["another cutoff", (d) => { d.cutoff = LEGACY_CUTOFF_TS + 1; }],
    ["an address changed", (d) => { d.addresses[0] = "0x" + "0".repeat(39) + "1"; }],
    ["unsorted", (d) => { d.addresses.reverse(); }],
    ["uppercase", (d) => { d.addresses[0] = d.addresses[0].toUpperCase().replace("0X", "0x"); }],
    ["a chain missing", (d) => { d.chains.pop(); }],
    ["a chain's contract", (d) => { d.chains[1].xen = "0x" + "1".repeat(40); }],
    ["a count", (d) => { d.chains[0].events++; }],
    ["an extra member", (d) => { (d as unknown as Record<string, unknown>).note = "x"; }],
  ];
  for (const [what, edit] of bad) {
    const d = clone(doc);
    edit(d);
    assert(legacySnapshotError(d) !== null, what);
  }
  assert.match(String(legacySnapshotError(snapshotDoc([pilot(1)], LEGACY_CUTOFF_TS - 1))), /cutoff/);
});

// ── the snapshot script against a local mock JSON-RPC (no outside network) ───────────────────────
const SCRIPT = path.join(__dirname, "..", "..", "scripts", "legacy", "build-snapshot.mjs");
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicOf = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
interface MockLog {
  block: number;
  from: string;
  to: string;
  value: bigint;
  address: string;
}
interface MockChain {
  chainId: number;
  xen: string;
  head: number;
  deploy: number;
  ts: (n: number) => number;
  logs: MockLog[];
}
/** a deterministic chain: block n is stamped 2022-09-01 + n × 70,000 s; XEN deploys at block `deploy`; burns before and after the cutoff */
function mockChain(chainId: number, xen: string, salt: number): MockChain {
  const ts = (n: number) => 1_661_990_400 + n * 70_000;
  const head = 2_000;
  const deploy = 60 + salt * 7;
  const logs: MockLog[] = [];
  let r = salt * 7919 + 17;
  const next = () => (r = (r * 1_103_515_245 + 12_345) % 2_147_483_648);
  for (let i = 0; i < 160; i++) {
    const block = deploy + (next() % (head - deploy));
    const from = "0x" + (next() % 97).toString(16).padStart(4, "0") + "c".repeat(36);
    const kind = next() % 10;
    // 0: a zero-value burn (not a burn); 1: a transfer to someone else (not a burn); 2: a burn of another token at the same topic
    logs.push({ block, from, to: kind === 1 ? "0x" + "e".repeat(40) : "0x" + "0".repeat(40), value: kind === 0 ? 0n : BigInt(1 + (next() % 1_000_000)) * 10n ** 18n, address: kind === 2 ? "0x" + "d".repeat(40) : xen });
  }
  return { chainId, xen, head, deploy, ts, logs };
}
function expectedOf(m: MockChain) {
  let toBlock = 0;
  while (m.ts(toBlock + 1) < LEGACY_CUTOFF_TS) toBlock++;
  const hits = m.logs.filter((l) => l.block <= toBlock && l.address === m.xen && l.to === "0x" + "0".repeat(40) && l.value > 0n);
  return { toBlock, events: hits.length, addresses: [...new Set(hits.map((l) => l.from))].sort() };
}
/** one server for every chain (path /<chainId>); `maxRange` refuses larger getLogs ranges; every `flaky`-th getLogs answers 429 */
function mockServer(chains: MockChain[], o: { maxRange: number; flaky: number }) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const m = chains.find((c) => req.url === `/${c.chainId}` || req.url === `/${c.chainId}/b`);
      const q = JSON.parse(body);
      const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
      const error = (code: number, message: string) => res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, error: { code, message } }));
      if (!m) return error(-32601, "no chain");
      const p = q.params;
      switch (q.method) {
        case "eth_chainId":
          return reply("0x" + m.chainId.toString(16));
        case "eth_blockNumber":
          return reply("0x" + m.head.toString(16));
        case "eth_getBlockByNumber": {
          const n = Number(BigInt(p[0]));
          return reply(n > m.head ? null : { number: p[0], timestamp: "0x" + m.ts(n).toString(16) });
        }
        case "eth_getCode":
          return reply(Number(BigInt(p[1])) >= m.deploy ? "0x6080" : "0x");
        case "eth_getLogs": {
          calls++;
          if (o.flaky && calls % o.flaky === 0 && !req.url!.endsWith("/b")) {
            res.statusCode = 429;
            return res.end("Too Many Requests");
          }
          const f = p[0];
          const a = Number(BigInt(f.fromBlock));
          const b = Number(BigInt(f.toBlock));
          if (b - a + 1 > o.maxRange) return error(-32005, "query exceeds max block range");
          const logs = m.logs
            .filter((l) => l.block >= a && l.block <= b && l.address === f.address && f.topics[0] === TRANSFER && topicOf(l.to) === f.topics[2])
            .map((l, i) => ({ address: l.address, topics: [TRANSFER, topicOf(l.from), topicOf(l.to)], data: "0x" + l.value.toString(16).padStart(64, "0"), blockNumber: "0x" + l.block.toString(16), logIndex: "0x" + i.toString(16), removed: false }));
          return reply(logs);
        }
        default:
          return error(-32601, `method ${q.method}`);
      }
    });
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, LEGACY_RPC_TIMEOUT_MS: "10000" } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code: code ?? 1, out, err }));
  });
}

testAsync("the snapshot script: every source chain scanned from the time bound to the cutoff block (binary search), refused ranges halved, a rate limit failed over, zero values, transfers and other tokens ignored; deterministic bytes; the oracle accepts it", async () => {
  const chains = LEGACY_SOURCES.map((s, i) => mockChain(s.chainId, s.xen, i + 1));
  const srv = await mockServer(chains, { maxRange: 300, flaky: 7 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-snap-"));
  try {
    const src = await run(["sources"]);
    assert.deepStrictEqual(JSON.parse(src.out), LEGACY_SOURCES.map((s) => ({ chainId: s.chainId, xen: s.xen })), "the script's table is the oracle's");
    const outs: string[] = [];
    for (const [k, chunk] of [[0, "1000"], [1, "64"]] as const) {
      const parts: string[] = [];
      for (const c of chains) {
        const part = path.join(dir, `r${k}-part-${c.chainId}.json`);
        // run 0: one flaky RPC then a steady one (the same mock), big chunks halved; run 1: small chunks growing
        const r = await run(["scan", "--chain", String(c.chainId), "--out", part, "--rpc", `${srv.url}/${c.chainId},${srv.url}/${c.chainId}/b`, "--chunk", chunk, "--backoff-ms", "1"]);
        assert.strictEqual(r.code, 0, `scan ${c.chainId}: ${r.err}`);
        const got = JSON.parse(fs.readFileSync(part, "utf8"));
        const want = expectedOf(c);
        assert.deepStrictEqual([got.toBlock, got.events, got.addresses], [want.toBlock, want.events, want.addresses], `chain ${c.chainId}`);
        assert.strictEqual(c.ts(got.toBlock) < LEGACY_CUTOFF_TS && c.ts(got.toBlock + 1) >= LEGACY_CUTOFF_TS, true, "the cutoff block is the last block stamped before the cutoff");
        assert(c.ts(got.fromBlock) >= 1_664_582_400 && c.ts(got.fromBlock - 1) < 1_664_582_400 && got.fromBlock <= c.deploy, "the time bound, at or before the deployment");
        parts.push(part);
      }
      const out = path.join(dir, `r${k}-legacy-burners.json`);
      const m = await run(["merge", "--out", out, ...parts]);
      assert.strictEqual(m.code, 0, m.err);
      outs.push(fs.readFileSync(out, "utf8"));
    }
    assert.strictEqual(outs[0], outs[1], "the same reads give the same bytes, whatever the chunks and the RPCs");
    const doc = JSON.parse(outs[0]) as LegacySnapshotDoc;
    assert.strictEqual(legacySnapshotError(doc), null, "the oracle's validator accepts it");
    assert.strictEqual(doc.sha256, legacySnapshotSha256(doc), "the oracle computes the same sha256");
    assert.deepStrictEqual(doc.addresses, [...new Set(chains.flatMap((c) => expectedOf(c).addresses))].sort(), "once per address whatever the chain");
    assert(BigInt(doc.addresses.length) <= sum(chains.map((c) => BigInt(expectedOf(c).addresses.length))), "the union, never more than the chains together");
    const ck = await run(["check", path.join(dir, "r0-legacy-burners.json")]);
    assert.strictEqual(ck.code, 0, ck.err);
    // a wrong chain behind the URL is refused; a merge with a chain missing is refused
    const wrong = await run(["scan", "--chain", "10", "--out", path.join(dir, "x.json"), "--rpc", `${srv.url}/56`, "--backoff-ms", "1"]);
    assert.notStrictEqual(wrong.code, 0);
    assert.match(wrong.err, /serves chain 56, not 10/);
    const short = await run(["merge", "--out", path.join(dir, "y.json"), ...chains.slice(1).map((c) => path.join(dir, `r0-part-${c.chainId}.json`))]);
    assert.notStrictEqual(short.code, 0);
    assert.match(short.err, /chain 1 \(Ethereum\) is missing/);
    // a start after the deployment is refused where the RPC serves the state
    const late = await run(["scan", "--chain", "10", "--out", path.join(dir, "z.json"), "--rpc", `${srv.url}/10`, "--from", String(chains[1].deploy + 5), "--backoff-ms", "1"]);
    assert.notStrictEqual(late.code, 0);
    assert.match(late.err, /already has code/);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── benefit 2: an Artifact ──────────────────────────────────────────────────────────────────────
const INIT = { ts: T0 - 30 * DAY, tx: sig(999) };
interface Art {
  asset: string;
  tier: number;
  owner: string;
  forgedAt: number;
}
const xrec = (a: Art): ExtraSnapshotRecord => ({ asset: a.asset, tier: a.tier, owner: a.owner, backing: BACKING[a.tier].toString(), origin: ORIGIN_FORGED, forgedAt: a.forgedAt, signature: sig(1) });
const brec = (a: Art): SnapshotRecord => ({ asset: a.asset, tier: a.tier, owner: a.owner, backing: BACKING[a.tier].toString(), origin: ORIGIN_FORGED });
function extraOf(base: EpochFileV3, prev: ExtraFileV1 | null, arts: Art[], X: bigint, opts = {}) {
  return clone(buildExtraFile(base, prev, { slot: base.snapshot.slot, blockTime: base.window.endTs, records: arts.map(xrec) }, { open: X.toString(), lamports: X.toString(), slot: base.snapshot.slot + 5, createdAt: iso(base.window.endTs + 60), init: INIT }, undefined, opts));
}
/** LEGACY-2 on one extra epoch: the same week without the rule has the same rows and totals; each leaf differs by the wallet's Legacy Pilot payments only */
function legacy2(xf: ExtraFileV1, plain: ExtraFileV1, label: string) {
  assert.deepStrictEqual(xf.rows, plain.rows, `${label}: a holder row differs with the rule`);
  for (const k of ["need", "use", "counted", "release", "budgetMax", "eligibleBacking", "backingBound", "eligibleArtifacts"] as const) assert.deepStrictEqual(xf.totals[k], plain.totals[k], `${label}: totals.${k}`);
  const extra = new Map<string, bigint>();
  for (const x of xf.legacy?.payments ?? []) extra.set(x.wallet, (extra.get(x.wallet) ?? 0n) + BigInt(x.paid));
  for (const w of new Set([...xf.leaves, ...plain.leaves].map((l) => l.wallet))) {
    const a = BigInt(xf.leaves.find((l) => l.wallet === w)?.amount ?? "0");
    const b = BigInt(plain.leaves.find((l) => l.wallet === w)?.amount ?? "0");
    assert.strictEqual(a - (extra.get(w) ?? 0n), b, `${label}: wallet ${w}`);
  }
  assert.strictEqual(BigInt(xf.totals.budget), BigInt(plain.totals.budget) + BigInt(xf.legacy?.paid ?? "0"), `${label}: budget`);
}

test("benefit 2: the first new Artifact of a linked wallet claims 20% of its forge price, paid from the release the holder rebates left (within the backing bound), the rest owed to the next weeks, oldest first; once per wallet and per address; LEGACY-2", () => {
  // epoch 1: W1 (pilot 1) and W2 (pilot 2) burn; W5 holds an Artifact from before (eligible in epoch 2)
  const old: Art = { asset: ASSET(1), tier: 2, owner: W(5), forgedAt: T0 - 10 * DAY };
  const b1 = build({ epoch: 1, prev: null, F: 5_000n * XNT, records: [old].map(brec), burns: [{ day: 0, usd: 1_000_000n, x1: W(1), pilot: pilot(1) }, { day: 1, usd: 1_000_000n, x1: W(2), pilot: pilot(2) }] });
  const x1 = extraOf(b1, null, [old], 0n);
  assert.deepStrictEqual(x1.legacy!.linked, [{ wallet: W(1), pilot: low(pilot(1)) }, { wallet: W(2), pilot: low(pilot(2)) }].sort((a, b) => (a.wallet < b.wallet ? -1 : 1)));
  assert.deepStrictEqual(verifyExtraFile(x1, b1, null), []);
  // epoch 2: W1 forges two Artifacts, W2 one, W5 (a holder, not linked) one; W5 burns (its holder rebate is paid)
  const e2 = T0 + 2 * WEEK;
  const arts2: Art[] = [old, { asset: ASSET(2), tier: 1, owner: W(1), forgedAt: e2 - 5 * DAY }, { asset: ASSET(3), tier: 3, owner: W(1), forgedAt: e2 - 4 * DAY }, { asset: ASSET(4), tier: 0, owner: W(2), forgedAt: e2 - 3 * DAY }, { asset: ASSET(5), tier: 0, owner: W(5), forgedAt: e2 - 2 * DAY }];
  const b2 = build({ epoch: 2, prev: b1, F: 200n * XNT, records: arts2.map(brec), burns: [{ day: 0, usd: 4_000_000n, x1: W(5), pilot: pilot(40) }, { day: 1, usd: 4_000_000n, x1: W(6), pilot: pilot(41) }] });
  const X = 1_000n * XNT;
  const x2 = extraOf(b2, x1, arts2, X);
  assert.deepStrictEqual(verifyExtraFile(x2, b2, x1), []);
  assert.deepStrictEqual(legacyRecordErrorsV1(x2), []);
  const L = x2.legacy!;
  assert.deepStrictEqual(L.claims.map((c) => [c.asset, c.wallet, c.pilot]), [[ASSET(2), W(1), low(pilot(1))], [ASSET(4), W(2), low(pilot(2))]], "each linked wallet's first new Artifact, by forge time");
  for (const c of L.claims) assert.strictEqual(BigInt(c.want), (BigInt(c.pricePaid) * 2_000n) / 10_000n, "20% of the forge price");
  assert.deepStrictEqual([L.usedWallets, L.usedPilots], [[W(1), W(2)].sort(), [low(pilot(1)), low(pilot(2))]]);
  assert.deepStrictEqual(L.linked, [], "both links used by their claims");
  const plain = extraOf(b2, x1, arts2, X, { legacy: false });
  legacy2(x2, plain, "epoch 2");
  assert(x2.rows.some((r) => r.pay !== "0"), "a holder is paid this week");
  // the room: what the holder rebates left of min(R, 4% of the live forged backing)
  const live = arts2.reduce((s, a) => s + BACKING[a.tier], 0n);
  const top = min(BigInt(x2.totals.release), (live * 400n) / 10_000n);
  assert.strictEqual(BigInt(L.room), top - BigInt(plain.totals.budget));
  assert(BigInt(L.paid) <= BigInt(L.room));
  assert(BigInt(L.room) < sum(L.claims.map((c) => BigInt(c.want))), "the backing bound is short this week");
  assert.deepStrictEqual(L.payments.map((p) => p.asset), [ASSET(2)], "the oldest claim first, in part");
  assert.deepStrictEqual(L.owed.map((c) => [c.asset, BigInt(c.left)]), [[ASSET(2), BigInt(L.claims[0].want) - BigInt(L.paid)], [ASSET(4), BigInt(L.claims[1].want)]]);
  // epoch 3: W1 forges again (never a second claim); the owed claims are paid first, oldest first
  const e3 = T0 + 3 * WEEK;
  const arts3 = [...arts2, { asset: ASSET(6), tier: 3, owner: W(1), forgedAt: e3 - 3 * DAY }, { asset: ASSET(7), tier: 3, owner: W(8), forgedAt: e3 - 3 * DAY }];
  const b3 = build({ epoch: 3, prev: b2, F: 5_000n * XNT, records: arts3.map(brec), burns: [{ day: 0, usd: 10_000n, x1: W(1), pilot: pilot(1) }] });
  const x3 = extraOf(b3, x2, arts3, X);
  assert.deepStrictEqual(verifyExtraFile(x3, b3, x2), []);
  assert.deepStrictEqual(x3.legacy!.claims, []);
  assert.deepStrictEqual(x3.legacy!.payments.map((p) => p.asset), [ASSET(2), ASSET(4)].slice(0, x3.legacy!.payments.length));
  legacy2(x3, extraOf(b3, x2, arts3, X, { legacy: false }), "epoch 3");
  // over the weeks, each claim is paid at most its want
  const paidBy = new Map<string, bigint>();
  for (const x of [x2, x3]) for (const p of x.legacy!.payments) paidBy.set(p.asset, (paidBy.get(p.asset) ?? 0n) + BigInt(p.paid));
  for (const c of L.claims) assert(paidBy.get(c.asset)! <= BigInt(c.want));
  // tampering: a payment above its claim, a claim of an unlinked owner
  const t = clone(x2);
  t.legacy!.payments[0].paid = (BigInt(L.claims[0].want) + 1n).toString();
  assert(legacyRecordErrorsV1(t).some((e) => /above the claim/.test(e)));
  assert(verifyExtraFile(t, b2, x1).length > 0);
  const u = clone(x2);
  u.legacy!.claims[1].wallet = W(5);
  assert(legacyRecordErrorsV1(u).some((e) => /is not a FORGED Artifact of/.test(e)));
});

test("benefit 2: only from the release left (a pot release of 0 pays nothing and the claim waits); a skip week carries the links, the owed claims and the used sets; MIN_PAY", () => {
  const b1 = build({ epoch: 1, prev: null, F: 5_000n * XNT, burns: [1, 2, 3].map((i) => ({ day: i - 1, usd: 1_000_000n, x1: W(i), pilot: pilot(i) })) });
  const x1 = extraOf(b1, null, [], 0n);
  const e2 = T0 + 2 * WEEK;
  const arts: Art[] = [1, 2, 3].map((i) => ({ asset: ASSET(10 + i), tier: 3, owner: W(i), forgedAt: e2 - (5 - i) * DAY }));
  const b2 = build({ epoch: 2, prev: b1, F: 5_000n * XNT, records: arts.map(brec), burns: [{ day: 0, usd: 100_000n, x1: W(9), pilot: pilot(30) }] });
  // no release at all (X = 0): three claims, nothing paid, all owed
  const zero = extraOf(b2, x1, arts, 0n);
  assert.deepStrictEqual([zero.legacy!.claims.length, zero.legacy!.payments, zero.legacy!.owed.length, zero.totals.budget], [3, [], 3, "0"]);
  assert.deepStrictEqual(verifyExtraFile(zero, b2, x1), []);
  // a release so small that only MIN_PAY-sized payments would fit: none is made below MIN_PAY
  const tiny = extraOf(b2, x1, arts, ((MIN_PAY - 1n) * 10_000n) / 800n);
  assert.deepStrictEqual(tiny.legacy!.payments, []);
  // a skip week: nothing paid, nothing claimed, the owed claims and the links of the new base carried
  const e3 = T0 + 3 * WEEK;
  const b3 = build({ epoch: 3, prev: b2, F: 5_000n * XNT, records: arts.map(brec), burns: [{ day: 0, usd: 100_000n, x1: W(4), pilot: pilot(4) }] });
  const skip = clone(buildSkipExtraFile(b3, zero, "the snapshot could not be read", { open: (100n * XNT).toString(), lamports: (100n * XNT).toString(), slot: b3.snapshot.slot + 5, createdAt: iso(e3 + 60), init: INIT }));
  assert.deepStrictEqual(skip.legacy!.linked, [{ wallet: W(4), pilot: low(pilot(4)) }]);
  assert.deepStrictEqual([skip.legacy!.owed, skip.legacy!.usedWallets, skip.legacy!.paid], [zero.legacy!.owed, zero.legacy!.usedWallets, "0"]);
  assert.deepStrictEqual(verifyExtraFile(skip, b3, zero), []);
  // after the skip (an empty S(n−1)), every Artifact is new again but only forges after the skip's snapshot can claim
  const e4 = T0 + 4 * WEEK;
  const arts4 = [...arts, { asset: ASSET(20), tier: 2, owner: W(4), forgedAt: e4 - 2 * DAY }];
  const b4 = build({ epoch: 4, prev: b3, F: 5_000n * XNT, records: arts4.map(brec), burns: [{ day: 0, usd: 100_000n, x1: W(9), pilot: pilot(30) }] });
  const x4 = extraOf(b4, skip, arts4, 2_000n * XNT);
  assert.deepStrictEqual(x4.legacy!.claims.map((c) => c.asset), [ASSET(20)]);
  assert.deepStrictEqual(x4.legacy!.payments[0]?.asset, ASSET(11), "the oldest owed claim is paid first");
  assert.deepStrictEqual(verifyExtraFile(x4, b4, skip), []);
  legacy2(x4, extraOf(b4, skip, arts4, 2_000n * XNT, { legacy: false }), "after a skip");
});

// ── LEGACY-1 and LEGACY-2 on random chained worlds ───────────────────────────────────────────────
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
const WORLDS = Number(process.env.LEGACY_WORLDS || 150);
const stats = { worlds: 0, epochs: 0, burns: 0, candidates: 0, topUpsPaid: 0, partial: 0, zeroed: 0, capacityBound: 0, shortfalls: 0, extra: 0, rows: 0, rebates: 0, payments: 0, paidBase: 0n, paidExtra: 0n };

test(`LEGACY-1 / LEGACY-2 on ${WORLDS} random chained worlds (3 to 5 epochs each): every normal number identical with and without the rule; each address paid at most once over the history`, () => {
  for (let id = 0; id < WORLDS; id++) {
    const rnd = mulberry32(20_261_102 + id);
    const ri = (n: number) => Math.floor(rnd() * n);
    const epochs = 3 + ri(3);
    const wallets = Array.from({ length: 6 }, (_, i) => W(100 + (id % 50) * 8 + i));
    let prev: EpochFileV3 | null = null;
    let prevX: ExtraFileV1 | null = null;
    const arts: Art[] = [];
    let artSeq = id * 100;
    const paidOnce = new Map<string, number>();
    const claimedW = new Set<string>();
    const claimedP = new Set<string>();
    const wantBy = new Map<string, bigint>();
    const paidBy = new Map<string, bigint>();
    let F = BigInt(50 + ri(4_000)) * XNT;
    stats.worlds++;
    // a build that pays nothing publishes nothing: the same epoch number is built again a week later
    for (let week = 1, e = 1; week <= epochs; week++) {
      const n = ri(14);
      const burns: B[] = Array.from({ length: n }, () => ({
        day: ri(7), usd: BigInt(1 + ri(9)) * 10n ** BigInt(4 + ri(3)), x1: ri(10) === 0 ? OPERATOR : wallets[ri(wallets.length)], pilot: pilot(1 + ri(12)), tier: ri(3), chain: ri(2) ? CHAIN_A : CHAIN_B,
      }));
      const endTs = T0 + week * WEEK;
      for (let k = ri(3); k > 0; k--) arts.push({ asset: key(5, artSeq++ % 250), tier: ri(4), owner: wallets[ri(wallets.length)], forgedAt: endTs - (1 + ri(5)) * DAY });
      const live = [...new Map(arts.map((a) => [a.asset, a])).values()];
      // a shortfall now and then: the pool at the build below F_ref
      const shrink = prev && ri(6) === 0;
      const Fb = shrink ? (F * BigInt(5 + ri(60))) / 100n : F;
      const inp = inputs({ epoch: e, week, prev, F: Fb, open: F, burns, records: live.map(brec) });
      const body = computeEpochV3(inp, prev);
      if (!body) continue;
      const f = clone(body);
      const built: EpochFileV3 = clone(buildEpochFileV3(inp, prev)!);
      assert.deepStrictEqual(verifyEpochV3(built, prev), [], `world ${id} epoch ${e}`);
      const r = legacy1(f, inp, prev, `world ${id} epoch ${e}`);
      stats.epochs++;
      stats.burns += r.burns;
      stats.candidates += r.candidates;
      stats.paidBase += r.paid;
      if (f.capacity.left === "0") stats.capacityBound++;
      if (f.capacity.shortfall) stats.shortfalls++;
      for (const t of f.legacy!.topUps) {
        if (t.paid === "0") stats.zeroed++;
        else {
          stats.topUpsPaid++;
          if (t.paid !== t.want) stats.partial++;
          assert(!paidOnce.has(t.pilot), `world ${id}: ${t.pilot} paid twice (epochs ${paidOnce.get(t.pilot)} and ${e})`);
          paidOnce.set(t.pilot, e);
        }
        assert(LISTED.has(t.pilot), "only listed addresses");
      }
      // LEGACY-2 on the extra epoch of this base (the pot grows with the forges)
      const X = BigInt(ri(3) === 0 ? 1 + ri(20) : 50 + ri(2_000)) * XNT;
      const xf = extraOf(built, prevX, live, X);
      assert.deepStrictEqual(verifyExtraFile(xf, built, prevX), [], `world ${id} extra ${e}`);
      const plain = extraOf(built, prevX, live, X, { legacy: false });
      legacy2(xf, plain, `world ${id} extra ${e}`);
      assert.deepStrictEqual(legacyRecordErrorsV1(xf), [], `world ${id} extra ${e}`);
      for (const c of xf.legacy!.claims) {
        assert(!claimedW.has(c.wallet) && !claimedP.has(c.pilot), `world ${id}: a wallet or an address claims twice`);
        claimedW.add(c.wallet);
        claimedP.add(c.pilot);
        wantBy.set(c.asset, BigInt(c.want));
      }
      for (const p of xf.legacy!.payments) {
        paidBy.set(p.asset, (paidBy.get(p.asset) ?? 0n) + BigInt(p.paid));
        assert(paidBy.get(p.asset)! <= wantBy.get(p.asset)!, `world ${id}: claim ${p.asset} paid above its 20%`);
      }
      stats.extra++;
      stats.rows += xf.rows.length;
      stats.rebates += xf.legacy!.claims.length;
      stats.payments += xf.legacy!.payments.length;
      stats.paidExtra += BigInt(xf.legacy?.paid ?? "0");
      prev = built;
      prevX = xf;
      e++;
      // the pool: the budget out, some inflow
      F = F - BigInt(built.totalScore) + BigInt(ri(300)) * XNT;
      if (F < 10n * XNT) F = 10n * XNT;
    }
  }
  assert(stats.topUpsPaid > 0 && stats.partial > 0 && stats.zeroed > 0 && stats.capacityBound > 0 && stats.shortfalls > 0 && stats.rebates > 0 && stats.payments > 0, `coverage: ${JSON.stringify(stats, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
});

// ── run ─────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  for (const t of pending) await t();
  console.log(
    `legacy: LEGACY-1 ${stats.epochs} epochs / ${stats.burns} non-candidate burns + ${stats.candidates} candidates identical (${stats.topUpsPaid} top-ups paid, ${stats.partial} in part, ${stats.zeroed} at 0; ` +
      `${stats.capacityBound} capacity-bound weeks, ${stats.shortfalls} shortfalls); LEGACY-2 ${stats.extra} extra epochs / ${stats.rows} holder rows identical (${stats.rebates} Artifact claims, ${stats.payments} payments); ` +
      `paid ${Number(stats.paidBase) / 1e9} XNT (base) + ${Number(stats.paidExtra) / 1e9} XNT (extra)`,
  );
  console.log(`legacy tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
