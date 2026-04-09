/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                  MOON FORGE — PORTAL DEPLOYMENT (EVM chains)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Deploys MoonForgePortal.sol on each EVM chain where XEN exists.
 * Run once per chain with the correct --network flag.
 *
 * The Portal is 100% immutable (no owner, no admin, no upgradability).
 * It only emits events — the oracle reads them off-chain.
 *
 * XEN contract addresses by chain:
 *   Ethereum  (1):     0x06450dEe7FD2Fb8E39061434BAbCfc05599a6Fb8
 *   Optimism  (10):    0xeB585163DEbb1E637c6D617de3bef99347CD75c8
 *   BSC       (56):    0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e
 *   Polygon   (137):   0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e
 *   Avalanche (43114): 0xC0C5AA69Dbe4d6DDdfBc89c0957686ec60F24389
 *   Base      (8453):  0xffcbF84650cE02DaFE96926B37a0ac5E34932fa5
 *   Pulsechain(369):   0x8a7FDcA264e87b6da72D000f22186B4403081A2a
 *
 * Usage:
 *   npx hardhat run scripts/deploy_portal.ts --network mainnet
 *   npx hardhat run scripts/deploy_portal.ts --network optimism
 *   npx hardhat run scripts/deploy_portal.ts --network bsc
 *   npx hardhat run scripts/deploy_portal.ts --network polygon
 *   npx hardhat run scripts/deploy_portal.ts --network avalanche
 *   npx hardhat run scripts/deploy_portal.ts --network base
 *   npx hardhat run scripts/deploy_portal.ts --network pulsechain
 *
 * Optional override (for testnet or new chain):
 *   XEN_ADDRESS=0x... npx hardhat run scripts/deploy_portal.ts --network sepolia
 */

import { ethers } from "hardhat";

// XEN token addresses by chainId
const XEN_BY_CHAIN: Record<number, string> = {
    1:     "0x06450dEe7FD2Fb8E39061434BAbCfc05599a6Fb8", // Ethereum
    10:    "0xeB585163DEbb1E637c6D617de3bef99347CD75c8", // Optimism
    56:    "0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e", // BSC
    137:   "0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e", // Polygon
    43114: "0xC0C5AA69Dbe4d6DDdfBc89c0957686ec60F24389", // Avalanche C-Chain
    8453:  "0xffcbF84650cE02DaFE96926B37a0ac5E34932fa5", // Base
    369:   "0x8a7FDcA264e87b6da72D000f22186B4403081A2a", // PulseChain
};

async function main() {
    const [deployer] = await ethers.getSigners();
    const network    = await ethers.provider.getNetwork();
    const chainId    = Number(network.chainId);

    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("          MOON FORGE — PORTAL DEPLOYMENT");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`Network:   ${network.name} (chainId: ${chainId})`);
    console.log(`Deployer:  ${deployer.address}`);
    console.log(`Balance:   ${ethers.formatEther(await deployer.provider.getBalance(deployer.address))} native`);
    console.log();

    // Resolve XEN address: env override → known chain map → fail
    let xenAddress: string;
    if (process.env.XEN_ADDRESS) {
        xenAddress = process.env.XEN_ADDRESS;
        console.log(`XEN override from env: ${xenAddress}`);
    } else if (XEN_BY_CHAIN[chainId]) {
        xenAddress = XEN_BY_CHAIN[chainId];
        console.log(`XEN from built-in map: ${xenAddress}`);
    } else {
        throw new Error(
            `No XEN address known for chainId ${chainId}. ` +
            `Set XEN_ADDRESS=0x... in your environment to override.`
        );
    }

    // Normalize to checksummed address (handles mixed-case input)
    xenAddress = ethers.getAddress(xenAddress.toLowerCase());

    if (!ethers.isAddress(xenAddress)) {
        throw new Error(`XEN address is invalid: ${xenAddress}`);
    }

    console.log("\nDeploying MoonForgePortal...");
    const MoonForgePortal = await ethers.getContractFactory("MoonForgePortal");
    const portal = await MoonForgePortal.deploy(xenAddress);
    await portal.waitForDeployment();
    const portalAddr = await portal.getAddress();

    console.log(`\nMoonForgePortal deployed:`);
    console.log(`  Address:     ${portalAddr}`);
    console.log(`  XEN Token:   ${xenAddress}`);
    console.log(`  Chain:       ${network.name} (${chainId})`);
    console.log(`  Deployer:    ${deployer.address}`);

    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("Add to your frontend constants.ts portalAddress for this chain:");
    console.log(`  chainId ${chainId}: "${portalAddr}"`);
    console.log("\nVerify contract (optional):");
    console.log(`  npx hardhat verify --network ${network.name} ${portalAddr} "${xenAddress}"`);
    console.log("═══════════════════════════════════════════════════════════\n");
}

main().catch((error) => {
    console.error("\nFATAL ERROR during portal deployment:");
    console.error(error);
    process.exitCode = 1;
});
