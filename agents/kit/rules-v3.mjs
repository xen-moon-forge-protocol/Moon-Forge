/**
 * The final-upgrade (rules 3) program rules the kit mirrors: constants, Artifact pricing (PX), the market split, the
 * house keeper's hash chain (bet packing, anchoring, rolls), the sealed Duel / Moon Wars commitments, and a reader of
 * the Metaplex Core asset layout (owner, TransferDelegate authority). Pure functions, no network.
 *
 * Every constant is the MAINNET value of programs/moon-forge/src/constants.rs on the upgrade branch; the unit test
 * test/unit/rules-v3.test.mjs parses constants.rs (when the repository is present) and fails on any drift, so a change
 * of the program is a one-line change here. None of these rules apply to the live program (rules 2): the kit uses them
 * only after it has detected the upgraded program (detect.mjs).
 */
import { keccak_256 } from '@noble/hashes/sha3';
import { PublicKey } from '@solana/web3.js';

export const XNT = 1_000_000_000n;
export const BPS = 10_000n;
const DAY = 86_400;

/** constants.rs (rules 3, mainnet). Times in seconds, amounts in lamports (BigInt), slots as numbers. */
export const V3 = Object.freeze({
  CLAIM_HOLD: 2 * DAY,
  CLAIM_WINDOW: 90 * DAY,
  MIN_EPOCH_INTERVAL: 6 * DAY,
  KEEPER_TIP: 2_000_000n,
  /** rules 3: a claim pays the third-party keeper tip only from 0.2 XNT (rules 2: 0.02 XNT) */
  KEEPER_TIP_MIN_CLAIM: 200_000_000n,
  MIN_STAKE: 10_000_000n,
  BET_KEEPER: 0x80,
  BET_ANCHORED: 0x40,
  BET_GAME_MASK: 0x3f,
  BET_SLOT_BITS: 40n,
  /** SlotHashes depth: an anchor block older than this many slots can no longer be read (the bet stalls) */
  SLOT_HASHES_DEPTH: 512,
  KEEPER_BOND_MIN: 20n * XNT,
  KEEPER_NOTICE: 7 * DAY,
  KEEPER_DEAD_DELAY: 28 * DAY,
  KEEPER_STALL_SLOTS: 235_000,
  /** G-2 (round 4): the settle tip of one settled house bet, at most this (0.0005 XNT), at most half the bet's pool share */
  KEEPER_SETTLE_TIP: 500_000n,
  /** of every house stake at placement: 1% to the reward pool, 0.5% to the architect (games.rs bet_edge) */
  EDGE_TO_POOL_BPS: 100n,
  EDGE_TO_ARCHITECT_BPS: 50n,
  HOUSE_EDGE_BPS: 200n,
  JACKPOT_MAX_POT: 20n * XNT,
  DUEL_MIN_STAKE: 100_000_000n,
  DUEL_REVEAL_WINDOW: DAY / 24 + 2,
  DUEL_JOIN_REVEAL_WINDOW: 600,
  P2P_OFFER_TTL: 86_400,
  WAR_MIN_STAKE: 100_000_000n,
  WAR_TURN_TIMEOUT: 120,
  WAR_SEED_WINDOW: 600,
  WAR_REVEAL_WINDOW: 120,
  WAR_FIRST_TURN_GRACE: 600,
  WAR_TURN_FREE: 30,
  WAR_TIME_BANK: 300,
  WAR_V2: 1n << 63n,
  ARTIFACT_PRICE: Object.freeze([10n * XNT, 25n * XNT, 60n * XNT, 200n * XNT]),
  ARTIFACT_SUPPLY: Object.freeze([600, 300, 90, 10]),
  PRICE_UP_NUM: Object.freeze([51n, 21n, 21n, 21n]),
  PRICE_UP_DEN: Object.freeze([50n, 20n, 20n, 20n]),
  PRICE_DECAY_PERIOD: Object.freeze([DAY, 3 * DAY, 7 * DAY, 14 * DAY]),
  MIN_PRICE_BPS: Object.freeze([3_000n, 5_000n, 5_000n, 5_000n]),
  MAX_PRICE_MULTIPLE: 10n,
  PRICE_MAX_STEPS: 180,
  PRICE_LAUNCH_TS: 1_795_564_800,
  FORGE_BACKING_BPS: 5_000n,
  FORGE_POOL_BPS: 2_000n,
  FORGE_EXTRA_BPS: 2_500n,
  FORGE_DRAW_BPS: 0n,
  FORGE_ARCHITECT_BPS: 500n,
  MARKET_ROYALTY_BPS: 500n,
  MARKET_POOL_BPS: 200n,
  MARKET_MIN_PRICE: 100_000_000n,
  MARKET_MAX_LISTING: 90 * DAY,
  EXTRA_RELEASE_BPS: 800n,
  EXTRA_BACKING_BOUND_BPS: 400n,
  EXTRA_MAX_LEAVES: 1_000,
  HOUSE_WITHDRAW_DELAY: DAY,
  HOUSE_WITHDRAW_WINDOW: DAY,
  MAX_EXPOSURE_BPS: 25n,
  MAX_TOTAL_EXPOSURE_BPS: 500n,
  MAX_DAILY_LOSS_BPS: 300n,
  MAX_WEEKLY_LOSS_BPS: 1_500n,
  /** Predictions v2 schedule (in the program, not offered: the kit only advances and claims) */
  PRED_PERIOD: 86_400,
  PRED_LOCK_OFFSET: 50_400,
  PRED_TWAP_WINDOW: 1_200,
  PRED_MAX_GAP: 300,
  PRED_HORIZON: 79_200,
  PRED_MIN_MOVE_BPS: 100n,
  AIRDROP_DEADLINE: 1_806_537_600,
});

// ─── byte helpers ───────────────────────────────────────────────────────────
export const keccak = (...parts) => {
  const h = keccak_256.create();
  for (const p of parts) h.update(typeof p === 'string' ? new TextEncoder().encode(p) : p);
  return Buffer.from(h.digest());
};
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const bytes32 = (x, what) => {
  const b = Buffer.isBuffer(x) ? x : x instanceof Uint8Array ? Buffer.from(x) : typeof x === 'string' && /^[0-9a-f]{64}$/i.test(x) ? Buffer.from(x, 'hex') : null;
  if (!b || b.length !== 32) throw new Error(`${what}: expected 32 bytes`);
  return b;
};
const key = (k) => new PublicKey(k).toBuffer();

/** utils.rs random_u64: the first 8 bytes (LE) of keccak("MOONFORGE_RNG" ‖ hash ‖ a ‖ b). */
export function randomU64(hash, a, b) {
  return keccak('MOONFORGE_RNG', bytes32(hash, 'hash'), a, b).readBigUInt64LE(0);
}

// ─── Artifacts: PX price, forge split, market split ─────────────────────────
const bpsOf = (amount, bps) => (BigInt(amount) * BigInt(bps)) / BPS;
const maxBig = (a, b) => (a > b ? a : b);
const minBig = (a, b) => (a < b ? a : b);

/**
 * artifacts.rs current_price: the tier's price now. `cfg` needs artifactPrice[], artifactPriceTs[], artifactsAlive[]
 * (Anchor BN, BigInt or number). A full tier does not decay; each full decay period divides the price by PRICE_UP,
 * down to MIN_PRICE_BPS of base; a never-forged tier decays from base since PRICE_LAUNCH_TS.
 */
export function currentPrice(cfg, tier, now) {
  const t = Number(tier);
  if (!(t >= 0 && t < 4)) throw new Error(`currentPrice: tier ${tier} is not 0..3`);
  const base = V3.ARTIFACT_PRICE[t];
  const min = bpsOf(base, V3.MIN_PRICE_BPS[t]);
  const stored = BigInt(cfg.artifactPrice[t].toString());
  let p = stored === 0n ? base : stored;
  const since = stored === 0n ? V3.PRICE_LAUNCH_TS : Number(cfg.artifactPriceTs[t].toString());
  if (Number(cfg.artifactsAlive[t].toString()) >= V3.ARTIFACT_SUPPLY[t]) return maxBig(p, min);
  const periods = Math.floor(Math.max(0, Number(now) - since) / V3.PRICE_DECAY_PERIOD[t]);
  for (let i = 0; i < Math.min(periods, V3.PRICE_MAX_STEPS); i++) {
    p = (p * V3.PRICE_UP_DEN[t]) / V3.PRICE_UP_NUM[t];
    if (p <= min) return min;
  }
  return maxBig(p, min);
}

/** artifacts.rs next_price: the price left after a forge at `paid` (×PRICE_UP, capped at 10× base). */
export function nextPrice(paid, tier) {
  const t = Number(tier);
  return minBig((BigInt(paid) * V3.PRICE_UP_NUM[t]) / V3.PRICE_UP_DEN[t], V3.ARTIFACT_PRICE[t] * V3.MAX_PRICE_MULTIPLE);
}

/** artifacts.rs forge_split: { backing, toPool, toExtra, toDraw, toArchitect } of a forge price (sums to the price). */
export function forgeSplit(price) {
  const p = BigInt(price);
  const backing = bpsOf(p, V3.FORGE_BACKING_BPS), toExtra = bpsOf(p, V3.FORGE_EXTRA_BPS), toPool = bpsOf(p, V3.FORGE_POOL_BPS), toDraw = bpsOf(p, V3.FORGE_DRAW_BPS);
  return { backing, toPool, toExtra, toDraw, toArchitect: p - backing - toPool - toExtra - toDraw };
}

/** utils.rs market_split: { royalty (5%, architect), poolFee (2%, base pot), sellerNet } of a sale price. */
export function marketSplit(price) {
  const p = BigInt(price);
  const royalty = bpsOf(p, V3.MARKET_ROYALTY_BPS), poolFee = bpsOf(p, V3.MARKET_POOL_BPS);
  return { royalty, poolFee, sellerNet: p - royalty - poolFee };
}

/** market.rs check_price: null when `price` may be listed for an Artifact of floor `backing`, otherwise why not. */
export function listingPriceProblem(price, backing) {
  const p = BigInt(price);
  if (p < V3.MARKET_MIN_PRICE) return `the price is below the market minimum of ${Number(V3.MARKET_MIN_PRICE) / 1e9} XNT`;
  const { sellerNet } = marketSplit(p);
  if (sellerNet < BigInt(backing)) return `the seller would receive ${Number(sellerNet) / 1e9} XNT, less than this Artifact's floor (${Number(backing) / 1e9} XNT): recycling it returns more`;
  return null;
}

/** The lowest list price whose seller net (93%) still covers `backing` (found exactly, the fees floor). */
export function minimumListPrice(backing) {
  const b = BigInt(backing);
  let p = maxBig(V3.MARKET_MIN_PRICE, (b * BPS + (BPS - V3.MARKET_ROYALTY_BPS - V3.MARKET_POOL_BPS) - 1n) / (BPS - V3.MARKET_ROYALTY_BPS - V3.MARKET_POOL_BPS));
  while (p > V3.MARKET_MIN_PRICE && listingPriceProblem(p - 1n, b) === null) p -= 1n;
  while (listingPriceProblem(p, b) !== null) p += 1n;
  return p;
}

// ─── house bets on the keeper hash chain ─────────────────────────────────────
const SLOT_MASK = (1n << V3.BET_SLOT_BITS) - 1n;
/** utils.rs bet_pack / bet_unpack: chain position in bits 40..63, anchor slot in bits 0..39. */
export const betPack = (index, anchor) => (BigInt(index) << V3.BET_SLOT_BITS) | (BigInt(anchor) & SLOT_MASK);
export const betUnpack = (packed) => ({ index: BigInt(packed) >> V3.BET_SLOT_BITS, anchor: BigInt(packed) & SLOT_MASK });
/** A bet placed through place_bet_v2 (bit 7 of Bet.game); bit 6 once anchored; the game itself is game & 0x3f. */
export const isKeeperBet = (game) => (Number(game) & V3.BET_KEEPER) !== 0;
export const isAnchored = (game) => (Number(game) & V3.BET_ANCHORED) !== 0;
export const gameOf = (game) => Number(game) & V3.BET_GAME_MASK;
/** keeper.rs anchor_bet: the bet seed after its anchor block's hash is mixed in. */
export const anchoredSeed = (seed, slotHash) => keccak('MOONFORGE_ANCHOR', bytes32(seed, 'seed'), bytes32(slotHash, 'slot hash'));
/** keeper.rs: keccak(reveal) must equal the chain head the keeper committed (its previous reveal or the armed tip). */
export const chainNextOk = (tip, reveal) => keccak(bytes32(reveal, 'reveal')).equals(bytes32(tip, 'tip'));
/** settle_bet_v2: roll = random_u64(reveal, bet, mixed seed) % 10,000. */
export const rollFor = (reveal, bet, mixedSeed) => Number(randomU64(reveal, key(bet), bytes32(mixedSeed, 'mixed seed')) % BPS);

const RTP_NUMERATOR = 98_000_000;
/** games.rs game_odds: [chance in bps, payout in bps] (refuses parameters the program refuses). */
export function gameOdds(game, param, choice) {
  const g = Number(game), p = Number(param), c = Number(choice);
  if (g === 0) { if (c > 1) throw new Error('Coin Flip: choice 0 or 1'); return [5_000, Math.floor(RTP_NUMERATOR / 5_000)]; }
  if (g === 1) {
    if (c > 1) throw new Error('High-Low: choice 0 (under) or 1 (over)');
    if (!(p >= 100 && p <= 9_500)) throw new Error('High-Low: win chance 100..9500 bps');
    return [p, Math.floor(RTP_NUMERATOR / p)];
  }
  if (g === 2) { if (!(p >= 10_500 && p <= 1_000_000)) throw new Error('Void Rush: target 10500..1000000 bps'); return [Math.floor(RTP_NUMERATOR / p), p]; }
  throw new Error(`unknown game ${game}`);
}
/** games.rs is_win. */
export function isWin(game, choice, chanceBps, roll) {
  const g = Number(game), r = Number(roll), ch = Number(chanceBps);
  if (g === 0) return (r < 5_000) === (Number(choice) === 0);
  if (g === 1) return Number(choice) === 0 ? r < ch : r >= 10_000 - ch;
  return r < ch;
}

/** games.rs bet_edge: the placement edge of a house stake (pool 1% + architect 0.5%, floored each). */
export const betEdge = (stake) => bpsOf(stake, V3.EDGE_TO_POOL_BPS) + bpsOf(stake, V3.EDGE_TO_ARCHITECT_BPS);
/**
 * keeper.rs settle_tip (G-2, round 4): the tip a settle_bet_v2 pays the registered keeper wallet from the FREE reward pool:
 * min(KEEPER_SETTLE_TIP, half of the bet's 1% pool share, the free pool). 0 on a refund, a stall or a skip; the program
 * also pays 0 when the keeper wallet would stay below its rent minimum (tip_payable).
 */
export const settleTip = (stake, freePool = 2n ** 64n - 1n) => minBig(minBig(V3.KEEPER_SETTLE_TIP, bpsOf(stake, V3.EDGE_TO_POOL_BPS) / 2n), BigInt(freePool));
/**
 * keeper.rs stall_split / stall_moves (round 4, review F1; r4-fix, review r4 finding 1), with a bond that covers it:
 * what a stalled house bet pays and who pays it. reason 0 (never anchored): the player gets the whole stake back, the
 * bankroll returns stake − edge (the bet is undone for the house) and the keeper bond pays the edge; the bond also
 * forfeits stake − edge to nobody (it stays in the keeper seat; BetRefunded.penalty), so no LP, burner or player gains
 * from a bet left unanchored. reason 1 (anchored and not revealed in time, or skipped): the payout, as a win, all from
 * the keeper bond; the bankroll keeps stake − edge (booked as a lost bet, BetRefunded.penalty). The pool and the
 * architect keep only the placement edge. Amounts in lamports.
 */
export function stallOutcome(reason, stake, payout) {
  const s = BigInt(stake), edge = betEdge(s), stakeIn = s - edge;
  if (Number(reason) === 0) {
    return { reason: 0, toPlayer: s, fromBond: edge, fromBankroll: stakeIn, bankrollKeeps: 0n, bondForfeit: stakeIn, bondLoss: s, edge };
  }
  const toPlayer = BigInt(payout);
  return { reason: Number(reason), toPlayer, fromBond: toPlayer, fromBankroll: 0n, bankrollKeeps: stakeIn, bondForfeit: 0n, bondLoss: toPlayer, edge };
}

/**
 * Where a keeper bet stands (keeper.rs settle_bet_v2 / refund_stalled_bet), from the Bet and HouseKeeper accounts and the
 * current slot: 'legacy' (placed by the live binary), 'unanchored' (anchor_bet still possible), 'waiting' (anchored, the
 * keeper reveals it), 'refundable' (reason 0 = never anchored and its block is gone: the whole stake back; reason 1 =
 * anchored and stalled past KEEPER_STALL_SLOTS, or its position skipped: paid as a win). Both refunds are paid from the
 * keeper bond (stallOutcome).
 */
export function keeperBetState(bet, keeper, slot) {
  if (!isKeeperBet(bet.game)) return { state: 'legacy' };
  const { index, anchor } = betUnpack(bet.targetSlot.toString());
  const s = BigInt(slot);
  const revealed = keeper ? BigInt(keeper.revealed.toString()) : 0n;
  const skipped = index < revealed;
  if (!isAnchored(bet.game)) {
    if (skipped) return { state: 'refundable', reason: 1, index, anchor };
    if (s > anchor + BigInt(V3.SLOT_HASHES_DEPTH)) return { state: 'refundable', reason: 0, index, anchor };
    return { state: 'unanchored', index, anchor, anchorableFrom: anchor + 1n, anchorableUntil: anchor + BigInt(V3.SLOT_HASHES_DEPTH) };
  }
  if (skipped || s > anchor + BigInt(V3.KEEPER_STALL_SLOTS)) return { state: 'refundable', reason: 1, index, anchor };
  return { state: 'waiting', index, anchor, stallsAfterSlot: anchor + BigInt(V3.KEEPER_STALL_SLOTS), position: index - revealed };
}

/** The house keeper as an agent sees it: armed, positions left, bond, pending, idle since (all read-only facts). */
export function keeperView(k, now) {
  if (!k) return { exists: false, armed: false, reason: 'the HouseKeeper account does not exist yet (house games on the keeper chain are not open)' };
  const length = BigInt(k.length.toString()), next = BigInt(k.nextIndex.toString()), bond = BigInt(k.bond.toString());
  const lastActive = Number(k.lastActiveTs.toString());
  const armed = next < length && bond >= V3.KEEPER_BOND_MIN;
  return {
    exists: true, armed, keeper: new PublicKey(k.keeper).toBase58(), positionsLeft: (length > next ? length - next : 0n).toString(),
    bondXnt: Number(bond) / 1e9, pendingBets: Number(k.pendingBets), jackpotReservedXnt: Number(BigInt(k.jackpotReserved.toString())) / 1e9,
    lastActiveTs: lastActive, idleDays: Math.max(0, (Number(now) - lastActive) / DAY), withdrawRequested: Number(k.withdrawTs.toString()) !== 0,
    deadAfterTs: lastActive + V3.KEEPER_DEAD_DELAY,
    reason: armed ? null : next >= length ? 'the keeper chain has no positions left (wait for it to re-arm)' : 'the keeper bond is below the 20 XNT minimum',
  };
}

// ─── sealed Artifact Duel (p2p.rs) ──────────────────────────────────────────
/** The creator's commitment: keccak("MOONFORGE_DUEL" ‖ element ‖ salt ‖ duel). */
export const duelCommitment = (element, salt, duel) => keccak('MOONFORGE_DUEL', Uint8Array.of(Number(element)), bytes32(salt, 'salt'), key(duel));
/** The joiner's sealed commitment: keccak("MOONFORGE_DUEL_JOIN" ‖ element ‖ salt ‖ duel ‖ opponent). */
export const duelJoinCommitment = (element, salt, duel, opponent) => keccak('MOONFORGE_DUEL_JOIN', Uint8Array.of(Number(element)), bytes32(salt, 'salt'), key(duel), key(opponent));
/** a beats b ⇔ b == (a + 3) % 4: Lunar > Void, Void > Solar, Solar > Cosmic, Cosmic > Lunar. */
export const beats = (a, b) => Number(b) === (Number(a) + 3) % 4;
/** p2p.rs duel_winner: true = the opponent wins, false = the creator wins, null = a draw. */
export const duelWinner = (creatorEl, opponentEl) => (beats(creatorEl, opponentEl) ? false : beats(opponentEl, creatorEl) ? true : null);
export const DUEL_ELEMENT_SEALED = 255;

// ─── sealed Moon Wars (wars.rs) ─────────────────────────────────────────────
/** keccak("MOONFORGE_WAR_ENTROPY" ‖ entropy ‖ war): the creator's commitment at create_war_sealed. */
export const warEntropyCommitment = (entropy, war) => keccak('MOONFORGE_WAR_ENTROPY', bytes32(entropy, 'entropy'), key(war));
/** keccak("MOONFORGE_WAR_JOIN" ‖ secret ‖ war ‖ opponent ‖ move key): the joiner's commitment at join_war_sealed. */
export const warJoinCommitment = (secret, war, opponent, moveKey) => keccak('MOONFORGE_WAR_JOIN', bytes32(secret, 'secret'), key(war), key(opponent), key(moveKey));
/** keccak("MOONFORGE_WAR_V2" ‖ entropy ‖ secret ‖ war): the seed of both decks and of the first mover. */
export const warSeedV2 = (entropy, secret, war) => keccak('MOONFORGE_WAR_V2', bytes32(entropy, 'entropy'), bytes32(secret, 'secret'), key(war));
/** wars.rs first_mover: 0 = the creator moves first, 1 = the opponent. */
export const firstMover = (seed) => Number(randomU64(seed, new TextEncoder().encode('MOONFORGE_WAR_FIRST'), new Uint8Array(0)) & 1n);
/** A match created by the upgraded binary (sealed start, chess clock): bit 63 of War.target_slot. */
export const isSealedWar = (w) => (BigInt(w.targetSlot.toString()) & V3.WAR_V2) !== 0n;
/** Chess-clock seconds left: [creator, opponent] (valid once a sealed match is ACTIVE). */
export function warClockBanks(w) {
  const t = BigInt(w.targetSlot.toString());
  return [Number((t >> 16n) & 0xffffn), Number(t & 0xffffn)];
}

// ─── Metaplex Core asset layout (read-only) ─────────────────────────────────
const CORE_KEY_ASSET_V1 = 1, CORE_KEY_PLUGIN_HEADER = 3, CORE_KEY_PLUGIN_REGISTRY = 4;
const PLUGIN_TRANSFER_DELEGATE = 3;
const AUTHORITY = ['none', 'owner', 'updateAuthority', 'address'];
/**
 * Reads a Core AssetV1 account: owner, update authority, name, uri and, when the account carries a plugin registry, the
 * TransferDelegate plugin's authority ({ type: 'owner' | 'address' | ..., address }). Returns null for anything that is
 * not a readable AssetV1 (wrong key byte, truncated data). Used to show Buy only while the asset's delegate is its
 * listing PDA (a buy would otherwise fail inside Core) and to choose list_artifact's add_plugin flag.
 */
export function parseCoreAsset(data) {
  const d = Buffer.from(data ?? []);
  if (d.length < 1 + 32 + 1 || d[0] !== CORE_KEY_ASSET_V1) return null;
  let o = 1;
  const need = (n) => { if (o + n > d.length) throw new Error('truncated'); };
  try {
    need(32); const owner = new PublicKey(d.subarray(o, o + 32)); o += 32;
    need(1); const uaTag = d[o]; o += 1;
    let updateAuthority = null;
    if (uaTag === 1 || uaTag === 2) { need(32); updateAuthority = { type: uaTag === 2 ? 'collection' : 'address', address: new PublicKey(d.subarray(o, o + 32)) }; o += 32; }
    else if (uaTag !== 0) return null;
    const str = () => { need(4); const n = d.readUInt32LE(o); o += 4; need(n); const s = d.subarray(o, o + n).toString('utf8'); o += n; return s; };
    const name = str(), uri = str();
    need(1); const seqTag = d[o]; o += 1;
    if (seqTag === 1) { need(8); o += 8; } else if (seqTag !== 0) return null;
    const out = { owner, updateAuthority, name, uri, plugins: null, transferDelegate: null };
    if (o === d.length) return { ...out, plugins: [] };
    need(9);
    if (d[o] !== CORE_KEY_PLUGIN_HEADER) return out;
    const registryOffset = Number(d.readBigUInt64LE(o + 1));
    if (registryOffset < o + 9 || registryOffset + 5 > d.length || d[registryOffset] !== CORE_KEY_PLUGIN_REGISTRY) return out;
    o = registryOffset + 1;
    need(4); const count = d.readUInt32LE(o); o += 4;
    if (count > 64) return out;
    const plugins = [];
    for (let i = 0; i < count; i++) {
      need(2); const type = d[o]; const aTag = d[o + 1]; o += 2;
      if (aTag > 3) return out;
      let address = null;
      if (aTag === 3) { need(32); address = new PublicKey(d.subarray(o, o + 32)); o += 32; }
      need(8); o += 8;
      plugins.push({ type, authority: { type: AUTHORITY[aTag], address } });
    }
    out.plugins = plugins;
    const td = plugins.find((p) => p.type === PLUGIN_TRANSFER_DELEGATE);
    out.transferDelegate = td ? td.authority : null;
    return out;
  } catch {
    return null;
  }
}
