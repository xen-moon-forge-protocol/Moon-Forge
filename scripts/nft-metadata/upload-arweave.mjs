// Uploads the Artifact images and metadata to Arweave (permanent storage) through ArDrive Turbo.
// Every file is under Turbo's free tier limit, so nothing is paid. The uploads are signed by a
// throwaway key generated for this run and never stored: it owns nothing and pays nothing.
//
// Two steps, because the metadata must point at the images:
//   1. nft-arweave/images (WebP, see build-webp.py)                → manifest A
//   2. the metadata JSON, with  image = <gateway>/<A>/<tier>/<variant>.webp  → manifest B
// The program's METADATA_BASE_URI is then  https://arweave.net/<B>/  (constants.rs), and the
// collection and every asset resolve to  <B>/collection.json  and  <B>/<tier_slug>/<variant>.json.
//
// Usage: node scripts/nft-metadata/upload-arweave.mjs <out-dir> [--sandbox]
//   --sandbox  rehearses the whole run on the ar.io testnet sandbox (data purged after a few days)
// Run by .github/workflows/nft-arweave.yml.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { TurboFactory } from '@ardrive/turbo-sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const [outArg, ...flags] = process.argv.slice(2);
if (!outArg) throw new Error('usage: upload-arweave.mjs <out-dir> [--sandbox]');
const SANDBOX = flags.includes('--sandbox');
const OUT = path.resolve(outArg);
const IMAGES = path.join(root, 'nft-arweave/images');
const JSON_DIR = path.join(OUT, 'metadata');
const MAX_ITEM = 100 * 1024; // the free tier takes items up to 105 KiB, headers and tags included
const GATEWAY = SANDBOX ? 'https://ar-io.dev' : 'https://arweave.net';

const listFiles = (dir) =>
  fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile());
const rel = (dir, f) => path.relative(dir, f).split(path.sep).join('/');

const turbo = TurboFactory.authenticated({
  privateKey: '0x' + crypto.randomBytes(32).toString('hex'),
  token: 'ethereum',
  ...(SANDBOX
    ? {
        gatewayUrl: 'https://sepolia.gateway.tenderly.co',
        paymentServiceConfig: { url: 'https://payment.services.ar-io.dev' },
        uploadServiceConfig: { url: 'https://upload.services.ar-io.dev' },
      }
    : {}),
});

async function upload(dir, label) {
  const files = listFiles(dir);
  let total = 0;
  for (const f of files) {
    const n = fs.statSync(f).size;
    if (n > MAX_ITEM) throw new Error(`${rel(dir, f)} is ${n} bytes, above the free tier: refusing to upload`);
    total += n;
  }
  const { bytesRemaining } = await turbo.getFreeStatus();
  if (bytesRemaining !== null && bytesRemaining < total * 1.1) {
    throw new Error(`free allowance ${bytesRemaining} bytes < ${total} needed: refusing (this run never pays)`);
  }
  console.log(`${label}: uploading ${files.length} files, ${total} bytes (free allowance ${bytesRemaining ?? 'unlimited'})`);
  const { manifest, manifestResponse } = await turbo.uploadFolder({ folderPath: dir, throwOnFailure: true });
  const ids = Object.fromEntries(Object.entries(manifest.paths).map(([p, v]) => [p, v.id]));
  const missing = files.map((f) => rel(dir, f)).filter((p) => !ids[p]);
  if (missing.length) throw new Error(`${label}: not in the manifest: ${missing.join(', ')}`);
  console.log(`${label}: manifest ${manifestResponse.id}`);
  return { manifest: manifestResponse.id, ids };
}

// Waits until every path resolves through the gateway manifest with the right content type.
async function verify(manifest, paths, type) {
  const pending = new Set(paths);
  for (let attempt = 0; attempt < 40 && pending.size; attempt++) {
    for (const p of [...pending]) {
      try {
        const r = await fetch(`${GATEWAY}/${manifest}/${p}`, { method: 'GET', redirect: 'follow' });
        if (r.ok && (r.headers.get('content-type') ?? '').startsWith(type)) pending.delete(p);
      } catch {}
    }
    if (pending.size) await new Promise((r) => setTimeout(r, 15_000));
  }
  return [...pending];
}

fs.mkdirSync(OUT, { recursive: true });
const images = await upload(IMAGES, 'images');
const imageBase = `${GATEWAY}/${images.manifest}`;

fs.rmSync(JSON_DIR, { recursive: true, force: true });
execFileSync(process.execPath, [path.join(here, 'generate-metadata.mjs')], {
  env: { ...process.env, NFT_OUT: JSON_DIR, NFT_IMAGE_BASE: imageBase, NFT_IMAGE_EXT: 'webp' },
  stdio: 'inherit',
});
const metadata = await upload(JSON_DIR, 'metadata');

const result = {
  network: SANDBOX ? 'ar.io testnet sandbox (ephemeral)' : 'arweave mainnet (permanent)',
  imagesManifest: images.manifest,
  metadataManifest: metadata.manifest,
  imageBaseUri: `${imageBase}/`,
  metadataBaseUri: `${GATEWAY}/${metadata.manifest}/`,
  images: images.ids,
  metadata: metadata.ids,
};
// written before the gateway check, so the ids are kept even if that check runs out of time
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
const missingImages = await verify(images.manifest, Object.keys(images.ids), 'image/webp');
const missingJson = await verify(metadata.manifest, Object.keys(metadata.ids), 'application/json');
result.notYetServed = [...missingImages.map((p) => `images/${p}`), ...missingJson.map((p) => `metadata/${p}`)];
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (result.notYetServed.length) console.log('some paths are not served yet; re-check them before using metadataBaseUri');
