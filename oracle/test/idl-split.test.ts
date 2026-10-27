/**
 * IDL split and the W2-4 upgraded-binary guard, no network:
 *   - src/idl/moon_forge.json is the LIVE program's IDL (main's copy, ae8c18d) and the v2 client (x1.ts connect /
 *     programV2) is built from it; the v3 client (x1-v3.ts connectV3 / programV3) from moon_forge.v3.json;
 *   - every instruction the v2 path calls (x1.ts and the v2 lines of index.ts) has exactly the arguments and account list
 *     of the DEPLOYED program (frozen below from the on-chain IDL account CCt3yKzEbfZ1tV9cBVqsryGGSXGojMCtJZhYKHRfxszP,
 *     read 2026-10-23; refresh_collection_uri from ae8c18d, it is not in the deployed binary yet);
 *   - draw_jackpot sent by the v2 keeper (keeperPass) carries exactly the live account list (the v3 IDL would add
 *     keeper_seat, which the live binary does not take);
 *   - a v3 publication (base or extra) refuses unless the live binary is the upgraded one, and goes through when it is.
 *   npm test
 */
import assert from "assert";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { connect, keeperPass, LIVE_IDL, PDA, programId, programV2 } from "../src/x1";
import {
  assertUpgradedV3, BPF_LOADER_UPGRADEABLE, connectV3, EXTRA_STATE_SIZE, isV3Program, LIVE_DEPLOY_SLOT, markWritable, ORACLE_SEAT_SIZE, PDA_V3, programV3, publishEpochV3,
  ExtraNotYetV3, publishExtraEpochV3, publishRulesErrorV3, readUpgradeProbeV3, upgradeVerdictV3, UpgradeProbeV3, UPGRADED_ELF, V3_IDL,
} from "../src/x1-v3";
import { EMPTY_ROOT, ExtraFileV1 } from "../src/extra";
import { DEFAULT_RULES_V3, MAX_PUBLISH_LAG, MIN_WINDOW } from "../src/rewards";

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

const IDL_DIR = path.join(__dirname, "..", "src", "idl");
const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(IDL_DIR, f), "utf8"));
const lfSha = (f: string) => createHash("sha256").update(fs.readFileSync(path.join(IDL_DIR, f), "utf8").replace(/\r\n/g, "\n")).digest("hex");
/**
 * git blob ae8c18d:oracle/src/idl/moon_forge.json (= HEAD, = the release copy with LF line ends). The comparison with a
 * local copy of the release tree is optional: set LIVE_IDL_RELEASE_COPY to that copy's oracle/src/idl/moon_forge.json; it
 * is skipped when unset, so no local path is named in the repository.
 */
const LIVE_IDL_SHA256 = "274f534a0b353ede826045a47ed783ecd4f827563b1bf3ea39dd8444f6a5007e";
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * The deployed program's definition of every instruction the v2 path calls: [IDL name, discriminator, args, accounts]
 * (w = writable, s = signer), frozen from the on-chain IDL account. A new v2 call fails the test until it is added here
 * from the live IDL; a changed live IDL fails it too.
 */
const LIVE_V2: Record<string, [string, string, string, string]> = {
  acceptOracle: ["accept_oracle", "5ecd0591c7504e5f", "", "config(w) signer(s)"],
  claimDrop: ["claim_drop", "9d1d590e51cb6b3a", "epoch_id:u64,tier:u8,serial:u32,score:u64,proof:{vec:{array:[u8,32]}}", "config(w) epoch(w) receipt(w) player asset(w) record(w) collection(w) artifact_authority reward_vault(w) payer(w)(s) core_program system_program"],
  claimDropXnt: ["claim_drop_xnt", "1ea147c3bd86321c", "epoch_id:u64,tier:u8,score:u64,proof:{vec:{array:[u8,32]}}", "config(w) epoch(w) receipt(w) player(w) player_state(w) reward_vault(w) payer(w)(s) system_program"],
  claimInstant: ["claim_instant", "c1a755efd59364b0", "epoch_id:u64,tier:u8,score:u64,proof:{vec:{array:[u8,32]}}", "config(w) epoch(w) receipt(w) player(w) player_state(w) reward_vault(w) payer(w)(s) system_program"],
  claimMission: ["claim_mission", "ed2f01c66986c994", "epoch_id:u64,tier:u8,score:u64,proof:{vec:{array:[u8,32]}}", "config(w) epoch(w) receipt(w) mission(w) player player_state(w) reward_vault(w) payer(w)(s) system_program"],
  claimPrediction: ["claim_prediction", "8e649f7b1fb70071", "", "config(w) round(w) entry(w) player_state(w) rent_payer(w)"],
  claimWarTimeout: ["claim_war_timeout", "8dd1d705ccc576b3", "", "war(w)"],
  closeJackpotEntry: ["close_jackpot_entry", "1abaa004a096c23f", "", "round(w) player_state(w) entry(w) rent_payer(w)"],
  closePredictionRound: ["close_prediction_round", "c0aa6589af0be45c", "", "config round(w) reward_vault(w) rent_payer(w)"],
  drawDraw: ["draw_draw", "f202c9480b7f6ec4", "", "config(w) round(w)"],
  drawJackpot: ["draw_jackpot", "41174c9275e8ec88", "", "config(w) round(w) first_player_state(w)"],
  expireEpoch: ["expire_epoch", "3e005d6511d2a940", "", "config(w) epoch(w)"],
  initArtifacts: ["init_artifacts", "9f5adc0681078afe", "", "config collection(w) artifact_authority payer(w)(s) core_program system_program"],
  initializeV2: ["initialize_v2", "4399af27da102620", "", "config(w) reward_vault(w) bankroll_vault(w) draw_vault(w) collection artifact_authority payer(w)(s) system_program"],
  lockPrediction: ["lock_prediction", "3ba3d98162d9a856", "", "round(w) observation"],
  proposeOracle: ["propose_oracle", "5fbcb44907f8e84e", "new_oracle:pubkey", "config(w) signer(s)"],
  publishEpoch: ["publish_epoch", "de06885236f6f578", "epoch_id:u64,root:{array:[u8,32]},data_hash:{array:[u8,32]},total_score:u128,leaves:u32,rate_cap:u64", "config(w) epoch(w) reward_vault oracle(w)(s) system_program"],
  refreshCollectionUri: ["refresh_collection_uri", "bda2678a027bd8ab", "", "config collection(w) artifact_authority payer(w)(s) core_program system_program"], // ae8c18d (not in the deployed binary yet)
  sealDrop: ["seal_drop", "2fe8a655ca9cecac", "", "config(w) epoch(w) slot_hashes"],
  settleBet: ["settle_bet", "7337eab1e3040a43", "", "config(w) bet(w) player_state(w) bankroll_vault(w) slot_hashes rent_payer(w)"],
  settleDraw: ["settle_draw", "af9a4b1e76756bc2", "", "config(w) round(w) entry winner_state(w) draw_vault(w) reward_vault(w) slot_hashes"],
  settleJackpot: ["settle_jackpot", "d481435843f9c7ef", "", "config(w) round(w) entry winner_state(w) reward_vault(w) draw_vault(w) architect(w) slot_hashes"],
  settlePrediction: ["settle_prediction", "c981b19a109b3029", "", "config(w) round(w) observation reward_vault(w) draw_vault(w) architect(w)"],
  settleWar: ["settle_war", "a5cd15f5a473a028", "", "config(w) war(w) creator_state(w) opponent_state(w) reward_vault(w) draw_vault(w) architect(w) rent_payer(w)"],
  startWar: ["start_war", "a8ae6ed4b22a7d95", "", "war(w) slot_hashes"],
  sweepLegacy: ["sweep_legacy", "8ada13c128a685a2", "", "legacy_state(w) legacy_escrow(w) config reward_vault(w)"],
};

type IdlIx = { name: string; discriminator: number[]; args: { name: string; type: unknown }[]; accounts: any[] };
const tyStr = (t: unknown) => (typeof t === "string" ? t : JSON.stringify(t).replace(/"/g, ""));
const flatAccounts = (accs: any[], pre = ""): string[] =>
  accs.flatMap((a) => (a.accounts ? flatAccounts(a.accounts, `${pre}${a.name}.`) : [`${pre}${a.name}${a.writable ? "(w)" : ""}${a.signer ? "(s)" : ""}`]));
const shape = (ix: IdlIx): [string, string, string, string] => [
  ix.name, Buffer.from(ix.discriminator).toString("hex"), ix.args.map((a) => `${a.name}:${tyStr(a.type)}`).join(","), flatAccounts(ix.accounts).join(" "),
];
const byCamel = (idl: { instructions: IdlIx[] }) => new Map(idl.instructions.map((i) => [camel(i.name), i]));

/** the program methods the v2 path calls (x1.ts and index.ts; every v3 call is in x1-v3.ts) */
function v2Methods(): string[] {
  const src = ["x1.ts", "index.ts"].map((f) => fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8")).join("\n");
  return [...new Set([...src.matchAll(/\.methods\s*\.\s*([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1]))].sort();
}

// ── a fake chain: accounts by address, every sent transaction captured, nothing on the network ─────
type FakeAccount = { owner: PublicKey; data: Buffer; lamports: number; executable: boolean };
class FakeChain {
  accounts = new Map<string, FakeAccount>();
  sent: TransactionInstruction[][] = [];
  rpcError: string | null = null;
  /** getBlockTime's answer (null: the node has none) */
  blockTime: number | null = null;
  put(pk: PublicKey, owner: PublicKey, data: Buffer) {
    this.accounts.set(pk.toBase58(), { owner, data, lamports: 1_000_000_000, executable: false });
  }
  private get(pk: PublicKey) {
    if (this.rpcError) throw new Error(this.rpcError);
    return this.accounts.get(pk.toBase58()) ?? null;
  }
  connection(): any {
    return {
      commitment: "confirmed",
      getAccountInfo: async (pk: PublicKey, cfg?: { dataSlice?: { offset: number; length: number } }) => {
        const a = this.get(pk);
        if (a && cfg && typeof cfg === "object" && cfg.dataSlice) return { ...a, data: a.data.subarray(cfg.dataSlice.offset, cfg.dataSlice.offset + cfg.dataSlice.length) };
        return a;
      },
      getAccountInfoAndContext: async (pk: PublicKey) => ({ context: { slot: 1_000 }, value: this.get(pk) }),
      getMultipleAccountsInfo: async (pks: PublicKey[]) => pks.map((pk) => this.get(pk)),
      getProgramAccounts: async () => [],
      getSlot: async () => 1_000,
      getBlockTime: async () => this.blockTime,
    };
  }
  provider(payer: Keypair): anchor.Provider {
    return {
      connection: this.connection(),
      publicKey: payer.publicKey,
      wallet: new anchor.Wallet(payer),
      sendAndConfirm: async (tx: Transaction) => {
        this.sent.push(tx.instructions);
        return `sig${this.sent.length}`;
      },
    } as unknown as anchor.Provider;
  }
}

/** a zero value of any IDL type, with the coder's camelCase field names */
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
async function encodeAccount(program: anchor.Program, name: string, over: Record<string, unknown>): Promise<Buffer> {
  const coderName = ((program.idl as anchor.Idl).accounts ?? []).find((a) => a.name.toLowerCase() === name.toLowerCase())!.name;
  return program.coder.accounts.encode(coderName, { ...zero(program.rawIdl as anchor.Idl, { defined: { name } }), ...over });
}

/** the live chain as it is today (read 2026-10-23): ProgramData at slot 85,429,880, no upgraded-only PDA */
const PROGRAM_DATA = new PublicKey("CXcE1TYM4SGJWcYfdCV8PNu3hcbioGo2z6851qjZeQEs");
function putProgram(c: FakeChain, deploySlot: number) {
  const prog = Buffer.alloc(36);
  prog.writeUInt32LE(2, 0);
  PROGRAM_DATA.toBuffer().copy(prog, 4);
  c.put(programId, BPF_LOADER_UPGRADEABLE, prog);
  const head = Buffer.alloc(45 + 64);
  head.writeUInt32LE(3, 0);
  head.writeBigUInt64LE(BigInt(deploySlot), 4);
  head[12] = 1;
  new PublicKey("7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd").toBuffer().copy(head, 13);
  c.put(PROGRAM_DATA, BPF_LOADER_UPGRADEABLE, head);
}
async function putUpgradedPdas(c: FakeChain, v3: anchor.Program, extra: Record<string, unknown> = {}) {
  c.put(PDA_V3.extraState(), programId, await encodeAccount(v3, "ExtraState", { bump: 255, vaultBump: 255, ...extra }));
  c.put(PDA_V3.oracleSeat(), programId, await encodeAccount(v3, "OracleSeat", { generation: new anchor.BN(1), bump: 255 }));
}

async function main() {
  const live = readJson("moon_forge.json");
  const v3json = readJson("moon_forge.v3.json");

  await test("the live IDL is main's copy (ae8c18d); the v3 IDL is the upgraded program's; both name the same program", () => {
    assert.strictEqual(lfSha("moon_forge.json"), LIVE_IDL_SHA256, "src/idl/moon_forge.json must stay the LIVE IDL until the upgrade is on mainnet");
    const copy = process.env.LIVE_IDL_RELEASE_COPY;
    if (copy) {
      const sha = createHash("sha256").update(fs.readFileSync(copy, "utf8").replace(/\r\n/g, "\n")).digest("hex");
      assert.strictEqual(sha, LIVE_IDL_SHA256, "the release copy named by LIVE_IDL_RELEASE_COPY holds the same live IDL");
    } else console.log("  (LIVE_IDL_RELEASE_COPY not set: the comparison with a local release copy is skipped)");
    assert.strictEqual(live.address, programId.toBase58());
    assert.strictEqual(v3json.address, programId.toBase58());
    assert.strictEqual(live.instructions.length, 59);
    assert.strictEqual(v3json.instructions.length, 92);
    assert(!live.instructions.some((i: IdlIx) => i.name === "publish_extra_epoch" || i.name === "init_extra" || i.name === "arm_keeper"), "no v3 instruction in the live IDL");
    const pe = (v3json.instructions as IdlIx[]).find((i) => i.name === "publish_extra_epoch")!;
    assert.deepStrictEqual(pe.args.map((a) => a.name), ["epoch_id", "root", "data_hash", "total", "leaves", "weeks"]);
    assert.strictEqual(v3json.errors.length, 101);
  });

  await test("freePoolV3 reads the vault and Config in ONE call at one commitment (the e2e found them read apart)", async () => {
    const program = connectV3().program;
    // a real Config account from the v3 coder: reward_reserved 3 XNT
    const zero = (t: any): any => {
      if (t === "pubkey") return PublicKey.default;
      if (typeof t === "string") return t === "bool" ? false : /^(u|i)(64|128)$/.test(t) ? new anchor.BN(0) : 0;
      if (t.array) return Array.from({ length: t.array[1] }, () => zero(t.array[0]));
      if (t.defined) {
        const ty = (V3_IDL.types ?? []).find((x) => x.name === t.defined.name)!;
        return Object.fromEntries(((ty.type as any).fields ?? []).map((f: any) => [f.name.replace(/_([a-z])/g, (_: string, c: string) => c.toUpperCase()), zero(f.type)]));
      }
      if (t.vec) return [];
      if (t.option) return null;
      throw new Error(`type ${JSON.stringify(t)}`);
    };
    const cfg = { ...zero({ defined: { name: "Config" } }), rewardReserved: new anchor.BN(3_000_000_000) };
    const configData = await program.coder.accounts.encode("config", cfg);
    const calls: { keys: string[]; commitment: unknown }[] = [];
    const fake = {
      getMultipleAccountsInfoAndContext: async (keys: PublicKey[], commitment: unknown) => {
        calls.push({ keys: keys.map((k) => k.toBase58()), commitment });
        return { context: { slot: 77 }, value: [{ lamports: 10_000_000_000, data: Buffer.alloc(8), owner: programId }, { lamports: 1, data: configData, owner: programId }] };
      },
      getMinimumBalanceForRentExemption: async (n: number) => (n === 8 ? 946_560 : 0),
      getAccountInfo: async () => assert.fail("no separate vault read"),
      getAccountInfoAndContext: async () => assert.fail("no separate vault read"),
    } as never;
    const { freePoolV3 } = await import("../src/x1-v3");
    const p = await freePoolV3(fake, program);
    assert.deepStrictEqual(p, { lamports: (10_000_000_000 - 946_560 - 3_000_000_000).toString(), slot: 77 });
    assert.deepStrictEqual(calls, [{ keys: [PDA.rewardVault().toBase58(), PDA.config().toBase58()], commitment: "finalized" }]);
    await freePoolV3(fake, program, "confirmed");
    assert.strictEqual(calls[1].commitment, "confirmed", "the publish gate's live re-check");
  });

  await test("x1.ts builds the v2 client from the live IDL, x1-v3.ts the v3 client from moon_forge.v3.json", () => {
    assert.deepStrictEqual(LIVE_IDL, live);
    assert.deepStrictEqual(connect().program.rawIdl, live, "connect() (every v2 path) uses the live IDL");
    assert.deepStrictEqual(programV2({} as never).rawIdl, live);
    assert.deepStrictEqual(V3_IDL, v3json);
    assert.deepStrictEqual(connectV3().program.rawIdl, v3json, "connectV3() (every v3 / extra path) uses the v3 IDL");
    assert.strictEqual(isV3Program(connect().program), false);
    assert.strictEqual(isV3Program(connectV3().program), true);
  });

  await test("the v2 path calls only instructions whose arguments and account lists equal the deployed program's", () => {
    const used = v2Methods();
    assert.deepStrictEqual(used, Object.keys(LIVE_V2).sort(), "the v2 instruction set (a new v2 call must be added to LIVE_V2 from the live IDL)");
    const L = byCamel(live);
    for (const m of used) assert.deepStrictEqual(shape(L.get(m)!), LIVE_V2[m], `${m}: the live IDL differs from the deployed program`);
    // the program client of the v2 path has exactly those definitions too (the camelCase IDL anchor builds from it)
    const p = connect().program;
    for (const m of used) assert.strictEqual(typeof (p.methods as any)[m], "function", `${m} is a method of the v2 client`);
    // and why the split matters: on the v2 path, only draw_jackpot changes in the upgraded IDL (keeper_seat)
    const V = byCamel(v3json);
    const differs = used.filter((m) => { const a = shape(L.get(m)!), b = V.get(m) ? shape(V.get(m)!) : null; return !b || a.join("|") !== b.join("|"); });
    assert.deepStrictEqual(differs, ["drawJackpot"]);
    assert.strictEqual(shape(V.get("drawJackpot")!)[3], "config(w) round(w) first_player_state(w) keeper_seat(w)");
  });

  await test("draw_jackpot from the v2 keeper sends exactly the live account list (config, round, first_player_state)", async () => {
    const payer = Keypair.generate();
    const firstPlayer = Keypair.generate().publicKey;
    const run = async (make: (p: anchor.Provider) => anchor.Program) => {
      const c = new FakeChain();
      const program = make(c.provider(payer));
      c.put(PDA.config(), programId, await encodeAccount(program, "Config", { version: 2, jackpotRound: new anchor.BN(1), drawRound: new anchor.BN(1) }));
      c.put(PDA.jackpot(1), programId, await encodeAccount(program, "JackpotRound", {
        id: new anchor.BN(1), total: new anchor.BN(50_000_000), entries: 1, firstPlayer, endTs: new anchor.BN(Math.floor(Date.now() / 1000) - 60), state: 0,
      }));
      const lines: string[] = [];
      await keeperPass(c.connection(), program, payer, (s) => lines.push(s), []);
      return { sent: c.sent, lines };
    };
    const v2 = await run(programV2);
    assert.strictEqual(v2.sent.length, 1, `exactly one transaction (the draw); log: ${v2.lines.join(" | ")}`);
    assert.strictEqual(v2.sent[0].length, 1);
    const ix = v2.sent[0][0];
    assert(ix.programId.equals(programId));
    assert.strictEqual(ix.data.toString("hex"), LIVE_V2.drawJackpot[1], "draw_jackpot's discriminator, no arguments");
    assert.deepStrictEqual(
      ix.keys.map((k) => [k.pubkey.toBase58(), k.isWritable, k.isSigner]),
      [[PDA.config().toBase58(), true, false], [PDA.jackpot(1).toBase58(), true, false], [PDA.player(firstPlayer).toBase58(), true, false]],
      "the live account list, nothing more",
    );
    // the same keeper code on the v3 client would add keeper_seat, which the live binary does not take: the split is needed
    const v3 = await run(programV3);
    assert.deepStrictEqual(v3.sent[0][0].keys.map((k) => k.pubkey.toBase58()), [PDA.config(), PDA.jackpot(1), PDA.player(firstPlayer), PDA_V3.houseKeeper()].map((k) => k.toBase58()));
  });

  // ── W2-4 ─────────────────────────────────────────────────────────────────────────────────────────
  const v3p = programV3({} as never);
  const probeOf = async (setup: (c: FakeChain) => Promise<void> | void) => {
    const c = new FakeChain();
    await setup(c);
    return readUpgradeProbeV3(c.connection());
  };

  await test("W2-4: the live chain today (deploy slot 85,429,880, no ExtraState / OracleSeat) is 'legacy' and refuses every v3 publication", async () => {
    assert.strictEqual(LIVE_DEPLOY_SLOT, 85_429_880);
    const p = await probeOf((c) => putProgram(c, LIVE_DEPLOY_SLOT));
    assert.deepStrictEqual([p.deploySlot, p.extraState, p.oracleSeat, p.houseKeeper], [LIVE_DEPLOY_SLOT, null, null, null]);
    const v = upgradeVerdictV3(p, v3p);
    assert.strictEqual(v.status, "legacy");
    assert.strictEqual(v.reasons.length, 3, v.reasons.join("; "));
    assert.match(v.reasons.join("; "), /last-deploy slot 85429880 is not after 85429880.*ExtraState.*does not exist.*OracleSeat.*does not exist/);
    const c = new FakeChain();
    putProgram(c, LIVE_DEPLOY_SLOT);
    await assert.rejects(assertUpgradedV3(c.connection(), v3p, "to publish v3 epoch 2"), /refusing to publish v3 epoch 2: the live program is not the upgraded binary \(legacy: .*\(W2-4\)/);
  });

  await test("W2-4: the upgraded binary (deploy slot after 85,429,880, ExtraState and OracleSeat present and decoding) is 'upgraded'", async () => {
    assert.deepStrictEqual([EXTRA_STATE_SIZE, ORACLE_SEAT_SIZE], [v3p.coder.accounts.size("extraState"), v3p.coder.accounts.size("oracleSeat")], "the sizes are the IDL layouts");
    const p = await probeOf(async (c) => {
      putProgram(c, 90_000_000);
      await putUpgradedPdas(c, v3p);
    });
    assert.deepStrictEqual(upgradeVerdictV3(p, v3p), { status: "upgraded", reasons: [], deploySlot: 90_000_000 });
    const c = new FakeChain();
    putProgram(c, 90_000_000);
    await putUpgradedPdas(c, v3p);
    assert.strictEqual((await assertUpgradedV3(c.connection(), v3p, "x")).status, "upgraded");
  });

  await test("W2-4: anything in between fails closed ('unknown'): a half-done upgrade, a foreign or malformed PDA, an RPC error, a v2 client", async () => {
    const cases: [string, (c: FakeChain) => Promise<void> | void, RegExp][] = [
      ["new binary, init_extra / init_seat not run", (c) => putProgram(c, 90_000_000), /ExtraState.*does not exist/],
      ["new binary, no OracleSeat", async (c) => { putProgram(c, 90_000_000); c.put(PDA_V3.extraState(), programId, await encodeAccount(v3p, "ExtraState", { bump: 255 })); }, /OracleSeat.*does not exist/],
      ["PDAs present but the deploy slot is the live one", async (c) => { putProgram(c, LIVE_DEPLOY_SLOT); await putUpgradedPdas(c, v3p); }, /not after 85429880/],
      ["ExtraState owned by another program", async (c) => { putProgram(c, 90_000_000); await putUpgradedPdas(c, v3p); c.put(PDA_V3.extraState(), SystemProgram.programId, await encodeAccount(v3p, "ExtraState", { bump: 255 })); }, /owned by 1111/],
      ["ExtraState of the wrong size", async (c) => { putProgram(c, 90_000_000); await putUpgradedPdas(c, v3p); c.put(PDA_V3.extraState(), programId, Buffer.alloc(EXTRA_STATE_SIZE + 8)); }, /98 bytes, not 90/],
      ["ExtraState with another discriminator", async (c) => { putProgram(c, 90_000_000); await putUpgradedPdas(c, v3p); c.put(PDA_V3.extraState(), programId, Buffer.alloc(EXTRA_STATE_SIZE)); }, /does not decode/],
      ["ExtraState with a non-canonical bump", async (c) => { putProgram(c, 90_000_000); await putUpgradedPdas(c, v3p, { bump: 254 }); }, /bump 254 is not the PDA's/],
      ["the program account is not an upgradeable program", (c) => c.put(programId, SystemProgram.programId, Buffer.alloc(36)), /not an upgradeable-loader Program account/],
      ["no program account", () => undefined, /program account .* is missing/],
    ];
    for (const [what, setup, why] of cases) {
      const v = upgradeVerdictV3(await probeOf(setup), v3p);
      assert.strictEqual(v.status, "unknown", what);
      assert.match(v.reasons.join("; "), why, what);
    }
    // an RPC error refuses (never a pass)
    const c = new FakeChain();
    putProgram(c, 90_000_000);
    await putUpgradedPdas(c, v3p);
    c.rpcError = "429 Too Many Requests";
    await assert.rejects(assertUpgradedV3(c.connection(), v3p, "to publish v3 epoch 2"), /not the upgraded binary \(unknown: RPC error: 429 Too Many Requests\)/);
    // the v2 client can never pass: it has no ExtraState / OracleSeat account
    c.rpcError = null;
    const v = upgradeVerdictV3(await readUpgradeProbeV3(c.connection()), programV2({} as never));
    assert.strictEqual(v.status, "unknown");
    assert.match(v.reasons.join("; "), /the client's IDL has no ExtraState account/);
  });

  const oracle = Keypair.generate();
  const T = 1_792_000_000;
  const v3Base = {
    version: 3, epoch: 2, root: "11".repeat(32), dataHash: "22".repeat(32), totalScore: "1000", rateCap: "5000", leaves: [{ player: Keypair.generate().publicKey.toBase58(), tier: 0, score: "1000" }],
    proofs: {}, window: { startTs: T, endTs: T + MIN_WINDOW + 3_600 }, rulesBlock: DEFAULT_RULES_V3,
  };
  const chainWith = async (deploySlot: number, upgraded: boolean) => {
    const c = new FakeChain();
    putProgram(c, deploySlot);
    if (upgraded) await putUpgradedPdas(c, v3p);
    return c;
  };

  await test("W2-4: publishEpochV3 sends nothing on the live binary and publish_epoch (live ABI, 108 bytes; D-47: the reward vault writable) on the upgraded one", async () => {
    const legacy = await chainWith(LIVE_DEPLOY_SLOT, false);
    await assert.rejects(publishEpochV3(programV3(legacy.provider(oracle)), oracle, v3Base), /refusing to publish v3 epoch 2: the live program is not the upgraded binary \(legacy/);
    assert.strictEqual(legacy.sent.length, 0, "nothing sent");
    // a v2 client is refused before any read
    await assert.rejects(publishEpochV3(programV2(legacy.provider(oracle)), oracle, v3Base), /not built from moon_forge\.v3\.json/);
    const up = await chainWith(90_000_000, true);
    // CF-22: X1's clock is read right before sending; an unreadable clock or a build older than MAX_PUBLISH_LAG sends nothing
    up.blockTime = null;
    await assert.rejects(publishEpochV3(programV3(up.provider(oracle)), oracle, v3Base), /X1 clock .* could not be read.*fail closed.*CF-22/);
    up.blockTime = v3Base.window.endTs + MAX_PUBLISH_LAG + 1;
    await assert.rejects(publishEpochV3(programV3(up.provider(oracle)), oracle, v3Base), /more than MAX_PUBLISH_LAG 21600 s, so it is never published/);
    up.blockTime = v3Base.window.endTs - 3 * 3_600;
    await assert.rejects(publishEpochV3(programV3(up.provider(oracle)), oracle, v3Base), /before the build's snapshot/);
    assert.strictEqual(up.sent.length, 0, "nothing sent on a stale build or an unknown clock");
    // T2-RULES: no rules block, or a program hash that is not the pin, is refused before any read
    const { rulesBlock: _r, ...noRules } = v3Base;
    await assert.rejects(publishEpochV3(programV3(up.provider(oracle)), oracle, noRules), /without a rules block is never published/);
    await assert.rejects(publishEpochV3(programV3(up.provider(oracle)), oracle, { ...v3Base, rulesBlock: { ...DEFAULT_RULES_V3, programHash: "ab".repeat(32) } } as never), /not the pinned S2 binary null/);
    assert.strictEqual(publishRulesErrorV3({ rulesBlock: { programHash: "ab".repeat(32) } }, { sha256: "ab".repeat(32), bytes: 1 }), null, "with a pin, its hash");
    assert.match(String(publishRulesErrorV3({ rulesBlock: { programHash: null } }, { sha256: "ab".repeat(32), bytes: 1 })), /not the pinned S2 binary/);
    up.blockTime = v3Base.window.endTs + MAX_PUBLISH_LAG;
    assert.strictEqual(await publishEpochV3(programV3(up.provider(oracle)), oracle, v3Base), "sig1");
    assert.strictEqual(up.sent.length, 1);
    const ix = up.sent[0][0];
    assert.strictEqual(ix.data.length, 108, "the publish_epoch ABI is unchanged");
    assert.strictEqual(ix.data.subarray(0, 8).toString("hex"), LIVE_V2.publishEpoch[1]);
    assert.deepStrictEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isWritable, k.isSigner]), [
      [PDA.config().toBase58(), true, false], [PDA.epoch(2).toBase58(), true, false], [PDA.rewardVault().toBase58(), true, false],
      [oracle.publicKey.toBase58(), true, true], [SystemProgram.programId.toBase58(), false, false],
    ]);
    // D-47: the v3 IDL keeps the live account list (vault read-only, so an old client still publishes, with no allowance);
    // publishEpochV3 alone marks the vault writable, and refuses an instruction without it
    const idlVault = (V3_IDL as any).instructions.find((i: any) => i.name === "publish_epoch").accounts.find((a: any) => a.name === "reward_vault");
    assert.ok(idlVault && !idlVault.writable, "the IDL lists the reward vault read-only");
    assert.throws(() => markWritable(new TransactionInstruction({ programId, keys: [], data: Buffer.alloc(0) }), PDA.rewardVault()), /is not in the instruction/);
    // the file guards still run first (a provisional file never reaches the probe)
    await assert.rejects(publishEpochV3(programV3(up.provider(oracle)), oracle, { ...v3Base, provisional: { reason: "dry" } } as never), /a provisional dry-run file/);
    assert.strictEqual(up.sent.length, 1);
  });

  await test("W2-4: publishExtraEpochV3 sends nothing on the live binary; on the upgraded one it preflights the program's checks, then sends 93 bytes", async () => {
    const extra = (o: Partial<{ epoch: number; budget: string; leaves: number; weeks: number }>): ExtraFileV1 => {
      const n = o.leaves ?? 1;
      return {
        epoch: o.epoch ?? 2, root: n ? "33".repeat(32) : EMPTY_ROOT, dataHash: "44".repeat(32), totals: { budget: o.budget ?? "8000000000" },
        leaves: Array.from({ length: n }, (_, i) => ({ index: i, wallet: Keypair.generate().publicKey.toBase58(), amount: "1" })), window: { weeks: o.weeks ?? 2 },
      } as unknown as ExtraFileV1;
    };
    const legacy = await chainWith(LIVE_DEPLOY_SLOT, false);
    await assert.rejects(publishExtraEpochV3(programV3(legacy.provider(oracle)), oracle, extra({})), /refusing to publish extra epoch 2: the live program is not the upgraded binary \(legacy/);
    assert.strictEqual(legacy.sent.length, 0);
    // upgraded: ExtraState (pot 1,000 XNT, backing 100 XNT, last epoch 1), Config.last_epoch 2, Epoch(1) and Epoch(2) 14 days apart
    const XNT = 1_000_000_000;
    const up = await chainWith(90_000_000, false);
    const p = programV3(up.provider(oracle));
    up.put(PDA_V3.extraState(), programId, await encodeAccount(p, "ExtraState", {
      bump: 255, vaultBump: 255, lastEpoch: new anchor.BN(1), accounted: new anchor.BN(1_000 * XNT), liveForgedBacking: new anchor.BN(100 * XNT),
    }));
    up.put(PDA_V3.oracleSeat(), programId, await encodeAccount(p, "OracleSeat", { generation: new anchor.BN(1), bump: 255 }));
    up.put(PDA.config(), programId, await encodeAccount(p, "Config", { version: 2, lastEpoch: new anchor.BN(2) }));
    up.put(PDA.epoch(1), programId, await encodeAccount(p, "Epoch", { id: new anchor.BN(1), publishedAt: new anchor.BN(T) }));
    up.put(PDA.epoch(2), programId, await encodeAccount(p, "Epoch", { id: new anchor.BN(2), publishedAt: new anchor.BN(T + 14 * 86_400) }));
    // the program would refuse these: the preflight says why and nothing is sent
    await assert.rejects(publishExtraEpochV3(p, oracle, extra({ weeks: 1 })), /would refuse it \(ExtraBudgetExceeded; weeks 1, chain max 2, total 8000000000, bound 4000000000\)/);
    await assert.rejects(publishExtraEpochV3(p, oracle, extra({ weeks: 3 })), /would refuse it \(BadEpochWindow; weeks 3, chain max 2/);
    await assert.rejects(publishExtraEpochV3(p, oracle, extra({ budget: "8000000001" })), /ExtraBudgetExceeded/);
    await assert.rejects(publishExtraEpochV3(p, oracle, extra({ epoch: 3 })), /Epoch\(3\) does not exist/);
    await assert.rejects(publishExtraEpochV3(p, oracle, extra({ weeks: 14 })), /weeks 14 is outside 1\.\.=13/);
    assert.strictEqual(up.sent.length, 0);
    // R-2: the 6-day interval at the chain's time, from the BASE publication of the last paying extra: a soft not-yet
    const xAt = async (last: number) => up.put(PDA_V3.extraState(), programId, await encodeAccount(p, "ExtraState", {
      bump: 255, vaultBump: 255, lastEpoch: new anchor.BN(1), lastPublishTs: new anchor.BN(last), accounted: new anchor.BN(1_000 * XNT), liveForgedBacking: new anchor.BN(100 * XNT),
    }));
    up.blockTime = T + 14 * 86_400 + 300;
    await xAt(T + 8 * 86_400 + 301);
    await assert.rejects(publishExtraEpochV3(p, oracle, extra({})), (e: unknown) => e instanceof ExtraNotYetV3 && e.from === T + 14 * 86_400 + 301 && /not due yet/.test(e.message));
    assert.strictEqual(up.sent.length, 0, "nothing sent");
    await xAt(T); // the previous paying extra's base (epoch 1) was published 14 days ago
    // the W2-3 file (two weeks, 8 XNT) goes through
    assert.strictEqual(await publishExtraEpochV3(p, oracle, extra({})), "sig1");
    const ix = up.sent[0][0];
    assert.strictEqual(ix.data.length, 93);
    assert.strictEqual(ix.data.subarray(0, 8).toString("hex"), "58472b582480adff");
    assert.strictEqual(ix.data[92], 2, "weeks, the last byte");
    assert.deepStrictEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isWritable, k.isSigner]), [
      [PDA.config().toBase58(), false, false], [PDA_V3.extraState().toBase58(), true, false], [PDA_V3.extraEpoch(2).toBase58(), true, false],
      [PDA.epoch(2).toBase58(), false, false], [PDA.epoch(1).toBase58(), false, false], [oracle.publicKey.toBase58(), true, true], [SystemProgram.programId.toBase58(), false, false],
    ]);
  });

  await test("R-7: with the S2 build pinned, a redeploy of another ELF (a rollback) is 'unknown', never 'upgraded'; the ELF is read once per deploy slot", async () => {
    const elf = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7 + 3) & 0xff));
    const pin = { sha256: createHash("sha256").update(elf).digest("hex"), bytes: elf.length };
    const withElf = async (deploySlot: number, body: Buffer) => {
      const c = await chainWith(deploySlot, true);
      const head = Buffer.from(c.accounts.get(PROGRAM_DATA.toBase58())!.data.subarray(0, 45));
      c.put(PROGRAM_DATA, BPF_LOADER_UPGRADEABLE, Buffer.concat([head, body, Buffer.alloc(64)]));
      return c;
    };
    const verdictOf = async (c: FakeChain, p: typeof pin | null) => upgradeVerdictV3(await readUpgradeProbeV3(c.connection(), "finalized", p), v3p, p);
    // the pinned build: upgraded
    const good = await withElf(90_000_001, elf);
    assert.strictEqual((await verdictOf(good, pin)).status, "upgraded");
    // a rollback (the old binary, a new deploy slot, the PDAs still there): unknown, fail closed
    const old = Buffer.from(elf);
    old[17] ^= 1;
    const rb = await withElf(90_000_002, old);
    const v = await verdictOf(rb, pin);
    assert.strictEqual(v.status, "unknown");
    assert.match(v.reasons.join(";"), /is not the pinned S2 build .*R-7/);
    // a longer ELF that starts with the pinned bytes: not the pinned length
    const longer = await withElf(90_000_003, Buffer.concat([elf, Buffer.from([9])]));
    assert.match((await verdictOf(longer, pin)).reasons.join(";"), /is not 300 bytes long/);
    // no pin (until S2): the deploy slot and the PDAs decide, as before; the ELF is never read in full
    let full = 0;
    const plain = await withElf(90_000_004, old);
    const conn = plain.connection();
    const gai = conn.getAccountInfo;
    conn.getAccountInfo = async (pk: PublicKey, cfg?: any) => {
      if (pk.equals(PROGRAM_DATA) && !(cfg && cfg.dataSlice)) full++;
      return gai(pk, cfg);
    };
    assert.strictEqual(upgradeVerdictV3(await readUpgradeProbeV3(conn, "finalized", null), v3p, null).status, "upgraded");
    assert.strictEqual(full, 0);
    // cached per deploy slot: a second probe of the same deployment reads the 45-byte header only
    await readUpgradeProbeV3(conn, "finalized", { ...pin, sha256: "00".repeat(32) });
    await readUpgradeProbeV3(conn, "finalized", { ...pin, sha256: "00".repeat(32) });
    assert.strictEqual(full, 1);
    assert.strictEqual(UPGRADED_ELF, null, "pinned only after S2 (the reproducible build of the reviewed commit)");
  });

  console.log(`idl split + upgrade guard tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
