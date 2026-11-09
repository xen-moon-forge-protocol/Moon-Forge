// A guarded EVM signer for the kit's burnXen(). The kit builds the calls (an exact XEN approval, then enterForge) and
// checks the quote; this wrapper decides whether a transaction may leave the machine at all, and how:
//   - the kill switch, then one unfinished transaction at most per chain (the journal and the mempool must both be clear);
//   - the fee cap (max fee per gas) and the cost cap per transaction, plus a native-coin reserve kept in the wallet;
//   - a simulation (eth_call) before signing: a call that would revert is never sent;
//   - the gas limit from a fresh estimate with headroom; the nonce from the chain, never below the last one used;
//   - signed first, written to the journal, then broadcast; a broadcast that errors is looked up by its hash before
//     anything is reported, and a broadcast is never repeated with a different nonce;
//   - confirmations are awaited with a timeout; a transaction still unknown after it stays in the journal and the next
//     tick reconciles it before sending anything else.
// The RPC and the key are adapters (src/evm-ethers.mjs in production, fakes in the tests), so every rule is tested.

export class GuardRefused extends Error {
  constructor(code, text) { super(text); this.name = 'GuardRefused'; this.code = code; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GWEI = 1_000_000_000n;
/** 12.5 gwei (number) → 12500000000n wei, without float drift below 1 wei per gas. */
export const gweiToWei = (g) => (BigInt(Math.round(Number(g) * 1e6)) * GWEI) / 1_000_000n;

/**
 * Fee and cost check, pure. fee = { maxFeePerGas, maxPriorityFeePerGas, gasPrice } (bigint | null).
 * Returns { ok, why?, fees, costWei } where fees is what the transaction will carry.
 */
export function priceCheck({ fee, gasLimit, gas, limits }) {
  const cap = gweiToWei(gas.maxFeePerGasGwei);
  const eip1559 = fee.maxFeePerGas !== null && fee.maxFeePerGas !== undefined;
  const perGas = eip1559 ? BigInt(fee.maxFeePerGas) : BigInt(fee.gasPrice ?? 0n);
  if (perGas === 0n) return { ok: false, why: 'the RPC gave no fee data' };
  if (perGas > cap) return { ok: false, why: `gas price ${Number(perGas) / 1e9} gwei is above the cap of ${gas.maxFeePerGasGwei} gwei` };
  const extra = BigInt(gas.extraFeeWei ?? 0n);
  const costWei = BigInt(gasLimit) * perGas + extra;
  if (costWei > limits.maxGasCostWei) return { ok: false, why: `this transaction may cost up to ${costWei} wei of gas, above maxGasCostNative` };
  const fees = eip1559
    ? { maxFeePerGas: perGas, maxPriorityFeePerGas: BigInt(fee.maxPriorityFeePerGas ?? 0n) > perGas ? perGas : BigInt(fee.maxPriorityFeePerGas ?? 0n) }
    : { gasPrice: perGas };
  return { ok: true, fees, costWei };
}

/**
 * Builds the signer object burnXen() expects ({ provider: { getNetwork, call }, getAddress, sendTransaction }).
 * rpc: { chainId, call, getTransactionCount, getFeeData, estimateGas, getBalance, broadcast, getTransaction, getReceipt, blockNumber }
 * key: { address, sign(txRequest) → signed hex, hashOf(signed) → tx hash }
 */
export function guardedSigner({ chainId, rpc, key, journal, gas, limits, killSwitch = () => null, log = () => {}, pollMs = 4_000, now = () => Date.now() }) {
  let lastNonce = -1n;
  const kindOf = (data) => (String(data).startsWith('0x095ea7b3') ? 'approve' : 'enterForge');

  /** Settles journal entries left open by an earlier run: mined, failed, dropped, or still pending. */
  async function reconcile() {
    for (const e of journal.unresolved(chainId)) {
      const rc = e.hash ? await rpc.getReceipt(e.hash) : null;
      if (rc) { journal.updateSend(e.id, { state: Number(rc.status) === 1 ? 'mined' : 'failed', block: Number(rc.blockNumber) }); continue; }
      const seen = e.hash ? await rpc.getTransaction(e.hash) : null;
      if (seen) continue; // still in a mempool: wait
      const latest = BigInt(await rpc.getTransactionCount(key.address, 'latest'));
      if (latest > BigInt(e.nonce)) journal.updateSend(e.id, { state: 'dropped', note: 'the nonce was used by another transaction' });
      else if (e.state === 'signed' || now() - Date.parse(e.at) > 30 * 60_000) journal.updateSend(e.id, { state: 'dropped', note: 'never seen by the RPC' });
    }
    return journal.unresolved(chainId);
  }

  async function waitFor(entry, confirmations, timeoutMs) {
    const until = now() + timeoutMs;
    for (;;) {
      const rc = await rpc.getReceipt(entry.hash);
      if (rc) {
        const depth = Number(await rpc.blockNumber()) - Number(rc.blockNumber) + 1;
        if (depth >= confirmations) {
          journal.updateSend(entry.id, { state: Number(rc.status) === 1 ? 'mined' : 'failed', block: Number(rc.blockNumber) });
          return rc;
        }
      } else if (BigInt(await rpc.getTransactionCount(key.address, 'latest')) > BigInt(entry.nonce) && !(await rpc.getTransaction(entry.hash))) {
        journal.updateSend(entry.id, { state: 'dropped', note: 'replaced' });
        const err = new Error('the transaction was replaced by another one with the same nonce');
        err.code = 'TRANSACTION_REPLACED'; err.cancelled = true; err.reason = 'cancelled';
        throw err;
      }
      if (now() > until) throw new Error(`transaction ${entry.hash} not confirmed within ${Math.round(timeoutMs / 1000)} s: it stays in the journal and is checked on the next tick before anything else is sent`);
      await sleep(pollMs);
    }
  }

  async function sendTransaction(tx) {
    const stop = killSwitch();
    if (stop) throw new GuardRefused('killSwitch', `kill switch on (${stop}): nothing sent`);
    if (BigInt(await rpc.chainId()) !== BigInt(chainId)) throw new GuardRefused('chain', `the RPC is not on chain ${chainId}`);
    if ((await reconcile()).length) throw new GuardRefused('notFinal', 'an earlier transaction on this chain is not final yet: nothing sent');
    const [latest, pending] = await Promise.all([rpc.getTransactionCount(key.address, 'latest'), rpc.getTransactionCount(key.address, 'pending')]);
    if (BigInt(pending) > BigInt(latest)) throw new GuardRefused('mempool', 'this wallet has a pending transaction in the mempool (sent by something else?): nothing sent');
    const nonce = BigInt(latest) > lastNonce ? BigInt(latest) : lastNonce + 1n;
    const req = { from: key.address, to: tx.to, data: tx.data, value: 0n };
    try { await rpc.call(req); } catch (e) { throw new GuardRefused('simulation', `the call would revert: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}`); }
    const est = BigInt(await rpc.estimateGas(req));
    const gasLimit = (est * BigInt(gas.gasLimitHeadroomBps) + 9_999n) / 10_000n;
    const price = priceCheck({ fee: await rpc.getFeeData(), gasLimit, gas, limits });
    if (!price.ok) throw new GuardRefused('gas', price.why);
    const balance = BigInt(await rpc.getBalance(key.address));
    if (balance < price.costWei + limits.keepNativeReserveWei) throw new GuardRefused('nativeBalance', 'not enough native coin for the gas cap plus the reserve kept in the wallet');
    const signed = await key.sign({ ...req, chainId: BigInt(chainId), nonce: Number(nonce), gasLimit, ...price.fees, ...(price.fees.maxFeePerGas ? { type: 2 } : { type: 0 }) });
    const hash = key.hashOf(signed);
    const entry = journal.openSend({ chainId, kind: kindOf(tx.data), nonce: nonce.toString(), hash, to: tx.to });
    lastNonce = nonce;
    try {
      await rpc.broadcast(signed);
    } catch (e) {
      // the node may have accepted it and failed to answer: look it up before reporting anything
      await sleep(Math.min(pollMs, 2_000));
      if (!(await rpc.getTransaction(hash)) && !(await rpc.getReceipt(hash))) {
        journal.updateSend(entry.id, { state: 'dropped', note: 'broadcast failed and the RPC does not know it' });
        lastNonce = nonce - 1n;
        throw new Error(`broadcast failed (${String(e?.shortMessage ?? e?.message ?? e).slice(0, 120)}); the transaction is not known to the RPC, nothing was sent`);
      }
    }
    journal.updateSend(entry.id, { state: 'broadcast' });
    log(`sent ${entry.kind} on chain ${chainId}: ${hash} (nonce ${nonce}, gas limit ${gasLimit})`);
    return { hash, nonce: Number(nonce), wait: (confirmations = 1) => waitFor(entry, confirmations, gas.txTimeoutSeconds * 1000) };
  }

  return {
    provider: { getNetwork: async () => ({ chainId: BigInt(await rpc.chainId()) }), call: (req) => rpc.call(req) },
    getAddress: async () => key.address,
    sendTransaction,
    reconcile,
  };
}
