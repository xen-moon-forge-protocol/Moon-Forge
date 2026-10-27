/**
 * The week-so-far feed (FEED CONTRACT v1 of agents/kit/burn.mjs): the hourly, machine-readable state of the epoch being
 * built, which the site (frontend/src/lib/quote.ts) and the agent kit (agents/kit/burn.mjs quoteBurn) need to quote a
 * burn under the v3 rules. It is written by the oracle (`npm run feed`), never committed: the keeper workflow serves it
 * with the site, at <site>/feed/week-so-far.json (FEED_PATH).
 *
 * ONE ENGINE. Every derived number of the feed (the capacity C and Σ senior, the XNT build price and floor, each chain's
 * L, price cap, reference spot and curve state) comes from windowStateV3 in rewards.ts: the very function the weekly
 * build (computeEpochV3) runs, on the same inputs, before it builds the leaves. The raw part (each chain's burns with
 * their price readings, its market and its live liquidity) is read by assembleInputsV3, the build's own reader. The
 * feed's only differences from a build on the same inputs, both required by the contract:
 *  - the window ends at `asOf` (a finalized X1 slot's block time), and the run is labelled provisional (a window shorter
 *    than 6 days is never an epoch file);
 *  - the allocation is the plain first-come-first-served run at C (the kit's applyLimit:false): the build limit, which
 *    only a shortfall at the build can make bind, is not consulted.
 * test/feed.test.ts checks both: the feed equals the kit's supersetFeed() on the kit's recorded window, and its numbers
 * equal those of the epoch build on the same inputs.
 *
 * DORMANT UNTIL THE SWITCH. The CLI writes nothing while epoch n is built under the v2 rules (rewardsVersionFor) or the
 * live program is not the upgraded binary (W2-4 detection): then there is no binding quote, and no feed.
 *
 * What the feed does NOT make exact (reported, not hidden): the build reads each chain's liquidity L once, at the build;
 * the feed carries this hour's reading (Lnow) and the previous epoch's L (Lprev), so a client computes the L the engine
 * would use if the window closed now (clampL). Burns of the same chain in the same hour share that hour's curve pot,
 * and burns after the feed's EVM heads are not in it yet: a quote is the engine's number for the window as the feed
 * saw it.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ChainConfig } from "./config";
import {
  AnyEpochFile, BurnInputV3, EpochInputsV3, HOUR, LiquiditySampleV3, liquidityReadingV3, MarketV3, NoXenPriceError, RulesBlockV3, SwitchRefV3, uint, windowStateV3,
  WindowStateV3, XdexReadingV3,
} from "./rewards";
import type { XenRouteV3 } from "./pricing";
import { assembleInputsV3, candleReadings, CandleReadingV3, KnownReadingsV3, prevCursor, SkippedChainV3, SourcesV3, XenMarketV3 } from "./flow-v3";

export const FEED_KIND = "week-so-far" as const;
export const FEED_VERSION = 1 as const;
/** the feed's path on the site (GitHub Pages): <site>/feed/week-so-far.json */
export const FEED_PATH = "feed/week-so-far.json";
/** the hourly feed never reads the Artifact records (the base pot never reads them, A13.1) */
export const FEED_SNAPSHOT_REASON = "week-so-far feed: the Artifact records are not read (the base pot never reads them)";
/** the provisional label of the engine run behind a feed (A13.4: a window that is never an epoch file) */
export const FEED_PROVISIONAL = "week-so-far feed: the window so far, never an epoch file";

/** One hour's readings of a chain (the closes before the start of `hour`, in unix hours). */
export interface FeedCurrentV1 {
  hour: number;
  medianE18: string;
  lastCloseE18: string;
  priceSource: "candles" | "fallback";
}

export interface FeedChainV1 {
  chainId: number;
  name: string;
  portal: string;
  /** D-21: "sunset" = an orphaned chain, valued at the orphan price (the kit asks allowStaleOracle for it) */
  status: "ok" | "skipped" | "sunset";
  /** the block range read so far: (fromBlockExclusive, toBlock], fromBlockExclusive = epoch n−1's cursor */
  fromBlockExclusive?: number;
  toBlock?: number;
  /** exactly what the oracle records in epoch-n.json (rewards.ts MarketV3) */
  market?: MarketV3;
  /** this hour's liquidity reading (µUSD) */
  liquidityNowMicro?: string;
  /** D-13: this hour's on-chain depth (null: not read) */
  liquidityOnChainMicro?: string | null;
  /** D-13: the window's hourly readings so far, min(GeckoTerminal, on-chain), this hour's last (the build records them) */
  liquiditySamples?: LiquiditySampleV3[];
  /** D-13: the price pool's creation time (the first-reading cap of a chain with no L yet) */
  poolCreatedAt?: number | null;
  /** FEED CONTRACT `route`: the price pool's reserves this hour (the kit's below-market check); absent when not read */
  route?: XenRouteV3;
  /** exactly what the oracle records in epoch-n.json (rewards.ts BurnInputV3), every burn read so far */
  burns?: BurnInputV3[];
  /** the readings a burn of this chain in the current hour is valued with (absent: the candles could not be read) */
  current?: FeedCurrentV1;
  // derived (FEED CONTRACT), on valued chains only
  Lnow?: string;
  Lprev?: string | null;
  capE18?: string;
  spotE18?: string;
  S?: string;
  hour?: number;
  hourSpot?: string;
}

/** The raw part of a feed: what the oracle read (the kit and the oracle value it themselves). */
export interface WeekSoFarRawV1 {
  kind: typeof FEED_KIND;
  version: typeof FEED_VERSION;
  programId: string;
  /** the rewards rules epoch `epoch` is built under: always 3 (no feed exists under the v2 rules) */
  rules: 3;
  epoch: number;
  /** X1 unix seconds: the block time of the finalized slot the window so far ends at */
  asOf: number;
  prevEpoch: { epoch: number; dataHash: string };
  /** startTs = epoch n−1's on-chain published_at (the tranche day origin) */
  window: { startTs: number };
  /** open = F_ref (the free pool right after epoch n−1 was published); now = the free pool at asOf (information) */
  freePool: { open: string; now?: string };
  xnt: { twapE18: string; apiE18: string; current?: { hour: number; medianE18: string; lastCloseE18: string; source: "candles" | "fallback" } };
  chains: FeedChainV1[];
  /** at the v2 → v3 switch only (null otherwise) */
  switchRefs: SwitchRefV3[] | null;
  /** sha256 of the oracle's rewards.ts (LF line ends), the engine that wrote this feed (the kit's vectors carry the same) */
  engineSha256?: string;
  /** FEED CONTRACT `xdex`: the XDEX WXNT/USDC.X pool this hour (the kit's route back to XNT); absent when not read */
  xdex?: XdexReadingV3;
  /** FEED CONTRACT `flags`: anomalyHold = epoch n is held by the D-17 gate (index.ts gate record); recoveryPending is not emitted */
  flags?: { anomalyHold: boolean };
  /**
   * T2-RULES: the rules block epoch `epoch` is built under (rules-v3.ts), so a client ranks the burns as the build will
   * (D-12 backlog, D-14 tie-break, D-18 operator wallets and their dated exceptions). Absent (the kit's v1 example):
   * the default block (rewards.ts DEFAULT_RULES_V3).
   */
  rulesBlock?: RulesBlockV3;
}

/** The whole feed: the raw part and every derived field (FEED CONTRACT v1). */
export interface WeekSoFarFeedV1 extends Omit<WeekSoFarRawV1, "xnt"> {
  prevDataHash: string;
  capacity: { cash: string; senior: string };
  xnt: WeekSoFarRawV1["xnt"] & { buildE18: string; floorE18: string };
  readings: { hour: number | null; xen: Record<string, [string, string] | null>; xnt: [string, string] | null };
  skipped: number[];
}

const DERIVED_TOP = ["prevDataHash", "capacity", "readings", "skipped"] as const;
const DERIVED_CHAIN = ["Lnow", "Lprev", "capE18", "spotE18", "S", "hour", "hourSpot"] as const;

/** The raw part of a feed (every derived field removed): what weekSoFarFeedV1 rebuilds the feed from. */
export function rawOfFeedV1(feed: WeekSoFarFeedV1 | WeekSoFarRawV1): WeekSoFarRawV1 {
  const f = JSON.parse(JSON.stringify(feed)) as Record<string, unknown> & WeekSoFarRawV1;
  for (const k of DERIVED_TOP) delete f[k];
  if (f.xnt) {
    delete (f.xnt as Record<string, unknown>).buildE18;
    delete (f.xnt as Record<string, unknown>).floorE18;
  }
  f.chains = (f.chains ?? []).map((c) => {
    if (c.status === "skipped") return c;
    const n = { ...c } as Record<string, unknown>;
    for (const k of DERIVED_CHAIN) delete n[k];
    return n as unknown as FeedChainV1;
  });
  return f;
}

const iso = (ts: number) => new Date(ts * 1000).toISOString();

/** Checks the raw part against epoch n−1 (the file it continues); throws on the first problem. */
export function checkRawV1(raw: WeekSoFarRawV1, prev: AnyEpochFile | null): void {
  if (!raw || raw.kind !== FEED_KIND || raw.version !== FEED_VERSION) throw new Error("not a week-so-far feed v1");
  if (raw.rules !== 3) throw new Error(`a week-so-far feed exists only under the v3 rules (rules ${String(raw.rules)})`);
  if (!prev) throw new Error("a week-so-far feed continues a published epoch: epoch n−1's file is required");
  if (raw.epoch !== prev.epoch + 1) throw new Error(`the feed is for epoch ${raw.epoch}, but the previous file is epoch ${prev.epoch}`);
  if (!raw.prevEpoch || raw.prevEpoch.epoch !== prev.epoch || raw.prevEpoch.dataHash !== prev.dataHash) throw new Error(`the feed does not continue epoch-${prev.epoch}.json (its data hash)`);
  if (!Number.isSafeInteger(raw.asOf) || !Number.isSafeInteger(raw.window?.startTs) || raw.asOf < raw.window.startTs) throw new Error("the feed's asOf is not an X1 time after the window start");
  uint(raw.freePool?.open, "freePool.open");
  if (raw.freePool.now !== undefined) uint(raw.freePool.now, "freePool.now");
  const hour = Math.floor(raw.asOf / HOUR);
  const ids = new Set<number>();
  for (const c of raw.chains ?? []) {
    if (ids.has(c.chainId)) throw new Error(`chain ${c.chainId} twice in the feed`);
    ids.add(c.chainId);
    if (c.status !== "ok" && c.status !== "skipped" && c.status !== "sunset") throw new Error(`chain ${c.chainId}: status ${String(c.status)}`);
    if (c.status === "skipped") continue;
    if (!Array.isArray(c.burns) || !c.market) throw new Error(`chain ${c.chainId}: a valued chain carries its raw burns and its market`);
    uint(c.liquidityNowMicro, `chain ${c.chainId} liquidityNowMicro`);
    if (c.current && c.current.hour !== hour) throw new Error(`chain ${c.chainId}: readings for hour ${c.current.hour}, not the feed's hour ${hour}`);
  }
  if (raw.xnt?.current && raw.xnt.current.hour !== hour) throw new Error(`XNT readings for hour ${raw.xnt.current.hour}, not the feed's hour ${hour}`);
}

/**
 * The engine inputs of the window so far (rewards.ts EpochInputsV3): what a build would read if the window ended at
 * `asOf`. A chain without a recorded block range (the kit's form) starts at epoch n−1's cursor and ends at its last burn.
 * The snapshot is recorded unavailable (the base never reads it) and the free pool at build is the feed's `now` reading.
 */
export function feedInputsV3(raw: WeekSoFarRawV1, prev: AnyEpochFile): EpochInputsV3 {
  return {
    programId: raw.programId,
    epoch: raw.epoch,
    createdAt: iso(raw.asOf),
    window: { startTs: raw.window.startTs, endTs: raw.asOf },
    chains: raw.chains
      .filter((c) => c.status !== "skipped")
      .map((c) => {
        const from = c.fromBlockExclusive ?? prevCursor(prev, c.chainId) ?? 0;
        return {
          chainId: c.chainId, name: c.name, portal: c.portal, fromBlockExclusive: from,
          toBlock: c.toBlock ?? Math.max(from, ...(c.burns ?? []).map((b) => b.blockNumber)),
          market: c.market as MarketV3, liquidityNowMicro: c.liquidityNowMicro as string, totalSupply: "0", burns: c.burns ?? [],
          ...(c.status === "sunset" ? { orphan: true as const } : {}),
          // D-13: the hourly samples, this hour's on-chain reading and the pool's age, exactly as the build records them
          ...(c.liquidityOnChainMicro !== undefined ? { liquidityOnChainMicro: c.liquidityOnChainMicro } : {}),
          ...(c.liquiditySamples !== undefined ? { liquiditySamples: c.liquiditySamples } : {}),
          ...(c.poolCreatedAt !== undefined ? { poolCreatedAt: c.poolCreatedAt } : {}),
        };
      }),
    snapshot: { slot: 0, records: [], unavailable: { reason: FEED_SNAPSHOT_REASON } },
    freePool: { lamports: raw.freePool.now ?? raw.freePool.open, slot: 0, open: raw.freePool.open },
    xnt: { twapE18: raw.xnt.twapE18, apiE18: raw.xnt.apiE18, source: "week-so-far feed" },
    switchRefs: raw.switchRefs ?? null,
    ...(raw.rulesBlock !== undefined ? { rulesBlock: raw.rulesBlock } : {}),
  };
}

/**
 * windowStateV3 over the window so far, without the build limit; a chain with a burn that has no XEN price (no candles
 * and a build spot of 0) is marked skipped, as the build skips it (computeEpochV3SkippingUnpriced). Returns the raw part
 * as valued (those chains marked) and the engine state.
 */
export function weekSoFarStateV3(raw: WeekSoFarRawV1, prev: AnyEpochFile): { raw: WeekSoFarRawV1; state: WindowStateV3; unpriced: number[] } {
  checkRawV1(raw, prev);
  const unpriced: number[] = [];
  let current = raw;
  for (;;) {
    try {
      const state = windowStateV3(feedInputsV3(current, prev), prev, { limit: false, provisional: FEED_PROVISIONAL });
      return { raw: current, state, unpriced };
    } catch (e) {
      if (!(e instanceof NoXenPriceError) || unpriced.includes(e.chainId)) throw e;
      unpriced.push(e.chainId);
      current = { ...current, chains: current.chains.map((c) => (c.chainId === e.chainId ? { chainId: c.chainId, name: c.name, portal: c.portal, status: "skipped" as const } : c)) };
    }
  }
}

/**
 * The feed (raw part + every derived field) from its raw part and epoch n−1's file, by the engine. The construction
 * (and so the field order) is the kit's supersetFeed (agents/kit/test/vectors/gen-week-so-far.mjs): a client that
 * re-derives the fields from the raw part gets exactly these.
 */
export function weekSoFarFeedV1(rawIn: WeekSoFarRawV1, prev: AnyEpochFile): WeekSoFarFeedV1 {
  return buildWeekSoFarV1(rawIn, prev).feed;
}

/** weekSoFarFeedV1 with the engine state behind it and the chains it marked skipped (a burn without a XEN price). */
export function buildWeekSoFarV1(rawIn: WeekSoFarRawV1, prev: AnyEpochFile): { feed: WeekSoFarFeedV1; state: WindowStateV3; unpriced: number[] } {
  const { raw, state, unpriced } = weekSoFarStateV3(rawIn, prev);
  const chains: FeedChainV1[] = raw.chains.map((c) => {
    if (c.status === "skipped") return { ...c };
    const ch = state.chains.find((x) => x.chainId === c.chainId && !x.skipped);
    if (!ch) throw new Error(`chain ${c.chainId}: no engine record`);
    const mine = state.works.filter((w) => w.b.chainId === c.chainId);
    let curve: { S: string; hour: number; hourSpot: string };
    if (!mine.length) curve = { S: ch.curveBefore.S, hour: ch.curveBefore.hour, hourSpot: "0" };
    else {
      // the curve after every burn of the earlier hours, at the latest hour, and Σ spot of that hour's burns
      const last = Math.max(...mine.map((w) => w.hour));
      const V = mine.filter((w) => w.hour === last).reduce((s, w) => s + w.spot, 0n);
      curve = { S: (BigInt(ch.curveAfter.S) - V).toString(), hour: ch.curveAfter.hour, hourSpot: V.toString() };
    }
    return { ...c, Lnow: String(c.liquidityNowMicro), Lprev: ch.L.prev, capE18: ch.priceCapE18, spotE18: ch.xenUsdE18, ...curve };
  });
  const pair = (m: string, l: string, src: string): [string, string] | null => (src === "fallback" ? null : [m, l]);
  const valued = chains.filter((c) => c.status !== "skipped" && c.current);
  const hour = raw.xnt.current?.hour ?? valued[0]?.current?.hour ?? null;
  const feed: WeekSoFarFeedV1 = {
    ...raw,
    prevDataHash: raw.prevEpoch.dataHash,
    // D-12 / D-18: the senior a new burn of the window claims after (the backlog and the operator burns rank after it)
    capacity: { cash: state.C.toString(), senior: state.seniorAhead.toString() },
    xnt: { ...raw.xnt, buildE18: state.xBuild.toString(), floorE18: state.xFloor.toString() },
    readings: {
      hour,
      xen: Object.fromEntries(valued.map((c) => [String(c.chainId), pair(c.current!.medianE18, c.current!.lastCloseE18, c.current!.priceSource)])),
      xnt: raw.xnt.current ? pair(raw.xnt.current.medianE18, raw.xnt.current.lastCloseE18, raw.xnt.current.source) : null,
    },
    skipped: chains.filter((c) => c.status === "skipped").map((c) => c.chainId),
    chains,
  };
  return { feed, state, unpriced };
}

// ── readings already published (the previous hour's feed) ────────────────────────────────────────────
const canonicalReading = (m: unknown, l: unknown): CandleReadingV3 | null => {
  try {
    if (uint(m, "median") === 0n || uint(l, "last close") === 0n) return null;
  } catch {
    return null;
  }
  return { medianE18: m as string, lastCloseE18: l as string, source: "candles" };
};

/**
 * The closed-candle readings a previous feed of the SAME window already carries (its burns' readings and its current
 * hour's), so the next hour reads only the hours it has not seen. Null unless that feed is a v1 feed of the same
 * program, epoch and epoch n−1 data hash. Only "candles" readings are reused; a "fallback" hour is read again.
 */
export function knownReadingsOfFeedV1(prevFeed: unknown, id: { programId: string; epoch: number; prevDataHash: string }): KnownReadingsV3 | null {
  const f = prevFeed as Partial<WeekSoFarFeedV1> | null;
  if (!f || f.kind !== FEED_KIND || f.version !== FEED_VERSION || f.programId !== id.programId || f.epoch !== id.epoch || f.prevEpoch?.dataHash !== id.prevDataHash) return null;
  const xen = new Map<string, CandleReadingV3>();
  const xnt = new Map<number, CandleReadingV3>();
  for (const c of Array.isArray(f.chains) ? f.chains : []) {
    for (const b of Array.isArray(c.burns) ? c.burns : []) {
      if (!Number.isSafeInteger(b?.timestamp) || b.chainId !== c.chainId) continue;
      const h = Math.floor(b.timestamp / HOUR) * HOUR;
      const r = b.priceSource === "candles" ? canonicalReading(b.medianE18, b.lastCloseE18) : null;
      if (r) xen.set(`${c.chainId}:${h}`, r);
      const x = b.xntSource === "candles" ? canonicalReading(b.xntMedianE18, b.xntLastCloseE18) : null;
      if (x) xnt.set(h, x);
    }
    const cur = c.current;
    if (cur && Number.isSafeInteger(cur.hour) && cur.priceSource === "candles") {
      const r = canonicalReading(cur.medianE18, cur.lastCloseE18);
      if (r) xen.set(`${c.chainId}:${cur.hour * HOUR}`, r);
    }
  }
  const xc = f.xnt?.current;
  if (xc && Number.isSafeInteger(xc.hour) && xc.source === "candles") {
    const r = canonicalReading(xc.medianE18, xc.lastCloseE18);
    if (r) xnt.set(xc.hour * HOUR, r);
  }
  return { xen: (chainId, hourStart) => xen.get(`${chainId}:${hourStart}`) ?? null, xnt: (hourStart) => xnt.get(hourStart) ?? null };
}

/**
 * D-13: the hourly liquidity samples a feed of the SAME window carries (program, epoch and epoch n−1 data hash), per chain:
 * the next hour's feed appends its own reading to them, and the weekly build records them (its statistic is the minimum
 * of their daily medians). Only canonical, strictly ascending samples are taken (the engine checks them again); a feed
 * of another window gives none.
 */
export function samplesOfFeedV1(feed: unknown, id: { programId: string; epoch: number; prevDataHash: string }): Map<number, LiquiditySampleV3[]> {
  const out = new Map<number, LiquiditySampleV3[]>();
  const f = feed as Partial<WeekSoFarFeedV1> | null;
  if (!f || f.kind !== FEED_KIND || f.version !== FEED_VERSION || f.programId !== id.programId || f.epoch !== id.epoch || f.prevEpoch?.dataHash !== id.prevDataHash) return out;
  for (const c of Array.isArray(f.chains) ? f.chains : []) {
    if (!Number.isSafeInteger(c?.chainId) || !Array.isArray(c.liquiditySamples)) continue;
    const list: LiquiditySampleV3[] = [];
    for (const s of c.liquiditySamples) {
      if (!s || !Number.isSafeInteger(s.hour) || s.hour < 0 || typeof s.micro !== "string" || !/^(0|[1-9][0-9]*)$/.test(s.micro)) continue;
      if (list.length && s.hour <= list[list.length - 1].hour) continue;
      list.push({ hour: s.hour, micro: s.micro });
    }
    out.set(c.chainId, list);
  }
  return out;
}

/** Where the site serves the feed (GitHub Pages, the same origin as the epoch files); FEED_URL overrides it. */
export const FEED_URL_DEFAULT = `https://xen-moon-forge-protocol.github.io/Moon-Forge/${FEED_PATH}`;

/**
 * The published feed (read-only GET, a short timeout), for the weekly build's D-13 samples: null when it cannot be read
 * or parsed (the build then records the samples it has: none, and its statistic is its own reading).
 */
export async function fetchFeedV1(url = process.env.FEED_URL || FEED_URL_DEFAULT, timeoutMs = 20_000, fetcher: typeof fetch = fetch): Promise<unknown | null> {
  try {
    const r = await fetcher(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return JSON.parse(await r.text());
  } catch {
    return null;
  }
}

/** The feed's samples of a chain with this hour's reading appended (replacing a sample already there for that hour). */
export function withHourSampleV1(samples: LiquiditySampleV3[], hour: number, micro: bigint): LiquiditySampleV3[] {
  return [...samples.filter((s) => s.hour < hour), { hour, micro: micro.toString() }];
}

/** sha256 of an engine source file with LF line ends (the kit's vectors record the same digest of rewards.ts). */
export function engineSha256Of(file = path.join(__dirname, "rewards.ts")): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")).digest("hex");
  } catch {
    return null;
  }
}

// ── the live writer's assembly ─────────────────────────────────────────────────────────────────────
export interface AssembledFeedV3 {
  feed: WeekSoFarFeedV1;
  /** chains left out this hour (read failure, or a burn without a XEN price) */
  skipped: SkippedChainV3[];
  warnings: string[];
}

/**
 * Reads the window so far with the build's own reader (assembleInputsV3: the same cursors, mission continuity, burns
 * and per-burn readings) and adds the current hour's readings. The window is anchored at a finalized X1 slot alone: the
 * Artifact records are never read. `known` (the previous hour's feed) spares the candles already read.
 */
export async function assembleWeekSoFarV3(
  prev: AnyEpochFile, s: SourcesV3, chains: ChainConfig[], files: AnyEpochFile[], log: (m: string) => void = () => {},
  opts: {
    known?: KnownReadingsV3 | null; engineSha256?: string | null;
    /** D-13: the samples the previous hour's feed of this window carries (samplesOfFeedV1); this hour's reading is appended */
    samples?: Map<number, LiquiditySampleV3[]> | null;
    /** D-17: epoch n is held by the anomaly gate (FEED CONTRACT flags.anomalyHold) */
    anomalyHold?: boolean;
  } = {},
): Promise<AssembledFeedV3> {
  const markets = new Map<number, XenMarketV3>();
  const src: SourcesV3 = {
    ...s,
    market: async (c) => {
      const m = await s.market(c);
      markets.set(c.chainId, m);
      return m;
    },
    snapshot: async () => {
      const a = s.anchor ? await s.anchor() : await s.snapshot();
      return { slot: a.slot, blockTime: a.blockTime, records: [], unavailable: { reason: FEED_SNAPSHOT_REASON } };
    },
  };
  const n = prev.epoch + 1;
  // the hourly feed records no portal counter, so it asks no second provider (the build does, X-010)
  const a = await assembleInputsV3(n, prev, src, chains, files, log, { known: opts.known ?? null, reconcile: false, samples: (id) => opts.samples?.get(id) ?? [] });
  const asOf = a.inputs.window.endTs;
  const hour = Math.floor(asOf / HOUR);
  const hourStart = hour * HOUR;
  // the current hour's readings: a read that fails leaves `current` out (no quote on that chain this hour); a read
  // that finds no candle is "fallback", as the build would record it
  const readNow = async (known: CandleReadingV3 | null, read: () => Promise<string[] | null>): Promise<CandleReadingV3 | null> => {
    if (known) return known;
    try {
      return candleReadings(await read());
    } catch {
      return null;
    }
  };
  const xntNow = await readNow(opts.known?.xnt(hourStart) ?? null, () => s.xntCloses(hourStart));
  const out: FeedChainV1[] = [];
  for (const c of [...chains].filter((x) => x.portal).sort((x, y) => x.chainId - y.chainId)) {
    const ci = a.inputs.chains.find((x) => x.chainId === c.chainId);
    if (!ci) {
      out.push({ chainId: c.chainId, name: c.name, portal: c.portal, status: "skipped" });
      continue;
    }
    const m = markets.get(c.chainId);
    const cur = m ? await readNow(opts.known?.xen(c.chainId, hourStart) ?? null, () => s.xenCloses(c, m, hourStart)) : null;
    // D-13: this hour's reading, min(GeckoTerminal, on-chain), appended to the window's samples (the build records them)
    const onChain = ci.liquidityOnChainMicro === undefined || ci.liquidityOnChainMicro === null ? null : BigInt(ci.liquidityOnChainMicro);
    const reading = liquidityReadingV3(BigInt(ci.liquidityNowMicro), onChain);
    const route = a.routes?.get(c.chainId);
    out.push({
      chainId: ci.chainId, name: ci.name, portal: ci.portal, status: ci.orphan ? "sunset" : "ok", fromBlockExclusive: ci.fromBlockExclusive, toBlock: ci.toBlock,
      market: ci.market, liquidityNowMicro: ci.liquidityNowMicro, burns: ci.burns,
      ...(cur ? { current: { hour, medianE18: cur.medianE18, lastCloseE18: cur.lastCloseE18, priceSource: cur.source } } : {}),
      ...(ci.liquidityOnChainMicro !== undefined ? { liquidityOnChainMicro: ci.liquidityOnChainMicro } : {}),
      liquiditySamples: withHourSampleV1(ci.liquiditySamples ?? [], hour, reading),
      ...(ci.poolCreatedAt !== undefined ? { poolCreatedAt: ci.poolCreatedAt } : {}),
      ...(route ? { route } : {}),
    });
  }
  const open = a.inputs.freePool.open;
  if (open === null) throw new Error("epoch n−1's publication gave no F_ref");
  const raw: WeekSoFarRawV1 = {
    kind: FEED_KIND, version: FEED_VERSION, programId: a.inputs.programId, rules: 3, epoch: n, asOf,
    prevEpoch: { epoch: prev.epoch, dataHash: prev.dataHash }, window: { startTs: a.inputs.window.startTs },
    freePool: { open, now: a.inputs.freePool.lamports },
    xnt: { twapE18: a.inputs.xnt.twapE18, apiE18: a.inputs.xnt.apiE18, ...(xntNow ? { current: { hour, medianE18: xntNow.medianE18, lastCloseE18: xntNow.lastCloseE18, source: xntNow.source } } : {}) },
    chains: out,
    switchRefs: a.inputs.switchRefs ?? null,
    ...(opts.engineSha256 ? { engineSha256: opts.engineSha256 } : {}),
    ...(a.inputs.rulesBlock !== undefined ? { rulesBlock: a.inputs.rulesBlock } : {}),
    ...(a.inputs.xdex ? { xdex: a.inputs.xdex } : {}),
    flags: { anomalyHold: opts.anomalyHold === true },
  };
  const { feed, unpriced } = buildWeekSoFarV1(raw, prev);
  const skipped = [
    ...a.skipped,
    ...unpriced.map((id) => ({ chainId: id, name: chains.find((c) => c.chainId === id)?.name ?? String(id), reason: "a burn has no XEN price (no candles and a build spot of 0)" })),
  ];
  return { feed, skipped, warnings: a.warnings };
}

/** The feed as written: one line of JSON (the site and the kit parse it; nothing reads it by eye). */
export const feedText = (feed: WeekSoFarFeedV1) => JSON.stringify(feed) + "\n";

// ── dormant until the switch ─────────────────────────────────────────────────────────────────────────
/**
 * Whether the feed is written this hour: only when epoch n is built under the v3 rules (rewardsVersionFor: the pinned
 * switch epoch, or a v3 previous file) AND the live program is the upgraded binary (W2-4 detection, "upgraded" only:
 * "legacy" and "unknown" keep it dormant). Otherwise no binding quote exists, and no feed is written.
 */
export function feedGateV3(o: { rewardsVersion: 2 | 3; upgrade: "upgraded" | "legacy" | "unknown"; reasons?: string[] }): { active: boolean; reason: string } {
  if (o.rewardsVersion !== 3) return { active: false, reason: "dormant: the next epoch is built under the v2 rules, which pay an estimate: there is no binding quote and no week-so-far feed" };
  if (o.upgrade !== "upgraded") {
    return { active: false, reason: `dormant: the live program is not the upgraded binary (${o.upgrade}${o.reasons?.length ? `: ${o.reasons.join("; ").slice(0, 300)}` : ""})` };
  }
  return { active: true, reason: "" };
}
