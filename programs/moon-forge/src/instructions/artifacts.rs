//! Moon Forge Artifacts — Metaplex Core NFTs with real, recyclable utility.
//!
//! forge   : pay the tier's current price → 50% floor kept inside the NFT record, 40% reward pool,
//!           5% Burn Lottery prize, 5% architect royalty. Supply cap = max ALIVE per tier.
//! price   : Lunar Dust fixed; other tiers +5% per forge, ÷1.05 per full week without a forge,
//!           never below the base price (see constants.rs). `max_price` protects the buyer.
//! recycle : burn the NFT → its floor comes back to the holder, the slot is freed and can be
//!           forged again (the royalty is earned again on every new forge).
//! chips   : each live Artifact grants ARTIFACT_WEEKLY_CHIPS[tier] lottery chips per week.
//! boost   : the oracle applies ARTIFACT_BOOST_BPS[tier] to the holder's burn score.
//! arenas  : any live Artifact is the ticket to Artifact Duel and Moon Wars (the duel element is free).
//! airdrop : up to AIRDROP_MAX free Lunar Dust for active X1 wallets (Merkle list, no floor).
//! drops   : burners win random Lunar Dust with a real floor, paid from the epoch budget (drops.rs).

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::constants::*;
use crate::core_cpi::{burn_asset, create_asset, create_collection, live_asset_owner};
use crate::errors::ForgeError;
use crate::events::*;
use crate::state::*;
use crate::utils::*;

const ELEMENT_NAMES: [&str; 4] = ["Lunar", "Cosmic", "Solar", "Void"];

fn xnt_str(lamports: u64) -> String {
    let whole = lamports / XNT;
    let frac = (lamports % XNT) / 10_000_000; // 2 decimals
    if frac == 0 {
        format!("{}", whole)
    } else {
        format!("{}.{:02}", whole, frac)
    }
}

fn attributes(tier: usize, serial: u32, backing: u64, origin: u8) -> Vec<(&'static str, String)> {
    vec![
        ("Tier", TIER_NAMES[tier].to_string()),
        ("Element", ELEMENT_NAMES[tier].to_string()),
        ("Burn Boost", format!("+{}%", ARTIFACT_BOOST_BPS[tier] / 100)),
        ("Weekly Chips", ARTIFACT_WEEKLY_CHIPS[tier].to_string()),
        ("Floor XNT", xnt_str(backing)),
        (
            "Origin",
            match origin {
                ORIGIN_AIRDROP => "Genesis Airdrop",
                ORIGIN_DROP => "Forge Drop",
                _ => "Forged",
            }
            .to_string(),
        ),
        ("Serial", (serial + 1).to_string()),
        ("Recyclable", "Yes".to_string()),
    ]
}

#[derive(Accounts)]
pub struct InitArtifacts<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: Core collection PDA (created by Core, signed by this program)
    #[account(mut, seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: collection update authority PDA
    #[account(seeds = [SEED_ART_AUTHORITY], bump = config.bumps[4])]
    pub artifact_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Metaplex Core program
    #[account(address = MPL_CORE_ID @ ForgeError::InvalidTarget)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// PERMISSIONLESS, once. Creates the "Moon Forge Artifacts" Core collection with a 5%
/// secondary royalty to the architect (immutable: only this program is the authority,
/// and it has no instruction to change it).
pub fn init_artifacts(ctx: Context<InitArtifacts>) -> Result<()> {
    require!(*ctx.accounts.collection.owner != MPL_CORE_ID, ForgeError::InvalidTarget); // once
    let uri = format!("{}collection.json", METADATA_BASE_URI);
    let bump = ctx.accounts.config.bumps[3];
    drain_prefunded(
        &ctx.accounts.collection,
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
        &[SEED_COLLECTION, &[bump]],
    )?;
    create_collection(
        &ctx.accounts.core_program,
        &ctx.accounts.collection,
        &ctx.accounts.artifact_authority,
        &ctx.accounts.payer,
        &ctx.accounts.system_program,
        &uri,
        &[&[SEED_COLLECTION, &[bump]]],
    )
}

#[derive(Accounts)]
#[instruction(tier: u8, serial: u32)]
pub struct ForgeArtifact<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: new Core asset PDA ["asset", tier, serial]
    #[account(mut, seeds = [SEED_ASSET, &[tier], serial.to_le_bytes().as_ref()], bump)]
    pub asset: UncheckedAccount<'info>,
    #[account(
        init, payer = buyer, space = 8 + ArtifactRecord::INIT_SPACE,
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
    /// CHECK: draw vault PDA
    #[account(mut, seeds = [SEED_DRAW_VAULT], bump = config.bumps[2])]
    pub draw_vault: UncheckedAccount<'info>,
    /// CHECK: architect wallet
    #[account(mut, address = config.architect @ ForgeError::InvalidTarget)]
    pub architect: UncheckedAccount<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: Metaplex Core program
    #[account(address = MPL_CORE_ID @ ForgeError::InvalidTarget)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

fn pay<'info>(sys: &AccountInfo<'info>, from: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    transfer(CpiContext::new(sys.clone(), Transfer { from: from.clone(), to: to.clone() }), amount)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn mint_core<'info>(
    config: &Config,
    core_program: &AccountInfo<'info>,
    asset: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    tier: u8,
    serial: u32,
    asset_bump: u8,
    backing: u64,
    origin: u8,
) -> Result<()> {
    let t = tier as usize;
    let name = format!("{} #{}", TIER_NAMES[t], serial + 1);
    let uri = format!("{}{}/{}.json", METADATA_BASE_URI, TIER_SLUGS[t], serial % ARTIFACT_VARIANTS[t]);
    let attrs = attributes(t, serial, backing, origin);
    let serial_le = serial.to_le_bytes();
    let auth_bump = config.bumps[4];
    drain_prefunded(asset, payer, system_program, &[SEED_ASSET, &[tier], serial_le.as_ref(), &[asset_bump]])?;
    create_asset(
        core_program,
        asset,
        collection,
        authority,
        payer,
        owner,
        system_program,
        &name,
        &uri,
        &attrs,
        &[
            &[SEED_ASSET, &[tier], serial_le.as_ref(), &[asset_bump]],
            &[SEED_ART_AUTHORITY, &[auth_bump]],
        ],
    )
}

/// Current forge price of a tier: the price left by the last forge, lowered by ÷1.05 per full
/// PRICE_DECAY_PERIOD since then, never below the base price. Pure function of config + clock.
pub fn current_price(c: &Config, t: usize, now: i64) -> u64 {
    let base = ARTIFACT_PRICE[t];
    if !DYNAMIC_PRICE[t] || c.artifact_price[t] <= base {
        return base;
    }
    let periods = (now.saturating_sub(c.artifact_price_ts[t]).max(0) / PRICE_DECAY_PERIOD) as u64;
    let mut p = c.artifact_price[t];
    for _ in 0..periods.min(1_000) {
        p = (p as u128 * PRICE_STEP_DEN as u128 / PRICE_STEP_NUM as u128) as u64;
        if p <= base {
            return base;
        }
    }
    p
}

/// Price left for the next buyer after a forge at `paid`: +5%, capped at MAX_PRICE_MULTIPLE × base.
pub fn next_price(paid: u64, t: usize) -> u64 {
    let cap = ARTIFACT_PRICE[t].saturating_mul(MAX_PRICE_MULTIPLE);
    ((paid as u128 * PRICE_STEP_NUM as u128 / PRICE_STEP_DEN as u128).min(cap as u128)) as u64
}

pub fn forge_artifact(ctx: Context<ForgeArtifact>, tier: u8, serial: u32, max_price: u64) -> Result<()> {
    require!(tier < 4, ForgeError::InvalidTier);
    let t = tier as usize;
    let now = Clock::get()?.unix_timestamp;
    let c = &ctx.accounts.config;
    require!(serial == c.artifacts_minted[t], ForgeError::InvalidTarget);
    require!(c.artifacts_alive[t] < ARTIFACT_SUPPLY[t], ForgeError::SoldOut);
    require!(*ctx.accounts.collection.owner == MPL_CORE_ID, ForgeError::InvalidTarget);

    let price = current_price(c, t, now);
    require!(price <= max_price, ForgeError::SlippageExceeded);
    let backing = bps(price, FORGE_BACKING_BPS)?;
    let mut to_pool = bps(price, FORGE_POOL_BPS)?;
    let to_draw = bps(price, FORGE_DRAW_BPS)?;
    let mut to_arch = price - backing - to_pool - to_draw;
    if architect_or_pool(&ctx.accounts.architect, &ctx.accounts.reward_vault, to_arch)?.key == ctx.accounts.reward_vault.key {
        to_pool += to_arch;
        to_arch = 0;
    }
    let sys = ctx.accounts.system_program.to_account_info();
    let buyer = ctx.accounts.buyer.to_account_info();
    pay(&sys, &buyer, &ctx.accounts.record.to_account_info(), backing)?;
    pay(&sys, &buyer, &ctx.accounts.reward_vault, to_pool)?;
    pay(&sys, &buyer, &ctx.accounts.draw_vault, to_draw)?;
    pay(&sys, &buyer, &ctx.accounts.architect, to_arch)?;

    mint_core(
        &ctx.accounts.config,
        &ctx.accounts.core_program,
        &ctx.accounts.asset,
        &ctx.accounts.collection,
        &ctx.accounts.artifact_authority,
        &buyer,
        &buyer,
        &sys,
        tier,
        serial,
        ctx.bumps.asset,
        backing,
        ORIGIN_FORGED,
    )?;

    let r = &mut ctx.accounts.record;
    r.asset = ctx.accounts.asset.key();
    r.tier = tier;
    r.serial = serial;
    r.backing = backing;
    r.origin = ORIGIN_FORGED;
    r.forged_at = now;
    r.last_chip_week = -1;
    r.bump = ctx.bumps.record;

    let c = &mut ctx.accounts.config;
    c.artifacts_minted[t] += 1;
    c.artifacts_alive[t] += 1;
    if DYNAMIC_PRICE[t] {
        c.artifact_price[t] = next_price(price, t);
        c.artifact_price_ts[t] = now;
    }
    c.stats.artifact_to_pool = c.stats.artifact_to_pool.saturating_add(to_pool);
    c.stats.to_draw = c.stats.to_draw.saturating_add(to_draw);
    c.stats.to_architect = c.stats.to_architect.saturating_add(to_arch);
    emit!(ArtifactForged { owner: buyer.key(), asset: r.asset, tier, serial, price, backing, origin: ORIGIN_FORGED });
    Ok(())
}

#[derive(Accounts)]
pub struct RecycleArtifact<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: Core asset owned by `owner`
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    #[account(mut, close = owner, seeds = [SEED_ARTIFACT, asset.key().as_ref()], bump = record.bump)]
    pub record: Box<Account<'info, ArtifactRecord>>,
    /// CHECK: collection PDA
    #[account(mut, seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: Metaplex Core program
    #[account(address = MPL_CORE_ID @ ForgeError::InvalidTarget)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Burn the NFT and get its floor back (record lamports = floor + rent).
pub fn recycle_artifact(ctx: Context<RecycleArtifact>) -> Result<()> {
    let holder = live_asset_owner(&ctx.accounts.asset, &ctx.accounts.collection.key()).ok_or(ForgeError::InvalidArtifact)?;
    require_keys_eq!(holder, ctx.accounts.owner.key(), ForgeError::NotArtifactOwner);
    burn_asset(
        &ctx.accounts.core_program,
        &ctx.accounts.asset,
        &ctx.accounts.collection,
        &ctx.accounts.owner.to_account_info(),
        &ctx.accounts.owner.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
    )?;
    let (tier, backing) = (ctx.accounts.record.tier, ctx.accounts.record.backing);
    let c = &mut ctx.accounts.config;
    c.artifacts_alive[tier as usize] = c.artifacts_alive[tier as usize].saturating_sub(1);
    emit!(ArtifactRecycled { owner: holder, asset: ctx.accounts.asset.key(), tier, backing_returned: backing, orphan: false });
    Ok(())
}

#[derive(Accounts)]
pub struct ReclaimOrphan<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: the (no longer existing / burned elsewhere) Core asset
    pub asset: UncheckedAccount<'info>,
    #[account(mut, close = reward_vault, seeds = [SEED_ARTIFACT, asset.key().as_ref()], bump = record.bump)]
    pub record: Box<Account<'info, ArtifactRecord>>,
    /// CHECK: collection PDA
    #[account(seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
}

/// PERMISSIONLESS. If an Artifact was burned outside Moon Forge, its floor would be stuck:
/// this frees the supply slot and sends the floor to the reward pool.
pub fn reclaim_orphan(ctx: Context<ReclaimOrphan>) -> Result<()> {
    require!(live_asset_owner(&ctx.accounts.asset, &ctx.accounts.collection.key()).is_none(), ForgeError::ArtifactAlive);
    let (tier, backing) = (ctx.accounts.record.tier, ctx.accounts.record.backing);
    let c = &mut ctx.accounts.config;
    c.artifacts_alive[tier as usize] = c.artifacts_alive[tier as usize].saturating_sub(1);
    c.stats.artifact_to_pool = c.stats.artifact_to_pool.saturating_add(backing);
    emit!(ArtifactRecycled { owner: Pubkey::default(), asset: ctx.accounts.asset.key(), tier, backing_returned: backing, orphan: true });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimArtifactChips<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: Core asset
    pub asset: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_ARTIFACT, asset.key().as_ref()], bump = record.bump)]
    pub record: Box<Account<'info, ArtifactRecord>>,
    /// CHECK: collection PDA
    #[account(seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
    #[account(
        mut, seeds = [SEED_PLAYER, owner.key().as_ref()], bump = player_state.bump,
        constraint = player_state.owner == owner.key() @ ForgeError::Unauthorized
    )]
    pub player_state: Box<Account<'info, PlayerState>>,
    pub owner: Signer<'info>,
}

/// Once per week per Artifact, the current holder collects its lottery chips.
pub fn claim_artifact_chips(ctx: Context<ClaimArtifactChips>) -> Result<()> {
    let holder = live_asset_owner(&ctx.accounts.asset, &ctx.accounts.collection.key()).ok_or(ForgeError::InvalidArtifact)?;
    require_keys_eq!(holder, ctx.accounts.owner.key(), ForgeError::NotArtifactOwner);
    let week = current_week(Clock::get()?.unix_timestamp);
    let r = &mut ctx.accounts.record;
    require!(r.last_chip_week < week, ForgeError::ChipsAlreadyClaimed);
    r.last_chip_week = week;
    let chips = ARTIFACT_WEEKLY_CHIPS[r.tier as usize];
    let ps = &mut ctx.accounts.player_state;
    ps.chips = ps.chips.saturating_add(chips);
    emit!(ChipsGranted { owner: holder, source: 2, chips });
    Ok(())
}

#[derive(Accounts)]
pub struct SetAirdropRoot<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(address = ARCHITECT @ ForgeError::OnlyArchitect)]
    pub architect: Signer<'info>,
}

/// The only architect action in the whole program: publish the airdrop list, ONCE.
pub fn set_airdrop_root(ctx: Context<SetAirdropRoot>, root: [u8; 32]) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require!(!c.airdrop_root_set, ForgeError::AirdropRootSet);
    c.airdrop_root = root;
    c.airdrop_root_set = true;
    Ok(())
}

#[derive(Accounts)]
#[instruction(serial: u32)]
pub struct ClaimAirdrop<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init, payer = claimant, space = 8 + AirdropReceipt::INIT_SPACE,
        seeds = [SEED_AIRDROP, claimant.key().as_ref()], bump
    )]
    pub receipt: Box<Account<'info, AirdropReceipt>>,
    /// CHECK: new Core asset PDA ["asset", 0, serial]
    #[account(mut, seeds = [SEED_ASSET, &[0u8], serial.to_le_bytes().as_ref()], bump)]
    pub asset: UncheckedAccount<'info>,
    #[account(
        init, payer = claimant, space = 8 + ArtifactRecord::INIT_SPACE,
        seeds = [SEED_ARTIFACT, asset.key().as_ref()], bump
    )]
    pub record: Box<Account<'info, ArtifactRecord>>,
    /// CHECK: collection PDA
    #[account(mut, seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: collection update authority PDA
    #[account(seeds = [SEED_ART_AUTHORITY], bump = config.bumps[4])]
    pub artifact_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub claimant: Signer<'info>,
    /// CHECK: Metaplex Core program
    #[account(address = MPL_CORE_ID @ ForgeError::InvalidTarget)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Free Lunar Dust (no floor) for wallets in the published list. leaf = keccak(DOMAIN || wallet)
pub fn claim_airdrop(ctx: Context<ClaimAirdrop>, serial: u32, proof: Vec<[u8; 32]>) -> Result<()> {
    let c = &ctx.accounts.config;
    require!(c.airdrop_root_set, ForgeError::AirdropNotSet);
    require!(c.airdrop_claimed < AIRDROP_MAX, ForgeError::AirdropExhausted);
    require!(c.artifacts_alive[0] < ARTIFACT_SUPPLY[0], ForgeError::SoldOut);
    require!(serial == c.artifacts_minted[0], ForgeError::InvalidTarget);
    let claimant = ctx.accounts.claimant.key();
    let leaf = keccak(&[LEAF_DOMAIN_AIRDROP, claimant.as_ref()]);
    require!(verify_proof(&proof, &c.airdrop_root, leaf), ForgeError::InvalidProof);

    let payer = ctx.accounts.claimant.to_account_info();
    mint_core(
        &ctx.accounts.config,
        &ctx.accounts.core_program,
        &ctx.accounts.asset,
        &ctx.accounts.collection,
        &ctx.accounts.artifact_authority,
        &payer,
        &payer,
        &ctx.accounts.system_program.to_account_info(),
        0,
        serial,
        ctx.bumps.asset,
        0,
        ORIGIN_AIRDROP,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let r = &mut ctx.accounts.record;
    r.asset = ctx.accounts.asset.key();
    r.tier = 0;
    r.serial = serial;
    r.backing = 0;
    r.origin = ORIGIN_AIRDROP;
    r.forged_at = now;
    r.last_chip_week = -1;
    r.bump = ctx.bumps.record;

    let rc = &mut ctx.accounts.receipt;
    rc.claimant = claimant;
    rc.asset = r.asset;
    rc.bump = ctx.bumps.receipt;

    let c = &mut ctx.accounts.config;
    c.artifacts_minted[0] += 1;
    c.artifacts_alive[0] += 1;
    c.airdrop_claimed += 1;
    emit!(ArtifactForged { owner: claimant, asset: r.asset, tier: 0, serial, price: 0, backing: 0, origin: ORIGIN_AIRDROP });
    Ok(())
}

#[cfg(test)]
mod price_tests {
    use super::*;

    fn cfg() -> Config {
        Config {
            version: 2, bump: 0, oracle: Pubkey::default(), pending_oracle: Pubkey::default(), architect: Pubkey::default(),
            bumps: [0; 5], last_epoch: 0, last_publish_ts: 0, reward_reserved: 0, bankroll_reserved: 0, house_total_shares: 0,
            house_protocol_shares: 0, jackpot_round: 0, draw_round: 0, artifacts_alive: [0; 4], artifacts_minted: [0; 4],
            airdrop_root: [0; 32], airdrop_root_set: false, airdrop_claimed: 0, artifact_price: [0; 4], artifact_price_ts: [0; 4],
            bankroll_day: 0, bankroll_day_start: 0,
            stats: Stats::default(),
        }
    }

    #[test]
    fn lunar_dust_is_fixed() {
        let mut c = cfg();
        c.artifact_price[0] = 50 * XNT;
        assert_eq!(current_price(&c, 0, 0), 10 * XNT);
    }

    #[test]
    fn rises_five_percent_per_forge_and_decays_back_to_base() {
        let mut c = cfg();
        let t = 1; // Cosmic Shard, base 25 XNT
        assert_eq!(current_price(&c, t, 0), 25 * XNT);
        let mut now = 1_000;
        let mut p = current_price(&c, t, now);
        for _ in 0..3 {
            c.artifact_price[t] = next_price(p, t);
            c.artifact_price_ts[t] = now;
            p = current_price(&c, t, now);
        }
        assert_eq!(p, 28_940_625_000); // 25 × 1.05³ = 28.940625 XNT
        now += PRICE_DECAY_PERIOD - 1;
        assert_eq!(current_price(&c, t, now), p); // no decay before a full period
        now += 1;
        assert_eq!(current_price(&c, t, now), 27_562_500_000); // ÷1.05 = 27.5625
        now += 10 * PRICE_DECAY_PERIOD;
        assert_eq!(current_price(&c, t, now), 25 * XNT); // never below base
    }

    #[test]
    fn capped_and_never_overflows() {
        let t = 3; // Void Anomaly, base 200 XNT
        let mut p = ARTIFACT_PRICE[t];
        for _ in 0..10_000 {
            p = next_price(p, t);
        }
        assert_eq!(p, 200 * XNT * MAX_PRICE_MULTIPLE);
        let mut c = cfg();
        c.artifact_price[t] = p;
        c.artifact_price_ts[t] = 0;
        assert_eq!(current_price(&c, t, i64::MAX), ARTIFACT_PRICE[t]);
    }

    /// Recycling returns 50% of what the buyer paid: forging and recycling at once always loses
    /// half the price, so price moves can never be farmed through the forge.
    #[test]
    fn floor_is_half_of_what_was_paid() {
        let p = next_price(next_price(ARTIFACT_PRICE[2], 2), 2);
        assert_eq!(bps(p, FORGE_BACKING_BPS).unwrap() * 2, p);
    }
}
