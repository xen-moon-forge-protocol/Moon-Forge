use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::ForgeError;

/// Keccak-256 of the concatenated parts. On-chain it uses the runtime syscall (a software hash costs
/// ~10x more compute; a 10-card deck shuffle alone needs 18 hashes); off-chain (unit tests) the sha3
/// crate. Both are the same standard Keccak-256 that the oracle and the frontend use.
#[cfg(target_os = "solana")]
pub fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    let mut out = [0u8; 32];
    // the syscall reads `parts` as an array of (pointer, length) byte slices
    unsafe {
        solana_define_syscall::definitions::sol_keccak256(parts as *const _ as *const u8, parts.len() as u64, out.as_mut_ptr());
    }
    out
}

#[cfg(not(target_os = "solana"))]
pub fn keccak(parts: &[&[u8]]) -> [u8; 32] {
    use sha3::{Digest, Keccak256};
    let mut h = Keccak256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

/// Moves lamports out of a program-owned account. `to` can be any writable account.
pub fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let from_bal = from.lamports().checked_sub(amount).ok_or(ForgeError::MathOverflow)?;
    let to_bal = to.lamports().checked_add(amount).ok_or(ForgeError::MathOverflow)?;
    **from.try_borrow_mut_lamports()? = from_bal;
    **to.try_borrow_mut_lamports()? = to_bal;
    Ok(())
}

pub fn rent_min(info: &AccountInfo) -> Result<u64> {
    Ok(Rent::get()?.minimum_balance(info.data_len()))
}

/// Lamports of a vault that are not rent and not reserved.
pub fn free_balance(vault: &AccountInfo, reserved: u64) -> Result<u64> {
    Ok(vault
        .lamports()
        .saturating_sub(rent_min(vault)?)
        .saturating_sub(reserved))
}

pub fn bps(amount: u64, bps: u64) -> Result<u64> {
    let v = (amount as u128)
        .checked_mul(bps as u128)
        .ok_or(ForgeError::MathOverflow)?
        / BPS as u128;
    u64::try_from(v).map_err(|_| error!(ForgeError::MathOverflow))
}

pub fn mul_div(a: u64, b: u64, c: u64) -> Result<u64> {
    require!(c > 0, ForgeError::MathOverflow);
    let v = (a as u128).checked_mul(b as u128).ok_or(ForgeError::MathOverflow)? / c as u128;
    u64::try_from(v).map_err(|_| error!(ForgeError::MathOverflow))
}

/// Sorted-pair keccak Merkle verification (same convention as merkletreejs `sortPairs: true`).
/// Leaves are > 64 bytes of preimage or domain-separated, so an inner node can never be a leaf.
pub fn verify_proof(proof: &[[u8; 32]], root: &[u8; 32], leaf: [u8; 32]) -> bool {
    let mut computed = leaf;
    for node in proof {
        computed = if computed <= *node {
            keccak(&[&computed, node])
        } else {
            keccak(&[node, &computed])
        };
    }
    computed == *root
}

pub enum SlotHashLookup {
    /// Hash of the first block produced at or after the target slot.
    Ready([u8; 32]),
    /// Target slot not produced yet.
    NotYet,
    /// Target slot fell out of the SlotHashes window (~512 slots, a few minutes).
    Expired,
}

/// Reads the SlotHashes sysvar without deserializing it (20 KB) and returns the hash of the
/// earliest slot >= target. The player commits to `target` before that block exists, and
/// settlement is permissionless, so nobody can choose the outcome after seeing it.
pub fn slot_hash_at_or_after(sysvar: &AccountInfo, target: u64) -> Result<SlotHashLookup> {
    require_keys_eq!(*sysvar.key, SLOT_HASHES_ID, ForgeError::InvalidTarget);
    let data = sysvar.try_borrow_data()?;
    if data.len() < 8 {
        return Ok(SlotHashLookup::NotYet);
    }
    let len = u64::from_le_bytes(data[0..8].try_into().unwrap()) as usize;
    let max = (data.len() - 8) / 40;
    let len = len.min(max);
    if len == 0 {
        return Ok(SlotHashLookup::NotYet);
    }
    let slot_at = |i: usize| -> u64 {
        let o = 8 + i * 40;
        u64::from_le_bytes(data[o..o + 8].try_into().unwrap())
    };
    // entries are sorted by slot, descending (index 0 = most recent)
    if slot_at(0) < target {
        return Ok(SlotHashLookup::NotYet);
    }
    if slot_at(len - 1) > target {
        // the oldest slot we still know is already after the target: we cannot know
        // whether the first block >= target was this one or an evicted one
        return Ok(SlotHashLookup::Expired);
    }
    // find the largest index i with slot_at(i) >= target (= smallest slot >= target)
    let (mut lo, mut hi) = (0usize, len - 1);
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        if slot_at(mid) >= target {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let o = 8 + lo * 40 + 8;
    let mut h = [0u8; 32];
    h.copy_from_slice(&data[o..o + 32]);
    Ok(SlotHashLookup::Ready(h))
}

/// Uniform random u64 derived from the slot hash and a per-bet salt.
pub fn random_u64(slot_hash: &[u8; 32], salt_a: &[u8], salt_b: &[u8]) -> u64 {
    let h = keccak(&[b"MOONFORGE_RNG", slot_hash, salt_a, salt_b]);
    u64::from_le_bytes(h[0..8].try_into().unwrap())
}

/// Anybody can send lamports to an address that does not exist yet, and `create_account`
/// refuses an address that already holds lamports. So before creating one of our PDAs we sign
/// for it and hand any such pre-funding to the payer: nobody can block an account creation.
pub fn drain_prefunded<'info>(
    pda: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    let lamports = pda.lamports();
    if lamports == 0 {
        return Ok(());
    }
    require!(*pda.owner == anchor_lang::system_program::ID && pda.data_is_empty(), ForgeError::InvalidTarget);
    anchor_lang::system_program::transfer(
        CpiContext::new_with_signer(
            system_program.clone(),
            anchor_lang::system_program::Transfer { from: pda.clone(), to: to.clone() },
            &[seeds],
        ),
        lamports,
    )
}

/// Where the architect's cut goes: the architect, unless that wallet was emptied below rent
/// exemption (then a tiny credit would be refused and block play): then the reward pool.
pub fn architect_or_pool<'a, 'info>(
    architect: &'a AccountInfo<'info>,
    reward_vault: &'a AccountInfo<'info>,
    amount: u64,
) -> Result<&'a AccountInfo<'info>> {
    let min = Rent::get()?.minimum_balance(0);
    Ok(if architect.lamports().saturating_add(amount) >= min { architect } else { reward_vault })
}

/// Creates a program-owned zero-data vault PDA if it does not exist yet.
pub fn ensure_vault<'info>(
    vault: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    seeds: &[&[u8]],
    program_id: &Pubkey,
) -> Result<()> {
    if vault.lamports() > 0 && vault.owner == program_id {
        return Ok(());
    }
    drain_prefunded(vault, payer, system_program, seeds)?;
    let space: u64 = 8;
    let lamports = Rent::get()?.minimum_balance(space as usize);
    anchor_lang::system_program::create_account(
        CpiContext::new_with_signer(
            system_program.clone(),
            anchor_lang::system_program::CreateAccount {
                from: payer.clone(),
                to: vault.clone(),
            },
            &[seeds],
        ),
        lamports,
        space,
        program_id,
    )
}

/// Pays `amount` to a wallet. If the wallet would end below the rent-exempt minimum
/// (fresh wallet + tiny amount), the payment is credited to the game balance instead.
pub fn pay_wallet_or_balance<'info>(
    from: &AccountInfo<'info>,
    wallet: &AccountInfo<'info>,
    player_state_info: &AccountInfo<'info>,
    player_balance: &mut u64,
    amount: u64,
) -> Result<bool> {
    let min = Rent::get()?.minimum_balance(0);
    if wallet.lamports().saturating_add(amount) >= min {
        move_lamports(from, wallet, amount)?;
        Ok(true)
    } else {
        move_lamports(from, player_state_info, amount)?;
        *player_balance = player_balance.checked_add(amount).ok_or(ForgeError::MathOverflow)?;
        Ok(false)
    }
}

/// Splits a P2P rake (2%) into pool / architect / draw.
pub fn split_rake<'info>(
    from: &AccountInfo<'info>,
    reward_vault: &AccountInfo<'info>,
    architect: &AccountInfo<'info>,
    draw_vault: &AccountInfo<'info>,
    pot: u64,
) -> Result<(u64, u64, u64)> {
    let mut to_pool = bps(pot, RAKE_TO_POOL_BPS)?;
    let mut to_arch = bps(pot, RAKE_TO_ARCHITECT_BPS)?;
    let to_draw = bps(pot, P2P_RAKE_BPS)?
        .checked_sub(to_pool + to_arch)
        .ok_or(ForgeError::MathOverflow)?;
    if architect_or_pool(architect, reward_vault, to_arch)?.key == reward_vault.key {
        to_pool += to_arch;
        to_arch = 0;
    }
    move_lamports(from, reward_vault, to_pool)?;
    move_lamports(from, architect, to_arch)?;
    move_lamports(from, draw_vault, to_draw)?;
    Ok((to_pool, to_arch, to_draw))
}

pub fn current_week(now: i64) -> i64 {
    now / WEEK
}
