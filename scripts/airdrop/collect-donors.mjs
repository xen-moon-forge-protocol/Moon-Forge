// Lists Genesis supporters, so they can be added to the airdrop list before the root is set:
//  - wallets that donated at least MIN_XNT (default 5) to any Moon Forge vault or deposited
//    into Be the House (read from the program's on-chain events);
//  - wallets that sent >= 1 XNT to the architect wallet for the v2 upgrade since SINCE_UNIX.
// Anyone can re-run it and get the same result.
//
//   MIN_XNT=5 node scripts/airdrop/collect-donors.mjs > donors.txt
//   cat donors.txt validators.txt > wallets.txt && node scripts/airdrop/build-airdrop.mjs wallets.txt
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'oracle/package.json'));
const anchor = require('@coral-xyz/anchor');
const { Connection, PublicKey } = require('@solana/web3.js');
const idl = require(path.join(root, 'oracle/src/idl/moon_forge.json'));

const RPC = process.env.X1_RPC_URL || 'https://rpc.mainnet.x1.xyz';
const MIN = Math.round(Number(process.env.MIN_XNT || 5) * 1e9);
const UNTIL = Number(process.env.UNTIL_UNIX || Math.floor(Date.now() / 1000));
const conn = new Connection(RPC, 'confirmed');
const programId = new PublicKey(idl.address);
const coder = new anchor.BorshCoder(idl);
const parser = new anchor.EventParser(programId, coder);

const totals = new Map();
let before;
for (;;) {
  const sigs = await conn.getSignaturesForAddress(programId, { limit: 1000, before });
  if (!sigs.length) break;
  for (const s of sigs) {
    if (s.err || (s.blockTime ?? 0) > UNTIL) continue;
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    for (const ev of parser.parseLogs(tx?.meta?.logMessages ?? [])) {
      const name = String(ev.name).toLowerCase(); // IDL names: "Donated", "HouseChanged"
      const who = name === 'donated' ? ev.data.donor : name === 'housechanged' && ev.data.deposit ? ev.data.owner : null;
      const amount = name === 'donated' ? ev.data.amount : name === 'housechanged' ? ev.data.lamports : null;
      if (!who || !amount) continue;
      const k = who.toBase58();
      totals.set(k, (totals.get(k) ?? 0) + Number(amount.toString()));
    }
  }
  if (sigs.length < 1000) break;
  before = sigs[sigs.length - 1].signature;
}
// Upgrade supporters: plain transfers of >= 1 XNT to the architect wallet since SINCE_UNIX
const ARCHITECT = new PublicKey('7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd');
const SINCE = Number(process.env.SINCE_UNIX || 1791331200); // 2026-10-07 00:00 UTC
const upgradeSupporters = new Map();
let b2;
for (;;) {
  const sigs = await conn.getSignaturesForAddress(ARCHITECT, { limit: 1000, before: b2 });
  if (!sigs.length) break;
  for (const s of sigs) {
    if (s.err || (s.blockTime ?? 0) < SINCE || (s.blockTime ?? 0) > UNTIL) continue;
    const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    for (const ix of tx?.transaction.message.instructions ?? []) {
      if (ix.program !== 'system' || ix.parsed?.type !== 'transfer') continue;
      const { source, destination, lamports } = ix.parsed.info;
      if (destination === ARCHITECT.toBase58() && source !== ARCHITECT.toBase58()) {
        upgradeSupporters.set(source, (upgradeSupporters.get(source) ?? 0) + lamports);
      }
    }
  }
  if (sigs.length < 1000 || (sigs[sigs.length - 1].blockTime ?? 0) < SINCE) break;
  b2 = sigs[sigs.length - 1].signature;
}
for (const [k, v] of upgradeSupporters) {
  if (v >= 1e9) totals.set(k, Math.max(totals.get(k) ?? 0, MIN, v));
}

const donors = [...totals].filter(([, v]) => v >= MIN).sort((a, b) => b[1] - a[1]);
process.stderr.write(`${donors.length} supporters with >= ${MIN / 1e9} XNT\n`);
for (const [k, v] of donors) process.stderr.write(`  ${k} ${(v / 1e9).toFixed(3)} XNT\n`);
console.log(donors.map(([k]) => k).join('\n'));
