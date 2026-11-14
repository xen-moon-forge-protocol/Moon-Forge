import { describe, expect, it } from 'vitest';
import * as anchor from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import idlV3 from '../../src/idl/moon_forge.v3.json';
import epoch1 from '../../public/epochs/epoch-1.json';
import index from '../../public/epochs/index.json';
import {
    EXTRA_STATE_PDA, PROGRAM_PK, boundaryHold, boundaryPosition, effective, newestEntry, overrideAllowed, parseOverride, readRewards, rewardsFrom, rulesFromAccount,
    v2EstimateAllowed, versionOfEpochFile, type DetectionState,
} from '../../src/v3/detect';
import { V3_PDAS } from '../../src/v3/constants';
import { V3_BOUNDARY } from '../../src/v3/facts-v3';

const BN = anchor.BN;
const coder = new anchor.BorshAccountsCoder(idlV3 as anchor.Idl);
const extraStateBytes = async () => new Uint8Array(await coder.encode('ExtraState', {
    last_epoch: new BN(3), last_publish_ts: new BN(0), accounted: new BN(0), reserved: new BN(0), free_after: new BN(0), live_forged_backing: new BN(0),
    out_since_publish: new BN(0), total_in: new BN(0), total_paid: new BN(0), total_returned: new BN(0), vault_bump: 255, bump: 255,
}));

describe('rules detection (program)', () => {
    it('watches the ExtraState PDA of the pinned program', () => {
        expect(EXTRA_STATE_PDA.toBase58()).toBe(V3_PDAS.extraState);
        expect(PROGRAM_PK.toBase58()).toBe('57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9');
    });
    it('no account = rules 2 (today); a failed read = unknown', () => {
        expect(rulesFromAccount(null).rules).toBe(2);
        expect(rulesFromAccount(undefined).rules).toBe('unknown');
    });
    it('lamports sent to the address (System-owned, no data) do not switch anything on', () => {
        expect(rulesFromAccount({ owner: SystemProgram.programId, data: new Uint8Array() }).rules).toBe(2);
    });
    it('an ExtraState owned by the program = rules 3, decoded', async () => {
        const r = rulesFromAccount({ owner: PROGRAM_PK, data: await extraStateBytes() });
        expect(r.rules).toBe(3);
        expect(r.extraState?.lastEpoch).toBe(3n);
    });
    it('a program-owned account that does not decode = unknown (fail-closed)', async () => {
        const d = await extraStateBytes();
        d[3] ^= 0xff;
        expect(rulesFromAccount({ owner: PROGRAM_PK, data: d }).rules).toBe('unknown');
        expect(rulesFromAccount({ owner: PROGRAM_PK, data: (await extraStateBytes()).slice(0, 89) }).rules).toBe('unknown');
    });
    it('an ExtraState-shaped account owned by another program = rules 2', async () => {
        expect(rulesFromAccount({ owner: new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'), data: await extraStateBytes() }).rules).toBe(2);
    });
});

describe('rewards detection (newest epoch file)', () => {
    it('today: epoch 1 is a version-2 file', () => {
        expect(newestEntry(index as any)?.epoch).toBe(1);
        expect(versionOfEpochFile(epoch1)).toBe(2);
    });
    it('a version-3 body with window and capacity = 3; a bare "version: 3" = unknown', () => {
        const v3 = { version: 3, epoch: 2, window: { startTs: 1, endTs: 604_801 }, capacity: { cash: '123' }, leaves: [], root: '00' };
        expect(versionOfEpochFile(v3)).toBe(3);
        expect(versionOfEpochFile({ version: 3, leaves: [], root: '' })).toBe('unknown');
        expect(versionOfEpochFile({ ...v3, capacity: { cash: 12 } })).toBe('unknown');
        expect(versionOfEpochFile({ version: 4, leaves: [], root: '' })).toBe('unknown');
        expect(versionOfEpochFile(null)).toBe('unknown');
    });
    it('the newest entry wins whatever the order; a bad index throws', () => {
        expect(newestEntry({ epochs: [{ epoch: 3 }, { epoch: 1 }, { epoch: 2 }] })?.epoch).toBe(3);
        expect(newestEntry({ epochs: [] })).toBeNull();
        expect(() => newestEntry({} as any)).toThrow();
        expect(() => newestEntry({ epochs: [{ epoch: 0 }] })).toThrow();
    });
    it('readRewards: v2 today, 3 once the newest file is v3, unknown on a file/epoch mismatch, throws on HTTP errors', async () => {
        const files: Record<string, any> = { '/r/epochs/index.json': index, '/r/epochs/epoch-1.json': epoch1 };
        const fake = (m: Record<string, any>) => (async (u: string) => (u in m ? { ok: true, status: 200, json: async () => m[u] } : { ok: false, status: 404, json: async () => null })) as any;
        expect((await readRewards(fake(files), '/r/')).rewards).toBe(2);
        const v3 = { version: 3, epoch: 2, window: { startTs: 1, endTs: 604_801 }, capacity: { cash: '1' }, leaves: [], root: '00' };
        const two = { ...files, '/r/epochs/index.json': { epochs: [...(index as any).epochs, { epoch: 2 }] }, '/r/epochs/epoch-2.json': v3 };
        expect(await readRewards(fake(two), '/r/')).toEqual({ rewards: 3, newestEpoch: 2, newestVersion: 3, boundaryPassed: false });
        expect((await readRewards(fake({ ...two, '/r/epochs/epoch-2.json': { ...v3, epoch: 5 } }), '/r/')).rewards).toBe('unknown');
        await expect(readRewards(fake({ '/r/epochs/index.json': two['/r/epochs/index.json'] }), '/r/')).rejects.toThrow(/404/);
        expect((await readRewards(fake({ '/r/epochs/index.json': { epochs: [] } }), '/r/')).rewards).toBe(2);
    });
});

describe('the v2/v3 boundary (X-034, T9-25: burns after the last v2 publish tx are scored under v3)', () => {
    const files: Record<string, any> = { '/r/epochs/index.json': index, '/r/epochs/epoch-1.json': epoch1 };
    const fake = (m: Record<string, any>) => (async (u: string) => (u in m ? { ok: true, status: 200, json: async () => m[u] } : { ok: false, status: 404, json: async () => null })) as any;
    const epoch1Tx = (index as any).epochs[0].tx as string;

    it('today: no boundary announced, the shipped constant is null and nothing changes', async () => {
        expect(V3_BOUNDARY).toBeNull();
        expect(await readRewards(fake(files), '/r/')).toEqual({ rewards: 2, newestEpoch: 1, newestVersion: 2, boundaryPassed: false });
    });
    it('a version-2 newest entry whose tx is the announced boundary = rewards 3, a week before any version-3 file', async () => {
        expect(await readRewards(fake(files), '/r/', epoch1Tx)).toEqual({ rewards: 3, newestEpoch: 1, newestVersion: 2, boundaryPassed: true });
    });
    it('a boundary tx not listed yet = rewards 2 (the burn is then held by the Forge gate below)', async () => {
        const r = await readRewards(fake(files), '/r/', 'NotPublishedYetTx');
        expect([r.rewards, r.boundaryPassed]).toEqual([2, false]);
        expect(v2EstimateAllowed(r.rewards, { date: '2026-11-22', lastV2PublishTx: 'NotPublishedYetTx' })).toBe(false);
    });
    it('a version-2 file NEWER than the announced boundary = unknown (constant and files disagree: fail-closed)', async () => {
        const later = { ...epoch1, epoch: 2 };
        const m = { ...files, '/r/epochs/index.json': { epochs: [...(index as any).epochs, { epoch: 2, tx: 'LaterV2Tx' }] }, '/r/epochs/epoch-2.json': later };
        const r = await readRewards(fake(m), '/r/', epoch1Tx);
        expect([r.rewards, r.boundaryPassed]).toEqual(['unknown', true]);
    });
    it('a version-3 file stays rewards 3 with or without the boundary', async () => {
        const v3 = { version: 3, epoch: 2, window: { startTs: 1, endTs: 604_801 }, capacity: { cash: '1' }, leaves: [], root: '00' };
        const m = { ...files, '/r/epochs/index.json': { epochs: [...(index as any).epochs, { epoch: 2, tx: 'FirstV3Tx' }] }, '/r/epochs/epoch-2.json': v3 };
        expect((await readRewards(fake(m), '/r/', epoch1Tx)).rewards).toBe(3);
        expect((await readRewards(fake(m), '/r/', null)).rewards).toBe(3);
    });
    it('boundaryPosition and rewardsFrom', () => {
        expect(boundaryPosition(index as any, null, 1)).toBe('none');
        expect(boundaryPosition(index as any, epoch1Tx, 1)).toBe('newest');
        expect(boundaryPosition(index as any, epoch1Tx, 2)).toBe('older');
        expect(boundaryPosition(index as any, 'other', 1)).toBe('none');
        expect([rewardsFrom(2, 'none'), rewardsFrom(2, 'newest'), rewardsFrom(2, 'older'), rewardsFrom(3, 'older'), rewardsFrom('unknown', 'newest')])
            .toEqual([2, 3, 'unknown', 3, 'unknown']);
    });
    it('the Forge gate: today unchanged; once announced, a failed or pending read never falls back to the v2 estimate', async () => {
        // no boundary (today): the v2 path whatever the read state, exactly as the live release
        expect([2, 'unknown'].map((r) => v2EstimateAllowed(r as any, null))).toEqual([true, true]);
        expect(boundaryHold('unknown', null)).toBeNull();
        // date announced, transaction not yet, before the planned UTC date: v2 only on a positive rewards-2 read
        const dateOnly = { date: '2026-11-22', lastV2PublishTx: null };
        const before = Date.parse('2026-11-21T23:59:59Z');
        expect([v2EstimateAllowed(2, dateOnly, before), v2EstimateAllowed('unknown', dateOnly, before)]).toEqual([true, false]);
        expect(boundaryHold('unknown', dateOnly, before)).toBe('read-failed');
        // transaction known: never the v2 path
        const known = { date: '2026-11-22', lastV2PublishTx: epoch1Tx };
        expect([v2EstimateAllowed(2, known, before), v2EstimateAllowed('unknown', known, before)]).toEqual([false, false]);
        expect(boundaryHold(2, known, before)).toBe('tx-known');
        // boundary set + a fetch failure: readRewards throws, the store reads 'unknown' (or keeps a 3 already seen): the v2 path stays closed
        await expect(readRewards(fake({}), '/r/', epoch1Tx)).rejects.toThrow(/404/);
        expect(v2EstimateAllowed('unknown', known)).toBe(false);
    });
    it('the Forge gate from 00:00 UTC of the planned date: held until a release names the transaction (no v2 estimate for a v3 burn)', () => {
        const dateOnly = { date: '2026-11-22', lastV2PublishTx: null };
        const midnight = Date.parse('2026-11-22T00:00:00Z');
        expect(boundaryHold(2, dateOnly, midnight - 1)).toBeNull();
        expect(boundaryHold(2, dateOnly, midnight)).toBe('date-reached');
        expect(boundaryHold(2, dateOnly, midnight + 3 * 86_400_000)).toBe('date-reached');
        expect(v2EstimateAllowed(2, dateOnly, midnight)).toBe(false);
        // a malformed date never opens the v2 path
        expect([boundaryHold(2, { date: '11/08/2026', lastV2PublishTx: null }, 0), boundaryHold(2, { date: '', lastV2PublishTx: null }, 0)]).toEqual(['date-reached', 'date-reached']);
    });
});

describe('preview override', () => {
    it('only on a local host or an opted-in build', () => {
        expect(overrideAllowed('xen-moon-forge-protocol.github.io', undefined)).toBe(false);
        expect(overrideAllowed('localhost', undefined)).toBe(true);
        expect(overrideAllowed('127.0.0.1', undefined)).toBe(true);
        expect(overrideAllowed('example.org', '1')).toBe(true);
    });
    it('the public site ignores the query string entirely', () => {
        expect(parseOverride('?mf_rules=3&mf_rewards=3', null, false).override).toBeNull();
    });
    it('parses, remembers and clears', () => {
        expect(parseOverride('?mf_rules=2&mf_rewards=2', null, true)).toEqual({ override: { rules: 2, rewards: 2 }, remember: '{"rules":2,"rewards":2}' });
        expect(parseOverride('', '{"rules":3}', true).override).toEqual({ rules: 3 });
        expect(parseOverride('?mf_detect=clear', '{"rules":3}', true)).toEqual({ override: null, remember: null });
        expect(parseOverride('?mf_rules=7', null, true).override).toBeNull();
        expect(parseOverride('', 'not json', true).override).toBeNull();
    });
    it('the override wins over what was detected', () => {
        const s = { rules: 3, rewards: 2, override: { rules: 2 } } as unknown as DetectionState;
        expect(effective(s).rules).toBe(2);
        expect(effective(s).rewards).toBe(2);
        expect(effective({ ...s, override: null }).rules).toBe(3);
    });
});
