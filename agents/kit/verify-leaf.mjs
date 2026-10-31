/**
 * Shared leaf and epoch-file verification: the exact conventions the program checks on chain (utils.rs verify_proof)
 * and the oracle writes (oracle/src/merkle.ts, epoch.ts, rewards.ts, extra.ts). Pure functions, no network:
 *
 *   base leaf    keccak("MOONFORGE_V2_CLAIM"   ‖ epoch u64 LE ‖ player 32 ‖ tier u8 ‖ score u64 LE)   (every epoch, v2 and v3)
 *   extra leaf   keccak("MOONFORGE_V3_EXTRA"   ‖ epoch u64 LE ‖ index u32 LE ‖ wallet 32 ‖ amount u64 LE)  (after the upgrade)
 *   airdrop leaf keccak("MOONFORGE_V2_AIRDROP" ‖ wallet 32)
 *   tree         sorted pairs: parent = keccak(min(a, b) ‖ max(a, b)); an odd node is promoted unchanged
 *   data hash    sha256 of the canonical JSON of the file body (v2: the listed fields; v3 and extra: everything but
 *                dataHash, proofs and publish)
 *
 * The same module serves verifyMyClaim(), examples/verify-epoch.mjs and the unit tests (epoch 1: one leaf, root
 * d277eb36…, data hash 3bfe5bd0…).
 */
import crypto from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { PublicKey } from '@solana/web3.js';

export const LEAF_DOMAIN = Buffer.from('MOONFORGE_V2_CLAIM');
export const EXTRA_LEAF_DOMAIN = Buffer.from('MOONFORGE_V3_EXTRA');
export const AIRDROP_DOMAIN = Buffer.from('MOONFORGE_V2_AIRDROP');
export const EMPTY_ROOT = '00'.repeat(32);
const U64 = 2n ** 64n;

export function keccak(...parts) {
  const h = keccak_256.create();
  for (const p of parts) h.update(p);
  return Buffer.from(h.digest());
}
function u64le(v) {
  const n = BigInt(v);
  if (n < 0n || n >= U64) throw new Error(`${v} does not fit in a u64`);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}
function u32le(v) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffff_ffff) throw new Error(`${v} does not fit in a u32`);
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}
const hex32 = (h, what = 'hash') => {
  const s = Buffer.isBuffer(h) || h instanceof Uint8Array ? Buffer.from(h).toString('hex') : String(h).replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/i.test(s)) throw new Error(`${what}: not a 32-byte hex value`);
  return Buffer.from(s, 'hex');
};

/** The base claim leaf of (epoch, player, tier, score). */
export const claimLeaf = (epoch, player, tier, score) => keccak(LEAF_DOMAIN, u64le(epoch), new PublicKey(player).toBuffer(), Buffer.from([Number(tier)]), u64le(score));
/** The extra-pot leaf of (epoch, index, wallet, amount). */
export const extraLeaf = (epoch, index, wallet, amount) => keccak(EXTRA_LEAF_DOMAIN, u64le(epoch), u32le(Number(index)), new PublicKey(wallet).toBuffer(), u64le(amount));
/** The Genesis airdrop leaf of a wallet. */
export const airdropLeaf = (wallet) => keccak(AIRDROP_DOMAIN, new PublicKey(wallet).toBuffer());

const hashPair = (a, b) => (Buffer.compare(a, b) <= 0 ? keccak(a, b) : keccak(b, a));

/** True when `proof` (hex strings or bytes) leads from `leaf` to `root`. */
export function verifyProof(proof, root, leaf) {
  let c = Buffer.from(leaf);
  for (const n of proof ?? []) c = hashPair(c, hex32(n, 'proof node'));
  return c.equals(hex32(root, 'root'));
}

/** Root and proofs of a list of leaf hashes (the oracle's MerkleTree); throws on an empty list. */
export function merkleTree(leafHashes) {
  if (!leafHashes.length) throw new Error('empty tree');
  const layers = [leafHashes.map((h) => Buffer.from(h))];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1], next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]);
    layers.push(next);
  }
  const proof = (index) => {
    const out = [];
    for (let l = 0, i = index; l < layers.length - 1; l++, i >>= 1) {
      const sib = i ^ 1;
      if (sib < layers[l].length) out.push(layers[l][sib].toString('hex'));
    }
    return out;
  };
  return { root: layers[layers.length - 1][0].toString('hex'), proof };
}

// ─── canonical JSON and data hashes ──────────────────────────────────────────
/** The path of an own "__proto__" member anywhere in v (JSON.parse creates them), or null. */
export function protoPath(v, at = '$') {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const p = protoPath(v[i], `${at}[${i}]`); if (p) return p; }
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (k === '__proto__') return `${at}.__proto__`;
      const p = protoPath(v[k], `${at}.${k}`);
      if (p) return p;
    }
  }
  return null;
}
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const o = Object.create(null);
    for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
    return o;
  }
  return v;
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const V2_FIELDS = ['version', 'programId', 'epoch', 'createdAt', 'chains', 'xnt', 'kBps', 'rateCap', 'artifacts', 'burns', 'leaves', 'totalScore', 'root'];
/** epoch.ts dataHash: sha256 of the canonical JSON of the v2 body fields. */
export function dataHashV2(f) {
  const pick = {};
  for (const k of V2_FIELDS) pick[k] = f[k];
  return sha256(JSON.stringify(canonical(pick)));
}
/** rewards.ts dataHashV3 / extra.ts dataHashExtra: sha256 of the canonical JSON of everything but dataHash, proofs, publish. */
export function dataHashBody(f) {
  const { dataHash: _h, proofs: _p, publish: _u, ...body } = f;
  return sha256(JSON.stringify(canonical(body)));
}
export const fileKind = (f) => (f?.kind === 'extra' ? 'extra' : f?.version === 3 ? 'v3' : f?.version === 2 ? 'v2' : 'unknown');
export function dataHashOf(f) {
  const k = fileKind(f);
  if (k === 'v2') return dataHashV2(f);
  if (k === 'v3' || k === 'extra') return dataHashBody(f);
  throw new Error('unknown epoch file version');
}

// ─── whole-file checks (offline) ─────────────────────────────────────────────
const isB58Key = (s) => { try { return typeof s === 'string' && new PublicKey(s).toBase58() === s; } catch { return false; } };

/**
 * Offline check of a base epoch file (v2 or v3): every leaf hash, the root, the total score, every proof and the data
 * hash are recomputed from the file. Returns { ok, kind, epoch, root, totalScore, leaves, dataHash, problems[] }.
 * This does NOT re-derive the allocation from the burns (that is the oracle's `npm run verify`); compareWithChain()
 * then ties the file to the on-chain Epoch account.
 */
export function verifyEpochFileOffline(f) {
  const problems = [];
  const kind = fileKind(f);
  if (kind !== 'v2' && kind !== 'v3') return { ok: false, kind, problems: [`not a base epoch file (version ${f?.version}, kind ${f?.kind})`] };
  const proto = protoPath(f);
  if (proto) problems.push(`the file has a "__proto__" member at ${proto}`);
  if (!Number.isSafeInteger(f.epoch) || f.epoch < 1) problems.push(`bad epoch number ${f.epoch}`);
  const leaves = Array.isArray(f.leaves) ? f.leaves : [];
  // round 4: a v3 heartbeat base epoch (a week with no burn to value; forge.rs epoch_shape) has no leaf, total score 0,
  // rate cap 0 and the all-zero root; it pays nothing and only keeps the oracle seat alive
  const heartbeat = kind === 'v3' && f.heartbeat === true;
  if (heartbeat) {
    if (leaves.length) problems.push(`a heartbeat epoch has no leaves (the file lists ${leaves.length})`);
    if (f.root !== EMPTY_ROOT) problems.push(`a heartbeat epoch has the all-zero root (the file says ${f.root})`);
    if (f.rateCap !== '0') problems.push(`a heartbeat epoch has rate cap 0 (the file says ${f.rateCap})`);
    if (f.proofs && Object.keys(f.proofs).length) problems.push('a heartbeat epoch has no proofs');
    if (Array.isArray(f.burns) && f.burns.length) problems.push('a heartbeat epoch values no burn');
  } else if (f.heartbeat !== undefined) problems.push(`heartbeat ${JSON.stringify(f.heartbeat)}: only a v3 file records it, as true`);
  if (!leaves.length && !heartbeat) problems.push('no leaves');
  let total = 0n;
  const hashes = [];
  const seen = new Set();
  leaves.forEach((l, i) => {
    if (!isB58Key(l.player)) { problems.push(`leaf ${i}: bad player ${l.player}`); return; }
    if (!Number.isInteger(l.tier) || l.tier < 0 || l.tier > 2) { problems.push(`leaf ${i}: bad tier ${l.tier}`); return; }
    if (typeof l.score !== 'string' || !/^(0|[1-9][0-9]*)$/.test(l.score) || BigInt(l.score) <= 0n || BigInt(l.score) >= U64) { problems.push(`leaf ${i}: bad score ${l.score}`); return; }
    const k = `${l.player}:${l.tier}`;
    if (seen.has(k)) problems.push(`leaf ${k} twice`);
    seen.add(k);
    if (i > 0) {
      const p = leaves[i - 1];
      if (p.player > l.player || (p.player === l.player && p.tier >= l.tier)) problems.push(`leaves are not sorted at ${i}`);
    }
    total += BigInt(l.score);
    hashes.push(claimLeaf(f.epoch, l.player, l.tier, l.score));
  });
  let root = null;
  if (hashes.length === leaves.length && hashes.length) {
    const t = merkleTree(hashes);
    root = t.root;
    if (t.root !== f.root) problems.push(`root mismatch: computed ${t.root}, file says ${f.root}`);
    leaves.forEach((l, i) => {
      const proof = f.proofs?.[`${l.player}:${l.tier}`];
      if (!Array.isArray(proof)) problems.push(`no proof for ${l.player}:${l.tier}`);
      else if (!verifyProof(proof, f.root, hashes[i])) problems.push(`the proof of ${l.player}:${l.tier} does not lead to the root`);
    });
  }
  if (String(total) !== f.totalScore) problems.push(`totalScore mismatch: computed ${total}, file says ${f.totalScore}`);
  let dataHash = null;
  try { dataHash = dataHashOf(f); if (dataHash !== f.dataHash) problems.push(`dataHash mismatch: computed ${dataHash}, file says ${f.dataHash}`); } catch (e) { problems.push(String(e.message)); }
  return { ok: problems.length === 0, kind, epoch: f.epoch, root: heartbeat && !leaves.length ? EMPTY_ROOT : root, totalScore: String(total), leaves: leaves.length, dataHash, heartbeat, problems };
}

/** Offline check of an extra-pot file (extra-<n>.json): leaves, root, proofs, Σ amounts vs the budget, data hash. */
export function verifyExtraFileOffline(f) {
  const problems = [];
  if (fileKind(f) !== 'extra') return { ok: false, kind: fileKind(f), problems: ['not an extra-pot file'] };
  const proto = protoPath(f);
  if (proto) problems.push(`the file has a "__proto__" member at ${proto}`);
  const leaves = Array.isArray(f.leaves) ? f.leaves : [];
  let sum = 0n;
  const hashes = [];
  leaves.forEach((l, i) => {
    if (l.index !== i) problems.push(`leaf ${i} has index ${l.index}`);
    if (!isB58Key(l.wallet)) { problems.push(`leaf ${i}: bad wallet`); return; }
    if (typeof l.amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(l.amount)) { problems.push(`leaf ${i}: bad amount`); return; }
    sum += BigInt(l.amount);
    hashes.push(extraLeaf(f.epoch, l.index, l.wallet, l.amount));
  });
  const root = hashes.length ? merkleTree(hashes).root : EMPTY_ROOT;
  if (hashes.length === leaves.length && root !== f.root) problems.push(`root mismatch: computed ${root}, file says ${f.root}`);
  if (hashes.length === leaves.length) {
    leaves.forEach((l, i) => {
      const proof = f.proofs?.[l.wallet];
      if (!Array.isArray(proof) || !verifyProof(proof, f.root, hashes[i])) problems.push(`the proof of ${l.wallet} does not lead to the root`);
    });
  }
  if (f.totals && String(sum) !== String(f.totals.budget)) problems.push(`Σ leaves ${sum} differs from the budget ${f.totals.budget}`);
  let dataHash = null;
  try { dataHash = dataHashBody(f); if (dataHash !== f.dataHash) problems.push(`dataHash mismatch: computed ${dataHash}`); } catch (e) { problems.push(String(e.message)); }
  return { ok: problems.length === 0, kind: 'extra', epoch: f.epoch, root, total: String(sum), leaves: leaves.length, dataHash, problems };
}

const bytesHex = (x) => Buffer.from(x).toString('hex');
/**
 * Ties a file to its on-chain account: an Epoch (root, data_hash, total_score, leaves) or an ExtraEpoch (root, data_hash,
 * budget, leaves). `account` is the Anchor-decoded account, or null when it does not exist. Returns the problems.
 */
export function compareWithChain(f, account) {
  if (!account) return [`epoch ${f.epoch} has no account on chain (not published, or a wrong file)`];
  const problems = [];
  if (bytesHex(account.root) !== f.root) problems.push(`on-chain root ${bytesHex(account.root)} differs from the file's ${f.root}`);
  if (bytesHex(account.dataHash) !== f.dataHash) problems.push(`on-chain data hash ${bytesHex(account.dataHash)} differs from the file's ${f.dataHash}`);
  if (fileKind(f) === 'extra') {
    if (String(account.budget) !== String(f.totals?.budget)) problems.push(`on-chain budget ${account.budget} differs from the file's ${f.totals?.budget}`);
  } else if (String(account.totalScore) !== f.totalScore) problems.push(`on-chain total score ${account.totalScore} differs from the file's ${f.totalScore}`);
  if (Number(account.leaves) !== (f.leaves?.length ?? -1)) problems.push(`on-chain leaf count ${account.leaves} differs from the file's ${f.leaves?.length}`);
  return problems;
}

/** The base leaf of `player` at `tier` in a file, with its proof and hash, or null. */
export function leafOf(f, player, tier) {
  const p = new PublicKey(player).toBase58();
  const l = (f.leaves ?? []).find((x) => x.player === p && x.tier === Number(tier));
  if (!l) return null;
  return { ...l, proof: f.proofs?.[`${p}:${l.tier}`] ?? [], hash: claimLeaf(f.epoch, p, l.tier, l.score).toString('hex') };
}
/** The extra leaf of `wallet` in an extra file, with its proof and hash, or null. */
export function extraLeafOf(f, wallet) {
  const w = new PublicKey(wallet).toBase58();
  const l = (f.leaves ?? []).find((x) => x.wallet === w);
  if (!l) return null;
  return { ...l, proof: f.proofs?.[w] ?? [], hash: extraLeaf(f.epoch, l.index, w, l.amount).toString('hex') };
}
