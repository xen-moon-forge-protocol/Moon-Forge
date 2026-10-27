/**
 * The v3 keeper: the permissionless upkeep of the UPGRADED program (SPEC-UPGRADE-v2 §2.9-§2.16, oracle-theft-design §6),
 * plus the house-keeper seat's hash chain when this key holds the seat. It runs only when the upgraded binary is detected
 * on chain (keeperModeV3: the W2-4 verdict "upgraded"); while the live v2 binary is there, index.ts runs x1.ts keeperPass
 * exactly as on main. Every instruction here is built from the v3 IDL (connectV3 / programV3).
 *
 * One pass, time-critical work first, bounded (at most `maxTx` transactions and `deadlineMs` of wall clock):
 *   1. house bets and the Jackpot (keeper seat ["house_keeper"]):
 *      - anchor_bet for every v2 bet whose anchor block is in SlotHashes (permissionless; skipped when this key holds the
 *        seat but cannot derive its chain: an anchored bet nobody reveals is paid as a WIN after KEEPER_STALL_SLOTS);
 *      - refund_stalled_bet for every stalled or skipped bet (reason 0: never anchored and its block left SlotHashes;
 *        reason 1: anchored and not revealed within KEEPER_STALL_SLOTS = 235,000 slots, or its position was skipped).
 *        Round 4 (review F1, keeper.rs stall_split) and r4-fix: every house stall costs the keeper BOND the whole stake or
 *        more: reason 1 pays the payout from the bond (the bankroll keeps the stake, as for a lost bet); reason 0 makes the
 *        player whole (stake - edge back from the bankroll, the edge from the bond) and the bond forfeits stake - edge.
 *        So an anchor is as urgent as a Jackpot settle (512 slots): besides the pass's own anchors, the in-pass urgent
 *        check and the loop's 5-s check (houseDueV3) run the house duty at once for a keeper bet waiting for its anchor;
 *      - the holder's settle_bet_v2 pays the registered keeper wallet the G-2 settle tip (min(0.0005 XNT, half the bet's
 *        1% pool share, the free pool), BetSettled.keeper_tip); the reward vault and the keeper wallet are passed;
 *      - settle_jackpot_v2's expiry path for a v3 round whose anchor block left SlotHashes (refund; no reveal is sent);
 *      - holder only: the chain walk from `revealed` up: settle_bet_v2 / settle_jackpot_v2 with the next preimage, or
 *        reveal_keeper to skip a position whose bet was refunded or whose round expired (only when the bet list was read
 *        at or after the seat's slot, so a pending bet is never skipped by a stale read);
 *      - holder only: arm_keeper with deposit 0 (the bond already >= KEEPER_BOND_MIN) when nothing is pending and the
 *        chain is nearly used up, is not derivable by this key, or the seat was idle for KEEPALIVE_AFTER (the seat dies
 *        after 28 days without arm / reveal / settle). NEVER a deposit and NEVER take_keeper: both are owner steps (S7);
 *      - draw_jackpot (with keeper_seat): by the holder when it can settle in time, by any other key HELPER_DRAW_GRACE
 *        after the end, at once when there is no seat (the program then refunds every entry, reason 3);
 *        legacy rounds drawn by the v2 binary settle through settle_jackpot; legacy bets through settle_bet.
 *   2. Burn Lottery exits after retirement: draw_draw / settle_draw of a round open at the upgrade, close_draw_entry.
 *   3. close_jackpot_entry (refunded rounds every pass: that is the players' money; settled rounds: rent only).
 *   4. Artifact Duel timeouts (claim_duel_timeout), Moon Wars (legacy start_war, claim_war_timeout on the chess clock and
 *      the sealed start, settle_war), Predictions (lock / settle with the strict v2 clock, claim, close): the architect
 *      account is read from Config (set_architect may change it), never a constant.
 *   5. slower duties (every SLOW_EVERY_MS): seal / cancel legacy drop seeds, expire_epoch, base claims after the 48-h
 *      hold with the v3 tip rule (no tip when the oracle submits; 0.2 XNT minimum), Forge Drop delivery of v2 epochs,
 *      claim_extra / close_extra_epoch of the extra files, close_listing of stale or expired listings, the
 *      close_receipt sweep (every SWEEP_EVERY_MS), and the oracle seat's liveness (a warning before the seat can die).
 *
 * ── Hash-chain secrets (GitHub Actions has no private persistent storage) ───────────────────────────────────────────
 * Every chain is derived, never stored:
 *   K      = HMAC-SHA256(ed25519 seed of the keeper key, "MOONFORGE_KEEPER_CHAIN_KDF_V1" ‖ program id ‖ keeper pubkey)
 *   x_N    = HMAC-SHA256(K, "MOONFORGE_KEEPER_CHAIN_V1" ‖ seat PDA ‖ build slot u64 LE ‖ nonce u8 ‖ N u64 LE)
 *   x_k    = keccak(x_{k+1}),  tip = x_0,  the k-th reveal = x_k (keccak(x_k) == x_{k-1}, keeper.rs chain_next_ok)
 *   N      = CHAIN_LEN_BASE + nonce × 1024 + (build slot mod 1024), nonce random in 0..15
 * The chain id (build slot, nonce) is recovered from the seat itself: N = `length` and the arm transaction lands within
 * 1,024 slots of the build slot (its blockhash expires long before), so build slot = armed_slot − ((armed_slot − N mod
 * 1024) mod 1024), or the candidate 1,024 above it when the slot read at build time came from a node ahead of the fork
 * the arm landed on (chainIdsOf; both are tried). A restarted runner, a second runner or the owner's CLI holding the
 * same key therefore rebuilds the same chain from the chain alone, and checks it: x_revealed must equal the seat's tip.
 * No chain file, no cache, no artifact: the spec's VPS chain file (SPEC 7, `~/.moonforge/keeper-chain.json`) is not
 * needed, and a chain is 16,384..32,767 positions (not the 1,000,000 of SPEC 6.3 item 8) so a rebuild costs < 1 s and
 * a few MB; the holder re-arms (deposit 0, nothing pending) when fewer than REARM_BELOW positions are left.
 * What a reader of the repo, the logs, the run artifacts or the chain learns: the program id, the seat, the keeper
 * pubkey, the build slot and nonce (public by design: they are in `length` and `armed_slot`), the tip and every preimage
 * already revealed on chain. What it cannot learn: any unrevealed preimage. x_{r+1} is a keccak preimage of the public
 * x_r (preimage resistance), and the seed is a PRF output under K, which needs the keeper's secret key; distinct chains
 * use distinct PRF inputs, so the reveals of one chain say nothing about another. Nothing here writes a preimage to a
 * file, a cache, an artifact or a log line (error texts are scrubbed of the reveal they carried); a preimage leaves the
 * process only inside the transaction that consumes it, and only for a bet that is already anchored or a round whose
 * block already exists, so a preimage seen by an RPC node before it lands yields only the true outcome (settle is
 * permissionless and deterministic; reveal_keeper, the only way to skip a position, is keeper-signed: H1).
 * Who holds the keeper's secret key can compute every chain, past and future: that is the K-4 key risk of the spec (the
 * key could also arm any chain it likes), not a new one; the 7-day withdrawal notice and the health alerts bound it.
 * Where the key lives decides who that is: SPEC K-4 / OD-25 put INITIAL_KEEPER on a VPS, never in GitHub; then the
 * GitHub keeper.yml key is a helper (anchor, refunds, expiries, draws after a grace, claims, cleanups) and the same code
 * on the VPS, run with the INITIAL_KEEPER key, is the holder. If the owner puts the seat key in the KEEPER_PRIVATE_KEY
 * secret instead, keeper.yml is the holder and whoever reads that secret holds the seat: it learns each anchored bet's
 * outcome early (as the keeper always does; stalling or skipping is paid from its bond, never profitable), can withdraw
 * the bond after the 7-day notice and can collude with a block producer within the disclosed bounds. That is an owner
 * decision against K-4, not something this file switches on.
 * Concurrency: every write is one transaction whose program checks make a duplicate fail (a settle or a skip needs
 * keccak(reveal) == tip and the next position; a refund closes the bet; an arm needs nothing pending and a new head), so
 * two runners (keeper.yml and its backup dispatch, or the owner's machine) can only waste a fee.
 */
import * as anchor from "@coral-xyz/anchor";
import { createHmac, randomInt } from "crypto";
import { Commitment, ComputeBudgetProgram, Connection, Keypair, PublicKey, SYSVAR_SLOT_HASHES_PUBKEY, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { EpochFile } from "./epoch";
import { ExtraFileV1 } from "./extra";
import { gatedSealActionV3, sealAllowedV3 } from "./flow-v3";
import { keccak } from "./merkle";
import { deliverDrops, MPL_CORE, PDA, programId, randomU64, XDEX_XNT_OBSERVATION } from "./x1";
import { claimExtraIxV3, ClaimGuardV3, claimGuardV3, closeExtraEpochIxV3, isV3Program, PDA_V3, readUpgradeProbeV3, sweepReceiptsV3, UpgradeProbeV3, upgradeVerdictV3, UpgradeVerdictV3 } from "./x1-v3";
import { trustedConnectionFor } from "./x1-rpc";

// ── program constants (mainnet values of constants.rs / state.rs) ───────────────────────────────────────────────────
export const DAY = 86_400;
export const CLAIM_HOLD = 2 * DAY;
export const CLAIM_WINDOW = 90 * DAY;
export const KEEPER_TIP = 2_000_000n;
/** v3 (SPEC 2.1 item 3): a claim earns the tip only from 100 × KEEPER_TIP = 0.2 XNT, and never when the oracle submits it */
export const KEEPER_TIP_MIN_CLAIM_V3 = 100n * KEEPER_TIP;
export const KEEPER_BOND_MIN = 20_000_000_000n;
export const KEEPER_DEAD_DELAY = 28 * DAY;
export const KEEPER_STALL_SLOTS = 235_000n;
export const KEEPER_MAX_CHAIN = (1n << 24n) - 1n;
export const JACKPOT_MAX_BACKLOG = 32n;
export const BET_KEEPER = 0x80;
export const BET_ANCHORED = 0x40;
export const BET_GAME_MASK = 0x3f;
export const BET_SLOT_BITS = 40n;
export const BET_SLOT_MASK = (1n << BET_SLOT_BITS) - 1n;
export const WAR_V2 = 1n << 63n;
export const U64_MAX = (1n << 64n) - 1n;
export const ROUND_OPEN = 0;
export const ROUND_DRAWING = 1;
export const ROUND_SETTLED = 2;
export const ROUND_REFUND = 3;
export const DUEL_JOINED = 1;
export const WAR_STARTING = 1;
export const WAR_ACTIVE = 2;
export const WAR_DONE = 3;
export const PRED_OPEN = 0;
export const PRED_LOCKED = 1;
export const PRED_SETTLED = 2;
export const PRED_REFUND = 3;
export const PRED_V1_HORIZON = 86_400;
export const DROP_PENDING = 1;
export const DROP_SEALED = 2;
export const DEAD_SEAT_DELAY = 28 * DAY;
export const SEAT_PRIORITY_WINDOW = DAY;
/** SEAT_WALK_PAIRS (seat.rs): the most (Epoch, ExtraEpoch) pairs the dead-seat walk reads */
export const SEAT_WALK_PAIRS = 11;

// ── keeper policy (off-chain; none of these is a program rule) ─────────────────────────────────────────────────────
export const CHAIN_LEN_BASE = 16_384;
export const CHAIN_SLOT_BITS = 10;
export const CHAIN_NONCE_BITS = 4;
/** re-arm (nothing pending) once fewer positions than this remain, so bets never hit KeeperNotArmed under load */
export const REARM_BELOW = 2_048n;
/** re-arm an idle seat after this long: the seat is takeable 28 days after its last arm / reveal / settle */
export const KEEPALIVE_AFTER = 7 * DAY;
/** the holder draws a Jackpot round only with at most this many earlier positions unrevealed (the settle must land
 *  within 512 slots of the draw, after revealing every earlier position; the program refunds above 32) */
export const HOLDER_DRAW_BACKLOG = 8n;
/**
 * Another key draws an ended round (with a seat) only this long after its end. The holder draws within a pass of the
 * end; a helper's draw reserves a position on the holder's chain, so if the holder is down the round expires 512 slots
 * later: every entry refunded and min(bond, pot) from the bond to the pool, the designed price of a keeper outage.
 * The grace keeps a short holder hiccup (a restart, an RPC blip) from costing that; the players wait at most this
 * long for an outcome. Without any seat the draw is a refund at once (reason 3, no penalty), so no grace applies.
 */
export const HELPER_DRAW_GRACE = 1_800;
/**
 * R-1: the holder checks the current Jackpot round after every step of a pass and after every this many sends inside
 * a step, and settles a DRAWING v3 round at once (a third party may draw it at end_ts, at the worst moment).
 */
export const URGENT_CHECK_EVERY = 10;
/**
 * R-1: while a v3 Jackpot round is DRAWING at a position not yet revealed, the walk up to that position (refunds,
 * anchors, settles, skips) is not capped by the pass's transaction budget; it has this long. The round expires when
 * its anchor block leaves SlotHashes, 512 slots (about 190 s) after it.
 */
export const URGENT_WALK_MS = 150_000;
/** R-1: chain positions per walk transaction (anchor_bet + settle_bet_v2 each); a batch is also cut at TX_SIZE_MAX */
export const WALK_BATCH = 4;
/** the packet limit of one transaction */
export const TX_SIZE_MAX = 1_232;
/** R-1: how many times one pass re-reads and walks again while its DRAWING round waits for a block (1.5 s apart) */
export const URGENT_RETRIES = 20;
/** R-1: urgent house runs per DRAWING round and pass (a round that cannot progress never spins a whole pass) */
export const URGENT_RUNS_PER_ROUND = 3;
/** the KeeperModeV3 keeper loop: between two full passes, the Jackpot check runs every this long */
export const HOUSE_TICK_MS = 5_000;
/** R-4: the alert of a holder that cannot derive its seat's chain (every pass, ::error:: on GitHub) */
export const UNKNOWN_CHAIN_ALERT =
  "ALERT (R-4): this key holds the keeper seat but cannot derive the seat's chain: it anchors and reveals nothing, so every anchored bet becomes refundable as a WIN paid from the bond after KEEPER_STALL_SLOTS, and the re-arm waits until nothing is pending. Re-arm or take the seat with this oracle's keeper-arm / keeper-take, then check that `npm run keeper -- --once` shows role holder.";
export const SLOW_EVERY_MS = 5 * 60_000;
export const SWEEP_EVERY_MS = 6 * 3_600_000;
export const LIVENESS_EVERY_MS = 3_600_000;
/** warn this long before the oracle seat can be taken (the publish that saves it must survive a 48-h hold first) */
export const SEAT_WARN_BEFORE = 10 * DAY;

const big = (v: unknown): bigint => (v === null || v === undefined ? 0n : BigInt((v as { toString(): string }).toString()));
const num = (v: unknown): number => Number(big(v));
const u64le = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const short = (e: unknown, n = 200) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, n);

// ── pure mirrors of the program ─────────────────────────────────────────────────────────────────────────────────────
/** utils.rs bet_pack / bet_unpack */
export const betPack = (index: bigint, anchorSlot: bigint): bigint => (index << BET_SLOT_BITS) | (anchorSlot & BET_SLOT_MASK);
export const betUnpack = (ts: bigint): { index: bigint; anchor: bigint } => ({ index: ts >> BET_SLOT_BITS, anchor: ts & BET_SLOT_MASK });

export type SlotLookup = { kind: "ready"; hash: Buffer } | { kind: "notYet" } | { kind: "expired" };
/** utils.rs lookup_in on a SlotHashes buffer (u64 count | (slot u64, hash 32) newest first): the first slot >= target */
export function lookupSlotHash(data: Buffer | null | undefined, target: bigint): SlotLookup {
  if (!data || data.length < 8) return { kind: "notYet" };
  const len = Math.min(Number(data.readBigUInt64LE(0)), Math.floor((data.length - 8) / 40));
  if (len === 0) return { kind: "notYet" };
  const slotAt = (i: number) => data.readBigUInt64LE(8 + i * 40);
  if (slotAt(0) < target) return { kind: "notYet" };
  if (slotAt(len - 1) > target) return { kind: "expired" };
  let lo = 0;
  let hi = len - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (slotAt(mid) >= target) lo = mid;
    else hi = mid - 1;
  }
  const o = 8 + lo * 40 + 8;
  return { kind: "ready", hash: Buffer.from(data.subarray(o, o + 32)) };
}

/** keeper.rs stall_reason: 1 = skipped or anchored and stalled (paid as a WIN), 0 = never anchored and expired, null = not stalled */
export function stallReason(anchored: boolean, index: bigint, anchorSlot: bigint, revealed: bigint, slot: bigint, anchorExpired: boolean): 0 | 1 | null {
  if (index < revealed || (anchored && slot > anchorSlot + KEEPER_STALL_SLOTS)) return 1;
  if (!anchored && anchorExpired) return 0;
  return null;
}

/** keeper.rs jackpot_ticket_v2: the legacy formula on keccak("MOONFORGE_JACKPOT_V2" ‖ block hash ‖ reveal) */
export function jackpotTicketV2(h: Buffer, reveal: Buffer, round: PublicKey, id: bigint, total: bigint): bigint {
  const h2 = keccak(Buffer.from("MOONFORGE_JACKPOT_V2"), h, reveal);
  return randomU64(h2, round.toBuffer(), u64le(id)) % total;
}

/** forge.rs keeper_tip_due (v3): not the player, not the oracle, and at least 0.2 XNT */
export function keeperTipDueV3(payer: PublicKey, player: PublicKey, oracle: PublicKey, amount: bigint): boolean {
  return !payer.equals(player) && !payer.equals(oracle) && amount >= KEEPER_TIP_MIN_CLAIM_V3;
}

/** predictions.rs is_v1_schedule / time_reached: v1 rounds lock at now >= t, v2 rounds strictly after t */
export const predIsV1 = (lockTs: number, endTs: number) => endTs - lockTs === PRED_V1_HORIZON;
export const predTimeReached = (now: number, t: number, v1: boolean) => (v1 ? now >= t : now > t);

/** core_cpi.rs live_asset_owner: the owner of a live asset of our collection, else null */
export function liveAssetOwner(info: { owner: PublicKey; data: Buffer } | null, collection: PublicKey): PublicKey | null {
  if (!info || !info.owner.equals(MPL_CORE) || info.data.length < 66 || info.data[0] !== 1 || info.data[33] !== 2) return null;
  if (!new PublicKey(info.data.subarray(34, 66)).equals(collection)) return null;
  return new PublicKey(info.data.subarray(1, 33));
}

// ── the house-keeper seat ───────────────────────────────────────────────────────────────────────────────────────────
export interface SeatV3 {
  keeper: PublicKey;
  pendingKeeper: PublicKey;
  tip: Buffer;
  length: bigint;
  nextIndex: bigint;
  revealed: bigint;
  bond: bigint;
  pendingBets: number;
  lastActiveTs: number;
  armedSlot: bigint;
  jackpotReserved: bigint;
  withdrawTs: number;
}

export function seatOf(d: any): SeatV3 {
  return {
    keeper: d.keeper, pendingKeeper: d.pendingKeeper, tip: Buffer.from(d.tip), length: big(d.length), nextIndex: big(d.nextIndex), revealed: big(d.revealed),
    bond: big(d.bond), pendingBets: Number(d.pendingBets), lastActiveTs: num(d.lastActiveTs), armedSlot: big(d.armedSlot), jackpotReserved: big(d.jackpotReserved),
    withdrawTs: num(d.withdrawTs),
  };
}

export type RoleV3 = "no-seat" | "helper" | "holder" | "holder-unknown-chain";

/**
 * What the holder does with its seat this pass (pure). Posting a bond and taking a seat are owner steps: a seat that
 * does not exist or holds less than KEEPER_BOND_MIN is left alone, and arm_keeper is only ever sent with deposit 0.
 */
export function armDecision(seat: SeatV3 | null, me: PublicKey, chainKnown: boolean, now: number): { arm: boolean; reason: string } {
  if (!seat) return { arm: false, reason: "no keeper seat yet: the first arm_keeper (with the 20-XNT bond) is an owner step (S7)" };
  if (!seat.keeper.equals(me)) return { arm: false, reason: `helper: the seat is held by ${seat.keeper.toBase58()}` };
  if (seat.bond < KEEPER_BOND_MIN) return { arm: false, reason: `idle: the bond ${seat.bond} is below KEEPER_BOND_MIN ${KEEPER_BOND_MIN}; posting a bond is an owner step` };
  if (seat.pendingBets > 0) return { arm: false, reason: `busy: ${seat.pendingBets} pending` };
  if (!chainKnown) return { arm: true, reason: "the seat's chain is not derivable by this key: re-arming with nothing pending" };
  if (seat.length - seat.nextIndex < REARM_BELOW) return { arm: true, reason: `${seat.length - seat.nextIndex} positions left (< ${REARM_BELOW})` };
  if (now - seat.lastActiveTs >= KEEPALIVE_AFTER) return { arm: true, reason: `keepalive: idle since ${new Date(seat.lastActiveTs * 1000).toISOString()} (the seat is takeable 28 days after its last activity)` };
  return { arm: false, reason: "armed" };
}

/** Whether this keeper draws an ended Jackpot round now (pure; draw_jackpot itself is permissionless). */
export function drawDecision(round: { state: number; endTs: number; multiPlayer: boolean }, role: RoleV3, backlog: bigint, now: number): boolean {
  if (round.state !== ROUND_OPEN || round.endTs === 0 || now < round.endTs) return false;
  if (!round.multiPlayer) return true; // a single player is refunded at once: no position is used
  if (role === "holder") return backlog <= HOLDER_DRAW_BACKLOG;
  if (role === "holder-unknown-chain") return false; // a position this key cannot reveal would cost its bond the pot
  if (role === "no-seat") return true; // no seat: draw_jackpot refunds every entry at once (reason 3, no penalty)
  return now >= round.endTs + HELPER_DRAW_GRACE;
}

// ── hash chains ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ChainIdV3 {
  buildSlot: bigint;
  nonce: number;
  length: number;
}

export function chainLengthOf(buildSlot: bigint, nonce: number): number {
  if (!Number.isInteger(nonce) || nonce < 0 || nonce >= 1 << CHAIN_NONCE_BITS) throw new Error(`nonce ${nonce} out of range`);
  return CHAIN_LEN_BASE + (nonce << CHAIN_SLOT_BITS) + Number(buildSlot & BigInt((1 << CHAIN_SLOT_BITS) - 1));
}

/** The chain id of an armed seat (from `length` and `armed_slot`), or null when `length` is not one this scheme makes. */
export function chainIdOf(armedSlot: bigint, length: bigint): ChainIdV3 | null {
  const off = length - BigInt(CHAIN_LEN_BASE);
  if (off < 0n || off >= 1n << BigInt(CHAIN_SLOT_BITS + CHAIN_NONCE_BITS)) return null;
  const mod = 1n << BigInt(CHAIN_SLOT_BITS);
  const low = off & (mod - 1n);
  if (armedSlot < low) return null;
  return { buildSlot: armedSlot - ((armedSlot - low) % mod), nonce: Number(off >> BigInt(CHAIN_SLOT_BITS)), length: Number(length) };
}

/**
 * Every chain id an armed seat can carry: the build slot at or below `armed_slot` (the arm landed up to 1,023 slots
 * after the slot it was built at, the normal case: its blockhash expires after ~150), then the one 1,024 slots above
 * (the slot read at build time came from a node ahead of the fork the arm landed on). identify() tries both; each
 * candidate costs one chain build, and the tip check makes a wrong one harmless.
 */
export function chainIdsOf(armedSlot: bigint, length: bigint): ChainIdV3[] {
  const off = length - BigInt(CHAIN_LEN_BASE);
  if (off < 0n || off >= 1n << BigInt(CHAIN_SLOT_BITS + CHAIN_NONCE_BITS)) return [];
  const mod = 1n << BigInt(CHAIN_SLOT_BITS);
  const nonce = Number(off >> BigInt(CHAIN_SLOT_BITS));
  const below = chainIdOf(armedSlot, length);
  const above = below ? below.buildSlot + mod : off & (mod - 1n);
  return [...(below ? [below] : []), { buildSlot: above, nonce, length: Number(length) }];
}

/** K = HMAC-SHA256(ed25519 seed, domain ‖ program ‖ keeper): the only secret input of every chain. */
export function chainKeyOf(signer: Keypair): Buffer {
  const sk = signer.secretKey;
  if (sk.length !== 64) throw new Error("the keeper key is not an ed25519 keypair");
  return createHmac("sha256", Buffer.from(sk.subarray(0, 32)))
    .update(Buffer.concat([Buffer.from("MOONFORGE_KEEPER_CHAIN_KDF_V1"), programId.toBuffer(), signer.publicKey.toBuffer()]))
    .digest();
}

export function chainSeed(key: Buffer, seat: PublicKey, id: ChainIdV3): Buffer {
  return createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from("MOONFORGE_KEEPER_CHAIN_V1"), seat.toBuffer(), u64le(id.buildSlot), Buffer.from([id.nonce]), u64le(id.length)]))
    .digest();
}

/** [x_0 (= tip), x_1, …, x_N] with x_N = seed and x_k = keccak(x_{k+1}). */
export function buildChain(seed: Buffer, length: number): Buffer[] {
  if (!Number.isSafeInteger(length) || length < 1 || BigInt(length) > KEEPER_MAX_CHAIN) throw new Error(`chain length ${length} out of range`);
  const out = new Array<Buffer>(length + 1);
  out[length] = seed;
  for (let k = length - 1; k >= 0; k--) out[k] = keccak(out[k + 1]);
  return out;
}

/** The chains of one keeper key, rebuilt on demand and kept in memory only (never written anywhere). */
export class KeeperChains {
  readonly keeper: PublicKey;
  private readonly key: Buffer;
  private readonly cache = new Map<string, Buffer[]>();
  constructor(signer: Keypair) {
    this.keeper = signer.publicKey;
    this.key = chainKeyOf(signer);
  }
  chain(id: ChainIdV3): Buffer[] {
    const k = `${id.buildSlot}:${id.nonce}:${id.length}`;
    let c = this.cache.get(k);
    if (!c) {
      c = buildChain(chainSeed(this.key, PDA_V3.houseKeeper(), id), id.length);
      if (this.cache.size >= 2) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(k, c);
    }
    return c;
  }
  /** The seat's chain when this key built it (x_revealed == tip), else null. */
  identify(seat: SeatV3): Buffer[] | null {
    if (!seat.keeper.equals(this.keeper) || seat.length === 0n || seat.revealed > seat.length) return null;
    for (const id of chainIdsOf(seat.armedSlot, seat.length)) {
      const c = this.chain(id);
      if (c[Number(seat.revealed)].equals(seat.tip)) return c;
    }
    return null;
  }
  /** A new chain for an arm built at `buildSlot` (its tip and length; the preimages stay here). */
  fresh(buildSlot: bigint, nonce = randomInt(1 << CHAIN_NONCE_BITS)): { id: ChainIdV3; tip: Buffer } {
    const id = { buildSlot, nonce, length: chainLengthOf(buildSlot, nonce) };
    return { id, tip: this.chain(id)[0] };
  }
}

// ── detection (W2-4) ────────────────────────────────────────────────────────────────────────────────────────────────
export type KeeperModeV3 = "v2" | "v3";

/**
 * Which keeper pass runs: "v3" only when the W2-4 verdict is "upgraded" (deploy slot after 85,429,880 AND ExtraState and
 * OracleSeat, which only the upgraded program creates, present and decoding); "v2" (x1.ts keeperPass, as on main) for
 * the live binary and for a half-done upgrade. An RPC error keeps the previous mode of this process (v2 at start).
 */
export async function keeperModeV3(connection: Connection, program: anchor.Program, previous: KeeperModeV3 = "v2"): Promise<{ mode: KeeperModeV3; verdict: UpgradeVerdictV3 }> {
  let probe: UpgradeProbeV3;
  try {
    probe = await readUpgradeProbeV3(connection, "confirmed");
  } catch (e) {
    probe = { deploySlot: null, extraState: null, oracleSeat: null, houseKeeper: null, error: `RPC error: ${short(e, 160)}` };
  }
  const verdict = upgradeVerdictV3(probe, program);
  if (verdict.status === "upgraded") return { mode: "v3", verdict };
  if (verdict.status === "legacy") return { mode: "v2", verdict };
  return { mode: probe.error && /RPC error/.test(probe.error) ? previous : "v2", verdict };
}

// ── account reads (v3 coder) ────────────────────────────────────────────────────────────────────────────────────────
function coderName(program: anchor.Program, name: string): string {
  const n = ((program.idl as anchor.Idl).accounts ?? []).find((a) => a.name.toLowerCase() === name.toLowerCase())?.name;
  if (!n) throw new Error(`the client's IDL has no ${name} account`);
  return n;
}
export function decodeAs(program: anchor.Program, name: string, data: Buffer): any {
  return program.coder.accounts.decode(coderName(program, name), data);
}
function tryDecode(program: anchor.Program, name: string, info: { owner: PublicKey; data: Buffer } | null): any | null {
  if (!info || !info.owner.equals(programId)) return null;
  try {
    return decodeAs(program, name, Buffer.from(info.data));
  } catch {
    return null;
  }
}
export async function fetchAs(connection: Connection, program: anchor.Program, name: string, pk: PublicKey, commitment: Commitment = "confirmed"): Promise<any | null> {
  return tryDecode(program, name, await connection.getAccountInfo(pk, commitment));
}
async function fetchManyAs(connection: Connection, program: anchor.Program, name: string, pks: PublicKey[]): Promise<(any | null)[]> {
  const out: (any | null)[] = [];
  for (let i = 0; i < pks.length; i += 100) {
    const infos = await connection.getMultipleAccountsInfo(pks.slice(i, i + 100), "confirmed");
    for (const info of infos) out.push(tryDecode(program, name, info as { owner: PublicKey; data: Buffer } | null));
  }
  return out;
}
export interface Listed {
  pk: PublicKey;
  acc: any;
}
/** Every account of a type (discriminator memcmp) with the RPC's context slot (null when the node gave none). */
export async function allAs(connection: Connection, program: anchor.Program, name: string, minContextSlot?: number, extra: { memcmp: { offset: number; bytes: string } }[] = []): Promise<{ slot: number | null; items: Listed[] }> {
  const n = coderName(program, name);
  const f = program.coder.accounts.memcmp(n) as { offset?: number; bytes: string };
  const res: any = await connection.getProgramAccounts(programId, {
    commitment: "confirmed", withContext: true, filters: [{ memcmp: { offset: f.offset ?? 0, bytes: f.bytes } }, ...extra], ...(minContextSlot === undefined ? {} : { minContextSlot }),
  } as any);
  const list: { pubkey: PublicKey; account: { data: Buffer } }[] = Array.isArray(res) ? res : res.value;
  const slot: number | null = Array.isArray(res) ? null : res.context?.slot ?? null;
  const items: Listed[] = [];
  for (const { pubkey, account } of list) {
    try {
      items.push({ pk: pubkey, acc: program.coder.accounts.decode(n, Buffer.from(account.data)) });
    } catch {
      /* another account type sharing the prefix: skipped */
    }
  }
  return { slot, items };
}

// ── the pass ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Per-process memory of the keeper loop: when the slow duties last ran and when the last liveness warning was given. */
export interface MemoV3 {
  last: Record<string, number>;
}
export const newMemoV3 = (): MemoV3 => ({ last: {} });

export interface PassOptsV3 {
  /** published epoch files (any version) the keeper claims for */
  epochFiles?: EpochFile[];
  /** extra-<n>.json files */
  extraFiles?: ExtraFileV1[];
  maxTx?: number;
  deadlineMs?: number;
  /** false near the end of a run: a Jackpot drawn now could not be settled by this run */
  allowDraw?: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  chains?: KeeperChains;
  memo?: MemoV3;
  /** ms clock of the slow-duty schedule (tests) */
  clockMs?: () => number;
  /** R-5: the connection for the reads a reveal depends on (default: trustedConnectionFor(connection)) */
  trusted?: Connection;
  /** R-1: only the house duty (the keeper loop's 5-s Jackpot timer between full passes) */
  houseOnly?: boolean;
}

export interface PassReportV3 {
  role: RoleV3;
  sent: number;
  failed: number;
  notes: string[];
}

/** Scrubs every encoding of each secret from an error text (a reveal never reaches a log). */
export function scrubSecrets(text: string, secrets: Buffer[]): string {
  let t = text;
  for (const s of secrets) for (const enc of [s.toString("hex"), s.toString("base64"), anchor.utils.bytes.bs58.encode(s), Array.from(s).join(",")]) t = t.split(enc).join("<reveal>");
  return t;
}

export class TxBudget {
  sent = 0;
  failed = 0;
  private since = 0;
  private inHook = false;
  /**
   * R-1: called after every `every` sends of THIS budget (never re-entered, never for a child's sends), so a long loop
   * (claims, extra claims, the receipt sweep, drop delivery) looks at the Jackpot round while it works.
   */
  hook: { every: number; fn: () => Promise<void> } | null = null;
  /** `parent`: a child budget (the urgent walk) also counts its sends there, without the parent's caps. */
  constructor(private readonly maxTx: number, private readonly deadline: number, private readonly log: (s: string) => void, private readonly parent: TxBudget | null = null) {}
  canSend(): boolean {
    return this.sent < this.maxTx && Date.now() < this.deadline;
  }
  /** one attempt (`sent` counts every attempt, `failed` the failed ones), here and in the parent */
  private count(failed: boolean) {
    if (failed) this.failed++;
    else this.sent++;
    if (this.parent) this.parent.count(failed);
  }
  /** Sends one transaction; never throws. `secrets` are scrubbed from any error text (a reveal never reaches a log). */
  async send(label: string, fn: () => Promise<string>, secrets: Buffer[] = []): Promise<boolean> {
    if (!this.canSend()) return false;
    this.count(false);
    let ok = false;
    try {
      const sig = await fn();
      this.log(`  ${label}: ${sig}`);
      ok = true;
    } catch (e) {
      this.count(true);
      this.log(`  ${label} failed: ${scrubSecrets(short(e), secrets)}`);
    }
    if (this.hook && !this.inHook && ++this.since >= this.hook.every) {
      this.since = 0;
      this.inHook = true;
      try {
        await this.hook.fn();
      } catch (e) {
        this.log(`  urgent check: ${short(e)}`);
      } finally {
        this.inHook = false;
      }
    }
    return ok;
  }
}

interface Ctx {
  connection: Connection;
  program: anchor.Program;
  payer: Keypair;
  log: (s: string) => void;
  run: TxBudget;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  chains: KeeperChains;
  cfg: any;
  architect: PublicKey;
  report: PassReportV3;
  allowDraw: boolean;
  /** D-47: one guard for every automatic claim of the pass (base and extra), from Config.oracle */
  claimGuard: ClaimGuardV3;
  /**
   * R-5: the connection of every read that decides a reveal (the seat, the Bet and JackpotRound lists, SlotHashes, the
   * slot, the Jackpot entries): the default endpoint only, never an X1_RPC_URLS entry (trustedConnectionFor).
   */
  trusted: Connection;
  /** set while houseV3 runs, so the urgent check never re-enters it */
  inHouse: boolean;
  /** R-1: urgent house runs per DRAWING round in this pass */
  urgentRuns: Map<string, number>;
  /** round 4: the keeper bets this pass already anchored or settled (an RPC still behind never re-triggers the urgent check) */
  anchoredPks: Set<string>;
}

const methods = (program: anchor.Program) => program.methods as any;

/** One v3 keeper pass (see the file header). Never throws on a single failed transaction; throws when Config is unreadable. */
export async function keeperPassV3(connection: Connection, program: anchor.Program, payer: Keypair, log: (s: string) => void = console.log, o: PassOptsV3 = {}): Promise<PassReportV3> {
  if (!isV3Program(program)) throw new Error("keeperPassV3: the client is not built from moon_forge.v3.json");
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const clockMs = o.clockMs ?? (() => Date.now());
  const memo = o.memo ?? newMemoV3();
  const report: PassReportV3 = { role: "no-seat", sent: 0, failed: 0, notes: [] };
  const run = new TxBudget(o.maxTx ?? 60, Date.now() + (o.deadlineMs ?? 150_000), log);
  const trusted = o.trusted ?? trustedConnectionFor(connection);
  const cfg = await fetchAs(trusted, program, "Config", PDA.config());
  if (!cfg) throw new Error("Config could not be read");
  const c: Ctx = {
    connection, program, payer, log, run, now, sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), chains: o.chains ?? new KeeperChains(payer),
    cfg, architect: cfg.architect as PublicKey, report, allowDraw: o.allowDraw !== false,
    claimGuard: claimGuardV3(connection, payer.publicKey, (cfg.oracle as PublicKey | undefined) ?? null),
    trusted, inHouse: false, urgentRuns: new Map(), anchoredPks: new Set(),
  };
  // R-1: draw_jackpot is permissionless at end_ts, and a v3 round must be settled within 512 slots of its anchor block.
  // So the holder looks at the round after every step and every URGENT_CHECK_EVERY sends inside the long loops (claims,
  // extra claims, the sweep, drop delivery), and runs the house duty at once when a round is DRAWING.
  const urgent = () => urgentHouseV3(c);
  run.hook = { every: URGENT_CHECK_EVERY, fn: urgent };
  const step = async (what: string, f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      report.notes.push(`${what}: ${short(e)}`);
      log(`  ${what}: ${short(e)}`);
    }
    if (what !== "house keeper") {
      try {
        await urgent();
      } catch (e) {
        log(`  urgent check: ${short(e)}`);
      }
    }
  };
  const due = (task: string, every: number) => {
    const t = clockMs();
    if (memo.last[task] !== undefined && t - memo.last[task] < every) return false;
    memo.last[task] = t;
    return true;
  };
  await step("house keeper", () => houseV3(c, 0));
  if (o.houseOnly) {
    if (report.role === "holder-unknown-chain") report.notes.push(UNKNOWN_CHAIN_ALERT);
    report.sent = run.sent;
    report.failed = run.failed;
    return report;
  }
  await step("burn lottery", () => lotteryV3(c));
  await step("jackpot entries", () => jackpotEntriesV3(c, due("settled-entries", SLOW_EVERY_MS)));
  await step("duels", () => duelsV3(c));
  await step("moon wars", () => warsV3(c));
  await step("predictions", () => predictionsV3(c));
  if (due("epochs", SLOW_EVERY_MS)) await step("epochs", () => epochsV3(c, o.epochFiles ?? []));
  if (due("extras", SLOW_EVERY_MS)) await step("extra pot", () => extrasV3(c, o.extraFiles ?? []));
  if (due("listings", SLOW_EVERY_MS)) await step("listings", () => listingsV3(c));
  // R-1 (2): the sweep is bounded by the pass budget like every other loop (it used to send without a bound)
  if (run.canSend() && due("sweep", SWEEP_EVERY_MS)) await step("receipt sweep", async () => void (await sweepReceiptsV3(connection, program, payer, log, run)));
  if (due("liveness", LIVENESS_EVERY_MS)) await step("oracle seat", () => oracleSeatV3(c));
  if (c.claimGuard.stopped) report.notes.push(c.claimGuard.stopped);
  if (report.role === "holder-unknown-chain") report.notes.push(UNKNOWN_CHAIN_ALERT);
  report.sent = run.sent;
  report.failed = run.failed;
  return report;
}

// ── 1. house bets and the Jackpot ───────────────────────────────────────────────────────────────────────────────────
async function slotHashesData(connection: Connection): Promise<Buffer | null> {
  const info = await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, "confirmed");
  return info ? Buffer.from(info.data) : null;
}

async function jackpotEntriesOf(c: Ctx, roundId: bigint, entries: number): Promise<{ pk: PublicKey; acc: any }[]> {
  const pks = Array.from({ length: entries }, (_, i) => PDA.jpEntry(roundId, i));
  const accs = await fetchManyAs(c.trusted, c.program, "JackpotEntry", pks); // R-5
  return pks.map((pk, i) => ({ pk, acc: accs[i] })).filter((e) => e.acc);
}

/** allAs at or after `minSlot`; a node still behind that slot ("minimum context slot not reached") gets one retry. */
async function listFresh(c: Ctx, name: string, minSlot: number): Promise<{ slot: number | null; items: Listed[] }> {
  try {
    return await allAs(c.trusted, c.program, name, minSlot); // R-5: the lists a skip depends on
  } catch (e) {
    if (!/context slot/i.test(short(e))) throw e;
    await c.sleep(1_000);
    return allAs(c.trusted, c.program, name, minSlot);
  }
}

const winnerOf = (entries: { pk: PublicKey; acc: any }[], ticket: bigint, size: (a: any) => bigint) =>
  entries.find((e) => ticket >= big(e.acc.start) && ticket < big(e.acc.start) + size(e.acc)) ?? null;

/** One position of the holder's walk: the instructions that reveal it, in chain order. */
interface WalkOpV3 {
  p: bigint;
  kind: "settle" | "anchor+settle" | "skip" | "jackpot";
  ixs: TransactionInstruction[];
  reveal: Buffer;
  label: string;
  /** the bet (anchor+settle / settle), for the R-6 re-read */
  bet?: Listed;
}

/** Serialized size of a transaction carrying `ixs` signed by `payer` alone (a dummy blockhash: the size does not depend on it). */
export function txSizeOf(ixs: TransactionInstruction[], payer: PublicKey): number {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: PublicKey.default.toBase58() }).add(...ixs);
  const sigs = tx.compileMessage().header.numRequiredSignatures;
  const n = sigs < 128 ? 1 : 2;
  return n + 64 * sigs + tx.serializeMessage().length;
}

// ── compute-unit limits (KEEPER-INCOME.md; agents/README.md "Compute-unit limits") ─────────────────────────────────
/**
 * X1 charges 10 lamports per compute unit REQUESTED; without a limit every instruction requests 200,000 (≈ 0.002 XNT per
 * transaction). No v3 instruction has a measured limit yet (none was measured on the final build), so every keeper
 * transaction is simulated first with the same instructions (nothing signed or sent) and carries that measurement × 1.2
 * rounded up to 1,000 (the kit's rule, limitFor): about 8× cheaper for a settle. A simulation that the program refuses is
 * reported as that refusal, with no fee spent. A node that cannot simulate (an RPC error, or a client without it) sends
 * as before, without a limit, so a keeper duty never waits on a measurement.
 */
export const CU_SIM_UNITS = 1_400_000;
export function cuLimitForV3(consumed: number): number {
  return Math.min(CU_SIM_UNITS, Math.max(1_000, Math.ceil((consumed * 1.2) / 1_000) * 1_000));
}
/** the limit instruction a transaction carries (and what the size check counts for it: its data does not depend on the units) */
export const cuIxV3 = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });

/** The units the instructions consume, by a simulation at "confirmed" (null: the node cannot simulate); throws on a program refusal. */
export async function measureCuV3(connection: Connection, payer: PublicKey, ixs: TransactionInstruction[]): Promise<number | null> {
  const sim = (connection as { simulateTransaction?: unknown }).simulateTransaction;
  if (typeof sim !== "function") return null;
  let r: Awaited<ReturnType<Connection["simulateTransaction"]>>;
  try {
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: [cuIxV3(CU_SIM_UNITS), ...ixs] }).compileToV0Message();
    r = await connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  } catch {
    return null;
  }
  if (r.value.err) {
    const why = (r.value.logs ?? []).find((l) => /Error Code|failed|insufficient/i.test(l)) ?? JSON.stringify(r.value.err);
    throw new Error(`refused in simulation (nothing was sent): ${why.slice(0, 200)}`);
  }
  return typeof r.value.unitsConsumed === "number" && r.value.unitsConsumed > 0 ? r.value.unitsConsumed : null;
}

async function sendTx(c: { program: anchor.Program; payer: Keypair }, ixs: TransactionInstruction[]): Promise<string> {
  // R-5: simulated on the very connection the transaction is then sent through (a reveal's preimage reaches no other node)
  const units = await measureCuV3(c.program.provider.connection, c.payer.publicKey, ixs);
  const pre = units === null ? [] : [cuIxV3(cuLimitForV3(units))];
  return c.program.provider.sendAndConfirm!(new Transaction().add(...pre, ...ixs), []);
}

/**
 * R-1: the holder's urgent check, one read: the current Jackpot round (and the next id, in case Config moved during the
 * pass) DRAWING with the v3 marker means a settle is due within 512 slots of its anchor block; the house duty runs at
 * once. Nothing for any other role (only the holder holds the preimage), nothing while the house duty already runs.
 */
async function urgentHouseV3(c: Ctx): Promise<void> {
  if (c.inHouse) return;
  // round 4 (review F1): a keeper bet left unanchored until its block leaves SlotHashes costs the bond its whole stake, so
  // an anchor due makes the house duty urgent for every role that anchors (at most URGENT_RUNS_PER_ROUND per pass)
  if (anchorsForRoleV3(c.report.role) && (c.urgentRuns.get("anchor") ?? 0) < URGENT_RUNS_PER_ROUND) {
    const bet = await anchorDueV3(c.trusted, c.program, c.anchoredPks).catch(() => null);
    if (bet) {
      c.urgentRuns.set("anchor", (c.urgentRuns.get("anchor") ?? 0) + 1);
      c.log(`  bet ${bet} waits for its anchor (its block leaves SlotHashes in ~3 min): the house duty runs now`);
      await houseV3(c, 0);
      return;
    }
  }
  if (c.report.role !== "holder") return;
  const id = big(c.cfg.jackpotRound);
  const pks = [PDA.jackpot(id), PDA.jackpot(id + 1n)];
  const infos = await c.trusted.getMultipleAccountsInfo(pks, "confirmed");
  let due: string | null = null;
  let slot: bigint | null = null;
  for (let i = 0; i < infos.length && !due; i++) {
    const r = tryDecode(c.program, "JackpotRound", infos[i] as { owner: PublicKey; data: Buffer } | null);
    if (!r || Number(r.state) !== ROUND_DRAWING || big(r.winningTicket) !== U64_MAX) continue;
    // an anchor block already out of SlotHashes (512 slots) is the expiry, which the next house duty sends anyway
    slot ??= BigInt(await c.trusted.getSlot("confirmed"));
    if (slot > betUnpack(big(r.targetSlot)).anchor + 512n) continue;
    const k = pks[i].toBase58();
    // at most URGENT_RUNS_PER_ROUND urgent runs per round and pass (each already walks and retries for a while)
    if ((c.urgentRuns.get(k) ?? 0) >= URGENT_RUNS_PER_ROUND) continue;
    c.urgentRuns.set(k, (c.urgentRuns.get(k) ?? 0) + 1);
    due = `jackpot ${r.id}`;
  }
  if (!due) return;
  c.log(`  ${due} is DRAWING: the house duty runs now (R-1)`);
  await houseV3(c, 0);
}

async function houseV3(c: Ctx, depth: number): Promise<void> {
  if (depth === 0) {
    if (c.inHouse) return;
    c.inHouse = true;
    try {
      await houseV3Once(c, 0);
    } finally {
      c.inHouse = false;
    }
    return;
  }
  await houseV3Once(c, depth);
}

async function houseV3Once(c: Ctx, depth: number): Promise<void> {
  const { program, payer, run, log } = c;
  const rd = c.trusted; // R-5: every read below decides what is revealed
  const read = await rd.getAccountInfoAndContext(PDA_V3.houseKeeper(), "confirmed");
  const seatSlot = read.context.slot;
  const raw = tryDecode(program, "HouseKeeper", read.value as { owner: PublicKey; data: Buffer } | null);
  const seat = raw ? seatOf(raw) : null;
  const holder = !!seat && seat.keeper.equals(payer.publicKey);
  const chain = holder ? c.chains.identify(seat!) : null;
  const role: RoleV3 = !seat ? "no-seat" : !holder ? "helper" : chain ? "holder" : "holder-unknown-chain";
  c.report.role = role;
  if (depth === 0 && role === "holder-unknown-chain") {
    log(`  keeper seat: held by this key but its chain (armed slot ${seat!.armedSlot}, length ${seat!.length}) is not one this key derives: no anchor, no reveal; re-arm once nothing is pending`);
    log(`  ${UNKNOWN_CHAIN_ALERT}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error::${UNKNOWN_CHAIN_ALERT}`);
  }
  const slot = BigInt(await rd.getSlot("confirmed"));
  const sh = await slotHashesData(rd);
  // both lists at or after the seat's slot: a position looks empty (and is skipped) only when neither a bet nor a
  // DRAWING round holds it in the state the seat was read at (a stale list could make the keeper skip a live round's
  // position, and that round would then expire against the bond)
  const bets = await listFresh(c, "Bet", seatSlot);
  const rounds = await listFresh(c, "JackpotRound", seatSlot);
  const now = c.now();
  const keeperBets = bets.items.filter((b) => (Number(b.acc.game) & BET_KEEPER) !== 0);
  const legacyBets = bets.items.filter((b) => (Number(b.acc.game) & BET_KEEPER) === 0);
  const closed = new Set<string>();
  const anchored = (b: Listed) => (Number(b.acc.game) & BET_ANCHORED) !== 0;
  const drawingV3 = rounds.items.filter((r) => Number(r.acc.state) === ROUND_DRAWING && big(r.acc.winningTicket) === U64_MAX);
  // R-5 (2): the lists are complete only when they hold exactly the seat's pending count (every pending keeper bet,
  // whatever its index, plus every DRAWING v3 round); an endpoint that omits one never gets a live position skipped
  const complete = !!seat && keeperBets.length + drawingV3.length === seat.pendingBets;

  // R-1 (3): a v3 round DRAWING at a position the holder still has to reveal, whose anchor block is still in
  // SlotHashes: the walk up to it is urgent and gets its own budget (the round expires against the bond otherwise)
  const urgentRound =
    role === "holder" && seat
      ? drawingV3
        .map((r) => ({ r, ...betUnpack(big(r.acc.targetSlot)) }))
        .filter((x) => x.index >= seat.revealed && lookupSlotHash(sh, x.anchor).kind !== "expired")
        .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0))[0] ?? null
      : null;
  const urgentPos = urgentRound ? urgentRound.index : null;
  const walkRun = urgentPos !== null ? new TxBudget(Number.MAX_SAFE_INTEGER, Date.now() + URGENT_WALK_MS, log, run) : run;
  const budgetFor = (index: bigint) => (urgentPos !== null && index <= urgentPos ? walkRun : run);

  const anchorIx = (b: Listed) => methods(program).anchorBet().accountsPartial({ bet: b.pk, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).instruction() as Promise<TransactionInstruction>;
  const anchorOne = async (b: Listed, budget: TxBudget) => {
    // round 4: never twice in one pass (an RPC still behind the anchor this pass sent lists the bet as unanchored)
    if (anchored(b) || c.anchoredPks.has(b.pk.toBase58()) || !budget.canSend()) return;
    const { anchor: a } = betUnpack(big(b.acc.targetSlot));
    if (lookupSlotHash(sh, a).kind !== "ready") return;
    const ok = await budget.send(`anchored bet ${b.pk.toBase58()}`, async () => sendTx(c, [await anchorIx(b)]));
    if (ok) {
      b.acc.game = Number(b.acc.game) | BET_ANCHORED;
      c.anchoredPks.add(b.pk.toBase58());
    }
  };

  // a. anchors: a helper (or anyone without a seat) anchors every keeper bet whose block is in SlotHashes (permissionless).
  //    The holder anchors inside its walk (anchor_bet + settle_bet_v2 in one transaction) and, after the walk, the bets
  //    it did not reach. Nothing when this key holds a seat it cannot reveal.
  if (role === "helper" || role === "no-seat") for (const b of keeperBets) await anchorOne(b, run);
  // b. refunds of stalled or skipped bets (permissionless); before an urgent round on the walk's budget, since the walk
  //    can only skip a refunded position
  const revealed0 = seat ? seat.revealed : 0n;
  if (seat) {
    for (const b of keeperBets) {
      const { index, anchor: a } = betUnpack(big(b.acc.targetSlot));
      const budget = index >= revealed0 ? budgetFor(index) : run; // a skipped position (index < revealed) blocks nothing
      if (!budget.canSend()) continue;
      const reason = stallReason(anchored(b), index, a, revealed0, slot, lookupSlotHash(sh, a).kind === "expired");
      if (reason === null) continue;
      const ok = await budget.send(`refunded stalled bet ${b.pk.toBase58()} (reason ${reason})`, () =>
        methods(program).refundStalledBet().accountsPartial({
          config: PDA.config(), bet: b.pk, playerState: b.acc.playerState, bankrollVault: PDA.bankrollVault(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
          rentPayer: b.acc.rentPayer, keeperSeat: PDA_V3.houseKeeper(), rewardVault: PDA.rewardVault(),
        }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
      if (ok) closed.add(b.pk.toBase58());
    }
  }
  // c. v3 rounds whose anchor block left SlotHashes: the expiry path refunds every entry (no reveal is sent)
  for (const r of drawingV3) {
    const { anchor: a } = betUnpack(big(r.acc.targetSlot));
    if (lookupSlotHash(sh, a).kind !== "expired" || !run.canSend()) continue;
    const e0 = (await jackpotEntriesOf(c, big(r.acc.id), Number(r.acc.entries)))[0];
    if (!e0) continue;
    const ok = await run.send(`jackpot ${r.acc.id} expired: every entry refunded`, () =>
      methods(program).settleJackpotV2(Array.from(Buffer.alloc(32))).accountsPartial({
        config: PDA.config(), round: r.pk, entry: e0.pk, winnerState: PDA.player(e0.acc.player), rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(),
        architect: c.architect, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, keeperSeat: PDA_V3.houseKeeper(),
      }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
    if (ok) r.acc.state = ROUND_REFUND;
  }
  // d. the chain walk (holder): positions from `revealed` up, in order, up to WALK_BATCH per transaction (not when a
  //    re-arm is due: with nothing pending the only work left would be skips, and the arm resets the positions anyway)
  const arm = holder && seat ? armDecision(seat, payer.publicKey, !!chain, now) : null;
  let walked = 0;
  let reached = seat ? seat.revealed : 0n;
  if (role === "holder" && seat && chain && !arm?.arm) {
    const items = new Map<string, { kind: "bet" | "jackpot"; it: Listed }>();
    for (const b of keeperBets) if (!closed.has(b.pk.toBase58())) items.set(betUnpack(big(b.acc.targetSlot)).index.toString(), { kind: "bet", it: b });
    for (const r of drawingV3) if (Number(r.acc.state) === ROUND_DRAWING) items.set(betUnpack(big(r.acc.targetSlot)).index.toString(), { kind: "jackpot", it: r });
    const fresh = bets.slot !== null && bets.slot >= seatSlot && rounds.slot !== null && rounds.slot >= seatSlot;
    // G-2 (program lane, IDL of 2026-10-25): settle_bet_v2 also takes the reward vault (it pays the settle tip) and the
    // registered keeper wallet (seat.keeper, which receives it); both passed explicitly, never resolved by a fetch
    const settleIx = (b: Listed, reveal: Buffer) =>
      methods(program).settleBetV2(Array.from(reveal)).accountsPartial({
        config: PDA.config(), bet: b.pk, playerState: b.acc.playerState, bankrollVault: PDA.bankrollVault(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
        rentPayer: b.acc.rentPayer, keeperSeat: PDA_V3.houseKeeper(), rewardVault: PDA.rewardVault(), keeper: seat.keeper,
      }).instruction() as Promise<TransactionInstruction>;
    /** the op of position p, or the reason the walk stops there */
    const opAt = async (p: bigint): Promise<WalkOpV3 | { stop: string | null }> => {
      const reveal = chain[Number(p) + 1];
      const item = items.get(p.toString());
      if (!item) {
        if (!fresh) return { stop: `position ${p}: nothing pending in a bet list read at slot ${bets.slot ?? "unknown"} (seat read at ${seatSlot}): the skip waits for a fresher read` };
        if (!complete) return { stop: `position ${p}: nothing listed, but the lists hold ${keeperBets.length + drawingV3.length} pending items and the seat ${seat.pendingBets}: the skip waits for a complete read (R-5)` };
        const ix = (await methods(program).revealKeeper(Array.from(reveal)).accountsPartial({ keeperSeat: PDA_V3.houseKeeper(), keeper: payer.publicKey }).instruction()) as TransactionInstruction;
        return { p, kind: "skip", ixs: [ix], reveal, label: `skipped position ${p} (refunded bet or expired round)` };
      }
      if (item.kind === "bet") {
        const b = item.it;
        const { anchor: a } = betUnpack(big(b.acc.targetSlot));
        if (slot > a + KEEPER_STALL_SLOTS) return { stop: null }; // stalled: refund-only (step b)
        if (anchored(b)) return { p, kind: "settle", ixs: [await settleIx(b, reveal)], reveal, label: `settled bet ${b.pk.toBase58()} (position ${p})`, bet: b };
        if (lookupSlotHash(sh, a).kind !== "ready") return { stop: null }; // not produced yet, or expired (refunded above / next pass)
        return { p, kind: "anchor+settle", ixs: [await anchorIx(b), await settleIx(b, reveal)], reveal, label: `anchored and settled bet ${b.pk.toBase58()} (position ${p})`, bet: b };
      }
      const r = item.it;
      const { anchor: a } = betUnpack(big(r.acc.targetSlot));
      const l = lookupSlotHash(sh, a);
      if (l.kind !== "ready") return { stop: null }; // not produced yet (next try), or expired (step c)
      const total = big(r.acc.total);
      const ticket = jackpotTicketV2(l.hash, reveal, r.pk, big(r.acc.id), total);
      const w = winnerOf(await jackpotEntriesOf(c, big(r.acc.id), Number(r.acc.entries)), ticket, (e) => big(e.amount));
      if (!w) return { stop: `jackpot ${r.acc.id}: no entry holds ticket ${ticket} (entries unreadable): retried next pass` };
      const ix = (await methods(program).settleJackpotV2(Array.from(reveal)).accountsPartial({
        config: PDA.config(), round: r.pk, entry: w.pk, winnerState: PDA.player(w.acc.player), rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(),
        architect: c.architect, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, keeperSeat: PDA_V3.houseKeeper(),
      }).instruction()) as TransactionInstruction;
      return { p, kind: "jackpot", ixs: [ix], reveal, label: `jackpot ${r.acc.id} settled (position ${p}, ticket ${ticket})` };
    };
    /** R-6: the anchored flags of the bets the next batch may carry, read again (the player's page anchors ~2 s after placing) */
    const refresh = async (from: bigint) => {
      const list: Listed[] = [];
      for (let p = from; p < from + BigInt(WALK_BATCH); p++) {
        const it = items.get(p.toString());
        if (it && it.kind === "bet" && !anchored(it.it)) list.push(it.it);
      }
      if (!list.length) return;
      const infos = await rd.getMultipleAccountsInfo(list.map((b) => b.pk), "confirmed");
      infos.forEach((info, i) => {
        const d = tryDecode(program, "Bet", info as { owner: PublicKey; data: Buffer } | null);
        if (d && (Number(d.game) & BET_ANCHORED) !== 0) list[i].acc.game = Number(list[i].acc.game) | BET_ANCHORED;
      });
    };
    let revealed = seat.revealed;
    let why: string | null = null;
    while (revealed < seat.nextIndex && revealed < seat.length) {
      const budget = budgetFor(revealed);
      if (!budget.canSend()) break;
      await refresh(revealed);
      const ops: WalkOpV3[] = [];
      for (let p = revealed; ops.length < WALK_BATCH && p < seat.nextIndex && p < seat.length; p++) {
        if (budgetFor(p) !== budget) break; // the urgent part of the walk and the rest never share a transaction
        const op = await opAt(p);
        if ("stop" in op) {
          if (!ops.length) why = op.stop;
          break;
        }
        if (ops.length && txSizeOf([cuIxV3(CU_SIM_UNITS), ...ops.flatMap((o) => o.ixs), ...op.ixs], payer.publicKey) > TX_SIZE_MAX) break;
        ops.push(op);
      }
      if (!ops.length) break;
      const label = ops.length === 1 ? ops[0].label : `${ops.map((o) => o.label).join("; ")} (one transaction)`;
      let done = (await budget.send(label, () => sendTx(c, ops.flatMap((o) => o.ixs)), ops.map((o) => o.reveal))) ? ops.length : 0;
      if (!done && ops.length > 1) {
        // a batch is all or nothing: the first position again, alone (it may be the one that failed, then the walk stops)
        done = (await budget.send(ops[0].label, () => sendTx(c, ops[0].ixs), [ops[0].reveal])) ? 1 : 0;
      }
      if (!done && ops[0].kind === "anchor+settle" && ops[0].bet) {
        // R-6: a lost anchor race (the player's page, a helper or anyone anchored it first): read the bet again and,
        // if it is anchored now, settle it; never stop the walk on an anchor someone else already made
        const b = ops[0].bet;
        const cur = await fetchAs(rd, program, "Bet", b.pk);
        if (cur && (Number(cur.game) & BET_ANCHORED) !== 0) {
          b.acc.game = Number(b.acc.game) | BET_ANCHORED;
          const ix = await settleIx(b, ops[0].reveal);
          done = (await budget.send(`settled bet ${b.pk.toBase58()} (position ${ops[0].p}, anchored by someone else)`, () => sendTx(c, [ix]), [ops[0].reveal])) ? 1 : 0;
        }
      }
      if (!done) break;
      for (const o of ops.slice(0, done)) {
        items.delete(o.p.toString());
        if (o.bet) c.anchoredPks.add(o.bet.pk.toBase58());
      }
      revealed += BigInt(done);
      walked += done;
    }
    if (why) log(`  ${why}`);
    reached = revealed;
    // a'. the bets the walk did not reach, anchored now so their block cannot leave SlotHashes first (a reason-0 refund
    //     paid from the bond), but none past a DRAWING round still to settle: R-1, every send goes to that round first
    const roundLeft = urgentPos !== null && reached <= urgentPos;
    for (const b of keeperBets) {
      if (closed.has(b.pk.toBase58())) continue;
      const { index } = betUnpack(big(b.acc.targetSlot));
      if (index < reached || (roundLeft && index > urgentPos!)) continue;
      await anchorOne(b, run);
    }
  }
  // e. legacy (v2-binary) jackpot rounds still DRAWING: settle_jackpot on the block hash
  for (const r of rounds.items.filter((x) => Number(x.acc.state) === ROUND_DRAWING && big(x.acc.winningTicket) !== U64_MAX)) {
    if (!run.canSend()) break;
    const l = lookupSlotHash(sh, big(r.acc.targetSlot));
    if (l.kind === "notYet") continue;
    const entries = await jackpotEntriesOf(c, big(r.acc.id), Number(r.acc.entries));
    const w = l.kind === "ready" ? winnerOf(entries, randomU64(l.hash, r.pk.toBuffer(), u64le(big(r.acc.id))) % big(r.acc.total), (e) => big(e.amount)) : entries[0];
    if (!w) continue;
    await run.send(`legacy jackpot ${r.acc.id} ${l.kind === "ready" ? "settled" : "expired: refunded"}`, () =>
      methods(program).settleJackpot().accountsPartial({
        config: PDA.config(), round: r.pk, entry: w.pk, winnerState: PDA.player(w.acc.player), rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(),
        architect: c.architect, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
      }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
  }
  // f. legacy bets (placed by the v2 binary): settle_bet once their drawing slot passed
  for (const b of legacyBets) {
    if (!run.canSend()) break;
    if (big(b.acc.targetSlot) >= slot) continue;
    await run.send(`settled legacy bet ${b.pk.toBase58()}`, () =>
      methods(program).settleBet().accountsPartial({
        config: PDA.config(), bet: b.pk, playerState: b.acc.playerState, bankrollVault: PDA.bankrollVault(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: b.acc.rentPayer,
      }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
  }
  // g. the holder's seat: re-arm with deposit 0 (never a bond) when nothing is pending
  let armed = false;
  if (holder && seat && arm) {
    // decided on the seat as read: the program refuses the arm if anything is pending by the time it lands (KeeperBusy)
    const d = arm;
    if (d.arm && run.canSend()) {
      const buildSlot = BigInt(await rd.getSlot("processed"));
      const { id, tip } = c.chains.fresh(buildSlot);
      if (!tip.equals(seat.tip)) {
        armed = await run.send(`keeper armed (${d.reason}; ${id.length} positions)`, () =>
          methods(program).armKeeper(Array.from(tip), new anchor.BN(id.length), new anchor.BN(0)).accountsPartial({
            config: PDA.config(), keeperSeat: PDA_V3.houseKeeper(), keeper: payer.publicKey, bankrollVault: PDA.bankrollVault(), rewardVault: PDA.rewardVault(),
            systemProgram: SystemProgram.programId,
          }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
      }
    } else if (!d.arm && depth === 0 && /idle|no keeper seat/.test(d.reason)) c.report.notes.push(d.reason);
  } else if (depth === 0 && !seat) c.report.notes.push(armDecision(null, payer.publicKey, false, now).reason);
  // h. draw the ended Jackpot round
  let drew = false;
  if (!armed && c.allowDraw && run.canSend()) {
    const id = big(c.cfg.jackpotRound);
    const r = rounds.items.find((x) => big(x.acc.id) === id) ?? null;
    const backlog = seat ? seat.nextIndex - (seat.revealed + BigInt(walked)) : 0n;
    if (r && drawDecision({ state: Number(r.acc.state), endTs: num(r.acc.endTs), multiPlayer: !!r.acc.multiPlayer }, role, backlog, now)) {
      const ok = await run.send(`jackpot ${id} drawn`, () =>
        methods(program).drawJackpot().accountsPartial({ config: PDA.config(), round: r.pk, firstPlayerState: PDA.player(r.acc.firstPlayer), keeperSeat: PDA_V3.houseKeeper() }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
      drew = ok && role === "holder" && !!r.acc.multiPlayer;
    }
  }
  // i. the holder settles a DRAWING round in this pass, whoever drew it: its block is the draw slot + 1, and the settle
  //    must land within 512 slots (≈ 3 min). Re-read and walk again a few times (the block reaches SlotHashes a slot or
  //    two later; a bet before it may still wait for its own block), so neither a `--once` run, nor the last pass of a
  //    run, nor a third party's draw at the worst moment leaves a round to expire against the bond (R-1).
  if (depth === 0 && role === "holder" && (drew || (urgentRound && reached <= urgentRound.index))) {
    const roundPk = drew ? PDA.jackpot(big(c.cfg.jackpotRound)) : urgentRound!.r.pk;
    const until = Date.now() + URGENT_WALK_MS;
    for (let i = 0; i < URGENT_RETRIES && Date.now() < until; i++) {
      await c.sleep(1_500);
      await houseV3(c, depth + 1);
      const cur = await fetchAs(rd, program, "JackpotRound", roundPk);
      if (!cur || Number(cur.state) !== ROUND_DRAWING) break;
    }
  }
}

// ── 2. Burn Lottery (retired: a round open at the upgrade still draws, settles and closes) ──────────────────────────
async function lotteryV3(c: Ctx): Promise<void> {
  const { connection, program, payer, run } = c;
  const id = big(c.cfg.drawRound);
  const pk = PDA.draw(id);
  let r = await fetchAs(connection, program, "DrawRound", pk);
  if (!r) return;
  if (Number(r.state) === ROUND_OPEN && c.now() >= num(r.endTs)) {
    if (!(await run.send(`burn lottery ${id} drawn`, () => methods(program).drawDraw().accountsPartial({ config: PDA.config(), round: pk }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix]))))) return;
    for (let i = 0; i < 8; i++) {
      r = await fetchAs(connection, program, "DrawRound", pk);
      if (!r || Number(r.state) !== ROUND_DRAWING || BigInt(await connection.getSlot("confirmed")) > big(r.targetSlot)) break;
      await c.sleep(500);
    }
    if (!r) return;
  }
  if (Number(r.state) !== ROUND_DRAWING) return;
  const l = lookupSlotHash(await slotHashesData(connection), big(r.targetSlot));
  if (l.kind === "notYet") return;
  const pks = Array.from({ length: Number(r.entries) }, (_, i) => PDA.drawEntry(id, i));
  const accs = await fetchManyAs(connection, program, "DrawEntry", pks);
  const entries = pks.map((p, i) => ({ pk: p, acc: accs[i] })).filter((e) => e.acc);
  const w = l.kind === "ready" ? winnerOf(entries, randomU64(l.hash, pk.toBuffer(), u64le(big(r.id))) % big(r.totalWeight), (e) => big(e.weight)) : entries[0];
  if (!w) return;
  await run.send(`burn lottery ${id} ${l.kind === "ready" ? "settled" : "expired: prize to the pool"}`, () =>
    methods(program).settleDraw().accountsPartial({
      config: PDA.config(), round: pk, entry: w.pk, winnerState: PDA.player(w.acc.player), drawVault: PDA.drawVault(), rewardVault: PDA.rewardVault(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
    }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
}

// ── 3. entries of finished rounds: refunds (every pass) and rent (slow) ─────────────────────────────────────────────
async function jackpotEntriesV3(c: Ctx, alsoSettled: boolean): Promise<void> {
  const { connection, program, payer, run } = c;
  const rounds = await allAs(connection, program, "JackpotRound");
  const state = new Map(rounds.items.map((r) => [big(r.acc.id).toString(), { pk: r.pk, state: Number(r.acc.state) }]));
  const wanted = (s: number) => s === ROUND_REFUND || (alsoSettled && s === ROUND_SETTLED);
  if ([...state.values()].some((r) => wanted(r.state))) {
    for (const e of (await allAs(connection, program, "JackpotEntry")).items) {
      const r = state.get(big(e.acc.round).toString());
      if (!r || !wanted(r.state) || !run.canSend()) continue;
      await run.send(`jackpot ${e.acc.round} entry ${e.acc.index} ${r.state === ROUND_REFUND ? "refunded" : "closed (rent back)"}`, () =>
        methods(program).closeJackpotEntry().accountsPartial({ round: r.pk, playerState: PDA.player(e.acc.player), entry: e.pk, rentPayer: e.acc.rentPayer }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
    }
  }
  if (!alsoSettled) return;
  const draws = await allAs(connection, program, "DrawRound");
  const settled = new Map(draws.items.filter((r) => Number(r.acc.state) === ROUND_SETTLED).map((r) => [big(r.acc.id).toString(), r.pk]));
  if (!settled.size) return;
  for (const e of (await allAs(connection, program, "DrawEntry")).items) {
    const rpk = settled.get(big(e.acc.round).toString());
    if (!rpk || !run.canSend()) continue;
    await run.send(`burn lottery ${e.acc.round} entry ${e.acc.index} closed (rent back)`, () =>
      methods(program).closeDrawEntry().accountsPartial({ round: rpk, entry: e.pk, rentPayer: e.acc.rentPayer }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
  }
}

// ── 4. Duel, Moon Wars, Predictions ─────────────────────────────────────────────────────────────────────────────────
async function duelsV3(c: Ctx): Promise<void> {
  const { connection, program, payer, run } = c;
  for (const d of (await allAs(connection, program, "Duel")).items) {
    if (Number(d.acc.state) !== DUEL_JOINED || c.now() <= num(d.acc.deadline) || !run.canSend()) continue;
    await run.send(`duel ${d.pk.toBase58()}: timeout`, () =>
      methods(program).claimDuelTimeout().accountsPartial({
        config: PDA.config(), duel: d.pk, creatorState: PDA.player(d.acc.creator), opponentState: PDA.player(d.acc.opponent), rewardVault: PDA.rewardVault(),
        drawVault: PDA.drawVault(), architect: c.architect, rentPayer: d.acc.rentPayer,
      }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
  }
}

async function warsV3(c: Ctx): Promise<void> {
  const { connection, program, payer, run } = c;
  for (const w of (await allAs(connection, program, "War")).items) {
    if (!run.canSend()) break;
    const key = w.pk.toBase58();
    let state = Number(w.acc.state);
    const v2 = (big(w.acc.targetSlot) & WAR_V2) !== 0n;
    if (state === WAR_STARTING && !v2) {
      if (await run.send(`war ${key} started (legacy block seed)`, () => methods(program).startWar().accountsPartial({ war: w.pk, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])))) {
        const cur = await fetchAs(connection, program, "War", w.pk);
        state = cur ? Number(cur.state) : state;
      }
    } else if ((state === WAR_ACTIVE || (state === WAR_STARTING && v2)) && c.now() > num(w.acc.deadline)) {
      if (await run.send(`war ${key}: timeout`, () => methods(program).claimWarTimeout().accountsPartial({ war: w.pk }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])))) state = WAR_DONE;
    }
    if (state === WAR_DONE && run.canSend()) {
      await run.send(`war ${key} paid out`, () =>
        methods(program).settleWar().accountsPartial({
          config: PDA.config(), war: w.pk, creatorState: PDA.player(w.acc.creator), opponentState: PDA.player(w.acc.opponent), rewardVault: PDA.rewardVault(),
          drawVault: PDA.drawVault(), architect: c.architect, rentPayer: w.acc.rentPayer,
        }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
    }
  }
}

async function predictionsV3(c: Ctx): Promise<void> {
  const { connection, program, payer, run } = c;
  for (const r of (await allAs(connection, program, "PredRound")).items) {
    if (!run.canSend()) break;
    const id = big(r.acc.id);
    const v1 = predIsV1(num(r.acc.lockTs), num(r.acc.endTs));
    let state = Number(r.acc.state);
    if (state === PRED_OPEN && predTimeReached(c.now(), num(r.acc.lockTs), v1)) {
      await run.send(`prediction ${id} locked`, () => methods(program).lockPrediction().accountsPartial({ round: r.pk, observation: XDEX_XNT_OBSERVATION }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
    } else if (state === PRED_LOCKED && predTimeReached(c.now(), num(r.acc.endTs), v1)) {
      await run.send(`prediction ${id} settled`, () =>
        methods(program).settlePrediction().accountsPartial({
          config: PDA.config(), round: r.pk, observation: XDEX_XNT_OBSERVATION, rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: c.architect,
        }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
    }
    const cur = await fetchAs(connection, program, "PredRound", r.pk);
    if (!cur) continue;
    state = Number(cur.state);
    if (state !== PRED_SETTLED && state !== PRED_REFUND) continue;
    const entries = await allAs(connection, program, "PredEntry", undefined, [{ memcmp: { offset: 8, bytes: anchor.utils.bytes.bs58.encode(u64le(id)) } }]);
    let claimed = Number(cur.claimed);
    for (const e of entries.items) {
      if (!run.canSend()) break;
      if (await run.send(`prediction ${id}: paid ${(e.acc.player as PublicKey).toBase58()}`, () =>
        methods(program).claimPrediction().accountsPartial({ config: PDA.config(), round: r.pk, entry: e.pk, playerState: PDA.player(e.acc.player), rentPayer: e.acc.rentPayer }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])))) claimed++;
    }
    if (claimed >= Number(cur.entries) && run.canSend()) {
      await run.send(`prediction ${id} closed`, () =>
        methods(program).closePredictionRound().accountsPartial({ config: PDA.config(), round: r.pk, rewardVault: PDA.rewardVault(), rentPayer: cur.rentPayer }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
    }
  }
}

// ── 5. epochs: drop seeds of v2 epochs, expiry, claims after the hold, drop delivery ────────────────────────────────
/** Claims every unclaimed leaf of a published file whose epoch is past its 48-h hold and inside its window. */
export async function claimBaseV3(
  c: { connection: Connection; program: anchor.Program; payer: Keypair; log: (s: string) => void; run: { canSend(): boolean; send: TxBudget["send"] }; claimGuard?: ClaimGuardV3 },
  f: EpochFile, ep: any, oracle: PublicKey, now: number,
): Promise<{ claimed: number; tipped: number; failed: number; skipped: string | null }> {
  // D-47: paid by the oracle key, the claims stop before its wallet is too low to publish
  const guard = c.claimGuard ?? claimGuardV3(c.connection, c.payer.publicKey, oracle);
  const out = { claimed: 0, tipped: 0, failed: 0, skipped: null as string | null };
  if (ep.closed) return { ...out, skipped: "closed" };
  const publishedAt = num(ep.publishedAt);
  if (now < publishedAt + CLAIM_HOLD) return { ...out, skipped: `on hold until ${new Date((publishedAt + CLAIM_HOLD) * 1000).toISOString()}` };
  if (now >= num(ep.expiresAt)) return { ...out, skipped: "claim window closed" };
  const budget = big(ep.budget);
  const total = big(ep.totalScore);
  const receipts = f.leaves.map((l) => PDA.receipt(f.epoch, new PublicKey(l.player), l.tier));
  const have: boolean[] = [];
  for (let i = 0; i < receipts.length; i += 100) have.push(...(await c.connection.getMultipleAccountsInfo(receipts.slice(i, i + 100), "confirmed")).map((a) => !!a));
  for (let i = 0; i < f.leaves.length; i++) {
    if (have[i]) continue;
    if (!c.run.canSend()) break;
    const was = guard.stopped;
    const stop = await guard.check();
    if (stop) {
      if (!was) c.log(`  ${stop}`);
      out.skipped = stop;
      break;
    }
    const l = f.leaves[i];
    const player = new PublicKey(l.player);
    const proof = (f.proofs[`${l.player}:${l.tier}`] || []).map((h) => Array.from(Buffer.from(h, "hex")));
    const common = {
      config: PDA.config(), epoch: PDA.epoch(f.epoch), receipt: receipts[i], player, playerState: PDA.player(player), rewardVault: PDA.rewardVault(), payer: c.payer.publicKey,
      systemProgram: SystemProgram.programId,
    };
    const amount = total > 0n ? (BigInt(l.score) * budget) / total : 0n;
    const tip = keeperTipDueV3(c.payer.publicKey, player, oracle, amount);
    const ok = await c.run.send(`claimed ${l.player} tier ${l.tier} of epoch ${f.epoch}${tip ? " (keeper tip)" : ""}`, () =>
      (l.tier === 0
        ? methods(c.program).claimInstant(new anchor.BN(f.epoch), l.tier, new anchor.BN(l.score), proof).accountsPartial(common)
        : methods(c.program).claimMission(new anchor.BN(f.epoch), l.tier, new anchor.BN(l.score), proof).accountsPartial({ ...common, mission: PDA.mission(f.epoch, player, l.tier) }))
        .instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
    if (ok) {
      out.claimed++;
      if (tip) out.tipped++;
    } else out.failed++;
  }
  return out;
}

async function epochsV3(c: Ctx, files: EpochFile[]): Promise<void> {
  const { connection, program, payer, run, log } = c;
  const now = c.now();
  const epochs = (await allAs(connection, program, "Epoch")).items;
  for (const e of epochs) {
    if (e.acc.closed || !run.canSend()) continue;
    const id = num(e.acc.id);
    if (now >= num(e.acc.expiresAt)) {
      if (await run.send(`epoch ${id} expired: unclaimed budget back to the pool`, () => methods(program).expireEpoch().accountsPartial({ config: PDA.config(), epoch: e.pk }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])))) e.acc.closed = true;
      continue;
    }
    // a drop seed of an epoch published by the v2 binary (v3 epochs have none): seal it, or cancel it once its window passed
    if (Number(e.acc.dropState) === DROP_PENDING) {
      const action = sealAllowedV3(files, id) ? "seal" : gatedSealActionV3({ dropState: 1, sealAllowed: false, dropSlot: num(e.acc.dropSlot), currentSlot: await connection.getSlot("finalized") });
      if (action === "seal" || action === "cancel") {
        await run.send(`epoch ${id}: drop seed ${action === "seal" ? "sealed" : "cancelled (reserve back to the pool)"}`, () =>
          methods(program).sealDrop().accountsPartial({ config: PDA.config(), epoch: e.pk, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
      }
    }
  }
  const oracle = c.cfg.oracle as PublicKey;
  for (const f of files) {
    if (!run.canSend()) break;
    const ep = epochs.find((e) => num(e.acc.id) === f.epoch);
    if (!ep) continue;
    const r = await claimBaseV3({ connection, program, payer, log, run, claimGuard: c.claimGuard }, f, ep.acc, oracle, now);
    if (r.claimed || r.failed) log(`  epoch ${f.epoch}: ${r.claimed} claimed (${r.tipped} with a keeper tip), ${r.failed} failed`);
    if (!r.skipped && Number(ep.acc.dropState) === DROP_SEALED && run.canSend()) await deliverDrops(connection, program, payer, f, log, run); // R-1 (2): bounded
  }
}

// ── extra pot claims and closes ─────────────────────────────────────────────────────────────────────────────────────
async function sendIx(c: { program: anchor.Program; payer: Keypair }, ix: TransactionInstruction): Promise<string> {
  return sendTx(c, [ix]);
}

async function extrasV3(c: Ctx, files: ExtraFileV1[]): Promise<void> {
  const { connection, program, payer, run } = c;
  const now = c.now();
  for (const f of files) {
    if (!run.canSend()) break;
    const x = await fetchAs(connection, program, "ExtraEpoch", PDA_V3.extraEpoch(f.epoch));
    if (!x || Buffer.from(x.root).toString("hex") !== f.root) continue; // not published (yet), or another file
    const at = num(x.publishedAt);
    if (now >= at + CLAIM_WINDOW) {
      await run.send(`extra epoch ${f.epoch} closed (rent back to the oracle)`, async () => sendIx(c, await closeExtraEpochIxV3(program, f.epoch, x.rentPayer)));
      continue;
    }
    if (x.closed || now < at + CLAIM_HOLD) continue;
    const bitmap = Buffer.from(x.bitmap);
    for (const leaf of f.leaves) {
      if (!run.canSend()) break;
      if ((bitmap[leaf.index >> 3] & (1 << (leaf.index & 7))) !== 0) continue;
      // D-47: an extra claim costs the oracle key a fee; it stops before the wallet is too low to publish
      const was = c.claimGuard.stopped;
      const stop = await c.claimGuard.check();
      if (stop) {
        if (!was) c.log(`  ${stop}`);
        break;
      }
      await run.send(`extra ${f.epoch}: paid ${leaf.wallet}`, async () =>
        sendIx(c, await claimExtraIxV3(program, payer.publicKey, { epoch: f.epoch, index: leaf.index, wallet: leaf.wallet, amount: leaf.amount, proof: f.proofs[leaf.wallet] ?? [] })));
    }
  }
}

// ── market: stale or expired listings (rent back to the seller) ─────────────────────────────────────────────────────
async function listingsV3(c: Ctx): Promise<void> {
  const { connection, program, payer, run } = c;
  const listings = (await allAs(connection, program, "Listing")).items;
  if (!listings.length) return;
  const assets = await connection.getMultipleAccountsInfo(listings.map((l) => l.acc.asset as PublicKey), "confirmed");
  const collection = PDA.collection();
  for (let i = 0; i < listings.length; i++) {
    if (!run.canSend()) break;
    const l = listings[i];
    const owner = liveAssetOwner(assets[i] as { owner: PublicKey; data: Buffer } | null, collection);
    const stale = !owner || !owner.equals(l.acc.seller);
    if (!stale && c.now() < num(l.acc.expiresAt)) continue;
    await run.send(`listing of ${(l.acc.asset as PublicKey).toBase58()} closed (${stale ? "stale" : "expired"})`, () =>
      methods(program).closeListing().accountsPartial({ config: PDA.config(), listing: l.pk, seller: l.acc.seller, asset: l.acc.asset, collection }).instruction().then((ix: TransactionInstruction) => sendTx(c, [ix])));
  }
}

// ── the oracle seat's liveness ──────────────────────────────────────────────────────────────────────────────────────
export interface PairViewV3 {
  id: number;
  publishedAt: number;
  closed: boolean;
  extra: { publishedAt: number; closed: boolean } | null;
}

export interface SeatLivenessV3 {
  /** the priority taker may take the seat from this time on, unless an epoch published before `publishBy` survives */
  deadAt: number;
  publishBy: number;
  state: "ok" | "warn" | "critical" | "dead";
  detail: string;
}

/**
 * When the oracle seat becomes takeable if nothing new is published and nothing more is voided: the exact mirror of
 * seat.rs walk_is_dead at every future time T. The seat is alive at T while T <= taken_at + 28 d, or while some pair
 * (base epoch not closed, its extra absent or not closed) has published_at >= T − 28 d AND has survived its hold at T
 * (T >= published_at + 48 h, for the extra too). An epoch in its hold does not count yet, so a seat whose newest epoch
 * is on hold while every older one is past 28 days is dead NOW (theft §4.5 / SPEC 2.14 (iv): silence is the signal).
 * `deadAt` is when the priority taker may take it; everyone else one day later (SEAT_PRIORITY_WINDOW).
 * `publishBy`: an epoch published after it would still be on hold at `deadAt`, so it could not save the seat.
 * Round 4: the upgraded program also accepts a HEARTBEAT base epoch (no leaves, budget 0; forge.rs epoch_shape) and the
 * weekly run publishes one in a week without a valued burn (index.ts runEpochV3), so a quiet month no longer kills the
 * seat: a heartbeat counts like any epoch once it survives its hold (seat.rs walk, unchanged), and a voided one does not.
 * An extra heartbeat (total 0) only ever breaks a pair (when voided), never makes one.
 */
export function oracleSeatLivenessV3(takenAt: number, pairs: PairViewV3[], now: number): SeatLivenessV3 {
  /** the first second at or after `now` the walk with this delay calls dead (spans are inclusive, as its comparisons) */
  const deadFrom = (delay: number): { at: number; from: string } => {
    const spans: { from: number; to: number; why: string }[] = [{ from: -Infinity, to: takenAt + delay, why: "the seat's take" }];
    for (const p of pairs) {
      if (p.closed || (p.extra && p.extra.closed)) continue;
      spans.push({ from: Math.max(p.publishedAt, p.extra ? p.extra.publishedAt : -Infinity) + CLAIM_HOLD, to: p.publishedAt + delay, why: `epoch ${p.id}` });
    }
    let t = now;
    let from = "";
    for (let moved = true; moved; ) {
      moved = false;
      for (const s of spans) {
        if (s.from <= t && t <= s.to) {
          t = s.to + 1;
          from = s.why;
          moved = true;
        }
      }
    }
    return { at: t, from };
  };
  const { at: deadAt, from } = deadFrom(DEAD_SEAT_DELAY);
  const everyone = deadFrom(DEAD_SEAT_DELAY + SEAT_PRIORITY_WINDOW).at;
  const publishBy = deadAt - CLAIM_HOLD;
  const day = (x: number) => new Date(x * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const state = now >= deadAt ? "dead" : now >= publishBy ? "critical" : now >= deadAt - SEAT_WARN_BEFORE ? "warn" : "ok";
  const detail =
    state === "dead"
      ? `the oracle seat is DEAD (no epoch survived its 48-h hold in the last 28 days): the priority taker may take it now and anyone ${everyone <= now ? "now" : `from ${day(everyone)}`}, with a seat bond; an epoch published now counts only once its hold is over`
      : `the oracle seat stays alive until ${day(deadAt)} (28 days after ${from}); an epoch (the weekly heartbeat in a week without a valued burn) must be published by ${day(publishBy)} and survive its 48-h hold to keep it alive`;
  return { deadAt, publishBy, state, detail };
}

/** Reads the seat and the walk pairs (read-only) and returns the liveness, or null without a seat. */
export async function readOracleSeatLivenessV3(connection: Connection, program: anchor.Program, now: number): Promise<SeatLivenessV3 | null> {
  const seat = await fetchAs(connection, program, "OracleSeat", PDA_V3.oracleSeat());
  if (!seat) return null;
  const cfg = await fetchAs(connection, program, "Config", PDA.config());
  const last = cfg ? num(cfg.lastEpoch) : 0;
  const ids = Array.from({ length: Math.min(last, SEAT_WALK_PAIRS) }, (_, i) => last - i);
  const bases = await fetchManyAs(connection, program, "Epoch", ids.map((id) => PDA.epoch(id)));
  const extras = await fetchManyAs(connection, program, "ExtraEpoch", ids.map((id) => PDA_V3.extraEpoch(id)));
  const pairs: PairViewV3[] = [];
  ids.forEach((id, i) => {
    const b = bases[i];
    if (!b) return;
    const x = extras[i];
    pairs.push({ id, publishedAt: num(b.publishedAt), closed: !!b.closed, extra: x ? { publishedAt: num(x.publishedAt), closed: !!x.closed } : null });
  });
  return oracleSeatLivenessV3(num(seat.takenAt), pairs, now);
}

async function oracleSeatV3(c: Ctx): Promise<void> {
  const l = await readOracleSeatLivenessV3(c.connection, c.program, c.now());
  if (!l || l.state === "ok") return;
  c.report.notes.push(l.detail);
  c.log(`  ${l.state === "warn" ? "WARNING" : "ALERT"}: ${l.detail}`);
  if (process.env.GITHUB_ACTIONS) console.log(`::${l.state === "warn" ? "warning" : "error"}::${l.detail}`);
}

// ── the keeper loop's clock ─────────────────────────────────────────────────────────────────────────────────────────
/** X1 slot time used to turn a slot distance into a wait (≈ 0.37 s/slot measured; a little fast, so never late). */
export const SLOT_SECONDS_FAST = 0.35;

/**
 * Earliest moment some time-sensitive v3 upkeep is due (unix seconds; `now` when already due), or null. `me` is the
 * keeper key of this run: the seat's holder settles its bets and DRAWING rounds at once; any other key only anchors
 * (due at once), refunds a never-anchored bet once its block leaves SlotHashes (minutes) and refunds an anchored one
 * once it stalls (anchor + KEEPER_STALL_SLOTS, about a day), and draws a seated round HELPER_DRAW_GRACE after its end,
 * so a helper run does not stay up for hours waiting on reveals only the holder can send.
 */
export async function nextDeadlineV3(connection: Connection, program: anchor.Program, now = Math.floor(Date.now() / 1000), me?: PublicKey): Promise<{ at: number | null; reasons: string[] }> {
  const due: { at: number; why: string }[] = [];
  const raw = await fetchAs(connection, program, "HouseKeeper", PDA_V3.houseKeeper());
  const seat = raw ? seatOf(raw) : null;
  const holder = !!seat && !!me && seat.keeper.equals(me);
  const cfg = await fetchAs(connection, program, "Config", PDA.config());
  if (cfg) {
    const jr = await fetchAs(connection, program, "JackpotRound", PDA.jackpot(big(cfg.jackpotRound)));
    const grace = seat && !holder && jr && jr.multiPlayer ? HELPER_DRAW_GRACE : 0;
    if (jr && Number(jr.state) === ROUND_OPEN && num(jr.endTs) > 0) due.push({ at: num(jr.endTs) + grace, why: `jackpot ${jr.id} ends` });
    if (jr && Number(jr.state) === ROUND_DRAWING) due.push({ at: now, why: `jackpot ${jr.id} to settle` });
    const dr = await fetchAs(connection, program, "DrawRound", PDA.draw(big(cfg.drawRound)));
    if (dr && Number(dr.state) === ROUND_OPEN && num(dr.endTs) > 0) due.push({ at: num(dr.endTs), why: `lottery ${dr.id} ends` });
    if (dr && Number(dr.state) === ROUND_DRAWING) due.push({ at: now, why: `lottery ${dr.id} to settle` });
  }
  const bets = (await allAs(connection, program, "Bet")).items;
  if (bets.length) {
    const slot = BigInt(await connection.getSlot("confirmed"));
    for (const b of bets) {
      const game = Number(b.acc.game);
      if ((game & BET_KEEPER) === 0 || holder || (game & BET_ANCHORED) === 0) {
        due.push({ at: now, why: (game & BET_KEEPER) === 0 ? "legacy bets" : holder ? "bets to settle" : "bets to anchor" });
        continue;
      }
      const { index, anchor: a } = betUnpack(big(b.acc.targetSlot));
      const stallAt = a + KEEPER_STALL_SLOTS + 1n;
      const wait = seat && index < seat.revealed ? 0 : stallAt > slot ? Math.floor(Number(stallAt - slot) * SLOT_SECONDS_FAST) : 0;
      due.push({ at: now + wait, why: "a stalled bet to refund" });
    }
  }
  for (const d of (await allAs(connection, program, "Duel")).items) if (Number(d.acc.state) === DUEL_JOINED) due.push({ at: num(d.acc.deadline) + 1, why: `duel ${d.pk.toBase58().slice(0, 8)} deadline` });
  for (const w of (await allAs(connection, program, "War")).items) {
    const s = Number(w.acc.state);
    const v2 = (big(w.acc.targetSlot) & WAR_V2) !== 0n;
    if ((s === WAR_STARTING && !v2) || s === WAR_DONE) due.push({ at: now, why: `war ${w.pk.toBase58().slice(0, 8)} to ${s === WAR_DONE ? "pay out" : "start"}` });
    else if (s === WAR_ACTIVE || s === WAR_STARTING) due.push({ at: num(w.acc.deadline) + 1, why: `war ${w.pk.toBase58().slice(0, 8)} clock` });
  }
  for (const r of (await allAs(connection, program, "PredRound")).items) {
    const s = Number(r.acc.state);
    const v1 = predIsV1(num(r.acc.lockTs), num(r.acc.endTs));
    if (s === PRED_OPEN) due.push({ at: num(r.acc.lockTs) + (v1 ? 0 : 1), why: `prediction ${r.acc.id} lock` });
    if (s === PRED_LOCKED) due.push({ at: num(r.acc.endTs) + (v1 ? 0 : 1), why: `prediction ${r.acc.id} settle` });
    if (s === PRED_SETTLED || s === PRED_REFUND) due.push({ at: now, why: `prediction ${r.acc.id} payouts` });
  }
  if (!due.length) return { at: null, reasons: [] };
  due.sort((a, b) => a.at - b.at);
  return { at: Math.max(now, due[0].at), reasons: due.slice(0, 5).map((d) => d.why) };
}

// ── S7 owner step: the first arm (with the bond) ────────────────────────────────────────────────────────────────────
/**
 * `keeper-arm --deposit <XNT> [--yes]`: arms the seat with a chain this key derives (so every keeper run holding the key
 * can reveal it), adding `deposit` to the bond. The first arm creates the seat, whose keeper is the program's
 * INITIAL_KEEPER. An owner step (it moves the bond); without --yes it only prints the plan. Never called by the loop.
 */
export async function armKeeperCli(connection: Connection, program: anchor.Program, signer: Keypair, depositXnt: number, yes: boolean, log = console.log): Promise<string | null> {
  if (!isV3Program(program)) throw new Error("keeper-arm needs the v3 client");
  if (!Number.isFinite(depositXnt) || depositXnt < 0) throw new Error("--deposit <XNT> is required (0 re-arms without adding to the bond)");
  const { verdict } = await keeperModeV3(connection, program);
  if (verdict.status !== "upgraded") throw new Error(`refusing to arm: the live program is not the upgraded binary (${verdict.status}: ${verdict.reasons.join("; ")}) (W2-4)`);
  const raw = await fetchAs(connection, program, "HouseKeeper", PDA_V3.houseKeeper());
  const seat = raw ? seatOf(raw) : null;
  if (seat && !seat.keeper.equals(signer.publicKey)) throw new Error(`the seat is held by ${seat.keeper.toBase58()}, not this key ${signer.publicKey.toBase58()} (take_keeper is a separate owner step)`);
  if (seat && seat.pendingBets > 0) throw new Error(`the seat has ${seat.pendingBets} pending bets / drawing rounds: arm_keeper would fail (KeeperBusy)`);
  const deposit = BigInt(Math.round(depositXnt * 1e9));
  const bondAfter = (seat ? seat.bond : 0n) + deposit;
  if (bondAfter < KEEPER_BOND_MIN) throw new Error(`the bond after the arm would be ${bondAfter} lamports, below KEEPER_BOND_MIN ${KEEPER_BOND_MIN} (KeeperBondTooSmall)`);
  const chains = new KeeperChains(signer);
  const buildSlot = BigInt(await connection.getSlot("processed"));
  const { id, tip } = chains.fresh(buildSlot);
  log(`keeper-arm plan: seat ${PDA_V3.houseKeeper().toBase58()} ${seat ? "(exists)" : "(created by this arm; its keeper is INITIAL_KEEPER)"}, keeper ${signer.publicKey.toBase58()}`);
  log(`  deposit ${deposit} lamports, bond after ${bondAfter}; chain of ${id.length} positions, tip ${tip.toString("hex")} (build slot ${buildSlot}, nonce ${id.nonce})`);
  if (!yes) {
    log("  dry: nothing sent (add --yes to send it)");
    return null;
  }
  const sig: string = await methods(program).armKeeper(Array.from(tip), new anchor.BN(id.length), new anchor.BN(deposit.toString())).accountsPartial({
    config: PDA.config(), keeperSeat: PDA_V3.houseKeeper(), keeper: signer.publicKey, bankrollVault: PDA.bankrollVault(), rewardVault: PDA.rewardVault(), systemProgram: SystemProgram.programId,
  }).signers([signer]).rpc();
  log(`  armed: ${sig}`);
  await assertChainDerivableV3(connection, program, signer, "keeper-arm", log);
  return sig;
}

/**
 * R-4: after an arm or a take, the seat must hold a chain this key derives (KeeperChains.identify), else every keeper
 * run with this key is "holder-unknown-chain": it reveals nothing and anchored bets become refundable as WINs paid
 * from the bond. Throws (the CLI exits 1) when it does not.
 */
export async function assertChainDerivableV3(connection: Connection, program: anchor.Program, signer: Keypair, what: string, log = console.log): Promise<void> {
  let raw: any = null;
  for (let i = 0; i < 10 && !raw; i++) {
    raw = await fetchAs(trustedConnectionFor(connection), program, "HouseKeeper", PDA_V3.houseKeeper());
    if (!raw) await new Promise((r) => setTimeout(r, 1_000));
  }
  const seat = raw ? seatOf(raw) : null;
  if (!seat || !seat.keeper.equals(signer.publicKey)) throw new Error(`${what}: ${UNKNOWN_CHAIN_ALERT} (the seat is ${seat ? `held by ${seat.keeper.toBase58()}` : "unreadable"})`);
  if (!new KeeperChains(signer).identify(seat)) throw new Error(`${what}: ${UNKNOWN_CHAIN_ALERT}`);
  log(`  checked: the seat's chain (length ${seat.length}, armed slot ${seat.armedSlot}) is derived by this key; next, run \`npm run keeper -- --once\` and check that it shows role holder`);
}

/**
 * `keeper-take --deposit <XNT> [--yes]` (R-4): take_keeper by the named successor after KEEPER_NOTICE, or by anyone once
 * the seat is dead (28 days without arm / reveal / settle), on a chain this key derives. The old bond goes back to the
 * old keeper in full; `deposit` is the new bond (at least KEEPER_BOND_MIN). An owner step; without --yes it only prints
 * the plan. After landing, the seat's chain is checked to be derivable by this key.
 */
export async function takeKeeperCli(connection: Connection, program: anchor.Program, signer: Keypair, depositXnt: number, yes: boolean, log = console.log): Promise<string | null> {
  if (!isV3Program(program)) throw new Error("keeper-take needs the v3 client");
  if (!Number.isFinite(depositXnt) || depositXnt <= 0) throw new Error("--deposit <XNT> is required: the new bond (at least 20 XNT)");
  const { verdict } = await keeperModeV3(connection, program);
  if (verdict.status !== "upgraded") throw new Error(`refusing to take the seat: the live program is not the upgraded binary (${verdict.status}: ${verdict.reasons.join("; ")}) (W2-4)`);
  const raw = await fetchAs(trustedConnectionFor(connection), program, "HouseKeeper", PDA_V3.houseKeeper());
  if (!raw) throw new Error("there is no keeper seat yet: the first arm is `keeper-arm` (INITIAL_KEEPER)");
  const seat = seatOf(raw);
  if (seat.keeper.equals(signer.publicKey)) throw new Error("this key already holds the seat: use keeper-arm to re-arm it");
  if (seat.pendingBets > 0) throw new Error(`the seat has ${seat.pendingBets} pending bets / drawing rounds: take_keeper would fail (KeeperBusy); they refund or settle permissionlessly first`);
  const deposit = BigInt(Math.round(depositXnt * 1e9));
  if (deposit < KEEPER_BOND_MIN) throw new Error(`the new bond ${deposit} lamports is below KEEPER_BOND_MIN ${KEEPER_BOND_MIN} (KeeperBondTooSmall)`);
  const named = seat.pendingKeeper.equals(signer.publicKey);
  const chains = new KeeperChains(signer);
  const buildSlot = BigInt(await connection.getSlot("processed"));
  const { id, tip } = chains.fresh(buildSlot);
  log(`keeper-take plan: seat ${PDA_V3.houseKeeper().toBase58()} held by ${seat.keeper.toBase58()} (bond ${seat.bond} back to it), taker ${signer.publicKey.toBase58()} (${named ? "the named successor: after KEEPER_NOTICE" : "not named: only once the seat is dead, 28 days without activity"})`);
  log(`  new bond ${deposit} lamports; chain of ${id.length} positions, tip ${tip.toString("hex")} (build slot ${buildSlot}, nonce ${id.nonce})`);
  if (!yes) {
    log("  dry: nothing sent (add --yes to send it)");
    return null;
  }
  const sig: string = await methods(program).takeKeeper(Array.from(tip), new anchor.BN(id.length), new anchor.BN(deposit.toString())).accountsPartial({
    config: PDA.config(), keeperSeat: PDA_V3.houseKeeper(), oldKeeper: seat.keeper, taker: signer.publicKey, rewardVault: PDA.rewardVault(), systemProgram: SystemProgram.programId,
  }).signers([signer]).rpc();
  log(`  taken: ${sig}`);
  await assertChainDerivableV3(connection, program, signer, "keeper-take", log);
  return sig;
}

/**
 * Round 4 (review F1, keeper.rs stall_split): which roles anchor keeper bets. Every role except a holder that cannot
 * derive its chain: a bet it anchored and never revealed would be paid as a WIN from its bond (reason 1), more than the
 * full stake an unanchored one costs (reason 0).
 */
export const anchorsForRoleV3 = (role: RoleV3): boolean => role !== "holder-unknown-chain";

/**
 * Round 4 (review F1): the first keeper bet that waits for its anchor now (pure): not anchored, its anchor block already
 * in SlotHashes (anchor_bet can land). Under the upgraded program such a bet that stays unanchored until its block leaves
 * SlotHashes (512 slots, about 3 min) is refunded in full and costs the keeper bond the whole stake (reason 0; r4-fix),
 * so the keeper loop anchors it at once instead of waiting for its next full pass. null when nothing waits.
 */
export function anchorDueOf(bets: { pk: string; game: number; targetSlot: bigint }[], slotHashes: Buffer | null, exclude: ReadonlySet<string> = new Set()): string | null {
  for (const b of bets) {
    if ((b.game & BET_KEEPER) === 0 || (b.game & BET_ANCHORED) !== 0 || exclude.has(b.pk)) continue;
    if (lookupSlotHash(slotHashes, betUnpack(b.targetSlot).anchor).kind === "ready") return b.pk;
  }
  return null;
}

/** anchorDueOf over the chain (R-5: the default endpoint): the open Bet accounts and SlotHashes, read only when one is unanchored. */
export async function anchorDueV3(connection: Connection, program: anchor.Program, exclude: ReadonlySet<string> = new Set()): Promise<string | null> {
  const rd = trustedConnectionFor(connection);
  const bets = (await allAs(rd, program, "Bet")).items
    .map((b) => ({ pk: b.pk.toBase58(), game: Number(b.acc.game), targetSlot: big(b.acc.targetSlot) }))
    .filter((b) => (b.game & BET_KEEPER) !== 0 && (b.game & BET_ANCHORED) === 0 && !exclude.has(b.pk));
  if (!bets.length) return null;
  return anchorDueOf(bets, await slotHashesData(rd), exclude);
}

/**
 * The keeper loop's 5-s check between two full passes (index.ts): the house duty is due now when a v3 Jackpot round is
 * DRAWING (R-1) or a keeper bet waits for its anchor (round 4, bond-paid stalls). `anchors` = whether this key's role
 * anchors (anchorsForRoleV3; the loop does not know the role before its first pass, so it asks for both).
 */
export async function houseDueV3(connection: Connection, program: anchor.Program, anchors = true): Promise<boolean> {
  if (await jackpotDrawingV3(connection, program)) return true;
  return anchors ? (await anchorDueV3(connection, program)) !== null : false;
}

/** R-1: whether the current Jackpot round (or the next id) is DRAWING with the v3 marker: the keeper loop's 5-s check. */
export async function jackpotDrawingV3(connection: Connection, program: anchor.Program): Promise<boolean> {
  const rd = trustedConnectionFor(connection);
  const cfg = await fetchAs(rd, program, "Config", PDA.config());
  if (!cfg) return false;
  const id = big(cfg.jackpotRound);
  const infos = await rd.getMultipleAccountsInfo([PDA.jackpot(id), PDA.jackpot(id + 1n)], "confirmed");
  return infos.some((i) => {
    const r = tryDecode(program, "JackpotRound", i as { owner: PublicKey; data: Buffer } | null);
    return !!r && Number(r.state) === ROUND_DRAWING && big(r.winningTicket) === U64_MAX;
  });
}
