/**
 * Moon Forge Oracle - Merkle Tree Generator
 * 
 * Calculates scores using the fairness formula and generates
 * Merkle trees for proof-based claims on X1.
 * 
 * FAIRNESS FORMULA:
 * Score = √(XEN_burned × CWF) × TierMultiplier × NFTBonus
 *
 * CWF (Chain Weight Factor) normalises burns across chains by economic effort.
 * This ensures:
 * - Cross-chain fairness (ETH burn ≠ Polygon burn in raw tokens)
 * - Whale compression (square root keeps community competitive)
 * - Long-term holders rewarded (tier multipliers 1x/2x/3x)
 * - NFT holders boosted (applied after sqrt)
 */

import { MerkleTree } from 'merkletreejs';
import keccak256 from 'keccak256';
import { ethers } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import {
    config,
    TIER_MULTIPLIERS,
    NFT_BONUS_MULTIPLIER,
    NO_NFT_MULTIPLIER,
    CWF_DEFAULTS,
    STREAK_CONFIG,
} from '../config';
import { BurnEvent, PilotHistory } from './evmListener';

// ═══════════════════════════════════════════════════════════════════════════
//                              TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface PilotScore {
    x1Address: string;        // X1 wallet address (destination)
    evmAddress: string;       // Original EVM address (for reference)
    totalBurned: bigint;      // Total XEN burned
    rawScore: number;         // √(xenNorm) — before multipliers
    tierMultiplier: number;   // Based on highest tier chosen
    nftBonus: number;         // 1.0 or 1.1 (MoonCommander)
    streakEpochs: number;     // Consecutive qualifying epochs at scoring time
    streakMultiplier: number; // 1.0 to 1.15 — applied last (after nft)
    finalScore: number;       // √(xenNorm) × tier × nft × streak
    tier: number;             // Highest tier selected
}

export interface ClaimInfo {
    amount: string;           // XNT amount in lamports (1 XNT = 1e9 lamports, X1 SVM style)
    tier: number;
    streakEpochs: number;     // Streak at time of allocation — visible to user in proofs.json
    streakMultiplier: number; // Multiplier applied — transparent audit trail
    proof: string[];          // Merkle proof array
}

export interface EpochProofs {
    epoch: number;
    timestamp: number;
    merkleRoot: string;
    totalPilots: number;
    totalScore: number;
    cwfSnapshot: Record<string, number>; // chainName -> CWF used this epoch
    claims: Record<string, ClaimInfo>;   // x1Address -> ClaimInfo
}

// ═══════════════════════════════════════════════════════════════════════════
//                              NFT HOLDER CHECK
// ═══════════════════════════════════════════════════════════════════════════

// For MVP: Load NFT holders from a static JSON file
// In production, this could query the X1 blockchain
const NFT_HOLDERS_FILE = path.resolve(__dirname, '../../data/nft_holders.json');

function loadNFTHolders(): Set<string> {
    try {
        if (fs.existsSync(NFT_HOLDERS_FILE)) {
            const data = fs.readFileSync(NFT_HOLDERS_FILE, 'utf-8');
            const holders: string[] = JSON.parse(data);
            return new Set(holders.map(h => h.toLowerCase()));
        }
    } catch (error) {
        console.warn('⚠️ Could not load NFT holders file, assuming no bonuses');
    }
    return new Set();
}

/**
 * Check if an address holds MoonCommander NFT.
 * For MVP, uses static list. Can be upgraded to on-chain check.
 */
function hasNFTBonus(x1Address: string, nftHolders: Set<string>): boolean {
    return nftHolders.has(x1Address.toLowerCase());
}

// ═══════════════════════════════════════════════════════════════════════════
//                              SCORE CALCULATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculate scores for all pilots from burn events.
 * Aggregates by X1 wallet address.
 *
 * @param events          Burn events collected during the epoch
 * @param cwfMap          CWF per chainId for this epoch (e.g. { 1: 1.0, 10: 0.88, 137: 0.01 })
 * @param pilotHistories  Streak state per pilot — updated BEFORE calling this function
 *                        so the current epoch's streak is already included.
 *                        Pass {} if streak tracking is not used (falls back to 1.0×).
 */
export function calculateScores(
    events: BurnEvent[],
    cwfMap: Record<number, number> = {},
    pilotHistories: Record<string, PilotHistory> = {}
): PilotScore[] {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('   🧮 CALCULATING PILOT SCORES');
    console.log('═══════════════════════════════════════════════════════════');

    const nftHolders = loadNFTHolders();
    console.log(`   📋 Loaded ${nftHolders.size} NFT holders`);

    // Aggregate by X1 address
    const pilotMap = new Map<string, {
        evmAddress: string;
        totalBurned: bigint;
        highestTier: number;
        events: BurnEvent[];
    }>();

    for (const event of events) {
        const x1Addr = event.x1TargetAddress.toLowerCase();
        const existing = pilotMap.get(x1Addr);

        if (existing) {
            existing.totalBurned += event.amount;
            existing.highestTier = Math.max(existing.highestTier, event.missionTier);
            existing.events.push(event);
        } else {
            pilotMap.set(x1Addr, {
                evmAddress: event.pilot,
                totalBurned: event.amount,
                highestTier: event.missionTier,
                events: [event],
            });
        }
    }

    console.log(`   👥 Found ${pilotMap.size} unique pilots`);

    // Calculate scores
    const scores: PilotScore[] = [];

    for (const [x1Address, data] of pilotMap.entries()) {
        // Aggregate CWF-normalised XEN across all burns for this pilot
        // Each burn contributed its own CWF (from the chain it came from)
        let xenNormTotal = 0;
        for (const ev of data.events) {
            const cwf = cwfMap[ev.chainId] ?? CWF_DEFAULTS[ev.chainId] ?? 1.0;
            xenNormTotal += Number(ethers.formatEther(ev.amount)) * cwf;
        }

        // √(XEN_normalised) — fairness formula with CWF
        const rawScore = Math.sqrt(xenNormTotal);

        // Tier multiplier (use highest tier for max bonus): 1.0 / 2.0 / 3.0
        const tierMultiplier = TIER_MULTIPLIERS[data.highestTier] || 1.0;

        // NFT bonus (applied after sqrt so it doesn't compound whale advantage)
        const nftBonus = hasNFTBonus(x1Address, nftHolders)
            ? NFT_BONUS_MULTIPLIER
            : NO_NFT_MULTIPLIER;

        // Streak multiplier — applied last, after nft and tier.
        // pilotHistories is already updated for this epoch (streak includes current burn).
        // Pilots below STREAK_CONFIG.minRawScore were excluded by updatePilotStreaks
        // so their streakEpochs was NOT incremented — they get 1.0× automatically.
        const history = pilotHistories[x1Address] ?? null;
        const streakEpochs = history?.streakEpochs ?? 0;
        const streakMultiplier = 1 + Math.min(
            STREAK_CONFIG.multiplierCap,
            STREAK_CONFIG.logCoefficient * Math.log2(streakEpochs + 1),
        );

        // Final score = √(XEN_norm) × tier × nft × streak
        const finalScore = rawScore * tierMultiplier * nftBonus * streakMultiplier;

        scores.push({
            x1Address,
            evmAddress: data.evmAddress,
            totalBurned: data.totalBurned,
            rawScore,
            tierMultiplier,
            nftBonus,
            streakEpochs,
            streakMultiplier,
            finalScore,
            tier: data.highestTier,
        });
    }

    // Sort by score descending (for display purposes)
    scores.sort((a, b) => b.finalScore - a.finalScore);

    // Log top pilots
    console.log('\n   🏆 TOP 5 PILOTS:');
    scores.slice(0, 5).forEach((s, i) => {
        const streakTag = s.streakEpochs > 0 ? ` 🔥×${s.streakEpochs}(${(s.streakMultiplier * 100 - 100).toFixed(1)}%)` : '';
        console.log(`      ${i + 1}. ${s.x1Address.substring(0, 10)}... Score: ${s.finalScore.toFixed(2)}${streakTag}`);
    });

    const totalScore = scores.reduce((sum, s) => sum + s.finalScore, 0);
    console.log(`\n   📊 Total score pool: ${totalScore.toFixed(2)}`);

    return scores;
}

// ═══════════════════════════════════════════════════════════════════════════
//                              MERKLE TREE GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert score to XNT allocation amount in lamports.
 * Each pilot gets: (myScore / totalScore) × epochBudget
 * epochBudget is in lamports (1 XNT = 1e9 lamports on X1 SVM).
 */
function scoreToAllocation(score: number, totalScore: number, epochBudget: bigint): bigint {
    // Each pilot gets: (myScore / totalScore) * epochBudget
    // Guard: if totalScore is 0 (no burns this epoch), no allocation
    const share = totalScore > 0 ? score / totalScore : 0;
    return BigInt(Math.floor(share * Number(epochBudget)));
}

/**
 * Generate leaf for Merkle tree.
 * Must match the leaf format expected by the MoonForge Anchor program on X1 SVM.
 *
 * X1 uses SVM (Solana Virtual Machine) — NOT EVM. The Anchor program verifies
 * keccak256 (available as a Solana syscall), not Solidity's abi.encodePacked.
 *
 * Leaf = keccak256(pubkey_32bytes || amount_8bytes_LE || tier_1byte)
 *   pubkey: raw bytes of Base58 Solana public key (32 bytes)
 *   amount: u64 in little-endian (8 bytes) — lamports (XNT uses 9 decimals, like SOL)
 *   tier:   u8 (1 byte)
 */
function generateLeaf(x1Address: string, amount: bigint, tier: number): Buffer {
    const pubkeyBytes = new PublicKey(x1Address).toBytes(); // 32 bytes
    const amountBuf = Buffer.alloc(8);
    const amountNum = Number(amount);
    amountBuf.writeUInt32LE(amountNum >>> 0, 0);
    amountBuf.writeUInt32LE(Math.floor(amountNum / 0x100000000), 4);
    const tierBuf = Buffer.from([tier]);
    return Buffer.from(keccak256(Buffer.concat([pubkeyBytes, amountBuf, tierBuf])));
}

/**
 * Generate Merkle tree and proofs for all pilots.
 */
// 1 XNT = 1_000_000_000 lamports (X1 SVM, same decimal structure as Solana SOL)
const DEFAULT_EPOCH_BUDGET_XNT = 100_000;
const LAMPORTS_PER_XNT = 1_000_000_000n;

export function generateMerkleTree(
    scores: PilotScore[],
    epoch: number,
    cwfSnapshot: Record<string, number> = {},
    epochBudget: bigint = BigInt(DEFAULT_EPOCH_BUDGET_XNT) * LAMPORTS_PER_XNT // Default 100k XNT in lamports
): EpochProofs {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('   🌳 GENERATING MERKLE TREE');
    console.log('═══════════════════════════════════════════════════════════');

    const totalScore = scores.reduce((sum, s) => sum + s.finalScore, 0);

    // Generate leaves
    const leaves: Buffer[] = [];
    const leafData: Array<{
        x1Address: string;
        amount: bigint;
        tier: number;
        leaf: Buffer;
    }> = [];

    for (const pilot of scores) {
        const amount = scoreToAllocation(pilot.finalScore, totalScore, epochBudget);
        const leaf = generateLeaf(pilot.x1Address, amount, pilot.tier);

        leaves.push(leaf);
        leafData.push({
            x1Address: pilot.x1Address,
            amount,
            tier: pilot.tier,
            leaf,
        });
    }

    // Build Merkle tree
    const tree = new MerkleTree(leaves, keccak256, { sortPairs: true });
    const root = tree.getHexRoot();

    console.log(`   🌲 Tree built with ${leaves.length} leaves`);
    console.log(`   🔑 Merkle Root: ${root}`);

    // Generate proofs for each pilot
    const claims: Record<string, ClaimInfo> = {};

    for (const data of leafData) {
        const proof = tree.getHexProof(data.leaf);
        // Find the pilot's streak info from the scores array
        const pilotScore = scores.find(s => s.x1Address === data.x1Address);
        claims[data.x1Address] = {
            amount: data.amount.toString(),
            tier: data.tier,
            streakEpochs: pilotScore?.streakEpochs ?? 0,
            streakMultiplier: parseFloat((pilotScore?.streakMultiplier ?? 1.0).toFixed(4)),
            proof,
        };
    }

    const epochProofs: EpochProofs = {
        epoch,
        timestamp: Date.now(),
        merkleRoot: root,
        totalPilots: scores.length,
        totalScore,
        cwfSnapshot,
        claims,
    };

    return epochProofs;
}

// ═══════════════════════════════════════════════════════════════════════════
//                              FILE OUTPUT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Save proofs to JSON file for frontend to access.
 * Frontend will fetch this from GitHub Pages.
 */
export function saveProofsToFile(proofs: EpochProofs): string {
    const outputDir = path.resolve(__dirname, '../../', config.epoch.proofsOutputDir);

    // Ensure directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const filename = `proofs.json`;
    const filepath = path.join(outputDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(proofs, null, 2));

    console.log(`\n   💾 Proofs saved to: ${filepath}`);
    console.log(`   📝 Epoch ${proofs.epoch}: ${proofs.totalPilots} claims`);

    // Also save historical copy
    const historyDir = path.join(outputDir, 'history');
    if (!fs.existsSync(historyDir)) {
        fs.mkdirSync(historyDir, { recursive: true });
    }
    const historyPath = path.join(historyDir, `epoch-${proofs.epoch}.json`);
    fs.writeFileSync(historyPath, JSON.stringify(proofs, null, 2));

    return filepath;
}
