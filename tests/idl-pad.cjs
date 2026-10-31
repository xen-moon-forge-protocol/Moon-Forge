// tests/run-upgrade.sh helper (SPEC-UPGRADE-v2 5 / OD-29 resize path): writes a copy of an IDL whose zlib level-6 size
// (what anchor-cli writes on chain) exceeds both the given IDL-account capacity and the 16,214-B budget by >= 2 KB,
// by adding incompressible docs to the first instruction. Usage: node tests/idl-pad.cjs <idl.json> <out.json> <capacity>
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const [src, out, capArg] = process.argv.slice(2);
const idl = JSON.parse(fs.readFileSync(src, 'utf8'));
const cap = Number(capArg);
const z = () => zlib.deflateSync(Buffer.from(JSON.stringify(idl)), { level: 6 }).length;
idl.instructions[0].docs = [];
while (z() <= Math.max(cap, 16_214) + 2048) idl.instructions[0].docs.push(crypto.randomBytes(48).toString('hex'));
fs.writeFileSync(out, JSON.stringify(idl, null, 2));
console.log(`padded IDL: zlib-6 ${z()} B > capacity ${cap} B (budget 16,214 B)`);
