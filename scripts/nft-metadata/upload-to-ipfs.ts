import fs from 'fs';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * IPFS Upload Script — Moon Forge Artifacts (Pinata)
 *
 * Requires PINATA_API_KEY and PINATA_SECRET_API_KEY in root .env
 *
 * Two-phase workflow:
 *
 * Phase 1 — Upload images:
 *   npx ts-node scripts/nft-metadata/upload-to-ipfs.ts --images-only
 *   → Uploads frontend/src/assets/nft/ to IPFS, preserving folder structure
 *   → Prints IMAGE_CID — set this in generate-metadata.ts then re-run it
 *
 * Phase 2 — Upload metadata:
 *   npx ts-node scripts/nft-metadata/upload-to-ipfs.ts --metadata-only
 *   → Uploads data/nft-metadata/ to IPFS
 *   → Prints METADATA_CID — use this as the contract baseURI
 *
 * Final contract steps (after both phases):
 *   MoonArtifacts.setBaseURI("ipfs://<METADATA_CID>/")  ← BEFORE initializePool
 *   MoonArtifacts.initializePool()                       ← locks URI forever
 */

const IMAGES_DIR   = path.resolve(__dirname, '../../frontend/src/assets/nft');
const METADATA_DIR = path.resolve(__dirname, '../../data/nft-metadata');

const PINATA_API_KEY    = process.env.PINATA_API_KEY;
const PINATA_SECRET_KEY = process.env.PINATA_SECRET_API_KEY;

if (!PINATA_API_KEY || !PINATA_SECRET_KEY) {
    console.error('ERROR: Missing PINATA_API_KEY or PINATA_SECRET_API_KEY in root .env');
    process.exit(1);
}

const PINATA_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function collectFiles(dir: string, baseDir: string): Array<{ filePath: string; relativePath: string }> {
    const results: Array<{ filePath: string; relativePath: string }> = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectFiles(fullPath, baseDir));
        } else if (entry.isFile()) {
            results.push({
                filePath: fullPath,
                relativePath: path.relative(baseDir, fullPath).replace(/\\/g, '/'),
            });
        }
    }
    return results;
}

async function uploadFolderToPinata(dir: string, pinataFolderName: string): Promise<string> {
    console.log(`Uploading '${pinataFolderName}' to Pinata IPFS...`);

    const files = collectFiles(dir, dir);
    console.log(`  Found ${files.length} files`);

    const form = new FormData();
    for (const { filePath, relativePath } of files) {
        form.append('file', fs.createReadStream(filePath), {
            filepath: `${pinataFolderName}/${relativePath}`,
        });
    }

    form.append('pinataOptions', JSON.stringify({ wrapWithDirectory: false }));
    form.append('pinataMetadata', JSON.stringify({ name: pinataFolderName }));

    const response = await axios.post(PINATA_URL, form, {
        maxBodyLength: Infinity,
        headers: {
            // @ts-ignore
            ...form.getHeaders(),
            pinata_api_key: PINATA_API_KEY,
            pinata_secret_api_key: PINATA_SECRET_KEY,
        },
    });

    return response.data.IpfsHash as string;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    const imagesOnly   = args.includes('--images-only');
    const metadataOnly = args.includes('--metadata-only');

    if (!imagesOnly && !metadataOnly) {
        console.error('Usage:');
        console.error('  npx ts-node scripts/nft-metadata/upload-to-ipfs.ts --images-only');
        console.error('  npx ts-node scripts/nft-metadata/upload-to-ipfs.ts --metadata-only');
        process.exit(1);
    }

    if (imagesOnly) {
        const cid = await uploadFolderToPinata(IMAGES_DIR, 'moon-forge-artifact-images');
        console.log('\nImages uploaded successfully.');
        console.log(`IMAGE_CID: ${cid}`);
        console.log(`Full URI:  ipfs://${cid}/`);
        console.log('\nNext step:');
        console.log(`  1. Open scripts/nft-metadata/generate-metadata.ts`);
        console.log(`  2. Set IMAGES_CID = '${cid}'`);
        console.log(`  3. Re-run: npx ts-node scripts/nft-metadata/generate-metadata.ts`);
        console.log(`  4. Then: npx ts-node scripts/nft-metadata/upload-to-ipfs.ts --metadata-only`);
    }

    if (metadataOnly) {
        const cid = await uploadFolderToPinata(METADATA_DIR, 'moon-forge-artifact-metadata');
        console.log('\nMetadata uploaded successfully.');
        console.log(`METADATA_CID: ${cid}`);
        console.log(`Base URI:     ipfs://${cid}/`);
        console.log('\nFinal contract steps (IRREVERSIBLE ORDER):');
        console.log(`  1. MoonArtifacts.setBaseURI("ipfs://${cid}/")`);
        console.log(`  2. MoonArtifacts.initializePool()  ← locks URI forever`);
    }
}

main().catch((err) => {
    console.error('Upload failed:', err.response?.data ?? err.message);
    process.exit(1);
});
