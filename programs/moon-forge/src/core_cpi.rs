//! Minimal hand-written CPI to Metaplex Core (CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d).
//! The official `mpl-core` crate pins a different Anchor/borsh version, so we encode the
//! three instructions we need directly from the published IDL:
//!   CreateV1 (0), CreateCollectionV1 (1), BurnV1 (12).
//! Optional accounts that are "None" are passed as the Core program id (Shank convention).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::constants::*;
use crate::errors::ForgeError;

const IX_CREATE_V1: u8 = 0;
const IX_CREATE_COLLECTION_V1: u8 = 1;
const IX_BURN_V1: u8 = 12;

const PLUGIN_ROYALTIES: u8 = 0;
const PLUGIN_ATTRIBUTES: u8 = 6;

const KEY_ASSET_V1: u8 = 1;
const UA_COLLECTION: u8 = 2;

fn put_str(buf: &mut Vec<u8>, s: &str) {
    buf.extend_from_slice(&(s.len() as u32).to_le_bytes());
    buf.extend_from_slice(s.as_bytes());
}

/// PluginAuthorityPair { plugin: Royalties {...}, authority: None }
fn royalties_plugin(buf: &mut Vec<u8>, basis_points: u16, creator: &Pubkey) {
    buf.push(PLUGIN_ROYALTIES);
    buf.extend_from_slice(&basis_points.to_le_bytes());
    buf.extend_from_slice(&1u32.to_le_bytes()); // creators: vec len 1
    buf.extend_from_slice(creator.as_ref());
    buf.push(100); // percentage
    buf.push(0); // RuleSet::None
    buf.push(0); // authority: None (defaults to update authority = our PDA)
}

/// PluginAuthorityPair { plugin: Attributes { attribute_list }, authority: None }
fn attributes_plugin(buf: &mut Vec<u8>, attrs: &[(&str, String)]) {
    buf.push(PLUGIN_ATTRIBUTES);
    buf.extend_from_slice(&(attrs.len() as u32).to_le_bytes());
    for (k, v) in attrs {
        put_str(buf, k);
        put_str(buf, v);
    }
    buf.push(0); // authority: None
}

pub fn create_collection<'info>(
    core_program: &AccountInfo<'info>,
    collection: &AccountInfo<'info>,
    update_authority: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    uri: &str,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    require_keys_eq!(*core_program.key, MPL_CORE_ID, ForgeError::InvalidTarget);
    let mut data = vec![IX_CREATE_COLLECTION_V1];
    put_str(&mut data, COLLECTION_NAME);
    put_str(&mut data, uri);
    data.push(1); // plugins: Some
    data.extend_from_slice(&1u32.to_le_bytes());
    royalties_plugin(&mut data, SECONDARY_ROYALTY_BPS, &ARCHITECT);

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
    let mut data = vec![IX_CREATE_V1];
    data.push(0); // DataState::AccountState
    put_str(&mut data, name);
    put_str(&mut data, uri);
    data.push(1); // plugins: Some
    data.extend_from_slice(&1u32.to_le_bytes());
    attributes_plugin(&mut data, attrs);

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

/// Burns an asset. `owner` must be a signer of the outer transaction.
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
