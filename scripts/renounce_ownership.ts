/**
 * ═══════════════════════════════════════════════════════════════════════════
 *               MOON FORGE — RENOUNCE OWNERSHIP (stand-alone)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Call this ONLY after all setup is complete:
 *   - setArtifactsContract() done on MoonForgeBase
 *   - setTimeLockContract() done on MoonArtifacts
 *   - setBaseURI() done on MoonArtifacts (if using IPFS metadata)
 *   - initializePool() done on MoonArtifacts (locks vault + URI)
 *
 * After running this script, NOTHING can be changed by anyone.
 *
 * Required .env variables:
 *   CONTRACT_BASE       — MoonForgeBase address
 *   CONTRACT_ARTIFACTS  — MoonArtifacts address
 *   CONTRACT_DEV_ESCROW — DevEscrow address
 *   CONTRACT_LOTTERY    — MoonLottery address
 *
 * Usage:
 *   npx hardhat run scripts/renounce_ownership.ts --network <network>
 */

import { ethers } from "hardhat";

function requireAddress(name: string): string {
    const val = process.env[name];
    if (!val || !ethers.isAddress(val)) {
        throw new Error(`Missing or invalid env var: ${name}`);
    }
    return val;
}

async function main() {
    const [deployer] = await ethers.getSigners();
    const network    = await ethers.provider.getNetwork();

    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("         MOON FORGE — RENOUNCE OWNERSHIP SEQUENCE");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`Network:   ${network.name}`);
    console.log(`Signer:    ${deployer.address}`);
    console.log();

    const baseAddr      = requireAddress("CONTRACT_BASE");
    const artifactsAddr = requireAddress("CONTRACT_ARTIFACTS");
    const escrowAddr    = requireAddress("CONTRACT_DEV_ESCROW");
    const lotteryAddr   = requireAddress("CONTRACT_LOTTERY");

    const abi = ["function renounceOwnership() external", "function owner() view returns (address)"];

    const base      = new ethers.Contract(baseAddr,      abi, deployer);
    const artifacts = new ethers.Contract(artifactsAddr, abi, deployer);
    const escrow    = new ethers.Contract(escrowAddr,    abi, deployer);
    const lottery   = new ethers.Contract(lotteryAddr,   abi, deployer);

    // Verify deployer is owner before renouncing
    const checkOwner = async (name: string, contract: ethers.Contract) => {
        const owner = await contract.owner();
        if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
            throw new Error(`${name}: deployer is not the owner (owner = ${owner})`);
        }
        console.log(`${name}: owner verified (${owner})`);
    };

    await checkOwner("MoonForgeBase", base);
    await checkOwner("MoonArtifacts", artifacts);
    await checkOwner("DevEscrow",     escrow);
    await checkOwner("MoonLottery",   lottery);

    console.log("\nAll ownership checks passed. Renouncing...\n");

    await (await base.renounceOwnership()).wait();
    console.log("MoonForgeBase: renounced");

    await (await artifacts.renounceOwnership()).wait();
    console.log("MoonArtifacts: renounced");

    await (await escrow.renounceOwnership()).wait();
    console.log("DevEscrow:     renounced");

    await (await lottery.renounceOwnership()).wait();
    console.log("MoonLottery:   renounced");

    console.log("\nAll ownership renounced. Moon Forge is now fully autonomous.");
    console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch((error) => {
    console.error("\nFATAL ERROR:");
    console.error(error);
    process.exitCode = 1;
});
