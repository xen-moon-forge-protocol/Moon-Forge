/**
 * The players, the owner steps and the checks of tests/e2e-oracle-v3.sh. Everything the ORACLE does in that test is
 * done by the oracle CLI itself (src/index.ts); this file only plays the other parties (burners on the fake EVM chain,
 * players, the house LP, the owner's S7 steps with throwaway keys) and reads the chain to check the outcome.
 * Run from an oracle directory through the preload: `node -r tests/e2e-oracle/preload.cjs <this file> <command> [args]`,
 * so it uses that oracle's own node_modules, PDAs, IDLs and keeper chain derivation (KeeperChains for take_keeper).
 * Env: E2E_RPC (local validator), E2E_FAKE_WORLD, E2E_FIXTURES (tests/fixtures), E2E_DIR (work dir), E2E_IDL=live|v3.
 * Each check prints "  ok   ..." or "  FAIL ..."; the command exits 1 when any check failed.
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

const ORACLE = path.resolve(process.env.E2E_ORACLE_DIR || process.cwd());
const R = (m: string) => require(path.join(ORACLE, "node_modules", m));
const anchor = R("@coral-xyz/anchor");
const web3 = R("@solana/web3.js");
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram, LAMPORTS_PER_SOL } = web3;
type Kp = InstanceType<typeof Keypair>;
type Pk = InstanceType<typeof PublicKey>;

const RPC = process.env.E2E_RPC || "http://127.0.0.1:8899";
const WORLD = process.env.E2E_FAKE_WORLD || "http://127.0.0.1:8546";
const FIX = process.env.E2E_FIXTURES || path.join(ORACLE, "..", "tests", "fixtures");
const DIR = process.env.E2E_DIR || "/tmp/mf-e2e";
const XNT = 1_000_000_000n;
const conn = new Connection(RPC, "confirmed");
const x1 = require(path.join(ORACLE, "src", "x1"));
const PDA = x1.PDA;
const v3mod = fs.existsSync(path.join(ORACLE, "src", "x1-v3.ts")) ? require(path.join(ORACLE, "src", "x1-v3")) : null;
const big = (v: any): bigint => (v === null || v === undefined ? 0n : BigInt(v.toString()));
const BN = (v: bigint | number) => new anchor.BN(v.toString());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── keys: the localnet program's fixed test keys (tests/fixtures) and deterministic throwaway keys ────────────────
const fileKey = (f: string): Kp => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"))));
const seedKey = (label: string): Kp => Keypair.fromSeed(createHash("sha256").update(`moonforge-e2e-oracle:${label}`).digest());
const K = {
  oracle: fileKey("test-oracle.json"), architect: fileKey("test-architect.json"), keeper: fileKey("test-keeper.json"), cold: fileKey("test-cold.json"),
  payer: seedKey("payer"), lp: seedKey("lp"), keeper2: seedKey("keeper2"), newArch: seedKey("new-architect"), sink: seedKey("sink"),
  alice: seedKey("alice"), bob: seedKey("bob"), carol: seedKey("carol"), dave: seedKey("dave"),
};
/** burners' X1 wallets: fresh, never pay a fee, so a claim shows as an exact balance delta */
const burner = (i: number): Kp => seedKey(`burner-${i}`);

let failures = 0;
const ok = (m: string) => console.log(`  ok   ${m}`);
const bad = (m: string) => { failures++; console.log(`  FAIL ${m}`); };
const check = (c: boolean, m: string) => (c ? ok : bad)(m);
const note = (m: string) => console.log(`  note ${m}`);

// tests/tx-confirm.cjs: every send waits for its signature (no 30-s legacy timeout) and is never re-sent; a landed failure
// keeps its program error (Anchor 0.32.1 alone answers "Unknown action 'undefined'")
const TX = require(path.join(__dirname, "..", "tx-confirm.cjs"));
const provider = (k: Kp) => TX.hardenProvider(new anchor.AnchorProvider(conn, new anchor.Wallet(k), { commitment: "confirmed", preflightCommitment: "confirmed" }));
const live = (k: Kp = K.payer) => x1.programV2(provider(k));
const v3 = (k: Kp = K.payer) => v3mod.programV3(provider(k));
const prog = (k: Kp = K.payer) => (process.env.E2E_IDL === "v3" ? v3(k) : live(k));
const SYS = SystemProgram.programId;
const CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

async function airdrop(pk: Pk, xnt: number) {
  await TX.airdrop(conn, pk, Math.round(xnt * LAMPORTS_PER_SOL));
}
async function transfer(from: Kp, to: Pk, lamports: bigint) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports: Number(lamports) }));
  return TX.sendOnce(conn, tx, [from], { commitment: "confirmed" });
}
const bal = async (pk: Pk) => BigInt(await conn.getBalance(pk, "confirmed"));
async function world(p: string, body: unknown = {}) {
  const r = await fetch(`${WORLD}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`fake world ${p}: ${JSON.stringify(j)}`);
  return j;
}
const cfgOf = async (p = prog()) => (p.account as any).config.fetch(PDA.config());
async function chainTime(): Promise<number> {
  return (await conn.getBlockTime(await conn.getSlot("confirmed"))) as number;
}
async function retry<T>(f: () => Promise<T>, codes: string[], tries = 60, ms = 500): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      const t = String(e) + JSON.stringify((e as any)?.logs ?? "");
      if (i >= tries || !codes.some((c) => t.includes(c))) throw e;
      await sleep(ms);
    }
  }
}
const writeJson = (name: string, v: unknown) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, name), JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
};
const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(DIR, name), "utf8"));

// ── commands ─────────────────────────────────────────────────────────────────────────────────────────────────────
const cmds: Record<string, (...a: string[]) => Promise<void>> = {
  /** airdrops every party; prints the keys the bash script needs (public keys only) */
  async fund() {
    const plan: [Kp, number][] = [[K.payer, 3000], [K.lp, 600], [K.oracle, 50], [K.architect, 20], [K.keeper, 60], [K.cold, 5], [K.keeper2, 60], [K.newArch, 10],
      [K.alice, 100], [K.bob, 100], [K.carol, 100], [K.dave, 100]];
    for (const [k, x] of plan) await airdrop(k.publicKey, x);
    writeJson("keys.json", Object.fromEntries(Object.entries(K).map(([n, k]) => [n, k.publicKey.toBase58()])));
    ok(`funded ${plan.length} wallets`);
  },
  /** prints a key's secret as the oracle's ORACLE_PRIVATE_KEY format (a JSON array) into a 0600 file */
  async keyfile(name: string, out: string) {
    const k = (K as any)[name] as Kp;
    fs.writeFileSync(out, JSON.stringify(Array.from(k.secretKey)), { mode: 0o600 });
  },
  /** v2 world on the OLD binary: the pool, two game wallets, one forged Artifact, an OPEN Burn Lottery round, the portal */
  async "v2-setup"(portal: string) {
    const A = live();
    await A.methods.donate(0, BN(1000n * XNT)).accountsPartial({ config: PDA.config(), donor: K.payer.publicKey, vault: PDA.rewardVault(), systemProgram: SYS }).rpc();
    for (const k of [K.alice, K.bob, K.carol]) {
      await live(k).methods.openPlayer().accountsPartial({ playerState: PDA.player(k.publicKey), owner: k.publicKey, systemProgram: SYS }).rpc();
      await live(k).methods.deposit(BN(20n * XNT)).accountsPartial({ playerState: PDA.player(k.publicKey), payer: k.publicKey, systemProgram: SYS }).rpc();
    }
    const c = await cfgOf(A);
    const serial = Number(c.artifactsMinted[0]);
    const asset = PDA.asset(0, serial);
    await live(K.carol).methods.forgeArtifact(0, serial, BN((1n << 64n) - 1n)).accountsPartial({
      config: PDA.config(), asset, record: PDA.artifact(asset), collection: PDA.collection(), artifactAuthority: PDA.authority(), rewardVault: PDA.rewardVault(),
      drawVault: PDA.drawVault(), architect: c.architect, buyer: K.carol.publicKey, coreProgram: CORE, systemProgram: SYS,
    }).rpc();
    const dr = Number(c.drawRound);
    for (const [i, k, t] of [[0, K.alice, 1], [1, K.bob, 2]] as [number, Kp, number][]) {
      await live(k).methods.enterDraw(BN(dr), i, BN(0), BN(t)).accountsPartial({
        config: PDA.config(), round: PDA.draw(dr), entry: PDA.drawEntry(dr, i), playerState: PDA.player(k.publicKey), rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(),
        architect: c.architect, signer: k.publicKey, systemProgram: SYS,
      }).rpc();
    }
    await world("/ctl/portal", { chainId: 8453, portal });
    ok(`v2 world: 1,000 XNT donated, game wallets for alice/bob/carol, Lunar Dust #${serial} forged by carol (old split), lottery round ${dr} OPEN with 2 entries`);
  },
  /** burns on the fake Base chain: `<label> <usd,...>` (tier 0; a trailing ":1" = tier 1). E2E_BURN_TS fixes the timestamp. */
  async burns(label: string, list: string) {
    const st = await world("/ctl/state", {});
    const xenUsd = st.chains["8453"].xenUsd as number;
    const fixed = process.env.E2E_BURN_TS ? Number(process.env.E2E_BURN_TS) : null;
    const out: unknown[] = [];
    let i = 0;
    for (const item of list.split(",")) {
      const [usd, tier] = item.split(":");
      const idx = Number(process.env.E2E_BURNER_BASE || 0) + i++;
      const xen = BigInt(Math.round(Number(usd) / xenUsd));
      // E2E_BURN_X1: the burn pays this X1 wallet (a holder burning for itself), else a fresh burner wallet
      const to = process.env.E2E_BURN_X1 || burner(idx).publicKey.toBase58();
      const r = await world("/ctl/burn", { chainId: 8453, x1: to, amountWei: (xen * 10n ** 18n).toString(), tier: Number(tier || 0), timestamp: fixed === null ? undefined : fixed + i });
      out.push({ burner: idx, x1: to, usd: Number(usd), tier: Number(tier || 0), missionId: r.burn.missionId, block: r.burn.block });
    }
    writeJson(`burns-${label}.json`, out);
    ok(`${out.length} burns on the fake Base chain (${label})`);
  },
  /** a normalized summary of the program state the oracle touched (for the main-vs-worktree comparison) */
  async summary(out: string) {
    const A = live();
    const c = await cfgOf(A);
    const n = Number(c.lastEpoch);
    const epochs: unknown[] = [];
    for (let e = 1; e <= n; e++) {
      const ep: any = await (A.account as any).epoch.fetch(PDA.epoch(e));
      epochs.push({ id: e, root: Buffer.from(ep.root).toString("hex"), dataHash: Buffer.from(ep.dataHash).toString("hex"), totalScore: ep.totalScore.toString(), leaves: ep.leaves, budget: ep.budget.toString(), dropReserve: ep.dropReserve.toString(), rateCap: ep.rateCap.toString(), dropState: ep.dropState, claimed: ep.claimed?.toString?.() ?? null });
    }
    const burners = Array.from({ length: 8 }, (_, i) => burner(i).publicKey);
    const receipts: unknown[] = [];
    for (let e = 1; e <= n; e++) for (const b of burners) for (const t of [0, 1, 2]) {
      const r: any = await (A.account as any).claimReceipt.fetchNullable(PDA.receipt(e, b, t));
      if (r) receipts.push({ epoch: e, player: b.toBase58(), tier: t, amount: r.amount.toString(), rentPayer: r.rentPayer.toBase58() });
    }
    const balances = Object.fromEntries(await Promise.all(burners.map(async (b) => [b.toBase58(), (await bal(b)).toString()])));
    // Forge Drops are drawn from a block hash after the publication: a different outcome on every run. What must hold
    // on every run is that the delivered drops are exactly the program's outcome for that seed (x1.ts dropOutcome).
    let drops = 0, dropsExpected = 0, dropsWrong = 0;
    for (let e = 1; e <= n; e++) {
      const fp = path.join(process.env.EPOCHS_DIR!, `epoch-${e}.json`);
      if (!fs.existsSync(fp)) continue;
      const f = JSON.parse(fs.readFileSync(fp, "utf8"));
      if (f.version !== 2) continue;
      const ep: any = await (A.account as any).epoch.fetch(PDA.epoch(e));
      for (const l of f.leaves) {
        const won = x1.dropOutcome(ep, new PublicKey(l.player), l.tier, BigInt(l.score)).won;
        const got = !!(await conn.getAccountInfo(PDA.drop(e, new PublicKey(l.player), l.tier), "confirmed"));
        if (won) dropsExpected++;
        if (got) drops++;
        if (won !== got) dropsWrong++;
      }
    }
    check(dropsWrong === 0, `Forge Drops: ${drops} delivered = the ${dropsExpected} the sealed seed awards (x1.ts dropOutcome)`);
    // the drops are random per run, so the vault balance (drop reserve) and per-leaf drop counts are not compared across runs
    const s = { lastEpoch: n, epochs: epochs.map((e: any) => ({ ...e, dataHash: undefined })), receipts, balances };
    fs.writeFileSync(out, JSON.stringify(s, null, 2));
    ok(`state summary written (${n} epochs, ${receipts.length} receipts, ${drops} drop receipts)`);
  },
  /** S7 steps 3-7 with throwaway keys: refresh_collection_uri, set_architect + lock_collection_royalties (both payee keys sign), init_seat, init_extra */
  async s7() {
    const B = v3();
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      await B.methods.refreshCollectionUri().accountsPartial({ config: PDA.config(), collection: PDA.collection(), artifactAuthority: PDA.authority(), payer: K.payer.publicKey, coreProgram: CORE, systemProgram: SYS }).instruction(),
      await B.methods.setArchitect(K.newArch.publicKey).accountsPartial({ config: PDA.config(), architect: K.architect.publicKey, newArchitect: K.newArch.publicKey, rewardVault: PDA.rewardVault() }).instruction(),
      await B.methods.lockCollectionRoyalties().accountsPartial({ config: PDA.config(), collection: PDA.collection(), artifactAuthority: PDA.authority(), architect: K.newArch.publicKey, coreProgram: CORE, systemProgram: SYS }).instruction(),
      await B.methods.initSeat().accountsPartial({ config: PDA.config(), seat: v3mod.PDA_V3.oracleSeat(), rewardVault: PDA.rewardVault(), payer: K.payer.publicKey, systemProgram: SYS }).instruction(),
    ];
    ixs[2].keys.find((k: any) => k.pubkey.equals(K.newArch.publicKey)).isSigner = true;
    const tx = new Transaction().add(...ixs);
    const sig = await TX.sendOnce(conn, tx, [K.payer, K.architect, K.newArch], { commitment: "confirmed" });
    ok(`S7 steps 3-6 in one transaction: refresh_collection_uri, set_architect (both payee keys sign), lock_collection_royalties, init_seat (${sig.slice(0, 12)}…)`);
    const sig2 = await B.methods.initExtra().accountsPartial({ config: PDA.config(), extraState: v3mod.PDA_V3.extraState(), extraVault: v3mod.PDA_V3.extraVault(), payer: K.payer.publicKey, systemProgram: SYS }).rpc();
    ok(`S7 step 7: init_extra (${sig2.slice(0, 12)}…)`);
    const c = await cfgOf(B);
    check(c.architect.equals(K.newArch.publicKey), "Config.architect is the new payee");
    const seat: any = await (B.account as any).oracleSeat.fetch(v3mod.PDA_V3.oracleSeat());
    check(c.oracle.equals(K.oracle.publicKey) && seat.cold.equals(K.cold.publicKey) && Number(seat.generation) === 1, "OracleSeat generation 1: hot key = Config.oracle (the oracle key), cold = SEAT_COLD_INITIAL (test-cold)");
  },
  /** take_keeper: INITIAL_KEEPER names keeper2, keeper2 takes the seat after KEEPER_NOTICE with a 20-XNT bond and its own derivable chain */
  async "take-keeper"() {
    const B = v3();
    const kv3 = require(path.join(ORACLE, "src", "keeper-v3"));
    const seatPk = v3mod.PDA_V3.houseKeeper();
    await v3(K.keeper).methods.proposeKeeper(K.keeper2.publicKey).accountsPartial({ config: PDA.config(), keeperSeat: seatPk, keeper: K.keeper.publicKey, bankrollVault: PDA.bankrollVault(), rewardVault: PDA.rewardVault(), systemProgram: SYS }).rpc();
    const chains = new kv3.KeeperChains(K.keeper2);
    const before = await bal(K.keeper.publicKey);
    const oldBond = big(((await (B.account as any).houseKeeper.fetch(seatPk)) as any).bond);
    const sig = await retry(async () => {
      const { id, tip } = chains.fresh(BigInt(await conn.getSlot("processed")));
      return v3(K.keeper2).methods.takeKeeper(Array.from(tip), BN(id.length), BN(20n * XNT)).accountsPartial({
        config: PDA.config(), keeperSeat: seatPk, oldKeeper: K.keeper.publicKey, taker: K.keeper2.publicKey, rewardVault: PDA.rewardVault(), systemProgram: SYS,
      }).rpc();
    }, ["KeeperNotice"], 40, 500);
    const seat: any = await (B.account as any).houseKeeper.fetch(seatPk);
    check(seat.keeper.equals(K.keeper2.publicKey) && big(seat.bond) === 20n * XNT, `take_keeper (${sig.slice(0, 12)}…): keeper2 holds the seat with a 20-XNT bond`);
    check((await bal(K.keeper.publicKey)) - before === oldBond, `the outgoing INITIAL_KEEPER got its whole bond back (${oldBond} lamports)`);
    check(chains.identify(kv3.seatOf(seat)) !== null, "the seat's chain is derivable from keeper2's key and the seat alone (armed_slot, length)");
  },
  /** the house: an LP bankroll, and game wallets on the upgraded program */
  async house() {
    const B = v3(K.lp);
    await B.methods.houseDeposit(BN(300n * XNT), BN(0)).accountsPartial({ config: PDA.config(), share: x1pda("house", K.lp.publicKey), bankrollVault: PDA.bankrollVault(), owner: K.lp.publicKey, systemProgram: SYS }).rpc();
    await v3(K.dave).methods.openPlayer().accountsPartial({ playerState: PDA.player(K.dave.publicKey), owner: K.dave.publicKey, systemProgram: SYS }).rpc();
    for (const k of [K.alice, K.bob, K.dave]) await v3(k).methods.deposit(BN(10n * XNT)).accountsPartial({ playerState: PDA.player(k.publicKey), payer: k.publicKey, systemProgram: SYS }).rpc();
    ok("house: 300 XNT bankroll from the LP; game wallets topped up");
  },
  /** `bets <who> <n> <label>`: n coin-flip bets of 0.1 XNT (place_bet_v2); their PDAs saved to bets-<label>.json */
  async bets(who: string, n: string, label: string) {
    const k = (K as any)[who] as Kp;
    const ps = PDA.player(k.publicKey);
    const out: string[] = [];
    for (let i = 0; i < Number(n); i++) {
      const nonce = Number(((await (v3().account as any).playerState.fetch(ps)) as any).nonce);
      const c = await cfgOf(v3());
      const seed = createHash("sha256").update(`bet:${who}:${nonce}`).digest();
      await v3(k).methods.placeBetV2(0, BN(0), i % 2, BN(XNT / 10n), Array.from(seed)).accountsPartial({
        config: PDA.config(), playerState: ps, bet: PDA.bet(ps, nonce), bankrollVault: PDA.bankrollVault(), rewardVault: PDA.rewardVault(), architect: c.architect,
        signer: k.publicKey, systemProgram: SYS, keeperSeat: v3mod.PDA_V3.houseKeeper(),
      }).rpc();
      out.push(PDA.bet(ps, nonce).toBase58());
    }
    writeJson(`bets-${label}.json`, out);
    ok(`${n} place_bet_v2 bets by ${who} (${label})`);
  },
  /** `bets-gone <label>`: every bet of the label is settled or refunded (its account closed); with the BetSettled/BetRefunded split */
  async "bets-gone"(label: string, want = "settled") {
    const pks: string[] = readJson(`bets-${label}.json`);
    const left = (await conn.getMultipleAccountsInfo(pks.map((p) => new PublicKey(p)), "confirmed")).filter(Boolean).length;
    check(left === 0, `${pks.length - left}/${pks.length} bets of "${label}" closed (${want})`);
    const kinds = await betOutcomes(pks);
    note(`outcomes of "${label}": ${JSON.stringify(kinds)}`);
    if (want === "refunded") check(kinds.refunded === pks.length, `every bet of "${label}" refunded by refund_stalled_bet (${kinds.refunded}/${pks.length}, reasons ${kinds.reasons.join(",")})`);
    if (want === "settled") check(kinds.settled === pks.length, `every bet of "${label}" settled by settle_bet_v2 with the keeper's reveal (${kinds.settled}/${pks.length})`);
  },
  /** `bets-anchored <label>`: every bet is anchored and still open */
  async "bets-anchored"(label: string) {
    const pks: string[] = readJson(`bets-${label}.json`);
    const infos = await conn.getMultipleAccountsInfo(pks.map((p) => new PublicKey(p)), "confirmed");
    const B = v3();
    const anchored = infos.filter((i: any) => i && (B.coder.accounts.decode("bet", i.data).game & 0x40) !== 0).length;
    check(anchored === pks.length, `${anchored}/${pks.length} bets of "${label}" anchored by the helper and not settled (it cannot reveal)`);
  },
  /** `jackpot`: alice and bob enter the current Jackpot round */
  async jackpot() {
    const B = v3();
    const r = Number((await cfgOf(B)).jackpotRound);
    // both entries in ONE transaction: the first entry starts the round's clock (JACKPOT_DURATION, 2 s on localnet), and
    // on a slow host a second transaction landed after it (RoundNotOpen, r5 e2e run 1)
    const ixs = [];
    for (const [i, k, amt] of [[0, K.alice, 1n], [1, K.bob, 2n]] as [number, Kp, bigint][]) {
      ixs.push(await v3(k).methods.enterJackpot(BN(r), i, BN(amt * XNT)).accountsPartial({ config: PDA.config(), round: PDA.jackpot(r), entry: PDA.jpEntry(r, i), playerState: PDA.player(k.publicKey), signer: k.publicKey, systemProgram: SYS }).instruction());
    }
    await TX.sendOnce(conn, new Transaction().add(...ixs), [K.alice, K.bob], { commitment: "confirmed" });
    writeJson("jackpot.json", { round: r });
    ok(`Jackpot round ${r}: alice 1 XNT, bob 2 XNT`);
  },
  async "jackpot-settled"() {
    const { round } = readJson("jackpot.json");
    const r: any = await (v3().account as any).jackpotRound.fetchNullable(PDA.jackpot(round));
    check(!!r && r.state === 2, `Jackpot round ${round} drawn and settled by the keeper (state ${r?.state}, winning ticket ${r?.winningTicket?.toString()})`);
  },
  /** the Burn Lottery round left OPEN by the old binary has exited (drawn + settled or refunded; entries closed) */
  async "lottery-exited"() {
    const c = await cfgOf(v3());
    const dr = Number(readJson("v2-lottery.json").round);
    const r: any = await (v3().account as any).drawRound.fetchNullable(PDA.draw(dr));
    const entries = await conn.getMultipleAccountsInfo([PDA.drawEntry(dr, 0), PDA.drawEntry(dr, 1)], "confirmed");
    check(!!r && (r.state === 2 || r.state === 3), `lottery round ${dr} (OPEN at the upgrade) exited: state ${r?.state} (2 settled, 3 refund)`);
    check(entries.every((e: any) => e === null), `its entries are closed (close_draw_entry): ${entries.filter((e: any) => e === null).length}/2`);
    void c;
  },
  /** a Burn Lottery round OPEN at the upgrade: alice and bob enter the current round on the old binary, right before it */
  async "lottery-open"() {
    const c = await cfgOf(live());
    const dr = Number(c.drawRound);
    for (const [i, k, t] of [[0, K.alice, 1], [1, K.bob, 1]] as [number, Kp, number][]) {
      await live(k).methods.enterDraw(BN(dr), i, BN(0), BN(t)).accountsPartial({
        config: PDA.config(), round: PDA.draw(dr), entry: PDA.drawEntry(dr, i), playerState: PDA.player(k.publicKey), rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(),
        architect: c.architect, signer: k.publicKey, systemProgram: SYS,
      }).rpc();
    }
    writeJson("v2-lottery.json", { round: dr });
    const r: any = await (live().account as any).drawRound.fetch(PDA.draw(dr));
    check(r.state === 0, `Burn Lottery round ${dr} OPEN on the old binary (2 entries) right before the upgrade`);
  },
  async "save-lottery"() {
    const c = await cfgOf(live());
    writeJson("v2-lottery.json", { round: Number(c.drawRound) });
  },
  /** `forge <who> <tier>` on the upgraded program (the extra pot gets its share) */
  async forge(who: string, tier: string) {
    const k = (K as any)[who] as Kp;
    const c = await cfgOf(v3());
    const t = Number(tier);
    const serial = Number(c.artifactsMinted[t]);
    const asset = PDA.asset(t, serial);
    await v3(k).methods.forgeArtifact(t, serial, BN((1n << 64n) - 1n)).accountsPartial({
      config: PDA.config(), asset, record: PDA.artifact(asset), collection: PDA.collection(), artifactAuthority: PDA.authority(), rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(),
      architect: c.architect, buyer: k.publicKey, coreProgram: CORE, systemProgram: SYS, extraState: v3mod.PDA_V3.extraState(), extraVault: v3mod.PDA_V3.extraVault(),
    }).rpc();
    ok(`${who} forged tier ${t} #${serial} on the upgraded program`);
  },
  /** `oracle-balance <lamports>`: sets the oracle wallet to exactly this balance (transfer to a sink, or airdrop) */
  async "oracle-balance"(target: string) {
    const want = BigInt(target);
    const have = await bal(K.oracle.publicKey);
    if (have > want) await transfer(K.oracle, K.sink.publicKey, have - want - 5000n);
    else if (have < want) await transfer(K.payer, K.oracle.publicKey, want - have);
    note(`oracle wallet ${await bal(K.oracle.publicKey)} lamports (target ${want})`);
  },
  async "oracle-wallet"(label: string) {
    const b = await bal(K.oracle.publicKey);
    writeJson(`oracle-wallet-${label}.json`, { lamports: b.toString() });
    note(`oracle wallet ${label}: ${b} lamports`);
  },
  /** `d47 <epoch> <before label>`: the EpochPublished allowance of base epoch n against the oracle wallet */
  async d47(epoch: string, label: string) {
    const n = Number(epoch);
    const f = JSON.parse(fs.readFileSync(path.join(process.env.EPOCHS_DIR!, `epoch-${n}.json`), "utf8"));
    const tx = await conn.getTransaction(f.publish.tx, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const parser = new anchor.EventParser(v3().programId, new anchor.BorshCoder(v3mod.V3_IDL));
    const ev = [...parser.parseLogs(tx!.meta!.logMessages!)].find((e: any) => e.name === "epochPublished" || e.name === "EpochPublished") as any;
    const allowance = big(ev?.data?.oracleAllowance ?? ev?.data?.oracle_allowance);
    const before = BigInt(readJson(`oracle-wallet-${label}.json`).lamports);
    const i = tx!.transaction.message.staticAccountKeys.findIndex((k: Pk) => k.equals(K.oracle.publicKey));
    const pre = BigInt(tx!.meta!.preBalances[i]), post = BigInt(tx!.meta!.postBalances[i]);
    const rent = BigInt(await conn.getMinimumBalanceForRentExemption(207));
    const fee = BigInt(tx!.meta!.fee);
    // forge.rs oracle_allowance: rent back + min(TOPUP_MAX, TARGET - balance after paying the rent and the fee), capped by the bound
    const afterRefund = pre - fee - rent + rent;
    const topup = afterRefund >= 250_000_000n ? 0n : (250_000_000n - afterRefund < 50_000_000n ? 250_000_000n - afterRefund : 50_000_000n);
    note(`epoch ${n}: oracle wallet ${pre} -> ${post} in the publish tx (fee ${fee}, Epoch rent ${rent}); EpochPublished.oracle_allowance ${allowance}; wallet before the run ${before}`);
    check(allowance > 0n && post - pre === allowance - fee - rent, `D-47: the publish tx moved exactly the allowance to the oracle (delta ${post - pre} = allowance − fee − Epoch rent)`);
    check(allowance === rent + topup || allowance < rent + topup, `D-47: allowance ${allowance} = Epoch rent ${rent} + top-up ${topup} (or less when the bound binds)`);
    const ceiling = pre - fee > 250_000_000n ? pre - fee : 250_000_000n;
    check(post <= ceiling, `D-47: the oracle wallet after the publication (${post}) is not above 0.25 XNT (or what it held before, when it held more)`);
    writeJson(`d47-${n}.json`, { allowance, pre, post, fee, rent, topup });
  },
  /** `base-claims <epoch> <who>`: every leaf of base epoch n is claimed; who = keeper2|oracle|any; checks the v3 tip rule */
  async "base-claims"(epoch: string, who: string) {
    const n = Number(epoch);
    const f = JSON.parse(fs.readFileSync(path.join(process.env.EPOCHS_DIR!, `epoch-${n}.json`), "utf8"));
    const B = v3();
    const seatKeeper = K.keeper2.publicKey;
    let claimed = 0, tipped = 0, untipped = 0;
    for (const l of f.leaves) {
      const player = new PublicKey(l.player ?? l.wallet);
      const tier = Number(l.tier ?? 0);
      const r: any = await (B.account as any).claimReceipt.fetchNullable(PDA.receipt(n, player, tier));
      if (!r) continue;
      claimed++;
      const amount = big(r.amount);
      const payer = r.rentPayer as Pk;
      const tipDue = !payer.equals(player) && !payer.equals(K.oracle.publicKey) && amount >= 200_000_000n;
      // the tip comes from the free pool, never from the claim (forge.rs pay_keeper_tip): ForgeClaimed.keeper_tip
      const tip = await claimTip(PDA.receipt(n, player, tier), player);
      const who = payer.equals(seatKeeper) ? "keeper2" : payer.equals(K.oracle.publicKey) ? "the oracle" : payer.toBase58().slice(0, 6);
      check(tip === (tipDue ? 2_000_000n : 0n), `epoch ${n} leaf ${player.toBase58().slice(0, 6)}… (${amount} lamports, tier ${tier}) claimed by ${who}: keeper tip ${tip} (${tipDue ? "due: >= 0.2 XNT, not the player, not the oracle" : "none due"})`);
      if (tier === 0 && !Object.values(K).some((k) => k.publicKey.equals(player))) {
        const got = await bal(player);
        check(got === amount, `  the burner's wallet got the whole leaf (${got}): the tip is paid by the pool`);
      }
      if (tipDue) tipped++; else untipped++;
      if (who === "keeper2") check(payer.equals(seatKeeper), `leaf claimed by keeper2`);
      if (who === "oracle") check(payer.equals(K.oracle.publicKey), `leaf claimed by the oracle key`);
    }
    check(claimed === f.leaves.length, `epoch ${n}: ${claimed}/${f.leaves.length} leaves claimed (${tipped} with the keeper tip, ${untipped} without)`);
  },
  /** `extra-claims <epoch>`: every leaf of extra epoch n paid to its holder (balances against the snapshot taken by `extra-snap`) */
  async "extra-snap"(epoch: string) {
    const f = JSON.parse(fs.readFileSync(path.join(process.env.EPOCHS_DIR!, `extra-${epoch}.json`), "utf8"));
    const m = Object.fromEntries(await Promise.all(f.leaves.map(async (l: any) => [l.wallet, (await bal(new PublicKey(l.wallet))).toString()])));
    writeJson(`extra-snap-${epoch}.json`, m);
    note(`extra epoch ${epoch}: ${f.leaves.length} leaves, total ${f.totals.budget}; balances saved`);
  },
  /** `extra-claims <epoch>`: every leaf of extra epoch n paid to its holder (the ExtraClaimed events of its PDA) */
  async "extra-claims"(epoch: string) {
    const f = JSON.parse(fs.readFileSync(path.join(process.env.EPOCHS_DIR!, `extra-${epoch}.json`), "utf8"));
    const parser = new anchor.EventParser(v3().programId, new anchor.BorshCoder(v3mod.V3_IDL));
    const got = new Map<string, bigint>();
    for (const sg of await conn.getSignaturesForAddress(v3mod.PDA_V3.extraEpoch(Number(epoch)), { limit: 200 }, "confirmed")) {
      if (sg.err) continue;
      const tx = await conn.getTransaction(sg.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      for (const e of parser.parseLogs(tx?.meta?.logMessages ?? []) as any) {
        if (String(e.name).toLowerCase() === "extraclaimed" && Number(e.data.epoch) === Number(epoch)) got.set(e.data.wallet.toBase58(), big(e.data.amount));
      }
    }
    let paid = 0;
    for (const l of f.leaves) {
      if (got.get(l.wallet) === big(l.amount)) paid++;
      else note(`extra ${epoch}: ${l.wallet.slice(0, 6)}… paid ${got.get(l.wallet) ?? "nothing"}, leaf ${l.amount}`);
    }
    note(`extra epoch ${epoch}: budget ${f.totals.budget}, ${f.leaves.length} leaves, weeks ${f.window?.weeks}`);
    check(f.leaves.length > 0 && paid === f.leaves.length, `extra epoch ${epoch}: ${paid}/${f.leaves.length} holders paid exactly their leaf by the keeper's claim_extra loop (ExtraClaimed)`);
  },
  /** `mine <blocks>`: the fake Base chain moves on (a real chain always has new blocks; the fake one only on demand) */
  async mine(n: string) {
    await world("/ctl/mine", { chainId: 8453, blocks: Number(n) });
  },
  /** `wait-chain <seconds>`: waits until the chain clock moved that far */
  async "wait-chain"(s: string) {
    const t0 = await chainTime();
    while ((await chainTime()) < t0 + Number(s)) await sleep(300);
  },
  /** `wait-slots <n>` */
  async "wait-slots"(n: string) {
    const s0 = await conn.getSlot("confirmed");
    while ((await conn.getSlot("confirmed")) < s0 + Number(n)) await sleep(200);
  },
  /** waits until the slot confirmed now is final (verify and the extra builder read at "finalized") */
  async "wait-final"() {
    const s0 = await conn.getSlot("confirmed");
    while ((await conn.getSlot("finalized")) < s0) await sleep(500);
  },
  /** `wait-final-time <epoch> <s>`: until the finalized slot's block time is s seconds after Epoch(n).published_at */
  async "wait-final-time"(epoch: string, secs: string) {
    const e: any = await (v3().account as any).epoch.fetch(PDA.epoch(Number(epoch)));
    const target = Number(e.publishedAt) + Number(secs);
    for (;;) {
      const t = await conn.getBlockTime(await conn.getSlot("finalized"));
      if (t !== null && t >= target) break;
      await sleep(500);
    }
  },
  /** `feed-check <feed.json> <epoch>`: the week-so-far feed agrees with the epoch later built from the same window */
  async "feed-check"(feedPath: string, epoch: string) {
    const feed = JSON.parse(fs.readFileSync(feedPath, "utf8"));
    const n = Number(epoch);
    const f = JSON.parse(fs.readFileSync(path.join(process.env.EPOCHS_DIR!, `epoch-${n}.json`), "utf8"));
    const prev = JSON.parse(fs.readFileSync(path.join(process.env.EPOCHS_DIR!, `epoch-${n - 1}.json`), "utf8"));
    check(feed.kind && feed.version === 1 && feed.rules === 3 && feed.epoch === n, `feed: week-so-far v1, rules 3, for epoch ${n} (${feed.kind})`);
    check(feed.prevEpoch?.epoch === n - 1 && feed.prevEpoch?.dataHash === prev.dataHash, `feed: chained to epoch ${n - 1}'s data hash`);
    check(feed.window?.startTs === f.window.startTs, `feed: window start ${feed.window?.startTs} = the epoch's ${f.window.startTs} (epoch ${n - 1}'s published_at)`);
    const eng = createHash("sha256").update(fs.readFileSync(path.join(ORACLE, "src", "rewards.ts"), "utf8").split("\r\n").join("\n")).digest("hex");
    check(feed.engineSha256 === eng, `feed: engineSha256 names the mainnet engine text of rewards.ts (${eng.slice(0, 12)}…)`);
    const fb = (feed.chains.find((c: any) => c.chainId === 8453)?.burns ?? []).map((b: any) => `${b.txHash}:${b.logIndex}:${b.amountWei}`).sort();
    const eb = (f.burns ?? []).filter((b: any) => b.chainId === 8453).map((b: any) => `${b.txHash}:${b.logIndex}:${b.amountWei}`).sort();
    check(JSON.stringify(fb) === JSON.stringify(eb) && fb.length > 0, `feed: the ${fb.length} burns read so far are the epoch's ${eb.length} burns`);
    check(feed.capacity?.cash === f.capacity?.cash, `feed: capacity C ${feed.capacity?.cash} = the epoch's ${f.capacity?.cash}`);
  },
  async seat() {
    const s: any = await (v3().account as any).houseKeeper.fetch(v3mod.PDA_V3.houseKeeper());
    const out = { keeper: s.keeper.toBase58(), revealed: s.revealed.toString(), nextIndex: s.nextIndex.toString(), length: s.length.toString(), pendingBets: s.pendingBets.toString(), bond: s.bond.toString() };
    writeJson("seat.json", out);
    note(`keeper seat: ${JSON.stringify(out)}`);
  },
  async genesis() {
    console.log(await conn.getGenesisHash());
  },
};

function x1pda(seed: string, k: Pk) {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), k.toBuffer()], x1.programId)[0];
}

/** ForgeClaimed.keeper_tip of the claim that created a receipt (its oldest transaction) */
async function claimTip(receipt: Pk, player: Pk): Promise<bigint> {
  const sigs = await conn.getSignaturesForAddress(receipt, { limit: 50 }, "confirmed");
  const parser = new anchor.EventParser(v3().programId, new anchor.BorshCoder(v3mod.V3_IDL));
  for (const s of [...sigs].reverse()) {
    if (s.err) continue;
    const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    for (const e of parser.parseLogs(tx?.meta?.logMessages ?? []) as any) {
      if (String(e.name).toLowerCase() === "forgeclaimed" && e.data.player.equals(player)) return big(e.data.keeperTip ?? e.data.keeper_tip);
    }
  }
  throw new Error(`no ForgeClaimed event for ${receipt.toBase58()}`);
}

/** BetSettled / BetRefunded of the given bet PDAs, from their transactions */
async function betOutcomes(pks: string[]) {
  const parser = new anchor.EventParser(v3().programId, new anchor.BorshCoder(v3mod.V3_IDL));
  const out = { settled: 0, refunded: 0, won: 0, reasons: [] as number[] };
  for (const p of pks) {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(p), { limit: 20 }, "confirmed");
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      for (const e of parser.parseLogs(tx?.meta?.logMessages ?? []) as any) {
        const name = String(e.name).toLowerCase();
        if (name === "betsettled" && e.data.bet.toBase58() === p) { out.settled++; if (e.data.won) out.won++; }
        if (name === "betrefunded" && e.data.bet.toBase58() === p) { out.refunded++; out.reasons.push(e.data.reason); }
      }
    }
  }
  return out;
}

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmds[cmd]) throw new Error(`unknown command ${cmd}; one of ${Object.keys(cmds).join(", ")}`);
  await cmds[cmd](...args);
  if (failures) {
    console.log(`  ${failures} check(s) FAILED in ${cmd}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(`driver ${process.argv[2]}: ${String((e as Error)?.stack ?? e)}${(e as any)?.logs ? "\n" + (e as any).logs.join("\n") : ""}`);
  process.exit(1);
});
