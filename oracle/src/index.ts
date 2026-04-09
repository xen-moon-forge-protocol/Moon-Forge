/**
 * ═══════════════════════════════════════════════════════════════════════════
 *                        MOON FORGE ORACLE
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * "Don't wait for the party. Forge it."
 * 
 * This oracle bridges XEN burns on EVM chains to XNT rewards on X1.
 * 
 * USAGE:
 * ─────────────────────────────────────────────────────────────────────────────
 * npm run dev              # Run once (manual epoch processing)
 * npm run epoch            # Same as dev, explicit epoch flag
 * npm run listen           # Start cron scheduler (for VPS deployment)
 * 
 * CRON DEPLOYMENT:
 * ─────────────────────────────────────────────────────────────────────────────
 * For VPS deployment, use the --listen flag to start the cron scheduler.
 * By default, it runs daily at midnight UTC.
 * 
 * Alternatively, set up system cron:
 *   0 0 * * * cd /path/to/oracle && npm run epoch >> /var/log/moonforge.log 2>&1
 * 
 * ═══════════════════════════════════════════════════════════════════════════
 */

import cron from 'node-cron';
import { config } from './config';
import { fetchAllBurnEvents, updateEpochState, getOracleState } from './services/evmListener';
import { calculateScores, generateMerkleTree, saveProofsToFile } from './services/merkleGenerator';
import { publishMerkleRoot, healthCheck, getOnChainStatus } from './services/x1Publisher';

// ═══════════════════════════════════════════════════════════════════════════
//                              BANNER
// ═══════════════════════════════════════════════════════════════════════════

function printBanner(): void {
    console.log(`
  ╔═══════════════════════════════════════════════════════════════════════════╗
  ║                                                                           ║
  ║   🌙  MOON FORGE ORACLE  🔨                                               ║
  ║                                                                           ║
  ║   "Don't wait for the party. Forge it."                                   ║
  ║                                                                           ║
  ║   Bridging XEN Burns → XNT Rewards                                        ║
  ║                                                                           ║
  ╚═══════════════════════════════════════════════════════════════════════════╝
  `);
}

// ═══════════════════════════════════════════════════════════════════════════
//                              EPOCH PROCESSING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Main epoch processing function.
 * This is the core logic that:
 * 1. Fetches burn events from EVM chains
 * 2. Calculates fairness scores
 * 3. Generates Merkle tree
 * 4. Publishes to X1
 * 5. Saves proofs for frontend
 */
async function processEpoch(): Promise<boolean> {
    const startTime = Date.now();
    console.log('\n\n═══════════════════════════════════════════════════════════════════════════');
    console.log(`   🚀 STARTING EPOCH PROCESSING - ${new Date().toISOString()}`);
    console.log('═══════════════════════════════════════════════════════════════════════════');

    try {
        // Step 1: Health check
        console.log('\n📡 STEP 1: Health Check');
        const health = await healthCheck();
        if (!health.connected) {
            throw new Error(`X1 connection failed: ${health.error}`);
        }
        console.log(`   ✅ X1 connected at block ${health.blockNumber}`);
        console.log(`   💰 Oracle wallet: ${health.oracleAddress}`);
        console.log(`   💵 Balance: ${health.balance} XNT`);

        // Step 2: Fetch burn events
        console.log('\n🔥 STEP 2: Fetching Burn Events');
        const events = await fetchAllBurnEvents();

        if (events.length === 0) {
            console.log('\n   ⚠️ No new burn events found. Skipping epoch.');
            return true; // Not an error, just nothing to do
        }

        // Step 3: Calculate scores
        console.log('\n🧮 STEP 3: Calculating Scores');
        const scores = calculateScores(events);

        if (scores.length === 0) {
            console.log('\n   ⚠️ No valid scores calculated. Skipping epoch.');
            return true;
        }

        // Step 4: Get current epoch from chain
        const onChainStatus = await getOnChainStatus();
        const nextEpoch = onChainStatus.currentEpoch + 1;

        // Protocol Health: Check pool solvency before publishing epoch
        const epochBudgetGoal = 100000;
        const currentVaultBalance = parseFloat(onChainStatus.vaultBalance);
        if (currentVaultBalance < epochBudgetGoal * 2) {
            console.warn('\n   🚨 [PROTOCOL HEALTH] WARNING: Vault balance is below 2x epoch budget!');
            console.warn(`   🚨 Vault Balance: ${currentVaultBalance.toFixed(2)} XNT | Required: ${(epochBudgetGoal * 2).toFixed(2)} XNT`);
            console.warn('   🚨 ACTION REQUIRED: The protocol needs XNT donations to remain solvent.');
            console.warn('   🚨 Anyone can donate via MoonForgeBase.donate() to refill the pool.');
        }

        // Step 5: Generate Merkle tree
        console.log('\n🌳 STEP 4: Generating Merkle Tree');
        const epochProofs = generateMerkleTree(scores, nextEpoch);

        // Step 6: Save proofs to file (for frontend)
        console.log('\n💾 STEP 5: Saving Proofs');
        saveProofsToFile(epochProofs);

        // Step 7: Publish to X1
        console.log('\n📤 STEP 6: Publishing to X1');
        const publishResult = await publishMerkleRoot(epochProofs.merkleRoot);

        if (!publishResult.success) {
            throw new Error(`Publish failed: ${publishResult.error}`);
        }

        // Step 8: Update local state
        updateEpochState(publishResult.epoch!);

        // Summary
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log('\n\n═══════════════════════════════════════════════════════════════════════════');
        console.log('   ✅ EPOCH PROCESSING COMPLETE');
        console.log('═══════════════════════════════════════════════════════════════════════════');
        console.log(`   📅 Epoch: ${publishResult.epoch}`);
        console.log(`   👥 Pilots: ${epochProofs.totalPilots}`);
        console.log(`   📊 Total Score: ${epochProofs.totalScore.toFixed(2)}`);
        console.log(`   🔑 Merkle Root: ${epochProofs.merkleRoot}`);
        console.log(`   📝 TX: ${publishResult.txHash}`);
        console.log(`   ⏱️ Duration: ${duration}s`);
        console.log('═══════════════════════════════════════════════════════════════════════════\n');

        return true;
    } catch (error: any) {
        console.error('\n\n═══════════════════════════════════════════════════════════════════════════');
        console.error('   ❌ EPOCH PROCESSING FAILED');
        console.error('═══════════════════════════════════════════════════════════════════════════');
        console.error(`   Error: ${error.message}`);
        console.error('═══════════════════════════════════════════════════════════════════════════\n');
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//                              STATUS COMMAND
// ═══════════════════════════════════════════════════════════════════════════

async function showStatus(): Promise<void> {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('   📊 ORACLE STATUS');
    console.log('═══════════════════════════════════════════════════════════');

    // Local state
    const state = getOracleState();
    console.log('\n   LOCAL STATE:');
    
    // Display all active chains in state
    for (const [chainId, cs] of Object.entries(state.chains)) {
        console.log(`   └─ Chain ${chainId} last block: ${cs.lastBlockProcessed}`);
        console.log(`   └─ Chain ${chainId} total events: ${cs.totalEventsProcessed}`);
    }
    
    console.log(`   └─ Last epoch run: ${state.lastEpochRun ? new Date(state.lastEpochRun).toISOString() : 'Never'}`);

    // On-chain status
    try {
        const onChain = await getOnChainStatus();
        console.log('\n   ON-CHAIN (X1):');
        console.log(`   └─ Current epoch: ${onChain.currentEpoch}`);
        console.log(`   └─ Current root: ${onChain.currentRoot.substring(0, 20)}...`);
        console.log(`   └─ Oracle balance: ${onChain.oracleBalance} XNT`);
    } catch (error: any) {
        console.log('\n   ON-CHAIN (X1): ❌ Could not connect');
        console.log(`   └─ Error: ${error.message}`);
    }

    console.log('\n═══════════════════════════════════════════════════════════\n');
}

// ═══════════════════════════════════════════════════════════════════════════
//                              MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
    printBanner();

    const args = process.argv.slice(2);

    // Parse command line arguments
    if (args.includes('--status')) {
        await showStatus();
        return;
    }

    if (args.includes('--listen')) {
        // Cron mode - run on schedule
        console.log(`\n   ⏰ Starting cron scheduler: ${config.epoch.cronSchedule}`);
        console.log('   📝 Press Ctrl+C to stop\n');

        // Run once immediately
        await processEpoch();

        // Then schedule
        cron.schedule(config.epoch.cronSchedule, async () => {
            console.log(`\n   ⏰ Cron triggered at ${new Date().toISOString()}`);
            await processEpoch();
        });

        // Keep process alive
        console.log('   🟢 Oracle is running. Waiting for next scheduled epoch...\n');
    } else {
        // One-shot mode - run once and exit
        console.log('   📝 Running single epoch (use --listen for continuous mode)\n');
        const success = await processEpoch();
        process.exit(success ? 0 : 1);
    }
}

// Run the oracle
main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
