// Writes tests/fixtures/xdex-observation.json: a synthetic XDEX (Raydium-CPMM) ObservationState for the
// local validator (`--account <address> <file>`), owned by the XDEX program id, for the WXNT/USDC.X pool.
// 100 observations, one every 20 s (< PRED_MAX_GAP 25 s) from 60 s ago to ~33 minutes ahead. The price is flat except
// for a +5% step at k × 120 + 105 s of every ODD localnet prediction round k (PRED_PERIOD 120 s, lock at +90 s, end at
// +150 s, TWAP window 30 s): an odd round moves exactly +5% between its lock and end TWAPs (settled UP), an even round
// does not move at all (v2 no-contest band: refunded). Regenerate right before starting the validator.
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
const STEP = 20, PERIOD = 120, JUMP_AT = 105;
const first = now - 60;
// price (raw, before X32) held over an interval whose midpoint is m: 1,000,000 × 1.05^(odd-round steps passed since first)
function priceAt(m) {
  let p = 1_000_000n;
  for (let k = Math.floor(first / PERIOD); k * PERIOD + JUMP_AT <= m; k++) if (k % 2 !== 0 && k * PERIOD + JUMP_AT > first) p = (p * 105n) / 100n;
  return p;
}
let cum = 0n;
for (let i = 0; i < 100; i++) {
  const ts = first + i * STEP;
  if (i > 0) cum += priceAt(ts - STEP / 2) * BigInt(STEP) * (1n << 32n); // price (X32) held over the previous interval
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
console.log(`xdex-observation.json: 100 observations from ${new Date((now - 60) * 1000).toISOString()} to ${new Date((now - 60 + 99 * STEP) * 1000).toISOString()}`);
