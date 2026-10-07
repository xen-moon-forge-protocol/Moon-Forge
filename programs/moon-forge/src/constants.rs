//! Every economic parameter of the protocol lives here.
//! They are compile-time constants: once the upgrade authority is burned,
//! nobody (including the architect) can change them.

use anchor_lang::prelude::*;

// ─── Identities ─────────────────────────────────────────────────────────────
/// Architect wallet. Receives ONLY: 0.5% of house-game volume (a slice of the 2% edge),
/// 0.5% of P2P pots / lottery tickets, and 5% of the NFT forge price.
/// Never anything from the burn → XNT path.
#[cfg(not(feature = "localnet"))]
pub const ARCHITECT: Pubkey = pubkey!("7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd");
/// First oracle key. It can only publish epoch roots (bounded by EPOCH_BUDGET_BPS)
/// and hand its role to a new key (two-step). It cannot move funds.
#[cfg(not(feature = "localnet"))]
pub const INITIAL_ORACLE: Pubkey = pubkey!("J5CU45Didfq7ng9JHXyxYqN7TwAGjMgEyhUcrV7Aixba");

// Test-only identities (keys in tests/fixtures, worthless). Used ONLY by `--features localnet`.
#[cfg(feature = "localnet")]
pub const ARCHITECT: Pubkey = pubkey!("DL5zP1p8zDnGFGkrSUsA4bpeWaHhaDVBwyXc2xyxiZsq");
#[cfg(feature = "localnet")]
pub const INITIAL_ORACLE: Pubkey = pubkey!("7umMRWhHfzE6HUgY1xbf55z2FWgdwWeupxxJH1hNj1g9");

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

// ─── Forge (burn → XNT) ─────────────────────────────────────────────────────
/// Each epoch distributes at most 10% of the FREE reward pool (balance minus
/// rent minus budgets still reserved for open epochs). Computed on-chain.
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
/// No tip for dust claims (a sybil splitting burns into dust leaves cannot farm tips).
pub const KEEPER_TIP_MIN_CLAIM: u64 = 10 * KEEPER_TIP;
/// Domain separators for Merkle leaves (prevents cross-use of proofs).
pub const LEAF_DOMAIN_FORGE: &[u8] = b"MOONFORGE_V2_CLAIM";
pub const LEAF_DOMAIN_AIRDROP: &[u8] = b"MOONFORGE_V2_AIRDROP";

// ─── Forge Drops (random Lunar Dust for burners) ────────────────────────────
/// 10% of every epoch budget is not paid pro-rata: it becomes Forge Drops. Each claim leaf
/// has an expected drop value of score × drop_reserve / total_score (linear: splitting a burn
/// across wallets never changes it). The leaf wins a Lunar Dust holding that value as its
/// floor with probability value / DROP_BACKING; at or above DROP_BACKING it always wins and the
/// whole value becomes the floor. Nothing is created from thin air: the reserve comes out
/// of the same budget, so the pool pays exactly the same in expectation.
/// Even with drops, ejecting a vesting mission at once still pays less than Launchpad:
/// Orbit 2 × (0.40 × 0.9 + 0.1) = 0.92x, Moon Landing 3 × (0.25 × 0.9 + 0.1) = 0.975x.
pub const DROP_BUDGET_BPS: u64 = 1_000;
pub const DROP_TIER: u8 = 0;
/// The initial recycle value of a Lunar Dust (50% of its forge price) = 5 XNT.
pub const DROP_BACKING: u64 = ARTIFACT_PRICE[0] / BPS * FORGE_BACKING_BPS;
pub const MAX_DROPS_PER_EPOCH: u64 = 20;
/// Luck can draw more winners than expected. Overruns come from the free pool, bounded:
/// an epoch never pays more than drop_reserve + max(drop_reserve, DROP_LUCK_BUFFER) in drops.
pub const DROP_LUCK_BUFFER: u64 = 3 * DROP_BACKING;
/// The drop seed is the hash of the first block at or after publish slot + this delay:
/// unknown to the oracle when it signs the epoch.
pub const DROP_SEED_DELAY_SLOTS: u64 = 4;
/// Paid by the pool to whoever delivers a drop to someone else (covers the rent of the
/// new Artifact, its record and the drop receipt).
pub const DROP_KEEPER_TIP: u64 = 10_000_000; // 0.01 XNT
pub const DROP_NONE: u8 = 0;
pub const DROP_PENDING: u8 = 1;
pub const DROP_SEALED: u8 = 2;
pub const DROP_CANCELLED: u8 = 3;

// ─── Chips (free entries for the weekly Burn Lottery) ───────────────────────
pub const CHIP_PER_CLAIMED: u64 = XNT; // 1 chip per XNT received from burns
pub const CHIP_PER_WAGERED: u64 = 10 * XNT; // 1 chip per 10 XNT wagered in house games

// ─── House games (Coin Flip, High-Low, Void Rush) ───────────────────────────
pub const HOUSE_EDGE_BPS: u64 = 200; // 2% total edge, built into the odds
pub const EDGE_TO_POOL_BPS: u64 = 100; // 1.0% of every stake -> reward pool (burners)
pub const EDGE_TO_ARCHITECT_BPS: u64 = 50; // 0.5% of every stake -> architect
// the remaining 0.5% stays in the bankroll (House LPs)
pub const MIN_STAKE: u64 = 10_000_000; // 0.01 XNT
/// A single bet can never risk more than 0.25% of the free bankroll (net of its own stake).
/// Only 0.5% of the edge stays in the bankroll, so a larger cap would push its log-growth to <= 0.
pub const MAX_EXPOSURE_BPS: u64 = 25;
/// All unsettled bets together can never reserve more than 20% of the bankroll, so the
/// conservative (LP withdrawal) value can never be pushed more than 20% below the real one.
pub const MAX_TOTAL_EXPOSURE_BPS: u64 = 2_000;
/// Circuit breaker: if the bankroll (net of LP deposits/withdrawals) has lost 10% since the start of
/// the day, new house bets are refused until the next day. Bounds the damage of any bad luck or
/// undiscovered edge (e.g. a block producer steering its own slot hashes) to 10% per day, leaving
/// LPs time to react.
pub const MAX_DAILY_LOSS_BPS: u64 = 1_000;
pub const DAY_SECONDS_FOR_BREAKER: i64 = DAY;
pub const COINFLIP_CHANCE_BPS: u64 = 5_000;
pub const MIN_CHANCE_BPS: u64 = 100; // High-Low: 1%..95% win chance
pub const MAX_CHANCE_BPS: u64 = 9_500;
pub const MIN_TARGET_BPS: u64 = 10_500; // Void Rush: 1.05x .. 100x
pub const MAX_TARGET_BPS: u64 = 1_000_000;
/// payout_bps = RTP_NUMERATOR / chance_bps  (98% return to player)
pub const RTP_NUMERATOR: u64 = (BPS - HOUSE_EDGE_BPS) * BPS;

// ─── P2P games (Jackpot, Artifact Duel, Burn Lottery tickets) ───────────────
pub const P2P_RAKE_BPS: u64 = 200; // 2% of the pot, only when someone wins
pub const RAKE_TO_POOL_BPS: u64 = 100; // 1.0% -> reward pool
pub const RAKE_TO_ARCHITECT_BPS: u64 = 50; // 0.5% -> architect
// the remaining 0.5% -> draw vault (Burn Lottery prize)
pub const JACKPOT_DURATION: i64 = DAY / 144 + 2; // ~10 min after the first entry (2 s on localnet)
pub const DUEL_MIN_STAKE: u64 = 100_000_000; // 0.1 XNT
pub const DUEL_REVEAL_WINDOW: i64 = DAY / 24 + 2; // creator must reveal within ~1 hour (2 s on localnet)

// ─── Moon Wars (PvP card battle with stakes; same rules as the free practice) ─
/// Each side plays the same 10-card deck (4 Lunar, 3 Cosmic, 2 Solar, 1 Void), shuffled by the
/// hash of a block produced after both players joined: the draw order is public to both (perfect
/// information, like chess), so the better player wins. 20 HP, mana = min(10, ceil(round/2)+1),
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
/// A player who does not finish their turn in time loses (2 minutes; 8 s on localnet).
#[cfg(not(feature = "localnet"))]
pub const WAR_TURN_TIMEOUT: i64 = 120;
#[cfg(feature = "localnet")]
pub const WAR_TURN_TIMEOUT: i64 = 8;

// ─── Predictions (pari-mutuel "XNT up or down") ──────────────────────────────
/// Price source: the time-weighted average price recorded on-chain by XDEX (a Raydium-CPMM fork)
/// for its WXNT/USDC.X pool. A TWAP can only be moved by holding a distorted price for minutes
/// against arbitrage, and each round's pot is capped, so manipulation costs more than it can win.
/// Schedule: round k opens at k × PRED_PERIOD (UTC), takes entries for PRED_BET_WINDOW, its start
/// price is the 15-minute TWAP ending at the lock time, its end price the 15-minute TWAP ending
/// PRED_HORIZON later. Winners share the pot pro-rata minus the 2% P2P rake; a tie, an empty winning
/// side, price data that left the on-chain window, or no price data at all PRED_MAX_DELAY after the
/// lock / end time (no swap in the pool) refunds everyone in full.
#[cfg(not(feature = "localnet"))]
pub const XDEX_PROGRAM: Pubkey = pubkey!("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
#[cfg(not(feature = "localnet"))]
pub const XDEX_XNT_POOL: Pubkey = pubkey!("CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR");
#[cfg(not(feature = "localnet"))]
pub const XDEX_XNT_OBSERVATION: Pubkey = pubkey!("4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ");
#[cfg(not(feature = "localnet"))]
pub const PRED_PERIOD: i64 = DAY;
#[cfg(not(feature = "localnet"))]
pub const PRED_BET_WINDOW: i64 = DAY / 2;
#[cfg(not(feature = "localnet"))]
pub const PRED_HORIZON: i64 = DAY;
#[cfg(not(feature = "localnet"))]
pub const PRED_TWAP_WINDOW: u64 = 15 * 60;
#[cfg(not(feature = "localnet"))]
pub const PRED_MAX_DELAY: i64 = DAY;
// localnet: a crafted observation account (tests/fixtures) and a compressed schedule
#[cfg(feature = "localnet")]
pub const XDEX_PROGRAM: Pubkey = pubkey!("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
#[cfg(feature = "localnet")]
pub const XDEX_XNT_POOL: Pubkey = pubkey!("CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR");
#[cfg(feature = "localnet")]
pub const XDEX_XNT_OBSERVATION: Pubkey = pubkey!("4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ");
#[cfg(feature = "localnet")]
pub const PRED_PERIOD: i64 = 40;
#[cfg(feature = "localnet")]
pub const PRED_BET_WINDOW: i64 = 20;
#[cfg(feature = "localnet")]
pub const PRED_HORIZON: i64 = 20;
#[cfg(feature = "localnet")]
pub const PRED_TWAP_WINDOW: u64 = 10;
#[cfg(feature = "localnet")]
pub const PRED_MAX_DELAY: i64 = 30;
pub const PRED_MAX_POT: u64 = 200 * XNT;
pub const DRAW_DURATION: i64 = 7 * DAY;
pub const TICKET_PRICE: u64 = XNT; // 1 ticket = 1 XNT = same weight as 1 chip
pub const DRAW_PRIZE_BPS: u64 = 5_000; // winner takes 50% of the draw vault, rest rolls over

// ─── Be the House (bankroll LP) ─────────────────────────────────────────────
pub const HOUSE_MIN_DEPOSIT: u64 = XNT;
pub const HOUSE_WITHDRAW_DELAY: i64 = DAY;
/// Permanent protocol shares minted with the very first LP deposit (blocks share-inflation
/// attacks on an empty bankroll). Worth at most 0.001 XNT.
pub const HOUSE_DEAD_SHARES: u64 = 1_000_000;

// ─── Artifacts (Metaplex Core NFTs) ─────────────────────────────────────────
pub const TIER_NAMES: [&str; 4] = ["Lunar Dust", "Cosmic Shard", "Solar Core", "Void Anomaly"];
pub const TIER_SLUGS: [&str; 4] = ["lunar_dust", "cosmic_shard", "solar_core", "void_anomaly"];
pub const ARTIFACT_SUPPLY: [u16; 4] = [600, 300, 90, 10]; // max ALIVE at any time
/// BASE forge prices. Lunar Dust is fixed (its 5 XNT floor is also the Forge Drop prize).
/// The other tiers are dynamic: every forge raises the tier's price by 5% (×21/20); every full
/// PRICE_DECAY_PERIOD without a forge lowers it by ÷1.05 (×20/21), never below the base price
/// and never above MAX_PRICE_MULTIPLE × base. The floor of each Artifact is 50% of what its
/// buyer actually paid, so recycling never returns more than was paid in.
pub const ARTIFACT_PRICE: [u64; 4] = [10 * XNT, 25 * XNT, 60 * XNT, 200 * XNT];
pub const DYNAMIC_PRICE: [bool; 4] = [false, true, true, true];
pub const PRICE_STEP_NUM: u64 = 21;
pub const PRICE_STEP_DEN: u64 = 20;
pub const PRICE_DECAY_PERIOD: i64 = 7 * DAY;
pub const MAX_PRICE_MULTIPLE: u64 = 100;
pub const ARTIFACT_VARIANTS: [u32; 4] = [6, 3, 2, 1];
pub const ARTIFACT_BOOST_BPS: [u16; 4] = [500, 1_000, 2_000, 5_000]; // +5/10/20/50% burn score
pub const ARTIFACT_WEEKLY_CHIPS: [u64; 4] = [5, 15, 40, 150];
/// Forge price split: 50% stays inside the NFT as its floor (returned on recycle),
/// 40% reward pool, 5% Burn Lottery prize, 5% architect royalty.
pub const FORGE_BACKING_BPS: u64 = 5_000;
pub const FORGE_POOL_BPS: u64 = 4_000;
pub const FORGE_DRAW_BPS: u64 = 500;
pub const FORGE_ARCHITECT_BPS: u64 = 500;
/// Royalty declared on the Core collection for secondary sales (marketplaces that honor it).
pub const SECONDARY_ROYALTY_BPS: u16 = 500;
pub const AIRDROP_MAX: u16 = 120; // free Lunar Dust for active X1 wallets (no floor)
pub const WEEK: i64 = 7 * 24 * 60 * 60;
pub const COLLECTION_NAME: &str = "Moon Forge Artifacts";
pub const METADATA_BASE_URI: &str = "https://xen-moon-forge-protocol.github.io/Moon-Forge/nft/";

// ─── Game ids ───────────────────────────────────────────────────────────────
pub const GAME_COINFLIP: u8 = 0;
pub const GAME_HIGHLOW: u8 = 1;
pub const GAME_VOIDRUSH: u8 = 2;
