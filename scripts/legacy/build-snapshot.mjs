#!/usr/bin/env node
/**
 * Legacy Pilot snapshot (oracle/src/legacy.ts): every EVM address that burned XEN before the cutoff
 * (2026-11-01T00:00:00Z), as recorded by XEN's own contracts: a Transfer(from = address, to = 0x0, value > 0) emitted by
 * the XEN token contract of a source chain (the five Moon Forge chains plus Ethereum), in a block stamped before the
 * cutoff. No dependency: raw JSON-RPC over Node's fetch (Node 20 or later), public RPCs, no key.
 *
 * Usage (the workflow .github/workflows/legacy-snapshot.yml runs it on GitHub, one job per part of a chain):
 *   node scripts/legacy/build-snapshot.mjs matrix [--parts <chainId=n,...>]
 *   node scripts/legacy/build-snapshot.mjs scan --chain <id> --out <part.json> [--part <k> --parts <n>] [--rpc <url,url>]
 *        [--from <block>] [--chunk <n>] [--max-chunk <n>] [--checkpoint <file>] [--deadline-min <m>] [--verify <n>]
 *   node scripts/legacy/build-snapshot.mjs merge --out deployments/legacy-burners.json <part.json> ...
 *   node scripts/legacy/build-snapshot.mjs check <legacy-burners.json>
 *   node scripts/legacy/build-snapshot.mjs sources
 *
 * The bounds of one chain: the cutoff block (the last block stamped before the cutoff) and the first block at or after
 * SCAN_FROM_TS (2022-10-01T00:00:00Z, before XEN existed on any chain, so the scan starts at or before the XEN deploy
 * block: no burn can be missed) are found by binary search on block timestamps (block headers only, no archive state;
 * --from overrides the start, for instance with the exact deploy block). When the RPC serves historical state, the XEN
 * contract must have no code at fromBlock − 1 and code at the cutoff block.
 *
 * Parts: the chain range [fromBlock, toBlock] is cut into `parts` equal block ranges (partRange); part k reads only its
 * own range, so the parts of a chain run as parallel jobs; merge checks that the parts tile the chain range exactly and
 * takes the union. The bytes of the merged file do not depend on the number of parts.
 *
 * The reads of one part: every RPC that answers the right eth_chainId, is at or past the part's last block and serves
 * the part's first block (its header and its logs) gets its own worker; the others are left out with the reason. Each
 * worker reads the next unread blocks in a range of its own size: a range its provider refuses (or cannot answer in
 * time) is halved for that RPC only (down to 50 blocks) and given back to the queue, a failing range is given back and
 * the RPC cools down (backoff), an RPC that fails `tries × rounds` times in a row is dropped, the range grows again after
 * quiet reads. When every RPC is dropped the part fails with each RPC's last error (never an empty answer taken as no
 * burn). After the reads, a sample of each RPC's ranges (--verify, default 8) is read again from another RPC and must
 * give the same burns, or the part fails naming both RPCs (a node that answers [] for history it does not hold).
 * Resumable: with --checkpoint, the ranges read so far are saved every minute and at the time budget (--deadline-min);
 * a scan that finds its checkpoint continues from it (exit code 3 = stopped at the time budget, run it again).
 *
 * The merged file is deterministic: { cutoff, chains: [{ chainId, xen, fromBlock, toBlock, events, addresses }],
 * addresses: [lowercase, ascending, unique], sha256 }, where sha256 is the sha256 of the canonical JSON (keys sorted,
 * no whitespace) of { addresses, chains, cutoff }: the same reads give the same bytes, whatever the parts, the chunks
 * and the RPCs.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const CUTOFF_TS = 1_793_491_200; // 2026-11-01T00:00:00Z
export const SCAN_FROM_TS = 1_664_582_400; // 2022-10-01T00:00:00Z
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const ZERO_TOPIC = '0x' + '0'.repeat(64);
const ZERO_ADDRESS = '0x' + '0'.repeat(40);
const MIN_CHUNK = 50;

/**
 * The source chains (oracle/src/legacy.ts LEGACY_SOURCES; the five XEN addresses are oracle/src/config.ts's). The RPC
 * lists are keyless public endpoints only (never one that needs an API key or an account): the oracle's lists
 * (oracle/src/config.ts, without its keyed BSC endpoint) plus other well-known keyless gateways. An endpoint that does
 * not answer, is behind, or does not serve the part's history is left out at the start; one that fails later is
 * dropped while the others carry on. polygon-rpc.com (now keyed), eth.llamarpc.com (a browser challenge) and
 * bsc-dataseed (no eth_getLogs) were dropped. `parts`: the default number of parallel jobs of the chain (run
 * 41608437087: Ethereum 454 s, Optimism 898 s, Polygon 1183 s in one job; Base 11995 s at 1000-block ranges; BSC and
 * Avalanche did not finish), overridable with the workflow's `parts` input.
 */
export const SOURCES = Object.freeze([
  { chainId: 1, name: 'Ethereum', xen: '0x06450dee7fd2fb8e39061434babcfc05599a6fb8', chunk: 2_000, parts: 1, rpcs: ['https://ethereum-rpc.publicnode.com', 'https://mainnet.gateway.tenderly.co', 'https://eth.drpc.org', 'https://eth.meowrpc.com', 'https://1rpc.io/eth'] },
  { chainId: 10, name: 'Optimism', xen: '0xeb585163debb1e637c6d617de3bef99347cd75c8', chunk: 10_000, parts: 1, rpcs: ['https://mainnet.optimism.io', 'https://optimism.gateway.tenderly.co', 'https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org'] },
  { chainId: 56, name: 'BSC', xen: '0x2ab0e9e4ee70fff1fb9d67031e44f6410170d00e', chunk: 2_000, parts: 16, rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc.rpc.blxrbdn.com', 'https://bsc.drpc.org', 'https://bsc.meowrpc.com', 'https://1rpc.io/bnb', 'https://bsc-mainnet.public.blastapi.io', 'https://rpc-bsc.48.club'] },
  { chainId: 137, name: 'Polygon', xen: '0x2ab0e9e4ee70fff1fb9d67031e44f6410170d00e', chunk: 3_000, parts: 1, rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.gateway.tenderly.co', 'https://polygon.drpc.org', 'https://1rpc.io/matic'] },
  { chainId: 8453, name: 'Base', xen: '0xffcbf84650ce02dafe96926b37a0ac5e34932fa5', chunk: 2_000, parts: 4, rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.gateway.tenderly.co', 'https://base.drpc.org'] },
  { chainId: 43114, name: 'Avalanche', xen: '0xc0c5aa69dbe4d6dddfbc89c0957686ec60f24389', chunk: 2_000, parts: 32, rpcs: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com', 'https://avalanche.drpc.org', 'https://1rpc.io/avax/c', 'https://ava-mainnet.public.blastapi.io/ext/bc/C/rpc'] },
]);

const RPC_TIMEOUT_MS = Number(process.env.LEGACY_RPC_TIMEOUT_MS || 60_000);
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => '0x' + n.toString(16);
const log = (m) => process.stderr.write(`${m}\n`);

/** an answer only a smaller range can fix (the oracle's isRangeErrorV3); a rate limit is not one */
export const isRangeError = (msg) => !/429|too many requests|rate.?limit/i.test(msg) && /range|limit|too large|too many|413|-32614|-32005|exceed|invalid params|response size/i.test(msg);
/** an answer that did not come in time: the same signal as a refused range on a slow node */
const isSlow = (msg) => /aborted|timeout|timed out/i.test(msg);

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

/**
 * A chain's RPC list: every call tries each RPC (3 tries with a backoff), for up to `rounds` rounds of the list. An
 * answer `accept` refuses (a null block from a lagging or pruned node) counts as a failure of that RPC.
 */
export function client(rpcs, { tries = 3, rounds = 4, backoffMs = 1_000 } = {}) {
  let first = 0;
  return {
    rpcs,
    async call(method, params, accept = () => true) {
      const errors = [];
      for (let round = 0; round < rounds; round++) {
        for (let k = 0; k < rpcs.length; k++) {
          const i = (first + k) % rpcs.length;
          for (let a = 0; a < tries; a++) {
            try {
              const r = await rpcCall(rpcs[i], method, params);
              if (!accept(r)) throw new Error(`unusable answer ${JSON.stringify(r)?.slice(0, 80)}`);
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
  // a node that does not serve block n (behind the head, or history pruned) answers null: the next RPC is asked
  const served = (b) => !!b && typeof b.timestamp === 'string';
  const b = await c.call('eth_getBlockByNumber', [hex(n), false], served).catch((e) => {
    throw new Error(`block ${n} not served by any RPC (${String(e?.message ?? e).slice(0, 300)})`);
  });
  if (!served(b)) throw new Error(`block ${n} not served`);
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

/** Part k (0-based) of n of the chain range [fromBlock, toBlock]: equal block ranges, the last one shorter. */
export function partRange(fromBlock, toBlock, part, parts) {
  const len = toBlock - fromBlock + 1;
  if (!Number.isSafeInteger(parts) || parts < 1 || parts > len) throw new Error(`parts must be an integer in [1, ${len}]`);
  if (!Number.isSafeInteger(part) || part < 0 || part >= parts) throw new Error(`part must be an integer in [0, ${parts - 1}]`);
  const size = Math.ceil(len / parts);
  const a = fromBlock + part * size;
  return [a, Math.min(toBlock, a + size - 1)];
}

/** The burns of one eth_getLogs answer for [a, b]: [{ from, key }] (key: block, sender, value). */
function burnsOf(logs, a, b, xen, chainId) {
  const out = [];
  for (const l of logs) {
    if (l.removed === true) continue;
    if (String(l.address).toLowerCase() !== xen) continue;
    const t = l.topics ?? [];
    if (t.length !== 3 || String(t[0]).toLowerCase() !== TRANSFER_TOPIC || String(t[2]).toLowerCase() !== ZERO_TOPIC) continue;
    const bn = Number(BigInt(l.blockNumber));
    if (bn < a || bn > b) throw new Error(`chain ${chainId}: a log of block ${bn} in the answer for ${a}-${b}`);
    const value = BigInt(l.data === '0x' ? 0 : l.data);
    if (value === 0n) continue;
    const from = '0x' + String(t[1]).toLowerCase().slice(-40);
    if (from === ZERO_ADDRESS) continue;
    // the key leaves the log index out (some providers number it per answer, not per block); the list keeps duplicates
    out.push({ from, key: `${bn}:${from}:${value}` });
  }
  return out;
}
const digestOf = (burns) => createHash('sha256').update(burns.map((x) => x.key).sort().join('\n')).digest('hex').slice(0, 32);
const getLogs = (url, xen, a, b) => rpcCall(url, 'eth_getLogs', [{ address: xen, topics: [TRANSFER_TOPIC, null, ZERO_TOPIC], fromBlock: hex(a), toBlock: hex(b) }]);

/** sorted disjoint block intervals: add one, merging neighbours */
function addInterval(list, [a, b]) {
  let i = 0;
  while (i < list.length && list[i][1] < a - 1) i++;
  let lo = a;
  let hi = b;
  while (i < list.length && list[i][0] <= b + 1) {
    lo = Math.min(lo, list[i][0]);
    hi = Math.max(hi, list[i][1]);
    list.splice(i, 1);
  }
  list.splice(i, 0, [lo, hi]);
  return list;
}
/** the blocks of [a, b] not in `done` */
function gapsOf(a, b, done) {
  const out = [];
  let s = a;
  for (const [x, y] of done) {
    if (y < s) continue;
    if (x > b) break;
    if (x > s) out.push([s, Math.min(b, x - 1)]);
    s = Math.max(s, y + 1);
  }
  if (s <= b) out.push([s, b]);
  return out;
}

/** a scan stopped at its time budget (or --max-chunks): the checkpoint holds what was read; exit code 3 */
export class StopError extends Error {}

/**
 * Scans one part of one chain: { chainId, xen, fromBlock, toBlock, cutoff, part, parts, rangeFrom, rangeTo, events,
 * addresses: [sorted] }.
 * o: { chainId, xen, rpcs, from?, part?, parts?, chunk?, maxChunk?, cutoff?, tries?, rounds?, backoffMs?, progressMs?,
 *      checkpoint?, deadlineAt? (ms epoch), maxChunks?, verify? }
 */
export async function scanChain(o) {
  const cutoff = o.cutoff ?? CUTOFF_TS;
  const xen = o.xen.toLowerCase();
  const part = o.part ?? 0;
  const parts = o.parts ?? 1;
  const tries = o.tries ?? 3;
  const rounds = o.rounds ?? 4;
  const backoff = o.backoffMs ?? 1_000;
  const tag = parts > 1 ? `chain ${o.chainId} part ${part + 1}/${parts}` : `chain ${o.chainId}`;
  // every RPC that answers must be the chain asked for; one that does not answer (down, keyed, a browser challenge) is
  // left out, so a single dead endpoint cannot stop the scan; at least one must remain
  const rpcs = [];
  for (const u of o.rpcs) {
    let id;
    try {
      id = await client([u], { tries, rounds: 1, backoffMs: backoff }).call('eth_chainId', []);
    } catch (e) {
      log(`${tag}: ${host(u)} left out (${String(e?.message ?? e).slice(0, 200)})`);
      continue;
    }
    if (Number(BigInt(id)) !== o.chainId) throw new Error(`${host(u)} serves chain ${Number(BigInt(id))}, not ${o.chainId}`);
    rpcs.push(u);
  }
  if (rpcs.length === 0) throw new Error(`chain ${o.chainId}: no RPC answered eth_chainId`);
  const c = client(rpcs, { tries, rounds, backoffMs: backoff });
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
  if (before === null || atCutoff === null) log(`${tag}: the RPC does not serve historical state; the deployment checks were skipped (the scan starts at the time bound)`);
  const [rangeFrom, rangeTo] = partRange(fromBlock, toBlock, part, parts);
  const ident = { chainId: o.chainId, xen, fromBlock, toBlock, cutoff, part, parts, rangeFrom, rangeTo };

  // resume from a checkpoint of the same part (same bounds); anything else is refused, never mixed in
  let done = [];
  let events = 0;
  const addresses = new Set();
  if (o.checkpoint && existsSync(o.checkpoint)) {
    const k = JSON.parse(readFileSync(o.checkpoint, 'utf8'));
    for (const f of Object.keys(ident)) if (k[f] !== ident[f]) throw new Error(`${tag}: the checkpoint ${o.checkpoint} is for another range (${f} ${k[f]}, not ${ident[f]})`);
    for (const iv of k.done) {
      if (!(Number.isSafeInteger(iv[0]) && Number.isSafeInteger(iv[1]) && rangeFrom <= iv[0] && iv[0] <= iv[1] && iv[1] <= rangeTo)) throw new Error(`${tag}: bad checkpoint interval ${JSON.stringify(iv)}`);
      addInterval(done, iv);
    }
    events = k.events;
    for (const x of k.addresses) addresses.add(x);
    log(`${tag}: resumed from the checkpoint, ${done.reduce((s, [x, y]) => s + y - x + 1, 0)} of ${rangeTo - rangeFrom + 1} blocks already read`);
  }
  const saveCheckpoint = () => {
    if (!o.checkpoint) return;
    mkdirSync(dirname(o.checkpoint), { recursive: true });
    writeFileSync(o.checkpoint + '.tmp', JSON.stringify({ kind: 'legacy-burners-checkpoint', ...ident, done, events, addresses: [...addresses].sort() }) + '\n');
    renameSync(o.checkpoint + '.tmp', o.checkpoint);
  };
  const pending = gapsOf(rangeFrom, rangeTo, done);

  // the RPCs for this part: at or past its last block, serving its first block (header and logs); the others are left
  // out with the reason, so a pruned node (BSC: "header not found") or a lagging one never answers for this range
  const states = [];
  const reasons = [];
  const firstBlock = pending.length ? pending[0][0] : rangeFrom;
  for (const u of rpcs) {
    try {
      const h = Number(BigInt(await client([u], { tries, rounds: 1, backoffMs: backoff }).call('eth_blockNumber', [])));
      if (h < rangeTo) throw new Error(`its head ${h} is before block ${rangeTo}`);
      await client([u], { tries, rounds: 1, backoffMs: backoff }).call('eth_getBlockByNumber', [hex(firstBlock), false], (b) => !!b && typeof b.timestamp === 'string');
      const t0 = Date.now();
      const l = await client([u], { tries, rounds: 1, backoffMs: backoff }).call('eth_getLogs', [{ address: xen, topics: [TRANSFER_TOPIC, null, ZERO_TOPIC], fromBlock: hex(firstBlock), toBlock: hex(firstBlock) }], Array.isArray);
      burnsOf(l, firstBlock, firstBlock, xen, o.chainId);
      states.push({ url: u, host: host(u), chunk: Math.max(MIN_CHUNK, o.chunk ?? 2_000), ceiling: Infinity, quiet: 0, fails: 0, coolUntil: 0, dropped: false, lastErr: '', ok: 0, failed: 0, blocks: 0, ms: 0, windows: [], probeMs: Date.now() - t0 });
    } catch (e) {
      const why = String(e?.message ?? e).slice(0, 200);
      reasons.push(`${host(u)}: ${why}`);
      log(`${tag}: ${host(u)} left out for blocks ${rangeFrom}..${rangeTo} (${why})`);
    }
  }
  if (states.length === 0) throw new Error(`${tag}: no RPC serves the logs of blocks ${rangeFrom}..${rangeTo} (${reasons.join(' | ')}); pass a list with an archive node in the workflow input`);
  log(`${tag}: blocks ${rangeFrom}..${rangeTo} of ${fromBlock}..${toBlock}, ${states.length} RPCs read in parallel: ${states.map((s) => `${s.host} (${s.probeMs} ms)`).join(', ')}`);

  const maxChunk = Math.max(MIN_CHUNK, o.chunk ?? 2_000, o.maxChunk ?? 100_000);
  const started = Date.now();
  const total = rangeTo - rangeFrom + 1;
  let lastLog = started;
  let lastSave = started;
  let chunks = 0;
  let inflight = 0;
  let fatal = null;
  let stopped = false;
  const take = (size) => {
    if (!pending.length) return null;
    const [a, b] = pending[0];
    const e = Math.min(b, a + size - 1);
    if (e === b) pending.shift();
    else pending[0] = [e + 1, b];
    return [a, e];
  };
  const giveBack = (r) => addInterval(pending, r);
  const progress = () => {
    const read = done.reduce((s, [x, y]) => s + y - x + 1, 0);
    log(`${tag}: ${read} of ${total} blocks (${((100 * read) / total).toFixed(1)}%), ${events} events, ${addresses.size} addresses, ${Math.round((Date.now() - started) / 1000)} s; ` +
      states.map((s) => `${s.host} ${s.dropped ? 'dropped' : `chunk ${s.chunk}`} ok ${s.ok} failed ${s.failed}`).join(', '));
  };

  async function worker(s) {
    for (;;) {
      if (fatal || s.dropped) return;
      if ((o.deadlineAt && Date.now() >= o.deadlineAt) || (o.maxChunks && chunks >= o.maxChunks)) stopped = true;
      if (stopped) return;
      const now = Date.now();
      if (now < s.coolUntil) {
        await SLEEP(Math.min(s.coolUntil - now, 250));
        continue;
      }
      const r = take(s.chunk);
      if (!r) {
        if (inflight === 0) return;
        await SLEEP(20);
        continue;
      }
      inflight++;
      const t0 = Date.now();
      let burns;
      let n;
      try {
        const logs = await getLogs(s.url, xen, r[0], r[1]);
        if (!Array.isArray(logs)) throw new Error('eth_getLogs did not answer an array');
        n = logs.length;
        burns = burnsOf(logs, r[0], r[1], xen, o.chainId);
      } catch (e) {
        inflight--;
        giveBack(r);
        const msg = String(e?.message ?? e);
        if (/a log of block/.test(msg)) {
          fatal = new Error(`${msg} (from ${s.host})`);
          return;
        }
        s.lastErr = msg.slice(0, 200);
        s.failed++;
        s.quiet = 0;
        if ((isRangeError(msg) || isSlow(msg)) && s.chunk > MIN_CHUNK) {
          // this RPC's range only: the others keep theirs
          s.ceiling = s.chunk - 1;
          s.chunk = Math.max(MIN_CHUNK, Math.floor(s.chunk / 2));
          continue;
        }
        s.fails++;
        if (s.fails >= tries * rounds) {
          s.dropped = true;
          log(`${tag}: ${s.host} dropped after ${s.fails} failures in a row (last: ${s.lastErr})`);
          return;
        }
        s.coolUntil = Date.now() + backoff * 2 ** Math.min(s.fails - 1, 6);
        continue;
      }
      inflight--;
      s.fails = 0;
      s.ok++;
      s.ms += Date.now() - t0;
      s.blocks += r[1] - r[0] + 1;
      s.windows.push([r[0], r[1], burns.length, digestOf(burns)]);
      for (const x of burns) addresses.add(x.from);
      events += burns.length;
      addInterval(done, r);
      chunks++;
      // grow again after quiet reads, never to a size this RPC refused in its last 64 reads
      if (++s.quiet >= 64) s.ceiling = Infinity;
      if (n < 2_000 && s.chunk * 2 <= Math.min(maxChunk, s.ceiling)) s.chunk *= 2;
      if (Date.now() - lastLog > (o.progressMs ?? 30_000)) {
        lastLog = Date.now();
        progress();
      }
      if (Date.now() - lastSave > 60_000) {
        lastSave = Date.now();
        saveCheckpoint();
      }
    }
  }
  await Promise.all(states.map(worker));
  if (fatal) {
    saveCheckpoint();
    throw fatal;
  }
  if (pending.length) {
    saveCheckpoint();
    if (stopped) {
      progress();
      throw new StopError(`${tag}: stopped at the time budget with ${pending.reduce((s, [x, y]) => s + y - x + 1, 0)} blocks left; ${o.checkpoint ? `the checkpoint ${o.checkpoint} holds what was read: run the job again to resume` : 'no checkpoint was asked'}`);
    }
    throw new Error(`${tag}: every RPC was dropped with blocks ${pending[0][0]}..${pending[0][1]} still unread (${states.map((s) => `${s.host}: ${s.lastErr}`).join(' | ')})`);
  }

  // cross-check: a sample of each RPC's ranges read again from another RPC must give the same burns
  const V = o.verify ?? 8;
  const live = states.filter((s) => !s.dropped);
  if (V > 0 && states.some((s) => s.windows.length)) {
    if (live.length < 2) log(`${tag}: only one RPC left: no cross-check of the reads`);
    else {
      let checked = 0;
      for (const s of states) {
        const w = s.windows.slice().sort((x, y) => x[0] - y[0]);
        const pick = [...new Set(Array.from({ length: Math.min(V, w.length) }, (_, i) => Math.floor((i * w.length) / Math.min(V, w.length))))].map((i) => w[i]);
        for (const [a, b, cnt, dg] of pick) {
          let got = null;
          let by = null;
          for (const v of live) {
            if (v === s) continue;
            try {
              got = await readRange(v, a, b);
              by = v;
              break;
            } catch {
              /* the next verifier */
            }
          }
          if (got === null) {
            log(`${tag}: blocks ${a}..${b} (read by ${s.host}) could not be read again from another RPC`);
            continue;
          }
          if (digestOf(got) !== dg) throw new Error(`${tag}: the RPCs disagree on blocks ${a}..${b}: ${s.host} answered ${cnt} burns, ${by.host} answered ${got.length}; leave the wrong one out with the workflow input (an RPC list)`);
          checked++;
        }
      }
      log(`${tag}: ${checked} ranges read again from another RPC: the same burns`);
    }
  }
  /** blocks [a, b] from one RPC, in ranges it accepts */
  async function readRange(v, a, b) {
    const out = [];
    let size = Math.max(MIN_CHUNK, Math.min(v.chunk, b - a + 1));
    for (let x = a; x <= b; ) {
      const y = Math.min(b, x + size - 1);
      let ok = false;
      let last = '';
      for (let t = 0; t < tries && !ok; t++) {
        try {
          const logs = await getLogs(v.url, xen, x, y);
          if (!Array.isArray(logs)) throw new Error('not an array');
          out.push(...burnsOf(logs, x, y, xen, o.chainId));
          ok = true;
        } catch (e) {
          last = String(e?.message ?? e);
          if ((isRangeError(last) || isSlow(last)) && size > MIN_CHUNK) break;
          if (t + 1 < tries) await SLEEP(backoff * 2 ** t);
        }
      }
      if (!ok) {
        if ((isRangeError(last) || isSlow(last)) && size > MIN_CHUNK) {
          size = Math.max(MIN_CHUNK, Math.floor(size / 2));
          continue;
        }
        throw new Error(last);
      }
      x = y + 1;
    }
    return out;
  }

  const secs = Math.round((Date.now() - started) / 1000);
  for (const s of states) log(`${tag}: ${s.host}: ${s.ok} reads, ${s.failed} failed, ${s.blocks} blocks, ${s.ok ? Math.round(s.ms / s.ok) : 0} ms per read, last chunk ${s.chunk}${s.dropped ? ', dropped' : ''}${s.lastErr ? ` (last error: ${s.lastErr})` : ''}`);
  log(`${tag}: blocks ${rangeFrom}..${rangeTo}${parts > 1 ? ` of ${fromBlock}..${toBlock}` : ''}, ${chunks} chunks, ${events} burn events, ${addresses.size} addresses, ${secs} s`);
  return { ...ident, events, addresses: [...addresses].sort() };
}

const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);

/** sha256 of the canonical JSON of { addresses, chains, cutoff } (oracle/src/legacy.ts legacySnapshotSha256). */
export function snapshotSha256(doc) {
  return createHash('sha256').update(JSON.stringify(canon({ addresses: doc.addresses, chains: doc.chains, cutoff: doc.cutoff }))).digest('hex');
}

/** One chain from its parts: the same bounds, parts 0..n−1 exactly once, each its partRange; events summed, addresses united. */
function mergeChain(list) {
  const p0 = list[0];
  const n = p0.parts ?? 1;
  const seen = new Map();
  for (const p of list) {
    for (const f of ['xen', 'fromBlock', 'toBlock', 'cutoff']) if (p[f] !== p0[f]) throw new Error(`chain ${p.chainId}: the parts disagree on ${f}`);
    if ((p.parts ?? 1) !== n) throw new Error(`chain ${p.chainId}: parts of different splits (${p.parts ?? 1} and ${n})`);
    const k = p.part ?? 0;
    if (seen.has(k)) throw new Error(n > 1 ? `chain ${p.chainId} part ${k + 1}/${n} twice` : `chain ${p.chainId} twice`);
    const [a, b] = partRange(p.fromBlock, p.toBlock, k, n);
    if ((p.rangeFrom ?? p.fromBlock) !== a || (p.rangeTo ?? p.toBlock) !== b) throw new Error(`chain ${p.chainId} part ${k + 1}/${n}: blocks ${p.rangeFrom}..${p.rangeTo}, not ${a}..${b}`);
    for (let i = 1; i < p.addresses.length; i++) if (!(p.addresses[i - 1] < p.addresses[i])) throw new Error(`chain ${p.chainId}: addresses not strictly ascending`);
    seen.set(k, p);
  }
  for (let k = 0; k < n; k++) if (!seen.has(k)) throw new Error(`chain ${p0.chainId} part ${k + 1}/${n} is missing`);
  const all = new Set();
  let events = 0;
  for (const p of list) {
    events += p.events;
    for (const a of p.addresses) all.add(a);
  }
  return { chainId: p0.chainId, xen: p0.xen, fromBlock: p0.fromBlock, toBlock: p0.toBlock, cutoff: p0.cutoff, events, addresses: [...all].sort() };
}

/** The snapshot of the chain parts (every source chain, each split into its parts exactly once, one cutoff). */
export function merge(parts, sources = SOURCES) {
  const groups = new Map();
  let cutoff = null;
  for (const p of parts) {
    const s = sources.find((x) => x.chainId === p.chainId);
    if (!s) throw new Error(`chain ${p.chainId} is not a source chain`);
    if (p.xen !== s.xen) throw new Error(`chain ${p.chainId}: xen ${p.xen} is not ${s.xen}`);
    if (cutoff !== null && p.cutoff !== cutoff) throw new Error('the parts were scanned with different cutoffs');
    cutoff = p.cutoff;
    if (!groups.has(p.chainId)) groups.set(p.chainId, []);
    groups.get(p.chainId).push(p);
  }
  for (const s of sources) if (!groups.has(s.chainId)) throw new Error(`chain ${s.chainId} (${s.name}) is missing`);
  const all = new Set();
  const chains = [...groups.values()]
    .map(mergeChain)
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

/**
 * The scan jobs: one per part of each source chain, the chains interleaved (so parallel jobs spread over the
 * providers). `override`: "chainId=n,..." (n in 1..64) replaces a chain's default number of parts.
 */
export function matrix(override = '', sources = SOURCES) {
  const n = new Map(sources.map((s) => [s.chainId, s.parts ?? 1]));
  for (const kv of String(override).split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d+)=(\d+)$/.exec(kv);
    if (!m || !n.has(Number(m[1])) || Number(m[2]) < 1 || Number(m[2]) > 64) throw new Error(`parts: "${kv}" is not chainId=n with a source chain and n in 1..64`);
    n.set(Number(m[1]), Number(m[2]));
  }
  const out = [];
  for (let k = 0; k < Math.max(...n.values()); k++) for (const s of sources) if (k < n.get(s.chainId)) out.push({ chain: s.chainId, part: k, parts: n.get(s.chainId), label: `${s.chainId} ${k + 1}/${n.get(s.chainId)}` });
  return out;
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
const intArg = (v, name) => {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  if (cmd === 'sources') {
    process.stdout.write(JSON.stringify(SOURCES.map((s) => ({ chainId: s.chainId, xen: s.xen }))) + '\n');
    return;
  }
  if (cmd === 'matrix') {
    process.stdout.write(JSON.stringify(matrix(a.parts ?? '')) + '\n');
    return;
  }
  if (cmd === 'scan') {
    const chainId = Number(a.chain);
    const s = SOURCES.find((x) => x.chainId === chainId);
    if (!s) throw new Error(`--chain must be one of ${SOURCES.map((x) => x.chainId).join(', ')}`);
    if (!a.out) throw new Error('--out is required');
    const rpcs = (a.rpc ? String(a.rpc) : s.rpcs.join(',')).split(',').map((u) => u.trim()).filter(Boolean);
    const deadlineMin = intArg(a['deadline-min'], 'deadline-min');
    const part = await scanChain({
      chainId, xen: s.xen, rpcs, from: intArg(a.from, 'from'), chunk: intArg(a.chunk, 'chunk') ?? s.chunk, maxChunk: intArg(a['max-chunk'], 'max-chunk'),
      backoffMs: intArg(a['backoff-ms'], 'backoff-ms'), part: intArg(a.part, 'part'), parts: intArg(a.parts, 'parts'), checkpoint: a.checkpoint || undefined,
      deadlineAt: deadlineMin ? Date.now() + deadlineMin * 60_000 : undefined, maxChunks: intArg(a['max-chunks'], 'max-chunks'), verify: intArg(a.verify, 'verify'),
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
  throw new Error('usage: build-snapshot.mjs matrix [--parts <id=n,...>] | scan --chain <id> --out <file> [--part <k> --parts <n>] [--rpc <urls>] [--from <block>] [--checkpoint <file>] [--deadline-min <m>] | merge --out <file> <parts...> | check <file> | sources');
}

if (/build-snapshot\.mjs$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    log(`build-snapshot: ${e?.message ?? e}`);
    process.exit(e instanceof StopError ? 3 : 1);
  });
}
