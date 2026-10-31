#!/usr/bin/env node
// The health-pins update (oracle/src/health-pins.json) at each key change of the upgrade: S6 step 11, S7, S9. A pin is
// what the daily health check expects on chain; a pin that differs from the chain is red, so a pin is only ever set
// to a key that BOTH the chain shows AND the sign-off sheet names (the flag). It never sends anything; it writes the
// file only with --write (a reviewed commit, the same session as the change, FORGOTTEN §1-G).
//   s6      upgradeAuthority, idlAuthority = the DEPLOY_KEY
//   s7      + architect = the payee, seatCold, seatRefund (OracleSeat); keeperSeat only if a HouseKeeper exists: under
//           F1-b the house keeper is not armed at S7, so keeperSeat stays unpinned ("") and health reads "no keeper seat yet"
//   s9      upgradeAuthority = null (none), idlAuthority = 11111111111111111111111111111111 (erased)
//   keeper  keeperSeat (HouseKeeper.keeper) only: the later arm by INITIAL_KEEPER (s7.mjs --arm-keeper), before or after S9
import path from 'path';
import { pathToFileURL } from 'url';
import {
  MAINNET_RPC, ERASED, PINS_FILE, P, PIN_KEYS, parseArgs, pubkeyArg, connectTo, describeCluster, readProgram, readIdlAccount,
  loadIdl, makeDecoder, IDL_V3_FILE, fetchDecoded, readPinsFile, writePinsFile, refuse, run, b58,
} from './lib.mjs';

/**
 * Reads the chain and returns the pins of `stage`. `want` holds the sign-off keys (PublicKey or null). Every pin that
 * the stage sets must equal both the chain and the sign-off key, else it lands in `errors` and nothing may be written.
 */
export async function planPins(conn, stage, want) {
  const prog = await readProgram(conn);
  const idl = await readIdlAccount(conn);
  const dec = makeDecoder(loadIdl(IDL_V3_FILE));
  const chain = {
    upgradeAuthority: prog.error ? undefined : (prog.authority ? prog.authority.toBase58() : null),
    idlAuthority: idl.exists ? idl.authority.toBase58() : undefined,
  };
  const cfg = (await fetchDecoded(conn, dec, P.config))?.value;
  if (cfg) chain.architect = cfg.architect.toBase58();
  const seat = (await fetchDecoded(conn, dec, P.oracleSeat))?.value;
  if (seat) { chain.seatCold = seat.cold.toBase58(); chain.seatRefund = seat.refund.toBase58(); }
  const keeper = (await fetchDecoded(conn, dec, P.houseKeeper))?.value;
  if (keeper) chain.keeperSeat = keeper.keeper.toBase58();
  const set = {};
  const errors = [];
  const pin = (k, expected, what) => {
    const on = chain[k];
    if (on === undefined) return void errors.push(`${k}: not readable on chain (${what})`);
    if (expected === undefined) return void errors.push(`${k}: the sign-off key is required (${what})`);
    if (on !== expected) return void errors.push(`${k}: the chain shows ${b58(on)}, the sign-off sheet says ${b58(expected)} (${what})`);
    set[k] = expected;
  };
  const s = (k) => (want[k] ? want[k].toBase58() : undefined);
  if (stage === 's6' || stage === 's7') {
    pin('upgradeAuthority', s('deployKey'), '--deploy-key');
    pin('idlAuthority', s('deployKey'), '--deploy-key');
  }
  const notes = [];
  if (stage === 's7') {
    pin('architect', s('payee'), '--payee');
    pin('seatCold', s('seatCold'), '--seat-cold');
    pin('seatRefund', s('seatRefund'), '--seat-refund');
    if (chain.keeperSeat !== undefined) pin('keeperSeat', s('keeper'), '--keeper');
    else notes.push('keeperSeat: no HouseKeeper on chain (not armed at S7, F1-b): left as it is; pinned by the later arm (--stage keeper)');
  }
  if (stage === 'keeper') pin('keeperSeat', s('keeper'), '--keeper (the later arm by INITIAL_KEEPER)');
  if (stage === 's9') {
    pin('upgradeAuthority', null, 'frozen: no upgrade authority');
    pin('idlAuthority', ERASED, 'erased IDL authority');
  }
  return { chain, set, errors, notes };
}

/** Prints the change and writes it when asked; returns the number of errors. */
export async function applyPins(conn, stage, want, { file = PINS_FILE, write = false, log = console.log } = {}) {
  const { chain, set, errors, notes } = await planPins(conn, stage, want);
  const cur = readPinsFile(file);
  const next = { ...cur.json };
  for (const [k, v] of Object.entries(set)) next[k] = v;
  log(`  health pins (${path.basename(file)}), stage ${stage}:`);
  for (const k of PIN_KEYS) {
    const a = cur.json[k], b = next[k];
    const tag = a === b ? 'same' : 'SET ';
    log(`    ${tag} ${k.padEnd(17)} ${JSON.stringify(a)}${a === b ? '' : ` -> ${JSON.stringify(b)}`}   (chain: ${chain[k] === undefined ? 'n/a' : JSON.stringify(chain[k])})`);
  }
  for (const n of notes) log(`    note  ${n}`);
  for (const e of errors) log(`    ERROR ${e}`);
  if (errors.length) { log('    nothing written: fix the errors first'); return errors.length; }
  const changed = PIN_KEYS.some((k) => cur.json[k] !== next[k]);
  if (!changed) log('    the file already holds these pins');
  else if (write) { writePinsFile(file, cur, next); log(`    written ${file}: commit it in a reviewed commit in this same session`); }
  else log('    dry: nothing written (add --write; the pins move only in a reviewed commit made in the same session as the change)');
  return 0;
}

const USAGE = `usage: node scripts/upgrade/pins.mjs --stage s6|s7|s9|keeper [--rpc <url>] [--pins <file>] [--write]
  --deploy-key <pubkey>   s6, s7: the OD-32 DEPLOY_KEY (upgrade + IDL authority)
  --payee <pubkey>        s7: the OD-22 payee (Config.architect)
  --seat-cold <pubkey>    s7: OD-16       --seat-refund <pubkey>  s7: OD-20
  --keeper <pubkey>       keeper (and s7 if a HouseKeeper exists): OD-25 INITIAL_KEEPER; under F1-b no HouseKeeper exists
                          at S7, so the keeper pin is set by --stage keeper after the later arm
  --pins <file>           default oracle/src/health-pins.json
  --write                 write the file (else print the change only)`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2), { stage: 'string', rpc: 'string', pins: 'string', write: 'bool', 'deploy-key': 'string', payee: 'string', 'seat-cold': 'string', 'seat-refund': 'string', keeper: 'string' }, USAGE);
  run(async () => {
    if (!['s6', 's7', 's9', 'keeper'].includes(args.stage)) refuse('--stage must be s6, s7, s9 or keeper');
    const c = await connectTo(args.rpc || MAINNET_RPC);
    console.log(`health pins, stage ${args.stage}, on ${describeCluster(c)} (reads only; never sends)`);
    const want = { deployKey: pubkeyArg(args['deploy-key'], '--deploy-key'), payee: pubkeyArg(args.payee, '--payee'), seatCold: pubkeyArg(args['seat-cold'], '--seat-cold'), seatRefund: pubkeyArg(args['seat-refund'], '--seat-refund'), keeper: pubkeyArg(args.keeper, '--keeper') };
    return (await applyPins(c.conn, args.stage, want, { file: args.pins || PINS_FILE, write: !!args.write })) ? 1 : 0;
  });
}
