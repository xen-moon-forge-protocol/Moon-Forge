/**
 * The r9 Core-closed floor hatch of recycle_artifact (programs/moon-forge/src/instructions/artifacts.rs core_is_closed):
 * if Metaplex Core was CLOSED under the upgradeable loader (its program account still owned by that loader, its ProgramData
 * account no longer owned by it), the holder passes Core's ProgramData as the one remaining account and the program pays
 * the floor without the burn (a closed program never runs again, so the asset is frozen for good). Otherwise nothing is
 * passed and the normal path burns the asset. The IDL did not change: the account goes in `remainingAccounts`.
 *
 * The two addresses mirror programs/moon-forge/src/constants.rs (BPF_LOADER_UPGRADEABLE_ID, MPL_CORE_PROGRAMDATA);
 * test/v3/core-hatch.test.ts checks them against that file and recomputes the ProgramData address. Pure decisions plus
 * one read (two accounts in a single call).
 */
import { Connection, PublicKey, type AccountMeta } from '@solana/web3.js';

export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const MPL_CORE_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
/** Core's ProgramData under the upgradeable loader: PDA [MPL_CORE_ID] of BPF_LOADER_UPGRADEABLE_ID. */
export const MPL_CORE_PROGRAMDATA = new PublicKey('9ZC25KLUrfgSoFVgjE1rrydZBbZns58UXi8A8ZhTdGfr');

export interface OwnerLike { owner: PublicKey | { toString(): string } }

/**
 * Pure, the program's own test: Core's program account exists and is owned by the upgradeable loader, and its ProgramData
 * account is NOT owned by that loader (a closed ProgramData has no lamports: the read returns null, i.e. not the loader).
 * A missing Core account, or Core owned by another loader (a migration), is never "closed".
 */
export function coreClosed(core: OwnerLike | null | undefined, programData: OwnerLike | null | undefined): boolean {
    if (!core) return false;
    if (core.owner.toString() !== BPF_LOADER_UPGRADEABLE_ID.toBase58()) return false;
    return !programData || programData.owner.toString() !== BPF_LOADER_UPGRADEABLE_ID.toBase58();
}

/** The remaining accounts recycle_artifact gets: Core's ProgramData only when Core is closed, else none. */
export function recycleRemainingAccounts(closed: boolean): AccountMeta[] {
    return closed ? [{ pubkey: MPL_CORE_PROGRAMDATA, isSigner: false, isWritable: false }] : [];
}

/** Reads both accounts in one call. Throws when X1 cannot be read (the caller then keeps the normal path). */
export async function readCoreClosed(connection: Pick<Connection, 'getMultipleAccountsInfo'>): Promise<boolean> {
    const [core, pd] = await connection.getMultipleAccountsInfo([MPL_CORE_ID, MPL_CORE_PROGRAMDATA], 'confirmed');
    return coreClosed(core, pd);
}

/** The read for a transaction: a failed read means the normal path (no remaining account), never a guess. */
export async function coreClosedOrFalse(connection: Pick<Connection, 'getMultipleAccountsInfo'>): Promise<boolean> {
    try { return await readCoreClosed(connection); } catch { return false; }
}

/** Shown on the Artifacts page when Core is detected closed. */
export const CORE_CLOSED_NOTICE = 'Metaplex Core is closed on X1: recycling returns the floor without Core.';
