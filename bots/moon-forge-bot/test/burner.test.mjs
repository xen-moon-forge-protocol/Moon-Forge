// node --test: dry-run planning of one tick with a mocked feed and mocked RPCs, the live path with a mocked burn, and
// one tick through the kit's real quoteBurn() on a golden week-so-far feed from the kit's own test vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { burnTick } from '../src/burner.mjs';
import { Journal } from '../src/journal.mjs';
import { readPortalsFile, resolveChains } from '../src/chains.mjs';
import { quoteBurn } from '../src/kit.mjs';
import { fakeQuote, fakeRpc, fakeKey, sinkLogger, testConfig, x1Address, XEN, LAMPORTS } from './helpers.mjs';
import { feedFromWorld, loadVectors, prevOf, burnsOf } from '../../../agents/kit/test/unit/helpers-v3.mjs';
import { HOUR } from '../../../agents/kit/quote-v3.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORTALS = readPortalsFile(path.resolve(HERE, '../../../deployments/portals.json'));

function setup({ rates = { 10: 10n, 8453: 12n }, rpcOver = {}, cfgOver = {}, live = false, feed = { epoch: 5 }, kill = null, burn = null } = {}) {
  const { cfg, limits } = testConfig(cfgOver);
  const chains = resolveChains(cfg, PORTALS);
  const journal = new Journal(null);
  const { lines, log } = sinkLogger();
  const rpcs = new Map();
  const burns = [];
  const deps = {
    getFeed: async () => { if (feed instanceof Error) throw feed; return feed; },
    getPrev: async () => ({ epoch: 4 }),
    now: () => 1_800_000_000,
    quote: ({ chainId, amountWei }) => fakeQuote({ amountWei, rate: rates[chainId] ?? 0n, remaining: 100n * LAMPORTS }),
    burn: burn ?? (async (args) => { burns.push(args); return { burned: true, txHash: '0xabc', missionId: 7n }; }),
    rpcFor: async (c) => { if (!rpcs.has(c.chainId)) rpcs.set(c.chainId, fakeRpc({ chainId: BigInt(c.chainId), ...(rpcOver[c.chainId] ?? {}) })); return rpcs.get(c.chainId); },
    key: live ? fakeKey : null,
    walletAddress: live ? fakeKey.address : null,
    x1Connection: null,
    readOracle: null,
    killSwitch: () => kill,
  };
  return { ctx: { cfg, limits: limits.burn, chains, journal, log, live, tick: 1, deps }, lines, burns, journal };
}
const decisions = (lines) => lines.filter((l) => l.includes('DECISION'));

test('dry run: one decision line per chain, the best chain picked, nothing sent', async () => {
  const { ctx, lines, burns } = setup();
  const r = await burnTick(ctx);
  const d = decisions(lines);
  assert.equal(d.length, 5, 'every chain of portals.json gets a line');
  assert.ok(d.some((l) => /chain=Base\(8453\) decision=BURN .*amountXen=1000000/.test(l)), d.join('\n'));
  assert.ok(d.some((l) => /chain=Optimism\(10\) decision=WAIT reason="another chain pays more per XEN this tick"/.test(l)));
  assert.ok(d.some((l) => /chain=BSC\(56\) decision=SKIP .*no RPC/.test(l)));
  assert.ok(d.every((l) => /mode=dry-run/.test(l)));
  assert.equal(burns.length, 0);
  assert.ok(lines.some((l) => /dry run: would burn 1000000 XEN on Base/.test(l)));
  assert.equal(r.results.length, 0);
});

test('gas above the cap, a missing feed and the kill switch all mean WAIT or STOP with the reason', async () => {
  const gas = setup({ rpcOver: { 8453: { fee: { maxFeePerGas: 900_000_000_000n, maxPriorityFeePerGas: 1n, gasPrice: 1n } } } });
  await burnTick(gas.ctx);
  assert.ok(decisions(gas.lines).some((l) => /Base\(8453\) decision=WAIT reason="gas price 900 gwei is above the cap of 5 gwei"/.test(l)));
  assert.ok(decisions(gas.lines).some((l) => /Optimism\(10\) decision=BURN/.test(l)), 'the other chain still burns');

  const nofeed = setup({ feed: new Error('fetchWeekFeed: HTTP 404') });
  await burnTick(nofeed.ctx);
  assert.ok(decisions(nofeed.lines).filter((l) => /decision=WAIT reason="no week-so-far feed published yet: before the v3 switch epoch/.test(l)).length === 2);

  const stop = setup({ kill: 'the kill-switch file exists' });
  const r = await burnTick(stop.ctx);
  assert.equal(r.stopped, true);
  assert.ok(decisions(stop.lines).every((l) => /decision=STOP/.test(l)));
});

test('the rule threshold and the kit refusal stop a burn', async () => {
  const low = setup({ rates: { 10: 3n, 8453: 3n } });
  await burnTick(low.ctx);
  assert.ok(decisions(low.lines).filter((l) => /decision=WAIT reason=.*below 100% of selling/.test(l)).length === 2);
  const refused = setup();
  refused.ctx.deps.quote = ({ amountWei }) => fakeQuote({ amountWei, ok: false, refusals: [{ code: 'noQuote', text: 'no binding quote' }] });
  await burnTick(refused.ctx);
  assert.ok(decisions(refused.lines).filter((l) => /kit refused \(noQuote\)/.test(l)).length === 2);
});

test('the daily XEN limit carries across ticks through the journal', async () => {
  const s = setup({ live: true });
  for (let i = 0; i < 4; i++) await burnTick({ ...s.ctx, tick: i + 1 });
  assert.equal(s.burns.length, 3, '3,000,000 XEN per day at 1,000,000 per burn');
  assert.equal(s.journal.today().xenWei, 3_000_000n * XEN);
  assert.ok(decisions(s.lines).some((l) => /daily XEN limit reached/.test(l)));
});

test('live: burnXen gets the guarded signer, the typed confirmation, the overrides and the XEN balance limit', async () => {
  const s = setup({ live: true, rpcOver: { 8453: { xenBalance: 400_000n * XEN + 5n } }, cfgOver: { burn: { rule: { minXenPerBurn: '1000' } } } });
  await burnTick(s.ctx);
  assert.equal(s.burns.length, 1);
  const a = s.burns[0];
  assert.equal(a.chainId, 8453);
  assert.equal(a.amountWei, 400_000n * XEN, 'capped by the wallet balance, whole XEN');
  assert.equal(a.confirmLast6, s.ctx.cfg.x1Destination.slice(-6));
  assert.equal(a.allowBelowMarket, false);
  assert.equal(a.allowLargeShare, undefined, 'never overridden');
  assert.equal(typeof a.signer.sendTransaction, 'function');
  assert.equal(await a.signer.getAddress(), fakeKey.address);
  assert.ok(s.lines.some((l) => /burned on Base: 0xabc mission 7/.test(l)));
});

test('live: an unfinished transaction in the journal blocks new burns on that chain', async () => {
  const s = setup({ live: true });
  s.journal.openSend({ chainId: 8453, kind: 'approve', nonce: '5', hash: 'h:x' });
  await burnTick(s.ctx);
  assert.ok(decisions(s.lines).some((l) => /Base\(8453\) decision=WAIT reason="1 transaction\(s\) not final yet/.test(l)));
  assert.equal(s.burns[0].chainId, 10, 'the other chain is still served');
});

test('one dry-run tick through the kit\'s real quote on a golden week-so-far feed', async () => {
  const v = loadVectors();
  let found = null;
  for (const w of v.worlds.filter((x) => x.expected && x.solo && !x.expected.shortfall)) {
    const chain = w.inputs.chains.find((c) => BigInt(c.liquidityNowMicro) > 0n && c.burns.length && PORTALS.some((p) => p.chainId === c.chainId));
    if (!chain) continue;
    for (const b of burnsOf(w.inputs)) {
      const now = (Math.floor(b.timestamp / HOUR) + 1) * HOUR + 600;
      if (now > w.inputs.window.endTs) continue;
      const feed = feedFromWorld(w, now);
      const q = quoteBurn({ feed, prev: prevOf(w), chainId: chain.chainId, amountWei: 1_000n * XEN, tier: 0, x1: x1Address(), now, allowBelowMarket: true });
      if (q.ok && q.bindingNow > 0n) { found = { w, chain, now, feed }; break; }
    }
    if (found) break;
  }
  assert.ok(found, 'a usable world in the kit vectors');
  const { cfg, limits } = testConfig({ burn: { rule: { minQuoteOverMarketBps: 0, maxShareOfRemainingBps: 5000, minRemainingTodayXnt: 0, minXenPerBurn: '1' }, limits: { maxXenPerBurn: '1000', maxXenPerDay: '1000' }, chains: { [found.chain.chainId]: { rpcs: ['https://rpc.invalid'] } } } });
  const chains = resolveChains(cfg, PORTALS).filter((c) => c.chainId === found.chain.chainId);
  const { lines, log } = sinkLogger();
  const deps = {
    getFeed: async () => found.feed, getPrev: async () => prevOf(found.w), now: () => found.now, quote: quoteBurn,
    burn: async () => assert.fail('dry run must not burn'), rpcFor: async () => fakeRpc({ chainId: BigInt(found.chain.chainId) }),
    key: null, walletAddress: null, x1Connection: null, readOracle: null, killSwitch: () => null,
  };
  const r = await burnTick({ cfg, limits: limits.burn, chains, journal: new Journal(null), log, live: false, tick: 1, deps });
  assert.equal(r.evaluations[0].decision, 'BURN', decisions(lines).join('\n'));
  assert.ok(r.evaluations[0].quote.bindingNow > 0n);
  assert.ok(decisions(lines)[0].includes('quoteXnt='));
});
