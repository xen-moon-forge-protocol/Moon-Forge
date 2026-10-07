// Writes tests/fixtures/xdex-observation.json: a synthetic XDEX (Raydium-CPMM) ObservationState for the
// local validator (`--account <address> <file>`), owned by the XDEX program id, for the WXNT/USDC.X pool.
// 100 observations, one every 15 s from 60 s ago to ~24 minutes ahead, with a steadily rising price, so any
// prediction round opened during the test run resolves UP. Regenerate right before starting the validator.
const fs = require('fs');
const path = require('path');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === '1') out.unshift(0); else break; }
  return Buffer.from(out.slice(-32).length === 32 ? out.slice(-32) : [...Array(32 - out.length).fill(0), ...out]);
}

const OBSERVATION = '4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ';
const POOL = 'CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR';
const XDEX = 'sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN';

const data = Buffer.alloc(4075);
Buffer.from([0xa4, 0x5c, 0x1e, 0x0b, 0x9b, 0x2e, 0x7f, 0x10]).copy(data, 0); // discriminator (not checked)
data[8] = 1; // initialized
data.writeUInt16LE(99, 9);
b58decode(POOL).copy(data, 11);
const now = Math.floor(Date.now() / 1000);
let cum = 0n;
for (let i = 0; i < 100; i++) {
  const ts = now - 60 + i * 15;
  if (i > 0) cum += BigInt(1000 + i) * 15n * (1n << 32n); // price (X32) held over the previous 15 s, rising
  const o = 43 + i * 40;
  data.writeBigUInt64LE(BigInt(ts), o);
  data.writeBigUInt64LE(cum & ((1n << 64n) - 1n), o + 8);
  data.writeBigUInt64LE(cum >> 64n, o + 16);
}
const json = {
  pubkey: OBSERVATION,
  account: { lamports: 29_250_000, data: [data.toString('base64'), 'base64'], owner: XDEX, executable: false, rentEpoch: 0, space: data.length },
};
fs.writeFileSync(path.join(__dirname, 'xdex-observation.json'), JSON.stringify(json));
console.log(`xdex-observation.json: 100 observations from ${new Date((now - 60) * 1000).toISOString()} to ${new Date((now + 1425) * 1000).toISOString()}`);
