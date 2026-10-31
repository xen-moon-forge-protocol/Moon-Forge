// Driver of tests/run-upgrade-tooling.sh: the upgrade-day tools (scripts/upgrade/*.mjs) rehearsed on a local
// validator that runs the OLD binary first, as tests/run-upgrade.sh does. Commands:
//   setup <rpc> <deploy-wallet.json>   on the OLD binary with the OLD IDL (tests/fixtures/idl-onchain-v2.json): Config,
//                                      the Core collection, a pool donation, an LP with a withdrawal request, a player
//                                      with a forged Lunar Dust, an OPEN war, a pending legacy bet, an OPEN Jackpot
//                                      round, a published epoch: the in-flight accounts the S5 census must list
//   snapshot <rpc> <out.json>          every program account + ProgramData + the IDL account + the Core collection,
//                                      as {lamports, owner, sha256(data)}: what a dry run must leave untouched
//   same <a.json> <b.json>             exit 0 when two snapshots are identical, else prints the differences
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, 'package.json'));
const anchor = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');
const { keccak_256 } = require('@noble/hashes/sha3');

const PROGRAM = new PublicKey('57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9');
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const SYS = SystemProgram.programId;
const XNT = 1_000_000_000;
const BN = (v) => new anchor.BN(v.toString());
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pda = (...s) => PublicKey.findProgramAddressSync(s.map((x) => (typeof x === 'string' ? Buffer.from(x) : x instanceof PublicKey ? x.toBuffer() : x)), PROGRAM)[0];
const kp = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, 'utf8'))));
const keccak = (...p) => { const h = keccak_256.create(); p.forEach((x) => h.update(x)); return Buffer.from(h.digest()); };
const hashPair = (a, b) => (Buffer.compare(a, b) <= 0 ? keccak(a, b) : keccak(b, a));
const claimLeaf = (e, p, t, s) => keccak(Buffer.from('MOONFORGE_V2_CLAIM'), u64(e), p.toBuffer(), Buffer.from([t]), u64(s));
const P = {
  config: pda('config'), reward: pda('reward_vault'), bankroll: pda('bankroll_vault'), draw: pda('draw_vault'), collection: pda('collection'),
  authority: pda('artifact_authority'), epoch: (n) => pda('epoch', u64(n)), player: (o) => pda('player', o), bet: (ps, n) => pda('bet', ps, u64(n)),
  house: (o) => pda('house', o), jackpot: (r) => pda('jackpot', u64(r)), jpEntry: (r, i) => pda('jp_entry', u64(r), u32(i)),
  war: (c, n) => pda('war', c, u64(n)), asset: (t, s) => pda('asset', Buffer.from([t]), u32(s)), artifact: (a) => pda('artifact', a),
};
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'setup') {
  const [rpc, deployWalletFile] = args;
  const conn = new Connection(rpc, 'confirmed');
  const OLD_IDL = JSON.parse(fs.readFileSync(path.join(here, 'fixtures/idl-onchain-v2.json'), 'utf8'));
  const prov = (s) => new anchor.AnchorProvider(conn, new anchor.Wallet(s), { commitment: 'confirmed', preflightCommitment: 'confirmed' });
  const OLD = (s) => new anchor.Program(OLD_IDL, prov(s));
  const fund = async (k, x) => conn.confirmTransaction(await conn.requestAirdrop(k, x * XNT), 'confirmed');
  const oracle = kp(path.join(here, 'fixtures/test-oracle.json'));
  const architect = kp(deployWalletFile); // the localnet ARCHITECT = the deploy wallet's twin (Config.architect + both authorities)
  const payer = Keypair.generate(), lp = Keypair.generate(), alice = Keypair.generate();
  await fund(payer.publicKey, 500); await fund(lp.publicKey, 200); await fund(alice.publicKey, 100); await fund(oracle.publicKey, 10);
  const A = OLD(payer);
  await A.methods.initializeV2().accountsPartial({ config: P.config, rewardVault: P.reward, bankrollVault: P.bankroll, drawVault: P.draw, collection: P.collection, artifactAuthority: P.authority, payer: payer.publicKey, systemProgram: SYS }).rpc();
  await A.methods.initArtifacts().accountsPartial({ config: P.config, collection: P.collection, artifactAuthority: P.authority, payer: payer.publicKey, coreProgram: CORE, systemProgram: SYS }).rpc();
  const cfg = await A.account.config.fetch(P.config);
  if (!cfg.architect.equals(architect.publicKey)) throw new Error(`Config.architect ${cfg.architect.toBase58()} is not the deploy wallet ${architect.publicKey.toBase58()}`);
  await A.methods.donate(0, BN(50 * XNT)).accountsPartial({ config: P.config, donor: payer.publicKey, vault: P.reward }).rpc();
  // an LP with a withdrawal request (HouseShare in flight)
  await OLD(lp).methods.houseDeposit(BN(100 * XNT), BN(0)).accountsPartial({ config: P.config, share: P.house(lp.publicKey), bankrollVault: P.bankroll, owner: lp.publicKey, systemProgram: SYS }).rpc();
  const sh = await A.account.houseShare.fetch(P.house(lp.publicKey));
  await OLD(lp).methods.houseRequestWithdraw(BN(BigInt(sh.shares.toString()) / 4n)).accountsPartial({ share: P.house(lp.publicKey), owner: lp.publicKey }).rpc();
  // a player with game balance and a forged Lunar Dust (old 50/40/5/5 split)
  await OLD(alice).methods.openPlayer().accountsPartial({ playerState: P.player(alice.publicKey), owner: alice.publicKey, systemProgram: SYS }).rpc();
  await OLD(alice).methods.deposit(BN(20 * XNT)).accountsPartial({ playerState: P.player(alice.publicKey), payer: alice.publicKey, systemProgram: SYS }).rpc();
  const serial = (await A.account.config.fetch(P.config)).artifactsMinted[0];
  const asset = P.asset(0, serial);
  await OLD(alice).methods.forgeArtifact(0, serial, BN('18446744073709551615')).accountsPartial({
    config: P.config, asset, record: P.artifact(asset), collection: P.collection, artifactAuthority: P.authority, rewardVault: P.reward,
    drawVault: P.draw, architect: architect.publicKey, buyer: alice.publicKey, coreProgram: CORE, systemProgram: SYS,
  }).rpc();
  const nonceOf = async () => Number((await A.account.playerState.fetch(P.player(alice.publicKey))).nonce);
  // an OPEN war (legacy create_war)
  const war = P.war(alice.publicKey, await nonceOf());
  await OLD(alice).methods.createWar(BN(0.2 * XNT), PublicKey.default).accountsPartial({ config: P.config, creatorState: P.player(alice.publicKey), war, owner: alice.publicKey, asset, record: P.artifact(asset), collection: P.collection, systemProgram: SYS }).rpc();
  // a pending legacy house bet (never settled here: the census lists it)
  const ps = P.player(alice.publicKey);
  const bet = P.bet(ps, await nonceOf());
  await OLD(alice).methods.placeBet(0, BN(0), 1, BN(0.1 * XNT), Array(32).fill(7)).accountsPartial({ config: P.config, playerState: ps, bet, bankrollVault: P.bankroll, rewardVault: P.reward, architect: architect.publicKey, signer: alice.publicKey, systemProgram: SYS }).rpc();
  // an OPEN Jackpot round with one entry
  const jr = Number((await A.account.config.fetch(P.config)).jackpotRound);
  await OLD(alice).methods.enterJackpot(BN(jr), 0, BN(XNT)).accountsPartial({ config: P.config, round: P.jackpot(jr), entry: P.jpEntry(jr, 0), playerState: ps, signer: alice.publicKey, systemProgram: SYS }).rpc();
  // a published epoch (old 108-B publish_epoch), 2 leaves
  const leaves = [claimLeaf(1, alice.publicKey, 0, 600n), claimLeaf(1, lp.publicKey, 0, 400n)];
  const root = hashPair(leaves[0], leaves[1]);
  await OLD(oracle).methods.publishEpoch(BN(1), Array.from(root), Array.from(Buffer.alloc(32, 1)), BN(1000), 2, BN(1_000_000_000_000_000n)).accountsPartial({ config: P.config, epoch: P.epoch(1), rewardVault: P.reward, oracle: oracle.publicKey, systemProgram: SYS }).rpc();
  const e1 = await A.account.epoch.fetch(P.epoch(1));
  console.log(`setup on the old binary: Config (architect ${cfg.architect.toBase58()}, oracle ${cfg.oracle.toBase58()}), pool +50 XNT, LP request, Lunar Dust #${serial} forged, OPEN war, pending legacy bet ${bet.toBase58()}, Jackpot round ${jr} OPEN, epoch 1 published (budget ${Number(e1.budget) / XNT} XNT)`);
} else if (cmd === 'snapshot') {
  const [rpc, out] = args;
  const conn = new Connection(rpc, 'confirmed');
  const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], LOADER)[0];
  const idl = await PublicKey.createWithSeed(PublicKey.findProgramAddressSync([], PROGRAM)[0], 'anchor:idl', PROGRAM);
  const slot = await conn.getSlot('confirmed');
  const accs = await conn.getProgramAccounts(PROGRAM, { commitment: 'confirmed' });
  const extra = await conn.getMultipleAccountsInfo([programData, idl, P.collection, PROGRAM], 'confirmed');
  const snap = {};
  const put = (k, a) => { snap[k] = a ? { lamports: a.lamports, owner: a.owner.toBase58(), len: a.data.length, sha256: crypto.createHash('sha256').update(a.data).digest('hex') } : null; };
  for (const a of accs) put(a.pubkey.toBase58(), a.account);
  [programData, idl, P.collection, PROGRAM].forEach((k, i) => put(k.toBase58(), extra[i]));
  fs.writeFileSync(out, JSON.stringify({ slot, accounts: snap }, null, 1));
  console.log(`snapshot at slot ${slot}: ${Object.keys(snap).length} accounts -> ${out}`);
} else if (cmd === 'same') {
  const [a, b] = args.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).accounts);
  const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null));
  if (diff.length) { console.log(`snapshots differ in ${diff.length} account(s): ${diff.join(' ')}`); process.exit(1); }
  console.log(`snapshots identical (${Object.keys(a).length} accounts: lamports, owner, data)`);
} else {
  console.error('usage: setup <rpc> <deploy-wallet.json> | snapshot <rpc> <out.json> | same <a.json> <b.json>');
  process.exit(2);
}
