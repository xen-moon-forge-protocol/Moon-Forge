/**
 * Moon Forge agent kit: what an autonomous agent needs to use Moon Forge (X1) with its own keypair.
 *
 *   import { connect, loadKeypair } from './moonforge.mjs';
 *   const mf = await connect({ keypair: loadKeypair(process.env.AGENT_KEY) });
 *   console.log(await mf.status());
 *
 * Covers: game wallet, Be the House (back the game bankroll: deposit, 24 h withdrawal request, withdraw, with a guard
 * against withdrawing while pending bets depress the share value), Artifacts (forge a Lunar Dust, recycle it for its
 * floor), Moon Wars (player vs player, perfect information, every move validated on-chain), the house games (Coin Flip,
 * High-Low, Void Rush: a fixed 2% edge, negative expected value, useful to test, never a way to make money) and the
 * exits of Predictions (claim / advance only: Predictions are in the program but not offered). Everything goes through
 * the open-source Moon Forge program; the kit holds no key other than the one you pass and sends nothing anywhere
 * except the X1 RPC endpoints you configure.
 *
 * Every transaction the kit sends carries a measured compute-unit limit (CU_LIMITS), passes a pre-flight balance check
 * (fee + rent + amount), is confirmed with a getSignatureStatuses fallback when the websocket confirmation times out,
 * and fails over to the next RPC endpoint of the same cluster on transport errors (connect({ rpcs }), or X1_RPC_URLS
 * when no endpoint is passed). A send that fails in transit is looked up by its signature before it is reported, and an
 * error that may hide a landed transaction carries that signature: check it before sending again.
 *
 * Program: 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 (X1 mainnet). Rules and source: https://github.com/xen-moon-forge-protocol/Moon-Forge
 * The program is upgradeable during its public test period; the current Artifact rules are being replaced by a planned
 * upgrade (see the notices the kit prints). No third-party audit.
 */
import anchor from '@coral-xyz/anchor'; // CommonJS package: the default import is the whole module (BN, Program, Wallet...)
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SendTransactionError, SystemProgram, SYSVAR_SLOT_HASHES_PUBKEY,
} from '@solana/web3.js';
import bs58 from 'bs58';
import crypto from 'crypto';
import fs from 'fs';
import { errorMessage, programErrorName, programErrorNumber, PROGRAM_ERRORS } from './errors.mjs';

export { errorMessage, programErrorName, programErrorNumber, PROGRAM_ERRORS };

export const PROGRAM_ID = new PublicKey('57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9');
export const MPL_CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
/** XDEX WXNT/USDC.X observation account: the on-chain price source the program reads (checked by the program). */
export const XDEX_OBSERVATION = new PublicKey('4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ');
/**
 * Public X1 mainnet RPC endpoints known to the project, in order. Only one public endpoint is known; the public RPC is
 * rate-limited, so for anything frequent add your own: connect({ rpcs: ['https://your-rpc', ...] }) or the
 * X1_RPC_URLS environment variable (comma-separated; read only when connect() gets no rpc/rpcs). The kit fails over to
 * the next endpoint on transport errors, and leaves out any endpoint on another cluster (genesis hash check).
 */
export const X1_RPCS = Object.freeze(['https://rpc.mainnet.x1.xyz']);
export const MAINNET_RPC = X1_RPCS[0];
export const X1_EXPLORER = 'https://explorer.mainnet.x1.xyz';
export const explorerTx = (sig) => `${X1_EXPLORER}/tx/${sig}`;
export const XNT = 1_000_000_000;
/** Lunar Dust (tier 0) price: fixed at 10 XNT; half of it stays inside the NFT as a refundable floor. */
export const LUNAR_DUST_PRICE = 10n * BigInt(XNT);
/** games.rs: the protocol's dead shares (1 share = 1 lamport at the first deposit; the supply can never be emptied). */
export const HOUSE_DEAD_SHARES = 1_000_000n;
/** Be the House guard: refuse deposits/withdrawals while pending bets reserve more than this share of the bankroll. */
export const LP_MAX_RESERVED_BPS = 100;

/**
 * Compute-unit limits per instruction: the most any measurement consumed, x1.2, rounded up to the next 1,000. Never a
 * global default: a limit that is too low is refused by the RPC's pre-flight simulation (send() then re-measures once),
 * one that is too high pays 10 lamports per unused unit on X1. Measurements (2026-10-22), in the comments:
 *   localnet v2  test/e2e-local.mjs MEASURE_CU=1 on the localnet build of the deployed source (tag program-2026-10-12)
 *   mainnet      test/measure-cu-mainnet.mjs: read-only simulation against the deployed program, where live state allows
 *   dev build    an earlier e2e run on a development build; kept because it was higher (an account whose address needs
 *                more search iterations costs ~1,500 units per iteration, and that depends on the keys involved)
 * See agents/README.md "Compute-unit limits".
 */
export const CU_LIMITS = Object.freeze({
  openPlayer: 23_000, // 12,578 localnet v2, 14,078 mainnet, 18,624 dev build
  deposit: 11_000, // 8,716 localnet v2, 8,716 mainnet, 8,762 dev build
  withdraw: 11_000, // 6,290 localnet v2, 6,140 mainnet, 8,541 dev build
  placeBet: 55_000, // 42,418 localnet v2, 37,748 mainnet, 45,443 dev build
  settleBet: 29_000, // 23,535 localnet v2, 23,587 dev build
  forgeArtifact: 104_000, // 85,073 localnet v2, 86,619 dev build (Core CPI)
  recycleArtifact: 40_000, // 32,831 localnet v2, 32,877 dev build (Core CPI)
  createWar: 54_000, // 39,953 localnet v2, 44,499 dev build
  joinWar: 38_000, // 30,954 localnet v2, 31,000 dev build
  cancelWar: 18_000, // 14,441 localnet v2, 14,487 dev build
  startWar: 25_000, // 20,365 localnet v2, 20,411 dev build
  warSummon: 18_000, // 14,740 localnet v2, 14,793 dev build
  warAttack: 18_000, // 14,910 localnet v2, 14,954 dev build
  warEndTurn: 18_000, // 14,752 localnet v2, 14,798 dev build
  claimWarTimeout: 18_000, // 14,251 localnet v2, 14,297 dev build
  settleWar: 44_000, // 35,958 localnet v2, 36,004 dev build
  lockPrediction: 16_000, // 12,674 localnet v2, 12,749 dev build
  settlePrediction: 37_000, // 29,930 localnet v2, 30,005 dev build
  claimPrediction: 31_000, // 25,396 localnet v2, 25,442 dev build
  houseDeposit: 42_000, // 28,595 localnet v2, 28,654 mainnet, 34,641 dev build
  houseRequestWithdraw: 8_000, // 5,800 localnet v2, 5,650 mainnet, 5,846 dev build
  houseWithdraw: 24_000, // 19,844 localnet v2, 19,890 dev build
});
/** X1 fee model (getFeeForMessage and real transactions, 2026-10-22): 10 lamports per requested unit + 1,500 for the limit instruction. */
export const feeLamports = (units) => 1_500 + 10 * units;

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const seed = (s) => Buffer.from(s);
const pda = (...s) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
export const PDA = {
  config: () => pda(seed('config')),
  rewardVault: () => pda(seed('reward_vault')),
  bankrollVault: () => pda(seed('bankroll_vault')),
  drawVault: () => pda(seed('draw_vault')),
  collection: () => pda(seed('collection')),
  artifactAuthority: () => pda(seed('artifact_authority')),
  player: (owner) => pda(seed('player'), owner.toBuffer()),
  house: (owner) => pda(seed('house'), owner.toBuffer()),
  bet: (playerState, nonce) => pda(seed('bet'), playerState.toBuffer(), u64(nonce)),
  asset: (tier, serial) => pda(seed('asset'), Buffer.from([tier]), u32(serial)),
  artifact: (asset) => pda(seed('artifact'), asset.toBuffer()),
  war: (creator, nonce) => pda(seed('war'), creator.toBuffer(), u64(nonce)),
  pred: (round) => pda(seed('pred'), u64(round)),
  predEntry: (round, player) => pda(seed('pred_entry'), u64(round), player.toBuffer()),
};

/** Moon Wars rules, identical to the program (constants.rs WAR_*). Cards: [power, defense, cost]. */
export const WAR = {
  cards: [[2, 2, 1], [4, 3, 2], [6, 4, 3], [10, 10, 5]],
  names: ['Lunar Dust', 'Cosmic Shard', 'Solar Core', 'Void Anomaly'],
  fieldMax: 6,
  minStakeXnt: 0.1,
  state: { OPEN: 0, STARTING: 1, ACTIVE: 2, DONE: 3 },
  /** attack target that means "the enemy player" (allowed only when the enemy field is empty) */
  PLAYER: 255,
  /** seconds per turn on mainnet: running out of time loses the match */
  turnSeconds: 120,
};
/**
 * House games (constants.rs GAME_*). Coin Flip: param 0, choice 0 | 1. High-Low: param = win chance in bps,
 * choice 0 low | 1 high. Void Rush: param = target multiplier in bps (20000 = 2x). Minimum stake 0.01 XNT; the net
 * win of one bet can be at most 0.25% of the free bankroll; all pending payouts together at most 20% of it.
 */
export const GAME = { COINFLIP: 0, HIGHLOW: 1, VOIDRUSH: 2 };
/** Predictions are in the program but not offered: the kit only exposes the exits (advance, claim). */
export const PRED = { state: { OPEN: 0, LOCKED: 1, SETTLED: 2, REFUND: 3 }, side: { DOWN: 0, UP: 1 } };

/** Notices the kit prints once per session (and status() returns) while they apply. */
export const NOTICES = Object.freeze({
  wars: 'Moon Wars: the website has paused creating and joining real-XNT matches (its browser move key is underfunded); '
    + 'the program is unchanged and the kit signs every move with your own key, so matches made here are real. Costs: every move is '
    + 'a transaction with its own network fee (each side often makes 30-60 moves, about 0.0002 XNT each), the winner pays the 2% rake, the arena ticket '
    + '(Lunar Dust) costs 10 XNT and returns only 5 XNT on recycle, and the creator moves first. 2 minutes per turn: a crash, a slow '
    + 'RPC or a missed poll loses the match and the stake. Your opponent may be another automated agent. Stake only what you can afford to lose.',
  forge: 'Forging is paused on the website until the planned program upgrade (the current Artifact rules are being replaced); the '
    + 'program itself still accepts forges. A Lunar Dust costs 10 XNT: 5 XNT stay inside as the floor you get back by recycling it, '
    + 'the rest goes to the reward pool, the lottery vault and the architect. An Artifact forged under the current rules is not '
    + 'expected to qualify for the rules that replace them. Forge + recycle always loses half of the price.',
  recycle: 'Recycling burns the NFT for good and returns only its floor (forged: half of the price paid; Forge Drop: the drop value; '
    + 'Genesis: nothing beyond the account rent). Under the current rules you give up its Moon Wars / Duel ticket, its burn-score '
    + 'boost and its weekly chips. The current Artifact rules are being replaced by a planned program upgrade written for Artifacts '
    + 'forged after it, so an Artifact forged under the current rules is not expected to qualify for the new rules either way.',
  predictions: 'Predictions: in the program, but not offered (the v1 design can be steered by whoever moves the small XDEX pool). The kit '
    + 'only advances and claims existing rounds; it does not enter them.',
  houseGames: 'House games carry a fixed 2% edge: negative expected value. Use them to test, never as a way to make money.',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bn = (n) => new anchor.BN(n.toString());
const lamports = (xnt) => BigInt(Math.round(Number(xnt) * XNT));
const fmt = (l) => (Number(l) / XNT).toFixed(4);
const maxBig = (a, b) => (a > b ? a : b);

/**
 * A keypair from a file path (holding a JSON byte array or a base58 secret), a JSON byte array string, a base58
 * secret, or a byte array. Every error message is fixed text: none of them quotes the key material (a JSON.parse
 * error would quote part of its input, which agent logs would then keep).
 */
export function loadKeypair(source) {
  if (source instanceof Keypair) return source;
  if (Array.isArray(source) || source instanceof Uint8Array) return keypairFromBytes(() => Uint8Array.from(source), 'byte array');
  if (typeof source !== 'string' || !source.trim()) throw new Error('loadKeypair: pass a keypair file path, a JSON byte array or a base58 secret');
  const s = source.trim();
  if (s.startsWith('[')) return keypairFromText(s, 'string');
  let isFile = false;
  try { isFile = fs.statSync(s).isFile(); } catch { /* not a path */ }
  if (isFile) {
    let text;
    try { text = fs.readFileSync(s, 'utf8'); } catch { throw new Error('loadKeypair: the key file exists but could not be read'); }
    return keypairFromText(text, 'file');
  }
  return keypairFromText(s, 'string');
}
function keypairFromText(text, where) {
  const s = text.trim();
  if (s.startsWith('[')) {
    return keypairFromBytes(() => {
      try { return Uint8Array.from(JSON.parse(s)); } catch { throw new Error(`loadKeypair: the key ${where} starts like a JSON byte array but is not valid JSON (its content is not shown)`); }
    }, where);
  }
  return keypairFromBytes(() => {
    try { return bs58.decode(s); } catch {
      throw new Error(where === 'file'
        ? 'loadKeypair: the key file holds neither a JSON byte array nor a base58 secret (its content is not shown)'
        : 'loadKeypair: the key string is not an existing file, a JSON byte array or a base58 secret (its content is not shown)');
    }
  }, where);
}
function keypairFromBytes(decode, where) {
  const bytes = decode();
  try { return Keypair.fromSecretKey(bytes); } catch { throw new Error(`loadKeypair: the key ${where} is not a valid 64-byte secret key (its content is not shown)`); }
}

// ─── RPC: endpoint list, cluster check, failover ───────────────────────────
/** X1 mainnet genesis hash (getGenesisHash on rpc.mainnet.x1.xyz, 2026-10-22): the built-in endpoint list must be on it. */
export const X1_MAINNET_GENESIS = '4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN';
const defaultWarning = (text) => console.warn(`[moonforge] ${text}`);
const splitUrls = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
/**
 * Where the endpoints come from: `rpc` (one URL) then `rpcs` when either is passed (source 'explicit'); otherwise
 * X1_RPC_URLS (comma-separated, 'env'); otherwise the public list ('default'). X1_RPC_URLS is never merged into an
 * explicit list: a run pointed at one cluster must not fail over to an endpoint of another.
 */
export function rpcConfig({ rpc, rpcs, env = process.env } = {}) {
  const explicit = [...(rpc ? [rpc] : []), ...(rpcs ?? [])].map((s) => String(s).trim()).filter(Boolean);
  if (explicit.length) return { urls: [...new Set(explicit)], source: 'explicit' };
  const fromEnv = splitUrls(env.X1_RPC_URLS);
  if (fromEnv.length) return { urls: [...new Set(fromEnv)], source: 'env' };
  return { urls: [...X1_RPCS], source: 'default' };
}
/** The endpoint list of rpcConfig(). */
export const rpcList = (opts) => rpcConfig(opts).urls;
/** Scheme, host and port of an RPC URL, for logs and status(): private endpoints often carry an API key in the path or query. */
export function redactRpc(url) {
  try {
    const u = new URL(String(url));
    return u.origin !== 'null' ? u.origin : `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid RPC URL)';
  }
}
const clusterName = (genesis) => (genesis === X1_MAINNET_GENESIS ? 'X1 mainnet' : genesis ? `not X1 mainnet (genesis ${genesis})` : 'not checked');
const expectedName = (genesis) => (genesis === X1_MAINNET_GENESIS ? 'X1 mainnet' : `genesis ${genesis}`);
const withTimeout = (p, ms) => {
  let t;
  const timer = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms); t.unref?.(); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
};
/**
 * Asks every endpoint for its genesis hash and keeps only the endpoints of one cluster: `expected` when given (connect()
 * passes X1 mainnet's for the built-in list), otherwise the cluster of the first endpoint that answers. Each endpoint
 * left out is reported through onWarning; one that does not answer stays in the list as unverified and is checked
 * before it serves its first request (failoverConnection `genesis` / `unverified`).
 */
export async function checkRpcGenesis(urls, { expected = null, onWarning = () => {}, timeoutMs = 10_000, getGenesis = (u) => new Connection(u, 'confirmed').getGenesisHash() } = {}) {
  const answers = await Promise.all(urls.map((u) => withTimeout(Promise.resolve().then(() => getGenesis(u)), timeoutMs)
    .then((genesis) => (typeof genesis === 'string' && genesis ? genesis : null), () => null)));
  const genesis = expected ?? answers.find(Boolean) ?? null;
  const kept = [], unverified = [], dropped = [];
  urls.forEach((url, i) => {
    const g = answers[i];
    if (g && genesis && g !== genesis) {
      dropped.push(url);
      onWarning(`RPC ${redactRpc(url)} left out: it is on another cluster (genesis ${g}; expected ${expectedName(genesis)})`);
      return;
    }
    kept.push(url);
    if (!g) unverified.push(url);
  });
  return { urls: kept, genesis, unverified, dropped };
}
/**
 * A web3.js Connection on urls[0] whose JSON-RPC requests fail over to the next endpoint on transport errors (network
 * failure, HTTP 5xx, 429 after the client's own retries). Subscriptions stay on the first endpoint. Relies on the
 * private `_rpcRequest` / `_rpcBatchRequest` of @solana/web3.js 1.98.4, which is pinned exactly for that reason.
 * Options: `genesis` (the cluster every endpoint must be on) and `unverified` (endpoints whose genesis is not known yet:
 * each is asked before its first use and left out if it differs); `onSwitch({ from, to, reason, back })` is called once
 * per change of the serving endpoint and `onDrop({ url, genesis, expected })` once per endpoint left out (URLs redacted
 * to their origin); after `retryPrimaryMs` on another endpoint the first one is probed in the background (genesis
 * hash) and serves again once it answers.
 */
export function failoverConnection(urls, commitment = 'confirmed', { genesis = null, unverified = [], onSwitch = null, onDrop = null, retryPrimaryMs = 60_000 } = {}) {
  const conns = urls.map((u) => new Connection(u, commitment));
  const primary = conns[0];
  const state = {
    urls: [...urls], conns, current: 0, failures: [], failCount: 0, sendFailCount: 0, genesis,
    verified: urls.map((u) => !unverified.includes(u)), dropped: urls.map(() => false), switchedAt: 0, retryPrimaryMs, onSwitch, onDrop,
  };
  if (conns.length > 1) {
    for (const c of conns) { c._rpcRequestOrig = c._rpcRequest; c._rpcBatchRequestOrig = c._rpcBatchRequest; }
    const fail = (i, method, e) => {
      state.failCount++;
      if (method === 'sendTransaction') state.sendFailCount++;
      state.failures.push({ url: redactRpc(urls[i]), method, error: String(e?.message ?? e).slice(0, 120), at: Date.now() });
      if (state.failures.length > 50) state.failures.shift();
    };
    const verify = async (i) => {
      if (state.verified[i]) return true;
      let g;
      try { g = (await conns[i]._rpcRequestOrig('getGenesisHash', []))?.result; } catch (e) { fail(i, 'getGenesisHash', e); return false; }
      if (typeof g !== 'string' || !g) return false;
      if (state.genesis && g !== state.genesis) {
        state.dropped[i] = true;
        state.onDrop?.({ url: redactRpc(urls[i]), genesis: g, expected: state.genesis });
        return false;
      }
      state.genesis ??= g;
      state.verified[i] = true;
      return true;
    };
    const switchTo = (i, reason) => {
      const from = state.current;
      state.current = i;
      state.switchedAt = Date.now();
      state.onSwitch?.({ from: redactRpc(urls[from]), to: redactRpc(urls[i]), reason, back: i === 0 });
    };
    // Not sticky forever: once per retryPrimaryMs the first endpoint gets a background genesis probe, and the next
    // request goes back to it when it answers on the right cluster. A real request never waits on a dead endpoint.
    const probeFirst = () => {
      if (state.probing || state.current === 0 || state.dropped[0] || Date.now() - state.switchedAt < state.retryPrimaryMs) return;
      state.probing = true;
      state.switchedAt = Date.now();
      Promise.resolve().then(() => conns[0]._rpcRequestOrig('getGenesisHash', [])).then((res) => {
        const g = res?.result;
        if (typeof g !== 'string' || !g || state.current === 0) return;
        if (state.genesis && g !== state.genesis) {
          state.dropped[0] = true;
          state.onDrop?.({ url: redactRpc(urls[0]), genesis: g, expected: state.genesis });
          return;
        }
        state.genesis ??= g;
        state.verified[0] = true;
        switchTo(0, null);
      }, (e) => fail(0, 'getGenesisHash', e)).finally(() => { state.probing = false; });
    };
    const tryAll = async (key, args) => {
      const method = key === '_rpcRequestOrig' ? String(args[0]) : 'batch';
      probeFirst();
      let lastErr = null;
      for (let k = 0; k < conns.length; k++) {
        const i = (state.current + k) % conns.length;
        if (state.dropped[i] || !(await verify(i))) continue;
        try {
          const r = await conns[i][key](...args);
          if (i !== state.current) switchTo(i, lastErr ? String(lastErr?.message ?? lastErr).slice(0, 120) : null);
          return r;
        } catch (e) {
          lastErr = e;
          fail(i, method, e);
        }
      }
      throw lastErr ?? new Error('no RPC endpoint left on the expected cluster (every other endpoint was left out or did not answer)');
    };
    primary._rpcRequest = (...a) => tryAll('_rpcRequestOrig', a);
    primary._rpcBatchRequest = (...a) => tryAll('_rpcBatchRequestOrig', a);
  }
  primary.rpcFailover = state;
  return primary;
}

// ─── compute-unit limits ────────────────────────────────────────────────────
export const cuIx = (units) => ComputeBudgetProgram.setComputeUnitLimit({ units });
/** Adds the measured compute-unit limit for `name` (a CU_LIMITS key) to an Anchor methods builder. */
export function withCu(builder, name, units = CU_LIMITS[name]) {
  if (!Number.isInteger(units) || units <= 0 || units > 1_400_000) throw new Error(`withCu: no compute-unit limit for "${name}"`);
  return builder.preInstructions([cuIx(units)]);
}
/** True when a send failed because the compute-unit limit was too low (pre-flight simulation or on-chain). */
export function cuExhausted(e) {
  const text = [String(e?.message ?? ''), JSON.stringify(e?.err ?? null), ...(e?.logs ?? e?.transactionLogs ?? [])].join('\n');
  return /exceeded CUs meter|ComputationalBudgetExceeded|Computational budget exceeded|exceeded maximum compute/i.test(text);
}
/**
 * True when sendRawTransaction failed in a way that may hide a delivered transaction: a transport failure (network,
 * dropped response, HTTP error status) or an RPC saying it was "already processed". False when the RPC answered with a
 * refusal of the transaction itself (pre-flight simulation failure, program error, bad blockhash), which sends nothing.
 */
export function sendMayHaveLanded(e) {
  const text = `${e?.message ?? e} ${e?.transactionMessage ?? ''}`;
  if (/already been processed|AlreadyProcessed/i.test(text)) return true;
  if (e instanceof SendTransactionError) return false;
  if (Array.isArray(e?.logs) || Array.isArray(e?.transactionLogs) || programErrorNumber(e) != null) return false;
  return true;
}
/** The error thrown when a send failed in transit and the signature was not found afterwards: it carries the signature. */
function mayHaveLandedError(original, translated, signature, name) {
  const text = `${String(original?.message ?? original)} ${original?.transactionMessage ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 160);
  // a refusal relayed by the failover (the next endpoint's pre-flight) keeps its own error, so programErrorName() still
  // works (errorMessage() appends the warning); a transport failure or "already processed" becomes a new error whose
  // message says what to do
  const refusal = !/already been processed|AlreadyProcessed/i.test(text)
    && (original instanceof SendTransactionError || Array.isArray(original?.logs) || programErrorNumber(original) != null);
  const e = refusal ? translated
    : new Error(`${name}: sending failed (${text}) after the transaction was signed, and it may have been delivered: signature ${signature} `
      + `(${explorerTx(signature)}) was not seen within the short check. It may have landed: check the signature on the explorer before sending again.`);
  if (e !== original) e.cause = original;
  e.signature = signature;
  e.mayHaveLanded = true;
  return e;
}
/** The limit to request for `consumed` units: x1.2, rounded up to the next 1,000, capped at 1.4M. */
export const limitFor = (consumed) => Math.min(1_400_000, Math.ceil((Number(consumed) * 1.2) / 1000) * 1000);
/** Replaces the SetComputeUnitLimit instruction of a built transaction (adds one if missing). */
export function setCuLimit(tx, units) {
  const i = tx.instructions.findIndex((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2);
  if (i >= 0) tx.instructions[i] = cuIx(units); else tx.instructions.unshift(cuIx(units));
  return tx;
}
/** Simulates a builder's transaction (no signature, nothing sent) and returns the compute units it consumed. */
export async function measureCu(connection, builder, feePayer) {
  const tx = await builder.transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  const sim = await connection.simulateTransaction(tx);
  return { unitsConsumed: sim.value.unitsConsumed ?? null, err: sim.value.err ?? null, logs: sim.value.logs ?? [] };
}

// ─── Be the House guard math (pure; games.rs::house_deposit / house_withdraw) ──
/** The widest slippage either guard accepts (50%): beyond it the minimum would no longer protect anything. */
export const MAX_SLIPPAGE_BPS = 5_000;
const slippageProblem = (bps) => (Number.isInteger(bps) && bps >= 0 && bps <= MAX_SLIPPAGE_BPS ? null
  : `slippageBps must be a whole number from 0 to ${MAX_SLIPPAGE_BPS} (got ${String(bps).slice(0, 20)})`);
/**
 * What a withdrawal of `shares` is worth and the minimum to demand. The program pays shares x (unreserved - reserved)
 * / totalShares: pending bets reserve their full payout until they settle, so a withdrawal made while bets are pending
 * is paid below the real value (the reserved part is not lost, it is simply not yours any more). Defaults: refuse while
 * reserved / unreserved > 1%, and demand 99% of the UNRESERVED quote so the transaction itself fails rather than pay
 * the haircut. `force` only skips the kit-side refusal; to accept a haircut pass an explicit `minLamports` above 0.
 * A minimum of 0 is refused even with `force`, and `slippageBps` must be 0-5000.
 */
export function houseWithdrawGuard({ shares, unreserved, reserved, totalShares, slippageBps = 100, minLamports, force = false, maxReservedBps = LP_MAX_RESERVED_BPS }) {
  shares = BigInt(shares); unreserved = BigInt(unreserved); reserved = BigInt(reserved); totalShares = BigInt(totalShares);
  const conservative = unreserved > reserved ? unreserved - reserved : 0n;
  const quoteUnreserved = totalShares > 0n ? (shares * unreserved) / totalShares : 0n;
  const quoteConservative = totalShares > 0n ? (shares * conservative) / totalShares : 0n;
  const haircutBps = unreserved > 0n ? Number((reserved * 10_000n) / unreserved) : 0;
  const badSlippage = minLamports === undefined || minLamports === null ? slippageProblem(slippageBps) : null;
  const min = badSlippage ? 0n
    : minLamports === undefined || minLamports === null ? (quoteUnreserved * BigInt(10_000 - slippageBps)) / 10_000n : BigInt(minLamports);
  let refuse = null;
  if (badSlippage) refuse = `${badSlippage}; to accept a larger loss pass an explicit minimum (minXnt)`;
  else if (min <= 0n) refuse = 'minLamports 0 disables the slippage guard (the withdrawal could be paid far below its value) and is refused even with force: pass the lowest amount you accept (minXnt above 0)';
  else if (haircutBps > maxReservedBps && !force) {
    refuse = `pending bets reserve ${(haircutBps / 100).toFixed(2)}% of the bankroll (guard limit ${maxReservedBps / 100}%): a withdrawal now would be paid `
      + `${fmt(quoteConservative)} instead of ${fmt(quoteUnreserved)} XNT. Settle the pending bets first (settleBet is permissionless) or pass force:true with an explicit minXnt`;
  }
  return { quoteUnreserved, quoteConservative, haircutBps, minLamports: min, refuse };
}
/**
 * Shares a deposit of `amount` lamports mints now and the minimum to demand. The program mints at the UNRESERVED value
 * (as if every pending bet loses); if the pending bets win, the new shares are worth less than paid. Defaults: refuse
 * while reserved / unreserved > 1%, and derive min_shares from the conservative value so the transaction itself fails
 * when the haircut exceeds the slippage. `force` falls back to the plain slippage guard on the minted amount.
 * min_shares is never 0 (refused), and `slippageBps` must be 0-5000, with or without `force`.
 */
export function houseDepositGuard({ amount, unreserved, reserved, totalShares, slippageBps = 100, force = false, maxReservedBps = LP_MAX_RESERVED_BPS }) {
  amount = BigInt(amount); unreserved = BigInt(unreserved); reserved = BigInt(reserved); totalShares = BigInt(totalShares);
  const value = maxBig(unreserved, HOUSE_DEAD_SHARES);
  const total = totalShares === 0n ? value : totalShares;
  const minted = (amount * total) / value;
  const conservativeValue = maxBig(unreserved > reserved ? unreserved - reserved : 0n, HOUSE_DEAD_SHARES);
  const fair = (amount * total) / conservativeValue;
  const haircutBps = unreserved > 0n ? Number((reserved * 10_000n) / unreserved) : 0;
  const badSlippage = slippageProblem(slippageBps);
  const minShares = badSlippage ? 0n : ((force ? minted : fair) * BigInt(10_000 - slippageBps)) / 10_000n;
  let refuse = null;
  if (badSlippage) refuse = badSlippage;
  else if (minShares <= 0n) refuse = 'min_shares would be 0, which disables the slippage guard; deposit a larger amount';
  else if (haircutBps > maxReservedBps && !force) {
    refuse = `pending bets reserve ${(haircutBps / 100).toFixed(2)}% of the bankroll (guard limit ${maxReservedBps / 100}%): a deposit now is priced as if every pending bet loses `
      + `(${minted} shares for ${fmt(amount)} XNT; ${fair} if they all win). Wait for them to settle or pass force:true`;
  }
  return { minted, fair, haircutBps, minShares, refuse };
}

/** Owner of a live Metaplex Core asset of the Moon Forge collection, or null. */
export function coreOwner(info, collection = PDA.collection()) {
  const d = info?.data;
  if (!info || !d || d.length < 66 || !info.owner.equals(MPL_CORE) || d[0] !== 1 || d[33] !== 2) return null;
  if (!new PublicKey(d.subarray(34, 66)).equals(collection)) return null;
  return new PublicKey(d.subarray(1, 33));
}

/**
 * Connects with the agent's keypair.
 *   rpc / rpcs: your own endpoint(s) (see X1_RPCS); without them X1_RPC_URLS, then the public list. Every endpoint is
 *   asked for its genesis hash and one on another cluster is left out (with a warning): the built-in list must be on X1
 *   mainnet, any other list on the cluster of its first endpoint; `genesis` pins the cluster (e.g. X1_MAINNET_GENESIS).
 *   idl: object or file path (default: read from chain, or the MOONFORGE_IDL env path); onWarning: where the kit's
 *   notices go (default console.warn); cu: per-instruction overrides.
 */
export async function connect({ rpc, rpcs, keypair, idl, onWarning, cu, genesis } = {}) {
  if (!keypair) throw new Error('connect: keypair is required');
  const warnFn = onWarning ?? defaultWarning;
  const { urls, source: rpcSource } = rpcConfig({ rpc, rpcs });
  const expected = genesis ?? (rpcSource === 'default' ? X1_MAINNET_GENESIS : null);
  const checked = await checkRpcGenesis(urls, { expected, onWarning: warnFn });
  if (!checked.urls.length) {
    throw new Error(`connect: no RPC endpoint is on the expected cluster (${clusterName(checked.genesis)}); left out: ${checked.dropped.map(redactRpc).join(', ')}`);
  }
  const connection = failoverConnection(checked.urls, 'confirmed', { genesis: checked.genesis, unverified: checked.unverified });
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(keypair), { commitment: 'confirmed' });
  const source = idl ?? process.env.MOONFORGE_IDL;
  const theIdl = source ? (typeof source === 'string' ? JSON.parse(fs.readFileSync(source, 'utf8')) : source) : await anchor.Program.fetchIdl(PROGRAM_ID, provider);
  if (!theIdl) throw new Error('could not load the Moon Forge IDL from chain (pass `idl` or set MOONFORGE_IDL to a local copy, e.g. frontend/src/idl/moon_forge.json)');
  if (theIdl.address && theIdl.address !== PROGRAM_ID.toBase58()) throw new Error(`the IDL is for ${theIdl.address}, not for the Moon Forge program ${PROGRAM_ID.toBase58()}`);
  return new MoonForge(new anchor.Program(theIdl, provider), keypair, { onWarning, cu });
}

export class MoonForge {
  constructor(program, keypair, { onWarning, cu } = {}) {
    this.program = program;
    this.connection = program.provider.connection;
    this.keypair = keypair;
    this.me = keypair.publicKey;
    this.acc = program.account;
    this.idlErrors = program.idl ? anchor.parseIdlErrors(program.idl) : new Map();
    this.cu = { ...CU_LIMITS, ...(cu ?? {}) };
    this.onWarning = onWarning ?? defaultWarning;
    this.warned = new Set();
    // every change of the serving RPC endpoint, and every endpoint left out for being on another cluster, is a warning
    const fo = this.connection.rpcFailover;
    if (fo) {
      fo.onSwitch ??= ({ from, to, reason, back }) => this.onWarning(back
        ? `RPC failover: back on ${to} (it answers again; ${from} served meanwhile)`
        : `RPC failover: ${from} failed (${reason ?? 'no answer'}); now using ${to}`);
      fo.onDrop ??= ({ url, genesis, expected }) => this.onWarning(`RPC ${url} left out: it is on another cluster (genesis ${genesis}; expected ${expectedName(expected)})`);
    }
    /** optional hook: (name, signature, transaction) after every confirmed send (used by the tests to measure CUs) */
    this.onSent = null;
    /** getSignatureStatuses polling after a confirmation timeout */
    this.pollOpts = { tries: 30, intervalMs: 2000 };
  }
  warn(key, text = NOTICES[key]) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.onWarning(text);
  }

  // ─── sending ───────────────────────────────────────────────────────────────
  /** Lamports the rent of one program account of type `name` costs (IDL account sizes). */
  rentFor(name) { return this.connection.getMinimumBalanceForRentExemption(this.acc[name].size); }
  /** Refuses before paying a fee when the wallet cannot cover fee + rent + amount. */
  async preflight(tx, needLamports = 0n) {
    const [feeRes, balance] = await Promise.all([
      this.connection.getFeeForMessage(tx.compileMessage(), 'confirmed').catch(() => ({ value: null })),
      this.connection.getBalance(this.me, 'confirmed'),
    ]);
    const fee = BigInt(feeRes?.value ?? 2_000_000);
    const need = fee + BigInt(needLamports);
    if (BigInt(balance) < need) {
      throw new Error(`pre-flight: the wallet holds ${fmt(balance)} XNT but this transaction needs about ${fmt(need)} XNT `
        + `(network fee ${fmt(fee)} + ${fmt(needLamports)} XNT of rent/amount). Nothing was sent; top up ${this.me.toBase58()} first.`);
    }
    return { fee, balance: BigInt(balance) };
  }
  /** Polls getSignatureStatuses after a confirmation timeout: the transaction may have landed anyway. */
  async pollStatus(signature, { tries = 30, intervalMs = 2000 } = {}) {
    for (let i = 0; i < tries; i++) {
      const s = await this.#signatureStatus(signature);
      if (s && (s.err || s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return s;
      await sleep(intervalMs);
    }
    const e = new Error(`transaction ${signature} was not confirmed after the timeout and polling (${explorerTx(signature)}). Check it before sending again: it may still land.`);
    e.signature = signature;
    e.mayHaveLanded = true;
    throw e;
  }
  /** The status of one signature, or null (not seen yet, or the RPC failed: both mean "keep looking"). */
  async #signatureStatus(signature) {
    try {
      return (await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))?.value?.[0] ?? null;
    } catch {
      return null;
    }
  }
  /** Looks for a signature at any commitment for `tries` polls (after a send that failed in transit); the status or null. */
  async #findSignature(signature, tries) {
    for (let i = 0; i < tries; i++) {
      const s = await this.#signatureStatus(signature);
      if (s) return s;
      if (i < tries - 1) await sleep(this.pollOpts.intervalMs);
    }
    return null;
  }
  translate(e) {
    if (Array.isArray(e?.logs)) {
      const t = anchor.translateError(e, this.idlErrors);
      if (t) { if (e.signature && !t.signature) t.signature = e.signature; return t; }
    }
    return e;
  }
  async onChainError(signature, err) {
    const tx = await this.connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
    const e = new Error(`transaction ${signature} failed on-chain: ${JSON.stringify(err)}`);
    e.logs = tx?.meta?.logMessages ?? [];
    e.err = err;
    e.signature = signature;
    return this.translate(e);
  }
  /**
   * Builds, pre-checks, signs, sends and confirms one instruction with its compute-unit limit. `needLamports`: rent
   * and amounts the wallet must hold besides the fee. `rebuild`: on InvalidTarget (a counter moved between read and
   * send) the builder is rebuilt once with fresh state and re-sent. If the measured limit is too low for this state
   * (a PDA whose bump needs more search iterations than measured, ~1,500 units each), the transaction is simulated
   * once without a cap and re-sent with that measurement x1.2. Returns the signature.
   */
  async send(builder, name, { needLamports = 0n, rebuild = null, cu } = {}) {
    let b = withCu(builder, name, cu ?? this.cu[name]);
    let units = null, raceRetried = false, cuRetried = false;
    for (;;) {
      try {
        return await this.#sendOnce(b, name, needLamports, units);
      } catch (e) {
        // a counter race surfaces as InvalidTarget (the program's check) or, when the loser's PDA is created from the
        // stale serial, as the System program refusing an account "already in use" before the program's check runs
        // a transaction that may have landed is never re-sent or rebuilt: that could execute it twice
        if (e?.mayHaveLanded) throw e;
        const raced = programErrorName(e) === 'InvalidTarget' || /already in use/.test((e?.logs ?? e?.transactionLogs ?? []).join('\n'));
        if (rebuild && !raceRetried && raced) {
          raceRetried = true;
          this.onWarning(`${name}: someone moved the counter first (InvalidTarget); re-reading it and retrying once`);
          b = withCu(await rebuild(), name, cu ?? this.cu[name]);
          continue;
        }
        if (!cuRetried && cuExhausted(e)) {
          cuRetried = true;
          const consumed = await this.#consumedUncapped(b);
          if (!consumed) throw e;
          units = limitFor(consumed);
          this.onWarning(`${name}: the compute-unit limit ${cu ?? this.cu[name]} was too low for this state (measured ${consumed}); retrying once with ${units}`);
          continue;
        }
        throw e;
      }
    }
  }
  /** Units the transaction consumes in a simulation with the maximum limit (nothing signed or sent), or null. */
  async #consumedUncapped(b) {
    const tx = setCuLimit(await b.transaction(), 1_400_000);
    tx.feePayer = this.me;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash('confirmed')).blockhash;
    const sim = await this.connection.simulateTransaction(tx).catch(() => null);
    return sim?.value?.unitsConsumed || null;
  }
  async #sendOnce(b, name, needLamports, units = null) {
    const tx = await b.transaction();
    if (units) setCuLimit(tx, units);
    tx.feePayer = this.me;
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    await this.preflight(tx, needLamports);
    tx.sign(this.keypair);
    // the signature is known before anything is sent: keep it, so a send that fails after delivery can still be found
    const signature = bs58.encode(tx.signature);
    const raw = tx.serialize();
    const fo = this.connection.rpcFailover;
    const sendFailsBefore = fo?.sendFailCount ?? 0;
    let status = null;
    try {
      await this.connection.sendRawTransaction(raw, { preflightCommitment: 'confirmed' });
    } catch (e) {
      // A transport failure may have happened after the RPC forwarded the transaction, and the failover re-sends the
      // same bytes to the next endpoint, which may then answer "already been processed" (or refuse it in its own
      // pre-flight). Before reporting a failure, look for the signature: reporting a landed transaction as failed
      // invites a second bet, forge or deposit.
      const relayed = (fo?.sendFailCount ?? 0) > sendFailsBefore;
      if (!relayed && !sendMayHaveLanded(e)) throw this.translate(e);
      const seen = await this.#findSignature(signature, 5);
      if (!seen) throw mayHaveLandedError(e, this.translate(e), signature, name);
      this.onWarning(`${name}: the RPC reported an error (${String(e?.message ?? e).split('\n')[0].slice(0, 100)}) but the transaction reached the network (${signature}); it was not sent again`);
      if (seen.err || seen.confirmationStatus === 'confirmed' || seen.confirmationStatus === 'finalized') status = seen;
    }
    if (!status) {
      try {
        status = (await this.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')).value;
      } catch {
        // timed out, expired, or the RPC failed while waiting: the transaction was sent and may have landed either way
        status = await this.pollStatus(signature, this.pollOpts);
      }
    }
    if (status?.err) throw await this.onChainError(signature, status.err);
    if (this.onSent) await this.onSent(name, signature, tx);
    return signature;
  }

  // ─── reading ───────────────────────────────────────────────────────────────
  config() { return this.acc.config.fetch(PDA.config()); }

  async chainTime() { return (await this.connection.getBlockTime(await this.connection.getSlot('confirmed'))) ?? Math.floor(Date.now() / 1000); }

  /** USD per XNT: the 15-minute TWAP the XDEX WXNT/USDC.X pool records on-chain (token 0 = WXNT 9 dp, token 1 = USDC.X 6 dp). */
  async xntUsd(window = 900) {
    const info = await this.connection.getAccountInfo(XDEX_OBSERVATION, 'confirmed');
    if (!info || info.data.length < 43 + 100 * 40) return null;
    const d = info.data, obs = [];
    for (let i = 0; i < 100; i++) {
      const o = 43 + i * 40, ts = Number(d.readBigUInt64LE(o));
      if (ts) obs.push({ ts, cum: d.readBigUInt64LE(o + 8) | (d.readBigUInt64LE(o + 16) << 64n) });
    }
    if (obs.length < 2) return null;
    obs.sort((a, b) => a.ts - b.ts);
    const hi = obs[obs.length - 1], lo = [...obs].reverse().find((x) => x.ts <= hi.ts - window) ?? obs[0];
    if (hi.ts <= lo.ts) return null;
    return (Number((hi.cum - lo.cum) / BigInt(hi.ts - lo.ts)) / 2 ** 32) * 1e3;
  }

  /** The game bankroll as the program values it: unreserved = vault minus rent; reserved = payouts of pending bets. */
  async bankroll() {
    const [cfg, info] = await Promise.all([this.config(), this.connection.getAccountInfo(PDA.bankrollVault(), 'confirmed')]);
    const rent = info ? BigInt(await this.connection.getMinimumBalanceForRentExemption(info.data.length)) : 0n;
    const unreserved = info ? maxBig(0n, BigInt(info.lamports) - rent) : 0n;
    const reserved = BigInt(cfg.bankrollReserved.toString());
    const totalShares = BigInt(cfg.houseTotalShares.toString());
    return {
      unreserved, reserved, conservative: unreserved > reserved ? unreserved - reserved : 0n, totalShares,
      protocolShares: BigInt(cfg.houseProtocolShares.toString()),
      haircutBps: unreserved > 0n ? Number((reserved * 10_000n) / unreserved) : 0,
    };
  }

  /** One call with what an agent needs to decide: balances, pool, bankroll state, open matches, notices. */
  async status() {
    const [cfg, xnt, game, pool, arts, wars, price, bank, entries, share] = await Promise.all([
      this.config(), this.connection.getBalance(this.me), this.gameBalance(), this.connection.getAccountInfo(PDA.rewardVault()),
      this.myArtifacts(), this.openWars(), this.xntUsd(), this.bankroll(), this.myPredictionEntries(), this.houseShare(),
    ]);
    const rent = pool ? await this.connection.getMinimumBalanceForRentExemption(pool.data.length) : 0;
    const free = Math.max(0, (pool?.lamports ?? 0) - rent - Number(cfg.rewardReserved));
    const fo = this.connection.rpcFailover;
    return {
      wallet: this.me.toBase58(),
      /** the endpoint serving now, origin only (a private URL's key stays out of logs) */
      rpc: redactRpc(fo ? fo.urls[fo.current] : this.connection.rpcEndpoint),
      cluster: clusterName(fo?.genesis),
      walletXnt: xnt / XNT,
      gameBalanceXnt: Number(game) / XNT,
      artifacts: arts.length,
      xntUsd: price,
      rewardPoolXnt: free / XNT,
      /** current rules: an epoch pays at most 10% of the free pool (an upper bound, not a promise; the rules are being replaced) */
      weeklyCapUpperBoundXnt: Math.floor(free * 0.1) / XNT,
      bankroll: {
        unreservedXnt: Number(bank.unreserved) / XNT, reservedXnt: Number(bank.reserved) / XNT, haircutPct: bank.haircutBps / 100,
        totalShares: bank.totalShares.toString(), myShares: share ? share.shares.toString() : '0',
        shareValueXnt: bank.totalShares > 0n ? Number(bank.conservative) / Number(bank.totalShares) : null,
      },
      openWars: wars.map((w) => ({ war: w.publicKey.toBase58(), creator: w.account.creator.toBase58(), stakeXnt: Number(w.account.stake) / XNT })),
      predictions: { offered: false, myEntries: entries.length },
      notices: [NOTICES.wars, NOTICES.predictions, NOTICES.houseGames, NOTICES.forge],
    };
  }

  // ─── game wallet ───────────────────────────────────────────────────────────
  async ensurePlayer() {
    const ps = PDA.player(this.me);
    if (await this.connection.getAccountInfo(ps)) return ps;
    await this.send(this.program.methods.openPlayer().accountsPartial({ playerState: ps, owner: this.me, systemProgram: SystemProgram.programId }),
      'openPlayer', { needLamports: BigInt(await this.rentFor('playerState')) });
    return ps;
  }
  async gameBalance() {
    const p = await this.acc.playerState.fetchNullable(PDA.player(this.me));
    return p ? BigInt(p.balance.toString()) : 0n;
  }
  async deposit(xnt) {
    const ps = await this.ensurePlayer();
    return this.send(this.program.methods.deposit(bn(lamports(xnt))).accountsPartial({ playerState: ps, payer: this.me, systemProgram: SystemProgram.programId }),
      'deposit', { needLamports: lamports(xnt) });
  }
  async withdraw(xnt) {
    return this.send(this.program.methods.withdraw(bn(lamports(xnt))).accountsPartial({ playerState: PDA.player(this.me), owner: this.me }), 'withdraw');
  }

  // ─── house games (fixed 2% edge: negative expected value) ──────────────────
  /**
   * Places a bet from the game wallet and returns the bet account. See GAME for game / param / choice.
   * The outcome comes from the hash of a future slot: call settleBet right away (a bet nobody settles within
   * ~3 minutes counts as lost). Its full payout stays reserved in the bankroll until it is settled.
   */
  async placeBet(game, param, choice, stakeXnt) {
    this.warn('houseGames');
    const ps = await this.ensurePlayer();
    const { nonce } = await this.acc.playerState.fetch(ps);
    const bet = PDA.bet(ps, BigInt(nonce.toString()));
    const cfg = await this.config();
    await this.send(this.program.methods.placeBet(game, bn(param), choice, bn(lamports(stakeXnt)), Array.from(crypto.randomBytes(32))).accountsPartial({
      config: PDA.config(), playerState: ps, bet, bankrollVault: PDA.bankrollVault(), rewardVault: PDA.rewardVault(),
      architect: cfg.architect, signer: this.me, systemProgram: SystemProgram.programId,
    }), 'placeBet', { needLamports: BigInt(await this.rentFor('bet')) });
    return bet;
  }
  /** Settles a bet once its target slot has passed (anyone may; the bet rent goes back to whoever paid it). */
  async settleBet(bet) {
    const b = await this.acc.bet.fetch(bet);
    const target = BigInt(b.targetSlot.toString());
    while (BigInt(await this.connection.getSlot('confirmed')) <= target) await sleep(400);
    const before = await this.acc.playerState.fetch(b.playerState);
    await this.send(this.program.methods.settleBet().accountsPartial({
      config: PDA.config(), bet, playerState: b.playerState, bankrollVault: PDA.bankrollVault(),
      slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, rentPayer: b.rentPayer,
    }), 'settleBet');
    const after = await this.acc.playerState.fetch(b.playerState);
    const paid = BigInt(after.balance.toString()) - BigInt(before.balance.toString());
    return { won: paid > 0n, payoutXnt: Number(paid) / XNT };
  }

  // ─── Artifacts (under the current rules any live one is the Moon Wars / Duel ticket) ──
  async myArtifacts() {
    const records = await this.acc.artifactRecord.all();
    if (!records.length) return [];
    // the RPC accepts at most 100 accounts per getMultipleAccountsInfo call
    const infos = [];
    for (let i = 0; i < records.length; i += 100) {
      infos.push(...await this.connection.getMultipleAccountsInfo(records.slice(i, i + 100).map((r) => r.account.asset)));
    }
    const collection = PDA.collection();
    return records.filter((r, i) => coreOwner(infos[i], collection)?.equals(this.me))
      .map((r) => ({ asset: r.account.asset, tier: r.account.tier, backingXnt: Number(r.account.backing) / XNT, origin: r.account.origin }));
  }
  /** Forges a Lunar Dust (tier 0): 50% of the price stays inside as a floor you get back by recycling it. Returns the asset. */
  async forgeLunarDust() {
    this.warn('forge');
    const build = async () => {
      const cfg = await this.config();
      const serial = cfg.artifactsMinted[0];
      const asset = PDA.asset(0, serial);
      // Lunar Dust has a fixed price (only the rarer tiers are dynamic); max_price protects against any change
      const b = this.program.methods.forgeArtifact(0, serial, bn(LUNAR_DUST_PRICE)).accountsPartial({
        config: PDA.config(), asset, record: PDA.artifact(asset), collection: PDA.collection(), artifactAuthority: PDA.artifactAuthority(),
        rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: cfg.architect, buyer: this.me, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
      });
      b.__asset = asset;
      return b;
    };
    let b = await build();
    const need = LUNAR_DUST_PRICE + BigInt(await this.rentFor('artifactRecord')) + BigInt(await this.connection.getMinimumBalanceForRentExemption(300));
    await this.send(b, 'forgeArtifact', { needLamports: need, rebuild: async () => (b = await build()) });
    return b.__asset;
  }
  /**
   * Recycles (burns) an Artifact you hold and returns its floor to your wallet. Prints the eligibility notice once:
   * the floor is all that comes back, and the current rules (ticket, boost, chips) are being replaced.
   */
  async recycleArtifact(asset) {
    asset = new PublicKey(asset);
    const record = await this.acc.artifactRecord.fetchNullable(PDA.artifact(asset));
    if (!record) throw new Error(`recycleArtifact: ${asset.toBase58()} has no Moon Forge record (not an Artifact of this program)`);
    const holder = coreOwner(await this.connection.getAccountInfo(asset, 'confirmed'));
    if (!holder) throw new Error(`recycleArtifact: ${asset.toBase58()} is not a live Artifact any more (already recycled or burned)`);
    if (!holder.equals(this.me)) throw new Error(`recycleArtifact: ${asset.toBase58()} is held by ${holder.toBase58()}, not by this wallet`);
    this.warn('recycle');
    const signature = await this.send(this.program.methods.recycleArtifact().accountsPartial({
      config: PDA.config(), asset, record: PDA.artifact(asset), collection: PDA.collection(), owner: this.me, coreProgram: MPL_CORE, systemProgram: SystemProgram.programId,
    }), 'recycleArtifact');
    return { signature, floorXnt: Number(record.backing) / XNT, tier: record.tier, origin: record.origin };
  }
  async ticket() { return (await this.myArtifacts())[0]?.asset ?? null; }

  // ─── Moon Wars ─────────────────────────────────────────────────────────────
  war(war) { return this.acc.war.fetch(war); }
  async openWars() {
    const all = await this.acc.war.all([{ memcmp: { offset: 88, bytes: bs58.encode(Buffer.from([WAR.state.OPEN])) } }]);
    return all.filter((w) => !w.account.creator.equals(this.me));
  }
  async myWars() {
    const [a, b] = await Promise.all([
      this.acc.war.all([{ memcmp: { offset: 8, bytes: this.me.toBase58() } }]),
      this.acc.war.all([{ memcmp: { offset: 40, bytes: this.me.toBase58() } }]),
    ]);
    return [...a, ...b];
  }
  async createWar(stakeXnt) {
    this.warn('wars');
    const ticket = await this.ticket();
    if (!ticket) throw new Error('an Artifact is the arena ticket under the current rules: forge a Lunar Dust first (10 XNT, 5 back on recycle)');
    const ps = await this.ensurePlayer();
    const nonce = (await this.acc.playerState.fetch(ps)).nonce;
    const war = PDA.war(this.me, nonce);
    await this.send(this.program.methods.createWar(bn(lamports(stakeXnt)), this.me).accountsPartial({
      config: PDA.config(), creatorState: ps, war, owner: this.me, asset: ticket, record: PDA.artifact(ticket), collection: PDA.collection(), systemProgram: SystemProgram.programId,
    }), 'createWar', { needLamports: BigInt(await this.rentFor('war')) });
    return war;
  }
  async joinWar(war) {
    this.warn('wars');
    const ticket = await this.ticket();
    if (!ticket) throw new Error('an Artifact is the arena ticket under the current rules: forge a Lunar Dust first (10 XNT, 5 back on recycle)');
    const ps = await this.ensurePlayer();
    return this.send(this.program.methods.joinWar(this.me).accountsPartial({
      config: PDA.config(), war, opponentState: ps, opponent: this.me, asset: ticket, record: PDA.artifact(ticket), collection: PDA.collection(),
    }), 'joinWar');
  }
  async cancelWar(war) {
    return this.send(this.program.methods.cancelWar().accountsPartial({ war, creatorState: PDA.player(this.me), creator: this.me }), 'cancelWar');
  }
  /** Permissionless: shuffles both decks with the hash of the block committed at join (retries until it exists). */
  async startWar(war) {
    let last = '';
    for (let i = 0; i < 40; i++) {
      const w = await this.war(war);
      if (w.state !== WAR.state.STARTING) return;
      try {
        await this.send(this.program.methods.startWar().accountsPartial({ war, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY }), 'startWar');
      } catch (e) {
        // NotReady: the committed block does not exist yet; any other failure is usually the opponent having
        // started it a moment earlier. The state is re-read on the next pass either way.
        last = errorMessage(e);
      }
      await sleep(800);
    }
    if ((await this.war(war)).state === WAR.state.STARTING) throw new Error(`the match did not start: ${last}`);
  }
  /** Every legal move for the side to move, in the program's terms. */
  legalMoves(w) {
    const me = w.sides[w.turn], foe = w.sides[1 - w.turn], out = [];
    for (let i = 0; i < me.handLen; i++) if (WAR.cards[me.hand[i]][2] <= me.mana && me.fieldLen < WAR.fieldMax) out.push({ type: 'summon', hand: i });
    for (let a = 0; a < me.fieldLen; a++) {
      if (!me.field[a].ready) continue;
      if (foe.fieldLen === 0) out.push({ type: 'attack', attacker: a, target: WAR.PLAYER });
      for (let t = 0; t < foe.fieldLen; t++) out.push({ type: 'attack', attacker: a, target: t });
    }
    out.push({ type: 'end' });
    return out;
  }
  /**
   * A simple baseline policy: hit the player when the way is clear; take trades that kill a unit without losing
   * the attacker; summon the most expensive affordable card; otherwise end the turn. Replace it with your own.
   */
  greedyMove(w) {
    const me = w.sides[w.turn], foe = w.sides[1 - w.turn], moves = this.legalMoves(w);
    const face = moves.find((m) => m.type === 'attack' && m.target === WAR.PLAYER);
    if (face) return face;
    let best = null, bestScore = 0;
    for (const m of moves.filter((x) => x.type === 'attack')) {
      const atk = me.field[m.attacker], def = foe.field[m.target];
      const [ap] = WAR.cards[atk.element], [dp] = WAR.cards[def.element];
      const kills = def.defense - ap <= 0, survives = atk.defense - dp > 0;
      const score = (kills ? WAR.cards[def.element][2] * 2 : 0) + (survives ? 1 : -WAR.cards[atk.element][2]);
      if (kills && score > bestScore) { best = m; bestScore = score; }
    }
    if (best) return best;
    const summons = moves.filter((x) => x.type === 'summon').sort((a, b) => WAR.cards[me.hand[b.hand]][2] - WAR.cards[me.hand[a.hand]][2]);
    if (summons.length) return summons[0];
    return { type: 'end' };
  }
  async move(war, m) {
    const [b, name] = m.type === 'summon' ? [this.program.methods.warSummon(m.hand), 'warSummon']
      : m.type === 'attack' ? [this.program.methods.warAttack(m.attacker, m.target), 'warAttack']
        : [this.program.methods.warEndTurn(), 'warEndTurn'];
    return this.send(b.accountsPartial({ war, signer: this.me }), name);
  }
  /** Permissionless: ends a match whose side to move ran out of time (the other side wins). */
  async claimWarTimeout(war) {
    return this.send(this.program.methods.claimWarTimeout().accountsPartial({ war }), 'claimWarTimeout');
  }
  /**
   * Plays a joined match to the end with `policy` (default greedyMove). Moves only on this agent's turns; claims the
   * win if the opponent runs out of time. Returns the finished match account. Turn timer: 2 minutes on mainnet.
   */
  async playMatch(war, { policy, log = () => {}, pollMs = 1500 } = {}) {
    const choose = policy ?? ((w) => this.greedyMove(w));
    await this.startWar(war);
    let failures = 0;
    for (;;) {
      const w = await this.war(war);
      if (w.state === WAR.state.DONE) return w;
      const mine = (w.turn === 0 ? w.creator : w.opponent).equals(this.me);
      const now = await this.chainTime();
      if (!mine) {
        if (now > Number(w.deadline)) {
          try { await this.claimWarTimeout(war); log('opponent ran out of time'); } catch { /* raced */ }
        }
        await sleep(pollMs);
        continue;
      }
      const m = choose(w);
      try {
        await this.move(war, m);
        failures = 0;
        log(`round ${w.round}: ${m.type}${m.type === 'summon' ? ` ${WAR.names[w.sides[w.turn].hand[m.hand]]}` : m.type === 'attack' ? ` ${m.attacker}→${m.target === WAR.PLAYER ? 'player' : m.target}` : ''}`);
      } catch (e) {
        // the state may have moved on (match over, turn timed out, an RPC that dropped the error details):
        // re-read it and try again; give up only on a move that keeps failing on the same state
        if (++failures >= 5) throw new Error(`move keeps failing: ${errorMessage(e)}`);
        await sleep(pollMs);
      }
    }
  }
  /** Permissionless once finished: winner gets both stakes minus the 2% rake (1% to the burners' pool); a draw refunds both. */
  async settleWar(war) {
    const w = await this.war(war);
    const cfg = await this.config();
    return this.send(this.program.methods.settleWar().accountsPartial({
      config: PDA.config(), war, creatorState: PDA.player(w.creator), opponentState: PDA.player(w.opponent), rewardVault: PDA.rewardVault(),
      drawVault: PDA.drawVault(), architect: cfg.architect, rentPayer: w.rentPayer,
    }), 'settleWar');
  }

  // ─── Predictions: exits only (not offered) ─────────────────────────────────
  async myPredictionEntries() {
    return this.acc.predEntry.all([{ memcmp: { offset: 16, bytes: this.me.toBase58() } }]);
  }
  /** Permissionless: locks a round after its entry window, or settles it after its end time. */
  async advancePrediction(id) {
    const r = await this.acc.predRound.fetch(PDA.pred(id));
    if (r.state === PRED.state.OPEN) {
      return this.send(this.program.methods.lockPrediction().accountsPartial({ round: PDA.pred(id), observation: XDEX_OBSERVATION }), 'lockPrediction');
    }
    const cfg = await this.config();
    return this.send(this.program.methods.settlePrediction().accountsPartial({
      config: PDA.config(), round: PDA.pred(id), observation: XDEX_OBSERVATION, rewardVault: PDA.rewardVault(), drawVault: PDA.drawVault(), architect: cfg.architect,
    }), 'settlePrediction');
  }
  /** Claims every resolved entry of this agent (winners share the pot pro-rata minus 2%; refunds return the stake). */
  async claimPredictions() {
    const out = [];
    for (const e of await this.myPredictionEntries()) {
      const id = Number(e.account.round);
      const r = await this.acc.predRound.fetch(PDA.pred(id));
      if (r.state !== PRED.state.SETTLED && r.state !== PRED.state.REFUND) continue;
      await this.send(this.program.methods.claimPrediction().accountsPartial({
        config: PDA.config(), round: PDA.pred(id), entry: e.publicKey, playerState: PDA.player(e.account.player), rentPayer: e.account.rentPayer,
      }), 'claimPrediction');
      out.push(id);
    }
    return out;
  }

  // ─── Be the House ──────────────────────────────────────────────────────────
  /** Shares a deposit of `xnt` would mint now (the program prices deposits as if every pending bet loses). */
  async houseQuote(xnt) {
    return houseDepositGuard({ amount: lamports(xnt), ...(await this.bankroll()), force: true }).minted;
  }
  /**
   * Backs the bankroll: you take the house side (your share rises when players lose and falls when they win; 1.5% of
   * every stake leaves to the pool and the architect before the bankroll sees it). 24 h withdrawal cooldown.
   * Refuses while pending bets reserve more than 1% of the bankroll unless `force`; min_shares is derived from the
   * conservative value so the transaction fails instead of overpaying. The second argument may be a slippage in bps
   * (0-5000; min_shares is never 0).
   */
  async houseDeposit(xnt, opts = {}) {
    const { slippageBps = 100, force = false } = typeof opts === 'number' ? { slippageBps: opts } : opts;
    const amount = lamports(xnt);
    const g = houseDepositGuard({ amount, ...(await this.bankroll()), slippageBps, force });
    if (g.refuse) throw new Error(`houseDeposit refused: ${g.refuse}`);
    const shareExists = !!(await this.connection.getAccountInfo(PDA.house(this.me)));
    const need = amount + (shareExists ? 0n : BigInt(await this.rentFor('houseShare')));
    const signature = await this.send(this.program.methods.houseDeposit(bn(amount), bn(g.minShares)).accountsPartial({
      config: PDA.config(), share: PDA.house(this.me), bankrollVault: PDA.bankrollVault(), owner: this.me, systemProgram: SystemProgram.programId,
    }), 'houseDeposit', { needLamports: need });
    return { signature, minShares: g.minShares, quotedShares: g.minted, haircutBps: g.haircutBps };
  }
  /** Your Be the House position: shares, shares requested for withdrawal and when they unlock (unix seconds). */
  async houseShare() {
    const s = await this.acc.houseShare.fetchNullable(PDA.house(this.me));
    return s ? { shares: BigInt(s.shares.toString()), pendingShares: BigInt(s.pendingShares.toString()), unlockTs: Number(s.unlockTs.toString()) } : null;
  }
  /** Starts the 24 h withdrawal cooldown for `shares` (default: all of them). A new request replaces the previous one. */
  async houseRequestWithdraw(shares) {
    const s = await this.houseShare();
    if (!s) throw new Error('houseRequestWithdraw: no Be the House position');
    return this.send(this.program.methods.houseRequestWithdraw(bn(shares === undefined ? s.shares : BigInt(shares))).accountsPartial({
      share: PDA.house(this.me), owner: this.me,
    }), 'houseRequestWithdraw');
  }
  /** What houseWithdraw() would do now: quotes, the pending-bet haircut and the minimum it would demand. */
  async houseWithdrawQuote({ minXnt, force = false, slippageBps = 100 } = {}) {
    const s = await this.houseShare();
    const pending = s ? (s.pendingShares < s.shares ? s.pendingShares : s.shares) : 0n;
    return { ...houseWithdrawGuard({ shares: pending, ...(await this.bankroll()), slippageBps, force, minLamports: minXnt === undefined ? undefined : lamports(minXnt) }), pendingShares: pending, unlockTs: s?.unlockTs ?? null };
  }
  /**
   * After the cooldown, pays the requested shares at the program's conservative value. Default minimum: 99% of the
   * unreserved quote, so a withdrawal depressed by pending bets fails instead of paying the haircut; refused by the kit
   * while reserved / bankroll > 1% unless `force`. To accept less pass an explicit `minXnt` above 0 (0 is refused,
   * even with `force`).
   */
  async houseWithdraw(minXnt, { force = false, slippageBps = 100 } = {}) {
    const q = await this.houseWithdrawQuote({ minXnt, force, slippageBps });
    if (q.pendingShares === 0n) throw new Error('houseWithdraw: nothing requested; call houseRequestWithdraw(shares) first and wait out the 24 h cooldown');
    if (q.refuse) throw new Error(`houseWithdraw refused: ${q.refuse}`);
    const signature = await this.send(this.program.methods.houseWithdraw(bn(q.minLamports)).accountsPartial({
      config: PDA.config(), share: PDA.house(this.me), bankrollVault: PDA.bankrollVault(), owner: this.me,
    }), 'houseWithdraw');
    return { signature, minLamports: q.minLamports, quoteUnreservedXnt: Number(q.quoteUnreserved) / XNT, quoteConservativeXnt: Number(q.quoteConservative) / XNT, haircutBps: q.haircutBps };
  }
}
