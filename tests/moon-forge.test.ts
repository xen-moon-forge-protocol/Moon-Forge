/**
 * Moon Forge v2 — integration tests against a local validator running:
 *   • the program built with `--features localnet` (test keys, days compressed into seconds)
 *   • the real Metaplex Core program dumped from X1 mainnet
 * Run: bash tests/run-local.sh   (see that script)
 */
import * as anchor from "@coral-xyz/anchor";
import { keccak_256 } from "@noble/hashes/sha3";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import { assert, expect } from "chai";
import * as fs from "fs";
import * as path from "path";

const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/moon_forge.json"), "utf8"));
const RPC = process.env.RPC || "http://127.0.0.1:8899";
const XNT = LAMPORTS_PER_SOL;
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const kp = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", f), "utf8"))));
const oracle = kp("test-oracle.json");
const architect = kp("test-architect.json");

const connection = new Connection(RPC, "confirmed");
const payer = Keypair.generate();
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
const pid = program.programId;
const acc = program.account as any;

// ─── helpers ────────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const u64 = (n: number | bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (...s: Buffer[]) => PublicKey.findProgramAddressSync(s, pid)[0];
const P = {
  config: pda(Buffer.from("config")),
  reward: pda(Buffer.from("reward_vault")),
  bankroll: pda(Buffer.from("bankroll_vault")),
  draw: pda(Buffer.from("draw_vault")),
  collection: pda(Buffer.from("collection")),
  authority: pda(Buffer.from("artifact_authority")),
  epoch: (n: number) => pda(Buffer.from("epoch"), u64(n)),
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
  asset: (t: number, s: number) => pda(Buffer.from("asset"), Buffer.from([t]), u32(s)),
  artifact: (a: PublicKey) => pda(Buffer.from("artifact"), a.toBuffer()),
  airdrop: (c: PublicKey) => pda(Buffer.from("airdrop"), c.toBuffer()),
  drop: (n: number, p: PublicKey, t: number) => pda(Buffer.from("drop"), u64(n), p.toBuffer(), Buffer.from([t])),
};
const keccak = (...p: Uint8Array[]) => { const h = keccak_256.create(); p.forEach((x) => h.update(x)); return Buffer.from(h.digest()); };
const hashPair = (a: Buffer, b: Buffer) => (Buffer.compare(a, b) <= 0 ? keccak(a, b) : keccak(b, a));
function tree(leaves: Buffer[]) {
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
const claimLeaf = (e: number, p: PublicKey, t: number, s: bigint) =>
  keccak(Buffer.from("MOONFORGE_V2_CLAIM"), u64(e), p.toBuffer(), Buffer.from([t]), u64(s));

async function fund(...ks: PublicKey[]) {
  for (const k of ks) {
    const sig = await connection.requestAirdrop(k, 1000 * XNT);
    await connection.confirmTransaction(sig, "confirmed");
  }
}
const bal = (k: PublicKey) => connection.getBalance(k, "confirmed");
async function expectErr(p: Promise<any>, code: string) {
  let resolved = false;
  try { await p; resolved = true; } catch (e: any) {
    const msg = String(e) + JSON.stringify(e?.logs ?? e?.transactionLogs ?? "");
    expect(msg, `expected error ${code || "(any)"}`).to.contain(code);
  }
  if (resolved) assert.fail(`transaction succeeded but error ${code || "(any)"} was expected`);
}
async function slotHashAtOrAfter(target: bigint): Promise<Buffer | null> {
  const d = (await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY))!.data;
  const len = Number(d.readBigUInt64LE(0));
  let best: Buffer | null = null;
  for (let i = 0; i < len; i++) { const o = 8 + i * 40; if (d.readBigUInt64LE(o) >= target) best = d.subarray(o + 8, o + 40); else break; }
  return best;
}
const rnd = (h: Buffer, a: Buffer, b: Buffer) => keccak(Buffer.from("MOONFORGE_RNG"), h, a, b).readBigUInt64LE(0);
async function waitPastSlot(target: bigint) {
  for (;;) { if (BigInt(await connection.getSlot("confirmed")) > target + 1n) return; await sleep(300); }
}

// ─── actors ─────────────────────────────────────────────────────────────────
const alice = Keypair.generate();
const bob = Keypair.generate();
const carol = Keypair.generate(); // Moon Landing burner who will eject
const keeper = Keypair.generate();
const bot = Keypair.generate(); // session key

describe("Moon Forge v2", () => {
  before(async () => {
    await fund(payer.publicKey, oracle.publicKey, architect.publicKey, alice.publicKey, bob.publicKey, carol.publicKey, keeper.publicKey, bot.publicKey);
  });

  it("initialize_v2 is permissionless and deterministic", async () => {
    await program.methods.initializeV2().accountsPartial({
      config: P.config, rewardVault: P.reward, bankrollVault: P.bankroll, drawVault: P.draw,
      collection: P.collection, artifactAuthority: P.authority, payer: payer.publicKey, systemProgram: SystemProgram.programId,
    }).rpc();
    const c = await acc.config.fetch(P.config);
    expect(c.oracle.toBase58()).to.equal(oracle.publicKey.toBase58());
    expect(c.architect.toBase58()).to.equal(architect.publicKey.toBase58());
    for (const v of [P.reward, P.bankroll, P.draw]) expect((await connection.getAccountInfo(v))!.owner.toBase58()).to.equal(pid.toBase58());
    await program.methods.sweepLegacy().accountsPartial({ config: P.config, rewardVault: P.reward }).rpc(); // no-op locally
  });

  it("donate sends 100% to the chosen vault and rejects foreign accounts", async () => {
    const before = await bal(P.reward);
    await program.methods.donate(0, new anchor.BN(100 * XNT)).accountsPartial({ config: P.config, donor: payer.publicKey, vault: P.reward }).rpc();
    expect((await bal(P.reward)) - before).to.equal(100 * XNT);
    await expectErr(program.methods.donate(0, new anchor.BN(1)).accountsPartial({ config: P.config, donor: payer.publicKey, vault: alice.publicKey }).rpc(), "InvalidTarget");
    await program.methods.donate(2, new anchor.BN(10 * XNT)).accountsPartial({ config: P.config, donor: payer.publicKey, vault: P.draw }).rpc();
  });

  // Epoch 1: alice Launchpad (score 600), bob Orbit (score 300), carol Moon Landing (score 100)
  const E1 = [
    { p: alice.publicKey, t: 0, s: 600n },
    { p: bob.publicKey, t: 1, s: 300n },
    { p: carol.publicKey, t: 2, s: 100n },
  ];
  const t1 = tree(E1.map((l) => claimLeaf(1, l.p, l.t, l.s)));
  const BIG_CAP = 1_000_000_000_000_000n; // lamports per score unit: never binding in these tests
  const publish = (n: number, root: Buffer, total: bigint, leaves: number, cap: bigint | number = BIG_CAP, signer = oracle) =>
    program.methods.publishEpoch(new anchor.BN(n), Array.from(root), Array.from(Buffer.alloc(32, n)), new anchor.BN(total.toString()), leaves, new anchor.BN(cap.toString()))
      .accountsPartial({ config: P.config, epoch: P.epoch(n), rewardVault: P.reward, oracle: signer.publicKey, systemProgram: SystemProgram.programId })
      .signers([signer]).rpc();

  it("only the oracle can publish; budget = 10% of the free pool, computed on-chain; >= 6 'days' between epochs", async () => {
    await expectErr(publish(1, t1.root, 1000n, 3, BIG_CAP, alice), "OnlyOracle");
    await expectErr(publish(1, t1.root, 1000n, 3, 0), "EmptyEpoch"); // the rate cap can never be switched off
    await expectErr(publish(2, t1.root, 1000n, 3), "BadEpochNumber");
    await expectErr(publish(1, t1.root, 0n, 3), "EmptyEpoch");
    const free = (await bal(P.reward)) - (await connection.getMinimumBalanceForRentExemption(8));
    await publish(1, t1.root, 1000n, 3);
    const e = await acc.epoch.fetch(P.epoch(1));
    const total = e.budget.toNumber() + e.dropReserve.toNumber();
    expect(total).to.equal(Math.floor(free / 10));
    expect(e.dropReserve.toNumber()).to.equal(Math.floor(total / 10)); // 10% of the budget -> Forge Drops
    expect(e.dropState).to.equal(1); // pending seal
    const c = await acc.config.fetch(P.config);
    expect(c.rewardReserved.toNumber()).to.equal(total);
    // immediately after: too soon (6 s on localnet)
    await expectErr(publish(2, tree([claimLeaf(2, alice.publicKey, 0, 1n)]).root, 1n, 1), "EpochTooSoon");
  });

  it("claim_instant: anyone can submit, XNT goes to the player, pool pays the keeper tip", async () => {
    const e = await acc.epoch.fetch(P.epoch(1));
    const expected = Math.floor((600 * e.budget.toNumber()) / 1000);
    const aliceBefore = await bal(alice.publicKey);
    const keeperBefore = await bal(keeper.publicKey);
    const accounts = {
      config: P.config, epoch: P.epoch(1), receipt: P.receipt(1, alice.publicKey, 0), player: alice.publicKey,
      playerState: P.player(alice.publicKey), rewardVault: P.reward, payer: keeper.publicKey, systemProgram: SystemProgram.programId,
    };
    // wrong score / wrong tier rejected
    await expectErr(program.methods.claimInstant(new anchor.BN(1), 0, new anchor.BN(601), t1.proof(0)).accountsPartial(accounts).signers([keeper]).rpc(), "InvalidProof");
    await program.methods.claimInstant(new anchor.BN(1), 0, new anchor.BN(600), t1.proof(0)).accountsPartial(accounts).signers([keeper]).rpc();
    expect((await bal(alice.publicKey)) - aliceBefore).to.equal(expected);
    const ps = await acc.playerState.fetch(P.player(alice.publicKey));
    expect(ps.chips.toNumber()).to.equal(Math.floor(expected / XNT)); // 1 chip per XNT
    expect(await bal(keeper.publicKey)).to.be.greaterThan(keeperBefore - 0.01 * XNT); // rents fronted, tip received
    // double claim impossible
    await expectErr(program.methods.claimInstant(new anchor.BN(1), 0, new anchor.BN(600), t1.proof(0)).accountsPartial(accounts).signers([keeper]).rpc(), "already in use");
  });

  it("claim_mission + linear vesting + permissionless withdraw_vested", async () => {
    const accounts = (l: typeof E1[0]) => ({
      config: P.config, epoch: P.epoch(1), receipt: P.receipt(1, l.p, l.t), mission: P.mission(1, l.p, l.t), player: l.p,
      playerState: P.player(l.p), rewardVault: P.reward, payer: payer.publicKey, systemProgram: SystemProgram.programId,
    });
    await program.methods.claimMission(new anchor.BN(1), 1, new anchor.BN(300), t1.proof(1)).accountsPartial(accounts(E1[1])).rpc();
    await program.methods.claimMission(new anchor.BN(1), 2, new anchor.BN(100), t1.proof(2)).accountsPartial(accounts(E1[2])).rpc();
    const m = await acc.mission.fetch(P.mission(1, bob.publicKey, 1));
    expect(m.end.toNumber() - m.start.toNumber()).to.equal(45); // 45 "days" (seconds on localnet)
    const chips0 = (await acc.playerState.fetch(P.player(bob.publicKey))).chips.toNumber();
    expect(chips0).to.equal(0); // vesting claims grant chips only as XNT is actually paid out
    await sleep(3000);
    const before = await bal(bob.publicKey);
    await program.methods.withdrawVested().accountsPartial({ mission: P.mission(1, bob.publicKey, 1), player: bob.publicKey, playerState: P.player(bob.publicKey), rentPayer: payer.publicKey }).rpc();
    const got = (await bal(bob.publicKey)) - before;
    expect(got).to.be.greaterThan(0);
    expect(got).to.be.lessThan(m.total.toNumber() * 0.3);
    const m2 = await acc.mission.fetch(P.mission(1, bob.publicKey, 1));
    expect((await acc.playerState.fetch(P.player(bob.publicKey))).chips.toNumber()).to.equal(Math.floor(m2.withdrawn.toNumber() / XNT));
  });

  it("eject: vested paid in full, unvested pays 75% penalty to the pool (Moon Landing)", async () => {
    const m = await acc.mission.fetch(P.mission(1, carol.publicKey, 2));
    const poolBefore = await bal(P.reward);
    const carolBefore = await bal(carol.publicKey);
    await expectErr(program.methods.eject().accountsPartial({ config: P.config, mission: P.mission(1, carol.publicKey, 2), player: bob.publicKey, rewardVault: P.reward, rentPayer: payer.publicKey, playerState: P.player(carol.publicKey) }).signers([bob]).rpc(), "");
    const cchips0 = (await acc.playerState.fetch(P.player(carol.publicKey))).chips.toNumber();
    await program.methods.eject().accountsPartial({ config: P.config, mission: P.mission(1, carol.publicKey, 2), player: carol.publicKey, rewardVault: P.reward, rentPayer: payer.publicKey, playerState: P.player(carol.publicKey) }).signers([carol]).rpc();
    const penalty = (await bal(P.reward)) - poolBefore;
    const paid = (await bal(carol.publicKey)) - carolBefore + 5000; // + tx fee
    // chips only on what carol really received, never on the part lost to the penalty
    expect((await acc.playerState.fetch(P.player(carol.publicKey))).chips.toNumber() - cchips0).to.equal(Math.floor(paid / XNT));
    expect(penalty + paid).to.be.closeTo(m.total.toNumber(), 10_000);
    expect(penalty / m.total.toNumber()).to.be.within(0.6, 0.75); // early exit pays less than Launchpad
    expect(await connection.getAccountInfo(P.mission(1, carol.publicKey, 2))).to.equal(null);
  });

  it("the rate cap can only lower the budget", async () => {
    const t2 = tree([claimLeaf(2, alice.publicKey, 0, 1000n)]);
    // the validator clock can lag the host clock: retry while the program still says "too soon"
    for (let i = 0; ; i++) {
      try { await publish(2, t2.root, 1000n, 1, 5); break; } // cap 5 lamports per score unit → budget 5000
      catch (e: any) { if (!String(e).includes("EpochTooSoon") || i > 40) throw e; await sleep(1000); }
    }
    const e2 = await acc.epoch.fetch(P.epoch(2));
    expect(e2.budget.toNumber() + e2.dropReserve.toNumber()).to.equal(5000);
  });

  it("game wallet, exposure cap, commit-reveal coin flip with permissionless settle", async () => {
    // seed the bankroll as the first House LP
    await program.methods.houseDeposit(new anchor.BN(200 * XNT), new anchor.BN(0)).accountsPartial({ config: P.config, share: P.house(payer.publicKey), bankrollVault: P.bankroll, owner: payer.publicKey, systemProgram: SystemProgram.programId }).rpc();
    await program.methods.openPlayer().accountsPartial({ playerState: P.player(bob.publicKey), owner: bob.publicKey, systemProgram: SystemProgram.programId }).signers([bob]).rpc();
    await program.methods.deposit(new anchor.BN(20 * XNT)).accountsPartial({ playerState: P.player(bob.publicKey), payer: bob.publicKey, systemProgram: SystemProgram.programId }).signers([bob]).rpc();

    const ps = P.player(bob.publicKey);
    const betAccounts = (nonce: number, signer: Keypair) => ({
      config: P.config, playerState: ps, bet: P.bet(ps, nonce), bankrollVault: P.bankroll, rewardVault: P.reward,
      architect: architect.publicKey, signer: signer.publicKey, systemProgram: SystemProgram.programId,
    });
    // 0.25% of a 200 XNT bankroll = 0.5 XNT max net win → 1 XNT coin flip (net 0.96) must fail
    await expectErr(program.methods.placeBet(0, new anchor.BN(0), 0, new anchor.BN(1 * XNT), Array(32).fill(1)).accountsPartial(betAccounts(0, bob)).signers([bob]).rpc(), "BankrollTooSmall");

    const poolBefore = await bal(P.reward), archBefore = await bal(architect.publicKey);
    const stake = 0.5 * XNT;
    await program.methods.placeBet(0, new anchor.BN(0), 1, new anchor.BN(stake), Array(32).fill(7)).accountsPartial(betAccounts(0, bob)).signers([bob]).rpc();
    expect((await bal(P.reward)) - poolBefore).to.equal(stake / 100); // 1% → burners' pool
    expect((await bal(architect.publicKey)) - archBefore).to.equal(stake / 200); // 0.5% → architect
    const bet = await acc.bet.fetch(P.bet(ps, 0));
    // settle too early fails, then anyone (the keeper) settles
    await waitPastSlot(BigInt(bet.targetSlot.toString()));
    const before = (await acc.playerState.fetch(ps)).balance.toNumber();
    await program.methods.settleBet().accountsPartial({ config: P.config, bet: P.bet(ps, 0), playerState: ps, bankrollVault: P.bankroll, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: bob.publicKey }).rpc(); // paid by a third party (the provider wallet), not by bob
    const h = (await slotHashAtOrAfter(BigInt(bet.targetSlot.toString())))!;
    const roll = rnd(h, P.bet(ps, 0).toBuffer(), Buffer.alloc(32, 7)) % 10000n;
    const won = (roll < 5000n) === false; // choice 1 wins on roll >= 5000
    const after = (await acc.playerState.fetch(ps)).balance.toNumber();
    expect(after - before).to.equal(won ? 0.98 * XNT : 0);
    expect((await acc.config.fetch(P.config)).bankrollReserved.toNumber()).to.equal(0);
    expect(await connection.getAccountInfo(P.bet(ps, 0))).to.equal(null);
  });

  it("session key (bot) can bet within its limit and can never withdraw", async () => {
    const ps = P.player(bob.publicKey);
    const now = Math.floor(Date.now() / 1000);
    await program.methods.setSession(bot.publicKey, new anchor.BN(now + 3600), new anchor.BN(0.2 * XNT)).accountsPartial({ playerState: ps, owner: bob.publicKey }).signers([bob]).rpc();
    const nonce = (await acc.playerState.fetch(ps)).nonce.toNumber();
    const accounts = { config: P.config, playerState: ps, bet: P.bet(ps, nonce), bankrollVault: P.bankroll, rewardVault: P.reward, architect: architect.publicKey, signer: bot.publicKey, systemProgram: SystemProgram.programId };
    await expectErr(program.methods.placeBet(2, new anchor.BN(20000), 0, new anchor.BN(0.3 * XNT), Array(32).fill(2)).accountsPartial(accounts).signers([bot]).rpc(), "SessionLimit");
    await program.methods.placeBet(2, new anchor.BN(20000), 0, new anchor.BN(0.1 * XNT), Array(32).fill(2)).accountsPartial(accounts).signers([bot]).rpc(); // Void Rush 2x
    await expectErr(program.methods.withdraw(new anchor.BN(1)).accountsPartial({ playerState: ps, owner: bot.publicKey }).signers([bot]).rpc(), "");
    // a bot cannot put the owner's money in a pot shared with others
    const jr = (await acc.config.fetch(P.config)).jackpotRound.toNumber();
    await expectErr(program.methods.enterJackpot(new anchor.BN(jr), 0, new anchor.BN(0.1 * XNT)).accountsPartial({
      config: P.config, round: P.jackpot(jr), entry: P.jpEntry(jr, 0), playerState: ps, signer: bot.publicKey, systemProgram: SystemProgram.programId,
    }).signers([bot]).rpc(), "OwnerOnly");
    const bet = await acc.bet.fetch(P.bet(ps, nonce));
    await waitPastSlot(BigInt(bet.targetSlot.toString()));
    await program.methods.settleBet().accountsPartial({ config: P.config, bet: P.bet(ps, nonce), playerState: ps, bankrollVault: P.bankroll, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: bot.publicKey }).rpc();
    // owner withdraws
    const b = (await acc.playerState.fetch(ps)).balance.toNumber();
    const w = await bal(bob.publicKey);
    await program.methods.withdraw(new anchor.BN(b)).accountsPartial({ playerState: ps, owner: bob.publicKey }).signers([bob]).rpc();
    expect((await bal(bob.publicKey)) - w).to.equal(b); // fee paid by the provider wallet: bob receives the exact balance
  });

  it("Be the House: 24h cooldown, withdraw at conservative share value", async () => {
    const share = P.house(payer.publicKey);
    const s = await acc.houseShare.fetch(share);
    await program.methods.houseRequestWithdraw(new anchor.BN(s.shares.toNumber() / 2)).accountsPartial({ share, owner: payer.publicKey }).rpc();
    await expectErr(program.methods.houseWithdraw(new anchor.BN(0)).accountsPartial({ config: P.config, share, bankrollVault: P.bankroll, owner: payer.publicKey }).rpc(), "WithdrawLocked");
    await sleep(2000);
    const before = await bal(payer.publicKey);
    await program.methods.houseWithdraw(new anchor.BN(0)).accountsPartial({ config: P.config, share, bankrollVault: P.bankroll, owner: payer.publicKey }).rpc();
    expect((await bal(payer.publicKey)) - before).to.be.greaterThan(90 * XNT);
  });

  it("Be the House: shares are never cheaper while bets are pending; slippage limits protect LPs", async () => {
    const ps = P.player(bob.publicKey);
    await program.methods.deposit(new anchor.BN(5 * XNT)).accountsPartial({ playerState: ps, payer: payer.publicKey, systemProgram: SystemProgram.programId }).rpc();
    const nonce = (await acc.playerState.fetch(ps)).nonce.toNumber();
    // a pending 20x Void Rush bet reserves its full payout (conservative value drops)
    await program.methods.placeBet(2, new anchor.BN(200_000), 0, new anchor.BN(0.01 * XNT), Array(32).fill(5)).accountsPartial({
      config: P.config, playerState: ps, bet: P.bet(ps, nonce), bankrollVault: P.bankroll, rewardVault: P.reward,
      architect: architect.publicKey, signer: bob.publicKey, systemProgram: SystemProgram.programId,
    }).signers([bob]).rpc();
    const c = await acc.config.fetch(P.config);
    expect(c.bankrollReserved.toNumber()).to.be.greaterThan(0);
    const rent = await connection.getMinimumBalanceForRentExemption(8);
    const optimistic = BigInt((await bal(P.bankroll)) - rent);
    const conservative = optimistic - BigInt(c.bankrollReserved.toString());
    const total = BigInt(c.houseTotalShares.toString());
    const amount = 10n * BigInt(XNT);
    const atOptimistic = (amount * total) / optimistic;
    expect(atOptimistic < (amount * total) / conservative).to.equal(true);
    const dep = (min: bigint) => program.methods.houseDeposit(new anchor.BN(amount.toString()), new anchor.BN(min.toString()))
      .accountsPartial({ config: P.config, share: P.house(alice.publicKey), bankrollVault: P.bankroll, owner: alice.publicKey, systemProgram: SystemProgram.programId }).signers([alice]).rpc();
    await expectErr(dep(atOptimistic + 1n), "SlippageExceeded");
    await dep(atOptimistic);
    expect((await acc.houseShare.fetch(P.house(alice.publicKey))).shares.toString()).to.equal(atOptimistic.toString());

    // withdrawals: priced at the conservative value, never below the LP's own limit
    await program.methods.houseRequestWithdraw(new anchor.BN(atOptimistic.toString())).accountsPartial({ share: P.house(alice.publicKey), owner: alice.publicKey }).signers([alice]).rpc();
    await sleep(1500);
    const wd = (min: bigint) => program.methods.houseWithdraw(new anchor.BN(min.toString()))
      .accountsPartial({ config: P.config, share: P.house(alice.publicKey), bankrollVault: P.bankroll, owner: alice.publicKey }).signers([alice]).rpc();
    await expectErr(wd(amount), "SlippageExceeded"); // the pending bet is counted as won
    const before = await bal(alice.publicKey);
    for (let i = 0; ; i++) {
      try { await wd(amount * 97n / 100n); break; }
      catch (e: any) { if (!String(e).includes("WithdrawLocked") || i > 30) throw e; await sleep(500); }
    }
    expect((await bal(alice.publicKey)) - before).to.be.greaterThan(9.7 * XNT);

    const bet = await acc.bet.fetch(P.bet(ps, nonce));
    await waitPastSlot(BigInt(bet.targetSlot.toString()));
    await program.methods.settleBet().accountsPartial({ config: P.config, bet: P.bet(ps, nonce), playerState: ps, bankrollVault: P.bankroll, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: bob.publicKey }).rpc();
  });

  async function settleRound(kind: "jackpot" | "draw", roundId: number) {
    const roundPk = kind === "jackpot" ? P.jackpot(roundId) : P.drawRound(roundId);
    const r = await (kind === "jackpot" ? acc.jackpotRound : acc.drawRound).fetch(roundPk);
    await waitPastSlot(BigInt(r.targetSlot.toString()));
    const h = (await slotHashAtOrAfter(BigInt(r.targetSlot.toString())))!;
    const total = BigInt((kind === "jackpot" ? r.total : r.totalWeight).toString());
    const t = rnd(h, roundPk.toBuffer(), u64(roundId)) % total;
    for (let i = 0; i < r.entries; i++) {
      const ePk = kind === "jackpot" ? P.jpEntry(roundId, i) : P.drawEntry(roundId, i);
      const e = await (kind === "jackpot" ? acc.jackpotEntry : acc.drawEntry).fetch(ePk);
      const start = BigInt(e.start.toString()), size = BigInt((kind === "jackpot" ? e.amount : e.weight).toString());
      if (t >= start && t < start + size) {
        if (i > 0) {
          const wrong = kind === "jackpot" ? P.jpEntry(roundId, 0) : P.drawEntry(roundId, 0);
          const we = await (kind === "jackpot" ? acc.jackpotEntry : acc.drawEntry).fetch(wrong);
          const m = kind === "jackpot"
            ? program.methods.settleJackpot().accountsPartial({ config: P.config, round: roundPk, entry: wrong, winnerState: P.player(we.player), rewardVault: P.reward, drawVault: P.draw, architect: architect.publicKey, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY })
            : program.methods.settleDraw().accountsPartial({ config: P.config, round: roundPk, entry: wrong, winnerState: P.player(we.player), drawVault: P.draw, rewardVault: P.reward, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY });
          await expectErr(m.rpc(), "NotWinningEntry");
        }
        const m = kind === "jackpot"
          ? program.methods.settleJackpot().accountsPartial({ config: P.config, round: roundPk, entry: ePk, winnerState: P.player(e.player), rewardVault: P.reward, drawVault: P.draw, architect: architect.publicKey, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY })
          : program.methods.settleDraw().accountsPartial({ config: P.config, round: roundPk, entry: ePk, winnerState: P.player(e.player), drawVault: P.draw, rewardVault: P.reward, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY });
        await m.rpc();
        return e.player as PublicKey;
      }
    }
    throw new Error("no winning entry found");
  }

  it("Jackpot: multiplayer pot, provably drawn winner, 2% rake", async () => {
    for (const k of [alice, bob]) {
      await program.methods.openPlayer().accountsPartial({ playerState: P.player(k.publicKey), owner: k.publicKey, systemProgram: SystemProgram.programId }).signers([k]).rpc();
      await program.methods.deposit(new anchor.BN(10 * XNT)).accountsPartial({ playerState: P.player(k.publicKey), payer: k.publicKey, systemProgram: SystemProgram.programId }).signers([k]).rpc();
    }
    const enter = (k: Keypair, idx: number, amt: number) => program.methods.enterJackpot(new anchor.BN(0), idx, new anchor.BN(amt))
      .accountsPartial({ config: P.config, round: P.jackpot(0), entry: P.jpEntry(0, idx), playerState: P.player(k.publicKey), signer: k.publicKey, systemProgram: SystemProgram.programId }).signers([k]).rpc();
    await enter(alice, 0, 3 * XNT);
    await enter(bob, 1, 1 * XNT);
    await expectErr(program.methods.drawJackpot().accountsPartial({ config: P.config, round: P.jackpot(0), firstPlayerState: P.player(alice.publicKey) }).rpc(), "RoundRunning");
    await sleep(2500);
    await program.methods.drawJackpot().accountsPartial({ config: P.config, round: P.jackpot(0), firstPlayerState: P.player(alice.publicKey) }).rpc();
    const winner = await settleRound("jackpot", 0);
    const ws = await acc.playerState.fetch(P.player(winner));
    const startBal = winner.equals(alice.publicKey) ? 7 : 9;
    expect(ws.balance.toNumber()).to.equal(startBal * XNT + 0.98 * 4 * XNT);
    expect((await acc.config.fetch(P.config)).jackpotRound.toNumber()).to.equal(1);
  });

  it("Jackpot: a round nobody else joined is refunded in full", async () => {
    const before = (await acc.playerState.fetch(P.player(bob.publicKey))).balance.toNumber();
    await program.methods.enterJackpot(new anchor.BN(1), 0, new anchor.BN(XNT)).accountsPartial({ config: P.config, round: P.jackpot(1), entry: P.jpEntry(1, 0), playerState: P.player(bob.publicKey), signer: bob.publicKey, systemProgram: SystemProgram.programId }).signers([bob]).rpc();
    await sleep(2500);
    await program.methods.drawJackpot().accountsPartial({ config: P.config, round: P.jackpot(1), firstPlayerState: P.player(bob.publicKey) }).rpc();
    expect((await acc.playerState.fetch(P.player(bob.publicKey))).balance.toNumber()).to.equal(before);
  });

  it("Artifacts: Core collection, forge (50/40/5/5 split), weekly chips, recycle returns the floor", async () => {
    await program.methods.initArtifacts().accountsPartial({ config: P.config, collection: P.collection, artifactAuthority: P.authority, payer: payer.publicKey, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId }).rpc();
    expect((await connection.getAccountInfo(P.collection))!.owner.toBase58()).to.equal(MPL_CORE.toBase58());

    const forge = (k: Keypair, tier: number, serial: number) => program.methods.forgeArtifact(tier, serial, new anchor.BN("18446744073709551615")).accountsPartial({
      config: P.config, asset: P.asset(tier, serial), record: P.artifact(P.asset(tier, serial)), collection: P.collection, artifactAuthority: P.authority,
      rewardVault: P.reward, drawVault: P.draw, architect: architect.publicKey, buyer: k.publicKey, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
    }).signers([k]).rpc();

    const pool0 = await bal(P.reward), draw0 = await bal(P.draw), arch0 = await bal(architect.publicKey);
    await forge(alice, 0, 0);
    expect((await bal(P.reward)) - pool0).to.equal(4 * XNT);
    expect((await bal(P.draw)) - draw0).to.equal(0.5 * XNT);
    expect((await bal(architect.publicKey)) - arch0).to.equal(0.5 * XNT);
    const asset = (await connection.getAccountInfo(P.asset(0, 0)))!;
    expect(asset.owner.toBase58()).to.equal(MPL_CORE.toBase58());
    expect(new PublicKey(asset.data.subarray(1, 33)).toBase58()).to.equal(alice.publicKey.toBase58());
    await expectErr(forge(alice, 0, 5), "InvalidTarget"); // serial must be sequential

    const chips = async () => (await acc.playerState.fetch(P.player(alice.publicKey))).chips.toNumber();
    const c0 = await chips();
    const chipAcc = { config: P.config, asset: P.asset(0, 0), record: P.artifact(P.asset(0, 0)), collection: P.collection, playerState: P.player(alice.publicKey), owner: alice.publicKey };
    await program.methods.claimArtifactChips().accountsPartial(chipAcc).signers([alice]).rpc();
    expect((await chips()) - c0).to.equal(5);
    await expectErr(program.methods.claimArtifactChips().accountsPartial(chipAcc).signers([alice]).rpc(), "ChipsAlreadyClaimed");

    await forge(bob, 1, 0); // Cosmic for the duel
    await forge(alice, 0, 1); // second Lunar, recycled now
    const before = await bal(alice.publicKey);
    await program.methods.recycleArtifact().accountsPartial({ config: P.config, asset: P.asset(0, 1), record: P.artifact(P.asset(0, 1)), collection: P.collection, owner: alice.publicKey, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId }).signers([alice]).rpc();
    expect((await bal(alice.publicKey)) - before).to.be.greaterThan(4.99 * XNT); // floor (5 XNT) + record rent - fee
    const c = await acc.config.fetch(P.config);
    expect(c.artifactsAlive[0]).to.equal(1);
    expect(c.artifactsMinted[0]).to.equal(2);
  });

  it("Artifacts: dynamic price — +5% per forge, buyer's max price, decay after a quiet week, floor = half of what was paid", async () => {
    const t = 2; // Solar Core, base 60 XNT (a quiet "week" = 7 s on localnet)
    const forgeAt = (serial: number, max: bigint) => program.methods.forgeArtifact(t, serial, new anchor.BN(max.toString())).accountsPartial({
      config: P.config, asset: P.asset(t, serial), record: P.artifact(P.asset(t, serial)), collection: P.collection, artifactAuthority: P.authority,
      rewardVault: P.reward, drawVault: P.draw, architect: architect.publicKey, buyer: carol.publicKey, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
    }).signers([carol]).rpc();
    const X = BigInt(XNT);
    const s0 = (await acc.config.fetch(P.config)).artifactsMinted[t];
    await expectErr(forgeAt(s0, 60n * X - 1n), "SlippageExceeded");
    const pool0 = await bal(P.reward);
    await forgeAt(s0, 60n * X);
    expect((await acc.artifactRecord.fetch(P.artifact(P.asset(t, s0)))).backing.toString()).to.equal((30n * X).toString());
    expect((await bal(P.reward)) - pool0).to.equal(24 * XNT);
    expect((await acc.config.fetch(P.config)).artifactPrice[t].toString()).to.equal((63n * X).toString());

    // the next buyer pays 5% more; a buyer who saw the old price is protected
    await expectErr(forgeAt(s0 + 1, 60n * X), "SlippageExceeded");
    await forgeAt(s0 + 1, 63n * X);
    expect((await acc.artifactRecord.fetch(P.artifact(P.asset(t, s0 + 1)))).backing.toString()).to.equal((315n * X / 10n).toString());
    expect((await acc.config.fetch(P.config)).artifactPrice[t].toString()).to.equal((6615n * X / 100n).toString());

    // recycling returns exactly half of what that buyer paid (plus the record rent)
    const c0 = await bal(carol.publicKey);
    await program.methods.recycleArtifact().accountsPartial({ config: P.config, asset: P.asset(t, s0 + 1), record: P.artifact(P.asset(t, s0 + 1)), collection: P.collection, owner: carol.publicKey, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId }).signers([carol]).rpc();
    const back = (await bal(carol.publicKey)) - c0;
    expect(back).to.be.greaterThan(31.5 * XNT - 10_000);
    expect(back).to.be.lessThan(31.5 * XNT + 0.01 * XNT);

    // after a full quiet period the price falls back by ÷1.05 (66.15 → 63), never below base
    for (let i = 0; ; i++) {
      try { await forgeAt(s0 + 2, 63n * X); break; }
      catch (e: any) { if (!String(e).includes("SlippageExceeded") || i > 40) throw e; await sleep(500); }
    }
    expect((await acc.artifactRecord.fetch(P.artifact(P.asset(t, s0 + 2)))).backing.toString()).to.equal((315n * X / 10n).toString());
  });

  it("Artifact Duel: commit-reveal, element cycle (Cosmic beats Lunar), 2% rake", async () => {
    const cs = P.player(alice.publicKey);
    const nonce = (await acc.playerState.fetch(cs)).nonce.toNumber();
    const duel = P.duel(alice.publicKey, nonce);
    const salt = Buffer.alloc(32, 9);
    const commitment = keccak(Buffer.from("MOONFORGE_DUEL"), Buffer.from([0]), salt, duel.toBuffer());
    await program.methods.createDuel(new anchor.BN(XNT), Array.from(commitment)).accountsPartial({ config: P.config, creatorState: cs, duel, owner: alice.publicKey, asset: P.asset(0, 0), record: P.artifact(P.asset(0, 0)), collection: P.collection, systemProgram: SystemProgram.programId }).signers([alice]).rpc();
    await expectErr(program.methods.joinDuel(1).accountsPartial({ config: P.config, duel, opponentState: P.player(bob.publicKey), opponent: bob.publicKey, asset: P.asset(0, 0), record: P.artifact(P.asset(0, 0)), collection: P.collection }).signers([bob]).rpc(), "NotArtifactOwner");
    await program.methods.joinDuel(1).accountsPartial({ config: P.config, duel, opponentState: P.player(bob.publicKey), opponent: bob.publicKey, asset: P.asset(1, 0), record: P.artifact(P.asset(1, 0)), collection: P.collection }).signers([bob]).rpc();
    const bobBefore = (await acc.playerState.fetch(P.player(bob.publicKey))).balance.toNumber();
    const resolve = { config: P.config, duel, creatorState: cs, opponentState: P.player(bob.publicKey), rewardVault: P.reward, drawVault: P.draw, architect: architect.publicKey, rentPayer: alice.publicKey };
    await expectErr(program.methods.revealDuel(3, Array.from(salt)).accountsPartial({ resolve, creator: alice.publicKey }).signers([alice]).rpc(), "BadCommitment");
    await program.methods.revealDuel(0, Array.from(salt)).accountsPartial({ resolve, creator: alice.publicKey }).signers([alice]).rpc();
    expect((await acc.playerState.fetch(P.player(bob.publicKey))).balance.toNumber() - bobBefore).to.equal(0.98 * 2 * XNT);
  });

  it("Burn Lottery: free chips + tickets, winner drawn on-chain, 50% of the vault paid", async () => {
    const r = (await acc.config.fetch(P.config)).drawRound.toNumber();
    const chips = (await acc.playerState.fetch(P.player(alice.publicKey))).chips.toNumber();
    const enter = (k: Keypair, idx: number, c: number, t: number) => program.methods.enterDraw(new anchor.BN(r), idx, new anchor.BN(c), new anchor.BN(t))
      .accountsPartial({ config: P.config, round: P.drawRound(r), entry: P.drawEntry(r, idx), playerState: P.player(k.publicKey), rewardVault: P.reward, drawVault: P.draw, architect: architect.publicKey, signer: k.publicKey, systemProgram: SystemProgram.programId })
      .signers([k]).rpc();
    await expectErr(enter(alice, 0, chips + 1, 0), "NotEnoughChips");
    await enter(alice, 0, chips, 0);
    await enter(bob, 1, 0, 2);
    await sleep(7500);
    await program.methods.drawDraw().accountsPartial({ config: P.config, round: P.drawRound(r) }).rpc();
    const vault = (await bal(P.draw)) - (await connection.getMinimumBalanceForRentExemption(8));
    const winner = await settleRound("draw", r);
    const round = await acc.drawRound.fetch(P.drawRound(r));
    expect(round.winner.toBase58()).to.equal(winner.toBase58());
    expect(round.prize.toNumber()).to.equal(Math.floor(vault / 2));
  });

  it("Airdrop: architect sets the list once; listed wallets claim a free Lunar Dust (no floor)", async () => {
    const leaf = (k: PublicKey) => keccak(Buffer.from("MOONFORGE_V2_AIRDROP"), k.toBuffer());
    const t = tree([leaf(carol.publicKey), leaf(keeper.publicKey)]);
    await expectErr(program.methods.setAirdropRoot(Array.from(t.root)).accountsPartial({ config: P.config, architect: alice.publicKey }).signers([alice]).rpc(), "");
    await program.methods.setAirdropRoot(Array.from(t.root)).accountsPartial({ config: P.config, architect: architect.publicKey }).signers([architect]).rpc();
    await expectErr(program.methods.setAirdropRoot(Array.from(t.root)).accountsPartial({ config: P.config, architect: architect.publicKey }).signers([architect]).rpc(), "AirdropRootSet");
    const serial = (await acc.config.fetch(P.config)).artifactsMinted[0];
    await program.methods.claimAirdrop(serial, t.proof(0)).accountsPartial({
      config: P.config, receipt: P.airdrop(carol.publicKey), asset: P.asset(0, serial), record: P.artifact(P.asset(0, serial)),
      collection: P.collection, artifactAuthority: P.authority, claimant: carol.publicKey, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
    }).signers([carol]).rpc();
    const rec = await acc.artifactRecord.fetch(P.artifact(P.asset(0, serial)));
    expect(rec.origin).to.equal(1);
    expect(rec.backing.toNumber()).to.equal(0);
  });

  // Epoch 3: a deep pool so the drop reserve is worth more than one Lunar Dust floor (5 XNT).
  // alice 70% of the score -> expected drop value 7 XNT >= 5 -> wins for sure, floor = 7 XNT.
  // bob 30% -> 3 XNT -> wins with probability 3/5 (decided by the sealed seed).
  const E3 = [
    { p: alice.publicKey, t: 0, s: 700_000n },
    { p: bob.publicKey, t: 0, s: 300_000n },
  ];
  const t3 = tree(E3.map((l) => claimLeaf(3, l.p, l.t, l.s)));
  const seal = (n: number) => program.methods.sealDrop().accountsPartial({ config: P.config, epoch: P.epoch(n), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).rpc();
  const nextLunar = async () => (await acc.config.fetch(P.config)).artifactsMinted[0] as number;
  const claimDrop = async (n: number, l: { p: PublicKey; t: number; s: bigint }, proof: number[][], signer: Keypair) => {
    const serial = await nextLunar();
    await program.methods.claimDrop(new anchor.BN(n), l.t, serial, new anchor.BN(l.s.toString()), proof).accountsPartial({
      config: P.config, epoch: P.epoch(n), receipt: P.drop(n, l.p, l.t), player: l.p, asset: P.asset(0, serial), record: P.artifact(P.asset(0, serial)),
      collection: P.collection, artifactAuthority: P.authority, rewardVault: P.reward, payer: signer.publicKey, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
    }).signers([signer]).rpc();
    return serial;
  };

  it("Forge Drops: 10% of the epoch becomes random Lunar Dust with a real floor, seeded by a future block", async () => {
    await fund(payer.publicKey);
    await program.methods.donate(0, new anchor.BN(900 * XNT)).accountsPartial({ config: P.config, donor: payer.publicKey, vault: P.reward }).rpc();
    for (let i = 0; ; i++) {
      try { await publish(3, t3.root, 1_000_000n, 2); break; }
      catch (e: any) { if (!String(e).includes("EpochTooSoon") || i > 40) throw e; await sleep(1000); }
    }
    let e = await acc.epoch.fetch(P.epoch(3));
    const reserve = BigInt(e.dropReserve.toString());
    expect(reserve > 5n * BigInt(XNT)).to.equal(true);
    await expectErr(claimDrop(3, E3[0], t3.proof(0), keeper), "DropNotSealed");

    // anyone seals once the committed slot exists; never twice
    await waitPastSlot(BigInt(e.dropSlot.toString()));
    await seal(3);
    await expectErr(seal(3), "DropNotPending");
    e = await acc.epoch.fetch(P.epoch(3));
    expect(e.dropState).to.equal(2);
    const h = (await slotHashAtOrAfter(BigInt(e.dropSlot.toString())))!;
    const seed = keccak(Buffer.from("MOONFORGE_DROP"), h, u64(3));
    expect(Buffer.from(e.dropSeed).equals(seed)).to.equal(true); // anyone can recompute every outcome

    // wrong score -> rejected
    await expectErr(claimDrop(3, { ...E3[0], s: 700_001n }, t3.proof(0), keeper), "InvalidProof");

    // alice: guaranteed drop, delivered by a keeper; the pool refunds the keeper's rent
    const aliceValue = (700_000n * reserve) / 1_000_000n;
    const reserved0 = BigInt((await acc.config.fetch(P.config)).rewardReserved.toString());
    // someone pre-funds the next Lunar Dust address: it must not block the mint
    const next = await nextLunar();
    const tx = new anchor.web3.Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: P.asset(0, next), lamports: 0.01 * XNT }));
    await provider.sendAndConfirm(tx);
    const keeper0 = await bal(keeper.publicKey);
    const s0 = await claimDrop(3, E3[0], t3.proof(0), keeper);
    const rec = await acc.artifactRecord.fetch(P.artifact(P.asset(0, s0)));
    expect(rec.origin).to.equal(2);
    expect(rec.backing.toString()).to.equal(aliceValue.toString());
    const asset = (await connection.getAccountInfo(P.asset(0, s0)))!;
    expect(new PublicKey(asset.data.subarray(1, 33)).toBase58()).to.equal(alice.publicKey.toBase58());
    expect((await bal(keeper.publicKey)) > keeper0).to.equal(true); // tip >= rents + fee
    expect(reserved0 - BigInt((await acc.config.fetch(P.config)).rewardReserved.toString())).to.equal(aliceValue);
    await expectErr(claimDrop(3, E3[0], t3.proof(0), keeper), "already in use");

    // the XNT fallback only exists while Lunar Dust is sold out
    await expectErr(program.methods.claimDropXnt(new anchor.BN(3), 0, new anchor.BN(300_000), t3.proof(1)).accountsPartial({
      config: P.config, epoch: P.epoch(3), receipt: P.drop(3, bob.publicKey, 0), player: bob.publicKey, playerState: P.player(bob.publicKey),
      rewardVault: P.reward, payer: payer.publicKey, systemProgram: SystemProgram.programId,
    }).rpc(), "NotSoldOut");

    // bob: the outcome is a pure function of the seed, the player and the tier
    const bobValue = (300_000n * reserve) / 1_000_000n;
    const roll = keccak(Buffer.from("MOONFORGE_RNG"), seed, bob.publicKey.toBuffer(), Buffer.from([0])).readBigUInt64LE(0) % (5n * BigInt(XNT));
    if (roll < bobValue) {
      const s1 = await claimDrop(3, E3[1], t3.proof(1), bob);
      expect((await acc.artifactRecord.fetch(P.artifact(P.asset(0, s1)))).backing.toNumber()).to.equal(5 * XNT);
    } else {
      await expectErr(claimDrop(3, E3[1], t3.proof(1), bob), "NoDrop");
    }
    // the regular claim still pays the other 90% pro-rata
    const expected = Math.floor((700_000 * e.budget.toNumber()) / 1_000_000);
    const a0 = await bal(alice.publicKey);
    await program.methods.claimInstant(new anchor.BN(3), 0, new anchor.BN(700_000), t3.proof(0)).accountsPartial({
      config: P.config, epoch: P.epoch(3), receipt: P.receipt(3, alice.publicKey, 0), player: alice.publicKey,
      playerState: P.player(alice.publicKey), rewardVault: P.reward, payer: payer.publicKey, systemProgram: SystemProgram.programId,
    }).rpc();
    expect((await bal(alice.publicKey)) - a0).to.equal(expected);

    // the dropped Artifact is a real one: recycling returns its whole floor
    const r0 = await bal(alice.publicKey);
    await program.methods.recycleArtifact().accountsPartial({ config: P.config, asset: P.asset(0, s0), record: P.artifact(P.asset(0, s0)), collection: P.collection, owner: alice.publicKey, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId }).signers([alice]).rpc();
    expect((await bal(alice.publicKey)) - r0).to.be.greaterThan(Number(aliceValue) - 10_000);
  });

  it("expired randomness never re-rolls: drops are cancelled, a jackpot is refunded, a lottery prize goes to the pool", async () => {
    // a jackpot round drawn but never settled
    for (const k of [alice, bob]) await program.methods.deposit(new anchor.BN(5 * XNT)).accountsPartial({ playerState: P.player(k.publicKey), payer: payer.publicKey, systemProgram: SystemProgram.programId }).rpc();
    const jp = (await acc.config.fetch(P.config)).jackpotRound.toNumber();
    const enterJp = (k: Keypair, idx: number, amt: number) => program.methods.enterJackpot(new anchor.BN(jp), idx, new anchor.BN(amt))
      .accountsPartial({ config: P.config, round: P.jackpot(jp), entry: P.jpEntry(jp, idx), playerState: P.player(k.publicKey), signer: k.publicKey, systemProgram: SystemProgram.programId }).signers([k]).rpc();
    await enterJp(alice, 0, 1 * XNT);
    await enterJp(bob, 1, 2 * XNT);
    const jpBal = async () => [(await acc.playerState.fetch(P.player(alice.publicKey))).balance.toNumber(), (await acc.playerState.fetch(P.player(bob.publicKey))).balance.toNumber()];
    for (let i = 0; ; i++) {
      try { await program.methods.drawJackpot().accountsPartial({ config: P.config, round: P.jackpot(jp), firstPlayerState: P.player(alice.publicKey) }).rpc(); break; }
      catch (e: any) { if (!String(e).includes("RoundRunning") || i > 30) throw e; await sleep(500); }
    }
    // a lottery round drawn but never settled
    const dr = (await acc.config.fetch(P.config)).drawRound.toNumber();
    await program.methods.enterDraw(new anchor.BN(dr), 0, new anchor.BN(0), new anchor.BN(1)).accountsPartial({
      config: P.config, round: P.drawRound(dr), entry: P.drawEntry(dr, 0), playerState: P.player(bob.publicKey), rewardVault: P.reward,
      drawVault: P.draw, architect: architect.publicKey, signer: bob.publicKey, systemProgram: SystemProgram.programId,
    }).signers([bob]).rpc();
    for (let i = 0; ; i++) {
      try { await program.methods.drawDraw().accountsPartial({ config: P.config, round: P.drawRound(dr) }).rpc(); break; }
      catch (e: any) { if (!String(e).includes("RoundRunning") || i > 40) throw e; await sleep(500); }
    }

    // an epoch whose drops nobody seals; its leaf also claims more than the whole epoch
    const t4 = tree([claimLeaf(4, carol.publicKey, 0, 1000n)]);
    for (let i = 0; ; i++) {
      try { await publish(4, t4.root, 999n, 1); break; }
      catch (e: any) { if (!String(e).includes("EpochTooSoon") || i > 40) throw e; await sleep(1000); }
    }
    await expectErr(program.methods.claimInstant(new anchor.BN(4), 0, new anchor.BN(1000), t4.proof(0)).accountsPartial({
      config: P.config, epoch: P.epoch(4), receipt: P.receipt(4, carol.publicKey, 0), player: carol.publicKey,
      playerState: P.player(carol.publicKey), rewardVault: P.reward, payer: payer.publicKey, systemProgram: SystemProgram.programId,
    }).rpc(), "InvalidProof"); // a leaf can never weigh more than the epoch
    const e = await acc.epoch.fetch(P.epoch(4));
    // wait until the committed slot has left the SlotHashes window (512 slots)
    await waitPastSlot(BigInt(e.dropSlot.toString()) + 530n);
    const reserved0 = BigInt((await acc.config.fetch(P.config)).rewardReserved.toString());
    await seal(4);
    const e4 = await acc.epoch.fetch(P.epoch(4));
    expect(e4.dropState).to.equal(3);
    expect(reserved0 - BigInt((await acc.config.fetch(P.config)).rewardReserved.toString())).to.equal(BigInt(e.dropReserve.toString()));
    await expectErr(claimDrop(4, { p: carol.publicKey, t: 0, s: 1000n }, t4.proof(0), carol), "DropNotSealed");
    await expectErr(seal(4), "DropNotPending");

    // jackpot: refunded in full, entry by entry, permissionlessly
    const before = await jpBal();
    await program.methods.settleJackpot().accountsPartial({
      config: P.config, round: P.jackpot(jp), entry: P.jpEntry(jp, 0), winnerState: P.player(alice.publicKey), rewardVault: P.reward,
      drawVault: P.draw, architect: architect.publicKey, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
    }).rpc();
    expect((await acc.jackpotRound.fetch(P.jackpot(jp))).state).to.equal(3);
    expect((await acc.config.fetch(P.config)).jackpotRound.toNumber()).to.equal(jp + 1);
    for (const [i, k] of [[0, alice], [1, bob]] as [number, Keypair][]) {
      await program.methods.closeJackpotEntry().accountsPartial({ round: P.jackpot(jp), playerState: P.player(k.publicKey), entry: P.jpEntry(jp, i), rentPayer: k.publicKey }).rpc();
    }
    const after = await jpBal();
    expect(after[0] - before[0]).to.equal(1 * XNT);
    expect(after[1] - before[1]).to.equal(2 * XNT);

    // lottery: no winner this week; the would-be prize goes to the reward pool (never grows a later prize)
    const vault0 = await bal(P.draw), pool0 = await bal(P.reward);
    const expectedPrize = Math.floor((vault0 - (await connection.getMinimumBalanceForRentExemption(8))) / 2);
    await program.methods.settleDraw().accountsPartial({
      config: P.config, round: P.drawRound(dr), entry: P.drawEntry(dr, 0), winnerState: P.player(bob.publicKey), drawVault: P.draw,
      rewardVault: P.reward, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
    }).rpc();
    const r = await acc.drawRound.fetch(P.drawRound(dr));
    expect(r.state).to.equal(2);
    expect(r.winner.toBase58()).to.equal(PublicKey.default.toBase58());
    expect(r.prize.toNumber()).to.equal(expectedPrize);
    expect(vault0 - (await bal(P.draw))).to.equal(expectedPrize);
    expect((await bal(P.reward)) - pool0).to.equal(expectedPrize);
    expect((await acc.config.fetch(P.config)).drawRound.toNumber()).to.equal(dr + 1);
  });

  it("epoch expiry returns unclaimed budget to the pool and frees receipts", async () => {
    // epoch 1 window = 90 s on localnet
    const e1 = await acc.epoch.fetch(P.epoch(1));
    const wait = e1.expiresAt.toNumber() * 1000 - Date.now() + 1500;
    if (wait > 0) await sleep(wait);
    const reservedBefore = (await acc.config.fetch(P.config)).rewardReserved.toNumber();
    await program.methods.expireEpoch().accountsPartial({ config: P.config, epoch: P.epoch(1) }).rpc();
    // unclaimed budget + the never-sealed drop reserve both go back to the free pool
    const left = e1.budget.toNumber() - e1.claimed.toNumber() + e1.dropReserve.toNumber();
    expect(reservedBefore - (await acc.config.fetch(P.config)).rewardReserved.toNumber()).to.equal(left);
    expect((await acc.epoch.fetch(P.epoch(1))).dropState).to.equal(3);
    await program.methods.closeReceipt().accountsPartial({ epoch: P.epoch(1), receipt: P.receipt(1, alice.publicKey, 0), rentPayer: keeper.publicKey }).rpc();
  });

  it("expiry of a sealed epoch releases only the drop reserve that was not paid", async () => {
    const e3 = await acc.epoch.fetch(P.epoch(3));
    const wait = e3.expiresAt.toNumber() * 1000 - Date.now() + 1500;
    if (wait > 0) await sleep(wait);
    const reservedBefore = BigInt((await acc.config.fetch(P.config)).rewardReserved.toString());
    await program.methods.expireEpoch().accountsPartial({ config: P.config, epoch: P.epoch(3) }).rpc();
    const unpaidDrops = BigInt(e3.dropReserve.toString()) - BigInt(e3.dropPaid.toString());
    const left = BigInt(e3.budget.toString()) - BigInt(e3.claimed.toString()) + (unpaidDrops > 0n ? unpaidDrops : 0n);
    expect(reservedBefore - BigInt((await acc.config.fetch(P.config)).rewardReserved.toString())).to.equal(left);
  });

  // ─── Moon Wars (real) ──────────────────────────────────────────────────────
  const CARD: number[][] = [[2, 2, 1], [4, 3, 2], [6, 4, 3], [10, 10, 5]]; // power, defense, cost
  const warPda = (c: PublicKey, n: number) => pda(Buffer.from("war"), c.toBuffer(), u64(n));
  const settleWarAccounts = (w: any, war: PublicKey) => ({
    config: P.config, war, creatorState: P.player(w.creator), opponentState: P.player(w.opponent), rewardVault: P.reward,
    drawVault: P.draw, architect: architect.publicKey, rentPayer: w.rentPayer,
  });
  async function openWar(stakeXnt: number) {
    const nonce = (await acc.playerState.fetch(P.player(alice.publicKey))).nonce.toNumber();
    const war = warPda(alice.publicKey, nonce);
    await program.methods.createWar(new anchor.BN(stakeXnt * XNT), PublicKey.default).accountsPartial({
      config: P.config, creatorState: P.player(alice.publicKey), war, owner: alice.publicKey,
      asset: P.asset(0, 0), record: P.artifact(P.asset(0, 0)), collection: P.collection, systemProgram: SystemProgram.programId,
    }).signers([alice]).rpc();
    return war;
  }
  async function joinAndStart(war: PublicKey) {
    await program.methods.joinWar(PublicKey.default).accountsPartial({
      config: P.config, war, opponentState: P.player(bob.publicKey), opponent: bob.publicKey,
      asset: P.asset(1, 0), record: P.artifact(P.asset(1, 0)), collection: P.collection,
    }).signers([bob]).rpc();
    const w = await acc.war.fetch(war);
    await waitPastSlot(BigInt(w.targetSlot.toString()));
    for (let i = 0; ; i++) {
      try { await program.methods.startWar().accountsPartial({ war, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).rpc(); break; }
      catch (e: any) { if (!String(e).includes("NotReady") || i > 20) throw e; await sleep(400); }
    }
  }

  it("Moon Wars (real): Artifact ticket, seeded decks, every move validated on-chain, winner paid 98%", async () => {
    for (const k of [alice, bob]) await program.methods.deposit(new anchor.BN(3 * XNT)).accountsPartial({ playerState: P.player(k.publicKey), payer: payer.publicKey, systemProgram: SystemProgram.programId }).rpc();
    const war = await openWar(1);
    // a player can only use an Artifact it really holds as its ticket
    await expectErr(program.methods.joinWar(PublicKey.default).accountsPartial({
      config: P.config, war, opponentState: P.player(bob.publicKey), opponent: bob.publicKey,
      asset: P.asset(0, 0), record: P.artifact(P.asset(0, 0)), collection: P.collection,
    }).signers([bob]).rpc(), "NotArtifactOwner");
    await joinAndStart(war);
    let w = await acc.war.fetch(war);
    expect(w.state).to.equal(2);
    expect(w.sides[0].handLen).to.equal(3);
    expect(w.sides[1].handLen).to.equal(3);
    expect(w.sides[0].mana).to.equal(1);
    await expectErr(program.methods.warEndTurn().accountsPartial({ war, signer: bob.publicKey }).signers([bob]).rpc(), "NotYourTurn");
    await expectErr(program.methods.warSummon(9).accountsPartial({ war, signer: alice.publicKey }).signers([alice]).rpc(), "InvalidMove");

    // alice plays greedily (summon the most expensive card she can, then attack); bob only ends his turns
    const players = [alice, bob];
    let txs = 0;
    for (; txs < 400; txs++) {
      w = await acc.war.fetch(war);
      if (w.state !== 2) break;
      const k = players[w.turn];
      const send = (m: any) => m.accountsPartial({ war, signer: k.publicKey }).signers([k]).rpc();
      if (w.turn === 0) {
        const me = w.sides[0];
        let best = -1;
        for (let i = 0; i < me.handLen; i++) {
          const c = CARD[me.hand[i]];
          if (c[2] <= me.mana && me.fieldLen < 6 && (best < 0 || c[2] > CARD[me.hand[best]][2])) best = i;
        }
        if (best >= 0) { await send(program.methods.warSummon(best)); continue; }
        const ready = me.field.slice(0, me.fieldLen).findIndex((u: any) => u.ready);
        if (ready >= 0) { await send(program.methods.warAttack(ready, w.sides[1].fieldLen === 0 ? 255 : 0)); continue; }
      }
      await send(program.methods.warEndTurn());
    }
    w = await acc.war.fetch(war);
    expect(w.state).to.equal(3);
    expect(w.winner.toBase58()).to.equal(alice.publicKey.toBase58());
    expect(w.sides[1].health).to.be.at.most(0);

    const a0 = (await acc.playerState.fetch(P.player(alice.publicKey))).balance.toNumber();
    const pool0 = await bal(P.reward);
    await program.methods.settleWar().accountsPartial(settleWarAccounts(w, war)).rpc();
    expect((await acc.playerState.fetch(P.player(alice.publicKey))).balance.toNumber() - a0).to.equal(1.96 * XNT);
    expect((await bal(P.reward)) - pool0).to.equal(0.02 * XNT); // 1% of the 2 XNT pot
    expect(await connection.getAccountInfo(war)).to.equal(null);
  });

  it("Moon Wars (real): running out of turn time loses; an unjoined match is cancelled with a full refund", async () => {
    const war = await openWar(0.5);
    await joinAndStart(war);
    const b0 = (await acc.playerState.fetch(P.player(bob.publicKey))).balance.toNumber();
    // alice (to move) does nothing: after the turn timer anyone can award the match to bob
    for (let i = 0; ; i++) {
      try { await program.methods.claimWarTimeout().accountsPartial({ war }).rpc(); break; }
      catch (e: any) { if (!String(e).includes("DeadlineNotReached") || i > 30) throw e; await sleep(500); }
    }
    const w = await acc.war.fetch(war);
    expect(w.winner.toBase58()).to.equal(bob.publicKey.toBase58());
    expect(w.timeout).to.equal(true);
    await program.methods.settleWar().accountsPartial(settleWarAccounts(w, war)).rpc();
    expect((await acc.playerState.fetch(P.player(bob.publicKey))).balance.toNumber() - b0).to.equal(0.98 * XNT);

    const before = (await acc.playerState.fetch(P.player(alice.publicKey))).balance.toNumber();
    const lonely = await openWar(0.2);
    await program.methods.cancelWar().accountsPartial({ war: lonely, creatorState: P.player(alice.publicKey), creator: alice.publicKey }).signers([alice]).rpc();
    expect((await acc.playerState.fetch(P.player(alice.publicKey))).balance.toNumber()).to.equal(before);
  });

  // ─── Predictions (real) ────────────────────────────────────────────────────
  const OBS = new PublicKey("4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ");
  const predPda = (r: number) => pda(Buffer.from("pred"), u64(r));
  const predEntry = (r: number, p: PublicKey) => pda(Buffer.from("pred_entry"), u64(r), p.toBuffer());
  const chainTime = async () => (await connection.getBlockTime(await connection.getSlot("confirmed")))!;
  const untilChainTime = async (t: number) => { while ((await chainTime()) < t) await sleep(500); };
  const enterPred = (k: Keypair, r: number, side: number, xnt: number) => program.methods.enterPrediction(new anchor.BN(r), side, new anchor.BN(xnt * XNT))
    .accountsPartial({ round: predPda(r), entry: predEntry(r, k.publicKey), playerState: P.player(k.publicKey), owner: k.publicKey, systemProgram: SystemProgram.programId })
    .signers([k]).rpc();
  const lockPred = (r: number) => program.methods.lockPrediction().accountsPartial({ round: predPda(r), observation: OBS }).rpc();
  const claimPred = (r: number, p: PublicKey) => program.methods.claimPrediction().accountsPartial({
    config: P.config, round: predPda(r), entry: predEntry(r, p), playerState: P.player(p), rentPayer: p,
  }).rpc();
  const closeRound = async (r: number) => {
    const round = await acc.predRound.fetch(predPda(r));
    await program.methods.closePredictionRound().accountsPartial({ config: P.config, round: predPda(r), rewardVault: P.reward, rentPayer: round.rentPayer }).rpc();
  };
  async function retry(code: string[], f: () => Promise<any>) {
    for (let i = 0; ; i++) {
      try { return await f(); } catch (e: any) { if (!code.some((c) => String(e).includes(c)) || i > 60) throw e; await sleep(500); }
    }
  }

  it("Predictions (real): XNT up/down priced by the XDEX on-chain TWAP; winners share the pot minus 2%", async () => {
    // localnet schedule: a round every 40 s, entries for 20 s, resolved 20 s after the lock
    let t = await chainTime();
    while (t % 40 < 2 || t % 40 > 12) { await sleep(1000); t = await chainTime(); }
    const r = Math.floor(t / 40);
    await enterPred(alice, r, 1, 1); // UP
    await enterPred(bob, r, 0, 1); // DOWN
    await expectErr(enterPred(alice, r, 0, 1), "already in use"); // one entry per wallet per round
    await expectErr(program.methods.enterPrediction(new anchor.BN(r), 1, new anchor.BN(XNT)).accountsPartial({
      round: predPda(r), entry: predEntry(r, bot.publicKey), playerState: P.player(bob.publicKey), owner: bot.publicKey, systemProgram: SystemProgram.programId,
    }).signers([bot]).rpc(), ""); // a bot session key cannot bet in a shared pot
    await expectErr(lockPred(r), "RoundRunning");

    await untilChainTime(r * 40 + 20);
    await retry(["RoundRunning", "NotReady"], () => lockPred(r));
    let round = await acc.predRound.fetch(predPda(r));
    expect(round.state).to.equal(1);
    expect(BigInt(round.startPriceX32.toString()) > 0n).to.equal(true);
    await expectErr(enterPred(carol, r, 1, 1), ""); // closed after the lock

    await untilChainTime(r * 40 + 40);
    const pool0 = await bal(P.reward);
    await retry(["RoundRunning", "NotReady"], () => program.methods.settlePrediction().accountsPartial({
      config: P.config, round: predPda(r), observation: OBS, rewardVault: P.reward, drawVault: P.draw, architect: architect.publicKey,
    }).rpc());
    round = await acc.predRound.fetch(predPda(r));
    expect(round.state).to.equal(2);
    expect(round.outcome).to.equal(1); // the synthetic price rises → UP
    expect(BigInt(round.endPriceX32.toString()) > BigInt(round.startPriceX32.toString())).to.equal(true);
    expect((await bal(P.reward)) - pool0).to.equal(0.02 * XNT);
    const a0 = (await acc.playerState.fetch(P.player(alice.publicKey))).balance.toNumber();
    const b0 = (await acc.playerState.fetch(P.player(bob.publicKey))).balance.toNumber();
    await claimPred(r, alice.publicKey);
    await claimPred(r, bob.publicKey);
    expect((await acc.playerState.fetch(P.player(alice.publicKey))).balance.toNumber() - a0).to.equal(1.96 * XNT);
    expect((await acc.playerState.fetch(P.player(bob.publicKey))).balance.toNumber() - b0).to.equal(0);
    expect(await connection.getAccountInfo(predEntry(r, bob.publicKey))).to.equal(null);
    // once every entry is claimed the round closes: dust to the pool, rent back to the first entrant
    const roundRent = await bal(predPda(r));
    const alice0 = await bal(alice.publicKey);
    await closeRound(r);
    expect(await connection.getAccountInfo(predPda(r))).to.equal(null);
    expect((await bal(alice.publicKey)) - alice0).to.equal(roundRent);

    // next round, nobody on the other side: refunded in full at the lock
    const r2 = r + 1;
    await untilChainTime(r2 * 40 + 1);
    await enterPred(alice, r2, 0, 0.5);
    await expectErr(closeRound(r2), "PredState"); // not before it is resolved and fully claimed
    const a1 = (await acc.playerState.fetch(P.player(alice.publicKey))).balance.toNumber();
    await untilChainTime(r2 * 40 + 20);
    await retry(["RoundRunning", "NotReady"], () => lockPred(r2));
    expect((await acc.predRound.fetch(predPda(r2))).state).to.equal(3);
    await claimPred(r2, alice.publicKey);
    expect((await acc.playerState.fetch(P.player(alice.publicKey))).balance.toNumber() - a1).to.equal(0.5 * XNT);
    await closeRound(r2);
    expect(await connection.getAccountInfo(predPda(r2))).to.equal(null);
  });

  it("solvency invariant: every vault still covers its obligations", async () => {
    const c = await acc.config.fetch(P.config);
    const rent = await connection.getMinimumBalanceForRentExemption(8);
    expect((await bal(P.reward)) - rent).to.be.at.least(c.rewardReserved.toNumber());
    expect((await bal(P.bankroll)) - rent).to.be.at.least(c.bankrollReserved.toNumber());
  });
});
