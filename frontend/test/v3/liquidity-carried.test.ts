/**
 * F5, the D-13 "carried" rule (owner approval 2026-10-25), in the site's mirror (lib/quote.ts): a valued chain whose hourly
 * feed was missing or thin in the window (more than L_MAX_THIN_DAYS of the L_STAT_DAYS stat days with fewer than
 * L_MIN_SAMPLES_PER_DAY RECORDED samples, or none at all) keeps its L for the next window; an orphaned chain (D-21) is never
 * carried. The branches are checked here on their own; with the oracle installed in this checkout, the site's functions are
 * also compared with rewards.ts recordedLiquiditySamplesV3 / liquidityDaysV3 / liquidityCarriedV3 / liquidityStatV3 on
 * seeded sample sets. test/v3/rules-vectors.test.ts replays the engine's own files (L.next and L.nextRule).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    DAY, HOUR, L_MAX_THIN_DAYS, L_MIN_SAMPLES_PER_DAY, L_STAT_DAYS, L_SWITCH_MIN_FULL_DAYS, liquidityCarried, liquidityDays, liquidityStat, liquidityStatOf,
    recordedLiquiditySamples, switchLiquidity, switchLOf, windowLOf,
} from '../../src/lib/quote';
import { rewardsV3 } from '../../src/v3/facts-v3';

const ORACLE = path.resolve(__dirname, '../../../oracle');
const oracleReady = fs.existsSync(path.join(ORACLE, 'node_modules', '@solana', 'web3.js')) && fs.existsSync(path.join(ORACLE, 'src', 'rewards.ts'));

/** A window end on an hour boundary, and the hour of day d's k-th sample, k < 23 (day 0 = the last 24 h before the end, end hour excluded). */
const END = 1_800_000_000 - (1_800_000_000 % HOUR);
const hourOf = (d: number, k: number) => Math.floor((END - d * DAY) / HOUR) - 1 - k;
/** `perDay[d]` samples on stat day d (ascending hours, as the feed records them). */
function feed(perDay: number[], micro = 1_000_000_000n): { hour: number; micro: string }[] {
    const out: { hour: number; micro: string }[] = [];
    perDay.forEach((n, d) => { for (let k = 0; k < n; k++) out.push({ hour: hourOf(d, k), micro: micro.toString() }); });
    return out.sort((a, b) => a.hour - b.hour);
}
const carriedOf = (perDay: number[], orphan = false) => liquidityCarried(recordedLiquiditySamples(feed(perDay), END), END, orphan);

describe('F5: the carried L (lib/quote.ts liquidityCarried)', () => {
    it('has the rules block 2 parameters, and the v3 text states them', () => {
        expect([L_MIN_SAMPLES_PER_DAY, L_MAX_THIN_DAYS, L_STAT_DAYS]).toEqual([4, 2, 7]);
        expect(rewardsV3.order).toContain(`fewer than ${L_MIN_SAMPLES_PER_DAY} on more than ${L_MAX_THIN_DAYS} of its last ${L_STAT_DAYS} days, or none at all`);
        expect(rewardsV3.order).toContain('an orphaned chain excepted');
    });

    it('a full feed is not carried; no feed is carried', () => {
        expect(carriedOf([23, 23, 23, 23, 23, 23, 23])).toEqual({ carried: false, samples: 161, thinDays: 0 });
        expect(carriedOf([])).toEqual({ carried: true, samples: 0, thinDays: 7 });
        expect(liquidityCarried([], END, false).carried).toBe(true);
    });

    it('exactly 2 thin days is not carried, 3 is; 4 samples make a day, 3 do not', () => {
        expect(carriedOf([4, 4, 4, 4, 4, 0, 0])).toEqual({ carried: false, samples: 20, thinDays: 2 });
        expect(carriedOf([4, 4, 4, 4, 0, 0, 0])).toEqual({ carried: true, samples: 16, thinDays: 3 });
        expect(carriedOf([4, 4, 4, 4, 4, 3, 3]).carried).toBe(false);
        expect(carriedOf([4, 4, 4, 4, 3, 3, 3]).carried).toBe(true);
        // removing one sample from a 4-sample day flips the chain to carried
        expect(carriedOf([4, 4, 4, 4, 4, 3, 0]).carried).toBe(false);
        expect(carriedOf([4, 4, 4, 3, 4, 3, 0]).carried).toBe(true);
    });

    it('counts zero readings as samples; an orphaned chain is never carried', () => {
        const zeros = recordedLiquiditySamples(feed([5, 5, 5, 5, 5, 5, 5], 0n), END);
        expect(liquidityCarried(zeros, END, false)).toEqual({ carried: false, samples: 35, thinDays: 0 });
        expect(carriedOf([], true)).toEqual({ carried: false, samples: 0, thinDays: 7 });
        expect(carriedOf([0, 0, 0, 1, 1, 1, 1], true).carried).toBe(false);
    });

    it('does not count the build\'s own reading, samples older than 7 days, or anything after the end', () => {
        // r6-review 3: the build's reading is the statistic only when nothing is recorded, and never a coverage sample
        const rec = recordedLiquiditySamples(feed([4, 4, 4, 4, 0, 0, 0]), END);
        expect(liquidityStatOf(rec, END, 7n)).toBe(1_000_000_000n);
        expect(liquidityStatOf([], END, 7n)).toBe(7n);
        expect(carriedOf([4, 4, 4, 4, 0, 0, 0]).carried).toBe(true);
        // a sample recorded at the end's own hour is day 0 (it counts)
        const atEnd = [...feed([3, 4, 4, 4, 4, 4, 4]), { hour: END / HOUR, micro: '1' }];
        expect(liquidityCarried(recordedLiquiditySamples(atEnd, END), END, false)).toEqual({ carried: false, samples: 28, thinDays: 0 });
        // the 7-day edge: an hour starting exactly 7 days before the end is day 7 (not counted); one hour later is day 6
        const edge = Math.floor((END - L_STAT_DAYS * DAY) / HOUR);
        expect([...liquidityDays([{ hour: edge, micro: 1n }], END).keys()]).toEqual([]);
        expect([...liquidityDays([{ hour: edge + 1, micro: 1n }], END).keys()]).toEqual([6]);
        const old = [{ hour: edge - 30, micro: '1' }, { hour: edge, micro: '1' }, ...feed([23, 23, 23, 23, 0, 0, 0])];
        expect(liquidityCarried(recordedLiquiditySamples(old, END), END, false)).toEqual({ carried: true, samples: 92, thinDays: 3 });
        expect(() => recordedLiquiditySamples([{ hour: END / HOUR + 1, micro: '1' }], END)).toThrow(/after the window end/);
        expect(() => recordedLiquiditySamples([{ hour: 5, micro: '1' }, { hour: 5, micro: '1' }], END)).toThrow(/ascending/);
    });

    it('the statistic and the coverage bucket by the same days', () => {
        const rec = recordedLiquiditySamples(feed([6, 5, 4, 3, 2, 1, 0], 2_000_000_000n), END);
        const days = liquidityDays(rec, END);
        expect([...days.entries()].map(([d, v]) => [d, v.length]).sort((a, b) => a[0] - b[0])).toEqual([[0, 6], [1, 5], [2, 4], [3, 3], [4, 2], [5, 1]]);
        expect(liquidityStat(rec, END)).toBe(2_000_000_000n);
        expect(liquidityCarried(rec, END, false)).toEqual({ carried: true, samples: 21, thinDays: 4 });
    });
});

describe.skipIf(!oracleReady)('F5: lib/quote.ts == oracle/src/rewards.ts on seeded sample sets', () => {
    it('recorded samples, day buckets, coverage and statistic agree', async () => {
        const R: any = await import('../../../oracle/src/rewards');
        expect([R.L_MIN_SAMPLES_PER_DAY, R.L_MAX_THIN_DAYS, R.L_STAT_DAYS]).toEqual([L_MIN_SAMPLES_PER_DAY, L_MAX_THIN_DAYS, L_STAT_DAYS]);
        let x = 0x9e3779b97f4a7c15n;
        const M = (1n << 64n) - 1n;
        const rnd = (n: number) => { x ^= (x << 13n) & M; x ^= x >> 7n; x ^= (x << 17n) & M; return Number(x % BigInt(n)); };
        const seen = { carried: 0, clamp: 0, orphan: 0 };
        for (let t = 0; t < 400; t++) {
            // 0..9 days of coverage, each 0..7 samples, sometimes zero readings, sometimes older samples
            const perDay = Array.from({ length: 7 + rnd(3) }, () => (rnd(4) === 0 ? 0 : rnd(8)));
            const rec = feed(perDay, rnd(5) === 0 ? 0n : BigInt(1 + rnd(5_000)) * 1_000_000n);
            const orphan = rnd(10) === 0;
            const mine = recordedLiquiditySamples(rec, END);
            const theirs = R.recordedLiquiditySamplesV3(rec, END, 'seeded');
            expect(mine).toEqual(theirs);
            expect([...liquidityDays(mine, END).entries()].sort((a, b) => a[0] - b[0])).toEqual([...R.liquidityDaysV3(theirs, END).entries()].sort((a: any, b: any) => a[0] - b[0]));
            const c = liquidityCarried(mine, END, orphan);
            expect(c, `case ${t}: ${JSON.stringify(perDay)} orphan ${orphan}`).toEqual(R.liquidityCarriedV3(theirs, END, orphan));
            const build = BigInt(rnd(9_000)) * 1_000_000n;
            // r6-review 3: the statistic the build records; r6-review 2: the switch epoch's coverage
            expect(liquidityStatOf(mine, END, build)).toBe(R.liquidityStatOfV3(theirs, END, build));
            expect(liquidityCarried(mine, END, orphan, true)).toEqual(R.liquidityCarriedV3(theirs, END, orphan, true));
            if (liquidityDays(mine, END).size) expect(liquidityStat(mine, END)).toBe(R.liquidityStatV3(theirs, END));
            const liq = Array.from({ length: 1 + rnd(4) }, () => (rnd(4) === 0 ? 0n : BigInt(1 + rnd(9_000)) * 1_000_000n));
            expect(switchLiquidity(liq)).toBe(R.switchLiquidityV3(liq));
            if (orphan) seen.orphan++;
            else if (c.carried) seen.carried++;
            else seen.clamp++;
        }
        expect(seen.carried).toBeGreaterThan(10);
        expect(seen.clamp).toBeGreaterThan(10);
        expect(seen.orphan).toBeGreaterThan(5);
    }, 120_000);
});

describe('r6-review 2 and 3: the switch L and the full-day statistic (lib/quote.ts)', () => {
    it('the statistic counts the full days only: a thin last day and a build reading of 0 decide nothing', () => {
        const six = recordedLiquiditySamples(feed([0, 23, 23, 23, 23, 23, 23], 2_000_000_000n), END);
        expect(liquidityStatOf(six, END, 0n)).toBe(2_000_000_000n);
        const thin0 = recordedLiquiditySamples([...feed([0, 23, 23, 23, 23, 23, 23], 2_000_000_000n), ...[3, 2, 1].map((k) => ({ hour: END / HOUR - k, micro: '1000000' }))].sort((a, b) => a.hour - b.hour), END);
        expect(liquidityStatOf(thin0, END, 0n)).toBe(2_000_000_000n);
        expect(liquidityStat(thin0, END)).toBe(1_000_000n);
    });

    it('at the switch epoch 2 full days clamp the next L (carried with fewer); the orphan exemption holds', () => {
        expect(L_SWITCH_MIN_FULL_DAYS).toBe(2);
        const two = recordedLiquiditySamples(feed([23, 23, 0, 0, 0, 0, 0]), END);
        expect(liquidityCarried(two, END, false, true)).toEqual({ carried: false, samples: 46, thinDays: 5 });
        expect(liquidityCarried(two, END, false, false).carried).toBe(true);
        expect(liquidityCarried(recordedLiquiditySamples(feed([23, 0, 0, 0, 0, 0, 0]), END), END, false, true).carried).toBe(true);
        expect(liquidityCarried([], END, true, true).carried).toBe(false);
    });

    it('the switch L is the median of the feed\'s switchRefs liquidity history; without it a v2 chain gets no binding L', () => {
        expect(switchLiquidity([50_000_000_000n, 2_000_000_000n, 2_100_000_000n, 1_900_000_000n])).toBe(2_050_000_000n);
        expect(switchLiquidity([0n])).toBeNull();
        const v2 = { version: 2, epoch: 1, chains: [{ chainId: 10, liquidityUsdMicro: '1197713900', xenUsdE18: '1' }] };
        const refs = [{ chainId: 10, readings: ['1', '1', '1'], liquidity: ['1197713900', '1000000000', '1300000000'] }];
        expect(switchLOf(refs, 10, 1_197_713_900n)).toBe(1_197_713_900n);
        expect(windowLOf(v2, 10, refs)).toEqual({ L: 1_197_713_900n, rule: 'switch', prevL: 1_197_713_900n });
        expect(windowLOf(v2, 10, [{ ...refs[0], liquidity: ['1197713900', '1000000000', '900000000'] }]).L).toBe(1_000_000_000n);
        // fail-closed: no history, a first reading that is not the file's own, one reading short, a bad integer
        expect(windowLOf(v2, 10).L).toBeNull();
        expect(windowLOf(v2, 10, [{ ...refs[0], liquidity: ['5', '1000000000', '1300000000'] }]).L).toBeNull();
        expect(windowLOf(v2, 10, [{ ...refs[0], liquidity: ['1197713900', '1000000000'] }]).L).toBeNull();
        expect(windowLOf(v2, 10, [{ ...refs[0], liquidity: ['1197713900', '-1', '1'] }]).L).toBeNull();
    });
});