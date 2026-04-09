/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                    MOON FORGE — FULL DEPLOYMENT SCRIPT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Deploys ALL game and NFT contracts in the correct order, links them,
 * initializes the NFT pool, and renounces ownership for full immutability.
 *
 * NOTE: This script deploys the game/reward-side contracts.
 *       MoonForgePortal.sol (XEN burning on each EVM chain) is deployed
 *       separately via: npx hardhat run scripts/deploy_portal.ts --network <chain>
 *
 * Required .env variables:
 *   PRIVATE_KEY              — Deployer wallet private key (pays gas only, no protocol power after renounce)
 *   DEV_WALLET_0             — DevSplitter recipient 0 (receives share of 2% dev fee — immutable after deploy)
 *   DEV_WALLET_1             — DevSplitter recipient 1 (set same as 0 if unused)
 *   DEV_WALLET_2             — DevSplitter recipient 2 (set same as 0 if unused)
 *   DEV_SHARE_0              — BPS share for wallet 0 (e.g. 10000 for 100%)
 *   DEV_SHARE_1              — BPS share for wallet 1 (e.g. 0)
 *   DEV_SHARE_2              — BPS share for wallet 2 (e.g. 0)
 *   ORACLE_WALLET            — Oracle hot wallet (receives 1% fee — whoever runs the oracle VPS)
 *   NFT_BASE_URI             — IPFS base URI for NFT metadata (optional — set after IPFS upload)
 *
 * Usage:
 *   npx hardhat run scripts/deploy_final.ts --network <network>
 *
 * After deployment, update frontend/.env and oracle/.env with printed addresses.
 *
 * IMMUTABILITY SEQUENCE (automated in this script):
 *   1. Deploy DevSplitter (immutable from birth)
 *   2. Deploy DevEscrow (empty Ownable — owner will be renounced)
 *   3. Deploy MoonForgeBase (vault, with DevSplitter + DevEscrow + Oracle)
 *   4. Deploy MoonTimeLock
 *   5. Deploy MoonArtifacts (NFT contract)
 *   6. Link: MoonForgeBase.setArtifactsContract()
 *   7. Link: MoonArtifacts.setTimeLockContract()
 *   8. Set NFT base URI (if provided)
 *   9. Initialize NFT pool (1000 NFTs — locks vault and URI)
 *  10. Deploy all game contracts
 *  11. renounceOwnership() on MoonForgeBase, MoonArtifacts, DevEscrow
 */

import { ethers } from "hardhat";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
    const val = process.env[name];
    if (!val) throw new Error(`CRITICAL STOP: '${name}' missing in .env`);
    return val;
}

function requireAddress(name: string): string {
    const val = requireEnv(name);
    if (!ethers.isAddress(val)) throw new Error(`CRITICAL STOP: '${name}' is not a valid address: ${val}`);
    return val;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const [deployer] = await ethers.getSigners();
    const network    = await ethers.provider.getNetwork();

    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("          MOON FORGE — FULL DEPLOYMENT SEQUENCE");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`Network:   ${network.name} (chainId: ${network.chainId})`);
    console.log(`Deployer:  ${deployer.address}`);
    console.log(`Balance:   ${ethers.formatEther(await deployer.provider.getBalance(deployer.address))} native`);
    console.log("───────────────────────────────────────────────────────────\n");

    // ── Read config ──────────────────────────────────────────────────────────
    const DEV_WALLET_0  = requireAddress("DEV_WALLET_0");
    const DEV_WALLET_1  = requireAddress("DEV_WALLET_1");
    const DEV_WALLET_2  = requireAddress("DEV_WALLET_2");
    const DEV_SHARE_0   = parseInt(requireEnv("DEV_SHARE_0"));
    const DEV_SHARE_1   = parseInt(requireEnv("DEV_SHARE_1"));
    const DEV_SHARE_2   = parseInt(requireEnv("DEV_SHARE_2"));
    const ORACLE_WALLET = requireAddress("ORACLE_WALLET");
    const NFT_BASE_URI  = process.env.NFT_BASE_URI || ""; // optional

    if (DEV_SHARE_0 + DEV_SHARE_1 + DEV_SHARE_2 !== 10000) {
        throw new Error("DEV_SHARE_0 + DEV_SHARE_1 + DEV_SHARE_2 must equal 10000");
    }

    console.log("Config verified:");
    console.log(`  DevWallet 0: ${DEV_WALLET_0}  (${DEV_SHARE_0 / 100}%)`);
    console.log(`  DevWallet 1: ${DEV_WALLET_1}  (${DEV_SHARE_1 / 100}%)`);
    console.log(`  DevWallet 2: ${DEV_WALLET_2}  (${DEV_SHARE_2 / 100}%)`);
    console.log(`  Oracle:      ${ORACLE_WALLET}`);
    if (NFT_BASE_URI) console.log(`  NFT URI:     ${NFT_BASE_URI}`);
    console.log();

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1 — DevSplitter (immutable from birth)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("STEP 1 — Deploying DevSplitter...");
    const DevSplitter = await ethers.getContractFactory("DevSplitter");
    const devSplitter = await DevSplitter.deploy(
        DEV_WALLET_0, DEV_WALLET_1, DEV_WALLET_2,
        DEV_SHARE_0,  DEV_SHARE_1,  DEV_SHARE_2
    );
    await devSplitter.waitForDeployment();
    const devSplitterAddr = await devSplitter.getAddress();
    console.log(`         DevSplitter:   ${devSplitterAddr}`);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2 — DevEscrow (time-vested dev cut)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("STEP 2 — Deploying DevEscrow...");
    const DevEscrow = await ethers.getContractFactory("DevEscrow");
    const devEscrow = await DevEscrow.deploy();
    await devEscrow.waitForDeployment();
    const devEscrowAddr = await devEscrow.getAddress();
    console.log(`         DevEscrow:     ${devEscrowAddr}`);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 3 — MoonForgeBase (vault + epoch rewards)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("STEP 3 — Deploying MoonForgeBase...");
    const MoonForgeBase = await ethers.getContractFactory("MoonForgeBase");
    const base = await MoonForgeBase.deploy(devSplitterAddr, devEscrowAddr, ORACLE_WALLET);
    await base.waitForDeployment();
    const baseAddr = await base.getAddress();
    console.log(`         MoonForgeBase: ${baseAddr}`);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 4 — MoonTimeLock (architect vesting)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("STEP 4 — Deploying MoonTimeLock...");
    const MoonTimeLock = await ethers.getContractFactory("MoonTimeLock");
    const timeLock = await MoonTimeLock.deploy(devSplitterAddr); // beneficiary = DevSplitter
    await timeLock.waitForDeployment();
    const timeLockAddr = await timeLock.getAddress();
    console.log(`         MoonTimeLock:  ${timeLockAddr}`);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 5 — MoonArtifacts (NFT)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("STEP 5 — Deploying MoonArtifacts...");
    const MoonArtifacts = await ethers.getContractFactory("MoonArtifacts");
    const artifacts = await MoonArtifacts.deploy(devSplitterAddr, baseAddr, ORACLE_WALLET);
    await artifacts.waitForDeployment();
    const artifactsAddr = await artifacts.getAddress();
    console.log(`         MoonArtifacts: ${artifactsAddr}`);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 6 — Link contracts
    // ═══════════════════════════════════════════════════════════════════════
    console.log("STEP 6 — Linking contracts...");

    console.log("  -> MoonForgeBase.setArtifactsContract()");
    await (await (base as any).setArtifactsContract(artifactsAddr)).wait();

    console.log("  -> MoonArtifacts.setTimeLockContract()");
    await (await (artifacts as any).setTimeLockContract(timeLockAddr)).wait();

    if (NFT_BASE_URI) {
        console.log("  -> MoonArtifacts.setBaseURI()");
        await (await (artifacts as any).setBaseURI(NFT_BASE_URI)).wait();
    } else {
        console.log("  -> setBaseURI() skipped (NFT_BASE_URI not set — set before pool init if needed)");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 7 — Initialize NFT pool (LOCKS vault and URI — do after setBaseURI)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("STEP 7 — Initializing NFT pool (minting 1000 NFTs)...");
    console.log("         This may take a while and consume significant gas.");
    const initTx = await (artifacts as any).initializePool();
    await initTx.wait();
    console.log("         NFT Pool initialized. Vault and URI are now LOCKED.");

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 8 — Deploy game contracts
    // ═══════════════════════════════════════════════════════════════════════
    console.log("STEP 8 — Deploying game contracts...");

    const MoonGames = await ethers.getContractFactory("MoonGames");
    const moonGames = await MoonGames.deploy(baseAddr, ORACLE_WALLET);
    await moonGames.waitForDeployment();
    const moonGamesAddr = await moonGames.getAddress();
    console.log(`         MoonGames:       ${moonGamesAddr}`);

    const MoonVoidRush = await ethers.getContractFactory("MoonVoidRush");
    const voidRush = await MoonVoidRush.deploy(baseAddr, ORACLE_WALLET);
    await voidRush.waitForDeployment();
    const voidRushAddr = await voidRush.getAddress();
    console.log(`         MoonVoidRush:    ${voidRushAddr}`);

    const MoonJackpot = await ethers.getContractFactory("MoonJackpot");
    const jackpot = await MoonJackpot.deploy(baseAddr, ORACLE_WALLET);
    await jackpot.waitForDeployment();
    const jackpotAddr = await jackpot.getAddress();
    console.log(`         MoonJackpot:     ${jackpotAddr}`);

    const MoonLottery = await ethers.getContractFactory("MoonLottery");
    const lottery = await MoonLottery.deploy(ORACLE_WALLET);
    await lottery.waitForDeployment();
    const lotteryAddr = await lottery.getAddress();
    console.log(`         MoonLottery:     ${lotteryAddr}`);

    const MoonPredictions = await ethers.getContractFactory("MoonPredictions");
    // resolverOracle = ORACLE_WALLET (same oracle resolves predictions)
    const predictions = await MoonPredictions.deploy(baseAddr, ORACLE_WALLET);
    await predictions.waitForDeployment();
    const predictionsAddr = await predictions.getAddress();
    console.log(`         MoonPredictions: ${predictionsAddr}`);

    // ArtifactDuel — pass artifactsContract for full NFT integration
    const ArtifactDuel = await ethers.getContractFactory("ArtifactDuel");
    const artifactDuel = await ArtifactDuel.deploy(baseAddr, ORACLE_WALLET, artifactsAddr);
    await artifactDuel.waitForDeployment();
    const artifactDuelAddr = await artifactDuel.getAddress();
    console.log(`         ArtifactDuel:    ${artifactDuelAddr}`);

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 9 — Renounce ownership (POINT OF NO RETURN)
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\nSTEP 9 — Renouncing ownership (IRREVERSIBLE)...");
    console.log("         After this step, NO ONE can change any configuration.");

    await (await (base as any).renounceOwnership()).wait();
    console.log("         MoonForgeBase: ownership renounced");

    await (await (artifacts as any).renounceOwnership()).wait();
    console.log("         MoonArtifacts: ownership renounced");

    await (await (devEscrow as any).renounceOwnership()).wait();
    console.log("         DevEscrow:     ownership renounced");

    // Note: MoonLottery has pause/unpause via owner.
    // If you want to keep pause capability, do NOT renounce MoonLottery.
    // For full immutability, renounce it too:
    await (await (lottery as any).renounceOwnership()).wait();
    console.log("         MoonLottery:   ownership renounced");

    // ═══════════════════════════════════════════════════════════════════════
    // FINAL SUMMARY
    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("   DEPLOYMENT COMPLETE — COPY THESE TO YOUR .env FILES");
    console.log("═══════════════════════════════════════════════════════════");
    console.log();
    console.log("# ── Core ──────────────────────────────────────────────────");
    console.log(`VITE_CONTRACT_BASE=${baseAddr}`);
    console.log(`VITE_CONTRACT_ARTIFACTS=${artifactsAddr}`);
    console.log(`VITE_CONTRACT_TIMELOCK=${timeLockAddr}`);
    console.log(`VITE_CONTRACT_DEV_SPLITTER=${devSplitterAddr}`);
    console.log(`VITE_CONTRACT_DEV_ESCROW=${devEscrowAddr}`);
    console.log();
    console.log("# ── Games ─────────────────────────────────────────────────");
    console.log(`VITE_CONTRACT_GAMES=${moonGamesAddr}`);
    console.log(`VITE_CONTRACT_VOIDRUSH=${voidRushAddr}`);
    console.log(`VITE_CONTRACT_JACKPOT=${jackpotAddr}`);
    console.log(`VITE_CONTRACT_LOTTERY=${lotteryAddr}`);
    console.log(`VITE_CONTRACT_PREDICTIONS=${predictionsAddr}`);
    console.log(`VITE_CONTRACT_ARTIFACT_DUEL=${artifactDuelAddr}`);
    console.log();
    console.log("═══════════════════════════════════════════════════════════");
    console.log("NEXT STEPS:");
    console.log("  1. Copy addresses above to frontend/.env and oracle/.env");
    console.log("  2. Fund game contracts with initial XNT liquidity");
    console.log("     (MoonGames, MoonVoidRush, MoonJackpot, ArtifactDuel)");
    console.log("     Use their deposit() function or send directly.");
    console.log("  3. Fund MoonLottery separately (lottery tickets fund the pool).");
    console.log("  4. Deploy MoonForgePortal on each EVM chain separately:");
    console.log("     npx hardhat run scripts/deploy_portal.ts --network mainnet");
    console.log("     npx hardhat run scripts/deploy_portal.ts --network optimism");
    console.log("     npx hardhat run scripts/deploy_portal.ts --network bsc");
    console.log("     npx hardhat run scripts/deploy_portal.ts --network polygon");
    console.log("     npx hardhat run scripts/deploy_portal.ts --network avalanche");
    console.log("  5. Verify contracts on explorers (optional):");
    console.log("     npx hardhat verify --network <net> <address> <constructor-args>");
    console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch((error) => {
    console.error("\nFATAL ERROR during deployment:");
    console.error(error);
    process.exitCode = 1;
});
