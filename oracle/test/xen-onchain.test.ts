/**
 * FEATURE-MATRIX gap 3, no network: the second XEN price source (src/xen-onchain-v3.ts), its wiring into the live
 * sources (src/sources-v3.ts), the GeckoTerminal breaker (src/pricing.ts getJsonV3), the `verify --full` comparison and
 * the health row "XEN price sources" (src/health-rules.ts).
 *   npx ts-node test/xen-onchain.test.ts
 */
import assert from "assert";
import { Keypair } from "@solana/web3.js";
import { CHAINS } from "../src/config";
import { isNoMarketErrorV3, marketV3 } from "../src/flow-v3";
import { getJsonV3, GT_BREAKER, GT_BREAKER_LIMIT, GT_TIMEOUT_MS } from "../src/pricing";
import { PRICE_CAP_BPS, xenPrice } from "../src/rewards";
import { liveSourcesV3 } from "../src/sources-v3";
import { programV3 } from "../src/x1-v3";
import {
  isOnChainSourceV3, ONCHAIN_MAX_POOLS, OnChainPriorV3, ONCHAIN_SOURCE_PREFIX, OnChainMarketV3, onChainMarketMismatchV3, onChainMarketOfV3, OnChainPoolReadV3, onChainPriorOfV3, poolValueV3,
  quotePerXenE18V3, xenMarketWithFallbackV3,
} from "../src/xen-onchain-v3";
import { weeklyRunsBetween, xenPriceHistoryNext, xenPriceVerdict, XenPriceProbe } from "../src/health-rules";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${(e as Error).stack ?? String(e)}`);
  }
}

const E18 = 10n ** 18n;
const BASE = CHAINS.find((c) => c.chainId === 8453)!;
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const JUNK = "0xdeadbeef00000000000000000000000000000000";
const addr = (n: number) => `0xaaaa${n.toString(16).padStart(36, "0")}`;
/** a v2 pool of XEN (token0, 18 decimals) against `quote`: `xen` whole XEN and `q` whole quote tokens */
const v2 = (n: number, quote: string, qDec: number, xen: bigint, q: bigint, quoteUsd: bigint | null): OnChainPoolReadV3 => ({
  address: addr(n), quote, xenIsToken0: true, xenDecimals: 18, quoteDecimals: qDec, kind: "v2",
  reserve0: (xen * E18).toString(), reserve1: (q * 10n ** BigInt(qDec)).toString(),
  xenBalance: (xen * E18).toString(), quoteBalance: (q * 10n ** BigInt(qDec)).toString(), quoteUsdE18: quoteUsd === null ? null : quoteUsd.toString(),
});

async function main() {
  await test("price math: v2 reserves and v3 sqrtPriceX96, either token order, any decimals (quote per XEN × 1e18)", () => {
    // 1e12 XEN against 100 USDC (6 decimals): 1e-10 USDC per XEN
    assert.strictEqual(quotePerXenE18V3(v2(1, USDC, 6, 1_000_000_000_000n, 100n, E18)), 100_000_000n);
    const flipped = { ...v2(1, USDC, 6, 1_000_000_000_000n, 100n, E18), xenIsToken0: false, reserve0: (100n * 10n ** 6n).toString(), reserve1: (1_000_000_000_000n * E18).toString() };
    assert.strictEqual(quotePerXenE18V3(flipped), 100_000_000n, "XEN as token1");
    assert.strictEqual(quotePerXenE18V3({ ...v2(1, USDC, 6, 0n, 100n, E18) }), 0n, "no XEN side: no price");
    // v3: XEN token1, WETH token0 (both 18 decimals), 1e12 XEN per WETH → 1e-12 WETH per XEN
    const s = 1_000_000n * (1n << 96n);
    const v3a: OnChainPoolReadV3 = { address: addr(2), quote: WETH, xenIsToken0: false, xenDecimals: 18, quoteDecimals: 18, kind: "v3", sqrtPriceX96: s.toString(), fee: 3000, xenBalance: "0", quoteBalance: "0", quoteUsdE18: null };
    assert.strictEqual(quotePerXenE18V3(v3a), 1_000_000n);
    // XEN token0: sqrt(1e-12) × 2^96, floored: within one unit of 1e6
    const v3b = { ...v3a, xenIsToken0: true, sqrtPriceX96: ((1n << 96n) / 1_000_000n).toString() };
    const p = quotePerXenE18V3(v3b);
    assert(p >= 999_999n && p <= 1_000_000n, String(p));
    assert.strictEqual(quotePerXenE18V3({ ...v3a, sqrtPriceX96: "0" }), 0n);
  });

  await test("the GeckoTerminal rules on on-chain data: allowlisted quote, a fresh Chainlink round, $50 of reserves, within 3× of the reference", () => {
    const ref = 100_000_000n; // $1e-10 per XEN
    const ok = v2(1, USDC, 6, 1_000_000_000_000n, 100n, E18); // $100 + $100
    const v = poolValueV3(ok, BASE.gecko, ref);
    assert.deepStrictEqual(v, { xenUsdE18: 100_000_000n, reserveUsdE18: 200n * E18, eligible: true, why: null });
    assert.match(String(poolValueV3({ ...ok, quote: JUNK }, BASE.gecko, ref).why), /not an allowlisted quote/);
    assert.match(String(poolValueV3({ ...ok, quoteUsdE18: null }, BASE.gecko, ref).why), /no fresh Chainlink round/);
    assert.match(String(poolValueV3(v2(1, USDC, 6, 100_000_000_000n, 10n, E18), BASE.gecko, ref).why), /under \$50/);
    const triple = v2(5, USDC, 6, 1_000_000_000_000n, 300n, E18); // $3e-10: exactly 3× the reference
    assert.strictEqual(poolValueV3(triple, BASE.gecko, ref).eligible, true, "exactly 3× the reference: kept (as GeckoTerminal's rule)");
    assert.match(String(poolValueV3(v2(5, USDC, 6, 1_000_000_000_000n, 301n, E18), BASE.gecko, ref).why), /more than 3× away/);
    assert.strictEqual(poolValueV3(ok, BASE.gecko, 300_000_000n).eligible, true, "a third of the reference: kept");
    assert.match(String(poolValueV3(ok, BASE.gecko, 300_000_001n).why), /more than 3× away/);
  });

  await test("the on-chain market: reserve-weighted spot, half the reserves as liquidity, the deepest pool prices, the source recorded; none eligible throws without the D-21 words", () => {
    const ref = 100_000_000n;
    const reads = [
      v2(1, USDC, 6, 1_000_000_000_000n, 100n, E18), // $1e-10, $200
      v2(2, WETH, 18, 5_000_000_000_000n, 1n, 550n * E18), // $1.1e-10, $550 + $550
      v2(3, JUNK, 18, 1n, 1_000_000n, E18), // junk quote
      v2(4, USDC, 6, 1_000_000_000_000n, 500n, E18), // $5e-10: more than 3× off
    ];
    const m = onChainMarketOfV3(BASE, reads, { refE18: ref, topPool: addr(2), poolCreatedAt: 1_700_000_000 }, 123_456);
    assert.deepStrictEqual(m.pools, [{ address: addr(2), reserveUsd: 1100 }, { address: addr(1), reserveUsd: 200 }], "eligible only, deepest first");
    assert.strictEqual(m.topPool, addr(2));
    assert.strictEqual(m.liquidityUsd, 650);
    assert.strictEqual(m.spotUsd, Number((110_000_000n * 1100n + 100_000_000n * 200n) / 1300n) / 1e18);
    assert.strictEqual(m.refUsd, 1e-10);
    assert.strictEqual(m.poolCreatedAt, 1_700_000_000, "the same price pool as the prior: its creation time carried");
    assert.strictEqual(onChainMarketOfV3(BASE, reads, { refE18: ref, topPool: addr(1), poolCreatedAt: 1 }, 1).poolCreatedAt, null);
    assert.deepStrictEqual(m.quote, { address: WETH, usd: 550, feeBps: 30 });
    assert.strictEqual(m.source, `${ONCHAIN_SOURCE_PREFIX} reserve-weighted spot of 2 eligible pools at block 123456 (GeckoTerminal unavailable)`);
    assert(isOnChainSourceV3(m.source) && !isOnChainSourceV3("reserve-weighted spot of 2 eligible pools"));
    // the record the run writes (flow-v3 marketV3) keeps the GeckoTerminal shape: spot, reference, pools
    const rec = marketV3(m);
    assert.deepStrictEqual(rec.pools.map((p) => p.address), [addr(2), addr(1)]);
    let err = "";
    try {
      onChainMarketOfV3(BASE, [reads[2], reads[3]], { refE18: ref, topPool: null, poolCreatedAt: null }, 9);
    } catch (e) {
      err = String(e);
    }
    assert.match(err, /no eligible on-chain pool for Base at block 9/);
    assert.strictEqual(isNoMarketErrorV3(err), false, "never read as GeckoTerminal's 'no market' answer (D-21 unchanged)");
  });

  await test("the prior: pools from the newest valued record, the engine's reference from the newest record (valued or skipped)", () => {
    const rec = (o: Record<string, unknown>) => ({ chainId: 8453, name: "Base", skipped: false, xenUsdE18: "100", refInputs: ["90", "110", "95", "500"], market: { pools: [{ address: addr(1) }, { address: "v4-pool-id" }, { address: addr(2) }] }, poolCreatedAt: 77, ...o });
    const file = (epoch: number, chains: unknown[], o: Record<string, unknown> = {}) => ({ version: 3, epoch, publish: { tx: "t" }, chains, ...o });
    const files = [
      file(5, [rec({})]),
      file(6, [rec({ skipped: true, market: null, xenUsdE18: "0", refInputs: ["100", "90", "110"] })]),
      file(7, [rec({ xenUsdE18: "999" })], { publish: undefined }), // not published: ignored
      { version: 2, epoch: 8, publish: { tx: "t" }, chains: [{ chainId: 8453 }] }, // v2: ignored
    ];
    const p = onChainPriorOfV3(files, 8453)!;
    assert.deepStrictEqual(p, { epoch: 5, refE18: 100n, pools: [addr(1), addr(2)], topPool: addr(1), poolCreatedAt: 77 }, "median of [0, 100, 90, 110] without the 0; 20-byte pools only");
    assert.strictEqual(onChainPriorOfV3(files, 10), null, "no record of the chain");
    assert.strictEqual(onChainPriorOfV3([file(5, [rec({ xenUsdE18: "0", refInputs: [] })])], 8453), null, "no reference");
    assert.strictEqual(onChainPriorOfV3([file(5, [rec({ market: { pools: [{ address: "x" }] } })])], 8453), null, "no readable pool");
    const many = file(5, [rec({ market: { pools: Array.from({ length: 12 }, (_, i) => ({ address: addr(i + 1) })) } })]);
    assert.strictEqual(onChainPriorOfV3([many], 8453)!.pools.length, ONCHAIN_MAX_POOLS);
  });

  const onChainMarket = (block: number): OnChainMarketV3 => onChainMarketOfV3(BASE, [v2(1, USDC, 6, 1_000_000_000_000n, 100n, E18)], { refE18: 100_000_000n, topPool: null, poolCreatedAt: null }, block);
  const prior: OnChainPriorV3 = { epoch: 5, refE18: 100_000_000n, pools: [addr(1)], topPool: addr(1), poolCreatedAt: null };

  await test("GeckoTerminal first; the on-chain market only when it fails; when both fail, GeckoTerminal's error (D-21 classification unchanged)", async () => {
    const gecko = { refUsd: 1, spotUsd: 1, liquidityUsd: 1, topPool: "g", xenIsBase: true, pools: [], poolCreatedAt: null, quote: { address: WETH, usd: 1, feeBps: 30 } };
    const logs: string[] = [];
    let asked = 0;
    const o = (g: () => Promise<any>, p: typeof prior | null, head: number | undefined, oc?: () => Promise<OnChainMarketV3>) => ({
      gecko: g, prior: () => p, head: () => head, log: (m: string) => logs.push(m),
      onChain: async (_p: typeof prior, b: number) => {
        asked++;
        return oc ? oc() : onChainMarket(b);
      },
    });
    assert.strictEqual(await xenMarketWithFallbackV3(BASE, o(async () => gecko, prior, 10)), gecko);
    assert.strictEqual(asked, 0, "never read on-chain while GeckoTerminal answers");
    const m = (await xenMarketWithFallbackV3(BASE, o(async () => { throw new Error("https://api.geckoterminal.com/x -> unavailable"); }, prior, 4_242))) as OnChainMarketV3;
    assert.strictEqual(m.block, 4_242, "read at the chain's toBlock");
    assert(isOnChainSourceV3(m.source));
    assert.match(logs.join(" "), /Base: GeckoTerminal failed .*unavailable.*priced from on-chain reserves of 1 pool\(s\) at block 4242/);
    // no prior, no head, or the on-chain read fails: GeckoTerminal's error first, so the skip is classified as before
    const noMkt = async () => { throw new Error("no XEN market found for Base"); };
    const down = async () => { throw new Error("https://api.geckoterminal.com/x -> HTTP 404"); };
    for (const [g, p, h, oc, re] of [
      [noMkt, null, 1, undefined, /^Error: no XEN market found for Base; on-chain fallback: no published v3 record/],
      [down, prior, undefined, undefined, /^Error: .*HTTP 404; on-chain fallback: the chain's final block was not read/],
      [down, prior, 1, async () => { throw new Error("no eligible on-chain pool for Base at block 1"); }, /HTTP 404; on-chain fallback: no eligible on-chain pool/],
    ] as const) {
      let e = "";
      try {
        await xenMarketWithFallbackV3(BASE, o(g, p, h, oc));
      } catch (x) {
        e = String(x);
      }
      assert.match(e, re);
      assert.strictEqual(isNoMarketErrorV3(e), g === noMkt, `D-21 reads the same answer as before: ${e}`);
    }
  });

  await test("the live sources: a chain GeckoTerminal cannot price is priced on-chain at its final head, and reads no GeckoTerminal candle", async () => {
    const was = GT_BREAKER.failures;
    GT_BREAKER.failures = GT_BREAKER_LIMIT; // GeckoTerminal "down" for this process: nothing is fetched
    try {
      let seen: { block: number; pools: string[] } | null = null;
      const s = liveSourcesV3({} as never, programV3({} as never), {
        finalHead: async () => 777,
        priorOf: (id) => (id === 8453 ? prior : null),
        onChain: async (_c, p, block) => {
          seen = { block, pools: p.pools };
          return onChainMarket(block);
        },
      });
      assert.strictEqual(await s.finalHead(BASE), 777);
      const m = await s.market(BASE);
      assert.deepStrictEqual(seen, { block: 777, pools: [addr(1)] });
      assert(isOnChainSourceV3((m as OnChainMarketV3).source));
      assert.strictEqual(await s.xenCloses(BASE, m, 1_800_000_000), null, "no candle: every burn takes the build spot under the cap");
      assert.strictEqual(s.market(BASE), s.market(BASE), "read once per run");
      // another chain without a prior stays skipped with GeckoTerminal's error
      const op = CHAINS.find((c) => c.chainId === 10)!;
      await s.finalHead(op);
      await assert.rejects(s.market(op), /not asked: GeckoTerminal failed 3 requests in a row in this run; on-chain fallback: no published v3 record/);
    } finally {
      GT_BREAKER.failures = was;
    }
  });

  await test("the engine prices such burns by its existing fallback rule: the build spot, never above 1.25 × the reference", () => {
    const ref = 100_000_000n;
    const cap = (ref * PRICE_CAP_BPS) / 10_000n;
    assert.deepStrictEqual(xenPrice(null, 110_000_000n, cap), { priceE18: 110_000_000n, rule: "spot" });
    assert.deepStrictEqual(xenPrice(null, 300_000_000n, cap), { priceE18: 125_000_000n, rule: "cap" }, "a pumped pool pays no more than the cap");
  });

  await test("getJsonV3: each request has a time limit; after 3 failed requests in a row GeckoTerminal is not asked again in this run; a success resets", async () => {
    const breaker = { failures: 0 };
    let calls = 0;
    let signal: unknown = null;
    const fail = (async (_u: string, init?: { signal?: unknown }) => {
      calls++;
      signal = init?.signal ?? null;
      return { ok: false, status: 404, headers: { get: () => null } };
    }) as unknown as typeof fetch;
    for (let i = 0; i < GT_BREAKER_LIMIT; i++) await assert.rejects(getJsonV3("https://example.invalid/a", fail, async () => {}, breaker), /HTTP 404/);
    assert(signal instanceof AbortSignal, "a time limit on every request");
    assert.strictEqual(GT_TIMEOUT_MS, 30_000);
    assert.strictEqual(breaker.failures, 3);
    await assert.rejects(getJsonV3("https://example.invalid/b", fail, async () => {}, breaker), /not asked: GeckoTerminal failed 3 requests in a row/);
    assert.strictEqual(calls, 3, "the 4th request is not sent");
    const fresh = { failures: 2 };
    assert.deepStrictEqual(await getJsonV3("https://example.invalid/c", (async () => ({ ok: true, status: 200, json: async () => ({ ok: 1 }) })) as unknown as typeof fetch, async () => {}, fresh), { ok: 1 });
    assert.strictEqual(fresh.failures, 0);
  });

  await test("verify --full: the same pools re-read at the same block must give the recorded market", () => {
    const m = onChainMarket(555);
    const market = marketV3(m);
    const rec = { name: "Base", market: { ...market, priceSource: m.source }, L: { now: BigInt(Math.floor(m.liquidityUsd * 1e6)).toString() } };
    assert.deepStrictEqual(onChainMarketMismatchV3(rec, m), []);
    assert.match(onChainMarketMismatchV3({ ...rec, market: { ...rec.market, spotE18: "1" } }, m).join(" "), /on-chain spot 1, the re-read gives/);
    assert.match(onChainMarketMismatchV3({ ...rec, L: { now: "1" } }, m).join(" "), /liquidity now 1/);
    assert.match(onChainMarketMismatchV3(rec, onChainMarket(556)).join(" "), /price source/);
    assert.match(onChainMarketMismatchV3({ ...rec, market: { ...rec.market, pools: [] } }, m).join(" "), /eligible pools/);
    void Keypair;
  });

  await test("health 'XEN price sources': ok on GeckoTerminal, warn on the on-chain fallback or a fresh outage, red only after 2 weekly runs without any source", () => {
    const sun = Date.UTC(2026, 10, 1) / 1000; // Sunday 2026-11-01 00:00 UTC
    assert.strictEqual(weeklyRunsBetween(sun - 1, sun), 1);
    assert.strictEqual(weeklyRunsBetween(sun, sun + 6 * 86_400), 0);
    assert.strictEqual(weeklyRunsBetween(sun - 1, sun + 7 * 86_400), 2);
    const p = (source: XenPriceProbe["source"], chainId = 56): XenPriceProbe => ({ chainId, chain: chainId === 56 ? "BSC" : "Base", source, detail: source === "none" ? "GeckoTerminal: down; on-chain: no eligible pool" : "" });
    assert.strictEqual(xenPriceVerdict([p("gecko"), p("gecko", 8453)], {}, sun).state, "ok");
    const fb = xenPriceVerdict([p("on-chain"), p("gecko", 8453)], {}, sun);
    assert.strictEqual(fb.state, "warn");
    assert.match(fb.detail, /BSC: on-chain pools only/);
    assert.strictEqual(xenPriceVerdict([p("gecko")], {}, sun, ["BSC"]).state, "warn", "the newest epoch used the fallback");
    // no source: warn first, red once 2 weekly runs passed with none
    const t0 = sun + 3_600;
    let h = xenPriceHistoryNext({}, [p("none")], t0);
    assert.deepStrictEqual(h, { 56: { noneSince: t0 } });
    assert.strictEqual(xenPriceVerdict([p("none")], h, t0).state, "warn");
    h = xenPriceHistoryNext(h, [p("none")], t0 + 7 * 86_400);
    assert.strictEqual(h["56"].noneSince, t0, "carried");
    assert.strictEqual(xenPriceVerdict([p("none")], h, t0 + 7 * 86_400).state, "warn", "one weekly run without a source");
    const red = xenPriceVerdict([p("none")], h, t0 + 14 * 86_400);
    assert.strictEqual(red.state, "fail", "two weekly runs");
    assert.match(red.detail, /no source for BSC through 2 weekly runs: its burns wait/);
    assert.deepStrictEqual(xenPriceHistoryNext(h, [p("on-chain")], t0 + 15 * 86_400), { 56: { noneSince: null } }, "a source again: cleared");
    assert.strictEqual(xenPriceVerdict([], {}, sun).state, "ok");
  });

  console.log(`xen on-chain tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
