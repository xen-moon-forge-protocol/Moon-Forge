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
 */
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { CHAINS, EPOCHS_DIR, PROGRAM_ID, RATE_CAP_K } from "./config";
import { Burn, finalHead, readBurns } from "./evm";
import { baseScore, buildTree, ChainSnapshot, computeLeaves, dataHash, eligibleHolders, EpochBody, EpochFile, epochRateCap, toE18, verifyEpochFile } from "./epoch";
import { burnTimePrice, clamp, median, xenMarket, xenTotalSupply, xntUsd } from "./pricing";
import { artifactSnapshot, claimAll, connect, deliverDrops, fetchConfig, keeperPass, loadKeypair, PDA, publishEpoch, sealDrop } from "./x1";

const file = (n: number) => path.join(EPOCHS_DIR, `epoch-${n}.json`);

function readEpoch(n: number): EpochFile | null {
  return fs.existsSync(file(n)) ? JSON.parse(fs.readFileSync(file(n), "utf8")) : null;
}

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

async function runEpoch(dry: boolean) {
  fs.mkdirSync(EPOCHS_DIR, { recursive: true });
  const signer = dry ? undefined : loadKeypair();
  const { connection, program } = connect(signer);
  const cfg = await fetchConfig(program);
  const onChainLast = Number(cfg.lastEpoch);
  const prev = onChainLast > 0 ? readEpoch(onChainLast) : null;
  if (onChainLast > 0 && !prev) throw new Error(`epoch-${onChainLast}.json missing locally — restore it from git before continuing`);
  const n = onChainLast + 1;
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
  if (cmd === "claim") {
    const signer = loadKeypair();
    const { connection, program } = connect(signer);
    const f: EpochFile = JSON.parse(fs.readFileSync(arg, "utf8"));
    console.log(`claimed ${await claimAll(connection, program, signer, f)}`);
    console.log(`drops delivered ${await deliverDrops(connection, program, signer, f)}`);
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
  if (cmd === "keeper") {
    const signer = loadKeypair();
    const { connection, program } = connect(signer);
    // --once: a single pass. --for <seconds>: loop for that long (used by the scheduled
    // GitHub workflow so consecutive runs overlap and draws are settled within seconds).
    const once = process.argv.includes("--once");
    const forIdx = process.argv.indexOf("--for");
    const until = forIdx > 0 ? Date.now() + Number(process.argv[forIdx + 1]) * 1000 : Infinity;
    for (;;) {
      await keeperPass(connection, program, signer, console.log, readAllEpochs()).catch((e) => console.error(e));
      if (once || Date.now() >= until) return;
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  console.log("usage: epoch [--dry] | verify <file> [--full] | claim <file> | keeper [--once | --for <seconds>]");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export { PublicKey };
