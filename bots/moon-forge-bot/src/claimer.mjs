// The claimer: finds the owner's leaves in the published epoch files (and, after the final upgrade, the extra-pot
// rebate leaves), and claims each one once its 48-hour hold is over and while its 90-day window is open. A claim is
// permissionless: the bot's X1 key pays the fee and the receipt rent, and the XNT always goes to the wallet in the leaf.
// The kit verifies every leaf against the root stored on X1 before anything is sent; the decisions below come first.
import { V3 } from './kit.mjs';

const iso = (ts) => new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** What to do with one base leaf (the shape of the kit's verifyMyClaim()). Pure: { action: 'claim' | 'wait' | 'skip', reason }. */
export function leafDecision(l, { now, minClaimXnt = 0 }) {
  if (l.claimed) return { action: 'skip', reason: 'already claimed' };
  if (!l.ok) return { action: 'skip', reason: `does not verify against X1: ${(l.reasons ?? [])[0] ?? 'unknown'}` };
  const published = l.onChain?.publishedAt ?? null;
  if (l.expired || (published !== null && now >= published + V3.CLAIM_WINDOW)) return { action: 'skip', reason: 'past the 90-day claim window' };
  if (l.onHold || (published !== null && l.claimableFrom && now < l.claimableFrom)) return { action: 'wait', reason: `on its 48 h hold until ${iso(l.claimableFrom)}` };
  if (l.estimateXnt !== null && l.estimateXnt !== undefined && l.estimateXnt < minClaimXnt) return { action: 'skip', reason: `estimate ${l.estimateXnt} XNT below minClaimXnt` };
  return { action: 'claim', reason: 'claimable' };
}

/** The same for an extra-pot rebate leaf (the shape of the kit's verifyExtraClaim()). */
export function extraDecision(v, { minClaimXnt = 0 } = {}) {
  if (v.claimed) return { action: 'skip', reason: 'already claimed' };
  if (!v.ok) return { action: 'skip', reason: (v.reasons ?? [])[0] ?? 'no leaf' };
  if (v.closed) return { action: 'skip', reason: 'past the 90-day claim window' };
  if (v.onHold) return { action: 'wait', reason: `on its 48 h hold until ${iso(v.claimableFrom)}` };
  if (v.amountXnt < minClaimXnt) return { action: 'skip', reason: `rebate ${v.amountXnt} XNT below minClaimXnt` };
  return { action: 'claim', reason: 'claimable' };
}

/** One claim pass. mf is a connected kit client; returns [{ kind, epoch, action, reason, signature? }]. */
export async function claimTick({ mf, cfg, live, log, tick }) {
  const c = cfg.claims;
  const owner = c.owner || cfg.x1Destination || mf.me.toBase58();
  const now = await mf.chainTime();
  const out = [];
  const mode = live ? 'live' : 'dry-run';
  const act = async (kind, epoch, d, send) => {
    const row = { kind, epoch, action: d.action, reason: d.reason };
    if (d.action === 'claim' && live) {
      try { const r = await send(); row.signature = r.signature; row.reason = `claimed${r.estimateXnt !== undefined && r.estimateXnt !== null ? ` (about ${r.estimateXnt} XNT)` : ''}`; } catch (e) { row.action = 'error'; row.reason = String(e?.message ?? e).slice(0, 200); }
    }
    log.decision({ tick, mode, claim: kind, epoch, decision: row.action.toUpperCase(), reason: row.reason, tx: row.signature });
    out.push(row);
  };

  if (c.base) {
    for (const l of await mf.myLeaves({ owner, last: c.lastEpochs })) {
      await act(`base-t${l.tier ?? '?'}`, l.epoch, leafDecision(l, { now, minClaimXnt: c.minClaimXnt }), () => mf.claim(l.epoch, { tier: l.tier, owner }));
    }
  }
  if (c.extra && (await mf.rulesNow()) === 3) {
    const idx = await mf.epochSource('claims').index();
    for (const e of idx.epochs.slice(-13)) {
      const v = await mf.verifyExtraClaim(e.epoch, { wallet: owner }).catch(() => null);
      if (!v || (!v.ok && /no extra leaf|not in/.test((v.reasons ?? []).join(' ')))) continue;
      await act('extra', e.epoch, extraDecision(v, { minClaimXnt: c.minClaimXnt }), () => mf.claimExtra(e.epoch, { wallet: owner }));
    }
  }
  if (c.withdrawVested) {
    for (const m of await mf.myMissions({ owner })) {
      const d = m.withdrawable > 0n ? { action: 'claim', reason: `${Number(m.withdrawable) / 1e9} XNT vested` } : { action: 'wait', reason: `vesting until ${m.endsAt}` };
      await act('vested', m.epoch, d, () => mf.withdrawVested(m));
    }
  }
  if (!out.length) log.info(`claims: nothing to claim for ${owner} in the last ${c.lastEpochs} epochs`);
  return out;
}
