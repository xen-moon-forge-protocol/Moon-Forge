// Generates the off-chain JSON metadata of the Moon Forge Artifacts (Metaplex standard): collection.json and
// <tier_slug>/<variant>.json for the 12 artwork variants (13 files; variant order in tiers.mjs).
//
//   node scripts/nft-metadata/generate-metadata.mjs
//       v2 texts (texts-v2.mjs) into frontend/public/nft, images copied: the copy served by GitHub Pages, which the
//       LIVE program points at. Output is byte-identical to the committed files until the final upgrade.
//   NFT_OUT=<dir> NFT_IMAGE_BASE=https://<gateway>/<images manifest> node scripts/nft-metadata/generate-metadata.mjs --texts final
//       the PERMANENT texts (texts-final.mjs) for the Arweave upload, JSON only, linted (lint-permanent.mjs); refuses
//       to write into frontend/public/nft before the final upgrade, so the site never shows future rules as live.
//
// upload-arweave.mjs calls buildFinal() directly; this CLI is for review and for the Pages copy.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SITE, TIERS } from './tiers.mjs';
import { buildV2 } from './texts-v2.mjs';
import { buildFinal, serialize } from './texts-final.mjs';
import { lintFiles, printHits } from './lint-permanent.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PAGES = path.join(root, 'frontend/public/nft');
const args = process.argv.slice(2);
const TEXTS = args.includes('--texts') ? args[args.indexOf('--texts') + 1] : 'v2';
if (!['v2', 'final'].includes(TEXTS)) throw new Error('--texts must be v2 or final');
const OUT = process.env.NFT_OUT ? path.resolve(process.env.NFT_OUT) : PAGES;

export function writeTree(out, files) {
  for (const [rel, obj] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
    fs.writeFileSync(path.join(out, rel), serialize(obj));
  }
}

if (TEXTS === 'v2') {
  const copyImages = !process.env.NFT_OUT;
  const files = buildV2({ imageBase: process.env.NFT_IMAGE_BASE ?? `${SITE}/nft/images`, imageExt: process.env.NFT_IMAGE_EXT ?? 'jpg' });
  writeTree(OUT, files);
  if (copyImages) {
    for (const t of TIERS) {
      fs.mkdirSync(path.join(OUT, 'images', t.slug), { recursive: true });
      for (const v of t.variants) {
        const src = path.join(root, 'frontend/src/assets/nft', t.slug, `${v}.jpg`);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, 'images', t.slug, `${v}.jpg`));
      }
    }
  }
} else {
  const rel = path.relative(PAGES, OUT);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('the final texts are not written into frontend/public/nft before the final upgrade; set NFT_OUT');
  }
  if (!process.env.NFT_IMAGE_BASE) throw new Error('NFT_IMAGE_BASE=https://<gateway>/<images manifest id> is required');
  const files = buildFinal({ imageBase: process.env.NFT_IMAGE_BASE, imageExt: 'webp' });
  const hits = lintFiles(files, { imageBase: process.env.NFT_IMAGE_BASE });
  if (hits.length) {
    console.log(`permanent-text lint: ${hits.length} hit(s), nothing written`);
    printHits(hits);
    process.exit(1);
  }
  writeTree(OUT, files);
}
console.log(`metadata (${TEXTS} texts) written to ${path.relative(root, OUT) || OUT}`);
