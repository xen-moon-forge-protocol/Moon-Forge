#!/usr/bin/env node
// S9, the freeze (SPEC-UPGRADE-v2 9.1 S9; signed by the DEPLOY_KEY): ONE transaction with
//   [0] anchor IDL SetAuthority(11111111111111111111111111111111)   = `anchor idl erase-authority`
//   [1] loader SetAuthority(none)                                   = `solana program set-upgrade-authority --final`
// so both powers end together or neither does. After it nothing can change the program or its IDL, ever.
// Checks before (all must be green; any red refuses before anything is signed):
//   the date is not before --not-before (S7 + 14 stable days; default 2026-12-02 00:00 UTC);
//   the program is the S6 deploy (--expect-deploy-slot) and its ELF is the pinned S2 build;
//   both authorities are the DEPLOY_KEY (= the key file);
//   the IDL on chain equals the final IDL file (if the docs changed, run `anchor idl upgrade` first: the command is printed);
//   the S7 accounts exist (OracleSeat, ExtraState) and Config.architect is the pinned payee. The HouseKeeper is only
//   reported: under F1-b it is not armed at S7, and the freeze does not change who can arm it later (arm_keeper needs
//   no upgrade authority; INITIAL_KEEPER is the only key that can create the seat until 2026-12-16 00:00 UTC, anyone with a bond of at least 20 XNT from then).
// DRY RUN by default (the freeze transaction is simulated without signatures). --send signs with the DEPLOY_KEY file;
// on X1 mainnet it also needs --mainnet. Then the health pins move to "none" / erased (--pins, written only after a
// verified freeze). Exit 0 = green / frozen, 1 = a check failed, 2 = usage, 3 = refused.
import fs from 'fs';
import path from 'path';
import {
  web3, P, MAINNET_RPC, ERASED, LIVE_DEPLOY_SLOT, IDL_V3_FILE, PINS_FILE, LOADER_ID, parseArgs, pubkeyArg, loadKeyFile, matchKey, connectTo, sendMode, header,
  iso, b58, Gates, loadIdl, makeDecoder, readJson, sameJson, sha256, readProgram, deployedElfSha, readIdlAccount, fetchDecoded, readPinsFile,
  loaderSetAuthorityIx, idlSetAuthorityIx, cuLimit, printIxs, simulateIxs, printSimulation, sendIxs, elfExpectation, balance, xnt, refuse, run, anchor,
} from './lib.mjs';
import { applyPins } from './pins.mjs';

const USAGE = `usage: node scripts/upgrade/s9.mjs --deploy-key <pubkey> --expect-deploy-slot <n> [options]   (dry run unless --send)
  --rpc <url>                default ${MAINNET_RPC}
  --deploy-key <pubkey>      OD-32 DEPLOY_KEY (the upgrade + IDL authority since S6)
  --deploy-key-file <file>   its key file, from its encrypted folder (needed to send)
  --expect-deploy-slot <n>   the S6 deploy slot (sign-off sheet "S6 completed")
  --elf <file> | --elf-sha <hex> --elf-bytes <n>   the S2 build (default: the UPGRADED_ELF pin of oracle/src/x1-v3.ts)
  --pin-file <file>          where to read the UPGRADED_ELF pin (default oracle/src/x1-v3.ts)
  --idl <file>               the final IDL that must be on chain (default oracle/src/idl/moon_forge.v3.json)
  --not-before <ISO time>    earliest freeze (default 2026-12-02T00:00:00Z: S7 + 14 stable days)
  --not-after <ISO time>     the "no later than" date (default 2026-12-31T23:59:59Z): later only warns
  --pins <file>              default oracle/src/health-pins.json (written only after a verified freeze)
  --send                     sign and send the freeze (else dry run)
  --mainnet                  required together with --send on X1 mainnet`;
const args = parseArgs(process.argv.slice(2), {
  rpc: 'string', 'deploy-key': 'string', 'deploy-key-file': 'string', 'expect-deploy-slot': 'string', elf: 'string', 'elf-sha': 'string',
  'elf-bytes': 'string', 'pin-file': 'string', idl: 'string', 'not-before': 'string', 'not-after': 'string', pins: 'string', send: 'bool', mainnet: 'bool',
}, USAGE);

async function main() {
  const c = await connectTo(args.rpc || MAINNET_RPC);
  const { conn } = c;
  const send = sendMode(args, c);
  header('Moon Forge S9: the freeze (IDL authority erased + upgrade authority none, one transaction)', c, send);
  const deployKey = pubkeyArg(args['deploy-key'], '--deploy-key');
  if (!deployKey) refuse('--deploy-key <pubkey> is required (OD-32, sign-off section 1)');
  const kp = matchKey(loadKeyFile(args['deploy-key-file'], '--deploy-key-file'), deployKey, '--deploy-key-file');
  if (send && !kp) refuse('--send needs --deploy-key-file (the DEPLOY_KEY file, from its encrypted folder)');
  const G = new Gates();
  console.log('\nchecks before the freeze (read-only)');

  // date
  const notBefore = Date.parse(args['not-before'] || '2026-12-02T00:00:00Z');
  const notAfter = Date.parse(args['not-after'] || '2026-12-31T23:59:59Z');
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) refuse('--not-before / --not-after must be ISO times');
  const slot = await conn.getSlot('confirmed');
  const chainNow = (await conn.getBlockTime(slot).catch(() => null)) ?? Math.floor(Date.now() / 1000);
  G.check(chainNow * 1000 >= notBefore, 'date', `chain time ${iso(chainNow)} >= ${new Date(notBefore).toISOString()}`, `chain time ${iso(chainNow)} is before ${new Date(notBefore).toISOString()} (S7 + 14 stable days)`);
  if (chainNow * 1000 > notAfter) G.warn('no-later-than date', `${iso(chainNow)} is after ${new Date(notAfter).toISOString()}: the owner burns as is or publishes a dated plan (X-164)`);

  // program + ELF
  const prog = await readProgram(conn, { full: true });
  if (prog.error) refuse(`program: ${prog.error}`);
  const frozen = prog.authority === null;
  const idl = await readIdlAccount(conn);
  const erased = idl.exists && idl.authority.toBase58() === ERASED;
  if (frozen && erased) {
    console.log(`  the program is already frozen: upgrade authority none, IDL authority ${ERASED}; nothing to send`);
    if (send) {
      const n = await applyPins(conn, 's9', {}, { file: args.pins || PINS_FILE, write: true });
      return n ? 1 : 0;
    }
    return 0;
  }
  if (frozen !== erased) G.fail('half-frozen', `upgrade authority ${b58(prog.authority)}, IDL authority ${idl.exists ? idl.authority.toBase58() : '-'}: only one power is gone (this tool always sends both together); finish with the CLI for the other one`);
  const expSlot = args['expect-deploy-slot'] ? Number(args['expect-deploy-slot']) : null;
  if (expSlot === null) G.fail('S6 deploy slot', `${prog.deploySlot}; --expect-deploy-slot (the sign-off "S6 completed" slot) is required`);
  else G.check(prog.deploySlot === expSlot, 'S6 deploy slot', `last-deploy slot ${prog.deploySlot} = the S6 deploy`, `last-deploy slot ${prog.deploySlot}, expected ${expSlot}: the program was deployed again since S6`);
  if (prog.deploySlot <= LIVE_DEPLOY_SLOT && c.mainnet) G.fail('upgraded binary', `last-deploy slot ${prog.deploySlot}: the live binary is still the v2 one`);
  const exp = elfExpectation(args);
  if (!exp) G.fail('deployed ELF', 'no S2 build to compare with (pin UPGRADED_ELF or give --elf)');
  else { const got = deployedElfSha(prog.body, exp.bytes); G.check(got === exp.sha256, 'deployed ELF = the S2 build', `sha256 ${got} (${exp.from})`, `${got ?? `not ${exp.bytes} B + zeros`}, expected ${exp.sha256} (${exp.from})`); }
  G.check(!!prog.authority && prog.authority.equals(deployKey), 'upgrade authority', `${b58(prog.authority)} = the DEPLOY_KEY`, `${b58(prog.authority)}, expected the DEPLOY_KEY ${deployKey.toBase58()}`);

  // IDL
  const idlFile = args.idl || IDL_V3_FILE;
  if (!idl.exists) G.fail('IDL account', `${idl.address.toBase58()} missing`);
  else {
    G.check(idl.authority.equals(deployKey), 'IDL authority', `${idl.authority.toBase58()} = the DEPLOY_KEY`, `${idl.authority.toBase58()}, expected the DEPLOY_KEY ${deployKey.toBase58()}`);
    const same = !idl.error && sameJson(idl.json, readJson(idlFile));
    G.check(same, 'on-chain IDL = the final IDL', `${path.basename(idlFile)} (sha256 ${sha256(fs.readFileSync(idlFile))})`, `differs from ${path.basename(idlFile)}: upgrade it first, then re-run:\n         anchor idl upgrade --filepath ${idlFile} 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 --provider.cluster ${c.rpc} --provider.wallet <DEPLOY_KEY file>`);
  }

  // S7 state
  const dec = makeDecoder(loadIdl(IDL_V3_FILE));
  const [seat, extra, keeper] = await conn.getMultipleAccountsInfo([P.oracleSeat, P.extraState, P.houseKeeper], 'confirmed');
  G.check(!!seat && !!extra, 'S7 accounts', 'OracleSeat and ExtraState exist', `missing: ${[!seat && 'OracleSeat', !extra && 'ExtraState'].filter(Boolean).join(', ')}`);
  G.info('HouseKeeper', keeper ? 'exists (armed by INITIAL_KEEPER after S7)' : 'absent: not armed (F1-b); INITIAL_KEEPER can create it until 2026-12-16 00:00 UTC and anyone with a bond of at least 20 XNT from then (KEEPER_OPEN_TS; arm_keeper needs no upgrade authority)');
  const cfg = (await fetchDecoded(conn, dec, P.config))?.value;
  const pins = readPinsFile(args.pins || PINS_FILE).json;
  if (cfg && pins.architect) G.check(cfg.architect.toBase58() === pins.architect, 'Config.architect = the pinned payee', cfg.architect.toBase58(), `${cfg.architect.toBase58()}, pinned ${pins.architect}`);
  else G.warn('Config.architect', `${cfg ? cfg.architect.toBase58() : 'unreadable'} (no architect pin to compare)`);
  // leftover deploy buffers keep their rent; they stay closable by their own authority after the freeze
  try {
    const bufs = await conn.getProgramAccounts(LOADER_ID, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 0, bytes: anchor.utils.bytes.bs58.encode(Buffer.from([1, 0, 0, 0, 1])) } }, { memcmp: { offset: 5, bytes: deployKey.toBase58() } }] });
    if (bufs.length) G.warn('buffers of the DEPLOY_KEY', `${bufs.length} left (${bufs.map((b) => b.pubkey.toBase58()).join(', ')}): \`solana program close <BUF>\` returns their rent`); else G.ok('buffers of the DEPLOY_KEY', 'none left');
  } catch (e) { G.info('buffers of the DEPLOY_KEY', `not listed by this RPC (${String(e.message || e).slice(0, 80)})`); }
  G.info('manual', 'the S8 proof plan done and 14 stable days of health green; the owner signs the S9 sheet; SECURITY.md / IMMUTABILITY.md get the hashes after');

  // the freeze transaction
  console.log('\nthe freeze transaction (fee payer: the DEPLOY_KEY)');
  const bal = await balance(conn, deployKey);
  console.log(`  DEPLOY_KEY ${deployKey.toBase58()} balance ${xnt(bal)}`);
  const ixs = [cuLimit(40_000), await idlSetAuthorityIx(deployKey, ERASED), loaderSetAuthorityIx(deployKey, null)];
  const roles = { [deployKey.toBase58()]: 'DEPLOY_KEY', [prog.programData.toBase58()]: 'ProgramData', [idl.address.toBase58()]: 'IDL account' };
  printIxs(ixs, roles);
  const sim = await simulateIxs(conn, ixs, deployKey);
  printSimulation(sim, roles);
  G.check(!sim.err, 'freeze simulation', `ok (${sim.units} compute units)`, sim.code);
  if (G.failed.length) { console.log(`\nS9: ${G.failed.length} check(s) red: nothing ${send ? 'sent' : 'would be sent'}`); for (const r of G.failed) console.log(`  FAIL ${r.name}: ${r.detail}`); return send ? refuse('checks red') : 1; }
  if (!send) { console.log('\nS9 dry run green: nothing was signed or sent (add --send, and --mainnet on X1 mainnet)'); return 0; }

  const r = await sendIxs(conn, ixs, [kp]);
  console.log(`  landed: slot ${r.slot}, block time ${iso(r.blockTime)}, fee ${r.fee} lamports`);
  const p2 = await readProgram(conn);
  const i2 = await readIdlAccount(conn);
  const ok = p2.authority === null && i2.exists && i2.authority.toBase58() === ERASED;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} upgrade authority ${b58(p2.authority)}, IDL authority ${i2.exists ? i2.authority.toBase58() : '-'}`);
  if (!ok) return 1;
  console.log(`  independent checks: solana program show 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 -u ${c.rpc}   (Authority: none)`);
  console.log(`                      anchor idl authority 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 --provider.cluster ${c.rpc}   (${ERASED})`);
  console.log(`  for SECURITY.md / IMMUTABILITY.md: frozen in transaction ${r.sig} (slot ${r.slot}, ${iso(r.blockTime)}); deployed ELF sha256 ${exp.sha256} (${exp.bytes} B), last-deploy slot ${prog.deploySlot}`);
  const n = await applyPins(conn, 's9', {}, { file: args.pins || PINS_FILE, write: true });
  return n ? 1 : 0;
}

run(main);
