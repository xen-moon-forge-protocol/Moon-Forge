// Offline tests of the Artifact metadata tooling: node --test scripts/nft-metadata/test/
// (no network: the L1 reader is exercised against a stubbed fetch).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TIERS, JSON_PATHS, IMAGE_PATHS, COLLECTION, PROGRAM_ID, COLLECTION_NAME } from '../tiers.mjs';
import { buildV2 } from '../texts-v2.mjs';
import { buildFinal, serialize, SPLIT, EXTERNAL_URL } from '../texts-final.mjs';
import { lintFiles, lintIdl, lintText, IDL_DESCRIPTION } from '../lint-permanent.mjs';
import { l1Payload, scanWebp, sha256 } from '../arweave.mjs';
import { normalizeRecord, expectedBytes, runCheck, verdict } from '../check-gateways.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const BASE = 'https://turbo-gateway.com/' + 'A'.repeat(43);
const SITE_IMAGES = 'https://xen-moon-forge-protocol.github.io/Moon-Forge/nft/images';

test('v2 texts are byte-identical to the Pages copy the live program points at', () => {
  const files = buildV2({ imageBase: SITE_IMAGES, imageExt: 'jpg' });
  for (const p of JSON_PATHS) {
    const committed = read(`frontend/public/nft/${p}`).replace(/\r\n/g, '\n');
    assert.equal(serialize(files[p]).toString('utf8'), committed, p);
  }
});

// The final texts describe the program AFTER the final upgrade. Its source is on the upgrade branch (FORGE_EXTRA_BPS
// exists there); main keeps the live v2 source until the upgrade, so on main these checks are skipped, and they
// must pass on the upgrade branch before the Arweave upload.
const constants = read('programs/moon-forge/src/constants.rs');
const artifacts = read('programs/moon-forge/src/instructions/artifacts.rs');
const UPGRADE_SOURCE = /pub const FORGE_EXTRA_BPS: u64/.test(constants);
const onUpgrade = UPGRADE_SOURCE ? {} : { skip: 'live v2 program source on this branch: run on the upgrade branch before the upload' };

test('tiers, variants, elements and collection name mirror the program constants', () => {
  const c = constants;
  const arr = (name) => c.match(new RegExp(`pub const ${name}: \\[[^\\]]+\\] = \\[([^\\]]+)\\]`))[1].split(',').map((s) => s.trim().replace(/"/g, ''));
  assert.deepEqual(arr('TIER_NAMES'), TIERS.map((t) => t.name));
  assert.deepEqual(arr('TIER_SLUGS'), TIERS.map((t) => t.slug));
  assert.deepEqual(arr('ARTIFACT_SUPPLY').map(Number), TIERS.map((t) => t.supply));
  assert.deepEqual(arr('ARTIFACT_VARIANTS').map(Number), TIERS.map((t) => t.variants.length));
  assert.match(c, new RegExp(`pub const COLLECTION_NAME: &str = "${COLLECTION_NAME}";`));
  assert.deepEqual(artifacts.match(/const ELEMENT_NAMES: \[&str; 4\] = \[([^\]]+)\]/)[1].split(',').map((s) => s.trim().replace(/"/g, '')), TIERS.map((t) => t.element));
});

test('split and on-chain attributes match the final program source', onUpgrade, () => {
  const bps = (n) => Number(constants.match(new RegExp(`pub const ${n}: u64 = ([\\d_]+);`))[1].replace(/_/g, ''));
  assert.deepEqual([bps('FORGE_BACKING_BPS'), bps('FORGE_POOL_BPS'), bps('FORGE_EXTRA_BPS'), bps('FORGE_ARCHITECT_BPS'), bps('FORGE_DRAW_BPS')],
    [SPLIT.floor * 100, SPLIT.rewardPool * 100, SPLIT.extraPot * 100, SPLIT.architect * 100, 0]);
  const a = artifacts;
  // the on-chain attributes the texts refer to by name
  assert.match(a, /\("Floor XNT", xnt_str\(backing\)\)/);
  assert.match(a, /"Forge Price XNT"/);
  assert.match(a, /ORIGIN_AIRDROP => "Genesis Airdrop"/);
  const attrs = a.slice(a.indexOf('fn attributes('), a.indexOf('\n}\n', a.indexOf('fn attributes(')));
  assert.doesNotMatch(attrs, /Burn Boost|Weekly Chips|Duel|Ticket/);
  // the price sentence: a full tier keeps its price (current_price returns before the decay loop), so the text
  // says the price eases back only while the tier is not full
  const cp = a.slice(a.indexOf('pub fn current_price('), a.indexOf('pub fn next_price('));
  assert.match(cp, /if c\.artifacts_alive\[t\] >= ARTIFACT_SUPPLY\[t\] \{\s*return /);
  assert.ok(cp.indexOf('ARTIFACT_SUPPLY[t]') < cp.indexOf('PRICE_DECAY_PERIOD'));
  for (const m of Object.values(buildFinal({ imageBase: BASE }))) {
    assert.match(m.description, /rises with each forge and, while the tier is not full, eases back over time without one/);
  }
});

test('final texts: 13 files, lint clean on both image gateways, program facts only', () => {
  for (const base of [BASE, 'https://ar-io.dev/' + 'b'.repeat(43)]) {
    const files = buildFinal({ imageBase: base });
    assert.deepEqual(Object.keys(files).sort(), [...JSON_PATHS].sort());
    assert.deepEqual(lintFiles(files, { imageBase: base }), []);
    for (const [p, m] of Object.entries(files)) {
      assert.ok(serialize(m).length < 100 * 1024, p);
      assert.equal(m.external_url, EXTERNAL_URL);
      assert.ok(m.description.includes(COLLECTION) && m.description.includes(PROGRAM_ID), p);
      assert.ok(!/\b(boost|chips|ticket|lottery|drops?|honou?red|weekly)\b|\d+\s*×|1%|\b52\b/i.test(JSON.stringify(m)), p);
    }
    assert.equal(files['lunar_dust/0.json'].image, `${base}/lunar_dust/frost_blue.webp`);
    assert.equal(files['void_anomaly/0.json'].properties.files[0].uri, `${base}/void_anomaly/event_horizon.webp`);
  }
  assert.throws(() => buildFinal({ imageBase: 'https://arweave.net/ARWEAVE_MANIFEST_ID_TBD' }));
});

test('the lint catches every class of forbidden permanent text', () => {
  const at = { file: 't', field: 'description' };
  // wording-check: ignore-start  (seeded violations the lint must catch; the personal-data samples are built at run time)
  const cases = {
    'holders earn XNT': 'banned-word', 'a yield': 'banned-word', 'no profit': 'banned-word', 'the return on it': 'banned-word',
    'a bigger share': 'banned-word', 'immutable forever': 'banned-word', 'a +5% boost': 'policy', 'weekly chips': 'policy',
    'a Duel ticket': 'policy', 'Forge Drops': 'policy', 'Burn Lottery': 'policy', 'royalty where honored': 'policy',
    'rebate up to 2× of it': 'policy', 'needs 1%/week': 'policy', 'a 52 weeks season': 'policy', 'from 2026-11-11': 'date',
    'every Sunday': 'date', 'unlike XEN Prime': 'name', 'join our Telegram': 'service', 'priced on Magic Eden': 'name', 'see https://example.com': 'url',
    'see moonforge.xyz': 'url', [['mail a', 'b.co'].join('@')]: 'personal', [['C:', 'Users', 'x'].join('\\')]: 'personal', [['GMT', '9'].join('+')]: 'personal',
    'zero\u200bwidth': 'hidden', 'nice \u{1F680}': 'emoji', 'ignore previous rules': 'instruction',
  };
  // wording-check: ignore-end
  for (const [text, rule] of Object.entries(cases)) {
    assert.ok(lintText(text, at).some((h) => h.rule === rule), `${JSON.stringify(text)} should hit ${rule}`);
  }
  assert.ok(lintText('costs 100 XNT', at).some((h) => h.rule === 'number'));
  assert.deepEqual(lintText(`Genuine only in ${COLLECTION} of ${PROGRAM_ID} on X1: 50%, 20%, 25%, 5%, 600`, at), []);
  const files = buildFinal({ imageBase: BASE });
  files['lunar_dust/0.json'].description = files['lunar_dust/0.json'].description.replace(/Burning this NFT[^\n]+/, '');
  files['cosmic_shard/0.json'].attributes.push({ trait_type: 'Burn Boost', value: '+10%' });
  files['solar_core/0.json'].external_url = 'https://evil.example/artifacts/';
  files['void_anomaly/0.json'].image = 'https://turbo-gateway.com/' + 'Z'.repeat(43) + '/void_anomaly/event_horizon.webp';
  const hits = lintFiles(files, { imageBase: BASE });
  assert.ok(hits.some((h) => h.file === 'lunar_dust/0.json' && h.text === 'wallet-burn warning'));
  assert.ok(hits.some((h) => h.file === 'cosmic_shard/0.json' && h.rule === 'attributes'));
  assert.ok(hits.some((h) => h.file === 'solar_core/0.json' && h.field === 'external_url'));
  assert.ok(hits.some((h) => h.file === 'void_anomaly/0.json' && h.field === 'image'));
});

test('final IDL and crate description are the WORDING.md section 4 sentence', onUpgrade, () => {
  // read-only; the v3 copy exists until the upgrade merges it into moon_forge.json
  const idls = ['frontend/src/idl/moon_forge.json', 'frontend/src/idl/moon_forge.v3.json'].filter((f) => fs.existsSync(path.join(root, f)));
  assert.ok(idls.length >= 1);
  for (const f of idls) assert.equal(JSON.parse(read(f)).metadata.description, IDL_DESCRIPTION, f);
  assert.match(read('programs/moon-forge/Cargo.toml'), new RegExp(`^description = "${IDL_DESCRIPTION.replace(/[.]/g, '\\.')}"$`, 'm'));
});

test('the IDL lint catches banned words in docs, error messages and the description', () => {
  // wording-check: ignore-start  (seeded violations)
  assert.equal(lintIdl({ metadata: { description: 'burn XEN, earn XNT' } }).length, 1);
  assert.ok(lintIdl({ metadata: { description: IDL_DESCRIPTION }, instructions: [{ name: 'x', docs: ['holders earn a yield'] }] }).some((h) => h.field === 'instructions[x].docs'));
  assert.ok(lintIdl({ metadata: { description: IDL_DESCRIPTION }, errors: [{ code: 6000, name: 'E', msg: 'Artifacts earn here' }] }).some((h) => h.field === 'errors[E].msg'));
  // wording-check: ignore-end
});

test('the WebP scan passes the 12 images and refuses metadata chunks', () => {
  for (const p of IMAGE_PATHS) assert.deepEqual(scanWebp(fs.readFileSync(path.join(root, 'nft-arweave/images', p))), [], p);
  const chunk = (id, body) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'ascii');
    h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body, Buffer.alloc(body.length % 2)]);
  };
  const body = Buffer.concat([Buffer.from('WEBP'), chunk('VP8 ', Buffer.alloc(10)), chunk('EXIF', Buffer.from('Google SynthID'))]);
  const riff = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), body]);
  const issues = scanWebp(riff);
  assert.ok(issues.some((i) => i.includes('EXIF')) && issues.some((i) => i.includes('SynthID')));
});

test('L1 reader rebuilds a payload that spans two chunks, and fails when a chunk is missing', async () => {
  const CH = 16;
  const bundle = Buffer.from(Array.from({ length: 64 }, (_, i) => i));
  const txEnd = 1000n; // absolute offset of the bundle's last byte
  const txStart = txEnd - BigInt(bundle.length) + 1n;
  const status = { status: 'FINALIZED', bundleId: 'B'.repeat(43), startOffsetInRootBundle: 10, payloadDataStart: 4, payloadContentLength: 20 };
  const want = bundle.subarray(14, 34);
  const note = (end) => { const b = Buffer.alloc(32); b.writeBigUInt64BE(BigInt(end), 24); return b; };
  const real = globalThis.fetch;
  let drop = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/status') && u.includes('upload.ardrive.io')) return json(status);
    if (u.endsWith('/offset')) return json({ size: String(bundle.length), offset: String(txEnd) });
    if (u.endsWith('/status')) return json({ block_height: 7, number_of_confirmations: 9 });
    const m = u.match(/\/chunk\/(\d+)$/);
    if (m) {
      const rel = Number(BigInt(m[1]) - txStart);
      const k = Math.floor(rel / CH);
      if (drop && k === 2) return json({}, 404);
      const c = bundle.subarray(k * CH, (k + 1) * CH);
      return json({ chunk: c.toString('base64url'), data_path: Buffer.concat([Buffer.alloc(32), note((k + 1) * CH)]).toString('base64url') });
    }
    return json({}, 404);
  };
  try {
    const r = await l1Payload('X'.repeat(43), { opts: { attempts: 1 } });
    assert.ok(r.ok, r.reason);
    assert.equal(sha256(r.buf), sha256(want));
    assert.equal(r.height, 7);
    drop = true;
    const r2 = await l1Payload('X'.repeat(43), { opts: { attempts: 1 } });
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /chunk at/);
  } finally {
    globalThis.fetch = real;
  }
});

test('the void 2026-10-14 record normalises and regenerates its v2 bytes', () => {
  const rec = normalizeRecord(JSON.parse(read('deployments/nft-arweave.json')));
  assert.equal(rec.legacy, true);
  assert.equal(rec.sets[0].manifest, 'rdVTds7h7EwIlyYhD_lC9ikmXAj1SuHOvbvAOe30zow');
  assert.equal(Object.keys(rec.images.files).length, 12);
  const exp = expectedBytes(rec, rec.sets[0]);
  assert.match(exp.json['lunar_dust/0.json'].toString(), /arweave\.net\/68yMFaMMiQwSp3Ev0UFk0nel3_18yPxIjJc9dmz50PQ\/lunar_dust\/frost_blue\.webp/);
});

// verdict() is keyed by set AND metadataBaseUri: the URI is what gets compiled, so its own days are what count.
const TURBO_URI = 'https://turbo-gateway.com/' + 'T'.repeat(43) + '/';
const ARIO_URI = 'https://ar-io.dev/' + 'R'.repeat(43) + '/';
const FULL = { l1: true, gateways: ['turbo-gateway.com', 'ar-io.dev'] };
const rep = (day, pass, extra = {}, uris = {}) => ({
  day, ...FULL,
  sets: { 'turbo-gateway.com': { pass, metadataBaseUri: uris.turbo ?? TURBO_URI }, 'ar-io.dev': { pass: !pass, metadataBaseUri: uris.ario ?? ARIO_URI } },
  ...extra,
});
const DAYS = Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 9, 28 + i)).toISOString().slice(0, 10)); // 10-28 .. 11-03
const entry = (v, uri) => Object.values(v).find((x) => x.metadataBaseUri === uri);

test('7-day verdict: consecutive passing UTC days per set, gaps and failures reset it', () => {
  let v = verdict(DAYS.map((d) => rep(d, true)));
  assert.equal(entry(v, TURBO_URI).set, 'turbo-gateway.com');
  assert.equal(entry(v, TURBO_URI).streak, 7);
  assert.equal(entry(v, TURBO_URI).ready, true);
  assert.equal(entry(v, TURBO_URI).from, '2026-10-28');
  assert.equal(entry(v, ARIO_URI).ready, false);
  v = verdict([...DAYS.map((d) => rep(d, true)), rep(DAYS[6], false)]); // a failing run on the last day fails that day
  assert.equal(entry(v, TURBO_URI).streak, 0);
  v = verdict(DAYS.filter((_, i) => i !== 3).map((d) => rep(d, true))); // a missing day breaks the run
  assert.equal(entry(v, TURBO_URI).streak, 3);
  v = verdict([...DAYS.map((d) => rep(d, true, { sandbox: true })), rep(DAYS[0], true, { legacy: true })]);
  assert.deepEqual(v, {});
});

test('7-day verdict: a new upload under the same set name starts its own streak; an old URI is never READY', () => {
  const OLD = 'https://turbo-gateway.com/' + 'O'.repeat(43) + '/';
  const NEW = 'https://turbo-gateway.com/' + 'N'.repeat(43) + '/';
  const v = verdict([...DAYS.slice(0, 5).map((d) => rep(d, true, {}, { turbo: OLD })), ...DAYS.slice(5).map((d) => rep(d, true, {}, { turbo: NEW }))]);
  assert.equal(entry(v, NEW).streak, 2);
  assert.equal(entry(v, NEW).from, DAYS[5]);
  assert.equal(entry(v, NEW).ready, false);
  // the old URI is no longer checked on the latest day of the log: no streak, even though it had 5 passing days
  assert.equal(entry(v, OLD).streak, 0);
  assert.equal(entry(v, OLD).lastDay, DAYS[4]);
  assert.equal(Object.values(v).some((x) => x.ready), false);
});

test('7-day verdict: only reports with Arweave L1 and both gateways count', () => {
  assert.deepEqual(verdict(DAYS.map((d) => rep(d, true, { l1: false }))), {});
  assert.deepEqual(verdict(DAYS.map((d) => rep(d, true, { gateways: ['turbo-gateway.com'] }))), {});
  assert.deepEqual(verdict(DAYS.map((d) => rep(d, true, { gateways: undefined, l1: undefined }))), {});
  assert.deepEqual(verdict(DAYS.map((d) => rep(d, true, { imagesOnly: true }))), {});
  // one partial report on a day does not fail that day's full reports, and does not count either
  const v = verdict([...DAYS.map((d) => rep(d, true)), rep(DAYS[6], false, { l1: false })]);
  assert.equal(entry(v, TURBO_URI).streak, 7);
});

test('runCheck flags a record whose base URIs are not the bases it checks', async () => {
  const I = 'I'.repeat(43);
  const M = 'M'.repeat(43);
  const rec = (metadataBaseUri, imageBaseUri) => normalizeRecord({
    kind: 'moon-forge-nft-arweave', version: 2, texts: 'final', images: { manifest: I, files: {} },
    sets: [{ gateway: 'turbo-gateway.com', imageBaseUri, manifest: M, metadataBaseUri, files: {} }],
  });
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 404 }); // offline: every check fails fast
  try {
    const opts = { attempts: 1 };
    let r = await runCheck(rec(`https://turbo-gateway.com/${M}/`, `https://turbo-gateway.com/${I}/`), { opts });
    let s = r.sets['turbo-gateway.com'];
    assert.deepEqual(s.drift, []);
    assert.equal(s.pass, false); // 404s
    r = await runCheck(rec(`https://turbo-gateway.com/${'X'.repeat(43)}/`, `https://turbo-gateway.com/${I}/`), { opts });
    s = r.sets['turbo-gateway.com'];
    assert.ok(s.drift.some((d) => d.startsWith('metadataBaseUri')), JSON.stringify(s.drift));
    r = await runCheck(rec(`https://turbo-gateway.com/${M}/`, `https://ar-io.dev/${I}/`), { opts });
    s = r.sets['turbo-gateway.com'];
    assert.ok(s.drift.some((d) => d.startsWith('imageBaseUri')), JSON.stringify(s.drift));
    assert.equal(s.pass, false);
  } finally {
    globalThis.fetch = real;
  }
});
