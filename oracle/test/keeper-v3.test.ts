/**
 * The v3 keeper (src/keeper-v3.ts), no network: a fake chain serves accounts, program-account lists and the SlotHashes
 * sysvar, and records every transaction (decoded with the v3 IDL). Covers the hash-chain KDF and its recovery from the
 * seat, the pure mirrors of the program (slot hashes, stall reasons, packing, Jackpot ticket, tip rule, seat liveness),
 * the seat state machine (idle / helper / holder / unknown chain / arm with deposit 0 only), every pass path (anchor,
 * settle in chain order, skip, stalled refunds, Jackpot draw / settle / expiry, legacy bets and rounds, Burn Lottery,
 * entries, Duel, Moon Wars, Predictions, epochs and claims after the hold, extra pot, listings), the bounded budget, the
 * stale-read guard, the scrubbing of reveals from logs and the W2-4 detection.
 *   npm test
 */
import assert from "assert";
import * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Keypair, PublicKey, SYSVAR_SLOT_HASHES_PUBKEY, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { keccak } from "../src/merkle";
import { MPL_CORE, PDA, programId, randomU64 } from "../src/x1";
import { BPF_LOADER_UPGRADEABLE, CLAIM_COST_MAX, claimFundsOkV3, claimGuardV3, FEE_COST_MAX, feeFundsOkV3, LIVE_DEPLOY_SLOT, ORACLE_PUBLISH_RESERVE, PDA_V3, programV3, RENT_FLOOR } from "../src/x1-v3";
import { CU_MEMO, cuExhaustedV3, cuFallbackV3, CuMemoV3, cuPlanOfUnitsV3, cuPlanV3, feeOfLimitV3, sendWithCuV3 } from "../src/cu-v3";
import { simulateAsV3 } from "../src/seat-v3";
import {
  armDecision, betPack, betUnpack, buildChain, chainIdOf, chainIdsOf, chainKeyOf, chainLengthOf, chainSeed, CHAIN_LEN_BASE, CLAIM_HOLD, CLAIM_WINDOW, DAY, drawDecision, HELPER_DRAW_GRACE,
  jackpotTicketV2, KEEPALIVE_AFTER, KEEPER_BOND_MIN, KEEPER_STALL_SLOTS, KeeperChains, keeperModeV3, keeperPassV3, keeperTipDueV3, KEEPER_TIP_MIN_CLAIM_V3, lookupSlotHash,
  newMemoV3, nextDeadlineV3, oracleSeatLivenessV3, predTimeReached, REARM_BELOW, SeatV3, stallReason, U64_MAX, armKeeperCli,
  takeKeeperCli, TX_SIZE_MAX, txSizeOf, UNKNOWN_CHAIN_ALERT, WALK_BATCH, cuIxV3, cuLimitForV3, CU_SIM_UNITS, measureCuV3, houseDueV3, anchorsForRoleV3,
  KEEPER_DEAD_DELAY, KEEPER_OPEN_TS, missionVestedV3, orphanGoneV3, ORPHANS_PER_PASS, seatCreatorV3, vestedDueV3, VESTED_PER_PASS,
  KEEPER_NOTICE, keeperWithdrawCli, keeperWithdrawDecisionV3, PairViewV3, proposeKeeperCli,
} from "../src/keeper-v3";
import { resignDecisionV3, resignSeatCli, rotateHotCli, rotateHotErrorV3 } from "../src/seat-v3";
import { claimsLineV3 } from "../src/flow-v3";
import { claimsVerdict, ORACLE_MIN_LAMPORTS } from "../src/health-rules";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${(e as Error).stack ?? String(e)}`);
  }
}

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const XNT = 1_000_000_000n;
const BN = (v: number | bigint | string) => new anchor.BN(v.toString());
const u64 = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const slotHash = (s: bigint) => keccak(Buffer.from("SLOT"), u64(s));

// ── the fake chain ─────────────────────────────────────────────────────────────────────────────────────────────────
type FakeAccount = { owner: PublicKey; data: Buffer; lamports: number; executable: boolean };
type Sent = { name: string; data: any; keys: { pubkey: PublicKey; isWritable: boolean; isSigner: boolean }[] };
class FakeChain {
  accounts = new Map<string, FakeAccount>();
  sent: Sent[] = [];
  slot = 1_000_000n;
  /** context slot of program-account lists (null = the node gives none) */
  listSlot: number | null = null;
  /** per account type (IDL name): a context slot that overrides listSlot for that type's lists */
  listSlotOf = new Map<string, number | null>();
  seatSlot = 999_990;
  failOn: (s: Sent) => string | null = () => null;
  /** the program's effect of one instruction (emulate()), applied in order inside an atomic transaction; a text = its error */
  apply: ((s: Sent) => string | null) | null = null;
  /** runs before a transaction is executed (outside its atomicity: a race that lands first) */
  beforeTx: ((ixs: Sent[]) => void) | null = null;
  rpcError: string | null = null;
  /** the signer's lamports (D-47 guard); null = getBalance fails */
  balance: number | null = 1_000 * 1e9;
  /** landed transactions */
  txs = 0;
  /** slots each landed transaction moves the clock (0: the clock stands still) */
  slotPerTx = 0n;
  /** SlotHashes rebuilt from `slot` on every read */
  autoHashes = false;
  /** accounts a lying or truncating endpoint leaves out of every program-account list (R-5) */
  hidden = new Set<string>();
  /** compute units: when set, the connection simulates (units per instruction) and the limits sent are recorded */
  cuPerIx: number | null = null;
  /** a simulation the program refuses (the text of its log) */
  simRefuse: string | null = null;
  cuLimits: number[] = [];
  constructor(public program: anchor.Program) {}
  put(pk: PublicKey, owner: PublicKey, data: Buffer) {
    this.accounts.set(pk.toBase58(), { owner, data, lamports: 1_000_000_000, executable: false });
  }
  del(pk: PublicKey) {
    this.accounts.delete(pk.toBase58());
  }
  get(pk: PublicKey) {
    if (this.rpcError) throw new Error(this.rpcError);
    if (this.autoHashes && pk.equals(SYSVAR_SLOT_HASHES_PUBKEY)) this.slotHashes();
    return this.accounts.get(pk.toBase58()) ?? null;
  }
  /** SlotHashes holding the last 512 slots up to `this.slot`, minus `holes` */
  slotHashes(holes: bigint[] = []) {
    const slots: bigint[] = [];
    for (let s = this.slot; s > this.slot - 512n; s--) if (!holes.includes(s)) slots.push(s);
    const d = Buffer.alloc(8 + slots.length * 40);
    d.writeBigUInt64LE(BigInt(slots.length), 0);
    slots.forEach((s, i) => {
      d.writeBigUInt64LE(s, 8 + i * 40);
      slotHash(s).copy(d, 8 + i * 40 + 8);
    });
    this.put(SYSVAR_SLOT_HASHES_PUBKEY, new PublicKey("Sysvar1111111111111111111111111111111111111"), d);
  }
  connection(): any {
    return {
      commitment: "confirmed",
      getAccountInfo: async (pk: PublicKey, cfg?: any) => {
        const a = this.get(pk);
        if (a && cfg && typeof cfg === "object" && cfg.dataSlice) return { ...a, data: a.data.subarray(cfg.dataSlice.offset, cfg.dataSlice.offset + cfg.dataSlice.length) };
        return a;
      },
      getAccountInfoAndContext: async (pk: PublicKey) => ({ context: { slot: this.seatSlot }, value: this.get(pk) }),
      getMultipleAccountsInfo: async (pks: PublicKey[]) => pks.map((pk) => this.get(pk)),
      getProgramAccounts: async (owner: PublicKey, cfg: any) => {
        if (this.rpcError) throw new Error(this.rpcError);
        const out: { pubkey: PublicKey; account: FakeAccount }[] = [];
        for (const [k, a] of this.accounts) {
          if (!a.owner.equals(owner) || this.hidden.has(k)) continue;
          const ok = (cfg?.filters ?? []).every((f: any) => {
            const want = Buffer.from(bs58.decode(f.memcmp.bytes));
            return a.data.subarray(f.memcmp.offset, f.memcmp.offset + want.length).equals(want);
          });
          if (ok) out.push({ pubkey: new PublicKey(k), account: a });
        }
        let ls = this.listSlot;
        for (const [name, s] of this.listSlotOf) {
          const n = ((this.program.idl as anchor.Idl).accounts ?? []).find((a) => a.name.toLowerCase() === name.toLowerCase())!.name;
          const disc = bs58.encode(Buffer.from((this.program.coder.accounts as any).accountDiscriminator(n)));
          if (cfg?.filters?.[0]?.memcmp?.bytes === disc) ls = s;
        }
        return cfg?.withContext ? (ls === null ? out : { context: { slot: ls }, value: out }) : out;
      },
      getSlot: async () => Number(this.slot),
      ...({
          // read at call time: a world sets cuPerIx after its provider exists (null = this node cannot simulate)
          simulateTransaction: async (vtx: VersionedTransaction) => {
            if (this.cuPerIx === null) throw new Error("simulateTransaction: method not supported");
            const n = vtx.message.compiledInstructions.length - 1; // the 1.4M limit instruction is not the program's
            if (this.simRefuse) return { context: { slot: Number(this.slot) }, value: { err: { InstructionError: [1, { Custom: 6000 }] }, logs: [`Program log: AnchorError ... Error Code: ${this.simRefuse}`], unitsConsumed: 0 } };
            return { context: { slot: Number(this.slot) }, value: { err: null, logs: [], unitsConsumed: this.cuPerIx! * n + 150 } };
          },
        }),
      getBalance: async () => {
        if (this.rpcError) throw new Error(this.rpcError);
        if (this.balance === null) throw new Error("getBalance: 503");
        return this.balance;
      },
    };
  }
  provider(payer: Keypair): anchor.Provider {
    return {
      connection: this.connection(),
      publicKey: payer.publicKey,
      wallet: new anchor.Wallet(payer),
      // one transaction, all or nothing (as on chain): every instruction passes failOn and the emulator, in order
      sendAndConfirm: async (tx: Transaction) => {
        // the compute-unit limit instruction is not the program's: recorded apart, never decoded
        for (const ix of tx.instructions) if (ix.programId.equals(ComputeBudgetProgram.programId)) this.cuLimits.push(ix.data.readUInt32LE(1));
        const list: Sent[] = tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)).map((ix) => {
          const d = (this.program.coder.instruction as any).decode(ix.data) as { name: string; data: any } | null;
          return { name: d?.name ?? "?", data: d?.data, keys: ix.keys };
        });
        if (this.beforeTx) this.beforeTx(list);
        const snapshot = new Map(this.accounts);
        for (const s of list) {
          const why = this.failOn(s) ?? (this.apply ? this.apply(s) : null);
          if (why) {
            this.accounts = snapshot;
            throw new Error(why);
          }
        }
        this.sent.push(...list);
        this.txs++;
        this.slot += this.slotPerTx;
        return `sig${this.sent.length}`;
      },
    } as unknown as anchor.Provider;
  }
  names() {
    return this.sent.map((s) => s.name);
  }
}

function zero(idl: anchor.Idl, t: any): any {
  if (typeof t === "string") {
    if (t === "bool") return false;
    if (t === "pubkey") return PublicKey.default;
    if (["u8", "i8", "u16", "i16", "u32", "i32"].includes(t)) return 0;
    return new anchor.BN(0);
  }
  if (t.array) return Array.from({ length: t.array[1] }, () => zero(idl, t.array[0]));
  if (t.vec) return [];
  if (t.option) return null;
  const d = (idl.types ?? []).find((x) => x.name === t.defined.name)! as any;
  if (d.type.kind === "struct") return Object.fromEntries(d.type.fields.map((f: any) => [camel(f.name), zero(idl, f.type)]));
  return { [camel(d.type.variants[0].name)]: {} };
}
/** BorshAccountsCoder.encode without its async wrapper (same layout + discriminator), so fixtures are built inline */
function enc(program: anchor.Program, name: string, over: Record<string, unknown>): Buffer {
  const coderName = ((program.idl as anchor.Idl).accounts ?? []).find((a) => a.name.toLowerCase() === name.toLowerCase())!.name;
  const coder = program.coder.accounts as any;
  const buf = Buffer.alloc(8_000);
  const len = coder.accountLayouts.get(coderName).layout.encode({ ...zero(program.rawIdl as anchor.Idl, { defined: { name } }), ...over }, buf);
  return Buffer.concat([Buffer.from(coder.accountDiscriminator(coderName)), buf.subarray(0, len)]);
}

// ── scenario helpers ───────────────────────────────────────────────────────────────────────────────────────────────
const NOW = 1_800_000_000;
const PROGRAM_DATA = new PublicKey("CXcE1TYM4SGJWcYfdCV8PNu3hcbioGo2z6851qjZeQEs");
function putProgram(c: FakeChain, deploySlot: number) {
  const prog = Buffer.alloc(36);
  prog.writeUInt32LE(2, 0);
  PROGRAM_DATA.toBuffer().copy(prog, 4);
  c.put(programId, BPF_LOADER_UPGRADEABLE, prog);
  const head = Buffer.alloc(45);
  head.writeUInt32LE(3, 0);
  head.writeBigUInt64LE(BigInt(deploySlot), 4);
  c.put(PROGRAM_DATA, BPF_LOADER_UPGRADEABLE, head);
}
interface World {
  c: FakeChain;
  p: anchor.Program;
  keeper: Keypair;
  architect: PublicKey;
  oracle: PublicKey;
}
function world(keeper = Keypair.generate()): World {
  const c0 = new FakeChain(programV3({} as never));
  const p = programV3(c0.provider(keeper));
  const c = Object.assign(c0, { program: p });
  const architect = Keypair.generate().publicKey;
  const oracle = Keypair.generate().publicKey;
  c.put(PDA.config(), programId, enc(p, "Config", { version: 2, architect, oracle, jackpotRound: BN(5), drawRound: BN(3), lastEpoch: BN(0) }));
  c.slotHashes();
  return { c, p, keeper, architect, oracle };
}
function putSeat(w: World, over: Partial<Record<string, unknown>>) {
  w.c.put(PDA_V3.houseKeeper(), programId, enc(w.p, "HouseKeeper", { keeper: w.keeper.publicKey, bond: BN(KEEPER_BOND_MIN), lastActiveTs: BN(NOW - 60), bump: 255, ...over }));
}
/** arms the seat with this keeper's derived chain (as the program would), `revealed` positions consumed */
function armWith(w: World, o: { buildSlot?: bigint; nonce?: number; nextIndex?: number; revealed?: number; pending?: number; bond?: bigint; lastActive?: number } = {}) {
  const buildSlot = o.buildSlot ?? 990_000n;
  const nonce = o.nonce ?? 3;
  const id = { buildSlot, nonce, length: chainLengthOf(buildSlot, nonce) };
  const chain = buildChain(chainSeed(chainKeyOf(w.keeper), PDA_V3.houseKeeper(), id), id.length);
  const revealed = o.revealed ?? 0;
  putSeat(w, {
    tip: Array.from(chain[revealed]), length: BN(id.length), nextIndex: BN(o.nextIndex ?? 0), revealed: BN(revealed), armedSlot: BN(buildSlot + 37n),
    pendingBets: o.pending ?? 0, bond: BN(o.bond ?? KEEPER_BOND_MIN), lastActiveTs: BN(o.lastActive ?? NOW - 60),
  });
  return { chain, id };
}
let nonceCounter = 0;
function putBet(w: World, o: { index: number; anchorSlot: bigint; anchored?: boolean; legacy?: boolean; targetSlot?: bigint }) {
  const ps = Keypair.generate().publicKey;
  const n = nonceCounter++;
  const pk = PDA.bet(ps, n);
  const game = o.legacy ? 0 : 0x80 | (o.anchored ? 0x40 : 0);
  w.c.put(pk, programId, enc(w.p, "Bet", {
    playerState: ps, owner: Keypair.generate().publicKey, rentPayer: Keypair.generate().publicKey, game, stake: BN(XNT), payout: BN(2n * XNT), nonce: BN(n),
    targetSlot: BN(o.targetSlot ?? betPack(BigInt(o.index), o.anchorSlot)), bump: 255,
  }));
  return pk;
}
function putJackpot(w: World, id: number, o: Record<string, unknown>, entries: { player: PublicKey; amount: bigint }[]) {
  let start = 0n;
  entries.forEach((e, i) => {
    w.c.put(PDA.jpEntry(id, i), programId, enc(w.p, "JackpotEntry", { round: BN(id), index: i, player: e.player, start: BN(start), amount: BN(e.amount), rentPayer: e.player, bump: 255 }));
    start += e.amount;
  });
  w.c.put(PDA.jackpot(id), programId, enc(w.p, "JackpotRound", { id: BN(id), total: BN(start), entries: entries.length, firstPlayer: entries[0]?.player ?? PublicKey.default, multiPlayer: entries.length > 1, bump: 255, ...o }));
}
/**
 * The program's effect on the fake chain, for the instructions the keeper's walk depends on (keeper.rs / p2p.rs): the
 * same checks (anchored, chain order, keccak(reveal) == tip, already anchored, block in SlotHashes) and the same state
 * changes (seat tip / revealed / pending, bet closed, round settled or refunded, arm / take installing a chain).
 * `settledAt` records the slot each round was settled at.
 */
function emulate(w: World) {
  const settledAt = new Map<string, bigint>();
  const seatNow = () => w.p.coder.accounts.decode("houseKeeper", w.c.get(PDA_V3.houseKeeper())!.data);
  const putSeatRaw = (d: any) => w.c.put(PDA_V3.houseKeeper(), programId, enc(w.p, "HouseKeeper", d));
  const reveal = (d: any, r: Buffer): string | null => {
    if (!keccak(r).equals(Buffer.from(d.tip))) return "BadReveal: keccak(reveal) != tip";
    d.tip = Array.from(r);
    d.revealed = BN(BigInt(d.revealed.toString()) + 1n);
    return null;
  };
  w.c.apply = (s) => {
    const k = (i: number) => s.keys[i].pubkey;
    if (s.name === "anchorBet") {
      const a = w.c.get(k(0));
      if (!a) return "AccountNotInitialized: bet";
      const b = w.p.coder.accounts.decode("bet", a.data);
      if ((Number(b.game) & 0x40) !== 0) return "InvalidTarget: already anchored";
      const l = lookupSlotHash(w.c.get(SYSVAR_SLOT_HASHES_PUBKEY)!.data, betUnpack(BigInt(b.targetSlot.toString())).anchor);
      if (l.kind !== "ready") return `anchor block ${l.kind}`;
      w.c.put(k(0), programId, enc(w.p, "Bet", { ...b, game: Number(b.game) | 0x40 }));
      return null;
    }
    if (s.name === "settleBetV2" || s.name === "revealKeeper") {
      const d = seatNow();
      if (s.name === "settleBetV2") {
        const a = w.c.get(k(1));
        if (!a) return "AccountNotInitialized: bet";
        const b = w.p.coder.accounts.decode("bet", a.data);
        if ((Number(b.game) & 0x40) === 0) return "NotReady: anchor_bet first";
        if (betUnpack(BigInt(b.targetSlot.toString())).index !== BigInt(d.revealed.toString())) return "BadReveal: not the next position";
        w.c.del(k(1));
        d.pendingBets = Number(d.pendingBets) - 1;
      } else if (BigInt(d.revealed.toString()) >= BigInt(d.nextIndex.toString())) return "BadReveal: nothing to skip";
      const bad = reveal(d, Buffer.from(s.data.reveal));
      if (bad) return bad;
      putSeatRaw(d);
      return null;
    }
    if (s.name === "refundStalledBet") {
      if (!w.c.get(k(1))) return "AccountNotInitialized: bet";
      w.c.del(k(1));
      const d = seatNow();
      d.pendingBets = Number(d.pendingBets) - 1;
      putSeatRaw(d);
      return null;
    }
    if (s.name === "settleJackpotV2") {
      const ra = w.c.get(k(1));
      if (!ra) return "AccountNotInitialized: round";
      const r = w.p.coder.accounts.decode("jackpotRound", ra.data);
      if (Number(r.state) !== 1) return "RoundNotDrawing";
      const d = seatNow();
      const zero = Buffer.from(s.data.reveal).equals(Buffer.alloc(32));
      if (!zero) {
        if (betUnpack(BigInt(r.targetSlot.toString())).index !== BigInt(d.revealed.toString())) return "BadReveal: not the next position";
        const bad = reveal(d, Buffer.from(s.data.reveal));
        if (bad) return bad;
        settledAt.set(k(1).toBase58(), w.c.slot);
      }
      d.pendingBets = Number(d.pendingBets) - 1;
      putSeatRaw(d);
      w.c.put(k(1), programId, enc(w.p, "JackpotRound", { ...r, state: zero ? 3 : 2, winningTicket: BN(zero ? U64_MAX : 1n) }));
      return null;
    }
    if (s.name === "armKeeper" || s.name === "takeKeeper") {
      const a = w.c.get(PDA_V3.houseKeeper());
      const d = a ? seatNow() : { keeper: k(2), bump: 255, bond: BN(0) };
      if (s.name === "takeKeeper") {
        d.keeper = k(3);
        d.bond = BN(s.data.deposit.toString());
      } else d.bond = BN(BigInt(d.bond.toString()) + BigInt(s.data.deposit.toString()));
      putSeatRaw({ ...d, tip: Array.from(s.data.tip), length: BN(s.data.length.toString()), nextIndex: BN(0), revealed: BN(0), armedSlot: BN(w.c.slot), pendingBets: 0, lastActiveTs: BN(NOW) });
      return null;
    }
    return null;
  };
  return { settledAt };
}

const reveals = (w: World) => w.c.sent.filter((s) => s.data && s.data.reveal).map((s) => Buffer.from(s.data.reveal));
const opts = (o: Record<string, unknown> = {}) => ({ now: () => NOW, sleep: async () => undefined, memo: newMemoV3(), clockMs: () => 0, ...o });

async function main() {
  // ── chains ───────────────────────────────────────────────────────────────────────────────────────────────────────
  await test("chain KDF: deterministic per key, different per key / slot / nonce, keccak-linked, tip = x_0", () => {
    const a = Keypair.generate();
    const b = Keypair.generate();
    const id = { buildSlot: 123_456n, nonce: 5, length: chainLengthOf(123_456n, 5) };
    const seat = PDA_V3.houseKeeper();
    const ca = buildChain(chainSeed(chainKeyOf(a), seat, id), id.length);
    const ca2 = buildChain(chainSeed(chainKeyOf(Keypair.fromSecretKey(a.secretKey)), seat, id), id.length);
    assert.strictEqual(ca.length, id.length + 1);
    assert(ca[0].equals(ca2[0]) && ca[id.length].equals(ca2[id.length]), "a restarted runner rebuilds the same chain");
    for (let k = 1; k <= 50; k++) assert(keccak(ca[k]).equals(ca[k - 1]), `keccak(x_${k}) == x_${k - 1}`);
    assert(!chainSeed(chainKeyOf(b), seat, id).equals(chainSeed(chainKeyOf(a), seat, id)), "another key, another chain");
    assert(!chainSeed(chainKeyOf(a), seat, { ...id, buildSlot: id.buildSlot + 1n, length: chainLengthOf(id.buildSlot + 1n, 5) }).equals(chainSeed(chainKeyOf(a), seat, id)));
    assert(!chainSeed(chainKeyOf(a), seat, { ...id, nonce: 6, length: chainLengthOf(id.buildSlot, 6) }).equals(chainSeed(chainKeyOf(a), seat, id)));
    // the key is the only secret: the public key alone (what the chain shows) gives a different seed
    const pubOnly = Keypair.fromSeed(Buffer.alloc(32, 7));
    assert(!chainKeyOf(pubOnly).equals(chainKeyOf(a)));
    assert.throws(() => buildChain(Buffer.alloc(32), 0), /out of range/);
  });

  await test("chain id recovery: length and armed_slot give back (build slot, nonce) whenever the arm lands within 1,024 slots", () => {
    for (const s of [0n, 1n, 1023n, 1024n, 85_429_880n, 987_654_321n]) {
      for (const nonce of [0, 7, 15]) {
        for (const lag of [0n, 1n, 150n, 1023n]) {
          const len = chainLengthOf(s, nonce);
          assert(len >= CHAIN_LEN_BASE && len < CHAIN_LEN_BASE + 16 * 1024);
          assert.deepStrictEqual(chainIdOf(s + lag, BigInt(len)), { buildSlot: s, nonce, length: len }, `s ${s} nonce ${nonce} lag ${lag}`);
        }
      }
    }
    assert.strictEqual(chainIdOf(10n, BigInt(CHAIN_LEN_BASE - 1)), null, "a length below the scheme");
    assert.strictEqual(chainIdOf(10n, BigInt(CHAIN_LEN_BASE + 16 * 1024)), null, "a length above the scheme");
    assert.strictEqual(chainIdOf(3n, BigInt(CHAIN_LEN_BASE + 5)), null, "armed before its own build slot");
    assert.throws(() => chainLengthOf(1n, 16), /nonce/);
  });

  await test("KeeperChains.identify: the installed chain at any revealed count; never another key's, a tampered tip or a foreign length", () => {
    const w = world();
    const { chain } = armWith(w, { revealed: 7, nextIndex: 9 });
    const raw = w.p.coder.accounts.decode("houseKeeper", w.c.get(PDA_V3.houseKeeper())!.data);
    const { seatOf } = require("../src/keeper-v3");
    const seat: SeatV3 = seatOf(raw);
    const mine = new KeeperChains(w.keeper).identify(seat);
    assert(mine && mine[7].equals(seat.tip) && mine[8].equals(chain[8]));
    assert.strictEqual(new KeeperChains(Keypair.generate()).identify(seat), null, "another key");
    assert.strictEqual(new KeeperChains(w.keeper).identify({ ...seat, tip: Buffer.alloc(32, 9) }), null, "a tip this chain never had");
    assert.strictEqual(new KeeperChains(w.keeper).identify({ ...seat, length: 5n }), null, "a length of another scheme");
    const fresh = new KeeperChains(w.keeper).fresh(555n, 2);
    assert.strictEqual(fresh.id.length, chainLengthOf(555n, 2));
    assert(fresh.tip.equals(new KeeperChains(w.keeper).chain(fresh.id)[0]));
  });

  await test("chain id recovery when the arm landed BEFORE its build slot (a node ahead of the fork): the candidate 1,024 slots up", () => {
    const w = world();
    const buildSlot = 5_000_123n;
    const id = { buildSlot, nonce: 9, length: chainLengthOf(buildSlot, 9) };
    const chain = buildChain(chainSeed(chainKeyOf(w.keeper), PDA_V3.houseKeeper(), id), id.length);
    for (const armedSlot of [buildSlot - 1n, buildSlot - 40n, buildSlot]) {
      const ids = chainIdsOf(armedSlot, BigInt(id.length));
      assert(ids.some((x) => x.buildSlot === buildSlot && x.nonce === 9), `armed at ${armedSlot}`);
      const seat: SeatV3 = {
        keeper: w.keeper.publicKey, pendingKeeper: PublicKey.default, tip: chain[3], length: BigInt(id.length), nextIndex: 5n, revealed: 3n, bond: KEEPER_BOND_MIN,
        pendingBets: 2, lastActiveTs: NOW, armedSlot, jackpotReserved: 0n, withdrawTs: 0,
      };
      const got = new KeeperChains(w.keeper).identify(seat);
      assert(got && got[4].equals(chain[4]), `identified at armed slot ${armedSlot}`);
    }
    assert.deepStrictEqual(chainIdsOf(10n, 5n), [], "a length of another scheme");
    assert.strictEqual(chainIdsOf(3n, BigInt(CHAIN_LEN_BASE + 5)).length, 1, "below the low bits: only the candidate above");
  });

  // ── pure mirrors ─────────────────────────────────────────────────────────────────────────────────────────────────
  await test("lookupSlotHash mirrors utils.rs lookup_in (gaps, the oldest entry, not yet, expired)", () => {
    const c = new FakeChain(programV3({} as never));
    c.slot = 1_511n; // entries 1000..1511
    c.slotHashes([1200n, 1201n, 1202n, 1203n, 1204n, 1205n, 1206n, 1207n, 1208n, 1209n, 1210n, 1300n, 1499n]);
    const d = c.get(SYSVAR_SLOT_HASHES_PUBKEY)!.data;
    const at = (t: bigint) => lookupSlotHash(d, t);
    assert.strictEqual(at(999n).kind, "expired");
    assert.strictEqual(at(1512n).kind, "notYet");
    for (const [t, got] of [[1000n, 1000n], [1199n, 1199n], [1200n, 1211n], [1205n, 1211n], [1300n, 1301n], [1499n, 1500n], [1511n, 1511n]] as const) {
      const l = at(t);
      assert(l.kind === "ready" && l.hash.equals(slotHash(got)), `target ${t} -> slot ${got}`);
    }
    assert.strictEqual(lookupSlotHash(null, 5n).kind, "notYet");
  });

  await test("stall reasons, packing, the v2 Jackpot ticket, the v3 tip rule and the strict v2 Prediction clock", () => {
    const A = 1_000n;
    assert.strictEqual(stallReason(true, 5n, A, 5n, A + KEEPER_STALL_SLOTS, false), null, "at the limit: still settleable");
    assert.strictEqual(stallReason(true, 5n, A, 5n, A + KEEPER_STALL_SLOTS + 1n, false), 1, "anchored and stalled: a WIN");
    assert.strictEqual(stallReason(false, 5n, A, 6n, A + 1n, false), 1, "skipped: refundable at once");
    assert.strictEqual(stallReason(false, 5n, A, 5n, A + 600n, true), 0, "never anchored, block gone: a refund");
    assert.strictEqual(stallReason(false, 5n, A, 5n, A + 10n, false), null);
    assert.deepStrictEqual(betUnpack(betPack(123n, 456_789n)), { index: 123n, anchor: 456_789n });
    assert.deepStrictEqual(betUnpack(betPack((1n << 24n) - 1n, (1n << 40n) - 1n)), { index: (1n << 24n) - 1n, anchor: (1n << 40n) - 1n });
    const h = Buffer.alloc(32, 1);
    const r = Buffer.alloc(32, 2);
    const round = Keypair.generate().publicKey;
    const want = randomU64(keccak(Buffer.from("MOONFORGE_JACKPOT_V2"), h, r), round.toBuffer(), u64(9)) % 777n;
    assert.strictEqual(jackpotTicketV2(h, r, round, 9n, 777n), want);
    const [k, pl, or] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    assert.strictEqual(KEEPER_TIP_MIN_CLAIM_V3, 200_000_000n);
    assert(keeperTipDueV3(k, pl, or, KEEPER_TIP_MIN_CLAIM_V3));
    assert(!keeperTipDueV3(k, pl, or, KEEPER_TIP_MIN_CLAIM_V3 - 1n));
    assert(!keeperTipDueV3(or, pl, or, 10n * XNT), "the oracle earns no tip (v3)");
    assert(!keeperTipDueV3(pl, pl, or, 10n * XNT));
    assert(!predTimeReached(100, 100, false) && predTimeReached(101, 100, false) && predTimeReached(100, 100, true));
  });

  await test("seat state machine: idle without a seat or a bond, helper for another key, busy, re-arm (deposit 0) when unknown, nearly used up or idle 7 days", () => {
    const me = Keypair.generate().publicKey;
    const base: SeatV3 = {
      keeper: me, pendingKeeper: PublicKey.default, tip: Buffer.alloc(32, 1), length: 20_000n, nextIndex: 10n, revealed: 10n, bond: KEEPER_BOND_MIN, pendingBets: 0,
      lastActiveTs: NOW - 60, armedSlot: 1n, jackpotReserved: 0n, withdrawTs: 0,
    };
    assert.match(armDecision(null, me, false, NOW).reason, /F1-b: armed only later, once a keeper runs continuously/);
    assert.strictEqual(armDecision(null, me, false, NOW).arm, false);
    assert.match(armDecision({ ...base, keeper: Keypair.generate().publicKey }, me, true, NOW).reason, /helper/);
    assert.deepStrictEqual(armDecision({ ...base, bond: KEEPER_BOND_MIN - 1n }, me, false, NOW).arm, false);
    assert.match(armDecision({ ...base, bond: KEEPER_BOND_MIN - 1n }, me, false, NOW).reason, /manual operator step \(from a project wallet only\)/);
    assert.strictEqual(armDecision({ ...base, pendingBets: 1 }, me, false, NOW).arm, false, "never with something pending");
    assert.strictEqual(armDecision(base, me, false, NOW).arm, true, "a chain this key cannot derive");
    assert.strictEqual(armDecision({ ...base, nextIndex: base.length - REARM_BELOW + 1n }, me, true, NOW).arm, true);
    assert.strictEqual(armDecision({ ...base, lastActiveTs: NOW - KEEPALIVE_AFTER }, me, true, NOW).arm, true);
    assert.strictEqual(armDecision(base, me, true, NOW).arm, false);
    const r = { state: 0, endTs: NOW - 1, multiPlayer: true };
    assert(drawDecision(r, "holder", 8n, NOW) && !drawDecision(r, "holder", 9n, NOW));
    assert(!drawDecision(r, "holder-unknown-chain", 0n, NOW));
    assert(!drawDecision(r, "helper", 0n, NOW) && drawDecision(r, "helper", 0n, NOW - 1 + HELPER_DRAW_GRACE));
    assert(drawDecision(r, "no-seat", 0n, NOW), "no seat: the draw is a penalty-free refund, at once");
    assert(drawDecision({ ...r, multiPlayer: false }, "holder-unknown-chain", 99n, NOW), "a single player is refunded by anyone");
    assert(!drawDecision({ ...r, endTs: NOW + 1 }, "holder", 0n, NOW) && !drawDecision({ ...r, state: 1 }, "holder", 0n, NOW));
  });

  // ── detection ────────────────────────────────────────────────────────────────────────────────────────────────────
  await test("W2-4 detection: legacy and a half-done upgrade run the v2 pass; the upgraded binary the v3 pass; an RPC error keeps the last mode", async () => {
    const w = world();
    putProgram(w.c, LIVE_DEPLOY_SLOT);
    assert.strictEqual((await keeperModeV3(w.c.connection(), w.p, "v3")).mode, "v2", "the live binary: v2, whatever came before");
    putProgram(w.c, 90_000_000);
    assert.strictEqual((await keeperModeV3(w.c.connection(), w.p, "v2")).mode, "v2", "new binary before init_extra / init_seat");
    w.c.put(PDA_V3.extraState(), programId, enc(w.p, "ExtraState", { bump: 255, vaultBump: 255 }));
    w.c.put(PDA_V3.oracleSeat(), programId, enc(w.p, "OracleSeat", { generation: BN(1), bump: 255 }));
    assert.strictEqual((await keeperModeV3(w.c.connection(), w.p, "v2")).mode, "v3");
    w.c.rpcError = "429 Too Many Requests";
    assert.strictEqual((await keeperModeV3(w.c.connection(), w.p, "v3")).mode, "v3");
    assert.strictEqual((await keeperModeV3(w.c.connection(), w.p, "v2")).mode, "v2");
  });

  // ── the pass: seat roles ─────────────────────────────────────────────────────────────────────────────────────────
  await test("no seat: nothing revealed or armed; an ended Jackpot round is drawn at once (with keeper_seat: the program refunds it, reason 3)", async () => {
    const w = world();
    const [a, b] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    putJackpot(w, 5, { endTs: BN(NOW - 10), state: 0 }, [{ player: a, amount: XNT }, { player: b, amount: XNT }]);
    const r1 = await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.strictEqual(r1.role, "no-seat");
    assert(r1.notes.some((n) => /F1-b: armed only later/.test(n)), "says the first arm comes later (F1-b), not at S7");
    assert.strictEqual(r1.sent, 1);
    assert.deepStrictEqual(w.c.names(), ["drawJackpot"]);
    assert.deepStrictEqual(w.c.sent[0].keys.map((k) => k.pubkey.toBase58()), [PDA.config(), PDA.jackpot(5), PDA.player(a), PDA_V3.houseKeeper()].map((k) => k.toBase58()));
    assert(!w.c.names().some((n) => /armKeeper|takeKeeper|revealKeeper|settleBetV2/.test(n)), "never arms, takes or reveals");
    // allowDraw false (the end of a run): not drawn
    w.c.sent = [];
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ now: () => NOW + 9_999, allowDraw: false }));
    assert.deepStrictEqual(w.c.names(), []);
  });

  await test("helper: an ended round of a seated keeper is drawn only after HELPER_DRAW_GRACE (a holder outage then costs its bond, by design)", async () => {
    const w = world();
    putSeat(w, { keeper: Keypair.generate().publicKey, length: BN(20_000) });
    const [a, b] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    putJackpot(w, 5, { endTs: BN(NOW - 10), state: 0 }, [{ player: a, amount: XNT }, { player: b, amount: XNT }]);
    const r1 = await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.strictEqual(r1.role, "helper");
    assert.deepStrictEqual(w.c.names(), []);
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ now: () => NOW - 10 + HELPER_DRAW_GRACE - 1 }));
    assert.deepStrictEqual(w.c.names(), []);
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ now: () => NOW - 10 + HELPER_DRAW_GRACE }));
    assert.deepStrictEqual(w.c.names(), ["drawJackpot"]);
    // the loop's clock agrees: the helper's next draw is end + grace, the holder's is the end itself
    const n = await nextDeadlineV3(w.c.connection(), w.p, NOW - 100, w.keeper.publicKey);
    assert.strictEqual(n.at, NOW - 10 + HELPER_DRAW_GRACE);
  });

  await test("holder: anchors, then settles in chain order with x_{p+1}, skips a refunded position, settles the Jackpot round at its position with the right winner", async () => {
    const w = world();
    w.c.listSlot = w.c.seatSlot + 5;
    const S = w.c.slot;
    const { chain } = armWith(w, { revealed: 4, nextIndex: 8, pending: 3 });
    const b4 = putBet(w, { index: 4, anchorSlot: S - 50n, anchored: true });
    const b5 = putBet(w, { index: 5, anchorSlot: S - 20n }); // anchor block ready, not anchored yet
    // position 6: its bet was refunded (no account): skipped
    const players = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    putJackpot(w, 5, { state: 1, endTs: BN(NOW - 100), winningTicket: BN(U64_MAX), targetSlot: BN(betPack(7n, S - 10n)) }, players.map((p, i) => ({ player: p, amount: BigInt(i + 1) * XNT })));
    emulate(w);
    const logs: string[] = [];
    const r = await keeperPassV3(w.c.connection(), w.p, w.keeper, (s) => logs.push(s), opts());
    assert.strictEqual(r.role, "holder");
    // R-1: the four positions in ONE transaction, in chain order; the bet not anchored yet is anchored right before its settle
    // (then, the round being settled, the slow cycle closes its three entries: rent back)
    assert.deepStrictEqual(w.c.names(), ["settleBetV2", "anchorBet", "settleBetV2", "revealKeeper", "settleJackpotV2", "closeJackpotEntry", "closeJackpotEntry", "closeJackpotEntry"]);
    assert.strictEqual(w.c.txs, 4, "the walk in one transaction, then the three entries");
    assert(w.c.sent[1].keys[0].pubkey.equals(b5));
    assert(w.c.sent[0].keys[1].pubkey.equals(b4) && w.c.sent[2].keys[1].pubkey.equals(b5), "bets in position order");
    const rv = reveals(w);
    assert.deepStrictEqual(rv.map((x) => x.toString("hex")), [5, 6, 7, 8].map((k) => chain[k].toString("hex")), "the reveals are x_5..x_8, in order");
    let tip = chain[4];
    for (const x of rv) {
      assert(keccak(x).equals(tip), "each reveal is the preimage of the current tip");
      tip = x;
    }
    // the Jackpot winner: the program's formula on the anchor block and x_8
    const ticket = jackpotTicketV2(slotHash(S - 10n), chain[8], PDA.jackpot(5), 5n, 6n * XNT);
    const winner = ticket < XNT ? 0 : ticket < 3n * XNT ? 1 : 2;
    const jk = w.c.sent[4].keys.map((k) => k.pubkey.toBase58());
    assert.strictEqual(jk[2], PDA.jpEntry(5, winner).toBase58());
    assert.strictEqual(jk[3], PDA.player(players[winner]).toBase58());
    assert.strictEqual(jk[6], w.architect.toBase58(), "the architect account is Config's");
    assert(jk.includes(PDA_V3.houseKeeper().toBase58()));
    // no preimage of the chain in any log line, in any encoding
    const all = logs.join("\n");
    for (let k = 0; k <= 12; k++) for (const e of [chain[k].toString("hex"), bs58.encode(chain[k]), chain[k].toString("base64")]) if (k > 4) assert(!all.includes(e), `x_${k} leaked into a log`);
  });

  await test("holder: a bet list read before the seat (stale RPC) never skips a position; a missing anchor block stops the walk", async () => {
    const w = world();
    armWith(w, { revealed: 2, nextIndex: 4, pending: 1 });
    putBet(w, { index: 3, anchorSlot: w.c.slot - 5n, anchored: true });
    w.c.listSlot = w.c.seatSlot - 1; // older than the seat read
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.deepStrictEqual(w.c.names(), [], "position 2 looks empty in a stale list: not skipped");
    w.c.listSlot = null; // a node without context: same
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.deepStrictEqual(w.c.names(), []);
    // the bet at the next position was placed in the last slot: its anchor block does not exist yet
    const w2 = world();
    w2.c.listSlot = w2.c.seatSlot;
    armWith(w2, { revealed: 0, nextIndex: 1, pending: 1 });
    putBet(w2, { index: 0, anchorSlot: w2.c.slot + 1n });
    await keeperPassV3(w2.c.connection(), w2.p, w2.keeper, () => undefined, opts());
    assert.deepStrictEqual(w2.c.names(), [], "nothing to anchor, nothing to reveal yet");
  });

  await test("holder: a Jackpot-round list read before the seat never skips a position either (a skipped DRAWING round would expire against the bond)", async () => {
    const w = world();
    const { chain } = armWith(w, { revealed: 2, nextIndex: 3, pending: 0 }); // position 2: its bet was refunded
    w.c.listSlot = w.c.seatSlot; // the bet list is fresh
    w.c.listSlotOf.set("JackpotRound", w.c.seatSlot - 1); // the round list is not
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.deepStrictEqual(w.c.names(), [], "not skipped on a stale round list");
    w.c.listSlotOf.set("JackpotRound", w.c.seatSlot + 2);
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.deepStrictEqual(w.c.names(), ["revealKeeper"]);
    assert(reveals(w)[0].equals(chain[3]));
  });

  await test("nextDeadlineV3 by role: the holder's bets are due at once; a helper's anchored bet only when it stalls, an unanchored one at once", async () => {
    const w = world();
    const other = Keypair.generate().publicKey;
    putSeat(w, { keeper: other, nextIndex: BN(1), pendingBets: 1, length: BN(20_000) });
    putBet(w, { index: 0, anchorSlot: w.c.slot - 100n, anchored: true });
    const h = await nextDeadlineV3(w.c.connection(), w.p, NOW, w.keeper.publicKey);
    const wait = Math.floor(Number(KEEPER_STALL_SLOTS + 1n - 100n) * 0.35);
    assert.strictEqual(h.at, NOW + wait, "a helper waits for the stall");
    assert(h.reasons.includes("a stalled bet to refund"));
    assert.strictEqual((await nextDeadlineV3(w.c.connection(), w.p, NOW, other)).at, NOW, "the holder settles at once");
    putBet(w, { index: 1, anchorSlot: w.c.slot - 2n });
    assert.strictEqual((await nextDeadlineV3(w.c.connection(), w.p, NOW, w.keeper.publicKey)).at, NOW, "an unanchored bet: anchor (or refund it) within minutes");
  });

  await test("stalled bets: reason 1 (anchored, > 235,000 slots) and reason 0 (never anchored, block gone) are refunded; the holder then skips their positions", async () => {
    const w = world();
    w.c.listSlot = w.c.seatSlot;
    const S = w.c.slot;
    const { chain } = armWith(w, { revealed: 0, nextIndex: 2, pending: 2 });
    putBet(w, { index: 0, anchorSlot: S - KEEPER_STALL_SLOTS - 2n, anchored: true });
    putBet(w, { index: 1, anchorSlot: S - 600n });
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.deepStrictEqual(w.c.names(), ["refundStalledBet", "refundStalledBet", "revealKeeper", "revealKeeper"]);
    assert.deepStrictEqual(reveals(w).map((x) => x.toString("hex")), [chain[1].toString("hex"), chain[2].toString("hex")]);
    const keys = w.c.sent[0].keys.map((k) => k.pubkey.toBase58());
    assert(keys.includes(PDA_V3.houseKeeper().toBase58()) && keys.includes(PDA.rewardVault().toBase58()));
    // a helper refunds too (permissionless), never reveals
    const h = world();
    putSeat(h, { keeper: Keypair.generate().publicKey, nextIndex: BN(1), pendingBets: 1, length: BN(20_000) });
    putBet(h, { index: 0, anchorSlot: h.c.slot - 600n });
    const r = await keeperPassV3(h.c.connection(), h.p, h.keeper, () => undefined, opts());
    assert.strictEqual(r.role, "helper");
    assert.deepStrictEqual(h.c.names(), ["refundStalledBet"]);
  });

  await test("helper: anchors a bet whose block is ready (permissionless), never settles, skips or arms", async () => {
    const w = world();
    putSeat(w, { keeper: Keypair.generate().publicKey, nextIndex: BN(1), pendingBets: 1, length: BN(20_000) });
    putBet(w, { index: 0, anchorSlot: w.c.slot - 3n });
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.deepStrictEqual(w.c.names(), ["anchorBet"]);
  });

  await test("round 4 (bond-paid stalls): a keeper bet placed while the pass runs is anchored by the in-pass urgent check; the 5-s loop check sees it too", async () => {
    const w = world();
    putSeat(w, { keeper: Keypair.generate().publicKey, nextIndex: BN(2), pendingBets: 2, length: BN(20_000) });
    putBet(w, { index: 0, anchorSlot: w.c.slot - 3n });
    let late: PublicKey | null = null;
    // the second bet lands while the pass anchors the first one (the page that placed it did not anchor it)
    w.c.beforeTx = (list) => {
      if (!late && list.some((s) => s.name === "anchorBet")) late = putBet(w, { index: 1, anchorSlot: w.c.slot - 2n });
    };
    const logs: string[] = [];
    await keeperPassV3(w.c.connection(), w.p, w.keeper, (s) => logs.push(s), opts());
    assert.deepStrictEqual(w.c.names(), ["anchorBet", "anchorBet"], "the late bet is anchored in the same pass, once");
    assert(logs.some((l) => /waits for its anchor/.test(l)));
    assert(w.c.sent[1].keys.some((k) => k.pubkey.equals(late!)), "the second anchor is the late bet's");
    // the keeper loop's 5-s check between two passes (houseDueV3): an unanchored keeper bet whose block is in SlotHashes
    const v = world();
    putSeat(v, { keeper: Keypair.generate().publicKey, nextIndex: BN(1), pendingBets: 1, length: BN(20_000) });
    assert.strictEqual(await houseDueV3(v.c.connection(), v.p), false, "nothing waits");
    putBet(v, { index: 0, anchorSlot: v.c.slot - 3n, anchored: true });
    assert.strictEqual(await houseDueV3(v.c.connection(), v.p), false, "an anchored bet waits for the holder, not for an anchor");
    putBet(v, { index: 1, anchorSlot: v.c.slot - 3n });
    assert.strictEqual(await houseDueV3(v.c.connection(), v.p), true, "an unanchored one is due now");
    assert.strictEqual(await houseDueV3(v.c.connection(), v.p, false), false, "a holder that cannot derive its chain never anchors");
    assert.strictEqual(anchorsForRoleV3("holder-unknown-chain"), false);
    assert.strictEqual(anchorsForRoleV3("helper") && anchorsForRoleV3("holder") && anchorsForRoleV3("no-seat"), true);
  });

  await test("holder with a chain it cannot derive: no anchor, no reveal; reason-0 refunds; re-arm (deposit 0) once nothing is pending", async () => {
    const w = world();
    putSeat(w, { tip: Array(32).fill(4), length: BN(5_000), armedSlot: BN(10), nextIndex: BN(2), pendingBets: 2 });
    putBet(w, { index: 0, anchorSlot: w.c.slot - 3n }); // anchorable, but this key could never reveal it
    putBet(w, { index: 1, anchorSlot: w.c.slot - 700n }); // expired, unanchored
    const logs: string[] = [];
    const r = await keeperPassV3(w.c.connection(), w.p, w.keeper, (s) => logs.push(s), opts());
    assert.strictEqual(r.role, "holder-unknown-chain");
    assert.deepStrictEqual(w.c.names(), ["refundStalledBet"]);
    assert(logs.some((l) => /not one this key derives/.test(l)));
    // nothing pending: re-armed with a derivable chain and deposit 0
    const w2 = world();
    putSeat(w2, { tip: Array(32).fill(4), length: BN(5_000), armedSlot: BN(10), nextIndex: BN(5_000), revealed: BN(5_000), pendingBets: 0 });
    await keeperPassV3(w2.c.connection(), w2.p, w2.keeper, () => undefined, opts());
    assert.deepStrictEqual(w2.c.names(), ["armKeeper"]);
    const d = w2.c.sent[0].data;
    assert.strictEqual(d.deposit.toString(), "0", "never a deposit");
    const id = chainIdOf(w2.c.slot + 3n, BigInt(d.length.toString()))!;
    assert.strictEqual(id.buildSlot, w2.c.slot, "the length encodes the build slot");
    assert(Buffer.from(d.tip).equals(new KeeperChains(w2.keeper).chain(id)[0]), "the tip is the derived chain's x_0");
    assert(w2.c.sent[0].keys.find((k) => k.isSigner)!.pubkey.equals(w2.keeper.publicKey));
  });

  await test("holder: re-arms when nearly used up or idle for 7 days (nothing pending), never with a bond below 20 XNT, never while busy", async () => {
    const run = async (o: Parameters<typeof armWith>[1]) => {
      const w = world();
      armWith(w, o);
      const r = await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
      return { names: w.c.names(), notes: r.notes };
    };
    const len = chainLengthOf(990_000n, 3);
    assert.deepStrictEqual((await run({ nextIndex: len - 100, revealed: len - 100 })).names, ["armKeeper"]);
    assert.deepStrictEqual((await run({ lastActive: NOW - KEEPALIVE_AFTER - 1 })).names, ["armKeeper"]);
    assert.deepStrictEqual((await run({})).names, [], "armed, active: nothing to do");
    const low = await run({ nextIndex: len, revealed: len, bond: KEEPER_BOND_MIN - 1n });
    assert.deepStrictEqual(low.names, []);
    assert(low.notes.some((n) => /manual operator step/.test(n)));
    assert.deepStrictEqual((await run({ nextIndex: len, revealed: len - 1, pending: 1 })).names, [], "busy: no arm");
  });

  await test("Jackpot: a v3 round whose block left SlotHashes takes the expiry path with a zero reveal; the holder skips its position next", async () => {
    const w = world();
    w.c.listSlot = w.c.seatSlot;
    const players = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    armWith(w, { revealed: 0, nextIndex: 1, pending: 1 });
    putJackpot(w, 5, { state: 1, endTs: BN(NOW - 900), winningTicket: BN(U64_MAX), targetSlot: BN(betPack(0n, w.c.slot - 800n)) }, players.map((p) => ({ player: p, amount: XNT })));
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.deepStrictEqual(w.c.names(), ["settleJackpotV2", "revealKeeper"]);
    assert(Buffer.from(w.c.sent[0].data.reveal).equals(Buffer.alloc(32)), "no preimage is spent on an expiry");
  });

  await test("holder: draws an ended round when its backlog is small, then settles it in the same pass", async () => {
    const w = world();
    w.c.listSlot = w.c.seatSlot;
    armWith(w, { revealed: 3, nextIndex: 3 });
    const players = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    putJackpot(w, 5, { state: 0, endTs: BN(NOW - 1) }, players.map((p) => ({ player: p, amount: XNT })));
    // the draw lands: the program writes DRAWING at the next position, anchored at slot + 1
    let settles = 0;
    w.c.failOn = (s) => {
      if (s.name === "drawJackpot") {
        armWith(w, { revealed: 3, nextIndex: 4, pending: 1 });
        // the anchor block (slot + 1) is not in SlotHashes yet on the first try
        putJackpot(w, 5, { state: 1, endTs: BN(NOW - 1), winningTicket: BN(U64_MAX), targetSlot: BN(betPack(3n, w.c.slot + 1n)) }, players.map((p) => ({ player: p, amount: XNT })));
      }
      if (s.name === "settleJackpotV2") {
        settles++;
        putJackpot(w, 5, { state: 2, endTs: BN(NOW - 1), winningTicket: BN(1) }, players.map((p) => ({ player: p, amount: XNT })));
      }
      return null;
    };
    const sleep = async () => {
      w.c.slot += 3n; // time passes: the anchor block reaches SlotHashes
      w.c.slotHashes();
    };
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ sleep }));
    // then (slow cycle) the settled round's entries are closed, rent back to their payers
    assert.deepStrictEqual(w.c.names(), ["drawJackpot", "settleJackpotV2", "closeJackpotEntry", "closeJackpotEntry"], "settled in the same pass, once the block exists");
    assert.strictEqual(settles, 1);
  });

  await test("legacy work on the upgraded binary: v2-drawn Jackpot rounds settle through settle_jackpot, legacy bets through settle_bet", async () => {
    const w = world();
    const players = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    putJackpot(w, 5, { state: 1, endTs: BN(NOW - 100), winningTicket: BN(0), targetSlot: BN(w.c.slot - 30n) }, players.map((p) => ({ player: p, amount: XNT })));
    putBet(w, { index: 0, anchorSlot: 0n, legacy: true, targetSlot: w.c.slot - 2n });
    putBet(w, { index: 0, anchorSlot: 0n, legacy: true, targetSlot: w.c.slot + 2n }); // not yet
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.deepStrictEqual(w.c.names(), ["settleJackpot", "settleBet"]);
    const t = randomU64(slotHash(w.c.slot - 30n), PDA.jackpot(5).toBuffer(), u64(5)) % (2n * XNT);
    assert.strictEqual(w.c.sent[0].keys[2].pubkey.toBase58(), PDA.jpEntry(5, t < XNT ? 0 : 1).toBase58());
  });

  // ── budget and logs ──────────────────────────────────────────────────────────────────────────────────────────────
  await test("bounded: at most maxTx transactions a pass; a failed reveal stops the walk and its preimage is scrubbed from the log", async () => {
    const w = world();
    w.c.listSlot = w.c.seatSlot;
    const { chain } = armWith(w, { revealed: 0, nextIndex: 6, pending: 0 });
    armWith(w, { revealed: 0, nextIndex: 6, pending: 1 });
    putBet(w, { index: 0, anchorSlot: w.c.slot - 9n, anchored: true });
    const r = await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ maxTx: 2 }));
    assert.strictEqual(r.sent, 2);
    assert.strictEqual(w.c.txs, 2, "two transactions (positions 0-3, then 4-5: WALK_BATCH per transaction)");
    assert.deepStrictEqual(w.c.names(), ["settleBetV2", "revealKeeper", "revealKeeper", "revealKeeper", "revealKeeper", "revealKeeper"]);
    const w2 = world();
    w2.c.listSlot = w2.c.seatSlot;
    const c2 = armWith(w2, { revealed: 0, nextIndex: 3, pending: 1 }).chain;
    putBet(w2, { index: 0, anchorSlot: w2.c.slot - 9n, anchored: true });
    w2.c.failOn = (s) => (s.name === "settleBetV2" ? `Simulation failed: data ${Buffer.from(s.data.reveal).toString("hex")} / ${bs58.encode(Buffer.from(s.data.reveal))}` : null);
    const logs: string[] = [];
    const r2 = await keeperPassV3(w2.c.connection(), w2.p, w2.keeper, (s) => logs.push(s), opts());
    assert.strictEqual(r2.failed, 2, "the batch, then its first position alone");
    assert.deepStrictEqual(w2.c.names(), [], "nothing after the failed settle");
    const all = logs.join("\n");
    assert(all.includes("<reveal>") && !all.includes(c2[1].toString("hex")) && !all.includes(bs58.encode(c2[1])));
    void chain;
  });

  // ── lottery, entries, P2P, Predictions ───────────────────────────────────────────────────────────────────────────
  await test("Burn Lottery after retirement: an ended open round is drawn, a drawing round settles on its block, settled entries are closed", async () => {
    const w = world();
    const pl = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const putDraw = (state: number, target: bigint) => w.c.put(PDA.draw(3), programId, enc(w.p, "DrawRound", { id: BN(3), endTs: BN(NOW - 5), totalWeight: BN(10), entries: 2, state, targetSlot: BN(target), bump: 255 }));
    pl.forEach((p, i) => w.c.put(PDA.drawEntry(3, i), programId, enc(w.p, "DrawEntry", { round: BN(3), index: i, player: p, start: BN(i * 5), weight: BN(5), rentPayer: p, bump: 255 })));
    putDraw(0, 0n);
    w.c.failOn = (s) => (s.name === "drawDraw" ? (putDraw(1, w.c.slot - 3n), null) : null);
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.deepStrictEqual(w.c.names().slice(0, 2), ["drawDraw", "settleDraw"]);
    const t = randomU64(slotHash(w.c.slot - 3n), PDA.draw(3).toBuffer(), u64(3)) % 10n;
    assert.strictEqual(w.c.sent[1].keys[2].pubkey.toBase58(), PDA.drawEntry(3, t < 5n ? 0 : 1).toBase58());
    // settled: entries closed (rent back) in the slow cycle
    const w2 = world();
    pl.forEach((p, i) => w2.c.put(PDA.drawEntry(2, i), programId, enc(w2.p, "DrawEntry", { round: BN(2), index: i, player: p, rentPayer: p, bump: 255 })));
    w2.c.put(PDA.draw(2), programId, enc(w2.p, "DrawRound", { id: BN(2), state: 2, bump: 255 }));
    await keeperPassV3(w2.c.connection(), w2.p, w2.keeper, () => undefined, opts());
    assert.deepStrictEqual(w2.c.names(), ["closeDrawEntry", "closeDrawEntry"]);
  });

  await test("Jackpot entries: a refunded round's entries every pass, a settled round's only in the slow cycle", async () => {
    const w = world();
    const pl = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    putJackpot(w, 3, { state: 3 }, pl.map((p) => ({ player: p, amount: XNT })));
    putJackpot(w, 4, { state: 2 }, pl.map((p) => ({ player: p, amount: XNT })));
    const memo = newMemoV3();
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ memo, clockMs: () => 0 }));
    assert.deepStrictEqual(w.c.names(), ["closeJackpotEntry", "closeJackpotEntry", "closeJackpotEntry", "closeJackpotEntry"]);
    w.c.sent = [];
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ memo, clockMs: () => 1_000 }));
    assert.deepStrictEqual(w.c.names(), ["closeJackpotEntry", "closeJackpotEntry"], "only the refunded round within the slow interval");
  });

  await test("Duel and Moon Wars timeouts, the legacy start, the payout (architect from Config)", async () => {
    const w = world();
    const [cr, op] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const duel = (n: number, state: number, deadline: number) => {
      const pk = PublicKey.findProgramAddressSync([Buffer.from("duel"), cr.toBuffer(), u64(n)], programId)[0];
      w.c.put(pk, programId, enc(w.p, "Duel", { creator: cr, opponent: op, nonce: BN(n), stake: BN(XNT), state, deadline: BN(deadline), rentPayer: cr, bump: 255 }));
      return pk;
    };
    const d1 = duel(1, 1, NOW - 1);
    duel(2, 1, NOW + 100);
    duel(3, 0, NOW - 100); // open offer: only its creator can cancel
    const war = (n: number, state: number, deadline: number, v2: boolean) => {
      const pk = PublicKey.findProgramAddressSync([Buffer.from("war"), cr.toBuffer(), u64(n)], programId)[0];
      w.c.put(pk, programId, enc(w.p, "War", { creator: cr, opponent: op, nonce: BN(n), stake: BN(XNT), state, deadline: BN(deadline), targetSlot: BN(v2 ? 1n << 63n : 500n), rentPayer: cr, bump: 255 }));
      return pk;
    };
    war(1, 1, NOW + 50, false); // legacy STARTING: start_war
    war(2, 1, NOW - 1, true); // sealed start, deadline passed: timeout
    war(3, 2, NOW - 1, true); // active, clock ran out
    war(4, 2, NOW + 60, true); // active, still running
    war(5, 3, 0, true); // finished: pay out
    war(6, 1, NOW + 60, true); // sealed start, still inside the window
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    const n = w.c.names();
    assert.deepStrictEqual(n.filter((x) => x === "claimDuelTimeout").length, 1);
    const dt = w.c.sent.find((s) => s.name === "claimDuelTimeout")!;
    assert(dt.keys[1].pubkey.equals(d1));
    assert(dt.keys[6].pubkey.equals(w.architect), "the architect account comes from Config");
    assert.strictEqual(n.filter((x) => x === "startWar").length, 1);
    assert.strictEqual(n.filter((x) => x === "claimWarTimeout").length, 2);
    // the two timeouts and the finished match are paid out (the fake does not change the state of the timed-out ones)
    assert.strictEqual(n.filter((x) => x === "settleWar").length, 3);
    for (const s of w.c.sent.filter((x) => x.name === "settleWar")) assert(s.keys[6].pubkey.equals(w.architect));
  });

  await test("Predictions: a v2 round locks only strictly after its lock time; a resolved round pays every entry, then closes", async () => {
    const w = world();
    const lock = NOW;
    w.c.put(PublicKey.findProgramAddressSync([Buffer.from("pred"), u64(7)], programId)[0], programId, enc(w.p, "PredRound", { id: BN(7), lockTs: BN(lock), endTs: BN(lock + 79_200), state: 0, rentPayer: w.architect, bump: 255 }));
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.deepStrictEqual(w.c.names(), [], "now == lock_ts: not yet for a v2 round");
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ now: () => lock + 1 }));
    assert.deepStrictEqual(w.c.names(), ["lockPrediction"]);
    const w2 = world();
    const rpk = PublicKey.findProgramAddressSync([Buffer.from("pred"), u64(8)], programId)[0];
    w2.c.put(rpk, programId, enc(w2.p, "PredRound", { id: BN(8), lockTs: BN(1), endTs: BN(2), state: 2, entries: 2, rentPayer: w2.architect, bump: 255 }));
    for (let i = 0; i < 2; i++) {
      const pl = Keypair.generate().publicKey;
      w2.c.put(PublicKey.findProgramAddressSync([Buffer.from("pred_entry"), u64(8), pl.toBuffer()], programId)[0], programId, enc(w2.p, "PredEntry", { round: BN(8), player: pl, amount: BN(XNT), rentPayer: pl, bump: 255 }));
    }
    // an entry of another round is not touched
    const other = Keypair.generate().publicKey;
    w2.c.put(PublicKey.findProgramAddressSync([Buffer.from("pred_entry"), u64(9), other.toBuffer()], programId)[0], programId, enc(w2.p, "PredEntry", { round: BN(9), player: other, bump: 255 }));
    await keeperPassV3(w2.c.connection(), w2.p, w2.keeper, () => undefined, opts());
    assert.deepStrictEqual(w2.c.names(), ["claimPrediction", "claimPrediction", "closePredictionRound"]);
  });

  // ── epochs, extra pot, listings ──────────────────────────────────────────────────────────────────────────────────
  const fileOf = (epoch: number, leaves: { player: string; tier: number; score: string }[]) =>
    ({ epoch, leaves, proofs: Object.fromEntries(leaves.map((l) => [`${l.player}:${l.tier}`, ["11".repeat(32)]])), totalScore: "1000", publish: { tx: "x" } }) as any;

  await test("epochs: nothing claimed inside the 48-h hold; after it every unclaimed leaf (instant / mission), the tip counted by the v3 rule; expiry; a legacy drop seed sealed", async () => {
    const w = world();
    const [p0, p1, p2] = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    const f = fileOf(2, [{ player: p0.toBase58(), tier: 0, score: "600" }, { player: p1.toBase58(), tier: 1, score: "300" }, { player: p2.toBase58(), tier: 0, score: "100" }]);
    const putEpoch = (id: number, o: Record<string, unknown>) => w.c.put(PDA.epoch(id), programId, enc(w.p, "Epoch", { id: BN(id), totalScore: BN(1000), budget: BN(XNT), bump: 255, ...o }));
    putEpoch(2, { publishedAt: BN(NOW - CLAIM_HOLD + 10), expiresAt: BN(NOW + 80 * DAY) });
    putEpoch(1, { publishedAt: BN(NOW - 91 * DAY), expiresAt: BN(NOW - DAY) }); // window over: expire
    putEpoch(3, { publishedAt: BN(NOW - 7 * DAY), expiresAt: BN(NOW + 80 * DAY), dropState: 1, dropSlot: BN(1) }); // a v2-binary drop seed, window long gone
    w.c.put(PDA.receipt(2, p2, 0), programId, Buffer.alloc(80)); // p2 claimed already
    const logs: string[] = [];
    await keeperPassV3(w.c.connection(), w.p, w.keeper, (s) => logs.push(s), opts({ epochFiles: [f] }));
    assert.deepStrictEqual(w.c.names(), ["expireEpoch", "sealDrop"], "epoch 2 is still on hold: no claim");
    // after the hold
    w.c.sent = [];
    logs.length = 0;
    await keeperPassV3(w.c.connection(), w.p, w.keeper, (s) => logs.push(s), opts({ epochFiles: [f], now: () => NOW + 10 }));
    assert.deepStrictEqual(w.c.names().filter((n) => n.startsWith("claim")), ["claimInstant", "claimMission"]);
    assert(logs.some((l) => /claimed .* tier 0 of epoch 2 \(keeper tip\)/.test(l)), "0.6 XNT from a third party: tipped");
    assert(logs.some((l) => /claimed .* tier 1 of epoch 2 \(keeper tip\)/.test(l)), "0.3 XNT: tipped too (>= 0.2)");
    // the oracle submitting: no tip in the v3 rule
    const w2 = world();
    const oracleKp = Keypair.generate();
    const w3 = world(oracleKp);
    w3.c.put(PDA.config(), programId, enc(w3.p, "Config", { version: 2, architect: w3.architect, oracle: oracleKp.publicKey, jackpotRound: BN(5), drawRound: BN(3) }));
    w3.c.put(PDA.epoch(2), programId, enc(w3.p, "Epoch", { id: BN(2), totalScore: BN(1000), budget: BN(XNT), publishedAt: BN(NOW - CLAIM_HOLD), expiresAt: BN(NOW + DAY), bump: 255 }));
    const l3: string[] = [];
    await keeperPassV3(w3.c.connection(), w3.p, w3.keeper, (s) => l3.push(s), opts({ epochFiles: [fileOf(2, [{ player: p0.toBase58(), tier: 0, score: "600" }])] }));
    assert.deepStrictEqual(w3.c.names(), ["claimInstant"]);
    assert(!l3.some((l) => /\(keeper tip\)/.test(l)), "no tip when the oracle submits");
    assert(l3.some((l) => /epoch 2: 1 claimed \(0 with a keeper tip\)/.test(l)), l3.join(" | "));
    void w2;
  });

  await test("D-47: the oracle key's automatic claims stop before its wallet is too low to publish; a helper key is never held back", async () => {
    // pure rule and guard
    assert.strictEqual(ORACLE_PUBLISH_RESERVE, 50_000_000n, "0.05 XNT, the health check's red floor");
    assert.strictEqual(Number(ORACLE_PUBLISH_RESERVE), ORACLE_MIN_LAMPORTS, "the reserve is the health floor (one number)");
    assert.deepStrictEqual([claimFundsOkV3(ORACLE_PUBLISH_RESERVE + CLAIM_COST_MAX), claimFundsOkV3(ORACLE_PUBLISH_RESERVE + CLAIM_COST_MAX - 1n), claimFundsOkV3(0n)], [true, false, false]);
    let reads = 0;
    const conn = (bal: number | null) => ({ getBalance: async () => { reads++; if (bal === null) throw new Error("503"); return bal; } });
    const me = Keypair.generate().publicKey;
    const helper = claimGuardV3(conn(0), me, Keypair.generate().publicKey);
    assert.deepStrictEqual([await helper.check(), helper.isOracle, reads], [null, false, 0], "a key that does not publish is never held back, nor read");
    const low = claimGuardV3(conn(Number(ORACLE_PUBLISH_RESERVE)), me, me);
    assert.match((await low.check())!, /^D-47: the oracle wallet holds 0\.0500 XNT/);
    const r0 = reads;
    assert.match((await low.check())!, /D-47/);
    assert.strictEqual(reads, r0, "once stopped, the pass stays stopped without re-reading");
    assert.match((await claimGuardV3(conn(null), me, me).check())!, /could not be read/, "an unreadable balance stops the claims (fail closed)");
    assert.strictEqual(await claimGuardV3(conn(1e12), me, null).check(), null, "Config unreadable: taken as the oracle, enough balance passes");
    assert.match((await claimGuardV3(conn(0), me, null).check())!, /D-47/, "Config unreadable: taken as the oracle, guarded");

    // the keeper pass with the oracle key: claims after the hold only while the reserve stays
    const p0 = Keypair.generate().publicKey;
    const p1 = Keypair.generate().publicKey;
    const oracleKp = Keypair.generate();
    const mk = (keeper: Keypair) => {
      const w = world(keeper);
      w.c.put(PDA.config(), programId, enc(w.p, "Config", { version: 2, architect: w.architect, oracle: oracleKp.publicKey, jackpotRound: BN(5), drawRound: BN(3) }));
      w.c.put(PDA.epoch(2), programId, enc(w.p, "Epoch", { id: BN(2), totalScore: BN(1000), budget: BN(XNT), publishedAt: BN(NOW - CLAIM_HOLD), expiresAt: BN(NOW + DAY), bump: 255 }));
      const bitmap = Array(125).fill(0);
      w.c.put(PDA_V3.extraEpoch(4), programId, enc(w.p, "ExtraEpoch", { id: BN(4), root: Array.from(Buffer.from("cd".repeat(32), "hex")), publishedAt: BN(NOW - CLAIM_HOLD - 1), leaves: 1, budget: BN(XNT), bitmap, rentPayer: oracleKp.publicKey, bump: 255 }));
      return w;
    };
    const files = { epochFiles: [fileOf(2, [{ player: p0.toBase58(), tier: 0, score: "600" }, { player: p1.toBase58(), tier: 0, score: "400" }])], extraFiles: [{ epoch: 4, root: "cd".repeat(32), leaves: [{ index: 0, wallet: p0.toBase58(), amount: "5000000" }], proofs: {} } as any] };
    const w = mk(oracleKp);
    w.c.balance = Number(ORACLE_PUBLISH_RESERVE + CLAIM_COST_MAX - 1n);
    const logs: string[] = [];
    const rep1 = await keeperPassV3(w.c.connection(), w.p, w.keeper, (s) => logs.push(s), opts(files));
    assert.deepStrictEqual(w.c.names().filter((n) => n.startsWith("claim")), [], "no claim: the reserve is for publishing");
    assert.strictEqual(logs.filter((l) => /D-47/.test(l)).length, 1, "said once per pass: " + logs.join(" | "));
    assert(rep1.notes.some((n) => /^D-47: the oracle wallet holds/.test(n)), "the pass report carries it");
    const ok = mk(oracleKp);
    ok.c.balance = Number(ORACLE_PUBLISH_RESERVE + CLAIM_COST_MAX);
    await keeperPassV3(ok.c.connection(), ok.p, ok.keeper, () => undefined, opts(files));
    assert.deepStrictEqual(ok.c.names().filter((n) => n.startsWith("claim")), ["claimInstant", "claimInstant", "claimExtra"], "at the line, the claims go out");
    const dead = mk(oracleKp);
    dead.c.balance = null;
    await keeperPassV3(dead.c.connection(), dead.p, dead.keeper, () => undefined, opts(files));
    assert.deepStrictEqual(dead.c.names().filter((n) => n.startsWith("claim")), [], "balance unreadable: no claim");
    const help = mk(Keypair.generate());
    help.c.balance = 0;
    await keeperPassV3(help.c.connection(), help.p, help.keeper, () => undefined, opts(files));
    assert.deepStrictEqual(help.c.names().filter((n) => n.startsWith("claim")), ["claimInstant", "claimInstant", "claimExtra"], "a helper key pays its own claims, whatever its balance");
  });

  await test("upkeep guard: the oracle key's expiries and extra closes wait while its wallet is under the publish reserve, unless the close refunds it; a helper key is never held back", async () => {
    CU_MEMO.clear(); // the fallbacks below are the unmeasured ones
    // pure rule, under X1's per-CU fee (LOW-2): FEE_COST_MAX is the fee of the unmeasured fallback (200,000 units requested)
    assert.strictEqual(FEE_COST_MAX, 2_001_500n, "1,500 + 10 × 200,000 lamports");
    assert.strictEqual(FEE_COST_MAX, feeOfLimitV3(200_000));
    // a measured upkeep (~20k units, limit 24,000) costs 241,500: every closed account refunds more than that
    const measured = feeOfLimitV3(cuLimitForV3(20_000));
    assert.strictEqual(measured, 241_500n);
    assert(RENT_FLOOR > measured, "every closed account refunds more than one measured upkeep fee");
    assert(RENT_FLOOR < FEE_COST_MAX, "but not more than an unmeasured one: such a close waits like any other upkeep");
    assert.deepStrictEqual(
      [feeFundsOkV3(ORACLE_PUBLISH_RESERVE + FEE_COST_MAX), feeFundsOkV3(ORACLE_PUBLISH_RESERVE + FEE_COST_MAX - 1n), feeFundsOkV3(FEE_COST_MAX, RENT_FLOOR), feeFundsOkV3(FEE_COST_MAX - 1n, RENT_FLOOR), feeFundsOkV3(0n)],
      [true, false, false, false, false],
    );
    assert.deepStrictEqual(
      [feeFundsOkV3(measured, RENT_FLOOR, ORACLE_PUBLISH_RESERVE, measured), feeFundsOkV3(measured - 1n, RENT_FLOOR, ORACLE_PUBLISH_RESERVE, measured), feeFundsOkV3(ORACLE_PUBLISH_RESERVE + measured, 0n, ORACLE_PUBLISH_RESERVE, measured)],
      [true, false, true],
      "the fee of the limit actually requested",
    );
    // the old base-fee guess (100,000) was 20× too low for an unmeasured upkeep and below even a measured one
    assert(feeOfLimitV3(null) === 2_000_000n && feeOfLimitV3(null, 3) === 6_000_000n && feeOfLimitV3(null, 9) === 14_000_000n, "no limit: 200,000 units per instruction, 1.4M at most");
    assert(feeFundsOkV3(ORACLE_PUBLISH_RESERVE + FEE_COST_MAX) && !claimFundsOkV3(ORACLE_PUBLISH_RESERVE + FEE_COST_MAX), "an upkeep fee is allowed where a claim is not");
    const me = Keypair.generate().publicKey;
    const conn = (bal: number | null) => ({ getBalance: async () => { if (bal === null) throw new Error("503"); return bal; } });
    assert.strictEqual(await claimGuardV3(conn(0), me, Keypair.generate().publicKey).checkFee(), null, "a key that does not publish is never held back");
    assert.match((await claimGuardV3(conn(null), me, me).checkFee())!, /^D-47 \(upkeep\): .*could not be read/, "fail closed");
    const g = claimGuardV3(conn(Number(ORACLE_PUBLISH_RESERVE)), me, me);
    assert.match((await g.checkFee())!, /^D-47 \(upkeep\): the oracle wallet holds 0\.0500 XNT/);
    assert.strictEqual(await g.checkFee(RENT_FLOOR, measured), null, "a close that refunds this wallet more than its fee still goes");
    assert.match((await g.checkFee(RENT_FLOOR))!, /plus one fee \(0\.0020 XNT at the requested compute-unit limit\)/, "unmeasured: the fallback's fee is more than the rent floor");
    assert.strictEqual(g.stopped, null, "the claims' state is separate");

    // the keeper pass with the oracle key: an expired epoch and an extra epoch past its 90 days
    const oracleKp = Keypair.generate();
    const mk = (keeper: Keypair, rentPayer: PublicKey) => {
      const w = world(keeper);
      w.c.put(PDA.config(), programId, enc(w.p, "Config", { version: 2, architect: w.architect, oracle: oracleKp.publicKey, jackpotRound: BN(5), drawRound: BN(3) }));
      w.c.put(PDA.epoch(1), programId, enc(w.p, "Epoch", { id: BN(1), totalScore: BN(1000), budget: BN(XNT), publishedAt: BN(NOW - 91 * DAY), expiresAt: BN(NOW - DAY), bump: 255 }));
      w.c.put(PDA_V3.extraEpoch(4), programId, enc(w.p, "ExtraEpoch", { id: BN(4), root: Array.from(Buffer.from("cd".repeat(32), "hex")), publishedAt: BN(NOW - CLAIM_WINDOW), leaves: 1, budget: BN(XNT), bitmap: Array(125).fill(0), rentPayer, bump: 255 }));
      return w;
    };
    const files = { extraFiles: [{ epoch: 4, root: "cd".repeat(32), leaves: [{ index: 0, wallet: Keypair.generate().publicKey.toBase58(), amount: "5000000" }], proofs: {} } as any] };
    const low = Number(ORACLE_PUBLISH_RESERVE + FEE_COST_MAX - 1n);
    // under the reserve: the expiry waits; the close whose rent goes back to another key waits too
    const a = mk(oracleKp, Keypair.generate().publicKey);
    a.c.balance = low;
    const logs: string[] = [];
    const rep = await keeperPassV3(a.c.connection(), a.p, a.keeper, (s) => logs.push(s), opts(files));
    assert.deepStrictEqual(a.c.names().filter((n) => n === "expireEpoch" || n === "closeExtraEpoch"), [], "held back: the reserve is for publishing");
    assert.strictEqual(logs.filter((l) => /D-47 \(upkeep\)/.test(l)).length, 1, "said once per pass: " + logs.join(" | "));
    assert(rep.notes.some((n) => /^D-47 \(upkeep\)/.test(n)), "the pass report carries it");
    // under the reserve plus the measured fee (limit 25,000: 251,500 lamports), but the close refunds its rent to this very
    // wallet, more than that fee: it goes (the expiry still waits); each carries the limit its own simulation measured
    const b = mk(oracleKp, oracleKp.publicKey);
    b.c.balance = Number(ORACLE_PUBLISH_RESERVE + feeOfLimitV3(cuLimitForV3(20_150)) - 1n);
    b.c.cuPerIx = 20_000;
    await keeperPassV3(b.c.connection(), b.p, b.keeper, () => undefined, opts(files));
    assert.deepStrictEqual(b.c.names().filter((n) => n === "expireEpoch" || n === "closeExtraEpoch"), ["closeExtraEpoch"]);
    assert.deepStrictEqual(b.c.cuLimits, [cuLimitForV3(20_150)], "the close went with the limit the guard priced");
    // the same close on a node that cannot simulate, nothing measured in this process: the fallback's fee (2,001,500) is
    // more than the rent floor, it waits (with b's measurements remembered, the fallback would be 1.5 × them)
    CU_MEMO.clear();
    const b2 = mk(oracleKp, oracleKp.publicKey);
    b2.c.balance = low;
    await keeperPassV3(b2.c.connection(), b2.p, b2.keeper, () => undefined, opts(files));
    assert.deepStrictEqual(b2.c.names().filter((n) => n === "expireEpoch" || n === "closeExtraEpoch"), []);
    // the guard derives from the limit requested: a wallet too low for an unmeasured fee still pays two measured ones
    const b3 = mk(oracleKp, Keypair.generate().publicKey);
    b3.c.balance = low;
    b3.c.cuPerIx = 20_000;
    await keeperPassV3(b3.c.connection(), b3.p, b3.keeper, () => undefined, opts(files));
    assert.deepStrictEqual(b3.c.names().filter((n) => n === "expireEpoch" || n === "closeExtraEpoch"), ["expireEpoch", "closeExtraEpoch"]);
    // at the line: both go; the node cannot simulate, so each carries the fallback: b3's measurement × 1.5 (this process
    // remembers it), and with nothing remembered the runtime default, never no limit
    const c = mk(oracleKp, Keypair.generate().publicKey);
    c.c.balance = Number(ORACLE_PUBLISH_RESERVE + FEE_COST_MAX);
    await keeperPassV3(c.c.connection(), c.p, c.keeper, () => undefined, opts(files));
    assert.deepStrictEqual(c.c.names().filter((n) => n === "expireEpoch" || n === "closeExtraEpoch"), ["expireEpoch", "closeExtraEpoch"]);
    assert.deepStrictEqual(c.c.cuLimits, [31_000, 31_000], "the remembered measurement (20,150) × 1.5, rounded up to 1,000");
    CU_MEMO.clear();
    const c2 = mk(oracleKp, Keypair.generate().publicKey);
    c2.c.balance = Number(ORACLE_PUBLISH_RESERVE + FEE_COST_MAX);
    await keeperPassV3(c2.c.connection(), c2.p, c2.keeper, () => undefined, opts(files));
    assert.deepStrictEqual(c2.c.cuLimits, [200_000, 200_000], "never sent without a limit: the explicit fallback when the node cannot simulate");
    // balance unreadable: nothing (fail closed); a helper key with no balance at all is never held back
    const d = mk(oracleKp, oracleKp.publicKey);
    d.c.balance = null;
    await keeperPassV3(d.c.connection(), d.p, d.keeper, () => undefined, opts(files));
    assert.deepStrictEqual(d.c.names().filter((n) => n === "expireEpoch" || n === "closeExtraEpoch"), []);
    const h = mk(Keypair.generate(), oracleKp.publicKey);
    h.c.balance = 0;
    await keeperPassV3(h.c.connection(), h.p, h.keeper, () => undefined, opts(files));
    assert.deepStrictEqual(h.c.names().filter((n) => n === "expireEpoch" || n === "closeExtraEpoch"), ["expireEpoch", "closeExtraEpoch"]);
  });

  await test("publish record of a held epoch: health says ok (claims after the hold, by the keeper), the announcement names the opening time", () => {
    const held = { tipped: 3, dust: 1, heldUntil: NOW + CLAIM_HOLD };
    const v = claimsVerdict(7, held)!;
    assert.strictEqual(v.state, "ok");
    assert.match(v.detail, /held until .*the keeper claims every leaf after it/);
    assert.strictEqual(claimsVerdict(7, { tipped: 3, dust: 1 })!.state, "warn", "a plan without the hold marker still warns, as before");
    assert.match(claimsLineV3({ claims: held }, 4), /Claims open .* UTC, after the 48-h verification hold/);
    assert.match(claimsLineV3({ claims: { claimed: 4, failed: 0, heldUntil: NOW } }, 4), /Every leaf claimed/, "what the claims did wins over the marker");
  });

  await test("extra pot: claims after the hold skip claimed bits; a file whose root is not on chain is ignored; close after 90 days", async () => {
    const w = world();
    const wallets = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const f = { epoch: 4, root: "ab".repeat(32), leaves: wallets.map((x, i) => ({ index: i, wallet: x.toBase58(), amount: "5000000" })), proofs: {} } as any;
    const bitmap = Array(125).fill(0);
    bitmap[0] = 1; // leaf 0 claimed
    const putX = (at: number) => w.c.put(PDA_V3.extraEpoch(4), programId, enc(w.p, "ExtraEpoch", { id: BN(4), root: Array.from(Buffer.from(f.root, "hex")), publishedAt: BN(at), leaves: 2, budget: BN(XNT), bitmap, rentPayer: w.oracle, bump: 255 }));
    putX(NOW - CLAIM_HOLD - 1);
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ extraFiles: [f, { ...f, epoch: 5 }] }));
    assert.deepStrictEqual(w.c.names(), ["claimExtra"]);
    assert.strictEqual(w.c.sent[0].data.index, 1);
    w.c.sent = [];
    putX(NOW - 10);
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ extraFiles: [f] }));
    assert.deepStrictEqual(w.c.names(), [], "on hold");
    putX(NOW - CLAIM_WINDOW);
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ extraFiles: [f] }));
    assert.deepStrictEqual(w.c.names(), ["closeExtraEpoch"]);
    assert(w.c.sent[0].keys[2].pubkey.equals(w.oracle), "the rent goes back to the key that paid it");
    w.c.sent = [];
    w.c.put(PDA_V3.extraEpoch(4), programId, enc(w.p, "ExtraEpoch", { id: BN(4), root: Array(32).fill(1), publishedAt: BN(NOW - CLAIM_HOLD - 1), leaves: 2, bitmap: Array(125).fill(0), bump: 255 }));
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ extraFiles: [f] }));
    assert.deepStrictEqual(w.c.names(), [], "another root on chain: not this file");
  });

  await test("listings: stale (the seller no longer holds the asset) and expired listings are closed, live ones are not", async () => {
    const w = world();
    const coll = PDA.collection();
    const asset = (owner: PublicKey | null) => {
      const pk = Keypair.generate().publicKey;
      if (owner) {
        const d = Buffer.alloc(66);
        d[0] = 1;
        owner.toBuffer().copy(d, 1);
        d[33] = 2;
        coll.toBuffer().copy(d, 34);
        w.c.put(pk, MPL_CORE, d);
      }
      return pk;
    };
    const seller = Keypair.generate().publicKey;
    const list = (a: PublicKey, expires: number) => w.c.put(PublicKey.findProgramAddressSync([Buffer.from("listing"), a.toBuffer()], programId)[0], programId, enc(w.p, "Listing", { asset: a, seller, expiresAt: BN(expires), bump: 255 }));
    list(asset(seller), NOW + 100); // live
    list(asset(Keypair.generate().publicKey), NOW + 100); // moved: stale
    list(asset(null), NOW + 100); // recycled: stale
    list(asset(seller), NOW - 1); // expired
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.deepStrictEqual(w.c.names(), ["closeListing", "closeListing", "closeListing"]);
  });

  // ── the oracle seat's liveness ───────────────────────────────────────────────────────────────────────────────────
  await test("oracle seat liveness: 28 days after the newest epoch not voided (its extra not voided), or after the take; warn 10 days before, critical inside the last 48 h", () => {
    const T = NOW;
    const l = oracleSeatLivenessV3(T - 40 * DAY, [{ id: 3, publishedAt: T - 20 * DAY, closed: false, extra: null }, { id: 2, publishedAt: T - 27 * DAY, closed: false, extra: null }], T);
    // walk_is_dead: alive while published_at >= now − 28 d (inclusive), so dead one second after 28 days
    assert.strictEqual(l.deadAt, T + 8 * DAY + 1);
    assert.strictEqual(l.publishBy, T + 6 * DAY + 1);
    assert.strictEqual(l.state, "warn");
    // the newest epoch is still on hold and every older one is past 28 days: dead NOW (silence is the signal)
    const held = oracleSeatLivenessV3(T - 40 * DAY, [{ id: 4, publishedAt: T - DAY, closed: false, extra: null }, { id: 3, publishedAt: T - 29 * DAY, closed: false, extra: null }], T);
    assert.strictEqual(held.state, "dead");
    assert.match(held.detail, /priority taker may take it now and anyone from/);
    // ... and alive again once its hold is over, for 28 days from its publication
    const after = oracleSeatLivenessV3(T - 40 * DAY, [{ id: 4, publishedAt: T - DAY, closed: false, extra: null }], T + DAY);
    assert.strictEqual(after.state, "ok");
    assert.strictEqual(after.deadAt, T - DAY + 28 * DAY + 1);
    // an extra epoch on hold delays its pair; a later extra never extends the base's 28 days
    const x = oracleSeatLivenessV3(T - 40 * DAY, [{ id: 4, publishedAt: T - 3 * DAY, closed: false, extra: { publishedAt: T - DAY, closed: false } }, { id: 3, publishedAt: T - 29 * DAY, closed: false, extra: null }], T);
    assert.strictEqual(x.state, "dead", "the pair counts only once the extra's hold is over too");
    // a gap between two surviving epochs ends the coverage at the gap
    const gap = oracleSeatLivenessV3(T - 40 * DAY, [{ id: 5, publishedAt: T + 40 * DAY, closed: false, extra: null }, { id: 4, publishedAt: T - 20 * DAY, closed: false, extra: null }], T);
    assert.strictEqual(gap.deadAt, T + 8 * DAY + 1);
    assert.strictEqual(oracleSeatLivenessV3(T - 40 * DAY, [{ id: 3, publishedAt: T - 5 * DAY, closed: false, extra: null }], T).state, "ok");
    assert.strictEqual(oracleSeatLivenessV3(T - 40 * DAY, [{ id: 3, publishedAt: T - 27 * DAY, closed: false, extra: null }], T).state, "critical");
    assert.strictEqual(oracleSeatLivenessV3(T - 40 * DAY, [{ id: 3, publishedAt: T - 5 * DAY, closed: true, extra: null }, { id: 2, publishedAt: T - 29 * DAY, closed: false, extra: null }], T).state, "dead", "a voided newest epoch does not count");
    assert.strictEqual(oracleSeatLivenessV3(T - 40 * DAY, [{ id: 3, publishedAt: T - 5 * DAY, closed: false, extra: { publishedAt: T - 5 * DAY, closed: true } }], T).state, "dead", "a voided extra breaks its pair");
    assert.strictEqual(oracleSeatLivenessV3(T - 3 * DAY, [], T).state, "ok", "a recent take keeps it alive");
  });

  await test("the pass warns about the oracle seat (hourly), reading the seat and the walk pairs", async () => {
    const w = world();
    w.c.put(PDA.config(), programId, enc(w.p, "Config", { version: 2, architect: w.architect, oracle: w.oracle, lastEpoch: BN(2), jackpotRound: BN(5), drawRound: BN(3) }));
    w.c.put(PDA_V3.oracleSeat(), programId, enc(w.p, "OracleSeat", { generation: BN(1), takenAt: BN(NOW - 60 * DAY), bump: 255 }));
    w.c.put(PDA.epoch(2), programId, enc(w.p, "Epoch", { id: BN(2), publishedAt: BN(NOW - 25 * DAY), expiresAt: BN(NOW + 60 * DAY), closed: true, bump: 255 })); // closed: voided
    w.c.put(PDA.epoch(1), programId, enc(w.p, "Epoch", { id: BN(1), publishedAt: BN(NOW - 22 * DAY), expiresAt: BN(NOW + 60 * DAY), bump: 255 }));
    const logs: string[] = [];
    const memo = newMemoV3();
    const r = await keeperPassV3(w.c.connection(), w.p, w.keeper, (s) => logs.push(s), opts({ memo }));
    assert(r.notes.some((n) => /stays alive until .* \(28 days after epoch 1\)/.test(n)), r.notes.join(" | "));
    assert(logs.some((l) => /WARNING: the oracle seat/.test(l)));
    const r2 = await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ memo, clockMs: () => 60_000 }));
    assert(!r2.notes.some((n) => /oracle seat/.test(n)), "hourly, not every pass");
  });

  // ── the loop's clock and the owner CLI ───────────────────────────────────────────────────────────────────────────
  await test("nextDeadlineV3: draws, bets, Duel / Moon Wars clocks and Prediction steps", async () => {
    const w = world();
    assert.deepStrictEqual(await nextDeadlineV3(w.c.connection(), w.p, NOW), { at: null, reasons: [] });
    putJackpot(w, 5, { state: 0, endTs: BN(NOW + 300) }, [{ player: Keypair.generate().publicKey, amount: XNT }]);
    assert.strictEqual((await nextDeadlineV3(w.c.connection(), w.p, NOW)).at, NOW + 300);
    putBet(w, { index: 0, anchorSlot: 1n });
    const n = await nextDeadlineV3(w.c.connection(), w.p, NOW);
    assert.strictEqual(n.at, NOW);
    assert(n.reasons.includes("bets to anchor"), n.reasons.join(" | "));
    putBet(w, { index: 0, anchorSlot: 0n, legacy: true, targetSlot: 5n });
    assert((await nextDeadlineV3(w.c.connection(), w.p, NOW)).reasons.includes("legacy bets"));
  });

  await test("keeper-arm (S7 owner step): refused before the upgrade, below 20 XNT or for another key; dry without --yes; with --yes one arm_keeper with the deposit", async () => {
    const w = world();
    putProgram(w.c, LIVE_DEPLOY_SLOT);
    await assert.rejects(armKeeperCli(w.c.connection(), w.p, w.keeper, 20, true, () => undefined), /not the upgraded binary/);
    putProgram(w.c, 90_000_000);
    w.c.put(PDA_V3.extraState(), programId, enc(w.p, "ExtraState", { bump: 255, vaultBump: 255 }));
    w.c.put(PDA_V3.oracleSeat(), programId, enc(w.p, "OracleSeat", { generation: BN(1), bump: 255 }));
    await assert.rejects(armKeeperCli(w.c.connection(), w.p, w.keeper, 19.9, true, () => undefined), /below KEEPER_BOND_MIN/);
    await assert.rejects(armKeeperCli(w.c.connection(), w.p, w.keeper, NaN, true, () => undefined), /--deposit/);
    const logs: string[] = [];
    assert.strictEqual(await armKeeperCli(w.c.connection(), w.p, w.keeper, 20, false, (s) => logs.push(s)), null);
    assert.deepStrictEqual(w.c.names(), []);
    assert(logs.some((l) => /dry: nothing sent/.test(l)));
    // R-4: without the program applying the arm, the seat does not show this key's chain: the CLI fails loudly
    putSeat(w, { tip: Array(32).fill(4), length: BN(5_000), armedSlot: BN(10) });
    await assert.rejects(armKeeperCli(w.c.connection(), w.p, w.keeper, 20, true, () => undefined), /ALERT \(R-4\)/);
    w.c.sent = [];
    emulate(w);
    const armLogs: string[] = [];
    await armKeeperCli(w.c.connection(), w.p, w.keeper, 20, true, (s) => armLogs.push(s));
    assert(armLogs.some((l) => /derived by this key/.test(l)), "checked after landing: " + armLogs.join(" | "));
    assert.deepStrictEqual(w.c.names(), ["armKeeper"]);
    assert.strictEqual(w.c.sent[0].data.deposit.toString(), (20n * XNT).toString());
    const id = chainIdOf(w.c.slot, BigInt(w.c.sent[0].data.length.toString()))!;
    assert(Buffer.from(w.c.sent[0].data.tip).equals(new KeeperChains(w.keeper).chain(id)[0]), "the loop can identify and reveal this chain");
    putSeat(w, { keeper: Keypair.generate().publicKey });
    await assert.rejects(armKeeperCli(w.c.connection(), w.p, w.keeper, 20, true, () => undefined), /held by/);
  });

  // ── review round 3 (R-1, R-4, R-5, R-6) ─────────────────────────────────────────────────────────────────────────
  const claimReceipt = (w: World, epoch: number) =>
    w.c.put(Keypair.generate().publicKey, programId, enc(w.p, "ClaimReceipt", { epoch: BN(epoch), player: Keypair.generate().publicKey, tier: 0, amount: BN(1), rentPayer: w.keeper.publicKey, bump: 255 }));

  await test("R-1: a third party draws right after the house duty, behind 31 unanchored bets, while 60 claims and a 500-receipt sweep wait: the round is settled far inside its 512 slots", async () => {
    const w = world();
    w.c.listSlot = w.c.seatSlot;
    w.c.slotPerTx = 3n; // about 1.1 s per confirmed transaction
    w.c.autoHashes = true;
    const { settledAt } = emulate(w);
    armWith(w, { revealed: 10, nextIndex: 10, pending: 0 });
    const players = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    putJackpot(w, 5, { state: 0, endTs: BN(NOW + 5) }, players.map((p) => ({ player: p, amount: XNT })));
    const leaves = Array.from({ length: 60 }, () => ({ player: Keypair.generate().publicKey.toBase58(), tier: 0, score: "10" }));
    w.c.put(PDA.epoch(2), programId, enc(w.p, "Epoch", { id: BN(2), totalScore: BN(600), budget: BN(60n * XNT), publishedAt: BN(NOW - CLAIM_HOLD - 1), expiresAt: BN(NOW + DAY), bump: 255 }));
    w.c.put(PDA.epoch(1), programId, enc(w.p, "Epoch", { id: BN(1), closed: true, bump: 255 }));
    for (let i = 0; i < 500; i++) claimReceipt(w, 1);
    let anchorSlot = 0n;
    let attacked = false;
    w.c.beforeTx = (ixs) => {
      if (attacked || !ixs.some((s) => s.name === "claimInstant")) return;
      attacked = true;
      // ONE attacker transaction at end_ts, timed right after the house duty: 31 place_bet_v2 at the minimum stake, then
      // draw_jackpot; the round takes position 41, behind 31 positions that are not even anchored
      const S = w.c.slot;
      anchorSlot = S + 1n;
      for (let i = 0; i < 31; i++) putBet(w, { index: 10 + i, anchorSlot });
      const d = w.p.coder.accounts.decode("houseKeeper", w.c.get(PDA_V3.houseKeeper())!.data);
      w.c.put(PDA_V3.houseKeeper(), programId, enc(w.p, "HouseKeeper", { ...d, nextIndex: BN(42), pendingBets: 32 }));
      putJackpot(w, 5, { state: 1, endTs: BN(NOW + 5), winningTicket: BN(U64_MAX), targetSlot: BN(betPack(41n, anchorSlot)) }, players.map((p) => ({ player: p, amount: XNT })));
    };
    const r = await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ epochFiles: [fileOf(2, leaves)] }));
    assert.strictEqual(r.role, "holder");
    assert(attacked, "the draw landed during the claims");
    const at = settledAt.get(PDA.jackpot(5).toBase58());
    assert(at !== undefined, "settled in the same pass: " + w.c.names().filter((n) => !/^claim|^close/.test(n)).join(","));
    assert(at! - anchorSlot < 120n, `settled ${at! - anchorSlot} slots after its anchor block (the window is 512)`);
    const seat = w.p.coder.accounts.decode("houseKeeper", w.c.get(PDA_V3.houseKeeper())!.data);
    assert.deepStrictEqual([Number(seat.revealed), Number(seat.pendingBets)], [42, 0], "every bet, then the round, in chain order");
    const walkTxs = Math.ceil(32 / 4);
    assert(r.sent <= 60 + walkTxs, `the pass stays bounded (the urgent walk is counted in it): ${r.sent}`);
    assert(w.c.names().filter((n) => n === "closeReceipt").length <= 60, "the sweep is bounded by the pass budget");
  });

  await test("R-1 (2): the receipt sweep and the Forge Drop delivery stop at the pass budget", async () => {
    const w = world();
    w.c.put(PDA.epoch(1), programId, enc(w.p, "Epoch", { id: BN(1), closed: true, bump: 255 }));
    for (let i = 0; i < 20; i++) claimReceipt(w, 1);
    const r = await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ maxTx: 5 }));
    assert.strictEqual(w.c.names().filter((n) => n === "closeReceipt").length, 5);
    assert.strictEqual(r.sent, 5);
    // drops: only as many deliveries as the budget allows (the v2 path, without a budget, is unchanged)
    const w2 = world();
    w2.c.put(PDA.config(), programId, enc(w2.p, "Config", { version: 2, architect: w2.architect, oracle: w2.oracle, jackpotRound: BN(5), drawRound: BN(3), artifactsAlive: [600, 0, 0, 0] }));
    w2.c.put(PDA.epoch(3), programId, enc(w2.p, "Epoch", { id: BN(3), totalScore: BN(1000), dropReserve: BN(100n * XNT), dropState: 2, expiresAt: BN(NOW + DAY), bump: 255 }));
    const f = fileOf(3, Array.from({ length: 5 }, () => ({ player: Keypair.generate().publicKey.toBase58(), tier: 0, score: "100" })));
    const { deliverDrops } = require("../src/x1");
    let n = 0;
    const budget = { canSend: () => n < 2, send: async (_l: string, fn: () => Promise<string>) => (n++, await fn(), true) };
    assert.strictEqual(await deliverDrops(w2.c.connection(), w2.p, w2.keeper, f, () => undefined, budget), 2);
    assert.deepStrictEqual(w2.c.names(), ["claimDropXnt", "claimDropXnt"]);
  });

  await test("R-1: a DRAWING round that cannot progress (entries unreadable) never spins the pass: bounded urgent runs, nothing sent", async () => {
    const w = world();
    w.c.listSlot = w.c.seatSlot;
    armWith(w, { revealed: 0, nextIndex: 1, pending: 1 });
    w.c.put(PDA.jackpot(5), programId, enc(w.p, "JackpotRound", { id: BN(5), total: BN(2n * XNT), entries: 2, multiPlayer: true, state: 1, winningTicket: BN(U64_MAX), targetSlot: BN(betPack(0n, w.c.slot - 5n)), bump: 255 }));
    let sleeps = 0;
    const r = await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ sleep: async () => void sleeps++ }));
    assert.strictEqual(r.sent, 0);
    assert(sleeps <= 20 * 4, `bounded retries: ${sleeps}`);
  });

  await test("R-1: one walk transaction carries WALK_BATCH anchor + settle pairs inside the 1,232-byte limit", async () => {
    const w = world();
    const ixs: TransactionInstruction[] = [];
    for (let i = 0; i < 4; i++) {
      const b = { pk: putBet(w, { index: i, anchorSlot: 5n }), acc: { playerState: Keypair.generate().publicKey, rentPayer: Keypair.generate().publicKey } };
      ixs.push(await (w.p.methods as any).anchorBet().accountsPartial({ bet: b.pk, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).instruction());
      ixs.push(await (w.p.methods as any).settleBetV2(Array(32).fill(7)).accountsPartial({
        config: PDA.config(), bet: b.pk, playerState: b.acc.playerState, bankrollVault: PDA.bankrollVault(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: b.acc.rentPayer, keeperSeat: PDA_V3.houseKeeper(),
        rewardVault: PDA.rewardVault(), keeper: w.keeper.publicKey,
      }).instruction());
    }
    const size = txSizeOf(ixs, w.keeper.publicKey);
    assert(size <= TX_SIZE_MAX && WALK_BATCH === 4, `4 pairs: ${size} B`);
    // with the compute-unit limit instruction counted (every keeper transaction carries one once it can simulate)
    const withCu = txSizeOf([cuIxV3(CU_SIM_UNITS), ...ixs], w.keeper.publicKey);
    console.log(`  R-1: 4 anchor + settle pairs: ${size} B, ${withCu} B with the compute-unit limit (limit ${TX_SIZE_MAX} B)`);
    assert(withCu <= TX_SIZE_MAX || txSizeOf([cuIxV3(CU_SIM_UNITS), ...ixs.slice(0, 6)], w.keeper.publicKey) <= TX_SIZE_MAX, "at least 3 pairs fit with the limit");
  });

  await test("compute-unit limits (KEEPER-INCOME.md): measured by a simulation × 1.2, rounded up to 1,000; a refusal sends nothing; no simulation = an explicit fallback, never no limit", async () => {
    assert.strictEqual(cuLimitForV3(23_535), 29_000, "the kit's settleBet rule: 23,535 measured → 29,000");
    assert.strictEqual(cuLimitForV3(1), 1_000);
    assert.strictEqual(cuLimitForV3(5_000_000), CU_SIM_UNITS);
    const payer = Keypair.generate().publicKey;
    const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 });
    assert.strictEqual(await measureCuV3({} as any, payer, [ix]), null, "a client without simulateTransaction: no limit");
    assert.strictEqual(await measureCuV3({ simulateTransaction: async () => { throw new Error("503"); } } as any, payer, [ix]), null, "an RPC error: no limit");
    assert.strictEqual(await measureCuV3({ simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 23_535, logs: [] } }) } as any, payer, [ix]), 23_535);
    await assert.rejects(measureCuV3({ simulateTransaction: async () => ({ value: { err: { InstructionError: [1, { Custom: 6001 }] }, unitsConsumed: 0, logs: ["Program log: Error Code: ClaimOnHold"] } }) } as any, payer, [ix]), /refused in simulation \(nothing was sent\).*ClaimOnHold/);
    // a pass on a node that simulates: every transaction carries its measured limit, the walk included
    const w = world();
    w.c.cuPerIx = 20_000;
    w.c.listSlot = w.c.seatSlot;
    armWith(w, { revealed: 0, nextIndex: 6, pending: 0 });
    armWith(w, { revealed: 0, nextIndex: 6, pending: 1 });
    putBet(w, { index: 0, anchorSlot: w.c.slot - 9n, anchored: true });
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ maxTx: 2 }));
    assert.strictEqual(w.c.txs, 2);
    assert.deepStrictEqual(w.c.cuLimits, [cuLimitForV3(4 * 20_000 + 150), cuLimitForV3(2 * 20_000 + 150)], "one limit per transaction, from its own simulation");
    assert.deepStrictEqual(w.c.names(), ["settleBetV2", "revealKeeper", "revealKeeper", "revealKeeper", "revealKeeper", "revealKeeper"], "the same instructions as before");
    // a simulation the program refuses: nothing is sent, the walk stops there (as a failed send would)
    const r = world();
    r.c.cuPerIx = 20_000;
    r.c.simRefuse = "BetNotAnchored";
    r.c.listSlot = r.c.seatSlot;
    armWith(r, { revealed: 0, nextIndex: 2, pending: 0 });
    armWith(r, { revealed: 0, nextIndex: 2, pending: 1 });
    putBet(r, { index: 0, anchorSlot: r.c.slot - 9n, anchored: true });
    const rep = await keeperPassV3(r.c.connection(), r.p, r.keeper, () => undefined, opts());
    assert.strictEqual(r.c.txs, 0, "nothing sent");
    assert(rep.failed >= 1);
    // LOW-5: a node that cannot simulate never sends without a limit: the runtime default per instruction (the price of
    // "no limit", but known before sending), or the same instruction list measured earlier in this process × 1.5
    const walk = async (cuPerIx: number | null) => {
      const x = world();
      x.c.cuPerIx = cuPerIx;
      x.c.listSlot = x.c.seatSlot;
      armWith(x, { revealed: 0, nextIndex: 6, pending: 0 });
      armWith(x, { revealed: 0, nextIndex: 6, pending: 1 });
      putBet(x, { index: 0, anchorSlot: x.c.slot - 9n, anchored: true });
      await keeperPassV3(x.c.connection(), x.p, x.keeper, () => undefined, opts({ maxTx: 2 }));
      return x;
    };
    CU_MEMO.clear();
    const cold = await walk(null);
    assert.deepStrictEqual(cold.c.cuLimits, [4 * 200_000, 2 * 200_000], "nothing measured yet: 200,000 per instruction");
    assert.deepStrictEqual(cold.c.names(), w.c.names(), "the same instructions");
    await walk(20_000);
    const warm = await walk(null);
    assert.deepStrictEqual(warm.c.cuLimits, [121_000, 61_000], "the earlier measurement of each list × 1.5, rounded up to 1,000");
    assert.deepStrictEqual(warm.c.names(), w.c.names());
    CU_MEMO.clear();
  });

  await test("cu-v3: the fallback is the runtime default per unmeasured instruction (or an earlier measurement × 1.5); one retry on compute exhaustion; seat dry runs measure with the 1.4M limit", async () => {
    const a = Keypair.generate().publicKey;
    const ixOf = (n: number) => new TransactionInstruction({ programId, keys: [], data: Buffer.from([n, 1, 2, 3, 4, 5, 6, 7, 9]) });
    const memo = new CuMemoV3();
    assert.strictEqual(cuFallbackV3([ixOf(1)], memo), 200_000);
    assert.strictEqual(cuFallbackV3([ixOf(1), ixOf(2), ixOf(1)], memo), 600_000);
    assert.strictEqual(cuFallbackV3(Array.from({ length: 9 }, () => ixOf(1)), memo), CU_SIM_UNITS, "capped at 1.4M");
    memo.record([ixOf(1)], 30_000);
    assert.strictEqual(cuFallbackV3([ixOf(1)], memo), 45_000);
    assert.strictEqual(cuFallbackV3([ixOf(1), ixOf(2)], memo), 245_000, "per instruction when the list was never measured");
    memo.record([ixOf(2)], 190_000);
    assert.strictEqual(cuFallbackV3([ixOf(2)], memo), 285_000, "an instruction measured near the default keeps its own margin");
    assert.strictEqual(cuFallbackV3([ixOf(2), ixOf(1)], memo), 330_000);
    assert.strictEqual(cuFallbackV3([cuIxV3(5), ixOf(1)], memo), 45_000, "a ComputeBudget instruction is not counted");
    // the plan: measured × 1.2 (recorded), else the fallback; a refusal throws
    assert.deepStrictEqual(await cuPlanV3({ simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 10_000, logs: [] } }) } as any, a, [ixOf(3)], memo), { units: 12_000, measured: true });
    assert.strictEqual(memo.ofOne(ixOf(3)), 10_000);
    assert.deepStrictEqual(await cuPlanV3({} as any, a, [ixOf(3)], memo), { units: 15_000, measured: false });
    assert.deepStrictEqual(cuPlanOfUnitsV3(null, [ixOf(4)], memo), { units: 200_000, measured: false });
    assert.deepStrictEqual(cuPlanOfUnitsV3(50_000, [ixOf(4)], memo), { units: 60_000, measured: true });
    // sendWithCuV3: the limit first, any earlier ComputeBudget instruction replaced; compute exhaustion retried once, wider
    const sent: { units: number; n: number }[] = [];
    let failFirst: Error | null = Object.assign(new Error("Simulation failed"), { logs: ["Program X consumed 12000 of 12000 compute units", "Program X failed: exceeded CUs meter at BPF instruction"] });
    const provider = {
      connection: { simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 10_000, logs: [] } }) },
      publicKey: a,
      sendAndConfirm: async (tx: Transaction) => {
        const cu = tx.instructions.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId));
        sent.push({ units: cu[0].data.readUInt32LE(1), n: tx.instructions.length });
        assert.strictEqual(cu.length, 1, "exactly one limit instruction");
        if (failFirst) {
          const e = failFirst;
          failFirst = null;
          throw e;
        }
        return "sig";
      },
    } as unknown as anchor.Provider;
    const notes: string[] = [];
    assert.strictEqual(await sendWithCuV3(provider, [cuIxV3(999), ixOf(5)], [], { memo, log: (s) => notes.push(s) }), "sig");
    assert.deepStrictEqual(sent, [{ units: 12_000, n: 2 }, { units: 200_000, n: 2 }]);
    assert.match(notes.join(" "), /limit 12000 was too low .* retrying once with 200000/);
    assert(cuExhaustedV3(new Error("Transaction simulation failed: Error processing Instruction 1: Computational budget exceeded")));
    assert(!cuExhaustedV3(new Error("custom program error: 0x1771")));
    // any other failure is not retried
    sent.length = 0;
    failFirst = new Error("custom program error: 0x1771");
    await assert.rejects(sendWithCuV3(provider, [ixOf(5)], [], { memo }), /0x1771/);
    assert.strictEqual(sent.length, 1);
    // a refused simulation sends nothing
    sent.length = 0;
    const refusing = { ...provider, connection: { simulateTransaction: async () => ({ value: { err: { InstructionError: [1, { Custom: 6000 }] }, unitsConsumed: 0, logs: ["Program log: Error Code: NothingVested"] } }) } } as unknown as anchor.Provider;
    await assert.rejects(sendWithCuV3(refusing, [ixOf(5)], [], { memo }), /refused in simulation \(nothing was sent\).*NothingVested/);
    assert.strictEqual(sent.length, 0);
    // seat-v3's dry-run simulation carries the 1.4M limit and returns the units the send then requests × 1.2
    let simIxs = 0;
    const sim = await simulateAsV3({ simulateTransaction: async (vtx: VersionedTransaction) => { simIxs = vtx.message.compiledInstructions.length; return { value: { err: null, unitsConsumed: 41_000, logs: [] } }; } } as any, a, [ixOf(6)]);
    assert.deepStrictEqual(sim, { ok: true, logs: [], err: null, units: 41_000 });
    assert.strictEqual(simIxs, 2, "the limit instruction plus the void");
    assert.deepStrictEqual(cuPlanOfUnitsV3(sim!.units, [ixOf(6)], memo), { units: 50_000, measured: true });
  });

  await test("R-6: a lost anchor race (the player's page anchored first) never stops the walk: the bet is read again and settled in the same pass", async () => {
    const w = world();
    w.c.listSlot = w.c.seatSlot;
    emulate(w);
    const { chain } = armWith(w, { revealed: 0, nextIndex: 2, pending: 2 });
    const b0 = putBet(w, { index: 0, anchorSlot: w.c.slot - 5n });
    putBet(w, { index: 1, anchorSlot: w.c.slot - 4n, anchored: true });
    let raced = false;
    w.c.beforeTx = (ixs) => {
      if (raced || !ixs.some((s) => s.name === "anchorBet")) return;
      raced = true; // the page's anchor_bet lands first
      const b = w.p.coder.accounts.decode("bet", w.c.get(b0)!.data);
      w.c.put(b0, programId, enc(w.p, "Bet", { ...b, game: Number(b.game) | 0x40 }));
    };
    const logs: string[] = [];
    await keeperPassV3(w.c.connection(), w.p, w.keeper, (s) => logs.push(s), opts());
    assert(raced);
    assert.deepStrictEqual(w.c.names(), ["settleBetV2", "settleBetV2"], logs.join(" | "));
    assert.deepStrictEqual(reveals(w).map((x) => x.toString("hex")), [chain[1].toString("hex"), chain[2].toString("hex")]);
    assert(logs.some((l) => /anchored by someone else/.test(l)));
  });

  await test("R-5: a bet list that misses one pending bet never gets that position skipped; the walk follows the trusted reads, not a lying endpoint", async () => {
    const w = world();
    w.c.listSlot = w.c.seatSlot;
    emulate(w);
    const { chain } = armWith(w, { revealed: 0, nextIndex: 2, pending: 2 });
    putBet(w, { index: 0, anchorSlot: w.c.slot - 5n, anchored: true });
    const b1 = putBet(w, { index: 1, anchorSlot: w.c.slot - 4n, anchored: true });
    w.c.hidden.add(b1.toBase58()); // a truncated getProgramAccounts answer
    const logs: string[] = [];
    await keeperPassV3(w.c.connection(), w.p, w.keeper, (s) => logs.push(s), opts());
    assert.deepStrictEqual(w.c.names(), ["settleBetV2"], "position 1 is not skipped: the lists hold fewer items than the seat's pending count");
    assert(logs.some((l) => /complete read \(R-5\)/.test(l)), logs.join(" | "));
    w.c.hidden.clear();
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.deepStrictEqual(w.c.names(), ["settleBetV2", "settleBetV2"]);
    assert(reveals(w)[1].equals(chain[2]));
    // a listed endpoint that lies (a larger next_index and fake anchored bets): only the trusted reads decide
    const w2 = world();
    w2.c.listSlot = w2.c.seatSlot;
    emulate(w2);
    const c2 = armWith(w2, { revealed: 0, nextIndex: 1, pending: 1 }).chain;
    putBet(w2, { index: 0, anchorSlot: w2.c.slot - 5n, anchored: true });
    const liar = new FakeChain(w2.p);
    liar.accounts = new Map(w2.c.accounts);
    liar.listSlot = liar.seatSlot;
    const d = w2.p.coder.accounts.decode("houseKeeper", w2.c.get(PDA_V3.houseKeeper())!.data);
    liar.put(PDA_V3.houseKeeper(), programId, enc(w2.p, "HouseKeeper", { ...d, nextIndex: BN(5), pendingBets: 5 }));
    for (let i = 1; i < 5; i++) {
      const pk = PDA.bet(Keypair.generate().publicKey, 9_000 + i);
      liar.put(pk, programId, enc(w2.p, "Bet", { playerState: Keypair.generate().publicKey, rentPayer: Keypair.generate().publicKey, game: 0xc0, targetSlot: BN(betPack(BigInt(i), w2.c.slot - 5n)), bump: 255 }));
    }
    await keeperPassV3(liar.connection(), w2.p, w2.keeper, () => undefined, opts({ trusted: w2.c.connection() }));
    assert.deepStrictEqual(reveals(w2).map((x) => x.toString("hex")), [c2[1].toString("hex")], "no future preimage is sent for positions only the liar shows");
  });

  await test("R-4: a holder that cannot derive its chain is an ALERT on every pass; keeper-take takes the seat on a derivable chain and checks it after landing", async () => {
    const w = world();
    putSeat(w, { tip: Array(32).fill(4), length: BN(5_000), armedSlot: BN(10), nextIndex: BN(1), pendingBets: 1 });
    const r = await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts());
    assert.strictEqual(r.role, "holder-unknown-chain");
    assert(r.notes.includes(UNKNOWN_CHAIN_ALERT), "the pass report carries the alert");
    // keeper-take
    const t = world();
    putProgram(t.c, 90_000_000);
    t.c.put(PDA_V3.extraState(), programId, enc(t.p, "ExtraState", { bump: 255, vaultBump: 255 }));
    t.c.put(PDA_V3.oracleSeat(), programId, enc(t.p, "OracleSeat", { generation: BN(1), bump: 255 }));
    const old = Keypair.generate().publicKey;
    putSeat(t, { keeper: old, pendingKeeper: t.keeper.publicKey, tip: Array(32).fill(4), length: BN(5_000), armedSlot: BN(10), pendingBets: 1 });
    await assert.rejects(takeKeeperCli(t.c.connection(), t.p, t.keeper, 20, true, () => undefined), /KeeperBusy/);
    putSeat(t, { keeper: old, pendingKeeper: t.keeper.publicKey, tip: Array(32).fill(4), length: BN(5_000), armedSlot: BN(10) });
    await assert.rejects(takeKeeperCli(t.c.connection(), t.p, t.keeper, 19, true, () => undefined), /KEEPER_BOND_MIN/);
    const logs: string[] = [];
    assert.strictEqual(await takeKeeperCli(t.c.connection(), t.p, t.keeper, 20, false, (s) => logs.push(s)), null);
    assert(logs.some((l) => /named successor/.test(l)) && logs.some((l) => /dry: nothing sent/.test(l)));
    assert.deepStrictEqual(t.c.names(), []);
    emulate(t);
    const tl: string[] = [];
    await takeKeeperCli(t.c.connection(), t.p, t.keeper, 20, true, (s) => tl.push(s));
    assert.deepStrictEqual(t.c.names(), ["takeKeeper"]);
    const keys = t.c.sent[0].keys.map((k) => k.pubkey.toBase58());
    assert.deepStrictEqual(keys.slice(0, 4), [PDA.config(), PDA_V3.houseKeeper(), old, t.keeper.publicKey].map((k) => k.toBase58()));
    assert.strictEqual(t.c.sent[0].data.deposit.toString(), (20n * XNT).toString());
    assert(tl.some((l) => /derived by this key/.test(l)));
    await assert.rejects(takeKeeperCli(t.c.connection(), t.p, t.keeper, 20, true, () => undefined), /already holds the seat/);
    // the next pass: holder (the chain is derived)
    const r2 = await keeperPassV3(t.c.connection(), t.p, t.keeper, () => undefined, opts());
    assert.strictEqual(r2.role, "holder");
  });

  await test("R-1: houseOnly runs the house duty alone (the keeper loop's 5-s Jackpot timer)", async () => {
    const w = world();
    const [cr, op] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const pk = PublicKey.findProgramAddressSync([Buffer.from("duel"), cr.toBuffer(), u64(1)], programId)[0];
    w.c.put(pk, programId, enc(w.p, "Duel", { creator: cr, opponent: op, nonce: BN(1), stake: BN(XNT), state: 1, deadline: BN(NOW - 1), rentPayer: cr, bump: 255 }));
    const [a, b] = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    putJackpot(w, 5, { endTs: BN(NOW - 10), state: 0 }, [{ player: a, amount: XNT }, { player: b, amount: XNT }]);
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ houseOnly: true }));
    assert.deepStrictEqual(w.c.names(), ["drawJackpot"], "no duel timeout in a house-only pass");
  });

  await test("the v3 pass refuses a v2 client", async () => {
    const { programV2 } = require("../src/x1");
    const w = world();
    await assert.rejects(keeperPassV3(w.c.connection(), programV2(w.c.provider(w.keeper)), w.keeper, () => undefined, opts()), /moon_forge\.v3\.json/);
  });

  // ── FEATURE-MATRIX gaps 11, 12: vested missions and orphaned Artifacts, permissionless, bounded, only what is due ──
  await test("gap 11: withdraw_vested is pushed monthly and at completion (the program's vesting mirrored), never for nothing or dust", () => {
    const DUR = 45 * DAY; // Orbit
    const m = (o: { withdrawn?: bigint; total?: bigint } = {}) => ({ total: o.total ?? 45n * XNT, withdrawn: o.withdrawn ?? 0n, start: NOW, end: NOW + DUR });
    assert.strictEqual(missionVestedV3(m(), NOW + 10 * DAY), 10n * XNT, "total × elapsed / duration, rounded down");
    assert.strictEqual(missionVestedV3(m(), NOW + DUR + 1), 45n * XNT);
    assert.strictEqual(missionVestedV3(m(), NOW - 5), 0n);
    assert.deepStrictEqual(vestedDueV3(m(), NOW + 29 * DAY), { due: false, amount: 29n * XNT, completes: false }, "under 30 days' worth: waits");
    assert.deepStrictEqual(vestedDueV3(m(), NOW + 30 * DAY), { due: true, amount: 30n * XNT, completes: false }, "30 days' worth: pushed");
    assert.strictEqual(vestedDueV3(m({ withdrawn: 30n * XNT }), NOW + 40 * DAY).due, false, "10 days after a push: waits");
    assert.deepStrictEqual(vestedDueV3(m({ withdrawn: 30n * XNT }), NOW + DUR), { due: true, amount: 15n * XNT, completes: true }, "complete: the rest, and the mission closes");
    assert.strictEqual(vestedDueV3(m({ withdrawn: 45n * XNT }), NOW + DUR + DAY).due, false, "nothing left (NothingVested)");
    assert.strictEqual(vestedDueV3(m({ total: 1_000n }), NOW + 40 * DAY).due, false, "dust before completion waits");
    assert.strictEqual(vestedDueV3(m({ total: 1_000n }), NOW + DUR).due, true, "dust at completion goes (it closes the mission)");
    assert.strictEqual(vestedDueV3({ total: 180n * XNT, withdrawn: 0n, start: NOW, end: NOW + 180 * DAY }, NOW + 30 * DAY).due, true, "Moon Landing: every 30 days");
  });

  await test("gap 12: an Artifact is reclaimed only when its asset is absent or Core's one-byte tombstone (stricter than the program)", () => {
    assert.strictEqual(orphanGoneV3(null), true, "closed");
    assert.strictEqual(orphanGoneV3({ owner: MPL_CORE, data: Buffer.from([0]) }), true, "burn tombstone");
    assert.strictEqual(orphanGoneV3({ owner: MPL_CORE, data: Buffer.alloc(0) }), true);
    assert.strictEqual(orphanGoneV3({ owner: MPL_CORE, data: Buffer.from([1, 2]) }), false, "a live asset");
    assert.strictEqual(orphanGoneV3({ owner: MPL_CORE, data: Buffer.alloc(80) }), false, "a Core account with key byte 0 and data: left to a person");
    assert.strictEqual(orphanGoneV3({ owner: SystemProgram.programId, data: Buffer.alloc(0) }), false, "another owner: left to a person");
  });

  await test("gaps 11, 12: the keeper pass sends withdraw_vested and reclaim_orphan for due items only, completed missions first, bounded per pass and by its cadence", async () => {
    const w = world();
    w.c.cuPerIx = 12_000;
    const mission = (epoch: number, o: { start: number; end: number; total: bigint; withdrawn?: bigint }) => {
      const player = Keypair.generate().publicKey;
      const pk = PDA.mission(epoch, player, 1);
      w.c.put(pk, programId, enc(w.p, "Mission", { player, epoch: BN(epoch), tier: 1, total: BN(o.total), withdrawn: BN(o.withdrawn ?? 0n), start: BN(o.start), end: BN(o.end), rentPayer: w.keeper.publicKey, bump: 255 }));
      return { pk, player };
    };
    const monthly = mission(1, { start: NOW - 31 * DAY, end: NOW + 14 * DAY, total: 45n * XNT });
    const done = mission(2, { start: NOW - 46 * DAY, end: NOW - DAY, total: 45n * XNT, withdrawn: 30n * XNT });
    mission(3, { start: NOW - 5 * DAY, end: NOW + 40 * DAY, total: 45n * XNT }); // not due
    mission(4, { start: NOW - 50 * DAY, end: NOW - 5 * DAY, total: 45n * XNT, withdrawn: 45n * XNT }); // nothing left
    const record = (asset: PublicKey, tier = 0) => {
      const pk = PDA.artifact(asset);
      w.c.put(pk, programId, enc(w.p, "ArtifactRecord", { asset, tier, serial: 0, backing: BN(3n * XNT), origin: 0, bump: 255 }));
      return pk;
    };
    const gone = Keypair.generate().publicKey;
    const tomb = Keypair.generate().publicKey;
    const live = Keypair.generate().publicKey;
    const odd = Keypair.generate().publicKey;
    w.c.put(tomb, MPL_CORE, Buffer.from([0]));
    w.c.put(live, MPL_CORE, Buffer.alloc(66, 1));
    w.c.put(odd, MPL_CORE, Buffer.alloc(66, 0));
    const recGone = record(gone);
    const recTomb = record(tomb, 2);
    record(live);
    record(odd);
    const memo = newMemoV3();
    const logs: string[] = [];
    await keeperPassV3(w.c.connection(), w.p, w.keeper, (s) => logs.push(s), opts({ memo }));
    const vested = w.c.sent.filter((s) => s.name === "withdrawVested");
    assert.deepStrictEqual(vested.map((s) => s.keys[0].pubkey.toBase58()), [done.pk, monthly.pk].map((k) => k.toBase58()), "the completed mission first; nothing for the others");
    assert.deepStrictEqual(vested[0].keys.map((k) => [k.pubkey.toBase58(), k.isWritable]), [
      [done.pk.toBase58(), true], [done.player.toBase58(), true], [PDA.player(done.player).toBase58(), true], [w.keeper.publicKey.toBase58(), true],
    ], "mission, player, player_state, rent_payer (forge.rs WithdrawVested)");
    const orphans = w.c.sent.filter((s) => s.name === "reclaimOrphan");
    assert.deepStrictEqual(new Set(orphans.map((s) => s.keys[2].pubkey.toBase58())), new Set([recGone, recTomb].map((k) => k.toBase58())), "the absent asset and the tombstone, never a live or an odd account");
    assert.deepStrictEqual(orphans[0].keys.map((k) => k.pubkey.toBase58()).filter((_, i) => i !== 1 && i !== 2), [PDA.config(), PDA.collection(), PDA.rewardVault(), PDA_V3.extraState()].map((k) => k.toBase58()), "config, asset, record, collection, reward_vault, extra_state (artifacts.rs ReclaimOrphan)");
    assert.strictEqual(w.c.cuLimits.length, w.c.txs, "each with its measured compute-unit limit");
    assert(logs.some((l) => /vested 15\.0000 XNT pushed to .*mission complete/.test(l)), logs.join(" | "));
    // the cadence: a second pass of the same process right after does not look again
    const before = w.c.txs;
    await keeperPassV3(w.c.connection(), w.p, w.keeper, () => undefined, opts({ memo }));
    assert.strictEqual(w.c.txs, before);
    // bounded: at most ORPHANS_PER_PASS per pass, and the pass budget wins
    const b = world();
    for (let i = 0; i < ORPHANS_PER_PASS + 3; i++) {
      const asset = Keypair.generate().publicKey;
      b.c.put(PDA.artifact(asset), programId, enc(b.p, "ArtifactRecord", { asset, tier: 0, serial: i, backing: BN(XNT), origin: 0, bump: 255 }));
    }
    await keeperPassV3(b.c.connection(), b.p, b.keeper, () => undefined, opts());
    assert.strictEqual(b.c.names().filter((n) => n === "reclaimOrphan").length, ORPHANS_PER_PASS);
    const t = world();
    for (let i = 0; i < 3; i++) {
      const asset = Keypair.generate().publicKey;
      t.c.put(PDA.artifact(asset), programId, enc(t.p, "ArtifactRecord", { asset, tier: 0, serial: i, backing: BN(XNT), origin: 0, bump: 255 }));
    }
    await keeperPassV3(t.c.connection(), t.p, t.keeper, () => undefined, opts({ maxTx: 2 }));
    assert.strictEqual(t.c.names().filter((n) => n === "reclaimOrphan").length, 2);
    assert.strictEqual(VESTED_PER_PASS, 20);
    // the program refuses one in simulation (state moved): nothing sent, the others still go
    const r = world();
    r.c.cuPerIx = 12_000;
    for (let i = 0; i < 2; i++) {
      const asset = Keypair.generate().publicKey;
      r.c.put(PDA.artifact(asset), programId, enc(r.p, "ArtifactRecord", { asset, tier: 0, serial: i, backing: BN(XNT), origin: 0, bump: 255 }));
    }
    r.c.simRefuse = "ArtifactAlive";
    const rl: string[] = [];
    const rep = await keeperPassV3(r.c.connection(), r.p, r.keeper, (s) => rl.push(s), opts());
    assert.strictEqual(r.c.names().filter((n) => n === "reclaimOrphan").length, 0, "refused in simulation: nothing sent");
    assert(rep.failed >= 2 && rl.some((l) => /reclaimed: its floor back to the pool, its supply slot freed failed: refused in simulation \(nothing was sent\).*ArtifactAlive/.test(l)), rl.join(" | "));
  });

  await test("r9 dated opening: keeper-arm and keeper-take say who may create the never-armed seat; the program's verdict is simulated, nothing sent", async () => {
    assert.strictEqual(KEEPER_OPEN_TS, Date.UTC(2026, 11, 16) / 1000, "2026-12-16 00:00 UTC");
    assert.strictEqual(KEEPER_OPEN_TS, Date.UTC(2026, 10, 18) / 1000 + KEEPER_DEAD_DELAY, "the 2026-11-18 upgrade window + 28 days");
    const before = seatCreatorV3(KEEPER_OPEN_TS - 1);
    const at = seatCreatorV3(KEEPER_OPEN_TS);
    assert(!before.open && /until 2026-12-16T00:00:00Z only the program's INITIAL_KEEPER may create it \(another key's arm is refused with OnlyKeeper\)/.test(before.text), before.text);
    assert(at.open && /since 2026-12-16T00:00:00Z anyone may create it with keeper-arm and a bond of at least 20 XNT, and becomes its keeper/.test(at.text), at.text);
    const w = world();
    putProgram(w.c, 90_000_000);
    w.c.put(PDA_V3.extraState(), programId, enc(w.p, "ExtraState", { bump: 255, vaultBump: 255 }));
    w.c.put(PDA_V3.oracleSeat(), programId, enc(w.p, "OracleSeat", { generation: BN(1), bump: 255 }));
    w.c.cuPerIx = 9_000;
    const logs: string[] = [];
    assert.strictEqual(await armKeeperCli(w.c.connection(), w.p, w.keeper, 20, false, (s) => logs.push(s)), null);
    assert.match(logs[0], /the seat was never created: (until|since) 2026-12-16T00:00:00Z .*this arm creates it/);
    assert(logs.some((l) => /simulation as .*: accepted by the program \(9150 compute units\)/.test(l)), logs.join(" | "));
    // a refusal (a stranger before the date: OnlyKeeper) is reported in the dry run and refused with --yes, nothing sent
    w.c.simRefuse = "OnlyKeeper";
    const dry: string[] = [];
    await armKeeperCli(w.c.connection(), w.p, w.keeper, 20, false, (s) => dry.push(s));
    assert(dry.some((l) => /REFUSED: refused in simulation \(nothing was sent\).*OnlyKeeper/.test(l)), dry.join(" | "));
    await assert.rejects(armKeeperCli(w.c.connection(), w.p, w.keeper, 20, true, () => undefined), /^Error: keeper-arm: refused in simulation \(nothing was sent\).*OnlyKeeper/);
    assert.deepStrictEqual(w.c.names(), []);
    // keeper-take on a seat that was never created: it says how the seat is created instead
    await assert.rejects(takeKeeperCli(w.c.connection(), w.p, w.keeper, 20, true, () => undefined), /no keeper seat to take: the seat was never created: .*\(npm run keeper-arm -- --deposit 20\)/);
  });

  // ── r9 fix-up (c): keeper_withdraw (with its notice toggle), propose_keeper, rotate_hot, resign_seat ──────────────
  const upgradedWorld = () => {
    const w = world();
    putProgram(w.c, 90_000_000);
    w.c.put(PDA_V3.extraState(), programId, enc(w.p, "ExtraState", { bump: 255, vaultBump: 255 }));
    w.c.put(PDA_V3.oracleSeat(), programId, enc(w.p, "OracleSeat", { generation: BN(1), bump: 255 }));
    w.c.cuPerIx = 7_000;
    return w;
  };
  const wallNow = () => Math.floor(Date.now() / 1000); // the CLIs read X1's clock, else the machine's (the fake has no block time)

  await test("keeper-withdraw: the notice toggle is named (start / cancel, never the other by accident); an amount after 7 days, nothing pending, 0 or >= 20 XNT left", async () => {
    const k = Keypair.generate().publicKey;
    const s = { keeper: k, bond: 30n * XNT, withdrawTs: 0, pendingBets: 0 };
    const t0 = 1_800_000_000;
    assert.deepStrictEqual(keeperWithdrawDecisionV3(s, k, { notice: "start" }, t0).ok, true);
    assert.match(keeperWithdrawDecisionV3({ ...s, withdrawTs: t0 - 10 }, k, { notice: "start" }, t0).reason, /already runs .*would CANCEL it/);
    assert.match(keeperWithdrawDecisionV3(s, k, { notice: "cancel" }, t0).reason, /no withdrawal notice runs .*would START one/);
    assert.strictEqual(keeperWithdrawDecisionV3({ ...s, withdrawTs: t0 - 10 }, k, { notice: "cancel" }, t0).ok, true);
    assert.match(keeperWithdrawDecisionV3(s, Keypair.generate().publicKey, { notice: "start" }, t0).reason, /OnlyKeeper/);
    const due = { ...s, withdrawTs: t0 - KEEPER_NOTICE };
    assert.deepStrictEqual(keeperWithdrawDecisionV3(due, k, { amount: 10n * XNT }, t0).amount, 10n * XNT);
    assert.strictEqual(keeperWithdrawDecisionV3(due, k, { amount: 30n * XNT }, t0).ok, true, "the whole bond");
    assert.match(keeperWithdrawDecisionV3(due, k, { amount: 15n * XNT }, t0).reason, /KeeperBondTooSmall/, "15 XNT would stay: under 20");
    assert.match(keeperWithdrawDecisionV3(due, k, { amount: 31n * XNT }, t0).reason, /less than/);
    assert.match(keeperWithdrawDecisionV3(s, k, { amount: XNT }, t0).reason, /no withdrawal notice runs.*KeeperNotice/);
    assert.match(keeperWithdrawDecisionV3({ ...s, withdrawTs: t0 - KEEPER_NOTICE + 1 }, k, { amount: 10n * XNT }, t0).reason, /runs until .*KeeperNotice/);
    assert.match(keeperWithdrawDecisionV3({ ...due, pendingBets: 2 }, k, { amount: 10n * XNT }, t0).reason, /KeeperBusy/);
    assert.match(keeperWithdrawDecisionV3(due, k, { amount: 0n }, t0).reason, /more than 0/);
    // the CLI: dry by default (simulated), sends keeper_withdraw with the HouseKeeperOnly accounts and a measured limit
    const w = upgradedWorld();
    putSeat(w, { bond: BN(30n * XNT), withdrawTs: BN(wallNow() - KEEPER_NOTICE - 60) });
    const logs: string[] = [];
    assert.strictEqual(await keeperWithdrawCli(w.c.connection(), w.p, w.keeper, { amount: 10n * XNT }, false, (s) => logs.push(s)), null);
    assert(logs.some((l) => /accepted by the program \(7150 compute units\)/.test(l)) && logs.some((l) => /dry: nothing signed/.test(l)), logs.join(" | "));
    assert.deepStrictEqual(w.c.names(), []);
    await keeperWithdrawCli(w.c.connection(), w.p, w.keeper, { amount: 10n * XNT }, true, () => undefined);
    assert.deepStrictEqual(w.c.names(), ["keeperWithdraw"]);
    assert.strictEqual(w.c.sent[0].data.amount.toString(), (10n * XNT).toString());
    assert.deepStrictEqual(w.c.sent[0].keys.map((k) => k.pubkey.toBase58()), [PDA.config(), PDA_V3.houseKeeper(), w.keeper.publicKey, PDA.bankrollVault(), PDA.rewardVault(), SystemProgram.programId].map((k) => k.toBase58()));
    assert.deepStrictEqual(w.c.cuLimits, [cuLimitForV3(7_150)]);
    // the seat read still shows its running notice: "start" would cancel it and is refused; "cancel" sends amount 0
    await assert.rejects(keeperWithdrawCli(w.c.connection(), w.p, w.keeper, { notice: "start" }, true, () => undefined), /refused: .*would CANCEL it/);
    await keeperWithdrawCli(w.c.connection(), w.p, w.keeper, { notice: "cancel" }, true, () => undefined);
    assert.deepStrictEqual(w.c.names(), ["keeperWithdraw", "keeperWithdraw"]);
    assert.strictEqual(w.c.sent[1].data.amount.toString(), "0", "the toggle: amount 0");
  });

  await test("propose-keeper names a successor (or none) and keeper-take then works for it after the notice; only the keeper may", async () => {
    const w = upgradedWorld();
    putSeat(w, {});
    const next = Keypair.generate().publicKey;
    const logs: string[] = [];
    await proposeKeeperCli(w.c.connection(), w.p, w.keeper, next.toBase58(), true, (s) => logs.push(s));
    assert.deepStrictEqual(w.c.names(), ["proposeKeeper"]);
    assert.strictEqual((w.c.sent[0].data.newKeeper as PublicKey).toBase58(), next.toBase58());
    assert(logs.some((l) => /names .* who may take the seat with keeper-take from/.test(l)), logs.join(" | "));
    await proposeKeeperCli(w.c.connection(), w.p, w.keeper, "none", true, () => undefined);
    assert.strictEqual((w.c.sent[1].data.newKeeper as PublicKey).toBase58(), PublicKey.default.toBase58(), "none cancels");
    await assert.rejects(proposeKeeperCli(w.c.connection(), w.p, Keypair.generate(), next.toBase58(), true, () => undefined), /OnlyKeeper/);
    await assert.rejects(proposeKeeperCli(w.c.connection(), w.p, w.keeper, w.keeper.publicKey.toBase58(), true, () => undefined), /another key/);
  });

  await test("rotate-hot and resign-seat: the cold key's operations, mirrored, simulated as the cold key (or --as), sent only with --yes", async () => {
    const cold = Keypair.generate();
    const arch = Keypair.generate().publicKey.toBase58();
    const ck = cold.publicKey.toBase58();
    const hot = Keypair.generate().publicKey.toBase58();
    assert.strictEqual(rotateHotErrorV3({ cold: ck, actor: ck, newHot: hot, architect: arch }), null);
    assert.strictEqual(rotateHotErrorV3({ cold: ck, actor: null, newHot: hot, architect: arch }), null, "a plan without a key");
    assert.match(String(rotateHotErrorV3({ cold: ck, actor: hot, newHot: hot, architect: arch })), /OnlyCold/);
    assert.match(String(rotateHotErrorV3({ cold: PublicKey.default.toBase58(), actor: ck, newHot: hot, architect: arch })), /no cold key/);
    for (const bad of [PublicKey.default.toBase58(), ck, arch]) assert.match(String(rotateHotErrorV3({ cold: ck, actor: ck, newHot: bad, architect: arch })), /InvalidTarget/);
    // resign: an open seat never; a seat that served since max(now − 28 d, taken_at): yes, with the walk pairs
    const t = 1_800_000_000;
    const pairs = new Map<number, PairViewV3>([[5, { id: 5, publishedAt: t - DAY, closed: false, extra: null }], [4, { id: 4, publishedAt: t - 8 * DAY, closed: false, extra: null }]]);
    assert.deepStrictEqual(resignDecisionV3({ takenAt: t - 60 * DAY, openSince: 0 }, 5, (id) => pairs.get(id) ?? null, t), { ok: true, reason: resignDecisionV3({ takenAt: t - 60 * DAY, openSince: 0 }, 5, (id) => pairs.get(id) ?? null, t).reason, walkIds: [5, 4] }, "5 is still in its hold, 4 survived");
    assert.match(resignDecisionV3({ takenAt: t - 60 * DAY, openSince: t - 1 }, 5, (id) => pairs.get(id) ?? null, t).reason, /SeatOpen/);
    assert.match(resignDecisionV3({ takenAt: t - 60 * DAY, openSince: 0 }, 5, (id) => ({ id, publishedAt: t - 40 * DAY, closed: false, extra: null }), t).reason, /SeatDead/);
    assert.match(resignDecisionV3({ takenAt: t - 60 * DAY, openSince: 0 }, 5, () => null, t).reason, /could not be read/);
    // the CLIs on the fake chain
    const w = upgradedWorld();
    const now = wallNow();
    const refund = Keypair.generate().publicKey;
    w.c.put(PDA.config(), programId, enc(w.p, "Config", { version: 2, architect: new PublicKey(arch), oracle: w.oracle, pendingOracle: Keypair.generate().publicKey, lastEpoch: BN(3), jackpotRound: BN(5), drawRound: BN(3) }));
    w.c.put(PDA_V3.oracleSeat(), programId, enc(w.p, "OracleSeat", { generation: BN(2), cold: cold.publicKey, refund, bond: BN(XNT), takenAt: BN(now - 60 * DAY), bump: 255 }));
    w.c.put(PDA.epoch(3), programId, enc(w.p, "Epoch", { id: BN(3), publishedAt: BN(now - 5 * DAY), expiresAt: BN(now + 80 * DAY), bump: 255 }));
    const logs: string[] = [];
    assert.strictEqual(await rotateHotCli(w.c.connection(), w.p, null, { yes: false, as: ck, newHot: hot, log: (s) => logs.push(s) }), null, "--as: simulated, nothing sent");
    assert(logs.some((l) => /the pending hand-over to .* is wiped/.test(l)) && logs.some((l) => /simulation as .*accepted/.test(l)), logs.join(" | "));
    await assert.rejects(rotateHotCli(w.c.connection(), w.p, null, { yes: true, newHot: hot }), /--yes needs COLD_PRIVATE_KEY/);
    await assert.rejects(rotateHotCli(w.c.connection(), w.p, Keypair.generate(), { yes: true, newHot: hot }), /OnlyCold/);
    await rotateHotCli(w.c.connection(), w.p, cold, { yes: true, newHot: hot, log: () => undefined });
    assert.deepStrictEqual(w.c.names(), ["rotateHot"]);
    assert.deepStrictEqual(w.c.sent[0].keys.map((k) => [k.pubkey.toBase58(), k.isWritable, k.isSigner]), [[PDA.config().toBase58(), true, false], [PDA_V3.oracleSeat().toBase58(), false, false], [ck, false, true]]);
    const rl: string[] = [];
    await resignSeatCli(w.c.connection(), w.p, cold, { yes: true, successor: "none", log: (s) => rl.push(s) });
    assert.deepStrictEqual(w.c.names(), ["rotateHot", "resignSeat"], rl.join(" | "));
    const r = w.c.sent[1];
    assert.strictEqual((r.data.successor as PublicKey).toBase58(), PublicKey.default.toBase58());
    assert.deepStrictEqual(r.keys.map((k) => k.pubkey.toBase58()), [PDA.config(), PDA_V3.oracleSeat(), PDA.rewardVault(), refund, cold.publicKey, PDA.epoch(3), PDA_V3.extraEpoch(3)].map((k) => k.toBase58()), "the refund key, then the walk pair");
    assert.deepStrictEqual(w.c.cuLimits, [cuLimitForV3(7_150), cuLimitForV3(7_150)]);
    // a seat that has not served cannot resign: refused before anything is simulated
    w.c.put(PDA.epoch(3), programId, enc(w.p, "Epoch", { id: BN(3), publishedAt: BN(now - DAY), expiresAt: BN(now + 80 * DAY), bump: 255 }));
    w.c.put(PDA.epoch(2), programId, enc(w.p, "Epoch", { id: BN(2), publishedAt: BN(now - 40 * DAY), expiresAt: BN(now + 50 * DAY), bump: 255 }));
    await assert.rejects(resignSeatCli(w.c.connection(), w.p, cold, { yes: true, successor: "none", log: () => undefined }), /SeatDead/);
  });

  void SystemProgram;
  void TransactionInstruction;
  console.log(`keeper v3 tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
