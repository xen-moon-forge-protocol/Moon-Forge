use anchor_lang::prelude::*;

/// Global protocol state. Created once by the permissionless `initialize_v2`
/// with values taken from compile-time constants (nothing can be front-run).
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    pub oracle: Pubkey,
    /// Two-step oracle hand-over. Pubkey::default() = none pending.
    pub pending_oracle: Pubkey,
    pub architect: Pubkey,
    /// bumps of [reward_vault, bankroll_vault, draw_vault, collection, artifact_authority]
    pub bumps: [u8; 5],

    // ── Forge ──
    pub last_epoch: u64,
    pub last_publish_ts: i64,
    /// Sum over open epochs of (budget - claimed). Not part of the free pool.
    pub reward_reserved: u64,

    // ── Games ──
    /// Sum of the gross payouts of all unsettled house bets.
    pub bankroll_reserved: u64,
    pub house_total_shares: u64,
    /// Shares minted to the protocol for value that existed before the first LP.
    /// They are never withdrawable: a permanent bankroll floor.
    pub house_protocol_shares: u64,
    pub jackpot_round: u64,
    pub draw_round: u64,

    // ── Artifacts ──
    pub artifacts_alive: [u16; 4],
    pub artifacts_minted: [u32; 4],
    pub airdrop_root: [u8; 32],
    pub airdrop_root_set: bool,
    pub airdrop_claimed: u16,
    /// Dynamic forge price per tier after the last forge (0 = never forged: base price).
    pub artifact_price: [u64; 4],
    /// Time of the last forge per tier (start of the weekly decay).
    pub artifact_price_ts: [i64; 4],
    /// Circuit breaker: current day and the bankroll value at its start (adjusted by LP flows).
    pub bankroll_day: i64,
    pub bankroll_day_start: u64,

    pub stats: Stats,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Stats {
    pub donated_reward: u64,
    pub donated_bankroll: u64,
    pub donated_draw: u64,
    pub forge_paid: u64,
    pub forge_claims: u64,
    pub penalties_to_pool: u64,
    pub keeper_tips: u64,
    pub wagered: u64,
    pub bets: u64,
    pub paid_to_players: u64,
    pub edge_to_pool: u64,
    pub to_architect: u64,
    pub to_draw: u64,
    pub artifact_to_pool: u64,
    pub draw_prizes: u64,
    pub drops: u64,
    pub drop_paid: u64,
    /// Lottery prizes of weeks nobody settled in time, sent to the reward pool.
    pub expired_draws_to_pool: u64,
}

/// One per published epoch. Seeds: ["epoch", epoch_id_le]
#[account]
#[derive(InitSpace)]
pub struct Epoch {
    pub id: u64,
    pub root: [u8; 32],
    /// sha256 of the full epoch JSON published by the oracle (every burn, every score).
    pub data_hash: [u8; 32],
    pub total_score: u128,
    pub leaves: u32,
    /// Max lamports paid per score unit (mandatory, > 0). It can only LOWER the budget:
    /// budget = min(10% of free pool, total_score * rate_cap). Prevents mint-and-burn farming
    /// windfalls; whatever is not distributed simply stays in the pool.
    pub rate_cap: u64,
    /// Paid pro-rata to the leaves (the epoch budget minus `drop_reserve`).
    pub budget: u64,
    pub claimed: u64,
    pub claims: u32,
    pub published_at: i64,
    pub expires_at: i64,
    pub closed: bool,
    /// Forge Drops: share of the epoch budget paid as random Lunar Dust (see constants.rs).
    pub drop_reserve: u64,
    /// Floors given to drop winners (can exceed the reserve by luck; the excess comes from the free pool).
    pub drop_paid: u64,
    pub drops: u32,
    pub drop_slot: u64,
    pub drop_seed: [u8; 32],
    /// DROP_NONE / DROP_PENDING / DROP_SEALED / DROP_CANCELLED
    pub drop_state: u8,
    pub bump: u8,
}

/// Anti double-drop. Seeds: ["drop", epoch_le, player, tier]
#[account]
#[derive(InitSpace)]
pub struct DropReceipt {
    pub epoch: u64,
    pub player: Pubkey,
    pub tier: u8,
    /// Pubkey::default() when the drop was paid in XNT (Lunar Dust sold out)
    pub asset: Pubkey,
    pub value: u64,
    pub bump: u8,
}

/// Anti double-claim. Seeds: ["receipt", epoch_le, player, tier]. Closable only after
/// the epoch is closed (claims are impossible then), refunding rent to whoever paid it.
#[account]
#[derive(InitSpace)]
pub struct ClaimReceipt {
    pub epoch: u64,
    pub player: Pubkey,
    pub tier: u8,
    pub amount: u64,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

/// Vesting position for Orbit / Moon Landing. Holds its own XNT.
/// Seeds: ["mission", epoch_le, player, tier]
#[account]
#[derive(InitSpace)]
pub struct Mission {
    pub player: Pubkey,
    pub epoch: u64,
    pub tier: u8,
    pub total: u64,
    pub withdrawn: u64,
    pub start: i64,
    pub end: i64,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

/// Game wallet of a player. Lamports held = rent + `balance`.
/// Seeds: ["player", owner]
#[account]
#[derive(InitSpace)]
pub struct PlayerState {
    pub owner: Pubkey,
    pub balance: u64,
    /// Non-transferable Burn Lottery chips.
    pub chips: u64,
    /// Optional delegated key (bots / auto-play). Can bet, can never withdraw.
    pub session_key: Pubkey,
    pub session_expires: i64,
    pub session_max_stake: u64,
    pub nonce: u64,
    pub total_wagered: u64,
    pub total_won: u64,
    pub bump: u8,
}

/// A pending house bet. Seeds: ["bet", player_state, nonce_le]
#[account]
#[derive(InitSpace)]
pub struct Bet {
    pub player_state: Pubkey,
    pub owner: Pubkey,
    pub rent_payer: Pubkey,
    pub game: u8,
    pub choice: u8,
    pub chance_bps: u64,
    pub stake: u64,
    pub payout: u64,
    pub seed: [u8; 32],
    pub target_slot: u64,
    pub nonce: u64,
    pub bump: u8,
}

/// Bankroll LP position. Seeds: ["house", owner]
#[account]
#[derive(InitSpace)]
pub struct HouseShare {
    pub owner: Pubkey,
    pub shares: u64,
    pub pending_shares: u64,
    pub unlock_ts: i64,
    pub bump: u8,
}

pub const ROUND_OPEN: u8 = 0;
pub const ROUND_DRAWING: u8 = 1;
pub const ROUND_SETTLED: u8 = 2;
/// The drawing block left the SlotHashes window before anyone settled: every entry is
/// refunded (a re-roll would let a losing player wait for a better block).
pub const ROUND_REFUND: u8 = 3;

/// Multiplayer pot. Holds the pot lamports. Seeds: ["jackpot", round_le]
#[account]
#[derive(InitSpace)]
pub struct JackpotRound {
    pub id: u64,
    pub total: u64,
    pub entries: u32,
    pub first_player: Pubkey,
    pub multi_player: bool,
    pub end_ts: i64,
    pub target_slot: u64,
    pub state: u8,
    pub winner: Pubkey,
    pub winning_ticket: u64,
    pub bump: u8,
}

/// Seeds: ["jp_entry", round_le, index_le]
#[account]
#[derive(InitSpace)]
pub struct JackpotEntry {
    pub round: u64,
    pub index: u32,
    pub player: Pubkey,
    pub start: u64,
    pub amount: u64,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

pub const PRED_OPEN: u8 = 0;
pub const PRED_LOCKED: u8 = 1;
pub const PRED_SETTLED: u8 = 2;
pub const PRED_REFUND: u8 = 3;
pub const SIDE_DOWN: u8 = 0;
pub const SIDE_UP: u8 = 1;

/// "XNT up or down" round. Holds the pot. Seeds: ["pred", round_id_le]
#[account]
#[derive(InitSpace)]
pub struct PredRound {
    pub id: u64,
    pub lock_ts: i64,
    pub end_ts: i64,
    /// [down, up] totals
    pub totals: [u64; 2],
    pub entries: u32,
    pub state: u8,
    pub start_price_x32: u128,
    pub end_price_x32: u128,
    pub outcome: u8,
    /// pot minus rake, shared by the winning side
    pub prize_pool: u64,
    /// entries already paid out / closed; the round closes once every entry is claimed
    pub claimed: u32,
    /// paid the round account rent (the first entrant); gets it back when the round closes
    pub rent_payer: Pubkey,
    pub bump: u8,
}

/// Seeds: ["pred_entry", round_id_le, player]
#[account]
#[derive(InitSpace)]
pub struct PredEntry {
    pub round: u64,
    pub player: Pubkey,
    pub side: u8,
    pub amount: u64,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

pub const WAR_OPEN: u8 = 0;
pub const WAR_STARTING: u8 = 1; // joined; waiting for the seed block
pub const WAR_ACTIVE: u8 = 2;
pub const WAR_DONE: u8 = 3; // finished; waiting for settle_war (payout)

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Debug)]
pub struct WarUnit {
    pub element: u8,
    pub defense: i8,
    pub ready: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Debug)]
pub struct WarSide {
    pub health: i8,
    pub mana: u8,
    /// shuffled deck; cards are drawn from the end (deck[deck_left - 1])
    pub deck: [u8; 10],
    pub deck_left: u8,
    pub hand: [u8; 10],
    pub hand_len: u8,
    pub field: [WarUnit; 6],
    pub field_len: u8,
}

/// Moon Wars match. Holds both stakes. Seeds: ["war", creator, nonce_le]
#[account]
#[derive(InitSpace)]
pub struct War {
    pub creator: Pubkey,
    pub opponent: Pubkey,
    pub nonce: u64,
    pub stake: u64,
    pub state: u8,
    pub target_slot: u64,
    /// 0 = creator to move, 1 = opponent to move
    pub turn: u8,
    pub round: u16,
    /// the player to move loses after this time
    pub deadline: i64,
    /// keys allowed to sign moves (the owner, or a key generated in the player's own browser)
    pub keys: [Pubkey; 2],
    pub sides: [WarSide; 2],
    pub winner: Pubkey,
    pub draw: bool,
    pub timeout: bool,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

pub const DUEL_OPEN: u8 = 0;
pub const DUEL_JOINED: u8 = 1;
pub const DUEL_DONE: u8 = 2;

/// Artifact Duel (commit-reveal PvP). Holds both stakes. Seeds: ["duel", creator, nonce_le]
#[account]
#[derive(InitSpace)]
pub struct Duel {
    pub creator: Pubkey,
    pub nonce: u64,
    pub stake: u64,
    pub commitment: [u8; 32],
    pub opponent: Pubkey,
    pub opponent_element: u8,
    pub creator_element: u8,
    pub state: u8,
    pub deadline: i64,
    pub winner: Pubkey,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

/// Weekly Burn Lottery. Seeds: ["draw", round_le]
#[account]
#[derive(InitSpace)]
pub struct DrawRound {
    pub id: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub total_weight: u64,
    pub entries: u32,
    pub target_slot: u64,
    pub state: u8,
    pub winning_ticket: u64,
    pub winner: Pubkey,
    pub prize: u64,
    pub bump: u8,
}

/// Seeds: ["draw_entry", round_le, index_le]
#[account]
#[derive(InitSpace)]
pub struct DrawEntry {
    pub round: u64,
    pub index: u32,
    pub player: Pubkey,
    pub start: u64,
    pub weight: u64,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

pub const ORIGIN_FORGED: u8 = 0;
pub const ORIGIN_AIRDROP: u8 = 1;
pub const ORIGIN_DROP: u8 = 2;

/// Moon Forge side-car for each Core asset. Holds the artifact's floor (backing) in lamports.
/// Seeds: ["artifact", asset]
#[account]
#[derive(InitSpace)]
pub struct ArtifactRecord {
    pub asset: Pubkey,
    pub tier: u8,
    pub serial: u32,
    pub backing: u64,
    pub origin: u8,
    pub forged_at: i64,
    pub last_chip_week: i64,
    pub bump: u8,
}

/// Seeds: ["airdrop", claimant]
#[account]
#[derive(InitSpace)]
pub struct AirdropReceipt {
    pub claimant: Pubkey,
    pub asset: Pubkey,
    pub bump: u8,
}
