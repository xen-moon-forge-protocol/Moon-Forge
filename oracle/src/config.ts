/**
 * Moon Forge Oracle - Configuration
 * 
 * Loads and validates environment variables.
 * All config is loaded from .env file.
 */

import dotenv from 'dotenv';
import path from 'path';

// Load .env from oracle directory
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// ═══════════════════════════════════════════════════════════════════════════
//                              TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface ChainConfig {
    name: string;
    chainId: number;
    rpcUrl: string;
    portalAddress: string;
    startBlock: number;
}

export interface Config {
    chains: {
        ethereum: ChainConfig;
        optimism: ChainConfig;
        bsc?: ChainConfig;        // Unlocks Day 13
        polygon?: ChainConfig;    // Unlocks Day 26
        avalanche?: ChainConfig;  // Unlocks Day 26
        base?: ChainConfig;       // Unlocks Day 39
        pulsechain?: ChainConfig; // Unlocks Day 39
    };
    x1: {
        rpcUrl: string;
        programId: string;       // MoonForge Anchor program ID (Base58) on X1 SVM
        commanderProgramId: string; // MoonCommander NFT program ID (Base58) on X1 SVM
        oraclePrivateKey: string;   // Oracle Solana keypair (Base58 secret key, 64 bytes)
    };
    epoch: {
        cronSchedule: string;
        proofsOutputDir: string;
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//                              VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

function requireEnv(key: string): string {
    const value = process.env[key];
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}

function optionalEnv(key: string, defaultValue: string): string {
    return process.env[key] || defaultValue;
}

// ═══════════════════════════════════════════════════════════════════════════
//                              CONFIG OBJECT
// ═══════════════════════════════════════════════════════════════════════════

export const config: Config = {
    chains: {
        ethereum: {
            name: 'Ethereum',
            chainId: 1,
            rpcUrl: requireEnv('ETH_RPC_URL'),
            portalAddress: requireEnv('ETH_PORTAL_ADDRESS'),
            startBlock: 0, // Will be loaded from state file
        },
        optimism: {
            name: 'Optimism',
            chainId: 10,
            rpcUrl: requireEnv('OP_RPC_URL'),
            portalAddress: requireEnv('OP_PORTAL_ADDRESS'),
            startBlock: 0,
        },
        // BSC — activate Day 13. Set BSC_RPC_URL and BSC_PORTAL_ADDRESS in .env before launch.
        ...(process.env['BSC_RPC_URL'] && process.env['BSC_PORTAL_ADDRESS'] ? {
            bsc: {
                name: 'BNB Chain',
                chainId: 56,
                rpcUrl: process.env['BSC_RPC_URL'],
                portalAddress: process.env['BSC_PORTAL_ADDRESS'],
                startBlock: 0,
            } as ChainConfig,
        } : {}),
        // Polygon — activate Day 26. Set POLYGON_RPC_URL and POLYGON_PORTAL_ADDRESS in .env before launch.
        ...(process.env['POLYGON_RPC_URL'] && process.env['POLYGON_PORTAL_ADDRESS'] ? {
            polygon: {
                name: 'Polygon',
                chainId: 137,
                rpcUrl: process.env['POLYGON_RPC_URL'],
                portalAddress: process.env['POLYGON_PORTAL_ADDRESS'],
                startBlock: 0,
            } as ChainConfig,
        } : {}),
        // Avalanche — activate Day 26. Set AVAX_RPC_URL and AVAX_PORTAL_ADDRESS in .env before launch.
        ...(process.env['AVAX_RPC_URL'] && process.env['AVAX_PORTAL_ADDRESS'] ? {
            avalanche: {
                name: 'Avalanche',
                chainId: 43114,
                rpcUrl: process.env['AVAX_RPC_URL'],
                portalAddress: process.env['AVAX_PORTAL_ADDRESS'],
                startBlock: 0,
            } as ChainConfig,
        } : {}),
        // Base — activate Day 39. Set BASE_RPC_URL and BASE_PORTAL_ADDRESS in .env before launch.
        ...(process.env['BASE_RPC_URL'] && process.env['BASE_PORTAL_ADDRESS'] ? {
            base: {
                name: 'Base',
                chainId: 8453,
                rpcUrl: process.env['BASE_RPC_URL'],
                portalAddress: process.env['BASE_PORTAL_ADDRESS'],
                startBlock: 0,
            } as ChainConfig,
        } : {}),
        // PulseChain — activate Day 39. Set PULSE_RPC_URL and PULSE_PORTAL_ADDRESS in .env before launch.
        ...(process.env['PULSE_RPC_URL'] && process.env['PULSE_PORTAL_ADDRESS'] ? {
            pulsechain: {
                name: 'PulseChain',
                chainId: 369,
                rpcUrl: process.env['PULSE_RPC_URL'],
                portalAddress: process.env['PULSE_PORTAL_ADDRESS'],
                startBlock: 0,
            } as ChainConfig,
        } : {}),
    },
    x1: {
        rpcUrl: requireEnv('X1_RPC_URL'),
        programId: requireEnv('X1_PROGRAM_ID'),
        commanderProgramId: requireEnv('X1_COMMANDER_PROGRAM_ID'),
        oraclePrivateKey: requireEnv('ORACLE_PRIVATE_KEY'),
    },
    epoch: {
        cronSchedule: optionalEnv('EPOCH_CRON', '0 0 * * *'),
        proofsOutputDir: optionalEnv('PROOFS_OUTPUT_DIR', '../frontend/public'),
    },
};

// ═══════════════════════════════════════════════════════════════════════════
//                              CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tier multipliers for score calculation.
 * Higher tier = longer lock = higher multiplier.
 * Official values: 1.0 / 2.0 / 3.0
 */
export const TIER_MULTIPLIERS: Record<number, number> = {
    0: 1.0,  // Launchpad (5 days)
    1: 2.0,  // Orbit (45 days)
    2: 3.0,  // Moon Landing (180 days)
};

/**
 * MoonCommander NFT holder bonus (applied at oracle score level — affects proportional distribution).
 * Note: Artifact NFT boosts (5/10/20/50%) are applied at CONTRACT level by MoonForgeBase.sol
 * on top of the Merkle allocation. They are NOT included in oracle score calculation.
 */
export const NFT_BONUS_MULTIPLIER = 1.1;  // MoonCommander: +10%, oracle-level
export const NO_NFT_MULTIPLIER = 1.0;

/**
 * Artifact Boost Safety Factor
 *
 * MoonArtifacts.sol applies boost AFTER the Oracle allocates XNT via Merkle.
 * If all 1,000 Artifacts are equipped simultaneously, they add up to 8.3% extra
 * demand on the pool beyond the epoch budget:
 *
 *   600 × +5%  = +3,000 units
 *   300 × +10% = +3,000 units
 *    90 × +20% = +1,800 units
 *    10 × +50% =   +500 units
 *   ───────────────────────────
 *   Total extra: 8,300 / 1,000 pilots = +8.3% per pilot average
 *
 * Safety factor = 1 / 1.10 = 0.909 → round down to 0.90 (10% reserve ≥ 8.3% max)
 * The Oracle must set epochBudget = pool_balance × ARTIFACT_BOOST_SAFETY_FACTOR
 * to guarantee the vault never goes dry due to Artifact boosts.
 */
export const ARTIFACT_BOOST_SAFETY_FACTOR = 0.90;

// ═══════════════════════════════════════════════════════════════════════════
//                    STREAK FLYWHEEL — CONSISTENCY INCENTIVE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Streak Flywheel — rewards pilots who burn XEN consistently across epochs.
 *
 * Formula:
 *   Streak_Mult = 1 + min(multiplierCap, logCoefficient × log2(streakEpochs + 1))
 *
 *   streakEpochs | Multiplier | Bonus
 *   ─────────────┼────────────┼──────
 *        1       |   1.050×   | +5.0%   ← immediate reward on return
 *        2       |   1.079×   | +7.9%
 *        3       |   1.100×   | +10.0%
 *        7+      |   1.150×   | +15.0%  ← veteran cap (reached at ~7 epochs)
 *
 * Break rules (forgiving):
 *   Miss 1 epoch  → streak = floor(streak / 2)
 *   Miss 2+ epochs → streak = 0
 *
 * ── MINIMUM BURN FOR STREAK ELIGIBILITY ─────────────────────────────────
 * A burn only counts toward streak if rawScore ≥ minRawScore (10.0).
 * rawScore = √(xenNorm)  where  xenNorm = XEN_burned × CWF(chain)
 *
 * Per-chain XEN minimum (approximate, based on CWF — oracle adjusts each epoch):
 *   Chain       | CWF    | Min XEN to qualify for streak
 *   ────────────┼────────┼──────────────────────────────
 *   Ethereum    | 1.000  | ≥         100 XEN
 *   Optimism    | 0.880  | ≥         115 XEN
 *   Base        | 0.850  | ≥         118 XEN
 *   Avalanche   | 0.095  | ≥       1,053 XEN
 *   BSC         | 0.045  | ≥       2,223 XEN
 *   PulseChain  | 0.020  | ≥       5,000 XEN
 *   Polygon     | 0.010  | ≥      10,000 XEN
 *
 * A single minRawScore applied to CWF-normalised XEN is automatically
 * fair across all chains — no hardcoded per-chain lists to maintain as
 * CWFs drift. When CWF updates each epoch, the effective minimum adapts.
 *
 * Budget safety:
 *   Streak only redistributes within the fixed epochBudget. No new XNT
 *   is created. Total XNT paid ≤ epochBudget always.
 */
export const STREAK_CONFIG = {
    multiplierCap:  0.15,  // +15% maximum bonus
    logCoefficient: 0.05,  // 0.05 × log2(streakEpochs + 1)
    breakHalveAt:   1,     // miss 1 epoch → streak = floor(streak / 2)
    breakResetAt:   2,     // miss 2+ consecutive epochs → streak = 0
    minRawScore:   10.0,   // √(xenNorm) ≥ 10 → xenNorm ≥ 100 CWF-adjusted XEN
} as const;

// ═══════════════════════════════════════════════════════════════════════════
//                         CWF — CHAIN WEIGHT FACTOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * CWF configuration.
 * The CWF normalises XEN burned across chains by combining:
 *
 *   ISF = AMP_max / AMP_current          (inflation scarcity factor)
 *   GCF = eth_gas / chain_gas            (gas cost factor — transaction economic effort)
 *   PF  = (price_chain_EMA / price_ETH_EMA) ^ exponent  (price factor — supply scarcity)
 *
 * Full formula: CWF(chain) = normalize( ISF × GCF × PF ) → ETH always = 1.0
 *
 * PF introduces market price awareness: as burns on a chain reduce supply,
 * the XEN price on that chain rises, increasing PF and rewarding future burners.
 * Cube-root dampening (^0.33) ensures AMP + gas remain the primary drivers.
 *
 * PF fallback: if price cannot be fetched (PulseChain, API failure, etc.), PF = 1.0.
 * priceFactorEnabled = false → PF = 1.0 for all chains (classic CWF v1 behaviour).
 */
export const CWF_CONFIG = {
    ampMax: 3000,             // AMP starting value (all chains)
    maxChangePerEpoch: 0.20,  // max ±20% movement per epoch
    minCwf: 0.001,            // absolute floor
    gasFallbacks: {           // fallback gas prices in Gwei if RPC fails
        1:     20,   // Ethereum   — L1 base fee, volatile (~15-40 Gwei)
        10:    0.5,  // Optimism   — L2 Bedrock, near zero (gas paid in ETH via sequencer)
        56:    1,    // BSC        — fixed at ~1 Gwei (gwei in BNB, cheap)
        137:   50,   // Polygon    — PoS, gas in MATIC (50 Gwei typical, cheap in USD)
        43114: 25,   // Avalanche  — C-Chain, gas in AVAX (~25 Gwei typical)
        8453:  0.1,  // Base       — L2 Coinbase/Bedrock, even cheaper than OP
        369:   10,   // PulseChain — L1 PoS, gas in PLS (massive supply, cheap gas)
    } as Record<number, number>,

    // ── Price Factor (PF) ─────────────────────────────────────────────────
    // Adds market price awareness to CWF without letting price dominate.
    //
    // PF(chain) = clamp( (price_chain_EMA / price_ETH_EMA) ^ exponent,
    //                     1 / maxImpact,  maxImpact )
    //
    // Effect table (exponent = 0.33, maxImpact = 5×):
    //   chain price / ETH price | PF      | Interpretation
    //   ────────────────────────┼─────────┼──────────────────────────────────
    //   100×  (chain expensive) | 4.64×   | chain XEN scarce → big bonus
    //    10×                    | 2.15×   | moderate scarcity bonus
    //     1×  (parity)          | 1.00×   | neutral (no PF effect)
    //    0.1×                   | 0.46×   | chain XEN abundant → small penalty
    //    0.01× (100× cheaper)   | 0.22×   | heavy penalty (further dampens low-CWF chains)
    //
    // Note: ETH PF = 1.0 always. After normalization, ETH CWF remains 1.0.
    priceFactorEnabled:    true,  // toggle — set false to revert to CWF v1 (ISF × GCF only)
    priceFactorEMAPeriods: 7,     // 7-epoch rolling average — smooths manipulation attempts
    priceFactorExponent:   0.33,  // cube-root dampening — price secondary to AMP + gas
    priceFactorMaxImpact:  5.0,   // hard cap: PF ∈ [0.2×, 5×] — prevents runaway scores
};

/**
 * Static CWF defaults (epoch 0 seed).
 * Recalculated dynamically each epoch by the oracle.
 */
export const CWF_DEFAULTS: Record<number, number> = {
    1:     1.000, // Ethereum   — benchmark (anchor)
    10:    0.880, // Optimism   — near-deflationary (AMP=1), close to ETH
    56:    0.045, // BSC        — ~22x more XEN needed vs ETH
    137:   0.010, // Polygon    — ~100x more XEN needed (massive supply)
    43114: 0.095, // Avalanche  — ~10x more XEN needed vs ETH
    8453:  0.850, // Base       — Coinbase L2, similar behavior to Optimism
    369:   0.020, // PulseChain — very low gas, high supply (similar to BSC, slightly higher)
};

/**
 * XEN contract ABI — only what we need for CWF calculation.
 */
export const XEN_AMP_ABI = [
    'function getCurrentAMP() view returns (uint256)',
];

/**
 * MoonForgePortal ABI (only events we need)
 * IMPORTANT: referrer must be included or ethers.js will misalign all subsequent params.
 */
export const PORTAL_ABI = [
    'event MissionStarted(address indexed pilot, uint256 amount, uint8 indexed missionTier, string x1TargetAddress, address referrer, uint256 timestamp)',
];

/**
 * MoonForgeBase ABI (only functions we need)
 */
export const BASE_ABI = [
    'function updateEpoch(uint256 epoch, bytes32 root) external',
    'function currentEpoch() view returns (uint256)',
    'function merkleRoot() view returns (bytes32)',
    'function epochVolume(uint256 epoch) view returns (uint256)',
];

/**
 * MoonCommander ABI (for NFT holder check)
 */
export const COMMANDER_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
];

console.log('✅ Configuration loaded successfully');
console.log(`   📡 Ethereum RPC: ${config.chains.ethereum.rpcUrl.substring(0, 30)}...`);
console.log(`   📡 Optimism RPC: ${config.chains.optimism.rpcUrl.substring(0, 30)}...`);
console.log(`   🌙 X1 RPC: ${config.x1.rpcUrl.substring(0, 30)}...`);
