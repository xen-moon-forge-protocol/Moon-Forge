/**
 * Secrets store for the sealed games (Duel element and salt, Moon Wars entropy and join secret). A sealed game is
 * lost if its secret is: the creator of a Duel who cannot reveal loses the pot; a joiner who cannot open its element
 * gives its stake to the pool; a Moon Wars creator who cannot seed makes the match a draw; a joiner who cannot reveal
 * loses. So the kit writes the secret to disk BEFORE the transaction that commits to it is broadcast, and reuses the
 * same bytes if that transaction is retried for the same account (same commitment, so a retry never commits to a
 * second secret that would then be lost).
 *
 *   default directory  ~/.moonforge/secrets/<program id>/   (one JSON file per game account; mode 0600; the file and
 *                       the directory are fsynced). Pass connect({ secretsDir }) to keep them elsewhere, e.g. an
 *                       encrypted volume. Back the directory up with the agent key: without it, an open game cannot
 *                       be finished.
 *
 * The files hold game secrets only, never a key. A secret is useless once its game account is closed;
 * pruneSecrets() deletes those.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const defaultSecretsDir = (programId) => path.join(os.homedir(), '.moonforge', 'secrets', String(programId));
const safeName = (kind, account) => {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(kind)) throw new Error(`secrets: bad kind "${kind}"`);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(account)) throw new Error('secrets: the account is not a base58 address');
  return `${kind}-${account}.json`;
};

function fsyncDir(dir) {
  // POSIX: make the new directory entry durable; Windows cannot open a directory for fsync (ignored there)
  let fd = null;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* not supported on this platform */ } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ } }
}

export class SecretsStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
  }
  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.dir, 0o700); } catch { /* best effort on non-POSIX systems */ }
  }
  pathOf(kind, account) { return path.join(this.dir, safeName(kind, account)); }
  /** The stored record of (kind, account), or null. */
  get(kind, account) {
    const file = this.pathOf(kind, account);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`secrets: ${kind} ${account} could not be read (${e.code})`); }
    let rec;
    try { rec = JSON.parse(text); } catch { throw new Error(`secrets: the file of ${kind} ${account} is not valid JSON (it is not shown)`); }
    if (rec.kind !== kind || rec.account !== account) throw new Error(`secrets: the file of ${kind} ${account} holds another record`);
    return rec;
  }
  /**
   * Writes the record of (kind, account) durably and returns it: temp file, fsync, then published with no-replace
   * semantics (a hard link, which fails when the name exists), fsync of the directory. Refuses to replace an existing
   * record with different secret bytes, also when another process with the same key wrote it a moment earlier: a game
   * commits to exactly one secret (the error has code 'ESECRETEXISTS').
   */
  put(kind, account, fields) {
    this.ensureDir();
    const sameAs = (prior) => Object.keys(fields).every((k) => JSON.stringify(prior[k]) === JSON.stringify(fields[k]));
    const conflict = () => Object.assign(new Error(`secrets: ${kind} ${account} already has a different secret on disk; refusing to overwrite it`), { code: 'ESECRETEXISTS' });
    const prior = this.get(kind, account);
    const rec = { kind, account, createdAt: new Date().toISOString(), ...fields };
    if (prior) {
      if (!sameAs(prior)) throw conflict();
      return prior;
    }
    const file = this.pathOf(kind, account);
    const text = JSON.stringify(rec, null, 1);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const lost = () => {
      // another process published first: its record wins, ours was never visible
      const winner = this.get(kind, account);
      if (!winner || !sameAs(winner)) throw conflict();
      return winner;
    };
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if (e.code === 'EEXIST') { fs.rmSync(tmp, { force: true }); return lost(); }
      // a file system without hard links: exclusive creation of the final name (still never replaces a record)
      fs.rmSync(tmp, { force: true });
      let fd2;
      try { fd2 = fs.openSync(file, 'wx', 0o600); } catch (e2) { if (e2.code === 'EEXIST') return lost(); throw e2; }
      try { fs.writeSync(fd2, text); fs.fsyncSync(fd2); } finally { fs.closeSync(fd2); }
      try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
      fsyncDir(this.dir);
      return rec;
    }
    fs.rmSync(tmp, { force: true });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    fsyncDir(this.dir);
    return rec;
  }
  /**
   * The record of (kind, account): the stored one when it exists (a retry reuses the same bytes), otherwise a fresh one
   * made by `make()` and written durably before it is returned. When another process with the same key creates the
   * same game's record at the same moment, the first one published wins and both callers get (and commit to) it.
   */
  getOrCreate(kind, account, make) {
    const prior = this.get(kind, account);
    if (prior) return { record: prior, reused: true };
    try {
      return { record: this.put(kind, account, make()), reused: false };
    } catch (e) {
      if (e?.code !== 'ESECRETEXISTS') throw e;
      return { record: this.get(kind, account), reused: true };
    }
  }
  /** Updates fields of an existing record (e.g. the transaction signature once known). */
  annotate(kind, account, fields) {
    const prior = this.get(kind, account);
    if (!prior) return null;
    const file = this.pathOf(kind, account);
    const next = { ...prior, ...fields, kind, account };
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeSync(fd, JSON.stringify(next, null, 1)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    fsyncDir(this.dir);
    return next;
  }
  /** Every stored record (kind, account, fields). */
  list() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names.filter((n) => /^[a-z][a-z0-9-]+-[1-9A-HJ-NP-Za-km-z]{32,44}\.json$/.test(n)).map((n) => {
      const m = /^([a-z][a-z0-9-]+)-([1-9A-HJ-NP-Za-km-z]{32,44})\.json$/.exec(n);
      try { return this.get(m[1], m[2]); } catch { return null; }
    }).filter(Boolean);
  }
  /** Deletes the records whose game account no longer exists (isClosed(record) → true). Returns the count. */
  async prune(isClosed) {
    let n = 0;
    for (const rec of this.list()) {
      if (await isClosed(rec)) { fs.rmSync(this.pathOf(rec.kind, rec.account), { force: true }); n++; }
    }
    return n;
  }
}

/** 32 random bytes as hex (a salt, an entropy or a secret). */
export const randomHex32 = () => crypto.randomBytes(32).toString('hex');
