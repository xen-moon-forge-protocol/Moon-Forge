#!/usr/bin/env node
// S7 first run (SPEC-UPGRADE-v2 6.3 steps 3-7; step 8, arm_keeper, is moved to a later day by F1-b; sign-off sheet
// section 5 "Then S7 starts"), right after a green S6:
//   refresh-uri     refresh_collection_uri                      payer: the deploy wallet (permissionless)
//   set-architect   set_architect(OD-22 payee)                  signed by the deploy wallet AND the new payee
//   lock-royalties  lock_collection_royalties                   signed by the payee (= config.architect); refused
//                                                               unless config.architect equals the OD-22 key
//   init-seat       init_seat (bond max(1 XNT, 10% of free))    payer: the deploy wallet
//   init-extra      init_extra (its block time is the OD-9 boundary)   payer: the deploy wallet
//   pins            oracle/src/health-pins.json: architect, seat cold / refund (pins.mjs); the keeper pin stays unpinned
// NOT AT S7 (F1-b, owner answer of 2026-10-25, BOND-GRIEF default (b)): the house keeper is not armed and no keeper bond
// is posted. While no keeper runs, anyone could place house bets, leave them unanchored and have them refunded from the
// bond (SR-2), so a bond posted with no keeper running would be drainable at no cost. No step of this script sends
// arm_keeper or take_keeper unless --arm-keeper is given, and --arm-keeper refuses the S7 steps:
//   arm-keeper      LATER, for the day a keeper runs continuously (an always-on loop outside GitHub Actions, SPEC 9.5)
//                   with the INITIAL_KEEPER key, for at least 24 hours (--continuous-keeper-since; the S4 gate of a new
//                   keeper): arm_keeper (bond >= 20 XNT) by INITIAL_KEEPER, through the oracle's own `keeper-arm` (so the
//                   chain is the one every keeper run derives from that key, keeper-v3.ts), then the keeper pin. It works
//                   after the freeze too (arm_keeper needs no upgrade authority). It starts the service-level week: the
//                   site lists house games and the Jackpot only after that keeper has met the published service levels
//                   (anchor within 150 slots, reveal within 10 minutes) for 7 days, in a site release (D-39, KEEPER_SLA_MET).
//                   A hand-over to another keeper key is the oracle's `keeper-take` (propose_keeper + 7-day notice),
//                   never this script.
// DRY RUN by default: every step reads the chain, prints every account and amount, and simulates (sigVerify off).
// Nothing is signed or sent without --send (and --mainnet on X1 mainnet). Every step re-reads the chain first and is
// skipped when already done, so a re-run after any failure resumes where it stopped. Keys are key files given by path;
// each must hold the public key the sign-off sheet names (the flags). Exit 0 = done (or dry run green), 1 = a step
// failed, 2 = usage, 3 = refused before sending.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import {
  web3, ROOT, PROGRAM_ID, CORE_ID, SYSTEM_ID, DEPLOY_WALLET, LIVE_DEPLOY_SLOT, MAINNET_RPC, XNT, KEEPER_BOND_MIN, IDL_V3_FILE, PINS_FILE,
  P, le64, parseArgs, pubkeyArg, lamportsArg, loadKeyFile, matchKey, connectTo, sendMode, header, xnt, iso, b58, big, Gates, loadIdl, makeDecoder,
  readJson, sameJson, sha256, readProgram, deployedElfSha, readIdlAccount, balance, rentFor, freePoolAndBond, fetchDecoded, parseCoreCollection,
  royaltiesOf, keyChunks, idlIx, cuLimit, cuPrice, printIxs, simulateIxs, printSimulation, sendIxs, elfExpectation, stepOneSimulations, refuse, run,
} from './lib.mjs';
import { applyPins } from './pins.mjs';
const { PublicKey, SystemProgram } = web3;

/** S7 (F1-b): no arm_keeper, no take_keeper. */
const STEPS = ['refresh-uri', 'set-architect', 'lock-royalties', 'init-seat', 'init-extra', 'pins'];
/** Only with --arm-keeper, on a later day (never together with the S7 steps). */
const LATER_STEPS = ['arm-keeper', 'pins'];
/** --continuous-keeper-since must be at least this old at the arm (the S4 gate of a new keeper: >= 24 h on mainnet). */
const CONTINUOUS_MIN_S = 24 * 3600;
/** The service-level week (D-39): the site lists house games and the Jackpot no earlier than the arm + 7 days. */
const SLA_WEEK_S = 7 * 86400;
/** What the payee holds after lock_collection_royalties' top-up: a wallet's rent-exempt minimum plus Core's rent difference. */
const PAYEE_FLOAT = 1_000_000n;
const USAGE = `usage: node scripts/upgrade/s7.mjs --payee <pubkey> [options]   (dry run unless --send)
       node scripts/upgrade/s7.mjs --arm-keeper --payee <pubkey> --keeper <pubkey> --keeper-key <file> --continuous-keeper-since <ISO UTC> [options]   (LATER only)
  S7 (F1-b): ${STEPS.join(', ')}. The house keeper is NOT armed and no keeper bond is posted at S7.
  --rpc <url>                    default ${MAINNET_RPC}
  --deploy-wallet <pubkey>       current Config.architect, payer of the rents and the seat bond (default ${DEPLOY_WALLET})
  --deploy-wallet-key <file>     its key file (needed to send any S7 step)
  --deploy-key <pubkey>          OD-32 DEPLOY_KEY, the upgrade + IDL authority since S6 (checked, and pinned by the pins step);
                                 omit it with --arm-keeper after the freeze (there is no upgrade authority any more)
  --payee <pubkey>               OD-22 architect payee (sign-off section 1)
  --payee-key <file>             its key file, from its encrypted folder (set-architect, lock-royalties)
  --keeper <pubkey>              OD-25 INITIAL_KEEPER (sign-off section 1): at S7 only checked (compiled into the deployed
                                 binary, distinct from the other keys); it stays the only key that can ever create the seat
  --seat-cold <pubkey>           OD-16 SEAT_COLD_INITIAL: checked in the deployed ELF before init_seat, and in the seat after
  --seat-refund <pubkey>         OD-20 SEAT_REFUND_INITIAL: checked in the seat after init_seat
  --metadata-base <uri>          METADATA_BASE_URI of the S2 build: refresh-uri is skipped when the collection already has it
  --arm-keeper                   LATER, never at S7: the steps become ${LATER_STEPS.join(', ')} (arm_keeper by INITIAL_KEEPER through
                                 the oracle's keeper-arm, then the keeper pin). Only for the day a keeper runs continuously
                                 outside GitHub Actions with the INITIAL_KEEPER key. Arming starts the service-level week:
                                 house games and the Jackpot stay hidden on the site until that keeper has met the published
                                 service levels (anchor within 150 slots, reveal within 10 minutes) for 7 days (D-39)
  --continuous-keeper-since <ISO UTC>   with --arm-keeper (required): when that continuous keeper started; refused unless
                                 at least 24 hours before the chain time (the S4 gate of a new keeper)
  --keeper-key <file>            with --arm-keeper: the INITIAL_KEEPER key file (never read without --arm-keeper)
  --deposit <XNT>                with --arm-keeper: the bond (default 20, the minimum)
  --elf <file> | --elf-sha <hex> --elf-bytes <n>   the S2 build (default: the UPGRADED_ELF pin of oracle/src/x1-v3.ts)
  --pin-file <file>              where to read the UPGRADED_ELF pin (default oracle/src/x1-v3.ts)
  --idl <file>                   the IDL that must be on chain (default oracle/src/idl/moon_forge.v3.json)
  --legacy-deploy-slot <n>       the live v2 binary's deploy slot (default ${LIVE_DEPLOY_SLOT})
  --steps <a,b,...>              a subset of ${STEPS.join(',')} (default: all, in that order); with --arm-keeper a
                                 subset of ${LATER_STEPS.join(',')}
  --pins <file>                  default oracle/src/health-pins.json (written only with --send, after every step is green)
  --cu-price <micro-lamports>    optional priority fee per compute unit
  --localnet-oracle              rehearsals: run the oracle's keeper-arm with tests/e2e-oracle/preload.cjs (localnet time
                                 profile, LIVE_DEPLOY_SLOT 0); refused unless the RPC is a local validator
  --send                         sign and send (else dry run)
  --mainnet                      required together with --send on X1 mainnet`;
const args = parseArgs(process.argv.slice(2), {
  rpc: 'string', 'deploy-key': 'string', 'deploy-wallet': 'string', 'deploy-wallet-key': 'string', payee: 'string', 'payee-key': 'string', keeper: 'string',
  'keeper-key': 'string', 'seat-cold': 'string', 'seat-refund': 'string', deposit: 'string', 'metadata-base': 'string', elf: 'string',
  'elf-sha': 'string', 'elf-bytes': 'string', 'pin-file': 'string', idl: 'string', 'legacy-deploy-slot': 'string', steps: 'string',
  pins: 'string', 'cu-price': 'string', 'localnet-oracle': 'bool', send: 'bool', mainnet: 'bool', 'arm-keeper': 'bool',
  'continuous-keeper-since': 'string',
}, USAGE);

async function main() {
  const c = await connectTo(args.rpc || MAINNET_RPC);
  const { conn } = c;
  const send = sendMode(args, c);
  const later = !!args['arm-keeper'];
  header(later ? 'Moon Forge house keeper, LATER step (arm_keeper by INITIAL_KEEPER; never at S7)' : 'Moon Forge S7 first run (SPEC-UPGRADE-v2 6.3 steps 3-7; no arm_keeper: F1-b)', c, send);
  if (args['localnet-oracle'] && !c.local) refuse('--localnet-oracle is for a local validator only');
  const allowed = later ? LATER_STEPS : STEPS;
  const steps = args.steps ? args.steps.split(',').map((s) => s.trim()) : allowed;
  for (const s of steps) {
    if (s === 'arm-keeper' && !later) refuse('--steps arm-keeper: the house keeper is NOT armed at S7 (F1-b, owner answer of 2026-10-25): no keeper bond is posted while no keeper runs continuously. On the later day give --arm-keeper with --continuous-keeper-since (see --help)');
    if (!allowed.includes(s)) refuse(`--steps: "${s}" is not a step of ${later ? 'the later --arm-keeper run' : 'S7'} (${allowed.join(', ')})${later && STEPS.includes(s) ? '; --arm-keeper never runs together with the S7 steps' : ''}`);
  }
  if (!later) {
    for (const f of ['keeper-key', 'deposit', 'continuous-keeper-since']) if (args[f] !== undefined) refuse(`--${f} belongs to the later --arm-keeper run only: at S7 the house keeper is not armed (F1-b)`);
    console.log('  F1-b: no arm_keeper and no take_keeper at S7; no keeper bond is posted. House games and the Jackpot stay hidden on the');
    console.log('  site until a continuous keeper has met the published service levels for a week (D-39).');
  }

  // ── keys (public keys from the sheet; key files by path, each must match) ────────────────────────────────────────
  const deployWallet = pubkeyArg(args['deploy-wallet'] || DEPLOY_WALLET, '--deploy-wallet');
  const payee = pubkeyArg(args.payee, '--payee');
  const keeper = pubkeyArg(args.keeper, '--keeper');
  const seatCold = pubkeyArg(args['seat-cold'], '--seat-cold');
  const seatRefund = pubkeyArg(args['seat-refund'], '--seat-refund');
  const deployKey = pubkeyArg(args['deploy-key'], '--deploy-key');
  if (!payee) refuse('--payee <pubkey> is required (OD-22, sign-off section 1)');
  if (!keeper && later) refuse('--keeper <pubkey> is required with --arm-keeper (OD-25, sign-off section 1)');
  let continuousSince = null;
  if (later) {
    if (!args['continuous-keeper-since']) refuse('--arm-keeper needs --continuous-keeper-since <ISO UTC>: the start of the keeper that runs continuously outside GitHub Actions with the INITIAL_KEEPER key (a bond posted while no keeper runs can be drained at no cost, SR-2 / BOND-GRIEF)');
    continuousSince = Math.floor(Date.parse(args['continuous-keeper-since']) / 1000);
    if (!Number.isFinite(continuousSince) || !/(Z|[+-]00:?00)$/.test(args['continuous-keeper-since'])) refuse(`--continuous-keeper-since "${args['continuous-keeper-since']}" is not an ISO time in UTC (end it with Z)`);
  }
  // S7 never touches a key it does not need: the deploy wallet and the payee only for the S7 steps, the keeper key only later
  const deployKp = later ? null : matchKey(loadKeyFile(args['deploy-wallet-key'], '--deploy-wallet-key'), deployWallet, '--deploy-wallet-key');
  const payeeKp = later ? null : matchKey(loadKeyFile(args['payee-key'], '--payee-key'), payee, '--payee-key');
  if (later) for (const f of ['deploy-wallet-key', 'payee-key']) if (args[f]) refuse(`--${f} is not used by the later --arm-keeper run: leave that key in its encrypted folder`);
  const keeperKp = later && keeper ? matchKey(loadKeyFile(args['keeper-key'], '--keeper-key'), keeper, '--keeper-key') : null;
  const deposit = lamportsArg(args.deposit ?? '20', '--deposit');
  if (deposit < KEEPER_BOND_MIN) refuse(`--deposit ${xnt(deposit)} is below KEEPER_BOND_MIN ${xnt(KEEPER_BOND_MIN)}`);
  const cuP = args['cu-price'] ? Number(args['cu-price']) : 0;
  const pre = (ixs, units) => [cuLimit(units), ...(cuP ? [cuPrice(cuP)] : []), ...ixs];
  console.log('  keys (public; the key files are only read, never printed):');
  for (const [n, k, kp, used] of [['deploy wallet', deployWallet, deployKp, !later], ['payee (OD-22)', payee, payeeKp, !later], ['INITIAL_KEEPER (OD-25)', keeper, keeperKp, later], ['seat cold (OD-16)', seatCold, null, false], ['seat refund (OD-20)', seatRefund, null, false]]) {
    if (k) console.log(`    ${n.padEnd(24)} ${k.toBase58()}${kp ? '  key file given' : n.startsWith('seat') ? '' : !used ? (n.startsWith('INITIAL') ? '  (checked only: not armed at S7, F1-b)' : '  (not used by this run)') : '  (no key file: dry run only for its steps)'}`);
  }

  // ── preflight: the upgraded binary, the IDL, Config, key roles ───────────────────────────────────────────────────
  console.log('\npreflight (read-only)');
  const G = new Gates();
  const v3 = loadIdl(IDL_V3_FILE);
  const dec = makeDecoder(v3);
  const legacy = args['legacy-deploy-slot'] ? Number(args['legacy-deploy-slot']) : LIVE_DEPLOY_SLOT;
  const prog = await readProgram(conn, { full: true });
  if (prog.error) refuse(`program: ${prog.error}`);
  G.check(prog.deploySlot > legacy, 'upgraded binary deployed', `last-deploy slot ${prog.deploySlot} > ${legacy}`, `last-deploy slot ${prog.deploySlot} is not after ${legacy}: S6 has not landed`);
  const exp = elfExpectation(args);
  let so = null;
  if (!exp) (c.mainnet ? G.fail.bind(G) : G.warn.bind(G))('deployed ELF', 'no S2 build to compare with (give --elf, or pin UPGRADED_ELF first)');
  else {
    const got = deployedElfSha(prog.body, exp.bytes);
    G.check(got === exp.sha256, 'deployed ELF = the S2 build', `sha256 ${got} (${exp.from})`, `${got ?? `not ${exp.bytes} B + zeros`}, expected ${exp.sha256} (${exp.from}): STOP, nothing runs (sign-off section 6)`);
    so = prog.body.subarray(0, exp.bytes);
  }
  const idl = await readIdlAccount(conn);
  if (deployKey) {
    G.check(!!prog.authority && prog.authority.equals(deployKey), 'upgrade authority (S6 steps 9-10)', `${b58(prog.authority)} = the DEPLOY_KEY`, `${b58(prog.authority)}, expected the DEPLOY_KEY ${deployKey.toBase58()}`);
    G.check(idl.exists && idl.authority.equals(deployKey), 'IDL authority (S6 step 8)', `${idl.exists ? idl.authority.toBase58() : '-'} = the DEPLOY_KEY`, `${idl.exists ? idl.authority.toBase58() : 'no IDL account'}, expected the DEPLOY_KEY ${deployKey.toBase58()}`);
  } else G.warn('authorities', `upgrade ${b58(prog.authority)}, IDL ${idl.exists ? idl.authority.toBase58() : '-'} (give --deploy-key to check S6 steps 8-10; the pins step needs it)`);
  const idlFile = args.idl || IDL_V3_FILE;
  G.check(idl.exists && !idl.error && sameJson(idl.json, readJson(idlFile)), 'on-chain IDL', `= ${path.basename(idlFile)} (sha256 ${sha256(fs.readFileSync(idlFile)).slice(0, 16)}...), authority ${idl.exists ? idl.authority.toBase58() : '-'}`, `${idl.exists ? 'differs from' : 'missing, expected'} ${path.basename(idlFile)}: the S6 step-7 IDL upgrade is missing`);
  const cfg0 = (await fetchDecoded(conn, dec, P.config))?.value;
  if (!cfg0) refuse('Config does not decode with the v3 IDL');
  const oracle = cfg0.oracle;
  G.info('Config', `oracle ${oracle.toBase58()}, architect ${cfg0.architect.toBase58()}, last epoch ${cfg0.last_epoch}`);
  G.check(cfg0.architect.equals(deployWallet) || cfg0.architect.equals(payee), 'Config.architect', `${cfg0.architect.toBase58()} (${cfg0.architect.equals(payee) ? 'already the payee' : 'the deploy wallet'})`, `${cfg0.architect.toBase58()} is neither the deploy wallet nor the payee: STOP`);
  // key roles (sign-off section 1: the keeper is never the oracle, deploy, cold or payee key; the payee is never the oracle)
  const roles = [['oracle hot key', oracle], ['deploy wallet', deployWallet], ['payee', payee], ['INITIAL_KEEPER', keeper], ['seat cold', seatCold]].filter(([, k]) => k);
  for (let i = 0; i < roles.length; i++) for (let j = i + 1; j < roles.length; j++) {
    if (roles[i][1].equals(roles[j][1])) G.fail('distinct keys', `the ${roles[i][0]} and the ${roles[j][0]} are the same key ${roles[i][1].toBase58()}`);
  }
  if (payee.equals(PublicKey.default)) G.fail('payee', 'the default key');
  if (so) {
    // at S7 too: under F1-b this key stays the only one that can ever create the keeper seat, so the sheet must name it
    if (keeper) G.check(keyChunks(so, keeper) === 4, 'INITIAL_KEEPER compiled in', `${keeper.toBase58()} is in the deployed ELF${later ? '' : ' (kept for the later arm; the only key that can create the seat)'}`, `${keeper.toBase58()} is not the deployed binary's INITIAL_KEEPER: ${later ? 'arm_keeper would fail (OnlyKeeper)' : 'the sheet names another key than the one that can ever create the keeper seat'}`);
    else if (!later) G.warn('INITIAL_KEEPER', 'give --keeper to check that the key the owner keeps is the one compiled in (the only key that can ever create the keeper seat)');
    if (seatCold) G.check(keyChunks(so, seatCold) === 4, 'SEAT_COLD_INITIAL compiled in', `${seatCold.toBase58()} is in the deployed ELF`, `${seatCold.toBase58()} is not in the deployed ELF: init_seat would write another cold key`);
  }
  const sims = await stepOneSimulations(conn, v3, dec, cfg0);
  G.check(sims.initSeat === 'ok' || !!(await conn.getAccountInfo(P.oracleSeat)), 'init_seat simulation (6.3 step 1)', sims.initSeat === 'ok' ? 'ok (not 101)' : 'the seat already exists', sims.initSeat);
  if (sims.owner) {
    G.check(sims.createWar === 'SealedJoinRequired', 'create_war simulation (6.3 step 1)', sims.createWar, `${sims.createWar}, expected SealedJoinRequired`);
    G.check(sims.placeBet === 'KeeperRequired', 'place_bet simulation (6.3 step 1)', sims.placeBet, `${sims.placeBet}, expected KeeperRequired`);
  } else G.warn('create_war / place_bet simulations', 'no PlayerState on chain');
  const kNow = (await fetchDecoded(conn, dec, P.houseKeeper))?.value;
  if (!later) {
    // F1-b: no seat at S7; a seat that exists already was armed outside this plan (only INITIAL_KEEPER can create it)
    if (kNow) G.warn('HouseKeeper (F1-b: not armed at S7)', `exists already: keeper ${kNow.keeper.toBase58()}, bond ${xnt(kNow.bond)}; this run leaves it alone`);
    else G.ok('HouseKeeper (F1-b: not armed at S7)', 'absent: the program takes no house bets and a Jackpot draw refunds every entry, so no bond is exposed');
  } else {
    const t = await conn.getBlockTime(await conn.getSlot('confirmed')).catch(() => null);
    const chainNow = t ?? Math.floor(Date.now() / 1000);
    G.check(continuousSince <= chainNow - CONTINUOUS_MIN_S, 'continuous keeper (--continuous-keeper-since)', `running since ${iso(continuousSince)}, ${((chainNow - continuousSince) / 3600).toFixed(1)} h before the chain time ${iso(chainNow)} (>= 24 h)`,
      `${iso(continuousSince)} is less than 24 h before the chain time ${iso(chainNow)}: arm only once a keeper outside GitHub Actions has run continuously with this key for at least 24 hours (the bond is drainable while no keeper runs)`);
    G.info('service-level week (D-39)', `arming starts it: house games and the Jackpot stay hidden on the site until this keeper has met the published service levels (anchor within 150 slots, reveal within 10 minutes) for 7 days, so no earlier than ${iso(chainNow + SLA_WEEK_S)}, announced in a site release (KEEPER_SLA_MET)`);
  }
  if (G.failed.length) refuse(`preflight failed (${G.failed.map((r) => r.name).join('; ')}): nothing was sent`);

  const roleOf = {
    [deployWallet.toBase58()]: 'deploy wallet', [payee.toBase58()]: 'payee', ...(keeper ? { [keeper.toBase58()]: 'INITIAL_KEEPER' } : {}),
    [P.config.toBase58()]: 'Config', [P.collection.toBase58()]: 'Core collection', [P.rewardVault.toBase58()]: 'reward vault', [P.bankrollVault.toBase58()]: 'bankroll vault',
    [P.oracleSeat.toBase58()]: 'OracleSeat PDA', [P.extraState.toBase58()]: 'ExtraState PDA', [P.extraVault.toBase58()]: 'extra_vault PDA', [P.houseKeeper.toBase58()]: 'HouseKeeper PDA',
    [P.artifactAuthority.toBase58()]: 'artifact authority PDA',
  };
  const results = {};
  let failed = 0;
  const needKey = (kp, what, step) => { if (!kp) refuse(`${step}: --send needs ${what}`); return kp; };
  // one step = plan + simulation + (send + verify); `done()` re-reads the chain
  const doStep = async (name, { done, plan, signers, payer, verify }) => {
    console.log(`\n== ${name}`);
    const d = await done();
    if (d) { console.log(`  done already: ${d}`); results[name] = 'done-before'; return true; }
    const p = await plan();
    if (p.refuse) refuse(`${name}: ${p.refuse}`);
    for (const l of p.notes || []) console.log(`  ${l}`);
    printIxs(p.ixs, roleOf);
    const sim = await simulateIxs(conn, p.simIxs || p.ixs, payer);
    if (p.simIxs) console.log(`  (simulated together with: ${p.simWith})`);
    printSimulation(sim, roleOf);
    if (sim.err) { console.log(`  FAIL ${name}: the simulation fails (${sim.code})${send ? '; nothing sent' : ''}`); results[name] = `simulation ${sim.code}`; failed++; return false; }
    if (!send) { results[name] = 'dry ok'; return true; }
    const r = await sendIxs(conn, p.ixs, signers());
    console.log(`  landed: slot ${r.slot}, block time ${iso(r.blockTime)}, fee ${r.fee} lamports`);
    const v = await verify(r);
    console.log(`  ${v.ok ? 'ok  ' : 'FAIL'} ${v.detail}`);
    results[name] = v.ok ? { sig: r.sig, slot: r.slot, blockTime: r.blockTime } : `verify failed: ${v.detail}`;
    if (!v.ok) failed++;
    return v.ok;
  };
  const cfgNow = async () => (await fetchDecoded(conn, dec, P.config)).value;
  const collectionNow = async () => parseCoreCollection((await conn.getAccountInfo(P.collection, 'confirmed')).data);
  // with --send the first failed step stops the run (a re-run skips what is done); a dry run goes on to show every step
  const stop = () => { if (failed && send) throw new Error(`stopped after a failed step; re-run once fixed (done steps are skipped)`); };

  // ── 6.3 step 3: refresh_collection_uri ───────────────────────────────────────────────────────────────────────────
  const refreshIx = () => idlIx(v3, 'refresh_collection_uri', [
    { name: 'config', pubkey: P.config }, { name: 'collection', pubkey: P.collection, writable: true }, { name: 'artifact_authority', pubkey: P.artifactAuthority },
    { name: 'payer', pubkey: deployWallet, writable: true, signer: true }, { name: 'core_program', pubkey: CORE_ID }, { name: 'system_program', pubkey: SYSTEM_ID },
  ]);
  if (steps.includes('refresh-uri')) {
    await doStep('refresh_collection_uri (6.3 step 3)', {
      done: async () => { const col = await collectionNow(); return args['metadata-base'] && col.uri === `${args['metadata-base']}collection.json` ? `the collection URI is ${col.uri}` : null; },
      plan: async () => ({ ixs: pre([refreshIx()], 300_000), notes: [`the collection URI now: ${(await collectionNow()).uri}; it becomes METADATA_BASE_URI + collection.json (a compile-time constant of the deployed binary)`] }),
      payer: deployWallet, signers: () => [needKey(deployKp, '--deploy-wallet-key', 'refresh-uri')],
      verify: async () => { const u = (await collectionNow()).uri; const ok = !args['metadata-base'] || u === `${args['metadata-base']}collection.json`; return { ok, detail: `collection URI ${u}${args['metadata-base'] ? (ok ? ' = the S2 base + collection.json' : `, expected ${args['metadata-base']}collection.json`) : ''}` }; },
    });
    stop();
  }

  // ── 6.3 steps 4-5: set_architect (deploy wallet + payee), lock_collection_royalties (payee) ──────────────────────
  const setArchIx = () => {
    const ix = idlIx(v3, 'set_architect', [
      { name: 'config', pubkey: P.config, writable: true }, { name: 'architect', pubkey: deployWallet, signer: true },
      { name: 'new_architect', pubkey: payee, signer: true }, { name: 'reward_vault', pubkey: P.rewardVault },
    ], payee.toBuffer());
    ix.args = `new_architect = ${payee.toBase58()}`;
    return ix;
  };
  const lockIx = () => idlIx(v3, 'lock_collection_royalties', [
    { name: 'config', pubkey: P.config }, { name: 'collection', pubkey: P.collection, writable: true }, { name: 'artifact_authority', pubkey: P.artifactAuthority },
    { name: 'architect', pubkey: payee, writable: true, signer: true }, { name: 'core_program', pubkey: CORE_ID }, { name: 'system_program', pubkey: SYSTEM_ID },
  ]);
  if (steps.includes('set-architect')) {
    await doStep('set_architect (6.3 step 4: signed by the deploy wallet and the payee)', {
      done: async () => { const a = (await cfgNow()).architect; return a.equals(payee) ? `Config.architect is the payee ${payee.toBase58()}` : null; },
      plan: async () => {
        const a = (await cfgNow()).architect;
        if (!a.equals(deployWallet)) return { refuse: `Config.architect is ${a.toBase58()}, not the deploy wallet` };
        return { ixs: pre([setArchIx()], 50_000), notes: [`Config.architect ${a.toBase58()} -> ${payee.toBase58()} (the dev share, the house-edge slice and the market fees go to the payee from here on)`, 'fee payer: the deploy wallet; the payee only signs (it needs no balance)'] };
      },
      payer: deployWallet, signers: () => [needKey(deployKp, '--deploy-wallet-key', 'set-architect'), needKey(payeeKp, '--payee-key (from its encrypted folder)', 'set-architect')],
      verify: async () => { const a = (await cfgNow()).architect; return { ok: a.equals(payee), detail: `Config.architect = ${a.toBase58()}` }; },
    });
    stop();
  }
  if (steps.includes('lock-royalties')) {
    await doStep('lock_collection_royalties (6.3 step 5: signed by the payee)', {
      done: async () => {
        const roy = royaltiesOf(await collectionNow());
        if (roy?.authority !== 'None') return null;
        const r = roy.royalties;
        if (r && r.bps === 500 && r.creators.length === 1 && r.creators[0].address.equals(payee) && r.creators[0].percentage === 100) return `Royalties already locked: 500 bps, ${payee.toBase58()} 100%, authority None`;
        refuse(`the Royalties plugin is ALREADY LOCKED to ${r ? r.creators.map((x) => `${x.address.toBase58()} ${x.percentage}%`).join(', ') : '?'}: nothing can change it any more`);
      },
      plan: async () => {
        const a = (await cfgNow()).architect;
        const roy = royaltiesOf(await collectionNow());
        // Core charges the collection's rent difference to the payer of the CPI, the payee (rehearsal 2026-10-25: 6,960
        // lamports, one byte); a fresh payee holds nothing, so the deploy wallet tops it up to 0.001 XNT (the
        // 890,880-lamport rent-exempt minimum of a wallet plus that difference) in the same transaction
        const pb = await balance(conn, payee);
        const fund = pb >= PAYEE_FLOAT ? [] : [(() => { const ix = SystemProgram.transfer({ fromPubkey: deployWallet, toPubkey: payee, lamports: PAYEE_FLOAT - pb }); ix.names = ['from', 'to']; ix.label = `system transfer ${xnt(PAYEE_FLOAT - pb)} from the deploy wallet to the payee`; return ix; })()];
        const notes = [`Royalties now: ${roy?.royalties ? `${roy.royalties.bps} bps, ${roy.royalties.creators.map((x) => `${x.address.toBase58()} ${x.percentage}%`).join(', ')}, authority ${roy.authority}` : 'none'}`,
          `after: 500 bps, ${payee.toBase58()} 100%, rule set None, plugin authority None (permanent)`,
          `fee payer: the deploy wallet; the payee signs and pays the collection's rent difference (payee balance ${xnt(pb)}${fund.length ? `: topped up to ${xnt(PAYEE_FLOAT)} first, in this transaction` : ''})`];
        if (a.equals(payee)) return { ixs: pre([...fund, lockIx()], 300_000), notes };
        if (send) return { refuse: `Config.architect is ${a.toBase58()}, not the OD-22 payee ${payee.toBase58()}: run set-architect first (the lock names config.architect for good)` };
        // dry run before set_architect: simulate both in one transaction to show the pair works from the current state
        return { ixs: pre([...fund, lockIx()], 300_000), simIxs: pre([setArchIx(), ...fund, lockIx()], 350_000), simWith: 'set_architect, which has not run yet', notes };
      },
      payer: deployWallet, signers: () => [needKey(deployKp, '--deploy-wallet-key', 'lock-royalties'), needKey(payeeKp, '--payee-key (from its encrypted folder)', 'lock-royalties')],
      verify: async () => {
        const roy = royaltiesOf(await collectionNow()); const r = roy?.royalties;
        const ok = !!r && roy.authority === 'None' && r.bps === 500 && r.creators.length === 1 && r.creators[0].address.equals(payee) && r.creators[0].percentage === 100 && r.ruleSet === 'None';
        return { ok, detail: `Royalties ${r ? `${r.bps} bps, ${r.creators.map((x) => `${x.address.toBase58()} ${x.percentage}%`).join(', ')}, rule set ${r.ruleSet}` : 'missing'}, plugin authority ${roy?.authority}` };
      },
    });
    stop();
  }

  // ── 6.3 step 6: init_seat ────────────────────────────────────────────────────────────────────────────────────────
  if (steps.includes('init-seat')) {
    const seatCheck = (s) => [seatCold && !s.cold.equals(seatCold) ? `cold ${s.cold.toBase58()} is not ${seatCold.toBase58()}` : null, seatRefund && !s.refund.equals(seatRefund) ? `refund ${s.refund.toBase58()} is not ${seatRefund.toBase58()}` : null].filter(Boolean);
    await doStep('init_seat (6.3 step 6)', {
      done: async () => {
        const s = (await fetchDecoded(conn, dec, P.oracleSeat))?.value;
        if (!s) return null;
        const bad = seatCheck(s);
        if (bad.length) { console.log(`  FAIL the existing seat: ${bad.join('; ')}`); failed++; }
        return `OracleSeat exists: generation ${s.generation}, cold ${s.cold.toBase58()}, refund ${s.refund.toBase58()}, bond ${xnt(s.bond)}`;
      },
      plan: async () => {
        const pool = await freePoolAndBond(conn, await cfgNow());
        const rent = await rentFor(conn, 157);
        const bal = await balance(conn, deployWallet);
        const need = pool.bond + rent + 10_000_000n;
        if (bal < need) return { refuse: `the deploy wallet holds ${xnt(bal)}, the seat needs ${xnt(pool.bond)} bond + ${xnt(rent)} rent + fees` };
        return { ixs: pre([idlIx(v3, 'init_seat', [{ name: 'config', pubkey: P.config }, { name: 'seat', pubkey: P.oracleSeat, writable: true }, { name: 'reward_vault', pubkey: P.rewardVault }, { name: 'payer', pubkey: deployWallet, writable: true, signer: true }, { name: 'system_program', pubkey: SYSTEM_ID }])], 50_000),
          notes: [`free pool ${xnt(pool.free)} -> bond ${xnt(pool.bond)} = max(1 XNT, 10% of free) + OracleSeat rent ${xnt(rent)} (157 B), paid by the deploy wallet (balance ${xnt(bal)})`, `the seat gets the compiled-in cold key${seatCold ? ` (expected ${seatCold.toBase58()})` : ''} and refund key${seatRefund ? ` (expected ${seatRefund.toBase58()})` : ''}; the bond returns on a graceful resign to the refund key`] };
      },
      payer: deployWallet, signers: () => [needKey(deployKp, '--deploy-wallet-key', 'init-seat')],
      verify: async () => { const s = (await fetchDecoded(conn, dec, P.oracleSeat))?.value; if (!s) return { ok: false, detail: 'OracleSeat missing' }; const bad = seatCheck(s); return { ok: !bad.length, detail: `OracleSeat generation ${s.generation}, cold ${s.cold.toBase58()}, refund ${s.refund.toBase58()}, bond ${xnt(s.bond)}${bad.length ? `: ${bad.join('; ')}` : ''}` }; },
    });
    stop();
  }

  // ── 6.3 step 7: init_extra (before any forge is announced; its block time is the OD-9 boundary) ──────────────────
  if (steps.includes('init-extra')) {
    await doStep('init_extra (6.3 step 7)', {
      done: async () => ((await conn.getAccountInfo(P.extraState)) ? 'ExtraState exists' : null),
      plan: async () => {
        const r1 = await rentFor(conn, 90), r0 = await rentFor(conn, 8);
        return { ixs: pre([idlIx(v3, 'init_extra', [{ name: 'config', pubkey: P.config }, { name: 'extra_state', pubkey: P.extraState, writable: true }, { name: 'extra_vault', pubkey: P.extraVault, writable: true }, { name: 'payer', pubkey: deployWallet, writable: true, signer: true }, { name: 'system_program', pubkey: SYSTEM_ID }])], 60_000),
          notes: [`rents: ExtraState ${xnt(r1)} (90 B) + extra_vault ${xnt(r0)} (8 B), paid by the deploy wallet`, 'the block time of this transaction is the OD-9 boundary: Artifacts forged before it are pre-upgrade'] };
      },
      payer: deployWallet, signers: () => [needKey(deployKp, '--deploy-wallet-key', 'init-extra')],
      verify: async (r) => { const x = await conn.getAccountInfo(P.extraState); const v = await conn.getAccountInfo(P.extraVault); return { ok: !!x && !!v, detail: `ExtraState ${x ? `${x.data.length} B` : 'missing'}, extra_vault ${v ? xnt(v.lamports) : 'missing'}; OD-9 boundary (pool.init): tx ${r.sig}, block time ${r.blockTime} (${iso(r.blockTime)})` }; },
    });
    stop();
  }

  // ── LATER (never at S7, F1-b): arm_keeper by INITIAL_KEEPER, through the oracle's keeper-arm ──────────────────────
  if (later && steps.includes('arm-keeper')) {
    console.log('\n== arm_keeper (LATER, not at S7: INITIAL_KEEPER, through the oracle\'s keeper-arm)');
    const k = (await fetchDecoded(conn, dec, P.houseKeeper))?.value;
    if (k && k.keeper.equals(keeper) && big(k.length) > 0n) {
      console.log(`  done already: HouseKeeper armed by ${k.keeper.toBase58()}, chain ${k.length}, bond ${xnt(k.bond)}`);
      // also after a run whose confirmation timed out although the arm landed (re-run): the week counts from the arm
      const at = (await conn.getBlockTime(Number(k.armed_slot)).catch(() => null));
      if (at) console.log(`  service-level week (D-39): from ${iso(at)} (the arm); the site lists house games and the Jackpot no earlier than ${iso(at + SLA_WEEK_S)}, and only after 7 days of the published service levels, in a site release (KEEPER_SLA_MET)`);
      if (big(k.bond) < KEEPER_BOND_MIN) { console.log(`  FAIL the bond ${xnt(k.bond)} is below ${xnt(KEEPER_BOND_MIN)}`); failed++; }
      results.armKeeper = 'done-before';
    } else if (k && !k.keeper.equals(keeper)) {
      refuse(`the HouseKeeper seat is held by ${k.keeper.toBase58()}, not INITIAL_KEEPER ${keeper.toBase58()}`);
    } else {
      const bal = await balance(conn, keeper);
      const rent = await rentFor(conn, 213);
      console.log(`  keeper ${keeper.toBase58()}: balance ${xnt(bal)}; bond ${xnt(deposit)} + HouseKeeper rent ${xnt(rent)} + fees`);
      if (bal < deposit + rent + 10_000_000n) refuse(`INITIAL_KEEPER holds ${xnt(bal)}, below the bond ${xnt(deposit)} + rent + fees (fund it on the later day with the bond + 0.1 XNT; nothing of this is funded at S7, sign-off section 3)`);
      // our own simulation first, with a placeholder chain (the real tip is derived by the oracle from the key)
      const tip = crypto.createHash('sha256').update('moon-forge s7 dry-run placeholder tip').digest();
      const ix = idlIx(v3, 'arm_keeper', [
        { name: 'config', pubkey: P.config, writable: true }, { name: 'keeper_seat', pubkey: P.houseKeeper, writable: true }, { name: 'keeper', pubkey: keeper, writable: true, signer: true },
        { name: 'bankroll_vault', pubkey: P.bankrollVault, writable: true }, { name: 'reward_vault', pubkey: P.rewardVault, writable: true }, { name: 'system_program', pubkey: SYSTEM_ID },
      ], Buffer.concat([tip, le64(1_000_000), le64(deposit)]));
      ix.args = `tip = (placeholder in this simulation; the oracle derives the real one), length 1000000, deposit ${xnt(deposit)}`;
      printIxs([ix], roleOf);
      const sim = await simulateIxs(conn, [ix], keeper);
      printSimulation(sim, roleOf);
      if (sim.err) { console.log(`  FAIL arm_keeper simulation: ${sim.code}`); failed++; results.armKeeper = `simulation ${sim.code}`; }
      else if (!keeperKp) {
        if (send) refuse('arm-keeper: --send needs --keeper-key');
        console.log('  dry: no --keeper-key, so the oracle\'s own plan (the derived chain) is not shown');
        results.armKeeper = 'dry ok (placeholder chain)';
      } else {
        const seatsReady = !!(await conn.getAccountInfo(P.oracleSeat)) && !!(await conn.getAccountInfo(P.extraState));
        if (!seatsReady && !send) {
          console.log('  dry: the oracle\'s keeper-arm needs OracleSeat and ExtraState (its upgrade verdict): shown once init-seat and init-extra have run');
          results.armKeeper = 'dry ok (placeholder chain)';
        } else {
          const code = oracleKeeperArm(c.rpc, keeperKp, deposit, send, !!args['localnet-oracle']);
          if (code !== 0) { console.log(`  FAIL the oracle's keeper-arm exited ${code}`); failed++; results.armKeeper = `oracle exit ${code}`; }
          else if (send) {
            const k2 = (await fetchDecoded(conn, dec, P.houseKeeper))?.value;
            const ok = !!k2 && k2.keeper.equals(keeper) && big(k2.length) > 0n && big(k2.bond) >= KEEPER_BOND_MIN;
            console.log(`  ${ok ? 'ok  ' : 'FAIL'} HouseKeeper ${k2 ? `keeper ${k2.keeper.toBase58()}, chain ${k2.length} armed at slot ${k2.armed_slot}, bond ${xnt(k2.bond)}` : 'missing'}`);
            if (!ok) failed++;
            if (ok) {
              const at = (await conn.getBlockTime(Number(k2.armed_slot)).catch(() => null)) ?? Math.floor(Date.now() / 1000);
              console.log(`  service-level week (D-39): from ${iso(at)}; the site lists house games and the Jackpot no earlier than ${iso(at + SLA_WEEK_S)}, and only after 7 days of the published service levels, in a site release (KEEPER_SLA_MET)`);
            }
            results.armKeeper = ok ? 'sent' : 'verify failed';
          } else results.armKeeper = 'dry ok (oracle plan shown)';
        }
      }
    }
    stop();
  }

  // ── health pins ──────────────────────────────────────────────────────────────────────────────────────────────────
  if (steps.includes('pins')) {
    // S7: architect + seat keys (the keeper pin stays unpinned: no HouseKeeper, F1-b); later: the keeper pin only
    const stage = later ? 'keeper' : 's7';
    console.log(`\n== health pins (oracle/src/health-pins.json, stage ${stage})`);
    const want = later ? { keeper } : { deployKey, payee, seatCold, seatRefund, keeper };
    if (send) {
      const n = await applyPins(conn, stage, want, { file: args.pins || PINS_FILE, write: true });
      if (n) failed++;
    } else {
      const ready = later ? !!(await conn.getAccountInfo(P.houseKeeper)) : !!(await conn.getAccountInfo(P.oracleSeat)) && (await cfgNow()).architect.equals(payee);
      if (!ready) console.log(later ? `  dry: after arm_keeper the pin becomes keeperSeat ${b58(keeper)}; checked against the chain once it has run`
        : `  dry: after the steps above the pins become architect ${payee.toBase58()}, seatCold ${b58(seatCold)}, seatRefund ${b58(seatRefund)} (upgrade / IDL authority ${b58(deployKey)}); keeperSeat stays unpinned (no HouseKeeper at S7, F1-b); checked against the chain once the steps have run`);
      else await applyPins(conn, stage, want, { file: args.pins || PINS_FILE, write: false });
    }
  }

  const what = later ? 'house keeper arm (later step)' : 'S7 first run';
  console.log(`\n${what}: ${failed ? `${failed} step(s) FAILED` : send ? 'every step done' : 'dry run green (nothing was signed or sent)'}`);
  for (const [k, v] of Object.entries(results)) console.log(`  ${k}: ${typeof v === 'string' ? v : `${v.sig} (slot ${v.slot})`}`);
  if (!failed && !later) {
    console.log('arm-keeper: not at S7 (F1-b): no keeper bond posted; house games and the Jackpot stay hidden on the site (D-39).');
    console.log('next (sign-off section 5, in this order): `node scripts/upgrade/census.mjs --stage s7 ...` green (it expects no HouseKeeper);');
    console.log('  `npm run keeper -- --once` in oracle/ shows the role "no-seat"; KEEPER_ENABLED back on; the site constants S7_PROGRAM_TAG /');
    console.log('  S7_VALID_FROM and the regenerated discoverability files; house games and the Jackpot stay hidden (D-39, KEEPER_SLA_MET false).');
  } else if (!failed && later && send) {
    console.log('next: `npm run keeper -- --once` in oracle/ on the continuous keeper shows the role "holder" (R-4); `node scripts/upgrade/census.mjs');
    console.log('  --stage s7|s9 --keeper-armed ...` green; the site stays as it is until the service-level week is met and announced (D-39).');
  }
  return failed ? 1 : 0;
}

/**
 * The oracle's `keeper-arm` in a child process (cwd oracle/), so the chain is exactly what every keeper run derives
 * from this key (keeper-v3.ts chainKeyOf / chainSeed). The key reaches the child only through its environment, as
 * the keeper workflow passes it; X1_RPC_URLS is cleared so every read goes to the given endpoint.
 */
function oracleKeeperArm(rpc, kp, deposit, yes, localnet) {
  const oracleDir = path.join(ROOT, 'oracle');
  const env = { ...process.env, X1_RPC_URL: rpc, KEEPER_PRIVATE_KEY: JSON.stringify(Array.from(kp.secretKey)) };
  delete env.X1_RPC_URLS; delete env.ORACLE_PRIVATE_KEY;
  const dep = `${deposit / XNT}.${(deposit % XNT).toString().padStart(9, '0')}`;
  const cmd = ['src/index.ts', 'keeper-arm', '--deposit', dep, ...(yes ? ['--yes'] : [])];
  let pre;
  if (localnet) { env.E2E_LOCALNET = '1'; env.E2E_ORACLE_DIR = oracleDir; pre = path.join(ROOT, 'tests/e2e-oracle/preload.cjs'); }
  else pre = createRequire(path.join(oracleDir, 'package.json')).resolve('ts-node/register/transpile-only');
  console.log(`  running the oracle: keeper-arm --deposit ${dep}${yes ? ' --yes' : ' (its dry plan)'}${localnet ? ' (localnet time profile)' : ''}`);
  const r = spawnSync(process.execPath, ['-r', pre, ...cmd], { cwd: oracleDir, env, stdio: ['ignore', 'inherit', 'inherit'] });
  env.KEEPER_PRIVATE_KEY = '';
  return r.status ?? 1;
}

run(main);
