import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
//  SECURITY: PRIVATE_KEY must be set in .env — NEVER hardcoded here.
//  Use a dedicated deployer wallet. Never use your personal main wallet.
//  The same EVM private key works on all chains (ETH, OP, BSC, Polygon, etc.).
//
//  X1 is SVM (Solana Virtual Machine) — NOT deployed via Hardhat.
//  X1 contracts are Anchor programs deployed with `anchor deploy`.
// ─────────────────────────────────────────────────────────────────────────────

const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
    console.warn("⚠️  PRIVATE_KEY not set in .env — deploy tasks will fail. Set it before deploying.");
}

// Hardhat requires an accounts array even if key is missing (use dummy for compilation)
const accounts = PRIVATE_KEY ? [PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
    solidity: {
        version: "0.8.20",
        settings: {
            optimizer: {
                enabled: true,
                runs: 200,
            },
            // Required for contracts with many local variables (avoids "stack too deep")
            viaIR: true,
        },
    },

    networks: {
        // ── LOCAL ──────────────────────────────────────────────────────────────
        hardhat: {},

        // ── TESTNETS ───────────────────────────────────────────────────────────
        sepolia: {
            url: process.env.SEPOLIA_RPC || "https://rpc.sepolia.org",
            accounts,
            chainId: 11155111,
        },

        // ── EVM MAINNETS ───────────────────────────────────────────────────────
        // MoonForgePortal.sol is deployed on each of these chains.
        // Use the same deployer wallet address on all chains.

        mainnet: {
            url: process.env.ETH_RPC || "https://eth.llamarpc.com",
            accounts,
            chainId: 1,
        },
        optimism: {
            url: process.env.OP_RPC || "https://mainnet.optimism.io",
            accounts,
            chainId: 10,
        },
        bsc: {
            url: process.env.BSC_RPC || "https://bsc-dataseed.binance.org",
            accounts,
            chainId: 56,
        },
        polygon: {
            url: process.env.POLYGON_RPC || "https://polygon.llamarpc.com",
            accounts,
            chainId: 137,
        },
        avalanche: {
            url: process.env.AVAX_RPC || "https://api.avax.network/ext/bc/C/rpc",
            accounts,
            chainId: 43114,
        },
        base: {
            url: process.env.BASE_RPC || "https://mainnet.base.org",
            accounts,
            chainId: 8453,
        },
        pulsechain: {
            url: process.env.PULSE_RPC || "https://rpc.pulsechain.com",
            accounts,
            chainId: 369,
        },

        // NOTE: X1 is SVM — deploy with `anchor deploy`, not Hardhat.
        // See oracle/src/config.ts for X1 RPC and program IDs.
    },

    etherscan: {
        apiKey: {
            mainnet:    process.env.ETHERSCAN_API_KEY        || "",
            optimisticEthereum: process.env.OPTIMISTIC_ETHERSCAN_API_KEY || "",
            bsc:        process.env.BSCSCAN_API_KEY          || "",
            polygon:    process.env.POLYGONSCAN_API_KEY      || "",
            avalanche:  process.env.SNOWTRACE_API_KEY        || "",
            base:       process.env.BASESCAN_API_KEY         || "",
        },
    },

    paths: {
        sources:   "./contracts",
        tests:     "./test",
        cache:     "./cache",
        artifacts: "./artifacts",
    },
};

export default config;
