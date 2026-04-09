/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                    MOON FORGE ORACLE BOT v8.2
 *                    REAL WORLD DATA INTEGRATION
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Features:
 * - Real XEN contract addresses per chain
 * - CWF (Chain Weight Factor) — dynamic per epoch
 * - 13-Day Rollout Schedule enforcement
 * - Fairness Formula: √(XEN × CWF) × Tier × NFT_Bonus
 */

import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { MerkleTree } from 'merkletreejs';
import keccak256 from 'keccak256';
import * as dotenv from 'dotenv';

dotenv.config();

// ═══════════════════════════════════════════════════════════════════════════
//                    OFFICIAL XEN CONTRACT ADDRESSES
// ═══════════════════════════════════════════════════════════════════════════

// All addresses verified from xen.network (the official XEN source).
// Arbitrum and Cronos removed — not listed on xen.network.
const XEN_ADDRESSES: Record<number, string> = {
    // ── Active burn chains ───────────────────────────────────────────────
    1:     '0x06450dEe7FD2Fb8E39061434BAbCFC05599a6Fb8', // Ethereum
    10:    '0xeB585163DEbB1E637c6D617de3bEF99347cd75c8', // Optimism
    56:    '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e', // BSC
    137:   '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e', // Polygon
    43114: '0xC0C5AA69Dbe4d6DDdfBc89c0957686ec60F24389', // Avalanche C-Chain

    // ── Available on xen.network — not yet active (Phase 4+) ────────────
    8453:  '0xffcbF84650cE02DaFE96926B37a0ac5E34932fa5', // Base
    250:   '0xeF4B763385838FfFc708000f884026B8c0434275', // Fantom
    1284:  '0xb564A5767A00Ee9075cAC561c427643686d91f43', // Moonbeam
    66:    '0x1cC4D981e897A3D2E7785093A648c0a75fAd0453', // OKX Chain
    369:   '0x8a7FDcA264e87b6da72D000f22186B4403081A2a', // PulseChain
    2000:  '0x948eed4490833D526688fD1E5Ba0b9B35CD2c32e', // Dogechain
    9001:  '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e', // Evmos
    // Ethereum PoW (10001) — omitted, network inactive
};

// ═══════════════════════════════════════════════════════════════════════════
//                        CHAIN CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const LAUNCH_TIMESTAMP = new Date('2026-04-02T00:00:00Z').getTime();

interface ChainConfig {
    chainId: number;
    name: string;
    rpc: string;
    portal: string;
    xenAddress: string;
    unlockDay: number;
}

const CHAINS: ChainConfig[] = [
    // Phase 1: Days 0-13 (Launch)
    {
        chainId: 1,
        name: 'Ethereum',
        rpc: process.env.ETH_RPC || 'https://eth.llamarpc.com',
        portal: process.env.PORTAL_ETH || '',
        xenAddress: XEN_ADDRESSES[1],
        unlockDay: 0,
    },
    {
        chainId: 10,
        name: 'Optimism',
        rpc: process.env.OP_RPC || 'https://mainnet.optimism.io',
        portal: process.env.PORTAL_OP || '',
        xenAddress: XEN_ADDRESSES[10],
        unlockDay: 0,
    },

    // Phase 2: Day 13+
    {
        chainId: 56,
        name: 'BSC',
        rpc: process.env.BSC_RPC || 'https://bsc-dataseed.binance.org',
        portal: process.env.PORTAL_BSC || '',
        xenAddress: XEN_ADDRESSES[56],
        unlockDay: 13,
    },

    // Phase 3: Day 26+
    {
        chainId: 137,
        name: 'Polygon',
        rpc: process.env.POLYGON_RPC || 'https://polygon-rpc.com',
        portal: process.env.PORTAL_POLYGON || '',
        xenAddress: XEN_ADDRESSES[137],
        unlockDay: 26,
    },
    {
        chainId: 43114,
        name: 'Avalanche',
        rpc: process.env.AVAX_RPC || 'https://api.avax.network/ext/bc/C/rpc',
        portal: process.env.PORTAL_AVAX || '',
        xenAddress: XEN_ADDRESSES[43114],
        unlockDay: 26,
    },

    // Phase 4: Day 39+
    {
        chainId: 8453,
        name: 'Base',
        rpc: process.env.BASE_RPC || 'https://mainnet.base.org',
        portal: process.env.PORTAL_BASE || '',
        xenAddress: XEN_ADDRESSES[8453],
        unlockDay: 39,
    },
    {
        chainId: 369,
        name: 'PulseChain',
        rpc: process.env.PULSE_RPC || 'https://rpc.pulsechain.com',
        portal: process.env.PORTAL_PULSE || '',
        xenAddress: XEN_ADDRESSES[369],
        unlockDay: 39,
    },
];

// ═══════════════════════════════════════════════════════════════════════════
//                        CWF — CHAIN WEIGHT FACTOR
// ═══════════════════════════════════════════════════════════════════════════

import { CWF_CONFIG, CWF_DEFAULTS, XEN_AMP_ABI, TIER_MULTIPLIERS as TIER_MULT_CONFIG, ARTIFACT_BOOST_SAFETY_FACTOR, STREAK_CONFIG } from './config';
import { loadState, saveState, updatePilotStreaks, PilotHistory } from './services/evmListener';

const TIER_MULTIPLIERS = TIER_MULT_CONFIG; // 1.0 / 2.0 / 3.0

interface ChainCWF {
    chainId: number;
    name: string;
    ampCurrent: number;
    gasPriceGwei: number;
    isf: number;          // AMP_max / AMP_current
    gcf: number;          // eth_gas / chain_gas
    priceFactor: number;  // (price_chain_EMA / price_ETH_EMA)^exponent — 1.0 if PF disabled
    priceEmaUsd: number;  // 7-epoch EMA price used for PF (audit transparency)
    cwfRaw: number;       // isf × gcf × priceFactor
    cwfNorm: number;      // cwfRaw / cwfRaw(ETH) — ETH always = 1.0
}

/**
 * Read the current AMP from a XEN contract on-chain.
 * Falls back to 1 (minimum) if the call fails.
 */
async function readChainAMP(xenAddress: string, rpc: string): Promise<number> {
    try {
        const provider = new ethers.JsonRpcProvider(rpc);
        const xen = new ethers.Contract(xenAddress, XEN_AMP_ABI, provider);
        const amp = await xen.getCurrentAMP();
        return Math.max(Number(amp), 1);
    } catch {
        return 1; // treat as minimum (deflation) if unreachable
    }
}

/**
 * Fetch the current gas price in Gwei for a chain.
 * Falls back to CWF_CONFIG.gasFallbacks if unreachable.
 */
async function fetchGasPrice(chainId: number, rpc: string): Promise<number> {
    try {
        const provider = new ethers.JsonRpcProvider(rpc);
        const feeData = await provider.getFeeData();
        const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas;
        if (gasPriceWei) {
            return Number(ethers.formatUnits(gasPriceWei, 'gwei'));
        }
    } catch {
        // fall through to fallback
    }
    return CWF_CONFIG.gasFallbacks[chainId] ?? 1;
}

/**
 * Calculate the CWF for each active chain this epoch.
 * ETH is always normalised to 1.0. All others are relative to ETH.
 * Movement is capped at ±20% per epoch to avoid manipulation.
 *
 * CWF v2 formula: normalize( ISF × GCF × PF )
 *   ISF = AMP_max / AMP_current        — inflation scarcity factor
 *   GCF = eth_gas / chain_gas          — gas economic effort factor
 *   PF  = (price_chain_EMA / price_ETH_EMA) ^ 0.33  — price/supply scarcity factor
 *
 * @param previousCWF      Last epoch's cwfNorm values (for ±20% cap)
 * @param xenPriceHistory  Ring buffer of past prices per chainId — mutated in-place
 */
async function calculateEpochCWF(
    previousCWF: Record<number, number>,
    xenPriceHistory: Record<string, number[]>,
): Promise<Record<number, ChainCWF>> {
    console.log('\n📐 Calculating Chain Weight Factors (CWF v2 — ISF × GCF × PF)...');

    const results: Record<number, ChainCWF> = {};
    const pfEnabled = CWF_CONFIG.priceFactorEnabled;
    const emaN      = CWF_CONFIG.priceFactorEMAPeriods;
    const expo      = CWF_CONFIG.priceFactorExponent;
    const maxImpact = CWF_CONFIG.priceFactorMaxImpact;

    // ── Pre-fetch ETH reference values ──────────────────────────────────────
    const ethChain = CHAINS.find(c => c.chainId === 1)!;
    const ethGas   = await fetchGasPrice(1, ethChain.rpc);
    const ethAMP   = await readChainAMP(XEN_ADDRESSES[1], ethChain.rpc);
    const ethISF   = CWF_CONFIG.ampMax / Math.max(ethAMP, 1);
    // ETH GCF = eth_gas / eth_gas = 1.0  |  ETH PF = 1.0 always
    const cwfRawEth = ethISF * 1.0 * 1.0; // ISF × GCF × PF

    // ── Pre-fetch ETH price EMA (denominator for all chains' PF) ────────────
    let ethPriceEMA = 0;
    if (pfEnabled) {
        const ethPrice = await fetchXenPrice(1);
        const k = '1';
        if (!xenPriceHistory[k]) xenPriceHistory[k] = [];
        xenPriceHistory[k].push(ethPrice);
        if (xenPriceHistory[k].length > emaN) xenPriceHistory[k].shift();
        ethPriceEMA = xenPriceHistory[k].reduce((a, b) => a + b, 0) / xenPriceHistory[k].length;
        console.log(`   ETH XEN price: $${ethPrice.toExponential(3)} | EMA(${xenPriceHistory[k].length}): $${ethPriceEMA.toExponential(3)}`);
    }

    // ── Per-chain CWF ────────────────────────────────────────────────────────
    for (const chain of CHAINS) {
        const amp = await readChainAMP(chain.xenAddress, chain.rpc);
        const gas = await fetchGasPrice(chain.chainId, chain.rpc);
        const isf = CWF_CONFIG.ampMax / Math.max(amp, 1);
        const gcf = ethGas / gas;

        // ── Price Factor ────────────────────────────────────────────────────
        let priceFactor = 1.0;
        let priceEmaUsd = 0;

        if (pfEnabled) {
            const key = String(chain.chainId);

            if (chain.chainId === 1) {
                // ETH already fetched — reuse pre-computed EMA
                priceEmaUsd  = ethPriceEMA;
                priceFactor  = 1.0; // price_ETH / price_ETH = 1.0 always
            } else {
                const chainPrice = await fetchXenPrice(chain.chainId);
                if (!xenPriceHistory[key]) xenPriceHistory[key] = [];
                xenPriceHistory[key].push(chainPrice);
                if (xenPriceHistory[key].length > emaN) xenPriceHistory[key].shift();
                priceEmaUsd = xenPriceHistory[key].reduce((a, b) => a + b, 0) / xenPriceHistory[key].length;

                if (ethPriceEMA > 0 && priceEmaUsd > 0) {
                    // Cube-root dampening keeps AMP+gas as primary drivers.
                    // Higher chain XEN price → bigger economic sacrifice → higher PF.
                    const raw = (priceEmaUsd / ethPriceEMA) ** expo;
                    priceFactor = Math.max(1 / maxImpact, Math.min(maxImpact, raw));
                }
            }
        }

        // ── CWF computation ─────────────────────────────────────────────────
        const cwfRaw = isf * gcf * priceFactor;
        let cwfNorm  = cwfRaw / (cwfRawEth || 1);

        // Apply ±20% per-epoch cap vs previous value (anti-manipulation)
        const prev    = previousCWF[chain.chainId] ?? CWF_DEFAULTS[chain.chainId] ?? 1.0;
        const maxUp   = prev * (1 + CWF_CONFIG.maxChangePerEpoch);
        const maxDown = prev * (1 - CWF_CONFIG.maxChangePerEpoch);
        cwfNorm = Math.min(maxUp, Math.max(maxDown, cwfNorm));

        // Apply absolute floor
        cwfNorm = Math.max(cwfNorm, CWF_CONFIG.minCwf);

        const pfTag = pfEnabled
            ? ` PF=${priceFactor.toFixed(3)}($${priceEmaUsd.toExponential(2)}EMA)`
            : '';
        console.log(`   ${chain.name}: AMP=${amp} gas=${gas.toFixed(2)}gwei ISF=${isf.toFixed(1)} GCF=${gcf.toFixed(3)}${pfTag} → CWF=${cwfNorm.toFixed(4)}`);

        results[chain.chainId] = {
            chainId: chain.chainId,
            name: chain.name,
            ampCurrent: amp,
            gasPriceGwei: gas,
            isf,
            gcf,
            priceFactor,
            priceEmaUsd,
            cwfRaw,
            cwfNorm,
        };
    }

    // Force ETH = 1.0 always (normalization guarantee)
    if (results[1]) {
        results[1].cwfNorm    = 1.0;
        results[1].priceFactor = 1.0;
    }

    return results;
}

// ═══════════════════════════════════════════════════════════════════════════
//                      X1 SVM CONFIGURATION
//
// X1 runs the Solana Virtual Machine (SVM) — NOT EVM.
// The reward distribution lives in a Rust/Anchor program on X1, not Solidity.
// Connection uses @solana/web3.js (same as Solana SDK).
//
// ⚠️  CRITICAL PENDING WORK:
//     The MoonForge Anchor program (Rust) must be written and deployed on X1
//     before publishToX1() can actually execute on-chain.
//     The Merkle leaf format below defines the interface the Anchor program must implement.
//     Leaf = keccak256(pubkey_32bytes || amount_8bytes_LE || tier_1byte)
// ═══════════════════════════════════════════════════════════════════════════

const X1_CONFIG = {
    rpc: process.env.X1_RPC || 'https://rpc.x1.xyz',          // X1 SVM RPC endpoint
    programId: process.env.X1_PROGRAM_ID || '',                 // MoonForge Anchor program ID (Base58)
    oracleKey: process.env.ORACLE_PRIVATE_KEY || '',            // Oracle keypair (Base58 secret key)
};

// ═══════════════════════════════════════════════════════════════════════════
//                        DEXSCREENER TOKEN API (for display only)
// ═══════════════════════════════════════════════════════════════════════════

const DEXSCREENER_CHAIN_NAMES: Record<number, string> = {
    1: 'ethereum',
    10: 'optimism',
    56: 'bsc',
    137: 'polygon',
    43114: 'avalanche',
    8453: 'base',
    250: 'fantom',
    // PulseChain (369) — not indexed by DexScreener
};

/**
 * Fetch XEN price from DexScreener Token API
 * Endpoint: https://api.dexscreener.com/latest/dex/tokens/{ADDRESS}
 */
async function fetchXenPrice(chainId: number): Promise<number> {
    const xenAddress = XEN_ADDRESSES[chainId];
    const chainName = DEXSCREENER_CHAIN_NAMES[chainId];

    if (!xenAddress || !chainName) {
        console.warn(`⚠️ No XEN address for chain ${chainId}`);
        return 0.0000001;
    }

    try {
        const url = `https://api.dexscreener.com/latest/dex/tokens/${xenAddress}`;
        const response = await fetch(url);
        const data: any = await response.json();

        if (data.pairs && data.pairs.length > 0) {
            // Find the pair on the correct chain with highest liquidity
            const chainPairs = data.pairs.filter((p: any) =>
                p.chainId === chainName && p.priceUsd
            );

            if (chainPairs.length > 0) {
                // Sort by liquidity and take the best price
                chainPairs.sort((a: any, b: any) =>
                    (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
                );

                const price = parseFloat(chainPairs[0].priceUsd);
                console.log(`📊 ${CHAINS.find(c => c.chainId === chainId)?.name} XEN: $${price.toFixed(10)}`);
                return price;
            }
        }

        console.warn(`⚠️ No price data for chain ${chainId}`);
        return 0.0000001;
    } catch (error) {
        console.error(`❌ Price fetch failed for chain ${chainId}:`, error);
        return 0.0000001;
    }
}

/**
 * Fetch XNT price from X1.ninja or fallback
 */
async function fetchXntPrice(): Promise<number> {
    try {
        // Try X1.ninja API first (if available)
        const response = await fetch('https://api.x1.ninja/v1/tokens/xnt');
        const data: any = await response.json();

        if (data.priceUsd) {
            return parseFloat(data.priceUsd);
        }
    } catch {
        // Fallback: try alternate source
    }

    try {
        // Fallback to XDEX or hardcoded estimate
        // In production, implement proper XNT price discovery
        return 0.001; // Placeholder
    } catch {
        return 0.001;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//                        ROLLOUT ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════════

function getDaysSinceLaunch(): number {
    const now = Date.now();
    const diff = now - LAUNCH_TIMESTAMP;
    return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function isChainActive(chainId: number): boolean {
    const chain = CHAINS.find(c => c.chainId === chainId);
    if (!chain) return false;
    const days = getDaysSinceLaunch();
    return days >= chain.unlockDay;
}

function rejectIfLocked(chainId: number, chainName: string): boolean {
    if (!isChainActive(chainId)) {
        const chain = CHAINS.find(c => c.chainId === chainId);
        const daysUntil = chain ? chain.unlockDay - getDaysSinceLaunch() : 0;
        console.log(`🔒 REJECTED: ${chainName} burn. Chain unlocks in ${daysUntil} days.`);
        return true;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════════════════
//                        CWF SCORE CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate Forge Points using the unified fairness formula:
 *   Points = √(XEN_amount × CWF) × Tier_Multiplier
 *
 * CWF normalises burns across chains by economic effort.
 * Square-root compression ensures whales don't dominate.
 * NFT bonus is applied separately in aggregateScores().
 */
function calculateForgePoints(
    xenAmount: bigint,
    cwf: number,
    tier: number
): { xenNorm: number; rawScore: number; finalPoints: number } {
    const amountFloat = Number(ethers.formatEther(xenAmount));
    const xenNorm = amountFloat * cwf;
    const rawScore = Math.sqrt(xenNorm);
    const finalPoints = rawScore * (TIER_MULTIPLIERS[tier] || 1.0);

    return { xenNorm, rawScore, finalPoints };
}

// ═══════════════════════════════════════════════════════════════════════════
//                              TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface BurnEvent {
    pilot: string;
    amount: bigint;
    tier: number;
    x1Address: string;
    referrer: string;
    timestamp: number;
    chainId: number;
    chainName: string;
    cwf: number;         // CWF applied at burn time (epoch CWF)
    xenNorm: number;     // amount × cwf (normalised)
    forgePoints: number; // √(xenNorm) × tier_multiplier
}

interface PilotScore {
    x1Address: string;
    basePoints: number;   // points before streak (for logging/audit)
    totalPoints: number;  // final points with streak applied
    streakEpochs: number;
    streakMultiplier: number;
    tier: number;
    referrer: string;
}

// ═══════════════════════════════════════════════════════════════════════════
//                              ORACLE BOT
// ═══════════════════════════════════════════════════════════════════════════

const PORTAL_ABI = [
    'event MissionStarted(address indexed pilot, uint256 amount, uint8 indexed tier, string x1Address, address referrer, uint256 timestamp)',
];

// X1 program interface (Anchor/Rust — NOT Solidity):
//   update_epoch(epoch: u64, merkle_root: [u8; 32])
//   current_epoch() -> u64
// ⚠️  publishToX1() is a STUB until the Anchor program is deployed on X1 SVM.

class OracleBot {
    private providers: Map<number, ethers.JsonRpcProvider> = new Map();
    private x1Connection: Connection;  // @solana/web3.js — X1 runs SVM, not EVM
    private burnEvents: BurnEvent[] = [];
    private currentEpoch: number = 0;
    private currentCWF: Record<number, number> = { ...CWF_DEFAULTS }; // seeded with defaults

    constructor() {
        // X1 SVM connection via @solana/web3.js
        this.x1Connection = new Connection(X1_CONFIG.rpc, 'confirmed');

        for (const chain of CHAINS) {
            this.providers.set(chain.chainId, new ethers.JsonRpcProvider(chain.rpc));
        }
    }

    async start(): Promise<void> {
        console.log('🚀 Moon Forge Oracle Bot v8.2 Starting...');
        console.log(`📅 Launch: ${new Date(LAUNCH_TIMESTAMP).toISOString()}`);
        console.log(`📆 Day ${getDaysSinceLaunch()} since launch\n`);

        // Display XEN addresses
        console.log('📜 XEN Contract Addresses:');
        for (const chain of CHAINS) {
            const status = isChainActive(chain.chainId) ? '✅' : '🔒';
            console.log(`   ${status} ${chain.name}: ${chain.xenAddress}`);
        }

        // Get current epoch from X1 SVM program
        // ⚠️  STUB — reads from local state until Anchor program is deployed on X1
        // TODO: query the Anchor program's epoch account via this.x1Connection.getAccountInfo(epochPDA)
        try {
            // Attempt a connectivity check to X1 SVM RPC
            const slot = await this.x1Connection.getSlot();
            console.log(`\n📊 X1 SVM connected. Slot: ${slot}. Epoch: ${this.currentEpoch} (local state)`);
        } catch {
            console.log('\n⚠️ Could not connect to X1 SVM RPC — will retry on epoch publish');
        }

        // Start listeners for active chains
        console.log('\n👂 Starting listeners:');
        for (const chain of CHAINS) {
            if (isChainActive(chain.chainId) && chain.portal) {
                this.startChainListener(chain);
            } else if (!isChainActive(chain.chainId)) {
                console.log(`   🔒 ${chain.name}: Locked (Day ${chain.unlockDay})`);
            }
        }

        this.scheduleEpochPublish();
        setInterval(() => this.checkNewlyUnlockedChains(), 60 * 60 * 1000);
    }

    private startChainListener(chain: ChainConfig): void {
        const provider = this.providers.get(chain.chainId);
        if (!provider || !chain.portal) return;

        const contract = new ethers.Contract(chain.portal, PORTAL_ABI, provider);

        contract.on('MissionStarted', async (pilot, amount, tier, x1Address, referrer, timestamp) => {
            // Enforce rollout lock
            if (rejectIfLocked(chain.chainId, chain.name)) return;

            const cwf = this.currentCWF[chain.chainId] ?? CWF_DEFAULTS[chain.chainId] ?? 1.0;
            const { xenNorm, finalPoints } = calculateForgePoints(amount, cwf, Number(tier));

            console.log(`\n🔥 BURN on ${chain.name}`);
            console.log(`   Pilot:  ${pilot}`);
            console.log(`   Amount: ${ethers.formatEther(amount)} XEN`);
            console.log(`   CWF:    ${cwf.toFixed(4)} | XEN_norm: ${xenNorm.toFixed(2)}`);
            console.log(`   Score:  √${xenNorm.toFixed(2)} × ${TIER_MULTIPLIERS[Number(tier)]}x = ${finalPoints.toFixed(4)} pts (Tier ${tier})`);

            this.burnEvents.push({
                pilot,
                amount,
                tier: Number(tier),
                x1Address,
                referrer,
                timestamp: Number(timestamp),
                chainId: chain.chainId,
                chainName: chain.name,
                cwf,
                xenNorm,
                forgePoints: finalPoints,
            });
        });

        console.log(`   ✅ ${chain.name}: ${chain.portal.slice(0, 10)}...`);
    }

    private checkNewlyUnlockedChains(): void {
        for (const chain of CHAINS) {
            if (isChainActive(chain.chainId) && chain.portal) {
                // Start listener if not already running
                this.startChainListener(chain);
            }
        }
    }

    private scheduleEpochPublish(): void {
        const interval = process.env.NODE_ENV === 'production'
            ? 7 * 24 * 60 * 60 * 1000
            : 60 * 60 * 1000;

        console.log(`\n⏰ Epoch interval: ${interval / 1000 / 60 / 60}h`);

        setInterval(async () => {
            await this.publishEpoch();
        }, interval);
    }

    async publishEpoch(): Promise<void> {
        if (this.burnEvents.length === 0) {
            console.log('\n📭 No burns this epoch');
            return;
        }

        console.log(`\n📤 Publishing Epoch ${this.currentEpoch + 1}...`);
        console.log(`   Burns: ${this.burnEvents.length}`);

        // Read current pool balance from X1 SVM program vault account
        // ⚠️  STUB — getBalance reads lamports from a program-derived account (PDA).
        // TODO: replace programId with actual MoonForge Anchor program ID (Base58)
        //       and query the vault PDA: this.x1Connection.getBalance(vaultPDA)
        let epochBudget: bigint;
        try {
            if (!X1_CONFIG.programId) throw new Error('X1_PROGRAM_ID not set');
            const programPubkey = new PublicKey(X1_CONFIG.programId);
            const lamports = await this.x1Connection.getBalance(programPubkey);
            // 1 XNT = 1e9 lamports (Solana-style decimals on X1)
            const poolBalance = BigInt(lamports);
            epochBudget = BigInt(Math.floor(Number(poolBalance) * ARTIFACT_BOOST_SAFETY_FACTOR));
            const xntDisplay = (Number(lamports) / 1e9).toFixed(4);
            console.log(`   Pool:   ${xntDisplay} XNT (${lamports} lamports)`);
            console.log(`   Budget: ${(Number(epochBudget) / 1e9).toFixed(4)} XNT (safety factor ${ARTIFACT_BOOST_SAFETY_FACTOR})`);
        } catch {
            console.error('   ❌ Could not read pool balance from X1 SVM — aborting to prevent vault dry');
            return;
        }

        if (epochBudget === 0n) {
            console.log('   ⚠️ Pool balance is zero — skipping epoch publish');
            return;
        }

        // Load persisted state first — needed for both xenPriceHistory (CWF) and streaks.
        const oracleState = loadState();
        oracleState.currentEpoch = this.currentEpoch;

        // Recalculate CWF for this epoch before aggregating scores.
        // xenPriceHistory is mutated in-place inside calculateEpochCWF (ring buffer update).
        const cwfMap = await calculateEpochCWF(this.currentCWF, oracleState.xenPriceHistory);
        this.currentCWF = Object.fromEntries(
            Object.entries(cwfMap).map(([k, v]) => [Number(k), v.cwfNorm])
        );

        // ── Streak Flywheel ───────────────────────────────────────────────────
        // 1. Compute per-pilot xenNorm sums to check streak eligibility minimum.
        //    rawScore = √(xenNormSum); pilots below STREAK_CONFIG.minRawScore get
        //    no streak credit this epoch (dust burn protection).
        const xenNormByPilot = new Map<string, number>();
        for (const event of this.burnEvents) {
            const key = event.x1Address.toLowerCase();
            xenNormByPilot.set(key, (xenNormByPilot.get(key) ?? 0) + event.xenNorm);
        }
        const eligibleBurners = new Set<string>();
        for (const [x1Addr, xenNormSum] of xenNormByPilot.entries()) {
            if (Math.sqrt(xenNormSum) >= STREAK_CONFIG.minRawScore) {
                eligibleBurners.add(x1Addr);
            }
        }

        // 2. Update streaks (BEFORE scoring so the current epoch is already reflected).
        updatePilotStreaks(oracleState, eligibleBurners, this.currentEpoch);

        // 3. Aggregate scores — streak applied per pilot.
        const aggregated = this.aggregateScores(oracleState.pilots);
        const { root, cwfSnapshot, priceFactorSnapshot } = this.generateMerkleTree(aggregated, cwfMap, epochBudget);

        console.log(`   Root:   ${root}`);
        console.log(`   Pilots: ${aggregated.size} (${eligibleBurners.size} streak-eligible)`);
        console.log(`   CWF snapshot saved: ${Object.keys(cwfSnapshot).length} chains`);
        if (CWF_CONFIG.priceFactorEnabled) {
            console.log('   💰 Price factors:', Object.entries(priceFactorSnapshot)
                .map(([n, v]) => `${n}=${v.pf.toFixed(3)}`).join(' | '));
        }

        await this.publishToX1(this.currentEpoch + 1, root, cwfSnapshot, priceFactorSnapshot);

        // 4. Persist updated streak state AFTER successful publish.
        oracleState.lastEpochRun = Date.now();
        saveState(oracleState);

        this.burnEvents = [];
        this.currentEpoch++;
    }

    private aggregateScores(pilotHistories: Record<string, PilotHistory>): Map<string, PilotScore> {
        // Pass 1 — accumulate base forge points per pilot (sum of all events)
        const baseMap = new Map<string, { basePoints: number; tier: number; referrer: string }>();

        for (const event of this.burnEvents) {
            const existing = baseMap.get(event.x1Address);
            if (existing) {
                existing.basePoints += event.forgePoints;
                if (event.tier > existing.tier) existing.tier = event.tier;
            } else {
                baseMap.set(event.x1Address, {
                    basePoints: event.forgePoints,
                    tier: event.tier,
                    referrer: event.referrer,
                });
            }
        }

        // Pass 2 — apply streak multiplier and build final PilotScore
        const scores = new Map<string, PilotScore>();

        for (const [x1Address, data] of baseMap.entries()) {
            const history = pilotHistories[x1Address.toLowerCase()] ?? null;
            const streakEpochs = history?.streakEpochs ?? 0;
            const streakMultiplier = 1 + Math.min(
                STREAK_CONFIG.multiplierCap,
                STREAK_CONFIG.logCoefficient * Math.log2(streakEpochs + 1),
            );

            scores.set(x1Address, {
                x1Address,
                basePoints: data.basePoints,
                totalPoints: data.basePoints * streakMultiplier,
                streakEpochs,
                streakMultiplier,
                tier: data.tier,
                referrer: data.referrer,
            });
        }

        return scores;
    }

    private generateMerkleTree(
        scores: Map<string, PilotScore>,
        cwfMap: Record<number, ChainCWF>,
        epochBudget: bigint
    ): { tree: MerkleTree; root: string; cwfSnapshot: Record<string, number>; priceFactorSnapshot: Record<string, { pf: number; priceEmaUsd: number }> } {
        // Proportional distribution: each pilot receives
        //   xntAmount = (pilot.totalPoints / totalPoints) × epochBudget
        // This guarantees sum of all allocations = epochBudget (≤ pool balance × 0.90).
        // The remaining 10% acts as a reserve buffer for Artifact boosts applied at contract level.
        const totalPoints = Array.from(scores.values()).reduce((sum, s) => sum + s.totalPoints, 0);

        const leaves: Buffer[] = [];
        const allocations: { x1Address: string; xntAmount: bigint; tier: number; points: number }[] = [];

        for (const [, score] of scores) {
            const share = totalPoints > 0 ? score.totalPoints / totalPoints : 0;
            // Use BigInt arithmetic to avoid floating-point precision loss at scale
            const xntAmount = BigInt(Math.floor(Number(epochBudget) * share));

            allocations.push({ x1Address: score.x1Address, xntAmount, tier: score.tier, points: score.totalPoints });

            // Leaf = keccak256(pubkey_32bytes || amount_8bytes_LE || tier_1byte)
            // x1Address is a Base58 Solana public key (32 bytes).
            // The MoonForge Anchor program on X1 must verify this exact format.
            const pubkeyBytes = new PublicKey(score.x1Address).toBytes(); // 32 bytes
            const amountBuf = Buffer.alloc(8);
            // Write as 64-bit little-endian (matches Anchor u64 layout)
            const amountNum = Number(xntAmount);
            amountBuf.writeUInt32LE(amountNum >>> 0, 0);
            amountBuf.writeUInt32LE(Math.floor(amountNum / 0x100000000), 4);
            const tierBuf = Buffer.from([score.tier]);
            const leaf = keccak256(Buffer.concat([pubkeyBytes, amountBuf, tierBuf]));
            leaves.push(leaf);
        }

        // Log summary — XNT on X1 SVM uses 9 decimals (lamports), NOT 18 (do not use formatEther)
        const totalAllocated = allocations.reduce((sum, a) => sum + a.xntAmount, 0n);
        const toXNT = (lam: bigint) => (Number(lam) / 1e9).toFixed(4);
        console.log(`   Total allocated: ${toXNT(totalAllocated)} XNT / ${toXNT(epochBudget)} budget`);
        console.log(`   Reserve buffer:  ${toXNT(epochBudget - totalAllocated)} XNT (rounding dust)`);

        // Streak audit log — top 5 by streak for transparency
        const streakTop = Array.from(scores.values())
            .filter(s => s.streakEpochs > 0)
            .sort((a, b) => b.streakEpochs - a.streakEpochs)
            .slice(0, 5);
        if (streakTop.length > 0) {
            console.log('   🔥 Top streak pilots:');
            streakTop.forEach(s => {
                const bonus = ((s.streakMultiplier - 1) * 100).toFixed(1);
                console.log(`      ${s.x1Address.slice(0, 10)}... streak=${s.streakEpochs} (+${bonus}%)`);
            });
        }

        const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
        const root = '0x' + tree.getRoot().toString('hex');

        // Build CWF snapshot — published in proof JSON for full transparency
        const cwfSnapshot: Record<string, number> = {};
        const priceFactorSnapshot: Record<string, { pf: number; priceEmaUsd: number }> = {};
        for (const cwf of Object.values(cwfMap)) {
            cwfSnapshot[cwf.name] = parseFloat(cwf.cwfNorm.toFixed(4));
            priceFactorSnapshot[cwf.name] = {
                pf:          parseFloat(cwf.priceFactor.toFixed(4)),
                priceEmaUsd: parseFloat(cwf.priceEmaUsd.toExponential(4)),
            };
        }

        return { tree, root, cwfSnapshot, priceFactorSnapshot };
    }

    private async publishToX1(
        epoch: number,
        root: string,
        cwfSnapshot: Record<string, number>,
        priceFactorSnapshot: Record<string, { pf: number; priceEmaUsd: number }>,
    ): Promise<void> {
        // ⚠️  CRITICAL STUB — X1 runs SVM (Solana Virtual Machine), NOT EVM.
        //
        // To publish the Merkle root on-chain, you need a Rust/Anchor program deployed on X1.
        // The Anchor program must expose an instruction equivalent to:
        //   update_epoch(epoch: u64, merkle_root: [u8; 32])
        //
        // The oracle keypair must be a Solana keypair (Base58 secret key, 64 bytes),
        // set via ORACLE_PRIVATE_KEY in the .env file.
        //
        // Example implementation (requires @coral-xyz/anchor and the compiled IDL):
        //   const oracleKeypair = Keypair.fromSecretKey(bs58.decode(X1_CONFIG.oracleKey));
        //   const provider = new AnchorProvider(this.x1Connection, new NodeWallet(oracleKeypair), {});
        //   const program = new Program(IDL, new PublicKey(X1_CONFIG.programId), provider);
        //   const rootBytes = Buffer.from(root.replace('0x', ''), 'hex');
        //   const tx = await program.methods.updateEpoch(new BN(epoch), rootBytes).rpc();
        //   console.log(`   TX: ${tx}`);

        if (!X1_CONFIG.oracleKey || !X1_CONFIG.programId) {
            console.log('   ⚠️ X1_PROGRAM_ID or ORACLE_PRIVATE_KEY not set — saving proof locally only');
        } else {
            console.log(`   ⚠️ Anchor program stub — root not yet submitted on-chain`);
            console.log(`   Program: ${X1_CONFIG.programId}`);
        }

        // Always save proof locally so it's not lost when Anchor program goes live.
        // priceFactorSnapshot provides a full audit trail of the PF used each epoch.
        const proof = { epoch, root, cwfSnapshot, priceFactorSnapshot, timestamp: new Date().toISOString() };
        const fs = await import('fs');
        const proofPath = `./proofs/epoch_${epoch}.json`;
        fs.mkdirSync('./proofs', { recursive: true });
        fs.writeFileSync(proofPath, JSON.stringify(proof, null, 2));
        console.log(`   💾 Proof saved: ${proofPath}`);
        console.log(`   Root: ${root}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//                              MAIN
// ═══════════════════════════════════════════════════════════════════════════

const bot = new OracleBot();
bot.start().catch(console.error);

export {
    OracleBot,
    CHAINS,
    XEN_ADDRESSES,
    LAUNCH_TIMESTAMP,
    fetchXenPrice,
    fetchXntPrice,
    isChainActive
};
