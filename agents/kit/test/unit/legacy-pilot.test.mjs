// node --test: the Legacy Pilot member of the rules block (oracle/src/legacy.ts) in the kit's port (quote-v3.mjs): the one
// optional member, every parameter pinned, the snapshot's sha256 named; a feed whose rules block carries it is accepted
// and quotes exactly what it quotes without it (the top-ups are paid after every normal claim, from the week's leftover).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { feedProblems, quoteBurn } from '../../burn.mjs';
import { DEFAULT_RULES_V3, LEGACY_PILOT_V3, legacyPilotRulesOf, rulesBlockOf } from '../../quote-v3.mjs';
import { REPO } from './helpers-v3.mjs';

const SHA = 'ab'.repeat(32);
const RULE = { cutoffTs: 1_793_491_200, sourceChains: [1, 10, 56, 137, 8453, 43114], snapshotSha256: SHA, burnTopUpBps: 5_000, leftoverBps: 2_500, order: 'mission-order', artifactRebateBps: 2_000 };

test('Legacy Pilot: the rules block takes the optional member (kept as checked) and is unchanged without it', () => {
  assert.equal('legacyPilot' in rulesBlockOf(DEFAULT_RULES_V3), false);
  const r = rulesBlockOf({ ...DEFAULT_RULES_V3, legacyPilot: RULE });
  assert.deepEqual(r.legacyPilot, RULE);
  const { legacyPilot: _l, ...rest } = r;
  assert.deepEqual(rest, rulesBlockOf(DEFAULT_RULES_V3), 'every other member is read as before');
  assert.equal(new Date(LEGACY_PILOT_V3.cutoffTs * 1000).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.deepEqual(legacyPilotRulesOf(RULE), RULE);
});

test('Legacy Pilot: a parameter that is not the pinned rule, a bad sha256 or an extra member is refused (the block with it too)', () => {
  for (const [patch, re] of [
    [{ burnTopUpBps: 10_000 }, /not the Legacy Pilot rule this kit implements/],
    [{ leftoverBps: 5_000 }, /not the Legacy Pilot rule this kit implements/],
    [{ artifactRebateBps: 3_000 }, /not the Legacy Pilot rule this kit implements/],
    [{ cutoffTs: 1_793_491_201 }, /not the Legacy Pilot rule this kit implements/],
    [{ sourceChains: [10, 56, 137, 8453, 43114] }, /not the Legacy Pilot rule this kit implements/],
    [{ order: 'pro-rata' }, /not the Legacy Pilot rule this kit implements/],
    [{ snapshotSha256: 'AB'.repeat(32) }, /lowercase sha256/],
    [{ snapshotSha256: null }, /lowercase sha256/],
    [{ note: 'x' }, /must have exactly the members/],
  ]) {
    assert.throws(() => legacyPilotRulesOf({ ...RULE, ...patch }), re, JSON.stringify(patch));
    assert.throws(() => rulesBlockOf({ ...DEFAULT_RULES_V3, legacyPilot: { ...RULE, ...patch } }), re, JSON.stringify(patch));
  }
});

test('Legacy Pilot: the oracle engine in this repository pins the same parameters (when present)', (t) => {
  const file = path.join(REPO, 'oracle', 'src', 'legacy.ts');
  if (!fs.existsSync(file)) return t.skip('oracle/src/legacy.ts is not present (kit used outside the repository)');
  const src = fs.readFileSync(file, 'utf8');
  const num = (name) => Number(new RegExp(`export const ${name} = (\\d[\\d_]*)n?;`).exec(src)?.[1].replace(/_/g, ''));
  assert.deepEqual(
    [num('LEGACY_CUTOFF_TS'), num('LEGACY_BURN_TOPUP_BPS'), num('LEGACY_LEFTOVER_BPS'), num('LEGACY_ARTIFACT_REBATE_BPS')],
    [LEGACY_PILOT_V3.cutoffTs, LEGACY_PILOT_V3.burnTopUpBps, LEGACY_PILOT_V3.leftoverBps, LEGACY_PILOT_V3.artifactRebateBps],
  );
  assert.match(src, /export const LEGACY_ORDER = "mission-order" as const;/);
  const ids = [...src.matchAll(/\{ chainId: (\d+), xen: "0x[0-9a-f]{40}" \}/g)].map((m) => Number(m[1]));
  assert.deepEqual(ids, [...LEGACY_PILOT_V3.sourceChains]);
});

test('Legacy Pilot: a feed whose rules block carries the rule passes the feed checks and quotes exactly the same', async () => {
  const { FEED_FIXTURE } = await import('../vectors/gen-week-so-far.mjs');
  const { fixtureInputs } = await import('./helpers-v3.mjs');
  const fx = JSON.parse(fs.readFileSync(FEED_FIXTURE, 'utf8'));
  const inputs = await fixtureInputs();
  const withRule = { ...structuredClone(fx.feed), rulesBlock: { ...DEFAULT_RULES_V3, legacyPilot: RULE } };
  assert.deepEqual(feedProblems(withRule, { now: fx.candidate.now }), []);
  const quote = (feed) => quoteBurn({ feed, prev: inputs.prev, allowBelowMarket: true, ...fx.candidate, amountWei: BigInt(fx.candidate.amountWei) });
  const a = quote(fx.feed);
  const b = quote(withRule);
  assert.equal(b.ok, true, JSON.stringify(b.refusals));
  assert.equal(String(b.bindingNow), String(a.bindingNow));
  assert.equal(String(b.bindingNow), fx.expected.bindingNow);
  // a feed whose rule is not this kit's gives no quote
  const bad = { ...withRule, rulesBlock: { ...DEFAULT_RULES_V3, legacyPilot: { ...RULE, leftoverBps: 9_000 } } };
  assert.ok(feedProblems(bad, { now: fx.candidate.now }).some((p) => /rules block is not one this kit implements/.test(p)));
});
