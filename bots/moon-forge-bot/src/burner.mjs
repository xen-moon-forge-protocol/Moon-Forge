// One tick of the burn strategist: read the hourly feed once, judge every chain, log one decision line per chain,
// then (with --live) burn on the best accepted chain through the kit's burnXen() and the guarded signer.
// Without --live nothing is signed: the same decisions are printed with mode=dry-run.
import { burnRoom, decisionFields, fitAmount, kitOverrides, pickBurns, xntPerBillionXen } from './strategy.mjs';
import { encodeBalanceOf } from './kit.mjs';
import { priceCheck, guardedSigner } from './evm-guard.mjs';
import { toUnits, NATIVE_DECIMALS } from './config.mjs';

const short = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 200);

/**
 * ctx: { cfg, limits, chains, journal, log, live, tick, deps }
 * deps: { getFeed(), getPrev(feed), now() (unix s), quote(args), burn(args), rpcFor(chain), key (adapter | null),
 *         walletAddress (string | null), x1Connection (| null), readOracle() (| null), killSwitch() }
 * Returns the evaluations (one per chain) and the results of the burns sent.
 */
export async function burnTick(ctx) {
  const { cfg, limits, chains, journal, log, live, tick, deps } = ctx;
  const mode = live ? 'live' : 'dry-run';
  const line = (e) => log.decision({ tick, mode, ...decisionFields(e) });
  const stop = deps.killSwitch();
  if (stop) {
    for (const c of chains) line({ chain: c.name, chainId: c.chainId, decision: 'STOP', reason: stop });
    return { evaluations: [], results: [], stopped: true };
  }

  let feed = null, prev = null, feedError = null;
  try {
    feed = await deps.getFeed();
    if (feed && Number(feed.epoch) > 1) prev = await deps.getPrev(feed);
  } catch (e) {
    feedError = /HTTP 404/.test(short(e))
      ? 'no week-so-far feed published yet: before the v3 switch epoch no binding quote exists, so the bot does not burn'
      : `feed unavailable: ${short(e)}`;
  }
  const now = deps.now();
  let oracle = null;
  if (deps.readOracle) { try { oracle = await deps.readOracle(); } catch { oracle = null; } }
  const overrides = kitOverrides(cfg);
  const x1 = cfg.x1Destination;
  const evaluations = [];

  for (const c of chains) {
    const base = { chain: c.name, chainId: c.chainId };
    if (!c.usable) { evaluations.push({ ...base, decision: 'SKIP', reason: c.why }); continue; }
    if (feedError) { evaluations.push({ ...base, decision: 'WAIT', reason: feedError }); continue; }
    const s = c.settings;
    const lim = { ...limits, ...pickChainLimits(s.limits) };
    const gas = { ...s.gas, extraFeeWei: toUnits(s.gas.extraFeeNative ?? '0', NATIVE_DECIMALS) };
    try {
      const rpc = await deps.rpcFor(c);
      if (live) {
        const open = journal.unresolved(c.chainId);
        if (open.length) { evaluations.push({ ...base, decision: 'WAIT', reason: `${open.length} transaction(s) not final yet (checked before any new send)` }); continue; }
      }
      // gas first: a chain whose fee is above the cap is not worth quoting this tick
      const fee = await rpc.getFeeData();
      const gasProbe = priceCheck({ fee, gasLimit: 120_000n, gas, limits: lim });
      if (!gasProbe.ok) { evaluations.push({ ...base, decision: 'WAIT', reason: gasProbe.why }); continue; }
      let balanceWei = lim.maxXenPerBurn, balanceNote;
      if (deps.walletAddress) balanceWei = BigInt(await rpc.call({ to: c.xen, data: encodeBalanceOf(deps.walletAddress) }) || '0x0');
      else balanceNote = 'balance not read (no wallet in dry run)';
      const room = burnRoom({ limits: lim, today: journal.today(), todayChain: journal.today(c.chainId), balanceWei });
      if (!room.maxWei) { evaluations.push({ ...base, decision: 'WAIT', reason: room.why }); continue; }
      const quoteAt = (amountWei) => deps.quote({ feed, prev, chainId: c.chainId, amountWei, tier: cfg.burn.tier, x1, now, oracle, ...overrides });
      const fit = fitAmount({ quoteAt, minWei: lim.minXenPerBurn, maxWei: room.maxWei, rule: cfg.burn.rule });
      if (!fit.amountWei) { evaluations.push({ ...base, decision: 'WAIT', reason: fit.verdict.reason, quote: fit.quote?.ok ? fit.quote : undefined }); continue; }
      evaluations.push({ ...base, decision: 'BURN', reason: [fit.verdict.reason, balanceNote].filter(Boolean).join('; '), amountWei: fit.amountWei, quote: fit.quote, rate: xntPerBillionXen(fit.quote), rpc, gas, lim });
    } catch (e) {
      evaluations.push({ ...base, decision: 'WAIT', reason: `read failed: ${short(e)}` });
    }
  }

  const picked = new Set(pickBurns(evaluations, limits.maxBurnsPerTick));
  for (const e of evaluations) {
    if (e.decision === 'BURN' && !picked.has(e)) { e.decision = 'WAIT'; e.reason = 'another chain pays more per XEN this tick'; }
    line(e);
  }

  const results = [];
  for (const e of picked) {
    if (!live) { log.info(`dry run: would burn ${decisionFields(e).amountXen} XEN on ${e.chain} for about ${e.quote.bindingNowXnt.toFixed(6)} XNT at arrival (not sent; add --live to send)`); continue; }
    const signer = guardedSigner({ chainId: e.chainId, rpc: e.rpc, key: deps.key, journal, gas: e.gas, limits: e.lim, killSwitch: deps.killSwitch, log: log.info });
    try {
      const r = await deps.burn({
        signer, chainId: e.chainId, amountWei: e.amountWei, tier: cfg.burn.tier, x1, confirmLast6: cfg.x1DestinationConfirm,
        getFeed: deps.getFeed, prev, x1Connection: deps.x1Connection, confirmations: e.gas.confirmations, ...overrides,
        onStep: (step, info) => log.info(`burn ${e.chain}: ${step}${info?.hash ? ` ${info.hash}` : ''}`),
      });
      if (r.burned) journal.recordBurn(e.chainId, e.amountWei);
      log.info(r.burned ? `burned on ${e.chain}: ${r.txHash} mission ${r.missionId ?? '?'}${r.warning ? ` WARNING ${r.warning}` : ''}` : `not burned on ${e.chain}: ${r.reason}`);
      results.push({ chainId: e.chainId, ...r });
    } catch (err) {
      log.warn(`burn on ${e.chain} stopped before completion: ${short(err)}`);
      results.push({ chainId: e.chainId, burned: false, error: short(err) });
    }
  }
  return { evaluations, results, stopped: false };
}

/** The integer limits of a chain's own overrides (burn.chains[id].limits), when it has any. */
function pickChainLimits(l) {
  const out = {};
  if (l?.maxXenPerBurn !== undefined) out.maxXenPerBurn = toUnits(l.maxXenPerBurn, 18, 'chain maxXenPerBurn');
  return out;
}
