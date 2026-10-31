// Shared code of the upgrade-day tools (scripts/upgrade/*.mjs). Read-only helpers, the transaction plan printer, the
// simulator and the one sender. No key material lives in this directory: keypair files are named by path at run time,
// only their public keys are ever printed, and nothing is sent unless the calling tool got an explicit --send.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');

// @solana/web3.js and @coral-xyz/anchor come from the oracle's install (the same versions the oracle sends with), else
// from tests/ (the localnet suites install them there).
function resolver() {
  const tried = [];
  for (const d of [process.env.UPGRADE_TOOLS_NODE_DIR, path.join(ROOT, 'oracle'), path.join(ROOT, 'tests')].filter(Boolean)) {
    try {
      const r = createRequire(path.join(d, 'package.json'));
      r.resolve('@solana/web3.js');
      r.resolve('@coral-xyz/anchor');
      return r;
    } catch { tried.push(d); }
  }
  throw new Error(`@solana/web3.js and @coral-xyz/anchor not found (npm ci in oracle/ or tests/); tried ${tried.join(', ')}`);
}
export const requireDep = resolver();
export const web3 = requireDep('@solana/web3.js');
export const anchor = requireDep('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = web3;

// ── fixed facts (deployments/upgrade-v3-signoff.md section 1) ─────────────────────────────────────────────────────────
export const PROGRAM_ID = new PublicKey('57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9');
export const CORE_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
export const LOADER_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export const SYSTEM_ID = SystemProgram.programId;
export const DEPLOY_WALLET = '7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd';
/** ProgramData last-deploy slot and data length of the live v2 binary (tag program-2026-10-12). */
export const LIVE_DEPLOY_SLOT = 85_429_880;
export const LIVE_DATA_LEN = 992_168;
export const X1_MAINNET_GENESIS = '4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN';
export const MAINNET_RPC = 'https://rpc.mainnet.x1.xyz';
/** anchor-lang ERASED_AUTHORITY (Pubkey [0; 32]): the IDL authority after `anchor idl erase-authority`. */
export const ERASED = '11111111111111111111111111111111';
export const XNT = 1_000_000_000n;
export const SEAT_BOND_MIN = XNT;
export const SEAT_BOND_BPS = 1_000n;
export const KEEPER_BOND_MIN = 20n * XNT;
export const ORACLE_SEAT_SIZE = 157;
export const EXTRA_STATE_SIZE = 90;
/** The oracle keys compiled into the two builds (tests/fork-rehearsal.mjs guard). */
export const MAINNET_ORACLE = 'J5CU45Didfq7ng9JHXyxYqN7TwAGjMgEyhUcrV7Aixba';
export const LOCALNET_ORACLE = '7umMRWhHfzE6HUgY1xbf55z2FWgdwWeupxxJH1hNj1g9';
export const IDL_V3_FILE = path.join(ROOT, 'oracle/src/idl/moon_forge.v3.json');
export const IDL_LIVE_FILE = path.join(ROOT, 'oracle/src/idl/moon_forge.json');
export const PINS_FILE = path.join(ROOT, 'oracle/src/health-pins.json');
export const X1V3_FILE = path.join(ROOT, 'oracle/src/x1-v3.ts');

export const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === 'string' ? Buffer.from(s) : s instanceof PublicKey ? s.toBuffer() : Buffer.from(s))), PROGRAM_ID)[0];
export const le64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
export const P = {
  config: pda('config'), rewardVault: pda('reward_vault'), bankrollVault: pda('bankroll_vault'), drawVault: pda('draw_vault'),
  collection: pda('collection'), artifactAuthority: pda('artifact_authority'), oracleSeat: pda('oracle_seat'),
  houseKeeper: pda('house_keeper'), extraState: pda('extra_state'), extraVault: pda('extra_vault'),
  player: (o) => pda('player', o), war: (o, n) => pda('war', o, le64(n)), bet: (ps, n) => pda('bet', ps, le64(n)),
};
export const programDataAddress = () => PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER_ID)[0];
export const idlAddress = () => PublicKey.createWithSeed(PublicKey.findProgramAddressSync([], PROGRAM_ID)[0], 'anchor:idl', PROGRAM_ID);

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Strict flag parser: `spec` maps a flag name (without --) to 'string' | 'bool'. An unknown flag, a missing value or a
 * repeated flag is an error (a typo must never turn into a silent default on upgrade day).
 */
export function parseArgs(argv, spec, usage) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const name = a.slice(2);
    const kind = spec[name];
    if (!kind) usageError(`unknown flag ${a}`, usage);
    if (name in out) usageError(`flag ${a} given twice`, usage);
    if (kind === 'bool') { out[name] = true; continue; }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) usageError(`flag ${a} needs a value`, usage);
    out[name] = v;
  }
  return out;
}
export function usageError(msg, usage) { console.error(`error: ${msg}\n\n${usage}`); process.exit(2); }
export class Refused extends Error {}
/** Stop the tool before anything is sent (exit 3); the caller's catch prints it. */
export const refuse = (msg) => { throw new Refused(msg); };
export function pubkeyArg(v, what) {
  if (v === undefined || v === null || v === '') return null;
  try { return new PublicKey(v); } catch { refuse(`${what}: "${v}" is not a base58 public key`); }
}
export function lamportsArg(v, what) {
  if (v === undefined) return null;
  if (!/^\d+(\.\d{1,9})?$/.test(v)) refuse(`${what}: "${v}" is not an XNT amount`);
  const [i, f = ''] = v.split('.');
  return BigInt(i) * XNT + BigInt((f + '000000000').slice(0, 9));
}

// ── keys: by file path only; the secret never leaves this function except as a Keypair object ────────────────────────
export function loadKeyFile(file, what) {
  if (!file) return null;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { refuse(`${what}: cannot read the key file (${e.code || e.message})`); }
  let kp;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== 64) throw new Error('not a 64-byte keypair array');
    kp = Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch { refuse(`${what}: the key file is not a 64-byte JSON array (solana-keygen keypair)`); } // never e.message: on Node 22 a JSON SyntaxError quotes the input, i.e. the seed (r4-fix, review r4 finding 14)
  raw = null;
  return kp;
}
/** A key file must match the public key written on the sign-off sheet (the flag); refuse otherwise. */
export function matchKey(kp, pub, what) {
  if (!kp) return null;
  if (pub && !kp.publicKey.equals(pub)) refuse(`${what}: the key file holds ${kp.publicKey.toBase58()}, not the sign-off key ${pub.toBase58()}`);
  return kp;
}

// ── connection, cluster ─────────────────────────────────────────────────────────────────────────────────────────────
export async function connectTo(rpc) {
  const conn = new Connection(rpc, 'confirmed');
  let genesis = null;
  try { genesis = await conn.getGenesisHash(); } catch (e) { refuse(`RPC ${rpc} does not answer getGenesisHash (${String(e.message || e).slice(0, 120)})`); }
  const host = (() => { try { return new URL(rpc).hostname; } catch { return ''; } })();
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  return { conn, rpc, genesis, mainnet: genesis === X1_MAINNET_GENESIS, local };
}
export function describeCluster(c) {
  return c.mainnet ? `X1 MAINNET (genesis ${c.genesis})` : c.local ? `local validator (genesis ${c.genesis})` : `cluster with genesis ${c.genesis}`;
}
/** --send rules: dry unless --send; on X1 mainnet --send also needs --mainnet (a localnet command can never land there). */
export function sendMode(args, c) {
  if (!args.send) return false;
  if (c.mainnet && !args.mainnet) refuse('--send on X1 mainnet also needs --mainnet (so a command meant for a test validator can never land on mainnet)');
  if (!c.mainnet && args.mainnet) refuse('--mainnet given, but the RPC is not X1 mainnet');
  return true;
}

// ── formatting ──────────────────────────────────────────────────────────────────────────────────────────────────────
export const xnt = (l) => {
  const v = BigInt(l); const neg = v < 0n; const a = neg ? -v : v;
  return `${neg ? '-' : ''}${a / XNT}.${(a % XNT).toString().padStart(9, '0')} XNT`;
};
export const iso = (ts) => (ts === null || ts === undefined ? 'n/a' : new Date(Number(ts) * 1000).toISOString().replace('.000Z', 'Z'));
export const b58 = (k) => (k === null || k === undefined ? 'none' : typeof k === 'string' ? k : k.toBase58());
export const big = (x) => BigInt(x.toString());

/** Gate table: ok / warn / fail / info rows, printed in order; `failed` decides the exit code. */
export class Gates {
  constructor() { this.rows = []; }
  add(state, name, detail = '') { this.rows.push({ state, name, detail }); const tag = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL', info: 'info' }[state]; console.log(`  ${tag} ${name}${detail ? `: ${detail}` : ''}`); return state !== 'fail'; }
  ok(n, d) { return this.add('ok', n, d); }
  warn(n, d) { return this.add('warn', n, d); }
  fail(n, d) { return this.add('fail', n, d); }
  info(n, d) { return this.add('info', n, d); }
  check(cond, n, okDetail, failDetail = okDetail) { return cond ? this.ok(n, okDetail) : this.fail(n, failDetail); }
  get failed() { return this.rows.filter((r) => r.state === 'fail'); }
  get warned() { return this.rows.filter((r) => r.state === 'warn'); }
}

// ── IDLs and decoding ───────────────────────────────────────────────────────────────────────────────────────────────
export const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export function loadIdl(file) {
  const idl = readJson(file);
  if (idl.address !== PROGRAM_ID.toBase58()) refuse(`${path.basename(file)} is not this program's IDL (address ${idl.address})`);
  return idl;
}
/** Account decoding by discriminator over one or more IDLs (the first IDL that knows a discriminator wins). */
export function makeDecoder(...idls) {
  const by = new Map();
  for (const idl of idls) {
    const coder = new anchor.BorshAccountsCoder(idl);
    for (const a of idl.accounts || []) {
      const d = Buffer.from(a.discriminator).toString('hex');
      if (!by.has(d)) by.set(d, { name: a.name, coder });
    }
  }
  return {
    kindOf: (data) => by.get(Buffer.from(data).subarray(0, 8).toString('hex'))?.name ?? null,
    discOf: (name) => { for (const [d, v] of by) if (v.name === name) return Buffer.from(d, 'hex'); return null; },
    decode: (data) => {
      const e = by.get(Buffer.from(data).subarray(0, 8).toString('hex'));
      if (!e) return null;
      return { kind: e.name, value: e.coder.decode(e.name, Buffer.from(data)) };
    },
  };
}
export const sortedJson = (x) => (Array.isArray(x) ? x.map(sortedJson) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortedJson(x[k])])) : x);
export const sameJson = (a, b) => JSON.stringify(sortedJson(a)) === JSON.stringify(sortedJson(b));
export const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
export function zeroStrippedSha(b) { let n = b.length; while (n > 0 && b[n - 1] === 0) n--; return sha256(b.subarray(0, n)); }

// ── on-chain reads (read-only) ──────────────────────────────────────────────────────────────────────────────────────
/** The upgradeable-loader Program and ProgramData accounts: deploy slot, upgrade authority (null = none), sizes, body. */
export async function readProgram(conn, { full = false, commitment = 'confirmed' } = {}) {
  const prog = await conn.getAccountInfo(PROGRAM_ID, commitment);
  if (!prog) return { error: 'the program account is missing' };
  if (!prog.owner.equals(LOADER_ID) || prog.data.length < 36 || prog.data.readUInt32LE(0) !== 2) return { error: 'the program account is not an upgradeable-loader Program' };
  const programData = new PublicKey(prog.data.subarray(4, 36));
  const acc = await conn.getAccountInfo(programData, full ? commitment : { commitment, dataSlice: { offset: 0, length: 45 } });
  if (!acc || !acc.owner.equals(LOADER_ID) || acc.data.readUInt32LE(0) !== 3) return { error: `ProgramData ${programData.toBase58()} is missing or not a ProgramData account` };
  const head = Buffer.from(acc.data);
  const deploySlot = Number(head.readBigUInt64LE(4));
  const authority = head[12] === 1 ? new PublicKey(head.subarray(13, 45)) : null;
  let accountLen = full ? head.length : null;
  if (!full) {
    // the length without downloading the ELF: getAccountInfo with a 0-byte slice still reports `space` on recent RPCs;
    // fall back to the full read when it does not
    const sized = await conn.getAccountInfo(programData, { commitment, dataSlice: { offset: 0, length: 0 } }).catch(() => null);
    accountLen = sized && typeof sized.space === 'number' ? sized.space : null;
    if (accountLen === null) { const all = await conn.getAccountInfo(programData, commitment); accountLen = all.data.length; }
  }
  return { programData, deploySlot, authority, accountLen, dataLen: accountLen - 45, lamports: acc.lamports, body: full ? head.subarray(45) : null };
}
/** R-7 rule (x1-v3.ts deployedElfV3): the first `bytes` bytes after the header hash to the pin and the rest is zero. */
export function deployedElfSha(body, bytes) {
  if (body.length < bytes || body.subarray(bytes).some((b) => b !== 0)) return null;
  return sha256(body.subarray(0, bytes));
}
/** Anchor's IDL account: discriminator 8 | authority 32 | data_len u32 | zlib(IDL JSON). */
export async function readIdlAccount(conn, commitment = 'confirmed') {
  const address = await idlAddress();
  const a = await conn.getAccountInfo(address, commitment);
  if (!a) return { address, exists: false };
  const d = Buffer.from(a.data);
  const authority = new PublicKey(d.subarray(8, 40));
  const len = d.readUInt32LE(40);
  let json = null, error = null;
  try { json = JSON.parse(zlib.inflateSync(d.subarray(44, 44 + len)).toString('utf8')); } catch (e) { error = String(e.message || e).slice(0, 120); }
  return { address, exists: true, authority, compressedLen: len, capacity: d.length - 44, accountLen: d.length, json, error, lamports: a.lamports };
}
export async function balance(conn, k) { return BigInt(await conn.getBalance(new PublicKey(k), 'confirmed')); }
export async function rentFor(conn, n) { return BigInt(await conn.getMinimumBalanceForRentExemption(n)); }
/** utils.rs free_balance + seat_bond: max(1 XNT, 10% of (reward vault − its rent − reward_reserved)). */
export async function freePoolAndBond(conn, cfg) {
  const v = await conn.getAccountInfo(P.rewardVault, 'confirmed');
  if (!v) return { error: 'reward vault missing' };
  const rent = await rentFor(conn, v.data.length);
  const lamports = BigInt(v.lamports);
  const reserved = big(cfg.reward_reserved);
  const free = lamports - rent - reserved > 0n ? lamports - rent - reserved : 0n;
  const pct = free * SEAT_BOND_BPS / 10_000n;
  return { lamports, rent, reserved, free, bond: pct > SEAT_BOND_MIN ? pct : SEAT_BOND_MIN };
}
export async function fetchDecoded(conn, decoder, k, commitment = 'confirmed') {
  const a = await conn.getAccountInfo(k, commitment);
  if (!a) return null;
  if (!a.owner.equals(PROGRAM_ID)) return { foreign: true, owner: a.owner, lamports: a.lamports, size: a.data.length };
  const d = decoder.decode(a.data);
  return d ? { ...d, lamports: a.lamports, size: a.data.length } : { undecodable: true, lamports: a.lamports, size: a.data.length };
}

// ── Metaplex Core collection (CollectionV1 + plugin registry), read-only ─────────────────────────────────────────────
const CORE_PLUGIN = ['Royalties', 'FreezeDelegate', 'BurnDelegate', 'TransferDelegate', 'UpdateDelegate', 'PermanentFreezeDelegate', 'Attributes', 'PermanentTransferDelegate', 'PermanentBurnDelegate', 'Edition', 'MasterEdition', 'AddBlocker', 'ImmutableMetadata', 'VerifiedCreators', 'Autograph'];
const CORE_AUTH = ['None', 'Owner', 'UpdateAuthority', 'Address'];
/**
 * Key::CollectionV1 (5) | update_authority 32 | name | uri | num_minted u32 | current_size u32, then PluginHeaderV1 (3,
 * registry offset u64) and PluginRegistryV1 (4, Vec<{plugin_type u8, authority (u8 [+ 32]), offset u64}>, ...). At a
 * Royalties offset: Plugin tag 0 | basis_points u16 | Vec<{address 32, percentage u8}> | RuleSet (0 = None).
 * A Royalties record whose authority is None can never be updated, removed or re-delegated (the lock).
 */
export function parseCoreCollection(data) {
  const d = Buffer.from(data);
  let o = 0;
  if (d[o] !== 5) throw new Error(`not a Core CollectionV1 account (key ${d[o]})`);
  o += 1;
  const updateAuthority = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const str = () => { const n = d.readUInt32LE(o); o += 4; const s = d.subarray(o, o + n).toString('utf8'); o += n; return s; };
  const name = str(), uri = str();
  const numMinted = d.readUInt32LE(o); o += 4;
  const currentSize = d.readUInt32LE(o); o += 4;
  const out = { updateAuthority, name, uri, numMinted, currentSize, plugins: [] };
  if (o >= d.length || d[o] !== 3) return out;
  let r = Number(d.readBigUInt64LE(o + 1));
  if (d[r] !== 4) throw new Error(`plugin registry key ${d[r]} at offset ${r}`);
  r += 1;
  const n = d.readUInt32LE(r); r += 4;
  for (let i = 0; i < n; i++) {
    const type = d[r]; r += 1;
    const at = d[r]; r += 1;
    let address = null;
    if (at === 3) { address = new PublicKey(d.subarray(r, r + 32)); r += 32; }
    const offset = Number(d.readBigUInt64LE(r)); r += 8;
    const p = { type: CORE_PLUGIN[type] ?? `type${type}`, authority: CORE_AUTH[at] ?? `auth${at}`, address, offset };
    if (type === 0) {
      let q = offset;
      if (d[q] !== 0) throw new Error(`Royalties record points at plugin tag ${d[q]}`);
      q += 1;
      const bps = d.readUInt16LE(q); q += 2;
      const nc = d.readUInt32LE(q); q += 4;
      const creators = [];
      for (let j = 0; j < nc; j++) { creators.push({ address: new PublicKey(d.subarray(q, q + 32)), percentage: d[q + 32] }); q += 33; }
      p.royalties = { bps, creators, ruleSet: ['None', 'ProgramAllowList', 'ProgramDenyList'][d[q]] ?? `rule${d[q]}` };
    }
    out.plugins.push(p);
  }
  return out;
}
export function royaltiesOf(col) { return col.plugins.find((p) => p.type === 'Royalties') ?? null; }

/** SBF materialises a Pubkey constant as four lddw immediates (tests/fork-rehearsal.mjs keyChunks): 4 = compiled in. */
export function keyChunks(so, key) {
  const kb = new PublicKey(key).toBuffer();
  return [0, 1, 2, 3].filter((i) => { const c = kb.subarray(8 * i, 8 * i + 8); return so.includes(Buffer.concat([c.subarray(0, 4), Buffer.alloc(4), c.subarray(4)])) || so.includes(c); }).length;
}

// ── instructions ────────────────────────────────────────────────────────────────────────────────────────────────────
/** An instruction from the IDL's discriminator and an explicit, named account list (printed as given). */
export function idlIx(idl, name, accounts, args = Buffer.alloc(0)) {
  const i = idl.instructions.find((x) => x.name === name);
  if (!i) refuse(`the IDL has no instruction ${name}`);
  if (i.accounts.length !== accounts.length) refuse(`${name}: ${accounts.length} accounts given, the IDL lists ${i.accounts.length}`);
  accounts.forEach((a, j) => { if (a.name !== i.accounts[j].name) refuse(`${name}: account ${j} is ${a.name}, the IDL says ${i.accounts[j].name}`); });
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: !!a.signer, isWritable: !!a.writable })),
    data: Buffer.concat([Buffer.from(i.discriminator), args]),
  });
  ix.names = accounts.map((a) => a.name);
  ix.label = name;
  return ix;
}
/** loader-v3 SetAuthority (tag 4): ProgramData (w), current authority (s), [new authority]; none = `--final`. */
export function loaderSetAuthorityIx(current, next) {
  const keys = [
    { pubkey: programDataAddress(), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(current), isSigner: true, isWritable: false },
  ];
  if (next) keys.push({ pubkey: new PublicKey(next), isSigner: false, isWritable: false });
  const ix = new TransactionInstruction({ programId: LOADER_ID, keys, data: Buffer.from([4, 0, 0, 0]) });
  ix.names = ['program_data', 'current_authority', ...(next ? ['new_authority'] : [])];
  ix.label = next ? 'loader SetAuthority' : 'loader SetAuthority (final: none)';
  return ix;
}
/** anchor IDL instruction SetAuthority (IDL_IX_TAG ‖ variant 4 ‖ new_authority): idl (w), authority (s). */
export const IDL_IX_TAG = Buffer.from('40f4bc78a7e9690a', 'hex'); // 0x0a69e9a778bcf440 little-endian
export async function idlSetAuthorityIx(authority, next) {
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: await idlAddress(), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(authority), isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([IDL_IX_TAG, Buffer.from([4]), new PublicKey(next).toBuffer()]),
  });
  ix.names = ['idl', 'authority'];
  ix.label = next === ERASED ? 'IDL SetAuthority (erase: 11111111111111111111111111111111)' : 'IDL SetAuthority';
  return ix;
}
export const cuLimit = (units) => { const ix = ComputeBudgetProgram.setComputeUnitLimit({ units }); ix.names = []; ix.label = `compute unit limit ${units}`; return ix; };
export const cuPrice = (micro) => { const ix = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro }); ix.names = []; ix.label = `compute unit price ${micro} micro-lamports`; return ix; };

export function printIxs(ixs, roles = {}) {
  ixs.forEach((ix, n) => {
    console.log(`    [${n}] ${ix.label ?? ix.programId.toBase58()}  (program ${ix.programId.toBase58()})`);
    ix.keys.forEach((k, j) => {
      const nm = ix.names?.[j] ?? `#${j}`;
      const role = roles[k.pubkey.toBase58()];
      console.log(`         ${nm.padEnd(22)} ${k.pubkey.toBase58().padEnd(44)} ${k.isSigner ? 'signer ' : '       '}${k.isWritable ? 'writable' : 'readonly'}${role ? `  (${role})` : ''}`);
    });
    if (ix.args) console.log(`         args: ${ix.args}`);
  });
}

/** The first Anchor error name of a log, else the raw error, else "ok". */
export function errorCode(err, logs) {
  const named = (logs || []).map((l) => l.match(/Error Code: (\w+)/)).find(Boolean)?.[1];
  if (named) return named;
  if (!err) return 'ok';
  return JSON.stringify(err);
}
/**
 * Simulates `ixs` paid by `payer` without signatures (sigVerify false) and reports, for every writable account, its
 * lamports before and after: the exact amounts the transaction would move (the fee payer's line includes the fee).
 */
export async function simulateIxs(conn, ixs, payer, { commitment = 'confirmed' } = {}) {
  const writable = [];
  for (const ix of ixs) for (const k of ix.keys) if (k.isWritable && !writable.some((w) => w.equals(k.pubkey))) writable.push(k.pubkey);
  if (!writable.some((w) => w.equals(new PublicKey(payer)))) writable.unshift(new PublicKey(payer));
  const before = await conn.getMultipleAccountsInfo(writable, commitment);
  const { blockhash } = await conn.getLatestBlockhash(commitment);
  const msg = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const r = await conn.simulateTransaction(new VersionedTransaction(msg), {
    sigVerify: false, replaceRecentBlockhash: true, commitment,
    accounts: { encoding: 'base64', addresses: writable.map((w) => w.toBase58()) },
  });
  const logs = r.value.logs || [];
  // a failed simulation returns no post-state: no amounts then (never a misleading "-> 0")
  const deltas = r.value.err || !r.value.accounts ? [] : writable.map((k, i) => {
    const pre = BigInt(before[i]?.lamports ?? 0);
    const post = BigInt(r.value.accounts[i]?.lamports ?? 0);
    return { key: k.toBase58(), pre, post, delta: post - pre, created: !before[i] && !!r.value.accounts[i] };
  });
  return { err: r.value.err, code: errorCode(r.value.err, logs), logs, units: r.value.unitsConsumed ?? null, deltas };
}
export function printSimulation(sim, roles = {}) {
  console.log(`    simulation: ${sim.code}${sim.units !== null ? `, ${sim.units} compute units` : ''}`);
  for (const d of sim.deltas) {
    if (d.delta === 0n && !d.created) continue;
    console.log(`      ${d.key.padEnd(44)} ${xnt(d.pre).padStart(22)} -> ${xnt(d.post).padStart(22)}  (${d.delta >= 0n ? '+' : ''}${xnt(d.delta)})${d.created ? ' created' : ''}${roles[d.key] ? `  ${roles[d.key]}` : ''}`);
  }
  if (sim.err) for (const l of sim.logs.slice(-8)) console.log(`      | ${l}`);
}
/**
 * The only sender. Signs, re-simulates the SIGNED transaction (sigVerify true), sends it once, waits for confirmation.
 * It never resends: on a timeout it reports the signature, and the tools re-read the chain before any retry.
 */
export async function sendIxs(conn, ixs, signers, { commitment = 'confirmed' } = {}) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(commitment);
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  const sim = await conn.simulateTransaction(tx, signers);
  if (sim.value.err) {
    const e = new Error(`signed simulation failed: ${errorCode(sim.value.err, sim.value.logs)}`);
    e.logs = sim.value.logs;
    throw e;
  }
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 5 });
  console.log(`    sent ${sig}`);
  let res;
  try {
    res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, commitment);
  } catch (e) {
    const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true }).catch(() => null);
    throw new Error(`confirmation of ${sig} failed (${String(e.message || e).slice(0, 120)}); status now ${JSON.stringify(st?.value ?? null)}. Re-run the tool: it re-reads the chain and skips what is done`);
  }
  if (res.value.err) throw new Error(`transaction ${sig} failed on chain: ${JSON.stringify(res.value.err)}`);
  let t = null;
  for (let i = 0; i < 20 && !t; i++) { t = await conn.getTransaction(sig, { commitment, maxSupportedTransactionVersion: 0 }); if (!t) await new Promise((r) => setTimeout(r, 500)); }
  return { sig, slot: t?.slot ?? null, blockTime: t?.blockTime ?? null, fee: t?.meta?.fee ?? null };
}

/**
 * SPEC-UPGRADE-v2 6.3 step 1, simulated without signatures: init_seat (not custom 101), create_war (SealedJoinRequired),
 * place_bet (KeeperRequired). The two game calls need a PlayerState owner: the first one on chain (null codes without).
 */
export async function stepOneSimulations(conn, idl, decoder, cfg) {
  const bs58 = anchor.utils.bytes.bs58;
  const players = await conn.getProgramAccounts(PROGRAM_ID, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 0, bytes: bs58.encode(decoder.discOf('PlayerState')) } }] }).catch(() => []);
  const owner = players.length ? (decoder.decode((await conn.getAccountInfo(players[0].pubkey, 'confirmed')).data)?.value?.owner ?? null) : null;
  const payer = owner ?? cfg.architect;
  const initSeat = idlIx(idl, 'init_seat', [
    { name: 'config', pubkey: P.config }, { name: 'seat', pubkey: P.oracleSeat, writable: true }, { name: 'reward_vault', pubkey: P.rewardVault },
    { name: 'payer', pubkey: payer, writable: true, signer: true }, { name: 'system_program', pubkey: SYSTEM_ID },
  ]);
  const out = { initSeat: (await simulateIxs(conn, [initSeat], payer)).code, createWar: null, placeBet: null, owner };
  if (!owner) return out;
  const ps = P.player(owner);
  const nonce = big(decoder.decode((await conn.getAccountInfo(ps, 'confirmed')).data).value.nonce);
  const cw = idlIx(idl, 'create_war', [
    { name: 'config', pubkey: P.config }, { name: 'creator_state', pubkey: ps, writable: true }, { name: 'war', pubkey: P.war(owner, nonce), writable: true },
    { name: 'owner', pubkey: owner, writable: true, signer: true }, { name: 'asset', pubkey: SYSTEM_ID }, { name: 'record', pubkey: SYSTEM_ID },
    { name: 'collection', pubkey: SYSTEM_ID }, { name: 'system_program', pubkey: SYSTEM_ID },
  ], Buffer.concat([le64(1_000_000), PublicKey.default.toBuffer()]));
  const pb = idlIx(idl, 'place_bet', [
    { name: 'config', pubkey: P.config, writable: true }, { name: 'player_state', pubkey: ps, writable: true }, { name: 'bet', pubkey: P.bet(ps, nonce), writable: true },
    { name: 'bankroll_vault', pubkey: P.bankrollVault, writable: true }, { name: 'reward_vault', pubkey: P.rewardVault, writable: true }, { name: 'architect', pubkey: cfg.architect, writable: true },
    { name: 'signer', pubkey: owner, writable: true, signer: true }, { name: 'system_program', pubkey: SYSTEM_ID },
  ], Buffer.concat([Buffer.from([0]), le64(0), Buffer.from([0]), le64(1_000_000), Buffer.alloc(32, 1)]));
  out.createWar = (await simulateIxs(conn, [cw], owner)).code;
  out.placeBet = (await simulateIxs(conn, [pb], owner)).code;
  return out;
}

// ── the oracle's R-7 pin (oracle/src/x1-v3.ts) ──────────────────────────────────────────────────────────────────────
export const PIN_NULL_LINE = 'export const UPGRADED_ELF: { sha256: string; bytes: number } | null = null;';
export const PIN_RE = /^export const UPGRADED_ELF: \{ sha256: string; bytes: number \} \| null = (null|\{ sha256: "([0-9a-f]{64})", bytes: (\d+) \});(?=\r?$)/m;
export const pinLine = (sha, bytes) => `export const UPGRADED_ELF: { sha256: string; bytes: number } | null = { sha256: "${sha}", bytes: ${bytes} };`;
export function readPin(file = X1V3_FILE) {
  const src = fs.readFileSync(file, 'utf8');
  const all = src.match(new RegExp(PIN_RE.source, 'gm')) || [];
  if (all.length !== 1) throw new Error(`${path.basename(file)}: the UPGRADED_ELF line occurs ${all.length} times (expected exactly once)`);
  const m = src.match(PIN_RE);
  return m[1] === 'null' ? null : { sha256: m[2], bytes: Number(m[3]) };
}
/** The S2 build the tools check against: --elf <file>, else --elf-sha + --elf-bytes, else the oracle's pin, else null. */
export function elfExpectation(args) {
  if (args.elf) {
    const b = fs.readFileSync(args.elf);
    return { sha256: sha256(b), bytes: b.length, from: `file ${path.basename(args.elf)}`, so: b };
  }
  if (args['elf-sha'] || args['elf-bytes']) {
    if (!/^[0-9a-f]{64}$/.test(args['elf-sha'] || '') || !/^\d+$/.test(args['elf-bytes'] || '')) refuse('--elf-sha needs 64 hex characters and --elf-bytes a byte count, together');
    return { sha256: args['elf-sha'], bytes: Number(args['elf-bytes']), from: 'flags' };
  }
  const pin = readPin(args['pin-file'] || X1V3_FILE);
  return pin ? { ...pin, from: 'the UPGRADED_ELF pin of oracle/src/x1-v3.ts' } : null;
}

// ── health pins (oracle/src/health-pins.json) ───────────────────────────────────────────────────────────────────────
export const PIN_KEYS = ['upgradeAuthority', 'idlAuthority', 'architect', 'seatCold', 'seatRefund', 'keeperSeat'];
export function readPinsFile(file = PINS_FILE) {
  const raw = fs.readFileSync(file, 'utf8');
  return { raw, json: JSON.parse(raw), crlf: raw.includes('\r\n') };
}
/** Same key order, same line endings, 2-space indent, trailing newline as the file had. */
export function writePinsFile(file, cur, next) {
  let s = JSON.stringify(next, null, 2) + (cur.raw.endsWith('\n') ? '\n' : '');
  if (cur.crlf) s = s.replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(file, s);
}

export function header(title, c, send) {
  console.log(`${title}`);
  console.log(`  cluster: ${describeCluster(c)}`);
  console.log(`  rpc:     ${c.rpc}`);
  console.log(`  mode:    ${send ? 'SEND (transactions will be signed and sent)' : 'DRY RUN (read and simulate only; nothing is signed or sent)'}`);
  console.log(`  time:    ${new Date().toISOString()}`);
}
/** Runs a tool's main(): a Refused stops with exit 3 before anything more is sent; any other error exits 1. */
export function run(main) {
  main().then((code) => process.exit(code ?? 0), (e) => {
    if (e instanceof Refused) { console.error(`\nREFUSED: ${e.message}`); process.exit(3); }
    console.error(`\nERROR: ${e?.stack || e}`);
    if (e?.logs) for (const l of e.logs.slice(-10)) console.error(`  | ${l}`);
    process.exit(1);
  });
}
