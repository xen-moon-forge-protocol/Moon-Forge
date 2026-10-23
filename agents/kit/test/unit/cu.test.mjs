// node --test: every instruction the kit sends has a measured compute-unit limit and withCu() puts it in the transaction
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComputeBudgetProgram } from '@solana/web3.js';
import { CU_LIMITS, withCu, cuIx } from '../../moonforge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../../moonforge.mjs'), 'utf8');

test('every send(...) call names an instruction that has a limit, and every limit is sent by some call', () => {
  // send(builder, 'name', ...): the name follows the builder's closing parenthesis; move() picks its name at runtime
  const commitments = ['confirmed', 'finalized', 'processed'];
  const direct = [...source.matchAll(/\)\s*,\s*'([a-zA-Z]+)'\s*[,)]/g)].map((m) => m[1]).filter((n) => !commitments.includes(n));
  // send(b, 'name', ...) where the builder is a variable (forgeLunarDust rebuilds it on InvalidTarget)
  const viaVariable = [...source.matchAll(/send\(\s*[A-Za-z_]\w*\s*,\s*'([a-zA-Z]+)'/g)].map((m) => m[1]);
  const runtime = ['warSummon', 'warAttack', 'warEndTurn'];
  const named = new Set([...direct, ...viaVariable, ...runtime]);
  for (const n of named) assert.ok(n in CU_LIMITS, `no CU limit for ${n}`);
  for (const n of Object.keys(CU_LIMITS)) assert.ok(named.has(n), `CU_LIMITS.${n} is never sent`);
  assert.ok(named.size >= 20, `only ${named.size} names found`);
});

test('limits are per instruction, positive, below the 1.4M cap and not one global number', () => {
  const values = Object.values(CU_LIMITS);
  assert.ok(values.length >= 20);
  for (const v of values) { assert.ok(Number.isInteger(v) && v > 0 && v <= 1_400_000); assert.equal(v % 1000, 0, 'rounded to 1,000'); }
  assert.ok(new Set(values).size > 3, 'not a single global limit');
});

test('withCu prepends a SetComputeUnitLimit instruction with the table value', () => {
  const pre = [];
  const builder = { preInstructions(ixs) { pre.push(...ixs); return this; } };
  assert.equal(withCu(builder, 'placeBet'), builder);
  assert.equal(pre.length, 1);
  assert.ok(pre[0].programId.equals(ComputeBudgetProgram.programId));
  assert.deepEqual([...pre[0].data], [...cuIx(CU_LIMITS.placeBet).data]);
  assert.equal(pre[0].data[0], 2, 'SetComputeUnitLimit discriminator');
  assert.equal(pre[0].data.readUInt32LE(1), CU_LIMITS.placeBet);
});

test('withCu refuses an unknown instruction or a bad override', () => {
  const builder = { preInstructions() { return this; } };
  assert.throws(() => withCu(builder, 'nope'), /no compute-unit limit for "nope"/);
  assert.throws(() => withCu(builder, 'placeBet', 0), /placeBet/);
  assert.throws(() => withCu(builder, 'placeBet', 2_000_000), /placeBet/);
});
