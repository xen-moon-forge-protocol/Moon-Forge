/**
 * Writes test/fixtures/flow-v3-epoch2.json: a recorded `SourcesV3` run (flow-v3.ts) for epoch 2 built on the REAL
 * epoch-1.json (test/fixtures/epoch-1.json = frontend/public/epochs/epoch-1.json) with SYNTHETIC burns, markets,
 * candles and X1 readings. Real numbers (read-only probe of 2026-10-22, scratchpad/wp-oracle/clock-b2): epoch 1's
 * publish transaction, slot 86728945, published_at 1792287484, net budget 388359377, rate cap 6751, total score 63918,
 * the five chains' cursors and portals, their XEN spot prices, liquidity and total supply. Everything else is made up
 * and marked `synthetic` below. Re-run with `npx ts-node test/fixtures/make-flow-fixture.ts` after a change here.
 */
import * as fs from "fs";
import * as path from "path";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { EpochFile, toE18 } from "../../src/epoch";
import { emptyRecording, RecordedSourcesV3 } from "../../src/flow-v3";

const here = __dirname;
const epoch1: EpochFile = JSON.parse(fs.readFileSync(path.join(here, "epoch-1.json"), "utf8"));

const WEEK = 7 * 86_400;
const REAL = { publishedAt: 1_792_287_484, publishSlot: 86_728_945, publishBlockTime: 1_792_287_484, netBudget: "388359377", rateCap: "6751", dropReserve: "43151041", fullBudget: "431510418" };
// synthetic: the next build, one week and ten minutes after epoch 1's publication, on X1's clock (A8)
const endTs = REAL.publishedAt + WEEK + 600;
const snapshotSlot = 88_374_000;
const createdAt = new Date((endTs + 13) * 1000).toISOString();

const key = (tag: number, i: number) => {
  const b = new Uint8Array(32);
  b[0] = tag;
  b[1] = i;
  b[31] = 9;
  return new PublicKey(b).toBase58();
};
const sig = (i: number) => {
  const b = new Uint8Array(64);
  b[0] = i;
  b[63] = 1;
  return bs58.encode(b);
};
const XEN = 10n ** 18n;
const burn = (chainId: number, missionId: number, block: number, ts: number, xen: bigint, tier: number, x1: string, logIndex = 7) => ({
  chainId, txHash: "0x" + (chainId * 1000 + missionId).toString(16).padStart(64, "0"), logIndex, blockNumber: block, missionId: String(missionId),
  pilot: "0x" + "ab".repeat(20), amountWei: (xen * XEN).toString(), tier, x1, timestamp: ts,
});

const rec: RecordedSourcesV3 = emptyRecording();
rec.now = createdAt;
rec.snapshot.push({
  slot: snapshotSlot,
  blockTime: endTs,
  // synthetic: one FORGED Artifact (the real collection had none on 2026-10-22), to exercise the snapshot and the extra file
  records: [{ asset: key(2, 1), tier: 1, owner: key(1, 1), backing: "12500000000", origin: 0, forgedAt: REAL.publishedAt + 86_400 }],
});
rec.assetSignatures[key(2, 1)] = sig(1);
// synthetic: a 300 XNT pool (the live pool was about 7 XNT in October 2026, too small to pay more than the first burn),
// grown a little since the publication (F_build above F_ref)
rec.freePool.push({ lamports: "299600000000", slot: snapshotSlot + 1 });
rec.xnt = { twapE18: "193000000000000000", apiE18: "193400000000000000", source: "fixture (x1report-like api, XDEX twap)" };
rec.published[1] = {
  tx: epoch1.publish!.tx, slot: REAL.publishSlot, blockTime: REAL.publishBlockTime, epoch: 1, root: epoch1.root, dataHash: epoch1.dataHash, totalScore: epoch1.totalScore,
  leaves: epoch1.leaves.length, budget: REAL.fullBudget, dropReserve: REAL.dropReserve, dropSlot: String(REAL.publishSlot + 2), freePoolBefore: "300000000000",
  publishedAt: REAL.publishedAt, netBudget: REAL.netBudget, rateCap: REAL.rateCap,
};

// chains: the real cursors; synthetic heads one week of blocks later; synthetic burns with contiguous mission ids
const blocksPerWeek: Record<number, number> = { 10: 302_400, 56: 806_400, 137: 302_400, 43114: 302_400, 8453: 302_400 };
const missions: Record<number, { ids: number[]; before: string }> = { 10: { ids: [2, 3], before: "1" }, 56: { ids: [1], before: "0" }, 137: { ids: [], before: "0" }, 43114: { ids: [1], before: "0" }, 8453: { ids: [], before: "0" } };
const tiers: Record<number, number[]> = { 10: [0, 1], 56: [2], 43114: [0] };
// synthetic X1 wallets: wallet 3 burns on two chains (Optimism Orbit, BSC Moon Landing); the Avalanche burner is alone
const wallets: Record<number, number[]> = { 10: [2, 3], 56: [3], 43114: [4] };
// synthetic amounts: the Avalanche burn (50 million XEN, about $0.0013) is a dust leaf, paid but under the keeper-tip minimum
const amounts: Record<number, bigint[]> = { 10: [120_000_000n, 300_000_000n], 56: [2_000_000_000n], 43114: [50_000_000n] };
for (const c of epoch1.chains) {
  const from = c.toBlock;
  const to = from + blocksPerWeek[c.chainId];
  rec.finalHead[c.chainId] = to;
  const m = missions[c.chainId];
  const burns = m.ids.map((id, i) => burn(c.chainId, id, from + 1000 + i * 90_000, REAL.publishedAt + 86_400 * (1 + i * 2) + 3600 * (c.chainId % 7), amounts[c.chainId][i], tiers[c.chainId][i], key(1, wallets[c.chainId][i]), 7 + i));
  rec.readChain[`${c.chainId}:${from}:${to}`] = { burns, totalMissions: String(m.ids.length ? m.ids[m.ids.length - 1] : Number(m.before)), totalMissionsBefore: m.before };
  rec.market[c.chainId] = { refUsd: c.xenUsd, spotUsd: c.xenUsd, liquidityUsd: Number(BigInt(c.liquidityUsdMicro)) / 1e6, topPool: c.pools[0].address, xenIsBase: true, pools: c.pools };
  rec.totalSupply[`${c.chainId}:${to}`] = c.totalSupply;
  // synthetic candles: 24 closes within ±3% of the spot; the Avalanche burn has none (fallback price)
  for (const b of burns) {
    const h = Math.floor(b.timestamp / 3600) * 3600;
    if (c.chainId !== 43114) rec.xenCloses[`${c.chainId}:${h}`] = Array.from({ length: 24 }, (_, i) => toE18(c.xenUsd * (1 + ((i % 7) - 3) / 100)));
    rec.xntCloses[h] = Array.from({ length: 24 }, (_, i) => toE18(0.19 + ((i % 5) - 2) / 1000));
  }
}

const out = path.join(here, "flow-v3-epoch2.json");
fs.writeFileSync(out, JSON.stringify({ about: "recorded SourcesV3 run for epoch 2 on the real epoch-1.json; see make-flow-fixture.ts for what is real and what is synthetic", recording: rec }, null, 2));
console.log(`wrote ${out}`);
