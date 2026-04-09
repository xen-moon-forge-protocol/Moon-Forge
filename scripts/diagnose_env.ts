import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

async function main() {
    console.log("🔍 DIAGNOSTIC: Checking Environment...");
    console.log(`📂 Current Directory: ${process.cwd()}`);

    // 1. Check for .env file
    const envPath = path.join(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
        console.log("✅ FOUND: .env file exists.");
    } else {
        console.error("❌ MISSING: .env file NOT found in root!");
        console.log("   -> Please create a file named '.env' here.");
    }

    // 2. Load Dotenv manually to test
    dotenv.config();

    // 3. Check PRIVATE_KEY
    const key = process.env.PRIVATE_KEY;
    if (!key) {
        console.error("❌ MISSING: process.env.PRIVATE_KEY is undefined.");
    } else if (key.startsWith("0000000")) {
        console.error("❌ INVALID: PRIVATE_KEY appears to be the default zero-string?");
    } else {
        console.log(`✅ LOADED: PRIVATE_KEY found (Length: ${key.length}).`);
        if (key.startsWith("0x")) {
            console.warn("⚠️  WARNING: PRIVATE_KEY starts with '0x'. Hardhat might expect raw hex. If deploy fails, try removing '0x'.");
        }
    }

    // 4. Check RPC
    const rpc = process.env.SEPOLIA_RPC;
    if (rpc) {
        console.log(`✅ LOADED: SEPOLIA_RPC found (${rpc})`);
    } else {
        console.warn("⚠️  WARNING: SEPOLIA_RPC not set. Using default fallback?");
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
