// node --test: the kit's port of the rewards v3 engine (quote-v3.mjs) against the oracle's own round-4 rules vectors,
// oracle/test/fixtures/rules-v3-vectors.json (written by oracle/test/fixtures/make-rules-vectors.ts with rewards.ts
// computeEpochV3 and asserted there byte for byte): D-14 same-second tie-break, D-12 backlog, D-18 operator wallets and a
// dated exception, X-010 counters, D-13 frozen L with the F5 "carried" rule (rulesId 2: L.nextRule), D-22 (a) XDEX
// tranche cap and (c) USDC.X guard, D-21 orphaned chain, D-22 (b) pool switch. Every epoch of every world is rebuilt from its inputs and the previous file: burns[] in the
// arrival order with every allocation field, the capacity, the XNT build price and each chain's L record; and the live
// quote (quoteBurn) of every burn of the window that it can quote exactly (the last burn of its chain-hour) equals what
// the engine paid it at arrival. Skipped outside the repository (the file lives in the oracle tree).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { globalOrder, HOUR, quoteBurn, rulesBlockOf, windowResult } from '../../quote-v3.mjs';
import { REPO } from './helpers-v3.mjs';

const VECTORS = path.join(REPO, 'oracle', 'test', 'fixtures', 'rules-v3-vectors.json');
const doc = fs.existsSync(VECTORS) ? JSON.parse(fs.readFileSync(VECTORS, 'utf8')) : null;
const PICK = ['chainId', 'txHash', 'logIndex', 'priceE18', 'priceRule', 'xntE18', 'xntRule', 'hour', 'day', 'backlog', 'operator', 'exception', 'spotMicro', 'valueMicro', 'base', 'lp', 'ent', 'band', 'senior', 'basePaid', 'bandPaid', 'lockedLp', 'converted', 'leafTier'];
const CAP = ['cash', 'planCash', 'trancheCap', 'tranche', 'senior', 'base', 'bandTotal', 'bandPaid', 'left', 'lockedMissions', 'splitMissions', 'convertedMissions'];
const each = (fn) => { for (const w of doc.worlds) w.epochs.forEach((e, i) => fn(w, e, i === 0 ? null : w.epochs[i - 1].file)); };

test('the oracle\'s rules vectors: every epoch rebuilt by the kit\'s port, burn by burn, to the lamport', { skip: !doc && 'oracle/test/fixtures/rules-v3-vectors.json is not present' }, () => {
  assert.equal(doc.kind, 'rules-v3-vectors');
  let epochs = 0, burns = 0;
  const seen = { backlog: 0, operator: 0, exception: 0, orphan: 0, capped: 0, peg: 0, frozen: 0, ties: 0, carried: 0, clamp: 0 };
  each((w, e, prev) => {
    const f = e.file;
    const label = `${w.name} epoch ${e.inputs.epoch}`;
    // the rules block the file records is the one the kit implements (the engine read it from the inputs)
    assert.deepEqual(rulesBlockOf(f.rulesBlock), f.rulesBlock, `${label}: rules block`);
    const got = windowResult(prev, e.inputs);
    assert.deepEqual(got.burns, f.burns.map((b) => Object.fromEntries(PICK.map((k) => [k, b[k]]))), `${label}: burns[] (order and allocation)`);
    assert.deepEqual(got.capacity, Object.fromEntries(CAP.map((k) => [k, f.capacity[k]])), `${label}: capacity`);
    const sf = f.capacity.shortfall;
    assert.deepEqual(got.shortfall, sf ? { stage: sf.stage, kept: sf.kept, wanted: sf.wanted, claim: sf.claim, planned: sf.planned } : null, `${label}: shortfall`);
    assert.deepEqual(got.xnt, { buildE18: f.xnt.buildE18, floorE18: f.xnt.floorE18, peg: f.xnt.peg }, `${label}: XNT`);
    const valued = f.chains.filter((c) => !c.skipped).map((c) => ({
      chainId: c.chainId, L: { used: c.L.used, rule: c.L.rule, stat: c.L.stat, next: c.L.next, nextRule: c.L.nextRule, cap: c.L.cap }, priceCapE18: c.priceCapE18, xenUsdE18: c.xenUsdE18, curveAfter: c.curveAfter,
    }));
    assert.deepEqual(got.chains, valued, `${label}: chain records`);
    // F5: the valued chains whose next L was carried (feed missing or thin) and those clamped
    seen.carried += valued.filter((c) => c.L.nextRule === 'carried').length;
    seen.clamp += valued.filter((c) => c.L.nextRule === 'clamp').length;
    epochs++;
    burns += f.burns.length;
    seen.backlog += f.burns.filter((b) => b.backlog).length;
    seen.operator += f.burns.filter((b) => b.operator).length;
    seen.exception += f.burns.filter((b) => b.exception !== null).length;
    seen.orphan += f.burns.filter((b) => b.priceRule === 'orphan').length;
    seen.capped += f.capacity.trancheCap !== null && f.capacity.cash === f.capacity.trancheCap ? 1 : 0;
    seen.peg += f.xnt.peg.guard === 'high' ? 1 : 0;
    seen.frozen += f.chains.filter((c) => c.L.rule === 'frozen').length;
    const ts = f.burns.map((b) => b.timestamp);
    seen.ties += ts.length - new Set(ts).size;
  });
  assert.ok(epochs >= 20 && burns >= 40, `${epochs} epochs, ${burns} burns`);
  for (const [k, n] of Object.entries(seen)) assert.ok(n > 0, `the vectors exercise ${k} (${n})`);
});

test('the oracle\'s rules vectors: the live quote of each burn of the window from the burns before it is what the engine paid it at arrival', { skip: !doc && 'oracle/test/fixtures/rules-v3-vectors.json is not present' }, () => {
  let exact = 0;
  each((w, e, prev) => {
    const f = e.file;
    if (f.capacity.shortfall) return;
    const all = e.inputs.chains.flatMap((c) => c.burns).sort(globalOrder);
    for (const b of all) {
      const paid = f.burns.find((x) => x.chainId === b.chainId && x.txHash === b.txHash && x.logIndex === b.logIndex);
      // a backlog or operator burn claims after every burn of the window (D-12, D-18): it has no quote of its own
      if (!paid || paid.backlog || paid.operator) continue;
      // exact only for the last burn of its chain-hour (earlier burns of the hour share the pot with the later ones)
      const later = all.filter((x) => globalOrder(x, b) > 0 && x.chainId === b.chainId && Math.floor(x.timestamp / HOUR) === Math.floor(b.timestamp / HOUR));
      if (later.length) continue;
      const before = { ...e.inputs, chains: e.inputs.chains.map((c) => ({ ...c, burns: c.burns.filter((x) => globalOrder(x, b) < 0) })) };
      const orphan = e.inputs.chains.find((c) => c.chainId === b.chainId)?.orphan === true;
      const q = quoteBurn(prev, before, { ...b, ...(orphan ? { priceSource: 'orphan', medianE18: '0', lastCloseE18: '0' } : {}) });
      const label = `${w.name} epoch ${e.inputs.epoch} ${b.chainId}:${b.txHash.slice(0, 10)}`;
      assert.equal(q.bindingNow.toString(), paid.senior, `${label}: arrival claim`);
      assert.equal(q.lockedLp.toString(), paid.lockedLp, `${label}: locked piece`);
      assert.equal(q.bandLocked.toString(), paid.bandPaid, `${label}: band`);
      assert.equal(q.leafTier, paid.leafTier, `${label}: leaf tier`);
      assert.equal(q.converted, paid.converted, `${label}: converted`);
      assert.equal(q.valueMicro.toString(), paid.valueMicro, `${label}: value`);
      assert.equal(q.priceRule, paid.priceRule, `${label}: XEN price rule`);
      assert.equal(q.chain.Lrule, f.chains.find((c) => c.chainId === b.chainId).L.rule, `${label}: L rule`);
      assert.equal(q.exception, paid.exception, `${label}: exception`);
      exact++;
    }
  });
  assert.ok(exact >= 20, `${exact} quotes equal to the engine's arrival outcome`);
});
