// Golden quote vectors for the rewards v3 engine, produced BY THE ORACLE ENGINE ITSELF (oracle/src/rewards.ts,
// computeEpochV3 / buildEpochFileV3), so the kit's port (quote-v3.mjs), the site and the oracle can be checked against
// the same numbers. Deterministic: the same engine gives byte-identical output and the same checksum.
//
//   node test/vectors/gen-quote-vectors.cjs          (from agents/kit; needs oracle/node_modules: cd oracle && npm ci --ignore-scripts)
//
// Writes test/vectors/quote-v3.json and quote-v3.json.sha256. Run it from agents/kit only: the oracle config reads a
// .env from the working directory, and agents/kit has none.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KIT = path.resolve(__dirname, '..', '..');
const ORACLE = path.resolve(KIT, '..', '..', 'oracle');
if (process.cwd() !== KIT) {
  console.error(`run from ${KIT} (the oracle config reads a .env from the working directory)`);
  process.exit(1);
}
require(path.join(ORACLE, 'node_modules', 'ts-node')).register({ transpileOnly: true, project: path.join(ORACLE, 'tsconfig.json') });
const R = require(path.join(ORACLE, 'src', 'rewards.ts'));
const { PublicKey } = require(path.join(ORACLE, 'node_modules', '@solana', 'web3.js'));

// ── deterministic generator ────────────────────────────────────────────────
let s = 0x9e3779b97f4a7c15n;
const rnd = () => { s ^= s << 13n; s &= (1n << 64n) - 1n; s ^= s >> 7n; s ^= s << 17n; s &= (1n << 64n) - 1n; return s; };
const int = (lo, hi) => lo + Number(rnd() % BigInt(hi - lo + 1));
const pick = (a) => a[int(0, a.length - 1)];
const key = (tag, i) => { const b = new Uint8Array(32); b[0] = tag; b[1] = i & 255; b[2] = (i >> 8) & 255; b[31] = 7; return new PublicKey(b).toBase58(); };
const iso = (ts) => new Date(ts * 1000).toISOString();
const PROGRAM = '57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9';
const XEN = 10n ** 18n;
const E18 = 10n ** 18n;
const T0 = 1_795_478_400; // a UTC midnight
const CHAINS = [10, 56, 137, 8453, 43114];
const NAMES = { 10: 'Optimism', 56: 'BSC', 137: 'Polygon', 8453: 'Base', 43114: 'Avalanche' };
/** a block number that grows with time and lies above every chain's epoch-1 cursor (the switch worlds continue epoch-1.json) */
const blockAt = (ts) => 200_000_000 + (ts - 1_790_000_000) * 4;

let seq = 0;
function burnAt(chainId, ts, opts) {
  seq++;
  const fb = opts.fallback, xfb = opts.xntFallback;
  return {
    chainId, txHash: '0x' + seq.toString(16).padStart(64, '0'), logIndex: seq, blockNumber: blockAt(ts) + (seq % 4), missionId: String(seq), pilot: '0x' + 'ab'.repeat(20),
    amountWei: opts.wei.toString(), tier: opts.tier, x1: opts.x1, timestamp: ts,
    medianE18: fb ? '0' : opts.median.toString(), lastCloseE18: fb ? '0' : opts.last.toString(), priceSource: fb ? 'fallback' : 'candles',
    xntMedianE18: xfb ? '0' : opts.xnt.toString(), xntLastCloseE18: xfb ? '0' : opts.xntLast.toString(), xntSource: xfb ? 'fallback' : 'candles',
  };
}

/** A world: chains with markets, burns over the window, a pool. `solo`: every chain-hour holds at most one burn. */
function world({ startTs, endTs, nBurns, solo, poolXnt, chainsN, prevChains }) {
  const chains = (prevChains ?? CHAINS).slice(0, chainsN);
  const market = Object.fromEntries(chains.map((c) => {
    const spot = BigInt(int(5, 60)) * 10n ** 9n; // XEN ≈ $5e-9 .. $6e-8 (E18)
    return [c, { spot, ref: spot * BigInt(int(80, 120)) / 100n, L: BigInt(pick([0, 1, 3, 30, 300, 3_000, 30_000])) * 1_000_000n * BigInt(int(1, 9)) }];
  }));
  const wallets = Array.from({ length: int(2, 6) }, (_, i) => key(1, i + 1 + int(0, 50)));
  const used = new Set();
  const burns = [];
  for (let i = 0; i < nBurns; i++) {
    const c = pick(chains);
    let ts;
    for (let tries = 0; ; tries++) {
      ts = int(startTs + 60, endTs - 60);
      const h = `${c}:${Math.floor(ts / 3600)}`;
      if (!solo || !used.has(h) || tries > 200) { used.add(h); break; }
    }
    const m = market[c];
    const median = m.spot * BigInt(int(70, 130)) / 100n;
    const last = m.spot * BigInt(int(70, 130)) / 100n;
    const x = BigInt(int(15, 30)) * E18 / 100n;
    burns.push(burnAt(c, ts, {
      tier: pick([0, 0, 0, 1, 2]), x1: pick(wallets), wei: BigInt(pick([1_000, 50_000, 1_000_000, 30_000_000, 400_000_000, 3_000_000_000])) * XEN * BigInt(int(1, 9)),
      median, last, fallback: int(0, 9) === 0, xnt: x, xntLast: x * BigInt(int(90, 112)) / 100n, xntFallback: int(0, 14) === 0,
    }));
  }
  return { chains, market, burns, poolLamports: BigInt(poolXnt) * 1_000_000_000n };
}

function inputsOf(w, { epoch, startTs, endTs, prev, open, switchRefs }) {
  return {
    programId: PROGRAM, epoch, createdAt: iso(endTs), window: { startTs, endTs },
    chains: w.chains.map((c) => {
      const pc = prev ? prev.chains.find((x) => x.chainId === c) : null;
      const from = pc ? pc.toBlock : 0;
      return {
        chainId: c, name: NAMES[c], portal: '0x7b00f314aB48D223bee567181CA89c65126Bf6E9', fromBlockExclusive: from, toBlock: blockAt(endTs) + 3,
        market: { spotE18: w.market[c].spot.toString(), refUsdE18: w.market[c].ref.toString(), priceSource: 'vector', pools: [] },
        liquidityNowMicro: w.market[c].L.toString(), totalSupply: '0',
        burns: w.burns.filter((b) => b.chainId === c && b.blockNumber > from),
      };
    }),
    snapshot: { slot: 1_000 + epoch, records: [] },
    freePool: { lamports: w.poolLamports.toString(), slot: 999 + epoch, open: open === undefined ? null : open.toString() },
    xnt: { twapE18: (E18 / 5n).toString(), apiE18: (E18 / 5n + 3n * 10n ** 15n).toString(), source: 'vector' },
    switchRefs: switchRefs ?? null,
  };
}

const PICK = ['chainId', 'txHash', 'logIndex', 'priceE18', 'priceRule', 'xntE18', 'xntRule', 'hour', 'day', 'backlog', 'operator', 'exception', 'spotMicro', 'valueMicro', 'base', 'lp', 'ent', 'band', 'senior', 'basePaid', 'bandPaid', 'lockedLp', 'converted', 'leafTier'];
const CAP = ['cash', 'planCash', 'trancheCap', 'tranche', 'senior', 'base', 'bandTotal', 'bandPaid', 'left', 'lockedMissions', 'splitMissions', 'convertedMissions'];
function expectedOf(body) {
  if (!body) return null;
  const sf = body.capacity.shortfall;
  return {
    capacity: Object.fromEntries(CAP.map((k) => [k, typeof body.capacity[k] === 'number' || body.capacity[k] === null ? body.capacity[k] : String(body.capacity[k])])),
    burns: body.burns.map((b) => Object.fromEntries(PICK.map((k) => [k, b[k]]))),
    shortfall: sf ? { stage: sf.stage, kept: sf.kept, wanted: sf.wanted, claim: sf.claim, planned: sf.planned } : null,
    // round 4: the XNT build price and its USDC.X guard (D-22 c), each chain's L and its rule (D-13), cap and curve;
    // F5 (rulesId 2): how the next L was set (nextRule "clamp" or "carried")
    xnt: { buildE18: body.xnt.buildE18, floorE18: body.xnt.floorE18, peg: body.xnt.peg },
    chains: body.chains.filter((c) => !c.skipped).map((c) => ({
      chainId: c.chainId, L: { used: c.L.used, rule: c.L.rule, stat: c.L.stat, next: c.L.next, nextRule: c.L.nextRule, cap: c.L.cap }, priceCapE18: c.priceCapE18, xenUsdE18: c.xenUsdE18,
      curveAfter: c.curveAfter,
    })),
  };
}

const worlds = [];
const files = {};
// 1. first-epoch worlds (no previous file), solo and batched, small and large pools
for (let i = 0; i < 14; i++) {
  const endTs = T0 + 7 * 86_400 + i * 3_600, startTs = endTs - 7 * 86_400;
  const solo = i % 2 === 0;
  const w = world({ startTs, endTs, nBurns: int(4, 30), solo, poolXnt: pick([1, 5, 40, 300, 5_000]), chainsN: int(1, 5) });
  const inputs = inputsOf(w, { epoch: 1, startTs, endTs });
  const body = R.computeEpochV3(inputs, null);
  worlds.push({ name: `first-${i}${solo ? '-solo' : ''}`, prev: null, solo, inputs, expected: expectedOf(body) });
  if (body && !files.v3a) files.v3a = { inputs, file: JSON.parse(JSON.stringify(R.buildEpochFileV3(inputs, null))) };
}
// 2. second-epoch worlds on a v3 previous file (curve memory, L clamp, XNT floor, reference history), incl. shortfalls
const prevA = files.v3a.file;
const publishedA = prevA.window.endTs + 120;
for (let i = 0; i < 10; i++) {
  const startTs = publishedA, endTs = startTs + 7 * 86_400 - (i % 3) * 600;
  const solo = i % 2 === 1;
  const w = world({ startTs, endTs, nBurns: int(4, 30), solo, poolXnt: pick([3, 60, 900]), chainsN: prevA.chains.length, prevChains: prevA.chains.map((c) => c.chainId) });
  // open = F_ref; a smaller pool at build forces the literal cut (A13.2) in some worlds
  const open = i % 3 === 0 ? w.poolLamports * 6n : w.poolLamports;
  const inputs = inputsOf(w, { epoch: 2, startTs, endTs, prev: prevA, open });
  worlds.push({ name: `second-${i}${solo ? '-solo' : ''}${open !== w.poolLamports ? '-shortfall' : ''}`, prev: 'v3a', solo, inputs, expected: expectedOf(R.computeEpochV3(inputs, prevA)) });
}
// 3. the v2 → v3 switch on the real epoch-1.json (a v2 file: curve seeded from its burns, switchRefs from its readings;
//    r6-review 2: with its liquidity reading too, the only v2 file, so the switch L is that reading)
const epoch1 = JSON.parse(fs.readFileSync(path.resolve(KIT, '..', '..', 'frontend', 'public', 'epochs', 'epoch-1.json'), 'utf8'));
const e1End = Math.floor(Date.parse(epoch1.createdAt) / 1000);
for (let i = 0; i < 4; i++) {
  const startTs = e1End + 60, endTs = startTs + 7 * 86_400;
  const solo = i % 2 === 0;
  const w = world({ startTs, endTs, nBurns: int(3, 16), solo, poolXnt: pick([6, 6, 40]), chainsN: 5, prevChains: epoch1.chains.map((c) => c.chainId) });
  const switchRefs = epoch1.chains.map((c) => ({ chainId: c.chainId, readings: [c.xenUsdE18], liquidity: [BigInt(c.liquidityUsdMicro || '0').toString()] }));
  const inputs = inputsOf(w, { epoch: 2, startTs, endTs, prev: epoch1, open: w.poolLamports, switchRefs });
  worlds.push({ name: `switch-${i}${solo ? '-solo' : ''}`, prev: 'epoch-1', solo, inputs, expected: expectedOf(R.computeEpochV3(inputs, epoch1)) });
}

// 4. round 4 (2026-10-25): the rules rewards.ts gained (D-12 backlog, D-14 keccak tie-break, D-18 operator wallets and a
//    dated exception, D-22 a XDEX tranche cap, D-22 c USDC.X guard); the second worlds above already run on the frozen L
//    of a v3 file (D-13 option a) and the switch worlds on the v2 file's reading
const clone = (x) => JSON.parse(JSON.stringify(x));
const XNT_POOL = 'CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR';
// 4a. a previous file whose build read the XDEX pool: the next window's C is capped at 7 × 2% of that reserve
files.v3b = { file: clone(R.buildEpochFileV3({ ...files.v3a.inputs, xdex: { pool: XNT_POOL, slot: 5_000, wxntReserveLamports: (25n * 10n ** 9n).toString(), usdcReserveMicro: '5000000000', feeBps: 28 } }, null)) };
const prevB = files.v3b.file;
for (let i = 0; i < 4; i++) {
  const startTs = prevB.window.endTs + 120, endTs = startTs + 7 * 86_400;
  const solo = i % 2 === 0;
  const w = world({ startTs, endTs, nBurns: int(6, 24), solo, poolXnt: pick([60, 900]), chainsN: prevB.chains.length, prevChains: prevB.chains.map((c) => c.chainId) });
  const inputs = inputsOf(w, { epoch: 2, startTs, endTs, prev: prevB, open: w.poolLamports });
  // D-22 (c): odd worlds read x1report's USD price 5% above the XDEX TWAP (a USDC.X premium): every pool reading is raised
  if (i % 2 === 1) inputs.xnt.apiE18 = ((BigInt(inputs.xnt.twapE18) * 105n) / 100n).toString();
  worlds.push({ name: `r4-cap${i % 2 ? '-peg' : ''}-${i}${solo ? '-solo' : ''}`, prev: 'v3b', solo, inputs, expected: expectedOf(R.computeEpochV3(inputs, prevB)) });
}
// 4b. D-14: burns of different chains stamped in the same second, ordered by keccak256(txHash ‖ logIndex)
for (let i = 0; i < 3; i++) {
  const startTs = publishedA, endTs = startTs + 7 * 86_400;
  // the previous file's chains, then new ones (a chain's first week under v3: the first-reading L cap)
  const ids = [...prevA.chains.map((c) => c.chainId), ...CHAINS.filter((c) => !prevA.chains.some((x) => x.chainId === c))];
  const w = world({ startTs, endTs, nBurns: int(8, 20), solo: false, poolXnt: pick([5, 60]), chainsN: Math.max(3, prevA.chains.length), prevChains: ids });
  for (let k = 1; k < w.burns.length; k += 2) {
    const other = w.burns.find((b) => b.chainId !== w.burns[k].chainId);
    if (other) { w.burns[k].timestamp = other.timestamp; w.burns[k].blockNumber = blockAt(other.timestamp) + (k % 4); }
  }
  const inputs = inputsOf(w, { epoch: 2, startTs, endTs, prev: prevA, open: w.poolLamports });
  worlds.push({ name: `r4-ties-${i}`, prev: 'v3a', solo: false, inputs, expected: expectedOf(R.computeEpochV3(inputs, prevA)) });
}
// 4c. D-12: a chain the previous file did not list (or skipped): its burns stamped before the window start are its
//     backlog; they claim after every burn of the window, and first in the leftover. Kept apart (backlogWorlds): their
//     burns precede the window start, so they are not a week-so-far window read from its start (oracle test/feed.test.ts)
const backlogWorlds = [];
for (let i = 0; i < 3; i++) {
  const extra = CHAINS.find((c) => !prevA.chains.some((x) => x.chainId === c));
  const startTs = publishedA, endTs = startTs + 7 * 86_400;
  const w = world({ startTs, endTs, nBurns: int(8, 16), solo: true, poolXnt: pick([3, 60]), chainsN: prevA.chains.length + 1, prevChains: [...prevA.chains.map((c) => c.chainId), extra] });
  const m = w.market[extra];
  for (let k = 0; k < 3 + i; k++) {
    const ts = int(prevA.window.startTs + 3_600, startTs - 3_600);
    w.burns.push(burnAt(extra, ts, { tier: pick([0, 0, 1]), x1: w.burns[0]?.x1 ?? key(1, 9), wei: BigInt(pick([50_000, 1_000_000, 30_000_000])) * XEN, median: m.spot, last: m.spot, xnt: E18 / 5n, xntLast: E18 / 5n }));
  }
  const inputs = inputsOf(w, { epoch: 2, startTs, endTs, prev: prevA, open: w.poolLamports });
  backlogWorlds.push({ name: `r4-backlog-${i}-solo`, prev: 'v3a', solo: true, inputs, expected: expectedOf(R.computeEpochV3(inputs, prevA)) });
}
// 4d. D-18 with PROOF_BURN_RULE (c): one listed operator wallet (ranked last), and a wallet under a dated, published
//     exception (an ordinary burn inside its range, an operator burn outside it)
for (let i = 0; i < 3; i++) {
  const startTs = publishedA, endTs = startTs + 7 * 86_400;
  const solo = i !== 2;
  const w = world({ startTs, endTs, nBurns: int(10, 24), solo, poolXnt: pick([5, 60]), chainsN: prevA.chains.length, prevChains: prevA.chains.map((c) => c.chainId) });
  const wallets = [...new Set(w.burns.map((b) => b.x1))].sort();
  if (wallets.length < 2) w.burns[0].x1 = key(1, 200 + i), wallets.push(key(1, 200 + i)), wallets.sort();
  const fromTs = startTs + 2 * 86_400, untilTs = startTs + 5 * 86_400;
  const rulesBlock = clone(R.DEFAULT_RULES_V3);
  rulesBlock.operatorWallets = { rule: 'rank-last', wallets: [wallets[0]], exceptions: [{ name: 'proof burns (vectors)', wallets: [wallets[1]], fromTs, untilTs, published: iso(startTs).slice(0, 10) }] };
  const inputs = { ...inputsOf(w, { epoch: 2, startTs, endTs, prev: prevA, open: w.poolLamports }), rulesBlock };
  worlds.push({ name: `r4-operator-${i}${solo ? '-solo' : ''}`, prev: 'v3a', solo, inputs, expected: expectedOf(R.computeEpochV3(inputs, prevA)) });
}

// 4e. round 4 (quiet-month seat liveness): a heartbeat base epoch (a window with no burn to value: no leaf, nothing paid)
//     as the previous file; the next window continues its carried cursors, curves and frozen L
{
  const startTs = publishedA, endTs = startTs + 7 * 86_400;
  const quiet = world({ startTs, endTs, nBurns: 0, solo: true, poolXnt: 60, chainsN: prevA.chains.length, prevChains: prevA.chains.map((c) => c.chainId) });
  const hb = R.buildEpochFileV3(inputsOf(quiet, { epoch: 2, startTs, endTs, prev: prevA, open: quiet.poolLamports }), prevA, { heartbeat: true });
  if (!hb || hb.heartbeat !== true || hb.leaves.length !== 0) throw new Error('the heartbeat world: the engine built no heartbeat');
  files.v3h = { file: clone(hb) };
  for (let i = 0; i < 2; i++) {
    const s3 = hb.window.endTs + 120, e3 = s3 + 7 * 86_400;
    const solo = i === 0;
    const w = world({ startTs: s3, endTs: e3, nBurns: int(5, 14), solo, poolXnt: pick([5, 60]), chainsN: hb.chains.length, prevChains: hb.chains.map((c) => c.chainId) });
    const inputs = inputsOf(w, { epoch: 3, startTs: s3, endTs: e3, prev: hb, open: w.poolLamports });
    worlds.push({ name: `r4-after-heartbeat-${i}${solo ? '-solo' : ''}`, prev: 'v3h', solo, inputs, expected: expectedOf(R.computeEpochV3(inputs, hb)) });
  }
}

// 4f. F5 (the D-13 "carried" rule, rulesId 2): every world above records no liquidity feed, so each of its chains carries
//     its L (next = used). Here the chains of a window on v3a (its chain, frozen L, and four chains in their first week,
//     first-reading cap) carry a recorded hourly feed, chain by chain: full, exactly 2 thin days (clamped), 3 thin days
//     (carried), none (carried), 4 samples a day (clamped); the v3a chain is clamped in one world and carried in the
//     other. Only the next L moves. Added after every other world, so the generator's earlier draws, and the worlds
//     above, are unchanged.
{
  /** counts[d] hourly samples of `micro` on stat day d (0 = the last 24 h; the end's own hour left to the build) */
  const daySamples = (endTs, micro, counts) => {
    if (endTs % 3_600 !== 0) throw new Error('daySamples: endTs is not on an hour');
    const endH = endTs / 3_600;
    const hours = counts.flatMap((n, d) => Array.from({ length: n }, (_, i) => endH - 24 * d - 1 - i));
    return hours.sort((a, b) => a - b).map((hour) => ({ hour, micro: micro.toString() }));
  };
  const PATTERNS = [[23, 23, 23, 23, 23, 23, 23], [23, 23, 23, 0, 23, 4, 3], [23, 23, 23, 23, 3, 3, 0], null, [4, 4, 4, 4, 4, 4, 4]];
  const ids = [...prevA.chains.map((c) => c.chainId), ...CHAINS.filter((c) => !prevA.chains.some((x) => x.chainId === c))];
  for (let i = 0; i < 2; i++) {
    const startTs = publishedA, endTs = Math.floor((startTs + 7 * 86_400) / 3_600) * 3_600;
    const solo = i === 0;
    const w = world({ startTs, endTs, nBurns: int(8, 18), solo, poolXnt: pick([5, 60]), chainsN: PATTERNS.length, prevChains: ids });
    const inputs = inputsOf(w, { epoch: 2, startTs, endTs, prev: prevA, open: w.poolLamports });
    inputs.chains.forEach((c, k) => {
      const counts = PATTERNS[(k + 2 * i) % PATTERNS.length];
      // a feed reading above the L in force (a new chain: above its $500 first-reading cap), so a clamped chain's next L
      // moves (+10% + $50) and a carried one's does not
      const pc = prevA.chains.find((x) => x.chainId === c.chainId);
      const used = pc ? BigInt(pc.L.next ?? '0') : 500_000_000n;
      if (counts) c.liquiditySamples = daySamples(endTs, 2n * used + 100_000_000n, counts);
    });
    worlds.push({ name: `f5-carried-${i}${solo ? '-solo' : ''}`, prev: 'v3a', solo, inputs, expected: expectedOf(R.computeEpochV3(inputs, prevA)) });
  }
}

// 4g. r6-review 2 and 3 (2026-10-26): the switch window's L is the median of the last (up to) 4 v2 liquidity readings
//     (switchRefs[].liquidity; the first is epoch-1.json's own, the older ones a recorded history), and at the switch epoch
//     the next L is clamped when the feed has at least 2 full stat days (carried with fewer). The statistic is taken over
//     the full days only, so a thin last day and the build's own reading (pulled to $0 here) decide nothing. Chain by
//     chain: 3 full days (the feed began at the upgrade), 2 full days, 1 full day (carried), none (carried), 6 full days
//     and a thin day 0 at $1. Added after every other world, so the earlier draws and worlds are unchanged.
{
  const daySamples = (endTs, micro, counts) => {
    const endH = endTs / 3_600;
    const hours = counts.flatMap((n, d) => Array.from({ length: n }, (_, i) => endH - 24 * d - 1 - i));
    return hours.sort((a, b) => a - b).map((hour) => ({ hour, micro: micro.toString() }));
  };
  const PATTERNS = [[23, 23, 23, 0, 0, 0, 0], [23, 23, 0, 0, 0, 0, 0], [23, 0, 0, 0, 0, 0, 0], null, 'thin0'];
  for (let i = 0; i < 2; i++) {
    const startTs = e1End + 60, endTs = Math.floor((startTs + 7 * 86_400) / 3_600) * 3_600;
    const solo = i === 0;
    const w = world({ startTs, endTs, nBurns: int(4, 14), solo, poolXnt: pick([6, 40]), chainsN: 5, prevChains: epoch1.chains.map((c) => c.chainId) });
    // a recorded v2 history: epoch-1's reading first, then 3 older readings around it (one of them far off)
    const switchRefs = epoch1.chains.map((c, k) => {
      const L1 = BigInt(c.liquidityUsdMicro || '0');
      const older = [L1 / 2n + BigInt(int(1, 9)) * 1_000_000n, L1 * 3n + BigInt(k) * 1_000_000n, (L1 * 9n) / 10n];
      return { chainId: c.chainId, readings: [c.xenUsdE18, c.xenUsdE18, c.xenUsdE18, c.xenUsdE18], liquidity: [L1, ...older].map(String) };
    });
    const inputs = inputsOf(w, { epoch: 2, startTs, endTs, prev: epoch1, open: w.poolLamports, switchRefs });
    const endH = endTs / 3_600;
    inputs.chains.forEach((c, k) => {
      const counts = PATTERNS[(k + i) % PATTERNS.length];
      const ref = switchRefs.find((r) => r.chainId === c.chainId);
      const switchL = R.switchLiquidityV3(ref.liquidity.map(BigInt)) ?? 500_000_000n;
      const feed = 2n * switchL + 100_000_000n;
      c.liquidityNowMicro = '0';
      if (counts === 'thin0') c.liquiditySamples = [...daySamples(endTs, feed, [0, 23, 23, 23, 23, 23, 23]), ...[3, 2, 1].map((h) => ({ hour: endH - h, micro: '1000000' }))];
      else if (counts) c.liquiditySamples = daySamples(endTs, feed, counts);
    });
    worlds.push({ name: `r6-switch-${i}${solo ? '-solo' : ''}`, prev: 'epoch-1', solo, inputs, expected: expectedOf(R.computeEpochV3(inputs, epoch1)) });
  }
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p).toString('utf8').replace(/\r\n/g, '\n')).digest('hex');
const out = {
  kind: 'moon-forge-quote-vectors', version: 1,
  note: 'Produced by oracle/src/rewards.ts (computeEpochV3); every number is the engine\'s. Regenerate with node test/vectors/gen-quote-vectors.cjs.',
  engineSha256: sha(path.join(ORACLE, 'src', 'rewards.ts')),
  prevFiles: { v3a: files.v3a.file, v3b: files.v3b.file, v3h: files.v3h.file },
  worlds,
  backlogWorlds,
};
const json = JSON.stringify(out) + '\n';
fs.writeFileSync(path.join(__dirname, 'quote-v3.json'), json);
const digest = crypto.createHash('sha256').update(json).digest('hex');
fs.writeFileSync(path.join(__dirname, 'quote-v3.json.sha256'), `${digest}  quote-v3.json\n`);
const every = [...worlds, ...backlogWorlds];
console.log(`${worlds.length} + ${backlogWorlds.length} backlog worlds (${every.reduce((n, w) => n + (w.expected?.burns.length ?? 0), 0)} burns), sha256 ${digest}`);
