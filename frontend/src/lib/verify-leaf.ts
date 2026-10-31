/**
 * Verify-this-leaf: recompute a claim leaf and walk its Merkle proof to the published root, in the browser, with the
 * same byte layout the program checks on-chain (programs/moon-forge/src/utils.rs verify_proof; oracle/src/merkle.ts):
 *
 *   base leaf  = keccak("MOONFORGE_V2_CLAIM" ‖ epoch u64 LE ‖ player 32 ‖ tier u8 ‖ score u64 LE)
 *   extra leaf = keccak("MOONFORGE_V3_EXTRA" ‖ epoch u64 LE ‖ index u32 LE ‖ wallet 32 ‖ amount u64 LE)   (rules 3)
 *   parent     = keccak(min(a, b) ‖ max(a, b)); an odd node is promoted unchanged.
 *
 * Golden vector (test/verify-leaf.test.ts): the single leaf of epoch 1 reproduces root d277eb36…b358.
 * Pure: no network, no React.
 */
import { PublicKey } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';

const enc = (s: string) => new TextEncoder().encode(s);
export const LEAF_DOMAIN_BASE = enc('MOONFORGE_V2_CLAIM');
export const LEAF_DOMAIN_EXTRA = enc('MOONFORGE_V3_EXTRA');

const keccak = (...parts: Uint8Array[]) => {
    const h = keccak_256.create();
    for (const p of parts) h.update(p);
    return h.digest();
};
const u64le = (v: bigint) => {
    if (v < 0n || v >= 1n << 64n) throw new Error(`${v} does not fit in a u64`);
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    return b;
};
const u32le = (v: number) => {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) throw new Error(`${v} does not fit in a u32`);
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    return b;
};
export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h: string): Uint8Array {
    const s = h.startsWith('0x') ? h.slice(2) : h;
    if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error('not a hex string');
    return Uint8Array.from(s.match(/.{2}/g) ?? [], (x) => parseInt(x, 16));
}
const cmp = (a: Uint8Array, b: Uint8Array) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
};
export const hashPair = (a: Uint8Array, b: Uint8Array) => (cmp(a, b) <= 0 ? keccak(a, b) : keccak(b, a));

export function baseLeaf(epoch: number | bigint, player: string, tier: number, score: bigint | string): Uint8Array {
    if (!Number.isInteger(tier) || tier < 0 || tier > 255) throw new Error('bad tier');
    return keccak(LEAF_DOMAIN_BASE, u64le(BigInt(epoch)), new PublicKey(player).toBytes(), Uint8Array.of(tier), u64le(BigInt(score)));
}

export function extraLeaf(epoch: number | bigint, index: number, wallet: string, amount: bigint | string): Uint8Array {
    return keccak(LEAF_DOMAIN_EXTRA, u64le(BigInt(epoch)), u32le(index), new PublicKey(wallet).toBytes(), u64le(BigInt(amount)));
}

/** The root a leaf and its proof walk to. */
export function rootOf(leaf: Uint8Array, proof: readonly string[]): Uint8Array {
    let c = leaf;
    for (const n of proof) c = hashPair(c, fromHex(n));
    return c;
}

export interface LeafCheck {
    ok: boolean;
    leaf: string;
    computedRoot: string;
    expectedRoot: string;
}

/** Verifies a base (v2 claim) leaf of an epoch file against the file's root and, if given, the on-chain root. */
export function verifyBaseLeaf(a: { epoch: number; player: string; tier: number; score: string; proof: readonly string[]; root: string }): LeafCheck {
    const leaf = baseLeaf(a.epoch, a.player, a.tier, a.score);
    const computed = toHex(rootOf(leaf, a.proof));
    return { ok: computed === a.root.toLowerCase(), leaf: toHex(leaf), computedRoot: computed, expectedRoot: a.root.toLowerCase() };
}

/** Verifies an extra-pot leaf (rules 3) of an extra file against its root. */
export function verifyExtraLeaf(a: { epoch: number; index: number; wallet: string; amount: string; proof: readonly string[]; root: string }): LeafCheck {
    const leaf = extraLeaf(a.epoch, a.index, a.wallet, a.amount);
    const computed = toHex(rootOf(leaf, a.proof));
    return { ok: computed === a.root.toLowerCase(), leaf: toHex(leaf), computedRoot: computed, expectedRoot: a.root.toLowerCase() };
}

/** The leaf of `player` on `tier` in a published epoch file (v2 or v3 base file: same leaves and proofs members). */
export function leafOfFile(file: any, player: string, tier: number): { score: string; proof: string[] } | null {
    const l = Array.isArray(file?.leaves) ? file.leaves.find((x: any) => x?.player === player && x?.tier === tier) : null;
    if (!l) return null;
    const proof = file?.proofs?.[`${player}:${tier}`];
    return Array.isArray(proof) ? { score: String(l.score), proof } : null;
}
