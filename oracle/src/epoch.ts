/**
 * Epoch construction — a PURE function of the data recorded in the epoch file, so that
 * `npm run verify -- epoch-N.json` reproduces leaves, total score, root and data hash.
 *
 * Each XEN contract (one per EVM chain) is valued on its OWN market, at the moment of the burn:
 *
 *   spot_value(burn)   = amount × price of that chain's XEN at the burn hour (median of the 24 hourly closes ending then), in micro-USD
 *   V_chain            = Σ spot_value of all burns on that chain in this epoch
 *   L_chain            = XEN-side USD liquidity of that chain's pools
 *   real_value(burn)   = spot_value × L_chain / (L_chain + V_chain)
 *        (constant-product AMM: what the market could really pay if all of this epoch's XEN of
 *         that chain were sold — thin markets are discounted, deep markets ≈ spot)
 *   score(player,tier) = Σ real_value × tier_multiplier × (1 + best Artifact boost of the player)
 *
 * The liquidity factor is the same for every burn of a chain, so splitting a burn across
 * wallets never increases the total (the old √ formula rewarded sybil splitting).
 * A chain with no market (no pool) gives no value.
 *
 *   rate_cap = K × XNT-per-USD × base_score / total_score,   base_score = Σ real_value × tier_multiplier
 * so total_score × rate_cap = K × market value × tier: Artifact boosts change WHO gets the epoch,
 * never how much it can pay in total (a burner alone in an epoch gains nothing from a boost).
 */
import { createHash } from "crypto";
import { ARTIFACT_BOOST_BPS, TIER_MULTIPLIER } from "./config";
import { Burn } from "./evm";
import { claimLeaf, MerkleTree } from "./merkle";

export interface ChainSnapshot {
  chainId: number;
  name: string;
  portal: string;
  fromBlockExclusive: number;
  toBlock: number;
  /** reserve-weighted spot price at build time (reference for the next epoch's clamp) */
  xenUsd: number;
  xenUsdE18: string;
  priceSource: string;
  clamped: boolean;
  /** XEN-side USD liquidity of the chain's pools, in micro-USD */
  liquidityUsdMicro: string;
  pools: { address: string; reserveUsd: number }[];
  /** XEN totalSupply of that chain's contract at toBlock */
  totalSupply: string;
}

export interface ArtifactHolder {
  owner: string;
  asset: string;
  tier: number;
}

export interface Leaf {
  player: string;
  tier: number;
  score: string;
}

export interface EpochBody {
  version: 2;
  programId: string;
  epoch: number;
  createdAt: string;
  chains: ChainSnapshot[];
  xnt: { usd: number; usdE18: string; source: string };
  kBps: number;
  rateCap: string;
  /** holders = live owners at this epoch's snapshot; eligible = those that also held the SAME
   *  Artifact at the previous epoch's snapshot (only they get a boost: no flash forging/renting). */
  artifacts: { slot: number; holders: ArtifactHolder[]; eligible: ArtifactHolder[] };
  burns: Burn[];
  leaves: Leaf[];
  totalScore: string;
  root: string;
}

export interface EpochFile extends EpochBody {
  dataHash: string;
  proofs: Record<string, string[]>; // `${player}:${tier}` -> hex proof
  publish?: { tx: string; slot: number; budget?: string };
}

export function toE18(usd: number): string {
  // decimal string → integer ×1e18, without float drift beyond the source precision
  const s = usd.toFixed(18);
  const [i, f = ""] = s.split(".");
  return (BigInt(i) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18))).toString();
}

export function rateCapFor(kBps: number, xntUsdE18: string): bigint {
  // lamports per micro-USD = kBps/1e4 × 1e9 lamports / (xntUsd × 1e6)
  return (BigInt(kBps) * 10n ** 17n) / BigInt(xntUsdE18);
}

/** The cap actually published: scaled so that boosts cannot raise the epoch's total payout. */
export function epochRateCap(kBps: number, xntUsdE18: string, base: bigint, totalScore: bigint): bigint {
  if (totalScore === 0n) return 0n;
  const cap = (rateCapFor(kBps, xntUsdE18) * base) / totalScore;
  return cap > 0n ? cap : 1n; // 0 would mean "uncapped" on-chain
}

/** Holders that held the same Artifact at the previous snapshot too (sorted like `current`). */
export function eligibleHolders(current: ArtifactHolder[], previous: ArtifactHolder[] | undefined): ArtifactHolder[] {
  if (!previous) return [];
  const prev = new Set(previous.map((h) => `${h.asset}:${h.owner}`));
  return current.filter((h) => prev.has(`${h.asset}:${h.owner}`));
}

export function bestBoostByOwner(holders: ArtifactHolder[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of holders) {
    const b = ARTIFACT_BOOST_BPS[h.tier] ?? 0;
    if (b > (m.get(h.owner) ?? 0)) m.set(h.owner, b);
  }
  return m;
}

/** spot value of a burn in micro-USD (amountWei has 18 decimals, priceE18 = USD × 1e18) */
export function spotValueMicro(b: Burn): bigint {
  if (!b.priceE18) throw new Error(`burn ${b.txHash}:${b.logIndex} has no price`);
  return (BigInt(b.amountWei) * BigInt(b.priceE18)) / 10n ** 30n;
}

/** real_value (micro-USD) per `${player}:${tier}`, before tier multipliers and boosts. */
function realValues(burns: Burn[], chains: ChainSnapshot[]): Map<string, bigint> {
  const liquidity = new Map(chains.map((c) => [c.chainId, BigInt(c.liquidityUsdMicro || "0")]));
  const chainSpot = new Map<number, bigint>();
  for (const b of burns) chainSpot.set(b.chainId, (chainSpot.get(b.chainId) ?? 0n) + spotValueMicro(b));

  const sums = new Map<string, bigint>();
  for (const b of burns) {
    const L = liquidity.get(b.chainId);
    if (L === undefined) throw new Error(`no market data for chain ${b.chainId}`);
    if (L === 0n) continue; // no market on that chain → no value
    const V = chainSpot.get(b.chainId)!;
    const micro = (spotValueMicro(b) * L) / (L + V);
    if (micro === 0n) continue; // dust
    const k = `${b.x1}:${b.tier}`;
    sums.set(k, (sums.get(k) ?? 0n) + micro);
  }
  return sums;
}

/** Σ real_value × tier_multiplier over the epoch (scores WITHOUT Artifact boosts). */
export function baseScore(burns: Burn[], chains: ChainSnapshot[]): bigint {
  let total = 0n;
  for (const [k, micro] of realValues(burns, chains)) total += micro * TIER_MULTIPLIER[Number(k.split(":")[1])];
  return total;
}

export function computeLeaves(burns: Burn[], chains: ChainSnapshot[], holders: ArtifactHolder[]): Leaf[] {
  const sums = realValues(burns, chains);
  const boosts = bestBoostByOwner(holders);
  const leaves: Leaf[] = [];
  for (const [k, micro] of sums) {
    const [player, t] = k.split(":");
    const tier = Number(t);
    const boost = BigInt(boosts.get(player) ?? 0);
    const score = (micro * TIER_MULTIPLIER[tier] * (10_000n + boost)) / 10_000n;
    if (score > 0n && score < 2n ** 64n) leaves.push({ player, tier, score: score.toString() });
  }
  leaves.sort((a, b) => (a.player < b.player ? -1 : a.player > b.player ? 1 : a.tier - b.tier));
  return leaves;
}

export function buildTree(epoch: number, leaves: Leaf[]) {
  const hashes = leaves.map((l) => claimLeaf(BigInt(epoch), l.player, l.tier, BigInt(l.score)));
  const tree = new MerkleTree(hashes);
  const proofs: Record<string, string[]> = {};
  leaves.forEach((l, i) => {
    proofs[`${l.player}:${l.tier}`] = tree.proof(i).map((p) => p.toString("hex"));
  });
  const total = leaves.reduce((s, l) => s + BigInt(l.score), 0n);
  return { root: tree.root.toString("hex"), proofs, totalScore: total.toString() };
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = canonical((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}

export function dataHash(body: EpochBody): string {
  const pick: EpochBody = {
    version: body.version,
    programId: body.programId,
    epoch: body.epoch,
    createdAt: body.createdAt,
    chains: body.chains,
    xnt: body.xnt,
    kBps: body.kBps,
    rateCap: body.rateCap,
    artifacts: body.artifacts,
    burns: body.burns,
    leaves: body.leaves,
    totalScore: body.totalScore,
    root: body.root,
  };
  return createHash("sha256").update(JSON.stringify(canonical(pick))).digest("hex");
}

/** Re-derives everything from the recorded inputs; returns a list of mismatches (empty = OK). */
export function verifyEpochFile(f: EpochFile, previous?: EpochFile): string[] {
  const errors: string[] = [];
  const eligible = f.artifacts.eligible ?? [];
  const current = new Set(f.artifacts.holders.map((h) => `${h.asset}:${h.owner}:${h.tier}`));
  if (!eligible.every((h) => current.has(`${h.asset}:${h.owner}:${h.tier}`))) errors.push("eligible holders not in this epoch's snapshot");
  if (previous && JSON.stringify(eligibleHolders(f.artifacts.holders, previous.artifacts.holders)) !== JSON.stringify(eligible)) {
    errors.push("eligible holders do not match this snapshot ∩ the previous epoch's snapshot");
  }
  const leaves = computeLeaves(f.burns, f.chains, eligible);
  if (JSON.stringify(leaves) !== JSON.stringify(f.leaves)) errors.push("leaves do not match burns × prices × boosts");
  const t = buildTree(f.epoch, leaves);
  if (t.root !== f.root) errors.push(`root mismatch: computed ${t.root}`);
  if (t.totalScore !== f.totalScore) errors.push(`totalScore mismatch: computed ${t.totalScore}`);
  const cap = epochRateCap(f.kBps, f.xnt.usdE18, baseScore(f.burns, f.chains), BigInt(t.totalScore));
  if (cap.toString() !== f.rateCap) errors.push("rateCap does not match kBps / XNT price / boosts");
  const h = dataHash(f);
  if (h !== f.dataHash) errors.push(`dataHash mismatch: computed ${h}`);
  return errors;
}
