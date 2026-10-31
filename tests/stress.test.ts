/**
 * Moon Forge v3 — randomized stress test + full accounting audit (SPEC-UPGRADE-v2 8.3).
 * Runs on the same local validator, after moon-forge.test.ts (see run-local.sh).
 *
 * Every round: house bets through place_bet_v2 + anchor_bet, settled by a keeper loop that reveals in chain order and
 * stalls ~2% of the bets on purpose (keeper skip → refund_stalled_bet, reason 1); Jackpot rounds drawn on a chain
 * position and settled by the keeper; sealed duels and Moon Wars without tickets; forges / recycles / listings / buys
 * (PX price checked against the TS mirror); base + extra epochs published when the interval allows, claimed after the
 * hold, sometimes voided with a bond; v2 prediction rounds; LPs and game wallets moving.
 * After every round, audit() reads EVERY program account and checks, besides what each account owes:
 *   • the 23-kind length map, reward_reserved == Σ open epochs, bankroll_reserved == Σ bet payouts
 *   • keeper: pending_bets == #v2 bets + #DRAWING v3 rounds, jackpot_reserved == Σ DRAWING pots,
 *     bond >= bankroll_reserved + jackpot_reserved, next_index − revealed == pending positions, seat >= rent + bond (r4-fix: reason-0 forfeits stay in it)
 *   • ExtraState: reserved == Σ open extra budgets − claims, accounted == the TS ledger, the vault covers both,
 *     live_forged_backing == Σ floors of live FORGED records
 *   • PlayerState.chips == 0 everywhere (ECO-3), oracle seat == rent + bond, listings delegate or stale
 *   STRESS_SEED=7 STRESS_ROUNDS=20 npx mocha ... stress.test.ts   (reproducible choices; timing is the validator's)
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";
import { assert, expect } from "chai";
import {
  airdrop, big, betUnpack, chainTools, claimLeaf, currentPrice, errMatches, errText, extraLeaf, forgeSplit, idl, isWin, jackpotTicketV2, KeeperChain, keccak, kp, L,
  marketSplit, minListPrice, MPL_CORE, OBS, pdas, retry, rnd, sleep, trackedMethods, tree, u64, U64_MAX, voidBond, XNT,
} from "./v3-helpers";

const RPC = process.env.RPC || "http://127.0.0.1:8899";
const SEED = Number(process.env.STRESS_SEED ?? 42);
const ROUNDS = Number(process.env.STRESS_ROUNDS ?? 10);
const connection = new Connection(RPC, "confirmed");
const payer = Keypair.generate();
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);
// the confirmation rule of the other suites (tests/tx-confirm.cjs through v3-helpers trackedMethods), without coverage recording
const methods: any = trackedMethods(program, false);
const acc = program.account as any;
const pid = program.programId;
const P = pdas(pid);
const T = chainTools(connection, program);
const { bal } = T;
const BN = (x: number | bigint | string) => new anchor.BN(x.toString());
const SYS = SystemProgram.programId;
const keeper = kp("test-keeper.json");
const oracle = kp("test-oracle.json");

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

async function fund(k: PublicKey, amount = 1000) {
  // identical airdrop transactions in one blockhash are deduplicated: vary the amount by a few lamports
  for (let left = amount, i = 0; left > 0; left -= 1000, i++) await airdrop(connection, k, Math.min(1000, left) * XNT - i);
}
const refusals: Record<string, number> = {};
/** Runs an action that may legitimately be refused; any other failure is a bug. */
async function attempt(label: string, allowed: string[], f: () => Promise<any>): Promise<boolean> {
  for (let i = 0; ; i++) {
    try { await f(); return true; } catch (e: any) {
      const t = errText(e);
      if (allowed.some((a) => errMatches(t, a))) { refusals[label] = (refusals[label] ?? 0) + 1; return false; }
      // A transaction that passed preflight but failed on-chain (the state moved in between, e.g. a round closed a moment
      // later) now comes back with its program error (tests/tx-confirm.cjs). Without that provider it reached us as
      // "Unknown action 'undefined'" with no logs (Anchor 0.32 + web3.js 1.98): it failed, nothing changed on chain, so
      // sending it once more lets the new preflight say why.
      if (i < 2 && /Unknown action/.test(t)) continue;
      throw new Error(`${label} failed unexpectedly: ${t.slice(0, 1500)}`);
    }
  }
}
const cfg = () => acc.config.fetch(P.config);
const ks = () => acc.houseKeeper.fetch(P.keeper);
const xs = () => acc.extraState.fetch(P.extraState);

// ─── the auditor ────────────────────────────────────────────────────────────
const rentCache = new Map<number, bigint>();
const rentFor = async (len: number) => { if (!rentCache.has(len)) rentCache.set(len, BigInt(await T.rentFor(len))); return rentCache.get(len)!; };
const discs = new Map<string, string>((idl.accounts ?? []).map((a: any) => [Buffer.from(a.discriminator).toString("hex"), a.name]));
const SIZES: Record<string, number> = Object.fromEntries((idl.accounts ?? []).map((a: any) => [a.name, 0]));
let audits = 0;
const ledger = { accounted: 0n }; // ExtraState.accounted: start + Σ forge extra − Σ extra claims (this suite)

async function audit(tag: string) {
  const all = await connection.getProgramAccounts(pid, { commitment: "confirmed" });
  const fail = (msg: string) => assert.fail(`[audit ${tag}] ${msg}`);
  let config: any, keeperSeat: any, extra: any, seat: any;
  let epochReserved = 0n, betReserved = 0n, lpShares = 0n, extraReserved = 0n, liveBacking = 0n;
  let v2Bets = 0, drawingV3 = 0, drawingTotal = 0n;
  const counts: Record<string, number> = {};
  const lengths = new Map<string, Set<number>>();
  const refundRounds = new Map<string, bigint>();
  const jpEntries: { round: bigint; amount: bigint }[] = [];
  const predRounds: { pubkey: PublicKey; free: bigint; d: any }[] = [];
  const predEntries: any[] = [];
  const listings: { pubkey: PublicKey; d: any }[] = [];
  for (const { pubkey, account } of all) {
    const name = discs.get(Buffer.from(account.data.subarray(0, 8)).toString("hex"));
    if (!name) { if (account.data.length !== 8) fail(`unknown account ${pubkey.toBase58()} (${account.data.length} B)`); continue; } // the four lamport vaults
    counts[name] = (counts[name] ?? 0) + 1;
    if (!lengths.has(name)) lengths.set(name, new Set());
    lengths.get(name)!.add(account.data.length);
    const d: any = program.coder.accounts.decode(name.charAt(0).toLowerCase() + name.slice(1), account.data);
    const free = BigInt(account.lamports) - (await rentFor(account.data.length));
    const need = (owed: bigint, what: string) => { if (free < owed) fail(`${name} ${pubkey.toBase58()} holds ${free} above rent but owes ${owed} (${what})`); };
    switch (name) {
      case "Config": config = d; break;
      case "Epoch":
        if (!d.closed) {
          epochReserved += big(d.budget) - big(d.claimed);
          if (d.dropState === 1 || d.dropState === 2) { const left = big(d.dropReserve) - big(d.dropPaid); if (left > 0n) epochReserved += left; }
        }
        break;
      case "ExtraEpoch": if (!d.closed) extraReserved += big(d.budget) - big(d.claimed); need(0n, "rent"); break;
      case "ExtraState": extra = d; break;
      case "OracleSeat": seat = d; if (free !== big(d.bond)) fail(`oracle seat holds ${free} above rent, bond ${d.bond}`); break;
      case "HouseKeeper": keeperSeat = d; if (free < big(d.bond)) fail(`keeper seat holds ${free} above rent, below its bond ${d.bond}`); break; // r4-fix: reason-0 forfeits stay above the bond
      case "Bet": betReserved += big(d.payout); if ((d.game & 0x80) !== 0) v2Bets++; need(0n, "rent"); break;
      case "PlayerState": need(big(d.balance), "game balance"); if (big(d.chips) !== 0n) fail(`player ${d.owner.toBase58()} holds ${d.chips} chips (ECO-3)`); break;
      case "Mission": need(big(d.total) - big(d.withdrawn), "unvested + vested-unpaid"); break;
      case "ArtifactRecord": need(big(d.backing), "artifact floor"); if (d.origin === 0) liveBacking += big(d.backing); break;
      case "JackpotRound":
        if (d.state === 0 || d.state === 1) need(big(d.total), "open pot");
        else if (d.state === 3) refundRounds.set(d.id.toString(), free);
        else need(0n, "rent");
        if (d.state === 1 && d.winningTicket.toString() === U64_MAX.toString()) { drawingV3++; drawingTotal += big(d.total); }
        break;
      case "JackpotEntry": jpEntries.push({ round: big(d.round), amount: big(d.amount) }); need(0n, "rent"); break;
      case "Duel": need(big(d.stake) * (d.state === 1 ? 2n : d.state === 0 ? 1n : 0n), "duel stakes"); break;
      case "War": need(big(d.stake) * (d.state === 0 ? 1n : 2n), "war stakes"); break;
      case "PredRound": predRounds.push({ pubkey, free, d }); break;
      case "PredEntry": predEntries.push(d); need(0n, "rent"); break;
      case "HouseShare": lpShares += big(d.shares); break;
      case "Listing": listings.push({ pubkey, d }); need(0n, "rent"); break;
      default: need(0n, "rent");
    }
  }
  if (!config || !keeperSeat || !extra || !seat) fail("config / keeper seat / extra state / oracle seat missing");
  for (const [name, set] of lengths) if (set.size !== 1) fail(`${name} has ${set.size} different lengths: ${[...set].join(", ")}`);
  for (const [name] of lengths) SIZES[name] = [...lengths.get(name)!][0];
  for (const [id, lamports] of refundRounds) {
    const owed = jpEntries.filter((e) => e.round.toString() === id).reduce((a, e) => a + e.amount, 0n);
    if (lamports < owed) fail(`refunded jackpot ${id} holds ${lamports} but owes ${owed} to its entries`);
  }
  for (const { pubkey, free, d } of predRounds) {
    const mine = predEntries.filter((e) => e.round.toString() === d.id.toString());
    if (mine.length !== d.entries - d.claimed) fail(`prediction round ${d.id} has ${mine.length} entries but counts ${d.entries - d.claimed} unclaimed`);
    const totals = d.totals.map((t: any) => big(t));
    let owed = 0n;
    if (d.state === 0 || d.state === 1) owed = totals[0] + totals[1];
    else if (d.state === 3) owed = mine.reduce((a: bigint, e: any) => a + big(e.amount), 0n);
    else for (const e of mine) if (e.side === d.outcome) owed += (big(e.amount) * big(d.prizePool)) / totals[e.side];
    if (free < owed) fail(`prediction round ${pubkey.toBase58()} holds ${free} above rent but owes ${owed}`);
  }
  const reserved = big(config.rewardReserved);
  if (reserved !== epochReserved) fail(`reward_reserved ${reserved} != Σ open epochs ${epochReserved}`);
  if (big(config.bankrollReserved) !== betReserved) fail(`bankroll_reserved ${config.bankrollReserved} != Σ bets ${betReserved}`);
  if (lpShares + big(config.houseProtocolShares) !== big(config.houseTotalShares)) fail(`shares ${lpShares}+${config.houseProtocolShares} != ${config.houseTotalShares}`);
  // keeper (K-3, the chain)
  if (keeperSeat.pendingBets !== v2Bets + drawingV3) fail(`keeper pending_bets ${keeperSeat.pendingBets} != ${v2Bets} v2 bets + ${drawingV3} DRAWING rounds`);
  if (big(keeperSeat.jackpotReserved) !== drawingTotal) fail(`jackpot_reserved ${keeperSeat.jackpotReserved} != Σ DRAWING pots ${drawingTotal}`);
  if (big(keeperSeat.bond) < big(config.bankrollReserved) + big(keeperSeat.jackpotReserved)) fail(`keeper bond ${keeperSeat.bond} < reserved ${config.bankrollReserved} + ${keeperSeat.jackpotReserved}`);
  if (big(keeperSeat.nextIndex) - big(keeperSeat.revealed) !== BigInt(keeperSeat.pendingBets)) fail(`next_index − revealed ${big(keeperSeat.nextIndex) - big(keeperSeat.revealed)} != pending ${keeperSeat.pendingBets}`);
  // extra pot
  if (big(extra.reserved) !== extraReserved) fail(`ExtraState.reserved ${extra.reserved} != Σ open extra epochs ${extraReserved}`);
  if (big(extra.accounted) !== ledger.accounted) fail(`ExtraState.accounted ${extra.accounted} != ledger ${ledger.accounted}`);
  if (big(extra.liveForgedBacking) !== liveBacking) fail(`live_forged_backing ${extra.liveForgedBacking} != Σ live forged floors ${liveBacking}`);
  for (const [v, owed, label] of [[P.reward, reserved, "reward"], [P.bankroll, betReserved, "bankroll"], [P.draw, 0n, "draw"], [P.extraVault, big(extra.accounted), "extra"]] as [PublicKey, bigint, string][]) {
    const info = (await connection.getAccountInfo(v, "confirmed"))!;
    const free = BigInt(info.lamports) - (await rentFor(info.data.length));
    if (free < owed) fail(`${label} vault holds ${free} but owes ${owed}`);
  }
  if (big(extra.accounted) < big(extra.reserved)) fail(`extra accounted ${extra.accounted} < reserved ${extra.reserved}`);
  for (const { pubkey, d } of listings) {
    const a = await connection.getAccountInfo(d.asset, "confirmed");
    const owner = a && a.data.length >= 33 ? new PublicKey(a.data.subarray(1, 33)) : PublicKey.default;
    if (a && owner.equals(d.seller) && !a.data.includes(pubkey.toBuffer())) fail(`listing ${pubkey.toBase58()} is live but the asset's delegate is not the listing`);
  }
  audits++;
  return { config, counts, keeperSeat, extra };
}

// ─── actors ─────────────────────────────────────────────────────────────────
const players = Array.from({ length: 8 }, () => Keypair.generate());
const lps = Array.from({ length: 3 }, () => Keypair.generate());

// ─── house bets and the keeper loop ─────────────────────────────────────────
let chain: KeeperChain;
type Pos = { kind: "bet"; ps: PublicKey; pk: PublicKey; rentPayer: PublicKey } | { kind: "jp"; id: number };
const positions = new Map<string, Pos>();
const keeperStats = { settled: 0, stalled: 0, late: 0, jackpots: 0, refundedRounds: 0 };
async function placeBet(k: Keypair, game: number, param: number, choice: number, stake: number) {
  const ps = P.player(k.publicKey);
  const nonce = (await acc.playerState.fetch(ps)).nonce.toNumber();
  const pk = P.bet(ps, nonce);
  const c = await cfg();
  const ok = await attempt("bet", ["BankrollTooSmall", "InsufficientBalance", "AmountTooSmall", "KeeperBondTooSmall", "DailyLossLimit", "WeeklyLossLimit"], () =>
    methods.placeBetV2(game, BN(param), choice, BN(stake), Array.from(keccak(u64(nonce), k.publicKey.toBuffer()))).accountsPartial({
      config: P.config, playerState: ps, bet: pk, bankrollVault: P.bankroll, rewardVault: P.reward, architect: c.architect, signer: k.publicKey,
      systemProgram: SYS, keeperSeat: P.keeper,
    }).signers([k]).rpc());
  if (ok) positions.set(betUnpack(big((await acc.bet.fetch(pk)).targetSlot)).index.toString(), { kind: "bet", ps, pk, rentPayer: k.publicKey });
  return ok;
}
/** The keeper: reveals every handed-out position in chain order (anchoring bets first); ~2% of bets are stalled on purpose. */
async function keeperPass(stallRate = 0.02) {
  for (;;) {
    const k = await ks();
    if (big(k.revealed) >= big(k.nextIndex)) return;
    const idx = big(k.revealed);
    const reveal = chain.reveal(idx);
    const pos = positions.get(idx.toString());
    if (!pos) { await methods.revealKeeper(Array.from(reveal)).accountsPartial({ keeperSeat: P.keeper, keeper: keeper.publicKey }).signers([keeper]).rpc(); continue; }
    if (pos.kind === "bet") {
      const acct = { config: P.config, bet: pos.pk, playerState: pos.ps, bankrollVault: P.bankroll, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: pos.rentPayer, keeperSeat: P.keeper };
      const balance = async () => big((await acc.playerState.fetch(pos.ps)).balance);
      /** the keeper consumes the position without settling (reveal_keeper), only while it is still the next one */
      const skip = async () => { if (big((await ks()).revealed) === idx) await methods.revealKeeper(Array.from(reveal)).accountsPartial({ keeperSeat: P.keeper, keeper: keeper.publicKey }).signers([keeper]).rpc(); };
      /** refund_stalled_bet: reason 1 pays the full payout (a win), reason 0 the full stake */
      const refund = async (asWin: boolean) => {
        const bet = await acc.bet.fetch(pos.pk);
        const b0 = await balance();
        await methods.refundStalledBet().accountsPartial({ ...acct, rewardVault: P.reward }).rpc();
        expect(await acc.bet.fetchNullable(pos.pk), "a refunded bet is closed").to.equal(null);
        expect((await balance()) - b0, asWin ? "a stalled bet pays its full payout" : "an expired unanchored bet refunds its stake").to.equal(asWin ? big(bet.payout) : big(bet.stake));
      };
      let bet = await acc.bet.fetchNullable(pos.pk);
      if (!bet) { await skip(); continue; }
      if ((bet.game & 0x40) === 0) {
        await T.waitPastSlot(betUnpack(big(bet.targetSlot)).anchor);
        let expired = false;
        await retry(["NotReady"], () => methods.anchorBet().accountsPartial({ bet: pos.pk, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).rpc()).catch((e: any) => {
          if (!errMatches(errText(e), "BetStalled")) throw e;
          expired = true; // its block left SlotHashes: reason 0
        });
        if (expired) { await refund(false); await skip(); keeperStats.stalled++; continue; }
      }
      if (rand() < stallRate) {
        // K-2 b: the keeper skips the position on purpose; the bet is refundable at once and paid as a win
        await skip();
        await refund(true);
        keeperStats.stalled++;
        continue;
      }
      bet = await acc.bet.fetch(pos.pk);
      const b0 = await balance();
      try {
        await methods.settleBetV2(Array.from(reveal)).accountsPartial(acct).rpc();
      } catch (e: any) {
        // revealed after anchor + KEEPER_STALL_SLOTS (40 slots on localnet): refund-only, paid as a win (K-2 a)
        if (!errMatches(errText(e), "BetStalled") && !/Unknown action/.test(errText(e))) throw e;
        if (await acc.bet.fetchNullable(pos.pk)) { await refund(true); await skip(); keeperStats.late++; continue; }
      }
      const roll = rnd(reveal, pos.pk.toBuffer(), Buffer.from(bet.seed)) % 10_000n;
      const won = isWin(bet.game & 0x3f, bet.choice, big(bet.chanceBps), roll);
      expect((await balance()) - b0, "v2 roll mirror").to.equal(won ? big(bet.payout) : 0n);
      keeperStats.settled++;
    } else {
      const r = await acc.jackpotRound.fetch(P.jackpot(pos.id));
      const { anchor } = betUnpack(big(r.targetSlot));
      await T.waitPastSlot(anchor);
      const h = (await T.slotHashAtOrAfter(anchor))!;
      const ticket = jackpotTicketV2(h, reveal, P.jackpot(pos.id), pos.id, big(r.total));
      let done = false;
      for (let i = 0; i < r.entries && !done; i++) {
        const e = await acc.jackpotEntry.fetch(P.jpEntry(pos.id, i));
        if (ticket >= big(e.start) && ticket < big(e.start) + big(e.amount)) {
          await methods.settleJackpotV2(Array.from(reveal)).accountsPartial({
            config: P.config, round: P.jackpot(pos.id), entry: P.jpEntry(pos.id, i), winnerState: P.player(e.player), rewardVault: P.reward, drawVault: P.draw,
            architect: (await cfg()).architect, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, keeperSeat: P.keeper,
          }).rpc();
          done = true;
        }
      }
      if (!done) assert.fail("no winning jackpot entry");
      await closeEntries(pos.id);
      keeperStats.jackpots++;
    }
  }
}
async function closeEntries(id: number) {
  const r = await acc.jackpotRound.fetch(P.jackpot(id));
  for (let i = 0; i < r.entries; i++) {
    const e = await acc.jackpotEntry.fetchNullable(P.jpEntry(id, i));
    if (!e) continue;
    await methods.closeJackpotEntry().accountsPartial({ round: P.jackpot(id), playerState: P.player(e.player), entry: P.jpEntry(id, i), rentPayer: e.rentPayer }).rpc();
  }
}
async function runJackpot() {
  const id = (await cfg()).jackpotRound.toNumber();
  const round = await acc.jackpotRound.fetchNullable(P.jackpot(id));
  if (!round || round.endTs.toNumber() === 0) return;
  await retry(["RoundRunning"], () => methods.drawJackpot().accountsPartial({ config: P.config, round: P.jackpot(id), firstPlayerState: P.player(round.firstPlayer), keeperSeat: P.keeper }).rpc());
  const r = await acc.jackpotRound.fetch(P.jackpot(id));
  if (r.state === 1) positions.set(betUnpack(big(r.targetSlot)).index.toString(), { kind: "jp", id });
  else if (r.state === 3) { await closeEntries(id); keeperStats.refundedRounds++; } // no capacity: refunded at once (reason 3)
  else await closeEntries(id); // single player: refunded in full
}

// ─── Artifacts and the market ───────────────────────────────────────────────
const owned = new Map<string, { asset: PublicKey; tier: number; owner: Keypair }>();
const market = { forged: 0, recycled: 0, listed: 0, sold: 0, delisted: 0 };
async function forge(k: Keypair, tier: number) {
  const c = await cfg();
  const serial = c.artifactsMinted[tier];
  const asset = P.asset(tier, serial);
  let sig = "";
  const ok = await attempt("forge", ["SoldOut", "InvalidTarget"], async () => {
    sig = await methods.forgeArtifact(tier, serial, U64_MAX).accountsPartial({
      config: P.config, asset, record: P.artifact(asset), collection: P.collection, artifactAuthority: P.authority, rewardVault: P.reward, drawVault: P.draw,
      architect: c.architect, buyer: k.publicKey, coreProgram: MPL_CORE, systemProgram: SYS, extraState: P.extraState, extraVault: P.extraVault,
    }).signers([k]).rpc();
  });
  if (!ok) return null;
  const info = await T.txInfo(sig);
  const price = big(T.event(info.events, "ArtifactForged").price);
  expect([0, -1, 1].some((d) => currentPrice(c, tier, info.blockTime + d) === price), `PX mirror tier ${tier}: paid ${price}`).to.equal(true);
  ledger.accounted += forgeSplit(price).extra;
  owned.set(asset.toBase58(), { asset, tier, owner: k });
  market.forged++;
  return asset;
}
async function recycle(a: { asset: PublicKey; owner: Keypair }) {
  await methods.recycleArtifact().accountsPartial({
    config: P.config, asset: a.asset, record: P.artifact(a.asset), collection: P.collection, owner: a.owner.publicKey, coreProgram: MPL_CORE, systemProgram: SYS, extraState: P.extraState,
  }).signers([a.owner]).rpc();
  owned.delete(a.asset.toBase58());
  market.recycled++;
}
async function tradeRound() {
  const items = [...owned.values()];
  if (!items.length) return;
  const it = pick(items);
  const rec = await acc.artifactRecord.fetch(P.artifact(it.asset));
  const price = minListPrice(big(rec.backing)) + BigInt(between(0, 30)) * 10_000_000n;
  const now = await T.chainTime();
  await methods.listArtifact(BN(price), BN(now + 60), PublicKey.default, false).accountsPartial({
    config: P.config, listing: P.listing(it.asset), asset: it.asset, record: P.artifact(it.asset), collection: P.collection, seller: it.owner.publicKey, coreProgram: MPL_CORE, systemProgram: SYS,
  }).signers([it.owner]).rpc();
  market.listed++;
  await audit("listing open");
  const roll = rand();
  if (roll < 0.6) {
    const buyer = pick(players.filter((p) => !p.publicKey.equals(it.owner.publicKey)));
    const c = await cfg();
    const pool0 = big(await bal(P.reward));
    await methods.buyArtifact(BN(price)).accountsPartial({
      config: P.config, listing: P.listing(it.asset), asset: it.asset, record: P.artifact(it.asset), collection: P.collection, buyer: buyer.publicKey, seller: it.owner.publicKey,
      architect: c.architect, rewardVault: P.reward, coreProgram: MPL_CORE, systemProgram: SYS,
    }).signers([buyer]).rpc();
    const sp = marketSplit(price);
    const toPool = c.architect.equals(P.reward) ? sp.pool + sp.royalty : sp.pool;
    expect(big(await bal(P.reward)) - pool0, "market pool fee").to.equal(toPool);
    owned.set(it.asset.toBase58(), { ...it, owner: buyer });
    market.sold++;
  } else if (roll < 0.8) {
    await methods.delistArtifact().accountsPartial({ config: P.config, listing: P.listing(it.asset), asset: it.asset, collection: P.collection, seller: it.owner.publicKey, coreProgram: MPL_CORE, systemProgram: SYS }).signers([it.owner]).rpc();
    market.delisted++;
  } else {
    await recycle(it); // recycled while listed: anyone closes the stale listing
    await methods.closeListing().accountsPartial({ config: P.config, listing: P.listing(it.asset), seller: it.owner.publicKey, asset: it.asset, collection: P.collection }).rpc();
    market.delisted++;
  }
}

// ─── epochs: base + extra, claims after the hold, voids with a bond ──────────
type Claim = { kind: "base" | "extra"; n: number; i: number; p: PublicKey; s: bigint; proof: number[][]; at: number };
const claims: Claim[] = [];
const epochs = { base: 0, extra: 0, voids: 0, claimed: 0, skipped: 0 };
async function epochRound() {
  const c = await cfg();
  if (!c.oracle.equals(oracle.publicKey)) return;
  const now = await T.chainTime();
  if (c.lastPublishTs.toNumber() + L.MIN_EPOCH_INTERVAL < now) {
    const n = c.lastEpoch.toNumber() + 1;
    const leaves = players.filter(() => rand() < 0.5).slice(0, 4).map((k) => ({ p: k.publicKey, t: 0, s: BigInt(between(1, 1000)) }));
    if (leaves.length) {
      const total = leaves.reduce((a, l) => a + l.s, 0n);
      const tr = tree(leaves.map((l) => claimLeaf(n, l.p, l.t, l.s)));
      const ok = await attempt("publish", ["EpochTooSoon", "PoolEmpty"], () => methods.publishEpoch(BN(n), Array.from(tr.root), Array.from(Buffer.alloc(32, n % 256)), BN(total), leaves.length, BN(1_000_000_000_000n))
        .accountsPartial({ config: P.config, epoch: P.epoch(n), rewardVault: P.reward, oracle: oracle.publicKey, systemProgram: SYS }).signers([oracle]).rpc());
      if (ok) {
        epochs.base++;
        const e = await acc.epoch.fetch(P.epoch(n));
        expect(e.dropReserve.toNumber(), "publish_epoch writes reserve 0").to.equal(0);
        leaves.forEach((l, i) => claims.push({ kind: "base", n, i, p: l.p, s: l.s, proof: tr.proof(i), at: e.publishedAt.toNumber() }));
        if (rand() < 0.15) { // someone voids it inside the hold
          const voider = pick(players);
          if (await attempt("void", ["HoldOver"], () => methods.voidEpoch(BN(n), BN(voidBond(big(e.budget)))).accountsPartial({
            config: P.config, epoch: P.epoch(n), seat: P.seat, rewardVault: P.reward, voider: voider.publicKey, systemProgram: SYS,
          }).signers([voider]).rpc())) epochs.voids++;
        }
      }
    }
  }
  const x = await xs();
  const c2 = await cfg();
  const n = x.lastEpoch.toNumber() + 1;
  if (n <= c2.lastEpoch.toNumber()) {
    const free = big(x.accounted) - big(x.reserved), backing = big(x.liveForgedBacking) + big(x.outSincePublish);
    const a = (free * 800n) / 10_000n, b = (backing * 400n) / 10_000n;
    const bound = a < b ? a : b;
    const real = x.lastPublishTs.toNumber() + L.MIN_EPOCH_INTERVAL < (await T.chainTime()) && bound > 2_000_000n;
    const wallets = real ? players.filter(() => rand() < 0.4).slice(0, 4) : [];
    const total = wallets.length ? (bound * BigInt(between(10, 100))) / 100n : 0n;
    const amounts = wallets.map(() => (total / BigInt(Math.max(1, wallets.length))) - 1n);
    const tr = wallets.length ? tree(wallets.map((w, i) => extraLeaf(n, i, w.publicKey, amounts[i]))) : { root: Buffer.alloc(32), proof: () => [] };
    const ok = await attempt("extra", ["ExtraEpochOrder"], () => methods.publishExtraEpoch(BN(n), Array.from(tr.root), Array.from(Buffer.alloc(32, 7)), BN(wallets.length ? total : 0n), wallets.length, 1)
      .accountsPartial({ config: P.config, extraState: P.extraState, extraEpoch: P.extraEpoch(n), baseEpoch: P.epoch(n), prevEpoch: P.epoch(Math.max(1, n - 1)), oracle: oracle.publicKey, systemProgram: SYS })
      .signers([oracle]).rpc());
    if (ok) {
      epochs.extra++;
      const xe = await acc.extraEpoch.fetch(P.extraEpoch(n));
      wallets.forEach((w, i) => claims.push({ kind: "extra", n, i, p: w.publicKey, s: amounts[i], proof: tr.proof(i), at: xe.publishedAt.toNumber() }));
      if (wallets.length && rand() < 0.1) {
        const voider = pick(players), e = await acc.epoch.fetch(P.epoch(n));
        const full = big(xe.budget) > big(e.budget) ? big(xe.budget) : big(e.budget);
        if (await attempt("void-extra", ["HoldOver"], () => methods.voidExtraEpoch(BN(n), BN(voidBond(full))).accountsPartial({
          config: P.config, extraState: P.extraState, extraEpoch: P.extraEpoch(n), epoch: P.epoch(n), seat: P.seat, rewardVault: P.reward, voider: voider.publicKey, systemProgram: SYS,
        }).signers([voider]).rpc())) epochs.voids++;
      }
    }
  }
}
async function claimRound() {
  const now = await T.chainTime();
  for (const cl of claims.splice(0)) {
    if (now < cl.at + L.CLAIM_HOLD + 1) { claims.push(cl); continue; }
    const submitter = pick([...players, payer]);
    if (cl.kind === "base") {
      const e = await acc.epoch.fetch(P.epoch(cl.n));
      if (e.closed) { epochs.skipped++; continue; }
      const ok = await attempt("claim", ["ClaimOnHold", "AmountTooSmall"], () => methods.claimInstant(BN(cl.n), 0, BN(cl.s), cl.proof).accountsPartial({
        config: P.config, epoch: P.epoch(cl.n), receipt: P.receipt(cl.n, cl.p, 0), player: cl.p, playerState: P.player(cl.p), rewardVault: P.reward,
        payer: submitter.publicKey, systemProgram: SYS,
      }).signers(submitter === payer ? [] : [submitter]).rpc());
      if (ok) epochs.claimed++;
    } else {
      const xe = await acc.extraEpoch.fetch(P.extraEpoch(cl.n));
      if (xe.closed) { epochs.skipped++; continue; }
      const ok = await attempt("claim-extra", ["ClaimOnHold"], () => methods.claimExtra(BN(cl.n), cl.i, BN(cl.s), cl.proof).accountsPartial({
        config: P.config, extraState: P.extraState, extraEpoch: P.extraEpoch(cl.n), extraVault: P.extraVault, wallet: cl.p, payer: submitter.publicKey, systemProgram: SYS,
      }).signers(submitter === payer ? [] : [submitter]).rpc());
      if (ok) { ledger.accounted -= cl.s; epochs.claimed++; }
    }
  }
}

// ─── sealed duels and Moon Wars (no tickets) ────────────────────────────────
const duels = { resolved: 0, lapsed: 0, cancelled: 0 };
/**
 * The joiner opens its sealed element (reveal_duel_join), retried while it is still the join's own second (NotReady).
 * r6-fix (run-local seed 42, 2026-10-31): on a loaded validator the opening can land after the compressed 4-s
 * DUEL_JOIN_REVEAL_WINDOW (DeadlinePassed, p2p.rs reveal_duel_join). The program is right to refuse it; the duel then
 * ends as a sealed join never opened: claim_duel_timeout refunds the creator and sends the joiner's stake to the pool
 * (the same path as a joiner that never opens). Returns true when the join was opened, false when it lapsed.
 */
async function openDuelJoin(a: Keypair, b: Keypair, duel: PublicKey, element: number, jsalt: Buffer): Promise<boolean> {
  const opened = await attempt("duel-join-reveal", ["DeadlinePassed"], () =>
    retry(["NotReady"], () => methods.revealDuelJoin(element, Array.from(jsalt)).accountsPartial({ duel, opponent: b.publicKey }).signers([b]).rpc()));
  if (opened) return true;
  await retry(["DeadlineNotReached"], async () => methods.claimDuelTimeout().accountsPartial({
    config: P.config, duel, creatorState: P.player(a.publicKey), opponentState: P.player(b.publicKey), rewardVault: P.reward, drawVault: P.draw,
    architect: (await cfg()).architect, rentPayer: a.publicKey,
  }).rpc());
  duels.lapsed++;
  return false;
}
async function duelRound() {
  const [a, b] = [pick(players), pick(players)];
  if (a === b) return;
  const nonce = (await acc.playerState.fetch(P.player(a.publicKey))).nonce.toNumber();
  const duel = P.duel(a.publicKey, nonce);
  const ce = between(0, 3), oe = between(0, 3);
  const salt = keccak(duel.toBuffer(), Buffer.from("c")), jsalt = keccak(duel.toBuffer(), Buffer.from("j"));
  const stake = between(1, 20) * XNT / 10;
  const created = await attempt("duel", ["InsufficientBalance"], () => methods.createDuel(BN(stake), Array.from(keccak(Buffer.from("MOONFORGE_DUEL"), Buffer.from([ce]), salt, duel.toBuffer())))
    .accountsPartial({ config: P.config, creatorState: P.player(a.publicKey), duel, owner: a.publicKey, asset: SYS, record: SYS, collection: SYS, systemProgram: SYS }).signers([a]).rpc());
  if (!created) return;
  const resolve = async () => ({ config: P.config, duel, creatorState: P.player(a.publicKey), opponentState: P.player(b.publicKey), rewardVault: P.reward, drawVault: P.draw, architect: (await cfg()).architect, rentPayer: a.publicKey });
  const joined = rand() < 0.85 && await attempt("duel-join", ["InsufficientBalance"], () => methods.joinDuelSealed(Array.from(keccak(Buffer.from("MOONFORGE_DUEL_JOIN"), Buffer.from([oe]), jsalt, duel.toBuffer(), b.publicKey.toBuffer())))
    .accountsPartial({ config: P.config, duel, opponentState: P.player(b.publicKey), opponent: b.publicKey, asset: SYS, record: SYS, collection: SYS }).signers([b]).rpc());
  if (!joined) {
    await methods.cancelDuel().accountsPartial({ duel, creatorState: P.player(a.publicKey), creator: a.publicKey }).signers([a]).rpc();
    duels.cancelled++;
    return;
  }
  if (rand() < 0.15) { // the joiner never opens: the creator is refunded, the joiner's stake goes to the pool
    await retry(["DeadlineNotReached"], async () => methods.claimDuelTimeout().accountsPartial(await resolve()).rpc());
    duels.lapsed++;
    return;
  }
  if (!(await openDuelJoin(a, b, duel, oe, jsalt))) return; // opened too late: lapsed as an unopened join (see openDuelJoin)
  const sum0 = big((await acc.playerState.fetch(P.player(a.publicKey))).balance) + big((await acc.playerState.fetch(P.player(b.publicKey))).balance);
  if (rand() < 0.8 && await attempt("duel-reveal", ["DeadlinePassed"], async () => methods.revealDuel(ce, Array.from(salt)).accountsPartial({ resolve: await resolve(), creator: a.publicKey }).signers([a]).rpc())) {
    duels.resolved++;
  } else {
    await retry(["DeadlineNotReached"], async () => methods.claimDuelTimeout().accountsPartial(await resolve()).rpc());
    duels.lapsed++;
  }
  const sum1 = big((await acc.playerState.fetch(P.player(a.publicKey))).balance) + big((await acc.playerState.fetch(P.player(b.publicKey))).balance);
  const pot = 2n * BigInt(stake);
  expect([pot, pot - pot / 50n]).to.deep.include(sum1 - sum0); // a draw refunds both; otherwise the pot minus the 2% rake
}
const WAR_CARD = [[2, 2, 1], [4, 3, 2], [6, 4, 3], [10, 10, 5]];
const wars = { finished: 0, timeouts: 0, draws: 0, cancelled: 0 };
async function warRound() {
  const [a, b] = [pick(players), pick(players)];
  if (a === b) return;
  const nonce = (await acc.playerState.fetch(P.player(a.publicKey))).nonce.toNumber();
  const war = P.war(a.publicKey, nonce);
  const stake = between(1, 20) * XNT / 10;
  const entropy = keccak(war.toBuffer(), Buffer.from("e")), secret = keccak(war.toBuffer(), Buffer.from("s"));
  const created = await attempt("war", ["InsufficientBalance"], () => methods.createWarSealed(BN(stake), PublicKey.default, Array.from(keccak(Buffer.from("MOONFORGE_WAR_ENTROPY"), entropy, war.toBuffer())))
    .accountsPartial({ config: P.config, creatorState: P.player(a.publicKey), war, owner: a.publicKey, asset: SYS, record: SYS, collection: SYS, systemProgram: SYS }).signers([a]).rpc());
  if (!created) return;
  const joined = rand() < 0.85 && await attempt("war-join", ["InsufficientBalance"], () => methods.joinWarSealed(Array.from(keccak(Buffer.from("MOONFORGE_WAR_JOIN"), secret, war.toBuffer(), b.publicKey.toBuffer(), PublicKey.default.toBuffer())))
    .accountsPartial({ config: P.config, war, opponentState: P.player(b.publicKey), opponent: b.publicKey, asset: SYS, record: SYS, collection: SYS }).signers([b]).rpc());
  if (!joined) {
    await methods.cancelWar().accountsPartial({ war, creatorState: P.player(a.publicKey), creator: a.publicKey }).signers([a]).rpc();
    wars.cancelled++;
    return;
  }
  const timeout = () => retry(["DeadlineNotReached"], () => methods.claimWarTimeout().accountsPartial({ war }).rpc());
  const lapse = rand();
  if (lapse < 0.08) await timeout(); // the creator never seeds: a draw
  else {
    await methods.seedWar(Array.from(entropy)).accountsPartial({ war, signer: a.publicKey }).signers([a]).rpc();
    if (lapse < 0.15) await timeout(); // the joiner never reveals: the creator wins
    // r6-fix (run-local seed 42, 2026-10-27): on a loaded validator the reveal can land after the compressed reveal
    // deadline (DeadlinePassed, wars.rs reveal_war). The program is right to refuse it; the round then ends as a joiner
    // that never revealed (the creator wins by timeout), as the duel reveal and the war moves below already allow.
    else if (!(await attempt("war-reveal", ["DeadlinePassed"], () => methods.revealWar(Array.from(secret), PublicKey.default).accountsPartial({ war, signer: b.publicKey }).signers([b]).rpc()))) await timeout();
    else {
      const keys = [a, b];
      const abandonAfter = rand() < 0.2 ? between(0, 12) : Infinity;
      for (let moves = 0; ; moves++) {
        const s = await acc.war.fetch(war);
        if (s.state === 3) break;
        if (moves >= abandonAfter || moves > 600) { await timeout(); break; }
        const k = keys[s.turn], me = s.sides[s.turn], foe = s.sides[1 - s.turn];
        const mv = (m: any, signer = k) => m.accountsPartial({ war, signer: signer.publicKey }).signers([signer]).rpc();
        if (rand() < 0.04) {
          const illegal = rand() < 0.5 ? () => mv(methods.warAttack(9, 0)) : () => mv(methods.warEndTurn(), keys[1 - s.turn]);
          expect(await attempt("war-illegal", ["InvalidMove", "NotYourTurn"], illegal), "an illegal Moon Wars move was accepted").to.equal(false);
          continue;
        }
        const cards = Array.from({ length: me.handLen }, (_, i) => i).filter((i) => WAR_CARD[me.hand[i]][2] <= me.mana);
        const ready = Array.from({ length: me.fieldLen }, (_, i) => i).filter((i) => me.field[i].ready);
        const roll = rand();
        let m: any;
        if (cards.length && me.fieldLen < 6 && roll < 0.6) m = methods.warSummon(pick(cards));
        else if (ready.length && roll < 0.95) m = methods.warAttack(pick(ready), foe.fieldLen ? between(0, foe.fieldLen - 1) : 255);
        else m = methods.warEndTurn();
        if (!(await attempt("war-move", ["DeadlinePassed"], () => mv(m)))) { await timeout(); break; }
      }
    }
  }
  const d = await acc.war.fetch(war);
  const ps = [P.player(a.publicKey), P.player(b.publicKey)];
  const sum = async () => big((await acc.playerState.fetch(ps[0])).balance) + big((await acc.playerState.fetch(ps[1])).balance);
  const before = await sum();
  await methods.settleWar().accountsPartial({
    config: P.config, war, creatorState: ps[0], opponentState: ps[1], rewardVault: P.reward, drawVault: P.draw, architect: (await cfg()).architect, rentPayer: a.publicKey,
  }).rpc();
  const pot = 2n * BigInt(stake);
  expect((await sum()) - before, "Moon Wars payout").to.equal(d.draw ? pot : pot - pot / 50n);
  wars[d.draw ? "draws" : d.timeout ? "timeouts" : "finished"]++;
}

// ─── Predictions v2 (120-s rounds on localnet; entries close 35 s in) ────────
const predBets = new Map<number, Keypair[]>();
const preds = { settled: 0, refunded: 0, entries: 0 };
async function predictionEntries() {
  const now = await T.chainTime();
  if (now % L.PRED_PERIOD >= 30) return;
  const id = Math.floor(now / L.PRED_PERIOD);
  for (const k of players.filter(() => rand() < 0.4)) {
    if (predBets.get(id)?.includes(k)) continue;
    const ok = await attempt("prediction", ["InsufficientBalance", "PotFull", "PredState"], () => methods.enterPrediction(BN(id), between(0, 1), BN(between(1, 20) * XNT / 10))
      .accountsPartial({ round: P.pred(id), entry: P.predEntry(id, k.publicKey), playerState: P.player(k.publicKey), owner: k.publicKey, systemProgram: SYS }).signers([k]).rpc());
    if (ok) { predBets.set(id, [...(predBets.get(id) ?? []), k]); preds.entries++; }
  }
}
async function progressPredictions(): Promise<boolean> {
  for (const [id, entrants] of predBets) {
    const pk = P.pred(id);
    let r = await acc.predRound.fetch(pk);
    if (r.state === 0) await attempt("pred-lock", ["RoundRunning"], () => methods.lockPrediction().accountsPartial({ round: pk, observation: OBS }).rpc());
    r = await acc.predRound.fetch(pk);
    if (r.state === 1) await attempt("pred-settle", ["RoundRunning"], async () => methods.settlePrediction().accountsPartial({
      config: P.config, round: pk, observation: OBS, rewardVault: P.reward, drawVault: P.draw, architect: (await cfg()).architect,
    }).rpc());
    r = await acc.predRound.fetch(pk);
    if (r.state < 2) continue;
    await audit(`prediction ${id} resolved`);
    for (const k of entrants.splice(0)) {
      await methods.claimPrediction().accountsPartial({ config: P.config, round: pk, entry: P.predEntry(id, k.publicKey), playerState: P.player(k.publicKey), rentPayer: k.publicKey }).rpc();
    }
    await methods.closePredictionRound().accountsPartial({ config: P.config, round: pk, rewardVault: P.reward, rentPayer: r.rentPayer }).rpc();
    preds[r.state === 2 ? "settled" : "refunded"]++;
    predBets.delete(id);
  }
  return predBets.size === 0;
}

async function freeBankroll() {
  const c = await cfg();
  const info = (await connection.getAccountInfo(P.bankroll))!;
  return info.lamports - Number(await rentFor(info.data.length)) - c.bankrollReserved.toNumber();
}
/** Largest stake the exposure cap allows for a payout multiplier (in bps). */
async function maxStake(payoutBps: number) {
  return Math.floor(((await freeBankroll()) * 25) / 10_000 / (payoutBps / 10_000 - 1));
}

const HOUSE_WITHDRAW_WINDOW = 60; // localnet (constants.rs): a request is usable for 60 s after its 1-s delay
/**
 * One LP's exit after its withdrawal request (house_withdraw, retried while the 1-s delay runs: WithdrawLocked).
 * r6-fix (run-local seed 42, 2026-10-31): on a loaded validator the bank run's audits between the exits can take longer
 * than the 60-s localnet HOUSE_WITHDRAW_WINDOW, and the program refuses the stale request (WithdrawExpired: "request
 * again"). The LP then requests the same shares again and withdraws, as a real one would. Returns true when it renewed.
 */
async function lpExit(k: Keypair): Promise<boolean> {
  const signers = k === payer ? [] : [k];
  const withdraw = () => methods.houseWithdraw(BN(0)).accountsPartial({ config: P.config, share: P.house(k.publicKey), bankrollVault: P.bankroll, owner: k.publicKey }).signers(signers).rpc();
  try { await retry(["WithdrawLocked"], withdraw); return false; } catch (e: any) { if (!errMatches(errText(e), "WithdrawExpired")) throw e; }
  const s = await acc.houseShare.fetch(P.house(k.publicKey));
  await methods.houseRequestWithdraw(s.pendingShares).accountsPartial({ share: P.house(k.publicKey), owner: k.publicKey }).signers(signers).rpc();
  await retry(["WithdrawLocked"], withdraw);
  return true;
}

describe("Moon Forge v3 — stress & solvency audit", () => {
  before(async () => {
    await fund(payer.publicKey, 5000);
    await fund(keeper.publicKey, 3000);
    await fund(oracle.publicKey, 100); // pays the epoch account rents
    for (const k of [...players, ...lps]) await fund(k.publicKey, 500);
    if (!(await connection.getAccountInfo(P.config))) {
      // run alone on a fresh validator: the S7 first-run steps (permissionless or test-keyed)
      await methods.initializeV2().accountsPartial({ config: P.config, rewardVault: P.reward, bankrollVault: P.bankroll, drawVault: P.draw, collection: P.collection, artifactAuthority: P.authority, payer: payer.publicKey, systemProgram: SYS }).rpc();
      await methods.donate(0, BN(200 * XNT)).accountsPartial({ config: P.config, donor: payer.publicKey, vault: P.reward, systemProgram: SYS }).rpc();
      await methods.initArtifacts().accountsPartial({ config: P.config, collection: P.collection, artifactAuthority: P.authority, payer: payer.publicKey, coreProgram: MPL_CORE, systemProgram: SYS }).rpc();
      await methods.initSeat().accountsPartial({ config: P.config, seat: P.seat, rewardVault: P.reward, payer: payer.publicKey, systemProgram: SYS }).rpc();
      await methods.initExtra().accountsPartial({ config: P.config, extraState: P.extraState, extraVault: P.extraVault, payer: payer.publicKey, systemProgram: SYS }).rpc();
    }
    // the keeper arms a fresh chain with a deep bond (nothing may be pending)
    expect((await ks().catch(() => ({ pendingBets: 0 }))).pendingBets).to.equal(0);
    chain = new KeeperChain(keccak(Buffer.from("stress-chain"), u64(SEED)), 6000);
    await methods.armKeeper(Array.from(chain.tip), BN(chain.length), BN(1500 * XNT)).accountsPartial({
      config: P.config, keeperSeat: P.keeper, keeper: keeper.publicKey, bankrollVault: P.bankroll, rewardVault: P.reward, systemProgram: SYS,
    }).signers([keeper]).rpc();
    ledger.accounted = big((await xs()).accounted);
    await audit("start");
    for (const k of lps) await methods.houseDeposit(BN(between(50, 200) * XNT), BN(0)).accountsPartial({ config: P.config, share: P.house(k.publicKey), bankrollVault: P.bankroll, owner: k.publicKey, systemProgram: SYS }).signers([k]).rpc();
    for (const k of players) {
      if (!(await connection.getAccountInfo(P.player(k.publicKey)))) await methods.openPlayer().accountsPartial({ playerState: P.player(k.publicKey), owner: k.publicKey, systemProgram: SYS }).signers([k]).rpc();
      await methods.deposit(BN(between(20, 80) * XNT)).accountsPartial({ playerState: P.player(k.publicKey), payer: k.publicKey, systemProgram: SYS }).signers([k]).rpc();
      await forge(k, pick([0, 0, 1, 1, 2]));
    }
    await audit("setup");
  });

  it(`random play (${ROUNDS} rounds, seed ${SEED}) never breaks an invariant`, async () => {
    const c0 = await cfg();
    for (let r = 0; r < ROUNDS; r++) {
      // the keeper reveals promptly (KEEPER_STALL_SLOTS is 40 slots on localnet); the last player's bets stay pending for the audit
      for (const [pi, k] of players.entries()) {
        for (let n = between(0, 3); n > 0; n--) {
          const game = pick([0, 1, 2]);
          const param = game === 1 ? between(100, 9500) : game === 2 ? pick([10_500, 20_000, 50_000, 100_000, 1_000_000]) : 0;
          await placeBet(k, game, param, between(0, 1), Math.floor(0.01 * XNT * Math.pow(500, rand())));
        }
        if (pi < players.length - 1) await keeperPass();
      }
      // an attacker tries 2x the exposure cap on a 100x Void Rush: always refused
      const greedy = players[r % players.length];
      const over = (await maxStake(1_000_000)) * 2 + 1;
      if (over >= 10_000_000) {
        const ps = P.player(greedy.publicKey);
        const nonce = (await acc.playerState.fetch(ps)).nonce.toNumber();
        let refused = "";
        try {
          await methods.placeBetV2(2, BN(1_000_000), 0, BN(over), Array(32).fill(1)).accountsPartial({
            config: P.config, playerState: ps, bet: P.bet(ps, nonce), bankrollVault: P.bankroll, rewardVault: P.reward, architect: (await cfg()).architect,
            signer: greedy.publicKey, systemProgram: SYS, keeperSeat: P.keeper,
          }).signers([greedy]).rpc();
        } catch (e: any) { refused = errText(e); }
        expect(refused, "an over-cap bet was accepted").to.match(/BankrollTooSmall|InsufficientBalance|KeeperBondTooSmall|DailyLossLimit|WeeklyLossLimit/);
      }
      // jackpot entries (20 XNT cap)
      const jp = (await cfg()).jackpotRound.toNumber();
      for (const k of players.filter(() => rand() < 0.4)) {
        const round = await acc.jackpotRound.fetchNullable(P.jackpot(jp));
        const idx = round ? round.entries : 0;
        await attempt("jackpot", ["InsufficientBalance", "RoundNotOpen", "PotFull"], () => methods.enterJackpot(BN(jp), idx, BN(Math.floor(between(1, 30) * XNT / 10)))
          .accountsPartial({ config: P.config, round: P.jackpot(jp), entry: P.jpEntry(jp, idx), playerState: P.player(k.publicKey), signer: k.publicKey, systemProgram: SYS }).signers([k]).rpc());
      }
      await predictionEntries();
      if (rand() < 0.6) { const k = pick(players); const a = await forge(k, pick([0, 0, 0, 1])); if (a && rand() < 0.4) await recycle(owned.get(a.toBase58())!); }
      if (rand() < 0.5) await tradeRound();
      await epochRound();
      // LPs come and go (24 "hours" = 1 s on localnet)
      for (const k of lps) {
        const s = await acc.houseShare.fetchNullable(P.house(k.publicKey));
        const roll = rand();
        if (s && s.pendingShares.toNumber() > 0) {
          await attempt("lp-withdraw", ["WithdrawLocked", "SlippageExceeded", "WithdrawExpired"], () => methods.houseWithdraw(BN(0)).accountsPartial({ config: P.config, share: P.house(k.publicKey), bankrollVault: P.bankroll, owner: k.publicKey }).signers([k]).rpc());
        } else if (s && s.shares.toNumber() > 0 && roll < 0.3) {
          await methods.houseRequestWithdraw(BN(Math.max(1, Math.floor(s.shares.toNumber() * rand())))).accountsPartial({ share: P.house(k.publicKey), owner: k.publicKey }).signers([k]).rpc();
        } else if (roll > 0.8) {
          await attempt("lp-deposit", ["SlippageExceeded"], () => methods.houseDeposit(BN(between(1, 40) * XNT), BN(0)).accountsPartial({ config: P.config, share: P.house(k.publicKey), bankrollVault: P.bankroll, owner: k.publicKey, systemProgram: SYS }).signers([k]).rpc());
        }
      }
      const k = pick(players);
      const b = (await acc.playerState.fetch(P.player(k.publicKey))).balance.toNumber();
      if (b > 0 && rand() < 0.5) await methods.withdraw(BN(Math.max(1, Math.floor(b * rand())))).accountsPartial({ playerState: P.player(k.publicKey), owner: k.publicKey }).signers([k]).rpc();
      else await methods.deposit(BN(between(1, 10) * XNT)).accountsPartial({ playerState: P.player(k.publicKey), payer: k.publicKey, systemProgram: SYS }).signers([k]).rpc();

      await audit(`round ${r} (bets pending)`);
      await keeperPass();
      await runJackpot();
      await keeperPass();
      if (rand() < 0.7) await duelRound();
      if (rand() < 0.5) await warRound();
      await claimRound();
      await progressPredictions();
      await audit(`round ${r} (settled)`);
    }
    // the run ends with every prediction round resolved and closed, every claim made, nothing open
    for (let i = 0; !(await progressPredictions()); i++) {
      if (i > 400) assert.fail(`prediction rounds still open: ${[...predBets.keys()]}`);
      await sleep(1000);
    }
    await sleep(2500);
    await claimRound();
    const left = await audit("end of rounds");
    for (const kind of ["Bet", "Duel", "War", "PredRound", "PredEntry", "Listing", "JackpotEntry"]) expect(left.counts[kind] ?? 0, `${kind} accounts left open`).to.equal(0);
    expect(Object.keys(SIZES).length, "23 account kinds in the IDL").to.equal(23);
    console.log(`      keeper ${JSON.stringify(keeperStats)}, Moon Wars ${JSON.stringify(wars)}, duels ${JSON.stringify(duels)}, predictions ${JSON.stringify(preds)}`);
    console.log(`      market ${JSON.stringify(market)}, epochs ${JSON.stringify(epochs)}`);
    const c1 = await cfg();
    console.log(`      ${c1.stats.bets.toNumber() - c0.stats.bets.toNumber()} bets, ${((c1.stats.wagered.toNumber() - c0.stats.wagered.toNumber()) / XNT).toFixed(2)} XNT wagered, refusals ${JSON.stringify(refusals)}, audits ${audits}`);
    expect(keeperStats.settled).to.be.greaterThan(0);
  });

  it("whale at the exposure cap on 100x Void Rush, 40 bets in a row: the bankroll never owes more than it holds", async () => {
    const whale = players[0];
    await methods.deposit(BN(300 * XNT)).accountsPartial({ playerState: P.player(whale.publicKey), payer: payer.publicKey, systemProgram: SYS }).rpc();
    await methods.houseDeposit(BN(3000 * XNT), BN(0)).accountsPartial({ config: P.config, share: P.house(payer.publicKey), bankrollVault: P.bankroll, owner: payer.publicKey, systemProgram: SYS }).rpc();
    const free0 = await freeBankroll();
    let placed = 0;
    for (let i = 0; i < 40; i++) {
      const cap = await maxStake(1_000_000);
      expect(cap).to.be.greaterThan(10_000_000);
      if (await placeBet(whale, 2, 1_000_000, 0, cap)) placed++;
      if (i % 4 === 3) { await audit(`whale ${i}`); await keeperPass(0); }
    }
    expect(placed).to.be.greaterThan(30); // a loss streak can trip the daily breaker (3%): refused, never owed
    await keeperPass(0);
    await audit("whale end");
    expect(await freeBankroll()).to.be.greaterThan(free0 * 0.9);
  });

  it("bank run: every LP exits while bets are pending — the pending winners are still paid in full", async () => {
    for (const k of players.slice(1, 6)) await placeBet(k, 0, 0, between(0, 1), 50_000_000);
    expect((await ks()).pendingBets).to.be.greaterThan(0);
    for (const k of [...lps, payer]) {
      const s = await acc.houseShare.fetchNullable(P.house(k.publicKey));
      if (!s || s.shares.toNumber() === 0) continue;
      await methods.houseRequestWithdraw(s.shares).accountsPartial({ share: P.house(k.publicKey), owner: k.publicKey }).signers(k === payer ? [] : [k]).rpc();
    }
    for (const k of [...lps, payer]) {
      const s = await acc.houseShare.fetchNullable(P.house(k.publicKey));
      if (!s || s.pendingShares.toNumber() === 0) continue;
      if (await lpExit(k)) console.log("      (an LP request outlived its 60-s window during the audits: requested again, then withdrawn)");
      await audit("lp exit");
    }
    await keeperPass(0); // every winner is paid from the reserved part, which no LP could take
    await audit("after bank run");
    expect((await cfg()).bankrollReserved.toNumber()).to.equal(0);
  });

  // r6-fix regression tests (2026-10-31): the two late-landing paths the loaded-host runs hit, forced on purpose, through
  // the same helpers the random play and the bank run use
  it("regression: a duel join opened after its 4-s window is refused (DeadlinePassed) and lapses as unopened: creator refunded, the joiner's stake to the pool", async () => {
    const [a, b] = [players[1], players[2]];
    for (const k of [a, b]) await methods.deposit(BN(XNT)).accountsPartial({ playerState: P.player(k.publicKey), payer: k.publicKey, systemProgram: SYS }).signers([k]).rpc();
    const nonce = (await acc.playerState.fetch(P.player(a.publicKey))).nonce.toNumber();
    const duel = P.duel(a.publicKey, nonce);
    const stake = XNT / 2;
    const salt = keccak(duel.toBuffer(), Buffer.from("rc")), jsalt = keccak(duel.toBuffer(), Buffer.from("rj"));
    await methods.createDuel(BN(stake), Array.from(keccak(Buffer.from("MOONFORGE_DUEL"), Buffer.from([1]), salt, duel.toBuffer())))
      .accountsPartial({ config: P.config, creatorState: P.player(a.publicKey), duel, owner: a.publicKey, asset: SYS, record: SYS, collection: SYS, systemProgram: SYS }).signers([a]).rpc();
    await methods.joinDuelSealed(Array.from(keccak(Buffer.from("MOONFORGE_DUEL_JOIN"), Buffer.from([2]), jsalt, duel.toBuffer(), b.publicKey.toBuffer())))
      .accountsPartial({ config: P.config, duel, opponentState: P.player(b.publicKey), opponent: b.publicKey, asset: SYS, record: SYS, collection: SYS }).signers([b]).rpc();
    const gameA = big((await acc.playerState.fetch(P.player(a.publicKey))).balance), gameB = big((await acc.playerState.fetch(P.player(b.publicKey))).balance);
    const pool0 = BigInt(await bal(P.reward)), lapsed0 = duels.lapsed;
    await T.untilChainTime((await acc.duel.fetch(duel)).deadline.toNumber() + 1); // the opening is now late, on the validator clock
    expect(await openDuelJoin(a, b, duel, 2, jsalt), "a late opening must lapse, not throw").to.equal(false);
    expect(duels.lapsed).to.equal(lapsed0 + 1);
    expect(await connection.getAccountInfo(duel), "the duel account is closed").to.equal(null);
    expect(big((await acc.playerState.fetch(P.player(a.publicKey))).balance) - gameA, "creator refunded its stake").to.equal(BigInt(stake));
    expect(big((await acc.playerState.fetch(P.player(b.publicKey))).balance) - gameB, "the joiner gets nothing back").to.equal(0n);
    expect(BigInt(await bal(P.reward)) - pool0, "the joiner's stake went to the pool").to.equal(BigInt(stake));
    await audit("late duel opening");
  });

  it("regression: an LP request older than its 60-s window is refused (WithdrawExpired); the exit requests again and withdraws every share", async () => {
    const k = lps[0];
    await methods.houseDeposit(BN(5 * XNT), BN(0)).accountsPartial({ config: P.config, share: P.house(k.publicKey), bankrollVault: P.bankroll, owner: k.publicKey, systemProgram: SYS }).signers([k]).rpc();
    const s0 = await acc.houseShare.fetch(P.house(k.publicKey));
    expect(s0.shares.toNumber()).to.be.greaterThan(0);
    await methods.houseRequestWithdraw(s0.shares).accountsPartial({ share: P.house(k.publicKey), owner: k.publicKey }).signers([k]).rpc();
    const s1 = await acc.houseShare.fetch(P.house(k.publicKey));
    await T.untilChainTime(s1.unlockTs.toNumber() + HOUSE_WITHDRAW_WINDOW + 1); // the request is now stale, on the validator clock
    const wallet0 = await bal(k.publicKey);
    expect(await lpExit(k), "the stale request must be renewed, not thrown").to.equal(true);
    const s2 = await acc.houseShare.fetch(P.house(k.publicKey));
    expect([s2.shares.toNumber(), s2.pendingShares.toNumber()], "every share withdrawn").to.deep.equal([0, 0]);
    expect((await bal(k.publicKey)) - wallet0, "the 5-XNT deposit came back (less share rounding and fees)").to.be.greaterThan(4.5 * XNT);
    await audit("lp exit after a renewed request");
  });

  it("players can always withdraw their whole game balance", async () => {
    for (const k of players) {
      const b = (await acc.playerState.fetch(P.player(k.publicKey))).balance.toNumber();
      if (b === 0) continue;
      const before = await bal(k.publicKey);
      await methods.withdraw(BN(b)).accountsPartial({ playerState: P.player(k.publicKey), owner: k.publicKey }).signers([k]).rpc();
      expect((await bal(k.publicKey)) - before).to.be.greaterThan(b - 10_000);
    }
    await audit("all withdrawn");
  });
});
