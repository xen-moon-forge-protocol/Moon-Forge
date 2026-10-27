/**
 * Pure rules of the health check (no network, no secrets): epoch timing, wallet runway, vault
 * solvency and anomalies, price divergence, RPC and keeper freshness, Pages-vs-chain consistency.
 * health.ts feeds them live data; test/health.test.ts pins their thresholds.
 *
 * States: "fail" = the scheduled run goes red (something needs a human, or the protocol is not
 * paying what it owes); "warn" = visible in the table and the public snapshot, never red.
 *
 * The rows IMMUTABILITY.md promises before the 14-day stable count (vault invariants, reconciliation of every epoch,
 * oracle cadence, keeper service levels, site current, verification green, privileged-change pins, the K-5 chain
 * history, the extra pot, the stable-days streak) are at the end of this file. Rows that need the upgraded program
 * answer "n/a until upgrade" (state ok) while the live v2 binary is detected, and never fail before detection.
 */

import bs58 from "bs58";
import { keccak } from "./merkle";

export type State = "ok" | "warn" | "fail";
export interface Row { check: string; state: State; detail: string }

export const LAMPORTS = 1e9;
export const WEEK = 7 * 86_400;
const SUNDAY_0 = 3 * 86_400; // 1970-01-04 00:00 UTC, the first Sunday of Unix time
const xnt = (lamports: number, d = 4) => `${(lamports / LAMPORTS).toFixed(d)} XNT`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

// ── Weekly epoch ─────────────────────────────────────────────────────────────

/** Start (unix s) of the weekly slot that contains `now` (Sundays 00:00 UTC). */
export function slotStart(now: number): number {
  return now - ((now - SUNDAY_0) % WEEK);
}

/** The slot opened more than `graceH` hours ago and nothing was published since it opened. */
export function epochOverdue(lastPublishTs: number, now: number, graceH = 48): boolean {
  const slot = slotStart(now);
  return now - slot > graceH * 3600 && lastPublishTs < slot;
}

/** The newest oracle run whose epoch job ran (from the Actions API): when it finished and whether it succeeded. */
export interface OracleRun { ok: boolean; at: number }

/**
 * Verdict for the weekly epoch. `unpaid` = burns the portals registered after the last paid mission
 * (null = could not be determined). A late epoch with burns waiting is red, unless the oracle ran
 * successfully in this slot and still published nothing: then it saw those burns and found no value
 * to pay (dust, a tier it does not pay, a chain with no market), which is a quiet week like any other
 * and only warns (the program refuses empty epochs, and such burns stay "waiting" until a paying burn
 * lands on that chain, so counting them alone would page every week). No burn to pay also only warns.
 * Round 4: on the upgraded program (`upgraded`) a week with no burn publishes the heartbeat base epoch (budget 0) that
 * keeps the oracle seat alive, so an overdue slot with no burn warns that the heartbeat is missing (the oracle seat row
 * says how long the seat lasts); the live v2 binary refuses empty epochs and keeps the text as on main.
 */
export function epochVerdict(lastEpoch: number, lastPublishTs: number, now: number, unpaid: number | null, where = "", oracleRun: OracleRun | null = null, upgraded = false, v2Closed = false): Row {
  const lateH = Math.max(0, (now - slotStart(now)) / 3600);
  const last = lastPublishTs > 0 ? new Date(lastPublishTs * 1000).toISOString().slice(0, 16) + "Z" : "never";
  if (!epochOverdue(lastPublishTs, now)) {
    const pending = unpaid ? `, ${unpaid} burn(s) waiting for it` : "";
    return { check: "weekly epoch", state: "ok", detail: `epoch ${lastEpoch} published ${last}; next slot not overdue${pending}` };
  }
  // C-14 (r4-fix): past the v2 boundary on the v2 binary the oracle publishes no v2 epoch by design (flow-v3.ts v2ClosedV3)
  if (!upgraded && v2Closed) {
    const waiting = unpaid ? `; ${unpaid} burn(s) waiting${where ? ` on ${where}` : ""}` : unpaid === null ? "; burns waiting: unknown" : "";
    return { check: "weekly epoch", state: "warn", detail: `v2 closed at the boundary: later burns wait for the first v3 epoch with their own time. The final upgrade (S6) is not live yet, so nothing is published after epoch ${lastEpoch} (${last})${waiting}` };
  }
  if (unpaid === null) return { check: "weekly epoch", state: "warn", detail: `epoch ${lastEpoch + 1} not published ${lateH.toFixed(0)} h into its slot (last ${last}); burns waiting: unknown (portal reads failed)` };
  if (unpaid > 0) {
    const ranThisSlot = !!oracleRun && oracleRun.at >= slotStart(now);
    if (ranThisSlot && oracleRun!.ok) {
      const when = new Date(oracleRun!.at * 1000).toISOString().slice(0, 16) + "Z";
      return { check: "weekly epoch", state: "warn", detail: `${unpaid} burn(s) registered after the last paid one${where ? ` on ${where}` : ""}, but the oracle run of ${when} published nothing: either no value to pay (dust, a tier it does not pay, or no market; such burns stay listed until a paying burn lands on that chain) or they landed after that run (the next slot pays them)` };
    }
    const why = ranThisSlot ? "the oracle run in this slot failed" : "no oracle run finished in this slot";
    return { check: "weekly epoch", state: "fail", detail: `epoch ${lastEpoch + 1} is late: ${unpaid} burn(s) waiting${where ? ` on ${where}` : ""}, slot opened ${lateH.toFixed(0)} h ago (last ${last}); ${why}` };
  }
  if (upgraded) return { check: "weekly epoch", state: "warn", detail: `quiet week: no burn since epoch ${lastEpoch} (${last}), but the heartbeat epoch ${lastEpoch + 1} (budget 0, it keeps the oracle seat alive) is not published ${lateH.toFixed(0)} h into its slot` };
  return { check: "weekly epoch", state: "warn", detail: `quiet week: no burn since epoch ${lastEpoch} (${last}), nothing to publish` };
}

// ── Wallets ──────────────────────────────────────────────────────────────────

/** Epochs the balance still pays for, from the sampled per-epoch costs (mean) or a fallback estimate. */
export function runway(balanceLamports: number, costs: number[], fallbackCost: number): { epochs: number; cost: number } {
  const valid = costs.filter((c) => c > 0);
  const cost = valid.length ? valid.reduce((s, c) => s + c, 0) / valid.length : fallbackCost;
  return { epochs: cost > 0 ? balanceLamports / cost : Infinity, cost };
}

/** The window of a publication run around its publish transaction: 1 h before it, 6 h after it (seal, claims, extras). */
export const EPOCH_COST_BEFORE_S = 3600;
export const EPOCH_COST_AFTER_S = 6 * 3600;
/** A publication: its epoch and the chain time of its publish transaction (the file's createdAt when unreadable). */
export interface PublicationTime { epoch: number; at: number }
/** One transaction of the oracle wallet: chain time, lamports it took from the wallet (negative = it paid the wallet),
 * and whether it ran the Moon Forge program. */
export interface WalletTx { blockTime: number; spent: number; program: boolean }
/**
 * The cost of each publication run, measured on the oracle wallet's own transactions, all on the chain clock:
 *  - only transactions that ran the Moon Forge program count. A plain transfer in or out (a top-up by the owner, a
 *    withdrawal) changes the balance, which the runway already divides, not what an epoch costs;
 *  - each one counts once: for the latest publication at or before it, within EPOCH_COST_AFTER_S, else for the next
 *    publication within EPOCH_COST_BEFORE_S.
 * Weekly publications are days apart, so every window is the fixed [−1 h, +6 h] around its publication. On a local
 * validator whose epochs come seconds apart (DAY = 1 s), each run keeps exactly its own transactions instead of every
 * window covering the whole run. `publications` lists every publication known (older ones bound the windows);
 * the result has one cost per entry of `epochs`, 0 when nothing was measured.
 */
export function epochCostsOf(publications: PublicationTime[], txs: WalletTx[], epochs: number[]): number[] {
  const pubs = publications.filter((p) => Number.isFinite(p.at)).sort((a, b) => a.at - b.at || a.epoch - b.epoch);
  const cost = new Map<number, number>(epochs.map((e) => [e, 0]));
  for (const tx of txs) {
    if (!tx.program || !Number.isFinite(tx.blockTime)) continue;
    let owner: PublicationTime | undefined;
    for (const p of pubs) if (p.at <= tx.blockTime && tx.blockTime - p.at <= EPOCH_COST_AFTER_S) owner = p;
    if (!owner) owner = pubs.find((p) => p.at > tx.blockTime && p.at - tx.blockTime <= EPOCH_COST_BEFORE_S);
    if (owner && cost.has(owner.epoch)) cost.set(owner.epoch, cost.get(owner.epoch)! + tx.spent);
  }
  return epochs.map((e) => cost.get(e)!);
}

export const ORACLE_MIN_LAMPORTS = 0.05 * LAMPORTS; // Epoch account rent + a few fees
export const KEEPER_MIN_LAMPORTS = 0.05 * LAMPORTS; // ~25 transactions at X1's base fee

/** Red below 4 epochs (about a month) of measured cost or below the hard floor; warns below 12. */
export function oracleWalletVerdict(balanceLamports: number, costs: number[], fallbackCost: number): Row {
  const r = runway(balanceLamports, costs, fallbackCost);
  const sampled = costs.filter((c) => c > 0).length;
  const basis = sampled ? `measured over ${sampled} epoch(s)` : "estimated";
  const detail = `${xnt(balanceLamports)}; ${xnt(r.cost)} per epoch ${basis} → ${r.epochs === Infinity ? "∞" : r.epochs.toFixed(0)} epochs of runway`;
  if (balanceLamports < ORACLE_MIN_LAMPORTS || r.epochs < 4) return { check: "oracle wallet", state: "fail", detail: `${detail} (alert below 4 epochs or ${xnt(ORACLE_MIN_LAMPORTS, 2)})` };
  if (r.epochs < 12) return { check: "oracle wallet", state: "warn", detail: `${detail} (top up before it reaches 4)` };
  return { check: "oracle wallet", state: "ok", detail };
}

/** A12 (P11): a burst of dust leaves (no keeper tip) costs the oracle rent per claim; above this many it is flagged */
export const DUST_CLAIMS_WARN = 200;
/**
 * The last v3 epoch's claims, as the oracle recorded them after claimLeavesV3 (A12): failed claims are red (the keeper
 * retries them, a person should look), many dust claims are amber (each costs the oracle wallet rent and a fee).
 */
export function claimsVerdict(epoch: number, claims: { tipped: number; dust: number; claimed?: number; failed?: number; heldUntil?: number } | undefined | null, dustWarn = DUST_CLAIMS_WARN): Row | null {
  if (!claims) return null;
  // upgraded program: the publish run claims nothing inside the 48-h hold; the keeper claims every leaf after it
  if (claims.claimed === undefined && typeof claims.heldUntil === "number") {
    return { check: "auto-claims", state: "ok", detail: `epoch ${epoch}: claims held until ${new Date(claims.heldUntil * 1000).toISOString()} (48-h hold; ${claims.tipped} tipped, ${claims.dust} dust planned); the keeper claims every leaf after it` };
  }
  if (claims.claimed === undefined) return { check: "auto-claims", state: "warn", detail: `epoch ${epoch}: only the claim plan is recorded (${claims.tipped} tipped, ${claims.dust} dust): the claims did not report` };
  const detail = `epoch ${epoch}: ${claims.claimed} claimed (${claims.tipped} tipped, ${claims.dust} dust), ${claims.failed ?? 0} failed`;
  if ((claims.failed ?? 0) > 0) return { check: "auto-claims", state: "fail", detail };
  if (claims.dust > dustWarn) return { check: "auto-claims", state: "warn", detail: `${detail} (more than ${dustWarn} dust claims: each costs the oracle wallet rent)` };
  return { check: "auto-claims", state: "ok", detail };
}

export function keeperWalletVerdict(balanceLamports: number): Row {
  const detail = `${xnt(balanceLamports)} (alert below ${xnt(KEEPER_MIN_LAMPORTS, 2)}; it earns tips from the pool)`;
  if (balanceLamports < KEEPER_MIN_LAMPORTS) return { check: "keeper wallet", state: "fail", detail };
  if (balanceLamports < 3 * KEEPER_MIN_LAMPORTS) return { check: "keeper wallet", state: "warn", detail };
  return { check: "keeper wallet", state: "ok", detail };
}

// ── Vaults ───────────────────────────────────────────────────────────────────

/** vault lamports − rent must cover what the program has promised (reward_reserved / bankroll_reserved). */
export function solvencyVerdict(name: string, lamports: number, rent: number, reserved: number): Row {
  const free = lamports - rent - reserved;
  if (lamports < rent) return { check: name, state: "fail", detail: `${xnt(lamports)} is below rent (${xnt(rent)}): the vault can be garbage-collected` };
  if (free < 0) return { check: name, state: "fail", detail: `insolvent: ${xnt(lamports)} − rent ${xnt(rent)} < reserved ${xnt(reserved)}` };
  return { check: name, state: "ok", detail: `${xnt(free)} free (${xnt(lamports)} − rent − ${xnt(reserved)} reserved)` };
}

/** Config.reward_reserved must equal what the open epochs still owe (budget − claimed + unpaid drop reserve). */
export function reservedVerdict(reserved: bigint, expected: bigint): Row {
  const diff = reserved > expected ? reserved - expected : expected - reserved;
  const tol = expected / 100n > 1_000_000n ? expected / 100n : 1_000_000n; // 1% or 0.001 XNT
  const detail = `Config.reward_reserved ${xnt(Number(reserved))} vs Σ open epochs ${xnt(Number(expected))}`;
  if (diff === 0n) return { check: "reserved accounting", state: "ok", detail };
  return { check: "reserved accounting", state: diff > tol ? "fail" : "warn", detail: `${detail} (off by ${xnt(Number(diff), 6)})` };
}

export interface VaultPrev { lamports: number; at: number }

/**
 * A drop of more than `maxDrop` (fraction) since the previous snapshot that the stats counters do not
 * explain (claims, prizes, LP exits) is red. Only snapshots younger than 36 h are compared.
 */
export function vaultDropVerdict(name: string, lamports: number, prev: VaultPrev | null, explained: number, now: number, maxDrop = 0.2): Row {
  if (!prev || now - prev.at > 36 * 3600 || prev.lamports <= 0) return { check: name, state: "ok", detail: `${xnt(lamports)} (no snapshot of the last 36 h to compare with)` };
  const drop = prev.lamports - lamports;
  const unexplained = drop - Math.max(0, explained);
  const hours = ((now - prev.at) / 3600).toFixed(0);
  if (unexplained > maxDrop * prev.lamports) {
    return { check: name, state: "fail", detail: `fell ${xnt(drop)} (${pct(drop / prev.lamports)}) in ${hours} h, ${xnt(unexplained)} of it not explained by claims, prizes or LP exits` };
  }
  const sign = drop > 0 ? "−" : "+";
  return { check: name, state: "ok", detail: `${xnt(lamports)} (${sign}${xnt(Math.abs(drop))} in ${hours} h${explained > 0 ? `, ${xnt(explained)} explained` : ""})` };
}

/** The program's own circuit breaker reference: bankroll value at the start of the current day. */
export function bankrollDayVerdict(valueNow: number, dayStart: number, bankrollDay: number, now: number): Row {
  const today = Math.floor(now / 86_400);
  if (bankrollDay !== today || dayStart <= 0) return { check: "bankroll today", state: "ok", detail: `no house bet today (day reference ${bankrollDay ? new Date(bankrollDay * 86_400_000).toISOString().slice(0, 10) : "unset"})` };
  const ratio = valueNow / dayStart;
  const detail = `${xnt(valueNow)} vs ${xnt(dayStart)} at day start (${pct(ratio - 1)})`;
  if (ratio < 0.8) return { check: "bankroll today", state: "fail", detail: `${detail}: more than 20% lost today` };
  if (ratio < 0.9) return { check: "bankroll today", state: "warn", detail: `${detail}: circuit breaker tripped (bets refused until tomorrow)` };
  return { check: "bankroll today", state: "ok", detail };
}

// ── Prices ───────────────────────────────────────────────────────────────────

export function median(xs: number[]): number {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Largest relative deviation of any source from the median of all sources (0 when fewer than 2). */
export function divergence(prices: number[]): number {
  const v = prices.filter((x) => x > 0);
  if (v.length < 2) return 0;
  const m = median(v);
  return Math.max(...v.map((p) => Math.abs(p - m) / m));
}

/** XNT price sources must agree within `maxPct`; fewer than two answering sources only warns. */
export function priceVerdict(sources: Record<string, number | null>, maxPct = 5): Row {
  const live = Object.entries(sources).filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0);
  const down = Object.entries(sources).filter(([, v]) => !(typeof v === "number" && v > 0)).map(([k]) => k);
  const list = live.map(([k, v]) => `${k} $${v.toFixed(4)}`).join(", ");
  const downNote = down.length ? `; unavailable: ${down.join(", ")}` : "";
  if (live.length < 2) return { check: "XNT price sources", state: "warn", detail: `cannot cross-check: ${list || "no source answered"}${downNote}` };
  const d = divergence(live.map(([, v]) => v));
  const detail = `${list}; max deviation from median ${pct(d)}${downNote}`;
  if (d * 100 > maxPct) return { check: "XNT price sources", state: "fail", detail: `${detail} (limit ${maxPct}%)` };
  return { check: "XNT price sources", state: "ok", detail };
}

// ── EVM RPCs ─────────────────────────────────────────────────────────────────

export interface RpcProbe { host: string; ok: boolean; ageS?: number; code?: boolean; error?: string }

/** Every live chain needs one fresh RPC that serves the portal's code; a fallback in use or a single survivor warns. */
export function rpcVerdict(chain: string, probes: RpcProbe[], staleS = 900): Row {
  const check = `rpc ${chain}`;
  const fresh = probes.map((p, i) => ({ ...p, i })).filter((p) => p.ok && (p.ageS ?? Infinity) <= staleS && p.code !== false);
  const summary = probes.map((p) => `${p.host}:${p.ok ? (p.code === false ? "no portal code" : (p.ageS ?? 0) > staleS ? `stale ${Math.round((p.ageS ?? 0) / 60)} min` : "ok") : "down"}`).join(", ");
  if (!fresh.length) {
    const stale = probes.filter((p) => p.ok);
    return { check, state: "fail", detail: stale.length ? `no fresh RPC (${summary})` : `every RPC failed (${summary})` };
  }
  const used = fresh[0];
  if (used.i > 0) return { check, state: "warn", detail: `primary down, using fallback #${used.i + 1} ${used.host} (${summary})` };
  if (fresh.length === 1 && probes.length > 1) return { check, state: "warn", detail: `only one RPC answers (${summary})` };
  return { check, state: "ok", detail: `${fresh.length}/${probes.length} RPCs fresh, using ${used.host}` };
}

// ── Automation ───────────────────────────────────────────────────────────────

/** GitHub fires a few percent of the keeper's cron ticks (gaps of 2–10 h seen), so a day without a run is the alarm, not half of one. */
export function keeperFreshnessVerdict(ageH: number, maxH = 24): Row {
  if (ageH > maxH) return { check: "keeper freshness", state: "fail", detail: `no keeper run finished in ${ageH.toFixed(0)} h (limit ${maxH} h)` };
  if (ageH > maxH / 2) return { check: "keeper freshness", state: "warn", detail: `last keeper run ${ageH.toFixed(1)} h ago (red after ${maxH} h)` };
  return { check: "keeper freshness", state: "ok", detail: `last keeper run ${ageH.toFixed(1)} h ago` };
}

/** X1 targets 400 ms slots (the ~512-slot hash window is "about 3 minutes"). */
export const SLOT_S = 0.4;
/** An expired house bet still open this long after its target means the keeper has not passed for longer than its usual gap. */
export const EXPIRED_BET_RED_H = 12;

/** Hours since a target slot, from the current slot. */
export function slotAgeH(slotNow: number, targetSlot: number): number {
  return Math.max(0, (slotNow - targetSlot) * SLOT_S) / 3600;
}

/** The publishing token only matters while a human still pushes; after walk-away nothing uses it, so it never fails. */
export function patVerdict(exp: string | undefined, now: number): Row | null {
  if (!exp) return null;
  const days = Math.floor((Date.parse(`${exp}T00:00:00Z`) / 1000 - now) / 86_400);
  if (Number.isNaN(days)) return { check: "publishing token", state: "warn", detail: `PAT_EXPIRES "${exp}" is not YYYY-MM-DD` };
  return { check: "publishing token", state: days > 14 ? "ok" : "warn", detail: `expires ${exp} (${days} days left; only manual pushes use it, the automation does not)` };
}

// ── Pages vs chain ───────────────────────────────────────────────────────────

export interface EpochRef { epoch: number; root: string; dataHash: string }

/** The served epochs/index.json must list every on-chain epoch with the same root and data hash, and the newest file must match too. */
export function pagesVerdict(onChain: EpochRef[], index: EpochRef[] | null, latestFile: EpochRef | null): Row {
  if (!index) return { check: "pages epochs", state: "fail", detail: "epochs/index.json not served by GitHub Pages" };
  const problems: string[] = [];
  for (const e of onChain) {
    const i = index.find((x) => x.epoch === e.epoch);
    if (!i) problems.push(`epoch ${e.epoch} missing from index.json`);
    else if (i.root !== e.root || i.dataHash !== e.dataHash) problems.push(`epoch ${e.epoch}: index.json root/dataHash differ from chain`);
  }
  for (const i of index) if (!onChain.find((e) => e.epoch === i.epoch)) problems.push(`epoch ${i.epoch} listed but not on-chain`);
  const newest = onChain.reduce((m, e) => Math.max(m, e.epoch), 0);
  if (newest > 0) {
    const e = onChain.find((x) => x.epoch === newest)!;
    if (!latestFile) problems.push(`epoch-${newest}.json not served`);
    else if (latestFile.root !== e.root || latestFile.dataHash !== e.dataHash) problems.push(`epoch-${newest}.json root/dataHash differ from chain`);
  }
  if (problems.length) return { check: "pages epochs", state: "fail", detail: problems.join("; ") };
  return { check: "pages epochs", state: "ok", detail: `${onChain.length} epoch(s) on-chain, all served with matching root and data hash` };
}

// ── Privileged state ─────────────────────────────────────────────────────────

export function oracleRoleVerdict(oracle: string, expected: string, pending: string, defaultKey: string): Row {
  if (oracle !== expected) return { check: "oracle key", state: "fail", detail: `Config.oracle is ${oracle}, expected ${expected}` };
  if (pending !== defaultKey) return { check: "oracle key", state: "fail", detail: `hand-over pending to ${pending}: accept it or re-propose (a leaked key would start like this)` };
  return { check: "oracle key", state: "ok", detail: `${oracle.slice(0, 8)}…, no hand-over pending` };
}

export interface ProgramAuth { authority: string | null; lastDeploySlot: number }

/** The upgrade authority must be the architect (before the burn) or none (after); any change or redeploy is reported. */
export function authorityVerdict(now: ProgramAuth, prev: ProgramAuth | null, architect: string): Row {
  const who = now.authority ? (now.authority === architect ? "architect" : now.authority) : "none (burned)";
  const base = `upgrade authority ${who}, last deploy slot ${now.lastDeploySlot}`;
  if (now.authority && now.authority !== architect) return { check: "program authority", state: "fail", detail: `${base}: unexpected authority` };
  if (prev && prev.authority !== now.authority) return { check: "program authority", state: "fail", detail: `${base}: changed since the previous snapshot (${prev.authority ?? "none"})` };
  if (prev && prev.lastDeploySlot !== now.lastDeploySlot) return { check: "program authority", state: "warn", detail: `${base}: program redeployed since the previous snapshot (slot ${prev.lastDeploySlot})` };
  return { check: "program authority", state: "ok", detail: base };
}

/** Upkeep the keeper should already have done. `lost` items cost someone money (red); `late` ones only warn. */
export function backlogVerdict(lost: string[], late: string[]): Row {
  if (lost.length) return { check: "keeper backlog", state: "fail", detail: `${lost.join("; ")}${late.length ? `; also late: ${late.join("; ")}` : ""}` };
  if (late.length) return { check: "keeper backlog", state: "warn", detail: late.join("; ") };
  return { check: "keeper backlog", state: "ok", detail: "nothing overdue on-chain" };
}

// ── Automation switches ──────────────────────────────────────────────────────

/**
 * KEEPER_ENABLED / ORACLE_ENABLED gate the jobs: anything but "true" skips every run. Undefined (not in Actions) is
 * not judged; empty (the workflow always passes the variable, so a deleted one arrives as "") is a deliberate stop
 * and warns, since the keeper-freshness and weekly-epoch rows already say what that stop costs; any other value
 * is most likely a typo ("True", "yes") and is red.
 */
export function automationVerdict(name: string, value: string | undefined): Row | null {
  if (value === undefined) return null;
  if (value === "true") return { check: name, state: "ok", detail: "repository variable is true" };
  if (value === "") return { check: name, state: "warn", detail: "repository variable is not set: every run of that workflow is skipped" };
  return { check: name, state: "fail", detail: `repository variable is "${value}" (needs "true"): every run of that workflow is skipped` };
}

// ── Reserved accounting input ────────────────────────────────────────────────

export interface EpochAccount { closed: boolean; budget: bigint; claimed: bigint; dropReserve: bigint; dropPaid: bigint; dropState: number }

/** What the open epochs still owe: budget − claimed, plus the unpaid drop reserve while the drop is pending (1) or sealed (2). */
export function expectedReserved(epochs: EpochAccount[]): bigint {
  let sum = 0n;
  for (const e of epochs) {
    if (e.closed) continue;
    if (e.budget > e.claimed) sum += e.budget - e.claimed;
    if ((e.dropState === 1 || e.dropState === 2) && e.dropReserve > e.dropPaid) sum += e.dropReserve - e.dropPaid;
  }
  return sum;
}

// ── Explained outflows ───────────────────────────────────────────────────────

export type Counters = Record<string, string | number>;

/** Growth of the named lifetime counters since the previous snapshot (lamports); a counter that went down counts 0. */
export function statsDelta(prev: Counters | undefined, now: Counters, keys: string[]): number {
  if (!prev) return 0;
  let sum = 0;
  for (const k of keys) {
    const d = Number(now[k] ?? 0) - Number(prev[k] ?? 0);
    if (d > 0) sum += d;
  }
  return sum;
}

/** Bankroll value that left with LPs: the share of the previous value matching the house shares that disappeared. */
export function lpExitExplained(prevShares: number, nowShares: number, prevValue: number): number {
  if (!(prevShares > 0) || !(nowShares < prevShares)) return 0;
  return Math.round(((prevShares - nowShares) / prevShares) * prevValue);
}

// ── BPF upgradeable loader ───────────────────────────────────────────────────

/** ProgramData account: u32 tag 3 | u64 last deploy slot | Option<Pubkey> upgrade authority (1 + 32 bytes). */
export function parseProgramData(data: Uint8Array): ProgramAuth {
  const d = Buffer.from(data);
  if (d.length < 13) throw new Error("programdata account too short");
  const tag = d.readUInt32LE(0);
  if (tag !== 3) throw new Error(`not a ProgramData account (tag ${tag})`);
  const lastDeploySlot = Number(d.readBigUInt64LE(4));
  if (d[12] === 0) return { authority: null, lastDeploySlot };
  if (d.length < 45) throw new Error("programdata account too short for an authority");
  return { authority: bs58.encode(d.subarray(13, 45)), lastDeploySlot };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Stable-count rows (IMMUTABILITY.md "When the upgrade authority will be burned", item 3)
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** The W2-4 detection verdict (x1-v3.ts upgradeVerdictV3): "legacy" = the live v2 binary, "upgraded" = the final binary. */
export type Detection = "legacy" | "upgraded" | "unknown";
const NA = "n/a until upgrade (the live v2 binary is detected)";
/** A row that needs the upgraded program: n/a (ok) on the v2 binary, a warning when detection is unknown. */
export function naUntilUpgrade(check: string, detection: Detection, why = ""): Row | null {
  if (detection === "legacy") return { check, state: "ok", detail: NA };
  if (detection === "unknown") return { check, state: "warn", detail: `not checked: the program version is unknown${why ? ` (${why})` : ""}` };
  return null;
}

/** The program version row: which rules the chain runs; a half-done upgrade or an unreadable probe only warns. */
export function detectionVerdict(detection: Detection, deploySlot: number | null, reasons: string[] = []): Row {
  if (detection === "legacy") return { check: "program version", state: "ok", detail: `live v2 binary (deploy slot ${deploySlot}); rows that need the upgrade say n/a` };
  if (detection === "upgraded") return { check: "program version", state: "ok", detail: `upgraded binary detected (deploy slot ${deploySlot}): v3 rows are live` };
  return { check: "program version", state: "warn", detail: `unknown: ${reasons.join("; ").slice(0, 300) || "probe unreadable"}` };
}

// ── X1 RPC endpoints (owner sheet 9.2: X1_RPC_URLS) ──────────────────────────────────────────────────────────────────

export interface X1RpcProbe { host: string; ok: boolean; genesisOk?: boolean; error?: string }

/** Every configured X1 endpoint (X1_RPC_URLS, then the default): none healthy is red; a listed one down or on another cluster warns. */
export function x1RpcVerdict(probes: X1RpcProbe[], withPath = 0): Row {
  const check = "X1 RPCs";
  const good = probes.filter((p) => p.ok && p.genesisOk !== false);
  const summary = probes.map((p) => `${p.host}:${!p.ok ? "down" : p.genesisOk === false ? "other cluster" : "ok"}`).join(", ");
  if (!good.length) return { check, state: "fail", detail: `no X1 endpoint answers on X1 mainnet (${summary})` };
  // R-8: X1_RPC_URLS is a repository variable, printed in the public run logs: a path or a query may carry a key
  const keyed = withPath
    ? `; ${withPath} X1_RPC_URLS entr${withPath === 1 ? "y has" : "ies have"} a path or a query: repository variables appear in the public run logs, so only keyless endpoints belong there (a keyed one goes in the X1_RPC_URL secret)`
    : "";
  if (good.length < probes.length) return { check, state: "warn", detail: `${good.length}/${probes.length} endpoints usable (${summary}); the oracle and keeper skip the others${keyed}` };
  if (withPath) return { check, state: "warn", detail: `${probes.length} endpoint(s), all on X1 mainnet (${summary})${keyed}` };
  return { check, state: "ok", detail: `${probes.length} endpoint(s), all on X1 mainnet (${summary})` };
}

/** R-4: the next unrevealed keeper position holds an anchored bet this many slots old: amber (~10 min), red (~1 h). */
export const REVEAL_STALL_WARN_SLOTS = 1_600;
export const REVEAL_STALL_RED_SLOTS = 9_700;
/**
 * R-4: the keeper seat's holder settles an anchored bet within seconds. When the bet at the next position (index ==
 * HouseKeeper.revealed) is anchored and still pending long after its anchor slot, the holder is down or holds a chain
 * its key cannot derive (no key is needed to see it): every anchored bet then becomes refundable as a WIN paid from the
 * bond after KEEPER_STALL_SLOTS (~26 h), and an attacker can farm that. `next` = that bet's anchor slot, null when the
 * next position holds no anchored bet.
 */
export function keeperRevealVerdict(detection: Detection, seat: { revealed: number; nextIndex: number } | null, next: { anchorSlot: number } | null, slot: number): Row {
  const check = "keeper reveals";
  const na = naUntilUpgrade(check, detection);
  if (na) return na;
  if (!seat) return { check, state: "ok", detail: "no keeper seat yet" };
  if (!next) return { check, state: "ok", detail: `nothing anchored waits at the next position (${seat.revealed} revealed of ${seat.nextIndex} handed out)` };
  const age = slot - next.anchorSlot;
  const mins = Math.round((age * 0.37) / 60);
  const detail = `the bet at position ${seat.revealed} is anchored and not revealed ${age} slots (~${mins} min) after its anchor block: the holder is down or cannot derive the seat's chain (R-4); anchored bets become refundable as a WIN paid from the bond after ~26 h. Run \`npm run keeper -- --once\` with the seat's key and check the role`;
  if (age > REVEAL_STALL_RED_SLOTS) return { check, state: "fail", detail };
  if (age > REVEAL_STALL_WARN_SLOTS) return { check, state: "warn", detail };
  return { check, state: "ok", detail: `the next position's bet was anchored ${age} slots ago: within the holder's usual delay` };
}

// ── Vault invariants: every escrow account against what the program owes from it ────────────────────────────────────

export interface Escrow { name: string; lamports: number; rent: number; owed: number }

/** Game escrows (player game wallets, open Jackpot / Prediction pots, seat bonds): lamports − rent must cover what is owed. */
export function escrowVerdict(check: string, items: Escrow[]): Row {
  const short = items.filter((e) => e.lamports - e.rent < e.owed);
  const owed = items.reduce((s, e) => s + e.owed, 0);
  if (short.length) {
    const list = short.slice(0, 5).map((e) => `${e.name} holds ${xnt(e.lamports - e.rent)} above rent, owes ${xnt(e.owed)}`).join("; ");
    return { check, state: "fail", detail: `${short.length} of ${items.length} account(s) cannot cover what they owe: ${list}${short.length > 5 ? "; …" : ""}` };
  }
  return { check, state: "ok", detail: `${items.length} account(s) cover ${xnt(owed)} owed` };
}

// ── Reconciliation of every published epoch ──────────────────────────────────────────────────────────────────────────

export interface EpochOnChain { id: number; budget: bigint; claimed: bigint; claims: number; leaves: number; closed: boolean; root: string; dataHash: string; totalScore: bigint }
export interface EpochFileRef { epoch: number; root: string; dataHash: string; leaves: number; totalScore: string; budget: string | null }

/**
 * Every published epoch: claimed + unclaimed (open) + expired (closed) = budget with no negative part, the file in git
 * says what the chain says (root, data hash, leaves, total score, the budget recorded at publication), and the
 * lifetime counter Stats.forge_paid equals the sum of the epochs' claimed amounts (forge.rs adds the same amount to both).
 */
export function reconcileVerdict(chain: EpochOnChain[], files: EpochFileRef[], forgePaid: bigint): Row {
  const check = "epoch reconciliation";
  const problems: string[] = [];
  let budget = 0n, claimed = 0n, unclaimed = 0n, expired = 0n;
  for (const e of chain) {
    if (e.claimed > e.budget) problems.push(`epoch ${e.id}: claimed ${xnt(Number(e.claimed))} above its budget ${xnt(Number(e.budget))}`);
    if (e.claims > e.leaves) problems.push(`epoch ${e.id}: ${e.claims} claims for ${e.leaves} leaves`);
    const rest = e.budget > e.claimed ? e.budget - e.claimed : 0n;
    budget += e.budget;
    claimed += e.claimed;
    if (e.closed) expired += rest;
    else unclaimed += rest;
    const f = files.find((x) => x.epoch === e.id);
    if (!f) { problems.push(`epoch ${e.id}: no epoch-${e.id}.json in the repository`); continue; }
    if (f.root !== e.root || f.dataHash !== e.dataHash) problems.push(`epoch ${e.id}: the file's root/data hash differ from the chain`);
    if (f.leaves !== e.leaves) problems.push(`epoch ${e.id}: ${f.leaves} leaves in the file, ${e.leaves} on chain`);
    if (BigInt(f.totalScore) !== e.totalScore) problems.push(`epoch ${e.id}: total score differs from the chain`);
    if (f.budget !== null && BigInt(f.budget) !== e.budget) problems.push(`epoch ${e.id}: the recorded budget ${f.budget} is not the chain's ${e.budget}`);
  }
  for (const f of files) if (!chain.find((e) => e.id === f.epoch)) problems.push(`epoch-${f.epoch}.json has no Epoch account on chain`);
  if (forgePaid !== claimed) problems.push(`Stats.forge_paid ${xnt(Number(forgePaid))} ≠ Σ claimed ${xnt(Number(claimed))}`);
  const sums = `${chain.length} epoch(s): budget ${xnt(Number(budget))} = claimed ${xnt(Number(claimed))} + unclaimed ${xnt(Number(unclaimed))} + expired ${xnt(Number(expired))}`;
  if (problems.length) return { check, state: "fail", detail: `${problems.join("; ")} (${sums})` };
  return { check, state: "ok", detail: `${sums}; every file matches the chain` };
}

// ── Oracle cadence: seat liveness and the 28-day dead-seat clock ─────────────────────────────────────────────────────

/** keeper-v3.ts SeatLivenessV3 (oracleSeatLivenessV3, the mirror of seat.rs walk_is_dead). */
export interface SeatLiveness { deadAt: number; publishBy: number; state: "ok" | "warn" | "critical" | "dead"; detail: string }

/** The oracle seat: "critical" (an epoch published now could no longer save it) and "dead" are red; 10 days before, amber. */
export function oracleSeatVerdict(detection: Detection, seat: { liveness: SeatLiveness; openSince: number; generation: number } | null): Row {
  const check = "oracle seat";
  const na = naUntilUpgrade(check, detection);
  if (na) return na;
  if (!seat) return { check, state: "fail", detail: "the upgraded program is detected but OracleSeat does not decode" };
  const l = seat.liveness;
  const gen = `generation ${seat.generation}`;
  if (l.state === "dead" || l.state === "critical") return { check, state: "fail", detail: `${gen}: ${l.detail}` };
  if (seat.openSince > 0) return { check, state: "warn", detail: `${gen}: the seat is open since ${new Date(seat.openSince * 1000).toISOString().slice(0, 10)} (resigned); ${l.detail}` };
  return { check, state: l.state === "warn" ? "warn" : "ok", detail: `${gen}: ${l.detail}` };
}

// ── Oracle publications in their hold: a foreign publisher (round 4, quiet-month seat default) ───────────────────────

/** CLAIM_HOLD (constants.rs): every epoch (base and extra) can be voided during the 48 h after its publication. */
export const VOID_HOLD_S = 2 * 86_400;
/**
 * The oracle workflow commits epoch-<n>.json (extra-<n>.json) right after publishing it; a publication this recent with no
 * file in the repository is "pending" (amber), not yet "foreign" (red).
 */
export const FOREIGN_GRACE_S = 2 * 3_600;

/** One base or extra epoch on chain, with the data hash of the repository's file of the same id (null = no file). */
export interface PublicationView {
  kind: "base" | "extra";
  id: number;
  publishedAt: number;
  closed: boolean;
  dataHash: string;
  /** the data hash of epoch-<id>.json / extra-<id>.json in this checkout, null when there is none */
  local: string | null;
  /** the bond a voider other than the cold key posts (seat.rs void_required: max(0.05 XNT, 10% of the full budget); 1 XNT for a heartbeat, r4-fix) */
  bond: bigint;
}

/**
 * What one publication is (pure): "ours" = the repository holds the file with exactly its data hash; "pending" = no file
 * yet, published less than FOREIGN_GRACE_S ago (the commit follows the publication); "foreign" = no file after the grace
 * (someone else published it: a stolen hot key or a taken seat); "differs" = the repository's file of that id has another
 * data hash. Only a publication still inside its 48-h hold can be voided; after it, a foreign one is only reported.
 */
export function publicationClassOf(p: PublicationView, now: number): { cls: "ours" | "pending" | "foreign" | "differs"; voidable: boolean; voidBy: number } {
  const voidBy = p.publishedAt + VOID_HOLD_S;
  const voidable = !p.closed && now < voidBy;
  if (p.local !== null && p.local === p.dataHash) return { cls: "ours", voidable, voidBy };
  if (p.local !== null) return { cls: "differs", voidable, voidBy };
  return { cls: now - p.publishedAt < FOREIGN_GRACE_S ? "pending" : "foreign", voidable, voidBy };
}

/**
 * The oracle publications still inside their 48-h hold (upgraded program only): a publication the repository does not hold
 * (a foreign publisher) or holds with another data hash is red, with the deadline and the command that voids it; one
 * just published whose file is not committed yet is amber; every other one is listed as ours. Outside the hold nothing
 * can be voided any more (the epoch reconciliation row reports those).
 */
export function oraclePublicationsVerdict(detection: Detection, pubs: PublicationView[], now: number): Row {
  const check = "oracle publications";
  const na = naUntilUpgrade(check, detection);
  if (na) return na;
  const inHold = pubs.filter((p) => publicationClassOf(p, now).voidable).sort((a, b) => a.id - b.id || a.kind.localeCompare(b.kind));
  if (!inHold.length) return { check, state: "ok", detail: "no epoch is inside its 48-h hold (nothing to void)" };
  const at = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const name = (p: PublicationView) => `${p.kind === "extra" ? "extra epoch" : "epoch"} ${p.id}`;
  const bad: string[] = [];
  const wait: string[] = [];
  const ours: string[] = [];
  for (const p of inHold) {
    const c = publicationClassOf(p, now);
    const cmd = `npm run void-epoch -- ${p.id}${p.kind === "extra" ? " --extra" : ""} --yes (bond ${xnt(Number(p.bond))}; free for the seat's cold key)`;
    if (c.cls === "foreign") bad.push(`${name(p)} (data hash ${p.dataHash.slice(0, 12)}…) is not in the repository: a FOREIGN publisher. Void it before ${at(c.voidBy)}: ${cmd}`);
    else if (c.cls === "differs") bad.push(`${name(p)} on chain (data hash ${p.dataHash.slice(0, 12)}…) is not the repository's file (${p.local!.slice(0, 12)}…). Void it before ${at(c.voidBy)} unless the file is wrong: ${cmd}`);
    else if (c.cls === "pending") wait.push(`${name(p)} was published ${Math.round((now - p.publishedAt) / 60)} min ago and its file is not committed yet`);
    else ours.push(`${name(p)} (hold ends ${at(c.voidBy)})`);
  }
  if (bad.length) return { check, state: "fail", detail: bad.join("; ") };
  if (wait.length) return { check, state: "warn", detail: `${wait.join("; ")}${ours.length ? `; ours: ${ours.join(", ")}` : ""}` };
  return { check, state: "ok", detail: `in their hold, every one the repository's file: ${ours.join(", ")}` };
}

/**
 * r4-fix (review r4 finding 12): the oracle's D-17 GATE_BLOCK repository variable (oracle.yml, keeper.yml). While it is
 * "true" an epoch whose anomaly-gate hold ran out waits for an operator instead of being released; heartbeats are never
 * held, so it cannot kill the oracle seat, but a forgotten block stops every paying epoch: amber while set.
 */
export function gateBlockVerdict(value: string | undefined): Row {
  const check = "anomaly gate block";
  if ((value ?? "") === "true") return { check, state: "warn", detail: "GATE_BLOCK is set: an epoch held by the anomaly gate is not released when its 24-h hold runs out, only by an operator (heartbeats still publish). Clear the variable once the held epoch is decided" };
  return { check, state: "ok", detail: "GATE_BLOCK is not set: a held epoch is released with a fresh rebuild after its 24-h hold (unless the rebuild trips a new kind of reason)" };
}

/** CLAIM_WINDOW (constants.rs): an epoch closed before it ends was voided (expire_epoch / close_extra_epoch need it over). */
export const CLAIM_WINDOW_S = 90 * 86_400;
/** How far back the "our epochs voided" row looks: the seat's 28-day liveness window plus the 48-h hold. */
export const VOIDED_LOOKBACK_S = 30 * 86_400;

/** A base or extra epoch closed before its claim window ended (so voided), with its EpochVoided event when found. */
export interface VoidedView {
  kind: "base" | "extra";
  id: number;
  publishedAt: number;
  /** the repository holds its file with exactly the chain's data hash */
  ours: boolean;
  voider: string | null;
  bond: bigint | null;
  byCold: boolean | null;
}

/**
 * r4-fix (review r4 finding 3): our own epochs voided (upgraded program only). A voided epoch never keeps the seat alive,
 * so a stranger who voids every weekly heartbeat (now at least SEAT_BOND_MIN each, with no takeover priority) can still
 * let a quiet seat die: an epoch of ours voided by anyone but the seat's cold key is red, with the voider and its bond;
 * one the cold key voided is amber (the owner's own correction, or a cold key in the wrong hands). Voids of foreign
 * publications are the defence working and stay green. Looks back VOIDED_LOOKBACK_S.
 */
export function ourVoidedVerdict(detection: Detection, voided: VoidedView[], now: number): Row {
  const check = "our epochs voided";
  const na = naUntilUpgrade(check, detection);
  if (na) return na;
  const recent = voided.filter((v) => now - v.publishedAt <= VOIDED_LOOKBACK_S).sort((a, b) => a.id - b.id || a.kind.localeCompare(b.kind));
  const ours = recent.filter((v) => v.ours);
  if (!ours.length) {
    return { check, state: "ok", detail: recent.length ? `${recent.length} voided publication(s) in the last 30 days, none of them the repository's (foreign ones voided)` : "no epoch of ours was voided in the last 30 days" };
  }
  const at = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const name = (v: VoidedView) => `${v.kind === "extra" ? "extra epoch" : "epoch"} ${v.id} (published ${at(v.publishedAt)})`;
  const by = (v: VoidedView) => (v.voider ? `by ${v.voider}${v.byCold ? " (the seat's cold key)" : ""}${v.bond !== null ? ` with a bond of ${xnt(Number(v.bond))}` : ""}` : "(voider not found in its recent transactions)");
  const foreignVoid = ours.filter((v) => v.byCold !== true);
  const detail = `${ours.map((v) => `${name(v)} was VOIDED ${by(v)}`).join("; ")}: a voided epoch does not keep the oracle seat alive (28 days); if voids repeat, the seat can die in a quiet month (npm run seat shows the liveness clock)`;
  return { check, state: foreignVoid.length ? "fail" : "warn", detail };
}

// ── Keeper service levels ────────────────────────────────────────────────────────────────────────────────────────────

/** KEEPER_STALL_SLOTS (constants.rs, OD-31; mirrored in keeper-v3.ts): an anchored bet nobody reveals is paid as a win after it. */
export const KEEPER_STALL_SLOTS = 235_000;

/**
 * Oldest unsettled house bet against KEEPER_STALL_SLOTS (≈ 1 day): past the limit is red (on the upgraded program the
 * player is paid as a win from the keeper BOND and the bankroll keeps the stake, round 4 / review F1, so a stall moves
 * neither the bankroll nor the pool; on v2 the bet is long lost for the player), past half amber.
 * `ageSlots` = slots since its anchor (upgraded keeper bets) or its target slot (v2 bets).
 */
export function keeperSlaVerdict(oldest: { ageSlots: number; key: string } | null, open: number, stall = KEEPER_STALL_SLOTS): Row {
  const check = "keeper service level";
  if (!oldest) return { check, state: "ok", detail: "no unsettled house bet" };
  const h = slotAgeH(oldest.ageSlots, 0).toFixed(1);
  const detail = `${open} unsettled bet(s); oldest ${oldest.key} is ${oldest.ageSlots.toLocaleString("en-US")} slots old (~${h} h; limit KEEPER_STALL_SLOTS ${stall.toLocaleString("en-US")})`;
  if (oldest.ageSlots > stall) return { check, state: "fail", detail };
  if (oldest.ageSlots > stall / 2) return { check, state: "warn", detail };
  return { check, state: "ok", detail };
}

/** K-3: the keeper seat's bond covers every pending payout (Config.bankroll_reserved) plus the DRAWING Jackpot pots (jackpot_reserved). */
export function keeperBondVerdict(detection: Detection, seat: { bond: bigint; jackpotReserved: bigint } | null, bankrollReserved: bigint): Row {
  const check = "keeper bond cover";
  const na = naUntilUpgrade(check, detection);
  if (na) return na;
  if (!seat) return { check, state: bankrollReserved > 0n ? "fail" : "ok", detail: bankrollReserved > 0n ? `no keeper seat, but ${xnt(Number(bankrollReserved))} of house payouts are reserved` : "no keeper seat yet (the first arm_keeper with its bond is an owner step)" };
  const need = bankrollReserved + seat.jackpotReserved;
  const detail = `bond ${xnt(Number(seat.bond))} vs reserved ${xnt(Number(bankrollReserved))} + jackpot_reserved ${xnt(Number(seat.jackpotReserved))}`;
  return { check, state: seat.bond >= need ? "ok" : "fail", detail: seat.bond >= need ? detail : `${detail}: the bond does not cover them (K-3)` };
}

/** KEEPER_DEAD_DELAY: the keeper seat is takeable 28 days after its last arm / reveal / settle. */
export const KEEPER_DEAD_DELAY_S = 28 * 86_400;

/** The keeper seat: dead (takeable) or a hand-over pending is red; 10 days before death or a withdrawal notice is amber. */
export function keeperSeatVerdict(detection: Detection, seat: { keeper: string; pendingKeeper: string; lastActiveTs: number; withdrawTs: number } | null, now: number, defaultKey = "11111111111111111111111111111111"): Row {
  const check = "keeper seat";
  const na = naUntilUpgrade(check, detection);
  if (na) return na;
  if (!seat) return { check, state: "ok", detail: "no keeper seat yet (the first arm_keeper with its bond is an owner step)" };
  const deadAt = seat.lastActiveTs + KEEPER_DEAD_DELAY_S;
  const who = `held by ${seat.keeper.slice(0, 8)}…, last active ${new Date(seat.lastActiveTs * 1000).toISOString().slice(0, 16)}Z`;
  if (seat.pendingKeeper !== defaultKey) return { check, state: "fail", detail: `${who}; hand-over pending to ${seat.pendingKeeper}` };
  if (now >= deadAt) return { check, state: "fail", detail: `${who}: DEAD since ${new Date(deadAt * 1000).toISOString().slice(0, 10)} (anyone with a bond may take it)` };
  if (now >= deadAt - 10 * 86_400) return { check, state: "warn", detail: `${who}: takeable from ${new Date(deadAt * 1000).toISOString().slice(0, 10)} unless it arms, reveals or settles` };
  if (seat.withdrawTs > 0) return { check, state: "warn", detail: `${who}; a bond withdrawal was requested ${new Date(seat.withdrawTs * 1000).toISOString().slice(0, 10)} (7-day notice)` };
  return { check, state: "ok", detail: `${who}; alive until ${new Date(deadAt * 1000).toISOString().slice(0, 10)}` };
}

// ── Site current: the served rules marker equals the detection ───────────────────────────────────────────────────────

/** The source tag of the live v2 binary (frontend/src/facts.ts rules.program). */
export const LIVE_PROGRAM_TAG = "program-2026-10-12";
/** After the switch a stale marker warns this long before it turns red. */
export const SITE_GRACE_S = 72 * 3600;

/** "Rules described: program tag X, oracle Y" of the served llms.txt (scripts/prerender.mjs). */
export function parseRulesMarker(text: string): { program: string; oracle: string } | null {
  const m = text.match(/Rules described: program tag ([A-Za-z0-9._-]+), oracle (v\d+)/);
  return m ? { program: m[1], oracle: m[2] } : null;
}

/**
 * The site must describe the rules the chain runs: under the v2 binary the marker must be the live tag and oracle v2
 * (anything else shows future rules as live: red). Once the upgrade (or the first version-3 epoch file) is live, a
 * marker still on the old rules warns for SITE_GRACE_S after the change, then turns red.
 */
export function siteRulesVerdict(marker: { program: string; oracle: string } | null, detection: Detection, newestVersion: number | null, changedAt: { program: number | null; oracle: number | null }, now: number, liveTag = LIVE_PROGRAM_TAG): Row {
  const check = "site current";
  if (!marker) return { check, state: "warn", detail: "the served llms.txt has no \"Rules described\" marker (or could not be read)" };
  const shown = `marker: program tag ${marker.program}, oracle ${marker.oracle}`;
  if (detection === "unknown") return { check, state: "warn", detail: `${shown}; the program version is unknown, not compared` };
  const problems: string[] = [];
  let state: State = "ok";
  const stale = (since: number | null) => (since !== null && now - since < SITE_GRACE_S ? "warn" : "fail") as State;
  const worst = (s: State) => { if (s === "fail" || (s === "warn" && state === "ok")) state = s; };
  if (detection === "legacy" && marker.program !== liveTag) { problems.push(`the site names ${marker.program} but the live binary is ${liveTag}`); worst("fail"); }
  if (detection === "upgraded" && marker.program === liveTag) { problems.push(`the upgraded program is live but the site still names ${liveTag}`); worst(stale(changedAt.program)); }
  if (newestVersion === 3 && marker.oracle === "v2") { problems.push("the newest epoch file is version 3 but the site still says oracle v2"); worst(stale(changedAt.oracle)); }
  if (newestVersion !== 3 && marker.oracle !== "v2") {
    // under the upgraded binary the site may switch to v3 at the announced boundary publication, before the first
    // version-3 file (frontend/src/v3/detect.ts); under the v2 binary the v3 rules cannot be live yet
    problems.push(`the site says oracle ${marker.oracle} while the newest epoch file is version ${newestVersion ?? "none"}`);
    worst(detection === "legacy" ? "fail" : "warn");
  }
  if (problems.length) return { check, state, detail: `${shown}: ${problems.join("; ")}` };
  return { check, state: "ok", detail: `${shown}, as detected on chain (${detection === "legacy" ? "v2 binary" : "upgraded binary"}, newest epoch file version ${newestVersion ?? "none"})` };
}

// ── Verification green ───────────────────────────────────────────────────────────────────────────────────────────────

/** One entry of ops/verification.json (written by src/health-verify.ts with `npm run verify -- <file> --full`). */
export interface VerificationEntry { file: string; kind: "epoch" | "extra"; epoch: number; dataHash: string; status: "ok" | "failed" | "error"; detail: string; at: string }
export interface VerificationFile { at: string; results: VerificationEntry[] }
/** A newly published epoch must be verified green within this long (inside its 48-h hold). */
export const VERIFY_GRACE_S = 36 * 3600;

/** The newest on-chain epoch must have a green full verification of exactly its file; a mismatch is red, a run that could not finish warns. */
export function verificationVerdict(v: VerificationFile | null, newest: { epoch: number; dataHash: string; publishedAt: number } | null, now: number): Row {
  const check = "verification";
  if (!newest) return { check, state: "ok", detail: "no epoch published yet" };
  const failed = (v?.results ?? []).filter((r) => r.status === "failed");
  if (failed.length) return { check, state: "fail", detail: `verify --full FAILED for ${failed.map((r) => `${r.file} (${r.detail.slice(0, 120)})`).join("; ")}` };
  const mine = (v?.results ?? []).find((r) => r.kind === "epoch" && r.epoch === newest.epoch && r.dataHash === newest.dataHash);
  const young = now - newest.publishedAt < VERIFY_GRACE_S;
  if (!v) return { check, state: young ? "warn" : "fail", detail: `no verification.json for epoch ${newest.epoch} (published ${new Date(newest.publishedAt * 1000).toISOString().slice(0, 16)}Z)` };
  if (!mine) return { check, state: young ? "warn" : "fail", detail: `epoch ${newest.epoch} not verified yet (latest verification.json ${v.at} covers ${v.results.map((r) => r.file).join(", ") || "nothing"})` };
  if (mine.status === "error") return { check, state: "warn", detail: `verify --full of ${mine.file} could not finish (${mine.detail.slice(0, 120)}); the next run retries` };
  return { check, state: "ok", detail: `${v.results.filter((r) => r.status === "ok").map((r) => r.file).join(", ")} verified green (--full) at ${mine.at}` };
}

// ── Privileged-change rows: pinned expectations ──────────────────────────────────────────────────────────────────────

/**
 * A privileged key against its pin (src/health-pins.json): pin undefined or "" = not pinned yet (amber); null = none is
 * expected (an erased authority); a different value is red. Updating a pin is a reviewed commit, made in the same session
 * as the change it expects (the upgrade, the freeze, a seat rotation).
 */
export function pinVerdict(check: string, actual: string | null, pin: string | null | undefined): Row {
  const shown = (k: string | null) => (k === null ? "none" : k);
  if (pin === undefined || pin === "") return { check, state: "warn", detail: `${shown(actual)} (not pinned in health-pins.json)` };
  if (actual === pin) return { check, state: "ok", detail: `${shown(actual)}, as pinned` };
  return { check, state: "fail", detail: `${shown(actual)}, pinned ${shown(pin)}: a privileged key changed` };
}

/** Anchor's IDL account: 8-byte discriminator | authority (32) | data length (u32) | data. */
export function parseIdlAuthority(data: Uint8Array): string {
  const d = Buffer.from(data);
  if (d.length < 40) throw new Error("IDL account too short");
  return bs58.encode(d.subarray(8, 40));
}

// ── K-5: the house keeper's hash chains, full history ────────────────────────────────────────────────────────────────

/** One armed chain of the keeper seat: its head (the tip at arm time), its length, the slot it was armed at. */
export interface KeeperChain { armedSlot: number; head: string; length: number; revealedSeen: number }
/** What the health snapshot carries from run to run (the chain has no history of past heads). */
export interface K5History { since: string; chains: KeeperChain[] }
/** Walks longer than this are cut (chains are ~16k positions; KEEPER_MAX_CHAIN is 2^24 − 1). */
export const K5_WALK_MAX = 1 << 20;

/** x_0 = keccak^revealed(tip): every reveal r sets tip = r with keccak(r) == the previous tip (keeper.rs chain_next_ok). */
export function chainHeadOf(tip: Buffer, revealed: number): Buffer {
  let x: Buffer = Buffer.from(tip);
  for (let i = 0; i < revealed; i++) x = keccak(x);
  return x;
}

/** Steps d in [0, max] with keccak^d(from) == target, or -1. */
function hashDistance(from: Buffer, target: Buffer, max: number): number {
  let x: Buffer = Buffer.from(from);
  for (let d = 0; d <= max; d++) {
    if (x.equals(target)) return d;
    x = keccak(x);
  }
  return -1;
}

/**
 * Whether a new chain overlaps an earlier one: then some of its future reveals may already be public (the program's
 * K-5 check refuses only the CURRENT head). Overlap = one head reachable from the other by hashing within the other's
 * length (x_m(new) = x_r(old) gives keccak^(r−m)(head_new) = head_old, or keccak^(m−r)(head_old) = head_new).
 */
export function k5Overlaps(next: KeeperChain, earlier: KeeperChain[], max = K5_WALK_MAX): string[] {
  const h = Buffer.from(next.head, "hex");
  const out: string[] = [];
  for (const p of earlier) {
    const ph = Buffer.from(p.head, "hex");
    const a = hashDistance(h, ph, Math.min(p.length, max));
    const b = a < 0 ? hashDistance(ph, h, Math.min(next.length, max)) : -1;
    if (a >= 0) out.push(`the chain armed at slot ${next.armedSlot} lies on the chain armed at slot ${p.armedSlot} (position ${a}; ${p.revealedSeen} of it revealed when last seen)`);
    else if (b >= 0) out.push(`the chain armed at slot ${p.armedSlot} lies on the chain armed at slot ${next.armedSlot} (position ${b})`);
  }
  return out;
}

/**
 * The K-5 row and the history to carry. `seat` = the HouseKeeper now (null without a seat). A new armed slot adds a chain,
 * compared with every chain seen since `history.since`; the current chain's tip must still hash back to its head.
 */
export function k5Verdict(detection: Detection, seat: { tip: Buffer; revealed: number; length: number; armedSlot: number } | null, history: K5History | null, today: string): { row: Row; history: K5History | null } {
  const check = "K-5 chain history";
  const na = naUntilUpgrade(check, detection);
  if (na) return { row: na, history };
  if (!seat) return { row: { check, state: "ok", detail: "no keeper seat yet: nothing armed" }, history };
  const restarted = !history;
  const h: K5History = history ? { since: history.since, chains: history.chains.map((c) => ({ ...c })) } : { since: today, chains: [] };
  const head = chainHeadOf(seat.tip, seat.revealed).toString("hex");
  const last = h.chains[h.chains.length - 1];
  const problems: string[] = [];
  if (last && last.armedSlot === seat.armedSlot) {
    if (last.head !== head) problems.push(`the tip no longer hashes back to the head recorded for the chain armed at slot ${seat.armedSlot}`);
    last.revealedSeen = Math.max(last.revealedSeen, seat.revealed);
  } else {
    const next: KeeperChain = { armedSlot: seat.armedSlot, head, length: seat.length, revealedSeen: seat.revealed };
    problems.push(...k5Overlaps(next, h.chains));
    h.chains.push(next);
  }
  const base = `${h.chains.length} chain(s) since ${h.since}; current armed at slot ${seat.armedSlot}, ${seat.revealed}/${seat.length} revealed`;
  if (problems.length) return { row: { check, state: "fail", detail: `${problems.join("; ")} (${base})` }, history: h };
  if (restarted) return { row: { check, state: "warn", detail: `history (re)started today: chains armed before this run are not compared (${base})` }, history: h };
  return { row: { check, state: "ok", detail: `no overlap between chains (${base})` }, history: h };
}

// ── The extra pot: pot vs released vs claimed, the release bound ─────────────────────────────────────────────────────

/** extra.rs: R = 8% of X = free_before (EXTRA_RELEASE_BPS); the backing bound can only lower it. */
export const EXTRA_RELEASE_BPS = 800n;

export interface ExtraStateView { accounted: bigint; reserved: bigint; totalIn: bigint; totalPaid: bigint; totalReturned: bigint; lastEpoch: number }
export interface ExtraEpochView { id: number; budget: bigint; claimed: bigint; closed: boolean; freeBefore: bigint }

/**
 * The extra pot (two-pot model): the vault holds what the program accounts for; accounted = in − paid; reserved = Σ
 * (budget − claimed) of the open extra epochs; every epoch claims at most its budget, and its budget is at most 8% of
 * the free pot it was published against (the release bound).
 */
export function extraPotVerdicts(detection: Detection, x: ExtraStateView | null, epochs: ExtraEpochView[], vault: { lamports: number; rent: number } | null): Row[] {
  const names = ["extra vault", "extra accounting", "extra bound"];
  const na = naUntilUpgrade("extra pot", detection);
  if (na) return names.map((check) => ({ ...na, check }));
  if (!x || !vault) return [{ check: "extra pot", state: "fail", detail: "the upgraded program is detected but ExtraState or its vault cannot be read" }];
  const rows: Row[] = [];
  const free = BigInt(vault.lamports - vault.rent);
  rows.push(free >= x.accounted
    ? { check: "extra vault", state: "ok", detail: `${xnt(Number(free))} above rent covers the accounted pot ${xnt(Number(x.accounted))}` }
    : { check: "extra vault", state: "fail", detail: `${xnt(Number(free))} above rent is below the accounted pot ${xnt(Number(x.accounted))}` });
  const open = epochs.filter((e) => !e.closed).reduce((s, e) => s + (e.budget > e.claimed ? e.budget - e.claimed : 0n), 0n);
  const released = epochs.reduce((s, e) => s + e.budget, 0n), claimed = epochs.reduce((s, e) => s + e.claimed, 0n);
  const acct: string[] = [];
  if (x.accounted !== x.totalIn - x.totalPaid) acct.push(`accounted ${xnt(Number(x.accounted))} ≠ in ${xnt(Number(x.totalIn))} − paid ${xnt(Number(x.totalPaid))}`);
  if (x.reserved !== open) acct.push(`reserved ${xnt(Number(x.reserved))} ≠ Σ open (budget − claimed) ${xnt(Number(open))}`);
  if (x.reserved > x.accounted) acct.push("reserved above accounted");
  if (claimed > x.totalPaid) acct.push(`Σ claimed of the listed extra epochs ${xnt(Number(claimed))} above total_paid ${xnt(Number(x.totalPaid))}`);
  const sums = `pot ${xnt(Number(x.accounted))} (in ${xnt(Number(x.totalIn))}, paid ${xnt(Number(x.totalPaid))}, returned ${xnt(Number(x.totalReturned))}); ${epochs.length} extra epoch(s) listed: released ${xnt(Number(released))}, claimed ${xnt(Number(claimed))}, reserved ${xnt(Number(x.reserved))}`;
  rows.push(acct.length ? { check: "extra accounting", state: "fail", detail: `${acct.join("; ")} (${sums})` } : { check: "extra accounting", state: "ok", detail: sums });
  const bound = epochs.filter((e) => e.claimed > e.budget || e.budget > (e.freeBefore * EXTRA_RELEASE_BPS) / 10_000n);
  rows.push(bound.length
    ? { check: "extra bound", state: "fail", detail: bound.map((e) => `extra epoch ${e.id}: budget ${xnt(Number(e.budget))}, claimed ${xnt(Number(e.claimed))}, 8% of X ${xnt(Number((e.freeBefore * EXTRA_RELEASE_BPS) / 10_000n))}`).join("; ") }
    : { check: "extra bound", state: "ok", detail: `every listed extra epoch within 8% of its X and its budget${epochs.length ? "" : " (none published yet)"}` });
  return rows;
}

// ── Stable-days streak ───────────────────────────────────────────────────────────────────────────────────────────────

/** Days of no FAIL the freeze needs (IMMUTABILITY.md item 3; docs PROOF table). */
export const STABLE_DAYS_NEEDED = 14;

/** UTC day (YYYY-MM-DD) of a unix time. */
export const utcDay = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/**
 * Consecutive UTC days, ending today, with at least one completed health run and no failed one (the previous runs come
 * from the Actions API; today's verdict is this run's). The count starts the day after the last program deploy: any
 * program change restarts it. A day without a run breaks it too ("14 consecutive daily health runs").
 */
export function streakVerdict(runs: { day: string; ok: boolean }[] | null, today: string, todayOk: boolean, deployDay: string | null): Row {
  const check = "stable-days streak";
  if (!runs) return { check, state: "warn", detail: "the previous health runs could not be read (GITHUB_TOKEN unset or the API failed): not counted" };
  const byDay = new Map<string, boolean>();
  for (const r of runs) byDay.set(r.day, (byDay.get(r.day) ?? true) && r.ok);
  const prevDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const counts = (d: string) => deployDay === null || d > deployDay;
  let days = 0, why = "";
  if (!todayOk || byDay.get(today) === false) why = "a FAIL today";
  else if (!counts(today)) why = `the program was deployed today (${today})`;
  else {
    days = 1;
    for (let d = prevDay(today); ; d = prevDay(d)) {
      if (!counts(d)) { why = `the count starts the day after the last program deploy (${deployDay})`; break; }
      const ok = byDay.get(d);
      if (ok === undefined) { why = `no health run on ${d}`; break; }
      if (!ok) { why = `a FAIL on ${d}`; break; }
      days++;
    }
  }
  const since = days ? new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10) : null;
  const detail = `${days} consecutive day(s) with no FAIL${since ? ` (since ${since})` : ""}; ${STABLE_DAYS_NEEDED} needed before the freeze${why ? `; before that: ${why}` : ""}`;
  return { check, state: "ok", detail };
}

// ── The external-cron token (owner sheet 9.2 step 7) ─────────────────────────────────────────────────────────────────

/** DISPATCH_EXPIRES, like PAT_EXPIRES: information only (the external cron is a backup of the schedules), it never fails. */
export function dispatchVerdict(exp: string | undefined, now: number): Row | null {
  if (!exp) return null;
  const days = Math.floor((Date.parse(`${exp}T00:00:00Z`) / 1000 - now) / 86_400);
  if (Number.isNaN(days)) return { check: "dispatch token", state: "warn", detail: `DISPATCH_EXPIRES "${exp}" is not YYYY-MM-DD` };
  return { check: "dispatch token", state: days > 14 ? "ok" : "warn", detail: `expires ${exp} (${days} days left; only the external cron uses it to start the workflows, the schedules do not)` };
}

// ── the week-so-far feed (rewards v3: src/feed-v3.ts, served at <site>/feed/week-so-far.json) ───────────────────────

/** Past this age the feed warns (the keeper workflow writes it every hour; the site and the kit refuse a past hour's). */
export const FEED_WARN_AGE_S = 2 * 3_600;
/** What the health check read of the served feed (null fields when absent or unreadable). */
export interface FeedSeen { kind: unknown; version: unknown; rules: unknown; epoch: unknown; prevDataHash: unknown; asOf: unknown; readingsHour: unknown }

/**
 * The week-so-far feed row. n/a on the live v2 binary and while the next epoch is built under the v2 rules (no feed
 * exists then). Once live: a warning when it is missing, is not a v1 feed of the v3 rules, does not continue the newest
 * published epoch, is older than FEED_WARN_AGE_S, or carries no readings for the current or the previous hour. Never
 * red: without a fresh feed only the quote stops (the site and the kit fail closed), no payout is at risk.
 */
export function feedVerdict(detection: Detection, live: boolean, seen: FeedSeen | null, newest: { epoch: number; dataHash: string } | null, now: number): Row {
  const check = "week-so-far feed";
  const na = naUntilUpgrade(check, detection);
  if (na) return na;
  if (!live) return { check, state: "ok", detail: "n/a: the next epoch is built under the v2 rules (no binding quote, no feed)" };
  if (!seen) return { check, state: "warn", detail: "the site serves no week-so-far feed: no binding quote on the site or in the kit until the keeper workflow writes it" };
  if (seen.kind !== "week-so-far" || seen.version !== 1 || seen.rules !== 3) return { check, state: "warn", detail: `the served file is not a week-so-far feed v1 of the v3 rules (${String(seen.kind)} v${String(seen.version)}, rules ${String(seen.rules)})` };
  if (!newest) return { check, state: "warn", detail: "no published epoch file to compare the feed with" };
  if (seen.epoch !== newest.epoch + 1 || seen.prevDataHash !== newest.dataHash) {
    return { check, state: "warn", detail: `the feed is for epoch ${String(seen.epoch)} after data hash ${String(seen.prevDataHash).slice(0, 8)}…, not epoch ${newest.epoch + 1} after ${newest.dataHash.slice(0, 8)}…` };
  }
  if (typeof seen.asOf !== "number" || !Number.isSafeInteger(seen.asOf)) return { check, state: "warn", detail: "the feed has no asOf time" };
  const age = now - seen.asOf;
  const hour = Math.floor(now / 3_600);
  if (age > FEED_WARN_AGE_S) return { check, state: "warn", detail: `the feed is ${(age / 3_600).toFixed(1)} h old (the keeper workflow writes it every hour): no quote until it is fresh` };
  if (seen.readingsHour !== hour && seen.readingsHour !== hour - 1) return { check, state: "warn", detail: `the feed's readings are for hour ${String(seen.readingsHour)}, not the current one (${hour})` };
  return { check, state: "ok", detail: `epoch ${String(seen.epoch)}, as of ${Math.round(age / 60)} min ago, readings for hour ${String(seen.readingsHour)}` };
}
