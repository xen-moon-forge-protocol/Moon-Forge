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
    #[msg("The bankroll lost 10% today: house games resume tomorrow")]
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
    #[msg("This round's pot is full")]
    PotFull,
}
