// node --test: the shared leaf verification (verify-leaf.mjs) on the published epoch 1 (one leaf: its hash is the root
// d277eb36…, data hash 3bfe5bd0…), an engine-built v3 file, tampering, multi-leaf proofs, extra-pot trees and the
// comparison with the on-chain Epoch account; then the bundled IDLs (idl.mjs) and the upgrade detection (detect.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import anchor from '@coral-xyz/anchor';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  claimLeaf, compareWithChain, dataHashV2, extraLeaf, leafOf, merkleTree, verifyEpochFileOffline, verifyExtraFileOffline, verifyProof, dataHashBody,
} from '../../verify-leaf.mjs';
import { checkIdlAddress, IDL_FILES, idlRules, lfSha256, loadBundledIdl, loadGivenIdl } from '../../idl.mjs';
import { LIVE_DEPLOY_SLOT, PDA_V3, PROGRAM_ID, upgradeVerdict } from '../../detect.mjs';
import { epoch1, loadVectors, tempDir } from './helpers-v3.mjs';

const E1_ROOT = 'd277eb366200c447083d285719ce6b3ff8c07bd4b7a535ad44d188e1a891b358';
const E1_HASH = '3bfe5bd015a6215f752b0aed657459a158e831c2a956935b9142a167d74e4218';

test('epoch 1: the single leaf hashes to the published root; the file passes its own checks', () => {
  const f = epoch1();
  const l = f.leaves[0];
  assert.equal(claimLeaf(1, l.player, l.tier, l.score).toString('hex'), E1_ROOT);
  assert.ok(verifyProof([], E1_ROOT, claimLeaf(1, l.player, l.tier, l.score)));
  assert.equal(dataHashV2(f), E1_HASH);
  const r = verifyEpochFileOffline(f);
  assert.deepEqual(r.problems, []);
  assert.equal(r.root, E1_ROOT);
  assert.equal(leafOf(f, l.player, 0).hash, E1_ROOT);
});

test('round 4: a v3 heartbeat epoch (no leaf, total 0, rate cap 0, the all-zero root) passes; a broken or v2 heartbeat does not', () => {
  const body = {
    version: 3, programId: '57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9', epoch: 9, createdAt: '2026-12-06T00:00:00.000Z', chains: [], burns: [], targets: [], leaves: [],
    totalScore: '0', root: '0'.repeat(64), rateCap: '0', heartbeat: true,
  };
  const hb = { ...body, dataHash: dataHashBody(body), proofs: {} };
  const r = verifyEpochFileOffline(hb);
  assert.deepEqual(r.problems, []);
  assert.equal(r.heartbeat, true);
  assert.equal(r.root, '0'.repeat(64));
  assert.deepEqual(compareWithChain(hb, { root: Buffer.alloc(32), dataHash: Buffer.from(hb.dataHash, 'hex'), totalScore: { toString: () => '0' }, leaves: 0 }), []);
  const noFlag = { ...hb, heartbeat: undefined };
  delete noFlag.heartbeat;
  assert.ok(verifyEpochFileOffline(noFlag).problems.includes('no leaves'), 'without the heartbeat member an empty file is refused');
  for (const [k, v, re] of [['rateCap', '1', /rate cap 0/], ['root', 'ab'.repeat(32), /all-zero root/], ['burns', [{}], /values no burn/]]) {
    assert.match(verifyEpochFileOffline({ ...hb, [k]: v }).problems.join(';'), re);
  }
  assert.match(verifyEpochFileOffline({ ...epoch1(), heartbeat: true }).problems.join(';'), /only a v3 file records it/);
  // the heartbeat the oracle engine itself builds (rewards.ts computeEpochV3 { heartbeat: true }, in the quote vectors)
  const engineHb = loadVectors().prevFiles.v3h;
  assert.equal(engineHb.heartbeat, true);
  assert.deepEqual(verifyEpochFileOffline(engineHb).problems, []);
});
test('a tampered file is caught: score, root, proof, data hash', () => {
  const f = epoch1();
  f.leaves[0].score = '63919';
  const r = verifyEpochFileOffline(f);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /root mismatch/.test(p)));
  assert.ok(r.problems.some((p) => /totalScore mismatch/.test(p)));
  assert.ok(r.problems.some((p) => /dataHash mismatch/.test(p)));
  const g = epoch1();
  g.chains[0].xenUsdE18 = '1';
  assert.ok(verifyEpochFileOffline(g).problems.some((p) => /dataHash mismatch/.test(p)), 'a changed input breaks the data hash');
  const h = JSON.parse('{"__proto__":{"x":1}}');
  assert.equal(verifyEpochFileOffline({ ...epoch1(), extra: h }).ok, false);
});

test('an engine-built v3 file (from the golden vectors) passes, and its data hash is the canonical body hash', () => {
  const f = loadVectors().prevFiles.v3a;
  assert.equal(dataHashBody(f), f.dataHash);
  const r = verifyEpochFileOffline(f);
  assert.deepEqual(r.problems, []);
  assert.equal(r.kind, 'v3');
});

test('multi-leaf tree: every proof verifies; a proof for another leaf does not', () => {
  const leaves = Array.from({ length: 7 }, (_, i) => claimLeaf(3, Keypair.generate().publicKey.toBase58(), i % 3, 1_000 + i));
  const t = merkleTree(leaves);
  leaves.forEach((h, i) => assert.ok(verifyProof(t.proof(i), t.root, h), `leaf ${i}`));
  assert.equal(verifyProof(t.proof(0), t.root, leaves[1]), false);
});

test('extra-pot file: leaves, root, proofs and Σ amounts = budget', () => {
  const wallets = [Keypair.generate(), Keypair.generate(), Keypair.generate()].map((k) => k.publicKey.toBase58());
  const leaves = wallets.map((w, i) => ({ index: i, wallet: w, amount: String(1_000_000 * (i + 1)) }));
  const t = merkleTree(leaves.map((l) => extraLeaf(9, l.index, l.wallet, l.amount)));
  const f = { kind: 'extra', version: 1, epoch: 9, leaves, root: t.root, totals: { budget: '6000000' }, proofs: Object.fromEntries(leaves.map((l, i) => [l.wallet, t.proof(i)])) };
  f.dataHash = dataHashBody(f);
  assert.deepEqual(verifyExtraFileOffline(f).problems, []);
  const bad = { ...f, totals: { budget: '6000001' } };
  bad.dataHash = dataHashBody(bad);
  assert.ok(verifyExtraFileOffline(bad).problems.some((p) => /differs from the budget/.test(p)));
});

test('compareWithChain: the file must match the Epoch account (root, data hash, total score, leaves)', () => {
  const f = epoch1();
  const acc = { root: Buffer.from(E1_ROOT, 'hex'), dataHash: Buffer.from(E1_HASH, 'hex'), totalScore: { toString: () => '63918' }, leaves: 1 };
  assert.deepEqual(compareWithChain(f, acc), []);
  assert.equal(compareWithChain(f, null).length, 1);
  assert.match(compareWithChain(f, { ...acc, root: Buffer.alloc(32) })[0], /on-chain root/);
});

test('bundled IDLs: pinned sha256 (LF form), 59 / 92 instructions, the Moon Forge address, rules 2 / 3', () => {
  const live = loadBundledIdl('live'), v3 = loadBundledIdl('v3');
  assert.equal(live.idl.instructions.length, 59);
  assert.equal(v3.idl.instructions.length, 92);
  assert.equal(live.rules, 2);
  assert.equal(v3.rules, 3);
  assert.equal(idlRules(live.idl), 2);
  assert.equal(idlRules(v3.idl), 3);
  assert.equal(v3.idl.address, PROGRAM_ID.toBase58());
  // CRLF and LF checkouts pin the same hash
  assert.equal(lfSha256(Buffer.from('a\r\nb\n')), lfSha256(Buffer.from('a\nb\n')));
});

test('a changed IDL file is refused (sha256 pin), and so is an IDL for another program', () => {
  const dir = tempDir('mf-idl');
  const file = path.join(dir, 'moon_forge.v3.json');
  const idl = JSON.parse(fs.readFileSync(IDL_FILES.v3.path, 'utf8'));
  idl.instructions[0].args = [];
  fs.writeFileSync(file, JSON.stringify(idl));
  assert.throws(() => loadBundledIdl('v3', { files: { v3: { ...IDL_FILES.v3, path: file } } }), /does not match its pinned sha256/);
  assert.throws(() => checkIdlAddress({ ...idl, address: Keypair.generate().publicKey.toBase58() }), /not for the Moon Forge program/);
  assert.throws(() => loadBundledIdl('v3', { files: { v3: { ...IDL_FILES.v3, path: path.join(dir, 'missing.json') } } }), /is missing/);
  assert.equal(loadGivenIdl(file).rules, 3);
});

// ─── detection ──────────────────────────────────────────────────────────────
const v3Coder = new anchor.BorshAccountsCoder(loadBundledIdl('v3').idl);
const decode = (name, data) => v3Coder.decode(name, data);
async function encodeExtraState(over = {}) {
  const bump = PublicKey.findProgramAddressSync([Buffer.from('extra_state')], PROGRAM_ID)[1];
  const d = { lastEpoch: new anchor.BN(5), lastPublishTs: new anchor.BN(0), accounted: new anchor.BN(10), reserved: new anchor.BN(0), freeAfter: new anchor.BN(0), liveForgedBacking: new anchor.BN(0), outSincePublish: new anchor.BN(0), totalIn: new anchor.BN(0), totalPaid: new anchor.BN(0), totalReturned: new anchor.BN(0), vaultBump: 255, bump, ...over };
  return { owner: PROGRAM_ID, data: await v3Coder.encode('ExtraState', d) };
}
async function encodeSeat(over = {}) {
  const bump = PublicKey.findProgramAddressSync([Buffer.from('oracle_seat')], PROGRAM_ID)[1];
  const d = { generation: new anchor.BN(1), cold: PublicKey.default, refund: PublicKey.default, bond: new anchor.BN(1), takenAt: new anchor.BN(0), openSince: new anchor.BN(0), priority: PublicKey.default, priorityBond: new anchor.BN(0), voids: 0, toPool: new anchor.BN(0), bump, ...over };
  return { owner: PROGRAM_ID, data: await v3Coder.encode('OracleSeat', d) };
}

test('detection on X1 mainnet: today\'s state is rules 2 ("legacy"); the full first run is rules 3', async () => {
  assert.deepEqual(upgradeVerdict({ deploySlot: LIVE_DEPLOY_SLOT, extraState: null, oracleSeat: null, houseKeeper: null }, decode).rules, 2);
  const up = upgradeVerdict({ deploySlot: LIVE_DEPLOY_SLOT + 10, extraState: await encodeExtraState(), oracleSeat: await encodeSeat(), houseKeeper: null }, decode);
  assert.deepEqual([up.rules, up.status], [3, 'upgraded'], up.reasons.join('; '));
});

test('detection fails closed: a half-done upgrade, a foreign or malformed account, an RPC error are "unknown"', async () => {
  const x = await encodeExtraState(), s = await encodeSeat();
  const cases = [
    { deploySlot: LIVE_DEPLOY_SLOT + 1, extraState: null, oracleSeat: null, houseKeeper: null },
    { deploySlot: LIVE_DEPLOY_SLOT + 1, extraState: x, oracleSeat: null, houseKeeper: null },
    { deploySlot: LIVE_DEPLOY_SLOT, extraState: x, oracleSeat: s, houseKeeper: null },
    { deploySlot: LIVE_DEPLOY_SLOT + 1, extraState: { ...x, owner: Keypair.generate().publicKey }, oracleSeat: s, houseKeeper: null },
    { deploySlot: LIVE_DEPLOY_SLOT + 1, extraState: { ...x, data: Buffer.concat([x.data, Buffer.alloc(1)]) }, oracleSeat: s, houseKeeper: null },
    { deploySlot: LIVE_DEPLOY_SLOT + 1, extraState: { ...x, data: Buffer.alloc(90) }, oracleSeat: s, houseKeeper: null },
    { deploySlot: LIVE_DEPLOY_SLOT + 1, extraState: await encodeExtraState({ reserved: new anchor.BN(11) }), oracleSeat: s, houseKeeper: null },
    { deploySlot: LIVE_DEPLOY_SLOT + 1, extraState: x, oracleSeat: await encodeSeat({ generation: new anchor.BN(0) }), houseKeeper: null },
    { deploySlot: null, extraState: null, oracleSeat: null, houseKeeper: null, error: 'RPC error: fetch failed' },
  ];
  for (const [i, p] of cases.entries()) assert.equal(upgradeVerdict(p, decode).rules, 'unknown', `case ${i}`);
});

test('detection on another cluster (a local validator): ExtraState alone decides', async () => {
  assert.equal(upgradeVerdict({ extraState: null }, decode, { mainnet: false }).rules, 2);
  assert.equal(upgradeVerdict({ extraState: await encodeExtraState() }, decode, { mainnet: false }).rules, 3);
  assert.equal(upgradeVerdict({ extraState: { owner: PROGRAM_ID, data: Buffer.alloc(90) } }, decode, { mainnet: false }).rules, 'unknown');
  assert.equal(PDA_V3.extraState().toBase58(), 'FF4CHxw1XgCMYv9Q48yB8qX4W19oDcGK2wrqZhEEvYrE');
  assert.equal(PDA_V3.houseKeeper().toBase58(), 'Hb8Er2uoJKEWDgkJPncFQa5sVidqr34NEatqEDqnhj85');
  assert.equal(PDA_V3.oracleSeat().toBase58(), 'EQ5BTUsYou2ndMw8SXdJVwNSz4nLABSuX6WxwT2doVGq');
  assert.equal(PDA_V3.extraVault().toBase58(), 'GRGxMQDjNg4DwoL69y2p1x14fSzeaKeCHVLkAb67Z9d2');
});
