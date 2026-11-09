// node --test: the strategist's pure decisions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { burnRoom, fitAmount, judgeQuote, kitOverrides, pickBurns, xntPerBillionXen } from '../src/strategy.mjs';
import { fakeQuote, testConfig, XEN, LAMPORTS } from './helpers.mjs';

const rule = { minXntPerBillionXen: 0, minQuoteOverMarketBps: 10_000, minRemainingTodayXnt: 0.001, maxShareOfRemainingBps: 2_500 };
const limits = { minXenPerBurn: 1_000n * XEN, maxXenPerBurn: 1_000_000n * XEN, maxXenPerDay: 3_000_000n * XEN, maxBurnsPerDay: 4 };
const day = (xen = 0n, burns = 0) => ({ xenWei: xen * XEN, burns });

test('XNT per 1e9 XEN is computed from the binding part of the quote', () => {
  const q = fakeQuote({ amountWei: 2_000_000_000n * XEN, rate: 3n });
  assert.equal(xntPerBillionXen(q), 3); // 3 lamports per XEN = 3 XNT per 1e9 XEN
  assert.equal(xntPerBillionXen({ amountWei: '0', bindingNow: 0n }), null);
});

test('burnRoom: per-burn cap, what is left today, the balance, whole XEN, and the minimum', () => {
  assert.equal(burnRoom({ limits, today: day(), balanceWei: 10n ** 40n }).maxWei, 1_000_000n * XEN);
  assert.equal(burnRoom({ limits, today: day(2_500_000n, 2), balanceWei: 10n ** 40n }).maxWei, 500_000n * XEN);
  assert.equal(burnRoom({ limits, today: day(0n), balanceWei: 12_345n * XEN + 7n }).maxWei, 12_345n * XEN, 'dust below 1 XEN is left alone');
  assert.match(burnRoom({ limits, today: day(0n, 4), balanceWei: 10n ** 40n }).why, /daily burn count/);
  assert.match(burnRoom({ limits, today: day(3_000_000n, 1), balanceWei: 10n ** 40n }).why, /daily XEN limit/);
  assert.match(burnRoom({ limits, today: day(), balanceWei: 10n * XEN }).why, /balance below minXenPerBurn/);
  assert.match(burnRoom({ limits, today: day(2_999_500n, 1), balanceWei: 10n ** 40n }).why, /below minXenPerBurn/);
});

test('judgeQuote: the kit refusal comes first, then the slice, the share, the rate and the market', () => {
  const a = 1_000n * XEN;
  assert.match(judgeQuote(fakeQuote({ amountWei: a, ok: false, refusals: [{ code: 'noQuote', text: 'no feed' }] }), rule).reason, /kit refused \(noQuote\)/);
  assert.match(judgeQuote(fakeQuote({ amountWei: a, remaining: 1000n }), rule).reason, /slice has/);
  assert.match(judgeQuote(fakeQuote({ amountWei: a, rate: 10n, remaining: 30_000n }), { ...rule, minRemainingTodayXnt: 0 }).reason, /more than 25%/);
  assert.match(judgeQuote(fakeQuote({ amountWei: a, rate: 2n }), { ...rule, minXntPerBillionXen: 5 }).reason, /below 5/);
  assert.match(judgeQuote(fakeQuote({ amountWei: a, rate: 4n, market: 5n }), rule).reason, /below 100% of selling/);
  assert.match(judgeQuote(fakeQuote({ amountWei: a, market: null }), rule).reason, /market route unknown/);
  assert.equal(judgeQuote(fakeQuote({ amountWei: a, market: null }), { ...rule, minQuoteOverMarketBps: 0 }).ok, true);
  assert.equal(judgeQuote(fakeQuote({ amountWei: a, rate: 11n, market: 10n }), { ...rule, minQuoteOverMarketBps: 11_000 }).ok, true);
  assert.equal(judgeQuote(fakeQuote({ amountWei: a, rate: 10n, market: 10n }), { ...rule, minQuoteOverMarketBps: 11_000 }).ok, false);
});

test('fitAmount finds the largest whole-XEN burn the rule accepts when the share limit binds', () => {
  // 10 lamports per XEN, 1 XNT left today, at most 25% of it per burn → at most 0.25 XNT → 25,000,000 XEN
  const quoteAt = (amountWei) => fakeQuote({ amountWei, rate: 10n, remaining: LAMPORTS });
  const r = fitAmount({ quoteAt, minWei: 1_000n * XEN, maxWei: 100_000_000n * XEN, rule });
  assert.equal(r.amountWei, 25_000_000n * XEN);
  assert.equal(r.verdict.ok, true);
  const all = fitAmount({ quoteAt, minWei: 1_000n * XEN, maxWei: 1_000_000n * XEN, rule });
  assert.equal(all.amountWei, 1_000_000n * XEN, 'the whole room when it fits');
  const none = fitAmount({ quoteAt: (a) => fakeQuote({ amountWei: a, rate: 1n }), minWei: 1_000n * XEN, maxWei: 10_000n * XEN, rule });
  assert.equal(none.amountWei, 0n);
  assert.match(none.verdict.reason, /selling/);
});

test('fitAmount follows a falling rate (a larger burn moves the curve) and stops at the threshold', () => {
  // rate falls from 20 to 0 lamports per XEN as the burn grows; the rule wants at least 8 XNT per 1e9 XEN
  const quoteAt = (amountWei) => {
    const xen = BigInt(amountWei) / XEN;
    const rate = 20n - (xen * 20n) / 10_000_000n;
    return fakeQuote({ amountWei, rate: rate > 0n ? rate : 0n, market: 0n, remaining: 10n ** 15n });
  };
  const r = fitAmount({ quoteAt, minWei: XEN, maxWei: 10_000_000n * XEN, rule: { ...rule, minXntPerBillionXen: 8 } });
  assert.equal(xntPerBillionXen(r.quote) >= 8, true);
  assert.equal(xntPerBillionXen(quoteAt(r.amountWei + 500_000n * XEN)) < 8, true);
});

test('pickBurns keeps the best rate first and at most maxBurnsPerTick; kitOverrides follow the config only', () => {
  const ev = [{ decision: 'BURN', rate: 1, chainId: 1 }, { decision: 'WAIT', rate: 9, chainId: 2 }, { decision: 'BURN', rate: 5, chainId: 3 }];
  assert.deepEqual(pickBurns(ev, 1).map((e) => e.chainId), [3]);
  assert.deepEqual(pickBurns(ev, 2).map((e) => e.chainId), [3, 1]);
  const { cfg } = testConfig();
  assert.deepEqual(kitOverrides(cfg), { allowVesting: false, allowBelowMarket: false });
  cfg.burn.rule.minQuoteOverMarketBps = 0; cfg.burn.tier = 1;
  assert.deepEqual(kitOverrides(cfg), { allowVesting: true, allowBelowMarket: true });
});
