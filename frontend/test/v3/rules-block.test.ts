/**
 * r4-fix (review r4 finding 7): the site's rules check (lib/quote.ts rulesOf) refuses every rules block it does not
 * implement, as the kit's does (agents/kit/quote-v3.mjs: priceRules equal to PRICE_RULES_V3). Before the fix it read only
 * programRules, the tie-break, the backlog and operator rules: a new rulesId with other D-13 cap numbers, another gate or
 * another tip minimum kept giving "binding" quotes from the site's own constants. The real block is the one the oracle's
 * rules vectors carry (oracle/test/fixtures/rules-v3-vectors.json, read from this checkout; built from constants when absent).
 * F5: that block is rulesId 2, with the carried-L members of priceRules.liquidity; rulesId 1 is refused, as the oracle does.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AUTO_CLAIM_MIN, L_MAX_THIN_DAYS, L_MIN_SAMPLES_PER_DAY, PRICE_RULES, RULES_ID, RULES_ID_RETIRED, rulesOf, sortedJson, TIP_MIN } from '../../src/lib/quote';

const VECTORS = path.resolve(__dirname, '../../../oracle/test/fixtures/rules-v3-vectors.json');
const fromVectors = (): any | null => {
    if (!fs.existsSync(VECTORS)) return null;
    const doc = JSON.parse(fs.readFileSync(VECTORS, 'utf8'));
    return doc.worlds?.[0]?.epochs?.[0]?.file?.rulesBlock ?? null;
};
const BLOCK: any = fromVectors() ?? {
    programRules: 3, programHash: null, rulesId: 2, tipMin: TIP_MIN.toString(), autoClaimMin: AUTO_CLAIM_MIN.toString(), dustRule: { vestMinEnt: '20000000' },
    tieBreak: 'keccak256(txHash,logIndex)', backlogRule: 'after-current-senior,first-leftover', operatorWallets: { rule: 'rank-last', wallets: [], exceptions: [] },
    priceRules: JSON.parse(JSON.stringify(PRICE_RULES)),
};
const mutate = (f: (b: any) => void) => {
    const b = JSON.parse(JSON.stringify(BLOCK));
    f(b);
    return b;
};

describe('rulesOf: only the rules block this mirror implements', () => {
    it('accepts the oracle\'s own block, whose priceRules are exactly the site\'s PRICE_RULES', () => {
        expect(rulesOf(BLOCK)).not.toBeNull();
        expect(sortedJson(BLOCK.priceRules)).toBe(sortedJson(PRICE_RULES));
        expect([String(BLOCK.tipMin), String(BLOCK.autoClaimMin)]).toEqual([TIP_MIN.toString(), AUTO_CLAIM_MIN.toString()]);
        // key order does not matter, values do
        const reordered = mutate((b) => { b.priceRules = Object.fromEntries(Object.entries(b.priceRules).reverse()); });
        expect(rulesOf(reordered)).not.toBeNull();
    });

    it('refuses a block with other price rules (no quote), as the kit does', () => {
        for (const f of [
            (b: any) => { b.priceRules.liquidity.dropBps = 4_000; }, // D-13 cap numbers changed
            (b: any) => { b.priceRules.liquidity.growthBps += 1; },
            (b: any) => { b.priceRules.gate.holdSeconds = 3_600; }, // another anomaly gate
            (b: any) => { b.priceRules.xntPeg.guardBps = 500; },
            (b: any) => { b.priceRules.orphan.skips = 3; },
            (b: any) => { b.priceRules.proofPlan = { exception: true }; }, // an added member
            (b: any) => { delete b.priceRules.xntPool; },
            (b: any) => { delete b.priceRules; },
        ]) {
            expect(rulesOf(mutate(f))).toBeNull();
        }
    });

    it('F5: rules block 2 carries the carried-L parameters; rulesId 1 (the round-4 block, replaced before any v3 epoch) is refused', () => {
        expect([RULES_ID, RULES_ID_RETIRED]).toEqual([2, 1]);
        expect(BLOCK.rulesId).toBe(RULES_ID);
        expect([BLOCK.priceRules.liquidity.minSamplesPerDay, BLOCK.priceRules.liquidity.maxThinDays]).toEqual([4, 2]);
        expect([PRICE_RULES.liquidity.minSamplesPerDay, PRICE_RULES.liquidity.maxThinDays]).toEqual([L_MIN_SAMPLES_PER_DAY, L_MAX_THIN_DAYS]);
        for (const id of [1, 0, -1, 1.5, '2', null]) expect(rulesOf(mutate((b) => { b.rulesId = id; })), `rulesId ${JSON.stringify(id)}`).toBeNull();
        expect(rulesOf(mutate((b) => { delete b.rulesId; }))).toBeNull();
        // a later rules version with the same rules would still be read (a new rulesId is announced, D-20)
        expect(rulesOf(mutate((b) => { b.rulesId = 3; }))?.rulesId).toBe(3);
        // the round-4 block: rulesId 1 and no F5 members
        const round4 = mutate((b) => { b.rulesId = 1; delete b.priceRules.liquidity.minSamplesPerDay; delete b.priceRules.liquidity.maxThinDays; });
        expect(rulesOf(round4)).toBeNull();
        expect(rulesOf({ ...round4, rulesId: 2 })).toBeNull();
        for (const f of [
            (b: any) => { delete b.priceRules.liquidity.minSamplesPerDay; },
            (b: any) => { delete b.priceRules.liquidity.maxThinDays; },
            (b: any) => { b.priceRules.liquidity.minSamplesPerDay = 3; },
            (b: any) => { b.priceRules.liquidity.maxThinDays = 3; },
            (b: any) => { b.priceRules.liquidity.maxThinDays = '2'; },
        ]) {
            expect(rulesOf(mutate(f))).toBeNull();
        }
    });

    it('refuses another tip minimum or auto-claim minimum', () => {
        expect(rulesOf(mutate((b) => { b.tipMin = '100000000'; }))).toBeNull();
        expect(rulesOf(mutate((b) => { b.autoClaimMin = '1'; }))).toBeNull();
        expect(rulesOf(mutate((b) => { delete b.tipMin; }))).toBeNull();
    });

    it('sortedJson is canonical', () => {
        expect(sortedJson({ b: 1, a: [2, { d: 3, c: '4' }] })).toBe('{"a":[2,{"c":"4","d":3}],"b":1}');
        expect(sortedJson(undefined)).toBe('null');
    });
});
