// node --test: loadKeypair accepts every usual key format and never echoes key material in an error (a JSON.parse
// SyntaxError quotes part of its input; agent logs would keep it). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadKeypair } from '../../moonforge.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-keypair-test-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = (name, content) => { const p = path.join(dir, name); fs.writeFileSync(p, content); return p; };

/** Every 6-character window of `secret` (whitespace-only windows skipped) that appears in `text`. */
const leaks = (text, secret) => {
  const out = [];
  for (let i = 0; i + 6 <= secret.length; i++) {
    const w = secret.slice(i, i + 6);
    if (w.trim().length === 6 && text.includes(w)) out.push(w);
  }
  return out;
};
const errorOf = (fn) => { try { fn(); } catch (e) { return e; } assert.fail('expected a throw'); };

test('loads a JSON array file, a base58 file, a JSON string, a base58 string, bytes and a Keypair', () => {
  const kp = Keypair.generate();
  const json = JSON.stringify(Array.from(kp.secretKey)), b58 = bs58.encode(kp.secretKey);
  const pub = kp.publicKey.toBase58();
  assert.equal(loadKeypair(file('a.json', `${json}\n`)).publicKey.toBase58(), pub);
  assert.equal(loadKeypair(file('b.txt', `  ${b58}\r\n`)).publicKey.toBase58(), pub, 'a base58 secret inside a file (wallet export)');
  assert.equal(loadKeypair(json).publicKey.toBase58(), pub);
  assert.equal(loadKeypair(b58).publicKey.toBase58(), pub);
  assert.equal(loadKeypair(Array.from(kp.secretKey)).publicKey.toBase58(), pub);
  assert.equal(loadKeypair(kp), kp);
});

test('a damaged key never appears in the error: no 6-character piece of the secret in the message or the stack', () => {
  for (let n = 0; n < 30; n++) {
    const kp = Keypair.generate();
    const b58 = bs58.encode(kp.secretKey);
    const json = JSON.stringify(Array.from(kp.secretKey));
    // base58 with one invalid character (0 is not in the base58 alphabet), in a file and as a string
    const badB58 = `${b58.slice(0, 40)}0${b58.slice(41)}`;
    // a JSON array with a typo in the middle (the shape that made Node quote seed bytes)
    const badJson = json.replace(/,(\d+),/, ',$1x,');
    // a base58 file that a JSON-first loader would have parsed (the reported case: a SyntaxError quoting the key)
    const cases = [
      [() => loadKeypair(file(`k${n}.txt`, badB58)), badB58],
      [() => loadKeypair(badB58), badB58],
      [() => loadKeypair(file(`j${n}.json`, badJson)), badJson],
      [() => loadKeypair(badJson), badJson],
      [() => loadKeypair(file(`s${n}.json`, `[${b58}]`)), b58],
      [() => loadKeypair(file(`t${n}.txt`, b58.slice(0, 60))), b58], // valid base58, wrong length
    ];
    for (const [fn, secret] of cases) {
      const e = errorOf(fn);
      assert.match(e.message, /^loadKeypair: /);
      assert.deepEqual(leaks(`${e.message}\n${e.stack}`, secret), [], `leaked from: ${e.message}`);
      assert.deepEqual(leaks(`${e.message}\n${e.stack}`, b58), []);
    }
  }
});

test('an empty or non-string source gets a fixed message', () => {
  assert.match(errorOf(() => loadKeypair('')).message, /pass a keypair file path/);
  assert.match(errorOf(() => loadKeypair(undefined)).message, /pass a keypair file path/);
  assert.match(errorOf(() => loadKeypair(path.join(dir, 'missing.json'))).message, /not an existing file, a JSON byte array or a base58 secret/);
});
