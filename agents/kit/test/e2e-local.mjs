// End-to-end test of the agent kit against a local validator running the Moon Forge localnet build
// (see tests/run-local.sh: localnet keys, compressed time, a synthetic XDEX observation with a rising price).
// Two agents forge their tickets, play a full Moon Wars match against each other, take opposite sides of a
// Predictions round, and one backs the bankroll. Every balance change is checked.
//   RPC=http://127.0.0.1:8899 node test/e2e-local.mjs
import anchor from '@coral-xyz/anchor'; // CommonJS package: the default import is the whole module (BN, Program, Wallet...)
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js';
import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { connect, MPL_CORE, PDA, PRED, WAR, XNT } from '../moonforge.mjs';

const RPC = process.env.RPC ?? 'http://127.0.0.1:8899';
const IDL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../target/idl/moon_forge.json');
const LOCAL_PRED = { periodSeconds: 40, betWindowSeconds: 20 }; // localnet schedule (constants.rs, feature "localnet")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const connection = new Connection(RPC, 'confirmed');
const fund = async (k, sol) => connection.confirmTransaction(await connection.requestAirdrop(k.publicKey, sol * LAMPORTS_PER_SOL), 'confirmed');
let passed = 0;
const ok = (what) => { passed++; console.log(`  ✔ ${what}`); };

const [admin, alice, bob, carol] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
for (const [k, n] of [[admin, 100], [alice, 50], [bob, 50], [carol, 5]]) await fund(k, n);
const A = await connect({ rpc: RPC, keypair: alice, idl: IDL, pred: LOCAL_PRED });
const B = await connect({ rpc: RPC, keypair: bob, idl: IDL, pred: LOCAL_PRED });
const C = await connect({ rpc: RPC, keypair: carol, idl: IDL, pred: LOCAL_PRED });

// a fresh validator has no config yet: initialize it like the integration tests do (permissionless)
const adm = await connect({ rpc: RPC, keypair: admin, idl: IDL, pred: LOCAL_PRED });
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
ok(`status(): wallet ${s0.walletXnt.toFixed(2)} XNT, pool ${s0.rewardPoolXnt} XNT, TWAP read from the observation account (synthetic test price ${s0.xntUsd.toFixed(0)}; only its direction matters here)`);

// 2. no ticket → a clear refusal
await assert.rejects(C.createWar(0.1), /arena ticket/);
ok('createWar without an Artifact is refused with a clear message');

// 3. tickets: forging a Lunar Dust sends 40% of the price to the burners' pool and keeps 50% as a floor
const pool0 = await connection.getBalance(PDA.rewardVault());
await A.forgeLunarDust();
await B.forgeLunarDust();
const artsA = await A.myArtifacts();
assert.equal(artsA.length, 1);
assert.equal(artsA[0].backingXnt, 5);
assert.equal((await connection.getBalance(PDA.rewardVault())) - pool0, 8 * XNT);
ok('both agents forged a Lunar Dust: floor 5 XNT each, +8 XNT to the reward pool');

// 4. a full Moon Wars match, agent vs agent, every move validated on-chain
await A.deposit(3);
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

// 5. Predictions: opposite sides of one round, resolved by the on-chain TWAP (the fixture price rises → UP wins)
let t = await A.chainTime();
while (t % 40 < 2 || t % 40 > 12) { await sleep(1000); t = await A.chainTime(); }
const pa = await A.gameBalance(), pb = await B.gameBalance();
const id = await A.enterPrediction('up', 1);
assert.equal(await B.enterPrediction('down', 1), id);
await assert.rejects(A.enterPrediction('down', 1)); // one entry per wallet per round
ok(`both agents entered prediction round ${id} (one entry per wallet enforced)`);
const advance = async (until) => {
  while ((await A.chainTime()) < until) await sleep(1000);
  for (let i = 0; i < 60; i++) {
    try { await A.advancePrediction(id); return; } catch (e) { if (!/RoundRunning|NotReady/.test(String(e))) throw e; await sleep(1000); }
  }
  throw new Error('round did not advance');
};
await advance(id * 40 + 20);
assert.equal((await A.acc.predRound.fetch(PDA.pred(id))).state, PRED.state.LOCKED);
await advance(id * 40 + 40);
const round = await A.acc.predRound.fetch(PDA.pred(id));
assert.equal(round.state, PRED.state.SETTLED);
assert.equal(round.outcome, PRED.side.UP);
assert.deepEqual(await A.claimPredictions(), [id]);
assert.deepEqual(await B.claimPredictions(), [id]);
assert.equal(Number((await A.gameBalance()) - pa), 0.96 * XNT, 'UP won: +0.96 net');
assert.equal(Number((await B.gameBalance()) - pb), -1 * XNT, 'DOWN lost its stake');
ok('round locked, settled UP by the TWAP, winner claimed 1.96 XNT, loser entry closed');

// 6. Be the House
const quote = await A.houseQuote(2);
assert.ok(quote > 0n);
await A.houseDeposit(2);
const share = await A.acc.houseShare.fetch(PDA.house(alice.publicKey));
assert.ok(BigInt(share.shares.toString()) >= (quote * 99n) / 100n);
ok(`house deposit: ${share.shares.toString()} shares (quote ${quote}, 1% slippage guard)`);

// 7. legalMoves / greedyMove never propose an illegal move on a fresh match state
const war2 = await A.createWar(0.2);
await B.joinWar(war2);
await A.startWar(war2);
const w2 = await A.war(war2);
const legal = A.legalMoves(w2);
assert.ok(legal.some((m) => m.type === 'end'));
assert.ok(legal.every((m) => m.type !== 'attack'), 'no unit can attack on the first turn (summoning sickness)');
const g = A.greedyMove(w2);
assert.ok(legal.some((m) => JSON.stringify(m) === JSON.stringify(g)));
ok(`move generator: ${legal.length} legal moves on turn 1, greedy picks ${g.type}`);

console.log(`\n${passed} checks passed`);
process.exit(0);
