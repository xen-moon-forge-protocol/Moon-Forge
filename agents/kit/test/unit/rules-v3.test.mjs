// node --test: the kit's mirror of the final upgrade's rules (rules-v3.mjs) against the program itself: every mirrored
// constant against programs/moon-forge/src/constants.rs (mainnet values; skipped outside the repository), the SPEC
// Appendix A vectors the program's own unit test pins (tests/fixtures/spec-vectors-v2.out.json), the duel commitment
// vector of p2p.rs, and the Metaplex Core asset reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  anchoredSeed, betPack, betUnpack, chainNextOk, currentPrice, duelCommitment, duelJoinCommitment, duelWinner, forgeSplit, gameOdds, isWin, keccak,
  keeperBetState, listingPriceProblem, marketSplit, minimumListPrice, nextPrice, parseCoreAsset, rollFor, V3, warClockBanks, warEntropyCommitment, warSeedV2, firstMover,
  betEdge, settleTip, stallOutcome,
} from '../../rules-v3.mjs';
import { extraLeaf } from '../../verify-leaf.mjs';
import { REPO } from './helpers-v3.mjs';

const CONSTANTS = path.join(REPO, 'programs', 'moon-forge', 'src', 'constants.rs');
const SPEC_VECTORS = path.join(REPO, 'tests', 'fixtures', 'spec-vectors-v2.out.json');
const fill = (b) => Buffer.alloc(32, b);

/** Mainnet values of constants.rs: `const` / `pub const` NAME: T = expr; skipping the definitions under #[cfg(feature = "localnet")]. */
function parseConstants(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const raw = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:pub(?:\([a-z]+\))?\s+)?const\s+([A-Z0-9_]+)\s*:\s*[^=]+=\s*(.+?);\s*(?:\/\/.*)?$/.exec(lines[i]);
    if (!m) continue;
    let j = i - 1;
    while (j >= 0 && /^\s*(\/\/\/|\/\/)/.test(lines[j])) j--;
    if (j >= 0 && /#\[cfg\(feature = "localnet"\)\]/.test(lines[j])) continue;
    raw.set(m[1], m[2].trim());
  }
  const memo = new Map();
  const value = (name, depth = 0) => {
    if (memo.has(name)) return memo.get(name);
    if (!raw.has(name) || depth > 20) throw new Error(`constant ${name} not found`);
    const v = evalExpr(raw.get(name), (n) => value(n, depth + 1));
    memo.set(name, v);
    return v;
  };
  return { has: (n) => raw.has(n), value };
}
/** A tiny evaluator for the constant expressions (integers, + - * / % << >>, parentheses, arrays, `as` casts, names). */
function evalExpr(src, lookup) {
  const s = src.replace(/_(?=\d)/g, '').replace(/\bas\s+[a-z0-9]+/g, '');
  const toks = s.match(/0x[0-9a-fA-F]+|\d+|[A-Z][A-Z0-9_]*|<<|>>|[-+*/%()[\],]/g) ?? [];
  let i = 0;
  const peek = () => toks[i], next = () => toks[i++];
  const primary = () => {
    const t = next();
    if (t === '(') { const v = expr(); next(); return v; }
    if (t === '[') { const out = []; while (peek() !== ']') { out.push(expr()); if (peek() === ',') next(); } next(); return out; }
    if (t === '-') return -primary();
    if (/^0x/.test(t)) return BigInt(t);
    if (/^\d+$/.test(t)) return BigInt(t);
    if (/^[A-Z]/.test(t)) return lookup(t);
    throw new Error(`cannot evaluate ${src}`);
  };
  const term = () => { let v = primary(); while (['*', '/', '%'].includes(peek())) { const o = next(), r = primary(); v = o === '*' ? v * r : o === '/' ? v / r : v % r; } return v; };
  const sum = () => { let v = term(); while (['+', '-'].includes(peek())) { const o = next(), r = term(); v = o === '+' ? v + r : v - r; } return v; };
  const expr = () => { let v = sum(); while (['<<', '>>'].includes(peek())) { const o = next(), r = sum(); v = o === '<<' ? v << r : v >> r; } return v; };
  return expr();
}

test('every mirrored constant equals constants.rs (mainnet values)', (t) => {
  if (!fs.existsSync(CONSTANTS)) return t.skip('programs/moon-forge/src/constants.rs is not present');
  const c = parseConstants(fs.readFileSync(CONSTANTS, 'utf8'));
  const same = (name, kitValue) => {
    const v = c.value(name);
    const norm = (x) => (Array.isArray(x) ? x.map(norm) : BigInt(x));
    assert.deepEqual(norm(v), norm(kitValue), `${name}: constants.rs ${v} vs kit ${kitValue}`);
  };
  for (const n of ['CLAIM_HOLD', 'CLAIM_WINDOW', 'MIN_EPOCH_INTERVAL', 'KEEPER_TIP', 'KEEPER_TIP_MIN_CLAIM', 'MIN_STAKE', 'BET_KEEPER', 'BET_ANCHORED', 'BET_GAME_MASK',
    'BET_SLOT_BITS', 'KEEPER_BOND_MIN', 'KEEPER_NOTICE', 'KEEPER_DEAD_DELAY', 'KEEPER_STALL_SLOTS', 'KEEPER_SETTLE_TIP', 'EDGE_TO_POOL_BPS', 'EDGE_TO_ARCHITECT_BPS', 'HOUSE_EDGE_BPS', 'JACKPOT_MAX_POT', 'DUEL_MIN_STAKE', 'DUEL_REVEAL_WINDOW',
    'DUEL_JOIN_REVEAL_WINDOW', 'P2P_OFFER_TTL', 'WAR_MIN_STAKE', 'WAR_TURN_TIMEOUT', 'WAR_SEED_WINDOW', 'WAR_REVEAL_WINDOW', 'WAR_FIRST_TURN_GRACE', 'WAR_TURN_FREE',
    'WAR_TIME_BANK', 'WAR_V2', 'ARTIFACT_PRICE', 'ARTIFACT_SUPPLY', 'PRICE_UP_NUM', 'PRICE_UP_DEN', 'PRICE_DECAY_PERIOD', 'MIN_PRICE_BPS', 'MAX_PRICE_MULTIPLE',
    'PRICE_MAX_STEPS', 'PRICE_LAUNCH_TS', 'FORGE_BACKING_BPS', 'FORGE_POOL_BPS', 'FORGE_EXTRA_BPS', 'FORGE_DRAW_BPS', 'FORGE_ARCHITECT_BPS', 'MARKET_ROYALTY_BPS',
    'MARKET_POOL_BPS', 'MARKET_MIN_PRICE', 'MARKET_MAX_LISTING', 'EXTRA_RELEASE_BPS', 'EXTRA_BACKING_BOUND_BPS', 'EXTRA_MAX_LEAVES', 'HOUSE_WITHDRAW_DELAY',
    'HOUSE_WITHDRAW_WINDOW', 'MAX_EXPOSURE_BPS', 'MAX_TOTAL_EXPOSURE_BPS', 'MAX_DAILY_LOSS_BPS', 'MAX_WEEKLY_LOSS_BPS', 'PRED_PERIOD', 'PRED_LOCK_OFFSET',
    'PRED_TWAP_WINDOW', 'PRED_MAX_GAP', 'PRED_HORIZON', 'PRED_MIN_MOVE_BPS', 'AIRDROP_DEADLINE']) {
    same(n, V3[n]);
  }
});

test('SPEC Appendix A vectors (the same file the program\'s unit test pins)', (t) => {
  if (!fs.existsSync(SPEC_VECTORS)) return t.skip('tests/fixtures/spec-vectors-v2.out.json is not present');
  const v = JSON.parse(fs.readFileSync(SPEC_VECTORS, 'utf8'));
  // keeper chain x_k = keccak(x_{k+1}); each reveal follows the previous head
  for (let i = 0; i < 8; i++) assert.ok(chainNextOk(v[`keeper_chain_x${i}`], v[`keeper_chain_x${i + 1}`]), `x${i + 1} reveals x${i}`);
  assert.equal(anchoredSeed(fill(8), fill(7)).toString('hex'), v.anchor_mixed_seed);
  assert.equal(String(rollFor(v.keeper_chain_x1, new PublicKey(fill(7)), v.anchor_mixed_seed)), v.v2_roll_reveal_x1_bet_07);
  assert.equal(betPack(5, 1_000_000).toString(), v.bet_pack_5_1000000);
  assert.deepEqual(betUnpack(BigInt(v.bet_pack_5_1000000)), { index: 5n, anchor: 1_000_000n });
  assert.equal(extraLeaf(7, 3, new PublicKey(fill(2)).toBase58(), 123_456_789n).toString('hex'), v.extra_leaf_e7_i3_w02_a123456789);
  const ms = marketSplit(10n * 10n ** 9n);
  assert.equal([ms.royalty, ms.poolFee, ms.sellerNet].join(','), v.market_split_10xnt);
  const never = { artifactPrice: [0, 0, 0, 0], artifactPriceTs: [0, 0, 0, 0], artifactsAlive: [0, 0, 0, 0] };
  assert.equal(String(currentPrice(never, 0, V3.PRICE_LAUNCH_TS)), v.px_lunar_never_forged_at_launch);
  assert.equal(String(currentPrice(never, 0, V3.PRICE_LAUNCH_TS + 86_400)), v.px_lunar_never_forged_plus_1d);
  assert.equal(String(currentPrice(never, 0, V3.PRICE_LAUNCH_TS + 177 * 86_400)), v.px_lunar_never_forged_plus_177d);
  assert.equal(String(nextPrice(nextPrice(V3.ARTIFACT_PRICE[1], 1), 1)), v.px_cosmic_after_2_forges);
  const from100 = { artifactPrice: [100n * 10n ** 9n, 0, 0, 0], artifactPriceTs: [1_000, 0, 0, 0], artifactsAlive: [0, 0, 0, 0] };
  assert.equal(String(currentPrice(from100, 0, 1_000 + 177 * 86_400)), v.px_lunar_from_100xnt_177_periods);
  assert.equal(String(currentPrice(from100, 0, 1_000 + 178 * 86_400)), v.px_lunar_from_100xnt_178_periods);
  const full = { artifactPrice: [V3.ARTIFACT_PRICE[0], 0, 0, 0], artifactPriceTs: [1_000, 0, 0, 0], artifactsAlive: [600, 0, 0, 0] };
  assert.equal(String(currentPrice(full, 0, 1_000 + 400 * 86_400)), v.px_full_tier_never_decays);
  assert.equal([0, 1, 2, 3].map((t2) => nextPrice(V3.ARTIFACT_PRICE[t2] * 10n, t2)).join(','), v.px_next_price_cap);
});

test('duel join commitment: the p2p.rs vector (element 1, salt 0x09, duel 0x01, opponent 0x02)', () => {
  const c = duelJoinCommitment(1, fill(9), new PublicKey(fill(1)), new PublicKey(fill(2)));
  assert.equal(c.toString('hex'), '4174fb36832c31540985c74b2a24465def836269b4b4de407a978fbc546baf16');
  assert.notEqual(c.toString('hex'), duelJoinCommitment(1, fill(9), new PublicKey(fill(1)), new PublicKey(fill(3))).toString('hex'));
  assert.equal(duelCommitment(2, fill(4), new PublicKey(fill(5))).toString('hex'), keccak('MOONFORGE_DUEL', Uint8Array.of(2), fill(4), fill(5)).toString('hex'));
});

test('duel winner: Lunar > Void > Solar > Cosmic > Lunar; same element is a draw', () => {
  assert.equal(duelWinner(0, 1), true, 'creator Lunar vs Cosmic: the opponent wins');
  assert.equal(duelWinner(3, 2), false, 'creator Void vs Solar: the creator wins');
  assert.equal(duelWinner(2, 2), null);
});

test('sealed Moon Wars: commitments, seed, first mover and the chess-clock banks', () => {
  const war = Keypair.generate().publicKey;
  assert.equal(warEntropyCommitment(fill(1), war).toString('hex'), keccak('MOONFORGE_WAR_ENTROPY', fill(1), war.toBuffer()).toString('hex'));
  const seed = warSeedV2(fill(1), fill(2), war);
  assert.ok([0, 1].includes(firstMover(seed)));
  const ones = Array.from({ length: 2_000 }, (_, i) => firstMover(keccak(Buffer.from(String(i))))).reduce((a, b) => a + b, 0);
  assert.ok(ones > 850 && ones < 1150, `first mover is a fair coin (${ones}/2000)`);
  assert.deepEqual(warClockBanks({ targetSlot: 0x8000_0000_012c_012cn }), [300, 300]);
});

test('forge split 50/20/25/0/5 sums to the price; market split and the floor rule', () => {
  for (const p of [10n * 10n ** 9n, 9_803_921_568n, 1n, 27_562_500_001n]) {
    const s = forgeSplit(p);
    assert.equal(s.backing + s.toPool + s.toExtra + s.toDraw + s.toArchitect, p);
    assert.equal(s.toDraw, 0n);
  }
  const f = forgeSplit(10n * 10n ** 9n);
  assert.deepEqual([f.backing, f.toPool, f.toExtra, f.toArchitect], [5n * 10n ** 9n, 2n * 10n ** 9n, 2_500_000_000n, 500_000_000n]);
  const min = minimumListPrice(5n * 10n ** 9n);
  assert.equal(listingPriceProblem(min, 5n * 10n ** 9n), null);
  assert.match(listingPriceProblem(min - 1n, 5n * 10n ** 9n), /less than this Artifact's floor/);
  assert.match(listingPriceProblem(1n, 0n), /below the market minimum/);
  assert.ok(Number(min) / 1e9 > 5.37 && Number(min) / 1e9 < 5.38, 'about 53.76% of a 10 XNT base');
});

test('house odds and win sets mirror games.rs (98% return to player)', () => {
  assert.deepEqual(gameOdds(0, 0, 1), [5_000, 19_600]);
  assert.deepEqual(gameOdds(1, 9_500, 0), [9_500, 10_315]);
  assert.deepEqual(gameOdds(2, 20_000, 0), [4_900, 20_000]);
  assert.throws(() => gameOdds(1, 99, 0), /100\.\.9500/);
  const wins = (g, c, ch) => Array.from({ length: 10_000 }, (_, r) => isWin(g, c, ch, r)).filter(Boolean).length;
  assert.equal(wins(0, 0, 5_000), 5_000);
  assert.equal(wins(1, 1, 300), 300);
  assert.equal(wins(2, 0, 4_900), 4_900);
});

test('keeper bet states: unanchored, waiting, refundable after the anchor block or the stall, skipped', () => {
  const bet = (anchored, index, anchor) => ({ game: 0x80 | (anchored ? 0x40 : 0), targetSlot: betPack(index, anchor) });
  const k = { revealed: 3n };
  assert.equal(keeperBetState(bet(false, 5, 1_000), k, 1_100).state, 'unanchored');
  assert.deepEqual([keeperBetState(bet(false, 5, 1_000), k, 1_513).state, keeperBetState(bet(false, 5, 1_000), k, 1_513).reason], ['refundable', 0]);
  assert.equal(keeperBetState(bet(true, 5, 1_000), k, 2_000).state, 'waiting');
  assert.deepEqual([keeperBetState(bet(true, 5, 1_000), k, 1_000 + 235_001).state, keeperBetState(bet(true, 5, 1_000), k, 1_000 + 235_001).reason], ['refundable', 1]);
  assert.equal(keeperBetState(bet(true, 2, 1_000), k, 1_100).reason, 1, 'a position the keeper skipped is refundable at once, as a win');
  assert.equal(keeperBetState({ game: 0, targetSlot: 7n }, k, 1).state, 'legacy');
});

test('Core asset reader: owner, collection, the TransferDelegate authority (Owner, then an address)', () => {
  const owner = Keypair.generate().publicKey, coll = Keypair.generate().publicKey, listing = Keypair.generate().publicKey;
  const str = (s) => { const b = Buffer.from(s); const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]); };
  const base = Buffer.concat([Buffer.from([1]), owner.toBuffer(), Buffer.from([2]), coll.toBuffer(), str('Lunar Dust #1'), str('https://x/0/1.json'), Buffer.from([0])]);
  const build = (authority) => {
    const pluginData = Buffer.from([3]); // TransferDelegate {} (plugin body; its content is not read)
    const headerAt = base.length;
    const pluginsAt = headerAt + 9;
    const registryAt = pluginsAt + pluginData.length;
    const header = Buffer.alloc(9); header[0] = 3; header.writeBigUInt64LE(BigInt(registryAt), 1);
    const off = Buffer.alloc(8); off.writeBigUInt64LE(BigInt(pluginsAt));
    const count = Buffer.alloc(4); count.writeUInt32LE(1);
    const auth = authority === 'owner' ? Buffer.from([1]) : Buffer.concat([Buffer.from([3]), authority.toBuffer()]);
    const registry = Buffer.concat([Buffer.from([4]), count, Buffer.from([3]), auth, off, Buffer.alloc(4)]);
    return Buffer.concat([base, header, pluginData, registry]);
  };
  const a = parseCoreAsset(build('owner'));
  assert.ok(a.owner.equals(owner));
  assert.equal(a.updateAuthority.type, 'collection');
  assert.ok(a.updateAuthority.address.equals(coll));
  assert.equal(a.name, 'Lunar Dust #1');
  assert.equal(a.transferDelegate.type, 'owner');
  const b = parseCoreAsset(build(listing));
  assert.equal(b.transferDelegate.type, 'address');
  assert.ok(b.transferDelegate.address.equals(listing));
  assert.deepEqual(parseCoreAsset(base).plugins, [], 'an asset without a plugin header has no plugins');
  assert.equal(parseCoreAsset(Buffer.from([0, 1, 2])), null);
  assert.equal(parseCoreAsset(base.subarray(0, 40)), null, 'truncated data is unreadable, never guessed');
});

test('G-2 settle tip (keeper.rs settle_tip_cases) and the round-4 stall split: the bond pays the player, the bankroll keeps the stake', () => {
  const X = 1_000_000_000n;
  assert.equal(settleTip(X / 100n), 50_000n);
  assert.equal(settleTip(X), 500_000n);
  assert.equal(settleTip(7n * X), 500_000n);
  assert.equal(settleTip(X, 0n), 0n);
  assert.equal(settleTip(X, 123n), 123n);
  assert.equal(settleTip(V3.MIN_STAKE), 50_000n);
  for (let i = 1n; i < 2_000n; i++) {
    const stake = V3.MIN_STAKE + i * 7_919_113n, t = settleTip(stake, i * 997n);
    assert.ok(2n * t <= (stake * V3.EDGE_TO_POOL_BPS) / 10_000n && t <= V3.KEEPER_SETTLE_TIP && t <= i * 997n);
  }
  const stake = 1_000_000_000n, payout = 1_960_000_000n, edge = betEdge(stake);
  assert.equal(edge, 15_000_000n, 'the placement edge: 1% pool + 0.5% architect');
  assert.deepEqual(stallOutcome(0, stake, payout), { reason: 0, toPlayer: stake, fromBond: edge, fromBankroll: stake - edge, bankrollKeeps: 0n, bondForfeit: stake - edge, bondLoss: stake, edge }, 'r4-fix: never anchored: the whole stake back (the bankroll returns stake - edge, the bond pays the edge and forfeits stake - edge to nobody)');
  assert.deepEqual(stallOutcome(1, stake, payout), { reason: 1, toPlayer: payout, fromBond: payout, fromBankroll: 0n, bankrollKeeps: stake - edge, bondForfeit: 0n, bondLoss: payout, edge }, 'stalled or skipped: the payout, from the bond');
});