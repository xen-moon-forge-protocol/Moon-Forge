#!/usr/bin/env node
// READ-ONLY census of the program for the upgrade-day gates (deployments/upgrade-v3-signoff.md section 4, SPEC-UPGRADE-v2
// 9.1 S5 and 9.4). It never signs and never sends: it reads accounts and simulates a few instructions without
// signatures. Exit 0 = every gate green, 1 = a gate failed, 2 = usage, 3 = refused.
//
//   s5  before the deploy (S6 − 30 min): the live v2 binary as expected (last-deploy slot, data length, both
//       authorities = the deploy wallet), every in-flight account listed, no Jackpot round DRAWING, no v1 PredRound
//       lock/settle near the window, the planned start outside the forbidden times, any epoch younger than 48 h noted,
//       the deploy-wallet and INITIAL_KEEPER balances (the keeper only needs fees: no keeper bond at S7, F1-b), the free
//       pool and the seat bond.
//   s6  after the deploy and the authority moves: a new deploy slot, the deployed ELF = the S2 build, both authorities =
//       the DEPLOY_KEY, the on-chain IDL = the v3 IDL, the SPEC 6.3 step-1 simulations.
//   s7  after the first-run steps: s6 + Config.architect = the payee, the Royalties plugin locked (500 bps, payee 100%),
//       OracleSeat (cold / refund keys), ExtraState + extra_vault, and NO HouseKeeper (F1-b, owner answer of 2026-10-25:
//       the house keeper is not armed at S7 and no keeper bond is posted). --keeper-armed instead expects the HouseKeeper
//       of the later arm (s7.mjs --arm-keeper): armed by INITIAL_KEEPER with a bond of at least 20 XNT.
//   s9  after the freeze: no upgrade authority, the IDL authority erased, the binary and the IDL unchanged since S6; the
//       HouseKeeper as in s7 (absent unless --keeper-armed).
import fs from 'fs';
import path from 'path';
import {
  web3, PROGRAM_ID, DEPLOY_WALLET, LIVE_DEPLOY_SLOT, LIVE_DATA_LEN, MAINNET_RPC, ERASED, XNT, KEEPER_BOND_MIN, ORACLE_SEAT_SIZE,
  EXTRA_STATE_SIZE, IDL_V3_FILE, IDL_LIVE_FILE, P, le64, parseArgs, pubkeyArg, lamportsArg, connectTo, describeCluster, xnt, iso, b58, big,
  Gates, loadIdl, makeDecoder, sameJson, sha256, readProgram, deployedElfSha, readIdlAccount, balance, freePoolAndBond,
  fetchDecoded, parseCoreCollection, royaltiesOf, keyChunks, idlIx, simulateIxs, elfExpectation, readJson, refuse, run, anchor, ROOT, stepOneSimulations,
} from './lib.mjs';
const { PublicKey } = web3;
const bs58 = anchor.utils.bytes.bs58;

const USAGE = `usage: node scripts/upgrade/census.mjs --stage s5|s6|s7|s9 [options]   (read-only: nothing is ever sent)
  --rpc <url>                 default ${MAINNET_RPC}
  --out <file>                write the census as JSON (its sha256 goes on the sign-off sheet)
  --deploy-wallet <pubkey>    the current upgrade + IDL authority and payee (default ${DEPLOY_WALLET})
  --keeper-wallet <pubkey>    OD-25 INITIAL_KEEPER: s5 balance, s6 compiled-in check, HouseKeeper.keeper with --keeper-armed
  --keeper-armed              s7, s9: expect the HouseKeeper of the LATER arm (s7.mjs --arm-keeper); without it the census
                              expects NO HouseKeeper (F1-b: not armed at S7, no keeper bond posted)
  --deploy-key <pubkey>       OD-32 DEPLOY_KEY: the upgrade + IDL authority from S6 to S9 (s6, s7, s9)
  --payee <pubkey>            OD-22 architect payee (s7, s9)
  --seat-cold <pubkey>        OD-16 SEAT_COLD_INITIAL (s6 compiled-in check, s7, s9)
  --seat-refund <pubkey>      OD-20 SEAT_REFUND_INITIAL (s7, s9)
  --expect-deploy-slot <n>    s5: the live binary's slot (default ${LIVE_DEPLOY_SLOT}); s6/s7/s9: the S6 deploy slot
  --legacy-deploy-slot <n>    the live v2 binary's slot that "upgraded" must be after (default ${LIVE_DEPLOY_SLOT})
  --expect-data-len <n>       s5: ProgramData data length (default ${LIVE_DATA_LEN})
  --elf <file> | --elf-sha <hex> --elf-bytes <n>   the S2 build (default: the oracle's UPGRADED_ELF pin, if set)
  --pin-file <file>           where to read the UPGRADED_ELF pin (default oracle/src/x1-v3.ts)
  --idl <file>                the IDL expected on chain from S6 on (default oracle/src/idl/moon_forge.v3.json)
  --metadata-base <uri>       METADATA_BASE_URI of the S2 build (s7: the collection URI = it + collection.json)
  --deploy-at <ISO time>      s5: the planned start of the deploy (default now)
  --window-min <n>            s5: minutes the deploy session may take (default 240)
  --min-deploy <XNT>          s5: deploy-wallet balance needed (default 15)
  --min-keeper <XNT>          s5: INITIAL_KEEPER balance needed (default 0.1, its fees: no keeper bond at S7, F1-b)
  --list-max <n>              in-flight rows printed per kind (default 25; the JSON always has all)`;
const args = parseArgs(process.argv.slice(2), {
  stage: 'string', rpc: 'string', out: 'string', 'deploy-wallet': 'string', 'keeper-wallet': 'string', 'deploy-key': 'string',
  payee: 'string', 'seat-cold': 'string', 'seat-refund': 'string', 'expect-deploy-slot': 'string', 'legacy-deploy-slot': 'string',
  'expect-data-len': 'string', elf: 'string', 'elf-sha': 'string', 'elf-bytes': 'string', 'pin-file': 'string', idl: 'string',
  'metadata-base': 'string', 'deploy-at': 'string', 'window-min': 'string', 'min-deploy': 'string', 'min-keeper': 'string', 'list-max': 'string',
  'keeper-armed': 'bool',
}, USAGE);

const KINDS_IN_FLIGHT = ['Epoch', 'Bet', 'JackpotRound', 'DrawRound', 'PredRound', 'Duel', 'War', 'HouseShare', 'Mission', 'Listing', 'ExtraEpoch'];
const num = (v, what) => { if (v === undefined) return null; if (!/^\d+$/.test(v)) refuse(`${what}: "${v}" is not a number`); return Number(v); };

async function main() {
  const stage = args.stage;
  if (!['s5', 's6', 's7', 's9'].includes(stage)) refuse('--stage must be s5, s6, s7 or s9');
  const c = await connectTo(args.rpc || MAINNET_RPC);
  const { conn } = c;
  const G = new Gates();
  const takenAt = new Date();
  const listMax = num(args['list-max'], '--list-max') ?? 25;
  const deployWallet = pubkeyArg(args['deploy-wallet'] || DEPLOY_WALLET, '--deploy-wallet');
  const keeperWallet = pubkeyArg(args['keeper-wallet'], '--keeper-wallet');
  const deployKey = pubkeyArg(args['deploy-key'], '--deploy-key');
  const payee = pubkeyArg(args.payee, '--payee');
  const seatCold = pubkeyArg(args['seat-cold'], '--seat-cold');
  const seatRefund = pubkeyArg(args['seat-refund'], '--seat-refund');
  const legacySlot = num(args['legacy-deploy-slot'], '--legacy-deploy-slot') ?? LIVE_DEPLOY_SLOT;
  const expectSlot = num(args['expect-deploy-slot'], '--expect-deploy-slot') ?? (stage === 's5' ? LIVE_DEPLOY_SLOT : null);
  const idlFile = args.idl || IDL_V3_FILE;
  const v3 = loadIdl(IDL_V3_FILE);
  const live = loadIdl(IDL_LIVE_FILE);
  const dec = stage === 's5' ? makeDecoder(live, v3) : makeDecoder(v3, live);
  const slot = await conn.getSlot('confirmed');
  const blockTime = await conn.getBlockTime(slot).catch(() => null);
  const census = { tool: 'scripts/upgrade/census.mjs', stage, takenAt: takenAt.toISOString(), cluster: { genesis: c.genesis, mainnet: c.mainnet, rpc: c.rpc }, slot, blockTime };

  console.log(`Moon Forge census, stage ${stage} (read-only)`);
  console.log(`  cluster ${describeCluster(c)}; slot ${slot}, block time ${iso(blockTime)}; taken ${takenAt.toISOString()}${stage === 's5' ? ` (valid for the S6 step-4 check until ${new Date(takenAt.getTime() + 30 * 60_000).toISOString()})` : ''}`);

  // ── program, ProgramData, the deployed ELF ──────────────────────────────────────────────────────────────────────
  console.log('\nprogram');
  const prog = await readProgram(conn, { full: stage !== 's5' });
  if (prog.error) { G.fail('program', prog.error); return finish(G, census); }
  census.program = { programData: prog.programData.toBase58(), deploySlot: prog.deploySlot, upgradeAuthority: b58(prog.authority), dataLen: prog.dataLen, lamports: prog.lamports };
  G.info('ProgramData', `${prog.programData.toBase58()}, last-deploy slot ${prog.deploySlot}, data length ${prog.dataLen} B, upgrade authority ${b58(prog.authority)}`);
  if (stage === 's5') {
    G.check(prog.deploySlot === expectSlot, 'last-deploy slot', `${prog.deploySlot} = ${expectSlot} (the live binary)`, `${prog.deploySlot}, expected ${expectSlot}: STOP (sign-off section 1)`);
    const wantLen = num(args['expect-data-len'], '--expect-data-len') ?? LIVE_DATA_LEN;
    G.check(prog.dataLen === wantLen, 'ProgramData data length', `${prog.dataLen} B = ${wantLen} B`, `${prog.dataLen} B, expected ${wantLen} B (an extension is permanent but harmless; re-read the sheet's step 1)`);
    G.check(!!prog.authority && prog.authority.equals(deployWallet), 'upgrade authority', `${b58(prog.authority)} = the deploy wallet`, `${b58(prog.authority)}, expected the deploy wallet ${deployWallet.toBase58()}: STOP`);
  } else {
    G.check(prog.deploySlot > legacySlot, 'upgraded binary deployed', `last-deploy slot ${prog.deploySlot} > ${legacySlot}`, `last-deploy slot ${prog.deploySlot} is not after ${legacySlot}: the upgrade has not landed`);
    if (expectSlot !== null) G.check(prog.deploySlot === expectSlot, 'last-deploy slot = the S6 deploy', `${prog.deploySlot}`, `${prog.deploySlot}, expected ${expectSlot}: the program was deployed again after S6`);
    const want = stage === 's9' ? null : deployKey;
    if (stage === 's9') G.check(prog.authority === null, 'upgrade authority', 'none (frozen)', `${b58(prog.authority)}: not frozen`);
    else if (!want) G.fail('upgrade authority', `${b58(prog.authority)}; --deploy-key is required at ${stage}`);
    else G.check(!!prog.authority && prog.authority.equals(want), 'upgrade authority', `${b58(prog.authority)} = the DEPLOY_KEY`, `${b58(prog.authority)}, expected the DEPLOY_KEY ${want.toBase58()}`);
    const exp = elfExpectation(args);
    census.program.elf = exp ? { sha256: exp.sha256, bytes: exp.bytes, from: exp.from } : null;
    if (!exp) G.fail('deployed ELF', 'no S2 build to compare with: give --elf or --elf-sha/--elf-bytes (or pin UPGRADED_ELF first)');
    else {
      const got = deployedElfSha(prog.body, exp.bytes);
      census.program.deployedSha256 = got;
      G.check(got === exp.sha256, 'deployed ELF = the S2 build', `sha256 ${got} (${exp.bytes} B, from ${exp.from}), zero padding after`, `${got === null ? `not ${exp.bytes} B followed by zeros` : `sha256 ${got}`}, expected ${exp.sha256} (${exp.from}): STOP`);
      // the S2 constants compiled into the deployed binary (K-4 / OD-16): every key appears as its four 8-byte immediates
      const so = prog.body.subarray(0, exp.bytes);
      for (const [what, k] of [['INITIAL_KEEPER', keeperWallet], ['SEAT_COLD_INITIAL', seatCold]]) {
        if (k) G.check(keyChunks(so, k) === 4, `${what} compiled in`, `${k.toBase58()} found in the deployed ELF`, `${k.toBase58()} not found in the deployed ELF`);
      }
    }
  }

  // ── the IDL account ─────────────────────────────────────────────────────────────────────────────────────────────
  console.log('\nIDL account');
  const idl = await readIdlAccount(conn);
  census.idl = idl.exists ? { address: idl.address.toBase58(), authority: idl.authority.toBase58(), compressedLen: idl.compressedLen, capacity: idl.capacity, decodeError: idl.error } : { address: idl.address.toBase58(), exists: false };
  if (!idl.exists) G.fail('IDL account', `${idl.address.toBase58()} does not exist`);
  else {
    G.info('IDL account', `${idl.address.toBase58()}: ${idl.accountLen} B, ${idl.compressedLen} B compressed of ${idl.capacity} B usable, authority ${idl.authority.toBase58()}`);
    if (stage === 's5') G.check(idl.authority.equals(deployWallet), 'IDL authority', `${idl.authority.toBase58()} = the deploy wallet`, `${idl.authority.toBase58()}, expected the deploy wallet ${deployWallet.toBase58()}: STOP`);
    else if (stage === 's9') G.check(idl.authority.toBase58() === ERASED, 'IDL authority', `${ERASED} (erased)`, `${idl.authority.toBase58()}: not erased`);
    else if (!deployKey) G.fail('IDL authority', `${idl.authority.toBase58()}; --deploy-key is required at ${stage}`);
    else G.check(idl.authority.equals(deployKey), 'IDL authority', `${idl.authority.toBase58()} = the DEPLOY_KEY`, `${idl.authority.toBase58()}, expected the DEPLOY_KEY ${deployKey.toBase58()}`);
    if (idl.error) G.fail('IDL content', `does not inflate as JSON (${idl.error})`);
    else if (stage === 's5') {
      // the IDL on chain today is the recorded tests/fixtures/idl-onchain-v2.json (the oracle's live copy is the same ABI)
      const recorded = path.join(ROOT, 'tests/fixtures/idl-onchain-v2.json');
      const same = fs.existsSync(recorded) && sameJson(idl.json, readJson(recorded));
      census.idl.equalsRecordedV2 = same;
      G.info('IDL content', `${idl.json.instructions?.length ?? '?'} instructions, ${idl.json.accounts?.length ?? '?'} accounts; ${same ? 'equals tests/fixtures/idl-onchain-v2.json (the recorded on-chain IDL)' : 'differs from tests/fixtures/idl-onchain-v2.json'} as key-sorted JSON`);
    } else {
      const want = readJson(idlFile);
      G.check(sameJson(idl.json, want), 'IDL content', `equals ${path.basename(idlFile)} (sha256 ${sha256(fs.readFileSync(idlFile))}) as key-sorted JSON`, `differs from ${path.basename(idlFile)}: the S6 step-7 IDL upgrade is missing or used another file`);
    }
  }

  // ── Config, the Core collection, vaults ─────────────────────────────────────────────────────────────────────────
  console.log('\nconfig and collection');
  const cfgD = await fetchDecoded(conn, dec, P.config);
  if (!cfgD?.value) { G.fail('Config', `${P.config.toBase58()} missing or undecodable`); return finish(G, census); }
  const cfg = cfgD.value;
  census.config = { oracle: cfg.oracle.toBase58(), pendingOracle: cfg.pending_oracle.toBase58(), architect: cfg.architect.toBase58(), lastEpoch: Number(cfg.last_epoch), lastPublishTs: Number(cfg.last_publish_ts), rewardReserved: cfg.reward_reserved.toString(), bankrollReserved: cfg.bankroll_reserved.toString(), jackpotRound: Number(cfg.jackpot_round), drawRound: Number(cfg.draw_round), artifactsMinted: cfg.artifacts_minted, artifactsAlive: cfg.artifacts_alive };
  G.info('Config', `oracle ${cfg.oracle.toBase58()}, architect ${cfg.architect.toBase58()}, last epoch ${cfg.last_epoch} at ${iso(cfg.last_publish_ts)}, reward reserved ${xnt(cfg.reward_reserved)}, bankroll reserved ${xnt(cfg.bankroll_reserved)}`);
  if (stage === 's5' || stage === 's6') G.check(cfg.architect.equals(deployWallet), 'Config.architect', `${cfg.architect.toBase58()} = the deploy wallet (it co-signs set_architect at S7)`, `${cfg.architect.toBase58()}, expected the deploy wallet ${deployWallet.toBase58()}`);
  else if (payee) G.check(cfg.architect.equals(payee), 'Config.architect = the OD-22 payee', cfg.architect.toBase58(), `${cfg.architect.toBase58()}, expected ${payee.toBase58()}`);
  else G.fail('Config.architect', `${cfg.architect.toBase58()}; --payee is required at ${stage}`);
  if (!cfg.pending_oracle.equals(PublicKey.default)) G.warn('Config.pending_oracle', `${cfg.pending_oracle.toBase58()} (an oracle hand-over is pending)`);
  const pool = await freePoolAndBond(conn, cfg);
  if (!pool.error) {
    census.pool = { rewardVault: pool.lamports.toString(), rent: pool.rent.toString(), reserved: pool.reserved.toString(), free: pool.free.toString(), seatBond: pool.bond.toString() };
    G.info('free pool', `${xnt(pool.free)} (vault ${xnt(pool.lamports)} - rent ${xnt(pool.rent)} - reserved ${xnt(pool.reserved)}); init_seat bond now ${xnt(pool.bond)} = max(1 XNT, 10% of free)`);
  }
  const colAcc = await conn.getAccountInfo(P.collection, 'confirmed');
  if (!colAcc) G.warn('Core collection', `${P.collection.toBase58()} does not exist (init_artifacts never ran)`);
  else {
    try {
      const col = parseCoreCollection(colAcc.data);
      const roy = royaltiesOf(col);
      census.collection = { address: P.collection.toBase58(), uri: col.uri, numMinted: col.numMinted, currentSize: col.currentSize, updateAuthority: col.updateAuthority.toBase58(), plugins: col.plugins.map((p) => ({ type: p.type, authority: p.authority, address: b58(p.address), royalties: p.royalties ? { bps: p.royalties.bps, creators: p.royalties.creators.map((x) => ({ address: x.address.toBase58(), percentage: x.percentage })), ruleSet: p.royalties.ruleSet } : undefined })) };
      G.info('Core collection', `${P.collection.toBase58()}: uri ${col.uri}, minted ${col.numMinted}, size ${col.currentSize}, plugins ${col.plugins.map((p) => `${p.type}(${p.authority})`).join(', ') || 'none'}`);
      if (roy?.royalties) G.info('Royalties plugin', `${roy.royalties.bps} bps, creators ${roy.royalties.creators.map((x) => `${x.address.toBase58()} ${x.percentage}%`).join(', ')}, rule set ${roy.royalties.ruleSet}, authority ${roy.authority}`);
      if (stage === 's7' || stage === 's9') {
        const want = payee;
        const r = roy?.royalties;
        G.check(!!r && roy.authority === 'None' && r.bps === 500 && r.creators.length === 1 && !!want && r.creators[0].address.equals(want) && r.creators[0].percentage === 100 && r.ruleSet === 'None',
          'Royalties locked (lock_collection_royalties)', `500 bps, ${want?.toBase58()} 100%, rule set None, plugin authority None`,
          r ? `${r.bps} bps, ${r.creators.map((x) => `${x.address.toBase58()} ${x.percentage}%`).join(', ')}, rule set ${r.ruleSet}, authority ${roy.authority}${want ? '' : ' (--payee missing)'}` : 'no Royalties plugin');
        if (args['metadata-base']) G.check(col.uri === `${args['metadata-base']}collection.json`, 'collection URI (refresh_collection_uri)', col.uri, `${col.uri}, expected ${args['metadata-base']}collection.json`);
      }
    } catch (e) { G.fail('Core collection', `does not parse: ${e.message}`); }
  }

  // ── the upgraded-only PDAs ──────────────────────────────────────────────────────────────────────────────────────
  console.log('\nupgraded-only accounts');
  const [seatA, extraA, vaultA, keeperA] = await conn.getMultipleAccountsInfo([P.oracleSeat, P.extraState, P.extraVault, P.houseKeeper], 'confirmed');
  census.v3 = { oracleSeat: !!seatA, extraState: !!extraA, extraVault: !!vaultA, houseKeeper: !!keeperA };
  if (stage === 's5' || stage === 's6') {
    G.check(!seatA && !extraA && !keeperA, 'no OracleSeat / ExtraState / HouseKeeper yet', 'none exists (the S7 first-run steps create them)', `present: ${[seatA && 'OracleSeat', extraA && 'ExtraState', keeperA && 'HouseKeeper'].filter(Boolean).join(', ')}`);
  } else {
    if (!seatA) G.fail('OracleSeat (init_seat)', `${P.oracleSeat.toBase58()} missing`);
    else {
      const s = dec.decode(seatA.data)?.value;
      census.v3.seat = s ? { generation: Number(s.generation), cold: s.cold.toBase58(), refund: s.refund.toBase58(), bond: s.bond.toString(), takenAt: Number(s.taken_at), openSince: Number(s.open_since), voids: s.voids } : null;
      if (!s || seatA.data.length !== ORACLE_SEAT_SIZE) G.fail('OracleSeat (init_seat)', `${seatA.data.length} B, does not decode`);
      else {
        G.ok('OracleSeat (init_seat)', `${P.oracleSeat.toBase58()}: generation ${s.generation}, hot ${cfg.oracle.toBase58()}, bond ${xnt(s.bond)}, taken ${iso(s.taken_at)}, open since ${Number(s.open_since) ? iso(s.open_since) : 'never'}`);
        if (seatCold) G.check(s.cold.equals(seatCold), 'seat cold key (OD-16)', s.cold.toBase58(), `${s.cold.toBase58()}, expected ${seatCold.toBase58()}`); else G.warn('seat cold key (OD-16)', `${s.cold.toBase58()} (give --seat-cold to check it)`);
        if (seatRefund) G.check(s.refund.equals(seatRefund), 'seat refund key (OD-20)', s.refund.toBase58(), `${s.refund.toBase58()}, expected ${seatRefund.toBase58()}`); else G.warn('seat refund key (OD-20)', `${s.refund.toBase58()} (give --seat-refund to check it)`);
        G.check(big(s.bond) >= XNT, 'seat bond', `${xnt(s.bond)} >= 1 XNT`, `${xnt(s.bond)} < 1 XNT`);
      }
    }
    if (!extraA) G.fail('ExtraState (init_extra)', `${P.extraState.toBase58()} missing`);
    else {
      const x = dec.decode(extraA.data)?.value;
      census.v3.extra = x ? { lastEpoch: Number(x.last_epoch), accounted: x.accounted.toString(), reserved: x.reserved.toString(), totalIn: x.total_in.toString() } : null;
      G.check(!!x && extraA.data.length === EXTRA_STATE_SIZE, 'ExtraState (init_extra)', `${P.extraState.toBase58()}: last epoch ${x?.last_epoch}, accounted ${x ? xnt(x.accounted) : '?'}, reserved ${x ? xnt(x.reserved) : '?'}`, `${extraA.data.length} B, does not decode`);
    }
    G.check(!!vaultA && vaultA.owner.equals(PROGRAM_ID), 'extra_vault', vaultA ? `${P.extraVault.toBase58()}: ${xnt(vaultA.lamports)}, ${vaultA.data.length} B, program-owned` : 'missing', vaultA ? `owned by ${vaultA.owner.toBase58()}` : `${P.extraVault.toBase58()} missing`);
    if (!args['keeper-armed']) {
      // F1-b: no seat means no house bet and a Jackpot draw that refunds every entry, so no bond can be drained
      if (!keeperA) G.ok('HouseKeeper not armed (F1-b)', `${P.houseKeeper.toBase58()} absent: no house bets, a Jackpot draw refunds, no keeper bond posted; house games and the Jackpot stay hidden on the site (D-39)`);
      else {
        const k = dec.decode(keeperA.data)?.value;
        census.v3.keeper = k ? { keeper: k.keeper.toBase58(), length: k.length.toString(), bond: k.bond.toString(), armedSlot: k.armed_slot.toString() } : null;
        G.fail('HouseKeeper not armed (F1-b)', `present${k ? `: keeper ${k.keeper.toBase58()}, chain ${k.length}, bond ${xnt(k.bond)}, armed at slot ${k.armed_slot}` : ''}; F1-b says no arm at S7 (if this is the later arm of s7.mjs --arm-keeper, re-run with --keeper-armed)`);
      }
    } else if (!keeperA) G.fail('HouseKeeper (the later arm_keeper)', `${P.houseKeeper.toBase58()} missing`);
    else {
      const k = dec.decode(keeperA.data)?.value;
      census.v3.keeper = k ? { keeper: k.keeper.toBase58(), pendingKeeper: k.pending_keeper.toBase58(), length: k.length.toString(), revealed: k.revealed.toString(), bond: k.bond.toString(), pendingBets: k.pending_bets, armedSlot: k.armed_slot.toString(), withdrawTs: Number(k.withdraw_ts), lastActiveTs: Number(k.last_active_ts) } : null;
      if (!k) G.fail('HouseKeeper (arm_keeper)', 'does not decode');
      else {
        G.check(big(k.length) > 0n, 'HouseKeeper armed', `${P.houseKeeper.toBase58()}: keeper ${k.keeper.toBase58()}, chain ${k.length} (${k.revealed} revealed), armed at slot ${k.armed_slot}, pending ${k.pending_bets}`, 'no chain armed');
        if (keeperWallet) G.check(k.keeper.equals(keeperWallet), 'keeper key (OD-25)', k.keeper.toBase58(), `${k.keeper.toBase58()}, expected ${keeperWallet.toBase58()}`); else G.warn('keeper key (OD-25)', `${k.keeper.toBase58()} (give --keeper-wallet to check it)`);
        G.check(big(k.bond) >= KEEPER_BOND_MIN, 'keeper bond', `${xnt(k.bond)} >= 20 XNT (house games and the Jackpot still stay hidden on the site until the service-level week is met, D-39)`, `${xnt(k.bond)} < 20 XNT`);
        G.check(Number(k.withdraw_ts) === 0, 'keeper withdrawal', 'none requested', `requested at ${iso(k.withdraw_ts)} (K-4 alert)`);
      }
    }
  }

  // ── simulations (no signatures; nothing lands) ──────────────────────────────────────────────────────────────────
  console.log('\nsimulations (sigVerify off; read-only)');
  const sims = await stepOneSimulations(conn, v3, dec, cfg);
  census.simulations = { initSeat: sims.initSeat, createWar: sims.createWar, placeBet: sims.placeBet };
  if (stage === 's5') G.check(sims.initSeat === 'InstructionFallbackNotFound' || /"Custom":101/.test(sims.initSeat), 'init_seat on the live binary', `${sims.initSeat} (programRules 2: the old binary)`, `${sims.initSeat}: the live binary already knows init_seat`);
  else if (stage === 's6') G.check(sims.initSeat === 'ok', 'init_seat (SPEC 6.3 step 1)', 'ok (not 101)', sims.initSeat);
  else G.info('init_seat', `${sims.initSeat} (the seat exists)`);
  if (stage === 's6' || stage === 's7') {
    if (!sims.owner) G.warn('create_war / place_bet simulations', 'no PlayerState on chain to simulate with');
    else {
      G.check(sims.createWar === 'SealedJoinRequired', 'create_war (SPEC 6.3 step 1)', sims.createWar, `${sims.createWar}, expected SealedJoinRequired`);
      G.check(sims.placeBet === 'KeeperRequired', 'place_bet (SPEC 6.3 step 1)', sims.placeBet, `${sims.placeBet}, expected KeeperRequired`);
    }
  }

  // ── every program account, by kind; the in-flight ones listed ───────────────────────────────────────────────────
  console.log('\nprogram accounts');
  const all = await conn.getProgramAccounts(PROGRAM_ID, { commitment: 'confirmed', dataSlice: { offset: 0, length: 8 } });
  const named = new Map([[idl.address.toBase58(), 'IDL'], ...[P.rewardVault, P.bankrollVault, P.drawVault, P.extraVault].map((k) => [k.toBase58(), 'vault'])]);
  const counts = {};
  for (const a of all) {
    const k = named.get(a.pubkey.toBase58()) ?? dec.kindOf(Buffer.concat([Buffer.from(a.account.data), Buffer.alloc(8)]).subarray(0, 8)) ?? 'unknown';
    counts[k] = (counts[k] || 0) + 1;
  }
  census.counts = counts;
  G.info('accounts', `${all.length} program-owned: ${Object.entries(counts).sort().map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (counts.unknown) G.warn('unknown accounts', `${counts.unknown} program-owned accounts decode with neither IDL`);
  const inFlight = {};
  const nowTs = blockTime ?? Math.floor(Date.now() / 1000);
  const deployAt = args['deploy-at'] ? Math.floor(Date.parse(args['deploy-at']) / 1000) : Math.floor(takenAt.getTime() / 1000);
  if (!Number.isFinite(deployAt)) refuse(`--deploy-at "${args['deploy-at']}" is not an ISO time`);
  const windowS = (num(args['window-min'], '--window-min') ?? 240) * 60;
  for (const kind of KINDS_IN_FLIGHT) {
    if (!counts[kind]) continue;
    const disc = dec.discOf(kind);
    const accs = await conn.getProgramAccounts(PROGRAM_ID, { commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }] });
    const rows = [];
    for (const a of accs) {
      const v = dec.decode(a.account.data)?.value;
      if (!v) continue;
      const r = rowOf(kind, a.pubkey.toBase58(), v, a.account.lamports, nowTs);
      if (r) rows.push(r);
    }
    rows.sort((x, y) => (x.sort ?? 0) - (y.sort ?? 0));
    inFlight[kind] = rows;
  }
  census.inFlight = inFlight;
  for (const [kind, rows] of Object.entries(inFlight)) {
    const live = rows.filter((r) => r.live);
    console.log(`  ${kind}: ${rows.length} account(s), ${live.length} in flight`);
    for (const r of live.slice(0, listMax)) console.log(`    ${r.pubkey}  ${r.text}`);
    if (live.length > listMax) console.log(`    ... ${live.length - listMax} more in the JSON`);
  }

  // ── stage-5 timing and in-flight gates ──────────────────────────────────────────────────────────────────────────
  if (stage === 's5') {
    console.log('\ngates of the window');
    const drawing = (inFlight.JackpotRound || []).filter((r) => r.state === 1);
    G.check(drawing.length === 0, 'no Jackpot round DRAWING', 'none', `${drawing.map((r) => `round ${r.id}`).join(', ')} DRAWING: never deploy while a round is drawing (SPEC 9.1)`);
    const lo = deployAt - 30 * 60, hi = deployAt + windowS + 30 * 60;
    const preds = (inFlight.PredRound || []).filter((r) => r.live);
    const near = preds.filter((r) => [r.lockTs, r.endTs].some((t) => t >= lo && t <= hi));
    G.check(near.length === 0, 'no v1 PredRound lock / settle near the window', preds.length ? `${preds.length} open round(s), none locks or settles within 30 min of ${iso(deployAt)} .. ${iso(deployAt + windowS)}` : 'no open round',
      `${near.map((r) => `round ${r.id} (lock ${iso(r.lockTs)}, end ${iso(r.endTs)})`).join(', ')}`);
    const d = new Date(deployAt * 1000);
    const minOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
    const endMin = minOfDay + windowS / 60;
    const nearCron = [12 * 60, 14 * 60].some((m) => (m >= minOfDay - 30 && m <= endMin + 30) || (m + 1440 >= minOfDay - 30 && m + 1440 <= endMin + 30));
    G.check(!nearCron, 'not within 30 min of 12:00 / 14:00 UTC', `${iso(deployAt)} .. ${iso(deployAt + windowS)}`, `${iso(deployAt)} .. ${iso(deployAt + windowS)} touches 12:00 or 14:00 UTC ± 30 min`);
    const sunday = (t) => { const x = new Date(t * 1000); const dow = x.getUTCDay(); const s0 = Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate() - dow) / 1000; return [s0, s0 + 7 * 86400]; };
    const sundays = [...sunday(deployAt), ...sunday(deployAt + windowS)];
    const nearSunday = sundays.some((s0) => deployAt <= s0 + 6 * 3600 && deployAt + windowS >= s0 - 6 * 3600);
    G.check(!nearSunday, 'not within 6 h of Sunday 00:00 UTC', 'clear of the weekly epoch', 'the window touches Sunday 00:00 UTC ± 6 h');
    const inHours = d.getUTCHours() >= 16 && endMin <= 20 * 60;
    if (!inHours) G.warn('16:00-20:00 UTC window', `${iso(deployAt)} .. ${iso(deployAt + windowS)} is outside the sheet's hours`); else G.ok('16:00-20:00 UTC window', `${iso(deployAt)} .. ${iso(deployAt + windowS)}`);
    const young = (inFlight.Epoch || []).filter((r) => r.publishedAt > deployAt - 48 * 3600);
    if (young.length) G.warn('epoch younger than 48 h at the deploy', `${young.map((r) => `epoch ${r.id} published ${iso(r.publishedAt)}`).join(', ')}: its remaining claims wait once (ClaimOnHold until published + 48 h)`);
    else G.ok('no epoch younger than 48 h at the deploy', 'claims continue at once');
    console.log('\nbalances');
    const minDeploy = lamportsArg(args['min-deploy'] ?? '15', '--min-deploy');
    const minKeeper = lamportsArg(args['min-keeper'] ?? '0.1', '--min-keeper');
    const db = await balance(conn, deployWallet);
    census.balances = { deployWallet: { key: deployWallet.toBase58(), lamports: db.toString() } };
    G.check(db >= minDeploy, 'deploy wallet balance', `${deployWallet.toBase58()}: ${xnt(db)} >= ${xnt(minDeploy)}`, `${deployWallet.toBase58()}: ${xnt(db)} < ${xnt(minDeploy)}`);
    if (keeperWallet) {
      const kb = await balance(conn, keeperWallet);
      census.balances.keeperWallet = { key: keeperWallet.toBase58(), lamports: kb.toString() };
      G.check(kb >= minKeeper, 'INITIAL_KEEPER balance', `${keeperWallet.toBase58()}: ${xnt(kb)} >= ${xnt(minKeeper)}`, `${keeperWallet.toBase58()}: ${xnt(kb)} < ${xnt(minKeeper)}`);
    } else G.warn('INITIAL_KEEPER balance', 'not checked (give --keeper-wallet)');
    G.info('manual', 'no epoch build may be between its build and its publish; KEEPER_ENABLED off and no keeper run in progress at step 4 (repository variable)');
  }
  return finish(G, census);
}

/** One row per account; `live` = in flight (needs an exit after the upgrade), else settled history. */
function rowOf(kind, pubkey, v, lamports, now) {
  const n = (x) => Number(x);
  switch (kind) {
    case 'Epoch': {
      const live = !v.closed;
      const hold = n(v.published_at) + 48 * 3600 > now;
      return { pubkey, kind, id: n(v.id), publishedAt: n(v.published_at), expiresAt: n(v.expires_at), live, sort: n(v.id),
        text: `epoch ${v.id}: published ${iso(v.published_at)}, expires ${iso(v.expires_at)}, budget ${xnt(v.budget)}, claimed ${xnt(v.claimed)} (${v.claims}/${v.leaves} leaves), drop reserve ${xnt(v.drop_reserve)} state ${v.drop_state}${v.closed ? ', closed' : ''}${hold ? ', younger than 48 h' : ''}` };
    }
    case 'Bet': return { pubkey, kind, live: true, sort: n(v.target_slot), text: `${(v.game & 0x80) ? 'v2' : 'legacy'} bet of ${v.owner.toBase58()}: game ${v.game & 0x7f}, stake ${xnt(v.stake)}, payout ${xnt(v.payout)}, target slot ${v.target_slot} (legacy: settle_bet single block, unchanged)` };
    case 'JackpotRound': return { pubkey, kind, id: n(v.id), state: v.state, live: v.state <= 1, sort: n(v.id), text: `round ${v.id}: ${['OPEN', 'DRAWING', 'SETTLED', 'REFUNDED'][v.state] ?? v.state}, ${v.entries} entries, total ${xnt(v.total)}, ends ${iso(v.end_ts)}${v.state === 1 ? ` target slot ${v.target_slot}` : ''}` };
    case 'DrawRound': return { pubkey, kind, id: n(v.id), state: v.state, live: v.state <= 1, sort: n(v.id), text: `lottery round ${v.id}: state ${v.state}, ${v.entries} entries, ends ${iso(v.end_ts)} (no new tickets after the upgrade)` };
    case 'PredRound': return { pubkey, kind, id: n(v.id), state: v.state, lockTs: n(v.lock_ts), endTs: n(v.end_ts), live: v.state <= 1, sort: n(v.lock_ts), text: `prediction round ${v.id}: ${['OPEN', 'LOCKED', 'SETTLED', 'REFUNDED'][v.state] ?? v.state}, lock ${iso(v.lock_ts)}, end ${iso(v.end_ts)}, ${v.entries} entries, ${xnt(big(v.totals[0]) + big(v.totals[1]))}` };
    case 'Duel': return { pubkey, kind, state: v.state, live: true, text: `duel of ${v.creator.toBase58()}: state ${v.state}, stake ${xnt(v.stake)}, deadline ${n(v.deadline) ? iso(v.deadline) : 'none'}` };
    case 'War': return { pubkey, kind, state: v.state, live: true, text: `war of ${v.creator.toBase58()}: state ${v.state}, stake ${xnt(v.stake)}, target slot ${v.target_slot}, deadline ${n(v.deadline) ? iso(v.deadline) : 'none'}` };
    case 'HouseShare': {
      const live = big(v.pending_shares) > 0n || n(v.unlock_ts) !== 0;
      return { pubkey, kind, live, text: `LP ${v.owner.toBase58()}: ${v.shares} shares${live ? `, withdrawal of ${v.pending_shares} unlocking ${iso(v.unlock_ts)} (24-h usable window)` : ''}` };
    }
    case 'Mission': return { pubkey, kind, live: big(v.withdrawn) < big(v.total), text: `mission of ${v.player.toBase58()}: epoch ${v.epoch} tier ${v.tier}, ${xnt(v.withdrawn)} of ${xnt(v.total)} withdrawn, ends ${iso(v.end)}` };
    case 'Listing': return { pubkey, kind, live: true, text: 'market listing' };
    case 'ExtraEpoch': return { pubkey, kind, live: !v.closed, text: `extra epoch ${v.id ?? '?'}` };
    default: return null;
  }
}

function finish(G, census) {
  census.gates = G.rows;
  census.verdict = G.failed.length ? 'FAIL' : 'OK';
  console.log(`\ncensus ${census.stage}: ${census.verdict} (${G.rows.filter((r) => r.state === 'ok').length} ok, ${G.warned.length} warn, ${G.failed.length} fail)`);
  for (const r of G.failed) console.log(`  FAIL ${r.name}: ${r.detail}`);
  if (args.out) {
    const body = JSON.stringify(census, (k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof web3.PublicKey ? v.toBase58() : v), 1) + '\n';
    fs.writeFileSync(args.out, body);
    console.log(`  written ${args.out} (sha256 ${sha256(Buffer.from(body))})`);
  }
  return G.failed.length ? 1 : 0;
}

run(main);
