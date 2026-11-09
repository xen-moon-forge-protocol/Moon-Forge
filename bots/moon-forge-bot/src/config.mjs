// Configuration: defaults, merge, validation. Every limit the bot obeys is here, in one JSON file the owner edits.
// Amounts are decimal strings in whole units (XEN, the chain's native coin) or numbers in XNT; they are converted
// to integers (wei, lamports) once, here, so no other module does float arithmetic on money.
import fs from 'node:fs';
import path from 'node:path';
import { WEEK_FEED_URL } from './kit.mjs';

export const XEN_DECIMALS = 18;
export const NATIVE_DECIMALS = 18;

/** "1.5" → 1500000000000000000n for 18 decimals. Throws on anything that is not a plain non-negative decimal. */
export function toUnits(value, decimals, what = 'amount') {
  const s = typeof value === 'number' ? (Number.isFinite(value) ? value.toFixed(decimals).replace(/\.?0+$/, '') : '') : String(value ?? '').trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`${what}: "${s}" is not a non-negative decimal number`);
  const frac = (m[2] ?? '').padEnd(decimals, '0');
  if (frac.length > decimals) throw new Error(`${what}: more than ${decimals} decimals`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}
/** 1500000000000000000n → "1.5" (18 decimals). */
export function fromUnits(v, decimals) {
  const n = BigInt(v), neg = n < 0n, a = neg ? -n : n, base = 10n ** BigInt(decimals);
  const frac = (a % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / base}${frac ? `.${frac}` : ''}`;
}

export const DEFAULTS = Object.freeze({
  acceptRiskNotice: false,
  x1Destination: '',
  x1DestinationConfirm: '',
  evmAddress: '',
  keys: { evm: { file: '', env: 'MFBOT_EVM_KEY' }, x1: { file: '', env: 'MFBOT_X1_KEY' } },
  x1Rpcs: [],
  feedUrl: WEEK_FEED_URL,
  epochs: 'site',
  portalsFile: '../../deployments/portals.json',
  tickSeconds: 300,
  stateFile: './state/journal.json',
  logFile: './state/bot.log',
  killSwitchFile: './STOP',
  burn: {
    enabled: true,
    tier: 0,
    rule: {
      minXntPerBillionXen: 0,
      minQuoteOverMarketBps: 10_000,
      minRemainingTodayXnt: 0.001,
      maxShareOfRemainingBps: 2_500,
      minXenPerBurn: '1000000',
    },
    limits: { maxXenPerBurn: '0', maxXenPerDay: '0', maxBurnsPerDay: 4, maxBurnsPerTick: 1 },
    gas: {
      maxFeePerGasGwei: 5, maxGasCostNative: '0.002', keepNativeReserve: '0.0005', extraFeeNative: '0',
      gasLimitHeadroomBps: 12_500, confirmations: 2, txTimeoutSeconds: 600,
    },
    chainDefaults: { enabled: true },
    chains: {},
  },
  claims: { enabled: true, base: true, extra: true, withdrawVested: false, lastEpochs: 20, minClaimXnt: 0, owner: '' },
  games: {
    enabled: false, ageConfirmed18Plus: false, lossBudgetXnt: 0, maxStakeXnt: 0.1, maxGamesPerDay: 3,
    duel: { enabled: false, createWhenNone: false },
    wars: { enabled: false, createWhenNone: false },
    house: { enabled: false, game: 0, param: 0, choice: 0 },
  },
  artifacts: {
    alerts: true,
    recycle: { enabled: false, assets: [], maxPerDay: 1 },
    listing: { enabled: false, items: [], maxPerDay: 2 },
  },
  a2a: { enabled: false, host: '127.0.0.1', port: 8787, tokenEnv: 'MFBOT_A2A_TOKEN', allowActions: false },
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Deep merge: objects merge key by key, everything else (arrays included) replaces. */
export function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Validates a merged config. Returns { ok, errors, warnings, limits } where `limits` holds the integer forms the
 * strategist uses. Never throws for a bad value: every problem is listed, so the owner fixes them all at once.
 */
export function validateConfig(cfg, { live = false } = {}) {
  const errors = [], warnings = [];
  const num = (v, what, { min = 0, max = Infinity, int = false } = {}) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
      errors.push(`${what} must be ${int ? 'an integer' : 'a number'} between ${min} and ${max}`);
      return null;
    }
    return v;
  };
  const units = (v, dec, what) => { try { return toUnits(v, dec, what); } catch (e) { errors.push(e.message); return null; } };

  if (typeof cfg.acceptRiskNotice !== 'boolean') errors.push('acceptRiskNotice must be true or false');
  if (live && cfg.acceptRiskNotice !== true) errors.push('live mode needs "acceptRiskNotice": true (read the notice printed by `check`)');
  if (cfg.x1Destination && !B58_RE.test(cfg.x1Destination)) errors.push('x1Destination is not a base58 X1 address');
  if (cfg.burn?.enabled && !cfg.x1Destination) errors.push('x1Destination is required for burns: the X1 wallet that receives the XNT');
  if (cfg.burn?.enabled && cfg.x1Destination && cfg.x1DestinationConfirm !== String(cfg.x1Destination).slice(-6)) {
    errors.push('x1DestinationConfirm must be the last 6 characters of x1Destination, typed by you: the XNT is paid to that X1 address and nowhere else');
  }
  if (cfg.evmAddress && !/^0x[0-9a-fA-F]{40}$/.test(cfg.evmAddress)) errors.push('evmAddress is not a 0x EVM address');
  num(cfg.tickSeconds, 'tickSeconds', { min: 30, max: 86_400, int: true });
  if (!Array.isArray(cfg.x1Rpcs) || cfg.x1Rpcs.some((u) => !/^https:\/\//.test(String(u)))) errors.push('x1Rpcs must be a list of https:// URLs');
  if (!/^https:\/\//.test(String(cfg.feedUrl))) errors.push('feedUrl must be an https:// URL');
  for (const k of ['evm', 'x1']) {
    const key = cfg.keys?.[k];
    if (!isObj(key)) { errors.push(`keys.${k} must be { file, env }`); continue; }
    if (key.value !== undefined) errors.push(`keys.${k}.value is not accepted: keep keys in a file or an environment variable, never in the config`);
  }

  const b = cfg.burn ?? {};
  const limits = { burn: null };
  if (b.enabled) {
    if (![0, 1, 2].includes(b.tier)) errors.push('burn.tier must be 0 (Launchpad), 1 (Orbit) or 2 (Moon Landing)');
    if (b.tier > 0) warnings.push('burn.tier > 0 locks a vesting mission (45 or 180 days); the bot passes allowVesting only because you set this tier');
    const r = b.rule ?? {};
    num(r.minXntPerBillionXen, 'burn.rule.minXntPerBillionXen');
    num(r.minQuoteOverMarketBps, 'burn.rule.minQuoteOverMarketBps', { max: 100_000, int: true });
    if (r.minQuoteOverMarketBps === 0) warnings.push('burn.rule.minQuoteOverMarketBps is 0: the bot may burn for less than selling the XEN would bring');
    num(r.minRemainingTodayXnt, 'burn.rule.minRemainingTodayXnt');
    num(r.maxShareOfRemainingBps, 'burn.rule.maxShareOfRemainingBps', { min: 1, max: 5_000, int: true });
    const l = b.limits ?? {}, g = b.gas ?? {};
    const lim = {
      minXenPerBurn: units(r.minXenPerBurn, XEN_DECIMALS, 'burn.rule.minXenPerBurn'),
      maxXenPerBurn: units(l.maxXenPerBurn, XEN_DECIMALS, 'burn.limits.maxXenPerBurn'),
      maxXenPerDay: units(l.maxXenPerDay, XEN_DECIMALS, 'burn.limits.maxXenPerDay'),
      maxBurnsPerDay: num(l.maxBurnsPerDay, 'burn.limits.maxBurnsPerDay', { max: 96, int: true }),
      maxBurnsPerTick: num(l.maxBurnsPerTick, 'burn.limits.maxBurnsPerTick', { min: 1, max: 5, int: true }),
    };
    if (lim.maxXenPerBurn === 0n) errors.push('burn.limits.maxXenPerBurn is 0: set the most XEN one burn may destroy');
    if (lim.maxXenPerDay === 0n) errors.push('burn.limits.maxXenPerDay is 0: set the most XEN the bot may burn per UTC day');
    if (lim.maxXenPerBurn && lim.maxXenPerDay && lim.maxXenPerBurn > lim.maxXenPerDay) errors.push('burn.limits.maxXenPerBurn is above maxXenPerDay');
    if (lim.minXenPerBurn && lim.maxXenPerBurn && lim.minXenPerBurn > lim.maxXenPerBurn) errors.push('burn.rule.minXenPerBurn is above maxXenPerBurn');
    num(g.maxFeePerGasGwei, 'burn.gas.maxFeePerGasGwei', { min: 0.000001, max: 10_000 });
    num(g.gasLimitHeadroomBps, 'burn.gas.gasLimitHeadroomBps', { min: 10_000, max: 30_000, int: true });
    num(g.confirmations, 'burn.gas.confirmations', { min: 1, max: 64, int: true });
    num(g.txTimeoutSeconds, 'burn.gas.txTimeoutSeconds', { min: 30, max: 7_200, int: true });
    lim.maxGasCostWei = units(g.maxGasCostNative, NATIVE_DECIMALS, 'burn.gas.maxGasCostNative');
    lim.keepNativeReserveWei = units(g.keepNativeReserve, NATIVE_DECIMALS, 'burn.gas.keepNativeReserve');
    units(g.extraFeeNative, NATIVE_DECIMALS, 'burn.gas.extraFeeNative');
    if (!isObj(b.chains)) errors.push('burn.chains must be an object keyed by chain id');
    else for (const [id, c] of Object.entries(b.chains)) {
      if (!/^\d+$/.test(id)) errors.push(`burn.chains.${id}: keys are chain ids (e.g. "10")`);
      if (c?.rpcs !== undefined && (!Array.isArray(c.rpcs) || c.rpcs.some((u) => !/^https:\/\//.test(String(u))))) errors.push(`burn.chains.${id}.rpcs must be a list of https:// URLs`);
    }
    limits.burn = lim;
  }

  const c = cfg.claims ?? {};
  if (c.enabled) {
    num(c.lastEpochs, 'claims.lastEpochs', { min: 1, max: 60, int: true });
    num(c.minClaimXnt, 'claims.minClaimXnt');
    if (c.owner && !B58_RE.test(c.owner)) errors.push('claims.owner is not a base58 X1 address');
  }

  const gm = cfg.games ?? {};
  if (gm.enabled) {
    if (gm.ageConfirmed18Plus !== true) errors.push('games.enabled needs games.ageConfirmed18Plus: true (games are 18+ only and only where legal)');
    if (num(gm.lossBudgetXnt, 'games.lossBudgetXnt') === 0) errors.push('games.lossBudgetXnt is 0: set the most XNT the games may lose in total');
    num(gm.maxStakeXnt, 'games.maxStakeXnt', { min: 0.01 });
    num(gm.maxGamesPerDay, 'games.maxGamesPerDay', { min: 1, max: 100, int: true });
    if (gm.maxStakeXnt > gm.lossBudgetXnt) errors.push('games.maxStakeXnt is above games.lossBudgetXnt');
    if (gm.house?.enabled) warnings.push('house games carry a fixed 2% edge: over time, players as a group lose that edge');
  }

  const a = cfg.artifacts ?? {};
  if (a.recycle?.enabled && (!Array.isArray(a.recycle.assets) || !a.recycle.assets.every((x) => B58_RE.test(String(x))))) errors.push('artifacts.recycle.assets must list the asset addresses the bot may recycle');
  if (a.listing?.enabled) {
    if (!Array.isArray(a.listing.items) || !a.listing.items.every((x) => B58_RE.test(String(x?.asset)) && typeof x?.priceXnt === 'number' && x.priceXnt > 0)) {
      errors.push('artifacts.listing.items must be [{ "asset": "<address>", "priceXnt": <number> }]');
    }
  }

  const s = cfg.a2a ?? {};
  if (s.enabled) {
    num(s.port, 'a2a.port', { min: 1, max: 65_535, int: true });
    const token = s.tokenEnv ? process.env[s.tokenEnv] : '';
    if (!LOOPBACK.has(String(s.host)) && !token) errors.push(`a2a.host ${s.host} is not loopback: set a token in the ${s.tokenEnv} environment variable`);
    if (s.allowActions) warnings.push('a2a.allowActions is true: another agent can ask for a tick, which still obeys every limit here and sends only with --live');
  }
  return { ok: errors.length === 0, errors, warnings, limits };
}

/** Reads a JSON config file, merges it over DEFAULTS and resolves relative paths against the file's folder. */
export function loadConfig(file, { live = false } = {}) {
  const abs = path.resolve(file);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { throw new Error(`config ${path.basename(abs)}: ${e.code === 'ENOENT' ? 'not found' : 'not valid JSON'}`); }
  const cfg = merge(structuredClone(DEFAULTS), raw);
  const dir = path.dirname(abs);
  for (const k of ['stateFile', 'logFile', 'killSwitchFile', 'portalsFile']) if (cfg[k]) cfg[k] = path.resolve(dir, cfg[k]);
  for (const k of ['evm', 'x1']) if (cfg.keys?.[k]?.file) cfg.keys[k].file = path.resolve(dir, cfg.keys[k].file);
  return { cfg, ...validateConfig(cfg, { live }) };
}

/** The settings of one chain: burn.chainDefaults, then burn.chains[chainId]; gas and limits merged over burn.gas / burn.limits. */
export function chainSettings(cfg, chainId) {
  const b = cfg.burn;
  const own = b.chains?.[String(chainId)] ?? {};
  const merged = merge(structuredClone(b.chainDefaults ?? {}), own);
  return { ...merged, gas: merge(structuredClone(b.gas), own.gas ?? {}), limits: merge(structuredClone(b.limits), own.limits ?? {}), rpcs: own.rpcs ?? merged.rpcs ?? [] };
}
