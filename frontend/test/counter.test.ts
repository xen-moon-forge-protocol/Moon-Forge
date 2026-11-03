/**
 * The public counter (src/lib/counter.ts): XEN removed per chain and XNT set aside, from the epoch files only. Checked on
 * synthetic files (dedupe, sums, missing budgets, malformed input refused) and on the epoch files shipped with the site.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { counterMatchesIndex, decimal, summarizeEpochFiles } from '../src/lib/counter';

const burn = (chainId: number, tx: string, logIndex: number, amountWei: string) => ({ chainId, txHash: tx, logIndex, amountWei, tier: 0 });

describe('public counter', () => {
    it('sums XEN per chain once per burn and the published budgets', () => {
        const f1 = { version: 2, programId: 'P', epoch: 1, createdAt: '2026-10-18T01:38:05.469Z', chains: [{ chainId: 10, name: 'Optimism' }], burns: [burn(10, '0xAA', 1, '1500000000000000000000000')], publish: { tx: 't', budget: '388359377' } };
        const f2 = {
            version: 3, programId: 'P', epoch: 2, createdAt: '2026-11-22T00:00:00.000Z', chains: [{ chainId: 10, name: 'Optimism' }, { chainId: 56, name: 'BNB Chain' }],
            burns: [burn(10, '0xaa', 1, '1500000000000000000000000'), burn(10, '0xBB', 3, '500000000000000000000000'), burn(56, '0xCC', 0, '2000000000000000000')], publish: { tx: 'u', budget: '1000000000' },
        };
        const f3 = { version: 3, epoch: 3, createdAt: '2026-11-29T00:00:00.000Z', chains: [], burns: [], heartbeat: true, publish: { tx: 'v' } };
        const c = summarizeEpochFiles([f3, f2, f1]);
        expect(c.kind).toBe('moonforge-public-counter');
        expect(c.newestEpoch).toBe(3);
        expect(c.asOf).toBe('2026-11-29T00:00:00.000Z');
        expect(c.epochs).toBe(3);
        expect(c.burns).toBe(3); // 0xAA / 0xaa log 1 on chain 10 counted once
        expect(c.chains).toEqual([
            { chainId: 10, name: 'Optimism', burns: 2, xenWei: '2000000000000000000000000', xen: '2000000' },
            { chainId: 56, name: 'BNB Chain', burns: 1, xenWei: '2000000000000000000', xen: '2' },
        ]);
        expect(c.xen).toBe('2000002');
        expect(c.xntSetAsideLamports).toBe('1388359377');
        expect(c.xntSetAside).toBe('1.3883');
        expect(c.epochsWithoutBudget).toEqual([3]);
        expect(counterMatchesIndex(c, 3)).toBe(true);
        expect(counterMatchesIndex(c, 4)).toBe(false);
        expect(counterMatchesIndex(null, 3)).toBe(false);
        expect(c.notes.join(' ')).not.toMatch(/\b(earn|yield|profit|guarantee|return)\w*/i);
    });
    it('refuses a partial or malformed set instead of counting it', () => {
        expect(() => summarizeEpochFiles([{ epoch: 1 }])).toThrow(/not an epoch file/);
        expect(() => summarizeEpochFiles([{ epoch: 1, burns: [{ chainId: 10, txHash: '0x', amountWei: '-5' }] }])).toThrow(/malformed burn/);
        expect(() => summarizeEpochFiles([{ epoch: 1, burns: [] }, { epoch: 1, burns: [] }])).toThrow(/twice/);
        expect(summarizeEpochFiles([]).newestEpoch).toBeNull();
    });
    it('decimal formatting', () => {
        expect(decimal(1_234_567_890_000_000_000n, 18)).toBe('1.23');
        expect(decimal(5n, 9, 4)).toBe('0');
        expect(decimal(388_359_377n, 9, 4)).toBe('0.3883');
    });
    it('the epoch files shipped with the site summarize', () => {
        const dir = path.resolve(__dirname, '../public/epochs');
        const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
        const files = index.epochs.map((e: any) => JSON.parse(fs.readFileSync(path.join(dir, `epoch-${e.epoch}.json`), 'utf8')));
        const c = summarizeEpochFiles(files);
        expect(c.epochs).toBe(index.epochs.length);
        expect(c.programId).toBe('57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9');
        expect(BigInt(c.xenWei)).toBeGreaterThan(0n);
    });
});
