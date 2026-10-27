/**
 * Extra epoch (two-pot NFT model, nft-extra REPORT §A, SPEC-v3 amendment A10): the weekly "Artifact Burn Rebate"
 * paid from the EXTRA pot, as a PURE function of base (v3) epoch file n, extra file n−1, the snapshot S(n) and the
 * pot reading, so that `verifyExtraFile(file, base, prevExtra)` reproduces every row, leaf, root and data hash.
 *
 *  Snapshot S(n): Core owner + ArtifactRecord of every live asset at the first X1 slot whose block time is
 *    ≥ base.window.endTs, rebuilt from each asset's last create / transfer / burn signature (recorded per asset).
 *  Eligible: origin FORGED, alive in S(n−1) and S(n) with the same owner w, and in season
 *    (forgedAt + 52 weeks > base.window.startTs). Nothing is eligible in the first extra epoch (no S(n−1)).
 *  Need:     pricePaid_e = 2 × backing_e; need_e = ⌊pricePaid_e × 100/10^4⌋ (1% of the price paid per week);
 *            need_w = Σ need_e over w's eligible Artifacts.
 *  Use:      for every burn b of base file n with x1 = w: u_b = ⌊base_b × (lp_b − basePaid_b)/lp_b⌋ (0 when
 *            basePaid_b ≥ lp_b or lp_b = 0): the market value the base pot did NOT pay. Band, vesting, ent ignored.
 *  Counted:  counted_w = min(U_w, need_w); W = Σ counted_w.
 *  Release:  R = ⌊X × 800/10^4⌋ with X = free_after of extra epoch n−1 (known at the week's start): ONE release per
 *            published base epoch, whatever the window (A13.3). B = min(R, ⌊W × 20,000/10^4⌋, k × ⌊backing × 400/10^4⌋),
 *            0 when W = 0, where k = the 7-day weeks of the base window (need is k weeks' worth too, A12.7 / A13.3).
 *  Pay:      pay_w = ⌊counted_w × B/W⌋, and 0 below MIN_PAY (0.001 XNT). rho = B/W ≤ 2, the same for every tier.
 *  Leaves:   (index, wallet, amount) sorted by wallet; leaf = keccak("MOONFORGE_V3_EXTRA" ‖ epoch u64 LE ‖ index u32 LE
 *            ‖ wallet 32 ‖ amount u64 LE) on the v2 sorted-pair tree; an empty epoch has the all-zero root.
 *  Pots:     R − budget (dust, dropped pays, unused release) stays in the extra pot. The base file is read, never
 *            changed, and no number of it other than its burns, window, epoch and hashes is used.
 *  Bound:    budget ≤ ⌊X × 800/10^4⌋ and budget ≤ k × ⌊Σ backing(eligible) × 400/10^4⌋, both sure lower bounds of the
 *            on-chain A4 bound scaled by the window (A13.3), so a verified file always publishes. ≤ 1,000 leaves.
 *  Heartbeat: one extra file per base epoch, every week, with budget "0" when nothing is paid. A week that cannot be
 *            built is published as a SKIP heartbeat (A13.6: budget 0, empty snapshot, the reason recorded), so one bad
 *            week never blocks the history. A base whose snapshot is unavailable (A13.9) has only that skip.
 *
 * On-chain publishing (publish_extra_epoch / claim_extra) comes with the final program upgrade: see the block at the
 * end. The instruction builders live in x1-v3.ts (v3 IDL, moon_forge.v3.json); `npm run publish-extra` sends
 * publish_extra_epoch once the file is durable (A10.11) and the keeper (keeper-v3.ts) claims and closes extra epochs.
 */
import { createHash } from "crypto";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { keccak, MerkleTree } from "./merkle";
import { BPS, dataHashV3, EpochFileV3, isoSeconds, MAX_PUBLISH_LAG, nat, ORIGIN_DROP, ORIGIN_FORGED, ORIGIN_GENESIS, protoPath, provisionalError, pubkey, retiredBaseTerms, SnapshotRecord, uint, WEEK } from "./rewards";

// ── policy constants (oracle, versioned forward-only; A10.1) ───────────────────────────────────
/** weekly need: 1% of the price paid */
export const NEED_BPS = 100n;
/** at most 2 lamports of rebate per lamport of counted (uncovered) use */
export const RHO_MAX_BPS = 20_000n;
/** a pay below 0.001 XNT becomes 0 and stays in the pot */
export const MIN_PAY = 1_000_000n;
/** rebate season: only Artifacts younger than 52 weeks at the week's start */
export const SEASON_WEEKS = 52;
/** price paid = 2 × backing (the ArtifactRecord holds 50% of the forge price) */
export const PRICE_PAID_NUM = 2n;
// ── program constants (to be mirrored in programs/moon-forge/src/constants.rs by the upgrade) ──
/** EXTRA_RELEASE_BPS: R = 8% of the free extra balance recorded at the previous extra publication */
export const EXTRA_RELEASE_BPS = 800n;
/** EXTRA_BACKING_BOUND_BPS: total ≤ 4% of the live forged backing (= 2% of the live price paid = rhoMax × need) */
export const EXTRA_BACKING_BOUND_BPS = 400n;
/** EXTRA_MAX_LEAVES = Σ ARTIFACT_SUPPLY: one leaf per wallet with an eligible Artifact */
export const EXTRA_MAX_LEAVES = 1_000;
/**
 * EXTRA_MAX_WEEKS (constants.rs, W2-3): the most 7-day weeks one extra publication can carry. The program refuses
 * `weeks` above min(13, its published_at gap) with BadEpochWindow, so needWeeksOf is capped here too: a window after a
 * silence longer than 13 weeks carries 13 weeks' worth of need and backing bound, never more.
 */
export const EXTRA_MAX_WEEKS = 13;
export const EXTRA_LEAF_DOMAIN = Buffer.from("MOONFORGE_V3_EXTRA");
/** the root of an epoch without leaves (heartbeat) */
export const EMPTY_ROOT = "00".repeat(32);
/**
 * An optional pin of the first extra epoch (null: none, never set by hand). The run DERIVES the chain's first extra
 * epoch from the upgraded program (sources-v3 extraPotRunV3: Config.last_epoch at init_extra + 1, read back from
 * ExtraState and the published ExtraEpoch accounts); the local history starts with the v3 history (base.v3FirstEpoch),
 * and extra files before the chain's first one stay local heartbeats.
 */
export const EXTRA_FIRST_EPOCH: number | null = null;
/**
 * OD-9 / D-28 (owner sheet, the default): an Artifact forged BEFORE the program upgrade never enters the extra pot. Its
 * forge put nothing into the extra pot (the 25% extra split exists only on the upgraded binary) and its backing is not
 * in the program's bound (ExtraState.live_forged_backing counts only the forges after init_extra), so a rebate for it
 * would be paid by the 25% of everyone else's forges. Such an Artifact is excluded with the reason "pre-upgrade" in
 * every extra epoch. The boundary is the pot's creation, the block time of the init_extra transaction (`pool.init`,
 * read once from the chain, readExtraInitV3, and carried unchanged by every later extra file): forgedAt < init.ts is
 * pre-upgrade (a forge in the same second as init_extra counts as after it: only the upgraded binary can forge then,
 * unless the deploy and init_extra share that second, which the S6 runbook avoids). Before the pot exists (init null)
 * every FORGED Artifact is pre-upgrade, and every extra file is a budget-0 heartbeat anyway (X6).
 * The owner's revert (alternative (b), disclosed): set this to false and pre-upgrade Artifacts enter like any other.
 * The value is recorded in every file (policy.preUpgradeExcluded), so it is chosen before the first extra epoch is
 * published; a later change is a new policy version (files built under the old value no longer re-verify).
 */
export const EXTRA_EXCLUDE_PRE_UPGRADE = true;
export const EXTRA_FORMAT = "extra" as const;
export const EXTRA_VERSION = 1 as const;
const U64 = 2n ** 64n;

// ── types ──────────────────────────────────────────────────────────────────────────────────────
export interface ExtraSnapshotRecord {
  asset: string;
  tier: number;
  /** Core owner at the snapshot slot */
  owner: string;
  /** lamports held by the ArtifactRecord (the recycle floor) */
  backing: string;
  /** ORIGIN_FORGED | ORIGIN_GENESIS | ORIGIN_DROP */
  origin: number;
  /** ArtifactRecord.forged_at (unix seconds) */
  forgedAt: number;
  /** the asset's last Core create / transfer / burn transaction at or before the slot (base58 signature) */
  signature: string;
}

export interface ExtraSnapshot {
  /** the first X1 slot whose block time is ≥ base.window.endTs */
  slot: number;
  blockTime: number;
  /** every live asset of the collection at that slot (a burned asset is not listed) */
  records: ExtraSnapshotRecord[];
}

/** OD-9: the extra pot's creation, the init_extra transaction; its block time is the pre-upgrade boundary */
export interface ExtraInitMark {
  /** the block time of the init_extra transaction (unix seconds) */
  ts: number;
  /** the init_extra transaction (base58 signature), so `verify --full` re-reads it in one call */
  tx: string;
}

/** the extra pot at build: X = free_after of extra epoch n−1 (counter-based), and the free balance now (≥ X) */
export interface ExtraPoolInfo {
  /** X: ExtraEpochPublished(n−1).free_after; the free extra pot at init_extra for the first extra epoch; "0" before the upgrade */
  open: string;
  /** accounted − reserved at build (informational; it never falls between two publications) */
  lamports: string;
  slot: number;
  /** build instant, ISO (toISOString form) */
  createdAt: string;
  /**
   * OD-9: the pot's creation (init_extra), null (or absent) before the upgrade. Read once from the chain for the first
   * extra epoch on the live pot, then carried unchanged: a file whose previous file has a mark must carry the same one.
   */
  init?: ExtraInitMark | null;
}

export interface ExtraArtifactRow {
  asset: string;
  tier: number;
  backing: string;
  pricePaid: string;
  need: string;
}

export interface ExtraWalletRow {
  wallet: string;
  artifacts: ExtraArtifactRow[];
  need: string;
  /** U_w: Σ uncovered market value of the wallet's burns in base file n */
  use: string;
  /** min(use, need) */
  counted: string;
  pay: string;
}

/** why a FORGED Artifact of S(n) is not eligible: "pre-upgrade" (OD-9, permanent), then "new", "moved", "season" */
export type ExtraExclusion = "pre-upgrade" | "new" | "moved" | "season";

export interface ExtraLeaf {
  index: number;
  wallet: string;
  amount: string;
}

export interface ExtraPolicy {
  needBps: number;
  rhoMaxBps: number;
  minPay: string;
  releaseBps: number;
  backingBoundBps: number;
  seasonWeeks: number;
  pricePaidNum: number;
  /** OD-9: EXTRA_EXCLUDE_PRE_UPGRADE (Artifacts forged before init_extra never enter the extra pot) */
  preUpgradeExcluded: boolean;
}

export interface ExtraTotals {
  /** Σ need of the eligible wallets */
  need: string;
  /** Σ use of the eligible wallets */
  use: string;
  /** W */
  counted: string;
  /** R = ⌊X × 800/10^4⌋ */
  release: string;
  /** B = min(R, ⌊W × 20,000/10^4⌋) */
  budgetMax: string;
  /** Σ pay (the on-chain total) */
  budget: string;
  /** R − budget: stays in the extra pot */
  unpaid: string;
  /** Σ backing of the eligible Artifacts */
  eligibleBacking: string;
  /** weeks × ⌊eligibleBacking × 400/10^4⌋ (A13.3): a sure lower bound of the on-chain backing bound for the window */
  backingBound: string;
  eligibleArtifacts: number;
  leaves: number;
}

export interface ExtraBodyV1 {
  kind: typeof EXTRA_FORMAT;
  version: typeof EXTRA_VERSION;
  programId: string;
  epoch: number;
  firstEpoch: number;
  createdAt: string;
  /** base file n's dataHash */
  baseDataHash: string;
  /** extra file n−1's dataHash (null in the first extra epoch) */
  prevDataHash: string | null;
  /** base file n's window; seasonAfter = startTs − 52 weeks: an Artifact is in season iff forgedAt > seasonAfter */
  /** weeks: the 7-day weeks this window carries (A12.7, A13.3): need and the backing bound are that many weeks' worth */
  window: { startTs: number; endTs: number; seasonAfter: number; weeks: number };
  policy: ExtraPolicy;
  /** init: OD-9, the pot's creation (null before the upgrade); carried unchanged from the previous extra file */
  pool: { open: string; lamports: string; slot: number; init: ExtraInitMark | null };
  snapshot: ExtraSnapshot;
  /** FORGED Artifacts of S(n) that are not eligible this week, with the reason */
  excluded: { asset: string; reason: ExtraExclusion }[];
  /** one row per wallet with at least one eligible Artifact, sorted by wallet */
  rows: ExtraWalletRow[];
  totals: ExtraTotals;
  leaves: ExtraLeaf[];
  root: string;
  /**
   * A13.6: present only on a SKIP heartbeat, the file written for a week whose extra epoch could not be built (nor
   * rebuilt, A13.7) by the next base run: budget 0, no rows, an empty snapshot, and why. The history goes on from it.
   */
  skip?: { reason: string };
}

export interface ExtraFileV1 extends ExtraBodyV1 {
  dataHash: string;
  /** wallet → hex proof */
  proofs: Record<string, string[]>;
  publish?: { tx: string; slot: number };
}

// ── integer helpers ────────────────────────────────────────────────────────────────────────────
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export const policy = (): ExtraPolicy => ({
  needBps: Number(NEED_BPS), rhoMaxBps: Number(RHO_MAX_BPS), minPay: MIN_PAY.toString(), releaseBps: Number(EXTRA_RELEASE_BPS),
  backingBoundBps: Number(EXTRA_BACKING_BOUND_BPS), seasonWeeks: SEASON_WEEKS, pricePaidNum: Number(PRICE_PAID_NUM),
  preUpgradeExcluded: EXTRA_EXCLUDE_PRE_UPGRADE,
});

/**
 * OD-9: whether an Artifact forged at `forgedAt` was forged before the extra pot existed (before the init_extra
 * transaction's block time; always, while the pot does not exist) and is therefore kept out of the extra pot.
 */
export function isPreUpgrade(forgedAt: number, init: ExtraInitMark | null, excluded: boolean = EXTRA_EXCLUDE_PRE_UPGRADE): boolean {
  return excluded && (init === null || forgedAt < init.ts);
}

/** price paid at the forge: 2 × backing for a FORGED Artifact, 0 for Genesis and Drops (never a resale price) */
export function pricePaid(r: { origin: number; backing: string }): bigint {
  return r.origin === ORIGIN_FORGED ? PRICE_PAID_NUM * uint(r.backing, "backing", U64) : 0n;
}

/** weekly need of one Artifact: 1% of the price paid (Lunar 0.10, Cosmic 0.25, Solar 0.60, Void 2.00 XNT) */
export function needOf(r: { origin: number; backing: string }): bigint {
  return (pricePaid(r) * NEED_BPS) / BPS;
}

/**
 * uncovered market value of one burn: ⌊base × (lp − basePaid)/lp⌋; 0 when the base pot paid the whole Launchpad layer.
 * Every amount is below 2^64 (A10.2, X5): a larger one is refused, it never reaches a row.
 */
export function uncovered(b: { base: string; lp: string; basePaid: string }): bigint {
  const lp = uint(b.lp, "lp", U64);
  const paid = uint(b.basePaid, "basePaid", U64);
  const base = uint(b.base, "base", U64);
  if (lp <= 0n || paid >= lp) return 0n;
  return (base * (lp - paid)) / lp;
}

/** the week's release from the pot reading: R = ⌊X × 800/10^4⌋ */
export function releaseOf(open: bigint): bigint {
  return (open * EXTRA_RELEASE_BPS) / BPS;
}

/**
 * A13.3: the per-publication backing bound of a window of `weeks` 7-day weeks: weeks × ⌊eligibleBacking × 400/10^4⌋
 * (computed per week, then that many weeks' worth). The upgraded program scales its own bound the same way (A13.3 rule 4).
 */
export function backingBoundOf(eligibleBacking: bigint, weeks: number): bigint {
  if (!Number.isInteger(weeks) || weeks < 1) throw new Error(`weeks ${weeks}: a window carries at least one week`);
  return ((eligibleBacking * EXTRA_BACKING_BOUND_BPS) / BPS) * BigInt(weeks);
}

/**
 * B = min(R, ⌊W × rhoMax/10^4⌋, the backing bound), 0 when W = 0. With the backing bound scaled by the window (A13.3) it
 * never binds: pay ≤ 2 × need = 2 × weeks × Σ⌊backing/50⌋ ≤ weeks × ⌊Σ backing/25⌋. R stays ONE release per publication.
 */
export function budgetMaxOf(R: bigint, W: bigint, backingBound: bigint | null = null): bigint {
  if (W <= 0n) return 0n;
  const B = min(R, (W * RHO_MAX_BPS) / BPS);
  return backingBound === null ? B : min(B, backingBound);
}

/** an Artifact is in season for base window [startTs, …) iff forgedAt + 52 weeks > startTs */
export function seasonAfterOf(startTs: number): number {
  return startTs - SEASON_WEEKS * WEEK;
}

/**
 * A13.3 (OWNER-A12-3; was A12.7's ⌊(len + 1 day)/1 week⌋): the 7-day weeks a base window of len = endTs − startTs
 * carries: k = max(1, ⌊(len + MAX_PUBLISH_LAG)/1 week⌋). The window starts at published_at(n−1), up to MAX_PUBLISH_LAG
 * (6 h) after its weekly slot, so the count is the floor of the window measured on the weekly schedule: 7 and 13 days
 * are 1 week, 14 days (or a skipped week published 6 h late) 2. Every window pays at least its own week; a window of
 * len pays at most ⌊(len + 6 h)/7 d⌋ weeks' worth, and never more than one release (R) per published base epoch.
 * W2-3: capped at EXTRA_MAX_WEEKS (13), the program's cap: k = min(13, max(1, ⌊(len + 6 h)/1 week⌋)), exactly the
 * clamp of extra.rs::extra_weeks_max, so a file is never refused for claiming more weeks than the chain allows.
 */
export const NEED_WEEK_SLACK = MAX_PUBLISH_LAG;
export function needWeeksOf(startTs: number, endTs: number): number {
  return Math.min(EXTRA_MAX_WEEKS, Math.max(1, Math.floor((endTs - startTs + NEED_WEEK_SLACK) / WEEK)));
}

/**
 * X1 / A13.1: the two-pot model (nft-extra REPORT A2) is valid only on a base pot with every NFT term off. The base
 * engine has none (no Forge Right ledger, lane, boost or drop policy can be written by computeEpochV3), so a base file
 * that carries any such member, even an empty one, is not a base file of this engine: it is refused (structural, so
 * verifyExtraFile inherits it), and the extra can never pay twice what a base lane or boost already paid.
 */
export function baseNftTermsError(base: unknown): string | null {
  const retired = retiredBaseTerms(base);
  if (retired.length) {
    return `the base file carries NFT terms (${retired.join(", ")}): the two-pot base (REPORT A2, A13.1) has no Forge Right ledger, lane, boost or drop policy, or the extra would pay the same uncovered value twice`;
  }
  return null;
}

/**
 * X6: until the program upgrade creates the extra pot (init_extra), every extra file is a heartbeat: X and the pot
 * reading are 0. A file claiming a pot before it exists is refused by verify and the health check.
 * EXTRA_POT_LIVE is only the default of the pure functions (tests, offline checks) and is never edited by hand: the
 * run detects the pot on chain (sources-v3 extraPotRunV3, the W2-4 probe) and `verify` takes the pot as live for a file
 * that carries the init_extra mark (pool.init, OD-9), which `verify --full` checks against the chain.
 */
export const EXTRA_POT_LIVE = false;
export function preUpgradePotError(f: { pool: { open: string; lamports: string; init?: ExtraInitMark | null } }, live = EXTRA_POT_LIVE): string | null {
  if (live) return null;
  if (f.pool.open !== "0" || f.pool.lamports !== "0") return `pool.open ${f.pool.open} / lamports ${f.pool.lamports}: the extra pot does not exist before the program upgrade, every extra file is a budget-0 heartbeat`;
  if (f.pool.init !== undefined && f.pool.init !== null) return `pool.init ${f.pool.init.tx}: the extra pot does not exist before the program upgrade, so it has no init_extra (OD-9)`;
  return null;
}

export function pinnedExtraError(firstEpoch: number, pinned: number | null = EXTRA_FIRST_EPOCH): string | null {
  if (pinned !== null && firstEpoch !== pinned) return `the extra history starts at epoch ${firstEpoch}, but EXTRA_FIRST_EPOCH is pinned at ${pinned}`;
  return null;
}

// ── leaves and tree ────────────────────────────────────────────────────────────────────────────
function u64le(v: bigint): Buffer {
  if (v < 0n || v >= U64) throw new Error(`${v} does not fit in a u64`);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
function u32le(v: number): Buffer {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) throw new Error(`${v} does not fit in a u32`);
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

/** keccak("MOONFORGE_V3_EXTRA" ‖ epoch u64 LE ‖ index u32 LE ‖ wallet 32 ‖ amount u64 LE) */
export function extraLeaf(epoch: number, index: number, wallet: string, amount: bigint): Buffer {
  return keccak(EXTRA_LEAF_DOMAIN, u64le(BigInt(epoch)), u32le(index), new PublicKey(wallet).toBuffer(), u64le(amount));
}

/** the sorted-pair keccak tree of merkle.ts over the leaves in order; the all-zero root for an empty epoch */
export function extraTree(epoch: number, leaves: ExtraLeaf[]): { root: string; proofs: Record<string, string[]> } {
  if (leaves.length === 0) return { root: EMPTY_ROOT, proofs: {} };
  const tree = new MerkleTree(leaves.map((l) => extraLeaf(epoch, l.index, l.wallet, BigInt(l.amount))));
  const proofs: Record<string, string[]> = {};
  leaves.forEach((l, i) => {
    proofs[l.wallet] = tree.proof(i).map((p) => p.toString("hex"));
  });
  return { root: tree.root.toString("hex"), proofs };
}

// ── canonical JSON and data hash (same rules as v3: sorted keys, null prototypes, R2-4) ─────────
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(v as object).sort()) o[k] = canonical((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}
const canonicalJson = (v: unknown) => JSON.stringify(canonical(v));

/** sha256 of the canonical JSON of the whole body (everything except dataHash, proofs and publish). */
export function dataHashExtra(f: ExtraBodyV1): string {
  const { dataHash: _h, proofs: _p, publish: _u, ...body } = f as ExtraFileV1;
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

// ── input checks ───────────────────────────────────────────────────────────────────────────────
function signature(v: unknown, what: string): string {
  let ok = false;
  try {
    ok = typeof v === "string" && bs58.decode(v).length === 64 && bs58.encode(bs58.decode(v)) === v;
  } catch {
    ok = false;
  }
  if (!ok) throw new Error(`${what}: ${JSON.stringify(v)} is not a canonical base58 transaction signature`);
  return v as string;
}

/**
 * OD-9: the pool's init_extra mark, validated ({ts, tx} exactly, or null / absent = before the upgrade), and its
 * continuity: once a previous extra file carries a mark, every later file carries the same one (the pot is created
 * once). A previous file without a mark (built before the pot existed) lets the first mark in.
 */
export function checkedInitMark(v: unknown, prev: ExtraFileV1 | null, what = "pool.init"): ExtraInitMark | null {
  let init: ExtraInitMark | null = null;
  if (v !== undefined && v !== null) {
    if (typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} is not {ts, tx}`);
    const keys = Object.keys(v).sort().join(",");
    if (keys !== "ts,tx") throw new Error(`${what} has members ${keys}, expected exactly ts, tx`);
    const o = v as { ts: unknown; tx: unknown };
    init = { ts: nat(o.ts, `${what}.ts`), tx: signature(o.tx, `${what}.tx`) };
  }
  const was = prev?.pool?.init ?? null;
  if (was !== null && (init === null || init.ts !== was.ts || init.tx !== was.tx)) {
    throw new Error(`${what} ${init ? `${init.tx} @ ${init.ts}` : "null"} differs from extra-${prev!.epoch}.json's (${was.tx} @ ${was.ts}): the extra pot is created once (OD-9)`);
  }
  return init;
}

/** Validates a snapshot and returns a copy with the records sorted by asset (the recorded form). */
export function checkedSnapshot(s: ExtraSnapshot, what = "snapshot"): ExtraSnapshot {
  nat(s.slot, `${what}.slot`);
  nat(s.blockTime, `${what}.blockTime`);
  if (!Array.isArray(s.records)) throw new Error(`${what}.records is not an array`);
  const seen = new Set<string>();
  const records = s.records.map((r) => {
    const asset = pubkey(r.asset, `${what} asset`);
    if (seen.has(asset)) throw new Error(`${what}: asset ${asset} twice`);
    seen.add(asset);
    const tier = nat(r.tier, `${what} ${asset} tier`);
    if (tier > 3) throw new Error(`${what} ${asset}: tier ${tier}`);
    const origin = nat(r.origin, `${what} ${asset} origin`);
    if (![ORIGIN_FORGED, ORIGIN_GENESIS, ORIGIN_DROP].includes(origin)) throw new Error(`${what} ${asset}: origin ${origin}`);
    return {
      asset, tier, owner: pubkey(r.owner, `${what} ${asset} owner`), backing: uint(r.backing, `${what} ${asset} backing`, U64).toString(), origin,
      forgedAt: nat(r.forgedAt, `${what} ${asset} forgedAt`), signature: signature(r.signature, `${what} ${asset} signature`),
    };
  });
  records.sort((a, b) => cmpStr(a.asset, b.asset));
  return { slot: s.slot, blockTime: s.blockTime, records };
}

function checkBase(base: EpochFileV3): void {
  if ((base as { version?: unknown }).version !== 3) throw new Error(`the base file is not a v3 epoch file (version ${String((base as { version?: unknown }).version)})`);
  const proto = protoPath(base);
  if (proto) throw new Error(`the base file has a "__proto__" member at ${proto}`);
  // A13.4: a provisional dry-run file is never an epoch, so no extra file is ever built on one
  const provisional = provisionalError(base);
  if (provisional) throw new Error(`the base file: ${provisional}`);
  if (dataHashV3(base) !== base.dataHash) throw new Error(`base epoch-${base.epoch}.json does not match its own dataHash`);
}

function checkPrev(prev: ExtraFileV1, epoch: number, base: EpochFileV3): void {
  if (prev.kind !== EXTRA_FORMAT || prev.version !== EXTRA_VERSION) throw new Error("the previous extra file has an unknown format");
  const proto = protoPath(prev);
  if (proto) throw new Error(`the previous extra file has a "__proto__" member at ${proto}`);
  if (prev.epoch !== epoch - 1) throw new Error(`previous extra file is epoch ${prev.epoch}, expected ${epoch - 1} (extra epochs are never skipped)`);
  if (dataHashExtra(prev) !== prev.dataHash) throw new Error(`extra-${prev.epoch}.json does not match its own dataHash`);
  if (prev.programId !== base.programId) throw new Error("the previous extra file is for another program");
  if (prev.baseDataHash !== base.prevDataHash) throw new Error(`extra-${prev.epoch}.json was built on a base file other than epoch-${prev.epoch}.json (prevDataHash of the base)`);
}

// ── construction ───────────────────────────────────────────────────────────────────────────────
/**
 * Builds extra epoch n (the body, without dataHash and proofs) from base file n, extra file n−1 (null for the first
 * extra epoch), the snapshot S(n) and the pot reading. Pure and deterministic: the input order of records and
 * burns never changes the output. Throws on an input that breaks a recorded rule; never returns null (heartbeat).
 */
export function computeExtraEpoch(base: EpochFileV3, prev: ExtraFileV1 | null | undefined, snapshot: ExtraSnapshot, pool: ExtraPoolInfo): ExtraBodyV1 {
  const pv = prev ?? null;
  for (const [what, v] of [["snapshot", snapshot], ["pool", pool]] as const) {
    const proto = protoPath(v);
    if (proto) throw new Error(`${what} has a "__proto__" member at ${proto}`);
  }
  checkBase(base);
  const nftTerms = baseNftTermsError(base);
  if (nftTerms) throw new Error(nftTerms);
  const epoch = nat(base.epoch, "base epoch");
  if (epoch < 1) throw new Error("epochs start at 1");
  const programId = pubkey(base.programId, "programId");
  if (pv) checkPrev(pv, epoch, base);
  const firstEpoch = pv ? pv.firstEpoch : epoch;
  const pinError = pinnedExtraError(firstEpoch);
  if (pinError) throw new Error(pinError);
  // X4: the extra history starts with the v3 history (A11.6: an extra epoch for every v3 base from the first one), so
  // without a previous extra file only the first v3 epoch (or the pinned EXTRA_FIRST_EPOCH) can start it: a lost
  // extra-(n−1).json is recovered (A12), never replaced by a restart that would withhold everyone's rebate for a week
  if (!pv) {
    const startAt = EXTRA_FIRST_EPOCH ?? nat(base.v3FirstEpoch, "base v3FirstEpoch");
    if (epoch !== startAt) throw new Error(`extra epoch ${epoch} without extra-${epoch - 1}.json: the extra history starts at epoch ${startAt} and is never restarted (rebuild the missing file: rebuild-extra ${epoch - 1}, A13.7)`);
  }

  // window and instants
  const startTs = nat(base.window.startTs, "base window.startTs");
  const endTs = nat(base.window.endTs, "base window.endTs");
  if (endTs < startTs) throw new Error("base window ends before it starts");
  const createdAt = isoSeconds(pool.createdAt, "pool.createdAt");
  if (createdAt < endTs) throw new Error(`extra build time ${pool.createdAt} is before the base window end ${endTs}`);

  // snapshot S(n) (A12, X2): exactly the base file's snapshot, the slot whose block time IS the base window end (A8),
  // with the same assets and, per asset, the same owner, tier, origin and backing; after S(n−1), whose immutables it keeps
  const snap = checkedSnapshot(snapshot);
  const baseSnap = (base as { snapshot?: { slot?: unknown; records?: unknown } }).snapshot;
  if (!baseSnap || !Array.isArray(baseSnap.records)) throw new Error("the base file has no snapshot: S(n) cannot be tied to it");
  // A13.9 (review R2): the base was built without its Artifact records (unreadable, or one refused): S(n) is unknown,
  // so the only extra file on that base is the skip heartbeat (baseSnapshotSkipReason)
  const unavailable = baseSnapshotUnavailable(base);
  if (unavailable !== null) throw new Error(`the base snapshot of epoch ${epoch} is unavailable (A13.9: ${unavailable}): S(${epoch}) is unknown, so extra epoch ${epoch} is a skip heartbeat`);
  if (snap.slot !== baseSnap.slot) throw new Error(`snapshot slot ${snap.slot} is not the base file's snapshot slot ${String(baseSnap.slot)}`);
  if (snap.blockTime !== endTs) throw new Error(`snapshot block time ${snap.blockTime} is not the base window end ${endTs} (the block time of the base snapshot slot, A8)`);
  const baseRecords = new Map((baseSnap.records as SnapshotRecord[]).map((r) => [r.asset, r]));
  if (baseRecords.size !== snap.records.length) throw new Error(`snapshot has ${snap.records.length} assets, the base snapshot ${baseRecords.size}`);
  for (const r of snap.records) {
    const b = baseRecords.get(r.asset);
    if (!b) throw new Error(`snapshot asset ${r.asset} is not in the base snapshot`);
    if (b.owner !== r.owner || b.tier !== r.tier || b.origin !== r.origin || String(b.backing) !== r.backing) {
      throw new Error(`snapshot asset ${r.asset} differs from the base snapshot (owner ${r.owner} / ${b.owner}, tier ${r.tier} / ${b.tier}, origin ${r.origin} / ${b.origin}, backing ${r.backing} / ${b.backing})`);
    }
  }
  if (pv && !(snap.slot > pv.snapshot.slot)) throw new Error(`snapshot slot ${snap.slot} is not after the previous extra snapshot (${pv.snapshot.slot})`);
  if (pv && snap.blockTime < pv.snapshot.blockTime) throw new Error("snapshot block time before the previous extra snapshot's");
  if (pv) {
    const before = new Map(pv.snapshot.records.map((r) => [r.asset, r]));
    for (const r of snap.records) {
      const p = before.get(r.asset);
      if (!p) continue;
      if (p.tier !== r.tier || p.origin !== r.origin || p.forgedAt !== r.forgedAt) throw new Error(`snapshot asset ${r.asset}: tier, origin or forgedAt changed since S(n−1) (immutable)`);
      if (BigInt(r.backing) > BigInt(p.backing)) throw new Error(`snapshot asset ${r.asset}: backing ${r.backing} above S(n−1)'s ${p.backing} (a backing never grows)`);
    }
  }

  // the pot: X is known at the week's start; the free balance never falls between two publications
  const open = uint(pool.open, "pool.open", U64);
  const lamports = uint(pool.lamports, "pool.lamports", U64);
  nat(pool.slot, "pool.slot");
  if (lamports < open) throw new Error(`extra pot ${lamports} at build is below X = ${open} (free_after of the previous publication)`);
  const init = checkedInitMark(pool.init, pv);

  // eligibility (A10.3; OD-9 first: an Artifact forged before init_extra never enters, whatever its owner did)
  const seasonAfter = seasonAfterOf(startTs);
  const weeks = needWeeksOf(startTs, endTs);
  const prevOwner = new Map<string, string>(pv ? pv.snapshot.records.map((r) => [r.asset, r.owner]) : []);
  const excluded: { asset: string; reason: ExtraExclusion }[] = [];
  const byWallet = new Map<string, { artifacts: ExtraArtifactRow[]; need: bigint; backing: bigint }>();
  let eligibleBacking = 0n;
  let eligibleArtifacts = 0;
  for (const r of snap.records) {
    if (r.origin !== ORIGIN_FORGED) continue;
    const was = prevOwner.get(r.asset);
    const reason: ExtraExclusion | null = isPreUpgrade(r.forgedAt, init) ? "pre-upgrade" : was === undefined ? "new" : was !== r.owner ? "moved" : r.forgedAt <= seasonAfter ? "season" : null;
    if (reason) {
      excluded.push({ asset: r.asset, reason });
      continue;
    }
    const backing = BigInt(r.backing);
    const price = pricePaid(r);
    const need = ((price * NEED_BPS) / BPS) * BigInt(weeks);
    const w = byWallet.get(r.owner) ?? { artifacts: [], need: 0n, backing: 0n };
    w.artifacts.push({ asset: r.asset, tier: r.tier, backing: r.backing, pricePaid: price.toString(), need: need.toString() });
    w.need += need;
    w.backing += backing;
    byWallet.set(r.owner, w);
    eligibleBacking += backing;
    eligibleArtifacts++;
  }

  // use: the uncovered market value of the week's burns, by X1 destination (A10.4)
  const use = new Map<string, bigint>();
  for (const b of base.burns) {
    if (!byWallet.has(b.x1)) continue;
    use.set(b.x1, (use.get(b.x1) ?? 0n) + uncovered(b));
  }

  // counted, release, pay (A10.5)
  const wallets = [...byWallet.keys()].sort(cmpStr);
  let W = 0n;
  let totalNeed = 0n;
  let totalUse = 0n;
  const pre = wallets.map((wallet) => {
    const w = byWallet.get(wallet)!;
    const u = use.get(wallet) ?? 0n;
    const counted = min(u, w.need);
    W += counted;
    totalNeed += w.need;
    totalUse += u;
    return { wallet, w, u, counted };
  });
  // A13.3: one release per published base epoch; need (above) and the backing bound are `weeks` weeks' worth
  const R = releaseOf(open);
  const backingBound = backingBoundOf(eligibleBacking, weeks);
  const B = budgetMaxOf(R, W, backingBound);
  let budget = 0n;
  const rows: ExtraWalletRow[] = pre.map(({ wallet, w, u, counted }) => {
    let pay = W > 0n ? (counted * B) / W : 0n;
    if (pay < MIN_PAY) pay = 0n;
    budget += pay;
    return { wallet, artifacts: w.artifacts, need: w.need.toString(), use: u.toString(), counted: counted.toString(), pay: pay.toString() };
  });

  // bounds (A10.7, A13.3): structural, so a correct build never trips them
  if (budget > R) throw new Error(`budget ${budget} above the release ${R}`);
  if (budget > backingBound) throw new Error(`budget ${budget} above ${weeks} week(s) of 4% of the eligible backing (${backingBound})`);
  const leaves: ExtraLeaf[] = [];
  for (const r of rows) if (r.pay !== "0") leaves.push({ index: leaves.length, wallet: r.wallet, amount: r.pay });
  if (leaves.length > EXTRA_MAX_LEAVES) throw new Error(`${leaves.length} leaves: above EXTRA_MAX_LEAVES (${EXTRA_MAX_LEAVES})`);
  const tree = extraTree(epoch, leaves);

  return {
    kind: EXTRA_FORMAT,
    version: EXTRA_VERSION,
    programId,
    epoch,
    firstEpoch,
    createdAt: pool.createdAt,
    baseDataHash: base.dataHash,
    prevDataHash: pv ? pv.dataHash : null,
    window: { startTs, endTs, seasonAfter, weeks },
    policy: policy(),
    pool: { open: open.toString(), lamports: lamports.toString(), slot: pool.slot, init },
    snapshot: snap,
    excluded,
    rows,
    totals: {
      need: totalNeed.toString(), use: totalUse.toString(), counted: W.toString(), release: R.toString(), budgetMax: B.toString(), budget: budget.toString(),
      unpaid: (R - budget).toString(), eligibleBacking: eligibleBacking.toString(), backingBound: backingBound.toString(), eligibleArtifacts, leaves: leaves.length,
    },
    leaves,
    root: tree.root,
  };
}

export function buildExtraFile(base: EpochFileV3, prev: ExtraFileV1 | null | undefined, snapshot: ExtraSnapshot, pool: ExtraPoolInfo): ExtraFileV1 {
  const body = computeExtraEpoch(base, prev, snapshot, pool);
  return { ...body, dataHash: dataHashExtra(body), proofs: extraTree(body.epoch, body.leaves).proofs };
}

// ── A13.6: the skip heartbeat ──────────────────────────────────────────────────────────────────
/** a skip reason is one line of at most this many characters (an error message, cut) */
export const SKIP_REASON_MAX = 500;
export function skipReasonOf(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, SKIP_REASON_MAX) : "";
  return s || "unknown";
}

/**
 * A13.6: extra epoch n as a SKIP heartbeat, for a week whose extra epoch could not be built and could not be rebuilt
 * (A13.7) by the next base run. A pure function of base file n, extra file n−1 (null only for the first extra epoch),
 * the pot reading and the reason, so `verifyExtraFile` recomputes it like any extra file:
 *  - the chain is the normal one (epoch, firstEpoch, baseDataHash, prevDataHash; never a restart, A12.8);
 *  - budget 0: no rows, no leaves, the all-zero root; R is recorded and stays in the extra pot (`unpaid` = R);
 *  - the snapshot is EMPTY at the base snapshot slot (records []), so extra n+1 depends on nothing of week n: every
 *    Artifact is "new" there (a heartbeat) and extra n+2 compares two good snapshots again. One bad week therefore costs
 *    at most two weekly releases, which stay in the pot, and can never block the history.
 */
export function skipExtraEpoch(base: EpochFileV3, prev: ExtraFileV1 | null | undefined, reason: string, pool: ExtraPoolInfo): ExtraBodyV1 {
  const pv = prev ?? null;
  const proto = protoPath(pool);
  if (proto) throw new Error(`pool has a "__proto__" member at ${proto}`);
  checkBase(base);
  const epoch = nat(base.epoch, "base epoch");
  if (epoch < 1) throw new Error("epochs start at 1");
  const programId = pubkey(base.programId, "programId");
  if (pv) checkPrev(pv, epoch, base);
  const firstEpoch = pv ? pv.firstEpoch : epoch;
  const pinError = pinnedExtraError(firstEpoch);
  if (pinError) throw new Error(pinError);
  if (!pv) {
    const startAt = EXTRA_FIRST_EPOCH ?? nat(base.v3FirstEpoch, "base v3FirstEpoch");
    if (epoch !== startAt) throw new Error(`extra epoch ${epoch} without extra-${epoch - 1}.json: a skip never restarts the history either (A12.8, A13.6)`);
  }
  const startTs = nat(base.window.startTs, "base window.startTs");
  const endTs = nat(base.window.endTs, "base window.endTs");
  if (endTs < startTs) throw new Error("base window ends before it starts");
  const createdAt = isoSeconds(pool.createdAt, "pool.createdAt");
  if (createdAt < endTs) throw new Error(`extra build time ${pool.createdAt} is before the base window end ${endTs}`);
  const baseSnap = (base as { snapshot?: { slot?: unknown } }).snapshot;
  const slot = nat(baseSnap?.slot, "base snapshot.slot");
  if (pv && !(slot > pv.snapshot.slot)) throw new Error(`base snapshot slot ${slot} is not after the previous extra snapshot (${pv.snapshot.slot})`);
  if (pv && endTs < pv.snapshot.blockTime) throw new Error("base window end before the previous extra snapshot's block time");
  const open = uint(pool.open, "pool.open", U64);
  const lamports = uint(pool.lamports, "pool.lamports", U64);
  nat(pool.slot, "pool.slot");
  if (lamports < open) throw new Error(`extra pot ${lamports} at build is below X = ${open} (free_after of the previous publication)`);
  const init = checkedInitMark(pool.init, pv);
  const R = releaseOf(open);
  return {
    kind: EXTRA_FORMAT,
    version: EXTRA_VERSION,
    programId,
    epoch,
    firstEpoch,
    createdAt: pool.createdAt,
    baseDataHash: base.dataHash,
    prevDataHash: pv ? pv.dataHash : null,
    window: { startTs, endTs, seasonAfter: seasonAfterOf(startTs), weeks: needWeeksOf(startTs, endTs) },
    policy: policy(),
    pool: { open: open.toString(), lamports: lamports.toString(), slot: pool.slot, init },
    snapshot: { slot, blockTime: endTs, records: [] },
    excluded: [],
    rows: [],
    totals: {
      need: "0", use: "0", counted: "0", release: R.toString(), budgetMax: "0", budget: "0", unpaid: R.toString(), eligibleBacking: "0", backingBound: "0",
      eligibleArtifacts: 0, leaves: 0,
    },
    leaves: [],
    root: EMPTY_ROOT,
    skip: { reason: skipReasonOf(reason) },
  };
}

/** A13.9: the recorded reason when base file n's snapshot is unavailable (its records could not be read), else null. */
export function baseSnapshotUnavailable(base: unknown): string | null {
  const s = base && typeof base === "object" ? (base as { snapshot?: unknown }).snapshot : undefined;
  if (!s || typeof s !== "object" || !Object.prototype.hasOwnProperty.call(s, "unavailable")) return null;
  const u = (s as { unavailable?: { reason?: unknown } }).unavailable;
  return u && typeof u === "object" && typeof u.reason === "string" ? u.reason : "malformed";
}

/** A13.9: the skip reason of the extra epoch on a base whose snapshot is unavailable: a function of the base file alone. */
export function baseSnapshotSkipReason(base: EpochFileV3): string {
  return skipReasonOf(`the base snapshot S(${base.epoch}) is unavailable (A13.9): ${baseSnapshotUnavailable(base) ?? "no"}`);
}

export function buildSkipExtraFile(base: EpochFileV3, prev: ExtraFileV1 | null | undefined, reason: string, pool: ExtraPoolInfo): ExtraFileV1 {
  const body = skipExtraEpoch(base, prev, reason, pool);
  return { ...body, dataHash: dataHashExtra(body), proofs: {} };
}

/** The recorded inputs of an extra file (what computeExtraEpoch consumed besides the base and previous files). */
export function extraInputsOf(f: ExtraBodyV1): { snapshot: ExtraSnapshot; pool: ExtraPoolInfo } {
  return { snapshot: f.snapshot, pool: { open: f.pool.open, lamports: f.pool.lamports, slot: f.pool.slot, createdAt: f.createdAt, init: f.pool.init ?? null } };
}

// ── verification ───────────────────────────────────────────────────────────────────────────────
/**
 * Re-derives extra file n from base file n and extra file n−1 (null for the first extra epoch) and checks the
 * recorded bounds independently of the builder. Returns the mismatches (empty = OK).
 */
export function verifyExtraFile(f: ExtraFileV1, base: EpochFileV3, prev?: ExtraFileV1 | null): string[] {
  const errors: string[] = [];
  const pv = prev ?? null;
  try {
    if (f.kind !== EXTRA_FORMAT || f.version !== EXTRA_VERSION) return [`not an extra file (kind ${String((f as { kind?: unknown }).kind)}, version ${String((f as { version?: unknown }).version)})`];
    const proto = protoPath(f);
    if (proto) return [`the file has a "__proto__" member at ${proto}`];
    const pinError = pinnedExtraError(f.firstEpoch);
    if (pinError) errors.push(pinError);
    if ((base as { version?: unknown }).version !== 3) errors.push("the base file is not a v3 epoch file");
    else {
      if (base.epoch !== f.epoch) errors.push(`base file is epoch ${base.epoch}, expected ${f.epoch}`);
      if (dataHashV3(base) !== base.dataHash) errors.push("the base file does not match its data hash");
      if (f.baseDataHash !== base.dataHash) errors.push("baseDataHash does not match the base file");
    }
    if (!pv) {
      if (f.prevDataHash !== null) errors.push(`extra-${f.epoch - 1}.json is required to verify extra epoch ${f.epoch}`);
      if (f.firstEpoch !== f.epoch) errors.push(`without a previous extra file the history must start here (firstEpoch ${f.firstEpoch})`);
      if ((base as { version?: unknown }).version === 3 && EXTRA_FIRST_EPOCH === null && f.epoch !== base.v3FirstEpoch) {
        errors.push(`extra epoch ${f.epoch} has no previous extra file but the v3 history started at epoch ${base.v3FirstEpoch}: a restart is never valid (X4)`);
      }
    } else {
      if (pv.epoch !== f.epoch - 1) errors.push(`previous extra file is epoch ${pv.epoch}, expected ${f.epoch - 1}`);
      if (dataHashExtra(pv) !== pv.dataHash) errors.push("the previous extra file does not match its data hash");
      if (f.prevDataHash !== pv.dataHash) errors.push("prevDataHash does not match the previous extra file");
      if (f.firstEpoch !== pv.firstEpoch) errors.push("firstEpoch differs from the previous extra file");
      if ((base as { version?: unknown }).version === 3 && pv.baseDataHash !== base.prevDataHash) errors.push("the previous extra file was not built on the base file's previous epoch");
    }
    if (errors.length) return errors;

    // A13.6: a skip heartbeat is recomputed from its recorded reason; any other file from its recorded snapshot
    const skip = (f as { skip?: unknown }).skip;
    if (skip !== undefined && (!skip || typeof skip !== "object" || typeof (skip as { reason?: unknown }).reason !== "string")) return ["skip is not {reason: string}"];
    const { snapshot, pool } = extraInputsOf(f);
    const body = skip !== undefined ? skipExtraEpoch(base, pv, (skip as { reason: string }).reason, pool) : computeExtraEpoch(base, pv, snapshot, pool);
    const keys = new Set([...Object.keys(body), ...Object.keys(f)].filter((k) => k !== "dataHash" && k !== "proofs" && k !== "publish"));
    for (const k of [...keys].sort()) {
      if (canonicalJson((body as unknown as Record<string, unknown>)[k]) !== canonicalJson((f as unknown as Record<string, unknown>)[k])) errors.push(`${k} does not match the recomputation`);
    }

    // bounds and leaf discipline on the recorded numbers, independently of the builder (A10.7)
    const budget = uint(f.totals.budget, "totals.budget", U64);
    const open = uint(f.pool.open, "pool.open", U64);
    if (budget > (open * EXTRA_RELEASE_BPS) / BPS) errors.push("budget above 8% of the free extra pot at the previous publication");
    if (budget > backingBoundOf(uint(f.totals.eligibleBacking, "totals.eligibleBacking"), nat(f.window.weeks, "window.weeks"))) errors.push("budget above window.weeks × 4% of the eligible backing (A13.3)");
    if (f.leaves.length > EXTRA_MAX_LEAVES) errors.push(`${f.leaves.length} leaves: above EXTRA_MAX_LEAVES`);
    let sum = 0n;
    f.leaves.forEach((l, i) => {
      const amount = uint(l.amount, `leaf ${i} amount`, U64);
      sum += amount;
      if (l.index !== i) errors.push(`leaf ${i} has index ${l.index}`);
      if (amount < MIN_PAY) errors.push(`leaf ${i} (${l.wallet}) below MIN_PAY`);
      if (i > 0 && cmpStr(f.leaves[i - 1].wallet, l.wallet) >= 0) errors.push(`leaf ${i} (${l.wallet}) is not after leaf ${i - 1} (${f.leaves[i - 1].wallet})`);
    });
    if (sum !== budget) errors.push("totals.budget is not the sum of the leaves");
    const rowPay = f.rows.reduce((s, r) => s + uint(r.pay, `row ${r.wallet} pay`, U64), 0n);
    if (rowPay !== budget) errors.push("totals.budget is not the sum of the rows' pays");
    // OD-9, independently of the builder: no row carries an Artifact forged before init_extra
    const forgedAt = new Map(f.snapshot.records.map((r) => [r.asset, r.forgedAt]));
    for (const r of f.rows) {
      for (const a of r.artifacts) {
        const at = forgedAt.get(a.asset);
        if (at === undefined || isPreUpgrade(at, f.pool.init ?? null, f.policy.preUpgradeExcluded === true)) errors.push(`row ${r.wallet}: Artifact ${a.asset} is ${at === undefined ? "not in the snapshot" : "pre-upgrade (forged before init_extra, OD-9)"}`);
      }
    }
    for (const r of f.rows) {
      const counted = uint(r.counted, `row ${r.wallet} counted`, U64);
      if (counted > uint(r.need, `row ${r.wallet} need`, U64) || counted > uint(r.use, `row ${r.wallet} use`, U64)) errors.push(`row ${r.wallet}: counted above need or use`);
      if (uint(r.pay, `row ${r.wallet} pay`) > (counted * RHO_MAX_BPS) / BPS) errors.push(`row ${r.wallet}: pay above ${Number(RHO_MAX_BPS) / 10_000}x the counted use`);
    }
    const t = extraTree(f.epoch, f.leaves);
    if (t.root !== f.root) errors.push(`root mismatch: computed ${t.root}`);
    if (canonicalJson(t.proofs) !== canonicalJson(f.proofs)) errors.push("proofs do not match the leaves");
    const h = dataHashExtra(f);
    if (h !== f.dataHash) errors.push(`dataHash mismatch: computed ${h}`);
  } catch (e) {
    errors.push(`verification aborted: ${(e as Error).message}`);
  }
  return errors;
}

// ── On-chain interface (the final program upgrade, SPEC-UPGRADE-v2 §2.15 + W2-3) ─────────────────────────
/**
 * The instruction builders are in x1-v3.ts (v3 IDL only): publishExtraEpochIxV3 / publishExtraEpochV3 (behind the W2-4
 * upgraded-binary guard and a read-only preflight of the program's own checks), claimExtraIxV3, initExtraIxV3,
 * closeExtraEpochIxV3. index.ts sends publish_extra_epoch (`publish-extra`, after the durability gate below); the keeper
 * sends claim_extra (D-47 guard) and close_extra_epoch.
 *
 * Program interface (programs/moon-forge/src/instructions/extra.rs, IDL moon_forge.v3.json):
 *   publish_extra_epoch(epoch_id: u64, root: [u8; 32], data_hash: [u8; 32], total: u64, leaves: u32, weeks: u8)
 *     discriminator 58472b582480adff, 93 data bytes; accounts in order: config, extra_state (w), extra_epoch (w, init,
 *     [extra_epoch, id]), base_epoch ([epoch, id], must exist), prev_epoch (the Epoch PDA of id − 1, checked in the
 *     handler: PDA, owner, discriminator, id, else BadEpochWindow; ignored for id 1), oracle (w, signer), system_program.
 *     Requires, in this order: id = ExtraState.last_epoch + 1 and id ≤ Config.last_epoch (ExtraEpochOrder); when
 *     total > 0, ≥ 6 days since the last paying extra publish (ExtraEpochOrder) and leaves > 0 (EmptyEpoch);
 *     leaves ≤ 1,000 (InvalidProof); 1 ≤ weeks ≤ min(EXTRA_MAX_WEEKS = 13, max(1, ⌊(Epoch(id).published_at −
 *     Epoch(id−1).published_at + 6 h)/1 w⌋)) (BadEpochWindow; id 1: weeks = 1; heartbeats are checked too) — the base
 *     window of the file ends before Epoch(id) was published, so its weeks (needWeeksOf, capped at 13) is always within
 *     it; total ≤ min(⌊free × 800/10^4⌋, weeks × ⌊(live_forged_backing + out_since_publish) × 400/10^4⌋) with
 *     free = accounted − reserved (ExtraBudgetExceeded): the release term is NOT scaled (one release per published base
 *     epoch), the backing term is floored per week then multiplied (backingBoundOf). It sets reserved += total, records
 *     free_after = free − total and resets out_since_publish. An empty epoch (total 0, leaves 0, root = EMPTY_ROOT) is
 *     accepted: the weekly heartbeat, and the A13.6 skip heartbeat. Event ExtraEpochPublished {epoch, root, data_hash,
 *     total, leaves, free_before, free_after, weeks} (weeks appended last).
 *   claim_extra(epoch_id: u64, index: u32, amount: u64, proof: Vec<[u8; 32]>)                       signer: anyone
 *     accounts: config, extra_state (w), extra_epoch (w), extra_vault (w), wallet (w; the beneficiary, an account, not
 *     an argument), payer (signer), system_program. leaf = keccak(LEAF_DOMAIN_EXTRA ‖ epoch LE ‖ index LE ‖ wallet ‖
 *     amount LE), bitmap bit `index`, 48 h hold, 90-day window; the lamports always go to `wallet`. No keeper tip.
 *   close_extra_epoch() (accounts extra_state, extra_epoch, rent_payer) after 90 days returns budget − claimed to the pot.
 *
 * The remaining plumbing: a claim loop built from extraClaimArgs(file, wallet), the ExtraEpochPublished reader for
 * `pool.open` (extraPublishedFromLogsV3 parses the event), and the
 * deterministic snapshot reader (first slot with block time ≥ endTs, owners rebuilt from getSignaturesForAddress
 * + Core create / transfer / burn, last signature per asset). index.ts publishes base n, then extra n, every week.
 * Two completeness gaps bind that plumbing (A10.11): extra-<n>.json must be durable (pushed or uploaded) BEFORE
 * publish_extra_epoch is sent [X-011, X-017], and S(n) is read per asset with minContextSlot ≥ slot from two
 * independent X1 RPCs, never from one getProgramAccounts answer [X-015]; a disagreement aborts the build.
 */
export interface ExtraPublishArgs {
  epoch: number;
  root: string;
  dataHash: string;
  total: string;
  leaves: number;
  /** A13.3: the window's 7-day weeks, the multiplier of the program's backing bound */
  weeks: number;
}

export function extraPublishArgs(f: ExtraFileV1): ExtraPublishArgs {
  return { epoch: f.epoch, root: f.root, dataHash: f.dataHash, total: f.totals.budget, leaves: f.leaves.length, weeks: f.window.weeks };
}

export interface ExtraClaimArgs {
  epoch: number;
  index: number;
  wallet: string;
  amount: string;
  proof: string[];
}

export function extraClaimArgs(f: ExtraFileV1, wallet: string): ExtraClaimArgs | null {
  const leaf = f.leaves.find((l) => l.wallet === wallet);
  if (!leaf) return null;
  return { epoch: f.epoch, index: leaf.index, wallet, amount: leaf.amount, proof: f.proofs[wallet] ?? [] };
}

/** The ExtraEpochPublished event of epoch n, once the program emits it. */
export interface PublishedExtra {
  epoch: number;
  root: string;
  dataHash: string;
  total: string;
  leaves: number;
  freeBefore: string;
  freeAfter: string;
  /** A13.3: the weeks the publication was bounded with (the upgraded program's event) */
  weeks?: number;
}

/** `verify --full` rules for the extra publication (pure; the plumbing reads the event). */
export function verifyPublishedExtra(f: ExtraFileV1, ev: PublishedExtra): string[] {
  const errors: string[] = [];
  if (ev.epoch !== f.epoch) errors.push(`published epoch ${ev.epoch} != ${f.epoch}`);
  if (ev.root !== f.root) errors.push("published root differs from the file");
  if (ev.dataHash !== f.dataHash) errors.push("published data hash differs from the file");
  if (ev.total !== f.totals.budget) errors.push(`published total ${ev.total} != budget ${f.totals.budget}`);
  if (ev.leaves !== f.leaves.length) errors.push(`published leaf count ${ev.leaves} != ${f.leaves.length}`);
  if (ev.weeks !== undefined && ev.weeks !== f.window.weeks) errors.push(`published weeks ${ev.weeks} != window.weeks ${f.window.weeks} (A13.3)`);
  const before = uint(ev.freeBefore, "free_before", U64);
  const after = uint(ev.freeAfter, "free_after", U64);
  if (before < uint(f.pool.open, "pool.open", U64)) errors.push("free_before is below the X the file was built on");
  if (after !== before - uint(f.totals.budget, "budget", U64)) errors.push("free_after != free_before − total");
  return errors;
}

/**
 * The link between extra file n and the previous publication: `pool.open` must be ExtraEpochPublished(n−1).free_after
 * (the free extra pot at init_extra, or "0" before the upgrade, for the first extra epoch).
 */
export function verifyExtraChainLink(f: ExtraBodyV1, prevPublished: { freeAfter: string } | null): string[] {
  if (!prevPublished) return f.epoch === f.firstEpoch ? [] : ["the previous extra publication is required"];
  return prevPublished.freeAfter === f.pool.open ? [] : [`pool.open ${f.pool.open} != previous free_after ${prevPublished.freeAfter}`];
}
