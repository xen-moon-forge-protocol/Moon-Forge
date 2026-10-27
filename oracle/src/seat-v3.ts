/**
 * The oracle seat's client (round 4 default for the quiet-month seat, s6-minus-7 MANIFEST §4 item 4): read-only status
 * and the two defences the program leaves to anyone (seat.rs):
 *   - void_epoch / void_extra_epoch: inside an epoch's 48-h hold, anyone closes it for a bond paid to the reward pool
 *     (max(0.05 XNT, 10% of its full budget)); the seat's cold key voids for free (and, for a base epoch, waives the 6-day
 *     interval once so the rotated hot key republishes at once, S-2);
 *   - take_seat: a DEAD seat (no epoch survived its hold in the last 28 days: the largest voider from day 28, anyone from
 *     day 29) or an OPEN one (resigned: the named successor first for 24 h), for a seat bond of max(1 XNT, 10% of the
 *     free pool), naming the new hot, cold and refund keys.
 *
 *   npm run seat                                      read-only: the seat, its liveness, every epoch in its hold vs the repository
 *   npm run void-epoch -- <n> [--extra] [--as <pk>]   dry run: decide, build and SIMULATE the void (nothing signed, nothing sent)
 *   npm run void-epoch -- <n> [--extra] --yes          send it, signed by VOIDER_PRIVATE_KEY
 *   npm run take-seat -- --hot <pk> --cold <pk> --refund <pk> [--as <pk>]   dry run (simulated)
 *   npm run take-seat -- --hot <pk> --cold <pk> --refund <pk> --yes          send it, signed by TAKER_PRIVATE_KEY
 *
 * Everything is READ-ONLY unless --yes is given. A dry run simulates the exact transaction as the signing key (or as the
 * public key given with --as, so the cold key's owner can rehearse without the secret on the machine); with neither,
 * it prints the plan without a simulation. These commands never use ORACLE_PRIVATE_KEY, never run in the workflows and
 * only work on the upgraded program (the W2-4 verdict, read first). A void is refused when the epoch is the repository's
 * own file (the same data hash) unless --even-if-ours is given: voiding an honest epoch delays every burner's claim.
 */
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { EPOCHS_DIR } from "./config";
import { PDA } from "./x1";
import { isV3Program, PDA_V3, freePoolV3 } from "./x1-v3";
import { CLAIM_HOLD, DEAD_SEAT_DELAY, fetchAs, keeperModeV3, oracleSeatLivenessV3, PairViewV3, SEAT_PRIORITY_WINDOW, SEAT_WALK_PAIRS } from "./keeper-v3";
import { trustedConnectionFor } from "./x1-rpc";
import { CLAIM_WINDOW_S, publicationClassOf, PublicationView, VOIDED_LOOKBACK_S, VoidedView } from "./health-rules";

// ── program constants (constants.rs / utils.rs, mainnet values) ─────────────────────────────────────────────────────
export const VOID_BOND_MIN = 50_000_000n;
export const VOID_BOND_BPS = 1_000n;
export const SEAT_BOND_MIN = 1_000_000_000n;
export const SEAT_BOND_BPS = 1_000n;
const BPS = 10_000n;
const DEFAULT_KEY = PublicKey.default.toBase58();

const big = (v: unknown): bigint => (v === null || v === undefined ? 0n : BigInt((v as { toString(): string }).toString()));
const num = (v: unknown): number => Number(big(v));
const hex = (a: number[] | Uint8Array) => Buffer.from(a).toString("hex");
const maxB = (a: bigint, b: bigint) => (a > b ? a : b);
const xnt = (l: bigint) => `${(Number(l) / 1e9).toFixed(4)} XNT`;
const at = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const methods = (program: anchor.Program) => program.methods as any;

// ── pure mirrors of seat.rs ─────────────────────────────────────────────────────────────────────────────────────────
/** utils.rs void_bond */
export const voidBondV3 = (fullBudget: bigint): bigint => maxB((fullBudget * VOID_BOND_BPS) / BPS, VOID_BOND_MIN);
/**
 * seat.rs void_required: 0 for the cold key; SEAT_BOND_MIN for an epoch with nothing to protect (full budget 0: a
 * heartbeat, r4-fix / review r4 finding 3); else void_bond(full budget)
 */
export const voidRequiredV3 = (byCold: boolean, fullBudget: bigint): bigint => (byCold ? 0n : fullBudget === 0n ? SEAT_BOND_MIN : voidBondV3(fullBudget));
/** seat.rs book_void: a non-cold void of an epoch with something to protect (full budget > 0) may take the takeover priority */
export const voidTakesPriorityV3 = (byCold: boolean, fullBudget: bigint, openSince: number, bond: bigint, priorityBond: bigint): boolean =>
  !byCold && openSince === 0 && fullBudget > 0n && bond > priorityBond;
/** seat.rs extra_void_full_budget (S-1): an extra void is priced on max(extra budget, base budget + drop reserve) */
export const extraVoidFullBudgetV3 = (extraBudget: bigint, baseBudget: bigint, baseDropReserve: bigint): bigint => maxB(extraBudget, baseBudget + baseDropReserve);
/** utils.rs seat_bond: 10% of the free pool, at least 1 XNT */
export const seatBondV3 = (free: bigint): bigint => maxB((free * SEAT_BOND_BPS) / BPS, SEAT_BOND_MIN);
/** seat.rs is_cold: the seat's cold key (never the default key) */
export const isColdV3 = (seatCold: string, signer: string): boolean => seatCold !== DEFAULT_KEY && seatCold === signer;
/** seat.rs take_delay: the priority taker waits 28 d, everyone else 28 d + 24 h */
export const takeDelayV3 = (priority: string, taker: string): number => (priority !== DEFAULT_KEY && taker === priority ? DEAD_SEAT_DELAY : DEAD_SEAT_DELAY + SEAT_PRIORITY_WINDOW);

/** seat.rs void_gate, as the reason the program would refuse (null = voidable now) */
export function voidGateErrorV3(e: { closed: boolean; publishedAt: number }, now: number): string | null {
  if (e.closed) return "EpochClosed: the epoch is already closed (voided or expired)";
  if (now >= e.publishedAt + CLAIM_HOLD) return `HoldOver: its 48-h hold ended at ${at(e.publishedAt + CLAIM_HOLD)}; it can no longer be voided`;
  return null;
}

/** seat.rs take_keys_check + take_refund_check (null = accepted) */
export function takeKeysErrorV3(o: { hot: string; cold: string; refund: string; architect: string; seat: string }): string | null {
  if (o.hot === DEFAULT_KEY) return "InvalidTarget: the new hot key is the default key";
  if (o.hot === o.cold) return "InvalidTarget: the new hot key equals the new cold key";
  if (o.hot === o.architect) return "InvalidTarget: the new hot key is the architect payee";
  if (o.refund === o.seat) return "InvalidTarget: the refund address is the seat itself (its bond could never be returned)";
  return null;
}

/**
 * The exact mirror of seat.rs walk_is_dead for one delay, with the walk pairs it reads: ids from last_epoch down, newest
 * first; it stops at the first base epoch published before now − delay (dead), at the first surviving pair (alive) or at
 * id 1 (dead). `pairOf` returns null for a pair that could not be read (the program would fail: BadEpochWindow).
 */
export function seatWalkV3(takenAt: number, lastEpoch: number, pairOf: (id: number) => PairViewV3 | null, now: number, delay: number): { dead: boolean; ids: number[]; error: string | null } {
  const cutoff = now - delay;
  if (takenAt >= cutoff) return { dead: false, ids: [], error: null };
  const ids: number[] = [];
  let id = lastEpoch;
  for (let k = 0; k < SEAT_WALK_PAIRS; k++) {
    if (id === 0) return { dead: true, ids, error: null };
    const p = pairOf(id);
    if (!p) return { dead: false, ids, error: `epoch ${id} could not be read (the walk needs it)` };
    ids.push(id);
    if (p.publishedAt < cutoff) return { dead: true, ids, error: null };
    const survived = (x: { publishedAt: number; closed: boolean }) => !x.closed && now >= x.publishedAt + CLAIM_HOLD;
    if (survived(p) && (!p.extra || survived(p.extra))) return { dead: false, ids, error: null };
    if (id === 1) return { dead: true, ids, error: null };
    id--;
  }
  return { dead: false, ids, error: "BadEpochWindow: the walk is longer than SEAT_WALK_PAIRS" };
}

/**
 * Whether a void of this publication may be SENT (pure): only inside its hold, never twice, and never against the
 * repository's own file unless the caller says so (voiding an honest epoch only delays every claim of it).
 */
export function voidDecisionV3(p: PublicationView, now: number, evenIfOurs: boolean): { ok: boolean; reason: string } {
  const gate = voidGateErrorV3(p, now);
  if (gate) return { ok: false, reason: gate };
  const c = publicationClassOf(p, now);
  if (c.cls === "ours" && !evenIfOurs) return { ok: false, reason: `the repository holds this file with the same data hash (${p.dataHash.slice(0, 12)}…): it is the oracle's own publication; pass --even-if-ours to void it anyway` };
  if (c.cls === "pending" && !evenIfOurs) return { ok: false, reason: `published ${Math.round((now - p.publishedAt) / 60)} min ago and its file may not be committed yet: wait for the commit, or pass --even-if-ours` };
  return { ok: true, reason: c.cls === "ours" ? "the repository's own file (--even-if-ours)" : c.cls === "differs" ? "the chain's data hash is not the repository's file" : c.cls === "pending" ? "no file yet (--even-if-ours)" : "no file in the repository: a foreign publication" };
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The data hash of the repository's epoch-<n>.json / extra-<n>.json (EPOCHS_DIR), or null. */
export function localDataHashV3(kind: "base" | "extra", id: number, dir = EPOCHS_DIR): string | null {
  const p = path.join(dir, `${kind === "extra" ? "extra" : "epoch"}-${id}.json`);
  try {
    if (!fs.existsSync(p)) return null;
    const f = JSON.parse(fs.readFileSync(p, "utf8"));
    return typeof f?.dataHash === "string" ? f.dataHash : null;
  } catch {
    return null;
  }
}

/** Every base and extra epoch account still open (not closed), as PublicationViews with the repository's data hash. */
export async function openPublicationsV3(connection: Connection, program: anchor.Program, dir = EPOCHS_DIR): Promise<PublicationView[]> {
  const acc = program.account as any;
  const bases: any[] = await acc.epoch.all();
  const extras: any[] = await acc.extraEpoch.all().catch(() => []);
  const byId = new Map<number, any>(bases.map((e) => [num(e.account.id), e.account]));
  const out: PublicationView[] = [];
  for (const e of bases) {
    const a = e.account;
    if (a.closed) continue;
    const id = num(a.id);
    out.push({ kind: "base", id, publishedAt: num(a.publishedAt), closed: !!a.closed, dataHash: hex(a.dataHash), local: localDataHashV3("base", id, dir), bond: voidRequiredV3(false, big(a.budget) + big(a.dropReserve)) });
  }
  for (const x of extras) {
    const a = x.account;
    if (a.closed) continue;
    const id = num(a.id);
    const b = byId.get(id);
    const full = extraVoidFullBudgetV3(big(a.budget), b ? big(b.budget) : 0n, b ? big(b.dropReserve) : 0n);
    out.push({ kind: "extra", id, publishedAt: num(a.publishedAt), closed: !!a.closed, dataHash: hex(a.dataHash), local: localDataHashV3("extra", id, dir), bond: voidRequiredV3(false, full) });
  }
  void connection;
  return out.sort((p, q) => p.id - q.id || p.kind.localeCompare(q.kind));
}

/**
 * r4-fix (review r4 finding 3): the EpochVoided / ExtraEpochVoided event of a voided epoch, from the epoch account's
 * recent transactions (best effort: null when the node prunes them or none parses). Read-only.
 */
export async function voidEventOfV3(connection: Connection, program: anchor.Program, kind: "base" | "extra", id: number): Promise<{ voider: string; bond: bigint; byCold: boolean } | null> {
  const pda = kind === "extra" ? PDA_V3.extraEpoch(id) : PDA.epoch(id);
  const want = kind === "extra" ? "extraepochvoided" : "epochvoided";
  const parser = new anchor.EventParser(program.programId, program.coder);
  const sigs = await connection.getSignaturesForAddress(pda, { limit: 20 }, "confirmed");
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    const logs = tx?.meta?.logMessages;
    if (!logs) continue;
    for (const ev of parser.parseLogs(logs)) {
      if (ev.name.toLowerCase() !== want || num((ev.data as any).epoch) !== id) continue;
      const d = ev.data as any;
      return { voider: (d.voider as PublicKey).toBase58(), bond: big(d.bond), byCold: !!(d.byCold ?? d.by_cold) };
    }
  }
  return null;
}

/**
 * r4-fix (review r4 finding 3): every base / extra epoch published in the last VOIDED_LOOKBACK_S that is closed before its
 * 90-day claim window ended, i.e. voided, against the repository's files, with its void event when found.
 */
export async function voidedPublicationsV3(connection: Connection, program: anchor.Program, now: number, dir = EPOCHS_DIR): Promise<VoidedView[]> {
  const acc = program.account as any;
  const bases: any[] = await acc.epoch.all();
  const extras: any[] = await acc.extraEpoch.all().catch(() => []);
  const out: VoidedView[] = [];
  for (const [kind, list] of [["base", bases], ["extra", extras]] as ["base" | "extra", any[]][]) {
    for (const e of list) {
      const a = e.account;
      const publishedAt = num(a.publishedAt);
      if (!a.closed || now - publishedAt > VOIDED_LOOKBACK_S || now >= publishedAt + CLAIM_WINDOW_S) continue;
      const id = num(a.id);
      const ev = await voidEventOfV3(connection, program, kind, id).catch(() => null);
      out.push({ kind, id, publishedAt, ours: localDataHashV3(kind, id, dir) === hex(a.dataHash), voider: ev?.voider ?? null, bond: ev?.bond ?? null, byCold: ev?.byCold ?? null });
    }
  }
  return out.sort((p, q) => p.id - q.id || p.kind.localeCompare(q.kind));
}

/** The seat account, decoded (null without one). */
async function readSeat(connection: Connection, program: anchor.Program) {
  const s = await fetchAs(trustedConnectionFor(connection), program, "OracleSeat", PDA_V3.oracleSeat());
  if (!s) return null;
  return {
    generation: num(s.generation), cold: (s.cold as PublicKey).toBase58(), refund: (s.refund as PublicKey).toBase58(), bond: big(s.bond), takenAt: num(s.takenAt),
    openSince: num(s.openSince), priority: (s.priority as PublicKey).toBase58(), priorityBond: big(s.priorityBond), voids: num(s.voids), toPool: big(s.toPool),
  };
}

/** The walk pairs of the newest SEAT_WALK_PAIRS ids (the PairViewV3 of keeper-v3's liveness). */
async function readPairs(connection: Connection, program: anchor.Program, last: number): Promise<Map<number, PairViewV3>> {
  const ids = Array.from({ length: Math.min(last, SEAT_WALK_PAIRS) }, (_, i) => last - i);
  const rd = trustedConnectionFor(connection);
  const out = new Map<number, PairViewV3>();
  if (!ids.length) return out;
  const infos = await rd.getMultipleAccountsInfo([...ids.map((id) => PDA.epoch(id)), ...ids.map((id) => PDA_V3.extraEpoch(id))], "confirmed");
  ids.forEach((id, i) => {
    const b = infos[i];
    const x = infos[ids.length + i];
    const db = b && b.owner.equals(program.programId) ? safeDecode(program, "Epoch", b.data) : null;
    if (!db) return;
    const dx = x && x.owner.equals(program.programId) ? safeDecode(program, "ExtraEpoch", x.data) : null;
    out.set(id, { id, publishedAt: num(db.publishedAt), closed: !!db.closed, extra: dx ? { publishedAt: num(dx.publishedAt), closed: !!dx.closed } : null });
  });
  return out;
}

function safeDecode(program: anchor.Program, name: string, data: Buffer): any | null {
  try {
    const n = ((program.idl as anchor.Idl).accounts ?? []).find((a) => a.name.toLowerCase() === name.toLowerCase())?.name ?? name;
    return program.coder.accounts.decode(n, Buffer.from(data));
  } catch {
    return null;
  }
}

/** X1's clock now (the newest confirmed slot's block time on the default endpoint), else the machine clock. */
async function chainNowV3(connection: Connection): Promise<number> {
  const rd = trustedConnectionFor(connection);
  try {
    const t = await rd.getBlockTime(await rd.getSlot("confirmed"));
    if (typeof t === "number") return t;
  } catch {
    /* the machine clock below */
  }
  return Math.floor(Date.now() / 1000);
}

async function requireUpgraded(connection: Connection, program: anchor.Program, what: string) {
  if (!isV3Program(program)) throw new Error(`${what} needs the v3 client (moon_forge.v3.json)`);
  const { verdict } = await keeperModeV3(connection, program);
  if (verdict.status !== "upgraded") throw new Error(`${what}: the live program is not the upgraded binary (${verdict.status}: ${verdict.reasons.join("; ")}); the oracle seat exists only there (W2-4)`);
}

/** Simulates `ixs` as `payer` (no signature, nothing sent): the program's answer, or null when the node cannot simulate. */
export async function simulateAsV3(connection: Connection, payer: PublicKey, ixs: TransactionInstruction[]): Promise<{ ok: boolean; logs: string[]; err: string | null } | null> {
  try {
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message();
    const r = await connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    const logs = r.value.logs ?? [];
    return { ok: !r.value.err, logs, err: r.value.err ? (logs.find((l) => /Error Code|failed|insufficient/i.test(l)) ?? JSON.stringify(r.value.err)) : null };
  } catch {
    return null;
  }
}

/** The key a dry run simulates as: the signer, else --as <pubkey>, else none. */
function actorOf(signer: Keypair | null, as: string | undefined): PublicKey | null {
  if (signer) return signer.publicKey;
  if (as) return new PublicKey(as);
  return null;
}

// ── instruction builders (pure: no read; the CLIs and the tests use the same ones) ──────────────────────────────────
/**
 * void_epoch (base) or void_extra_epoch (extra) of `epoch` by `voider` with `bond` lamports. A base void carries
 * Epoch(n − 1) as remaining account 0: the program reads it only for a cold void (the S-2 waiver), and refuses a wrong one.
 */
export async function voidIxV3(program: anchor.Program, o: { epoch: number; extra: boolean; bond: bigint; voider: PublicKey }): Promise<TransactionInstruction> {
  if (o.extra) {
    return methods(program).voidExtraEpoch(new anchor.BN(o.epoch), new anchor.BN(o.bond.toString())).accountsPartial({
      config: PDA.config(), extraState: PDA_V3.extraState(), extraEpoch: PDA_V3.extraEpoch(o.epoch), epoch: PDA.epoch(o.epoch), seat: PDA_V3.oracleSeat(),
      rewardVault: PDA.rewardVault(), voider: o.voider, systemProgram: SystemProgram.programId,
    }).instruction();
  }
  return methods(program).voidEpoch(new anchor.BN(o.epoch), new anchor.BN(o.bond.toString())).accountsPartial({
    config: PDA.config(), epoch: PDA.epoch(o.epoch), seat: PDA_V3.oracleSeat(), rewardVault: PDA.rewardVault(), voider: o.voider, systemProgram: SystemProgram.programId,
  }).remainingAccounts(o.epoch > 1 ? [{ pubkey: PDA.epoch(o.epoch - 1), isSigner: false, isWritable: false }] : []).instruction();
}

/** take_seat naming the new keys, with the walk pairs (Epoch id, ExtraEpoch id), newest first, as seat_is_dead reads them. */
export async function takeSeatIxV3(program: anchor.Program, o: { hot: PublicKey; cold: PublicKey; refund: PublicKey; taker: PublicKey; walkIds: number[] }): Promise<TransactionInstruction> {
  const remaining = o.walkIds.flatMap((id) => [
    { pubkey: PDA.epoch(id), isSigner: false, isWritable: false },
    { pubkey: PDA_V3.extraEpoch(id), isSigner: false, isWritable: false },
  ]);
  return methods(program).takeSeat(o.hot, o.cold, o.refund).accountsPartial({
    config: PDA.config(), seat: PDA_V3.oracleSeat(), rewardVault: PDA.rewardVault(), taker: o.taker, systemProgram: SystemProgram.programId,
  }).remainingAccounts(remaining).instruction();
}

// ── the commands ────────────────────────────────────────────────────────────────────────────────────────────────────
/** `npm run seat`: read-only. The seat, when it can be taken, and every open epoch against the repository. */
export async function seatStatusCli(connection: Connection, program: anchor.Program, log = console.log): Promise<{ foreign: number }> {
  await requireUpgraded(connection, program, "seat");
  const now = await chainNowV3(connection);
  const seat = await readSeat(connection, program);
  const cfg = await fetchAs(trustedConnectionFor(connection), program, "Config", PDA.config());
  if (!cfg) throw new Error("Config could not be read");
  log(`oracle seat ${PDA_V3.oracleSeat().toBase58()} (X1 time ${at(now)})`);
  log(`  hot key (Config.oracle) ${(cfg.oracle as PublicKey).toBase58()}; pending hand-over ${(cfg.pendingOracle as PublicKey).toBase58()}`);
  if (!seat) {
    log("  no OracleSeat yet (init_seat is an S7 step)");
    return { foreign: 0 };
  }
  log(`  generation ${seat.generation}, cold ${seat.cold}, refund ${seat.refund}, bond ${xnt(seat.bond)}, taken ${at(seat.takenAt)}${seat.openSince ? `, OPEN since ${at(seat.openSince)}` : ""}`);
  log(`  priority taker ${seat.priority === DEFAULT_KEY ? "none" : `${seat.priority} (bond ${xnt(seat.priorityBond)})`}; ${seat.voids} voids, ${xnt(seat.toPool)} to the pool`);
  const last = num(cfg.lastEpoch);
  const pairs = await readPairs(connection, program, last);
  const l = oracleSeatLivenessV3(seat.takenAt, [...pairs.values()], now);
  log(`  liveness: ${l.state.toUpperCase()}: ${l.detail}`);
  const pubs = await openPublicationsV3(connection, program);
  let foreign = 0;
  for (const p of pubs) {
    const c = publicationClassOf(p, now);
    if (!c.voidable) continue;
    if (c.cls === "foreign" || c.cls === "differs") foreign++;
    log(`  ${p.kind === "extra" ? "extra epoch" : "epoch"} ${p.id}: in its hold until ${at(c.voidBy)}, ${c.cls.toUpperCase()}${c.cls === "ours" ? "" : ` (chain ${p.dataHash.slice(0, 16)}…, repository ${p.local ? `${p.local.slice(0, 16)}…` : "no file"})`}; void bond ${xnt(p.bond)} (0 for the cold key)`);
  }
  if (!pubs.some((p) => publicationClassOf(p, now).voidable)) log("  no epoch is inside its 48-h hold");
  if (foreign) log(`  ${foreign} publication(s) the repository does not hold: void each with npm run void-epoch -- <n> [--extra] --yes before its hold ends`);
  return { foreign };
}

export interface VoidOptsV3 {
  epoch: number;
  extra: boolean;
  yes: boolean;
  evenIfOurs: boolean;
  /** dry run only: simulate as this public key (no secret needed) */
  as?: string;
  /** a bond above the required one (lamports); the required one by default */
  bond?: bigint;
  log?: (s: string) => void;
}

/** `npm run void-epoch -- <n> [--extra]`: dry (decide, build, simulate) unless --yes; signed by VOIDER_PRIVATE_KEY. */
export async function voidEpochCli(connection: Connection, program: anchor.Program, signer: Keypair | null, o: VoidOptsV3): Promise<string | null> {
  const log = o.log ?? console.log;
  if (!Number.isSafeInteger(o.epoch) || o.epoch < 1) throw new Error("usage: void-epoch <epoch> [--extra] [--as <pubkey>] [--yes] [--even-if-ours]");
  if (o.yes && !signer) throw new Error("--yes needs VOIDER_PRIVATE_KEY (the key that posts the bond, or the seat's cold key)");
  await requireUpgraded(connection, program, "void-epoch");
  const now = await chainNowV3(connection);
  const seat = await readSeat(connection, program);
  if (!seat) throw new Error("there is no OracleSeat: void_epoch needs it");
  const rd = trustedConnectionFor(connection);
  const base = await fetchAs(rd, program, "Epoch", PDA.epoch(o.epoch));
  if (!base) throw new Error(`Epoch ${o.epoch} does not exist on chain`);
  const ex = o.extra ? await fetchAs(rd, program, "ExtraEpoch", PDA_V3.extraEpoch(o.epoch)) : null;
  if (o.extra && !ex) throw new Error(`ExtraEpoch ${o.epoch} does not exist on chain`);
  const a = o.extra ? ex : base;
  const full = o.extra ? extraVoidFullBudgetV3(big(ex.budget), big(base.budget), big(base.dropReserve)) : big(base.budget) + big(base.dropReserve);
  const kind: "base" | "extra" = o.extra ? "extra" : "base";
  const p: PublicationView = { kind, id: o.epoch, publishedAt: num(a.publishedAt), closed: !!a.closed, dataHash: hex(a.dataHash), local: localDataHashV3(kind, o.epoch), bond: voidRequiredV3(false, full) };
  const actor = actorOf(signer, o.as);
  const byCold = !!actor && isColdV3(seat.cold, actor.toBase58());
  const required = voidRequiredV3(byCold, full);
  const bond = o.bond !== undefined ? maxB(o.bond, required) : required;
  const decision = voidDecisionV3(p, now, o.evenIfOurs);
  const name = `${o.extra ? "extra epoch" : "epoch"} ${o.epoch}`;
  log(`void-epoch plan: ${name}, published ${at(p.publishedAt)}, hold ends ${at(p.publishedAt + CLAIM_HOLD)}; chain data hash ${p.dataHash}, repository ${p.local ?? "no file"}`);
  log(`  voider ${actor ? actor.toBase58() : "(none given: plan only)"}${byCold ? " = the seat's COLD key: no bond" : ""}; bond ${xnt(bond)} (required ${xnt(required)}) to the reward pool`);
  if (byCold && !o.extra && o.epoch > 1) log("  the cold key's void of a base epoch also waives the 6-day interval once (S-2): the rotated hot key can republish at once");
  log(`  decision: ${decision.ok ? "VOID" : "REFUSED"}: ${decision.reason}`);
  if (!decision.ok && o.yes) throw new Error(`refusing to void ${name}: ${decision.reason}`);
  if (!actor) {
    log("  dry: no VOIDER_PRIVATE_KEY and no --as <pubkey>: not simulated, nothing sent");
    return null;
  }
  const ix = await voidIxV3(program, { epoch: o.epoch, extra: o.extra, bond, voider: actor });
  const sim = await simulateAsV3(connection, actor, [ix]);
  log(`  simulation as ${actor.toBase58()}: ${sim === null ? "the node cannot simulate" : sim.ok ? "accepted by the program" : `REFUSED: ${sim.err}`}`);
  if (!o.yes) {
    log("  dry: nothing signed, nothing sent (add --yes to send it)");
    return null;
  }
  if (sim && !sim.ok) throw new Error(`refusing to send: the program refuses the void in simulation (${sim.err})`);
  const sig = await program.provider.sendAndConfirm!(new Transaction().add(ix), [signer!]);
  log(`  voided: ${sig}`);
  return sig;
}

export interface TakeOptsV3 {
  hot: string;
  cold: string;
  refund: string;
  yes: boolean;
  as?: string;
  log?: (s: string) => void;
}

/** `npm run take-seat -- --hot <pk> --cold <pk> --refund <pk>`: dry (decide, build, simulate) unless --yes; TAKER_PRIVATE_KEY. */
export async function takeSeatCli(connection: Connection, program: anchor.Program, signer: Keypair | null, o: TakeOptsV3): Promise<string | null> {
  const log = o.log ?? console.log;
  for (const [k, v] of [["--hot", o.hot], ["--cold", o.cold], ["--refund", o.refund]] as const) {
    if (!v) throw new Error(`usage: take-seat --hot <pubkey> --cold <pubkey> --refund <pubkey> [--as <pubkey>] [--yes] (${k} missing)`);
    new PublicKey(v); // throws on a malformed key
  }
  if (o.yes && !signer) throw new Error("--yes needs TAKER_PRIVATE_KEY (it posts the seat bond)");
  await requireUpgraded(connection, program, "take-seat");
  const now = await chainNowV3(connection);
  const seat = await readSeat(connection, program);
  if (!seat) throw new Error("there is no OracleSeat (init_seat is an S7 step)");
  const cfg = await fetchAs(trustedConnectionFor(connection), program, "Config", PDA.config());
  if (!cfg) throw new Error("Config could not be read");
  const keys = takeKeysErrorV3({ hot: o.hot, cold: o.cold, refund: o.refund, architect: (cfg.architect as PublicKey).toBase58(), seat: PDA_V3.oracleSeat().toBase58() });
  if (keys) throw new Error(`refusing to take the seat: ${keys}`);
  const actor = actorOf(signer, o.as);
  const taker = actor ? actor.toBase58() : DEFAULT_KEY;
  const last = num(cfg.lastEpoch);
  const pairs = await readPairs(connection, program, last);
  let walkIds: number[] = [];
  let reason: string;
  let ok: boolean;
  if (seat.openSince) {
    const firstDay = now < seat.openSince + SEAT_PRIORITY_WINDOW;
    ok = !firstDay || taker === seat.priority;
    reason = ok ? `the seat is OPEN since ${at(seat.openSince)}${firstDay ? " and this key is the named successor" : ""}: no bond is forfeited` : `the seat is open, but only the named successor ${seat.priority} may take it before ${at(seat.openSince + SEAT_PRIORITY_WINDOW)} (SeatPriority)`;
  } else {
    const delay = takeDelayV3(seat.priority, taker);
    const w = seatWalkV3(seat.takenAt, last, (id) => pairs.get(id) ?? null, now, delay);
    walkIds = w.ids;
    ok = w.dead && !w.error;
    const l = oracleSeatLivenessV3(seat.takenAt, [...pairs.values()], now);
    reason = w.error ? `the walk cannot be built: ${w.error}` : w.dead ? `DEAD for this key (no epoch survived its hold in the last ${delay / 86_400} days): its bond ${xnt(seat.bond)} is forfeited to the pool` : `ALIVE for this key (SeatAlive): ${l.detail}`;
  }
  const pool = await freePoolV3(connection, program, "confirmed");
  const forfeit = seat.openSince ? 0n : seat.bond;
  const bond = seatBondV3(BigInt(pool.lamports) + (ok ? forfeit : 0n));
  log(`take-seat plan: seat generation ${seat.generation} → ${seat.generation + 1}; new hot ${o.hot}, cold ${o.cold}, refund ${o.refund}`);
  log(`  taker ${actor ? taker : "(none given: plan only)"}${seat.priority !== DEFAULT_KEY ? ` (priority taker: ${seat.priority}${taker === seat.priority ? ", this key" : ""})` : ""}; seat bond about ${xnt(bond)} (max(1 XNT, 10% of the free pool${forfeit && ok ? " incl. the forfeit" : ""}))`);
  log(`  decision: ${ok ? "TAKE" : "REFUSED"}: ${reason}`);
  if (!ok && o.yes) throw new Error(`refusing to take the seat: ${reason}`);
  if (!actor) {
    log("  dry: no TAKER_PRIVATE_KEY and no --as <pubkey>: not simulated, nothing sent");
    return null;
  }
  const ix = await takeSeatIxV3(program, { hot: new PublicKey(o.hot), cold: new PublicKey(o.cold), refund: new PublicKey(o.refund), taker: actor, walkIds });
  const sim = await simulateAsV3(connection, actor, [ix]);
  log(`  walk pairs passed: ${walkIds.length ? walkIds.join(", ") : "none"}; simulation as ${taker}: ${sim === null ? "the node cannot simulate" : sim.ok ? "accepted by the program" : `REFUSED: ${sim.err}`}`);
  if (!o.yes) {
    log("  dry: nothing signed, nothing sent (add --yes to send it)");
    return null;
  }
  if (sim && !sim.ok) throw new Error(`refusing to send: the program refuses take_seat in simulation (${sim.err})`);
  const sig = await program.provider.sendAndConfirm!(new Transaction().add(ix), [signer!]);
  log(`  taken: ${sig}; the new hot key publishes from now on (set ORACLE_PRIVATE_KEY to it) and health-pins.json moves in a reviewed commit`);
  return sig;
}
