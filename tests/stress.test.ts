/**
 * Moon Forge v2 — randomized stress test + full accounting audit.
 * Runs on the same local validator, after moon-forge.test.ts (see run-local.sh).
 *
 * After every round, audit() reads EVERY account owned by the program and checks that:
 *   • each account holds what it owes (game wallets, missions, pots, duels, artifact floors, bets)
 *   • config.reward_reserved   == Σ open epochs (unclaimed budget + unpaid drop reserve)
 *   • config.bankroll_reserved == Σ max payouts of unsettled bets
 *   • each vault covers its reservations (+ rent)
 *   • Σ LP shares + protocol shares == total shares
 * Any violation fails the test with the account that broke it.
 *
 *   STRESS_SEED=7 STRESS_ROUNDS=20 npx mocha ... stress.test.ts   (reproducible)
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
const SEED = Number(process.env.STRESS_SEED ?? 42);
const ROUNDS = Number(process.env.STRESS_ROUNDS ?? 10);
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const architect = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "test-architect.json"), "utf8"))));

const connection = new Connection(RPC, "confirmed");
const payer = Keypair.generate();
const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" }));
const pid = program.programId;
const acc = program.account as any;

// ─── deterministic PRNG (mulberry32) ────────────────────────────────────────
let rngState = SEED >>> 0;
const rand = () => {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

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
  player: (o: PublicKey) => pda(Buffer.from("player"), o.toBuffer()),
  bet: (ps: PublicKey, n: number | bigint) => pda(Buffer.from("bet"), ps.toBuffer(), u64(n)),
  house: (o: PublicKey) => pda(Buffer.from("house"), o.toBuffer()),
  jackpot: (r: number) => pda(Buffer.from("jackpot"), u64(r)),
  jpEntry: (r: number, i: number) => pda(Buffer.from("jp_entry"), u64(r), u32(i)),
  duel: (c: PublicKey, n: number | bigint) => pda(Buffer.from("duel"), c.toBuffer(), u64(n)),
  asset: (t: number, s: number) => pda(Buffer.from("asset"), Buffer.from([t]), u32(s)),
  artifact: (a: PublicKey) => pda(Buffer.from("artifact"), a.toBuffer()),
};
const keccak = (...p: Uint8Array[]) => { const h = keccak_256.create(); p.forEach((x) => h.update(x)); return Buffer.from(h.digest()); };
const rnd = (h: Buffer, a: Buffer, b: Buffer) => keccak(Buffer.from("MOONFORGE_RNG"), h, a, b).readBigUInt64LE(0);
const bal = (k: PublicKey) => connection.getBalance(k, "confirmed");
const errText = (e: any) => String(e) + JSON.stringify(e?.logs ?? e?.transactionLogs ?? "");
async function fund(k: PublicKey, amount = 1000) {
  await connection.confirmTransaction(await connection.requestAirdrop(k, amount * XNT), "confirmed");
}
async function waitPastSlot(target: bigint) {
  for (;;) { if (BigInt(await connection.getSlot("confirmed")) > target + 1n) return; await sleep(250); }
}
async function slotHashAtOrAfter(target: bigint): Promise<Buffer | null> {
  const d = (await connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY))!.data;
  const len = Number(d.readBigUInt64LE(0));
  let best: Buffer | null = null;
  for (let i = 0; i < len; i++) { const o = 8 + i * 40; if (d.readBigUInt64LE(o) >= target) best = d.subarray(o + 8, o + 40); else break; }
  return best;
}
/** Runs an action that may legitimately be refused; any other failure is a bug. */
async function attempt(label: string, allowed: string[], f: () => Promise<any>, simulate?: () => Promise<any>): Promise<boolean> {
  try { await f(); return true; } catch (e: any) {
    let t = errText(e);
    // A tx that passes preflight but fails on-chain (state changed in between, e.g. a round just
    // closed) reaches us as "Unknown action 'undefined'" (Anchor 0.32 + web3.js 1.98 drop the logs):
    // re-simulate the same instruction to read the real program error.
    if (simulate && !allowed.some((a) => t.includes(a))) t += " | simulation: " + (await simulate());
    if (allowed.some((a) => t.includes(a))) { refusals[label] = (refusals[label] ?? 0) + 1; return false; }
    throw new Error(`${label} failed unexpectedly: ${t.slice(0, 1500)}`);
  }
}
const refusals: Record<string, number> = {};
async function simLogs(b: () => any, signer: Keypair): Promise<string> {
  const tx = await b().transaction();
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(signer);
  const sim = await connection.simulateTransaction(tx);
  return JSON.stringify(sim.value.err) + " " + (sim.value.logs ?? []).join(" ");
}

// ─── the auditor ────────────────────────────────────────────────────────────
const rentCache = new Map<number, number>();
const rentFor = async (len: number) => {
  if (!rentCache.has(len)) rentCache.set(len, await connection.getMinimumBalanceForRentExemption(len));
  return rentCache.get(len)!;
};
const discs = new Map<string, string>((program.idl.accounts ?? []).map((a: any) => [Buffer.from(a.discriminator).toString("hex"), a.name]));
/** Retries an action the validator clock may not allow yet (it can lag the host clock). */
async function whenAllowed(code: string, f: () => Promise<any>) {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e: any) { if (!errText(e).includes(code) || i > 30) throw e; await sleep(500); }
  }
}
let audits = 0;

async function audit(tag: string) {
  const all = await connection.getProgramAccounts(pid, { commitment: "confirmed" });
  const fail = (msg: string) => assert.fail(`[audit ${tag}] ${msg}`);
  let config: any;
  let epochReserved = 0n, betReserved = 0n, lpShares = 0n;
  const counts: Record<string, number> = {};
  const refundRounds = new Map<string, { lamports: bigint; id: bigint }>(); // refunded jackpots: owe their open entries
  const jpEntries: { round: bigint; amount: bigint }[] = [];
  for (const { pubkey, account } of all) {
    const name = discs.get(Buffer.from(account.data.subarray(0, 8)).toString("hex"));
    if (!name) continue; // the three lamport vaults (8 zero bytes)
    const kind = name.toLowerCase();
    counts[kind] = (counts[kind] ?? 0) + 1;
    const d: any = program.coder.accounts.decode(name, account.data);
    const free = BigInt(account.lamports) - BigInt(await rentFor(account.data.length));
    const need = (owed: bigint, what: string) => { if (free < owed) fail(`${name} ${pubkey.toBase58()} holds ${free} above rent but owes ${owed} (${what})`); };
    switch (kind) {
      case "config": config = d; break;
      case "epoch": {
        if (d.closed) break;
        epochReserved += BigInt(d.budget.toString()) - BigInt(d.claimed.toString());
        if (d.dropState === 1 || d.dropState === 2) {
          const left = BigInt(d.dropReserve.toString()) - BigInt(d.dropPaid.toString());
          if (left > 0n) epochReserved += left;
        }
        break;
      }
      case "bet": betReserved += BigInt(d.payout.toString()); need(0n, "rent"); break;
      case "playerstate": need(BigInt(d.balance.toString()), "game balance"); break;
      case "mission": need(BigInt(d.total.toString()) - BigInt(d.withdrawn.toString()), "unvested + vested-unpaid"); break;
      case "artifactrecord": need(BigInt(d.backing.toString()), "artifact floor"); break;
      case "jackpotround":
        if (d.state === 0 || d.state === 1) need(BigInt(d.total.toString()), "open pot");
        else if (d.state === 3) refundRounds.set(BigInt(d.id.toString()).toString(), { lamports: free, id: BigInt(d.id.toString()) });
        else need(0n, "rent");
        break;
      case "jackpotentry": jpEntries.push({ round: BigInt(d.round.toString()), amount: BigInt(d.amount.toString()) }); need(0n, "rent"); break;
      case "duel": need(BigInt(d.stake.toString()) * (d.state === 1 ? 2n : d.state === 0 ? 1n : 0n), "duel stakes"); break;
      case "houseshare": lpShares += BigInt(d.shares.toString()); break;
      default: need(0n, "rent");
    }
  }
  if (!config) fail("config missing");
  for (const [id, r] of refundRounds) {
    const owed = jpEntries.filter((e) => e.round.toString() === id).reduce((a, e) => a + e.amount, 0n);
    if (r.lamports < owed) fail(`refunded jackpot ${id} holds ${r.lamports} but owes ${owed} to its entries`);
  }
  const reserved = BigInt(config.rewardReserved.toString());
  if (reserved !== epochReserved) fail(`reward_reserved ${reserved} != Σ open epochs ${epochReserved}`);
  if (BigInt(config.bankrollReserved.toString()) !== betReserved) fail(`bankroll_reserved ${config.bankrollReserved} != Σ bets ${betReserved}`);
  if (lpShares + BigInt(config.houseProtocolShares.toString()) !== BigInt(config.houseTotalShares.toString())) fail(`shares ${lpShares}+${config.houseProtocolShares} != ${config.houseTotalShares}`);
  // aggregate exposure cap: unsettled payouts never above 20% of the bankroll
  const binfo = (await connection.getAccountInfo(P.bankroll, "confirmed"))!;
  const bopt = BigInt(binfo.lamports) - BigInt(await rentFor(binfo.data.length));
  if (betReserved * 10_000n > bopt * 2_000n + 10_000n) fail(`bets reserve ${betReserved} > 20% of bankroll ${bopt}`);
  for (const [v, owed, label] of [[P.reward, reserved, "reward"], [P.bankroll, betReserved, "bankroll"], [P.draw, 0n, "draw"]] as [PublicKey, bigint, string][]) {
    const info = (await connection.getAccountInfo(v, "confirmed"))!;
    const free = BigInt(info.lamports) - BigInt(await rentFor(info.data.length));
    if (free < owed) fail(`${label} vault holds ${free} but owes ${owed}`);
  }
  audits++;
  return { config, counts };
}

// ─── actors ─────────────────────────────────────────────────────────────────
const players = Array.from({ length: 8 }, () => Keypair.generate());
const lps = Array.from({ length: 3 }, () => Keypair.generate());
const holdings = new Map<string, { tier: number; serial: number }>(); // one artifact per player (duels)
const pendingBets: { ps: PublicKey; nonce: number; rentPayer: PublicKey }[] = [];
const openDuels: { creator: Keypair; duel: PublicKey; element: number; salt: Buffer; joined?: Keypair; revealed?: boolean }[] = [];

const betAccounts = (k: Keypair, nonce: number) => ({
  config: P.config, playerState: P.player(k.publicKey), bet: P.bet(P.player(k.publicKey), nonce), bankrollVault: P.bankroll,
  rewardVault: P.reward, architect: architect.publicKey, signer: k.publicKey, systemProgram: SystemProgram.programId,
});
async function freeBankroll() {
  const c = await acc.config.fetch(P.config);
  const info = (await connection.getAccountInfo(P.bankroll))!;
  return info.lamports - (await rentFor(info.data.length)) - c.bankrollReserved.toNumber();
}
/** Largest stake the exposure cap allows for a payout multiplier (in bps). */
async function maxStake(payoutBps: number) {
  return Math.floor(((await freeBankroll()) * 25) / 10_000 / (payoutBps / 10_000 - 1));
}
async function placeBet(k: Keypair, game: number, param: number, choice: number, stake: number) {
  const ps = P.player(k.publicKey);
  const nonce = (await acc.playerState.fetch(ps)).nonce.toNumber();
  const ok = await attempt("bet", ["BankrollTooSmall", "InsufficientBalance", "AmountTooSmall"], () =>
    program.methods.placeBet(game, new anchor.BN(param), choice, new anchor.BN(stake), Array.from(keccak(u64(nonce), k.publicKey.toBuffer())))
      .accountsPartial(betAccounts(k, nonce)).signers([k]).rpc());
  if (ok) pendingBets.push({ ps, nonce, rentPayer: k.publicKey });
  return ok;
}
async function settleAllBets() {
  if (!pendingBets.length) return;
  const last = await acc.bet.fetch(P.bet(pendingBets[pendingBets.length - 1].ps, pendingBets[pendingBets.length - 1].nonce));
  await waitPastSlot(BigInt(last.targetSlot.toString()));
  while (pendingBets.length) {
    const b = pendingBets.shift()!;
    await program.methods.settleBet().accountsPartial({
      config: P.config, bet: P.bet(b.ps, b.nonce), playerState: b.ps, bankrollVault: P.bankroll, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: b.rentPayer,
    }).rpc();
  }
}
async function runJackpot() {
  const id = (await acc.config.fetch(P.config)).jackpotRound.toNumber();
  const round = await acc.jackpotRound.fetchNullable(P.jackpot(id));
  if (!round || round.endTs.toNumber() === 0) return;
  await whenAllowed("RoundRunning", () => program.methods.drawJackpot().accountsPartial({ config: P.config, round: P.jackpot(id), firstPlayerState: P.player(round.firstPlayer) }).rpc());
  const r = await acc.jackpotRound.fetch(P.jackpot(id));
  if (r.state === 2) return; // single player: refunded in full
  await waitPastSlot(BigInt(r.targetSlot.toString()));
  const h = (await slotHashAtOrAfter(BigInt(r.targetSlot.toString())))!;
  const t = rnd(h, P.jackpot(id).toBuffer(), u64(id)) % BigInt(r.total.toString());
  for (let i = 0; i < r.entries; i++) {
    const e = await acc.jackpotEntry.fetch(P.jpEntry(id, i));
    if (t >= BigInt(e.start.toString()) && t < BigInt(e.start.toString()) + BigInt(e.amount.toString())) {
      await program.methods.settleJackpot().accountsPartial({
        config: P.config, round: P.jackpot(id), entry: P.jpEntry(id, i), winnerState: P.player(e.player), rewardVault: P.reward,
        drawVault: P.draw, architect: architect.publicKey, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
      }).rpc();
      return;
    }
  }
  assert.fail("no winning jackpot entry");
}
const forge = (k: Keypair, tier: number, serial: number) => program.methods.forgeArtifact(tier, serial, new anchor.BN("18446744073709551615")).accountsPartial({
  config: P.config, asset: P.asset(tier, serial), record: P.artifact(P.asset(tier, serial)), collection: P.collection, artifactAuthority: P.authority,
  rewardVault: P.reward, drawVault: P.draw, architect: architect.publicKey, buyer: k.publicKey, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
}).signers([k]).rpc();
const resolveAccounts = (d: { creator: Keypair; duel: PublicKey; joined?: Keypair }) => ({
  config: P.config, duel: d.duel, creatorState: P.player(d.creator.publicKey), opponentState: P.player(d.joined!.publicKey),
  rewardVault: P.reward, drawVault: P.draw, architect: architect.publicKey, rentPayer: d.creator.publicKey,
});

describe("Moon Forge v2 — stress & solvency audit", () => {
  before(async () => {
    await fund(payer.publicKey, 5000);
    for (const k of [...players, ...lps]) await fund(k.publicKey, 500);
    if (!(await connection.getAccountInfo(P.config))) {
      await program.methods.initializeV2().accountsPartial({
        config: P.config, rewardVault: P.reward, bankrollVault: P.bankroll, drawVault: P.draw, collection: P.collection,
        artifactAuthority: P.authority, payer: payer.publicKey, systemProgram: SystemProgram.programId,
      }).rpc();
    }
    if (!(await connection.getAccountInfo(P.collection))) {
      await program.methods.initArtifacts().accountsPartial({ config: P.config, collection: P.collection, artifactAuthority: P.authority, payer: payer.publicKey, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId }).rpc();
    }
    await audit("start");
    for (const k of lps) await program.methods.houseDeposit(new anchor.BN(between(50, 200) * XNT), new anchor.BN(0)).accountsPartial({ config: P.config, share: P.house(k.publicKey), bankrollVault: P.bankroll, owner: k.publicKey, systemProgram: SystemProgram.programId }).signers([k]).rpc();
    for (const k of players) {
      await program.methods.openPlayer().accountsPartial({ playerState: P.player(k.publicKey), owner: k.publicKey, systemProgram: SystemProgram.programId }).signers([k]).rpc();
      await program.methods.deposit(new anchor.BN(between(20, 80) * XNT)).accountsPartial({ playerState: P.player(k.publicKey), payer: k.publicKey, systemProgram: SystemProgram.programId }).signers([k]).rpc();
      const tier = pick([0, 0, 1, 1, 2, 3]);
      const serial = (await acc.config.fetch(P.config)).artifactsMinted[tier];
      await forge(k, tier, serial);
      holdings.set(k.publicKey.toBase58(), { tier, serial });
    }
    await audit("setup");
  });

  it(`random play (${ROUNDS} rounds, seed ${SEED}) never breaks an invariant`, async () => {
    const c0 = await acc.config.fetch(P.config);
    for (let r = 0; r < ROUNDS; r++) {
      // house games with random parameters and stakes (log-uniform 0.01 .. 5 XNT)
      for (const k of players) {
        for (let n = between(0, 3); n > 0; n--) {
          const game = pick([0, 1, 2]);
          const param = game === 1 ? between(100, 9500) : game === 2 ? pick([10_500, 20_000, 50_000, 100_000, 1_000_000]) : 0;
          const stake = Math.floor(0.01 * XNT * Math.pow(500, rand()));
          await placeBet(k, game, param, between(0, 1), stake);
        }
      }
      // an attacker tries 2x the exposure cap on a 100x Void Rush: always refused by the cap
      const greedy = players[r % players.length];
      const over = (await maxStake(1_000_000)) * 2 + 1;
      if (over >= 10_000_000) {
        const nonce = (await acc.playerState.fetch(P.player(greedy.publicKey))).nonce.toNumber();
        let refused = "";
        try {
          await program.methods.placeBet(2, new anchor.BN(1_000_000), 0, new anchor.BN(over), Array(32).fill(1)).accountsPartial(betAccounts(greedy, nonce)).signers([greedy]).rpc();
        } catch (e: any) { refused = errText(e); }
        expect(refused, "an over-cap bet was accepted").to.contain("BankrollTooSmall");
      }

      // jackpot entries
      const jp = (await acc.config.fetch(P.config)).jackpotRound.toNumber();
      for (const k of players.filter(() => rand() < 0.4)) {
        const round = await acc.jackpotRound.fetchNullable(P.jackpot(jp));
        const idx = round ? round.entries : 0;
        const amount = Math.floor(between(1, 30) * XNT / 10);
        const b = () => program.methods.enterJackpot(new anchor.BN(jp), idx, new anchor.BN(amount))
          .accountsPartial({ config: P.config, round: P.jackpot(jp), entry: P.jpEntry(jp, idx), playerState: P.player(k.publicKey), signer: k.publicKey, systemProgram: SystemProgram.programId })
          .signers([k]);
        await attempt("jackpot", ["InsufficientBalance", "RoundNotOpen"], () => b().rpc(), () => simLogs(b, k));
      }

      // duels between artifact holders (creator commits, opponent joins with its own element)
      if (rand() < 0.7) {
        const [a, b] = [pick(players), pick(players)];
        if (a !== b) {
          const ha = holdings.get(a.publicKey.toBase58())!, hb = holdings.get(b.publicKey.toBase58())!;
          const nonce = (await acc.playerState.fetch(P.player(a.publicKey))).nonce.toNumber();
          const duel = P.duel(a.publicKey, nonce);
          const salt = keccak(duel.toBuffer(), u64(r));
          const created = await attempt("duel", ["InsufficientBalance"], () =>
            program.methods.createDuel(new anchor.BN(between(1, 20) * XNT / 10), Array.from(keccak(Buffer.from("MOONFORGE_DUEL"), Buffer.from([ha.tier]), salt, duel.toBuffer())))
              .accountsPartial({ config: P.config, creatorState: P.player(a.publicKey), duel, owner: a.publicKey, asset: P.asset(ha.tier, ha.serial), record: P.artifact(P.asset(ha.tier, ha.serial)), collection: P.collection, systemProgram: SystemProgram.programId }).signers([a]).rpc());
          if (created) {
            const d = { creator: a, duel, element: ha.tier, salt, joined: undefined as Keypair | undefined, revealed: false };
            const joined = await attempt("duel-join", ["InsufficientBalance"], () =>
              program.methods.joinDuel(hb.tier).accountsPartial({
                config: P.config, duel, opponentState: P.player(b.publicKey), opponent: b.publicKey,
                asset: P.asset(hb.tier, hb.serial), record: P.artifact(P.asset(hb.tier, hb.serial)), collection: P.collection,
              }).signers([b]).rpc());
            if (joined) {
              d.joined = b;
              // most creators reveal at once; the others let the window lapse and lose by timeout
              if (rand() < 0.75) {
                d.revealed = await attempt("duel-reveal", ["DeadlinePassed"], () => program.methods.revealDuel(d.element, Array.from(d.salt)).accountsPartial({
                  resolve: resolveAccounts(d), creator: a.publicKey,
                }).signers([a]).rpc());
              }
            }
            openDuels.push(d);
          }
        }
      }

      // artifact churn: forge a Lunar Dust and sometimes recycle it right away
      if (rand() < 0.5) {
        const k = pick(players);
        const serial = (await acc.config.fetch(P.config)).artifactsMinted[0];
        if (await attempt("forge", ["SoldOut"], () => forge(k, 0, serial)) && rand() < 0.6) {
          await program.methods.recycleArtifact().accountsPartial({ config: P.config, asset: P.asset(0, serial), record: P.artifact(P.asset(0, serial)), collection: P.collection, owner: k.publicKey, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId }).signers([k]).rpc();
        }
      }

      // LPs come and go (24 "hours" = 1 s on localnet)
      for (const k of lps) {
        const s = await acc.houseShare.fetchNullable(P.house(k.publicKey));
        const roll = rand();
        if (s && s.pendingShares.toNumber() > 0) {
          await attempt("lp-withdraw", ["WithdrawLocked"], () => program.methods.houseWithdraw(new anchor.BN(0)).accountsPartial({ config: P.config, share: P.house(k.publicKey), bankrollVault: P.bankroll, owner: k.publicKey }).signers([k]).rpc());
        } else if (s && s.shares.toNumber() > 0 && roll < 0.3) {
          await program.methods.houseRequestWithdraw(new anchor.BN(Math.max(1, Math.floor(s.shares.toNumber() * rand())))).accountsPartial({ share: P.house(k.publicKey), owner: k.publicKey }).signers([k]).rpc();
        } else if (roll > 0.8) {
          await program.methods.houseDeposit(new anchor.BN(between(1, 40) * XNT), new anchor.BN(0)).accountsPartial({ config: P.config, share: P.house(k.publicKey), bankrollVault: P.bankroll, owner: k.publicKey, systemProgram: SystemProgram.programId }).signers([k]).rpc();
        }
      }

      // players move money in and out of their game wallets
      const k = pick(players);
      const b = (await acc.playerState.fetch(P.player(k.publicKey))).balance.toNumber();
      if (b > 0 && rand() < 0.5) await program.methods.withdraw(new anchor.BN(Math.max(1, Math.floor(b * rand())))).accountsPartial({ playerState: P.player(k.publicKey), owner: k.publicKey }).signers([k]).rpc();
      else await program.methods.deposit(new anchor.BN(between(1, 10) * XNT)).accountsPartial({ playerState: P.player(k.publicKey), payer: k.publicKey, systemProgram: SystemProgram.programId }).signers([k]).rpc();

      await audit(`round ${r} (bets pending)`);

      // resolution: settle every bet, draw the jackpot, reveal / time out / cancel duels
      await settleAllBets();
      await runJackpot();
      for (const d of openDuels.splice(0)) {
        if (!d.joined) {
          await program.methods.cancelDuel().accountsPartial({ duel: d.duel, creatorState: P.player(d.creator.publicKey), creator: d.creator.publicKey }).signers([d.creator]).rpc();
        } else if (!d.revealed) {
          // the creator did not reveal in time (the window is 2 s on localnet): the opponent wins
          await whenAllowed("DeadlineNotReached", () => program.methods.claimDuelTimeout().accountsPartial(resolveAccounts(d)).rpc());
        }
      }
      await audit(`round ${r} (settled)`);
    }
    const c1 = await acc.config.fetch(P.config);
    const wagered = c1.stats.wagered.toNumber() - c0.stats.wagered.toNumber();
    const paid = c1.stats.paidToPlayers.toNumber() - c0.stats.paidToPlayers.toNumber();
    console.log(`      ${c1.stats.bets.toNumber() - c0.stats.bets.toNumber()} bets, ${(wagered / XNT).toFixed(2)} XNT wagered, ${(paid / XNT).toFixed(2)} XNT paid (incl. P2P), refusals ${JSON.stringify(refusals)}, audits ${audits}`);
  });

  it("whale at the exposure cap on 100x Void Rush, 40 bets in a row: the bankroll never owes more than it holds", async () => {
    const whale = players[0];
    await program.methods.deposit(new anchor.BN(300 * XNT)).accountsPartial({ playerState: P.player(whale.publicKey), payer: payer.publicKey, systemProgram: SystemProgram.programId }).rpc();
    // a deep bankroll so that a max-size 100x bet is well above the minimum stake
    await program.methods.houseDeposit(new anchor.BN(3000 * XNT), new anchor.BN(0)).accountsPartial({ config: P.config, share: P.house(payer.publicKey), bankrollVault: P.bankroll, owner: payer.publicKey, systemProgram: SystemProgram.programId }).rpc();
    const free0 = await freeBankroll();
    let placed = 0, wins = 0;
    for (let i = 0; i < 40; i++) {
      const cap = await maxStake(1_000_000);
      expect(cap).to.be.greaterThan(10_000_000);
      expect(await placeBet(whale, 2, 1_000_000, 0, cap)).to.equal(true);
      placed++;
      if (i % 8 === 7) {
        await audit(`whale ${i}`);
        const before = (await acc.config.fetch(P.config)).stats.paidToPlayers.toNumber();
        await settleAllBets();
        if ((await acc.config.fetch(P.config)).stats.paidToPlayers.toNumber() > before) wins++;
      }
    }
    expect(placed).to.equal(40);
    console.log(`      whale: 40 max-size 100x bets, ${wins} batch(es) with a win, bankroll ${(free0 / XNT).toFixed(1)} → ${((await freeBankroll()) / XNT).toFixed(1)} XNT (before final settle)`);
    await settleAllBets();
    await audit("whale end");
    const free1 = await freeBankroll();
    // even if the whale hit every time, 40 bets at 0.25% each can remove at most 1 - 0.9975^40 ≈ 9.5%
    expect(free1).to.be.greaterThan(free0 * 0.9);
  });

  it("bank run: every LP exits while bets are pending — the pending winners are still paid in full", async () => {
    for (const k of players.slice(1, 6)) await placeBet(k, 0, 0, between(0, 1), 50_000_000);
    const pending = pendingBets.length;
    expect(pending).to.be.greaterThan(0);
    for (const k of lps) {
      const s = await acc.houseShare.fetchNullable(P.house(k.publicKey));
      if (!s || s.shares.toNumber() === 0) continue;
      await program.methods.houseRequestWithdraw(s.shares).accountsPartial({ share: P.house(k.publicKey), owner: k.publicKey }).signers([k]).rpc();
    }
    for (const k of lps) {
      const s = await acc.houseShare.fetchNullable(P.house(k.publicKey));
      if (!s || s.pendingShares.toNumber() === 0) continue;
      await whenAllowed("WithdrawLocked", () => program.methods.houseWithdraw(new anchor.BN(0)).accountsPartial({ config: P.config, share: P.house(k.publicKey), bankrollVault: P.bankroll, owner: k.publicKey }).signers([k]).rpc());
      await audit("lp exit");
    }
    await settleAllBets(); // every winner is paid from the reserved part, which no LP could take
    await audit("after bank run");
    const c = await acc.config.fetch(P.config);
    expect(c.bankrollReserved.toNumber()).to.equal(0);
  });

  it("players can always withdraw their whole game balance", async () => {
    for (const k of players) {
      const b = (await acc.playerState.fetch(P.player(k.publicKey))).balance.toNumber();
      if (b === 0) continue;
      const before = await bal(k.publicKey);
      await program.methods.withdraw(new anchor.BN(b)).accountsPartial({ playerState: P.player(k.publicKey), owner: k.publicKey }).signers([k]).rpc();
      expect((await bal(k.publicKey)) - before).to.be.greaterThan(b - 10_000);
    }
    await audit("all withdrawn");
  });
});
