#!/usr/bin/env node
// SPEC-UPGRADE-v2 Appendix A vectors computed the way the CLIENTS compute them (plain JS + keccak-256 from
// @noble/hashes, no Rust), written to tests/fixtures/spec-vectors-v2.out.json. The program's unit test
// `vectors::vectors_match_the_clients` reads that file and asserts the on-chain functions give the same values, so a
// drift on either side fails `cargo test`. Off-chain mirrors (oracle extra.ts, keeper, kit, frontend) pin the same file.
// Usage: node tests/spec-vectors-v2.cjs [--check]   (--check: exit 1 if the committed file differs)
const fs = require("fs");
const path = require("path");
const req = (m) => { for (const d of ["tests", "oracle", "agents/kit", "frontend"]) { try { return require(require.resolve(m, { paths: [path.join(__dirname, "..", d)] })); } catch {} } throw new Error(`${m} not found: npm install in tests/`); };
const { keccak_256 } = req("@noble/hashes/sha3");

const XNT = 1_000_000_000n, BPS = 10_000n, DAY = 86_400n;
const k = (...parts) => Buffer.from(keccak_256(Buffer.concat(parts.map((p) => Buffer.from(p)))));
const fill = (b) => Buffer.alloc(32, b);
const le64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const le32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const hex = (b) => Buffer.from(b).toString("hex");

const out = {};
// 1. keeper hash chain: x_len = seed, x_k = keccak(x_{k+1}); x_0 is the armed tip
const chain = [fill(0x0a)];
for (let i = 0; i < 8; i++) chain.unshift(k(chain[0]));
chain.forEach((x, i) => (out[`keeper_chain_x${i}`] = hex(x)));
// 2. anchor_bet mixed seed: keccak("MOONFORGE_ANCHOR" ‖ seed ‖ slot hash)
const mixed = k(Buffer.from("MOONFORGE_ANCHOR"), fill(0x08), fill(0x07));
out.anchor_mixed_seed = hex(mixed);
// 3. v2 roll = random_u64(reveal, bet, mixed) % 10_000, random_u64 = LE u64 of keccak("MOONFORGE_RNG" ‖ a ‖ b ‖ c)[0..8]
const rnd = (a, b, c) => k(Buffer.from("MOONFORGE_RNG"), a, b, c).readBigUInt64LE(0);
out.v2_roll_reveal_x1_bet_07 = (rnd(chain[1], fill(0x07), mixed) % BPS).toString();
// 4. bet_pack(index, anchor) = index << 40 | anchor
out.bet_pack_5_1000000 = ((5n << 40n) | 1_000_000n).toString();
// 5. extra leaf = keccak("MOONFORGE_V3_EXTRA" ‖ epoch u64 LE ‖ index u32 LE ‖ wallet ‖ amount u64 LE)
out.extra_leaf_e7_i3_w02_a123456789 = hex(k(Buffer.from("MOONFORGE_V3_EXTRA"), le64(7), le32(3), fill(0x02), le64(123_456_789)));
// 6. market_split(price) = (5% royalty, 2% pool, rest to the seller), each fee floored
const msplit = (p) => { const r = (p * 500n) / BPS, f = (p * 200n) / BPS; return [r, f, p - r - f]; };
out.market_split_10xnt = msplit(10n * XNT).join(",");
// 7. PX: per tier base, PRICE_UP num/den, decay period, min bps, cap 10x base, PRICE_MAX_STEPS 180
const BASE = [10n, 25n, 60n, 200n].map((x) => x * XNT), NUM = [51n, 21n, 21n, 21n], DEN = [50n, 20n, 20n, 20n];
const PERIOD = [1n, 3n, 7n, 14n].map((d) => d * DAY), MINB = [3000n, 5000n, 5000n, 5000n], MAX_STEPS = 180n;
const LAUNCH = 1_795_564_800n; // mainnet PRICE_LAUNCH_TS (2026-11-25 00:00 UTC)
const minOf = (t) => (BASE[t] * MINB[t]) / BPS;
// currentPrice(price (0 = never forged), price_ts, alive_full, tier, now)
const currentPrice = (price, ts, full, t, now) => {
  let p = price === 0n ? BASE[t] : price; const since = price === 0n ? LAUNCH : ts; const min = minOf(t);
  if (full) return p > min ? p : min;
  let periods = now > since ? (now - since) / PERIOD[t] : 0n; if (periods > MAX_STEPS) periods = MAX_STEPS;
  for (let i = 0n; i < periods; i++) { p = (p * DEN[t]) / NUM[t]; if (p <= min) return min; }
  return p > min ? p : min;
};
const nextPrice = (paid, t) => { const v = (paid * NUM[t]) / DEN[t], cap = BASE[t] * 10n; return v < cap ? v : cap; };
out.px_lunar_never_forged_at_launch = currentPrice(0n, 0n, false, 0, LAUNCH).toString();
out.px_lunar_never_forged_plus_1d = currentPrice(0n, 0n, false, 0, LAUNCH + DAY).toString();
out.px_lunar_never_forged_plus_177d = currentPrice(0n, 0n, false, 0, LAUNCH + 177n * DAY).toString();
out.px_cosmic_after_2_forges = nextPrice(nextPrice(BASE[1], 1), 1).toString();
out.px_lunar_from_100xnt_177_periods = currentPrice(100n * XNT, 1_000n, false, 0, 1_000n + 177n * DAY).toString();
out.px_lunar_from_100xnt_178_periods = currentPrice(100n * XNT, 1_000n, false, 0, 1_000n + 178n * DAY).toString();
out.px_full_tier_never_decays = currentPrice(BASE[0], 1_000n, true, 0, 1_000n + 400n * DAY).toString();
out.px_next_price_cap = [0, 1, 2, 3].map((t) => nextPrice(BASE[t] * 10n, t)).join(",");
// steps from the 10x cap down to the minimum, per tier (PRICE_MAX_STEPS must cover the largest)
out.px_steps_cap_to_min = [0, 1, 2, 3].map((t) => { let p = BASE[t] * 10n, n = 0; while (p > minOf(t)) { p = (p * DEN[t]) / NUM[t]; n++; } return n; }).join(",");

const file = path.join(__dirname, "fixtures", "spec-vectors-v2.out.json");
const text = "{\n" + Object.entries(out).map(([key, v]) => `  "${key}": "${v}"`).join(",\n") + "\n}\n";
if (process.argv.includes("--check")) {
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : "";
  if (cur !== text) { console.error(`${file} is stale: rerun node tests/spec-vectors-v2.cjs`); process.exit(1); }
  console.log(`${file}: ${Object.keys(out).length} vectors, up to date`);
} else {
  fs.writeFileSync(file, text);
  console.log(text);
}
