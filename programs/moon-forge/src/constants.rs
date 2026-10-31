//! Every economic parameter of the protocol lives here.
//! They are compile-time constants: once the upgrade authority is burned,
//! nobody (including the architect) can change them.

use anchor_lang::prelude::*;

// ─── Identities ─────────────────────────────────────────────────────────────
/// Architect wallet at initialize_v2 (the payee lives in Config.architect and may be rotated or renounced
/// through set_architect). Receives ONLY: 0.5% of house-game volume (a slice of the 2% edge),
/// 0.5% of decided P2P pots, 5% of the NFT forge price and 5% of native Artifact sales.
/// Never anything from the burn → XNT path.
#[cfg(not(feature = "localnet"))]
pub const ARCHITECT: Pubkey = pubkey!("7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd");
/// First oracle key. It can only publish epoch roots (bounded by EPOCH_BUDGET_BPS)
/// and hand its role to a new key (two-step). It cannot move funds.
#[cfg(not(feature = "localnet"))]
pub const INITIAL_ORACLE: Pubkey = pubkey!("J5CU45Didfq7ng9JHXyxYqN7TwAGjMgEyhUcrV7Aixba");
/// First house keeper (hash-chain randomness). Generated on the keeper VPS, NEVER the GitHub KEEPER_PRIVATE_KEY (K-4). OD-25.
/// Placeholder until OD-25 is filled: the mainnet compile guard below refuses Pubkey::default().
#[cfg(not(feature = "localnet"))]
pub const INITIAL_KEEPER: Pubkey = pubkey!("11111111111111111111111111111111");

// Test-only identities (keys in tests/fixtures, worthless). Used ONLY by `--features localnet`.
#[cfg(feature = "localnet")]
pub const ARCHITECT: Pubkey = pubkey!("DL5zP1p8zDnGFGkrSUsA4bpeWaHhaDVBwyXc2xyxiZsq");
#[cfg(feature = "localnet")]
pub const INITIAL_ORACLE: Pubkey = pubkey!("7umMRWhHfzE6HUgY1xbf55z2FWgdwWeupxxJH1hNj1g9");
/// tests/fixtures/test-keeper.json
#[cfg(feature = "localnet")]
pub const INITIAL_KEEPER: Pubkey = pubkey!("HUvv7t99FhH7oxgAwjiBweqQGA7V6fpsuF4U7ExMoSRt");

/// Cold key of the first oracle seat (offline, never on GitHub). MANDATORY on mainnet (S-2): the guard refuses Pubkey::default(). OD-16.
#[cfg(not(feature = "localnet"))]
pub const SEAT_COLD_INITIAL: Pubkey = pubkey!("11111111111111111111111111111111");
/// tests/fixtures/test-cold.json (worthless). init_seat takes no arguments, so the localnet seat needs a real cold
/// key for the cold-only paths (void_epoch → rotate_hot, resign_seat, S-2) before any take_seat (theft §7).
#[cfg(feature = "localnet")]
pub const SEAT_COLD_INITIAL: Pubkey = pubkey!("36qXRZdsTVnsmRVjY6j8vnZqu12ePSNh7uuQ9tw1u81q");
/// Where the first seat's bond goes on a graceful resign. Pubkey::default() = the reward pool. OD-20.
pub const SEAT_REFUND_INITIAL: Pubkey = pubkey!("11111111111111111111111111111111");

// === FINAL-UPGRADE BLOCKERS === a mainnet SBF build fails until OD-25 (keeper) and OD-16 (cold key) are filled.
#[cfg(all(target_os = "solana", not(feature = "localnet")))]
const _: () = assert!(!mf_pk_eq(&INITIAL_KEEPER, &Pubkey::new_from_array([0; 32])), "INITIAL_KEEPER still holds the placeholder (OD-25)");
#[cfg(all(target_os = "solana", not(feature = "localnet")))]
const _: () = assert!(!mf_pk_eq(&INITIAL_KEEPER, &INITIAL_ORACLE), "INITIAL_KEEPER must not be the oracle key");
#[cfg(all(target_os = "solana", not(feature = "localnet")))]
const _: () = assert!(!mf_pk_eq(&SEAT_COLD_INITIAL, &Pubkey::new_from_array([0; 32])), "SEAT_COLD_INITIAL is mandatory on mainnet (OD-16, S-2)");
#[cfg(all(target_os = "solana", not(feature = "localnet")))]
const _: () = assert!(!mf_pk_eq(&SEAT_COLD_INITIAL, &INITIAL_ORACLE), "SEAT_COLD_INITIAL must not be the oracle key");
#[cfg(all(target_os = "solana", not(feature = "localnet")))]
const _: () = assert!(!mf_pk_eq(&SEAT_COLD_INITIAL, &ARCHITECT), "SEAT_COLD_INITIAL must not be the architect key");
#[cfg(all(target_os = "solana", not(feature = "localnet")))]
const _: () = assert!(!mf_pk_eq(&SEAT_COLD_INITIAL, &INITIAL_KEEPER), "SEAT_COLD_INITIAL must not be the keeper key");
// The localnet test keys are four distinct wallets too (the cold-only test paths would pass vacuously otherwise).
#[cfg(feature = "localnet")]
const _: () = assert!(
    !mf_pk_eq(&SEAT_COLD_INITIAL, &Pubkey::new_from_array([0; 32]))
        && !mf_pk_eq(&SEAT_COLD_INITIAL, &INITIAL_ORACLE)
        && !mf_pk_eq(&SEAT_COLD_INITIAL, &ARCHITECT)
        && !mf_pk_eq(&SEAT_COLD_INITIAL, &INITIAL_KEEPER)
        && !mf_pk_eq(&INITIAL_KEEPER, &INITIAL_ORACLE),
    "localnet test keys must be distinct"
);
// Published test keys: tests/fixtures/test-*.json carry their PRIVATE keys in the public repo. A mainnet build refuses
// them as INITIAL_KEEPER or SEAT_COLD_INITIAL (tests/check-mainnet-guards.sh proves it; its throwaway rehearsal build
// uses fresh keys). The unit test `fixture_keys_are_listed` fails on any keypair in tests/fixtures missing here.
#[allow(dead_code)] // used by the mainnet compile guards and the unit tests
pub(crate) const PUBLISHED_TEST_KEYS: [Pubkey; 4] = [
    pubkey!("DL5zP1p8zDnGFGkrSUsA4bpeWaHhaDVBwyXc2xyxiZsq"), // tests/fixtures/test-architect.json
    pubkey!("36qXRZdsTVnsmRVjY6j8vnZqu12ePSNh7uuQ9tw1u81q"), // tests/fixtures/test-cold.json
    pubkey!("HUvv7t99FhH7oxgAwjiBweqQGA7V6fpsuF4U7ExMoSRt"), // tests/fixtures/test-keeper.json
    pubkey!("7umMRWhHfzE6HUgY1xbf55z2FWgdwWeupxxJH1hNj1g9"), // tests/fixtures/test-oracle.json
];
#[allow(dead_code)] // used by the mainnet compile guards and the unit tests
pub(crate) const fn mf_is_published_test_key(k: &Pubkey) -> bool {
    let mut i = 0;
    while i < PUBLISHED_TEST_KEYS.len() {
        if mf_pk_eq(k, &PUBLISHED_TEST_KEYS[i]) {
            return true;
        }
        i += 1;
    }
    false
}
#[cfg(all(target_os = "solana", not(feature = "localnet")))]
const _: () = assert!(!mf_is_published_test_key(&INITIAL_KEEPER), "INITIAL_KEEPER is a published test key (tests/fixtures)");
#[cfg(all(target_os = "solana", not(feature = "localnet")))]
const _: () = assert!(!mf_is_published_test_key(&SEAT_COLD_INITIAL), "SEAT_COLD_INITIAL is a published test key (tests/fixtures)");

/// Time unit. Real seconds on mainnet; the localnet test build compresses days into seconds
/// so the integration tests can exercise vesting, rounds and intervals.
#[cfg(not(feature = "localnet"))]
const DAY: i64 = 24 * 60 * 60;
#[cfg(feature = "localnet")]
const DAY: i64 = 1;
pub const MPL_CORE_ID: Pubkey = pubkey!("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
pub const SLOT_HASHES_ID: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");

pub const BPS: u64 = 10_000;
pub const XNT: u64 = 1_000_000_000; // 1 XNT = 1e9 lamports

// ─── PDA seeds ──────────────────────────────────────────────────────────────
pub const SEED_CONFIG: &[u8] = b"config";
pub const SEED_REWARD_VAULT: &[u8] = b"reward_vault";
pub const SEED_BANKROLL_VAULT: &[u8] = b"bankroll_vault";
pub const SEED_DRAW_VAULT: &[u8] = b"draw_vault";
pub const SEED_EPOCH: &[u8] = b"epoch";
pub const SEED_RECEIPT: &[u8] = b"receipt";
pub const SEED_MISSION: &[u8] = b"mission";
pub const SEED_PLAYER: &[u8] = b"player";
pub const SEED_BET: &[u8] = b"bet";
pub const SEED_HOUSE: &[u8] = b"house";
pub const SEED_JACKPOT: &[u8] = b"jackpot";
pub const SEED_JP_ENTRY: &[u8] = b"jp_entry";
pub const SEED_DUEL: &[u8] = b"duel";
pub const SEED_WAR: &[u8] = b"war";
pub const SEED_PRED: &[u8] = b"pred";
pub const SEED_PRED_ENTRY: &[u8] = b"pred_entry";
pub const SEED_DRAW: &[u8] = b"draw";
pub const SEED_DRAW_ENTRY: &[u8] = b"draw_entry";
pub const SEED_COLLECTION: &[u8] = b"collection";
pub const SEED_ART_AUTHORITY: &[u8] = b"artifact_authority";
pub const SEED_ASSET: &[u8] = b"asset";
pub const SEED_ARTIFACT: &[u8] = b"artifact";
pub const SEED_AIRDROP: &[u8] = b"airdrop";
pub const SEED_DROP: &[u8] = b"drop";
// v1 accounts swept into the reward pool by `sweep_legacy`
pub const SEED_LEGACY_STATE: &[u8] = b"protocol_state";
pub const SEED_LEGACY_ESCROW: &[u8] = b"dev_escrow";
// final upgrade (v3)
pub const SEED_ORACLE_SEAT: &[u8] = b"oracle_seat"; // PDA EQ5BTUsYou2ndMw8SXdJVwNSz4nLABSuX6WxwT2doVGq, bump 255
pub const SEED_EXTRA_STATE: &[u8] = b"extra_state"; // PDA FF4CHxw1XgCMYv9Q48yB8qX4W19oDcGK2wrqZhEEvYrE, bump 255
pub const SEED_EXTRA_VAULT: &[u8] = b"extra_vault"; // PDA GRGxMQDjNg4DwoL69y2p1x14fSzeaKeCHVLkAb67Z9d2, bump 255
pub const SEED_EXTRA_EPOCH: &[u8] = b"extra_epoch";
pub const SEED_LISTING: &[u8] = b"listing";
pub const SEED_HOUSE_KEEPER: &[u8] = b"house_keeper"; // PDA Hb8Er2uoJKEWDgkJPncFQa5sVidqr34NEatqEDqnhj85, bump 255

// ─── Forge (burn → XNT) ─────────────────────────────────────────────────────
/// Each epoch distributes at most 10% of the FREE reward pool (balance minus
/// rent minus budgets still reserved for open epochs). Computed on-chain.
/// The hard bound per epoch is the budget plus the D-47 oracle allowance (together ≤ 10% of free) + the drop
/// overrun of a legacy epoch (≤ drop_reserve ≤ 1% of free) + keeper tips.
pub const EPOCH_BUDGET_BPS: u64 = 1_000;
/// Minimum time between two published epochs. Caps oracle damage to 10% per 6 days.
pub const MIN_EPOCH_INTERVAL: i64 = 6 * DAY;
/// Claims are open for 90 days; afterwards the unclaimed budget returns to the pool.
pub const CLAIM_WINDOW: i64 = 90 * DAY;
/// Vesting per tier: Launchpad pays instantly, Orbit 45 days, Moon Landing 180 days.
pub const TIER_DURATION: [i64; 3] = [0, 45 * DAY, 180 * DAY];
/// Penalty on the UNVESTED part when ejecting. 100% of it goes back to the reward pool.
/// Chosen so that ejecting immediately pays less than Launchpad
/// (Orbit 2x * 0.40 = 0.80x, Moon Landing 3x * 0.25 = 0.75x).
pub const TIER_PENALTY_BPS: [u64; 3] = [0, 6_000, 7_500];
/// Gas rebate paid BY THE POOL (never by the user) to whoever submits a claim for someone else.
pub const KEEPER_TIP: u64 = 2_000_000; // 0.002 XNT
/// No tip below this claim (0.2 XNT): the tip is at most 1% of the claim, and there is no tip when the
/// payer is the player or the oracle (a sybil splitting burns into dust leaves cannot farm tips).
pub const KEEPER_TIP_MIN_CLAIM: u64 = 100 * KEEPER_TIP;
/// G-2 (round 4, KEEPER-INCOME option 1): what settle_bet_v2 pays the registered keeper wallet from the reward vault
/// for one settled bet: at most this, at most half of the bet's own pool share (EDGE_TO_POOL_BPS of the stake), at
/// most the free pool. Never on a refund, a stall or a skipped position. Booked in `stats.keeper_tips`.
pub const KEEPER_SETTLE_TIP: u64 = 500_000; // 0.0005 XNT
const _: () = assert!(KEEPER_SETTLE_TIP < KEEPER_TIP);
/// D-47 oracle operating allowance, paid by `publish_epoch` from the FREE reward pool to the oracle key that publishes:
/// the Epoch account's rent back, plus a top-up that brings the oracle wallet up to ORACLE_TOPUP_TARGET, at most
/// ORACLE_TOPUP_MAX per epoch. It is a running cost of the pool (booked in `stats.keeper_tips`), never architect
/// income (nothing is paid while `config.oracle == config.architect`), and it only takes what the 10% bound leaves
/// after the epoch's budget: `budget + allowance ≤ 10%` of the free pool, the budget computed first and never lowered.
/// With MIN_EPOCH_INTERVAL the most the hot key can draw is ORACLE_TOPUP_MAX + one Epoch rent per 6 days (only a
/// cold-key void, which resets the interval, lets the next publication come sooner).
pub const ORACLE_TOPUP_TARGET: u64 = 250_000_000; // 0.25 XNT
pub const ORACLE_TOPUP_MAX: u64 = 50_000_000; // 0.05 XNT per epoch
const _: () = assert!(ORACLE_TOPUP_MAX <= ORACLE_TOPUP_TARGET);
/// D-47: the allowance never takes more than this share of the epoch's 10% bound (1% of the free pool), so a small pool
/// keeps at least 90% of its bound for the burners. From a free pool of about 5.24 XNT up, the rent + ORACLE_TOPUP_MAX
/// cap binds first and this share never does.
pub const ORACLE_ALLOWANCE_BOUND_BPS: u64 = 1_000;
const _: () = assert!(ORACLE_ALLOWANCE_BOUND_BPS <= BPS);
/// Domain separators for Merkle leaves (prevents cross-use of proofs).
pub const LEAF_DOMAIN_FORGE: &[u8] = b"MOONFORGE_V2_CLAIM";
pub const LEAF_DOMAIN_AIRDROP: &[u8] = b"MOONFORGE_V2_AIRDROP";
pub const LEAF_DOMAIN_EXTRA: &[u8] = b"MOONFORGE_V3_EXTRA";
/// No claim (base, mission, legacy drop, extra) before publish + CLAIM_HOLD: the public verifies in that window.
pub const CLAIM_HOLD: i64 = 2 * DAY;
const _: () = assert!(CLAIM_HOLD < MIN_EPOCH_INTERVAL && CLAIM_HOLD < CLAIM_WINDOW);

// ─── Forge Drops (legacy epochs only) ───────────────────────────────────────
/// Forge Drops are OFF for good since the final upgrade: `publish_epoch` always writes `drop_reserve = 0`.
/// The constants below exist only to settle epochs published by the v2 binary
/// (cap = reserve + max(reserve, DROP_LUCK_BUFFER), drops.rs:92).
pub const DROP_BUDGET_BPS: u64 = 1_000;
pub const DROP_TIER: u8 = 0;
/// The initial recycle value of a Lunar Dust (50% of its base forge price) = 5 XNT. Legacy drop cap only.
pub const DROP_BACKING: u64 = ARTIFACT_PRICE[0] / BPS * FORGE_BACKING_BPS;
pub const MAX_DROPS_PER_EPOCH: u64 = 20;
/// Luck can draw more winners than expected. Overruns come from the free pool, bounded:
/// a legacy epoch never pays more than drop_reserve + max(drop_reserve, DROP_LUCK_BUFFER) in drops.
pub const DROP_LUCK_BUFFER: u64 = 3 * DROP_BACKING;
/// The drop seed is the hash of the first block at or after publish slot + this delay:
/// unknown to the oracle when it signs the epoch.
pub const DROP_SEED_DELAY_SLOTS: u64 = 4;
/// Paid by the pool to whoever delivers a legacy drop to someone else (covers the rent of the
/// new Artifact, its record and the drop receipt).
pub const DROP_KEEPER_TIP: u64 = 10_000_000; // 0.01 XNT
pub const DROP_NONE: u8 = 0;
pub const DROP_PENDING: u8 = 1;
pub const DROP_SEALED: u8 = 2;
pub const DROP_CANCELLED: u8 = 3;

// ─── Chips ──────────────────────────────────────────────────────────────────
/// Retired since the final upgrade: no instruction grants chips (ECO-3). Kept for the record; no consumer.
pub const CHIP_PER_CLAIMED: u64 = XNT;
pub const CHIP_PER_WAGERED: u64 = 10 * XNT;

// ─── House games (Coin Flip, High-Low, Void Rush) ───────────────────────────
pub const HOUSE_EDGE_BPS: u64 = 200; // 2% total edge, built into the odds
pub const EDGE_TO_POOL_BPS: u64 = 100; // 1.0% of every stake -> reward pool (burners)
pub const EDGE_TO_ARCHITECT_BPS: u64 = 50; // 0.5% of every stake -> architect
// the remaining 0.5% stays in the bankroll (House LPs)
pub const MIN_STAKE: u64 = 10_000_000; // 0.01 XNT
/// A single bet can never risk more than 0.25% of the free bankroll (net of its own stake).
/// Only 0.5% of the edge stays in the bankroll, so a larger cap would push its log-growth to <= 0.
pub const MAX_EXPOSURE_BPS: u64 = 25;
/// All unsettled gross payouts together ≤ 5% of the bankroll when a bet is placed. LP exits while
/// bets are pending can raise the ratio for the remaining LPs.
pub const MAX_TOTAL_EXPOSURE_BPS: u64 = 500;
/// Circuit breaker (OD-1): counting every unsettled bet as won, the new one included, the bankroll net
/// of LP flows loses at most 3% per UTC day against its OPTIMISTIC value at the day's first bet.
/// This is the bound on block producers that grind or withhold deciding blocks.
pub const MAX_DAILY_LOSS_BPS: u64 = 300;
pub const DAY_SECONDS_FOR_BREAKER: i64 = DAY;
/// Rolling limit: realized net loss of the bankroll on v2 bets in the current 7-day window, plus every pending
/// payout, may not exceed 15% of the optimistic bankroll at the window start (market §3; sim-sens H3/H4).
pub const MAX_WEEKLY_LOSS_BPS: u64 = 1_500;
pub const WEEK_WINDOW: i64 = 7 * DAY;
/// Bit 7 of Bet.game: v3 keeper bet (index in the chain packed in target_slot bits 40..63).
pub const BET_KEEPER: u8 = 0x80;
/// Bit 6 of Bet.game: the anchor block hash has been mixed into Bet.seed (anchor_bet ran).
pub const BET_ANCHORED: u8 = 0x40;
pub const BET_GAME_MASK: u8 = 0x3f;
pub const BET_SLOT_BITS: u32 = 40;
pub const BET_SLOT_MASK: u64 = (1 << BET_SLOT_BITS) - 1;
const _: () = assert!(GAME_VOIDRUSH < BET_ANCHORED);
/// Keeper seat: bond floor (also covers any Jackpot round: JACKPOT_MAX_POT), notice for a hand-over AND for a bond
/// withdrawal (K-4), dead-seat delay, stall limit for an anchored bet (≈ 1 day at 0.3678 s/slot, OD-31: the anchor
/// itself only needs the 512-slot SlotHashes window), longest chain.
pub const KEEPER_BOND_MIN: u64 = 20 * XNT;
#[cfg(not(feature = "localnet"))]
pub const KEEPER_NOTICE: i64 = 7 * DAY;
#[cfg(feature = "localnet")]
pub const KEEPER_NOTICE: i64 = 3;
pub const KEEPER_DEAD_DELAY: i64 = 28 * DAY;
#[cfg(not(feature = "localnet"))]
pub const KEEPER_STALL_SLOTS: u64 = 235_000;
#[cfg(feature = "localnet")]
pub const KEEPER_STALL_SLOTS: u64 = 40;
pub const KEEPER_MAX_CHAIN: u64 = (1 << 24) - 1;
const _: () = assert!(KEEPER_BOND_MIN >= JACKPOT_MAX_POT);
pub const COINFLIP_CHANCE_BPS: u64 = 5_000;
pub const MIN_CHANCE_BPS: u64 = 100; // High-Low: 1%..95% win chance
pub const MAX_CHANCE_BPS: u64 = 9_500;
pub const MIN_TARGET_BPS: u64 = 10_500; // Void Rush: 1.05x .. 100x
pub const MAX_TARGET_BPS: u64 = 1_000_000;
/// payout_bps = RTP_NUMERATOR / chance_bps  (98% return to player)
pub const RTP_NUMERATOR: u64 = (BPS - HOUSE_EDGE_BPS) * BPS;

// ─── P2P games (Jackpot, Artifact Duel; Burn Lottery tickets retired) ───────
pub const P2P_RAKE_BPS: u64 = 200; // 2% of the pot, only when someone wins
pub const RAKE_TO_POOL_BPS: u64 = 150; // 1.5% -> reward pool (the former 0.5% lottery share, OD-27 / ECO-6)
pub const RAKE_TO_ARCHITECT_BPS: u64 = 50; // 0.5% -> architect
// the remaining share -> draw vault = 0 since the final upgrade
pub const JACKPOT_DURATION: i64 = DAY / 144 + 2; // ~10 min after the first entry (2 s on localnet)
pub const DUEL_MIN_STAKE: u64 = 100_000_000; // 0.1 XNT
pub const DUEL_REVEAL_WINDOW: i64 = DAY / 24 + 2; // creator must reveal within ~1 hour (2 s on localnet)
/// One decided round can never take more than this (OD-2).
pub const JACKPOT_MAX_POT: u64 = 20 * XNT;
/// A v3 Jackpot draw refunds at once (reason 3, no penalty) when more than this many earlier keeper-chain positions
/// are still unrevealed (finding M1, g3-fixes): the keeper must reveal all of them, in order, before the round's
/// anchor block leaves SlotHashes (512 slots). 32 positions are a few sequential settle transactions; without the
/// cap a flood of MIN_STAKE bets just before the draw could force an expiry that costs the bond the whole pot.
pub const JACKPOT_MAX_BACKLOG: u64 = 32;
const _: () = assert!(JACKPOT_MAX_BACKLOG >= 1 && JACKPOT_MAX_BACKLOG * 8 <= 512);
/// Sealed duel join: the joiner must open its element within this window (10 min; 4 s localnet).
#[cfg(not(feature = "localnet"))]
pub const DUEL_JOIN_REVEAL_WINDOW: i64 = 600;
#[cfg(feature = "localnet")]
pub const DUEL_JOIN_REVEAL_WINDOW: i64 = 4;
/// Duel and Moon Wars offers created by v3 can be joined only this long after creation (OD-5).
#[cfg(not(feature = "localnet"))]
pub const P2P_OFFER_TTL: i64 = 86_400;
#[cfg(feature = "localnet")]
pub const P2P_OFFER_TTL: i64 = 60;

// ─── Moon Wars (PvP card battle with stakes; same rules as the free practice) ─
/// Each side plays the same 10-card deck (4 Lunar, 3 Cosmic, 2 Solar, 1 Void). Since the final upgrade the
/// decks come from keccak(MOONFORGE_WAR_V2 ‖ creator entropy ‖ joiner secret ‖ war), with no block hash;
/// the first mover is drawn from the same seed. The draw order is public to both once the match starts
/// (perfect information, like chess), so the better player wins. 20 HP, mana = min(10, ceil(round/2)+1),
/// summoned units attack from the next turn, enemy units must be destroyed before hitting the
/// player, a Solar Core burns 2 HP when it enters play, an empty deck deals 1 fatigue damage.
pub const WAR_MIN_STAKE: u64 = 100_000_000; // 0.1 XNT
pub const WAR_START_HP: i8 = 20;
pub const WAR_DECK: [u8; 10] = [0, 0, 0, 0, 1, 1, 1, 2, 2, 3];
/// (power, defense, cost) per element: Lunar, Cosmic, Solar, Void
pub const WAR_CARDS: [(i8, i8, u8); 4] = [(2, 2, 1), (4, 3, 2), (6, 4, 3), (10, 10, 5)];
pub const WAR_SOLAR_BURN: i8 = 2;
pub const WAR_FIELD_MAX: usize = 6;
pub const WAR_HAND_MAX: usize = 10;
pub const WAR_MAX_ROUNDS: u16 = 100; // then a draw (both refunded)
/// Legacy matches: a player who does not finish their turn in time loses (2 minutes; 8 s on localnet).
#[cfg(not(feature = "localnet"))]
pub const WAR_TURN_TIMEOUT: i64 = 120;
#[cfg(feature = "localnet")]
pub const WAR_TURN_TIMEOUT: i64 = 8;
/// Bit 63 of War.target_slot: match created by v3 (sealed start). Exactly WAR_V2 while OPEN/STARTING;
/// WAR_V2 | creator_bank << 16 | opponent_bank (chess-clock seconds, u16 each) once ACTIVE/DONE.
pub const WAR_V2: u64 = 1 << 63;
#[cfg(not(feature = "localnet"))]
pub const WAR_SEED_WINDOW: i64 = 600; // creator's seed step after a join
#[cfg(not(feature = "localnet"))]
pub const WAR_REVEAL_WINDOW: i64 = 120; // joiner's reveal after the seed
#[cfg(not(feature = "localnet"))]
pub const WAR_FIRST_TURN_GRACE: i64 = 600; // creator's first turn, never charged
#[cfg(not(feature = "localnet"))]
pub const WAR_TURN_FREE: i64 = 30; // OD-12
#[cfg(not(feature = "localnet"))]
pub const WAR_TIME_BANK: i64 = 300;
#[cfg(feature = "localnet")]
pub const WAR_SEED_WINDOW: i64 = 6;
#[cfg(feature = "localnet")]
pub const WAR_REVEAL_WINDOW: i64 = 4;
#[cfg(feature = "localnet")]
pub const WAR_FIRST_TURN_GRACE: i64 = 10;
#[cfg(feature = "localnet")]
pub const WAR_TURN_FREE: i64 = 4;
#[cfg(feature = "localnet")]
pub const WAR_TIME_BANK: i64 = 12;
const _: () = assert!(
    WAR_TIME_BANK <= u16::MAX as i64 && WAR_TURN_FREE < WAR_TURN_TIMEOUT && WAR_REVEAL_WINDOW <= WAR_SEED_WINDOW && WAR_SEED_WINDOW > 0
);

// ─── Predictions (pari-mutuel "XNT up or down") ──────────────────────────────
/// Price source: the time-weighted average price recorded on-chain by XDEX (a Raydium-CPMM fork)
/// for its WXNT/USDC.X pool, read from its observation ring in write order.
/// v2 schedule (rounds created since the final upgrade): round k opens at k × PRED_PERIOD (UTC); entries
/// close PRED_TWAP_WINDOW + PRED_MAX_GAP before the lock; the start price is the PRED_TWAP_WINDOW TWAP ending at
/// lock = k × PRED_PERIOD + PRED_LOCK_OFFSET, the end price the same TWAP ending PRED_HORIZON later. A ring
/// with a gap longer than PRED_MAX_GAP inside a window, no write at or before the window end, or a window
/// start that already left the ring refunds everyone (Twap::Unavailable). Mainnet day: entries 00:00–13:35 UTC;
/// start data 13:35–14:00; lock 14:00; end data 11:35–12:00 the next day; end 12:00. Each side of the pot is
/// capped at PRED_MAX_SIDE, and a v2 round whose price moved less than PRED_MIN_MOVE_BPS is a no contest.
/// v1 rounds (end − lock == PRED_V1_HORIZON) keep the schedule they were created with.
#[cfg(not(feature = "localnet"))]
pub const XDEX_PROGRAM: Pubkey = pubkey!("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
#[cfg(not(feature = "localnet"))]
pub const XDEX_XNT_POOL: Pubkey = pubkey!("CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR");
#[cfg(not(feature = "localnet"))]
pub const XDEX_XNT_OBSERVATION: Pubkey = pubkey!("4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ");
#[cfg(not(feature = "localnet"))]
pub const PRED_PERIOD: i64 = 86_400;
#[cfg(not(feature = "localnet"))]
pub const PRED_LOCK_OFFSET: i64 = 50_400; // 14:00 UTC
#[cfg(not(feature = "localnet"))]
pub const PRED_TWAP_WINDOW: u64 = 1_200;
#[cfg(not(feature = "localnet"))]
pub const PRED_MAX_GAP: u64 = 300;
#[cfg(not(feature = "localnet"))]
pub const PRED_HORIZON: i64 = 79_200; // end 12:00 UTC the next day
#[cfg(not(feature = "localnet"))]
pub const PRED_V1_BET_WINDOW: i64 = 43_200;
#[cfg(not(feature = "localnet"))]
pub const PRED_V1_HORIZON: i64 = 86_400;
#[cfg(not(feature = "localnet"))]
pub const PRED_V1_TWAP_WINDOW: u64 = 900;
#[cfg(not(feature = "localnet"))]
pub const PRED_V1_MAX_DELAY: i64 = 86_400;
// localnet: a crafted observation account (tests/fixtures) and a compressed schedule
#[cfg(feature = "localnet")]
pub const XDEX_PROGRAM: Pubkey = pubkey!("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
#[cfg(feature = "localnet")]
pub const XDEX_XNT_POOL: Pubkey = pubkey!("CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR");
#[cfg(feature = "localnet")]
pub const XDEX_XNT_OBSERVATION: Pubkey = pubkey!("4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ");
#[cfg(feature = "localnet")]
pub const PRED_PERIOD: i64 = 120;
#[cfg(feature = "localnet")]
pub const PRED_LOCK_OFFSET: i64 = 90;
#[cfg(feature = "localnet")]
pub const PRED_TWAP_WINDOW: u64 = 30;
#[cfg(feature = "localnet")]
pub const PRED_MAX_GAP: u64 = 25;
#[cfg(feature = "localnet")]
pub const PRED_HORIZON: i64 = 60;
#[cfg(feature = "localnet")]
pub const PRED_V1_BET_WINDOW: i64 = 20;
#[cfg(feature = "localnet")]
pub const PRED_V1_HORIZON: i64 = 20;
#[cfg(feature = "localnet")]
pub const PRED_V1_TWAP_WINDOW: u64 = 10;
#[cfg(feature = "localnet")]
pub const PRED_V1_MAX_DELAY: i64 = 30;
pub const PRED_MAX_POT: u64 = 200 * XNT;
pub const PRED_MAX_SIDE: u64 = PRED_MAX_POT / 2;
/// v2 rounds: |end - start| < 1% of start = no contest, full refund
pub const PRED_MIN_MOVE_BPS: u64 = 100;
const _: () = assert!(PRED_HORIZON != PRED_V1_HORIZON);
const _: () = assert!(PRED_HORIZON + PRED_TWAP_WINDOW as i64 + (PRED_MAX_GAP as i64) < PRED_PERIOD);
const _: () = assert!(PRED_HORIZON > PRED_TWAP_WINDOW as i64 + PRED_MAX_GAP as i64);
const _: () = assert!(PRED_LOCK_OFFSET >= PRED_TWAP_WINDOW as i64 + PRED_MAX_GAP as i64 && PRED_LOCK_OFFSET < PRED_PERIOD);
const _: () = assert!(PRED_MAX_GAP < PRED_TWAP_WINDOW);
// 100 XDEX writes at >= 15 s apart always span 1,485 s: the window start (+15 s) stays in the ring for 270 s after the time
const _: () = assert!(PRED_TWAP_WINDOW + 15 + 270 <= 99 * 15);
/// Burn Lottery (tickets retired since the final upgrade; a round open at the upgrade still draws and settles).
/// Entries close at the earlier of end_ts and the fixed drawing block.
pub const DRAW_DURATION: i64 = 7 * DAY;
// DRAW_ANCHOR_SLOTS removed in round 4 (review F4): no instruction read it; a round open at the upgrade is drawn, as
// before, on the slot after draw_draw (p2p.rs).
pub const TICKET_PRICE: u64 = XNT; // 1 ticket = 1 XNT = same weight as 1 chip
pub const DRAW_PRIZE_BPS: u64 = 5_000; // winner takes 50% of the draw vault, rest rolls over

// ─── Be the House (bankroll LP) ─────────────────────────────────────────────
pub const HOUSE_MIN_DEPOSIT: u64 = XNT;
pub const HOUSE_WITHDRAW_DELAY: i64 = DAY;
/// A matured withdrawal request is usable in [unlock_ts, unlock_ts + this), then must be renewed (OD-8).
#[cfg(not(feature = "localnet"))]
pub const HOUSE_WITHDRAW_WINDOW: i64 = DAY;
#[cfg(feature = "localnet")]
pub const HOUSE_WITHDRAW_WINDOW: i64 = 60;
/// Permanent protocol shares minted with the very first LP deposit (blocks share-inflation
/// attacks on an empty bankroll). Worth at most 0.001 XNT.
pub const HOUSE_DEAD_SHARES: u64 = 1_000_000;

// ─── Artifacts (Metaplex Core NFTs) ─────────────────────────────────────────
pub const TIER_NAMES: [&str; 4] = ["Lunar Dust", "Cosmic Shard", "Solar Core", "Void Anomaly"];
pub const TIER_SLUGS: [&str; 4] = ["lunar_dust", "cosmic_shard", "solar_core", "void_anomaly"];
pub const ARTIFACT_SUPPLY: [u16; 4] = [600, 300, 90, 10]; // max ALIVE at any time
/// PX pricing (market §1, OD-23). Every tier is dynamic. A forge multiplies the tier's price by PRICE_UP;
/// each full PRICE_DECAY_PERIOD without a forge divides it by PRICE_UP (same ratio), down to MIN_PRICE_BPS of
/// base and never above MAX_PRICE_MULTIPLE × base. The price does not decay while the tier is full (alive ==
/// supply); recycling or reclaiming from a full tier restarts the decay clock. A tier never forged (stored
/// price 0) decays from PRICE_LAUNCH_TS. Pure function of config + clock; no oracle.
pub const ARTIFACT_PRICE: [u64; 4] = [10 * XNT, 25 * XNT, 60 * XNT, 200 * XNT]; // base, unchanged
pub const PRICE_UP_NUM: [u64; 4] = [51, 21, 21, 21]; // +2% / +5% / +5% / +5%
pub const PRICE_UP_DEN: [u64; 4] = [50, 20, 20, 20];
pub const PRICE_DECAY_PERIOD: [i64; 4] = [DAY, 3 * DAY, 7 * DAY, 14 * DAY];
pub const MIN_PRICE_BPS: [u64; 4] = [3_000, 5_000, 5_000, 5_000]; // 3 / 12.5 / 30 / 100 XNT
pub const MAX_PRICE_MULTIPLE: u64 = 10;
/// Longest decay walk: from 10× base to 30% of base at ÷1.02 per step: ceil(ln(33.33)/ln(1.02)) = 178 (the integer
/// walk ×50/51 from 100 XNT leaves 3,004,481,921 lamports after 177 steps and reaches the 3 XNT minimum at 178;
/// LB-4/ECO-8). 180 keeps a margin; Cosmic/Solar/Void need 62.
pub const PRICE_MAX_STEPS: u64 = 180;
/// Decay start for never-forged tiers: set at S2 to the planned S7 date + 7 days (OD-23). 2026-11-24 00:00 UTC.
#[cfg(not(feature = "localnet"))]
pub const PRICE_LAUNCH_TS: i64 = 1_795_478_400;
/// Localnet: DAY = 1 s on a wall-clock validator, so a real date would put every never-forged tier at its floor
/// from day one. i64::MAX = 0 decay periods: a never-forged tier sits at base until its first forge (B-7 is
/// deterministic). Decay from launch is covered by the unit tests, which build with the mainnet constants.
#[cfg(feature = "localnet")]
pub const PRICE_LAUNCH_TS: i64 = i64::MAX;
pub const ARTIFACT_VARIANTS: [u32; 4] = [6, 3, 2, 1];
/// Weekly chips are retired (nft-extra B1): claim_artifact_chips returns ChipsRetired.
pub const ARTIFACT_WEEKLY_CHIPS: [u64; 4] = [0, 0, 0, 0];
/// Forge price split (nft-extra A1): 50% floor inside the NFT, 20% base pot (reward_vault), 25% extra pot
/// (extra_vault), 5% architect, 0% Burn Lottery.
pub const FORGE_BACKING_BPS: u64 = 5_000;
pub const FORGE_POOL_BPS: u64 = 2_000;
pub const FORGE_EXTRA_BPS: u64 = 2_500;
pub const FORGE_DRAW_BPS: u64 = 0;
pub const FORGE_ARCHITECT_BPS: u64 = 500;
const _: () = assert!(FORGE_BACKING_BPS + FORGE_POOL_BPS + FORGE_EXTRA_BPS + FORGE_DRAW_BPS + FORGE_ARCHITECT_BPS == BPS);
const _: () = assert!(MIN_PRICE_BPS[0] * MAX_PRICE_MULTIPLE > 0 && PRICE_MAX_STEPS >= 178);
/// Royalty declared on the Core collection for secondary sales (marketplaces that honor it).
pub const SECONDARY_ROYALTY_BPS: u16 = 500;
pub const AIRDROP_MAX: u16 = 120; // free Lunar Dust for active X1 wallets (no floor)
/// Genesis claims stay open through 2027-03-31 and close at 2027-04-01 00:00 UTC (D-29: the live program's
/// 2027-01-01 00:00 UTC, extended by the length of the pause): whatever is unclaimed by then is never minted, so
/// every Lunar Dust slot stays available for forging.
pub const AIRDROP_DEADLINE: i64 = 1_806_537_600;
const _: () = assert!(AIRDROP_DEADLINE == 1_798_761_600 + 90 * 86_400); // 90 real days (DAY is 1 s on localnet)
pub const WEEK: i64 = 7 * 24 * 60 * 60;
pub const COLLECTION_NAME: &str = "Moon Forge Artifacts";

// ─── Extra pot (usage rebate) ───────────────────────────────────────────────
/// Extra pot (nft-extra A4): a release of at most 8% of the pot's free balance per extra epoch, and at most 4% of the
/// live forged backing (+ backing that left since the last publish). Leaves ≤ 1,000 (= Σ ARTIFACT_SUPPLY).
pub const EXTRA_RELEASE_BPS: u64 = 800;
pub const EXTRA_BACKING_BOUND_BPS: u64 = 400;
pub const EXTRA_MAX_LEAVES: u32 = 1_000;
pub const EXTRA_BITMAP_BYTES: usize = 125;
const _: () = assert!(EXTRA_MAX_LEAVES as usize == EXTRA_BITMAP_BYTES * 8);
const _: () = assert!(
    EXTRA_MAX_LEAVES as u64
        == ARTIFACT_SUPPLY[0] as u64 + ARTIFACT_SUPPLY[1] as u64 + ARTIFACT_SUPPLY[2] as u64 + ARTIFACT_SUPPLY[3] as u64
);
/// Oracle amendment A13.3 (OWNER-A12-3): the backing bound of an extra epoch is `weeks` 7-day weeks' worth,
/// weeks × ⌊backing × 4%⌋; the release term (8% of free) is NOT scaled. `weeks` is the oracle's
/// k = max(1, ⌊(window + EXTRA_WEEK_SLACK) / EXTRA_WEEK⌋) of the base window [published_at(id − 1), snapshot(id)],
/// capped at EXTRA_MAX_WEEKS; publish_extra_epoch bounds it by the same formula on the base epochs' own published_at
/// gap (the snapshot precedes published_at(id), so a legitimate k never exceeds it).
pub const EXTRA_WEEK: i64 = 7 * DAY;
/// The oracle's MAX_PUBLISH_LAG (6 h): a window starts at the previous publication, up to 6 h after its weekly slot.
pub const EXTRA_WEEK_SLACK: i64 = DAY / 4;
/// Sanity cap on `weeks`: ⌈CLAIM_WINDOW / 1 week⌉ = 13. A longer window (no oracle for a quarter) carries 13 weeks' worth.
pub const EXTRA_MAX_WEEKS: u8 = 13;
const _: () = assert!(EXTRA_WEEK_SLACK < EXTRA_WEEK && EXTRA_MAX_WEEKS >= 2);
const _: () = assert!(
    (EXTRA_MAX_WEEKS as i64 - 1) * EXTRA_WEEK < CLAIM_WINDOW && EXTRA_MAX_WEEKS as i64 * EXTRA_WEEK >= CLAIM_WINDOW
);

// ─── Oracle seat (theft containment; see docs/ORACLE-SEAT.md) ───────────────
/// A seat with no epoch that survived its hold for this long is dead: anyone may take it.
pub const DEAD_SEAT_DELAY: i64 = 28 * DAY;
/// Head start of the priority taker (largest void bond of the generation, or the named successor).
pub const SEAT_PRIORITY_WINDOW: i64 = DAY;
/// Void bond: VOID_BOND_BPS of the epoch's full budget (budget + drop reserve), at least VOID_BOND_MIN. Paid to the pool.
pub const VOID_BOND_BPS: u64 = 1_000;
pub const VOID_BOND_MIN: u64 = 50_000_000; // 0.05 XNT
/// Seat bond: SEAT_BOND_BPS of the free pool at take time, at least SEAT_BOND_MIN. Forfeited if the seat dies.
pub const SEAT_BOND_BPS: u64 = 1_000;
pub const SEAT_BOND_MIN: u64 = XNT;
/// Epochs that fit inside DEAD_SEAT_DELAY at the plain MIN_EPOCH_INTERVAL. NOT the walk bound itself: take_seat /
/// resign_seat walk up to seat.rs `SEAT_WALK_PAIRS` = 2 × SEAT_WALK_MAX + 1 pairs (cold-void waivers, g2 deviation 1).
pub const SEAT_WALK_MAX: usize = (DEAD_SEAT_DELAY / MIN_EPOCH_INTERVAL + 1) as usize; // 5

// ─── Artifact Market (escrowless native sales) ──────────────────────────────
/// Royalty on every native sale, to the architect (same value the collection's Royalties plugin declares).
pub const MARKET_ROYALTY_BPS: u64 = SECONDARY_ROYALTY_BPS as u64; // 500
/// Fee on every native sale to the reward_vault (BASE pot). Never to the extra pot, never to the lottery.
pub const MARKET_POOL_BPS: u64 = 200;
/// Smallest list price (Genesis Lunar Dust has no floor). Keeps fees > 0 and listings non-dust.
pub const MARKET_MIN_PRICE: u64 = 100_000_000; // 0.1 XNT
/// A listing expires at most this long after it is (re)written. 0 = no expiry is NOT allowed (stale delegations age out).
pub const MARKET_MAX_LISTING: i64 = 90 * DAY;
const _: () = assert!(MARKET_ROYALTY_BPS + MARKET_POOL_BPS < BPS);

// ─── Metadata ───────────────────────────────────────────────────────────────
/// === FINAL-UPGRADE BLOCKER === Arweave path manifest with collection.json, lunar_dust/0..5.json,
/// cosmic_shard/0..2.json, solar_core/0..1.json, void_anomaly/0.json (13 paths, final texts, no boost promise).
/// Replace the placeholder with the metadataBaseUri of ONE set in deployments/nft-arweave-final.json, only after 7
/// consecutive passing UTC days of scripts/nft-metadata/check-gateways.mjs (27/27 on turbo-gateway.com, ar-io.dev and
/// Arweave L1; runbook S2). Never manifest rdVTds….
pub const METADATA_BASE_URI: &str = "https://arweave.net/ARWEAVE_MANIFEST_ID_TBD/";
#[allow(dead_code)] // used by the mainnet compile guards and the unit tests
pub(crate) const fn mf_contains(s: &[u8], p: &[u8]) -> bool {
    let mut i = 0;
    while i + p.len() <= s.len() {
        let mut j = 0;
        while j < p.len() && s[i + j] == p[j] {
            j += 1;
        }
        if j == p.len() {
            return true;
        }
        i += 1;
    }
    false
}
#[allow(dead_code)] // used by the mainnet compile guards and the unit tests
pub(crate) const fn mf_starts(s: &[u8], p: &[u8]) -> bool {
    if s.len() < p.len() {
        return false;
    }
    let mut i = 0;
    while i < p.len() {
        if s[i] != p[i] {
            return false;
        }
        i += 1;
    }
    true
}
/// "…/<43 base64url chars>/" at the end
#[allow(dead_code)] // used by the mainnet compile guards and the unit tests
pub(crate) const fn mf_ends_with_tx_id(s: &[u8]) -> bool {
    if s.len() < 53 || s[s.len() - 1] != b'/' || s[s.len() - 45] != b'/' {
        return false;
    }
    let mut i = s.len() - 44;
    while i < s.len() - 1 {
        let c = s[i];
        if !(c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
            return false;
        }
        i += 1;
    }
    true
}
/// The whole URI guard as one predicate (unit-tested on host; asserted on mainnet SBF builds).
#[allow(dead_code)] // used by the mainnet compile guards and the unit tests
pub(crate) const fn mf_uri_is_final(s: &[u8]) -> bool {
    mf_starts(s, b"https://") && !mf_contains(s, b"_TBD") && mf_ends_with_tx_id(s)
}
/// Byte equality of two pubkeys in a const context (the compile guards above).
#[allow(dead_code)] // used by the mainnet compile guards and the unit tests
pub(crate) const fn mf_pk_eq(a: &Pubkey, b: &Pubkey) -> bool {
    let (a, b) = (a.to_bytes(), b.to_bytes());
    let mut i = 0;
    while i < 32 {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}
const _: () = assert!(METADATA_BASE_URI.as_bytes()[METADATA_BASE_URI.len() - 1] == b'/', "METADATA_BASE_URI must end with /");
#[cfg(all(target_os = "solana", not(feature = "localnet")))]
const _: () = assert!(mf_uri_is_final(METADATA_BASE_URI.as_bytes()), "METADATA_BASE_URI still holds the Arweave placeholder");

// ─── Game ids ───────────────────────────────────────────────────────────────
pub const GAME_COINFLIP: u8 = 0;
pub const GAME_HIGHLOW: u8 = 1;
pub const GAME_VOIDRUSH: u8 = 2;

#[cfg(test)]
mod constant_tests {
    use super::*;

    #[test]
    fn frozen_relations() {
        assert!(KEEPER_BOND_MIN >= JACKPOT_MAX_POT);
        assert!(PRICE_MAX_STEPS >= 178);
        assert!(CLAIM_HOLD < MIN_EPOCH_INTERVAL);
        assert_eq!(KEEPER_TIP_MIN_CLAIM, 200_000_000);
        assert_eq!(RAKE_TO_POOL_BPS + RAKE_TO_ARCHITECT_BPS, P2P_RAKE_BPS); // no lottery share left
        assert_eq!(FORGE_BACKING_BPS + FORGE_POOL_BPS + FORGE_EXTRA_BPS + FORGE_DRAW_BPS + FORGE_ARCHITECT_BPS, BPS);
        assert_eq!(SEAT_WALK_MAX, 5);
        assert_eq!(DROP_BACKING, 5 * XNT);
        #[cfg(not(feature = "localnet"))]
        assert_eq!(PRICE_LAUNCH_TS, 1_795_478_400); // 2026-11-24 00:00 UTC
        assert_eq!(ARTIFACT_WEEKLY_CHIPS, [0, 0, 0, 0]);
    }

    #[test]
    fn uri_guard_accepts_a_manifest_and_rejects_the_placeholder() {
        assert!(mf_uri_is_final(b"https://arweave.net/abcdefghijklmnopqrstuvwxyz0123456789ABCDE-_/"));
        assert!(mf_uri_is_final(b"https://ar-io.net/abcdefghijklmnopqrstuvwxyz0123456789ABCDE-_/"));
        assert!(!mf_uri_is_final(METADATA_BASE_URI.as_bytes())); // the placeholder
        assert!(!mf_uri_is_final(b"https://arweave.net/abcdefghijklmnopqrstuvwxyz0123456789ABCDE-/")); // 42 chars
        assert!(!mf_uri_is_final(b"https://arweave.net/abcdefghijklmnopqrstuvwxyz0123456789ABCDE-_")); // no trailing /
        assert!(!mf_uri_is_final(b"http://arweave.net/abcdefghijklmnopqrstuvwxyz0123456789ABCDE-_/")); // not https
        assert!(!mf_uri_is_final(b"https://arweave.net/abcdefghijklmnopqrstuvwxyz0123456789ABCDE+_/")); // not base64url
        assert!(!mf_uri_is_final(b"https://xen-moon-forge-protocol.github.io/Moon-Forge/nft/"));
        assert!(METADATA_BASE_URI.ends_with('/'));
    }

    #[test]
    fn pubkey_guard_predicate() {
        #[cfg(not(feature = "localnet"))]
        assert!(mf_pk_eq(&SEAT_COLD_INITIAL, &Pubkey::default())); // OD-16 placeholder until S2
        assert!(!mf_pk_eq(&INITIAL_ORACLE, &ARCHITECT));
        assert!(mf_pk_eq(&MPL_CORE_ID, &MPL_CORE_ID));
    }

    /// The predicate behind the two "published test key" mainnet guards: every key of tests/fixtures is refused, the
    /// zero placeholder (its own guard) and the live mainnet identities are not.
    #[test]
    fn published_test_keys_are_refused() {
        for k in PUBLISHED_TEST_KEYS {
            assert!(mf_is_published_test_key(&k));
        }
        for s in [
            "HUvv7t99FhH7oxgAwjiBweqQGA7V6fpsuF4U7ExMoSRt", // test-keeper.json (the localnet INITIAL_KEEPER)
            "36qXRZdsTVnsmRVjY6j8vnZqu12ePSNh7uuQ9tw1u81q", // test-cold.json (the localnet SEAT_COLD_INITIAL)
        ] {
            assert!(mf_is_published_test_key(&s.parse::<Pubkey>().unwrap()), "{s}");
        }
        assert!(!mf_is_published_test_key(&Pubkey::default()));
        assert!(!mf_is_published_test_key(&pubkey!("7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd"))); // mainnet ARCHITECT
        assert!(!mf_is_published_test_key(&pubkey!("J5CU45Didfq7ng9JHXyxYqN7TwAGjMgEyhUcrV7Aixba"))); // mainnet oracle
        #[cfg(not(feature = "localnet"))]
        assert!(!mf_is_published_test_key(&INITIAL_KEEPER) && !mf_is_published_test_key(&SEAT_COLD_INITIAL));
        #[cfg(feature = "localnet")]
        assert!(mf_is_published_test_key(&INITIAL_KEEPER) && mf_is_published_test_key(&SEAT_COLD_INITIAL));
    }

    /// Every Solana keypair file in tests/fixtures (a JSON array of 64 bytes; the public key is bytes 32..64) is in
    /// PUBLISHED_TEST_KEYS, so a fixture key added later is refused by the mainnet guards too.
    #[test]
    fn fixture_keys_are_listed() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures");
        let mut found = 0;
        for entry in std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("{}: {e}", dir.display())) {
            let p = entry.unwrap().path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let s = std::fs::read_to_string(&p).unwrap();
            let t = s.trim();
            if !(t.starts_with('[') && t.ends_with(']')) {
                continue;
            }
            let bytes: Vec<u8> = match t[1..t.len() - 1].split(',').map(|v| v.trim().parse::<u8>()).collect() {
                Ok(b) => b,
                Err(_) => continue,
            };
            if bytes.len() != 64 {
                continue;
            }
            let pk = Pubkey::new_from_array(bytes[32..].try_into().unwrap());
            assert!(mf_is_published_test_key(&pk), "{} ({pk}) is missing from PUBLISHED_TEST_KEYS", p.display());
            found += 1;
        }
        assert_eq!(found, PUBLISHED_TEST_KEYS.len(), "every listed key has its fixture file");
    }

    /// A13.3 constants mirror the oracle (rewards.ts WEEK, MAX_PUBLISH_LAG).
    #[test]
    fn extra_week_constants() {
        #[cfg(not(feature = "localnet"))]
        assert_eq!((EXTRA_WEEK, EXTRA_WEEK_SLACK), (WEEK, 6 * 60 * 60));
        assert_eq!(EXTRA_MAX_WEEKS, 13);
    }
}
