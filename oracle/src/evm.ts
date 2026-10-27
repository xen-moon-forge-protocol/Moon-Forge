/**
 * EVM burn reader. Rules that fix the v1 bugs:
 *  - only FINAL blocks (head - confirmations) are read;
 *  - a failed chunk is retried and, if it keeps failing, the whole epoch aborts
 *    (we never move a cursor past blocks we did not read);
 *  - events are deduplicated by (chainId, txHash, logIndex);
 *  - the event must come from the configured portal and carry this chain's id.
 */
import { ethers } from "ethers";
import { PublicKey } from "@solana/web3.js";
import { ChainConfig, PORTAL_ABI } from "./config";

export interface Burn {
  chainId: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  missionId: string;
  pilot: string;
  amountWei: string;
  tier: number;
  x1: string; // Base58
  timestamp: number; // block timestamp of the burn (from the event)
  /** XEN price on its chain at the burn time (median of 24 hourly closes), USD × 1e18 — filled by the epoch builder */
  priceE18?: string;
  priceSource?: string;
  clamped?: boolean;
}

const iface = new ethers.Interface(PORTAL_ABI);
const TOPIC = iface.getEvent("MissionStarted")!.topicHash;

async function withRetry<T>(fn: () => Promise<T>, what: string, tries = 6): Promise<T> {
  let err: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw new Error(`${what} failed after ${tries} tries: ${String(err)}`);
}

/** Runs `fn` against each of the chain's RPCs in order until one succeeds (a whole read restarts on the next RPC). */
export async function withFailover<T>(chain: ChainConfig, what: string, fn: (p: ethers.JsonRpcProvider, rpc: string) => Promise<T>): Promise<T> {
  const errors: string[] = [];
  for (const rpc of chain.rpcs) {
    try {
      return await fn(new ethers.JsonRpcProvider(rpc, chain.chainId, { staticNetwork: true }), rpc);
    } catch (e) {
      errors.push(`${new URL(rpc).host}: ${String(e).slice(0, 200)}`);
    }
  }
  throw new Error(`${chain.name} ${what}: every RPC failed — ${errors.join(" | ")}`);
}

export async function finalHead(chain: ChainConfig): Promise<number> {
  const head = await withFailover(chain, "head", (p) => withRetry(() => p.getBlockNumber(), `${chain.name} head`, 3));
  return Math.max(0, head - chain.confirmations);
}

/** Reads every MissionStarted in (fromBlock, toBlock]. Throws instead of skipping. */
export async function readBurns(chain: ChainConfig, fromBlockExclusive: number, toBlock: number): Promise<Burn[]> {
  return withFailover(chain, `logs ${fromBlockExclusive + 1}-${toBlock}`, (p) => readBurnsFrom(p, chain, fromBlockExclusive, toBlock));
}

async function readBurnsFrom(p: ethers.JsonRpcProvider, chain: ChainConfig, fromBlockExclusive: number, toBlock: number): Promise<Burn[]> {
  const out = new Map<string, Burn>();
  // public RPCs cap eth_getLogs ranges differently (e.g. 500 blocks): shrink the window when refused
  let chunk = chain.logChunk;
  for (let start = fromBlockExclusive + 1; start <= toBlock; ) {
    const end = Math.min(toBlock, start + chunk - 1);
    let logs: ethers.Log[];
    try {
      logs = await p.getLogs({ address: chain.portal, topics: [TOPIC], fromBlock: start, toBlock: end });
    } catch (e) {
      const msg = String(e);
      if (chunk > 50 && /range|limit|too large|too many|413|-32614|-32005|exceed|invalid params/i.test(msg)) {
        chunk = Math.max(50, Math.floor(chunk / 2));
        continue; // retry the same start with a smaller window
      }
      logs = await withRetry(
        () => p.getLogs({ address: chain.portal, topics: [TOPIC], fromBlock: start, toBlock: end }),
        `${chain.name} logs ${start}-${end}`,
        3,
      );
    }
    start = end + 1;
    for (const log of logs) {
      if (log.address.toLowerCase() !== chain.portal.toLowerCase()) continue;
      const ev = iface.parseLog(log);
      if (!ev) continue;
      if (Number(ev.args.chainId) !== chain.chainId) continue;
      const tier = Number(ev.args.tier);
      if (tier > 2) continue;
      const key = `${chain.chainId}:${log.transactionHash}:${log.index}`;
      out.set(key, {
        chainId: chain.chainId,
        txHash: log.transactionHash,
        logIndex: log.index,
        blockNumber: log.blockNumber,
        missionId: ev.args.missionId.toString(),
        pilot: ev.args.pilot,
        amountWei: ev.args.amount.toString(),
        tier,
        x1: new PublicKey(Buffer.from(ethers.getBytes(ev.args.x1Pubkey))).toBase58(),
        timestamp: Number(ev.args.timestamp),
      });
    }
  }
  return [...out.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

// ── v3 (A11, X-010, X-022): one RPC for the head, the logs and the portal counters ──────────────
export interface ChainReadResultV3 {
  burns: Burn[];
  /** portal.totalMissions() at toBlock, from the same RPC as the logs */
  totalMissions: string;
  /** portal.totalMissions() at fromBlockExclusive; null when the RPC does not serve that state (pruned) */
  totalMissionsBefore: string | null;
  /** X-010: portal.totalBurned() at toBlock, from the same RPC as the logs */
  totalBurned: string;
  /** the host of the RPC that served the read (the second-provider reconciliation asks another one) */
  rpc: string;
}

/** The host of an RPC URL (the URL itself when it does not parse): what the run logs and the reconciliation compares. */
export function rpcHost(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
}

const PORTAL_COUNTERS_ABI = ["function totalMissions() view returns (uint256)", "function totalBurned() view returns (uint256)"];

/**
 * Reads (fromBlockExclusive, toBlock] with the portal's mission counter at toBlock, so the caller can check that the ids
 * read run contiguously up to it. The counters come from ONE RPC whose own final head reaches toBlock (a node lagging
 * behind the head another RPC gave would answer [] for blocks it does not have yet). T1-8 (round 4): the logs are read
 * chunk by chunk from that RPC and, when a chunk keeps failing there (a 429, a timeout), from the next RPC whose final head
 * also reaches toBlock, KEEPING every chunk already read: a mid-read rate limit no longer restarts a week of logs. (A
 * silent omission by any of them is still caught: the mission ids must run contiguously up to the counter, X-010.)
 */
export async function readChainV3(chain: ChainConfig, fromBlockExclusive: number, toBlock: number): Promise<ChainReadResultV3> {
  return withFailover(chain, `read ${fromBlockExclusive + 1}-${toBlock}`, async (p, rpc) => {
    const head = await withRetry(() => p.getBlockNumber(), `${chain.name} head`, 3);
    if (head - chain.confirmations < toBlock) throw new Error(`final head ${head - chain.confirmations} below ${toBlock}: this RPC lags behind`);
    // A12 (P5): the counters at toBlock first, while toBlock is still inside a non-archive node's recent-state window;
    // the logs (a slow read over a week of blocks) come after them
    const portal = new ethers.Contract(chain.portal, PORTAL_COUNTERS_ABI, p);
    const totalMissions: bigint = await withRetry(() => portal.totalMissions({ blockTag: toBlock }), `${chain.name} totalMissions@${toBlock}`, 3);
    const totalBurned: bigint = await withRetry(() => portal.totalBurned({ blockTag: toBlock }), `${chain.name} totalBurned@${toBlock}`, 3);
    // the logs: this RPC first, the chain's other RPCs (in order) as per-chunk fallbacks
    const order = [rpc, ...chain.rpcs.filter((r) => r !== rpc)];
    const providers = order.map((u, i) => (i === 0 ? p : new ethers.JsonRpcProvider(u, chain.chainId, { staticNetwork: true })));
    const headOk = new Map<number, boolean>([[0, true]]);
    const read = await chunkedLogsV3(fromBlockExclusive, toBlock, chain.logChunk, providers.length, async (i, start, end) => {
      if (!headOk.has(i)) {
        const h = await withRetry(() => providers[i].getBlockNumber(), `${chain.name} head`, 2).catch(() => -1);
        headOk.set(i, h - chain.confirmations >= toBlock);
      }
      if (!headOk.get(i)) throw new Error(`${rpcHost(order[i])}: final head below ${toBlock}`);
      return readMissionLogsV3(providers[i], chain, start, end);
    });
    const burns = dedupeBurnsV3(read.items);
    let totalMissionsBefore: string | null = null;
    if (fromBlockExclusive >= chain.startBlock && fromBlockExclusive > 0) {
      try {
        totalMissionsBefore = ((await portal.totalMissions({ blockTag: fromBlockExclusive })) as bigint).toString();
      } catch {
        totalMissionsBefore = null; // a non-archive node: the local epoch files carry the last id instead
      }
    }
    return { burns, totalMissions: totalMissions.toString(), totalMissionsBefore, totalBurned: totalBurned.toString(), rpc: rpcHost(rpc) };
  });
}

/**
 * X-010 / X-022 (T8-13): the portal counters at toBlock read through a SECOND provider: the first RPC of the chain's
 * list whose host is not `exceptHost` (the one that served the logs), whose own final head reaches toBlock and that
 * serves the state at toBlock. Null when no other provider answers (a chain with one RPC, or only pruned nodes): the
 * reconciliation is then "not confirmed", never a pass and never a skip.
 */
export async function portalCountersV3(chain: ChainConfig, toBlock: number, exceptHost: string | null): Promise<{ totalMissions: string; totalBurned: string; rpc: string } | null> {
  const others = chain.rpcs.filter((r) => rpcHost(r) !== exceptHost);
  if (!others.length) return null;
  try {
    return await withFailover({ ...chain, rpcs: others }, `counters@${toBlock}`, async (p, rpc) => {
      const head = await withRetry(() => p.getBlockNumber(), `${chain.name} head`, 2);
      if (head - chain.confirmations < toBlock) throw new Error(`final head ${head - chain.confirmations} below ${toBlock}: this RPC lags behind`);
      const portal = new ethers.Contract(chain.portal, PORTAL_COUNTERS_ABI, p);
      const totalMissions: bigint = await withRetry(() => portal.totalMissions({ blockTag: toBlock }), `${chain.name} totalMissions@${toBlock}`, 2);
      const totalBurned: bigint = await withRetry(() => portal.totalBurned({ blockTag: toBlock }), `${chain.name} totalBurned@${toBlock}`, 2);
      return { totalMissions: totalMissions.toString(), totalBurned: totalBurned.toString(), rpc: rpcHost(rpc) };
    });
  } catch {
    return null;
  }
}

/**
 * A12 (P5): whether a MissionStarted with this id was emitted in [chain.startBlock, toBlock], with one indexed-topic
 * query per chunk walking back from toBlock (the mission the files miss is usually just before the cursor). Null when
 * no RPC answers or the walk exceeds `maxChunks`.
 */
export async function missionLogBeforeV3(chain: ChainConfig, missionId: string, toBlock: number, maxChunks = 400): Promise<boolean | null> {
  const topic = ethers.zeroPadValue(ethers.toBeHex(BigInt(missionId)), 32);
  try {
    return await withFailover(chain, `mission ${missionId} before ${toBlock}`, async (p) => {
      const span = Math.max(50, chain.logChunk);
      let chunks = 0;
      for (let end = toBlock; end >= chain.startBlock; end -= span) {
        if (++chunks > maxChunks) return null;
        const start = Math.max(chain.startBlock, end - span + 1);
        const logs = await withRetry(() => p.getLogs({ address: chain.portal, topics: [TOPIC, topic], fromBlock: start, toBlock: end }), `${chain.name} mission ${missionId} ${start}-${end}`, 3);
        if (logs.some((l) => l.address.toLowerCase() === chain.portal.toLowerCase())) return true;
      }
      return false;
    });
  } catch {
    return null;
  }
}

// ── v3 (round 4, T1-8 / O-22): per-chunk failover that keeps its progress ───────────────────────────────────────
/** An RPC answer that only a smaller range can fix (the provider's eth_getLogs block or result limit); a rate limit (429) is not one: it fails over. */
export const isRangeErrorV3 = (msg: string) => !/429|too many requests|rate.?limit/i.test(msg) && /range|limit|too large|too many|413|-32614|-32005|exceed|invalid params/i.test(msg);

/**
 * Reads the blocks (fromBlockExclusive, toBlock] in chunks with `readChunk(rpc, start, end)`, starting on RPC 0. A chunk
 * the provider refuses as too large is halved (down to 50 blocks) and retried on the same RPC; a chunk that fails
 * otherwise (after `tries` attempts with a backoff) is read from the next RPC, and the read goes on from there: every chunk
 * already read is kept, nothing is read twice. Throws only when every RPC failed the same chunk. Pure over `readChunk`.
 */
export async function chunkedLogsV3<T>(
  fromBlockExclusive: number, toBlock: number, chunk0: number, rpcCount: number, readChunk: (rpc: number, start: number, end: number) => Promise<T[]>,
  o: { tries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ items: T[]; rpcs: number[]; failovers: number }> {
  const tries = o.tries ?? 3;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const items: T[] = [];
  const used = new Set<number>([0]);
  let rpc = 0;
  let chunk = Math.max(50, chunk0);
  let failovers = 0;
  for (let start = fromBlockExclusive + 1; start <= toBlock; ) {
    const end = Math.min(toBlock, start + chunk - 1);
    let got: T[] | null = null;
    let last = "";
    for (let a = 0; a < tries && got === null; a++) {
      try {
        got = await readChunk(rpc, start, end);
      } catch (e) {
        last = String((e as Error)?.message ?? e);
        if (chunk > 50 && isRangeErrorV3(last)) break;
        if (a + 1 < tries) await sleep(1000 * 2 ** a);
      }
    }
    if (got === null) {
      if (chunk > 50 && isRangeErrorV3(last)) {
        chunk = Math.max(50, Math.floor(chunk / 2));
        continue; // the same start, a smaller range, the same RPC
      }
      if (rpc + 1 >= rpcCount) throw new Error(`logs ${start}-${end}: every RPC failed (last: ${last.slice(0, 200)})`);
      rpc++;
      used.add(rpc);
      failovers++;
      continue; // the same chunk on the next RPC; the chunks before it are kept
    }
    items.push(...got);
    start = end + 1;
  }
  return { items, rpcs: [...used].sort((a, b) => a - b), failovers };
}

/** One chunk's MissionStarted events from the portal (the same checks as readBurnsFrom: address, chain id, tier). */
export async function readMissionLogsV3(p: ethers.JsonRpcProvider, chain: ChainConfig, start: number, end: number): Promise<Burn[]> {
  const logs = await p.getLogs({ address: chain.portal, topics: [TOPIC], fromBlock: start, toBlock: end });
  const out: Burn[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== chain.portal.toLowerCase()) continue;
    const ev = iface.parseLog(log);
    if (!ev) continue;
    if (Number(ev.args.chainId) !== chain.chainId) continue;
    const tier = Number(ev.args.tier);
    if (tier > 2) continue;
    out.push({
      chainId: chain.chainId, txHash: log.transactionHash, logIndex: log.index, blockNumber: log.blockNumber, missionId: ev.args.missionId.toString(),
      pilot: ev.args.pilot, amountWei: ev.args.amount.toString(), tier, x1: new PublicKey(Buffer.from(ethers.getBytes(ev.args.x1Pubkey))).toBase58(), timestamp: Number(ev.args.timestamp),
    });
  }
  return out;
}

/** Deduplicated by (chainId, txHash, logIndex) and sorted by block and log index, as readBurnsFrom returns them. */
export function dedupeBurnsV3(burns: Burn[]): Burn[] {
  const m = new Map<string, Burn>();
  for (const b of burns) m.set(`${b.chainId}:${b.txHash}:${b.logIndex}`, b);
  return [...m.values()].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}
