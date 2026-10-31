// node --test: the kit's port of the rewards v3 engine (quote-v3.mjs) against the golden vectors the ORACLE ENGINE
// produced (test/vectors/quote-v3.json, gen-quote-vectors.cjs): every burn of every world (first epochs, second epochs on
// a v3 file with curve memory and shortfall cuts, the v2 -> v3 switch on the real epoch-1.json) reproduced to the
// lamport; the quote of each burn from the burns before it equals what the engine paid it at arrival (prefix
// stability); the vectors' sha256 checksum; and the engine primitives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  allocateBurns, allocItem, capOnDay, decayFactor, DECAY_Q, FP, lockPiece, nextLiquidityV3, quoteBurn, release, windowResult,
} from '../../quote-v3.mjs';
import { burnsOf, loadVectors, prefixInputs, prevOf, REPO, VECTORS_FILE } from './helpers-v3.mjs';

test('the site\'s own golden vectors (frontend/test/v3/golden/quote-vectors.json) are paid the same by the kit\'s port, to the lamport', async (t) => {
  // until one shared vectors file is wired (KIT-STAGING switch gate 2), the kit at least checks the site's set
  const { allocateWindow } = await import('../../quote-v3.mjs');
  const file = path.join(REPO, 'frontend', 'test', 'v3', 'golden', 'quote-vectors.json');
  if (!fs.existsSync(file)) return t.skip('the site\'s vectors are not present (kit used outside the repository)');
  const g = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  for (const w of g.worlds) {
    const by = new Map(allocateWindow(null, w.inputs).burns.map((b) => [b.txHash, b]));
    for (const e of w.expected) {
      const b = by.get(e.tx);
      assert.ok(b, `world ${w.seed}: burn ${e.tx} missing`);
      for (const k of ['valueMicro', 'base', 'lp', 'ent', 'band', 'senior', 'bandPaid', 'lockedLp']) assert.equal(String(b[k]), e[k], `world ${w.seed} burn ${e.tx.slice(-6)} ${k}`);
      assert.equal(b.leafTier, e.leafTier);
      assert.equal(b.converted, e.converted);
      n++;
    }
  }
  assert.ok(n > 0);
});

test('the vectors match their sha256 checksum', () => {
  const text = fs.readFileSync(VECTORS_FILE);
  const want = fs.readFileSync(`${VECTORS_FILE}.sha256`, 'utf8').trim().split(/\s+/)[0];
  assert.equal(crypto.createHash('sha256').update(text).digest('hex'), want, 'quote-v3.json was edited: regenerate it with node test/vectors/gen-quote-vectors.cjs');
});

test('engine drift: the vectors were produced by the oracle engine in this repository', (t) => {
  const engine = path.join(REPO, 'oracle', 'src', 'rewards.ts');
  if (!fs.existsSync(engine)) return t.skip('oracle/src/rewards.ts is not present (kit used outside the repository)');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(engine, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
  const v = loadVectors();
  if (sha !== v.engineSha256) {
    const msg = `oracle/src/rewards.ts changed since the vectors were generated (${v.engineSha256.slice(0, 12)}… -> ${sha.slice(0, 12)}…): regenerate them (node test/vectors/gen-quote-vectors.cjs) and re-check the port`;
    if (process.env.MF_VECTORS_STRICT === '1') assert.fail(msg);
    t.diagnostic(msg);
  }
});

test('every world: every burn, the capacity and the shortfall cut equal the engine\'s', () => {
  const v = loadVectors();
  let burns = 0, shortfalls = 0;
  // the D-12 worlds (burns before the window start) are kept apart from the week-so-far worlds: replayed here too
  for (const w of [...v.worlds, ...(v.backlogWorlds ?? [])]) {
    const got = windowResult(prevOf(w), w.inputs);
    if (!w.expected) {
      const paid = got.burns.reduce((s, b) => s + BigInt(b.basePaid) + BigInt(b.bandPaid), 0n);
      assert.equal(paid, 0n, `${w.name}: the engine published nothing, so nothing is paid`);
      continue;
    }
    assert.deepEqual(got.burns, w.expected.burns, `${w.name}: burns`);
    assert.deepEqual(got.capacity, w.expected.capacity, `${w.name}: capacity`);
    assert.deepEqual(got.shortfall, w.expected.shortfall, `${w.name}: shortfall`);
    // round 4: the XNT build price with its USDC.X guard (D-22 c), each chain's L, its rule and the next L (D-13), the cap and curve
    assert.deepEqual(got.xnt, w.expected.xnt, `${w.name}: xnt`);
    assert.deepEqual(got.chains, w.expected.chains, `${w.name}: chains`);
    burns += w.expected.burns.length;
    if (w.expected.shortfall) shortfalls++;
  }
  assert.ok(burns > 300, `${burns} burns checked`);
  assert.ok(shortfalls >= 1, 'at least one world exercises the build-limit cut');
  assert.ok(v.worlds.some((w) => w.prev === 'epoch-1'), 'the v2 -> v3 switch on epoch-1.json is covered');
  // round 4: every rule the engine gained is exercised by at least one world
  const all = [...v.worlds, ...(v.backlogWorlds ?? [])].filter((w) => w.expected);
  const rules = new Set(all.flatMap((w) => w.expected.chains.map((c) => c.L.rule)));
  for (const r of ['frozen', 'switch', 'first', 'genesis']) assert.ok(rules.has(r), `D-13: an L set by rule "${r}"`);
  // F5 (rulesId 2): a next L carried (next = used) and one clamped (next = nextLiquidityV3(stat, used)), a frozen L carried too
  const recs = all.flatMap((w) => w.expected.chains.map((c) => c.L));
  for (const r of ['carried', 'clamp']) assert.ok(recs.some((l) => l.nextRule === r), `F5: a next L set by rule "${r}"`);
  assert.ok(recs.some((l) => l.nextRule === 'carried' && l.rule === 'frozen' && nextLiquidityV3(BigInt(l.stat), BigInt(l.used)) !== BigInt(l.used)), 'F5: a frozen L carried where the clamp would have moved it');
  for (const l of recs) assert.equal(l.next, l.nextRule === 'carried' ? l.used : nextLiquidityV3(BigInt(l.stat), BigInt(l.used)).toString(), `F5: next follows nextRule ${l.nextRule}`);
  assert.ok(all.some((w) => w.expected.burns.some((b) => b.backlog)), 'D-12: a backlog burn');
  assert.ok(all.some((w) => w.expected.burns.some((b) => b.operator)) && all.some((w) => w.expected.burns.some((b) => b.exception !== null)), 'D-18: operator and exception burns');
  assert.ok(all.some((w) => w.expected.capacity.trancheCap !== null && w.expected.capacity.cash === w.expected.capacity.trancheCap), 'D-22 (a): a binding XDEX cap');
  assert.ok(all.some((w) => w.expected.xnt.peg.guard === 'high'), 'D-22 (c): a USDC.X premium');
  assert.ok(all.some((w) => { const ts = burnsOf(w.inputs).map((b) => b.timestamp); return new Set(ts).size < ts.length; }), 'D-14: burns stamped in the same second');
  assert.ok(all.some((w) => w.prev === 'v3h') && v.prevFiles.v3h.heartbeat === true, 'a window after a heartbeat epoch (quiet-month seat liveness)');
});

test('prefix stability: the quote of each burn from the burns before it is what the engine paid it at arrival', () => {
  const v = loadVectors();
  let checked = 0;
  for (const w of [...v.worlds, ...(v.backlogWorlds ?? [])].filter((x) => x.solo && x.expected && !x.expected.shortfall)) {
    const prev = prevOf(w);
    const all = burnsOf(w.inputs);
    // a quote is exact only when no later burn shares a chain-hour with it (same-hour burns share the hour's curve pot)
    const hours = new Map();
    for (const b of all) { const k = `${b.chainId}:${Math.floor(b.timestamp / 3600)}`; hours.set(k, (hours.get(k) ?? 0) + 1); }
    if ([...hours.values()].some((n) => n > 1)) continue;
    for (const b of all) {
      const e = w.expected.burns.find((x) => x.txHash === b.txHash && x.chainId === b.chainId);
      // a backlog or operator burn claims after every burn of the window (D-12, D-18): not a quote from the burns before it
      if (e.backlog || e.operator) continue;
      const q = quoteBurn(prev, prefixInputs(w.inputs, b), { ...b });
      assert.equal(q.bindingNow.toString(), e.senior, `${w.name} ${b.txHash}: arrival claim`);
      assert.equal(q.lockedLp.toString(), e.lockedLp, `${w.name} ${b.txHash}: locked piece`);
      assert.equal(q.bandLocked.toString(), e.bandPaid, `${w.name} ${b.txHash}: band`);
      assert.equal(q.leafTier, e.leafTier, `${w.name} ${b.txHash}: leaf tier`);
      assert.equal(q.converted, e.converted, `${w.name} ${b.txHash}: converted`);
      assert.equal(q.lp.toString(), e.lp, `${w.name} ${b.txHash}: Launchpad layer`);
      assert.equal(q.upperBound, false);
      checked++;
    }
  }
  assert.ok(checked >= 30, `${checked} quotes checked`);
});

test('a burn in an hour that already holds a burn of the same chain is flagged "at most"', () => {
  const w = loadVectors().worlds.find((x) => !x.solo && x.expected && x.prev === null && burnsOf(x.inputs).length > 3);
  const all = burnsOf(w.inputs);
  const b = all[all.length - 1];
  const hourMate = { ...b, txHash: `0x${'ee'.repeat(32)}`, logIndex: 999_999, blockNumber: b.blockNumber - 1, timestamp: b.timestamp };
  const inputs = { ...w.inputs, chains: w.inputs.chains.map((c) => (c.chainId === b.chainId ? { ...c, burns: [...c.burns.filter((x) => x.txHash !== b.txHash), hourMate] } : c)) };
  const q = quoteBurn(prevOf(w), inputs, { ...b });
  assert.equal(q.upperBound, true);
  assert.ok(q.sameHour >= 1);
});

test('decay constant: 2^(-1/336) floored, half-life 336 h', () => {
  assert.equal(DECAY_Q, 997_939_188_356_834_408n);
  const half = decayFactor(336);
  assert.ok(half <= FP / 2n && FP / 2n - half < 10n ** 6n, `decayFactor(336) = ${half}`);
  assert.equal(decayFactor(0), FP);
});

test('tranches: the cumulative cap grows by C/7 a day, the first C mod 7 days by one lamport more, the whole C after day 6', () => {
  const C = 1_000_003n;
  assert.equal(release(C, 1), C / 7n + 1n);
  assert.equal(capOnDay(C, 6), C);
  assert.equal(capOnDay(C, 9), C);
  for (let d = 0; d < 6; d++) assert.ok(capOnDay(C, d) < capOnDay(C, d + 1));
});

test('lockPiece: the whole mission locks on a full claim; a smaller claim locks the piece it covers, never below the multiplier', () => {
  assert.deepEqual(lockPiece(100n, 200n, 300n, 0n), { lp: 100n, band: 200n, cash: 0n });
  const p = lockPiece(100n, 200n, 150n, 0n);
  assert.ok(p.lp * 200n >= p.band * 100n, 'the piece is locked at its full multiplier');
  assert.ok(p.lp + p.band + p.cash <= 150n);
  assert.equal(lockPiece(100n, 200n, 150n, 1_000n), null, 'a dust piece is paid as Launchpad');
});

test('allocateBurns: FCFS inside the tranche; a burn after the cap gets nothing at arrival; the leftover pays Launchpad layers only', () => {
  const C = 700n;
  const ws = [allocItem(0, 0, 80n, 0n), allocItem(0, 0, 80n, 0n), allocItem(1, 1, 50n, 100n)];
  const a = allocateBurns(ws, C, 0n);
  assert.equal(ws[0].arrival.senior, 80n);
  assert.equal(ws[1].arrival.senior, 20n, 'day 0 releases 100: the second burn gets the remaining 20');
  assert.ok(ws[2].arrival.senior <= 100n);
  assert.ok(a.left >= 0n);
  assert.ok(ws.every((w) => w.basePaid <= w.lp));
});
