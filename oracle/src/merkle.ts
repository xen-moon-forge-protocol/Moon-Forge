/**
 * Sorted-pair keccak256 Merkle tree — byte-for-byte the convention verified on-chain
 * by `utils::verify_proof` (programs/moon-forge/src/utils.rs):
 *   parent = keccak(min(a,b) || max(a,b)); an odd node is promoted unchanged.
 * leaf = keccak("MOONFORGE_V2_CLAIM" || epoch u64 LE || pubkey 32 || tier u8 || score u64 LE)
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { PublicKey } from "@solana/web3.js";

export const LEAF_DOMAIN = Buffer.from("MOONFORGE_V2_CLAIM");
export const AIRDROP_DOMAIN = Buffer.from("MOONFORGE_V2_AIRDROP");

export function keccak(...parts: Uint8Array[]): Buffer {
  const h = keccak_256.create();
  for (const p of parts) h.update(p);
  return Buffer.from(h.digest());
}

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

export function claimLeaf(epoch: bigint, player: string, tier: number, score: bigint): Buffer {
  return keccak(LEAF_DOMAIN, u64le(epoch), new PublicKey(player).toBuffer(), Buffer.from([tier]), u64le(score));
}

export function airdropLeaf(wallet: string): Buffer {
  return keccak(AIRDROP_DOMAIN, new PublicKey(wallet).toBuffer());
}

function hashPair(a: Buffer, b: Buffer): Buffer {
  return Buffer.compare(a, b) <= 0 ? keccak(a, b) : keccak(b, a);
}

export class MerkleTree {
  readonly layers: Buffer[][];
  constructor(leaves: Buffer[]) {
    if (leaves.length === 0) throw new Error("empty tree");
    this.layers = [leaves];
    while (this.layers[this.layers.length - 1].length > 1) {
      const cur = this.layers[this.layers.length - 1];
      const next: Buffer[] = [];
      for (let i = 0; i < cur.length; i += 2) {
        next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
      }
      this.layers.push(next);
    }
  }
  get root(): Buffer {
    return this.layers[this.layers.length - 1][0];
  }
  proof(index: number): Buffer[] {
    const proof: Buffer[] = [];
    for (let l = 0; l < this.layers.length - 1; l++) {
      const layer = this.layers[l];
      const sib = index ^ 1;
      if (sib < layer.length) proof.push(layer[sib]);
      index >>= 1;
    }
    return proof;
  }
}

export function verifyProof(proof: Buffer[], root: Buffer, leaf: Buffer): boolean {
  let c = leaf;
  for (const n of proof) c = hashPair(c, n);
  return c.equals(root);
}
