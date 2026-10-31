// The XDEX WXNT/USDC.X observation account for tests/e2e-oracle-v3.sh: the layout of tests/fixtures/make-observation.cjs
// (Raydium-CPMM ObservationState owned by the XDEX program), but at a FLAT price in USD per XNT, so the oracle's
// on-chain TWAP reading (pricing.ts xntTwapOnChain: WXNT 9 decimals, USDC.X 6 decimals, price x 2^32) agrees with the
// price APIs of the fake world. 100 observations, one a minute, from 5 minutes ago (a 100-minute run at most).
// Usage: node make-observation.cjs <out.json> <usd per XNT>
const fs = require("fs");
const [out, usdArg] = process.argv.slice(2);
if (!out || !usdArg) { console.error("usage: make-observation.cjs <out.json> <usd per XNT>"); process.exit(2); }
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(ALPHABET.indexOf(c));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  return Buffer.from([...Array(32 - bytes.length).fill(0), ...bytes]);
}
const OBSERVATION = "4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ";
const POOL = "CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR";
const XDEX = "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN";
const data = Buffer.alloc(4075);
Buffer.from([0xa4, 0x5c, 0x1e, 0x0b, 0x9b, 0x2e, 0x7f, 0x10]).copy(data, 0);
data[8] = 1;
data.writeUInt16LE(99, 9);
b58decode(POOL).copy(data, 11);
// USD per XNT = (x32 / 2^32) x 1e3  =>  x32 = usd / 1e3 x 2^32
const x32 = BigInt(Math.round((Number(usdArg) / 1e3) * 2 ** 32));
const STEP = 60;
const first = Math.floor(Date.now() / 1000) - 300;
let cum = 0n;
for (let i = 0; i < 100; i++) {
  if (i > 0) cum += x32 * BigInt(STEP);
  const o = 43 + i * 40;
  data.writeBigUInt64LE(BigInt(first + i * STEP), o);
  data.writeBigUInt64LE(cum & ((1n << 64n) - 1n), o + 8);
  data.writeBigUInt64LE(cum >> 64n, o + 16);
}
fs.writeFileSync(out, JSON.stringify({ pubkey: OBSERVATION, account: { lamports: 29_250_000, data: [data.toString("base64"), "base64"], owner: XDEX, executable: false, rentEpoch: 0, space: data.length } }));
console.log(`observation ring at $${usdArg}/XNT from ${new Date(first * 1000).toISOString()}`);
