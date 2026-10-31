// Verifies published epoch files without trusting the site: every leaf hash, the Merkle root, every proof, the total
// score and the data hash are recomputed from the file (offline), then (unless --offline) tied to the program's Epoch
// account on X1 (root, data hash, total score, leaf count), read-only. Extra-pot files (extra-<n>.json, after the final
// upgrade) are checked the same way against their ExtraEpoch account.
//
//   node examples/verify-epoch.mjs                              every epoch in ../../frontend/public/epochs, offline + chain
//   node examples/verify-epoch.mjs --offline                    file checks only (no network at all)
//   node examples/verify-epoch.mjs --dir path/to/epochs 3       one epoch from a saved mirror
//   node examples/verify-epoch.mjs --site                       read the files from the site over HTTPS (explicit)
//   X1_RPC_URLS=https://your-rpc node examples/verify-epoch.mjs  your own endpoint first
//
// This does not re-derive each payout from the burns and prices recorded in the file (the oracle's
// `cd oracle && npm run verify -- epoch-N.json --full` does); it proves that the file you hold is the one the program
// pays from. Exit code 0 when every check passes, 1 otherwise.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import anchor from '@coral-xyz/anchor';
import { Connection } from '@solana/web3.js';
import { EpochSource, EPOCHS_URL } from '../epochs.mjs';
import { compareWithChain, verifyEpochFileOffline, verifyExtraFileOffline } from '../verify-leaf.mjs';
import { loadBundledIdl } from '../idl.mjs';
import { PDA, rpcList } from '../moonforge.mjs';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const offline = flag('--offline');
const here = path.dirname(fileURLToPath(import.meta.url));
const source = flag('--site') ? new EpochSource({ url: EPOCHS_URL }) : new EpochSource({ dir: opt('--dir') ?? path.resolve(here, '../../../frontend/public/epochs') });
const only = args.filter((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--dir').map(Number);

let failed = 0;
const say = (ok, line) => { if (!ok) failed++; console.log(`${ok ? 'OK  ' : 'FAIL'} ${line}`); };
try {
  const idx = await source.index();
  const epochs = only.length ? only : idx.epochs.map((e) => Number(e.epoch));
  if (!epochs.length) throw new Error(`no epoch files in ${source.describe}`);
  // read-only: the bundled IDL's coder decodes the accounts (camelCase fields); nothing is signed
  const conn = offline ? null : new Connection(rpcList()[0], 'confirmed');
  const program = new anchor.Program(loadBundledIdl('v3').idl, { connection: conn ?? new Connection('http://127.0.0.1:1') });
  const nameOf = (n) => program.idl.accounts.find((a) => a.name.toLowerCase() === n.toLowerCase()).name;
  const account = async (pk, name) => {
    const info = await conn.getAccountInfo(pk, 'confirmed');
    return info ? program.coder.accounts.decode(nameOf(name), info.data) : null;
  };
  for (const n of epochs) {
    const f = await source.epoch(n);
    if (!f) { say(false, `epoch ${n}: no file in ${source.describe}`); continue; }
    const r = verifyEpochFileOffline(f);
    say(r.ok, `epoch ${n} (v${f.version}): ${r.leaves} leaves, root ${String(r.root).slice(0, 12)}…, total ${r.totalScore}, data hash ${String(r.dataHash).slice(0, 12)}…${r.ok ? '' : ` — ${r.problems.join('; ')}`}`);
    if (conn) {
      const p = compareWithChain(f, await account(PDA.epoch(n), 'Epoch'));
      say(p.length === 0, `epoch ${n} on chain: ${p.length ? p.join('; ') : 'root, data hash, total score and leaf count match the Epoch account'}`);
    }
    const x = await source.extra(n).catch(() => null);
    if (x) {
      const e = verifyExtraFileOffline(x);
      say(e.ok, `extra ${n}: ${e.leaves} leaves, Σ ${e.total} lamports${e.ok ? '' : ` — ${e.problems.join('; ')}`}`);
      if (conn) {
        const p = compareWithChain(x, await account(PDA.extraEpoch(n), 'ExtraEpoch'));
        say(p.length === 0, `extra ${n} on chain: ${p.length ? p.join('; ') : 'matches the ExtraEpoch account'}`);
      }
    }
  }
} catch (e) {
  failed++;
  console.error(`verify-epoch: ${String(e?.message ?? e).slice(0, 300)}`);
}
console.log(failed ? `${failed} check(s) failed` : 'every check passed');
process.exitCode = failed ? 1 : 0;
