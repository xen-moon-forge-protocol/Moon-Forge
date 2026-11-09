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
const H = (...bufs) => crypto.createHash('sha256').update(Buffer.concat(bufs)).digest();
const noteInt = (b) => BigInt('0x' + (b.toString('hex') || '0'));

// Arweave's Merkle proof (data_path) of the byte at `dest` (relative to the transaction) against the transaction's
// data_root: branch = left id | right id | 32-byte boundary note, leaf = sha256(chunk) | 32-byte chunk-end note, and a
// node id is sha256 of the sha256 of each part. Returns { left, right, dataHash } of the proven leaf, or null.
export function validateDataPath(dataRoot, dest, txSize, dataPath) {
  let id = dataRoot;
  let left = 0n;
  let right = txSize;
  let rest = dataPath;
  if (!(dest >= 0n && dest < txSize)) return null;
  while (rest.length > 64) {
    if (rest.length < 96) return null;
    const [l, r, n] = [rest.subarray(0, 32), rest.subarray(32, 64), rest.subarray(64, 96)];
    if (!H(H(l), H(r), H(n)).equals(id)) return null;
    const off = noteInt(n);
    if (dest < off) {
      id = l;
      right = right < off ? right : off;
    } else {
      id = r;
      left = left > off ? left : off;
    }
    rest = rest.subarray(96);
  }
  if (rest.length !== 64) return null;
  const [dataHash, n] = [rest.subarray(0, 32), rest.subarray(32, 64)];
  if (!H(H(dataHash), H(n)).equals(id)) return null;
  const end = noteInt(n);
  if (!(left <= dest && dest < end && end <= right)) return null;
  return { left, right: end, dataHash };
}

// A chunk answer is accepted only when its data_path proves it against the mined transaction's data_root AND its
// bytes hash to the proven leaf. That makes the answer independent of who served it.
export function verifyChunk(json, { dataRoot, txSize, rel }) {
  if (typeof json?.chunk !== 'string' || typeof json?.data_path !== 'string') return { ok: false, why: 'not a chunk answer' };
  const chunk = b64(json.chunk);
  const leaf = validateDataPath(dataRoot, rel, txSize, b64(json.data_path));
  if (!leaf) return { ok: false, why: 'data_path does not prove the offset against data_root' };
  if (!H(chunk).equals(leaf.dataHash) || BigInt(chunk.length) !== leaf.right - leaf.left) return { ok: false, why: 'chunk bytes do not match the proven leaf' };
  return { ok: true, chunk, left: leaf.left, right: leaf.right };
}

// Arweave L1 node list: the seed itself, then the Arweave nodes it peers with (GET /peers, "ip:port"). Only Arweave
// nodes are asked for chunks, never an ar.io gateway (a gateway can serve the copy it was handed at upload time from
// its own cache, which is what the 2026-10-14 trap looked like). Since 2026-11-07 arweave.net answers 404 (HTML) to
// every GET /chunk/<offset>, even for old data, while its /tx/* answers still work; miners store only some
// partitions, so only a few peers hold a given offset, and any one of them is enough once the proof checks out.
export async function l1Nodes(seed = L1_NODE, opts) {
  const nodes = [seed];
  const p = await fetchJson(`${seed}/peers`, { ...opts, attempts: 1 });
  if (p.ok && Array.isArray(p.json)) {
    for (const x of p.json) if (typeof x === 'string' && /^[0-9a-zA-Z.\-]+:\d{1,5}$/.test(x)) nodes.push(`http://${x}`);
  }
  return [...new Set(nodes)];
}

// A transaction header field from the first of a few L1 nodes that answers it (the seed with the usual retries).
async function firstOk(nodes, pathname, opts, { json = true } = {}) {
  let last = { ok: false, error: 'no node' };
  for (const n of nodes.slice(0, 8)) {
    const o = n === nodes[0] ? opts : { ...opts, attempts: 1, timeoutMs: 15_000 };
    if (json) last = await fetchJson(`${n}${pathname}`, o);
    else {
      const r = await fetchBytes(`${n}${pathname}`, o);
      last = r.status === 200 ? { ok: true, text: r.buf.toString('utf8').trim() } : { ok: false, error: r.error ?? `HTTP ${r.status}` };
    }
    if (last.ok) return last;
  }
  return last;
}

// One chunk from any L1 node, valid proof required. The node that served the previous chunk is asked first (the
// chunks of one bundle sit in the same partition); otherwise nodes are probed `batch` at a time with one attempt and a
// short timeout. Rounds (opts.attempts, opts.backoffMs) cover a node that is briefly down.
async function l1Chunk(abs, check, ctx, opts) {
  const { attempts = 3, backoffMs = [0, 20_000, 60_000] } = opts ?? {};
  const probe = { attempts: 1, timeoutMs: ctx.probeTimeoutMs ?? 15_000 };
  const tally = {};
  for (let round = 0; round < attempts; round++) {
    if (round && backoffMs[round]) await sleep(backoffMs[round]);
    const order = [...new Set([ctx.preferred, ...ctx.nodes].filter(Boolean))].slice(0, ctx.maxNodes ?? 250);
    // the preferred node (or the seed) alone first, then the rest `batch` at a time
    for (let i = 0; i < order.length; i = i ? i + (ctx.batch ?? 12) : 1) {
      const batch = order.slice(i, i ? i + (ctx.batch ?? 12) : 1);
      const answers = await Promise.all(batch.map(async (n) => {
        const c = await fetchJson(`${n}/chunk/${abs}`, probe);
        if (!c.ok) return { n, why: c.status ? `HTTP ${c.status}` : 'unreachable' };
        const v = verifyChunk(c.json, check);
        return v.ok ? { n, v } : { n, why: v.why };
      }));
      const hit = answers.find((a) => a.v);
      if (hit) {
        ctx.preferred = hit.n;
        return { ok: true, ...hit.v, node: hit.n };
      }
      for (const a of answers) tally[a.why] = (tally[a.why] ?? 0) + 1;
    }
  }
  const tried = Object.entries(tally).map(([k, v]) => `${k} x${v}`).join(', ');
  return { ok: false, error: `no Arweave L1 node served a proven chunk (${tried || 'no node to ask'})` };
}

// Shared state for one check run: the L1 node list (discovered once) and the node that answered last.
export const l1Context = (extra = {}) => ({ nodes: null, preferred: null, batch: 24, ...extra });

// Rebuilds the payload of a bundled data item from L1 chunks, each proven against the bundle's mined data_root.
// Returns { ok, buf, bundleId, height, confirmations, nodes, reason }. A bundle whose header is mined but whose data
// was never seeded fails here (the 2026-10-14 upload did: Turbo said FINALIZED, GraphQL showed a block height, and no
// node served a single chunk of it).
export async function l1Payload(id, { node = L1_NODE, opts, ctx = l1Context() } = {}) {
  const st = await turboStatus(id, opts);
  if (!st.ok) return { ok: false, reason: `turbo status: ${st.error}` };
  const s = st.json;
  if (s.status !== 'FINALIZED') return { ok: false, reason: `turbo status ${s.status}`, bundleId: s.bundleId ?? null };
  const bundleId = s.bundleId;
  ctx.discovery ??= ctx.nodes ? Promise.resolve(ctx.nodes) : (ctx.discover ?? l1Nodes)(node, opts); // once per run
  ctx.nodes = await ctx.discovery;
  const [off, txs, root] = await Promise.all([
    firstOk(ctx.nodes, `/tx/${bundleId}/offset`, opts),
    firstOk(ctx.nodes, `/tx/${bundleId}/status`, opts),
    firstOk(ctx.nodes, `/tx/${bundleId}/data_root`, opts, { json: false }), // plain base64url text, not JSON
  ]);
  if (!off.ok) return { ok: false, bundleId, reason: `bundle offset: ${off.error}` };
  const height = txs.ok ? txs.json.block_height : null;
  const confirmations = txs.ok ? txs.json.number_of_confirmations : null;
  const dataRoot = root.ok ? b64(root.text) : Buffer.alloc(0);
  if (dataRoot.length !== 32) return { ok: false, bundleId, height, confirmations, reason: `bundle data_root: ${root.ok ? 'not 32 bytes' : root.error}` };
  const txSize = BigInt(off.json.size);
  const txStart = BigInt(off.json.offset) - txSize + 1n;
  const rStart = BigInt(s.startOffsetInRootBundle) + BigInt(s.payloadDataStart);
  const rEnd = rStart + BigInt(s.payloadContentLength);
  const parts = [];
  const served = new Set();
  for (let r = rStart; r < rEnd; ) {
    const c = await l1Chunk(txStart + r, { dataRoot, txSize, rel: r }, ctx, opts);
    if (!c.ok) return { ok: false, bundleId, height, confirmations, reason: `chunk at +${r}: ${c.error}` };
    served.add(c.node);
    const to = c.right < rEnd ? c.right : rEnd;
    parts.push(c.chunk.subarray(Number(r - c.left), Number(to - c.left)));
    r = to;
  }
  return { ok: true, buf: Buffer.concat(parts), bundleId, height, confirmations, nodes: [...served] };
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
