//! Minimal hand-written CPI to Metaplex Core (CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d).
//! The official `mpl-core` crate pins a different Anchor/borsh version, so we encode the
//! instructions we need directly from the published IDL (enum order of mpl-core @4e67f52 `instruction.rs`):
//!   CreateV1 (0), CreateCollectionV1 (1), AddPluginV1 (2), UpdateCollectionPluginV1 (7),
//!   ApprovePluginAuthorityV1 (8), ApproveCollectionPluginAuthorityV1 (9), RevokePluginAuthorityV1 (10),
//!   BurnV1 (12), TransferV1 (14), UpdateCollectionV1 (16).
//! Optional accounts that are "None" are passed as the Core program id (Shank convention).
//! Every byte layout is confirmed on localnet against the Core binary dumped from X1 (not Solana's).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::constants::*;
use crate::errors::ForgeError;

const IX_CREATE_V1: u8 = 0;
const IX_CREATE_COLLECTION_V1: u8 = 1;
const IX_ADD_PLUGIN_V1: u8 = 2;
const IX_UPDATE_COLLECTION_PLUGIN_V1: u8 = 7;
const IX_APPROVE_PLUGIN_AUTHORITY_V1: u8 = 8;
const IX_APPROVE_COLLECTION_PLUGIN_AUTHORITY_V1: u8 = 9;
const IX_REVOKE_PLUGIN_AUTHORITY_V1: u8 = 10;
const IX_BURN_V1: u8 = 12;
const IX_TRANSFER_V1: u8 = 14;
const IX_UPDATE_COLLECTION_V1: u8 = 16;

/// Plugin / PluginType enum indices
const PLUGIN_ROYALTIES: u8 = 0;
const PLUGIN_TRANSFER_DELEGATE: u8 = 3;
const PLUGIN_ATTRIBUTES: u8 = 6;
/// PluginAuthority enum: None (0) = the plugin's default authority, Address (3) = a given key
const AUTH_NONE: u8 = 0;
const AUTH_ADDRESS: u8 = 3;

const KEY_ASSET_V1: u8 = 1;
const UA_COLLECTION: u8 = 2;

fn put_str(buf: &mut Vec<u8>, s: &str) {
    buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
    buf.extend_from_slice(s.as_bytes());
}

/// Plugin::Royalties { basis_points, creators: [{ creator, 100 }], rule_set: None } (a Plugin, no authority byte).
fn royalties_body(buf: &mut Vec<u8>, basis_points: u16, creator: &Pubkey) {
    buf.push(PLUGIN_ROYALTIES);
    buf.extend_from_slice(&basis_points.to_le_bytes());
    buf.extend_from_slice(&1u32.to_le_bytes()); // creators: vec len 1
    buf.extend_from_slice(creator.as_ref());
    buf.push(100); // percentage
    buf.push(0); // RuleSet::None
}

/// PluginAuthorityPair { plugin: Royalties {...}, authority: None }
fn royalties_plugin(buf: &mut Vec<u8>, basis_points: u16, creator: &Pubkey) {
    royalties_body(buf, basis_points, creator);
    buf.push(AUTH_NONE); // authority: None (defaults to update authority = our PDA)
}

/// PluginAuthorityPair { plugin: Attributes { attribute_list }, authority: None }
fn attributes_plugin(buf: &mut Vec<u8>, attrs: &[(&str, String)]) {
    buf.push(PLUGIN_ATTRIBUTES);
    buf.extend_from_slice(&(attrs.len() as u32).to_le_bytes());
    for (k, v) in attrs {
        put_str(buf, k);
        put_str(buf, v);
    }
    buf.push(AUTH_NONE); // authority: None
}

/// At mint: PluginAuthorityPair { plugin: TransferDelegate {}, authority: None (= Owner) }. +11 B per asset.
fn transfer_delegate_plugin(buf: &mut Vec<u8>) {
    buf.push(PLUGIN_TRANSFER_DELEGATE);
    buf.push(AUTH_NONE);
}

pub fn create_collection<'info>(
    core_program: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    update_authority: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    uri: &str,
    creator: &Pubkey,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(*core_program.key, MPL_CORE_ID, ForgeError::InvalidTarget);
    let mut data = vec![IX_CREATE_COLLECTION_V1];
    put_str(&mut data, COLLECTION_NAME);
    put_str(&mut data, uri);
    data.push(1); // plugins: Some
    data.extend_from_slice(&1u32.to_le_bytes());
    royalties_plugin(&mut data, SECONDARY_ROYALTY_BPS, creator);

    let ix = Instruction {
        program_id: MPL_CORE_ID,
        accounts: vec![
            AccountMeta::new(*collection.key, true),
            AccountMeta::new_readonly(*update_authority.key, false),
            AccountMeta::new(*payer.key, true),
            AccountMeta::new_readonly(*system_program.key, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            collection.clone(),
            update_authority.clone(),
            payer.clone(),
            system_program.clone(),
            core_program.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

/// CreateV1 data: plugins = [Attributes, TransferDelegate (authority Owner)].
fn create_asset_data(name: &str, uri: &str, attrs: &[(&str, String)]) -> Vec<u8> {
    let mut data = vec![IX_CREATE_V1];
    data.push(0); // DataState::AccountState
    put_str(&mut data, name);
    put_str(&mut data, uri);
    data.push(1); // plugins: Some
    data.extend_from_slice(&2u32.to_le_bytes());
    attributes_plugin(&mut data, attrs);
    transfer_delegate_plugin(&mut data);
    data
}

#[allow(clippy::too_many_arguments)]
pub fn create_asset<'info>(
    core_program: &AccountInfo<'info>,
    asset: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    name: &str,
    uri: &str,
    attrs: &[(&str, String)],
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(*core_program.key, MPL_CORE_ID, ForgeError::InvalidTarget);
    let data = create_asset_data(name, uri, attrs);

    let ix = Instruction {
        program_id: MPL_CORE_ID,
        accounts: vec![
            AccountMeta::new(*asset.key, true),
            AccountMeta::new(*collection.key, false),
            AccountMeta::new_readonly(*authority.key, true),
            AccountMeta::new(*payer.key, true),
            AccountMeta::new_readonly(*owner.key, false),
            AccountMeta::new_readonly(MPL_CORE_ID, false), // update_authority: None (inherits collection)
            AccountMeta::new_readonly(*system_program.key, false),
            AccountMeta::new_readonly(MPL_CORE_ID, false), // log_wrapper: None
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            asset.clone(),
            collection.clone(),
            authority.clone(),
            payer.clone(),
            owner.clone(),
            system_program.clone(),
            core_program.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

/// UpdateCollectionV1 { new_name: None, new_uri: Some(uri) }, signed by the collection's update
/// authority PDA. Core resizes the collection account; `payer` covers any rent difference.
pub fn update_collection_uri<'info>(
    core_program: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    update_authority: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    uri: &str,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(*core_program.key, MPL_CORE_ID, ForgeError::InvalidTarget);
    let mut data = vec![IX_UPDATE_COLLECTION_V1];
    data.push(0); // new_name: None
    data.push(1); // new_uri: Some
    put_str(&mut data, uri);

    let ix = Instruction {
        program_id: MPL_CORE_ID,
        accounts: vec![
            AccountMeta::new(*collection.key, false),
            AccountMeta::new(*payer.key, true),
            AccountMeta::new_readonly(*update_authority.key, true),
            AccountMeta::new_readonly(MPL_CORE_ID, false), // new_update_authority: None
            AccountMeta::new_readonly(*system_program.key, false),
            AccountMeta::new_readonly(MPL_CORE_ID, false), // log_wrapper: None
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            collection.clone(),
            payer.clone(),
            update_authority.clone(),
            system_program.clone(),
            core_program.clone(),
        ],
        signer_seeds,
    )?;
    Ok(())
}

/// Burns an asset. `owner` must be a signer of the outer transaction. Core lets the owner burn regardless
/// of a TransferDelegate, so a listed Artifact can still be recycled (the listing goes stale).
pub fn burn_asset<'info>(
    core_program: &AccountInfo<'info>,
    asset: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
) -> Result<()> {
    require_keys_eq!(*core_program.key, MPL_CORE_ID, ForgeError::InvalidTarget);
    let data = vec![IX_BURN_V1, 0]; // compression_proof: None
    let ix = Instruction {
        program_id: MPL_CORE_ID,
        accounts: vec![
            AccountMeta::new(*asset.key, false),
            AccountMeta::new(*collection.key, false),
            AccountMeta::new(*payer.key, true),
            AccountMeta::new_readonly(*owner.key, true),
            AccountMeta::new_readonly(*system_program.key, false),
            AccountMeta::new_readonly(MPL_CORE_ID, false), // log_wrapper: None
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            asset.clone(),
            collection.clone(),
            payer.clone(),
            owner.clone(),
            system_program.clone(),
            core_program.clone(),
        ],
        &[],
    )?;
    Ok(())
}

/// Returns the current owner of a live Core asset that belongs to `collection`,
/// or None if the account is not (or no longer) such an asset.
/// AssetV1 layout: key u8 | owner Pubkey | update_authority (u8 tag + Pubkey) | ...
pub fn live_asset_owner(asset: &AccountInfo, collection: &Pubkey) -> Option<Pubkey> {
    if *asset.owner != MPL_CORE_ID {
        return None;
    }
    let data = asset.try_borrow_data().ok()?;
    if data.len() < 66 || data[0] != KEY_ASSET_V1 || data[33] != UA_COLLECTION {
        return None;
    }
    if data[34..66] != collection.to_bytes() {
        return None;
    }
    Some(Pubkey::new_from_array(data[1..33].try_into().ok()?))
}

// ─── final upgrade (v3): TransferDelegate (Artifact Market) and the royalty lock ───

/// Owner-signed Core call on the asset's TransferDelegate. `data` is one of:
///   approve: [8, 3, 3, listing(32)]      add: [2, 3, 1 (Some), 3, listing(32)]      revoke: [10, 3]
/// Accounts (client order): asset (w), collection (w), payer (w,s) = owner, authority = None (MPL_CORE_ID -> payer is the
/// authority), system_program, log_wrapper = None (MPL_CORE_ID).
fn owner_delegate_call<'info>(
    core: &AccountInfo<'info>,
    asset: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    data: Vec<u8>,
) -> Result<()> {
    require_keys_eq!(*core.key, MPL_CORE_ID, ForgeError::InvalidTarget);
    let ix = Instruction {
        program_id: MPL_CORE_ID,
        accounts: vec![
            AccountMeta::new(*asset.key, false),
            AccountMeta::new(*collection.key, false),
            AccountMeta::new(*owner.key, true),
            AccountMeta::new_readonly(MPL_CORE_ID, false),
            AccountMeta::new_readonly(*system_program.key, false),
            AccountMeta::new_readonly(MPL_CORE_ID, false),
        ],
        data,
    };
    invoke_signed(&ix, &[asset.clone(), collection.clone(), owner.clone(), system_program.clone(), core.clone()], &[])?;
    Ok(())
}

fn approve_delegate_data(delegate: &Pubkey) -> Vec<u8> {
    let mut d = vec![IX_APPROVE_PLUGIN_AUTHORITY_V1, PLUGIN_TRANSFER_DELEGATE, AUTH_ADDRESS];
    d.extend_from_slice(delegate.as_ref());
    d
}

fn add_delegate_data(delegate: &Pubkey) -> Vec<u8> {
    let mut d = vec![IX_ADD_PLUGIN_V1, PLUGIN_TRANSFER_DELEGATE, 1, AUTH_ADDRESS];
    d.extend_from_slice(delegate.as_ref());
    d
}

/// ApprovePluginAuthorityV1 { TransferDelegate, Address(delegate) }: the asset stays in the owner's wallet.
pub fn approve_transfer_delegate<'info>(
    core: &AccountInfo<'info>,
    asset: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    sys: &AccountInfo<'info>,
    delegate: &Pubkey,
) -> Result<()> {
    owner_delegate_call(core, asset, collection, owner, sys, approve_delegate_data(delegate))
}

/// AddPluginV1 { TransferDelegate, Some(Address(delegate)) }: only for assets minted before the final upgrade
/// (they have no TransferDelegate plugin yet).
pub fn add_transfer_delegate<'info>(
    core: &AccountInfo<'info>,
    asset: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    sys: &AccountInfo<'info>,
    delegate: &Pubkey,
) -> Result<()> {
    owner_delegate_call(core, asset, collection, owner, sys, add_delegate_data(delegate))
}

/// Owner revoke is idempotent: Address->Owner (shrinks 32 B, refund to owner) or Owner->Owner (no-op). Core always lets
/// the owner revoke an owner-managed plugin (state/asset.rs validate_revoke_plugin_authority; lifecycle.rs revoke base check).
pub fn revoke_transfer_delegate<'info>(
    core: &AccountInfo<'info>,
    asset: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    sys: &AccountInfo<'info>,
) -> Result<()> {
    owner_delegate_call(core, asset, collection, owner, sys, vec![IX_REVOKE_PLUGIN_AUTHORITY_V1, PLUGIN_TRANSFER_DELEGATE])
}

/// TransferV1 { compression_proof: None } = [14, 0], signed by the listing PDA (the TransferDelegate authority).
/// Accounts: asset (w), collection (r), payer (w,s) = buyer, authority (s) = listing, new_owner (r) = buyer,
/// system_program = None, log_wrapper = None. Core resets every owner-managed authority to Owner (transfer.rs:100-112).
pub fn transfer_as_delegate<'info>(
    core: &AccountInfo<'info>,
    asset: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    buyer: &AccountInfo<'info>,
    listing: &AccountInfo<'info>,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(*core.key, MPL_CORE_ID, ForgeError::InvalidTarget);
    let ix = Instruction {
        program_id: MPL_CORE_ID,
        accounts: vec![
            AccountMeta::new(*asset.key, false),
            AccountMeta::new_readonly(*collection.key, false),
            AccountMeta::new(*buyer.key, true),
            AccountMeta::new_readonly(*listing.key, true),
            AccountMeta::new_readonly(*buyer.key, false),
            AccountMeta::new_readonly(MPL_CORE_ID, false),
            AccountMeta::new_readonly(MPL_CORE_ID, false),
        ],
        data: vec![IX_TRANSFER_V1, 0],
    };
    invoke_signed(&ix, &[asset.clone(), collection.clone(), buyer.clone(), listing.clone(), core.clone()], seeds)?;
    Ok(())
}

/// UpdateCollectionPluginV1 { Royalties { SECONDARY_ROYALTY_BPS, creators: [creator 100%], RuleSet::None } } = [7] + the
/// plugin body, signed by the collection update authority PDA (M-1/ECO-4: the permanent declaration names
/// `config.architect`, never the owner's personal wallet). Accounts: collection (w), payer (w,s), authority (s),
/// system_program, log_wrapper = None.
pub fn update_collection_royalties<'info>(
    core: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    sys: &AccountInfo<'info>,
    creator: &Pubkey,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(*core.key, MPL_CORE_ID, ForgeError::InvalidTarget);
    let mut data = vec![IX_UPDATE_COLLECTION_PLUGIN_V1];
    royalties_body(&mut data, SECONDARY_ROYALTY_BPS, creator);
    let ix = Instruction {
        program_id: MPL_CORE_ID,
        accounts: vec![
            AccountMeta::new(*collection.key, false),
            AccountMeta::new(*payer.key, true),
            AccountMeta::new_readonly(*authority.key, true),
            AccountMeta::new_readonly(*sys.key, false),
            AccountMeta::new_readonly(MPL_CORE_ID, false),
        ],
        data,
    };
    invoke_signed(&ix, &[collection.clone(), payer.clone(), authority.clone(), sys.clone(), core.clone()], seeds)?;
    Ok(())
}

/// ApproveCollectionPluginAuthorityV1 { plugin_type: Royalties, new_authority: None } = [9, 0, 0], signed by the collection
/// update authority PDA. After it no signer can update/remove/revoke the Royalties plugin (500 bps, architect 100%, None).
pub fn lock_collection_royalties<'info>(
    core: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    sys: &AccountInfo<'info>,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(*core.key, MPL_CORE_ID, ForgeError::InvalidTarget);
    let ix = Instruction {
        program_id: MPL_CORE_ID,
        accounts: vec![
            AccountMeta::new(*collection.key, false),
            AccountMeta::new(*payer.key, true),
            AccountMeta::new_readonly(*authority.key, true),
            AccountMeta::new_readonly(*sys.key, false),
            AccountMeta::new_readonly(MPL_CORE_ID, false),
        ],
        data: vec![IX_APPROVE_COLLECTION_PLUGIN_AUTHORITY_V1, PLUGIN_ROYALTIES, AUTH_NONE],
    };
    invoke_signed(&ix, &[collection.clone(), payer.clone(), authority.clone(), sys.clone(), core.clone()], seeds)?;
    Ok(())
}

#[cfg(test)]
mod layout_tests {
    use super::*;

    /// The byte layouts of market_PROPOSAL.rs.txt / SPEC-UPGRADE-v2 §2.6 (confirmed on localnet against the X1 Core ELF).
    #[test]
    fn delegate_data_layouts() {
        let pk = Pubkey::new_from_array([9; 32]);
        let mut approve = vec![8u8, 3, 3];
        approve.extend_from_slice(&[9; 32]);
        assert_eq!(approve_delegate_data(&pk), approve);
        let mut add = vec![2u8, 3, 1, 3];
        add.extend_from_slice(&[9; 32]);
        assert_eq!(add_delegate_data(&pk), add);
        let mut td = vec![];
        transfer_delegate_plugin(&mut td);
        assert_eq!(td, vec![3, 0]);
    }

    #[test]
    fn create_asset_carries_two_plugins() {
        let attrs = vec![("Tier", "Lunar Dust".to_string())];
        let data = create_asset_data("N", "u", &attrs);
        assert_eq!(data[0], 0);
        assert_eq!(data[1], 0);
        // name (4 + 1) + uri (4 + 1) + plugins Some (1) + len (4)
        let o = 2 + 5 + 5;
        assert_eq!(data[o], 1);
        assert_eq!(&data[o + 1..o + 5], &2u32.to_le_bytes());
        assert_eq!(&data[data.len() - 2..], &[3, 0]); // TransferDelegate, authority None = Owner
        let mut only_attrs = vec![];
        attributes_plugin(&mut only_attrs, &attrs);
        assert_eq!(&data[o + 5..data.len() - 2], &only_attrs[..]);
    }

    #[test]
    fn royalties_update_is_a_plugin_without_an_authority_byte() {
        let creator = Pubkey::new_from_array([4; 32]);
        let (mut pair, mut body) = (vec![], vec![]);
        royalties_plugin(&mut pair, 500, &creator);
        royalties_body(&mut body, 500, &creator);
        assert_eq!(pair.len(), body.len() + 1);
        assert_eq!(&pair[..body.len()], &body[..]);
        assert_eq!(body[0], 0); // Plugin::Royalties
        assert_eq!(&body[1..3], &500u16.to_le_bytes());
        assert_eq!(&body[3..7], &1u32.to_le_bytes());
        assert_eq!(&body[7..39], &[4u8; 32]);
        assert_eq!(&body[39..], &[100, 0]); // 100 %, RuleSet::None
    }
}
