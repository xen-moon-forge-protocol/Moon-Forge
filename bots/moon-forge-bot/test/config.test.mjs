// node --test: config validation, unit conversion, chain discovery from deployments/portals.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, fromUnits, loadConfig, merge, toUnits, validateConfig } from '../src/config.mjs';
import { readPortalsFile, resolveChains } from '../src/chains.mjs';
import { testConfig, x1Address } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORTALS_FILE = path.resolve(HERE, '../../../deployments/portals.json');
const errorsOf = (over, opts) => validateConfig(merge(structuredClone(DEFAULTS), over), opts).errors.join(' | ');

test('decimal units round-trip without floats', () => {
  assert.equal(toUnits('1.5', 18), 1_500_000_000_000_000_000n);
  assert.equal(toUnits('50000000', 18), 50_000_000n * 10n ** 18n);
  assert.equal(fromUnits(toUnits('0.000000000000000001', 18), 18), '0.000000000000000001');
  assert.throws(() => toUnits('-1', 18), /not a non-negative decimal/);
  assert.throws(() => toUnits('1e9', 18), /not a non-negative decimal/);
  assert.throws(() => toUnits('0.1234567890123456789', 18), /more than 18 decimals/);
});

test('a valid config passes and gives integer limits', () => {
  const { limits } = testConfig();
  assert.equal(limits.burn.maxXenPerBurn, 1_000_000n * 10n ** 18n);
  assert.equal(limits.burn.maxGasCostWei, toUnits('0.002', 18));
});

test('the defaults alone are refused: the owner must set a destination and limits', () => {
  const e = errorsOf({});
  assert.match(e, /x1Destination is required/);
  assert.match(e, /maxXenPerBurn is 0/);
  assert.match(e, /maxXenPerDay is 0/);
});

test('the destination must be confirmed by its last 6 characters', () => {
  const x1 = x1Address();
  const base = { x1Destination: x1, burn: { limits: { maxXenPerBurn: '1', maxXenPerDay: '2' }, rule: { minXenPerBurn: '1' } } };
  assert.match(errorsOf({ ...base, x1DestinationConfirm: 'abcdef' }), /x1DestinationConfirm/);
  assert.equal(errorsOf({ ...base, x1DestinationConfirm: x1.slice(-6) }), '');
  assert.match(errorsOf({ ...base, x1DestinationConfirm: x1.slice(-6), x1Destination: '0x1234' }), /not a base58/);
});

test('live mode needs the risk notice accepted; games need 18+ and a loss budget; keys never inline', () => {
  const { cfg } = testConfig();
  assert.match(validateConfig(cfg, { live: true }).errors.join(), /acceptRiskNotice/);
  assert.equal(validateConfig({ ...cfg, acceptRiskNotice: true }, { live: true }).ok, true);
  const games = merge(cfg, { games: { enabled: true } });
  assert.match(validateConfig(games).errors.join(), /ageConfirmed18Plus/);
  assert.match(validateConfig(games).errors.join(), /lossBudgetXnt is 0/);
  assert.equal(validateConfig(merge(games, { games: { ageConfirmed18Plus: true, lossBudgetXnt: 1 } })).ok, true);
  assert.match(validateConfig(merge(games, { games: { ageConfirmed18Plus: true, lossBudgetXnt: 0.05, maxStakeXnt: 0.1 } })).errors.join(), /above games.lossBudgetXnt/);
  assert.match(validateConfig(merge(cfg, { keys: { evm: { value: '0xabc' } } })).errors.join(), /never in the config/);
});

test('limits that contradict each other are listed together', () => {
  const { cfg } = testConfig();
  const bad = merge(cfg, { burn: { limits: { maxXenPerBurn: '10', maxXenPerDay: '5' }, rule: { minXenPerBurn: '20', maxShareOfRemainingBps: 9000 }, gas: { gasLimitHeadroomBps: 5000 } } });
  const e = validateConfig(bad).errors.join(' | ');
  assert.match(e, /maxXenPerBurn is above maxXenPerDay/);
  assert.match(e, /minXenPerBurn is above maxXenPerBurn/);
  assert.match(e, /maxShareOfRemainingBps/);
  assert.match(e, /gasLimitHeadroomBps/);
});

test('the A2A interface off loopback needs a token from the environment', () => {
  const { cfg } = testConfig();
  const open = merge(cfg, { a2a: { enabled: true, host: '0.0.0.0', tokenEnv: 'MFBOT_TEST_TOKEN_UNSET' } });
  assert.match(validateConfig(open).errors.join(), /not loopback/);
  assert.equal(validateConfig(merge(cfg, { a2a: { enabled: true } })).ok, true);
});

test('loadConfig resolves paths against the config folder and reports bad JSON without quoting it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfbot-'));
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, '{ not json');
  assert.throws(() => loadConfig(f), /not valid JSON/);
  fs.writeFileSync(f, JSON.stringify({ stateFile: './s/j.json' }));
  assert.equal(loadConfig(f).cfg.stateFile, path.join(dir, 's', 'j.json'));
});

test('every chain of deployments/portals.json is discovered and checked against the kit', () => {
  const published = readPortalsFile(PORTALS_FILE);
  assert.deepEqual(published.map((p) => p.chainId).sort((a, b) => a - b), [10, 56, 137, 8453, 43114]);
  const { cfg } = testConfig();
  const chains = resolveChains(cfg, published);
  assert.equal(chains.length, 5);
  assert.deepEqual(chains.filter((c) => c.usable).map((c) => c.chainId).sort((a, b) => a - b), [10, 8453], 'only the chains with an RPC');
  assert.match(chains.find((c) => c.chainId === 56).why, /no RPC/);
});

test('a new chain appears from portals.json but waits for a kit that knows it; a different address is refused', () => {
  const { cfg } = testConfig();
  cfg.burn.chains['999'] = { rpcs: ['https://rpc.invalid'] };
  const published = [...readPortalsFile(PORTALS_FILE), { chain: 'Newchain', chainId: 999, address: '0x7b00f314aB48D223bee567181CA89c65126Bf6E9', xen: '0x0000000000000000000000000000000000000001' }];
  const fresh = resolveChains(cfg, published).find((c) => c.chainId === 999);
  assert.equal(fresh.usable, false);
  assert.match(fresh.why, /kit in use has no portal/);
  const kit = [{ chainId: 999, portal: '0x7b00f314aB48D223bee567181CA89c65126Bf6E9', xen: '0x0000000000000000000000000000000000000001' }];
  assert.equal(resolveChains(cfg, published, kit).find((c) => c.chainId === 999).usable, true);
  const forged = published.map((p) => (p.chainId === 10 ? { ...p, address: '0x0000000000000000000000000000000000000bad' } : p));
  assert.match(resolveChains(cfg, forged).find((c) => c.chainId === 10).why, /differs from the kit/);
  cfg.burn.chains['10'].enabled = false;
  assert.match(resolveChains(cfg, published).find((c) => c.chainId === 10).why, /disabled/);
});
