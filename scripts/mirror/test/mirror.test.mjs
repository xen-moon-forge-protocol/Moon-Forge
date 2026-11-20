// Offline tests of the Arweave mirror: link rewriting, the read-only page, the plan, the path manifest, the record and
// the cross-links. Run: node --test scripts/mirror/test/mirror.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  MAX_FREE, MARK_END, MARK_START, agentCardWithMirrors, appendMirror, buildManifest, contentType, depthOf, emptyRecord,
  linksMirrors, linksMirrorsNote, markdownBlock, mirrorNotice, mirrorUrls, planEntries, relativize, replaceBlock,
  serializeCard, sha256, stripApp, validateRecord, withRuntimeBase,
} from '../lib.mjs';
import { SURFACES, loadRecord, plan, syncLinks } from '../sync-crosslinks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const id = (c) => c.repeat(43).slice(0, 43);
const A = id('A'); const B = id('B'); const C = id('C'); const M = id('m');
const COMMIT = 'a'.repeat(40);

const page = `<!DOCTYPE html><html><head>
    <script>globalThis.__MF_BASE__=(location.pathname.match(/^\\/[A-Za-z0-9_-]{43}\\//)||['/'])[0];</script>
    <link rel="icon" href="./moon-icon.svg" />
    <link rel="canonical" href="https://xen-moon-forge-protocol.github.io/Moon-Forge/forge/" />
    <script type="module" crossorigin src="./assets/index-x.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/facts-y.js">
    <link rel="stylesheet" crossorigin href="./assets/index-z.css">
  </head><body><div id="root"><nav><a href="/Moon-Forge/">Home</a> <a href="/Moon-Forge/faq/">FAQ</a></nav></div></body></html>`;

test('relativize: root and ./ links become relative to the page; absolute links stay', () => {
  const top = relativize(page, 0);
  assert.match(top, /href="\.\/faq\/"/);
  assert.match(top, /src="\.\/assets\/index-x\.js"/);
  const deep = relativize(page, 1);
  assert.match(deep, /href="\.\.\/faq\/"/);
  assert.match(deep, /href="\.\.\/"/);
  assert.match(deep, /src="\.\.\/assets\/index-x\.js"/);
  assert.match(deep, /href="\.\.\/assets\/index-z\.css"/);
  assert.match(deep, /href="https:\/\/xen-moon-forge-protocol\.github\.io\/Moon-Forge\/forge\/"/);
  assert.ok(!deep.includes('"/Moon-Forge/'));
  assert.equal(relativize(page, 2).includes('src="../../assets/index-x.js"'), true);
  assert.equal(depthOf('index.html'), 0);
  assert.equal(depthOf('forge/index.html'), 1);
});

test('stripApp: a read-only page keeps its text and CSS, loses the app scripts, gains the notice', () => {
  const notice = mirrorNotice({ commit: COMMIT, date: '2026-11-20', full: false });
  const out = stripApp(relativize(page, 1), notice);
  assert.ok(!/type="module"/.test(out));
  assert.ok(!/modulepreload/.test(out));
  assert.ok(!out.includes('__MF_BASE__'));
  assert.match(out, /index-z\.css/);
  assert.match(out, /<a href="\.\.\/faq\/">FAQ<\/a>/);
  assert.match(out, /data-mirror-notice/);
  assert.ok(notice.includes('57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9'));
  assert.ok(notice.includes('aaaaaaaaaaaa'));
  assert.ok(notice.includes('read-only'));
  assert.ok(!mirrorNotice({ commit: COMMIT, date: 'd', full: true }).includes('read-only'));
  assert.throws(() => stripApp('<html><head></head></html>', 'x'), /no <body>/);
});

test('withRuntimeBase: the fallback page computes its <base> from the address', () => {
  const out = withRuntimeBase('<html><head><title>x</title></head><body></body></html>');
  assert.match(out, /<head>\n {4}<script>document\.write\('<base href="'\+/);
  assert.match(out, /\{43\}/);
});

test('contentType: source files are plain text, site files by extension', () => {
  assert.equal(contentType('index.html'), 'text/html; charset=utf-8');
  assert.equal(contentType('llms.txt'), 'text/plain; charset=utf-8');
  assert.equal(contentType('.well-known/agent-card.json'), 'application/json');
  assert.equal(contentType('fonts/orbitron-latin.woff2'), 'font/woff2');
  assert.equal(contentType('source/programs/moon-forge/src/lib.rs'), 'text/plain; charset=utf-8');
  assert.equal(contentType('source/frontend/index.html'), 'text/plain; charset=utf-8');
  assert.equal(contentType('source/LICENSE'), 'text/plain; charset=utf-8');
  assert.equal(contentType('source/x/a.png'), 'image/png');
  assert.equal(contentType('source/moon-forge-program-2026-11-25.bundle'), 'application/octet-stream');
});

test('planEntries: free tier, epoch exclusion, unsafe paths, deduplication', () => {
  const e = (p, bytes, s = p) => ({ path: p, bytes, sha256: sha256(s) });
  const entries = [
    e('index.html', 9000), e('llms.txt', 45000, 'same'), e('source/frontend/public/llms.txt', 45000, 'same'),
    e('assets/index.js', 1_164_329), e('epochs/epoch-1.json', 5000), e('source/frontend/public/epochs/index.json', 400),
    e('feed/week-so-far.json', 100), e('source/a b.txt', 10), e('source/../x', 10), e('MIRROR-small.json', MAX_FREE),
  ];
  const p = planEntries(entries);
  assert.deepEqual(p.uploads.map((f) => f.path).sort(), ['MIRROR-small.json', 'index.html', 'llms.txt']);
  assert.deepEqual(p.aliases, [{ path: 'source/frontend/public/llms.txt', sameAs: 'llms.txt' }]);
  const why = Object.fromEntries(p.skipped.map((s) => [s.path, s.reason]));
  assert.match(why['assets/index.js'], /free tier/);
  assert.match(why['epochs/epoch-1.json'], /2026-10-25/);
  assert.match(why['source/frontend/public/epochs/index.json'], /2026-10-25/);
  assert.match(why['feed/week-so-far.json'], /2026-10-25/);
  assert.match(why['source/a b.txt'], /not safe/);
  assert.match(why['source/../x'], /not safe/);
  assert.equal(p.paidBytes, 0);
  const paid = planEntries(entries, { allowPaid: true, includeEpochs: true });
  assert.ok(paid.uploads.some((f) => f.path === 'assets/index.js'));
  assert.ok(paid.uploads.some((f) => f.path === 'epochs/epoch-1.json'));
  assert.equal(paid.paidBytes, 1_164_329);
  assert.throws(() => planEntries([e('a', 1), e('a', 2)]), /duplicate/);
});

test('buildManifest: index, fallback, route aliases and shortcuts', () => {
  const m = buildManifest({
    'index.html': A, '404.html': B, 'forge/index.html': C, 'llms.txt': A, 'source/docs/HOW-IT-WORKS.md': B, '.well-known/agent-card.json': C,
  });
  assert.equal(m.manifest, 'arweave/paths');
  assert.equal(m.version, '0.2.0');
  assert.deepEqual(m.index, { path: 'index.html' });
  assert.deepEqual(m.fallback, { id: B });
  assert.deepEqual(m.paths['forge/'], { id: C });
  assert.deepEqual(m.paths['forge/index.html'], { id: C });
  assert.equal(m.paths.forge, undefined, 'no alias without the slash: relative links would resolve one level up');
  assert.deepEqual(m.paths['how-it-works'], { id: B });
  assert.deepEqual(m.paths['how-it-works.md'], { id: B });
  assert.deepEqual(m.paths['.well-known/agent-card.json'], { id: C });
  assert.equal(m.paths['README.md'], undefined, 'a shortcut only when its target is in the manifest');
  assert.deepEqual(Object.keys(m.paths), [...Object.keys(m.paths)].sort(), 'deterministic order');
  assert.throws(() => buildManifest({ 'index.html': 'short' }), /valid id/);
  assert.throws(() => buildManifest({ 'llms.txt': A }), /index/);
  assert.equal(buildManifest({ 'index.html': A }).fallback, undefined);
});

const entry = (manifest, extra = {}) => ({
  manifest, manifestSha256: 'f'.repeat(64), commit: COMMIT, uploadedAt: '2026-11-21T10:00:00.000Z',
  uploadedBy: 'test', owner: null, stableOwner: false, app: 'x', files: 1, bytes: 1, leftOut: 0,
  mirrorJson: { id: A, sha256: 'e'.repeat(64) }, bundle: null, ...extra,
});

test('record: validation and append', () => {
  const r0 = validateRecord(emptyRecord());
  assert.deepEqual(r0.mirrors, []);
  const r1 = appendMirror(r0, entry(M));
  assert.equal(r1.mirrors.length, 1);
  assert.equal(r0.mirrors.length, 0, 'append does not mutate');
  assert.throws(() => appendMirror(r1, entry(M)), /twice/);
  assert.throws(() => appendMirror(r0, entry('bad')), /manifest id/);
  assert.throws(() => appendMirror(r0, entry(M, { commit: 'abc' })), /40 hex/);
  assert.throws(() => appendMirror(r0, entry(M, { bundle: { id: A } })), /bundle/);
  assert.throws(() => validateRecord({ ...r0, gateways: ['one.com'] }), /two gateways/);
  const r2 = appendMirror(r1, entry(B, { bundle: { id: C, sha256: 'd'.repeat(64), ref: 'program-2026-11-25' } }));
  assert.deepEqual(mirrorUrls(B, r2.gateways), [`https://turbo-gateway.com/${B}/`, `https://ar-io.dev/${B}/`]);
  const l = linksMirrors(r2);
  assert.equal(l[0].manifest, B, 'newest first');
  assert.equal(l[0].bundle.url, `https://turbo-gateway.com/${C}`);
  assert.equal(l[1].bundle, undefined);
});

test('cross-links: empty record changes nothing visible; a mirror reaches every surface', () => {
  const r0 = emptyRecord();
  assert.equal(markdownBlock(r0), `${MARK_START}\n${MARK_END}`);
  assert.match(linksMirrorsNote(r0), /No copy on Arweave yet/);
  const r1 = appendMirror(r0, entry(M));
  const md = markdownBlock(r1);
  for (const u of mirrorUrls(M, r1.gateways)) assert.ok(md.includes(u));
  assert.match(md, /If the site or this repository is down/);
  assert.equal(replaceBlock(`a\n${MARK_START}\n${MARK_END}\nb`, md), `a\n${md}\nb`);
  assert.throws(() => replaceBlock('no markers', md), /marker/);
  const card = { name: 'x', services: [{ name: 'web', endpoint: 'w' }, { name: 'source', endpoint: 's' }, { name: 'x1-program', endpoint: 'p' }] };
  const c1 = agentCardWithMirrors(card, r1);
  assert.deepEqual(c1.services.map((s) => s.name), ['web', 'source', 'arweave-mirror', 'arweave-mirror-2', 'x1-program']);
  assert.deepEqual(agentCardWithMirrors(c1, r1), c1, 'idempotent');
  assert.deepEqual(agentCardWithMirrors(c1, r0).services, card.services);
  const links = '{\n  "a": 1,\n  "mirrorsNote": "x",\n  "mirrors": [],\n  "signature": null\n}\n';
  const l1 = syncLinks(links, r1);
  assert.equal(JSON.parse(l1).mirrors[0].manifest, M);
  assert.match(JSON.parse(l1).mirrorsNote, /newest first/);
  assert.equal(syncLinks(l1, r1), l1);
});

test('the repository: every surface matches deployments/mirrors.json, and the agent cards keep their exact text', () => {
  const rec = loadRecord(root);
  assert.deepEqual(plan(root, rec), {}, 'run node scripts/mirror/sync-crosslinks.mjs');
  for (const p of SURFACES.cards) {
    const text = fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(serializeCard(JSON.parse(text)), text, `${p}: serializeCard must reproduce the file`);
  }
  for (const p of SURFACES.markdown) {
    const text = fs.readFileSync(path.join(root, p), 'utf8');
    assert.ok(text.includes(MARK_START) && text.includes(MARK_END), `${p}: marker block`);
  }
  const links = JSON.parse(fs.readFileSync(path.join(root, SURFACES.links), 'utf8'));
  assert.deepEqual(links.mirrors, linksMirrors(rec));
});

test('the workflow uploads nothing without the confirmation and uses no secret', () => {
  const wf = fs.readFileSync(path.join(root, '.github/workflows/mirror-arweave.yml'), 'utf8');
  assert.ok(!/secrets\./.test(wf), 'no secret');
  assert.match(wf, /confirm != 'PERMANENT'/);
  assert.match(wf, /permissions:\n {2}contents: read/);
  assert.ok(!/--allow-paid/.test(wf), 'the workflow never pays');
});
