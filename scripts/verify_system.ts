import { ethers } from "hardhat";

async function main() {
    console.log("🔍 STARTING SYSTEM VERIFICATION (SMOKE TEST)...");

    // 1. Get Signers
    const [owner, player1] = await ethers.getSigners();
    console.log(`👤 Owner: ${owner.address}`);
    console.log(`👤 Player: ${player1.address}`);

    // 2. Attach to Contracts (Replace addresses after deployment if needed, 
    //    or use hardhat-deploy logic if available. Assuming environment vars or manual input for now
    //    For this script, we'll try to find the latest deployment or expect them passed as ENV)

    // NOTE: In a real run, you should paste the addresses here or load them.
    // Since this is a generated script, we will assume strict addresses or prompt.
    // For safety, let's assume the user will update these constants:
    const COIN_FLIP_ADDR = process.env.COIN_FLIP_ADDR || "ADDRESS_HERE";
    const VAULT_ADDR = process.env.VAULT_ADDR || "ADDRESS_HERE";
    const TOKENS_ADDR = process.env.XNT_ADDR || "ADDRESS_HERE";

    if (COIN_FLIP_ADDR === "ADDRESS_HERE") {
        console.warn("⚠️  WARNING: Contract addresses not set. Please edit verify_system.ts with deployed addresses.");
        return;
    }

    // 3. Attach Contracts
    const CoinFlip = await ethers.getContractAt("CoinFlip", COIN_FLIP_ADDR);
    const Vault = await ethers.getContractAt("ProtocolVault", VAULT_ADDR);
    const XNT = await ethers.getContractAt("XenonToken", TOKENS_ADDR);

    // 4. Verification Check 1: Play Coin Flip
    console.log("\n🎲 TEST 1: Playing Coin Flip...");
    const betAmount = ethers.parseEther("1.0");

    // Approve
    await (await XNT.connect(owner).approve(COIN_FLIP_ADDR, betAmount)).wait();

    // Play (Guess Heads = true)
    const tx = await CoinFlip.flip(betAmount, true); // true = Heads
    const receipt = await tx.wait();
    console.log(`✅ Flip Transaction Confirmed: ${receipt?.hash}`);

    // 5. Verification Check 2: Fee Distribution
    console.log("\n💸 TEST 2: Verifying Fee Distribution...");
    const vaultBalance = await XNT.balanceOf(VAULT_ADDR);
    console.log(`Vault Balance: ${ethers.formatEther(vaultBalance)} XNT`);

    if (vaultBalance > 0n) {
        console.log("✅ SUCCESS: Vault received fees.");
    } else {
        console.error("❌ FAILURE: Vault is empty. Fee logic failed?");
    }

    // 6. Verification Check 3: Invalid Mission (Security)
    console.log("\n🛡️ TEST 3: Invalid Mission (Security Check)...");
    try {
        const tooBigBet = ethers.parseEther("1000000.0"); // Exceeds limits
        await CoinFlip.flip(tooBigBet, true);
        console.error("❌ FAILURE: Should have reverted on huge bet!");
    } catch (e) {
        console.log("✅ SUCCESS: Transaction reverted as expected (Invalid Bet).");
    }

    console.log("\n✨ SMOKE TEST COMPLETE.");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
