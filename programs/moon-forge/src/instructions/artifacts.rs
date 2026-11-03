//! Moon Forge Artifacts — Metaplex Core NFTs with real, recyclable utility.
//!
//! forge   : pay the tier's current price → forge split 50/20/25/5/0: 50% floor kept inside the NFT record,
//!           20% base pot (reward_vault), 25% extra pot (extra_vault), 5% architect, 0% Burn Lottery.
//!           An Artifact's floor is 50% of the price actually paid. Supply cap = max ALIVE per tier.
//! price   : PX rule (constants.rs): every tier is dynamic, ×PRICE_UP per forge, ÷PRICE_UP per full decay period
//!           without a forge, down to MIN_PRICE_BPS of base and never above 10× base; no decay while the tier
//!           is full. `max_price` protects the buyer.
//! recycle : burn the NFT → its floor comes back to the holder, the slot is freed and can be forged again
//!           (the royalty is earned again on every new forge).
//! rebate  : the extra pot pays a usage rebate computed off-chain (nft-extra A3) and bounded on-chain (extra.rs);
//!           no boost, no chips, no Forge Right.
//! market  : escrowless native sales (market.rs); every asset is minted with a TransferDelegate plugin.
//! airdrop : up to AIRDROP_MAX free Lunar Dust for active X1 wallets (Merkle list, no floor).
//! drops   : legacy epochs only (drops.rs); Forge Drops are off since the final upgrade.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};

use crate::constants::*;
use crate::core_cpi::{burn_asset, create_asset, create_collection, live_asset_owner, update_collection_uri};
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

/// Tier, Element, Floor XNT, Forge Price XNT (= 2 × floor for a FORGED Artifact, "0" for Genesis and Drops;
/// fixed at mint = the forge price, never "price paid", ECO-10), Origin, Serial, Recyclable.
fn attributes(tier: usize, serial: u32, backing: u64, origin: u8) -> Vec<(&'static str, String)> {
    vec![
        ("Tier", TIER_NAMES[tier].to_string()),
        ("Element", ELEMENT_NAMES[tier].to_string()),
        ("Floor XNT", xnt_str(backing)),
        ("Forge Price XNT", xnt_str(if origin == ORIGIN_FORGED { backing.saturating_mul(2) } else { 0 })),
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
/// secondary royalty to the architect (immutable: only this program is the authority, and
/// `lock_collection_royalties` later points the creator at `config.architect` and locks the plugin).
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
        &ARCHITECT,
        &[&[SEED_COLLECTION, &[bump]]],
    )
}

#[derive(Accounts)]
pub struct RefreshCollectionUri<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: Core collection PDA
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

/// PERMISSIONLESS, idempotent. Sets the collection's metadata URI to
/// METADATA_BASE_URI + "collection.json". The URI is a compile-time constant, so a caller can
/// only ever write that value; this lets the metadata move to permanent storage without any
/// admin key. Each asset takes its URI from the same constant when it is created.
pub fn refresh_collection_uri(ctx: Context<RefreshCollectionUri>) -> Result<()> {
    require!(*ctx.accounts.collection.owner == MPL_CORE_ID, ForgeError::InvalidTarget);
    let uri = format!("{}collection.json", METADATA_BASE_URI);
    let bump = ctx.accounts.config.bumps[4];
    update_collection_uri(
        &ctx.accounts.core_program,
        &ctx.accounts.collection,
        &ctx.accounts.payer,
        &ctx.accounts.artifact_authority,
        &ctx.accounts.system_program,
        &uri,
        &[&[SEED_ART_AUTHORITY, &[bump]]],
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
    /// CHECK: draw vault PDA (receives nothing since the final upgrade: FORGE_DRAW_BPS = 0; position kept)
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
    // appended by the final upgrade (0 Artifacts existed, no live client breaks)
    #[account(mut, seeds = [SEED_EXTRA_STATE], bump = extra_state.bump)]
    pub extra_state: Box<Account<'info, ExtraState>>,
    /// CHECK: extra vault PDA (program-owned, lamports only)
    #[account(mut, seeds = [SEED_EXTRA_VAULT], bump = extra_state.vault_bump)]
    pub extra_vault: UncheckedAccount<'info>,
}

pub(crate) fn pay<'info>(sys: &AccountInfo<'info>, from: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
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

/// Current forge price of a tier (PX rule): the price left by the last forge (or the base price decaying
/// from PRICE_LAUNCH_TS when the tier was never forged), lowered by ÷PRICE_UP per full PRICE_DECAY_PERIOD
/// since the clock start, never below MIN_PRICE_BPS of base. A full tier does not decay.
/// Pure function of config + clock.
pub fn current_price(c: &Config, t: usize, now: i64) -> u64 {
    let base = ARTIFACT_PRICE[t];
    let min = bps(base, MIN_PRICE_BPS[t]).unwrap_or(base);
    let (mut p, since) = if c.artifact_price[t] == 0 { (base, PRICE_LAUNCH_TS) } else { (c.artifact_price[t], c.artifact_price_ts[t]) };
    if c.artifacts_alive[t] >= ARTIFACT_SUPPLY[t] {
        return p.max(min); // full tier: no decay
    }
    let periods = (now.saturating_sub(since).max(0) / PRICE_DECAY_PERIOD[t]) as u64;
    for _ in 0..periods.min(PRICE_MAX_STEPS) {
        p = (p as u128 * PRICE_UP_DEN[t] as u128 / PRICE_UP_NUM[t] as u128) as u64;
        if p <= min {
            return min;
        }
    }
    p.max(min)
}

/// Price left for the next buyer after a forge at `paid`: ×PRICE_UP, capped at MAX_PRICE_MULTIPLE × base.
pub fn next_price(paid: u64, t: usize) -> u64 {
    let cap = ARTIFACT_PRICE[t].saturating_mul(MAX_PRICE_MULTIPLE);
    ((paid as u128 * PRICE_UP_NUM[t] as u128 / PRICE_UP_DEN[t] as u128).min(cap as u128)) as u64
}

/// (backing, to_pool, to_extra, to_draw, to_architect): 50 / 20 / 25 / 0 / 5 % of the price; the architect
/// takes the rounding remainder so the parts always sum to the price.
pub fn forge_split(price: u64) -> Result<(u64, u64, u64, u64, u64)> {
    let backing = bps(price, FORGE_BACKING_BPS)?;
    let to_extra = bps(price, FORGE_EXTRA_BPS)?;
    let to_pool = bps(price, FORGE_POOL_BPS)?;
    let to_draw = bps(price, FORGE_DRAW_BPS)?; // 0
    let to_arch = price
        .checked_sub(backing)
        .and_then(|v| v.checked_sub(to_pool))
        .and_then(|v| v.checked_sub(to_extra))
        .and_then(|v| v.checked_sub(to_draw))
        .ok_or(ForgeError::MathOverflow)?;
    Ok((backing, to_pool, to_extra, to_draw, to_arch))
}

/// Frees one slot of a tier. Leaving a FULL tier restarts the PX decay clock (and gives it a stored
/// reference price when the tier was never forged), then the alive counter drops by one.
fn release_slot(c: &mut Config, t: usize, now: i64) {
    if c.artifacts_alive[t] >= ARTIFACT_SUPPLY[t] {
        if c.artifact_price[t] == 0 {
            c.artifact_price[t] = current_price(c, t, now);
        }
        c.artifact_price_ts[t] = now;
    }
    c.artifacts_alive[t] = c.artifacts_alive[t].saturating_sub(1);
}

/// Books backing that left the live forged set (recycle or orphan) for the extra pot's bound.
fn book_backing_out(x: &mut ExtraState, origin: u8, backing: u64) -> Result<()> {
    if origin == ORIGIN_FORGED {
        x.live_forged_backing = x.live_forged_backing.saturating_sub(backing);
        x.out_since_publish = x.out_since_publish.checked_add(backing).ok_or(ForgeError::MathOverflow)?;
    }
    Ok(())
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
    let (backing, mut to_pool, to_extra, to_draw, mut to_arch) = forge_split(price)?;
    if architect_or_pool(&ctx.accounts.architect, &ctx.accounts.reward_vault, to_arch)?.key == ctx.accounts.reward_vault.key {
        to_pool += to_arch;
        to_arch = 0;
    }
    let sys = ctx.accounts.system_program.to_account_info();
    let buyer = ctx.accounts.buyer.to_account_info();
    pay(&sys, &buyer, &ctx.accounts.record.to_account_info(), backing)?;
    pay(&sys, &buyer, &ctx.accounts.reward_vault, to_pool)?;
    pay(&sys, &buyer, &ctx.accounts.extra_vault, to_extra)?;
    if to_draw > 0 {
        pay(&sys, &buyer, &ctx.accounts.draw_vault, to_draw)?;
    }
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

    let x = &mut ctx.accounts.extra_state;
    x.accounted = x.accounted.checked_add(to_extra).ok_or(ForgeError::MathOverflow)?;
    x.total_in = x.total_in.checked_add(to_extra).ok_or(ForgeError::MathOverflow)?;
    x.live_forged_backing = x.live_forged_backing.checked_add(backing).ok_or(ForgeError::MathOverflow)?;

    let c = &mut ctx.accounts.config;
    c.artifacts_minted[t] += 1;
    c.artifacts_alive[t] += 1;
    c.artifact_price[t] = next_price(price, t);
    c.artifact_price_ts[t] = now;
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
    // appended by the final upgrade
    #[account(mut, seeds = [SEED_EXTRA_STATE], bump = extra_state.bump)]
    pub extra_state: Box<Account<'info, ExtraState>>,
}

/// r9 Core-closed hatch (FUTURE-PROOFING C.1.4): true only if Metaplex Core was CLOSED under the upgradeable loader: its
/// program account is still owned by that loader (a loader migration changes that owner, so a migrated, working Core
/// never matches) and its ProgramData account no longer belongs to the loader (a closed ProgramData has no lamports and
/// no data; only the loader can own that address, and a live loader-v3 program always has it). A closed program never
/// runs again, so its asset accounts are frozen for good: their owner bytes are final.
pub(crate) fn core_is_closed(core: &AccountInfo, programdata: &AccountInfo) -> bool {
    *core.key == MPL_CORE_ID
        && *core.owner == BPF_LOADER_UPGRADEABLE_ID
        && *programdata.key == MPL_CORE_PROGRAMDATA
        && *programdata.owner != BPF_LOADER_UPGRADEABLE_ID
}

/// Burn the NFT and get its floor back (record lamports = floor + rent).
/// r9 hatch: the holder may pass Core's ProgramData account as the one remaining account. If it proves Core was closed
/// (core_is_closed), the asset can never be burned or moved again and the floor is paid without the burn; the record is
/// closed as always, so a floor is paid once. Without that account, or with Core alive, nothing changes.
pub fn recycle_artifact(ctx: Context<RecycleArtifact>) -> Result<()> {
    let holder = live_asset_owner(&ctx.accounts.asset, &ctx.accounts.collection.key()).ok_or(ForgeError::InvalidArtifact)?;
    require_keys_eq!(holder, ctx.accounts.owner.key(), ForgeError::NotArtifactOwner);
    let core_closed = ctx.remaining_accounts.first().is_some_and(|pd| core_is_closed(&ctx.accounts.core_program, pd));
    if !core_closed {
        burn_asset(
            &ctx.accounts.core_program,
            &ctx.accounts.asset,
            &ctx.accounts.collection,
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
        )?;
    }
    let (tier, backing, origin) = (ctx.accounts.record.tier, ctx.accounts.record.backing, ctx.accounts.record.origin);
    let now = Clock::get()?.unix_timestamp;
    release_slot(&mut ctx.accounts.config, tier as usize, now);
    book_backing_out(&mut ctx.accounts.extra_state, origin, backing)?;
    emit!(ArtifactRecycled { owner: holder, asset: ctx.accounts.asset.key(), tier, backing_returned: backing, orphan: false });
    Ok(())
}

#[derive(Accounts)]
pub struct ReclaimOrphan<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: the (no longer existing / burned elsewhere) Core asset; proven gone in the handler
    pub asset: UncheckedAccount<'info>,
    #[account(mut, close = reward_vault, seeds = [SEED_ARTIFACT, asset.key().as_ref()], bump = record.bump)]
    pub record: Box<Account<'info, ArtifactRecord>>,
    /// CHECK: collection PDA (position kept; the guard no longer parses the asset against it)
    #[account(seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    // appended by the final upgrade
    #[account(mut, seeds = [SEED_EXTRA_STATE], bump = extra_state.bump)]
    pub extra_state: Box<Account<'info, ExtraState>>,
}

/// The only accepted proof that an Artifact is gone (X-021 / A-1): a burn tombstone (Core-owned, 1 byte,
/// Key::Uninitialized), a closed account, or an account Core does not own. Anything still owned by Core with
/// a non-zero key byte is refused, parseable or not: a Core upgrade can block reclaims, never sweep a live
/// Artifact's floor.
pub(crate) fn asset_is_gone(owner: &Pubkey, data: &[u8]) -> bool {
    *owner != MPL_CORE_ID || data.len() <= 1 || data[0] == 0 /* Key::Uninitialized */
}

/// PERMISSIONLESS. If an Artifact was burned outside Moon Forge, its floor would be stuck:
/// this frees the supply slot and sends the floor to the reward pool.
pub fn reclaim_orphan(ctx: Context<ReclaimOrphan>) -> Result<()> {
    let gone = {
        let a = &ctx.accounts.asset;
        asset_is_gone(a.owner, &a.try_borrow_data()?)
    };
    require!(gone, ForgeError::ArtifactAlive);
    let (tier, backing, origin) = (ctx.accounts.record.tier, ctx.accounts.record.backing, ctx.accounts.record.origin);
    let now = Clock::get()?.unix_timestamp;
    let c = &mut ctx.accounts.config;
    release_slot(c, tier as usize, now);
    c.stats.artifact_to_pool = c.stats.artifact_to_pool.saturating_add(backing);
    book_backing_out(&mut ctx.accounts.extra_state, origin, backing)?;
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

/// RETIRED (nft-extra B1, X-176): weekly chips no longer exist; the ABI is kept so old clients get a readable error.
pub fn claim_artifact_chips(_ctx: Context<ClaimArtifactChips>) -> Result<()> {
    err!(ForgeError::ChipsRetired)
}

#[derive(Accounts)]
pub struct SetAirdropRoot<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(address = config.architect @ ForgeError::OnlyArchitect)]
    pub architect: Signer<'info>,
}

/// Publish the airdrop list, ONCE (already used on mainnet).
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

/// Free Lunar Dust (no floor) for wallets in the published list, until AIRDROP_DEADLINE. leaf = keccak(DOMAIN || wallet)
pub fn claim_airdrop(ctx: Context<ClaimAirdrop>, serial: u32, proof: Vec<[u8; 32]>) -> Result<()> {
    let c = &ctx.accounts.config;
    require!(c.airdrop_root_set, ForgeError::AirdropNotSet);
    require!(Clock::get()?.unix_timestamp < AIRDROP_DEADLINE, ForgeError::AirdropClosed);
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

    const DAY: i64 = PRICE_DECAY_PERIOD[0];

    /// A tier never forged (stored price 0) decays from PRICE_LAUNCH_TS: Lunar 10 → 9.80 after a day → 3.00 floor.
    #[test]
    fn never_forged_lunar_decays_from_launch() {
        let c = cfg();
        assert_eq!(current_price(&c, 0, 0), 10 * XNT); // before launch
        assert_eq!(current_price(&c, 0, PRICE_LAUNCH_TS), 10 * XNT);
        assert_eq!(current_price(&c, 0, PRICE_LAUNCH_TS + DAY - 1), 10 * XNT);
        let day1 = current_price(&c, 0, PRICE_LAUNCH_TS + DAY);
        assert_eq!(day1, 9_803_921_568); // 10 × 50/51
        assert_eq!(xnt_str(day1), "9.80");
        assert_eq!(current_price(&c, 0, PRICE_LAUNCH_TS + 177 * DAY), 3 * XNT); // floor = 30% of base
        assert_eq!(current_price(&c, 0, i64::MAX), 3 * XNT);
        // the other tiers decay from launch too, down to 50% of base
        assert_eq!(current_price(&c, 1, PRICE_LAUNCH_TS + 3 * DAY), 25 * XNT * 20 / 21);
        assert_eq!(current_price(&c, 1, i64::MAX), 12_500_000_000);
        assert_eq!(current_price(&c, 2, i64::MAX), 30 * XNT);
        assert_eq!(current_price(&c, 3, i64::MAX), 100 * XNT);
    }

    #[test]
    fn cosmic_rises_five_percent_per_forge_and_decays_per_three_days() {
        let mut c = cfg();
        let t = 1; // Cosmic Shard, base 25 XNT
        let mut now = PRICE_LAUNCH_TS;
        let mut p = current_price(&c, t, now);
        assert_eq!(p, 25 * XNT);
        for _ in 0..2 {
            c.artifact_price[t] = next_price(p, t);
            c.artifact_price_ts[t] = now;
            p = current_price(&c, t, now);
        }
        assert_eq!(p, 27_562_500_000); // 25 × 1.05² = 27.5625 XNT
        now += PRICE_DECAY_PERIOD[t] - 1;
        assert_eq!(current_price(&c, t, now), p); // no decay before a full period
        now += 1;
        assert_eq!(current_price(&c, t, now), 26_250_000_000); // ÷1.05
        now += PRICE_DECAY_PERIOD[t];
        assert_eq!(current_price(&c, t, now), 25 * XNT);
        now += PRICE_DECAY_PERIOD[t];
        assert_eq!(current_price(&c, t, now), 25 * XNT * 20 / 21); // below base now
        now += 100 * PRICE_DECAY_PERIOD[t];
        assert_eq!(current_price(&c, t, now), 12_500_000_000); // 50% floor
    }

    #[test]
    fn full_tier_never_decays() {
        for t in 0..4 {
            let mut c = cfg();
            c.artifact_price[t] = 3 * ARTIFACT_PRICE[t];
            c.artifact_price_ts[t] = 0;
            c.artifacts_alive[t] = ARTIFACT_SUPPLY[t];
            assert_eq!(current_price(&c, t, i64::MAX), 3 * ARTIFACT_PRICE[t]);
            c.artifacts_alive[t] = ARTIFACT_SUPPLY[t] - 1;
            assert!(current_price(&c, t, i64::MAX) < 3 * ARTIFACT_PRICE[t]);
            // a full never-forged tier reads the base price
            let mut c = cfg();
            c.artifacts_alive[t] = ARTIFACT_SUPPLY[t];
            assert_eq!(current_price(&c, t, i64::MAX), ARTIFACT_PRICE[t]);
        }
    }

    #[test]
    fn leaving_a_full_tier_restarts_the_clock() {
        let t = 2; // Solar Core, 7-day period
        let mut c = cfg();
        c.artifacts_alive[t] = ARTIFACT_SUPPLY[t];
        let now = PRICE_LAUNCH_TS + 400 * DAY;
        release_slot(&mut c, t, now);
        assert_eq!(c.artifacts_alive[t], ARTIFACT_SUPPLY[t] - 1);
        assert_eq!(c.artifact_price[t], 60 * XNT); // reference written for the clock
        assert_eq!(c.artifact_price_ts[t], now);
        assert_eq!(current_price(&c, t, now + PRICE_DECAY_PERIOD[t] - 1), 60 * XNT);
        assert_eq!(current_price(&c, t, now + PRICE_DECAY_PERIOD[t]), 60 * XNT * 20 / 21);
        // a full tier with a stored price keeps it and restarts from now
        let mut c = cfg();
        c.artifacts_alive[t] = ARTIFACT_SUPPLY[t];
        c.artifact_price[t] = 90 * XNT;
        c.artifact_price_ts[t] = 0;
        release_slot(&mut c, t, now);
        assert_eq!(c.artifact_price[t], 90 * XNT);
        assert_eq!(c.artifact_price_ts[t], now);
        // leaving a tier that is not full does not touch the clock
        let mut c = cfg();
        c.artifacts_alive[t] = 5;
        c.artifact_price[t] = 90 * XNT;
        c.artifact_price_ts[t] = 7;
        release_slot(&mut c, t, now);
        assert_eq!((c.artifacts_alive[t], c.artifact_price[t], c.artifact_price_ts[t]), (4, 90 * XNT, 7));
        let mut c = cfg();
        release_slot(&mut c, t, now);
        assert_eq!(c.artifacts_alive[t], 0); // saturating
    }

    #[test]
    fn next_price_caps_at_ten_times_base() {
        for t in 0..4 {
            let mut p = ARTIFACT_PRICE[t];
            for _ in 0..10_000 {
                p = next_price(p, t);
            }
            assert_eq!(p, ARTIFACT_PRICE[t] * MAX_PRICE_MULTIPLE);
            let mut c = cfg();
            c.artifact_price[t] = p;
            c.artifact_price_ts[t] = 0;
            assert_eq!(current_price(&c, t, 0), p);
        }
        assert_eq!(next_price(10 * XNT, 0), 10_200_000_000);
        assert_eq!(next_price(25 * XNT, 1), 26_250_000_000);
    }

    /// LB-4 / ECO-8: the integer walk from 10× base reaches the minimum within PRICE_MAX_STEPS on every tier.
    #[test]
    fn max_steps_suffice_for_every_tier() {
        let walk = |t: usize| -> (u64, u64) {
            let min = ARTIFACT_PRICE[t] * MIN_PRICE_BPS[t] / BPS;
            let mut p = ARTIFACT_PRICE[t] * MAX_PRICE_MULTIPLE;
            let mut steps = 0u64;
            while p > min {
                p = (p as u128 * PRICE_UP_DEN[t] as u128 / PRICE_UP_NUM[t] as u128) as u64;
                steps += 1;
            }
            (steps, p)
        };
        let mut p = 100 * XNT;
        for _ in 0..177 {
            p = p * 50 / 51;
        }
        assert_eq!(p, 3_004_481_921);
        assert!(p * 50 / 51 <= 3 * XNT);
        assert_eq!(walk(0).0, 178);
        assert_eq!(walk(1).0, 62);
        assert_eq!(walk(2).0, 62);
        assert_eq!(walk(3).0, 62);
        for t in 0..4 {
            assert!(walk(t).0 <= PRICE_MAX_STEPS);
            let mut c = cfg();
            c.artifact_price[t] = ARTIFACT_PRICE[t] * MAX_PRICE_MULTIPLE;
            c.artifact_price_ts[t] = 0;
            assert_eq!(current_price(&c, t, i64::MAX), ARTIFACT_PRICE[t] * MIN_PRICE_BPS[t] / BPS);
        }
    }

    /// Recycling returns 50% of what the buyer paid: forging and recycling at once always loses
    /// half the price, so price moves can never be farmed through the forge.
    #[test]
    fn floor_is_half_of_what_was_paid() {
        let p = next_price(next_price(ARTIFACT_PRICE[2], 2), 2);
        assert_eq!(bps(p, FORGE_BACKING_BPS).unwrap() * 2, p);
    }
}

#[cfg(test)]
mod split_and_attribute_tests {
    use super::*;

    #[test]
    fn split_is_50_20_25_5_0_and_sums_to_the_price() {
        assert_eq!(forge_split(10 * XNT).unwrap(), (5 * XNT, 2 * XNT, 2_500_000_000, 0, 500_000_000));
        let mut x: u64 = 0x2545_F491_4F6C_DD1D;
        for _ in 0..1_000_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let price = x % (2_000 * XNT) + 1;
            let (b, p, e, d, a) = forge_split(price).unwrap();
            assert_eq!(b + p + e + d + a, price);
            assert_eq!(d, 0);
            assert_eq!(b, price / 2);
            assert!(a >= price / 20);
        }
    }

    fn get<'a>(attrs: &'a [(&'static str, String)], key: &str) -> Option<&'a str> {
        attrs.iter().find(|(k, _)| *k == key).map(|(_, v)| v.as_str())
    }

    #[test]
    fn attributes_carry_floor_and_forge_price() {
        let lunar = attributes(0, 0, 5 * XNT, ORIGIN_FORGED);
        assert_eq!(lunar.iter().map(|(k, _)| *k).collect::<Vec<_>>(), ["Tier", "Element", "Floor XNT", "Forge Price XNT", "Origin", "Serial", "Recyclable"]);
        assert_eq!(get(&lunar, "Floor XNT"), Some("5"));
        assert_eq!(get(&lunar, "Forge Price XNT"), Some("10"));
        assert_eq!(get(&lunar, "Serial"), Some("1"));
        assert_eq!(get(&lunar, "Origin"), Some("Forged"));
        let solar = attributes(2, 41, 31_500_000_000, ORIGIN_FORGED);
        assert_eq!(get(&solar, "Floor XNT"), Some("31.50"));
        assert_eq!(get(&solar, "Forge Price XNT"), Some("63"));
        assert_eq!(get(&solar, "Tier"), Some("Solar Core"));
        let genesis = attributes(0, 3, 0, ORIGIN_AIRDROP);
        assert_eq!(get(&genesis, "Floor XNT"), Some("0"));
        assert_eq!(get(&genesis, "Forge Price XNT"), Some("0"));
        assert_eq!(get(&genesis, "Origin"), Some("Genesis Airdrop"));
        let drop = attributes(0, 4, 5 * XNT, ORIGIN_DROP);
        assert_eq!(get(&drop, "Floor XNT"), Some("5"));
        assert_eq!(get(&drop, "Forge Price XNT"), Some("0"));
        for a in [&lunar, &solar, &genesis, &drop] {
            assert!(get(a, "Burn Boost").is_none());
            assert!(get(a, "Weekly Chips").is_none());
            assert!(get(a, "Initial Forge Right XNT").is_none());
            assert!(get(a, "Price Paid XNT").is_none());
            assert_eq!(get(a, "Recyclable"), Some("Yes"));
        }
    }
}

#[cfg(test)]
mod orphan_guard_tests {
    use super::*;

    fn live_asset(collection: &Pubkey, key: u8, ua_tag: u8) -> Vec<u8> {
        let mut d = vec![key];
        d.extend_from_slice(&[1u8; 32]); // owner
        d.push(ua_tag);
        d.extend_from_slice(collection.as_ref());
        d.extend_from_slice(&[0u8; 40]);
        d
    }

    /// X-021 / A-1: "gone" = tombstone, closed account or not Core-owned; everything else is ArtifactAlive.
    #[test]
    fn only_a_gone_asset_can_be_reclaimed() {
        let ours = Pubkey::new_from_array([7; 32]);
        let other = Pubkey::new_from_array([8; 32]);
        let other_program = Pubkey::new_from_array([9; 32]);
        // allowed
        assert!(asset_is_gone(&MPL_CORE_ID, &[0])); // burned: 1-byte Key::Uninitialized
        assert!(asset_is_gone(&anchor_lang::system_program::ID, &[])); // closed
        assert!(asset_is_gone(&other_program, &live_asset(&ours, 1, 2))); // not Core-owned
        assert!(asset_is_gone(&MPL_CORE_ID, &live_asset(&ours, 0, 2))); // key byte 0 whatever follows
        // refused
        assert!(!asset_is_gone(&MPL_CORE_ID, &live_asset(&ours, 1, 2))); // live own asset
        assert!(!asset_is_gone(&MPL_CORE_ID, &live_asset(&other, 1, 2))); // live asset of another collection
        assert!(!asset_is_gone(&MPL_CORE_ID, &live_asset(&ours, 9, 2))); // unknown key byte
        assert!(!asset_is_gone(&MPL_CORE_ID, &live_asset(&ours, 1, 0))); // UA tag != 2
        assert!(!asset_is_gone(&MPL_CORE_ID, &[1, 2])); // Core-owned, 2 bytes, non-zero key
    }

    /// r9 Core-closed hatch: the burn is skipped only for Core's own program account still under the upgradeable loader
    /// AND its own ProgramData address no longer owned by that loader (closed). A live Core, a Core migrated to another
    /// loader, or any other account passed as either never matches.
    #[test]
    fn core_closed_only_when_its_programdata_is_gone() {
        let loader_v4 = pubkey!("LoaderV411111111111111111111111111111111111");
        let sys = anchor_lang::system_program::ID;
        assert_eq!(Pubkey::find_program_address(&[MPL_CORE_ID.as_ref()], &BPF_LOADER_UPGRADEABLE_ID).0, MPL_CORE_PROGRAMDATA);
        let check = |core_key: Pubkey, core_owner: Pubkey, pd_key: Pubkey, pd_owner: Pubkey| {
            let (mut l1, mut l2) = (1u64, 0u64);
            let (mut d1, mut d2) = (vec![2u8, 0, 0, 0], Vec::<u8>::new());
            let core = AccountInfo::new(&core_key, false, false, &mut l1, &mut d1, &core_owner, true, 0);
            let pd = AccountInfo::new(&pd_key, false, false, &mut l2, &mut d2, &pd_owner, false, 0);
            core_is_closed(&core, &pd)
        };
        let (core, pd, ld3) = (MPL_CORE_ID, MPL_CORE_PROGRAMDATA, BPF_LOADER_UPGRADEABLE_ID);
        assert!(check(core, ld3, pd, sys), "closed: the ProgramData address is an empty system account");
        assert!(check(core, ld3, pd, Pubkey::new_unique()), "closed, whatever now sits at the address");
        assert!(!check(core, ld3, pd, ld3), "alive: ProgramData still owned by the loader");
        assert!(!check(core, loader_v4, pd, sys), "migrated to loader v4: Core works, no hatch");
        assert!(!check(core, sys, pd, sys), "Core account not under the upgradeable loader");
        assert!(!check(Pubkey::new_unique(), ld3, pd, sys), "another program account");
        assert!(!check(core, ld3, Pubkey::new_unique(), sys), "another ProgramData address");
    }
}
