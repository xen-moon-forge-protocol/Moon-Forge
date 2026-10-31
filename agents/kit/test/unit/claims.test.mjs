// node --test: the burner's exits (claims.mjs) on an offline kit with epoch 1 as the file source, the secrets store
// (secrets.mjs) and the kit version check: verifyMyClaim ties the leaf to the Epoch account; claim() builds
// claim_instant / claim_mission for the leaf's wallet and refuses claimed, expired and (rules 3) held leaves; missions,
// eject's penalty preview, donate, capacity under both rules, myBurns, the history CSV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { checkKitVersion, compareVersions, KIT_VERSION, PDA } from '../../moonforge.mjs';
import { EpochSource } from '../../epochs.mjs';
import { SecretsStore } from '../../secrets.mjs';
import { loadBundledIdl } from '../../idl.mjs';
import { BN, disc, epoch1, feedFromWorld, idlAccounts, loadVectors, offlineKit, tempDir } from './helpers-v3.mjs';
import { allocateWindow, capOnDay } from '../../quote-v3.mjs';
import { feedInputs } from '../../burn.mjs';

const E1 = epoch1();
const PLAYER = new PublicKey(E1.leaves[0].player);
const live = loadBundledIdl('live').idl;
const epochAccount = (over = {}) => ({
  root: Buffer.from(E1.root, 'hex'), dataHash: Buffer.from(E1.dataHash, 'hex'), totalScore: new BN(E1.totalScore), leaves: 1, budget: new BN('388359377'),
  publishedAt: new BN(1_792_287_485), expiresAt: new BN(1_792_287_485 + 90 * 86_400), closed: false, ...over,
});
function kit(rules = 2, { now = 1_792_300_000, receipt = false, account = epochAccount() } = {}) {
  const mf = offlineKit({ rules, idl: rules === 3 ? loadBundledIdl('v3').idl : live });
  mf.epochs = new EpochSource({ files: { 'epoch-1.json': E1, 'index.json': { epochs: [{ epoch: 1 }] } } });
  mf.chainTime = async () => now;
  mf.epochAccount = async () => account;
  mf.connection.getAccountInfo = async (pk) => (receipt && pk.equals(PDA.receipt(1, PLAYER, 0)) ? { owner: SystemProgram.programId, data: Buffer.alloc(90), lamports: 1 } : null);
  return mf;
}

test('verifyMyClaim: the epoch-1 leaf verifies against its Epoch account and is claimable', async () => {
  const v = await kit().verifyMyClaim(1, { owner: PLAYER });
  assert.deepEqual(v.reasons, []);
  assert.equal(v.ok, true);
  assert.equal(v.claimable, true);
  assert.equal(v.leafHash, E1.root);
  assert.equal(v.estimateXnt, 0.388359377);
});

test('verifyMyClaim refuses a file that differs from the chain, and reports a missing leaf', async () => {
  const bad = await kit(2, { account: epochAccount({ root: Buffer.alloc(32, 1) }) }).verifyMyClaim(1, { owner: PLAYER });
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.some((r) => /on-chain root/.test(r)));
  const none = await kit().verifyMyClaim(1, { owner: Keypair.generate().publicKey });
  assert.match(none.reasons.at(-1), /no leaf/);
  const unpublished = await kit(2, { account: null }).verifyMyClaim(1, { owner: PLAYER });
  assert.ok(unpublished.reasons.some((r) => /no account on chain/.test(r)));
});

test('claim(): claim_instant for the leaf\'s wallet, paid by this wallet; claimFor() sends for another wallet', async () => {
  const mf = kit();
  const r = await mf.claimFor(PLAYER, 1);
  assert.equal(r.tier, 0);
  const ix = mf.sent[0].ix;
  assert.equal(ix.data.subarray(0, 8).toString('hex'), disc('claim_instant'));
  const names = idlAccounts(live, 'claim_instant').map((a) => a.name);
  const at = (n) => ix.keys[names.indexOf(n)].pubkey;
  assert.ok(at('player').equals(PLAYER), 'the XNT goes to the wallet in the leaf');
  assert.ok(at('payer').equals(mf.me), 'this wallet pays the fee and the receipt rent');
  assert.ok(at('receipt').equals(PDA.receipt(1, PLAYER, 0)));
  assert.ok(at('epoch').equals(PDA.epoch(1)));
});

test('claim() refuses an already claimed, an expired and (rules 3) a held leaf, before anything is sent', async () => {
  await assert.rejects(kit(2, { receipt: true }).claimFor(PLAYER, 1), /already claimed/);
  await assert.rejects(kit(2, { now: 1_792_287_485 + 91 * 86_400 }).claimFor(PLAYER, 1), /90-day claim window/);
  const held = kit(3, { now: 1_792_287_485 + 3_600 });
  await assert.rejects(held.claimFor(PLAYER, 1), /open 48 h after its publication \(ClaimOnHold\)/);
  assert.equal(held.sent.length, 0);
  const after = kit(3, { now: 1_792_287_485 + 49 * 3_600 });
  await after.claimFor(PLAYER, 1);
  assert.equal(after.sent.length, 1);
});

test('missions: the vesting preview, withdrawVested, and eject only with acceptPenalty', async () => {
  const mf = kit();
  const m = { player: mf.me, epoch: new BN(1), tier: 2, total: new BN(1_000_000), withdrawn: new BN(100_000), start: new BN(1_000), end: new BN(1_000 + 180 * 86_400), rentPayer: mf.me };
  const half = 1_000 + 90 * 86_400;
  const p = mf.missionPreview(m, half);
  assert.equal(p.vested, 500_000n);
  assert.equal(p.withdrawable, 400_000n);
  assert.equal(p.penalty, 375_000n, '75% of the unvested 500,000 (Moon Landing)');
  assert.equal(p.ejectPays, 400_000n + 500_000n - 375_000n);
  mf.chainTime = async () => half;
  const mission = { publicKey: Keypair.generate().publicKey, account: m };
  await assert.rejects(mf.eject(mission), (e) => { assert.match(e.message, /acceptPenalty: true/); assert.equal(e.preview.penalty, 375_000n); return true; });
  assert.equal(mf.sent.length, 0);
  await mf.eject(mission, { acceptPenalty: true });
  assert.equal(mf.sent[0].ix.data.subarray(0, 8).toString('hex'), disc('eject'));
  await mf.withdrawVested(mission);
  assert.equal(mf.sent[1].ix.data.subarray(0, 8).toString('hex'), disc('withdraw_vested'));
});

test('donate: to the reward pool or the bankroll; the lottery vault is refused after the final upgrade', async () => {
  const mf = kit();
  await mf.donate('reward', 0.5);
  assert.equal(mf.sent[0].ix.data.subarray(0, 8).toString('hex'), disc('donate'));
  assert.equal(mf.sent[0].ix.data[8], 0);
  await assert.rejects(kit(3).donate('draw', 1), /Burn Lottery is retired/);
  await assert.rejects(mf.donate('nowhere', 1), /'reward' or 'bankroll'/);
});

test('capacity: the v2 upper bound today; under v3 C = 8% of F_ref in 7 daily tranches from the last publication', async () => {
  const mf = kit();
  const cfg = { lastEpoch: new BN(1), rewardReserved: new BN(0) };
  const c2 = await mf.capacity({ cfg, freeLamports: 6_000_000_000n, now: 1_792_300_000 });
  assert.equal(c2.rules, 'v2');
  assert.equal(c2.weeklyCapUpperBoundXnt, 0.6);
  const v3 = JSON.parse(JSON.stringify(loadVectors().prevFiles.v3a));
  v3.publish = { tx: 'x', freePoolBefore: '12000000000', budget: '1000000000' };
  const m3 = kit(3);
  m3.epochs = new EpochSource({ files: { [`epoch-${v3.epoch}.json`]: v3, 'index.json': { epochs: [{ epoch: v3.epoch }] } } });
  m3.epochAccount = async () => ({ publishedAt: new BN(1_800_000_000) });
  const c3 = await m3.capacity({ cfg: { lastEpoch: new BN(v3.epoch), rewardReserved: new BN(0) }, freeLamports: 20_000_000_000n, now: 1_800_000_000 + 2 * 86_400 + 5 });
  assert.equal(c3.rules, 'v3');
  assert.equal(c3.CXnt, 0.88, '8% of (12 - 1) XNT');
  assert.equal(c3.day, 2);
  assert.equal(c3.capTodayXnt, Number((880_000_000n / 7n) * 3n + 3n) / 1e9);
  assert.match(c3.projectionNote, /not binding/);
});

test('capacity with the week-so-far feed: what is left today = the cumulative cap minus the arrivals so far (engine)', async () => {
  const v = loadVectors();
  const w = v.worlds.find((x) => x.prev === 'v3a' && x.solo && x.expected && !x.expected.shortfall);
  const prev = v.prevFiles.v3a;
  const now = w.inputs.window.startTs + 3 * 86_400 + 1_800;
  const feed = feedFromWorld(w, now);
  const m = kit(3);
  m.epochs = new EpochSource({ files: { [`epoch-${prev.epoch}.json`]: prev, 'index.json': { epochs: [{ epoch: prev.epoch }] } } });
  m.epochAccount = async () => ({ publishedAt: new BN(w.inputs.window.startTs) });
  const c = await m.capacity({ cfg: { lastEpoch: new BN(prev.epoch), rewardReserved: new BN(0) }, freeLamports: BigInt(w.inputs.freePool.lamports), now, feed });
  const r = allocateWindow(prev, feedInputs(feed), { applyLimit: false });
  const capToday = capOnDay(r.C, 3);
  assert.equal(c.day, 3);
  assert.equal(c.CXnt, Number(r.C) / 1e9);
  assert.equal(c.remainingTodayXnt, Number(capToday > r.capacity.senior ? capToday - r.capacity.senior : 0n) / 1e9);
});

test('myBurns and history(): burns of an X1 destination from the epoch files; a CSV with a header', async () => {
  const mf = kit();
  const burns = await mf.myBurns({ owner: PLAYER });
  assert.equal(burns.length, 1);
  assert.equal(burns[0].chainId, 10);
  assert.equal(burns[0].missionId, '1');
  mf.myMissions = async () => [];
  mf.connection.getSignaturesForAddress = async () => [];
  const csv = await mf.history({ owner: PLAYER });
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'time_utc,kind,epoch,tier,amount_xnt,reference,note');
  assert.ok(lines.some((l) => l.includes(',burn,1,0,')));
  assert.ok(lines.some((l) => l.includes('leaf')));
});

test('methods that read epoch files refuse clearly without connect({ epochs })', async () => {
  const mf = offlineKit({ rules: 2, idl: live });
  await assert.rejects(mf.verifyMyClaim(1), /pass connect\(\{ epochs \}\)/);
  await assert.rejects(mf.myBurns(), /pass connect\(\{ epochs \}\)/);
});

test('secrets store: written durably, reused on a retry, never overwritten with other bytes, survives a restart', async (t) => {
  const dir = path.join(tempDir('mf-secrets'), 'nested');
  const s = new SecretsStore(dir);
  const acct = Keypair.generate().publicKey.toBase58();
  const a = s.getOrCreate('duel-create', acct, () => ({ element: 1, salt: 'aa'.repeat(32) }));
  assert.equal(a.reused, false);
  const b = s.getOrCreate('duel-create', acct, () => ({ element: 3, salt: 'bb'.repeat(32) }));
  assert.equal(b.reused, true);
  assert.equal(b.record.salt, 'aa'.repeat(32), 'a retry gets the same bytes');
  assert.throws(() => s.put('duel-create', acct, { element: 2, salt: 'cc'.repeat(32) }), /refusing to overwrite/);
  const again = new SecretsStore(dir);
  assert.equal(again.get('duel-create', acct).element, 1, 'a new process (after a crash) reads the same secret');
  assert.equal(again.list().length, 1);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, 'no temporary file left');
  if (process.platform !== 'win32') assert.equal(fs.statSync(again.pathOf('duel-create', acct)).mode & 0o777, 0o600);
  else t.diagnostic('file mode 0600 is checked on POSIX only');
  assert.equal(await again.prune(async () => true), 1);
  assert.equal(again.list().length, 0);
  assert.throws(() => s.get('../x', acct), /bad kind/);
  assert.throws(() => s.get('duel-create', '../../etc/passwd'), /base58/);
});

test('secrets store: two processes creating the same game\'s secret at once: the first one published wins for both', () => {
  const dir = tempDir('mf-secrets-race');
  const acct = Keypair.generate().publicKey.toBase58();
  const a = new SecretsStore(dir);
  const b = new SecretsStore(dir);
  // b looked for a record before a published its own (the race): its first two get() calls (getOrCreate, put) saw
  // nothing, so b reaches the publish step, which must not replace a's record
  const realGet = b.get.bind(b);
  let calls = 0;
  b.get = (k, x) => (calls++ < 2 ? null : realGet(k, x));
  const ra = a.getOrCreate('war-create', acct, () => ({ entropy: 'aa'.repeat(32) }));
  const rb = b.getOrCreate('war-create', acct, () => ({ entropy: 'bb'.repeat(32) }));
  assert.equal(ra.record.entropy, 'aa'.repeat(32));
  assert.equal(rb.record.entropy, 'aa'.repeat(32), 'the loser gets (and commits to) the winner\'s record');
  assert.equal(rb.reused, true);
  assert.equal(new SecretsStore(dir).get('war-create', acct).entropy, 'aa'.repeat(32), 'the record on disk was never replaced');
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0, 'no temporary file left');
  assert.ok(calls >= 3, 'the publish step ran and then read the winner');
  assert.throws(() => b.put('war-create', acct, { entropy: 'cc'.repeat(32) }), (e) => e.code === 'ESECRETEXISTS');
});

test('history(): every event it keeps exists in the bundled IDLs, and the money events are all kept', async () => {
  const { HISTORY_EVENTS, historyAmount, historyNote } = await import('../../claims.mjs');
  const names = new Set([...live.events, ...loadBundledIdl('v3').idl.events].map((e) => e.name));
  for (const n of HISTORY_EVENTS) assert.ok(names.has(n), `${n} is not an event of either IDL`);
  for (const n of ['WarFinished', 'HouseChanged', 'VestedWithdrawn', 'PilotEjected', 'JackpotSettled', 'DrawSettled', 'DropWon', 'PredictionResolved', 'ExtraClaimed']) assert.ok(HISTORY_EVENTS.has(n), n);
  assert.equal(historyAmount({ lamports: new BN(5) }).toString(), '5', 'HouseChanged carries lamports');
  assert.equal(historyAmount({ paid: new BN(7), penaltyToPool: new BN(1) }).toString(), '7', 'PilotEjected carries paid');
  assert.equal(historyNote('HouseChanged', { deposit: false }, PLAYER), 'Be the House withdrawal');
  assert.equal(historyNote('WarFinished', { winner: PLAYER }, PLAYER), 'won');
  assert.equal(historyNote('WarFinished', { winner: PublicKey.default }, PLAYER), 'draw or refund');
});

test('Jackpot and Lottery exits: close an entry of a settled round (rent back to its payer); refused before that', async () => {
  for (const rules of [2, 3]) {
    const mf = offlineKit({ rules, idl: rules === 3 ? loadBundledIdl('v3').idl : live });
    const player = Keypair.generate().publicKey, payer = Keypair.generate().publicKey;
    let state = 1;
    mf.acc = {
      ...mf.program.account,
      jackpotRound: { fetchNullable: async () => ({ state }) },
      jackpotEntry: { fetchNullable: async () => ({ player, rentPayer: payer, amount: new BN(250_000_000) }) },
      drawRound: { fetchNullable: async () => ({ state }) },
      drawEntry: { fetchNullable: async () => ({ player, rentPayer: payer }) },
    };
    await assert.rejects(mf.closeJackpotEntry(7, 2), /not settled or refunded yet.*Nothing was sent/);
    await assert.rejects(mf.closeDrawEntry(7, 2), /not settled yet.*Nothing was sent/);
    state = 3;
    const r = await mf.closeJackpotEntry(7, 2);
    assert.equal(r.refunded, true);
    assert.equal(r.amountXnt, 0.25);
    const idl = rules === 3 ? loadBundledIdl('v3').idl : live;
    const ix = mf.sent.at(-1).ix;
    assert.equal(ix.data.subarray(0, 8).toString('hex'), disc('close_jackpot_entry'));
    const want = { round: PDA.jackpot(7n), player_state: PDA.player(player), entry: PDA.jpEntry(7n, 2), rent_payer: payer };
    idlAccounts(idl, 'close_jackpot_entry').forEach((a, i) => assert.ok(ix.keys[i].pubkey.equals(want[a.name]), `close_jackpot_entry ${a.name}`));
    state = 2;
    await mf.closeDrawEntry(7, 2);
    const ix2 = mf.sent.at(-1).ix;
    assert.equal(ix2.data.subarray(0, 8).toString('hex'), disc('close_draw_entry'));
    const want2 = { round: PDA.draw(7n), entry: PDA.drawEntry(7n, 2), rent_payer: payer };
    idlAccounts(idl, 'close_draw_entry').forEach((a, i) => assert.ok(ix2.keys[i].pubkey.equals(want2[a.name]), `close_draw_entry ${a.name}`));
  }
  const u = offlineKit({ rules: 'unknown', idl: live });
  await assert.rejects(u.closeJackpotEntry(1, 0), /rules are unknown right now/);
});

test('kit version: semver compare and the agent card minimum', () => {
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(checkKitVersion({}).ok, true);
  assert.equal(checkKitVersion({ minKitVersion: '2.0.0' }).ok, true);
  const old = checkKitVersion({ minKitVersion: '2.1.0' });
  assert.equal(old.ok, false);
  assert.match(old.text, /older than the minimum/);
  assert.equal(checkKitVersion({ minKitVersion: '2.0.0' }, '1.0.0').ok, false);
  assert.equal(KIT_VERSION, JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version, 'KIT_VERSION matches package.json');
});
