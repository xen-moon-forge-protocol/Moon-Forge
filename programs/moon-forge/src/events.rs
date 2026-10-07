use anchor_lang::prelude::*;

#[event]
pub struct Initialized {
    pub oracle: Pubkey,
    pub architect: Pubkey,
}

#[event]
pub struct Donated {
    pub donor: Pubkey,
    pub target: u8,
    pub amount: u64,
}

#[event]
pub struct EpochPublished {
    pub epoch: u64,
    pub root: [u8; 32],
    pub data_hash: [u8; 32],
    pub total_score: u128,
    pub leaves: u32,
    pub budget: u64,
    pub drop_reserve: u64,
    pub drop_slot: u64,
    pub free_pool_before: u64,
}

#[event]
pub struct DropSealed {
    pub epoch: u64,
    pub seed: [u8; 32],
    /// true = nobody sealed within the SlotHashes window: the reserve went back to the pool
    pub cancelled: bool,
}

#[event]
pub struct DropWon {
    pub epoch: u64,
    pub player: Pubkey,
    pub tier: u8,
    /// Pubkey::default() when paid in XNT because Lunar Dust was sold out
    pub asset: Pubkey,
    pub value: u64,
    pub keeper_tip: u64,
}

#[event]
pub struct ForgeClaimed {
    pub epoch: u64,
    pub player: Pubkey,
    pub tier: u8,
    pub score: u64,
    pub amount: u64,
    pub chips: u64,
    pub keeper_tip: u64,
}

#[event]
pub struct VestedWithdrawn {
    pub player: Pubkey,
    pub epoch: u64,
    pub tier: u8,
    pub amount: u64,
}

#[event]
pub struct PilotEjected {
    pub player: Pubkey,
    pub epoch: u64,
    pub tier: u8,
    pub paid: u64,
    pub penalty_to_pool: u64,
}

#[event]
pub struct EpochExpired {
    pub epoch: u64,
    pub returned_to_pool: u64,
}

#[event]
pub struct BetPlaced {
    pub owner: Pubkey,
    pub bet: Pubkey,
    pub game: u8,
    pub choice: u8,
    pub chance_bps: u64,
    pub stake: u64,
    pub payout: u64,
    pub target_slot: u64,
    pub to_pool: u64,
    pub to_architect: u64,
}

#[event]
pub struct BetSettled {
    pub owner: Pubkey,
    pub bet: Pubkey,
    pub game: u8,
    pub roll: u64,
    pub won: bool,
    pub expired: bool,
    pub stake: u64,
    pub payout: u64,
}

#[event]
pub struct HouseChanged {
    pub owner: Pubkey,
    pub deposit: bool,
    pub lamports: u64,
    pub shares: u64,
}

#[event]
pub struct JackpotSettled {
    pub round: u64,
    pub winner: Pubkey,
    pub pot: u64,
    pub prize: u64,
    pub winning_ticket: u64,
    pub refunded: bool,
}

#[event]
pub struct DuelResolved {
    pub duel: Pubkey,
    pub creator_element: u8,
    pub opponent_element: u8,
    pub winner: Pubkey,
    pub pot: u64,
    pub timeout: bool,
}

#[event]
pub struct WarStarted {
    pub war: Pubkey,
    pub seed: [u8; 32],
}

#[event]
pub struct WarFinished {
    pub war: Pubkey,
    /// Pubkey::default() for a draw (both refunded)
    pub winner: Pubkey,
    pub pot: u64,
    pub prize: u64,
    pub timeout: bool,
}

#[event]
pub struct PredictionResolved {
    pub round: u64,
    pub start_price_x32: u128,
    pub end_price_x32: u128,
    /// 0 down, 1 up, 2 refund (tie, empty winning side or unavailable data)
    pub outcome: u8,
    pub pot: u64,
}

#[event]
pub struct DrawSettled {
    pub round: u64,
    pub winner: Pubkey,
    pub prize: u64,
    pub total_weight: u64,
    pub winning_ticket: u64,
}

#[event]
pub struct ArtifactForged {
    pub owner: Pubkey,
    pub asset: Pubkey,
    pub tier: u8,
    pub serial: u32,
    pub price: u64,
    pub backing: u64,
    pub origin: u8,
}

#[event]
pub struct ArtifactRecycled {
    pub owner: Pubkey,
    pub asset: Pubkey,
    pub tier: u8,
    pub backing_returned: u64,
    pub orphan: bool,
}

#[event]
pub struct ChipsGranted {
    pub owner: Pubkey,
    pub source: u8,
    pub chips: u64,
}
