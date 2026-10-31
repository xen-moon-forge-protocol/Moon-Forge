// node --test: the r6-review fixes of the D-13 liquidity rule in the kit's port (quote-v3.mjs), as the oracle engine has
// them (oracle/src/rewards.ts liquidityStatOfV3, switchLiquidityV3, liquidityCarriedV3 with switchEpoch; oracle tests
// price-rules.test.ts, f5-carried.test.ts and rewards.test.ts):
//  - r6-review 3: the statistic is taken over the FULL stat days only (4 recorded samples or more); a thin day and the
//    build's own reading (a pull at the known build time) never decide it while a full day exists;
//  - r6-review 2: the switch window's L is the median of the last (up to) 4 v2 liquidity readings (switchRefs[].liquidity),
//    and at the switch epoch the next L is clamped when the feed has at least 2 full stat days (carried with fewer).
// The oracle's golden world r6-full-day-stat is replayed by rules-vectors.test.mjs; the kit's own r6-switch worlds here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  HOUR, L_SWITCH_MIN_FULL_DAYS, liquidityCarriedV3, liquidityStatOfV3, liquidityStatV3, nextLiquidityV3, PRICE_RULES_V3, switchLiquidityV3, windowResult,
} from '../../quote-v3.mjs';
import { loadVectors, prevOf, REPO } from './helpers-v3.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));
const END = 1_800_000_000 - (1_800_000_000 % HOUR);
const endH = END / HOUR;
const S = (hour, micro) => ({ hour, micro });
const USD = 1_000_000n;
function daySamples(endTs, micro, counts) {
  const h = endTs / HOUR;
  return counts.flatMap((n, d) => Array.from({ length: n }, (_, i) => h - 24 * d - 1 - i)).sort((a, b) => a - b).map((hour) => ({ hour, micro }));
}

test('r6-review 2/3: the published members (switchL, switchMinFullDays, the full-day statistic) are in the rules block', () => {
  assert.equal(PRICE_RULES_V3.liquidity.stat, 'min-of-full-day-medians');
  assert.equal(PRICE_RULES_V3.liquidity.switchL, 'median-of-v2-readings');
  assert.equal(PRICE_RULES_V3.liquidity.switchMinFullDays, L_SWITCH_MIN_FULL_DAYS);
  assert.equal(L_SWITCH_MIN_FULL_DAYS, 2);
});

test('r6-review 2/3: the oracle engine in this repository has the same members (when present)', (t) => {
  const engine = path.join(REPO, 'oracle', 'src', 'rewards.ts');
  if (!fs.existsSync(engine)) return t.skip('oracle/src/rewards.ts is not present (kit used outside the repository)');
  const src = fs.readFileSync(engine, 'utf8');
  assert.equal(Number(/export const L_SWITCH_MIN_FULL_DAYS = (\d+);/.exec(src)?.[1]), L_SWITCH_MIN_FULL_DAYS);
  assert.ok(src.includes('stat: "min-of-full-day-medians" as const'));
  assert.ok(src.includes('switchL: "median-of-v2-readings" as const'));
});

test('r6-review 3: the statistic counts the full days only; the build reading only when nothing is recorded', () => {
  const sixFull = daySamples(END, 2_000n * USD, [0, 23, 23, 23, 23, 23, 23]);
  assert.equal(liquidityStatOfV3(sixFull, END, 0n), 2_000n * USD, 'the feed stopped in the last 24 h, the build read $0: not a sample');
  const thin0 = [...sixFull, S(endH - 3, 10n * USD), S(endH - 2, 10n * USD), S(endH - 1, 10n * USD)];
  assert.equal(liquidityStatOfV3(thin0, END, 0n), 2_000n * USD, 'a thin day never decides while a full day exists');
  assert.equal(liquidityStatV3(thin0, END), 10n * USD, '(the plain minimum over every day would take it)');
  assert.equal(liquidityStatOfV3([...thin0, S(endH - 4, 10n * USD)], END, 0n), 10n * USD, '4 samples: a full day counts');
  assert.equal(liquidityStatOfV3([S(endH - 30, 300n * USD), S(endH - 1, 700n * USD)], END, 0n), 300n * USD, 'only thin days: their medians');
  assert.equal(liquidityStatOfV3([], END, 42n), 42n, 'no feed: the build reading');
  assert.equal(nextLiquidityV3(liquidityStatOfV3(sixFull, END, 0n), 2_000n * USD), 2_000n * USD, 'the AR-5 pull does not halve the next L');
});

test('r6-review 2: the switch L is the median of the v2 liquidity readings; the switch epoch clamps with 2 full days', () => {
  assert.equal(switchLiquidityV3([50_000n * USD, 2_000n * USD, 2_100n * USD, 1_900n * USD]), 2_050n * USD);
  assert.equal(switchLiquidityV3([0n, 2_000n * USD]), 2_000n * USD, '0 = no reading');
  assert.equal(switchLiquidityV3([0n]), null);
  const days = (n) => Array.from({ length: n * 24 }, (_, i) => S(endH - n * 24 + 1 + i, 2_000n * USD));
  assert.deepEqual(liquidityCarriedV3(days(2), END, false, true), { carried: false, samples: 48, thinDays: 5 });
  assert.deepEqual(liquidityCarriedV3(days(2), END, false, false), { carried: true, samples: 48, thinDays: 5 });
  assert.deepEqual(liquidityCarriedV3(days(1), END, false, true), { carried: true, samples: 24, thinDays: 6 });
  assert.equal(liquidityCarriedV3([], END, true, true).carried, false, 'the orphan exemption holds at the switch');
});

test('r6-review 2: the kit\'s r6-switch worlds: used = the median of the switch history, next clamped with 2+ full days', () => {
  const v = loadVectors();
  const ws = v.worlds.filter((w) => w.name.startsWith('r6-switch-'));
  assert.equal(ws.length, 2);
  const seen = new Set();
  for (const w of ws) {
    const r = windowResult(prevOf(w), w.inputs);
    assert.deepEqual(r.chains, w.expected.chains, `${w.name}: the port gives the engine's L records`);
    for (const c of r.chains) {
      const ref = w.inputs.switchRefs.find((x) => x.chainId === c.chainId);
      const med = switchLiquidityV3(ref.liquidity.map(BigInt));
      assert.equal(c.L.rule, 'switch');
      assert.equal(c.L.used, med.toString(), `${w.name} chain ${c.chainId}: the median, not epoch-1's reading alone`);
      seen.add(c.L.nextRule);
    }
    // a switch history without its liquidity member, or with a first reading that is not epoch-1's, is refused
    const noLiq = clone(w.inputs);
    delete noLiq.switchRefs[0].liquidity;
    assert.throws(() => windowResult(prevOf(w), noLiq), /one liquidity reading per reading/);
    const wrong = clone(w.inputs);
    wrong.switchRefs[0].liquidity[0] = '5';
    assert.throws(() => windowResult(prevOf(w), wrong), /first liquidity reading must be epoch 1's liquidityUsdMicro/);
  }
  assert.deepEqual([...seen].sort(), ['carried', 'clamp'], 'both branches occur at the switch');
});
