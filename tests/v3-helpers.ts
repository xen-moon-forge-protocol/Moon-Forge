/**
 * Shared helpers of the v3 integration and stress suites (SPEC-UPGRADE-v2 8.2 / 8.3): PDAs, Merkle trees, the leaf
 * domains, the keeper hash chain, TS mirrors of the on-chain rules (PX price, market split, bet rolls, the v3 Jackpot
 * ticket) and an error / instruction / event coverage recorder (B-13). Not a test file: mocha only loads the two suites.
 */
import * as anchor from "@coral-xyz/anchor";
import { keccak_256 } from "@noble/hashes/sha3";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY, Transaction, TransactionInstruction } from "@solana/web3.js";
import { assert, expect } from "chai";
import * as fs from "fs";
import * as path from "path";

/** tests/tx-confirm.cjs: wait for the signature itself, generously, never send twice (shared with the .mjs drivers). */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TX: {
  hardenProvider: (p: any) => any;
  sendOnce: (c: Connection, tx: Transaction, signers: Keypair[], o?: { commitment?: string; skipPreflight?: boolean }) => Promise<string>;
  airdrop: (c: Connection, to: PublicKey, lamports: number, commitment?: string) => Promise<string>;
  waitSlotHashGone: (c: Connection, id: PublicKey, target: bigint, minSlots?: bigint) => Promise<void>;
} = require("./tx-confirm.cjs");
/** An airdrop, waited for like any transaction (no 30-s legacy timeout). */
export const airdrop = (connection: Connection, to: PublicKey, lamports: number) => TX.airdrop(connection, to, lamports);

export const XNT = LAMPORTS_PER_SOL;
export const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
export const OBS = new PublicKey("4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ");
export const U64_MAX = new anchor.BN("18446744073709551615");
export const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/moon_forge.json"), "utf8"));
export const kp = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8"))));

// localnet constants (constants.rs, feature "localnet": DAY = 1 s)
export const L = {
  CLAIM_HOLD: 2, MIN_EPOCH_INTERVAL: 6, CLAIM_WINDOW: 90, KEEPER_NOTICE: 3, KEEPER_STALL_SLOTS: 40, KEEPER_BOND_MIN: 20 * XNT,
  KEEPER_TIP: 2_000_000, KEEPER_TIP_MIN_CLAIM: 200_000_000, PRED_PERIOD: 120, PRED_LOCK_OFFSET: 90, PRED_HORIZON: 60, PRED_ENTRY_CLOSE: 35,
  JACKPOT_MAX_POT: 20 * XNT, DUEL_JOIN_REVEAL_WINDOW: 4, DUEL_REVEAL_WINDOW: 2, WAR_SEED_WINDOW: 6, WAR_REVEAL_WINDOW: 4,
  MARKET_MIN_PRICE: 100_000_000, MARKET_MAX_LISTING: 90, VOID_BOND_MIN: 50_000_000, SEAT_BOND_MIN: XNT,
  SLOT_HASH_MAX_AGE: 2_000, KEEPER_OPEN_TS: 0, // r9: the SlotHashes time fallback; the keeper seat open from the start
};
export const ARTIFACT_PRICE = [10n, 25n, 60n, 200n].map((x) => x * BigInt(XNT));
const PRICE_UP_NUM = [51n, 21n, 21n, 21n], PRICE_UP_DEN = [50n, 20n, 20n, 20n];
const PRICE_DECAY_PERIOD = [1, 3, 7, 14];
const MIN_PRICE_BPS = [3000n, 5000n, 5000n, 5000n];
export const ARTIFACT_SUPPLY = [600, 300, 90, 10];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const u64 = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
export const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const big = (x: any) => BigInt(x.toString());
export const keccak = (...p: Uint8Array[]) => { const h = keccak_256.create(); p.forEach((x) => h.update(x)); return Buffer.from(h.digest()); };
export const rnd = (h: Buffer, a: Buffer, b: Buffer) => keccak(Buffer.from("MOONFORGE_RNG"), h, a, b).readBigUInt64LE(0);
export const errText = (e: any) => String(e) + JSON.stringify(e?.logs ?? e?.transactionLogs ?? "");
/** IDL error name → message. A transaction that passed preflight and failed on-chain comes back from Anchor as a
 * ProgramError whose text is the message only (no name, no logs). */
const ERROR_MSG: Record<string, string> = Object.fromEntries((idl.errors ?? []).map((x: any) => [x.name, x.msg]));
export const errMatches = (text: string, code: string) => text.includes(code) || (!!ERROR_MSG[code] && text.includes(ERROR_MSG[code]));

export function pdas(pid: PublicKey) {
  const pda = (...s: Buffer[]) => PublicKey.findProgramAddressSync(s, pid)[0];
  return {
    pda,
    config: pda(Buffer.from("config")),
    reward: pda(Buffer.from("reward_vault")),
    bankroll: pda(Buffer.from("bankroll_vault")),
    draw: pda(Buffer.from("draw_vault")),
    collection: pda(Buffer.from("collection")),
    authority: pda(Buffer.from("artifact_authority")),
    seat: pda(Buffer.from("oracle_seat")),
    keeper: pda(Buffer.from("house_keeper")),
    extraState: pda(Buffer.from("extra_state")),
    extraVault: pda(Buffer.from("extra_vault")),
    epoch: (n: number) => pda(Buffer.from("epoch"), u64(n)),
    extraEpoch: (n: number) => pda(Buffer.from("extra_epoch"), u64(n)),
    receipt: (n: number, p: PublicKey, t: number) => pda(Buffer.from("receipt"), u64(n), p.toBuffer(), Buffer.from([t])),
    mission: (n: number, p: PublicKey, t: number) => pda(Buffer.from("mission"), u64(n), p.toBuffer(), Buffer.from([t])),
    player: (o: PublicKey) => pda(Buffer.from("player"), o.toBuffer()),
    bet: (ps: PublicKey, n: number | bigint) => pda(Buffer.from("bet"), ps.toBuffer(), u64(n)),
    house: (o: PublicKey) => pda(Buffer.from("house"), o.toBuffer()),
    jackpot: (r: number) => pda(Buffer.from("jackpot"), u64(r)),
    jpEntry: (r: number, i: number) => pda(Buffer.from("jp_entry"), u64(r), u32(i)),
    drawRound: (r: number) => pda(Buffer.from("draw"), u64(r)),
    drawEntry: (r: number, i: number) => pda(Buffer.from("draw_entry"), u64(r), u32(i)),
    duel: (c: PublicKey, n: number | bigint) => pda(Buffer.from("duel"), c.toBuffer(), u64(n)),
    war: (c: PublicKey, n: number | bigint) => pda(Buffer.from("war"), c.toBuffer(), u64(n)),
    asset: (t: number, s: number) => pda(Buffer.from("asset"), Buffer.from([t]), u32(s)),
    artifact: (a: PublicKey) => pda(Buffer.from("artifact"), a.toBuffer()),
    listing: (a: PublicKey) => pda(Buffer.from("listing"), a.toBuffer()),
    pred: (r: number) => pda(Buffer.from("pred"), u64(r)),
    predEntry: (r: number, p: PublicKey) => pda(Buffer.from("pred_entry"), u64(r), p.toBuffer()),
    legacyState: pda(Buffer.from("protocol_state")),
    legacyEscrow: pda(Buffer.from("dev_escrow")),
  };
}

// ─── Merkle trees and leaves ────────────────────────────────────────────────
const hashPair = (a: Buffer, b: Buffer) => (Buffer.compare(a, b) <= 0 ? keccak(a, b) : keccak(b, a));
export function tree(leaves: Buffer[]) {
  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const c = layers[layers.length - 1], n: Buffer[] = [];
    for (let i = 0; i < c.length; i += 2) n.push(i + 1 < c.length ? hashPair(c[i], c[i + 1]) : c[i]);
    layers.push(n);
  }
  const proof = (idx: number) => {
    const out: number[][] = [];
    for (let l = 0; l < layers.length - 1; l++) { const s = idx ^ 1; if (s < layers[l].length) out.push(Array.from(layers[l][s])); idx >>= 1; }
    return out;
  };
  return { root: layers[layers.length - 1][0], proof };
}
export const claimLeaf = (e: number, p: PublicKey, t: number, s: bigint) =>
  keccak(Buffer.from("MOONFORGE_V2_CLAIM"), u64(e), p.toBuffer(), Buffer.from([t]), u64(s));
export const extraLeaf = (e: number, i: number, w: PublicKey, amount: bigint) =>
  keccak(Buffer.from("MOONFORGE_V3_EXTRA"), u64(e), u32(i), w.toBuffer(), u64(amount));

// ─── keeper hash chain: x_N = seed, x_k = keccak(x_{k+1}), tip = x_0; position i is revealed by x_{i+1} ─────
export class KeeperChain {
  readonly xs: Buffer[];
  constructor(seed: Buffer, readonly length: number) {
    const v = [seed];
    for (let i = 0; i < length; i++) v.push(keccak(v[v.length - 1]));
    this.xs = v.reverse();
  }
  get tip() { return this.xs[0]; }
  reveal(position: number | bigint) { return this.xs[Number(position) + 1]; }
}
export const betPack = (index: bigint, anchor: bigint) => (index << 40n) | (anchor & ((1n << 40n) - 1n));
export const betUnpack = (ts: bigint) => ({ index: ts >> 40n, anchor: ts & ((1n << 40n) - 1n) });
export const mixedSeed = (seed: Buffer, h: Buffer) => keccak(Buffer.from("MOONFORGE_ANCHOR"), seed, h);
export const jackpotTicketV2 = (h: Buffer, reveal: Buffer, round: PublicKey, id: number, total: bigint) =>
  rnd(keccak(Buffer.from("MOONFORGE_JACKPOT_V2"), h, reveal), round.toBuffer(), u64(id)) % total;
export function isWin(game: number, choice: number, chance: bigint, roll: bigint) {
  if (game === 0) return (roll < 5000n) === (choice === 0);
  if (game === 1) return choice === 0 ? roll < chance : roll >= 10_000n - chance;
  return roll < chance;
}

// ─── TS mirrors of the economic rules ────────────────────────────────────────
/** artifacts.rs current_price (PX). PRICE_LAUNCH_TS = i64::MAX on localnet: a never-forged tier sits at base. */
export function currentPrice(c: any, t: number, now: number): bigint {
  const base = ARTIFACT_PRICE[t];
  const min = (base * MIN_PRICE_BPS[t]) / 10_000n;
  const stored = big(c.artifactPrice[t]);
  if (stored === 0n) return base; // localnet: 0 decay periods since i64::MAX
  let p = stored;
  if (c.artifactsAlive[t] >= ARTIFACT_SUPPLY[t]) return p > min ? p : min;
  const periods = Math.max(0, Math.floor((now - Number(c.artifactPriceTs[t])) / PRICE_DECAY_PERIOD[t]));
  for (let i = 0; i < Math.min(periods, 180); i++) {
    p = (p * PRICE_UP_DEN[t]) / PRICE_UP_NUM[t];
    if (p <= min) return min;
  }
  return p > min ? p : min;
}
export const nextPrice = (paid: bigint, t: number) => {
  const cap = ARTIFACT_PRICE[t] * 10n, n = (paid * PRICE_UP_NUM[t]) / PRICE_UP_DEN[t];
  return n < cap ? n : cap;
};
export const forgeSplit = (price: bigint) => {
  const backing = (price * 5000n) / 10_000n, extra = (price * 2500n) / 10_000n, pool = (price * 2000n) / 10_000n;
  return { backing, pool, extra, draw: 0n, architect: price - backing - pool - extra };
};
export const marketSplit = (price: bigint) => {
  const royalty = (price * 500n) / 10_000n, pool = (price * 200n) / 10_000n;
  return { royalty, pool, net: price - royalty - pool };
};
export const voidBond = (full: bigint) => { const b = (full * 1000n) / 10_000n; return b > 50_000_000n ? b : 50_000_000n; };
export const seatBond = (free: bigint) => { const b = (free * 1000n) / 10_000n; return b > BigInt(XNT) ? b : BigInt(XNT); };
/** Smallest list price whose seller net covers `backing` (and at least 0.1 XNT). */
export function minListPrice(backing: bigint) {
  // net(p) = p − ⌊5% p⌋ − ⌊2% p⌋ >= 0.93 p: start safely below and walk up to the first p whose net covers the floor
  let p = (backing * 10_000n) / 9_300n - 100n;
  if (p < 0n) p = 0n;
  while (marketSplit(p).net < backing) p += 1n;
  return p < 100_000_000n ? 100_000_000n : p;
}

/** games.rs game_odds (chance_bps, payout_bps) and the bet edge (1% pool + 0.5% architect). */
export function gameOdds(game: number, param: number, choice: number): { chance: bigint; payoutBps: bigint } {
  const RTP = 9_800n * 10_000n;
  if (game === 0) return { chance: 5_000n, payoutBps: RTP / 5_000n };
  if (game === 1) return { chance: BigInt(param), payoutBps: RTP / BigInt(param) };
  if (game === 2) return { chance: RTP / BigInt(param), payoutBps: BigInt(param) };
  throw new Error(`game ${game} ${choice}`);
}
export const betEdge = (stake: bigint) => (stake * 100n) / 10_000n + (stake * 50n) / 10_000n;
/**
 * games.rs bet_limits, clause by clause, in program order: the error a place_bet_v2 gets (or null). `vault` = bankroll
 * lamports above rent before the bet, `dayStart` = config.bankroll_day_start of the bet's UTC day (= vault on a new day).
 */
export function betLimitsMirror(s: {
  vault: bigint; reserved: bigint; stake: bigint; payout: bigint; dayStart: bigint; weekLoss: bigint; weekStart: bigint; bond: bigint; jackpotReserved: bigint;
}): string | null {
  const stakeIn = s.stake - betEdge(s.stake);
  const vaultAfter = s.vault + stakeIn, reservedAfter = s.reserved + s.payout;
  const left = vaultAfter > reservedAfter ? vaultAfter - reservedAfter : 0n;
  if (left * 10_000n < s.dayStart * 9_700n) return "DailyLossLimit";
  const free = s.vault > s.reserved ? s.vault - s.reserved : 0n;
  const net = s.payout > s.stake ? s.payout - s.stake : 0n;
  if (net > (free * 25n) / 10_000n) return "BankrollTooSmall";
  if (vaultAfter < reservedAfter) return "BankrollTooSmall";
  if (reservedAfter > (vaultAfter * 500n) / 10_000n) return "BankrollTooSmall";
  if (s.weekLoss + reservedAfter > (s.weekStart * 1_500n) / 10_000n) return "WeeklyLossLimit";
  if (s.bond < reservedAfter + s.jackpotReserved) return "KeeperBondTooSmall";
  return null;
}
/** keeper.rs week_base: the window-start bankroll, lowered by exits since (never raised by deposits). */
export const weekBase = (weekStart: bigint, vault: bigint, weekLoss: bigint) => {
  const adj = vault + weekLoss > 0n ? vault + weekLoss : 0n;
  return weekStart < adj ? weekStart : adj;
};

/** The airdrop list of the B-13 airdrop cases: AIRDROP_MAX (120) + 1 deterministic wallets, leaf = keccak(DOMAIN ‖ wallet). */
export const AIRDROP_MAX = 120;
export const airdropWallets = Array.from({ length: AIRDROP_MAX + 1 }, (_, i) => Keypair.fromSeed(keccak(Buffer.from("mf-test-airdrop"), u32(i))));
export const airdropLeaf = (w: PublicKey) => keccak(Buffer.from("MOONFORGE_V2_AIRDROP"), w.toBuffer());

// ─── Metaplex Core account parsing (the plugin registry, not a byte search) ───
/** PluginType (mpl-core): Royalties 0, FreezeDelegate 1, BurnDelegate 2, TransferDelegate 3, …, Attributes 6. */
export const CORE_PLUGIN = { Royalties: 0, TransferDelegate: 3, Attributes: 6 };
/** PluginAuthority (mpl-core): None 0, Owner 1, UpdateAuthority 2, Address 3 (+32 B). */
export const CORE_AUTH = { None: 0, Owner: 1, UpdateAuthority: 2, Address: 3 };
export type CorePlugin = { type: number; authority: number; address: PublicKey | null; offset: number };
/**
 * Parses a Core AssetV1 (key 1) or CollectionV1 (key 5) account: the base fields, the PluginHeaderV1 (key 3) right
 * after them, and the PluginRegistryV1 (key 4) it points to. Throws on any unexpected key, so a layout change fails loudly.
 */
export function parseCore(data: Buffer) {
  let o = 0;
  const key = data[o++];
  const str = () => { const n = data.readUInt32LE(o); o += 4; const s = data.subarray(o, o + n).toString("utf8"); o += n; return s; };
  let owner: PublicKey | null = null, updateAuthority: PublicKey | null = null;
  if (key === 1) {
    owner = new PublicKey(data.subarray(o, o + 32)); o += 32;
    const uaTag = data[o++];
    if (uaTag === 1 || uaTag === 2) { updateAuthority = new PublicKey(data.subarray(o, o + 32)); o += 32; }
    else if (uaTag !== 0) throw new Error(`Core: update authority tag ${uaTag}`);
    str(); str(); // name, uri
    const seq = data[o++];
    if (seq === 1) o += 8; else if (seq !== 0) throw new Error(`Core: seq tag ${seq}`);
  } else if (key === 5) {
    updateAuthority = new PublicKey(data.subarray(o, o + 32)); o += 32;
    str(); str();
    o += 8; // num_minted u32, current_size u32
  } else throw new Error(`Core: account key ${key} is neither AssetV1 nor CollectionV1`);
  const plugins: CorePlugin[] = [];
  if (o < data.length) {
    if (data[o] !== 3) throw new Error(`Core: plugin header key ${data[o]}`);
    let r = Number(data.readBigUInt64LE(o + 1));
    if (data[r++] !== 4) throw new Error("Core: plugin registry key");
    const n = data.readUInt32LE(r); r += 4;
    for (let i = 0; i < n; i++) {
      const type = data[r++];
      const authority = data[r++];
      let address: PublicKey | null = null;
      if (authority === CORE_AUTH.Address) { address = new PublicKey(data.subarray(r, r + 32)); r += 32; }
      else if (authority > 3) throw new Error(`Core: authority tag ${authority}`);
      const offset = Number(data.readBigUInt64LE(r)); r += 8;
      plugins.push({ type, authority, address, offset });
    }
  }
  return { key, owner, updateAuthority, plugins };
}
/** The Royalties plugin body at its registry offset: Plugin tag 0, basis_points u16, creators Vec<{address, pct}>, rule_set. */
export function parseRoyalties(data: Buffer, offset: number) {
  let o = offset;
  if (data[o++] !== CORE_PLUGIN.Royalties) throw new Error("Core: not a Royalties plugin");
  const basisPoints = data.readUInt16LE(o); o += 2;
  const n = data.readUInt32LE(o); o += 4;
  const creators: { address: PublicKey; percentage: number }[] = [];
  for (let i = 0; i < n; i++) { creators.push({ address: new PublicKey(data.subarray(o, o + 32)), percentage: data[o + 32] }); o += 33; }
  return { basisPoints, creators, ruleSet: data[o] };
}

// ─── chain access ───────────────────────────────────────────────────────────
/**
 * B-13 event coverage: one logs subscription per mocha process (opened by the first suite that loads) records every
 * event of every SUCCESSFUL transaction that mentions the program, whoever sent it (anchor .rpc(), raw sendIxs, the
 * stress harness). Events are read from the logs exactly as anchor's EventParser reads them. A root-level `after` hook
 * closes the subscription, so mocha still exits on its own.
 */
let eventWatch: { connection: Connection; id: number } | null = null;
function watchEvents(connection: Connection, program: anchor.Program, parser: anchor.EventParser) {
  if (eventWatch) return;
  const id = connection.onLogs(program.programId, (l) => {
    if (l.err) return;
    const names: string[] = [];
    try { for (const e of parser.parseLogs(l.logs)) names.push(e.name); } catch { /* a truncated log: keep what was read */ }
    coverage.events(names);
  }, "confirmed");
  eventWatch = { connection, id };
  const g: any = globalThis as any;
  if (typeof g.after === "function") {
    g.after(async () => {
      if (!eventWatch) return;
      const w = eventWatch;
      eventWatch = null;
      await w.connection.removeOnLogsListener(w.id).catch(() => undefined);
    });
  }
}

/** The Clock sysvar as a read-only account meta: in a simulated transaction it makes the RPC return the bank's clock. */
export const CLOCK_META = { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false };

export function chainTools(connection: Connection, program: anchor.Program) {
  const parser = new anchor.EventParser(program.programId, program.coder);
  watchEvents(connection, program, parser);
  TX.hardenProvider(program.provider);
  const slotHashAtOrAfter = async (target: bigint): Promise<Buffer | null> => {
    const d = (await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, "confirmed"))!.data;
    const len = Number(d.readBigUInt64LE(0));
    let best: Buffer | null = null;
    for (let i = 0; i < len; i++) { const o = 8 + i * 40; if (d.readBigUInt64LE(o) >= target) best = Buffer.from(d.subarray(o + 8, o + 40)); else break; }
    return best;
  };
  const slot = async () => BigInt(await connection.getSlot("confirmed"));
  const waitPastSlot = async (target: bigint) => { for (;;) { if ((await slot()) > target + 1n) return; await sleep(250); } };
  /** Until `target`'s block hash has left SlotHashes (the program answers Expired): `target + 515` slots and the sysvar
   * itself, since skipped slots leave no entry and a loaded validator skips slots (tx-confirm.cjs waitSlotHashGone). */
  const waitHashGone = (target: bigint) => TX.waitSlotHashGone(connection, SYSVAR_SLOT_HASHES_PUBKEY, target, 515n);
  const chainTime = async () => (await connection.getBlockTime(await connection.getSlot("confirmed")))!;
  const untilChainTime = async (t: number) => { while ((await chainTime()) < t) await sleep(400); };
  /** The events and the block time of a confirmed transaction. */
  const txInfo = async (sig: string) => {
    for (let i = 0; i < 100; i++) {
      const t = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      if (t) {
        const events = [...parser.parseLogs(t.meta?.logMessages ?? [])];
        coverage.events(events.map((e) => e.name));
        return { events, blockTime: t.blockTime!, slot: BigInt(t.slot), logs: t.meta?.logMessages ?? [] };
      }
      await sleep(300);
    }
    throw new Error(`transaction ${sig} not found`);
  };
  const event = (evs: { name: string; data: any }[], name: string) => {
    const e = evs.find((x) => x.name.toLowerCase() === name.toLowerCase());
    expect(e, `event ${name} not emitted (got ${evs.map((x) => x.name).join(", ")})`).to.not.equal(undefined);
    return e!.data;
  };
  const bal = (k: PublicKey) => connection.getBalance(k, "confirmed");
  const rentFor = async (len: number) => connection.getMinimumBalanceForRentExemption(len);
  /** Sends raw instructions with the given signers (first = fee payer), once; a landed failure carries its logs. */
  const sendIxs = async (ixs: TransactionInstruction[], signers: Keypair[]) =>
    TX.sendOnce(connection, new Transaction().add(...ixs), signers, { commitment: "confirmed" });
  // Raw simulateTransaction (no signatures: sigVerify false; replaceRecentBlockhash: the bank's own blockhash, so no
  // getLatestBlockhash per poll): one RPC request per simulation, none of web3.js's unique-signature blockhash polling,
  // so a poll loop really runs at the bank's pace.
  const unsigned = (ixs: TransactionInstruction[], payer: PublicKey) => {
    const msg = new Transaction({ feePayer: payer, recentBlockhash: PublicKey.default.toBase58() }).add(...ixs).compileMessage();
    const n = msg.header.numRequiredSignatures;
    return Buffer.concat([Buffer.from([n]), Buffer.alloc(64 * n), msg.serialize()]).toString("base64");
  };
  const simConfig = (commitment: "confirmed" | "processed") => ({
    encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment,
    accounts: { encoding: "base64", addresses: [SYSVAR_CLOCK_PUBKEY.toBase58()] },
  });
  /**
   * The RPC returns in `accounts` only accounts the transaction itself loads, and (Agave 3.1) only when it SUCCEEDS: a
   * caller that needs the exact clock of a successful simulation puts the Clock sysvar in the transaction (CLOCK_META,
   * e.g. after an instruction's last remaining account). Otherwise the block time of the simulated slot is used (a
   * block's time is its bank's Clock.unix_timestamp, fixed once the slot is confirmed: cached per slot), confirmed slots only.
   */
  const blockTimes = new Map<number, number>();
  const readSim = async (res: any, fallback = true) => {
    if (res?.error) throw new Error(`simulateTransaction: ${JSON.stringify(res.error)}`);
    const v = res.result.value;
    const slot = Number(res.result.context.slot);
    let now = NaN;
    let src: "sysvar" | "blocktime" | "none" = "none";
    const a = v.accounts?.[0];
    if (a?.data?.[0]) { now = Number(Buffer.from(a.data[0], "base64").readBigInt64LE(32)); src = "sysvar"; } // Clock.unix_timestamp @32
    else if (fallback && blockTimes.has(slot)) { now = blockTimes.get(slot)!; src = "blocktime"; }
    for (let i = 0; fallback && i < 50 && !Number.isFinite(now); i++) {
      try {
        const t = await connection.getBlockTime(slot);
        if (t != null) { now = t; src = "blocktime"; if (blockTimes.size > 4096) blockTimes.clear(); blockTimes.set(slot, t); }
      } catch { /* not confirmed yet */ }
      if (!Number.isFinite(now)) await sleep(100);
    }
    const err = v.err ? JSON.stringify(v.err) + JSON.stringify(v.logs ?? []) : null;
    return { err, now, slot, src };
  };
  /**
   * Simulates raw instructions (no state change) on the CONFIRMED bank and returns the program error text (null = would
   * succeed), the Clock.unix_timestamp of the bank that ran it (see readSim) and its slot. signers[0] pays the fee.
   */
  const simulateAt = async (ixs: TransactionInstruction[], signers: Keypair[]) =>
    readSim(await (connection as any)._rpcRequest("simulateTransaction", [unsigned(ixs, signers[0].publicKey), simConfig("confirmed")]));
  /**
   * Several simulations in ONE JSON-RPC batch, each on the bank of its commitment. The banks may differ between the
   * entries (the RPC serves them one by one while slots advance), so every result carries its own clock and slot.
   * Processed-bank results get no block-time fallback (their block may not be confirmed yet): put CLOCK_META in them.
   */
  const simulateMany = async (list: { ixs: TransactionInstruction[]; payer: PublicKey; commitment: "confirmed" | "processed" }[]) => {
    const reqs = list.map((s) => ({ methodName: "simulateTransaction", args: [unsigned(s.ixs, s.payer), simConfig(s.commitment)] }));
    const c: any = connection as any;
    const res = typeof c._rpcBatchRequest === "function"
      ? await c._rpcBatchRequest(reqs)
      : await Promise.all(reqs.map((r) => c._rpcRequest(r.methodName, r.args)));
    return Promise.all(res.map((r: any, i: number) => readSim(r, list[i].commitment === "confirmed")));
  };
  return { slotHashAtOrAfter, slot, waitPastSlot, waitHashGone, chainTime, untilChainTime, txInfo, event, bal, rentFor, sendIxs, simulateAt, simulateMany };
}

// ─── B-13 coverage recorder (errors observed, instructions succeeded, events seen) ─────
const seen = { errors: new Set<string>(), ixOk: new Set<string>(), events: new Set<string>() };
export const coverage = {
  error(name: string) { if (name) seen.errors.add(name); },
  ok(name: string) { seen.ixOk.add(name); },
  events(names: string[]) { names.forEach((n) => seen.events.add(n.toLowerCase())); },
  report(allErrors: string[], allIx: string[], newEvents: string[]) {
    const missE = allErrors.filter((e) => !seen.errors.has(e));
    const missI = allIx.filter((i) => !seen.ixOk.has(i));
    const missV = newEvents.filter((e) => !seen.events.has(e.toLowerCase()));
    return { errors: allErrors.length - missE.length, missE, ix: allIx.length - missI.length, missI, events: newEvents.length - missV.length, missV };
  },
};

/** Expects a program error by name (or any error with ""); records it for the coverage table. */
export async function expectErr(p: Promise<any>, code: string) {
  let resolved = false;
  try { await p; resolved = true; } catch (e: any) {
    const msg = errText(e);
    expect(errMatches(msg, code), `expected error ${code || "(any)"}, got: ${msg.slice(0, 600)}`).to.equal(true);
    coverage.error(code);
  }
  if (resolved) assert.fail(`transaction succeeded but error ${code || "(any)"} was expected`);
}

/**
 * A settle refused with BetStalled prints where the KEEPER_STALL_SLOTS window went (the bet's index and anchor slot, the
 * confirmed slot now, the seat's revealed count) and rethrows: a stall from a slow host is told apart from a chain-order
 * bug (index < revealed) at a glance.
 */
export async function withStallNote<T>(p: Promise<T>, connection: Connection, targetSlot: bigint, seat: () => Promise<any>): Promise<T> {
  try {
    return await p;
  } catch (e: any) {
    if (errMatches(errText(e), "BetStalled")) {
      const { index, anchor } = betUnpack(targetSlot);
      const now = BigInt(await connection.getSlot("confirmed").catch(() => 0));
      const k = await seat().catch(() => null);
      console.log(`      (BetStalled: bet index ${index}, anchor slot ${anchor}, confirmed slot ${now} = anchor + ${now - anchor}, window ${L.KEEPER_STALL_SLOTS} slots; seat revealed ${k ? k.revealed.toString() : "?"})`);
    }
    throw e;
  }
}

/** Retries while the program answers one of `codes` (the validator clock can lag the host clock). */
export async function retry<T>(codes: string[], f: () => Promise<T>, tries = 80, ms = 500): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e: any) { if (!codes.some((c) => errMatches(errText(e), c)) || i > tries) throw e; await sleep(ms); }
  }
}

/**
 * Wraps program.methods so every successful `.rpc()` is recorded by instruction name; `record = false` (stress.test.ts):
 * nothing recorded. Either way the program's provider sends through tests/tx-confirm.cjs (hardenProvider): one send,
 * then the signature is waited for (no 30-s legacy timeout, which run-local of 2026-10-25 lost whole runs to), and a
 * transaction that landed and failed comes back as the program's AnchorError (Anchor 0.32.1 alone answers "Unknown
 * action 'undefined'"). Nothing is ever re-sent, so no instruction can run twice.
 */
export function trackedMethods(program: anchor.Program, record = true) {
  const m: any = program.methods;
  TX.hardenProvider(program.provider);
  return new Proxy(m, {
    get(target, prop: string) {
      const f = target[prop];
      if (typeof f !== "function") return f;
      return (...args: any[]) => {
        const builder = f(...args);
        const name = prop.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
        const wrap = (b: any): any => new Proxy(b, {
          get(t, p: string) {
            const v = t[p];
            if (p === "rpc") return async (...a: any[]) => {
              const sig: string = await v.apply(t, a);
              if (record) coverage.ok(name);
              return sig;
            };
            if (typeof v === "function") return (...a: any[]) => { const r = v.apply(t, a); return r === t ? wrap(t) : r; };
            return v;
          },
        });
        return wrap(builder);
      };
    },
  });
}
