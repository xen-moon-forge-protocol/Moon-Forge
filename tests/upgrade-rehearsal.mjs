// Driver of tests/run-upgrade.sh (SPEC-UPGRADE-v2 8.5, base SPEC 6.5). One process, because the hold case is timed:
//   run <rpc> <dir>   Phase A on the OLD binary with the OLD IDL (tests/fixtures/idl-onchain-v2.json, the IDL on chain
//                     today), then the in-place upgrade from the buffer run-upgrade.sh wrote (UPGRADE_BUFFER, signed by
//                     UPGRADE_AUTHORITY), sent in the SAME transaction as the last old-binary publish (the hold case),
//                     then Phase B on the NEW binary with the NEW IDL (target/idl/moon_forge.json) and the old IDL.
// REHEARSAL_MODE (the old binary can hold only ONE current jackpot round: config.jackpot_round advances at settle):
//   a (default)  the Phase-A jackpot round is OPEN at the upgrade (drawn by the new draw_jackpot, marker, v2 settle);
//                the hold epoch is voided INSIDE its hold in the first post-upgrade transaction (bond, release check)
//   b            the jackpot round is DRAWING at the upgrade (old-style, winning_ticket 0: legacy settle_jackpot);
//                the hold epoch gets ClaimOnHold, then its claim pays once the hold is over
// Phase A creates: a pending house Bet; the jackpot round (mode a OPEN, mode b DRAWING); an OPEN lottery round with
// tickets; OPEN x2 + JOINED Duels; OPEN, STARTING x2 (one is left > 512 slots) and ACTIVE Wars; a LOCKED and an OPEN
// v1 PredRound with both sides; two HouseShares (one request matured just before the upgrade, one matured > 60 s
// before = the localnet HOUSE_WITHDRAW_WINDOW); Missions of tiers 1 and 2; forged Artifacts (old 50/40/5/5 split, no
// TransferDelegate); epoch A1 (500 leaves, sealed drop, claims), A2 (sealed drop, no claim), A3 (published in the
// upgrade transaction). Every program account is snapshotted right before the upgrade.
// Phase B proves each one exits as SPEC-UPGRADE-v2 6.1 / 8.5 and SPEC-UPGRADE 4.1 / 6.5 say (see the ok lines).
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, 'package.json'));
const anchor = require('@coral-xyz/anchor');
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram,
  SYSVAR_SLOT_HASHES_PUBKEY, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY, TransactionMessage, VersionedTransaction,
} = require('@solana/web3.js');
const { keccak_256 } = require('@noble/hashes/sha3');
// tests/tx-confirm.cjs: wait for the signature itself, never send twice; a landed failure keeps its program error
const TX = require('./tx-confirm.cjs');

const PROGRAM = new PublicKey('57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9');
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const OBS = new PublicKey('4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ');
const SYS = SystemProgram.programId;
const XNT = 1_000_000_000;
const MODE = process.env.REHEARSAL_MODE || 'a';
const [cmd, rpc, dir] = process.argv.slice(2);
if (cmd !== 'run') { console.error('usage: run <rpc> <dir>  (env UPGRADE_BUFFER, UPGRADE_AUTHORITY, REHEARSAL_MODE=a|b)'); process.exit(2); }
const conn = new Connection(rpc, 'confirmed');
const OLD_IDL = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/idl-onchain-v2.json'), 'utf8'));
const NEW_IDL = JSON.parse(fs.readFileSync(path.join(here, '../target/idl/moon_forge.json'), 'utf8'));
const kp = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, 'utf8'))));
const fixture = (f) => kp(path.join(here, 'fixtures', f));
const oracle = fixture('test-oracle.json'), architect = fixture('test-architect.json'), keeperKey = fixture('test-keeper.json');
const authority = kp(process.env.UPGRADE_AUTHORITY);
const BUFFER = new PublicKey(process.env.UPGRADE_BUFFER);
const BN = (v) => new anchor.BN(v.toString());
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (...s) => PublicKey.findProgramAddressSync(s.map((x) => (typeof x === 'string' ? Buffer.from(x) : x instanceof PublicKey ? x.toBuffer() : x)), PROGRAM)[0];
const keccak = (...p) => { const h = keccak_256.create(); p.forEach((x) => h.update(x)); return Buffer.from(h.digest()); };
const hashPair = (a, b) => (Buffer.compare(a, b) <= 0 ? keccak(a, b) : keccak(b, a));
const claimLeaf = (e, p, t, s) => keccak(Buffer.from('MOONFORGE_V2_CLAIM'), u64(e), p.toBuffer(), Buffer.from([t]), u64(s));
const rnd = (h, a, b) => keccak(Buffer.from('MOONFORGE_RNG'), h, a, b).readBigUInt64LE(0);
const big = (x) => BigInt(x.toString());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tree(leaves) {
  const layers = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const c = layers[layers.length - 1], n = [];
    for (let i = 0; i < c.length; i += 2) n.push(i + 1 < c.length ? hashPair(c[i], c[i + 1]) : c[i]);
    layers.push(n);
  }
  const proof = (idx) => { const out = []; for (let l = 0; l < layers.length - 1; l++) { const s = idx ^ 1; if (s < layers[l].length) out.push(Array.from(layers[l][s])); idx >>= 1; } return out; };
  return { root: layers[layers.length - 1][0], proof };
}
class KeeperChain { // x_N = seed, x_k = keccak(x_{k+1}); tip = x_0; the reveal of position k is x_{k+1}
  constructor(seed, length) { const v = [seed]; for (let i = 0; i < length; i++) v.push(keccak(v[v.length - 1])); this.xs = v.reverse(); }
  get tip() { return this.xs[0]; }
  reveal(k) { return this.xs[Number(k) + 1]; }
}
const betUnpack = (ts) => ({ index: ts >> 40n, anchor: ts & ((1n << 40n) - 1n) });

let failures = 0, passes = 0;
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const ok = (m) => { passes++; console.log(`  ok   ${stamp()} ${m}`); };
const bad = (m) => { failures++; console.log(`  FAIL ${stamp()} ${m}`); };
const note = (m) => console.log(`  note ${stamp()} ${m}`);
const check = (cond, m) => (cond ? ok : bad)(m);
const MSGS = Object.fromEntries([...(OLD_IDL.errors || []), ...(NEW_IDL.errors || [])].map((e) => [e.name, e.msg]));
const errText = (e) => String(e) + ' ' + JSON.stringify(e?.logs ?? e?.transactionLogs ?? '') + ' ' + (e?.error?.errorCode?.code ?? '');
const errIs = (t, c) => t.includes(c) || (!!MSGS[c] && t.includes(MSGS[c]));
async function expectErr(label, p, codes) {
  const want = [].concat(codes);
  try { await p; bad(`${label}: succeeded, expected ${want.join('|')}`); } catch (e) {
    const t = errText(e); const c = want.find((x) => errIs(t, x));
    c ? ok(`${label}: refused with ${c}`) : bad(`${label}: expected ${want.join('|')}, got ${t.slice(0, 500)}`);
  }
}
async function step(label, f) { try { await f(); } catch (e) { bad(`${label}: ${errText(e).slice(0, 700)}`); } }
async function retry(codes, f, tries = 120, ms = 500) {
  for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (!codes.some((c) => errIs(errText(e), c)) || i >= tries) throw e; await sleep(ms); } }
}
const bal = (k) => conn.getBalance(k, 'confirmed');
const slotNow = async (c = 'confirmed') => BigInt(await conn.getSlot(c));
const waitPastSlot = async (target) => { for (;;) { if ((await slotNow()) > target + 1n) return; await sleep(250); } };
const chainTime = async () => (await conn.getBlockTime(await conn.getSlot('confirmed')));
const untilChainTime = async (t) => { while ((await chainTime()) < t) await sleep(400); };
async function slotHashAtOrAfter(target) {
  const d = (await conn.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, 'confirmed')).data;
  const len = Number(d.readBigUInt64LE(0)); let best = null;
  for (let i = 0; i < len; i++) { const o = 8 + i * 40; if (d.readBigUInt64LE(o) >= target) best = Buffer.from(d.subarray(o + 8, o + 40)); else break; }
  return best;
}
const fundOne = async (k, xnt) => TX.airdrop(conn, k, xnt * XNT);
const provider = (signer) => TX.hardenProvider(new anchor.AnchorProvider(conn, new anchor.Wallet(signer), { commitment: 'confirmed', preflightCommitment: 'confirmed' }));
const OLD = (signer) => new anchor.Program(OLD_IDL, provider(signer));
const NEW = (signer) => new anchor.Program(NEW_IDL, provider(signer));
async function sendIxs(ixs, signers, commitment = 'confirmed') {
  return TX.sendOnce(conn, new Transaction().add(...ixs), signers, { commitment });
}
async function simulate(ix, payerKey) {
  const { blockhash } = await conn.getLatestBlockhash('processed');
  const msg = new TransactionMessage({ payerKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' });
  const logs = r.value.logs || [];
  return logs.map((l) => l.match(/Error Code: (\w+)/)).find(Boolean)?.[1] ?? (r.value.err ? JSON.stringify(r.value.err) : 'ok');
}

const P = {
  config: pda('config'), reward: pda('reward_vault'), bankroll: pda('bankroll_vault'), draw: pda('draw_vault'),
  collection: pda('collection'), authority: pda('artifact_authority'), seat: pda('oracle_seat'), keeper: pda('house_keeper'),
  extraState: pda('extra_state'), extraVault: pda('extra_vault'),
  epoch: (n) => pda('epoch', u64(n)), receipt: (n, p, t) => pda('receipt', u64(n), p, Buffer.from([t])),
  mission: (n, p, t) => pda('mission', u64(n), p, Buffer.from([t])), player: (o) => pda('player', o),
  bet: (ps, n) => pda('bet', ps, u64(n)), house: (o) => pda('house', o), jackpot: (r) => pda('jackpot', u64(r)),
  jpEntry: (r, i) => pda('jp_entry', u64(r), u32(i)), drawRound: (r) => pda('draw', u64(r)), drawEntry: (r, i) => pda('draw_entry', u64(r), u32(i)),
  duel: (c, n) => pda('duel', c, u64(n)), war: (c, n) => pda('war', c, u64(n)), asset: (t, s) => pda('asset', Buffer.from([t]), u32(s)),
  artifact: (a) => pda('artifact', a), drop: (n, p, t) => pda('drop', u64(n), p, Buffer.from([t])), pred: (r) => pda('pred', u64(r)),
  predEntry: (r, p) => pda('pred_entry', u64(r), p), listing: (a) => pda('listing', a),
};
const idlAddress = async () => PublicKey.createWithSeed(PublicKey.findProgramAddressSync([], PROGRAM)[0], 'anchor:idl', PROGRAM);
async function snapshotAll() {
  const idlAcc = (await idlAddress()).toBase58();
  const accs = await conn.getProgramAccounts(PROGRAM, { encoding: 'base64', commitment: 'confirmed' });
  const out = {};
  for (const a of accs) if (a.pubkey.toBase58() !== idlAcc) out[a.pubkey.toBase58()] = { lamports: a.account.lamports, data: Buffer.from(a.account.data) };
  return out;
}
async function fetchMany(keys, commitment = 'confirmed') {
  const out = {};
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const r = await conn.getMultipleAccountsInfo(chunk.map((k) => new PublicKey(k)), commitment);
    r.forEach((a, j) => { out[chunk[j]] = a ? { lamports: a.lamports, data: Buffer.from(a.data) } : null; });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase A — OLD binary, OLD IDL
// ═══════════════════════════════════════════════════════════════════════════
const payer = Keypair.generate(), lp1 = Keypair.generate(), lp2 = Keypair.generate();
const alice = Keypair.generate(), bob = Keypair.generate(), carol = Keypair.generate(), dave = Keypair.generate(), eve = Keypair.generate();
console.log(`upgrade rehearsal, mode ${MODE}`);
await fundOne(payer.publicKey, 6000);
for (const k of [lp1, lp2, alice, bob, carol, dave, eve, oracle, architect, keeperKey]) await fundOne(k.publicKey, 600);
const A = OLD(payer);
await A.methods.initializeV2().accountsPartial({ config: P.config, rewardVault: P.reward, bankrollVault: P.bankroll, drawVault: P.draw, collection: P.collection, artifactAuthority: P.authority, payer: payer.publicKey, systemProgram: SYS }).rpc();
await A.methods.initArtifacts().accountsPartial({ config: P.config, collection: P.collection, artifactAuthority: P.authority, payer: payer.publicKey, coreProgram: CORE, systemProgram: SYS }).rpc();
await A.methods.donate(0, BN(3000 * XNT)).accountsPartial({ config: P.config, donor: payer.publicKey, vault: P.reward }).rpc();
const houseDeposit = (k, xnt) => OLD(k).methods.houseDeposit(BN(xnt * XNT), BN(0)).accountsPartial({ config: P.config, share: P.house(k.publicKey), bankrollVault: P.bankroll, owner: k.publicKey, systemProgram: SYS }).rpc();
const houseRequest = async (k) => { const s = await A.account.houseShare.fetch(P.house(k.publicKey)); return OLD(k).methods.houseRequestWithdraw(BN(big(s.shares) / 2n)).accountsPartial({ share: P.house(k.publicKey), owner: k.publicKey }).rpc(); };
await houseDeposit(lp1, 300); await houseDeposit(lp2, 100);
await houseRequest(lp1); // matures 1 s later: > HOUSE_WITHDRAW_WINDOW (60 s on localnet) before Phase B -> WithdrawExpired, renewed
for (const k of [alice, bob, carol, dave]) {
  await OLD(k).methods.openPlayer().accountsPartial({ playerState: P.player(k.publicKey), owner: k.publicKey, systemProgram: SYS }).rpc();
  await OLD(k).methods.deposit(BN(40 * XNT)).accountsPartial({ playerState: P.player(k.publicKey), payer: k.publicKey, systemProgram: SYS }).rpc();
}
// forged Artifacts (old split 50/40/5/5, old attributes, no TransferDelegate)
const forgeOld = async (k, tier) => {
  const serial = (await A.account.config.fetch(P.config)).artifactsMinted[tier];
  const asset = P.asset(tier, serial);
  await OLD(k).methods.forgeArtifact(tier, serial, BN('18446744073709551615')).accountsPartial({
    config: P.config, asset, record: P.artifact(asset), collection: P.collection, artifactAuthority: P.authority, rewardVault: P.reward,
    drawVault: P.draw, architect: architect.publicKey, buyer: k.publicKey, coreProgram: CORE, systemProgram: SYS,
  }).rpc();
  return asset;
};
const pool0 = await bal(P.reward);
const aliceLunar = await forgeOld(alice, 0);
check((await bal(P.reward)) - pool0 === 4 * XNT, 'phase A: old forge split, 40% of a 10-XNT Lunar to the pool');
const bobCosmic = await forgeOld(bob, 1);
const carolLunar = await forgeOld(carol, 0);
const ticket = (k, asset) => ({ asset, record: P.artifact(asset), collection: P.collection });
const nonceOf = async (o) => Number((await A.account.playerState.fetch(P.player(o))).nonce);
// duels: OPEN (cancelled in B), OPEN (joined sealed in B), JOINED (legacy element; times out in B)
const duelSalt = (i) => Buffer.alloc(32, 0x30 + i);
const createDuel = async (stake, i) => {
  const duel = P.duel(alice.publicKey, await nonceOf(alice.publicKey));
  const c = keccak(Buffer.from('MOONFORGE_DUEL'), Buffer.from([0]), duelSalt(i), duel.toBuffer());
  await OLD(alice).methods.createDuel(BN(stake), Array.from(c)).accountsPartial({ config: P.config, creatorState: P.player(alice.publicKey), duel, owner: alice.publicKey, ...ticket(alice, aliceLunar), systemProgram: SYS }).rpc();
  return duel;
};
const duelCancel = await createDuel(0.2 * XNT, 1), duelSealed = await createDuel(0.3 * XNT, 2), duelJoined = await createDuel(0.4 * XNT, 3);
await OLD(bob).methods.joinDuel(1).accountsPartial({ config: P.config, duel: duelJoined, opponentState: P.player(bob.publicKey), opponent: bob.publicKey, ...ticket(bob, bobCosmic) }).rpc();
// wars: OPEN; STARTING joined early (left > 512 slots); ACTIVE; STARTING joined late (started in B)
const createWar = async (stake) => {
  const war = P.war(alice.publicKey, await nonceOf(alice.publicKey));
  await OLD(alice).methods.createWar(BN(stake), PublicKey.default).accountsPartial({ config: P.config, creatorState: P.player(alice.publicKey), war, owner: alice.publicKey, ...ticket(alice, aliceLunar), systemProgram: SYS }).rpc();
  return war;
};
const joinWar = (war) => OLD(bob).methods.joinWar(PublicKey.default).accountsPartial({ config: P.config, war, opponentState: P.player(bob.publicKey), opponent: bob.publicKey, ...ticket(bob, bobCosmic) }).rpc();
const warOpen = await createWar(0.2 * XNT), warExpire = await createWar(0.3 * XNT), warActive = await createWar(0.4 * XNT), warStart = await createWar(0.5 * XNT);
await joinWar(warExpire);
await joinWar(warActive);
await waitPastSlot(big((await A.account.war.fetch(warActive)).targetSlot));
await retry(['NotReady'], () => A.methods.startWar().accountsPartial({ war: warActive, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).rpc());
check((await A.account.war.fetch(warActive)).state === 2, 'phase A: legacy war ACTIVE (old start_war, fixed turns)');
// jackpot round (OPEN; mode b draws it right before the upgrade)
const jr = Number((await A.account.config.fetch(P.config)).jackpotRound);
for (const [i, k, amt] of [[0, alice, 1], [1, bob, 2]]) await OLD(k).methods.enterJackpot(BN(jr), i, BN(amt * XNT)).accountsPartial({ config: P.config, round: P.jackpot(jr), entry: P.jpEntry(jr, i), playerState: P.player(k.publicKey), signer: k.publicKey, systemProgram: SYS }).rpc();
// lottery round OPEN with tickets
const dr = Number((await A.account.config.fetch(P.config)).drawRound);
for (const [i, k, t] of [[0, alice, 1], [1, bob, 2]]) await OLD(k).methods.enterDraw(BN(dr), i, BN(0), BN(t)).accountsPartial({ config: P.config, round: P.drawRound(dr), entry: P.drawEntry(dr, i), playerState: P.player(k.publicKey), rewardVault: P.reward, drawVault: P.draw, architect: architect.publicKey, signer: k.publicKey, systemProgram: SYS }).rpc();

// v1 predictions (old localnet schedule: period 40 s, entries for 20 s, lock at +20, end at +40): round r LOCKED and
// round r+1 OPEN at the upgrade; the epochs and the upgrade fit inside round r+1's entry window
const enterPred = (k, r, side) => OLD(k).methods.enterPrediction(BN(r), side, BN(XNT)).accountsPartial({ round: P.pred(r), entry: P.predEntry(r, k.publicKey), playerState: P.player(k.publicKey), owner: k.publicKey, systemProgram: SYS }).rpc();
let ct = await chainTime();
while (ct % 40 < 1 || ct % 40 > 12) { await sleep(500); ct = await chainTime(); }
const pr = Math.floor(ct / 40);
await enterPred(alice, pr, 1); await enterPred(bob, pr, 0);
await untilChainTime(pr * 40 + 20);
await retry(['RoundRunning', 'NotReady'], () => A.methods.lockPrediction().accountsPartial({ round: P.pred(pr), observation: OBS }).rpc());
check((await A.account.predRound.fetch(P.pred(pr))).state === 1, `phase A: v1 PredRound ${pr} LOCKED`);
await untilChainTime((pr + 1) * 40 + 1);
await enterPred(alice, pr + 1, 1); await enterPred(bob, pr + 1, 0);
ok(`phase A: v1 PredRound ${pr + 1} OPEN with both sides`);

// a pending legacy house bet (bit 7 clear), settled in B through the OLD IDL
const bobPs = P.player(bob.publicKey);
const betNonce = await nonceOf(bob.publicKey);
const betPk = P.bet(bobPs, betNonce);
const betSeed = Buffer.alloc(32, 7);
await OLD(bob).methods.placeBet(0, BN(0), 1, BN(0.1 * XNT), Array.from(betSeed)).accountsPartial({ config: P.config, playerState: bobPs, bet: betPk, bankrollVault: P.bankroll, rewardVault: P.reward, architect: architect.publicKey, signer: bob.publicKey, systemProgram: SYS }).rpc();
await joinWar(warStart); // STARTING, started in B within 512 slots
await houseRequest(lp2); // matures 1 s later, still inside the 60-s window when Phase B starts

// epochs: A1 (500 leaves, sealed drop, claims incl. two Missions), A2 (sealed drop, no claim), A3 (in the upgrade tx)
const others = Array.from({ length: 494 }, () => Keypair.generate().publicKey);
const E1 = [
  { p: alice.publicKey, t: 0, s: 500_000n }, // 50% of the score: drop value >= the 5-XNT backing -> a certain drop (LB-6)
  { p: bob.publicKey, t: 0, s: 20_000n }, // claimed instantly in A
  { p: carol.publicKey, t: 1, s: 20_000n }, // Orbit Mission (tier 1), withdrawn in B
  { p: dave.publicKey, t: 2, s: 20_000n }, // Moon Landing Mission (tier 2), ejected in B
  { p: eve.publicKey, t: 0, s: 20_000n }, // claimed in B (old-style claim after the upgrade)
  { p: lp1.publicKey, t: 0, s: 20_000n },
  ...others.map((p, i) => ({ p, t: 0, s: 400_000n / 494n + (i < Number(400_000n % 494n) ? 1n : 0n) })),
];
const total1 = E1.reduce((a, l) => a + l.s, 0n);
const t1 = tree(E1.map((l) => claimLeaf(1, l.p, l.t, l.s)));
const BIG_CAP = 1_000_000_000_000_000n;
const publishIx = async (n, root, totalScore, leaves) => OLD(oracle).methods.publishEpoch(BN(n), Array.from(root), Array.from(Buffer.alloc(32, n)), BN(totalScore), leaves, BN(BIG_CAP))
  .accountsPartial({ config: P.config, epoch: P.epoch(n), rewardVault: P.reward, oracle: oracle.publicKey, systemProgram: SYS }).instruction();
const publishOld = async (n, root, totalScore, leaves) => retry(['EpochTooSoon'], async () => sendIxs([await publishIx(n, root, totalScore, leaves)], [oracle]), 40, 500);
const sealOld = async (n) => { await waitPastSlot(big((await A.account.epoch.fetch(P.epoch(n))).dropSlot)); await retry(['NotReady', 'DropNotReady'], () => A.methods.sealDrop().accountsPartial({ config: P.config, epoch: P.epoch(n), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).rpc(), 20, 400); };
const claimAcc = (n, l, payerK) => ({ config: P.config, epoch: P.epoch(n), receipt: P.receipt(n, l.p, l.t), player: l.p, playerState: P.player(l.p), rewardVault: P.reward, payer: payerK.publicKey, systemProgram: SYS });
await publishOld(1, t1.root, total1, E1.length);
const e1 = await A.account.epoch.fetch(P.epoch(1));
check(e1.dropState === 1 && big(e1.dropReserve) * 9n <= big(e1.budget) + 9n && big(e1.dropReserve) > 0n, `phase A: epoch A1 published by the old binary (${E1.length} leaves, budget ${Number(e1.budget) / XNT} XNT, drop_reserve ${Number(e1.dropReserve) / XNT} XNT)`);
await A.methods.claimInstant(BN(1), 0, BN(E1[1].s), t1.proof(1)).accountsPartial(claimAcc(1, E1[1], payer)).rpc();
for (const i of [2, 3]) await A.methods.claimMission(BN(1), E1[i].t, BN(E1[i].s), t1.proof(i)).accountsPartial({ ...claimAcc(1, E1[i], payer), mission: P.mission(1, E1[i].p, E1[i].t) }).rpc();
await sealOld(1);
check((await A.account.epoch.fetch(P.epoch(1))).dropState === 2, 'phase A: A1 sealed; one instant claim and two Missions (tiers 1, 2) half-vesting');
const t2 = tree([claimLeaf(2, alice.publicKey, 0, 600n), claimLeaf(2, bob.publicKey, 0, 400n)]);
await publishOld(2, t2.root, 1000n, 2);
await sealOld(2);
check((await A.account.epoch.fetch(P.epoch(2))).dropState === 2, 'phase A: A2 published and sealed, no claim');
if (MODE === 'b') {
  await retry(['RoundRunning'], () => A.methods.drawJackpot().accountsPartial({ config: P.config, round: P.jackpot(jr), firstPlayerState: P.player(alice.publicKey) }).rpc());
  const r = await A.account.jackpotRound.fetch(P.jackpot(jr));
  check(r.state === 1 && big(r.winningTicket) === 0n, 'phase A (mode b): jackpot round DRAWING, old-style (winning_ticket 0)');
}
const chips0 = Object.fromEntries(await Promise.all([alice, bob, carol, dave].map(async (k) => [k.publicKey.toBase58(), Number((await A.account.playerState.fetch(P.player(k.publicKey))).chips)])));
const dueTimes = { lp2Unlock: Number((await A.account.houseShare.fetch(P.house(lp2.publicKey))).unlockTs) };

const newArch = Keypair.generate(); // the OD-22 payee of set_architect (S7 step 4)
await fundOne(newArch.publicKey, 50);
// snapshot, then A3 + the upgrade in ONE transaction (SPEC 9.2 "deploy --buffer", here the loader's Upgrade ix)
const snapA = await snapshotAll();
const E3 = [{ p: eve.publicKey, t: 0, s: 700n }, { p: carol.publicKey, t: 0, s: 300n }];
const t3 = tree(E3.map((l) => claimLeaf(3, l.p, l.t, l.s)));
const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], LOADER)[0];
const upgradeIx = new TransactionInstruction({
  programId: LOADER, data: Buffer.from([3, 0, 0, 0]),
  keys: [
    { pubkey: programData, isSigner: false, isWritable: true }, { pubkey: PROGRAM, isSigner: false, isWritable: true },
    { pubkey: BUFFER, isSigner: false, isWritable: true }, { pubkey: authority.publicKey, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: authority.publicKey, isSigner: true, isWritable: false },
  ],
});
// the old interval (6 s) since A2 must have passed before the combined transaction
const a2 = await A.account.epoch.fetch(P.epoch(2));
await untilChainTime(Number(a2.publishedAt) + 7);
const upSig = await sendIxs([await publishIx(3, t3.root, 1000n, 2), upgradeIx], [oracle, authority], 'processed');
const upSlot = BigInt((await conn.getSignatureStatus(upSig)).value.slot);

// ═══════════════════════════════════════════════════════════════════════════
// Phase B — NEW binary
// ═══════════════════════════════════════════════════════════════════════════
while ((await slotNow('processed')) <= upSlot) await sleep(40); // the upgrade is visible from the next slot
const B = NEW(payer);
const claimA3 = (i, payerK) => B.methods.claimInstant(BN(3), 0, BN(E3[i].s), t3.proof(i)).accountsPartial(claimAcc(3, E3[i], payerK));
const holdSim = await simulate(await claimA3(0, payer).instruction(), payer.publicKey);
const after = await fetchMany(Object.keys(snapA), 'processed');
// S7 first run, 6.3 steps 3-6 in one transaction (mode a adds the void of A3 inside its hold)
const e3 = await A.account.epoch.fetch(P.epoch(3), 'processed');
const cfgBeforeVoid = await B.account.config.fetch(P.config, 'processed');
const voidBond = (big(e3.budget) + big(e3.dropReserve)) / 10n + 1n;
const s7 = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
  await B.methods.refreshCollectionUri().accountsPartial({ config: P.config, collection: P.collection, artifactAuthority: P.authority, payer: payer.publicKey, coreProgram: CORE, systemProgram: SYS }).instruction(),
  await B.methods.setArchitect(newArch.publicKey).accountsPartial({ config: P.config, architect: architect.publicKey, newArchitect: newArch.publicKey, rewardVault: P.reward }).instruction(),
  await B.methods.lockCollectionRoyalties().accountsPartial({ config: P.config, collection: P.collection, artifactAuthority: P.authority, architect: newArch.publicKey, coreProgram: CORE, systemProgram: SYS }).instruction(),
  await B.methods.initSeat().accountsPartial({ config: P.config, seat: P.seat, rewardVault: P.reward, payer: payer.publicKey, systemProgram: SYS }).instruction(),
];
s7[2].keys.find((k) => k.pubkey.equals(newArch.publicKey)).isSigner = true; // both keys sign set_architect (6.3 step 4)
if (MODE === 'a') s7.push(await B.methods.voidEpoch(BN(3), BN(voidBond)).accountsPartial({ config: P.config, epoch: P.epoch(3), seat: P.seat, rewardVault: P.reward, voider: payer.publicKey, systemProgram: SYS }).instruction());
const txOf = async (sig) => { for (;;) { const x = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); if (x) return x; await sleep(100); } };
let voided = false;
try {
  const sig = await sendIxs(s7, [payer, architect, newArch], 'processed');
  voided = MODE === 'a';
  const [up, t] = [await txOf(upSig), await txOf(sig)];
  ok(`S6: A3 published by the old binary and the program upgraded in place in the same transaction (slot ${upSlot}, block time ${up.blockTime})`);
  check(holdSim === 'ClaimOnHold', `hold case: a claim on A3 simulated in the first post-upgrade slot -> ${holdSim}`);
  ok(`S7 steps 3-6 (refresh_collection_uri, set_architect, lock_collection_royalties, init_seat)${MODE === 'a' ? ' + void_epoch(A3)' : ''} in one transaction, slot ${t.slot} (A3 + ${t.blockTime - up.blockTime} s)`);
} catch (e) {
  bad(`S7 steps 3-6${MODE === 'a' ? ' + void_epoch(A3) inside its hold' : ''}: ${errText(e).slice(0, 600)}`);
  if (MODE === 'a') { s7.pop(); await step('S7 steps 3-6 without the void', async () => { await sendIxs(s7, [payer, architect, newArch]); ok('S7 steps 3-6 resent without the void'); }); }
}
// byte-compare (read in the first post-upgrade slot, before any new-binary write)
{
  let same = 0; const diff = [];
  for (const [k, s] of Object.entries(snapA)) { const a = after[k]; if (a && a.lamports === s.lamports && a.data.equals(s.data)) same++; else diff.push(k); }
  // Config, reward_vault and A3 were written by the A3 publish inside the upgrade transaction (old binary, before the upgrade)
  const expectedDiff = new Set([P.config.toBase58(), P.reward.toBase58()]);
  const unexpected = diff.filter((k) => !expectedDiff.has(k));
  check(unexpected.length === 0, `after the in-place upgrade: ${same}/${Object.keys(snapA).length} Phase-A accounts byte-identical (+ Config and reward_vault written only by the A3 publish in the upgrade tx)${unexpected.length ? ` CHANGED: ${unexpected.join(' ')}` : ''}`);
  const discs = Object.fromEntries(NEW_IDL.accounts.map((a) => [Buffer.from(a.discriminator).toString('hex'), a.name]));
  const coder = new anchor.BorshAccountsCoder(NEW_IDL);
  const oldCoder = new anchor.BorshAccountsCoder(OLD_IDL);
  const oldDiscs = Object.fromEntries(OLD_IDL.accounts.map((a) => [Buffer.from(a.discriminator).toString('hex'), a.name]));
  let decoded = 0, oldDecoded = 0; const left = [], kinds = {};
  for (const [k, s] of Object.entries(after)) {
    const name = discs[s.data.subarray(0, 8).toString('hex')];
    if (name) { try { coder.decode(name, s.data); decoded++; kinds[name] = (kinds[name] || 0) + 1; } catch (e) { bad(`decode ${name} ${k}: ${e}`); } } else left.push(`${k.slice(0, 6)}:${s.data.length}B`);
    const on = oldDiscs[s.data.subarray(0, 8).toString('hex')];
    if (on) { try { oldCoder.decode(on, s.data); oldDecoded++; } catch (e) { bad(`old-IDL decode ${on} ${k}: ${e}`); } }
  }
  check(left.length === 3 && left.every((x) => x.endsWith(':8B')), `decode: ${decoded} accounts decode with the new IDL and ${oldDecoded} with the old IDL; leftovers ${left.join(' ')} (the three 8-B vaults)`);
  note(`Phase-A account kinds: ${Object.entries(kinds).map(([n, c]) => `${n} ${c}`).join(', ')}`);
}
const e3After = await B.account.epoch.fetch(P.epoch(3));
const cfgAfterVoid = await B.account.config.fetch(P.config);
if (voided) {
  const released = big(cfgBeforeVoid.rewardReserved) - big(cfgAfterVoid.rewardReserved);
  const want = big(e3.budget) - big(e3.claimed) + big(e3.dropReserve) - big(e3.dropPaid);
  check(e3After.closed && released === want, `void_epoch(A3) inside its hold: closed, reward_reserved -${Number(released) / XNT} XNT = budget - claimed + drop_reserve - drop_paid (${Number(want) / XNT})`);
  await expectErr('claim on the voided A3', claimA3(0, payer).rpc(), 'EpochClosed');
  await expectErr('expire_epoch on the voided A3', B.methods.expireEpoch().accountsPartial({ config: P.config, epoch: P.epoch(3) }).rpc(), 'EpochClosed');
}
const cfgNow = async () => B.account.config.fetch(P.config);
check((await cfgNow()).architect.equals(newArch.publicKey), 'set_architect: config.architect = the new key');
{
  const col = Buffer.from((await conn.getAccountInfo(P.collection)).data);
  check(col.includes(newArch.publicKey.toBuffer()) && col.includes(Buffer.from([0xf4, 0x01])), 'lock_collection_royalties: Royalties 500 bps, creator = config.architect');
  await expectErr('lock_collection_royalties twice', NEW(newArch).methods.lockCollectionRoyalties().accountsPartial({ config: P.config, collection: P.collection, artifactAuthority: P.authority, architect: newArch.publicKey, coreProgram: CORE, systemProgram: SYS }).rpc(), ['CannotRedelegate', 'Error', '']);
}
await step('init_extra', async () => { await B.methods.initExtra().accountsPartial({ config: P.config, extraState: P.extraState, extraVault: P.extraVault, payer: payer.publicKey, systemProgram: SYS }).rpc(); ok('init_extra (6.3 step 7)'); });
const chain = new KeeperChain(keccak(Buffer.from('rehearsal-chain'), u64(Date.now())), 32);
await step('arm_keeper', async () => {
  await NEW(keeperKey).methods.armKeeper(Array.from(chain.tip), BN(32), BN(20 * XNT)).accountsPartial({ config: P.config, keeperSeat: P.keeper, keeper: keeperKey.publicKey, bankrollVault: P.bankroll, rewardVault: P.reward, systemProgram: SYS }).rpc();
  ok('arm_keeper (6.3 step 8; test INITIAL_KEEPER, chain of 32, 20 XNT bond)');
});
const arch = () => newArch.publicKey;
const gameBal = async (o) => big((await B.account.playerState.fetch(P.player(o))).balance);

// HouseShare: the request matured just before the upgrade is usable (OLD IDL client); the one matured > 60 s ago is renewed
await step('house_withdraw (lp2, old IDL)', async () => {
  const now = await chainTime();
  const w0 = await bal(lp2.publicKey);
  await OLD(lp2).methods.houseWithdraw(BN(0)).accountsPartial({ config: P.config, share: P.house(lp2.publicKey), bankrollVault: P.bankroll, owner: lp2.publicKey }).rpc();
  check((await bal(lp2.publicKey)) > w0 + 40 * XNT, `HouseShare (request matured ${now - dueTimes.lp2Unlock} s ago, inside the window): house_withdraw through the OLD IDL pays`);
});
await step('house_withdraw (lp1 expired)', async () => {
  const hw = () => B.methods.houseWithdraw(BN(0)).accountsPartial({ config: P.config, share: P.house(lp1.publicKey), bankrollVault: P.bankroll, owner: lp1.publicKey }).signers([lp1]).rpc();
  await expectErr('HouseShare matured > 60 s before: house_withdraw', hw(), 'WithdrawExpired');
  const s = await B.account.houseShare.fetch(P.house(lp1.publicKey));
  await B.methods.houseRequestWithdraw(BN(big(s.shares) / 2n)).accountsPartial({ share: P.house(lp1.publicKey), owner: lp1.publicKey }).signers([lp1]).rpc();
  const w0 = await bal(lp1.publicKey);
  await retry(['WithdrawLocked'], hw, 40, 300);
  check((await bal(lp1.publicKey)) > w0 + 50 * XNT, 'HouseShare: renewed request, house_withdraw pays after the 1-s localnet delay');
});
// the legacy bet settles single-block, through the OLD IDL (an old keeper client)
await step('legacy bet', async () => {
  const bet = await A.account.bet.fetch(betPk);
  check((bet.game & 0x80) === 0, `legacy Bet pending at the upgrade (game ${bet.game}, target ${bet.targetSlot})`);
  const b0 = await gameBal(bob.publicKey);
  await retry(['NotReady'], () => OLD(payer).methods.settleBet().accountsPartial({ config: P.config, bet: betPk, playerState: bobPs, bankrollVault: P.bankroll, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: bet.rentPayer }).rpc());
  const h = await slotHashAtOrAfter(big(bet.targetSlot));
  const delta = (await gameBal(bob.publicKey)) - b0;
  if (h) {
    const roll = rnd(h, betPk.toBuffer(), betSeed) % 10_000n;
    const won = roll >= 5000n; // choice 1
    check(delta === (won ? big(bet.payout) : 0n), `legacy bet settled through the OLD IDL with the single-block roll ${roll} (${won ? 'won' : 'lost'}, +${Number(delta) / XNT} XNT)`);
  } else check(delta === 0n, 'legacy bet: its block left SlotHashes, Expired = lost (unchanged rule)');
  check((await conn.getAccountInfo(betPk)) === null && big((await cfgNow()).bankrollReserved) === 0n, 'legacy bet closed, bankroll_reserved back to 0');
});
// v1 predictions: the LOCKED round settles, the OPEN round locks then settles; every entry claims; rounds close
const predLock = async (r) => {
  const round = await B.account.predRound.fetch(P.pred(r));
  if (round.state === 0) await retry(['RoundRunning', 'NotReady'], () => B.methods.lockPrediction().accountsPartial({ round: P.pred(r), observation: OBS }).rpc());
  const r1 = await B.account.predRound.fetch(P.pred(r));
  note(`v1 PredRound ${r}: lock_prediction on the new binary -> state ${r1.state}`);
};
const predExit = async (r) => {
  await predLock(r);
  const r1 = await B.account.predRound.fetch(P.pred(r));
  if (r1.state === 1) await retry(['RoundRunning', 'NotReady'], () => B.methods.settlePrediction().accountsPartial({ config: P.config, round: P.pred(r), observation: OBS, rewardVault: P.reward, drawVault: P.draw, architect: arch() }).rpc());
  const r2 = await B.account.predRound.fetch(P.pred(r));
  const before = (await gameBal(alice.publicKey)) + (await gameBal(bob.publicKey));
  for (const k of [alice, bob]) await B.methods.claimPrediction().accountsPartial({ config: P.config, round: P.pred(r), entry: P.predEntry(r, k.publicKey), playerState: P.player(k.publicKey), rentPayer: k.publicKey }).rpc();
  const paid = (await gameBal(alice.publicKey)) + (await gameBal(bob.publicKey)) - before;
  const r3 = await B.account.predRound.fetch(P.pred(r));
  await B.methods.closePredictionRound().accountsPartial({ config: P.config, round: P.pred(r), rewardVault: P.reward, rentPayer: r3.rentPayer }).rpc();
  const v1 = Number(r2.endTs) - Number(r2.lockTs) === 20;
  // a refund is a valid v1 exit: the stretch guard refunds when the first XDEX write after the time is later than one
  // TWAP window (10 s on localnet; the fixture writes every 15 s, so about one lock or settle in three refunds)
  check((r2.state === 2 && paid === 2n * BigInt(XNT) * 98n / 100n || r2.state === 3 && paid === 2n * BigInt(XNT)) && v1 && (await conn.getAccountInfo(P.pred(r))) === null,
    `v1 PredRound ${r} (v1 schedule ${v1}): ${r2.state === 2 ? `settled, outcome ${r2.outcome}` : 'refunded (no contest or stretch guard)'}; entries paid ${Number(paid) / XNT} XNT of the 2-XNT pot; round closed`);
};
await step(`v1 PredRound ${pr} (LOCKED at the upgrade)`, () => predExit(pr));
await step(`v1 PredRound ${pr + 1} lock (OPEN at the upgrade)`, () => predLock(pr + 1));
// the STARTING legacy war joined late in Phase A is started now, well inside its 512-slot window
let warStartTs = 0;
await step('legacy start_war', async () => {
  await retry(['NotReady'], () => B.methods.startWar().accountsPartial({ war: warStart, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).rpc(), 20, 400);
  warStartTs = await chainTime();
});
// A1: the explicit claimDrop on the sealed Phase-A epoch pays (LB-6); an old-style claim continues; Missions
await step('A1 claimDrop', async () => {
  const serial = (await cfgNow()).artifactsMinted[0];
  const asset = P.asset(0, serial);
  const r0 = big((await cfgNow()).rewardReserved);
  await B.methods.claimDrop(BN(1), 0, serial, BN(E1[0].s), t1.proof(0)).accountsPartial({
    config: P.config, epoch: P.epoch(1), receipt: P.drop(1, alice.publicKey, 0), player: alice.publicKey, asset, record: P.artifact(asset), collection: P.collection,
    artifactAuthority: P.authority, rewardVault: P.reward, payer: payer.publicKey, coreProgram: CORE, systemProgram: SYS,
  }).rpc();
  const rec = await B.account.artifactRecord.fetch(P.artifact(asset));
  const value = (E1[0].s * big(e1.dropReserve)) / total1;
  const a = await conn.getAccountInfo(asset);
  check(rec.origin === 2 && big(rec.backing) === value && new PublicKey(a.data.subarray(1, 33)).equals(alice.publicKey) && r0 - big((await cfgNow()).rewardReserved) === value,
    `claimDrop on the sealed Phase-A epoch A1 pays (LB-6): Lunar Dust #${serial} to alice, floor ${Number(value) / XNT} XNT under the legacy cap`);
});
await step('A1 claim_instant after the upgrade', async () => {
  const e = await B.account.epoch.fetch(P.epoch(1));
  const want = (E1[4].s * big(e.budget)) / big(e.totalScore);
  const w0 = big(await bal(eve.publicKey));
  await B.methods.claimInstant(BN(1), 0, BN(E1[4].s), t1.proof(4)).accountsPartial(claimAcc(1, E1[4], eve)).signers([eve]).rpc();
  const got = big(await bal(eve.publicKey)) - w0;
  check(got > want - BigInt(XNT / 100) && got <= want, `old-style claim_instant on A1 continues after the upgrade (+${Number(got) / XNT} XNT, leaf ${Number(want) / XNT} less the claim rents)`);
});
await step('Missions', async () => {
  const m1 = await B.account.mission.fetch(P.mission(1, carol.publicKey, 1));
  const c0 = big(await bal(carol.publicKey));
  await B.methods.withdrawVested().accountsPartial({ mission: P.mission(1, carol.publicKey, 1), player: carol.publicKey, playerState: P.player(carol.publicKey), rentPayer: payer.publicKey }).rpc();
  const got = big(await bal(carol.publicKey)) - c0;
  check(got > 0n && got <= big(m1.total), `Mission tier 1: withdraw_vested pays ${Number(got) / XNT} of ${Number(m1.total) / XNT} XNT`);
  const m2 = await B.account.mission.fetch(P.mission(1, dave.publicKey, 2));
  const d0 = big(await bal(dave.publicKey)), pool0b = big(await bal(P.reward));
  await B.methods.eject().accountsPartial({ config: P.config, mission: P.mission(1, dave.publicKey, 2), player: dave.publicKey, rewardVault: P.reward, rentPayer: payer.publicKey, playerState: P.player(dave.publicKey) }).signers([dave]).rpc();
  const paid = big(await bal(dave.publicKey)) - d0 + 5000n, pen = big(await bal(P.reward)) - pool0b;
  check(pen > 0n && paid + pen >= big(m2.total) - 10_000n && paid + pen <= big(m2.total) + 10_000n && (await conn.getAccountInfo(P.mission(1, dave.publicKey, 2))) === null,
    `Mission tier 2: eject pays ${Number(paid) / XNT} XNT, unvested penalty ${Number(pen) / XNT} XNT to the pool, closed`);
  const chips = await Promise.all([alice, bob, carol, dave].map(async (k) => Number((await B.account.playerState.fetch(P.player(k.publicKey))).chips)));
  check([alice, bob, carol, dave].every((k, i) => chips[i] === chips0[k.publicKey.toBase58()]), `chips never granted after the upgrade (ECO-3): ${chips.join('/')} unchanged`);
});
if (MODE === 'b') {
  await step('A3 claim after the hold', async () => {
    const w0 = big(await bal(eve.publicKey));
    await retry(['ClaimOnHold'], () => claimA3(0, eve).signers([eve]).rpc(), 20, 500);
    check(big(await bal(eve.publicKey)) > w0, 'hold case: the A3 claim pays once the 2-s localnet hold is over (old-style claim continues)');
  });
}
// old clients with the OLD IDL: readable refusals
await step('old IDL refusals', async () => {
  const ps = P.player(alice.publicKey); const n = await nonceOf(alice.publicKey);
  await expectErr('old IDL placeBet', OLD(alice).methods.placeBet(0, BN(0), 0, BN(0.1 * XNT), Array(32).fill(1)).accountsPartial({ config: P.config, playerState: ps, bet: P.bet(ps, n), bankrollVault: P.bankroll, rewardVault: P.reward, architect: arch(), signer: alice.publicKey, systemProgram: SYS }).rpc(), 'KeeperRequired');
  await expectErr('old IDL createWar', OLD(alice).methods.createWar(BN(0.2 * XNT), PublicKey.default).accountsPartial({ config: P.config, creatorState: ps, war: P.war(alice.publicKey, n), owner: alice.publicKey, ...ticket(alice, aliceLunar), systemProgram: SYS }).rpc(), 'SealedJoinRequired');
  await expectErr('old IDL joinDuel on a Phase-A OPEN duel', OLD(bob).methods.joinDuel(1).accountsPartial({ config: P.config, duel: duelSealed, opponentState: bobPs, opponent: bob.publicKey, ...ticket(bob, bobCosmic) }).rpc(), 'SealedJoinRequired');
  await expectErr('old IDL joinWar on a Phase-A OPEN war', OLD(bob).methods.joinWar(PublicKey.default).accountsPartial({ config: P.config, war: warOpen, opponentState: bobPs, opponent: bob.publicKey, ...ticket(bob, bobCosmic) }).rpc(), ['SealedJoinRequired', 'WarState']);
  await expectErr('old IDL enterDraw', OLD(alice).methods.enterDraw(BN(dr), 2, BN(0), BN(1)).accountsPartial({ config: P.config, round: P.drawRound(dr), entry: P.drawEntry(dr, 2), playerState: ps, rewardVault: P.reward, drawVault: P.draw, architect: arch(), signer: alice.publicKey, systemProgram: SYS }).rpc(), 'LotteryRetired');
  await expectErr('old IDL claimArtifactChips', OLD(alice).methods.claimArtifactChips().accountsPartial({ config: P.config, asset: aliceLunar, record: P.artifact(aliceLunar), collection: P.collection, playerState: ps, owner: alice.publicKey }).rpc(), 'ChipsRetired');
  if (MODE === 'a') await expectErr('old IDL drawJackpot (no keeper_seat in its account list)', OLD(payer).methods.drawJackpot().accountsPartial({ config: P.config, round: P.jackpot(jr), firstPlayerState: P.player(alice.publicKey) }).rpc(), ['AccountNotEnoughKeys', 'NotEnoughAccountKeys', '3005', 'insufficient account keys']);
});
// jackpot
await step('jackpot', async () => {
  const closeAll = async () => { const r = await B.account.jackpotRound.fetch(P.jackpot(jr)); for (let i = 0; i < r.entries; i++) { const e = await B.account.jackpotEntry.fetch(P.jpEntry(jr, i)); await B.methods.closeJackpotEntry().accountsPartial({ round: P.jackpot(jr), playerState: P.player(e.player), entry: P.jpEntry(jr, i), rentPayer: e.rentPayer }).rpc(); } };
  const before = (await gameBal(alice.publicKey)) + (await gameBal(bob.publicKey));
  const settleWith = async (mk) => { for (const i of [0, 1]) { const e = await B.account.jackpotEntry.fetch(P.jpEntry(jr, i)); try { await mk(i, e).rpc(); return i; } catch (err) { if (!errIs(errText(err), 'NotWinningEntry')) throw err; } } throw new Error('no entry won'); };
  const sAcc = (i, e) => ({ config: P.config, round: P.jackpot(jr), entry: P.jpEntry(jr, i), winnerState: P.player(e.player), rewardVault: P.reward, drawVault: P.draw, architect: arch(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY });
  if (MODE === 'a') {
    await B.methods.drawJackpot().accountsPartial({ config: P.config, round: P.jackpot(jr), firstPlayerState: P.player(alice.publicKey), keeperSeat: P.keeper }).rpc();
    const r = await B.account.jackpotRound.fetch(P.jackpot(jr));
    check(r.state === 1 && big(r.winningTicket) === (1n << 64n) - 1n, 'Phase-A OPEN jackpot round drawn by the new draw_jackpot: DRAWING with the v3 marker');
    await expectErr('legacy settle_jackpot on a marked round', B.methods.settleJackpot().accountsPartial(sAcc(0, await B.account.jackpotEntry.fetch(P.jpEntry(jr, 0)))).rpc(), 'KeeperRequired');
    const { index, anchor: an } = betUnpack(big(r.targetSlot));
    await waitPastSlot(an);
    await retry(['NotReady'], () => settleWith((i, e) => B.methods.settleJackpotV2(Array.from(chain.reveal(index))).accountsPartial({ ...sAcc(i, e), keeperSeat: P.keeper })), 20, 400);
  } else {
    await retry(['NotReady'], () => settleWith((i, e) => B.methods.settleJackpot().accountsPartial(sAcc(i, e))), 20, 400);
  }
  const r = await B.account.jackpotRound.fetch(P.jackpot(jr));
  await closeAll();
  const got = (await gameBal(alice.publicKey)) + (await gameBal(bob.publicKey)) - before;
  check((r.state === 2 && got === 3n * BigInt(XNT) * 98n / 100n) || (r.state === 3 && got === 3n * BigInt(XNT)),
    `jackpot round ${jr} (${MODE === 'a' ? 'OPEN at the upgrade, settle_jackpot_v2' : 'DRAWING at the upgrade, legacy settle_jackpot'}): ${r.state === 2 ? 'settled, winner paid 98% of 3 XNT' : 'refunded in full'}; entries closed`);
  check(Number((await cfgNow()).jackpotRound) === jr + 1, 'config.jackpot_round advanced');
});
// lottery: the OPEN round draws, settles and closes; new tickets refused
await step('lottery', async () => {
  await expectErr('enter_draw (new IDL)', B.methods.enterDraw(BN(dr), 2, BN(0), BN(1)).accountsPartial({ config: P.config, round: P.drawRound(dr), entry: P.drawEntry(dr, 2), playerState: P.player(alice.publicKey), rewardVault: P.reward, drawVault: P.draw, architect: arch(), signer: alice.publicKey, systemProgram: SYS }).signers([alice]).rpc(), 'LotteryRetired');
  await retry(['RoundRunning'], () => B.methods.drawDraw().accountsPartial({ config: P.config, round: P.drawRound(dr) }).rpc(), 40, 500);
  const r = await B.account.drawRound.fetch(P.drawRound(dr));
  await waitPastSlot(big(r.targetSlot));
  let settled = false;
  for (const i of [0, 1]) {
    const e = await B.account.drawEntry.fetch(P.drawEntry(dr, i));
    try { await B.methods.settleDraw().accountsPartial({ config: P.config, round: P.drawRound(dr), entry: P.drawEntry(dr, i), winnerState: P.player(e.player), drawVault: P.draw, rewardVault: P.reward, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).rpc(); settled = true; break; } catch (err) { if (!errIs(errText(err), 'NotWinningEntry')) throw err; }
  }
  const r2 = await B.account.drawRound.fetch(P.drawRound(dr));
  for (const i of [0, 1]) { const e = await B.account.drawEntry.fetch(P.drawEntry(dr, i)); await B.methods.closeDrawEntry().accountsPartial({ round: P.drawRound(dr), entry: P.drawEntry(dr, i), rentPayer: e.rentPayer }).rpc(); }
  check(settled && r2.state === 2 && (await conn.getAccountInfo(P.drawEntry(dr, 0))) === null, `Phase-A OPEN lottery round ${dr}: draw_draw, settle_draw (prize ${Number(r2.prize) / XNT} XNT to ${r2.winner.toBase58().slice(0, 6)}), entries closed`);
});
await step(`v1 PredRound ${pr + 1} (OPEN at the upgrade) settles`, () => predExit(pr + 1));
// duels
await step('duels', async () => {
  const resolveAcc = async (duel) => { const d = await B.account.duel.fetch(duel); return { config: P.config, duel, creatorState: P.player(d.creator), opponentState: P.player(d.opponent), rewardVault: P.reward, drawVault: P.draw, architect: arch(), rentPayer: d.rentPayer }; };
  const a0 = await gameBal(alice.publicKey);
  await B.methods.cancelDuel().accountsPartial({ duel: duelCancel, creatorState: P.player(alice.publicKey), creator: alice.publicKey }).signers([alice]).rpc();
  check((await gameBal(alice.publicKey)) - a0 === BigInt(0.2 * XNT), 'Phase-A OPEN duel: cancel_duel refunds the creator in full');
  const jsalt = Buffer.alloc(32, 0x77);
  const jc = keccak(Buffer.from('MOONFORGE_DUEL_JOIN'), Buffer.from([1]), jsalt, duelSealed.toBuffer(), bob.publicKey.toBuffer());
  await B.methods.joinDuelSealed(Array.from(jc)).accountsPartial({ config: P.config, duel: duelSealed, opponentState: bobPs, opponent: bob.publicKey, asset: SYS, record: SYS, collection: SYS }).signers([bob]).rpc();
  await retry(['NotReady'], () => B.methods.revealDuelJoin(1, Array.from(jsalt)).accountsPartial({ duel: duelSealed, opponent: bob.publicKey }).signers([bob]).rpc(), 20, 500);
  const b0 = await gameBal(bob.publicKey);
  await B.methods.revealDuel(0, Array.from(duelSalt(2))).accountsPartial({ resolve: await resolveAcc(duelSealed), creator: alice.publicKey }).signers([alice]).rpc();
  check((await gameBal(bob.publicKey)) - b0 === BigInt(0.6 * XNT) * 98n / 100n && (await conn.getAccountInfo(duelSealed)) === null, 'Phase-A OPEN duel joined sealed without a ticket (no TTL): Cosmic beats Lunar, 98% of the pot, closed');
  const b1 = await gameBal(bob.publicKey);
  await retry(['DeadlineNotReached'], async () => B.methods.claimDuelTimeout().accountsPartial(await resolveAcc(duelJoined)).rpc(), 20, 500);
  const dj = (await gameBal(bob.publicKey)) - b1;
  check((dj === BigInt(0.8 * XNT) * 98n / 100n || dj === BigInt(0.8 * XNT)) && (await conn.getAccountInfo(duelJoined)) === null, 'Phase-A JOINED duel (legacy element): claim_duel_timeout pays the opponent (creator never revealed), closed');
});
// wars
const settleWar = async (war) => { const w = await B.account.war.fetch(war); return B.methods.settleWar().accountsPartial({ config: P.config, war, creatorState: P.player(w.creator), opponentState: P.player(w.opponent), rewardVault: P.reward, drawVault: P.draw, architect: arch(), rentPayer: w.rentPayer }).rpc(); };
await step('wars', async () => {
  const a0 = await gameBal(alice.publicKey);
  await B.methods.cancelWar().accountsPartial({ war: warOpen, creatorState: P.player(alice.publicKey), creator: alice.publicKey }).signers([alice]).rpc();
  check((await gameBal(alice.publicKey)) - a0 === BigInt(0.2 * XNT), 'Phase-A OPEN war: cancel_war refunds in full');
  // ACTIVE legacy war: fixed 8-s turns (localnet WAR_TURN_TIMEOUT) and the clock is never charged
  const wa = await B.account.war.fetch(warActive);
  const ts0 = big(wa.targetSlot);
  await retry(['DeadlineNotReached'], () => B.methods.claimWarTimeout().accountsPartial({ war: warActive }).rpc(), 30, 500);
  const wa2 = await B.account.war.fetch(warActive);
  const winner = wa2.winner;
  const w0 = await gameBal(winner);
  await settleWar(warActive);
  check(wa2.state === 3 && wa2.timeout && big(wa2.targetSlot) === ts0 && (await gameBal(winner)) - w0 === BigInt(0.8 * XNT) * 98n / 100n, 'Phase-A ACTIVE war: claim_war_timeout after the legacy turn deadline, target_slot never rewritten, settle_war pays 98%');
  // STARTING legacy war within 512 slots (started above): legacy seed, the creator first, the creator's grace turn
  const ws = await B.account.war.fetch(warStart);
  const now = warStartTs;
  check(ws.state === 2 && ws.turn === 0 && Number(ws.deadline) - now >= 8 && Number(ws.deadline) - now <= 12, `Phase-A STARTING war: legacy start_war -> ACTIVE, creator first, first deadline now + ${Number(ws.deadline) - now} s (WAR_FIRST_TURN_GRACE 10 s on localnet, 600 s on mainnet)`);
  await retry(['DeadlineNotReached'], () => B.methods.claimWarTimeout().accountsPartial({ war: warStart }).rpc(), 40, 500);
  const b0 = await gameBal(bob.publicKey);
  await settleWar(warStart);
  check((await gameBal(bob.publicKey)) - b0 === BigInt(XNT) * 98n / 100n, 'the started legacy war times out (creator idle) and settles to the opponent');
});
// market: a pre-upgrade Artifact lists with add_plugin = true and sells
await step('market', async () => {
  const rec = await B.account.artifactRecord.fetch(P.artifact(carolLunar));
  const price = big(rec.backing) * 3n;
  const exp = (await chainTime()) + 60;
  await B.methods.listArtifact(BN(price), BN(exp), PublicKey.default, true).accountsPartial({ config: P.config, listing: P.listing(carolLunar), asset: carolLunar, record: P.artifact(carolLunar), collection: P.collection, seller: carol.publicKey, coreProgram: CORE, systemProgram: SYS }).signers([carol]).rpc();
  const c0 = big(await bal(carol.publicKey));
  await B.methods.buyArtifact(BN(price)).accountsPartial({ config: P.config, listing: P.listing(carolLunar), asset: carolLunar, record: P.artifact(carolLunar), collection: P.collection, buyer: eve.publicKey, seller: carol.publicKey, architect: arch(), rewardVault: P.reward, coreProgram: CORE, systemProgram: SYS }).signers([eve]).rpc();
  const a = await conn.getAccountInfo(carolLunar);
  check(new PublicKey(a.data.subarray(1, 33)).equals(eve.publicKey) && big(await bal(carol.publicKey)) > c0 + big(rec.backing), `pre-upgrade Artifact (old split, no TransferDelegate) lists with add_plugin = true and sells for ${Number(price) / XNT} XNT`);
});
// A2: outside its hold -> HoldOver (the localnet hold is 2 s, shorter than any upgrade); expiry arithmetic below
await step('void A2', async () => {
  await expectErr('void_epoch(A2) after its 2-s hold', B.methods.voidEpoch(BN(2), BN(XNT)).accountsPartial({ config: P.config, epoch: P.epoch(2), seat: P.seat, rewardVault: P.reward, voider: payer.publicKey, systemProgram: SYS }).rpc(), 'HoldOver');
});
// 108-B publish_epoch through the OLD IDL (the live oracle client) still works
await step('old IDL publish_epoch', async () => {
  const t4 = tree([claimLeaf(4, alice.publicKey, 0, 10n)]);
  await retry(['EpochTooSoon'], async () => sendIxs([await publishIx(4, t4.root, 10n, 1)], [oracle]), 40, 500);
  const e4 = await B.account.epoch.fetch(P.epoch(4));
  check(big(e4.dropReserve) === 0n && e4.dropState === 0, 'publish_epoch (108-B ABI) through the OLD IDL: epoch 4 written with drop_reserve 0, drop_state NONE');
});
// expiry (90-s localnet claim window): A1, A2 (and A3 in mode b) release budget - claimed + (drop_reserve - drop_paid)
const expireCheck = async (n) => {
  const e = await B.account.epoch.fetch(P.epoch(n));
  await untilChainTime(Number(e.expiresAt) + 1);
  const r0 = big((await cfgNow()).rewardReserved);
  await retry(['ClaimWindowOpen'], () => B.methods.expireEpoch().accountsPartial({ config: P.config, epoch: P.epoch(n) }).rpc(), 20, 500);
  const unpaid = big(e.dropReserve) > big(e.dropPaid) ? big(e.dropReserve) - big(e.dropPaid) : 0n;
  const want = big(e.budget) - big(e.claimed) + unpaid;
  const got = r0 - big((await cfgNow()).rewardReserved);
  check(got === want, `expire_epoch(A${n}) releases ${Number(got) / XNT} XNT = budget - claimed + drop_reserve - drop_paid`);
};
await step('expire A1', () => expireCheck(1));
await step('expire A2', () => expireCheck(2));
if (MODE === 'b') await step('expire A3', () => expireCheck(3));
await step('close_receipt', async () => {
  const rc = P.receipt(1, bob.publicKey, 0);
  const r = await B.account.claimReceipt.fetch(rc);
  const p0 = await bal(r.rentPayer);
  await B.methods.closeReceipt().accountsPartial({ epoch: P.epoch(1), receipt: rc, rentPayer: r.rentPayer }).rpc();
  check((await bal(r.rentPayer)) > p0, 'close_receipt of the Phase-A claim receipt returns the rent');
});
// STARTING war left > 512 slots: a draw with a full refund (no re-roll, unlike the old binary)
await step('expired STARTING war', async () => {
  const w = await B.account.war.fetch(warExpire);
  await TX.waitSlotHashGone(conn, SYSVAR_SLOT_HASHES_PUBKEY, big(w.targetSlot)); // > 512 slots AND gone from SlotHashes (skipped slots)
  await B.methods.startWar().accountsPartial({ war: warExpire, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).rpc();
  const w2 = await B.account.war.fetch(warExpire);
  const a0 = await gameBal(alice.publicKey), b0 = await gameBal(bob.publicKey);
  await settleWar(warExpire);
  check(w2.state === 3 && w2.draw && (await gameBal(alice.publicKey)) - a0 === BigInt(0.3 * XNT) && (await gameBal(bob.publicKey)) - b0 === BigInt(0.3 * XNT), 'Phase-A STARTING war left > 512 slots: start_war -> draw, settle_war refunds both in full');
});
// census + solvency
for (const [name, k] of [['OracleSeat', P.seat], ['ExtraState', P.extraState], ['extra_vault', P.extraVault], ['HouseKeeper', P.keeper]]) {
  const a = await conn.getAccountInfo(k); check(!!a, `census: ${name} ${a ? `${a.data.length} B` : 'missing'}`);
}
{
  const c = await cfgNow(); const rent = await conn.getMinimumBalanceForRentExemption(8);
  check(BigInt((await bal(P.reward)) - rent) >= big(c.rewardReserved) && BigInt((await bal(P.bankroll)) - rent) >= big(c.bankrollReserved), 'solvency: reward and bankroll vaults cover their reservations');
}
const idlInfo = await conn.getAccountInfo(await idlAddress());
console.log(`IDL account ${(await idlAddress()).toBase58()}: ${idlInfo ? idlInfo.data.length : 'missing'} B`);
console.log(failures ? `upgrade rehearsal (mode ${MODE}): ${passes} ok, ${failures} FAILED` : `upgrade rehearsal (mode ${MODE}): all ${passes} checks passed in ${stamp()}`);
process.exit(failures ? 1 : 0);
