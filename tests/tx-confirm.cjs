// One confirmation rule for every localnet suite (run-local's mocha suites, run-upgrade's rehearsal, the e2e driver):
// wait for the signature itself, generously, and NEVER send a transaction twice.
//
// Why: web3.js's legacy wait (`confirmTransaction(sig)`) gives up after 30 s while the transaction may still land, and
// Anchor 0.32.1's sendAndConfirm turns a transaction that passed preflight and then failed on-chain into "Unknown action
// 'undefined'" (it builds web3's SendTransactionError with an old signature), which hides the program error. Under load
// (run-local and run-upgrade on a busy host, 2026-10-25) both cascaded into dozens of unrelated failures.
//
// Dependency-free (CommonJS): the TS suites, the .mjs rehearsal and the e2e driver load it with their own web3.js.
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How long a signature is waited for when nothing says it can no longer land (MF_CONFIRM_MS overrides). */
const CONFIRM_MS = Number(process.env.MF_CONFIRM_MS || 240_000);
const RANK = { processed: 0, confirmed: 1, finalized: 2 };

/**
 * Waits until `sig` reaches `commitment` and returns its status (status.err set = it landed and failed). Throws, with
 * `signature` and `neverLanded: true`, only when the blockhash expired (the confirmed block height passed
 * `lastValidBlockHeight`) and a history search still does not know the signature: it can never land, nothing ran.
 * After `ms` with no answer it throws `notConfirmed: true`: the outcome is unknown and the caller must not re-send.
 */
async function waitForSignature(connection, sig, { commitment = 'confirmed', lastValidBlockHeight, ms = CONFIRM_MS } = {}) {
  const t0 = Date.now();
  const want = RANK[commitment] ?? 1;
  for (let i = 0; ; i++) {
    let st = null;
    try {
      st = (await connection.getSignatureStatuses([sig], { searchTransactionHistory: i > 0 && i % 20 === 0 })).value[0];
    } catch { /* an RPC hiccup under load: ask again */ }
    if (st && st.confirmationStatus && RANK[st.confirmationStatus] >= want) return st;
    if (!st && lastValidBlockHeight !== undefined && i % 4 === 3) {
      const h = await connection.getBlockHeight('confirmed').catch(() => 0);
      if (h > lastValidBlockHeight + 2) {
        const last = (await connection.getSignatureStatuses([sig], { searchTransactionHistory: true }).catch(() => ({ value: [null] }))).value[0];
        if (last && last.confirmationStatus && RANK[last.confirmationStatus] >= want) return last;
        if (!last) {
          throw Object.assign(new Error(`transaction ${sig} never landed: its blockhash expired (block height ${h} > ${lastValidBlockHeight}); nothing ran`), { signature: sig, neverLanded: true });
        }
      }
    }
    if (Date.now() - t0 > ms) {
      throw Object.assign(new Error(`transaction ${sig} not confirmed after ${Math.round(ms / 1000)} s (last status ${st ? st.confirmationStatus : 'none'}); not re-sent`), { signature: sig, notConfirmed: true });
    }
    await sleep(i < 40 ? 250 : 500);
  }
}

/** The logs of a landed transaction (a confirmed one can take a moment to be served by getTransaction). */
async function logsOf(connection, sig, commitment = 'confirmed') {
  for (let i = 0; i < 40; i++) {
    const tx = await connection.getTransaction(sig, { commitment: commitment === 'processed' ? 'confirmed' : commitment, maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (tx) return tx.meta?.logMessages ?? [];
    await sleep(250);
  }
  return [];
}

/**
 * Waits for `sig` (waitForSignature) and returns it when it succeeded. A transaction that landed and failed throws an
 * Error carrying its program `logs` and `signature`: Anchor's translateError turns it into the AnchorError of the
 * program (the name, the number and the message), exactly as a preflight failure, and the suites' expectErr reads it.
 */
async function confirmOrThrow(connection, sig, opts = {}) {
  const st = await waitForSignature(connection, sig, opts);
  if (!st.err) return sig;
  const logs = await logsOf(connection, sig, opts.commitment);
  throw Object.assign(new Error(`transaction ${sig} failed on-chain: ${JSON.stringify(st.err)}`), { logs, signature: sig });
}

/**
 * Replaces an AnchorProvider's sendAndConfirm (the path of every `.rpc()`): sign, send ONCE (with preflight, as Anchor
 * does), then confirmOrThrow with the blockhash's lastValidBlockHeight. Same options as Anchor (provider.opts by
 * default). Idempotent.
 */
function hardenProvider(provider) {
  if (!provider || provider.__mfConfirm) return provider;
  const connection = provider.connection;
  provider.sendAndConfirm = async (tx, signers, opts) => {
    const o = opts || provider.opts || {};
    const commitment = o.commitment || 'confirmed';
    let lastValidBlockHeight;
    if ('version' in tx) {
      if (signers && signers.length) tx.sign(signers);
    } else {
      const bh = await connection.getLatestBlockhash(o.preflightCommitment || commitment);
      lastValidBlockHeight = bh.lastValidBlockHeight;
      tx.feePayer = tx.feePayer || provider.wallet.publicKey;
      tx.recentBlockhash = bh.blockhash;
      for (const s of signers || []) tx.partialSign(s);
    }
    const signed = await provider.wallet.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: o.skipPreflight, preflightCommitment: o.preflightCommitment || commitment, maxRetries: o.maxRetries, minContextSlot: o.minContextSlot,
    });
    return confirmOrThrow(connection, sig, { commitment, lastValidBlockHeight });
  };
  Object.defineProperty(provider, '__mfConfirm', { value: true });
  return provider;
}

/**
 * Sends a legacy Transaction built by the caller (signers[0] pays the fee) ONCE and waits with confirmOrThrow. A
 * preflight failure throws web3's SendTransactionError (with logs) before anything is sent.
 */
async function sendOnce(connection, tx, signers, { commitment = 'confirmed', skipPreflight = false } = {}) {
  const bh = await connection.getLatestBlockhash(commitment);
  tx.feePayer = tx.feePayer || signers[0].publicKey;
  tx.recentBlockhash = bh.blockhash;
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight, preflightCommitment: commitment });
  return confirmOrThrow(connection, sig, { commitment, lastValidBlockHeight: bh.lastValidBlockHeight });
}

/**
 * An airdrop (test funding, not a program instruction), waited for like any transaction. The faucet signs with a
 * blockhash at least as new as the block height read just before the request, so it is dead for sure once the height
 * passes that + 150 (MAX_PROCESSING_AGE) + 30; only then, and only when no node knows the signature, is the airdrop
 * asked for again (at most 3 times): a dropped faucet transaction can never land later, so nobody is funded twice.
 */
async function airdrop(connection, to, lamports, commitment = 'confirmed') {
  for (let attempt = 1; ; attempt++) {
    const h0 = await connection.getBlockHeight('confirmed');
    const sig = await connection.requestAirdrop(to, lamports);
    try {
      return await confirmOrThrow(connection, sig, { commitment, lastValidBlockHeight: h0 + 180 });
    } catch (e) {
      if (!e || !e.neverLanded || attempt >= 3) throw e;
      console.log(`      (airdrop ${sig.slice(0, 12)}… never landed, its blockhash expired: requested again, attempt ${attempt + 1})`);
    }
  }
}

/**
 * Until the block hash of `target` has left the SlotHashes sysvar of the confirmed bank (its oldest entry is a later
 * slot: the program then answers Expired). SlotHashes keeps 512 ENTRIES, and skipped slots have none, so on a loaded
 * validator "target + 515 slots" can still be inside the window: wait for the slot first, then for the sysvar.
 */
async function waitSlotHashGone(connection, slotHashesId, target, minSlots = 515n) {
  const t = BigInt(target);
  for (;;) {
    if (BigInt(await connection.getSlot('confirmed')) > t + BigInt(minSlots)) break;
    await sleep(250);
  }
  for (;;) {
    const info = await connection.getAccountInfo(slotHashesId, 'confirmed');
    const d = info && info.data;
    if (d && d.length >= 48) {
      const len = Math.min(Number(d.readBigUInt64LE(0)), Math.floor((d.length - 8) / 40));
      if (len > 0 && d.readBigUInt64LE(8 + (len - 1) * 40) > t) return;
    }
    await sleep(400);
  }
}

module.exports = { CONFIRM_MS, waitForSignature, confirmOrThrow, hardenProvider, sendOnce, airdrop, waitSlotHashGone, sleep };
