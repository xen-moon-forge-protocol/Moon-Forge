// Driver of tests/mainnet-fork.sh (SPEC-UPGRADE-v2 8.6). Commands:
//   guard <so>                 refuse a --features localnet binary (the localnet oracle key is compiled in)
//   census <mainnetRpc> <dir>  READ-ONLY: every account of the live program + the Core collection -> <dir>/accounts
//   before <localRpc> <dir> <payer.json>  the cloned state answers on the LIVE binary
//   after <localRpc> <dir> <payer.json>  after the in-place upgrade: byte-compare, 6.3 step-1 simulations, expire/void
//                              on the newest epoch, S7 first-run steps, census of the new PDAs
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, 'package.json'));
const anchor = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');

const PROGRAM = new PublicKey('57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9');
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const MAINNET_ORACLE = new PublicKey('J5CU45Didfq7ng9JHXyxYqN7TwAGjMgEyhUcrV7Aixba');
const LOCALNET_ORACLE = new PublicKey('7umMRWhHfzE6HUgY1xbf55z2FWgdwWeupxxJH1hNj1g9');
const NEW_IDL = JSON.parse(fs.readFileSync(path.join(here, '../target/idl/moon_forge.json'), 'utf8'));
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === 'string' ? Buffer.from(s) : s instanceof PublicKey ? s.toBuffer() : s)), PROGRAM)[0];
const le64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const [cmd, ...args] = process.argv.slice(2);
let failures = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL ${m}`); };
const kp = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, 'utf8'))));

async function simulate(conn, ix, payer) {
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
  const logs = r.value.logs || [];
  const code = logs.map((l) => l.match(/Error Code: (\w+)/)).find(Boolean)?.[1] ?? (r.value.err ? JSON.stringify(r.value.err) : 'ok');
  return { err: r.value.err, code, logs };
}
const expectSim = async (conn, what, ix, payer, want) => {
  const r = await simulate(conn, ix, payer);
  const pass = Array.isArray(want) ? want.includes(r.code) : r.code === want;
  (pass ? ok : bad)(`${what}: ${r.code}${pass ? '' : ` (want ${want})\n${r.logs.slice(-6).join('\n')}`}`);
  return r;
};

// SBF materialises a Pubkey constant as four lddw immediates: each 8-byte chunk appears split as lo4 ‖ 00000000 ‖ hi4
const keyChunks = (so, key) => [0, 1, 2, 3].filter((i) => { const c = key.toBuffer().subarray(8 * i, 8 * i + 8); return so.includes(Buffer.concat([c.subarray(0, 4), Buffer.alloc(4), c.subarray(4)])) || so.includes(c); }).length;
if (cmd === 'guard') {
  const so = fs.readFileSync(args[0]);
  if (keyChunks(so, LOCALNET_ORACLE) > 0) { console.error(`${args[0]} carries the localnet oracle key (a --features localnet build): refused`); process.exit(1); }
  if (keyChunks(so, MAINNET_ORACLE) < 4) { console.error(`${args[0]} does not carry the mainnet oracle key: refused`); process.exit(1); }
  console.log(`${args[0]}: mainnet constants (${so.length} B)`);
} else if (cmd === 'census') {
  const [rpc, dir] = args;
  const conn = new Connection(rpc, 'finalized');
  const accs = await conn.getProgramAccounts(PROGRAM, { encoding: 'base64' });
  // + the Core collection and the wallets the simulations sign as (PlayerState owners, config.architect, config.oracle)
  const cfgAcc = accs.find((a) => Buffer.from(a.account.data).subarray(0, 8).toString('hex') === '9b0caae01efacc82');
  const extra = [pda('collection')];
  if (cfgAcc) extra.push(new PublicKey(Buffer.from(cfgAcc.account.data).subarray(74, 106)), new PublicKey(Buffer.from(cfgAcc.account.data).subarray(10, 42)));
  for (const a of accs) if (Buffer.from(a.account.data).subarray(0, 8).toString('hex') === '38033c56ae10f4c3') extra.push(new PublicKey(Buffer.from(a.account.data).subarray(8, 40)));
  const list = accs.map((a) => ({ pubkey: a.pubkey, account: a.account }));
  for (const k of extra) { const a = await conn.getAccountInfo(k); if (a) list.push({ pubkey: k, account: a }); }
  const census = {};
  for (const { pubkey, account } of list) {
    const file = { pubkey: pubkey.toBase58(), account: { lamports: account.lamports, data: [Buffer.from(account.data).toString('base64'), 'base64'], owner: account.owner.toBase58(), executable: account.executable, rentEpoch: 0, space: account.data.length } };
    fs.writeFileSync(path.join(dir, 'accounts', `${pubkey.toBase58()}.json`), JSON.stringify(file));
    census[pubkey.toBase58()] = { owner: account.owner.toBase58(), len: account.data.length, lamports: account.lamports, disc: Buffer.from(account.data).subarray(0, 8).toString('hex') };
  }
  fs.writeFileSync(path.join(dir, 'census.json'), JSON.stringify({ slot: await conn.getSlot(), census }, null, 1));
  console.log(`census: ${list.length} accounts (${accs.length} program-owned) cloned read-only from ${rpc}`);
} else if (cmd === 'before' || cmd === 'after') {
  const [rpc, dir, payerFile] = args;
  const conn = new Connection(rpc, 'confirmed');
  const { census } = JSON.parse(fs.readFileSync(path.join(dir, 'census.json'), 'utf8'));
  const snap = (k) => JSON.parse(fs.readFileSync(path.join(dir, 'accounts', `${k}.json`), 'utf8')).account;
  // every cloned account is byte-identical (lamports, owner, data) to the mainnet snapshot
  const compare = async (label) => {
    let same = 0;
    for (const k of Object.keys(census)) {
      const a = await conn.getAccountInfo(new PublicKey(k));
      const s = snap(k);
      if (a && a.lamports === s.lamports && a.owner.toBase58() === s.owner && Buffer.from(a.data).equals(Buffer.from(s.data[0], 'base64'))) same++;
      else bad(`${label}: ${k} changed`);
    }
    ok(`${label}: ${same}/${Object.keys(census).length} cloned accounts byte-identical to mainnet`);
  };
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(payerFile ? kp(payerFile) : Keypair.generate()), { commitment: 'confirmed' });
  const program = new anchor.Program(NEW_IDL, provider);
  const config = pda('config');
  const cfg = await conn.getAccountInfo(config);
  const architect = new PublicKey(cfg.data.subarray(74, 106));
  const lastEpoch = Number(cfg.data.readBigUInt64LE(111));
  const epoch = pda('epoch', le64(lastEpoch));
  const player = Object.entries(census).find(([, v]) => v.disc === '38033c56ae10f4c3');
  const owner = player ? new PublicKey((await conn.getAccountInfo(new PublicKey(player[0]))).data.subarray(8, 40)) : architect;
  await compare(cmd === 'before' ? 'before the upgrade' : 'after the upgrade');
  if (cmd === 'before') {
    // the live binary has no init_seat: Anchor's InstructionFallbackNotFound (custom 101) = programRules 2
    const ix = await program.methods.initSeat().accounts({ payer: provider.wallet.publicKey }).instruction();
    await expectSim(conn, 'init_seat on the live binary (rules 2)', ix, provider.wallet.publicKey, ['InstructionFallbackNotFound', '{"InstructionError":[0,{"Custom":101}]}']);
    process.exit(failures ? 1 : 0);
  }
  const payer = provider.wallet.publicKey;
  // 6.3 step 1 / 8.6
  await expectSim(conn, 'init_seat simulated (not 101)', await program.methods.initSeat().accounts({ payer }).instruction(), payer, 'ok');
  const ps = pda('player', owner);
  const psInfo = await conn.getAccountInfo(ps);
  if (psInfo) {
    const nonce = psInfo.data.readBigUInt64LE(104);
    await expectSim(conn, 'create_war (retired)', await program.methods.createWar(new anchor.BN(1_000_000), PublicKey.default).accountsPartial({
      config, creatorState: ps, war: pda('war', owner, le64(nonce)), owner, asset: SystemProgram.programId, record: SystemProgram.programId, collection: SystemProgram.programId, systemProgram: SystemProgram.programId,
    }).instruction(), owner, 'SealedJoinRequired');
    await expectSim(conn, 'place_bet (retired)', await program.methods.placeBet(0, new anchor.BN(0), 0, new anchor.BN(1_000_000), Array(32).fill(1)).accountsPartial({
      config, playerState: ps, bet: pda('bet', ps, le64(nonce)), bankrollVault: pda('bankroll_vault'), rewardVault: pda('reward_vault'), architect, signer: owner, systemProgram: SystemProgram.programId,
    }).instruction(), owner, 'KeeperRequired');
  } else bad('no PlayerState cloned: create_war / place_bet simulations skipped');
  await expectSim(conn, `expire_epoch(${lastEpoch}) on the cloned epoch`, await program.methods.expireEpoch().accountsPartial({ config, epoch }).instruction(), payer, 'ClaimWindowOpen');
  // S7 first run (6.3 steps 4-8): set_architect and lock_collection_royalties need the architect's key -> simulated
  // without signature verification; init_seat / init_extra are permissionless -> sent; arm_keeper is sent only when the
  // binary's INITIAL_KEEPER is the throwaway key of FORK_KEEPER_KEY (default tests/fixtures/test-keeper.json), else simulated.
  const newArch = Keypair.generate().publicKey;
  const setArch = await program.methods.setArchitect(newArch).accountsPartial({ config, architect, newArchitect: newArch, rewardVault: pda('reward_vault') }).instruction();
  await expectSim(conn, 'set_architect simulated without the new key', setArch, architect, 'Unauthorized');
  setArch.keys.find((k) => k.pubkey.equals(newArch)).isSigner = true; // both keys sign at S7 (6.3 step 4)
  await expectSim(conn, 'set_architect simulated (architect + new key)', setArch, architect, 'ok');
  const col = await conn.getAccountInfo(pda('collection'));
  if (col) await expectSim(conn, 'lock_collection_royalties simulated (config.architect)', await program.methods.lockCollectionRoyalties().accountsPartial({ config, collection: pda('collection'), artifactAuthority: pda('artifact_authority'), architect, coreProgram: CORE, systemProgram: SystemProgram.programId }).instruction(), architect, 'ok');
  else ok('no Core collection on mainnet yet: lock_collection_royalties needs init_artifacts first (skipped)');
  await program.methods.initSeat().accounts({ payer }).rpc(); ok('init_seat sent');
  await program.methods.initExtra().accounts({ payer }).rpc(); ok('init_extra sent');
  // dry void on the newest epoch: HoldOver, or BondTooSmall / SeatMissing when still inside its hold (then 6.1's hold case is live)
  await expectSim(conn, `void_epoch(${lastEpoch}) dry`, await program.methods.voidEpoch(new anchor.BN(lastEpoch), new anchor.BN(0)).accountsPartial({ config, epoch, seat: pda('oracle_seat'), rewardVault: pda('reward_vault'), voider: payer, systemProgram: SystemProgram.programId }).instruction(), payer, ['HoldOver', 'BondTooSmall']);

  // a mainnet build refuses the published test keys, so a throwaway rehearsal build carries a fresh keeper key:
  // tests/check-mainnet-guards.sh with MF_THROWAWAY_OUT writes it next to the binary (FORK_KEEPER_KEY=<dir>/throwaway-keeper.json)
  const keeperFile = process.env.FORK_KEEPER_KEY || path.join(here, 'fixtures/test-keeper.json');
  const so = fs.readFileSync(path.join(dir, 'deployed.so'));
  const keeper = kp(keeperFile);
  if (keyChunks(so, keeper.publicKey) === 4) {
    await conn.confirmTransaction(await conn.requestAirdrop(keeper.publicKey, 30e9), 'confirmed');
    const kprog = new anchor.Program(NEW_IDL, new anchor.AnchorProvider(conn, new anchor.Wallet(keeper), { commitment: 'confirmed' }));
    await kprog.methods.armKeeper(Array(32).fill(9), new anchor.BN(1_000_000), new anchor.BN(20e9)).accounts({ keeper: keeper.publicKey }).rpc();
    ok('arm_keeper sent by the throwaway INITIAL_KEEPER (20 XNT bond)');
  } else ok('arm_keeper: INITIAL_KEEPER is a real key (needs the VPS key): not sent');
  for (const [name, k] of [['OracleSeat', pda('oracle_seat')], ['ExtraState', pda('extra_state')], ['extra_vault', pda('extra_vault')], ['HouseKeeper', pda('house_keeper')]]) {
    const a = await conn.getAccountInfo(k);
    (a ? ok : bad)(`census: ${name} ${k.toBase58()} ${a ? `${a.data.length} B, ${a.lamports} lamports` : 'missing'}`);
  }
  // informational: which cloned accounts the first-run steps wrote (the upgrade itself changed none, checked above)
  for (const k of Object.keys(census)) {
    const a = await conn.getAccountInfo(new PublicKey(k)); const s = snap(k);
    if (!(a && a.lamports === s.lamports && Buffer.from(a.data).equals(Buffer.from(s.data[0], 'base64')))) console.log(`  note written by the first-run steps: ${k} (${census[k].disc})${a ? ` lamports ${s.lamports} -> ${a.lamports}` : ' closed'}`);
  }
  console.log(failures ? `${failures} FAILED` : 'fork rehearsal: all checks passed');
  process.exit(failures ? 1 : 0);
} else {
  console.error('usage: guard|census|before|after'); process.exit(2);
}
