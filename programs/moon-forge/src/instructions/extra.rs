//! Extra pot (SPEC-UPGRADE-v2 §2.15, nft-extra A4): 25% of every forge price goes to `extra_vault`; the oracle publishes
//! one extra epoch per base epoch (a Merkle tree of usage rebates for Artifact holders, computed off-chain) bounded
//! ON-CHAIN by min(8% of the pot's free balance, 4% of the live forged floors + floors that left since the last
//! publish). Claims wait CLAIM_HOLD (48 h) like base claims, are bits in the epoch's bitmap, pay the leaf wallet
//! directly and can never exceed the epoch's published total (X-1). After 90 days the unclaimed rest returns to the
//! pot. Everything is counted (`ExtraState`): lamports sent to `extra_vault` by anyone else are ignored.
//! No instruction in this file touches reward_vault.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::ForgeError;
use crate::events::*;
use crate::state::*;
use crate::utils::*;

// ═══════════════════════════════════════════════════════════════════════════
// Pure cores (host-testable)
// ═══════════════════════════════════════════════════════════════════════════

/// leaf = keccak(LEAF_DOMAIN_EXTRA ‖ epoch u64 LE ‖ index u32 LE ‖ wallet 32 ‖ amount u64 LE)
pub fn extra_leaf(epoch: u64, index: u32, wallet: &Pubkey, amount: u64) -> [u8; 32] {
    keccak(&[LEAF_DOMAIN_EXTRA, &epoch.to_le_bytes(), &index.to_le_bytes(), wallet.as_ref(), &amount.to_le_bytes()])
}

/// Bit i of the claim bitmap: byte i / 8, bit i % 8 (least significant first).
pub(crate) fn bit_is_set(bitmap: &[u8; EXTRA_BITMAP_BYTES], i: u32) -> bool {
    bitmap[(i / 8) as usize] & (1u8 << (i % 8)) != 0
}

pub(crate) fn bit_set(bitmap: &mut [u8; EXTRA_BITMAP_BYTES], i: u32) {
    bitmap[(i / 8) as usize] |= 1u8 << (i % 8);
}

/// (free, bound): free = accounted − reserved; bound = min(8% of free, weeks × 4% of (live forged backing + backing
/// out since the last publish)), the release term NOT scaled (oracle A13.3: one release per published base epoch;
/// the backing term per 7-day week, floored per week then multiplied, exactly the oracle's `backingBoundOf`).
/// Counters only: stray lamports in extra_vault never raise it.
pub(crate) fn extra_bound(x: &ExtraState, weeks: u8) -> Result<(u64, u64)> {
    let free = x.accounted.checked_sub(x.reserved).ok_or(ForgeError::MathOverflow)?;
    let backing = x.live_forged_backing.checked_add(x.out_since_publish).ok_or(ForgeError::MathOverflow)?;
    let per_week = bps(backing, EXTRA_BACKING_BOUND_BPS)?;
    let backing_bound = per_week.checked_mul(weeks as u64).ok_or(ForgeError::MathOverflow)?;
    let bound = bps(free, EXTRA_RELEASE_BPS)?.min(backing_bound);
    Ok((free, bound))
}

/// A13.3: the most 7-day weeks the base window of extra epoch `id` can carry, from the base epochs' own on-chain
/// publication times: max(1, ⌊(published_at(id) − published_at(id − 1) + EXTRA_WEEK_SLACK) / EXTRA_WEEK⌋), at most
/// EXTRA_MAX_WEEKS. The oracle's window [published_at(id − 1), snapshot(id)] ends before published_at(id), so its
/// k = max(1, ⌊(len + 6 h) / 1 week⌋) (clamped to the same cap) never exceeds this. `prev_published_at` None (epoch 1,
/// no predecessor): 1 week, the oracle's first window (endTs − 7 days).
pub(crate) fn extra_weeks_max(published_at: i64, prev_published_at: Option<i64>) -> u8 {
    let Some(prev) = prev_published_at else {
        return 1;
    };
    let span = published_at.saturating_sub(prev).saturating_add(EXTRA_WEEK_SLACK).max(0);
    (span / EXTRA_WEEK).clamp(1, EXTRA_MAX_WEEKS as i64) as u8
}

/// published_at of the base Epoch `id − 1` from raw account parts (publish_extra_epoch's `prev_epoch`): the right PDA,
/// owned by this program, Epoch discriminator and id, else BadEpochWindow (base Epoch accounts are never closed, so
/// it always exists for id ≥ 2). Epoch 1 has no predecessor: the account is ignored, None.
pub(crate) fn prev_published_at(epoch_id: u64, key: &Pubkey, owner: &Pubkey, data: &[u8]) -> Result<Option<i64>> {
    if epoch_id <= 1 {
        return Ok(None);
    }
    Ok(Some(crate::instructions::seat::epoch_view(epoch_id - 1, key, owner, data)?.published_at))
}

/// publish_extra_epoch checks + ExtraState bookkeeping. `weeks` is the publication's claim (the oracle's
/// `window.weeks`), `weeks_max` the chain's bound for it (`extra_weeks_max`). Returns (free_before, free_after).
#[allow(clippy::too_many_arguments)]
pub(crate) fn extra_publish_core(
    x: &mut ExtraState,
    base_last_epoch: u64,
    epoch_id: u64,
    total: u64,
    leaves: u32,
    weeks: u8,
    weeks_max: u8,
    now: i64,
) -> Result<(u64, u64)> {
    let next = x.last_epoch.checked_add(1).ok_or(ForgeError::MathOverflow)?;
    require!(epoch_id == next && epoch_id <= base_last_epoch, ForgeError::ExtraEpochOrder);
    if total > 0 {
        // heartbeats (total 0) need no interval: after an outage the oracle catches up in one run (X-3)
        require!(now >= x.last_publish_ts.saturating_add(MIN_EPOCH_INTERVAL), ForgeError::ExtraEpochOrder);
        require!(leaves > 0, ForgeError::EmptyEpoch);
    }
    // a tree wider than the 1,000-bit bitmap could never be claimed
    require!(leaves <= EXTRA_MAX_LEAVES, ForgeError::InvalidProof);
    // A13.3: never trusted blindly; checked on heartbeats too, so the event's `weeks` is always one the chain allows
    require!(weeks >= 1 && weeks <= weeks_max, ForgeError::BadEpochWindow);
    let (free, bound) = extra_bound(x, weeks)?;
    require!(total <= bound, ForgeError::ExtraBudgetExceeded);

    x.reserved = x.reserved.checked_add(total).ok_or(ForgeError::MathOverflow)?;
    x.last_epoch = epoch_id;
    if total > 0 {
        x.last_publish_ts = now;
    }
    x.free_after = x.accounted.checked_sub(x.reserved).ok_or(ForgeError::MathOverflow)?;
    x.out_since_publish = 0;
    Ok((free, x.free_after))
}

/// claim_extra gates before the proof: window, hold, index, bitmap.
pub(crate) fn extra_claim_gate(e: &ExtraEpoch, index: u32, now: i64) -> Result<()> {
    require!(!e.closed && now < e.published_at.saturating_add(CLAIM_WINDOW), ForgeError::ExtraClaimWindow);
    require!(now >= e.published_at.saturating_add(CLAIM_HOLD), ForgeError::ClaimOnHold);
    require!(index < e.leaves, ForgeError::InvalidProof);
    require!(!bit_is_set(&e.bitmap, index), ForgeError::ExtraAlreadyClaimed);
    Ok(())
}

/// claim_extra bookkeeping after the proof: the epoch's published total bounds the tree whatever its leaves sum to
/// (X-1); checked arithmetic, never saturating.
pub(crate) fn extra_claim_book(x: &mut ExtraState, e: &mut ExtraEpoch, index: u32, amount: u64) -> Result<()> {
    let claimed = e.claimed.checked_add(amount).ok_or(ForgeError::MathOverflow)?;
    require!(claimed <= e.budget, ForgeError::BudgetExhausted);
    bit_set(&mut e.bitmap, index);
    e.claimed = claimed;
    x.accounted = x.accounted.checked_sub(amount).ok_or(ForgeError::MathOverflow)?;
    x.reserved = x.reserved.checked_sub(amount).ok_or(ForgeError::MathOverflow)?;
    x.total_paid = x.total_paid.checked_add(amount).ok_or(ForgeError::MathOverflow)?;
    Ok(())
}

/// close_extra_epoch bookkeeping: after 90 days the unclaimed rest returns to the free pot (a voided epoch already
/// returned it: 0).
pub(crate) fn extra_close_core(x: &mut ExtraState, e: &mut ExtraEpoch, now: i64) -> Result<u64> {
    require!(now >= e.published_at.saturating_add(CLAIM_WINDOW), ForgeError::ExtraClaimWindow);
    if e.closed {
        return Ok(0);
    }
    let returned = e.budget.checked_sub(e.claimed).ok_or(ForgeError::MathOverflow)?;
    x.reserved = x.reserved.checked_sub(returned).ok_or(ForgeError::MathOverflow)?;
    x.total_returned = x.total_returned.checked_add(returned).ok_or(ForgeError::MathOverflow)?;
    e.closed = true;
    Ok(returned)
}

/// void_extra_epoch bookkeeping (seat.rs): inside the hold, closes the epoch and returns its whole budget to the free
/// pot. A heartbeat (budget 0) may be voided too (it still breaks the seat-walk pair) and returns 0.
pub(crate) fn extra_void_core(x: &mut ExtraState, e: &mut ExtraEpoch, now: i64) -> Result<u64> {
    crate::instructions::seat::void_gate(e.closed, e.published_at, now)?;
    require!(e.claimed == 0, ForgeError::MathOverflow); // nothing can be claimed inside the hold
    let returned = e.budget.checked_sub(e.claimed).ok_or(ForgeError::MathOverflow)?;
    x.reserved = x.reserved.checked_sub(returned).ok_or(ForgeError::MathOverflow)?;
    x.total_returned = x.total_returned.checked_add(returned).ok_or(ForgeError::MathOverflow)?;
    e.closed = true;
    Ok(returned)
}

/// The base Epoch account of the same id exists (owned by this program, Epoch discriminator).
pub(crate) fn is_epoch_account(a: &AccountInfo) -> bool {
    if *a.owner != crate::ID {
        return false;
    }
    match a.try_borrow_data() {
        Ok(d) => d.len() == 8 + Epoch::INIT_SPACE && d.starts_with(Epoch::DISCRIMINATOR),
        Err(_) => false,
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// init_extra — permissionless, once; must run before the first forge
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct InitExtra<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = payer, space = 8 + ExtraState::INIT_SPACE, seeds = [SEED_EXTRA_STATE], bump)]
    pub extra_state: Box<Account<'info, ExtraState>>,
    /// CHECK: extra pot vault PDA (program-owned, lamports only); created here
    #[account(mut, seeds = [SEED_EXTRA_VAULT], bump)]
    pub extra_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn init_extra(ctx: Context<InitExtra>) -> Result<()> {
    let vb = ctx.bumps.extra_vault;
    ensure_vault(
        &ctx.accounts.extra_vault,
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &[SEED_EXTRA_VAULT, &[vb]],
        ctx.program_id,
    )?;
    let x = &mut ctx.accounts.extra_state;
    x.last_epoch = ctx.accounts.config.last_epoch;
    x.last_publish_ts = 0;
    x.accounted = 0;
    x.reserved = 0;
    x.free_after = 0;
    x.live_forged_backing = 0;
    x.out_since_publish = 0;
    x.total_in = 0;
    x.total_paid = 0;
    x.total_returned = 0;
    x.vault_bump = vb;
    x.bump = ctx.bumps.extra_state;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// publish_extra_epoch — oracle only, one per base epoch, bounded on-chain
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
#[instruction(epoch_id: u64)]
pub struct PublishExtraEpoch<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EXTRA_STATE], bump = extra_state.bump)]
    pub extra_state: Box<Account<'info, ExtraState>>,
    #[account(
        init, payer = oracle, space = 8 + ExtraEpoch::INIT_SPACE,
        seeds = [SEED_EXTRA_EPOCH, epoch_id.to_le_bytes().as_ref()], bump
    )]
    pub extra_epoch: Box<Account<'info, ExtraEpoch>>,
    /// CHECK: the base Epoch PDA of the same id; it must exist (owner + discriminator)
    #[account(
        seeds = [SEED_EPOCH, epoch_id.to_le_bytes().as_ref()], bump,
        constraint = is_epoch_account(&base_epoch) @ ForgeError::ExtraBaseEpochMissing
    )]
    pub base_epoch: UncheckedAccount<'info>,
    /// CHECK: the base Epoch PDA of epoch_id − 1 (seeds [epoch, epoch_id − 1]; checked in the handler: PDA, owner,
    /// discriminator, id, else BadEpochWindow). Its published_at opens the window that bounds `weeks` (A13.3).
    /// Ignored for epoch 1 (no predecessor: weeks must be 1).
    pub prev_epoch: UncheckedAccount<'info>,
    #[account(mut, address = config.oracle @ ForgeError::OnlyOracle)]
    pub oracle: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn publish_extra_epoch(
    ctx: Context<PublishExtraEpoch>,
    epoch_id: u64,
    root: [u8; 32],
    data_hash: [u8; 32],
    total: u64,
    leaves: u32,
    weeks: u8,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let base_last = ctx.accounts.config.last_epoch;
    // A13.3: the chain's bound on `weeks`, from published_at of the base epochs id and id − 1
    let base_published_at = {
        let d = ctx.accounts.base_epoch.try_borrow_data()?;
        Epoch::try_deserialize(&mut &d[..])?.published_at
    };
    let prev_at = {
        let p = &ctx.accounts.prev_epoch;
        let d = p.try_borrow_data()?;
        prev_published_at(epoch_id, p.key, p.owner, &d[..])?
    };
    let weeks_max = extra_weeks_max(base_published_at, prev_at);
    let (free_before, free_after) =
        extra_publish_core(&mut ctx.accounts.extra_state, base_last, epoch_id, total, leaves, weeks, weeks_max, now)?;

    let e = &mut ctx.accounts.extra_epoch;
    e.id = epoch_id;
    e.root = root;
    e.data_hash = data_hash;
    e.budget = total;
    e.claimed = 0;
    e.leaves = leaves;
    e.published_at = now;
    e.free_before = free_before;
    e.closed = false;
    e.bump = ctx.bumps.extra_epoch;
    e.rent_payer = ctx.accounts.oracle.key();
    e.bitmap = [0u8; EXTRA_BITMAP_BYTES];

    emit!(ExtraEpochPublished { epoch: epoch_id, root, data_hash, total, leaves, free_before, free_after, weeks });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// claim_extra — PERMISSIONLESS after the hold: the XNT goes to the wallet in the leaf
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
#[instruction(epoch_id: u64)]
pub struct ClaimExtra<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EXTRA_STATE], bump = extra_state.bump)]
    pub extra_state: Box<Account<'info, ExtraState>>,
    #[account(mut, seeds = [SEED_EXTRA_EPOCH, epoch_id.to_le_bytes().as_ref()], bump = extra_epoch.bump)]
    pub extra_epoch: Box<Account<'info, ExtraEpoch>>,
    /// CHECK: extra pot vault PDA
    #[account(mut, seeds = [SEED_EXTRA_VAULT], bump = extra_state.vault_bump)]
    pub extra_vault: UncheckedAccount<'info>,
    /// CHECK: beneficiary; authenticated by the Merkle leaf, not by a signature
    #[account(mut)]
    pub wallet: UncheckedAccount<'info>,
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn claim_extra(ctx: Context<ClaimExtra>, epoch_id: u64, index: u32, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let wallet = ctx.accounts.wallet.key();
    extra_claim_gate(&ctx.accounts.extra_epoch, index, now)?;
    let leaf = extra_leaf(epoch_id, index, &wallet, amount);
    require!(verify_proof(&proof, &ctx.accounts.extra_epoch.root, leaf), ForgeError::InvalidProof);
    extra_claim_book(&mut ctx.accounts.extra_state, &mut ctx.accounts.extra_epoch, index, amount)?;
    move_lamports(&ctx.accounts.extra_vault.to_account_info(), &ctx.accounts.wallet.to_account_info(), amount)?;
    emit!(ExtraClaimed { epoch: epoch_id, wallet, amount });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// close_extra_epoch — PERMISSIONLESS after 90 days; rent back to the oracle key that paid it (X-2)
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct CloseExtraEpoch<'info> {
    #[account(mut, seeds = [SEED_EXTRA_STATE], bump = extra_state.bump)]
    pub extra_state: Box<Account<'info, ExtraState>>,
    #[account(
        mut, close = rent_payer,
        seeds = [SEED_EXTRA_EPOCH, extra_epoch.id.to_le_bytes().as_ref()], bump = extra_epoch.bump
    )]
    pub extra_epoch: Box<Account<'info, ExtraEpoch>>,
    /// CHECK: the oracle key that paid the rent at publish
    #[account(mut, address = extra_epoch.rent_payer @ ForgeError::WrongRentPayer)]
    pub rent_payer: UncheckedAccount<'info>,
}

pub fn close_extra_epoch(ctx: Context<CloseExtraEpoch>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let returned = extra_close_core(&mut ctx.accounts.extra_state, &mut ctx.accounts.extra_epoch, now)?;
    emit!(ExtraEpochClosed { epoch: ctx.accounts.extra_epoch.id, returned });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Unit tests (SPEC-UPGRADE-v2 §8.1 "extra")
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod extra_tests {
    use super::*;
    use crate::instructions::seat::seat_tests::extra as extra_epoch;

    const D: i64 = CLAIM_HOLD / 2; // one day (DAY is private to constants.rs)

    fn state(accounted: u64, backing: u64) -> ExtraState {
        ExtraState {
            last_epoch: 0, last_publish_ts: 0, accounted, reserved: 0, free_after: 0, live_forged_backing: backing,
            out_since_publish: 0, total_in: accounted, total_paid: 0, total_returned: 0, vault_bump: 255, bump: 255,
        }
    }

    fn code(r: Result<impl Sized>) -> Option<u32> {
        match r {
            Err(Error::AnchorError(e)) => Some(e.error_code_number),
            _ => None,
        }
    }

    fn c(e: ForgeError) -> Option<u32> {
        Some(e as u32 + anchor_lang::error::ERROR_CODE_OFFSET)
    }

    #[test]
    fn extra_pdas() {
        let (v, b) = Pubkey::find_program_address(&[SEED_EXTRA_VAULT], &crate::ID);
        assert_eq!((v.to_string().as_str(), b), ("GRGxMQDjNg4DwoL69y2p1x14fSzeaKeCHVLkAb67Z9d2", 255));
        let (s, b) = Pubkey::find_program_address(&[SEED_EXTRA_STATE], &crate::ID);
        assert_eq!((s.to_string().as_str(), b), ("FF4CHxw1XgCMYv9Q48yB8qX4W19oDcGK2wrqZhEEvYrE", 255));
    }

    /// bound = min(8% free, 4% backing) incl. 0 after a mass exit; out_since_publish counts until the next publish.
    #[test]
    fn extra_bound_table() {
        // pot 100, backing 1,000 → min(8, 40) = 8
        assert_eq!(extra_bound(&state(100 * XNT, 1_000 * XNT), 1).unwrap(), (100 * XNT, 8 * XNT));
        // pot 100, backing 50 → min(8, 2) = 2
        assert_eq!(extra_bound(&state(100 * XNT, 50 * XNT), 1).unwrap().1, 2 * XNT);
        // mass exit: every forged Artifact recycled and one publish later → 0
        let mut x = state(100 * XNT, 0);
        x.out_since_publish = 50 * XNT;
        assert_eq!(extra_bound(&x, 1).unwrap().1, 2 * XNT); // the week of the exit still counts what left
        extra_publish_core(&mut x, 1, 1, 0, 0, 1, 1, 10 * D).unwrap();
        assert_eq!(x.out_since_publish, 0);
        assert_eq!(extra_bound(&x, 1).unwrap().1, 0);
        // reserved budgets are not free
        let mut x = state(100 * XNT, 1_000 * XNT);
        x.reserved = 50 * XNT;
        assert_eq!(extra_bound(&x, 1).unwrap(), (50 * XNT, 4 * XNT));
    }

    #[test]
    fn publish_order_heartbeats_and_bound() {
        let mut x = state(100 * XNT, 1_000 * XNT);
        let t0 = 100 * D;
        // id must follow the last extra epoch and not run ahead of the base epochs
        assert_eq!(code(extra_publish_core(&mut x, 3, 2, 0, 0, 1, 1, t0)), c(ForgeError::ExtraEpochOrder));
        assert_eq!(code(extra_publish_core(&mut x, 0, 1, 0, 0, 1, 1, t0)), c(ForgeError::ExtraEpochOrder));
        // above the bound
        assert_eq!(code(extra_publish_core(&mut x, 3, 1, 8 * XNT + 1, 10, 1, 1, t0)), c(ForgeError::ExtraBudgetExceeded));
        // shape
        assert_eq!(code(extra_publish_core(&mut x, 3, 1, XNT, 0, 1, 1, t0)), c(ForgeError::EmptyEpoch));
        assert_eq!(code(extra_publish_core(&mut x, 3, 1, XNT, EXTRA_MAX_LEAVES + 1, 1, 1, t0)), c(ForgeError::InvalidProof));
        // a real epoch at the bound
        let (free, after) = extra_publish_core(&mut x, 3, 1, 8 * XNT, EXTRA_MAX_LEAVES, 1, 1, t0).unwrap();
        assert_eq!((free, after, x.reserved, x.last_epoch, x.last_publish_ts), (100 * XNT, 92 * XNT, 8 * XNT, 1, t0));
        // X-3: heartbeats need no interval and catch up in one run
        extra_publish_core(&mut x, 3, 2, 0, 0, 1, 1, t0 + 1).unwrap();
        extra_publish_core(&mut x, 3, 3, 0, 0, 1, 1, t0 + 2).unwrap();
        assert_eq!(x.last_publish_ts, t0);
        // ... but real extras stay 6 days apart
        x.live_forged_backing = 1_000 * XNT;
        assert_eq!(code(extra_publish_core(&mut x, 4, 4, XNT, 1, 1, 1, t0 + MIN_EPOCH_INTERVAL - 1)), c(ForgeError::ExtraEpochOrder));
        extra_publish_core(&mut x, 4, 4, XNT, 1, 1, 1, t0 + MIN_EPOCH_INTERVAL).unwrap();
    }

    #[test]
    fn leaf_vector_and_bitmap() {
        let wallet = Pubkey::new_from_array([2; 32]);
        let leaf = extra_leaf(7, 3, &wallet, 123_456_789);
        let mut pre = LEAF_DOMAIN_EXTRA.to_vec();
        pre.extend_from_slice(&7u64.to_le_bytes());
        pre.extend_from_slice(&3u32.to_le_bytes());
        pre.extend_from_slice(&[2u8; 32]);
        pre.extend_from_slice(&123_456_789u64.to_le_bytes());
        assert_eq!(pre.len(), 18 + 8 + 4 + 32 + 8);
        assert_eq!(leaf, keccak(&[&pre]));
        // recorded in spec-vectors-v2.out.json at S1 (printed for the record)
        println!("extra leaf vector: {}", leaf.iter().map(|b| format!("{b:02x}")).collect::<String>());

        let mut bm = [0u8; EXTRA_BITMAP_BYTES];
        for i in [0u32, 7, 8, 999] {
            assert!(!bit_is_set(&bm, i));
            bit_set(&mut bm, i);
            assert!(bit_is_set(&bm, i));
        }
        assert_eq!(bm[0], 0b1000_0001);
        assert_eq!(bm[1], 0b0000_0001);
        assert_eq!(bm[124], 0b1000_0000);
        assert_eq!(bm.iter().map(|b| b.count_ones()).sum::<u32>(), 4);
    }

    /// X-1: leaves summing to 2× the published total pay at most `budget`; the next claim is BudgetExhausted;
    /// accounted / reserved never underflow.
    #[test]
    fn claim_bounded_by_budget() {
        let t0 = 100 * D;
        let mut x = state(100 * XNT, 1_000 * XNT);
        extra_publish_core(&mut x, 1, 1, 4 * XNT, 4, 1, 1, t0).unwrap();
        let mut e = extra_epoch(1, t0, 4 * XNT);
        e.leaves = 4;
        // hold
        assert_eq!(code(extra_claim_gate(&e, 0, t0 + CLAIM_HOLD - 1)), c(ForgeError::ClaimOnHold));
        let now = t0 + CLAIM_HOLD;
        // each leaf claims 2 XNT: 4 leaves = 8 XNT against a 4-XNT total
        for i in 0..2u32 {
            extra_claim_gate(&e, i, now).unwrap();
            extra_claim_book(&mut x, &mut e, i, 2 * XNT).unwrap();
        }
        assert_eq!(code(extra_claim_gate(&e, 1, now)), c(ForgeError::ExtraAlreadyClaimed));
        extra_claim_gate(&e, 2, now).unwrap();
        assert_eq!(code(extra_claim_book(&mut x, &mut e, 2, 2 * XNT)), c(ForgeError::BudgetExhausted));
        assert!(!bit_is_set(&e.bitmap, 2)); // a refused claim sets nothing
        assert_eq!(code(extra_claim_gate(&e, 4, now)), c(ForgeError::InvalidProof)); // index ≥ leaves
        assert_eq!((e.claimed, x.reserved, x.accounted, x.total_paid), (4 * XNT, 0, 96 * XNT, 4 * XNT));
        // window
        assert_eq!(code(extra_claim_gate(&e, 3, t0 + CLAIM_WINDOW)), c(ForgeError::ExtraClaimWindow));
        // close: nothing left to return; a second close is impossible (account closed) and a voided epoch returns 0
        assert_eq!(code(extra_close_core(&mut x, &mut e, t0 + CLAIM_WINDOW - 1)), c(ForgeError::ExtraClaimWindow));
        assert_eq!(extra_close_core(&mut x, &mut e, t0 + CLAIM_WINDOW).unwrap(), 0);
    }

    #[test]
    fn void_and_close_return_to_the_pot_once() {
        let t0 = 100 * D;
        let mut x = state(100 * XNT, 1_000 * XNT);
        extra_publish_core(&mut x, 1, 1, 5 * XNT, 3, 1, 1, t0).unwrap();
        let mut e = extra_epoch(1, t0, 5 * XNT);
        assert_eq!(extra_void_core(&mut x, &mut e, t0 + 1).unwrap(), 5 * XNT);
        assert_eq!((x.reserved, x.total_returned, x.accounted), (0, 5 * XNT, 100 * XNT));
        assert_eq!(code(extra_void_core(&mut x, &mut e, t0 + 2)), c(ForgeError::EpochClosed));
        assert_eq!(code(extra_claim_gate(&e, 0, t0 + CLAIM_HOLD)), c(ForgeError::ExtraClaimWindow));
        // the voided epoch closes after 90 days with returned 0 (never released twice)
        assert_eq!(extra_close_core(&mut x, &mut e, t0 + CLAIM_WINDOW).unwrap(), 0);
        assert_eq!(x.total_returned, 5 * XNT);
        // hold over → HoldOver
        let mut e2 = extra_epoch(2, t0, 0);
        assert_eq!(code(extra_void_core(&mut x, &mut e2, t0 + CLAIM_HOLD)), c(ForgeError::HoldOver));
        // heartbeat void returns 0
        assert_eq!(extra_void_core(&mut x, &mut e2, t0 + 1).unwrap(), 0);
        // an unclaimed epoch returns budget − claimed after 90 days
        x.last_epoch = 2;
        let t3 = t0 + MIN_EPOCH_INTERVAL; // real extras stay 6 days apart
        extra_publish_core(&mut x, 3, 3, 4 * XNT, 2, 1, 1, t3).unwrap();
        let mut e3 = extra_epoch(3, t3, 4 * XNT);
        e3.leaves = 2;
        extra_claim_book(&mut x, &mut e3, 0, XNT).unwrap();
        assert_eq!(extra_close_core(&mut x, &mut e3, t3 + CLAIM_WINDOW).unwrap(), 3 * XNT);
        assert_eq!(x.reserved, 0);
    }

    /// Escrow-exit property of the pot: over random publish / claim / void / close sequences every reserved lamport
    /// leaves the reservation exactly once (to a claimant, or back to the free pot), the counters never underflow,
    /// the vault always covers rent + accounted (stray lamports only add), and once every epoch is closed nothing
    /// stays reserved: accounted == total_in − total_paid and free == accounted.
    #[test]
    fn extra_escrow_exit_property() {
        let rent = 946_560u64; // any constant: the vault's rent never moves
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut rnd = |m: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % m.max(1)
        };
        for _world in 0..200 {
            let mut x = state(0, 0);
            x.total_in = 0;
            let mut vault = rent;
            let mut epochs: Vec<ExtraEpoch> = Vec::new();
            let mut now = 1_000 * D;
            let mut base_last = 0u64;
            for _step in 0..120 {
                match rnd(6) {
                    0 => {
                        // a forge: 25% of the price in, 50% backing live
                        let price = (1 + rnd(200)) * XNT / 10;
                        let to_extra = price / 4;
                        x.accounted += to_extra;
                        x.total_in += to_extra;
                        x.live_forged_backing += price / 2;
                        vault += to_extra;
                    }
                    1 => {
                        // a recycle of some backing
                        let out = rnd(x.live_forged_backing + 1);
                        x.live_forged_backing -= out;
                        x.out_since_publish += out;
                    }
                    2 => {
                        // a publish (heartbeat or real, up to the bound)
                        base_last += 1;
                        let id = x.last_epoch + 1;
                        let (_, bound) = extra_bound(&x, 1).unwrap();
                        let total = if rnd(3) == 0 { 0 } else { rnd(bound + 1) };
                        let leaves = if total == 0 { 0 } else { 1 + rnd(EXTRA_MAX_LEAVES as u64) as u32 };
                        if extra_publish_core(&mut x, base_last, id, total, leaves, 1, 1, now).is_ok() {
                            let mut e = extra_epoch(id, now, total);
                            e.leaves = leaves;
                            epochs.push(e);
                        }
                    }
                    3 => {
                        // claims on a random epoch (leaves may over-sum: the budget bounds them)
                        if let Some(e) = epochs.last_mut() {
                            let i = rnd(e.leaves.max(1) as u64) as u32;
                            let amount = rnd(e.budget / 2 + 2);
                            if extra_claim_gate(e, i, now).is_ok() && extra_claim_book(&mut x, e, i, amount).is_ok() {
                                vault -= amount;
                            }
                        }
                    }
                    4 => {
                        // a void during the hold
                        if let Some(e) = epochs.last_mut() {
                            let _ = extra_void_core(&mut x, e, now);
                        }
                    }
                    _ => {
                        // stray lamports: ignored by every bound
                        vault += rnd(XNT);
                    }
                }
                now += rnd(2 * D as u64) as i64;
                assert!(x.reserved <= x.accounted);
                assert!(vault >= rent + x.accounted);
                let open: u64 = epochs.iter().filter(|e| !e.closed).map(|e| e.budget - e.claimed).sum();
                assert_eq!(open, x.reserved);
            }
            // everything expires and closes: nothing stays reserved
            now += CLAIM_WINDOW;
            for e in epochs.iter_mut() {
                extra_close_core(&mut x, e, now).unwrap();
            }
            assert_eq!(x.reserved, 0);
            assert_eq!(x.accounted, x.total_in - x.total_paid);
            assert_eq!(extra_bound(&x, 1).unwrap().0, x.accounted);
            let budgets: u64 = epochs.iter().map(|e| e.budget).sum();
            assert_eq!(budgets, x.total_paid + x.total_returned);
        }
    }

    // ── A13.3 (W2-3): `weeks` scales the backing bound, checked against the base epochs' published_at gap ──

    /// A 1-week window keeps the 1-week bound; a total above it, or weeks above the window, is refused.
    #[test]
    fn weeks_one_week_window() {
        let t_prev = 100 * D;
        let t_base = t_prev + 7 * D;
        let max = extra_weeks_max(t_base, Some(t_prev));
        assert_eq!(max, 1);
        // pot 1,000 XNT, backing 100 XNT: R = 80, one week of backing bound = 4
        let x = state(1_000 * XNT, 100 * XNT);
        assert_eq!(extra_bound(&x, 1).unwrap(), (1_000 * XNT, 4 * XNT));
        assert_eq!(code(extra_publish_core(&mut x.clone(), 1, 1, 4 * XNT + 1, 3, 1, max, t_base)), c(ForgeError::ExtraBudgetExceeded));
        assert_eq!(code(extra_publish_core(&mut x.clone(), 1, 1, 4 * XNT, 3, 2, max, t_base)), c(ForgeError::BadEpochWindow));
        let mut y = x.clone();
        let (free, after) = extra_publish_core(&mut y, 1, 1, 4 * XNT, 3, 1, max, t_base).unwrap();
        assert_eq!((free, after, y.reserved), (1_000 * XNT, 996 * XNT, 4 * XNT));
    }

    /// The W2-3 case: a skipped week (14-day window, or 14 days minus the 6-h publication lag) is bound by two weeks
    /// of backing, so the oracle's 8-XNT file, refused by the old 1-week bound, publishes. The release term (8% of
    /// free) is never scaled.
    #[test]
    fn weeks_two_week_window() {
        let t_prev = 100 * D;
        // the 6-h edge of the oracle's needWeeksOf: 14 d − 6 h → 2, one second less → 1; 13 days → 1
        assert_eq!(extra_weeks_max(t_prev + 2 * EXTRA_WEEK - EXTRA_WEEK_SLACK, Some(t_prev)), 2);
        assert_eq!(extra_weeks_max(t_prev + 2 * EXTRA_WEEK - EXTRA_WEEK_SLACK - 1, Some(t_prev)), 1);
        assert_eq!(extra_weeks_max(t_prev + 13 * D, Some(t_prev)), 1);
        assert_eq!(extra_weeks_max(t_prev + 21 * D, Some(t_prev)), 3);
        let t_base = t_prev + 14 * D;
        let max = extra_weeks_max(t_base, Some(t_prev));
        assert_eq!(max, 2);
        let x = state(1_000 * XNT, 100 * XNT);
        // with the 1-week bound (the program before A13.3) the oracle's 2-week file is refused
        assert_eq!(code(extra_publish_core(&mut x.clone(), 1, 1, 8 * XNT, 3, 1, max, t_base)), c(ForgeError::ExtraBudgetExceeded));
        let mut y = x.clone();
        let (free, after) = extra_publish_core(&mut y, 1, 1, 8 * XNT, 3, 2, max, t_base).unwrap();
        assert_eq!((free, after, y.reserved, y.last_epoch, y.last_publish_ts), (1_000 * XNT, 992 * XNT, 8 * XNT, 1, t_base));
        assert_eq!(code(extra_publish_core(&mut x.clone(), 1, 1, 8 * XNT + 1, 3, 2, max, t_base)), c(ForgeError::ExtraBudgetExceeded));
        // ONE release per publication whatever the window: pot 50 (R = 4), backing 1,000 → 4 for 1 and for 2 weeks
        let small = state(50 * XNT, 1_000 * XNT);
        assert_eq!(extra_bound(&small, 1).unwrap().1, 4 * XNT);
        assert_eq!(extra_bound(&small, 2).unwrap().1, 4 * XNT);
        assert_eq!(code(extra_publish_core(&mut small.clone(), 1, 1, 4 * XNT + 1, 3, 2, max, t_base)), c(ForgeError::ExtraBudgetExceeded));
        // floor per week, then multiplied (the oracle's backingBoundOf): backing 1 lamport short of 25 XNT
        let odd = state(1_000 * XNT, 25 * XNT - 1);
        assert_eq!(extra_bound(&odd, 2).unwrap().1, 2 * ((25 * XNT - 1) * 400 / 10_000));
    }

    /// An over-claimed window is refused whatever the total (BadEpochWindow), heartbeats included: weeks 0, weeks above
    /// the base epochs' gap, above EXTRA_MAX_WEEKS, or above 1 for epoch 1 (no predecessor). A refused publication
    /// writes nothing.
    #[test]
    fn weeks_over_claimed_refused() {
        let t_prev = 100 * D;
        let t_base = t_prev + 14 * D;
        let max = extra_weeks_max(t_base, Some(t_prev));
        let x = state(1_000 * XNT, 100 * XNT);
        for (weeks, total, leaves) in [(0u8, XNT, 1u32), (0, 0, 0), (3, XNT, 1), (3, 0, 0), (u8::MAX, XNT, 1)] {
            let mut y = x.clone();
            assert_eq!(
                code(extra_publish_core(&mut y, 1, 1, total, leaves, weeks, max, t_base)),
                c(ForgeError::BadEpochWindow),
                "weeks {weeks} total {total}"
            );
            assert_eq!((y.last_epoch, y.reserved, y.last_publish_ts, y.free_after), (0, 0, 0, 0));
        }
        // a total that fits one week does not excuse an over-claimed week count
        assert_eq!(code(extra_publish_core(&mut x.clone(), 1, 1, XNT, 1, 3, max, t_base)), c(ForgeError::BadEpochWindow));
        // epoch 1 has no predecessor: 1 week only
        assert_eq!(extra_weeks_max(t_base, None), 1);
        assert_eq!(code(extra_publish_core(&mut x.clone(), 1, 1, XNT, 1, 2, 1, t_base)), c(ForgeError::BadEpochWindow));
        // the cap: a 40-week silence carries EXTRA_MAX_WEEKS, never more
        let m = extra_weeks_max(t_prev + 40 * EXTRA_WEEK, Some(t_prev));
        assert_eq!(m, EXTRA_MAX_WEEKS);
        assert_eq!(extra_weeks_max(i64::MAX, Some(i64::MIN)), EXTRA_MAX_WEEKS); // saturating
        assert_eq!(extra_weeks_max(t_prev, Some(t_base)), 1); // timestamps out of order: never below 1
        assert_eq!(code(extra_publish_core(&mut x.clone(), 1, 1, XNT, 1, EXTRA_MAX_WEEKS + 1, m, t_base)), c(ForgeError::BadEpochWindow));
        extra_publish_core(&mut x.clone(), 1, 1, XNT, 1, EXTRA_MAX_WEEKS, m, t_base).unwrap();
    }

    /// The program never accepts more than the oracle formula allows and never refuses what the oracle legitimately
    /// produces. Over random windows [published_at(id − 1), snapshot], published up to 6 h after the snapshot: the
    /// oracle's k = max(1, ⌊(len + 6 h)/1 week⌋) (clamped to the cap) is within 1 ..= extra_weeks_max (equal when the
    /// publication is immediate), the bound is exactly min(⌊free × 800/10^4⌋, k × ⌊backing × 400/10^4⌋), a file at the
    /// bound publishes and one lamport more is refused.
    #[test]
    fn weeks_match_the_oracle_formula() {
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let mut rnd = |m: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % m.max(1)
        };
        for _ in 0..10_000 {
            let prev = 1_000 * D + rnd(1_000 * D as u64) as i64;
            let len = MIN_EPOCH_INTERVAL - EXTRA_WEEK_SLACK + rnd(100 * D as u64) as i64; // MIN_WINDOW .. ~106 days
            let end = prev + len;
            let published = end + rnd(EXTRA_WEEK_SLACK as u64 + 1) as i64;
            let k = ((len + EXTRA_WEEK_SLACK) / EXTRA_WEEK).clamp(1, EXTRA_MAX_WEEKS as i64) as u8;
            let max = extra_weeks_max(published, Some(prev));
            assert!(k >= 1 && k <= max, "len {len}: oracle k {k}, chain max {max}");
            if published == end {
                assert_eq!(max, k);
            }
            let (free, backing) = (rnd(100_000 * XNT), rnd(100_000 * XNT));
            let x = state(free, backing);
            let want = ((free as u128 * 800 / 10_000) as u64).min(k as u64 * (backing as u128 * 400 / 10_000) as u64);
            assert_eq!(extra_bound(&x, k).unwrap(), (free, want));
            extra_publish_core(&mut x.clone(), 1, 1, want, (want > 0) as u32, k, max, published).unwrap();
            assert_eq!(code(extra_publish_core(&mut x.clone(), 1, 1, want + 1, 1, k, max, published)), c(ForgeError::ExtraBudgetExceeded));
        }
    }

    /// `prev_epoch` is Epoch(id − 1) or the publication fails (BadEpochWindow); ignored for epoch 1.
    #[test]
    fn prev_epoch_account_is_checked() {
        use crate::instructions::seat::epoch_pda;
        use anchor_lang::AccountSerialize;
        let e = crate::instructions::seat::seat_tests::epoch(4, 123 * D, XNT);
        let mut data = Vec::new();
        e.try_serialize(&mut data).unwrap();
        assert_eq!(prev_published_at(5, &epoch_pda(4), &crate::ID, &data).unwrap(), Some(123 * D));
        assert_eq!(code(prev_published_at(5, &epoch_pda(5), &crate::ID, &data)), c(ForgeError::BadEpochWindow)); // Epoch(id)
        assert_eq!(code(prev_published_at(6, &epoch_pda(5), &crate::ID, &data)), c(ForgeError::BadEpochWindow)); // id 4, not 5
        let sys = anchor_lang::system_program::ID;
        assert_eq!(code(prev_published_at(5, &epoch_pda(4), &sys, &data)), c(ForgeError::BadEpochWindow));
        assert_eq!(code(prev_published_at(5, &epoch_pda(4), &sys, &[])), c(ForgeError::BadEpochWindow)); // absent
        assert!(prev_published_at(5, &epoch_pda(4), &crate::ID, &data[..8]).is_err()); // truncated
        assert_eq!(prev_published_at(1, &Pubkey::default(), &sys, &[]).unwrap(), None);
    }
}
