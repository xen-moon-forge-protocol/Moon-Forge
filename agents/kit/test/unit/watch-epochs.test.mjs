// node --test: the dead-man watch's alarms (examples/watch.mjs evaluate) and the epoch-file sources (epochs.mjs):
// a directory, HTTPS through an injected fetch, in-memory files, refused names and "__proto__" members.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluate } from '../../examples/watch.mjs';
import { EpochSource, epochSourceOf, EPOCHS_URL } from '../../epochs.mjs';
import { epoch1, tempDir } from './helpers-v3.mjs';

const ok = (over = {}) => ({ ok: true, rules: 2, deploySlot: 85_429_880, oracle: { state: 'fresh', ageHours: 20 }, walletXnt: 1, kit: null, ...over });

test('watch: a quiet reading raises nothing; each condition raises its own alarm', () => {
  const first = ok();
  assert.deepEqual(evaluate(ok(), first), []);
  const codes = (r, o) => evaluate(r, first, o).map((a) => a.code);
  assert.deepEqual(codes(ok({ oracle: { state: 'late', ageHours: 9 * 24 } })), ['oracle-late']);
  assert.deepEqual(codes(ok({ rules: 3, deploySlot: 90_000_000 })), ['rules-changed', 'program-deployed']);
  assert.deepEqual(codes(ok({ rules: 'unknown' })), ['rules-unknown', 'rules-changed']);
  assert.deepEqual(codes(ok({ kit: { ok: false, text: 'older' } })), ['kit-outdated']);
  assert.deepEqual(codes(ok({ kit: { ok: false, unreadable: true, text: 'the agent card could not be read' } })), ['card-unreadable'], 'an unreadable card is an alarm, never a pass');
  assert.deepEqual(codes(ok({ walletXnt: 0.01 })), ['wallet-low']);
  assert.deepEqual(codes(ok({ walletXnt: 0.01 }), { minXnt: 0.001 }), []);
  assert.deepEqual(codes({ ok: false, error: 'fetch failed' }, { misses: 1 }), [], 'one missed read is not an alarm yet');
  assert.deepEqual(codes({ ok: false, error: 'fetch failed' }, { misses: 3 }), ['rpc']);
});

test('epoch sources: a directory, in-memory files, the index, the latest file', async () => {
  const dir = tempDir('mf-epochs');
  fs.writeFileSync(path.join(dir, 'epoch-1.json'), JSON.stringify(epoch1()));
  const d = new EpochSource({ dir });
  assert.equal((await d.epoch(1)).root, epoch1().root);
  assert.equal(await d.epoch(2), null);
  assert.deepEqual((await d.index()).epochs, [{ epoch: 1 }], 'without index.json the directory listing is the index');
  assert.equal((await d.latest()).epoch, 1);
  const m = new EpochSource({ files: { 'epoch-1.json': epoch1() } });
  assert.equal((await m.epoch(1)).epoch, 1);
  await assert.rejects(d.read('../secret.json'), /bad file name/);
  fs.writeFileSync(path.join(dir, 'epoch-3.json'), '{"__proto__":{"polluted":1},"epoch":3}');
  await assert.rejects(d.epoch(3), /__proto__/);
});

test('epoch sources: HTTPS only, through the fetch you pass; 404 is "not published"', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return url.endsWith('epoch-1.json') ? { ok: true, status: 200, text: async () => JSON.stringify(epoch1()) } : { ok: false, status: 404 }; };
  const s = new EpochSource({ url: EPOCHS_URL, fetchImpl });
  assert.equal((await s.epoch(1)).epoch, 1);
  assert.equal(await s.epoch(9), null);
  assert.deepEqual(seen, [`${EPOCHS_URL}epoch-1.json`, `${EPOCHS_URL}epoch-9.json`]);
  assert.throws(() => new EpochSource({ url: 'http://example.org/epochs/' }), /https/);
  assert.equal(epochSourceOf('site').url, EPOCHS_URL);
  assert.equal(epochSourceOf(null), null);
});
