// Measures compute units per Moon Forge instruction with simulateTransaction on X1 mainnet (read-only:
// no key, no signature; sigVerify=false; real on-chain accounts stand in as signers).
// Usage: npm run measure:cu [-- rpc]   → writes scripts/CU-MEASUREMENTS.md + scripts/cu-measurements.json.
// Re-run after every program upgrade, then copy the numbers into src/lib/cu.ts (CU_MEASURED, CU_MEASURED_PROGRAM).
import { createRequire } from 'module';
import { writeFileSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// Frontend root = the parent of this scripts/ directory (works from any checkout).
const FE = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(FE, 'package.json'));
const anchor = require('@coral-xyz/anchor');
const { Connection, PublicKey, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY, Keypair, Transaction } = require('@solana/web3.js');
const idl = JSON.parse(readFileSync(FE + '/src/idl/moon_forge.json', 'utf8'));
const here = dirname(fileURLToPath(import.meta.url));

const RPC = process.argv[2] || 'https://rpc.mainnet.x1.xyz';
const connection = new Connection(RPC, 'confirmed');
const PROGRAM_ID = new PublicKey(idl.address);
const ARCHITECT = new PublicKey('7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd');
const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const XNT = 1_000_000_000;
const u64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const enc = (s) => new TextEncoder().encode(s);
const pda = (...s) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
const PDA = {
  config: () => pda(enc('config')), rewardVault: () => pda(enc('reward_vault')), bankrollVault: () => pda(enc('bankroll_vault')),
  drawVault: () => pda(enc('draw_vault')), collection: () => pda(enc('collection')), artifactAuthority: () => pda(enc('artifact_authority')),
  epoch: (n) => pda(enc('epoch'), u64(n)), receipt: (n, p, t) => pda(enc('receipt'), u64(n), p.toBytes(), Uint8Array.of(t)),
  mission: (n, p, t) => pda(enc('mission'), u64(n), p.toBytes(), Uint8Array.of(t)), player: (o) => pda(enc('player'), o.toBytes()),
  bet: (ps, n) => pda(enc('bet'), ps.toBytes(), u64(n)), house: (o) => pda(enc('house'), o.toBytes()),
  jackpot: (r) => pda(enc('jackpot'), u64(r)), jpEntry: (r, i) => pda(enc('jp_entry'), u64(r), u32(i)),
  draw: (r) => pda(enc('draw'), u64(r)), drawEntry: (r, i) => pda(enc('draw_entry'), u64(r), u32(i)),
  duel: (c, n) => pda(enc('duel'), c.toBytes(), u64(n)), asset: (t, s) => pda(enc('asset'), Uint8Array.of(t), u32(s)),
  artifact: (a) => pda(enc('artifact'), a.toBytes()), airdrop: (c) => pda(enc('airdrop'), c.toBytes()),
  drop: (n, p, t) => pda(enc('drop'), u64(n), p.toBytes(), Uint8Array.of(t)), war: (c, n) => pda(enc('war'), c.toBytes(), u64(n)),
  pred: (r) => pda(enc('pred'), u64(r)), predEntry: (r, pl) => pda(enc('pred_entry'), u64(r), pl.toBytes()),
};
const bn = (n) => new anchor.BN(n.toString());
const programFor = (pk) => new anchor.Program(idl, new anchor.AnchorProvider(connection, { publicKey: pk, signTransaction: async (t) => t, signAllTransactions: async (t) => t }, { commitment: 'confirmed' }));
const reader = programFor(PublicKey.default);
const A = reader.account;

const rows = [];
async function sim(name, feePayer, build, note = '') {
  try {
    const program = programFor(feePayer);
    const tx = await build(program);
    tx.feePayer = feePayer;
    const r = await connection.simulateTransaction(tx);
    const v = r.value;
    const errLine = (v.logs || []).filter((l) => /Error|failed|insufficient/i.test(l)).slice(-1)[0] || '';
    rows.push({ name, ok: !v.err, units: v.unitsConsumed ?? null, err: v.err ? JSON.stringify(v.err).slice(0, 120) : '', detail: errLine.slice(0, 160), note });
    console.log(`${v.err ? 'FAIL' : ' ok '} ${name.padEnd(24)} ${String(v.unitsConsumed ?? '-').padStart(8)} ${v.err ? JSON.stringify(v.err).slice(0, 100) : ''} ${errLine.slice(0, 120)}`);
  } catch (e) {
    rows.push({ name, ok: false, units: null, err: String(e.message || e).slice(0, 160), detail: '', note });
    console.log(`SKIP ${name.padEnd(24)}          ${String(e.message || e).slice(0, 140)}`);
  }
}
const skip = (name, why) => { rows.push({ name, ok: false, units: null, err: 'not measurable on mainnet now', detail: why, note: '' }); console.log(`SKIP ${name.padEnd(24)}          ${why}`); };

const now = Math.floor(Date.now() / 1000);
const cfg = await A.config.fetch(PDA.config());
const archBal = await connection.getBalance(ARCHITECT);
console.log('config ok; architect balance', archBal / XNT, 'XNT; jackpotRound', Number(cfg.jackpotRound), 'drawRound', Number(cfg.drawRound));

// ── discovery ──────────────────────────────────────────────────────────────
const players = await A.playerState.all();
const byBal = [...players].sort((a, b) => Number(b.account.balance) - Number(a.account.balance));
const rich = byBal[0];
const withChips = players.find((p) => Number(p.account.chips) >= 1);
console.log('players', players.length, 'richest balance', rich ? Number(rich.account.balance) / XNT : null);
const shares = await A.houseShare.all();
const missions = await A.mission.all();
const records = await A.artifactRecord.all();
const infos = [];
for (let i = 0; i < records.length; i += 100) infos.push(...(await connection.getMultipleAccountsInfo(records.slice(i, i + 100).map((r) => r.account.asset))));
const artifacts = records.map((r, i) => ({ r, info: infos[i] })).filter(({ info }) => info && info.owner.equals(MPL_CORE) && info.data[0] === 1)
  .map(({ r, info }) => ({ asset: r.account.asset, tier: r.account.tier, owner: new PublicKey(info.data.subarray(1, 33)), lastChipWeek: Number(r.account.lastChipWeek) }));
console.log('artifacts alive', artifacts.length, 'shares', shares.length, 'missions', missions.length);
const duels = await A.duel.all();
const wars = await A.war.all();
const bets = await A.bet.all();
const preds = await A.predRound.all();
const predEntries = await A.predEntry.all();
console.log('duels', duels.length, 'wars', wars.length, 'open bets', bets.length, 'pred rounds', preds.length, 'pred entries', predEntries.length);

const ownerWithPlayer = (owner) => players.find((p) => p.account.owner.equals(owner));
const fundedNoPlayer = async () => {
  const cands = [ARCHITECT, ...artifacts.map((a) => a.owner), ...missions.map((m) => m.account.player)];
  for (const c of cands) if (!ownerWithPlayer(c) && (await connection.getBalance(c)) > 0.05 * XNT) return c;
  return null;
};

// ── simulations ────────────────────────────────────────────────────────────
const SYS = SystemProgram.programId;
await sim('donate', ARCHITECT, (p) => p.methods.donate(0, bn(0.01 * XNT)).accountsPartial({ config: PDA.config(), donor: ARCHITECT, vault: PDA.rewardVault() }).transaction());
await sim('system_transfer', ARCHITECT, async () => new Transaction().add(SystemProgram.transfer({ fromPubkey: ARCHITECT, toPubkey: Keypair.generate().publicKey, lamports: 5_000_000 })), 'fund / sweep of the Moon Wars move key');

const np = await fundedNoPlayer();
if (np) await sim('open_player', np, (p) => p.methods.openPlayer().accountsPartial({ playerState: PDA.player(np), owner: np, systemProgram: SYS }).transaction());
else skip('open_player', 'no funded wallet without a PlayerState among the candidates');

if (rich) {
  const o = rich.account.owner, ps = rich.publicKey;
  const oBal = await connection.getBalance(o);
  if (oBal > 0.02 * XNT) await sim('deposit', o, (p) => p.methods.deposit(bn(0.01 * XNT)).accountsPartial({ playerState: ps, payer: o, systemProgram: SYS }).transaction());
  else skip('deposit', 'richest player wallet holds < 0.02 XNT');
  const bal = Number(rich.account.balance);
  if (bal > 0) await sim('withdraw', o, (p) => p.methods.withdraw(bn(Math.min(bal, 1_000_000))).accountsPartial({ playerState: ps, owner: o }).transaction());
  else skip('withdraw', 'no PlayerState with a balance');
  await sim('set_session', o, (p) => p.methods.setSession(Keypair.generate().publicKey, bn(now + 3600), bn(0.1 * XNT)).accountsPartial({ playerState: ps, owner: o }).transaction());
  if (bal >= 0.01 * XNT) {
    const seed = Array.from(crypto.getRandomValues(new Uint8Array(32)));
    const stake = bn(0.01 * XNT);
    const common = { config: PDA.config(), playerState: ps, bet: PDA.bet(ps, BigInt(rich.account.nonce.toString())), bankrollVault: PDA.bankrollVault(), rewardVault: PDA.rewardVault(), architect: ARCHITECT, signer: o, systemProgram: SYS };
    await sim('place_bet:coinflip', o, (p) => p.methods.placeBet(0, bn(0), 0, stake, seed).accountsPartial(common).transaction());
    await sim('place_bet:highlow', o, (p) => p.methods.placeBet(1, bn(5000), 0, stake, seed).accountsPartial(common).transaction());
    await sim('place_bet:voidrush', o, (p) => p.methods.placeBet(2, bn(20_000), 0, stake, seed).accountsPartial(common).transaction());
    const jr = Number(cfg.jackpotRound);
    const jround = await A.jackpotRound.fetchNullable(PDA.jackpot(jr));
    const jidx = jround ? jround.entries : 0;
    if (!jround || jround.state === 0) await sim('enter_jackpot', o, (p) => p.methods.enterJackpot(bn(jr), jidx, stake).accountsPartial({ config: PDA.config(), round: PDA.jackpot(jr), entry: PDA.jpEntry(jr, jidx), playerState: ps, signer: o, systemProgram: SYS }).transaction(), jround ? `round ${jr} entry #${jidx}` : `new round ${jr}`);
    else skip('enter_jackpot', `round ${jr} is not open (state ${jround.state})`);
  } else skip('place_bet / enter_jackpot', 'no PlayerState holds >= 0.01 XNT');
} else skip('deposit / withdraw / set_session / place_bet / enter_jackpot', 'no PlayerState account on mainnet');

if (withChips) {
  const o = withChips.account.owner, ps = withChips.publicKey, dr = Number(cfg.drawRound);
  const dround = await A.drawRound.fetchNullable(PDA.draw(dr));
  const didx = dround ? dround.entries : 0;
  if (!dround || dround.state === 0) await sim('enter_draw', o, (p) => p.methods.enterDraw(bn(dr), didx, bn(1), bn(0)).accountsPartial({ config: PDA.config(), round: PDA.draw(dr), entry: PDA.drawEntry(dr, didx), playerState: ps, rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: ARCHITECT, signer: o, systemProgram: SYS }).transaction(), dround ? `round ${dr} entry #${didx}, 1 chip` : `new round ${dr}, 1 chip`);
  else skip('enter_draw', `round ${dr} is not open`);
} else skip('enter_draw', 'no PlayerState holds a chip');

// forge: tier 0 Lunar Dust at base price 10 XNT
const buyer = archBal > 11 * XNT ? ARCHITECT : null;
if (buyer) {
  const serial = cfg.artifactsMinted[0];
  const asset = PDA.asset(0, serial);
  await sim('forge_artifact:t0', buyer, (p) => p.methods.forgeArtifact(0, serial, bn(10 * XNT)).accountsPartial({ config: PDA.config(), asset, record: PDA.artifact(asset), collection: PDA.collection(), artifactAuthority: PDA.artifactAuthority(), rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: ARCHITECT, buyer, coreProgram: MPL_CORE, systemProgram: SYS }).transaction(), `serial ${serial}`);
  for (const t of [1, 2, 3]) {
    const price = [10, 25, 60, 200][t] * XNT;
    const stored = Number(cfg.artifactPrice[t]);
    const max = Math.max(price, stored) * 1.05;
    if (archBal > max + XNT) {
      const s = cfg.artifactsMinted[t], a = PDA.asset(t, s);
      await sim(`forge_artifact:t${t}`, buyer, (p) => p.methods.forgeArtifact(t, s, bn(Math.floor(max))).accountsPartial({ config: PDA.config(), asset: a, record: PDA.artifact(a), collection: PDA.collection(), artifactAuthority: PDA.artifactAuthority(), rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: ARCHITECT, buyer, coreProgram: MPL_CORE, systemProgram: SYS }).transaction(), `serial ${s}`);
    } else skip(`forge_artifact:t${t}`, 'no read-only wallet holds the price');
  }
} else skip('forge_artifact', 'no read-only wallet holds >= 11 XNT');

const art = artifacts[0];
if (art) {
  await sim('recycle_artifact', art.owner, (p) => p.methods.recycleArtifact().accountsPartial({ config: PDA.config(), asset: art.asset, record: PDA.artifact(art.asset), collection: PDA.collection(), owner: art.owner, coreProgram: MPL_CORE, systemProgram: SYS }).transaction(), `tier ${art.tier}`);
  const chipArt = artifacts.find((a) => ownerWithPlayer(a.owner) && a.lastChipWeek < Math.floor(now / (7 * 86400)));
  if (chipArt) await sim('claim_artifact_chips', chipArt.owner, (p) => p.methods.claimArtifactChips().accountsPartial({ config: PDA.config(), asset: chipArt.asset, record: PDA.artifact(chipArt.asset), collection: PDA.collection(), playerState: PDA.player(chipArt.owner), owner: chipArt.owner }).transaction(), `tier ${chipArt.tier}`);
  else skip('claim_artifact_chips', 'no artifact owner with a PlayerState and unclaimed chips this week');
  const duelist = artifacts.find((a) => { const ps = ownerWithPlayer(a.owner); return ps && Number(ps.account.balance) >= 0.1 * XNT; });
  if (duelist) {
    const ps = ownerWithPlayer(duelist.owner);
    const duel = PDA.duel(duelist.owner, BigInt(ps.account.nonce.toString()));
    await sim('create_duel', duelist.owner, (p) => p.methods.createDuel(bn(0.1 * XNT), Array.from(crypto.getRandomValues(new Uint8Array(32)))).accountsPartial({ config: PDA.config(), creatorState: ps.publicKey, duel, owner: duelist.owner, asset: duelist.asset, record: PDA.artifact(duelist.asset), collection: PDA.collection(), systemProgram: SYS }).transaction());
  } else skip('create_duel', 'no artifact owner has a game wallet with >= 0.1 XNT');
} else skip('recycle_artifact / claim_artifact_chips / create_duel', 'no live Artifact on mainnet');

// airdrop: a listed claimant without a receipt
try {
  const list = JSON.parse(readFileSync(FE + '/public/airdrop/airdrop.json', 'utf8'));
  const claimants = Object.keys(list.proofs || {});
  let found = null;
  for (const c of claimants.slice(0, 40)) { const pk = new PublicKey(c); if (!(await connection.getAccountInfo(PDA.airdrop(pk)))) { found = pk; break; } }
  if (found) {
    const serial = cfg.artifactsMinted[0], asset = PDA.asset(0, serial);
    const proof = list.proofs[found.toBase58()].map((h) => Array.from(Buffer.from(h, 'hex')));
    await sim('claim_airdrop', found, (p) => p.methods.claimAirdrop(serial, proof).accountsPartial({ config: PDA.config(), receipt: PDA.airdrop(found), asset, record: PDA.artifact(asset), collection: PDA.collection(), artifactAuthority: PDA.artifactAuthority(), claimant: found, coreProgram: MPL_CORE, systemProgram: SYS }).transaction(), `proof depth ${proof.length}`);
  } else skip('claim_airdrop', 'first 40 listed claimants all have a receipt');
} catch (e) { skip('claim_airdrop', 'airdrop.json unreadable: ' + e.message); }

// claims: an unclaimed leaf of an open epoch
try {
  const idx = JSON.parse(readFileSync(FE + '/public/epochs/index.json', 'utf8'));
  let done = { 0: false, 1: false };
  for (const e of idx.epochs.slice(-5).reverse()) {
    const ep = await A.epoch.fetchNullable(PDA.epoch(e.epoch));
    if (!ep || ep.closed || now >= Number(ep.expiresAt)) continue;
    const f = JSON.parse(readFileSync(FE + `/public/epochs/epoch-${e.epoch}.json`, 'utf8'));
    for (const l of f.leaves) {
      const kind = l.tier === 0 ? 0 : 1;
      if (done[kind]) continue;
      const player = new PublicKey(l.player);
      if (await connection.getAccountInfo(PDA.receipt(e.epoch, player, l.tier))) continue;
      const proof = (f.proofs[`${l.player}:${l.tier}`] || []).map((h) => Array.from(Buffer.from(h, 'hex')));
      const common = { config: PDA.config(), epoch: PDA.epoch(e.epoch), receipt: PDA.receipt(e.epoch, player, l.tier), player, playerState: PDA.player(player), rewardVault: PDA.rewardVault(), payer: player, systemProgram: SYS };
      if (kind === 0) await sim('claim_instant', player, (p) => p.methods.claimInstant(bn(e.epoch), l.tier, bn(l.score), proof).accountsPartial(common).transaction(), `epoch ${e.epoch}, proof depth ${proof.length}`);
      else await sim('claim_mission', player, (p) => p.methods.claimMission(bn(e.epoch), l.tier, bn(l.score), proof).accountsPartial({ ...common, mission: PDA.mission(e.epoch, player, l.tier) }).transaction(), `epoch ${e.epoch}, tier ${l.tier}, proof depth ${proof.length}`);
      done[kind] = true;
    }
  }
  if (!done[0]) skip('claim_instant', 'no unclaimed tier-0 leaf in an open epoch');
  if (!done[1]) skip('claim_mission', 'no unclaimed tier-1/2 leaf in an open epoch');
} catch (e) { skip('claim_instant / claim_mission', 'epoch files unreadable: ' + e.message); }

const m = missions.find((x) => Number(x.account.withdrawn) < Number(x.account.total));
if (m) {
  await sim('withdraw_vested', ARCHITECT, (p) => p.methods.withdrawVested().accountsPartial({ mission: m.publicKey, player: m.account.player, playerState: PDA.player(m.account.player), rentPayer: m.account.rentPayer }).transaction(), 'permissionless, any fee payer');
  await sim('eject', m.account.player, (p) => p.methods.eject().accountsPartial({ config: PDA.config(), mission: m.publicKey, player: m.account.player, rewardVault: PDA.rewardVault(), rentPayer: m.account.rentPayer, playerState: PDA.player(m.account.player) }).transaction());
} else skip('withdraw_vested / eject', 'no open Mission account on mainnet');

await sim('house_deposit', ARCHITECT, (p) => p.methods.houseDeposit(bn(0.1 * XNT), bn(0)).accountsPartial({ config: PDA.config(), share: PDA.house(ARCHITECT), bankrollVault: PDA.bankrollVault(), owner: ARCHITECT, systemProgram: SYS }).transaction(), archBal > 0.2 * XNT ? '' : 'architect balance low');
const sh = shares.find((s) => BigInt(s.account.shares.toString()) > 0n);
if (sh) await sim('house_request_withdraw', sh.account.owner, (p) => p.methods.houseRequestWithdraw(bn(1)).accountsPartial({ share: sh.publicKey, owner: sh.account.owner }).transaction());
else skip('house_request_withdraw', 'no HouseShare with shares');
const shp = shares.find((s) => BigInt(s.account.pendingShares.toString()) > 0n && Number(s.account.unlockTs) <= now);
if (shp) await sim('house_withdraw', shp.account.owner, (p) => p.methods.houseWithdraw(bn(0)).accountsPartial({ config: PDA.config(), share: shp.publicKey, bankrollVault: PDA.bankrollVault(), owner: shp.account.owner }).transaction());
else skip('house_withdraw', 'no HouseShare with unlocked pending shares');

// state-dependent P2P / keeper paths: only when such accounts exist right now
const jr = Number(cfg.jackpotRound);
const jround = await A.jackpotRound.fetchNullable(PDA.jackpot(jr));
if (jround && jround.state === 0 && Number(jround.endTs) > 0 && now >= Number(jround.endTs)) await sim('draw_jackpot', ARCHITECT, (p) => p.methods.drawJackpot().accountsPartial({ config: PDA.config(), round: PDA.jackpot(jr), firstPlayerState: PDA.player(jround.firstPlayer) }).transaction());
else skip('draw_jackpot', 'no ended, undrawn jackpot round');
skip('settle_jackpot', jround && jround.state === 1 ? 'drawing round exists but the winning entry lookup is not replicated here' : 'no jackpot round in the drawing state');
const refunded = (await A.jackpotRound.all()).find((r) => r.account.state === 3 && r.account.entries > 0);
if (refunded) {
  const id = Number(refunded.account.id);
  const e = await A.jackpotEntry.fetchNullable(PDA.jpEntry(id, 0));
  if (e) await sim('close_jackpot_entry', ARCHITECT, (p) => p.methods.closeJackpotEntry().accountsPartial({ round: PDA.jackpot(id), playerState: PDA.player(e.player), entry: PDA.jpEntry(id, 0), rentPayer: e.rentPayer }).transaction());
  else skip('close_jackpot_entry', 'refunded round has no entry left');
} else skip('close_jackpot_entry', 'no refunded jackpot round with entries');
const dr = Number(cfg.drawRound);
const dround = await A.drawRound.fetchNullable(PDA.draw(dr));
if (dround && dround.state === 0 && Number(dround.endTs) > 0 && now >= Number(dround.endTs)) await sim('draw_draw', ARCHITECT, (p) => p.methods.drawDraw().accountsPartial({ config: PDA.config(), round: PDA.draw(dr) }).transaction());
else skip('draw_draw', 'no ended, undrawn lottery round');
skip('settle_draw', 'no lottery round in the drawing state');

const bet = bets[0];
if (bet) await sim('settle_bet', ARCHITECT, (p) => p.methods.settleBet().accountsPartial({ config: PDA.config(), bet: bet.publicKey, playerState: bet.account.playerState, bankrollVault: PDA.bankrollVault(), slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: bet.account.rentPayer }).transaction(), 'an open bet exists');
else skip('settle_bet', 'no open Bet account on mainnet');

const openDuel = duels.find((d) => d.account.state === 0);
if (openDuel) {
  await sim('cancel_duel', openDuel.account.creator, (p) => p.methods.cancelDuel().accountsPartial({ duel: openDuel.publicKey, creatorState: PDA.player(openDuel.account.creator), creator: openDuel.account.creator }).transaction());
  const joiner = artifacts.find((a) => !a.owner.equals(openDuel.account.creator) && ownerWithPlayer(a.owner) && Number(ownerWithPlayer(a.owner).account.balance) >= Number(openDuel.account.stake));
  if (joiner) await sim('join_duel', joiner.owner, (p) => p.methods.joinDuel(0).accountsPartial({ config: PDA.config(), duel: openDuel.publicKey, opponentState: PDA.player(joiner.owner), opponent: joiner.owner, asset: joiner.asset, record: PDA.artifact(joiner.asset), collection: PDA.collection() }).transaction());
  else skip('join_duel', 'no artifact owner can cover the open duel stake');
} else skip('cancel_duel / join_duel', 'no open duel');
const joinedDuel = duels.find((d) => d.account.state === 1);
if (joinedDuel && now >= Number(joinedDuel.account.deadline)) await sim('claim_duel_timeout', ARCHITECT, (p) => p.methods.claimDuelTimeout().accountsPartial({ config: PDA.config(), duel: joinedDuel.publicKey, creatorState: PDA.player(joinedDuel.account.creator), opponentState: PDA.player(joinedDuel.account.opponent), rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: ARCHITECT, rentPayer: joinedDuel.account.rentPayer }).transaction());
else skip('claim_duel_timeout', 'no joined duel past its deadline');
skip('reveal_duel', 'needs the creator secret (browser localStorage)');

const openWar = wars.find((w) => w.account.state === 0);
if (openWar) await sim('cancel_war', openWar.account.creator, (p) => p.methods.cancelWar().accountsPartial({ war: openWar.publicKey, creatorState: PDA.player(openWar.account.creator), creator: openWar.account.creator }).transaction());
else skip('cancel_war', 'no open war');
const startingWar = wars.find((w) => w.account.state === 1);
if (startingWar) await sim('start_war', ARCHITECT, (p) => p.methods.startWar().accountsPartial({ war: startingWar.publicKey, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }).transaction());
else skip('start_war', 'no war in the starting state');
const activeWar = wars.find((w) => w.account.state === 2);
if (activeWar) {
  const turnKey = activeWar.account.keys[activeWar.account.turn];
  await sim('war_end_turn', turnKey, (p) => p.methods.warEndTurn().accountsPartial({ war: activeWar.publicKey, signer: turnKey }).transaction(), 'move key as signer');
  await sim('war_summon', turnKey, (p) => p.methods.warSummon(0).accountsPartial({ war: activeWar.publicKey, signer: turnKey }).transaction(), 'move key as signer');
  await sim('war_attack', turnKey, (p) => p.methods.warAttack(0, 255).accountsPartial({ war: activeWar.publicKey, signer: turnKey }).transaction(), 'move key as signer');
  if (now >= Number(activeWar.account.deadline)) await sim('claim_war_timeout', ARCHITECT, (p) => p.methods.claimWarTimeout().accountsPartial({ war: activeWar.publicKey }).transaction());
  else skip('claim_war_timeout', 'active war not past its deadline');
} else skip('war_summon / war_attack / war_end_turn / claim_war_timeout', 'no active war');
const doneWar = wars.find((w) => w.account.state === 3);
if (doneWar) await sim('settle_war', ARCHITECT, (p) => p.methods.settleWar().accountsPartial({ config: PDA.config(), war: doneWar.publicKey, creatorState: PDA.player(doneWar.account.creator), opponentState: PDA.player(doneWar.account.opponent), rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: ARCHITECT, rentPayer: doneWar.account.rentPayer }).transaction());
else skip('settle_war', 'no finished, unsettled war');
skip('create_war / join_war', 'real Moon Wars creation is PAUSED on the site (owner decision)');
skip('enter_prediction', 'Predictions are off the site (owner decision)');

const pe = predEntries[0];
if (pe) {
  const id = Number(pe.account.round);
  const pr = await A.predRound.fetchNullable(PDA.pred(id));
  if (pr && (pr.state === 2 || pr.state === 3)) await sim('claim_prediction', ARCHITECT, (p) => p.methods.claimPrediction().accountsPartial({ config: PDA.config(), round: PDA.pred(id), entry: pe.publicKey, playerState: PDA.player(pe.account.player), rentPayer: pe.account.rentPayer }).transaction());
  else skip('claim_prediction', 'the entry\'s round is not settled/refunded');
} else skip('claim_prediction', 'no PredEntry account on mainnet');
const lockable = preds.find((r) => r.account.state === 0 && now >= Number(r.account.lockTs));
if (lockable) await sim('lock_prediction', ARCHITECT, (p) => p.methods.lockPrediction().accountsPartial({ round: lockable.publicKey, observation: new PublicKey('4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ') }).transaction());
else skip('lock_prediction', 'no open round past its lock time');
const settleable = preds.find((r) => r.account.state === 1 && now >= Number(r.account.endTs));
if (settleable) await sim('settle_prediction', ARCHITECT, (p) => p.methods.settlePrediction().accountsPartial({ config: PDA.config(), round: settleable.publicKey, observation: new PublicKey('4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ'), rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: ARCHITECT }).transaction());
else skip('settle_prediction', 'no locked round past its end time');
skip('claim_drop / claim_drop_xnt', 'needs a drawn, won, unclaimed Forge Drop leaf (none found by the simple scan; v2 oracle seals drops)');

// ── chained simulations: several instructions in ONE transaction so later ones see the state the earlier
// ones create (a fresh PlayerState, a freshly forged Artifact...). Per-instruction units come from the
// "Program <id> consumed N of M compute units" log line of each top-level invocation. Fake signers are
// funded mainnet system accounts (sigVerify=false): nothing is signed or sent.
const RICH = new PublicKey('68RkV6ZnNqhaF8orcJYUir1AvgvVUbQjss7ZeeAb8bTU'); // validator identity, ~216 XNT, read-only stand-in
const RICH2 = new PublicKey('AWXswqfkraF6WPb33WqWLyhPAUgmbbWhifpdSuibivpT'); // ~36 XNT
function perIxUnits(logs) {
  const out = []; const stack = []; let top = -1;
  for (const l of logs || []) {
    let m;
    if ((m = /^Program (\S+) invoke \[(\d+)\]/.exec(l))) { stack.push(m[1]); if (m[2] === '1') { top++; out[top] = { program: m[1], units: null }; } continue; }
    if ((m = /^Program (\S+) consumed (\d+) of \d+ compute units/.exec(l))) { if (stack.length === 1) out[top].units = Number(m[2]); continue; }
    if (/^Program \S+ (success|failed)/.test(l)) stack.pop();
  }
  return out;
}
async function simChain(label, feePayer, names, build, note = '') {
  try {
    const program = programFor(feePayer);
    const ixs = await build(program);
    const tx = new Transaction().add(...ixs);
    tx.feePayer = feePayer;
    const r = await connection.simulateTransaction(tx);
    const v = r.value;
    if (v.err) {
      const errLine = (v.logs || []).filter((l) => /Error|failed/i.test(l)).slice(-1)[0] || '';
      console.log(`FAIL chain ${label}: ${JSON.stringify(v.err).slice(0, 100)} ${errLine.slice(0, 140)}`);
      for (const n of names) if (n) rows.push({ name: n, ok: false, units: null, err: `chain ${label} failed: ${JSON.stringify(v.err).slice(0, 80)}`, detail: errLine.slice(0, 120), note });
      return false;
    }
    const per = perIxUnits(v.logs);
    names.forEach((n, i) => { if (!n) return; const u = per[i]?.units ?? null; rows.push({ name: n, ok: u != null, units: u, err: u == null ? 'no consumed line' : '', detail: '', note: `${note}${note ? '; ' : ''}chain ${label} ix#${i}` }); console.log(`${u == null ? 'FAIL' : ' ok '} ${n.padEnd(24)} ${String(u ?? '-').padStart(8)}  (chain ${label})`); });
    return true;
  } catch (e) { console.log(`SKIP chain ${label}: ${String(e.message || e).slice(0, 160)}`); for (const n of names) if (n) rows.push({ name: n, ok: false, units: null, err: `chain ${label}: ${String(e.message || e).slice(0, 100)}`, detail: '', note }); return false; }
}
const ixOpen = (p, o) => p.methods.openPlayer().accountsPartial({ playerState: PDA.player(o), owner: o, systemProgram: SYS }).instruction();
const ixDeposit = (p, o, xnt) => p.methods.deposit(bn(xnt * XNT)).accountsPartial({ playerState: PDA.player(o), payer: o, systemProgram: SYS }).instruction();
const forgeAccs = (t, serial, buyer) => { const asset = PDA.asset(t, serial); return { config: PDA.config(), asset, record: PDA.artifact(asset), collection: PDA.collection(), artifactAuthority: PDA.artifactAuthority(), rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: ARCHITECT, buyer, coreProgram: MPL_CORE, systemProgram: SYS }; };
const ixForge = (p, t, serial, buyer, maxXnt) => p.methods.forgeArtifact(t, serial, bn(Math.floor(maxXnt * XNT))).accountsPartial(forgeAccs(t, serial, buyer)).instruction();
const richHasPlayer = !!ownerWithPlayer(RICH);
const s0 = cfg.artifactsMinted[0];
const a0 = PDA.asset(0, s0);
const ps = PDA.player(RICH);
const seed = Array.from(crypto.getRandomValues(new Uint8Array(32)));
const betAccs = (n) => ({ config: PDA.config(), playerState: ps, bet: PDA.bet(ps, n), bankrollVault: PDA.bankrollVault(), rewardVault: PDA.rewardVault(), architect: ARCHITECT, signer: RICH, systemProgram: SYS });
const nonce0 = richHasPlayer ? BigInt(ownerWithPlayer(RICH).account.nonce.toString()) : 0n;
const pre = (p) => (richHasPlayer ? [] : [ixOpen(p, RICH)]);
const preNames = richHasPlayer ? [] : [null];
console.log('\n── chains (fake signer', RICH.toBase58().slice(0, 6), richHasPlayer ? 'has a PlayerState' : 'has no PlayerState', ')');
await simChain('wallet', RICH, [...preNames, 'deposit', 'withdraw', 'set_session'], async (p) => [...(await Promise.all(pre(p))),
  await ixDeposit(p, RICH, 1), await p.methods.withdraw(bn(0.5 * XNT)).accountsPartial({ playerState: ps, owner: RICH }).instruction(),
  await p.methods.setSession(Keypair.generate().publicKey, bn(now + 3600), bn(0.1 * XNT)).accountsPartial({ playerState: ps, owner: RICH }).instruction()]);
for (const [g, name, param] of [[0, 'place_bet:coinflip', 0], [1, 'place_bet:highlow', 5000], [2, 'place_bet:voidrush', 20_000]]) {
  await simChain(name, RICH, [...preNames, null, name], async (p) => [...(await Promise.all(pre(p))), await ixDeposit(p, RICH, 1),
    await p.methods.placeBet(g, bn(param), 0, bn(0.01 * XNT), seed).accountsPartial(betAccs(nonce0)).instruction()], 'stake 0.01 XNT');
}
{
  const jr = Number(cfg.jackpotRound); const jround = await A.jackpotRound.fetchNullable(PDA.jackpot(jr)); const jidx = jround ? jround.entries : 0;
  await simChain('jackpot', RICH, [...preNames, null, 'enter_jackpot'], async (p) => [...(await Promise.all(pre(p))), await ixDeposit(p, RICH, 1),
    await p.methods.enterJackpot(bn(jr), jidx, bn(0.1 * XNT)).accountsPartial({ config: PDA.config(), round: PDA.jackpot(jr), entry: PDA.jpEntry(jr, jidx), playerState: ps, signer: RICH, systemProgram: SYS }).instruction()], jround ? `round ${jr} entry #${jidx}` : `opens round ${jr}`);
}
await simChain('forge0', RICH, ['forge_artifact:t0', 'recycle_artifact'], async (p) => [await ixForge(p, 0, s0, RICH, 10),
  await p.methods.recycleArtifact().accountsPartial({ config: PDA.config(), asset: a0, record: PDA.artifact(a0), collection: PDA.collection(), owner: RICH, coreProgram: MPL_CORE, systemProgram: SYS }).instruction()], `Lunar Dust serial ${s0}`);
for (const t of [1, 2, 3]) {
  const s = cfg.artifactsMinted[t]; const price = Math.max([10, 25, 60, 200][t], Number(cfg.artifactPrice[t]) / XNT) * 1.06;
  await simChain(`forge${t}`, RICH, [`forge_artifact:t${t}`], async (p) => [await ixForge(p, t, s, RICH, price)], `serial ${s}, max ${price.toFixed(2)} XNT`);
}
{
  const dr = Number(cfg.drawRound); const dround = await A.drawRound.fetchNullable(PDA.draw(dr)); const didx = dround ? dround.entries : 0;
  await simChain('chips+draw', RICH, [...preNames, null, 'claim_artifact_chips', 'enter_draw'], async (p) => [...(await Promise.all(pre(p))), await ixForge(p, 0, s0, RICH, 10),
    await p.methods.claimArtifactChips().accountsPartial({ config: PDA.config(), asset: a0, record: PDA.artifact(a0), collection: PDA.collection(), playerState: ps, owner: RICH }).instruction(),
    await p.methods.enterDraw(bn(dr), didx, bn(1), bn(0)).accountsPartial({ config: PDA.config(), round: PDA.draw(dr), entry: PDA.drawEntry(dr, didx), playerState: ps, rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: ARCHITECT, signer: RICH, systemProgram: SYS }).instruction()], '1 chip, 0 tickets');
}
{
  const duel = PDA.duel(RICH, nonce0);
  const salt = crypto.getRandomValues(new Uint8Array(32)); const element = 1;
  const { keccak_256 } = require('@noble/hashes/sha3');
  const h = keccak_256.create(); h.update(enc('MOONFORGE_DUEL')); h.update(Uint8Array.of(element)); h.update(salt); h.update(duel.toBytes());
  const commitment = Array.from(h.digest());
  const duelAccs = { config: PDA.config(), creatorState: ps, duel, owner: RICH, asset: a0, record: PDA.artifact(a0), collection: PDA.collection(), systemProgram: SYS };
  await simChain('duel-cancel', RICH, [...preNames, null, null, 'create_duel', 'cancel_duel'], async (p) => [...(await Promise.all(pre(p))), await ixDeposit(p, RICH, 1), await ixForge(p, 0, s0, RICH, 10),
    await p.methods.createDuel(bn(0.1 * XNT), commitment).accountsPartial(duelAccs).instruction(),
    await p.methods.cancelDuel().accountsPartial({ duel, creatorState: ps, creator: RICH }).instruction()], 'stake 0.1 XNT');
  const ps2 = PDA.player(RICH2); const a1 = PDA.asset(0, s0 + 1);
  const rich2HasPlayer = !!ownerWithPlayer(RICH2);
  const pre2 = (p) => (rich2HasPlayer ? [] : [ixOpen(p, RICH2)]);
  const pre2Names = rich2HasPlayer ? [] : [null];
  const resolve = { config: PDA.config(), duel, creatorState: ps, opponentState: ps2, rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: ARCHITECT, rentPayer: RICH };
  await simChain('duel-join-reveal', RICH, [...preNames, null, null, null, ...pre2Names, null, null, 'join_duel', 'reveal_duel'], async (p) => [...(await Promise.all(pre(p))), await ixDeposit(p, RICH, 1), await ixForge(p, 0, s0, RICH, 10),
    await p.methods.createDuel(bn(0.1 * XNT), commitment).accountsPartial(duelAccs).instruction(),
    ...(await Promise.all(pre2(p))), await ixDeposit(p, RICH2, 1), await ixForge(p, 0, s0 + 1, RICH2, 10),
    await p.methods.joinDuel(2).accountsPartial({ config: PDA.config(), duel, opponentState: ps2, opponent: RICH2, asset: a1, record: PDA.artifact(a1), collection: PDA.collection() }).instruction(),
    await p.methods.revealDuel(element, Array.from(salt)).accountsPartial({ resolve, creator: RICH }).instruction()], 'two fake signers');
}
for (const amt of [1, 5]) {
  const ok = await simChain(`house${amt}`, RICH, ['house_deposit', 'house_request_withdraw'], async (p) => [
    await p.methods.houseDeposit(bn(amt * XNT), bn(0)).accountsPartial({ config: PDA.config(), share: PDA.house(RICH), bankrollVault: PDA.bankrollVault(), owner: RICH, systemProgram: SYS }).instruction(),
    await p.methods.houseRequestWithdraw(bn(1)).accountsPartial({ share: PDA.house(RICH), owner: RICH }).instruction()], `${amt} XNT`);
  if (ok) break;
}
// keep only the best (successful) row per instruction name
{
  const best = new Map();
  for (const r of rows) { const cur = best.get(r.name); if (!cur || (!cur.ok && r.ok) || (cur.ok && r.ok && r.units > cur.units)) best.set(r.name, r); }
  rows.length = 0; rows.push(...best.values());
}

// ── output ────────────────────────────────────────────────────────────────
// The binary measured: its ProgramData last-deploy slot goes next to the table (src/lib/cu.ts CU_MEASURED_DEPLOY_SLOT),
// because an in-place upgrade keeps the program id. The site applies the table only while the live slot is this one.
let programDataSlot = null;
try {
  const prog = await connection.getAccountInfo(PROGRAM_ID);
  const pdInfo = await connection.getAccountInfo(new PublicKey(prog.data.subarray(4, 36)), { dataSlice: { offset: 0, length: 12 } });
  programDataSlot = Number(Buffer.from(pdInfo.data).readBigUInt64LE(4));
} catch (e) { console.error('could not read the ProgramData last-deploy slot:', e.message); }
const margin = (u) => Math.ceil(u * 1.25) + 300;
const measured = rows.filter((r) => r.ok && r.units != null);
const md = [
  `# CU measurements — Moon Forge program ${PROGRAM_ID.toBase58()} (rules v2 binary)`,
  '',
  `Binary: ProgramData last-deploy slot ${programDataSlot ?? 'unknown'}. The site applies this table only while the live program has that slot (src/lib/cu.ts CU_MEASURED_DEPLOY_SLOT).`,
  '',
  `Method: \`connection.simulateTransaction(tx)\` on ${RPC} at ${new Date().toISOString()}, read-only (no key, no signature; sigVerify=false; real on-chain accounts stand in as signers). ` +
  'Limit = ceil(units × 1.25) + 300 (two ComputeBudget builtin instructions at 150 CU each: ours plus one a wallet may inject). Each number is for ONE transaction of ONE instruction, as the site sends them. ' +
  'The site re-measures every transaction with the same call before signing and uses this table ONLY when that simulation fails; rows marked SKIP get no static limit (default runtime budget).',
  '',
  '| instruction | units (simulated) | static limit | note |', '|---|---:|---:|---|',
  ...rows.map((r) => `| ${r.name} | ${r.ok && r.units != null ? r.units : 'SKIP'} | ${r.ok && r.units != null ? margin(r.units) : '-'} | ${r.ok ? r.note : `${r.err} ${r.detail}`.trim()} |`),
  '',
  `Measured: ${measured.length} / ${rows.length}. Regenerate after every program upgrade: \`node measure-cu.mjs\` (this file).`,
].join('\n');
writeFileSync(join(here, 'CU-MEASUREMENTS.md'), md);
writeFileSync(join(here, 'cu-measurements.json'), JSON.stringify({ rpc: RPC, at: new Date().toISOString(), programId: PROGRAM_ID.toBase58(), programDataSlot, rows }, null, 2));
console.log(`\nwritten: ${measured.length}/${rows.length} measured → CU-MEASUREMENTS.md`);
