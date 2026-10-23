// node --test: the send path of the kit with a mocked connection (no network): pre-flight balance refusal,
// getSignatureStatuses polling after a confirmation timeout, InvalidTarget refetch-and-retry once, the compute-unit
// re-measure when the measured limit is too low for the state, and sends that fail in transit after the transaction
// was delivered (reported as sent when found, otherwise with the signature; never re-sent).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComputeBudgetProgram, Keypair, PublicKey, SendTransactionError, Transaction, TransactionExpiredTimeoutError, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { CU_LIMITS, cuExhausted, errorMessage, failoverConnection, limitFor, MoonForge, PROGRAM_ID, sendMayHaveLanded, setCuLimit, cuIx } from '../../moonforge.mjs';

const keypair = Keypair.generate();
const blockhash = Keypair.generate().publicKey.toBase58();
const programIx = () => new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) });
const sigOf = (tx) => bs58.encode(tx.signature);
const rawSig = (raw) => sigOf(Transaction.from(raw));

/** A minimal Anchor methods-builder stand-in: preInstructions + transaction(). */
function builder(tag = 'b') {
  return {
    tag, pre: [],
    preInstructions(ixs) { this.pre.push(...ixs); return this; },
    async transaction() { const tx = new Transaction(); tx.add(...this.pre, programIx()); return tx; },
  };
}

/** A mocked connection; `over` replaces any method. Records every raw transaction sent; returns its signature like an RPC. */
function mockConnection(over = {}) {
  const sent = [];
  const c = {
    sent, rpcEndpoint: 'mock://x1',
    async getLatestBlockhash() { return { blockhash, lastValidBlockHeight: 1000 }; },
    async getFeeForMessage() { return { value: 1_500 + 10 * 23_000 }; },
    async getBalance() { return 1_000_000_000; },
    async sendRawTransaction(raw) { const tx = Transaction.from(raw); sent.push(tx); return sigOf(tx); },
    async confirmTransaction() { return { value: { err: null } }; },
    async getSignatureStatuses() { return { value: [{ confirmationStatus: 'confirmed', err: null }] }; },
    async getTransaction() { return { meta: { logMessages: [] } }; },
    async simulateTransaction() { return { value: { err: null, unitsConsumed: 0, logs: [] } }; },
    ...over,
  };
  c.sent = sent;
  return c;
}
const kit = (connection) => {
  const mf = new MoonForge({ provider: { connection }, account: {}, idl: null }, keypair, { onWarning: (t) => mf.warnings.push(t) });
  mf.warnings = [];
  mf.pollOpts = { tries: 3, intervalMs: 1 };
  return mf;
};
const limitOf = (tx) => tx.instructions.find((ix) => ix.programId.equals(ComputeBudgetProgram.programId)).data.readUInt32LE(1);

test('every send carries the measured limit of its instruction and returns the transaction signature', async () => {
  const c = mockConnection();
  assert.equal(await kit(c).send(builder(), 'openPlayer'), sigOf(c.sent[0]));
  assert.equal(c.sent.length, 1);
  assert.equal(limitOf(c.sent[0]), CU_LIMITS.openPlayer);
  assert.equal(c.sent[0].instructions.filter((ix) => ix.programId.equals(ComputeBudgetProgram.programId)).length, 1);
});

test('pre-flight: a wallet that cannot cover fee + rent + amount is refused and nothing is sent', async () => {
  const c = mockConnection({ async getBalance() { return 100_000; } });
  await assert.rejects(kit(c).send(builder(), 'deposit', { needLamports: 50_000_000n }), (e) => {
    assert.match(e.message, /pre-flight: the wallet holds 0\.0001 XNT/);
    assert.match(e.message, /Nothing was sent/);
    return true;
  });
  assert.equal(c.sent.length, 0);
});

test('pre-flight: fee + rent exactly covered passes', async () => {
  const fee = 1_500 + 10 * 23_000, rent = 1_000_000;
  const c = mockConnection({ async getBalance() { return fee + rent; } });
  assert.equal(await kit(c).send(builder(), 'openPlayer', { needLamports: BigInt(rent) }), sigOf(c.sent[0]));
});

test('confirmation timeout: getSignatureStatuses finds the landed transaction', async () => {
  let polls = 0;
  const c = mockConnection({
    async confirmTransaction() { throw new TransactionExpiredTimeoutError('x', 30); },
    async getSignatureStatuses() { polls++; return { value: [polls < 2 ? null : { confirmationStatus: 'confirmed', err: null }] }; },
  });
  assert.equal(await kit(c).send(builder(), 'withdraw'), sigOf(c.sent[0]));
  assert.equal(polls, 2);
  assert.equal(c.sent.length, 1, 'never re-sent');
});

test('confirmation timeout: still unknown after polling -> error with the signature and the explorer link, not re-sent', async () => {
  const c = mockConnection({
    async confirmTransaction() { throw new Error('Transaction was not confirmed in 30.00 seconds'); },
    async getSignatureStatuses() { return { value: [null] }; },
  });
  await assert.rejects(kit(c).send(builder(), 'withdraw'), (e) => {
    const sig = sigOf(c.sent[0]);
    assert.equal(e.signature, sig);
    assert.equal(e.mayHaveLanded, true);
    assert.ok(e.message.includes(`explorer.mainnet.x1.xyz/tx/${sig}`));
    assert.match(e.message, /may still land/);
    return true;
  });
  assert.equal(c.sent.length, 1);
});

test('confirmation: an RPC failure while waiting (not a timeout) is polled too, never reported without the signature', async () => {
  let polls = 0;
  const c = mockConnection({
    async confirmTransaction() { throw new TypeError('fetch failed'); },
    async getSignatureStatuses() { if (++polls === 1) throw new TypeError('fetch failed'); return { value: [{ confirmationStatus: 'confirmed', err: null }] }; },
  });
  assert.equal(await kit(c).send(builder(), 'houseDeposit'), sigOf(c.sent[0]));
  assert.equal(c.sent.length, 1);
});

test('confirmation timeout: a polled on-chain failure is reported as a failure', async () => {
  const c = mockConnection({
    async confirmTransaction() { throw new TransactionExpiredTimeoutError('x', 30); },
    async getSignatureStatuses() { return { value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [1, { Custom: 6035 }] } }] }; },
  });
  await assert.rejects(kit(c).send(builder(), 'houseWithdraw'), /failed on-chain/);
});

const invalidTarget = () => Object.assign(new Error('Simulation failed'), {
  logs: ['Program log: AnchorError occurred. Error Code: InvalidTarget. Error Number: 6047. Error Message: Invalid target account.'],
});

test('InvalidTarget: the builder is rebuilt from fresh state and re-sent once', async () => {
  let sends = 0, rebuilds = 0;
  const c = mockConnection({
    async sendRawTransaction(raw) { sends++; if (sends === 1) throw invalidTarget(); c.sent.push(Transaction.from(raw)); return rawSig(raw); },
  });
  const mf = kit(c);
  const sig = await mf.send(builder('stale'), 'forgeArtifact', { rebuild: async () => { rebuilds++; return builder('fresh'); } });
  assert.equal(sig, sigOf(c.sent[0]));
  assert.equal(rebuilds, 1);
  assert.equal(limitOf(c.sent[0]), CU_LIMITS.forgeArtifact, 'the rebuilt builder keeps its limit');
  assert.ok(mf.warnings.some((w) => /InvalidTarget.*retrying once/.test(w)));
});

test('InvalidTarget twice: one retry only, then the error', async () => {
  let rebuilds = 0;
  const c = mockConnection({ async sendRawTransaction() { throw invalidTarget(); } });
  await assert.rejects(kit(c).send(builder(), 'forgeArtifact', { rebuild: async () => { rebuilds++; return builder(); } }), (e) => /InvalidTarget/.test(JSON.stringify(e.logs ?? e.message) + (e.error?.errorCode?.code ?? '')));
  assert.equal(rebuilds, 1);
});

test('InvalidTarget without a rebuild function is not retried', async () => {
  let sends = 0;
  const c = mockConnection({ async sendRawTransaction() { sends++; throw invalidTarget(); } });
  await assert.rejects(kit(c).send(builder(), 'recycleArtifact'));
  assert.equal(sends, 1);
});

test('limit too low for this state: simulated once uncapped, re-sent with the measurement x1.2', async () => {
  let sends = 0;
  const simulated = [];
  const c = mockConnection({
    async sendRawTransaction(raw) {
      sends++;
      const tx = Transaction.from(raw);
      if (sends === 1) {
        throw Object.assign(new Error('Transaction simulation failed: Error processing Instruction 1: Computational budget exceeded'), {
          logs: [`Program ${PROGRAM_ID.toBase58()} consumed 23000 of 23000 compute units`, `Program ${PROGRAM_ID.toBase58()} failed: exceeded CUs meter at BPF instruction`],
        });
      }
      c.sent.push(tx);
      return sigOf(tx);
    },
    async simulateTransaction(tx) { simulated.push(limitOf(tx)); return { value: { err: null, unitsConsumed: 24_650, logs: [] } }; },
  });
  const mf = kit(c);
  assert.equal(await mf.send(builder(), 'openPlayer'), sigOf(c.sent[0]));
  assert.deepEqual(simulated, [1_400_000], 'measured once with the maximum limit');
  assert.equal(limitOf(c.sent[0]), 30_000, 'ceil(24,650 x 1.2 / 1000) x 1000');
  assert.ok(mf.warnings.some((w) => /too low for this state \(measured 24650\); retrying once with 30000/.test(w)));
});

// ─── sends that fail in transit (M1: no false failure, no double submit) ─────
/**
 * Two endpoints behind the kit's real failover. Endpoint A forwards the transaction to the network and then drops
 * the HTTP response; `bSend` decides what endpoint B answers to the same bytes. `landed` = what reached the network.
 */
function failoverWorld({ bSend, aDelivers = true, statusFor = null }) {
  const c = failoverConnection(['http://a.invalid', 'http://b.invalid']);
  const landed = new Set(), sends = { a: 0, b: 0 };
  const result = (m, args) => {
    const ctx = { context: { slot: 1 } };
    if (m === 'getLatestBlockhash') return { ...ctx, value: { blockhash, lastValidBlockHeight: 100 } };
    if (m === 'getFeeForMessage') return { ...ctx, value: 181_500 };
    if (m === 'getBalance') return { ...ctx, value: 1_000_000_000 };
    if (m === 'getSignatureStatuses') {
      return { ...ctx, value: args[0].map((s) => (statusFor ? statusFor(s, landed) : landed.has(s) ? { slot: 1, confirmations: null, err: null, confirmationStatus: 'confirmed' } : null)) };
    }
    throw new Error(`unmocked ${m}`);
  };
  c.rpcFailover.conns[0]._rpcRequestOrig = async (m, args) => {
    if (m === 'sendTransaction') {
      sends.a++;
      if (aDelivers) landed.add(rawSig(Buffer.from(args[0], 'base64')));
      throw new TypeError('fetch failed');
    }
    return { jsonrpc: '2.0', id: '1', result: result(m, args) };
  };
  c.rpcFailover.conns[1]._rpcRequestOrig = async (m, args) => {
    if (m === 'sendTransaction') { sends.b++; return bSend(args, landed); }
    return { jsonrpc: '2.0', id: '1', result: result(m, args) };
  };
  return { c, landed, sends };
}
const alreadyProcessed = () => ({ jsonrpc: '2.0', id: '1', error: { code: -32002, message: 'Transaction simulation failed: This transaction has already been processed', data: { err: 'AlreadyProcessed', logs: [], accounts: null, unitsConsumed: 0 } } });

test('in transit, failover: A delivers then drops the response, B answers "already been processed" -> reported as sent, landed once', async () => {
  const { c, landed, sends } = failoverWorld({ bSend: alreadyProcessed });
  const mf = kit(c);
  const sig = await mf.send(builder(), 'placeBet');
  assert.equal(landed.size, 1, 'exactly one transaction landed');
  assert.ok(landed.has(sig), 'the call returns the signature that landed');
  assert.deepEqual(sends, { a: 1, b: 1 }, 'the same bytes, never a rebuilt transaction');
  assert.equal(mf.warnings.filter((w) => /reached the network/.test(w)).length, 1);
});

test('in transit, every endpoint drops the response after A delivered -> reported as sent, landed once', async () => {
  const { c, landed, sends } = failoverWorld({ bSend: () => { throw new TypeError('fetch failed'); } });
  const sig = await kit(c).send(builder(), 'forgeArtifact', { rebuild: async () => { throw new Error('must not rebuild'); } });
  assert.equal(landed.size, 1);
  assert.ok(landed.has(sig));
  assert.deepEqual(sends, { a: 1, b: 1 });
});

test('in transit, not found within the short check -> the error carries the signature, says it may have landed, and nothing is re-sent', async () => {
  const { c, landed, sends } = failoverWorld({ bSend: () => { throw new TypeError('fetch failed'); }, statusFor: () => null });
  let rebuilds = 0;
  await assert.rejects(kit(c).send(builder(), 'forgeArtifact', { rebuild: async () => { rebuilds++; return builder(); } }), (e) => {
    assert.equal(landed.size, 1);
    assert.equal(e.signature, [...landed][0]);
    assert.equal(e.mayHaveLanded, true);
    assert.match(e.message, /may have landed: check the signature on the explorer before sending again/);
    const text = errorMessage(e);
    assert.match(text, /may have landed/);
    assert.ok(text.includes(e.signature), 'errorMessage names the signature to check');
    assert.doesNotMatch(text, /fails over to the next endpoint/, 'no invitation to simply resend');
    return true;
  });
  assert.equal(rebuilds, 0);
  assert.deepEqual(sends, { a: 1, b: 1 });
});

test('in transit, "already been processed" but not visible yet -> error with the signature, errorMessage says do not send again', async () => {
  const { c } = failoverWorld({ bSend: alreadyProcessed, statusFor: () => null });
  await assert.rejects(kit(c).send(builder(), 'placeBet'), (e) => {
    assert.ok(e.signature && e.mayHaveLanded);
    assert.match(errorMessage(e), /already processed this transaction.*Do not send it again.*check the signature/);
    return true;
  });
});

test('in transit, failover: B refuses in its own pre-flight after A failed mid-send -> polled first; the refusal keeps its program error plus the signature', async () => {
  const refusal = () => ({ jsonrpc: '2.0', id: '1', error: { code: -32002, message: 'Transaction simulation failed: Error processing Instruction 1: custom program error: 0x179f', data: { err: { InstructionError: [1, { Custom: 6047 }] }, logs: ['Program log: AnchorError occurred. Error Code: InvalidTarget. Error Number: 6047. Error Message: Invalid target account.'] } } });
  const { c, sends } = failoverWorld({ bSend: refusal, aDelivers: false });
  let rebuilds = 0;
  await assert.rejects(kit(c).send(builder(), 'forgeArtifact', { rebuild: async () => { rebuilds++; return builder(); } }), (e) => {
    assert.equal(e.mayHaveLanded, true);
    assert.ok(e.signature);
    const text = errorMessage(e);
    assert.match(text, /InvalidTarget, 6047/);
    assert.match(text, /may have landed anyway: check the signature/);
    return true;
  });
  assert.equal(rebuilds, 0, 'A may have delivered it: no automatic retry');
  assert.deepEqual(sends, { a: 1, b: 1 });
});

test('in transit, single endpoint: a dropped response is looked up; found -> sent, not found -> signature', async () => {
  let delivered = 0;
  const found = mockConnection({
    async sendRawTransaction(raw) { delivered++; found.sent.push(Transaction.from(raw)); throw new TypeError('fetch failed'); },
  });
  assert.equal(await kit(found).send(builder(), 'houseDeposit'), sigOf(found.sent[0]));
  assert.equal(delivered, 1);

  const lost = mockConnection({
    async sendRawTransaction(raw) { lost.sent.push(Transaction.from(raw)); throw new TypeError('fetch failed'); },
    async getSignatureStatuses() { return { value: [null] }; },
  });
  await assert.rejects(kit(lost).send(builder(), 'houseDeposit'), (e) => {
    assert.equal(e.signature, sigOf(lost.sent[0]));
    assert.match(errorMessage(e), /RPC unreachable .*after the transaction was signed: it may have landed: check the signature/);
    return true;
  });
  assert.equal(lost.sent.length, 1);
});

test('a plain pre-flight refusal from the only endpoint is not polled and carries no landing warning', async () => {
  let polls = 0;
  const c = mockConnection({
    async sendRawTransaction() { throw invalidTarget(); },
    async getSignatureStatuses() { polls++; return { value: [null] }; },
  });
  await assert.rejects(kit(c).send(builder(), 'recycleArtifact'), (e) => {
    assert.notEqual(e.mayHaveLanded, true);
    assert.doesNotMatch(errorMessage(e), /may have landed/);
    return true;
  });
  assert.equal(polls, 0);
});

test('sendMayHaveLanded: transport failures and "already processed" yes; RPC refusals no', () => {
  assert.equal(sendMayHaveLanded(new TypeError('fetch failed')), true);
  assert.equal(sendMayHaveLanded(new Error('503 Service Unavailable: upstream')), true);
  assert.equal(sendMayHaveLanded(new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: This transaction has already been processed', logs: [] })), true);
  assert.equal(sendMayHaveLanded(new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: Blockhash not found', logs: [] })), false);
  assert.equal(sendMayHaveLanded(invalidTarget()), false);
  assert.equal(sendMayHaveLanded(new Error('failed to send transaction: custom program error: 0x1793')), false);
});

test('compute-budget helpers', () => {
  assert.equal(cuExhausted(new Error('Error processing Instruction 1: Computational budget exceeded')), true);
  assert.equal(cuExhausted({ err: { InstructionError: [1, 'ComputationalBudgetExceeded'] } }), true);
  assert.equal(cuExhausted({ logs: ['Program X failed: exceeded CUs meter at BPF instruction'] }), true);
  assert.equal(cuExhausted(new Error('custom program error: 0x179f')), false);
  assert.equal(limitFor(45_443), 55_000);
  assert.equal(limitFor(1_000), 2_000);
  assert.equal(limitFor(5_000_000), 1_400_000);
  const tx = new Transaction().add(cuIx(23_000), programIx());
  assert.equal(limitOf(setCuLimit(tx, 30_000)), 30_000);
  assert.equal(tx.instructions.length, 2, 'replaced, not added');
  const bare = new Transaction().add(programIx());
  assert.equal(limitOf(setCuLimit(bare, 9_000)), 9_000);
  assert.ok(bare.instructions[0].programId.equals(ComputeBudgetProgram.programId), 'added first');
  assert.ok(new PublicKey(PROGRAM_ID).equals(bare.instructions[1].programId));
});
