//! Oracle seat (SPEC-UPGRADE-v2 §2.14, oracle-theft-design.md §4): theft containment without a veto.
//!
//! - Every epoch (base and extra) waits CLAIM_HOLD (48 h) before any claim (forge.rs `verify_leaf`, extra.rs).
//! - During the hold ANYONE may void it for a bond (10% of its full budget, min 0.05 XNT) paid to the reward pool;
//!   the seat's cold key voids for free, and a cold void of the base epoch waives the 6-day interval once (S-2).
//! - A seat with no epoch that SURVIVED its hold for 28 days is dead: anyone takes it with a seat bond (10% of the
//!   free pool, min 1 XNT), naming new keys. The largest voider (or the successor named at resign) has 24 h priority.
//! - The cold key rotates the hot key at once and may resign a seat that PRODUCED a surviving epoch since
//!   max(now − 28 d, its take) (bond back; G2-R1). Nobody can veto anything.
//! No instruction in this file moves lamports OUT of reward_vault.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::constants::*;
use crate::errors::ForgeError;
use crate::events::*;
use crate::state::*;
use crate::utils::*;

/// Longest walk, in (Epoch, ExtraEpoch) pairs, of `seat_is_dead`. SEAT_WALK_MAX = 5 epochs fit the 28 (+1) days at the
/// 6-day interval; a cold void may add ONE waived republish per interval slot (S-2, bounded by `cold_waiver_allowed`),
/// so at most 2 × 5 epochs lie inside the window, plus the pair that closes the walk. (g2 deviation 1, DEVIATIONS.md.)
pub const SEAT_WALK_PAIRS: usize = 2 * SEAT_WALK_MAX + 1;

// ═══════════════════════════════════════════════════════════════════════════
// Pure cores (host-testable; the handlers below only add accounts and transfers)
// ═══════════════════════════════════════════════════════════════════════════

/// What the walk needs from one Epoch / ExtraEpoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EpochView {
    pub published_at: i64,
    pub closed: bool,
}

impl EpochView {
    /// Survived = not closed (voided or expired) and past its hold. "In hold" counts as NOT survived.
    fn survived(&self, now: i64) -> bool {
        !self.closed && now >= self.published_at.saturating_add(CLAIM_HOLD)
    }
}

/// The dead-seat walk (theft §4.5.3) over ids last_epoch, last_epoch-1, ...; `pair(i, id)` returns the base epoch and
/// the extra epoch (None = absent: neutral) of `id` read from remaining accounts i and i + 1.
/// Ok(true) = dead for `delay`: taken more than `delay` ago and no epoch published in the last `delay` seconds survived.
pub(crate) fn walk_is_dead<F>(last_epoch: u64, taken_at: i64, now: i64, delay: i64, mut pair: F) -> Result<bool>
where
    F: FnMut(usize, u64) -> Result<(EpochView, Option<EpochView>)>,
{
    let cutoff = now.saturating_sub(delay);
    if taken_at >= cutoff {
        return Ok(false);
    }
    let mut id = last_epoch;
    let mut i = 0usize;
    for _ in 0..SEAT_WALK_PAIRS {
        if id == 0 {
            return Ok(true); // nothing ever published (localnet only)
        }
        let (base, extra) = pair(i, id)?;
        if base.published_at < cutoff {
            return Ok(true); // every newer epoch failed to survive
        }
        let extra_ok = extra.map_or(true, |x| x.survived(now));
        if base.survived(now) && extra_ok {
            return Ok(false); // a surviving epoch: alive
        }
        if id == 1 {
            return Ok(true);
        }
        id -= 1;
        i += 2;
    }
    err!(ForgeError::BadEpochWindow)
}

pub(crate) fn epoch_pda(id: u64) -> Pubkey {
    Pubkey::find_program_address(&[SEED_EPOCH, &id.to_le_bytes()], &crate::ID).0
}

pub(crate) fn extra_epoch_pda(id: u64) -> Pubkey {
    Pubkey::find_program_address(&[SEED_EXTRA_EPOCH, &id.to_le_bytes()], &crate::ID).0
}

/// A base Epoch of id `id` from raw account parts: right PDA, owned by this program, Epoch discriminator.
pub(crate) fn epoch_view(id: u64, key: &Pubkey, owner: &Pubkey, data: &[u8]) -> Result<EpochView> {
    require_keys_eq!(*key, epoch_pda(id), ForgeError::BadEpochWindow);
    require_keys_eq!(*owner, crate::ID, ForgeError::BadEpochWindow);
    let e = Epoch::try_deserialize(&mut &data[..])?;
    require!(e.id == id, ForgeError::BadEpochWindow);
    Ok(EpochView { published_at: e.published_at, closed: e.closed })
}

/// One walk pair from raw account parts. The extra account must be the right PDA; if it is not a live program account
/// (never published, or closed by close_extra_epoch) it is neutral.
pub(crate) fn pair_view(
    id: u64,
    base: (&Pubkey, &Pubkey, &[u8]),
    extra: (&Pubkey, &Pubkey, &[u8]),
) -> Result<(EpochView, Option<EpochView>)> {
    let b = epoch_view(id, base.0, base.1, base.2)?;
    require_keys_eq!(*extra.0, extra_epoch_pda(id), ForgeError::BadEpochWindow);
    let x = if *extra.1 != crate::ID || extra.2.len() < 8 {
        None
    } else {
        let x = ExtraEpoch::try_deserialize(&mut &extra.2[..])?;
        Some(EpochView { published_at: x.published_at, closed: x.closed })
    };
    Ok((b, x))
}

/// remaining_accounts: for ids last_epoch, last_epoch - 1, ... the pair (Epoch id, ExtraEpoch id or its empty PDA),
/// newest first, until the first Epoch published before now - delay (that pair closes the walk).
pub(crate) fn seat_is_dead(config: &Config, seat: &OracleSeat, now: i64, delay: i64, rem: &[AccountInfo]) -> Result<bool> {
    walk_is_dead(config.last_epoch, seat.taken_at, now, delay, |i, id| {
        let ea = rem.get(i).ok_or(error!(ForgeError::BadEpochWindow))?;
        let xa = rem.get(i + 1).ok_or(error!(ForgeError::BadEpochWindow))?;
        let ed = ea.try_borrow_data()?;
        let xd = xa.try_borrow_data()?;
        pair_view(id, (ea.key, ea.owner, &ed[..]), (xa.key, xa.owner, &xd[..]))
    })
}

/// resign_seat gate (G2-R1, security fix to SPEC 2.14 / theft §4.5.5; DEVIATIONS g2-fixes 1): a graceful exit needs an
/// epoch published since max(now − DEAD_SEAT_DELAY, taken_at) that SURVIVED its hold (theft §3 rule 5 "a living seat =
/// one that produced a surviving epoch"). Unlike take_seat there is NO "recently taken" grace: otherwise a holder loops
/// resign → take as its own successor (taken_at resets every cycle), the seat never dies and its bond is recycled.
/// The window is at most 28 d, so the walk needs at most SEAT_WALK_PAIRS pairs.
pub(crate) fn resign_allowed<F>(last_epoch: u64, taken_at: i64, now: i64, pair: F) -> Result<bool>
where
    F: FnMut(usize, u64) -> Result<(EpochView, Option<EpochView>)>,
{
    let since = now.saturating_sub(DEAD_SEAT_DELAY).max(taken_at);
    Ok(!walk_is_dead(last_epoch, i64::MIN, now, now.saturating_sub(since), pair)?)
}

/// remaining_accounts: the (Epoch, ExtraEpoch) pairs, newest first, up to the first surviving pair or down to the first
/// Epoch published before max(now − DEAD_SEAT_DELAY, seat.taken_at) (that pair closes the walk).
pub(crate) fn seat_can_resign(config: &Config, seat: &OracleSeat, now: i64, rem: &[AccountInfo]) -> Result<bool> {
    resign_allowed(config.last_epoch, seat.taken_at, now, |i, id| {
        let ea = rem.get(i).ok_or(error!(ForgeError::BadEpochWindow))?;
        let xa = rem.get(i + 1).ok_or(error!(ForgeError::BadEpochWindow))?;
        let ed = ea.try_borrow_data()?;
        let xd = xa.try_borrow_data()?;
        pair_view(id, (ea.key, ea.owner, &ed[..]), (xa.key, xa.owner, &xd[..]))
    })
}

pub(crate) fn require_cold(seat: &OracleSeat, signer: &Pubkey) -> Result<()> {
    require!(seat.cold != Pubkey::default() && *signer == seat.cold, ForgeError::OnlyCold);
    Ok(())
}

pub(crate) fn is_cold(seat: &OracleSeat, signer: &Pubkey) -> bool {
    seat.cold != Pubkey::default() && *signer == seat.cold
}

/// rotate_hot: the cold key swaps the hot key at once and wipes any pending hand-over (the thief's `pending_oracle`).
pub(crate) fn rotate_hot_core(c: &mut Config, seat: &OracleSeat, signer: &Pubkey, new_hot: Pubkey) -> Result<Pubkey> {
    require_cold(seat, signer)?;
    require!(
        new_hot != Pubkey::default() && new_hot != seat.cold && new_hot != c.architect,
        ForgeError::InvalidTarget
    );
    let old = c.oracle;
    c.oracle = new_hot;
    c.pending_oracle = Pubkey::default();
    Ok(old)
}

/// Bond a voider must post: 0 for the cold key; else max(VOID_BOND_MIN, 10% of the full budget), and SEAT_BOND_MIN
/// for an epoch with nothing to protect (full budget 0: a heartbeat base epoch, or an extra heartbeat over a heartbeat
/// base). r4-fix, review r4 finding 3: at the 0.05-XNT minimum a squatter voided every weekly heartbeat of a quiet month
/// for about 0.25 XNT, the seat died, and the void had also given it the takeover priority (book_void).
pub(crate) fn void_required(by_cold: bool, full_budget: u64) -> u64 {
    if by_cold {
        0
    } else if full_budget == 0 {
        SEAT_BOND_MIN
    } else {
        void_bond(full_budget)
    }
}

/// S-1: an extra epoch's void bond is priced on max(extra budget, base budget + drop reserve).
pub(crate) fn extra_void_full_budget(extra_budget: u64, base_budget: u64, base_drop_reserve: u64) -> u64 {
    extra_budget.max(base_budget.saturating_add(base_drop_reserve))
}

/// Seat bookkeeping of a void (base or extra): lifetime counters and the priority slot (non-cold voiders only, only
/// while the seat is not open: an open seat keeps the successor named at resign, G2-R2 / DEVIATIONS g2-fixes 2; and only
/// for an epoch that had something to protect, full budget > 0: voiding a heartbeat earns no takeover priority, r4-fix,
/// review r4 finding 3).
pub(crate) fn book_void(seat: &mut OracleSeat, voider: &Pubkey, by_cold: bool, bond: u64, full_budget: u64) -> Result<()> {
    seat.to_pool = seat.to_pool.checked_add(bond).ok_or(ForgeError::MathOverflow)?;
    seat.voids = seat.voids.saturating_add(1);
    if !by_cold && seat.open_since == 0 && full_budget > 0 && bond > seat.priority_bond {
        seat.priority = *voider;
        seat.priority_bond = bond;
    }
    Ok(())
}

/// Hold-window gate shared by both voids.
pub(crate) fn void_gate(closed: bool, published_at: i64, now: i64) -> Result<()> {
    require!(!closed, ForgeError::EpochClosed);
    require!(now < published_at.saturating_add(CLAIM_HOLD), ForgeError::HoldOver);
    Ok(())
}

/// Closes a base epoch inside its hold and returns what goes back to the free pool: exactly the expire_epoch
/// arithmetic (forge.rs `expire_epoch`): budget − claimed, plus the unpaid drop reserve of a legacy PENDING/SEALED
/// epoch (PENDING becomes CANCELLED). Defensive: nothing can be claimed inside the hold.
pub(crate) fn void_base_core(e: &mut Epoch, now: i64) -> Result<u64> {
    void_gate(e.closed, e.published_at, now)?;
    require!(e.claimed == 0 && e.drop_paid == 0, ForgeError::MathOverflow);
    let mut remaining = e.budget.saturating_sub(e.claimed);
    if e.drop_state == DROP_PENDING || e.drop_state == DROP_SEALED {
        remaining = remaining.saturating_add(e.drop_reserve.saturating_sub(e.drop_paid));
        if e.drop_state == DROP_PENDING {
            e.drop_state = DROP_CANCELLED;
        }
    }
    e.closed = true;
    Ok(remaining)
}

/// S-2 waiver bound (g2 deviation 1): a cold void resets `last_publish_ts` only for an epoch that was itself published
/// at least MIN_EPOCH_INTERVAL after its predecessor, i.e. not for an epoch that already used a waiver. One waived
/// republish per interval slot keeps the seat walk bounded (SEAT_WALK_PAIRS) even under a stolen cold key.
pub(crate) fn waiver_from_predecessor(voided_published_at: i64, predecessor_published_at: i64) -> bool {
    voided_published_at >= predecessor_published_at.saturating_add(MIN_EPOCH_INTERVAL)
}

/// S-2 waiver of a cold void of epoch `id` (G2-R3 / DEVIATIONS g2-fixes 3). `pred` = remaining_accounts[0] as raw
/// parts, if one was passed. Epoch 1 has no predecessor: waiver. No account passed: the void still proceeds, WITHOUT the
/// waiver (fail open: the void is the time-critical theft response and must work from a generic IDL client). An
/// account passed that is not Epoch(id − 1) (PDA, owner, discriminator, id): BadEpochWindow.
pub(crate) fn cold_waiver_from(id: u64, published_at: i64, pred: Option<(&Pubkey, &Pubkey, &[u8])>) -> Result<bool> {
    if id <= 1 {
        return Ok(true);
    }
    match pred {
        None => Ok(false),
        Some((key, owner, data)) => {
            let prev = epoch_view(id - 1, key, owner, data)?;
            Ok(waiver_from_predecessor(published_at, prev.published_at))
        }
    }
}

fn cold_waiver_allowed(e: &Epoch, rem: &[AccountInfo]) -> Result<bool> {
    match rem.first() {
        None => cold_waiver_from(e.id, e.published_at, None),
        Some(pa) => {
            let d = pa.try_borrow_data()?;
            cold_waiver_from(e.id, e.published_at, Some((pa.key, pa.owner, &d[..])))
        }
    }
}

/// take_seat key rules: a hot key, distinct from the new cold key and from the architect payee.
pub(crate) fn take_keys_check(c: &Config, new_hot: &Pubkey, new_cold: &Pubkey) -> Result<()> {
    require!(
        *new_hot != Pubkey::default() && new_hot != new_cold && *new_hot != c.architect,
        ForgeError::InvalidTarget
    );
    Ok(())
}

/// take_seat refund rule (G2-R4): the refund address may not be the seat PDA itself. resign_seat would then move the
/// bond from the seat to the seat, which the runtime rejects as unbalanced, and the bond could never be returned.
pub(crate) fn take_refund_check(new_refund: &Pubkey, seat: &Pubkey) -> Result<()> {
    require_keys_neq!(*new_refund, *seat, ForgeError::InvalidTarget);
    Ok(())
}

/// Delay a closed seat must be dead for: the priority taker waits 28 d, everyone else 28 d + 24 h.
pub(crate) fn take_delay(seat: &OracleSeat, taker: &Pubkey) -> i64 {
    if seat.priority != Pubkey::default() && *taker == seat.priority {
        DEAD_SEAT_DELAY
    } else {
        DEAD_SEAT_DELAY + SEAT_PRIORITY_WINDOW
    }
}

/// Open-seat gate: during the 24 h after a resign only the named successor may take it.
pub(crate) fn open_seat_gate(seat: &OracleSeat, taker: &Pubkey, now: i64) -> Result<()> {
    if now < seat.open_since.saturating_add(SEAT_PRIORITY_WINDOW) {
        require!(*taker == seat.priority, ForgeError::SeatPriority);
    }
    Ok(())
}

/// resign_seat bookkeeping after the bond left: the seat is open, the named successor has the first 24 h.
pub(crate) fn open_seat(seat: &mut OracleSeat, successor: Pubkey, now: i64) {
    seat.bond = 0;
    seat.open_since = now;
    seat.priority = successor;
    seat.priority_bond = 0;
}

/// Installs a new seat generation and hot key; returns the old hot key. The stolen key is dead from this slot.
pub(crate) fn install_seat(
    c: &mut Config,
    seat: &mut OracleSeat,
    new_hot: Pubkey,
    new_cold: Pubkey,
    new_refund: Pubkey,
    bond: u64,
    now: i64,
) -> Pubkey {
    seat.generation = seat.generation.saturating_add(1);
    seat.cold = new_cold;
    seat.refund = new_refund;
    seat.bond = bond;
    seat.taken_at = now;
    seat.open_since = 0;
    seat.priority = Pubkey::default();
    seat.priority_bond = 0;
    let old = c.oracle;
    c.oracle = new_hot;
    c.pending_oracle = Pubkey::default();
    old
}

fn pay_in<'info>(sys: &AccountInfo<'info>, from: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    transfer(CpiContext::new(sys.clone(), Transfer { from: from.clone(), to: to.clone() }), amount)
}

// ═══════════════════════════════════════════════════════════════════════════
// init_seat — permissionless, once, deterministic (keys from constants)
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct InitSeat<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = payer, space = 8 + OracleSeat::INIT_SPACE, seeds = [SEED_ORACLE_SEAT], bump)]
    pub seat: Box<Account<'info, OracleSeat>>,
    /// CHECK: reward vault PDA (read: free balance)
    #[account(seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn init_seat(ctx: Context<InitSeat>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let bond = seat_bond(free_balance(&ctx.accounts.reward_vault, ctx.accounts.config.reward_reserved)?);
    pay_in(
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.seat.to_account_info(),
        bond,
    )?;
    let s = &mut ctx.accounts.seat;
    s.generation = 1;
    s.cold = SEAT_COLD_INITIAL;
    s.refund = SEAT_REFUND_INITIAL;
    s.bond = bond;
    s.taken_at = now;
    s.open_since = 0;
    s.priority = Pubkey::default();
    s.priority_bond = 0;
    s.voids = 0;
    s.to_pool = 0;
    s.bump = ctx.bumps.seat;
    emit!(SeatChanged {
        generation: 1,
        hot: ctx.accounts.config.oracle,
        cold: s.cold,
        refund: s.refund,
        bond,
        taker: ctx.accounts.payer.key(),
        reason: 0,
        forfeited: 0,
    });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// rotate_hot — cold only, instant (the theft response)
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct ColdOnly<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [SEED_ORACLE_SEAT], bump = seat.bump)]
    pub seat: Box<Account<'info, OracleSeat>>,
    pub cold: Signer<'info>,
}

pub fn rotate_hot(ctx: Context<ColdOnly>, new_hot: Pubkey) -> Result<()> {
    let old = rotate_hot_core(&mut ctx.accounts.config, &ctx.accounts.seat, &ctx.accounts.cold.key(), new_hot)?;
    emit!(OracleChanged { old_oracle: old, new_oracle: new_hot, by: 1 });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// resign_seat — cold only, a seat that produced a surviving epoch (G2-R1): bond back, seat open, successor first 24 h
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct ResignSeat<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_ORACLE_SEAT], bump = seat.bump)]
    pub seat: Box<Account<'info, OracleSeat>>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: seat.refund, or the reward vault when seat.refund is Pubkey::default() (checked in the handler)
    #[account(mut)]
    pub refund: UncheckedAccount<'info>,
    pub cold: Signer<'info>,
    // remaining_accounts: the walk pairs (see seat_can_resign)
}

pub fn resign_seat(ctx: Context<ResignSeat>, successor: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let seat = &ctx.accounts.seat;
    require_cold(seat, &ctx.accounts.cold.key())?;
    require!(seat.open_since == 0, ForgeError::SeatOpen);
    require!(seat_can_resign(&ctx.accounts.config, seat, now, ctx.remaining_accounts)?, ForgeError::SeatDead);
    let expected = if seat.refund == Pubkey::default() { ctx.accounts.reward_vault.key() } else { seat.refund };
    require_keys_eq!(ctx.accounts.refund.key(), expected, ForgeError::InvalidTarget);

    let bond = seat.bond;
    move_lamports(&ctx.accounts.seat.to_account_info(), &ctx.accounts.refund.to_account_info(), bond)?;
    if ctx.accounts.refund.key() == ctx.accounts.reward_vault.key() {
        let s = &mut ctx.accounts.config.stats;
        s.donated_reward = s.donated_reward.saturating_add(bond);
    }
    let s = &mut ctx.accounts.seat;
    open_seat(s, successor, now);
    emit!(SeatResigned { generation: s.generation, successor, refund: expected, bond_returned: bond });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// take_seat — anyone: an OPEN seat (successor first for 24 h) or a DEAD one (bond forfeited to the pool)
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct TakeSeat<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_ORACLE_SEAT], bump = seat.bump)]
    pub seat: Box<Account<'info, OracleSeat>>,
    /// CHECK: reward vault PDA (forfeits in, free balance read)
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub taker: Signer<'info>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: the walk pairs (ignored when the seat is open)
}

pub fn take_seat(ctx: Context<TakeSeat>, new_hot: Pubkey, new_cold: Pubkey, new_refund: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let taker = ctx.accounts.taker.key();
    take_keys_check(&ctx.accounts.config, &new_hot, &new_cold)?;
    take_refund_check(&new_refund, &ctx.accounts.seat.key())?;

    let (forfeited, reason) = if ctx.accounts.seat.open_since != 0 {
        open_seat_gate(&ctx.accounts.seat, &taker, now)?;
        (0u64, 2u8)
    } else {
        let delay = take_delay(&ctx.accounts.seat, &taker);
        require!(
            seat_is_dead(&ctx.accounts.config, &ctx.accounts.seat, now, delay, ctx.remaining_accounts)?,
            ForgeError::SeatAlive
        );
        (ctx.accounts.seat.bond, 1u8)
    };

    // The new bond is priced on the free pool INCLUDING the forfeit (same value free_balance gives after the move),
    // and the taker's bond CPI comes BEFORE the direct move of the forfeit: a move from the seat (carried by the CPI)
    // to reward_vault (not carried) would leave the caller unbalanced at the CPI boundary and the runtime would refuse
    // the instruction (UnbalancedInstruction; found by the v3 integration suite, B-9 dead seat).
    let bond = {
        let v = &ctx.accounts.reward_vault;
        seat_bond(
            v.lamports()
                .saturating_add(forfeited)
                .saturating_sub(rent_min(v)?)
                .saturating_sub(ctx.accounts.config.reward_reserved),
        )
    };
    pay_in(
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.taker.to_account_info(),
        &ctx.accounts.seat.to_account_info(),
        bond,
    )?;
    if forfeited > 0 {
        move_lamports(&ctx.accounts.seat.to_account_info(), &ctx.accounts.reward_vault.to_account_info(), forfeited)?;
        let s = &mut ctx.accounts.config.stats;
        s.penalties_to_pool = s.penalties_to_pool.saturating_add(forfeited);
        let seat = &mut ctx.accounts.seat;
        seat.to_pool = seat.to_pool.checked_add(forfeited).ok_or(ForgeError::MathOverflow)?;
        seat.bond = 0;
    }
    let old = install_seat(&mut ctx.accounts.config, &mut ctx.accounts.seat, new_hot, new_cold, new_refund, bond, now);
    emit!(OracleChanged { old_oracle: old, new_oracle: new_hot, by: 2 });
    emit!(SeatChanged {
        generation: ctx.accounts.seat.generation,
        hot: new_hot,
        cold: new_cold,
        refund: new_refund,
        bond,
        taker,
        reason,
        forfeited,
    });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// void_epoch — anyone during the 48-h hold, for a bond paid to the pool; free for the cold key
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
#[instruction(epoch_id: u64)]
pub struct VoidEpoch<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EPOCH, epoch_id.to_le_bytes().as_ref()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [SEED_ORACLE_SEAT], bump = seat.bump)]
    pub seat: Box<Account<'info, OracleSeat>>,
    /// CHECK: reward vault PDA (bond in)
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub voider: Signer<'info>,
    pub system_program: Program<'info, System>,
    // remaining_accounts[0] (optional; cold voids of epoch id > 1 only): the Epoch of id − 1, for the S-2 waiver.
    // Omitted: the void still succeeds, without the waiver (G2-R3). A wrong account: BadEpochWindow.
}

pub fn void_epoch(ctx: Context<VoidEpoch>, epoch_id: u64, bond: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let voider = ctx.accounts.voider.key();
    let by_cold = is_cold(&ctx.accounts.seat, &voider);
    let full = {
        let e = &ctx.accounts.epoch;
        void_gate(e.closed, e.published_at, now)?;
        let full = e.budget.saturating_add(e.drop_reserve);
        require!(bond >= void_required(by_cold, full), ForgeError::BondTooSmall);
        full
    };
    let waive = by_cold && cold_waiver_allowed(&ctx.accounts.epoch, ctx.remaining_accounts)?;

    pay_in(
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.voider.to_account_info(),
        &ctx.accounts.reward_vault.to_account_info(),
        bond,
    )?;
    let returned = void_base_core(&mut ctx.accounts.epoch, now)?;
    let c = &mut ctx.accounts.config;
    c.reward_reserved = c.reward_reserved.saturating_sub(returned);
    c.stats.penalties_to_pool = c.stats.penalties_to_pool.saturating_add(bond);
    if waive {
        // S-2: one-shot waiver of MIN_EPOCH_INTERVAL so the rotated hot key republishes the honest file at once
        c.last_publish_ts = 0;
    }
    book_void(&mut ctx.accounts.seat, &voider, by_cold, bond, full)?;
    emit!(EpochVoided { epoch: epoch_id, voider, bond, returned_to_pool: returned, by_cold });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// void_extra_epoch — same rule for the extra pot; the bond goes to reward_vault (the pots never exchange money)
// ═══════════════════════════════════════════════════════════════════════════
//
// Disclosed delay (G2-R6b, spec-literal, DEVIATIONS g2-fixes 6): unlike the S-2 waiver of a cold base void, a cold
// extra void does NOT reset extra_state.last_publish_ts. After a hot-key theft with a fake REAL extra, the honest real
// extra waits MIN_EPOCH_INTERVAL after the fake (heartbeats may follow at once); the missed usage carries over (X-3).

#[derive(Accounts)]
#[instruction(epoch_id: u64)]
pub struct VoidExtraEpoch<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EXTRA_STATE], bump = extra_state.bump)]
    pub extra_state: Box<Account<'info, ExtraState>>,
    #[account(mut, seeds = [SEED_EXTRA_EPOCH, epoch_id.to_le_bytes().as_ref()], bump = extra_epoch.bump)]
    pub extra_epoch: Box<Account<'info, ExtraEpoch>>,
    /// the base epoch of the same id (S-1: the void bond is priced on it too)
    #[account(seeds = [SEED_EPOCH, epoch_id.to_le_bytes().as_ref()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(mut, seeds = [SEED_ORACLE_SEAT], bump = seat.bump)]
    pub seat: Box<Account<'info, OracleSeat>>,
    /// CHECK: reward vault PDA (bond in)
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub voider: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn void_extra_epoch(ctx: Context<VoidExtraEpoch>, epoch_id: u64, bond: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let voider = ctx.accounts.voider.key();
    let by_cold = is_cold(&ctx.accounts.seat, &voider);
    let full = {
        let x = &ctx.accounts.extra_epoch;
        void_gate(x.closed, x.published_at, now)?;
        let e = &ctx.accounts.epoch;
        let full = extra_void_full_budget(x.budget, e.budget, e.drop_reserve);
        require!(bond >= void_required(by_cold, full), ForgeError::BondTooSmall);
        full
    };
    pay_in(
        &ctx.accounts.system_program.to_account_info(),
        &ctx.accounts.voider.to_account_info(),
        &ctx.accounts.reward_vault.to_account_info(),
        bond,
    )?;
    let returned = crate::instructions::extra::extra_void_core(&mut ctx.accounts.extra_state, &mut ctx.accounts.extra_epoch, now)?;
    let s = &mut ctx.accounts.config.stats;
    s.penalties_to_pool = s.penalties_to_pool.saturating_add(bond);
    book_void(&mut ctx.accounts.seat, &voider, by_cold, bond, full)?;
    emit!(ExtraEpochVoided { epoch: epoch_id, voider, bond, returned_to_pot: returned, by_cold });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Unit tests (SPEC-UPGRADE-v2 §8.1 "seat", theft §7, recovery cases of theft §5.2 / X-018)
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
pub(crate) mod seat_tests {
    use super::*;
    use anchor_lang::{AccountSerialize, Discriminator};

    const D: i64 = CLAIM_HOLD / 2; // one day (DAY is private to constants.rs)

    pub(crate) fn blank_config() -> Config {
        Config {
            version: 2, bump: 0, oracle: Pubkey::new_unique(), pending_oracle: Pubkey::default(), architect: Pubkey::new_unique(),
            bumps: [0; 5], last_epoch: 0, last_publish_ts: 0, reward_reserved: 0, bankroll_reserved: 0, house_total_shares: 0,
            house_protocol_shares: 0, jackpot_round: 0, draw_round: 0, artifacts_alive: [0; 4], artifacts_minted: [0; 4],
            airdrop_root: [0; 32], airdrop_root_set: false, airdrop_claimed: 0, artifact_price: [0; 4], artifact_price_ts: [0; 4],
            bankroll_day: 0, bankroll_day_start: 0, stats: Stats::default(),
        }
    }

    pub(crate) fn blank_seat(cold: Pubkey, taken_at: i64) -> OracleSeat {
        OracleSeat {
            generation: 1, cold, refund: Pubkey::default(), bond: XNT, taken_at, open_since: 0, priority: Pubkey::default(),
            priority_bond: 0, voids: 0, to_pool: 0, bump: 255,
        }
    }

    pub(crate) fn epoch(id: u64, published_at: i64, budget: u64) -> Epoch {
        Epoch {
            id, root: [0; 32], data_hash: [0; 32], total_score: 1, leaves: 1, rate_cap: 1, budget, claimed: 0, claims: 0,
            published_at, expires_at: published_at + CLAIM_WINDOW, closed: false, drop_reserve: 0, drop_paid: 0, drops: 0,
            drop_slot: 0, drop_seed: [0; 32], drop_state: DROP_NONE, bump: 255,
        }
    }

    pub(crate) fn extra(id: u64, published_at: i64, budget: u64) -> ExtraEpoch {
        ExtraEpoch {
            id, root: [0; 32], data_hash: [0; 32], budget, claimed: 0, leaves: 1, published_at, free_before: 0, closed: false,
            bump: 255, rent_payer: Pubkey::default(), bitmap: [0; 125],
        }
    }

    fn bytes<T: AccountSerialize>(v: &T) -> Vec<u8> {
        let mut out = Vec::new();
        v.try_serialize(&mut out).unwrap();
        out
    }

    /// Synthetic remaining accounts as raw (key, owner, data) parts, newest first.
    struct Raw {
        accs: Vec<(Pubkey, Pubkey, Vec<u8>)>,
    }

    impl Raw {
        /// pairs: (id, base, extra: None = never published (empty system PDA)).
        fn new(pairs: &[(u64, &Epoch, Option<&ExtraEpoch>)]) -> Self {
            let mut accs = Vec::new();
            for (id, e, x) in pairs {
                accs.push((epoch_pda(*id), crate::ID, bytes(*e)));
                match x {
                    Some(x) => accs.push((extra_epoch_pda(*id), crate::ID, bytes(*x))),
                    None => accs.push((extra_epoch_pda(*id), anchor_lang::system_program::ID, vec![])),
                }
            }
            Raw { accs }
        }
        fn dead(&self, last_epoch: u64, taken_at: i64, now: i64, delay: i64) -> Result<bool> {
            walk_is_dead(last_epoch, taken_at, now, delay, |i, id| {
                let b = self.accs.get(i).ok_or(error!(ForgeError::BadEpochWindow))?;
                let x = self.accs.get(i + 1).ok_or(error!(ForgeError::BadEpochWindow))?;
                pair_view(id, (&b.0, &b.1, &b.2), (&x.0, &x.1, &x.2))
            })
        }
    }

    fn is_err(r: Result<bool>, want: ForgeError) -> bool {
        match r {
            Err(Error::AnchorError(e)) => e.error_code_number == want as u32 + anchor_lang::error::ERROR_CODE_OFFSET,
            _ => false,
        }
    }

    #[test]
    fn seat_constants_and_pdas() {
        assert_eq!(SEAT_WALK_MAX, 5);
        assert_eq!(SEAT_WALK_PAIRS, 11);
        let (seat, bump) = Pubkey::find_program_address(&[SEED_ORACLE_SEAT], &crate::ID);
        assert_eq!(seat.to_string(), "EQ5BTUsYou2ndMw8SXdJVwNSz4nLABSuX6WxwT2doVGq");
        assert_eq!(bump, 255);
        assert_eq!(OracleSeat::DISCRIMINATOR, &[0x23, 0xdf, 0x92, 0x0b, 0x26, 0x09, 0x4f, 0xb8]);
    }

    /// theft §7 / SPEC 8.1: alive, dead by silence, dead by voids, tiny base + voided extra, in-hold newest,
    /// missing pair, wrong PDA, closed-and-absent extra, id 1 boundary.
    #[test]
    fn seat_is_dead_table() {
        let now = 400 * D;
        let delay = DEAD_SEAT_DELAY;
        let taken = 0;
        // weekly epochs 1..=5 at days 372, 378, 384, 390, 396 (all inside the 28 d window except 1 at 372 = cutoff)
        let ts = [370 * D, 378 * D, 384 * D, 390 * D, 396 * D];
        let mut es: Vec<Epoch> = (0..5).map(|k| epoch(k as u64 + 1, ts[k], 10 * XNT)).collect();
        let xs: Vec<ExtraEpoch> = (0..5).map(|k| extra(k as u64 + 1, ts[k], 0)).collect();

        // alive: epoch 4 (day 390) survived (newest 5 is in hold: day 396 + 2 > 400? 398 <= 400 → survived)
        let raw = Raw::new(&[(5, &es[4], Some(&xs[4])), (4, &es[3], Some(&xs[3]))]);
        assert_eq!(raw.dead(5, taken, now, delay).unwrap(), false);

        // in-hold newest: now = 397 → epoch 5 in hold (not survived), epoch 4 survived → alive
        let raw = Raw::new(&[(5, &es[4], Some(&xs[4])), (4, &es[3], Some(&xs[3]))]);
        assert_eq!(raw.dead(5, taken, 397 * D, delay).unwrap(), false);

        // dead by voids: 2..=5 voided, epoch 1 older than the cutoff closes the walk
        for k in 1..5 {
            es[k].closed = true;
        }
        let pairs: Vec<(u64, &Epoch, Option<&ExtraEpoch>)> = (0..5).rev().map(|k| (k as u64 + 1, &es[k], Some(&xs[k]))).collect();
        assert!(Raw::new(&pairs).dead(5, taken, now, delay).unwrap());
        // the same with one pair missing → BadEpochWindow
        assert!(is_err(Raw::new(&pairs[..4]).dead(5, taken, now, delay), ForgeError::BadEpochWindow));
        // id 1 boundary: walk reaches id 1 inside the window → dead
        let mut e1 = epoch(1, 380 * D, XNT);
        e1.closed = true;
        assert!(Raw::new(&[(1, &e1, None)]).dead(1, taken, now, delay).unwrap());
        // nothing ever published
        assert!(Raw::new(&[]).dead(0, taken, now, delay).unwrap());

        // dead by silence: newest epoch older than the cutoff
        let old = epoch(9, 300 * D, XNT);
        assert!(Raw::new(&[(9, &old, None)]).dead(9, taken, now, delay).unwrap());
        // ... but not before taken_at + delay
        assert_eq!(Raw::new(&[(9, &old, None)]).dead(9, now - delay, now, delay).unwrap(), false);

        // tiny base + voided extra: base survives, extra voided → pair fails
        let tiny = epoch(3, 390 * D, 1);
        let mut vx = extra(3, 390 * D, 5 * XNT);
        vx.closed = true;
        let older = epoch(2, 360 * D, XNT);
        assert!(Raw::new(&[(3, &tiny, Some(&vx)), (2, &older, None)]).dead(3, taken, now, delay).unwrap());
        // closed-and-absent extra (close_extra_epoch ran): neutral, the base alone decides
        assert_eq!(Raw::new(&[(3, &tiny, None)]).dead(3, taken, now, delay).unwrap(), false);

        // wrong PDA: base of id 2 passed for id 3
        let raw = Raw { accs: vec![(epoch_pda(2), crate::ID, bytes(&tiny)), (extra_epoch_pda(3), crate::ID, bytes(&vx))] };
        assert!(is_err(raw.dead(3, taken, now, delay), ForgeError::BadEpochWindow));
        // wrong extra PDA
        let raw = Raw { accs: vec![(epoch_pda(3), crate::ID, bytes(&tiny)), (extra_epoch_pda(2), crate::ID, bytes(&vx))] };
        assert!(is_err(raw.dead(3, taken, now, delay), ForgeError::BadEpochWindow));
        // base not owned by the program
        let raw = Raw { accs: vec![(epoch_pda(3), Pubkey::new_unique(), bytes(&tiny)), (extra_epoch_pda(3), crate::ID, vec![])] };
        assert!(is_err(raw.dead(3, taken, now, delay), ForgeError::BadEpochWindow));
        // an ExtraEpoch's bytes at the base slot: wrong discriminator
        let raw = Raw { accs: vec![(epoch_pda(3), crate::ID, bytes(&vx)), (extra_epoch_pda(3), crate::ID, vec![])] };
        assert!(raw.dead(3, taken, now, delay).is_err());
    }

    /// The walk stays bounded: 10 in-window epochs (one waived republish per interval slot) + the closing pair fit;
    /// one more fails with BadEpochWindow instead of looping.
    #[test]
    fn walk_bound_covers_waived_republishes() {
        let now = 1_000 * D;
        let mut es = Vec::new();
        let mut id = 1u64;
        es.push(epoch(id, now - 40 * D, XNT)); // closes the walk
        for slot in 0..5 {
            let t = now - 28 * D + 1 + slot * MIN_EPOCH_INTERVAL;
            for k in 0..2 {
                id += 1;
                let mut e = epoch(id, t + k, XNT);
                e.closed = true;
                es.push(e);
            }
        }
        let pairs: Vec<(u64, &Epoch, Option<&ExtraEpoch>)> = es.iter().rev().map(|e| (e.id, e, None)).collect();
        assert_eq!(pairs.len(), 11);
        assert!(Raw::new(&pairs).dead(id, 0, now, DEAD_SEAT_DELAY).unwrap());
        // 12 pairs needed → bounded error
        let mut extra_e = epoch(id + 1, now - D, XNT);
        extra_e.closed = true;
        let mut p2 = vec![(id + 1, &extra_e, None)];
        p2.extend(pairs.iter().cloned());
        assert!(is_err(Raw::new(&p2).dead(id + 1, 0, now, DEAD_SEAT_DELAY), ForgeError::BadEpochWindow));
    }

    #[test]
    fn void_bonds_and_priority() {
        // SPEC 8.1 void_extra_bond table (S-1)
        assert_eq!(void_required(false, extra_void_full_budget(0, 10 * XNT, 0)), XNT);
        assert_eq!(void_required(false, extra_void_full_budget(3 * XNT, XNT, 0)), 300_000_000);
        // r4-fix (review r4 finding 3): an epoch with nothing to protect (an extra heartbeat over a heartbeat base, a
        // heartbeat base) costs a non-cold voider SEAT_BOND_MIN; one lamport of budget is priced as before
        assert_eq!(void_required(false, extra_void_full_budget(0, 0, 0)), SEAT_BOND_MIN);
        assert_eq!(void_required(false, 0), SEAT_BOND_MIN);
        assert_eq!(void_required(true, 0), 0, "the cold key still voids a heartbeat for free");
        assert_eq!(void_required(false, extra_void_full_budget(0, 1, 0)), VOID_BOND_MIN);
        assert_eq!(void_required(true, extra_void_full_budget(0, 10 * XNT, 0)), 0);
        // base: 10% of budget + drop reserve (legacy epochs)
        assert_eq!(void_required(false, 400_000_000), VOID_BOND_MIN);
        assert_eq!(void_required(false, 100 * XNT), 10 * XNT);

        let cold = Pubkey::new_unique();
        let mut seat = blank_seat(cold, 0);
        let (a, b) = (Pubkey::new_unique(), Pubkey::new_unique());
        book_void(&mut seat, &a, false, 2 * XNT, 20 * XNT).unwrap();
        book_void(&mut seat, &b, false, XNT, 10 * XNT).unwrap(); // smaller: no priority change
        book_void(&mut seat, &cold, true, 5 * XNT, 50 * XNT).unwrap(); // cold never takes priority
        // r4-fix (review r4 finding 3): a heartbeat's void (full budget 0) never takes priority, whatever its bond
        book_void(&mut seat, &Pubkey::new_unique(), false, 9 * XNT, 0).unwrap();
        assert_eq!((seat.priority, seat.priority_bond, seat.voids, seat.to_pool), (a, 2 * XNT, 4, 17 * XNT));
        assert_eq!(take_delay(&seat, &a), DEAD_SEAT_DELAY);
        assert_eq!(take_delay(&seat, &b), DEAD_SEAT_DELAY + SEAT_PRIORITY_WINDOW);
    }

    #[test]
    fn void_releases_exactly_like_expire() {
        let now = 100 * D;
        let mut e = epoch(4, now - D, 7 * XNT);
        assert_eq!(void_base_core(&mut e, now).unwrap(), 7 * XNT);
        assert!(e.closed);
        assert!(void_base_core(&mut e, now).is_err()); // EpochClosed
        // hold over
        let mut e = epoch(5, now - CLAIM_HOLD, XNT);
        assert!(void_base_core(&mut e, now).is_err());
        // legacy epoch with a pending drop reserve: reserve released too, PENDING → CANCELLED
        let mut e = epoch(2, now - 10, 9 * XNT);
        e.drop_reserve = XNT;
        e.drop_state = DROP_PENDING;
        assert_eq!(void_base_core(&mut e, now).unwrap(), 10 * XNT);
        assert_eq!(e.drop_state, DROP_CANCELLED);
        // defensive: a claimed epoch cannot be voided
        let mut e = epoch(6, now - 10, XNT);
        e.claimed = 1;
        assert!(void_base_core(&mut e, now).is_err());
    }

    #[test]
    fn cold_waiver_is_one_per_interval() {
        let t = 50 * D;
        assert!(waiver_from_predecessor(t, t - MIN_EPOCH_INTERVAL)); // normal epoch: waiver
        assert!(!waiver_from_predecessor(t, t - MIN_EPOCH_INTERVAL + 1)); // a waived republish: no second waiver
    }

    // ─── Recovery table (theft §5.2 / X-018): a tiny model of the seat-relevant program rules ───

    struct World {
        c: Config,
        seat: OracleSeat,
        epochs: Vec<Epoch>,
        now: i64,
        pool_loss: u64,
    }

    impl World {
        fn new(hot: Pubkey, cold: Pubkey, architect: Pubkey) -> Self {
            let mut c = blank_config();
            c.oracle = hot;
            c.architect = architect;
            World { c, seat: blank_seat(cold, 0), epochs: Vec::new(), now: 100 * D, pool_loss: 0 }
        }
        /// publish_epoch's gate (forge.rs: oracle key, id, interval) + a 10-XNT epoch.
        fn publish(&mut self, signer: Pubkey) -> Result<u64> {
            require_keys_eq!(signer, self.c.oracle, ForgeError::OnlyOracle);
            if self.c.last_epoch > 0 {
                require!(self.now >= self.c.last_publish_ts.saturating_add(MIN_EPOCH_INTERVAL), ForgeError::EpochTooSoon);
            }
            let id = self.c.last_epoch + 1;
            self.epochs.push(epoch(id, self.now, 10 * XNT));
            self.c.last_epoch = id;
            self.c.last_publish_ts = self.now;
            Ok(id)
        }
        /// publish_epoch with a heartbeat's fields (round 4): the program's own forge.rs `epoch_shape` / `epoch_budget`
        /// decide it, so the model cannot drift from the handler. Budget 0, no leaves, even from an empty pool.
        fn heartbeat(&mut self, signer: Pubkey) -> Result<u64> {
            require_keys_eq!(signer, self.c.oracle, ForgeError::OnlyOracle);
            if self.c.last_epoch > 0 {
                require!(self.now >= self.c.last_publish_ts.saturating_add(MIN_EPOCH_INTERVAL), ForgeError::EpochTooSoon);
            }
            let hb = crate::instructions::forge::epoch_shape(&[0u8; 32], 0, 0, 0)?;
            assert!(hb, "all-zero fields are a heartbeat");
            let budget = crate::instructions::forge::epoch_budget(0, 0, 0, hb)?;
            let id = self.c.last_epoch + 1;
            let mut e = epoch(id, self.now, budget);
            (e.total_score, e.leaves, e.rate_cap) = (0, 0, 0);
            self.epochs.push(e);
            self.c.last_epoch = id;
            self.c.last_publish_ts = self.now;
            Ok(id)
        }
        /// void_epoch with the predecessor passed (what the kit does).
        fn void(&mut self, signer: Pubkey, id: u64, bond: u64) -> Result<()> {
            let by_cold = is_cold(&self.seat, &signer);
            let idx = (id - 1) as usize;
            let e = &self.epochs[idx];
            void_gate(e.closed, e.published_at, self.now)?;
            let full = e.budget;
            require!(bond >= void_required(by_cold, full), ForgeError::BondTooSmall);
            let waive = by_cold && (id == 1 || waiver_from_predecessor(e.published_at, self.epochs[idx - 1].published_at));
            let now = self.now;
            void_base_core(&mut self.epochs[idx], now)?;
            if waive {
                self.c.last_publish_ts = 0;
            }
            book_void(&mut self.seat, &signer, by_cold, bond, full)
        }
        fn rotate(&mut self, signer: Pubkey, new_hot: Pubkey) -> Result<()> {
            rotate_hot_core(&mut self.c, &self.seat, &signer, new_hot).map(|_| ())
        }
        fn dead(&self, delay: i64) -> Result<bool> {
            let es = &self.epochs;
            walk_is_dead(self.c.last_epoch, self.seat.taken_at, self.now, delay, |_, id| {
                let e = &es[(id - 1) as usize];
                Ok((EpochView { published_at: e.published_at, closed: e.closed }, None))
            })
        }
        /// resign_seat's gate (G2-R1) + open_seat; the model's pairs carry no extra epoch (neutral).
        fn can_resign(&self) -> Result<bool> {
            let es = &self.epochs;
            resign_allowed(self.c.last_epoch, self.seat.taken_at, self.now, |_, id| {
                let e = &es[(id - 1) as usize];
                Ok((EpochView { published_at: e.published_at, closed: e.closed }, None))
            })
        }
        fn resign(&mut self, signer: Pubkey, successor: Pubkey) -> Result<()> {
            require_cold(&self.seat, &signer)?;
            require!(self.seat.open_since == 0, ForgeError::SeatOpen);
            require!(self.can_resign()?, ForgeError::SeatDead);
            let now = self.now;
            open_seat(&mut self.seat, successor, now);
            Ok(())
        }
        fn take(&mut self, taker: Pubkey, new_hot: Pubkey, new_cold: Pubkey) -> Result<()> {
            take_keys_check(&self.c, &new_hot, &new_cold)?;
            if self.seat.open_since != 0 {
                open_seat_gate(&self.seat, &taker, self.now)?;
            } else {
                let delay = take_delay(&self.seat, &taker);
                require!(self.dead(delay)?, ForgeError::SeatAlive);
            }
            let now = self.now;
            install_seat(&mut self.c, &mut self.seat, new_hot, new_cold, Pubkey::default(), XNT, now);
            Ok(())
        }
        /// Every epoch that survives its hold pays its budget; a thief's surviving epoch is a pool loss.
        fn settle(&mut self, thief_epochs: &[u64]) {
            for id in thief_epochs {
                let e = &self.epochs[(*id - 1) as usize];
                if !e.closed && self.now >= e.published_at + CLAIM_HOLD {
                    self.pool_loss += e.budget;
                }
            }
        }
        fn wait(&mut self, s: i64) {
            self.now += s;
        }
    }

    fn keys() -> (Pubkey, Pubkey, Pubkey, Pubkey) {
        (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique())
    }

    #[test]
    fn recovery_table_x018() {
        // (1) hot stolen, cold safe: rotate_hot + free cold void inside the hold, honest republish at once. Loss 0.
        // (3) hot + architect stolen, cold safe: identical (the architect has no oracle power).
        for architect_stolen in [false, true] {
            let (hot, cold, arch, new_hot) = keys();
            let mut w = World::new(hot, cold, arch);
            w.publish(hot).unwrap();
            w.wait(MIN_EPOCH_INTERVAL);
            let fake = w.publish(hot).unwrap(); // the thief, holding the hot key
            w.wait(D); // the owner reacts inside the 48-h hold
            if architect_stolen {
                assert!(w.rotate(arch, Pubkey::new_unique()).is_err()); // OnlyCold
            }
            w.rotate(cold, new_hot).unwrap();
            w.void(cold, fake, 0).unwrap(); // free
            assert_eq!(w.c.last_publish_ts, 0);
            assert!(w.publish(hot).is_err()); // the stolen key is dead
            w.publish(new_hot).unwrap(); // honest file republished in the same session
            w.wait(3 * D);
            w.settle(&[fake]);
            assert_eq!(w.pool_loss, 0);
        }

        // (2) architect stolen: no oracle power at all.
        let (hot, cold, arch, _) = keys();
        let mut w = World::new(hot, cold, arch);
        assert!(w.publish(arch).is_err());
        assert!(w.rotate(arch, arch).is_err());
        w.publish(hot).unwrap();
        assert!(w.void(arch, 1, 0).is_err()); // BondTooSmall: the architect pays like anyone
        // (5) architect lost: the oracle keeps working
        w.wait(MIN_EPOCH_INTERVAL);
        w.publish(hot).unwrap();

        // (4) hot lost: the cold key rotates at once.
        let (hot, cold, arch, new_hot) = keys();
        let mut w = World::new(hot, cold, arch);
        w.publish(hot).unwrap();
        w.rotate(cold, new_hot).unwrap();
        w.wait(MIN_EPOCH_INTERVAL);
        w.publish(new_hot).unwrap();

        // (6) hot and cold lost: silence → dead after 28 d (+24 h for non-priority) → take_seat by anyone.
        let (hot, cold, arch, community) = keys();
        let mut w = World::new(hot, cold, arch);
        w.publish(hot).unwrap();
        w.wait(DEAD_SEAT_DELAY + 1);
        assert!(w.take(community, community, Pubkey::default()).is_err()); // SeatAlive: priority window still running
        w.wait(SEAT_PRIORITY_WINDOW);
        let new_hot = Pubkey::new_unique();
        w.take(community, new_hot, Pubkey::default()).unwrap();
        assert!(w.publish(hot).is_err());
        w.publish(new_hot).unwrap();
        assert_eq!(w.seat.generation, 2);

        // (7) cold stolen: the thief rotates, publishes fakes and self-voids for waivers; defenders void what stands;
        // the seat dies, the walk stays bounded, the community takes it. Pool loss 0.
        let (hot, cold, arch, defender) = keys();
        let mut w = World::new(hot, cold, arch);
        w.publish(hot).unwrap();
        let thief_hot = Pubkey::new_unique();
        w.rotate(cold, thief_hot).unwrap();
        let mut fakes = Vec::new();
        for _ in 0..5 {
            w.wait(MIN_EPOCH_INTERVAL);
            let f = w.publish(thief_hot).unwrap();
            fakes.push(f);
            w.void(cold, f, 0).unwrap(); // waiver used
            let g = w.publish(thief_hot).unwrap(); // waived republish
            fakes.push(g);
            assert!(w.publish(thief_hot).is_err()); // no third epoch in the same slot
            w.void(cold, g, 0).unwrap(); // no waiver this time
            assert_ne!(w.c.last_publish_ts, 0);
        }
        w.wait(DEAD_SEAT_DELAY + SEAT_PRIORITY_WINDOW);
        w.settle(&fakes);
        assert_eq!(w.pool_loss, 0);
        let taker_hot = Pubkey::new_unique();
        w.take(defender, taker_hot, Pubkey::new_unique()).unwrap();
        assert!(w.publish(thief_hot).is_err());
        assert!(w.rotate(cold, Pubkey::new_unique()).is_err()); // the stolen cold key is no longer the seat's
    }

    fn is_err_unit(r: Result<()>, want: ForgeError) -> bool {
        match r {
            Err(Error::AnchorError(e)) => e.error_code_number == want as u32 + anchor_lang::error::ERROR_CODE_OFFSET,
            _ => false,
        }
    }

    /// Round 4, quiet-month seat liveness (s6-minus-7 MANIFEST §4 item 4; FORGOTTEN §0 item 2). Eight weeks without a
    /// single paying burn: with a weekly heartbeat (budget 0) the seat never dies and nobody can take it; with silence
    /// it dies at 28 d (priority) / 28 d + 24 h (anyone), as before; heartbeats that a defender voids do not count, so a
    /// stolen hot key cannot keep its seat alive with them (each void costs VOID_BOND_MIN and returns nothing); a
    /// heartbeat takes its interval slot like any epoch; the walk stays bounded.
    #[test]
    fn quiet_month_heartbeats_keep_the_seat_alive() {
        // honest quiet months: one paying epoch, then heartbeats only
        let (hot, cold, arch, community) = keys();
        let mut w = World::new(hot, cold, arch);
        w.publish(hot).unwrap();
        for week in 1..=8 {
            w.wait(7 * D);
            let id = w.heartbeat(hot).unwrap();
            assert_eq!((w.epochs[(id - 1) as usize].budget, w.epochs[(id - 1) as usize].total_score), (0, 0));
            assert!(!w.dead(DEAD_SEAT_DELAY).unwrap(), "week {week}: alive for the priority voider's delay");
            assert!(is_err_unit(w.take(community, Pubkey::new_unique(), Pubkey::default()), ForgeError::SeatAlive));
            // the heartbeat holds the interval slot: no second publication in the same 6 days
            assert!(is_err_unit(w.publish(hot).map(|_| ()), ForgeError::EpochTooSoon));
            assert!(is_err_unit(w.heartbeat(hot).map(|_| ()), ForgeError::EpochTooSoon));
        }
        // the last heartbeat survives its hold; the seat dies only 28 d after it, never earlier
        w.wait(DEAD_SEAT_DELAY - 1);
        assert!(!w.dead(DEAD_SEAT_DELAY).unwrap());
        w.wait(2);
        assert!(w.dead(DEAD_SEAT_DELAY).unwrap(), "a seat that stops publishing altogether still dies");
        // a resign is allowed on heartbeats (a seat that produced a surviving epoch): no different from a paying epoch
        let mut r = World::new(hot, cold, arch);
        r.heartbeat(hot).unwrap();
        r.wait(CLAIM_HOLD);
        assert!(r.can_resign().unwrap());

        // the same eight weeks in silence (the program before round 4 refused every empty base epoch): dead at 28 d
        let mut s = World::new(hot, cold, arch);
        s.publish(hot).unwrap();
        s.wait(DEAD_SEAT_DELAY + 1);
        assert!(s.dead(DEAD_SEAT_DELAY).unwrap());
        assert!(is_err_unit(s.take(community, community, Pubkey::default()), ForgeError::SeatAlive)); // + 24 h for anyone
        s.wait(SEAT_PRIORITY_WINDOW);
        s.take(community, Pubkey::new_unique(), Pubkey::default()).unwrap();

        // a thief with the hot key heartbeats every interval; a defender voids each one (SEAT_BOND_MIN since r4-fix,
        // returns 0, earns no priority): dead
        let (hot, cold, arch, defender) = keys();
        let mut t = World::new(hot, cold, arch);
        t.publish(hot).unwrap();
        let prio0 = t.seat.priority;
        let mut voids = 0u32;
        for _ in 0..5 {
            t.wait(MIN_EPOCH_INTERVAL);
            let hb = t.heartbeat(hot).unwrap();
            assert!(is_err_unit(t.void(defender, hb, VOID_BOND_MIN), ForgeError::BondTooSmall), "r4-fix: 0.05 XNT no longer voids a heartbeat");
            assert!(is_err_unit(t.void(defender, hb, SEAT_BOND_MIN - 1), ForgeError::BondTooSmall));
            let idx = (hb - 1) as usize;
            let now = t.now;
            let mut probe = t.epochs[idx].clone();
            assert_eq!(void_base_core(&mut probe, now).unwrap(), 0, "a heartbeat's void returns nothing to the pool");
            t.void(defender, hb, SEAT_BOND_MIN).unwrap();
            voids += 1;
        }
        assert_eq!((t.seat.voids, t.seat.to_pool, t.seat.priority), (voids, voids as u64 * SEAT_BOND_MIN, prio0));
        t.wait(DEAD_SEAT_DELAY + 1 - 4 * MIN_EPOCH_INTERVAL);
        assert!(t.dead(DEAD_SEAT_DELAY).unwrap(), "voided heartbeats keep nobody's seat alive");
        // no priority from heartbeat voids: the defender takes it as anyone does (28 d + 24 h, already over here)
        assert_eq!(take_delay(&t.seat, &defender), DEAD_SEAT_DELAY + SEAT_PRIORITY_WINDOW);
        t.take(defender, Pubkey::new_unique(), Pubkey::new_unique()).unwrap();
        assert_eq!(t.seat.generation, 2);
    }

    /// r4-fix (review r4 finding 3): a squatter in an honest quiet month. The oracle heartbeats every week; a stranger
    /// voids each heartbeat to kill the seat and take it first. Before: 0.05 XNT per void (about 0.25 XNT in all) and the
    /// first void at a higher bond bought the 24-h takeover priority. Now each void costs SEAT_BOND_MIN (refused below),
    /// none of them earns priority, and the cold key still voids for free; once the seat is dead the squatter has no
    /// head start: at 28 d it is refused like anyone, and after the 24-h window it races everyone else, the honest
    /// operator included. A paying epoch's void still prices and prioritizes as before.
    #[test]
    fn heartbeat_squatter_pays_and_gets_no_priority() {
        let (hot, cold, arch, squatter) = keys();
        let mut w = World::new(hot, cold, arch);
        w.publish(hot).unwrap();
        let prio0 = (w.seat.priority, w.seat.priority_bond);
        let mut spent = 0u64;
        for week in 0..4 {
            w.wait(7 * D);
            let hb = w.heartbeat(hot).unwrap();
            assert!(is_err_unit(w.void(squatter, hb, VOID_BOND_MIN), ForgeError::BondTooSmall), "week {week}");
            let bond = if week == 0 { 3 * SEAT_BOND_MIN } else { SEAT_BOND_MIN }; // a larger bond buys nothing either
            w.void(squatter, hb, bond).unwrap();
            spent += bond;
            assert_eq!((w.seat.priority, w.seat.priority_bond), prio0, "week {week}: no priority from a heartbeat void");
        }
        assert!(spent >= 4 * SEAT_BOND_MIN, "the squatter paid at least 4 XNT, not 0.2");
        // 28 d after the last surviving epoch: dead for a priority holder, but the squatter holds none: no head start
        w.wait(1);
        assert!(w.dead(DEAD_SEAT_DELAY).unwrap());
        assert_eq!(take_delay(&w.seat, &squatter), DEAD_SEAT_DELAY + SEAT_PRIORITY_WINDOW);
        assert!(is_err_unit(w.take(squatter, Pubkey::new_unique(), Pubkey::new_unique()), ForgeError::SeatAlive), "no head start");
        // after the 24-h window it races everyone else; here the honest operator's new keys take it first
        w.wait(SEAT_PRIORITY_WINDOW);
        w.take(Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique()).unwrap();
        assert_eq!(w.seat.generation, 2);
        // the cold key voids a heartbeat for free (a stolen hot key's heartbeats), and a paying epoch keeps the old rule
        let (hot, cold, arch, voider) = keys();
        let mut c = World::new(hot, cold, arch);
        c.publish(hot).unwrap();
        c.wait(MIN_EPOCH_INTERVAL);
        let hb = c.heartbeat(hot).unwrap();
        c.void(cold, hb, 0).unwrap();
        c.wait(MIN_EPOCH_INTERVAL);
        let paying = c.publish(hot).unwrap();
        let need = void_required(false, c.epochs[(paying - 1) as usize].budget);
        assert_eq!(need, XNT, "10% of a 10-XNT budget");
        c.void(voider, paying, need).unwrap();
        assert_eq!((c.seat.priority, c.seat.priority_bond), (voider, need), "a paying epoch's void still takes priority");
    }

    /// G2-R1 (the review's loop): under the literal theft §4.5.5 rule (!seat_is_dead) a stolen cold key, or a vandal
    /// who took a dead seat once, looped resign → take as its own successor and the seat never died. Now a resign needs
    /// a surviving epoch since the take: the loop breaks after one take, the seat dies, the community takes it.
    #[test]
    fn resign_take_loop_is_closed() {
        let (hot, cold, arch, community) = keys();
        let mut w = World::new(hot, cold, arch);
        // a fresh seat with nothing produced since its take cannot resign either
        assert!(is_err_unit(w.resign(cold, Pubkey::new_unique()), ForgeError::SeatDead));
        w.publish(hot).unwrap();
        assert!(!w.can_resign().unwrap()); // in hold = not survived
        w.wait(3 * D); // the honest epoch survived
        let thief = Pubkey::new_unique();
        w.resign(cold, thief).unwrap(); // stolen cold key: one graceful exit from the honest living seat
        assert!(is_err_unit(w.take(community, Pubkey::new_unique(), Pubkey::default()), ForgeError::SeatPriority));
        let (thief_hot, thief_cold) = (Pubkey::new_unique(), Pubkey::new_unique());
        w.take(thief, thief_hot, thief_cold).unwrap();
        // the old rule (!seat_is_dead) answers "alive" right after a take and would have returned the bond
        assert!(!w.dead(DEAD_SEAT_DELAY).unwrap());
        // the new rule: just taken, nothing produced → SeatDead
        assert!(is_err_unit(w.resign(thief_cold, thief), ForgeError::SeatDead));
        // fakes every 6 days, all voided by defenders: still no graceful exit
        for _ in 0..4 {
            w.wait(MIN_EPOCH_INTERVAL);
            let f = w.publish(thief_hot).unwrap();
            assert!(is_err_unit(w.resign(thief_cold, thief), ForgeError::SeatDead));
            w.void(community, f, 100 * XNT).unwrap();
        }
        w.wait(DEAD_SEAT_DELAY + SEAT_PRIORITY_WINDOW - 4 * MIN_EPOCH_INTERVAL + 1);
        assert!(is_err_unit(w.resign(thief_cold, thief), ForgeError::SeatDead));
        let new_hot = Pubkey::new_unique();
        w.take(community, new_hot, Pubkey::new_unique()).unwrap(); // dead: the community takes it (bond forfeited)
        assert_eq!(w.seat.generation, 3);
        // the honest path stays open: a seat that produced a surviving epoch after its take may resign
        let new_cold = w.seat.cold;
        w.wait(MIN_EPOCH_INTERVAL);
        w.publish(new_hot).unwrap();
        assert!(!w.can_resign().unwrap()); // in hold
        w.wait(CLAIM_HOLD);
        assert!(w.can_resign().unwrap());
        w.resign(new_cold, community).unwrap();
        assert!(is_err_unit(w.resign(new_cold, community), ForgeError::SeatOpen));
    }

    /// G2-R1 on the raw walk: epochs before max(now − 28 d, taken_at) never count; an extra pair must survive too;
    /// a surviving epoch older than 28 d does not count either.
    #[test]
    fn resign_allowed_window() {
        const NOW: i64 = 500 * D;
        let now = NOW;
        fn allowed(pairs: &[(u64, &Epoch, Option<&ExtraEpoch>)], last: u64, taken_at: i64) -> Result<bool> {
            let raw = Raw::new(pairs);
            resign_allowed(last, taken_at, NOW, |i, id| {
                let b = raw.accs.get(i).ok_or(error!(ForgeError::BadEpochWindow))?;
                let x = raw.accs.get(i + 1).ok_or(error!(ForgeError::BadEpochWindow))?;
                pair_view(id, (&b.0, &b.1, &b.2), (&x.0, &x.1, &x.2))
            })
        }
        let e5 = epoch(5, now - 10 * D, XNT); // survived
        let e4 = epoch(4, now - 16 * D, XNT);
        // taken 30 d ago: e5 (10 d old) survived → may resign
        assert!(allowed(&[(5, &e5, None)], 5, now - 30 * D).unwrap());
        // taken 5 d ago: e5 predates the take → closes the walk, nothing since → refused
        assert!(!allowed(&[(5, &e5, None)], 5, now - 5 * D).unwrap());
        // the only surviving epoch is older than 28 d → refused even for an old seat
        let old = epoch(5, now - 29 * D, XNT);
        assert!(!allowed(&[(5, &old, None)], 5, now - 100 * D).unwrap());
        // newest in hold, the one before survived → allowed
        let e6 = epoch(6, now - D, XNT);
        assert!(allowed(&[(6, &e6, None), (5, &e5, None)], 6, now - 30 * D).unwrap());
        // base survived but its extra was voided → that pair fails; the next one decides
        let mut vx = extra(5, now - 10 * D, XNT);
        vx.closed = true;
        assert!(allowed(&[(5, &e5, Some(&vx)), (4, &e4, None)], 5, now - 30 * D).unwrap());
        let mut c4 = e4.clone();
        c4.closed = true;
        let e3 = epoch(3, now - 40 * D, XNT); // closes the walk
        assert!(!allowed(&[(5, &e5, Some(&vx)), (4, &c4, None), (3, &e3, None)], 5, now - 30 * D).unwrap());
        // a missing pair → BadEpochWindow, never "allowed"
        assert!(is_err(allowed(&[(5, &e5, Some(&vx))], 5, now - 30 * D), ForgeError::BadEpochWindow));
        // nothing ever published → refused
        assert!(!allowed(&[], 0, now - 30 * D).unwrap());
    }

    /// G2-R2: during the 24 h after a resign a paid void (any bond) cannot take over the named successor's priority;
    /// the void counters still accumulate. Outside an open seat the largest voider still gets the priority.
    #[test]
    fn open_seat_keeps_its_successor() {
        let (cold, successor, other) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        let mut s = blank_seat(cold, 0);
        let t = 50 * D;
        open_seat(&mut s, successor, t);
        book_void(&mut s, &other, false, XNT, 10 * XNT).unwrap();
        assert_eq!((s.priority, s.priority_bond, s.voids, s.to_pool, s.bond), (successor, 0, 1, XNT, 0));
        assert!(open_seat_gate(&s, &successor, t + 5).is_ok());
        assert!(is_err_unit(open_seat_gate(&s, &other, t + 5), ForgeError::SeatPriority));
        assert!(open_seat_gate(&s, &other, t + SEAT_PRIORITY_WINDOW).is_ok()); // after 24 h: anyone
        // closed seat: the largest non-cold voider takes the slot
        let mut s = blank_seat(cold, 0);
        book_void(&mut s, &other, false, XNT, 10 * XNT).unwrap();
        assert_eq!((s.priority, s.priority_bond), (other, XNT));
    }

    /// G2-R3: a cold void of id > 1 without remaining_accounts[0] proceeds without the waiver; a wrong account
    /// (PDA, owner, discriminator, id) is still refused; epoch 1 always waives.
    #[test]
    fn cold_void_without_predecessor_fails_open() {
        let t = 80 * D;
        assert!(cold_waiver_from(1, t, None).unwrap());
        assert!(!cold_waiver_from(7, t, None).unwrap());
        let prev = epoch(6, t - MIN_EPOCH_INTERVAL, XNT);
        let pb = bytes(&prev);
        assert!(cold_waiver_from(7, t, Some((&epoch_pda(6), &crate::ID, &pb[..]))).unwrap());
        let near = epoch(6, t - MIN_EPOCH_INTERVAL + 1, XNT); // a waived republish: no second waiver
        let nb = bytes(&near);
        assert!(!cold_waiver_from(7, t, Some((&epoch_pda(6), &crate::ID, &nb[..]))).unwrap());
        let wrong_pda = cold_waiver_from(7, t, Some((&epoch_pda(5), &crate::ID, &pb[..])));
        assert!(is_err(wrong_pda, ForgeError::BadEpochWindow));
        let wrong_owner = cold_waiver_from(7, t, Some((&epoch_pda(6), &Pubkey::new_unique(), &pb[..])));
        assert!(is_err(wrong_owner, ForgeError::BadEpochWindow));
        let mut wrong_id = prev.clone();
        wrong_id.id = 5;
        let wb = bytes(&wrong_id);
        assert!(is_err(cold_waiver_from(7, t, Some((&epoch_pda(6), &crate::ID, &wb[..]))), ForgeError::BadEpochWindow));
        let xb = bytes(&extra(6, t, 0));
        assert!(cold_waiver_from(7, t, Some((&epoch_pda(6), &crate::ID, &xb[..]))).is_err()); // wrong discriminator
        let empty: Vec<u8> = Vec::new();
        assert!(cold_waiver_from(7, t, Some((&epoch_pda(6), &anchor_lang::system_program::ID, &empty[..]))).is_err());
    }

    /// G2-R4: the refund address may be anything but the seat PDA.
    #[test]
    fn take_refund_is_not_the_seat() {
        let seat = Pubkey::find_program_address(&[SEED_ORACLE_SEAT], &crate::ID).0;
        assert!(is_err_unit(take_refund_check(&seat, &seat), ForgeError::InvalidTarget));
        assert!(take_refund_check(&Pubkey::default(), &seat).is_ok()); // default = the pool
        assert!(take_refund_check(&Pubkey::new_unique(), &seat).is_ok());
        assert!(take_refund_check(&SEAT_REFUND_INITIAL, &seat).is_ok()); // init_seat writes it unchecked
    }

    #[test]
    fn rotate_and_take_key_rules() {
        let (hot, cold, arch, other) = keys();
        let mut c = blank_config();
        c.oracle = hot;
        c.architect = arch;
        c.pending_oracle = other; // a thief's pending hand-over
        let seat = blank_seat(cold, 0);
        assert!(rotate_hot_core(&mut c, &seat, &hot, other).is_err()); // OnlyCold
        assert!(rotate_hot_core(&mut c, &seat, &cold, cold).is_err()); // the cold key stays offline
        assert!(rotate_hot_core(&mut c, &seat, &cold, arch).is_err()); // the architect stays a payee
        assert!(rotate_hot_core(&mut c, &seat, &cold, Pubkey::default()).is_err());
        assert_eq!(rotate_hot_core(&mut c, &seat, &cold, other).unwrap(), hot);
        assert_eq!((c.oracle, c.pending_oracle), (other, Pubkey::default()));
        // no cold key: nobody can rotate
        let no_cold = blank_seat(Pubkey::default(), 0);
        assert!(rotate_hot_core(&mut c, &no_cold, &Pubkey::default(), hot).is_err());

        assert!(take_keys_check(&c, &Pubkey::default(), &cold).is_err());
        assert!(take_keys_check(&c, &hot, &hot).is_err());
        assert!(take_keys_check(&c, &arch, &cold).is_err());
        assert!(take_keys_check(&c, &hot, &Pubkey::default()).is_ok());

        // open seat: successor first for 24 h
        let mut s = blank_seat(cold, 0);
        s.open_since = 10 * D;
        s.priority = other;
        assert!(open_seat_gate(&s, &hot, 10 * D + 5).is_err());
        assert!(open_seat_gate(&s, &other, 10 * D + 5).is_ok());
        assert!(open_seat_gate(&s, &hot, 11 * D).is_ok());
    }
}
