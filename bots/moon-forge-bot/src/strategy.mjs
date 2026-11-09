// The burn strategist's decisions, as pure functions (no network, no clock): the tests drive them with fixed quotes.
// The kit's quote is the floor of every decision: the bot never burns what the kit refuses, and the owner's rule can
// only add conditions on top of it.
import { fromUnits, XEN_DECIMALS } from './config.mjs';

const WHOLE_XEN = 10n ** 18n;
const BILLION_XEN_WEI = 10n ** 27n;

/** XNT paid at arrival per 1,000,000,000 XEN, from a kit quote (a float, for logs and thresholds only). */
export function xntPerBillionXen(q) {
  if (!q || q.bindingNow === undefined) return null;
  const amount = BigInt(q.amountWei);
  if (amount === 0n) return null;
  // lamports per 1e27 wei, kept in integers until the last division
  return Number((BigInt(q.bindingNow) * BILLION_XEN_WEI) / amount) / 1e9;
}

/**
 * How much XEN the limits leave for one burn on `chainId` now: min(per burn, what is left of the day's total, the
 * balance). Returns { maxWei, why } (why is set when maxWei is 0).
 */
export function burnRoom({ limits, today, todayChain, balanceWei }) {
  if (today.burns >= limits.maxBurnsPerDay) return { maxWei: 0n, why: `daily burn count reached (${today.burns}/${limits.maxBurnsPerDay})` };
  const leftToday = limits.maxXenPerDay > today.xenWei ? limits.maxXenPerDay - today.xenWei : 0n;
  if (leftToday === 0n) return { maxWei: 0n, why: 'daily XEN limit reached' };
  let max = limits.maxXenPerBurn;
  if (leftToday < max) max = leftToday;
  if (BigInt(balanceWei) < max) max = BigInt(balanceWei);
  max -= max % WHOLE_XEN; // whole XEN only: no dust left behind, and the search below runs on whole units
  if (max < limits.minXenPerBurn) {
    return { maxWei: 0n, why: BigInt(balanceWei) < limits.minXenPerBurn ? 'XEN balance below minXenPerBurn' : 'what the limits leave today is below minXenPerBurn' };
  }
  void todayChain;
  return { maxWei: max, why: null };
}

/** The kit overrides the owner's config implies. Nothing else is ever overridden. */
export function kitOverrides(cfg) {
  return {
    allowVesting: cfg.burn.tier > 0,
    // with no market check asked for, the kit's own below-market refusal is lifted; otherwise the kit checks 1:1 and the bot adds its own bps
    allowBelowMarket: cfg.burn.rule.minQuoteOverMarketBps === 0,
  };
}

/**
 * Does the owner's rule accept this quote? Returns { ok, reason }. `rule` is burn.rule of the config.
 * Checks, in order: the kit's refusals, today's slice, the share of it, XNT per XEN, the market comparison.
 */
export function judgeQuote(q, rule) {
  if (!q) return { ok: false, reason: 'no quote' };
  if (!q.ok) {
    const codes = [...new Set((q.refusals ?? []).map((r) => r.code))].join(',');
    return { ok: false, reason: `kit refused (${codes || 'unknown'})`, detail: q.refusals?.[0]?.text };
  }
  const remaining = BigInt(q.tranche.remainingToday);
  if (q.tranche.remainingTodayXnt < rule.minRemainingTodayXnt) return { ok: false, reason: `today's slice has ${q.tranche.remainingTodayXnt.toFixed(6)} XNT left (< ${rule.minRemainingTodayXnt})` };
  if (BigInt(q.entitlement) * 10_000n > remaining * BigInt(rule.maxShareOfRemainingBps)) return { ok: false, reason: `the burn would take more than ${rule.maxShareOfRemainingBps / 100}% of what is left today` };
  const rate = xntPerBillionXen(q);
  if (rate === null || rate < rule.minXntPerBillionXen) return { ok: false, reason: `XNT per 1e9 XEN ${rate?.toFixed(6) ?? '?'} below ${rule.minXntPerBillionXen}` };
  if (rule.minQuoteOverMarketBps > 0) {
    if (q.marketRoute === null || q.marketRoute === undefined) return { ok: false, reason: 'market route unknown: cannot compare with selling' };
    if (BigInt(q.bindingNow) * 10_000n < BigInt(q.marketRoute) * BigInt(rule.minQuoteOverMarketBps)) {
      return { ok: false, reason: `quote ${q.bindingNowXnt.toFixed(6)} XNT is below ${rule.minQuoteOverMarketBps / 100}% of selling (${q.marketRouteXnt.toFixed(6)} XNT)` };
    }
  }
  return { ok: true, reason: 'rule met' };
}

/**
 * The largest whole-XEN amount in [minWei, maxWei] that the kit and the rule accept, by bisection (a larger burn on the
 * same curve never pays more per XEN, so acceptance falls as the amount grows). `quoteAt(amountWei)` returns a kit
 * quote. Returns { amountWei, quote, verdict } or { amountWei: 0n, quote, verdict } with the reason of the smallest try.
 */
export function fitAmount({ quoteAt, minWei, maxWei, rule, maxSteps = 48 }) {
  const tryAt = (a) => { const q = quoteAt(a); return { q, v: judgeQuote(q, rule) }; };
  const top = tryAt(maxWei);
  if (top.v.ok) return { amountWei: maxWei, quote: top.q, verdict: top.v };
  const bottom = minWei === maxWei ? top : tryAt(minWei);
  if (!bottom.v.ok) return { amountWei: 0n, quote: bottom.q, verdict: bottom.v };
  let lo = minWei / WHOLE_XEN, hi = maxWei / WHOLE_XEN, best = bottom;
  for (let i = 0; i < maxSteps && hi - lo > 1n; i++) {
    const mid = (lo + hi) / 2n;
    const t = tryAt(mid * WHOLE_XEN);
    if (t.v.ok) { lo = mid; best = t; } else hi = mid;
  }
  return { amountWei: lo * WHOLE_XEN, quote: best.q, verdict: best.v };
}

/** Picks the burns of this tick: the accepted ones, best XNT per XEN first, at most `maxBurnsPerTick`. */
export function pickBurns(evaluations, maxBurnsPerTick) {
  return evaluations
    .filter((e) => e.decision === 'BURN')
    .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))
    .slice(0, maxBurnsPerTick);
}

/** The flat fields of a decision line. */
export function decisionFields(e) {
  return {
    chain: `${e.chain}(${e.chainId})`, decision: e.decision, reason: e.reason,
    amountXen: e.amountWei ? fromUnits(e.amountWei, XEN_DECIMALS) : undefined,
    quoteXnt: e.quote?.bindingNowXnt?.toFixed?.(6), xntPer1e9Xen: e.rate?.toFixed?.(6),
    leftTodayXnt: e.quote?.tranche?.remainingTodayXnt?.toFixed?.(6), sellXnt: e.quote?.marketRouteXnt?.toFixed?.(6),
  };
}
