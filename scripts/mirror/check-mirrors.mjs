// Serve check of the mirrors in deployments/mirrors.json: on every gateway, each copy's MIRROR.json and the key
// texts (index.html, llms.txt, llms-full.txt, the agent card, the plain guide) answer with the sha256 the inventory
// gives. Read-only: nothing signs or pays.
//
// Usage: node scripts/mirror/check-mirrors.mjs [--json <file>]    (exit 1 when the newest copy fails on every gateway)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchBytes } from '../nft-metadata/arweave.mjs';
import { sha256, validateRecord, emptyRecord } from './lib.mjs';

export const KEY_PATHS = ['index.html', 'llms.txt', 'llms-full.txt', '.well-known/agent-card.json', 'links.json', 'source/docs/HOW-IT-WORKS.md'];

/** inventory: the copy's MIRROR.json (from the run, or fetched). Returns { ok, total, failures }. */
export async function checkMirror(manifest, gateway, inventory, opts = { attempts: 2, backoffMs: [0, 15_000] }) {
  const failures = [];
  let ok = 0;
  for (const p of KEY_PATHS) {
    const meta = inventory.files[p];
    const want = meta?.sha256 ?? inventory.files[meta?.sameAs]?.sha256;
    const r = await fetchBytes(`https://${gateway}/${manifest}/${p}`, opts);
    if (r.status !== 200) failures.push({ item: p, why: r.error ?? `HTTP ${r.status}` });
    else if (want && sha256(r.buf) !== want) failures.push({ item: p, why: 'sha256 differs' });
    else ok++;
  }
  return { ok, total: KEY_PATHS.length, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const file = path.join(root, 'deployments/mirrors.json');
  const rec = validateRecord(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : emptyRecord());
  if (!rec.mirrors.length) { console.log('no mirror recorded yet: nothing to check'); process.exit(0); }
  const report = [];
  for (const m of rec.mirrors) {
    let inventory = null;
    for (const g of rec.gateways) {
      const r = await fetchBytes(`https://${g}/${m.manifest}/MIRROR.json`, { attempts: 2, backoffMs: [0, 15_000] });
      if (r.status === 200 && sha256(r.buf) === m.mirrorJson?.sha256) { inventory = JSON.parse(r.buf.toString('utf8')); break; }
    }
    for (const g of rec.gateways) {
      const r = inventory ? await checkMirror(m.manifest, g, inventory) : { ok: 0, total: 1, failures: [{ item: 'MIRROR.json', why: 'not served with its recorded sha256 on any gateway' }] };
      report.push({ manifest: m.manifest, commit: m.commit, gateway: g, ...r });
      console.log(`${m.manifest} (${m.uploadedAt.slice(0, 10)}) ${g.padEnd(20)} ${r.ok}/${r.total}${r.failures.length ? '  e.g. ' + r.failures[0].item + ': ' + r.failures[0].why : ''}`);
    }
  }
  const jsonAt = process.argv.indexOf('--json');
  if (jsonAt > 0) fs.writeFileSync(process.argv[jsonAt + 1], JSON.stringify(report, null, 2));
  const newest = rec.mirrors[rec.mirrors.length - 1].manifest;
  process.exit(report.some((r) => r.manifest === newest && r.ok === r.total) ? 0 : 1);
}
