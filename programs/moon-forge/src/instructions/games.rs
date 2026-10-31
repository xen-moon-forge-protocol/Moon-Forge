//! Player game wallet, session keys (bots / auto-play), house games and the
//! "Be the House" bankroll LP.
//!
//! Since the final upgrade house bets run on the keeper's hash chain (keeper.rs):
//!   place_bet_v2      : stake locked, max payout reserved, anchor block = slot + 1, chain position reserved
//!   anchor_bet        : PERMISSIONLESS within ~512 slots: the anchor block's hash is mixed into the bet's seed
//!   settle_bet_v2     : the keeper's next preimage; roll = random_u64(reveal, bet, mixed seed) % 10_000
//!   refund_stalled_bet: PERMISSIONLESS (keeper.rs stall_split; no stall pays the pool). An anchored bet the keeper
//!                       does not reveal in time (or skips) is paid as a WIN, the full payout from the keeper bond, and
//!                       the bankroll keeps the stake, as for a lost bet. An unanchored bet whose block left SlotHashes
//!                       gives the player its whole stake back (the bankroll returns stake − edge, the bond pays the
//!                       edge) and the bond also forfeits stake − edge to nobody (it stays in the seat above `bond`).
//! place_bet is retired (KeeperRequired). settle_bet settles bets placed before the upgrade with their single block:
//! one not settled before that block leaves the SlotHashes window (~3 min) counts as LOST.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::constants::*;
use crate::errors::ForgeError;
use crate::events::*;
use crate::state::*;
use crate::utils::*;

// ═══════════════════════════════════════════════════════════════════════════
// Player wallet
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct OpenPlayer<'info> {
    #[account(
        init_if_needed, payer = owner, space = 8 + PlayerState::INIT_SPACE,
        seeds = [SEED_PLAYER, owner.key().as_ref()], bump
    )]
    pub player_state: Box<Account<'info, PlayerState>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn open_player(ctx: Context<OpenPlayer>) -> Result<()> {
    let ps = &mut ctx.accounts.player_state;
    if ps.owner == Pubkey::default() {
        ps.owner = ctx.accounts.owner.key();
        ps.bump = ctx.bumps.player_state;
    }
    Ok(())
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut, seeds = [SEED_PLAYER, player_state.owner.as_ref()], bump = player_state.bump)]
    pub player_state: Box<Account<'info, PlayerState>>,
    /// Anyone can top up anyone's game balance.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, ForgeError::AmountTooSmall);
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer { from: ctx.accounts.payer.to_account_info(), to: ctx.accounts.player_state.to_account_info() },
        ),
        amount,
    )?;
    let ps = &mut ctx.accounts.player_state;
    ps.balance = ps.balance.checked_add(amount).ok_or(ForgeError::MathOverflow)?;
    Ok(())
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut, seeds = [SEED_PLAYER, owner.key().as_ref()], bump = player_state.bump,
        constraint = player_state.owner == owner.key() @ ForgeError::Unauthorized
    )]
    pub player_state: Box<Account<'info, PlayerState>>,
    /// Only the owner can withdraw. Session keys never can.
    #[account(mut)]
    pub owner: Signer<'info>,
}

pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let ps = &mut ctx.accounts.player_state;
    require!(amount > 0 && amount <= ps.balance, ForgeError::InsufficientBalance);
    ps.balance -= amount;
    move_lamports(&ctx.accounts.player_state.to_account_info(), &ctx.accounts.owner.to_account_info(), amount)
}

#[derive(Accounts)]
pub struct SetSession<'info> {
    #[account(
        mut, seeds = [SEED_PLAYER, owner.key().as_ref()], bump = player_state.bump,
        constraint = player_state.owner == owner.key() @ ForgeError::Unauthorized
    )]
    pub player_state: Box<Account<'info, PlayerState>>,
    pub owner: Signer<'info>,
}

/// Authorize a delegated key (e.g. a bot) to play — never to withdraw.
/// Pass Pubkey::default() or expires_at = 0 to revoke.
pub fn set_session(ctx: Context<SetSession>, session_key: Pubkey, expires_at: i64, max_stake: u64) -> Result<()> {
    let ps = &mut ctx.accounts.player_state;
    ps.session_key = session_key;
    ps.session_expires = expires_at;
    ps.session_max_stake = max_stake;
    Ok(())
}

/// Circuit breaker: true while the bankroll has lost less than MAX_DAILY_LOSS_BPS since the day began.
pub fn within_daily_loss(value_now: u64, day_start: u64) -> bool {
    (value_now as u128) * (BPS as u128) >= (day_start as u128) * ((BPS - MAX_DAILY_LOSS_BPS) as u128)
}

/// Every limit a v2 house bet must pass (SPEC 2.7 + 2.9). `vault` = bankroll lamports above rent BEFORE the bet
/// (the OPTIMISTIC value: unsettled bets counted as lost); `stake_in` = stake - edge (what enters the bankroll);
/// `week_loss` / `week_start` = the keeper seat's rolling 7-day window; `bond` / `jackpot_reserved` = the keeper
/// seat's bond and the pots of the v3 Jackpot rounds now DRAWING.
#[allow(clippy::too_many_arguments)]
pub fn bet_limits(
    vault: u64,
    reserved: u64,
    stake_in: u64,
    stake: u64,
    payout: u64,
    day_start: u64,
    week_loss: i64,
    week_start: u64,
    bond: u64,
    jackpot_reserved: u64,
) -> Result<()> {
    let vault_after = vault.checked_add(stake_in).ok_or(ForgeError::MathOverflow)?;
    let reserved_after = reserved.checked_add(payout).ok_or(ForgeError::MathOverflow)?;
    // breaker first (a tripped day keeps returning DailyLossLimit): even if every unsettled bet wins
    require!(within_daily_loss(vault_after.saturating_sub(reserved_after), day_start), ForgeError::DailyLossLimit);
    // one bet: net win <= 0.25% of the free bankroll (unchanged)
    require!(
        payout.saturating_sub(stake) <= bps(vault.saturating_sub(reserved), MAX_EXPOSURE_BPS)?,
        ForgeError::BankrollTooSmall
    );
    // solvency (was free_after >= payout)
    require!(vault_after >= reserved_after, ForgeError::BankrollTooSmall);
    // aggregate: every unsettled payout together <= 5% of the bankroll
    require!(reserved_after <= bps(vault_after, MAX_TOTAL_EXPOSURE_BPS)?, ForgeError::BankrollTooSmall);
    // rolling 7 days: realized net loss + every pending payout <= 15% of the window-start bankroll (i128: no wrap)
    require!(
        week_loss as i128 + reserved_after as i128 <= bps(week_start, MAX_WEEKLY_LOSS_BPS)? as i128,
        ForgeError::WeeklyLossLimit
    );
    // the keeper bond covers every pending payout AND every DRAWING v3 Jackpot pot (K-3)
    require!(bond >= reserved_after.saturating_add(jackpot_reserved), ForgeError::KeeperBondTooSmall);
    Ok(())
}

/// The part of a stake that never enters the bankroll: 1% to the pool + 0.5% to the architect. Identical at
/// placement and at settlement (the architect reroute moves it, never resizes it).
pub fn bet_edge(stake: u64) -> Result<u64> {
    bps(stake, EDGE_TO_POOL_BPS)?.checked_add(bps(stake, EDGE_TO_ARCHITECT_BPS)?).ok_or(error!(ForgeError::MathOverflow))
}

/// Owner, or a live session key within its stake limit.
pub fn authorize_play(ps: &PlayerState, signer: &Pubkey, stake: u64) -> Result<()> {
    if *signer == ps.owner {
        return Ok(());
    }
    let now = Clock::get()?.unix_timestamp;
    require!(
        ps.session_key != Pubkey::default() && *signer == ps.session_key && now < ps.session_expires,
        ForgeError::Unauthorized
    );
    require!(stake <= ps.session_max_stake, ForgeError::SessionLimit);
    Ok(())
}

pub fn debit_balance(ps: &mut PlayerState, amount: u64) -> Result<()> {
    require!(amount <= ps.balance, ForgeError::InsufficientBalance);
    ps.balance -= amount;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// House games
// ═══════════════════════════════════════════════════════════════════════════

/// Returns (chance_bps, payout_bps). Payout always <= 98% RTP by construction (floor).
pub fn game_odds(game: u8, param: u64, choice: u8) -> Result<(u64, u64)> {
    match game {
        GAME_COINFLIP => {
            require!(choice <= 1, ForgeError::InvalidGame);
            Ok((COINFLIP_CHANCE_BPS, RTP_NUMERATOR / COINFLIP_CHANCE_BPS))
        }
        GAME_HIGHLOW => {
            require!(choice <= 1, ForgeError::InvalidGame);
            require!((MIN_CHANCE_BPS..=MAX_CHANCE_BPS).contains(&param), ForgeError::InvalidGame);
            Ok((param, RTP_NUMERATOR / param))
        }
        GAME_VOIDRUSH => {
            require!((MIN_TARGET_BPS..=MAX_TARGET_BPS).contains(&param), ForgeError::InvalidGame);
            Ok((RTP_NUMERATOR / param, param))
        }
        _ => err!(ForgeError::InvalidGame),
    }
}

/// roll is uniform in [0, 10_000). Modulo bias of u64 % 10_000 is < 1e-15.
pub fn is_win(game: u8, choice: u8, chance_bps: u64, roll: u64) -> bool {
    match game {
        GAME_COINFLIP => (roll < COINFLIP_CHANCE_BPS) == (choice == 0),
        GAME_HIGHLOW => {
            if choice == 0 {
                roll < chance_bps // "under"
            } else {
                roll >= BPS - chance_bps // "over"
            }
        }
        _ => roll < chance_bps,
    }
}

#[cfg(test)]
mod odds_tests {
    use super::*;

    /// Exact expected return of a bet = P(win) * payout, using the exact win set of is_win.
    fn rtp_bps(game: u8, param: u64, choice: u8) -> u64 {
        let (chance, payout_bps) = game_odds(game, param, choice).unwrap();
        let wins = (0..BPS).filter(|r| is_win(game, choice, chance, *r)).count() as u64;
        wins * payout_bps / BPS
    }

    #[test]
    fn every_bet_returns_at_most_98_percent() {
        for c in 0..=1 {
            assert!(rtp_bps(GAME_COINFLIP, 0, c) <= 9_800);
            assert!(rtp_bps(GAME_COINFLIP, 0, c) >= 9_799);
        }
        for chance in (MIN_CHANCE_BPS..=MAX_CHANCE_BPS).step_by(7) {
            for c in 0..=1 {
                let r = rtp_bps(GAME_HIGHLOW, chance, c);
                assert!(r <= 9_800 && r >= 9_790, "highlow {chance} {c} -> {r}");
            }
        }
        for target in (MIN_TARGET_BPS..=MAX_TARGET_BPS).step_by(997) {
            let r = rtp_bps(GAME_VOIDRUSH, target, 0);
            assert!(r <= 9_800 && r >= 9_700, "voidrush {target} -> {r}");
        }
    }

    #[test]
    fn invalid_params_rejected() {
        assert!(game_odds(GAME_COINFLIP, 0, 2).is_err());
        assert!(game_odds(GAME_HIGHLOW, MIN_CHANCE_BPS - 1, 0).is_err());
        assert!(game_odds(GAME_HIGHLOW, MAX_CHANCE_BPS + 1, 0).is_err());
        assert!(game_odds(GAME_VOIDRUSH, MIN_TARGET_BPS - 1, 0).is_err());
        assert!(game_odds(GAME_VOIDRUSH, MAX_TARGET_BPS + 1, 0).is_err());
        assert!(game_odds(9, 0, 0).is_err());
    }

    #[test]
    fn circuit_breaker_trips_at_three_percent_daily_loss() {
        assert!(within_daily_loss(1_000, 1_000));
        assert!(within_daily_loss(970, 1_000)); // exactly -3%: still allowed (OD-1)
        assert!(!within_daily_loss(969, 1_000));
        assert!(within_daily_loss(5_000, 1_000)); // gains never trip it
        assert!(within_daily_loss(0, 0));
    }

    #[test]
    fn coinflip_sides_are_complementary() {
        for r in 0..BPS {
            assert_ne!(is_win(GAME_COINFLIP, 0, 5_000, r), is_win(GAME_COINFLIP, 1, 5_000, r));
        }
    }
}

#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_PLAYER, player_state.owner.as_ref()], bump = player_state.bump)]
    pub player_state: Box<Account<'info, PlayerState>>,
    #[account(
        init, payer = signer, space = 8 + Bet::INIT_SPACE,
        seeds = [SEED_BET, player_state.key().as_ref(), player_state.nonce.to_le_bytes().as_ref()], bump
    )]
    pub bet: Box<Account<'info, Bet>>,
    /// CHECK: bankroll vault PDA
    #[account(mut, seeds = [SEED_BANKROLL_VAULT], bump = config.bumps[1])]
    pub bankroll_vault: UncheckedAccount<'info>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: architect payee (config.architect)
    #[account(mut, address = config.architect @ ForgeError::InvalidTarget)]
    pub architect: UncheckedAccount<'info>,
    /// Owner or session key. Pays the (refundable) bet account rent.
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Retired since the final upgrade (same 58-byte ABI, so old clients get a clear error): house bets use
/// place_bet_v2 and the keeper chain. Its chip grant is gone with it (ECO-3).
pub fn place_bet(_ctx: Context<PlaceBet>, _game: u8, _param: u64, _choice: u8, _stake: u64, _seed: [u8; 32]) -> Result<()> {
    err!(ForgeError::KeeperRequired)
}

#[derive(Accounts)]
pub struct SettleBet<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut, close = rent_payer,
        seeds = [SEED_BET, bet.player_state.as_ref(), bet.nonce.to_le_bytes().as_ref()], bump = bet.bump
    )]
    pub bet: Box<Account<'info, Bet>>,
    #[account(mut, address = bet.player_state @ ForgeError::WrongPlayer)]
    pub player_state: Box<Account<'info, PlayerState>>,
    /// CHECK: bankroll vault PDA
    #[account(mut, seeds = [SEED_BANKROLL_VAULT], bump = config.bumps[1])]
    pub bankroll_vault: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar
    #[account(address = SLOT_HASHES_ID @ ForgeError::InvalidTarget)]
    pub slot_hashes: UncheckedAccount<'info>,
    /// CHECK: receives the bet rent back
    #[account(mut, address = bet.rent_payer @ ForgeError::WrongRentPayer)]
    pub rent_payer: UncheckedAccount<'info>,
}

/// PERMISSIONLESS — keepers, bots, the player or anyone can settle. Bets placed before the final upgrade only
/// (single block, Expired = lost); v2 bets settle through settle_bet_v2.
pub fn settle_bet(ctx: Context<SettleBet>) -> Result<()> {
    let bet = &ctx.accounts.bet;
    require!(bet.game & BET_KEEPER == 0, ForgeError::KeeperRequired);
    let (won, expired, roll) = match slot_hash_at_or_after(&ctx.accounts.slot_hashes, bet.target_slot)? {
        SlotHashLookup::NotYet => return err!(ForgeError::NotReady),
        SlotHashLookup::Expired => (false, true, u64::MAX),
        SlotHashLookup::Ready(h) => {
            let roll = random_u64(&h, bet.key().as_ref(), &bet.seed) % BPS;
            (is_win(bet.game, bet.choice, bet.chance_bps, roll), false, roll)
        }
    };
    let (payout, stake, game, owner, bet_key) = (bet.payout, bet.stake, bet.game, bet.owner, bet.key());

    let c = &mut ctx.accounts.config;
    c.bankroll_reserved = c.bankroll_reserved.saturating_sub(payout);
    if won {
        move_lamports(&ctx.accounts.bankroll_vault.to_account_info(), &ctx.accounts.player_state.to_account_info(), payout)?;
        let ps = &mut ctx.accounts.player_state;
        ps.balance = ps.balance.checked_add(payout).ok_or(ForgeError::MathOverflow)?;
        ps.total_won = ps.total_won.saturating_add(payout);
        c.stats.paid_to_players = c.stats.paid_to_players.saturating_add(payout);
    }
    emit!(BetSettled { owner, bet: bet_key, game, roll, won, expired, stake, payout: if won { payout } else { 0 }, keeper_tip: 0 });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Be the House — deposit XNT into the bankroll, share its 0.5% edge (and its variance)
// deposit at the optimistic value, withdraw at the conservative one (see house_deposit)
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct HouseDeposit<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed, payer = owner, space = 8 + HouseShare::INIT_SPACE,
        seeds = [SEED_HOUSE, owner.key().as_ref()], bump
    )]
    pub share: Box<Account<'info, HouseShare>>,
    /// CHECK: bankroll vault PDA
    #[account(mut, seeds = [SEED_BANKROLL_VAULT], bump = config.bumps[1])]
    pub bankroll_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Deposits are priced at the OPTIMISTIC value (every unsettled bet counted as lost) and
/// withdrawals at the CONSERVATIVE value (every unsettled bet counted as won). Nobody can buy
/// shares cheaply while bets are pending, nor leave with more than the worst case allows.
/// `min_shares` / `min_lamports` protect the LP against the value moving before execution.
pub fn house_deposit(ctx: Context<HouseDeposit>, amount: u64, min_shares: u64) -> Result<()> {
    require!(amount >= HOUSE_MIN_DEPOSIT, ForgeError::AmountTooSmall);
    let c = &mut ctx.accounts.config;
    let value = free_balance(&ctx.accounts.bankroll_vault, 0)?.max(HOUSE_DEAD_SHARES);
    if c.house_total_shares == 0 {
        // value donated before the first LP (and at least HOUSE_DEAD_SHARES) belongs to the
        // protocol forever: 1 share = 1 lamport at the start, and the supply can never be emptied
        c.house_protocol_shares = value;
        c.house_total_shares = value;
    }
    let minted = mul_div(amount, c.house_total_shares, value)?;
    require!(minted > 0, ForgeError::AmountTooSmall);
    require!(minted >= min_shares, ForgeError::SlippageExceeded);

    transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer { from: ctx.accounts.owner.to_account_info(), to: ctx.accounts.bankroll_vault.to_account_info() },
        ),
        amount,
    )?;
    c.house_total_shares = c.house_total_shares.checked_add(minted).ok_or(ForgeError::MathOverflow)?;
    // LP money is not a game result: keep the daily circuit breaker's reference in step
    if c.bankroll_day == Clock::get()?.unix_timestamp / DAY_SECONDS_FOR_BREAKER {
        c.bankroll_day_start = c.bankroll_day_start.saturating_add(amount);
    }
    let s = &mut ctx.accounts.share;
    if s.owner == Pubkey::default() {
        s.owner = ctx.accounts.owner.key();
        s.bump = ctx.bumps.share;
    }
    s.shares = s.shares.checked_add(minted).ok_or(ForgeError::MathOverflow)?;
    emit!(HouseChanged { owner: s.owner, deposit: true, lamports: amount, shares: minted });
    Ok(())
}

#[derive(Accounts)]
pub struct HouseRequestWithdraw<'info> {
    #[account(
        mut, seeds = [SEED_HOUSE, owner.key().as_ref()], bump = share.bump,
        constraint = share.owner == owner.key() @ ForgeError::Unauthorized
    )]
    pub share: Box<Account<'info, HouseShare>>,
    pub owner: Signer<'info>,
}

/// Starts the 24 h cooldown (prevents LPs from dodging pending bets). The matured request is usable for
/// HOUSE_WITHDRAW_WINDOW; a new request replaces it.
pub fn house_request_withdraw(ctx: Context<HouseRequestWithdraw>, shares: u64) -> Result<()> {
    let s = &mut ctx.accounts.share;
    require!(shares > 0 && shares <= s.shares, ForgeError::NotEnoughShares);
    s.pending_shares = shares;
    s.unlock_ts = Clock::get()?.unix_timestamp.saturating_add(HOUSE_WITHDRAW_DELAY);
    Ok(())
}

#[derive(Accounts)]
pub struct HouseWithdraw<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut, seeds = [SEED_HOUSE, owner.key().as_ref()], bump = share.bump,
        constraint = share.owner == owner.key() @ ForgeError::Unauthorized
    )]
    pub share: Box<Account<'info, HouseShare>>,
    /// CHECK: bankroll vault PDA
    #[account(mut, seeds = [SEED_BANKROLL_VAULT], bump = config.bumps[1])]
    pub bankroll_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

pub fn house_withdraw(ctx: Context<HouseWithdraw>, min_lamports: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let s = &mut ctx.accounts.share;
    require!(s.pending_shares > 0, ForgeError::NoPendingWithdraw);
    require!(now >= s.unlock_ts, ForgeError::WithdrawLocked);
    // an expired request stays in pending_shares until house_request_withdraw overwrites it
    require!(now < s.unlock_ts.saturating_add(HOUSE_WITHDRAW_WINDOW), ForgeError::WithdrawExpired);
    let shares = s.pending_shares.min(s.shares);
    let c = &mut ctx.accounts.config;
    let value = free_balance(&ctx.accounts.bankroll_vault, c.bankroll_reserved)?;
    let lamports = mul_div(shares, value, c.house_total_shares)?;
    require!(lamports >= min_lamports, ForgeError::SlippageExceeded);
    s.shares -= shares;
    s.pending_shares = 0;
    c.house_total_shares -= shares;
    if c.bankroll_day == now / DAY_SECONDS_FOR_BREAKER {
        c.bankroll_day_start = c.bankroll_day_start.saturating_sub(lamports);
    }
    move_lamports(&ctx.accounts.bankroll_vault.to_account_info(), &ctx.accounts.owner.to_account_info(), lamports)?;
    emit!(HouseChanged { owner: s.owner, deposit: false, lamports, shares });
    Ok(())
}

#[cfg(test)]
mod house_limit_tests {
    use super::*;
    use anchor_lang::error::ERROR_CODE_OFFSET;

    const X: u64 = XNT;
    const BIG: u64 = u64::MAX / 4;

    fn code(r: Result<()>) -> Option<u32> {
        match r {
            Err(Error::AnchorError(e)) => Some(e.error_code_number - ERROR_CODE_OFFSET),
            _ => None,
        }
    }
    fn payout_bps(game: u8, param: u64) -> u64 {
        game_odds(game, param, 0).unwrap().1
    }
    /// (stake_in, payout) exactly as place_bet_v2 computes them.
    fn bet(stake: u64, pbps: u64) -> (u64, u64) {
        (stake - bet_edge(stake).unwrap(), mul_div(stake, pbps, BPS).unwrap())
    }
    /// bet_limits with the weekly limit and the keeper bond out of the way.
    fn lim(vault: u64, reserved: u64, stake: u64, pbps: u64, day_start: u64) -> Result<()> {
        let (stake_in, payout) = bet(stake, pbps);
        bet_limits(vault, reserved, stake_in, stake, payout, day_start, 0, BIG, u64::MAX, 0)
    }
    /// Places identical bets until one is refused. After EVERY accepted bet the worst case (all pending win)
    /// stays >= 97% of day_start and the pending payouts stay <= 5% of the bankroll.
    fn fill(mut vault: u64, mut reserved: u64, stake: u64, pbps: u64, day_start: u64) -> (u64, u64, u32) {
        let mut n = 0;
        while lim(vault, reserved, stake, pbps, day_start).is_ok() {
            let (stake_in, payout) = bet(stake, pbps);
            vault += stake_in;
            reserved += payout;
            n += 1;
            assert!(within_daily_loss(vault - reserved, day_start));
            assert!(reserved as u128 * BPS as u128 <= vault as u128 * MAX_TOTAL_EXPOSURE_BPS as u128);
            assert!(n < 1_000_000);
        }
        (vault, reserved, n)
    }

    #[test]
    fn breaker_counts_every_unsettled_bet_as_won() {
        let day_start = 10_000 * X;
        // (stake, payout, the breaker is what stops the fill: false for High-Low 95%, where 5% pending binds first)
        let games = [
            (X / 100, payout_bps(GAME_VOIDRUSH, MAX_TARGET_BPS), true), // Void Rush 100x
            (X, payout_bps(GAME_COINFLIP, 0), true),                    // coin flip
            (10 * X, payout_bps(GAME_HIGHLOW, MAX_CHANCE_BPS), false),  // High-Low 95%
        ];
        for (stake, pbps, breaker_binds) in games {
            let (_, _, n) = fill(9_700 * X + X / 2, 0, stake, pbps, day_start); // the spec case: 0.5 XNT of room
            assert!(n <= 1);
            let (v, r, n) = fill(9_800 * X, 0, stake, pbps, day_start);
            assert!(n > 0);
            let why = code(lim(v, r, stake, pbps, day_start));
            if breaker_binds {
                assert_eq!(why, Some(ForgeError::DailyLossLimit as u32));
            } else {
                assert_eq!(why, Some(ForgeError::BankrollTooSmall as u32));
            }
        }
    }

    #[test]
    fn pending_payouts_stay_within_5_percent() {
        let (v, r, n) = fill(10_000 * X, 0, X, payout_bps(GAME_COINFLIP, 0), 0);
        assert!(n > 0);
        assert!(r as u128 * BPS as u128 <= v as u128 * 500);
        assert!(r as u128 * BPS as u128 > v as u128 * 475);
    }

    #[test]
    fn per_bet_cap_unchanged() {
        let flip = payout_bps(GAME_COINFLIP, 0);
        assert!(lim(200 * X, 0, X / 2, flip, 0).is_ok());
        assert_eq!(code(lim(200 * X, 0, X, flip, 0)), Some(ForgeError::BankrollTooSmall as u32));
    }

    /// Max winning flips (0.25% of the free bankroll each) until the breaker refuses; returns the vault.
    fn winning_flips(mut vault: u64, day_start: u64) -> u64 {
        let flip = payout_bps(GAME_COINFLIP, 0);
        loop {
            let stake = mul_div(bps(vault, MAX_EXPOSURE_BPS).unwrap(), BPS, flip - BPS).unwrap();
            if stake == 0 || lim(vault, 0, stake, flip, day_start).is_err() {
                return vault;
            }
            let (stake_in, payout) = bet(stake, flip);
            vault = vault + stake_in - payout; // placed, then settled as a win
        }
    }

    #[test]
    fn midnight_pending_bets_do_not_extend_the_breaker() {
        for lp_exit in [false, true] {
            // day 1: 5% of the bankroll pending on 100x bets
            let (mut vault, reserved, _) = fill(10_000 * X, 0, X / 10, payout_bps(GAME_VOIDRUSH, MAX_TARGET_BPS), 0);
            assert!(reserved as u128 * BPS as u128 > vault as u128 * 475);
            // midnight: the first bet of day 2 sets the OPTIMISTIC baseline; while day 1's payouts are pending
            // the worst case is already 5% below it, so nothing new is accepted
            let mut day_start = vault;
            assert_eq!(code(lim(vault, reserved, X / 100, payout_bps(GAME_COINFLIP, 0), day_start)), Some(ForgeError::DailyLossLimit as u32));
            // day 1's bets clear, then the house loses every flip it can still take
            if lp_exit {
                // an LP takes 50% at the conservative value; house_withdraw moves the baseline with it
                let w = vault / 2;
                vault -= w;
                day_start -= w;
            }
            let end = winning_flips(vault, day_start);
            assert!(end < vault);
            assert!((day_start - end) as u128 * BPS as u128 <= day_start as u128 * MAX_DAILY_LOSS_BPS as u128, "lp_exit {lp_exit}");
        }
    }

    #[test]
    fn upgrade_day_baseline() {
        let vault = 10_000 * X;
        let r = lim(vault, vault / 100 * 15, X / 100, payout_bps(GAME_COINFLIP, 0), vault);
        assert_eq!(code(r), Some(ForgeError::DailyLossLimit as u32));
    }

    #[test]
    fn weekly_limit_binds_after_realized_losses() {
        // week_start 1,000 XNT: 15% = 150 XNT of realized loss + pending payouts
        let (stake_in, payout) = bet(X, payout_bps(GAME_COINFLIP, 0));
        let reserved = 30 * X - payout; // 30 XNT pending once this bet is in
        let week = |loss: i64| bet_limits(10_000 * X, reserved, stake_in, X, payout, 0, loss, 1_000 * X, u64::MAX, 0);
        assert!(week(120 * X as i64).is_ok());
        assert_eq!(code(week(121 * X as i64)), Some(ForgeError::WeeklyLossLimit as u32));
        assert!(week(-(500 * X as i64)).is_ok()); // a winning week leaves more room
        // the window start bankroll is huge in no case: no i64 wrap
        assert!(bet_limits(10_000 * X, reserved, stake_in, X, payout, 0, i64::MAX, u64::MAX, u64::MAX, 0).is_err());
    }

    #[test]
    fn bond_must_cover_pending() {
        let (stake_in, payout) = bet(X, payout_bps(GAME_COINFLIP, 0));
        let reserved = 10 * X;
        let with_bond = |bond: u64| bet_limits(10_000 * X, reserved, stake_in, X, payout, 0, 0, BIG, bond, 0);
        assert!(with_bond(reserved + payout).is_ok());
        assert_eq!(code(with_bond(reserved + payout - 1)), Some(ForgeError::KeeperBondTooSmall as u32));
        assert_eq!(code(with_bond(0)), Some(ForgeError::KeeperBondTooSmall as u32)); // a parked seat takes no bets
    }

    #[test]
    fn bond_covers_bets_and_drawing_pots() {
        // bond 20, pending 20 (this bet included), a 20 XNT v3 Jackpot round DRAWING: refused (K-3)
        let (stake_in, payout) = bet(X, payout_bps(GAME_COINFLIP, 0));
        let reserved = 20 * X - payout;
        let run = |bond: u64, jp: u64| bet_limits(10_000 * X, reserved, stake_in, X, payout, 0, 0, BIG, bond, jp);
        assert!(run(20 * X, 0).is_ok());
        assert_eq!(code(run(20 * X, 20 * X)), Some(ForgeError::KeeperBondTooSmall as u32));
        assert!(run(40 * X, 20 * X).is_ok());
        assert_eq!(code(run(40 * X - 1, 20 * X)), Some(ForgeError::KeeperBondTooSmall as u32));
    }

    #[test]
    fn edge_is_one_and_a_half_percent() {
        assert_eq!(bet_edge(XNT).unwrap(), 15_000_000);
        assert_eq!(bet_edge(MIN_STAKE).unwrap(), 150_000);
        assert_eq!(bet_edge(99).unwrap(), 0); // both parts floor to 0
        assert_eq!(bet_edge(199).unwrap(), 1); // 1% part 1, 0.5% part 0
    }
}
