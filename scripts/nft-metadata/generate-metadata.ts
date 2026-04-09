import fs from 'fs';
import path from 'path';

/**
 * NFT Metadata Generator — Moon Forge Artifacts
 *
 * Generates 1,000 JSON metadata files following the exact tier/variant distribution:
 *
 * TIER 0 — Lunar Dust (Common) — 600 units — IDs 1–600 — Fixed pricing — Floor: 5 XNT
 *   Frost Blue     IDs   1–100   lunar_dust/frost_blue.jpg
 *   Silver Moon    IDs 101–200   lunar_dust/silver_moon.jpg
 *   Golden Dust    IDs 201–300   lunar_dust/golden_dust.jpg
 *   Rose Quartz    IDs 301–400   lunar_dust/rose_quartz.jpg
 *   Sage Green     IDs 401–500   lunar_dust/sage_green.jpg
 *   Lavender Mist  IDs 501–600   lunar_dust/lavender_mist.jpg
 *
 * TIER 1 — Cosmic Shard (Rare) — 300 units — IDs 601–900 — Dynamic pricing — Floor: 10 XNT
 *   Amethyst       IDs 601–700   cosmic_shard/amethyst.jpg
 *   Aquamarine     IDs 701–800   cosmic_shard/aquamarine.jpg
 *   Magenta Pulse  IDs 801–900   cosmic_shard/magenta_pulse.jpg
 *
 * TIER 2 — Solar Core (Epic) — 90 units — IDs 901–990 — Dynamic pricing — Floor: 20 XNT
 *   Flame          IDs 901–945   solar_core/flame.jpg
 *   Red Giant      IDs 946–990   solar_core/red_giant.jpg
 *
 * TIER 3 — Void Anomaly (Legendary) — 10 units — IDs 991–1000 — Dynamic pricing — Floor: 50 XNT
 *   Event Horizon  IDs 991–1000  void_anomaly/event_horizon.jpg
 *
 * Usage:
 *   npx ts-node scripts/nft-metadata/generate-metadata.ts
 *
 * After running:
 *   1. Upload images to IPFS → get IMAGE_CID
 *   2. Set IMAGES_CID below and re-run (or manually update JSON files)
 *   3. Upload data/nft-metadata/ to IPFS → get METADATA_CID
 *   4. Call MoonArtifacts.setBaseURI("ipfs://METADATA_CID/") — BEFORE initializePool()
 *   5. Call MoonArtifacts.initializePool() — locks URI forever
 */

// ─── CONFIGURATION ───────────────────────────────────────────────────────────

// Set this to the IPFS CID of your uploaded images folder after step 1.
const IMAGES_CID = 'PLACEHOLDER_IMAGES_CID';

const OUTPUT_DIR = path.resolve(__dirname, '../../data/nft-metadata');
const EXTERNAL_URL_BASE = 'https://moonforge.protocol/artifacts';

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface VariantConfig {
    tierId: number;
    tierName: string;
    rarity: 'Common' | 'Rare' | 'Epic' | 'Legendary';
    boost: number;
    floorPrice: string;
    pricing: 'Fixed' | 'Dynamic';
    variant: string;
    imageFolder: string;
    imageFile: string;
    startId: number;
    endId: number;
}

interface NFTMetadata {
    name: string;
    description: string;
    image: string;
    external_url: string;
    attributes: Array<{
        trait_type: string;
        display_type?: string;
        value: string | number;
    }>;
}

// ─── VARIANT MAP ─────────────────────────────────────────────────────────────

const VARIANTS: VariantConfig[] = [
    // Tier 0 — Lunar Dust — Common — Fixed pricing
    { tierId: 0, tierName: 'Lunar Dust',   rarity: 'Common',    boost: 5,  floorPrice: '5 XNT',  pricing: 'Fixed',   variant: 'Frost Blue',    imageFolder: 'lunar_dust',   imageFile: 'frost_blue.jpg',    startId: 1,   endId: 100  },
    { tierId: 0, tierName: 'Lunar Dust',   rarity: 'Common',    boost: 5,  floorPrice: '5 XNT',  pricing: 'Fixed',   variant: 'Silver Moon',   imageFolder: 'lunar_dust',   imageFile: 'silver_moon.jpg',   startId: 101, endId: 200  },
    { tierId: 0, tierName: 'Lunar Dust',   rarity: 'Common',    boost: 5,  floorPrice: '5 XNT',  pricing: 'Fixed',   variant: 'Golden Dust',   imageFolder: 'lunar_dust',   imageFile: 'golden_dust.jpg',   startId: 201, endId: 300  },
    { tierId: 0, tierName: 'Lunar Dust',   rarity: 'Common',    boost: 5,  floorPrice: '5 XNT',  pricing: 'Fixed',   variant: 'Rose Quartz',   imageFolder: 'lunar_dust',   imageFile: 'rose_quartz.jpg',   startId: 301, endId: 400  },
    { tierId: 0, tierName: 'Lunar Dust',   rarity: 'Common',    boost: 5,  floorPrice: '5 XNT',  pricing: 'Fixed',   variant: 'Sage Green',    imageFolder: 'lunar_dust',   imageFile: 'sage_green.jpg',    startId: 401, endId: 500  },
    { tierId: 0, tierName: 'Lunar Dust',   rarity: 'Common',    boost: 5,  floorPrice: '5 XNT',  pricing: 'Fixed',   variant: 'Lavender Mist', imageFolder: 'lunar_dust',   imageFile: 'lavender_mist.jpg', startId: 501, endId: 600  },
    // Tier 1 — Cosmic Shard — Rare — Dynamic pricing
    { tierId: 1, tierName: 'Cosmic Shard', rarity: 'Rare',      boost: 10, floorPrice: '10 XNT', pricing: 'Dynamic', variant: 'Amethyst',      imageFolder: 'cosmic_shard', imageFile: 'amethyst.jpg',      startId: 601, endId: 700  },
    { tierId: 1, tierName: 'Cosmic Shard', rarity: 'Rare',      boost: 10, floorPrice: '10 XNT', pricing: 'Dynamic', variant: 'Aquamarine',    imageFolder: 'cosmic_shard', imageFile: 'aquamarine.jpg',    startId: 701, endId: 800  },
    { tierId: 1, tierName: 'Cosmic Shard', rarity: 'Rare',      boost: 10, floorPrice: '10 XNT', pricing: 'Dynamic', variant: 'Magenta Pulse', imageFolder: 'cosmic_shard', imageFile: 'magenta_pulse.jpg', startId: 801, endId: 900  },
    // Tier 2 — Solar Core — Epic — Dynamic pricing
    { tierId: 2, tierName: 'Solar Core',   rarity: 'Epic',      boost: 20, floorPrice: '20 XNT', pricing: 'Dynamic', variant: 'Flame',         imageFolder: 'solar_core',   imageFile: 'flame.jpg',         startId: 901, endId: 945  },
    { tierId: 2, tierName: 'Solar Core',   rarity: 'Epic',      boost: 20, floorPrice: '20 XNT', pricing: 'Dynamic', variant: 'Red Giant',     imageFolder: 'solar_core',   imageFile: 'red_giant.jpg',     startId: 946, endId: 990  },
    // Tier 3 — Void Anomaly — Legendary — Dynamic pricing
    { tierId: 3, tierName: 'Void Anomaly', rarity: 'Legendary', boost: 50, floorPrice: '50 XNT', pricing: 'Dynamic', variant: 'Event Horizon', imageFolder: 'void_anomaly', imageFile: 'event_horizon.jpg', startId: 991, endId: 1000 },
];

// ─── DESCRIPTIONS ────────────────────────────────────────────────────────────

const DESCRIPTIONS: Record<string, string> = {
    'Lunar Dust':
        'A Common Moon Forge Artifact. Equipped on a mission, it grants a 5% boost to your Forge Score. ' +
        'Locked until mission completion or early exit. Floor price is fixed at 5 XNT — the most accessible entry into the Artifact economy.',
    'Cosmic Shard':
        'A Rare Moon Forge Artifact forged from fragments of cosmic material. Grants a 10% boost to Forge Score when equipped. ' +
        'Price increases with each sale and decays gradually without demand — true dynamic scarcity.',
    'Solar Core':
        'An Epic Moon Forge Artifact. Only 90 exist across the entire protocol. Grants a 20% boost to Forge Score. ' +
        'The solar crucible demands real commitment — equip it and watch the yield ignite.',
    'Void Anomaly':
        'A Legendary Moon Forge Artifact. Only 10 exist. Grants a massive 50% boost to Forge Score. ' +
        'An anomaly in the fabric of the forge — unmistakable, irreplaceable, and permanently verifiable on X1.',
};

// ─── MAIN ────────────────────────────────────────────────────────────────────

function buildMetadata(tokenId: number, v: VariantConfig): NFTMetadata {
    return {
        name: `${v.tierName} #${tokenId} — ${v.variant}`,
        description: DESCRIPTIONS[v.tierName],
        image: `ipfs://${IMAGES_CID}/${v.imageFolder}/${v.imageFile}`,
        external_url: `${EXTERNAL_URL_BASE}/${tokenId}`,
        attributes: [
            { trait_type: 'Tier',        value: v.tierName },
            { trait_type: 'Tier ID',     value: v.tierId },
            { trait_type: 'Rarity',      value: v.rarity },
            { trait_type: 'Variant',     value: v.variant },
            { trait_type: 'Boost',       display_type: 'boost_percentage', value: v.boost },
            { trait_type: 'Floor Price', value: v.floorPrice },
            { trait_type: 'Pricing',     value: v.pricing },
            { trait_type: 'Chain',       value: 'X1' },
            { trait_type: 'Collection',  value: 'Moon Forge Artifacts' },
        ],
    };
}

async function main() {
    console.log('Generating 1,000 Moon Forge Artifact metadata files...\n');

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Validate no ID gaps or overlaps
    const allIds = new Set<number>();
    let totalExpected = 0;
    for (const v of VARIANTS) {
        for (let id = v.startId; id <= v.endId; id++) {
            if (allIds.has(id)) throw new Error(`Duplicate token ID: ${id}`);
            allIds.add(id);
            totalExpected++;
        }
    }
    if (totalExpected !== 1000) throw new Error(`Expected 1000 tokens, got ${totalExpected}`);

    let generated = 0;

    for (const variant of VARIANTS) {
        const count = variant.endId - variant.startId + 1;
        console.log(`  [Tier ${variant.tierId}] ${variant.tierName} / ${variant.variant} — ${count} tokens (IDs ${variant.startId}–${variant.endId})`);

        for (let tokenId = variant.startId; tokenId <= variant.endId; tokenId++) {
            const metadata = buildMetadata(tokenId, variant);
            fs.writeFileSync(
                path.join(OUTPUT_DIR, `${tokenId}.json`),
                JSON.stringify(metadata, null, 2)
            );
            generated++;
        }
    }

    console.log(`\nGenerated ${generated} files in: ${OUTPUT_DIR}`);

    if (IMAGES_CID === 'PLACEHOLDER_IMAGES_CID') {
        console.log('\nWARNING: Images CID is still a placeholder.');
        console.log('Next steps:');
        console.log('  1. Upload frontend/src/assets/nft/ to IPFS via upload-to-ipfs.ts');
        console.log('     npx ts-node scripts/nft-metadata/upload-to-ipfs.ts --images-only');
        console.log('  2. Set IMAGES_CID in this file to the returned CID');
        console.log('  3. Re-run this script to update image URLs in all JSON files');
        console.log('  4. Upload data/nft-metadata/ to IPFS:');
        console.log('     npx ts-node scripts/nft-metadata/upload-to-ipfs.ts --metadata-only');
        console.log('  5. Call MoonArtifacts.setBaseURI("ipfs://<METADATA_CID>/")  ← BEFORE initializePool');
        console.log('  6. Call MoonArtifacts.initializePool()                       ← locks URI forever');
    }
}

main().catch(console.error);
