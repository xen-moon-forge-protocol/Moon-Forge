#!/usr/bin/env node
// UPGRADED_ELF pin helper (R-7, sign-off section 2; FORGOTTEN §4 step 17). The oracle and keeper treat the program as
// "upgraded" only when the deployed ELF hashes to the pinned S2 build (oracle/src/x1-v3.ts UPGRADED_ELF); until the
// pin is set, a rollback to another binary would still read as upgraded. This tool:
//   - hashes the S2 build (sha256 of the file, its byte length, and the zero-stripped executable hash);
//   - checks it against the published S2 hash (--expect-sha) and refuses a --features localnet build for the real pin;
//   - with --rpc, checks the deployed ProgramData against it (the x1-v3.ts deployedElfV3 rule);
//   - prints the exact line for oracle/src/x1-v3.ts, and writes it only with --write (a reviewed commit between the
//     published hash, Mon 11-23 16:00 UTC, and S7);
//   - --check: reads the pin that is in the file and checks it against the build (and the chain with --rpc).
// It never sends a transaction.
import fs from 'fs';
import path from 'path';
import {
  X1V3_FILE, MAINNET_ORACLE, LOCALNET_ORACLE, LIVE_DEPLOY_SLOT, parseArgs, connectTo, describeCluster, readProgram, deployedElfSha,
  sha256, zeroStrippedSha, keyChunks, PIN_RE, PIN_NULL_LINE, pinLine, readPin, refuse, run,
} from './lib.mjs';

const USAGE = `usage: node scripts/upgrade/pin-elf.mjs --elf <target/deploy/moon_forge.so> [options]
  --expect-sha <hex>   the S2 hash published at least 48 h before S6: the file sha256 must equal it
  --rpc <url>          also compare the deployed ProgramData of the program with the build (read-only)
  --file <x1-v3.ts>    the file holding the pin (default oracle/src/x1-v3.ts)
  --check              compare the pin already in --file with the build (exit 1 when it differs)
  --write              write the pin line into --file (else print it only)
  --allow-localnet     accept a --features localnet build (rehearsals only; never for the real pin)
  --legacy-deploy-slot <n>  the live v2 binary's deploy slot (default ${LIVE_DEPLOY_SLOT})`;
const args = parseArgs(process.argv.slice(2), { elf: 'string', 'expect-sha': 'string', rpc: 'string', file: 'string', check: 'bool', write: 'bool', 'allow-localnet': 'bool', 'legacy-deploy-slot': 'string' }, USAGE);

run(async () => {
  if (!args.elf) refuse('--elf <file> is required (the S2 build, target/deploy/moon_forge.so)');
  if (args.check && args.write) refuse('--check and --write together: check first, then write');
  const file = args.file || X1V3_FILE;
  const so = fs.readFileSync(args.elf);
  const sha = sha256(so);
  const exec = zeroStrippedSha(so);
  let bad = 0;
  console.log('UPGRADED_ELF pin helper (never sends anything)');
  console.log(`  build        ${path.basename(args.elf)}: ${so.length} B`);
  console.log(`  sha256       ${sha}`);
  console.log(`  exec hash    ${exec}   (zero padding stripped; what solana-verify get-executable-hash prints)`);
  const mainnetKey = keyChunks(so, MAINNET_ORACLE) === 4;
  const localKey = keyChunks(so, LOCALNET_ORACLE) > 0;
  console.log(`  constants    ${localKey ? 'a --features localnet build (the localnet oracle key is compiled in)' : mainnetKey ? 'mainnet (the mainnet oracle key is compiled in)' : 'unknown: neither oracle key found'}`);
  if (localKey && !args['allow-localnet']) refuse('this is a --features localnet build: the real pin is the S2 mainnet build (pass --allow-localnet only in a rehearsal)');
  if (!localKey && !mainnetKey) refuse('the build carries neither the mainnet nor the localnet oracle key: not a Moon Forge build');
  if (args['expect-sha']) {
    if (args['expect-sha'] !== sha) refuse(`the build's sha256 ${sha} is not the published S2 hash ${args['expect-sha']}`);
    console.log('  ok   sha256 = the published S2 hash');
  } else console.log('  note no --expect-sha: compare the sha256 above with the S2 hash on the sign-off sheet by eye');

  if (args.rpc) {
    const c = await connectTo(args.rpc);
    const legacy = args['legacy-deploy-slot'] ? Number(args['legacy-deploy-slot']) : LIVE_DEPLOY_SLOT;
    const prog = await readProgram(c.conn, { full: true });
    if (prog.error) refuse(`program: ${prog.error}`);
    const got = deployedElfSha(prog.body, so.length);
    console.log(`  chain        ${describeCluster(c)}: last-deploy slot ${prog.deploySlot}, data length ${prog.dataLen} B`);
    if (got === sha) console.log(`  ok   the deployed ProgramData holds this build byte for byte (${so.length} B + zero padding)`);
    else if (prog.deploySlot <= legacy) console.log(`  note not deployed yet: the live binary is still the one of slot ${prog.deploySlot}`);
    else { console.log(`  FAIL the deployed ELF is ${got === null ? `not ${so.length} B followed by zeros` : `sha256 ${got}`}, not this build`); bad++; }
  }

  const src = fs.readFileSync(file, 'utf8');
  const cur = readPin(file);
  const line = pinLine(sha, so.length);
  console.log(`  pin file     ${path.basename(file)}: ${cur ? `{ sha256: "${cur.sha256}", bytes: ${cur.bytes} }` : 'null (not pinned)'}`);
  if (args.check) {
    if (cur && cur.sha256 === sha && cur.bytes === so.length) console.log('  ok   the pin in the file is this build');
    else { console.log(`  FAIL the pin in the file is ${cur ? `${cur.sha256} (${cur.bytes} B)` : 'null'}, not this build`); bad++; }
    return bad ? 1 : 0;
  }
  console.log(`  new line     ${line}`);
  if (cur && cur.sha256 === sha && cur.bytes === so.length) { console.log('  the file already holds this pin'); return bad ? 1 : 0; }
  if (cur) console.log(`  note the file pins another build (${cur.sha256}): replacing a pin needs a reviewed reason (a corrective upgrade)`);
  if (!args.write) { console.log('  dry: nothing written (add --write, then commit the line in a reviewed commit before S7)'); return bad ? 1 : 0; }
  if (bad) refuse('the chain check failed: nothing written');
  const m = src.match(new RegExp(PIN_RE.source, 'gm'));
  if (!m || m.length !== 1) refuse(`the UPGRADED_ELF line occurs ${m ? m.length : 0} times in ${path.basename(file)}`);
  const out = src.replace(PIN_RE, line);
  fs.writeFileSync(file, out);
  const back = readPin(file);
  if (!back || back.sha256 !== sha || back.bytes !== so.length) refuse('the written file does not read back as the pin');
  console.log(`  written ${file}`);
  console.log(`  was: ${cur ? pinLine(cur.sha256, cur.bytes) : PIN_NULL_LINE}`);
  console.log(`  now: ${line}`);
  return 0;
});
