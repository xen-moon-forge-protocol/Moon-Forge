/**
 * r9 fallbacks of the final program, end to end on a validator (driven by tests/run-fallbacks.sh). Both paths are the
 * ones a working localnet never reaches, so this driver builds the broken world they protect against:
 *   1. SlotHashes time fallback (utils.rs age_limited, SLOT_HASH_MAX_AGE = 2,000 slots on localnet). `prepare` leaves an
 *      unanchored house bet and a DRAWING Jackpot round; the script restarts the validator from a snapshot that holds
 *      them, warped past anchor + SLOT_HASH_MAX_AGE. SlotHashes then STILL holds both anchor blocks (the warp keeps the
 *      window), so without the fallback the program would answer Ready: anchor_bet would succeed, the bet could not be
 *      refunded and the round would wait for a keeper reveal forever. `check` proves the program answers Expired.
 *   2. Core-closed hatch (artifacts.rs core_is_closed). Core is loaded as an UPGRADEABLE program with a throwaway
 *      authority; `check` recycles one Artifact while Core is alive (the hatch account changes nothing: the asset is
 *      burned), closes Core with that authority, then recycles a second one without Core: refused for a non-holder,
 *      refused without the ProgramData account (Core cannot run), paid to the holder with it, never twice; a live
 *      asset is still not an orphan.
 * Usage: ts-node fallbacks.ts prepare|check <state.json> [core-authority.json]
 */
import * as anchor from "@coral-xyz/anchor";
import { execFileSync } from "child_process";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import { assert, expect } from "chai";
import * as fs from "fs";
import { airdrop, betUnpack, big, expectErr, idl, KeeperChain, keccak, kp, L, MPL_CORE, pdas, u64, U64_MAX, XNT } from "./v3-helpers";

const RPC = process.env.RPC || "http://127.0.0.1:8899";
const connection = new Connection(RPC, "confirmed");
const [mode, statePath, coreAuthPath] = process.argv.slice(2);
const SYS = SystemProgram.programId;
const BN = (x: number | bigint | string) => new anchor.BN(x.toString());
const X = BigInt(XNT);
const CORE_PROGRAMDATA = new PublicKey("9ZC25KLUrfgSoFVgjE1rrydZBbZns58UXi8A8ZhTdGfr");
const LOADER_V3 = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const secret = (k: Keypair) => Array.from(k.secretKey);
const fromSecret = (s: number[]) => Keypair.fromSecretKey(Uint8Array.from(s));

type State = {
  payer: number[]; alice: number[]; bob: number[]; slot: string;
  bet: { pk: string; ps: string; rentPayer: string; anchor: string; stake: string };
  jackpot: { r: number; anchor: string; total: string; entries: number };
  artifacts: { serial: number; asset: string }[];
};

function setup(payer: Keypair) {
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
  const program = new anchor.Program(idl, provider);
  return { program, methods: program.methods as any, acc: program.account as any, P: pdas(program.programId) };
}
const slotNow = async () => BigInt(await connection.getSlot("confirmed"));
async function logsOf(sig: string) {
  for (let i = 0; i < 40; i++) {
    const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx) return tx.meta?.logMessages ?? [];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no transaction ${sig}`);
}
function events(program: anchor.Program, logs: string[]) {
  const parser = new anchor.EventParser(program.programId, program.coder);
  return [...parser.parseLogs(logs)];
}
/** SlotHashes as (count, newest, oldest). */
async function slotHashesWindow() {
  const d = (await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, "confirmed"))!.data;
  const n = Number(d.readBigUInt64LE(0));
  return { n, newest: d.readBigUInt64LE(8), oldest: d.readBigUInt64LE(8 + (n - 1) * 40) };
}

async function prepare() {
  const payer = Keypair.generate(), alice = Keypair.generate(), bob = Keypair.generate(), lp = Keypair.generate();
  const keeper = kp("test-keeper.json"); // INITIAL_KEEPER (localnet)
  for (const k of [payer, alice, bob, lp, keeper]) await airdrop(connection, k.publicKey, 1000 * XNT);
  const { program, methods, acc, P } = setup(payer);
  // the S7 base (as v3-gaps.test.ts does alone)
  await methods.initializeV2().accountsPartial({
    config: P.config, rewardVault: P.reward, bankrollVault: P.bankroll, drawVault: P.draw, collection: P.collection, artifactAuthority: P.authority,
    payer: payer.publicKey, systemProgram: SYS,
  }).rpc();
  await methods.donate(0, BN(100 * XNT)).accountsPartial({ config: P.config, donor: payer.publicKey, vault: P.reward, systemProgram: SYS }).rpc();
  await methods.initArtifacts().accountsPartial({ config: P.config, collection: P.collection, artifactAuthority: P.authority, payer: payer.publicKey, coreProgram: MPL_CORE, systemProgram: SYS }).rpc();
  await methods.initSeat().accountsPartial({ config: P.config, seat: P.seat, rewardVault: P.reward, payer: payer.publicKey, systemProgram: SYS }).rpc();
  await methods.initExtra().accountsPartial({ config: P.config, extraState: P.extraState, extraVault: P.extraVault, payer: payer.publicKey, systemProgram: SYS }).rpc();
  // three Lunar Dust for alice (the Core-closed hatch)
  const artifacts: State["artifacts"] = [];
  for (let i = 0; i < 3; i++) {
    const c = await acc.config.fetch(P.config);
    const serial = c.artifactsMinted[0];
    await methods.forgeArtifact(0, serial, U64_MAX).accountsPartial({
      config: P.config, asset: P.asset(0, serial), record: P.artifact(P.asset(0, serial)), collection: P.collection, artifactAuthority: P.authority,
      rewardVault: P.reward, drawVault: P.draw, architect: c.architect, buyer: alice.publicKey, coreProgram: MPL_CORE, systemProgram: SYS,
      extraState: P.extraState, extraVault: P.extraVault,
    }).signers([alice]).rpc();
    artifacts.push({ serial, asset: P.asset(0, serial).toBase58() });
  }
  // a keeper with a bond, a bankroll, two game wallets
  const chain = new KeeperChain(keccak(Buffer.from("r9-fallbacks"), payer.publicKey.toBuffer()), 16);
  await methods.armKeeper(Array.from(chain.tip), BN(16), BN(50 * XNT)).accountsPartial({
    config: P.config, keeperSeat: P.keeper, keeper: keeper.publicKey, bankrollVault: P.bankroll, rewardVault: P.reward, systemProgram: SYS,
  }).signers([keeper]).rpc();
  await methods.houseDeposit(BN(500 * XNT), BN(0)).accountsPartial({ config: P.config, share: P.house(lp.publicKey), bankrollVault: P.bankroll, owner: lp.publicKey, systemProgram: SYS }).signers([lp]).rpc();
  for (const k of [alice, bob]) {
    await methods.openPlayer().accountsPartial({ playerState: P.player(k.publicKey), owner: k.publicKey, systemProgram: SYS }).signers([k]).rpc();
    await methods.deposit(BN(10 * XNT)).accountsPartial({ playerState: P.player(k.publicKey), payer: k.publicKey, systemProgram: SYS }).signers([k]).rpc();
  }
  // a Jackpot round with two players, then the house bet nobody anchors, then the draw (both anchors close together)
  const r = (await acc.config.fetch(P.config)).jackpotRound.toNumber();
  const enter = (k: Keypair, idx: number, amt: bigint) => methods.enterJackpot(BN(r), idx, BN(amt)).accountsPartial({
    config: P.config, round: P.jackpot(r), entry: P.jpEntry(r, idx), playerState: P.player(k.publicKey), signer: k.publicKey, systemProgram: SYS,
  }).signers([k]).rpc();
  await enter(alice, 0, X);
  await enter(bob, 1, 2n * X);
  const ps = P.player(alice.publicKey);
  const nonce = (await acc.playerState.fetch(ps)).nonce.toNumber();
  const c = await acc.config.fetch(P.config);
  await methods.placeBetV2(0, BN(0), 1, BN(X / 10n), Array.from(keccak(Buffer.from("r9-bet")))).accountsPartial({
    config: P.config, playerState: ps, bet: P.bet(ps, nonce), bankrollVault: P.bankroll, rewardVault: P.reward, architect: c.architect,
    signer: alice.publicKey, systemProgram: SYS, keeperSeat: P.keeper,
  }).signers([alice]).rpc();
  const bet = await acc.bet.fetch(P.bet(ps, nonce));
  for (let i = 0; ; i++) {
    try { await methods.drawJackpot().accountsPartial({ config: P.config, round: P.jackpot(r), firstPlayerState: ps, keeperSeat: P.keeper }).rpc(); break; } catch (e: any) {
      if (i > 40 || !String(e).includes("RoundRunning") && !JSON.stringify(e?.logs ?? "").includes("RoundRunning")) throw e;
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  const round = await acc.jackpotRound.fetch(P.jackpot(r));
  expect(round.state, "the round is DRAWING").to.equal(1);
  const state: State = {
    payer: secret(payer), alice: secret(alice), bob: secret(bob), slot: (await slotNow()).toString(),
    bet: { pk: P.bet(ps, nonce).toBase58(), ps: ps.toBase58(), rentPayer: alice.publicKey.toBase58(), anchor: betUnpack(big(bet.targetSlot)).anchor.toString(), stake: big(bet.stake).toString() },
    jackpot: { r, anchor: betUnpack(big(round.targetSlot)).anchor.toString(), total: big(round.total).toString(), entries: round.entries },
    artifacts,
  };
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(`prepared at slot ${state.slot}: bet anchor ${state.bet.anchor}, round ${r} anchor ${state.jackpot.anchor}, ${artifacts.length} Artifacts`);
}

async function check() {
  const s: State = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const payer = fromSecret(s.payer), alice = fromSecret(s.alice), bob = fromSecret(s.bob);
  const { program, methods, acc, P } = setup(payer);
  const bal = async (k: PublicKey) => BigInt(await connection.getBalance(k, "confirmed"));
  const gameBal = async (k: PublicKey) => big((await acc.playerState.fetch(P.player(k))).balance);
  let ok = 0;
  const pass = (what: string) => { ok++; console.log(`  ok   ${what}`); };

  // ── 1. SlotHashes time fallback ─────────────────────────────────────────────
  const betAnchor = BigInt(s.bet.anchor), jpAnchor = BigInt(s.jackpot.anchor);
  const w = await slotHashesWindow();
  const now = await slotNow();
  expect(now > betAnchor + BigInt(L.SLOT_HASH_MAX_AGE) && now > jpAnchor + BigInt(L.SLOT_HASH_MAX_AGE), `clock slot ${now} past both anchors + ${L.SLOT_HASH_MAX_AGE}`).to.equal(true);
  for (const a of [betAnchor, jpAnchor]) expect(w.oldest <= a && a <= w.newest, `anchor ${a} still inside SlotHashes [${w.oldest}, ${w.newest}]`).to.equal(true);
  pass(`warped: clock slot ${now}; SlotHashes still holds both anchors (${betAnchor}, ${jpAnchor}) in [${w.oldest}, ${w.newest}]: without the fallback both would read Ready`);
  const betPk = new PublicKey(s.bet.pk);
  await expectErr(methods.anchorBet().accountsPartial({ bet: betPk, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).rpc(), "BetStalled");
  pass("anchor_bet past SLOT_HASH_MAX_AGE: BetStalled (its block counts as gone)");
  const g0 = await gameBal(alice.publicKey), k0 = await acc.houseKeeper.fetch(P.keeper);
  const rf = await methods.refundStalledBet().accountsPartial({
    config: P.config, bet: betPk, playerState: new PublicKey(s.bet.ps), bankrollVault: P.bankroll, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
    rentPayer: new PublicKey(s.bet.rentPayer), keeperSeat: P.keeper, rewardVault: P.reward,
  }).rpc();
  const ev = events(program, await logsOf(rf)).find((e) => e.name === "betRefunded" || e.name === "BetRefunded");
  expect(ev?.data.reason, "reason 0: never anchored, its block counts as gone").to.equal(0);
  expect((await gameBal(alice.publicKey)) - g0, "made whole").to.equal(BigInt(s.bet.stake));
  expect(await connection.getAccountInfo(betPk), "the bet account is closed").to.equal(null);
  expect((await acc.houseKeeper.fetch(P.keeper)).pendingBets, "one pending item less").to.equal(k0.pendingBets - 1);
  pass("refund_stalled_bet: reason 0, the player made whole, the bet closed");
  const total = BigInt(s.jackpot.total);
  const pool0 = await bal(P.reward), bond0 = big((await acc.houseKeeper.fetch(P.keeper)).bond);
  const e0 = await acc.jackpotEntry.fetch(P.jpEntry(s.jackpot.r, 0));
  const st = await methods.settleJackpotV2(Array.from(Buffer.alloc(32, 7))).accountsPartial({
    config: P.config, round: P.jackpot(s.jackpot.r), entry: P.jpEntry(s.jackpot.r, 0), winnerState: P.player(e0.player), rewardVault: P.reward, drawVault: P.draw,
    architect: (await acc.config.fetch(P.config)).architect, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, keeperSeat: P.keeper,
  }).rpc();
  const br = events(program, await logsOf(st)).find((e) => e.name === "betRefunded" || e.name === "BetRefunded");
  expect([br?.data.reason, big(br?.data.penalty)], "reason 2: the round expired, the bond pays the pot").to.deep.equal([2, total]);
  expect((await acc.jackpotRound.fetch(P.jackpot(s.jackpot.r))).state, "REFUND").to.equal(3);
  expect([(await bal(P.reward)) - pool0, bond0 - big((await acc.houseKeeper.fetch(P.keeper)).bond)]).to.deep.equal([total, total]);
  const k1 = await acc.houseKeeper.fetch(P.keeper);
  expect([k1.pendingBets, big(k1.jackpotReserved)], "nothing pending: the seat can be withdrawn or taken over again").to.deep.equal([0, 0n]);
  pass("settle_jackpot_v2 with no reveal: the DRAWING round expires (reason 2), the bond pays the pot to the pool, nothing pending");
  for (let i = 0; i < s.jackpot.entries; i++) {
    const e = await acc.jackpotEntry.fetch(P.jpEntry(s.jackpot.r, i));
    const before = await gameBal(e.player);
    await methods.closeJackpotEntry().accountsPartial({ round: P.jackpot(s.jackpot.r), playerState: P.player(e.player), entry: P.jpEntry(s.jackpot.r, i), rentPayer: e.rentPayer }).rpc();
    expect((await gameBal(e.player)) - before, `entry ${i} refunded`).to.equal(big(e.amount));
  }
  pass("close_jackpot_entry: every entry refunded");

  // ── 2. Core-closed hatch ────────────────────────────────────────────────────
  const core = (await connection.getAccountInfo(MPL_CORE))!;
  expect(core.owner.toBase58(), "Core is an upgradeable program here").to.equal(LOADER_V3.toBase58());
  expect((await connection.getAccountInfo(CORE_PROGRAMDATA))?.owner.toBase58(), "Core's ProgramData exists").to.equal(LOADER_V3.toBase58());
  const hatch = [{ pubkey: CORE_PROGRAMDATA, isSigner: false, isWritable: false }];
  const recycle = (k: Keypair, asset: PublicKey, withHatch: boolean) => methods.recycleArtifact().accountsPartial({
    config: P.config, asset, record: P.artifact(asset), collection: P.collection, owner: k.publicKey, coreProgram: MPL_CORE, systemProgram: SYS, extraState: P.extraState,
  }).remainingAccounts(withHatch ? hatch : []).signers([k]).rpc();
  const [a1, a2, a3] = s.artifacts.map((a) => new PublicKey(a.asset));
  // Core alive: the ProgramData account changes nothing, the asset is burned as always
  await recycle(alice, a1, true);
  const t1 = await connection.getAccountInfo(a1);
  expect(t1 === null || t1.data.length <= 1 || t1.data[0] === 0, "Core burned the asset (tombstone)").to.equal(true);
  expect(await connection.getAccountInfo(P.artifact(a1))).to.equal(null);
  pass("Core alive: recycle with the ProgramData account burns the asset through Core as before");
  // close Core with its (throwaway) upgrade authority
  const auth = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(coreAuthPath, "utf8"))));
  await airdrop(connection, auth.publicKey, XNT);
  execFileSync("solana", ["program", "close", MPL_CORE.toBase58(), "--authority", coreAuthPath, "--keypair", coreAuthPath, "--bypass-warning", "-u", RPC], { stdio: "inherit" });
  const pdAfter = await connection.getAccountInfo(CORE_PROGRAMDATA);
  expect(pdAfter === null || !pdAfter.owner.equals(LOADER_V3), "Core's ProgramData is closed").to.equal(true);
  expect((await connection.getAccountInfo(MPL_CORE))!.owner.toBase58(), "the program account stays under the loader").to.equal(LOADER_V3.toBase58());
  pass("Core closed by its upgrade authority (ProgramData gone, program account still under the upgradeable loader)");
  await expectErr(recycle(alice, a2, false), "");
  pass("recycle without the ProgramData account: refused (the Core burn cannot run)");
  await expectErr(recycle(bob, a2, true), "NotArtifactOwner");
  pass("the hatch for a non-holder: NotArtifactOwner (the frozen AssetV1 owner bytes decide)");
  const rec = await connection.getAccountInfo(P.artifact(a2));
  const floor = big((await acc.artifactRecord.fetch(P.artifact(a2))).backing);
  const alive0 = (await acc.config.fetch(P.config)).artifactsAlive[0];
  const al0 = await bal(alice.publicKey);
  const hs = await recycle(alice, a2, true);
  const rv = events(program, await logsOf(hs)).find((e) => e.name === "artifactRecycled" || e.name === "ArtifactRecycled");
  expect([big(rv?.data.backingReturned), rv?.data.orphan], "ArtifactRecycled: the floor, not an orphan").to.deep.equal([floor, false]);
  expect((await bal(alice.publicKey)) - al0, "the holder gets the record's lamports: floor + rent (the payer pays the fee)").to.equal(BigInt(rec!.lamports));
  expect(await connection.getAccountInfo(P.artifact(a2)), "the record is closed").to.equal(null);
  expect((await acc.config.fetch(P.config)).artifactsAlive[0], "the slot is freed").to.equal(alive0 - 1);
  expect((await connection.getAccountInfo(a2))!.owner.toBase58(), "the asset itself is untouched (Core can never change it again)").to.equal(MPL_CORE.toBase58());
  pass(`Core closed: the holder recycles with the ProgramData account and gets the floor (${floor} lamports) + rent; the slot is freed`);
  await expectErr(recycle(alice, a2, true), "AccountNotInitialized");
  pass("a floor is paid once: the record is gone");
  await expectErr(methods.reclaimOrphan().accountsPartial({
    config: P.config, asset: a3, record: P.artifact(a3), collection: P.collection, rewardVault: P.reward, extraState: P.extraState,
  }).rpc(), "ArtifactAlive");
  pass("a frozen live asset is still no orphan: reclaim_orphan refuses it (ArtifactAlive)");
  await recycle(alice, a3, true);
  expect(await connection.getAccountInfo(P.artifact(a3))).to.equal(null);
  pass("the last Artifact recycled through the hatch too");
  console.log(`fallbacks: ${ok} ok`);
  void assert; void u64;
}

(mode === "prepare" ? prepare() : mode === "check" ? check() : Promise.reject(new Error("usage: fallbacks.ts prepare|check <state.json> [core-authority.json]")))
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });
