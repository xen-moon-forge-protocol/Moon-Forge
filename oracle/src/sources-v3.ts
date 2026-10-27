/**
 * The live sources of the rewards v3 plumbing (flow-v3.ts `SourcesV3`): EVM portals and markets through evm.ts and
 * pricing.ts, X1 through x1-v3.ts. Every answer is a plain value the engine records in the epoch file, so a run can be
 * recorded (`recordingSources`) and replayed against the fixtures in test/flow.test.ts.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import { ChainConfig } from "./config";
import { finalHead, missionLogBeforeV3, portalCountersV3, readChainV3 } from "./evm";
import { toE18 } from "./epoch";
import { ExtraRecoverySourcesV3, rpcOrderV3, SourcesV3, XenMarketV3 } from "./flow-v3";
import { chainlinkUsdV3, xenDepthV3, xenHourlyClosesV3, XenMarketDetailV3, xenMarketV3, xenTotalSupply, xntHourlyClosesV3, xntTwapOnChain, xntUsd } from "./pricing";
import { readXdexV3, XNT_POOL_CANDIDATES_V3 } from "./xdex-v3";
import { ExtraInitMark } from "./extra";
import { rulesForEpochV3 } from "./rules-v3";
import {
  artifactForgedAtV3, artifactSnapshotV3, assetSignaturesV3, extraFirstEpochOnChainV3, ExtraPotV3, freePoolV3, initExtraXV3, readEpochPublishedV3, readExtraInitV3,
  readExtraPotV3, readExtraPublishedV3, UPGRADED_ELF,
} from "./x1-v3";

/**
 * A13.7: the X1 reads a rebuild of a lost extra file needs (immutable records and finalized history only). The
 * ExtraEpochPublished reader runs only once the extra pot is detected (`potLive`, readExtraPotV3): before the upgrade
 * the program records no extra epoch, so the answer is null without a read, exactly as before.
 */
export function liveExtraRecoveryV3(connection: Connection, program: anchor.Program, potLive = false): ExtraRecoverySourcesV3 {
  return {
    forgedAt: (assets) => artifactForgedAtV3(program, assets),
    assetSignatures: (assets, slot) => assetSignaturesV3(connection, assets, slot),
    publishedExtra: async (epoch) => (potLive ? readExtraPublishedV3(connection, program, epoch) : null),
  };
}

export function liveSourcesV3(connection: Connection, program: anchor.Program): SourcesV3 {
  const markets = new Map<number, Promise<XenMarketDetailV3>>();
  // D-23 (phase 1): every candle request as answered, by candle key, for the epoch's price sidecar
  const raw = new Map<string, { url: string; ohlcv: number[][] }>();
  return {
    finalHead: (c: ChainConfig) => finalHead(c),
    // A12 (P5): hosts that refuse historical state are tried last, so a fail-over keeps the counter at the cursor
    readChain: (c, from, to) => readChainV3({ ...c, rpcs: rpcOrderV3(c.rpcs) }, from, to),
    missionBefore: (c, missionId, to) => missionLogBeforeV3({ ...c, rpcs: rpcOrderV3(c.rpcs) }, missionId, to),
    // X-010 / X-022: the counters at toBlock through another provider than the one that served the logs
    counters: (c, to, except) => portalCountersV3({ ...c, rpcs: rpcOrderV3(c.rpcs) }, to, except),
    // T2-RULES: the rules in force (rules-v3.ts) with the pinned S2 binary's hash (R-7; null until pinned)
    rulesBlock: (epoch) => rulesForEpochV3(epoch, UPGRADED_ELF?.sha256 ?? null),
    blockTime: (slot) => connection.getBlockTime(slot),
    market: (c) => {
      if (!markets.has(c.chainId)) {
        // round 4: the v3 market read (GeckoTerminal with Retry-After), with the price pool's age (D-13) and its quote token (A5-c, the route)
        markets.set(c.chainId, xenMarketV3(c));
      }
      return markets.get(c.chainId)!;
    },
    xenCloses: (c, m, hourStart) =>
      xenHourlyClosesV3(c, { refUsd: m.refUsd, spotUsd: m.spotUsd, liquidityUsd: m.liquidityUsd, topPool: m.topPool, xenIsBase: m.xenIsBase, pools: m.pools }, hourStart, (r) => raw.set(`${c.chainId}:${hourStart}`, { url: r.url, ohlcv: r.ohlcv })),
    rawCandles: (key) => raw.get(key) ?? null,
    // D-13: the eligible pools' XEN balances at toBlock (and the price pool's route for the kit)
    depth: async (c, _m, block) => {
      const m = await markets.get(c.chainId);
      if (!m) return { micro: null, route: null };
      return xenDepthV3(c, m, block);
    },
    // A5-c: Chainlink's USD price of the price pool's quote token at toBlock (read-only eth_call)
    quoteUsd: (c, m, block) => chainlinkUsdV3(c, m.quote?.address, block),
    // D-22 (a): the XDEX pool at the build (finalized, read-only)
    xdex: () => readXdexV3(connection, "finalized"),
    xntCloses: (hourStart, pool) => xntHourlyClosesV3(hourStart, (r) => raw.set(`xnt:${hourStart}`, { url: r.url, ohlcv: r.ohlcv }), pool),
    // D-22 (b): every candidate XNT/USDC.X pool's TVL (2 × its USDC.X side, read-only)
    xntPools: async () => {
      const out: { pool: string; tvlMicro: string }[] = [];
      for (const pool of XNT_POOL_CANDIDATES_V3) out.push({ pool, tvlMicro: (2n * BigInt((await readXdexV3(connection, "finalized", pool)).usdcReserveMicro)).toString() });
      return out;
    },
    totalSupply: (c, block) => xenTotalSupply(c, block),
    snapshot: () => artifactSnapshotV3(connection, program),
    // A13.9: the window anchor alone, when the Artifact records cannot be read (the base never waits on them)
    anchor: async () => {
      const slot = await connection.getSlot("finalized");
      return { slot, blockTime: await connection.getBlockTime(slot) };
    },
    freePool: () => freePoolV3(connection, program),
    xnt: async () => {
      // build price = max(twap, api) in the engine; each reading is "0" when unavailable, both missing aborts the build
      const api = await xntUsd().catch(() => ({ usd: 0, source: "unavailable" }));
      const twap = await xntTwapOnChain().catch(() => 0);
      return { twapE18: twap > 0 ? toE18(twap) : "0", apiE18: api.usd > 0 ? toE18(api.usd) : "0", source: `${api.source}; twap XDEX 4oUvUg…pkPZ` };
    },
    published: (epoch, tx) => readEpochPublishedV3(connection, program, epoch, tx),
    assetSignatures: (assets, slot) => assetSignaturesV3(connection, assets, slot),
    now: () => new Date().toISOString(),
  };
}

/** What one run reads about the extra pot (injected in tests; liveExtraPotReadsV3 on X1, read-only). */
export interface ExtraPotReadsV3 {
  pot(): Promise<ExtraPotV3>;
  published(epoch: number): Promise<unknown | null>;
  init(): Promise<ExtraInitMark | null>;
}

export function liveExtraPotReadsV3(connection: Connection, program: anchor.Program): ExtraPotReadsV3 {
  return {
    pot: () => readExtraPotV3(connection, program),
    published: (epoch) => readExtraPublishedV3(connection, program, epoch),
    init: () => readExtraInitV3(connection, program),
  };
}

/** The extra pot of one run (A11-a, OD-9), every value derived from the chain, none set by hand. */
export interface ExtraPotRunV3 {
  /** the W2-4 detection: true only on the upgraded binary with ExtraState and OracleSeat (replaces EXTRA_POT_LIVE) */
  live: boolean;
  /** the chain's first extra epoch (replaces EXTRA_FIRST_EPOCH): Config.last_epoch at init_extra + 1; null before the upgrade */
  liveFrom: number | null;
  /** X of that first extra epoch, read from init_extra (initExtraXV3) */
  firstX: string | null;
  /** OD-9: the init_extra transaction and its block time (the pre-upgrade boundary) */
  init: ExtraInitMark | null;
}

/**
 * DETECTION RULE for the extra pot: before the upgrade (verdict "legacy") nothing is read and every extra file stays a
 * budget-0 heartbeat, exactly as before; on the upgraded binary the first extra epoch, its X and the init_extra mark are
 * read from the chain. "unknown", or any read that fails, throws: the run builds and publishes nothing extra (fail closed).
 */
export async function extraPotRunV3(reads: ExtraPotReadsV3): Promise<ExtraPotRunV3> {
  const pot = await reads.pot();
  if (!pot.live) return { live: false, liveFrom: null, firstX: null, init: null };
  if (!pot.state) throw new Error("the extra pot is live but ExtraState could not be decoded");
  const liveFrom = await extraFirstEpochOnChainV3(pot.state, reads.published);
  const firstX = initExtraXV3(pot, liveFrom);
  const init = await reads.init();
  if (!init) throw new Error("the extra pot is live but its init_extra transaction was not found (OD-9: the pre-upgrade boundary is unknown)");
  return { live: true, liveFrom, firstX, init };
}
