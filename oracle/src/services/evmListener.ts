/**
 * Moon Forge Oracle - EVM Event Listener
 *
 * Monitors MoonForgePortal on ALL supported EVM chains:
 *   Phase 1 (Day  0): ETH (1)         + OP (10)
 *   Phase 2 (Day 13): BSC (56)
 *   Phase 3 (Day 26): Polygon (137)   + Avalanche (43114)
 *   Phase 4 (Day 39): Base (8453)     + PulseChain (369)
 *
 * Chain characteristics (block time + chunk size + CWF seed):
 *   Ethereum  (1)    : ~12s/block  — chunk 2000 — CWF 1.000 (L1 anchor, gas ~20 Gwei on ETH)
 *   Optimism  (10)   : ~2s/block   — chunk 2000 — CWF 0.880 (L2 Bedrock, XEN near-deflation, gas ~0.5 Gwei on ETH)
 *   BSC       (56)   : ~3s/block   — chunk 2000 — CWF 0.045 (L1, high supply, gas ~1 Gwei on BNB)
 *   Polygon   (137)  : ~2s/block   — chunk 1500 — CWF 0.010 (PoS L1, massive supply, gas ~50 Gwei on MATIC)
 *   Avalanche (43114): ~2s/block   — chunk 2000 — CWF 0.095 (C-Chain L1, gas ~25 Gwei on AVAX)
 *   Base      (8453) : ~2s/block   — chunk 2000 — CWF 0.850 (L2 Coinbase/Bedrock, similar behavior to OP)
 *   PulseChain(369)  : ~10s/block  — chunk 2000 — CWF 0.020 (L1 PoS, high supply, gas ~10 Gwei on PLS)
 *
 * State persisted in data/state.json by chainId — supports progressive rollout.
 */

import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { config, ChainConfig, PORTAL_ABI } from '../config';

// ═══════════════════════════════════════════════════════════════════════════
//                              TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface BurnEvent {
    chain: string;
    chainId: number;
    txHash: string;
    blockNumber: number;
    pilot: string;           // EVM address that burned
    amount: bigint;          // Amount of XEN burned (18 decimals, EVM-style)
    missionTier: number;     // 0 = Launchpad | 1 = Orbit | 2 = Moon Landing
    x1TargetAddress: string; // Base58 X1 SVM address (rewards destination)
    referrer: string;        // EVM address of the referrer (or address(0) if none)
    timestamp: number;       // Block timestamp
}

interface ChainState {
    lastBlockProcessed: number;
    totalEventsProcessed: number;
}

/**
 * Per-pilot burn streak history — persisted in data/state.json.
 * Keyed by x1Address (lowercase) in OracleState.pilots.
 *
 * A burn qualifies for streak only if the pilot's aggregated rawScore
 * (√(xenNorm)) for the epoch meets STREAK_CONFIG.minRawScore.
 * Dust burns below the threshold are included in proportional allocation
 * but do NOT advance the streak counter.
 */
export interface PilotHistory {
    streakEpochs: number;       // consecutive qualifying epochs (updated BEFORE scoring)
    lastBurnEpoch: number;      // epoch index of last qualifying burn (-1 = never)
    totalEpochsBurned: number;  // lifetime qualifying epochs count (stats only)
}

export interface OracleState {
    // Keyed by chainId (string) for persistence — e.g. "1", "10", "56"
    chains: Record<string, ChainState>;
    // Keyed by x1Address (lowercase) — streak flywheel history per pilot
    pilots: Record<string, PilotHistory>;
    // Keyed by chainId (number as string) — ring buffer of recent XEN prices in USD.
    // Used by calculateEpochCWF() to compute the EMA for the Price Factor (PF).
    // Length capped at CWF_CONFIG.priceFactorEMAPeriods (7 epochs by default).
    // PulseChain (369) and chains not indexed by DexScreener default to ETH price
    // (i.e. PF = 1.0) when no historical data is available.
    xenPriceHistory: Record<string, number[]>;
    lastEpochRun: number;
    currentEpoch: number;
}

// ═══════════════════════════════════════════════════════════════════════════
//                        PER-CHAIN CHUNK SIZES
//
// Chunk = how many blocks we query per queryFilter().
// Limits vary by public RPC — conservative is better.
// ═══════════════════════════════════════════════════════════════════════════

const CHAIN_CHUNK_SIZES: Record<number, number> = {
    1:     2000, // Ethereum   — 12s/block, stable RPCs
    10:    2000, // Optimism   — 2s/block, L2 RPCs accept 2000+
    56:    2000, // BSC        — 3s/block, dataseed accepts 2000
    137:   1500, // Polygon    — 2s/block, polygon-rpc.com is conservative (2000 sometimes fails)
    43114: 2000, // Avalanche  — 2s/block, C-Chain standard
    8453:  2000, // Base       — 2s/block, L2 Coinbase (basescan supports 2000+)
    369:   2000, // PulseChain — 10s/block, public RPCs accept 2000
};
const DEFAULT_CHUNK_SIZE = 2000;

// How many blocks to look back if no saved state exists (first run)
// Ethereum: 10000 blocks ≈ 33h | BSC: 10000 blocks ≈ 8h | Polygon: 10000 blocks ≈ 5.5h
// Ideal is to use the portal deploy block — fill PORTAL_DEPLOY_BLOCKS after deploy.
const PORTAL_DEPLOY_BLOCKS: Record<number, number> = {
    1:     0, // TBD — MoonForgePortal deploy block on Ethereum
    10:    0, // TBD — MoonForgePortal deploy block on Optimism
    56:    0, // TBD — MoonForgePortal deploy block on BSC
    137:   0, // TBD — MoonForgePortal deploy block on Polygon
    43114: 0, // TBD — MoonForgePortal deploy block on Avalanche
    8453:  0, // TBD — MoonForgePortal deploy block on Base      (Phase 4, Day 39)
    369:   0, // TBD — MoonForgePortal deploy block on PulseChain (Phase 4, Day 39)
};
const FRESH_START_LOOKBACK = 10000; // Blocks to look back if deploy block not configured

// ═══════════════════════════════════════════════════════════════════════════
//                              STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

const STATE_FILE = path.resolve(__dirname, '../../data/state.json');

export function loadState(): OracleState {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));

            // Migrate from old format ({ ethereum: {...}, optimism: {...} }) to new ({ chains: { "1": {...} } })
            if (raw.ethereum && !raw.chains) {
                console.log('⚙️  Migrating state file to new format (v1→v2)...');
                return {
                    chains: {
                        '1':  raw.ethereum ?? { lastBlockProcessed: 0, totalEventsProcessed: 0 },
                        '10': raw.optimism  ?? { lastBlockProcessed: 0, totalEventsProcessed: 0 },
                    },
                    pilots: {},
                    xenPriceHistory: {},
                    lastEpochRun: raw.lastEpochRun ?? 0,
                    currentEpoch: raw.currentEpoch ?? 0,
                };
            }

            if (raw.chains) {
                // Migrate states that predate the pilots field (v2→v3)
                if (!raw.pilots) {
                    console.log('⚙️  Migrating state file to v3 (adding pilots streak history)...');
                    raw.pilots = {};
                }
                // Migrate states that predate xenPriceHistory (v3→v4)
                if (!raw.xenPriceHistory) {
                    console.log('⚙️  Migrating state file to v4 (adding XEN price history for PF)...');
                    raw.xenPriceHistory = {};
                }
                return raw as OracleState;
            }
        }
    } catch (error) {
        console.warn('⚠️ Could not load state file, starting fresh');
    }

    return { chains: {}, pilots: {}, xenPriceHistory: {}, lastEpochRun: 0, currentEpoch: 0 };
}

export function saveState(state: OracleState): void {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    console.log('💾 State saved');
}

function getChainState(state: OracleState, chainId: number): ChainState {
    return state.chains[String(chainId)] ?? { lastBlockProcessed: 0, totalEventsProcessed: 0 };
}

function setChainState(state: OracleState, chainId: number, cs: ChainState): void {
    state.chains[String(chainId)] = cs;
}

// ═══════════════════════════════════════════════════════════════════════════
//                         PILOT STREAK HELPERS (exported)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Return a pilot's history, or a safe default if not found.
 */
export function getPilotHistory(state: OracleState, x1Address: string): PilotHistory {
    return state.pilots[x1Address.toLowerCase()] ?? {
        streakEpochs: 0,
        lastBurnEpoch: -1,
        totalEpochsBurned: 0,
    };
}

/**
 * Update streak counters for ALL known pilots at the end of an epoch.
 *
 * eligibleBurners — set of x1Addresses (lowercase) whose aggregated
 *   rawScore met STREAK_CONFIG.minRawScore this epoch. Dust burns
 *   are excluded from this set.
 *
 * Call ORDER: updatePilotStreaks BEFORE aggregateScores so that the
 * streak multiplier already reflects the current epoch when scoring.
 *
 * Forgiving break rules:
 *   Miss 1 epoch  → streak = floor(streak / 2)
 *   Miss 2+ epochs → streak = 0
 */
export function updatePilotStreaks(
    state: OracleState,
    eligibleBurners: Set<string>,
    currentEpoch: number,
): void {
    // ── Pilots who burned this epoch (eligible) ────────────────────────
    for (const x1Addr of eligibleBurners) {
        const key = x1Addr.toLowerCase();
        const history = state.pilots[key] ?? { streakEpochs: 0, lastBurnEpoch: -1, totalEpochsBurned: 0 };

        const consecutive = history.lastBurnEpoch === currentEpoch - 1;
        history.streakEpochs      = consecutive ? history.streakEpochs + 1 : 1;
        history.lastBurnEpoch     = currentEpoch;
        history.totalEpochsBurned = history.totalEpochsBurned + 1;
        state.pilots[key]         = history;
    }

    // ── Pilots who did NOT burn this epoch — apply break penalty ───────
    for (const [key, history] of Object.entries(state.pilots)) {
        if (eligibleBurners.has(key)) continue;   // already updated above
        if (history.lastBurnEpoch < 0) continue;  // never burned, nothing to break

        const epochsMissed = currentEpoch - history.lastBurnEpoch;
        if (epochsMissed === 1) {
            history.streakEpochs = Math.floor(history.streakEpochs / 2);
        } else if (epochsMissed >= 2) {
            history.streakEpochs = 0;
        }
        state.pilots[key] = history;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//                              EVENT FETCHING — PER CHAIN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetches MissionStarted events from a specific chain.
 * Uses adjusted chunk size per chain to respect public RPC limits.
 */
async function fetchEventsFromChain(
    chainConfig: ChainConfig,
    fromBlock: number
): Promise<BurnEvent[]> {
    console.log(`\n📡 [${chainConfig.name}] Connecting to RPC...`);

    if (!chainConfig.portalAddress) {
        console.log(`   ⏭️  [${chainConfig.name}] Portal address not set — skipping`);
        return [];
    }

    const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
    const portal = new ethers.Contract(chainConfig.portalAddress, PORTAL_ABI, provider);

    const currentBlock = await provider.getBlockNumber();

    // Determine start block: use deploy block if configured, else look back N blocks
    const deployBlock = PORTAL_DEPLOY_BLOCKS[chainConfig.chainId] ?? 0;
    let startBlock: number;
    if (fromBlock > 0) {
        startBlock = fromBlock;
    } else if (deployBlock > 0) {
        startBlock = deployBlock;
    } else {
        startBlock = Math.max(0, currentBlock - FRESH_START_LOOKBACK);
    }

    console.log(`   🔍 [${chainConfig.name}] Blocks ${startBlock} → ${currentBlock}`);

    const chunkSize = CHAIN_CHUNK_SIZES[chainConfig.chainId] ?? DEFAULT_CHUNK_SIZE;
    const events: BurnEvent[] = [];

    for (let from = startBlock; from <= currentBlock; from += chunkSize) {
        const to = Math.min(from + chunkSize - 1, currentBlock);

        try {
            const filter = portal.filters.MissionStarted();
            const logs = await portal.queryFilter(filter, from, to);

            for (const log of logs) {
                const parsed = portal.interface.parseLog({
                    topics: log.topics as string[],
                    data: log.data,
                });

                if (parsed) {
                    events.push({
                        chain: chainConfig.name,
                        chainId: chainConfig.chainId,
                        txHash: log.transactionHash,
                        blockNumber: log.blockNumber,
                        pilot: parsed.args.pilot,
                        amount: parsed.args.amount,
                        missionTier: Number(parsed.args.missionTier),
                        x1TargetAddress: parsed.args.x1TargetAddress,
                        referrer: parsed.args.referrer ?? ethers.ZeroAddress,
                        timestamp: Number(parsed.args.timestamp),
                    });
                }
            }

            const blocksScanned = from - startBlock + chunkSize;
            if (blocksScanned > 0 && blocksScanned % 20000 === 0) {
                console.log(`   📊 [${chainConfig.name}] Processed ${blocksScanned} blocks...`);
            }
        } catch (error) {
            console.error(`   ❌ [${chainConfig.name}] Error fetching blocks ${from}-${to}:`, error);
            // Continue with next chunk — don't abort the whole chain
        }
    }

    console.log(`   ✅ [${chainConfig.name}] Found ${events.length} burn events`);
    return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//                              PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetches new burn events from ALL active chains in config.
 * Optional chains (bsc, polygon, avalanche) are only processed if configured in .env.
 * Updates state.json with the most recent blocks per chain.
 */
export async function fetchAllBurnEvents(): Promise<BurnEvent[]> {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('   🔥 FETCHING BURN EVENTS FROM ALL EVM CHAINS');
    console.log('═══════════════════════════════════════════════════════════');

    const state = loadState();
    const allEvents: BurnEvent[] = [];

    // Build list of active chains from config
    // Phase 1 (Day 0): ETH + OP always required
    // Phase 2 (Day 13): BSC optional
    // Phase 3 (Day 26): Polygon + Avalanche optional
    // Phase 4 (Day 39): Base + PulseChain optional
    const activeChains: ChainConfig[] = [
        config.chains.ethereum,
        config.chains.optimism,
        ...(config.chains.bsc        ? [config.chains.bsc]        : []),
        ...(config.chains.polygon    ? [config.chains.polygon]    : []),
        ...(config.chains.avalanche  ? [config.chains.avalanche]  : []),
        ...(config.chains.base       ? [config.chains.base]       : []),
        ...(config.chains.pulsechain ? [config.chains.pulsechain] : []),
    ];

    for (const chainConfig of activeChains) {
        try {
            const cs = getChainState(state, chainConfig.chainId);
            const fromBlock = cs.lastBlockProcessed > 0 ? cs.lastBlockProcessed + 1 : 0;

            const chainEvents = await fetchEventsFromChain(chainConfig, fromBlock);
            allEvents.push(...chainEvents);

            // Update state for this chain
            if (chainEvents.length > 0) {
                cs.lastBlockProcessed = Math.max(...chainEvents.map(e => e.blockNumber));
                cs.totalEventsProcessed += chainEvents.length;
            } else {
                // No events — still advance the cursor to current block to avoid rescanning
                try {
                    const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
                    cs.lastBlockProcessed = await provider.getBlockNumber();
                } catch {
                    // RPC temporarily unreachable — keep old cursor, retry next epoch
                }
            }

            setChainState(state, chainConfig.chainId, cs);
        } catch (error) {
            console.error(`❌ Failed to fetch from ${chainConfig.name}:`, error);
        }
    }

    saveState(state);

    // Summary
    console.log(`\n📊 TOTAL: ${allEvents.length} new burn events across all chains`);
    for (const chain of activeChains) {
        const cs = getChainState(state, chain.chainId);
        console.log(`   ${chain.name}: ${cs.totalEventsProcessed} events total (cursor: block ${cs.lastBlockProcessed})`);
    }

    return allEvents;
}

/**
 * Returns current oracle state (for health checks).
 */
export function getOracleState(): OracleState {
    return loadState();
}

/**
 * Updates epoch info in the state.
 */
export function updateEpochState(epoch: number): void {
    const state = loadState();
    state.currentEpoch = epoch;
    state.lastEpochRun = Date.now();
    saveState(state);
}
