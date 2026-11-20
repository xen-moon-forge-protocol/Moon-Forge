// Writes the Arweave mirrors of deployments/mirrors.json into every surface that lists them: public/links.json
// (`mirrors`, `mirrorsNote`; llms.txt and llms-full.txt are generated from it by the frontend prerender), both agent
// cards, README.md and docs/HOW-IT-WORKS.md (the marker block). Idempotent.
//
// Usage: node scripts/mirror/sync-crosslinks.mjs           write
//        node scripts/mirror/sync-crosslinks.mjs --check   exit 1 when a surface is out of date (writes nothing)
// After a write that changed links.json, run `cd frontend && node scripts/prerender.mjs --write-public`.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { agentCardWithMirrors, emptyRecord, linksMirrors, linksMirrorsNote, markdownBlock, replaceBlock, serializeCard, validateRecord } from './lib.mjs';

export const SURFACES = {
  links: 'frontend/public/links.json',
  cards: ['frontend/public/agent-card.json', 'frontend/public/.well-known/agent-card.json'],
  markdown: ['README.md', 'docs/HOW-IT-WORKS.md'],
};

/** links.json keeps its hand formatting: only the two mirror lines are rewritten. */
export function syncLinks(text, rec) {
  const list = linksMirrors(rec);
  const note = linksMirrorsNote(rec);
  if (!/^ {2}"mirrors": .*$/m.test(text) || !/^ {2}"mirrorsNote": .*$/m.test(text)) throw new Error('links.json: no "mirrors" / "mirrorsNote" line');
  const out = text
    .replace(/^ {2}"mirrorsNote": .*$/m, () => `  "mirrorsNote": ${JSON.stringify(note)},`)
    .replace(/^ {2}"mirrors": .*$/m, () => `  "mirrors": ${JSON.stringify(list)},`);
  JSON.parse(out); // still valid JSON
  return out;
}

/** Returns { file: newText } for every surface whose text changes. */
export function plan(root, rec) {
  const changes = {};
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const links = read(SURFACES.links);
  const nextLinks = syncLinks(links, rec);
  if (nextLinks !== links) changes[SURFACES.links] = nextLinks;
  for (const p of SURFACES.cards) {
    const text = read(p);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const next = serializeCard(agentCardWithMirrors(JSON.parse(text), rec)).replace(/\n/g, eol);
    if (next !== text) changes[p] = next;
  }
  for (const p of SURFACES.markdown) {
    const text = read(p);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const next = replaceBlock(text.replace(/\r\n/g, '\n'), markdownBlock(rec)).replace(/\n/g, eol);
    if (next !== text) changes[p] = next;
  }
  return changes;
}

export function loadRecord(root) {
  const file = path.join(root, 'deployments/mirrors.json');
  return validateRecord(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : emptyRecord());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const changes = plan(root, loadRecord(root));
  const files = Object.keys(changes);
  if (process.argv.includes('--check')) {
    for (const f of files) console.error(`sync-crosslinks --check: ${f} does not list the mirrors of deployments/mirrors.json (run node scripts/mirror/sync-crosslinks.mjs)`);
    if (!files.length) console.log('sync-crosslinks --check: every surface lists the mirrors of deployments/mirrors.json');
    process.exit(files.length ? 1 : 0);
  }
  for (const f of files) fs.writeFileSync(path.join(root, f), changes[f]);
  console.log(files.length ? `updated ${files.join(', ')}${changes[SURFACES.links] ? '; now run: cd frontend && node scripts/prerender.mjs --write-public' : ''}` : 'every surface already lists the mirrors');
}
