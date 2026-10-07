//! Forge Drops — random Lunar Dust for burners, paid out of the epoch budget.
//!
//! publish_epoch : 10% of the budget (at most MAX_DROPS_PER_EPOCH floors) becomes the epoch's
//!                 `drop_reserve`, and the epoch commits to a future slot (publish slot + 4).
//! seal_drop     : PERMISSIONLESS. seed = keccak(hash of the first block at or after that slot).
//!                 If nobody seals within the SlotHashes window (~512 slots) the drops are
//!                 cancelled and the reserve returns to the free pool. There is no re-roll, so
//!                 nobody gains anything by waiting for a "better" seed.
//! claim_drop    : PERMISSIONLESS, for any leaf of the epoch.
//!                 value = score × drop_reserve / total_score (the leaf's expected drop value).
//!                 value >= DROP_BACKING → always wins, and the whole value becomes the floor;
//!                 otherwise wins with probability value / DROP_BACKING and the floor is DROP_BACKING.
//!                 The prize is a Lunar Dust Artifact owned by the player: recyclable for its
//!                 floor at any time, +5% burn boost, weekly lottery chips, Duel element.
//! claim_drop_xnt: only while every Lunar Dust slot is alive (sold out): same value, paid in XNT.
//!
//! Bounds: a leaf never weighs more than the epoch (score <= total_score), so one drop is at
//! most the reserve; and an epoch never pays more than reserve + max(reserve, 15 XNT) in drops
//! (luck above that is refused with DropCapReached). Overruns come from the free pool only.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::ForgeError;
use crate::events::*;
use crate::instructions::artifacts::mint_core;
use crate::instructions::forge::verify_leaf;
use crate::state::*;
use crate::utils::*;

#[derive(Accounts)]
pub struct SealDrop<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EPOCH, epoch.id.to_le_bytes().as_ref()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    /// CHECK: SlotHashes sysvar (address checked when read)
    pub slot_hashes: UncheckedAccount<'info>,
}

pub fn seal_drop(ctx: Context<SealDrop>) -> Result<()> {
    let e = &mut ctx.accounts.epoch;
    require!(e.drop_state == DROP_PENDING && !e.closed, ForgeError::DropNotPending);
    match slot_hash_at_or_after(&ctx.accounts.slot_hashes, e.drop_slot)? {
        SlotHashLookup::NotYet => return err!(ForgeError::NotReady),
        SlotHashLookup::Ready(h) => {
            e.drop_seed = keccak(&[b"MOONFORGE_DROP", &h, &e.id.to_le_bytes()]);
            e.drop_state = DROP_SEALED;
        }
        SlotHashLookup::Expired => {
            // no drop can have been paid before sealing, so the whole reserve is released
            e.drop_state = DROP_CANCELLED;
            let c = &mut ctx.accounts.config;
            c.reward_reserved = c.reward_reserved.saturating_sub(e.drop_reserve);
        }
    }
    emit!(DropSealed { epoch: e.id, seed: e.drop_seed, cancelled: e.drop_state == DROP_CANCELLED });
    Ok(())
}

/// (won, floor). Pure function of on-chain data: anyone can recompute every outcome.
pub fn drop_outcome(epoch: &Epoch, player: &Pubkey, tier: u8, score: u64) -> Result<(bool, u64)> {
    let value = u64::try_from(
        (score as u128)
            .checked_mul(epoch.drop_reserve as u128)
            .ok_or(ForgeError::MathOverflow)?
            / epoch.total_score,
    )
    .map_err(|_| error!(ForgeError::MathOverflow))?;
    if value >= DROP_BACKING {
        return Ok((true, value));
    }
    let r = random_u64(&epoch.drop_seed, player.as_ref(), &[tier]) % DROP_BACKING;
    Ok((r < value, DROP_BACKING))
}

/// Verifies the leaf and the win, and books the floor: first against the epoch's reserve, then
/// (only when luck drew more winners than expected) against the free pool.
fn verify_and_book_drop(
    config: &mut Config,
    epoch: &mut Epoch,
    reward_vault: &AccountInfo,
    player: &Pubkey,
    tier: u8,
    score: u64,
    proof: &[[u8; 32]],
) -> Result<u64> {
    require!(epoch.drop_state == DROP_SEALED, ForgeError::DropNotSealed);
    verify_leaf(epoch, player, tier, score, proof, Clock::get()?.unix_timestamp)?;
    let (won, value) = drop_outcome(epoch, player, tier, score)?;
    require!(won, ForgeError::NoDrop);
    let cap = epoch.drop_reserve.saturating_add(epoch.drop_reserve.max(DROP_LUCK_BUFFER));
    require!(epoch.drop_paid.saturating_add(value) <= cap, ForgeError::DropCapReached);

    let from_reserve = value.min(epoch.drop_reserve.saturating_sub(epoch.drop_paid));
    let from_free = value - from_reserve;
    if from_free > 0 {
        require!(free_balance(reward_vault, config.reward_reserved)? >= from_free, ForgeError::PoolEmpty);
    }
    config.reward_reserved = config.reward_reserved.checked_sub(from_reserve).ok_or(ForgeError::MathOverflow)?;
    epoch.drop_paid = epoch.drop_paid.saturating_add(value);
    epoch.drops = epoch.drops.saturating_add(1);
    config.stats.drops = config.stats.drops.saturating_add(1);
    config.stats.drop_paid = config.stats.drop_paid.saturating_add(value);
    Ok(value)
}

/// The pool refunds whoever delivers a drop to someone else (rent of the new accounts).
fn pay_drop_tip(config: &mut Config, reward_vault: &AccountInfo, payer: &AccountInfo, player: &Pubkey) -> Result<u64> {
    if payer.key() == *player {
        return Ok(0);
    }
    let tip = DROP_KEEPER_TIP.min(free_balance(reward_vault, config.reward_reserved)?);
    move_lamports(reward_vault, payer, tip)?;
    config.stats.keeper_tips = config.stats.keeper_tips.saturating_add(tip);
    Ok(tip)
}

#[derive(Accounts)]
#[instruction(epoch_id: u64, tier: u8, serial: u32)]
pub struct ClaimDrop<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EPOCH, epoch_id.to_le_bytes().as_ref()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(
        init, payer = payer, space = 8 + DropReceipt::INIT_SPACE,
        seeds = [SEED_DROP, epoch_id.to_le_bytes().as_ref(), player.key().as_ref(), &[tier]], bump
    )]
    pub receipt: Box<Account<'info, DropReceipt>>,
    /// CHECK: beneficiary; authenticated by the Merkle leaf, not by a signature
    pub player: UncheckedAccount<'info>,
    /// CHECK: new Core asset PDA ["asset", 0, serial]
    #[account(mut, seeds = [SEED_ASSET, &[DROP_TIER], serial.to_le_bytes().as_ref()], bump)]
    pub asset: UncheckedAccount<'info>,
    #[account(
        init, payer = payer, space = 8 + ArtifactRecord::INIT_SPACE,
        seeds = [SEED_ARTIFACT, asset.key().as_ref()], bump
    )]
    pub record: Box<Account<'info, ArtifactRecord>>,
    /// CHECK: collection PDA
    #[account(mut, seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: collection update authority PDA
    #[account(seeds = [SEED_ART_AUTHORITY], bump = config.bumps[4])]
    pub artifact_authority: UncheckedAccount<'info>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Metaplex Core program
    #[account(address = MPL_CORE_ID @ ForgeError::InvalidTarget)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn claim_drop(ctx: Context<ClaimDrop>, epoch_id: u64, tier: u8, serial: u32, score: u64, proof: Vec<[u8; 32]>) -> Result<()> {
    let t = DROP_TIER as usize;
    {
        let c = &ctx.accounts.config;
        require!(c.artifacts_alive[t] < ARTIFACT_SUPPLY[t], ForgeError::SoldOut);
        require!(serial == c.artifacts_minted[t], ForgeError::InvalidTarget);
        require!(*ctx.accounts.collection.owner == MPL_CORE_ID, ForgeError::InvalidTarget);
    }
    let player = ctx.accounts.player.key();
    let vault = ctx.accounts.reward_vault.to_account_info();
    let value = verify_and_book_drop(&mut ctx.accounts.config, &mut ctx.accounts.epoch, &vault, &player, tier, score, &proof)?;
    move_lamports(&vault, &ctx.accounts.record.to_account_info(), value)?;

    mint_core(
        &ctx.accounts.config,
        &ctx.accounts.core_program,
        &ctx.accounts.asset,
        &ctx.accounts.collection,
        &ctx.accounts.artifact_authority,
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.player.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        DROP_TIER,
        serial,
        ctx.bumps.asset,
        value,
        ORIGIN_DROP,
    )?;

    let r = &mut ctx.accounts.record;
    r.asset = ctx.accounts.asset.key();
    r.tier = DROP_TIER;
    r.serial = serial;
    r.backing = value;
    r.origin = ORIGIN_DROP;
    r.forged_at = Clock::get()?.unix_timestamp;
    r.last_chip_week = -1;
    r.bump = ctx.bumps.record;

    let rc = &mut ctx.accounts.receipt;
    rc.epoch = epoch_id;
    rc.player = player;
    rc.tier = tier;
    rc.asset = ctx.accounts.asset.key();
    rc.value = value;
    rc.bump = ctx.bumps.receipt;

    let c = &mut ctx.accounts.config;
    c.artifacts_minted[t] += 1;
    c.artifacts_alive[t] += 1;
    let tip = pay_drop_tip(c, &vault, &ctx.accounts.payer.to_account_info(), &player)?;
    let asset = ctx.accounts.asset.key();
    emit!(ArtifactForged { owner: player, asset, tier: DROP_TIER, serial, price: 0, backing: value, origin: ORIGIN_DROP });
    emit!(DropWon { epoch: epoch_id, player, tier, asset, value, keeper_tip: tip });
    Ok(())
}

#[derive(Accounts)]
#[instruction(epoch_id: u64, tier: u8)]
pub struct ClaimDropXnt<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_EPOCH, epoch_id.to_le_bytes().as_ref()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(
        init, payer = payer, space = 8 + DropReceipt::INIT_SPACE,
        seeds = [SEED_DROP, epoch_id.to_le_bytes().as_ref(), player.key().as_ref(), &[tier]], bump
    )]
    pub receipt: Box<Account<'info, DropReceipt>>,
    /// CHECK: beneficiary; authenticated by the Merkle leaf
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

/// Only while all Lunar Dust slots are alive: the drop is paid in XNT instead of an Artifact.
pub fn claim_drop_xnt(ctx: Context<ClaimDropXnt>, epoch_id: u64, tier: u8, score: u64, proof: Vec<[u8; 32]>) -> Result<()> {
    let t = DROP_TIER as usize;
    require!(ctx.accounts.config.artifacts_alive[t] >= ARTIFACT_SUPPLY[t], ForgeError::NotSoldOut);
    let player = ctx.accounts.player.key();
    let vault = ctx.accounts.reward_vault.to_account_info();
    let value = verify_and_book_drop(&mut ctx.accounts.config, &mut ctx.accounts.epoch, &vault, &player, tier, score, &proof)?;

    let ps = &mut ctx.accounts.player_state;
    if ps.owner == Pubkey::default() {
        ps.owner = player;
        ps.bump = ctx.bumps.player_state;
    }
    let mut bal = ps.balance;
    pay_wallet_or_balance(
        &vault,
        &ctx.accounts.player.to_account_info(),
        &ctx.accounts.player_state.to_account_info(),
        &mut bal,
        value,
    )?;
    ctx.accounts.player_state.balance = bal;

    let rc = &mut ctx.accounts.receipt;
    rc.epoch = epoch_id;
    rc.player = player;
    rc.tier = tier;
    rc.asset = Pubkey::default();
    rc.value = value;
    rc.bump = ctx.bumps.receipt;

    let tip = pay_drop_tip(&mut ctx.accounts.config, &vault, &ctx.accounts.payer.to_account_info(), &player)?;
    emit!(DropWon { epoch: epoch_id, player, tier, asset: Pubkey::default(), value, keeper_tip: tip });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn epoch(total_score: u128, drop_reserve: u64, seed: u8) -> Epoch {
        Epoch {
            id: 1,
            root: [0; 32],
            data_hash: [0; 32],
            total_score,
            leaves: 0,
            rate_cap: 0,
            budget: 0,
            claimed: 0,
            claims: 0,
            published_at: 0,
            expires_at: 0,
            closed: false,
            drop_reserve,
            drop_paid: 0,
            drops: 0,
            drop_slot: 0,
            drop_seed: [seed; 32],
            drop_state: DROP_SEALED,
            bump: 0,
        }
    }

    #[test]
    fn backing_is_the_lunar_dust_floor() {
        assert_eq!(DROP_BACKING, 5 * XNT);
    }

    #[test]
    fn big_leaf_always_wins_its_full_value() {
        let e = epoch(1_000, 20 * XNT, 1);
        let (won, floor) = drop_outcome(&e, &Pubkey::new_unique(), 0, 600).unwrap();
        assert!(won);
        assert_eq!(floor, 12 * XNT);
    }

    /// Splitting one burn into many wallets must not change the expected drop value.
    #[test]
    fn expected_value_is_linear_in_the_score() {
        // 20,000 leaves of score 50 (total 1e6): value per leaf = reserve / 20,000.
        // 10,000 XNT → 0.5 XNT per leaf → 10% chance of a 5 XNT floor; 50,000 XNT → 50%.
        for (reserve, chance) in [(10_000 * XNT, 0.10), (50_000 * XNT, 0.50)] {
            let e = epoch(1_000_000, reserve, 7);
            let (leaves, score) = (20_000u64, 50u64);
            let (mut paid, mut wins): (u128, u64) = (0, 0);
            for i in 0..leaves {
                let mut key = [0u8; 32];
                key[..8].copy_from_slice(&i.to_le_bytes());
                let (won, floor) = drop_outcome(&e, &Pubkey::new_from_array(key), 0, score).unwrap();
                if won {
                    paid += floor as u128;
                    wins += 1;
                }
            }
            let ratio = paid as f64 / reserve as f64;
            let freq = wins as f64 / leaves as f64;
            assert!((0.95..1.05).contains(&ratio), "paid/reserve = {ratio}");
            assert!((freq - chance).abs() < chance * 0.05, "win frequency {freq} vs {chance}");
        }
    }
}
