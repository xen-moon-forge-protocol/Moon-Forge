// The Artifact tiers and their artwork variants, shared by every metadata text set (texts-v2.mjs, texts-final.mjs).
//
// The program picks an asset's JSON with  variant = serial % variants  (constants.rs ARTIFACT_VARIANTS) and writes
// <METADATA_BASE_URI><tier_slug>/<variant>.json, so the VARIANT ORDER BELOW MUST NEVER CHANGE once the collection
// exists. Tier names, slugs, elements and supply caps mirror constants.rs / artifacts.rs; test/metadata.test.mjs
// fails if they drift apart.

export const SITE = 'https://xen-moon-forge-protocol.github.io/Moon-Forge';
export const PROGRAM_ID = '57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9';
// Core collection = program PDA ["collection"]; its update authority is the program PDA ["artifact_authority"].
export const COLLECTION = '7Re1n5DsnvyJnDTiaaZZ1f9G9REPRwb2Br7SYVYCfpzK';
export const COLLECTION_NAME = 'Moon Forge Artifacts';
export const SYMBOL = 'MFART';

export const TIERS = [
  { slug: 'lunar_dust', name: 'Lunar Dust', element: 'Lunar', supply: 600,
    variants: ['frost_blue', 'golden_dust', 'lavender_mist', 'rose_quartz', 'sage_green', 'silver_moon'],
    lore: 'Fine regolith swept from the craters where XEN was forged into light.' },
  { slug: 'cosmic_shard', name: 'Cosmic Shard', element: 'Cosmic', supply: 300,
    variants: ['amethyst', 'aquamarine', 'magenta_pulse'],
    lore: 'A crystal splinter of the burn, still humming with the chain it left behind.' },
  { slug: 'solar_core', name: 'Solar Core', element: 'Solar', supply: 90,
    variants: ['flame', 'red_giant'],
    lore: 'The molten heart of a thousand missions, too hot to hold for long.' },
  { slug: 'void_anomaly', name: 'Void Anomaly', element: 'Void', supply: 10,
    variants: ['event_horizon'],
    lore: 'Where the burned supply goes. Only ten can exist at once.' },
];

export const title = (s) => s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

// The 13 metadata paths the program can ever request, and the 12 image paths of the Arweave image folder.
export const JSON_PATHS = ['collection.json', ...TIERS.flatMap((t) => t.variants.map((_, i) => `${t.slug}/${i}.json`))];
export const IMAGE_PATHS = TIERS.flatMap((t) => t.variants.map((v) => `${t.slug}/${v}.webp`));
