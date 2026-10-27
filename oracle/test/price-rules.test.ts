/**
 * The price and liquidity rules of round 4 (part B): D-13 (the liquidity statistic L with the feed's option (a), the window's
 * L frozen at epoch n−1's build), D-22 (a) (the daily tranche at most 2% of the XDEX XNT reserve at the week start) and
 * D-22 (c) (the USDC.X depeg guard). Unit tests of the pure rules, then the golden worlds of test/fixtures/rules-v3-vectors.json
 * (d13-frozen-l, d22-tranche-cap-peg) that the site (lib/quote.ts) and the kit (quote-v3.mjs) mirror, then the property
 * the freeze exists for: a quote made at the window's first hour is the build's number whatever the build reads.
 */
import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {
  AnyEpochFile, BPS, buildEpochFileV3, clampL, computeEpochV3, DAY, EpochFileV3, EpochInputsV3, FP, firstLiquidityCapV3, HOUR, L_DROP_BPS, L_FIRST_BASE_MICRO,
  L_FIRST_PER_DAY_MICRO, L_GROWTH_BPS, L_STEP_MICRO, liquidityReadingV3, liquidityRuleV3, liquiditySamplesV3, liquidityStatV3, nextLiquidityV3, PEG_GUARD_BPS,
  PLAN_BPS, trancheCapV3, verifyEpochV3, windowStateV3, xdexReadingOf, XDEX_TRANCHE_BPS, xntPegV3, XNT_POOL_DEFAULT, xntPoolActiveV3, xntPoolRecordV3, anomalyGateV3,
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
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const S = (hour: number, micro: bigint) => ({ hour, micro });
const USD = 1_000_000n;

const VECTORS = path.join(__dirname, "fixtures", "rules-v3-vectors.json");
const doc: { worlds: { name: string; epochs: { inputs: EpochInputsV3; file: EpochFileV3 }[] }[] } = JSON.parse(fs.readFileSync(VECTORS, "utf8"));
const world = (name: string) => doc.worlds.find((w) => w.name === name)!;

// ── D-13: the statistic ──────────────────────────────────────────────────────────────────────────
test("D-13: a reading is min(GeckoTerminal, on-chain); on-chain unread = GeckoTerminal alone", () => {
  assert.strictEqual(liquidityReadingV3(5n, 3n), 3n);
  assert.strictEqual(liquidityReadingV3(3n, 5n), 3n);
  assert.strictEqual(liquidityReadingV3(7n, null), 7n);
});

test("D-13: stat = the minimum over the last 7 days of each day's median (zeros count), days counted back from the window end", () => {
  const end = 1_800_000_000 - (1_800_000_000 % HOUR); // on an hour
  const endH = end / HOUR;
  const week = Array.from({ length: 7 * 24 }, (_, i) => S(endH - 7 * 24 + 1 + i, 2_000n * USD));
  assert.strictEqual(liquidityStatV3(week, end), 2_000n * USD);
  // a 10-minute pull shows as one hourly sample of 0: no day's median moves (acceptance: a pull changes L by < 50%)
  const pulled = week.map((s, i) => (i === 50 ? S(s.hour, 0n) : s));
  assert.strictEqual(liquidityStatV3(pulled, end), 2_000n * USD);
  // a JIT deposit of $100k at the build is one sample of the last day: the median ignores it
  const jit = [...week.slice(0, -1), S(endH, 102_000n * USD)];
  assert.strictEqual(liquidityStatV3(jit, end), 2_000n * USD);
  // a whole day at $200 (the pool really pulled for more than half a day): that day's median is the minimum
  const day = week.map((s, i) => (i >= 24 && i < 48 ? S(s.hour, 200n * USD) : s));
  assert.strictEqual(liquidityStatV3(day, end), 200n * USD);
  // raising L takes more than half of EVERY day: 6 days at $10k and one at $2k gives $2k
  const six = week.map((s, i) => (i >= 24 ? S(s.hour, 10_000n * USD) : s));
  assert.strictEqual(liquidityStatV3(six, end), 2_000n * USD);
  // samples older than 7 days (a late window) are recorded and not counted; an even count takes the floor of the middle two
  assert.strictEqual(liquidityStatV3([S(endH - 24 * 8, 1n), S(endH - 1, 4n), S(endH, 7n)], end), 5n);
  assert.throws(() => liquidityStatV3([S(endH - 24 * 8, 1n)], end), /no sample/);
});

test("D-13: the recorded samples are checked (ascending, not after the end); the build's own reading is the sample of the end's hour", () => {
  const end = 1_800_000_000;
  const endH = Math.floor(end / HOUR);
  const r = liquiditySamplesV3([{ hour: endH - 2, micro: "5" }, { hour: endH - 1, micro: "6" }], end, 9n, "c");
  assert.deepStrictEqual(r, [S(endH - 2, 5n), S(endH - 1, 6n), S(endH, 9n)]);
  // a recorded sample for the end's hour wins over the build's reading
  assert.deepStrictEqual(liquiditySamplesV3([{ hour: endH, micro: "4" }], end, 9n, "c"), [S(endH, 4n)]);
  assert.deepStrictEqual(liquiditySamplesV3(undefined, end, 9n, "c"), [S(endH, 9n)]);
  assert.throws(() => liquiditySamplesV3([{ hour: endH - 1, micro: "5" }, { hour: endH - 1, micro: "6" }], end, 9n, "c"), /strictly ascending/);
  assert.throws(() => liquiditySamplesV3([{ hour: endH + 1, micro: "5" }], end, 9n, "c"), /after the window end/);
  assert.throws(() => liquiditySamplesV3([{ hour: endH - 1, micro: "-5" }], end, 9n, "c"), /canonical unsigned integer/);
  assert.throws(() => liquiditySamplesV3([{ hour: endH - 1, micro: "5", extra: 1 }], end, 9n, "c"), /exactly the members/);
  assert.throws(() => liquiditySamplesV3({}, end, 9n, "c"), /not an array/);
});

test("D-13: the next window's L stays within [50% × L, 110% × L + $50] of the L in force (the symmetric clamp and the step)", () => {
  const L = 2_000n * USD;
  assert.strictEqual(nextLiquidityV3(L, L), L);
  assert.strictEqual(nextLiquidityV3(102_000n * USD, L), (L * L_GROWTH_BPS) / BPS + L_STEP_MICRO, "a JIT reading moves the next L by at most 10% + $50");
  assert.strictEqual(nextLiquidityV3(0n, L), (L * L_DROP_BPS) / BPS, "a pull moves the next L by at most 50%");
  assert.strictEqual(nextLiquidityV3(1_500n * USD, L), 1_500n * USD);
  // recovery from 0 by the step
  assert.strictEqual(nextLiquidityV3(1_000n * USD, 0n), L_STEP_MICRO);
  // the growth side is the old clamp
  for (const [s, u] of [[5n, 7n], [10n ** 12n, 10n ** 9n], [3n * USD, 0n]] as const) assert.strictEqual(nextLiquidityV3(s, u) >= clampL(s, u) || s < (u * L_DROP_BPS) / BPS, true);
});

test("D-13: the first-reading cap is $500 + $50 per whole day of the price pool's age at the window start, at most 90 days", () => {
  const start = 1_800_000_000;
  assert.strictEqual(firstLiquidityCapV3(null, start), L_FIRST_BASE_MICRO, "unknown age: $500");
  assert.strictEqual(firstLiquidityCapV3(start + 5, start), L_FIRST_BASE_MICRO, "a pool created after the start: age 0");
  assert.strictEqual(firstLiquidityCapV3(start - 10 * DAY - 5, start), 1_000n * USD);
  assert.strictEqual(firstLiquidityCapV3(start - 10 * DAY + 5, start), 950n * USD, "whole days only");
  assert.strictEqual(firstLiquidityCapV3(start - 400 * DAY, start), L_FIRST_BASE_MICRO + 90n * L_FIRST_PER_DAY_MICRO, "at most 90 days: $5,000");
});

test("D-13 (a): which L values the window: frozen (epoch n−1's next), switch (the v2 reading), legacy, first (capped), genesis", () => {
  const stat = 9_000n * USD;
  const cap = 1_000n * USD;
  assert.deepStrictEqual(liquidityRuleV3({ L: 5n, next: 7n, v2: false }, true, stat, cap), { used: 7n, rule: "frozen", cap: null });
  assert.deepStrictEqual(liquidityRuleV3({ L: 2_000n * USD, next: undefined, v2: true }, true, stat, cap), { used: 2_000n * USD, rule: "switch", cap: null });
  assert.deepStrictEqual(liquidityRuleV3({ L: 2_000n * USD, next: undefined, v2: false }, true, stat, cap), { used: clampL(stat, 2_000n * USD), rule: "legacy", cap: null });
  assert.deepStrictEqual(liquidityRuleV3({ L: null, next: undefined, v2: true }, true, stat, cap), { used: cap, rule: "first", cap }, "a v2 chain with no reading takes the first-reading cap");
  assert.deepStrictEqual(liquidityRuleV3({ L: 5n, next: null, v2: false }, true, stat, cap), { used: cap, rule: "first", cap }, "nothing frozen: a first reading");
  assert.deepStrictEqual(liquidityRuleV3(null, true, stat, cap), { used: cap, rule: "first", cap });
  assert.deepStrictEqual(liquidityRuleV3(null, true, 300n * USD, cap), { used: 300n * USD, rule: "first", cap });
  assert.deepStrictEqual(liquidityRuleV3(null, false, stat, cap), { used: stat, rule: "genesis", cap: null }, "no previous file at all (a fresh deployment)");
});

// ── D-22 ─────────────────────────────────────────────────────────────────────────────────────────
test("D-22 (a): the week's cap is 7 daily tranches of 2% of the XDEX XNT reserve at the week start", () => {
  assert.strictEqual(trancheCapV3(null), null);
  assert.strictEqual(trancheCapV3(5_000_000_000n), 7n * ((5_000_000_000n * XDEX_TRANCHE_BPS) / BPS));
  assert.strictEqual(trancheCapV3(5_000_000_000n), 700_000_000n);
  assert.strictEqual(trancheCapV3(49n), 0n, "a reserve below 50 lamports allows nothing");
  assert.deepStrictEqual(xdexReadingOf(null, "x"), null);
  const r = { pool: "CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR", slot: 1, wxntReserveLamports: "5", usdcReserveMicro: "6", feeBps: 25 };
  assert.deepStrictEqual(xdexReadingOf(r, "x"), r);
  assert.throws(() => xdexReadingOf({ ...r, feeBps: 10_000 }, "x"), /not below 100%/);
  assert.throws(() => xdexReadingOf({ ...r, more: 1 }, "x"), /exactly the members/);
  assert.throws(() => xdexReadingOf({ ...r, pool: "nope" }, "x"), /base58/);
});

test("D-22 (c): the depeg guard reads USDC.X as x1report's USD over the XDEX TWAP; above +3% every pool reading takes the factor", () => {
  assert.deepStrictEqual(xntPegV3(0n, FP), { usdcxUsdE18: null, guard: "unread", factorE18: FP.toString() });
  assert.deepStrictEqual(xntPegV3(FP, 0n), { usdcxUsdE18: null, guard: "unread", factorE18: FP.toString() });
  assert.strictEqual(xntPegV3(FP, (FP * 103n) / 100n).guard, "ok", "exactly 3%: no depeg");
  assert.deepStrictEqual(xntPegV3(FP, (FP * 105n) / 100n), { usdcxUsdE18: ((FP * 105n) / 100n).toString(), guard: "high", factorE18: ((FP * 105n) / 100n).toString() });
  assert.deepStrictEqual(xntPegV3(FP, (FP * 96n) / 100n), { usdcxUsdE18: ((FP * 96n) / 100n).toString(), guard: "low", factorE18: FP.toString() }, "a discount needs nothing: USDC.X at $1 already prices XNT high");
  assert.strictEqual(PEG_GUARD_BPS, 300n);
  // the memory note's case: GeckoTerminal's own USD for USDC.X (1.3757) is never an input; the guard compares x1report with the TWAP
  assert.strictEqual(xntPegV3(193_200_000_000_000_000n, 193_400_000_000_000_000n).guard, "ok", "x1report $0.1934 vs 0.1932 USDC.X: within the band");
});

// ── the golden worlds ────────────────────────────────────────────────────────────────────────────
test("golden d13-frozen-l: a JIT deposit at the build moves nothing; a day-long pull moves the NEXT window's L by 50%; a new chain is capped", () => {
  const w = world("d13-frozen-l");
  const [f1, f2, f3] = w.epochs.map((e) => e.file);
  const c = (f: EpochFileV3, id: number) => f.chains.find((x) => x.chainId === id)!;
  assert.deepStrictEqual([c(f1, 10).L.rule, c(f1, 10).L.used, c(f1, 10).L.stat, c(f1, 10).L.next], ["genesis", "2000000000", "2000000000", "2000000000"], "the 10-minute pull of epoch 1 moves no daily median");
  assert.deepStrictEqual([c(f2, 10).L.now, c(f2, 10).L.onChain, c(f2, 10).L.rule, c(f2, 10).L.used, c(f2, 10).L.stat, c(f2, 10).L.next], ["102000000000", "101000000000", "frozen", "2000000000", "2000000000", "2000000000"]);
  assert.deepStrictEqual([c(f2, 56).L.rule, c(f2, 56).L.cap, c(f2, 56).L.used, c(f2, 56).L.next], ["first", "1000000000", "1000000000", "1150000000"], "a new chain: min(stat $50k, $500 + 10 days × $50)");
  assert.deepStrictEqual([c(f3, 10).L.rule, c(f3, 10).L.used, c(f3, 10).L.stat, c(f3, 10).L.next], ["frozen", "2000000000", "200000000", "1000000000"], "the pulled day lowers the next L by the 50% clamp only");
  assert.deepStrictEqual([c(f3, 56).L.rule, c(f3, 56).L.next], ["carried", "1150000000"], "a skipped chain carries its frozen L");
  // the same burn in the JIT week is valued exactly as without the JIT
  const noJit = clone(w.epochs[1].inputs);
  noJit.chains[0].liquidityNowMicro = "2000000000";
  noJit.chains[0].liquidityOnChainMicro = "2000000000";
  const b = computeEpochV3(noJit, f1)!;
  assert.strictEqual(b.burns.find((x) => x.chainId === 10)!.valueMicro, f2.burns.find((x) => x.chainId === 10)!.valueMicro);
  for (const [i, e] of w.epochs.entries()) assert.deepStrictEqual(verifyEpochV3(e.file, i ? w.epochs[i - 1].file : null), []);
});

test("golden d22-tranche-cap-peg: C = 7 × 2% of epoch n−1's XDEX reading; USDC.X at $1.05 prices the candles at $1.05", () => {
  const w = world("d22-tranche-cap-peg");
  const [f1, f2] = w.epochs.map((e) => e.file);
  assert.deepStrictEqual(f1.xdex.atBuild?.wxntReserveLamports, "5000000000");
  assert.deepStrictEqual([f1.capacity.trancheCap, f1.xdex.capReserve], [null, null], "no week-start reading for the first window");
  assert.deepStrictEqual([f2.xdex.capReserve, f2.capacity.trancheCap, f2.capacity.cash], ["5000000000", "700000000", "700000000"]);
  assert.strictEqual(f2.capacity.planCash, ((BigInt(f2.freePool.ref) * PLAN_BPS) / BPS).toString());
  assert(BigInt(f2.capacity.planCash) > BigInt(f2.capacity.cash), "the XDEX cap binds");
  assert.strictEqual(sumAlloc(f2) <= 700_000_000n, true);
  assert.deepStrictEqual(f2.xnt.peg, { usdcxUsdE18: "1050000000000000000", guard: "high", factorE18: "1050000000000000000" });
  assert(f2.burns.every((b) => b.xntE18 === "1050000000000000000"), "every burn's XNT is the pool reading × 1.05");
  assert.strictEqual(f2.xnt.buildE18, "1050000000000000000");
  // without the guard (x1report = TWAP) the same burns are paid more XNT: the guard is pool-safe
  const flat = clone(w.epochs[1].inputs);
  flat.xnt.apiE18 = flat.xnt.twapE18;
  const g = computeEpochV3(flat, f1)!;
  assert.strictEqual(g.xnt.peg.guard, "ok");
  assert(BigInt(g.burns[0].base) > BigInt(f2.burns[0].base));
  // a window that reads no XDEX carries the cap reserve: the next week stays capped by the last reading
  const st = windowStateV3(clone(w.epochs[1].inputs), f1);
  assert.deepStrictEqual(st.xdex, { atBuild: null, capReserve: "5000000000" });
  for (const [i, e] of w.epochs.entries()) assert.deepStrictEqual(verifyEpochV3(e.file, i ? w.epochs[i - 1].file : null), []);
});

function sumAlloc(f: EpochFileV3): bigint {
  return f.burns.reduce((s, b) => s + BigInt(b.alloc), 0n);
}

test("a recorded L input changed after the build fails verification (samples, on-chain reading, pool age and XDEX reading are hashed inputs)", () => {
  const w = world("d13-frozen-l");
  const f2 = w.epochs[1].file;
  const f1 = w.epochs[0].file;
  const tamper = (fn: (f: EpochFileV3) => void) => {
    const g = clone(f2);
    fn(g);
    return verifyEpochV3(g, f1);
  };
  assert(tamper((g) => (g.chains[0].liquiditySamples[3].micro = "1")).length > 0);
  assert(tamper((g) => (g.chains[0].L.onChain = "1")).length > 0);
  assert(tamper((g) => (g.chains.find((c) => c.chainId === 56)!.poolCreatedAt = 1)).length > 0);
  assert(tamper((g) => (g.chains[0].L.next = "1")).length > 0);
  const d = world("d22-tranche-cap-peg");
  const g = clone(d.epochs[0].file);
  g.xdex.atBuild!.wxntReserveLamports = "1";
  assert(verifyEpochV3(g, null).length > 0);
});

// ── the property the freeze exists for ───────────────────────────────────────────────────────────
test("D-13 (a): the L of a window is known at its first hour: whatever the build reads (JIT, pull, on-chain), the window's values are the same", () => {
  const w = world("d13-frozen-l");
  const f1 = w.epochs[0].file;
  const base = w.epochs[1].inputs;
  const values = (inp: EpochInputsV3) => windowStateV3(inp, f1).works.map((x) => x.value.toString());
  const ref = values(clone(base));
  for (const [gt, oc] of [["1", "1"], ["999999999999", null], ["0", "0"], ["2000000000", "5"]] as const) {
    const inp = clone(base);
    for (const c of inp.chains.filter((x) => x.chainId === 10)) {
      c.liquidityNowMicro = gt;
      c.liquidityOnChainMicro = oc;
      c.liquiditySamples = [];
    }
    assert.deepStrictEqual(values(inp), ref, `build reading ${gt} / ${oc}`);
  }
  // the next window's L moves by at most +10% + $50 or −50% whatever this build reads
  const L = 2_000_000_000n;
  for (const [gt] of [["999999999999"], ["0"]] as const) {
    const inp = clone(base);
    inp.chains[0].liquidityNowMicro = gt;
    inp.chains[0].liquidityOnChainMicro = null;
    inp.chains[0].liquiditySamples = [];
    const next = BigInt(windowStateV3(inp, f1).chains.find((c) => c.chainId === 10)!.L.next!);
    assert(next <= (L * L_GROWTH_BPS) / BPS + L_STEP_MICRO && next >= (L * L_DROP_BPS) / BPS, `next ${next}`);
  }
});

test("golden d21-orphaned-chain: 4 no-market skips in a row (a read failure does not count) announce the orphaning one epoch ahead; then half the reference", () => {
  const w = world("d21-orphaned-chain");
  const files = w.epochs.map((e) => e.file);
  const c56 = (f: EpochFileV3) => f.chains.find((c) => c.chainId === 56)!;
  assert.deepStrictEqual(files.map((f) => c56(f).noMarketRun?.skips ?? 0), [0, 1, 1, 2, 3, 4, 4]);
  assert.deepStrictEqual(files.map((f) => f.noMarket), [[], [56], [], [56], [56], [56], []]);
  assert.deepStrictEqual(files.map((f) => c56(f).orphan?.from ?? null), [null, null, null, null, null, 7, 7], "announced by epoch 6, in force from epoch 7");
  const ref = c56(files[0]).xenUsdE18;
  assert.strictEqual(c56(files[5]).orphan!.refE18, ref, "the reference the chain had when its run began");
  const b = files[6].burns.find((x) => x.chainId === 56)!;
  assert.deepStrictEqual([b.priceRule, b.priceE18, b.priceSource, b.backlog], ["orphan", (BigInt(ref) / 2n).toString(), "orphan", true]);
  assert.strictEqual(c56(files[6]).L.next, (BigInt(c56(files[6]).L.used!) / 2n).toString(), "no market: the frozen L halves each week");
  for (const [i, e] of w.epochs.entries()) assert.deepStrictEqual(verifyEpochV3(e.file, i ? files[i - 1] : null), []);
  // refused: an orphan valuation before the notice runs out, an "orphan" price on a chain that is not orphaned, a noMarket
  // chain that is also valued
  const early = clone(w.epochs[6].inputs);
  assert.throws(() => computeEpochV3(early, files[4]), /previous file is epoch 5|announces no orphaning/);
  const e6 = clone(w.epochs[5].inputs);
  e6.chains.push({ ...clone(w.epochs[6].inputs.chains.find((c) => c.chainId === 56)!), fromBlockExclusive: c56(files[4]).toBlock });
  assert.throws(() => computeEpochV3(e6, files[4]), /listed in noMarket and valued|announces no orphaning/);
  const notOrphan = clone(w.epochs[6].inputs);
  delete notOrphan.chains.find((c) => c.chainId === 56)!.orphan;
  assert.throws(() => computeEpochV3(notOrphan, files[5]), /priceSource "orphan" on a chain that is not orphaned|burns but no price reference/);
  const notOrphan2 = clone(notOrphan);
  notOrphan2.chains.find((c) => c.chainId === 56)!.market = clone(w.epochs[0].inputs.chains.find((x) => x.chainId === 56)!.market);
  assert.throws(() => computeEpochV3(notOrphan2, files[5]), /priceSource "orphan" on a chain that is not orphaned/);
  // the market comes back: valued on it, the run and the orphaning end
  const back = clone(w.epochs[6].inputs);
  const c = back.chains.find((x) => x.chainId === 56)!;
  delete c.orphan;
  c.market = clone(w.epochs[0].inputs.chains.find((x) => x.chainId === 56)!.market);
  c.liquidityNowMicro = "1000000000000000000000000000000";
  c.burns = c.burns.map((x) => ({ ...x, medianE18: ref, lastCloseE18: ref, priceSource: "candles" }));
  const g = computeEpochV3(back, files[5])!;
  assert.deepStrictEqual([c56(g as EpochFileV3).noMarketRun, c56(g as EpochFileV3).orphan], [null, null]);
});

test("D-22 (b): a candidate more than 2× the active pool's median TVL for 2 builds is announced, then read; the gate holds the switch epoch", () => {
  const A = XNT_POOL_DEFAULT;
  const B = "7M7RXES3U4arfXpKeGwRJFJAtJFxDn2Eyjj1SXVnGBz8";
  const r = (a: number, b: number) => [{ pool: A, tvlMicro: String(a) }, { pool: B, tvlMicro: String(b) }];
  const r1 = xntPoolRecordV3(null, r(9, 15));
  assert.deepStrictEqual([r1.active, r1.deeper, r1.weeks, r1.next], [A, null, 0, null], "15 < 2 × 9");
  const r2 = xntPoolRecordV3(r1, r(9, 30));
  assert.deepStrictEqual([r2.deeper, r2.weeks, r2.next], [B, 1, null], "median 22 > 18: once");
  const r3 = xntPoolRecordV3(r2, r(9, 40));
  assert.deepStrictEqual([r3.deeper, r3.weeks, r3.next], [B, 2, B], "twice in a row: announced");
  const r4 = xntPoolRecordV3(r3, r(9, 40));
  assert.deepStrictEqual([r4.active, r4.deeper, r4.next], [B, null, null], "in force from the next epoch");
  assert.strictEqual(xntPoolActiveV3(r3), B);
  assert.strictEqual(xntPoolActiveV3(null), A);
  // a dip breaks the run; no reading keeps the history; a pool listed twice is refused
  assert.deepStrictEqual([xntPoolRecordV3(r2, r(9, 10)).deeper, xntPoolRecordV3(r2, r(9, 10)).weeks], [null, 0], "a dip of B (median 15 < 18) breaks the run");
  assert.deepStrictEqual([xntPoolRecordV3(r2, undefined).weeks, xntPoolRecordV3(r2, undefined).next], [1, null], "a build that reads no pool counts nothing toward the 2 builds");
  assert.strictEqual(xntPoolRecordV3(r2, r(30, 10)).deeper, null, "A grew: nothing is deeper");
  assert.throws(() => xntPoolRecordV3(null, [{ pool: A, tvlMicro: "1" }, { pool: A, tvlMicro: "2" }]), /twice/);
  const w = world("d22b-pool-switch");
  const fs4 = w.epochs.map((e) => e.file);
  assert.deepStrictEqual(fs4.map((f) => f.xntPool.active), [A, A, A, B, B]);
  assert.deepStrictEqual(fs4.map((f) => f.xntPool.next), [null, null, B, null, null]);
  for (const [i, e] of w.epochs.entries()) assert.deepStrictEqual(verifyEpochV3(e.file, i ? fs4[i - 1] : null), []);
  assert(anomalyGateV3(fs4[3], fs4[2], [fs4[2], fs4[1], fs4[0]]).some((g) => g.code === "xnt-source" && /switched/.test(g.text)), "the first epoch on the new pool is held by the gate");
  assert(!anomalyGateV3(fs4[4], fs4[3], [fs4[3], fs4[2]]).some((g) => /switched/.test(g.text)));
});

test("the files of this part rebuild byte for byte (the generic golden test also runs them)", () => {
  for (const name of ["d13-frozen-l", "d22-tranche-cap-peg", "d21-orphaned-chain", "d22b-pool-switch"]) {
    let prev: AnyEpochFile | null = null;
    for (const e of world(name).epochs) {
      const again = buildEpochFileV3(clone(e.inputs), prev);
      assert.strictEqual(JSON.stringify(again), JSON.stringify(e.file), `${name} epoch ${e.inputs.epoch}`);
      prev = e.file;
    }
  }
});

console.log(`price rules tests: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
