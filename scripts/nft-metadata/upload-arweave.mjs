// Uploads the Artifact images and the PERMANENT metadata (texts-final.mjs) to Arweave through ArDrive Turbo's free
// tier. Every file is under the free limit, so nothing is paid; uploads are signed by a throwaway key generated for
// this run and never stored: it owns nothing and pays nothing.
//
// Steps (run by .github/workflows/nft-arweave.yml):
//   1. preflight: the 12 WebP in nft-arweave/images carry no EXIF/XMP/C2PA or other identifying bytes; the texts lint
//      clean (lint-permanent.mjs); every file fits the free tier.
//   2. images -> manifest A (or --images A: reused only if all 12 images AND the manifest serve with matching sha256
//      on every image gateway AND rebuild from Arweave L1; decision D-32).
//   3. one metadata set per image gateway G (default turbo-gateway.com and ar-io.dev): the 13 JSON with
//      image = https://G/A/<tier>/<variant>.webp -> manifest B_G. The JSON embeds its image gateway forever, so the
//      gateway is chosen AFTER the 7-day check by picking the set: METADATA_BASE_URI = https://G/B_G/.
//   4. result.json = the record (commit it as deployments/nft-arweave-final.json); a first serve check per set.
// Then check-gateways.mjs runs daily: 27/27 per set on two gateways and on L1 for 7 consecutive days.
//
// Usage: node scripts/nft-metadata/upload-arweave.mjs <out-dir> [--dry-run] [--sandbox] [--images <manifest id>]
//                                                     [--image-gateways turbo-gateway.com,ar-io.dev]
//   --dry-run  builds and prints the whole manifest (paths, bytes, sha256, image URLs), uploads nothing, needs no SDK
//   --sandbox  rehearses on the ar.io testnet sandbox (data purged after a few days); never a record to commit
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { IMAGE_PATHS, JSON_PATHS } from './tiers.mjs';
import { buildFinal, serialize } from './texts-final.mjs';
import { lintFiles, printHits } from './lint-permanent.mjs';
import { DEFAULT_GATEWAYS, ID_RE, rawManifest, scanWebp, sha256 } from './arweave.mjs';
import { checkSetOnGateway, checkSetOnL1, expectedBytes } from './check-gateways.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const [outArg, ...flags] = process.argv.slice(2);
if (!outArg || outArg.startsWith('--')) throw new Error('usage: upload-arweave.mjs <out-dir> [--dry-run] [--sandbox] [--images <id>] [--image-gateways a,b]');
const opt = (name) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined);
const DRY = flags.includes('--dry-run');
const SANDBOX = flags.includes('--sandbox');
const REUSE_IMAGES = opt('--images') || null;
if (flags.includes('--images') && REUSE_IMAGES && !ID_RE.test(REUSE_IMAGES)) throw new Error('--images needs a 43-character manifest id');
const IMAGE_GATEWAYS = (opt('--image-gateways') || (SANDBOX ? 'ar-io.dev' : DEFAULT_GATEWAYS.join(','))).split(',').filter(Boolean);
for (const g of IMAGE_GATEWAYS) if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(g)) throw new Error(`bad gateway host ${g}`);
const OUT = path.resolve(outArg);
const IMAGES = path.join(root, 'nft-arweave/images');
const MAX_ITEM = 100 * 1024; // the free tier takes items up to 105 KiB, headers and tags included
export const DRY_RUN_ID = 'DRYRUN-placeholder-not-an-arweave-id'.padEnd(43, '0');
const log = (...a) => console.log(...a);

// ─── 1. preflight ──────────────────────────────────────────────────────────
function preflight() {
  const images = {};
  const problems = [];
  const onDisk = fs.readdirSync(IMAGES, { recursive: true }).map((f) => String(f).split(path.sep).join('/')).filter((f) => fs.statSync(path.join(IMAGES, f)).isFile()).sort();
  if (onDisk.join() !== [...IMAGE_PATHS].sort().join()) problems.push(`nft-arweave/images must hold exactly the 12 variant WebP files, found: ${onDisk.join(', ')}`);
  for (const p of IMAGE_PATHS) {
    const f = path.join(IMAGES, p);
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    if (buf.length > MAX_ITEM) problems.push(`${p}: ${buf.length} bytes, above the free tier`);
    for (const i of scanWebp(buf)) problems.push(`${p}: ${i}`);
    images[p] = { bytes: buf.length, sha256: sha256(buf) };
  }
  return { images, problems };
}

function buildSet(imagesManifest, gateway) {
  const imageBase = `https://${gateway}/${imagesManifest}`;
  const files = buildFinal({ imageBase, imageExt: 'webp' });
  const hits = lintFiles(files, { imageBase });
  const bytes = Object.fromEntries(JSON_PATHS.map((p) => [p, serialize(files[p])]));
  return { gateway, imageBase, files, bytes, hits };
}

function writeSet(set) {
  const dir = path.join(OUT, 'metadata', set.gateway);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [p, b] of Object.entries(set.bytes)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), b);
  }
  return dir;
}

function printManifest(images, imagesManifest, sets) {
  log(`\nimages manifest: ${imagesManifest}${imagesManifest === DRY_RUN_ID ? ' (dry-run placeholder)' : ''}`);
  for (const [p, v] of Object.entries(images)) log(`  ${p.padEnd(34)} ${String(v.bytes).padStart(6)} B  sha256 ${v.sha256}`);
  for (const s of sets) {
    log(`\nmetadata set "${s.gateway}"  (image base ${s.imageBase}/)  METADATA_BASE_URI would be https://${s.gateway}/<B>/`);
    for (const p of JSON_PATHS) log(`  ${p.padEnd(22)} ${String(s.bytes[p].length).padStart(6)} B  sha256 ${sha256(s.bytes[p])}  image ${s.files[p].image.slice(s.imageBase.length + 1)}`);
    log(`  lint: ${s.hits.length ? `${s.hits.length} hit(s)` : 'clean'}`);
    if (s.hits.length) printHits(s.hits);
  }
}

// ─── run ───────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
const pre = preflight();
log(`preflight: ${Object.keys(pre.images).length} images, ${pre.problems.length ? pre.problems.length + ' problem(s)' : 'clean (no EXIF/XMP/C2PA, all under the free tier)'}`);
for (const p of pre.problems) log(`  ${p}`);
// lint once with a placeholder, so a text problem stops the run before anything is uploaded
const probe = IMAGE_GATEWAYS.map((g) => buildSet(DRY_RUN_ID, g));
const textHits = probe.flatMap((s) => s.hits);
if (pre.problems.length || textHits.length) {
  if (textHits.length) { log('permanent-text lint:'); printHits(textHits); }
  if (!DRY) throw new Error('preflight failed: nothing uploaded');
}

// Reuse of an images manifest (D-32): every image gateway 13/13 and L1 13/13, else refuse.
async function reuseCheck(id) {
  const rec = { images: { manifest: id, files: {} }, texts: 'final' };
  // the manifest gives the ids; the bytes must equal nft-arweave/images
  const m = await rawManifest(IMAGE_GATEWAYS[0], id);
  if (!m.ok) return { ok: false, why: `manifest ${id}: ${m.error}` };
  rec.images.files = Object.fromEntries(Object.entries(m.json.paths).map(([p, v]) => [p, { id: v.id }]));
  const set = { gateway: IMAGE_GATEWAYS[0], imageBaseUri: `https://${IMAGE_GATEWAYS[0]}/${id}/`, files: {} };
  const exp = expectedBytes(rec, set);
  const out = {};
  const opts = { attempts: 2, backoffMs: [0, 15_000] };
  for (const g of IMAGE_GATEWAYS) out[g] = await checkSetOnGateway(rec, set, exp, g, { imagesOnly: true, opts });
  out['Arweave L1'] = await checkSetOnL1(rec, set, exp, { imagesOnly: true, opts });
  const ok = Object.values(out).every((r) => r.ok === r.total);
  return { ok, out, files: rec.images.files, manifestSha256: sha256(m.buf) };
}

let imagesManifest = DRY_RUN_ID;
let imageFiles = Object.fromEntries(Object.entries(pre.images).map(([p, v]) => [p, { id: null, ...v }]));
let imagesManifestSha = null;
let reused = false;
let reuseRefused = false;
if (REUSE_IMAGES) {
  log(`\nreuse check of images manifest ${REUSE_IMAGES} on ${IMAGE_GATEWAYS.join(', ')} and Arweave L1 ...`);
  const r = await reuseCheck(REUSE_IMAGES);
  if (r.out) for (const [g, x] of Object.entries(r.out)) log(`  ${g.padEnd(20)} ${x.ok}/${x.total}${x.failures.length ? '  e.g. ' + x.failures[0].item + ': ' + x.failures[0].why : ''}`);
  if (!r.ok) {
    log(`  => REFUSED: ${r.why ?? 'not every image serves with a matching sha256 everywhere'}; upload the images again (omit --images)`);
    reuseRefused = true;
    if (!DRY) process.exit(1);
  } else {
    log('  => reusable');
    imagesManifest = REUSE_IMAGES;
    imageFiles = Object.fromEntries(IMAGE_PATHS.map((p) => [p, { id: r.files[p].id, ...pre.images[p] }]));
    imagesManifestSha = r.manifestSha256;
    reused = true;
  }
}

if (DRY) {
  const sets = IMAGE_GATEWAYS.map((g) => buildSet(imagesManifest, g));
  for (const s of sets) writeSet(s);
  printManifest(pre.images, imagesManifest, sets);
  const plan = {
    dryRun: true, builtAt: new Date().toISOString(), imageGateways: IMAGE_GATEWAYS, imagesManifest, reusedImages: reused, reuseRefused,
    images: pre.images,
    sets: sets.map((s) => ({ gateway: s.gateway, imageBaseUri: `${s.imageBase}/`, files: Object.fromEntries(JSON_PATHS.map((p) => [p, { bytes: s.bytes[p].length, sha256: sha256(s.bytes[p]) }])), lintHits: s.hits.length })),
    uploads: { images: reused ? 0 : IMAGE_PATHS.length + 1, metadata: sets.length * (JSON_PATHS.length + 1) },
  };
  fs.writeFileSync(path.join(OUT, 'dry-run.json'), JSON.stringify(plan, null, 2));
  log(`\ndry run: would upload ${plan.uploads.images} image item(s) and ${plan.uploads.metadata} metadata item(s) (manifests included); nothing uploaded.`);
  log(`files for review: ${path.join(OUT, 'metadata')}  plan: ${path.join(OUT, 'dry-run.json')}`);
  process.exit(pre.problems.length || reuseRefused || sets.some((s) => s.hits.length) ? 1 : 0);
}

// ─── 2-3. upload ───────────────────────────────────────────────────────────
const { TurboFactory } = await import('@ardrive/turbo-sdk');
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
  const files = fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, String(f))).filter((f) => fs.statSync(f).isFile());
  const total = files.reduce((n, f) => n + fs.statSync(f).size, 0);
  for (const f of files) if (fs.statSync(f).size > MAX_ITEM) throw new Error(`${f} above the free tier: refusing to upload`);
  const { bytesRemaining } = await turbo.getFreeStatus();
  if (bytesRemaining !== null && bytesRemaining < total * 1.1) throw new Error(`free allowance ${bytesRemaining} bytes < ${total} needed: refusing (this run never pays)`);
  log(`${label}: uploading ${files.length} files, ${total} bytes (free allowance ${bytesRemaining ?? 'unlimited'})`);
  const { manifest, manifestResponse } = await turbo.uploadFolder({ folderPath: dir, throwOnFailure: true });
  const rel = (f) => path.relative(dir, f).split(path.sep).join('/');
  const missing = files.map(rel).filter((p) => !manifest.paths[p]?.id);
  if (missing.length) throw new Error(`${label}: not in the manifest: ${missing.join(', ')}`);
  log(`${label}: manifest ${manifestResponse.id}`);
  return { id: manifestResponse.id, paths: manifest.paths, manifestSha256: sha256(Buffer.from(JSON.stringify(manifest))) };
}

if (!reused) {
  const up = await upload(IMAGES, 'images');
  imagesManifest = up.id;
  imagesManifestSha = up.manifestSha256;
  imageFiles = Object.fromEntries(IMAGE_PATHS.map((p) => [p, { id: up.paths[p].id, ...pre.images[p] }]));
}
const record = {
  kind: 'moon-forge-nft-arweave', version: 2,
  status: 'candidate for the final program upgrade (planned for November 2026): not used by the live program; the texts describe the program after that upgrade',
  network: SANDBOX ? 'ar.io testnet sandbox (ephemeral)' : 'arweave mainnet',
  sandbox: SANDBOX,
  uploadedAt: new Date().toISOString(),
  uploadedBy: `GitHub Actions run ${process.env.GITHUB_RUN_ID ?? 'local'} (NFT metadata to Arweave), throwaway key, ArDrive Turbo free tier`,
  sourceCommit: process.env.GITHUB_SHA ?? null,
  texts: 'final',
  images: { manifest: imagesManifest, manifestSha256: imagesManifestSha, reused, files: imageFiles },
  sets: [],
  note: 'Pick ONE set after 7 consecutive passing days of check-gateways.mjs (27/27 on two gateways and on L1); METADATA_BASE_URI = its metadataBaseUri.',
};
const resultPath = path.join(OUT, 'result.json');
const save = () => fs.writeFileSync(resultPath, JSON.stringify(record, null, 2));
save(); // the image ids are kept even if a metadata upload fails
for (const g of IMAGE_GATEWAYS) {
  const s = buildSet(imagesManifest, g);
  if (s.hits.length) throw new Error(`lint hits for ${g} after the image upload`);
  const up = await upload(writeSet(s), `metadata (${g})`);
  record.sets.push({
    gateway: g, imageBaseUri: `${s.imageBase}/`, manifest: up.id, manifestSha256: up.manifestSha256,
    metadataBaseUri: `https://${g}/${up.id}/`,
    files: Object.fromEntries(JSON_PATHS.map((p) => [p, { id: up.paths[p].id, bytes: s.bytes[p].length, sha256: sha256(s.bytes[p]) }])),
  });
  save(); // ids kept even if a later step fails
}

// ─── 4. first serve check (own gateway, up to ~6 minutes per set; L1 seeding takes hours and is left to the daily check) ──
for (const set of record.sets) {
  const exp = expectedBytes(record, set);
  let r;
  for (let round = 0; round < 12; round++) {
    r = await checkSetOnGateway(record, set, exp, set.gateway, { opts: { attempts: 1 } });
    if (r.ok === r.total) break;
    await new Promise((res) => setTimeout(res, 30_000));
  }
  // a gateway right after an upload serves from Turbo's cache: this proves the ids and bytes, not permanence
  set.uploadCheck = { at: new Date().toISOString(), gateway: set.gateway, kind: 'gateway cache, not L1', ok: r.ok, total: r.total, failures: r.failures };
  save();
  log(`serve check "${set.gateway}": ${r.ok}/${r.total}`);
}
log(JSON.stringify(record, null, 2));
log(`\nnext: commit ${path.relative(root, resultPath)} as deployments/nft-arweave-final.json; the daily check starts from it.`);
