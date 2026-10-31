//! Predictions — pari-mutuel "XNT up or down" rounds, priced by the TWAP that XDEX records on-chain.
//!
//! enter_prediction  : the wallet owner (never a bot session key) stakes on UP or DOWN for the current round
//!                     while it accepts entries. One entry per wallet per round. Pot and each side capped.
//! lock_prediction   : PERMISSIONLESS once the lock time has passed: records the start price. A round where one
//!                     side is empty is refunded.
//! settle_prediction : PERMISSIONLESS once the end time has passed: records the end price. Up if end > start, down
//!                     if end < start; a tie refunds everyone. The winning side shares the pot pro-rata minus the
//!                     2% P2P rake (1.5% pool, 0.5% architect).
//! claim_prediction  : PERMISSIONLESS push of an entry's payout (or refund) to its owner's game wallet.
//! close_prediction_round : PERMISSIONLESS once every entry is claimed: rounding dust goes to the reward pool,
//!                     the account rent back to the first entrant who paid it.
//!
//! v2 schedule (rounds created since the final upgrade; v1 rounds are those with end − lock == PRED_V1_HORIZON
//! and keep the schedule they were created with): round k opens at k × PRED_PERIOD (UTC); entries close
//! PRED_TWAP_WINDOW + PRED_MAX_GAP before the lock; start = the PRED_TWAP_WINDOW TWAP ending at the lock
//! (k × PRED_PERIOD + PRED_LOCK_OFFSET), end = the same TWAP ending PRED_HORIZON later. A v2 read uses the ring in
//! XDEX write order and never a write made after the time it prices; the clock must be strictly past that time.
//! A v2 round is refunded in full when the ring has a gap > PRED_MAX_GAP inside the window, its last write before
//! the time is older than PRED_MAX_GAP (stale end), the window start already left the ring, or the XDEX account was
//! closed or reshaped; and when the price moved less than PRED_MIN_MOVE_BPS (no contest). v1 rounds keep the old
//! read (first write at or after the time) with a stretch guard, and a refund if no write comes PRED_V1_MAX_DELAY
//! after the time. Nobody can win by delaying a lock or a settlement, and no stake can stay stuck.

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

/// v2 read. The ring in XDEX write order (observation_index at bytes 9..11 = newest), never a write made after
/// `end`. lo = the last write at or before the window start (it must still be in the ring: no fallback), hi = the
/// last write at or before `end`. Never NotYet, never an error.
pub fn twap_v2(data: &[u8], end: u64, window: u64) -> Twap {
    if data.len() < OBS_HEADER + OBS_SIZE * OBS_NUM {
        return Twap::Unavailable;
    }
    let start = end.saturating_sub(window);
    let newest = u16::from_le_bytes([data[9], data[10]]) as usize % OBS_NUM;
    let (mut lo, mut hi): (Option<(u64, u128)>, Option<(u64, u128)>) = (None, None);
    for k in 1..=OBS_NUM {
        let o = OBS_HEADER + ((newest + k) % OBS_NUM) * OBS_SIZE;
        let ts = u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
        if ts == 0 {
            continue;
        }
        if ts > end {
            break;
        }
        let cum = u128::from_le_bytes(data[o + 8..o + 24].try_into().unwrap());
        if let Some((t, _)) = hi {
            if ts <= t {
                return Twap::Unavailable; // not in write order
            }
            if ts > start && ts - t > PRED_MAX_GAP {
                return Twap::Unavailable; // a hole in the window
            }
        }
        if ts <= start {
            lo = Some((ts, cum)); // last write at/before the start
        }
        hi = Some((ts, cum));
    }
    let (Some((t_lo, c_lo)), Some((t_hi, c_hi))) = (lo, hi) else { return Twap::Unavailable };
    if t_hi <= t_lo || end - t_hi > PRED_MAX_GAP {
        return Twap::Unavailable;
    }
    match c_hi.wrapping_sub(c_lo) / (t_hi - t_lo) as u128 {
        0 => Twap::Unavailable,
        p => Twap::Ready(p),
    }
}

/// A round created by the v2 binary (v1 schedule) keeps its rules.
pub fn is_v1_schedule(lock_ts: i64, end_ts: i64) -> bool {
    end_ts - lock_ts == PRED_V1_HORIZON
}
/// Entries close at the lock (v1) or one TWAP window + one max gap before it (v2: no entry while start data forms).
pub fn entry_close(lock_ts: i64, end_ts: i64) -> i64 {
    if is_v1_schedule(lock_ts, end_ts) {
        lock_ts
    } else {
        lock_ts - (PRED_TWAP_WINDOW + PRED_MAX_GAP) as i64
    }
}
/// v2 needs the clock strictly past the time (every write at or before it is then final; X1's clock is monotonic).
pub fn time_reached(now: i64, t: i64, v1: bool) -> bool {
    if v1 {
        now >= t
    } else {
        now > t
    }
}
/// Earliest write at or after `at` (v1 stretch guard).
fn first_write_at_or_after(data: &[u8], at: u64) -> Option<u64> {
    (0..OBS_NUM)
        .map(|i| u64::from_le_bytes(data[OBS_HEADER + i * OBS_SIZE..OBS_HEADER + i * OBS_SIZE + 8].try_into().unwrap()))
        .filter(|ts| *ts != 0 && *ts >= at)
        .min()
}
/// The price of a round time from the observation account's data (address and owner already checked).
pub fn round_price_data(data: &[u8], v1: bool, at: i64) -> Result<Twap> {
    if data.len() < OBS_HEADER + OBS_SIZE * OBS_NUM || data[11..43] != XDEX_XNT_POOL.to_bytes() {
        return Ok(Twap::Unavailable); // reshaped or reassigned: refund
    }
    let at = at.max(0) as u64;
    if v1 {
        let t = twap_from(data, at, PRED_V1_TWAP_WINDOW)?;
        // v1 stretch guard: a closing write later than one window after the time would carry the whole gap
        if matches!(t, Twap::Ready(_)) && first_write_at_or_after(data, at).map_or(true, |ts| ts > at + PRED_V1_TWAP_WINDOW) {
            return Ok(Twap::Unavailable);
        }
        Ok(t)
    } else {
        Ok(twap_v2(data, at, PRED_TWAP_WINDOW))
    }
}
fn round_price(obs: &AccountInfo, v1: bool, at: i64) -> Result<Twap> {
    require_keys_eq!(*obs.key, XDEX_XNT_OBSERVATION, ForgeError::BadPriceAccount); // wrong address = caller error
    if *obs.owner != XDEX_PROGRAM {
        return Ok(Twap::Unavailable); // XDEX closed / reassigned it: refund
    }
    let data = obs.try_borrow_data()?;
    round_price_data(&data, v1, at)
}

/// What a lock or a settle does with a price read.
#[derive(Debug, PartialEq)]
pub enum PriceStep {
    /// v1 only: no write after the time yet, still inside PRED_V1_MAX_DELAY
    NotReady,
    Refund,
    Price(u128),
}
pub fn price_step(t: Twap, v1: bool, now: i64, at: i64) -> PriceStep {
    match t {
        Twap::NotYet if v1 && now <= at.saturating_add(PRED_V1_MAX_DELAY) => PriceStep::NotReady,
        Twap::NotYet | Twap::Unavailable => PriceStep::Refund,
        Twap::Ready(p) => PriceStep::Price(p),
    }
}
/// v2 rounds: |end − start| < PRED_MIN_MOVE_BPS of start is no contest (full refund). v1 rounds: only a tie.
pub fn no_contest(start: u128, end: u128, v1: bool) -> bool {
    let diff = start.abs_diff(end);
    if v1 {
        diff == 0
    } else {
        diff.saturating_mul(BPS as u128) < start.saturating_mul(PRED_MIN_MOVE_BPS as u128)
    }
}
/// 1 up, 0 down, 2 refund.
pub fn settle_outcome(start: u128, end: Option<u128>, v1: bool) -> u8 {
    match end {
        Some(p) if no_contest(start, p, v1) => 2,
        Some(p) if p > start => SIDE_UP,
        Some(p) if p < start => SIDE_DOWN,
        _ => 2,
    }
}
/// New totals after an entry: the pot cap and (since the final upgrade, v1 rounds included) the side cap.
pub fn add_entry(totals: [u64; 2], side: u8, amount: u64) -> Result<[u64; 2]> {
    let pot = totals[0].checked_add(totals[1]).ok_or(ForgeError::MathOverflow)?;
    require!(pot.checked_add(amount).ok_or(ForgeError::MathOverflow)? <= PRED_MAX_POT, ForgeError::PotFull);
    let side_total = totals[side as usize].checked_add(amount).ok_or(ForgeError::MathOverflow)?;
    require!(side_total <= PRED_MAX_SIDE, ForgeError::PotFull);
    let mut t = totals;
    t[side as usize] = side_total;
    Ok(t)
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
        r.lock_ts = (round_id as i64) * PRED_PERIOD + PRED_LOCK_OFFSET;
        r.end_ts = r.lock_ts + PRED_HORIZON;
        r.state = PRED_OPEN;
        r.rent_payer = ctx.accounts.owner.key();
        r.bump = ctx.bumps.round;
    }
    // in-flight v1 rounds keep closing at their lock
    require!(r.state == PRED_OPEN && now < entry_close(r.lock_ts, r.end_ts), ForgeError::PredState);
    r.totals = add_entry(r.totals, side, amount)?;
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
    /// CHECK: XDEX observation account (address checked when read; a foreign owner or shape refunds)
    pub observation: UncheckedAccount<'info>,
}

fn refund_round(r: &mut PredRound) {
    r.state = PRED_REFUND;
    r.outcome = 2;
    emit!(PredictionResolved { round: r.id, start_price_x32: 0, end_price_x32: 0, outcome: 2, pot: r.totals[0] + r.totals[1] });
}

pub fn lock_prediction(ctx: Context<LockPrediction>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let r = &mut ctx.accounts.round;
    require!(r.state == PRED_OPEN, ForgeError::PredState);
    let v1 = is_v1_schedule(r.lock_ts, r.end_ts);
    require!(time_reached(now, r.lock_ts, v1), ForgeError::RoundRunning);
    if r.totals[0] == 0 || r.totals[1] == 0 {
        refund_round(r); // no contest
        return Ok(());
    }
    match price_step(round_price(&ctx.accounts.observation, v1, r.lock_ts)?, v1, now, r.lock_ts) {
        PriceStep::NotReady => err!(ForgeError::NotReady),
        PriceStep::Refund => {
            refund_round(r);
            Ok(())
        }
        PriceStep::Price(p) => {
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
    /// CHECK: XDEX observation account (address checked when read; a foreign owner or shape refunds)
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
    let now = Clock::get()?.unix_timestamp;
    let a = &mut *ctx.accounts;
    require!(a.round.state == PRED_LOCKED, ForgeError::PredState);
    let v1 = is_v1_schedule(a.round.lock_ts, a.round.end_ts);
    require!(time_reached(now, a.round.end_ts, v1), ForgeError::RoundRunning);
    let pot = a.round.totals[0] + a.round.totals[1];
    let end = match price_step(round_price(&a.observation, v1, a.round.end_ts)?, v1, now, a.round.end_ts) {
        PriceStep::NotReady => return err!(ForgeError::NotReady),
        PriceStep::Refund => None,
        PriceStep::Price(p) => Some(p),
    };
    let start = a.round.start_price_x32;
    let outcome = settle_outcome(start, end, v1);
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

#[cfg(test)]
mod twap_v2_tests {
    use super::*;

    const E: u64 = 1_800_000_000;

    /// Writes the points chronologically from ring index `first` and sets observation_index to the newest.
    fn ring2(points: &[(u64, u128)], first: usize) -> Vec<u8> {
        let mut d = vec![0u8; OBS_HEADER + OBS_SIZE * OBS_NUM];
        d[11..43].copy_from_slice(&XDEX_XNT_POOL.to_bytes());
        for (i, (ts, cum)) in points.iter().enumerate() {
            let o = OBS_HEADER + ((first + i) % OBS_NUM) * OBS_SIZE;
            d[o..o + 8].copy_from_slice(&ts.to_le_bytes());
            d[o + 8..o + 24].copy_from_slice(&cum.to_le_bytes());
        }
        if !points.is_empty() {
            let newest = ((first + points.len() - 1) % OBS_NUM) as u16;
            d[9..11].copy_from_slice(&newest.to_le_bytes());
        }
        d
    }
    /// Cumulative price at each write time for a per-second price path, integrated from E − 3,000.
    fn writes(ts: &[u64], price: impl Fn(u64) -> u128) -> Vec<(u64, u128)> {
        ts.iter()
            .map(|&t| (t, ((E - 3_000 + 1)..=t).map(&price).sum::<u128>()))
            .collect()
    }
    fn ready(t: Twap) -> Option<u128> {
        match t {
            Twap::Ready(p) => Some(p),
            _ => None,
        }
    }
    fn unavailable(t: Twap) -> bool {
        matches!(t, Twap::Unavailable)
    }
    /// price 100 every 300 s from E − 1,200 to E
    fn steady() -> Vec<(u64, u128)> {
        vec![(E - 1_200, 0), (E - 900, 30_000), (E - 600, 60_000), (E - 300, 90_000), (E, 120_000)]
    }

    #[test]
    fn v2_never_uses_a_write_after_the_end() {
        let d = ring2(&[(E - 1_200, 0), (E - 900, 30_000), (E - 600, 60_000), (E - 300, 90_000), (E + 300, 151_200)], 0);
        assert_eq!(ready(twap_from(&d, E, 900).unwrap()), Some(101)); // v1 reads the write after the end
        assert_eq!(ready(twap_v2(&d, E, PRED_TWAP_WINDOW)), Some(100));
    }

    #[test]
    fn v2_refunds_on_a_hole() {
        assert_eq!(ready(twap_v2(&ring2(&steady(), 0), E, PRED_TWAP_WINDOW)), Some(100)); // 300-s gaps
        let hole = [(E - 1_200, 0), (E - 899, 30_100), (E - 600, 60_000), (E - 300, 90_000), (E, 120_000)];
        assert!(unavailable(twap_v2(&ring2(&hole, 0), E, PRED_TWAP_WINDOW))); // 301 s
        // a gap before the window start does not matter
        let early = [(E - 2_000, 0), (E - 1_200, 80_000), (E - 900, 110_000), (E - 600, 140_000), (E - 300, 170_000), (E, 200_000)];
        assert_eq!(ready(twap_v2(&ring2(&early, 0), E, PRED_TWAP_WINDOW)), Some(100));
    }

    #[test]
    fn v2_refunds_on_a_stale_end() {
        let stale = [(E - 1_200, 0), (E - 900, 30_000), (E - 600, 60_000), (E - 301, 89_900)];
        assert!(unavailable(twap_v2(&ring2(&stale, 0), E, PRED_TWAP_WINDOW)));
        let fresh = [(E - 1_200, 0), (E - 900, 30_000), (E - 600, 60_000), (E - 300, 90_000)];
        assert_eq!(ready(twap_v2(&ring2(&fresh, 0), E, PRED_TWAP_WINDOW)), Some(100));
    }

    #[test]
    fn v2_spam_before_the_end_cannot_move_the_window() {
        // ×100 prices: 101 on (E − 1,200, E − 600], 99.5 on (E − 600, ∞); 100 before. Exact mean: 100.25.
        let price = |t: u64| -> u128 {
            if t <= E - 1_200 {
                10_000
            } else if t <= E - 600 {
                10_100
            } else {
                9_950
            }
        };
        let honest: Vec<u64> = (0..=10).rev().map(|j| E - 150 * j).collect(); // E − 1,500 … E
        let d = ring2(&writes(&honest, price), 0);
        assert_eq!(ready(twap_v2(&d, E, PRED_TWAP_WINDOW)), Some(10_025));
        // zero-impact spam every 15 s over (E − 1,485, E] fills the whole 100-entry ring: same lo, same price
        let mut all: Vec<u64> = (0..=98).rev().map(|j| E - 15 * j).collect();
        all.insert(0, E - 1_500);
        assert_eq!(all.len(), OBS_NUM);
        let d = ring2(&writes(&all, price), 0);
        assert_eq!(ready(twap_v2(&d, E, PRED_TWAP_WINDOW)), Some(10_025));
        // the spam goes on after the end: writes after E are never read; the window start stays in the ring for
        // 270 s (and up to 285 s on the 15-s grid), then the read refunds
        for (extra, ok) in [(270u64, true), (285, true), (300, false)] {
            let mut more = all.clone();
            more.extend((1..=extra / 15).map(|j| E + 15 * j));
            let d = ring2(&writes(&more, price), 7);
            let t = twap_v2(&d, E, PRED_TWAP_WINDOW);
            if ok {
                assert_eq!(ready(t), Some(10_025), "+{extra}");
            } else {
                assert!(unavailable(t), "+{extra}");
            }
        }
    }

    #[test]
    fn v2_needs_the_window_start_in_the_ring() {
        let late = [(E - 1_100, 0), (E - 800, 30_000), (E - 500, 60_000), (E - 200, 90_000)];
        assert!(unavailable(twap_v2(&ring2(&late, 0), E, PRED_TWAP_WINDOW))); // no fallback to the oldest write
    }

    #[test]
    fn v2_reads_in_write_order() {
        let p = steady();
        for first in [0usize, 37, 97] {
            assert_eq!(ready(twap_v2(&ring2(&p, first), E, PRED_TWAP_WINDOW)), Some(100), "first {first}");
        }
        let mut d = ring2(&p, 0);
        let (a, b) = (OBS_HEADER + OBS_SIZE, OBS_HEADER + 2 * OBS_SIZE);
        let tmp = d[a..a + OBS_SIZE].to_vec();
        d.copy_within(b..b + OBS_SIZE, a);
        d[b..b + OBS_SIZE].copy_from_slice(&tmp);
        assert!(unavailable(twap_v2(&d, E, PRED_TWAP_WINDOW)));
    }

    #[test]
    fn v2_needs_a_write_at_or_before_the_end() {
        assert!(unavailable(twap_v2(&ring2(&[(E + 15, 0), (E + 30, 1_500)], 0), E, PRED_TWAP_WINDOW)));
        assert!(unavailable(twap_v2(&ring2(&[(E - 1_300, 0), (E + 10, 131_000)], 0), E, PRED_TWAP_WINDOW)));
        assert!(unavailable(twap_v2(&ring2(&[], 0), E, PRED_TWAP_WINDOW)));
        assert!(unavailable(twap_v2(&[0u8; 100], E, PRED_TWAP_WINDOW))); // too short
    }

    #[test]
    fn v1_stretch_guard() {
        let d = ring2(&[(E - 1_000, 0), (E + 901, 190_100)], 0);
        assert!(unavailable(round_price_data(&d, true, E as i64).unwrap()));
        let d = ring2(&[(E - 1_000, 0), (E + 900, 190_000)], 0);
        assert_eq!(ready(round_price_data(&d, true, E as i64).unwrap()), Some(100));
    }

    #[test]
    fn v1_notyet_maps_to_notready_then_refund() {
        let d = ring2(&[(E - 1_000, 0), (E - 10, 99_000)], 0);
        assert!(matches!(round_price_data(&d, true, E as i64).unwrap(), Twap::NotYet));
        let at = E as i64;
        assert_eq!(price_step(Twap::NotYet, true, at + PRED_V1_MAX_DELAY, at), PriceStep::NotReady);
        assert_eq!(price_step(Twap::NotYet, true, at + PRED_V1_MAX_DELAY + 1, at), PriceStep::Refund);
        assert_eq!(price_step(Twap::NotYet, false, at + 1, at), PriceStep::Refund);
        assert_eq!(price_step(Twap::Unavailable, true, at, at), PriceStep::Refund);
        assert_eq!(price_step(Twap::Ready(7), false, at + 1, at), PriceStep::Price(7));
    }

    #[test]
    fn foreign_or_reshaped_data_refunds() {
        let mut d = ring2(&steady(), 0);
        assert_eq!(ready(round_price_data(&d, false, E as i64).unwrap()), Some(100));
        d[20] ^= 1; // another pool
        assert!(unavailable(round_price_data(&d, false, E as i64).unwrap()));
        assert!(unavailable(round_price_data(&[0u8; 43], true, E as i64).unwrap()));
    }

    #[test]
    fn time_reached_is_strict_for_v2_only() {
        assert!(time_reached(100, 100, true));
        assert!(!time_reached(100, 100, false));
        assert!(time_reached(101, 100, false));
        assert!(!time_reached(99, 100, true));
    }

    #[test]
    fn side_cap_applies_to_v1_and_v2() {
        let x = XNT;
        assert_eq!(add_entry([0, 0], SIDE_UP, PRED_MAX_SIDE).unwrap(), [0, PRED_MAX_SIDE]);
        assert!(add_entry([0, PRED_MAX_SIDE], SIDE_UP, 1).is_err()); // side cap
        assert_eq!(add_entry([PRED_MAX_SIDE, 0], SIDE_UP, PRED_MAX_SIDE).unwrap(), [PRED_MAX_SIDE, PRED_MAX_SIDE]);
        assert!(add_entry([PRED_MAX_SIDE, PRED_MAX_SIDE], SIDE_DOWN, 1).is_err()); // pot cap
        assert_eq!(PRED_MAX_SIDE, 100 * x);
        assert!(add_entry([u64::MAX, 1], SIDE_UP, 1).is_err());
    }

    #[test]
    fn rounds_never_share_price_data() {
        let span = (PRED_TWAP_WINDOW + PRED_MAX_GAP) as i64;
        for k in 20_000i64..20_400 {
            let lock = k * PRED_PERIOD + PRED_LOCK_OFFSET;
            let end = lock + PRED_HORIZON;
            let next_lock = (k + 1) * PRED_PERIOD + PRED_LOCK_OFFSET;
            assert!(!is_v1_schedule(lock, end));
            assert!(end < next_lock - span); // round k's end data lies below round k+1's start data
            assert_eq!(entry_close(lock, end), lock - span);
            #[cfg(not(feature = "localnet"))]
            assert_eq!(entry_close(lock, end), lock - 1_500);
            assert!(entry_close(lock, end) > k * PRED_PERIOD);
            // a v1 round keeps its own schedule, and its end read (stretch included) lies below k+1's v2 start
            let v1_lock = k * PRED_PERIOD + PRED_V1_BET_WINDOW;
            let v1_end = v1_lock + PRED_V1_HORIZON;
            assert!(is_v1_schedule(v1_lock, v1_end));
            assert_eq!(entry_close(v1_lock, v1_end), v1_lock);
            assert!(v1_end + (PRED_V1_TWAP_WINDOW as i64) < next_lock - span);
        }
    }

    #[test]
    fn v2_no_contest_band() {
        let s = 1_000_000u128;
        assert_eq!(settle_outcome(s, Some(1_009_900), false), 2); // +0.99%: refund
        assert_eq!(settle_outcome(s, Some(1_010_000), false), SIDE_UP); // +1.00%: settles
        assert_eq!(settle_outcome(s, Some(990_100), false), 2); // −0.99%
        assert_eq!(settle_outcome(s, Some(990_000), false), SIDE_DOWN); // −1.00%
        assert_eq!(settle_outcome(s, None, false), 2); // no price
        assert!(no_contest(s, s, false));
    }

    #[test]
    fn band_does_not_apply_to_v1() {
        let s = 1_000_000u128;
        assert_eq!(settle_outcome(s, Some(s + 1), true), SIDE_UP);
        assert_eq!(settle_outcome(s, Some(s - 1), true), SIDE_DOWN);
        assert_eq!(settle_outcome(s, Some(s), true), 2); // a tie still refunds
        assert_eq!(settle_outcome(s, None, true), 2);
    }
}
