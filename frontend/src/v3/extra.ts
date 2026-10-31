/**
 * Extra pot (rules 3): reads and claims of the weekly extra epochs (the rebate pot of forged Artifacts).
 *
 * Sources: the ExtraState account (src/v3/layout.ts), the ExtraEpoch account of each id (claim bitmap, budget, the
 * on-chain root), and the extra-<n>.json file the oracle publishes next to epoch-<n>.json (oracle/src/extra.ts
 * ExtraFileV1: leaves {index, wallet, amount}, proofs keyed by wallet). A leaf is offered for a claim only when the
 * file's root equals the on-chain root AND its proof walks to it in the browser (lib/verify-leaf.ts), the epoch is not
 * closed, the 48 h hold is over and its bit is not set. Used only under rules 3.
 */
import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { PROGRAM_PK } from './detect';
import { decodeExtraEpoch, leafClaimed, type ExtraEpochView, type ExtraStateView } from './layout';
import { BPS, CLAIM_HOLD_SECONDS, EXTRA_BACKING_BOUND_BPS, EXTRA_MAX_WEEKS, EXTRA_RELEASE_BPS } from './constants';
import { fromHex, verifyExtraLeaf } from '../lib/verify-leaf';

const enc = (s: string) => new TextEncoder().encode(s);
const u64 = (n: number | bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const pda = (...s: Uint8Array[]) => PublicKey.findProgramAddressSync(s, PROGRAM_PK)[0];

export const V3_PDA = {
    config: () => pda(enc('config')),
    rewardVault: () => pda(enc('reward_vault')),
    drawVault: () => pda(enc('draw_vault')),
    collection: () => pda(enc('collection')),
    artifactAuthority: () => pda(enc('artifact_authority')),
    extraState: () => pda(enc('extra_state')),
    extraVault: () => pda(enc('extra_vault')),
    extraEpoch: (id: number | bigint) => pda(enc('extra_epoch'), u64(id)),
    houseKeeper: () => pda(enc('house_keeper')),
    listing: (asset: PublicKey) => pda(enc('listing'), asset.toBytes()),
    asset: (t: number, s: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, s, true); return pda(enc('asset'), Uint8Array.of(t), b); },
    artifact: (asset: PublicKey) => pda(enc('artifact'), asset.toBytes()),
};

/**
 * The program's cap on one extra epoch (programs/moon-forge/src/instructions/extra.rs extra_bound), from ExtraState
 * counters only: free = accounted − reserved; cap = min(8% of free, weeks × ⌊4% of (live forged backing + backing out
 * since the last publication)⌋), weeks clamped to [1, EXTRA_MAX_WEEKS]. Null when reserved exceeds accounted (the
 * program refuses to publish then).
 */
export function extraBound(x: ExtraStateView, weeks = 1): { free: bigint; releaseCap: bigint; perWeek: bigint; cap: bigint } | null {
    if (x.reserved > x.accounted) return null;
    const w = BigInt(Math.min(EXTRA_MAX_WEEKS, Math.max(1, Math.floor(weeks))));
    const free = x.accounted - x.reserved;
    const releaseCap = (free * EXTRA_RELEASE_BPS) / BPS;
    const perWeek = ((x.liveForgedBacking + x.outSincePublish) * EXTRA_BACKING_BOUND_BPS) / BPS;
    const backingCap = perWeek * w;
    return { free, releaseCap, perWeek, cap: releaseCap < backingCap ? releaseCap : backingCap };
}

export interface ExtraFileLike {
    kind?: string;
    version?: number;
    epoch: number;
    root: string;
    leaves: { index: number; wallet: string; amount: string }[];
    proofs: Record<string, string[]>;
    totals?: { budget?: string; release?: string; eligibleArtifacts?: number; leaves?: number };
    skip?: { reason: string };
    window?: { startTs: number; endTs: number };
}

export type ExtraLeafStatus = 'claimable' | 'claimed' | 'on-hold' | 'closed' | 'not-published' | 'mismatch';

export interface MyExtraLeaf {
    epoch: number;
    index: number;
    amount: bigint;
    proof: string[];
    status: ExtraLeafStatus;
    /** unix seconds when the 48 h hold ends */
    opensAt: number | null;
    /** the browser walked the proof to the file root, and the file root is the on-chain root */
    verified: boolean;
    detail: string;
}

/** Pure: the status of one wallet leaf given the file and the on-chain epoch (null = not published on-chain). */
export function extraLeafStatus(file: ExtraFileLike, onChain: ExtraEpochView | null, wallet: string, now: number): MyExtraLeaf | null {
    const leaf = file.leaves.find((l) => l.wallet === wallet);
    if (!leaf) return null;
    const proof = file.proofs?.[wallet] ?? [];
    const check = verifyExtraLeaf({ epoch: file.epoch, index: leaf.index, wallet, amount: leaf.amount, proof, root: file.root });
    const base = { epoch: file.epoch, index: leaf.index, amount: BigInt(leaf.amount), proof };
    if (!onChain) return { ...base, status: 'not-published', opensAt: null, verified: false, detail: 'This extra epoch is not on X1 yet.' };
    const rootMatches = onChain.root === file.root.toLowerCase();
    if (!check.ok || !rootMatches || Number(onChain.id) !== file.epoch) {
        return { ...base, status: 'mismatch', opensAt: null, verified: false, detail: 'The published file does not match the root on X1: nothing is offered (fail-closed).' };
    }
    const opensAt = Number(onChain.publishedAt) + CLAIM_HOLD_SECONDS;
    if (leafClaimed(onChain.bitmap, leaf.index)) return { ...base, status: 'claimed', opensAt, verified: true, detail: 'Claimed.' };
    if (onChain.closed) return { ...base, status: 'closed', opensAt, verified: true, detail: 'This extra epoch is closed: the unclaimed amount went back to the extra pot.' };
    if (now < opensAt) return { ...base, status: 'on-hold', opensAt, verified: true, detail: 'Claims open 48 h after the publication, so anyone can check the file first.' };
    return { ...base, status: 'claimable', opensAt, verified: true, detail: 'Ready to claim.' };
}

const root = () => ((import.meta as any).env?.BASE_URL as string | undefined) ?? '/Moon-Forge/';

export async function fetchExtraFile(n: number, fetcher: typeof fetch = fetch): Promise<ExtraFileLike | null> {
    const r = await fetcher(`${root()}epochs/extra-${n}.json`, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`extra-${n}.json: HTTP ${r.status}`);
    const f = await r.json();
    if (f?.epoch !== n || !Array.isArray(f?.leaves) || typeof f?.root !== 'string') throw new Error(`extra-${n}.json does not parse as an extra file`);
    return f;
}

export async function fetchExtraEpoch(connection: Connection, id: number): Promise<ExtraEpochView | null> {
    const info = await connection.getAccountInfo(V3_PDA.extraEpoch(id));
    if (!info || !info.owner.equals(PROGRAM_PK)) return null;
    return decodeExtraEpoch(new Uint8Array(info.data));
}

/**
 * The wallet's extra leaves of the last `lookback` extra epochs up to `lastEpoch` (ExtraState.last_epoch). A file that
 * cannot be read is reported in `errors` ("could not load"), never as "nothing to claim".
 */
export async function fetchMyExtraLeaves(connection: Connection, wallet: PublicKey, lastEpoch: number, lookback = 14) {
    const out: MyExtraLeaf[] = [];
    const errors: string[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (let n = lastEpoch; n >= 1 && n > lastEpoch - lookback; n--) {
        try {
            const file = await fetchExtraFile(n);
            if (!file) continue;
            const onChain = await fetchExtraEpoch(connection, n);
            const s = extraLeafStatus(file, onChain, wallet.toBase58(), now);
            if (s) out.push(s);
        } catch (e: any) {
            errors.push(`extra epoch ${n}: ${String(e?.message ?? e).slice(0, 160)}`);
        }
    }
    return { leaves: out, errors };
}

/** Accounts of claim_extra (IDL order): config, extra_state, extra_epoch, extra_vault, wallet, payer, system_program. */
export function claimExtraAccounts(epoch: number, wallet: PublicKey, payer: PublicKey) {
    return {
        config: V3_PDA.config(), extraState: V3_PDA.extraState(), extraEpoch: V3_PDA.extraEpoch(epoch), extraVault: V3_PDA.extraVault(),
        wallet, payer, systemProgram: SystemProgram.programId,
    };
}
export const proofBytes = (proof: readonly string[]) => proof.map((h) => Array.from(fromHex(h)));
