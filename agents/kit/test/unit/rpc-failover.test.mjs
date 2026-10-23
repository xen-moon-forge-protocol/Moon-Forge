// node --test: the endpoint list, the cluster (genesis) check and the JSON-RPC failover (first endpoint down -> second
// answers), with one warning per switch and status() naming the endpoint that serves, origin only. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { checkRpcGenesis, failoverConnection, MoonForge, redactRpc, rpcConfig, rpcList, X1_MAINNET_GENESIS, X1_RPCS } from '../../moonforge.mjs';

const TESTNET = 'C7ucgdDEhxLTpXHhWSZxavSVmaNTUJWwT5iTdeaviDho';
const ok = (result) => ({ jsonrpc: '2.0', id: '1', result });
const down = async () => { throw new TypeError('fetch failed'); };

test('rpcList: an explicit rpc/rpcs list is used alone (X1_RPC_URLS is never merged into it); duplicates removed', () => {
  assert.deepEqual(rpcList({ env: {} }), [...X1_RPCS]);
  assert.deepEqual(rpcList({ rpc: 'http://a', env: {} }), ['http://a']);
  assert.deepEqual(rpcList({ rpc: 'http://a', rpcs: ['http://b', 'http://a'], env: { X1_RPC_URLS: ' http://c ,http://b, ' } }), ['http://a', 'http://b']);
  assert.deepEqual(rpcList({ rpc: 'https://rpc.testnet.x1.xyz', env: { X1_RPC_URLS: 'https://rpc.mainnet.x1.xyz' } }), ['https://rpc.testnet.x1.xyz'], 'the reported cross-cluster case');
  assert.deepEqual(rpcList({ env: { X1_RPC_URLS: ' http://c ,http://d, ' } }), ['http://c', 'http://d']);
  assert.equal(rpcConfig({ env: {} }).source, 'default');
  assert.equal(rpcConfig({ env: { X1_RPC_URLS: 'http://c' } }).source, 'env');
  assert.equal(rpcConfig({ rpcs: ['http://b'], env: { X1_RPC_URLS: 'http://c' } }).source, 'explicit');
});

test('redactRpc keeps the origin only: no path, query or credentials', () => {
  assert.equal(redactRpc('https://x1.example.com/v1/SECRETKEY?api-key=SECRET2'), 'https://x1.example.com');
  const withCredentials = Object.assign(new URL('https://x1.example.com:8443/'), { username: 'user', password: 'SECRET' }).href;
  assert.ok(withCredentials.includes('SECRET'));
  assert.equal(redactRpc(withCredentials), 'https://x1.example.com:8443');
  assert.equal(redactRpc('http://127.0.0.1:8899'), 'http://127.0.0.1:8899');
  assert.equal(redactRpc('not a url SECRET'), '(invalid RPC URL)');
});

test('checkRpcGenesis: an endpoint on another cluster is left out with one warning; a silent one stays unverified', async () => {
  const genesisOf = { 'https://a.example/k1': TESTNET, 'https://b.example/k2': X1_MAINNET_GENESIS, 'https://c.example': null, 'https://d.example': TESTNET };
  const warnings = [];
  const r = await checkRpcGenesis(Object.keys(genesisOf), {
    onWarning: (t) => warnings.push(t),
    getGenesis: async (u) => { if (!genesisOf[u]) throw new TypeError('fetch failed'); return genesisOf[u]; },
  });
  assert.equal(r.genesis, TESTNET, 'reference: the first endpoint that answers');
  assert.deepEqual(r.urls, ['https://a.example/k1', 'https://c.example', 'https://d.example']);
  assert.deepEqual(r.dropped, ['https://b.example/k2']);
  assert.deepEqual(r.unverified, ['https://c.example']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^RPC https:\/\/b\.example left out: it is on another cluster/);
  assert.doesNotMatch(warnings[0], /k2/, 'the warning names the origin only');
});

test('checkRpcGenesis: the built-in list must be on X1 mainnet (expected genesis wins over the first answer)', async () => {
  const warnings = [];
  const r = await checkRpcGenesis(['https://wrong.example', 'https://right.example'], {
    expected: X1_MAINNET_GENESIS, onWarning: (t) => warnings.push(t),
    getGenesis: async (u) => (u.includes('wrong') ? TESTNET : X1_MAINNET_GENESIS),
  });
  assert.deepEqual(r.urls, ['https://right.example']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /X1 mainnet/);
});

test('one endpoint: a plain Connection, nothing patched', () => {
  const c = failoverConnection(['http://127.0.0.1:1']);
  assert.equal(c.rpcEndpoint, 'http://127.0.0.1:1');
  assert.equal(c._rpcRequestOrig, undefined);
  assert.deepEqual(c.rpcFailover.urls, ['http://127.0.0.1:1']);
});

test('two endpoints: a transport failure on the first is served by the second, and the second becomes current', async () => {
  const c = failoverConnection(['http://127.0.0.1:1', 'http://127.0.0.1:2']);
  const calls = [];
  c.rpcFailover.conns[0]._rpcRequestOrig = async (method) => { calls.push(`0:${method}`); throw new Error('fetch failed'); };
  c.rpcFailover.conns[1]._rpcRequestOrig = async (method) => { calls.push(`1:${method}`); return ok(4242); };
  assert.equal(await c.getSlot(), 4242);
  assert.deepEqual(calls, ['0:getSlot', '1:getSlot']);
  assert.equal(c.rpcFailover.current, 1);
  assert.equal(c.rpcFailover.failures.length, 1);
  assert.equal(c.rpcFailover.failures[0].url, 'http://127.0.0.1:1');
  // the next call starts on the endpoint that answered
  calls.length = 0;
  assert.equal(await c.getSlot(), 4242);
  assert.deepEqual(calls, ['1:getSlot']);
});

const tick = () => new Promise((r) => setImmediate(r));

test('a switch emits exactly one warning through MoonForge.onWarning; switching back to the first endpoint emits one more', async () => {
  const c = failoverConnection(['https://a.example/KEY-A', 'https://b.example/KEY-B'], 'confirmed', { retryPrimaryMs: 60_000 });
  let aUp = false;
  c.rpcFailover.conns[0]._rpcRequestOrig = async (m) => { if (!aUp) throw new TypeError('fetch failed'); return ok(m === 'getGenesisHash' ? X1_MAINNET_GENESIS : 1); };
  c.rpcFailover.conns[1]._rpcRequestOrig = async () => ok(2);
  const warnings = [];
  new MoonForge({ provider: { connection: c }, account: {}, idl: null }, Keypair.generate(), { onWarning: (t) => warnings.push(t) });
  for (let i = 0; i < 4; i++) assert.equal(await c.getSlot(), 2);
  assert.equal(warnings.length, 1, 'one warning for one switch, not one per request');
  assert.match(warnings[0], /^RPC failover: https:\/\/a\.example failed \(fetch failed\); now using https:\/\/b\.example$/);
  assert.ok(!warnings[0].includes('KEY'), 'origins only');
  // not sticky forever: after retryPrimaryMs the first endpoint gets a background probe; the request itself is still
  // served by the endpoint that works, and the next one goes back to the first
  aUp = true;
  c.rpcFailover.retryPrimaryMs = 0;
  assert.equal(await c.getSlot(), 2, 'this request does not wait on the probe');
  await tick();
  assert.equal(c.rpcFailover.current, 0);
  c.rpcFailover.retryPrimaryMs = 60_000;
  assert.equal(await c.getSlot(), 1);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /back on https:\/\/a\.example/);
});

test('the first endpoint still down (or hung) at the retry: one background probe at a time, no request waits on it, no extra warning', async () => {
  const c = failoverConnection(['http://a.invalid', 'http://b.invalid'], 'confirmed', { retryPrimaryMs: 0 });
  const aCalls = [];
  let hang = false;
  c.rpcFailover.conns[0]._rpcRequestOrig = (m) => { aCalls.push(m); return hang ? new Promise(() => {}) : Promise.reject(new TypeError('fetch failed')); };
  c.rpcFailover.conns[1]._rpcRequestOrig = async () => ok(2);
  const switches = [];
  c.rpcFailover.onSwitch = (s) => switches.push(s);
  assert.equal(await c.getSlot(), 2); // a fails, b serves: one switch
  hang = true; // a blackholed endpoint: its probe never answers
  assert.equal(await c.getSlot(), 2, 'served by b at once; the probe of a runs in the background');
  assert.equal(await c.getSlot(), 2, 'one probe in flight at a time');
  await tick();
  assert.deepEqual(aCalls, ['getSlot', 'getGenesisHash']);
  assert.equal(switches.length, 1);
  assert.equal(c.rpcFailover.current, 1);
});

test('a probe that finds the first endpoint on another cluster leaves it out for good', async () => {
  const c = failoverConnection(['http://a.invalid', 'http://b.invalid'], 'confirmed', { genesis: X1_MAINNET_GENESIS, retryPrimaryMs: 0 });
  let aDown = true;
  c.rpcFailover.conns[0]._rpcRequestOrig = async (m) => { if (aDown) throw new TypeError('fetch failed'); return ok(m === 'getGenesisHash' ? TESTNET : 1); };
  c.rpcFailover.conns[1]._rpcRequestOrig = async () => ok(2);
  const drops = [];
  c.rpcFailover.onDrop = (d) => drops.push(d);
  assert.equal(await c.getSlot(), 2);
  aDown = false; // it comes back, but as another cluster
  assert.equal(await c.getSlot(), 2);
  await tick();
  assert.equal(await c.getSlot(), 2);
  assert.equal(c.rpcFailover.dropped[0], true);
  assert.equal(c.rpcFailover.current, 1);
  assert.equal(drops.length, 1);
  assert.equal(drops[0].genesis, TESTNET);
});

test('an unverified endpoint on another cluster is left out before it serves anything (the reported testnet -> mainnet case)', async () => {
  const testnet = 'https://rpc.testnet.x1.xyz', mainnet = 'https://rpc.mainnet.x1.xyz';
  const c = failoverConnection([testnet, mainnet], 'confirmed', { genesis: TESTNET, unverified: [mainnet] });
  const served = [];
  c.rpcFailover.conns[0]._rpcRequestOrig = async (m) => { served.push(`testnet:${m}`); throw new TypeError('fetch failed'); };
  c.rpcFailover.conns[1]._rpcRequestOrig = async (m) => { served.push(`mainnet:${m}`); return ok(m === 'getGenesisHash' ? X1_MAINNET_GENESIS : 99); };
  const warnings = [];
  new MoonForge({ provider: { connection: c }, account: {}, idl: null }, Keypair.generate(), { onWarning: (t) => warnings.push(t) });
  await assert.rejects(c.getSlot(), /fetch failed/, 'the testnet blip is reported, never served by mainnet');
  assert.deepEqual(served, ['testnet:getSlot', 'mainnet:getGenesisHash'], 'mainnet was only asked for its genesis hash');
  assert.equal(c.rpcFailover.dropped[1], true);
  await assert.rejects(c.getSlot());
  assert.equal(warnings.filter((w) => /left out: it is on another cluster/.test(w)).length, 1);
  assert.equal(c.rpcFailover.current, 0);
});

test('an unverified endpoint on the same cluster is verified once, then serves', async () => {
  const c = failoverConnection(['http://a.invalid', 'http://b.invalid'], 'confirmed', { genesis: X1_MAINNET_GENESIS, unverified: ['http://b.invalid'] });
  const asked = [];
  c.rpcFailover.conns[0]._rpcRequestOrig = down;
  c.rpcFailover.conns[1]._rpcRequestOrig = async (m) => { asked.push(m); return ok(m === 'getGenesisHash' ? X1_MAINNET_GENESIS : 7); };
  assert.equal(await c.getSlot(), 7);
  assert.equal(await c.getSlot(), 7);
  assert.deepEqual(asked, ['getGenesisHash', 'getSlot', 'getSlot']);
});

test('status().rpc names the endpoint serving now, origin only, and status().cluster the checked cluster', async () => {
  const c = failoverConnection(['https://a.example/v1/KEY-A?api-key=SECRET-A', 'https://b.example/v1/KEY-B?api-key=SECRET-B'], 'confirmed', { genesis: X1_MAINNET_GENESIS });
  c.rpcFailover.conns[0]._rpcRequestOrig = down;
  c.rpcFailover.conns[1]._rpcRequestOrig = async (m) => ok(m === 'getBalance' ? { context: { slot: 1 }, value: 2_000_000_000 } : { context: { slot: 1 }, value: null });
  const mf = new MoonForge({ provider: { connection: c }, account: {}, idl: null }, Keypair.generate(), { onWarning: () => {} });
  Object.assign(mf, {
    config: async () => ({ rewardReserved: 0 }), gameBalance: async () => 0n, myArtifacts: async () => [], openWars: async () => [], xntUsd: async () => null,
    bankroll: async () => ({ unreserved: 0n, reserved: 0n, conservative: 0n, totalShares: 0n, haircutBps: 0 }), myPredictionEntries: async () => [], houseShare: async () => null,
  });
  const s = await mf.status();
  assert.equal(s.walletXnt, 2);
  assert.equal(s.rpc, 'https://b.example');
  assert.equal(s.cluster, 'X1 mainnet');
  assert.ok(!JSON.stringify(s).includes('SECRET') && !JSON.stringify(s).includes('KEY-'), 'no credential in status()');
});

test('every endpoint down: the last transport error is thrown', async () => {
  const c = failoverConnection(['http://127.0.0.1:1', 'http://127.0.0.1:2']);
  c.rpcFailover.conns[0]._rpcRequestOrig = async () => { throw new Error('ECONNREFUSED one'); };
  c.rpcFailover.conns[1]._rpcRequestOrig = async () => { throw new Error('ECONNREFUSED two'); };
  await assert.rejects(c.getSlot(), /ECONNREFUSED two/);
});

test('a JSON-RPC error body (not a transport failure) is not retried on the next endpoint', async () => {
  const c = failoverConnection(['http://127.0.0.1:1', 'http://127.0.0.1:2']);
  let second = 0;
  c.rpcFailover.conns[0]._rpcRequestOrig = async () => ({ jsonrpc: '2.0', id: '1', error: { code: -32602, message: 'Invalid param: WrongSize' } });
  c.rpcFailover.conns[1]._rpcRequestOrig = async () => { second++; return ok(1); };
  await assert.rejects(c.getSlot(), /Invalid param/);
  assert.equal(second, 0);
});
