// A dependency-free EVM JSON-RPC adapter for evm-guard.mjs: plain fetch, a list of endpoints per chain, rotation and a
// short backoff on transport errors. A JSON-RPC error (a revert, a bad request) is an answer and is never retried on
// another endpoint. Endpoint URLs never reach the logs (they often carry an API key): errors name the origin only.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const origin = (u) => { try { return new URL(u).origin; } catch { return '(url)'; } };
const big = (h) => (h === null || h === undefined ? null : BigInt(h));
const hex = (v) => (v === undefined || v === null ? undefined : `0x${BigInt(v).toString(16)}`);

export class RpcAnswerError extends Error {
  constructor(err) { super(err?.message ?? 'JSON-RPC error'); this.name = 'RpcAnswerError'; this.code = err?.code; this.data = err?.data; }
}

/** rpc adapter over `urls` for `chainId`. Options: fetchImpl, rounds, backoffMs, timeoutMs. */
export function jsonRpc(urls, { fetchImpl = globalThis.fetch, rounds = 3, backoffMs = 800, timeoutMs = 15_000 } = {}) {
  if (!urls?.length) throw new Error('no RPC endpoint');
  let current = 0, id = 0;
  async function once(url, method, params) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: ctl.signal });
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} from ${origin(url)}`), { transient: r.status === 429 || r.status >= 500 });
      const j = await r.json();
      if (j.error) throw new RpcAnswerError(j.error);
      return j.result;
    } catch (e) {
      if (e instanceof RpcAnswerError || e.transient === false) throw e;
      throw Object.assign(new Error(`${method} failed on ${origin(url)}: ${e.name === 'AbortError' ? 'timeout' : String(e.message).replace(/https?:\/\/\S+/g, '(url)')}`), { transient: true });
    } finally { clearTimeout(t); }
  }
  async function request(method, params = []) {
    let last;
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < urls.length; i++) {
        const k = (current + i) % urls.length;
        try { const v = await once(urls[k], method, params); current = k; return v; } catch (e) {
          last = e;
          if (!e.transient) throw e;
        }
      }
      await sleep(backoffMs * (r + 1));
    }
    throw last;
  }
  const txParams = (req) => ({ from: req.from, to: req.to, data: req.data, value: hex(req.value ?? 0n) });
  return {
    request,
    chainId: async () => BigInt(await request('eth_chainId')),
    call: (req) => request('eth_call', [txParams(req), 'latest']),
    getTransactionCount: async (a, tag) => BigInt(await request('eth_getTransactionCount', [a, tag])),
    estimateGas: async (req) => BigInt(await request('eth_estimateGas', [txParams(req)])),
    getBalance: async (a) => BigInt(await request('eth_getBalance', [a, 'latest'])),
    blockNumber: async () => Number(await request('eth_blockNumber')),
    broadcast: (signed) => once(urls[current], 'eth_sendRawTransaction', [signed]),
    getTransaction: (h) => request('eth_getTransactionByHash', [h]),
    getReceipt: async (h) => { const r = await request('eth_getTransactionReceipt', [h]); return r ? { ...r, hash: r.transactionHash, status: Number(r.status), blockNumber: Number(r.blockNumber) } : null; },
    /** EIP-1559 fees when the chain has a base fee (max fee = 2 × base fee + tip), else the legacy gas price. */
    async getFeeData() {
      const [block, gasPrice] = await Promise.all([request('eth_getBlockByNumber', ['latest', false]), request('eth_gasPrice')]);
      const base = big(block?.baseFeePerGas);
      if (base === null) return { maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: big(gasPrice) };
      let tip;
      try { tip = big(await request('eth_maxPriorityFeePerGas')); } catch { tip = big(gasPrice) > base ? big(gasPrice) - base : 0n; }
      return { maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip, gasPrice: big(gasPrice) };
    },
  };
}
