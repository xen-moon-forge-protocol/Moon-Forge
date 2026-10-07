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

export async function finalHead(chain: ChainConfig): Promise<number> {
  const p = new ethers.JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true });
  const head = await withRetry(() => p.getBlockNumber(), `${chain.name} head`);
  return Math.max(0, head - chain.confirmations);
}

/** Reads every MissionStarted in (fromBlock, toBlock]. Throws instead of skipping. */
export async function readBurns(chain: ChainConfig, fromBlockExclusive: number, toBlock: number): Promise<Burn[]> {
  const p = new ethers.JsonRpcProvider(chain.rpc, chain.chainId, { staticNetwork: true });
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
      if (chunk > 50 && /range|limit|too large|too many|413|-32614|-32005|exceed/i.test(msg)) {
        chunk = Math.max(50, Math.floor(chunk / 2));
        continue; // retry the same start with a smaller window
      }
      logs = await withRetry(
        () => p.getLogs({ address: chain.portal, topics: [TOPIC], fromBlock: start, toBlock: end }),
        `${chain.name} logs ${start}-${end}`,
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
