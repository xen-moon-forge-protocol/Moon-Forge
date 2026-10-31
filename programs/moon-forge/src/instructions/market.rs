//! Artifact Market (SPEC-UPGRADE-v2 §2.16): escrowless native sales of Artifacts.
//!
//! The NFT never leaves the seller's wallet. `list_artifact` delegates Core's TransferDelegate to the `Listing` PDA
//! (`["listing", asset]`), which signs the Core transfer only inside `buy_artifact`, after the buyer paid:
//!   price (exact) = seller_net + royalty (5%, to `config.architect` through `architect_or_pool`) + pool_fee (2%, to
//!   the BASE pot `reward_vault`; never the extra pot, never the lottery), and seller_net >= the Artifact's floor
//!   (`record.backing`), so the lowest list price is 53.76% of base and a wash trade costs at least 3.76% of base.
//! Core resets every owner-managed authority to the Owner on any transfer, and the owner can burn (recycle) whatever the
//! delegate, so a moved or recycled Artifact leaves a stale listing that anyone can close (rent back to the seller).
//!
//! `lock_collection_royalties` (group g2) also lives here.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::core_cpi;
use crate::core_cpi::{
    add_transfer_delegate, approve_transfer_delegate, live_asset_owner, revoke_transfer_delegate, transfer_as_delegate,
};
use crate::errors::ForgeError;
use crate::events::*;
use crate::instructions::artifacts::pay;
use crate::state::*;
use crate::utils::*;

// ═══════════════════════════════════════════════════════════════════════════
// Pure rules (market_PROPOSAL.rs.txt lines 141-155, unit-tested below)
// ═══════════════════════════════════════════════════════════════════════════

/// The list price must be at least MARKET_MIN_PRICE and leave the seller at least the Artifact's floor after both
/// fees (below this the holder should recycle). Returns the seller's net.
fn check_price(price: u64, backing: u64) -> Result<u64> {
    require!(price >= MARKET_MIN_PRICE, ForgeError::ListingBelowFloor);
    let (_, _, net) = market_split(price)?;
    require!(net >= backing, ForgeError::ListingBelowFloor);
    Ok(net)
}

/// A listing always expires: strictly in the future and at most MARKET_MAX_LISTING after it is (re)written.
fn check_expiry(expires_at: i64, now: i64) -> Result<()> {
    require!(expires_at > now && expires_at <= now.saturating_add(MARKET_MAX_LISTING), ForgeError::InvalidExpiry);
    Ok(())
}

/// Pubkey::default() = public listing; otherwise only the reserved wallet may buy (private sale).
fn buyer_allowed(reserved_buyer: &Pubkey, buyer: &Pubkey) -> bool {
    *reserved_buyer == Pubkey::default() || reserved_buyer == buyer
}

/// `close_listing` reason: 1 = stale (the seller no longer holds a live asset of the collection), 2 = expired.
/// A live, unexpired listing can only be delisted by its seller.
fn close_reason(stale: bool, expired: bool) -> Result<u8> {
    require!(stale || expired, ForgeError::ListingActive);
    Ok(if stale { 1 } else { 2 })
}

// ═══════════════════════════════════════════════════════════════════════════
// list_artifact — seller
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct ListArtifact<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = seller, space = 8 + Listing::INIT_SPACE, seeds = [SEED_LISTING, asset.key().as_ref()], bump)]
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK: Core asset, owner checked with live_asset_owner
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    #[account(seeds = [SEED_ARTIFACT, asset.key().as_ref()], bump = record.bump)]
    pub record: Box<Account<'info, ArtifactRecord>>,
    /// CHECK: collection PDA
    #[account(mut, seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: Metaplex Core
    #[account(address = MPL_CORE_ID @ ForgeError::InvalidTarget)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// `add_plugin = true` only when the asset has no TransferDelegate plugin: minted BEFORE this upgrade (0 exist), or
/// the owner removed the plugin with Core's RemovePluginV1 (G4R-3). `add_plugin = false` on such an asset fails with
/// Core's PluginNotFound, so clients read the asset's plugin list to choose. On a fresh mint the revoke below is an
/// Owner -> Owner revoke, which upstream Core accepts (size unchanged).
/// `reserved_buyer = Pubkey::default()` lists publicly; any other key makes a private sale to that wallet.
pub fn list_artifact(
    ctx: Context<ListArtifact>,
    price: u64,
    expires_at: i64,
    reserved_buyer: Pubkey,
    add_plugin: bool,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let holder = live_asset_owner(&ctx.accounts.asset, &ctx.accounts.collection.key()).ok_or(ForgeError::InvalidArtifact)?;
    require_keys_eq!(holder, ctx.accounts.seller.key(), ForgeError::NotArtifactOwner);
    require_keys_eq!(ctx.accounts.record.asset, ctx.accounts.asset.key(), ForgeError::InvalidArtifact);
    require_keys_neq!(reserved_buyer, holder, ForgeError::SelfPurchase);
    let backing = ctx.accounts.record.backing;
    let net = check_price(price, backing)?;
    check_expiry(expires_at, now)?;

    let core = ctx.accounts.core_program.to_account_info();
    let asset = ctx.accounts.asset.to_account_info();
    let coll = ctx.accounts.collection.to_account_info();
    let seller = ctx.accounts.seller.to_account_info();
    let sys = ctx.accounts.system_program.to_account_info();
    let me = ctx.accounts.listing.key();
    if add_plugin {
        add_transfer_delegate(&core, &asset, &coll, &seller, &sys, &me)?;
    } else {
        revoke_transfer_delegate(&core, &asset, &coll, &seller, &sys)?; // clears a dangling or third-party delegation (idempotent)
        approve_transfer_delegate(&core, &asset, &coll, &seller, &sys, &me)?;
    }

    let tier = ctx.accounts.record.tier;
    let l = &mut ctx.accounts.listing;
    l.asset = asset.key();
    l.seller = holder;
    l.reserved_buyer = reserved_buyer;
    l.price = price;
    l.created_at = now;
    l.expires_at = expires_at;
    l.tier = tier;
    l.bump = ctx.bumps.listing;
    emit!(ArtifactListed {
        asset: l.asset,
        seller: holder,
        tier,
        price,
        seller_net: net,
        backing,
        reserved_buyer,
        expires_at,
        update: false
    });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// update_listing — seller (SPEC 2.16; not in the proposal)
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct UpdateListing<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut, seeds = [SEED_LISTING, asset.key().as_ref()], bump = listing.bump,
        has_one = seller @ ForgeError::Unauthorized, has_one = asset
    )]
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK: Core asset; live_asset_owner must be the seller (else ListingStale). Writable only for the two
    /// delegate CPIs.
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    #[account(seeds = [SEED_ARTIFACT, asset.key().as_ref()], bump = record.bump)]
    pub record: Box<Account<'info, ArtifactRecord>>,
    /// CHECK: collection PDA
    #[account(mut, seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: Metaplex Core
    #[account(address = MPL_CORE_ID @ ForgeError::InvalidTarget)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Reprices / re-dates / re-reserves without the rent round-trip of delist + list. ALWAYS revokes and re-approves the
/// delegate (M-2): Core resets it to the Owner on every transfer, so after A -> B -> A the old listing would otherwise
/// look live while nobody could buy it and nobody could close it. `created_at` is kept.
pub fn update_listing(ctx: Context<UpdateListing>, price: u64, expires_at: i64, reserved_buyer: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let seller_key = ctx.accounts.seller.key();
    require!(
        live_asset_owner(&ctx.accounts.asset, &ctx.accounts.collection.key()) == Some(seller_key),
        ForgeError::ListingStale
    );
    let backing = ctx.accounts.record.backing;
    let net = check_price(price, backing)?;
    check_expiry(expires_at, now)?;
    require_keys_neq!(reserved_buyer, seller_key, ForgeError::SelfPurchase);

    let l = &mut ctx.accounts.listing;
    l.price = price;
    l.expires_at = expires_at;
    l.reserved_buyer = reserved_buyer;
    let (asset_key, tier, me) = (l.asset, l.tier, l.key());

    let core = ctx.accounts.core_program.to_account_info();
    let asset = ctx.accounts.asset.to_account_info();
    let coll = ctx.accounts.collection.to_account_info();
    let seller = ctx.accounts.seller.to_account_info();
    let sys = ctx.accounts.system_program.to_account_info();
    revoke_transfer_delegate(&core, &asset, &coll, &seller, &sys)?;
    approve_transfer_delegate(&core, &asset, &coll, &seller, &sys, &me)?;

    emit!(ArtifactListed {
        asset: asset_key,
        seller: seller_key,
        tier,
        price,
        seller_net: net,
        backing,
        reserved_buyer,
        expires_at,
        update: true
    });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// delist_artifact — seller
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct DelistArtifact<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, close = seller, seeds = [SEED_LISTING, asset.key().as_ref()], bump = listing.bump, has_one = seller, has_one = asset)]
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK: Core asset (may be burned)
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: collection PDA
    #[account(mut, seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: Metaplex Core
    #[account(address = MPL_CORE_ID @ ForgeError::InvalidTarget)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Always succeeds for the seller: revokes only while they still hold the asset (owner revoke is idempotent).
/// One exception, caused by the seller (G4R-3): if the seller removed the TransferDelegate plugin with Core's
/// RemovePluginV1 while the listing was open, this revoke and update_listing's both fail with PluginNotFound, and
/// close_listing returns ListingActive until `expires_at` (at most MARKET_MAX_LISTING). After that, close_listing
/// (reason 2) returns the rent, and list_artifact(add_plugin = true) adds the plugin back. No funds are lost.
pub fn delist_artifact(ctx: Context<DelistArtifact>) -> Result<()> {
    if live_asset_owner(&ctx.accounts.asset, &ctx.accounts.collection.key()) == Some(ctx.accounts.seller.key()) {
        revoke_transfer_delegate(
            &ctx.accounts.core_program,
            &ctx.accounts.asset,
            &ctx.accounts.collection,
            &ctx.accounts.seller.to_account_info(),
            &ctx.accounts.system_program.to_account_info(),
        )?;
    }
    emit!(ArtifactDelisted { asset: ctx.accounts.asset.key(), seller: ctx.accounts.seller.key(), reason: 0 });
    Ok(()) // `close = seller` returns the listing rent
}

// ═══════════════════════════════════════════════════════════════════════════
// buy_artifact — buyer
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct BuyArtifact<'info> {
    /// mut for the M-3 stats. This write-locks config, so a buy waits behind every other instruction that writes
    /// config (forge, recycle, bets, claims). The collection is read-only here and gives no such serialisation.
    /// The cost is throughput only (SPEC M-3 chose it).
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, close = seller, seeds = [SEED_LISTING, asset.key().as_ref()], bump = listing.bump, has_one = seller, has_one = asset)]
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK: Core asset
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    #[account(seeds = [SEED_ARTIFACT, asset.key().as_ref()], bump = record.bump)]
    pub record: Box<Account<'info, ArtifactRecord>>,
    /// CHECK: collection PDA
    #[account(seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: = listing.seller
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: architect wallet
    #[account(mut, address = config.architect @ ForgeError::InvalidTarget)]
    pub architect: UncheckedAccount<'info>,
    /// CHECK: reward vault PDA (BASE pot)
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core
    #[account(address = MPL_CORE_ID @ ForgeError::InvalidTarget)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// `price` must equal the listing price exactly (a seller cannot raise it under a pending buy).
/// A listing whose seller still holds the asset passes every check below even when its delegate is no longer this
/// PDA: after A -> B -> A, after the seller revoked it directly in Core, or after the seller approved a third party
/// (G4R-2). Core's TransferV1 then fails and the whole transaction reverts; the buyer loses only the network fee.
/// Clients show Buy only when the asset's TransferDelegate authority equals the Listing PDA.
/// Core resets the delegate on transfer without shrinking the account, and the next approve adds 32 B. Each
/// list -> buy cycle therefore leaves the asset 32 B larger. The next seller pays that rent, and whoever later
/// recycles the asset gets it back. The buyer gets no Core refund (G4R-1).
pub fn buy_artifact(ctx: Context<BuyArtifact>, price: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let l = &ctx.accounts.listing;
    require!(l.price == price, ForgeError::ListingPriceChanged);
    require!(now < l.expires_at, ForgeError::ListingExpired);
    require!(buyer_allowed(&l.reserved_buyer, &ctx.accounts.buyer.key()), ForgeError::ListingReserved);
    require_keys_neq!(ctx.accounts.buyer.key(), l.seller, ForgeError::SelfPurchase);
    let holder = live_asset_owner(&ctx.accounts.asset, &ctx.accounts.collection.key()).ok_or(ForgeError::ListingStale)?;
    require_keys_eq!(holder, l.seller, ForgeError::ListingStale);
    require_keys_eq!(ctx.accounts.record.asset, ctx.accounts.asset.key(), ForgeError::InvalidArtifact);
    let (royalty, pool_fee, seller_net) = market_split(price)?;
    require!(seller_net >= ctx.accounts.record.backing, ForgeError::ListingBelowFloor); // defensive: backing never changes
    let (bump, private) = (l.bump, l.reserved_buyer != Pubkey::default());

    let sys = ctx.accounts.system_program.to_account_info();
    let buyer = ctx.accounts.buyer.to_account_info();
    pay(&sys, &buyer, &ctx.accounts.seller, seller_net)?;
    let roy_to = architect_or_pool(&ctx.accounts.architect, &ctx.accounts.reward_vault, royalty)?;
    let royalty_to_pool = roy_to.key == ctx.accounts.reward_vault.key;
    pay(&sys, &buyer, roy_to, royalty)?;
    pay(&sys, &buyer, &ctx.accounts.reward_vault, pool_fee)?;

    let asset_key = ctx.accounts.asset.key();
    let seeds: &[&[u8]] = &[SEED_LISTING, asset_key.as_ref(), &[bump]];
    transfer_as_delegate(
        &ctx.accounts.core_program,
        &ctx.accounts.asset,
        &ctx.accounts.collection,
        &buyer,
        &ctx.accounts.listing.to_account_info(),
        &[seeds],
    )?;

    // M-3: stats follow where the lamports went (as forge_artifact does when the architect cut falls back to the pool).
    let (to_arch, to_pool) = if royalty_to_pool { (0, royalty + pool_fee) } else { (royalty, pool_fee) };
    let c = &mut ctx.accounts.config;
    c.stats.to_architect = c.stats.to_architect.saturating_add(to_arch);
    c.stats.artifact_to_pool = c.stats.artifact_to_pool.saturating_add(to_pool);

    let r = &ctx.accounts.record;
    emit!(ArtifactSold {
        asset: asset_key,
        tier: r.tier,
        origin: r.origin,
        seller: holder,
        buyer: buyer.key(),
        price,
        royalty,
        pool_fee,
        seller_net,
        backing: r.backing,
        private
    });
    Ok(()) // `close = seller` returns the listing rent
}

// ═══════════════════════════════════════════════════════════════════════════
// close_listing — PERMISSIONLESS (stale or expired)
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct CloseListing<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, close = seller, seeds = [SEED_LISTING, asset.key().as_ref()], bump = listing.bump, has_one = seller, has_one = asset)]
    pub listing: Box<Account<'info, Listing>>,
    /// CHECK: listing.seller (rent goes back to them)
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: Core asset (may be burned)
    pub asset: UncheckedAccount<'info>,
    /// CHECK: collection PDA
    #[account(seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
}

/// Closes a listing whose asset moved or was burned (Core already reset the delegation), or that expired (the dangling
/// delegation is harmless: the listing PDA signs only inside buy_artifact, which needs this account; the next
/// list_artifact revokes it first). Rent always goes to the seller.
pub fn close_listing(ctx: Context<CloseListing>) -> Result<()> {
    let l = &ctx.accounts.listing;
    let stale = live_asset_owner(&ctx.accounts.asset, &ctx.accounts.collection.key()) != Some(l.seller);
    let expired = Clock::get()?.unix_timestamp >= l.expires_at;
    let reason = close_reason(stale, expired)?;
    emit!(ArtifactDelisted { asset: l.asset, seller: l.seller, reason });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// lock_collection_royalties — architect-signed, effectively once (M-1/ECO-4)
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct LockCollectionRoyalties<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: Core collection PDA
    #[account(mut, seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: collection update authority PDA (signs both Core CPIs, holds nothing)
    #[account(seeds = [SEED_ART_AUTHORITY], bump = config.bumps[4])]
    pub artifact_authority: UncheckedAccount<'info>,
    /// the payee whose address becomes the permanent Core royalty creator; pays any rent difference
    #[account(mut, address = config.architect @ ForgeError::OnlyArchitect)]
    pub architect: Signer<'info>,
    /// CHECK: Metaplex Core program
    #[account(address = MPL_CORE_ID @ ForgeError::InvalidTarget)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Rewrites the collection's Royalties plugin to { SECONDARY_ROYALTY_BPS, creators: [config.architect 100%],
/// RuleSet::None } and then sets the plugin authority to None, so nobody can ever change the 500 bps declaration or
/// its creator (third-party venues may still ignore it). Run AFTER `set_architect` (runbook 6.3 steps 4-5): the
/// declaration does not follow any later `set_architect`. Not permissionless: a stranger could otherwise lock the old
/// creator before the payee is rotated. A second call fails inside Core (the authority is gone).
pub fn lock_collection_royalties(ctx: Context<LockCollectionRoyalties>) -> Result<()> {
    require!(*ctx.accounts.collection.owner == MPL_CORE_ID, ForgeError::InvalidTarget);
    let creator = ctx.accounts.config.architect;
    let bump = ctx.accounts.config.bumps[4];
    let seeds: &[&[&[u8]]] = &[&[SEED_ART_AUTHORITY, &[bump]]];
    let core = ctx.accounts.core_program.to_account_info();
    let collection = ctx.accounts.collection.to_account_info();
    let payer = ctx.accounts.architect.to_account_info();
    let authority = ctx.accounts.artifact_authority.to_account_info();
    let sys = ctx.accounts.system_program.to_account_info();
    core_cpi::update_collection_royalties(&core, &collection, &payer, &authority, &sys, &creator, seeds)?;
    core_cpi::lock_collection_royalties(&core, &collection, &payer, &authority, &sys, seeds)?;
    emit!(CollectionRoyaltiesLocked { collection: collection.key(), creator });
    Ok(())
}

#[cfg(test)]
mod market_tests {
    use super::*;
    use anchor_lang::{Discriminator, InstructionData};

    fn code(r: Result<impl Sized>) -> u32 {
        match r {
            Err(anchor_lang::error::Error::AnchorError(e)) => e.error_code_number,
            Err(e) => panic!("unexpected error {e:?}"),
            Ok(_) => 0,
        }
    }
    const BELOW_FLOOR: u32 = 6080;
    const INVALID_EXPIRY: u32 = 6081;
    const LISTING_ACTIVE: u32 = 6086;

    #[test]
    fn min_price_applies_at_backing_zero() {
        // Genesis Lunar Dust has no floor: MARKET_MIN_PRICE (0.1 XNT) is the only bound
        assert_eq!(check_price(MARKET_MIN_PRICE, 0).unwrap(), 93_000_000);
        assert_eq!(code(check_price(MARKET_MIN_PRICE - 1, 0)), BELOW_FLOOR);
        assert_eq!(code(check_price(0, 0)), BELOW_FLOOR);
        // a tiny floor still needs the minimum price
        assert_eq!(code(check_price(MARKET_MIN_PRICE - 1, 1)), BELOW_FLOOR);
        assert_eq!(check_price(MARKET_MIN_PRICE, 1).unwrap(), 93_000_000);
    }

    /// Proposal unit sketch: for every floor, the smallest accepted price p has seller_net(p) >= backing and
    /// seller_net(p - 1) < backing (or p is the 0.1 XNT minimum), and check_price agrees with market_split.
    #[test]
    fn floor_boundary_per_backing() {
        let mut floors: Vec<u64> = vec![0, 1, 5 * XNT, 12_500_000_000, 30 * XNT, 100 * XNT, 93_000_000, 93_000_001];
        floors.extend(ARTIFACT_PRICE.iter().map(|b| b / 2));
        let mut x: u64 = 0xD1B5_4A32_D192_ED03;
        for _ in 0..2_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            floors.push(x % (500 * XNT));
        }
        for backing in floors {
            // net(p) = p - floor(5% p) - floor(2% p) is non-decreasing in p: search the first p with net >= backing
            let est = ((backing as u128 * BPS as u128) / (BPS - MARKET_ROYALTY_BPS - MARKET_POOL_BPS) as u128) as u64;
            let mut p = est.saturating_sub(64).max(MARKET_MIN_PRICE);
            while market_split(p).unwrap().2 < backing {
                p += 1;
            }
            assert_eq!(check_price(p, backing).unwrap(), market_split(p).unwrap().2, "backing {backing}");
            // one lamport less fails: on the floor, or on the 0.1 XNT minimum when that is what binds
            assert_eq!(code(check_price(p - 1, backing)), BELOW_FLOOR, "backing {backing}");
        }
    }

    /// WORK-PACKAGES "wash >= 3.76%": at the lowest list price of every tier (floor = 50% of base) the two fees,
    /// which a wash trade between one's own wallets pays and never gets back, are at least 3.76% of base; above the
    /// 0.1 XNT minimum the fees are 7% of the price (each floored once, so at most 2 lamports short).
    #[test]
    fn wash_trade_costs_at_least_3_76_percent_of_base() {
        for base in ARTIFACT_PRICE {
            let backing = base / 2;
            // net >= 93% of p - 0 and <= 93% of p + 2: start just below the exact boundary and walk up
            let mut p = ((backing as u128 * BPS as u128) / (BPS - MARKET_ROYALTY_BPS - MARKET_POOL_BPS) as u128) as u64 - 64;
            assert!(check_price(p, backing).is_err());
            while check_price(p, backing).is_err() {
                p += 1;
            }
            let (r, f, _) = market_split(p).unwrap();
            assert!((r + f) as u128 * BPS as u128 >= 376 * base as u128, "base {base}: fees {}", r + f);
        }
        let mut x: u64 = 0x2545_F491_4F6C_DD1D;
        for _ in 0..200_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let price = MARKET_MIN_PRICE + x % (10_000 * XNT);
            let (r, f, n) = market_split(price).unwrap();
            assert_eq!(r + f + n, price);
            let exact = price as u128 * (MARKET_ROYALTY_BPS + MARKET_POOL_BPS) as u128 / BPS as u128;
            assert!((r + f) as u128 + 2 >= exact && (r + f) as u128 <= exact, "price {price}");
        }
        // the pool share (2%) is never zero at a valid price, the royalty (5%) neither
        let (r, f, _) = market_split(MARKET_MIN_PRICE).unwrap();
        assert_eq!((r, f), (5_000_000, 2_000_000));
    }

    #[test]
    fn expiry_window() {
        let now = 1_800_000_000i64;
        check_expiry(now + 1, now).unwrap();
        check_expiry(now + MARKET_MAX_LISTING, now).unwrap();
        assert_eq!(code(check_expiry(now, now)), INVALID_EXPIRY);
        assert_eq!(code(check_expiry(now - 1, now)), INVALID_EXPIRY);
        assert_eq!(code(check_expiry(0, now)), INVALID_EXPIRY); // 0 = "no expiry" is not allowed
        assert_eq!(code(check_expiry(now + MARKET_MAX_LISTING + 1, now)), INVALID_EXPIRY);
        assert_eq!(code(check_expiry(now + MARKET_MAX_LISTING / 90 * 91, now)), INVALID_EXPIRY); // 91 days
        assert_eq!(code(check_expiry(i64::MAX, i64::MAX - 1)), 0); // saturating, no overflow
        assert_eq!(code(check_expiry(i64::MAX, i64::MAX)), INVALID_EXPIRY);
    }

    #[test]
    fn private_sale_and_public_listing() {
        let (a, b) = (Pubkey::new_from_array([1; 32]), Pubkey::new_from_array([2; 32]));
        assert!(buyer_allowed(&Pubkey::default(), &a));
        assert!(buyer_allowed(&Pubkey::default(), &b));
        assert!(buyer_allowed(&a, &a));
        assert!(!buyer_allowed(&a, &b));
    }

    /// Delegate invalidation: a transfer or a recycle makes the listing stale (reason 1, wins over expiry); an
    /// expired one closes with reason 2; a live one only through the seller's delist.
    #[test]
    fn close_listing_reasons() {
        assert_eq!(close_reason(true, false).unwrap(), 1);
        assert_eq!(close_reason(true, true).unwrap(), 1);
        assert_eq!(close_reason(false, true).unwrap(), 2);
        assert_eq!(code(close_reason(false, false)), LISTING_ACTIVE);
    }

    /// SPEC §4 rows 76-81 and Appendix B: discriminators and instruction data sizes (incl. the 8-byte discriminator).
    #[test]
    fn instruction_discriminators_and_sizes() {
        use crate::instruction as ix;
        let pk = Pubkey::new_from_array([7; 32]);
        let rows: [(&[u8], &str, usize); 6] = [
            (
                ix::ListArtifact::DISCRIMINATOR,
                "cc5d207ecfb57934",
                ix::ListArtifact { price: 1, expires_at: 2, reserved_buyer: pk, add_plugin: true }.data().len(),
            ),
            (
                ix::UpdateListing::DISCRIMINATOR,
                "c0aed2447428f2fd",
                ix::UpdateListing { price: 1, expires_at: 2, reserved_buyer: pk }.data().len(),
            ),
            (ix::DelistArtifact::DISCRIMINATOR, "4ec76a452810c72d", ix::DelistArtifact {}.data().len()),
            (ix::BuyArtifact::DISCRIMINATOR, "94a0a21e61febd83", ix::BuyArtifact { price: 1 }.data().len()),
            (ix::CloseListing::DISCRIMINATOR, "210fc0514eaf9f61", ix::CloseListing {}.data().len()),
            (ix::LockCollectionRoyalties::DISCRIMINATOR, "fd270f1e834f3147", ix::LockCollectionRoyalties {}.data().len()),
        ];
        let sizes = [57usize, 56, 8, 16, 8, 8];
        for ((d, want, len), size) in rows.iter().zip(sizes) {
            let hex: String = d.iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(&hex, want);
            assert_eq!(*len, size, "{want}");
        }
        let data = ix::ListArtifact { price: 1, expires_at: 2, reserved_buyer: pk, add_plugin: true }.data();
        assert_eq!(&data[8..16], &1u64.to_le_bytes());
        assert_eq!(&data[16..24], &2i64.to_le_bytes());
        assert_eq!(&data[24..56], pk.as_ref());
        assert_eq!(data[56], 1);
    }

    /// Listing golden offsets (seller@40 and tier@128 are the frontend memcmp filters).
    #[test]
    fn listing_offsets() {
        let l = Listing {
            asset: Pubkey::new_from_array([1; 32]),
            seller: Pubkey::new_from_array([2; 32]),
            reserved_buyer: Pubkey::new_from_array([3; 32]),
            price: 0x0102_0304_0506_0708,
            created_at: 11,
            expires_at: 12,
            tier: 4,
            bump: 254,
        };
        let mut buf = Vec::new();
        l.try_serialize(&mut buf).unwrap();
        assert_eq!(buf.len(), 130);
        assert_eq!(&buf[..8], Listing::DISCRIMINATOR);
        assert_eq!(&buf[8..40], &[1; 32]);
        assert_eq!(&buf[40..72], &[2; 32]);
        assert_eq!(&buf[72..104], &[3; 32]);
        assert_eq!(&buf[104..112], &0x0102_0304_0506_0708u64.to_le_bytes());
        assert_eq!(&buf[112..120], &11i64.to_le_bytes());
        assert_eq!(&buf[120..128], &12i64.to_le_bytes());
        assert_eq!(buf[128], 4);
        assert_eq!(buf[129], 254);
    }
}
