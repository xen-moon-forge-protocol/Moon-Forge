import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import epoch1 from '../public/epochs/epoch-1.json';
import index from '../public/epochs/index.json';
import { baseLeaf, extraLeaf, hashPair, leafOfFile, rootOf, toHex, verifyBaseLeaf, verifyExtraLeaf } from '../src/lib/verify-leaf';

const ROOT1 = 'd277eb366200c447083d285719ce6b3ff8c07bd4b7a535ad44d188e1a891b358';

describe('verify-this-leaf', () => {
    it('epoch 1: the single leaf reproduces root d277eb36…b358 (file and index)', () => {
        const l = (epoch1 as any).leaves[0];
        const leaf = leafOfFile(epoch1, l.player, l.tier)!;
        expect(leaf.score).toBe('63918');
        const r = verifyBaseLeaf({ epoch: 1, player: l.player, tier: l.tier, score: leaf.score, proof: leaf.proof, root: (epoch1 as any).root });
        expect(r.ok).toBe(true);
        expect(r.computedRoot).toBe(ROOT1);
        expect((index as any).epochs[0].root).toBe(ROOT1);
    });
    it('a changed score, tier or epoch does not verify', () => {
        const l = (epoch1 as any).leaves[0];
        expect(verifyBaseLeaf({ epoch: 1, player: l.player, tier: 0, score: '63919', proof: [], root: ROOT1 }).ok).toBe(false);
        expect(verifyBaseLeaf({ epoch: 1, player: l.player, tier: 1, score: '63918', proof: [], root: ROOT1 }).ok).toBe(false);
        expect(verifyBaseLeaf({ epoch: 2, player: l.player, tier: 0, score: '63918', proof: [], root: ROOT1 }).ok).toBe(false);
    });
    it('sorted-pair tree of three extra leaves (odd node promoted), like oracle/src/merkle.ts', () => {
        const w = [0, 1, 2].map(() => Keypair.generate().publicKey.toBase58());
        const leaves = w.map((x, i) => extraLeaf(5, i, x, BigInt(1_000_000 * (i + 1))));
        const l01 = hashPair(leaves[0], leaves[1]);
        const root = hashPair(l01, leaves[2]);
        const proofs = [[toHex(leaves[1]), toHex(leaves[2])], [toHex(leaves[0]), toHex(leaves[2])], [toHex(l01)]];
        for (let i = 0; i < 3; i++) {
            expect(toHex(rootOf(leaves[i], proofs[i]))).toBe(toHex(root));
            expect(verifyExtraLeaf({ epoch: 5, index: i, wallet: w[i], amount: String(1_000_000 * (i + 1)), proof: proofs[i], root: toHex(root) }).ok).toBe(true);
        }
        expect(verifyExtraLeaf({ epoch: 5, index: 1, wallet: w[0], amount: '1000000', proof: proofs[0], root: toHex(root) }).ok).toBe(false);
        // the two domains never collide
        expect(toHex(extraLeaf(1, 0, w[0], 1n))).not.toBe(toHex(baseLeaf(1, w[0], 0, 1n)));
    });
});
