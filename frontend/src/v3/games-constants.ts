/**
 * Rules-3 GAME constants: the upgraded program's compile-time values for house bets, the keeper seat, the sealed Artifact
 * Duel and sealed Moon Wars, mirrored from programs/moon-forge/src/constants.rs (mainnet values, never the `localnet`
 * ones). test/v3/games-constants.test.ts parses that file and fails on any difference.
 *
 * Kept apart from src/v3/constants.ts (the forge, market and pot mirror) so the game screens can grow without touching it.
 * Nothing here is shown before rules detection reads 3. Pure data: no React, no web3.
 */
const DAY = 86_400;

/** House bets (games.rs, keeper.rs). Stakes in lamports. */
export const MIN_STAKE = 10_000_000n;
export const COINFLIP_CHANCE_BPS = 5_000;
export const MIN_CHANCE_BPS = 100;
export const MAX_CHANCE_BPS = 9_500;
export const MIN_TARGET_BPS = 10_500;
export const MAX_TARGET_BPS = 1_000_000;
/** payout_bps = RTP_NUMERATOR / chance_bps (98% paid back by construction, floored) */
export const RTP_NUMERATOR = 98_000_000;
/** Bet.game bits: bit 7 = placed through place_bet_v2 (keeper chain), bit 6 = anchored, bits 0-5 = the game id. */
export const BET_KEEPER = 0x80;
export const BET_ANCHORED = 0x40;
export const BET_GAME_MASK = 0x3f;
/** Bet.target_slot of a keeper bet = chain index << 40 | anchor slot. */
export const BET_SLOT_BITS = 40n;

/** The house keeper seat (keeper.rs). */
export const KEEPER_NOTICE = 7 * DAY;
/** A seat with no arm, reveal or settle for this long can be taken by anyone posting a bond (take_keeper). */
export const KEEPER_DEAD_DELAY = 28 * DAY;
/** An anchored bet the keeper has not revealed this many slots after its anchor is refundable as a WIN, from the bond. */
export const KEEPER_STALL_SLOTS = 235_000;
export const KEEPER_MAX_CHAIN = 16_777_215;
/**
 * Dated opening (r9): from this time (2026-12-16 00:00:00 UTC) a seat that was never created can be created by ANY
 * signer through arm_keeper, with its own hash chain and its own bond of at least KEEPER_BOND_MIN; before it, only the
 * initial keeper key can create it.
 */
export const KEEPER_OPEN_TS = 1_797_379_200;
/** A v3 Jackpot draw refunds every entry when more than this many earlier keeper positions are still unrevealed. */
export const JACKPOT_MAX_BACKLOG = 32;
/** A Jackpot round closes this long after its first entry (~10 min). */
export const JACKPOT_DURATION = DAY / 144 + 2;

/** Sealed Artifact Duel (p2p.rs). No Artifact is needed. */
export const DUEL_MIN_STAKE = 100_000_000n;
/** An offer created under the final rules can be joined this long. */
export const P2P_OFFER_TTL = DAY;
/** The joiner opens its sealed element within this window after its join (not in the join's own second). */
export const DUEL_JOIN_REVEAL_WINDOW = 600;
/** The creator reveals within this window after the joiner opened. */
export const DUEL_REVEAL_WINDOW = DAY / 24 + 2;

/** Sealed Moon Wars (wars.rs). */
export const WAR_MIN_STAKE = 100_000_000n;
/** The creator opens its entropy within this window after the join (else the match is a draw: both refunded). */
export const WAR_SEED_WINDOW = 600;
/** The joiner opens its secret within this window after the seed (else the creator wins). */
export const WAR_REVEAL_WINDOW = 120;
/** The creator's first turn: never charged to its bank. */
export const WAR_FIRST_TURN_GRACE = 600;
/** Each turn's first seconds are free; beyond them the mover's bank pays. */
export const WAR_TURN_FREE = 30;
/** Chess-clock bank per side. */
export const WAR_TIME_BANK = 300;
/** A single turn never lasts longer than this (free part + at most 90 s of bank). */
export const WAR_TURN_TIMEOUT = 120;
export const WAR_MAX_ROUNDS = 100;
/** Bit 63 of War.target_slot: a match created by the final binary (sealed start, chess clock). */
export const WAR_V2 = 1n << 63n;
