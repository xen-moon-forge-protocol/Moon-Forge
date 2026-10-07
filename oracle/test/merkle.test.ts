/**
 * Oracle unit tests (no network): Merkle proofs, linear scoring (sybil-neutral),
 * dust handling, boosts, determinism of the data hash and verification.
 *   npm test
 */
import assert from "assert";
import { Keypair } from "@solana/web3.js";
import { baseScore, buildTree, ChainSnapshot, computeLeaves, dataHash, eligibleHolders, EpochBody, EpochFile, epochRateCap, rateCapFor, toE18, verifyEpochFile } from "../src/epoch";
import { median } from "../src/pricing";
import { claimLeaf, MerkleTree, verifyProof } from "../src/merkle";
import { Burn } from "../src/evm";

const A = Keypair.generate().publicKey.toBase58();
const B = Keypair.generate().publicKey.toBase58();
const C = Keypair.generate().publicKey.toBase58();

const L_BSC = 3_000n * 1_000_000n; // $3,000 XEN-side liquidity (micro-USD)
const L_ETH = 65_000n * 1_000_000n;
const chains: ChainSnapshot[] = [
  { chainId: 56, name: "BSC", portal: "0x1", fromBlockExclusive: 0, toBlock: 10, xenUsd: 9.57e-11, xenUsdE18: toE18(9.57e-11), priceSource: "t", clamped: false, liquidityUsdMicro: L_BSC.toString(), pools: [], totalSupply: "0" },
  { chainId: 1, name: "Ethereum", portal: "0x2", fromBlockExclusive: 0, toBlock: 10, xenUsd: 6e-9, xenUsdE18: toE18(6e-9), priceSource: "t", clamped: false, liquidityUsdMicro: L_ETH.toString(), pools: [], totalSupply: "0" },
  { chainId: 999, name: "NoMarket", portal: "0x3", fromBlockExclusive: 0, toBlock: 10, xenUsd: 1e-9, xenUsdE18: toE18(1e-9), priceSource: "t", clamped: false, liquidityUsdMicro: "0", pools: [], totalSupply: "0" },
];
const PRICE: Record<number, number> = { 56: 9.57e-11, 1: 6e-9, 999: 1e-9 };
const burn = (x1: string, chainId: number, xen: bigint, tier = 0, i = 0): Burn => ({
  chainId, txHash: "0x" + i.toString(16).padStart(64, "0"), logIndex: i, blockNumber: i + 1, missionId: String(i), pilot: "0xabc",
  amountWei: (xen * 10n ** 18n).toString(), tier, x1, timestamp: 1_790_000_000 + i, priceE18: toE18(PRICE[chainId]), priceSource: "t",
});
const real = (spotMicro: bigint, L: bigint, chainTotal: bigint) => (spotMicro * L) / (L + chainTotal);

// 1. Merkle proofs for 1..9 leaves (odd promotion) verify
for (let n = 1; n <= 9; n++) {
  const leaves = Array.from({ length: n }, (_, i) => claimLeaf(1n, Keypair.generate().publicKey.toBase58(), i % 3, BigInt(i + 1)));
  const t = new MerkleTree(leaves);
  leaves.forEach((l, i) => assert(verifyProof(t.proof(i), t.root, l), `proof ${i}/${n}`));
  assert(!verifyProof(t.proof(0), t.root, claimLeaf(2n, A, 0, 1n)), "wrong leaf must fail");
}

// 2. Sybil neutrality: 1 burn of 1T vs 10 burns of 100B → same total score
const one = computeLeaves([burn(A, 56, 1_000_000_000_000n)], chains, []);
const split = computeLeaves(Array.from({ length: 10 }, (_, i) => burn(Keypair.generate().publicKey.toBase58(), 56, 100_000_000_000n, 0, i)), chains, []);
const sum = (l: { score: string }[]) => l.reduce((s, x) => s + BigInt(x.score), 0n);
// splitting never helps: equal up to integer rounding (≤ 1 micro-USD per burn), never more
assert(sum(split) <= sum(one) && sum(one) - sum(split) <= 10n, "score must be sybil-neutral");
// 1T BSC-XEN ≈ $95.7 spot, discounted by BSC liquidity ($3,000): 95.7M × 3000/3095.7
assert.strictEqual(one[0].score, real(95_700_000n, L_BSC, 95_700_000n).toString());

// 3. Tier multiplier and Artifact boost (+50% Void Anomaly), deep market ≈ spot
const t2 = computeLeaves([burn(B, 1, 1_000_000_000n, 2)], chains, [{ owner: B, asset: C, tier: 3 }]);
// 1B ETH-XEN = $6 spot × liquidity factor × 3 × 1.5
assert.strictEqual(t2[0].score, ((real(6_000_000n, L_ETH, 6_000_000n) * 3n * 15_000n) / 10_000n).toString());

// 4. Thin market: burning as much value as the whole liquidity is worth half of spot
const big = computeLeaves([burn(C, 56, 31_347_962_382_445n)], chains, []); // ≈ $3,000 of BSC-XEN
assert(Math.abs(Number(big[0].score) / 1e6 - 1500) < 1, `thin-market discount, got ${big[0].score}`);

// 5. A chain without any market gives no value; dust gives no leaf
assert.strictEqual(computeLeaves([burn(C, 999, 1_000_000_000_000n)], chains, []).length, 0);
assert.strictEqual(computeLeaves([burn(C, 56, 1n)], chains, []).length, 0);

// 5. Rate cap: K=1.25, XNT $0.1855 → 6738 lamports per micro-USD
assert.strictEqual(rateCapFor(12_500, toE18(0.1855)).toString(), "6738");

// Boosts redistribute an epoch, they never raise its cap: a lone burner with a Void Anomaly (+50%)
// can receive at most K × market value, exactly like a burner without any Artifact.
{
  const bb = [burn(B, 1, 1_000_000_000n, 0, 9)];
  const plain = computeLeaves(bb, chains, []);
  const boosted = computeLeaves(bb, chains, [{ owner: B, asset: C, tier: 3 }]);
  const capPlain = epochRateCap(12_500, toE18(0.1855), baseScore(bb, chains), sum(plain)) * sum(plain);
  const capBoosted = epochRateCap(12_500, toE18(0.1855), baseScore(bb, chains), sum(boosted)) * sum(boosted);
  assert(sum(boosted) > sum(plain), "boost raises the score");
  assert(capBoosted <= capPlain && capPlain - capBoosted <= rateCapFor(12_500, toE18(0.1855)) * 2n, `boost must not raise the epoch cap (${capPlain} vs ${capBoosted})`);
}

// 6. Data hash deterministic and verify round-trip
const burns = [burn(A, 56, 5_000_000_000_000n, 0, 1), burn(B, 1, 2_000_000_000n, 1, 2), burn(A, 1, 1_000_000_000n, 2, 3)];
const leaves = computeLeaves(burns, chains, []);
const { root, proofs, totalScore } = buildTree(7, leaves);
const body: EpochBody = {
  version: 2, programId: "57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9", epoch: 7, createdAt: "2026-10-07T00:00:00.000Z", chains,
  xnt: { usd: 0.1855, usdE18: toE18(0.1855), source: "t" }, kBps: 12_500, rateCap: epochRateCap(12_500, toE18(0.1855), baseScore(burns, chains), BigInt(totalScore)).toString(),
  artifacts: { slot: 1, holders: [], eligible: [] }, burns, leaves, totalScore, root,
};
const f: EpochFile = { ...body, dataHash: dataHash(body), proofs };
assert.deepStrictEqual(verifyEpochFile(f), []);
assert.strictEqual(dataHash(JSON.parse(JSON.stringify(body))), f.dataHash, "hash must not depend on key order / round-trip");
const tampered: EpochFile = JSON.parse(JSON.stringify(f));
tampered.burns[0].amountWei = "1";
assert(verifyEpochFile(tampered).length > 0, "tampered burns must be detected");

// Robust price: a single spike does not move the median of hourly closes.
assert.strictEqual(median([1, 1, 1, 1, 50]), 1);
assert.strictEqual(median([2, 4]), 3);
assert.strictEqual(median([0, -1]), 0);

// Boosts need the same Artifact held at two consecutive snapshots (no flash forging / renting).
{
  const prevSnap = [{ owner: A, asset: "asset1", tier: 3 }];
  const nowSnap = [{ owner: A, asset: "asset1", tier: 3 }, { owner: B, asset: "asset2", tier: 3 }];
  const el = eligibleHolders(nowSnap, prevSnap);
  assert.deepStrictEqual(el.map((h) => h.owner), [A], "only A held its Artifact at both snapshots");
  assert.deepStrictEqual(eligibleHolders(nowSnap, undefined), [], "first epoch: no boosts");
  const moved = eligibleHolders([{ owner: B, asset: "asset1", tier: 3 }], prevSnap);
  assert.deepStrictEqual(moved, [], "an Artifact that changed hands is not eligible this epoch");
}

console.log("oracle tests: all passed");
