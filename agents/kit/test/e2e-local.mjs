// End-to-end test of the agent kit against a local validator running the Moon Forge localnet build
// (see tests/run-local.sh: localnet keys, compressed time, a synthetic XDEX observation).
// The kit targets the LIVE program (rules 2). Against the final-upgrade (v3) build it runs in "v3 mode": the setup also
// runs init_extra (S7 step 7), the agents connect with rules: 'detect' and must read rules 3 from the chain, the kit's
// retired live calls (createWar / placeBet) are refused before sending with their documented errors (SPEC-UPGRADE-v2
// 6.2), forges follow the PX price (forgeLunarDust keeps a 10 XNT max; forge() at the kit's quote), and the Be the
// House guard is driven with place_bet_v2 bets settled with the fixture keeper's chain.
// Two agents forge their tickets, play a full Moon Wars match against each other, cancel and time out matches, take
// opposite sides of a Predictions round (entered with raw program calls: the kit only exposes the exits), back the
// bankroll, hit the Be the House guard with pending bets, place a house bet, recycle an Artifact and race two forges.
// Every balance change is checked.
//   RPC=http://127.0.0.1:8899 node test/e2e-local.mjs
//   MEASURE_CU=1   prints the compute units every instruction consumed (the source of CU_LIMITS)
//   MAINNET_FEES=1 also asks X1 mainnet (read-only getFeeForMessage) what each transaction would cost there
import anchor from '@coral-xyz/anchor'; // CommonJS package: the default import is the whole module (BN, Program, Wallet...)
import { keccak_256 } from '@noble/hashes/sha3'; // a dependency of @solana/web3.js (test only)
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connect, CU_LIMITS, errorMessage, GAME, LUNAR_DUST_PRICE, MAINNET_RPC, MPL_CORE, PDA, PRED, programErrorName, programErrorNumber, WAR, XNT } from '../moonforge.mjs';

const RPC = process.env.RPC ?? 'http://127.0.0.1:8899';
const here = path.dirname(fileURLToPath(import.meta.url));
const IDL = process.env.IDL ?? [path.resolve(here, '../../../target/idl/moon_forge.json'), path.resolve(here, '../../../frontend/src/idl/moon_forge.json')].find((p) => fs.existsSync(p));
const LOCAL_PRED = { periodSeconds: 40, betWindowSeconds: 20 }; // localnet schedule (constants.rs, feature "localnet")
const LOCAL_WAR_TURN = 8; // seconds (constants.rs, feature "localnet")
const MEASURE = process.env.MEASURE_CU === '1';
const keccak = (...p) => { const h = keccak_256.create(); p.forEach((x) => h.update(x)); return Buffer.from(h.digest()); };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
/** program error by number (the kit's static table may not know the v3 names) or by name in the text */
const isProgErr = (e, name, code) => programErrorNumber(e) === code || new RegExp(name).test(`${e?.message ?? e} ${errorMessage(e)} ${JSON.stringify(e?.logs ?? [])}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connection = new Connection(RPC, 'confirmed');
// r6-fix (run-local 2026-10-27): on a loaded validator an airdrop can take longer than web3's legacy 30-s confirmation
// (TransactionExpiredTimeoutError although it lands). Confirm by blockhash instead; when that fails, an airdrop that
// landed late counts (the balance shows it), else ask again, up to 3 times (the amount varies by a few lamports so a
// repeated request is not deduplicated).
const fund = async (k, sol) => {
  const want = (await connection.getBalance(k.publicKey, 'confirmed')) + sol * LAMPORTS_PER_SOL;
  for (let i = 0; ; i++) {
    const bh = await connection.getLatestBlockhash('confirmed');
    const sig = await connection.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL - i);
    try { await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed'); return; } catch (e) {
      if ((await connection.getBalance(k.publicKey, 'confirmed')) >= want - 10) return;
      if (i >= 2) throw e;
    }
  }
};
let passed = 0;
const ok = (what) => { passed++; console.log(`  ✔ ${what}`); };
const warnings = [];
const onWarning = (t) => warnings.push(t);

// compute-unit measurement: max units consumed per instruction name, and the last transaction of each
const cuSeen = {}, txByName = {};
const onSent = async (name, sig, tx) => {
  txByName[name] = tx;
  if (!MEASURE) return;
  const t = await connection.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const u = t?.meta?.computeUnitsConsumed;
  if (u != null) cuSeen[name] = Math.max(cuSeen[name] ?? 0, u);
};

const [admin, alice, bob, carol] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
for (const [k, n] of [[admin, 100], [alice, 50], [bob, 50], [carol, 5]]) await fund(k, n);
// measuring: generous limits so every instruction lands and reports what it really consumed; otherwise the table is under test
const cu = MEASURE ? Object.fromEntries(Object.keys(CU_LIMITS).map((n) => [n, 400_000])) : undefined;
// v3 build (final upgrade): the IDL of the build under test has init_extra
const V3 = !!IDL && (JSON.parse(fs.readFileSync(IDL, 'utf8')).instructions ?? []).some((i) => /^init_?extra$/i.test(i.name));
// Off X1 mainnet the kit keeps the live rules unless told (kit 2.0.0). Against the v3 build the agents DETECT the rules
// (connect({ rules: 'detect' }): the upgraded program's ExtraState switches them, as on mainnet after the upgrade); the
// admin, used only for raw setup / keeper calls, pins rules 3 so its interface has init_extra before ExtraState exists.
const AGENT_RULES = V3 ? 'detect' : undefined;
const A = await connect({ rpc: RPC, keypair: alice, idl: IDL, onWarning, cu, rules: AGENT_RULES });
const B = await connect({ rpc: RPC, keypair: bob, idl: IDL, onWarning, cu, rules: AGENT_RULES });
const C = await connect({ rpc: RPC, keypair: carol, idl: IDL, onWarning, cu, rules: AGENT_RULES });
for (const k of [A, B, C]) k.onSent = onSent;

// a fresh validator has no config yet: initialize it like the integration tests do (permissionless)
const adm = await connect({ rpc: RPC, keypair: admin, idl: IDL, onWarning, rules: V3 ? 3 : undefined });
if (!(await connection.getAccountInfo(PDA.config()))) {
  await adm.program.methods.initializeV2().accountsPartial({
    config: PDA.config(), rewardVault: PDA.rewardVault(), bankrollVault: PDA.bankrollVault(), drawVault: PDA.drawVault(), collection: PDA.collection(),
    artifactAuthority: PDA.artifactAuthority(), payer: admin.publicKey, systemProgram: SystemProgram.programId,
  }).rpc();
}
if (!(await connection.getAccountInfo(PDA.collection()))) {
  await adm.program.methods.initArtifacts().accountsPartial({
    config: PDA.config(), collection: PDA.collection(), artifactAuthority: PDA.artifactAuthority(), payer: admin.publicKey, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
  }).rpc();
}
// v3 build (final upgrade): the extra pot must exist before the first forge (S7 step 7, permissionless)
const V3PDA = {
  extraState: PublicKey.findProgramAddressSync([Buffer.from('extra_state')], adm.program.programId)[0],
  extraVault: PublicKey.findProgramAddressSync([Buffer.from('extra_vault')], adm.program.programId)[0],
  keeper: PublicKey.findProgramAddressSync([Buffer.from('house_keeper')], adm.program.programId)[0],
};
if (V3 && !(await connection.getAccountInfo(V3PDA.extraState))) {
  await adm.program.methods.initExtra().accountsPartial({
    config: PDA.config(), extraState: V3PDA.extraState, extraVault: V3PDA.extraVault, payer: admin.publicKey, systemProgram: SystemProgram.programId,
  }).rpc();
}
// off mainnet the kit does not re-read the rules by itself: the agents re-detect once the setup above is done (on a
// fresh validator they connected before init_extra and read rules 2)
if (V3) for (const k of [A, B, C]) await k.refreshRules();
// v3: the PX price of Lunar Dust moves (+2% per forge, ÷1.02 per localnet second, floor 3 XNT). forgeLunarDust keeps
// the kit's historical 10 XNT maximum. The kit's price mirror (rules-v3.mjs) uses the MAINNET decay periods (1, 3, 7,
// 14 days), so on this build (1-s days) its quote is the stored price, at or above the program's decayed one: the
// e2e forges at that quote (the program charges its own, lower or equal, price) once forgeLunarDust is refused.
const kitQuote = async (kit) => (await kit.forgePrice(0)).xnt + 1e-6;
const forgeV3 = async (kit) => {
  const q = await kit.forgePrice(0);
  if (q.lamports <= LUNAR_DUST_PRICE) return kit.forgeLunarDust();
  const bal = await connection.getBalance(kit.me);
  await assert.rejects(kit.forgeLunarDust(), /above your maximum 10 XNT \(SlippageExceeded\)\. Nothing was sent/);
  assert.equal(await connection.getBalance(kit.me), bal, 'refused before sending: no fee spent');
  return (await kit.forge(0, { maxPriceXnt: await kitQuote(kit) })).asset;
};
// the pool's share of a forge: 40% (live), 20% (v3; + the architect's 5% once the payee is renounced to the vault)
const forgePoolShare = async (price) => {
  const c = await adm.config();
  const pool = (price * 2000n) / 10_000n, arch = price - (price * 5000n) / 10_000n - pool - (price * 2500n) / 10_000n;
  return V3 ? pool + (c.architect.equals(PDA.rewardVault()) ? arch : 0n) : (price * 4000n) / 10_000n;
};
// a bankroll to make house quotes meaningful
await adm.program.methods.houseDeposit(new anchor.BN(20 * XNT), new anchor.BN(0)).accountsPartial({
  config: PDA.config(), share: PDA.house(admin.publicKey), bankrollVault: PDA.bankrollVault(), owner: admin.publicKey, systemProgram: SystemProgram.programId,
}).rpc();

console.log('agent kit — local end-to-end');
if (V3) {
  for (const k of [A, B, C]) assert.equal(k.rules, 3, `rules detected ${k.rules} (${(k.detection?.reasons ?? []).join('; ')})`);
  assert.equal(adm.rules, 3);
  ok("v3: the agents (connect({ rules: 'detect' })) read rules 3 from the chain: the upgraded program's ExtraState");
}

// 1. status() works for a brand-new agent
const s0 = await A.status();
assert.equal(s0.wallet, alice.publicKey.toBase58());
assert.equal(s0.artifacts, 0);
assert.ok(s0.xntUsd > 0, 'XNT price from the observation account');
assert.equal(s0.predictions.offered, false);
assert.equal(s0.notices.length, 4);
assert.ok(s0.bankroll.unreservedXnt >= 19.99, `bankroll ${s0.bankroll.unreservedXnt}`); // a reused validator keeps earlier deposits
assert.ok(s0.bankroll.haircutPct >= 0 && s0.bankroll.haircutPct <= 1, `haircut ${s0.bankroll.haircutPct}% (an aborted earlier run may have left pending bets)`);
assert.equal(s0.rpc, new URL(RPC).origin, 'status().rpc: the serving endpoint, origin only');
assert.ok(s0.cluster && s0.cluster !== 'not checked', `cluster ${s0.cluster}`);
ok(`status(): wallet ${s0.walletXnt.toFixed(2)} XNT, pool ${s0.rewardPoolXnt} XNT, bankroll ${s0.bankroll.unreservedXnt} XNT, TWAP read from the observation account (synthetic test price ${s0.xntUsd.toFixed(0)}; only its direction matters here)`);

// 2. no ticket → a clear refusal, and the Moon Wars notice is printed once (v3: the live createWar is retired and
// refused by the kit before anything is sent; sealed matches need no Artifact)
if (V3) await assert.rejects(C.createWar(0.1), (e) => e.retired === true && e.code === 6065 && /SealedJoinRequired.*Nothing was sent/.test(e.message));
else await assert.rejects(C.createWar(0.1), /arena ticket/);
assert.equal(warnings.filter((w) => w.startsWith(V3 ? 'Moon Wars (final upgrade)' : 'Moon Wars')).length, 1);
ok(V3 ? 'v3: the live createWar is refused by the kit before sending (retired: SealedJoinRequired, 6065); the sealed Moon Wars notice printed once'
  : 'createWar without an Artifact is refused with a clear message; the Moon Wars pause/fees notice printed once');

// 3. tickets: forging a Lunar Dust keeps 50% of the price as a floor; the pool gets 40% (live) or 20% (v3)
const forgeOne = async (kit) => {
  const p0 = BigInt(await connection.getBalance(PDA.rewardVault()));
  const asset = V3 ? await forgeV3(kit) : await kit.forgeLunarDust();
  const rec = await kit.acc.artifactRecord.fetch(PDA.artifact(asset));
  const price = 2n * BigInt(rec.backing.toString());
  assert.equal(BigInt(await connection.getBalance(PDA.rewardVault())) - p0, await forgePoolShare(price), 'pool share of the forge');
  return { asset, price };
};
const fa0 = await forgeOne(A);
const fb0 = await forgeOne(B);
const assetA = fa0.asset, assetB = fb0.asset;
const artsA = await A.myArtifacts();
assert.equal(artsA.length, 1);
assert.ok(artsA[0].asset.equals(assetA));
assert.equal(BigInt(Math.round(artsA[0].backingXnt * XNT)), fa0.price / 2n);
assert.ok(V3 || artsA[0].backingXnt === 5); // v3: half of the PX price paid (checked above against the record)
assert.equal(warnings.filter((w) => w.startsWith(V3 ? 'Artifacts (final upgrade)' : 'Forging is paused')).length, 2, 'one forge notice per agent');
ok(`both agents forged a Lunar Dust at ${Number(fa0.price) / XNT} / ${Number(fb0.price) / XNT} XNT: floor = half the price, pool share checked${V3 ? ' (PX price, v3 split)' : ''}; forge notice printed`);

// 3b. pre-flight: a wallet that cannot pay is refused before any fee is spent
const c0 = await connection.getBalance(carol.publicKey);
// (v3: the max price is what the wallet must hold, so at least 10 XNT, and at least the kit's quote so the price check
// passes; after the integration suites the PX price can sit at its 3 XNT minimum, which a 5 XNT wallet could pay)
await assert.rejects(V3 ? C.forge(0, { maxPriceXnt: Math.max(10, await kitQuote(C)) }) : C.forgeLunarDust(), /pre-flight: the wallet holds/);
assert.equal(await connection.getBalance(carol.publicKey), c0, 'no fee spent');
ok('pre-flight balance check refuses a 10 XNT forge from a 5 XNT wallet without spending a fee');

// 4. a full Moon Wars match, agent vs agent, every move validated on-chain
await A.deposit(3.5);
await A.withdraw(0.5);
assert.equal(await A.gameBalance(), 3n * BigInt(XNT), 'deposit 3.5, withdraw 0.5');
await B.deposit(3);
if (V3) {
  // the kit's createWar / joinWar are the live (rules-2) calls: under rules 3 the kit refuses them before sending
  await assert.rejects(A.createWar(1), (e) => e.retired === true && isProgErr(e, 'SealedJoinRequired', 6065));
  ok("v3: the kit's createWar (live ABI) is refused with SealedJoinRequired (6065) before sending, nothing hangs (SPEC-UPGRADE-v2 6.2)");
} else {
const a0 = await A.gameBalance(), b0 = await B.gameBalance();
const war = await A.createWar(1);
assert.ok((await B.openWars()).some((w) => w.publicKey.equals(war)), 'B sees the open match');
await B.joinWar(war);
const moves = { a: 0, b: 0 };
const [doneA] = await Promise.all([
  A.playMatch(war, { log: () => moves.a++ }),
  B.playMatch(war, { log: () => moves.b++ }),
]);
assert.equal(doneA.state, WAR.state.DONE);
await A.settleWar(war);
assert.equal(await connection.getAccountInfo(war), null, 'match account closed');
const da = Number((await A.gameBalance()) - a0), db = Number((await B.gameBalance()) - b0);
if (doneA.draw) {
  assert.equal(da, 0); assert.equal(db, 0);
  ok(`match drawn after ${moves.a + moves.b} moves: both stakes refunded`);
} else {
  const [w, l] = doneA.winner.equals(alice.publicKey) ? [da, db] : [db, da];
  assert.equal(w, 0.96 * XNT, 'winner +0.96 net (1.96 back for 1 staked)');
  assert.equal(l, -1 * XNT, 'loser -1');
  ok(`match played to the end (${moves.a} + ${moves.b} moves, ${doneA.timeout ? 'timeout' : 'by HP'}): winner paid 1.96 XNT, 2% rake`);
}

// 4b. an unjoined match can be cancelled: stake back, account closed
const g1 = await A.gameBalance();
const war2 = await A.createWar(0.2);
assert.equal(Number(g1 - (await A.gameBalance())), 0.2 * XNT);
await A.cancelWar(war2);
assert.equal(await A.gameBalance(), g1);
assert.equal(await connection.getAccountInfo(war2), null);
ok('cancelWar: stake refunded, match account closed');

// 4c. a side that stops moving loses on time (8 s per turn on localnet); the other side claims and settles
const war3 = await A.createWar(0.2);
await B.joinWar(war3);
await A.startWar(war3);
const w3 = await A.war(war3);
const idle = w3.turn === 0 ? A : B, claimant = w3.turn === 0 ? B : A;
while ((await A.chainTime()) <= Number(w3.deadline) + 1) await sleep(500);
await claimant.claimWarTimeout(war3);
const w3done = await A.war(war3);
assert.equal(w3done.state, WAR.state.DONE);
assert.ok(w3done.winner.equals(claimant.me));
await claimant.settleWar(war3);
ok(`claimWarTimeout: the idle side (${idle === A ? 'A' : 'B'}) lost on time after ${LOCAL_WAR_TURN} s, the other claimed and settled`);
}

// 5. Predictions: the kit only exposes the exits (advance, claim); entries go through raw program calls here
// v3 rounds: 120 s, entries close 35 s in, lock at +90 s, end at +150 s (an even round of the fixture does not move: refunded)
const PREDS = V3 ? { periodSeconds: 120, entryClose: 30, lock: 90, end: 150 } : { periodSeconds: LOCAL_PRED.periodSeconds, entryClose: 12, lock: LOCAL_PRED.betWindowSeconds, end: LOCAL_PRED.periodSeconds };
let t = await A.chainTime();
while (t % PREDS.periodSeconds < 2 || t % PREDS.periodSeconds > PREDS.entryClose) { await sleep(1000); t = await A.chainTime(); }
const id = Math.floor(t / PREDS.periodSeconds);
const enter = (kit, side) => kit.program.methods.enterPrediction(new anchor.BN(id), side, new anchor.BN(XNT)).accountsPartial({
  round: PDA.pred(id), entry: PDA.predEntry(id, kit.me), playerState: PDA.player(kit.me), owner: kit.me, systemProgram: SystemProgram.programId,
}).rpc();
const pa = await A.gameBalance(), pb = await B.gameBalance();
await enter(A, PRED.side.UP);
await enter(B, PRED.side.DOWN);
assert.equal(typeof A.enterPrediction, 'undefined', 'the kit has no entry method: Predictions are not offered');
assert.equal((await A.status()).predictions.myEntries, 1);
ok(`both agents entered prediction round ${id} through raw program calls (the kit offers no entry; status counts the open entry)`);
const advance = async (until) => {
  while ((await A.chainTime()) < until) await sleep(1000);
  for (let i = 0; i < 60; i++) {
    try { await A.advancePrediction(id); return; } catch (e) { if (!/RoundRunning|NotReady/.test(programErrorName(e) ?? String(e))) throw e; await sleep(1000); }
  }
  throw new Error('round did not advance');
};
await advance(id * PREDS.periodSeconds + PREDS.lock + (V3 ? 1 : 0));
assert.ok([PRED.state.LOCKED, PRED.state.REFUND].includes((await A.acc.predRound.fetch(PDA.pred(id))).state));
if ((await A.acc.predRound.fetch(PDA.pred(id))).state === PRED.state.LOCKED) await advance(id * PREDS.periodSeconds + PREDS.end + (V3 ? 1 : 0));
const round = await A.acc.predRound.fetch(PDA.pred(id));
assert.deepEqual(await A.claimPredictions(), [id]);
assert.deepEqual(await B.claimPredictions(), [id]);
if (round.state === PRED.state.SETTLED) {
  assert.equal(round.outcome, PRED.side.UP);
  assert.equal(Number((await A.gameBalance()) - pa), 0.96 * XNT, 'UP won: +0.96 net');
  assert.equal(Number((await B.gameBalance()) - pb), -1 * XNT, 'DOWN lost its stake');
  ok(`round ${id} locked, settled UP by the TWAP, winner claimed 1.96 XNT, loser entry closed (kit exits only)`);
} else {
  assert.equal(round.state, PRED.state.REFUND);
  assert.ok(V3, 'a live-rules round of the rising fixture always settles');
  assert.equal(Number((await A.gameBalance()) - pa), 0, 'refunded');
  assert.equal(Number((await B.gameBalance()) - pb), 0, 'refunded');
  ok(`round ${id}: the price moved < 1% (v2 no-contest band) or the observation ring ended: refunded in full through the kit exits`);
}

// 6. Be the House: deposit with the guard (no pending bets: min_shares = 99% of the quote)
const quote = await A.houseQuote(2);
assert.ok(quote > 0n);
const dep = await A.houseDeposit(2);
assert.ok(dep.quotedShares * 1000n >= quote * 995n && dep.quotedShares * 1000n <= quote * 1005n, `quote moved: ${quote} -> ${dep.quotedShares}`);
assert.equal(dep.minShares, (dep.quotedShares * 99n) / 100n);
const share = await A.acc.houseShare.fetch(PDA.house(alice.publicKey));
assert.ok(BigInt(share.shares.toString()) >= dep.minShares);
ok(`house deposit: ${share.shares.toString()} shares (quote ${quote}, min ${dep.minShares}, 1% slippage guard)`);

// 6b. the H2 guard: pending bets reserve part of the bankroll; withdrawals and deposits are refused until they settle
// (the 2x bets below are ~0.25% of the bankroll each and stop at a 1% reservation: B needs ~0.6% of the bankroll it
// finds, which depends on what the suites before this one left in it; at least 3 XNT as before)
const bank0 = await A.bankroll();
await B.deposit(Math.max(3, Math.ceil((Number(bank0.unreserved) / XNT) * 0.006)));
const bets = [];
let bank = await A.bankroll();
// v3: house bets need the keeper (place_bet_v2); the fixture keeper arms a fresh chain and settles them below
const keeperKp = V3 ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.resolve(here, '../../../tests/fixtures/test-keeper.json'), 'utf8')))) : null;
let chain = null;
if (V3) {
  await fund(keeperKp, 200);
  const seed = keccak(Buffer.from('kit-e2e'), u64(Date.now()));
  chain = [seed];
  for (let i = 0; i < 200; i++) chain.push(keccak(chain[chain.length - 1]));
  chain.reverse(); // chain[0] = tip; position i is revealed by chain[i + 1]
  const k = await adm.acc.houseKeeper.fetchNullable(V3PDA.keeper);
  const bond = k ? BigInt(k.bond.toString()) : 0n;
  await adm.program.methods.armKeeper(Array.from(chain[0]), new anchor.BN(200), new anchor.BN((bond >= 100n * BigInt(XNT) ? 0n : 100n * BigInt(XNT)).toString())).accountsPartial({
    config: PDA.config(), keeperSeat: V3PDA.keeper, keeper: keeperKp.publicKey, bankrollVault: PDA.bankrollVault(), rewardVault: PDA.rewardVault(), systemProgram: SystemProgram.programId,
  }).signers([keeperKp]).rpc();
  // the kit's placeBet is the live call: a readable refusal
  await assert.rejects(B.placeBet(GAME.COINFLIP, 0, 1, 0.01), (e) => isProgErr(e, 'KeeperRequired', 6088));
  ok("v3: the kit's placeBet (live ABI) is refused before sending with KeeperRequired (6088); the fixture keeper armed a fresh chain for the kit's placeBetV2 bets below");
}
/** v3: the kit's placeBetV2 (place_bet_v2, then anchor_bet one slot later) */
const placeV2 = async (kit, game, param, choice, stakeXnt) => {
  const r = await kit.placeBetV2(game, param, choice, stakeXnt);
  assert.ok(r.anchored, 'placeBetV2 anchored the bet');
  return r.bet;
};
/** v3: (anchor if needed +) settle_bet_v2 with the keeper's next preimage (chain order = placement order here) */
const settleV2 = async (bet) => {
  const b = await adm.acc.bet.fetch(bet);
  const packed = BigInt(b.targetSlot.toString());
  const index = Number(packed >> 40n), anchorSlot = packed & ((1n << 40n) - 1n);
  if ((b.game & 0x40) === 0) {
    while (BigInt(await connection.getSlot('confirmed')) <= anchorSlot + 1n) await sleep(300);
    for (let i = 0; ; i++) {
      try { await adm.program.methods.anchorBet().accountsPartial({ bet, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).rpc(); break; } catch (e) { if (!/NotReady/.test(String(e)) || i > 20) throw e; await sleep(400); }
    }
  }
  await adm.program.methods.settleBetV2(Array.from(chain[index + 1])).accountsPartial({
    config: PDA.config(), bet, playerState: b.playerState, bankrollVault: PDA.bankrollVault(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: b.rentPayer, keeperSeat: V3PDA.keeper,
  }).rpc();
};
// 2x Void Rush bets as large as the per-bet cap allows (net win <= 0.25% of the free bankroll); each full payout stays reserved
const stake = Math.max(0.01, Math.floor((Number(bank.unreserved) / XNT) * 0.0025 / 0.96 * 0.95 * 1000) / 1000);
while (bank.haircutBps <= 100 && bets.length < 40) {
  bets.push(V3 ? await placeV2(B, GAME.VOIDRUSH, 20_000, 0, stake) : await B.placeBet(GAME.VOIDRUSH, 20_000, 0, stake));
  bank = await A.bankroll();
}
assert.ok(bank.haircutBps > 100, `reserved ${bank.haircutBps} bps`);
const h0 = await A.houseShare();
await A.houseRequestWithdraw(h0.shares / 2n);
const h1 = await A.houseShare();
assert.equal(h1.pendingShares, h0.shares / 2n);
while ((await A.chainTime()) <= h1.unlockTs) await sleep(500);
await assert.rejects(A.houseWithdraw(), /houseWithdraw refused: pending bets reserve/);
await assert.rejects(A.houseWithdraw(0), /minLamports 0 disables/);
let onChain;
try { await A.houseWithdraw(undefined, { force: true }); } catch (e) { onChain = e; }
assert.equal(programErrorName(onChain), 'SlippageExceeded', errorMessage(onChain));
assert.match(errorMessage(onChain), /SlippageExceeded, 6053/);
await assert.rejects(C.houseDeposit(1), /houseDeposit refused: pending bets reserve/);
const q = await A.houseWithdrawQuote();
assert.ok(q.quoteConservative < q.quoteUnreserved);
ok(`LP guard: ${(bank.haircutBps / 100).toFixed(2)}% reserved → withdraw refused by the kit, minXnt 0 unreachable, force → on-chain SlippageExceeded, deposit refused`);
const forced = await C.houseDeposit(1, { force: true });
assert.ok(forced.minShares > 0n);
for (const bet of bets) await (V3 ? settleV2(bet) : B.settleBet(bet));
assert.equal((await A.bankroll()).reserved, 0n);
if (V3) {
  // the kit follows a keeper bet to its settle: the account is closed and BetSettled is read from its last transaction
  assert.equal((await B.betStatus(bets[0])).state, 'closed');
  const r0 = await B.waitBet(bets[0], { timeoutMs: 30_000, pollMs: 500 });
  assert.equal(r0.state, 'settled', JSON.stringify(r0));
  // Void Rush pays the target exactly (param 20_000 bps = 2.00x, stake included; the house edge is in the win chance,
  // RTP_NUMERATOR / param): a won bet pays 2 x stake, a lost one 0
  assert.ok(r0.won ? Math.abs(r0.payoutXnt - stake * 2) < 1e-6 : r0.payoutXnt === 0, `payout ${r0.payoutXnt} for a ${stake} XNT 2x bet`);
  // round 4 (G-2): BetSettled carries the keeper's settle tip (0 when the free pool or the keeper wallet's rent cannot take it)
  assert.ok(typeof r0.keeperTipXnt === 'number' && r0.keeperTipXnt >= 0 && r0.keeperTipXnt <= 0.0005, `keeper tip ${r0.keeperTipXnt}`);
  ok(`v3: ${bets.length} house bets placed and anchored through the kit's placeBetV2, revealed by the fixture keeper; waitBet reads the settle (${r0.won ? 'won' : 'lost'}, roll ${r0.roll}, keeper tip ${r0.keeperTipXnt} XNT)`);
}
const w0 = await connection.getBalance(alice.publicKey);
const wd = await A.houseWithdraw();
const h2 = await A.houseShare();
assert.equal(h2.shares, h0.shares - h0.shares / 2n);
assert.ok((await connection.getBalance(alice.publicKey)) - w0 > 0.9 * XNT, 'about 1 XNT back');
assert.ok(wd.minLamports > 0n && wd.haircutBps === 0);
ok(`house withdraw after the bets settled: half the shares paid (min ${wd.minLamports} lamports, haircut 0); forced deposit minted ${forced.minShares}+ shares`);

// 6c. house games: a coin flip placed and settled through the kit (the house-games notice printed once per agent)
if (V3) {
  assert.equal(warnings.filter((w) => w.startsWith('House games')).length, 1);
  ok("v3: house bets go through place_bet_v2 + the keeper (the kit's placeBetV2 above); the kit's live coin flip is refused, its notice printed once");
} else {
const g0 = await B.gameBalance();
const bet = await B.placeBet(GAME.COINFLIP, 0, 1, 0.01);
assert.equal(Number(g0 - (await B.gameBalance())), 0.01 * XNT, 'stake taken from the game wallet');
const res = await B.settleBet(bet);
assert.equal(await connection.getAccountInfo(bet), null, 'bet account closed, rent returned');
assert.ok(res.won ? Math.abs(res.payoutXnt - 0.0196) < 1e-9 : res.payoutXnt === 0, `payout ${res.payoutXnt}`);
assert.equal(warnings.filter((w) => w.startsWith('House games')).length, 1);
ok(`coin flip: placed and settled through the kit (${res.won ? 'won 0.0196' : 'lost 0.01'} XNT)`);
}

// 7. legalMoves / greedyMove never propose an illegal move on a fresh match state (live rules: a kit-created match)
if (!V3) {
const war4 = await A.createWar(0.2);
await B.joinWar(war4);
await A.startWar(war4);
const w4 = await A.war(war4);
const legal = A.legalMoves(w4);
assert.ok(legal.some((m) => m.type === 'end'));
assert.ok(legal.every((m) => m.type !== 'attack'), 'no unit can attack on the first turn (summoning sickness)');
const g = A.greedyMove(w4);
assert.ok(legal.some((m) => JSON.stringify(m) === JSON.stringify(g)));
ok(`move generator: ${legal.length} legal moves on turn 1, greedy picks ${g.type}`);
const [done4] = await Promise.all([A.playMatch(war4), B.playMatch(war4)]);
assert.equal(done4.state, WAR.state.DONE);
await B.settleWar(war4);
}

// 8. recycle: the floor comes back, the record is gone, the eligibility notice is printed once
const r0 = await connection.getBalance(alice.publicKey);
const rec = await A.recycleArtifact(assetA);
assert.equal(BigInt(Math.round(rec.floorXnt * XNT)), fa0.price / 2n);
const back = (await connection.getBalance(alice.publicKey)) - r0;
assert.ok(back > rec.floorXnt * XNT - 0.01 * XNT && back <= rec.floorXnt * XNT + 0.01 * XNT, `+${back / XNT} XNT`);
assert.equal((await A.myArtifacts()).length, 0);
assert.equal(warnings.filter((w) => w.startsWith('Recycling burns')).length, 1);
await assert.rejects(A.recycleArtifact(assetA), /no Moon Forge record|not a live Artifact any more/); // recycle closes the record too
await assert.rejects(C.recycleArtifact(assetB), /held by/);
await assert.rejects(A.recycleArtifact(Keypair.generate().publicKey), /no Moon Forge record/);
ok(`recycleArtifact: +${(back / XNT).toFixed(4)} XNT (floor ${rec.floorXnt} minus fees), notice printed once, clear refusals for a dead asset, someone else's asset and a non-Artifact`);

// 9. InvalidTarget: two agents forge at the same time; the loser re-reads the serial and retries once
const serial0 = (await A.config()).artifactsMinted[0];
// v3: both at the kit's quote (see forgeV3); the first forge raises the price 2%, the second may then exceed it
const q9 = V3 ? await kitQuote(A) : null;
const raced = await Promise.allSettled(V3 ? [A, B].map((k) => k.forge(0, { maxPriceXnt: q9 }).then((r) => r.asset)) : [A.forgeLunarDust(), B.forgeLunarDust()]);
const won = raced.filter((r) => r.status === 'fulfilled').map((r) => r.value);
const lost = raced.filter((r) => r.status === 'rejected').map((r) => r.reason);
if (V3) {
  // PX: the first forge raises the price 2%; the loser's retry may then exceed the shared max price (it is protected)
  assert.ok(won.length >= 1);
  for (const e of lost) assert.ok(isProgErr(e, 'SlippageExceeded', 6053), errorMessage(e));
} else assert.equal(won.length, 2);
if (won.length === 2) assert.ok(!won[0].equals(won[1]));
assert.equal((await A.config()).artifactsMinted[0], serial0 + won.length);
const retried = warnings.filter((w) => /InvalidTarget/.test(w)).length;
ok(`concurrent forges: ${won.length} succeeded from serial ${serial0}${lost.length ? ", the other refused by the kit's max price (SlippageExceeded) after the PX step-up" : ''}; ${retried} InvalidTarget retry${retried === 1 ? '' : 'ies'}`);

console.log(`\n${passed} checks passed`);

if (MEASURE || process.env.MAINNET_FEES === '1') {
  console.log(`\n${MEASURE ? 'compute units consumed (max per instruction) → suggested limit (x1.2, rounded up to 1,000)' : 'compute-unit limits in force'}`);
  const names = Object.keys(CU_LIMITS);
  const missing = names.filter((n) => !(n in txByName));
  let mainnet = null;
  if (process.env.MAINNET_FEES === '1') {
    mainnet = new Connection(MAINNET_RPC, 'confirmed');
    const { blockhash } = await mainnet.getLatestBlockhash('confirmed');
    for (const n of names) {
      const tx = txByName[n];
      if (!tx) continue;
      tx.recentBlockhash = blockhash;
      try { cuSeen[`${n}:fee`] = (await mainnet.getFeeForMessage(tx.compileMessage(), 'confirmed')).value; } catch (e) { cuSeen[`${n}:fee`] = `? ${String(e.message).slice(0, 40)}`; }
    }
  }
  for (const n of names) {
    const u = cuSeen[n];
    const suggested = u == null ? '-' : Math.ceil((u * 1.2) / 1000) * 1000;
    console.log(`  ${n.padEnd(22)} ${String(u ?? '-').padStart(8)}  limit ${String(CU_LIMITS[n]).padStart(8)}  suggested ${String(suggested).padStart(8)}${mainnet ? `  mainnet fee ${cuSeen[`${n}:fee`] ?? '-'} lamports` : ''}${u != null && u > CU_LIMITS[n] ? '  OVER' : ''}`);
  }
  if (missing.length) console.log(`  not exercised: ${missing.join(', ')}`);
}
process.exit(0);
