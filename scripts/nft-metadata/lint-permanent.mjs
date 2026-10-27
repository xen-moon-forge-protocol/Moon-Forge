// Lint for the PERMANENT texts (docs/WORDING.md section 4): the Arweave metadata JSON, collection.json and the IDL /
// crate description. Stricter than scripts/wording-check.mjs: no negation exception, no allow-list, and every number
// must be a program fact from the short list below. Any hit blocks the upload.
//
// Usage: node scripts/nft-metadata/lint-permanent.mjs <metadata dir> [--image-base <url>]   (exit 1 on any hit)
//        node scripts/nft-metadata/lint-permanent.mjs --idl <idl.json> [--cargo <Cargo.toml>]
// Library: lintFiles(files, { imageBase }) / lintIdl(idl) return a list of { file, field, rule, text } hits.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SITE, PROGRAM_ID, COLLECTION, JSON_PATHS } from './tiers.mjs';
import { EXTERNAL_URL } from './texts-final.mjs';

export const IDL_DESCRIPTION =
  'Moon Forge Protocol: burn XEN on a supported EVM chain, receive XNT on X1. Zero protocol fee on the burn path.';

// Numbers a permanent text may contain (forge split 50/20/25/5, supply caps 600/300/90/10, "0" for Genesis).
const ALLOWED_NUMBERS = new Set(['0', '5', '10', '20', '25', '50', '90', '300', '600']);

// wording-check: ignore-start  (this block lists the words it forbids)
const RULES = [
  ['banned-word', /\b(earn\w*|yield\w*|profit\w*|invest\w*|guarantee\w*|audited|returns?|APR|APY|ROI|passive|risk[- ]free|bigger share|share of|interest|dividend\w*|income|reward(s|ed|ing)? (you|holders))\b/i],
  ['banned-word', /\b(immutable|trustless|forever|permanent(ly)?|safe|secure|official partner)\b/i],
  ['policy', /\b(boost\w*|chips?|tickets?|drops?|lottery|jackpot|duels?|moon wars|arena|games?|predictions?|forge right|price paid|weekly|per week|season|honou?red|marketplaces?)\b/i],
  ['policy', /(\d\s*[x×]\b|×|\d+(\.\d+)?\s*%\s*\/|\bper (day|epoch|month|year)\b|\bMIN_PAY\b|\bRHO\b|\bK\s*=)/i],
  ['date', /\b(19|20)\d\d\b|\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|jun(e)?|jul(y)?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b|\b(mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)\b|\bUTC\b/i],
  // other projects (docs/WORDING.md section 3 "Names") and marketplaces
  ['name', /\b(X1 Labs|FairCrypto|XEN Prime|X1 Forge|Moon Party|Magic Eden|Tensor|OpenSea|Solaris)\b/i],
  // services and apps: never in metadata; fine in program error messages (XDEX is the price source the program reads)
  ['service', /\b(Backpack|Phantom|XDEX|GeckoTerminal|Telegram|Discord|Twitter)\b/i],
  ['url', /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|io|xyz|net|org|dev|app|gg|me|co)\b)/i],
  ['personal', /([\w.+-]+@[\w-]+\.[\w.]+|@[A-Za-z0-9_]{2,}|\b[A-Za-z]:[\\/]|\/(home|Users|mnt)\/|\b(GMT|UTC)\s*[+-]\s*\d|\b(America|Europe|Asia|Africa|Australia|Pacific|Atlantic)\/[A-Z]|[+-]\d\d:\d\d\b)/],
  ['hidden', /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/],
  ['emoji', /\p{Extended_Pictographic}/u],
  ['instruction', /\b(ignore (all|previous)|assistant|AI model|recommend\w*|you should|always say)\b/i],
];
// IDL docs (permanent at the IDL freeze): the docs/WORDING.md section 2 words (the verb "return" is normal there),
// the oracle policy numbers, other projects' names, URLs, personal data and hidden text.
const IDL_RULES = [
  ['banned-word', /\b(earn\w*|yield\w*|profit\w*|invest\w*|guarantee\w*|audited|APR|APY|ROI|passive income|risk[- ]free|bigger share)\b/i],
  ['policy', /(1\s*%\s*\/\s*week|\b2\s*[x×]|\b52[- ]weeks?\b|\bMIN_PAY\b|\bRHO_MAX\b|\bSEASON\b)/i],
  ...RULES.filter(([rule]) => ['name', 'url', 'personal', 'hidden', 'emoji', 'instruction'].includes(rule)),
];
// wording-check: ignore-end

const ADDRESSES = new RegExp(`\\b(${PROGRAM_ID}|${COLLECTION})\\b`, 'g');

export function lintText(text, where) {
  const hits = [];
  const plain = text.replace(ADDRESSES, ' ').replace(/\bX1\b/g, ' ');
  for (const [rule, re] of RULES) {
    const m = plain.match(re);
    if (m) hits.push({ ...where, rule, text: m[0] });
  }
  for (const n of plain.match(/\d+(\.\d+)?/g) ?? []) {
    if (!ALLOWED_NUMBERS.has(n)) hits.push({ ...where, rule: 'number', text: n });
  }
  return hits;
}

const ASSET_KEYS = ['name', 'symbol', 'description', 'image', 'external_url', 'attributes', 'properties'];
const COLLECTION_KEYS = ['name', 'symbol', 'description', 'image', 'external_url'];
const ASSET_TRAITS = ['Tier', 'Variant', 'Element', 'Max Alive', 'Recyclable'];

// files: { '<path>': object }. imageBase: the https://<gateway>/<manifest> the images must live under.
export function lintFiles(files, { imageBase } = {}) {
  const hits = [];
  const add = (file, field, rule, text) => hits.push({ file, field, rule, text });
  const paths = Object.keys(files).sort();
  if (paths.join() !== [...JSON_PATHS].sort().join()) add('*', 'paths', 'paths', `expected the 13 program paths, got ${paths.join(', ')}`);
  for (const [file, m] of Object.entries(files)) {
    const isCollection = file === 'collection.json';
    const keys = Object.keys(m);
    const want = isCollection ? COLLECTION_KEYS : ASSET_KEYS;
    if (keys.join() !== want.join()) add(file, 'keys', 'keys', keys.join(','));
    for (const field of ['name', 'symbol', 'description']) {
      if (typeof m[field] !== 'string' || !m[field]) add(file, field, 'missing', String(m[field]));
      else hits.push(...lintText(m[field], { file, field }));
    }
    if (m.external_url !== EXTERNAL_URL) add(file, 'external_url', 'url', String(m.external_url));
    const images = [m.image, ...(m.properties?.files ?? []).map((f) => f.uri)];
    for (const uri of images) {
      if (typeof uri !== 'string' || (imageBase && !uri.startsWith(`${imageBase}/`)) || !/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9_-]{43}\/[a-z_]+\/[a-z_]+\.webp$/.test(uri)) {
        add(file, 'image', 'url', String(uri));
      }
    }
    const d = m.description ?? '';
    if (!d.includes(COLLECTION)) add(file, 'description', 'required', 'genuine-collection line (collection address)');
    if (!/in a wallet app sends its floor to the reward pool; recycle it through Moon Forge instead\./.test(d)) {
      add(file, 'description', 'required', 'wallet-burn warning');
    }
    if (!d.includes('made with an AI image tool')) add(file, 'description', 'required', 'AI-art note');
    if (!d.includes('no payout is promised')) add(file, 'description', 'required', 'no-promise sentence');
    if (!isCollection) {
      const traits = (m.attributes ?? []).map((a) => a.trait_type);
      if (traits.join() !== ASSET_TRAITS.join()) add(file, 'attributes', 'attributes', traits.join(','));
      for (const a of m.attributes ?? []) hits.push(...lintText(`${a.trait_type} ${a.value}`, { file, field: 'attributes' }));
      if (m.properties?.category !== 'image' || m.properties?.files?.length !== 1 || m.properties.files[0].type !== 'image/webp') {
        add(file, 'properties', 'keys', JSON.stringify(m.properties));
      }
    }
  }
  return hits;
}

// The IDL description (from Cargo.toml) must be exactly the WORDING.md section 4 sentence; every other prose string that
// becomes permanent at the IDL freeze (docs, error messages, string constants) is scanned for banned words, policy
// numbers, names, URLs and personal data (plain numbers there are program constants, so the number rule is not applied).
export function lintIdl(idl) {
  const hits = [];
  if (idl?.metadata?.description !== IDL_DESCRIPTION) {
    hits.push({ file: 'idl', field: 'metadata.description', rule: 'idl-description', text: String(idl?.metadata?.description) });
  }
  const walk = (node, where) => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${where}[${typeof n?.name === 'string' ? n.name : i}]`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        const prose = (k === 'docs' && Array.isArray(v)) || (k === 'msg' && typeof v === 'string') || (k === 'value' && typeof v === 'string' && where.startsWith('constants'));
        if (prose) {
          const text = Array.isArray(v) ? v.join(' ') : v;
          for (const [rule, re] of IDL_RULES) {
            const m = text.match(re);
            if (m) hits.push({ file: 'idl', field: `${where}.${k}`, rule, text: m[0] });
          }
        } else walk(v, where ? `${where}.${k}` : k);
      }
    }
  };
  walk(idl, '');
  return hits;
}

export const readTree = (dir) =>
  Object.fromEntries(
    fs.readdirSync(dir, { recursive: true })
      .map((f) => String(f).split(path.sep).join('/'))
      .filter((f) => f.endsWith('.json') && fs.statSync(path.join(dir, f)).isFile())
      .map((f) => [f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]),
  );

export function printHits(hits) {
  for (const h of hits) console.log(`  ${h.rule.padEnd(15)} ${h.file} ${h.field}: ${JSON.stringify(h.text)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  let hits;
  if (opt('--idl')) {
    hits = lintIdl(JSON.parse(fs.readFileSync(opt('--idl'), 'utf8')));
    if (opt('--cargo')) {
      const m = fs.readFileSync(opt('--cargo'), 'utf8').match(/^description\s*=\s*"(.*)"\s*$/m);
      if (m?.[1] !== IDL_DESCRIPTION) hits.push({ file: 'Cargo.toml', field: 'description', rule: 'idl-description', text: String(m?.[1]) });
    }
  } else {
    if (!args[0]) throw new Error('usage: lint-permanent.mjs <metadata dir> [--image-base <url>] | --idl <idl.json> [--cargo <Cargo.toml>]');
    hits = lintFiles(readTree(args[0]), { imageBase: opt('--image-base') });
  }
  if (hits.length) {
    console.log(`permanent-text lint: ${hits.length} hit(s)`);
    printHits(hits);
    process.exit(1);
  }
  console.log('permanent-text lint: clean');
}
