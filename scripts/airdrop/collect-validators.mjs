// Collects candidate Genesis-airdrop wallets from X1 mainnet: the withdraw authorities of the
// active vote accounts (the operators who run X1 validators — the most engaged X1 users, and
// the recipients of the Oct 2026 testnet rewards). Foundation-scale accounts are excluded.
//
//   node scripts/airdrop/collect-validators.mjs > wallets.txt
//   node scripts/airdrop/build-airdrop.mjs wallets.txt
//
// Everything comes from public RPC data, so anyone can re-run it and get the same list
// (modulo validators joining/leaving).
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'oracle/package.json'));
const { Connection, PublicKey } = require('@solana/web3.js');

const RPC = process.env.X1_RPC_URL || 'https://rpc.mainnet.x1.xyz';
const MAX_STAKE_XNT = Number(process.env.MAX_STAKE_XNT || 10_000_000); // excludes foundation-scale validators
const conn = new Connection(RPC, 'confirmed');

const { current } = await conn.getVoteAccounts();
const eligible = current.filter((v) => v.activatedStake / 1e9 < MAX_STAKE_XNT);
const out = new Set();
for (let i = 0; i < eligible.length; i += 100) {
  const chunk = eligible.slice(i, i + 100);
  const infos = await conn.getMultipleAccountsInfo(chunk.map((v) => new PublicKey(v.votePubkey)));
  infos.forEach((info) => {
    // VoteState (current versions): u32 version | node_pubkey 32 | authorized_withdrawer 32 | ...
    if (!info || info.data.length < 68) return;
    out.add(new PublicKey(info.data.subarray(36, 68)).toBase58());
  });
}
process.stderr.write(`${current.length} active vote accounts, ${eligible.length} below ${MAX_STAKE_XNT} XNT, ${out.size} unique withdraw authorities\n`);
console.log([...out].sort().join('\n'));
