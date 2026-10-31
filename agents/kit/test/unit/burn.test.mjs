// node --test: the burn module (burn.mjs) with a week-so-far feed built from a golden world and a mocked ethers v6
// signer: the quote fails closed without a v3 feed; every refusal (stale feed, wrong previous file, skipped or
// quarantined chain, vesting, beyond capacity, more than half of the remaining tranche, below the market route, the
// hour edge, a late oracle, a bad destination, the wrong chain, the balance); the exact-amount approval, the re-quote
// before enterForge, TRANSACTION_REPLACED (repriced / cancelled), the MissionStarted check; address round trips; the
// pacing planner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  burnXen, BurnRefused, bytes32ToX1, checkX1Destination, destinationPreview, encodeApprove, encodeEnterForge, feedProblems, marketRouteLamports,
  MISSION_STARTED_TOPIC, parseMissionStarted, planBurns, PORTAL, portalFor, quoteBurn, SELECTORS, x1ToBytes32,
} from '../../burn.mjs';
import { DEFAULT_RULES_V3, HOUR, V3_FROM, V3_SWITCH } from '../../quote-v3.mjs';
import { supersetFeed } from '../vectors/gen-week-so-far.mjs';
import { accountDiscriminatorHex, accountFieldOffset, loadBundledIdl } from '../../idl.mjs';
import { NOTICES, normalizeFeed } from '../../burn.mjs';
import { NOTICES_V3 } from '../../moonforge.mjs';
import { burnsOf, feedFromWorld, loadVectors, prevOf, REPO } from './helpers-v3.mjs';

const X1 = Keypair.generate().publicKey.toBase58();
const XEN = 10n ** 18n;
const codes = (q) => q.refusals.map((r) => r.code);

/** A world, a time inside it with room left today, and the feed at that time. */
function scenario() {
  const v = loadVectors();
  for (const w of v.worlds.filter((x) => x.expected && x.solo && !x.expected.shortfall)) {
    const chain = w.inputs.chains.find((c) => BigInt(c.liquidityNowMicro) > 0n && c.burns.length);
    if (!chain) continue;
    for (const b of burnsOf(w.inputs)) {
      const now = (Math.floor(b.timestamp / HOUR) + 1) * HOUR + 600;
      if (now > w.inputs.window.endTs) continue;
      const feed = feedFromWorld(w, now);
      const q = quoteBurn({ feed, prev: prevOf(w), chainId: chain.chainId, amountWei: 1_000n * XEN, tier: 0, x1: X1, now, allowBelowMarket: true });
      if (q.bindingNow !== undefined && q.tranche.remainingToday > 10n ** 7n && q.bindingNow > 0n && q.ok) return { w, chain, now, feed, prev: prevOf(w) };
    }
  }
  throw new Error('no usable scenario in the vectors');
}
const S = scenario();
const base = (over = {}) => ({ feed: S.feed, prev: S.prev, chainId: S.chain.chainId, amountWei: 1_000n * XEN, tier: 0, x1: X1, now: S.now, allowBelowMarket: true, ...over });

test('no binding quote without a v3 feed: the kit fails closed (today the v2 oracle pays an estimate)', () => {
  const q = quoteBurn({ ...base(), feed: null });
  assert.equal(q.ok, false);
  assert.deepEqual(codes(q), ['noQuote']);
  assert.match(q.refusals[0].text, /No binding quote exists before the v3 switch/);
  assert.equal(q.refusals[0].override, null, 'nothing can override a missing quote');
  const v2 = quoteBurn({ ...base(), feed: { ...S.feed, rules: 2 } });
  assert.deepEqual(codes(v2), ['noQuote']);
  const stale = quoteBurn({ ...base(), feed: { ...S.feed, asOf: S.now - 3 * HOUR } });
  assert.match(stale.refusals[0].text, /stale/);
  assert.deepEqual(feedProblems({ ...S.feed, programId: Keypair.generate().publicKey.toBase58() }, { now: S.now }).length, 1);
});

test('the quote is tied to the previous epoch file the feed continues', () => {
  if (S.feed.epoch > 1) {
    assert.match(quoteBurn({ ...base(), prev: null }).refusals[0].text, /previous epoch file .* is required/);
    const other = { ...S.prev, dataHash: '00'.repeat(32) };
    assert.match(quoteBurn({ ...base(), prev: other }).refusals[0].text, /not the one the feed continues/);
  }
});

test('a skipped chain has no quote; a quarantined chain needs allowStaleOracle', () => {
  const skipped = feedFromWorld(S.w, S.now, { statuses: { [S.chain.chainId]: 'skipped' } });
  assert.match(quoteBurn({ ...base(), feed: skipped }).refusals[0].text, /skipped this week/);
  const quarantined = feedFromWorld(S.w, S.now, { statuses: { [S.chain.chainId]: 'quarantined' } });
  const q = quoteBurn({ ...base(), feed: quarantined });
  assert.ok(codes(q).includes('chainStatus'));
  assert.equal(quoteBurn({ ...base(), feed: quarantined, allowStaleOracle: true }).ok, true);
});

test('a small Launchpad burn inside today\'s tranche: a binding number, fully paid at arrival', () => {
  const q = quoteBurn(base());
  assert.equal(q.ok, true, JSON.stringify(q.refusals));
  assert.ok(q.bindingNow > 0n);
  assert.equal(q.bindingNow, q.entitlement);
  assert.equal(q.notPaid, 0n);
  assert.ok(q.tranche.remainingToday >= q.bindingNow);
  assert.match(q.notices[0], /irreversible/);
});

test('refusals: vesting tier, beyond capacity, more than half of what is left today', () => {
  const v = quoteBurn(base({ tier: 1 }));
  assert.ok(codes(v).includes('vesting'));
  const big = quoteBurn(base({ amountWei: 10n ** 12n * XEN }));
  assert.ok(codes(big).includes('beyondCapacity'), JSON.stringify(codes(big)));
  assert.ok(codes(big).includes('largeShare'));
  assert.ok(big.bindingNow < big.entitlement);
  const forced = quoteBurn(base({ amountWei: 10n ** 12n * XEN, allowBeyondCapacity: true, allowLargeShare: true }));
  assert.equal(forced.ok, true);
  const accepted = forced.accepted.map((r) => r.code);
  assert.ok(accepted.includes('beyondCapacity') && accepted.includes('largeShare'), JSON.stringify(accepted));
});

test('the market route: unknown → refused; above the binding number → refused; below → accepted', () => {
  const unknown = quoteBurn(base({ allowBelowMarket: false }));
  assert.ok(codes(unknown).includes('belowMarket'));
  assert.match(unknown.refusals.find((r) => r.code === 'belowMarket').text, /unknown/);
  const q = quoteBurn(base({ allowBelowMarket: false, marketRouteLamports: 0n }));
  assert.equal(q.ok, true);
  const above = quoteBurn(base({ allowBelowMarket: false, marketRouteLamports: q.bindingNow + 1n }));
  assert.match(above.refusals.find((r) => r.code === 'belowMarket').text, /selling the XEN now/);
  const route = { xenReserveWei: (10n ** 12n * XEN).toString(), quoteReserveMicro: '5000000000', feeBps: 30, bridgeFeeMicro: '0', bridgeMinMicro: '0' };
  const xdex = { wxntReserveLamports: (50_000n * 10n ** 9n).toString(), usdcReserveMicro: '10000000000', feeBps: 30 };
  const r = marketRouteLamports(10n ** 6n * XEN, route, xdex);
  assert.ok(r > 0n);
  const fed = quoteBurn({ ...base({ allowBelowMarket: false }), feed: feedFromWorld(S.w, S.now, { route, xdex }) });
  assert.notEqual(fed.marketRoute, null);
});

test('refusals: the hour edge, a late oracle, a recovery in progress', () => {
  const edge = (Math.floor(S.now / HOUR) + 1) * HOUR - 60;
  const q = quoteBurn({ ...base(), feed: feedFromWorld(S.w, edge), now: edge });
  assert.ok(codes(q).includes('hourEdge'));
  const late = quoteBurn(base({ oracle: { lastPublishTs: S.now - 9 * 86_400 } }));
  assert.ok(codes(late).includes('staleOracle'));
  const rec = quoteBurn({ ...base(), feed: feedFromWorld(S.w, S.now, { flags: { recoveryPending: true } }) });
  assert.ok(codes(rec).includes('staleOracle'));
});

test('destination checks: EVM address, zero key, reserved accounts, off-curve keys; hex round trip and last 6', () => {
  assert.throws(() => checkX1Destination('0x7b00f314aB48D223bee567181CA89c65126Bf6E9'), /EVM address/);
  assert.throws(() => checkX1Destination('11111111111111111111111111111111'), /zero key|program, sysvar/);
  assert.throws(() => checkX1Destination('57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9'), /program, sysvar or protocol/);
  const pda = PublicKey.findProgramAddressSync([Buffer.from('player'), Keypair.generate().publicKey.toBuffer()], new PublicKey('57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9'))[0].toBase58();
  assert.throws(() => checkX1Destination(pda), /off the ed25519 curve/);
  assert.equal(checkX1Destination(pda, { allowOffCurve: true }).b58, pda);
  assert.equal(checkX1Destination(' ' + X1 + '\n').b58, X1, 'surrounding whitespace is ignored, the key is the same');
  for (let i = 0; i < 20; i++) {
    const k = Keypair.generate().publicKey.toBase58();
    assert.equal(bytes32ToX1(x1ToBytes32(k)), k);
  }
  assert.deepEqual(Object.keys(destinationPreview(X1)), ['x1', 'hex', 'last6']);
  assert.equal(destinationPreview(X1).last6, X1.slice(-6));
});

test('calldata: ERC-20 selectors, enterForge, the MissionStarted topic (cross-checked with ethers when the oracle has it)', async () => {
  assert.equal(SELECTORS.approve, '095ea7b3');
  assert.equal(SELECTORS.allowance, 'dd62ed3e');
  assert.equal(SELECTORS.balanceOf, '70a08231');
  const data = encodeEnterForge(123n * XEN, 2, X1);
  assert.equal(data.length, 2 + 8 + 64 * 3);
  assert.equal(data.slice(-64), x1ToBytes32(X1).slice(2));
  assert.throws(() => encodeEnterForge(1n, 3, X1), /tier/);
  assert.equal(encodeApprove(PORTAL, 5n).slice(-1), '5');
  const ethersPath = path.join(REPO, 'oracle', 'node_modules', 'ethers', 'lib.esm', 'index.js');
  if (fs.existsSync(ethersPath)) {
    const { ethers } = await import(pathToFileURL(ethersPath).href);
    const iface = new ethers.Interface(['function enterForge(uint256 amount, uint8 tier, bytes32 x1Pubkey)', 'event MissionStarted(uint256 indexed missionId, address indexed pilot, uint256 amount, uint8 tier, bytes32 x1Pubkey, uint256 chainId, uint256 timestamp)', 'function approve(address,uint256)']);
    assert.equal(data, iface.encodeFunctionData('enterForge', [123n * XEN, 2, x1ToBytes32(X1)]));
    assert.equal(MISSION_STARTED_TOPIC, iface.getEvent('MissionStarted').topicHash);
    assert.equal(encodeApprove(PORTAL, 7n), iface.encodeFunctionData('approve', [PORTAL, 7n]));
    const log = iface.encodeEventLog('MissionStarted', [42n, '0x' + 'ab'.repeat(20), 9n * XEN, 1, x1ToBytes32(X1), 10n, 1_800_000_000n]);
    const ev = parseMissionStarted({ logs: [{ address: PORTAL, topics: log.topics, data: log.data }] });
    assert.deepEqual([ev.missionId, ev.amount, ev.tier, ev.x1, ev.chainId], [42n, 9n * XEN, 1, X1, 10]);
  }
});

// ─── burnXen with a mocked ethers v6 signer ──────────────────────────────────
function missionLog({ amount, tier, x1, pilot, id = 7n }) {
  const w = (h) => h.replace(/^0x/, '').padStart(64, '0');
  return {
    address: PORTAL,
    topics: [MISSION_STARTED_TOPIC, '0x' + w(id.toString(16)), '0x' + w(pilot.replace(/^0x/, '').toLowerCase())],
    data: '0x' + w(amount.toString(16)) + w(BigInt(tier).toString(16)) + x1ToBytes32(x1).slice(2) + w('a') + w('6b49d200'),
  };
}
function mockSigner({ chainId = S.chain.chainId, balance = 10n ** 30n, allowance = 0n, waitImpl = null } = {}) {
  const owner = '0x' + 'ab'.repeat(20);
  const sent = [];
  const signer = {
    sent,
    async getAddress() { return owner; },
    provider: {
      async getNetwork() { return { chainId: BigInt(chainId) }; },
      async call({ data }) { return '0x' + (data.startsWith('0x' + SELECTORS.balanceOf) ? balance : allowance).toString(16).padStart(64, '0'); },
    },
    async sendTransaction(tx) {
      sent.push(tx);
      const hash = '0x' + String(sent.length).padStart(64, '0');
      const isBurn = tx.data.startsWith('0x' + SELECTORS.enterForge);
      return {
        hash,
        wait: waitImpl && isBurn ? () => waitImpl(tx, hash) : async () => ({ hash, status: 1, logs: isBurn ? [missionLog({ amount: BigInt('0x' + tx.data.slice(10, 74)), tier: Number('0x' + tx.data.slice(74 + 62, 74 + 64)), x1: bytes32ToX1(tx.data.slice(-64)), pilot: owner })] : [] }),
      };
    },
  };
  return signer;
}
/** An X1 connection that knows the Config account (last_publish_ts at its IDL offset) and an empty destination. */
const PROGRAM = new PublicKey('57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9');
const CONFIG = PublicKey.findProgramAddressSync([Buffer.from('config')], PROGRAM)[0];
function x1Conn({ lastPublishTs = S.feed.window.startTs, dest = null, fail = false } = {}) {
  const idl = loadBundledIdl('live').idl;
  const data = Buffer.alloc(256);
  Buffer.from(accountDiscriminatorHex(idl, 'Config'), 'hex').copy(data, 0);
  data.writeBigInt64LE(BigInt(lastPublishTs), accountFieldOffset(idl, 'Config', 'last_publish_ts'));
  return {
    reads: [],
    async getAccountInfo(pk) {
      this.reads.push(pk.toBase58());
      if (fail) throw new Error('fetch failed');
      if (pk.equals(CONFIG)) return { owner: PROGRAM, data, executable: false, lamports: 1 };
      return dest;
    },
  };
}
const burnArgs = (signer, over = {}) => ({ signer, chainId: S.chain.chainId, amountWei: 1_000n * XEN, tier: 0, x1: X1, confirmLast6: X1.slice(-6), feed: S.feed, prev: S.prev, now: () => S.now, allowBelowMarket: true, x1Connection: x1Conn(), ...over });

test('burnXen: approves the exact amount, re-quotes, burns, and checks the MissionStarted event', async () => {
  const signer = mockSigner();
  const steps = [];
  const r = await burnXen({ ...burnArgs(signer), onStep: (s) => steps.push(s) });
  assert.equal(r.burned, true, r.reason);
  assert.equal(r.missionId, 7n);
  assert.equal(signer.sent.length, 2);
  assert.equal(signer.sent[0].to, portalFor(S.chain.chainId).xen);
  assert.equal(signer.sent[0].data, encodeApprove(PORTAL, 1_000n * XEN), 'the approval is the exact amount, never unlimited');
  assert.equal(signer.sent[1].to, PORTAL);
  assert.deepEqual(steps, ['quote', 'approve', 'burn', 'sent']);
});

test('burnXen refuses before anything is signed: last-6 confirmation, wrong chain, a refused quote, the XEN balance', async () => {
  for (const [over, sig, re] of [
    [{ confirmLast6: 'xxxxxx' }, {}, /confirmLast6/],
    [{}, { chainId: 1 }, /signer is on chain 1/],
    [{ tier: 1 }, {}, /vesting/],
    [{}, { balance: 1n }, /holds 1 XEN wei/],
    [{ feed: null }, {}, /No binding quote/],
  ]) {
    const signer = mockSigner(sig);
    await assert.rejects(burnXen(burnArgs(signer, over)), (e) => { assert.ok(e instanceof BurnRefused); assert.match(e.message, re); return true; });
    assert.equal(signer.sent.length, 0, 'nothing sent');
  }
});

test('burnXen: a lower quote after the approval stops the burn (the approval stays, nothing is burned)', async () => {
  const signer = mockSigner();
  let calls = 0;
  // the second feed has a large burn just before ours on the same chain: less room left, a lower number
  const crowded = feedFromWorld(S.w, S.now);
  const c = crowded.chains.find((x) => x.chainId === S.chain.chainId);
  const tpl = c.burns.at(-1) ?? burnsOf(S.w.inputs).find((b) => b.chainId === S.chain.chainId);
  c.burns.push({ ...tpl, txHash: '0xcrowd', logIndex: 9_999_999, blockNumber: tpl.blockNumber + 1, timestamp: S.now - 30, amountWei: (10n ** 13n * XEN).toString(), tier: 0 });
  const getFeed = async () => (++calls === 1 ? S.feed : crowded);
  await assert.rejects(burnXen({ ...burnArgs(signer), feed: undefined, getFeed, allowBeyondCapacity: true, allowLargeShare: true }), /quote dropped|BurnRefused|remaining capacity/);
  assert.equal(signer.sent.length, 1, 'only the approval was sent');
});

test('burnXen: TRANSACTION_REPLACED — a repriced burn counts, a cancelled one does not', async () => {
  const repriced = mockSigner({ waitImpl: async (tx, hash) => { const e = new Error('replaced'); e.code = 'TRANSACTION_REPLACED'; e.reason = 'repriced'; e.replacement = { hash: hash + 'r' }; e.receipt = { hash: hash + 'r', status: 1, logs: [missionLog({ amount: 1_000n * XEN, tier: 0, x1: X1, pilot: '0x' + 'ab'.repeat(20) })] }; throw e; } });
  const r1 = await burnXen(burnArgs(repriced, { allowance: 0n }));
  assert.equal(r1.burned, true);
  assert.equal(r1.replaced.reason, 'repriced');
  const cancelled = mockSigner({ waitImpl: async () => { const e = new Error('cancelled'); e.code = 'TRANSACTION_REPLACED'; e.reason = 'cancelled'; e.cancelled = true; e.receipt = { status: 1, logs: [] }; throw e; } });
  const r2 = await burnXen(burnArgs(cancelled));
  assert.equal(r2.burned, false);
  assert.match(r2.reason, /cancelled/);
  const reverted = mockSigner({ waitImpl: async (tx, hash) => { const e = new Error('reverted'); e.code = 'CALL_EXCEPTION'; e.receipt = { hash, status: 0, logs: [] }; throw e; } });
  const r3 = await burnXen(burnArgs(reverted));
  assert.equal(r3.burned, false);
  assert.match(r3.reason, /reverted/);
});

test('planBurns: pieces that each fit and take at most half of what is left, the first one binding', () => {
  const p = planBurns({ feed: S.feed, prev: S.prev, chainId: S.chain.chainId, amountWei: 10n ** 12n * XEN, tier: 0, x1: X1, now: S.now });
  assert.ok(p.pieces.length >= 1, JSON.stringify(p));
  assert.equal(p.pieces[0].binding, true);
  assert.ok(p.pieces.slice(1).every((x) => !x.binding));
  const total = p.pieces.reduce((s, x) => s + BigInt(x.amountWei), 0n) + BigInt(p.rest);
  assert.equal(total, 10n ** 12n * XEN);
  const first = quoteBurn({ ...base(), amountWei: BigInt(p.pieces[0].amountWei) });
  assert.equal(first.ok, true, JSON.stringify(first.refusals));
});

// ─── review fixes (K-01 feed contract, K-02 oracle liveness, K-03 clock order, K-13 dated notices) ─────────────
test('the one feed schema: the example feed v1 parses, quotes the burn it carries to the lamport, and every derived field is the engine\'s', async () => {
  const { FEED_FIXTURE, buildFixture } = await import('../vectors/gen-week-so-far.mjs');
  const { fixtureInputs } = await import('./helpers-v3.mjs');
  const fx = JSON.parse(fs.readFileSync(FEED_FIXTURE, 'utf8'));
  const inputs = await fixtureInputs();
  assert.deepEqual(fx, JSON.parse(JSON.stringify(buildFixture(inputs))), 'the fixture is what the generator makes from the vectors (npm run vectors:feed)');
  assert.deepEqual(feedProblems(fx.feed, { now: fx.candidate.now }), []);
  const quote = (feed) => quoteBurn({ feed, prev: inputs.prev, allowBelowMarket: true, ...fx.candidate, amountWei: BigInt(fx.candidate.amountWei) });
  const q = quote(fx.feed);
  assert.equal(q.ok, true, JSON.stringify(q.refusals));
  assert.equal(String(q.bindingNow), fx.expected.bindingNow);
  // the site's fields are present (WeekSoFarFeed in frontend/src/lib/quote.ts) and the kit's raw ones too
  for (const k of ['prevDataHash', 'prevEpoch', 'capacity', 'skipped', 'readings']) assert.ok(k in fx.feed, k);
  for (const k of ['floorE18', 'buildE18', 'twapE18', 'apiE18', 'current']) assert.ok(k in fx.feed.xnt, `xnt.${k}`);
  for (const c of fx.feed.chains) for (const k of ['Lprev', 'Lnow', 'S', 'hour', 'hourSpot', 'capE18', 'spotE18', 'burns', 'market', 'liquidityNowMicro', 'current']) assert.ok(k in c, `chain ${c.chainId}.${k}`);
  // a derived field that disagrees with the raw window: no quote
  const bad = structuredClone(fx.feed);
  bad.capacity.senior = String(BigInt(bad.capacity.senior) + 1n);
  assert.match(quote(bad).refusals[0].text, /derived fields disagree with its raw window.*capacity\.senior/);
  const badCap = structuredClone(fx.feed);
  badCap.chains.find((c) => c.chainId === fx.candidate.chainId).capE18 = '1';
  assert.match(quote(badCap).refusals[0].text, /capE18/);
});

test('feed v1: continuity with epoch n − 1, the site\'s twins (prevDataHash, skipped[], readings), no quote from derived fields alone', () => {
  if (S.feed.epoch > 1) {
    const gap = { ...S.feed, prevEpoch: { ...S.feed.prevEpoch, epoch: S.feed.epoch - 2 } };
    assert.ok(feedProblems(gap, { now: S.now }).some((p) => /does not continue its previous epoch/.test(p)));
    const siteForm = { ...S.feed, prevEpoch: undefined, prevDataHash: S.feed.prevEpoch.dataHash };
    assert.deepEqual(normalizeFeed(siteForm).feed.prevEpoch, S.feed.prevEpoch, 'prevDataHash stands for epoch n − 1');
    assert.equal(quoteBurn({ ...base(), feed: siteForm }).ok, true);
    assert.ok(feedProblems({ ...S.feed, prevDataHash: '00'.repeat(32) }, { now: S.now }).some((p) => /two different previous data hashes/.test(p)));
    assert.ok(feedProblems({ ...S.feed, prevEpoch: null }, { now: S.now }).some((p) => /names no previous epoch/.test(p)));
  }
  assert.ok(feedProblems({ ...S.feed, skipped: [S.chain.chainId] }, { now: S.now }).some((p) => /in skipped\[\] but its status is ok/.test(p)));
  const listed = { ...S.feed, skipped: [S.chain.chainId], chains: S.feed.chains.map((c) => (c.chainId === S.chain.chainId ? { ...c, status: undefined } : c)) };
  assert.match(quoteBurn({ ...base(), feed: listed }).refusals[0].text, /skipped this week/);
  // readings in the site's form stand in for `current`; disagreeing twins are refused
  const cur = S.feed.chains.find((c) => c.chainId === S.chain.chainId).current;
  const xcur = S.feed.xnt.current;
  const readings = { hour: cur.hour, xen: { [S.chain.chainId]: [cur.medianE18, cur.lastCloseE18] }, xnt: [xcur.medianE18, xcur.lastCloseE18] };
  const viaReadings = { ...S.feed, readings, xnt: { ...S.feed.xnt, current: undefined }, chains: S.feed.chains.map((c) => (c.chainId === S.chain.chainId ? { ...c, current: undefined } : c)) };
  const q = quoteBurn({ ...base(), feed: viaReadings });
  assert.equal(q.ok, true, JSON.stringify(q.refusals));
  assert.equal(q.bindingNow, quoteBurn(base()).bindingNow);
  assert.ok(feedProblems({ ...S.feed, readings: { ...readings, xnt: [xcur.lastCloseE18, xcur.medianE18 + '1'] } }, { now: S.now }).some((p) => /readings\.xnt and xnt\.current disagree/.test(p)));
  // derived fields only (the site's minimum): the kit cannot value the window and refuses
  const derivedOnly = { ...S.feed, chains: S.feed.chains.map(({ burns: _b, ...c }) => c) };
  assert.match(quoteBurn({ ...base(), feed: derivedOnly }).refusals[0].text, /carries no raw burns/);
});

test('the late-oracle refusal never depends on an optional argument: without `oracle` the window start (epoch n − 1 published) is used', () => {
  const old = { ...S.feed, window: { startTs: S.now - 20 * 86_400 } };
  assert.ok(codes(quoteBurn({ ...base(), feed: old })).includes('staleOracle'), 'no oracle passed: still refused');
  assert.ok(!codes(quoteBurn({ ...base(), feed: old, oracle: { lastPublishTs: S.now - 86_400 } })).includes('staleOracle'), 'the chain\'s reading wins when given');
  assert.ok(!codes(quoteBurn(base())).includes('staleOracle'));
});

test('clock order: no quote when this machine\'s clock is behind a burn already in the feed, or before the window', () => {
  const ahead = feedFromWorld(S.w, S.now);
  const c = ahead.chains.find((x) => x.chainId === S.chain.chainId);
  const tpl = c.burns.at(-1) ?? burnsOf(S.w.inputs).find((b) => b.chainId === S.chain.chainId);
  c.burns.push({ ...tpl, txHash: '0xahead', logIndex: 77, blockNumber: tpl.blockNumber + 5, timestamp: S.now + 300 });
  const q = quoteBurn({ ...base(), feed: ahead });
  assert.equal(q.ok, false);
  const r = q.refusals.find((x) => x.code === 'noQuote');
  assert.match(r.text, /clock .* is behind the feed/);
  assert.equal(r.override, null, 'nothing overrides it');
  const early = S.feed.window.startTs - 10;
  const before = quoteBurn({ ...base(), feed: { ...feedFromWorld(S.w, early), asOf: early }, now: early });
  assert.ok(before.refusals.some((x) => /before the window start/.test(x.text)), JSON.stringify(before.refusals));
});

test('a quarantined or sunset chain is never priced on a stale hour, even with allowStaleOracle', () => {
  for (const status of ['quarantined', 'sunset']) {
    const f = feedFromWorld(S.w, S.now, { statuses: { [S.chain.chainId]: status } });
    // a sunset (orphaned, D-21) chain has no XEN market: its burns take the orphan price, so its XNT readings are the ones that must be fresh
    if (status === 'sunset') f.xnt.current.hour -= 1;
    else f.chains.find((c) => c.chainId === S.chain.chainId).current.hour -= 1;
    const q = quoteBurn({ ...base(), feed: f, allowStaleOracle: true });
    assert.equal(q.ok, false);
    assert.ok(q.refusals.some((r) => /no price readings for the current hour/.test(r.text)), status);
  }
  // a chain the feed calls sunset while the previous file announces no orphaning: the engine refuses it, so no quote
  const f = feedFromWorld(S.w, S.now, { statuses: { [S.chain.chainId]: 'sunset' } });
  const q = quoteBurn({ ...base(), feed: f, allowStaleOracle: true });
  assert.equal(q.ok, false);
  assert.ok(q.refusals.some((r) => r.code === 'noQuote' && /orphan/.test(r.text)), JSON.stringify(q.refusals));
});

test('burnXen reads X1 itself: x1Connection is required, the oracle\'s last publication comes from the chain, a failed read refuses', async () => {
  let signer = mockSigner();
  await assert.rejects(burnXen(burnArgs(signer, { x1Connection: undefined })), (e) => e instanceof BurnRefused && /pass x1Connection/.test(e.message));
  await assert.rejects(burnXen(burnArgs(signer, { x1Connection: x1Conn({ fail: true }) })), /could not be checked on X1/);
  const late = x1Conn({ lastPublishTs: S.now - 9 * 86_400 });
  await assert.rejects(burnXen(burnArgs(signer, { x1Connection: late, oracle: { lastPublishTs: S.now } })), (e) => e.refusals.some((r) => r.code === 'staleOracle'), 'a fresh caller value never hides a late oracle on chain');
  const token = x1Conn({ dest: { owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), executable: false, data: Buffer.alloc(165), lamports: 1 } });
  await assert.rejects(burnXen(burnArgs(signer, { x1Connection: token })), /not a wallet/);
  assert.equal(signer.sent.length, 0, 'nothing signed in any of these');
  signer = mockSigner();
  const conn = x1Conn();
  const r = await burnXen(burnArgs(signer, { x1Connection: conn }));
  assert.equal(r.burned, true);
  assert.ok(conn.reads.includes(CONFIG.toBase58()), 'the Config account was read');
});

test('notices about the v3 rules carry their date (WORDING §1): the planned month until the switch is announced', () => {
  assert.equal(V3_SWITCH, null);
  assert.match(V3_FROM, /planned for November 2026, announced at least one full epoch ahead/);
  assert.ok(NOTICES.etiquette.startsWith(V3_FROM));
  assert.ok(NOTICES_V3.forge.includes(`${V3_FROM}, each week the extra pot`));
});

test('r7 audit F16: the kit states the rebate bound in the WORDING form (1% caps the counted use, the rebate reaches at most 2%)', () => {
  assert.ok(NOTICES_V3.forge.includes('counted use is at most 1% of the price paid per eligible Artifact per week'));
  assert.ok(NOTICES_V3.forge.includes('the rebate at most 2 XNT per counted XNT, so at most 2% of the price paid per Artifact per week'));
  assert.ok(NOTICES_V3.forge.includes('counting only burns whose X1 destination is the wallet that holds the Artifact'));
  assert.ok(NOTICES_V3.forge.includes('only in the first 52 weeks after the forge'));
  assert.doesNotMatch(NOTICES_V3.forge, /at most 1% of the price paid per Artifact per week|own forge contribution|2× what/);
});

// ── round 4 (2026-10-25): the feed's route and xdex, the frozen L, the operator wallets, the derived senior ──────
test('the oracle\'s route and xdex (FEED CONTRACT) make the below-market check by default: no allowBelowMarket needed', () => {
  // the shapes oracle/src/pricing.ts XenRouteV3 and rewards.ts XdexReadingV3 write every hour
  const xdex = { pool: 'CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR', slot: 5, wxntReserveLamports: '18000000000000', usdcReserveMicro: '4900000000', feeBps: 28 };
  const thin = { pool: `0x${'11'.repeat(20)}`, xenReserveWei: (10n ** 15n * XEN).toString(), quoteReserveMicro: '2000000', feeBps: 30, bridgeFeeMicro: '1000000', bridgeMinMicro: '10000000' };
  const q = quoteBurn({ ...base({ allowBelowMarket: false }), feed: feedFromWorld(S.w, S.now, { route: thin, xdex }) });
  assert.equal(q.ok, true, JSON.stringify(q.refusals));
  assert.equal(q.marketRoute, 0n, 'selling 1,000 XEN into a thin pool fetches less than the bridge minimum');
  assert.ok(!codes(q).includes('belowMarket'));
  // a deep pool that pays more than the burn: refused, and the check names the market number
  const deep = { ...thin, xenReserveWei: (10n ** 3n * XEN).toString(), quoteReserveMicro: (10n ** 12n).toString() };
  const d = quoteBurn({ ...base({ allowBelowMarket: false }), feed: feedFromWorld(S.w, S.now, { route: deep, xdex }) });
  assert.ok(codes(d).includes('belowMarket'), JSON.stringify(codes(d)));
  assert.match(d.refusals.find((r) => r.code === 'belowMarket').text, /selling the XEN now/);
  // a malformed reserve is a feed problem (fail closed), never a silent "unknown"
  assert.ok(feedProblems(feedFromWorld(S.w, S.now, { route: { ...thin, xenReserveWei: '1e30' }, xdex }), { now: S.now }).some((p) => /route is not/.test(p)));
  assert.ok(feedProblems(feedFromWorld(S.w, S.now, { route: thin, xdex: { ...xdex, usdcReserveMicro: -1 } }), { now: S.now }).some((p) => /xdex is not/.test(p)));
});

test('D-13: no binding quote on a chain whose L is set only at the weekly build (the first week, no previous file)', () => {
  const w = loadVectors().worlds.find((x) => x.prev === null && x.expected && x.solo);
  const b = burnsOf(w.inputs)[0];
  const now = (Math.floor(b.timestamp / HOUR) + 1) * HOUR + 600;
  const q = quoteBurn({ feed: feedFromWorld(w, now), prev: null, chainId: b.chainId, amountWei: 1_000n * XEN, tier: 0, x1: X1, now, allowBelowMarket: true });
  assert.equal(q.ok, false);
  assert.equal(q.bindingNow, undefined, 'no number at all');
  assert.match(q.refusals.find((r) => r.code === 'noQuote').text, /set only at the weekly build \(rule "genesis"/);
  assert.equal(quoteBurn(base()).ok, true, 'the frozen L of a v3 previous file is binding');
});

test('D-18: an operator wallet gets no binding quote; a wallet inside its dated, published exception is quoted as any burn', () => {
  const rb = (ow) => ({ ...JSON.parse(JSON.stringify(DEFAULT_RULES_V3)), operatorWallets: ow });
  const listed = { ...S.feed, rulesBlock: rb({ rule: 'rank-last', wallets: [X1], exceptions: [] }) };
  const q = quoteBurn({ ...base(), feed: listed });
  assert.equal(q.ok, false);
  assert.equal(q.bindingNow, undefined);
  assert.ok(codes(q).includes('operatorWallet'));
  assert.equal(q.refusals.find((r) => r.code === 'operatorWallet').override, null, 'nothing overrides it');
  const fromTs = S.now - 3_600;
  const exception = { name: 'proof burns (test)', wallets: [X1], fromTs, untilTs: S.now + 3_600, published: new Date(fromTs * 1000).toISOString().slice(0, 10) };
  const inside = quoteBurn({ ...base(), feed: { ...S.feed, rulesBlock: rb({ rule: 'rank-last', wallets: [], exceptions: [exception] }) } });
  assert.equal(inside.ok, true, JSON.stringify(inside.refusals));
  assert.equal(inside.bindingNow, quoteBurn(base()).bindingNow);
  const outside = quoteBurn({ ...base(), feed: { ...S.feed, rulesBlock: rb({ rule: 'rank-last', wallets: [], exceptions: [{ ...exception, untilTs: S.now - 60 }] }) } });
  assert.ok(codes(outside).includes('operatorWallet'), 'outside its range the same wallet ranks last');
  // a rules block the kit does not implement (another tie-break) is a feed problem
  assert.ok(feedProblems({ ...S.feed, rulesBlock: { ...rb({ rule: 'rank-last', wallets: [], exceptions: [] }), tieBreak: 'chainId' } }, { now: S.now }).some((p) => /rules block/.test(p)));
});

test('the derived fields the website reads (supersetFeed) are checked against the raw window: capacity.senior is the window\'s own burns', () => {
  const full = supersetFeed(S.feed, S.prev);
  const q = quoteBurn({ ...base(), feed: full });
  assert.equal(q.ok, true, JSON.stringify(q.refusals));
  assert.equal(q.bindingNow, quoteBurn(base()).bindingNow);
  for (const bad of [{ capacity: { ...full.capacity, senior: String(BigInt(full.capacity.senior) + 1n) } }, { capacity: { ...full.capacity, cash: String(BigInt(full.capacity.cash) + 1n) } }]) {
    const r = quoteBurn({ ...base(), feed: { ...full, ...bad } });
    assert.match(r.refusals.find((x) => x.code === 'noQuote').text, /derived fields disagree/);
  }
  const lprev = { ...full, chains: full.chains.map((c) => (c.chainId === S.chain.chainId ? { ...c, Lprev: '1' } : c)) };
  assert.match(quoteBurn({ ...base(), feed: lprev }).refusals.find((x) => x.code === 'noQuote').text, /Lprev/);
});