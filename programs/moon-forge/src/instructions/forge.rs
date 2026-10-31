//! Forge: initialization, donations, oracle epochs, burn claims, vesting, ejects.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::constants::*;
use crate::errors::ForgeError;
use crate::events::*;
use crate::state::*;
use crate::utils::*;

// ═══════════════════════════════════════════════════════════════════════════
// initialize_v2 — permissionless, deterministic (all values are constants)
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct InitializeV2<'info> {
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [SEED_CONFIG], bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: lamport vault PDA (exists since v1; created here if missing)
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump)]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: lamport vault PDA (exists since v1; created here if missing)
    #[account(mut, seeds = [SEED_BANKROLL_VAULT], bump)]
    pub bankroll_vault: UncheckedAccount<'info>,
    /// CHECK: lamport vault PDA (new in v2)
    #[account(mut, seeds = [SEED_DRAW_VAULT], bump)]
    pub draw_vault: UncheckedAccount<'info>,
    /// CHECK: Core collection PDA (created later by init_artifacts)
    #[account(seeds = [SEED_COLLECTION], bump)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: collection update-authority PDA (signs Core CPIs, holds nothing)
    #[account(seeds = [SEED_ART_AUTHORITY], bump)]
    pub artifact_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_v2(ctx: Context<InitializeV2>) -> Result<()> {
    let b = &ctx.bumps;
    let sys = ctx.accounts.system_program.to_account_info();
    let payer = ctx.accounts.payer.to_account_info();
    ensure_vault(&ctx.accounts.reward_vault, &payer, &sys, &[SEED_REWARD_VAULT, &[b.reward_vault]], ctx.program_id)?;
    ensure_vault(&ctx.accounts.bankroll_vault, &payer, &sys, &[SEED_BANKROLL_VAULT, &[b.bankroll_vault]], ctx.program_id)?;
    ensure_vault(&ctx.accounts.draw_vault, &payer, &sys, &[SEED_DRAW_VAULT, &[b.draw_vault]], ctx.program_id)?;

    let c = &mut ctx.accounts.config;
    c.version = 2;
    c.bump = b.config;
    c.oracle = INITIAL_ORACLE;
    c.pending_oracle = Pubkey::default();
    c.architect = ARCHITECT;
    c.bumps = [b.reward_vault, b.bankroll_vault, b.draw_vault, b.collection, b.artifact_authority];
    emit!(Initialized { oracle: c.oracle, architect: c.architect });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// donate — 100% to the chosen vault, no fee
// ═══════════════════════════════════════════════════════════════════════════

pub const DONATE_REWARD: u8 = 0;
pub const DONATE_BANKROLL: u8 = 1;
pub const DONATE_DRAW: u8 = 2;

#[derive(Accounts)]
pub struct Donate<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub donor: Signer<'info>,
    /// CHECK: must be one of the three protocol vaults (checked in handler)
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn donate(ctx: Context<Donate>, target: u8, amount: u64) -> Result<()> {
    require!(amount > 0, ForgeError::AmountTooSmall);
    let c = &ctx.accounts.config;
    let (seed, bump): (&[u8], u8) = match target {
        DONATE_REWARD => (SEED_REWARD_VAULT, c.bumps[0]),
        DONATE_BANKROLL => (SEED_BANKROLL_VAULT, c.bumps[1]),
        DONATE_DRAW => (SEED_DRAW_VAULT, c.bumps[2]),
        _ => return err!(ForgeError::InvalidTarget),
    };
    let expected = Pubkey::create_program_address(&[seed, &[bump]], ctx.program_id)
        .map_err(|_| error!(ForgeError::InvalidTarget))?;
    require_keys_eq!(expected, ctx.accounts.vault.key(), ForgeError::InvalidTarget);

    transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer { from: ctx.accounts.donor.to_account_info(), to: ctx.accounts.vault.to_account_info() },
        ),
        amount,
    )?;
    let s = &mut ctx.accounts.config.stats;
    match target {
        DONATE_REWARD => s.donated_reward = s.donated_reward.saturating_add(amount),
        DONATE_BANKROLL => s.donated_bankroll = s.donated_bankroll.saturating_add(amount),
        _ => s.donated_draw = s.donated_draw.saturating_add(amount),
    }
    emit!(Donated { donor: ctx.accounts.donor.key(), target, amount });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Oracle hand-over (two-step). The hot key can rotate itself; the oracle seat's cold key can also rotate it
// (seat.rs rotate_hot) and a dead seat can be taken (seat.rs take_seat). Nobody else can.
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct OracleOnly<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub signer: Signer<'info>,
}

/// Round 4 (review R9, s6-minus-7 MANIFEST §4 item 11): the oracle role never goes to the architect payee, the same
/// rule as rotate_hot / take_seat (hot key ≠ payee) and set_architect (payee ≠ oracle key). Checked at the proposal
/// and again at the acceptance, since set_architect may name the pending key as payee in between.
/// `Pubkey::default()` stays a valid proposal: it cancels a pending hand-over (accept refuses it).
pub(crate) fn oracle_target_ok(new_oracle: &Pubkey, architect: &Pubkey) -> bool {
    new_oracle != architect
}

pub fn propose_oracle(ctx: Context<OracleOnly>, new_oracle: Pubkey) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require_keys_eq!(ctx.accounts.signer.key(), c.oracle, ForgeError::OnlyOracle);
    require!(oracle_target_ok(&new_oracle, &c.architect), ForgeError::InvalidTarget);
    c.pending_oracle = new_oracle;
    emit!(OracleHandoverProposed { oracle: c.oracle, pending_oracle: new_oracle });
    Ok(())
}

pub fn accept_oracle(ctx: Context<OracleOnly>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require!(c.pending_oracle != Pubkey::default(), ForgeError::NotPendingOracle);
    require_keys_eq!(ctx.accounts.signer.key(), c.pending_oracle, ForgeError::NotPendingOracle);
    require!(oracle_target_ok(&c.pending_oracle, &c.architect), ForgeError::InvalidTarget);
    let old = c.oracle;
    c.oracle = c.pending_oracle;
    c.pending_oracle = Pubkey::default();
    emit!(OracleChanged { old_oracle: old, new_oracle: c.oracle, by: 0 });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// publish_epoch — the ONLY oracle power. Budget is computed on-chain.
// ═══════════════════════════════════════════════════════════════════════════

/// The values publish_epoch writes into a new Epoch (after its checks and the on-chain budget).
pub(crate) struct PublishedEpoch {
    pub id: u64,
    pub root: [u8; 32],
    pub data_hash: [u8; 32],
    pub total_score: u128,
    pub leaves: u32,
    pub rate_cap: u64,
    pub budget: u64,
    pub now: i64,
    pub drop_slot: u64,
    pub bump: u8,
}

/// publish_epoch's Epoch write (pure, host-tested). Forge Drops are off for good since the final upgrade (OD-18):
/// every v3 epoch pays its whole budget pro-rata, `drop_reserve = 0` and `drop_state = DROP_NONE` whatever the budget.
/// Returns the drop reserve (always 0) for the EpochPublished event.
pub(crate) fn write_published_epoch(e: &mut Epoch, p: PublishedEpoch) -> u64 {
    let drop_reserve: u64 = 0;
    e.id = p.id;
    e.root = p.root;
    e.data_hash = p.data_hash;
    e.total_score = p.total_score;
    e.leaves = p.leaves;
    e.rate_cap = p.rate_cap;
    e.budget = p.budget - drop_reserve;
    e.claimed = 0;
    e.claims = 0;
    e.published_at = p.now;
    e.expires_at = p.now.saturating_add(CLAIM_WINDOW);
    e.closed = false;
    e.drop_reserve = drop_reserve;
    e.drop_paid = 0;
    e.drops = 0;
    e.drop_slot = p.drop_slot;
    e.drop_seed = [0u8; 32];
    e.drop_state = DROP_NONE;
    e.bump = p.bump;
    drop_reserve
}

/// Round 4, quiet-month seat liveness (s6-minus-7 MANIFEST §4 item 4): the shape of a publication. A HEARTBEAT base
/// epoch pays nothing and has no leaves: total_score = 0, leaves = 0, rate_cap = 0 and an all-zero root (returns true).
/// It is an ordinary publication in every other respect (same instruction, accounts and 108-B data; oracle key only,
/// epoch order, MIN_EPOCH_INTERVAL, the 48-h hold, voidable like any epoch, D-47 inside its bound), so a week with no
/// paying burn no longer silences the seat: a heartbeat that survives its hold keeps it alive (seat.rs walk, unchanged).
/// Anything else with a zero score, zero leaves or a zero rate cap is EmptyEpoch, as before (false = a paying epoch).
pub(crate) fn epoch_shape(root: &[u8; 32], total_score: u128, leaves: u32, rate_cap: u64) -> Result<bool> {
    if total_score == 0 && leaves == 0 && rate_cap == 0 && *root == [0u8; 32] {
        return Ok(true);
    }
    require!(total_score > 0 && leaves > 0, ForgeError::EmptyEpoch);
    // the per-score cap is mandatory: the oracle cannot switch it off
    require!(rate_cap > 0, ForgeError::EmptyEpoch);
    Ok(false)
}

/// The on-chain budget of a publication: min(the 10% bound, total_score × rate_cap) for a paying epoch, which must be
/// > 0 (PoolEmpty); always 0 for a heartbeat, which publishes even from an empty pool (nothing is reserved).
pub(crate) fn epoch_budget(bound: u64, total_score: u128, rate_cap: u64, heartbeat: bool) -> Result<u64> {
    if heartbeat {
        return Ok(0);
    }
    let capped = total_score.saturating_mul(rate_cap as u128);
    let budget = if capped < bound as u128 { capped as u64 } else { bound };
    require!(budget > 0, ForgeError::PoolEmpty);
    Ok(budget)
}

/// D-47 oracle operating allowance (pure, host-tested): what publish_epoch pays the oracle key from the free pool.
/// `bound` = 10% of the free pool before the publication, `budget` = the epoch's budget (computed first, never lowered
/// by this), `rent` = the Epoch account's rent the oracle just paid, `oracle_balance` = the oracle wallet after it paid
/// that rent. The rent comes back, plus a top-up to ORACLE_TOPUP_TARGET of at most ORACLE_TOPUP_MAX; the whole is
/// capped by what the bound leaves after the budget, so `budget + allowance ≤ bound` always, and by a tenth of the
/// bound (ORACLE_ALLOWANCE_BOUND_BPS), so a small pool keeps at least 90% of its bound for the burners.
pub(crate) fn oracle_allowance(bound: u64, budget: u64, rent: u64, oracle_balance: u64) -> u64 {
    // ≤ bound, so the u128 product always fits back in a u64
    let share = ((bound as u128) * (ORACLE_ALLOWANCE_BOUND_BPS as u128) / (BPS as u128)) as u64;
    let room = bound.saturating_sub(budget).min(share);
    let top_up = ORACLE_TOPUP_TARGET.saturating_sub(oracle_balance.saturating_add(rent)).min(ORACLE_TOPUP_MAX);
    rent.saturating_add(top_up).min(room)
}

/// D-47: the allowance is paid only to an oracle key that is not the architect payee (never architect income), and
/// only when the reward vault is writable in the transaction (the client marked it, or another instruction of the
/// same transaction writes it, e.g. a void sent with the publication). The account list and the 108-B data are those
/// of the live binary, whose IDL has the vault read-only: an old client sending publish_epoch alone still publishes
/// (SPEC-UPGRADE-v2 6.2) and simply gets no allowance; the oracle's v3 client marks the vault writable.
pub(crate) fn oracle_allowance_due(vault_writable: bool, oracle: &Pubkey, architect: &Pubkey) -> bool {
    vault_writable && oracle != architect
}

#[derive(Accounts)]
#[instruction(epoch_id: u64)]
pub struct PublishEpoch<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init, payer = oracle, space = 8 + Epoch::INIT_SPACE,
        seeds = [SEED_EPOCH, epoch_id.to_le_bytes().as_ref()], bump
    )]
    pub epoch: Box<Account<'info, Epoch>>,
    /// CHECK: reward vault PDA. Not `mut` in the account constraints, so the live binary's account list (vault
    /// read-only) keeps working; passed writable, it pays the D-47 oracle allowance (oracle_allowance_due).
    #[account(seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub oracle: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn publish_epoch(
    ctx: Context<PublishEpoch>,
    epoch_id: u64,
    root: [u8; 32],
    data_hash: [u8; 32],
    total_score: u128,
    leaves: u32,
    rate_cap: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let c = &mut ctx.accounts.config;
    require_keys_eq!(ctx.accounts.oracle.key(), c.oracle, ForgeError::OnlyOracle);
    require!(epoch_id == c.last_epoch.checked_add(1).ok_or(ForgeError::MathOverflow)?, ForgeError::BadEpochNumber);
    if c.last_epoch > 0 {
        require!(now >= c.last_publish_ts.saturating_add(MIN_EPOCH_INTERVAL), ForgeError::EpochTooSoon);
    }
    // round 4: a heartbeat (no leaves, budget 0) keeps the seat alive through a week without paying burns
    let heartbeat = epoch_shape(&root, total_score, leaves, rate_cap)?;

    let free = free_balance(&ctx.accounts.reward_vault, c.reward_reserved)?;
    let bound = bps(free, EPOCH_BUDGET_BPS)?;
    let budget = epoch_budget(bound, total_score, rate_cap, heartbeat)?;
    let drop_slot = Clock::get()?.slot.saturating_add(DROP_SEED_DELAY_SLOTS);

    // D-47: after the budget, inside the same 10% bound, from the free pool; a running cost booked with the keeper tips
    let oracle_info = ctx.accounts.oracle.to_account_info();
    let allowance = if oracle_allowance_due(ctx.accounts.reward_vault.is_writable, &oracle_info.key(), &c.architect) {
        let rent = rent_min(&ctx.accounts.epoch.to_account_info())?;
        oracle_allowance(bound, budget, rent, oracle_info.lamports())
    } else {
        0
    };
    move_lamports(&ctx.accounts.reward_vault.to_account_info(), &oracle_info, allowance)?;
    c.stats.keeper_tips = c.stats.keeper_tips.saturating_add(allowance);

    let e = &mut ctx.accounts.epoch;
    let drop_reserve = write_published_epoch(
        e,
        PublishedEpoch { id: epoch_id, root, data_hash, total_score, leaves, rate_cap, budget, now, drop_slot, bump: ctx.bumps.epoch },
    );

    c.last_epoch = epoch_id;
    c.last_publish_ts = now;
    c.reward_reserved = c.reward_reserved.checked_add(budget).ok_or(ForgeError::MathOverflow)?;

    emit!(EpochPublished {
        epoch: epoch_id,
        root,
        data_hash,
        total_score,
        leaves,
        budget,
        drop_reserve,
        drop_slot,
        free_pool_before: free,
        oracle_allowance: allowance,
    });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// Claims — PERMISSIONLESS: anyone (a keeper, a friend, the user) can submit the
// claim; the XNT always goes to the player committed in the Merkle leaf.
// leaf = keccak(DOMAIN || epoch u64 LE || player 32 || tier u8 || score u64 LE)
// amount = score * epoch.budget / epoch.total_score   (never above the budget)
// ═══════════════════════════════════════════════════════════════════════════

pub(crate) fn verify_leaf(epoch: &Epoch, player: &Pubkey, tier: u8, score: u64, proof: &[[u8; 32]], now: i64) -> Result<()> {
    require!(tier <= 2, ForgeError::InvalidTier);
    // round 4: a heartbeat epoch (total_score 0) has no leaf to claim; never reaches the division by total_score
    require!(epoch.total_score > 0, ForgeError::EmptyEpoch);
    // a leaf can never weigh more than the whole epoch (bounds claims AND drops)
    require!((score as u128) <= epoch.total_score, ForgeError::InvalidProof);
    require!(!epoch.closed, ForgeError::EpochClosed);
    // 48-h hold (oracle seat, SPEC-UPGRADE-v2 2.7 item 2): the public verifies, and may void, before anything is paid.
    // Gates claim_instant, claim_mission, claim_drop and claim_drop_xnt in one place.
    require!(now >= epoch.published_at.saturating_add(CLAIM_HOLD), ForgeError::ClaimOnHold);
    require!(now < epoch.expires_at, ForgeError::ClaimWindowClosed);
    let leaf = keccak(&[
        LEAF_DOMAIN_FORGE,
        &epoch.id.to_le_bytes(),
        player.as_ref(),
        &[tier],
        &score.to_le_bytes(),
    ]);
    require!(verify_proof(proof, &epoch.root, leaf), ForgeError::InvalidProof);
    Ok(())
}

fn verify_and_book(
    config: &mut Config,
    epoch: &mut Epoch,
    player: &Pubkey,
    tier: u8,
    score: u64,
    proof: &[[u8; 32]],
    now: i64,
) -> Result<u64> {
    verify_leaf(epoch, player, tier, score, proof, now)?;

    let amount = u64::try_from(
        (score as u128)
            .checked_mul(epoch.budget as u128)
            .ok_or(ForgeError::MathOverflow)?
            / epoch.total_score,
    )
    .map_err(|_| error!(ForgeError::MathOverflow))?;
    require!(amount > 0, ForgeError::AmountTooSmall);
    let claimed = epoch.claimed.checked_add(amount).ok_or(ForgeError::MathOverflow)?;
    require!(claimed <= epoch.budget, ForgeError::BudgetExhausted);

    epoch.claimed = claimed;
    epoch.claims = epoch.claims.saturating_add(1);
    config.reward_reserved = config.reward_reserved.checked_sub(amount).ok_or(ForgeError::MathOverflow)?;
    config.stats.forge_paid = config.stats.forge_paid.saturating_add(amount);
    config.stats.forge_claims = config.stats.forge_claims.saturating_add(1);
    Ok(amount)
}

fn init_player_if_new(ps: &mut PlayerState, owner: Pubkey, bump: u8) {
    if ps.owner == Pubkey::default() {
        ps.owner = owner;
        ps.bump = bump;
    }
}

/// Retired since the final upgrade (ECO-3): no claim grants chips; `ForgeClaimed.chips` is always 0 and
/// `PlayerState.chips` is never written. Kept as a function so the 8.1 test pins it.
fn grant_claim_chips(_ps: &mut PlayerState, _amount: u64) -> u64 {
    0
}

/// SPEC 2.11 (SPEC-UPGRADE-v2 S6): a claim earns the keeper tip only when it is not dust (≥ KEEPER_TIP_MIN_CLAIM,
/// 0.2 XNT) and is submitted by someone other than the player and the oracle.
pub(crate) fn keeper_tip_due(payer: &Pubkey, player: &Pubkey, oracle: &Pubkey, amount: u64) -> bool {
    payer != player && payer != oracle && amount >= KEEPER_TIP_MIN_CLAIM
}

/// Pays the keeper tip from the FREE pool (never from the claimed amount) when
/// someone other than the player or the oracle submits a claim that is not dust.
fn pay_keeper_tip<'info>(
    config: &mut Config,
    reward_vault: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    player: &Pubkey,
    amount: u64,
) -> Result<u64> {
    if !keeper_tip_due(&payer.key(), player, &config.oracle, amount) {
        return Ok(0);
    }
    let free = free_balance(reward_vault, config.reward_reserved)?;
    send_keeper_tip(config, reward_vault, payer, free)
}

/// The tip itself: KEEPER_TIP, at most the free pool, booked in stats.keeper_tips (split out for the host tests,
/// which cannot read the Rent sysvar that free_balance needs).
fn send_keeper_tip<'info>(config: &mut Config, reward_vault: &AccountInfo<'info>, payer: &AccountInfo<'info>, free: u64) -> Result<u64> {
    let tip = KEEPER_TIP.min(free);
    move_lamports(reward_vault, payer, tip)?;
    config.stats.keeper_tips = config.stats.keeper_tips.saturating_add(tip);
    Ok(tip)
}

#[derive(Accounts)]
#[instruction(epoch_id: u64, tier: u8)]
pub struct ClaimInstant<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EPOCH, epoch_id.to_le_bytes().as_ref()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(
        init, payer = payer, space = 8 + ClaimReceipt::INIT_SPACE,
        seeds = [SEED_RECEIPT, epoch_id.to_le_bytes().as_ref(), player.key().as_ref(), &[tier]], bump
    )]
    pub receipt: Box<Account<'info, ClaimReceipt>>,
    /// CHECK: beneficiary; authenticated by the Merkle leaf, not by a signature
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    #[account(
        init_if_needed, payer = payer, space = 8 + PlayerState::INIT_SPACE,
        seeds = [SEED_PLAYER, player.key().as_ref()], bump
    )]
    pub player_state: Box<Account<'info, PlayerState>>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Launchpad (tier 0): XNT is paid immediately to the player's wallet.
pub fn claim_instant(ctx: Context<ClaimInstant>, epoch_id: u64, tier: u8, score: u64, proof: Vec<[u8; 32]>) -> Result<()> {
    require!(tier == 0, ForgeError::InvalidTier);
    let now = Clock::get()?.unix_timestamp;
    let player = ctx.accounts.player.key();
    let amount = verify_and_book(&mut ctx.accounts.config, &mut ctx.accounts.epoch, &player, tier, score, &proof, now)?;

    let ps = &mut ctx.accounts.player_state;
    init_player_if_new(ps, player, ctx.bumps.player_state);
    let chips = grant_claim_chips(ps, amount);
    let mut bal = ps.balance;
    pay_wallet_or_balance(
        &ctx.accounts.reward_vault.to_account_info(),
        &ctx.accounts.player.to_account_info(),
        &ctx.accounts.player_state.to_account_info(),
        &mut bal,
        amount,
    )?;
    ctx.accounts.player_state.balance = bal;

    let r = &mut ctx.accounts.receipt;
    r.epoch = epoch_id;
    r.player = player;
    r.tier = tier;
    r.amount = amount;
    r.rent_payer = ctx.accounts.payer.key();
    r.bump = ctx.bumps.receipt;

    let tip = pay_keeper_tip(
        &mut ctx.accounts.config,
        &ctx.accounts.reward_vault.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &player,
        amount,
    )?;
    emit!(ForgeClaimed { epoch: epoch_id, player, tier, score, amount, chips, keeper_tip: tip });
    Ok(())
}

#[derive(Accounts)]
#[instruction(epoch_id: u64, tier: u8)]
pub struct ClaimMission<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EPOCH, epoch_id.to_le_bytes().as_ref()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(
        init, payer = payer, space = 8 + ClaimReceipt::INIT_SPACE,
        seeds = [SEED_RECEIPT, epoch_id.to_le_bytes().as_ref(), player.key().as_ref(), &[tier]], bump
    )]
    pub receipt: Box<Account<'info, ClaimReceipt>>,
    #[account(
        init, payer = payer, space = 8 + Mission::INIT_SPACE,
        seeds = [SEED_MISSION, epoch_id.to_le_bytes().as_ref(), player.key().as_ref(), &[tier]], bump
    )]
    pub mission: Box<Account<'info, Mission>>,
    /// CHECK: beneficiary; authenticated by the Merkle leaf
    pub player: UncheckedAccount<'info>,
    #[account(
        init_if_needed, payer = payer, space = 8 + PlayerState::INIT_SPACE,
        seeds = [SEED_PLAYER, player.key().as_ref()], bump
    )]
    pub player_state: Box<Account<'info, PlayerState>>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Orbit (1) / Moon Landing (2): XNT moves into the player's own Mission PDA and vests linearly.
pub fn claim_mission(ctx: Context<ClaimMission>, epoch_id: u64, tier: u8, score: u64, proof: Vec<[u8; 32]>) -> Result<()> {
    require!(tier == 1 || tier == 2, ForgeError::InvalidTier);
    let now = Clock::get()?.unix_timestamp;
    let player = ctx.accounts.player.key();
    let amount = verify_and_book(&mut ctx.accounts.config, &mut ctx.accounts.epoch, &player, tier, score, &proof, now)?;

    move_lamports(&ctx.accounts.reward_vault.to_account_info(), &ctx.accounts.mission.to_account_info(), amount)?;
    let m = &mut ctx.accounts.mission;
    m.player = player;
    m.epoch = epoch_id;
    m.tier = tier;
    m.total = amount;
    m.withdrawn = 0;
    m.start = now;
    m.end = now.saturating_add(TIER_DURATION[tier as usize]);
    m.rent_payer = ctx.accounts.payer.key();
    m.bump = ctx.bumps.mission;

    // no chips for vesting missions either (ECO-3: withdraw_vested / eject grant none)
    let ps = &mut ctx.accounts.player_state;
    init_player_if_new(ps, player, ctx.bumps.player_state);
    let chips = 0;

    let r = &mut ctx.accounts.receipt;
    r.epoch = epoch_id;
    r.player = player;
    r.tier = tier;
    r.amount = amount;
    r.rent_payer = ctx.accounts.payer.key();
    r.bump = ctx.bumps.receipt;

    let tip = pay_keeper_tip(
        &mut ctx.accounts.config,
        &ctx.accounts.reward_vault.to_account_info(),
        &ctx.accounts.payer.to_account_info(),
        &player,
        amount,
    )?;
    emit!(ForgeClaimed { epoch: epoch_id, player, tier, score, amount, chips, keeper_tip: tip });
    Ok(())
}

fn vested(m: &Mission, now: i64) -> Result<u64> {
    if now >= m.end {
        return Ok(m.total);
    }
    let dur = (m.end - m.start).max(1) as u64;
    let el = (now - m.start).max(0) as u64;
    mul_div(m.total, el, dur)
}

// ═══════════════════════════════════════════════════════════════════════════
// withdraw_vested — PERMISSIONLESS push of already-vested XNT to the player
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct WithdrawVested<'info> {
    #[account(
        mut,
        seeds = [SEED_MISSION, mission.epoch.to_le_bytes().as_ref(), mission.player.as_ref(), &[mission.tier]],
        bump = mission.bump
    )]
    pub mission: Box<Account<'info, Mission>>,
    /// CHECK: must be the mission owner
    #[account(mut, address = mission.player @ ForgeError::WrongPlayer)]
    pub player: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_PLAYER, mission.player.as_ref()], bump = player_state.bump)]
    pub player_state: Box<Account<'info, PlayerState>>,
    /// CHECK: receives the mission rent when the mission completes
    #[account(mut, address = mission.rent_payer @ ForgeError::WrongRentPayer)]
    pub rent_payer: UncheckedAccount<'info>,
}

pub fn withdraw_vested(ctx: Context<WithdrawVested>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let m = &ctx.accounts.mission;
    let v = vested(m, now)?;
    let amount = v.saturating_sub(m.withdrawn);
    require!(amount > 0, ForgeError::NothingVested);
    let (epoch, tier, total) = (m.epoch, m.tier, m.total);

    let mut bal = ctx.accounts.player_state.balance;
    pay_wallet_or_balance(
        &ctx.accounts.mission.to_account_info(),
        &ctx.accounts.player.to_account_info(),
        &ctx.accounts.player_state.to_account_info(),
        &mut bal,
        amount,
    )?;
    ctx.accounts.player_state.balance = bal;
    let before = ctx.accounts.mission.withdrawn;
    ctx.accounts.mission.withdrawn = before.saturating_add(amount); // no chips since the final upgrade (ECO-3)

    emit!(VestedWithdrawn { player: ctx.accounts.player.key(), epoch, tier, amount });
    if ctx.accounts.mission.withdrawn >= total {
        ctx.accounts.mission.close(ctx.accounts.rent_payer.to_account_info())?;
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// eject — leave early. Vested part paid in full; the unvested part pays a
// penalty that goes 100% back to the reward pool.
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct Eject<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut,
        seeds = [SEED_MISSION, mission.epoch.to_le_bytes().as_ref(), mission.player.as_ref(), &[mission.tier]],
        bump = mission.bump,
        constraint = mission.player == player.key() @ ForgeError::WrongPlayer
    )]
    pub mission: Box<Account<'info, Mission>>,
    #[account(mut)]
    pub player: Signer<'info>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: receives the mission rent
    #[account(mut, address = mission.rent_payer @ ForgeError::WrongRentPayer)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_PLAYER, mission.player.as_ref()], bump = player_state.bump)]
    pub player_state: Box<Account<'info, PlayerState>>,
}

pub fn eject(ctx: Context<Eject>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let m = &ctx.accounts.mission;
    let v = vested(m, now)?;
    let vested_unpaid = v.saturating_sub(m.withdrawn);
    let unvested = m.total.saturating_sub(v);
    let penalty = bps(unvested, TIER_PENALTY_BPS[m.tier as usize])?;
    let paid = vested_unpaid + unvested - penalty;
    let (epoch, tier) = (m.epoch, m.tier);

    move_lamports(&ctx.accounts.mission.to_account_info(), &ctx.accounts.reward_vault.to_account_info(), penalty)?;
    move_lamports(&ctx.accounts.mission.to_account_info(), &ctx.accounts.player.to_account_info(), paid)?;
    // no chips since the final upgrade (ECO-3)
    let s = &mut ctx.accounts.config.stats;
    s.penalties_to_pool = s.penalties_to_pool.saturating_add(penalty);

    ctx.accounts.mission.close(ctx.accounts.rent_payer.to_account_info())?;
    emit!(PilotEjected { player: ctx.accounts.player.key(), epoch, tier, paid, penalty_to_pool: penalty });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// expire_epoch — PERMISSIONLESS after the claim window: unclaimed budget is
// released back to the free pool.
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct ExpireEpoch<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EPOCH, epoch.id.to_le_bytes().as_ref()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
}

pub fn expire_epoch(ctx: Context<ExpireEpoch>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let e = &mut ctx.accounts.epoch;
    require!(!e.closed, ForgeError::EpochClosed);
    require!(now >= e.expires_at, ForgeError::ClaimWindowOpen);
    let mut remaining = e.budget.saturating_sub(e.claimed);
    if e.drop_state == DROP_PENDING || e.drop_state == DROP_SEALED {
        // unclaimed drops (if luck paid out more than the reserve, nothing is left to release)
        remaining = remaining.saturating_add(e.drop_reserve.saturating_sub(e.drop_paid));
        if e.drop_state == DROP_PENDING {
            e.drop_state = DROP_CANCELLED;
        }
    }
    e.closed = true;
    let c = &mut ctx.accounts.config;
    c.reward_reserved = c.reward_reserved.saturating_sub(remaining);
    emit!(EpochExpired { epoch: e.id, returned_to_pool: remaining });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseReceipt<'info> {
    #[account(seeds = [SEED_EPOCH, receipt.epoch.to_le_bytes().as_ref()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(
        mut, close = rent_payer,
        seeds = [SEED_RECEIPT, receipt.epoch.to_le_bytes().as_ref(), receipt.player.as_ref(), &[receipt.tier]],
        bump = receipt.bump
    )]
    pub receipt: Box<Account<'info, ClaimReceipt>>,
    /// CHECK: original rent payer
    #[account(mut, address = receipt.rent_payer @ ForgeError::WrongRentPayer)]
    pub rent_payer: UncheckedAccount<'info>,
}

/// Receipts can only be closed once their epoch is closed (no claim is possible anymore).
pub fn close_receipt(ctx: Context<CloseReceipt>) -> Result<()> {
    require!(ctx.accounts.epoch.closed, ForgeError::ClaimWindowOpen);
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// sweep_legacy — moves the lamports of the dead v1 accounts into the reward pool
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct SweepLegacy<'info> {
    /// CHECK: v1 ProtocolState PDA, program-owned
    #[account(mut, seeds = [SEED_LEGACY_STATE], bump)]
    pub legacy_state: UncheckedAccount<'info>,
    /// CHECK: v1 dev escrow PDA, program-owned
    #[account(mut, seeds = [SEED_LEGACY_ESCROW], bump)]
    pub legacy_escrow: UncheckedAccount<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
}

pub fn sweep_legacy(ctx: Context<SweepLegacy>) -> Result<()> {
    for acc in [&ctx.accounts.legacy_state, &ctx.accounts.legacy_escrow] {
        let info = acc.to_account_info();
        if info.owner == ctx.program_id && info.lamports() > 0 {
            // draining all lamports makes the runtime purge the account at the end of the tx
            let l = info.lamports();
            move_lamports(&info, &ctx.accounts.reward_vault.to_account_info(), l)?;
        }
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// set_architect — the architect PAYEE rotates itself (both keys sign) or renounces to the reward pool for good.
// A payee only: no oracle, keeper or seat power (X-025). Read through config.architect everywhere.
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct SetArchitect<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(address = config.architect @ ForgeError::OnlyArchitect)]
    pub architect: Signer<'info>,
    /// CHECK: the new payee. Must sign, unless it is the reward vault PDA (renounce: the dev share goes to the burners' pool for good).
    pub new_architect: UncheckedAccount<'info>,
    /// CHECK: reward vault PDA
    #[account(seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
}

pub fn set_architect(ctx: Context<SetArchitect>, new_architect: Pubkey) -> Result<()> {
    let na = &ctx.accounts.new_architect;
    require_keys_eq!(na.key(), new_architect, ForgeError::InvalidTarget);
    require!(
        architect_target_ok(&new_architect, &ctx.accounts.config.oracle),
        ForgeError::InvalidTarget
    );
    if na.key() != ctx.accounts.reward_vault.key() {
        require!(na.is_signer, ForgeError::Unauthorized);
    }
    let old = ctx.accounts.config.architect;
    ctx.accounts.config.architect = new_architect;
    emit!(ArchitectChanged { old_architect: old, new_architect });
    Ok(())
}

/// A payee is never the default key nor the oracle's hot key.
pub(crate) fn architect_target_ok(new_architect: &Pubkey, oracle: &Pubkey) -> bool {
    *new_architect != Pubkey::default() && new_architect != oracle
}

#[cfg(test)]
mod forge_v3_tests {
    use super::*;
    use crate::instructions::seat::seat_tests::{blank_config, epoch};

    /// SPEC 8.1 / ECO-3: `grant_claim_chips` returns 0 (so `ForgeClaimed.chips == 0`) and never writes
    /// `PlayerState.chips`; withdraw_vested and eject carry no chip arithmetic any more (g3-fixes M3).
    #[test]
    fn claims_grant_no_chips() {
        let mut ps = PlayerState {
            owner: Pubkey::new_unique(),
            balance: 0,
            chips: 7,
            session_key: Pubkey::default(),
            session_expires: 0,
            session_max_stake: 0,
            nonce: 0,
            total_wagered: 0,
            total_won: 0,
            bump: 0,
        };
        for amount in [0u64, 1, XNT - 1, XNT, 1_000 * XNT, u64::MAX] {
            assert_eq!(grant_claim_chips(&mut ps, amount), 0);
        }
        assert_eq!(ps.chips, 7, "legacy chips are left as they were, never increased");
    }

    fn proof_for_single_leaf(e: &Epoch, player: &Pubkey, tier: u8, score: u64) -> (Epoch, Vec<[u8; 32]>) {
        let leaf = keccak(&[LEAF_DOMAIN_FORGE, &e.id.to_le_bytes(), player.as_ref(), &[tier], &score.to_le_bytes()]);
        let mut e2 = e.clone();
        e2.root = leaf; // a one-leaf tree: root == leaf, empty proof
        e2.total_score = score as u128;
        (e2, vec![])
    }

    /// SPEC 2.7 item 2: no claim before published_at + CLAIM_HOLD; then the usual window.
    #[test]
    fn verify_leaf_holds_48h() {
        let player = Pubkey::new_unique();
        let t0 = 100 * (CLAIM_HOLD / 2);
        let (e, proof) = proof_for_single_leaf(&epoch(3, t0, XNT), &player, 0, 7);
        let code = |r: Result<()>| match r {
            Err(Error::AnchorError(a)) => a.error_code_number,
            _ => 0,
        };
        let want = |e: ForgeError| e as u32 + anchor_lang::error::ERROR_CODE_OFFSET;
        assert_eq!(code(verify_leaf(&e, &player, 0, 7, &proof, t0 + CLAIM_HOLD - 1)), want(ForgeError::ClaimOnHold));
        verify_leaf(&e, &player, 0, 7, &proof, t0 + CLAIM_HOLD).unwrap();
        assert_eq!(code(verify_leaf(&e, &player, 0, 7, &proof, e.expires_at)), want(ForgeError::ClaimWindowClosed));
        let mut voided = e.clone();
        voided.closed = true;
        assert_eq!(code(verify_leaf(&voided, &player, 0, 7, &proof, t0 + CLAIM_HOLD)), want(ForgeError::EpochClosed));
    }

    #[test]
    fn architect_targets() {
        let c = blank_config();
        assert!(!architect_target_ok(&Pubkey::default(), &c.oracle));
        assert!(!architect_target_ok(&c.oracle, &c.oracle));
        assert!(architect_target_ok(&Pubkey::new_unique(), &c.oracle));
    }

    /// Round 4 (R9): propose_oracle / accept_oracle refuse the architect payee as the oracle key (InvalidTarget), like
    /// rotate_hot and take_seat; any other key, and the default key (a cancel), are accepted. Together with
    /// architect_target_ok the two roles can never meet in one key through any instruction.
    #[test]
    fn oracle_targets_refuse_the_payee() {
        let c = blank_config();
        assert!(!oracle_target_ok(&c.architect, &c.architect), "the payee never becomes the oracle");
        assert!(oracle_target_ok(&Pubkey::new_unique(), &c.architect));
        assert!(oracle_target_ok(&Pubkey::default(), &c.architect), "a cancel stays possible");
        // the same key refused on both sides of the pair of rules
        let k = Pubkey::new_unique();
        assert!(!architect_target_ok(&k, &k) && !oracle_target_ok(&k, &k));
        // rotate_hot / take_seat (seat.rs) refuse the payee the same way
        let mut c2 = blank_config();
        let seat = crate::instructions::seat::seat_tests::blank_seat(Pubkey::new_unique(), 0);
        let arch = c2.architect;
        assert!(crate::instructions::seat::rotate_hot_core(&mut c2, &seat, &seat.cold, arch).is_err());
        assert!(crate::instructions::seat::take_keys_check(&c2, &arch, &Pubkey::new_unique()).is_err());
    }

    /// SPEC 8.1 / 2.7 item 1 (OD-18): publish_epoch always writes drop_reserve = 0 and drop_state = DROP_NONE, and the
    /// whole budget is the pro-rata budget; property over 10k budgets, written over a dirty account (an `init` account
    /// is zeroed, so this is stricter than the chain).
    #[test]
    fn publish_epoch_always_writes_reserve_0_and_drop_state_none() {
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for i in 0..10_000u64 {
            let budget = match i {
                0 => 1,
                1 => u64::MAX,
                2 => 15 * XNT, // the old binary's drop threshold
                _ => 1 + rnd() % (1_000_000 * XNT),
            };
            let mut e = epoch(9, 0, 0);
            e.drop_reserve = rnd();
            e.drop_paid = rnd();
            e.drops = 7;
            e.drop_seed = [5; 32];
            e.drop_state = DROP_SEALED;
            e.closed = true;
            e.claimed = rnd();
            let now = (rnd() % 4_000_000_000) as i64;
            let p = PublishedEpoch {
                id: i + 1, root: [1; 32], data_hash: [2; 32], total_score: rnd() as u128 + 1, leaves: 3, rate_cap: 4,
                budget, now, drop_slot: rnd() % 1_000_000_000, bump: 254,
            };
            let slot = p.drop_slot;
            assert_eq!(write_published_epoch(&mut e, p), 0);
            assert_eq!((e.drop_reserve, e.drop_state, e.drop_paid, e.drops, e.drop_seed), (0, DROP_NONE, 0, 0, [0; 32]));
            assert_eq!((e.budget, e.claimed, e.claims, e.closed), (budget, 0, 0, false));
            assert_eq!((e.id, e.published_at, e.expires_at, e.drop_slot, e.bump), (i + 1, now, now + CLAIM_WINDOW, slot, 254));
        }
    }

    /// Round 4 heartbeat: exactly the all-zero shape (score, leaves, rate cap, root) is a heartbeat with budget 0, even
    /// from an empty pool; every other zero field is still EmptyEpoch and a paying epoch is unchanged (min of the 10%
    /// bound and score × cap, PoolEmpty at 0). No claim reaches a heartbeat (EmptyEpoch before any proof or division).
    #[test]
    fn heartbeat_shape_budget_and_no_claims() {
        let code = |r: Result<bool>| match r {
            Err(Error::AnchorError(a)) => a.error_code_number - anchor_lang::error::ERROR_CODE_OFFSET,
            Ok(b) => b as u32 + 1_000_000,
            _ => u32::MAX,
        };
        let empty = ForgeError::EmptyEpoch as u32;
        let z = [0u8; 32];
        assert_eq!(code(epoch_shape(&z, 0, 0, 0)), 1_000_001, "the heartbeat");
        assert_eq!(code(epoch_shape(&[1; 32], 7, 3, 4)), 1_000_000, "a paying epoch");
        assert_eq!(code(epoch_shape(&z, 7, 3, 4)), 1_000_000, "a zero root alone is not a heartbeat");
        for (root, score, leaves, cap) in [([1u8; 32], 0u128, 0u32, 0u64), (z, 0, 1, 0), (z, 0, 0, 1), (z, 1, 0, 0), (z, 0, 3, 4), (z, 5, 0, 4), (z, 5, 3, 0)] {
            assert_eq!(code(epoch_shape(&root, score, leaves, cap)), empty, "({score}, {leaves}, {cap}) is EmptyEpoch");
        }
        // budgets: a heartbeat is 0 whatever the pool; a paying epoch keeps min(bound, score × cap) > 0
        for bound in [0u64, 1, 10 * XNT, u64::MAX] {
            assert_eq!(epoch_budget(bound, 0, 0, true).unwrap(), 0);
        }
        assert_eq!(epoch_budget(10 * XNT, 3, 4, false).unwrap(), 12);
        assert_eq!(epoch_budget(10 * XNT, u128::MAX, u64::MAX, false).unwrap(), 10 * XNT);
        let pool_empty = |r: Result<u64>| matches!(r, Err(Error::AnchorError(a)) if a.error_code_number == ForgeError::PoolEmpty as u32 + anchor_lang::error::ERROR_CODE_OFFSET);
        assert!(pool_empty(epoch_budget(0, 3, 4, false)), "a paying epoch still needs a free pool");
        // D-47 inside the heartbeat's bound: the budget is 0, so the allowance is at most a tenth of the bound
        assert_eq!(oracle_allowance(XNT / 10, 0, 2_331_600, 0), XNT / 100);
        assert_eq!(oracle_allowance(10 * XNT, 0, 2_331_600, 0), 2_331_600 + ORACLE_TOPUP_MAX);
        assert_eq!(oracle_allowance(0, 0, 2_331_600, 0), 0, "an empty pool pays nothing");
        // a heartbeat epoch as written by publish_epoch: no claim of any score, with any proof, reaches the division
        let player = Pubkey::new_unique();
        let t0 = 100 * (CLAIM_HOLD / 2);
        let mut hb = epoch(4, t0, 0);
        (hb.total_score, hb.leaves, hb.rate_cap, hb.root) = (0, 0, 0, [0; 32]);
        let want = ForgeError::EmptyEpoch as u32 + anchor_lang::error::ERROR_CODE_OFFSET;
        for score in [0u64, 1, u64::MAX] {
            for proof in [vec![], vec![[0u8; 32]], vec![[7u8; 32]; 3]] {
                let r = verify_leaf(&hb, &player, 0, score, &proof, t0 + CLAIM_HOLD);
                assert!(matches!(r, Err(Error::AnchorError(ref a)) if a.error_code_number == want), "score {score}");
            }
        }
    }

    /// D-47: the Epoch account is 207 bytes (the oracle's EPOCH_RENT mirror, oracle/src/rewards.ts, is its rent).
    #[test]
    fn epoch_account_size_is_pinned() {
        assert_eq!(8 + Epoch::INIT_SPACE, 207);
        assert_eq!((ORACLE_TOPUP_TARGET, ORACLE_TOPUP_MAX, ORACLE_ALLOWANCE_BOUND_BPS), (250_000_000, 50_000_000, 1_000));
    }

    /// D-47 `oracle_allowance`: the rent back plus a top-up to 0.25 XNT of at most 0.05 XNT, never above what the 10%
    /// bound leaves after the budget, nor above a tenth of the bound.
    #[test]
    fn oracle_allowance_cases() {
        let rent = 2_331_600u64; // 207 B at the default rent
        let big = 100 * XNT; // a bound that never binds
        // a dry wallet: rent back + the full 0.05 top-up
        assert_eq!(oracle_allowance(big, XNT, rent, 0), rent + ORACLE_TOPUP_MAX);
        // 0.22 XNT after the refund: topped up to exactly 0.25
        assert_eq!(oracle_allowance(big, XNT, rent, 220_000_000 - rent), rent + 30_000_000);
        // at or above the target: the rent only
        assert_eq!(oracle_allowance(big, XNT, rent, ORACLE_TOPUP_TARGET - rent), rent);
        assert_eq!(oracle_allowance(big, XNT, rent, 10 * XNT), rent);
        // the bound left after the budget caps everything, the rent included; the budget is never touched
        assert_eq!(oracle_allowance(10 * XNT, 10 * XNT - 1_000, rent, 0), 1_000);
        assert_eq!(oracle_allowance(10 * XNT, 10 * XNT, rent, 0), 0);
        assert_eq!(oracle_allowance(10 * XNT, u64::MAX, rent, 0), 0);
        // a small pool (0.1 XNT free, bound 0.01 XNT): a tenth of the bound, below the rent
        assert_eq!(oracle_allowance(XNT / 100, XNT / 1_000, rent, 0), XNT / 1_000);
        // the share binds below a bound of rent + 0.05 XNT times ten (a free pool of about 5.24 XNT), not above it
        let edge = 10 * (rent + ORACLE_TOPUP_MAX);
        assert_eq!(oracle_allowance(edge, XNT / 10, rent, 0), rent + ORACLE_TOPUP_MAX);
        assert_eq!(oracle_allowance(edge - 10, XNT / 10, rent, 0), rent + ORACLE_TOPUP_MAX - 1);
        // extremes do not overflow
        assert_eq!(oracle_allowance(u64::MAX, 0, u64::MAX, u64::MAX), u64::MAX / 10);
        assert_eq!(oracle_allowance(u64::MAX, 0, 0, u64::MAX), 0);
    }

    /// D-47 property over 100k draws: budget + allowance ≤ bound (inside the 10% bound), allowance ≤ rent + 0.05 XNT and
    /// ≤ a tenth of the bound,
    /// the wallet never ends above max(0.25 XNT, its balance + the rent), and the reward vault still covers its rent,
    /// the reserved budgets and this epoch's budget afterwards (B-14 solvency at publication).
    #[test]
    fn oracle_allowance_inside_the_bound_and_solvent() {
        let mut seed = 0xD47_0000_2026_1024u64;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let vault_rent = 890_880u64;
        for _ in 0..100_000 {
            let reserved = rnd() % (1_000 * XNT);
            let free = rnd() % (10_000 * XNT);
            let vault = vault_rent + reserved + free;
            let bound = free / 10; // bps(free, EPOCH_BUDGET_BPS)
            let budget = 1 + rnd() % bound.max(1);
            let budget = budget.min(bound.max(1));
            let rent = 1_000_000 + rnd() % 5_000_000;
            let balance = match rnd() % 4 {
                0 => 0,
                1 => rnd() % ORACLE_TOPUP_TARGET,
                2 => ORACLE_TOPUP_TARGET + rnd() % XNT,
                _ => rnd() % (2 * XNT),
            };
            let a = oracle_allowance(bound, budget, rent, balance);
            assert!(budget > bound || budget + a <= bound, "inside the 10% bound");
            assert!(a <= rent + ORACLE_TOPUP_MAX);
            assert!(a <= bound / 10, "at most a tenth of the bound");
            assert!(balance + a <= ORACLE_TOPUP_TARGET.max(balance + rent));
            if budget <= bound {
                // the vault after the allowance covers rent + every reserved budget + this epoch's budget
                assert!(vault - a >= vault_rent + reserved + budget, "B-14 solvency at publication");
            }
        }
    }

    /// D-47 `oracle_allowance_due`: only with the vault writable and an oracle key that is not the architect payee.
    #[test]
    fn oracle_allowance_due_cases() {
        let (oracle, architect) = (Pubkey::new_unique(), Pubkey::new_unique());
        assert!(oracle_allowance_due(true, &oracle, &architect));
        assert!(!oracle_allowance_due(false, &oracle, &architect), "an old client (vault read-only) publishes with no allowance");
        assert!(!oracle_allowance_due(true, &architect, &architect), "never architect income");
        assert!(!oracle_allowance_due(false, &architect, &architect));
    }

    /// SPEC 2.11 / 8.1 `keeper_tip_due`: a third party at 0.2 XNT → true; the player → false; the oracle → false;
    /// 199,999,999 lamports → false.
    #[test]
    fn keeper_tip_due_cases() {
        let (player, oracle, keeper) = (Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique());
        assert_eq!(KEEPER_TIP_MIN_CLAIM, 200_000_000);
        assert!(keeper_tip_due(&keeper, &player, &oracle, KEEPER_TIP_MIN_CLAIM));
        assert!(keeper_tip_due(&keeper, &player, &oracle, u64::MAX));
        assert!(!keeper_tip_due(&player, &player, &oracle, KEEPER_TIP_MIN_CLAIM));
        assert!(!keeper_tip_due(&oracle, &player, &oracle, KEEPER_TIP_MIN_CLAIM));
        assert!(!keeper_tip_due(&keeper, &player, &oracle, 199_999_999));
        assert!(!keeper_tip_due(&keeper, &player, &oracle, 0));
    }

    /// pay_keeper_tip returns before touching any account unless keeper_tip_due holds (claim ≥ 0.2 XNT, payer neither
    /// the player nor the oracle): nothing moves and stats.keeper_tips is unchanged. A due tip goes on to read the free
    /// pool (Rent: on the host that read fails, which shows the branch is taken) and send_keeper_tip pays KEEPER_TIP,
    /// at most the free pool, and books it.
    #[test]
    fn pay_keeper_tip_only_when_due() {
        let mut c = blank_config();
        let player = Pubkey::new_unique();
        let oracle = c.oracle;
        let keeper = Pubkey::new_unique();
        let vault_key = Pubkey::new_unique();
        let sys = anchor_lang::system_program::ID;
        // (tip or None on error, lamports out of the vault, lamports into the payer)
        let run = |c: &mut Config, payer_key: &Pubkey, amount: Option<u64>, free: u64| -> (Option<u64>, u64, u64) {
            let mut vault_lamports = 100 * XNT;
            let mut payer_lamports = XNT;
            let (mut vd, mut pd) = ([0u8; 8], [0u8; 0]);
            let vault = AccountInfo::new(&vault_key, false, true, &mut vault_lamports, &mut vd, &crate::ID, false, 0);
            let payer = AccountInfo::new(payer_key, true, true, &mut payer_lamports, &mut pd, &sys, false, 0);
            let tip = match amount {
                Some(a) => pay_keeper_tip(c, &vault, &payer, &player, a).ok(),
                None => send_keeper_tip(c, &vault, &payer, free).ok(),
            };
            let (v, p) = (vault.lamports(), payer.lamports());
            (tip, 100 * XNT - v, p - XNT)
        };
        for (who, amount) in [(player, KEEPER_TIP_MIN_CLAIM), (oracle, KEEPER_TIP_MIN_CLAIM), (keeper, KEEPER_TIP_MIN_CLAIM - 1), (keeper, 0)] {
            assert_eq!(run(&mut c, &who, Some(amount), 0), (Some(0), 0, 0), "payer {who} amount {amount}");
        }
        assert_eq!(c.stats.keeper_tips, 0);
        // due: the free-pool read is reached (no Rent sysvar on the host)
        assert_eq!(run(&mut c, &keeper, Some(KEEPER_TIP_MIN_CLAIM), 0), (None, 0, 0));
        // the payment: KEEPER_TIP, or the whole free pool when it is smaller
        assert_eq!(run(&mut c, &keeper, None, 100 * XNT), (Some(KEEPER_TIP), KEEPER_TIP, KEEPER_TIP));
        assert_eq!(run(&mut c, &keeper, None, 1_000), (Some(1_000), 1_000, 1_000));
        assert_eq!(c.stats.keeper_tips, KEEPER_TIP + 1_000);
    }
}
