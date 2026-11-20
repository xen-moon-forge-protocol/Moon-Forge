// Builds, and with --upload stores on Arweave, one mirror of the site and the repository files at a commit (see
// lib.mjs for the layout). Run by .github/workflows/mirror-arweave.yml; dry run by default.
//
// Usage: node scripts/mirror/build-mirror.mjs <out-dir> --site <dir> [--commit <sha>] [--bundle-ref <tag>]
//                                             [--upload] [--allow-paid] [--include-epochs] [--gateways a,b]
//   --site        the mirror build of the site: `vite build --mode mirror` + `node scripts/prerender.mjs --dist dist-mirror`
//   --commit      the commit whose repository files are copied (default HEAD); the site must be built from it
//   --bundle-ref  also write `git bundle create` of this ref (a release tag) and its sha256; uploaded only with
//                 --allow-paid (it is far above the free tier)
//   --upload      upload through ArDrive Turbo, signed by MIRROR_SIGNER_KEY (hex, optional) or a throwaway key made
//                 for this run; without --allow-paid every item must fit the free tier and the run never pays
//   --allow-paid  include the files above the free tier and the bundle; needs MIRROR_SIGNER_KEY with Turbo credits
// Writes <out>/stage/ (the exact bytes), <out>/plan.json, and after an upload <out>/result.json (the new entry) and
// <out>/mirrors.json (deployments/mirrors.json with the entry appended: commit it, then run sync-crosslinks.mjs).
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { Readable } from 'stream';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import {
  APP_NAME, MAX_FREE, appendMirror, buildManifest, contentType, depthOf, emptyRecord, mirrorNotice, mirrorUrls,
  planEntries, relativize, sha256, stripApp, validateRecord, withRuntimeBase,
} from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const [outArg, ...flags] = process.argv.slice(2);
const usage = 'usage: build-mirror.mjs <out-dir> --site <dir> [--commit <sha>] [--bundle-ref <tag>] [--upload] [--allow-paid] [--include-epochs] [--gateways a,b]';
if (!outArg || outArg.startsWith('--')) throw new Error(usage);
const opt = (name) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined);
const OUT = path.resolve(outArg);
const SITE = opt('--site') ? path.resolve(opt('--site')) : null;
if (!SITE || !fs.existsSync(path.join(SITE, 'index.html'))) throw new Error(`--site must name the mirror build (index.html missing). ${usage}`);
const UPLOAD = flags.includes('--upload');
const ALLOW_PAID = flags.includes('--allow-paid');
const INCLUDE_EPOCHS = flags.includes('--include-epochs');
const BUNDLE_REF = opt('--bundle-ref') || null;
const git = (...a) => execFileSync('git', a, { cwd: root, maxBuffer: 1 << 28 });
const COMMIT = git('rev-parse', opt('--commit') || 'HEAD').toString().trim();
const recordPath = path.join(root, 'deployments/mirrors.json');
const record = validateRecord(fs.existsSync(recordPath) ? JSON.parse(fs.readFileSync(recordPath, 'utf8')) : emptyRecord());
const GATEWAYS = (opt('--gateways') || record.gateways.join(',')).split(',').filter(Boolean);
const log = (...a) => console.log(...a);
const today = new Date().toISOString().slice(0, 10);

// ─── stage ───────────────────────────────────────────────────────────────────────────────────────────────────────
const STAGE = path.join(OUT, 'stage');
fs.rmSync(STAGE, { recursive: true, force: true });
const entries = [];
const put = (p, buf) => {
  const f = path.join(STAGE, p);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
  entries.push({ path: p, bytes: buf.length, sha256: sha256(buf) });
};

// The site: the app runs only if its entry script is copied too (paid run); otherwise the pages are read-only.
const siteFiles = fs.readdirSync(SITE, { recursive: true }).map((f) => String(f).split(path.sep).join('/')).filter((f) => fs.statSync(path.join(SITE, f)).isFile()).sort();
const indexHtml = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
if (!indexHtml.includes('globalThis.__MF_BASE__')) throw new Error('--site is not a mirror build (run `vite build --mode mirror`)');
const entryScripts = [...indexHtml.matchAll(/<script type="module"[^>]*src="\.\/([^"]+)"/g)].map((m) => m[1]);
const appFits = entryScripts.length > 0 && entryScripts.every((p) => ALLOW_PAID || fs.statSync(path.join(SITE, p)).size <= MAX_FREE);
const notice = mirrorNotice({ commit: COMMIT, date: today, full: appFits });
for (const p of siteFiles) {
  let buf = fs.readFileSync(path.join(SITE, p));
  if (p.endsWith('.html')) {
    let html = relativize(buf.toString('utf8'), p === '404.html' ? 0 : depthOf(p));
    if (!appFits) html = stripApp(html, notice);
    if (p === '404.html') html = withRuntimeBase(html);
    if (html.includes('"/Moon-Forge/')) throw new Error(`${p}: a root-relative /Moon-Forge/ link is left`);
    buf = Buffer.from(html, 'utf8');
  }
  put(p, buf);
}

// The repository files at the commit, exact bytes from git (not the working tree).
const tree = git('ls-tree', '-r', '-l', '-z', COMMIT).toString('utf8').split('\0').filter(Boolean).map((l) => {
  const [meta, file] = l.split('\t');
  const [mode, type, sha, size] = meta.split(/\s+/);
  return { mode, type, sha, size: Number(size), file };
}).filter((t) => t.type === 'blob' && t.mode !== '120000');
const batch = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: tree.map((t) => t.sha).join('\n') + '\n', maxBuffer: 1 << 30 });
if (batch.status !== 0) throw new Error(`git cat-file failed: ${batch.stderr}`);
let at = 0;
for (const t of tree) {
  const nl = batch.stdout.indexOf(10, at);
  const [sha, , size] = batch.stdout.subarray(at, nl).toString().split(' ');
  if (sha !== t.sha) throw new Error(`git cat-file: expected ${t.sha}, got ${sha}`);
  const body = batch.stdout.subarray(nl + 1, nl + 1 + Number(size));
  at = nl + 1 + Number(size) + 1;
  put(`source/${t.file}`, Buffer.from(body));
}

let bundle = null;
if (BUNDLE_REF) {
  const ref = git('rev-parse', `${BUNDLE_REF}^{commit}`).toString().trim();
  const file = path.join(OUT, 'moon-forge.bundle');
  git('bundle', 'create', file, BUNDLE_REF);
  const buf = fs.readFileSync(file);
  bundle = { path: `source/moon-forge-${BUNDLE_REF}.bundle`, ref: BUNDLE_REF, commit: ref, bytes: buf.length, sha256: sha256(buf) };
  if (ALLOW_PAID) put(bundle.path, buf);
  log(`git bundle of ${BUNDLE_REF} (${ref}): ${buf.length} bytes, sha256 ${bundle.sha256}${ALLOW_PAID ? '' : ' (not uploaded: above the free tier; needs --allow-paid)'}`);
}

const plan = planEntries(entries, { allowPaid: ALLOW_PAID, includeEpochs: INCLUDE_EPOCHS });
if (bundle && !ALLOW_PAID) plan.skipped.push({ path: bundle.path, bytes: bundle.bytes, reason: `above the free tier (${MAX_FREE} bytes)` });
const inventory = {
  kind: 'moon-forge-mirror', version: 1, commit: COMMIT, builtAt: new Date().toISOString(),
  site: 'https://xen-moon-forge-protocol.github.io/Moon-Forge/', programId: '57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9',
  app: appFits ? 'included' : 'left out (above the free tier): the pages are read-only',
  bundle: bundle ? { ...bundle, included: ALLOW_PAID } : null,
  files: Object.fromEntries([...plan.uploads.map((f) => [f.path, { bytes: f.bytes, sha256: f.sha256 }]), ...plan.aliases.map((a) => [a.path, { sameAs: a.sameAs }])].sort(([a], [b]) => a.localeCompare(b))),
  leftOut: plan.skipped,
};
// one file per line: readable, and small enough for the free tier
const inventoryText = JSON.stringify({ ...inventory, files: '__F__', leftOut: '__L__' }, null, 1)
  .replace('"__F__"', `{\n${Object.entries(inventory.files).map(([p, v]) => `  ${JSON.stringify(p)}: ${JSON.stringify(v)}`).join(',\n')}\n }`)
  .replace('"__L__"', `[\n${inventory.leftOut.map((s) => `  ${JSON.stringify(s)}`).join(',\n')}\n ]`);
JSON.parse(inventoryText);
put('MIRROR.json', Buffer.from(inventoryText + '\n'));
if (!ALLOW_PAID && entries[entries.length - 1].bytes > MAX_FREE) throw new Error(`MIRROR.json is ${entries[entries.length - 1].bytes} B, above the free tier`);
plan.uploads.push(entries[entries.length - 1]);
plan.freeBytes += entries[entries.length - 1].bytes;

const summary = {
  commit: COMMIT, app: inventory.app, gateways: GATEWAYS, uploads: plan.uploads.length, aliases: plan.aliases.length,
  skipped: plan.skipped.length, freeBytes: plan.freeBytes, paidBytes: plan.paidBytes, bundle,
  skippedPaths: plan.skipped.map((s) => `${s.path} (${s.bytes} B): ${s.reason}`),
};
fs.writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify(summary, null, 2));
log(`mirror of ${COMMIT}: ${plan.uploads.length} items to upload (${plan.freeBytes} B within the free tier, ${plan.paidBytes} B paid), ${plan.aliases.length} aliases, ${plan.skipped.length} left out; app ${inventory.app}`);
for (const s of summary.skippedPaths) log(`  left out: ${s}`);
for (const p of ['index.html', 'llms.txt', 'llms-full.txt', '.well-known/agent-card.json', 'agent-card.json', 'links.json', 'source/docs/HOW-IT-WORKS.md', 'source/README.md']) {
  if (!plan.uploads.some((f) => f.path === p) && !plan.aliases.some((a) => a.path === p)) throw new Error(`${p} would not be in the mirror`);
}
if (!UPLOAD) {
  log(`dry run: nothing uploaded. Staged bytes: ${STAGE}  plan: ${path.join(OUT, 'plan.json')}`);
  process.exit(0);
}

// ─── upload ──────────────────────────────────────────────────────────────────────────────────────────────────────
// the Turbo SDK pinned by scripts/nft-metadata/package-lock.json (installed there with npm ci --ignore-scripts): no new dependency
const { TurboFactory } = createRequire(path.join(root, 'scripts/nft-metadata/package.json'))('@ardrive/turbo-sdk');
const signerKey = process.env.MIRROR_SIGNER_KEY?.trim() || null;
if (ALLOW_PAID && !signerKey) throw new Error('--allow-paid needs MIRROR_SIGNER_KEY (a key holding Turbo credits): nothing uploaded');
const turbo = TurboFactory.authenticated({ privateKey: signerKey ? (signerKey.startsWith('0x') ? signerKey : `0x${signerKey}`) : `0x${crypto.randomBytes(32).toString('hex')}`, token: 'ethereum' });
const totalFree = plan.uploads.filter((f) => f.bytes <= MAX_FREE).reduce((n, f) => n + f.bytes, 0);
const { bytesRemaining } = await turbo.getFreeStatus().catch(() => ({ bytesRemaining: null }));
if (!ALLOW_PAID && bytesRemaining !== null && bytesRemaining !== undefined && bytesRemaining < totalFree * 1.1) throw new Error(`free allowance ${bytesRemaining} B < ${totalFree} B needed: refusing (a free run never pays)`);
for (const f of plan.uploads) if (!ALLOW_PAID && f.bytes > MAX_FREE) throw new Error(`${f.path} above the free tier: refusing`);
log(`uploading ${plan.uploads.length} items (free allowance ${bytesRemaining ?? 'unlimited'})`);

const tagsFor = (p) => [
  { name: 'Content-Type', value: contentType(p) },
  { name: 'App-Name', value: APP_NAME },
  { name: 'Moon-Forge-Commit', value: COMMIT },
  { name: 'Moon-Forge-Path', value: p },
];
async function uploadBuf(buf, tags) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await turbo.uploadFile({ fileStreamFactory: () => Readable.from(buf), fileSizeFactory: () => buf.length, dataItemOpts: { tags } });
      if (!r?.id) throw new Error('no id in the upload response');
      return r;
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((res) => setTimeout(res, 5_000 * (i + 1)));
    }
  }
}
const ids = {};
let done = 0;
const queue = [...plan.uploads];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const f = queue.shift();
    ids[f.path] = (await uploadBuf(fs.readFileSync(path.join(STAGE, f.path)), tagsFor(f.path))).id;
    if (++done % 50 === 0) log(`  ${done}/${plan.uploads.length}`);
  }
}));
for (const a of plan.aliases) ids[a.path] = ids[a.sameAs];
const manifest = buildManifest(ids);
const manifestBuf = Buffer.from(JSON.stringify(manifest));
if (!ALLOW_PAID && manifestBuf.length > MAX_FREE) throw new Error(`manifest ${manifestBuf.length} B above the free tier: refusing`);
const manifestUp = await uploadBuf(manifestBuf, [
  { name: 'Content-Type', value: 'application/x.arweave-manifest+json' },
  { name: 'App-Name', value: APP_NAME }, { name: 'Moon-Forge-Commit', value: COMMIT }, { name: 'Moon-Forge-Path', value: '' },
]);
const manifestId = manifestUp.id;
fs.writeFileSync(path.join(OUT, 'manifest.json'), manifestBuf);
log(`manifest ${manifestId}: ${mirrorUrls(manifestId, GATEWAYS).join('  ')}`);

const entry = {
  manifest: manifestId,
  manifestSha256: sha256(manifestBuf),
  commit: COMMIT,
  uploadedAt: new Date().toISOString(),
  uploadedBy: `GitHub Actions run ${process.env.GITHUB_RUN_ID ?? 'local'} (Arweave mirror), ${signerKey ? 'project mirror key' : 'throwaway key'}, ArDrive Turbo ${ALLOW_PAID ? 'credits' : 'free tier'}`,
  // the Arweave owner address of the signing key: constant across uploads only with MIRROR_SIGNER_KEY, so only then
  // can a reader find every genuine copy by owner (GraphQL owners: [...]) without GitHub
  owner: manifestUp.owner ?? null,
  stableOwner: Boolean(signerKey),
  app: inventory.app,
  files: Object.keys(inventory.files).length,
  bytes: plan.freeBytes + plan.paidBytes,
  leftOut: plan.skipped.length,
  mirrorJson: { id: ids['MIRROR.json'], sha256: entries[entries.length - 1].sha256 },
  bundle: bundle && ALLOW_PAID ? { id: ids[bundle.path], path: bundle.path, ref: bundle.ref, commit: bundle.commit, bytes: bundle.bytes, sha256: bundle.sha256 } : null,
};
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(entry, null, 2));
fs.writeFileSync(path.join(OUT, 'mirrors.json'), JSON.stringify(appendMirror(record, entry), null, 2) + '\n');

// First serve check (a gateway right after an upload serves from Turbo's cache: this proves the ids and bytes, not
// permanence; check-mirrors.mjs repeats it later on every gateway).
const { checkMirror } = await import('./check-mirrors.mjs');
for (let round = 0; round < 12; round++) {
  const r = await checkMirror(manifestId, GATEWAYS[0], inventory);
  log(`serve check ${GATEWAYS[0]} round ${round + 1}: ${r.ok}/${r.total}`);
  if (r.ok === r.total) break;
  await new Promise((res) => setTimeout(res, 30_000));
}
log(`\nnext: commit ${path.join(OUT, 'mirrors.json')} as deployments/mirrors.json, then run node scripts/mirror/sync-crosslinks.mjs`);
