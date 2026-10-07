//! Player game wallet, session keys (bots / auto-play), house games and the
//! "Be the House" bankroll LP.
//!
//! House games are two-step (commit → settle) so nobody can see the outcome
//! before the stake is locked:
//!   place_bet : stake locked, max payout reserved, target_slot = now + 1
//!   settle_bet: PERMISSIONLESS. roll = keccak(slot_hash(target) || bet || seed) % 10_000
//! If nobody settles before the target slot hash leaves the SlotHashes window
//! (~3 min), the bet counts as LOST — a player can never "skip" a bad result.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
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
    fn circuit_breaker_trips_at_ten_percent_daily_loss() {
        assert!(within_daily_loss(1_000, 1_000));
        assert!(within_daily_loss(900, 1_000)); // exactly -10%: still allowed
        assert!(!within_daily_loss(899, 1_000));
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
    /// CHECK: architect wallet (constant)
    #[account(mut, address = config.architect @ ForgeError::InvalidTarget)]
    pub architect: UncheckedAccount<'info>,
    /// Owner or session key. Pays the (refundable) bet account rent.
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn place_bet(ctx: Context<PlaceBet>, game: u8, param: u64, choice: u8, stake: u64, seed: [u8; 32]) -> Result<()> {
    // Bets must be top-level instructions: no program can wrap them.
    require!(get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT, ForgeError::Unauthorized);
    require!(stake >= MIN_STAKE, ForgeError::AmountTooSmall);
    authorize_play(&ctx.accounts.player_state, &ctx.accounts.signer.key(), stake)?;

    let (chance_bps, payout_bps) = game_odds(game, param, choice)?;
    let payout = mul_div(stake, payout_bps, BPS)?;
    require!(payout > stake, ForgeError::InvalidGame);

    // circuit breaker: at most 10% of the bankroll (net of LP flows) can be lost per day
    let now = Clock::get()?.unix_timestamp;
    let today = now / DAY_SECONDS_FOR_BREAKER;
    let value_now = free_balance(&ctx.accounts.bankroll_vault, 0)?;
    {
        let c = &mut ctx.accounts.config;
        if c.bankroll_day != today {
            c.bankroll_day = today;
            c.bankroll_day_start = value_now;
        }
        require!(within_daily_loss(value_now, c.bankroll_day_start), ForgeError::DailyLossLimit);
    }

    let reserved = ctx.accounts.config.bankroll_reserved;
    let free_before = free_balance(&ctx.accounts.bankroll_vault, reserved)?;
    require!(payout - stake <= bps(free_before, MAX_EXPOSURE_BPS)?, ForgeError::BankrollTooSmall);

    // Stake leaves the player's game balance. 1% -> burners' pool, 0.5% -> architect,
    // 98.5% -> bankroll (which then owes the full payout if the bet wins).
    debit_balance(&mut ctx.accounts.player_state, stake)?;
    let mut to_pool = bps(stake, EDGE_TO_POOL_BPS)?;
    let mut to_arch = bps(stake, EDGE_TO_ARCHITECT_BPS)?;
    let edge = to_pool + to_arch;
    let ps_info = ctx.accounts.player_state.to_account_info();
    let reward_info = ctx.accounts.reward_vault.to_account_info();
    let arch_info = ctx.accounts.architect.to_account_info();
    if architect_or_pool(&arch_info, &reward_info, to_arch)?.key == reward_info.key {
        to_pool += to_arch;
        to_arch = 0;
    }
    move_lamports(&ps_info, &reward_info, to_pool)?;
    move_lamports(&ps_info, &arch_info, to_arch)?;
    move_lamports(&ps_info, &ctx.accounts.bankroll_vault.to_account_info(), stake - edge)?;

    let free_after = free_balance(&ctx.accounts.bankroll_vault, reserved)?;
    require!(free_after >= payout, ForgeError::BankrollTooSmall);
    // aggregate cap: all unsettled payouts together stay below 20% of the bankroll
    let total_after = free_balance(&ctx.accounts.bankroll_vault, 0)?;
    require!(
        reserved.checked_add(payout).ok_or(ForgeError::MathOverflow)? <= bps(total_after, MAX_TOTAL_EXPOSURE_BPS)?,
        ForgeError::BankrollTooSmall
    );

    let slot = Clock::get()?.slot;
    let bet_key = ctx.accounts.bet.key();
    let ps_key = ctx.accounts.player_state.key();
    let owner = ctx.accounts.player_state.owner;
    let nonce = ctx.accounts.player_state.nonce;
    let b = &mut ctx.accounts.bet;
    b.player_state = ps_key;
    b.owner = owner;
    b.rent_payer = ctx.accounts.signer.key();
    b.game = game;
    b.choice = choice;
    b.chance_bps = chance_bps;
    b.stake = stake;
    b.payout = payout;
    b.seed = seed;
    b.target_slot = slot + 1;
    b.nonce = nonce;
    b.bump = ctx.bumps.bet;

    let ps = &mut ctx.accounts.player_state;
    ps.nonce += 1;
    let before = ps.total_wagered / CHIP_PER_WAGERED;
    ps.total_wagered = ps.total_wagered.saturating_add(stake);
    let new_chips = ps.total_wagered / CHIP_PER_WAGERED - before;
    ps.chips = ps.chips.saturating_add(new_chips);

    let c = &mut ctx.accounts.config;
    c.bankroll_reserved = c.bankroll_reserved.checked_add(payout).ok_or(ForgeError::MathOverflow)?;
    c.stats.wagered = c.stats.wagered.saturating_add(stake);
    c.stats.bets = c.stats.bets.saturating_add(1);
    c.stats.edge_to_pool = c.stats.edge_to_pool.saturating_add(to_pool);
    c.stats.to_architect = c.stats.to_architect.saturating_add(to_arch);

    emit!(BetPlaced {
        owner,
        bet: bet_key,
        game,
        choice,
        chance_bps,
        stake,
        payout,
        target_slot: slot + 1,
        to_pool,
        to_architect: to_arch,
    });
    Ok(())
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

/// PERMISSIONLESS — keepers, bots, the player or anyone can settle.
pub fn settle_bet(ctx: Context<SettleBet>) -> Result<()> {
    let bet = &ctx.accounts.bet;
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
    emit!(BetSettled { owner, bet: bet_key, game, roll, won, expired, stake, payout: if won { payout } else { 0 } });
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

/// Starts the 24h cooldown (prevents LPs from dodging pending bets).
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
