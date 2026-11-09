// Artifacts: alerts by default; recycling and listing only for the assets the owner names in the config, within a
// daily count. An Artifact is an optional purchase, not a source of income. After the final upgrade an Artifact's extra
// pot rebate counts only burns whose X1 destination is the wallet that holds the Artifact, only in its first 52 weeks.
import { minimumListPrice } from './kit.mjs';

const WEEK = 7 * 86_400;
const XNT = 1e9;

/** Alerts for the Artifacts a wallet holds. Pure: artifacts from the kit's myArtifacts(); returns [text]. */
export function artifactAlerts(artifacts, { holder, x1Destination, now, rules }) {
  const out = [];
  for (const a of artifacts) {
    const id = String(a.asset?.toBase58?.() ?? a.asset);
    if (a.origin !== 0) continue; // Genesis and Forge Drops have no rebate and no floor beyond rent
    const ageWeeks = a.forgedAt ? (now - a.forgedAt) / WEEK : null;
    if (rules === 3 && ageWeeks !== null && ageWeeks >= 52) out.push(`${id}: forged more than 52 weeks ago, no longer counted by the extra pot; its floor (${a.backingXnt} XNT) comes back by recycling`);
    else if (rules === 3 && ageWeeks !== null && ageWeeks >= 48) out.push(`${id}: the extra pot stops counting it in ${Math.max(0, 52 - ageWeeks).toFixed(1)} weeks`);
    if (rules === 3 && x1Destination && holder !== x1Destination) out.push(`${id}: held by ${holder}, but your burns pay ${x1Destination}; the rebate counts only burns whose destination holds the Artifact`);
  }
  return out;
}

/** May this listing go out? Pure: the price must clear the program's minimum for the Artifact's floor. */
export function listingCheck(item, backingLamports) {
  const min = Number(minimumListPrice(BigInt(backingLamports))) / XNT;
  return item.priceXnt >= min ? { ok: true, minXnt: min } : { ok: false, minXnt: min, why: `price ${item.priceXnt} XNT is below the minimum ${min} XNT for its floor` };
}

/** One Artifacts pass. */
export async function artifactsTick({ mf, cfg, journal, live, log, tick }) {
  const a = cfg.artifacts;
  const mode = live ? 'live' : 'dry-run';
  const rules = await mf.rulesNow();
  const mine = await mf.myArtifacts();
  const now = await mf.chainTime();
  if (a.alerts) for (const t of artifactAlerts(mine, { holder: mf.me.toBase58(), x1Destination: cfg.x1Destination, now, rules })) log.warn(`artifact alert: ${t}`);
  const day = new Date().toISOString().slice(0, 10);
  const used = journal.data.artifacts.perDay[day] ?? { recycle: 0, list: 0 };
  const held = new Map(mine.map((m) => [m.asset.toBase58(), m]));

  if (a.recycle.enabled) {
    for (const asset of a.recycle.assets) {
      if (!held.has(asset)) continue;
      if (used.recycle >= a.recycle.maxPerDay) { log.decision({ tick, mode, artifact: asset, decision: 'WAIT', reason: 'daily recycle count reached' }); break; }
      if (!live) { log.decision({ tick, mode, artifact: asset, decision: 'RECYCLE', reason: `would take back the floor of ${held.get(asset).backingXnt} XNT` }); continue; }
      try { const r = await mf.recycleArtifact(asset); used.recycle += 1; log.decision({ tick, mode, artifact: asset, decision: 'RECYCLE', reason: `floor ${r.floorXnt} XNT`, tx: r.signature }); } catch (e) { log.decision({ tick, mode, artifact: asset, decision: 'ERROR', reason: String(e?.message ?? e).slice(0, 160) }); }
    }
  }
  if (a.listing.enabled && rules === 3) {
    for (const item of a.listing.items) {
      const m = held.get(item.asset);
      if (!m) continue;
      if (used.list >= a.listing.maxPerDay) { log.decision({ tick, mode, artifact: item.asset, decision: 'WAIT', reason: 'daily listing count reached' }); break; }
      const chk = listingCheck(item, Math.round(m.backingXnt * XNT));
      if (!chk.ok) { log.decision({ tick, mode, artifact: item.asset, decision: 'SKIP', reason: chk.why }); continue; }
      if (!live) { log.decision({ tick, mode, artifact: item.asset, decision: 'LIST', reason: `would list at ${item.priceXnt} XNT` }); continue; }
      try { await mf.listArtifact(item.asset, item.priceXnt); used.list += 1; log.decision({ tick, mode, artifact: item.asset, decision: 'LIST', reason: `${item.priceXnt} XNT` }); } catch (e) { log.decision({ tick, mode, artifact: item.asset, decision: 'ERROR', reason: String(e?.message ?? e).slice(0, 160) }); }
    }
  }
  journal.data.artifacts.perDay[day] = used;
  journal.save();
}
