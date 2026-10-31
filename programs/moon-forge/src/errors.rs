use anchor_lang::prelude::*;

#[error_code]
pub enum ForgeError {
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Only the oracle can do this")]
    OnlyOracle,
    #[msg("Only the pending oracle can accept")]
    NotPendingOracle,
    #[msg("Only the architect can do this")]
    OnlyArchitect,
    #[msg("Epoch must be exactly last_epoch + 1")]
    BadEpochNumber,
    #[msg("Too early: minimum interval between epochs not reached")]
    EpochTooSoon,
    #[msg("Epoch has no score")]
    EmptyEpoch,
    #[msg("Reward pool has no free balance")]
    PoolEmpty,
    #[msg("Invalid Merkle proof")]
    InvalidProof,
    #[msg("Invalid tier")]
    InvalidTier,
    #[msg("Epoch budget exhausted")]
    BudgetExhausted,
    #[msg("Claim window closed")]
    ClaimWindowClosed,
    #[msg("Claim window still open")]
    ClaimWindowOpen,
    #[msg("Epoch already closed")]
    EpochClosed,
    #[msg("Nothing to withdraw yet")]
    NothingVested,
    #[msg("Wrong player account")]
    WrongPlayer,
    #[msg("Wrong rent payer account")]
    WrongRentPayer,
    #[msg("Amount too small")]
    AmountTooSmall,
    #[msg("Insufficient game balance")]
    InsufficientBalance,
    #[msg("Signer is neither the owner nor an active session key")]
    Unauthorized,
    #[msg("Stake above the session limit")]
    SessionLimit,
    #[msg("Invalid game parameters")]
    InvalidGame,
    #[msg("Bankroll cannot cover this bet")]
    BankrollTooSmall,
    #[msg("Randomness not available yet, retry in a moment")]
    NotReady,
    #[msg("Round is not open")]
    RoundNotOpen,
    #[msg("Round is still running")]
    RoundRunning,
    #[msg("Round is not drawing")]
    RoundNotDrawing,
    #[msg("This entry does not hold the winning ticket")]
    NotWinningEntry,
    #[msg("Round not settled yet")]
    RoundNotSettled,
    #[msg("Duel is not in the expected state")]
    DuelState,
    #[msg("Cannot duel yourself")]
    SelfDuel,
    #[msg("Commitment does not match")]
    BadCommitment,
    #[msg("Reveal deadline not reached")]
    DeadlineNotReached,
    #[msg("Reveal deadline passed")]
    DeadlinePassed,
    #[msg("Not enough chips")]
    NotEnoughChips,
    #[msg("Withdraw still locked")]
    WithdrawLocked,
    #[msg("No pending withdraw")]
    NoPendingWithdraw,
    #[msg("Not enough shares")]
    NotEnoughShares,
    #[msg("Artifact tier sold out")]
    SoldOut,
    #[msg("Not a valid Moon Forge artifact")]
    InvalidArtifact,
    #[msg("You do not own this artifact")]
    NotArtifactOwner,
    #[msg("Artifact element does not match")]
    WrongElement,
    #[msg("Chips already claimed for this artifact this week")]
    ChipsAlreadyClaimed,
    #[msg("Artifact still exists")]
    ArtifactAlive,
    #[msg("Airdrop root already set")]
    AirdropRootSet,
    #[msg("Airdrop not configured")]
    AirdropNotSet,
    #[msg("Airdrop allocation exhausted")]
    AirdropExhausted,
    #[msg("Invalid target account")]
    InvalidTarget,
    #[msg("Forge Drop seed is not pending")]
    DropNotPending,
    #[msg("Forge Drop seed not sealed yet")]
    DropNotSealed,
    #[msg("This leaf did not win a Forge Drop")]
    NoDrop,
    #[msg("Lunar Dust is not sold out: claim the Artifact itself")]
    NotSoldOut,
    #[msg("This epoch's Forge Drops are exhausted")]
    DropCapReached,
    #[msg("Price moved beyond your limit")]
    SlippageExceeded,
    #[msg("Counting every unsettled bet as won, the bankroll would lose more than 3% today: house games resume tomorrow (UTC)")]
    DailyLossLimit,
    #[msg("Only the wallet owner can enter player-vs-player games")]
    OwnerOnly,
    #[msg("This Moon Wars match is not in the right state")]
    WarState,
    #[msg("It is not your turn")]
    NotYourTurn,
    #[msg("Invalid move")]
    InvalidMove,
    #[msg("Not enough mana")]
    NotEnoughMana,
    #[msg("This prediction round is not in the right state")]
    PredState,
    #[msg("Invalid XDEX price account")]
    BadPriceAccount,
    #[msg("This round's pot, or this side of it, is full")]
    PotFull,
    #[msg("The Genesis airdrop claim period has ended")]
    AirdropClosed,
    // ── final upgrade (v3): 6064 … 6100, frozen ──
    #[msg("This withdrawal request has expired: request again")]
    WithdrawExpired,
    #[msg("This game now uses sealed instructions (create_war_sealed, join_war_sealed, join_duel_sealed): update your client")]
    SealedJoinRequired,
    #[msg("Claims open 48 h after the epoch is published")]
    ClaimOnHold,
    #[msg("The 48-h hold has ended: this epoch can no longer be voided")]
    HoldOver,
    #[msg("Only the oracle seat's cold key can do this")]
    OnlyCold,
    #[msg("The oracle seat is alive: an epoch survived its hold in the last 28 days, or the seat changed hands less than 28 days ago")]
    SeatAlive,
    #[msg("The oracle seat is dead: it can only be taken, not resigned")]
    SeatDead,
    #[msg("Pass the Epoch and ExtraEpoch accounts of every epoch of the last 28 days, newest first, down to the first older one")]
    BadEpochWindow,
    #[msg("Only the priority taker can take the seat during its 24-h window")]
    SeatPriority,
    #[msg("The seat is already open")]
    SeatOpen,
    #[msg("Bond below the required minimum")]
    BondTooSmall,
    #[msg("Extra budget above 8% of the pot or 4% of the live forged floors")]
    ExtraBudgetExceeded,
    #[msg("Extra epochs follow base epochs one by one, at least 6 days apart")]
    ExtraEpochOrder,
    #[msg("No base epoch with this id")]
    ExtraBaseEpochMissing,
    #[msg("This extra epoch is closed or its 90-day window ended")]
    ExtraClaimWindow,
    #[msg("This extra leaf was already claimed")]
    ExtraAlreadyClaimed,
    #[msg("The seller would receive less than this Artifact's floor (or the price is below 0.1 XNT): recycle it instead")]
    ListingBelowFloor,
    #[msg("Expiry must be in the future and at most 90 days away")]
    InvalidExpiry,
    #[msg("This listing has expired")]
    ListingExpired,
    #[msg("This listing is reserved for another buyer")]
    ListingReserved,
    #[msg("The seller no longer holds this Artifact")]
    ListingStale,
    #[msg("The listing price changed: review it again")]
    ListingPriceChanged,
    #[msg("This listing is still valid: only the seller can close it")]
    ListingActive,
    #[msg("Buyer and seller are the same wallet")]
    SelfPurchase,
    #[msg("House bets use place_bet_v2 and the keeper chain since the final upgrade")]
    KeeperRequired,
    #[msg("The house keeper has no chain positions left: wait for it to re-arm")]
    KeeperNotArmed,
    #[msg("Reveal does not match the chain head, it is out of order, or the new tip repeats the current head")]
    BadReveal,
    #[msg("Only the house keeper can do this")]
    OnlyKeeper,
    #[msg("This bet is not stalled yet")]
    BetNotStalled,
    #[msg("Bets or a Jackpot round are pending: settle or refund them first")]
    KeeperBusy,
    #[msg("The keeper bond does not cover the pending payouts")]
    KeeperBondTooSmall,
    #[msg("The bankroll would lose more than 15% over 7 days: house games resume when the window rolls")]
    WeeklyLossLimit,
    #[msg("The 7-day keeper notice (hand-over or bond withdrawal) has not elapsed")]
    KeeperNotice,
    #[msg("The keeper seat is alive: it was active in the last 28 days")]
    KeeperAlive,
    #[msg("Weekly chips are retired since the final upgrade")]
    ChipsRetired,
    #[msg("This bet is stalled (block gone, reveal overdue or position skipped): refund it with refund_stalled_bet")]
    BetStalled,
    #[msg("Burn Lottery tickets are retired since the final upgrade")]
    LotteryRetired,
}

#[cfg(test)]
mod error_tests {
    use super::ForgeError as E;

    /// Every code is permanent: clients, the kit and the docs key off these numbers.
    #[test]
    fn error_codes_are_frozen() {
        let all: [(E, u32); 101] = [
            (E::MathOverflow, 6000), (E::OnlyOracle, 6001), (E::NotPendingOracle, 6002), (E::OnlyArchitect, 6003),
            (E::BadEpochNumber, 6004), (E::EpochTooSoon, 6005), (E::EmptyEpoch, 6006), (E::PoolEmpty, 6007),
            (E::InvalidProof, 6008), (E::InvalidTier, 6009), (E::BudgetExhausted, 6010), (E::ClaimWindowClosed, 6011),
            (E::ClaimWindowOpen, 6012), (E::EpochClosed, 6013), (E::NothingVested, 6014), (E::WrongPlayer, 6015),
            (E::WrongRentPayer, 6016), (E::AmountTooSmall, 6017), (E::InsufficientBalance, 6018), (E::Unauthorized, 6019),
            (E::SessionLimit, 6020), (E::InvalidGame, 6021), (E::BankrollTooSmall, 6022), (E::NotReady, 6023),
            (E::RoundNotOpen, 6024), (E::RoundRunning, 6025), (E::RoundNotDrawing, 6026), (E::NotWinningEntry, 6027),
            (E::RoundNotSettled, 6028), (E::DuelState, 6029), (E::SelfDuel, 6030), (E::BadCommitment, 6031),
            (E::DeadlineNotReached, 6032), (E::DeadlinePassed, 6033), (E::NotEnoughChips, 6034), (E::WithdrawLocked, 6035),
            (E::NoPendingWithdraw, 6036), (E::NotEnoughShares, 6037), (E::SoldOut, 6038), (E::InvalidArtifact, 6039),
            (E::NotArtifactOwner, 6040), (E::WrongElement, 6041), (E::ChipsAlreadyClaimed, 6042), (E::ArtifactAlive, 6043),
            (E::AirdropRootSet, 6044), (E::AirdropNotSet, 6045), (E::AirdropExhausted, 6046), (E::InvalidTarget, 6047),
            (E::DropNotPending, 6048), (E::DropNotSealed, 6049), (E::NoDrop, 6050), (E::NotSoldOut, 6051),
            (E::DropCapReached, 6052), (E::SlippageExceeded, 6053), (E::DailyLossLimit, 6054), (E::OwnerOnly, 6055),
            (E::WarState, 6056), (E::NotYourTurn, 6057), (E::InvalidMove, 6058), (E::NotEnoughMana, 6059),
            (E::PredState, 6060), (E::BadPriceAccount, 6061), (E::PotFull, 6062), (E::AirdropClosed, 6063),
            (E::WithdrawExpired, 6064), (E::SealedJoinRequired, 6065), (E::ClaimOnHold, 6066), (E::HoldOver, 6067),
            (E::OnlyCold, 6068), (E::SeatAlive, 6069), (E::SeatDead, 6070), (E::BadEpochWindow, 6071),
            (E::SeatPriority, 6072), (E::SeatOpen, 6073), (E::BondTooSmall, 6074), (E::ExtraBudgetExceeded, 6075),
            (E::ExtraEpochOrder, 6076), (E::ExtraBaseEpochMissing, 6077), (E::ExtraClaimWindow, 6078), (E::ExtraAlreadyClaimed, 6079),
            (E::ListingBelowFloor, 6080), (E::InvalidExpiry, 6081), (E::ListingExpired, 6082), (E::ListingReserved, 6083),
            (E::ListingStale, 6084), (E::ListingPriceChanged, 6085), (E::ListingActive, 6086), (E::SelfPurchase, 6087),
            (E::KeeperRequired, 6088), (E::KeeperNotArmed, 6089), (E::BadReveal, 6090), (E::OnlyKeeper, 6091),
            (E::BetNotStalled, 6092), (E::KeeperBusy, 6093), (E::KeeperBondTooSmall, 6094), (E::WeeklyLossLimit, 6095),
            (E::KeeperNotice, 6096), (E::KeeperAlive, 6097), (E::ChipsRetired, 6098), (E::BetStalled, 6099),
            (E::LotteryRetired, 6100),
        ];
        for (i, (e, code)) in all.iter().enumerate() {
            assert_eq!(*e as u32 + anchor_lang::error::ERROR_CODE_OFFSET, *code, "index {i}");
            assert_eq!(*code, 6000 + i as u32);
        }
        assert_eq!(E::LotteryRetired as u32 + anchor_lang::error::ERROR_CODE_OFFSET, 6100);
    }

    #[test]
    fn message_edits() {
        assert!(anchor_lang::error::Error::from(E::DailyLossLimit).to_string().contains("3% today"));
        assert!(anchor_lang::error::Error::from(E::PotFull).to_string().contains("or this side of it"));
    }
}
