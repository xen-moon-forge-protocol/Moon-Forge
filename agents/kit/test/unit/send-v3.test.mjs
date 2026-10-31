// node --test: the send-path additions of kit 2.0.0 with a mocked connection (no network): an instruction without a
// measured limit is simulated first and sent with that measurement x1.2 (a refusal there is the program error, nothing
// sent); the priority fee instruction; the rebroadcast of the same signed bytes until the confirmation arrives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComputeBudgetProgram, Keypair, Transaction, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { limitFor, MoonForge, PROGRAM_ID, programErrorName } from '../../moonforge.mjs';

const keypair = Keypair.generate();
const blockhash = Keypair.generate().publicKey.toBase58();
const builder = () => ({
  pre: [],
  preInstructions(ixs) { this.pre.push(...ixs); return this; },
  async transaction() { const tx = new Transaction(); tx.add(...this.pre, new TransactionInstruction({ programId: PROGRAM_ID, keys: [{ pubkey: keypair.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([9]) })); return tx; },
});
function conn(over = {}) {
  const sent = [];
  return {
    sent, rpcEndpoint: 'mock://x1',
    async getLatestBlockhash() { return { blockhash, lastValidBlockHeight: 1000 }; },
    async getFeeForMessage() { return { value: 10_000 }; },
    async getBalance() { return 10 ** 10; },
    async sendRawTransaction(raw) { sent.push(Buffer.from(raw)); return bs58.encode(Transaction.from(raw).signature); },
    async confirmTransaction() { return { value: { err: null } }; },
    async getSignatureStatuses() { return { value: [{ confirmationStatus: 'confirmed', err: null }] }; },
    async getTransaction() { return { meta: { logMessages: [] } }; },
    async simulateTransaction() { return { value: { err: null, unitsConsumed: 31_234, logs: [] } }; },
    ...over,
  };
}
const kit = (c) => {
  const mf = new MoonForge({ provider: { connection: c }, account: {}, idl: null }, keypair, { onWarning: () => {} });
  mf.pollOpts = { tries: 2, intervalMs: 1 };
  return mf;
};
const budget = (tx, kind) => tx.instructions.find((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === kind);

test('an instruction without a measured limit is simulated first and sent with that measurement x1.2', async () => {
  let sims = 0;
  const c = conn({ async simulateTransaction() { sims++; return { value: { err: null, unitsConsumed: 31_234, logs: [] } }; } });
  await kit(c).send(builder(), 'claimExtra');
  assert.equal(sims, 1);
  const tx = Transaction.from(c.sent[0]);
  assert.equal(budget(tx, 2).data.readUInt32LE(1), limitFor(31_234));
});

test('a refusal in that simulation is the program error, and nothing is sent', async () => {
  const c = conn({ async simulateTransaction() { return { value: { err: { InstructionError: [1, { Custom: 6066 }] }, unitsConsumed: 900, logs: ['Program log: AnchorError occurred. Error Code: ClaimOnHold. Error Number: 6066. Error Message: Claims open 48 h after the epoch is published.'] } }; } });
  await assert.rejects(kit(c).send(builder(), 'claimExtra'), (e) => { assert.equal(programErrorName(e), 'ClaimOnHold'); return true; });
  assert.equal(c.sent.length, 0);
});

test('priority: a compute-unit price instruction is added; without it, none', async () => {
  const c = conn();
  const mf = kit(c);
  await mf.send(builder(), 'withdraw', { priority: { microLamports: 5_000 } });
  const p = budget(Transaction.from(c.sent[0]), 3);
  assert.ok(p, 'SetComputeUnitPrice present');
  assert.equal(p.data.readBigUInt64LE(1), 5_000n);
  await mf.send(builder(), 'withdraw');
  assert.equal(budget(Transaction.from(c.sent[1]), 3), undefined);
  mf.priorityFee = { microLamports: 7 };
  await mf.send(builder(), 'withdraw', { priority: true });
  assert.equal(budget(Transaction.from(c.sent[2]), 3).data.readBigUInt64LE(1), 7n, 'priority: true takes connect({ priorityFee })');
});

test('resend: the same signed bytes are rebroadcast until the confirmation arrives, then stop', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const c = conn({ async confirmTransaction() { await gate; return { value: { err: null } }; } });
  const mf = kit(c);
  mf.resendMs = 5;
  const p = mf.send(builder(), 'seedWar', { resend: true });
  // wait (up to 5 s, the machine may be busy) until the rebroadcast has run a few times, then let the confirmation arrive
  for (let i = 0; i < 500 && c.sent.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
  release();
  await p;
  const after = c.sent.length;
  assert.ok(after >= 3, `${after} broadcasts`);
  assert.ok(c.sent.every((b) => b.equals(c.sent[0])), 'identical bytes: one signature, it can only land once');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.sent.length, after, 'no rebroadcast after the confirmation');
});
