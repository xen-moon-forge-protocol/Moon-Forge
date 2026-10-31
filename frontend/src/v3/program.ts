/**
 * THE ONLY MODULE THAT READS src/idl/moon_forge.v3.json (the upgraded program's IDL, 92 instructions).
 *
 * src/idl/moon_forge.json stays the LIVE program's IDL (59 instructions) and is untouched: lib/protocol.ts keeps using
 * it for everything the live program does. Every rules-3 instruction the site builds goes through getProgramV3() here,
 * and only after rules detection reads 3 (src/v3/detect.ts). When the program build is re-synced, replacing the JSON
 * file is the whole change: the layout and constant tests (test/v3/*.test.ts) say what else moved.
 *
 * The IDL is loaded lazily (its own chunk, fetched only when a rules-3 path runs), so the live pages do not grow.
 */
import * as anchor from '@coral-xyz/anchor';
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { PROGRAM_ID_B58 } from '../lib/constants';
import { registerV3Errors } from '../lib/errors';

export interface V3Idl {
    idl: anchor.Idl;
    /** sha256 of the bundled JSON text, shown on Transparency once rules 3 is live (compare with the published one) */
    sha256: string;
    instructions: number;
    errors: { code: number; name: string; msg?: string }[];
}

async function sha256Hex(text: string): Promise<string> {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Parses and checks the new IDL text (exported for the tests). */
export async function parseV3Idl(text: string): Promise<V3Idl> {
    const idl = JSON.parse(text) as anchor.Idl & { address?: string; errors?: { code: number; name: string; msg?: string }[] };
    if (idl.address !== PROGRAM_ID_B58) throw new Error(`Moon Forge: the new IDL address (${idl.address}) is not the pinned program ${PROGRAM_ID_B58}`);
    return { idl, sha256: await sha256Hex(text), instructions: idl.instructions.length, errors: idl.errors ?? [] };
}

let loaded: Promise<V3Idl> | null = null;
export function loadV3Idl(): Promise<V3Idl> {
    if (!loaded) {
        loaded = import('../idl/moon_forge.v3.json?raw').then(async (m) => {
            const v = await parseV3Idl(m.default);
            registerV3Errors(v.errors);
            return v;
        }).catch((e) => {
            loaded = null;
            throw e;
        });
    }
    return loaded;
}

export interface WalletLike {
    publicKey: PublicKey | { toString(): string };
    signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
    signAllTransactions?<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
}

/** An Anchor client of the upgraded program (rules 3 only). Same wallet bridge as lib/protocol.ts getProgram. */
export async function getProgramV3(provider: WalletLike | null, connection: Connection): Promise<anchor.Program> {
    const { idl } = await loadV3Idl();
    const pk = provider ? new PublicKey(provider.publicKey.toString()) : PublicKey.default;
    const wallet = {
        publicKey: pk,
        signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => {
            if (!provider) throw new Error('Connect your X1 wallet first');
            return provider.signTransaction(tx);
        },
        signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => {
            if (!provider) throw new Error('Connect your X1 wallet first');
            if (provider.signAllTransactions) return provider.signAllTransactions(txs);
            const out: T[] = [];
            for (const t of txs) out.push(await provider.signTransaction(t));
            return out;
        },
    };
    const ap = new anchor.AnchorProvider(connection, wallet as any, { commitment: 'confirmed' });
    return new anchor.Program(idl, ap);
}

/** Message of a custom program error code of the upgraded program (6000 … 6100), or null. */
export async function v3ErrorText(code: number): Promise<string | null> {
    const { errors } = await loadV3Idl();
    const e = errors.find((x) => x.code === code);
    return e ? `${e.msg ?? e.name} (${e.name})` : null;
}
