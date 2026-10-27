/**
 * Moon Forge oracle v2 — CLI
 *
 *   npm run epoch              build + write + publish the next epoch, then auto-claim it
 *   npm run epoch -- --dry     build and print, publish nothing
 *   npm run claim -- <file>    (re)submit pending claims of an epoch file
 *   npm run keeper             loop: settle bets, jackpots and lotteries; claim pending leaves;
 *                              seal and deliver Forge Drops; pay back refunded rounds; expire epochs
 *   npm run verify -- <file>   anyone: recompute an epoch file and compare with X1 on-chain data
 *
 * The oracle is stateless: its only memory is the epoch files in EPOCHS_DIR
 * (committed to git and served by GitHub Pages). Epoch N reads EVM blocks right after
 * epoch N-1's `toBlock` for every chain, so no block is ever skipped or read twice.
 *
 * Rewards v3 (amendment A11, from the switch epoch on: REWARDS_VERSION=3 or V3_FIRST_EPOCH, or a v3 previous file):
 *   npm run epoch -- --dry --record <file>   dry build that also records every source answer as a replayable fixture
 *   npm run verify -- <file> [--full]        dispatches by version (v2, v3, extra); --full re-reads logs, counters, snapshot time
 *   npm run sweep                            close_receipt sweep of expired epochs (rent back to the oracle)
 *   ts-node src/index.ts rebuild-extra <n>   A13.7: rebuild a lost extra-<n>.json from epoch-<n>.json, extra-<n−1>.json
 *                                            and X1 reads at the recorded snapshot slot; refused on a data-hash mismatch
 * The v2 path above stays byte-for-byte as it is before the switch (runEpochV3 / verifyV3 below).
 *
 *   npm run feed -- --out <file> [--prev-feed <file>]
 *                              the hourly week-so-far feed v1 of the epoch being built (feed-v3.ts; read-only, no key);
 *                              writes nothing (active=false) under the v2 rules or before the upgraded binary is detected
 */
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { CHAINS, EPOCHS_DIR, PROGRAM_ID, RATE_CAP_K } from "./config";
import { Burn, finalHead, portalCountersV3, readBurns, readChainV3 } from "./evm";
import { baseScore, buildTree, ChainSnapshot, computeLeaves, dataHash, eligibleHolders, EpochBody, EpochFile, epochRateCap, toE18, verifyEpochFile } from "./epoch";
import { burnTimePrice, clamp, median, xenMarket, xenTotalSupply, xntUsd } from "./pricing";
import { artifactSnapshot, claimAll, connect, deliverDrops, fetchConfig, keeperPass, loadKeypair, nextDeadline, PDA, publishEpoch, sealDrop } from "./x1";
import { AnyEpochFile, anomalyGateV3, EpochFileV3, isHeartbeatV3, MIN_EPOCH_INTERVAL, provisionalReasonOf, verifyAny, verifyChainLinkV3, verifyChainSetV3, verifyPublishedV3, verifySnapshotTimeV3 } from "./rewards";
import { baseNftTermsError, ExtraFileV1, preUpgradePotError, verifyExtraChainLink, verifyExtraFile, verifyPublishedExtra } from "./extra";
import { execFileSync } from "child_process";
import {
  assembleInputsV3, AssembledV3, buildExtraAfterBaseV3, buildV3, burnEvent, catchUpExtrasV3, claimPlanV3, durableExtraErrorV3, emptyRecording, extraCreatedAtV3, extraFirstEpochV3,
  extraInitV3, extraOpenV3, extraPoolV3, publishExtraRefusalsV3,
  keeperFilesV3, lastMissionIds, missionContinuity, NotDueV3, postPublishReport, publishDecisionV3, publishGateV3, publishRecordV3, readPublishClockV3, rebuildExtraV3,
  recordingSources, refreshSnapshotIfOldV3, rewardsVersionGatedV3, V2_CLOSED_TEXT, baseDueAfterExtraV3, EXTRA_LAG_MARGIN, SnapshotReadV3, SourcesV3, staleEpochs, toPublishedEpochV3, withRetries,
  gateDecisionV3, gateHoldsV3, gateRecordOf, GateRecordV3, PriceSidecarV3, verifyPriceSidecarV3, heartbeatAllowedV3,
} from "./flow-v3";
import * as os from "os";
import { ExtraPotRunV3, extraPotRunV3, liveExtraPotReadsV3, liveExtraRecoveryV3, liveSourcesV3 } from "./sources-v3";
import {
  claimLeavesV3, connectV3, ExtraNotYetV3, freePoolV3, PDA_V3, publishEpochV3, publishExtraEpochV3, readEpochPublishedV3, readExtraPublishedV3, readUpgradeProbeV3, sweepReceiptsV3, upgradeVerdictV3,
  UPGRADED_ELF, verifyExtraInitV3,
} from "./x1-v3";
import { assembleWeekSoFarV3, engineSha256Of, feedGateV3, feedText, fetchFeedV1, knownReadingsOfFeedV1, samplesOfFeedV1 } from "./feed-v3";
import { countersMissingV3, rulesInForceErrorV3 } from "./rules-v3";
import { seatStatusCli, takeSeatCli, voidEpochCli } from "./seat-v3";
import {
  anchorsForRoleV3, armKeeperCli, CLAIM_HOLD, HOUSE_TICK_MS, houseDueV3, KeeperChains, keeperModeV3, KeeperModeV3, keeperPassV3, newMemoV3, nextDeadlineV3, readOracleSeatLivenessV3, RoleV3,
  takeKeeperCli,
} from "./keeper-v3";

const file = (n: number) => path.join(EPOCHS_DIR, `epoch-${n}.json`);
const extraFile = (n: number) => path.join(EPOCHS_DIR, `extra-${n}.json`);
/** D-17: the anomaly gate's hold record of epoch n (public, next to the epoch files; never read as an epoch file) */
const gateFile = (n: number) => path.join(EPOCHS_DIR, "gate", `epoch-${n}.json`);
function readGate(n: number): GateRecordV3 | null {
  try {
    return fs.existsSync(gateFile(n)) ? gateRecordOf(JSON.parse(fs.readFileSync(gateFile(n), "utf8"))) : null;
  } catch {
    return null;
  }
}
function writeGate(r: GateRecordV3) {
  fs.mkdirSync(path.dirname(gateFile(r.epoch)), { recursive: true });
  fs.writeFileSync(gateFile(r.epoch), JSON.stringify(r, null, 2));
}
/** GATE_BLOCK (a repository variable): a hold that ran out stays held until an operator clears it */
const gateBlocked = () => process.env.GATE_BLOCK === "true";

function readEpoch(n: number): EpochFile | null {
  return fs.existsSync(file(n)) ? JSON.parse(fs.readFileSync(file(n), "utf8")) : null;
}

// ── v3 (A11) file helpers: the same files, read as any version ──────────────────────────────────
function readEpochAny(n: number): AnyEpochFile | null {
  return fs.existsSync(file(n)) ? JSON.parse(fs.readFileSync(file(n), "utf8")) : null;
}

/** Every local epoch file (published or not), any version, by epoch, from `dir` (EPOCHS_DIR by default). */
function readAllEpochsAny(dir = EPOCHS_DIR): AnyEpochFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^epoch-\d+\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as AnyEpochFile)
    .sort((a, b) => a.epoch - b.epoch);
}

function readExtra(n: number): ExtraFileV1 | null {
  return fs.existsSync(extraFile(n)) ? JSON.parse(fs.readFileSync(extraFile(n), "utf8")) : null;
}

const argValue = (k: string): string | undefined => (process.argv.indexOf(k) > 0 ? process.argv[process.argv.indexOf(k) + 1] : undefined);

/** Every published epoch file (the keeper claims and delivers drops for the open ones). */
function readAllEpochs(): EpochFile[] {
  if (!fs.existsSync(EPOCHS_DIR)) return [];
  return fs.readdirSync(EPOCHS_DIR)
    .filter((f) => /^epoch-\d+\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(EPOCHS_DIR, f), "utf8")) as EpochFile)
    .filter((e) => e.publish)
    .sort((a, b) => a.epoch - b.epoch);
}

function writeIndex() {
  const files = fs.readdirSync(EPOCHS_DIR).filter((f) => /^epoch-\d+\.json$/.test(f));
  const epochs = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(EPOCHS_DIR, f), "utf8")) as EpochFile)
    .filter((e) => e.publish)
    .sort((a, b) => a.epoch - b.epoch)
    .map((e) => ({ epoch: e.epoch, root: e.root, dataHash: e.dataHash, leaves: e.leaves.length, totalScore: e.totalScore, tx: e.publish!.tx, createdAt: e.createdAt }));
  fs.writeFileSync(path.join(EPOCHS_DIR, "index.json"), JSON.stringify({ programId: PROGRAM_ID, epochs }, null, 2));
}

/**
 * R-3: the W2-4 verdict of the live program, read once from the default endpoint (readUpgradeProbeV3 never uses an
 * X1_RPC_URLS entry) at "finalized"; any read error is "unknown". Read-only.
 */
async function liveVerdictV3(): Promise<{ status: "upgraded" | "legacy" | "unknown"; reasons: string[] }> {
  const v3 = connectV3();
  try {
    return upgradeVerdictV3(await readUpgradeProbeV3(v3.connection, "finalized"), v3.program);
  } catch (e) {
    return { status: "unknown", reasons: [`RPC error: ${String((e as Error)?.message ?? e).slice(0, 160)}`] };
  }
}

const WEEK = 7 * 86_400;
const SUNDAY_0 = 3 * 86_400; // 1970-01-04 00:00 UTC, the first Sunday of Unix time
/** An epoch is due once per weekly slot (Sundays 00:00 UTC): the slot started less than two days ago and
 *  nothing was published since it started. The program itself enforces >= 6 days between epochs. */
export function epochDue(lastPublishTs: number, now = Math.floor(Date.now() / 1000)): boolean {
  const slot = now - ((now - SUNDAY_0) % WEEK);
  return now - slot < 2 * 86_400 && lastPublishTs < slot;
}

async function runEpoch(dry: boolean) {
  fs.mkdirSync(EPOCHS_DIR, { recursive: true });
  const signer = dry ? undefined : loadKeypair();
  const { connection, program } = connect(signer);
  const cfg = await fetchConfig(program);
  const onChainLast = Number(cfg.lastEpoch);
  if (!dry && !epochDue(Number(cfg.lastPublishTs))) {
    console.log(`not due: epoch ${onChainLast} was published ${new Date(Number(cfg.lastPublishTs) * 1000).toISOString()}; the next weekly slot has not started`);
    return;
  }
  const prev = onChainLast > 0 ? readEpoch(onChainLast) : null;
  if (onChainLast > 0 && !prev) throw new Error(`epoch-${onChainLast}.json missing locally — restore it from git before continuing`);
  const n = onChainLast + 1;
  // v3 (A11): from the switch epoch on (REWARDS_VERSION / V3_FIRST_EPOCH, or a v3 previous file) the v3 flow runs;
  // the v2 path below stays exactly as it is before it
  // (IDL split, W2-4: the v3 flow runs on the upgraded program's IDL; the v2 lines below keep the live one)
  // R-3: gated by the live program's verdict (read once, default endpoint, finalized): v3 only on the upgraded binary
  // (by detection when nothing is pinned), v2 with a warning while S6 is late, a refusal for a v2 epoch on the
  // upgraded binary or for v3 on an unknown verdict (rewardsVersionGatedV3)
  const gated = rewardsVersionGatedV3(n, prev, (await liveVerdictV3()).status);
  if (gated.warning) console.log(`::warning::${gated.warning}`);
  // C-14 (r4-fix): from the v2 boundary no v2 epoch is built or published, even while S6 is late
  if (gated.v2Closed) {
    console.log(`${V2_CLOSED_TEXT}: epoch ${n} is not built under the v2 rules (nothing published)`);
    return;
  }
  if (gated.version === 3) {
    const v3 = connectV3(signer);
    return runEpochV3(dry, v3.connection, v3.program, signer, n, onChainLast > 0 ? readEpochAny(onChainLast) : null);
  }
  const recent = [1, 2, 3, 4].map((k) => (onChainLast - k + 1 > 0 ? readEpoch(onChainLast - k + 1) : null)).filter((e): e is EpochFile => !!e);
  console.log(`Building epoch ${n} (on-chain last = ${onChainLast})`);

  const chains: ChainSnapshot[] = [];
  const burns: Burn[] = [];
  for (const c of CHAINS) {
    if (!c.portal) continue;
    const prevChain = prev?.chains.find((x) => x.chainId === c.chainId);
    const from = prevChain ? prevChain.toBlock : Math.max(0, c.startBlock - 1);
    const to = await finalHead(c);
    if (to <= from) {
      // nothing new on this chain: carry the cursor and market reference forward
      chains.push({
        chainId: c.chainId, name: c.name, portal: c.portal, fromBlockExclusive: from, toBlock: from,
        xenUsd: prevChain?.xenUsd ?? 0, xenUsdE18: prevChain?.xenUsdE18 ?? "0", priceSource: prevChain?.priceSource ?? "", clamped: false,
        liquidityUsdMicro: prevChain?.liquidityUsdMicro ?? "0", pools: prevChain?.pools ?? [], totalSupply: prevChain?.totalSupply ?? "0",
      });
      continue;
    }
    // Each XEN contract is valued on its own market: spot + liquidity now, median price at each burn hour.
    const market = await xenMarket(c);
    // clamp reference: median of this chain's reference over the last 4 epochs (cannot be ratcheted
    // up 50% per epoch); a chain's first epoch uses the aggregator's token price
    const history = recent.map((e) => e.chains.find((x) => x.chainId === c.chainId)?.xenUsd ?? 0);
    const reference = median(history) || market.refUsd;
    const spot = clamp({ usd: market.spotUsd, source: `reserve-weighted spot of ${market.pools.length} eligible pools` }, reference);
    const b = await readBurns(c, from, to);
    for (const burn of b) {
      const p = clamp(await burnTimePrice(c, market, burn.timestamp), reference);
      burn.priceE18 = toE18(p.usd);
      burn.priceSource = p.source;
      burn.clamped = !!p.clamped;
    }
    const totalSupply = await xenTotalSupply(c, to).catch(() => "0");
    console.log(`  ${c.name}: blocks ${from + 1}..${to}, ${b.length} burns, XEN spot $${spot.usd}, liquidity $${Math.round(market.liquidityUsd)}`);
    burns.push(...b);
    chains.push({
      chainId: c.chainId, name: c.name, portal: c.portal, fromBlockExclusive: from, toBlock: to,
      xenUsd: spot.usd, xenUsdE18: toE18(spot.usd), priceSource: spot.source, clamped: !!spot.clamped,
      liquidityUsdMicro: BigInt(Math.floor(market.liquidityUsd * 1e6)).toString(), pools: market.pools, totalSupply,
    });
  }
  const xnt = clamp(await xntUsd(), prev?.xnt.usd);
  const snapshot = await artifactSnapshot(connection, program);
  const artifacts = { ...snapshot, eligible: eligibleHolders(snapshot.holders, prev?.artifacts.holders) };
  const leaves = computeLeaves(burns, chains, artifacts.eligible);
  if (leaves.length === 0) {
    console.log("No burns with value in this period — nothing to publish.");
    return;
  }
  const { root, proofs, totalScore } = buildTree(n, leaves);
  const kBps = Math.round(RATE_CAP_K * 10_000);
  const body: EpochBody = {
    version: 2, programId: PROGRAM_ID, epoch: n, createdAt: new Date().toISOString(), chains,
    xnt: { usd: xnt.usd, usdE18: toE18(xnt.usd), source: xnt.source }, kBps,
    rateCap: epochRateCap(kBps, toE18(xnt.usd), baseScore(burns, chains), BigInt(totalScore)).toString(), artifacts, burns, leaves, totalScore, root,
  };
  const f: EpochFile = { ...body, dataHash: dataHash(body), proofs };
  const errs = verifyEpochFile(f);
  if (errs.length) throw new Error("self-verification failed: " + errs.join("; "));
  console.log(`  ${leaves.length} leaves, total score ${totalScore}, root ${root}`);
  if (dry) {
    console.log(JSON.stringify({ ...f, proofs: undefined }, null, 2).slice(0, 4000));
    return;
  }
  // Write BEFORE publishing: an on-chain epoch must always have its public data file.
  fs.writeFileSync(file(n), JSON.stringify(f, null, 2));
  const tx = await publishEpoch(program, signer!, f);
  const ep: any = await (program.account as any).epoch.fetch(PDA.epoch(n));
  f.publish = { tx, slot: await connection.getSlot(), budget: ep.budget.toString() };
  fs.writeFileSync(file(n), JSON.stringify(f, null, 2));
  writeIndex();
  console.log(`  published: ${tx} (budget ${ep.budget.toString()} + drop reserve ${ep.dropReserve.toString()} lamports)`);
  // the drop seed must be read within ~512 slots of publication: seal it now
  await sealDrop(program, signer!, n);
  const claimed = await claimAll(connection, program, signer!, f);
  console.log(`  auto-claimed ${claimed}/${leaves.length}`);
  console.log(`  Forge Drops delivered: ${await deliverDrops(connection, program, signer!, f)}`);
}

async function verify(p: string) {
  // v3 (A11): dispatch by version; an extra file by its kind. The v2 rules below verify v2 files forever.
  const any = JSON.parse(fs.readFileSync(p, "utf8"));
  if (any && any.kind === "extra") return verifyExtraV3(p, any as ExtraFileV1);
  if (any && any.version === 3) return verifyV3(p, any as EpochFileV3, process.argv.includes("--full"));
  const f: EpochFile = JSON.parse(fs.readFileSync(p, "utf8"));
  const prevPath = path.join(path.dirname(p), `epoch-${f.epoch - 1}.json`);
  const previous = f.epoch > 1 && fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, "utf8")) : undefined;
  const errors = verifyEpochFile(f, previous);
  if (f.epoch > 1 && !previous) console.log(`(epoch-${f.epoch - 1}.json not found next to it: boost eligibility checked against this snapshot only)`);
  const { program } = connect();
  const ep: any = await (program.account as any).epoch.fetchNullable(PDA.epoch(f.epoch));
  if (!ep) errors.push("epoch not found on-chain");
  else {
    if (Buffer.from(ep.root).toString("hex") !== f.root) errors.push("on-chain root differs");
    if (Buffer.from(ep.dataHash).toString("hex") !== f.dataHash) errors.push("on-chain data hash differs");
    if (ep.totalScore.toString() !== f.totalScore) errors.push("on-chain total score differs");
    if (ep.rateCap.toString() !== f.rateCap) errors.push("on-chain rate cap differs");
  }
  if (process.argv.includes("--full")) {
    for (const c of f.chains) {
      if (c.toBlock <= c.fromBlockExclusive) continue;
      const chain = CHAINS.find((x) => x.chainId === c.chainId);
      if (!chain) continue;
      const again = await readBurns({ ...chain, portal: c.portal }, c.fromBlockExclusive, c.toBlock);
      // compare the on-chain event fields only (prices are market data recorded by the oracle)
      const mine = f.burns.filter((b) => b.chainId === c.chainId).map(({ priceE18, priceSource, clamped, ...ev }) => ev);
      if (JSON.stringify(again) !== JSON.stringify(mine)) errors.push(`${c.name}: burns differ from chain logs`);
    }
  }
  if (errors.length) {
    console.error("❌ VERIFICATION FAILED\n - " + errors.join("\n - "));
    process.exit(1);
  }
  console.log(`✅ epoch ${f.epoch} verified: ${f.leaves.length} leaves, root ${f.root}`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (cmd === "epoch") return runEpoch(process.argv.includes("--dry"));
  if (cmd === "verify") return verify(arg);
  if (cmd === "feed") return weekSoFarCli();
  if (cmd === "due") {
    // Used by the keeper workflow as a backup to the oracle's own weekly schedule (GitHub may delay or skip cron runs).
    const { program } = connect();
    let due = epochDue(Number((await fetchConfig(program)).lastPublishTs));
    // R-2: on the upgraded binary the base epoch also waits for the last paying extra's interval (runEpochV3); on the
    // live v2 binary there is no ExtraState and nothing changes
    // C-14 (r4-fix): from the v2 boundary, while the live program is not the upgraded one, no v2 epoch is due
    if (due) {
      try {
        const cfgD = await fetchConfig(program);
        const lastD = Number(cfgD.lastEpoch);
        const g = rewardsVersionGatedV3(lastD + 1, lastD > 0 ? readEpochAny(lastD) : null, (await liveVerdictV3()).status);
        if (g.v2Closed) {
          due = false;
          console.log(`${V2_CLOSED_TEXT} (epoch ${lastD + 1} is not due under the v2 rules; it waits for S6)`);
        }
      } catch {
        /* a refused selection (R-3) or a read error: the epoch run itself reports it, as before */
      }
    }
    if (due) {
      const v3 = connectV3();
      const r = await extraIntervalReadyV3(v3.connection, v3.program).catch(() => null);
      if (r && r.now < r.ready - EXTRA_LAG_WAIT_MAX) {
        due = false;
        console.log(`the last paying extra epoch landed ${r.now - r.last} s ago: the base epoch waits until ${new Date(r.ready * 1000).toISOString()} (R-2)`);
      }
      // D-17: an epoch held by the anomaly gate is not dispatched again before its hold runs out (or while GATE_BLOCK holds
      // it). Only a v3 run writes a hold record; any read error here leaves the answer as it was (the v2 path unchanged)
      try {
        const n = Number((await fetchConfig(program)).lastEpoch) + 1;
        const g = readGate(n);
        if (g && !g.released) {
          const now = await chainNow(v3.connection).catch(() => Math.floor(Date.now() / 1000));
          if (gateHoldsV3(g, n, now) || (gateBlocked() && now >= g.until)) {
            due = false;
            console.log(`epoch ${n} is held by the anomaly gate ${gateBlocked() && now >= g.until ? "(GATE_BLOCK)" : `until ${new Date(g.until * 1000).toISOString()}`}: ${g.reasons.map((x) => x.code).join(", ")}`);
          }
        }
      } catch {
        /* no gate answer: as before */
      }
    }
    console.log(due ? "epoch due" : "epoch not due");
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\n`);
    return;
  }
  if (cmd === "claim") {
    const signer = loadKeypair();
    const { connection, program } = connect(signer);
    const f: EpochFile = JSON.parse(fs.readFileSync(arg, "utf8"));
    if ((f as unknown as EpochFileV3).version === 3) {
      // v3 (A11): every leaf, dust included; a v3 epoch has no drops (A13.1)
      const v3 = f as unknown as EpochFileV3;
      const v3c = connectV3(signer);
      const c = await claimLeavesV3(v3c.connection, v3c.program, signer, v3);
      console.log(`claimed ${c.claimed} (${c.tipped} with a keeper tip, ${c.dust} dust, ${c.failed} failed)${c.stopped ? `; stopped: ${c.stopped}` : ""}`);
      return;
    }
    console.log(`claimed ${await claimAll(connection, program, signer, f)}`);
    console.log(`drops delivered ${await deliverDrops(connection, program, signer, f)}`);
    return;
  }
  if (cmd === "rebuild-extra") return rebuildExtraCli(Number(arg));
  if (cmd === "publish-extra") return publishExtraCli(arg === undefined ? null : Number(arg));
  if (cmd === "sweep") {
    // v3 (A11, SPEC-v3 §7 step 7): close the claim receipts of expired epochs, so their rent comes back
    const signer = loadKeypair();
    const { connection, program } = connectV3(signer);
    console.log(`closed ${await sweepReceiptsV3(connection, program, signer)} receipts`);
    return;
  }
  if (cmd === "init") {
    // Permissionless one-time setup after the v2 upgrade: config + vaults, Core collection,
    // sweep of the dead v1 accounts. Any funded key can run it; values are program constants.
    const signer = loadKeypair();
    const { connection, program } = connect(signer);
    const { SystemProgram } = await import("@solana/web3.js");
    const pda = (s: string) => PublicKey.findProgramAddressSync([Buffer.from(s)], program.programId)[0];
    if (!(await connection.getAccountInfo(PDA.config()))) {
      const tx = await program.methods.initializeV2().accountsPartial({
        config: PDA.config(), rewardVault: PDA.rewardVault(), bankrollVault: PDA.bankrollVault(), drawVault: PDA.drawVault(),
        collection: PDA.collection(), artifactAuthority: pda("artifact_authority"), payer: signer.publicKey, systemProgram: SystemProgram.programId,
      }).signers([signer]).rpc();
      console.log("initialize_v2:", tx);
    }
    if (!(await connection.getAccountInfo(PDA.collection()))) {
      const tx = await program.methods.initArtifacts().accountsPartial({
        config: PDA.config(), collection: PDA.collection(), artifactAuthority: pda("artifact_authority"), payer: signer.publicKey,
        coreProgram: new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"), systemProgram: SystemProgram.programId,
      }).signers([signer]).rpc();
      console.log("init_artifacts:", tx);
    }
    const tx = await program.methods.sweepLegacy().accountsPartial({ config: PDA.config(), rewardVault: PDA.rewardVault() }).signers([signer]).rpc();
    console.log("sweep_legacy:", tx);
    return;
  }
  if (cmd === "refresh-collection") {
    // Permissionless and idempotent: points the Artifact collection at METADATA_BASE_URI (a program constant).
    const signer = loadKeypair();
    const { program } = connect(signer);
    const { SystemProgram } = await import("@solana/web3.js");
    const tx = await program.methods.refreshCollectionUri().accountsPartial({
      config: PDA.config(), collection: PDA.collection(),
      artifactAuthority: PublicKey.findProgramAddressSync([Buffer.from("artifact_authority")], program.programId)[0],
      payer: signer.publicKey, coreProgram: new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"), systemProgram: SystemProgram.programId,
    }).signers([signer]).rpc();
    console.log("refresh_collection_uri:", tx);
    return;
  }
  if (cmd === "propose-oracle" || cmd === "accept-oracle") {
    // Two-step hand-over of the oracle role (see OPERATORS.md). propose-oracle <new pubkey> is signed by the
    // current oracle (ORACLE_PRIVATE_KEY); accept-oracle is signed by the new key (NEW_ORACLE_PRIVATE_KEY).
    const signer = loadKeypair(cmd === "accept-oracle" ? process.env.NEW_ORACLE_PRIVATE_KEY : undefined);
    const { program } = connect(signer);
    const accounts = { config: PDA.config(), signer: signer.publicKey };
    const tx = cmd === "propose-oracle"
      ? await program.methods.proposeOracle(new PublicKey(arg)).accountsPartial(accounts).signers([signer]).rpc()
      : await program.methods.acceptOracle().accountsPartial(accounts).signers([signer]).rpc();
    const cfg = await fetchConfig(program);
    console.log(`${cmd}: ${tx}\n  oracle  ${cfg.oracle.toBase58()}\n  pending ${cfg.pendingOracle.toBase58()}`);
    return;
  }
  if (cmd === "keeper-arm") {
    // S7 owner step (SPEC 9.3): the first arm_keeper of the house-keeper seat, with its bond, on a chain this key derives
    // (keeper-v3.ts), so every keeper run holding the key can reveal it. Dry without --yes. Signed by KEEPER_PRIVATE_KEY
    // (else ORACLE_PRIVATE_KEY): the program's INITIAL_KEEPER for the first arm.
    const signer = loadKeypair(process.env.KEEPER_PRIVATE_KEY || undefined);
    const v3 = connectV3(signer);
    const dep = argValue("--deposit");
    await armKeeperCli(v3.connection, v3.program, signer, dep === undefined ? NaN : Number(dep), process.argv.includes("--yes"));
    return;
  }
  if (cmd === "keeper-take") {
    // R-4 owner step: take_keeper by the named successor (after KEEPER_NOTICE) or anyone once the seat is dead, on a
    // chain this key derives, so the keeper runs holding this key can reveal it. Dry without --yes. KEEPER_PRIVATE_KEY.
    const signer = loadKeypair(process.env.KEEPER_PRIVATE_KEY || undefined);
    const v3 = connectV3(signer);
    const dep = argValue("--deposit");
    await takeKeeperCli(v3.connection, v3.program, signer, dep === undefined ? NaN : Number(dep), process.argv.includes("--yes"));
    return;
  }
  if (cmd === "seat" || cmd === "void-epoch" || cmd === "take-seat") return seatCli(cmd, arg);
  if (cmd === "keeper") {
    const signer = loadKeypair();
    const { connection, program } = connect(signer);
    // --once: a single pass. --for <seconds>: loop at least that long. --max <seconds>: then keep looping while
    // some time-sensitive upkeep falls due before that limit (a Prediction lock, a draw, a Moon Wars turn), so
    // a scheduled run that starts early still does the work on time. When it stops at --max with work still
    // due within a day, it reports more=true so the workflow can start the next run.
    const once = process.argv.includes("--once");
    const arg = (k: string) => (process.argv.indexOf(k) > 0 ? Number(process.argv[process.argv.indexOf(k) + 1]) : null);
    const start = Date.now();
    const minUntil = arg("--for") !== null ? start + arg("--for")! * 1000 : Infinity;
    const maxUntil = arg("--max") !== null ? start + arg("--max")! * 1000 : minUntil;
    let more = false;
    // W2-4: the v3 keeper (keeper-v3.ts) runs only once the upgraded binary is detected on chain; until then every pass
    // below is the v2 pass exactly as on main. The probe is read before each pass (an RPC error keeps the last mode).
    const v3c = connectV3(signer);
    const chains = new KeeperChains(signer);
    const memo = newMemoV3();
    let mode: KeeperModeV3 = "v2";
    /** the role of this key in the last v3 pass (the 5-s check anchors only for a role that anchors; anchorsForRoleV3) */
    let lastRole: RoleV3 = "no-seat";
    for (;;) {
      // read-only; any failure of the probe itself keeps the current mode (v2 until the upgrade is seen)
      const probed: Awaited<ReturnType<typeof keeperModeV3>> | null = await keeperModeV3(v3c.connection, v3c.program, mode).catch(() => null);
      if (probed && probed.mode !== mode) console.log(probed.mode === "v3" ? "the upgraded program is live (W2-4): running the v3 keeper" : `back to the v2 keeper (${probed.verdict.status}: ${probed.verdict.reasons.join("; ")})`);
      if (probed) mode = probed.mode;
      if (mode === "v3") {
        const anyFiles = readAllEpochsAny();
        const onChainLast = await fetchConfig(v3c.program).then((c) => Number(c.lastEpoch)).catch(() => null);
        const files = (onChainLast === null ? anyFiles.filter((f) => !!f.publish) : keeperFilesV3(anyFiles, onChainLast)) as unknown as EpochFile[];
        const extras = fs.existsSync(EPOCHS_DIR)
          ? fs.readdirSync(EPOCHS_DIR).filter((f) => /^extra-\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(EPOCHS_DIR, f), "utf8")) as ExtraFileV1)
          : [];
        // a Jackpot drawn in the last 10 minutes of a run could not be settled by it (the settle must land within 512 slots)
        const allowDraw = once || Date.now() < maxUntil - 600_000;
        await keeperPassV3(v3c.connection, v3c.program, signer, console.log, { epochFiles: files, extraFiles: extras, chains, memo, allowDraw }).then((r) => void (lastRole = r.role)).catch((e) => console.error(e));
        if (once) return;
        const t = Date.now();
        if (t >= minUntil) {
          const next = await nextDeadlineV3(v3c.connection, v3c.program, Math.floor(Date.now() / 1000), signer.publicKey).catch(() => ({ at: null, reasons: [] as string[] }));
          if (next.at === null) break;
          if (next.at * 1000 > maxUntil || t >= maxUntil) {
            more = next.at * 1000 - t < 86_400_000;
            if (more) console.log(`  next upkeep at ${new Date(next.at * 1000).toISOString()} (${next.reasons.join(", ")}): handing over to the next run`);
            break;
          }
          if (t % 600_000 < 15_000) console.log(`  waiting for ${next.reasons.join(", ")} at ${new Date(next.at * 1000).toISOString()}`);
        }
        // R-1: the house duty has its own HOUSE_TICK_MS timer between two full passes, so a Jackpot round drawn by
        // anyone (draw_jackpot is permissionless at end_ts) is settled within seconds, not a pass later. The house-only
        // pass sends nothing unless a round is DRAWING or a bet waits (the holder settles its bets at once anyway).
        // Round 4 (review F1): a keeper bet waiting for its anchor is due too (an unanchored bet whose block leaves
        // SlotHashes is refunded in full from the keeper bond); a holder that cannot derive its chain never anchors.
        for (let waited = 0; waited < 15_000; waited += HOUSE_TICK_MS) {
          await new Promise((r) => setTimeout(r, HOUSE_TICK_MS));
          if (waited + HOUSE_TICK_MS >= 15_000) break;
          const due = await houseDueV3(v3c.connection, v3c.program, anchorsForRoleV3(lastRole)).catch(() => false);
          if (due) await keeperPassV3(v3c.connection, v3c.program, signer, console.log, { chains, memo, allowDraw, houseOnly: true }).then((r) => void (lastRole = r.role)).catch((e) => console.error(e));
        }
        continue;
      }
      // A12 (P3, v3 only): a file the program has published counts even when its publish record is missing (a
      // confirmation timeout), so its leaves are claimed and its gated seed is never sealed by default. Without a v3
      // file the keeper reads exactly what it reads today.
      const anyFiles = readAllEpochsAny();
      const v3 = anyFiles.some((x) => x.version === 3);
      const onChain = v3 ? await fetchConfig(program).then((c) => Number(c.lastEpoch)).catch(() => null) : null;
      const keeperFiles = v3 && onChain !== null ? (keeperFilesV3(anyFiles, onChain) as unknown as EpochFile[]) : readAllEpochs();
      await keeperPass(connection, program, signer, console.log, keeperFiles).catch((e) => console.error(e));
      if (once) return;
      const t = Date.now();
      if (t >= minUntil) {
        const next = await nextDeadline(program, Math.floor(Date.now() / 1000), keeperFiles).catch(() => ({ at: null, reasons: [] as string[] }));
        if (next.at === null) break;
        if (next.at * 1000 > maxUntil || t >= maxUntil) {
          more = next.at * 1000 - t < 86_400_000;
          if (more) console.log(`  next upkeep at ${new Date(next.at * 1000).toISOString()} (${next.reasons.join(", ")}): handing over to the next run`);
          break;
        }
        if (t % 600_000 < 15_000) console.log(`  waiting for ${next.reasons.join(", ")} at ${new Date(next.at * 1000).toISOString()}`);
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `more=${more}\n`);
    return;
  }
  console.log("usage: epoch [--dry] [--record <fixture>] | due | verify <file> [--full] | claim <file> | sweep | rebuild-extra <n> | publish-extra [<n>] | keeper [--once | --for <seconds>] | keeper-arm --deposit <XNT> [--yes] | keeper-take --deposit <XNT> [--yes] | refresh-collection | propose-oracle <pubkey> | accept-oracle | seat | void-epoch <n> [--extra] [--as <pubkey>] [--yes] [--even-if-ours] | take-seat --hot <pk> --cold <pk> --refund <pk> [--as <pubkey>] [--yes]");
}

/**
 * Round 4 (quiet-month seat default): the oracle seat's client (seat-v3.ts). `seat` is read-only; `void-epoch` and
 * `take-seat` decide, build and simulate the transaction (a dry run) and send it only with --yes. Their keys are their
 * own (VOIDER_PRIVATE_KEY, TAKER_PRIVATE_KEY), never ORACLE_PRIVATE_KEY; --as <pubkey> simulates as a key whose secret
 * is not on this machine (the cold key). Upgraded program only.
 */
async function seatCli(cmd: "seat" | "void-epoch" | "take-seat", arg: string | undefined) {
  const own = (name: string) => (process.env[name] ? loadKeypair(process.env[name]) : null);
  if (cmd === "seat") {
    const v3 = connectV3();
    const r = await seatStatusCli(v3.connection, v3.program);
    if (r.foreign) process.exitCode = 1;
    return;
  }
  const yes = process.argv.includes("--yes");
  const as = argValue("--as");
  if (cmd === "void-epoch") {
    const signer = own("VOIDER_PRIVATE_KEY");
    const v3 = connectV3(signer ?? undefined);
    const bondArg = argValue("--bond");
    await voidEpochCli(v3.connection, v3.program, signer, {
      epoch: Number(arg), extra: process.argv.includes("--extra"), yes, evenIfOurs: process.argv.includes("--even-if-ours"), as,
      ...(bondArg === undefined ? {} : { bond: BigInt(Math.round(Number(bondArg) * 1e9)) }),
    });
    return;
  }
  const signer = own("TAKER_PRIVATE_KEY");
  const v3 = connectV3(signer ?? undefined);
  await takeSeatCli(v3.connection, v3.program, signer, { hot: argValue("--hot") ?? "", cold: argValue("--cold") ?? "", refund: argValue("--refund") ?? "", yes, as });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Rewards v3 flow (SPEC-v3 §7, amendments A7.4, A8, A10.11, A11). Runs from the switch epoch on; nothing above
// changes for v2. The sources are injected (flow-v3.ts), so `--record <file>` saves every answer of a dry run as a
// fixture that test/flow.test.ts can replay.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

// ── the week-so-far feed (feed-v3.ts): hourly, never committed, dormant until the switch ──────────────────────
/**
 * Writes the week-so-far feed v1 of epoch n = Config.last_epoch + 1 to --out (the keeper workflow serves it with the site,
 * at <site>/feed/week-so-far.json). Read-only: no key, no transaction, nothing in EPOCHS_DIR changes. While epoch n is
 * built under the v2 rules, or the live program is not the upgraded binary, it writes nothing and reports active=false
 * (GITHUB_OUTPUT): no binding quote exists then. --prev-feed (the feed the site serves now) spares the candles already read.
 */
async function weekSoFarCli() {
  // --gate-only: only report whether the feed is live (active=true|false), read nothing else (the keeper loop uses it)
  const gateOnly = process.argv.includes("--gate-only");
  const out = argValue("--out");
  if (!out && !gateOnly) throw new Error("usage: npm run feed -- --out <file> [--prev-feed <file>] | --gate-only");
  const gh = (k: string, v: string | number | boolean) => {
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  };
  const dormant = (reason: string) => {
    console.log(reason);
    gh("active", false);
  };
  const { program } = connect();
  const last = Number((await fetchConfig(program)).lastEpoch);
  const n = last + 1;
  const prev = last > 0 ? readEpochAny(last) : null;
  if (!prev) {
    // published, not in this checkout yet (the epoch run commits it right after publishing): the next hour tries again
    if (last > 0) console.log(`::warning::epoch-${last}.json is not in this checkout yet: no week-so-far feed this hour`);
    return dormant(last > 0 ? `no feed: epoch-${last}.json is missing locally` : "dormant: no epoch is published yet");
  }
  const v3 = connectV3();
  const verdict = await liveVerdictV3();
  // R-3: the feed is live exactly when epoch n will be built under the v3 rules (rewardsVersionGatedV3)
  let version: 2 | 3;
  try {
    version = rewardsVersionGatedV3(n, prev, verdict.status).version;
  } catch (e) {
    return dormant(`dormant: ${String((e as Error)?.message ?? e).slice(0, 240)}`);
  }
  if (version !== 3) return dormant(feedGateV3({ rewardsVersion: 2, upgrade: verdict.status }).reason);
  const gate = feedGateV3({ rewardsVersion: 3, upgrade: verdict.status, reasons: verdict.reasons });
  if (!gate.active) return dormant(gate.reason);
  if (gateOnly) {
    console.log(`the week-so-far feed is live: epoch ${n} is built under the v3 rules on the upgraded program`);
    return gh("active", true);
  }
  const prevFeed = argValue("--prev-feed");
  let known = null;
  let samples = null;
  if (prevFeed && fs.existsSync(prevFeed)) {
    try {
      const pf = JSON.parse(fs.readFileSync(prevFeed, "utf8"));
      known = knownReadingsOfFeedV1(pf, { programId: PROGRAM_ID, epoch: n, prevDataHash: prev.dataHash });
      // D-13: the hourly liquidity samples of this window so far; this hour's reading is appended to them
      samples = samplesOfFeedV1(pf, { programId: PROGRAM_ID, epoch: n, prevDataHash: prev.dataHash });
    } catch {
      known = null;
    }
  }
  // D-17: the feed says when epoch n is held by the anomaly gate (FEED CONTRACT flags.anomalyHold)
  const held = readGate(n);
  const anomalyHold = !!held && !held.released;
  console.log(`week-so-far feed for epoch ${n} (previous: epoch ${prev.epoch}, v${prev.version}${known ? "; readings of the previous feed reused" : ""})`);
  const files = readAllEpochsAny().filter((f) => f.epoch < n);
  const a = await assembleWeekSoFarV3(prev, liveSourcesV3(v3.connection, v3.program), CHAINS, files, (m) => console.log(m), { known, engineSha256: engineSha256Of(), samples, anomalyHold });
  for (const w of a.warnings) console.log(`  WARNING ${w}`);
  for (const k of a.skipped) console.log(`  ${k.name}: not valued this hour (${k.reason.slice(0, 200)})`);
  fs.mkdirSync(path.dirname(path.resolve(out!)), { recursive: true });
  fs.writeFileSync(out!, feedText(a.feed));
  const f = a.feed;
  const burns = f.chains.reduce((s, c) => s + (c.burns?.length ?? 0), 0);
  console.log(`  as of ${new Date(f.asOf * 1000).toISOString()} (X1): ${burns} burns, senior ${f.capacity.senior} of C ${f.capacity.cash} lamports, readings for hour ${f.readings.hour}; skipped [${f.skipped.join(", ")}]`);
  gh("active", true);
  gh("epoch", n);
  gh("asof", f.asOf);
}

async function runEpochV3(dry: boolean, connection: Connection, program: anchor.Program, signer: Keypair | undefined, n: number, prev: AnyEpochFile | null) {
  const log = (m: string) => console.log(m);
  console.log(`Building epoch ${n} with rewards v3 (previous: ${prev ? `epoch ${prev.epoch}, v${prev.version}` : "none"})`);
  // A12 (P1): a local epoch file above the last published epoch was never published (a run died between its write and
  // publish_epoch). It is moved out of the epochs directory (kept in the runner's temp for the log) so it can never
  // poison the mission history or be committed as if it were an epoch; the program is asked first, never assumed.
  const all = readAllEpochsAny();
  for (const e of staleEpochs(all, n - 1)) {
    const onChain = await (program.account as any).epoch.fetchNullable(PDA.epoch(e)).catch(() => undefined);
    if (onChain === undefined) throw new Error(`epoch-${e}.json is above the last published epoch ${n - 1} and Epoch(${e}) could not be read: refusing to guess`);
    if (onChain) throw new Error(`epoch-${e}.json is above Config.last_epoch ${n - 1} but Epoch(${e}) exists on-chain: the RPC is behind, re-run`);
    const to = path.join(os.tmpdir(), `epoch-${e}.stale-${Date.now()}.json`);
    if (!dry) {
      fs.renameSync(file(e), to);
      console.log(`  epoch-${e}.json was never published: moved to ${to} (it does not count as history)`);
    } else console.log(`  epoch-${e}.json was never published (a real run moves it out of ${EPOCHS_DIR})`);
  }
  const files = all.filter((f) => f.epoch < n);
  // R-2 (round-3 review): the program spaces PAYING extra epochs MIN_EPOCH_INTERVAL apart on their own landing times.
  // So (1) an extra epoch still pending from an earlier week goes out BEFORE this base epoch, and (2) the base epoch is
  // not due until the last paying extra is MIN_EPOCH_INTERVAL + EXTRA_LAG_MARGIN old: the extra published minutes after
  // this base can then never be refused, and one late or failed extra step can no longer push every later paying extra
  // a week late for good. A short remaining wait (the localnet profile) is waited out; a long one ends the run as "not
  // due" (the keeper's `due` check says the same, so it does not re-dispatch in between).
  if (!dry) {
    const lag = await extraLagV3(connection, program, signer!, n);
    if (lag.problems.length) for (const p of lag.problems) console.log(`::warning::${p}`);
    if (lag.notDueUntil !== null) {
      console.log(`  not due: the last paying extra epoch landed less than ${MIN_EPOCH_INTERVAL + EXTRA_LAG_MARGIN} s ago; base epoch ${n} waits until ${new Date(lag.notDueUntil * 1000).toISOString()} (R-2)`);
      return void (await seatLivenessNoteV3(connection, program));
    }
  }
  // D-17: an epoch the anomaly gate still holds (or GATE_BLOCK keeps held) is not rebuilt before its hold runs out
  const held = readGate(n);
  if (!dry && held && !held.released) {
    const now = await chainNow(connection).catch(() => null);
    if (now !== null && (gateHoldsV3(held, n, now) || (gateBlocked() && now >= held.until))) {
      console.log(`::warning::epoch ${n} is held by the anomaly gate ${now < held.until ? `until ${new Date(held.until * 1000).toISOString()}` : "(GATE_BLOCK is set)"}: ${held.reasons.map((x) => x.text).join("; ").slice(0, 400)}`);
      return void (await seatLivenessNoteV3(connection, program));
    }
  }
  const recordTo = argValue("--record");
  const rec = emptyRecording();
  const live = liveSourcesV3(connection, program);
  const s: SourcesV3 = recordTo ? recordingSources(live, rec) : live;
  // D-13: the hourly liquidity samples of this window, from the published week-so-far feed (or --feed <file>); none when
  // it cannot be read (each chain's statistic is then the build's own reading)
  const feedArg = argValue("--feed");
  const feedDoc = feedArg ? (fs.existsSync(feedArg) ? JSON.parse(fs.readFileSync(feedArg, "utf8")) : null) : await fetchFeedV1();
  const samples = prev ? samplesOfFeedV1(feedDoc, { programId: PROGRAM_ID, epoch: n, prevDataHash: prev.dataHash }) : new Map();
  console.log(`  D-13 samples: ${samples.size ? [...samples.entries()].map(([id, v]) => `chain ${id} ${v.length}`).join(", ") : "none (no feed of this window)"}`);
  let assembled: AssembledV3;
  try {
    assembled = await assembleInputsV3(n, prev, s, CHAINS, files, log, { stopIfNotDue: !dry, samples: (id) => samples.get(id) ?? null });
  } catch (e) {
    if (e instanceof NotDueV3) {
      console.log(`  ${e.message}`);
      return void (await seatLivenessNoteV3(connection, program));
    }
    throw e;
  } finally {
    if (recordTo) {
      fs.writeFileSync(recordTo, JSON.stringify(rec, null, 2));
      console.log(`  sources recorded to ${recordTo}`);
    }
  }
  for (const w of assembled.warnings) console.log(`  WARNING ${w}`);
  // A12 (P3): the previous file lost its publish record (a confirmation timeout after the transaction landed): write it
  if (!dry && prev && !prev.publish?.tx && assembled.prevPublished) {
    (prev as { publish?: unknown }).publish = publishRecordV3(assembled.prevPublished.tx, assembled.prevPublished);
    fs.writeFileSync(file(prev.epoch), JSON.stringify(prev, null, 2));
    writeIndex();
    console.log(`  epoch-${prev.epoch}.json: publish record backfilled from the chain (${assembled.prevPublished.tx})`);
  }
  const due = publishDecisionV3(assembled.inputs.window);
  if (!due.ok) {
    console.log(`  ${due.reason}`);
    if (!dry) return void (await seatLivenessNoteV3(connection, program));
  }
  // A13.4 (N3): a dry run on a window shorter than MIN_WINDOW prints a labelled provisional file instead of throwing;
  // it is never written to the epochs directory, never self-verified as an epoch and never published
  const provisional = dry ? provisionalReasonOf(assembled.inputs.window) : null;
  const paying = buildV3(assembled.inputs, prev, { provisional });
  let built = paying.file;
  const unpriced = paying.unpriced;
  for (const id of unpriced) console.log(`  chain ${id}: SKIPPED this epoch, a burn without a XEN price (A7.7); its cursor stays`);
  if (!built) {
    // Round 4 (quiet-month seat liveness): a window that valued no burn at all publishes the HEARTBEAT base epoch (no
    // leaves, budget 0) so the oracle seat survives a quiet month; only on the upgraded binary, verdict re-read here
    // (the paying path above never reads it). A window with a valued burn that pays nothing still publishes nothing.
    const allowed = heartbeatAllowedV3({ verdict: (await liveVerdictV3()).status, provisional, due: due.ok });
    if (allowed.ok) {
      built = buildV3(assembled.inputs, prev, { heartbeat: true }).file;
      if (built) console.log(`  heartbeat: ${allowed.reason}`);
    } else if (!provisional) console.log(`  no heartbeat: ${allowed.reason}`);
  }
  if (!built) {
    console.log("No burn with value in this window: nothing to publish (the window grows until there is one).");
    return void (await seatLivenessNoteV3(connection, program));
  }
  if (provisional) {
    const bar = "=".repeat(100);
    console.log(`${bar}\nPROVISIONAL epoch ${n} (A13.4): NOT PUBLISHABLE. ${provisional}.\nThe numbers below are a preview of a window that is still open; the real epoch is built from a fresh snapshot once the window is long enough.\n${bar}`);
    console.log(JSON.stringify({ ...built, proofs: undefined }, null, 2));
    console.log(`${bar}\nEND OF PROVISIONAL epoch ${n}: not written, not verified as an epoch, not published; no extra file is built on it.\n${bar}`);
    return;
  }
  // T2-RULES: the rules in force for epoch n; X-010: every chain read records its portal counters
  const rulesErr = rulesInForceErrorV3(built, UPGRADED_ELF?.sha256 ?? null);
  // D-23: the price sidecar re-derives every burn's readings (it is written next to the file, before it)
  const sidecarErrs = verifyPriceSidecarV3(built, assembled.sidecar ?? null);
  const errs = [...verifyAny(built, prev), ...verifyChainSetV3(built, prev, CHAINS.filter((c) => c.portal)), ...(rulesErr ? [rulesErr] : []), ...countersMissingV3(built), ...sidecarErrs];
  if (errs.length) throw new Error("self-verification failed: " + errs.join("; "));
  // D-17: the anomaly gate (published thresholds, rulesBlock.priceRules.gate): a hit holds the publication up to 24 h, then
  // it is released with a fresh rebuild unless GATE_BLOCK is set; the hold record is public (gate/epoch-<n>.json)
  const history = files.filter((x) => x.publish).sort((x, y) => y.epoch - x.epoch);
  const gateReasons = anomalyGateV3(built, prev, history);
  for (const r of gateReasons) console.log(`  anomaly gate: ${r.code}: ${r.text}`);
  let gateRelease: GateRecordV3 | null = null;
  if (!dry) {
    const nowTs = await chainNow(connection).catch(() => null);
    // r4-fix (review r4 findings 4 and 12): a heartbeat is never held; a rebuild with a new kind of reason holds once more
    const g = gateDecisionV3(gateReasons, readGate(n), nowTs, gateBlocked(), n, built.dataHash, isHeartbeatV3(built));
    if (g.action === "hold" || g.action === "wait" || g.action === "blocked") {
      if (g.action === "hold" && g.record) writeGate(g.record);
      console.log(`::warning::epoch ${n} not published: ${g.reason.slice(0, 600)}`);
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Epoch ${n}: anomaly gate (${g.action})\n\n${gateReasons.map((r) => `- ${r.code}: ${r.text}`).join("\n")}\n`);
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `held=true\n`);
      return void (await seatLivenessNoteV3(connection, program));
    }
    if (g.record) {
      gateRelease = g.record;
      console.log(`  ${g.reason}`);
    }
  }
  const skippedNames = built.chains.filter((c) => c.skipped).map((c) => c.name);
  console.log(`  ${built.leaves.length} leaves, total score ${built.totalScore}, cash capacity ${built.capacity.cash}, root ${built.root}`);
  if (skippedNames.length) console.log(`  skipped chains: ${skippedNames.join(", ")}`);
  if (dry) {
    console.log(JSON.stringify({ ...built, proofs: undefined }, null, 2));
    try {
      await buildExtraV3(built, s, assembled.snapshotRead, true);
    } catch (e) {
      console.log(`  extra epoch (dry): ${String((e as Error)?.message ?? e)}`);
    }
    return;
  }

  // Write BEFORE publishing (X-011, X-017): the workflow keeps the directory as a run artifact whatever happens next,
  // so an epoch that is on-chain always has its public file. Then the pool is re-read and the file rebuilt on drift.
  // (A file left by a run that dies before the publication is moved out by the next run: P1.)
  let f = built;
  let inputs = assembled.inputs;
  let snapshotRead = assembled.snapshotRead;
  // D-23 (phase 1): the sidecar first (the file records its sha256), then the file
  if (assembled.sidecar && f.sidecar) fs.writeFileSync(path.join(EPOCHS_DIR, f.sidecar.file), JSON.stringify(assembled.sidecar, null, 2));
  fs.writeFileSync(file(n), JSON.stringify(f, null, 2));
  for (let attempt = 1; ; attempt++) {
    const pool = await s.freePool();
    // A12 (RE-1): with the block time of the slot the pool was read at, a build whose snapshot is older than
    // MAX_PUBLISH_LAG is rebuilt instead of sent, so the oracle never makes a late publication itself.
    // A13.5 (N5): a block time that cannot be read (3 tries) fails CLOSED: nothing is published, and the run says why
    const nowTs = await readPublishClockV3(s, pool.slot, 3, 2_000, log);
    const gate = publishGateV3(f, BigInt(pool.lamports), nowTs, pool.slot);
    if (gate.action === "refuse") throw new Error(gate.reason);
    if (gate.action === "publish") {
      // The gate's pool is the finalized one (~13 s behind); publish_epoch records the live free pool, and the file is
      // refused by verify forever when its F is more than the rebuild drift away from that (verifyPublishedV3). A pool
      // that moved in the last seconds (a forge, a donation, an expiry) is waited for until final, and the next attempt
      // rebuilds on it (found by the localnet e2e, tests/e2e-oracle-v3.sh: three forges right before the build)
      const live = await freePoolV3(connection, program, "confirmed").catch(() => null);
      const liveGate = live ? publishGateV3(f, BigInt(live.lamports), nowTs, live.slot) : gate;
      if (liveGate.action !== "rebuild") break;
      if (attempt > 3) throw new Error(`rebuild needed again (${liveGate.reason}, the live pool at slot ${live!.slot}): giving up this run; nothing was published`);
      console.log(`  the live pool moved after the finalized read (${liveGate.reason}): waiting until slot ${live!.slot} is final`);
      for (let i = 0; i < 30 && (await s.freePool().catch(() => ({ slot: 0 }))).slot < live!.slot; i++) await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }
    const reason = gate.reason;
    if (attempt > 3) throw new Error(`rebuild needed again (${reason}): giving up this run; nothing was published`);
    console.log(`  rebuild ${attempt}: ${reason}`);
    // A12 (P4): a rebuild far from the snapshot re-reads it first, so createdAt stays within CLOCK_SKEW_MAX of endTs
    ({ inputs, snapshotRead } = await refreshSnapshotIfOldV3(inputs, snapshotRead, s, log, /older than MAX_PUBLISH_LAG/.test(reason)));
    // round 4: a heartbeat is rebuilt as a heartbeat (its window still values no burn), a paying file as a paying file
    const again = buildV3({ ...inputs, createdAt: s.now(), freePool: { ...inputs.freePool, lamports: pool.lamports, slot: pool.slot } }, prev, { heartbeat: isHeartbeatV3(f) });
    if (!again.file) throw new Error("the rebuild pays nobody: nothing was published");
    f = again.file;
    fs.writeFileSync(file(n), JSON.stringify(f, null, 2));
  }

  // A12 (P3): a confirmation timeout does not mean the transaction failed: look for the EpochPublished record of n
  // before giving up, and continue with the transaction found
  let tx: string;
  try {
    tx = await publishEpochV3(program, signer!, f);
  } catch (e) {
    console.log(`  publish_epoch did not confirm (${String((e as Error)?.message ?? e).slice(0, 200)}): looking for the publication on-chain`);
    const landed = await withRetries(
      async () => {
        const r = await readEpochPublishedV3(connection, program, n, undefined, "confirmed");
        if (!r) throw new Error(`no EpochPublished record for epoch ${n} yet`);
        return r;
      },
      12, 15_000, log,
    );
    if (!landed || landed.dataHash !== f.dataHash) throw e;
    tx = landed.tx;
    console.log(`  the publication landed: ${tx}`);
  }
  f.publish = { tx };
  fs.writeFileSync(file(n), JSON.stringify(f, null, 2));
  console.log(`  published: ${tx}`);
  // D-17: the hold record says how the epoch was let go, and the publication record says it was held
  if (gateRelease) {
    writeGate({ ...gateRelease, released: { ...gateRelease.released!, tx } });
  }
  const gateNote = gateRelease ? { gate: { heldAt: gateRelease.heldAt, releasedAt: gateRelease.released!.at, reasons: gateRelease.reasons.map((r) => r.code) } } : {};
  const problems: string[] = [];
  // the EpochPublished event and the publish slot, with retries at "confirmed" (P7: its logs never change, and X1's
  // finality lags ~13 s); {tx} alone stays when every read fails
  const read = await withRetries(
    async () => {
      const r = await readEpochPublishedV3(connection, program, n, tx, "confirmed");
      if (!r) throw new Error("the EpochPublished event is not in the transaction yet");
      return r;
    },
    10, 6_000, log,
  );
  const plan = claimPlanV3(f);
  f.publish = { ...publishRecordV3(tx, read, { tipped: plan.tipped.length, dust: plan.dust.length }), ...gateNote };
  fs.writeFileSync(file(n), JSON.stringify(f, null, 2));
  writeIndex();
  if (read) {
    const pe = verifyPublishedV3(f, toPublishedEpochV3(read));
    if (pe.length) problems.push(...pe.map((e) => `publication: ${e}`));
    console.log(`  publish slot ${read.slot}, published_at ${read.publishedAt}, budget ${read.budget} (drop reserve ${read.dropReserve}), free pool before ${read.freePoolBefore}`);
  } else problems.push("the EpochPublished event could not be read after publishing: the file records {tx} alone (verify the file later)");

  // A13.1: a v3 epoch has no drop reserve and no drop seed (verifyPublishedV3 above reports a reserve as I9 broken)
  // every leaf is claimed for its burner, dust too (A11; X-027); the record above says how many carry a keeper tip.
  // The upgraded program holds every claim for 48 h after the publication (theft §6.1): inside the hold the publish
  // run claims nothing (each claim would fail with ClaimOnHold) and the keeper claims once the hold is over.
  // (publishEpochV3 sends only to the upgraded binary, W2-4, so the hold always applies: an unreadable event means
  // "published just now", never "claim now")
  const holdEnds = (read?.publishedAt ?? Math.floor(Date.now() / 1000)) + CLAIM_HOLD;
  // the hold is judged on the program's clock, never on this machine's: a local validator's clock can trail the wall
  // clock by seconds (the e2e saw ClaimOnHold from claims sent "after" a 2-s hold). An unreadable clock means "held".
  const holdClock = isHeartbeatV3(f) ? null : await chainClockV3(connection);
  if (isHeartbeatV3(f)) {
    // round 4: a heartbeat has no leaf (budget 0): nothing to claim; it keeps the oracle seat alive once its hold is over
    console.log(`  heartbeat epoch ${n}: no leaf, budget 0; it counts for the oracle seat once its 48-h hold ends (${new Date(holdEnds * 1000).toISOString()})`);
    // the record says what the claims did: nothing to do (the health row reads it; outside the data hash)
    f.publish = { ...f.publish!, claims: { tipped: 0, dust: 0, claimed: 0, failed: 0, planned: { tipped: 0, dust: 0 } } } as typeof f.publish;
    fs.writeFileSync(file(n), JSON.stringify(f, null, 2));
  } else if (holdClock === null || holdClock < holdEnds) {
    console.log(`  claims open at ${new Date(holdEnds * 1000).toISOString()} (48-h hold): the keeper claims every leaf then`);
    f.publish = { ...f.publish!, claims: { ...(f.publish!.claims ?? { tipped: plan.tipped.length, dust: plan.dust.length }), heldUntil: holdEnds } } as typeof f.publish;
    fs.writeFileSync(file(n), JSON.stringify(f, null, 2));
  } else try {
    const c = await claimLeavesV3(connection, program, signer!, f);
    console.log(`  auto-claimed ${c.claimed}/${f.leaves.length} (${c.tipped} with a keeper tip, ${c.dust} dust, ${c.failed} failed)`);
    // A12 (P11): the record carries what the claims did, not the plan
    f.publish = { ...f.publish!, claims: { tipped: c.tipped, dust: c.dust, claimed: c.claimed, failed: c.failed, planned: { tipped: plan.tipped.length, dust: plan.dust.length } } } as typeof f.publish;
    fs.writeFileSync(file(n), JSON.stringify(f, null, 2));
    if (c.failed) problems.push(`claims: ${c.failed} of ${f.leaves.length} leaves failed (the keeper retries them)`);
    if (c.stopped) problems.push(`claims: ${c.stopped}`);
  } catch (e) {
    problems.push(`claims: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  try {
    await sweepReceiptsV3(connection, program, signer!);
  } catch (e) {
    problems.push(`close_receipt sweep: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
  // A10.11: an earlier extra epoch whose file an earlier run pushed but which is not on-chain yet goes out first (in
  // order: X of extra n is ExtraEpochPublished(n−1).free_after); extra n itself waits for this run's push (publish-extra)
  try {
    const pending = await publishPendingExtrasV3(signer!, n - 1);
    problems.push(...pending.problems);
    // extra n reads X from ExtraEpochPublished(n − 1) at "finalized": one published by this run is waited for (~13 s),
    // else extra-n.json is not built this week (found by the localnet e2e, tests/e2e-oracle-v3.sh)
    if (pending.published.includes(n - 1)) {
      await withRetries(
        async () => {
          if (!(await readExtraPublishedV3(connection, program, n - 1, "finalized"))) throw new Error(`ExtraEpochPublished(${n - 1}) is not final yet`);
          return true;
        },
        12, 5_000, log,
      );
    }
  } catch (e) {
    problems.push(`extra publication: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
  }
  // the extra epoch right after the base epoch (A10.11): a heartbeat with budget 0 until the program upgrade
  try {
    await buildExtraV3(f, s, snapshotRead, false);
  } catch (e) {
    problems.push(`extra epoch: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
  }
  if (problems.length) {
    // A12 (P7): the epoch is published and written, so these are soft: reported as error annotations and in the step
    // summary, and the run still succeeds, so the commit and the announcement of a published epoch always happen
    console.error("post-publish problems (the epoch file is written and published):\n - " + problems.join("\n - "));
    const r = postPublishReport(problems);
    for (const a of r.annotations) console.log(a);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Epoch ${n}: post-publish problems\n\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `problems=${problems.length}\n`);
    process.exitCode = r.exitCode;
  }
}

/**
 * The oracle seat's liveness when this run publishes nothing (upgraded program only; read-only, silent before the upgrade
 * or on a read error). The seat dies 28 days after its newest surviving epoch. A week without a valued burn publishes
 * the heartbeat (round 4), but a week whose valued burns pay nothing (an empty pool), a held or failed run still
 * publishes nothing: the run says when the seat can be taken, as a warning annotation 10 days before and an error
 * annotation once an epoch published now would still be on hold at that time.
 */
async function seatLivenessNoteV3(connection: Connection, program: anchor.Program) {
  try {
    const l = await readOracleSeatLivenessV3(connection, program, Math.floor(Date.now() / 1000));
    if (!l) return;
    console.log(`  oracle seat: ${l.detail}`);
    if (l.state !== "ok" && process.env.GITHUB_ACTIONS) console.log(`::${l.state === "warn" ? "warning" : "error"}::${l.detail}`);
    if (l.state !== "ok" && process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Oracle seat\n\n${l.detail}\n`);
  } catch {
    /* the program is not upgraded, or the read failed: nothing to say */
  }
}

/**
 * Extra epoch n from base file n (A10): the previous extra file when the history has one, the pot reading ("0" until
 * the program upgrade creates the extra pot, so every extra epoch before it is a heartbeat with budget 0) and the base
 * snapshot's records with their last Core signature. Written next to the base file; not published (publish_extra_epoch
 * comes with the upgrade).
 */
async function buildExtraV3(base: EpochFileV3, s: SourcesV3, read: SnapshotReadV3, dry: boolean): Promise<ExtraFileV1> {
  // X1: the extra runs only on a two-pot base (no Forge Right lane, no boost); on an A7 base it would pay holders twice
  const nft = baseNftTermsError(base);
  if (nft) throw new Error(`extra epoch ${base.epoch} not built: ${nft}`);
  // A13.6: a missing extra file of an earlier week (a build that failed last run, a lost file) is rebuilt (A13.7) or,
  // when it cannot be, written as a skip heartbeat, so one bad week never blocks the history
  const { connection, program } = connectV3();
  // DETECTION RULE (A11-a, OD-9): the pot, its first extra epoch, X at init_extra and the init_extra mark, all from the
  // chain; before the upgrade nothing is read and every extra file stays a budget-0 heartbeat (as before)
  const pot = await extraPotRunV3(liveExtraPotReadsV3(connection, program));
  const potOpts = { potLive: pot.live, liveFrom: pot.liveFrom, firstX: pot.firstX, init: pot.init };
  const src = liveExtraRecoveryV3(connection, program, pot.live);
  const caught = await catchUpExtrasV3({
    upTo: base.epoch - 1, firstEpoch: extraFirstEpochV3(base), src, log: (m) => console.log(m), ...potOpts,
    baseOf: (e) => readEpochAny(e) as EpochFileV3 | null, extraOf: (e) => readExtra(e),
  });
  for (const c of caught.written) {
    if (!dry) fs.writeFileSync(extraFile(c.epoch), JSON.stringify(c.file, null, 2));
    console.log(`  extra-${c.epoch}.json ${c.how}${c.how === "skipped" ? ` (A13.6: budget 0, ${c.reason?.slice(0, 200)})` : " (A13.7)"}${dry ? " (dry: not written)" : ""}`);
  }
  const prevExtra = caught.prev;
  const signatures = await s.assetSignatures(read.records.map((r) => r.asset), read.slot);
  // A13.7: the pot reading and the build instant are functions of durable inputs, so a lost file is rebuilt byte for byte
  const livePot = { live: pot.live, liveFrom: pot.liveFrom };
  const open = await extraOpenV3(base.epoch, prevExtra, { ...livePot, firstX: pot.firstX }, src);
  const init = extraInitV3(base.epoch, prevExtra, { ...livePot, init: pot.init });
  const ef = buildExtraAfterBaseV3(base, prevExtra, read, signatures, extraPoolV3(base, open, init), extraCreatedAtV3(base));
  const errs = verifyExtraFile(ef, base, prevExtra);
  if (errs.length) throw new Error("extra self-verification failed: " + errs.join("; "));
  if (!dry) fs.writeFileSync(extraFile(base.epoch), JSON.stringify(ef, null, 2));
  // A13.9: a base built without its Artifact records gets the skip heartbeat (buildExtraAfterBaseV3 says why)
  const what = ef.skip ? `SKIP heartbeat (${ef.skip.reason.slice(0, 200)})` : `${ef.totals.eligibleArtifacts} eligible Artifacts`;
  const next = pot.live ? "publish it once pushed: npm run publish-extra (A10.11: durable first)" : "not published (the extra pot comes with the program upgrade)";
  console.log(`  extra epoch ${ef.epoch}: ${what}, ${ef.leaves.length} leaves, budget ${ef.totals.budget}${dry ? " (dry)" : ` written to ${extraFile(base.epoch)}`}; ${next}`);
  return ef;
}

/**
 * A13.7: `rebuild-extra <n>` rebuilds a lost extra-<n>.json deterministically from epoch-<n>.json, extra-<n−1>.json and
 * X1 reads at the recorded snapshot slot; refused when its data hash differs from the program's record of epoch n (once
 * the program records extra epochs) or from extra-<n+1>.json's prevDataHash. Never overwrites a different file.
 */
async function rebuildExtraCli(n: number) {
  if (!Number.isInteger(n) || n < 1) throw new Error("usage: rebuild-extra <epoch>");
  const base = readEpochAny(n);
  if (!base || base.version !== 3) throw new Error(`epoch-${n}.json is missing or not a v3 file: an extra file exists only for a v3 base epoch`);
  const first = extraFirstEpochV3(base);
  const prev = n > first ? readExtra(n - 1) : null;
  if (n > first && !prev) throw new Error(`extra-${n - 1}.json is missing too: rebuild it first (rebuild-extra ${n - 1})`);
  const { connection, program } = connectV3();
  // A11-a: X and the init_extra mark of the chain once the pot is live (the first extra epoch's X from init_extra)
  const pot = await extraPotRunV3(liveExtraPotReadsV3(connection, program));
  const r = await rebuildExtraV3(base, prev, liveExtraRecoveryV3(connection, program, pot.live), { next: readExtra(n + 1), potLive: pot.live, liveFrom: pot.liveFrom, firstX: pot.firstX, init: pot.init });
  const existing = readExtra(n);
  if (existing) {
    if (existing.dataHash === r.file.dataHash) {
      console.log(`extra-${n}.json is present and identical to the rebuild (${r.file.dataHash}): nothing written`);
      return;
    }
    throw new Error(`extra-${n}.json exists with data hash ${existing.dataHash}, the rebuild gives ${r.file.dataHash}: not overwritten (verify both)`);
  }
  fs.writeFileSync(extraFile(n), JSON.stringify(r.file, null, 2));
  const how = r.confirmedBy.length ? `confirmed by ${r.confirmedBy.join(" and ")}` : "unchecked against the chain: the program records no extra epoch before the upgrade";
  console.log(`extra-${n}.json rebuilt: data hash ${r.file.dataHash}, ${r.file.leaves.length} leaves, budget ${r.file.totals.budget} (${how})`);
}

async function verifyV3(p: string, f: EpochFileV3, full: boolean) {
  const dir = path.dirname(p);
  const prevPath = path.join(dir, `epoch-${f.epoch - 1}.json`);
  const prev: AnyEpochFile | null = f.epoch > 1 && fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, "utf8")) : null;
  if (f.epoch > 1 && !prev) {
    console.error(`❌ epoch-${f.epoch - 1}.json is required next to the file: a v3 epoch is a function of its previous file`);
    process.exit(1);
  }
  const live = CHAINS.filter((c) => c.portal);
  // T2-RULES: the file carries the rules version in force for its epoch (rules-v3.ts) for the pinned binary
  const rulesErr = rulesInForceErrorV3(f, UPGRADED_ELF?.sha256 ?? null);
  const errors = [...verifyAny(f, prev), ...verifyChainSetV3(f, prev, live), ...(rulesErr ? [rulesErr] : []), ...countersMissingV3(f)];
  // D-23 (phase 1): the price sidecar next to the file re-derives every burn's readings offline
  if (f.sidecar) {
    const sp = path.join(dir, f.sidecar.file);
    const doc: PriceSidecarV3 | null = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, "utf8")) : null;
    errors.push(...verifyPriceSidecarV3(f, doc));
  }
  if (!f.publish?.tx) console.log(`(epoch-${f.epoch}.json has no publish record: the publication is looked up on-chain)`);
  const { connection, program } = connectV3();
  const read = await readEpochPublishedV3(connection, program, f.epoch, f.publish?.tx);
  if (!read) errors.push("epoch not found on-chain (no EpochPublished transaction)");
  else errors.push(...verifyPublishedV3(f, toPublishedEpochV3(read)));
  if (prev) {
    const pr = await readEpochPublishedV3(connection, program, prev.epoch, prev.publish?.tx);
    if (!pr || pr.publishedAt === null) errors.push(`epoch ${prev.epoch}'s publication could not be read: the window start and F_ref are unconfirmed`);
    else errors.push(...verifyChainLinkV3(f, { publishedAt: pr.publishedAt, budget: BigInt(pr.budget), freePoolBefore: BigInt(pr.freePoolBefore) }));
  } else errors.push(...verifyChainLinkV3(f, null));
  if (full) {
    // A8: the window end is the block time of the snapshot slot (a null reading is reported, never a pass)
    errors.push(...verifySnapshotTimeV3(f, await connection.getBlockTime(f.snapshot.slot)));
    // the burns re-read from the configured portals, from one RPC with the mission counters (A11)
    // the history next to the file under verification (P7), not the oracle's EPOCHS_DIR
    const last = lastMissionIds(readAllEpochsAny(dir).filter((x) => x.epoch < f.epoch));
    const order = (a: { blockNumber: number; logIndex: number }, b: { blockNumber: number; logIndex: number }) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;
    for (const c of f.chains) {
      if (c.skipped || c.toBlock <= c.fromBlockExclusive) continue;
      const chain = CHAINS.find((x) => x.chainId === c.chainId);
      if (!chain) {
        errors.push(`${c.name}: chain ${c.chainId} is not configured`);
        continue;
      }
      const again = await readChainV3({ ...chain, portal: c.portal }, c.fromBlockExclusive, c.toBlock);
      const mine = f.burns.filter((b) => b.chainId === c.chainId).map(burnEvent).sort(order);
      if (JSON.stringify(again.burns.map(burnEvent).sort(order)) !== JSON.stringify(mine)) errors.push(`${c.name}: burns differ from chain logs`);
      const cont = missionContinuity(again.burns, last.get(c.chainId) ?? 0n, BigInt(again.totalMissions), again.totalMissionsBefore === null ? null : BigInt(again.totalMissionsBefore));
      if (cont.error) errors.push(`${c.name}: ${cont.error}`);
      if (cont.warning) console.log(`(${c.name}: ${cont.warning})`);
      // X-010 / X-022: the recorded counters at toBlock, as the RPC that served the logs reads them and as a second
      // provider reads them (the reconciliation is reported unconfirmed when no other provider answers)
      if (c.missionsAt !== null && again.totalMissions !== c.missionsAt) errors.push(`${c.name}: missionsAt ${c.missionsAt}, but ${again.rpc} reads totalMissions ${again.totalMissions} at block ${c.toBlock}`);
      if (c.burnedAt !== null && again.totalBurned !== c.burnedAt) errors.push(`${c.name}: burnedAt ${c.burnedAt}, but ${again.rpc} reads totalBurned ${again.totalBurned} at block ${c.toBlock}`);
      const second = await portalCountersV3({ ...chain, portal: c.portal }, c.toBlock, again.rpc);
      if (!second) console.log(`(${c.name}: the portal counters at block ${c.toBlock} were not confirmed by a second provider: none answered)`);
      else if ((c.missionsAt !== null && second.totalMissions !== c.missionsAt) || (c.burnedAt !== null && second.totalBurned !== c.burnedAt)) {
        errors.push(`${c.name}: the second provider ${second.rpc} reads ${second.totalMissions} missions / ${second.totalBurned} wei at block ${c.toBlock}, the file records ${c.missionsAt} / ${c.burnedAt}`);
      }
    }
  }
  if (errors.length) {
    console.error("❌ VERIFICATION FAILED\n - " + errors.join("\n - "));
    process.exit(1);
  }
  console.log(`✅ epoch ${f.epoch} (v3) verified: ${f.leaves.length} leaves, ${f.burns.length} burns, root ${f.root}${full ? " (full: logs, counters, snapshot time)" : ""}`);
}

async function verifyExtraV3(p: string, f: ExtraFileV1) {
  const dir = path.dirname(p);
  const basePath = path.join(dir, `epoch-${f.epoch}.json`);
  if (!fs.existsSync(basePath)) {
    console.error(`❌ epoch-${f.epoch}.json is required next to the extra file`);
    process.exit(1);
  }
  const base: EpochFileV3 = JSON.parse(fs.readFileSync(basePath, "utf8"));
  const prevPath = path.join(dir, `extra-${f.epoch - 1}.json`);
  const prev: ExtraFileV1 | null = fs.existsSync(prevPath) ? JSON.parse(fs.readFileSync(prevPath, "utf8")) : null;
  const errors = verifyExtraFile(f, base, prev);
  // X4: a missing previous extra file is an error, never a silent first epoch (verifyExtraFile refuses the restart too)
  if (!prev && f.epoch > base.v3FirstEpoch) errors.push(`extra-${f.epoch - 1}.json is required: the extra history started at epoch ${base.v3FirstEpoch} (recover it, A12)`);
  // X6: before the pot exists every extra file is a budget-0 heartbeat without an init_extra mark; a file with the mark
  // was built on the live pot (OD-9), and --full checks that mark, X and the publication against the chain
  const pot = preUpgradePotError(f, (f.pool.init ?? null) !== null);
  if (pot) errors.push(pot);
  const full = process.argv.includes("--full");
  if (full) errors.push(...(await verifyExtraOnChainV3(f, prev)));
  // X2 (--full): forgedAt of an asset first seen in S(n) cannot be tied offline: re-read its ArtifactRecord (immutable)
  if (full) {
    const { program } = connectV3();
    const seen = new Set((prev?.snapshot.records ?? []).map((r) => r.asset));
    for (const r of f.snapshot.records) {
      if (seen.has(r.asset)) continue;
      const a = await (program.account as any).artifactRecord.fetchNullable(PDA.artifact(new PublicKey(r.asset))).catch(() => null);
      if (!a) console.log(`(${r.asset}: no ArtifactRecord now (recycled since): forgedAt ${r.forgedAt} unconfirmed)`);
      else if (Number(a.forgedAt.toString()) !== r.forgedAt) errors.push(`${r.asset}: forgedAt ${r.forgedAt} != the ArtifactRecord's ${a.forgedAt.toString()}`);
    }
  }
  if (errors.length) {
    console.error("❌ VERIFICATION FAILED\n - " + errors.join("\n - "));
    process.exit(1);
  }
  console.log(`✅ extra epoch ${f.epoch} verified: ${f.leaves.length} leaves, budget ${f.totals.budget}, root ${f.root}${full ? (f.pool.init ? " (full: init_extra, X, publication)" : " (full: before the extra pot existed)") : ""}`);
}

/**
 * `verify --full` of an extra file against X1 (read-only): the init_extra mark (OD-9), the chain link of X
 * (verifyExtraChainLink: ExtraEpochPublished(n−1).free_after, or X at init_extra for the chain's first extra epoch) and,
 * once published, the ExtraEpochPublished event and account (verifyPublishedExtra). A file without the mark was built
 * before the pot existed: the chain must then not be live for it.
 */
async function verifyExtraOnChainV3(f: ExtraFileV1, prev: ExtraFileV1 | null): Promise<string[]> {
  const { connection, program } = connectV3();
  const errors: string[] = [];
  let pot: ExtraPotRunV3;
  try {
    pot = await extraPotRunV3(liveExtraPotReadsV3(connection, program));
  } catch (e) {
    return [`the extra pot could not be read: ${String((e as Error)?.message ?? e).slice(0, 200)}`];
  }
  const live = pot.live && pot.liveFrom !== null && f.epoch >= pot.liveFrom;
  if (!f.pool.init) return live ? [`extra epoch ${f.epoch} is on the live pot (from ${pot.liveFrom}) but carries no init_extra mark (OD-9)`] : [];
  if (!live) return [`extra-${f.epoch}.json carries an init_extra mark but the chain's extra pot is not live for epoch ${f.epoch}`];
  errors.push(...(await verifyExtraInitV3(connection, program, f.pool.init)));
  if (pot.init && (pot.init.tx !== f.pool.init.tx || pot.init.ts !== f.pool.init.ts)) errors.push(`pool.init is not the chain's init_extra (${pot.init.tx})`);
  const first = f.epoch === pot.liveFrom;
  const pe = first ? null : await readExtraPublishedV3(connection, program, f.epoch - 1);
  if (first) errors.push(...(f.pool.open === pot.firstX ? [] : [`pool.open ${f.pool.open} is not X at init_extra (${pot.firstX})`]));
  else errors.push(...verifyExtraChainLink(f, pe));
  void prev;
  const ev = await readExtraPublishedV3(connection, program, f.epoch);
  if (ev) errors.push(...verifyPublishedExtra(f, ev).map((e) => `publication: ${e}`));
  else console.log(`(extra epoch ${f.epoch} is not published on-chain yet)`);
  return errors;
}

/** the text of `file` at git ref `ref` (null when the ref does not hold it); a git failure throws (fail closed) */
function gitShowV3(ref: string, file: string): string | null {
  const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: path.dirname(path.resolve(file)) }).toString().trim();
  const rel = path.relative(repo, path.resolve(file)).split(path.sep).join("/");
  try {
    return execFileSync("git", ["show", `${ref}:${rel}`], { cwd: repo, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Publishes extra-<n>.json (A10.11, A11-a) once
 *  - it verifies against its base file and the previous extra file;
 *  - the chain agrees: n is at or after the chain's first extra epoch, the init_extra mark is the chain's, and X is
 *    ExtraEpochPublished(n−1).free_after (X at init_extra for the first one), so extra epochs go out in order;
 *  - it is DURABLE: the same file (data hash) is in the pushed history (EXTRA_DURABLE_REF, default origin/<branch>), so
 *    an extra epoch is never on-chain without its file (X-011, X-017);
 * then publishExtraEpochV3 (the upgraded-binary guard and the program's own checks, read-only, before sending). An extra
 * epoch already on-chain with the same data hash is recorded, never sent twice. Read-back problems after a landed
 * publication are returned (the file keeps {tx, slot}); every refusal throws and nothing is sent.
 */
async function publishExtraOneV3(n: number, c: { connection: Connection; program: anchor.Program; signer: Keypair; pot: ExtraPotRunV3 }): Promise<{ status: "published" | "already"; problems: string[] }> {
  const { connection, program, signer, pot } = c;
  const f = readExtra(n);
  const base = readEpochAny(n);
  if (!f || !base || base.version !== 3) throw new Error(`extra-${n}.json and its v3 base epoch-${n}.json are required`);
  const prev = readExtra(n - 1);
  const errs = verifyExtraFile(f, base as EpochFileV3, prev);
  if (errs.length) throw new Error(`refusing to publish extra-${n}.json: it does not verify: ${errs.join("; ")}`);
  // "confirmed": an extra epoch published seconds ago (by the weekly run's pending pass) is not final yet, and a second
  // publish_extra_epoch would only fail on the existing PDA (found by the localnet e2e, tests/e2e-oracle-v3.sh)
  const onChain = await readExtraPublishedV3(connection, program, n, "confirmed");
  if (onChain) {
    if (onChain.dataHash !== f.dataHash) throw new Error(`extra epoch ${n} is on-chain with data hash ${onChain.dataHash}, the local file is ${f.dataHash}: nothing sent (verify both)`);
    if (!f.publish && onChain.tx && onChain.slot !== null) {
      f.publish = { tx: onChain.tx, slot: onChain.slot };
      fs.writeFileSync(extraFile(n), JSON.stringify(f, null, 2));
    }
    return { status: "already", problems: [] };
  }
  const prevPublished = pot.liveFrom !== null && n > pot.liveFrom ? await readExtraPublishedV3(connection, program, n - 1) : null;
  const refused = publishExtraRefusalsV3(f, pot, prevPublished);
  if (refused.length) throw new Error(`refusing to publish extra-${n}.json: ${refused.join("; ")}`);
  const ref = process.env.EXTRA_DURABLE_REF || `origin/${process.env.GITHUB_REF_NAME || "main"}`;
  const durable = durableExtraErrorV3(f, gitShowV3(ref, extraFile(n)), ref);
  if (durable) throw new Error(`refusing to publish extra-${n}.json: ${durable}`);
  const tx = await publishExtraEpochV3(program, signer, f);
  console.log(`  extra epoch ${n} published: ${tx}`);
  const read = await withRetries(
    async () => {
      const r = await readExtraPublishedV3(connection, program, n, "confirmed");
      if (!r) throw new Error("the ExtraEpochPublished event is not readable yet");
      return r;
    },
    10, 6_000, (m) => console.log(m),
  );
  f.publish = { tx, slot: read?.slot ?? 0 };
  fs.writeFileSync(extraFile(n), JSON.stringify(f, null, 2));
  const problems = read ? verifyPublishedExtra(f, read).map((e) => `extra epoch ${n}: ${e}`) : [`extra epoch ${n}: the ExtraEpochPublished event could not be read after publishing (verify --full later)`];
  if (!problems.length) console.log(`  ExtraEpochPublished(${n}) read back and verified: total ${read!.total}, free_after ${read!.freeAfter}, weeks ${read!.weeks}`);
  return { status: "published", problems };
}

/**
 * Every local extra file not yet on-chain, oldest first, from the chain's first extra epoch up to `upTo` (all when
 * null; only `only` when given), stopping at the first refusal (extra epochs go out in order). Before the upgrade (the
 * pot not live) nothing is read beyond the detection and nothing is sent. Returns the post-publish problems.
 */
async function publishPendingExtrasV3(signer: Keypair, upTo: number | null, only: number | null = null): Promise<{ problems: string[]; published: number[] }> {
  const { connection, program } = connectV3(signer);
  const pot = await extraPotRunV3(liveExtraPotReadsV3(connection, program));
  if (!pot.live || pot.liveFrom === null) {
    console.log("  extra pot not live (the program is not upgraded): no extra epoch to publish");
    return { problems: [], published: [] };
  }
  const locals = (fs.existsSync(EPOCHS_DIR) ? fs.readdirSync(EPOCHS_DIR) : [])
    .map((x) => /^extra-(\d+)\.json$/.exec(x)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]))
    .filter((e) => e >= pot.liveFrom! && (upTo === null || e <= upTo) && (only === null || e === only)).sort((a, b) => a - b);
  if (only !== null && !locals.includes(only)) throw new Error(`extra-${only}.json is not a local extra file at or after the chain's first extra epoch ${pot.liveFrom}`);
  const problems: string[] = [];
  const published: number[] = [];
  for (const n of locals) {
    let r: Awaited<ReturnType<typeof publishExtraOneV3>>;
    try {
      r = await publishExtraOneV3(n, { connection, program, signer, pot });
    } catch (e) {
      // R-2: only the 6-day interval refuses it now: a notice, not a failure (extra epochs go out in order, so the
      // later ones wait too); the next run sends it
      if (e instanceof ExtraNotYetV3) {
        console.log(`::notice::${e.message}`);
        break;
      }
      throw e;
    }
    if (r.status === "already") console.log(`  extra epoch ${n} is already published: nothing sent`);
    else published.push(n);
    problems.push(...r.problems);
  }
  return { problems, published };
}

/** R-2: a remaining wait at most this long (seconds) is waited out inside the run */
const EXTRA_LAG_WAIT_MAX = 600;

/**
 * The program's clock for a claim hold: the block time of the confirmed slot. A transaction sent now runs in a later
 * slot, whose Clock is never earlier, so "the hold is over" here means the program agrees. null when unreadable.
 */
async function chainClockV3(connection: Connection): Promise<number | null> {
  try {
    const t = await connection.getBlockTime(await connection.getSlot("confirmed"));
    return typeof t === "number" ? t : null;
  } catch {
    return null;
  }
}

/** The X1 time now (block time of the confirmed slot), the wall clock when the node has none. */
async function chainNow(connection: Connection): Promise<number> {
  const t = await connection.getBlockTime(await connection.getSlot("confirmed")).catch(() => null);
  return typeof t === "number" ? t : Math.floor(Date.now() / 1000);
}

/**
 * R-2: ExtraState.last_publish_ts, the landing time of the last PAYING extra epoch (the program's interval clock), and
 * when the next base epoch is due by it; null when the pot is not live (the v2 binary) or nothing paid yet.
 */
async function extraIntervalReadyV3(connection: Connection, program: anchor.Program): Promise<{ last: number; ready: number; now: number } | null> {
  const x = await (program.account as any).extraState.fetchNullable(PDA_V3.extraState(), "confirmed");
  const last = x ? Number(x.lastPublishTs.toString()) : 0;
  if (!last) return null;
  const now = await chainNow(connection);
  return { last, ready: baseDueAfterExtraV3(last, now).ready, now };
}

/**
 * R-2, before base epoch n: (1) every extra epoch still pending from an earlier week (≤ n − 1) goes out first, and is
 * waited for until final when it is n − 1 (extra n reads X from it); (2) the base epoch is due only once the last paying
 * extra is MIN_EPOCH_INTERVAL + EXTRA_LAG_MARGIN old: a short wait is waited out, a long one returns `notDueUntil`.
 */
async function extraLagV3(connection: Connection, program: anchor.Program, signer: Keypair, n: number): Promise<{ notDueUntil: number | null; problems: string[] }> {
  const problems: string[] = [];
  try {
    const pending = await publishPendingExtrasV3(signer, n - 1);
    problems.push(...pending.problems);
    if (pending.published.includes(n - 1)) {
      await withRetries(
        async () => {
          if (!(await readExtraPublishedV3(connection, program, n - 1, "finalized"))) throw new Error(`ExtraEpochPublished(${n - 1}) is not final yet`);
          return true;
        },
        12, 5_000, (m) => console.log(m),
      );
    }
  } catch (e) {
    problems.push(`extra publication before base epoch ${n}: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
  }
  let r: Awaited<ReturnType<typeof extraIntervalReadyV3>>;
  try {
    r = await extraIntervalReadyV3(connection, program);
  } catch (e) {
    problems.push(`ExtraState could not be read (R-2 interval not checked): ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    return { notDueUntil: null, problems };
  }
  if (!r || r.now >= r.ready) return { notDueUntil: null, problems };
  if (r.ready - r.now <= EXTRA_LAG_WAIT_MAX) {
    console.log(`  the last paying extra epoch landed ${r.now - r.last} s ago: waiting ${r.ready - r.now} s before base epoch ${n} (R-2)`);
    await new Promise((res) => setTimeout(res, (r!.ready - r!.now + 1) * 1000));
    return { notDueUntil: null, problems };
  }
  return { notDueUntil: r.ready, problems };
}

/** `publish-extra [<n>]`: publishes extra-<n>.json, or every pending local extra file in order (the oracle key). */
async function publishExtraCli(arg: number | null) {
  if (arg !== null && (!Number.isInteger(arg) || arg < 1)) throw new Error("usage: publish-extra [<epoch>]");
  const { problems } = await publishPendingExtrasV3(loadKeypair(), null, arg);
  if (problems.length) {
    console.error(`post-publish problems (the extra files are published and written):\n - ${problems.join("\n - ")}`);
    if (process.env.GITHUB_ACTIONS) for (const p of problems) console.log(`::error::${p}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export { PublicKey };
