#!/usr/bin/env node
/**
 * Legacy Pilot snapshot (oracle/src/legacy.ts): every EVM address that burned XEN before the cutoff
 * (2026-11-01T00:00:00Z), as recorded by XEN's own contracts: a Transfer(from = address, to = 0x0, value > 0) emitted by
 * the XEN token contract of a source chain (the five Moon Forge chains plus Ethereum), in a block stamped before the
 * cutoff. No dependency: raw JSON-RPC over Node's fetch (Node 20 or later), public RPCs, no key.
 *
 * Usage (the workflow .github/workflows/legacy-snapshot.yml runs it on GitHub, one chain per job):
 *   node scripts/legacy/build-snapshot.mjs scan --chain <id> --out <part.json> [--rpc <url,url>] [--from <block>] [--chunk <n>] [--max-chunk <n>]
 *   node scripts/legacy/build-snapshot.mjs merge --out deployments/legacy-burners.json <part.json> ...
 *   node scripts/legacy/build-snapshot.mjs check <legacy-burners.json>
 *   node scripts/legacy/build-snapshot.mjs sources
 *
 * The scan of one chain: the cutoff block (the last block stamped before the cutoff) and the first block at or after
 * SCAN_FROM_TS (2022-10-01T00:00:00Z, before XEN existed on any chain, so the scan starts at or before the XEN deploy
 * block: no burn can be missed) are found by binary search on block timestamps (block headers only, no archive state;
 * --from overrides the start, for instance with the exact deploy block). When the RPC serves historical state, the XEN
 * contract must have no code at fromBlock − 1 and code at the cutoff block. The logs are read in chunks the RPC accepts
 * (the oracle's strategy: a range the provider refuses is halved down to 50 blocks, a failing chunk is retried with a
 * backoff, then read from the next RPC, every chunk already read is kept), growing again after quiet chunks.
 *
 * The merged file is deterministic: { cutoff, chains: [{ chainId, xen, fromBlock, toBlock, events, addresses }],
 * addresses: [lowercase, ascending, unique], sha256 }, where sha256 is the sha256 of the canonical JSON (keys sorted,
 * no whitespace) of { addresses, chains, cutoff }: the same reads give the same bytes, whatever the chunks and the RPCs.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const CUTOFF_TS = 1_793_491_200; // 2026-11-01T00:00:00Z
export const SCAN_FROM_TS = 1_664_582_400; // 2022-10-01T00:00:00Z
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ZERO_TOPIC = '0x' + '0'.repeat(64);
const ZERO_ADDRESS = '0x' + '0'.repeat(40);

/** The source chains (oracle/src/legacy.ts LEGACY_SOURCES; the five XEN addresses are oracle/src/config.ts's). */
export const SOURCES = Object.freeze([
  { chainId: 1, name: 'Ethereum', xen: '0x06450dee7fd2fb8e39061434babcfc05599a6fb8', chunk: 2_000, rpcs: ['https://eth.drpc.org', 'https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://1rpc.io/eth'] },
  { chainId: 10, name: 'Optimism', xen: '0xeb585163debb1e637c6d617de3bef99347cd75c8', chunk: 10_000, rpcs: ['https://mainnet.optimism.io', 'https://optimism.gateway.tenderly.co', 'https://optimism-rpc.publicnode.com'] },
  { chainId: 56, name: 'BSC', xen: '0x2ab0e9e4ee70fff1fb9d67031e44f6410170d00e', chunk: 5_000, rpcs: ['https://bsc.rpc.blxrbdn.com', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org'] },
  { chainId: 137, name: 'Polygon', xen: '0x2ab0e9e4ee70fff1fb9d67031e44f6410170d00e', chunk: 3_000, rpcs: ['https://polygon.gateway.tenderly.co', 'https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com'] },
  { chainId: 8453, name: 'Base', xen: '0xffcbf84650ce02dafe96926b37a0ac5e34932fa5', chunk: 1_000, rpcs: ['https://base.gateway.tenderly.co', 'https://mainnet.base.org', 'https://base-rpc.publicnode.com'] },
  { chainId: 43114, name: 'Avalanche', xen: '0xc0c5aa69dbe4d6dddfbc89c0957686ec60f24389', chunk: 2_000, rpcs: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'] },
]);

const RPC_TIMEOUT_MS = Number(process.env.LEGACY_RPC_TIMEOUT_MS || 60_000);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => '0x' + n.toString(16);
const log = (m) => process.stderr.write(`${m}\n`);

/** an answer only a smaller range can fix (the oracle's isRangeErrorV3); a rate limit is not one */
export const isRangeError = (msg) => !/429|too many requests|rate.?limit/i.test(msg) && /range|limit|too large|too many|413|-32614|-32005|exceed|invalid params|response size/i.test(msg);

/** One JSON-RPC call to one URL. */
export async function rpcCall(url, method, params) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`not JSON: ${text.slice(0, 200)}`);
    }
    if (j.error) throw new Error(`RPC error ${j.error.code}: ${String(j.error.message).slice(0, 200)}`);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

/** A chain's RPC list: every call tries each RPC (3 tries with a backoff), for up to `rounds` rounds of the list. */
export function client(rpcs, { tries = 3, rounds = 4, backoffMs = 1_000 } = {}) {
  let first = 0;
  return {
    rpcs,
    async call(method, params) {
      const errors = [];
      for (let round = 0; round < rounds; round++) {
        for (let k = 0; k < rpcs.length; k++) {
          const i = (first + k) % rpcs.length;
          for (let a = 0; a < tries; a++) {
            try {
              const r = await rpcCall(rpcs[i], method, params);
              first = i;
              return r;
            } catch (e) {
              errors.push(`${host(rpcs[i])}: ${String(e?.message ?? e).slice(0, 160)}`);
              if (a + 1 < tries) await SLEEP(backoffMs * 2 ** a);
            }
          }
        }
        if (round + 1 < rounds) await SLEEP(backoffMs * 10 * (round + 1));
      }
      throw new Error(`${method}: every RPC failed (${errors.slice(-3).join(' | ')})`);
    },
  };
}

const host = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

async function timestampOf(c, n) {
  const b = await c.call('eth_getBlockByNumber', [hex(n), false]);
  if (!b || typeof b.timestamp !== 'string') throw new Error(`block ${n} not served`);
  return Number(BigInt(b.timestamp));
}

/** The first block in [lo, hi] stamped at or after `ts` (hi + 1 when none), by binary search on block timestamps. */
export async function firstBlockAtOrAfter(c, ts, lo, hi) {
  let a = lo;
  let b = hi + 1;
  while (a < b) {
    const m = Math.floor((a + b) / 2);
    if ((await timestampOf(c, m)) >= ts) b = m;
    else a = m + 1;
  }
  return a;
}

/** eth_getCode at a block, or null when the RPC does not serve that state (a non-archive node). */
async function codeAt(c, address, block) {
  try {
    return await c.call('eth_getCode', [address, hex(block)]);
  } catch {
    return null;
  }
}

/**
 * Scans one chain: { chainId, xen, fromBlock, toBlock, cutoff, events, addresses: [sorted] }.
 * o: { chainId, xen, rpcs, from?, chunk?, maxChunk?, cutoff?, tries?, rounds?, backoffMs?, progressMs? }
 */
export async function scanChain(o) {
  const cutoff = o.cutoff ?? CUTOFF_TS;
  const xen = o.xen.toLowerCase();
  const c = client(o.rpcs, { tries: o.tries ?? 3, rounds: o.rounds ?? 4, backoffMs: o.backoffMs ?? 1_000 });
  // every RPC must be the chain asked for
  for (const u of o.rpcs) {
    const id = await client([u], { tries: o.tries ?? 3, rounds: 1, backoffMs: o.backoffMs ?? 1_000 }).call('eth_chainId', []);
    if (Number(BigInt(id)) !== o.chainId) throw new Error(`${host(u)} serves chain ${Number(BigInt(id))}, not ${o.chainId}`);
  }
  const head = Number(BigInt(await c.call('eth_blockNumber', [])));
  if ((await timestampOf(c, head)) < cutoff + 3_600) throw new Error(`chain ${o.chainId}: the head is not an hour past the cutoff yet`);
  const toBlock = (await firstBlockAtOrAfter(c, cutoff, 0, head)) - 1;
  if (toBlock < 0) throw new Error(`chain ${o.chainId}: no block before the cutoff`);
  const fromBlock = o.from ?? (await firstBlockAtOrAfter(c, SCAN_FROM_TS, 0, toBlock));
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0 || fromBlock > toBlock) throw new Error(`chain ${o.chainId}: fromBlock ${fromBlock} is not in [0, ${toBlock}]`);
  // the contract must not exist before the scan starts, and must exist at the cutoff (checked where the RPC serves it)
  const before = fromBlock > 0 ? await codeAt(c, xen, fromBlock - 1) : '0x';
  if (before !== null && before !== '0x') throw new Error(`chain ${o.chainId}: XEN already has code at block ${fromBlock - 1}: the scan would start after its deployment`);
  const atCutoff = await codeAt(c, xen, toBlock);
  if (atCutoff === '0x') throw new Error(`chain ${o.chainId}: no code at ${xen} at the cutoff block ${toBlock}`);
  if (before === null || atCutoff === null) log(`chain ${o.chainId}: the RPC does not serve historical state; the deployment checks were skipped (the scan starts at the time bound)`);

  const addresses = new Set();
  let events = 0;
  let chunk = Math.max(50, o.chunk ?? 2_000);
  const maxChunk = Math.max(chunk, o.maxChunk ?? 100_000);
  let ceiling = Infinity;
  let quiet = 0;
  let rpc = 0;
  let failed = 0;
  let chunks = 0;
  const started = Date.now();
  let lastLog = started;
  const tries = o.tries ?? 3;
  const backoff = o.backoffMs ?? 1_000;
  // a range the provider refuses, or one it cannot answer in time, is halved (a timeout on a wide range is the same
  // signal as a refusal on a slow node)
  const shrinkable = (msg) => isRangeError(msg) || /aborted|timeout|timed out/i.test(msg);
  for (let start = fromBlock; start <= toBlock; ) {
    const end = Math.min(toBlock, start + chunk - 1);
    let logs = null;
    let last = '';
    for (let a = 0; a < tries && logs === null; a++) {
      try {
        logs = await rpcCall(o.rpcs[rpc], 'eth_getLogs', [{ address: xen, topics: [TRANSFER_TOPIC, null, ZERO_TOPIC], fromBlock: hex(start), toBlock: hex(end) }]);
        if (!Array.isArray(logs)) throw new Error('eth_getLogs did not answer an array');
      } catch (e) {
        logs = null;
        last = String(e?.message ?? e);
        if (chunk > 50 && shrinkable(last)) break;
        if (a + 1 < tries) await SLEEP(backoff * 2 ** a);
      }
    }
    if (logs === null) {
      if (chunk > 50 && shrinkable(last)) {
        ceiling = chunk - 1;
        chunk = Math.max(50, Math.floor(chunk / 2));
        quiet = 0;
        continue; // the same start, a smaller range, the same RPC
      }
      failed++;
      if (failed >= o.rpcs.length * (o.rounds ?? 4)) throw new Error(`chain ${o.chainId}: logs ${start}-${end}: every RPC failed (last: ${last.slice(0, 200)})`);
      rpc = (rpc + 1) % o.rpcs.length;
      if (rpc === 0) await SLEEP(backoff * 10 * Math.ceil(failed / o.rpcs.length));
      continue; // the same chunk on the next RPC; every chunk read so far is kept
    }
    failed = 0;
    for (const l of logs) {
      if (l.removed === true) continue;
      if (String(l.address).toLowerCase() !== xen) continue;
      const t = l.topics ?? [];
      if (t.length !== 3 || String(t[0]).toLowerCase() !== TRANSFER_TOPIC || String(t[2]).toLowerCase() !== ZERO_TOPIC) continue;
      const bn = Number(BigInt(l.blockNumber));
      if (bn < start || bn > end) throw new Error(`chain ${o.chainId}: a log of block ${bn} in the answer for ${start}-${end}`);
      if (BigInt(l.data === '0x' ? 0 : l.data) === 0n) continue;
      const from = '0x' + String(t[1]).toLowerCase().slice(-40);
      if (from === ZERO_ADDRESS) continue;
      events++;
      addresses.add(from);
    }
    chunks++;
    start = end + 1;
    // grow again after quiet chunks, never to a size the provider refused in the last 64 chunks
    if (++quiet >= 64) ceiling = Infinity;
    if (logs.length < 2_000 && chunk * 2 <= Math.min(maxChunk, ceiling)) chunk *= 2;
    if (Date.now() - lastLog > (o.progressMs ?? 30_000)) {
      lastLog = Date.now();
      const pct = (100 * (start - fromBlock)) / Math.max(1, toBlock - fromBlock + 1);
      log(`chain ${o.chainId}: block ${start - 1} of ${toBlock} (${pct.toFixed(1)}%), chunk ${chunk}, ${events} events, ${addresses.size} addresses, ${Math.round((Date.now() - started) / 1000)} s`);
    }
  }
  log(`chain ${o.chainId}: blocks ${fromBlock}..${toBlock}, ${chunks} chunks, ${events} burn events, ${addresses.size} addresses, ${Math.round((Date.now() - started) / 1000)} s`);
  return { chainId: o.chainId, xen, fromBlock, toBlock, cutoff, events, addresses: [...addresses].sort() };
}

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

/** sha256 of the canonical JSON of { addresses, chains, cutoff } (oracle/src/legacy.ts legacySnapshotSha256). */
export function snapshotSha256(doc) {
  return createHash('sha256').update(JSON.stringify(canon({ addresses: doc.addresses, chains: doc.chains, cutoff: doc.cutoff }))).digest('hex');
}

/** The snapshot of the chain parts (every source chain exactly once, one cutoff). */
export function merge(parts, sources = SOURCES) {
  const byId = new Map();
  let cutoff = null;
  for (const p of parts) {
    if (byId.has(p.chainId)) throw new Error(`chain ${p.chainId} twice`);
    const s = sources.find((x) => x.chainId === p.chainId);
    if (!s) throw new Error(`chain ${p.chainId} is not a source chain`);
    if (p.xen !== s.xen) throw new Error(`chain ${p.chainId}: xen ${p.xen} is not ${s.xen}`);
    if (cutoff !== null && p.cutoff !== cutoff) throw new Error('the parts were scanned with different cutoffs');
    cutoff = p.cutoff;
    for (let i = 1; i < p.addresses.length; i++) if (!(p.addresses[i - 1] < p.addresses[i])) throw new Error(`chain ${p.chainId}: addresses not strictly ascending`);
    byId.set(p.chainId, p);
  }
  for (const s of sources) if (!byId.has(s.chainId)) throw new Error(`chain ${s.chainId} (${s.name}) is missing`);
  const all = new Set();
  const chains = [...byId.values()]
    .sort((a, b) => a.chainId - b.chainId)
    .map((p) => {
      for (const a of p.addresses) all.add(a);
      return { chainId: p.chainId, xen: p.xen, fromBlock: p.fromBlock, toBlock: p.toBlock, events: p.events, addresses: p.addresses.length };
    });
  const doc = { cutoff, chains, addresses: [...all].sort() };
  return { ...doc, sha256: snapshotSha256(doc) };
}

/** The file's bytes: one chain and one address per line, so a change shows line by line. */
export function serialize(doc) {
  const lines = ['{', `  "cutoff": ${JSON.stringify(doc.cutoff)},`, '  "chains": ['];
  doc.chains.forEach((c, i) => lines.push(`    ${JSON.stringify({ chainId: c.chainId, xen: c.xen, fromBlock: c.fromBlock, toBlock: c.toBlock, events: c.events, addresses: c.addresses })}${i + 1 < doc.chains.length ? ',' : ''}`));
  lines.push('  ],', '  "addresses": [');
  doc.addresses.forEach((a, i) => lines.push(`    ${JSON.stringify(a)}${i + 1 < doc.addresses.length ? ',' : ''}`));
  lines.push('  ],', `  "sha256": ${JSON.stringify(doc.sha256)}`, '}');
  return lines.join('\n') + '\n';
}

/** null when `doc` is consistent (sorted unique addresses, its own sha256, every source chain), else why not. */
export function check(doc, sources = SOURCES) {
  if (!doc || Object.keys(doc).sort().join(',') !== 'addresses,chains,cutoff,sha256') return 'members must be exactly addresses, chains, cutoff, sha256';
  if (doc.chains.length !== sources.length || doc.chains.some((c, i) => c.chainId !== sources[i].chainId || c.xen !== sources[i].xen)) return 'the chains are not the source chains in order';
  for (let i = 0; i < doc.addresses.length; i++) {
    if (!/^0x[0-9a-f]{40}$/.test(doc.addresses[i])) return `addresses[${i}] is not a lowercase address`;
    if (i > 0 && !(doc.addresses[i - 1] < doc.addresses[i])) return `addresses[${i}] is not after addresses[${i - 1}]`;
  }
  if (snapshotSha256(doc) !== doc.sha256) return 'sha256 does not match the content';
  return null;
}

function args(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  if (cmd === 'sources') {
    process.stdout.write(JSON.stringify(SOURCES.map((s) => ({ chainId: s.chainId, xen: s.xen }))) + '\n');
    return;
  }
  if (cmd === 'scan') {
    const chainId = Number(a.chain);
    const s = SOURCES.find((x) => x.chainId === chainId);
    if (!s) throw new Error(`--chain must be one of ${SOURCES.map((x) => x.chainId).join(', ')}`);
    if (!a.out) throw new Error('--out is required');
    const rpcs = (a.rpc ? String(a.rpc) : s.rpcs.join(',')).split(',').map((u) => u.trim()).filter(Boolean);
    const part = await scanChain({
      chainId, xen: s.xen, rpcs, from: a.from !== undefined && a.from !== '' ? Number(a.from) : undefined, chunk: a.chunk ? Number(a.chunk) : s.chunk,
      maxChunk: a['max-chunk'] ? Number(a['max-chunk']) : undefined, backoffMs: a['backoff-ms'] ? Number(a['backoff-ms']) : undefined,
    });
    mkdirSync(dirname(a.out), { recursive: true });
    writeFileSync(a.out, JSON.stringify({ kind: 'legacy-burners-part', ...part }) + '\n');
    return;
  }
  if (cmd === 'merge') {
    if (!a.out) throw new Error('--out is required');
    const parts = a._.map((f) => JSON.parse(readFileSync(f, 'utf8')));
    for (const p of parts) if (p.kind !== 'legacy-burners-part') throw new Error('not a part file');
    const doc = merge(parts.map(({ kind: _k, ...p }) => p));
    mkdirSync(dirname(a.out), { recursive: true });
    writeFileSync(a.out, serialize(doc));
    process.stdout.write(`${doc.addresses.length} addresses, sha256 ${doc.sha256}\n`);
    return;
  }
  if (cmd === 'check') {
    const doc = JSON.parse(readFileSync(a._[0], 'utf8'));
    const bad = check(doc);
    if (bad) throw new Error(bad);
    process.stdout.write(`ok: ${doc.addresses.length} addresses, sha256 ${doc.sha256}\n`);
    return;
  }
  throw new Error('usage: build-snapshot.mjs scan --chain <id> --out <file> [--rpc <urls>] [--from <block>] | merge --out <file> <parts...> | check <file> | sources');
}

if (/build-snapshot\.mjs$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    log(`build-snapshot: ${e?.message ?? e}`);
    process.exit(1);
  });
}
