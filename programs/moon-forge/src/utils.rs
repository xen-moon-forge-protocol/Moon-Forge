use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::ForgeError;

/// Keccak-256 of the concatenated parts. On-chain it uses the runtime syscall (a software hash costs
/// ~10x more compute; a 10-card deck shuffle alone needs 18 hashes); off-chain (unit tests) the sha3
/// crate. Both are the same standard Keccak-256 that the oracle and the frontend use. FROZEN.
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

#[allow(dead_code)] // the slot of the entry is kept for completeness (the beacon that used it was not written)
enum SlotEntry {
    Found(u64, [u8; 32]),
    NotYet,
    Expired,
}

/// First produced slot >= target in a SlotHashes buffer (u64 count | (slot u64, hash 32) newest first).
fn entry_at_or_after(data: &[u8], target: u64) -> SlotEntry {
    if data.len() < 8 {
        return SlotEntry::NotYet;
    }
    let len = (u64::from_le_bytes(data[0..8].try_into().unwrap()) as usize).min((data.len() - 8) / 40);
    if len == 0 {
        return SlotEntry::NotYet;
    }
    let slot_at = |i: usize| -> u64 {
        let o = 8 + i * 40;
        u64::from_le_bytes(data[o..o + 8].try_into().unwrap())
    };
    // entries are sorted by slot, descending (index 0 = most recent)
    if slot_at(0) < target {
        return SlotEntry::NotYet;
    }
    if slot_at(len - 1) > target {
        // the oldest slot we still know is already after the target: we cannot know
        // whether the first block >= target was this one or an evicted one
        return SlotEntry::Expired;
    }
    // find the largest index i with slot_at(i) >= target (= smallest slot >= target)
    let (mut lo, mut hi) = (0usize, len - 1);
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        if slot_at(mid) >= target {
            lo = mid
        } else {
            hi = mid - 1
        }
    }
    let o = 8 + lo * 40 + 8;
    let mut h = [0u8; 32];
    h.copy_from_slice(&data[o..o + 32]);
    SlotEntry::Found(slot_at(lo), h)
}

/// Pure form of `slot_hash_at_or_after` on a SlotHashes buffer. Byte-identical to the pre-upgrade algorithm.
pub(crate) fn lookup_in(data: &[u8], target: u64) -> SlotHashLookup {
    match entry_at_or_after(data, target) {
        SlotEntry::Found(_, h) => SlotHashLookup::Ready(h),
        SlotEntry::NotYet => SlotHashLookup::NotYet,
        SlotEntry::Expired => SlotHashLookup::Expired,
    }
}

/// The SlotHashes time fallback (r9): a target more than SLOT_HASH_MAX_AGE slots before `slot` is Expired, whatever
/// the sysvar answered. On a working chain the target left SlotHashes long before, so the answer is unchanged.
pub(crate) fn age_limited(lookup: SlotHashLookup, target: u64, slot: u64) -> SlotHashLookup {
    if slot > target.saturating_add(SLOT_HASH_MAX_AGE) {
        SlotHashLookup::Expired
    } else {
        lookup
    }
}

/// Reads the SlotHashes sysvar without deserializing it (20 KB) and returns the hash of the
/// earliest slot >= target. The player commits to `target` before that block exists, and
/// settlement is permissionless, so nobody can choose the outcome after seeing it.
/// Every caller (anchor_bet, refund_stalled_bet, settle_jackpot_v2 and the legacy settle_bet, settle_jackpot,
/// settle_draw, start_war, seal_drop) gets the time fallback: a target older than SLOT_HASH_MAX_AGE takes the caller's
/// existing Expired path even if the sysvar stopped answering for it.
pub fn slot_hash_at_or_after(sysvar: &AccountInfo, target: u64) -> Result<SlotHashLookup> {
    require_keys_eq!(*sysvar.key, SLOT_HASHES_ID, ForgeError::InvalidTarget);
    let lookup = lookup_in(&sysvar.try_borrow_data()?, target);
    Ok(age_limited(lookup, target, Clock::get()?.slot))
}

/// Uniform random u64 derived from the slot hash (or the keeper's reveal) and a per-bet salt. FROZEN.
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
/// Also what makes `set_architect(reward_vault)` a working renounce: the vault always holds rent.
pub fn architect_or_pool<'a, 'info>(
    architect: &'a AccountInfo<'info>,
    reward_vault: &'a AccountInfo<'info>,
    amount: u64,
) -> Result<&'a AccountInfo<'info>> {
    let min = Rent::get()?.minimum_balance(0);
    Ok(if architect.lamports().saturating_add(amount) >= min { architect } else { reward_vault })
}

/// Creates a program-owned zero-data vault PDA if it does not exist yet (reward_vault, bankroll_vault,
/// draw_vault, extra_vault).
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

/// Splits a P2P rake (2%) into pool / architect / draw. The draw share is 0 since the final upgrade
/// (RAKE_TO_POOL_BPS 150: the former lottery share goes to the base pot). The pool takes rake − architect, so the
/// floor-rounding remainder (0 or 1 lamport) also goes to the base pot, never to draw_vault. `to_draw` stays in the
/// return tuple for the stats.
pub fn split_rake<'info>(
    from: &AccountInfo<'info>,
    reward_vault: &AccountInfo<'info>,
    architect: &AccountInfo<'info>,
    draw_vault: &AccountInfo<'info>,
    pot: u64,
) -> Result<(u64, u64, u64)> {
    let (mut to_pool, mut to_arch) = rake_parts(pot)?;
    let to_draw = 0u64;
    if architect_or_pool(architect, reward_vault, to_arch)?.key == reward_vault.key {
        to_pool += to_arch;
        to_arch = 0;
    }
    move_lamports(from, reward_vault, to_pool)?;
    move_lamports(from, architect, to_arch)?;
    move_lamports(from, draw_vault, to_draw)?;
    Ok((to_pool, to_arch, to_draw))
}

/// (to_pool, to_architect) of a P2P rake: the architect takes floor(0.5%), the pool the rest of floor(2%), so the
/// two always sum to the whole rake and no rounding lamport is left over for draw_vault.
pub fn rake_parts(pot: u64) -> Result<(u64, u64)> {
    let rake = bps(pot, P2P_RAKE_BPS)?;
    let to_arch = bps(pot, RAKE_TO_ARCHITECT_BPS)?;
    let to_pool = rake.checked_sub(to_arch).ok_or(ForgeError::MathOverflow)?;
    Ok((to_pool, to_arch))
}

pub fn current_week(now: i64) -> i64 {
    now / WEEK
}

// ─── final upgrade (v3): pure helpers ───────────────────────────────────────

/// Seat bond: SEAT_BOND_BPS of the free pool, at least SEAT_BOND_MIN.
pub fn seat_bond(free: u64) -> u64 {
    ((free as u128 * SEAT_BOND_BPS as u128 / BPS as u128) as u64).max(SEAT_BOND_MIN)
}

/// Void bond: VOID_BOND_BPS of the epoch's full budget, at least VOID_BOND_MIN.
pub fn void_bond(full_budget: u64) -> u64 {
    ((full_budget as u128 * VOID_BOND_BPS as u128 / BPS as u128) as u64).max(VOID_BOND_MIN)
}

/// (royalty, pool_fee, seller_net). Floors like `bps`. The buyer pays `price` exactly.
pub fn market_split(price: u64) -> Result<(u64, u64, u64)> {
    let royalty = bps(price, MARKET_ROYALTY_BPS)?;
    let pool_fee = bps(price, MARKET_POOL_BPS)?;
    Ok((royalty, pool_fee, price - royalty - pool_fee))
}

/// v2 bet / v3 Jackpot draw: keeper-chain position in bits 40..63, anchor slot in bits 0..39.
pub fn bet_pack(index: u64, anchor: u64) -> u64 {
    (index << BET_SLOT_BITS) | (anchor & BET_SLOT_MASK)
}

/// (index, anchor) of a packed `target_slot`.
pub fn bet_unpack(ts: u64) -> (u64, u64) {
    (ts >> BET_SLOT_BITS, ts & BET_SLOT_MASK)
}

#[cfg(test)]
mod rng_tests {
    use super::*;

    /// A synthetic SlotHashes buffer: u64 count, then (slot, hash) newest first, hash(slot) = keccak("SLOT" ‖ slot_le).
    fn buffer(slots: &[u64]) -> Vec<u8> {
        let mut sorted = slots.to_vec();
        sorted.sort_unstable_by(|a, b| b.cmp(a));
        let mut out = (sorted.len() as u64).to_le_bytes().to_vec();
        for s in sorted {
            out.extend_from_slice(&s.to_le_bytes());
            out.extend_from_slice(&keccak(&[b"SLOT", &s.to_le_bytes()]));
        }
        out
    }

    /// The pre-upgrade algorithm (utils.rs before the final upgrade), kept here as the reference.
    fn reference(data: &[u8], target: u64) -> Option<Option<[u8; 32]>> {
        if data.len() < 8 {
            return Some(None);
        }
        let len = u64::from_le_bytes(data[0..8].try_into().unwrap()) as usize;
        let max = (data.len() - 8) / 40;
        let len = len.min(max);
        if len == 0 {
            return Some(None);
        }
        let slot_at = |i: usize| -> u64 {
            let o = 8 + i * 40;
            u64::from_le_bytes(data[o..o + 8].try_into().unwrap())
        };
        if slot_at(0) < target {
            return Some(None); // NotYet
        }
        if slot_at(len - 1) > target {
            return None; // Expired
        }
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
        Some(Some(h))
    }

    fn same(a: &SlotHashLookup, b: Option<Option<[u8; 32]>>) -> bool {
        match (a, b) {
            (SlotHashLookup::Ready(h), Some(Some(r))) => *h == r,
            (SlotHashLookup::NotYet, Some(None)) => true,
            (SlotHashLookup::Expired, None) => true,
            _ => false,
        }
    }

    #[test]
    fn lookup_in_equals_the_pre_upgrade_algorithm() {
        // slots 1000..1511 with a gap at 1200..1210 and a few single holes
        let slots: Vec<u64> = (1000u64..1512).filter(|s| !(1200..=1210).contains(s) && *s != 1300 && *s != 1499).collect();
        let data = buffer(&slots);
        for target in [0u64, 999, 1000, 1001, 1199, 1200, 1205, 1210, 1211, 1299, 1300, 1301, 1498, 1499, 1500, 1510, 1511, 1512, 9999] {
            let got = lookup_in(&data, target);
            assert!(same(&got, reference(&data, target)), "target {target}");
        }
        assert!(matches!(lookup_in(&data, 999), SlotHashLookup::Expired));
        assert!(matches!(lookup_in(&data, 1512), SlotHashLookup::NotYet));
        match lookup_in(&data, 1205) {
            SlotHashLookup::Ready(h) => assert_eq!(h, keccak(&[b"SLOT", &1211u64.to_le_bytes()])),
            _ => panic!("gap target must resolve to the first later block"),
        }
        match lookup_in(&data, 1000) {
            SlotHashLookup::Ready(h) => assert_eq!(h, keccak(&[b"SLOT", &1000u64.to_le_bytes()])),
            _ => panic!(),
        }
        // degenerate buffers
        assert!(matches!(lookup_in(&[], 5), SlotHashLookup::NotYet));
        assert!(matches!(lookup_in(&0u64.to_le_bytes(), 5), SlotHashLookup::NotYet));
        // a count larger than the buffer is clamped
        let mut short = buffer(&[10, 11, 12]);
        short[0..8].copy_from_slice(&100u64.to_le_bytes());
        assert!(same(&lookup_in(&short, 11), reference(&short, 11)));
    }

    /// r9 SlotHashes time fallback: (1) on a working chain (a full 512-entry window ending at slot - 1) the fallback
    /// never changes an answer, whatever the skipped slots; (2) a sysvar that stopped answering (emptied, stale, never
    /// reaching the target) yields Expired once the clock is more than SLOT_HASH_MAX_AGE past the target, and not one
    /// slot before.
    #[test]
    fn slot_hash_time_fallback() {
        #[cfg(not(feature = "localnet"))]
        assert_eq!(SLOT_HASH_MAX_AGE, 235_000); // mainnet: KEEPER_STALL_SLOTS, about a day
        let max = SLOT_HASH_MAX_AGE;
        let tag = |l: &SlotHashLookup| match l {
            SlotHashLookup::Ready(h) => Some(*h),
            SlotHashLookup::NotYet => None,
            SlotHashLookup::Expired => Some([0xee; 32]),
        };
        // (1) working chain: at clock slot `now` the window holds the 512 produced slots before it
        for (start, step) in [(10_000_000u64, 1u64), (20_000_000, 3), (30_000_000, 400)] {
            let slots: Vec<u64> = (0..512u64).map(|i| start + i * step).collect();
            let now = slots[511] + 1;
            let data = buffer(&slots);
            for target in [0, start - 1, start, start + step / 2, slots[300], slots[511], now, now + 5, now.saturating_sub(max + 1)] {
                let raw = lookup_in(&data, target);
                let aged = age_limited(lookup_in(&data, target), target, now);
                assert_eq!(tag(&aged), tag(&raw), "working chain, step {step}, target {target}");
            }
        }
        // (2) the sysvar stopped answering: empty, zero count, or stale (its newest entry before the target)
        let stale = buffer(&(1000u64..1512).collect::<Vec<_>>());
        for data in [vec![], 0u64.to_le_bytes().to_vec(), stale.clone()] {
            let target = 5_000u64;
            assert!(matches!(lookup_in(&data, target), SlotHashLookup::NotYet));
            assert!(matches!(age_limited(lookup_in(&data, target), target, target + max), SlotHashLookup::NotYet));
            assert!(matches!(age_limited(lookup_in(&data, target), target, target + max + 1), SlotHashLookup::Expired));
            assert!(matches!(age_limited(lookup_in(&data, target), target, u64::MAX), SlotHashLookup::Expired));
        }
        // a stale window that still holds the target (no longer updated): Ready until the age limit, then Expired, so a
        // keeper bet or a Jackpot round anchored there no longer waits on a keeper that may never come
        assert!(matches!(age_limited(lookup_in(&stale, 1200), 1200, 1200 + max), SlotHashLookup::Ready(_)));
        assert!(matches!(age_limited(lookup_in(&stale, 1200), 1200, 1200 + max + 1), SlotHashLookup::Expired));
        // no overflow near u64::MAX
        assert!(matches!(age_limited(SlotHashLookup::NotYet, u64::MAX - 1, u64::MAX), SlotHashLookup::NotYet));
    }

    #[test]
    fn random_u64_is_pinned() {
        assert_eq!(random_u64(&[0; 32], b"A", b"B"), 12159564258722668737);
    }
}

#[cfg(test)]
mod helper_tests {
    use super::*;

    #[test]
    fn seat_bond_floor_and_rate() {
        assert_eq!(seat_bond(0), XNT);
        assert_eq!(seat_bond(5 * XNT), XNT);
        assert_eq!(seat_bond(100 * XNT), 10 * XNT);
    }

    #[test]
    fn void_bond_floor_and_rate() {
        assert_eq!(void_bond(400_000_000), 50_000_000);
        assert_eq!(void_bond(100 * XNT), 10 * XNT);
        assert_eq!(void_bond(0), VOID_BOND_MIN);
    }

    #[test]
    fn market_split_vector_and_sum() {
        assert_eq!(market_split(10 * XNT).unwrap(), (500_000_000, 200_000_000, 9_300_000_000));
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        for _ in 0..1_000_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let price = x % (100_000 * XNT);
            let (r, p, n) = market_split(price).unwrap();
            assert_eq!(r + p + n, price);
            assert!(r <= price / 20 && p <= price / 50);
        }
        // the lowest list price that still pays the floor: net = 93% of price >= backing (= 50% of base) -> 53.76% of base
        for base in ARTIFACT_PRICE {
            let backing = base / 2;
            let est = (backing as u128 * BPS as u128).div_ceil((BPS - MARKET_ROYALTY_BPS - MARKET_POOL_BPS) as u128) as u64;
            // the fees floor, so the exact minimum sits a few lamports around the estimate
            let min_price = (est - 10..=est).find(|p| market_split(*p).unwrap().2 >= backing).unwrap();
            assert!(market_split(est).unwrap().2 >= backing);
            assert!(market_split(est - 10).unwrap().2 < backing);
            let pct = min_price as u128 * 10_000 / base as u128;
            assert!((5376..=5377).contains(&pct), "{pct}");
        }
    }

    /// L2: a decided P2P pot never sends a rounding lamport to draw_vault (B-4 "nothing to draw_vault").
    #[test]
    fn rake_parts_sum_to_the_rake_with_no_draw_remainder() {
        assert_eq!(rake_parts(150).unwrap(), (3, 0)); // old split: pool 2, architect 0, draw 1
        assert_eq!(rake_parts(10 * XNT).unwrap(), (150_000_000, 50_000_000));
        assert_eq!(rake_parts(0).unwrap(), (0, 0));
        let mut x: u64 = 0xD1B5_4A32_D192_ED03;
        for _ in 0..1_000_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let pot = x % (1_000_000 * XNT);
            let (pool, arch) = rake_parts(pot).unwrap();
            assert_eq!(pool + arch, bps(pot, P2P_RAKE_BPS).unwrap());
            assert_eq!(arch, bps(pot, RAKE_TO_ARCHITECT_BPS).unwrap());
            let floor_pool = bps(pot, RAKE_TO_POOL_BPS).unwrap();
            assert!(pool == floor_pool || pool == floor_pool + 1);
        }
    }

    #[test]
    fn bet_pack_roundtrip() {
        assert_eq!(bet_pack(5, 1_000_000), 0x0500000F4240);
        assert_eq!(bet_pack(5, 1_000_000), 5_497_559_138_880);
        assert_eq!(bet_unpack(5_497_559_138_880), (5, 1_000_000));
        let mut x: u64 = 7;
        for _ in 0..100_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let index = x % KEEPER_MAX_CHAIN; // <= 2^24 - 2
            let slot = (x >> 20) & BET_SLOT_MASK;
            assert_eq!(bet_unpack(bet_pack(index, slot)), (index, slot));
        }
        assert_eq!(bet_unpack(bet_pack(KEEPER_MAX_CHAIN, BET_SLOT_MASK)), (KEEPER_MAX_CHAIN, BET_SLOT_MASK));
        assert_eq!(bet_unpack(bet_pack(0, 0)), (0, 0));
    }

    #[test]
    fn bps_overflow_is_an_error() {
        assert!(bps(u64::MAX, BPS + 1).is_err());
        assert_eq!(bps(u64::MAX, BPS).unwrap(), u64::MAX);
        assert_eq!(bps(10 * XNT, 2_500).unwrap(), 2_500_000_000);
    }
}
