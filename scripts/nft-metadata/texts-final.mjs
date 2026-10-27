// PERMANENT texts: the 13 metadata JSON files (collection.json + 12 variants) uploaded once to Arweave and compiled
// into the final program's METADATA_BASE_URI. They can never be corrected after the upload, so they follow
// docs/WORDING.md section 4: program facts only (tier, element, floor, forge price, origin, recyclable, the
// genuine-collection line, the wallet-burn warning, the AI-art note, the forge split into the two pots); no oracle
// policy numbers, no boost / chips / ticket / drop / lottery text, no "where honored", no other project's name, no
// date, no URL other than the site. lint-permanent.mjs enforces this on the generated files before any upload.
//
// Tense: these files describe the program AFTER the final upgrade. The program points at them only from that upgrade
// on (refresh_collection_uri + the compiled METADATA_BASE_URI); until then the site's /nft/ copy (texts-v2.mjs) is
// the one in use.
//
// Every number below must match programs/moon-forge/src/constants.rs (test/metadata.test.mjs checks it):
//   FORGE_BACKING_BPS 5000 / FORGE_POOL_BPS 2000 / FORGE_EXTRA_BPS 2500 / FORGE_ARCHITECT_BPS 500 / FORGE_DRAW_BPS 0,
//   ARTIFACT_SUPPLY [600, 300, 90, 10].
import { SITE, PROGRAM_ID, COLLECTION, COLLECTION_NAME, SYMBOL, TIERS, title } from './tiers.mjs';

export const SPLIT = { floor: 50, rewardPool: 20, extraPot: 25, architect: 5 };
export const EXTERNAL_URL = `${SITE}/artifacts/`;

const GENUINE =
  `Genuine only in the Metaplex Core collection ${COLLECTION} on X1, minted by the Moon Forge program ` +
  `${PROGRAM_ID}: an asset outside this collection is not a Moon Forge Artifact, whatever its name or image.`;
// current_price (artifacts.rs): a full tier (alive == ARTIFACT_SUPPLY) keeps its price, so "eases back" is
// conditional on the tier not being full (Void Anomaly, 10 slots, will often be full).
const PRICE =
  `The forge price of each tier is set by the program: it rises with each forge and, while the tier is not full, ` +
  `eases back over time without one, within limits fixed in the program. Of every forge price, ${SPLIT.floor}% stays inside the Artifact as its ` +
  `floor, ${SPLIT.rewardPool}% goes to the reward pool that pays XEN burners, ${SPLIT.extraPot}% goes to the extra ` +
  `pot and ${SPLIT.architect}% to the architect.`;
const EXTRA =
  `The extra pot is a separate vault of the program that never draws on the reward pool. Its payouts are usage ` +
  `rebates for Artifact holders, set by the oracle under its published rules and capped by the program at every ` +
  `release. The extra pot can be empty and the rebates can stop: no payout is promised.`;
const WALLET_BURN = `Burning this NFT in a wallet app sends its floor to the reward pool; recycle it through Moon Forge instead.`;
const AI_ART = `The artwork was made with an AI image tool and then edited.`;

function floorText(t) {
  const origin = t.slug === 'lunar_dust' ? '; 0 for a Genesis Airdrop piece' : '';
  return (
    `This Artifact holds a floor in XNT, recorded in its on-chain "Floor XNT" attribute (half of its "Forge Price ` +
    `XNT" when forged${origin}). Recycling it through Moon Forge pays the floor back to its holder and frees its ` +
    `slot: at most ${t.supply} ${t.name} can be alive at a time.`
  );
}

export function buildFinal({ imageBase, imageExt = 'webp' }) {
  if (!/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9_-]{43}$/.test(imageBase)) {
    throw new Error(`image base must be https://<gateway>/<43-character manifest id>, got ${imageBase}`);
  }
  const imageType = imageExt === 'webp' ? 'image/webp' : 'image/jpeg';
  const files = {};
  const caps = TIERS.map((t) => `${t.name} ${t.supply}`).join(', ');
  files['collection.json'] = {
    name: COLLECTION_NAME,
    symbol: SYMBOL,
    description: [
      `Moon Forge Protocol: burn XEN on a supported EVM chain, receive XNT on X1.`,
      `Moon Forge Artifacts are Metaplex Core NFTs on X1 in four tiers, each with a cap on how many can be alive at ` +
        `a time: ${caps}. ${GENUINE}`,
      `Each Artifact holds a floor in XNT, recorded in its on-chain "Floor XNT" attribute (half of its "Forge Price ` +
        `XNT" when forged; 0 for a Genesis Airdrop piece). Recycling an Artifact through Moon Forge pays its floor ` +
        `back to its holder and frees its slot for a new forge. ${PRICE}`,
      EXTRA,
      `Burning an Artifact in a wallet app sends its floor to the reward pool; recycle it through Moon Forge instead.`,
      AI_ART,
    ].join('\n\n'),
    image: `${imageBase}/void_anomaly/event_horizon.${imageExt}`,
    external_url: EXTERNAL_URL,
  };
  for (const t of TIERS) {
    t.variants.forEach((v, i) => {
      const image = `${imageBase}/${t.slug}/${v}.${imageExt}`;
      files[`${t.slug}/${i}.json`] = {
        name: `${t.name} — ${title(v)}`,
        symbol: SYMBOL,
        description: [t.lore, GENUINE, floorText(t), PRICE, EXTRA, WALLET_BURN, AI_ART].join('\n\n'),
        image,
        external_url: EXTERNAL_URL,
        attributes: [
          { trait_type: 'Tier', value: t.name },
          { trait_type: 'Variant', value: title(v) },
          { trait_type: 'Element', value: t.element },
          { trait_type: 'Max Alive', value: t.supply },
          { trait_type: 'Recyclable', value: 'Yes' },
        ],
        properties: { category: 'image', files: [{ uri: image, type: imageType }] },
      };
    });
  }
  return files;
}

// Exact bytes of one file, as written to disk and uploaded (2-space JSON, no trailing newline).
export const serialize = (obj) => Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
