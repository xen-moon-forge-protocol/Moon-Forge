// node --test: the final upgrade's methods (games-v3.mjs, artifacts-v3.mjs) and the rules gate, on an offline kit
// whose send() builds the instruction without sending it: under the live rules every new method refuses before
// anything is built; under unknown rules every call refuses; under rules 3 the live calls the upgrade retired refuse
// with the program's code; and each new instruction is built with the upgraded IDL's discriminator and exactly the
// accounts the IDL lists, in order. The sealed games' secrets are on disk before the commitment is sent, and a retry
// commits to the same bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Keypair, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js';
import { errorMessage, MPL_CORE, PDA, programErrorName, programErrorNumber } from '../../moonforge.mjs';
import { loadBundledIdl } from '../../idl.mjs';
import { betPack, duelCommitment, duelJoinCommitment, warEntropyCommitment, warJoinCommitment, V3 } from '../../rules-v3.mjs';
import { BN, disc, idlAccounts, offlineConnection, offlineKit } from './helpers-v3.mjs';

const v3 = loadBundledIdl('v3').idl;
const live = loadBundledIdl('live').idl;
const ARCHITECT = Keypair.generate().publicKey;
const someKey = () => Keypair.generate().publicKey;

/** Asserts the instruction's discriminator and that its accounts are the IDL's, in order, with the expected keys. */
function assertIx(ix, name, expected) {
  assert.equal(ix.data.subarray(0, 8).toString('hex'), disc(name), `${name}: discriminator`);
  const accounts = idlAccounts(v3, name);
  assert.equal(ix.keys.length, accounts.length, `${name}: ${ix.keys.length} keys, IDL lists ${accounts.length}`);
  accounts.forEach((a, i) => {
    if (expected[a.name]) assert.ok(ix.keys[i].pubkey.equals(expected[a.name]), `${name}: account ${i} (${a.name}) is ${ix.keys[i].pubkey.toBase58()}, expected ${expected[a.name].toBase58()}`);
    assert.equal(ix.keys[i].isWritable, !!a.writable, `${name}: ${a.name} writable`);
    assert.equal(ix.keys[i].isSigner, !!a.signer, `${name}: ${a.name} signer`);
  });
}

const cfg = () => ({
  architect: ARCHITECT, lastEpoch: new BN(3), lastPublishTs: new BN(1_799_000_000), artifactsMinted: [5, 0, 0, 0], artifactsAlive: [3, 0, 0, 0],
  artifactPrice: [new BN(0), new BN(0), new BN(0), new BN(0)], artifactPriceTs: [new BN(0), new BN(0), new BN(0), new BN(0)], rewardReserved: new BN(0),
  bankrollDay: new BN(0), bankrollDayStart: new BN(0), bankrollReserved: new BN(0), houseTotalShares: new BN(0), houseProtocolShares: new BN(0),
});
const armedKeeper = { keeper: someKey(), length: new BN(100), nextIndex: new BN(3), revealed: new BN(3), bond: new BN((50n * 10n ** 9n).toString()), pendingBets: 0, lastActiveTs: new BN(1_800_000_000), jackpotReserved: new BN(0), withdrawTs: new BN(0), weekStartBankroll: new BN(0), weekNetLoss: new BN(0), weekStartTs: new BN(0) };
function kit3(over = {}) {
  const mf = offlineKit({ rules: 3, ...over });
  const ps = PDA.player(mf.me);
  Object.assign(mf, {
    config: async () => cfg(), chainTime: async () => 1_800_000_000, ensurePlayer: async () => ps, rentFor: async () => 1_000_000,
    houseKeeper: async () => ({ armed: true, reason: null }),
  });
  mf.acc = {
    ...mf.program.account,
    playerState: { fetch: async () => ({ nonce: new BN(4) }), size: 129 },
    houseKeeper: { fetchNullable: async () => armedKeeper },
    bet: { fetchNullable: async () => null, fetch: async () => null },
  };
  return { mf, ps };
}

test('connect() off X1 mainnet keeps the live rules unless told (a local harness keeps its live calls); rules: 3 pins them', async () => {
  const { connect } = await import('../../moonforge.mjs');
  const { IDL_FILES } = await import('../../idl.mjs');
  const kp = Keypair.generate();
  const LOCAL = 'LocalTestGenesis111111111111111111111111111'; // a cluster that is not X1 mainnet (the endpoint does not answer)
  const rpc = 'http://127.0.0.1:9';
  const a = await connect({ rpc, genesis: LOCAL, keypair: kp, idl: IDL_FILES.v3.path, onWarning: () => {} });
  assert.equal(a.rules, 2);
  assert.equal(a.detection.status, 'default');
  assert.equal(a.idlInfo.origin, 'bundled', 'a file identical to a bundled IDL (e.g. the MOONFORGE_IDL path of the 1.0.0 README) behaves like the bundle');
  assert.equal(a.idlInfo.sha256, IDL_FILES.live.sha256, '... so it follows the rules in force (live here), and switches with them');
  assert.equal(await a.refreshRules(), 2, 'not re-read while pinned by the default');
  const b = await connect({ rpc, genesis: LOCAL, keypair: kp, idl: IDL_FILES.v3.path, rules: 3, onWarning: () => {} });
  assert.equal(b.rules, 3);
  assert.equal(b.idlInfo.sha256, IDL_FILES.v3.sha256);
  const c = await connect({ rpc, genesis: LOCAL, keypair: kp, onWarning: () => {} });
  assert.equal(c.idlInfo.origin, 'bundled');
  assert.equal(c.idlInfo.sha256, IDL_FILES.live.sha256, 'without an IDL the live bundled one, pinned by sha256');
  const d = await connect({ rpc, genesis: LOCAL, keypair: kp, idl: JSON.parse(fs.readFileSync(IDL_FILES.v3.path, 'utf8')), onWarning: () => {} });
  assert.equal(d.idlInfo.origin, 'object');
  assert.equal(d.idlInfo.rules, 3, 'an IDL object is used as given');
});

test('connect(): an unknown cluster is refused, not assumed; rules: 3 on X1 mainnet is checked against the chain', async () => {
  const { connect, X1_MAINNET_GENESIS } = await import('../../moonforge.mjs');
  const kp = Keypair.generate();
  await assert.rejects(connect({ rpc: 'http://127.0.0.1:9', keypair: kp, onWarning: () => {} }), /no RPC endpoint answered getGenesisHash.*nothing is assumed/);
  const pinned = await connect({ rpc: 'http://127.0.0.1:9', keypair: kp, rules: 2, onWarning: () => {} });
  assert.equal(pinned.rules, 2, 'pinned rules need no cluster answer');
  await assert.rejects(connect({ rpc: 'http://127.0.0.1:9', genesis: X1_MAINNET_GENESIS, keypair: kp, rules: 3, onWarning: () => {} }), /rules: 3 was pinned, but X1 mainnet reports rules unknown/);
});

test('connect({ card }): a kit older than the card\'s minKitVersion refuses every send; an up-to-date one does not', async () => {
  const { connect } = await import('../../moonforge.mjs');
  const kp = Keypair.generate();
  const warnings = [];
  const old = await connect({ rpc: 'http://127.0.0.1:9', genesis: 'LocalTestGenesis111111111111111111111111111', keypair: kp, card: { minKitVersion: '9.0.0' }, onWarning: (t) => warnings.push(t) });
  assert.equal(old.kitCheck.ok, false);
  assert.ok(warnings.some((w) => /older than the minimum/.test(w)));
  await assert.rejects(old.send({}, 'deposit'), /deposit: this kit \(2\.0\.0\) is older than the minimum the agent card names \(9\.0\.0\).*Nothing was sent/);
  const ok = await connect({ rpc: 'http://127.0.0.1:9', genesis: 'LocalTestGenesis111111111111111111111111111', keypair: kp, card: { minKitVersion: '2.0.0' }, onWarning: () => {} });
  assert.equal(ok.kitCheck.ok, true);
});

test('live rules: every final-upgrade method refuses before anything is built', async () => {
  const mf = offlineKit({ rules: 2, idl: live });
  const asset = someKey();
  const calls = {
    placeBetV2: () => mf.placeBetV2(0, 0, 1, 0.01), anchorBet: () => mf.anchorBet(someKey()), refundStalledBet: () => mf.refundStalledBet(someKey()), waitBet: () => mf.waitBet(someKey()),
    createDuelSealed: () => mf.createDuelSealed(0.1, 1), joinDuelSealed: () => mf.joinDuelSealed(someKey(), 1), revealDuelJoin: () => mf.revealDuelJoin(someKey()),
    createWarSealed: () => mf.createWarSealed(0.1), joinWarSealed: () => mf.joinWarSealed(someKey()), advanceStart: () => mf.advanceStart(someKey()),
    forge: () => mf.forge(1), forgePrice: () => mf.forgePrice(0), listings: () => mf.listings(), listArtifact: () => mf.listArtifact(asset, 9), updateListing: () => mf.updateListing(asset, 9),
    delistArtifact: () => mf.delistArtifact(asset), closeListing: () => mf.closeListing(asset), buyArtifact: () => mf.buyArtifact(asset),
    claimExtra: () => mf.claimExtra(1), verifyExtraClaim: () => mf.verifyExtraClaim(1), claimAllExtra: () => mf.claimAllExtra(),
  };
  for (const [name, call] of Object.entries(calls)) {
    await assert.rejects(call(), (e) => { assert.match(e.message, /needs the final program upgrade/, name); assert.match(e.message, /Nothing was sent/); assert.match(e.message, /binary hash at least 48 hours before/, 'option B wording (r4-fix, review r4 finding 8)'); assert.doesNotMatch(e.message, /hash at least 7 days/); return true; });
  }
  assert.equal(mf.sent.length, 0);
});

test('unknown rules (a half-done upgrade, an unreadable answer): every call refuses, live or new', async () => {
  const mf = offlineKit({ rules: 'unknown', idl: live });
  for (const call of [() => mf.deposit(1), () => mf.withdraw(1), () => mf.placeBet(0, 0, 1, 0.01), () => mf.houseDeposit(1), () => mf.donate('reward', 1), () => mf.claimPredictions(), () => mf.placeBetV2(0, 0, 1, 0.01)]) {
    await assert.rejects(call(), /rules are unknown right now/);
  }
  assert.equal(mf.sent.length, 0);
});

test('rules: a failed re-read keeps the last clear reading and retries soon; the RPC key never reaches a reason', async () => {
  const { RULES_RETRY_MS } = await import('../../moonforge.mjs');
  const { detectRules } = await import('../../detect.mjs');
  const failing = offlineConnection({ getAccountInfo: async () => { throw new Error('request to https://x1.example.com/v1/SECRETKEY?api-key=SECRET2 failed, reason: 429 Too Many Requests'); } });
  const d = await detectRules(failing, () => null, { mainnet: true });
  assert.equal(d.rules, 'unknown');
  assert.equal(d.transient, true);
  assert.ok(!d.reasons.join(' ').includes('SECRET'), `the API key is cut from the reason: ${d.reasons.join(' ')}`);
  assert.match(d.reasons[0], /https:\/\/x1\.example\.com/);
  const mf = offlineKit({ rules: 3, connection: failing });
  mf.mainnet = true;
  mf.detection.at = 0;
  assert.equal(await mf.rulesNow(), 3, 'a transport error is not a reading: the last clear one stays');
  assert.ok(!JSON.stringify(mf.detection).includes('SECRET'));
  const age = Date.now() - mf.detection.at;
  assert.ok(age >= mf.rulesTtlMs - RULES_RETRY_MS - 1_000 && age <= mf.rulesTtlMs, 're-read within RULES_RETRY_MS, not after a whole TTL');
  assert.equal(mf.warnings.filter((w) => /rules changed/.test(w)).length, 0, 'no false "rules changed" warning');
});

test('unknown rules: a sealed game\'s own account lets its time-critical step through; anything else still refuses', async () => {
  const sealed = { state: 2, turn: 0, targetSlot: new BN(V3.WAR_V2.toString()), creator: someKey(), opponent: someKey(), deadline: new BN(0) };
  const u = offlineKit({ rules: 'unknown' });
  u.war = async () => sealed;
  assert.deepEqual(await u.advanceStart(someKey()), { state: 2 }, 'the WAR_V2 bit proves the upgraded program');
  assert.ok(u.warnings.some((w) => /this game's own account was created by the upgraded program/.test(w)));
  u.war = async () => ({ ...sealed, targetSlot: new BN(0) });
  await assert.rejects(u.advanceStart(someKey()), /rules are unknown right now/);
  u.acc = { ...u.acc, duel: { fetchNullable: async () => ({ opponentCommitment: Array(32).fill(0), opponentElement: 255 }) } };
  await assert.rejects(u.revealDuelJoin(someKey()), /rules are unknown right now/, 'a duel not joined sealed proves nothing');
  const l = offlineKit({ rules: 'unknown', idl: live });
  l.war = async () => sealed;
  await assert.rejects(l.advanceStart(someKey()), /rules are unknown right now/, 'with the live IDL in use the proof is not taken');
});

test('layout facts come from the IDL in use (offsets of the memcmp filters, settle_bet_v2 discriminator)', async () => {
  const { accountFieldOffset, ixDiscriminatorHex } = await import('../../idl.mjs');
  assert.equal(accountFieldOffset(v3, 'Duel', 'creator'), 8);
  assert.equal(accountFieldOffset(v3, 'Duel', 'opponent'), 88);
  assert.equal(accountFieldOffset(v3, 'Duel', 'state'), 122);
  assert.equal(accountFieldOffset(v3, 'Listing', 'seller'), 40);
  assert.equal(accountFieldOffset(v3, 'Listing', 'tier'), 128);
  for (const idl of [live, v3]) {
    assert.equal(accountFieldOffset(idl, 'War', 'creator'), 8);
    assert.equal(accountFieldOffset(idl, 'War', 'opponent'), 40);
    assert.equal(accountFieldOffset(idl, 'War', 'state'), 88);
  }
  assert.equal(ixDiscriminatorHex(v3, 'settle_bet_v2'), disc('settle_bet_v2'));
  assert.equal(ixDiscriminatorHex(live, 'settle_bet_v2'), null, 'the live IDL has no settle_bet_v2: waitBet then reports verified:null');
  assert.throws(() => accountFieldOffset(v3, 'Duel', 'nope'), /no field nope/);
  // the filters the kit sends are the IDL's
  const { mf } = kit3();
  const seen = [];
  mf.acc = { ...mf.acc, duel: { all: async (f) => { seen.push(f); return []; } }, listing: { all: async (f) => { seen.push(f); return []; } } };
  mf.chainTime = async () => 1_800_000_000;
  await mf.openDuels();
  await mf.myDuels();
  await mf.listings({ tier: 1, seller: someKey() });
  assert.deepEqual(seen.flat().map((x) => x.memcmp.offset), [122, 8, 88, 40, 128]);
});

test('rules 3: the live calls the upgrade retired refuse with the program\'s code, nothing sent', async () => {
  const { mf } = kit3();
  await assert.rejects(mf.placeBet(0, 0, 1, 0.01), (e) => { assert.equal(programErrorNumber(e), 6088); assert.equal(programErrorName(e), 'KeeperRequired'); assert.match(errorMessage(e), /placeBetV2/); return true; });
  await assert.rejects(mf.createWar(1), (e) => { assert.equal(programErrorNumber(e), 6065); assert.match(e.message, /SealedJoinRequired/); return true; });
  await assert.rejects(mf.joinWar(someKey()), (e) => programErrorNumber(e) === 6065);
  assert.equal(mf.sent.length, 0);
  assert.equal(mf.warnings.filter((w) => w.startsWith('House games')).length, 1, 'the house-games notice is printed before the refusal');
});

test('rules 3 with the live IDL passed by hand: new methods refuse (the interface lacks them)', async () => {
  const mf = offlineKit({ rules: 3, idl: live });
  await assert.rejects(mf.placeBetV2(0, 0, 1, 0.01), /IDL in use is not the upgraded program's/);
});

test('placeBetV2 + anchorBet: place_bet_v2 with the keeper seat, then anchor_bet with the SlotHashes sysvar', async () => {
  const { mf, ps } = kit3();
  const bet = PDA.bet(ps, 4n);
  let anchored = false;
  mf.acc.bet = { fetchNullable: async () => ({ game: anchored ? 0xc0 : 0x80, seed: Buffer.alloc(32, 1), targetSlot: new BN(betPack(3, 1000).toString()) }), fetch: async () => ({ game: 0xc0, seed: Buffer.alloc(32, 2) }) };
  const realSend = mf.send;
  mf.send = async (b, n, o) => { const r = await realSend(b, n, o); if (n === 'anchorBet') anchored = true; return r; };
  const r = await mf.placeBetV2(1, 4_000, 0, 0.05);
  assert.equal(r.anchored, true);
  assert.deepEqual(r.odds, { chanceBps: 4_000, payoutBps: 24_500 });
  assertIx(mf.sent[0].ix, 'place_bet_v2', {
    config: PDA.config(), player_state: ps, bet, bankroll_vault: PDA.bankrollVault(), reward_vault: PDA.rewardVault(), architect: ARCHITECT, signer: mf.me,
    system_program: SystemProgram.programId, keeper_seat: PDA.houseKeeper(),
  });
  assertIx(mf.sent[1].ix, 'anchor_bet', { bet, slot_hashes: SYSVAR_SLOT_HASHES_PUBKEY });
  await assert.rejects(mf.placeBetV2(0, 0, 1, 0.001), /minimum stake is 0.01 XNT/);
});

test('placeBetV2 refuses while the keeper is not armed', async () => {
  const { mf } = kit3();
  mf.houseKeeper = async () => ({ armed: false, reason: 'the keeper chain has no positions left (wait for it to re-arm)' });
  await assert.rejects(mf.placeBetV2(0, 0, 1, 0.01), /no positions left/);
  assert.equal(mf.sent.length, 0);
});

test('refundStalledBet: refund_stalled_bet with the keeper seat and the reward vault', async () => {
  const { mf, ps } = kit3();
  const bet = someKey(), rentPayer = someKey();
  mf.acc.bet = { fetch: async () => ({ playerState: ps, rentPayer }) };
  await mf.refundStalledBet(bet);
  assertIx(mf.sent[0].ix, 'refund_stalled_bet', {
    config: PDA.config(), bet, player_state: ps, bankroll_vault: PDA.bankrollVault(), slot_hashes: SYSVAR_SLOT_HASHES_PUBKEY, rent_payer: rentPayer, keeper_seat: PDA.houseKeeper(), reward_vault: PDA.rewardVault(),
  });
});

test('sealed duel: the secret is on disk before the commitment is sent; a retry commits to the same bytes; join and open', async () => {
  const { mf, ps } = kit3();
  const duel = PDA.duel(mf.me, 4n);
  const realSend = mf.send;
  mf.send = async (b, n, o) => {
    if (n === 'createDuel') assert.ok(fs.existsSync(mf.secrets.pathOf('duel-create', duel.toBase58())), 'secret written before the broadcast');
    return realSend(b, n, o);
  };
  const r1 = await mf.createDuelSealed(0.2, 'Solar');
  const r2 = await mf.createDuelSealed(0.2, 'Lunar'); // a retry for the same account reuses the stored secret
  assert.equal(r1.element, undefined, 'the sealed element is never returned (tool results get logged)');
  assert.equal(r1.sealed, true);
  assert.ok(!JSON.stringify({ ...r1, duel: r1.duel.toBase58() }).match(/Solar|salt/), 'nothing of the secret in the result');
  assert.deepEqual(mf.sent[0].ix.data, mf.sent[1].ix.data, 'identical instruction bytes on a retry');
  const rec = mf.secrets.get('duel-create', duel.toBase58());
  assert.equal(rec.element, 2, 'the stored element (Solar) wins on a retry');
  assert.deepEqual(mf.sent[0].ix.data.subarray(16, 48), duelCommitment(rec.element, rec.salt, duel));
  assertIx(mf.sent[0].ix, 'create_duel', { config: PDA.config(), creator_state: ps, duel, owner: mf.me, asset: SystemProgram.programId, record: SystemProgram.programId, collection: SystemProgram.programId });

  const { mf: j } = kit3();
  const creator = someKey();
  j.acc.duel = { fetch: async () => ({ state: 0, creator }) };
  let t = 1_800_000_000;
  j.chainTime = async () => t++;
  const joined = await j.joinDuelSealed(duel, 2);
  assert.equal(joined.opened, true);
  const jr = j.secrets.get('duel-join', duel.toBase58());
  assert.deepEqual(j.sent[0].ix.data.subarray(8, 40), duelJoinCommitment(jr.element, jr.salt, duel, j.me));
  assertIx(j.sent[0].ix, 'join_duel_sealed', { config: PDA.config(), duel, opponent: j.me, asset: SystemProgram.programId });
  assertIx(j.sent[1].ix, 'reveal_duel_join', { duel, opponent: j.me });
  assert.equal(j.sent[1].opts.resend, true, 'the opening is rebroadcast until it lands');
});

test('revealDuel (creator) builds the nested resolve accounts; a sealed join must be opened first', async () => {
  const { mf } = kit3();
  const duel = PDA.duel(mf.me, 4n);
  await mf.createDuelSealed(0.2, 0);
  const opponent = someKey();
  mf.acc.duel = { fetch: async () => ({ opponentElement: 255, creator: mf.me, opponent, rentPayer: mf.me }) };
  await assert.rejects(mf.revealDuel(duel), /has not opened its element yet/);
  mf.acc.duel = { fetch: async () => ({ opponentElement: 1, creator: mf.me, opponent, rentPayer: mf.me }) };
  await mf.revealDuel(duel);
  assertIx(mf.sent.at(-1).ix, 'reveal_duel', {
    config: PDA.config(), duel, creator_state: PDA.player(mf.me), opponent_state: PDA.player(opponent), reward_vault: PDA.rewardVault(), draw_vault: PDA.drawVault(), architect: ARCHITECT, rent_payer: mf.me, creator: mf.me,
  });
});

test('sealed Moon Wars: create with the entropy commitment, join with the secret commitment, seed and reveal', async () => {
  const { mf, ps } = kit3();
  const war = PDA.war(mf.me, 4n);
  await mf.createWarSealed(0.5);
  const rec = mf.secrets.get('war-create', war.toBase58());
  assertIx(mf.sent[0].ix, 'create_war_sealed', { config: PDA.config(), creator_state: ps, war, owner: mf.me, asset: SystemProgram.programId });
  assert.deepEqual(mf.sent[0].ix.data.subarray(48, 80), warEntropyCommitment(rec.entropy, war));
  mf.war = async () => ({ state: 1, turn: 0, creator: mf.me, opponent: someKey(), deadline: new BN(1_900_000_000), targetSlot: new BN((1n << 63n).toString()) });
  await mf.advanceStart(war);
  assertIx(mf.sent.at(-1).ix, 'seed_war', { war, signer: mf.me });
  assert.deepEqual(mf.sent.at(-1).ix.data.subarray(8, 40), Buffer.from(rec.entropy, 'hex'));

  const { mf: j } = kit3();
  j.war = async () => ({ state: 0, creator: mf.me, targetSlot: new BN((1n << 63n).toString()) });
  await j.joinWarSealed(war);
  const jr = j.secrets.get('war-join', war.toBase58());
  assert.deepEqual(j.sent[0].ix.data.subarray(8, 40), warJoinCommitment(jr.secret, war, j.me, new PublicKey(jr.moveKey)));
  j.war = async () => ({ state: 1, turn: 1, creator: mf.me, opponent: j.me, deadline: new BN(1_900_000_000), targetSlot: new BN((1n << 63n).toString()) });
  await j.advanceStart(war);
  assertIx(j.sent.at(-1).ix, 'reveal_war', { war, signer: j.me });
  // a legacy OPEN match cannot be joined sealed
  j.war = async () => ({ state: 0, creator: mf.me, targetSlot: new BN(0) });
  await assert.rejects(j.joinWarSealed(war), /not an open sealed match/);
});

test('forge(tier, maxPrice): the PX price, refused above the maximum, built with the extra-pot accounts', async () => {
  const { mf } = kit3();
  mf.connection.getAccountInfo = async () => ({ owner: SystemProgram.programId, data: Buffer.alloc(0), lamports: 1 });
  // never forged, read 10 days after PRICE_LAUNCH_TS: Lunar Dust decays 2% a day towards 3 XNT
  mf.chainTime = async () => V3.PRICE_LAUNCH_TS + 10 * 86_400;
  const p = await mf.forgePrice(0);
  assert.ok(p.xnt < 10 && p.xnt > 8, `${p.xnt}`);
  await assert.rejects(mf.forge(0, { maxPriceXnt: 5 }), /above your maximum/);
  const r = await mf.forge(0);
  const asset = PDA.asset(0, 5);
  assert.ok(r.asset.equals(asset));
  assertIx(mf.sent[0].ix, 'forge_artifact', {
    config: PDA.config(), asset, record: PDA.artifact(asset), collection: PDA.collection(), artifact_authority: PDA.artifactAuthority(), reward_vault: PDA.rewardVault(),
    draw_vault: PDA.drawVault(), architect: ARCHITECT, buyer: mf.me, core_program: MPL_CORE, system_program: SystemProgram.programId, extra_state: PDA.extraState(), extra_vault: PDA.extraVault(),
  });
});

test('market: list (floor rule, add_plugin from the asset), buy (delegate check), delist, close', async () => {
  const { mf } = kit3();
  const asset = PDA.asset(1, 2);
  const listing = PDA.listing(asset);
  const record = { asset, tier: 1, serial: 2, backing: new BN((12_500_000_000n).toString()), origin: 0, forgedAt: new BN(1_799_000_000) };
  mf.isGenuineArtifact = async () => ({ genuine: true, reasons: [], owner: mf.me.toBase58(), record });
  mf.acc.listing = { fetchNullable: async () => null };
  // an asset whose TransferDelegate plugin exists (authority Owner): add_plugin = false
  const str = (s) => { const b = Buffer.from(s); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
  const baseBytes = Buffer.concat([Buffer.from([1]), mf.me.toBuffer(), Buffer.from([2]), PDA.collection().toBuffer(), str('Cosmic Shard #2'), str('u'), Buffer.from([0])]);
  const at = baseBytes.length + 9 + 1;
  const header = Buffer.alloc(9); header[0] = 3; header.writeBigUInt64LE(BigInt(at), 1);
  const off = Buffer.alloc(8); off.writeBigUInt64LE(BigInt(baseBytes.length + 9));
  const count = Buffer.alloc(4); count.writeUInt32LE(1);
  const assetData = Buffer.concat([baseBytes, header, Buffer.from([3]), Buffer.from([4]), count, Buffer.from([3, 1]), off, Buffer.alloc(4)]);
  mf.connection.getAccountInfo = async () => ({ owner: MPL_CORE, data: assetData, lamports: 1 });
  await assert.rejects(mf.listArtifact(asset, 13), /less than this Artifact's floor/);
  const l = await mf.listArtifact(asset, 20, { expiresInDays: 10 });
  assert.equal(l.sellerNetXnt, 18.6);
  assertIx(mf.sent[0].ix, 'list_artifact', { config: PDA.config(), listing, asset, record: PDA.artifact(asset), collection: PDA.collection(), seller: mf.me, core_program: MPL_CORE });
  assert.equal(mf.sent[0].ix.data.at(-1), 0, 'add_plugin = false: the asset already has its TransferDelegate plugin');

  const { mf: b } = kit3();
  const seller = someKey();
  b.artifactInfo = async () => ({ genuine: true, reasons: [], floorXnt: 12.5, listing: { seller: seller.toBase58(), expired: false, stale: false, reservedBuyer: null, delegateOk: true } });
  b.acc.listing = { fetch: async () => ({ price: new BN((20n * 10n ** 9n).toString()), seller }) };
  await assert.rejects(b.buyArtifact(asset, { maxPriceXnt: 19 }), /above your maximum/);
  await b.buyArtifact(asset);
  assertIx(b.sent[0].ix, 'buy_artifact', { config: PDA.config(), listing, asset, record: PDA.artifact(asset), collection: PDA.collection(), buyer: b.me, seller, architect: ARCHITECT, reward_vault: PDA.rewardVault(), core_program: MPL_CORE });
  b.artifactInfo = async () => ({ genuine: true, reasons: [], listing: { seller: seller.toBase58(), expired: false, stale: false, reservedBuyer: null, delegateOk: false } });
  await assert.rejects(b.buyArtifact(asset), /Core would refuse the transfer/);
  b.artifactInfo = async () => ({ genuine: true, reasons: [], listing: { seller: seller.toBase58(), expired: false, stale: false, reservedBuyer: someKey().toBase58(), delegateOk: true } });
  await assert.rejects(b.buyArtifact(asset), /ListingReserved/);

  mf.acc.listing = { fetchNullable: async () => ({ seller: mf.me }) };
  await mf.delistArtifact(asset);
  assertIx(mf.sent.at(-1).ix, 'delist_artifact', { config: PDA.config(), listing, asset, collection: PDA.collection(), seller: mf.me });
  mf.acc.listing = { fetchNullable: async () => ({ seller }) };
  await mf.closeListing(asset);
  assertIx(mf.sent.at(-1).ix, 'close_listing', { config: PDA.config(), listing, seller, asset, collection: PDA.collection() });
});

test('transferArtifact: a Core TransferV1 signed by the holder; refuses a non-wallet destination and an open listing', async () => {
  const { mf } = kit3();
  const asset = PDA.asset(0, 1);
  const to = Keypair.generate().publicKey;
  mf.isGenuineArtifact = async () => ({ genuine: true, reasons: [], owner: mf.me.toBase58(), record: {} });
  mf.connection.getAccountInfo = async () => null;
  mf.acc.listing = { fetchNullable: async () => ({ seller: mf.me }) };
  await assert.rejects(mf.transferArtifact(asset, to), /open listing/);
  mf.acc.listing = { fetchNullable: async () => null };
  await mf.transferArtifact(asset, to);
  const ix = mf.sent[0].ix;
  assert.ok(ix.programId.equals(MPL_CORE));
  assert.deepEqual([...ix.data], [14, 0]);
  assert.ok(ix.keys[0].pubkey.equals(asset) && ix.keys[0].isWritable);
  assert.ok(ix.keys[2].pubkey.equals(mf.me) && ix.keys[2].isSigner);
  assert.ok(ix.keys[4].pubkey.equals(to));
  mf.connection.getAccountInfo = async () => ({ executable: true, owner: SystemProgram.programId });
  await assert.rejects(mf.transferArtifact(asset, Keypair.generate().publicKey), /not a wallet/);
});

test('claimExtra: claim_extra with the extra-pot accounts after the leaf verifies', async () => {
  const { mf } = kit3();
  mf.verifyExtraClaim = async () => ({ ok: true, claimed: false, closed: false, onHold: false, index: 2, amount: '5000000', amountXnt: 0.005, proof: ['11'.repeat(32)], reasons: [] });
  const r = await mf.claimExtra(4);
  assert.equal(r.amountXnt, 0.005);
  assertIx(mf.sent[0].ix, 'claim_extra', { config: PDA.config(), extra_state: PDA.extraState(), extra_epoch: PDA.extraEpoch(4), extra_vault: PDA.extraVault(), wallet: mf.me, payer: mf.me, system_program: SystemProgram.programId });
  mf.verifyExtraClaim = async () => ({ ok: true, claimed: false, closed: false, onHold: true, claimableFrom: 1_800_100_000, reasons: [] });
  await assert.rejects(mf.claimExtra(4), /ClaimOnHold/);
});

test('status() under rules 3 returns the v3 notices (still four) and the keeper', async () => {
  const { mf } = kit3();
  Object.assign(mf, {
    gameBalance: async () => 0n, myArtifacts: async () => [], openWars: async () => [], xntUsd: async () => 0.2, myPredictionEntries: async () => [], houseShare: async () => null,
    bankroll: async () => ({ unreserved: 0n, reserved: 0n, conservative: 0n, totalShares: 0n, protocolShares: 0n, haircutBps: 0 }),
  });
  mf.connection.getBalance = async () => 1_000_000_000;
  mf.connection.getAccountInfo = async () => null;
  mf.capacity = async () => ({ rules: 'v3', available: false });
  const s = await mf.status();
  assert.equal(s.notices.length, 4);
  assert.match(s.notices[0], /^Moon Wars \(final upgrade\)/);
  assert.equal(s.rules.rules, 3);
  assert.ok(s.houseKeeper);
  assert.equal(s.kitVersion, '2.0.0');
});

test('round 4: settledBetResult reads the G-2 keeper tip of BetSettled; a stall refund is paid from the keeper bond', async () => {
  const { mf } = kit3();
  const ev = (name) => Buffer.from(v3.events.find((e) => e.name === name).discriminator);
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const bet = someKey(), owner = someKey();
  const program = mf.program.programId.toBase58();
  const tx = (data) => ({ meta: { logMessages: [`Program ${program} invoke [1]`, `Program data: ${data.toString('base64')}`, `Program ${program} success`] }, transaction: { message: { staticAccountKeys: [], compiledInstructions: [] } } });
  mf.connection.getSignaturesForAddress = async () => [{ signature: 'SIG-SETTLE', err: null }];
  // BetSettled { owner, bet, game, roll, won, expired, stake, payout, keeper_tip }
  const settled = Buffer.concat([ev('BetSettled'), owner.toBuffer(), bet.toBuffer(), Buffer.from([0]), u64(1_234), Buffer.from([1, 0]), u64(10_000_000), u64(19_600_000), u64(50_000)]);
  mf.connection.getTransaction = async () => tx(settled);
  const r = await mf.settledBetResult(bet);
  assert.equal(r.state, 'settled');
  assert.equal(r.won, true);
  assert.equal(r.payoutXnt, 0.0196);
  assert.equal(r.keeperTipXnt, 0.00005, 'half of the 0.01 XNT stake\'s 1% pool share');
  // BetRefunded { bet, player, stake, penalty, reason }: reason 0 = never anchored, the bond forfeited stake − edge
  const refunded = Buffer.concat([ev('BetRefunded'), bet.toBuffer(), owner.toBuffer(), u64(10_000_000), u64(9_850_000), Buffer.from([0])]);
  mf.connection.getTransaction = async () => tx(refunded);
  const s = await mf.settledBetResult(bet);
  assert.equal(s.state, 'refunded');
  assert.equal(s.reason, 0);
  // r4-fix (review r4 finding 1): reason 0 undoes the bet for the bankroll; the penalty is what the bond forfeited
  assert.equal(s.paidFrom, 'bankroll (stake - edge) and keeper bond (edge)');
  assert.equal(s.bankrollKeptXnt, 0);
  assert.equal(s.bondForfeitXnt, 0.00985);
  // reason 1: the bond paid the payout, the bankroll kept stake - edge
  const refunded1 = Buffer.concat([ev('BetRefunded'), bet.toBuffer(), owner.toBuffer(), u64(10_000_000), u64(9_850_000), Buffer.from([1])]);
  mf.connection.getTransaction = async () => tx(refunded1);
  const s1 = await mf.settledBetResult(bet);
  assert.deepEqual([s1.reason, s1.paidFrom, s1.bankrollKeptXnt, s1.bondForfeitXnt], [1, 'keeper bond', 0.00985, undefined]);
  assert.match(s.note, /whole stake is refunded \(stake - edge by the bankroll, the edge by the keeper bond, which also forfeits stake - edge\)/);
});