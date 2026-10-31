/**
 * Moon Forge v3 — the integration cases round 2 left out (SPEC-UPGRADE-v2 8.2), and the B-13 coverage ASSERTION.
 * Runs on the same local validator AFTER moon-forge.test.ts and stress.test.ts (see run-local.sh); it also runs alone on
 * a fresh validator (it then does the S7 first-run steps itself), which is how it is developed.
 *   D-47       : publish_epoch's oracle allowance (vault writable: the Epoch rent back + a top-up to 0.25 XNT of at most
 *                0.05 XNT, inside the 10% bound, booked in keeper_tips; vault read-only, the live account list: nothing)
 *   B-13 sweep : the reachable error codes no other block reaches (house, jackpot, artifact, duel, war, drop guards)
 *   B-1        : the 15%-weekly limit after a realized loss + its 7-s roll; 5% pending; the 3% daily breaker; the LP
 *                client guards (SlippageExceeded, WithdrawLocked / NoPendingWithdraw / NotEnoughShares, WithdrawExpired)
 *   B-3 / B-2  : a stream of post-draw bets; K-3 (bond 20, a 20-XNT round DRAWING); NotReady in the draw slot;
 *                KeeperBusy (arm / withdraw / named take with a pending bet / dead-seat take while DRAWING); the dead
 *                keeper seat taken after the 512-slot expiry; the seat handed back to the fixture keeper
 *   B-7        : the full-tier freeze (Void, supply 10), SoldOut, the clock restarting at the recycle
 *   B-9        : walk errors, resign / open seat / successor priority (SeatPriority, SeatOpen, SeatResigned), dead by
 *                voids with the 28-s / 29-s priority split, S-1 (five voided heartbeats at 1 XNT each), tiny bases with
 *                voided extras (dead) and without extras (alive), SeatDead
 *   B-10 / X-3 : three heartbeats in one transaction after a gap, then real extras still 6 s apart
 *   B-14 + B-13: solvency, then every error / instruction / event observed or allowlisted with its reason
 * Run: bash tests/run-local.sh   (alone: npx mocha -r ts-node/register -t 900000 v3-gaps.test.ts against a fresh validator)
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY, Transaction } from "@solana/web3.js";
import { assert, expect } from "chai";
import {
  AIRDROP_MAX, airdrop, airdropLeaf, airdropWallets, betEdge, CLOCK_META, betLimitsMirror, betUnpack, big, chainTools, claimLeaf, coverage, currentPrice, errMatches, errText,
  expectErr, extraLeaf, gameOdds, idl, isWin, jackpotTicketV2, KeeperChain, keccak, kp, L, MPL_CORE, pdas, retry, rnd, seatBond, sleep, trackedMethods,
  tree, u32, u64, U64_MAX, voidBond, weekBase, withStallNote, XNT,
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
const X = BigInt(XNT);
const WEEK = 7; // WEEK_WINDOW on localnet (7 × DAY, DAY = 1 s)
const HOUSE_WITHDRAW_DELAY = 1, HOUSE_WITHDRAW_WINDOW = 60; // localnet
const DEAD = 28, PRIORITY = 1; // DEAD_SEAT_DELAY / KEEPER_DEAD_DELAY, SEAT_PRIORITY_WINDOW (localnet seconds)

const oracle = kp("test-oracle.json");
const cold = kp("test-cold.json");
const keeper = kp("test-keeper.json");
const architect0 = kp("test-architect.json");
const [alice, bob, carol, dave, erin, frank, eve, gus, lp1, lp2, lpX, keeper2, stranger, smith] = Array.from({ length: 14 }, () => Keypair.generate());

let airdropNonce = 0;
async function fund(k: PublicKey, xnt = 1000) {
  for (let left = xnt; left > 0; left -= 1000) {
    // identical airdrops in one blockhash are deduplicated: vary the amount by a few lamports
    await airdrop(connection, k, Math.min(1000, left) * XNT - (airdropNonce++ % 1000));
  }
}
async function send(b: any, signers: Keypair[] = []) {
  return T.txInfo(await b.signers(signers).rpc());
}
const cfg = () => acc.config.fetch(P.config);
const ks = () => acc.houseKeeper.fetch(P.keeper);
const xs = () => acc.extraState.fetch(P.extraState);
const seatAcc = () => acc.oracleSeat.fetch(P.seat);
const gameBal = async (k: PublicKey) => big((await acc.playerState.fetch(P.player(k))).balance);
const rent8 = async () => BigInt(await T.rentFor(8));
const bankrollFree = async () => big(await bal(P.bankroll)) - (await rent8());
const poolFree = async () => big(await bal(P.reward)) - (await rent8()) - big((await cfg()).rewardReserved);

// ─── builders (as in moon-forge.test.ts) ────────────────────────────────────
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
const recycleB = (k: Keypair, asset: PublicKey) => methods.recycleArtifact().accountsPartial({
  config: P.config, asset, record: P.artifact(asset), collection: P.collection, owner: k.publicKey, coreProgram: MPL_CORE, systemProgram: SYS, extraState: P.extraState,
}).signers([k]);
const coreBurn = (asset: PublicKey, owner: Keypair) => T.sendIxs([new anchor.web3.TransactionInstruction({
  programId: MPL_CORE, data: Buffer.from([12, 0]),
  keys: [
    { pubkey: asset, isSigner: false, isWritable: true }, { pubkey: P.collection, isSigner: false, isWritable: true },
    { pubkey: owner.publicKey, isSigner: true, isWritable: true }, { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    { pubkey: SYS, isSigner: false, isWritable: false }, { pubkey: MPL_CORE, isSigner: false, isWritable: false },
  ],
})], [owner]);

const publish = (n: number, root: Buffer, total: bigint, leaves: number, cap: bigint, signer = oracle) =>
  methods.publishEpoch(BN(n), Array.from(root), Array.from(Buffer.alloc(32, n % 251)), BN(total), leaves, BN(cap))
    .accountsPartial({ config: P.config, epoch: P.epoch(n), rewardVault: P.reward, oracle: signer.publicKey, systemProgram: SYS }).signers([signer]);
/** Publishes the next base epoch as soon as the 6-s interval allows; returns its id and published_at. */
async function nextBase(total: bigint, cap: bigint, root: Buffer = Buffer.alloc(32, 7), leaves = 1) {
  const n = (await cfg()).lastEpoch.toNumber() + 1;
  await retry(["EpochTooSoon"], () => publish(n, root, total, leaves, cap).rpc(), 120, 300);
  const e = await acc.epoch.fetch(P.epoch(n));
  return { n, at: e.publishedAt.toNumber(), budget: big(e.budget) };
}
const publishExtra = (n: number, root: Buffer, total: bigint, leaves: number, weeks = 1) =>
  methods.publishExtraEpoch(BN(n), Array.from(root), Array.from(Buffer.alloc(32, 0x40 + (n % 64))), BN(total), leaves, weeks).accountsPartial({
    config: P.config, extraState: P.extraState, extraEpoch: P.extraEpoch(n), baseEpoch: P.epoch(n), prevEpoch: P.epoch(Math.max(1, n - 1)),
    oracle: oracle.publicKey, systemProgram: SYS,
  }).signers([oracle]);
/** Heartbeat extras (total 0) for every base epoch that has none yet. */
async function catchUpExtras() {
  const last = (await cfg()).lastEpoch.toNumber();
  for (let id = (await xs()).lastEpoch.toNumber() + 1; id <= last; id++) await publishExtra(id, Buffer.alloc(32), 0n, 0).rpc();
}
const voidB = (n: number, k: Keypair, bond: bigint) => methods.voidEpoch(BN(n), BN(bond)).accountsPartial({
  config: P.config, epoch: P.epoch(n), seat: P.seat, rewardVault: P.reward, voider: k.publicKey, systemProgram: SYS,
}).signers([k]);
const voidExtraB = (n: number, k: Keypair, bond: bigint) => methods.voidExtraEpoch(BN(n), BN(bond)).accountsPartial({
  config: P.config, extraState: P.extraState, extraEpoch: P.extraEpoch(n), epoch: P.epoch(n), seat: P.seat, rewardVault: P.reward, voider: k.publicKey, systemProgram: SYS,
}).signers([k]);
/**
 * A heartbeat extra (total 0) for base `n` and its void by `k` in ONE transaction: one clock, so the void is always
 * inside the extra's 2-s hold whatever the confirmation latency (a separate void could land after it: HoldOver).
 */
async function heartbeatAndVoid(n: number, k: Keypair, bond: bigint) {
  const ixs = [await publishExtra(n, Buffer.alloc(32), 0n, 0).instruction(), await voidExtraB(n, k, bond).instruction()];
  const info = await T.txInfo(await T.sendIxs(ixs, [k, oracle]));
  coverage.ok("publish_extra_epoch");
  coverage.ok("void_extra_epoch");
  return info;
}
/** Publishes the next base epoch and voids it by `k` in ONE transaction (inside its hold); returns its id. */
async function baseAndVoid(total: bigint, cap: bigint, k: Keypair, bond: bigint) {
  const n = (await cfg()).lastEpoch.toNumber() + 1;
  const ixs = [await publish(n, Buffer.alloc(32, 7), total, 1, cap).instruction(), await voidB(n, k, bond).instruction()];
  await retry(["EpochTooSoon"], async () => T.sendIxs(ixs, [k, oracle]), 120, 300);
  coverage.ok("publish_epoch");
  coverage.ok("void_epoch");
  return n;
}
const pairs = (from: number, count: number) => {
  const out: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  for (let id = from; id >= 1 && out.length < 2 * count; id--) out.push({ pubkey: P.epoch(id), isSigner: false, isWritable: false }, { pubkey: P.extraEpoch(id), isSigner: false, isWritable: false });
  return out;
};
const walk = async () => pairs((await cfg()).lastEpoch.toNumber(), 10);
const takeSeatB = (k: Keypair, rem: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[], refund = PublicKey.default) =>
  methods.takeSeat(oracle.publicKey, cold.publicKey, refund).accountsPartial({ config: P.config, seat: P.seat, rewardVault: P.reward, taker: k.publicKey, systemProgram: SYS })
    .remainingAccounts(rem).signers([k]);
const resignB = (successor: PublicKey, refund: PublicKey, rem: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) =>
  methods.resignSeat(successor).accountsPartial({ config: P.config, seat: P.seat, rewardVault: P.reward, refund, cold: cold.publicKey })
    .remainingAccounts(rem).signers([cold]);

// house / keeper
let chain: KeeperChain;
let chainSeed = 1;
const newChain = (len: number) => (chain = new KeeperChain(keccak(Buffer.from("gaps-chain"), u32(chainSeed++), payer.publicKey.toBuffer()), len));
const armB = (k: Keypair, tip: Buffer, len: number, deposit: number | bigint) => methods.armKeeper(Array.from(tip), BN(len), BN(deposit)).accountsPartial({
  config: P.config, keeperSeat: P.keeper, keeper: k.publicKey, bankrollVault: P.bankroll, rewardVault: P.reward, systemProgram: SYS,
}).signers([k]);
const keeperOnly = (k: Keypair) => ({ config: P.config, keeperSeat: P.keeper, keeper: k.publicKey, bankrollVault: P.bankroll, rewardVault: P.reward, systemProgram: SYS });
const wd = (amount: bigint | number, k = keeper) => methods.keeperWithdraw(BN(amount)).accountsPartial(keeperOnly(k)).signers([k]);
const takeKeeperB = (k: Keypair, c: KeeperChain, deposit: bigint | number, old: PublicKey) => methods.takeKeeper(Array.from(c.tip), BN(c.length), BN(deposit)).accountsPartial({
  config: P.config, keeperSeat: P.keeper, oldKeeper: old, taker: k.publicKey, rewardVault: P.reward, systemProgram: SYS,
}).signers([k]);
type V2Bet = { ps: PublicKey; nonce: number; pk: PublicKey; owner: Keypair; seed: Buffer };
async function placeV2(owner: Keypair, game: number, param: number, choice: number, stake: number | bigint, signer: Keypair = owner): Promise<V2Bet> {
  const ps = P.player(owner.publicKey);
  const nonce = (await acc.playerState.fetch(ps)).nonce.toNumber();
  const seed = keccak(Buffer.from("gaps-seed"), owner.publicKey.toBuffer(), u64(nonce));
  const c = await cfg();
  await methods.placeBetV2(game, BN(param), choice, BN(stake), Array.from(seed)).accountsPartial({
    config: P.config, playerState: ps, bet: P.bet(ps, nonce), bankrollVault: P.bankroll, rewardVault: P.reward, architect: c.architect,
    signer: signer.publicKey, systemProgram: SYS, keeperSeat: P.keeper,
  }).signers([signer]).rpc();
  return { ps, nonce, pk: P.bet(ps, nonce), owner: signer, seed };
}
const anchorB = (b: V2Bet) => methods.anchorBet().accountsPartial({ bet: b.pk, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY });
async function anchorWhenReady(b: V2Bet) {
  const t = big((await acc.bet.fetch(b.pk)).targetSlot);
  await T.waitPastSlot(betUnpack(t).anchor);
  await retry(["NotReady"], () => anchorB(b).rpc());
}
const settleV2B = (b: V2Bet, reveal: Buffer, ps = b.ps) => methods.settleBetV2(Array.from(reveal)).accountsPartial({
  config: P.config, bet: b.pk, playerState: ps, bankrollVault: P.bankroll, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: b.owner.publicKey, keeperSeat: P.keeper,
});
async function settleBet(b: V2Bet) {
  if (((await acc.bet.fetch(b.pk)).game & 0x40) === 0) await anchorWhenReady(b);
  const bet = await acc.bet.fetch(b.pk);
  const reveal = chain.reveal(betUnpack(big(bet.targetSlot)).index);
  const owner = new PublicKey(bet.owner);
  const before = await gameBal(owner);
  await withStallNote(settleV2B(b, reveal).rpc(), connection, big(bet.targetSlot), ks);
  const roll = rnd(reveal, b.pk.toBuffer(), Buffer.from(bet.seed)) % 10_000n;
  const won = isWin(bet.game & 0x3f, bet.choice, big(bet.chanceBps), roll);
  expect((await gameBal(owner)) - before).to.equal(won ? big(bet.payout) : 0n);
  return { won, payout: big(bet.payout), stakeIn: big(bet.stake) - betEdge(big(bet.stake)) };
}
async function openGame(k: Keypair, xnt: number) {
  if (!(await connection.getAccountInfo(P.player(k.publicKey)))) {
    await methods.openPlayer().accountsPartial({ playerState: P.player(k.publicKey), owner: k.publicKey, systemProgram: SYS }).signers([k]).rpc();
  }
  if (xnt > 0) await methods.deposit(BN(Math.round(xnt * XNT))).accountsPartial({ playerState: P.player(k.publicKey), payer: k.publicKey, systemProgram: SYS }).signers([k]).rpc();
}
const houseDeposit = (k: Keypair, amount: bigint) => methods.houseDeposit(BN(amount), BN(0)).accountsPartial({
  config: P.config, share: P.house(k.publicKey), bankrollVault: P.bankroll, owner: k.publicKey, systemProgram: SYS,
}).signers([k]);
const houseRequest = (k: Keypair, shares: bigint) => methods.houseRequestWithdraw(BN(shares)).accountsPartial({ share: P.house(k.publicKey), owner: k.publicKey }).signers([k]);
const houseWithdraw = (k: Keypair, min: bigint) => methods.houseWithdraw(BN(min)).accountsPartial({
  config: P.config, share: P.house(k.publicKey), bankrollVault: P.bankroll, owner: k.publicKey,
}).signers([k]);
const shareOf = async (k: Keypair) => big((await acc.houseShare.fetch(P.house(k.publicKey))).shares);
/** Tops the keeper bond up to `min` by re-arming the fixture keeper with a fresh chain (needs nothing pending). */
async function ensureBond(min: bigint) {
  const k = await ks();
  if (big(k.bond) >= min) return;
  const need = min - big(k.bond);
  if (big(await bal(keeper.publicKey)) < need + 5n * X) await fund(keeper.publicKey, Number(need / X) + 10);
  newChain(600);
  await armB(keeper, chain.tip, 600, need).rpc();
  expect(big((await ks()).bond)).to.equal(min);
}
/** Tops a game wallet up to at least `lamports` (the house-limit cases scale their stakes with the bankroll). */
async function ensureGame(k: Keypair, lamports: bigint) {
  const have = (await connection.getAccountInfo(P.player(k.publicKey))) ? await gameBal(k.publicKey) : 0n;
  if (have >= lamports) return;
  const add = lamports - have + X;
  if (big(await bal(k.publicKey)) < add + 5n * X) await fund(k.publicKey, Number(add / X) + 10);
  await openGame(k, Number(add / X) + 1);
}
/** The limit state a bet placed now would see (both day-start cases: same UTC day, or a new one). */
async function limitState() {
  const c = await cfg(), k = await ks(), vault = await bankrollFree();
  const now = await T.chainTime();
  const sameDay = c.bankrollDay.toNumber() === now;
  const weekRolled = now >= k.weekStartTs.toNumber() + WEEK;
  const weekLoss = weekRolled ? 0n : big(k.weekNetLoss);
  const weekStart = weekRolled ? vault : weekBase(big(k.weekStartBankroll), vault, big(k.weekNetLoss));
  return {
    vault, reserved: big(c.bankrollReserved), weekLoss, weekStart, bond: big(k.bond), jackpotReserved: big(k.jackpotReserved),
    dayStarts: sameDay ? [big(c.bankrollDayStart), vault] : [vault],
  };
}
/** The mirror's verdict for a bet, required to be the same whatever UTC second the bet lands in. */
async function predict(game: number, param: number, choice: number, stake: bigint, over: Partial<{ weekLoss: bigint }> = {}) {
  const s = await limitState();
  const payout = (stake * gameOdds(game, param, choice).payoutBps) / 10_000n;
  const verdicts = new Set([...s.dayStarts, s.vault].map((d) => betLimitsMirror({ ...s, ...over, dayStart: d, stake, payout })));
  expect(verdicts.size, `mirror verdict depends on the day start: ${[...verdicts].join(", ")}`).to.equal(1);
  return { verdict: [...verdicts][0], payout, s };
}

// jackpot
const enterJp = (k: Keypair, r: number, idx: number, amt: number | bigint, signer = k) => methods.enterJackpot(BN(r), idx, BN(amt)).accountsPartial({
  config: P.config, round: P.jackpot(r), entry: P.jpEntry(r, idx), playerState: P.player(k.publicKey), signer: signer.publicKey, systemProgram: SYS,
}).signers([signer]);
const drawJp = (r: number, first: PublicKey) => methods.drawJackpot().accountsPartial({ config: P.config, round: P.jackpot(r), firstPlayerState: P.player(first), keeperSeat: P.keeper });
const settleJpV2B = async (r: number, entryIdx: number, reveal: Buffer) => {
  const e = await acc.jackpotEntry.fetch(P.jpEntry(r, entryIdx));
  return methods.settleJackpotV2(Array.from(reveal)).accountsPartial({
    config: P.config, round: P.jackpot(r), entry: P.jpEntry(r, entryIdx), winnerState: P.player(e.player), rewardVault: P.reward, drawVault: P.draw,
    architect: (await cfg()).architect, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, keeperSeat: P.keeper,
  });
};
async function jackpotWinner(r: number, reveal: Buffer) {
  const round = await acc.jackpotRound.fetch(P.jackpot(r));
  const { anchor } = betUnpack(big(round.targetSlot));
  await T.waitPastSlot(anchor);
  const h = (await T.slotHashAtOrAfter(anchor))!;
  const ticket = jackpotTicketV2(h, reveal, P.jackpot(r), r, big(round.total));
  for (let i = 0; i < round.entries; i++) {
    const e = await acc.jackpotEntry.fetch(P.jpEntry(r, i));
    if (ticket >= big(e.start) && ticket < big(e.start) + big(e.amount)) return { i, ticket };
  }
  throw new Error("no winning entry");
}
const closeJpEntry = async (r: number, i: number) => {
  const e = await acc.jackpotEntry.fetch(P.jpEntry(r, i));
  return methods.closeJackpotEntry().accountsPartial({ round: P.jackpot(r), playerState: P.player(e.player), entry: P.jpEntry(r, i), rentPayer: e.rentPayer });
};

// claims
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

// state shared across blocks
let standalone = false;
let late: { n: number; at: number; leaves: { p: PublicKey; t: number; s: bigint }[]; tr: ReturnType<typeof tree> };
let lpXRequestAt = 0;
let drawing: { r: number; anchor: bigint; lastActive: number } | null = null;
let seatT = 0; // taken_at of the newest seat generation (B-9)

describe("Moon Forge v3 — integration gaps (round 3) and the B-13 assertion", () => {
  before(async () => {
    for (const k of [payer, oracle, cold, keeper, architect0, alice, bob, carol, dave, erin, frank, eve, gus, lp1, lp2, lpX, keeper2, stranger]) await fund(k.publicKey);
    await fund(payer.publicKey, 3000);
    await fund(smith.publicKey, 4000);
    await fund(lp1.publicKey, 3000);
  });

  // ─── setup ─────────────────────────────────────────────────────────────────
  it("setup: the S7 base when run alone; a fresh keeper chain; a late epoch (claims at the end); an LP request left to expire", async () => {
    if (!(await connection.getAccountInfo(P.config))) {
      standalone = true;
      await methods.initializeV2().accountsPartial({
        config: P.config, rewardVault: P.reward, bankrollVault: P.bankroll, drawVault: P.draw, collection: P.collection, artifactAuthority: P.authority,
        payer: payer.publicKey, systemProgram: SYS,
      }).rpc();
      await methods.donate(0, BN(1500 * XNT)).accountsPartial({ config: P.config, donor: payer.publicKey, vault: P.reward, systemProgram: SYS }).rpc();
      await methods.initArtifacts().accountsPartial({ config: P.config, collection: P.collection, artifactAuthority: P.authority, payer: payer.publicKey, coreProgram: MPL_CORE, systemProgram: SYS }).rpc();
      await methods.initSeat().accountsPartial({ config: P.config, seat: P.seat, rewardVault: P.reward, payer: payer.publicKey, systemProgram: SYS }).rpc();
      await methods.initExtra().accountsPartial({ config: P.config, extraState: P.extraState, extraVault: P.extraVault, payer: payer.publicKey, systemProgram: SYS }).rpc();
      // a forged floor for the extra pot's backing bound
      await forge(smith, 0);
    }
    const c = await cfg();
    expect(c.oracle.toBase58(), "the hot key the earlier suites leave").to.equal(oracle.publicKey.toBase58());
    expect((await seatAcc()).cold.toBase58()).to.equal(cold.publicKey.toBase58());
    // keeper: nothing pending after the stress suite; a fresh chain, bond >= 300 XNT
    const k0 = await connection.getAccountInfo(P.keeper) ? await ks() : null;
    if (k0) expect(k0.pendingBets, "nothing pending before the gaps suite").to.equal(0);
    newChain(600);
    const bond = k0 ? big(k0.bond) : 0n;
    await armB(keeper, chain.tip, 600, bond >= 300n * X ? 0n : 300n * X - bond).rpc();
    expect((await ks()).keeper.toBase58()).to.equal(keeper.publicKey.toBase58());
    // the late epoch: an instant leaf (ClaimWindowClosed at the end) and a mission leaf (NothingVested)
    const leaves = [{ p: alice.publicKey, t: 0, s: 10n }, { p: bob.publicKey, t: 1, s: 10n }];
    const n = (await cfg()).lastEpoch.toNumber() + 1;
    const tr = tree(leaves.map((l) => claimLeaf(n, l.p, l.t, l.s)));
    const b = await nextBase(20n, 100_000_000n, tr.root, 2);
    expect(b.n).to.equal(n);
    late = { n, at: b.at, leaves, tr };
    await catchUpExtras();
    // lpX: a withdrawal request that is NOT used within its 60-s window (WithdrawExpired at the end)
    await houseDeposit(lpX, 10n * X).rpc();
    await houseRequest(lpX, await shareOf(lpX)).rpc();
    lpXRequestAt = await T.chainTime();
  });

  // ─── D-47: the oracle operating allowance ──────────────────────────────────
  it("D-47: publish_epoch with the reward vault writable refunds the Epoch rent and tops the oracle up to 0.25 XNT (at most 0.05 XNT per epoch) inside the 10% bound, booked in keeper_tips; the live account list (vault read-only) pays nothing", async () => {
    const TARGET = 250_000_000n, TOPUP = 50_000_000n;
    const epochRent = BigInt(await T.rentFor(207)); // 8 + Epoch::INIT_SPACE (forge.rs epoch_account_size_is_pinned)
    // the oracle wallet holds exactly `lamports` (the payer pays the fee, so the transfer is exact)
    const setOracle = async (lamports: bigint) => {
      const now = big(await bal(oracle.publicKey));
      if (now > lamports) await T.sendIxs([SystemProgram.transfer({ fromPubkey: oracle.publicKey, toPubkey: payer.publicKey, lamports: now - lamports })], [payer, oracle]);
      if (now < lamports) await T.sendIxs([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: oracle.publicKey, lamports: lamports - now })], [payer]);
      expect(big(await bal(oracle.publicKey))).to.equal(lamports);
    };
    const publishAs = async (writable: boolean) => {
      const n = (await cfg()).lastEpoch.toNumber() + 1;
      const ix = await publish(n, Buffer.alloc(32, 0x47), 1_000n, 1, 1n).instruction();
      expect(ix.data.length, "the publish_epoch ABI is unchanged").to.equal(108);
      const vault = ix.keys.find((k) => k.pubkey.equals(P.reward))!;
      expect(vault.isWritable, "the IDL keeps the live account list (vault read-only)").to.equal(false);
      vault.isWritable = writable;
      const tips0 = big((await cfg()).stats.keeperTips), v0 = big(await bal(P.reward)), o0 = big(await bal(oracle.publicKey));
      const info = await T.txInfo(await retry(["EpochTooSoon"], () => T.sendIxs([ix], [payer, oracle]), 120, 300));
      coverage.ok("publish_epoch");
      const ev = event(info.events, "EpochPublished");
      const c1 = await cfg();
      const r = {
        n, a: big(ev.oracleAllowance), budget: big(ev.budget), freeBefore: big(ev.freePoolBefore), dTips: big(c1.stats.keeperTips) - tips0,
        vaultOut: v0 - big(await bal(P.reward)), o0, o1: big(await bal(oracle.publicKey)),
      };
      // whatever the case: inside the 10% bound, at most the rent + 0.05 XNT, all of it from the vault, booked as a tip
      expect(r.budget + r.a <= r.freeBefore / 10n, "budget + allowance within 10% of the free pool").to.equal(true);
      expect(r.a <= epochRent + TOPUP).to.equal(true);
      expect([r.vaultOut, r.dTips], "the vault pays exactly the allowance, booked in stats.keeper_tips").to.deep.equal([r.a, r.a]);
      expect(r.o1, "the oracle paid the Epoch rent and received the allowance").to.equal(r.o0 - epochRent + r.a);
      expect(big((await acc.epoch.fetch(P.epoch(n))).budget), "the budget is never lowered").to.equal(1_000n);
      return r;
    };
    // a dry wallet: the rent back + the full 0.05 XNT
    await setOracle(100_000_000n);
    const dry = await publishAs(true);
    expect(dry.a).to.equal(epochRent + TOPUP);
    expect(dry.o1).to.equal(150_000_000n);
    // 0.23 XNT: topped up to exactly 0.25 XNT
    await setOracle(230_000_000n);
    const near = await publishAs(true);
    expect([near.a, near.o1]).to.deep.equal([epochRent + 20_000_000n, TARGET]);
    // the live account list (an old client, vault read-only): nothing is paid, the oracle pays the rent as before
    await setOracle(230_000_000n);
    const old = await publishAs(false);
    expect([old.a, old.vaultOut, old.dTips, old.o1]).to.deep.equal([0n, 0n, 0n, 230_000_000n - epochRent]);
    // above the target: the rent back only
    await setOracle(10n * X);
    const rich = await publishAs(true);
    expect([rich.a, rich.o1]).to.deep.equal([epochRent, 10n * X]);
    // back to the suite's state: heartbeat extras for these bases, a funded oracle
    await catchUpExtras();
    await fund(oracle.publicKey);
  });

  // ─── B-13 sweep: errors no other block reaches ─────────────────────────────
  it("B-13 sweep, house games: AmountTooSmall, InvalidGame, SessionLimit (set_session), OwnerOnly, InsufficientBalance (withdraw), WrongPlayer", async () => {
    await openGame(eve, 300);
    await openGame(alice, 50);
    await openGame(bob, 50);
    await houseDeposit(lp2, 50n * X).rpc();
    await expectErr(placeV2(eve, 0, 0, 0, 1_000_000), "AmountTooSmall");
    await expectErr(placeV2(eve, 9, 0, 0, 0.1 * XNT), "InvalidGame");
    // MathOverflow: a u64::MAX coin-flip stake has a 1.96× payout that no u64 holds (mul_div, before any balance check)
    await expectErr(placeV2(eve, 0, 0, 0, (1n << 64n) - 1n), "MathOverflow");
    // a session key plays house games within its stake limit, never pot games (OwnerOnly)
    const now = await T.chainTime();
    await methods.setSession(gus.publicKey, BN(now + 600), BN(0.05 * XNT)).accountsPartial({ playerState: P.player(eve.publicKey), owner: eve.publicKey }).signers([eve]).rpc();
    await expectErr(placeV2(eve, 0, 0, 0, 0.1 * XNT, gus), "SessionLimit");
    const bs = await placeV2(eve, 0, 0, 1, 0.05 * XNT, gus); // within the limit: the session key pays the bet rent
    const r = (await cfg()).jackpotRound.toNumber();
    await expectErr(enterJp(eve, r, 0, 0.1 * XNT, gus).rpc(), "OwnerOnly");
    await methods.setSession(PublicKey.default, BN(0), BN(0)).accountsPartial({ playerState: P.player(eve.publicKey), owner: eve.publicKey }).signers([eve]).rpc();
    await expectErr(placeV2(eve, 0, 0, 0, 0.02 * XNT, gus), "Unauthorized"); // revoked
    // withdraw: never above the game balance; the owner only
    const w = (k: Keypair, amt: bigint) => methods.withdraw(BN(amt)).accountsPartial({ playerState: P.player(eve.publicKey), owner: k.publicKey }).signers([k]);
    const balEve = await gameBal(eve.publicKey);
    await expectErr(w(eve, balEve + 1n).rpc(), "InsufficientBalance");
    const e0 = big(await bal(eve.publicKey));
    await w(eve, X).rpc();
    expect(big(await bal(eve.publicKey)) - e0 > X - 100_000n).to.equal(true);
    // the settle names the bet's own game wallet (WrongPlayer otherwise)
    await anchorWhenReady(bs);
    const bet = await acc.bet.fetch(bs.pk);
    await expectErr(settleV2B(bs, chain.reveal(betUnpack(big(bet.targetSlot)).index), P.player(alice.publicKey)).rpc(), "WrongPlayer");
    await settleBet(bs);
  });

  it("B-13 sweep, Jackpot: RoundNotOpen, RoundRunning, RoundNotDrawing, RoundNotSettled; then the round settles on the keeper reveal", async () => {
    const r = (await cfg()).jackpotRound.toNumber();
    await expectErr(enterJp(alice, r + 1, 0, XNT).rpc(), "RoundNotOpen"); // only the current round
    await enterJp(alice, r, 0, XNT).rpc();
    await enterJp(bob, r, 1, XNT).rpc();
    await expectErr(drawJp(r, alice.publicKey).rpc(), "RoundRunning");
    await expectErr((await settleJpV2B(r, 0, Buffer.alloc(32, 1))).rpc(), "RoundNotDrawing");
    await expectErr((await closeJpEntry(r, 0)).rpc(), "RoundNotSettled");
    await retry(["RoundRunning"], () => drawJp(r, alice.publicKey).rpc());
    await expectErr(enterJp(alice, r, 2, XNT).rpc(), "RoundNotOpen"); // DRAWING
    const pos = betUnpack(big((await acc.jackpotRound.fetch(P.jackpot(r))).targetSlot)).index;
    const w = await jackpotWinner(r, chain.reveal(pos));
    await (await settleJpV2B(r, w.i, chain.reveal(pos))).rpc();
    await (await closeJpEntry(r, 0)).rpc();
    await (await closeJpEntry(r, 1)).rpc();
  });

  it("B-13 sweep, epochs and legacy drops: DropNotPending (seal_drop), DropNotSealed (claim_drop) on a v3 epoch; NothingVested (claim + withdraw in one slot)", async () => {
    await expectErr(methods.sealDrop().accountsPartial({ config: P.config, epoch: P.epoch(late.n), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).rpc(), "DropNotPending");
    const c = await cfg();
    const serial = c.artifactsMinted[0];
    const l = late.leaves[0];
    await expectErr(methods.claimDrop(BN(late.n), l.t, serial, BN(l.s), late.tr.proof(0)).accountsPartial({
      config: P.config, epoch: P.epoch(late.n), receipt: P.pda(Buffer.from("drop"), u64(late.n), l.p.toBuffer(), Buffer.from([l.t])), player: l.p,
      asset: P.asset(0, serial), record: P.artifact(P.asset(0, serial)), collection: P.collection, artifactAuthority: P.authority, rewardVault: P.reward,
      payer: alice.publicKey, coreProgram: MPL_CORE, systemProgram: SYS,
    }).signers([alice]).rpc(), "DropNotSealed");
    // the mission vests from its claim: a withdrawal in the same transaction finds nothing vested
    await T.untilChainTime(late.at + L.CLAIM_HOLD + 1);
    const m = late.leaves[1];
    const claimIx = await claimMissionB(late.n, m, late.tr.proof(1), bob).instruction();
    const wIx = await methods.withdrawVested().accountsPartial({ mission: P.mission(late.n, m.p, m.t), player: m.p, playerState: P.player(m.p), rentPayer: bob.publicKey }).instruction();
    await expectErr(retry(["ClaimOnHold"], () => T.sendIxs([claimIx, wIx], [bob])), "NothingVested");
  });

  it("B-13 sweep, artifacts: InvalidTier, NotArtifactOwner (recycle), InvalidArtifact (list a burned asset; then reclaim_orphan)", async () => {
    const c = await cfg();
    await expectErr(methods.forgeArtifact(4, 0, U64_MAX).accountsPartial(forgeAccounts(alice.publicKey, 4, 0, c.architect)).signers([alice]).rpc(), "InvalidTier");
    const f = await forge(alice, 0);
    await expectErr(recycleB(bob, f.asset).rpc(), "NotArtifactOwner");
    await coreBurn(f.asset, alice);
    const now = await T.chainTime();
    await expectErr(methods.listArtifact(BN(10n * X), BN(now + 60), PublicKey.default, false).accountsPartial({
      config: P.config, listing: P.listing(f.asset), asset: f.asset, record: P.artifact(f.asset), collection: P.collection, seller: alice.publicKey, coreProgram: MPL_CORE, systemProgram: SYS,
    }).signers([alice]).rpc(), "InvalidArtifact");
    await methods.reclaimOrphan().accountsPartial({ config: P.config, asset: f.asset, record: P.artifact(f.asset), collection: P.collection, rewardVault: P.reward, extraState: P.extraState }).rpc();
  });

  it("B-13 sweep, Duel and Moon Wars: DeadlineNotReached, WrongElement, DeadlinePassed; NotYourTurn, InvalidMove, NotEnoughMana", async () => {
    // Duel: a sealed join whose opening comes too late
    const nonce = (await acc.playerState.fetch(P.player(alice.publicKey))).nonce.toNumber();
    const duel = P.duel(alice.publicKey, nonce);
    const salt = Buffer.alloc(32, 3), jsalt = Buffer.alloc(32, 4);
    await methods.createDuel(BN(0.2 * XNT), Array.from(keccak(Buffer.from("MOONFORGE_DUEL"), Buffer.from([0]), salt, duel.toBuffer()))).accountsPartial({
      config: P.config, creatorState: P.player(alice.publicKey), duel, owner: alice.publicKey, asset: SYS, record: SYS, collection: SYS, systemProgram: SYS,
    }).signers([alice]).rpc();
    const jc = keccak(Buffer.from("MOONFORGE_DUEL_JOIN"), Buffer.from([2]), jsalt, duel.toBuffer(), bob.publicKey.toBuffer());
    await methods.joinDuelSealed(Array.from(jc)).accountsPartial({ config: P.config, duel, opponentState: P.player(bob.publicKey), opponent: bob.publicKey, asset: SYS, record: SYS, collection: SYS })
      .signers([bob]).rpc();
    const resolve = async () => ({
      config: P.config, duel, creatorState: P.player(alice.publicKey), opponentState: P.player(bob.publicKey), rewardVault: P.reward, drawVault: P.draw,
      architect: (await cfg()).architect, rentPayer: alice.publicKey,
    });
    await expectErr(methods.claimDuelTimeout().accountsPartial(await resolve()).rpc(), "DeadlineNotReached");
    const openJ = (el: number) => methods.revealDuelJoin(el, Array.from(jsalt)).accountsPartial({ duel, opponent: bob.publicKey }).signers([bob]);
    await expectErr(retry(["NotReady"], () => openJ(7).rpc()), "WrongElement");
    const d = await acc.duel.fetch(duel);
    await T.untilChainTime(d.deadline.toNumber() + 1);
    await expectErr(openJ(2).rpc(), "DeadlinePassed");
    await retry(["DeadlineNotReached"], async () => methods.claimDuelTimeout().accountsPartial(await resolve()).rpc());
    // Moon Wars: a sealed match, then the move guards
    const wn = (await acc.playerState.fetch(P.player(alice.publicKey))).nonce.toNumber();
    const war = P.war(alice.publicKey, wn);
    const entropy = Buffer.alloc(32, 0x31), secret = Buffer.alloc(32, 0x32);
    await methods.createWarSealed(BN(0.2 * XNT), PublicKey.default, Array.from(keccak(Buffer.from("MOONFORGE_WAR_ENTROPY"), entropy, war.toBuffer()))).accountsPartial({
      config: P.config, creatorState: P.player(alice.publicKey), war, owner: alice.publicKey, asset: SYS, record: SYS, collection: SYS, systemProgram: SYS,
    }).signers([alice]).rpc();
    await methods.joinWarSealed(Array.from(keccak(Buffer.from("MOONFORGE_WAR_JOIN"), secret, war.toBuffer(), bob.publicKey.toBuffer(), PublicKey.default.toBuffer())))
      .accountsPartial({ config: P.config, war, opponentState: P.player(bob.publicKey), opponent: bob.publicKey, asset: SYS, record: SYS, collection: SYS }).signers([bob]).rpc();
    await methods.seedWar(Array.from(entropy)).accountsPartial({ war, signer: alice.publicKey }).signers([alice]).rpc();
    await methods.revealWar(Array.from(secret), PublicKey.default).accountsPartial({ war, signer: bob.publicKey }).signers([bob]).rpc();
    const CARD_COST = [1, 2, 3, 5];
    const players = [alice, bob];
    let w = await acc.war.fetch(war);
    expect(w.state).to.equal(2);
    const mover = players[w.turn], other = players[1 - w.turn];
    await expectErr(methods.warEndTurn().accountsPartial({ war, signer: other.publicKey }).signers([other]).rpc(), "NotYourTurn");
    await expectErr(methods.warSummon(9).accountsPartial({ war, signer: mover.publicKey }).signers([mover]).rpc(), "InvalidMove");
    let mana = false;
    for (let t = 0; t < 12 && !mana; t++) {
      w = await acc.war.fetch(war);
      const k = players[w.turn], me = w.sides[w.turn];
      const j = me.hand.slice(0, me.handLen).findIndex((card: number) => CARD_COST[card] > me.mana);
      if (j >= 0 && me.fieldLen < 6) {
        await expectErr(methods.warSummon(j).accountsPartial({ war, signer: k.publicKey }).signers([k]).rpc(), "NotEnoughMana");
        mana = true;
      } else await methods.warEndTurn().accountsPartial({ war, signer: k.publicKey }).signers([k]).rpc();
    }
    expect(mana, "a hand card above the mana appeared").to.equal(true);
  });

  // ─── B-1 House limits and LP guards ────────────────────────────────────────
  it("B-1: the 15% weekly limit binds after a REALIZED loss (window base below the bankroll) and rolls after the 7-s window", async () => {
    let won = false, L0 = 0n, W = 0n;
    for (let attempt = 0; attempt < 3 && !won; attempt++) {
      // before the window opens (all of it scales with the bankroll W): lp1 can lift the bankroll to 4 W, so the 5%
      // aggregate cap (20% of W) and the 0.25% net cap stay above a 15%-of-W payout; the bond and eve's game wallet cover it
      const guess = await bankrollFree();
      await ensureBond((guess * 16n) / 100n + 2n * X);
      await ensureGame(eve, (guess * 16n) / 100n + 2n * X);
      if (big(await bal(lp1.publicKey)) < 4n * guess + 10n * X) await fund(lp1.publicKey, Number((4n * guess) / X) + 10);
      // the window starts at the first bet after the old one ended: W = the bankroll then (deposits never raise it)
      await T.untilChainTime((await ks()).weekStartTs.toNumber() + WEEK + 1);
      const b0 = await placeV2(eve, 1, 9_500, 0, X); // High-Low 95% "under"
      const k = await ks();
      W = big(k.weekStartBankroll);
      expect(big(k.weekNetLoss)).to.equal(0n);
      const vault = await bankrollFree();
      if (vault < 4n * W) await houseDeposit(lp1, 4n * W - vault).rpc();
      const r = await settleBet(b0);
      won = r.won;
      L0 = big((await ks()).weekNetLoss);
      expect(L0).to.equal(r.won ? r.payout - r.stakeIn : -r.stakeIn); // realized loss of the bankroll
      if (!won) { // 5%: the player lost; take lp1 out again so the next window starts low
        await houseRequest(lp1, await shareOf(lp1)).rpc();
        await sleep(1200);
        await retry(["WithdrawLocked"], () => houseWithdraw(lp1, 0n).rpc());
      }
    }
    expect(won, "a 95% bet won within 3 attempts").to.equal(true);
    // a bet whose payout fits 15% of W without the realized loss, but not with it
    const base = weekBase(W, await bankrollFree(), L0);
    expect(base).to.equal(W);
    const limit = (W * 1_500n) / 10_000n;
    let stake = ((limit - L0 / 2n) * 10_000n) / 10_315n;
    const pay = (s: bigint) => (s * 10_315n) / 10_000n;
    while (pay(stake) > limit) stake -= 1n;
    expect(pay(stake) > limit - L0 && pay(stake) <= limit).to.equal(true);
    expect((await predict(1, 9_500, 0, stake)).verdict).to.equal("WeeklyLossLimit");
    expect((await predict(1, 9_500, 0, stake, { weekLoss: 0n })).verdict).to.equal(null); // the realized loss is what binds
    await expectErr(placeV2(eve, 1, 9_500, 0, stake), "WeeklyLossLimit");
    // the window rolls 7 s after its start: the same bet is accepted against the new (larger) base
    await T.untilChainTime((await ks()).weekStartTs.toNumber() + WEEK + 1);
    const b1 = await retry(["WeeklyLossLimit"], () => placeV2(eve, 1, 9_500, 0, stake));
    expect(big((await ks()).weekStartBankroll) > W).to.equal(true);
    await settleBet(b1);
  });

  it("B-1: 5% of pending payouts (BankrollTooSmall), then the 3% daily breaker (DailyLossLimit) under 4% pending; LP guards: SlippageExceeded while > 1% is pending, WithdrawLocked, NoPendingWithdraw, NotEnoughShares", async () => {
    const V = await bankrollFree();
    expect(V > 50n * X, "a bankroll to bet against").to.equal(true);
    expect((await ks()).pendingBets, "nothing pending").to.equal(0);
    await ensureBond((V * 6n) / 100n + 2n * X); // the 4% bet below reserves 4.13% of V
    await ensureGame(eve, (V * 8n) / 100n + 2n * X);
    // WithdrawLocked: the request and the withdrawal in ONE transaction (one clock, so never a second apart); both revert
    const reqIx = await houseRequest(lp2, await shareOf(lp2)).instruction();
    const wdIx = await houseWithdraw(lp2, 0n).instruction();
    await expectErr(T.sendIxs([reqIx, wdIx], [lp2]), "WithdrawLocked");
    expect(big((await acc.houseShare.fetch(P.house(lp2.publicKey))).pendingShares)).to.equal(0n);
    // lp2's request matures while nothing is pending
    await houseRequest(lp2, await shareOf(lp2)).rpc();
    // one 95% bet of 6% of the bankroll: under the 0.25% net-win cap, above the 5% aggregate cap
    const s6 = (V * 6n) / 100n;
    const p6 = await predict(1, 9_500, 0, s6);
    expect(p6.verdict).to.equal("BankrollTooSmall");
    expect(p6.payout - s6 <= (p6.s.vault * 25n) / 10_000n).to.equal(true); // not the per-bet cap
    await expectErr(placeV2(eve, 1, 9_500, 0, s6), "BankrollTooSmall");
    // 4% passes every limit and stays pending
    const s4 = (V * 4n) / 100n;
    expect((await predict(1, 9_500, 0, s4)).verdict).to.equal(null);
    const b4 = await placeV2(eve, 1, 9_500, 0, s4);
    const reserved = big((await cfg()).bankrollReserved);
    expect(reserved * 10_000n <= (await bankrollFree()) * 500n).to.equal(true);
    // the 3% breaker: with 4% pending, even a 0.01-XNT coin flip is refused, and only by the breaker. The day start is
    // the bankroll at the day's first bet (a day = 1 s on localnet): wait for a new second, so the start is the bankroll
    // WITH the 4% stake in it (a refused bet reverts its own day start), never the value before it
    await sleep(1100);
    const tiny = await predict(0, 0, 0, 10_000_000n);
    expect(tiny.verdict).to.equal("DailyLossLimit");
    expect(tiny.s.reserved + tiny.payout <= ((tiny.s.vault + 10_000_000n) * 500n) / 10_000n).to.equal(true); // the 5% cap would pass
    await expectErr(placeV2(eve, 0, 0, 0, 10_000_000n), "DailyLossLimit");
    // LP client guard: min_lamports = the optimistic value × 0.99 fails while more than 1% is pending
    await sleep(1200);
    const c = await cfg();
    const sh = await shareOf(lp2);
    const optimistic = (sh * (await bankrollFree())) / big(c.houseTotalShares);
    expect(big(c.bankrollReserved) * 100n > await bankrollFree()).to.equal(true);
    await expectErr(houseWithdraw(lp2, (optimistic * 99n) / 100n).rpc(), "SlippageExceeded");
    await settleBet(b4);
    const c2 = await cfg();
    const opt2 = (sh * (await bankrollFree())) / big(c2.houseTotalShares);
    const l0 = big(await bal(lp2.publicKey));
    await houseWithdraw(lp2, (opt2 * 99n) / 100n).rpc();
    expect(big(await bal(lp2.publicKey)) - l0 >= (opt2 * 99n) / 100n - 10_000n).to.equal(true);
    await expectErr(houseWithdraw(lp2, 0n).rpc(), "NoPendingWithdraw");
    await houseDeposit(lp2, 5n * X).rpc();
    await expectErr(houseRequest(lp2, (await shareOf(lp2)) + 1n).rpc(), "NotEnoughShares");
  });

  // ─── B-3 / B-2 keeper ─────────────────────────────────────────────────────
  it("B-3: a stream of bets placed after the draw (one per slot) takes later positions and never blocks the settle; the winner is fixed at the draw", async () => {
    const r = (await cfg()).jackpotRound.toNumber();
    await enterJp(alice, r, 0, 3n * X).rpc();
    await enterJp(bob, r, 1, 2n * X).rpc();
    await retry(["RoundRunning"], () => drawJp(r, alice.publicKey).rpc());
    const pos = betUnpack(big((await acc.jackpotRound.fetch(P.jackpot(r))).targetSlot)).index;
    const w = await jackpotWinner(r, chain.reveal(pos)); // h and the reserved position are fixed now
    const stream: V2Bet[] = [];
    let lastAnchor = 0n;
    for (let i = 0; i < 6; i++) {
      const b = await placeV2(eve, 0, 0, i % 2, 0.05 * XNT);
      const t = betUnpack(big((await acc.bet.fetch(b.pk)).targetSlot));
      expect(t.index).to.equal(pos + 1n + BigInt(i));
      expect(t.anchor > lastAnchor).to.equal(true); // one slot after another
      lastAnchor = t.anchor;
      stream.push(b);
    }
    // the six anchors in ONE transaction once the last anchor block exists: each bet must be settled within 40 slots of
    // its own placement, and anchoring them one by one inside the settle loop cost the last bets most of that window
    await T.waitPastSlot(lastAnchor);
    const anchorIxs = await Promise.all(stream.map((b) => anchorB(b).instruction()));
    await retry(["NotReady"], () => T.sendIxs(anchorIxs, [payer]));
    const st = await send(await settleJpV2B(r, w.i, chain.reveal(pos)));
    expect(big(event(st.events, "JackpotSettled").winningTicket)).to.equal(w.ticket);
    for (const b of stream) await settleBet(b);
    await (await closeJpEntry(r, 0)).rpc();
    await (await closeJpEntry(r, 1)).rpc();
    expect((await ks()).pendingBets).to.equal(0);
  });

  it("B-2: a named successor cannot take the seat while a bet is pending (KeeperBusy); after the cancel it is KeeperAlive", async () => {
    await methods.proposeKeeper(keeper2.publicKey).accountsPartial(keeperOnly(keeper)).signers([keeper]).rpc();
    // the notice first, then the bet: an anchored bet must be settled within KEEPER_STALL_SLOTS (40 slots) of its
    // placement, so no wait sits inside that window (r5, 2026-10-25)
    await T.untilChainTime((await ks()).pendingTs.toNumber() + L.KEEPER_NOTICE + 1); // the notice on the validator clock, never a host-clock sleep
    const b = await placeV2(eve, 0, 0, 0, 0.05 * XNT);
    const c2 = new KeeperChain(Buffer.alloc(32, 0x6b), 50);
    await expectErr(retry(["KeeperNotice"], () => takeKeeperB(keeper2, c2, 20n * X, keeper.publicKey).rpc()), "KeeperBusy");
    await settleBet(b);
    await methods.proposeKeeper(PublicKey.default).accountsPartial(keeperOnly(keeper)).signers([keeper]).rpc();
    await expectErr(takeKeeperB(keeper2, c2, 20n * X, keeper.publicKey).rpc(), "KeeperAlive");
  });

  it("B-3 K-3 / ECO-2: bond 20 XNT and a 20-XNT round DRAWING: NotReady in the draw slot, every bet KeeperBondTooSmall, arm / withdraw KeeperBusy, a stranger KeeperAlive", async () => {
    await wd(0).rpc();
    await T.untilChainTime((await ks()).withdrawTs.toNumber() + L.KEEPER_NOTICE + 1); // the notice on the validator clock, never a host-clock sleep
    const bond = big((await ks()).bond);
    await retry(["KeeperNotice"], () => wd(bond - 20n * X).rpc());
    expect(big((await ks()).bond)).to.equal(20n * X);
    await wd(0).rpc(); // a new request: its notice runs while the round is drawn
    const wts = (await ks()).withdrawTs.toNumber();
    const r = (await cfg()).jackpotRound.toNumber();
    await enterJp(alice, r, 0, 10n * X).rpc();
    await enterJp(bob, r, 1, 10n * X).rpc();
    await expectErr(enterJp(carol, r, 2, 10_000_000n).rpc(), ""); // carol has no game wallet; the pot is full anyway
    // the draw and a settle in the same transaction: the anchor block does not exist yet
    const drawIx = await drawJp(r, alice.publicKey).instruction();
    const settleIx = await (await settleJpV2B(r, 0, Buffer.alloc(32, 2))).instruction();
    await expectErr(retry(["RoundRunning"], () => T.sendIxs([drawIx, settleIx], [payer])), "NotReady");
    await drawJp(r, alice.publicKey).rpc();
    const k = await ks();
    expect(big(k.jackpotReserved)).to.equal(20n * X);
    expect(k.pendingBets).to.equal(1);
    expect((await predict(0, 0, 0, 10_000_000n)).verdict).to.equal("KeeperBondTooSmall");
    await expectErr(placeV2(eve, 0, 0, 0, 10_000_000n), "KeeperBondTooSmall");
    await expectErr(armB(keeper, keccak(Buffer.from("rearm")), 10, 0).rpc(), "KeeperBusy");
    // the notice on the validator clock (it can lag the host clock), so that only KeeperBusy can refuse
    await T.untilChainTime(wts + L.KEEPER_NOTICE + 1);
    await expectErr(wd(20n * X).rpc(), "KeeperBusy");
    await expectErr(takeKeeperB(stranger, new KeeperChain(Buffer.alloc(32, 0x71), 10), 20n * X, keeper.publicKey).rpc(), "KeeperAlive");
    drawing = { r, anchor: betUnpack(big((await acc.jackpotRound.fetch(P.jackpot(r))).targetSlot)).anchor, lastActive: k.lastActiveTs.toNumber() };
  });

  // ─── B-7 the full-tier freeze ──────────────────────────────────────────────
  it("B-7: a full tier never decays (Void, supply 10): SoldOut; > 1 period later a recycle restarts the clock; the next forge pays exactly one decay step", async () => {
    const mine: PublicKey[] = [];
    for (let c = await cfg(); c.artifactsAlive[3] < 10; c = await cfg()) {
      const price = currentPrice(c, 3, await T.chainTime());
      if (big(await bal(smith.publicKey)) < price + 20n * X) await fund(smith.publicKey, Number(price / X) + 50);
      mine.push((await forge(smith, 3)).asset);
    }
    expect(mine.length > 0, "the suite forged at least one Void").to.equal(true);
    const full = await cfg();
    const stored = big(full.artifactPrice[3]);
    await expectErr(forge(smith, 3), "SoldOut");
    await T.untilChainTime(full.artifactPriceTs.toNumber ? 0 : 0);
    const tsFull = Number(full.artifactPriceTs[3]);
    await T.untilChainTime(tsFull + 15); // more than one 14-s decay period while full
    expect(currentPrice(await cfg(), 3, await T.chainTime())).to.equal(stored); // the TS mirror agrees: no decay
    const rc = await T.txInfo(await recycleB(smith, mine[mine.length - 1]).rpc());
    const c2 = await cfg();
    expect(c2.artifactsAlive[3]).to.equal(9);
    expect(big(c2.artifactPrice[3])).to.equal(stored); // the stored price did not move while full
    expect(Number(c2.artifactPriceTs[3])).to.equal(rc.blockTime); // the clock restarts at the recycle
    await T.untilChainTime(rc.blockTime + 15);
    const f = await forge(smith, 3);
    const steps = Math.floor((f.info.blockTime - rc.blockTime) / 14);
    expect(steps).to.equal(1);
    expect(f.price).to.equal((stored * 20n) / 21n); // one step since the recycle, not two since the last forge
    expect(f.price).to.equal(currentPrice(c2, 3, f.info.blockTime));
  });

  // ─── B-9 oracle seat ───────────────────────────────────────────────────────
  it("B-9: resign: walk errors (BadEpochWindow), the successor-only window (SeatPriority), SeatResigned with the bond to the pool, SeatOpen, the successor takes (forfeited 0)", async () => {
    await catchUpExtras();
    const b = await nextBase(1000n, 1_000_000n);
    await catchUpExtras();
    await T.untilChainTime(b.at + L.CLAIM_HOLD + 1); // epoch b survived its hold: the seat is alive
    const n = b.n;
    const meta = (k: PublicKey) => ({ pubkey: k, isSigner: false, isWritable: false });
    await expectErr(resignB(erin.publicKey, P.reward, []).rpc(), "BadEpochWindow"); // missing pair
    await expectErr(resignB(erin.publicKey, P.reward, [meta(P.epoch(n - 1)), meta(P.extraEpoch(n - 1))]).rpc(), "BadEpochWindow"); // out of order
    await expectErr(resignB(erin.publicKey, P.reward, [meta(P.epoch(n)), meta(P.extraEpoch(n - 1))]).rpc(), "BadEpochWindow"); // wrong extra PDA
    await expectErr(resignB(erin.publicKey, P.reward, [meta(P.config), meta(P.extraEpoch(n))]).rpc(), "BadEpochWindow"); // foreign account
    await expectErr(resignB(erin.publicKey, alice.publicKey, pairs(n, 2)).rpc(), "InvalidTarget"); // refund = default → the pool only
    // the gate in one transaction: resign + a stranger's take in the same second → SeatPriority (all reverted)
    const resignIx = await resignB(erin.publicKey, P.reward, pairs(n, 2)).instruction();
    const takeIx = await takeSeatB(frank, []).instruction();
    await expectErr(T.sendIxs([resignIx, takeIx], [frank, cold]), "SeatPriority");
    expect((await seatAcc()).openSince.toNumber()).to.equal(0);
    const s0 = await seatAcc();
    const pool0 = big(await bal(P.reward)), don0 = big((await cfg()).stats.donatedReward);
    const rs = await send(resignB(erin.publicKey, P.reward, pairs(n, 2))); // an unneeded extra pair after the closing one is ignored
    const ev = event(rs.events, "SeatResigned");
    expect([ev.generation.toString(), ev.successor.toBase58(), ev.refund.toBase58(), big(ev.bondReturned)])
      .to.deep.equal([s0.generation.toString(), erin.publicKey.toBase58(), P.reward.toBase58(), big(s0.bond)]);
    expect(big(await bal(P.reward)) - pool0).to.equal(big(s0.bond));
    expect(big((await cfg()).stats.donatedReward) - don0).to.equal(big(s0.bond));
    const s1 = await seatAcc();
    expect([big(s1.bond), s1.priority.toBase58(), s1.openSince.toNumber() > 0]).to.deep.equal([0n, erin.publicKey.toBase58(), true]);
    await expectErr(resignB(erin.publicKey, P.reward, pairs(n, 2)).rpc(), "SeatOpen");
    const free = await poolFree();
    const tk = await send(takeSeatB(erin, [], erin.publicKey));
    const sc = event(tk.events, "SeatChanged");
    expect([sc.reason, big(sc.forfeited), big(sc.bond)]).to.deep.equal([2, 0n, seatBond(free)]);
    expect(event(tk.events, "OracleChanged").by).to.equal(2);
    const s2 = await seatAcc();
    expect([s2.generation.toNumber(), s2.refund.toBase58(), s2.openSince.toNumber()]).to.deep.equal([s0.generation.toNumber() + 1, erin.publicKey.toBase58(), 0]);
    seatT = s2.takenAt.toNumber();
  });

  it("B-9 S-1 + dead by voids: five 10-XNT base epochs with heartbeat extras voided by carol (0.05 XNT BondTooSmall, 1 XNT each), two bases voided too; the seat is dead: a cold resign is SeatDead, carol takes it (the bond forfeited to the pool)", async () => {
    // five 10-XNT budgets need 10% of the free pool >= 10 XNT at every publish (each base reserves its budget)
    const free0 = await poolFree();
    if (free0 < 200n * X) {
      await methods.donate(0, BN(200n * X - free0)).accountsPartial({ config: P.config, donor: payer.publicKey, vault: P.reward, systemProgram: SYS }).rpc();
    }
    expect(await poolFree() >= 200n * X, "the pool affords 10-XNT budgets").to.equal(true);
    const pool0 = big(await bal(P.reward));
    const tips0 = big((await cfg()).stats.keeperTips);
    let bonds = 0n;
    for (let i = 1; i <= 5; i++) {
      // bases 2 and 4 are voided too, in their publishing transaction (inside the hold), with a 2-XNT bond (priority)
      const n = i === 2 || i === 4 ? await baseAndVoid(10n, X, carol, 2n * X) : (await nextBase(10n, X)).n;
      if (i === 2 || i === 4) bonds += 2n * X;
      expect(big((await acc.epoch.fetch(P.epoch(n))).budget)).to.equal(10n * X);
      // S-1: the heartbeat's void is priced on the 10-XNT base, not on the extra's own 0 budget
      await expectErr(heartbeatAndVoid(n, carol, BigInt(L.VOID_BOND_MIN)), "BondTooSmall");
      const need = voidBond(10n * X);
      expect(need).to.equal(X);
      const ve = await heartbeatAndVoid(n, carol, need);
      expect(big(event(ve.events, "ExtraEpochVoided").returnedToPot)).to.equal(0n);
      bonds += need;
    }
    // D-47: a void sent in the publishing transaction makes the reward vault writable for the whole transaction, so
    // publish_epoch pays the oracle its allowance there (the Epoch rent back: the oracle wallet is above 0.25 XNT),
    // booked in keeper_tips; nothing else in this case touches keeper_tips
    const allowances = big((await cfg()).stats.keeperTips) - tips0;
    expect(allowances, "two allowances, one per base voided in its publishing transaction").to.equal(2n * BigInt(await T.rentFor(207)));
    expect(big(await bal(P.reward)) - pool0).to.equal(bonds - allowances); // 5 × 1 XNT (S-1) + the two base voids, all to the pool
    const s = await seatAcc();
    expect([s.priority.toBase58(), big(s.priorityBond)]).to.deep.equal([carol.publicKey.toBase58(), 2n * X]);
    // every epoch since the take was voided (base or extra): past both delays the seat is dead for everyone
    await T.untilChainTime(seatT + DEAD + PRIORITY + 1);
    await expectErr(resignB(cold.publicKey, P.reward, await walk()).rpc(), "SeatDead");
    const pool1 = big(await bal(P.reward)), forfeit = big((await seatAcc()).bond);
    const tk = await retry(["SeatAlive"], async () => send(takeSeatB(carol, await walk())), 40, 200);
    const sc = event(tk.events, "SeatChanged");
    expect([sc.reason, big(sc.forfeited)]).to.deep.equal([1, forfeit]);
    expect(big(await bal(P.reward)) - pool1).to.equal(forfeit);
    const s2 = await seatAcc();
    expect([s2.priority.toBase58(), big(s2.priorityBond)], "a new generation starts with no priority").to.deep.equal([PublicKey.default.toBase58(), 0n]);
    seatT = s2.takenAt.toNumber();
  });

  it("B-9 priority window: one voided heartbeat after the take gives frank priority; at the clock second taken + 29 frank's take simulates OK while erin's is SeatAlive (29 s vs 30 s); frank takes", async () => {
    // dead iff taken_at < now − delay: the priority voider waits DEAD (28 s, takes from taken + 29), everyone else
    // DEAD + PRIORITY (from taken + 30). The verdict of a take depends only on the clock (nothing else changes while
    // this polls), so EVERY simulation is checked against the clock of the confirmed bank that ran it (the Clock sysvar
    // a successful simulation returns: CLOCK_META after the walk, which the walk never reads; else that slot's block
    // time, the same value), and the window is proven once frank's take is OK and erin's SeatAlive at the clock second
    // taken + 29, in the same bank or not. A loaded validator can skip that clock second (no confirmed bank carries
    // it) or stall its RPC across it (acceptance runs 1-3 of 2026-10-23: the two simulations of one JSON-RPC batch ran
    // up to 3 slots and 6 clock seconds apart, so the old same-slot rule never held): then frank takes the seat anyway
    // (a new generation, set up exactly like the first: frank's voided heartbeat after the take, the same walk) and
    // the window is polled again, up to 5 generations. Every generation is the same function of (taker, dt), so the
    // two observations at taken + 29 may come from different generations. A verdict that contradicts its clock fails
    // at once, in any generation.
    const FRANK_FROM = DEAD + 1, ERIN_FROM = DEAD + PRIORITY + 1; // first dt (now − taken_at) at which each take is OK
    const attempts: string[] = [];
    const at29 = { frank: false, erin: false };
    let proven = false;
    for (let attempt = 1; attempt <= 5 && !proven; attempt++) {
      const b = await nextBase(10n, X);
      await heartbeatAndVoid(b.n, frank, X);
      expect((await seatAcc()).priority.toBase58()).to.equal(frank.publicKey.toBase58());
      const rem = [...(await walk()), CLOCK_META];
      const who = [
        { name: "frank", k: frank, ix: await takeSeatB(frank, rem).instruction(), from: FRANK_FROM },
        { name: "erin", k: erin, ix: await takeSeatB(erin, rem).instruction(), from: ERIN_FROM },
      ];
      const list = who.map((w) => ({ ixs: [w.ix], payer: w.k.publicKey, commitment: "confirmed" as const, w }));
      const seen: string[] = [];
      let observations = 0, sameBank = false;
      const srcs: Record<string, number> = {};
      const here = { frank: false, erin: false }; // seen at taken + 29 in this generation
      await T.untilChainTime(seatT + FRANK_FROM - 2);
      for (let i = 0; i < 3000 && !(at29.frank && at29.erin); i++) {
        const res = await T.simulateMany(list);
        let allPast = true;
        const bySlot = new Map<number, Set<string>>();
        res.forEach((r, j) => {
          const w = list[j].w;
          expect(Number.isFinite(r.now), `the clock of slot ${r.slot} read`).to.equal(true);
          srcs[r.src] = (srcs[r.src] ?? 0) + 1;
          const dt = r.now - seatT;
          observations++;
          if (dt <= FRANK_FROM) allPast = false;
          if (dt >= w.from) expect(r.err, `${w.name} at taken + ${dt} s (slot ${r.slot}, ${list[j].commitment}): ${r.err}`).to.equal(null);
          else expect(errMatches(r.err ?? "", "SeatAlive"), `${w.name} at taken + ${dt} s (slot ${r.slot}, ${list[j].commitment}): ${r.err}`).to.equal(true);
          if (dt === FRANK_FROM) {
            at29[w.name as "frank" | "erin"] = true;
            here[w.name as "frank" | "erin"] = true;
            bySlot.set(r.slot, new Set([...(bySlot.get(r.slot) ?? []), w.name]));
          }
        });
        if ([...bySlot.values()].some((s) => s.size === 2)) sameBank = true;
        if (seen.length < 60) seen.push(res.map((r) => `${r.slot}@${Number.isFinite(r.now) ? r.now - seatT : "?"}`).join("/"));
        if (allPast) break; // every bank polled is past taken + 29: the window is gone for this generation
      }
      proven = at29.frank && at29.erin;
      attempts.push(`attempt ${attempt}: ${observations} verdicts checked (clock from ${JSON.stringify(srcs)}), taken + ${FRANK_FROM} s seen for frank ${at29.frank} / erin ${at29.erin}`
        + `${sameBank ? " (both in one bank)" : ""}; polls slot@dt frank/erin: ${seen.join(" ")}`);
      // frank takes now (any time from taken + 29 s): a new generation, which the next attempt (if any) starts from
      const tk = await retry(["SeatAlive"], async () => send(takeSeatB(frank, await walk())), 40, 200);
      expect(event(tk.events, "SeatChanged").reason).to.equal(1);
      seatT = (await seatAcc()).takenAt.toNumber();
    }
    console.log(`      priority window: ${attempts.map((a) => a.slice(0, a.indexOf("; polls"))).join("\n        ")}`);
    if (attempts.length > 1 || !proven) console.log(`        ${attempts.join("\n        ")}`);
    expect(proven, `frank OK and erin SeatAlive both seen at taken + ${FRANK_FROM} seconds; attempts\n${attempts.join("\n")}`).to.equal(true);
    coverage.error("SeatAlive");
  });

  it("B-9 (theft case 7): tiny base epochs (1 lamport) whose heartbeat extras are voided at 0.05 XNT keep the seat dead: after 5 pairs dave (priority) takes at taken + 29 s", async () => {
    for (let i = 1; i <= 5; i++) {
      const b = await nextBase(1n, 1n);
      expect(b.budget).to.equal(1n);
      await heartbeatAndVoid(b.n, dave, BigInt(L.VOID_BOND_MIN)); // 10% of max(0, 1 lamport) → the 0.05-XNT minimum
    }
    expect((await seatAcc()).priority.toBase58()).to.equal(dave.publicKey.toBase58());
    await T.untilChainTime(seatT + DEAD + 1);
    const tk = await retry(["SeatAlive"], async () => send(takeSeatB(dave, await walk())), 40, 200);
    expect(event(tk.events, "SeatChanged").reason).to.equal(1);
    seatT = (await seatAcc()).takenAt.toNumber();
  });

  it("B-9 (case 7, other half) + B-10 X-3: tiny bases WITHOUT extras survive (SeatAlive at taken + 30 s); three heartbeats in one transaction after the gap; real extras still 6 s apart", async () => {
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) ids.push((await nextBase(1n, 1n)).n);
    await T.untilChainTime(seatT + DEAD + 2);
    const sim = await T.simulateAt([await takeSeatB(stranger, [...(await walk()), CLOCK_META]).instruction()], [stranger]);
    expect(sim.now >= seatT + DEAD + 2, `clock ${sim.now}`).to.equal(true);
    expect(errMatches(sim.err ?? "", "SeatAlive"), `the extra-less tiny bases keep the seat alive: ${sim.err}`).to.equal(true);
    await expectErr(takeSeatB(stranger, await walk()).rpc(), "SeatAlive");
    // X-3: the extra pot lags five ids; three heartbeats land in ONE transaction (no interval), last_publish_ts untouched
    const x0 = await xs();
    expect(x0.lastEpoch.toNumber()).to.equal(ids[0] - 1);
    const hb = await Promise.all(ids.slice(0, 3).map(async (id) => publishExtra(id, Buffer.alloc(32), 0n, 0).instruction()));
    await T.sendIxs(hb, [oracle]);
    coverage.ok("publish_extra_epoch");
    const x1 = await xs();
    expect([x1.lastEpoch.toNumber(), x1.lastPublishTs.toString()]).to.deep.equal([ids[2], x0.lastPublishTs.toString()]);
    // a real extra right away: the last REAL one is more than 6 s old
    expect((await T.chainTime()) >= x0.lastPublishTs.toNumber() + L.MIN_EPOCH_INTERVAL).to.equal(true);
    const t4 = tree([extraLeaf(ids[3], 0, alice.publicKey, 1_000_000n)]);
    const r4 = await send(publishExtra(ids[3], t4.root, 1_000_000n, 1));
    expect(big(event(r4.events, "ExtraEpochPublished").total)).to.equal(1_000_000n);
    // the next real extra waits 6 s after it (heartbeats do not need, nor reset, that clock)
    const t5 = tree([extraLeaf(ids[4], 0, alice.publicKey, 1_000_000n)]);
    await expectErr(publishExtra(ids[4], t5.root, 1_000_000n, 1).rpc(), "ExtraEpochOrder");
    await retry(["ExtraEpochOrder"], () => publishExtra(ids[4], t5.root, 1_000_000n, 1).rpc(), 60, 300);
    const e4 = await acc.extraEpoch.fetch(P.extraEpoch(ids[3])), e5 = await acc.extraEpoch.fetch(P.extraEpoch(ids[4]));
    expect(e5.publishedAt.toNumber() - e4.publishedAt.toNumber() >= L.MIN_EPOCH_INTERVAL).to.equal(true);
  });

  // ─── round 4: quiet-month seat liveness (s6-minus-7 MANIFEST §4 item 4) ────────
  it("Round 4 heartbeat: a base epoch with no leaves (score 0, leaves 0, rate cap 0, zero root) goes through the live 108-B publish_epoch with budget 0 (D-47 inside its bound); half-empty shapes stay EmptyEpoch; it holds the 6-s interval; no claim reaches it (EmptyEpoch); its void returns 0; heartbeats alone keep the seat alive more than 28 s after the last paying epoch", async () => {
    const Z = Buffer.alloc(32);
    const hbIx = async (n: number, writable = true) => {
      const ix = await publish(n, Z, 0n, 0, 0n).instruction();
      expect(ix.data.length, "the publish_epoch ABI is unchanged").to.equal(108);
      ix.keys.find((k) => k.pubkey.equals(P.reward))!.isWritable = writable; // the v3 oracle client (D-47)
      return ix;
    };
    const c0 = await cfg();
    const paidAt = (await acc.epoch.fetch(P.epoch(c0.lastEpoch.toNumber()))).publishedAt.toNumber(); // the last paying epoch
    let n = c0.lastEpoch.toNumber() + 1;
    await T.untilChainTime(c0.lastPublishTs.toNumber() + L.MIN_EPOCH_INTERVAL);
    // anything half-empty is still refused
    for (const [root, leaves, cap] of [[Buffer.alloc(32, 7), 0, 0n], [Z, 1, 0n], [Z, 0, 1n]] as [Buffer, number, bigint][]) {
      await expectErr(publish(n, root, 0n, leaves, cap).rpc(), "EmptyEpoch");
    }
    // the heartbeat: budget 0, nothing reserved; the D-47 allowance alone leaves the vault, booked as a tip
    const res0 = big(c0.rewardReserved), tips0 = big(c0.stats.keeperTips), v0 = big(await bal(P.reward));
    const info = await T.txInfo(await retry(["EpochTooSoon"], async () => T.sendIxs([await hbIx(n)], [payer, oracle]), 120, 300));
    coverage.ok("publish_epoch");
    const ev = event(info.events, "EpochPublished");
    expect([big(ev.budget), big(ev.totalScore), ev.leaves, big(ev.dropReserve)]).to.deep.equal([0n, 0n, 0, 0n]);
    const c1 = await cfg();
    expect(big(c1.rewardReserved), "a heartbeat reserves nothing").to.equal(res0);
    expect(big(ev.oracleAllowance) * 100n <= big(ev.freePoolBefore), "D-47: at most 1% of the free pool").to.equal(true);
    expect([v0 - big(await bal(P.reward)), big(c1.stats.keeperTips) - tips0]).to.deep.equal([big(ev.oracleAllowance), big(ev.oracleAllowance)]);
    const e = await acc.epoch.fetch(P.epoch(n));
    expect([big(e.budget), big(e.totalScore), e.leaves, big(e.rateCap), Buffer.from(e.root).equals(Z)]).to.deep.equal([0n, 0n, 0, 0n, true]);
    // it holds the interval like any epoch, heartbeat or not
    await expectErr(publish(n + 1, Z, 0n, 0, 0n).rpc(), "EpochTooSoon");
    await expectErr(publish(n + 1, Buffer.alloc(32, 7), 1n, 1, 1n).rpc(), "EpochTooSoon");
    // no claim reaches it, after its hold either (nothing to divide by: EmptyEpoch before any proof)
    await T.untilChainTime(e.publishedAt.toNumber() + L.CLAIM_HOLD);
    await expectErr(claimInstantB(n, { p: alice.publicKey, t: 0, s: 0n }, [], alice).rpc(), "EmptyEpoch");
    await expectErr(claimInstantB(n, { p: alice.publicKey, t: 0, s: 1n }, [Array.from(Z)], alice).rpc(), "EmptyEpoch");
    // a heartbeat voided inside its hold returns nothing. r4-fix (review r4 finding 3): a non-cold voider must post
    // SEAT_BOND_MIN (the 0.05-XNT minimum is refused, atomically with the publish) and earns no takeover priority
    n += 1;
    const prio0 = (await seatAcc()).priority.toBase58();
    const cheap = [await hbIx(n, false), await voidB(n, stranger, BigInt(L.VOID_BOND_MIN)).instruction()];
    await retry(["EpochTooSoon"], async () => {
      const r = await T.sendIxs(cheap, [stranger, oracle]).then(() => "accepted", (e: any) => errText(e));
      if (r === "accepted" || !errMatches(r, "BondTooSmall")) throw new Error(`a 0.05-XNT heartbeat void: ${r}`); // the whole text: retry() looks for EpochTooSoon in it
    }, 120, 300);
    coverage.error("BondTooSmall");
    const vIxs = [await hbIx(n, false), await voidB(n, stranger, BigInt(L.SEAT_BOND_MIN)).instruction()];
    const vinfo = await T.txInfo(await retry(["EpochTooSoon"], async () => T.sendIxs(vIxs, [stranger, oracle]), 120, 300));
    coverage.ok("publish_epoch");
    coverage.ok("void_epoch");
    const vd = event(vinfo.events, "EpochVoided");
    expect([big(vd.bond), big(vd.returnedToPool)]).to.deep.equal([BigInt(L.SEAT_BOND_MIN), 0n]);
    expect((await seatAcc()).priority.toBase58(), "r4-fix: a heartbeat void earns no priority").to.equal(prio0);
    // heartbeats only, until the last paying epoch is more than 28 s + 24 h (1 s) old
    let last = n;
    while ((await T.chainTime()) < paidAt + DEAD + PRIORITY + 2) {
      last = (await cfg()).lastEpoch.toNumber() + 1;
      await retry(["EpochTooSoon"], async () => T.sendIxs([await hbIx(last)], [payer, oracle]), 120, 300);
      coverage.ok("publish_epoch");
    }
    await T.untilChainTime((await acc.epoch.fetch(P.epoch(last))).publishedAt.toNumber() + L.CLAIM_HOLD); // the newest survived
    expect((await T.chainTime()) > paidAt + DEAD + PRIORITY + 1, "the last paying epoch is older than both take delays").to.equal(true);
    // the seat lives on its heartbeats: neither the priority voider (28 s) nor anyone else (29 s) can take it
    await expectErr(takeSeatB(stranger, await walk()).rpc(), "SeatAlive");
    await expectErr(takeSeatB(erin, await walk()).rpc(), "SeatAlive");
    coverage.error("SeatAlive");
    // the extra pot follows the base ids: a heartbeat extra for every heartbeat base (no interval)
    await catchUpExtras();
  });

  // ─── B-2 the dead keeper seat ──────────────────────────────────────────────
  it("B-2: 28 s without keeper activity the seat is dead but KeeperBusy while the round is DRAWING; after the 512-slot expiry (reason 2) anyone takes it; then it is handed back", async () => {
    const d = drawing!;
    await T.untilChainTime(d.lastActive + DEAD + 1);
    const c2 = new KeeperChain(keccak(Buffer.from("keeper2"), payer.publicKey.toBuffer()), 100);
    await expectErr(takeKeeperB(keeper2, c2, 20n * X, keeper.publicKey).rpc(), "KeeperBusy");
    await T.waitHashGone(d.anchor);
    const ex = await send(await settleJpV2B(d.r, 0, Buffer.alloc(32, 3)));
    const br = event(ex.events, "BetRefunded");
    expect([br.reason, big(br.penalty)]).to.deep.equal([2, 20n * X]);
    expect([big((await ks()).bond), (await ks()).pendingBets]).to.deep.equal([0n, 0]);
    await (await closeJpEntry(d.r, 0)).rpc();
    await (await closeJpEntry(d.r, 1)).rpc();
    // dead + nothing pending: anyone takes it (by 1); the old bond (now 0) goes back to the old keeper
    const tk = await send(takeKeeperB(keeper2, c2, 20n * X, keeper.publicKey));
    expect(event(tk.events, "KeeperChanged").by).to.equal(1);
    expect((await ks()).keeper.toBase58()).to.equal(keeper2.publicKey.toBase58());
    // and back to the fixture keeper (the kit e2e runs with it)
    await methods.proposeKeeper(keeper.publicKey).accountsPartial(keeperOnly(keeper2)).signers([keeper2]).rpc();
    await T.untilChainTime((await ks()).pendingTs.toNumber() + L.KEEPER_NOTICE + 1); // the notice on the validator clock, never a host-clock sleep
    newChain(400);
    const k20 = big(await bal(keeper2.publicKey));
    const back = await retry(["KeeperNotice"], () => send(takeKeeperB(keeper, chain, 300n * X, keeper2.publicKey)));
    expect(event(back.events, "KeeperChanged").by).to.equal(0);
    expect(big(await bal(keeper2.publicKey)) - k20).to.equal(20n * X);
  });

  // ─── round 4: the keeper bets on its own house (review F1, s6-minus-7 MANIFEST §4 item 8) ──────────
  const refundSB = (b: V2Bet) => methods.refundStalledBet().accountsPartial({
    config: P.config, bet: b.pk, playerState: b.ps, bankrollVault: P.bankroll, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: b.owner.publicKey,
    keeperSeat: P.keeper, rewardVault: P.reward,
  });
  const revealSkip = (reveal: Buffer) => methods.revealKeeper(Array.from(reveal)).accountsPartial({ keeperSeat: P.keeper, keeper: keeper.publicKey }).signers([keeper]);
  /** the keeper's money (game wallet, bond, wallet), the bankroll, the reward pool and the placement edge booked to it */
  const books = async () => {
    const c = await cfg();
    return {
      game: await gameBal(keeper.publicKey), bond: big((await ks()).bond), wallet: big(await bal(keeper.publicKey)),
      bank: big(await bal(P.bankroll)), pool: big(await bal(P.reward)), edgeToPool: big(c.stats.edgeToPool), tips: big(c.stats.keeperTips),
    };
  };
  let selfBet: { b: V2Bet; stake: bigint; anchor: bigint; index: bigint; before: Awaited<ReturnType<typeof books>> } | null = null;

  it("Round 4 (review F1): the keeper bets on its own house: an anchored self-bet it skips is paid as a win BY ITS OWN BOND (the bankroll keeps the stake, the pool gets nothing), so the skip costs it exactly its stake, like a loss; a settled self-bet pays its registered wallet the G-2 tip; a third is left unanchored for the F1 tail", async () => {
    await ensureGame(keeper, 2n * X);
    const stake = X / 20n, edge = betEdge(X / 20n), stakeIn = X / 20n - betEdge(X / 20n);
    const k0 = await ks();
    expect([k0.keeper.toBase58(), k0.pendingBets, big(k0.revealed)]).to.deep.equal([keeper.publicKey.toBase58(), 0, big(k0.nextIndex)]);
    // 1. placed, anchored (the keeper now knows the outcome), then skipped by the keeper itself: reason 1
    const b0 = await books();
    const bS = await placeV2(keeper, 0, 0, 1, stake);
    const pS = betUnpack(big((await acc.bet.fetch(bS.pk)).targetSlot)).index;
    await anchorWhenReady(bS);
    const betS = await acc.bet.fetch(bS.pk);
    await revealSkip(chain.reveal(pS)).rpc();
    const rf = await send(refundSB(bS));
    const ev = event(rf.events, "BetRefunded");
    expect([ev.reason, big(ev.penalty)]).to.deep.equal([1, stakeIn]);
    const b1 = await books();
    expect(b1.game - b0.game, "paid as a win into the keeper's game wallet").to.equal(big(betS.payout) - stake);
    expect(b1.bond - b0.bond, "... by its own bond").to.equal(-big(betS.payout));
    expect(b1.game + b1.bond - (b0.game + b0.bond), "the skip costs the keeper exactly its stake, what a lost bet costs").to.equal(-stake);
    expect(b1.bank - b0.bank, "the bankroll keeps the stake (a lost bet)").to.equal(stakeIn);
    expect([b1.pool - b0.pool, b1.edgeToPool - b0.edgeToPool], "the pool gets the placement edge only").to.deep.equal([b1.edgeToPool - b0.edgeToPool, b1.edgeToPool - b0.edgeToPool]);
    expect(b1.edgeToPool - b0.edgeToPool <= edge).to.equal(true);
    expect([b1.wallet, b1.tips], "no tip for a stall").to.deep.equal([b0.wallet, b0.tips]);
    // 2. placed, anchored and settled honestly: the registered keeper wallet gets the G-2 tip from the free pool
    const w0 = await books();
    const bH = await placeV2(keeper, 0, 0, 0, stake); // the keeper wallet pays the bet rent, and gets it back at the settle
    await settleBet(bH); // anchors, settles with the next reveal (the client resolves `keeper` from the seat), checks the roll
    const tip = [500_000n, (stake * 100n) / 10_000n / 2n].reduce((a, x) => (x < a ? x : a));
    const w1 = await books();
    expect([w1.wallet - w0.wallet, w1.tips - w0.tips], "G-2 tip to the registered keeper wallet, booked in keeper_tips").to.deep.equal([tip, tip]);
    expect(w1.pool - w0.pool, "the pool: + the placement edge − the tip").to.equal(w1.edgeToPool - w0.edgeToPool - tip);
    // 3. placed and never anchored (the strategy F1 priced at +0.465 × stake): the F1 tail refunds it after 512 slots
    const before = await books();
    const bU = await placeV2(keeper, 0, 0, 1, stake);
    const t = betUnpack(big((await acc.bet.fetch(bU.pk)).targetSlot));
    selfBet = { b: bU, stake, anchor: t.anchor, index: t.index, before };
  });

  // ─── B-13 airdrop to exhaustion ────────────────────────────────────────────
  it("B-13: airdrop claims up to AIRDROP_MAX (120), then AirdropExhausted", async () => {
    const tr = tree(airdropWallets.map((k) => airdropLeaf(k.publicKey)));
    let c = await cfg();
    if (!c.airdropRootSet) {
      expect(c.architect.toBase58(), "alone: the localnet ARCHITECT sets the list").to.equal(architect0.publicKey.toBase58());
      await methods.setAirdropRoot(Array.from(tr.root)).accountsPartial({ config: P.config, architect: architect0.publicKey }).signers([architect0]).rpc();
      c = await cfg();
    }
    const from = c.airdropClaimed;
    // fund the remaining claimants (rent of the receipt, record and asset), 20 transfers per transaction
    const todo = airdropWallets.slice(from);
    for (let i = 0; i < todo.length; i += 20) {
      const tx = new Transaction().add(...todo.slice(i, i + 20).map((k) => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports: 30_000_000 })));
      await provider.sendAndConfirm(tx);
    }
    const claim = (i: number, serial: number) => methods.claimAirdrop(serial, tr.proof(i)).accountsPartial({
      config: P.config, receipt: P.pda(Buffer.from("airdrop"), airdropWallets[i].publicKey.toBuffer()), asset: P.asset(0, serial), record: P.artifact(P.asset(0, serial)),
      collection: P.collection, artifactAuthority: P.authority, claimant: airdropWallets[i].publicKey, coreProgram: MPL_CORE, systemProgram: SYS,
    }).signers([airdropWallets[i]]);
    for (let i = from; i < AIRDROP_MAX; i++) await claim(i, (await cfg()).artifactsMinted[0]).rpc();
    c = await cfg();
    expect(c.airdropClaimed).to.equal(AIRDROP_MAX);
    await expectErr(claim(AIRDROP_MAX, c.artifactsMinted[0]).rpc(), "AirdropExhausted");
  });

  // ─── tails: windows that needed time ───────────────────────────────────────
  it("Round 4 (review F1) tail: the self-bet the keeper never anchored refunds once its block left SlotHashes (reason 0), the whole stake paid BY ITS BOND: since its placement the keeper lost exactly the stake, like a loss (selective anchoring no longer pays), the bankroll kept it, the pool got nothing more; the keeper then skips the dead position", async () => {
    const sb = selfBet!;
    await T.waitHashGone(sb.anchor);
    await expectErr(anchorB(sb.b).rpc(), "BetStalled");
    const stakeIn = sb.stake - betEdge(sb.stake);
    const pre = await books();
    const rf = await send(refundSB(sb.b));
    const ev = event(rf.events, "BetRefunded");
    expect([ev.reason, big(ev.penalty)]).to.deep.equal([0, stakeIn]);
    const post = await books();
    expect(post.game - pre.game, "made whole").to.equal(sb.stake);
    expect(post.bond - pre.bond, "by its own bond (the whole stake; 2 × edge before round 4)").to.equal(-sb.stake);
    expect([post.bank - pre.bank, post.pool - pre.pool, post.tips - pre.tips], "r4-fix: the bankroll returns stake_in; nothing to the pool, no tip").to.deep.equal([-stakeIn, 0n, 0n]);
    const s = sb.before;
    expect(post.game + post.bond - (s.game + s.bond), "since its placement: minus the stake, what a lost bet costs").to.equal(-sb.stake);
    expect(post.bank - s.bank, "r4-fix: the bankroll is back where it was (the bet is undone; review r4 finding 1: no LP gains)").to.equal(0n);
    // the keeper consumes the dead position; nothing is left pending
    await revealSkip(chain.reveal(sb.index)).rpc();
    const k = await ks();
    expect([k.pendingBets, big(k.revealed)]).to.deep.equal([0, big(k.nextIndex)]);
    selfBet = null;
  });

  it("B-13 tail: a claim after the 90-s window is ClaimWindowClosed; an LP request unused for 60 s is WithdrawExpired, renewed and withdrawn", async () => {
    await T.untilChainTime(late.at + L.CLAIM_WINDOW + 1);
    await expectErr(claimInstantB(late.n, late.leaves[0], late.tr.proof(0), alice).rpc(), "ClaimWindowClosed");
    await T.untilChainTime(lpXRequestAt + HOUSE_WITHDRAW_DELAY + HOUSE_WITHDRAW_WINDOW + 1);
    await expectErr(houseWithdraw(lpX, 0n).rpc(), "WithdrawExpired");
    await houseRequest(lpX, await shareOf(lpX)).rpc();
    await sleep(1200);
    const x0 = big(await bal(lpX.publicKey));
    await retry(["WithdrawLocked"], () => houseWithdraw(lpX, 0n).rpc());
    expect(big(await bal(lpX.publicKey)) > x0).to.equal(true);
    expect(await shareOf(lpX)).to.equal(0n);
    // lp1 leaves too: the weekly case lifted the bankroll to 4 W, and the kit e2e after this suite sizes its bets on
    // the bankroll it finds (it was written against the bankroll the earlier suites leave)
    const s1 = await acc.houseShare.fetchNullable(P.house(lp1.publicKey));
    if (s1 && big(s1.shares) > 0n) {
      expect((await ks()).pendingBets, "nothing pending: the conservative value is the full value").to.equal(0);
      await houseRequest(lp1, big(s1.shares)).rpc();
      await sleep(1200);
      await retry(["WithdrawLocked"], () => houseWithdraw(lp1, 0n).rpc());
      expect(await shareOf(lp1)).to.equal(0n);
    }
  });

  // ─── B-14 solvency (again, after the gaps) ─────────────────────────────────
  it("B-14: every vault covers its obligations after the gap cases; both seats hold rent + bond", async () => {
    const c = await cfg();
    const rent = await rent8();
    expect(big(await bal(P.reward)) - rent >= big(c.rewardReserved)).to.equal(true);
    expect(big(await bal(P.bankroll)) - rent >= big(c.bankrollReserved)).to.equal(true);
    const x = await xs();
    const xf = big(await bal(P.extraVault)) - rent;
    expect(xf >= big(x.reserved) && xf >= big(x.accounted)).to.equal(true);
    const k = await ks();
    const kInfo = (await connection.getAccountInfo(P.keeper))!;
    // r4-fix: reason-0 forfeits stay in the seat above the bond (owed to nobody), so the seat holds AT LEAST rent + bond
    expect(big(kInfo.lamports) >= BigInt(await T.rentFor(kInfo.data.length)) + big(k.bond)).to.equal(true);
    expect(big(k.bond) >= big(c.bankrollReserved) + big(k.jackpotReserved)).to.equal(true);
    expect([k.pendingBets, k.keeper.toBase58()]).to.deep.equal([0, keeper.publicKey.toBase58()]);
    const s = await seatAcc();
    const sInfo = (await connection.getAccountInfo(P.seat))!;
    expect(big(sInfo.lamports)).to.equal(BigInt(await T.rentFor(sInfo.data.length)) + big(s.bond));
    expect(c.oracle.toBase58()).to.equal(oracle.publicKey.toBase58());
  });

  // ─── B-13 the coverage ASSERTION (all suites of this mocha run) ────────────
  it("B-13: every reachable error code observed, every instruction succeeded, every event emitted, except the allowlist (each with its reason)", async () => {
    // errors that cannot be reached on a fresh localnet, and where each is proven instead
    // (MathOverflow and PoolEmpty are reached: a u64::MAX stake above, the publish before the first donation in moon-forge.test.ts)
    const ALLOW_ERRORS: Record<string, string> = {
      NotEnoughChips: "no raise site left in the program (chips retired, ECO-3); kept only for the frozen numbering (error_codes_are_frozen)",
      ChipsAlreadyClaimed: "no raise site left (claim_artifact_chips returns ChipsRetired first); frozen numbering, unit test only",
      NoDrop: "legacy Forge Drops only: needs an epoch with drop_reserve > 0, which publish_epoch never writes again (8.5 Phase B)",
      NotSoldOut: "claim_drop_xnt on a sealed LEGACY drop epoch only (drop_reserve > 0); drops.rs unit tests",
      DropCapReached: "legacy drop epochs only (drop_reserve > 0): drops.rs legacy_drop_cap unit tests, 8.5 Phase B",
      AirdropClosed: "needs a clock at or after AIRDROP_DEADLINE (2027-04-01 00:00 UTC, D-29); the localnet clock is the host's",
    };
    // the 6 retired instructions count their documented refusal as their outcome (SPEC 4 B)
    const RETIRED: Record<string, string> = {
      place_bet: "KeeperRequired", enter_draw: "LotteryRetired", join_duel: "SealedJoinRequired", create_war: "SealedJoinRequired",
      join_war: "SealedJoinRequired", claim_artifact_chips: "ChipsRetired",
    };
    // instructions whose success needs accounts only the OLD binary creates (proven by tests/run-upgrade.sh, 8.5 Phase B)
    const ALLOW_IX: Record<string, string> = {
      settle_bet: "legacy bets only (place_bet is retired): KeeperRequired on a v2 bet observed here; 8.5 Phase B settles the Phase-A bet",
      settle_jackpot: "rounds drawn by the v2 binary only: KeeperRequired on a v3 round observed here; 8.5 Phase B",
      start_war: "legacy (unsealed) wars only, create_war is retired; 8.5 Phase B starts the Phase-A war",
      seal_drop: "legacy drop epochs only (DropNotPending observed here); 8.5 Phase B seals the Phase-A drop",
      claim_drop: "legacy sealed drop epochs only (DropNotSealed observed here); 8.5 Phase B pays the Phase-A drop",
      claim_drop_xnt: "a sealed legacy drop AND a sold-out Lunar tier; drops.rs unit tests (not reached in 8.5 either)",
      draw_draw: "lottery rounds opened by the v2 binary only (enter_draw is retired); 8.5 Phase B",
      settle_draw: "the same Phase-A lottery round; 8.5 Phase B",
      close_draw_entry: "the same Phase-A lottery round; 8.5 Phase B",
    };
    // events only legacy accounts can emit (the same 8.5 Phase B paths as above)
    const ALLOW_EVENTS: Record<string, string> = {
      ChipsGranted: "no emit site left in the program (chips retired, ECO-3); kept in the IDL for old indexers",
      DropSealed: "seal_drop on a legacy drop epoch only (8.5 Phase B)",
      DropWon: "claim_drop / claim_drop_xnt on a sealed legacy drop only (8.5 Phase B)",
      DrawSettled: "settle_draw of a lottery round opened by the v2 binary only (8.5 Phase B)",
    };
    for (const k of Object.keys(ALLOW_EVENTS)) expect((idl.events ?? []).map((e: any) => e.name), `allowlisted event ${k}`).to.include(k);
    const NEW_EVENTS = ["WarSeedOpened", "OracleChanged", "OracleHandoverProposed", "SeatChanged", "SeatResigned", "EpochVoided", "ExtraEpochVoided",
      "ExtraEpochPublished", "ExtraClaimed", "ExtraEpochClosed", "ArtifactListed", "ArtifactDelisted", "ArtifactSold", "CollectionRoyaltiesLocked",
      "KeeperArmed", "KeeperChanged", "BetRefunded", "ArchitectChanged"];
    const allErrors: string[] = idl.errors.map((e: any) => e.name);
    const allIx: string[] = idl.instructions.map((i: any) => i.name);
    const allEvents: string[] = (idl.events ?? []).map((e: any) => e.name);
    const rep = coverage.report(allErrors, allIx, allEvents);
    const missE = rep.missE.filter((e) => !ALLOW_ERRORS[e]);
    const missI = rep.missI.filter((i) => !ALLOW_IX[i] && !(RETIRED[i] && !rep.missE.includes(RETIRED[i])));
    const missV = rep.missV.filter((e) => !ALLOW_EVENTS[e]);
    const missNew = NEW_EVENTS.filter((e) => rep.missV.includes(e));
    console.log(`      B-13: errors ${rep.errors}/${allErrors.length} observed (+${rep.missE.length - missE.length} allowlisted), instructions ${rep.ix}/${allIx.length} succeeded`
      + ` (+${rep.missI.length - missI.length} retired/allowlisted), events ${rep.events}/${allEvents.length} emitted (+${rep.missV.length - missV.length} allowlisted)`);
    for (const [k, v] of Object.entries(ALLOW_ERRORS)) console.log(`        allow error ${k}${rep.missE.includes(k) ? "" : " (observed anyway)"}: ${v}`);
    for (const [k, v] of Object.entries(ALLOW_IX)) console.log(`        allow ix ${k}${rep.missI.includes(k) ? "" : " (succeeded anyway)"}: ${v}`);
    for (const [k, v] of Object.entries(ALLOW_EVENTS)) console.log(`        allow event ${k}${rep.missV.includes(k) ? "" : " (emitted anyway)"}: ${v}`);
    if (standalone) {
      // alone (development) the other two suites did not run: their codes are missing by construction, so report only
      console.log(`        alone: report only; missing errors ${missE.join(", ")}; instructions ${missI.join(", ")}; events ${missV.join(", ")}`);
      return;
    }
    // the allowlists name real IDL entries only (a typo would silently exempt nothing)
    for (const k of Object.keys(ALLOW_ERRORS)) expect(allErrors, `allowlisted error ${k}`).to.include(k);
    for (const k of [...Object.keys(ALLOW_IX), ...Object.keys(RETIRED)]) expect(allIx, `allowlisted instruction ${k}`).to.include(k);
    expect(allErrors.length).to.equal(101);
    expect(allIx.length).to.equal(92);
    expect(missE, `error codes never observed: ${missE.join(", ")}`).to.deep.equal([]);
    expect(missI, `instructions that never succeeded: ${missI.join(", ")}`).to.deep.equal([]);
    expect(missNew, `new events never emitted: ${missNew.join(", ")}`).to.deep.equal([]);
    expect(missV, `events never emitted: ${missV.join(", ")}`).to.deep.equal([]);
    void errText; void assert; void sleep;
  });
});
