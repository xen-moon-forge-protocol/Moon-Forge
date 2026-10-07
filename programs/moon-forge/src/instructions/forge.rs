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
// Oracle hand-over (two-step). The oracle can rotate itself; nobody else can.
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct OracleOnly<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub signer: Signer<'info>,
}

pub fn propose_oracle(ctx: Context<OracleOnly>, new_oracle: Pubkey) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require_keys_eq!(ctx.accounts.signer.key(), c.oracle, ForgeError::OnlyOracle);
    c.pending_oracle = new_oracle;
    Ok(())
}

pub fn accept_oracle(ctx: Context<OracleOnly>) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require!(c.pending_oracle != Pubkey::default(), ForgeError::NotPendingOracle);
    require_keys_eq!(ctx.accounts.signer.key(), c.pending_oracle, ForgeError::NotPendingOracle);
    c.oracle = c.pending_oracle;
    c.pending_oracle = Pubkey::default();
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// publish_epoch — the ONLY oracle power. Budget is computed on-chain.
// ═══════════════════════════════════════════════════════════════════════════

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
    /// CHECK: reward vault PDA
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
    require!(total_score > 0 && leaves > 0, ForgeError::EmptyEpoch);
    // the per-score cap is mandatory: the oracle cannot switch it off
    require!(rate_cap > 0, ForgeError::EmptyEpoch);

    let free = free_balance(&ctx.accounts.reward_vault, c.reward_reserved)?;
    let mut budget = bps(free, EPOCH_BUDGET_BPS)?;
    let capped = (total_score).saturating_mul(rate_cap as u128);
    if capped < budget as u128 {
        budget = capped as u64;
    }
    require!(budget > 0, ForgeError::PoolEmpty);
    let drop_reserve = bps(budget, DROP_BUDGET_BPS)?.min(MAX_DROPS_PER_EPOCH * DROP_BACKING);
    let drop_slot = Clock::get()?.slot.saturating_add(DROP_SEED_DELAY_SLOTS);

    let e = &mut ctx.accounts.epoch;
    e.id = epoch_id;
    e.root = root;
    e.data_hash = data_hash;
    e.total_score = total_score;
    e.leaves = leaves;
    e.rate_cap = rate_cap;
    e.budget = budget - drop_reserve;
    e.claimed = 0;
    e.claims = 0;
    e.published_at = now;
    e.expires_at = now.saturating_add(CLAIM_WINDOW);
    e.closed = false;
    e.drop_reserve = drop_reserve;
    e.drop_paid = 0;
    e.drops = 0;
    e.drop_slot = drop_slot;
    e.drop_seed = [0u8; 32];
    e.drop_state = if drop_reserve > 0 { DROP_PENDING } else { DROP_NONE };
    e.bump = ctx.bumps.epoch;

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
    // a leaf can never weigh more than the whole epoch (bounds claims AND drops)
    require!((score as u128) <= epoch.total_score, ForgeError::InvalidProof);
    require!(!epoch.closed, ForgeError::EpochClosed);
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

fn grant_claim_chips(ps: &mut PlayerState, amount: u64) -> u64 {
    let chips = amount / CHIP_PER_CLAIMED;
    ps.chips = ps.chips.saturating_add(chips);
    chips
}

/// Pays the keeper tip from the FREE pool (never from the claimed amount) when
/// someone other than the player submits a claim that is not dust.
fn pay_keeper_tip<'info>(
    config: &mut Config,
    reward_vault: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    player: &Pubkey,
    amount: u64,
) -> Result<u64> {
    if payer.key() == *player || amount < KEEPER_TIP_MIN_CLAIM {
        return Ok(0);
    }
    let free = free_balance(reward_vault, config.reward_reserved)?;
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

    // chips for vesting missions are granted as the XNT is actually paid out (withdraw / eject)
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
    ctx.accounts.mission.withdrawn = before.saturating_add(amount);
    // 1 chip per XNT received, counted on the running total so small pushes lose nothing
    let chips = ctx.accounts.mission.withdrawn / CHIP_PER_CLAIMED - before / CHIP_PER_CLAIMED;
    ctx.accounts.player_state.chips = ctx.accounts.player_state.chips.saturating_add(chips);

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
    // chips only on what the pilot really receives (never on the part lost to the penalty)
    let withdrawn = ctx.accounts.mission.withdrawn;
    let chips = withdrawn.saturating_add(paid) / CHIP_PER_CLAIMED - withdrawn / CHIP_PER_CLAIMED;
    ctx.accounts.player_state.chips = ctx.accounts.player_state.chips.saturating_add(chips);
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
