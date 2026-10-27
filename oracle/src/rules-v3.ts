/**
 * T2-RULES (CF-13, X-259, CF-19): the rules blocks in force for v3 epochs, by version. Every v3 file records the block
 * it was built under (rewards.ts RulesBlockV3, hashed with the file); the engine is a pure function of that block, and
 * this registry says which block an epoch must carry: the build takes it from here, the self-verification and
 * `verify` check the file against it, and publishEpochV3 refuses a file whose programHash is not the pinned binary.
 *
 * A rules change is a NEW version appended below (rulesId + 1, announced at least two epochs before its first epoch,
 * D-20 / WORDING "a versioned rules change with 2 epochs of notice"), never an edit of a published version: old files
 * keep verifying against the version they were built under.
 *
 * Operator wallets (D-18) and PROOF_BURN_RULE (s7 MANIFEST R1). The default of round 4 is option (c): a dated, named
 * exception. Before the first proof-plan burn, the operator appends a version whose operatorWallets lists:
 *   - `wallets`: every wallet the operator controls that may burn (roles only, never a funding link); their burns are
 *     flagged `operator: true` and ranked after every other burn of the week, in both passes;
 *   - `exceptions`: [{ name, wallets, fromTs, untilTs, published }] for the proof plan: the burns of those wallets
 *     stamped in [fromTs, untilTs) compete for the week's capacity like any other burn and are recorded with
 *     `exception: name`; `published` is the YYYY-MM-DD (UTC) of the POLICY-CHANGES.md text that names them, on or
 *     before the day the range starts. Outside the range those wallets rank last as operator wallets.
 * Option (a) is the same version with the proof wallets in `wallets` and no exception. The registry below holds no
 * wallet today: none is listed until the operator publishes one (and the epoch-1 burn is never attributed to anyone).
 */
import { DEFAULT_RULES_V3, rulesBlockOf, RulesBlockV3 } from "./rewards";

export interface RulesVersionV3 {
  /** the first epoch the version applies to; null = from the first v3 epoch (rulesId 1 only) */
  fromEpoch: number | null;
  /** YYYY-MM-DD (UTC) of the public announcement; null for the rules of the first v3 epoch */
  announced: string | null;
  /** the block, without programHash (it is the pinned binary's, filled in by rulesForEpochV3) */
  rules: Omit<RulesBlockV3, "programHash">;
}

const { programHash: _ph, ...RULES_1 } = DEFAULT_RULES_V3;

/** Append-only. rulesId 1: the rules of the first v3 epoch (tip minimum 0.2 XNT final, every leaf claimed, no operator wallet yet). */
export const RULES_V3_VERSIONS: readonly RulesVersionV3[] = Object.freeze([{ fromEpoch: null, announced: null, rules: RULES_1 }]);

/** Why a registry is not usable (null when it is): versions 1, 2, … in order, each a valid block, epochs increasing. */
export function rulesRegistryErrorV3(versions: readonly RulesVersionV3[] = RULES_V3_VERSIONS): string | null {
  if (!versions.length) return "no rules version";
  let lastFrom = 0;
  for (const [i, v] of versions.entries()) {
    try {
      rulesBlockOf({ ...v.rules, programHash: null });
    } catch (e) {
      return `rules version ${i + 1}: ${(e as Error).message}`;
    }
    if (v.rules.rulesId !== i + 1) return `rules version ${i + 1} has rulesId ${v.rules.rulesId}`;
    if (i === 0) {
      if (v.fromEpoch !== null || v.announced !== null) return "rules version 1 applies from the first v3 epoch (fromEpoch and announced null)";
      continue;
    }
    if (!Number.isSafeInteger(v.fromEpoch) || (v.fromEpoch as number) <= lastFrom) return `rules version ${i + 1}: fromEpoch ${String(v.fromEpoch)} is not after the previous version's`;
    if (typeof v.announced !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.announced) || new Date(`${v.announced}T00:00:00.000Z`).toISOString().slice(0, 10) !== v.announced) {
      return `rules version ${i + 1}: announced ${JSON.stringify(v.announced)} is not a YYYY-MM-DD date`;
    }
    lastFrom = v.fromEpoch as number;
  }
  return null;
}

/** The rules block epoch `epoch` is built under: the last version whose fromEpoch is at or before it, with the pinned program hash. */
export function rulesForEpochV3(epoch: number, programHash: string | null, versions: readonly RulesVersionV3[] = RULES_V3_VERSIONS): RulesBlockV3 {
  const bad = rulesRegistryErrorV3(versions);
  if (bad) throw new Error(`rules registry: ${bad}`);
  let v = versions[0];
  for (const x of versions) if (x.fromEpoch !== null && x.fromEpoch <= epoch) v = x;
  return rulesBlockOf({ ...JSON.parse(JSON.stringify(v.rules)), programHash });
}

/**
 * X-010 / X-022: every chain a build READ (not skipped) records its portal counters at toBlock; the build's reader
 * always reads both, so a file without them was not built by the oracle's own path (the self-verification and
 * `verify` refuse it). The engine itself accepts null, for the week-so-far feed and older recordings.
 */
export function countersMissingV3(f: { chains: { chainId: number; skipped: boolean; missionsAt?: unknown; burnedAt?: unknown }[] }): string[] {
  return f.chains
    .filter((c) => !c.skipped && (typeof c.missionsAt !== "string" || typeof c.burnedAt !== "string"))
    .map((c) => `chain ${c.chainId} records no portal counters (missionsAt / burnedAt, X-010)`);
}

/**
 * Null when file `f` carries exactly the rules block in force for its epoch (with `programHash`, the pinned binary's
 * hash or null), else why not: a v3 file written before the rules block, a block that is not a published version, a
 * version used before its epoch, or a program hash that is not the pin.
 */
export function rulesInForceErrorV3(f: { epoch: number; rulesBlock?: unknown }, programHash: string | null, versions: readonly RulesVersionV3[] = RULES_V3_VERSIONS): string | null {
  if (f.rulesBlock === undefined) return `epoch ${f.epoch} has no rules block (T2-RULES: every v3 file records the rules it was built under)`;
  let mine: RulesBlockV3;
  try {
    mine = rulesBlockOf(f.rulesBlock);
  } catch (e) {
    return `epoch ${f.epoch}: ${(e as Error).message}`;
  }
  const want = rulesForEpochV3(f.epoch, programHash, versions);
  if (mine.programHash !== want.programHash) return `epoch ${f.epoch} records programHash ${mine.programHash}, not the pinned binary's ${want.programHash}`;
  if (JSON.stringify(mine) !== JSON.stringify(want)) return `epoch ${f.epoch} records rules ${mine.rulesId}, not the rules version in force for it (${want.rulesId}) as published in rules-v3.ts`;
  return null;
}
