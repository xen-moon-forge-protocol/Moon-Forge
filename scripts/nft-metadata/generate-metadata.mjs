// Generates the off-chain JSON metadata for Moon Forge Artifacts (Metaplex standard),
// served by GitHub Pages at  <site>/nft/<tier_slug>/<variant>.json  and  <site>/nft/collection.json.
// The program picks the file with  variant = serial % variants  (constants.rs ARTIFACT_VARIANTS),
// so the VARIANT ORDER BELOW MUST NEVER CHANGE once the collection exists.
//
// Usage: node scripts/nft-metadata/generate-metadata.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE = 'https://xen-moon-forge-protocol.github.io/Moon-Forge';
const OUT = path.join(root, 'frontend/public/nft');
const SRC_IMAGES = path.join(root, 'frontend/src/assets/nft');

const TIERS = [
  { slug: 'lunar_dust', name: 'Lunar Dust', element: 'Lunar', supply: 600, price: 10, boost: 5, chips: 5,
    variants: ['frost_blue', 'golden_dust', 'lavender_mist', 'rose_quartz', 'sage_green', 'silver_moon'],
    lore: 'Fine regolith swept from the craters where XEN was forged into light.' },
  { slug: 'cosmic_shard', name: 'Cosmic Shard', element: 'Cosmic', supply: 300, price: 25, boost: 10, chips: 15,
    variants: ['amethyst', 'aquamarine', 'magenta_pulse'],
    lore: 'A crystal splinter of the burn, still humming with the chain it left behind.' },
  { slug: 'solar_core', name: 'Solar Core', element: 'Solar', supply: 90, price: 60, boost: 20, chips: 40,
    variants: ['flame', 'red_giant'],
    lore: 'The molten heart of a thousand missions, too hot to hold for long.' },
  { slug: 'void_anomaly', name: 'Void Anomaly', element: 'Void', supply: 10, price: 200, boost: 50, chips: 150,
    variants: ['event_horizon'],
    lore: 'Where the burned supply goes. Only ten can exist at once.' },
];
const title = (s) => s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'collection.json'), JSON.stringify({
  name: 'Moon Forge Artifacts',
  symbol: 'MFART',
  description: 'Recyclable utility NFTs of Moon Forge Protocol on X1. Each Artifact raises its holder\'s share of an epoch\'s burn rewards (only if held by the same owner at two consecutive epoch snapshots; best Artifact per wallet; the epoch total never changes), grants weekly Burn Lottery chips, is a ticket to Artifact Duel (the element played is chosen freely and hidden), and holds a refundable XNT floor (except Genesis airdrop Lunar Dust). Recycle it through Moon Forge at any time to get the floor back. Lunar Dust is also drawn among XEN burners as Forge Drops, paid to them as part of their own epoch reward. Utilities are implemented by the program 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 and the public epoch oracle, and readable by any project.',
  image: `${SITE}/nft/images/void_anomaly/event_horizon.jpg`,
  external_url: `${SITE}/artifacts`,
}, null, 2));

for (const t of TIERS) {
  fs.mkdirSync(path.join(OUT, t.slug), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'images', t.slug), { recursive: true });
  t.variants.forEach((v, i) => {
    const src = path.join(SRC_IMAGES, t.slug, `${v}.jpg`);
    const dst = path.join(OUT, 'images', t.slug, `${v}.jpg`);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    const image = `${SITE}/nft/images/${t.slug}/${v}.jpg`;
    const meta = {
      name: `${t.name} — ${title(v)}`,
      symbol: 'MFART',
      description:
        `${t.lore}\n\n` +
        `UTILITY (Moon Forge program + oracle):\n` +
        `• +${t.boost}% XEN burn score for the holder — counts only if held by the same owner at two consecutive epoch snapshots; best Artifact per wallet; it shifts shares within an epoch and never raises the epoch total\n` +
        `• ${t.chips} Burn Lottery chips every week (claim_artifact_chips; weeks reset Thursdays 00:00 UTC, missed weeks do not accumulate)\n` +
        `• Ticket to Artifact Duel: any live Artifact lets its holder create or join duels; the element played is chosen freely and hidden by commit-reveal\n` +
        (t.slug === 'lunar_dust'
          ? `• Refundable floor: 5 XNT when forged; the drop value (at least 5 XNT) when won as a Forge Drop; none for Genesis airdrop Lunar Dust — recycle to get it back. `
          : `• Refundable floor: half of the price its buyer paid (${t.price / 2} XNT at the base price) — recycle to get it back. `) +
        `The exact floor of each Artifact is its on-chain "Floor XNT" attribute\n` +
        `• Max ${t.supply} alive at any time; recycling frees the slot for a new forge\n` +
        (t.slug === 'lunar_dust'
          ? `• Also drawn among XEN burners as Forge Drops: 10% of each epoch budget (at most 100 XNT), paid to XEN burners as part of their epoch reward, as Lunar Dust holding a floor of at least 5 XNT\n\n`
          : `\n`) +
        (t.slug === 'lunar_dust'
          ? `Forge price ${t.price} XNT (fixed): 50% floor, 40% burners' reward pool, 5% Burn Lottery, 5% architect; 5% royalty on secondary sales where honored.`
          : `Base forge price ${t.price} XNT, +5% with every forge and ÷1.05 (-4.76%) per full week without one (never below base, never above 100× base); the buyer signs a max price. ` +
            `Of the price paid: 50% floor, 40% burners' reward pool, 5% Burn Lottery, 5% architect; 5% royalty on secondary sales where honored.`),
      image,
      external_url: `${SITE}/artifacts`,
      attributes: [
        { trait_type: 'Tier', value: t.name },
        { trait_type: 'Variant', value: title(v) },
        { trait_type: 'Element', value: t.element },
        { trait_type: 'Duel Ticket', value: 'Yes' },
        { trait_type: 'Burn Boost', value: `+${t.boost}%` },
        { trait_type: 'Weekly Chips', value: t.chips },
        { trait_type: 'Max Alive', value: t.supply },
        { trait_type: 'Recyclable', value: 'Yes' },
      ],
      properties: { category: 'image', files: [{ uri: image, type: 'image/jpeg' }] },
    };
    fs.writeFileSync(path.join(OUT, t.slug, `${i}.json`), JSON.stringify(meta, null, 2));
  });
}
console.log(`metadata written to ${OUT}`);
