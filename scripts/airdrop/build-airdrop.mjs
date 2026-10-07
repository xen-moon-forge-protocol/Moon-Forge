// Builds the Genesis airdrop list (max 120 Lunar Dust, no floor) for active X1 wallets.
//
//   node scripts/airdrop/build-airdrop.mjs wallets.txt
//
// wallets.txt: one Base58 X1 address per line (e.g. testnet-reward recipients, XDEX traders,
// early Moon Forge burners). Duplicates and invalid keys are dropped; order is normalized so
// anyone can rebuild the same root from the same list.
// Output: frontend/public/airdrop/airdrop.json  { root, wallets, proofs }
// Then the architect calls set_airdrop_root(root) ONCE (see DEPLOY.md).
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'oracle/package.json'));
const { PublicKey } = require('@solana/web3.js');
const { keccak_256 } = require('@noble/hashes/sha3');

const keccak = (...parts) => { const h = keccak_256.create(); parts.forEach((p) => h.update(p)); return Buffer.from(h.digest()); };
const pair = (a, b) => (Buffer.compare(a, b) <= 0 ? keccak(a, b) : keccak(b, a));
const DOMAIN = Buffer.from('MOONFORGE_V2_AIRDROP');

const file = process.argv[2];
if (!file) throw new Error('usage: build-airdrop.mjs wallets.txt');
const wallets = [...new Set(fs.readFileSync(file, 'utf8').split(/\s+/).filter(Boolean))]
  .filter((w) => { try { return new PublicKey(w).toBase58() === w; } catch { return false; } })
  .sort();
if (!wallets.length) throw new Error('no valid wallets');

const leaves = wallets.map((w) => keccak(DOMAIN, new PublicKey(w).toBuffer()));
const layers = [leaves];
while (layers[layers.length - 1].length > 1) {
  const c = layers[layers.length - 1], n = [];
  for (let i = 0; i < c.length; i += 2) n.push(i + 1 < c.length ? pair(c[i], c[i + 1]) : c[i]);
  layers.push(n);
}
const proofs = {};
wallets.forEach((w, idx) => {
  const p = [];
  let i = idx;
  for (let l = 0; l < layers.length - 1; l++) { const s = i ^ 1; if (s < layers[l].length) p.push(layers[l][s].toString('hex')); i >>= 1; }
  proofs[w] = p;
});
const out = path.join(root, 'frontend/public/airdrop');
fs.mkdirSync(out, { recursive: true });
const rootHex = layers[layers.length - 1][0].toString('hex');
fs.writeFileSync(path.join(out, 'airdrop.json'), JSON.stringify({ root: rootHex, count: wallets.length, note: 'First 120 claims win (AIRDROP_MAX).', wallets, proofs }, null, 2));
console.log(`${wallets.length} wallets, root ${rootHex}`);
