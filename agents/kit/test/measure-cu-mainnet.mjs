// Read-only compute-unit measurement on X1 mainnet against the deployed program.
//
// Simulates every kit instruction the live state allows: nothing is signed (sigVerify off) and nothing is sent. The
// fee payer / signer is an unfunded throwaway keypair first; an unfunded payer cannot be simulated (the runtime
// rejects it before the program runs), so the script then uses the PUBLIC key of an existing account holder for that
// one simulation (the architect wallet from the config account, the holder of a live Artifact, an existing player or
// Be the House position). Instructions the live state cannot reach (no open match, no pending bet...) are reported as
// "no state" and keep their localnet measurement (see agents/README.md "Compute-unit limits").
//
//   node test/measure-cu-mainnet.mjs [--rpc URL] [--json out.json]
import anchor from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { coreOwner, CU_LIMITS, feeLamports, LUNAR_DUST_PRICE, MAINNET_RPC, MPL_CORE, PDA, PRED, PROGRAM_ID, WAR, XDEX_OBSERVATION, XNT } from '../moonforge.mjs';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const RPC = arg('--rpc') ?? MAINNET_RPC;
const here = path.dirname(fileURLToPath(import.meta.url));
const connection = new Connection(RPC, 'confirmed');
const throwaway = Keypair.generate();
const idlPath = [path.resolve(here, '../../../frontend/src/idl/moon_forge.json')].find((p) => fs.existsSync(p));
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(throwaway), { commitment: 'confirmed' });
const idl = idlPath ? JSON.parse(fs.readFileSync(idlPath, 'utf8')) : await anchor.Program.fetchIdl(PROGRAM_ID, provider);
if (idl.address !== PROGRAM_ID.toBase58()) throw new Error('IDL is for another program');
const program = new anchor.Program(idl, provider);
const acc = program.account, m = program.methods;
const bn = (n) => new anchor.BN(n.toString());
const SIM_LIMIT = 400_000; // generous, so the measurement is never capped (the kit uses the same value when measuring on localnet)

async function simulate(name, builder, payer) {
  const ix = await builder.instruction();
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: SIM_LIMIT }), ix] }).compileToV0Message();
  const r = await connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  const logs = r.value.logs ?? [];
  const progErr = logs.find((l) => /Error Code: |custom program error|failed:/.test(l));
  return { name, units: r.value.unitsConsumed ?? 0, err: r.value.err ? JSON.stringify(r.value.err) : null, why: progErr ? progErr.replace(/^Program log: /, '').slice(0, 140) : null, payer: payer.toBase58() };
}

/**
 * Simulates several instructions in ONE transaction (e.g. deposit then placeBet, so a wallet with no game balance can
 * still measure a bet) and reads each top-level Moon Forge instruction's consumption from the logs.
 */
async function simulateChain(steps, payer) {
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })];
  for (const s of steps) ixs.push(await s.builder.instruction());
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const r = await connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  const logs = r.value.logs ?? [], pid = PROGRAM_ID.toBase58(), used = [];
  let depth = 0;
  for (const l of logs) {
    let x;
    if ((x = /^Program (\w+) invoke \[(\d+)\]$/.exec(l))) depth = Number(x[2]);
    else if ((x = /^Program (\w+) consumed (\d+) of \d+ compute units$/.exec(l)) && depth === 1 && x[1] === pid) used.push(Number(x[2]));
    else if (/^Program \w+ (success|failed)/.test(l)) depth = Math.max(0, depth - 1);
  }
  const progErr = logs.find((l) => /Error Code: |custom program error|failed:/.test(l));
  return steps.map((s, i) => ({
    name: `${s.name} (in a chain)`, units: used[i] ?? null, payer: payer.toBase58(),
    err: used[i] == null ? (r.value.err ? JSON.stringify(r.value.err) : 'not reached') : (i === used.length - 1 && r.value.err ? JSON.stringify(r.value.err) : null),
    why: used[i] == null || (i === used.length - 1 && r.value.err) ? (progErr ?? '').replace(/^Program log: /, '').slice(0, 140) || null : null,
  }));
}

const results = [];
const note = (name, why) => results.push({ name, units: null, err: 'no state', why });
/** steps: [[name, makeBuilder], ...]; the earlier steps only set up state, the LAST one is the instruction measured. */
const runChain = async (steps, payer) => {
  try {
    const built = [];
    for (const [name, mk] of steps) built.push({ name, builder: await mk() });
    results.push((await simulateChain(built, payer)).at(-1));
  } catch (e) { results.push({ name: `${steps.at(-1)[0]} (in a chain)`, units: null, err: 'build', why: String(e?.message ?? e).slice(0, 140) }); }
};
const run = async (name, makeBuilder, payer) => {
  try { results.push(await simulate(name, await makeBuilder(), payer)); } catch (e) { results.push({ name, units: null, err: 'build', why: String(e?.message ?? e).slice(0, 140) }); }
};

console.log(`read-only CU simulation on ${RPC} (nothing is signed or sent)`);
const cfg = await acc.config.fetch(PDA.config());
const architect = cfg.architect;

// 0. an unfunded payer: shows why a funded public key is needed for the rest
await run('openPlayer (unfunded payer)', () => m.openPlayer().accountsPartial({ playerState: PDA.player(throwaway.publicKey), owner: throwaway.publicKey, systemProgram: SystemProgram.programId }), throwaway.publicKey);

// survey (small program: unfiltered scans are fine today)
const [records, players, houses, wars, rounds, entries, bets] = await Promise.all(
  ['artifactRecord', 'playerState', 'houseShare', 'war', 'predRound', 'predEntry', 'bet'].map((n) => acc[n].all().catch(() => [])),
);
const infos = [];
for (let i = 0; i < records.length; i += 100) infos.push(...await connection.getMultipleAccountsInfo(records.slice(i, i + 100).map((r) => r.account.asset)));
const live = records.map((r, i) => ({ r, holder: coreOwner(infos[i]) })).filter((x) => x.holder);
console.log(`state: ${records.length} Artifact records (${live.length} live), ${players.length} players, ${houses.length} Be the House positions, ${wars.length} matches, ${rounds.length} prediction rounds, ${entries.length} entries, ${bets.length} pending bets`);
const lamportsOf = async (k) => BigInt(await connection.getBalance(k, 'confirmed'));
const hasPlayer = new Set(players.map((p) => p.account.owner.toBase58()));

// 1. game wallet
const noPlayer = [architect, cfg.oracle, ...live.map((x) => x.holder)].find((k) => !hasPlayer.has(k.toBase58()));
if (noPlayer) await run('openPlayer', () => m.openPlayer().accountsPartial({ playerState: PDA.player(noPlayer), owner: noPlayer, systemProgram: SystemProgram.programId }), noPlayer);
else note('openPlayer', 'every candidate already has a player account');
const funded = [];
for (const p of players) if ((await lamportsOf(p.account.owner)) > 20_000_000n) funded.push(p);
const depositor = funded[0];
if (depositor) {
  const o = depositor.account.owner;
  await run('deposit', () => m.deposit(bn(10_000_000)).accountsPartial({ playerState: PDA.player(o), payer: o, systemProgram: SystemProgram.programId }), o);
} else note('deposit', 'no player with wallet XNT');
const withBalance = players.filter((p) => BigInt(p.account.balance.toString()) >= 10_000_000n);
if (withBalance[0]) {
  const o = withBalance[0].account.owner;
  await run('withdraw', () => m.withdraw(bn(1_000_000)).accountsPartial({ playerState: PDA.player(o), owner: o }), o);
  const ps = PDA.player(o), nonce = BigInt(withBalance[0].account.nonce.toString());
  await run('placeBet', () => m.placeBet(0, bn(0), 0, bn(10_000_000), Array.from(crypto.randomBytes(32))).accountsPartial({
    config: PDA.config(), playerState: ps, bet: PDA.bet(ps, nonce), bankrollVault: PDA.bankrollVault(), rewardVault: PDA.rewardVault(),
    architect, signer: o, systemProgram: SystemProgram.programId,
  }), o);
} else if ((await lamportsOf(architect)) > 100_000_000n) {
  // no game balance anywhere: open (if needed) and fund a game wallet inside the same simulated transaction
  const o = architect, ps = PDA.player(o), existing = players.find((p) => p.account.owner.equals(o));
  const setup = [
    ...(existing ? [] : [['openPlayer', () => m.openPlayer().accountsPartial({ playerState: ps, owner: o, systemProgram: SystemProgram.programId })]]),
    ['deposit', () => m.deposit(bn(50_000_000)).accountsPartial({ playerState: ps, payer: o, systemProgram: SystemProgram.programId })],
  ];
  const nonce = existing ? BigInt(existing.account.nonce.toString()) : 0n;
  await runChain([...setup, ['withdraw', () => m.withdraw(bn(1_000_000)).accountsPartial({ playerState: ps, owner: o })]], o);
  await runChain([...setup, ['placeBet', () => m.placeBet(0, bn(0), 0, bn(10_000_000), Array.from(crypto.randomBytes(32))).accountsPartial({
    config: PDA.config(), playerState: ps, bet: PDA.bet(ps, nonce), bankrollVault: PDA.bankrollVault(), rewardVault: PDA.rewardVault(),
    architect, signer: o, systemProgram: SystemProgram.programId,
  })]], o);
} else { note('withdraw', 'no player with a game balance'); note('placeBet', 'no player with a game balance'); }
const slot = BigInt(await connection.getSlot('confirmed'));
const settleable = bets.find((b) => BigInt(b.account.targetSlot.toString()) < slot);
if (settleable) {
  await run('settleBet', () => m.settleBet().accountsPartial({ config: PDA.config(), bet: settleable.publicKey, playerState: settleable.account.playerState, bankrollVault: PDA.bankrollVault(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: settleable.account.rentPayer }), architect);
} else note('settleBet', 'no pending bet');

// 2. Artifacts
const buyer = (await lamportsOf(architect)) > LUNAR_DUST_PRICE + 50_000_000n ? architect : null;
if (buyer) {
  const serial = cfg.artifactsMinted[0], asset = PDA.asset(0, serial);
  await run('forgeArtifact', () => m.forgeArtifact(0, serial, bn(LUNAR_DUST_PRICE)).accountsPartial({
    config: PDA.config(), asset, record: PDA.artifact(asset), collection: PDA.collection(), artifactAuthority: PDA.artifactAuthority(),
    rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect, buyer, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
  }), buyer);
} else note('forgeArtifact', 'no known wallet with 10 XNT');
const forged = live.find((x) => x.r.account.origin === 0) ?? live[0];
if (forged) {
  const asset = forged.r.account.asset;
  await run(`recycleArtifact (tier ${forged.r.account.tier}, origin ${forged.r.account.origin})`, () => m.recycleArtifact().accountsPartial({
    config: PDA.config(), asset, record: PDA.artifact(asset), collection: PDA.collection(), owner: forged.holder, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
  }), forged.holder);
} else note('recycleArtifact', 'no live Artifact');
const warrior = live.find((x) => players.some((p) => p.account.owner.equals(x.holder) && BigInt(p.account.balance.toString()) >= 100_000_000n));
if (warrior) {
  const o = warrior.holder, ps = PDA.player(o), nonce = BigInt(players.find((p) => p.account.owner.equals(o)).account.nonce.toString());
  await run('createWar', () => m.createWar(bn(100_000_000), o).accountsPartial({
    config: PDA.config(), creatorState: ps, war: PDA.war(o, nonce), owner: o, asset: warrior.r.account.asset, record: PDA.artifact(warrior.r.account.asset), collection: PDA.collection(), systemProgram: SystemProgram.programId,
  }), o);
} else note('createWar', 'no Artifact holder with 0.1 XNT of game balance');
const open = wars.find((w) => w.account.state === WAR.state.OPEN);
if (open) await run('cancelWar', () => m.cancelWar().accountsPartial({ war: open.publicKey, creatorState: PDA.player(open.account.creator), creator: open.account.creator }), open.account.creator);
else { note('cancelWar', 'no open match'); note('joinWar', 'no open match'); }
const starting = wars.find((w) => w.account.state === WAR.state.STARTING);
if (starting) await run('startWar', () => m.startWar().accountsPartial({ war: starting.publicKey, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }), architect);
else note('startWar', 'no match waiting to start');
const active = wars.find((w) => w.account.state === WAR.state.ACTIVE);
if (active) await run('claimWarTimeout', () => m.claimWarTimeout().accountsPartial({ war: active.publicKey }), architect);
else note('claimWarTimeout / moves', 'no active match');
const done = wars.find((w) => w.account.state === WAR.state.DONE);
if (done) {
  await run('settleWar', () => m.settleWar().accountsPartial({
    config: PDA.config(), war: done.publicKey, creatorState: PDA.player(done.account.creator), opponentState: PDA.player(done.account.opponent),
    rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect, rentPayer: done.account.rentPayer,
  }), architect);
} else note('settleWar', 'no finished, unsettled match');

// 3. Predictions exits
const now = Math.floor(Date.now() / 1000);
const lockable = rounds.find((r) => r.account.state === PRED.state.OPEN && Number(r.account.lockTs) <= now);
if (lockable) await run('lockPrediction', () => m.lockPrediction().accountsPartial({ round: lockable.publicKey, observation: XDEX_OBSERVATION }), architect);
else note('lockPrediction', 'no open round past its lock time');
const settle = rounds.find((r) => r.account.state === PRED.state.LOCKED && Number(r.account.endTs) <= now);
if (settle) {
  await run('settlePrediction', () => m.settlePrediction().accountsPartial({ config: PDA.config(), round: settle.publicKey, observation: XDEX_OBSERVATION, rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect }), architect);
} else note('settlePrediction', 'no locked round past its end');
const claimable = entries.find((e) => [PRED.state.SETTLED, PRED.state.REFUND].includes(rounds.find((r) => r.publicKey.equals(e.account.round))?.account.state));
if (claimable) {
  await run('claimPrediction', () => m.claimPrediction().accountsPartial({ config: PDA.config(), round: claimable.account.round, entry: claimable.publicKey, playerState: PDA.player(claimable.account.player), rentPayer: claimable.account.rentPayer }), architect);
} else note('claimPrediction', 'no unclaimed resolved entry');

// 4. Be the House
const lp = (await lamportsOf(architect)) > 1_100_000_000n ? architect : null;
if (lp) await run('houseDeposit', () => m.houseDeposit(bn(XNT), bn(1)).accountsPartial({ config: PDA.config(), share: PDA.house(lp), bankrollVault: PDA.bankrollVault(), owner: lp, systemProgram: SystemProgram.programId }), lp);
else note('houseDeposit', 'no known wallet with 1 XNT');
const pos = houses.find((h) => BigInt(h.account.shares.toString()) > 0n);
if (pos) {
  const o = pos.account.owner;
  await run('houseRequestWithdraw', () => m.houseRequestWithdraw(bn(1)).accountsPartial({ share: PDA.house(o), owner: o }), o);
  const ready = houses.find((h) => BigInt(h.account.pendingShares.toString()) > 0n && Number(h.account.unlockTs) <= now);
  if (ready) await run('houseWithdraw', () => m.houseWithdraw(bn(1)).accountsPartial({ config: PDA.config(), share: PDA.house(ready.account.owner), bankrollVault: PDA.bankrollVault(), owner: ready.account.owner }), ready.account.owner);
  else note('houseWithdraw', 'no matured withdrawal request');
} else if (lp) {
  // no position anywhere: deposit and request in the same simulated transaction (the 24 h cooldown keeps houseWithdraw out of reach)
  await runChain([
    ['houseDeposit', () => m.houseDeposit(bn(XNT), bn(1)).accountsPartial({ config: PDA.config(), share: PDA.house(lp), bankrollVault: PDA.bankrollVault(), owner: lp, systemProgram: SystemProgram.programId })],
    ['houseRequestWithdraw', () => m.houseRequestWithdraw(bn(1)).accountsPartial({ share: PDA.house(lp), owner: lp })],
  ], lp);
  note('houseWithdraw', 'needs a request older than 24 h');
} else { note('houseRequestWithdraw', 'no position'); note('houseWithdraw', 'no position'); }

// report
const key = (n) => n.split(' ')[0];
console.log('\ninstruction                          consumed   kit limit   fee at limit (XNT)   result');
for (const r of results) {
  const lim = CU_LIMITS[key(r.name)];
  const status = r.err ? `${r.err}${r.why ? `: ${r.why}` : ''}` : 'ok';
  console.log(`${r.name.padEnd(36)} ${String(r.units ?? '-').padStart(8)}   ${String(lim ?? '-').padStart(9)}   ${lim ? (feeLamports(lim) / XNT).toFixed(6).padStart(18) : '-'.padStart(18)}   ${status}`);
  if (!r.err && lim && r.units > lim) console.log(`  !! ${r.name} consumed ${r.units} > its limit ${lim}`);
}
console.log(`\nwithout a limit X1 charges for 200,000 units per program instruction: ${(feeLamports(200_000) / XNT).toFixed(4)} XNT per transaction`);
const out = arg('--json');
if (out) fs.writeFileSync(out, JSON.stringify({ rpc: RPC, at: new Date().toISOString(), slot: slot.toString(), results }, null, 2));
const over = results.filter((r) => !r.err && CU_LIMITS[key(r.name)] && r.units > CU_LIMITS[key(r.name)]);
process.exit(over.length ? 1 : 0);
