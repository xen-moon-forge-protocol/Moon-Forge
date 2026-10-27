// Read-only Arweave helpers shared by upload-arweave.mjs and check-gateways.mjs: gateway GETs with retries, raw path
// manifests, Turbo's status of a data item, and an L1 read that rebuilds a data item's payload from the weave's own
// chunks (so "permanent" is checked on Arweave itself, not on a gateway cache). Nothing here signs or pays.
import crypto from 'crypto';

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const DEFAULT_GATEWAYS = ['turbo-gateway.com', 'ar-io.dev'];
export const L1_NODE = 'https://arweave.net';
export const TURBO_STATUS = 'https://upload.ardrive.io/v1/tx';
export const ID_RE = /^[A-Za-z0-9_-]{43}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET with retries on network errors, 404 and 5xx (fresh uploads and busy gateways answer both for a while).
export async function fetchBytes(url, { attempts = 3, backoffMs = [0, 20_000, 60_000], timeoutMs = 60_000, init = {} } = {}) {
  let last = { status: 0, type: '', buf: Buffer.alloc(0), url, error: 'not tried' };
  for (let i = 0; i < attempts; i++) {
    if (backoffMs[i]) await sleep(backoffMs[i]);
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), ...init });
      const buf = Buffer.from(await r.arrayBuffer());
      last = { status: r.status, type: r.headers.get('content-type') ?? '', buf, url: r.url, error: null };
      if (r.status < 500 && r.status !== 404 && r.status !== 429) return last;
    } catch (e) {
      last = { status: 0, type: '', buf: Buffer.alloc(0), url, error: `${e.name}: ${e.message}` };
    }
  }
  return last;
}

export async function fetchJson(url, opts) {
  const r = await fetchBytes(url, opts);
  if (r.status !== 200) return { ok: false, status: r.status, error: r.error ?? `HTTP ${r.status}` };
  try {
    return { ok: true, status: 200, json: JSON.parse(r.buf.toString('utf8')), buf: r.buf, type: r.type };
  } catch (e) {
    return { ok: false, status: r.status, error: `not JSON: ${e.message}` };
  }
}

// A path manifest exactly as stored (ar.io gateways serve it at /raw/<id>; /<id> would resolve its index instead).
export async function rawManifest(gateway, id, opts) {
  const r = await fetchJson(`https://${gateway}/raw/${id}`, opts);
  if (!r.ok) return r;
  if (r.json?.manifest !== 'arweave/paths' || typeof r.json.paths !== 'object') return { ok: false, status: 200, error: 'not an arweave/paths manifest' };
  return r;
}

// Turbo's record of a data item: bundle id and the payload's position inside the root bundle.
export async function turboStatus(id, opts) {
  return fetchJson(`${TURBO_STATUS}/${id}/status`, opts);
}

const b64 = (s) => Buffer.from(s, 'base64url');

// Rebuilds the payload of a bundled data item from L1 chunks. Returns { ok, buf, bundleId, height, confirmations,
// reason }. A bundle whose header is mined but whose data was never seeded fails here (the 2026-10-14 upload did:
// Turbo said FINALIZED, GraphQL showed a block height, and no node served a single chunk of it).
export async function l1Payload(id, { node = L1_NODE, opts } = {}) {
  const st = await turboStatus(id, opts);
  if (!st.ok) return { ok: false, reason: `turbo status: ${st.error}` };
  const s = st.json;
  if (s.status !== 'FINALIZED') return { ok: false, reason: `turbo status ${s.status}`, bundleId: s.bundleId ?? null };
  const bundleId = s.bundleId;
  const [off, txs] = await Promise.all([fetchJson(`${node}/tx/${bundleId}/offset`, opts), fetchJson(`${node}/tx/${bundleId}/status`, opts)]);
  if (!off.ok) return { ok: false, bundleId, reason: `bundle offset: ${off.error}` };
  const height = txs.ok ? txs.json.block_height : null;
  const confirmations = txs.ok ? txs.json.number_of_confirmations : null;
  const txStart = BigInt(off.json.offset) - BigInt(off.json.size) + 1n;
  const rStart = BigInt(s.startOffsetInRootBundle) + BigInt(s.payloadDataStart);
  const rEnd = rStart + BigInt(s.payloadContentLength);
  const parts = [];
  for (let r = rStart; r < rEnd; ) {
    const c = await fetchJson(`${node}/chunk/${txStart + r}`, opts);
    if (!c.ok) return { ok: false, bundleId, height, confirmations, reason: `chunk at +${r}: ${c.error}` };
    const chunk = b64(c.json.chunk);
    const dataPath = b64(c.json.data_path);
    const right = BigInt('0x' + dataPath.subarray(dataPath.length - 32).toString('hex')); // leaf note = chunk end
    const left = right - BigInt(chunk.length);
    if (!(left <= r && r < right)) return { ok: false, bundleId, height, confirmations, reason: `chunk range [${left},${right}) does not hold +${r}` };
    const to = right < rEnd ? right : rEnd;
    parts.push(chunk.subarray(Number(r - left), Number(to - left)));
    r = to;
  }
  return { ok: true, buf: Buffer.concat(parts), bundleId, height, confirmations };
}

// Runs fn over items with at most n in flight.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// WebP = RIFF container; only image chunks are allowed, and no identifying strings anywhere in the bytes.
export function scanWebp(buf) {
  const issues = [];
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return ['not a RIFF/WEBP file'];
  for (let o = 12; o + 8 <= buf.length; ) {
    const id = buf.toString('ascii', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (!['VP8 ', 'VP8L', 'VP8X', 'ALPH'].includes(id)) issues.push(`chunk ${JSON.stringify(id)}`);
    o += 8 + size + (size % 2);
  }
  const text = buf.toString('latin1');
  // EXIF/XMP/ICCP chunks are refused above; these are the strings an editor, a generator or a path would leave
  for (const s of ['c2pa', 'jumb', 'jumd', 'SynthID', 'Google', 'Adobe', 'Photoshop']) {
    if (text.toLowerCase().includes(s.toLowerCase())) issues.push(`bytes contain ${JSON.stringify(s)}`);
  }
  if (/[A-Za-z0-9._%+-]{3,}@[A-Za-z0-9-]{3,}\.(com|net|org|io|dev|me)\b/.test(text)) issues.push('bytes contain an e-mail address');
  if (/\b[A-Za-z]:\\[A-Za-z]|\/(home|Users|mnt)\/[A-Za-z]/.test(text)) issues.push('bytes contain a local path');
  return issues;
}
