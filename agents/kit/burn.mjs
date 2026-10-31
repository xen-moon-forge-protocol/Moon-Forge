/**
 * Burn XEN through a Moon Forge portal from an agent, with the v3 binding quote and every refusal in front of it.
 *
 *   import { quoteBurn, burnXen, planBurns, x1ToBytes32 } from './burn.mjs';
 *   const q = quoteBurn({ feed, prev, chainId: 10, amountWei, tier: 0, x1 });   // refusals in q.refusals
 *   const r = await burnXen({ signer, chainId: 10, amountWei, tier: 0, x1, confirmLast6: x1.slice(-6), getFeed, prev, x1Connection: mf.connection });
 *
 * The EVM side needs an ethers v6 Signer of the burning wallet (bring your own: the kit adds no EVM dependency; it builds
 * the three calls itself: XEN approve of the exact amount, never unlimited, then the portal's enterForge). The X1 side
 * of the quote needs the week-so-far feed the v3 oracle writes (FEED CONTRACT below) and the previous epoch file.
 *
 * WHEN THIS APPLIES. The binding quote exists only from the switch epoch (v3 rules, decided, not live; planned for
 * November 2026 and announced at least one full epoch ahead with the date and the last v2 publish transaction). Today
 * the live v2 oracle pays an estimate, there is no feed, and quoteBurn() fails closed: burnXen() refuses every burn.
 * Nothing in this module can make the kit burn without a binding quote.
 *
 * What a quote means (WORDING §3): the number is what the epoch pays for this burn if it lands inside today's remaining
 * capacity. It is not a dollar price of XNT and not a promise about XNT's value at claim time; it depends on the oracle
 * publishing; burns on the same chain in the same hour share that hour's curve pot, so the number is "at most" until the
 * hour closes. If the GitHub account falls, the site, the oracle, the keeper and the epoch files stop; payouts pause;
 * the pools stay locked in the program; once the final upgrade is live and no epoch has survived its hold for 28 days,
 * the largest voider can take the oracle seat from day 28 and anyone from day 29, with a bond.
 *
 * FEED CONTRACT (week-so-far, version 1; written hourly by the v3 oracle, off the main branch). ONE schema for every
 * client: the raw window (what the kit and the oracle value) plus the fields the website reads already derived from it.
 * A writer emits all of it; the fixture test/vectors/week-so-far.v1.json is an example (npm run vectors:feed) that the
 * kit's tests parse and check field by field.
 *   { kind: 'week-so-far', version: 1, programId, rules: 3, epoch, asOf (X1 unix s),
 *     prevEpoch: { epoch: epoch − 1, dataHash }, prevDataHash (= prevEpoch.dataHash),
 *     window: { startTs (epoch − 1's on-chain published_at) }, freePool: { open (F_ref), now? },
 *     capacity: { cash: C (⌊8% F_ref⌋, never above 7 × 2% of the XDEX XNT reserve read at epoch − 1's build, D-22 a),
 *                 senior: Σ arrival senior of the window's own burns in chains[].burns (a skipped chain's backlog and
 *                 the operator wallets' burns rank after a new burn, D-12 / D-18) },
 *     xnt: { twapE18, apiE18, buildE18: max(twap × the USDC.X factor, api) (D-22 c), floorE18: 60% of epoch − 1's XNT price,
 *            current: { hour, medianE18, lastCloseE18, source: 'candles' | 'fallback' } },
 *     readings: { hour, xen: { [chainId]: [medianE18, lastCloseE18] | null }, xnt: [medianE18, lastCloseE18] | null }
 *               (the same current-hour readings in the site's form; null = no candles: 'fallback' with "0", "0"),
 *     skipped: [chainId] (= the chains whose status is 'skipped'),
 *     chains: [{ chainId, name, portal, status: 'ok' | 'skipped' | 'quarantined' | 'sunset' (an orphaned chain, D-21),
 *                fromBlockExclusive?, toBlock?, market: { spotE18, refUsdE18 }, liquidityOnChainMicro?, poolCreatedAt?,
 *                liquiditySamples?: [{ hour, micro }] (D-13: the window's hourly readings so far),
 *                liquidityNowMicro, burns: [BurnInputV3], current: { hour, medianE18, lastCloseE18, priceSource },
 *                Lnow (= liquidityNowMicro), Lprev (epoch − 1's L, or null), capE18 (1.25 × ref), spotE18 (min(spot, cap)),
 *                S, hour, hourSpot (the curve after every burn of earlier hours, at `hour`, and Σ spot of the burns of
 *                the latest hour; with no burn yet: epoch − 1's curveAfter and 0),
 *                route?: { pool, xenReserveWei, quoteReserveMicro, feeBps, bridgeFeeMicro, bridgeMinMicro } }],
 *     xdex?: { pool, slot, wxntReserveLamports, usdcReserveMicro, feeBps }, switchRefs?, flags?: { anomalyHold, recoveryPending? },
 *     rulesBlock? (the hashed rules the epoch is built under: tie-break, backlog, operator wallets, dust; default when
 *     absent), engineSha256? }
 *   burns[] and the market fields are exactly what the oracle will record in epoch-<epoch>.json (rewards.ts BurnInputV3).
 *   The window's L is the one epoch − 1 froze at its build (its chains[].L.next; at the switch, the median of the
 *   chain's last (up to) 4 v2 liquidity readings, switchRefs, D-13): a chain whose L is set only at the weekly build (its first week with a reading, or a record written before
 *   D-13) gives no binding quote. route and xdex (the price pool's and the XDEX pool's reserves, written by the oracle
 *   every hour) are what the below-market check reads; without them for a chain the kit refuses unless allowBelowMarket.
 *   The kit values the raw part itself and refuses a feed whose duplicated or derived fields disagree with it
 *   (normalizeFeed, quoteBurn): a feed without raw burns, or that does not continue epoch − 1, gives no quote.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  allocateWindow, capOnDay, DAY, DEFAULT_RULES_V3, HOUR, operatorOfV3, quoteBurn as engineQuote, rulesBlockOf, uint, V3_FROM, xntPegV3,
} from './quote-v3.mjs';
import { accountDiscriminatorHex, accountFieldOffset, loadBundledIdl, PROGRAM_ID_B58 } from './idl.mjs';

export const XNT_LAMPORTS = 1_000_000_000n;
/** deployments/portals.json: the five immutable portals (same address on every chain; no owner, fee, pause or upgrade). */
export const PORTAL = '0x7b00f314aB48D223bee567181CA89c65126Bf6E9';
export const PORTALS = Object.freeze([
  { chain: 'Base', chainId: 8453, portal: PORTAL, xen: '0xffcbF84650cE02DaFE96926B37a0ac5E34932fa5' },
  { chain: 'Optimism', chainId: 10, portal: PORTAL, xen: '0xeB585163DEbB1E637c6D617de3bEF99347cd75c8' },
  { chain: 'Polygon', chainId: 137, portal: PORTAL, xen: '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e' },
  { chain: 'BSC', chainId: 56, portal: PORTAL, xen: '0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e' },
  { chain: 'Avalanche', chainId: 43114, portal: PORTAL, xen: '0xC0C5AA69Dbe4d6DDdfBc89c0957686ec60F24389' },
].map(Object.freeze));
export const portalFor = (chainId) => PORTALS.find((p) => p.chainId === Number(chainId)) ?? null;

/** The kit refuses a single burn whose payout would take more than this share of what is left of today's tranche. */
export const MAX_SHARE_OF_REMAINING_BPS = 5_000;
/** A feed older than this is stale (the writer runs hourly). */
export const FEED_MAX_AGE_SEC = 2 * HOUR;
/** The oracle publishes at least 6 days apart; beyond this since the last publication it is late. */
export const ORACLE_LATE_SEC = 8 * DAY;
/** Closer than this to the end of the hour, the burn may land in the next hour and be priced on that hour's candles. */
export const HOUR_EDGE_SEC = 180;

export const NOTICES = Object.freeze({
  consent: 'Burning XEN through a Moon Forge portal is irreversible: the XEN is destroyed on its chain and the payout is XNT on X1, '
    + 'credited to the X1 address you enter (never to the EVM wallet that burns), under the rules of the epoch the burn falls in. '
    + 'Moon Forge is not XEN Prime and is not run by the XEN or X1 teams. Only burns through these portals are counted.',
  etiquette: `${V3_FROM}, capacity opens in daily tranches counted from the previous epoch's publication time (UTC); `
    + 'scripted burns can take a tranche first. Spread your burns: the kit refuses one burn that takes more than half of what is left of today\'s tranche.',
  noQuoteToday: 'No binding quote exists before the v3 switch epoch (planned for November 2026, announced at least one full epoch ahead): '
    + 'the live v2 oracle pays an estimate, so the kit does not burn.',
});

// ─── X1 destination helpers ─────────────────────────────────────────────────
const RESERVED = new Set([
  '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'ComputeBudget111111111111111111111111111111',
  'AddressLookupTab1e1111111111111111111111111', 'Vote111111111111111111111111111111111111111', 'Stake11111111111111111111111111111111111111',
  'Config1111111111111111111111111111111111111', 'Ed25519SigVerify111111111111111111111111111', 'KeccakSecp256k11111111111111111111111111111',
  'NativeLoader1111111111111111111111111111111', 'BPFLoader1111111111111111111111111111111111', 'BPFLoader2111111111111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111', 'LoaderV411111111111111111111111111111111111', 'SysvarC1ock11111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111', 'SysvarS1otHashes111111111111111111111111111', 'SysvarS1otHistory11111111111111111111111111',
  'SysvarRecentB1ockHashes11111111111111111111', 'SysvarEpochSchedu1e111111111111111111111111', 'SysvarFees111111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111', 'SysvarStakeHistory1111111111111111111111111', '1nc1nerator11111111111111111111111111111111',
  '57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9', 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d', 'So11111111111111111111111111111111111111112',
]);

/**
 * Checks an X1 destination offline and returns { pubkey, b58, hex, last6 }. Refuses an EVM address, anything that is
 * not a canonical base58 32-byte key, the all-zero key, programs, sysvars and Moon Forge's own accounts, and (unless
 * allowOffCurve) an address off the ed25519 curve: a program-derived address can never sign, so a vesting mission
 * credited to it could never be withdrawn.
 */
export function checkX1Destination(x1, { allowOffCurve = false, reserved = [] } = {}) {
  const s = String(x1 ?? '').trim();
  if (/^0x/i.test(s)) throw new Error('that is an EVM address: the destination is your X1 (base58) address, where the XNT is paid');
  let pk;
  try { pk = new PublicKey(s); } catch { throw new Error('the destination is not a valid X1 (base58) address'); }
  const b58 = pk.toBase58();
  if (b58 !== s) throw new Error('the destination is not in canonical base58 form: copy it again from your X1 wallet');
  if (pk.toBuffer().every((b) => b === 0)) throw new Error('the destination is the all-zero key: XNT sent there is lost');
  if (RESERVED.has(b58) || reserved.includes(b58)) throw new Error(`the destination ${b58} is a program, sysvar or protocol account: it can never use XNT`);
  if (!allowOffCurve && !PublicKey.isOnCurve(pk.toBytes())) {
    throw new Error('the destination is not a wallet key (off the ed25519 curve, e.g. a program-derived address): it can never sign, so a vesting payout could never be withdrawn; pass allowOffCurve:true only if you know why');
  }
  return { pubkey: pk, b58, hex: x1ToBytes32(b58), last6: b58.slice(-6) };
}
/** Base58 X1 address → the 32-byte hex the portal records (0x + 64 hex). */
export function x1ToBytes32(x1) {
  const s = String(x1 ?? '').trim();
  if (/^0x/i.test(s)) throw new Error('that is an EVM address: pass the X1 (base58) address');
  return '0x' + new PublicKey(s).toBuffer().toString('hex');
}
/** The 32-byte hex of a MissionStarted event → the base58 X1 address. */
export function bytes32ToX1(hex) {
  const h = String(hex ?? '').replace(/^0x/i, '');
  if (!/^[0-9a-f]{64}$/i.test(h)) throw new Error('not a 32-byte hex value');
  return new PublicKey(Buffer.from(h, 'hex')).toBase58();
}
/** What to show before signing: the address, its bytes as the portal records them, and the last 6 characters to confirm. */
export const destinationPreview = (x1) => { const d = checkX1Destination(x1, { allowOffCurve: true }); return { x1: d.b58, hex: d.hex, last6: d.last6 }; };

/**
 * One read-only getAccountInfo on X1: 'new' (no account yet, a fresh wallet: normal), 'wallet' (System-owned),
 * 'executable' (a program: refused), 'owned' (owned by another program, e.g. a token account: refused unless
 * allowNonWallet), 'unknown' (the read failed).
 */
export async function inspectX1Destination(connection, x1) {
  try {
    const info = await connection.getAccountInfo(new PublicKey(x1), 'confirmed');
    if (!info) return { kind: 'new' };
    if (info.executable) return { kind: 'executable', owner: info.owner.toBase58() };
    if (info.owner.toBase58() === '11111111111111111111111111111111') return { kind: 'wallet' };
    return { kind: 'owned', owner: info.owner.toBase58() };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * The oracle's last publication time (Config.last_publish_ts, X1 unix s), read on X1. The layout is taken from the
 * bundled IDL (the same offset under the live and the upgraded program); a missing account, another owner or another
 * discriminator throws.
 */
export async function readLastPublishTs(connection) {
  const program = new PublicKey(PROGRAM_ID_B58);
  const config = PublicKey.findProgramAddressSync([Buffer.from('config')], program)[0];
  const info = await connection.getAccountInfo(config, 'confirmed');
  if (!info) throw new Error('the Moon Forge Config account is missing on this endpoint');
  if (!new PublicKey(info.owner).equals(program)) throw new Error('the Config account is not owned by the Moon Forge program');
  const idl = loadBundledIdl('live').idl;
  const off = accountFieldOffset(idl, 'Config', 'last_publish_ts');
  const d = Buffer.from(info.data);
  if (d.length < off + 8 || d.subarray(0, 8).toString('hex') !== accountDiscriminatorHex(idl, 'Config')) throw new Error('the Config account does not have the expected layout');
  return Number(d.readBigInt64LE(off));
}

// ─── EVM calldata (no EVM library needed) ────────────────────────────────────
const k256 = (s) => Buffer.from(keccak_256(new TextEncoder().encode(s)));
const selector = (sig) => k256(sig).subarray(0, 4).toString('hex');
export const SELECTORS = Object.freeze({
  approve: selector('approve(address,uint256)'),
  allowance: selector('allowance(address,address)'),
  balanceOf: selector('balanceOf(address)'),
  enterForge: selector('enterForge(uint256,uint8,bytes32)'),
});
export const MISSION_STARTED_TOPIC = '0x' + k256('MissionStarted(uint256,address,uint256,uint8,bytes32,uint256,uint256)').toString('hex');
const word = (hexNoPrefix) => hexNoPrefix.padStart(64, '0');
const addrWord = (a) => {
  const h = String(a).replace(/^0x/i, '');
  if (!/^[0-9a-f]{40}$/i.test(h)) throw new Error(`not an EVM address: ${a}`);
  return word(h.toLowerCase());
};
const uintWord = (n) => { const v = BigInt(n); if (v < 0n || v >= 2n ** 256n) throw new Error('uint256 out of range'); return word(v.toString(16)); };
export const encodeApprove = (spender, amount) => '0x' + SELECTORS.approve + addrWord(spender) + uintWord(amount);
export const encodeAllowance = (owner, spender) => '0x' + SELECTORS.allowance + addrWord(owner) + addrWord(spender);
export const encodeBalanceOf = (owner) => '0x' + SELECTORS.balanceOf + addrWord(owner);
export function encodeEnterForge(amountWei, tier, x1) {
  const t = Number(tier);
  if (!Number.isInteger(t) || t < 0 || t > 2) throw new Error('tier must be 0 (Launchpad), 1 (Orbit) or 2 (Moon Landing)');
  if (BigInt(amountWei) <= 0n) throw new Error('amount must be above 0');
  return '0x' + SELECTORS.enterForge + uintWord(amountWei) + uintWord(t) + x1ToBytes32(x1).slice(2);
}
const decodeUint = (hex) => BigInt('0x' + (String(hex).replace(/^0x/i, '') || '0'));
/** The MissionStarted event emitted by `portal` in a receipt (ethers v6 TransactionReceipt shape), or null. */
export function parseMissionStarted(receipt, portal = PORTAL) {
  for (const log of receipt?.logs ?? []) {
    if (String(log.address).toLowerCase() !== portal.toLowerCase()) continue;
    if (String(log.topics?.[0]).toLowerCase() !== MISSION_STARTED_TOPIC) continue;
    const d = String(log.data).replace(/^0x/i, '');
    if (d.length < 64 * 5) continue;
    const w = (i) => d.slice(i * 64, (i + 1) * 64);
    return {
      missionId: decodeUint(log.topics[1]), pilot: '0x' + String(log.topics[2]).slice(-40), amount: decodeUint(w(0)), tier: Number(decodeUint(w(1))),
      x1: bytes32ToX1(w(2)), chainId: Number(decodeUint(w(3))), timestamp: Number(decodeUint(w(4))),
    };
  }
  return null;
}

// ─── the week-so-far feed ────────────────────────────────────────────────────
const isU = (v) => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
/**
 * The feed (FEED CONTRACT v1) in the kit's working form, with every duplicated field checked against its twin:
 * returns { feed, problems }. prevDataHash stands in for a missing prevEpoch (epoch − 1), skipped[] marks its chains
 * 'skipped', readings stand in for missing `current` readings; when both forms are present they must agree. A chain
 * that is not skipped must carry its raw burns[], its market and its live liquidity: derived fields alone are not
 * enough to value a burn.
 */
export function normalizeFeed(feed) {
  const problems = [];
  if (!feed || typeof feed !== 'object') return { feed, problems: ['no week-so-far feed'] };
  const out = { ...feed };
  let prevEpoch = feed.prevEpoch ?? null;
  if (!prevEpoch && typeof feed.prevDataHash === 'string' && Number.isSafeInteger(feed.epoch)) prevEpoch = { epoch: feed.epoch - 1, dataHash: feed.prevDataHash };
  if (feed.prevEpoch && feed.prevDataHash !== undefined && feed.prevDataHash !== feed.prevEpoch.dataHash) problems.push('the feed names two different previous data hashes (prevDataHash, prevEpoch.dataHash)');
  if (Number.isSafeInteger(feed.epoch) && feed.epoch > 1) {
    if (!prevEpoch || !Number.isSafeInteger(prevEpoch.epoch) || typeof prevEpoch.dataHash !== 'string') problems.push('the feed names no previous epoch (prevEpoch)');
    else if (feed.epoch !== prevEpoch.epoch + 1) problems.push(`the feed does not continue its previous epoch (epoch ${feed.epoch} after epoch ${prevEpoch.epoch})`);
  }
  out.prevEpoch = prevEpoch;
  const skipped = new Set(Array.isArray(feed.skipped) ? feed.skipped.map(Number) : []);
  const readings = feed.readings && typeof feed.readings === 'object' ? feed.readings : null;
  const pairOf = (pair, what) => {
    if (pair === null) return { medianE18: '0', lastCloseE18: '0', source: 'fallback' };
    if (!Array.isArray(pair) || pair.length !== 2 || !isU(pair[0]) || !isU(pair[1])) { problems.push(`readings.${what} is not a [median, last close] pair`); return null; }
    return { medianE18: pair[0], lastCloseE18: pair[1], source: 'candles' };
  };
  if (Array.isArray(feed.chains)) {
    out.chains = feed.chains.map((c) => {
      const n = { ...c };
      const listed = skipped.has(Number(c.chainId));
      if (listed && c.status && c.status !== 'skipped') problems.push(`chain ${c.chainId} is in skipped[] but its status is ${c.status}`);
      if (!listed && c.status === 'skipped' && Array.isArray(feed.skipped)) problems.push(`chain ${c.chainId} is skipped but not in skipped[]`);
      n.status = listed ? 'skipped' : (c.status ?? 'ok');
      if (n.status !== 'skipped') {
        if (!Array.isArray(c.burns)) problems.push(`chain ${c.chainId} carries no raw burns[]: the window cannot be valued from derived fields`);
        if (!c.market || !isU(c.market.spotE18) || !isU(c.market.refUsdE18)) problems.push(`chain ${c.chainId} has no market (spotE18, refUsdE18)`);
        if (c.liquidityNowMicro === undefined && c.Lnow !== undefined) n.liquidityNowMicro = c.Lnow;
        else if (c.Lnow !== undefined && String(c.Lnow) !== String(c.liquidityNowMicro)) problems.push(`chain ${c.chainId}: Lnow and liquidityNowMicro differ`);
        if (!isU(String(n.liquidityNowMicro ?? ''))) problems.push(`chain ${c.chainId} has no live liquidity reading (liquidityNowMicro)`);
      }
      if (readings && readings.xen && Object.prototype.hasOwnProperty.call(readings.xen, String(c.chainId))) {
        const r = pairOf(readings.xen[String(c.chainId)], `xen.${c.chainId}`);
        if (r) {
          const cur = { hour: readings.hour, medianE18: r.medianE18, lastCloseE18: r.lastCloseE18, priceSource: r.source };
          if (!c.current) n.current = cur;
          else if (c.current.hour !== cur.hour || c.current.medianE18 !== cur.medianE18 || c.current.lastCloseE18 !== cur.lastCloseE18 || c.current.priceSource !== cur.priceSource) problems.push(`chain ${c.chainId}: readings and current disagree`);
        }
      }
      return n;
    });
    for (const id of skipped) if (!feed.chains.some((c) => Number(c.chainId) === id)) out.chains.push({ chainId: id, status: 'skipped' });
  }
  if (feed.xnt && typeof feed.xnt === 'object') {
    out.xnt = { ...feed.xnt };
    if (readings && Object.prototype.hasOwnProperty.call(readings, 'xnt')) {
      const r = pairOf(readings.xnt, 'xnt');
      if (r) {
        const cur = { hour: readings.hour, ...r };
        const x = feed.xnt.current;
        if (!x) out.xnt.current = cur;
        else if (x.hour !== cur.hour || x.medianE18 !== cur.medianE18 || x.lastCloseE18 !== cur.lastCloseE18 || x.source !== cur.source) problems.push('readings.xnt and xnt.current disagree');
      }
    }
    if (isU(feed.xnt.buildE18) && isU(feed.xnt.twapE18) && isU(feed.xnt.apiE18)) {
      // D-22 (c): a USDC.X premium above 3% raises the TWAP to the pool-safe price before the max
      const t = BigInt(feed.xnt.twapE18), a = BigInt(feed.xnt.apiE18);
      const f = BigInt(xntPegV3(t, a).factorE18);
      const tp = f === 10n ** 18n ? t : (t * f) / 10n ** 18n;
      if (BigInt(feed.xnt.buildE18) !== (tp > a ? tp : a)) problems.push('xnt.buildE18 is not max(twapE18 at the USDC.X factor, apiE18)');
    }
  }
  // the reserves the below-market check reads (the oracle writes them every hour): refused when present but malformed
  const fee = (v) => Number.isSafeInteger(v) && v >= 0 && v < 10_000;
  if (feed.xdex !== undefined && feed.xdex !== null && !(isU(feed.xdex.wxntReserveLamports) && isU(feed.xdex.usdcReserveMicro) && fee(feed.xdex.feeBps ?? 30))) problems.push('xdex is not { wxntReserveLamports, usdcReserveMicro, feeBps }');
  for (const c of Array.isArray(feed.chains) ? feed.chains : []) {
    const r = c?.route;
    if (r === undefined || r === null) continue;
    if (!(isU(r.xenReserveWei) && isU(r.quoteReserveMicro) && fee(r.feeBps ?? 30) && isU(String(r.bridgeFeeMicro ?? '0')) && isU(String(r.bridgeMinMicro ?? '0')))) problems.push(`chain ${c.chainId}: route is not { xenReserveWei, quoteReserveMicro, feeBps, bridgeFeeMicro, bridgeMinMicro }`);
  }
  // the rules block the epoch is built under (T2-RULES): one this kit implements, or the feed gives no quote
  if (feed.rulesBlock !== undefined) {
    try { rulesBlockOf(feed.rulesBlock); } catch (e) { problems.push(`the feed's rules block is not one this kit implements (${String(e?.message ?? e).slice(0, 160)})`); }
  }
  return { feed: out, problems };
}

/** Problems of a week-so-far feed (an empty list = usable), checked at `now` (X1 unix seconds). */
export function feedProblems(feed, { now = Math.floor(Date.now() / 1000), maxAgeSec = FEED_MAX_AGE_SEC } = {}) {
  if (!feed || typeof feed !== 'object') return ['no week-so-far feed'];
  const p = [...normalizeFeed(feed).problems];
  if (feed.kind !== 'week-so-far' || feed.version !== 1) p.push(`not a week-so-far feed v1 (kind ${feed.kind}, version ${feed.version})`);
  if (feed.programId !== '57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9') p.push('the feed is for another program');
  if (feed.rules !== 3) p.push(`the feed is for rules ${feed.rules}: a binding quote exists only under the v3 rules`);
  if (!Number.isSafeInteger(feed.asOf)) p.push('the feed has no asOf time');
  else if (now - feed.asOf > maxAgeSec) p.push(`the feed is ${Math.round((now - feed.asOf) / 60)} min old (more than ${maxAgeSec / 60} min): stale`);
  else if (feed.asOf - now > 15 * 60) p.push('the feed is dated in the future');
  if (!Number.isSafeInteger(feed.window?.startTs)) p.push('the feed has no window start');
  if (!Array.isArray(feed.chains) || !feed.chains.length) p.push('the feed lists no chain');
  if (!feed.freePool || typeof feed.freePool.open !== 'string') p.push('the feed has no F_ref (freePool.open)');
  return p;
}
/** The engine inputs of the window so far (rewards.ts EpochInputsV3 shape), from the feed's usable chains. */
export function feedInputs(raw) {
  const feed = normalizeFeed(raw).feed;
  return {
    // the window so far ends at the feed's asOf (oracle feed-v3.ts feedInputsV3)
    programId: feed.programId, epoch: feed.epoch, window: { startTs: feed.window.startTs, ...(Number.isSafeInteger(feed.asOf) ? { endTs: feed.asOf } : {}) },
    freePool: { open: feed.freePool.open }, xnt: { twapE18: feed.xnt.twapE18, apiE18: feed.xnt.apiE18 },
    // a skipped chain has no market this week; a quarantined or sunset chain is still valued (its quote needs allowStaleOracle)
    chains: feed.chains.filter((c) => (c.status ?? 'ok') !== 'skipped').map((c) => ({
      chainId: c.chainId, name: c.name, portal: c.portal, market: c.market, liquidityNowMicro: c.liquidityNowMicro, burns: c.burns ?? [],
      // D-21: a sunset chain is an orphaned one, valued at the orphan price; D-13: the window's samples, as the build records them
      ...(c.status === 'sunset' ? { orphan: true } : {}),
      ...(c.liquidityOnChainMicro !== undefined ? { liquidityOnChainMicro: c.liquidityOnChainMicro } : {}),
      ...(c.liquiditySamples !== undefined ? { liquiditySamples: c.liquiditySamples } : {}),
      ...(c.poolCreatedAt !== undefined ? { poolCreatedAt: c.poolCreatedAt } : {}),
    })),
    switchRefs: feed.switchRefs ?? null,
    ...(feed.rulesBlock !== undefined ? { rulesBlock: feed.rulesBlock } : {}),
  };
}

// ─── the market route (A4 b): sell the XEN now, bridge, buy XNT ────────────────
const cpOut = (reserveIn, reserveOut, amountIn, feeBps) => {
  const inAfter = (BigInt(amountIn) * (10_000n - BigInt(feeBps))) / 10_000n;
  const rin = BigInt(reserveIn), rout = BigInt(reserveOut);
  return rin + inAfter === 0n ? 0n : (rout * inAfter) / (rin + inAfter);
};
/**
 * Lamports the XEN would fetch on the market right now: a single sale into the chain's deepest pool (constant product,
 * live reserves and fee), the bridge fee and minimum, then XNT bought on the XDEX pool. Null when the feed carries no
 * route data for the chain (then the kit cannot compare and refuses unless allowBelowMarket).
 */
export function marketRouteLamports(amountWei, route, xdex) {
  if (!route || !xdex) return null;
  const ok = (v) => (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)) || typeof v === 'bigint' || (Number.isSafeInteger(v) && v >= 0);
  if (![route.xenReserveWei, route.quoteReserveMicro, xdex.usdcReserveMicro, xdex.wxntReserveLamports].every(ok)) return null;
  const usd = cpOut(route.xenReserveWei, route.quoteReserveMicro, amountWei, route.feeBps ?? 30);
  const afterBridge = usd > BigInt(route.bridgeFeeMicro ?? 0) ? usd - BigInt(route.bridgeFeeMicro ?? 0) : 0n;
  if (afterBridge < BigInt(route.bridgeMinMicro ?? 0)) return 0n;
  return cpOut(xdex.usdcReserveMicro, xdex.wxntReserveLamports, afterBridge, xdex.feeBps ?? 30);
}

// ─── the quote with every refusal ────────────────────────────────────────────
const xnt = (l) => Number(l) / 1e9;
const refusal = (code, text, override = null) => ({ code, text, override });

/**
 * The binding quote of one burn and the reasons the kit would refuse it. Never throws for a refusal: read
 * `refusals` (each { code, text, override }: the option that accepts it, or null when nothing can).
 * Inputs: feed (week-so-far v1), prev (epoch file n − 1), chainId, amountWei, tier, x1, now (X1 unix s; default the
 * clock), oracle { lastPublishTs } (from MoonForge.status().oracle) and the overrides
 * { allowBelowMarket, allowBeyondCapacity, allowStaleOracle, allowVesting, allowLargeShare, allowHourEdge, marketRouteLamports }.
 */
export function quoteBurn({ feed, prev, chainId, amountWei, tier = 0, x1, now = Math.floor(Date.now() / 1000), oracle = null, ...opts }) {
  const refusals = [];
  const warnings = [];
  const out = { ok: false, chainId: Number(chainId), tier: Number(tier), amountWei: String(amountWei), refusals, warnings, notices: [NOTICES.consent, NOTICES.etiquette] };
  const fail = (code, text, override = null) => { refusals.push(refusal(code, text, override)); };
  let amount;
  try { amount = BigInt(amountWei); } catch { amount = 0n; }
  if (amount <= 0n) fail('amount', 'the amount must be above 0 (XEN in wei, 18 decimals)');
  if (![0, 1, 2].includes(Number(tier))) fail('tier', 'tier must be 0 (Launchpad), 1 (Orbit, 45-day vesting) or 2 (Moon Landing, 180-day vesting)');
  const portal = portalFor(chainId);
  if (!portal) fail('chain', `chain ${chainId} has no Moon Forge portal (Base 8453, Optimism 10, Polygon 137, BSC 56, Avalanche 43114)`);
  let dest = null;
  try { dest = checkX1Destination(x1, { allowOffCurve: !!opts.allowOffCurve }); } catch (e) { fail('destination', e.message, /off the ed25519 curve/.test(e.message) ? 'allowOffCurve' : null); }
  const fp = feedProblems(feed, { now });
  if (fp.length) {
    fail('noQuote', `${fp.join('; ')}. ${feed?.rules === 3 ? 'No quote: the kit fails closed.' : NOTICES.noQuoteToday}`);
    return out;
  }
  feed = normalizeFeed(feed).feed;
  if (!prev && feed.epoch > 1) fail('noQuote', `the previous epoch file (epoch-${feed.epoch - 1}.json) is required: the curve memory, the liquidity clamp and the XNT floor come from it`);
  else if (prev && (prev.epoch !== feed.prevEpoch?.epoch || prev.dataHash !== feed.prevEpoch?.dataHash)) fail('noQuote', `the previous epoch file (${prev.epoch}, ${String(prev.dataHash).slice(0, 8)}…) is not the one the feed continues (${feed.prevEpoch?.epoch}, ${String(feed.prevEpoch?.dataHash).slice(0, 8)}…)`);
  // the candidate is ranked at `now`: every burn already in the feed must be earlier, or the quote would rank this burn
  // before burns that are already in (and the oracle, which ranks by block time, would not pay it that number)
  const latestBurn = Math.max(feed.asOf, ...feed.chains.flatMap((c) => (c.burns ?? []).map((b) => Number(b.timestamp))));
  if (now < feed.window.startTs) fail('noQuote', `this machine's clock (${new Date(now * 1000).toISOString()}) is before the window start (${new Date(feed.window.startTs * 1000).toISOString()}): no quote`);
  else if (now < latestBurn) fail('noQuote', `this machine's clock (${new Date(now * 1000).toISOString()}) is behind the feed (a burn or the feed at ${new Date(latestBurn * 1000).toISOString()}): no quote until the clock is right (pass now: the X1 time)`);
  const chain = feed.chains.find((c) => c.chainId === Number(chainId));
  const status = chain?.status ?? (chain ? 'ok' : 'missing');
  if (status === 'missing') fail('noQuote', `the feed has no market for chain ${chainId} this week: no quote`);
  else if (status === 'skipped') fail('noQuote', `chain ${chainId} was skipped this week (no eligible market or data): its burns wait as backlog and rank after this week's burns, so no quote is given`);
  else if (status === 'quarantined') fail('chainStatus', `chain ${chainId} is quarantined: burns there may not be valued this week`, 'allowStaleOracle');
  else if (status === 'sunset') fail('chainStatus', `chain ${chainId} is sunset (orphaned: no eligible market for 4 epochs in a row; its burns are valued at half the reference price it had then, D-21)`, 'allowStaleOracle');
  const hourNow = Math.floor(now / HOUR);
  const cur = chain?.current, xcur = feed.xnt?.current;
  // every valued chain (ok, quarantined) is priced on the current hour's readings, never on a stale hour's; a sunset
  // chain has no XEN market (its burns take the orphan price), so only its XNT readings are needed
  const xenOk = status === 'sunset' || (cur && cur.hour === hourNow);
  if ((status === 'ok' || status === 'quarantined' || status === 'sunset') && (!xenOk || !xcur || xcur.hour !== hourNow)) fail('noQuote', `the feed carries no price readings for the current hour (${new Date(hourNow * HOUR * 1000).toISOString().slice(0, 13)}:00 UTC): wait for its next hourly update`);
  else if ((hourNow + 1) * HOUR - now < HOUR_EDGE_SEC) fail('hourEdge', `the hour ends in ${(hourNow + 1) * HOUR - now} s: the burn may be priced on the next hour's candles`, 'allowHourEdge');
  // the oracle's last publication: the chain's reading when given (burnXen reads it on X1), else the feed's window start
  // (epoch n − 1's published_at): the late-oracle refusal never depends on an optional argument
  const lastPub = Number(oracle?.lastPublishTs ?? feed.window.startTs);
  if (!Number.isFinite(lastPub) || now - lastPub > ORACLE_LATE_SEC) fail('staleOracle', `the oracle last published ${Number.isFinite(lastPub) ? ((now - lastPub) / DAY).toFixed(1) : '?'} days ago (more than 8)${oracle?.lastPublishTs ? '' : ', by the feed\'s window start'}: payouts may be late or paused`, 'allowStaleOracle');
  if (feed.flags?.recoveryPending) fail('staleOracle', 'an oracle-seat recovery or void is pending: the next epoch may be voided or delayed', 'allowStaleOracle');
  if (feed.flags?.anomalyHold) fail('staleOracle', 'the oracle holds the epoch under its anomaly gate (up to 24 h)', 'allowStaleOracle');
  if (Number(tier) > 0) fail('vesting', 'a vesting burn locks the part of it that fits today at its full multiplier, for 45 or 180 days; the rest of its Launchpad layer can only come from the leftover; if nothing fits, or what fits is under 0.02 XNT, it is paid as Launchpad. Pass allowVesting:true to burn on a vesting tier', 'allowVesting');
  // D-18: a burn of an operator wallet (outside a dated, published exception) claims after every other burn of the week
  if (dest) {
    let ow = DEFAULT_RULES_V3.operatorWallets;
    try { ow = rulesBlockOf(feed.rulesBlock ?? DEFAULT_RULES_V3).operatorWallets; } catch { /* refused by feedProblems already */ }
    if (operatorOfV3(ow, dest.b58, now).operator) fail('operatorWallet', `${dest.b58} is listed as an operator wallet in the epoch's rules block: its burns rank after every other burn of the week (D-18), so no binding quote can be given`);
  }
  if (refusals.some((r) => r.code === 'noQuote' || r.code === 'amount' || r.code === 'tier' || r.code === 'chain' || r.code === 'operatorWallet' || (r.code === 'destination' && !r.override))) return out;
  const inputs = feedInputs(feed);
  // the derived fields other clients read (the website) must be what the raw window gives, or one of the two is wrong:
  // checked against the engine over the window as the feed states it (without this burn)
  if (feed.capacity || chain.capE18 !== undefined || chain.Lprev !== undefined) {
    let w;
    try { w = allocateWindow(prev, inputs, { applyLimit: false }); } catch (e) {
      fail('noQuote', `the feed's window could not be valued (${String(e?.message ?? e).slice(0, 200)}): no quote`);
      return out;
    }
    const mismatch = [];
    const ch = w.chains.get(Number(chainId));
    if (feed.capacity) {
      const cash = isU(feed.capacity.cash) ? BigInt(feed.capacity.cash) : null;
      const senior = isU(feed.capacity.senior) ? BigInt(feed.capacity.senior) : null;
      if (cash !== w.C) mismatch.push(`capacity.cash ${feed.capacity.cash} vs C ${w.C}`);
      if (senior !== w.capacity.seniorAhead) mismatch.push(`capacity.senior ${feed.capacity.senior} vs ${w.capacity.seniorAhead}`);
    }
    if (ch && chain.capE18 !== undefined && String(chain.capE18) !== String(ch.priceCapE18)) mismatch.push(`chain ${chainId} capE18 ${chain.capE18} vs ${ch.priceCapE18}`);
    if (ch && chain.Lprev !== undefined && (chain.Lprev === null ? null : String(chain.Lprev)) !== (ch.Lprev === null ? null : String(ch.Lprev))) mismatch.push(`chain ${chainId} Lprev ${chain.Lprev} vs ${ch.Lprev}`);
    if (isU(feed.xnt?.floorE18) && BigInt(feed.xnt.floorE18) !== w.xFloor) mismatch.push(`xnt.floorE18 ${feed.xnt.floorE18} vs ${w.xFloor}`);
    if (mismatch.length) {
      fail('noQuote', `the feed's derived fields disagree with its raw window (${mismatch.join('; ')}): the feed is inconsistent, no quote`);
      return out;
    }
  }
  let q;
  try {
    const xen = status === 'sunset' ? { medianE18: '0', lastCloseE18: '0', priceSource: 'orphan' } : { medianE18: cur.medianE18, lastCloseE18: cur.lastCloseE18, priceSource: cur.priceSource };
    q = engineQuote(prev, inputs, {
      chainId: Number(chainId), amountWei: amount, tier: Number(tier), x1: dest?.b58 ?? String(x1), timestamp: now,
      ...xen, xntMedianE18: xcur.medianE18, xntLastCloseE18: xcur.lastCloseE18, xntSource: xcur.source,
    });
  } catch (e) {
    fail('noQuote', `the quote could not be computed (${String(e?.message ?? e).slice(0, 200)}): no quote`);
    return out;
  }
  // D-13: binding only when the window's L was known before the build (frozen at epoch − 1's build, or the switch reading)
  if (!q.chain.Lbinding) {
    fail('noQuote', `chain ${chainId}'s liquidity for this week is set only at the weekly build (rule "${q.chain.Lrule}": its first week with a reading under the v3 rules, or a record written before the frozen-liquidity rule), so no binding quote can be given this week`);
    return out;
  }
  if (q.rankClass !== 0) {
    fail('operatorWallet', 'this burn would rank after the window\'s burns (an operator wallet, D-18): no binding quote');
    return out;
  }
  const route = opts.marketRouteLamports !== undefined && opts.marketRouteLamports !== null ? BigInt(opts.marketRouteLamports) : marketRouteLamports(amount, chain.route, feed.xdex);
  const remaining = q.capacity.roomBefore;
  Object.assign(out, {
    epoch: feed.epoch,
    bindingNow: q.bindingNow, bindingNowXnt: xnt(q.bindingNow), leftoverMaybe: q.leftoverMaybe, leftoverMaybeXnt: xnt(q.leftoverMaybe),
    notPaid: q.notPaid, notPaidXnt: xnt(q.notPaid), entitlement: q.entitlement, entitlementXnt: xnt(q.entitlement),
    mission: Number(tier) > 0 ? { lockedLp: q.lockedLp, bandLocked: q.bandLocked, launchpadNow: q.launchpadNow, converted: q.converted, leafTier: q.leafTier, lockDays: [0, 45, 180][Number(tier)] } : null,
    marketRoute: route, marketRouteXnt: route === null ? null : xnt(route),
    valueMicro: q.valueMicro, spotMicro: q.spotMicro, priceE18: q.priceE18, priceRule: q.priceRule, xntE18: q.xntE18, xntRule: q.xntRule,
    tranche: {
      C: q.capacity.C, CXnt: xnt(q.capacity.C), dailyXnt: xnt(q.capacity.tranche), day: q.capacity.day,
      opensAt: new Date((feed.window.startTs + q.capacity.day * DAY) * 1000).toISOString(),
      nextOpensAt: q.capacity.day < 6 ? new Date((feed.window.startTs + (q.capacity.day + 1) * DAY) * 1000).toISOString() : null,
      remainingToday: remaining, remainingTodayXnt: xnt(remaining), capTodayXnt: xnt(q.capacity.capToday),
    },
    atMost: q.upperBound, sameHourBurns: q.sameHour,
  });
  if (q.upperBound) warnings.push(`${q.sameHour} other burn(s) on this chain in the same hour share its curve pot: the number is "at most" until the hour closes`);
  if (!q.fitsWhole) fail('beyondCapacity', `today's remaining capacity (${xnt(remaining).toFixed(6)} XNT) does not cover this burn: ${xnt(q.bindingNow).toFixed(6)} of ${xnt(q.entitlement).toFixed(6)} XNT is paid at arrival; the rest is ${q.leftoverMaybe > 0n ? 'paid only if the week\'s leftover reaches it (not promised), the remainder ' : ''}not paid`, 'allowBeyondCapacity');
  if (remaining > 0n && q.entitlement * 10_000n > remaining * BigInt(MAX_SHARE_OF_REMAINING_BPS)) fail('largeShare', `this burn would take more than half of what is left of today's tranche (${xnt(remaining).toFixed(6)} XNT): split it (planBurns) or pass allowLargeShare:true`, 'allowLargeShare');
  if (route === null) fail('belowMarket', 'the market route of this XEN is unknown (the feed carries no pool reserves for this chain): the kit cannot check that the burn pays at least what selling would', 'allowBelowMarket');
  else if (q.bindingNow < route) fail('belowMarket', `selling the XEN now would fetch about ${xnt(route).toFixed(6)} XNT, more than the ${xnt(q.bindingNow).toFixed(6)} XNT this burn is paid at arrival (the chain's curve recovers over the next days)`, 'allowBelowMarket');
  const blocking = refusals.filter((r) => !r.override || !opts[r.override]);
  out.refusals = blocking;
  out.accepted = refusals.filter((r) => r.override && opts[r.override]);
  out.ok = blocking.length === 0;
  return out;
}

/**
 * Pacing planner: splits `amountWei` into burns that each fit what the kit accepts (fully paid at arrival, at most half of
 * the remaining tranche) on today's tranche and the next days' tranches, simulated in order (each planned burn joins the
 * window, so the curve memory of the chain is counted). Only the first piece of today is binding; later pieces are
 * estimates at today's prices that assume nobody else burns first. Returns { pieces: [{ at, amountWei, xnt, binding }], rest }.
 */
export function planBurns({ feed, prev, chainId, amountWei, tier = 0, x1, now = Math.floor(Date.now() / 1000), maxShareBps = MAX_SHARE_OF_REMAINING_BPS, maxPieces = 24 }) {
  const fp = feedProblems(feed, { now });
  if (fp.length) return { pieces: [], rest: String(amountWei), refused: fp };
  // the simulation works on the raw window only: the derived twins (readings, capacity, per-chain curve state) would
  // stop matching as soon as a planned piece joins it
  const { readings: _r, capacity: _c, skipped: _s, prevDataHash: _p, ...norm } = normalizeFeed(feed).feed;
  norm.chains = norm.chains.map(({ Lnow: _a, Lprev: _b, capE18: _d, spotE18: _e, S: _f, hour: _g, hourSpot: _h, ...c }) => c);
  const chain = norm.chains.find((c) => c.chainId === Number(chainId));
  if (!chain || (chain.status ?? 'ok') !== 'ok') return { pieces: [], rest: String(amountWei), refused: [`chain ${chainId} has no usable market this week`] };
  let left = BigInt(amountWei);
  const pieces = [];
  let sim = JSON.parse(JSON.stringify(norm));
  const dayNow = Math.max(0, Math.floor((now - feed.window.startTs) / DAY));
  for (let d = dayNow; d < 7 && left > 0n && pieces.length < maxPieces; d++) {
    for (let k = 0; k < 4 && left > 0n && pieces.length < maxPieces; k++) {
      // one piece per hour: pieces in the same chain-hour would share (and lower) that hour's curve pot
      const at = (d === dayNow ? now : feed.window.startTs + d * DAY + 60) + k * HOUR;
      const fits = (a) => {
        const q = quoteBurn({ feed: { ...sim, asOf: at, chains: sim.chains.map((c) => ({ ...c, current: { ...c.current, hour: Math.floor(at / HOUR) } })), xnt: { ...sim.xnt, current: { ...sim.xnt.current, hour: Math.floor(at / HOUR) } } },
          prev, chainId, amountWei: a, tier, x1, now: at, allowBelowMarket: true, allowVesting: true, allowHourEdge: true, allowStaleOracle: true });
        return q.bindingNow !== undefined && q.refusals.length === 0 && (q.tranche.remainingToday === 0n || q.entitlement * 10_000n <= q.tranche.remainingToday * BigInt(maxShareBps)) ? q : null;
      };
      if (!fits(1n)) break;
      let lo = 1n, hi = left, best = fits(left) ? left : null;
      if (!best) {
        while (hi - lo > 1n) { const mid = (lo + hi) / 2n; if (fits(mid)) lo = mid; else hi = mid; }
        best = lo;
      }
      const q = fits(best);
      if (!q || q.bindingNow === 0n) break;
      pieces.push({ at: new Date(at * 1000).toISOString(), amountWei: best.toString(), xnt: q.bindingNowXnt, binding: d === dayNow && pieces.length === 0 });
      left -= best;
      const c = sim.chains.find((x) => x.chainId === Number(chainId));
      c.burns = [...(c.burns ?? []), {
        // a planned piece has no transaction yet: a placeholder hash (D-14 orders same-second burns by it)
        chainId: Number(chainId), txHash: `0x${'f'.repeat(56)}${pieces.length.toString(16).padStart(8, '0')}`, logIndex: pieces.length, blockNumber: Number.MAX_SAFE_INTEGER - 100 + pieces.length, missionId: '0', pilot: '0x',
        amountWei: best.toString(), tier: Number(tier), x1, timestamp: at,
        medianE18: c.current.medianE18, lastCloseE18: c.current.lastCloseE18, priceSource: c.current.priceSource,
        xntMedianE18: sim.xnt.current.medianE18, xntLastCloseE18: sim.xnt.current.lastCloseE18, xntSource: sim.xnt.current.source,
      }];
      sim = { ...sim };
    }
  }
  return { pieces, rest: left.toString(), note: 'Only the first piece of today is binding; later pieces are estimates at today\'s prices that assume nobody else takes the tranche first.' };
}

// ─── the burn itself ─────────────────────────────────────────────────────────
export class BurnRefused extends Error {
  constructor(refusals, quote) {
    super(`burn refused: ${refusals.map((r) => `${r.text}${r.override ? ` (${r.override})` : ''}`).join('; ')}`);
    this.name = 'BurnRefused';
    this.refusals = refusals;
    this.quote = quote;
  }
}
const lower = (a) => String(a).toLowerCase();
/** Waits for an EVM transaction, handling ethers v6 TRANSACTION_REPLACED: { receipt, replaced: null | { reason, hash } }. */
export async function waitEvm(tx, confirmations = 1) {
  try {
    const receipt = await tx.wait(confirmations);
    return { receipt, replaced: null };
  } catch (e) {
    if (e?.code === 'TRANSACTION_REPLACED') {
      const reason = e.reason ?? (e.cancelled ? 'cancelled' : 'replaced');
      return { receipt: reason === 'cancelled' ? null : (e.receipt ?? null), replaced: { reason, hash: e.replacement?.hash ?? e.receipt?.hash ?? null } };
    }
    if (e?.code === 'CALL_EXCEPTION' && e.receipt) return { receipt: e.receipt, replaced: null };
    throw e;
  }
}

/**
 * Burns `amountWei` XEN on `chainId` for the X1 address `x1`, with the quote and every refusal checked before the
 * approval and again (with a fresh feed) right before enterForge. The approval is for the exact amount, never unlimited.
 * Options: signer (ethers v6 Signer on that chain), confirmLast6 (the last 6 characters of x1, typed by the principal),
 * getFeed() (returns the latest week-so-far feed) or feed, prev (epoch file n − 1), x1Connection (required: an X1
 * Connection, e.g. mf.connection; the destination is checked and the oracle's last publication is read on it, so a
 * caller-given `oracle` is never trusted over the chain), confirmations, requoteToleranceBps (default 0: a lower second
 * quote stops the burn), onStep(step, info), and the quote overrides of quoteBurn().
 * Returns { burned, txHash, missionId, quote, replaced, approveTx }; burned:false with a reason when the burn
 * transaction was cancelled or reverted. Throws BurnRefused before anything is signed when a refusal applies.
 */
export async function burnXen({ signer, chainId, amountWei, tier = 0, x1, confirmLast6, feed, getFeed, prev, x1Connection, oracle, confirmations = 1, requoteToleranceBps = 0, onStep = () => {}, now: nowFn, allowNonWallet = false, ...opts }) {
  if (!signer?.provider || typeof signer.sendTransaction !== 'function') throw new Error('burnXen: pass an ethers v6 Signer connected to the burn chain (signer.provider)');
  const clock = typeof nowFn === 'function' ? nowFn : () => Math.floor(Date.now() / 1000);
  const fetchFeed = async () => (getFeed ? getFeed() : feed);
  const dest = checkX1Destination(x1, { allowOffCurve: !!opts.allowOffCurve });
  if (String(confirmLast6 ?? '') !== dest.last6) {
    throw new BurnRefused([refusal('destination', `confirm the destination by passing confirmLast6: "${dest.last6}" (the last 6 characters of ${dest.b58}); the XNT is paid to this X1 address and nowhere else`)], null);
  }
  // X1 is read for two refusals that must never be skipped: the destination is a wallet, and the oracle is not late
  if (!x1Connection || typeof x1Connection.getAccountInfo !== 'function') {
    throw new BurnRefused([refusal('destination', 'pass x1Connection (e.g. mf.connection) so the destination and the oracle can be checked on X1: nothing was signed')], null);
  }
  const kind = await inspectX1Destination(x1Connection, dest.b58);
  if (kind.kind === 'unknown') throw new BurnRefused([refusal('destination', `${dest.b58} could not be checked on X1 (the read failed): nothing was signed; retry`)], null);
  if (kind.kind === 'executable') throw new BurnRefused([refusal('destination', `${dest.b58} is a program on X1: it can never use XNT`)], null);
  if (kind.kind === 'owned' && !allowNonWallet) throw new BurnRefused([refusal('destination', `${dest.b58} is an account owned by ${kind.owner} (not a wallet, e.g. a token account): pass allowNonWallet:true only if you know why`, 'allowNonWallet')], null);
  let oracleOnX1;
  try { oracleOnX1 = { lastPublishTs: await readLastPublishTs(x1Connection) }; } catch (e) {
    throw new BurnRefused([refusal('staleOracle', `the oracle's last publication could not be read on X1 (${String(e?.message ?? e).slice(0, 120)}): nothing was signed; retry`)], null);
  }
  if (oracle?.lastPublishTs !== undefined && Number(oracle.lastPublishTs) !== oracleOnX1.lastPublishTs) onStep('oracle', { given: Number(oracle.lastPublishTs), onX1: oracleOnX1.lastPublishTs, used: 'onX1' });
  oracle = oracleOnX1;
  const portal = portalFor(chainId);
  if (!portal) throw new BurnRefused([refusal('chain', `chain ${chainId} has no Moon Forge portal`)], null);
  const net = await signer.provider.getNetwork();
  if (Number(net.chainId) !== portal.chainId) throw new BurnRefused([refusal('chain', `the signer is on chain ${net.chainId}, not ${portal.chain} (${portal.chainId})`)], null);
  const q1 = quoteBurn({ feed: await fetchFeed(), prev, chainId, amountWei, tier, x1: dest.b58, now: clock(), oracle, ...opts });
  if (!q1.ok) throw new BurnRefused(q1.refusals, q1);
  onStep('quote', q1);
  const owner = await signer.getAddress();
  const balance = decodeUint(await signer.provider.call({ to: portal.xen, data: encodeBalanceOf(owner) }));
  if (balance < BigInt(amountWei)) throw new BurnRefused([refusal('balance', `the wallet holds ${balance} XEN wei on ${portal.chain}, less than ${amountWei}`)], q1);
  let approveTx = null;
  const allowance = decodeUint(await signer.provider.call({ to: portal.xen, data: encodeAllowance(owner, portal.portal) }));
  if (allowance < BigInt(amountWei)) {
    onStep('approve', { amountWei: String(amountWei) });
    const tx = await signer.sendTransaction({ to: portal.xen, data: encodeApprove(portal.portal, amountWei) });
    approveTx = tx.hash;
    const w = await waitEvm(tx, confirmations);
    if (!w.receipt || Number(w.receipt.status) !== 1) {
      return { burned: false, reason: w.replaced ? `the approval was ${w.replaced.reason}` : 'the approval reverted', approveTx, replaced: w.replaced, quote: q1 };
    }
  }
  // re-quote right before enterForge (the approval may have taken minutes): same refusals, and never a lower number
  const q2 = quoteBurn({ feed: await fetchFeed(), prev, chainId, amountWei, tier, x1: dest.b58, now: clock(), oracle, ...opts });
  if (!q2.ok) throw new BurnRefused(q2.refusals, q2);
  if (q2.bindingNow * 10_000n < q1.bindingNow * BigInt(10_000 - requoteToleranceBps)) {
    throw new BurnRefused([refusal('requote', `the quote dropped from ${q1.bindingNowXnt} to ${q2.bindingNowXnt} XNT while approving: nothing was burned (the approval stays; burn again to accept the new quote)`)], q2);
  }
  onStep('burn', q2);
  const tx = await signer.sendTransaction({ to: portal.portal, data: encodeEnterForge(amountWei, tier, dest.b58) });
  onStep('sent', { hash: tx.hash });
  const w = await waitEvm(tx, confirmations);
  if (!w.receipt) return { burned: false, reason: `the burn transaction was ${w.replaced?.reason ?? 'dropped'} (nothing was burned by it)`, txHash: tx.hash, replaced: w.replaced, approveTx, quote: q2 };
  if (Number(w.receipt.status) !== 1) return { burned: false, reason: 'the burn transaction reverted (nothing was burned)', txHash: w.receipt.hash ?? tx.hash, replaced: w.replaced, approveTx, quote: q2 };
  const ev = parseMissionStarted(w.receipt, portal.portal);
  if (!ev) return { burned: false, reason: `transaction ${w.receipt.hash ?? tx.hash} has no MissionStarted event of the portal${w.replaced ? ` (it ${w.replaced.reason} the burn)` : ''}`, txHash: w.receipt.hash ?? tx.hash, replaced: w.replaced, approveTx, quote: q2 };
  if (ev.x1 !== dest.b58 || ev.amount !== BigInt(amountWei) || ev.tier !== Number(tier) || lower(ev.pilot) !== lower(owner)) {
    return { burned: true, warning: 'the recorded mission differs from the request (destination, amount, tier or wallet): check it on the explorer', mission: ev, txHash: w.receipt.hash ?? tx.hash, replaced: w.replaced, approveTx, quote: q2 };
  }
  return { burned: true, txHash: w.receipt.hash ?? tx.hash, missionId: ev.missionId, mission: ev, replaced: w.replaced, approveTx, quote: q2 };
}

/** Fetches a week-so-far feed over HTTPS (an explicit opt-in: the kit fetches nothing unless you call this). */
export async function fetchWeekFeed(url, { fetchImpl = globalThis.fetch, maxBytes = 8_000_000 } = {}) {
  if (!/^https:\/\//.test(String(url))) throw new Error('fetchWeekFeed: an https:// URL is required');
  const r = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`fetchWeekFeed: HTTP ${r.status}`);
  const text = await r.text();
  if (text.length > maxBytes) throw new Error('fetchWeekFeed: the feed is larger than expected');
  return JSON.parse(text);
}

/** bs58 re-export for callers that format destinations. */
export { bs58, capOnDay, uint };
