/**
 * Rewards v3 plumbing (SPEC-v3 §7 and §12, amendments A7.4, A7.7, A8, A11): the orchestration between the recorded
 * sources (EVM portals, markets, X1) and the pure engine in rewards.ts. Everything here is written against an
 * injected `SourcesV3`, so the whole dry build runs against recorded fixtures (test/flow.test.ts) and a live run can
 * be recorded (`npm run epoch -- --dry --record <file>`). Nothing here touches the network or the file system.
 *
 * Rules (A11):
 *  - Version: REWARDS_VERSION / V3_FIRST_EPOCH select v3 from the switch epoch on; a v3 previous file forces v3
 *    (versions never go backwards); before the switch epoch the v2 path runs byte-for-byte as today.
 *  - A chain whose RPC, portal counter, head or market fails is SKIPPED with its cursor carried (the engine keeps its
 *    toBlock, L and curve): a chain failure never aborts the epoch and never moves a cursor past unread blocks.
 *  - Cursors continue exactly from the previous file's toBlock; a chain read for the first time starts at its
 *    configured start block (max(0, startBlock − 1)), as v2 does.
 *  - Mission continuity: the mission ids read in (from, to] must run contiguously from the last id already paid (the
 *    local epoch files, cross-checked with portal.totalMissions at `from` when the RPC serves that state) up to
 *    portal.totalMissions at `to`, read from the SAME RPC as the logs after that RPC's own head was checked. A gap,
 *    a duplicate, a short read or a counter below what was already paid skips the chain: the burns are read next
 *    time from the same cursor. A silent log omission can therefore never move a cursor past a burn.
 *  - The window end is the X1 block time of the snapshot slot (A8); a null block time re-reads the snapshot. The slot is
 *    the context slot of the finalized record list (A13.10); records that cannot be read or are refused never stop the
 *    base: it is built with an empty snapshot marked `unavailable` and that week's extra is a skip heartbeat (A13.9).
 *  - Publication only when the window is at least MIN_EPOCH_INTERVAL (6 days) long.
 *  - Every leaf is claimed for its burner; the publish record counts the claims that carry a keeper tip and the dust
 *    claims that do not, so dust leaves are never advertised as claimable tips.
 */
import { ChainConfig, PROGRAM_ID } from "./config";
import { Burn } from "./evm";
import { EpochFile, Leaf, toE18 } from "./epoch";
import {
  AnyEpochFile, BurnInputV3, ChainInputV3, computeEpochV3SkippingUnpriced, dataHashV3, EpochFileV3, EpochInputsV3, HOUR, keeperTipDue,
  medianE18, MIN_EPOCH_INTERVAL, programClaims, PublishedEpochV3, SnapshotRecord, snapshotWindowEnd, switchRefsFromV2, SwitchRefV3, uint, V3_FIRST_EPOCH, WEEK,
  CLOCK_SKEW_MAX, ComputeOptsV3, CLOCK_UNKNOWN, isoSeconds, rebuildReason, isBlockTime, reasonLineOf, snapshotRecordsError,
  countersErrorV3, RulesBlockV3, LiquiditySampleV3, XdexReadingV3, GateReasonV3, GATE_HOLD_SECONDS, sidecarFileV3, xntPoolActiveV3, XntPoolV3,
  proofsOfV3,
} from "./rewards";
import { createHash } from "crypto";
import { closesFromOhlcvV3, QUOTE_USD_MAX_DIFF_BPS, quoteUsdDiffBpsV3 } from "./pricing";
import type { XenRouteV3 } from "./pricing";
import { rulesForEpochV3 } from "./rules-v3";
import {
  baseSnapshotSkipReason, baseSnapshotUnavailable, buildExtraFile, buildSkipExtraFile, dataHashExtra, EXTRA_FIRST_EPOCH, EXTRA_POT_LIVE, ExtraFileV1, ExtraInitMark, ExtraSnapshot,
  verifyExtraFile,
} from "./extra";

// ── types read from the sources ──────────────────────────────────────────────────────────────

/** One chain's logs and portal counters, read from ONE RPC whose own final head was checked against toBlock. */
export interface ChainReadV3 {
  burns: Burn[];
  /** portal.totalMissions() at toBlock */
  totalMissions: string;
  /** portal.totalMissions() at fromBlockExclusive, null when the RPC does not serve that state */
  totalMissionsBefore: string | null;
  /** X-010: portal.totalBurned() at toBlock (absent in recordings made before it was read) */
  totalBurned?: string;
  /** the host of the RPC that served the read (absent in older recordings) */
  rpc?: string;
}

/** X-010 / X-022: the portal counters at toBlock as a second provider read them (evm.ts portalCountersV3). */
export interface PortalCountersV3 {
  totalMissions: string;
  totalBurned: string;
  rpc: string;
}

export interface XenMarketV3 {
  refUsd: number;
  spotUsd: number;
  liquidityUsd: number;
  topPool: string;
  xenIsBase: boolean;
  pools: { address: string; reserveUsd: number }[];
  /** D-13: the price pool's creation time (unix s); absent in older recordings */
  poolCreatedAt?: number | null;
  /** A5-c / the kit's route: the price pool's other token, its stated USD price and the pool fee; absent in older recordings */
  quote?: { address: string; usd: number; feeBps: number };
}

/** D-13 / the kit's route: the on-chain depth of a chain's eligible pools and the price pool's reserves (pricing.ts xenDepthV3). */
export interface XenDepthV3 {
  micro: string | null;
  route: XenRouteV3 | null;
}

export interface SnapshotRecordV3 extends SnapshotRecord {
  /** ArtifactRecord.forged_at (unix seconds), for the extra snapshot */
  forgedAt: number;
}

export interface SnapshotReadV3 {
  /** A13.10: the context slot of the finalized record list (every record listed exists at it) */
  slot: number;
  /** getBlockTime(slot); null when the node has no block time for it (the snapshot is re-read) */
  blockTime: number | null;
  records: SnapshotRecordV3[];
  /** A13.9: set by readSnapshotV3 alone, when the records could not be read or one was refused (records is then []) */
  unavailable?: { reason: string };
}

/** An EpochPublished event with its transaction and the Epoch account fields (null fields when the account read failed). */
export interface PublishedRecordV3 {
  tx: string;
  slot: number;
  blockTime: number | null;
  epoch: number;
  root: string;
  dataHash: string;
  totalScore: string;
  leaves: number;
  /** EpochPublished.budget: the full budget, drop reserve included */
  budget: string;
  dropReserve: string;
  dropSlot: string;
  freePoolBefore: string;
  /** Epoch.published_at */
  publishedAt: number | null;
  /** Epoch.budget (net of the drop reserve) */
  netBudget: string | null;
  rateCap: string | null;
}

export interface SourcesV3 {
  finalHead(chain: ChainConfig): Promise<number>;
  readChain(chain: ChainConfig, fromBlockExclusive: number, toBlock: number): Promise<ChainReadV3>;
  market(chain: ChainConfig): Promise<XenMarketV3>;
  /** closes (USD × 1e18, oldest first) of the closed hourly candles before `hourStart` on the chain's price pool; null = none */
  xenCloses(chain: ChainConfig, market: XenMarketV3, hourStart: number): Promise<string[] | null>;
  /** the same on the XNT/USDC.X pool (1 USDC.X = $1); `pool` = the active XNT price pool (D-22 b; absent: the default) */
  xntCloses(hourStart: number, pool?: string): Promise<string[] | null>;
  totalSupply(chain: ChainConfig, block: number): Promise<string>;
  snapshot(): Promise<SnapshotReadV3>;
  /**
   * A13.9 (review R2): a finalized slot and its block time ALONE, the window anchor when the Artifact records cannot be
   * read. Optional: without it a snapshot that cannot be read stops the run as before.
   */
  anchor?(): Promise<{ slot: number; blockTime: number | null }>;
  freePool(): Promise<{ lamports: string; slot: number }>;
  xnt(): Promise<{ twapE18: string; apiE18: string; source: string }>;
  /** the EpochPublished record of an epoch (its publish transaction when known) */
  published(epoch: number, tx?: string): Promise<PublishedRecordV3 | null>;
  /** the last Core transaction of each asset at or before `slot` (base58 signature), for the extra snapshot */
  assetSignatures(assets: string[], slot: number): Promise<Record<string, string>>;
  now(): string;
  /**
   * A12 (P5): whether a MissionStarted log with this id exists at or before `toBlock` (one indexed-topic query);
   * null when the RPC cannot answer. Optional: without it a gap before the cursor is reported as omitted logs.
   */
  missionBefore?(chain: ChainConfig, missionId: string, toBlock: number): Promise<boolean | null>;
  /** A12 (RE-1): the X1 block time of a slot (null when unknown); optional, used before a publication is sent */
  blockTime?(slot: number): Promise<number | null>;
  /**
   * X-010 / X-022: the portal counters at toBlock through a provider other than `exceptRpc` (the one that served the
   * logs); null when no other provider answers. Optional: without it the counters are recorded unconfirmed.
   */
  counters?(chain: ChainConfig, toBlock: number, exceptRpc: string | null): Promise<PortalCountersV3 | null>;
  /** T2-RULES: the rules block in force for an epoch (rules-v3.ts with the pinned binary's hash); optional: the registry without a pin */
  rulesBlock?(epoch: number): RulesBlockV3;
  /**
   * D-13: the eligible pools' XEN-side depth read on-chain at `block` (null micro: not read), with the price pool's route;
   * optional: without it the GeckoTerminal reading is used alone
   */
  depth?(chain: ChainConfig, market: XenMarketV3, block: number): Promise<XenDepthV3>;
  /** D-22 (a): the XDEX WXNT/USDC.X pool at the build (xdex-v3.ts); optional: without it the next window has no new cap reading */
  xdex?(): Promise<XdexReadingV3>;
  /** D-23: the raw candle request behind a candle key ("<chainId>:<hourStart>" | "xnt:<hourStart>"), when the sources kept it */
  rawCandles?(key: string): { url: string; ohlcv: number[][] } | null;
  /**
   * A5-c: Chainlink's USD price of the price pool's quote token at `block` (pricing.ts chainlinkUsdV3); null = no listed
   * feed or no fresh round (the check is then not made, with a warning). Optional.
   */
  quoteUsd?(chain: ChainConfig, market: XenMarketV3, block: number): Promise<{ feed: string; pair: string; usdE18: string } | null>;
  /** D-22 (b): the TVL of every candidate XNT/USD pool (µUSD); optional: without it the pool record keeps its history */
  xntPools?(): Promise<{ pool: string; tvlMicro: string }[]>;
}

export interface SkippedChainV3 {
  chainId: number;
  name: string;
  reason: string;
}

export interface AssembledV3 {
  inputs: EpochInputsV3;
  skipped: SkippedChainV3[];
  warnings: string[];
  /** the snapshot read the window end came from (with forged_at, for the extra epoch) */
  snapshotRead: SnapshotReadV3;
  /** A12 (P3): epoch n−1's publication as read (its transaction backfills a file whose publish record is missing) */
  prevPublished: PublishedRecordV3 | null;
  /** the kit's market route per chain (the price pool's reserves at toBlock), when the depth was read */
  routes?: Map<number, XenRouteV3>;
  /** D-23: the price sidecar to write next to epoch-<n>.json (null for the week-so-far feed, which reuses readings) */
  sidecar?: PriceSidecarV3 | null;
}

// ── version switch ─────────────────────────────────────────────────────────────────────────────
/**
 * The rewards version of epoch `epoch`: the pinned V3_FIRST_EPOCH wins; otherwise the environment's V3_FIRST_EPOCH
 * (the first v3 epoch) or REWARDS_VERSION ("2" | "3"); v2 by default. A v3 previous file forces v3, whatever the
 * environment says: a v2 interlude would re-initialize the Forge Right ledger (TR-2), so it is refused loudly.
 */
export function rewardsVersionFor(epoch: number, prev: { version?: unknown; epoch?: number } | null, env: Record<string, string | undefined> = process.env, pinned: number | null = V3_FIRST_EPOCH): 2 | 3 {
  let v: 2 | 3;
  if (pinned !== null) v = epoch >= pinned ? 3 : 2;
  else if (env.V3_FIRST_EPOCH) {
    const first = Number(env.V3_FIRST_EPOCH);
    if (!Number.isSafeInteger(first) || first < 1) throw new Error(`V3_FIRST_EPOCH=${env.V3_FIRST_EPOCH} is not an epoch number`);
    v = epoch >= first ? 3 : 2;
  } else if (env.REWARDS_VERSION === "3") v = 3;
  else if (env.REWARDS_VERSION === undefined || env.REWARDS_VERSION === "" || env.REWARDS_VERSION === "2") v = 2;
  else throw new Error(`REWARDS_VERSION=${env.REWARDS_VERSION}: expected 2 or 3`);
  if (prev && prev.version === 3 && v === 2) {
    throw new Error(`epoch-${(prev as { epoch?: number }).epoch}.json is a v3 file: the rewards version never goes back to v2 (set REWARDS_VERSION=3 or pin V3_FIRST_EPOCH)`);
  }
  return v;
}

/**
 * R-2 (round-3 review): the margin over MIN_EPOCH_INTERVAL between the landing of the last paying extra epoch and the
 * next base epoch: 2 h on mainnet (it scales with DAY, so the localnet profile keeps its compressed week).
 */
export const EXTRA_LAG_MARGIN = MIN_EPOCH_INTERVAL / 72;

/**
 * R-2: when base epoch n may be published so that its extra epoch, sent minutes after it, can never be refused by the
 * program's 6-day interval between PAYING extra epochs (measured on their landing times, extra.rs): `lastPayingExtraTs`
 * = ExtraState.last_publish_ts (0: none yet). `wait` = seconds still to wait (0 = due).
 */
export function baseDueAfterExtraV3(lastPayingExtraTs: number, now: number): { ready: number; wait: number } {
  if (!lastPayingExtraTs) return { ready: 0, wait: 0 };
  const ready = lastPayingExtraTs + MIN_EPOCH_INTERVAL + EXTRA_LAG_MARGIN;
  return { ready, wait: Math.max(0, ready - now) };
}

export type UpgradeStatusV3 = "upgraded" | "legacy" | "unknown";

/**
 * R-3 (round-3 review): the rewards version of epoch `epoch` as it is BUILT, gated by the W2-4 verdict of the live
 * program (detection rule: the v3 behaviour switches on by itself when the upgraded program is detected; while the old
 * binary is live, the v2 path stays as on main). On top of rewardsVersionFor (which still throws for a v3 history
 * asked to go back to v2):
 *  - a v3 previous file: v3 (a v3 history never goes back; publishEpochV3 itself refuses a binary that is not the
 *    upgraded one, so a rollback still stops the run);
 *  - "legacy" (the live v2 binary): v2, with a warning when the pin or the environment asked for v3 (S6 is late: the
 *    v2 rules keep paying this week instead of a refused run every 4 hours);
 *  - "unknown" (an RPC error or a half-done upgrade): v2 when v2 was selected (the v2 path never read the probe), a
 *    refusal (fail closed) when v3 was;
 *  - "upgraded": v3 when v3 was selected; with nothing selected (no pin, no environment) v3 too, by detection; a v2
 *    epoch on the upgraded binary is REFUSED when the pin or the environment selects it (its claims would wait 48 h, it
 *    has no drop reserve, and no extra epoch would be built for it, so the extra pot's chain of epochs would stop):
 *    the owner re-pins V3_FIRST_EPOCH to this epoch (or clears the environment).
 * C-14 (r4-fix, review r4 finding 2): any outcome that would build a v2 epoch at or after the v2 boundary (V2_BOUNDARY_TS:
 * Monday 2026-11-09 06:00 UTC, the boundary release after the last v2 publication) is `v2Closed`: the caller builds and
 * publishes nothing, and the burns made after the last v2 file wait for the first v3 epoch, keeping their time.
 */
export function rewardsVersionGatedV3(
  epoch: number, prev: { version?: unknown; epoch?: number } | null, verdict: UpgradeStatusV3,
  env: Record<string, string | undefined> = process.env, pinned: number | null = V3_FIRST_EPOCH, now: number = Math.floor(Date.now() / 1000),
): { version: 2 | 3; warning: string | null; v2Closed: boolean } {
  const r = rewardsVersionGatedInnerV3(epoch, prev, verdict, env, pinned);
  if (r.version === 2 && v2ClosedV3(now, env)) return { version: 2, warning: `${V2_CLOSED_TEXT} (epoch ${epoch} is not built: the live program is ${verdict === "legacy" ? "still the v2 binary, S6 is not live yet" : "not confirmed upgraded"}; C-14)`, v2Closed: true };
  return { ...r, v2Closed: false };
}

/**
 * C-14 (owner default 2026-10-20, "boundary release": Monday 2026-11-09 06:00 UTC, after the quiet period; r4-fix, review
 * r4 finding 2): the v2 rules close at this time. The last v2 epoch is the one published before it (the weekly epoch of
 * Sunday 2026-11-08). From then on the oracle builds and publishes NO v2 epoch, also when S6 slips and the live program
 * is still the v2 binary: every burn after the last v2 file waits for the first v3 epoch, keeping its time (it is paid
 * under the v3 rules), exactly as release-staging/boundary POLICY-CHANGES.md "Precondition" and the site say. Defined by
 * a date, never by a future epoch number (POLICY-CHANGES rule 3: a week without burns publishes no v2 epoch).
 * V2_BOUNDARY_TS (seconds) overrides it for localnet rehearsals only; no workflow sets it.
 */
export const V2_BOUNDARY_TS_DEFAULT = 1_794_204_000; // 2026-11-09T06:00:00Z
export const V2_CLOSED_TEXT = "v2 closed at the boundary: later burns wait for the first v3 epoch with their own time";
export function v2BoundaryTsV3(env: Record<string, string | undefined> = process.env): number {
  const v = (env.V2_BOUNDARY_TS ?? "").trim();
  return /^\d{1,12}$/.test(v) ? Number(v) : V2_BOUNDARY_TS_DEFAULT;
}
export const v2ClosedV3 = (now: number, env: Record<string, string | undefined> = process.env): boolean => now >= v2BoundaryTsV3(env);

function rewardsVersionGatedInnerV3(
  epoch: number, prev: { version?: unknown; epoch?: number } | null, verdict: UpgradeStatusV3,
  env: Record<string, string | undefined>, pinned: number | null,
): { version: 2 | 3; warning: string | null } {
  if (prev && prev.version === 3) {
    // a v3 history continues as v3 with nothing set (the detection switched it on); a pin or an environment that
    // selects v2 for it is still refused loudly by rewardsVersionFor ("never goes back")
    if (pinned !== null || env.V3_FIRST_EPOCH || (env.REWARDS_VERSION ?? "") !== "") rewardsVersionFor(epoch, prev, env, pinned);
    return { version: 3, warning: null };
  }
  const sel = rewardsVersionFor(epoch, prev, env, pinned);
  if (verdict === "unknown") {
    if (sel === 3) throw new Error(`the upgrade verdict is unknown (an RPC error or a half-done upgrade): refusing to build epoch ${epoch} under the v3 rules (fail closed, W2-4 / R-3)`);
    return { version: 2, warning: null };
  }
  if (verdict === "legacy") {
    return { version: 2, warning: sel === 3 ? `S6 is not live yet: epoch ${epoch} is built under the v2 rules this week (the v3 rules were selected, but the live program is the v2 binary; R-3)` : null };
  }
  if (sel === 3) return { version: 3, warning: null };
  if (pinned !== null) {
    throw new Error(`the upgraded binary is live, but V3_FIRST_EPOCH is pinned at ${pinned}, after epoch ${epoch}: a v2 epoch on the upgraded binary is refused (claims on hold, no drop reserve, no extra epoch for it: the extra pot would stop). Re-pin V3_FIRST_EPOCH to ${epoch} (R-3)`);
  }
  if (env.V3_FIRST_EPOCH || env.REWARDS_VERSION === "2") {
    throw new Error(`the upgraded binary is live, but the environment selects the v2 rules for epoch ${epoch} (V3_FIRST_EPOCH=${env.V3_FIRST_EPOCH ?? ""} REWARDS_VERSION=${env.REWARDS_VERSION ?? ""}): a v2 epoch on the upgraded binary is refused; clear them or set V3_FIRST_EPOCH=${epoch} (R-3)`);
  }
  return { version: 3, warning: `the upgraded binary is live (W2-4): epoch ${epoch} is the first v3 epoch, switched on by the detection; pin V3_FIRST_EPOCH = ${epoch} after it is published` };
}

// ── helpers over the local epoch files ─────────────────────────────────────────────────────────
/** The highest mission id already recorded per chain over every local epoch file (0n when none). */
export function lastMissionIds(files: AnyEpochFile[]): Map<number, bigint> {
  const last = new Map<number, bigint>();
  for (const f of files) {
    for (const b of f.burns ?? []) {
      const id = BigInt(b.missionId);
      if (id > (last.get(b.chainId) ?? 0n)) last.set(b.chainId, id);
    }
  }
  return last;
}

/** The switch epoch's reference history: the last (up to) 4 v2 files at or before `prevEpoch`, most recent first. */
export function v2SwitchFiles(files: AnyEpochFile[], prevEpoch: number): EpochFile[] {
  return files.filter((f): f is EpochFile => f.version === 2 && f.epoch <= prevEpoch).sort((a, b) => b.epoch - a.epoch).slice(0, 4);
}

/** The previous file's cursor for a chain (v2 or v3 record), or undefined for a chain read for the first time. */
export function prevCursor(prev: AnyEpochFile | null, chainId: number): number | undefined {
  return prev?.chains.find((c) => c.chainId === chainId)?.toBlock;
}

// ── mission continuity (X-010, X-022) ──────────────────────────────────────────────────────────
/**
 * The ids read in (from, to] must be exactly first..totalMissions(to), first = the id after the last one already
 * counted: portal.totalMissions at `from` when the RPC serves it, otherwise the local files' last id. Returns the
 * reason to skip the chain, and a warning when the portal counts missions before the cursor that no file paid.
 */
export function missionContinuity(
  burns: { missionId: string }[], lastPaid: bigint, totalMissions: bigint, totalBefore: bigint | null, foundBefore: boolean | null = null,
): { error: string | null; warning: string | null; probe: bigint | null } {
  const r = continuity(burns, lastPaid, totalMissions, totalBefore, foundBefore);
  return { probe: null, ...r };
}

function continuity(
  burns: { missionId: string }[], lastPaid: bigint, totalMissions: bigint, totalBefore: bigint | null, foundBefore: boolean | null,
): { error: string | null; warning: string | null; probe?: bigint | null } {
  let warning: string | null = null;
  let first = lastPaid + 1n;
  const sorted = burns.map((b) => BigInt(b.missionId)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // A12 (P5): without the counter at the cursor, ids that run contiguously up to the counter but start above
  // lastPaid + 1 are either a short read or missions before the cursor that no file paid. One indexed-topic query for
  // mission lastPaid + 1 at or before the cursor tells them apart (found: A11-b warning; not found: omitted logs).
  if (totalBefore === null && sorted.length && sorted[0] > first && sorted[sorted.length - 1] === totalMissions && sorted.every((id, i) => id === sorted[0] + BigInt(i))) {
    if (foundBefore === null) {
      return { error: `${sorted.length} MissionStarted logs read but the portal counts ${totalMissions - first + 1n} missions in the range (${first}..${totalMissions}): the RPC omitted logs, or missions ${first}..${sorted[0] - 1n} are before the cursor (unconfirmed)`, warning, probe: first };
    }
    if (foundBefore) totalBefore = sorted[0] - 1n;
  }
  if (totalBefore !== null) {
    if (totalBefore < lastPaid) {
      return { error: `portal.totalMissions at the cursor is ${totalBefore}, below the last mission already paid (${lastPaid}): the RPC serves a wrong state`, warning };
    }
    if (totalBefore > lastPaid) {
      warning = `missions ${lastPaid + 1n}..${totalBefore} are before the cursor and in no local epoch file: they were never paid (missing files, or a burn lost before v3)`;
    }
    first = totalBefore + 1n;
  }
  if (totalMissions < first - 1n) return { error: `portal.totalMissions at toBlock is ${totalMissions}, below the ${first - 1n} missions already counted: the RPC serves a wrong state`, warning };
  const expected = totalMissions - first + 1n;
  const ids = sorted;
  if (BigInt(ids.length) < expected) {
    return { error: `${ids.length} MissionStarted logs read but the portal counts ${expected} missions in the range (${first}..${totalMissions}): the RPC omitted logs`, warning };
  }
  if (BigInt(ids.length) > expected) {
    return { error: `${ids.length} MissionStarted logs read but the portal counts ${expected} missions in the range (${first}..${totalMissions}): duplicate ids or a wrong counter`, warning };
  }
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== first + BigInt(i)) return { error: `mission ids do not run contiguously from ${first}: got ${ids.slice(0, 12).join(", ")}${ids.length > 12 ? ", …" : ""}`, warning };
  }
  return { error: null, warning };
}

// ── readings ───────────────────────────────────────────────────────────────────────────────────
/** The engine's two readings from a list of closed hourly closes: median and last close, or "fallback" (both "0"). */
export function candleReadings(closes: string[] | null | undefined): { medianE18: string; lastCloseE18: string; source: "candles" | "fallback" } {
  const fallback = { medianE18: "0", lastCloseE18: "0", source: "fallback" as const };
  if (!closes || !closes.length) return fallback;
  let vals: bigint[];
  try {
    vals = closes.map((c) => uint(c, "close"));
  } catch {
    return fallback;
  }
  if (vals.some((v) => v === 0n)) return fallback;
  return { medianE18: medianE18(vals).toString(), lastCloseE18: vals[vals.length - 1].toString(), source: "candles" };
}

/** One hour's closed-candle readings, as candleReadings returns them. */
export type CandleReadingV3 = ReturnType<typeof candleReadings>;

/**
 * Readings already known for an hour (the week-so-far feed's previous file, feed-v3.ts knownReadingsOfFeedV1): null =
 * not known, read the candles. Only "candles" readings are ever known (a "fallback" hour is read again).
 */
export interface KnownReadingsV3 {
  xen(chainId: number, hourStart: number): CandleReadingV3 | null;
  xnt(hourStart: number): CandleReadingV3 | null;
}

export function marketV3(m: XenMarketV3): ChainInputV3["market"] {
  return {
    spotE18: toE18(m.spotUsd),
    refUsdE18: toE18(m.refUsd),
    priceSource: `reserve-weighted spot of ${m.pools.length} eligible pools`,
    pools: m.pools.map((p) => ({ address: p.address, reserveUsd: String(p.reserveUsd), createdAt: null })),
  };
}

/** The on-chain event fields of a burn (what `verify --full` compares with the logs; prices are market data). */
export const burnEvent = (b: Burn) => ({
  chainId: b.chainId, txHash: b.txHash, logIndex: b.logIndex, blockNumber: b.blockNumber, missionId: b.missionId, pilot: b.pilot,
  amountWei: b.amountWei, tier: b.tier, x1: b.x1, timestamp: b.timestamp,
});

class SkipChain extends Error {}

/** D-21: a market read that found no eligible market (pricing.ts xenMarket / xenMarketV3 refusals), not an RPC failure. */
export function isNoMarketErrorV3(e: unknown): boolean {
  return /no XEN market found|no XEN price for/.test(String((e as Error)?.message ?? e));
}

// ── inputs ─────────────────────────────────────────────────────────────────────────────────────
/**
 * Reads everything epoch `n` needs and returns the engine's inputs. The X1 snapshot is read first (its block time is
 * the window end, A8), then the previous publication (window start and F_ref), then every configured chain with a
 * portal: a chain that fails at any step is listed in `skipped` and left out of the inputs, so the engine carries it.
 * Throws only for what no epoch can do without: the window anchor (A13.9: never the Artifact records, which only the
 * extra pot reads), the previous publication, the pool and the XNT price.
 */
export async function assembleInputsV3(
  n: number, prev: AnyEpochFile | null, s: SourcesV3, chains: ChainConfig[], files: AnyEpochFile[], log: (m: string) => void = () => {},
  opts: {
    stopIfNotDue?: boolean; known?: KnownReadingsV3 | null; reconcile?: boolean;
    /** D-13: the window's hourly liquidity samples of a chain (the week-so-far feed's, feed-v3.ts samplesOfFeedV1); null = none */
    samples?: ((chainId: number) => LiquiditySampleV3[] | null) | null;
  } = {},
): Promise<AssembledV3> {
  const warnings: string[] = [];
  const skipped: SkippedChainV3[] = [];
  if (prev && prev.epoch !== n - 1) throw new Error(`previous file is epoch ${prev.epoch}, expected ${n - 1}`);
  // A12 (P1): only the files before epoch n are its history; an unpublished epoch-n.json (or later) left by a run that
  // died between the write and the publication never makes its own burns look "already paid"
  files = historyFor(files, n);

  // 1. the Artifact snapshot and the window end (A8): a null block time re-reads at a fresh finalized slot
  let { snap, endTs } = await readSnapshotV3(s, log);

  // 2. the window start and F_ref come from epoch n−1's publication (F2, A2, A8)
  let startTs = endTs - WEEK;
  let open: string | null = null;
  let prevPublished: PublishedRecordV3 | null = null;
  if (prev) {
    const pub = await s.published(prev.epoch, prev.publish?.tx);
    if (!pub) throw new Error(`the EpochPublished record of epoch ${prev.epoch} could not be read: the window start and F_ref are unknown`);
    if (pub.publishedAt === null) throw new Error(`Epoch(${prev.epoch}).published_at could not be read`);
    startTs = pub.publishedAt;
    open = (BigInt(pub.freePoolBefore) - BigInt(pub.budget)).toString();
    prevPublished = pub;
  }
  // A12 (P8): the program refuses a publication before MIN_EPOCH_INTERVAL, so a run that is not due stops here,
  // before reading any chain or candle (a dry run still assembles everything)
  if (opts.stopIfNotDue && endTs - startTs < MIN_EPOCH_INTERVAL) {
    throw new NotDueV3(`window of ${endTs - startTs} s is shorter than ${MIN_EPOCH_INTERVAL} s (6 days): not due`);
  }

  // 3. the chains, each on its own: a failure skips the chain and carries its cursor
  const last = lastMissionIds(files);
  const inputsChains: ChainInputV3[] = [];
  const routes = new Map<number, XenRouteV3>();
  const depths = new Map<number, XenDepthV3>();
  const quotes = new Map<number, QuoteCheckV3>();
  const noMarket: number[] = [];
  const closesCache = new Map<string, Promise<string[] | null>>();
  const xenClosesAt = (c: ChainConfig, m: XenMarketV3, h: number) => {
    const k = `${c.chainId}:${h}`;
    if (!closesCache.has(k)) closesCache.set(k, s.xenCloses(c, m, h).catch(() => null));
    return closesCache.get(k)!;
  };
  // D-22 (b): the XNT candles come from the active price pool (epoch n−1's announced switch, else its pool)
  const xntActive = xntPoolActiveV3(prev?.version === 3 ? ((prev as { xntPool?: XntPoolV3 }).xntPool ?? null) : null);
  const xntClosesAt = (h: number) => {
    const k = `xnt:${h}`;
    if (!closesCache.has(k)) closesCache.set(k, s.xntCloses(h, xntActive).catch(() => null));
    return closesCache.get(k)!;
  };
  for (const c of chains) {
    if (!c.portal) continue;
    const pc = prevCursor(prev, c.chainId);
    const from = pc !== undefined ? pc : Math.max(0, c.startBlock - 1);
    try {
      const to = await s.finalHead(c);
      if (to <= from) throw new SkipChain(`no new final block (final head ${to}, cursor ${from})`);
      const read = await s.readChain(c, from, to);
      const before = read.totalMissionsBefore === null ? null : BigInt(read.totalMissionsBefore);
      let cont = missionContinuity(read.burns, last.get(c.chainId) ?? 0n, BigInt(read.totalMissions), before);
      if (cont.probe !== null && s.missionBefore) {
        const found = await s.missionBefore(c, cont.probe.toString(), from).catch(() => null);
        if (found !== null) cont = missionContinuity(read.burns, last.get(c.chainId) ?? 0n, BigInt(read.totalMissions), before, found);
      }
      if (cont.error) throw new SkipChain(cont.error);
      if (cont.warning) warnings.push(`${c.name}: ${cont.warning}`);
      // X-010 / X-022: the counters at toBlock are recorded (hashed) and must agree with the burns and continue the
      // previous record's; then a second provider must read the same counters (a lagging or lying RPC skips the chain)
      const missionsAt = read.totalMissions;
      const burnedAt = read.totalBurned ?? null;
      const pr = prev?.chains.find((x) => x.chainId === c.chainId) as { missionsAt?: unknown; burnedAt?: unknown } | undefined;
      const prevCounter = (v: unknown) => (typeof v === "string" ? BigInt(v) : null);
      const counterError = countersErrorV3(read.burns, BigInt(missionsAt), burnedAt === null ? null : BigInt(burnedAt), prevCounter(pr?.missionsAt), prevCounter(pr?.burnedAt));
      if (counterError) throw new SkipChain(`portal counters: ${counterError}`);
      if (opts.reconcile !== false && s.counters) {
        const second = await s.counters(c, to, read.rpc ?? null).catch(() => null);
        if (!second) warnings.push(`${c.name}: portal counters at block ${to} not confirmed by a second provider (none answered)`);
        else if (second.totalMissions !== missionsAt || (burnedAt !== null && second.totalBurned !== burnedAt)) {
          throw new SkipChain(`portal counters at block ${to}: ${read.rpc ?? "the logs' RPC"} reads ${missionsAt} missions / ${burnedAt ?? "?"} wei, ${second.rpc} reads ${second.totalMissions} / ${second.totalBurned} (a lagging or lying RPC)`);
        }
      }
      for (const b of read.burns) {
        if (!(b.blockNumber > from && b.blockNumber <= to)) throw new SkipChain(`burn ${b.txHash}:${b.logIndex} at block ${b.blockNumber} outside (${from}, ${to}]`);
        if (b.timestamp > endTs + HOUR) throw new SkipChain(`burn ${b.txHash}:${b.logIndex} is stamped ${b.timestamp - endTs} s after the window end: the chain's head or clock is wrong`);
      }
      // D-21: a market read that finds no eligible market is a skip for lack of a market (the chain's run of skips grows),
      // unless the previous record announced its orphaning for this epoch: its burns are then valued at the orphan price
      const prevRec = prev?.version === 3 ? (prev.chains.find((x) => x.chainId === c.chainId) as { orphan?: { from?: number } | null } | undefined) : undefined;
      const orphanNow = !!prevRec?.orphan && typeof prevRec.orphan.from === "number" && prevRec.orphan.from <= n;
      let market: XenMarketV3 | null;
      try {
        market = await s.market(c);
      } catch (e) {
        const noMkt = isNoMarketErrorV3(e);
        if (!(noMkt && orphanNow)) {
          if (noMkt && prev?.chains.some((x) => x.chainId === c.chainId)) noMarket.push(c.chainId);
          throw e;
        }
        market = null;
      }
      if (market === null) {
        const burns: BurnInputV3[] = [];
        for (const b of read.burns) {
          const xnt = candleReadings(await xntClosesAt(Math.floor(b.timestamp / HOUR) * HOUR));
          burns.push({ ...burnEvent(b), medianE18: "0", lastCloseE18: "0", priceSource: "orphan", xntMedianE18: xnt.medianE18, xntLastCloseE18: xnt.lastCloseE18, xntSource: xnt.source });
        }
        let supply: { totalSupply: string | null; totalSupplyError?: string };
        try {
          supply = { totalSupply: await s.totalSupply(c, to) };
        } catch (e) {
          supply = { totalSupply: null, totalSupplyError: reasonLineOf(`totalSupply at block ${to} could not be read: ${String((e as Error)?.message ?? e)}`) };
        }
        inputsChains.push({
          chainId: c.chainId, name: c.name, portal: c.portal, fromBlockExclusive: from, toBlock: to, orphan: true,
          market: { spotE18: "0", refUsdE18: "0", priceSource: "orphan: no eligible market (D-21)", pools: [] }, liquidityNowMicro: "0", ...supply, missionsAt, burnedAt, burns,
        });
        log(`  ${c.name}: ORPHANED (D-21): blocks ${from + 1}..${to}, ${burns.length} burns valued at half the reference recorded at its orphaning`);
        continue;
      }
      const m = market;
      // A5-c: GeckoTerminal's USD price of the price pool's quote token against Chainlink's at toBlock: more than 3% apart
      // skips the chain this epoch (its cursor kept); no feed or no fresh round: the check is not made, with a warning
      if (m.quote && m.quote.usd > 0) {
        const stated = BigInt(toE18(m.quote.usd));
        const cl = s.quoteUsd ? await s.quoteUsd(c, m, to).catch(() => null) : null;
        const diff = cl ? quoteUsdDiffBpsV3(stated, BigInt(cl.usdE18)) : null;
        quotes.set(c.chainId, { token: m.quote.address, statedE18: stated.toString(), chainlinkE18: cl?.usdE18 ?? null, feed: cl?.feed ?? null, diffBps: diff });
        if (diff !== null && diff > QUOTE_USD_MAX_DIFF_BPS) {
          throw new SkipChain(`quote USD mismatch (A5-c): GeckoTerminal prices the price pool's quote token ${m.quote.address} at $${m.quote.usd}, Chainlink ${cl!.pair} at $${Number(cl!.usdE18) / 1e18} (${diff / 100}% apart, more than ${QUOTE_USD_MAX_DIFF_BPS / 100}%)`);
        }
        if (s.quoteUsd && !cl) warnings.push(`${c.name}: the quote token's USD price was not checked against Chainlink (no listed feed or no fresh round, A5-c)`);
      }
      const burns: BurnInputV3[] = [];
      for (const b of read.burns) {
        const hourStart = Math.floor(b.timestamp / HOUR) * HOUR;
        // the week-so-far feed passes the closed-candle readings it already published (feed-v3.ts); the build never does
        const xen = opts.known?.xen(c.chainId, hourStart) ?? candleReadings(await xenClosesAt(c, m, hourStart));
        const xnt = opts.known?.xnt(hourStart) ?? candleReadings(await xntClosesAt(hourStart));
        burns.push({
          ...burnEvent(b),
          medianE18: xen.medianE18, lastCloseE18: xen.lastCloseE18, priceSource: xen.source,
          xntMedianE18: xnt.medianE18, xntLastCloseE18: xnt.lastCloseE18, xntSource: xnt.source,
        });
      }
      // T1-34: informative only, and a failed read is recorded as null with its reason, never as "0"
      let supply: { totalSupply: string | null; totalSupplyError?: string };
      try {
        supply = { totalSupply: await s.totalSupply(c, to) };
      } catch (e) {
        supply = { totalSupply: null, totalSupplyError: reasonLineOf(`totalSupply at block ${to} could not be read: ${String((e as Error)?.message ?? e)}`) };
        warnings.push(`${c.name}: ${supply.totalSupplyError}`);
      }
      // D-13: the on-chain depth at toBlock (min with GeckoTerminal's in the engine), the price pool's age, the window's
      // hourly samples; a depth read that fails is recorded as not read (the GeckoTerminal reading then stands alone)
      let depth: XenDepthV3 | null = null;
      if (s.depth) {
        try {
          depth = await s.depth(c, m, to);
        } catch (e) {
          warnings.push(`${c.name}: on-chain depth at block ${to} not read (${String((e as Error)?.message ?? e).slice(0, 160)}): GeckoTerminal's reading stands alone`);
        }
      }
      const samples = opts.samples ? opts.samples(c.chainId) : null;
      inputsChains.push({
        chainId: c.chainId, name: c.name, portal: c.portal, fromBlockExclusive: from, toBlock: to,
        market: marketV3(m), liquidityNowMicro: BigInt(Math.floor(m.liquidityUsd * 1e6)).toString(), ...supply, missionsAt, burnedAt, burns,
        ...(s.depth ? { liquidityOnChainMicro: depth?.micro ?? null } : {}),
        ...(m.poolCreatedAt !== undefined ? { poolCreatedAt: m.poolCreatedAt } : {}),
        ...(samples ? { liquiditySamples: samples.filter((x) => x.hour * HOUR >= startTs && x.hour * HOUR <= endTs) } : {}),
      });
      if (depth?.route) routes.set(c.chainId, depth.route);
      if (depth) depths.set(c.chainId, depth);
      log(`  ${c.name}: blocks ${from + 1}..${to}, ${burns.length} burns (missions up to ${read.totalMissions}), XEN spot $${m.spotUsd}, liquidity $${Math.round(m.liquidityUsd)}${depth?.micro ? ` (on-chain $${Math.round(Number(depth.micro) / 1e6)})` : ""}${samples ? `, ${samples.length} hourly samples` : ""}`);
    } catch (e) {
      const reason = e instanceof SkipChain ? e.message : `${String((e as Error)?.message ?? e).slice(0, 300)}`;
      skipped.push({ chainId: c.chainId, name: c.name, reason });
      log(`  ${c.name}: SKIPPED this epoch (cursor stays at ${from}): ${reason}`);
    }
  }

  // A12 (P4): a slow read of the chains and candles must not push the build past CLOCK_SKEW_MAX from the window end:
  // re-read the snapshot (a later endTs; every burn read is at or before the heads read above, so A8 still holds)
  if (snapshotTooOld(s.now(), endTs)) {
    const fresh = await readSnapshotV3(s, log);
    log(`  the chains took until ${s.now()}: snapshot re-read at slot ${fresh.snap.slot} (window end ${endTs} → ${fresh.endTs})`);
    ({ snap, endTs } = fresh);
  }

  // 4. the pool and the XNT build price (A13.1: a v3 epoch has no drop reserve, so no drop luck enters the build)
  const freePool = await s.freePool();
  const xnt = await s.xnt();
  const switchRefs: SwitchRefV3[] | null = prev?.version === 2 ? switchRefsFromV2(v2SwitchFiles(files, prev.epoch)) : null;
  // D-22 (a): the XDEX pool at this build caps the NEXT window's tranches; a failed read is recorded as none (the next
  // window then keeps this window's cap reserve)
  // D-22 (b): the candidate XNT/USD pools' TVL at this build (a failed read keeps their history unchanged)
  let xntPools: { pool: string; tvlMicro: string }[] | null = null;
  if (s.xntPools) {
    try {
      xntPools = await s.xntPools();
    } catch (e) {
      warnings.push(`the candidate XNT pools' TVL not read (${String((e as Error)?.message ?? e).slice(0, 160)}): their history is kept`);
    }
  }
  let xdex: XdexReadingV3 | null = null;
  if (s.xdex) {
    try {
      xdex = await s.xdex();
    } catch (e) {
      warnings.push(`XDEX pool not read (${String((e as Error)?.message ?? e).slice(0, 160)}): the next window keeps this window's tranche cap`);
    }
  }

  // D-23 (phase 1): the sidecar of this build: the closes every burn was priced from (with the raw candles and their URL
  // when the sources kept them), each chain's on-chain depth and route, the XDEX reading; hashed into the file
  let sidecar: PriceSidecarV3 | null = null;
  if (!opts.known) {
    const candles: PriceSidecarV3["candles"] = {};
    for (const key of sidecarKeysV3(inputsChains)) {
      const cached = closesCache.get(key);
      const raw = s.rawCandles ? s.rawCandles(key) : null;
      candles[key] = { closes: cached ? await cached : null, url: raw?.url ?? null, ohlcv: raw?.ohlcv ?? null };
    }
    const depth: PriceSidecarV3["depth"] = {};
    for (const [id, d] of [...depths.entries()].sort((a, b) => a[0] - b[0])) depth[String(id)] = { micro: d.micro, route: d.route };
    const quoteRec: PriceSidecarV3["quotes"] = {};
    for (const [id, q] of [...quotes.entries()].sort((a, b) => a[0] - b[0])) if (inputsChains.some((x) => x.chainId === id)) quoteRec[String(id)] = q;
    sidecar = { kind: "price-sidecar", version: 1, programId: PROGRAM_ID, epoch: n, candles: sortedObject(candles), depth, xdex, quotes: quoteRec };
  }
  const inputs: EpochInputsV3 = {
    programId: PROGRAM_ID,
    epoch: n,
    createdAt: s.now(),
    window: { startTs, endTs },
    chains: inputsChains,
    snapshot: snapshotInputOf(snap),
    freePool: { lamports: freePool.lamports, slot: freePool.slot, open },
    xnt,
    switchRefs,
    // T2-RULES: the rules block in force for epoch n (rules-v3.ts), recorded and hashed with the file
    rulesBlock: s.rulesBlock ? s.rulesBlock(n) : rulesForEpochV3(n, null),
    ...(s.xdex ? { xdex } : {}),
    ...(sidecar ? { sidecar: { file: sidecarFileV3(n), sha256: sidecarSha256V3(sidecar) } } : {}),
    ...(noMarket.length ? { noMarket: [...noMarket].sort((a, b) => a - b) } : {}),
    ...(xntPools ? { xntPools } : {}),
  };
  return { inputs, skipped, warnings, snapshotRead: snap, prevPublished, routes, sidecar };
}

// ── D-23 (phase 1): the price sidecar ────────────────────────────────────────────────────────────
/**
 * The raw price data of one build, written next to its file as epoch-<n>.prices.json and hashed into it (`sidecar`):
 * every candle request a burn was priced from (the closes used and, from the live sources, the raw ohlcv_list as the API
 * answered it, with its URL), each chain's on-chain depth and route inputs (the price pool's reserves at toBlock), and the
 * XDEX reading. `verify` re-derives every burn's readings from it offline (verifyPriceSidecarV3). GeckoTerminal is credited
 * on the site; republishing its candles is the accepted interim terms risk of D-23 until phase 2.
 */
export interface PriceSidecarV3 {
  kind: "price-sidecar";
  version: 1;
  programId: string;
  epoch: number;
  /** key "<chainId>:<hourStart>" (XEN on that chain's price pool) or "xnt:<hourStart>" (the XDEX pool, in USDC.X) */
  candles: Record<string, { closes: string[] | null; url: string | null; ohlcv: number[][] | null }>;
  /** per chain id: the on-chain XEN-side depth (µUSD, null: not read) and the price pool's route (null: not read) */
  depth: Record<string, { micro: string | null; route: XenRouteV3 | null }>;
  xdex: XdexReadingV3 | null;
  /** A5-c, per valued chain id: the quote token, GeckoTerminal's stated USD and Chainlink's (null: no check made) */
  quotes: Record<string, QuoteCheckV3>;
}

/** A5-c: one chain's quote-token check at the build. */
export interface QuoteCheckV3 {
  token: string;
  statedE18: string;
  chainlinkE18: string | null;
  feed: string | null;
  diffBps: number | null;
}

const sortedObject = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

/** sha256 of a sidecar's canonical JSON (sorted keys at every level), what the epoch file records. */
export function sidecarSha256V3(doc: PriceSidecarV3): string {
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
  return createHash("sha256").update(JSON.stringify(canon(doc))).digest("hex");
}

/** The candle keys a set of burns was priced from. */
export function sidecarKeysV3(chains: { chainId: number; orphan?: true; burns: { timestamp: number }[] }[]): string[] {
  const keys = new Set<string>();
  for (const c of chains) {
    for (const b of c.burns) {
      const h = Math.floor(b.timestamp / HOUR) * HOUR;
      // D-21: an orphaned chain's burns read no XEN candle (only the XNT ones)
      if (!c.orphan) keys.add(`${c.chainId}:${h}`);
      keys.add(`xnt:${h}`);
    }
  }
  return [...keys].sort();
}

/**
 * D-23: null when the sidecar `doc` is the one file `f` records and every burn's readings re-derive from it, else the
 * problems: the sha256, the epoch, each burn's XEN and XNT readings = candleReadings(the recorded closes), the closes =
 * closesFromOhlcvV3(the raw candles) when they are recorded, each chain's on-chain depth = L.onChain, the XDEX reading.
 */
export function verifyPriceSidecarV3(f: EpochFileV3, doc: PriceSidecarV3 | null): string[] {
  const out: string[] = [];
  if (!f.sidecar) return doc ? ["the file records no sidecar, but one was given"] : [];
  if (!doc) return [`the sidecar ${f.sidecar.file} is missing`];
  if (sidecarSha256V3(doc) !== f.sidecar.sha256) out.push(`${f.sidecar.file}: sha256 ${sidecarSha256V3(doc)} is not the file's ${f.sidecar.sha256}`);
  if (doc.kind !== "price-sidecar" || doc.version !== 1 || doc.epoch !== f.epoch || doc.programId !== f.programId) out.push(`${f.sidecar.file} is not epoch ${f.epoch}'s sidecar`);
  for (const b of f.burns) {
    const h = Math.floor(b.timestamp / HOUR) * HOUR;
    const checks = [[`${b.chainId}:${h}`, b.medianE18, b.lastCloseE18, b.priceSource, "XEN"], [`xnt:${h}`, b.xntMedianE18, b.xntLastCloseE18, b.xntSource, "XNT"]] as const;
    // D-21: an orphaned chain's burn reads no XEN candle (its price is the orphan rule's)
    for (const [key, m, l, s, what] of checks.filter((x) => !(x[4] === "XEN" && b.priceSource === "orphan"))) {
      const c = doc.candles[key];
      if (!c) {
        out.push(`burn ${b.chainId}:${b.txHash}:${b.logIndex}: no ${what} candles for hour ${h} in the sidecar`);
        continue;
      }
      const r = candleReadings(c.closes);
      if (r.medianE18 !== m || r.lastCloseE18 !== l || r.source !== s) out.push(`burn ${b.chainId}:${b.txHash}:${b.logIndex}: its ${what} readings are not the sidecar's closes`);
      if (c.ohlcv !== null && JSON.stringify(closesFromOhlcvV3(c.ohlcv, h)) !== JSON.stringify(c.closes)) out.push(`${key}: the recorded closes are not the raw candles' closes`);
    }
  }
  for (const ch of f.chains.filter((x) => !x.skipped)) {
    const d = doc.depth[String(ch.chainId)];
    if (d && d.micro !== ch.L.onChain) out.push(`chain ${ch.chainId}: the sidecar's on-chain depth ${d.micro} is not L.onChain ${ch.L.onChain}`);
  }
  if (JSON.stringify(doc.xdex) !== JSON.stringify(f.xdex.atBuild)) out.push("the sidecar's XDEX reading is not xdex.atBuild");
  // D-22 (b): the XNT candles were read from the file's active pool
  for (const [key, c] of Object.entries(doc.candles)) if (key.startsWith("xnt:") && c.url !== null && !c.url.includes(f.xntPool.active)) out.push(`${key}: read from another pool than xntPool.active ${f.xntPool.active}`);
  // A5-c: a valued chain whose quote token's USD was more than 3% off Chainlink's should have been skipped
  for (const [id, q] of Object.entries(doc.quotes ?? {})) {
    if (q.chainlinkE18 === null) continue;
    const d = quoteUsdDiffBpsV3(BigInt(q.statedE18), BigInt(q.chainlinkE18));
    if (d !== q.diffBps) out.push(`chain ${id}: the recorded quote difference ${q.diffBps} bps is not ${d}`);
    if (d > QUOTE_USD_MAX_DIFF_BPS && f.chains.some((c) => String(c.chainId) === id && !c.skipped)) out.push(`chain ${id} was valued with a quote USD ${d / 100}% off Chainlink's (A5-c: it is skipped)`);
  }
  return out;
}

// ── D-17: the anomaly gate's hold record ─────────────────────────────────────────────────────────
/**
 * The hold record of epoch n (EPOCHS_DIR/gate/epoch-<n>.json, public): when the gate first held it (X1 time), until when,
 * why, and the data hash of the build it held. Written by the run that holds; read by the next runs, the `due` check and
 * the week-so-far feed (flags.anomalyHold).
 */
export interface GateRecordV3 {
  kind: "anomaly-gate";
  epoch: number;
  heldAt: number;
  until: number;
  reasons: GateReasonV3[];
  dataHash: string;
  /** set by the run that publishes it: when and how it was let go */
  released?: { at: number; by: "timer" | "clear" | "heartbeat"; tx?: string };
  /**
   * r4-fix (review r4 finding 4): set when a rebuild after the first hold tripped a NEW kind of reason, which held it once
   * more (a second 24-h hold); a second new kind after it blocks the epoch for an operator (a fresh rebuild after a hold
   * runs out is released only when it trips nothing the hold has not already seen).
   */
  rehold?: number;
}

/**
 * D-17: what the run does with a built epoch, by the gate's reasons, the hold record and the X1 clock (pure):
 *  - no reason, no record: publish;
 *  - no reason, a record: publish (a rebuild that no longer trips the gate), the record is marked released "clear";
 *  - reasons, no record: hold (write the record: until = now + GATE_HOLD_SECONDS), publish nothing;
 *  - reasons, a record still running: wait (publish nothing; the `due` check stops dispatching until `until`);
 *  - reasons, a record that ran out: GATE_BLOCK set → blocked (nothing is published; an operator decides); else release:
 *    publish this fresh build (every run rebuilds) and mark the record released "timer", but ONLY when every reason code of
 *    the rebuild was already in the record (r4-fix, review r4 finding 4: tripping the gate on purpose at the first build
 *    must not buy an unchecked publication of whatever the second, predictable build reads). A rebuild with a new kind of
 *    reason holds again, once (record.rehold, a fresh 24-h hold with the union of the reasons); a further new kind after
 *    that blocks for an operator.
 *  - a heartbeat (`heartbeat`: the budget-0 base epoch, which pays nothing) is never held or blocked (review r4 finding 12:
 *    a forgotten GATE_BLOCK must not kill the oracle seat in a quiet month); a record of the same epoch is marked released
 *    "heartbeat".
 * An unknown clock fails closed (wait).
 */
export function gateDecisionV3(
  reasons: GateReasonV3[], record: GateRecordV3 | null, nowTs: number | null, block: boolean, epoch: number, dataHash: string, heartbeat = false,
): { action: "publish" | "hold" | "wait" | "blocked" | "release"; record: GateRecordV3 | null; reason: string } {
  if (record && record.epoch !== epoch) record = null;
  if (record?.released) record = null; // an earlier, already released hold of this epoch number never holds again
  if (heartbeat) {
    const why = reasons.length ? ` (it would have tripped: ${reasons.map((r) => r.code).join(", ")})` : "";
    if (!record) return { action: "publish", record: null, reason: `a heartbeat pays nothing: the anomaly gate never holds it${why}` };
    return { action: "publish", record: { ...record, released: { at: nowTs ?? record.until, by: "heartbeat" } }, reason: `a heartbeat pays nothing: the anomaly gate never holds it${why}` };
  }
  if (!reasons.length) {
    if (!record) return { action: "publish", record: null, reason: "" };
    return { action: "publish", record: { ...record, released: { at: nowTs ?? record.until, by: "clear" } }, reason: "the rebuild no longer trips the anomaly gate" };
  }
  const why = reasons.map((r) => r.text).join("; ");
  if (nowTs === null || !Number.isSafeInteger(nowTs)) return { action: "wait", record, reason: `the X1 clock could not be read, so the anomaly gate cannot time the hold (fail closed): ${why}` };
  if (!record) {
    return { action: "hold", record: { kind: "anomaly-gate", epoch, heldAt: nowTs, until: nowTs + GATE_HOLD_SECONDS, reasons, dataHash }, reason: `held by the anomaly gate until ${new Date((nowTs + GATE_HOLD_SECONDS) * 1000).toISOString()}: ${why}` };
  }
  if (nowTs < record.until) return { action: "wait", record, reason: `held by the anomaly gate until ${new Date(record.until * 1000).toISOString()}: ${why}` };
  if (block) return { action: "blocked", record, reason: `the anomaly gate's hold ran out, but GATE_BLOCK is set: nothing is published until it is cleared: ${why}` };
  const seen = new Set(record.reasons.map((r) => r.code));
  const fresh = [...new Set(reasons.map((r) => r.code).filter((c) => !seen.has(c)))];
  if (fresh.length) {
    if ((record.rehold ?? 0) >= 1) return { action: "blocked", record, reason: `the rebuild after the anomaly gate's second hold trips a new kind of reason (${fresh.join(", ")}): nothing is published until an operator decides (to accept them, add those reasons to gate/epoch-${epoch}.json and commit it: the next run then releases the rebuild): ${why}` };
    const union = [...record.reasons, ...reasons.filter((r) => fresh.includes(r.code))];
    return { action: "hold", record: { ...record, until: nowTs + GATE_HOLD_SECONDS, reasons: union, rehold: (record.rehold ?? 0) + 1 }, reason: `held again by the anomaly gate until ${new Date((nowTs + GATE_HOLD_SECONDS) * 1000).toISOString()}: the rebuild trips a new kind of reason (${fresh.join(", ")}): ${why}` };
  }
  return { action: "release", record: { ...record, released: { at: nowTs, by: "timer" } }, reason: `the anomaly gate's 24-h hold ran out: published with a fresh rebuild that trips nothing the hold had not seen (${why})` };
}

/** A gate record read from disk, or null when it is not one (the run then treats the epoch as not held). */
export function gateRecordOf(v: unknown): GateRecordV3 | null {
  const r = v as Partial<GateRecordV3> | null;
  if (!r || r.kind !== "anomaly-gate" || !Number.isSafeInteger(r.epoch) || !Number.isSafeInteger(r.heldAt) || !Number.isSafeInteger(r.until) || !Array.isArray(r.reasons) || typeof r.dataHash !== "string") return null;
  return r as GateRecordV3;
}

/** Whether a gate record still holds epoch n at X1 time `nowTs` (the `due` check and the feed's flags.anomalyHold). */
export function gateHoldsV3(record: GateRecordV3 | null, epoch: number, nowTs: number): boolean {
  return !!record && record.epoch === epoch && !record.released && nowTs < record.until;
}

/** The ≥ 6 days rule: the program refuses an earlier publication, so the oracle does not build one. */
export function publishDecisionV3(window: { startTs: number; endTs: number }): { ok: boolean; reason: string } {
  const len = window.endTs - window.startTs;
  if (len < MIN_EPOCH_INTERVAL) return { ok: false, reason: `window of ${len} s is shorter than ${MIN_EPOCH_INTERVAL} s (6 days): not due` };
  return { ok: true, reason: "" };
}

/**
 * The v3 file from the inputs: chains with an unpriced burn are skipped (A7.7); null when nothing would be paid.
 * `opts.provisional` (A13.4, dry runs only) builds a too-short window as a labelled, never-publishable preview.
 * `opts.heartbeat` (round 4, the weekly run on the upgraded binary only) builds the heartbeat base epoch of a window that
 * valued no burn instead of null (ComputeOptsV3.heartbeat).
 */
export function buildV3(inputs: EpochInputsV3, prev: AnyEpochFile | null, opts: ComputeOptsV3 = {}): { file: EpochFileV3 | null; unpriced: number[] } {
  const { body, skipped } = computeEpochV3SkippingUnpriced(inputs, prev, opts);
  if (!body) return { file: null, unpriced: skipped };
  return { file: { ...body, dataHash: dataHashV3(body), proofs: proofsOfV3(body) }, unpriced: skipped };
}

/**
 * Round 4 (quiet-month seat liveness), pure: whether this run may send the heartbeat built for a window that valued no
 * burn. Only on the upgraded binary (the live v2 binary refuses the shape with EmptyEpoch, and the W2-4 rule keeps the v2
 * path exactly as on main), never for a provisional preview, and only once the window is publishable (≥ 6 days).
 */
export function heartbeatAllowedV3(o: { verdict: "upgraded" | "legacy" | "unknown"; provisional: string | null; due: boolean }): { ok: boolean; reason: string } {
  if (o.provisional !== null) return { ok: false, reason: "a provisional preview is never a heartbeat" };
  if (!o.due) return { ok: false, reason: "the window is not publishable yet" };
  if (o.verdict !== "upgraded") return { ok: false, reason: `the live program is not the upgraded binary (${o.verdict}): no heartbeat (the v2 binary refuses an empty epoch)` };
  return { ok: true, reason: "a week without a valued burn: the heartbeat base epoch keeps the oracle seat alive" };
}

// ── publication record ─────────────────────────────────────────────────────────────────────────
/** What a v3 file records about its publication; `{tx}` alone when the post-publish reads failed. */
export interface PublishV3 {
  tx: string;
  slot?: number;
  /** Epoch.budget (net of the drop reserve), as v2 recorded it */
  budget?: string;
  fullBudget?: string;
  dropReserve?: string;
  dropSlot?: string;
  freePoolBefore?: string;
  publishedAt?: number;
  blockTime?: number | null;
  /**
   * the claims the oracle sent: with a keeper tip, and dust (no tip, the burner is still paid). Right after the
   * publication this is the plan; once claimLeavesV3 ran it is what happened (A12, P11): claimed, failed, and the plan
   */
  claims?: { tipped: number; dust: number; claimed?: number; failed?: number; planned?: { tipped: number; dust: number }; heldUntil?: number };
}

/** A12 (P11): the announcement's claim line from what the claims did (publish.claims after claimLeavesV3), never the plan. */
export function claimsLineV3(publish: { claims?: { claimed?: number; failed?: number; heldUntil?: number } } | undefined, leaves: number): string {
  const c = publish?.claims;
  // the upgraded program holds every claim for 48 h (theft §6.1): the publish run claims nothing, the keeper claims after
  if (c && c.claimed === undefined && typeof c.heldUntil === "number") {
    return `• Claims open ${new Date(c.heldUntil * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC, after the 48-h verification hold; then the keeper claims every leaf for its burner. Root and data hash on-chain, anyone can recompute the file`;
  }
  if (!c || c.claimed === undefined) return `• Claims for every burner are being sent; root and data hash on-chain, anyone can recompute the file`;
  if ((c.failed ?? 0) === 0 && c.claimed >= leaves) return `• Every leaf claimed for its burner; root and data hash on-chain, anyone can recompute the file`;
  return `• ${c.claimed} of ${leaves} leaves claimed for their burners so far (${c.failed ?? 0} failed, the keeper retries them); root and data hash on-chain`;
}

/**
 * A12 (RE-5): the daily release that was applied (capacity.tranche), in lamports. A13.2: a shortfall never cuts the
 * schedule, so it is ⌊cash/7⌋; a body without `tranche` (an A12 draft) falls back to its cut capacity `shortfall.to`.
 */
export function dailyReleaseV3(capacity: { cash: string; tranche?: string; shortfall?: object | null }): number {
  if (capacity.tranche !== undefined) return Number(BigInt(capacity.tranche));
  const to = (capacity.shortfall as { to?: unknown } | null | undefined)?.to;
  return Number(BigInt(typeof to === "string" ? to : capacity.cash) / 7n);
}

/** A12 (P3): the files the keeper works on: published ones, and any the program has published (publish record lost). */
export function keeperFilesV3<T extends { epoch: number; publish?: unknown }>(files: readonly T[], onChainLast: number): T[] {
  return files.filter((f) => !!f.publish || f.epoch <= onChainLast);
}

export function publishRecordV3(tx: string, read: PublishedRecordV3 | null, claims?: { tipped: number; dust: number }): PublishV3 {
  if (!read) return claims ? { tx, claims } : { tx };
  const net = read.netBudget ?? (BigInt(read.budget) - BigInt(read.dropReserve)).toString();
  return {
    tx, slot: read.slot, budget: net, fullBudget: read.budget, dropReserve: read.dropReserve, dropSlot: read.dropSlot, freePoolBefore: read.freePoolBefore,
    ...(read.publishedAt === null ? {} : { publishedAt: read.publishedAt }), blockTime: read.blockTime, ...(claims ? { claims } : {}),
  };
}

/** The verify rules' view of a publication record. */
export function toPublishedEpochV3(r: PublishedRecordV3): PublishedEpochV3 {
  return {
    epoch: r.epoch, root: r.root, dataHash: r.dataHash, leaves: r.leaves, budget: BigInt(r.budget), dropReserve: BigInt(r.dropReserve), totalScore: BigInt(r.totalScore),
    freePoolBefore: BigInt(r.freePoolBefore),
    ...(r.rateCap === null ? {} : { rateCap: BigInt(r.rateCap) }),
    ...(r.netBudget === null ? {} : { netBudget: BigInt(r.netBudget) }),
    ...(r.publishedAt === null ? {} : { publishedAt: r.publishedAt }),
  };
}

/**
 * The leaves whose on-chain claim pays a keeper tip, and the dust leaves (claimed all the same, no tip), by the rule of
 * the binary the file is published on (keeperTipDue): a v3 file (the default) on the upgraded program, where a claim
 * earns the tip from 0.2 XNT and never when the oracle submits it; a v2 file on the live one (0.02 XNT). The plan is
 * the keeper's view after the 48-h hold: `payer` / `oracle` say who will submit the claims (null = a third-party
 * keeper, the default); with payer = oracle every leaf is "dust" (the oracle earns no tip on the upgraded program).
 */
export function claimPlanV3(f: { leaves: Leaf[]; totalScore: string; version?: unknown }, who: { payer?: string | null; oracle?: string | null } = {}): { tipped: Leaf[]; dust: Leaf[] } {
  const ts = BigInt(f.totalScore);
  const { claims } = programClaims(f.leaves.map((l) => BigInt(l.score)), ts, ts * 10n);
  const version = f.version === undefined ? 3 : Number(f.version);
  const tipped: Leaf[] = [];
  const dust: Leaf[] = [];
  f.leaves.forEach((l, i) => (keeperTipDue({ version, payer: who.payer ?? null, player: l.player, oracle: who.oracle ?? null, claim: claims[i] }) ? tipped : dust).push(l));
  return { tipped, dust };
}

/**
 * Whether the keeper may seal an epoch's pending drop seed. A13.1: a v3 epoch has no drop reserve (the upgraded program
 * writes drop_reserve = 0 and drop_state = DROP_NONE), so the keeper never seals one: a pending seed on a v3 epoch can
 * only come from a binary that was not upgraded, and it is left to expire and then cancelled, which releases the reserve
 * (gatedSealActionV3). A v2 file, or no file, says nothing, so the keeper keeps sealing the legacy epochs as today.
 */
export function sealAllowedV3(files: readonly { epoch: number; version?: unknown }[], epochId: number): boolean {
  const f = files.find((x) => x.epoch === epochId);
  return !(f && f.version === 3);
}

/** Runs `fn` up to `tries` times with a pause between attempts; returns null when every attempt failed. */
// ── A12 (P2): a drop seed the gate left unsealed is cancelled once the SlotHashes window has passed ─────
/** SlotHashes keeps the last 512 slot hashes; past that seal_drop takes its Expired branch (drops.rs) */
export const SLOT_HASHES_DEPTH = 512;
/** extra slots before the cancelling seal_drop is sent, so the program surely sees the seed's slot as expired */
export const SLOT_HASHES_MARGIN = 16;
/** a conservative X1 slot time for scheduling only (X1 runs at ~0.4 s) */
export const X1_SLOT_SECONDS = 0.5;

/**
 * What the keeper does with an epoch whose drop seed is pending (drop_state 1): seal it when allowed (every legacy v2
 * epoch; never a v3 epoch, which has no drop reserve, A13.1); otherwise wait until the SlotHashes window has passed and then send seal_drop
 * anyway, which cancels the seed and releases the drop reserve at once (DropSealed{cancelled: true}) instead of holding
 * it 90 days and keeping the keeper busy every pass (P2).
 */
export function gatedSealActionV3(o: { dropState: number; sealAllowed: boolean; dropSlot: number; currentSlot: number }): "none" | "seal" | "wait" | "cancel" {
  if (o.dropState !== 1) return "none";
  if (o.sealAllowed) return "seal";
  return o.currentSlot > o.dropSlot + SLOT_HASHES_DEPTH + SLOT_HASHES_MARGIN ? "cancel" : "wait";
}

/** When the keeper has to come back for such an epoch: now for a seal or a cancel, the estimated expiry for a wait. */
export function gatedSealDueAt(o: { dropState: number; sealAllowed: boolean; dropSlot: number; currentSlot: number }, now: number): number | null {
  const a = gatedSealActionV3(o);
  if (a === "none") return null;
  if (a === "wait") return now + Math.ceil((o.dropSlot + SLOT_HASHES_DEPTH + SLOT_HASHES_MARGIN + 1 - o.currentSlot) * X1_SLOT_SECONDS);
  return now;
}

// ── A12 (P1): local files that are not part of the published history ─────────────────────────────
/** The epochs of local files above the last published epoch: never published (a run died between write and publish). */
export function staleEpochs(files: readonly { epoch: number }[], onChainLast: number): number[] {
  return files.filter((f) => f.epoch > onChainLast).map((f) => f.epoch).sort((a, b) => a - b);
}

/** The local history epoch n is built on: the files of epochs before n only (a stale epoch-n.json never counts). */
export function historyFor<T extends { epoch: number }>(files: readonly T[], n: number): T[] {
  return files.filter((f) => f.epoch < n);
}

// ── A12 (P4): a slow assemble re-reads the snapshot before the build ───────────────────────────────
/** the margin kept under CLOCK_SKEW_MAX before a build: past it the snapshot is re-read so createdAt stays near endTs */
export const SNAPSHOT_REFRESH_MARGIN = 10 * 60;
export function snapshotTooOld(nowIso: string, endTs: number): boolean {
  return Math.floor(Date.parse(nowIso) / 1000) - endTs > CLOCK_SKEW_MAX - SNAPSHOT_REFRESH_MARGIN;
}

/**
 * The snapshot and its window end (A8): a null block time re-reads at a fresh finalized slot, three tries.
 * A13.9 (review R2): the base pot never reads the Artifact records, so the base run never waits on them either:
 *  - a read that throws (a getProgramAccounts timeout, a getMultipleAccountsInfo error, the two X1 RPCs disagreeing,
 *    X-015) is retried like a null block time, three tries in all;
 *  - when every try failed, the window is anchored alone (`anchor`: a finalized slot and its block time, three tries)
 *    and the snapshot is recorded with no record and `unavailable: {reason}`;
 *  - a read whose records the engine would refuse (snapshotRecordsError) is recorded the same way at its own slot.
 * The base is then built as usual (nothing in it reads the records) and that week's extra file is a skip heartbeat.
 * Only a window that cannot be anchored at all stops the run (A8).
 */
export async function readSnapshotV3(s: SourcesV3, log: (m: string) => void = () => {}, tries = 3): Promise<{ snap: SnapshotReadV3; endTs: number }> {
  let failure: string | null = null;
  for (let i = 0; i < tries; i++) {
    let r: SnapshotReadV3;
    try {
      r = await s.snapshot();
    } catch (e) {
      failure = String((e as Error)?.message ?? e);
      log(`  the Artifact snapshot read failed (${i + 1}/${tries}): ${failure.slice(0, 200)}`);
      continue;
    }
    let endTs: number;
    try {
      endTs = snapshotWindowEnd(r.slot, r.blockTime);
    } catch (e) {
      log(`  snapshot at slot ${r.slot}: ${String((e as Error).message)}; re-reading`);
      continue;
    }
    const refused = snapshotRecordsError(r.records);
    if (refused !== null) {
      const reason = reasonLineOf(`an Artifact record is refused: ${refused}`);
      log(`  snapshot at slot ${r.slot}: ${reason}; the base is built without the records and this week's extra is a skip (A13.9)`);
      return { snap: { slot: r.slot, blockTime: r.blockTime, records: [], unavailable: { reason } }, endTs };
    }
    return { snap: r, endTs };
  }
  if (failure !== null && s.anchor) {
    const reason = reasonLineOf(`the Artifact records could not be read (${tries} tries): ${failure}`);
    for (let i = 0; i < tries; i++) {
      try {
        const a = await s.anchor();
        const endTs = snapshotWindowEnd(a.slot, a.blockTime);
        log(`  window anchored alone at slot ${a.slot}: ${reason.slice(0, 200)}; the base is built without the records and this week's extra is a skip (A13.9)`);
        return { snap: { slot: a.slot, blockTime: a.blockTime, records: [], unavailable: { reason } }, endTs };
      } catch (e) {
        log(`  window anchor (${i + 1}/${tries}): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      }
    }
  }
  if (failure !== null) {
    throw new Error(`the Artifact snapshot could not be read (${failure.slice(0, 300)}) and no finalized slot with a block time could anchor the window alone: the window end cannot be anchored (A8, A13.9)`);
  }
  throw new Error("no finalized slot with a block time after three reads: the window end cannot be anchored (A8)");
}

/** The inputs with a fresh snapshot (window end and records) when the build would otherwise be too far from it (P4). */
export async function refreshSnapshotIfOldV3(inputs: EpochInputsV3, read: SnapshotReadV3, s: SourcesV3, log: (m: string) => void = () => {}, force = false): Promise<{ inputs: EpochInputsV3; snapshotRead: SnapshotReadV3; refreshed: boolean }> {
  if (!force && !snapshotTooOld(s.now(), inputs.window.endTs)) return { inputs, snapshotRead: read, refreshed: false };
  const { snap, endTs } = await readSnapshotV3(s, log);
  log(`  snapshot re-read at slot ${snap.slot} (window end ${inputs.window.endTs} → ${endTs}): the build stays within CLOCK_SKEW_MAX of it`);
  return {
    inputs: { ...inputs, createdAt: s.now(), window: { ...inputs.window, endTs }, snapshot: snapshotInputOf(snap) },
    snapshotRead: snap,
    refreshed: true,
  };
}

/** The engine's snapshot input from a read: the records without forgedAt, and the A13.9 `unavailable` member when set. */
export const snapshotInputOf = (snap: SnapshotReadV3): EpochInputsV3["snapshot"] => ({
  slot: snap.slot,
  records: snap.records.map((r) => ({ asset: r.asset, tier: r.tier, owner: r.owner, backing: r.backing, origin: r.origin })),
  ...(snap.unavailable ? { unavailable: { reason: snap.unavailable.reason } } : {}),
});

// ── A12 (P8): the due rule before any chain is read ────────────────────────────────────────────────
export class NotDueV3 extends Error {}

// ── A13.5 (N5): the publish gate fails closed on an unknown clock ──────────────────────────────────
/**
 * The X1 block time of the slot the free pool was read at, with retries (a transient RPC error, or a node that has no
 * block time for that slot yet); null when every try failed or the sources cannot tell time.
 */
export async function readPublishClockV3(s: Pick<SourcesV3, "blockTime">, slot: number, tries = 3, pauseMs = 2_000, log: (m: string) => void = () => {}): Promise<number | null> {
  if (!s.blockTime) return null;
  return withRetries(
    async () => {
      const t = await s.blockTime!(slot);
      if (t === null || t === undefined) throw new Error(`no block time for slot ${slot}`);
      // A13.11 (review R5): a reading that is not a block time is a failed try, never a clock
      if (!isBlockTime(t)) throw new Error(`block time of slot ${slot}: ${JSON.stringify(t)} is not a safe non-negative integer`);
      return t;
    },
    tries, pauseMs, log,
  );
}

/**
 * What the run does with a written build just before publish_epoch: publish it, rebuild it (pool drift, a snapshot
 * older than MAX_PUBLISH_LAG; at most 3 times) or REFUSE: an unknown X1 clock (nowTs null) can never be fixed by a
 * rebuild and never lets a build through, so nothing is published and the run says why (A13.5).
 */
export function publishGateV3(f: EpochFileV3, freePoolNow: bigint, nowTs: number | null, slot?: number): { action: "publish" | "rebuild" | "refuse"; reason: string } {
  // A13.11 (review R5): a value that is not a block time (NaN, a fraction, a string) is an unknown clock as well
  if (nowTs === null || !isBlockTime(nowTs)) {
    return {
      action: "refuse",
      reason: `${CLOCK_UNKNOWN}${slot === undefined ? "" : ` (slot ${slot})`}: the snapshot's age cannot be checked against MAX_PUBLISH_LAG, so epoch ${f.epoch} is NOT published (A13.5). The written file is moved out by the next run (P1); re-run once the X1 RPC answers getBlockTime`,
    };
  }
  const reason = rebuildReason(f, freePoolNow, nowTs);
  return reason ? { action: "rebuild", reason } : { action: "publish", reason: "" };
}

// ── A12 (P7, P11): what the run reports after a publication ────────────────────────────────────────
/** The post-publish problems are soft: the epoch is on-chain and written, so the run reports them and still succeeds. */
export function postPublishReport(problems: string[]): { exitCode: number; annotations: string[] } {
  return { exitCode: 0, annotations: problems.map((p) => `::error title=post-publish::${p.replace(/\r?\n/g, " ")}`) };
}

/** RPC hosts known (live probe 2026-10-22) to refuse historical state or ranges beyond ~128 blocks: tried last in v3 (P5). */
export const NO_HISTORY_HOSTS = /(^|\.)publicnode\.com$|(^|\.)blxrbdn\.com$/;
export function rpcOrderV3(rpcs: readonly string[]): string[] {
  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };
  return [...rpcs.filter((r) => !NO_HISTORY_HOSTS.test(host(r))), ...rpcs.filter((r) => NO_HISTORY_HOSTS.test(host(r)))];
}

export async function withRetries<T>(fn: () => Promise<T>, tries: number, pauseMs: number, log: (m: string) => void = () => {}): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      log(`  attempt ${i + 1}/${tries} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      if (i + 1 < tries && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
  return null;
}

// ── the extra epoch, right after the base epoch (A10.11) ───────────────────────────────────────
/**
 * The extra snapshot S(n) from the base snapshot read: the same finalized slot (its block time is the window end, so it
 * is the first slot the oracle read with block time ≥ endTs), each record with its forged_at and last Core signature.
 */
export function extraSnapshotFromBase(base: EpochFileV3, read: SnapshotReadV3, signatures: Record<string, string>): ExtraSnapshot {
  if (read.slot !== base.snapshot.slot) throw new Error(`extra snapshot slot ${read.slot} is not the base snapshot slot ${base.snapshot.slot}`);
  return {
    slot: read.slot,
    blockTime: base.window.endTs,
    records: read.records.map((r) => {
      const signature = signatures[r.asset];
      if (!signature) throw new Error(`no Core signature for asset ${r.asset} at or before slot ${read.slot}`);
      return { asset: r.asset, tier: r.tier, owner: r.owner, backing: r.backing, origin: r.origin, forgedAt: r.forgedAt, signature };
    }),
  };
}

/**
 * Builds extra file n right after base file n: the previous extra file when it exists (null for the first extra
 * epoch), the pot reading ("0" until the program upgrade creates the extra pot, so every extra epoch before it is a
 * heartbeat with budget 0) and the build instant.
 */
export function buildExtraAfterBaseV3(base: EpochFileV3, prevExtra: ExtraFileV1 | null, read: SnapshotReadV3, signatures: Record<string, string>, pool: { open: string; lamports: string; slot: number; init?: ExtraInitMark | null }, createdAt: string): ExtraFileV1 {
  const p = { open: pool.open, lamports: pool.lamports, slot: pool.slot, createdAt, init: pool.init ?? null };
  // A13.9 (review R2): a base built without its Artifact records has one extra file, the skip heartbeat, whose reason is
  // a function of the base file (so the catch-up and rebuild-extra rebuild it byte for byte)
  if (baseSnapshotUnavailable(base) !== null) return buildSkipExtraFile(base, prevExtra, baseSnapshotSkipReason(base), p);
  const snapshot = extraSnapshotFromBase(base, read, signatures);
  return buildExtraFile(base, prevExtra, snapshot, p);
}

// ── A13.7: a lost extra file is rebuilt byte for byte ─────────────────────────────────────────────
/**
 * The extra file's build instant: the base file's createdAt (the runner's clock within CLOCK_SKEW_MAX of endTs), or the
 * window end when that clock was behind it (the extra needs createdAt ≥ endTs). A function of the base file, so a lost
 * extra file is rebuilt with the same instant and the same data hash.
 */
export function extraCreatedAtV3(base: EpochFileV3): string {
  return isoSeconds(base.createdAt, "base createdAt") >= base.window.endTs ? base.createdAt : new Date(base.window.endTs * 1000).toISOString();
}

/**
 * The pot reading that enters the extra body: X for `open` AND `lamports` (X = ExtraEpochPublished(n−1).free_after after
 * the upgrade, "0" before it), at the base file's pool slot. Nothing read at build time enters the body, so it is a pure
 * function of durable inputs; the program checks the live free balance itself at publication (free ≥ X, A10.2, A4).
 */
export function extraPoolV3(base: EpochFileV3, open: string, init: ExtraInitMark | null = null): { open: string; lamports: string; slot: number; init: ExtraInitMark | null } {
  return { open, lamports: open, slot: base.freePool.slot, init };
}

/**
 * The extra pot as one run sees it (DETECTION RULE, A11-a): `live` from the W2-4 probe; `liveFrom`, once live, the
 * chain's first extra epoch (extraFirstEpochOnChainV3: Config.last_epoch at init_extra + 1). An extra epoch before
 * `liveFrom` was built before the pot existed (a heartbeat: X 0, no init_extra mark) and is rebuilt that way; from
 * `liveFrom` on, X and the mark come from the chain. Without `liveFrom` (undefined) the whole history follows `live`.
 */
export interface ExtraPotLivenessV3 {
  live: boolean;
  liveFrom?: number | null;
}

/** whether the extra pot existed for extra epoch n (see ExtraPotLivenessV3) */
export function potLiveForV3(n: number, pot: ExtraPotLivenessV3): boolean {
  if (pot.liveFrom === undefined) return pot.live;
  return pot.live && pot.liveFrom !== null && n >= pot.liveFrom;
}

/** whether extra epoch n is the pot's first publishable one: X from init_extra, the mark read from the chain */
function firstLiveV3(n: number, prev: ExtraFileV1 | null, pot: ExtraPotLivenessV3): boolean {
  return !prev || (pot.liveFrom !== undefined && pot.liveFrom !== null && n === pot.liveFrom);
}

/**
 * OD-9: the init_extra mark (`pool.init`) of extra file n, by what the chain holds:
 *  - pot not live (detection "legacy"): null, every FORGED Artifact is pre-upgrade (and the file a heartbeat, X6);
 *  - live, the previous extra file carries a mark: that one, unchanged (the pot is created once); a chain read that
 *    disagrees with it throws;
 *  - live, no mark yet (the first extra epoch on the live pot): the one read from the chain (readExtraInitV3, x1-v3.ts),
 *    passed as `read`; without it this throws (the boundary is never assumed).
 */
export function extraInitV3(n: number, prev: ExtraFileV1 | null, pot: ExtraPotLivenessV3 & { init?: ExtraInitMark | null }): ExtraInitMark | null {
  if (!potLiveForV3(n, pot)) return null;
  const was = prev?.pool?.init ?? null;
  const read = pot.init ?? null;
  if (was) {
    if (read && (read.ts !== was.ts || read.tx !== was.tx)) throw new Error(`the chain's init_extra (${read.tx} @ ${read.ts}) differs from extra-${prev!.epoch}.json's (${was.tx} @ ${was.ts}): refusing extra-${n}.json (OD-9)`);
    return was;
  }
  if (!read) throw new Error(`extra-${n}.json needs the init_extra mark (OD-9: the pre-upgrade boundary): it was not read from the chain (readExtraInitV3), nothing is built`);
  return read;
}

/**
 * A11-a: X (`pool.open`) of extra file n, by what the chain holds:
 *  - pot not live (the live v2 binary, detection "legacy"): "0", every extra file is a budget-0 heartbeat (X6);
 *  - live, n−1 in the history: ExtraEpochPublished(n−1).free_after, which must be published (the program takes extra
 *    epochs in order, so extra n is built only after n−1 is on-chain);
 *  - live, the first extra epoch: the free extra pot at init_extra, read by the caller (initExtraXV3, x1-v3.ts) and
 *    passed as `firstX`; without it this throws (X is never assumed, A13.8).
 */
export async function extraOpenV3(n: number, prev: ExtraFileV1 | null, pot: ExtraPotLivenessV3 & { firstX: string | null }, src: Pick<ExtraRecoverySourcesV3, "publishedExtra">): Promise<string> {
  if (!potLiveForV3(n, pot)) return "0";
  if (prev && !firstLiveV3(n, prev, pot)) {
    const pe = await src.publishedExtra(prev.epoch);
    if (!pe) throw new Error(`ExtraEpochPublished(${prev.epoch}) could not be read: X (its free_after) is unknown, extra-${n}.json cannot be built until extra epoch ${prev.epoch} is published (npm run publish-extra)`);
    if (!/^(0|[1-9][0-9]*)$/.test(pe.freeAfter)) throw new Error(`ExtraEpochPublished(${prev.epoch}).free_after ${pe.freeAfter} is not an amount`);
    return pe.freeAfter;
  }
  if (pot.firstX === null) throw new Error(`the first extra epoch after the upgrade reads X from init_extra: X was not read (initExtraXV3), extra-${n}.json is not built (A11-a, A13.8)`);
  if (!/^(0|[1-9][0-9]*)$/.test(pot.firstX)) throw new Error(`X of the first extra epoch ${pot.firstX} is not an amount`);
  return pot.firstX;
}

/**
 * A10.11 durability (X-011, X-017): extra-<n>.json is published on-chain only once that exact file is durable, i.e. in
 * the repository's PUSHED history (the copy every verifier and the site read), so a lost runner can never leave an
 * on-chain extra epoch without its file. `remote` is the file's text at the pushed ref (null: not there). Pure; the
 * publish-extra command reads it with git. Any doubt refuses.
 */
export function durableExtraErrorV3(local: ExtraFileV1, remote: string | null, ref: string): string | null {
  if (remote === null) return `extra-${local.epoch}.json is not in ${ref}: commit and push it first (A10.11: the file is durable before publish_extra_epoch)`;
  let r: ExtraFileV1;
  try {
    r = JSON.parse(remote);
  } catch {
    return `extra-${local.epoch}.json at ${ref} is not JSON`;
  }
  if (!r || typeof r !== "object" || r.dataHash !== local.dataHash) return `extra-${local.epoch}.json at ${ref} has data hash ${String(r?.dataHash)}, the local file ${local.dataHash}: push the file being published`;
  if (dataHashExtra(r) !== r.dataHash) return `extra-${local.epoch}.json at ${ref} does not match its own data hash`;
  return null;
}

/**
 * What publish-extra checks before sending extra file f (pure; the chain reads are passed in). `pot` is the run's pot
 * (extraPotRunV3), `prevPublished` ExtraEpochPublished(n−1) (null when n is the chain's first extra epoch or it was
 * never published). Returns the reasons to refuse (empty = send).
 */
export function publishExtraRefusalsV3(f: ExtraFileV1, pot: { live: boolean; liveFrom: number | null; firstX: string | null; init: ExtraInitMark | null }, prevPublished: { freeAfter: string } | null): string[] {
  const out: string[] = [];
  if (!pot.live || pot.liveFrom === null) return [`the extra pot is not live (the program is not upgraded): extra-${f.epoch}.json stays a local heartbeat`];
  if (f.epoch < pot.liveFrom) return [`extra epoch ${f.epoch} is before the chain's first extra epoch ${pot.liveFrom}: built before the pot existed, never published`];
  const init = f.pool.init ?? null;
  if (!init || !pot.init || init.tx !== pot.init.tx || init.ts !== pot.init.ts) out.push(`pool.init of extra-${f.epoch}.json is not the chain's init_extra (OD-9)`);
  if (f.epoch === pot.liveFrom) {
    if (f.pool.open !== pot.firstX) out.push(`pool.open ${f.pool.open} is not X at init_extra (${String(pot.firstX)})`);
  } else if (!prevPublished) out.push(`extra epoch ${f.epoch - 1} is not published: extra epochs are published in order (publish it first)`);
  else if (prevPublished.freeAfter !== f.pool.open) out.push(`pool.open ${f.pool.open} != ExtraEpochPublished(${f.epoch - 1}).free_after ${prevPublished.freeAfter}`);
  return out;
}

/** What a rebuild of extra file n reads from X1 now (every answer is about the past: immutable or finalized history). */
export interface ExtraRecoverySourcesV3 {
  /** ArtifactRecord.forged_at of each asset whose record still exists (immutable); a recycled asset is absent */
  forgedAt(assets: string[]): Promise<Record<string, number>>;
  /** the last successful transaction of each asset at or before `slot` (paged back as far as needed) */
  assetSignatures(assets: string[], slot: number): Promise<Record<string, string>>;
  /** ExtraEpochPublished(epoch) once the program records extra epochs; null before the upgrade or when never published */
  publishedExtra(epoch: number): Promise<{ dataHash: string; freeAfter: string } | null>;
}

export interface RebuiltExtraV3 {
  file: ExtraFileV1;
  /** how the rebuilt data hash was confirmed: by the chain, by the next local extra file, or not at all (before the upgrade) */
  confirmedBy: ("chain" | "next file")[];
}

/**
 * A13.7: rebuilds extra file n from base file n, extra file n−1 (null for the first extra epoch) and X1 reads at base
 * n's snapshot slot: S(n) is the base snapshot (A12.6) with each asset's forgedAt (its ArtifactRecord, or S(n−1)'s for an
 * asset recycled since) and its last transaction at or before the slot; the pot is X (A13.7 extraPoolV3) and the
 * instant extraCreatedAtV3(base). The result must verify, and is REFUSED when its data hash differs from the one the
 * program recorded for epoch n (after the upgrade) or from extra-(n+1).json's prevDataHash (when that file exists).
 */
export async function rebuildExtraV3(
  base: EpochFileV3, prev: ExtraFileV1 | null, src: ExtraRecoverySourcesV3,
  opts: { next?: ExtraFileV1 | null; potLive?: boolean; liveFrom?: number | null; firstX?: string | null; init?: ExtraInitMark | null } = {},
): Promise<RebuiltExtraV3> {
  const n = base.epoch;
  const pot: ExtraPotLivenessV3 = { live: opts.potLive ?? EXTRA_POT_LIVE, liveFrom: opts.liveFrom };
  const open = await extraOpenV3(n, prev, { ...pot, firstX: opts.firstX ?? null }, src);
  const init = extraInitV3(n, prev, { ...pot, init: opts.init });
  const assets = base.snapshot.records.map((r) => r.asset);
  const liveAt = await src.forgedAt(assets);
  const before = new Map((prev?.snapshot.records ?? []).map((r) => [r.asset, r.forgedAt]));
  const records = base.snapshot.records.map((r) => {
    const forgedAt = liveAt[r.asset] ?? before.get(r.asset);
    if (forgedAt === undefined) throw new Error(`asset ${r.asset}: no ArtifactRecord now (recycled since) and not in S(${n - 1}): its forgedAt cannot be recovered`);
    return { asset: r.asset, tier: r.tier, owner: r.owner, backing: r.backing, origin: r.origin, forgedAt };
  });
  const read: SnapshotReadV3 = { slot: base.snapshot.slot, blockTime: base.window.endTs, records };
  const signatures = await src.assetSignatures(assets, base.snapshot.slot);
  const file = buildExtraAfterBaseV3(base, prev, read, signatures, extraPoolV3(base, open, init), extraCreatedAtV3(base));
  const errs = verifyExtraFile(file, base, prev);
  if (errs.length) throw new Error(`the rebuilt extra-${n}.json does not verify: ${errs.join("; ")}`);
  const confirmedBy: RebuiltExtraV3["confirmedBy"] = [];
  const onChain = await src.publishedExtra(n);
  if (onChain) {
    if (onChain.dataHash !== file.dataHash) throw new Error(`refused: the rebuilt extra-${n}.json has data hash ${file.dataHash}, the program recorded ${onChain.dataHash} for epoch ${n}`);
    confirmedBy.push("chain");
  }
  if (opts.next) {
    if (opts.next.prevDataHash !== file.dataHash) throw new Error(`refused: the rebuilt extra-${n}.json has data hash ${file.dataHash}, extra-${n + 1}.json was built on ${opts.next.prevDataHash}`);
    confirmedBy.push("next file");
  }
  return { file, confirmedBy };
}

// ── A13.6: an extra epoch is never blocked forever by one bad week ─────────────────────────────────
export interface CaughtUpExtraV3 {
  epoch: number;
  file: ExtraFileV1;
  how: "rebuilt" | "skipped";
  reason?: string;
}

/**
 * A13.6: before extra epoch `upTo + 1` is built, every missing extra file of the history (from its first epoch to
 * `upTo`) is rebuilt (A13.7) or, when that fails, written as a SKIP heartbeat with the failure as its reason. A file the
 * program already published is never replaced by a skip (its claims need the real file), a rebuild REFUSED for a
 * data-hash mismatch is never skipped over, a lost file that a later local file of the history (up to `upTo`) was built
 * on is never skipped over (A13.8: unless that file was built on this very skip), and once the pot is live a skip never
 * assumes X = 0 (A13.8): all of these throw and nothing is written. Returns the files to write, oldest first, and the
 * extra file epoch upTo + 1 builds on (extra-(upTo + 1).json is the one about to be built, so it is not history here).
 */
export async function catchUpExtrasV3(o: {
  upTo: number;
  firstEpoch: number;
  baseOf: (epoch: number) => EpochFileV3 | null;
  extraOf: (epoch: number) => ExtraFileV1 | null;
  src: ExtraRecoverySourcesV3;
  potLive?: boolean;
  /** A11-a: X of the first extra epoch, read from init_extra (initExtraXV3) once the pot is live; null = not read */
  firstX?: string | null;
  /** OD-9: the init_extra mark read from the chain (readExtraInitV3) once the pot is live; null = not read */
  init?: ExtraInitMark | null;
  /** the chain's first extra epoch once live (ExtraPotLivenessV3); undefined = the whole history follows potLive */
  liveFrom?: number | null;
  log?: (m: string) => void;
}): Promise<{ written: CaughtUpExtraV3[]; prev: ExtraFileV1 | null }> {
  const log = o.log ?? (() => {});
  const potLive = o.potLive ?? EXTRA_POT_LIVE;
  const pot: ExtraPotLivenessV3 = { live: potLive, liveFrom: o.liveFrom };
  const firstX = o.firstX ?? null;
  const init = o.init ?? null;
  const written: CaughtUpExtraV3[] = [];
  let prev: ExtraFileV1 | null = null;
  for (let e = o.firstEpoch; e <= o.upTo; e++) {
    const have = o.extraOf(e);
    if (have) {
      prev = have;
      continue;
    }
    const base = o.baseOf(e);
    if (!base) throw new Error(`epoch-${e}.json is missing: extra-${e}.json can be neither rebuilt nor skipped without its base file`);
    let file: ExtraFileV1;
    try {
      file = (await rebuildExtraV3(base, prev, o.src, { next: o.extraOf(e + 1), potLive, liveFrom: o.liveFrom, firstX, init })).file;
      written.push({ epoch: e, file, how: "rebuilt" });
      log(`  extra-${e}.json was missing: rebuilt (A13.7)`);
    } catch (err) {
      const reason = String((err as Error)?.message ?? err);
      if (/^refused:/.test(reason)) throw err;
      const published = await o.src.publishedExtra(e);
      if (published) throw new Error(`extra-${e}.json was published on-chain but cannot be rebuilt (${reason}): restore it, a skip never replaces a published extra epoch`);
      // A13.8 (review R1): a later local extra file of the history was built on the lost one, so a skip here would fork
      // the history (that file's prevDataHash, and every file after it, would no longer verify). Before the upgrade the
      // chain records no extra epoch, so this local check is what protects the history; it never assumes anything
      const later = laterExtraV3(o.extraOf, e, o.upTo);
      if (later && later.epoch !== e + 1) throw new Error(builtOnLost(later, e, reason));
      let X = "0";
      if (potLiveForV3(e, pot)) {
        // A13.8 (review R1, E5): X is never assumed to be 0 once the pot is live; the first extra epoch's X is the one read
        // from init_extra (A11-a, `firstX`), and without that reading the week can be neither rebuilt nor skipped
        if (firstLiveV3(e, prev, pot)) {
          if (firstX === null) throw new Error(`extra-${e}.json cannot be skipped either: it is the first extra epoch, whose X comes from init_extra (not read, A11-a), and X is never assumed to be 0 (A13.8); restore it (${reason})`);
          X = firstX;
        } else {
          const pe = await o.src.publishedExtra(prev!.epoch);
          if (!pe) throw new Error(`extra-${e}.json cannot be skipped either: ExtraEpochPublished(${prev!.epoch}) could not be read (${reason})`);
          X = pe.freeAfter;
        }
      }
      // OD-9: a skip carries the pot's init_extra mark too (never assumed: without it, once live, this throws)
      file = buildSkipExtraFile(base, prev, `extra epoch ${e} could not be built or rebuilt: ${reason}`, { ...extraPoolV3(base, X, extraInitV3(e, prev, { ...pot, init })), createdAt: extraCreatedAtV3(base) });
      // the next file may only have been built on this very skip (the same reason, so the same bytes)
      if (later && later.prevDataHash !== file.dataHash) throw new Error(builtOnLost(later, e, reason));
      written.push({ epoch: e, file, how: "skipped", reason });
      log(`  extra-${e}.json was missing and cannot be rebuilt: written as a SKIP heartbeat (A13.6): ${reason.slice(0, 200)}`);
    }
    prev = file;
  }
  return { written, prev };
}

/** A13.8: the nearest local extra file after epoch `e` up to `upTo` (the history the catch-up keeps), or null. */
function laterExtraV3(extraOf: (epoch: number) => ExtraFileV1 | null, e: number, upTo: number): ExtraFileV1 | null {
  for (let k = e + 1; k <= upTo; k++) {
    const f = extraOf(k);
    if (f) return f;
  }
  return null;
}

const builtOnLost = (later: ExtraFileV1, e: number, reason: string) =>
  `extra-${later.epoch}.json was built on the lost extra-${e}.json (its history, prevDataHash ${String(later.prevDataHash).slice(0, 16)}…): ` +
  `restore extra-${e}.json or rebuild it (rebuild-extra ${e}); a skip heartbeat would fork the history, so nothing is written (A13.8). The rebuild failed: ${reason}`;

/** The first extra epoch of the history: the pinned EXTRA_FIRST_EPOCH, else the v3 history's first epoch (A12.8). */
export function extraFirstEpochV3(base: EpochFileV3): number {
  return EXTRA_FIRST_EPOCH ?? base.v3FirstEpoch;
}

// ── recording sources (fixtures) ───────────────────────────────────────────────────────────────
/** A recorded run of the sources: every answer keyed by call, replayable by `fixtureSources`. */
export interface RecordedSourcesV3 {
  finalHead: Record<string, number>;
  readChain: Record<string, ChainReadV3>;
  market: Record<string, XenMarketV3>;
  xenCloses: Record<string, string[] | null>;
  xntCloses: Record<string, string[] | null>;
  totalSupply: Record<string, string>;
  snapshot: SnapshotReadV3[];
  /** A13.9: the window anchors read alone (only when the snapshot could not be read); absent in older recordings */
  anchor?: { slot: number; blockTime: number | null }[];
  freePool: { lamports: string; slot: number }[];
  xnt: { twapE18: string; apiE18: string; source: string } | null;
  published: Record<string, PublishedRecordV3 | null>;
  assetSignatures: Record<string, string>;
  now: string | null;
  errors: Record<string, string>;
  /** X-010: the second provider's counters, by chain and block (absent in older recordings: replayed as "none answered") */
  counters?: Record<string, PortalCountersV3 | null>;
  /** D-13: the on-chain depth by chain and block; D-22 (a): the XDEX reading (both absent in older recordings: not read) */
  depth?: Record<string, XenDepthV3>;
  xdex?: XdexReadingV3 | null;
}

export const emptyRecording = (): RecordedSourcesV3 => ({
  finalHead: {}, readChain: {}, market: {}, xenCloses: {}, xntCloses: {}, totalSupply: {}, snapshot: [], freePool: [], xnt: null, published: {},
  assetSignatures: {}, now: null, errors: {},
});

/** Wraps live sources so that every answer (and every failure) lands in `rec`. */
export function recordingSources(inner: SourcesV3, rec: RecordedSourcesV3): SourcesV3 {
  const tap = async <T>(key: string, store: (v: T) => void, fn: () => Promise<T>): Promise<T> => {
    try {
      const v = await fn();
      store(v);
      return v;
    } catch (e) {
      rec.errors[key] = String((e as Error)?.message ?? e).slice(0, 300);
      throw e;
    }
  };
  return {
    finalHead: (c) => tap(`finalHead:${c.chainId}`, (v) => (rec.finalHead[c.chainId] = v), () => inner.finalHead(c)),
    readChain: (c, from, to) => tap(`readChain:${c.chainId}:${from}:${to}`, (v) => (rec.readChain[`${c.chainId}:${from}:${to}`] = v), () => inner.readChain(c, from, to)),
    market: (c) => tap(`market:${c.chainId}`, (v) => (rec.market[c.chainId] = v), () => inner.market(c)),
    xenCloses: (c, m, h) => tap(`xenCloses:${c.chainId}:${h}`, (v) => (rec.xenCloses[`${c.chainId}:${h}`] = v), () => inner.xenCloses(c, m, h)),
    xntCloses: (h, pool) => tap(`xntCloses:${h}`, (v) => (rec.xntCloses[h] = v), () => inner.xntCloses(h, pool)),
    totalSupply: (c, b) => tap(`totalSupply:${c.chainId}:${b}`, (v) => (rec.totalSupply[`${c.chainId}:${b}`] = v), () => inner.totalSupply(c, b)),
    snapshot: () => tap("snapshot", (v) => rec.snapshot.push(v), () => inner.snapshot()),
    freePool: () => tap("freePool", (v) => rec.freePool.push(v), () => inner.freePool()),
    xnt: () => tap("xnt", (v) => (rec.xnt = v), () => inner.xnt()),
    published: (e, tx) => tap(`published:${e}`, (v) => (rec.published[e] = v), () => inner.published(e, tx)),
    assetSignatures: (a, slot) => tap("assetSignatures", (v) => Object.assign(rec.assetSignatures, v), () => inner.assetSignatures(a, slot)),
    now: () => (rec.now = rec.now ?? inner.now()),
    // optional probes (A12): passed through, not recorded (a replay without them reports what they would have settled)
    ...(inner.missionBefore ? { missionBefore: (c: ChainConfig, id: string, to: number) => inner.missionBefore!(c, id, to) } : {}),
    ...(inner.blockTime ? { blockTime: (slot: number) => inner.blockTime!(slot) } : {}),
    ...(inner.anchor ? { anchor: () => tap("anchor", (v: { slot: number; blockTime: number | null }) => (rec.anchor = [...(rec.anchor ?? []), v]), () => inner.anchor!()) } : {}),
    ...(inner.counters
      ? { counters: (c: ChainConfig, to: number, except: string | null) => tap(`counters:${c.chainId}:${to}`, (v: PortalCountersV3 | null) => (rec.counters = { ...(rec.counters ?? {}), [`${c.chainId}:${to}`]: v }), () => inner.counters!(c, to, except)) }
      : {}),
    ...(inner.rulesBlock ? { rulesBlock: (n: number) => inner.rulesBlock!(n) } : {}),
    ...(inner.depth
      ? { depth: (c: ChainConfig, m: XenMarketV3, b: number) => tap(`depth:${c.chainId}:${b}`, (v: XenDepthV3) => (rec.depth = { ...(rec.depth ?? {}), [`${c.chainId}:${b}`]: v }), () => inner.depth!(c, m, b)) }
      : {}),
    ...(inner.xdex ? { xdex: () => tap("xdex", (v: XdexReadingV3) => (rec.xdex = v), () => inner.xdex!()) } : {}),
    ...(inner.rawCandles ? { rawCandles: (k: string) => inner.rawCandles!(k) } : {}),
    ...(inner.quoteUsd ? { quoteUsd: (c: ChainConfig, m: XenMarketV3, b: number) => inner.quoteUsd!(c, m, b) } : {}),
    ...(inner.xntPools ? { xntPools: () => inner.xntPools!() } : {}),
  };
}

/** Sources that replay a recording; a key the recording does not have fails like a dead RPC (so the chain is skipped). */
export function fixtureSources(rec: RecordedSourcesV3): SourcesV3 {
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`fixture has no ${what}`);
    return v;
  };
  let snaps = 0;
  let pools = 0;
  let anchors = 0;
  const anchorsRec = rec.anchor;
  return {
    finalHead: async (c) => need(rec.finalHead[c.chainId], `finalHead ${c.chainId}`),
    readChain: async (c, from, to) => need(rec.readChain[`${c.chainId}:${from}:${to}`], `readChain ${c.chainId}:${from}:${to}`),
    market: async (c) => need(rec.market[c.chainId], `market ${c.chainId}`),
    xenCloses: async (c, _m, h) => rec.xenCloses[`${c.chainId}:${h}`] ?? null,
    xntCloses: async (h) => rec.xntCloses[h] ?? null,
    totalSupply: async (c, b) => need(rec.totalSupply[`${c.chainId}:${b}`], `totalSupply ${c.chainId}:${b}`),
    // a recording whose every snapshot read failed replays that failure (A13.9), so the anchor below is replayed too
    snapshot: async () => {
      if (!rec.snapshot.length && rec.errors.snapshot) throw new Error(rec.errors.snapshot);
      return need(rec.snapshot[Math.min(snaps++, rec.snapshot.length - 1)], "snapshot");
    },
    ...(anchorsRec && anchorsRec.length ? { anchor: async () => anchorsRec[Math.min(anchors++, anchorsRec.length - 1)] } : {}),
    freePool: async () => need(rec.freePool[Math.min(pools++, rec.freePool.length - 1)], "freePool"),
    xnt: async () => need(rec.xnt ?? undefined, "xnt"),
    published: async (e) => need(rec.published[e], `published ${e}`),
    assetSignatures: async (assets) => Object.fromEntries(assets.filter((a) => rec.assetSignatures[a]).map((a) => [a, rec.assetSignatures[a]])),
    now: () => need(rec.now ?? undefined, "now"),
    ...(rec.counters ? { counters: async (c: ChainConfig, to: number) => rec.counters![`${c.chainId}:${to}`] ?? null } : {}),
    ...(rec.depth ? { depth: async (c: ChainConfig, _m: XenMarketV3, b: number) => need(rec.depth![`${c.chainId}:${b}`], `depth ${c.chainId}:${b}`) } : {}),
    ...(rec.xdex !== undefined ? { xdex: async () => need(rec.xdex ?? undefined, "xdex") } : {}),
  };
}
