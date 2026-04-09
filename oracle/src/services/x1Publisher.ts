/**
 * Moon Forge Oracle - X1 Publisher
 *
 * Publishes Merkle roots to the MoonForge Anchor program on X1 blockchain (SVM).
 * X1 is a Solana Virtual Machine chain — uses @solana/web3.js, NOT ethers.js.
 *
 * IMPORTANT: The MoonForge Anchor program must be deployed to X1 before this
 * module can publish on-chain. Until then, publishMerkleRoot() will fail with a
 * clear error. See DEPLOY.md "X1 SVM Migration" section.
 *
 * Instruction encoding (Anchor layout):
 *   [0..8]   discriminator — sha256("global:update_epoch")[0..8]
 *   [8..16]  epoch         — u64 little-endian
 *   [16..48] merkle_root   — [u8; 32]
 *
 * To get the real discriminator once the program is compiled:
 *   cat target/idl/moon_forge.json | jq '.instructions[] | select(.name=="updateEpoch") | .discriminator'
 *   OR: sha256("global:update_epoch") → take first 8 bytes
 */

import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
    sendAndConfirmTransaction,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { config } from '../config';

// ═══════════════════════════════════════════════════════════════════════════
//                              TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface PublishResult {
    success: boolean;
    txHash?: string;
    epoch?: number;
    error?: string;
    gasUsed?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
//                              KEYPAIR LOADING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load Solana Keypair from ORACLE_PRIVATE_KEY env var.
 *
 * Supported formats:
 *   1. JSON array  — "[1,2,3,...,64]"  — default export of `solana-keygen`
 *   2. Base58 string — exported by Phantom / Backpack / Solflare
 *
 * DO NOT use an EVM (hex) private key here — this is a Solana keypair.
 */
function loadKeypair(): Keypair {
    const key = config.x1.oraclePrivateKey.trim();

    // Format 1: JSON array [1, 2, ..., 64]
    if (key.startsWith('[')) {
        try {
            const secretKey = Uint8Array.from(JSON.parse(key) as number[]);
            return Keypair.fromSecretKey(secretKey);
        } catch {
            throw new Error(
                'ORACLE_PRIVATE_KEY looks like a JSON array but failed to parse. ' +
                'Expected format: [1,2,...,64] (64 numbers, exported by solana-keygen).'
            );
        }
    }

    // Format 2: Base58 string — uses bs58 which ships with @solana/web3.js
    try {
        // bs58 is a direct dependency of @solana/web3.js and always available in node_modules
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const bs58 = require('bs58') as { decode: (s: string) => Uint8Array };
        const secretKey = bs58.decode(key);
        return Keypair.fromSecretKey(secretKey);
    } catch {
        throw new Error(
            'Failed to parse ORACLE_PRIVATE_KEY. Provide it as:\n' +
            '  • JSON array: [1,2,...,64]  (from: solana-keygen new --outfile keypair.json)\n' +
            '  • Base58 string             (from: Phantom / Backpack export)\n' +
            'Do NOT use an EVM hex private key here.'
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//                              CONNECTION
// ═══════════════════════════════════════════════════════════════════════════

function getX1Connection(): Connection {
    return new Connection(config.x1.rpcUrl, 'confirmed');
}

// ═══════════════════════════════════════════════════════════════════════════
//                              STATUS CHECK
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get oracle wallet balance and X1 connection status.
 *
 * NOTE: Reading the on-chain epoch and Merkle root from the Anchor program
 * account requires the deployed program + PDA derivation. This function
 * returns placeholder values for epoch/root until the Anchor program is live.
 */
export async function getOnChainStatus(): Promise<{
    currentEpoch: number;
    currentRoot: string;
    oracleBalance: string;
    vaultBalance: string;
}> {
    const connection = getX1Connection();
    const keypair = loadKeypair();
    const programId = new PublicKey(config.x1.programId);

    const [oracleLamports, programLamports] = await Promise.all([
        connection.getBalance(keypair.publicKey),
        connection.getBalance(programId),
    ]);

    return {
        currentEpoch: 0,          // TODO: read from Anchor program PDA once deployed
        currentRoot: '0x' + '0'.repeat(64), // TODO: read from Anchor program PDA
        oracleBalance: (oracleLamports / LAMPORTS_PER_SOL).toFixed(6),
        vaultBalance:  (programLamports / LAMPORTS_PER_SOL).toFixed(6),
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//                              EXCESS DONATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Oracle Excess → Pool Ceiling
 *
 * If the oracle wallet accumulates more than ORACLE_XNT_CEILING XNT,
 * the excess is donated back to the pool via the Anchor program's donate()
 * instruction. This prevents the oracle from accumulating disproportionate
 * rewards relative to its operating costs (~5 XNT/day = VPS + gas).
 *
 * Ceiling rationale: validators earn ~5 XNT/day; 25 XNT = 5× daily earnings.
 * Any oracle balance above this threshold is returned to the reward pool.
 *
 * TODO: Implement the actual Anchor instruction call once the program is live.
 *       The donate instruction layout (TBD from Anchor IDL):
 *         [0..8]  discriminator — sha256("global:donate")[0..8]
 *         [8..16] amount        — u64 little-endian (lamports)
 */
const ORACLE_XNT_CEILING = 25; // XNT — oracle surplus threshold

export async function donateExcessToPool(connection: Connection, keypair: Keypair): Promise<void> {
    const balanceLamports = await connection.getBalance(keypair.publicKey);
    const balanceXnt = balanceLamports / LAMPORTS_PER_SOL;

    if (balanceXnt <= ORACLE_XNT_CEILING) {
        return; // Below ceiling — nothing to donate
    }

    const excessXnt = balanceXnt - ORACLE_XNT_CEILING;

    console.log('\n   💸 ORACLE CEILING: Balance exceeds 25 XNT threshold');
    console.log(`   💰 Oracle balance: ${balanceXnt.toFixed(6)} XNT`);
    console.log(`   🔄 Excess to donate: ${excessXnt.toFixed(6)} XNT`);

    // donate() Anchor instruction — Donate context (lib.rs):
    //   donor:          Signer (oracle keypair)
    //   reward_vault:   PDA seeds=[b"reward_vault"]
    //   system_program: SystemProgram
    //
    // Discriminator = sha256("global:donate")[0..8]
    // Computed: node -e "const c=require('crypto'); console.log(Array.from(c.createHash('sha256').update('global:donate').digest().slice(0,8)))"
    const DONATE_DISCRIMINATOR = Buffer.from([121, 186, 218, 211, 73, 70, 196, 180]);

    const programId = new PublicKey(process.env.X1_PROGRAM_ID!);
    const [rewardVault] = PublicKey.findProgramAddressSync([Buffer.from('reward_vault')], programId);

    const excessLamports = BigInt(Math.floor(excessXnt * LAMPORTS_PER_SOL));
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(excessLamports);
    const data = Buffer.concat([DONATE_DISCRIMINATOR, amountBuf]);

    const instruction = new TransactionInstruction({
        programId,
        keys: [
            { pubkey: keypair.publicKey, isSigner: true,  isWritable: true  }, // donor
            { pubkey: rewardVault,       isSigner: false, isWritable: true  }, // reward_vault PDA
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
        ],
        data,
    });

    const tx = new Transaction().add(instruction);
    const sig = await sendAndConfirmTransaction(connection, tx, [keypair]);
    console.log(`   ✅ Excess donated to pool! TX: ${sig}`);
}

// ═══════════════════════════════════════════════════════════════════════════
//                              PUBLISH
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Publish a new Merkle root to the MoonForge Anchor program on X1.
 * After publishing, checks oracle ceiling and donates excess XNT to pool.
 */
export async function publishMerkleRoot(merkleRoot: string): Promise<PublishResult> {
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('   🚀 PUBLISHING TO X1 BLOCKCHAIN (SVM)');
    console.log('═══════════════════════════════════════════════════════════');

    try {
        const connection = getX1Connection();
        const keypair = loadKeypair();
        const programId = new PublicKey(config.x1.programId);

        // Check oracle balance
        const balanceLamports = await connection.getBalance(keypair.publicKey);
        const balanceXnt = balanceLamports / LAMPORTS_PER_SOL;
        console.log(`   💰 Oracle balance: ${balanceXnt.toFixed(6)} XNT`);
        console.log(`   🔑 Oracle address: ${keypair.publicKey.toBase58()}`);
        console.log(`   📡 Program:        ${programId.toBase58()}`);

        if (balanceLamports < 0.01 * LAMPORTS_PER_SOL) {
            console.warn('   ⚠️ LOW BALANCE WARNING! Fund the oracle wallet with XNT for gas fees.');
        }

        // Validate merkle root
        const rootHex = merkleRoot.startsWith('0x') ? merkleRoot.slice(2) : merkleRoot;
        const rootBytes = Buffer.from(rootHex, 'hex');
        if (rootBytes.length !== 32) {
            throw new Error(`Invalid merkle root: expected 32 bytes, got ${rootBytes.length}`);
        }

        // Get current slot (proxy for epoch until Anchor PDA is readable)
        const slot = await connection.getSlot();
        console.log(`   📅 Current slot: ${slot}`);
        console.log(`   🔑 Publishing root: ${merkleRoot}`);

        // ── Encode Anchor instruction ─────────────────────────────────────
        // Instruction name in lib.rs: update_merkle_root
        // Discriminator = sha256("global:update_merkle_root")[0..8]
        //
        // Compute after `anchor build`:
        //   node -e "const c=require('crypto'); \
        //     console.log(Array.from(c.createHash('sha256') \
        //       .update('global:update_merkle_root').digest().slice(0,8)));"
        //
        // OR read directly from the IDL:
        //   cat target/idl/moon_forge_games.json | \
        //     node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); \
        //       const idl=JSON.parse(d); \
        //       const ix=idl.instructions.find(i=>i.name==='updateMerkleRoot'); \
        //       console.log(ix.discriminator);"
        //
        // Discriminator = sha256("global:update_merkle_root")[0..8]
        // Pre-computed (deterministic — independent of compiled binary):
        //   node -e "const c=require('crypto'); console.log(Array.from(c.createHash('sha256').update('global:update_merkle_root').digest().slice(0,8)))"
        //   → [195, 173, 38, 60, 242, 203, 158, 93]
        // Verified against Anchor IDL after `anchor build` via:
        //   cat target/idl/moon_forge_games.json | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const idl=JSON.parse(d); const ix=idl.instructions.find(i=>i.name==='updateMerkleRoot'); console.log(ix.discriminator);"
        const discriminator = Buffer.from([195, 173, 38, 60, 242, 203, 158, 93]);

        const epochBuf = Buffer.alloc(8);
        epochBuf.writeBigUInt64LE(BigInt(slot)); // TODO: replace with real epoch counter

        const data = Buffer.concat([discriminator, epochBuf, rootBytes]);

        const instruction = new TransactionInstruction({
            keys: [
                { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
            ],
            programId,
            data,
        });

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const transaction = new Transaction();
        transaction.feePayer = keypair.publicKey;
        transaction.recentBlockhash = blockhash;
        transaction.add(instruction);

        // Send and confirm
        console.log('   📤 Sending transaction...');
        const txHash = await sendAndConfirmTransaction(connection, transaction, [keypair], {
            commitment: 'confirmed',
        });

        console.log('\n   ✅ PUBLISH SUCCESSFUL!');
        console.log(`   📝 TX Hash: ${txHash}`);

        // Oracle ceiling check — donate excess XNT to pool
        await donateExcessToPool(connection, keypair);

        return {
            success: true,
            txHash,
            epoch: slot, // TODO: replace with real epoch from Anchor PDA
        };

    } catch (error: any) {
        console.error('\n   ❌ PUBLISH FAILED!');
        console.error(`   Error: ${error.message}`);

        return {
            success: false,
            error: error.message,
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//                              HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check X1 SVM connection and oracle wallet status.
 */
export async function healthCheck(): Promise<{
    connected: boolean;
    blockNumber?: number;
    oracleAddress?: string;
    balance?: string;
    error?: string;
}> {
    try {
        const connection = getX1Connection();
        const keypair = loadKeypair();

        const [slot, balanceLamports] = await Promise.all([
            connection.getSlot(),
            connection.getBalance(keypair.publicKey),
        ]);

        return {
            connected: true,
            blockNumber: slot,
            oracleAddress: keypair.publicKey.toBase58(),
            balance: (balanceLamports / LAMPORTS_PER_SOL).toFixed(6),
        };
    } catch (error: any) {
        return {
            connected: false,
            error: error.message,
        };
    }
}
