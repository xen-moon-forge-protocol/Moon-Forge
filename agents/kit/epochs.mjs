/**
 * Where the kit reads the oracle's public files (epoch-<n>.json, extra-<n>.json, index.json, the Genesis airdrop list):
 *
 *   { dir: 'path/to/frontend/public/epochs' }   a local directory (a clone of the repository, or any mirror you saved)
 *   { url: EPOCHS_URL }                         HTTPS (the site, or a mirror); an explicit opt-in: by default the kit
 *                                               sends nothing anywhere except the X1 RPC endpoints you configure
 *   { files: { 'epoch-1.json': {...} } }        objects already in memory (tests, your own cache)
 *
 * A file is only data until it is tied to the chain: verifyMyClaim() and claim() check every leaf against the root and
 * data hash that the program stored when the epoch was published, so a wrong or forged file is refused, wherever it
 * came from.
 */
import fs from 'node:fs';
import path from 'node:path';
import { protoPath } from './verify-leaf.mjs';

export const SITE_URL = 'https://xen-moon-forge-protocol.github.io/Moon-Forge/';
export const EPOCHS_URL = `${SITE_URL}epochs/`;
export const AIRDROP_URL = `${SITE_URL}airdrop/airdrop.json`;
const MAX_BYTES = 32_000_000;

function parse(text, name) {
  if (text.length > MAX_BYTES) throw new Error(`${name}: larger than ${MAX_BYTES} bytes`);
  let v;
  try { v = JSON.parse(text); } catch { throw new Error(`${name}: not valid JSON`); }
  const proto = protoPath(v);
  if (proto) throw new Error(`${name}: has a "__proto__" member at ${proto}`);
  return v;
}

export class EpochSource {
  /** @param {{ dir?: string, url?: string, files?: Record<string, object>, fetchImpl?: Function }} src */
  constructor(src) {
    if (!src || (!src.dir && !src.url && !src.files)) throw new Error('epochs: pass { dir }, { url } or { files }');
    if (src.url && !/^https:\/\//.test(src.url)) throw new Error('epochs: the url must be https://');
    this.dir = src.dir ? path.resolve(src.dir) : null;
    this.url = src.url ? (src.url.endsWith('/') ? src.url : `${src.url}/`) : null;
    this.files = src.files ?? null;
    this.fetchImpl = src.fetchImpl ?? globalThis.fetch;
    this.cache = new Map();
    this.describe = this.dir ? `directory ${this.dir}` : this.url ? `URL ${this.url}` : 'in-memory files';
  }
  /** The parsed file `name` (e.g. 'epoch-3.json'), or null when it does not exist. */
  async read(name) {
    if (!/^[a-z0-9-]+\.json$/.test(name)) throw new Error(`epochs: bad file name ${name}`);
    if (this.cache.has(name)) return this.cache.get(name);
    let v = null;
    if (this.files) v = this.files[name] ? JSON.parse(JSON.stringify(this.files[name])) : null;
    else if (this.dir) {
      let text = null;
      try { text = fs.readFileSync(path.join(this.dir, name), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw new Error(`epochs: ${name} could not be read (${e.code})`); }
      v = text === null ? null : parse(text, name);
    } else {
      const r = await this.fetchImpl(`${this.url}${name}`, { headers: { accept: 'application/json' } });
      if (r.status === 404) v = null;
      else if (!r.ok) throw new Error(`epochs: ${name}: HTTP ${r.status}`);
      else v = parse(await r.text(), name);
    }
    // epoch files never change once published; index.json grows every week, so it is read again each time
    if (v !== null && name !== 'index.json') this.cache.set(name, v);
    return v;
  }
  /** index.json: { programId, epochs: [{ epoch, root, dataHash, leaves, totalScore, tx, createdAt }] } (or a list built from the directory). */
  async index() {
    const idx = await this.read('index.json');
    if (idx && Array.isArray(idx.epochs)) return idx;
    if (this.dir) {
      const epochs = fs.readdirSync(this.dir).map((n) => /^epoch-(\d+)\.json$/.exec(n)).filter(Boolean).map((m) => ({ epoch: Number(m[1]) })).sort((a, b) => a.epoch - b.epoch);
      return { epochs };
    }
    if (this.files) return { epochs: Object.keys(this.files).map((n) => /^epoch-(\d+)\.json$/.exec(n)).filter(Boolean).map((m) => ({ epoch: Number(m[1]) })).sort((a, b) => a.epoch - b.epoch) };
    return { epochs: [] };
  }
  epoch(n) { return this.read(`epoch-${Number(n)}.json`); }
  extra(n) { return this.read(`extra-${Number(n)}.json`); }
  /** The latest base epoch file (highest number in the index), or null. */
  async latest() {
    const idx = await this.index();
    const last = idx.epochs.reduce((m, e) => Math.max(m, Number(e.epoch)), 0);
    return last ? this.epoch(last) : null;
  }
}

/** An EpochSource from connect()'s `epochs` option (a source object, a directory path, an https URL, or 'site'). */
export function epochSourceOf(opt) {
  if (!opt) return null;
  if (opt instanceof EpochSource) return opt;
  if (opt === 'site') return new EpochSource({ url: EPOCHS_URL });
  if (typeof opt === 'string') return /^https:\/\//.test(opt) ? new EpochSource({ url: opt }) : new EpochSource({ dir: opt });
  return new EpochSource(opt);
}
