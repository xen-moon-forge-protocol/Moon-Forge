// node --test: the guarded EVM signer with a fake RPC and a fake key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardedSigner, GuardRefused, gweiToWei, priceCheck } from '../src/evm-guard.mjs';
import { Journal } from '../src/journal.mjs';
import { fakeKey, fakeRpc } from './helpers.mjs';

const gas = { maxFeePerGasGwei: 5, gasLimitHeadroomBps: 12_500, confirmations: 1, txTimeoutSeconds: 1, extraFeeWei: 0n };
const limits = { maxGasCostWei: 10n ** 16n, keepNativeReserveWei: 10n ** 15n };
const APPROVE = { to: '0x0000000000000000000000000000000000000001', data: '0x095ea7b3' + '00'.repeat(64) };
const make = (over = {}, extra = {}) => {
  const rpc = fakeRpc(over);
  const journal = new Journal(null);
  return { rpc, journal, signer: guardedSigner({ chainId: 10, rpc, key: fakeKey, journal, gas, limits, pollMs: 1, ...extra }) };
};

test('gwei conversion and the fee cap', () => {
  assert.equal(gweiToWei(0.5), 500_000_000n);
  assert.equal(gweiToWei(5), 5_000_000_000n);
  const ok = priceCheck({ fee: { maxFeePerGas: 2n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }, gasLimit: 100_000n, gas, limits });
  assert.equal(ok.ok, true);
  assert.equal(ok.costWei, 2n * 10n ** 14n);
  assert.match(priceCheck({ fee: { maxFeePerGas: 6n * 10n ** 9n }, gasLimit: 1n, gas, limits }).why, /above the cap/);
  assert.match(priceCheck({ fee: { maxFeePerGas: null, gasPrice: 10n ** 9n }, gasLimit: 10n ** 8n, gas, limits }).why, /maxGasCostNative/);
  assert.deepEqual(priceCheck({ fee: { maxFeePerGas: null, gasPrice: 10n ** 9n }, gasLimit: 1n, gas, limits }).fees, { gasPrice: 10n ** 9n });
  assert.match(priceCheck({ fee: { maxFeePerGas: null, gasPrice: null }, gasLimit: 1n, gas, limits }).why, /no fee data/);
});

test('a send: simulated, priced, nonce from the chain, journaled before broadcast, then confirmed', async () => {
  const { rpc, journal, signer } = make();
  const tx = await signer.sendTransaction(APPROVE);
  assert.equal(tx.nonce, 5);
  assert.equal(rpc.st.sent.length, 1);
  const [e] = journal.data.sends;
  assert.equal(e.state, 'broadcast');
  assert.equal(e.kind, 'approve');
  rpc.st.receipts.set(tx.hash, { status: 1, blockNumber: 100, logs: [] });
  const rc = await tx.wait(1);
  assert.equal(rc.status, 1);
  assert.equal(journal.data.sends[0].state, 'mined');
  // a lagging node still reports nonce 5: the guard never reuses it
  const tx2 = await signer.sendTransaction({ ...APPROVE, data: '0xabcdef00' });
  assert.equal(tx2.nonce, 6);
  assert.equal(journal.data.sends[1].kind, 'enterForge');
});

test('refusals: kill switch, wrong chain, pending mempool, revert, fee cap, native balance, open journal entry', async () => {
  await assert.rejects(make({}, { killSwitch: () => 'STOP file' }).signer.sendTransaction(APPROVE), (e) => e instanceof GuardRefused && e.code === 'killSwitch');
  await assert.rejects(make({ chainId: 8453n }).signer.sendTransaction(APPROVE), (e) => e.code === 'chain');
  await assert.rejects(make({ pending: 6n }).signer.sendTransaction(APPROVE), (e) => e.code === 'mempool');
  await assert.rejects(make({ revert: true }).signer.sendTransaction(APPROVE), (e) => e.code === 'simulation');
  await assert.rejects(make({ fee: { maxFeePerGas: 50n * 10n ** 9n, maxPriorityFeePerGas: 1n } }).signer.sendTransaction(APPROVE), (e) => e.code === 'gas');
  await assert.rejects(make({ balance: 10n ** 14n }).signer.sendTransaction(APPROVE), (e) => e.code === 'nativeBalance');
  const s = make();
  s.journal.openSend({ chainId: 10, kind: 'approve', nonce: '5', hash: 'h:known' });
  s.rpc.st.known.add('h:known');
  await assert.rejects(s.signer.sendTransaction(APPROVE), (e) => e.code === 'notFinal');
  for (const x of [s]) assert.equal(x.rpc.st.sent.length, 0, 'nothing broadcast');
});

test('reconcile settles what an earlier run left open', async () => {
  const s = make({ latest: 7n, pending: 7n });
  const mined = s.journal.openSend({ chainId: 10, kind: 'approve', nonce: '5', hash: 'h:a' });
  s.journal.updateSend(mined.id, { state: 'broadcast' });
  s.rpc.st.receipts.set('h:a', { status: 1, blockNumber: 90 });
  const gone = s.journal.openSend({ chainId: 10, kind: 'enterForge', nonce: '6', hash: 'h:b' });
  assert.deepEqual(await s.signer.reconcile(), []);
  assert.equal(s.journal.data.sends.find((e) => e.id === mined.id).state, 'mined');
  assert.equal(s.journal.data.sends.find((e) => e.id === gone.id).state, 'dropped');
});

test('a broadcast that errors is looked up by hash before anything is reported', async () => {
  const known = make({ broadcastFails: 'known' });
  const tx = await known.signer.sendTransaction(APPROVE);
  assert.equal(known.journal.data.sends[0].state, 'broadcast');
  assert.ok(tx.hash);
  const lost = make({ broadcastFails: true });
  await assert.rejects(lost.signer.sendTransaction(APPROVE), /not known to the RPC, nothing was sent/);
  assert.equal(lost.journal.data.sends[0].state, 'dropped');
  const again = await lost.signer.sendTransaction(APPROVE).catch((e) => e);
  assert.match(String(again.message), /not known/); // still failing, and with the same nonce: never skipped
  assert.equal(lost.journal.data.sends[1].nonce, '5');
});

test('a transaction replaced in the mempool reports TRANSACTION_REPLACED (the kit maps it to "not burned")', async () => {
  const s = make();
  const tx = await s.signer.sendTransaction(APPROVE);
  s.rpc.st.known.clear();
  s.rpc.st.latest = 6n;
  await assert.rejects(tx.wait(1), (e) => e.code === 'TRANSACTION_REPLACED' && e.cancelled === true);
  assert.equal(s.journal.data.sends[0].state, 'dropped');
});

test('a transaction not confirmed in time stays in the journal for the next tick', async () => {
  const s = make();
  const tx = await s.signer.sendTransaction(APPROVE);
  await assert.rejects(tx.wait(1), /not confirmed within/);
  assert.equal(s.journal.unresolved(10).length, 1);
});
