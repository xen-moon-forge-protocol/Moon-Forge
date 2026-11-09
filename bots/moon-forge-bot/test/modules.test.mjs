// node --test: claims, games, Artifacts, log scrubbing, the journal, and the local A2A interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extraDecision, leafDecision } from '../src/claimer.mjs';
import { gamesGate, keeperSeatLive } from '../src/games.mjs';
import { artifactAlerts, listingCheck } from '../src/artifacts.mjs';
import { scrub } from '../src/log.mjs';
import { Journal } from '../src/journal.mjs';
import { startA2A } from '../src/a2a.mjs';
import { evmKeyFrom, killSwitchOn, readSecret } from '../src/safety.mjs';
import { jsonRpc } from '../src/evm-rpc.mjs';

const DAY = 86_400;
const T0 = 1_800_000_000;

test('claims: 48 h hold, 90-day window, already claimed, not verified, minimum', () => {
  const leaf = (o = {}) => ({ ok: true, claimed: false, expired: false, onHold: false, estimateXnt: 0.5, onChain: { publishedAt: T0 }, ...o });
  assert.equal(leafDecision(leaf(), { now: T0 + 3 * DAY }).action, 'claim');
  const held = leafDecision(leaf({ onHold: true, claimableFrom: T0 + 2 * DAY }), { now: T0 + DAY });
  assert.equal(held.action, 'wait');
  assert.match(held.reason, /48 h hold until 2027-01-17T/);
  assert.equal(leafDecision(leaf(), { now: T0 + 90 * DAY }).action, 'skip');
  assert.match(leafDecision(leaf({ expired: true }), { now: T0 }).reason, /90-day/);
  assert.match(leafDecision(leaf({ claimed: true }), { now: T0 }).reason, /already/);
  assert.match(leafDecision(leaf({ ok: false, reasons: ['chain: root differs'] }), { now: T0 }).reason, /root differs/);
  assert.equal(leafDecision(leaf({ estimateXnt: 0.001 }), { now: T0 + 3 * DAY, minClaimXnt: 0.01 }).action, 'skip');
  assert.equal(extraDecision({ ok: true, claimed: false, closed: false, onHold: false, amountXnt: 0.1 }).action, 'claim');
  assert.equal(extraDecision({ ok: true, claimed: false, closed: false, onHold: true, claimableFrom: T0, amountXnt: 0.1 }).action, 'wait');
  assert.equal(extraDecision({ ok: true, claimed: false, closed: true, amountXnt: 0.1 }).action, 'skip');
});

test('games: off by default, 18+ gate, final upgrade, daily count, loss budget measured on the wallets', () => {
  const g = { enabled: true, ageConfirmed18Plus: true, lossBudgetXnt: 1, maxStakeXnt: 0.5, maxGamesPerDay: 2 };
  const st = { rules: 3, totalLamports: 5e9, baselineLamports: 5e9, playedToday: 0 };
  assert.match(gamesGate({ ...g, enabled: false }, st).why, /off/);
  assert.match(gamesGate({ ...g, ageConfirmed18Plus: false }, st).why, /18Plus/);
  assert.match(gamesGate(g, { ...st, rules: 2 }).why, /final upgrade/);
  assert.match(gamesGate(g, { ...st, playedToday: 2 }).why, /daily game count/);
  assert.deepEqual(gamesGate(g, st), { ok: true, stakeXnt: 0.5, budgetLeftXnt: 1 });
  assert.equal(gamesGate(g, { ...st, totalLamports: 4.2e9 }).stakeXnt.toFixed(2), '0.20', 'the stake shrinks to what the budget has left');
  assert.match(gamesGate(g, { ...st, totalLamports: 3.9e9 }).why, /loss budget used/);
  assert.match(gamesGate(g, { ...st, totalLamports: 4.05e9 }).why, /below the 0.1 XNT minimum/);
});

test('house games only while the keeper seat is live', () => {
  const k = { exists: true, armed: true, bondXnt: 25, withdrawRequested: false, idleDays: 1 };
  assert.equal(keeperSeatLive(k).live, true);
  assert.equal(keeperSeatLive(null).live, false);
  assert.match(keeperSeatLive({ ...k, armed: false, reason: 'no positions left' }).why, /no positions/);
  assert.match(keeperSeatLive({ ...k, bondXnt: 10 }).why, /bond/);
  assert.match(keeperSeatLive({ ...k, withdrawRequested: true }).why, /withdrawal/);
  assert.match(keeperSeatLive({ ...k, idleDays: 30 }).why, /idle/);
});

test('Artifacts: alerts for the 52-week window and a holder that is not the burn destination; listing minimum', () => {
  const a = { asset: 'A1', origin: 0, backingXnt: 5, forgedAt: T0 - 50 * 7 * DAY };
  const alerts = artifactAlerts([a, { ...a, asset: 'G', origin: 1 }], { holder: 'H', x1Destination: 'D', now: T0, rules: 3 });
  assert.equal(alerts.length, 2);
  assert.match(alerts[0], /stops counting it in 2\.0 weeks/);
  assert.match(alerts[1], /rebate counts only burns whose destination holds the Artifact/);
  assert.equal(artifactAlerts([a], { holder: 'D', x1Destination: 'D', now: T0, rules: 2 }).length, 0, 'nothing about v3 before the upgrade');
  const low = listingCheck({ priceXnt: 5 }, 5e9);
  assert.equal(low.ok, false);
  assert.match(low.why, /below the minimum/);
  assert.equal(listingCheck({ priceXnt: low.minXnt }, 5e9).ok, true);
});

test('logs never carry keys, seeds or RPC paths; a transaction hash stays readable', () => {
  const pk = `0x${'ab'.repeat(32)}`;
  assert.equal(scrub(`key ${pk.slice(2)}`), 'key [redacted hex]');
  assert.equal(scrub(`tx ${pk}`), `tx ${pk}`);
  assert.equal(scrub(`k ${'5Kq'.repeat(29)}`), 'k [redacted]');
  assert.equal(scrub(`k [${Array(64).fill(7).join(',')}]`), 'k [redacted bytes]');
  assert.equal(scrub('rpc https://host.example/v2/SECRETKEY?x=1 down'), 'rpc https://host.example down');
  assert.match(scrub('words abandon ability able about above absent absorb abstract absurd abuse access accident end'), /\[redacted words\]/);
  assert.throws(() => evmKeyFrom('not a key'), (e) => !e.message.includes('not a key'));
  assert.equal(evmKeyFrom('ab'.repeat(32)), pk);
});

test('keys from a file or the environment; the kill switch from a file or MFBOT_STOP', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfbot-'));
  const f = path.join(dir, 'k.txt');
  fs.writeFileSync(f, ' secret \n');
  assert.equal(readSecret({ file: f }), 'secret');
  assert.equal(readSecret({ env: 'X' }, { X: 'abc' }), 'abc');
  assert.equal(readSecret({ env: 'X' }, {}), null);
  assert.throws(() => readSecret({ file: path.join(dir, 'missing') }), (e) => !e.message.includes(dir));
  const stopFile = path.join(dir, 'STOP');
  assert.equal(killSwitchOn({ killSwitchFile: stopFile }, {}), null);
  fs.writeFileSync(stopFile, '');
  assert.match(killSwitchOn({ killSwitchFile: stopFile }, {}), /kill-switch file/);
  assert.match(killSwitchOn({}, { MFBOT_STOP: '1' }), /MFBOT_STOP/);
});

test('the journal survives a restart and counts per UTC day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfbot-'));
  const file = path.join(dir, 'j.json');
  let now = Date.parse('2026-11-30T23:00:00Z');
  const j = new Journal(file, { clock: () => now });
  j.recordBurn(10, 5n);
  j.openSend({ chainId: 10, kind: 'approve', nonce: '1', hash: 'h' });
  const j2 = new Journal(file, { clock: () => now });
  assert.equal(j2.today().xenWei, 5n);
  assert.equal(j2.today(10).burns, 1);
  assert.equal(j2.unresolved(10).length, 1);
  now += 2 * 3_600_000;
  assert.equal(j2.today().xenWei, 0n, 'a new UTC day starts at zero');
  fs.writeFileSync(file, '{ broken');
  assert.throws(() => new Journal(file), /never guesses/);
});

test('the JSON-RPC adapter rotates on transport errors and never retries an answer', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(new URL(url).host);
    if (url.includes('down')) return { ok: false, status: 503 };
    if (body.method === 'eth_call') return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, error: { code: 3, message: 'execution reverted' } }) };
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: body.id, result: '0xa' }) };
  };
  const rpc = jsonRpc(['https://down.invalid/key123', 'https://up.invalid'], { fetchImpl, backoffMs: 1 });
  assert.equal(await rpc.chainId(), 10n);
  assert.deepEqual(calls, ['down.invalid', 'up.invalid']);
  calls.length = 0;
  await assert.rejects(rpc.call({ to: '0x0', data: '0x' }), /execution reverted/);
  assert.deepEqual(calls, ['up.invalid'], 'a revert is an answer: no second endpoint');
  const dead = jsonRpc(['https://down.invalid/key123'], { fetchImpl, backoffMs: 1, rounds: 1 });
  await assert.rejects(dead.chainId(), (e) => !e.message.includes('key123'));
});

test('A2A: card open, token required, actions refused unless allowed, quotes validated', async () => {
  let ticks = 0;
  const handlers = { card: () => ({ name: 'Moon Forge Bot' }), status: () => ({ mode: 'dry-run' }), quote: (q) => ({ ok: false, echo: q }), plan: () => ({ plan: [] }), tick: () => { ticks += 1; return { tick: ticks }; } };
  const server = startA2A({ port: 0, token: 'tok', handlers });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: 'Bearer tok', 'content-type': 'application/json' };
  try {
    assert.equal((await (await fetch(`${base}/.well-known/agent-card.json`)).json()).name, 'Moon Forge Bot');
    assert.equal((await fetch(`${base}/status`)).status, 401);
    assert.equal((await fetch(`${base}/status`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/tick`, { method: 'POST', headers: auth })).status, 403);
    assert.equal(ticks, 0);
    assert.equal((await fetch(`${base}/quote`, { method: 'POST', headers: auth, body: '{"chainId":"x"}' })).status, 400);
    const q = await (await fetch(`${base}/quote`, { method: 'POST', headers: auth, body: '{"chainId":10,"amountXen":"1000"}' })).json();
    assert.deepEqual(q.echo, { chainId: 10, amountXen: '1000' });
    assert.equal((await fetch(`${base}/quote`, { method: 'POST', headers: auth, body: 'x'.repeat(20_000) }).catch(() => ({ status: 413 }))).status, 413);
  } finally { server.close(); }
  const open = startA2A({ port: 0, allowActions: true, handlers });
  await new Promise((r) => open.once('listening', r));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${open.address().port}/tick`, { method: 'POST' })).status, 200);
    assert.equal(ticks, 1);
  } finally { open.close(); }
});
