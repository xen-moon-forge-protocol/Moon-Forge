/**
 * X1 side of the rewards v3 plumbing (amendments A8, A10.11, A11): the Artifact snapshot with record fields and the
 * slot's block time, the free pool at one read, the EpochPublished record of an epoch, the pending drop luck,
 * publish_epoch for a v3 file, the claims (dust included) and the close_receipt sweep. Nothing in x1.ts changes for
 * v2; the keeper's seal loop only asks sealAllowedV3 (flow-v3.ts), which answers true for every v2 file.
 *
 * IDL split (W2-4): every function here runs on the UPGRADED program's IDL (src/idl/moon_forge.v3.json, programV3 /
 * connectV3), while x1.ts and the v2 path keep the live IDL (moon_forge.json) until the upgrade is on mainnet. Every v3
 * publication (base or extra) first checks, read-only, that the live binary IS the upgraded one (assertUpgradedV3).
 * The extra-pot instruction builders (publish_extra_epoch with `weeks`, claim_extra, init_extra, close_extra_epoch)
 * follow the program's final signature (extra.rs, W2-3).
 */
import * as anchor from "@coral-xyz/anchor";
import { createHash } from "crypto";
import { Commitment, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { trustedConnectionFor, x1Connection } from "./x1-rpc";
import { BPS, keeperTipDue, MAX_PUBLISH_LAG, MIN_EPOCH_INTERVAL, programClaims, publishableError, publishAgeError, WEEK } from "./rewards";
import type { PublishedRecordV3, SnapshotReadV3, SnapshotRecordV3 } from "./flow-v3";
import { fetchConfig, MPL_CORE, PDA, programId } from "./x1";
import { EXTRA_BACKING_BOUND_BPS, EXTRA_MAX_LEAVES, EXTRA_MAX_WEEKS, EXTRA_RELEASE_BPS, ExtraClaimArgs, ExtraFileV1, ExtraInitMark, extraPublishArgs, ExtraPublishArgs, PublishedExtra } from "./extra";
import idlV3 from "./idl/moon_forge.v3.json";

// ── the v3 client (upgraded program's IDL) ──────────────────────────────────────────────────────
/** The UPGRADED program's IDL (SPEC-UPGRADE-v2, 92 instructions); the live one is x1.ts LIVE_IDL. */
export const V3_IDL = idlV3 as anchor.Idl;

/** The v3 Anchor client (upgraded IDL) on any provider. */
export function programV3(provider: anchor.Provider): anchor.Program {
  return new anchor.Program(V3_IDL, provider);
}

/** connect() of x1.ts with the v3 IDL: the client of every v3 / extra path. */
export function connectV3(signer?: Keypair) {
  const connection = x1Connection("confirmed");
  const wallet = new anchor.Wallet(signer ?? Keypair.generate());
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = programV3(provider);
  return { connection, provider, program, wallet };
}

/** true when `program` is built from the v3 IDL (publish_extra_epoch with its `weeks` argument). */
export function isV3Program(program: anchor.Program): boolean {
  const ix = ((program.rawIdl as anchor.Idl).instructions ?? []).find((i) => i.name === "publish_extra_epoch");
  return !!ix && ix.args.some((a) => a.name === "weeks");
}

function requireV3Program(program: anchor.Program, what: string) {
  if (!program || !isV3Program(program)) throw new Error(`${what}: the client is not built from moon_forge.v3.json (the upgraded program's IDL); use connectV3 / programV3`);
}

const u64le = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const pdaV3 = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];

/** PDAs added by the upgrade (constants.rs SEED_*; Appendix B). */
export const PDA_V3 = {
  extraState: () => pdaV3(Buffer.from("extra_state")),
  extraVault: () => pdaV3(Buffer.from("extra_vault")),
  extraEpoch: (id: number | bigint) => pdaV3(Buffer.from("extra_epoch"), u64le(id)),
  oracleSeat: () => pdaV3(Buffer.from("oracle_seat")),
  houseKeeper: () => pdaV3(Buffer.from("house_keeper")),
};

const bnStr = (v: unknown): string => (v === null || v === undefined ? "0" : (v as { toString(): string }).toString());

/**
 * The ArtifactRecord accounts at "finalized", with the context slot the RPC served them at (A13.10): every record
 * listed exists at that slot, because the list IS the state of that slot. `minContextSlot` makes a second RPC answer
 * from that slot or later.
 */
export async function artifactRecordsAtV3(connection: Connection, program: anchor.Program, minContextSlot?: number): Promise<{ slot: number; records: { publicKey: PublicKey; account: any }[] }> {
  const name = ((program.idl as anchor.Idl).accounts ?? []).find((a) => a.name.toLowerCase() === "artifactrecord")?.name ?? "ArtifactRecord";
  const coder = program.coder.accounts;
  const f = coder.memcmp(name);
  const res = await connection.getProgramAccounts(program.programId, {
    commitment: "finalized",
    withContext: true,
    filters: [{ memcmp: { offset: f.offset, bytes: f.bytes } }],
    ...(minContextSlot === undefined ? {} : { minContextSlot }),
  });
  return { slot: res.context.slot, records: res.value.map(({ pubkey, account }) => ({ publicKey: pubkey, account: coder.decode(name, account.data) })) };
}

/** The owner of a live Core asset of our collection (Key::AssetV1, update authority = Collection(ours)), else null. */
export function liveCoreOwnerV3(info: { owner: PublicKey; data: Buffer | Uint8Array } | null, collection: PublicKey = PDA.collection()): string | null {
  if (!info || !info.owner.equals(MPL_CORE)) return null;
  const d = Buffer.from(info.data);
  if (d.length < 66 || d[0] !== 1 || d[33] !== 2 || !new PublicKey(d.subarray(34, 66)).equals(collection)) return null;
  return new PublicKey(d.subarray(1, 33)).toBase58();
}

/** mpl-core instruction ids that set or end an asset's owner (core_cpi.rs IX_*; CreateV2 shares CreateV1's accounts) */
export const CORE_IX = { CREATE_V1: 0, BURN_V1: 12, TRANSFER_V1: 14, CREATE_V2: 20 } as const;

/** One instruction of a transaction, keys resolved (lookup tables included). */
export interface TxIxV3 {
  program: string;
  accounts: string[];
  data: Buffer;
}

/**
 * A10.11: what a transaction did to `asset`'s owner, from its Core instructions in execution order (each top-level
 * instruction, then the CPIs it made): the LAST create / transfer / burn of the asset wins; null when it has none (a
 * plugin or metadata change: the owner is unchanged). Core passes an absent optional account as its own program id
 * (core_cpi.rs): CreateV1/V2 [asset, collection, authority, payer, owner, ...] (no owner: the payer owns it), TransferV1
 * [asset, collection, payer, authority, new_owner, ...], BurnV1 [asset, ...].
 */
export function coreOwnershipOfV3(ixs: TxIxV3[], asset: string): { kind: "create" | "transfer" | "burn"; owner: string | null } | null {
  const core = MPL_CORE.toBase58();
  let out: { kind: "create" | "transfer" | "burn"; owner: string | null } | null = null;
  for (const ix of ixs) {
    if (ix.program !== core || ix.accounts[0] !== asset || ix.data.length < 1) continue;
    const k = ix.data[0];
    if (k === CORE_IX.CREATE_V1 || k === CORE_IX.CREATE_V2) {
      const o = ix.accounts[4];
      const owner = o && o !== core ? o : ix.accounts[3];
      if (!owner || owner === core) throw new Error(`a Core create of ${asset} names no owner and no payer`);
      out = { kind: "create", owner };
    } else if (k === CORE_IX.TRANSFER_V1) {
      const o = ix.accounts[4];
      if (!o || o === core) throw new Error(`a Core transfer of ${asset} names no new owner`);
      out = { kind: "transfer", owner: o };
    } else if (k === CORE_IX.BURN_V1) out = { kind: "burn", owner: null };
  }
  return out;
}

/** The instructions of a transaction from getTransaction (legacy or v0, lookup tables resolved), in execution order. */
export function txInstructionsV3(t: { transaction: { message: any }; meta: any }): TxIxV3[] {
  const msg = t.transaction.message;
  const loaded = t.meta?.loadedAddresses;
  const keys = msg.getAccountKeys(loaded ? { accountKeysFromLookups: loaded } : undefined);
  const key = (i: number): string => {
    const k = keys.get(i);
    if (!k) throw new Error(`account index ${i} is outside the transaction's keys`);
    return k.toBase58();
  };
  const inner = new Map<number, { programIdIndex: number; accounts: number[]; data: string }[]>();
  for (const g of t.meta?.innerInstructions ?? []) inner.set(g.index, g.instructions);
  const out: TxIxV3[] = [];
  (msg.compiledInstructions as { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }[]).forEach((ix, i) => {
    out.push({ program: key(ix.programIdIndex), accounts: ix.accountKeyIndexes.map(key), data: Buffer.from(ix.data) });
    for (const c of inner.get(i) ?? []) out.push({ program: key(c.programIdIndex), accounts: c.accounts.map(key), data: Buffer.from(bs58.decode(c.data)) });
  });
  return out;
}

/** What the A10.11 per-asset reader asks one X1 RPC (read-only, "finalized"). */
export interface AssetHistoryRpcV3 {
  /** Core asset accounts from `minContextSlot` on, with the context slot of the answer */
  assets(keys: PublicKey[], minContextSlot: number): Promise<{ slot: number; infos: ({ owner: PublicKey; data: Buffer } | null)[] }>;
  /** one page (at most 1,000, newest first) of an address's signatures, from `minContextSlot` on */
  signatures(address: PublicKey, before: string | undefined, minContextSlot: number): Promise<{ signature: string; slot: number; err: unknown }[]>;
  /** the instructions of a finalized transaction in execution order; null when the node does not have it */
  instructions(signature: string): Promise<TxIxV3[] | null>;
}

export function assetHistoryRpcV3(connection: Connection): AssetHistoryRpcV3 {
  return {
    assets: async (keys, minContextSlot) => {
      const r = await connection.getMultipleAccountsInfoAndContext(keys, { commitment: "finalized", minContextSlot });
      return { slot: r.context.slot, infos: r.value.map((a) => (a ? { owner: a.owner, data: Buffer.from(a.data) } : null)) };
    },
    signatures: (address, before, minContextSlot) => connection.getSignaturesForAddress(address, { limit: 1000, before, minContextSlot }, "finalized"),
    instructions: async (sig) => {
      const t = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
      if (!t || !t.meta || t.meta.err) return null;
      return txInstructionsV3(t as never);
    },
  };
}

/** One asset's state at slot S (A10.11): live, its owner, its last successful transaction at or before S. */
export interface AssetAtSlotV3 {
  live: boolean;
  owner: string | null;
  signature: string | null;
  /** "current": no transaction touched the asset after S, so the account read now is its state at S; "history": rebuilt */
  via: "current" | "history";
}

/** the most transactions walked back through one asset's history before the reader gives up (fail closed) */
export const ASSET_HISTORY_MAX_TX = 200;

/**
 * A10.11 (X-015, the A13.10 residuals): the state of `asset` at slot S, deterministic. The account is read first
 * (context slot Sa >= S), then its signatures from Sa on, so every transaction that could have changed what was read is
 * listed. With no successful transaction after S, the account read IS its state at S. Otherwise the state at S is
 * rebuilt from its history: the last Core create / transfer / burn of the asset at or before S decides
 * (coreOwnershipOfV3); none at all means the asset did not exist at S. A transaction the node cannot serve, or a
 * history longer than the limits, throws: never a guess.
 */
export async function assetStateAtV3(rpc: AssetHistoryRpcV3, asset: PublicKey, S: number, current: { slot: number; info: { owner: PublicKey; data: Buffer } | null }, collection: PublicKey = PDA.collection(), maxPages = 50): Promise<AssetAtSlotV3> {
  const id = asset.toBase58();
  let before: string | undefined;
  let changedAfter = false;
  let exhausted = false;
  const atOrBefore: string[] = [];
  // newest first: every signature listed before the first one at or before S is after S
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new Error(`asset ${id}: more than ${maxPages * 1000} signatures to read back to slot ${S}`);
    const sigs = await rpc.signatures(asset, before, current.slot);
    for (const s of sigs) {
      if (s.err) continue;
      if (s.slot > S) changedAfter = true;
      else atOrBefore.push(s.signature);
    }
    if (sigs.length < 1000) {
      exhausted = true;
      break;
    }
    before = sigs[sigs.length - 1].signature;
    // without a change after S the newest signature at or before S is all the reader needs
    if (atOrBefore.length && !changedAfter) break;
    if (changedAfter && atOrBefore.length >= ASSET_HISTORY_MAX_TX) break;
  }
  const signature = atOrBefore[0] ?? null;
  if (!changedAfter) {
    const owner = liveCoreOwnerV3(current.info, collection);
    if (owner && !signature) throw new Error(`asset ${id} is live with no transaction at or before slot ${S} (a lagging signature index)`);
    return { live: !!owner, owner, signature, via: "current" };
  }
  for (const [i, sig] of atOrBefore.entries()) {
    if (i >= ASSET_HISTORY_MAX_TX) break;
    const ixs = await rpc.instructions(sig);
    if (!ixs) throw new Error(`asset ${id}: transaction ${sig} cannot be read (its owner at slot ${S} is unknown)`);
    const c = coreOwnershipOfV3(ixs, id);
    if (c) return { live: c.kind !== "burn", owner: c.kind === "burn" ? null : c.owner, signature, via: "history" };
  }
  if (!exhausted || atOrBefore.length > ASSET_HISTORY_MAX_TX) throw new Error(`asset ${id}: no Core create / transfer / burn within the reader's limits at or before slot ${S}`);
  return { live: false, owner: null, signature, via: "history" };
}

/**
 * The Artifact snapshot for v3 (A8, R1-3, A13.10, A10.11): every ArtifactRecord whose Core asset is live in the
 * collection AT slot S, with the record's backing, origin and forged_at and the Core owner AT S; blockTime = the X1
 * block time of S (null when the node has none: the caller re-reads).
 *  - S is the context slot of the finalized record list itself (A13.10), so every record listed exists at S.
 *  - Per asset, the owner and the liveness are the state AT S (assetStateAtV3): an Artifact transferred or recycled
 *    after S is recorded as it was at S, never as of the later read (the A13.10 residual 1).
 *  - With X1_RPC_2 set (A10.11, X-015): the second RPC lists the records from S on and answers the same per-asset
 *    reads; an Artifact forged after S (listed by the second RPC only) or recycled after S (listed by the first only)
 *    is decided by its own history, so a forge or recycle between the two reads no longer refuses the snapshot (the
 *    A13.10 residual 2, review E6). The two RPCs must agree on every asset's state at S and on the immutable record
 *    fields; any disagreement, or an asset that existed at S missing from the first list, throws (readSnapshotV3
 *    retries, then builds the base without the records, A13.9).
 */
export async function artifactSnapshotV3(
  connection: Connection, program: anchor.Program, rpc2 = process.env.X1_RPC_2 || "",
  rpcs: { first?: AssetHistoryRpcV3; second?: AssetHistoryRpcV3; secondConnection?: Connection | null } = {},
): Promise<SnapshotReadV3> {
  const { slot: S, records } = await artifactRecordsAtV3(connection, program);
  const secondConn = rpcs.secondConnection !== undefined ? rpcs.secondConnection : rpc2 ? new Connection(rpc2, "confirmed") : null;
  const assetOf = (r: { account: any }) => (r.account.asset as PublicKey).toBase58();
  const first = new Map(records.map((r) => [assetOf(r), r]));
  const candidates = new Set(first.keys());
  if (secondConn) {
    const other = await artifactRecordsAtV3(secondConn, program, S);
    if (other.slot < S) throw new Error(`the second X1 RPC answered at slot ${other.slot}, before the snapshot slot ${S} (X-015)`);
    for (const r of other.records) {
      const a = assetOf(r);
      const p = first.get(a);
      if (p) {
        const same = (k: string) => bnStr(p.account[k]) === bnStr(r.account[k]);
        if (!same("tier") || !same("origin") || !same("forgedAt")) throw new Error(`the two X1 RPCs disagree on the ArtifactRecord of ${a}: snapshot refused (X-015)`);
      } else candidates.add(a);
    }
  }
  const readers = [rpcs.first ?? assetHistoryRpcV3(connection), ...(secondConn ? [rpcs.second ?? assetHistoryRpcV3(secondConn)] : [])];
  const collection = PDA.collection();
  const keys = [...candidates].sort();
  const states: AssetAtSlotV3[][] = [];
  for (const rpc of readers) {
    const mine: AssetAtSlotV3[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100).map((k) => new PublicKey(k));
      const cur = await rpc.assets(chunk, S);
      if (cur.slot < S) throw new Error(`an X1 RPC answered the Core assets at slot ${cur.slot}, before the snapshot slot ${S}`);
      for (let j = 0; j < chunk.length; j++) mine.push(await assetStateAtV3(rpc, chunk[j], S, { slot: cur.slot, info: cur.infos[j] ?? null }, collection));
    }
    states.push(mine);
  }
  const out: SnapshotRecordV3[] = [];
  keys.forEach((a, i) => {
    const st = states[0][i];
    for (const o of states.slice(1)) {
      if (o[i].live !== st.live || o[i].owner !== st.owner || (st.live && o[i].signature !== st.signature)) {
        throw new Error(`the two X1 RPCs disagree on asset ${a} at slot ${S} (${st.live ? st.owner : "not live"} / ${o[i].live ? o[i].owner : "not live"}): snapshot refused (X-015)`);
      }
    }
    if (!st.live) return; // recycled or burned at or before S, or forged after S
    const rec = first.get(a);
    if (!rec) throw new Error(`asset ${a} exists at slot ${S} (its history) but the finalized record list at S omits it: snapshot refused (X-015)`);
    out.push({
      asset: a, tier: Number(rec.account.tier), owner: st.owner!, backing: bnStr(rec.account.backing), origin: Number(rec.account.origin), forgedAt: Number(bnStr(rec.account.forgedAt)),
    });
  });
  out.sort((x, y) => (x.asset < y.asset ? -1 : x.asset > y.asset ? 1 : 0));
  const blockTime = await connection.getBlockTime(S);
  return { slot: S, blockTime, records: out };
}

/**
 * The free reward pool (vault lamports − rent − Config.reward_reserved) with its slot. The vault and Config are read in
 * ONE call, so both come from the same slot: read apart (the vault at "finalized", Config at the provider's
 * "confirmed"), every claim of the last ~13 s was missing from the vault but already out of reward_reserved, and F was
 * overstated by its amount (the localnet e2e, tests/e2e-oracle-v3.sh, found it). `commitment` "confirmed" is the live
 * pool the publish gate compares with, just before sending.
 */
export async function freePoolV3(connection: Connection, program: anchor.Program, commitment: Commitment = "finalized"): Promise<{ lamports: string; slot: number }> {
  const { context, value } = await connection.getMultipleAccountsInfoAndContext([PDA.rewardVault(), PDA.config()], commitment);
  const [vault, config] = value;
  if (!config) throw new Error(`Config ${PDA.config().toBase58()} is missing at slot ${context.slot}`);
  const cfg = program.coder.accounts.decode(accountNameIn(program, "Config") ?? "config", config.data);
  const rent = vault ? await connection.getMinimumBalanceForRentExemption(vault.data.length) : 0;
  const free = BigInt(vault?.lamports ?? 0) - BigInt(rent) - BigInt(bnStr(cfg.rewardReserved));
  return { lamports: (free > 0n ? free : 0n).toString(), slot: context.slot };
}

/**
 * The EpochPublished record of an epoch: the event parsed from its publish transaction (the one in the file, or the
 * first transaction of the Epoch PDA), its slot and block time, plus the Epoch account's published_at, net budget and
 * rate cap. Null when the transaction cannot be found.
 */
export async function readEpochPublishedV3(connection: Connection, program: anchor.Program, epochId: number, tx?: string, commitment: "confirmed" | "finalized" = "finalized"): Promise<PublishedRecordV3 | null> {
  let sig = tx;
  if (!sig) {
    // A12 (P6): the Epoch PDA is an account of every claim, close_receipt, seal_drop, claim_drop and expire_epoch, so
    // its publish transaction (the oldest: publish_epoch creates the PDA) can be past the first 1,000: page to the end
    sig = oldestSignature(await signaturePages((before) => connection.getSignaturesForAddress(PDA.epoch(epochId), { limit: 1000, before }, commitment))) ?? undefined;
    if (!sig) return null;
  }
  // the publish transaction's logs never change once confirmed: reading it at "confirmed" (P7) spares the ~13 s of
  // finality lag right after the publication; verify reads it at "finalized"
  const t = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment });
  if (!t || !t.meta || t.meta.err) return null;
  const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl as anchor.Idl));
  let ev: any = null;
  for (const e of parser.parseLogs(t.meta.logMessages ?? [], false)) {
    if (e.name === "EpochPublished" || e.name === "epochPublished") ev = e.data;
  }
  if (!ev || Number(bnStr(ev.epoch)) !== epochId) return null;
  const hex = (x: number[] | Uint8Array) => Buffer.from(x).toString("hex");
  let account: any = null;
  try {
    account = await (program.account as any).epoch.fetchNullable(PDA.epoch(epochId));
  } catch {
    account = null;
  }
  return {
    tx: sig, slot: t.slot, blockTime: t.blockTime ?? null, epoch: epochId, root: hex(ev.root), dataHash: hex(ev.dataHash), totalScore: bnStr(ev.totalScore),
    leaves: Number(ev.leaves), budget: bnStr(ev.budget), dropReserve: bnStr(ev.dropReserve), dropSlot: bnStr(ev.dropSlot), freePoolBefore: bnStr(ev.freePoolBefore),
    publishedAt: account ? Number(bnStr(account.publishedAt)) : null, netBudget: account ? bnStr(account.budget) : null, rateCap: account ? bnStr(account.rateCap) : null,
  };
}

/** Pages getSignaturesForAddress (newest first, 1,000 per page) until a short page; at most `maxPages` pages. */
export async function signaturePages<S extends { signature: string }>(page: (before: string | undefined) => Promise<S[]>, maxPages = 50): Promise<S[]> {
  const all: S[] = [];
  let before: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const got = await page(before);
    all.push(...got);
    if (got.length < 1000) return all;
    before = got[got.length - 1].signature;
  }
  throw new Error(`more than ${maxPages * 1000} signatures: the oldest one could not be reached`);
}

/** The oldest successful signature of a newest-first list (the creating transaction of a PDA). */
export function oldestSignature(sigs: { signature: string; err?: unknown }[]): string | null {
  const ok = sigs.filter((s) => !s.err);
  return ok.length ? ok[ok.length - 1].signature : null;
}

/** What publish_epoch and the claims need of a v3 (or v2) file. */
export interface PublishableV3 {
  epoch: number;
  root: string;
  dataHash: string;
  totalScore: string;
  leaves: { player: string; tier: number; score: string }[];
  rateCap: string;
  proofs: Record<string, string[]>;
}

export async function publishEpochV3(program: anchor.Program, oracle: Keypair, f: PublishableV3): Promise<string> {
  // A13.4: a provisional dry-run file is never published, whoever calls this; A13.11 (review R5): nor a v3 file whose
  // window is shorter than MIN_WINDOW (a provisional file stripped of its member and re-hashed) or that has no window
  const refused = publishableError(f);
  if (refused) throw new Error(`refusing to publish epoch ${f.epoch}: ${refused}`);
  // T2-RULES: a v3 file records the rules it was built under, for the binary the verdict below accepts (R-7 pin)
  const rules = publishRulesErrorV3(f);
  if (rules) throw new Error(`refusing to publish epoch ${f.epoch}: ${rules}`);
  // W2-4: a v3 base epoch is published only on the upgraded binary (drop reserve 0, claim hold, v3 tip rules), checked
  // read-only right before sending; the v3 client is required (its coder decodes the upgraded-only accounts)
  requireV3Program(program, `refusing to publish epoch ${f.epoch}`);
  await assertUpgradedV3(program.provider.connection, program, `to publish v3 epoch ${f.epoch}`);
  // CF-22 / X-160 / T8-4: never more than MAX_PUBLISH_LAG after the build's snapshot, whatever path built or kept the
  // file: X1's own clock (a finalized slot's block time on the default endpoint) is read right before sending, and an
  // unreadable clock refuses (fail closed). The run's gate rebuilds such a file on a fresh snapshot instead.
  const aged = publishAgeError(f as { epoch: number; window?: { endTs?: unknown } }, await x1NowV3(program.provider.connection));
  if (aged) throw new Error(`refusing to publish: ${aged} (CF-22)`);
  return program.provider.sendAndConfirm!(await publishEpochTxV3(program, oracle.publicKey, f), [oracle]);
}

/**
 * The publish_epoch transaction of a v3 file (pure builder, no read): (epoch, root, data hash, total score, leaf count,
 * rate cap) from the file, so a heartbeat (round 4) goes out exactly in forge.rs epoch_shape's form (total 0, 0 leaves,
 * rate cap 0, the all-zero root). D-47: the same 108 B and the same five accounts as the live binary, with the reward
 * vault WRITABLE: the upgraded program then pays the oracle allowance (the Epoch rent back + a top-up to 0.25 XNT of at
 * most 0.05 XNT) inside the 10% bound. The IDL keeps the vault read-only (the live account list), so a client that passes
 * it read-only still publishes and simply receives no allowance.
 */
export async function publishEpochTxV3(program: anchor.Program, oracle: PublicKey, f: PublishableV3): Promise<Transaction> {
  const tx = await program.methods
    .publishEpoch(new anchor.BN(f.epoch), Array.from(Buffer.from(f.root, "hex")), Array.from(Buffer.from(f.dataHash, "hex")), new anchor.BN(f.totalScore), f.leaves.length, new anchor.BN(f.rateCap))
    .accountsPartial({ config: PDA.config(), epoch: PDA.epoch(f.epoch), rewardVault: PDA.rewardVault(), oracle, systemProgram: SystemProgram.programId })
    .transaction();
  markWritable(tx.instructions[tx.instructions.length - 1], PDA.rewardVault());
  return tx;
}

/**
 * T2-RULES, pure: null when a file sent to publish_epoch on the upgraded program carries a rules block whose
 * programHash is the pinned S2 binary's (UPGRADED_ELF, null while nothing is pinned), else why not.
 */
export function publishRulesErrorV3(f: unknown, pin: { sha256: string; bytes: number } | null = UPGRADED_ELF): string | null {
  const rb = f && typeof f === "object" ? (f as { rulesBlock?: unknown }).rulesBlock : undefined;
  if (!rb || typeof rb !== "object") return "a v3 file without a rules block is never published (T2-RULES)";
  const hash = (rb as { programHash?: unknown }).programHash;
  const want = pin ? pin.sha256 : null;
  if (hash !== want) return `the file's rules block names program ${JSON.stringify(hash)}, not the pinned S2 binary ${JSON.stringify(want)} (R-7)`;
  return null;
}

/** CF-22: X1's clock now, the block time of the newest finalized slot on the default endpoint; null when unreadable (fail closed). */
export async function x1NowV3(connection0: Connection, tries = 3): Promise<number | null> {
  const connection = trustedConnectionFor(connection0);
  for (let i = 0; i < tries; i++) {
    try {
      const slot = await connection.getSlot("finalized");
      const t = await connection.getBlockTime(slot);
      if (typeof t === "number" && Number.isSafeInteger(t) && t >= 0) return t;
    } catch {
      // retried below
    }
    if (i + 1 < tries) await new Promise((r) => setTimeout(r, 1_000));
  }
  return null;
}

/** D-47: the account meta of `key` in `ix` becomes writable (publish_epoch's reward vault); throws if it is absent. */
export function markWritable(ix: TransactionInstruction, key: PublicKey): void {
  const meta = ix.keys.find((k) => k.pubkey.equals(key));
  if (!meta) throw new Error(`account ${key.toBase58()} is not in the instruction`);
  meta.isWritable = true;
}

// ── D-47: publication keeps priority over the automatic claims ───────────────────────────────────────────────────
/**
 * D-47 (owner sheet): each publication refunds the Epoch rent and tops the oracle wallet up towards 0.25 XNT with at
 * most 0.05 XNT (publishEpochV3, forge.rs oracle_allowance), but nothing else pays the oracle, so a week of many
 * automatic claims can still spend more than one top-up brings. The order is fixed: the AUTOMATIC CLAIMS it pays for (a
 * fee plus the ClaimReceipt / Mission rents each) stop first, and the publications go on with what is left (each one
 * refilling the wallet a little), until someone tops the wallet up or takes the seat.
 * This much always stays for publishing: 0.05 XNT, the health check's red floor for the oracle wallet
 * (health-rules ORACLE_MIN_LAMPORTS; a weekly publication costs about 0.01 XNT: the Epoch and ExtraEpoch rents and two
 * fees). Burners can always claim their own leaf themselves.
 */
export const ORACLE_PUBLISH_RESERVE = 50_000_000n;
/** the most one automatic claim costs its payer, rounded up: the fee plus the ClaimReceipt and Mission rents */
export const CLAIM_COST_MAX = 10_000_000n;

/** D-47, pure: a claim paid by the oracle wallet may go out only while the wallet keeps the publish reserve after it. */
export function claimFundsOkV3(balance: bigint, reserve: bigint = ORACLE_PUBLISH_RESERVE, cost: bigint = CLAIM_COST_MAX): boolean {
  return balance >= reserve + cost;
}

/** The D-47 guard of one automatic claim loop (one pass). `stopped` keeps the reason once the claims stopped. */
export interface ClaimGuardV3 {
  /** null = the next claim may go out; else why the automatic claims stopped (the loop stops) */
  check(): Promise<string | null>;
  readonly stopped: string | null;
  /** true when the payer is (or is taken to be) the oracle key, the only one the guard holds back */
  readonly isOracle: boolean;
}

const xntStr = (l: bigint) => (Number(l) / 1e9).toFixed(4);

/**
 * D-47: the guard of an automatic claim loop. A payer that is not Config.oracle publishes nothing and is never held back.
 * The oracle key (or any payer when Config.oracle could not be read, `oracle` null: assumed to be the oracle) re-reads
 * its balance before every claim, and the loop stops for good (this pass) once a claim would leave less than the
 * publish reserve, or the balance cannot be read (fail closed). The publication paths never ask it.
 */
export function claimGuardV3(connection: { getBalance(pk: PublicKey, c?: Commitment): Promise<number> }, payer: PublicKey, oracle: PublicKey | string | null, reserve: bigint = ORACLE_PUBLISH_RESERVE): ClaimGuardV3 {
  const isOracle = oracle === null || payer.toBase58() === (typeof oracle === "string" ? oracle : oracle.toBase58());
  let stopped: string | null = null;
  return {
    isOracle,
    get stopped() {
      return stopped;
    },
    async check() {
      if (!isOracle || stopped) return stopped;
      let bal: bigint;
      try {
        bal = BigInt(await connection.getBalance(payer, "confirmed"));
      } catch (e) {
        stopped = `D-47: the oracle wallet's balance could not be read (${String((e as Error)?.message ?? e).slice(0, 120)}): automatic claims stopped, publication keeps priority`;
        return stopped;
      }
      if (!claimFundsOkV3(bal, reserve)) {
        stopped = `D-47: the oracle wallet holds ${xntStr(bal)} XNT, under the ${xntStr(reserve)} XNT kept for publishing plus one claim (${xntStr(CLAIM_COST_MAX)} XNT): automatic claims stopped, publication keeps priority (each burner can claim their own leaf)`;
      }
      return stopped;
    },
  };
}

/**
 * Claims every not-yet-claimed leaf of a v3 file for its burner (A11: dust leaves too, so a wallet with no XNT is still
 * paid; X-027). Counts the claims that paid a keeper tip by the upgraded program's rule (keeperTipDue: the claim, from
 * the Epoch account's budget, at or above 0.2 XNT and the payer neither the player nor Config.oracle: a claim the oracle
 * submits never earns one) and the others ("dust": no tip, the burner is paid all the same).
 */
export async function claimLeavesV3(connection: Connection, program: anchor.Program, payer: Keypair, f: PublishableV3, log = console.log): Promise<{ claimed: number; tipped: number; dust: number; failed: number; stopped: string | null }> {
  const ts = BigInt(f.totalScore);
  // the claim the program pays: ⌊score × Epoch.budget / totalScore⌋ (the file's plan, budget = totalScore, when unreadable)
  const acc = program.account as any;
  const ep = await acc.epoch.fetchNullable(PDA.epoch(f.epoch)).catch(() => null);
  const cfg = await acc.config.fetch(PDA.config()).catch(() => null);
  const oracle: string | null = cfg ? (cfg.oracle as PublicKey).toBase58() : null;
  const { claims } = ep && BigInt(bnStr(ep.totalScore)) === ts
    ? { claims: f.leaves.map((l) => (ts === 0n ? 0n : (BigInt(l.score) * BigInt(bnStr(ep.budget))) / ts)) }
    : programClaims(f.leaves.map((l) => BigInt(l.score)), ts, ts * 10n);
  let claimed = 0;
  let tipped = 0;
  let dust = 0;
  let failed = 0;
  // D-47: the oracle's own claims stop before its wallet is too low to publish (Config unreadable: taken as the oracle)
  const guard = claimGuardV3(connection, payer.publicKey, oracle);
  for (let i = 0; i < f.leaves.length; i++) {
    const l = f.leaves[i];
    const player = new PublicKey(l.player);
    const receipt = PDA.receipt(f.epoch, player, l.tier);
    if (await connection.getAccountInfo(receipt)) continue;
    const stop = await guard.check();
    if (stop) {
      log(`  ${stop}`);
      break;
    }
    const proof = (f.proofs[`${l.player}:${l.tier}`] || []).map((h) => Array.from(Buffer.from(h, "hex")));
    const common = {
      config: PDA.config(), epoch: PDA.epoch(f.epoch), receipt, player, playerState: PDA.player(player), rewardVault: PDA.rewardVault(), payer: payer.publicKey, systemProgram: SystemProgram.programId,
    };
    // with Config.oracle unreadable the oracle's own key is assumed: no tip is ever counted that the program would not pay
    const tip = keeperTipDue({ version: 3, payer: payer.publicKey.toBase58(), player: l.player, oracle: oracle ?? payer.publicKey.toBase58(), claim: claims[i] });
    try {
      const m = l.tier === 0
        ? program.methods.claimInstant(new anchor.BN(f.epoch), l.tier, new anchor.BN(l.score), proof).accountsPartial(common)
        : program.methods.claimMission(new anchor.BN(f.epoch), l.tier, new anchor.BN(l.score), proof).accountsPartial({ ...common, mission: PDA.mission(f.epoch, player, l.tier) });
      const sig = await m.signers([payer]).rpc();
      claimed++;
      if (tip) tipped++;
      else dust++;
      log(`  claimed ${l.player} tier ${l.tier}${tip ? "" : " (dust, no keeper tip)"}: ${sig}`);
    } catch (e) {
      failed++;
      log(`  claim failed for ${l.player} tier ${l.tier}: ${String(e).slice(0, 200)}`);
    }
  }
  return { claimed, tipped, dust, failed, stopped: guard.stopped };
}

/**
 * close_receipt sweep (SPEC-v3 §7 step 7): closes the ClaimReceipts the payer paid rent for in CLOSED epochs, so the rent
 * comes back. close_receipt requires epoch.closed (forge.rs), so an epoch past expires_at that the keeper has not expired
 * yet is left for a later sweep (P10: it would only fail with ClaimWindowOpen). Permissionless per receipt.
 */
export const sweepableEpoch = (e: { closed: boolean }) => e.closed;

/** A pass budget (keeper-v3 TxBudget): the sweep stops when it is spent, and every close counts against it (R-1). */
export interface SendBudgetV3 {
  canSend(): boolean;
  send(label: string, fn: () => Promise<string>): Promise<boolean>;
}

export async function sweepReceiptsV3(connection: Connection, program: anchor.Program, payer: Keypair, log = console.log, run?: SendBudgetV3): Promise<number> {
  const acc = program.account as any;
  const over = new Map<number, PublicKey>();
  for (const e of await acc.epoch.all()) {
    if (sweepableEpoch({ closed: !!e.account.closed })) over.set(Number(bnStr(e.account.id)), e.publicKey as PublicKey);
  }
  if (!over.size) return 0;
  // ClaimReceipt: disc 8 | epoch u64 | player 32 | tier u8 | amount u64 | rent_payer 32
  const mine: any[] = await acc.claimReceipt.all([{ memcmp: { offset: 8 + 8 + 32 + 1 + 8, bytes: payer.publicKey.toBase58() } }]);
  let done = 0;
  for (const r of mine) {
    const epochPk = over.get(Number(bnStr(r.account.epoch)));
    if (!epochPk) continue;
    const close = () => program.methods.closeReceipt().accountsPartial({ epoch: epochPk, receipt: r.publicKey, rentPayer: payer.publicKey }).signers([payer]).rpc();
    if (run) {
      // R-1 (2): bounded by the pass, like every other loop of the keeper (the rest waits for the next sweep)
      if (!run.canSend()) break;
      if (await run.send(`close_receipt ${(r.publicKey as PublicKey).toBase58()}`, close)) done++;
      continue;
    }
    try {
      await close();
      done++;
    } catch (e) {
      log(`  close_receipt ${(r.publicKey as PublicKey).toBase58()}: ${String(e).slice(0, 160)}`);
    }
  }
  if (done) log(`  closed ${done} claim receipts of expired epochs (rent returned)`);
  return done;
}

/**
 * The last Core transaction of each asset at or before `slot` (base58 signature), for the extra snapshot (A10.3). Pages
 * back (1,000 per page, newest first) until it reaches the slot, so a rebuild long after the slot (A13.7) finds the same
 * signature the build found right after it; an asset with no transaction at or before the slot is absent.
 */
export async function assetSignaturesV3(connection: Connection, assets: string[], slot: number, maxPages = 50): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const a of assets) {
    let before: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const sigs = await connection.getSignaturesForAddress(new PublicKey(a), { limit: 1000, before }, "finalized");
      const at = sigs.find((s) => !s.err && s.slot <= slot);
      if (at) {
        out[a] = at.signature;
        break;
      }
      if (sigs.length < 1000) break;
      before = sigs[sigs.length - 1].signature;
    }
  }
  return out;
}

/** A13.7: ArtifactRecord.forged_at of each asset whose record still exists (immutable); a recycled asset is absent. */
export async function artifactForgedAtV3(program: anchor.Program, assets: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const acc = program.account as any;
  for (let i = 0; i < assets.length; i += 100) {
    const chunk = assets.slice(i, i + 100);
    const recs: any[] = await acc.artifactRecord.fetchMultiple(chunk.map((a) => PDA.artifact(new PublicKey(a))), "finalized");
    chunk.forEach((a, j) => {
      if (recs[j]) out[a] = Number(bnStr(recs[j].forgedAt));
    });
  }
  return out;
}

/** ExtraEpochPublished(epoch) as the oracle reads it back: the event, its transaction, and the ExtraEpoch account. */
export interface PublishedExtraRecordV3 extends PublishedExtra {
  /** the publish transaction; null when the event could not be found and the values come from the account alone */
  tx: string | null;
  slot: number | null;
  /** ExtraEpoch.published_at; null once the account is closed (close_extra_epoch, 90 days) */
  publishedAt: number | null;
  closed: boolean | null;
}

/** the most signatures of an ExtraEpoch PDA scanned (oldest first) for its ExtraEpochPublished event */
export const EXTRA_EVENT_SCAN_MAX = 25;

/**
 * A13.7 / A11-a: ExtraEpochPublished(epoch), read back from the chain (read-only, "finalized" by default). Null when the
 * extra epoch was never published: no ExtraEpoch account and no transaction ever touched its PDA. Otherwise:
 *  - the account (while it exists) gives root, data_hash, budget, leaves and free_before; free_after = free_before −
 *    budget exactly (extra.rs extra_publish_core: reserved += total, free_after = accounted − reserved);
 *  - the event is looked for in the PDA's oldest successful transactions (publish_extra_epoch creates the PDA; a
 *    lamport transfer to the address before it does not fool the reader, the event must be in the logs of THIS program)
 *    and gives `weeks`; it must agree with the account on every field, else this throws;
 *  - a PDA with transactions but neither an account nor an event, or an event that disagrees, throws: never a guess.
 * The upgraded program only; the caller asks only once the upgrade is detected (readExtraPotV3).
 */
export async function readExtraPublishedV3(connection: Connection, program: anchor.Program, epoch: number, commitment: "confirmed" | "finalized" = "finalized"): Promise<PublishedExtraRecordV3 | null> {
  requireV3Program(program, "ExtraEpochPublished");
  const pda = PDA_V3.extraEpoch(epoch);
  const acc: any = await (program.account as any).extraEpoch.fetchNullable(pda, commitment);
  const hex = (x: number[] | Uint8Array) => Buffer.from(x).toString("hex");
  const fromAccount = acc
    ? (() => {
        const before = BigInt(bnStr(acc.freeBefore));
        const budget = BigInt(bnStr(acc.budget));
        if (Number(bnStr(acc.id)) !== epoch) throw new Error(`ExtraEpoch(${epoch}) holds id ${bnStr(acc.id)}`);
        if (budget > before) throw new Error(`ExtraEpoch(${epoch}): budget ${budget} above free_before ${before}`);
        return { epoch, root: hex(acc.root), dataHash: hex(acc.dataHash), total: budget.toString(), leaves: Number(acc.leaves), freeBefore: before.toString(), freeAfter: (before - budget).toString() };
      })()
    : null;
  // oldest first: the publish transaction is the first one of the PDA that carries the event
  const sigs = (await signaturePages((b) => connection.getSignaturesForAddress(pda, { limit: 1000, before: b }, commitment))).filter((s) => !s.err).reverse();
  if (!acc && !sigs.length) return null;
  let ev: PublishedExtra | null = null;
  let at: { tx: string; slot: number } | null = null;
  for (const s of sigs.slice(0, EXTRA_EVENT_SCAN_MAX)) {
    const t = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment });
    if (!t || !t.meta || t.meta.err) continue;
    const e = extraPublishedFromLogsV3(program, t.meta.logMessages ?? []);
    if (e && e.epoch === epoch) {
      ev = e;
      at = { tx: s.signature, slot: t.slot };
      break;
    }
  }
  if (!ev && !fromAccount) throw new Error(`ExtraEpoch(${epoch}): its PDA has ${sigs.length} transaction(s) but no account and no ExtraEpochPublished event could be read: unknown, never assumed unpublished`);
  if (ev && fromAccount) {
    for (const k of ["root", "dataHash", "total", "leaves", "freeBefore", "freeAfter"] as const) {
      if (String(ev[k]) !== String(fromAccount[k])) throw new Error(`ExtraEpoch(${epoch}): the event's ${k} ${ev[k]} differs from the account's ${fromAccount[k]}`);
    }
  }
  const v = ev ?? fromAccount!;
  return { ...v, weeks: ev?.weeks, tx: at?.tx ?? null, slot: at?.slot ?? null, publishedAt: acc ? Number(bnStr(acc.publishedAt)) : null, closed: acc ? !!acc.closed : null };
}

/** The extra pot as the oracle sees it: detected (W2-4 verdict) and, once live, the ExtraState counters. */
export interface ExtraPotV3 {
  /** true only on the upgraded binary (verdict "upgraded"); false on the live v2 binary (verdict "legacy") */
  live: boolean;
  verdict: UpgradeVerdictV3["status"];
  /** ExtraState now (null before the upgrade) */
  state: (ExtraStateV3 & { freeAfter: bigint }) | null;
}

/**
 * Detection of the extra pot (DETECTION RULE): live exactly when the W2-4 probe says "upgraded" (deploy slot after
 * 85,429,880, ExtraState and OracleSeat present and decoding). "legacy" = not live (every extra file stays a budget-0
 * heartbeat, as before the upgrade). "unknown" (a half-done upgrade, an RPC error) throws: the oracle never guesses
 * whether X is 0 (A13.8).
 */
export async function readExtraPotV3(connection: Connection, program: anchor.Program): Promise<ExtraPotV3> {
  requireV3Program(program, "the extra pot");
  let probe: UpgradeProbeV3;
  try {
    probe = await readUpgradeProbeV3(connection);
  } catch (e) {
    probe = { deploySlot: null, extraState: null, oracleSeat: null, houseKeeper: null, error: `RPC error: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
  }
  const v = upgradeVerdictV3(probe, program);
  if (v.status === "unknown") throw new Error(`the extra pot cannot be detected (unknown: ${v.reasons.join("; ")}): nothing extra is built or published (W2-4, A13.8)`);
  if (v.status === "legacy") return { live: false, verdict: "legacy", state: null };
  const d = program.coder.accounts.decode(accountNameIn(program, "ExtraState")!, probe.extraState!.data);
  return { live: true, verdict: "upgraded", state: { ...extraStateOf(d), freeAfter: BigInt(bnStr(d.freeAfter)) } };
}

/**
 * The first extra epoch of the CHAIN (EXTRA_FIRST_EPOCH, derived instead of pinned by hand): init_extra sets
 * ExtraState.last_epoch = Config.last_epoch and every publication must be last_epoch + 1, so
 *  - nothing published yet (ExtraEpoch(L) never published, L = ExtraState.last_epoch): the first is L + 1;
 *  - otherwise the history's own first epoch `claimed` is confirmed (published, and its predecessor never was), or,
 *    without a claim, found by walking back from L (at most `maxWalk` epochs).
 * `published` is readExtraPublishedV3 (injected for tests). Any read error throws.
 */
export async function extraFirstEpochOnChainV3(state: { lastEpoch: bigint }, published: (epoch: number) => Promise<unknown | null>, claimed: number | null = null, maxWalk = 600): Promise<number> {
  const L = Number(state.lastEpoch);
  if (L === 0 || !(await published(L))) return L + 1;
  if (claimed !== null) {
    if (!Number.isSafeInteger(claimed) || claimed < 1 || claimed > L) throw new Error(`the extra history starts at epoch ${claimed}, outside the chain's published extra epochs (≤ ${L})`);
    if (!(await published(claimed))) throw new Error(`the extra history starts at epoch ${claimed}, but ExtraEpoch(${claimed}) was never published on-chain`);
    if (claimed > 1 && (await published(claimed - 1))) throw new Error(`the extra history starts at epoch ${claimed}, but the chain's extra history starts earlier (ExtraEpoch(${claimed - 1}) is published)`);
    return claimed;
  }
  let k = L;
  for (let i = 0; k > 1 && (await published(k - 1)); i++) {
    if (i >= maxWalk) throw new Error(`more than ${maxWalk} published extra epochs before ${L}: the first one was not found`);
    k--;
  }
  return k;
}

/**
 * X of the first extra epoch (A11-a, "the X read at init_extra"): init_extra writes free_after = 0 with accounted = 0
 * (extra.rs init_extra), so the free extra pot at init_extra is 0 and the first extra epoch is a heartbeat (nothing is
 * eligible without S(n−1) either, A10-a). While nothing is published yet the live ExtraState.free_after is still that
 * value: it is read and must be 0, else the chain is not what the program writes and this throws.
 */
export function initExtraXV3(pot: ExtraPotV3, firstEpoch: number): string {
  if (!pot.live || !pot.state) throw new Error("the extra pot is not live: X of the first extra epoch is not read from init_extra");
  if (Number(pot.state.lastEpoch) + 1 === firstEpoch && pot.state.freeAfter !== 0n) {
    throw new Error(`ExtraState.free_after is ${pot.state.freeAfter} before any extra publication; init_extra writes 0: refusing to guess X`);
  }
  return "0";
}

/** the most of ExtraState's oldest successful transactions scanned for its init_extra (OD-9) */
export const EXTRA_INIT_SCAN_MAX = 25;

/** the 8-byte discriminator of a v3 instruction (snake_case IDL name) */
function ixDiscriminatorV3(program: anchor.Program, name: string): Buffer {
  const ix = ((program.rawIdl as anchor.Idl).instructions ?? []).find((i) => i.name === name);
  if (!ix || !ix.discriminator) throw new Error(`the v3 IDL has no instruction ${name}`);
  return Buffer.from(ix.discriminator);
}

/**
 * OD-9: the init_extra mark of one transaction (getTransaction form): {ts: its block time, tx} when it succeeded and ran
 * THIS program's init_extra (top level or by CPI), else null. A success without a block time throws (never a guess).
 */
export function initExtraMarkOfTxV3(program: anchor.Program, signature: string, t: { blockTime?: number | null; transaction: { message: any }; meta: any } | null): ExtraInitMark | null {
  if (!t || !t.meta || t.meta.err) return null;
  const disc = ixDiscriminatorV3(program, "init_extra");
  const id = program.programId.toBase58();
  if (!txInstructionsV3(t).some((ix) => ix.program === id && ix.data.length >= 8 && ix.data.subarray(0, 8).equals(disc))) return null;
  if (typeof t.blockTime !== "number" || !Number.isSafeInteger(t.blockTime) || t.blockTime < 0) throw new Error(`the init_extra transaction ${signature} has no block time: the pre-upgrade boundary is unknown (OD-9)`);
  return { ts: t.blockTime, tx: signature };
}

/**
 * OD-9: the extra pot's creation, read back from the chain (read-only, "finalized"): the oldest successful transaction
 * of the ExtraState PDA that ran this program's init_extra (a lamport transfer to the address before it does not count;
 * init_extra can succeed only once), with its block time: the pre-upgrade boundary of every extra file. Null when
 * ExtraState does not exist (the program is not upgraded); throws when it exists and no init_extra is found among its
 * oldest EXTRA_INIT_SCAN_MAX transactions, or a read fails (fail closed).
 */
export async function readExtraInitV3(connection: Connection, program: anchor.Program, maxPages = 50): Promise<ExtraInitMark | null> {
  requireV3Program(program, "init_extra");
  const pda = PDA_V3.extraState();
  const acc = await connection.getAccountInfo(pda, "finalized");
  if (!acc) return null;
  const sigs = (await signaturePages((b) => connection.getSignaturesForAddress(pda, { limit: 1000, before: b }, "finalized"), maxPages)).filter((s) => !s.err).reverse();
  for (const s of sigs.slice(0, EXTRA_INIT_SCAN_MAX)) {
    const t = await connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
    if (!t) throw new Error(`transaction ${s.signature} of ExtraState cannot be read: the init_extra mark is unknown (OD-9)`);
    const m = initExtraMarkOfTxV3(program, s.signature, t as never);
    if (m) return m;
  }
  throw new Error(`ExtraState exists but no init_extra was found in its ${Math.min(sigs.length, EXTRA_INIT_SCAN_MAX)} oldest transaction(s): the pre-upgrade boundary is unknown (OD-9)`);
}

/** `verify --full` (OD-9): the file's init_extra mark against the chain: the transaction ran init_extra at that block time. */
export async function verifyExtraInitV3(connection: Connection, program: anchor.Program, mark: ExtraInitMark): Promise<string[]> {
  const t = await connection.getTransaction(mark.tx, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
  if (!t) return [`pool.init: transaction ${mark.tx} is not on X1 (finalized)`];
  let m: ExtraInitMark | null;
  try {
    m = initExtraMarkOfTxV3(program, mark.tx, t as never);
  } catch (e) {
    return [`pool.init: ${String((e as Error)?.message ?? e)}`];
  }
  if (!m) return [`pool.init: transaction ${mark.tx} did not run this program's init_extra`];
  return m.ts === mark.ts ? [] : [`pool.init.ts ${mark.ts} is not the block time of init_extra (${m.ts})`];
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// W2-4: the upgraded-binary guard. Before ANY v3 publication (base or extra) the oracle checks, read-only, that the live
// program is the upgraded binary; anything else (the live v2 binary, a half-done upgrade, an RPC error) refuses.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** ProgramData last-deploy slot of the live v2 binary (tag program-2026-10-12, deployed 2026-10-12). */
export const LIVE_DEPLOY_SLOT = 85_429_880;
export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** 8 + INIT_SPACE of the upgraded-only accounts (state.rs: ExtraState bump @89, OracleSeat bump @156). */
export const EXTRA_STATE_SIZE = 90;
export const ORACLE_SEAT_SIZE = 157;

export interface ProbedAccountV3 {
  owner: PublicKey;
  data: Buffer;
}

/** What the guard reads (read-only): the ProgramData header and the upgraded-only PDAs. */
export interface UpgradeProbeV3 {
  /** ProgramData last-deploy slot, null when unreadable */
  deploySlot: number | null;
  extraState: ProbedAccountV3 | null;
  oracleSeat: ProbedAccountV3 | null;
  /** informational: created by arm_keeper, not needed to publish */
  houseKeeper: ProbedAccountV3 | null;
  /** an RPC or layout error: the verdict is "unknown" */
  error?: string;
  /** R-7: the deployed ELF's sha256 (deployedElfV3), read only when UPGRADED_ELF is pinned; null = not the pinned length */
  elfSha256?: string | null;
}

export interface UpgradeVerdictV3 {
  /**
   * upgraded: every check passed. legacy: exactly the live v2 state (deploy slot 85,429,880, no upgraded-only PDA).
   * unknown: anything else (a half-done upgrade, an unreadable answer, a PDA that does not decode). Only "upgraded"
   * lets a v3 publication through.
   */
  status: "upgraded" | "legacy" | "unknown";
  reasons: string[];
  deploySlot: number | null;
}

/**
 * Reads the probe: the program account, a 45-byte slice of ProgramData, the three PDAs (one commitment). R-5: always
 * from the default endpoint (trustedConnectionFor), never an X1_RPC_URLS entry, which could fake ProgramData and the
 * PDAs and flip the verdict.
 */
export async function readUpgradeProbeV3(connection0: Connection, commitment: Commitment = "finalized", pin: { sha256: string; bytes: number } | null = UPGRADED_ELF): Promise<UpgradeProbeV3> {
  const connection = trustedConnectionFor(connection0);
  const empty: UpgradeProbeV3 = { deploySlot: null, extraState: null, oracleSeat: null, houseKeeper: null };
  const prog = await connection.getAccountInfo(programId, commitment);
  if (!prog) return { ...empty, error: `the program account ${programId.toBase58()} is missing` };
  if (!prog.owner.equals(BPF_LOADER_UPGRADEABLE) || prog.data.length < 36 || prog.data.readUInt32LE(0) !== 2) {
    return { ...empty, error: "the program account is not an upgradeable-loader Program account" };
  }
  const programData = new PublicKey(prog.data.subarray(4, 36));
  const head = await connection.getAccountInfo(programData, { commitment, dataSlice: { offset: 0, length: 45 } });
  if (!head || !head.owner.equals(BPF_LOADER_UPGRADEABLE) || head.data.length < 12 || head.data.readUInt32LE(0) !== 3) {
    return { ...empty, error: `the ProgramData account ${programData.toBase58()} is missing or not a ProgramData account` };
  }
  const deploySlot = Number(head.data.readBigUInt64LE(4));
  const [x, s, k] = await connection.getMultipleAccountsInfo([PDA_V3.extraState(), PDA_V3.oracleSeat(), PDA_V3.houseKeeper()], commitment);
  const pick = (a: { owner: PublicKey; data: Buffer } | null): ProbedAccountV3 | null => (a ? { owner: a.owner, data: Buffer.from(a.data) } : null);
  // R-7: with the S2 build pinned, the deployed ELF itself (hashed once per deploy slot: the account is about 1 MB)
  const elf = pin && deploySlot > LIVE_DEPLOY_SLOT ? await deployedElfV3(connection, programData, deploySlot, pin.bytes, commitment) : undefined;
  return { deploySlot, extraState: pick(x), oracleSeat: pick(s), houseKeeper: pick(k), ...(elf === undefined ? {} : { elfSha256: elf }) };
}

/**
 * R-7: the sha256 of the S2 reproducible build (`bytes` long) that the upgrade deploys, pinned after S2 (null until then:
 * the verdict then rests on the deploy slot and the PDAs alone, as before). With a pin, a deploy of any other ELF (a
 * rollback to the old binary, a wrong build) is "unknown": no v3 publication, no v3 keeper pass.
 */
export const UPGRADED_ELF: { sha256: string; bytes: number } | null = null;

const elfCache = new Map<string, string | null>();
/**
 * The sha256 (hex) of the first `bytes` bytes after the 45-byte ProgramData header, or null when the account is shorter
 * or anything after them is not zero (another, longer ELF). Read in full once per (ProgramData, deploy slot).
 */
export async function deployedElfV3(connection: Connection, programData: PublicKey, deploySlot: number, bytes: number, commitment: Commitment = "finalized"): Promise<string | null> {
  const key = `${programData.toBase58()}:${deploySlot}:${bytes}`;
  if (elfCache.has(key)) return elfCache.get(key)!;
  const acc = await connection.getAccountInfo(programData, commitment);
  if (!acc) throw new Error(`the ProgramData account ${programData.toBase58()} could not be read in full`);
  const data = Buffer.from(acc.data);
  if (data.length < 4 + 8 + 1 || Number(data.readBigUInt64LE(4)) !== deploySlot) throw new Error("the ProgramData account changed while it was read");
  const body = data.subarray(45);
  const out = body.length < bytes || body.subarray(bytes).some((b) => b !== 0) ? null : createHash("sha256").update(body.subarray(0, bytes)).digest("hex");
  elfCache.set(key, out);
  return out;
}

/** The coder's name of an IDL account (anchor camelCases the IDL it builds the coder from), or null when absent. */
function accountNameIn(program: anchor.Program, name: string): string | null {
  return ((program.idl as anchor.Idl).accounts ?? []).find((a) => a.name.toLowerCase() === name.toLowerCase())?.name ?? null;
}

/**
 * Pure verdict over a probe. `program` must be the v3 client: its coder decodes the upgraded-only accounts (the
 * discriminator is checked by the decode); a v2 client has no such accounts, so it can never pass.
 */
export function upgradeVerdictV3(p: UpgradeProbeV3, program: anchor.Program, pin: { sha256: string; bytes: number } | null = UPGRADED_ELF): UpgradeVerdictV3 {
  const reasons: string[] = [];
  if (p.error) return { status: "unknown", reasons: [p.error], deploySlot: p.deploySlot };
  if (p.deploySlot === null || !Number.isSafeInteger(p.deploySlot)) reasons.push("the ProgramData last-deploy slot is unreadable");
  else if (p.deploySlot <= LIVE_DEPLOY_SLOT) reasons.push(`the ProgramData last-deploy slot ${p.deploySlot} is not after ${LIVE_DEPLOY_SLOT} (the live v2 binary)`);
  // R-7: a redeploy after S7 (a rollback, another build) keeps a new deploy slot and the PDAs: only the pinned hash tells
  else if (pin && p.elfSha256 !== pin.sha256) reasons.push(`the deployed ELF ${p.elfSha256 === undefined ? "was not read" : p.elfSha256 === null ? `is not ${pin.bytes} bytes long` : `sha256 ${p.elfSha256}`} is not the pinned S2 build ${pin.sha256} (R-7: fail closed)`);
  const check = (what: string, a: ProbedAccountV3 | null, pda: PublicKey, name: string, size: number, sane: (d: any) => string | null) => {
    if (!a) return void reasons.push(`${what} PDA ${pda.toBase58()} does not exist`);
    if (!a.owner.equals(programId)) return void reasons.push(`${what} PDA is owned by ${a.owner.toBase58()}, not the program`);
    if (a.data.length !== size) return void reasons.push(`${what} PDA has ${a.data.length} bytes, not ${size}`);
    let d: any;
    try {
      const coderName = accountNameIn(program, name);
      if (!coderName) throw new Error(`the client's IDL has no ${name} account`);
      d = program.coder.accounts.decode(coderName, a.data);
    } catch (e) {
      return void reasons.push(`${what} PDA does not decode as the upgraded program's ${name} (${String((e as Error)?.message ?? e).slice(0, 80)})`);
    }
    const bad = sane(d);
    if (bad) reasons.push(`${what}: ${bad}`);
  };
  const bumpOf = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], programId)[1];
  check("ExtraState (init_extra)", p.extraState, PDA_V3.extraState(), "ExtraState", EXTRA_STATE_SIZE, (d) =>
    Number(d.bump) !== bumpOf("extra_state") ? `bump ${d.bump} is not the PDA's` : BigInt(bnStr(d.reserved)) > BigInt(bnStr(d.accounted)) ? "reserved above accounted" : null);
  check("OracleSeat (init_seat)", p.oracleSeat, PDA_V3.oracleSeat(), "OracleSeat", ORACLE_SEAT_SIZE, (d) =>
    Number(d.bump) !== bumpOf("oracle_seat") ? `bump ${d.bump} is not the PDA's` : BigInt(bnStr(d.generation)) < 1n ? "generation 0" : null);
  if (!reasons.length) return { status: "upgraded", reasons: [], deploySlot: p.deploySlot };
  const legacy = p.deploySlot === LIVE_DEPLOY_SLOT && !p.extraState && !p.oracleSeat && !p.houseKeeper;
  return { status: legacy ? "legacy" : "unknown", reasons, deploySlot: p.deploySlot };
}

/** Reads the probe and throws unless the verdict is "upgraded" (an RPC error is "unknown": fail closed). */
export async function assertUpgradedV3(connection: Connection, program: anchor.Program, what: string): Promise<UpgradeVerdictV3> {
  let probe: UpgradeProbeV3;
  try {
    probe = await readUpgradeProbeV3(connection);
  } catch (e) {
    probe = { deploySlot: null, extraState: null, oracleSeat: null, houseKeeper: null, error: `RPC error: ${String((e as Error)?.message ?? e).slice(0, 160)}` };
  }
  const v = upgradeVerdictV3(probe, program);
  if (v.status !== "upgraded") throw new Error(`refusing ${what}: the live program is not the upgraded binary (${v.status}: ${v.reasons.join("; ")}) (W2-4)`);
  return v;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Extra pot (W2-3 final signature). Pure mirrors of extra.rs, then the instruction builders (v3 IDL only).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** EXTRA_WEEK = 7 × DAY and EXTRA_WEEK_SLACK = DAY / 4 (mainnet constants.rs; the oracle's WEEK and MAX_PUBLISH_LAG). */
export const EXTRA_WEEK = WEEK;
export const EXTRA_WEEK_SLACK = MAX_PUBLISH_LAG;
const U64_MAX = 2n ** 64n - 1n;

/**
 * extra.rs::extra_weeks_max: the most weeks extra epoch `id` may claim, from published_at of the base epochs id and
 * id − 1: min(13, max(1, ⌊(published_at − prev + 6 h)/1 week⌋)); 1 without a predecessor (epoch 1).
 */
export function extraWeeksMaxV3(publishedAt: number, prevPublishedAt: number | null): number {
  if (prevPublishedAt === null) return 1;
  if (!Number.isSafeInteger(publishedAt) || !Number.isSafeInteger(prevPublishedAt)) throw new Error("published_at is not an integer");
  const span = Math.max(0, publishedAt - prevPublishedAt + EXTRA_WEEK_SLACK);
  return Math.min(EXTRA_MAX_WEEKS, Math.max(1, Math.floor(span / EXTRA_WEEK)));
}

/** The ExtraState counters the bound reads (lamports, unix seconds). */
export interface ExtraStateV3 {
  lastEpoch: bigint;
  lastPublishTs: bigint;
  accounted: bigint;
  reserved: bigint;
  liveForgedBacking: bigint;
  outSincePublish: bigint;
}

/** decoded ExtraState account (anchor camelCase BN fields) → counters */
export function extraStateOf(d: any): ExtraStateV3 {
  const b = (v: unknown) => BigInt(bnStr(v));
  return { lastEpoch: b(d.lastEpoch), lastPublishTs: b(d.lastPublishTs), accounted: b(d.accounted), reserved: b(d.reserved), liveForgedBacking: b(d.liveForgedBacking), outSincePublish: b(d.outSincePublish) };
}

/**
 * extra.rs::extra_bound, bit for bit: free = accounted − reserved; bound = min(⌊free × 800/10^4⌋, weeks × ⌊(live forged
 * backing + out since publish) × 400/10^4⌋): the release NOT scaled, the backing term floored per week then multiplied
 * (the oracle's releaseOf / backingBoundOf). Throws where the program fails with MathOverflow.
 */
export function extraBoundV3(x: ExtraStateV3, weeks: number): { free: bigint; bound: bigint } {
  if (!Number.isInteger(weeks) || weeks < 0 || weeks > 255) throw new Error(`weeks ${weeks} is not a u8`);
  const free = x.accounted - x.reserved;
  if (free < 0n) throw new Error("MathOverflow: reserved above accounted");
  const backing = x.liveForgedBacking + x.outSincePublish;
  if (backing > U64_MAX) throw new Error("MathOverflow: backing above u64");
  const perWeek = (backing * EXTRA_BACKING_BOUND_BPS) / BPS;
  const backingBound = perWeek * BigInt(weeks);
  if (backingBound > U64_MAX) throw new Error("MathOverflow: backing bound above u64");
  const release = (free * EXTRA_RELEASE_BPS) / BPS;
  return { free, bound: release < backingBound ? release : backingBound };
}

/**
 * extra.rs::extra_publish_core_at's checks, in the program's order: the name of the error the program would return,
 * or null when it accepts. `now` (unix seconds) enables the 6-day interval check of a paying publication, measured from
 * ExtraState.last_publish_ts, which the program sets to the BASE published_at of the last paying extra (R-2).
 */
export function extraPublishErrorV3(x: ExtraStateV3, a: ExtraPublishArgs, ctx: { baseLastEpoch: number; weeksMax: number; now?: number }): string | null {
  const total = BigInt(a.total);
  if (BigInt(a.epoch) !== x.lastEpoch + 1n || a.epoch > ctx.baseLastEpoch) return "ExtraEpochOrder";
  if (total > 0n) {
    if (ctx.now !== undefined && BigInt(ctx.now) < x.lastPublishTs + BigInt(MIN_EPOCH_INTERVAL)) return "ExtraEpochOrder";
    if (a.leaves === 0) return "EmptyEpoch";
  }
  if (a.leaves > EXTRA_MAX_LEAVES) return "InvalidProof";
  if (a.weeks < 1 || a.weeks > ctx.weeksMax) return "BadEpochWindow";
  if (total > extraBoundV3(x, a.weeks).bound) return "ExtraBudgetExceeded";
  return null;
}

const hex32 = (h: string, what: string): number[] => {
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`${what} is not 32 bytes of lowercase hex`);
  return Array.from(Buffer.from(h, "hex"));
};

/** Structural check of publish_extra_epoch's arguments (u64 / u32 / u8 ranges, weeks 1..=EXTRA_MAX_WEEKS). */
export function extraPublishArgsError(a: ExtraPublishArgs): string | null {
  if (!Number.isSafeInteger(a.epoch) || a.epoch < 1) return `epoch ${a.epoch} is not an epoch id`;
  if (typeof a.total !== "string" || !/^(0|[1-9][0-9]*)$/.test(a.total) || BigInt(a.total) > U64_MAX) return `total ${a.total} is not a u64`;
  if (!Number.isInteger(a.leaves) || a.leaves < 0 || a.leaves > 0xffff_ffff) return `leaves ${a.leaves} is not a u32`;
  if (!Number.isInteger(a.weeks) || a.weeks < 1 || a.weeks > EXTRA_MAX_WEEKS) return `weeks ${a.weeks} is outside 1..=${EXTRA_MAX_WEEKS} (W2-3)`;
  if (!/^[0-9a-f]{64}$/.test(a.root) || !/^[0-9a-f]{64}$/.test(a.dataHash)) return "root / dataHash is not 32 bytes of lowercase hex";
  return null;
}

/** The accounts of publish_extra_epoch (prev_epoch = Epoch(id − 1); epoch 1 passes Epoch(0), which the program ignores). */
export function publishExtraEpochAccountsV3(epoch: number, oracle: PublicKey) {
  return {
    config: PDA.config(), extraState: PDA_V3.extraState(), extraEpoch: PDA_V3.extraEpoch(epoch), baseEpoch: PDA.epoch(epoch),
    prevEpoch: PDA.epoch(epoch > 1 ? epoch - 1 : 0), oracle, systemProgram: SystemProgram.programId,
  };
}

function publishExtraEpochMethodV3(program: anchor.Program, oracle: PublicKey, a: ExtraPublishArgs) {
  requireV3Program(program, `publish_extra_epoch ${a.epoch}`);
  const bad = extraPublishArgsError(a);
  if (bad) throw new Error(`refusing to publish extra epoch ${a.epoch}: ${bad}`);
  return program.methods
    .publishExtraEpoch(new anchor.BN(a.epoch), hex32(a.root, "root"), hex32(a.dataHash, "dataHash"), new anchor.BN(a.total), a.leaves, a.weeks)
    .accountsPartial(publishExtraEpochAccountsV3(a.epoch, oracle));
}

/** publish_extra_epoch(epoch_id, root, data_hash, total, leaves, weeks): the instruction, built offline. */
export async function publishExtraEpochIxV3(program: anchor.Program, oracle: PublicKey, a: ExtraPublishArgs): Promise<TransactionInstruction> {
  return publishExtraEpochMethodV3(program, oracle, a).instruction();
}

/** What the preflight read (read-only) before a publish_extra_epoch. */
export interface ExtraPreflightV3 {
  state: ExtraStateV3;
  baseLastEpoch: number;
  publishedAt: number;
  prevPublishedAt: number | null;
  weeksMax: number;
}

/** Reads ExtraState, Config.last_epoch and published_at of Epoch(id) and Epoch(id − 1) (finalized). */
export async function readExtraPreflightV3(program: anchor.Program, epoch: number): Promise<ExtraPreflightV3> {
  const acc = program.account as any;
  const x = await acc.extraState.fetch(PDA_V3.extraState(), "finalized");
  const cfg = await acc.config.fetch(PDA.config(), "finalized");
  const base = await acc.epoch.fetchNullable(PDA.epoch(epoch), "finalized");
  if (!base) throw new Error(`Epoch(${epoch}) does not exist: the program would refuse (ExtraBaseEpochMissing)`);
  const prev = epoch > 1 ? await acc.epoch.fetchNullable(PDA.epoch(epoch - 1), "finalized") : null;
  if (epoch > 1 && !prev) throw new Error(`Epoch(${epoch - 1}) does not exist: the program would refuse (BadEpochWindow)`);
  const publishedAt = Number(bnStr(base.publishedAt));
  const prevPublishedAt = prev ? Number(bnStr(prev.publishedAt)) : null;
  return { state: extraStateOf(x), baseLastEpoch: Number(bnStr(cfg.lastEpoch)), publishedAt, prevPublishedAt, weeksMax: extraWeeksMaxV3(publishedAt, prevPublishedAt) };
}

/**
 * R-2: the program would refuse this PAYING extra epoch now only for its 6-day interval (now < ExtraState.last_publish_ts
 * + MIN_EPOCH_INTERVAL; last_publish_ts is the base published_at of the last paying extra): it may be sent from `from`
 * on. Not a failure: publish-extra reports it and exits 0, and the next run sends it.
 */
export class ExtraNotYetV3 extends Error {
  constructor(readonly epoch: number, readonly from: number) {
    super(`extra epoch ${epoch} is not due yet: a paying extra epoch may land from ${new Date(from * 1000).toISOString()} on (6 days after the base publication of the previous paying one, R-2); nothing sent`);
  }
}

/** The X1 time now (the block time of the confirmed slot), null when the node has none. */
async function chainNowV3(connection: Connection): Promise<number | null> {
  try {
    const t = await connection.getBlockTime(await connection.getSlot("confirmed"));
    return typeof t === "number" && Number.isSafeInteger(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * Publishes extra file f: the W2-4 guard (upgraded binary), then a read-only preflight of the program's own checks on
 * the same inputs (order, the 6-day interval at the chain's time, leaves, weeks against the published_at gap, the
 * bound), then the transaction. The caller verifies the file (verifyExtraFile) and makes it durable first (A10.11):
 * index.ts publish-extra. Throws ExtraNotYetV3 (nothing sent) when only the interval refuses it now.
 */
export async function publishExtraEpochV3(program: anchor.Program, oracle: Keypair, f: ExtraFileV1): Promise<string> {
  const a = extraPublishArgs(f);
  requireV3Program(program, `refusing to publish extra epoch ${a.epoch}`);
  const bad = extraPublishArgsError(a);
  if (bad) throw new Error(`refusing to publish extra epoch ${a.epoch}: ${bad}`);
  await assertUpgradedV3(program.provider.connection, program, `to publish extra epoch ${a.epoch}`);
  const pre = await readExtraPreflightV3(program, a.epoch);
  // R-2: the interval at the chain's own time (the program uses Clock), a soft "not yet" instead of a refused send
  const now = await chainNowV3(program.provider.connection);
  const from = Number(pre.state.lastPublishTs) + MIN_EPOCH_INTERVAL;
  if (BigInt(a.total) > 0n && now !== null && BigInt(a.epoch) === pre.state.lastEpoch + 1n && now < from) throw new ExtraNotYetV3(a.epoch, from);
  const err = extraPublishErrorV3(pre.state, a, { baseLastEpoch: pre.baseLastEpoch, weeksMax: pre.weeksMax, ...(now === null ? {} : { now }) });
  if (err) {
    throw new Error(`refusing to publish extra epoch ${a.epoch}: the program would refuse it (${err}; weeks ${a.weeks}, chain max ${pre.weeksMax}, total ${a.total}, bound ${extraBoundV3(pre.state, a.weeks).bound})`);
  }
  return publishExtraEpochMethodV3(program, oracle.publicKey, a).signers([oracle]).rpc();
}

/** claim_extra(epoch_id, index, amount, proof): permissionless; the lamports go to the leaf wallet (an account). */
export async function claimExtraIxV3(program: anchor.Program, payer: PublicKey, c: ExtraClaimArgs): Promise<TransactionInstruction> {
  requireV3Program(program, `claim_extra ${c.epoch}`);
  return program.methods
    .claimExtra(new anchor.BN(c.epoch), c.index, new anchor.BN(c.amount), c.proof.map((h, i) => hex32(h, `proof[${i}]`)))
    .accountsPartial({
      config: PDA.config(), extraState: PDA_V3.extraState(), extraEpoch: PDA_V3.extraEpoch(c.epoch), extraVault: PDA_V3.extraVault(),
      wallet: new PublicKey(c.wallet), payer, systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** init_extra(): permissionless, once, before the first forge on the upgraded binary. */
export async function initExtraIxV3(program: anchor.Program, payer: PublicKey): Promise<TransactionInstruction> {
  requireV3Program(program, "init_extra");
  return program.methods.initExtra()
    .accountsPartial({ config: PDA.config(), extraState: PDA_V3.extraState(), extraVault: PDA_V3.extraVault(), payer, systemProgram: SystemProgram.programId })
    .instruction();
}

/** close_extra_epoch(): permissionless after 90 days; the rent goes back to the oracle key that paid it. */
export async function closeExtraEpochIxV3(program: anchor.Program, epoch: number, rentPayer: PublicKey): Promise<TransactionInstruction> {
  requireV3Program(program, `close_extra_epoch ${epoch}`);
  return program.methods.closeExtraEpoch()
    .accountsPartial({ extraState: PDA_V3.extraState(), extraEpoch: PDA_V3.extraEpoch(epoch), rentPayer })
    .instruction();
}

/** The ExtraEpochPublished event (weeks appended last, W2-3) of a transaction's logs, decoded with the v3 IDL. */
export function extraPublishedFromLogsV3(program: anchor.Program, logs: string[]): PublishedExtra | null {
  requireV3Program(program, "ExtraEpochPublished");
  const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.rawIdl as anchor.Idl));
  let ev: any = null;
  for (const e of parser.parseLogs(logs, false)) if (e.name === "ExtraEpochPublished" || e.name === "extraEpochPublished") ev = e.data;
  if (!ev) return null;
  const hex = (x: number[] | Uint8Array) => Buffer.from(x).toString("hex");
  return {
    epoch: Number(bnStr(ev.epoch)), root: hex(ev.root), dataHash: hex(ev.data_hash ?? ev.dataHash), total: bnStr(ev.total), leaves: Number(ev.leaves),
    freeBefore: bnStr(ev.free_before ?? ev.freeBefore), freeAfter: bnStr(ev.free_after ?? ev.freeAfter), weeks: Number(ev.weeks),
  };
}
