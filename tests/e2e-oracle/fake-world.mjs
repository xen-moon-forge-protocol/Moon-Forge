// The outside world of the oracle for tests/e2e-oracle-v3.sh, on one local HTTP port (no key, no network):
//   /evm/<chainId>         EVM JSON-RPC of one chain: eth_blockNumber, eth_getLogs (the portal's MissionStarted events),
//                          eth_call totalMissions() / totalBurned() / totalSupply(), eth_chainId (batches accepted). Other
//                          calls (XEN balanceOf of a pool, Chainlink) revert: the oracle takes its documented warn path
//   /gt/api/v2/...         GeckoTerminal: token price, the XEN pool list, hourly OHLCV (XEN pools and the X1 XNT pool)
//   /x1report/api/xnt      the XNT price API
//   /xdex/...              the XDEX pool list (empty: the oracle falls through to its next source)
//   /site/...              the project site as the health check reads it: <site dir> first (epochs/ = the pushed epochs
//                          directory, feed/ = the keeper workflow's feed), then the repository's frontend/public
//   /ctl/*                 test control: burn, mine, prices, state (used by driver.ts)
// Every answer is a function of what the test put in, so two runs of the same steps read the same world.
// Usage: node fake-world.mjs <port> <oracle dir (for ethers)> [state file] [site dir]
import http from 'http';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const [port, oracleDir, stateFile, siteDir] = process.argv.slice(2);
if (!port || !oracleDir) { console.error('usage: fake-world.mjs <port> <oracle dir> [state file]'); process.exit(2); }
const require = createRequire(path.join(path.resolve(oracleDir), 'package.json'));
const { ethers } = require('ethers');
const bs58 = require('bs58').default ?? require('bs58');

const PORTAL_ABI = ['event MissionStarted(uint256 indexed missionId, address indexed pilot, uint256 amount, uint8 tier, bytes32 x1Pubkey, uint256 chainId, uint256 timestamp)'];
const iface = new ethers.Interface(PORTAL_ABI);
const TOPIC = iface.getEvent('MissionStarted').topicHash;
const SEL_TOTAL_MISSIONS = ethers.id('totalMissions()').slice(0, 10);
const SEL_TOTAL_SUPPLY = ethers.id('totalSupply()').slice(0, 10);
// X-010: the portal's cumulative burned amount (wei), read with totalMissions() at the window's toBlock (r4-fix, review
// r4 finding 10: without it every chain read failed and was skipped)
const SEL_TOTAL_BURNED = ethers.id('totalBurned()').slice(0, 10);
const coder = ethers.AbiCoder.defaultAbiCoder();

// chains the test can use (portal / XEN addresses are the oracle's config.ts values for XEN; the portal is any address)
const CHAINS = {
  8453: { gecko: 'base', xen: '0xffcbF84650cE02DaFE96926B37a0ac5E34932fa5', quote: '0x4200000000000000000000000000000000000006' },
  56: { gecko: 'bsc', xen: '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e', quote: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
};
const XNT_POOL = 'CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR';

const state = {
  chains: Object.fromEntries(Object.entries(CHAINS).map(([id, c]) => [id, {
    head: 1000, portal: '', burns: [], supply: '1000000000000000000000000000000000', xenUsd: 1e-7, liquidityUsd: 100_000,
  }])),
  xntUsd: 0.5,
  requests: 0,
};
function save() { if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state, null, 1)); }
if (stateFile && fs.existsSync(stateFile)) Object.assign(state, JSON.parse(fs.readFileSync(stateFile, 'utf8')));

const hex = (n) => '0x' + BigInt(n).toString(16);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const blockOf = (tag, head) => (tag === undefined || tag === 'latest' || tag === 'pending' || tag === 'safe' || tag === 'finalized' ? head : Number(BigInt(tag)));

function logOf(chainId, c, b) {
  const data = coder.encode(['uint256', 'uint8', 'bytes32', 'uint256', 'uint256'], [BigInt(b.amountWei), b.tier, '0x' + Buffer.from(bs58.decode(b.x1)).toString('hex'), BigInt(chainId), BigInt(b.timestamp)]);
  return {
    address: c.portal, topics: [TOPIC, word(b.missionId), ethers.zeroPadValue(b.pilot, 32)], data,
    blockNumber: hex(b.block), blockHash: ethers.id(`block:${chainId}:${b.block}`), transactionHash: b.txHash,
    transactionIndex: '0x0', logIndex: hex(b.logIndex), removed: false,
  };
}

function evm(chainId, req) {
  const c = state.chains[chainId];
  if (!c) return { error: { code: -32000, message: `unknown chain ${chainId}` } };
  const p = req.params || [];
  switch (req.method) {
    case 'eth_chainId': return { result: hex(chainId) };
    case 'net_version': return { result: String(chainId) };
    case 'eth_blockNumber': return { result: hex(c.head) };
    case 'eth_getCode': return { result: String(p[0] || '').toLowerCase() === c.portal.toLowerCase() ? '0x6080604052' : '0x' };
    case 'eth_getBlockByNumber': {
      const n = blockOf(p[0], c.head);
      return { result: { number: hex(n), hash: ethers.id(`block:${chainId}:${n}`), parentHash: ethers.id(`block:${chainId}:${n - 1}`), timestamp: hex(Math.floor(Date.now() / 1000)), transactions: [], gasLimit: '0x1c9c380', gasUsed: '0x0', baseFeePerGas: '0x1', miner: ethers.ZeroAddress, extraData: '0x', difficulty: '0x0', nonce: '0x0000000000000000', logsBloom: '0x' + '00'.repeat(256) } };
    }
    case 'eth_getLogs': {
      const f = p[0] || {};
      const from = blockOf(f.fromBlock, c.head), to = blockOf(f.toBlock, c.head);
      if (to > c.head) return { result: [] };
      const addr = String(f.address || '').toLowerCase();
      const want = (f.topics || [])[1];
      const out = c.burns
        .filter((b) => b.block >= from && b.block <= to && (!addr || addr === c.portal.toLowerCase()))
        .filter((b) => !want || BigInt(want) === BigInt(b.missionId))
        .map((b) => logOf(chainId, c, b));
      if (f.topics && f.topics[0] && f.topics[0].toLowerCase() !== TOPIC.toLowerCase()) return { result: [] };
      return { result: out };
    }
    case 'eth_call': {
      const call = p[0] || {};
      const at = blockOf(p[1], c.head);
      const sel = String(call.data || '').slice(0, 10).toLowerCase();
      if (sel === SEL_TOTAL_MISSIONS && String(call.to).toLowerCase() === c.portal.toLowerCase()) {
        const n = c.burns.filter((b) => b.block <= at).reduce((m, b) => Math.max(m, b.missionId), 0);
        return { result: word(n) };
      }
      if (sel === SEL_TOTAL_BURNED && String(call.to).toLowerCase() === c.portal.toLowerCase()) {
        const wei = c.burns.filter((b) => b.block <= at).reduce((s, b) => s + BigInt(b.amountWei), 0n);
        return { result: word(wei) };
      }
      if (sel === SEL_TOTAL_SUPPLY) return { result: word(c.supply) };
      return { error: { code: 3, message: 'execution reverted' } };
    }
    default: return { error: { code: -32601, message: `method ${req.method} not served by the fake chain` } };
  }
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const candles = (beforeTs, limit, close) => {
  const last = Math.floor(beforeTs / 3600) * 3600;
  return Array.from({ length: limit }, (_, k) => { const ts = last - k * 3600; return [ts, close, close, close, close, 1000]; });
};

function gecko(url, res) {
  const parts = url.pathname.split('/').filter(Boolean); // gt api v2 networks <net> ...
  const net = parts[4];
  const chain = Object.entries(CHAINS).find(([, c]) => c.gecko === net);
  const q = url.searchParams;
  if (parts[5] === 'tokens' && parts[7] === 'pools') {
    if (!chain) return json(res, 404, { errors: [{ status: '404' }] });
    const [id, c] = chain; const s = state.chains[id];
    return json(res, 200, { data: [{
      id: `${net}_0xpool${id}`, type: 'pool',
      attributes: { address: `0x${String(id).padStart(40, '0')}`, reserve_in_usd: String(s.liquidityUsd * 2), base_token_price_usd: String(s.xenUsd), quote_token_price_usd: '1', volume_usd: { h24: '1000' } },
      relationships: { base_token: { data: { id: `${net}_${c.xen.toLowerCase()}` } }, quote_token: { data: { id: `${net}_${c.quote.toLowerCase()}` } } },
    }] });
  }
  if (parts[5] === 'tokens') {
    if (!chain) return json(res, 404, { errors: [{ status: '404' }] });
    return json(res, 200, { data: { attributes: { price_usd: String(state.chains[chain[0]].xenUsd) } } });
  }
  if (parts[5] === 'pools' && parts[7] === 'ohlcv') {
    const before = Number(q.get('before_timestamp') || Math.floor(Date.now() / 1000));
    const limit = Number(q.get('limit') || 24);
    if (net === 'x1-network' && parts[6] === XNT_POOL) return json(res, 200, { data: { attributes: { ohlcv_list: candles(before, limit, state.xntUsd) } } });
    if (!chain) return json(res, 404, { errors: [{ status: '404' }] });
    return json(res, 200, { data: { attributes: { ohlcv_list: candles(before, limit, state.chains[chain[0]].xenUsd) } } });
  }
  return json(res, 404, { errors: [{ status: '404', title: 'not served by the fake world' }] });
}

async function body(req) { let s = ''; for await (const d of req) s += d; return s ? JSON.parse(s) : {}; }

function control(url, b) {
  const c = b.chainId !== undefined ? state.chains[b.chainId] : null;
  switch (url.pathname) {
    case '/ctl/portal': c.portal = b.portal; c.head = Math.max(c.head, b.head ?? c.head); return { ok: true };
    case '/ctl/burn': {
      // one MissionStarted in a new block; the head then moves `final` blocks past it (the chain's confirmations + 1)
      const block = c.head + 1;
      const missionId = c.burns.reduce((m, x) => Math.max(m, x.missionId), 0) + 1;
      const burn = {
        block, logIndex: 0, txHash: ethers.id(`tx:${b.chainId}:${missionId}`), missionId,
        pilot: b.pilot || ethers.getAddress('0x' + ethers.id(`pilot:${b.x1}`).slice(26)),
        amountWei: String(b.amountWei), tier: b.tier ?? 0, x1: b.x1, timestamp: b.timestamp ?? Math.floor(Date.now() / 1000),
      };
      c.burns.push(burn);
      c.head = block + (b.final ?? 200);
      return { ok: true, burn };
    }
    case '/ctl/mine': c.head += b.blocks ?? 1; return { ok: true, head: c.head };
    case '/ctl/price': if (b.chainId !== undefined) c.xenUsd = b.xenUsd; if (b.xntUsd !== undefined) state.xntUsd = b.xntUsd; return { ok: true };
    case '/ctl/state': return state;
    default: return { error: `unknown ${url.pathname}` };
  }
}

http.createServer(async (req, res) => {
  try {
    state.requests++;
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/evm/')) {
      const chainId = url.pathname.split('/')[2];
      const b = await body(req);
      const one = (r) => ({ jsonrpc: '2.0', id: r.id, ...evm(chainId, r) });
      return json(res, 200, Array.isArray(b) ? b.map(one) : one(b));
    }
    if (url.pathname.startsWith('/gt/')) return gecko(url, res);
    if (url.pathname.startsWith('/x1report/')) return json(res, 200, { priceUsd: state.xntUsd });
    if (url.pathname.startsWith('/xdex/')) return json(res, 200, { data: { list: [] } });
    if (url.pathname.startsWith('/site/')) {
      const rel = decodeURIComponent(url.pathname.slice('/site/'.length)) || 'index.html';
      if (rel.includes('..')) return json(res, 400, { error: 'bad path' });
      const roots = [siteDir, path.join(path.resolve(oracleDir), '..', 'frontend', 'public')].filter(Boolean);
      for (const r of roots) {
        const f = path.join(r, rel);
        if (fs.existsSync(f) && fs.statSync(f).isFile()) { res.writeHead(200, { 'content-type': f.endsWith('.json') ? 'application/json' : 'text/plain' }); return res.end(fs.readFileSync(f)); }
      }
      if (rel === 'index.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>Moon Forge (e2e)</title>'); }
      return json(res, 404, { error: 'not found' });
    }
    if (url.pathname.startsWith('/ctl/')) { const r = control(url, req.method === 'POST' ? await body(req) : {}); save(); return json(res, r.error ? 400 : 200, r); }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: String(e?.stack || e) });
  }
}).listen(Number(port), '127.0.0.1', () => console.log(`fake world on 127.0.0.1:${port}`));
