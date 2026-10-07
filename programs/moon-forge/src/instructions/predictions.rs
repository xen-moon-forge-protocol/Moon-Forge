//! Predictions — pari-mutuel "XNT up or down" rounds, priced by the TWAP that XDEX records on-chain.
//!
//! enter_prediction  : the wallet owner (never a bot session key) stakes on UP or DOWN for the current
//!                     round, before its lock time. One entry per wallet per round. Pot capped.
//! lock_prediction   : PERMISSIONLESS after the lock time: records the start price = 15-minute TWAP
//!                     ending at the lock time. A round where one side is empty is refunded.
//! settle_prediction : PERMISSIONLESS after the end time: end price = 15-minute TWAP ending then.
//!                     Up if end > start, down if end < start; a tie refunds everyone. The winning side
//!                     shares the pot pro-rata minus the 2% P2P rake (1% pool, 0.5% architect, 0.5% lottery).
//! claim_prediction  : PERMISSIONLESS push of an entry's payout (or refund) to its owner's game wallet.
//! close_prediction_round : PERMISSIONLESS once every entry is claimed: rounding dust goes to the
//!                     reward pool, the account rent back to the first entrant who paid it.
//! If the price data needed for a round has left XDEX's on-chain window (≈100 observations), or never
//! appears (no swap in the pool for PRED_MAX_DELAY after the lock / end time), the round is refunded in
//! full: nobody can win by delaying a lock or a settlement, and no stake can stay stuck.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::ForgeError;
use crate::events::*;
use crate::instructions::games::debit_balance;
use crate::instructions::p2p::{add_rake_stats, credit};
use crate::state::*;
use crate::utils::*;

// ═══════════════════════════════════════════════════════════════════════════
// XDEX TWAP (Raydium-CPMM ObservationState: disc 8 | initialized 1 | index 2 | pool 32 |
// 100 × { block_timestamp u64, cumulative_token_0_price_x32 u128, cumulative_token_1_price_x32 u128 })
// token 0 of the WXNT/USDC.X pool is WXNT, so token-0 price = USDC.X per XNT (raw units, × 2^32).
// ═══════════════════════════════════════════════════════════════════════════

pub enum Twap {
    Ready(u128),
    /// no observation at or after the end time yet (no swap since)
    NotYet,
    /// the window start has left the 100-observation ring
    Unavailable,
}

const OBS_HEADER: usize = 8 + 1 + 2 + 32;
const OBS_SIZE: usize = 40;
const OBS_NUM: usize = 100;

/// TWAP over [end - window, end], from stored observations only: lo = last observation at or before
/// end - window, hi = first observation at or after end. Each observation integrates the price that
/// held since the previous one (recorded before each swap moves it), so a price must be held for
/// time to move the average.
pub fn twap_from(data: &[u8], end: u64, window: u64) -> Result<Twap> {
    require!(data.len() >= OBS_HEADER + OBS_SIZE * OBS_NUM, ForgeError::BadPriceAccount);
    let start = end.saturating_sub(window);
    let mut lo: Option<(u64, u128)> = None;
    let mut hi: Option<(u64, u128)> = None;
    for i in 0..OBS_NUM {
        let o = OBS_HEADER + i * OBS_SIZE;
        let ts = u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
        if ts == 0 {
            continue;
        }
        let cum = u128::from_le_bytes(data[o + 8..o + 24].try_into().unwrap());
        if ts <= start && lo.map_or(true, |(t, _)| ts > t) {
            lo = Some((ts, cum));
        }
        if ts >= end && hi.map_or(true, |(t, _)| ts < t) {
            hi = Some((ts, cum));
        }
    }
    let Some((t_hi, c_hi)) = hi else { return Ok(Twap::NotYet) };
    let Some((t_lo, c_lo)) = lo else { return Ok(Twap::Unavailable) };
    if t_hi <= t_lo {
        return Ok(Twap::Unavailable);
    }
    Ok(Twap::Ready(c_hi.wrapping_sub(c_lo) / (t_hi - t_lo) as u128))
}

fn read_twap(obs: &AccountInfo, end: i64) -> Result<Twap> {
    require_keys_eq!(*obs.key, XDEX_XNT_OBSERVATION, ForgeError::BadPriceAccount);
    require_keys_eq!(*obs.owner, XDEX_PROGRAM, ForgeError::BadPriceAccount);
    let data = obs.try_borrow_data()?;
    require!(data.len() >= OBS_HEADER, ForgeError::BadPriceAccount);
    require!(data[11..43] == XDEX_XNT_POOL.to_bytes(), ForgeError::BadPriceAccount);
    twap_from(&data, end.max(0) as u64, PRED_TWAP_WINDOW)
}

// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct EnterPrediction<'info> {
    #[account(
        init_if_needed, payer = owner, space = 8 + PredRound::INIT_SPACE,
        seeds = [SEED_PRED, round_id.to_le_bytes().as_ref()], bump
    )]
    pub round: Box<Account<'info, PredRound>>,
    #[account(
        init, payer = owner, space = 8 + PredEntry::INIT_SPACE,
        seeds = [SEED_PRED_ENTRY, round_id.to_le_bytes().as_ref(), owner.key().as_ref()], bump
    )]
    pub entry: Box<Account<'info, PredEntry>>,
    #[account(
        mut, seeds = [SEED_PLAYER, owner.key().as_ref()], bump = player_state.bump,
        constraint = player_state.owner == owner.key() @ ForgeError::Unauthorized
    )]
    pub player_state: Box<Account<'info, PlayerState>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn enter_prediction(ctx: Context<EnterPrediction>, round_id: u64, side: u8, amount: u64) -> Result<()> {
    require!(side <= SIDE_UP, ForgeError::InvalidMove);
    require!(amount >= MIN_STAKE, ForgeError::AmountTooSmall);
    let now = Clock::get()?.unix_timestamp;
    require!(round_id == (now / PRED_PERIOD) as u64, ForgeError::PredState);
    let r = &mut ctx.accounts.round;
    if r.lock_ts == 0 {
        r.id = round_id;
        r.lock_ts = (round_id as i64) * PRED_PERIOD + PRED_BET_WINDOW;
        r.end_ts = r.lock_ts + PRED_HORIZON;
        r.state = PRED_OPEN;
        r.rent_payer = ctx.accounts.owner.key();
        r.bump = ctx.bumps.round;
    }
    require!(r.state == PRED_OPEN && now < r.lock_ts, ForgeError::PredState);
    let pot = r.totals[0].checked_add(r.totals[1]).ok_or(ForgeError::MathOverflow)?;
    require!(pot.checked_add(amount).ok_or(ForgeError::MathOverflow)? <= PRED_MAX_POT, ForgeError::PotFull);
    r.totals[side as usize] = r.totals[side as usize].checked_add(amount).ok_or(ForgeError::MathOverflow)?;
    r.entries += 1;

    debit_balance(&mut ctx.accounts.player_state, amount)?;
    move_lamports(&ctx.accounts.player_state.to_account_info(), &ctx.accounts.round.to_account_info(), amount)?;
    let e = &mut ctx.accounts.entry;
    e.round = round_id;
    e.player = ctx.accounts.owner.key();
    e.side = side;
    e.amount = amount;
    e.rent_payer = ctx.accounts.owner.key();
    e.bump = ctx.bumps.entry;
    Ok(())
}

#[derive(Accounts)]
pub struct LockPrediction<'info> {
    #[account(mut, seeds = [SEED_PRED, round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, PredRound>>,
    /// CHECK: XDEX observation account (address, owner and pool checked when read)
    pub observation: UncheckedAccount<'info>,
}

pub fn lock_prediction(ctx: Context<LockPrediction>) -> Result<()> {
    let r = &mut ctx.accounts.round;
    require!(r.state == PRED_OPEN, ForgeError::PredState);
    require!(Clock::get()?.unix_timestamp >= r.lock_ts, ForgeError::RoundRunning);
    if r.totals[0] == 0 || r.totals[1] == 0 {
        r.state = PRED_REFUND; // no contest
        r.outcome = 2;
        emit!(PredictionResolved { round: r.id, start_price_x32: 0, end_price_x32: 0, outcome: 2, pot: r.totals[0] + r.totals[1] });
        return Ok(());
    }
    let now = Clock::get()?.unix_timestamp;
    match read_twap(&ctx.accounts.observation, r.lock_ts)? {
        Twap::NotYet if now <= r.lock_ts.saturating_add(PRED_MAX_DELAY) => err!(ForgeError::NotReady),
        Twap::NotYet | Twap::Unavailable => {
            r.state = PRED_REFUND;
            r.outcome = 2;
            emit!(PredictionResolved { round: r.id, start_price_x32: 0, end_price_x32: 0, outcome: 2, pot: r.totals[0] + r.totals[1] });
            Ok(())
        }
        Twap::Ready(p) => {
            r.start_price_x32 = p;
            r.state = PRED_LOCKED;
            Ok(())
        }
    }
}

#[derive(Accounts)]
pub struct SettlePrediction<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_PRED, round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, PredRound>>,
    /// CHECK: XDEX observation account (address, owner and pool checked when read)
    pub observation: UncheckedAccount<'info>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: draw vault PDA
    #[account(mut, seeds = [SEED_DRAW_VAULT], bump = config.bumps[2])]
    pub draw_vault: UncheckedAccount<'info>,
    /// CHECK: architect wallet
    #[account(mut, address = config.architect @ ForgeError::InvalidTarget)]
    pub architect: UncheckedAccount<'info>,
}

pub fn settle_prediction(ctx: Context<SettlePrediction>) -> Result<()> {
    let a = &mut *ctx.accounts;
    require!(a.round.state == PRED_LOCKED, ForgeError::PredState);
    require!(Clock::get()?.unix_timestamp >= a.round.end_ts, ForgeError::RoundRunning);
    let pot = a.round.totals[0] + a.round.totals[1];
    let now = Clock::get()?.unix_timestamp;
    let end = match read_twap(&a.observation, a.round.end_ts)? {
        Twap::NotYet if now <= a.round.end_ts.saturating_add(PRED_MAX_DELAY) => return err!(ForgeError::NotReady),
        Twap::NotYet | Twap::Unavailable => None,
        Twap::Ready(p) => Some(p),
    };
    let start = a.round.start_price_x32;
    let outcome = match end {
        Some(p) if p > start => SIDE_UP,
        Some(p) if p < start => SIDE_DOWN,
        _ => 2,
    };
    a.round.end_price_x32 = end.unwrap_or(0);
    a.round.outcome = outcome;
    if outcome == 2 {
        a.round.state = PRED_REFUND;
    } else {
        let rinfo = a.round.to_account_info();
        let rake = split_rake(&rinfo, &a.reward_vault.to_account_info(), &a.architect.to_account_info(), &a.draw_vault.to_account_info(), pot)?;
        a.round.prize_pool = pot - rake.0 - rake.1 - rake.2;
        a.round.state = PRED_SETTLED;
        add_rake_stats(&mut a.config, rake);
    }
    emit!(PredictionResolved { round: a.round.id, start_price_x32: start, end_price_x32: a.round.end_price_x32, outcome, pot });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimPrediction<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_PRED, entry.round.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, PredRound>>,
    #[account(
        mut, close = rent_payer,
        seeds = [SEED_PRED_ENTRY, entry.round.to_le_bytes().as_ref(), entry.player.as_ref()], bump = entry.bump
    )]
    pub entry: Box<Account<'info, PredEntry>>,
    #[account(mut, seeds = [SEED_PLAYER, entry.player.as_ref()], bump = player_state.bump)]
    pub player_state: Box<Account<'info, PlayerState>>,
    /// CHECK: original rent payer of the entry
    #[account(mut, address = entry.rent_payer @ ForgeError::WrongRentPayer)]
    pub rent_payer: UncheckedAccount<'info>,
}

/// PERMISSIONLESS. Winners get amount × prize_pool / winning_total; a refunded round returns the stake;
/// a losing entry just closes (its rent goes back to whoever paid it).
pub fn claim_prediction(ctx: Context<ClaimPrediction>) -> Result<()> {
    let state = ctx.accounts.round.state;
    require!(state == PRED_SETTLED || state == PRED_REFUND, ForgeError::PredState);
    let e = &ctx.accounts.entry;
    let payout = if state == PRED_REFUND {
        e.amount
    } else if e.side == ctx.accounts.round.outcome {
        mul_div(e.amount, ctx.accounts.round.prize_pool, ctx.accounts.round.totals[e.side as usize])?
    } else {
        0
    };
    if payout > 0 {
        let rinfo = ctx.accounts.round.to_account_info();
        credit(&ctx.accounts.player_state.to_account_info(), &mut ctx.accounts.player_state, &rinfo, payout)?;
        if state == PRED_SETTLED {
            ctx.accounts.config.stats.paid_to_players = ctx.accounts.config.stats.paid_to_players.saturating_add(payout);
        }
    }
    ctx.accounts.round.claimed += 1;
    Ok(())
}

#[derive(Accounts)]
pub struct ClosePredictionRound<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, close = rent_payer, seeds = [SEED_PRED, round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, PredRound>>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: first entrant, paid the round rent
    #[account(mut, address = round.rent_payer @ ForgeError::WrongRentPayer)]
    pub rent_payer: UncheckedAccount<'info>,
}

/// PERMISSIONLESS. After the last claim only rounding dust (< 1 lamport per winner) and rent remain.
pub fn close_prediction_round(ctx: Context<ClosePredictionRound>) -> Result<()> {
    let r = &ctx.accounts.round;
    require!(r.state == PRED_SETTLED || r.state == PRED_REFUND, ForgeError::PredState);
    require!(r.claimed == r.entries, ForgeError::PredState);
    let rinfo = ctx.accounts.round.to_account_info();
    let dust = rinfo.lamports().saturating_sub(rent_min(&rinfo)?);
    move_lamports(&rinfo, &ctx.accounts.reward_vault.to_account_info(), dust)
}

#[cfg(test)]
mod twap_tests {
    use super::*;

    fn ring(points: &[(u64, u128)]) -> Vec<u8> {
        let mut d = vec![0u8; OBS_HEADER + OBS_SIZE * OBS_NUM + 32];
        for (i, (ts, cum)) in points.iter().enumerate() {
            let o = OBS_HEADER + i * OBS_SIZE;
            d[o..o + 8].copy_from_slice(&ts.to_le_bytes());
            d[o + 8..o + 24].copy_from_slice(&cum.to_le_bytes());
        }
        d
    }

    #[test]
    fn twap_is_the_time_weighted_average() {
        // price 100 for 600 s, then 200 for 600 s → cumulative 60_000 then 180_000
        let d = ring(&[(1_000, 0), (1_600, 60_000), (2_200, 180_000)]);
        match twap_from(&d, 2_200, 1_200).unwrap() { Twap::Ready(p) => assert_eq!(p, 150), _ => panic!() }
        match twap_from(&d, 2_200, 600).unwrap() { Twap::Ready(p) => assert_eq!(p, 200), _ => panic!() }
    }

    #[test]
    fn needs_an_observation_after_the_end_and_one_before_the_window() {
        let d = ring(&[(1_000, 0), (1_600, 60_000)]);
        assert!(matches!(twap_from(&d, 2_000, 600).unwrap(), Twap::NotYet));
        assert!(matches!(twap_from(&d, 1_600, 900).unwrap(), Twap::Unavailable));
    }

    #[test]
    fn a_spike_between_observations_barely_moves_it() {
        // stable price 100; a manipulator holds 10_000 for 15 s right before the end
        let d = ring(&[(1_000, 0), (1_885, 88_500), (1_900, 88_500 + 150_000)]);
        match twap_from(&d, 1_900, 900).unwrap() { Twap::Ready(p) => assert_eq!(p, 265), _ => panic!() }
        // 100x the price for 15 s of a 15-minute window moves the TWAP to 2.65x, not 100x; holding it
        // longer costs the manipulator arbitrage losses in the pool, while the pot is capped at 200 XNT
    }

    #[test]
    fn wrapping_cumulatives_are_handled() {
        let d = ring(&[(1_000, u128::MAX - 49), (1_100, 50)]);
        match twap_from(&d, 1_100, 100).unwrap() { Twap::Ready(p) => assert_eq!(p, 1), _ => panic!() }
    }
}
