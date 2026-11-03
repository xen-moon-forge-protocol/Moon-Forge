/**
 * The r9 Core-closed floor hatch on the site (src/v3/core-hatch.ts, src/v3/actions.ts buildRecycleArtifactV3): Core's
 * ProgramData is appended to recycle_artifact ONLY when the reads show Core closed under the upgradeable loader; the
 * addresses mirror constants.rs; and the LotteryRetired refusal (6100) is shown in plain words on any path (lib/errors.ts).
 */
import { describe, expect, it } from 'vitest';
import * as anchor from '@coral-xyz/anchor';
import fs from 'node:fs';
import path from 'node:path';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { parseV3Idl } from '../../src/v3/program';
import { buildRecycleArtifactV3 } from '../../src/v3/actions';
import {
    BPF_LOADER_UPGRADEABLE_ID, CORE_CLOSED_NOTICE, coreClosed, coreClosedOrFalse, MPL_CORE_ID, MPL_CORE_PROGRAMDATA, readCoreClosed, recycleRemainingAccounts,
} from '../../src/v3/core-hatch';
import { customErrorCode, staticErrorFor, v3ErrorFor } from '../../src/lib/errors';
import { errorMessage } from '../../src/lib/protocol';

const text = fs.readFileSync(path.resolve(__dirname, '../../src/idl/moon_forge.v3.json'), 'utf8');
const RS = path.resolve(__dirname, '../../../programs/moon-forge/src/constants.rs');
const LOADER = BPF_LOADER_UPGRADEABLE_ID;
const acct = (owner: PublicKey) => ({ owner, data: Buffer.alloc(0), lamports: 1, executable: false });
/** A mocked X1 read: the two accounts in the order the module asks for them. */
const conn = (core: any, pd: any, fail = false) => ({
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        if (fail) throw new Error('rpc down');
        expect(keys.map((k) => k.toBase58())).toEqual([MPL_CORE_ID.toBase58(), MPL_CORE_PROGRAMDATA.toBase58()]);
        return [core, pd];
    },
}) as any;

describe('Core-closed detection (artifacts.rs core_is_closed)', () => {
    it('closed only when Core is still under the upgradeable loader and its ProgramData is not', async () => {
        expect(await readCoreClosed(conn(acct(LOADER), acct(LOADER)))).toBe(false); // Core alive
        expect(await readCoreClosed(conn(acct(LOADER), null))).toBe(true); // ProgramData closed (no lamports: no account)
        expect(await readCoreClosed(conn(acct(LOADER), acct(SystemProgram.programId)))).toBe(true);
        expect(await readCoreClosed(conn(acct(Keypair.generate().publicKey), null))).toBe(false); // migrated to another loader
        expect(await readCoreClosed(conn(null, null))).toBe(false); // no Core account at all
        await expect(readCoreClosed(conn(null, null, true))).rejects.toThrow(/rpc down/);
        expect(await coreClosedOrFalse(conn(acct(LOADER), null, true))).toBe(false); // a failed read keeps the normal path
        expect(coreClosed({ owner: LOADER.toBase58() }, { owner: LOADER.toBase58() })).toBe(false);
        expect(CORE_CLOSED_NOTICE).toBe('Metaplex Core is closed on X1: recycling returns the floor without Core.');
    });
    it('the addresses are the program constants, and the ProgramData is the loader PDA of Core', () => {
        expect(PublicKey.findProgramAddressSync([MPL_CORE_ID.toBytes()], LOADER)[0].equals(MPL_CORE_PROGRAMDATA)).toBe(true);
        if (!fs.existsSync(RS)) return;
        const src = fs.readFileSync(RS, 'utf8');
        expect(src).toContain(`pub const BPF_LOADER_UPGRADEABLE_ID: Pubkey = pubkey!("${LOADER.toBase58()}");`);
        expect(src).toContain(`pub const MPL_CORE_PROGRAMDATA: Pubkey = pubkey!("${MPL_CORE_PROGRAMDATA.toBase58()}");`);
        expect(src).toContain(`pub const MPL_CORE_ID: Pubkey = pubkey!("${MPL_CORE_ID.toBase58()}");`);
    });
    it('recycle_artifact gets Core\'s ProgramData as the one remaining account only when Core is closed', async () => {
        const { idl } = await parseV3Idl(text);
        const w = { publicKey: Keypair.generate().publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t };
        const p = new anchor.Program(idl, new anchor.AnchorProvider(new Connection('http://127.0.0.1:1'), w as any, {}));
        const owner = Keypair.generate().publicKey; const asset = Keypair.generate().publicKey;
        const n = (JSON.parse(text).instructions as any[]).find((i) => i.name === 'recycle_artifact').accounts.length;
        const normal = await buildRecycleArtifactV3(p, owner, asset, false).instruction();
        expect(normal.keys).toHaveLength(n);
        const closed = await buildRecycleArtifactV3(p, owner, asset, true).instruction();
        expect(closed.keys).toHaveLength(n + 1);
        expect(closed.keys[n]).toEqual({ pubkey: MPL_CORE_PROGRAMDATA, isSigner: false, isWritable: false });
        expect(closed.keys.slice(0, n)).toEqual(normal.keys);
        expect(Buffer.from(closed.data).equals(Buffer.from(normal.data))).toBe(true);
        expect(recycleRemainingAccounts(false)).toEqual([]);
    });
});

describe('LotteryRetired (6100) in plain words on any path', () => {
    const want = /Burn Lottery is retired .* no donations/;
    it('from a hex custom error, a decimal log line and an AnchorError object, with or without the new IDL loaded', () => {
        const hex = { message: 'failed to send transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x17d4' };
        const dec = { logs: ['Program log: AnchorError occurred. Error Code: LotteryRetired. Error Number: 6100. Error Message: Burn Lottery tickets are retired since the final upgrade.'] };
        const ae = { error: { errorCode: { code: 'LotteryRetired', number: 6100 }, errorMessage: 'Burn Lottery tickets are retired since the final upgrade' } };
        for (const e of [hex, dec, ae]) {
            expect(customErrorCode(e)).toBe(6100);
            expect(staticErrorFor(e)).toMatch(want);
            expect(v3ErrorFor(e)).toMatch(want);
            expect(errorMessage(e)).toMatch(want);
        }
        expect(staticErrorFor({ message: 'custom program error: 0x1770' })).toBeNull(); // 6000: the IDL's own text applies
    });
});
