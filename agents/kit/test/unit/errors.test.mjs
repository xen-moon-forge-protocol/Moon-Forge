// node --test: the error map covers every IDL error and errorMessage() handles every shape the kit can throw
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMessage, programErrorName, programErrorNumber, PROGRAM_ERRORS } from '../../errors.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const idlPath = [path.resolve(here, '../../../../target/idl/moon_forge.json'), path.resolve(here, '../../../../frontend/src/idl/moon_forge.json')].find((p) => fs.existsSync(p));

test('every IDL error code is in the map with the same name and text', { skip: !idlPath && 'no IDL file in this checkout' }, () => {
  const idl = JSON.parse(fs.readFileSync(idlPath, 'utf8'));
  assert.equal(idl.errors.length, 64);
  for (const e of idl.errors) {
    assert.ok(PROGRAM_ERRORS[e.code], `code ${e.code} missing`);
    assert.equal(PROGRAM_ERRORS[e.code].name, e.name);
    assert.equal(PROGRAM_ERRORS[e.code].text, e.msg);
    assert.ok(PROGRAM_ERRORS[e.code].next.length > 10, `${e.name} has no next step`);
  }
  assert.equal(Object.keys(PROGRAM_ERRORS).length, idl.errors.length, 'no code outside the IDL');
});

test('codes are contiguous 6000..6063 (frozen; an upgrade may only append)', () => {
  const codes = Object.keys(PROGRAM_ERRORS).map(Number).sort((a, b) => a - b);
  assert.deepEqual(codes, Array.from({ length: 64 }, (_, i) => 6000 + i));
});

test('AnchorError shape (what .rpc() and the kit throw after translation)', () => {
  const e = { error: { errorCode: { code: 'SlippageExceeded', number: 6053 }, errorMessage: 'Price moved beyond your limit' }, logs: [] };
  assert.equal(programErrorNumber(e), 6053);
  assert.equal(programErrorName(e), 'SlippageExceeded');
  assert.match(errorMessage(e), /^Price moved beyond your limit \(SlippageExceeded, 6053\)\. Be the House/);
});

test('transaction logs with the Anchor error line', () => {
  const e = { logs: ['Program 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 invoke [1]', 'Program log: AnchorError occurred. Error Code: InvalidTarget. Error Number: 6047. Error Message: Invalid target account.'] };
  assert.equal(programErrorName(e), 'InvalidTarget');
  assert.match(errorMessage(e), /InvalidTarget, 6047.*re-read the counter/);
});

test('hex custom program error in logs or message', () => {
  assert.equal(programErrorName({ logs: ['Program 57UE failed: custom program error: 0x179f'] }), 'InvalidTarget');
  assert.equal(programErrorName(new Error('failed to send transaction: custom program error: 0x1793')), 'WithdrawLocked');
  assert.equal(programErrorName('custom program error: 0x1786'), 'BankrollTooSmall');
  assert.match(errorMessage({ logs: ['Program 11111111111111111111111111111111 failed: custom program error: 0x1'] }), /another program/);
});

test('getSignatureStatuses err shape', () => {
  assert.equal(programErrorName({ err: { InstructionError: [1, { Custom: 6036 }] } }), 'NoPendingWithdraw');
});

test('unknown program codes and framework codes', () => {
  assert.match(errorMessage({ logs: ['custom program error: 0x17b0'] }), /newer program than the kit/); // 0x17b0 = 6064: first code after the frozen range
  assert.match(errorMessage({ error: { errorCode: { code: 'ConstraintSeeds', number: 2006 }, errorMessage: 'A seeds constraint was violated' } }), /Anchor framework error 2006/);
});

test('non-program errors get an actionable line', () => {
  assert.match(errorMessage(new Error('Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed.')), /Check its signature on the explorer/);
  assert.match(errorMessage(new Error('Attempt to debit an account but found no record of a prior credit.')), /Not enough XNT/);
  assert.match(errorMessage(new Error('fetch failed')), /RPC unreachable/);
  assert.match(errorMessage(new Error('429 Too Many Requests')), /rate-limiting/);
  assert.match(errorMessage(new Error('Blockhash not found')), /stale blockhash/);
  assert.equal(errorMessage(null), 'Unknown error');
  assert.equal(errorMessage('plain text'), 'plain text');
  assert.equal(errorMessage(new Error('x'.repeat(500))).length, 300);
});

test('sends that may have landed: the text names the signature and never invites a blind resend', () => {
  const sig = '5'.repeat(88);
  const unreachable = errorMessage(Object.assign(new Error('fetch failed'), { signature: sig, mayHaveLanded: true }));
  assert.match(unreachable, /RPC unreachable \(fetch failed\) after the transaction was signed: it may have landed: check the signature 5{88} on the explorer before sending again/);
  assert.doesNotMatch(unreachable, /fails over/);
  assert.match(errorMessage(new Error('Transaction simulation failed: This transaction has already been processed')), /already processed this transaction.*Do not send it again/);
  assert.match(errorMessage(Object.assign(new Error('already been processed'), { signature: sig })), /check the signature 5{88}/);
  // a relayed program refusal keeps its own text and gets the warning appended once
  const relayed = { logs: ['Program log: AnchorError occurred. Error Code: InvalidTarget. Error Number: 6047. Error Message: Invalid target account.'], signature: sig, mayHaveLanded: true };
  const text = errorMessage(relayed);
  assert.match(text, /^Invalid target account \(InvalidTarget, 6047\)/);
  assert.equal(text.match(/may have landed/g).length, 1);
  // without the flag nothing is appended
  assert.doesNotMatch(errorMessage({ logs: relayed.logs, signature: sig }), /may have landed/);
});

test('RPC URLs inside an error text are cut to their origin (an API key in a path or query stays out of logs)', () => {
  const text = errorMessage(new Error('request to https://x1.example.com/v1/SECRETKEY?api-key=SECRET2 failed, reason: socket hang up'));
  assert.match(text, /https:\/\/x1\.example\.com/);
  assert.doesNotMatch(text, /SECRET/);
});
