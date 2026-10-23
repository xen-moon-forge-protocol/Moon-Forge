// End-to-end test of the agent kit against a local validator running the Moon Forge localnet build
// (see tests/run-local.sh: localnet keys, compressed time, a synthetic XDEX observation with a rising price).
// Two agents forge their tickets, play a full Moon Wars match against each other, cancel and time out matches, take
// opposite sides of a Predictions round (entered with raw program calls: the kit only exposes the exits), back the
// bankroll, hit the Be the House guard with pending bets, place a house bet, recycle an Artifact and race two forges.
// Every balance change is checked.
//   RPC=http://127.0.0.1:8899 node test/e2e-local.mjs
//   MEASURE_CU=1   prints the compute units every instruction consumed (the source of CU_LIMITS)
//   MAINNET_FEES=1 also asks X1 mainnet (read-only getFeeForMessage) what each transaction would cost there
import anchor from '@coral-xyz/anchor'; // CommonJS package: the default import is the whole module (BN, Program, Wallet...)
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js';
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { connect, CU_LIMITS, errorMessage, GAME, MAINNET_RPC, MPL_CORE, PDA, PRED, programErrorName, WAR, XNT } from '../moonforge.mjs';

const RPC = process.env.RPC ?? 'http://127.0.0.1:8899';
const here = path.dirname(fileURLToPath(import.meta.url));
const IDL = process.env.IDL ?? [path.resolve(here, '../../../target/idl/moon_forge.json'), path.resolve(here, '../../../frontend/src/idl/moon_forge.json')].find((p) => fs.existsSync(p));
const LOCAL_PRED = { periodSeconds: 40, betWindowSeconds: 20 }; // localnet schedule (constants.rs, feature "localnet")
const LOCAL_WAR_TURN = 8; // seconds (constants.rs, feature "localnet")
const MEASURE = process.env.MEASURE_CU === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connection = new Connection(RPC, 'confirmed');
const fund = async (k, sol) => connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL), 'confirmed');
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
const A = await connect({ rpc: RPC, keypair: alice, idl: IDL, onWarning, cu });
const B = await connect({ rpc: RPC, keypair: bob, idl: IDL, onWarning, cu });
const C = await connect({ rpc: RPC, keypair: carol, idl: IDL, onWarning, cu });
for (const k of [A, B, C]) k.onSent = onSent;

// a fresh validator has no config yet: initialize it like the integration tests do (permissionless)
const adm = await connect({ rpc: RPC, keypair: admin, idl: IDL, onWarning });
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
// a bankroll to make house quotes meaningful
await adm.program.methods.houseDeposit(new anchor.BN(20 * XNT), new anchor.BN(0)).accountsPartial({
  config: PDA.config(), share: PDA.house(admin.publicKey), bankrollVault: PDA.bankrollVault(), owner: admin.publicKey, systemProgram: SystemProgram.programId,
}).rpc();

console.log('agent kit — local end-to-end');

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

// 2. no ticket → a clear refusal, and the Moon Wars notice is printed once
await assert.rejects(C.createWar(0.1), /arena ticket/);
assert.equal(warnings.filter((w) => w.startsWith('Moon Wars')).length, 1);
ok('createWar without an Artifact is refused with a clear message; the Moon Wars pause/fees notice printed once');

// 3. tickets: forging a Lunar Dust sends 40% of the price to the burners' pool and keeps 50% as a floor
const pool0 = await connection.getBalance(PDA.rewardVault());
const assetA = await A.forgeLunarDust();
const assetB = await B.forgeLunarDust();
const artsA = await A.myArtifacts();
assert.equal(artsA.length, 1);
assert.ok(artsA[0].asset.equals(assetA));
assert.equal(artsA[0].backingXnt, 5);
assert.equal((await connection.getBalance(PDA.rewardVault())) - pool0, 8 * XNT);
assert.equal(warnings.filter((w) => w.startsWith('Forging is paused')).length, 2, 'one forge notice per agent');
ok('both agents forged a Lunar Dust: floor 5 XNT each, +8 XNT to the reward pool; forge notice printed');

// 3b. pre-flight: a wallet that cannot pay is refused before any fee is spent
const c0 = await connection.getBalance(carol.publicKey);
await assert.rejects(C.forgeLunarDust(), /pre-flight: the wallet holds/);
assert.equal(await connection.getBalance(carol.publicKey), c0, 'no fee spent');
ok('pre-flight balance check refuses a 10 XNT forge from a 5 XNT wallet without spending a fee');

// 4. a full Moon Wars match, agent vs agent, every move validated on-chain
await A.deposit(3.5);
await A.withdraw(0.5);
assert.equal(await A.gameBalance(), 3n * BigInt(XNT), 'deposit 3.5, withdraw 0.5');
await B.deposit(3);
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

// 5. Predictions: the kit only exposes the exits (advance, claim); entries go through raw program calls here
let t = await A.chainTime();
while (t % LOCAL_PRED.periodSeconds < 2 || t % LOCAL_PRED.periodSeconds > 12) { await sleep(1000); t = await A.chainTime(); }
const id = Math.floor(t / LOCAL_PRED.periodSeconds);
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
await advance(id * LOCAL_PRED.periodSeconds + LOCAL_PRED.betWindowSeconds);
assert.equal((await A.acc.predRound.fetch(PDA.pred(id))).state, PRED.state.LOCKED);
await advance((id + 1) * LOCAL_PRED.periodSeconds);
const round = await A.acc.predRound.fetch(PDA.pred(id));
assert.equal(round.state, PRED.state.SETTLED);
assert.equal(round.outcome, PRED.side.UP);
assert.deepEqual(await A.claimPredictions(), [id]);
assert.deepEqual(await B.claimPredictions(), [id]);
assert.equal(Number((await A.gameBalance()) - pa), 0.96 * XNT, 'UP won: +0.96 net');
assert.equal(Number((await B.gameBalance()) - pb), -1 * XNT, 'DOWN lost its stake');
ok('round locked, settled UP by the TWAP, winner claimed 1.96 XNT, loser entry closed (kit exits only)');

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
await B.deposit(3);
const bets = [];
let bank = await A.bankroll();
// 2x Void Rush bets as large as the per-bet cap allows (net win <= 0.25% of the free bankroll); each full payout stays reserved
const stake = Math.max(0.01, Math.floor((Number(bank.unreserved) / XNT) * 0.0025 / 0.96 * 0.95 * 1000) / 1000);
while (bank.haircutBps <= 100 && bets.length < 40) {
  bets.push(await B.placeBet(GAME.VOIDRUSH, 20_000, 0, stake));
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
for (const bet of bets) await B.settleBet(bet);
assert.equal((await A.bankroll()).reserved, 0n);
const w0 = await connection.getBalance(alice.publicKey);
const wd = await A.houseWithdraw();
const h2 = await A.houseShare();
assert.equal(h2.shares, h0.shares - h0.shares / 2n);
assert.ok((await connection.getBalance(alice.publicKey)) - w0 > 0.9 * XNT, 'about 1 XNT back');
assert.ok(wd.minLamports > 0n && wd.haircutBps === 0);
ok(`house withdraw after the bets settled: half the shares paid (min ${wd.minLamports} lamports, haircut 0); forced deposit minted ${forced.minShares}+ shares`);

// 6c. house games: a coin flip placed and settled through the kit (the house-games notice printed once per agent)
const g0 = await B.gameBalance();
const bet = await B.placeBet(GAME.COINFLIP, 0, 1, 0.01);
assert.equal(Number(g0 - (await B.gameBalance())), 0.01 * XNT, 'stake taken from the game wallet');
const res = await B.settleBet(bet);
assert.equal(await connection.getAccountInfo(bet), null, 'bet account closed, rent returned');
assert.ok(res.won ? Math.abs(res.payoutXnt - 0.0196) < 1e-9 : res.payoutXnt === 0, `payout ${res.payoutXnt}`);
assert.equal(warnings.filter((w) => w.startsWith('House games')).length, 1);
ok(`coin flip: placed and settled through the kit (${res.won ? 'won 0.0196' : 'lost 0.01'} XNT)`);

// 7. legalMoves / greedyMove never propose an illegal move on a fresh match state
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

// 8. recycle: the floor comes back, the record is gone, the eligibility notice is printed once
const r0 = await connection.getBalance(alice.publicKey);
const rec = await A.recycleArtifact(assetA);
assert.equal(rec.floorXnt, 5);
const back = (await connection.getBalance(alice.publicKey)) - r0;
assert.ok(back > 4.99 * XNT && back <= 5.01 * XNT, `+${back / XNT} XNT`);
assert.equal((await A.myArtifacts()).length, 0);
assert.equal(warnings.filter((w) => w.startsWith('Recycling burns')).length, 1);
await assert.rejects(A.recycleArtifact(assetA), /no Moon Forge record|not a live Artifact any more/); // recycle closes the record too
await assert.rejects(C.recycleArtifact(assetB), /held by/);
await assert.rejects(A.recycleArtifact(Keypair.generate().publicKey), /no Moon Forge record/);
ok(`recycleArtifact: +${(back / XNT).toFixed(4)} XNT (floor 5 minus fees), notice printed once, clear refusals for a dead asset, someone else's asset and a non-Artifact`);

// 9. InvalidTarget: two agents forge at the same time; the loser re-reads the serial and retries once
const serial0 = (await A.config()).artifactsMinted[0];
const [fa, fb] = await Promise.all([A.forgeLunarDust(), B.forgeLunarDust()]);
assert.ok(!fa.equals(fb));
assert.equal((await A.config()).artifactsMinted[0], serial0 + 2);
const retried = warnings.filter((w) => /InvalidTarget/.test(w)).length;
ok(`concurrent forges: both succeeded (serials ${serial0}, ${serial0 + 1}); ${retried} InvalidTarget retry${retried === 1 ? '' : 'ies'}`);

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
