import { ethers } from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("🚀 Deploying Moon Forge X1 Suite (v7.1 - Governance Update)...");
    console.log("Account:", deployer.address);

    // 1. Configuration
    const ARCHITECT_WALLET = process.env.ARCHITECT_WALLET || deployer.address;
    const ORACLE_WALLET = process.env.ORACLE_WALLET || deployer.address;

    console.log("Architect:", ARCHITECT_WALLET);
    console.log("Oracle:", ORACLE_WALLET);

    // 2. Deploy MoonForgeBase
    console.log("\n📦 Deploying MoonForgeBase (v7.1)...");
    const MoonForgeBase = await ethers.getContractFactory("MoonForgeBase");
    const base = await MoonForgeBase.deploy(ARCHITECT_WALLET, ORACLE_WALLET);
    await base.waitForDeployment();
    const baseAddress = await base.getAddress();
    console.log("✅ MoonForgeBase deployed to:", baseAddress);

    // 3. Deploy MoonTimeLock
    console.log("\n📦 Deploying MoonTimeLock (v7.1)...");
    const MoonTimeLock = await ethers.getContractFactory("MoonTimeLock");
    const timeLock = await MoonTimeLock.deploy(ARCHITECT_WALLET); // Beneficiary = Architect
    await timeLock.waitForDeployment();
    const timeLockAddress = await timeLock.getAddress();
    console.log("✅ MoonTimeLock deployed to:", timeLockAddress);

    // 4. Deploy MoonArtifacts
    console.log("\n📦 Deploying MoonArtifacts (v7.1)...");
    const MoonArtifacts = await ethers.getContractFactory("MoonArtifacts");
    const artifacts = await MoonArtifacts.deploy(ARCHITECT_WALLET, baseAddress, ORACLE_WALLET);
    await artifacts.waitForDeployment();
    const artifactsAddress = await artifacts.getAddress();
    console.log("✅ MoonArtifacts deployed to:", artifactsAddress);

    // 5. Link Contracts
    console.log("\n🔗 Linking contracts...");

    // Base -> Artifacts
    const tx1 = await base.setArtifactsContract(artifactsAddress);
    await tx1.wait();
    console.log("   - Base linked to Artifacts");

    // Artifacts -> TimeLock
    const tx2 = await artifacts.setTimeLockContract(timeLockAddress);
    await tx2.wait();
    console.log("   - Artifacts linked to TimeLock");

    // Artifacts -> Base (via constructor, but verified)
    console.log("   - Artifacts linked to Base (via constructor)");

    // 6. Initialize Pool
    console.log("\n🎱 Initializing Pool (Minting 1000 NFTs)...");
    // This consumes a lot of gas
    const tx3 = await artifacts.initializePool();
    await tx3.wait();
    console.log("✅ Pool Initialized! 1000 NFTs minted.");

    console.log("\n🎉 DEPLOYMENT COMPLETE v7.1!");
    console.log("----------------------------------------------------");
    console.log("MoonForgeBase:    ", baseAddress);
    console.log("MoonTimeLock:     ", timeLockAddress);
    console.log("MoonArtifacts:    ", artifactsAddress);
    console.log("----------------------------------------------------");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
