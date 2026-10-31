/**
 * Moon Forge v3 (final upgrade) — integration tests against a local validator running:
 *   • the program built with `--features localnet` (test keys, days compressed into seconds)
 *   • the real Metaplex Core program dumped from X1 mainnet
 *   • a synthetic XDEX observation account (tests/fixtures/make-observation.cjs: +5% on odd prediction rounds)
 * SPEC-UPGRADE-v2 8.2 blocks B-1 … B-14, in the order: first-run steps (S7) → Predictions entries (background) → B-8
 * → B-1 / B-3 → B-7 → B-9 → B-10 → B-5 / B-6 → stalls and expiries → B-2 → B-11 → Predictions resolution → B-13 → B-14.
 * Run: bash tests/run-local.sh
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { assert, expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
  big, betPack, betUnpack, chainTools, claimLeaf, coverage, currentPrice, errText, expectErr, extraLeaf, forgeSplit, idl, isWin,
  jackpotTicketV2, KeeperChain, keccak, kp, L, marketSplit, minListPrice, mixedSeed, MPL_CORE, nextPrice, OBS, pdas, retry, rnd,
  seatBond, sleep, trackedMethods, tree, u32, u64, U64_MAX, voidBond, withStallNote, XNT,
  airdrop, airdropLeaf, airdropWallets, CORE_AUTH, CORE_PLUGIN, parseCore, parseRoyalties,
} from "./v3-helpers";

const RPC = process.env.RPC || "http://127.0.0.1:8899";
const connection = new Connection(RPC, "confirmed");
const payer = Keypair.generate();
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const methods: any = trackedMethods(program);
const acc = program.account as any;
const pid = program.programId;
const P = pdas(pid);
const T = chainTools(connection, program);
const { bal, event } = T;
const BN = (x: number | bigint | string) => new anchor.BN(x.toString());
const SYS = SystemProgram.programId;

// ─── actors ─────────────────────────────────────────────────────────────────
const oracle = kp("test-oracle.json"); // INITIAL_ORACLE (localnet)
const architect0 = kp("test-architect.json"); // ARCHITECT (localnet): config.architect at initialize
const cold = kp("test-cold.json"); // SEAT_COLD_INITIAL (localnet)
const keeper = kp("test-keeper.json"); // INITIAL_KEEPER (localnet)
const architect = Keypair.generate(); // the OD-22 payee installed by set_architect (S7 step 4)
const newHot = Keypair.generate(); // the hot key the cold key rotates to (B-9)
const [alice, bob, carol, dave, eve, frank, predA, predB, keeper2, fresh] = Array.from({ length: 10 }, () => Keypair.generate());
const stranger = Keypair.generate();

async function fund(...ks: PublicKey[]) {
  for (const k of ks) await airdrop(connection, k, 1000 * XNT);
}
/** Sends a builder, returns its events and block time. */
async function send(b: any, signers: Keypair[] = []) {
  const sig = await b.signers(signers).rpc();
  return T.txInfo(sig);
}
const cfg = () => acc.config.fetch(P.config);
const ks = () => acc.houseKeeper.fetch(P.keeper);
const xs = () => acc.extraState.fetch(P.extraState);
const gameBal = async (k: PublicKey) => big((await acc.playerState.fetch(P.player(k))).balance);
const rent8 = () => T.rentFor(8);

// ─── account builders ───────────────────────────────────────────────────────
const forgeAccounts = (k: PublicKey, tier: number, serial: number, arch: PublicKey) => ({
  config: P.config, asset: P.asset(tier, serial), record: P.artifact(P.asset(tier, serial)), collection: P.collection, artifactAuthority: P.authority,
  rewardVault: P.reward, drawVault: P.draw, architect: arch, buyer: k, coreProgram: MPL_CORE, systemProgram: SYS, extraState: P.extraState, extraVault: P.extraVault,
});
async function forge(k: Keypair, tier: number, max: anchor.BN = U64_MAX) {
  const c = await cfg();
  const serial = c.artifactsMinted[tier];
  const info = await send(methods.forgeArtifact(tier, serial, max).accountsPartial(forgeAccounts(k.publicKey, tier, serial, c.architect)), [k]);
  const ev = event(info.events, "ArtifactForged");
  return { serial, asset: P.asset(tier, serial), price: big(ev.price), backing: big(ev.backing), info, before: c };
}
const recycle = (k: Keypair, asset: PublicKey) => methods.recycleArtifact().accountsPartial({
  config: P.config, asset, record: P.artifact(asset), collection: P.collection, owner: k.publicKey, coreProgram: MPL_CORE, systemProgram: SYS, extraState: P.extraState,
}).signers([k]).rpc();
const assetOwner = async (a: PublicKey) => new PublicKey((await connection.getAccountInfo(a))!.data.subarray(1, 33));
/** The asset's TransferDelegate registry record (exactly one), parsed: { authority tag, address or null }. */
const delegateOf = (d: Buffer) => {
  const rec = parseCore(d).plugins.filter((p) => p.type === CORE_PLUGIN.TransferDelegate);
  expect(rec.length, "one TransferDelegate plugin").to.equal(1);
  return { authority: rec[0].authority, address: rec[0].address ? rec[0].address.toBase58() : null };
};
/** Core TransferV1 by the owner (Core resets every owner-managed plugin authority on transfer). */
const coreTransfer = (asset: PublicKey, owner: Keypair, to: PublicKey) => T.sendIxs([new TransactionInstruction({
  programId: MPL_CORE, data: Buffer.from([14, 0]),
  keys: [
    { pubkey: asset, isSigner: false, isWritable: true }, { pubkey: P.collection, isSigner: false, isWritable: false },
    { pubkey: owner.publicKey, isSigner: true, isWritable: true }, { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    { pubkey: to, isSigner: false, isWritable: false }, { pubkey: MPL_CORE, isSigner: false, isWritable: false }, { pubkey: MPL_CORE, isSigner: false, isWritable: false },
  ],
})], [owner]);
/** Core BurnV1 by the owner, outside Moon Forge (leaves an orphan record). */
const coreBurn = (asset: PublicKey, owner: Keypair) => T.sendIxs([new TransactionInstruction({
  programId: MPL_CORE, data: Buffer.from([12, 0]),
  keys: [
    { pubkey: asset, isSigner: false, isWritable: true }, { pubkey: P.collection, isSigner: false, isWritable: true },
    { pubkey: owner.publicKey, isSigner: true, isWritable: true }, { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    { pubkey: SYS, isSigner: false, isWritable: false }, { pubkey: MPL_CORE, isSigner: false, isWritable: false },
  ],
})], [owner]);

// epochs: oracle publishes; the signer changes after the cold rotation (B-9)
let hot = oracle;
const publish = (n: number, root: Buffer, total: bigint, leaves: number, signer = hot, cap: bigint = 1_000_000_000_000_000n) =>
  methods.publishEpoch(BN(n), Array.from(root), Array.from(Buffer.alloc(32, n)), BN(total), leaves, BN(cap))
    .accountsPartial({ config: P.config, epoch: P.epoch(n), rewardVault: P.reward, oracle: signer.publicKey, systemProgram: SYS }).signers([signer]);
const claimInstantB = (n: number, l: { p: PublicKey; t: number; s: bigint }, proof: number[][], payerK: Keypair) =>
  methods.claimInstant(BN(n), l.t, BN(l.s), proof).accountsPartial({
    config: P.config, epoch: P.epoch(n), receipt: P.receipt(n, l.p, l.t), player: l.p, playerState: P.player(l.p), rewardVault: P.reward,
    payer: payerK.publicKey, systemProgram: SYS,
  }).signers([payerK]);
const claimMissionB = (n: number, l: { p: PublicKey; t: number; s: bigint }, proof: number[][], payerK: Keypair) =>
  methods.claimMission(BN(n), l.t, BN(l.s), proof).accountsPartial({
    config: P.config, epoch: P.epoch(n), receipt: P.receipt(n, l.p, l.t), mission: P.mission(n, l.p, l.t), player: l.p, playerState: P.player(l.p),
    rewardVault: P.reward, payer: payerK.publicKey, systemProgram: SYS,
  }).signers([payerK]);
const publishExtra = (n: number, root: Buffer, total: bigint, leaves: number, signer = hot, weeks = 1) =>
  methods.publishExtraEpoch(BN(n), Array.from(root), Array.from(Buffer.alloc(32, 0x40 + n)), BN(total), leaves, weeks).accountsPartial({
    config: P.config, extraState: P.extraState, extraEpoch: P.extraEpoch(n), baseEpoch: P.epoch(n), prevEpoch: P.epoch(Math.max(1, n - 1)),
    oracle: signer.publicKey, systemProgram: SYS,
  }).signers([signer]);
const walkPairs = async () => {
  const last = (await cfg()).lastEpoch.toNumber();
  const out: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  for (let id = last; id >= 1 && out.length < 20; id--) out.push({ pubkey: P.epoch(id), isSigner: false, isWritable: false }, { pubkey: P.extraEpoch(id), isSigner: false, isWritable: false });
  return out;
};

// house / keeper
let chain: KeeperChain;
let chainSeed = 1;
const newChain = (len: number) => (chain = new KeeperChain(keccak(Buffer.from("test-chain"), u32(chainSeed++)), len));
const armB = (k: Keypair, tip: Buffer, len: number, deposit: number | bigint) => methods.armKeeper(Array.from(tip), BN(len), BN(deposit)).accountsPartial({
  config: P.config, keeperSeat: P.keeper, keeper: k.publicKey, bankrollVault: P.bankroll, rewardVault: P.reward, systemProgram: SYS,
}).signers([k]);
const keeperOnly = (k: Keypair) => ({ config: P.config, keeperSeat: P.keeper, keeper: k.publicKey, bankrollVault: P.bankroll, rewardVault: P.reward, systemProgram: SYS });
type V2Bet = { ps: PublicKey; nonce: number; pk: PublicKey; owner: Keypair; seed: Buffer; game: number; choice: number };
async function placeV2(k: Keypair, game: number, param: number, choice: number, stake: number): Promise<V2Bet> {
  const ps = P.player(k.publicKey);
  const nonce = (await acc.playerState.fetch(ps)).nonce.toNumber();
  const seed = keccak(Buffer.from("seed"), k.publicKey.toBuffer(), u64(nonce));
  const c = await cfg();
  await methods.placeBetV2(game, BN(param), choice, BN(stake), Array.from(seed)).accountsPartial({
    config: P.config, playerState: ps, bet: P.bet(ps, nonce), bankrollVault: P.bankroll, rewardVault: P.reward, architect: c.architect,
    signer: k.publicKey, systemProgram: SYS, keeperSeat: P.keeper,
  }).signers([k]).rpc();
  return { ps, nonce, pk: P.bet(ps, nonce), owner: k, seed, game, choice };
}
const anchorB = (b: V2Bet) => methods.anchorBet().accountsPartial({ bet: b.pk, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY });
async function anchorWhenReady(b: V2Bet) {
  const t = big((await acc.bet.fetch(b.pk)).targetSlot);
  await T.waitPastSlot(betUnpack(t).anchor);
  await retry(["NotReady"], () => anchorB(b).rpc());
}
const settleV2B = (b: V2Bet, reveal: Buffer) => methods.settleBetV2(Array.from(reveal)).accountsPartial({
  config: P.config, bet: b.pk, playerState: b.ps, bankrollVault: P.bankroll, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: b.owner.publicKey, keeperSeat: P.keeper,
});
const refundB = (b: V2Bet) => methods.refundStalledBet().accountsPartial({
  config: P.config, bet: b.pk, playerState: b.ps, bankrollVault: P.bankroll, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: b.owner.publicKey,
  keeperSeat: P.keeper, rewardVault: P.reward,
});
/** Anchors (if needed) and settles a v2 bet with the keeper's next reveal; returns the roll, win flag and payout. */
async function settleBet(b: V2Bet) {
  const bet0 = await acc.bet.fetch(b.pk);
  if ((bet0.game & 0x40) === 0) await anchorWhenReady(b);
  const bet = await acc.bet.fetch(b.pk);
  const { index } = betUnpack(big(bet.targetSlot));
  const reveal = chain.reveal(index);
  const before = await gameBal(b.owner.publicKey);
  // G-2 (round 4): the settle tip, min(0.0005 XNT, half of the bet's 1% pool share, the free pool), from the reward
  // vault to the registered keeper wallet (resolved by the client from keeper_seat.keeper), booked in keeper_tips
  const kw = (await ks()).keeper as PublicKey;
  const c0 = await cfg();
  const [kw0, pool0] = [big(await bal(kw)), big(await bal(P.reward))];
  const free0 = pool0 - big(await rent8()) - big(c0.rewardReserved);
  const share = (big(bet.stake) * 100n) / 10_000n / 2n;
  const want = [500_000n, share, free0 < 0n ? 0n : free0].reduce((a, x) => (x < a ? x : a));
  const st = await withStallNote(send(settleV2B(b, reveal)), connection, big(bet.targetSlot), ks);
  const ev = event(st.events, "BetSettled");
  expect(big(ev.keeperTip), "G-2 settle tip").to.equal(want);
  expect(big(await bal(kw)) - kw0, "the tip reaches the registered keeper wallet").to.equal(want);
  expect(pool0 - big(await bal(P.reward)), "the tip leaves the reward vault").to.equal(want);
  expect(big((await cfg()).stats.keeperTips) - big(c0.stats.keeperTips), "booked in keeper_tips").to.equal(want);
  const roll = rnd(reveal, b.pk.toBuffer(), Buffer.from(bet.seed)) % 10_000n;
  const won = isWin(bet.game & 0x3f, bet.choice, big(bet.chanceBps), roll);
  expect((await gameBal(b.owner.publicKey)) - before).to.equal(won ? big(bet.payout) : 0n);
  return { roll, won, payout: big(bet.payout), tip: want };
}
const revealKeeperB = (reveal: Buffer, k = keeper) => methods.revealKeeper(Array.from(reveal)).accountsPartial({ keeperSeat: P.keeper, keeper: k.publicKey }).signers([k]);

// jackpot
const enterJp = (k: Keypair, r: number, idx: number, amt: number) => methods.enterJackpot(BN(r), idx, BN(amt)).accountsPartial({
  config: P.config, round: P.jackpot(r), entry: P.jpEntry(r, idx), playerState: P.player(k.publicKey), signer: k.publicKey, systemProgram: SYS,
}).signers([k]);
const drawJp = (r: number, first: PublicKey) => methods.drawJackpot().accountsPartial({ config: P.config, round: P.jackpot(r), firstPlayerState: P.player(first), keeperSeat: P.keeper });
const settleJpV2B = async (r: number, entryIdx: number, reveal: Buffer) => {
  const e = await acc.jackpotEntry.fetch(P.jpEntry(r, entryIdx));
  return methods.settleJackpotV2(Array.from(reveal)).accountsPartial({
    config: P.config, round: P.jackpot(r), entry: P.jpEntry(r, entryIdx), winnerState: P.player(e.player), rewardVault: P.reward, drawVault: P.draw,
    architect: (await cfg()).architect, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, keeperSeat: P.keeper,
  });
};
async function jackpotWinnerIndex(r: number, reveal: Buffer) {
  const round = await acc.jackpotRound.fetch(P.jackpot(r));
  const { anchor } = betUnpack(big(round.targetSlot));
  await T.waitPastSlot(anchor);
  const h = (await T.slotHashAtOrAfter(anchor))!;
  const ticket = jackpotTicketV2(h, reveal, P.jackpot(r), r, big(round.total));
  for (let i = 0; i < round.entries; i++) {
    const e = await acc.jackpotEntry.fetch(P.jpEntry(r, i));
    if (ticket >= big(e.start) && ticket < big(e.start) + big(e.amount)) return { i, ticket, player: e.player as PublicKey };
  }
  throw new Error("no winning entry");
}
const closeJpEntry = async (r: number, i: number) => {
  const e = await acc.jackpotEntry.fetch(P.jpEntry(r, i));
  return methods.closeJackpotEntry().accountsPartial({ round: P.jackpot(r), playerState: P.player(e.player), entry: P.jpEntry(r, i), rentPayer: e.rentPayer }).rpc();
};
async function openGame(k: Keypair, xnt: number) {
  if (!(await connection.getAccountInfo(P.player(k.publicKey)))) {
    await methods.openPlayer().accountsPartial({ playerState: P.player(k.publicKey), owner: k.publicKey, systemProgram: SYS }).signers([k]).rpc();
  }
  if (xnt > 0) await methods.deposit(BN(Math.round(xnt * XNT))).accountsPartial({ playerState: P.player(k.publicKey), payer: k.publicKey, systemProgram: SYS }).signers([k]).rpc();
}

// state shared across blocks
const E1 = [
  { p: alice.publicKey, t: 0, s: 600n },
  { p: bob.publicKey, t: 1, s: 300n },
  { p: carol.publicKey, t: 2, s: 100n },
];
const t1 = tree(E1.map((l) => claimLeaf(1, l.p, l.t, l.s)));
const E2 = [{ p: alice.publicKey, t: 0, s: 1000n }, { p: bob.publicKey, t: 0, s: 1000n }]; // leaves sum to 2× the total score
const t2 = tree(E2.map((l) => claimLeaf(2, l.p, l.t, l.s)));
let stallGroup: { jp: number; s0: V2Bet; s1: V2Bet; positions: bigint[] } | null = null;
let predRounds: number[] = [];
let predEntries: Promise<void> | null = null;
let predError: any = null;
const p2pRake = { pool: 0n, architect: 0n }; // expected 1.5% / 0.5% of decided P2P pots, checked in B-4

describe("Moon Forge v3", () => {
  before(async () => {
    await fund(payer.publicKey, oracle.publicKey, architect0.publicKey, cold.publicKey, keeper.publicKey, architect.publicKey, newHot.publicKey,
      alice.publicKey, bob.publicKey, carol.publicKey, dave.publicKey, eve.publicKey, frank.publicKey, predA.publicKey, predB.publicKey,
      keeper2.publicKey, stranger.publicKey);
    await fund(payer.publicKey, keeper.publicKey, dave.publicKey);
  });

  // ─── S7 first-run steps (SPEC-UPGRADE-v2 6.3) ──────────────────────────────
  it("S7: initialize, init_artifacts, forge refused before init_extra, set_architect, lock_collection_royalties, init_seat, init_extra, arm_keeper", async () => {
    await methods.initializeV2().accountsPartial({
      config: P.config, rewardVault: P.reward, bankrollVault: P.bankroll, drawVault: P.draw, collection: P.collection, artifactAuthority: P.authority,
      payer: payer.publicKey, systemProgram: SYS,
    }).rpc();
    let c = await cfg();
    expect(c.oracle.toBase58()).to.equal(oracle.publicKey.toBase58());
    expect(c.architect.toBase58()).to.equal(architect0.publicKey.toBase58());
    await methods.sweepLegacy().accountsPartial({ legacyState: P.legacyState, legacyEscrow: P.legacyEscrow, config: P.config, rewardVault: P.reward }).rpc();
    // B-13 PoolEmpty: before the first donation the pool holds only its rent, so 10% of the free pool is 0 and the first
    // publish is refused (checked first: fewer than 10 free lamports, so the refused publish can never create epoch 1)
    const rv = (await connection.getAccountInfo(P.reward))!;
    expect(BigInt(rv.lamports) - BigInt(await T.rentFor(rv.data.length)) - big(c.rewardReserved) < 10n, "an empty pool before the donation").to.equal(true);
    await expectErr(publish(1, Buffer.alloc(32, 9), 1000n, 1).rpc(), "PoolEmpty");
    expect((await cfg()).lastEpoch.toNumber()).to.equal(0);
    const r0 = await bal(P.reward);
    const d = await send(methods.donate(0, BN(100 * XNT)).accountsPartial({ config: P.config, donor: payer.publicKey, vault: P.reward, systemProgram: SYS }));
    expect(event(d.events, "Donated").amount.toString()).to.equal(String(100 * XNT));
    expect((await bal(P.reward)) - r0).to.equal(100 * XNT);
    await expectErr(methods.donate(0, BN(1)).accountsPartial({ config: P.config, donor: payer.publicKey, vault: alice.publicKey, systemProgram: SYS }).rpc(), "InvalidTarget");
    await methods.initArtifacts().accountsPartial({ config: P.config, collection: P.collection, artifactAuthority: P.authority, payer: payer.publicKey, coreProgram: MPL_CORE, systemProgram: SYS }).rpc();
    await methods.refreshCollectionUri().accountsPartial({ config: P.config, collection: P.collection, artifactAuthority: P.authority, payer: payer.publicKey, coreProgram: MPL_CORE, systemProgram: SYS }).rpc();
    // LB-6: forging before init_extra fails on the missing extra_state account
    await expectErr(methods.forgeArtifact(0, 0, U64_MAX).accountsPartial(forgeAccounts(alice.publicKey, 0, 0, c.architect)).signers([alice]).rpc(), "AccountNotInitialized");

    // B-11: set_architect needs the old payee AND the new key; then lock the royalties to the new payee
    const setArch = (signer: Keypair, extra: Keypair[] = []) => methods.setArchitect(architect.publicKey).accountsPartial({
      config: P.config, architect: signer.publicKey, newArchitect: architect.publicKey, rewardVault: P.reward,
    }).remainingAccounts(extra.map((k) => ({ pubkey: k.publicKey, isSigner: true, isWritable: false }))).signers([signer, ...extra]);
    await expectErr(setArch(architect0).rpc(), "Unauthorized");
    await expectErr(setArch(stranger, [architect]).rpc(), "OnlyArchitect");
    const sa = await send(setArch(architect0, [architect]));
    expect(event(sa.events, "ArchitectChanged").newArchitect.toBase58()).to.equal(architect.publicKey.toBase58());
    c = await cfg();
    expect(c.architect.toBase58()).to.equal(architect.publicKey.toBase58());
    const lock = (k: Keypair) => methods.lockCollectionRoyalties().accountsPartial({
      config: P.config, collection: P.collection, artifactAuthority: P.authority, architect: k.publicKey, coreProgram: MPL_CORE, systemProgram: SYS,
    }).signers([k]);
    await expectErr(lock(architect0).rpc(), "OnlyArchitect");
    const lk = await send(lock(architect));
    expect(event(lk.events, "CollectionRoyaltiesLocked").creator.toBase58()).to.equal(architect.publicKey.toBase58());
    const coll = (await connection.getAccountInfo(P.collection))!.data;
    // M-1, parsed from the collection's plugin registry (not a byte search): Royalties { 500 bps, [ { new payee, 100 } ],
    // RuleSet None } and its plugin authority None, so nobody (not even the artifact_authority PDA) can change it again
    const royaltiesOf = (d: Buffer) => {
      const core = parseCore(d);
      expect(core.key).to.equal(5);
      expect(core.updateAuthority!.toBase58()).to.equal(P.authority.toBase58());
      const rec = core.plugins.filter((p) => p.type === CORE_PLUGIN.Royalties);
      expect(rec.length).to.equal(1);
      return { authority: rec[0].authority, ...parseRoyalties(d, rec[0].offset) };
    };
    const roy = royaltiesOf(coll);
    expect([roy.authority, roy.basisPoints, roy.creators.length, roy.creators[0].percentage, roy.ruleSet]).to.deep.equal([CORE_AUTH.None, 500, 1, 100, 0]);
    expect(roy.creators[0].address.toBase58()).to.equal(architect.publicKey.toBase58());
    expect(coll.includes(architect0.publicKey.toBuffer())).to.equal(false);
    // the plugin authority is None: Core itself refuses a second update (the program has no lock flag of its own), and the
    // failure is inside the Core CPI, not a program check
    const coreRefuses = async (p: Promise<any>) => {
      let failed = false;
      try { await p; } catch (e) { failed = true; expect(errText(e), "a refusal inside Core").to.include(`Program ${MPL_CORE.toBase58()} failed`); }
      expect(failed, "Core accepted a plugin update after the lock").to.equal(true);
    };
    await coreRefuses(lock(architect).rpc());
    // After the lock, an UpdateCollectionPluginV1 from the artifact_authority PDA with DIFFERENT content (a new creator)
    // also fails: lock_collection_royalties is the program's only plugin-update CPI, so it stands in for the spec's
    // test-only Core instruction (DEVIATIONS r3 task-b 2). The payee moves to `arch2` and back; the plugin never changes.
    const arch2 = Keypair.generate();
    await fund(arch2.publicKey);
    const setArchTo = (from: Keypair, to: Keypair) => methods.setArchitect(to.publicKey).accountsPartial({
      config: P.config, architect: from.publicKey, newArchitect: to.publicKey, rewardVault: P.reward,
    }).remainingAccounts([{ pubkey: to.publicKey, isSigner: true, isWritable: false }]).signers([from, to]).rpc();
    await setArchTo(architect, arch2);
    await coreRefuses(lock(arch2).rpc());
    expect((await connection.getAccountInfo(P.collection))!.data.equals(coll)).to.equal(true);
    await setArchTo(arch2, architect);
    expect((await cfg()).architect.toBase58()).to.equal(architect.publicKey.toBase58());

    // init_seat: 10% of the free pool (min 1 XNT) bonded by the payer, keys from constants.
    // SR-1 (security review r2, by design): init_seat is permissionless, so a STRANGER sends it here, standing in for a
    // front-runner of S7 step 6. The seat it creates is exactly the one the runbook expects (hot = config.oracle, cold =
    // SEAT_COLD_INITIAL, refund = SEAT_REFUND_INITIAL, bond = max(1 XNT, 10% of free) read at call time); the stranger
    // only pays the bond and gets no role and no claim on it.
    const free = big(await bal(P.reward)) - big(await rent8()) - big(c.rewardReserved);
    const st0 = big(await bal(stranger.publicKey));
    const initSeatB = (k: Keypair) => methods.initSeat().accountsPartial({ config: P.config, seat: P.seat, rewardVault: P.reward, payer: k.publicKey, systemProgram: SYS }).signers([k]);
    const is = await send(initSeatB(stranger));
    const seat = await acc.oracleSeat.fetch(P.seat);
    expect(big(seat.bond)).to.equal(seatBond(free));
    expect(seat.cold.toBase58()).to.equal(cold.publicKey.toBase58());
    expect(seat.refund.toBase58()).to.equal(PublicKey.default.toBase58()); // SEAT_REFUND_INITIAL (default = the pool)
    expect(seat.priority.toBase58()).to.equal(PublicKey.default.toBase58());
    expect([seat.generation, seat.openSince, seat.priorityBond, seat.voids, seat.toPool].map((x: any) => x.toString())).to.deep.equal(["1", "0", "0", "0", "0"]);
    const seatRent = big(await T.rentFor((await connection.getAccountInfo(P.seat))!.data.length));
    expect(big(await bal(P.seat))).to.equal(seatRent + seatBond(free));
    expect(st0 - big(await bal(stranger.publicKey)) >= seatRent + seatBond(free)).to.equal(true); // bond + rent + fee
    const sc = event(is.events, "SeatChanged");
    expect(sc.reason).to.equal(0);
    expect(sc.taker.toBase58()).to.equal(stranger.publicKey.toBase58());
    expect(sc.hot.toBase58()).to.equal(oracle.publicKey.toBase58());
    expect((await cfg()).oracle.toBase58()).to.equal(oracle.publicKey.toBase58());
    await expectErr(initSeatB(payer).rpc(), "already in use"); // once
    await expectErr(methods.rotateHot(stranger.publicKey).accountsPartial({ config: P.config, seat: P.seat, cold: stranger.publicKey }).signers([stranger]).rpc(), "OnlyCold");
    // init_extra (before any forge), once
    const ie = () => methods.initExtra().accountsPartial({ config: P.config, extraState: P.extraState, extraVault: P.extraVault, payer: payer.publicKey, systemProgram: SYS });
    await ie().rpc();
    await expectErr(ie().rpc(), "already in use");
    expect((await connection.getAccountInfo(P.extraVault))!.owner.toBase58()).to.equal(pid.toBase58());

    // arm_keeper: only INITIAL_KEEPER, bond >= 20 XNT
    newChain(64);
    await expectErr(armB(stranger, chain.tip, 64, 20 * XNT).rpc(), "OnlyKeeper");
    await expectErr(armB(keeper, chain.tip, 64, 19 * XNT).rpc(), "KeeperBondTooSmall");
    const ak = await send(armB(keeper, chain.tip, 64, 20 * XNT));
    const ka = event(ak.events, "KeeperArmed");
    expect(big(ka.bond)).to.equal(20n * BigInt(XNT));
    expect(ka.length.toNumber()).to.equal(64);
    const k = await ks();
    expect((await bal(P.keeper)) - (await T.rentFor((await connection.getAccountInfo(P.keeper))!.data.length))).to.equal(Number(k.bond));
  });

  it("Predictions (real) v2: two players enter two consecutive rounds (entries in the background; resolved at the end)", async () => {
    await openGame(predA, 5);
    await openGame(predB, 5);
    const enter = (k: Keypair, r: number, side: number, xnt: number) => methods.enterPrediction(BN(r), side, BN(xnt * XNT))
      .accountsPartial({ round: P.pred(r), entry: P.predEntry(r, k.publicKey), playerState: P.player(k.publicKey), owner: k.publicKey, systemProgram: SYS }).signers([k]);
    const enterRound = async (r: number) => {
      await enter(predA, r, 1, 1).rpc(); // UP
      await enter(predB, r, 0, 1).rpc(); // DOWN
    };
    // entries close 35 s into a 120-s round (one TWAP window + one max gap before the lock)
    let t = await T.chainTime();
    while (t % L.PRED_PERIOD > 28) { await sleep(1000); t = await T.chainTime(); }
    const k0 = Math.floor(t / L.PRED_PERIOD);
    await expectErr(enter(predA, k0 + 1, 1, 1).rpc(), "PredState"); // only the current round takes entries
    await enterRound(k0);
    await expectErr(enter(predA, k0, 0, 1).rpc(), "already in use"); // one entry per wallet per round
    predRounds = [k0, k0 + 1];
    predEntries = (async () => {
      await T.untilChainTime((k0 + 1) * L.PRED_PERIOD + 1);
      await enterRound(k0 + 1);
    })().catch((e) => { predError = e; });
  });

  // ─── B-8 Forge + hold ──────────────────────────────────────────────────────
  it("B-8: publish (reserve 0, drop_state 0, budget = 10% free), 48-h hold, keeper tips (0.2 XNT min, never to the oracle), missions, eject", async () => {
    await expectErr(publish(1, t1.root, 1000n, 3, alice).rpc(), "OnlyOracle");
    await expectErr(publish(1, t1.root, 1000n, 3, oracle, 0n).rpc(), "EmptyEpoch");
    await expectErr(publish(2, t1.root, 1000n, 3).rpc(), "BadEpochNumber");
    await expectErr(publish(1, t1.root, 0n, 3).rpc(), "EmptyEpoch");
    const c0 = await cfg();
    const free = big(await bal(P.reward)) - big(await rent8()) - big(c0.rewardReserved);
    const pub = await send(publish(1, t1.root, 1000n, 3));
    const e = await acc.epoch.fetch(P.epoch(1));
    expect(big(e.budget)).to.equal(free / 10n);
    expect(e.dropReserve.toNumber()).to.equal(0);
    expect(e.dropState).to.equal(0);
    expect(event(pub.events, "EpochPublished").dropReserve.toNumber()).to.equal(0);
    expect(big((await cfg()).rewardReserved)).to.equal(big(c0.rewardReserved) + big(e.budget));
    await expectErr(publish(2, t2.root, 1000n, 2).rpc(), "EpochTooSoon");
    await expectErr(methods.expireEpoch().accountsPartial({ config: P.config, epoch: P.epoch(1) }).rpc(), "ClaimWindowOpen");
    await expectErr(claimInstantB(1, E1[0], t1.proof(0), dave).rpc(), "ClaimOnHold");
    await expectErr(claimMissionB(1, E1[1], t1.proof(1), oracle).rpc(), "ClaimOnHold");

    const budget = big(e.budget);
    const amt = (s: bigint) => (s * budget) / 1000n;
    // a third party submits alice's claim: alice gets the amount, the pool pays dave the 0.002 XNT tip (claim >= 0.2 XNT)
    const a0 = big(await bal(alice.publicKey)), v0 = big(await bal(P.reward));
    await expectErr(claimInstantB(1, { ...E1[0], s: 601n }, t1.proof(0), dave).rpc(), "ClaimOnHold"); // the hold comes before the proof
    await T.untilChainTime(e.publishedAt.toNumber() + L.CLAIM_HOLD + 1);
    await expectErr(claimInstantB(1, { ...E1[0], s: 601n }, t1.proof(0), dave).rpc(), "InvalidProof");
    const ci = await retry(["ClaimOnHold"], () => send(claimInstantB(1, E1[0], t1.proof(0), dave)));
    expect(big(await bal(alice.publicKey)) - a0).to.equal(amt(600n));
    expect(v0 - big(await bal(P.reward))).to.equal(amt(600n) + BigInt(L.KEEPER_TIP));
    const fc = event(ci.events, "ForgeClaimed");
    expect(fc.keeperTip.toNumber()).to.equal(L.KEEPER_TIP);
    expect(fc.chips.toNumber()).to.equal(0); // ECO-3
    await expectErr(claimInstantB(1, E1[0], t1.proof(0), dave).rpc(), "already in use"); // the receipt PDA blocks a replay
    // the oracle submits bob's mission: no tip (S6 / SPEC 2.11)
    const v1 = big(await bal(P.reward));
    const cm = await send(claimMissionB(1, E1[1], t1.proof(1), oracle));
    expect(v1 - big(await bal(P.reward))).to.equal(amt(300n));
    expect(event(cm.events, "ForgeClaimed").keeperTip.toNumber()).to.equal(0);
    // carol submits her own mission: no tip
    const v2 = big(await bal(P.reward));
    await claimMissionB(1, E1[2], t1.proof(2), carol).rpc();
    expect(v2 - big(await bal(P.reward))).to.equal(amt(100n));
    const m = await acc.mission.fetch(P.mission(1, bob.publicKey, 1));
    expect(m.end.toNumber() - m.start.toNumber()).to.equal(45);
    await T.untilChainTime(m.start.toNumber() + 2); // vesting runs on the validator clock (it can lag the host clock)
    const b0 = big(await bal(bob.publicKey));
    await methods.withdrawVested().accountsPartial({ mission: P.mission(1, bob.publicKey, 1), player: bob.publicKey, playerState: P.player(bob.publicKey), rentPayer: oracle.publicKey }).rpc();
    const got = big(await bal(bob.publicKey)) - b0;
    expect(got > 0n && got < big(m.total) / 2n).to.equal(true);
    // eject: vested paid, 75% of the unvested to the pool
    const cm2 = await acc.mission.fetch(P.mission(1, carol.publicKey, 2));
    const pool0 = big(await bal(P.reward)), carol0 = big(await bal(carol.publicKey));
    await expectErr(methods.eject().accountsPartial({ config: P.config, mission: P.mission(1, carol.publicKey, 2), player: bob.publicKey, rewardVault: P.reward, rentPayer: carol.publicKey, playerState: P.player(carol.publicKey) }).signers([bob]).rpc(), "");
    const ej = await send(methods.eject().accountsPartial({ config: P.config, mission: P.mission(1, carol.publicKey, 2), player: carol.publicKey, rewardVault: P.reward, rentPayer: carol.publicKey, playerState: P.player(carol.publicKey) }), [carol]);
    const pe = event(ej.events, "PilotEjected");
    expect(big(await bal(P.reward)) - pool0).to.equal(big(pe.penaltyToPool));
    expect(big(pe.paid) + big(pe.penaltyToPool)).to.equal(big(cm2.total));
    expect(big(await bal(carol.publicKey)) - carol0 > big(pe.paid)).to.equal(true); // + the mission rent
    // a void after the hold is refused (B-9 HoldOver)
    await expectErr(methods.voidEpoch(BN(1), BN(XNT)).accountsPartial({ config: P.config, epoch: P.epoch(1), seat: P.seat, rewardVault: P.reward, voider: dave.publicKey, systemProgram: SYS }).signers([dave]).rpc(), "HoldOver");
    // the seat is alive (recently taken, surviving epoch)
    await expectErr(methods.takeSeat(dave.publicKey, cold.publicKey, PublicKey.default).accountsPartial({ config: P.config, seat: P.seat, rewardVault: P.reward, taker: dave.publicKey, systemProgram: SYS })
      .remainingAccounts(await walkPairs()).signers([dave]).rpc(), "SeatAlive");
  });

  it("B-8: the 108-byte legacy publish (old IDL) writes reserve 0; a leaf above the remaining budget is BudgetExhausted", async () => {
    const old = new anchor.Program(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/idl-onchain-v2.json"), "utf8")), provider);
    const ix = await old.methods.publishEpoch(BN(2), Array.from(t2.root), Array.from(Buffer.alloc(32, 2)), BN(1000), 2, BN(1_000_000_000_000_000n))
      .accountsPartial({ config: P.config, epoch: P.epoch(2), rewardVault: P.reward, oracle: oracle.publicKey, systemProgram: SYS }).instruction();
    expect(ix.data.length).to.equal(108);
    await retry(["EpochTooSoon"], () => T.sendIxs([ix], [oracle]));
    coverage.ok("publish_epoch");
    const e2 = await acc.epoch.fetch(P.epoch(2));
    expect(e2.dropReserve.toNumber()).to.equal(0);
    expect(e2.dropState).to.equal(0);
    await retry(["ClaimOnHold"], () => claimInstantB(2, E2[0], t2.proof(0), alice).rpc());
    expect(big((await acc.epoch.fetch(P.epoch(2))).claimed)).to.equal(big(e2.budget));
    await expectErr(claimInstantB(2, E2[1], t2.proof(1), bob).rpc(), "BudgetExhausted");
    await expectErr(methods.closeReceipt().accountsPartial({ epoch: P.epoch(2), receipt: P.receipt(2, alice.publicKey, 0), rentPayer: alice.publicKey }).rpc(), "ClaimWindowOpen");
  });

  // ─── B-1 House (keeper) ────────────────────────────────────────────────────
  it("B-1: place_bet retired; place_bet_v2 packs the chain position; anchor after one slot; settle in chain order; K-5; chain exhaustion", async () => {
    await methods.houseDeposit(BN(200 * XNT), BN(0)).accountsPartial({ config: P.config, share: P.house(payer.publicKey), bankrollVault: P.bankroll, owner: payer.publicKey, systemProgram: SYS }).rpc();
    await openGame(eve, 30);
    const ps = P.player(eve.publicKey);
    const n0 = (await acc.playerState.fetch(ps)).nonce.toNumber();
    const c = await cfg();
    await expectErr(methods.placeBet(0, BN(0), 1, BN(0.1 * XNT), Array(32).fill(1)).accountsPartial({
      config: P.config, playerState: ps, bet: P.bet(ps, n0), bankrollVault: P.bankroll, rewardVault: P.reward, architect: c.architect, signer: eve.publicKey, systemProgram: SYS,
    }).signers([eve]).rpc(), "KeeperRequired");
    // place + anchor in the same transaction: the anchor block does not exist yet
    const placeIx = await methods.placeBetV2(0, BN(0), 1, BN(0.1 * XNT), Array(32).fill(3)).accountsPartial({
      config: P.config, playerState: ps, bet: P.bet(ps, n0), bankrollVault: P.bankroll, rewardVault: P.reward, architect: c.architect, signer: eve.publicKey, systemProgram: SYS, keeperSeat: P.keeper,
    }).instruction();
    const anchorIx = await methods.anchorBet().accountsPartial({ bet: P.bet(ps, n0), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).instruction();
    await expectErr(T.sendIxs([placeIx, anchorIx], [eve]), "NotReady");
    const b1 = await placeV2(eve, 0, 0, 1, 0.1 * XNT);
    let bet = await acc.bet.fetch(b1.pk);
    expect(bet.game).to.equal(0x80);
    const { index, anchor } = betUnpack(big(bet.targetSlot));
    expect(index).to.equal(0n);
    let k = await ks();
    expect(k.pendingBets).to.equal(1);
    expect(k.nextIndex.toNumber()).to.equal(1);
    await expectErr(settleV2B(b1, chain.reveal(0)).rpc(), "NotReady"); // BET_ANCHORED first
    await expectErr(methods.settleBet().accountsPartial({
      config: P.config, bet: b1.pk, playerState: ps, bankrollVault: P.bankroll, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: eve.publicKey,
    }).rpc(), "KeeperRequired");
    await anchorWhenReady(b1);
    bet = await acc.bet.fetch(b1.pk);
    expect(bet.game).to.equal(0xc0);
    const h = (await T.slotHashAtOrAfter(anchor))!;
    expect(Buffer.from(bet.seed).equals(mixedSeed(b1.seed, h))).to.equal(true);
    await expectErr(anchorB(b1).rpc(), "InvalidTarget"); // anchored once
    await expectErr(settleV2B(b1, Buffer.alloc(32, 9)).rpc(), "BadReveal");
    const r1 = await settleBet(b1);
    k = await ks();
    expect(k.revealed.toNumber()).to.equal(1);
    expect(k.pendingBets).to.equal(0);
    expect((await cfg()).bankrollReserved.toNumber()).to.equal(0);
    const stakeIn = BigInt(0.1 * XNT) - BigInt(0.0015 * XNT);
    expect(big(k.weekNetLoss)).to.equal(r1.won ? r1.payout - stakeIn : -stakeIn);
    // chain order: the second of two bets cannot be revealed first
    const b2 = await placeV2(eve, 1, 5000, 0, 0.05 * XNT);
    const b3 = await placeV2(eve, 2, 20_000, 0, 0.05 * XNT);
    await anchorWhenReady(b2);
    await anchorWhenReady(b3);
    await expectErr(settleV2B(b3, chain.reveal(2)).rpc(), "BadReveal");
    await settleBet(b2);
    await settleBet(b3);
    // K-5: a re-arm with the current head is refused
    k = await ks();
    await expectErr(armB(keeper, Buffer.from(k.tip), 10, 0).rpc(), "BadReveal");
    // chain exhaustion: length 2, the third bet has no position; no re-arm under a pending bet
    newChain(2);
    await armB(keeper, chain.tip, 2, 30 * XNT).rpc();
    const b4 = await placeV2(eve, 0, 0, 0, 0.05 * XNT);
    const b5 = await placeV2(eve, 0, 0, 1, 0.05 * XNT);
    await expectErr(placeV2(eve, 0, 0, 1, 0.05 * XNT), "KeeperNotArmed");
    await expectErr(armB(keeper, keccak(Buffer.from("x")), 10, 0).rpc(), "KeeperBusy");
    // B-3: a Jackpot draw with no chain position left refunds at once (reason 3, no penalty); entries closable
    await openGame(alice, 30);
    await openGame(bob, 30);
    const r = (await cfg()).jackpotRound.toNumber();
    await enterJp(alice, r, 0, XNT).rpc();
    await enterJp(bob, r, 1, XNT).rpc();
    const a0 = await gameBal(alice.publicKey);
    const dr = await retry(["RoundRunning"], () => send(drawJp(r, alice.publicKey)));
    const br = event(dr.events, "BetRefunded");
    expect([br.reason, br.penalty.toNumber()]).to.deep.equal([3, 0]);
    expect((await acc.jackpotRound.fetch(P.jackpot(r))).state).to.equal(3);
    await closeJpEntry(r, 0);
    await closeJpEntry(r, 1);
    expect((await gameBal(alice.publicKey)) - a0).to.equal(BigInt(XNT));
    await settleBet(b4);
    await settleBet(b5);
    newChain(400);
    await armB(keeper, chain.tip, 400, 50 * XNT).rpc();
    expect(big((await ks()).bond)).to.equal(100n * BigInt(XNT));
  });

  // ─── B-3 Jackpot (K-1 / K-3 / ECO-2) ───────────────────────────────────────
  it("B-3: Jackpot v3: 20 XNT cap, draw reserves a chain position, settle in chain order with the keeper reveal, winner by the TS mirror", async () => {
    const r = (await cfg()).jackpotRound.toNumber();
    await enterJp(alice, r, 0, 15 * XNT).rpc();
    await expectErr(enterJp(bob, r, 1, 6 * XNT).rpc(), "PotFull");
    await enterJp(bob, r, 1, 5 * XNT).rpc();
    const bp = await placeV2(eve, 0, 0, 0, 0.05 * XNT); // an earlier position, still unrevealed at the draw
    const p = betUnpack(big((await acc.bet.fetch(bp.pk)).targetSlot)).index;
    const k0 = await ks();
    await retry(["RoundRunning"], () => drawJp(r, alice.publicKey).rpc());
    const round = await acc.jackpotRound.fetch(P.jackpot(r));
    expect(round.state).to.equal(1);
    expect(round.winningTicket.toString()).to.equal(U64_MAX.toString());
    expect(betUnpack(big(round.targetSlot)).index).to.equal(p + 1n);
    let k = await ks();
    expect(k.pendingBets).to.equal(k0.pendingBets + 1);
    expect(big(k.jackpotReserved)).to.equal(20n * BigInt(XNT));
    await expectErr(methods.settleJackpot().accountsPartial({
      config: P.config, round: P.jackpot(r), entry: P.jpEntry(r, 0), winnerState: P.player(alice.publicKey), rewardVault: P.reward, drawVault: P.draw,
      architect: (await cfg()).architect, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
    }).rpc(), "KeeperRequired");
    const reveal = chain.reveal(p + 1n);
    const w = await jackpotWinnerIndex(r, reveal);
    await expectErr((await settleJpV2B(r, w.i, reveal)).rpc(), "BadReveal"); // position p comes first
    const after = await placeV2(eve, 0, 0, 1, 0.05 * XNT); // a bet after the draw takes a later position: the winner cannot change
    await settleBet(bp);
    await expectErr((await settleJpV2B(r, 1 - w.i, reveal)).rpc(), "NotWinningEntry");
    const wb0 = await gameBal(w.player), pool0 = big(await bal(P.reward)), arch0 = big(await bal(architect.publicKey)), draw0 = await bal(P.draw);
    const st = await send(await settleJpV2B(r, w.i, reveal));
    const js = event(st.events, "JackpotSettled");
    expect(big(js.winningTicket)).to.equal(w.ticket);
    expect((await gameBal(w.player)) - wb0).to.equal(196n * BigInt(XNT) / 10n);
    expect(big(await bal(P.reward)) - pool0).to.equal(3n * BigInt(XNT) / 10n);
    expect(big(await bal(architect.publicKey)) - arch0).to.equal(BigInt(XNT) / 10n);
    expect(await bal(P.draw)).to.equal(draw0);
    k = await ks();
    expect(big(k.jackpotReserved)).to.equal(0n);
    await settleBet(after);
    expect((await ks()).pendingBets).to.equal(0);
    // a settled round: the entries close permissionlessly (rent back to their payers, nothing else moves)
    const wbal = await gameBal(w.player);
    await closeJpEntry(r, 0);
    await closeJpEntry(r, 1);
    expect(await gameBal(w.player)).to.equal(wbal);
    // a round nobody else joined is refunded in full, without a chain position
    const r2 = r + 1;
    const c0 = await gameBal(carol.publicKey).catch(() => 0n);
    await openGame(carol, 2);
    const c1 = await gameBal(carol.publicKey);
    await enterJp(carol, r2, 0, XNT).rpc();
    const n0 = (await ks()).nextIndex.toNumber();
    await retry(["RoundRunning"], () => drawJp(r2, carol.publicKey).rpc());
    expect(await gameBal(carol.publicKey)).to.equal(c1);
    expect((await ks()).nextIndex.toNumber()).to.equal(n0);
    await closeJpEntry(r2, 0);
    expect(await gameBal(carol.publicKey)).to.equal(c1);
    void c0;
  });

  it("B-1/B-3: stall cases are set up (an unanchored bet, an anchored bet never revealed, a DRAWING round never settled)", async () => {
    const r = (await cfg()).jackpotRound.toNumber();
    await enterJp(alice, r, 0, 2 * XNT).rpc();
    await enterJp(bob, r, 1, 3 * XNT).rpc();
    await retry(["RoundRunning"], () => drawJp(r, alice.publicKey).rpc());
    const q = betUnpack(big((await acc.jackpotRound.fetch(P.jackpot(r))).targetSlot)).index;
    const s0 = await placeV2(eve, 0, 0, 0, 0.1 * XNT);
    const s1 = await placeV2(eve, 0, 0, 1, 0.1 * XNT);
    await anchorWhenReady(s1);
    stallGroup = { jp: r, s0, s1, positions: [q, q + 1n, q + 2n] };
    expect(betUnpack(big((await acc.bet.fetch(s1.pk)).targetSlot)).index).to.equal(q + 2n);
  });

  // ─── B-7 Artifacts (PX, split, market) ─────────────────────────────────────
  let lunarA: PublicKey, lunarB: PublicKey;
  it("B-7: forge Lunar at 10: 50/20/25/5 split (floor, base pot, extra pot, architect), price ×1.02, PX decay by the TS mirror, ChipsRetired", async () => {
    const r0 = big(await bal(P.reward)), x0 = big(await bal(P.extraVault)), a0 = big(await bal(architect.publicKey)), d0 = await bal(P.draw);
    const xs0 = await xs();
    const f1 = await forge(alice, 0, BN(10 * XNT));
    expect(f1.price).to.equal(10n * BigInt(XNT));
    const sp = forgeSplit(f1.price);
    expect(sp.backing).to.equal(5n * BigInt(XNT));
    expect(big(await bal(P.reward)) - r0).to.equal(2n * BigInt(XNT));
    expect(big(await bal(P.extraVault)) - x0).to.equal(25n * BigInt(XNT) / 10n);
    expect(big(await bal(architect.publicKey)) - a0).to.equal(BigInt(XNT) / 2n);
    expect(await bal(P.draw)).to.equal(d0);
    const record = await acc.artifactRecord.fetch(P.artifact(f1.asset));
    expect(big(record.backing)).to.equal(sp.backing);
    const xs1 = await xs();
    expect(big(xs1.accounted) - big(xs0.accounted)).to.equal(sp.extra);
    expect(big(xs1.liveForgedBacking) - big(xs0.liveForgedBacking)).to.equal(sp.backing);
    let c = await cfg();
    expect(big(c.artifactPrice[0])).to.equal(nextPrice(f1.price, 0));
    expect(big(c.artifactPrice[0])).to.equal(102n * BigInt(XNT) / 10n);
    const data = (await connection.getAccountInfo(f1.asset))!.data;
    const attr = (k: string, v: string) => Buffer.concat([u32(k.length), Buffer.from(k), u32(v.length), Buffer.from(v)]);
    expect(data.includes(attr("Forge Price XNT", "10"))).to.equal(true);
    expect(data.includes(attr("Floor XNT", "5"))).to.equal(true);
    expect(data.includes(Buffer.from("Burn Boost"))).to.equal(false);
    expect(data.includes(Buffer.from("Weekly Chips"))).to.equal(false);
    lunarA = f1.asset;
    // the next forges pay the price the mirror computes from config + the block time (1 s decay periods on localnet)
    const mirrorOk = (f: { price: bigint; before: any; info: { blockTime: number } }, t: number) =>
      [0, -1, 1].some((d) => currentPrice(f.before, t, f.info.blockTime + d) === f.price);
    await expectErr(forge(bob, 0, BN(1)), "SlippageExceeded");
    const f2 = await forge(bob, 0);
    expect(mirrorOk(f2, 0), `PX mirror: paid ${f2.price}`).to.equal(true);
    lunarB = f2.asset;
    await T.untilChainTime(f2.info.blockTime + 2); // two decay periods on the validator clock (it can lag the host clock)
    c = await cfg();
    const f3 = await forge(carol, 0);
    expect(f3.price < big(c.artifactPrice[0])).to.equal(true); // decayed by >= 2 periods
    expect(mirrorOk(f3, 0)).to.equal(true);
    const f4 = await forge(dave, 1); // Cosmic
    expect(f4.price).to.equal(25n * BigInt(XNT));
    expect(big((await cfg()).artifactPrice[1])).to.equal(2625n * BigInt(XNT) / 100n);
    await openGame(alice, 0);
    await expectErr(methods.claimArtifactChips().accountsPartial({
      config: P.config, asset: lunarA, record: P.artifact(lunarA), collection: P.collection, playerState: P.player(alice.publicKey), owner: alice.publicKey,
    }).signers([alice]).rpc(), "ChipsRetired");
    expect((await acc.playerState.fetch(P.player(alice.publicKey))).chips.toNumber()).to.equal(0);
  });

  const listB = (seller: Keypair, asset: PublicKey, price: bigint, expires: number, reserved = PublicKey.default) =>
    methods.listArtifact(BN(price), BN(expires), reserved, false).accountsPartial({
      config: P.config, listing: P.listing(asset), asset, record: P.artifact(asset), collection: P.collection, seller: seller.publicKey, coreProgram: MPL_CORE, systemProgram: SYS,
    }).signers([seller]);
  const buyB = async (buyer: Keypair, asset: PublicKey, price: bigint) => {
    const l = await acc.listing.fetch(P.listing(asset));
    return methods.buyArtifact(BN(price)).accountsPartial({
      config: P.config, listing: P.listing(asset), asset, record: P.artifact(asset), collection: P.collection, buyer: buyer.publicKey, seller: l.seller,
      architect: (await cfg()).architect, rewardVault: P.reward, coreProgram: MPL_CORE, systemProgram: SYS,
    }).signers([buyer]);
  };
  const updateB = (seller: Keypair, asset: PublicKey, price: bigint, expires: number, reserved = PublicKey.default) =>
    methods.updateListing(BN(price), BN(expires), reserved).accountsPartial({
      config: P.config, listing: P.listing(asset), asset, record: P.artifact(asset), collection: P.collection, seller: seller.publicKey, coreProgram: MPL_CORE, systemProgram: SYS,
    }).signers([seller]);
  const delistB = (seller: Keypair, asset: PublicKey) => methods.delistArtifact().accountsPartial({
    config: P.config, listing: P.listing(asset), asset, collection: P.collection, seller: seller.publicKey, coreProgram: MPL_CORE, systemProgram: SYS,
  }).signers([seller]);
  const closeListingB = async (asset: PublicKey) => {
    const l = await acc.listing.fetch(P.listing(asset));
    return methods.closeListing().accountsPartial({ config: P.config, listing: P.listing(asset), seller: l.seller, asset, collection: P.collection });
  };

  it("B-7: market: floor rule, expiry and self checks, public sale (5% royalty + 2% pool), private sale, M-2 update after A→B→A, stale / expired / live closes, delist", async () => {
    const X = BigInt(XNT);
    let now = await T.chainTime();
    const minP = minListPrice(5n * X);
    await expectErr(listB(alice, lunarA, minP - 1n, now + 60).rpc(), "ListingBelowFloor");
    await expectErr(listB(alice, lunarA, 6n * X, now + 200).rpc(), "InvalidExpiry");
    await expectErr(listB(alice, lunarA, 6n * X, now + 60, alice.publicKey).rpc(), "SelfPurchase");
    const li = await send(listB(alice, lunarA, 6n * X, now + 60));
    const ev = event(li.events, "ArtifactListed");
    expect(ev.update).to.equal(false);
    expect(big(ev.sellerNet)).to.equal(marketSplit(6n * X).net);
    // TransferDelegate, parsed from the asset's plugin registry: authority Address(listing PDA) while listed
    expect(delegateOf((await connection.getAccountInfo(lunarA))!.data)).to.deep.equal({ authority: CORE_AUTH.Address, address: P.listing(lunarA).toBase58() });
    await expectErr((await buyB(bob, lunarA, 5n * X)).rpc(), "ListingPriceChanged");
    await expectErr((await buyB(alice, lunarA, 6n * X)).rpc(), "SelfPurchase");
    const s0 = big(await bal(alice.publicKey)), arch0 = big(await bal(architect.publicKey)), pool0 = big(await bal(P.reward));
    const st0 = (await cfg()).stats;
    const listingRent = big(await bal(P.listing(lunarA)));
    const sold = await send(await buyB(bob, lunarA, 6n * X));
    const sp = marketSplit(6n * X);
    const as = event(sold.events, "ArtifactSold");
    expect([big(as.royalty), big(as.poolFee), big(as.sellerNet), as.private]).to.deep.equal([sp.royalty, sp.pool, sp.net, false]);
    expect(big(await bal(alice.publicKey)) - s0).to.equal(sp.net + listingRent);
    expect(big(await bal(architect.publicKey)) - arch0).to.equal(sp.royalty);
    expect(big(await bal(P.reward)) - pool0).to.equal(sp.pool);
    expect((await assetOwner(lunarA)).toBase58()).to.equal(bob.publicKey.toBase58());
    expect(await connection.getAccountInfo(P.listing(lunarA))).to.equal(null);
    expect(delegateOf((await connection.getAccountInfo(lunarA))!.data)).to.deep.equal({ authority: CORE_AUTH.Owner, address: null }); // reset to Owner
    const st1 = (await cfg()).stats;
    expect(big(st1.toArchitect) - big(st0.toArchitect)).to.equal(sp.royalty);
    expect(big(st1.artifactToPool) - big(st0.artifactToPool)).to.equal(sp.pool);
    // private sale: only the reserved buyer
    now = await T.chainTime();
    await listB(bob, lunarA, 6n * X, now + 60, carol.publicKey).rpc();
    await expectErr((await buyB(dave, lunarA, 6n * X)).rpc(), "ListingReserved");
    const ps = await send(await buyB(carol, lunarA, 6n * X));
    expect(event(ps.events, "ArtifactSold").private).to.equal(true);
    // update_listing (M-2): stranger, floor, stale after a transfer; after A→B→A it re-delegates and the sale works
    now = await T.chainTime();
    await listB(carol, lunarA, 6n * X, now + 60).rpc();
    await expectErr(updateB(dave, lunarA, 7n * X, now + 60).rpc(), "");
    await expectErr(updateB(carol, lunarA, minP - 1n, now + 60).rpc(), "ListingBelowFloor");
    await coreTransfer(lunarA, carol, dave.publicKey);
    await expectErr(updateB(carol, lunarA, 7n * X, now + 60).rpc(), "ListingStale");
    await expectErr((await buyB(bob, lunarA, 6n * X)).rpc(), "ListingStale");
    await coreTransfer(lunarA, dave, carol.publicKey);
    expect(delegateOf((await connection.getAccountInfo(lunarA))!.data).authority).to.equal(CORE_AUTH.Owner); // A→B→A reset it
    const up = await send(updateB(carol, lunarA, 7n * X, now + 60));
    expect(event(up.events, "ArtifactListed").update).to.equal(true);
    expect(delegateOf((await connection.getAccountInfo(lunarA))!.data)).to.deep.equal({ authority: CORE_AUTH.Address, address: P.listing(lunarA).toBase58() });
    await send(await buyB(bob, lunarA, 7n * X));
    expect((await assetOwner(lunarA)).toBase58()).to.equal(bob.publicKey.toBase58());
    // a live listing only leaves through the seller; delist gives the rent back
    now = await T.chainTime();
    await listB(bob, lunarB, 6n * X, now + 60).rpc();
    await expectErr((await closeListingB(lunarB)).rpc(), "ListingActive");
    const b0 = big(await bal(bob.publicKey));
    const dl = await send(delistB(bob, lunarB));
    expect(event(dl.events, "ArtifactDelisted").reason).to.equal(0);
    expect(delegateOf((await connection.getAccountInfo(lunarB))!.data)).to.deep.equal({ authority: CORE_AUTH.Owner, address: null }); // back to Owner
    expect(big(await bal(bob.publicKey)) > b0).to.equal(true);
    // expired listing: no sale, anyone closes it (reason 2)
    now = await T.chainTime();
    await listB(bob, lunarB, 6n * X, now + 3).rpc();
    await T.untilChainTime(now + 4);
    await expectErr((await buyB(carol, lunarB, 6n * X)).rpc(), "ListingExpired");
    const ce = await send(await closeListingB(lunarB));
    expect(event(ce.events, "ArtifactDelisted").reason).to.equal(2);
    // recycled while listed: stale (reason 1), closed by anyone, rent to the seller
    now = await T.chainTime();
    await listB(bob, lunarA, 6n * X, now + 60).rpc();
    const xb = await xs();
    await recycle(bob, lunarA);
    const xa = await xs();
    expect(big(xb.liveForgedBacking) - big(xa.liveForgedBacking)).to.equal(5n * X);
    expect(big(xa.outSincePublish) - big(xb.outSincePublish)).to.equal(5n * X);
    const cs = await send(await closeListingB(lunarA));
    expect(event(cs.events, "ArtifactDelisted").reason).to.equal(1);
  });

  it("B-7: reclaim_orphan: an Artifact burned through Core directly gives its floor to the pool; a live one is ArtifactAlive", async () => {
    const f = await forge(frank, 0);
    const live = await forge(frank, 0);
    const reclaim = (asset: PublicKey) => methods.reclaimOrphan().accountsPartial({
      config: P.config, asset, record: P.artifact(asset), collection: P.collection, rewardVault: P.reward, extraState: P.extraState,
    });
    await expectErr(reclaim(live.asset).rpc(), "ArtifactAlive");
    await coreBurn(f.asset, frank);
    const recLamports = big(await bal(P.artifact(f.asset)));
    const pool0 = big(await bal(P.reward)), x0 = await xs();
    const rc = await send(reclaim(f.asset));
    expect(event(rc.events, "ArtifactRecycled").orphan).to.equal(true);
    expect(big(await bal(P.reward)) - pool0).to.equal(recLamports);
    expect(big(x0.liveForgedBacking) - big((await xs()).liveForgedBacking)).to.equal(f.backing);
    expect(await connection.getAccountInfo(P.artifact(f.asset))).to.equal(null);
  });

  // ─── B-9 Oracle seat ───────────────────────────────────────────────────────
  const voidB = (n: number, k: Keypair, bond: bigint, rem: PublicKey[] = []) => methods.voidEpoch(BN(n), BN(bond)).accountsPartial({
    config: P.config, epoch: P.epoch(n), seat: P.seat, rewardVault: P.reward, voider: k.publicKey, systemProgram: SYS,
  }).remainingAccounts(rem.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))).signers([k]);
  it("B-9: a void inside the hold costs 10% of the budget (to the pool) and gives priority; a cold void waives the interval once; rotate_hot", async () => {
    const t3 = tree([claimLeaf(3, alice.publicKey, 0, 10n)]);
    await retry(["EpochTooSoon"], () => publish(3, t3.root, 10n, 1).rpc());
    const e3 = await acc.epoch.fetch(P.epoch(3));
    const need = voidBond(big(e3.budget));
    await expectErr(voidB(3, dave, need - 1n).rpc(), "BondTooSmall");
    const pool0 = big(await bal(P.reward)), res0 = big((await cfg()).rewardReserved);
    const v = await send(voidB(3, dave, need));
    const ev = event(v.events, "EpochVoided");
    expect([big(ev.bond), big(ev.returnedToPool), ev.byCold]).to.deep.equal([need, big(e3.budget), false]);
    expect(big(await bal(P.reward)) - pool0).to.equal(need);
    expect(res0 - big((await cfg()).rewardReserved)).to.equal(big(e3.budget));
    const seat = await acc.oracleSeat.fetch(P.seat);
    expect(seat.priority.toBase58()).to.equal(dave.publicKey.toBase58());
    expect(big(seat.priorityBond)).to.equal(need);
    await expectErr(claimInstantB(3, { p: alice.publicKey, t: 0, s: 10n }, t3.proof(0), alice).rpc(), "EpochClosed");
    await expectErr(voidB(3, dave, need).rpc(), "EpochClosed");
    const t4 = tree([claimLeaf(4, alice.publicKey, 0, 10n)]);
    await expectErr(publish(4, t4.root, 10n, 1).rpc(), "EpochTooSoon"); // a non-cold void keeps the interval
    await retry(["EpochTooSoon"], () => publish(4, t4.root, 10n, 1).rpc());
    await expectErr(voidB(4, cold, 0n, [P.epoch(2)]).rpc(), "BadEpochWindow"); // the waiver witness must be Epoch(id − 1)
    const cv = await send(voidB(4, cold, 0n, [P.epoch(3)]));
    expect(event(cv.events, "EpochVoided").byCold).to.equal(true);
    expect((await cfg()).lastPublishTs.toNumber()).to.equal(0); // S-2
    const rot = (k: Keypair, nh: PublicKey) => methods.rotateHot(nh).accountsPartial({ config: P.config, seat: P.seat, cold: k.publicKey }).signers([k]);
    await expectErr(rot(dave, newHot.publicKey).rpc(), "OnlyCold");
    await expectErr(rot(cold, cold.publicKey).rpc(), "InvalidTarget");
    const ro = await send(rot(cold, newHot.publicKey));
    expect(event(ro.events, "OracleChanged").by).to.equal(1);
    const t5 = tree([claimLeaf(5, alice.publicKey, 0, 10n)]);
    await expectErr(publish(5, t5.root, 10n, 1, oracle).rpc(), "OnlyOracle"); // the stolen key is dead
    hot = newHot;
    await publish(5, t5.root, 10n, 1).rpc(); // at once: the cold void waived the interval
    expect((await cfg()).lastEpoch.toNumber()).to.equal(5);
  });

  // ─── B-10 Extra pot ────────────────────────────────────────────────────────
  const claimExtraB = (n: number, i: number, w: PublicKey, amount: bigint, proof: number[][], payerK = payer) =>
    methods.claimExtra(BN(n), i, BN(amount), proof).accountsPartial({
      config: P.config, extraState: P.extraState, extraEpoch: P.extraEpoch(n), extraVault: P.extraVault, wallet: w, payer: payerK.publicKey, systemProgram: SYS,
    }).signers(payerK === payer ? [] : [payerK]);
  const voidExtraB = (n: number, k: Keypair, bond: bigint) => methods.voidExtraEpoch(BN(n), BN(bond)).accountsPartial({
    config: P.config, extraState: P.extraState, extraEpoch: P.extraEpoch(n), epoch: P.epoch(n), seat: P.seat, rewardVault: P.reward, voider: k.publicKey, systemProgram: SYS,
  }).signers([k]);
  const extraBound = (x: any, weeks = 1n) => {
    const free = big(x.accounted) - big(x.reserved);
    const backing = big(x.liveForgedBacking) + big(x.outSincePublish);
    const a = (free * 800n) / 10_000n, b = ((backing * 400n) / 10_000n) * weeks;
    return a < b ? a : b;
  };
  let X3: { amounts: bigint[]; wallets: PublicKey[]; total: bigint; tr: ReturnType<typeof tree> };
  it("B-10: extra pot: oracle only, in order, base epoch required, weeks bound, heartbeats, 8%/4% bound ignores stray lamports, hold, bitmap, X-1, S-1 void bond, recycle bookkeeping", async () => {
    const zero = Buffer.alloc(32);
    await expectErr(publishExtra(1, zero, 0n, 0, stranger).rpc(), "OnlyOracle");
    await expectErr(publishExtra(2, zero, 0n, 0).rpc(), "ExtraEpochOrder");
    await expectErr(publishExtra(6, zero, 0n, 0).rpc(), "ExtraBaseEpochMissing");
    await expectErr(publishExtra(1, zero, 0n, 0, hot, 2).rpc(), "BadEpochWindow"); // epoch 1: one week
    const h1 = await send(publishExtra(1, zero, 0n, 0));
    expect(event(h1.events, "ExtraEpochPublished").weeks).to.equal(1);
    await publishExtra(2, zero, 0n, 0).rpc(); // heartbeats need no interval (X-3)
    let x = await xs();
    const bound = extraBound(x);
    expect(bound > 10_000_000n).to.equal(true);
    const total = bound - (bound % 2n);
    const wallets = [fresh.publicKey, alice.publicKey, bob.publicKey, carol.publicKey];
    const amounts = [1_000_000n, total / 2n - 1_000_000n, total / 2n, total]; // Σ = 2 × total
    const tr = tree(wallets.map((w, i) => extraLeaf(3, i, w, amounts[i])));
    await expectErr(publishExtra(3, tr.root, bound + 1n, 4).rpc(), "ExtraBudgetExceeded");
    await provider.sendAndConfirm(new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: P.extraVault, lamports: 50 * XNT })));
    expect(extraBound(await xs())).to.equal(bound); // stray lamports are not counted
    await expectErr(publishExtra(3, tr.root, bound + 1n, 4).rpc(), "ExtraBudgetExceeded");
    // the two "too early" refusals ride in ONE transaction with the publish (one clock): on a slow host the 2-s hold
    // or the 6-s interval could end before a separate check lands (r5, 2026-10-25); the refused transaction reverts the
    // publish with it, which is then sent alone
    const p3Ix = await publishExtra(3, tr.root, total, 4).instruction();
    await expectErr(T.sendIxs([p3Ix, await claimExtraB(3, 0, fresh.publicKey, amounts[0], tr.proof(0)).instruction()], [payer, hot]), "ClaimOnHold");
    await expectErr(T.sendIxs([p3Ix, await publishExtra(4, zero, 1n, 1).instruction()], [payer, hot]), "ExtraEpochOrder"); // real extras 6 s apart
    const p3 = await send(publishExtra(3, tr.root, total, 4));
    expect(big(event(p3.events, "ExtraEpochPublished").total)).to.equal(total);
    X3 = { amounts, wallets, total, tr };
    expect(await bal(fresh.publicKey)).to.equal(0);
    const c0 = await retry(["ClaimOnHold"], () => send(claimExtraB(3, 0, fresh.publicKey, amounts[0], tr.proof(0))));
    expect(big(event(c0.events, "ExtraClaimed").amount)).to.equal(amounts[0]);
    expect(await bal(fresh.publicKey)).to.equal(Number(amounts[0])); // a fresh wallet with 0 lamports receives 0.001 XNT
    await expectErr(claimExtraB(3, 0, fresh.publicKey, amounts[0], tr.proof(0)).rpc(), "ExtraAlreadyClaimed");
    await expectErr(claimExtraB(3, 1, alice.publicKey, amounts[1] + 1n, tr.proof(1)).rpc(), "InvalidProof");
    await claimExtraB(3, 1, alice.publicKey, amounts[1], tr.proof(1)).rpc();
    await claimExtraB(3, 2, bob.publicKey, amounts[2], tr.proof(2), dave).rpc();
    expect(big((await acc.extraEpoch.fetch(P.extraEpoch(3))).claimed)).to.equal(total);
    await expectErr(claimExtraB(3, 3, carol.publicKey, amounts[3], tr.proof(3)).rpc(), "BudgetExhausted"); // X-1
    x = await xs();
    const vaultFree = big(await bal(P.extraVault)) - big(await rent8());
    expect(vaultFree >= big(x.reserved) && vaultFree >= big(x.accounted)).to.equal(true);
    // a real extra voided by a stranger: the bond is priced on the base epoch too (S-1) and lands in reward_vault
    // the void must land inside the 2-s hold: publish and void in ONE transaction (one clock), so a slow host cannot let
    // the hold end in between (r5 run 2 answered HoldOver); the 6-s interval after extra 3 is waited for by the retry
    const t4 = tree([extraLeaf(4, 0, alice.publicKey, 1_000_000n)]);
    const e4 = await acc.epoch.fetch(P.epoch(4));
    const need = voidBond(big(e4.budget) > 1_000_000n ? big(e4.budget) : 1_000_000n);
    const p4Ix = await publishExtra(4, t4.root, 1_000_000n, 1).instruction();
    const pubVoid = async (bond: bigint) => T.sendIxs([p4Ix, await voidExtraB(4, dave, bond).instruction()], [dave, hot]);
    await expectErr(retry(["ExtraEpochOrder"], () => pubVoid(BigInt(L.VOID_BOND_MIN))), "BondTooSmall");
    const pool0 = big(await bal(P.reward)), xr0 = big((await xs()).reserved);
    const ve = await T.txInfo(await retry(["ExtraEpochOrder"], () => pubVoid(need)));
    coverage.ok("publish_extra_epoch"); coverage.ok("void_extra_epoch"); // B-13: sent raw, recorded here
    expect(big(event(ve.events, "ExtraEpochPublished").total)).to.equal(1_000_000n);
    expect(big(event(ve.events, "ExtraEpochVoided").returnedToPot)).to.equal(1_000_000n);
    expect(big(await bal(P.reward)) - pool0).to.equal(need);
    expect(big((await xs()).reserved), "published and voided in one transaction: the 1,000,000 returned to the pot").to.equal(xr0);
    // recycle: the floor leaves the live forged set and is counted once more for the next bound; the publish resets it
    const f = await forge(frank, 0);
    const xb = await xs();
    await recycle(frank, f.asset);
    const xa = await xs();
    expect(big(xb.liveForgedBacking) - big(xa.liveForgedBacking)).to.equal(f.backing);
    expect(big(xa.outSincePublish) - big(xb.outSincePublish)).to.equal(f.backing);
    const t5 = tree([extraLeaf(5, 0, alice.publicKey, 1_000_000n)]);
    await retry(["ExtraEpochOrder"], () => publishExtra(5, t5.root, 1_000_000n, 1).rpc());
    expect((await xs()).outSincePublish.toNumber()).to.equal(0);
    // no extra instruction debits reward_vault: the vault only grew by the void bond above (checked), never shrank here
  });

  // ─── B-5 Duel / B-6 Wars ───────────────────────────────────────────────────
  const rakeCheck = async (f: () => Promise<any>, pot: bigint) => {
    const pool0 = big(await bal(P.reward)), arch0 = big(await bal(architect.publicKey)), draw0 = await bal(P.draw);
    const r = await f();
    expect(big(await bal(P.reward)) - pool0).to.equal((pot * 150n) / 10_000n);
    expect(big(await bal(architect.publicKey)) - arch0).to.equal((pot * 50n) / 10_000n);
    expect(await bal(P.draw)).to.equal(draw0);
    return r;
  };
  it("B-5: Duel: plain join retired, sealed join (no ticket), no cancel after the join, open + reveal pays 98% (1.5% pool, 0.5% architect), unopened join lapses to the pool", async () => {
    await openGame(alice, 5);
    await openGame(bob, 5);
    const create = async (k: Keypair, stake: number, element: number, salt: Buffer) => {
      const nonce = (await acc.playerState.fetch(P.player(k.publicKey))).nonce.toNumber();
      const duel = P.duel(k.publicKey, nonce);
      await methods.createDuel(BN(stake), Array.from(keccak(Buffer.from("MOONFORGE_DUEL"), Buffer.from([element]), salt, duel.toBuffer()))).accountsPartial({
        config: P.config, creatorState: P.player(k.publicKey), duel, owner: k.publicKey, asset: SYS, record: SYS, collection: SYS, systemProgram: SYS,
      }).signers([k]).rpc();
      return duel;
    };
    const joinAcc = (duel: PublicKey, k: Keypair) => ({ config: P.config, duel, opponentState: P.player(k.publicKey), opponent: k.publicKey, asset: SYS, record: SYS, collection: SYS });
    const resolve = async (duel: PublicKey, opp: Keypair) => ({
      config: P.config, duel, creatorState: P.player(alice.publicKey), opponentState: P.player(opp.publicKey), rewardVault: P.reward, drawVault: P.draw,
      architect: (await cfg()).architect, rentPayer: alice.publicKey,
    });
    const salt = Buffer.alloc(32, 9), jsalt = Buffer.alloc(32, 7);
    const duel = await create(alice, XNT, 0, salt); // Lunar
    await expectErr(methods.joinDuel(1).accountsPartial(joinAcc(duel, bob)).signers([bob]).rpc(), "SealedJoinRequired");
    const jc = keccak(Buffer.from("MOONFORGE_DUEL_JOIN"), Buffer.from([1]), jsalt, duel.toBuffer(), bob.publicKey.toBuffer());
    await expectErr(methods.joinDuelSealed(Array.from(jc)).accountsPartial(joinAcc(duel, alice)).signers([alice]).rpc(), "SelfDuel");
    const jn = await send(methods.joinDuelSealed(Array.from(jc)).accountsPartial(joinAcc(duel, bob)), [bob]);
    await expectErr(methods.cancelDuel().accountsPartial({ duel, creatorState: P.player(alice.publicKey), creator: alice.publicKey }).signers([alice]).rpc(), "DuelState");
    await expectErr(methods.revealDuel(0, Array.from(salt)).accountsPartial({ resolve: await resolve(duel, bob), creator: alice.publicKey }).signers([alice]).rpc(), "DuelState");
    await T.untilChainTime(jn.blockTime + 1);
    await expectErr(methods.revealDuelJoin(2, Array.from(jsalt)).accountsPartial({ duel, opponent: bob.publicKey }).signers([bob]).rpc(), "BadCommitment");
    await retry(["NotReady"], () => methods.revealDuelJoin(1, Array.from(jsalt)).accountsPartial({ duel, opponent: bob.publicKey }).signers([bob]).rpc());
    const bob0 = await gameBal(bob.publicKey);
    const rd = await rakeCheck(async () => send(methods.revealDuel(0, Array.from(salt)).accountsPartial({ resolve: await resolve(duel, bob), creator: alice.publicKey }), [alice]), 2n * BigInt(XNT));
    expect(event(rd.events, "DuelResolved").winner.toBase58()).to.equal(bob.publicKey.toBase58()); // Cosmic beats Lunar
    expect((await gameBal(bob.publicKey)) - bob0).to.equal(196n * BigInt(XNT) / 100n);
    // a sealed join never opened: the creator gets its stake back, the joiner's goes to the pool
    const d2 = await create(alice, 0.5 * XNT, 2, salt);
    await methods.joinDuelSealed(Array.from(keccak(Buffer.from("MOONFORGE_DUEL_JOIN"), Buffer.from([3]), jsalt, d2.toBuffer(), bob.publicKey.toBuffer())))
      .accountsPartial(joinAcc(d2, bob)).signers([bob]).rpc();
    const a0 = await gameBal(alice.publicKey), pool0 = big(await bal(P.reward));
    await retry(["DeadlineNotReached"], async () => methods.claimDuelTimeout().accountsPartial(await resolve(d2, bob)).rpc());
    expect((await gameBal(alice.publicKey)) - a0).to.equal(BigInt(0.5 * XNT));
    expect(big(await bal(P.reward)) - pool0).to.equal(BigInt(0.5 * XNT));
    // an unjoined duel is cancelled with a full refund
    const d3 = await create(alice, 0.2 * XNT, 1, salt);
    const a1 = await gameBal(alice.publicKey);
    await methods.cancelDuel().accountsPartial({ duel: d3, creatorState: P.player(alice.publicKey), creator: alice.publicKey }).signers([alice]).rpc();
    expect((await gameBal(alice.publicKey)) - a1).to.equal(BigInt(0.2 * XNT));
  });

  it("B-6: Moon Wars sealed start: create/join retired, no cancel or settle once joined, seed + reveal (WarSeedOpened), full match pays 98%, both lapses", async () => {
    await openGame(alice, 4);
    await openGame(bob, 4);
    const CARD = [[2, 2, 1], [4, 3, 2], [6, 4, 3], [10, 10, 5]];
    const createSealed = async (stake: number, entropy: Buffer) => {
      const nonce = (await acc.playerState.fetch(P.player(alice.publicKey))).nonce.toNumber();
      const war = P.war(alice.publicKey, nonce);
      await methods.createWarSealed(BN(stake), PublicKey.default, Array.from(keccak(Buffer.from("MOONFORGE_WAR_ENTROPY"), entropy, war.toBuffer()))).accountsPartial({
        config: P.config, creatorState: P.player(alice.publicKey), war, owner: alice.publicKey, asset: SYS, record: SYS, collection: SYS, systemProgram: SYS,
      }).signers([alice]).rpc();
      return war;
    };
    const joinAcc = (war: PublicKey) => ({ config: P.config, war, opponentState: P.player(bob.publicKey), opponent: bob.publicKey, asset: SYS, record: SYS, collection: SYS });
    const joinSealed = (war: PublicKey, secret: Buffer) => methods.joinWarSealed(Array.from(keccak(Buffer.from("MOONFORGE_WAR_JOIN"), secret, war.toBuffer(), bob.publicKey.toBuffer(), PublicKey.default.toBuffer())))
      .accountsPartial(joinAcc(war)).signers([bob]);
    const settleAcc = async (war: PublicKey) => {
      const w = await acc.war.fetch(war);
      return { config: P.config, war, creatorState: P.player(w.creator), opponentState: P.player(w.opponent), rewardVault: P.reward, drawVault: P.draw, architect: (await cfg()).architect, rentPayer: w.rentPayer };
    };
    const move = (war: PublicKey, k: Keypair, m: any) => m.accountsPartial({ war, signer: k.publicKey }).signers([k]).rpc();
    const nonce = (await acc.playerState.fetch(P.player(alice.publicKey))).nonce.toNumber();
    await expectErr(methods.createWar(BN(XNT), PublicKey.default).accountsPartial({
      config: P.config, creatorState: P.player(alice.publicKey), war: P.war(alice.publicKey, nonce), owner: alice.publicKey, asset: SYS, record: SYS, collection: SYS, systemProgram: SYS,
    }).signers([alice]).rpc(), "SealedJoinRequired");
    const entropy = Buffer.alloc(32, 0x11), secret = Buffer.alloc(32, 0x22);
    const war = await createSealed(XNT, entropy);
    await expectErr(methods.joinWar(PublicKey.default).accountsPartial(joinAcc(war)).signers([bob]).rpc(), "SealedJoinRequired");
    await joinSealed(war, secret).rpc();
    await expectErr(methods.cancelWar().accountsPartial({ war, creatorState: P.player(alice.publicKey), creator: alice.publicKey }).signers([alice]).rpc(), "WarState");
    await expectErr(methods.revealWar(Array.from(secret), PublicKey.default).accountsPartial({ war, signer: bob.publicKey }).signers([bob]).rpc(), "WarState");
    await expectErr(methods.seedWar(Array.from(Buffer.alloc(32, 0x12))).accountsPartial({ war, signer: alice.publicKey }).signers([alice]).rpc(), "BadCommitment");
    await methods.seedWar(Array.from(entropy)).accountsPartial({ war, signer: alice.publicKey }).signers([alice]).rpc();
    const rv = await send(methods.revealWar(Array.from(secret), PublicKey.default).accountsPartial({ war, signer: bob.publicKey }), [bob]);
    const so = event(rv.events, "WarSeedOpened");
    expect(Buffer.from(so.creatorEntropy).equals(entropy) && Buffer.from(so.joinerSecret).equals(secret)).to.equal(true);
    expect(event(rv.events, "WarStarted").seed).to.deep.equal(Array.from(keccak(Buffer.from("MOONFORGE_WAR_V2"), entropy, secret, war.toBuffer())));
    await expectErr(methods.settleWar().accountsPartial(await settleAcc(war)).rpc(), "WarState"); // ACTIVE
    // alice plays greedily, bob only ends his turns
    const players = [alice, bob];
    for (let i = 0; i < 400; i++) {
      const w = await acc.war.fetch(war);
      if (w.state !== 2) break;
      const k = players[w.turn];
      if (w.turn === 0) {
        const me = w.sides[0];
        let best = -1;
        for (let j = 0; j < me.handLen; j++) { const c = CARD[me.hand[j]]; if (c[2] <= me.mana && me.fieldLen < 6 && (best < 0 || c[2] > CARD[me.hand[best]][2])) best = j; }
        if (best >= 0) { await move(war, k, methods.warSummon(best)); continue; }
        const ready = me.field.slice(0, me.fieldLen).findIndex((u: any) => u.ready);
        if (ready >= 0) { await move(war, k, methods.warAttack(ready, w.sides[1].fieldLen === 0 ? 255 : 0)); continue; }
      }
      await move(war, k, methods.warEndTurn());
    }
    const done = await acc.war.fetch(war);
    expect(done.state).to.equal(3);
    expect(done.winner.toBase58()).to.equal(alice.publicKey.toBase58());
    const a0 = await gameBal(alice.publicKey);
    await rakeCheck(async () => methods.settleWar().accountsPartial(await settleAcc(war)).rpc(), 2n * BigInt(XNT));
    expect((await gameBal(alice.publicKey)) - a0).to.equal(196n * BigInt(XNT) / 100n);
    // the joiner never reveals: the creator wins on time
    const w2 = await createSealed(0.5 * XNT, entropy);
    await joinSealed(w2, secret).rpc();
    await methods.seedWar(Array.from(entropy)).accountsPartial({ war: w2, signer: alice.publicKey }).signers([alice]).rpc();
    await retry(["DeadlineNotReached"], () => methods.claimWarTimeout().accountsPartial({ war: w2 }).rpc());
    expect((await acc.war.fetch(w2)).winner.toBase58()).to.equal(alice.publicKey.toBase58());
    const a1 = await gameBal(alice.publicKey);
    await methods.settleWar().accountsPartial(await settleAcc(w2)).rpc();
    expect((await gameBal(alice.publicKey)) - a1).to.equal(98n * BigInt(XNT) / 100n);
    // the creator never seeds: a draw, both stakes back
    const w3 = await createSealed(0.3 * XNT, entropy);
    await joinSealed(w3, secret).rpc();
    await retry(["DeadlineNotReached"], () => methods.claimWarTimeout().accountsPartial({ war: w3 }).rpc());
    expect((await acc.war.fetch(w3)).draw).to.equal(true);
    const a2 = await gameBal(alice.publicKey), b2 = await gameBal(bob.publicKey);
    await methods.settleWar().accountsPartial(await settleAcc(w3)).rpc();
    expect([(await gameBal(alice.publicKey)) - a2, (await gameBal(bob.publicKey)) - b2]).to.deep.equal([BigInt(0.3 * XNT), BigInt(0.3 * XNT)]);
    // an unjoined match is cancelled with a full refund
    const w4 = await createSealed(0.2 * XNT, entropy);
    const a3 = await gameBal(alice.publicKey);
    await methods.cancelWar().accountsPartial({ war: w4, creatorState: P.player(alice.publicKey), creator: alice.publicKey }).signers([alice]).rpc();
    expect((await gameBal(alice.publicKey)) - a3).to.equal(BigInt(0.2 * XNT));
  });

  // ─── stalls and expiries ───────────────────────────────────────────────────
  it("B-1/B-3: stalls: anchored-unrevealed pays as a win (reason 1), an expired DRAWING round refunds from the bond (reason 2), an unanchored bet refunds (reason 0), skips; round 4: every house stall is paid by the bond, the bankroll keeps the stake, the pool gets nothing", async () => {
    const g = stallGroup!;
    const X = BigInt(XNT);
    // reason 1: anchored, not revealed within KEEPER_STALL_SLOTS
    const s1 = await acc.bet.fetch(g.s1.pk);
    await T.waitPastSlot(betUnpack(big(s1.targetSlot)).anchor + BigInt(L.KEEPER_STALL_SLOTS) + 1n);
    await expectErr(settleV2B(g.s1, chain.reveal(g.positions[2])).rpc(), "BetStalled");
    let k0 = await ks();
    let pool0 = big(await bal(P.reward)), e0 = await gameBal(eve.publicKey), bank0 = big(await bal(P.bankroll));
    const rf1 = await send(refundB(g.s1));
    const edge = (big(s1.stake) * 150n) / 10_000n, stakeIn = big(s1.stake) - edge;
    const ev1 = event(rf1.events, "BetRefunded");
    expect([ev1.reason, big(ev1.penalty)]).to.deep.equal([1, stakeIn]);
    expect((await gameBal(eve.publicKey)) - e0).to.equal(big(s1.payout));
    expect(big(await bal(P.reward)) - pool0, "round 4: no stall pays the pool").to.equal(0n);
    expect(big(await bal(P.bankroll)) - bank0, "round 4: the bankroll keeps the stake (a lost bet)").to.equal(0n);
    expect(big(k0.bond) - big((await ks()).bond)).to.equal(big(s1.payout));
    expect(big((await ks()).penalties) - big(k0.penalties)).to.equal(stakeIn);
    // reason 2: the DRAWING round's anchor left SlotHashes; every entry is refunded, the bond pays min(bond, pot)
    const round = await acc.jackpotRound.fetch(P.jackpot(g.jp));
    await T.waitHashGone(betUnpack(big(round.targetSlot)).anchor);
    k0 = await ks();
    pool0 = big(await bal(P.reward));
    const ex = await send(await settleJpV2B(g.jp, 0, Buffer.alloc(32, 1)));
    const br = event(ex.events, "BetRefunded");
    expect([br.reason, big(br.penalty)]).to.deep.equal([2, big(round.total)]);
    expect(big(await bal(P.reward)) - pool0).to.equal(big(round.total));
    let k = await ks();
    expect(big(k0.bond) - big(k.bond)).to.equal(big(round.total));
    expect(big(k.jackpotReserved)).to.equal(0n);
    const al0 = await gameBal(alice.publicKey), bo0 = await gameBal(bob.publicKey);
    await closeJpEntry(g.jp, 0);
    await closeJpEntry(g.jp, 1);
    expect([(await gameBal(alice.publicKey)) - al0, (await gameBal(bob.publicKey)) - bo0]).to.deep.equal([2n * X, 3n * X]);
    // reason 0: never anchored; once its block left SlotHashes it cannot be anchored and refunds in full
    const s0 = await acc.bet.fetch(g.s0.pk);
    await T.waitHashGone(betUnpack(big(s0.targetSlot)).anchor);
    await expectErr(anchorB(g.s0).rpc(), "BetStalled");
    k0 = await ks();
    pool0 = big(await bal(P.reward));
    e0 = await gameBal(eve.publicKey);
    bank0 = big(await bal(P.bankroll));
    const seatL0 = big(await bal(P.keeper));
    const rf0 = await send(refundB(g.s0));
    const edge0 = (big(s0.stake) * 150n) / 10_000n;
    const ev0 = event(rf0.events, "BetRefunded");
    expect([ev0.reason, big(ev0.penalty)], "r4-fix: the penalty is the forfeited stake_in").to.deep.equal([0, big(s0.stake) - edge0]);
    expect((await gameBal(eve.publicKey)) - e0, "made whole").to.equal(big(s0.stake));
    expect(big(await bal(P.reward)) - pool0, "round 4: no stall pays the pool").to.equal(0n);
    expect(big(await bal(P.bankroll)) - bank0, "r4-fix: the bankroll returns stake_in (the unanchored bet is undone)").to.equal(-(big(s0.stake) - edge0));
    expect(big(k0.bond) - big((await ks()).bond), "the bond loses the whole stake (was 2 × edge before round 4)").to.equal(big(s0.stake));
    expect(seatL0 - big(await bal(P.keeper)), "r4-fix: only the edge leaves the seat; the forfeited stake_in stays in it, owed to nobody").to.equal(edge0);
    // the keeper skips the three dead positions
    for (const pos of g.positions) await revealKeeperB(chain.reveal(pos)).rpc();
    await expectErr(revealKeeperB(chain.reveal(g.positions[2] + 1n)).rpc(), "BadReveal"); // nothing handed out beyond
    await expectErr(revealKeeperB(chain.reveal(g.positions[2] + 1n), stranger).rpc(), "OnlyKeeper");
    k = await ks();
    expect([k.pendingBets, k.revealed.toString()]).to.deep.equal([0, k.nextIndex.toString()]);
    // K-2 b: a keeper reveal past a pending anchored bet makes it refundable at once as a win
    const b = await placeV2(eve, 0, 0, 0, 0.1 * XNT);
    await anchorWhenReady(b);
    const idx = betUnpack(big((await acc.bet.fetch(b.pk)).targetSlot)).index;
    await expectErr(refundB(b).rpc(), "BetNotStalled");
    await revealKeeperB(chain.reveal(idx)).rpc();
    await expectErr(settleV2B(b, chain.reveal(idx + 1n)).rpc(), "BetStalled");
    const rb = await send(refundB(b));
    expect(event(rb.events, "BetRefunded").reason).to.equal(1);
  });

  it("B-1: keeper withdrawal: request, 3-s notice, busy with a pending bet, keeps >= 20 XNT or 0 (parked), toggle cancels (K-4)", async () => {
    const wd = (amount: bigint | number) => methods.keeperWithdraw(BN(amount)).accountsPartial(keeperOnly(keeper)).signers([keeper]);
    // the "too early" refusal rides in ONE transaction with the request (one clock): a separate withdrawal could land
    // after the 3-s notice on a slow host (r5 run 4 saw that with the hand-over below); the refused transaction reverts
    // the request with it, which is then sent alone
    await expectErr(T.sendIxs([await wd(0).instruction(), await wd(5 * XNT).instruction()], [keeper]), "KeeperNotice");
    await wd(0).rpc();
    const wts = (await ks()).withdrawTs.toNumber();
    expect(wts).to.not.equal(0);
    // the notice runs on the validator clock, which can lag the host clock (acceptance run 9: a 3.5-s sleep was not
    // enough and the check answered KeeperNotice): wait for the notice on chain, then only KeeperBusy can refuse. The
    // wait comes BEFORE the bet: an anchored bet must be settled within KEEPER_STALL_SLOTS (40 slots, ~18 s here) of
    // its placement, and a chain-clock wait inside that window let it stall on a slower run (r5, 2026-10-25)
    await T.untilChainTime(wts + L.KEEPER_NOTICE + 1);
    const b = await placeV2(eve, 0, 0, 1, 0.05 * XNT);
    await expectErr(wd(5 * XNT).rpc(), "KeeperBusy");
    await settleBet(b);
    const bond = big((await ks()).bond);
    const kb0 = big(await bal(keeper.publicKey));
    await retry(["KeeperNotice"], () => wd(bond - 20n * BigInt(XNT)).rpc());
    expect(big((await ks()).bond)).to.equal(20n * BigInt(XNT));
    expect(big(await bal(keeper.publicKey)) - kb0 > bond - 21n * BigInt(XNT)).to.equal(true);
    await expectErr(wd(1).rpc(), "KeeperBondTooSmall");
    await wd(0).rpc();
    await T.untilChainTime((await ks()).withdrawTs.toNumber() + L.KEEPER_NOTICE + 1); // the notice on the validator clock, never a host-clock sleep
    await retry(["KeeperNotice"], () => wd(20n * BigInt(XNT)).rpc());
    expect((await ks()).bond.toNumber()).to.equal(0);
    await expectErr(placeV2(eve, 0, 0, 1, 0.05 * XNT), "KeeperBondTooSmall"); // parked
    await wd(0).rpc();
    await wd(0).rpc();
    expect((await ks()).withdrawTs.toNumber()).to.equal(0); // the second request cancels the first
    newChain(400);
    await armB(keeper, chain.tip, 400, 60 * XNT).rpc();
  });

  // ─── B-2 Keeper seat ───────────────────────────────────────────────────────
  it("B-2: keeper hand-over: named successor after the notice gets the seat, old bond returned in full; and back", async () => {
    const take = (k: Keypair, c: KeeperChain, deposit: number, old: PublicKey) => methods.takeKeeper(Array.from(c.tip), BN(c.length), BN(deposit)).accountsPartial({
      config: P.config, keeperSeat: P.keeper, oldKeeper: old, taker: k.publicKey, rewardVault: P.reward, systemProgram: SYS,
    }).signers([k]);
    const c2 = new KeeperChain(Buffer.alloc(32, 0x5a), 50);
    // both refusals ride in ONE transaction with the proposal (one clock): on a slow host a separate take landed after the
    // 3-s notice and succeeded (r5 run 4), which handed the seat over early and broke every suite after it; the refused
    // transaction reverts the proposal with it, which is then sent alone
    const proposeIx = await methods.proposeKeeper(keeper2.publicKey).accountsPartial(keeperOnly(keeper)).instruction();
    await expectErr(T.sendIxs([proposeIx, await take(keeper2, c2, 20 * XNT, keeper.publicKey).instruction()], [keeper2, keeper]), "KeeperNotice");
    await expectErr(T.sendIxs([proposeIx, await take(stranger, c2, 20 * XNT, keeper.publicKey).instruction()], [stranger, keeper]), "KeeperAlive");
    await methods.proposeKeeper(keeper2.publicKey).accountsPartial(keeperOnly(keeper)).signers([keeper]).rpc();
    await T.untilChainTime((await ks()).pendingTs.toNumber() + L.KEEPER_NOTICE + 1); // the notice on the validator clock, never a host-clock sleep
    const bond = big((await ks()).bond), k10 = big(await bal(keeper.publicKey));
    const tk = await retry(["KeeperNotice"], () => send(take(keeper2, c2, 20 * XNT, keeper.publicKey)));
    expect(event(tk.events, "KeeperChanged").by).to.equal(0);
    expect(big(await bal(keeper.publicKey)) - k10).to.equal(bond);
    expect((await ks()).keeper.toBase58()).to.equal(keeper2.publicKey.toBase58());
    // and back to the fixture keeper (the stress suite and the kit run with it)
    await methods.proposeKeeper(keeper.publicKey).accountsPartial(keeperOnly(keeper2)).signers([keeper2]).rpc();
    await T.untilChainTime((await ks()).pendingTs.toNumber() + L.KEEPER_NOTICE + 1); // the notice on the validator clock, never a host-clock sleep
    newChain(400);
    await retry(["KeeperNotice"], () => take(keeper, chain, 60 * XNT, keeper2.publicKey).rpc());
    expect((await ks()).keeper.toBase58()).to.equal(keeper.publicKey.toBase58());
  });

  // ─── B-8 tail: expiry, receipts ────────────────────────────────────────────
  it("B-8: expire_epoch after the 90-s window returns the unclaimed budget; close_receipt refunds the receipt rent to its payer", async () => {
    for (const n of [1, 2]) {
      const e = await acc.epoch.fetch(P.epoch(n));
      await T.untilChainTime(e.expiresAt.toNumber() + 1);
      const res0 = big((await cfg()).rewardReserved);
      const ee = await retry(["ClaimWindowOpen"], () => send(methods.expireEpoch().accountsPartial({ config: P.config, epoch: P.epoch(n) })));
      expect(big(event(ee.events, "EpochExpired").returnedToPool)).to.equal(big(e.budget) - big(e.claimed));
      expect(res0 - big((await cfg()).rewardReserved)).to.equal(big(e.budget) - big(e.claimed));
    }
    const r = await acc.claimReceipt.fetch(P.receipt(1, alice.publicKey, 0));
    expect(r.rentPayer.toBase58()).to.equal(dave.publicKey.toBase58());
    const d0 = await bal(dave.publicKey), rr = await bal(P.receipt(1, alice.publicKey, 0));
    await methods.closeReceipt().accountsPartial({ epoch: P.epoch(1), receipt: P.receipt(1, alice.publicKey, 0), rentPayer: dave.publicKey }).rpc();
    expect((await bal(dave.publicKey)) - d0).to.equal(rr);
    await methods.closeReceipt().accountsPartial({ epoch: P.epoch(2), receipt: P.receipt(2, alice.publicKey, 0), rentPayer: alice.publicKey }).rpc();
    await expectErr(methods.expireEpoch().accountsPartial({ config: P.config, epoch: P.epoch(1) }).rpc(), "EpochClosed");
  });

  it("B-10: after the 90-s window: ExtraClaimWindow, close returns budget − claimed (rent to the oracle that paid it), voided and heartbeat epochs close with 0", async () => {
    const x5 = await acc.extraEpoch.fetch(P.extraEpoch(5));
    await T.untilChainTime(x5.publishedAt.toNumber() + L.CLAIM_WINDOW + 1);
    await expectErr(claimExtraB(3, 3, carol.publicKey, X3.amounts[3], X3.tr.proof(3)).rpc(), "ExtraClaimWindow");
    const closeX = (n: number, rp: PublicKey) => methods.closeExtraEpoch().accountsPartial({ extraState: P.extraState, extraEpoch: P.extraEpoch(n), rentPayer: rp });
    await expectErr(closeX(3, stranger.publicKey).rpc(), "WrongRentPayer"); // X-2
    for (const n of [1, 2, 3, 4]) {
      const ce = await send(closeX(n, newHot.publicKey));
      expect(big(event(ce.events, "ExtraEpochClosed").returned)).to.equal(0n);
    }
    const x0 = await xs(), h0 = await bal(newHot.publicKey), rent = await bal(P.extraEpoch(5));
    const c5 = await send(closeX(5, newHot.publicKey));
    expect(big(event(c5.events, "ExtraEpochClosed").returned)).to.equal(1_000_000n);
    const x1 = await xs();
    expect(big(x0.reserved) - big(x1.reserved)).to.equal(1_000_000n);
    expect(big(x1.totalReturned) - big(x0.totalReturned)).to.equal(1_000_000n);
    expect((await bal(newHot.publicKey)) - h0).to.equal(rent);
  });

  // ─── B-9 tail: hand-over back, dead seat ───────────────────────────────────
  it("B-9: two-step oracle hand-over; a seat with no surviving epoch for 28 s is taken by the priority voider (bond forfeited to the pool)", async () => {
    const oo = (k: Keypair) => ({ config: P.config, signer: k.publicKey });
    await expectErr(methods.proposeOracle(oracle.publicKey).accountsPartial(oo(oracle)).signers([oracle]).rpc(), "OnlyOracle");
    // round 4 (review R9): the architect payee is never the oracle key: propose_oracle refuses it ...
    await expectErr(methods.proposeOracle(architect.publicKey).accountsPartial(oo(newHot)).signers([newHot]).rpc(), "InvalidTarget");
    const pr = await send(methods.proposeOracle(oracle.publicKey).accountsPartial(oo(newHot)), [newHot]);
    expect(event(pr.events, "OracleHandoverProposed").pendingOracle.toBase58()).to.equal(oracle.publicKey.toBase58());
    await expectErr(methods.acceptOracle().accountsPartial(oo(stranger)).signers([stranger]).rpc(), "NotPendingOracle");
    // ... and accept_oracle refuses a pending key that set_architect made the payee after the proposal
    const setArchTo = (from: Keypair, to: Keypair) => methods.setArchitect(to.publicKey).accountsPartial({
      config: P.config, architect: from.publicKey, newArchitect: to.publicKey, rewardVault: P.reward,
    }).remainingAccounts([{ pubkey: to.publicKey, isSigner: true, isWritable: false }]).signers([from, to]);
    await send(setArchTo(architect, oracle));
    await expectErr(methods.acceptOracle().accountsPartial(oo(oracle)).signers([oracle]).rpc(), "InvalidTarget");
    await send(setArchTo(oracle, architect));
    expect((await cfg()).architect.toBase58()).to.equal(architect.publicKey.toBase58());
    const ac = await send(methods.acceptOracle().accountsPartial(oo(oracle)), [oracle]);
    expect(event(ac.events, "OracleChanged").by).to.equal(0);
    hot = oracle;
    // dead: the newest epoch (5) is older than 28 s and nothing newer survived
    const e5 = await acc.epoch.fetch(P.epoch(5));
    await T.untilChainTime(e5.publishedAt.toNumber() + 30);
    const seat0 = await acc.oracleSeat.fetch(P.seat);
    const pool0 = big(await bal(P.reward));
    const take = async (k: Keypair) => methods.takeSeat(oracle.publicKey, cold.publicKey, PublicKey.default).accountsPartial({
      config: P.config, seat: P.seat, rewardVault: P.reward, taker: k.publicKey, systemProgram: SYS,
    }).remainingAccounts(await walkPairs()).signers([k]);
    await expectErr(methods.takeSeat(oracle.publicKey, cold.publicKey, PublicKey.default).accountsPartial({
      config: P.config, seat: P.seat, rewardVault: P.reward, taker: dave.publicKey, systemProgram: SYS,
    }).signers([dave]).rpc(), "BadEpochWindow"); // the walk needs the epoch accounts
    const ts = await retry(["SeatAlive"], async () => send(await take(dave)));
    const sc = event(ts.events, "SeatChanged");
    expect([sc.reason, big(sc.forfeited)]).to.deep.equal([1, big(seat0.bond)]);
    const seat = await acc.oracleSeat.fetch(P.seat);
    expect(seat.generation.toNumber()).to.equal(seat0.generation.toNumber() + 1);
    expect(big(await bal(P.reward)) - pool0).to.equal(big(seat0.bond));
    expect((await cfg()).oracle.toBase58()).to.equal(oracle.publicKey.toBase58());
  });

  // ─── B-12 Predictions resolution ───────────────────────────────────────────
  it("B-12: Predictions v2: wrong observation = BadPriceAccount; the odd round (+5%) settles UP with the 2% rake, the even round (no move) is refunded; rounds close", async () => {
    await predEntries;
    if (predError) throw predError;
    const lockB = (r: number, obs = OBS) => methods.lockPrediction().accountsPartial({ round: P.pred(r), observation: obs });
    for (const r of predRounds) {
      await T.untilChainTime(r * L.PRED_PERIOD + L.PRED_LOCK_OFFSET + 1);
      await expectErr(lockB(r, SYS).rpc(), "BadPriceAccount");
      await retry(["RoundRunning"], () => lockB(r).rpc());
      expect((await acc.predRound.fetch(P.pred(r))).state).to.equal(1);
    }
    for (const r of predRounds) {
      await T.untilChainTime(r * L.PRED_PERIOD + L.PRED_LOCK_OFFSET + L.PRED_HORIZON + 1);
      const c = await cfg();
      const pool0 = big(await bal(P.reward)), arch0 = big(await bal(c.architect));
      await retry(["RoundRunning"], () => methods.settlePrediction().accountsPartial({
        config: P.config, round: P.pred(r), observation: OBS, rewardVault: P.reward, drawVault: P.draw, architect: c.architect,
      }).rpc());
      const round = await acc.predRound.fetch(P.pred(r));
      const a0 = await gameBal(predA.publicKey), b0 = await gameBal(predB.publicKey);
      const claim = (k: Keypair) => methods.claimPrediction().accountsPartial({
        config: P.config, round: P.pred(r), entry: P.predEntry(r, k.publicKey), playerState: P.player(k.publicKey), rentPayer: k.publicKey,
      }).rpc();
      await claim(predA);
      await claim(predB);
      if (r % 2 !== 0) {
        expect([round.state, round.outcome]).to.deep.equal([2, 1]);
        expect(big(round.endPriceX32) * 100n >= big(round.startPriceX32) * 104n).to.equal(true);
        expect(big(await bal(P.reward)) - pool0).to.equal(3n * BigInt(XNT) / 100n);
        expect(big(await bal(c.architect)) - arch0).to.equal(BigInt(XNT) / 100n);
        expect([(await gameBal(predA.publicKey)) - a0, (await gameBal(predB.publicKey)) - b0]).to.deep.equal([196n * BigInt(XNT) / 100n, 0n]);
      } else {
        expect(round.state).to.equal(3); // |move| < 1%: no contest
        expect(big(round.endPriceX32)).to.equal(big(round.startPriceX32));
        expect([(await gameBal(predA.publicKey)) - a0, (await gameBal(predB.publicKey)) - b0]).to.deep.equal([BigInt(XNT), BigInt(XNT)]);
      }
      const rr = await bal(P.pred(r)), pa0 = await bal(predA.publicKey);
      await methods.closePredictionRound().accountsPartial({ config: P.config, round: P.pred(r), rewardVault: P.reward, rentPayer: predA.publicKey }).rpc();
      expect(await connection.getAccountInfo(P.pred(r))).to.equal(null);
      expect((await bal(predA.publicKey)) - pa0 <= rr).to.equal(true);
    }
  });

  // ─── B-13: the airdrop list (architect-signed: before B-11 renounces the payee) ──────────────────
  it("B-13: airdrop list: a claim before the root is AirdropNotSet; the architect sets it once (then AirdropRootSet); one claim mints a free Lunar", async () => {
    const tr = tree(airdropWallets.map((k) => airdropLeaf(k.publicKey)));
    const w0 = airdropWallets[0];
    await fund(w0.publicKey);
    const claimB = (k: Keypair, serial: number, proof: number[][]) => methods.claimAirdrop(serial, proof).accountsPartial({
      config: P.config, receipt: P.pda(Buffer.from("airdrop"), k.publicKey.toBuffer()), asset: P.asset(0, serial), record: P.artifact(P.asset(0, serial)),
      collection: P.collection, artifactAuthority: P.authority, claimant: k.publicKey, coreProgram: MPL_CORE, systemProgram: SYS,
    }).signers([k]);
    let c = await cfg();
    await expectErr(claimB(w0, c.artifactsMinted[0], tr.proof(0)).rpc(), "AirdropNotSet");
    const setRoot = (k: Keypair) => methods.setAirdropRoot(Array.from(tr.root)).accountsPartial({ config: P.config, architect: k.publicKey }).signers([k]);
    await expectErr(setRoot(stranger).rpc(), "OnlyArchitect");
    await setRoot(architect).rpc();
    await expectErr(setRoot(architect).rpc(), "AirdropRootSet");
    c = await cfg();
    expect(Buffer.from(c.airdropRoot).equals(tr.root)).to.equal(true);
    await expectErr(claimB(w0, c.artifactsMinted[0], tr.proof(1)).rpc(), "InvalidProof");
    const alive0 = c.artifactsAlive[0], price0 = big(c.artifactPrice[0]);
    const ci = await send(claimB(w0, c.artifactsMinted[0], tr.proof(0)));
    const ev = event(ci.events, "ArtifactForged");
    expect([big(ev.price), big(ev.backing)]).to.deep.equal([0n, 0n]);
    c = await cfg();
    expect([c.airdropClaimed, c.artifactsAlive[0] - alive0]).to.deep.equal([1, 1]);
    expect(big(c.artifactPrice[0])).to.equal(price0); // a free Lunar never moves the PX price
    await expectErr(claimB(w0, c.artifactsMinted[0], tr.proof(0)).rpc(), "already in use"); // one per wallet
  });

  // ─── B-11 tail: renounce ───────────────────────────────────────────────────
  it("B-11: renouncing the architect payee to reward_vault: forges pay the vault", async () => {
    const r = await send(methods.setArchitect(P.reward).accountsPartial({ config: P.config, architect: architect.publicKey, newArchitect: P.reward, rewardVault: P.reward }), [architect]);
    expect(event(r.events, "ArchitectChanged").newArchitect.toBase58()).to.equal(P.reward.toBase58());
    await expectErr(methods.setArchitect(oracle.publicKey).accountsPartial({ config: P.config, architect: architect.publicKey, newArchitect: oracle.publicKey, rewardVault: P.reward })
      .remainingAccounts([{ pubkey: oracle.publicKey, isSigner: true, isWritable: false }]).signers([architect, oracle]).rpc(), "OnlyArchitect");
    const pool0 = big(await bal(P.reward));
    const f = await forge(frank, 0);
    const sp = forgeSplit(f.price);
    expect(big(await bal(P.reward)) - pool0).to.equal(sp.pool + sp.architect);
  });

  // ─── B-4 Lottery / ECO-3 ───────────────────────────────────────────────────
  it("B-4: the Burn Lottery takes no tickets (LotteryRetired); no player ever holds chips; the draw vault received nothing", async () => {
    const c = await cfg();
    const r = c.drawRound.toNumber();
    await expectErr(methods.enterDraw(BN(r), 0, BN(0), BN(1)).accountsPartial({
      config: P.config, round: P.drawRound(r), entry: P.drawEntry(r, 0), playerState: P.player(alice.publicKey), rewardVault: P.reward, drawVault: P.draw,
      architect: c.architect, signer: alice.publicKey, systemProgram: SYS,
    }).signers([alice]).rpc(), "LotteryRetired");
    const disc = Buffer.from(idl.accounts.find((a: any) => a.name === "PlayerState").discriminator);
    const all = await connection.getProgramAccounts(pid, { filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(disc) } }] });
    expect(all.length).to.be.greaterThan(5);
    for (const a of all) expect(big(program.coder.accounts.decode("playerState", a.account.data).chips)).to.equal(0n);
    expect(await bal(P.draw)).to.equal(await rent8());
  });

  // ─── B-13 coverage table ───────────────────────────────────────────────────
  // the ASSERTED table (with its allowlist) runs last, at the end of v3-gaps.test.ts, over all three suites
  it("B-13: coverage of error codes, instructions and new events so far (interim report)", async () => {
    const NEW_EVENTS = ["WarSeedOpened", "OracleChanged", "OracleHandoverProposed", "SeatChanged", "SeatResigned", "EpochVoided", "ExtraEpochVoided",
      "ExtraEpochPublished", "ExtraClaimed", "ExtraEpochClosed", "ArtifactListed", "ArtifactDelisted", "ArtifactSold", "CollectionRoyaltiesLocked",
      "KeeperArmed", "KeeperChanged", "BetRefunded", "ArchitectChanged"];
    const rep = coverage.report(idl.errors.map((e: any) => e.name), idl.instructions.map((i: any) => i.name), NEW_EVENTS);
    console.log(`      B-13 coverage: errors ${rep.errors}/${idl.errors.length}, instructions ${rep.ix}/${idl.instructions.length}, new events ${rep.events}/${NEW_EVENTS.length}`);
    console.log(`        errors not observed: ${rep.missE.join(", ")}`);
    console.log(`        instructions without a success: ${rep.missI.join(", ")}`);
    console.log(`        new events not seen: ${rep.missV.join(", ")}`);
    expect(rep.events).to.be.greaterThan(15);
  });

  // ─── B-14 Solvency ─────────────────────────────────────────────────────────
  it("B-14: every vault covers its obligations; the seats hold rent + bond; the keeper bond covers pending payouts and DRAWING pots", async () => {
    const c = await cfg();
    const rent = big(await rent8());
    expect(big(await bal(P.reward)) - rent >= big(c.rewardReserved)).to.equal(true);
    expect(big(await bal(P.bankroll)) - rent >= big(c.bankrollReserved)).to.equal(true);
    const x = await xs();
    const xf = big(await bal(P.extraVault)) - rent;
    expect(xf >= big(x.reserved) && xf >= big(x.accounted)).to.equal(true);
    const k = await ks();
    const kInfo = (await connection.getAccountInfo(P.keeper))!;
    // r4-fix: reason-0 forfeits stay in the seat above the bond (owed to nobody), so the seat holds AT LEAST rent + bond
    expect(big(kInfo.lamports) >= big(await T.rentFor(kInfo.data.length)) + big(k.bond)).to.equal(true);
    expect(big(k.bond) >= big(c.bankrollReserved) + big(k.jackpotReserved)).to.equal(true);
    const s = await acc.oracleSeat.fetch(P.seat);
    const sInfo = (await connection.getAccountInfo(P.seat))!;
    expect(big(sInfo.lamports)).to.equal(big(await T.rentFor(sInfo.data.length)) + big(s.bond));
    for (const l of await acc.listing.all()) {
      const owner = await assetOwner(l.account.asset);
      const d = delegateOf((await connection.getAccountInfo(l.account.asset))!.data);
      expect(d.address === l.publicKey.toBase58() || !owner.equals(l.account.seller)).to.equal(true);
    }
  });
});
