/**
 * The ONE module that knows the program interface files (IDL). Everything else in the kit asks this module for an IDL;
 * nothing reads an IDL file directly. A re-sync after a program build is a change of this file only: the path, the
 * pinned sha256 and the instruction count of the file that changed.
 *
 *   live  frontend/src/idl/moon_forge.json     the deployed program (tag program-2026-10-12, rules 2): 59 instructions
 *   v3    frontend/src/idl/moon_forge.v3.json  the final-upgrade program (rules 3): 92 instructions; used only once the
 *                                              kit has detected the upgraded program on chain (detect.mjs)
 *
 * The sha256 is taken over the file with CRLF line ends turned into LF (the form git stores), so a Windows checkout and
 * a Linux clone pin the same value. A file whose hash differs, or whose `address` is not the Moon Forge program, is
 * refused: the kit never signs with an interface it did not expect (X-051: the chain's IDL account can be changed by
 * its authority until the freeze, so the kit does not take its interface from chain unless asked to).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PROGRAM_ID_B58 = '57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9';

export const IDL_FILES = Object.freeze({
  live: Object.freeze({
    path: fileURLToPath(new URL('../../frontend/src/idl/moon_forge.json', import.meta.url)),
    sha256: '207c277a917880c62dc3db8334f46c994a51acc570dedf45b401d9cf6fbf2cfa',
    instructions: 59,
    rules: 2,
  }),
  v3: Object.freeze({
    path: fileURLToPath(new URL('../../frontend/src/idl/moon_forge.v3.json', import.meta.url)),
    // round 4 (2026-10-25): settle_bet_v2 + reward_vault, keeper (the G-2 settle tip); refund_stalled_bet's reward_vault
    // read-only (stalls paid from the keeper bond); BetSettled + keeper_tip. 92 instructions, no layout change.
    sha256: '9617cd5eaf80168026957ae77396fc72497e9c154de2f55432b0f571e793a72f',
    instructions: 92,
    rules: 3,
  }),
});

/** sha256 (hex) of a file's bytes with CRLF turned into LF. */
export function lfSha256(bytes) {
  const text = Buffer.from(bytes).toString('utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** Throws unless the IDL is for the Moon Forge program. */
export function checkIdlAddress(idl, programId = PROGRAM_ID_B58) {
  if (!idl || typeof idl !== 'object' || !Array.isArray(idl.instructions)) throw new Error('the IDL is not an Anchor IDL (no instructions)');
  if (idl.address && idl.address !== programId) throw new Error(`the IDL is for ${idl.address}, not for the Moon Forge program ${programId}`);
  return idl;
}

/** The rules an IDL describes: 3 when it has the final upgrade's instructions (init_extra, claim_extra), else 2. */
export function idlRules(idl) {
  const names = new Set((idl?.instructions ?? []).map((i) => String(i.name).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()));
  return names.has('init_extra') && names.has('claim_extra') ? 3 : 2;
}

const cache = new Map();
/**
 * The bundled IDL `which` ('live' or 'v3'), read from its pinned path and checked: sha256 (LF form), instruction count
 * and program address. Returns { idl, sha256, path, rules }. `files` replaces IDL_FILES (tests).
 */
export function loadBundledIdl(which, { files = IDL_FILES } = {}) {
  const f = files[which];
  if (!f) throw new Error(`loadBundledIdl: no bundled IDL named "${which}" (live or v3)`);
  const cacheKey = `${which}:${f.path}:${f.sha256}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  let bytes;
  try { bytes = fs.readFileSync(f.path); } catch {
    throw new Error(`the bundled ${which} IDL is missing (${which === 'v3' ? 'frontend/src/idl/moon_forge.v3.json' : 'frontend/src/idl/moon_forge.json'} in the repository): run the kit from a clone of the repository, or pass connect({ idl })`);
  }
  const sha256 = lfSha256(bytes);
  if (sha256 !== f.sha256) {
    throw new Error(`the bundled ${which} IDL does not match its pinned sha256 (expected ${f.sha256}, found ${sha256}): the file changed; review the change and update agents/kit/idl.mjs`);
  }
  let idl;
  try { idl = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`the bundled ${which} IDL is not valid JSON`); }
  checkIdlAddress(idl);
  if (idl.instructions.length !== f.instructions) throw new Error(`the bundled ${which} IDL has ${idl.instructions.length} instructions, expected ${f.instructions}`);
  if (idlRules(idl) !== f.rules) throw new Error(`the bundled ${which} IDL describes rules ${idlRules(idl)}, expected ${f.rules}`);
  const out = Object.freeze({ idl, sha256, path: f.path, rules: f.rules });
  cache.set(cacheKey, out);
  return out;
}

/** Loads an IDL given by the caller (object or file path) and checks its address; returns { idl, sha256 | null, rules }. */
export function loadGivenIdl(source) {
  if (typeof source === 'string') {
    let bytes;
    try { bytes = fs.readFileSync(source); } catch { throw new Error(`connect: the IDL file ${source} could not be read`); }
    let idl;
    try { idl = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`connect: the IDL file ${source} is not valid JSON`); }
    checkIdlAddress(idl);
    return { idl, sha256: lfSha256(bytes), rules: idlRules(idl) };
  }
  checkIdlAddress(source);
  return { idl: source, sha256: null, rules: idlRules(source) };
}

/** The sha256 pins, for status() and the agent card / SKILL texts. */
export const idlPins = () => ({ live: IDL_FILES.live.sha256, v3: IDL_FILES.v3.sha256 });

/** True when `sha256` (LF form) is one of the bundled files' pins: a copy of a bundled IDL. */
export const isBundledSha = (sha256) => !!sha256 && Object.values(IDL_FILES).some((f) => f.sha256 === sha256);

// ─── layout facts derived from an IDL (never hard-coded elsewhere in the kit) ──
const snake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const PRIM = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8, u128: 16, i128: 16, pubkey: 32, publicKey: 32 };
/** Borsh size of a fixed-size IDL type, or null when it is variable (vec, string, option, bytes, data enums). */
function borshSize(idl, t, seen = new Set()) {
  if (typeof t === 'string') return PRIM[t] ?? null;
  if (t?.array) { const s = borshSize(idl, t.array[0], seen); return s === null || typeof t.array[1] !== 'number' ? null : s * t.array[1]; }
  const name = t?.defined?.name ?? (typeof t?.defined === 'string' ? t.defined : null);
  if (!name || seen.has(name)) return null;
  const def = (idl.types ?? []).find((x) => x.name === name);
  if (!def) return null;
  const s2 = new Set(seen).add(name);
  if (def.type?.kind === 'struct') {
    let n = 0;
    for (const f of def.type.fields ?? []) { const s = borshSize(idl, f.type, s2); if (s === null) return null; n += s; }
    return n;
  }
  if (def.type?.kind === 'enum') return (def.type.variants ?? []).every((v) => !v.fields || !v.fields.length) ? 1 : null;
  return null;
}
/**
 * The byte offset of `field` inside a program account `account` (the 8-byte Anchor discriminator included), computed
 * from the IDL's type layout: what a memcmp filter needs. Names may be snake_case or camelCase. Throws when the account
 * or field is unknown, or when a variable-size field comes before it.
 */
export function accountFieldOffset(idl, account, field) {
  const want = snake(field);
  // Anchor ≥ 0.30 IDLs keep account layouts in `types`; an older (0.29) IDL, e.g. read with idl: 'chain', inlines them in `accounts`
  const pool = [...(idl?.types ?? []), ...(idl?.accounts ?? []).filter((a) => a.type)];
  const def = pool.find((t) => t.name === account) ?? pool.find((t) => snake(t.name) === snake(account));
  if (!def || def.type?.kind !== 'struct') throw new Error(`accountFieldOffset: the IDL has no account type ${account}`);
  let o = 8;
  for (const f of def.type.fields ?? []) {
    if (snake(f.name) === want) return o;
    const s = borshSize(idl, f.type);
    if (s === null) throw new Error(`accountFieldOffset: ${account}.${f.name} has a variable size, so ${field} has no fixed offset`);
    o += s;
  }
  throw new Error(`accountFieldOffset: ${account} has no field ${field}`);
}
/** The 8-byte discriminator (hex) of instruction `name` in this IDL, or null. */
export function ixDiscriminatorHex(idl, name) {
  const want = snake(name);
  const ix = (idl?.instructions ?? []).find((i) => snake(i.name) === want);
  return ix?.discriminator ? Buffer.from(ix.discriminator).toString('hex') : null;
}
/** The 8-byte discriminator (hex) of account `name` in this IDL, or null. */
export function accountDiscriminatorHex(idl, name) {
  const a = (idl?.accounts ?? []).find((x) => x.name === name || snake(x.name) === snake(name));
  return a?.discriminator ? Buffer.from(a.discriminator).toString('hex') : null;
}
