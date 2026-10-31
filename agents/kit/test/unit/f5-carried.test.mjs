// node --test: F5, the D-13 "carried" rule of rulesId 2, in the kit's port (quote-v3.mjs), as the oracle engine has it
// (oracle/src/rewards.ts liquidityCarriedV3; oracle/test/f5-carried.test.ts). A chain valued this epoch whose window feed is
// missing or thin (fewer than 4 RECORDED hourly samples on more than 2 of the 7 stat days, the build's own reading not
// counted, or no recorded sample at all) keeps its L for the next window (next = used, L.nextRule "carried"); otherwise
// the next L is clamped as before (nextRule "clamp"). An orphaned chain (D-21) is never carried. Covered here: the
// parameters and the rules block (rulesId 2, rulesId 1 refused as a block, as a previous file and in a feed), every
// branch of liquidityCarriedV3, the day buckets the statistic shares, and the kit's own F5 worlds (only the next L moves;
// one sample fewer flips a chain; the quote never depends on the feed). The oracle's own F5 world is replayed by
// test/unit/rules-vectors.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { feedProblems } from '../../burn.mjs';
import {
  DAY, DEFAULT_RULES_V3, HOUR, L_MAX_THIN_DAYS, L_MIN_SAMPLES_PER_DAY, L_STAT_DAYS, liquidityCarriedV3, liquidityDaysV3, liquidityStatOfV3,
  liquidityStatV3, nextLiquidityV3, PRICE_RULES_V3, quoteBurn, recordedLiquiditySamplesV3, RULES_ID_RETIRED_V3, RULES_ID_V3, rulesBlockOf, windowResult,
} from '../../quote-v3.mjs';
import { dataHashBody } from '../../verify-leaf.mjs';
import { FEED_FIXTURE } from '../vectors/gen-week-so-far.mjs';
import { burnsOf, loadVectors, prefixInputs, prevOf, REPO } from './helpers-v3.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
// a window end on an hour, and its samples by stat day (counts[d] samples on day d, the end's own hour left free)
const END = 1_800_000_000 - (1_800_000_000 % HOUR);
const endH = END / HOUR;
function daySamples(endTs, micro, counts) {
  const h = endTs / HOUR;
  return counts.flatMap((n, d) => Array.from({ length: n }, (_, i) => h - 24 * d - 1 - i)).sort((a, b) => a - b).map((hour) => ({ hour, micro }));
}
const week = (counts, micro = 2_000_000_000n) => daySamples(END, micro, counts);
const cov = (counts, orphan = false) => liquidityCarriedV3(week(counts), END, orphan);
const FULL = [23, 23, 23, 23, 23, 23, 23];
const world = (name) => [...loadVectors().worlds, ...(loadVectors().backlogWorlds ?? [])].find((w) => w.name === name);
const Lof = (r, id) => r.chains.find((c) => c.chainId === id).L;

// ── the parameters and the rules block ─────────────────────────────────────────────────────────
test('F5: the published parameters (4 samples a day, more than 2 thin days of the 7) are priceRules members; rulesId 2', () => {
  assert.equal(L_MIN_SAMPLES_PER_DAY, 4);
  assert.equal(L_MAX_THIN_DAYS, 2);
  assert.equal(L_STAT_DAYS, 7);
  assert.equal(PRICE_RULES_V3.liquidity.minSamplesPerDay, L_MIN_SAMPLES_PER_DAY);
  assert.equal(PRICE_RULES_V3.liquidity.maxThinDays, L_MAX_THIN_DAYS);
  assert.deepEqual(Object.keys(PRICE_RULES_V3.liquidity).sort(), [
    'dropBps', 'firstBaseMicro', 'firstMaxDays', 'firstPerDayMicro', 'freeze', 'growthBps', 'maxThinDays', 'minSamplesPerDay', 'reading', 'stat', 'statDays', 'stepMicro', 'switchL', 'switchMinFullDays',
  ]);
  assert.deepEqual([RULES_ID_V3, RULES_ID_RETIRED_V3, DEFAULT_RULES_V3.rulesId], [2, 1, 2]);
  assert.equal(rulesBlockOf(DEFAULT_RULES_V3).rulesId, 2);
});

test('F5: the oracle engine in this repository has the same parameters and rules id (when present)', (t) => {
  const engine = path.join(REPO, 'oracle', 'src', 'rewards.ts');
  if (!fs.existsSync(engine)) return t.skip('oracle/src/rewards.ts is not present (kit used outside the repository)');
  const src = fs.readFileSync(engine, 'utf8');
  const num = (name) => Number(new RegExp(`export const ${name} = (\\d+);`).exec(src)?.[1]);
  assert.deepEqual([num('L_MIN_SAMPLES_PER_DAY'), num('L_MAX_THIN_DAYS'), num('RULES_ID_V3'), num('RULES_ID_RETIRED_V3')], [L_MIN_SAMPLES_PER_DAY, L_MAX_THIN_DAYS, RULES_ID_V3, RULES_ID_RETIRED_V3]);
});

test('F5: the round-4 block (rulesId 1, no F5 members) is never accepted, and no F5 value can change without a new rulesId', () => {
  const { minSamplesPerDay: _m, maxThinDays: _t, ...round4 } = PRICE_RULES_V3.liquidity;
  const block = (patch) => ({ ...clone(DEFAULT_RULES_V3), ...patch });
  assert.throws(() => rulesBlockOf(block({ rulesId: 1 })), /rulesId 1 was replaced before any v3 epoch was built/);
  assert.throws(() => rulesBlockOf(block({ rulesId: 1, priceRules: { ...clone(PRICE_RULES_V3), liquidity: round4 } })), /rulesId 1 was replaced/);
  assert.throws(() => rulesBlockOf(block({ rulesId: 0 })), /is not a version number/);
  assert.throws(() => rulesBlockOf(block({ priceRules: { ...clone(PRICE_RULES_V3), liquidity: round4 } })), /rulesBlock.priceRules .* is not the price rules this kit implements/);
  for (const [k, v] of [['minSamplesPerDay', 3], ['minSamplesPerDay', 5], ['minSamplesPerDay', '4'], ['maxThinDays', 1], ['maxThinDays', 3], ['maxThinDays', null]]) {
    assert.throws(() => rulesBlockOf(block({ priceRules: { ...clone(PRICE_RULES_V3), liquidity: { ...PRICE_RULES_V3.liquidity, [k]: v } } })), /rulesBlock.priceRules/, `${k} = ${String(v)}`);
  }
  // as in the engine, a higher rulesId is read as a later version; the pinned members still decide what this kit implements
  assert.equal(rulesBlockOf(block({ rulesId: 3 })).rulesId, 3);
});

test('F5: a previous v3 file under the retired block is refused as epoch n − 1 (its data hash made right, only the id changed)', () => {
  const w = world('f5-carried-0-solo');
  const old = clone(prevOf(w));
  assert.equal(old.rulesBlock.rulesId, 2, 'the kit vectors are written under rulesId 2');
  old.rulesBlock.rulesId = 1;
  old.dataHash = dataHashBody(old);
  assert.throws(() => windowResult(old, w.inputs), /rulesId 1 was replaced/);
  // and a window under rulesId 1 after a rulesId 2 file is refused too
  assert.throws(() => windowResult(prevOf(w), { ...w.inputs, rulesBlock: { ...clone(DEFAULT_RULES_V3), rulesId: 1 } }), /rulesId 1 was replaced/);
});

test('F5: a week-so-far feed that names rulesId 1 gives no quote (feedProblems); rulesId 2 is accepted', () => {
  const fx = JSON.parse(fs.readFileSync(FEED_FIXTURE, 'utf8'));
  const now = fx.candidate.now;
  assert.deepEqual(feedProblems(fx.feed, { now }), []);
  assert.deepEqual(feedProblems({ ...fx.feed, rulesBlock: clone(DEFAULT_RULES_V3) }, { now }), []);
  const p = feedProblems({ ...fx.feed, rulesBlock: { ...clone(DEFAULT_RULES_V3), rulesId: 1 } }, { now });
  assert.ok(p.some((x) => /rules block is not one this kit implements .*rulesId 1 was replaced/.test(x)), p.join(' | '));
});

// ── liquidityCarriedV3, every branch ───────────────────────────────────────────────────────────
test('F5: a full feed is never carried; no recorded sample at all (no feed) is always carried', () => {
  assert.deepEqual(cov(FULL), { carried: false, samples: 161, thinDays: 0 });
  assert.deepEqual(liquidityCarriedV3([], END, false), { carried: true, samples: 0, thinDays: 7 });
  assert.deepEqual(cov([0, 0, 0, 0, 0, 0, 0]), { carried: true, samples: 0, thinDays: 7 });
});

test('F5: thin = fewer than 4 samples in a day (4 is not thin); carried = more than 2 thin days (exactly 2 is not)', () => {
  assert.deepEqual(cov([4, 4, 4, 4, 4, 4, 4]), { carried: false, samples: 28, thinDays: 0 }, '4 samples a day: no day is thin');
  assert.deepEqual(cov([3, 3, 3, 3, 3, 3, 3]), { carried: true, samples: 21, thinDays: 7 }, '3 samples a day: every day is thin');
  assert.deepEqual(cov([23, 23, 23, 0, 23, 4, 3]), { carried: false, samples: 99, thinDays: 2 }, 'exactly 2 thin days: clamped');
  assert.deepEqual(cov([3, 3, 4, 4, 4, 4, 4]), { carried: false, samples: 26, thinDays: 2 });
  assert.deepEqual(cov([4, 4, 4, 4, 4, 0, 0]), { carried: false, samples: 20, thinDays: 2 }, 'two empty days: still clamped');
  assert.deepEqual(cov([23, 23, 23, 23, 3, 3, 0]), { carried: true, samples: 98, thinDays: 3 }, '3 thin days: carried');
  assert.deepEqual(cov([4, 4, 4, 4, 3, 3, 3]), { carried: true, samples: 25, thinDays: 3 });
  assert.deepEqual(cov([23, 23, 23, 23, 0, 0, 0]), { carried: true, samples: 92, thinDays: 3 }, 'a feed that started 4 days before the build (the first v3 window)');
  assert.deepEqual(cov([0, 23, 23, 23, 23, 0, 0]), { carried: true, samples: 92, thinDays: 3 }, 'a feed that stopped a day before the build');
});

test('F5: a sample is a sample whatever it reads (a pull to 0 counts); the orphan exemption; the build\'s own reading never counts', () => {
  assert.deepEqual(liquidityCarriedV3(week(FULL, 0n), END, false), { carried: false, samples: 161, thinDays: 0 }, 'readings of 0 are recorded readings');
  // D-21: an orphaned chain has no market and reads 0 by rule: never carried, its frozen L keeps halving
  assert.deepEqual(liquidityCarriedV3([], END, true), { carried: false, samples: 0, thinDays: 7 });
  assert.equal(cov([3, 3, 3, 3, 3, 3, 3], true).carried, false);
  // r6-review 3: the build's own reading is the statistic only when nothing is recorded, and never a coverage sample
  assert.equal(liquidityStatOfV3([], END, 5n), 5n, 'no feed: the statistic is the build\'s own reading');
  assert.deepEqual(liquidityCarriedV3(recordedLiquiditySamplesV3([], END, 'c'), END, false), { carried: true, samples: 0, thinDays: 7 }, 'the coverage does not');
  // a sample RECORDED for the end's hour is a feed sample like any other
  assert.deepEqual(liquidityCarriedV3(recordedLiquiditySamplesV3([{ hour: endH, micro: '7' }], END, 'c'), END, false), { carried: true, samples: 1, thinDays: 7 });
  assert.equal(liquidityCarriedV3(recordedLiquiditySamplesV3(null, END, 'c'), END, false).samples, 0, 'null = none recorded');
  // the recorded samples are checked as before: ascending, at or before the end
  assert.throws(() => recordedLiquiditySamplesV3([{ hour: endH - 1, micro: '1' }, { hour: endH - 1, micro: '1' }], END, 'c'), /strictly ascending/);
  assert.throws(() => recordedLiquiditySamplesV3([{ hour: endH + 1, micro: '1' }], END, 'c'), /after the window end/);
});

test('F5: the coverage counts the statistic\'s own 7 day buckets (liquidityDaysV3): older samples and the 7-day edge do not count', () => {
  // day d = ⌊(endTs − hour start) / DAY⌋: the hour starting exactly 7 days before the end is day 7, outside the window
  const edge = [{ hour: endH - 168, micro: 1n }, { hour: endH - 167, micro: 2n }];
  assert.deepEqual([...liquidityDaysV3(edge, END).entries()], [[6, [2n]]]);
  assert.deepEqual(liquidityCarriedV3(edge, END, false), { carried: true, samples: 1, thinDays: 7 });
  assert.deepEqual(liquidityCarriedV3([{ hour: endH - 24 * 8, micro: 1n }], END, false), { carried: true, samples: 0, thinDays: 7 }, 'a late window\'s old samples: recorded, not counted');
  const xs = week([5, 23, 1, 0, 9, 4, 23]);
  const days = liquidityDaysV3(xs, END);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((d) => days.get(d)?.length ?? 0), [5, 23, 1, 0, 9, 4, 23]);
  assert.equal(liquidityStatV3(xs, END), 2_000_000_000n);
  // the hour at the end itself is day 0, the 23 hours before it too; the 24th hour back is day 1
  assert.deepEqual([...liquidityDaysV3([{ hour: endH - 24, micro: 1n }, { hour: endH - 23, micro: 1n }, { hour: endH, micro: 1n }], END).entries()].map(([d, v]) => [d, v.length]), [[1, 1], [0, 2]]);
  assert.equal(DAY, 86_400);
});

test('the oracle\'s F5 and D-21 worlds through the kit\'s port (when present): carried, clamped, and an orphaned chain never carried', (t) => {
  const file = path.join(REPO, 'oracle', 'test', 'fixtures', 'rules-v3-vectors.json');
  if (!fs.existsSync(file)) return t.skip('oracle/test/fixtures/rules-v3-vectors.json is not present (kit used outside the repository)');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const run = (name, i) => {
    const w = doc.worlds.find((x) => x.name === name);
    assert.ok(w, `the oracle's vectors have the world ${name}`);
    return { got: windowResult(i ? w.epochs[i - 1].file : null, w.epochs[i].inputs), file: w.epochs[i].file };
  };
  const { got, file: f2 } = run('d13-f5-carried', 1);
  const row = (r, id) => [Lof(r, id).rule, Lof(r, id).used, Lof(r, id).stat, Lof(r, id).nextRule, Lof(r, id).next];
  assert.deepEqual(row(got, 10), ['frozen', '2000000000', '2000000000', 'clamp', '2000000000'], 'a full feed');
  assert.deepEqual(row(got, 56), ['frozen', '2000000000', '3000000000', 'clamp', '2250000000'], 'exactly 2 thin days: clamped');
  assert.deepEqual(row(got, 137), ['frozen', '2000000000', '3000000000', 'carried', '2000000000'], '3 thin days: carried');
  assert.deepEqual(row(got, 8453), ['frozen', '2000000000', '100000000000', 'carried', '2000000000'], 'no feed: the build\'s own reading moves nothing');
  for (const id of [10, 56, 137, 8453, 42161]) assert.deepEqual(row(got, id), [f2.chains.find((c) => c.chainId === id).L.rule, ...['used', 'stat', 'nextRule', 'next'].map((k) => f2.chains.find((c) => c.chainId === id).L[k])]);
  // D-21: the orphaned chain (no market, no feed) is clamped: its frozen L halves
  const o = run('d21-orphaned-chain', 6);
  const c = o.file.chains.find((x) => x.chainId === 56);
  assert.deepEqual([c.orphan !== null, c.liquiditySamples.length, Lof(o.got, 56).nextRule, Lof(o.got, 56).next], [true, 0, 'clamp', (BigInt(c.L.used) / 2n).toString()]);
});

// ── the kit's own F5 worlds (test/vectors/quote-v3.json, written by the oracle engine) ─────────────
test('the kit\'s F5 worlds: carried chains keep the L in force, clamped ones move by the clamp, a frozen L carried too', () => {
  const rows = (name) => world(name).expected.chains.map((c) => [c.chainId, c.L.rule, c.L.nextRule, c.L.used, c.L.next]);
  assert.deepEqual(rows('f5-carried-0-solo'), [
    [10, 'frozen', 'clamp', '2400000000', '2690000000'], [56, 'first', 'clamp', '500000000', '600000000'], [137, 'first', 'carried', '500000000', '500000000'],
    [8453, 'first', 'carried', '500000000', '500000000'], [43114, 'first', 'clamp', '500000000', '600000000'],
  ]);
  assert.deepEqual(rows('f5-carried-1').map((r) => r.slice(0, 3)), [[10, 'frozen', 'carried'], [56, 'first', 'carried'], [137, 'first', 'clamp'], [8453, 'first', 'clamp'], [43114, 'first', 'clamp']]);
  assert.equal(Lof(world('f5-carried-1').expected, 10).next, '2400000000', 'a frozen L carried: next = used');
  for (const name of ['f5-carried-0-solo', 'f5-carried-1']) {
    const w = world(name);
    const got = windowResult(prevOf(w), w.inputs);
    assert.deepEqual(got.chains, w.expected.chains, `${name}: the kit's chain records`);
  }
});

test('F5 changes only the next window\'s L: a full feed on a frozen chain leaves the burns and the capacity as they are', () => {
  let flipped = 0;
  for (const name of ['f5-carried-0-solo', 'f5-carried-1']) {
    const w = world(name);
    // a frozen L was set at the previous build (option a); a chain in its first week takes min(statistic, cap) of this
    // window's own readings (D-13 "first"), so only the frozen chains are given a full feed here
    const frozen = new Set(w.expected.chains.filter((c) => c.L.rule === 'frozen').map((c) => c.chainId));
    assert.ok(frozen.size > 0);
    const full = clone(w.inputs);
    for (const c of full.chains) if (frozen.has(c.chainId)) c.liquiditySamples = daySamples(full.window.endTs, '3000000000', FULL);
    const a = windowResult(prevOf(w), w.inputs);
    const b = windowResult(prevOf(w), full);
    for (const id of frozen) {
      assert.equal(Lof(b, id).nextRule, 'clamp', `${name} chain ${id}: a full feed is clamped`);
      if (Lof(a, id).nextRule === 'carried') flipped++;
    }
    assert.deepEqual([b.burns, b.capacity, b.shortfall, b.xnt], [a.burns, a.capacity, a.shortfall, a.xnt], `${name}: the window's values never depend on its feed`);
    assert.deepEqual(b.chains.map((c) => [c.chainId, c.L.used, c.L.rule]), a.chains.map((c) => [c.chainId, c.L.used, c.L.rule]), `${name}: the L in force is the same`);
    assert.deepEqual(b.chains.filter((c) => !frozen.has(c.chainId)), a.chains.filter((c) => !frozen.has(c.chainId)), `${name}: the other chains are untouched`);
  }
  assert.ok(flipped >= 1, 'a carried frozen chain becomes clamped with a full feed');
});

test('F5: one sample fewer on a day with exactly 4 makes it thin: 3 thin days, so the chain is carried', () => {
  const w = world('f5-carried-0-solo');
  const inp = clone(w.inputs);
  const c56 = inp.chains.find((c) => c.chainId === 56);
  const endTs = inp.window.endTs;
  const day5 = c56.liquiditySamples.filter((s) => Math.floor((endTs - s.hour * HOUR) / DAY) === 5);
  assert.equal(day5.length, 4);
  assert.deepEqual([Lof(windowResult(prevOf(w), inp), 56).nextRule, Lof(windowResult(prevOf(w), inp), 56).next], ['clamp', '600000000']);
  c56.liquiditySamples = c56.liquiditySamples.filter((s) => s !== day5[0]);
  const r = windowResult(prevOf(w), inp);
  assert.deepEqual([Lof(r, 56).nextRule, Lof(r, 56).next], ['carried', '500000000']);
  assert.equal(nextLiquidityV3(BigInt(Lof(r, 56).stat), 500_000_000n), 600_000_000n, 'without F5 the clamp would have raised it');
});

test('F5: a binding quote (a frozen L) never depends on the window feed', () => {
  let n = 0;
  for (const name of ['f5-carried-0-solo', 'f5-carried-1']) {
    const w = world(name);
    // the frozen chains lose their feed (carried or not, their L in force stays); a chain in its first week keeps its own
    // readings (its L, min(statistic, cap), sets the values of its burns, which share the week's capacity)
    const bare = clone(w.inputs);
    for (const c of bare.chains) if (Lof(w.expected, c.chainId).rule === 'frozen') delete c.liquiditySamples;
    for (const b of burnsOf(w.inputs).filter((x) => Lof(w.expected, x.chainId).rule === 'frozen')) {
      const q1 = quoteBurn(prevOf(w), prefixInputs(w.inputs, b), { ...b });
      const q2 = quoteBurn(prevOf(w), prefixInputs(bare, b), { ...b });
      assert.equal(q1.chain.Lbinding, true);
      assert.deepEqual([q1.bindingNow, q1.lp, q1.chain.L, q1.chain.Lrule], [q2.bindingNow, q2.lp, q2.chain.L, q2.chain.Lrule], `${name} ${b.txHash.slice(0, 10)}`);
      n++;
    }
  }
  assert.ok(n >= 1, `${n} quotes on a frozen chain`);
});
