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
    /// D-47: lamports paid by this publication from the free pool to the oracle key (Epoch rent back + wallet top-up,
    /// inside the 10% bound after the budget; 0 when the reward vault is read-only in the transaction). Appended
    /// last, so a decoder of the earlier layout still reads every other field.
    pub oracle_allowance: u64,
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
    /// G-2 (round 4): lamports settle_bet_v2 paid the registered keeper wallet from the free pool for this settle
    /// (at most 0.0005 XNT and half of the bet's pool share; 0 for a legacy settle_bet). Appended last, like
    /// EpochPublished.oracle_allowance, so a decoder of the earlier layout still reads every other field.
    pub keeper_tip: u64,
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

// ─── final upgrade (v3): the 21 events above stay byte-identical ────────────

#[event]
pub struct WarSeedOpened {
    pub war: Pubkey,
    pub creator_entropy: [u8; 32],
    pub joiner_secret: [u8; 32],
    /// 0 = creator moves first, 1 = opponent
    pub first: u8,
}

#[event]
pub struct OracleChanged {
    pub old_oracle: Pubkey,
    pub new_oracle: Pubkey,
    /// 0 accept_oracle, 1 rotate_hot, 2 take_seat
    pub by: u8,
}

#[event]
pub struct OracleHandoverProposed {
    pub oracle: Pubkey,
    pub pending_oracle: Pubkey,
}

#[event]
pub struct SeatChanged {
    pub generation: u64,
    pub hot: Pubkey,
    pub cold: Pubkey,
    pub refund: Pubkey,
    pub bond: u64,
    pub taker: Pubkey,
    /// 0 init, 1 dead, 2 open
    pub reason: u8,
    pub forfeited: u64,
}

#[event]
pub struct SeatResigned {
    pub generation: u64,
    pub successor: Pubkey,
    pub refund: Pubkey,
    pub bond_returned: u64,
}

#[event]
pub struct EpochVoided {
    pub epoch: u64,
    pub voider: Pubkey,
    pub bond: u64,
    pub returned_to_pool: u64,
    pub by_cold: bool,
}

#[event]
pub struct ExtraEpochVoided {
    pub epoch: u64,
    pub voider: Pubkey,
    pub bond: u64,
    pub returned_to_pot: u64,
    pub by_cold: bool,
}

#[event]
pub struct ExtraEpochPublished {
    pub epoch: u64,
    pub root: [u8; 32],
    pub data_hash: [u8; 32],
    pub total: u64,
    pub leaves: u32,
    pub free_before: u64,
    pub free_after: u64,
    /// A13.3: the 7-day weeks the publication was bounded with (1 ..= the base epochs' gap, at most EXTRA_MAX_WEEKS)
    pub weeks: u8,
}

#[event]
pub struct ExtraClaimed {
    pub epoch: u64,
    pub wallet: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ExtraEpochClosed {
    pub epoch: u64,
    pub returned: u64,
}

#[event]
pub struct ArtifactListed {
    pub asset: Pubkey,
    pub seller: Pubkey,
    pub tier: u8,
    pub price: u64,
    pub seller_net: u64,
    pub backing: u64,
    pub reserved_buyer: Pubkey,
    pub expires_at: i64,
    pub update: bool,
}

/// reason: 0 = seller delisted, 1 = stale (asset moved or burned), 2 = expired
#[event]
pub struct ArtifactDelisted {
    pub asset: Pubkey,
    pub seller: Pubkey,
    pub reason: u8,
}

#[event]
pub struct ArtifactSold {
    pub asset: Pubkey,
    pub tier: u8,
    pub origin: u8,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub price: u64,
    /// The 5% the buyer paid, also when it went to `reward_vault` (`config.architect == reward_vault` after a
    /// renounce). That case is booked in `stats.artifact_to_pool`, so read architect income from `config.stats`.
    pub royalty: u64,
    pub pool_fee: u64,
    pub seller_net: u64,
    pub backing: u64,
    pub private: bool,
}

#[event]
pub struct CollectionRoyaltiesLocked {
    pub collection: Pubkey,
    pub creator: Pubkey,
}

#[event]
pub struct KeeperArmed {
    pub keeper: Pubkey,
    pub tip: [u8; 32],
    pub length: u64,
    pub bond: u64,
    pub armed_slot: u64,
}

#[event]
pub struct KeeperChanged {
    pub old_keeper: Pubkey,
    pub new_keeper: Pubkey,
    /// 0 notice, 1 dead seat
    pub by: u8,
    pub bond: u64,
}

/// reason: 0 unanchored expired (the whole stake back: stake − edge returned by the bankroll, the edge paid by the
/// keeper bond); 1 anchored stalled or position skipped (paid as a win by the keeper bond); 2 jackpot expired (entries
/// back + penalty = pot, from the bond to the pool); 3 jackpot drawn without keeper capacity (entries back, no penalty).
/// `penalty`: reason 0, the stake − edge the bond forfeits to nobody (it stays in the keeper seat above its bond;
/// r4-fix); reason 1, the stake the bankroll keeps, paid by the bond (booked as a lost bet; nothing goes to the pool);
/// reason 2, what the bond paid the pool; reason 3, 0.
#[event]
pub struct BetRefunded {
    pub bet: Pubkey,
    pub player: Pubkey,
    pub stake: u64,
    pub penalty: u64,
    pub reason: u8,
}

#[event]
pub struct ArchitectChanged {
    pub old_architect: Pubkey,
    pub new_architect: Pubkey,
}

#[cfg(test)]
mod event_tests {
    use super::*;
    use anchor_lang::Discriminator;

    fn hex(d: &[u8]) -> String {
        d.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// discs-v2.out.txt (live events unchanged, new ones as listed in SPEC-UPGRADE-v2 §2.4).
    #[test]
    fn event_discriminators_are_frozen() {
        let live: [(&[u8], &str); 21] = [
            (Initialized::DISCRIMINATOR, "d0d573627352c9d1"), (Donated::DISCRIMINATOR, "0c53fbb727d37d2c"),
            (EpochPublished::DISCRIMINATOR, "dd5f4d62cb12c0e1"), (DropSealed::DISCRIMINATOR, "3ad2e8edc657cb83"),
            (DropWon::DISCRIMINATOR, "f9391db1c8f8295f"), (ForgeClaimed::DISCRIMINATOR, "8b347cec87bded7f"),
            (VestedWithdrawn::DISCRIMINATOR, "692a8c5b2780f439"), (PilotEjected::DISCRIMINATOR, "fd96c96def443aeb"),
            (EpochExpired::DISCRIMINATOR, "641e77ea470d2faa"), (BetPlaced::DISCRIMINATOR, "585891e27ece2000"),
            (BetSettled::DISCRIMINATOR, "3991e0a03e77e3ce"), (HouseChanged::DISCRIMINATOR, "60ddbc85841acb6c"),
            (JackpotSettled::DISCRIMINATOR, "620a7f54f103dde0"), (DuelResolved::DISCRIMINATOR, "e0f5d6d46f973205"),
            (WarStarted::DISCRIMINATOR, "f8102c748d50ee92"), (WarFinished::DISCRIMINATOR, "3d8fac65bd0ef8e1"),
            (PredictionResolved::DISCRIMINATOR, "753cce4377d55411"), (DrawSettled::DISCRIMINATOR, "89a6841e088edb81"),
            (ArtifactForged::DISCRIMINATOR, "3ca83455052678e2"), (ArtifactRecycled::DISCRIMINATOR, "3949e0c3989e24d5"),
            (ChipsGranted::DISCRIMINATOR, "6c3022421df21f87"),
        ];
        let new: [(&[u8], &str); 18] = [
            (WarSeedOpened::DISCRIMINATOR, "292a20e9c5ccacdf"), (OracleChanged::DISCRIMINATOR, "97d4d56831833717"),
            (OracleHandoverProposed::DISCRIMINATOR, "f96632797324d2c0"), (SeatChanged::DISCRIMINATOR, "3a1d50a68cde3f4c"),
            (SeatResigned::DISCRIMINATOR, "e80559d29c237f3e"), (EpochVoided::DISCRIMINATOR, "c2b3b5b5c47eb646"),
            (ExtraEpochVoided::DISCRIMINATOR, "f65ad0442706a807"), (ExtraEpochPublished::DISCRIMINATOR, "efde5571084cc169"),
            (ExtraClaimed::DISCRIMINATOR, "882a8d63646a698d"), (ExtraEpochClosed::DISCRIMINATOR, "7a64d50c92134e37"),
            (ArtifactListed::DISCRIMINATOR, "ccb664397f2825d0"), (ArtifactDelisted::DISCRIMINATOR, "37585908c6faf147"),
            (ArtifactSold::DISCRIMINATOR, "5f649aa1efe70b60"), (CollectionRoyaltiesLocked::DISCRIMINATOR, "32f5bce49413b669"),
            (KeeperArmed::DISCRIMINATOR, "2246631d2072f36a"), (KeeperChanged::DISCRIMINATOR, "c2aef864de68f36c"),
            (BetRefunded::DISCRIMINATOR, "20eaad666a0402cb"), (ArchitectChanged::DISCRIMINATOR, "10be608aa46370bb"),
        ];
        for (d, want) in live.iter().chain(new.iter()) {
            assert_eq!(hex(d), *want);
        }
    }
}
