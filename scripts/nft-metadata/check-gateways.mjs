// Gateway + L1 check of an Arweave metadata upload: the gate before METADATA_BASE_URI is compiled into the final
// program (docs/WORDING.md section 4, CLAIMS E4, decision D-32). Read-only; signs nothing.
//
// For every metadata set of the record (one per image gateway, see upload-arweave.mjs) it counts 27 paths:
//   2 path manifests (images + that set's metadata, read raw, every path -> id exactly as recorded)
//   12 images and 13 JSON through the manifests (HTTP 200, right content type, sha256 equal to the repository bytes)
// on EVERY listed gateway, plus the same 27 items rebuilt from Arweave L1 chunks (bundle mined AND data seeded).
// A set passes a day only with 27/27 on each gateway and 27/27 on L1, and only if the record's imageBaseUri and
// metadataBaseUri are exactly the bases that were checked. A URI may be compiled only after 7 consecutive passing
// UTC days of that exact metadataBaseUri, up to the latest day in the log (verdict(): per set AND URI; reports
// without L1 or without every default gateway do not count).
//
// Usage:
//   node scripts/nft-metadata/check-gateways.mjs [--record deployments/nft-arweave-final.json] [--gateways a,b]
//        [--set <gateway>] [--no-l1] [--images-only] [--json <out.json>] [--log <log.jsonl>] [--strict]
//        [--attempts 3] [--require-record] [--verbose]
//   node scripts/nft-metadata/check-gateways.mjs --verdict <log.jsonl | dir of reports> [--days 7]
// Exit: 0 when at least one set passes (all sets with --strict; verdict: a set has the streak), 1 otherwise, 2 usage.
// The record may also be the void 2026-10-14 record (deployments/nft-arweave.json, v2 texts), to show the method.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { IMAGE_PATHS, JSON_PATHS } from './tiers.mjs';
import { buildFinal, serialize } from './texts-final.mjs';
import { buildV2 } from './texts-v2.mjs';
import { DEFAULT_GATEWAYS, ID_RE, fetchBytes, l1Payload, pool, rawManifest, sha256 } from './arweave.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
export const IMAGES_DIR = path.join(root, 'nft-arweave/images');
export const DEFAULT_RECORD = path.join(root, 'deployments/nft-arweave-final.json');
let verbose = false;
const progress = (msg) => verbose && process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);

// ─── record ────────────────────────────────────────────────────────────────
export function normalizeRecord(rec) {
  if (rec?.kind === 'moon-forge-nft-arweave' && rec.version === 2) return rec;
  if (rec?.imagesManifest && rec?.metadataManifest) {
    // the 2026-10-14 record: images + one metadata manifest written with the v2 texts at an arweave.net image base
    const imageBaseUri = rec.imageBaseUri;
    return {
      kind: 'moon-forge-nft-arweave', version: 2, legacy: true, network: rec.network, uploadedAt: rec.uploadedAt, texts: 'v2',
      images: { manifest: rec.imagesManifest, files: Object.fromEntries(Object.entries(rec.images).map(([p, id]) => [p, { id }])) },
      sets: [{
        gateway: new URL(imageBaseUri).host, imageBaseUri, manifest: rec.metadataManifest, metadataBaseUri: rec.metadataBaseUri,
        files: Object.fromEntries(Object.entries(rec.metadata).map(([p, id]) => [p, { id }])),
      }],
    };
  }
  throw new Error('unknown record format');
}

export const localImage = (p) => fs.readFileSync(path.join(IMAGES_DIR, p));

// The bytes every path must have: images from nft-arweave/images, JSON regenerated from the texts module the record
// names (deterministic), so a later edit of the texts shows up as drift instead of passing silently.
export function expectedBytes(rec, set) {
  const imageBase = set.imageBaseUri.replace(/\/$/, '');
  const files = rec.texts === 'v2' ? buildV2({ imageBase, imageExt: 'webp' }) : buildFinal({ imageBase, imageExt: 'webp' });
  return {
    images: Object.fromEntries(IMAGE_PATHS.map((p) => [p, localImage(p)])),
    json: Object.fromEntries(JSON_PATHS.map((p) => [p, serialize(files[p])])),
  };
}

// ─── checks ────────────────────────────────────────────────────────────────
const fail = (list, item, why) => {
  list.push({ item, why });
  return 0;
};

async function checkManifest(gw, id, wantPaths, failures, label, opts) {
  const m = await rawManifest(gw, id, opts);
  if (!m.ok) return fail(failures, `manifest:${label}`, m.error);
  const got = Object.fromEntries(Object.entries(m.json.paths).map(([p, v]) => [p, v.id]));
  const want = Object.fromEntries(Object.entries(wantPaths).map(([p, v]) => [p, v.id]));
  const bad = [...new Set([...Object.keys(got), ...Object.keys(want)])].filter((p) => got[p] !== want[p]);
  if (bad.length) return fail(failures, `manifest:${label}`, `paths differ: ${bad.slice(0, 4).join(', ')}`);
  return 1;
}

async function checkPath(url, type, want, failures, item, opts) {
  const r = await fetchBytes(url, opts);
  if (r.status !== 200) return fail(failures, item, r.error ?? `HTTP ${r.status}`);
  if (!r.type.startsWith(type)) return fail(failures, item, `content-type ${r.type}`);
  if (sha256(r.buf) !== sha256(want)) return fail(failures, item, `sha256 ${sha256(r.buf).slice(0, 12)} != ${sha256(want).slice(0, 12)}`);
  return 1;
}

// 27 checks of one set on one gateway (13 with imagesOnly).
export async function checkSetOnGateway(rec, set, exp, gw, { imagesOnly = false, opts } = {}) {
  const failures = [];
  const A = rec.images.manifest;
  const jobs = [() => checkManifest(gw, A, rec.images.files, failures, 'images', opts)];
  for (const p of IMAGE_PATHS) jobs.push(() => checkPath(`https://${gw}/${A}/${p}`, 'image/webp', exp.images[p], failures, `images/${p}`, opts));
  if (!imagesOnly) {
    jobs.push(() => checkManifest(gw, set.manifest, set.files, failures, 'metadata', opts));
    for (const p of JSON_PATHS) jobs.push(() => checkPath(`https://${gw}/${set.manifest}/${p}`, 'application/json', exp.json[p], failures, `metadata/${p}`, opts));
  }
  progress(`gateway ${gw}: ${jobs.length} checks`);
  const ok = (await pool(jobs, 4, (j) => j())).reduce((a, b) => a + b, 0);
  return { ok, total: jobs.length, failures };
}

// The same items rebuilt from L1 chunks (no gateway involved).
export async function checkSetOnL1(rec, set, exp, { imagesOnly = false, opts } = {}) {
  const failures = [];
  const bundles = {};
  const items = [];
  for (const p of IMAGE_PATHS) items.push({ item: `images/${p}`, id: rec.images.files[p]?.id, want: exp.images[p] });
  items.push({ item: 'manifest:images', id: rec.images.manifest, paths: rec.images.files, wantSha: rec.images.manifestSha256 });
  if (!imagesOnly) {
    for (const p of JSON_PATHS) items.push({ item: `metadata/${p}`, id: set.files[p]?.id, want: exp.json[p] });
    items.push({ item: 'manifest:metadata', id: set.manifest, paths: set.files, wantSha: set.manifestSha256 });
  }
  progress(`Arweave L1: ${items.length} items`);
  const results = await pool(items, 4, async (it) => {
    if (!ID_RE.test(it.id ?? '')) return fail(failures, it.item, 'no id in the record');
    const r = await l1Payload(it.id, { opts });
    if (r.bundleId) bundles[r.bundleId] = { height: r.height ?? null, confirmations: r.confirmations ?? null };
    if (!r.ok) return fail(failures, it.item, r.reason);
    if (it.want && sha256(r.buf) !== sha256(it.want)) return fail(failures, it.item, 'L1 bytes differ from the repository');
    if (it.paths) {
      if (it.wantSha && sha256(r.buf) !== it.wantSha) return fail(failures, it.item, 'manifest bytes differ from the record');
      let m;
      try {
        m = JSON.parse(r.buf.toString('utf8'));
      } catch {
        return fail(failures, it.item, 'manifest is not JSON');
      }
      const bad = Object.entries(it.paths).filter(([p, v]) => m.paths?.[p]?.id !== v.id);
      if (bad.length || Object.keys(m.paths ?? {}).length !== Object.keys(it.paths).length) return fail(failures, it.item, 'manifest paths differ');
    }
    return 1;
  });
  return { ok: results.reduce((a, b) => a + b, 0), total: items.length, failures, bundles };
}

export async function runCheck(rec, { gateways = DEFAULT_GATEWAYS, only, l1 = true, imagesOnly = false, opts } = {}) {
  const now = new Date().toISOString();
  const report = { checkedAt: now, day: now.slice(0, 10), legacy: !!rec.legacy, sandbox: !!rec.sandbox, uploadedAt: rec.uploadedAt ?? null, gateways, l1, imagesOnly, sets: {} };
  const sets = rec.sets.filter((s) => !only || s.gateway === only);
  if (!sets.length) throw new Error(`no metadata set for gateway ${only}`);
  for (const set of sets) {
    progress(`set ${set.gateway}`);
    const exp = expectedBytes(rec, set);
    const drift = imagesOnly ? [] : JSON_PATHS.filter((p) => set.files[p]?.sha256 && set.files[p].sha256 !== sha256(exp.json[p]));
    for (const p of IMAGE_PATHS) if (rec.images.files[p]?.sha256 && rec.images.files[p].sha256 !== sha256(exp.images[p])) drift.push(`images/${p}`);
    // The checks below fetch https://<gateway>/<manifest>/...; the URIs in the record are what an operator copies
    // (metadataBaseUri into METADATA_BASE_URI, imageBaseUri inside every JSON), so they must be exactly those bases.
    const wantImages = `https://${set.gateway}/${rec.images.manifest}/`;
    const wantMetadata = `https://${set.gateway}/${set.manifest}/`;
    if (set.imageBaseUri !== wantImages) drift.push(`imageBaseUri ${set.imageBaseUri} is not the checked base ${wantImages}`);
    if (!imagesOnly && set.metadataBaseUri !== wantMetadata) drift.push(`metadataBaseUri ${set.metadataBaseUri} is not the checked base ${wantMetadata}`);
    const out = { metadataBaseUri: set.metadataBaseUri, imageBaseUri: set.imageBaseUri, drift, gateways: {} };
    for (const gw of gateways) out.gateways[gw] = await checkSetOnGateway(rec, set, exp, gw, { imagesOnly, opts });
    if (l1) out.l1 = await checkSetOnL1(rec, set, exp, { imagesOnly, opts });
    out.pass = !drift.length && Object.values(out.gateways).every((g) => g.ok === g.total) && (!l1 || out.l1.ok === out.l1.total);
    report.sets[set.gateway] = out;
  }
  return report;
}

export function printReport(report) {
  console.log(`check ${report.checkedAt}${report.legacy ? ' (void 2026-10-14 record, v2 texts)' : ''}${report.imagesOnly ? ' (images only)' : ''}`);
  for (const [name, s] of Object.entries(report.sets)) {
    console.log(`set "${name}"  metadata ${s.metadataBaseUri}`);
    if (s.drift.length) console.log(`  DRIFT: the record does not match the repository bytes or the checked bases: ${s.drift.join('; ')}`);
    const rows = [...Object.entries(s.gateways), ...(s.l1 ? [['Arweave L1', s.l1]] : [])];
    for (const [gw, g] of rows) {
      console.log(`  ${gw.padEnd(20)} ${String(g.ok).padStart(2)}/${g.total}`);
      for (const f of g.failures.slice(0, 6)) console.log(`      ${f.item}: ${f.why}`);
      if (g.failures.length > 6) console.log(`      ... ${g.failures.length - 6} more`);
    }
    if (s.l1) for (const [b, v] of Object.entries(s.l1.bundles)) console.log(`  bundle ${b}: height ${v.height ?? '?'}, confirmations ${v.confirmations ?? '?'}`);
    console.log(`  => ${s.pass ? 'PASS' : 'FAIL'}`);
  }
}

// ─── 7-day verdict ─────────────────────────────────────────────────────────
export function readReports(src) {
  if (fs.statSync(src).isDirectory()) {
    return fs.readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(src, f), 'utf8')));
  }
  return fs.readFileSync(src, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// A full report: the whole gate (Arweave L1 and every default gateway), not images-only, not the void legacy record,
// not the sandbox. Any other report is ignored by the verdict: it neither passes nor fails a day.
export const isFullReport = (r, gateways = DEFAULT_GATEWAYS) =>
  !r.imagesOnly && !r.legacy && !r.sandbox && r.l1 === true && gateways.every((g) => (r.gateways ?? []).includes(g));

// Per (set, metadataBaseUri), because the URI is what gets compiled: a re-upload under the same set name starts a
// new streak. A UTC day passes when it has at least one full report and every full report passed. The streak is the
// run of consecutive passing days ending at the LATEST day of any full report in the log, so a URI that is no longer
// checked (an older record) has no streak. Returns { '<set> <uri>': { set, metadataBaseUri, streak, from, lastDay,
// latestDay, ready } }.
export function verdict(reports, days = 7, { gateways = DEFAULT_GATEWAYS } = {}) {
  const full = reports.filter((r) => isFullReport(r, gateways));
  const latestDay = full.map((r) => r.day).sort().at(-1);
  const perUri = {};
  for (const r of full) {
    for (const [name, s] of Object.entries(r.sets ?? {})) {
      const key = `${name} ${s.metadataBaseUri}`;
      const u = (perUri[key] ??= { set: name, metadataBaseUri: s.metadataBaseUri ?? null, days: {} });
      u.days[r.day] = (u.days[r.day] ?? true) && !!s.pass;
    }
  }
  const out = {};
  for (const [key, u] of Object.entries(perUri)) {
    let streak = 0;
    let cursor = new Date(`${latestDay}T00:00:00Z`);
    while (u.days[cursor.toISOString().slice(0, 10)] === true) {
      streak++;
      cursor = new Date(cursor.getTime() - 86_400_000);
    }
    const from = streak ? new Date(cursor.getTime() + 86_400_000).toISOString().slice(0, 10) : null;
    const lastDay = Object.keys(u.days).sort().at(-1);
    out[key] = { set: u.set, metadataBaseUri: u.metadataBaseUri, streak, from, lastDay, latestDay, ready: streak >= days };
  }
  return out;
}

// ─── CLI ───────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
  verbose = args.includes('--verbose');
  if (args.includes('--verdict')) {
    const days = Number(opt('--days', '7'));
    const v = verdict(readReports(opt('--verdict')), days);
    if (!Object.keys(v).length) console.log('no full reports in the log (a full report has Arweave L1 and every default gateway)');
    for (const s of Object.values(v)) {
      const span = s.streak ? ` from ${s.from} to ${s.latestDay}` : ` (last checked ${s.lastDay}, latest day in the log ${s.latestDay})`;
      console.log(`set "${s.set}"  METADATA_BASE_URI ${s.metadataBaseUri}: ${s.streak} consecutive passing UTC day(s)${span}: ${s.ready ? `READY (>= ${days})` : `not ready (needs ${days})`}`);
    }
    process.exit(Object.values(v).some((s) => s.ready) ? 0 : 1);
  }
  const recordPath = opt('--record', DEFAULT_RECORD);
  if (!fs.existsSync(recordPath)) {
    console.log(`no record at ${path.relative(root, recordPath).split(path.sep).join('/')}: nothing to check yet`);
    process.exit(args.includes('--require-record') ? 1 : 0);
  }
  const rec = normalizeRecord(JSON.parse(fs.readFileSync(recordPath, 'utf8')));
  const report = await runCheck(rec, {
    gateways: opt('--gateways', DEFAULT_GATEWAYS.join(',')).split(',').filter(Boolean),
    only: opt('--set'),
    l1: !args.includes('--no-l1'),
    imagesOnly: args.includes('--images-only'),
    opts: { attempts: Number(opt('--attempts', '3')) },
  });
  report.record = path.relative(root, recordPath).split(path.sep).join('/');
  printReport(report);
  if (opt('--json')) fs.writeFileSync(opt('--json'), JSON.stringify(report, null, 2));
  if (opt('--log')) fs.appendFileSync(opt('--log'), JSON.stringify(report) + '\n');
  const passes = Object.values(report.sets).map((s) => s.pass);
  process.exit((args.includes('--strict') ? passes.every(Boolean) : passes.some(Boolean)) ? 0 : 1);
}
