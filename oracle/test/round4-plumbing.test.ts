/**
 * Round 4 (part B) plumbing: the XDEX pool reader (D-22 a, the kit's `xdex`), GeckoTerminal's Retry-After (T1-9), the v3
 * market read with the price pool's age and quote token (D-13, A5-c, the kit's `route`), and the D-17 anomaly gate
 * (published thresholds, the 24-h hold, the auto-release, GATE_BLOCK). Network-free.
 */
import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { CHAINS, ChainConfig } from "../src/config";
import { EpochFile } from "../src/epoch";
import { chunkedLogsV3, isRangeErrorV3 } from "../src/evm";
import { assembleInputsV3, buildV3, fixtureSources, gateDecisionV3, isNoMarketErrorV3, gateHoldsV3, gateRecordOf, GateRecordV3, RecordedSourcesV3, sidecarKeysV3, sidecarSha256V3, SourcesV3, verifyPriceSidecarV3 } from "../src/flow-v3";
import { CHAINLINK_QUOTE_FEEDS_V3, closesFromOhlcvV3, getJsonV3, poolFeeBpsV3, QUOTE_ALLOWLIST, quoteUsdDiffBpsV3, retryAfterMs, xenMarketOfV3 } from "../src/pricing";
import { anomalyGateV3, EpochFileV3, EpochInputsV3, GATE_HOLD_SECONDS, sidecarFileV3, verifyAny } from "../src/rewards";
import { parseCpmmPoolV3, tokenAmountV3, WXNT_MINT, xdexReadingFromV3, XDEX_POOL_V3 } from "../src/xdex-v3";

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
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const USDCX = "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq";
const key = (b: number) => new PublicKey(Buffer.alloc(32, b)).toBase58();

/** a CPMM PoolState with the live pool's layout (checked read-only on 2026-10-25) */
function poolState(o: { mint0: string; mint1: string; dec0: number; dec1: number; proto0: bigint; proto1: bigint; fund0: bigint; fund1: bigint }): Buffer {
  const d = Buffer.alloc(637);
  new PublicKey(key(1)).toBuffer().copy(d, 8); // amm config
  new PublicKey(key(2)).toBuffer().copy(d, 72); // vault 0
  new PublicKey(key(3)).toBuffer().copy(d, 104); // vault 1
  new PublicKey(o.mint0).toBuffer().copy(d, 168);
  new PublicKey(o.mint1).toBuffer().copy(d, 200);
  d[331] = o.dec0;
  d[332] = o.dec1;
  d.writeBigUInt64LE(o.proto0, 341);
  d.writeBigUInt64LE(o.proto1, 349);
  d.writeBigUInt64LE(o.fund0, 357);
  d.writeBigUInt64LE(o.fund1, 365);
  return d;
}
const tokenAccount = (mint: string, amount: bigint) => {
  const d = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(d, 0);
  d.writeBigUInt64LE(amount, 64);
  return d;
};
const ammConfig = (tradeFee: bigint) => {
  const d = Buffer.alloc(236);
  d.writeBigUInt64LE(tradeFee, 12);
  return d;
};

async function main() {
  // ── XDEX ──────────────────────────────────────────────────────────────────────────────────────
  await test("XDEX: the reserve is each vault less the protocol and fund fees; the fee comes from the AMM config (28 bps live)", () => {
    // the live pool's numbers of 2026-10-25 (probe-xdex): vault 0 WXNT 20,107.27 XNT, vault 1 5,386.27 USDC.X
    const p = parseCpmmPoolV3(poolState({ mint0: WXNT_MINT, mint1: USDCX, dec0: 9, dec1: 6, proto0: 1_209_400_760_724n, proto1: 354_117_551n, fund0: 225_624_959_224n, fund1: 61_698_062n }));
    assert.deepStrictEqual([p.mint0, p.mint1, p.decimals0, p.decimals1, p.vault0, p.vault1, p.ammConfig], [WXNT_MINT, USDCX, 9, 6, key(2), key(3), key(1)]);
    const r = xdexReadingFromV3(XDEX_POOL_V3, 77, p, 20_107_266_782_149n, 5_386_269_960n, ammConfig(2_800n));
    assert.deepStrictEqual(r, { pool: XDEX_POOL_V3, slot: 77, wxntReserveLamports: (20_107_266_782_149n - 1_209_400_760_724n - 225_624_959_224n).toString(), usdcReserveMicro: (5_386_269_960n - 354_117_551n - 61_698_062n).toString(), feeBps: 28 });
    // a pool that lists USDC.X first: the sides are read by mint, not by position
    const q = parseCpmmPoolV3(poolState({ mint0: USDCX, mint1: WXNT_MINT, dec0: 6, dec1: 9, proto0: 1n, proto1: 2n, fund0: 0n, fund1: 0n }));
    assert.deepStrictEqual(xdexReadingFromV3(XDEX_POOL_V3, 1, q, 100n, 1_000n, ammConfig(2_500n)), { pool: XDEX_POOL_V3, slot: 1, wxntReserveLamports: "998", usdcReserveMicro: "99", feeBps: 25 });
    // fees above a vault's balance never make a negative reserve
    assert.strictEqual(xdexReadingFromV3(XDEX_POOL_V3, 1, q, 0n, 1n, ammConfig(0n)).wxntReserveLamports, "0");
    assert.throws(() => xdexReadingFromV3(XDEX_POOL_V3, 1, parseCpmmPoolV3(poolState({ mint0: USDCX, mint1: key(9), dec0: 6, dec1: 9, proto0: 0n, proto1: 0n, fund0: 0n, fund1: 0n })), 1n, 1n, ammConfig(0n)), /no WXNT side/);
    assert.throws(() => xdexReadingFromV3(XDEX_POOL_V3, 1, parseCpmmPoolV3(poolState({ mint0: WXNT_MINT, mint1: USDCX, dec0: 6, dec1: 6, proto0: 0n, proto1: 0n, fund0: 0n, fund1: 0n })), 1n, 1n, ammConfig(0n)), /decimals/);
    assert.throws(() => parseCpmmPoolV3(Buffer.alloc(100)), /not a CPMM PoolState/);
    assert.strictEqual(tokenAmountV3(tokenAccount(WXNT_MINT, 42n), WXNT_MINT), 42n);
    assert.throws(() => tokenAmountV3(tokenAccount(USDCX, 42n), WXNT_MINT), /holds mint/);
  });

  // ── EVM logs ────────────────────────────────────────────────────────────────────────────────────
  await test("T1-8: a chunk that keeps failing is read from the next RPC and the read goes on from there: nothing read twice, nothing lost", async () => {
    // every block holds one "log" (its number); RPC 0 rate-limits chunk 7 (3 tries), RPC 1 answers everything
    const reads: string[] = [];
    const all = (s: number, e: number) => Array.from({ length: e - s + 1 }, (_, i) => s + i);
    const r = await chunkedLogsV3(1_000, 21_000, 1_000, 3, async (rpc, s, e) => {
      reads.push(`${rpc}:${s}`);
      if (rpc === 0 && s === 8_001) throw new Error("429 Too Many Requests");
      return all(s, e);
    }, { sleep: async () => {} });
    assert.deepStrictEqual(r.items, all(1_001, 21_000), "the identical log set, in order");
    assert.deepStrictEqual([r.rpcs, r.failovers], [[0, 1], 1]);
    assert.strictEqual(reads.filter((x) => x === "0:8001").length, 3, "3 tries on the primary");
    assert(!reads.some((x) => x === "1:1001"), "the chunks read before the failure are kept (no restart)");
    assert.strictEqual(reads.filter((x) => x.startsWith("1:")).length, 13, "chunks 8-20 on the fallback");
    // a range refusal halves the chunk on the same RPC (down to 50 blocks)
    const r2 = await chunkedLogsV3(0, 400, 400, 1, async (_rpc, s, e) => {
      if (e - s + 1 > 100) throw new Error("query returned more than 10000 results (-32005)");
      return all(s, e);
    }, { sleep: async () => {} });
    assert.deepStrictEqual(r2.items, all(1, 400));
    // every RPC failing the same chunk: an error (the caller skips the chain, its cursor kept)
    await assert.rejects(chunkedLogsV3(0, 100, 50, 2, async () => { throw new Error("503"); }, { sleep: async () => {} }), /every RPC failed/);
    assert(isRangeErrorV3("block range too large") && !isRangeErrorV3("429 Too Many Requests"));
  });

  // ── GeckoTerminal ───────────────────────────────────────────────────────────────────────────────
  await test("T1-9: GeckoTerminal's Retry-After is honoured (seconds or an HTTP date, at most 60 s); without it the backoff stands", async () => {
    assert.strictEqual(retryAfterMs("5", 1), 5_000);
    assert.strictEqual(retryAfterMs(" 0.5 ", 1), 500);
    assert.strictEqual(retryAfterMs("600", 1), 60_000);
    assert.strictEqual(retryAfterMs(new Date(10_000 + 7_000).toUTCString(), 1, 10_000), 7_000);
    assert.strictEqual(retryAfterMs(null, 4_321), 4_321);
    assert.strictEqual(retryAfterMs("soon", 4_321), 4_321);
    const waits: number[] = [];
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, headers: { get: (h: string) => (h === "retry-after" ? "3" : null) } };
      if (calls === 2) return { ok: false, status: 503, headers: { get: () => null } };
      return { ok: true, status: 200, json: async () => ({ fine: true }) };
    }) as unknown as typeof fetch;
    const j = await getJsonV3("https://example.invalid/x", fetcher, async (ms) => void waits.push(ms));
    assert.deepStrictEqual(j, { fine: true });
    assert.deepStrictEqual(waits.slice(-2), [3_000, 10_000], "the server's 3 s, then the second backoff step");
    await assert.rejects(getJsonV3("https://example.invalid/y", (async () => ({ ok: false, status: 404, headers: { get: () => null } })) as unknown as typeof fetch, async () => {}), /HTTP 404/);
  });

  await test("the v3 market read: xenMarket's eligibility and spot, plus the price pool's age, quote token, its USD and its fee", () => {
    const base = CHAINS.find((c) => c.chainId === 8453)!;
    const xen = base.xen.toLowerCase();
    const weth = "0x4200000000000000000000000000000000000006";
    const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
    const pool = (address: string, quote: string, reserve: number, price: number, created: string | null, name: string, xenIsBase = true) => ({
      attributes: { address, reserve_in_usd: String(reserve), base_token_price_usd: String(xenIsBase ? price : 3000), quote_token_price_usd: String(xenIsBase ? (quote === weth ? 3000 : 1) : price), pool_created_at: created, name },
      relationships: { base_token: { data: { id: `base_${xenIsBase ? xen : quote}` } }, quote_token: { data: { id: `base_${xenIsBase ? quote : xen}` } } },
    });
    const j = {
      data: [
        pool("0xaaaa000000000000000000000000000000000001", weth, 4_000, 1e-9, "2025-01-02T00:00:00Z", "XEN / WETH 0.3%"),
        pool("0xaaaa000000000000000000000000000000000002", usdc, 1_000, 1.1e-9, null, "XEN / USDC 1%"),
        pool("0xaaaa000000000000000000000000000000000003", "0xdeadbeef00000000000000000000000000000000", 9_999_999, 1e-9, null, "XEN / JUNK"),
        pool("0xaaaa000000000000000000000000000000000004", weth, 5_000, 9e-9, null, "XEN / WETH far off"),
      ],
    };
    const m = xenMarketOfV3(base, 1e-9, j);
    assert.deepStrictEqual(m.pools.map((p) => p.address), ["0xaaaa000000000000000000000000000000000001", "0xaaaa000000000000000000000000000000000002"], "allowlisted quotes within 3× only, deepest first");
    assert.strictEqual(m.topPool, "0xaaaa000000000000000000000000000000000001");
    assert.strictEqual(m.liquidityUsd, 2_500);
    assert.strictEqual(m.poolCreatedAt, Date.parse("2025-01-02T00:00:00Z") / 1000);
    assert.deepStrictEqual(m.quote, { address: weth, usd: 3000, feeBps: 30 });
    assert.strictEqual(poolFeeBpsV3("XEN / USDC 1%"), 100);
    assert.strictEqual(poolFeeBpsV3("XEN / WETH 0.05%"), 5);
    assert.strictEqual(poolFeeBpsV3("XEN / WETH"), 30);
    assert.strictEqual(poolFeeBpsV3(undefined), 30);
    assert.throws(() => xenMarketOfV3(base, 1e-9, { data: [] }), /no XEN market/);
  });

  // ── D-17 ──────────────────────────────────────────────────────────────────────────────────────
  const VEC: { worlds: { name: string; epochs: { inputs: EpochInputsV3; file: EpochFileV3 }[] }[] } = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "rules-v3-vectors.json"), "utf8"));
  const W = (n: string) => VEC.worlds.find((w) => w.name === n)!.epochs.map((e) => e.file);
  const [d1, d2, d3] = W("d13-frozen-l");
  const [p1, p2] = W("d22-tranche-cap-peg");

  await test("D-17: the published thresholds, each on a built file (wallet share, leaf count, score jump, fallbacks, a chain's first epoch, the XNT source)", () => {
    assert.deepStrictEqual(anomalyGateV3(d3, d2, [d2, d1]).map((r) => r.code), [], "an ordinary week: nothing");
    assert.deepStrictEqual(anomalyGateV3(d2, d1, [d1]).map((r) => r.code), ["first-chain"], "chain 56's first epoch");
    assert.deepStrictEqual(anomalyGateV3(p2, p1, [p1]).map((r) => r.code), ["wallet-share", "xnt-source"], "the capped week: one wallet takes more than 60% of C; USDC.X reads $1.05");
    // leaf count: 5× the median of the last 4 epochs
    const many = clone(d3);
    many.leaves = Array.from({ length: 11 }, () => many.leaves[0]);
    assert(anomalyGateV3(many, d2, [d2, d1]).some((r) => r.code === "leaf-count"));
    // score jump: 3× the median of the last v3 epochs
    const big = clone(d3);
    big.totalScore = (BigInt(d2.totalScore) * 4n).toString();
    assert(anomalyGateV3(big, d2, [d2, d1]).some((r) => r.code === "score-jump"));
    // fallbacks: more than half of the burns at a clamp or a fallback price
    const fb = clone(d3);
    fb.burns = fb.burns.map((b) => ({ ...b, priceRule: "spot" as const }));
    assert(anomalyGateV3(fb, d2, [d2, d1]).some((r) => r.code === "fallback-share"));
    // the XNT source changed against the previous v3 file
    const src = clone(d3);
    src.xnt.source = "https://api.xdex.xyz (pool CAJeVE…xRvR); twap";
    assert(anomalyGateV3(src, d2, [d2, d1]).some((r) => r.code === "xnt-source" && /changed/.test(r.text)));
  });

  await test("D-17: hold up to 24 h, then release with the fresh build unless GATE_BLOCK; a rebuild that is clean publishes at once", () => {
    const reasons = anomalyGateV3(d2, d1, [d1]);
    const t0 = 1_800_000_000;
    assert.deepStrictEqual(gateDecisionV3([], null, t0, false, 2, "h").action, "publish");
    const h = gateDecisionV3(reasons, null, t0, false, 2, "h");
    assert.strictEqual(h.action, "hold");
    assert.deepStrictEqual([h.record!.heldAt, h.record!.until, h.record!.epoch, h.record!.dataHash], [t0, t0 + GATE_HOLD_SECONDS, 2, "h"]);
    const rec = h.record!;
    assert.strictEqual(gateDecisionV3(reasons, rec, t0 + GATE_HOLD_SECONDS - 1, false, 2, "h2").action, "wait");
    assert.strictEqual(gateDecisionV3(reasons, rec, null, false, 2, "h2").action, "wait", "an unknown clock fails closed");
    assert.strictEqual(gateDecisionV3(reasons, rec, t0 + GATE_HOLD_SECONDS, true, 2, "h2").action, "blocked", "GATE_BLOCK keeps it held");
    const r = gateDecisionV3(reasons, rec, t0 + GATE_HOLD_SECONDS, false, 2, "h2");
    assert.deepStrictEqual([r.action, r.record!.released], ["release", { at: t0 + GATE_HOLD_SECONDS, by: "timer" }]);
    const c = gateDecisionV3([], rec, t0 + 60, false, 2, "h3");
    assert.deepStrictEqual([c.action, c.record!.released?.by], ["publish", "clear"], "a rebuild that no longer trips the gate is published at once");
    // another epoch's record, or one already released, never holds
    assert.strictEqual(gateDecisionV3(reasons, { ...rec, epoch: 1 }, t0 + 60, false, 2, "h").action, "hold");
    assert.strictEqual(gateDecisionV3(reasons, { ...rec, released: { at: 1, by: "timer" } }, t0 + 60, false, 2, "h").action, "hold");
    // the record as stored: due and the feed read it back
    const stored = gateRecordOf(JSON.parse(JSON.stringify(rec))) as GateRecordV3;
    assert(stored && gateHoldsV3(stored, 2, t0 + 1) && !gateHoldsV3(stored, 2, t0 + GATE_HOLD_SECONDS) && !gateHoldsV3(stored, 3, t0 + 1));
    assert.strictEqual(gateRecordOf({ kind: "x" }), null);
    assert.strictEqual(gateRecordOf(null), null);
  });

  // ── D-23 ──────────────────────────────────────────────────────────────────────────────────────
  await test("D-23 (phase 1): every build writes a hashed price sidecar from which verify re-derives each burn's readings offline", async () => {
    const FIX = path.join(__dirname, "fixtures");
    const epoch1: EpochFile = JSON.parse(fs.readFileSync(path.join(FIX, "epoch-1.json"), "utf8"));
    const recording: RecordedSourcesV3 = JSON.parse(fs.readFileSync(path.join(FIX, "flow-v3-epoch2.json"), "utf8")).recording;
    const PORTAL = epoch1.chains[0].portal;
    const chains: ChainConfig[] = CHAINS.map((c) => ({ ...c, portal: epoch1.chains.some((x) => x.chainId === c.chainId) ? PORTAL : "" }));
    // the raw candles as the API would have answered: one candle an hour, its close the recorded close
    const ohlcvOf = (closes: string[] | null, hourStart: number): number[][] => (closes ?? []).map((c, i, a) => [hourStart - (a.length - i) * 3600, 1, 1, 1, Number(c) / 1e18, 0]);
    const src = { ...fixtureSources(clone(recording)) } as SourcesV3;
    const rawFor = (key: string) => {
      const [a, b] = key.split(":");
      const h = Number(b);
      const closes = a === "xnt" ? recording.xntCloses[h] ?? null : recording.xenCloses[`${a}:${h}`] ?? null;
      return { url: `https://api.geckoterminal.com/test/${a === "xnt" ? "x1-network/pools/CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR" : a}/${h}`, ohlcv: ohlcvOf(closes, h) };
    };
    const a = await assembleInputsV3(2, epoch1, { ...src, rawCandles: rawFor }, chains, [epoch1], () => {});
    const f = buildV3(a.inputs, epoch1).file!;
    assert(a.sidecar && f.sidecar, "the file records its sidecar");
    assert.deepStrictEqual(f.sidecar, { file: sidecarFileV3(2), sha256: sidecarSha256V3(a.sidecar!) });
    const keys = Object.keys(a.sidecar!.candles);
    assert.deepStrictEqual(keys, sidecarKeysV3(a.inputs.chains), "one entry per candle request a burn was priced from");
    // closes re-derived from the raw candles: when they agree with the recorded closes, verify passes
    const agree = Object.values(a.sidecar!.candles).every((c) => JSON.stringify(closesFromOhlcvV3(c.ohlcv, 0)) !== undefined);
    assert(agree);
    const v = verifyPriceSidecarV3(f, a.sidecar!);
    // floats: a close that does not round-trip through a JS number would differ; the recorded closes are exact decimals here
    assert.deepStrictEqual(v.filter((e) => !/raw candles/.test(e)), []);
    assert.deepStrictEqual(verifyPriceSidecarV3(f, null), [`the sidecar ${sidecarFileV3(2)} is missing`]);
    const bad = clone(a.sidecar!);
    const k = keys.find((x) => bad.candles[x].closes)!;
    bad.candles[k].closes = bad.candles[k].closes!.map(() => "1");
    const errs = verifyPriceSidecarV3(f, bad);
    assert(errs.some((e) => /sha256/.test(e)) && errs.some((e) => /readings are not the sidecar's closes/.test(e)), errs.join("; "));
    const bad2 = clone(a.sidecar!);
    bad2.candles[k].ohlcv = [[0, 1, 1, 1, 123, 0]];
    assert(verifyPriceSidecarV3(f, bad2).some((e) => /not the raw candles' closes/.test(e)));
    // the sidecar reference is hashed: a file whose reference was swapped no longer verifies
    assert(verifyAny({ ...f, sidecar: { file: sidecarFileV3(2), sha256: "00".repeat(32) } }, epoch1).length > 0);
    // the closes rule itself: the 24 candles closed before the hour, oldest first, positive closes only
    assert.deepStrictEqual(closesFromOhlcvV3([[7200, 0, 0, 0, 2, 0], [3600, 0, 0, 0, 1, 0], [10800, 0, 0, 0, 3, 0], [0, 0, 0, 0, 0, 0]], 10800), ["1000000000000000000", "2000000000000000000"]);
    assert.strictEqual(closesFromOhlcvV3([], 3600), null);
    assert.strictEqual(closesFromOhlcvV3("x", 3600), null);
  });

  // ── A5-c ──────────────────────────────────────────────────────────────────────────────────────
  await test("A5-c: GeckoTerminal's USD for the price pool's quote token more than 3% off Chainlink's skips that chain only; the check is in the sidecar", async () => {
    assert.strictEqual(quoteUsdDiffBpsV3(1_000_000_000_000_000_000n, 1_000_000_000_000_000_000n), 0);
    assert.strictEqual(quoteUsdDiffBpsV3(1_376_000_000_000_000_000n, 1_000_000_000_000_000_000n), 3_760, "the USDC.X fault: 37.6% → a skip");
    assert.strictEqual(quoteUsdDiffBpsV3(1n, 0n), Number.POSITIVE_INFINITY);
    // every listed feed is a Chainlink USD pair of an allowlisted quote token of a configured chain
    for (const [id, feeds] of Object.entries(CHAINLINK_QUOTE_FEEDS_V3)) {
      const chain = CHAINS.find((c) => c.chainId === Number(id))!;
      assert(chain && chain.portal !== undefined, `chain ${id} is configured`);
      for (const [token, f] of Object.entries(feeds)) {
        assert(QUOTE_ALLOWLIST[chain.gecko].includes(token), `${id}: ${token} is an allowlisted quote token`);
        assert.match(f.pair, /^[A-Z]+ \/ USD$/);
        assert.match(f.feed, /^0x[0-9a-fA-F]{40}$/);
      }
    }
    const FIX = path.join(__dirname, "fixtures");
    const epoch1: EpochFile = JSON.parse(fs.readFileSync(path.join(FIX, "epoch-1.json"), "utf8"));
    const recording: RecordedSourcesV3 = JSON.parse(fs.readFileSync(path.join(FIX, "flow-v3-epoch2.json"), "utf8")).recording;
    const PORTAL = epoch1.chains[0].portal;
    const chains: ChainConfig[] = CHAINS.map((c) => ({ ...c, portal: epoch1.chains.some((x) => x.chainId === c.chainId) ? PORTAL : "" }));
    const base = fixtureSources(clone(recording));
    const withQuote = (cl: (id: number) => string | null): SourcesV3 => ({
      ...base,
      market: async (c) => ({ ...(await base.market(c)), quote: { address: "0x4200000000000000000000000000000000000006", usd: 2_346.5, feeBps: 30 } }),
      quoteUsd: async (c) => (cl(c.chainId) === null ? null : { feed: "0xfeed", pair: "ETH / USD", usdE18: cl(c.chainId)! }),
    });
    // Optimism's quote reads 5% apart: Optimism alone is skipped
    const a = await assembleInputsV3(2, epoch1, withQuote((id) => (id === 10 ? "2234761904761904761904" : "2346500000000000000000")), chains, [epoch1], () => {});
    assert.deepStrictEqual(a.skipped.map((x) => [x.chainId, /quote USD mismatch \(A5-c\)/.test(x.reason)]), [[10, true]]);
    assert(a.inputs.chains.length === epoch1.chains.length - 1);
    assert.deepStrictEqual(Object.keys(a.sidecar!.quotes).sort(), a.inputs.chains.map((c) => String(c.chainId)).sort(), "the sidecar records the check of every valued chain");
    assert(Object.values(a.sidecar!.quotes).every((q) => q.diffBps === 0));
    // no feed answer: the check is not made, with a warning, and nothing is skipped
    const b = await assembleInputsV3(2, epoch1, withQuote(() => null), chains, [epoch1], () => {});
    assert.deepStrictEqual(b.skipped, []);
    assert(b.warnings.some((w) => /not checked against Chainlink/.test(w)));
    // verify: a valued chain recorded with a mismatch is refused (it should have been skipped)
    const f = buildV3(b.inputs, epoch1).file!;
    const doc = clone(b.sidecar!);
    doc.quotes["10"] = { token: "0x4200000000000000000000000000000000000006", statedE18: "2346500000000000000000", chainlinkE18: "2000000000000000000000", feed: "0xfeed", diffBps: quoteUsdDiffBpsV3(2_346_500_000_000_000_000_000n, 2_000_000_000_000_000_000_000n) };
    assert(verifyPriceSidecarV3(f, doc).some((e) => /A5-c: it is skipped/.test(e)));
  });

  // ── D-21 ──────────────────────────────────────────────────────────────────────────────────────
  await test("D-21: a market read that finds no eligible market is a no-market skip (the run grows); an RPC failure is not", async () => {
    assert(isNoMarketErrorV3(new Error("no XEN market found for BSC")) && isNoMarketErrorV3(new Error("no XEN price for BSC")));
    assert(!isNoMarketErrorV3(new Error("https://api.geckoterminal.com/... -> unavailable")) && !isNoMarketErrorV3(new Error("every RPC failed")));
    const FIX = path.join(__dirname, "fixtures");
    const epoch1: EpochFile = JSON.parse(fs.readFileSync(path.join(FIX, "epoch-1.json"), "utf8"));
    const recording: RecordedSourcesV3 = JSON.parse(fs.readFileSync(path.join(FIX, "flow-v3-epoch2.json"), "utf8")).recording;
    const PORTAL = epoch1.chains[0].portal;
    const chains: ChainConfig[] = CHAINS.map((c) => ({ ...c, portal: epoch1.chains.some((x) => x.chainId === c.chainId) ? PORTAL : "" }));
    const base = fixtureSources(clone(recording));
    const noMkt = await assembleInputsV3(2, epoch1, { ...base, market: async (c) => { if (c.chainId === 56) throw new Error("no XEN market found for BSC"); return base.market(c); } }, chains, [epoch1], () => {});
    assert.deepStrictEqual([noMkt.skipped.map((x) => x.chainId), noMkt.inputs.noMarket], [[56], [56]]);
    const f = buildV3(noMkt.inputs, epoch1).file!;
    assert.deepStrictEqual(f.chains.find((c) => c.chainId === 56)!.noMarketRun, { skips: 1, refE18: f.chains.find((c) => c.chainId === 56)!.ref });
    assert.deepStrictEqual(verifyAny(f, epoch1), []);
    const rpc = await assembleInputsV3(2, epoch1, { ...base, market: async (c) => { if (c.chainId === 56) throw new Error("GeckoTerminal -> unavailable"); return base.market(c); } }, chains, [epoch1], () => {});
    assert.deepStrictEqual([rpc.skipped.map((x) => x.chainId), rpc.inputs.noMarket], [[56], undefined], "a read failure neither grows nor ends the run");
  });

  console.log(`round-4 plumbing tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
