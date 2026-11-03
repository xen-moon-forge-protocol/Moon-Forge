//! Player-vs-player games. Solvent by construction: the pot is the players' money.
//! A 2% rake is taken only when there is a winner (1.5% pool, 0.5% architect; the former lottery share goes to
//! the pool since the final upgrade, OD-27).
//!
//!  • Jackpot      — multiplayer pot (at most JACKPOT_MAX_POT), winner drawn proportionally to the amount entered.
//!                   A round drawn by this binary reserves the house keeper's next chain position at draw time,
//!                   before its block exists, and is settled with the keeper's reveal (settle_jackpot_v2).
//!  • Artifact Duel— commit-reveal element duel, both sides sealed: the creator commits at create, the joiner
//!                   commits at join, the joiner opens, the creator reveals. No Artifact is needed (ticket removed).
//!  • Burn Lottery — tickets retired (enter_draw → LotteryRetired); a round open at the upgrade draws and settles.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::ForgeError;
use crate::events::*;
use crate::instructions::games::debit_balance;
use crate::instructions::keeper::{chain_next_ok, jackpot_draw, jackpot_ticket_v2};
use crate::state::*;
use crate::utils::*;

pub(crate) fn credit(ps_info: &AccountInfo, ps: &mut PlayerState, from: &AccountInfo, amount: u64) -> Result<()> {
    move_lamports(from, ps_info, amount)?;
    ps.balance = ps.balance.checked_add(amount).ok_or(ForgeError::MathOverflow)?;
    Ok(())
}

pub(crate) fn add_rake_stats(c: &mut Config, (p, a, d): (u64, u64, u64)) {
    c.stats.edge_to_pool = c.stats.edge_to_pool.saturating_add(p);
    c.stats.to_architect = c.stats.to_architect.saturating_add(a);
    c.stats.to_draw = c.stats.to_draw.saturating_add(d);
}

// ═══════════════════════════════════════════════════════════════════════════
// JACKPOT
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
#[instruction(round_id: u64, entry_index: u32)]
pub struct EnterJackpot<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump, constraint = config.jackpot_round == round_id @ ForgeError::RoundNotOpen)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed, payer = signer, space = 8 + JackpotRound::INIT_SPACE,
        seeds = [SEED_JACKPOT, round_id.to_le_bytes().as_ref()], bump
    )]
    pub round: Box<Account<'info, JackpotRound>>,
    #[account(
        init, payer = signer, space = 8 + JackpotEntry::INIT_SPACE,
        seeds = [SEED_JP_ENTRY, round_id.to_le_bytes().as_ref(), entry_index.to_le_bytes().as_ref()], bump
    )]
    pub entry: Box<Account<'info, JackpotEntry>>,
    #[account(mut, seeds = [SEED_PLAYER, player_state.owner.as_ref()], bump = player_state.bump)]
    pub player_state: Box<Account<'info, PlayerState>>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn enter_jackpot(ctx: Context<EnterJackpot>, round_id: u64, entry_index: u32, amount: u64) -> Result<()> {
    require!(amount >= MIN_STAKE, ForgeError::AmountTooSmall);
    // session keys (bots) play house games only: in a pot shared with others they could steer
    // the owner's money towards themselves
    require_keys_eq!(ctx.accounts.signer.key(), ctx.accounts.player_state.owner, ForgeError::OwnerOnly);
    let now = Clock::get()?.unix_timestamp;
    let round = &mut ctx.accounts.round;
    if round.entries == 0 && round.end_ts == 0 {
        round.id = round_id;
        round.bump = ctx.bumps.round;
        round.state = ROUND_OPEN;
    }
    require!(round.state == ROUND_OPEN, ForgeError::RoundNotOpen);
    require!(round.end_ts == 0 || now < round.end_ts, ForgeError::RoundNotOpen);
    require!(entry_index == round.entries, ForgeError::InvalidTarget);

    let total_after = round.total.checked_add(amount).ok_or(ForgeError::MathOverflow)?;
    require!(total_after <= JACKPOT_MAX_POT, ForgeError::PotFull);

    let player = ctx.accounts.player_state.owner;
    if round.entries == 0 {
        round.first_player = player;
        round.end_ts = now.saturating_add(JACKPOT_DURATION);
    } else if player != round.first_player {
        round.multi_player = true;
    }
    let start = round.total;
    round.total = total_after;
    round.entries += 1;

    debit_balance(&mut ctx.accounts.player_state, amount)?;
    move_lamports(&ctx.accounts.player_state.to_account_info(), &ctx.accounts.round.to_account_info(), amount)?;

    let e = &mut ctx.accounts.entry;
    e.round = round_id;
    e.index = entry_index;
    e.player = player;
    e.start = start;
    e.amount = amount;
    e.rent_payer = ctx.accounts.signer.key();
    e.bump = ctx.bumps.entry;
    Ok(())
}

#[derive(Accounts)]
pub struct DrawJackpot<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_JACKPOT, round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, JackpotRound>>,
    /// Game wallet of the first player (refund path when nobody else joined).
    #[account(mut, seeds = [SEED_PLAYER, round.first_player.as_ref()], bump = first_player_state.bump)]
    pub first_player_state: Box<Account<'info, PlayerState>>,
    /// CHECK: house keeper seat PDA (appended since the final upgrade): the draw reserves its next chain position.
    /// Unchecked because the seat may not exist yet (before the first arm_keeper): the handler then refunds the
    /// round (reason 3) instead of failing with AccountNotInitialized (finding M2). Owner and discriminator are
    /// checked in the handler; only this program can create an account at this PDA.
    #[account(mut, seeds = [SEED_HOUSE_KEEPER], bump)]
    pub keeper_seat: UncheckedAccount<'info>,
}

/// PERMISSIONLESS after the round ends. Single-player rounds are refunded in full (no rake). Otherwise the round
/// takes the keeper's next chain position now, before its block (slot + 1) exists (K-1); if there is no keeper seat
/// yet, the keeper has no position left, more than JACKPOT_MAX_BACKLOG earlier positions are unrevealed, or its bond
/// cannot also cover this pot (K-3), every entry is refunded at once (nothing about the outcome exists yet, so this
/// cannot be steered).
pub fn draw_jackpot(ctx: Context<DrawJackpot>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &mut ctx.accounts.round;
    require!(round.state == ROUND_OPEN, ForgeError::RoundNotOpen);
    require!(round.end_ts != 0 && now >= round.end_ts, ForgeError::RoundRunning);
    if !round.multi_player {
        let total = round.total;
        round.state = ROUND_SETTLED;
        round.winner = round.first_player;
        let rinfo = ctx.accounts.round.to_account_info();
        credit(&ctx.accounts.first_player_state.to_account_info(), &mut ctx.accounts.first_player_state, &rinfo, total)?;
        ctx.accounts.config.jackpot_round += 1;
        emit!(JackpotSettled {
            round: ctx.accounts.round.id,
            winner: ctx.accounts.round.first_player,
            pot: total,
            prize: total,
            winning_ticket: 0,
            refunded: true,
        });
        return Ok(());
    }
    let (round_key, total) = (round.key(), round.total);
    let reserved = ctx.accounts.config.bankroll_reserved;
    let slot = Clock::get()?.slot;
    let seat = ctx.accounts.keeper_seat.to_account_info();
    let drawn = if seat.owner == &crate::ID && !seat.data_is_empty() {
        let mut k = HouseKeeper::try_deserialize(&mut &seat.try_borrow_data()?[..])?;
        let target = jackpot_draw(&mut k, reserved, total, slot);
        if target.is_some() {
            k.try_serialize(&mut &mut seat.try_borrow_mut_data()?[..])?;
        }
        target
    } else {
        None // no keeper seat yet: nobody could ever reveal this round's position
    };
    match drawn {
        Some(target) => {
            let round = &mut ctx.accounts.round;
            round.state = ROUND_DRAWING;
            round.target_slot = target; // bet_pack(position, slot + 1)
            round.winning_ticket = u64::MAX; // v3 marker: settle_jackpot_v2
        }
        None => {
            ctx.accounts.round.state = ROUND_REFUND; // close_jackpot_entry refunds every entry
            ctx.accounts.config.jackpot_round += 1;
            emit!(BetRefunded { bet: round_key, player: Pubkey::default(), stake: total, penalty: 0, reason: 3 });
        }
    }
    Ok(())
}

#[derive(Accounts)]
pub struct SettleJackpot<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_JACKPOT, round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, JackpotRound>>,
    #[account(
        seeds = [SEED_JP_ENTRY, round.id.to_le_bytes().as_ref(), entry.index.to_le_bytes().as_ref()], bump = entry.bump
    )]
    pub entry: Box<Account<'info, JackpotEntry>>,
    #[account(mut, seeds = [SEED_PLAYER, entry.player.as_ref()], bump = winner_state.bump)]
    pub winner_state: Box<Account<'info, PlayerState>>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: draw vault PDA
    #[account(mut, seeds = [SEED_DRAW_VAULT], bump = config.bumps[2])]
    pub draw_vault: UncheckedAccount<'info>,
    /// CHECK: architect wallet
    #[account(mut, address = config.architect @ ForgeError::InvalidTarget)]
    pub architect: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar
    #[account(address = SLOT_HASHES_ID @ ForgeError::InvalidTarget)]
    pub slot_hashes: UncheckedAccount<'info>,
}

/// PERMISSIONLESS. Pass the entry holding the winning ticket (any client can compute it
/// from the event / account data). If nobody settled before the drawing block left the
/// SlotHashes window, the round is refunded in full (any entry can be passed): a re-roll would
/// let a losing player simply wait for a better block.
/// Rounds drawn by the v2 binary only; a round drawn by this binary settles through settle_jackpot_v2.
pub fn settle_jackpot(ctx: Context<SettleJackpot>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(round.winning_ticket != u64::MAX, ForgeError::KeeperRequired);
    require!(round.state == ROUND_DRAWING, ForgeError::RoundNotDrawing);
    let h = match slot_hash_at_or_after(&ctx.accounts.slot_hashes, round.target_slot)? {
        SlotHashLookup::NotYet => return err!(ForgeError::NotReady),
        SlotHashLookup::Expired => {
            round.state = ROUND_REFUND;
            ctx.accounts.config.jackpot_round += 1;
            emit!(JackpotSettled {
                round: round.id,
                winner: Pubkey::default(),
                pot: round.total,
                prize: 0,
                winning_ticket: 0,
                refunded: true,
            });
            return Ok(());
        }
        SlotHashLookup::Ready(h) => h,
    };
    let ticket = random_u64(&h, round.key().as_ref(), &round.id.to_le_bytes()) % round.total;
    let e = &ctx.accounts.entry;
    require!(ticket >= e.start && ticket < e.start + e.amount, ForgeError::NotWinningEntry);

    let pot = round.total;
    round.state = ROUND_SETTLED;
    round.winner = e.player;
    round.winning_ticket = ticket;
    let rinfo = ctx.accounts.round.to_account_info();
    let rake = split_rake(
        &rinfo,
        &ctx.accounts.reward_vault.to_account_info(),
        &ctx.accounts.architect.to_account_info(),
        &ctx.accounts.draw_vault.to_account_info(),
        pot,
    )?;
    let prize = pot - rake.0 - rake.1 - rake.2;
    credit(&ctx.accounts.winner_state.to_account_info(), &mut ctx.accounts.winner_state, &rinfo, prize)?;
    let c = &mut ctx.accounts.config;
    add_rake_stats(c, rake);
    c.stats.paid_to_players = c.stats.paid_to_players.saturating_add(prize);
    c.jackpot_round += 1;
    emit!(JackpotSettled { round: ctx.accounts.round.id, winner: ctx.accounts.entry.player, pot, prize, winning_ticket: ticket, refunded: false });
    Ok(())
}

/// SettleJackpot + keeper_seat (SettleJackpot already carries reward_vault, which takes the expiry penalty).
#[derive(Accounts)]
pub struct SettleJackpotV2<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_JACKPOT, round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, JackpotRound>>,
    #[account(
        seeds = [SEED_JP_ENTRY, round.id.to_le_bytes().as_ref(), entry.index.to_le_bytes().as_ref()], bump = entry.bump
    )]
    pub entry: Box<Account<'info, JackpotEntry>>,
    #[account(mut, seeds = [SEED_PLAYER, entry.player.as_ref()], bump = winner_state.bump)]
    pub winner_state: Box<Account<'info, PlayerState>>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: draw vault PDA
    #[account(mut, seeds = [SEED_DRAW_VAULT], bump = config.bumps[2])]
    pub draw_vault: UncheckedAccount<'info>,
    /// CHECK: architect wallet
    #[account(mut, address = config.architect @ ForgeError::InvalidTarget)]
    pub architect: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar
    #[account(address = SLOT_HASHES_ID @ ForgeError::InvalidTarget)]
    pub slot_hashes: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_HOUSE_KEEPER], bump = keeper_seat.bump)]
    pub keeper_seat: Box<Account<'info, HouseKeeper>>,
}

/// PERMISSIONLESS for whoever holds the preimage of the round's reserved position (pass the winning entry).
/// ticket = random_u64(keccak("MOONFORGE_JACKPOT_V2" ‖ hash(anchor) ‖ reveal), round, id) % total. If nobody
/// settled before the anchor block left SlotHashes (~3 min), every entry is refunded and the keeper bond pays
/// min(bond, pot) to the pool (any entry can be passed). That expiry needs no reveal and no chain order, so a dead
/// keeper never strands a round (and never blocks take_keeper); the reserved position is skipped later. The r9 time
/// fallback of the SlotHashes read (utils.rs age_limited) makes the round expire once SLOT_HASH_MAX_AGE slots have
/// passed since its anchor even if SlotHashes stopped answering for it.
pub fn settle_jackpot_v2(ctx: Context<SettleJackpotV2>, reveal: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round_key = ctx.accounts.round.key();
    let (id, total, target) = {
        let r = &ctx.accounts.round;
        require!(r.state == ROUND_DRAWING && r.winning_ticket == u64::MAX, ForgeError::RoundNotDrawing);
        (r.id, r.total, r.target_slot)
    };
    let (index, anchor) = bet_unpack(target);
    // defence in depth: re-arming is impossible while the round is pending
    require!(anchor > ctx.accounts.keeper_seat.armed_slot, ForgeError::BadReveal);
    let h = match slot_hash_at_or_after(&ctx.accounts.slot_hashes, anchor)? {
        SlotHashLookup::NotYet => return err!(ForgeError::NotReady),
        SlotHashLookup::Expired => {
            let penalty = total.min(ctx.accounts.keeper_seat.bond);
            move_lamports(&ctx.accounts.keeper_seat.to_account_info(), &ctx.accounts.reward_vault.to_account_info(), penalty)?;
            let k = &mut ctx.accounts.keeper_seat;
            k.bond -= penalty;
            k.penalties = k.penalties.saturating_add(penalty);
            k.pending_bets = k.pending_bets.saturating_sub(1);
            k.jackpot_reserved = k.jackpot_reserved.saturating_sub(total);
            ctx.accounts.round.state = ROUND_REFUND; // close_jackpot_entry refunds every entry
            let c = &mut ctx.accounts.config;
            c.jackpot_round += 1;
            c.stats.penalties_to_pool = c.stats.penalties_to_pool.saturating_add(penalty);
            emit!(BetRefunded { bet: round_key, player: Pubkey::default(), stake: total, penalty, reason: 2 });
            return Ok(());
        }
        SlotHashLookup::Ready(h) => h,
    };
    {
        let k = &ctx.accounts.keeper_seat;
        require!(index == k.revealed, ForgeError::BadReveal); // chain order, like bets
        require!(chain_next_ok(&k.tip, &reveal), ForgeError::BadReveal);
    }
    let ticket = jackpot_ticket_v2(&h, &reveal, &round_key, id, total);
    let e = &ctx.accounts.entry;
    require!(ticket >= e.start && ticket < e.start + e.amount, ForgeError::NotWinningEntry);
    let winner = e.player;

    let round = &mut ctx.accounts.round;
    round.state = ROUND_SETTLED;
    round.winner = winner;
    round.winning_ticket = ticket;
    let rinfo = ctx.accounts.round.to_account_info();
    let rake = split_rake(
        &rinfo,
        &ctx.accounts.reward_vault.to_account_info(),
        &ctx.accounts.architect.to_account_info(),
        &ctx.accounts.draw_vault.to_account_info(),
        total,
    )?;
    let prize = total - rake.0 - rake.1 - rake.2;
    credit(&ctx.accounts.winner_state.to_account_info(), &mut ctx.accounts.winner_state, &rinfo, prize)?;
    let c = &mut ctx.accounts.config;
    add_rake_stats(c, rake);
    c.stats.paid_to_players = c.stats.paid_to_players.saturating_add(prize);
    c.jackpot_round += 1;
    let k = &mut ctx.accounts.keeper_seat;
    k.tip = reveal;
    k.revealed += 1;
    k.pending_bets = k.pending_bets.saturating_sub(1);
    k.jackpot_reserved = k.jackpot_reserved.saturating_sub(total);
    k.last_active_ts = now;
    emit!(JackpotSettled { round: id, winner, pot: total, prize, winning_ticket: ticket, refunded: false });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseJackpotEntry<'info> {
    #[account(mut, seeds = [SEED_JACKPOT, entry.round.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, JackpotRound>>,
    /// Game wallet of the entry's player: receives the refund when the round was refunded.
    #[account(mut, seeds = [SEED_PLAYER, entry.player.as_ref()], bump = player_state.bump)]
    pub player_state: Box<Account<'info, PlayerState>>,
    #[account(
        mut, close = rent_payer,
        seeds = [SEED_JP_ENTRY, entry.round.to_le_bytes().as_ref(), entry.index.to_le_bytes().as_ref()], bump = entry.bump
    )]
    pub entry: Box<Account<'info, JackpotEntry>>,
    /// CHECK: original rent payer
    #[account(mut, address = entry.rent_payer @ ForgeError::WrongRentPayer)]
    pub rent_payer: UncheckedAccount<'info>,
}

/// PERMISSIONLESS once the round is over. In a refunded round the entry's amount goes back to
/// its player's game wallet; the entry rent always goes back to whoever paid it.
pub fn close_jackpot_entry(ctx: Context<CloseJackpotEntry>) -> Result<()> {
    let state = ctx.accounts.round.state;
    require!(state == ROUND_SETTLED || state == ROUND_REFUND, ForgeError::RoundNotSettled);
    if state == ROUND_REFUND {
        let amount = ctx.accounts.entry.amount;
        let rinfo = ctx.accounts.round.to_account_info();
        credit(&ctx.accounts.player_state.to_account_info(), &mut ctx.accounts.player_state, &rinfo, amount)?;
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// ARTIFACT DUEL — element cycle: Lunar(0) > Void(3) > Solar(2) > Cosmic(1) > Lunar(0)
// a beats b  <=>  b == (a + 3) % 4.  Same or opposite element = draw (full refund).
// The creator commits keccak("MOONFORGE_DUEL" || element || salt || duel_pubkey) at create (offer open for
// P2P_OFFER_TTL). The joiner commits keccak("MOONFORGE_DUEL_JOIN" || element || salt || duel || opponent) at join
// (join_duel_sealed) and opens it within DUEL_JOIN_REVEAL_WINDOW (reveal_duel_join); then the creator reveals
// within ~1 h (reveal_duel). A joiner who never opens: the creator is refunded and the joiner's stake goes to the
// pool. A creator who never reveals loses. No Artifact is needed since the final upgrade (ticket removed).
// ═══════════════════════════════════════════════════════════════════════════

/// `a` beats `b`  <=>  b == (a + 3) % 4   (Lunar>Void, Void>Solar, Solar>Cosmic, Cosmic>Lunar)
pub fn beats(a: u8, b: u8) -> bool {
    b == (a + 3) % 4
}

/// None = draw; Some(true) = opponent wins; Some(false) = creator wins.
pub fn duel_winner(creator_el: u8, opponent_el: u8) -> Option<bool> {
    if creator_el == opponent_el || (creator_el + 2) % 4 == opponent_el {
        None
    } else {
        Some(beats(opponent_el, creator_el))
    }
}

#[cfg(test)]
mod duel_tests {
    use super::*;
    #[test]
    fn cycle_is_consistent() {
        // every non-draw pair has exactly one winner, and the cycle is the documented one
        assert!(beats(0, 3) && beats(3, 2) && beats(2, 1) && beats(1, 0));
        for a in 0..4u8 {
            for b in 0..4u8 {
                match duel_winner(a, b) {
                    None => assert!(a == b || (a + 2) % 4 == b),
                    Some(opp) => assert!(opp == beats(b, a) && opp != beats(a, b)),
                }
            }
        }
        assert_eq!(duel_winner(0, 1), Some(true)); // creator Lunar vs opponent Cosmic -> Cosmic wins
        assert_eq!(duel_winner(3, 2), Some(false)); // creator Void vs Solar -> Void wins
    }

    #[test]
    fn join_commitment_matches_the_clients() {
        // Appendix A: element 1, salt 0x09×32, duel 0x01×32, opponent 0x02×32
        let c = duel_join_commitment(1, &[9; 32], &Pubkey::new_from_array([1; 32]), &Pubkey::new_from_array([2; 32]));
        let hex: String = c.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, "4174fb36832c31540985c74b2a24465def836269b4b4de407a978fbc546baf16");
        // bound to the duel and to the joiner: a copied commitment cannot be opened by anyone else
        assert_ne!(c, duel_join_commitment(1, &[9; 32], &Pubkey::new_from_array([1; 32]), &Pubkey::new_from_array([3; 32])));
        assert!(DUEL_ELEMENT_SEALED >= 4); // never a playable element: reveal_duel refuses a sealed join
    }
}

/// The joiner's sealed commitment (join_duel_sealed / reveal_duel_join; Appendix A vector).
pub fn duel_join_commitment(element: u8, salt: &[u8; 32], duel: &Pubkey, opponent: &Pubkey) -> [u8; 32] {
    keccak(&[b"MOONFORGE_DUEL_JOIN", &[element], salt, duel.as_ref(), opponent.as_ref()])
}

#[derive(Accounts)]
pub struct CreateDuel<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut, seeds = [SEED_PLAYER, owner.key().as_ref()], bump = creator_state.bump,
        constraint = creator_state.owner == owner.key() @ ForgeError::Unauthorized
    )]
    pub creator_state: Box<Account<'info, PlayerState>>,
    #[account(
        init, payer = owner, space = 8 + Duel::INIT_SPACE,
        seeds = [SEED_DUEL, owner.key().as_ref(), creator_state.nonce.to_le_bytes().as_ref()], bump
    )]
    pub duel: Box<Account<'info, Duel>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: unused since v3 (ticket removed): pass the system program
    pub asset: UncheckedAccount<'info>,
    /// CHECK: unused since v3 (ticket removed): pass the system program
    pub record: UncheckedAccount<'info>,
    /// CHECK: unused since v3 (ticket removed): pass the system program
    pub collection: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn create_duel(ctx: Context<CreateDuel>, stake: u64, commitment: [u8; 32]) -> Result<()> {
    require!(stake >= DUEL_MIN_STAKE, ForgeError::AmountTooSmall);
    let now = Clock::get()?.unix_timestamp;
    let nonce = ctx.accounts.creator_state.nonce;
    debit_balance(&mut ctx.accounts.creator_state, stake)?;
    ctx.accounts.creator_state.nonce += 1;
    move_lamports(&ctx.accounts.creator_state.to_account_info(), &ctx.accounts.duel.to_account_info(), stake)?;
    let d = &mut ctx.accounts.duel;
    d.creator = ctx.accounts.owner.key();
    d.nonce = nonce;
    d.stake = stake;
    d.commitment = commitment;
    d.state = DUEL_OPEN;
    d.deadline = now.saturating_add(P2P_OFFER_TTL); // offer expiry (deadline@123 is unused while OPEN)
    d.rent_payer = ctx.accounts.owner.key();
    d.bump = ctx.bumps.duel;
    Ok(())
}

#[derive(Accounts)]
pub struct JoinDuel<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_DUEL, duel.creator.as_ref(), duel.nonce.to_le_bytes().as_ref()], bump = duel.bump)]
    pub duel: Box<Account<'info, Duel>>,
    #[account(
        mut, seeds = [SEED_PLAYER, opponent.key().as_ref()], bump = opponent_state.bump,
        constraint = opponent_state.owner == opponent.key() @ ForgeError::Unauthorized
    )]
    pub opponent_state: Box<Account<'info, PlayerState>>,
    pub opponent: Signer<'info>,
    /// CHECK: unused since v3 (ticket removed): pass the system program
    pub asset: UncheckedAccount<'info>,
    /// CHECK: unused since v3 (ticket removed): pass the system program
    pub record: UncheckedAccount<'info>,
    /// CHECK: unused since v3 (ticket removed): pass the system program
    pub collection: UncheckedAccount<'info>,
}

/// Retired: a plain-text element could be read before the join landed and answered with cancel_duel (audit L2).
/// Kept so the discriminator still resolves.
pub fn join_duel(_ctx: Context<JoinDuel>, _element: u8) -> Result<()> {
    err!(ForgeError::SealedJoinRequired)
}

/// Same accounts as the old join. commitment = keccak("MOONFORGE_DUEL_JOIN" ‖ element ‖ salt ‖ duel ‖ opponent).
pub fn join_duel_sealed(ctx: Context<JoinDuel>, commitment: [u8; 32]) -> Result<()> {
    require!(commitment != [0u8; 32], ForgeError::BadCommitment);
    let now = Clock::get()?.unix_timestamp;
    let d = &ctx.accounts.duel;
    require!(d.state == DUEL_OPEN, ForgeError::DuelState);
    require!(d.deadline == 0 || now <= d.deadline, ForgeError::DeadlinePassed); // offer TTL (0 = pre-upgrade offer)
    require!(ctx.accounts.opponent.key() != d.creator, ForgeError::SelfDuel);
    let stake = d.stake;
    debit_balance(&mut ctx.accounts.opponent_state, stake)?;
    move_lamports(&ctx.accounts.opponent_state.to_account_info(), &ctx.accounts.duel.to_account_info(), stake)?;
    let d = &mut ctx.accounts.duel;
    d.opponent = ctx.accounts.opponent.key();
    d.opponent_element = DUEL_ELEMENT_SEALED;
    d.opponent_commitment = commitment;
    d.state = DUEL_JOINED;
    d.deadline = now.saturating_add(DUEL_JOIN_REVEAL_WINDOW);
    Ok(())
}

#[derive(Accounts)]
pub struct RevealDuelJoin<'info> {
    #[account(mut, seeds = [SEED_DUEL, duel.creator.as_ref(), duel.nonce.to_le_bytes().as_ref()], bump = duel.bump)]
    pub duel: Box<Account<'info, Duel>>,
    #[account(address = duel.opponent @ ForgeError::Unauthorized)]
    pub opponent: Signer<'info>,
}

/// The joiner opens its element once its join has landed (the creator can no longer cancel). The creator then has
/// DUEL_REVEAL_WINDOW to reveal through reveal_duel.
pub fn reveal_duel_join(ctx: Context<RevealDuelJoin>, element: u8, salt: [u8; 32]) -> Result<()> {
    let key = ctx.accounts.duel.key();
    let now = Clock::get()?.unix_timestamp;
    let d = &mut ctx.accounts.duel;
    require!(d.state == DUEL_JOINED && d.opponent_element == DUEL_ELEMENT_SEALED, ForgeError::DuelState);
    // not in the join's own second (no join + open bundle)
    require!(now > d.deadline.saturating_sub(DUEL_JOIN_REVEAL_WINDOW), ForgeError::NotReady);
    require!(now <= d.deadline, ForgeError::DeadlinePassed);
    require!(element < 4, ForgeError::WrongElement);
    require!(duel_join_commitment(element, &salt, &key, &d.opponent) == d.opponent_commitment, ForgeError::BadCommitment);
    d.opponent_element = element;
    d.opponent_commitment = [0u8; 32];
    d.deadline = now.saturating_add(DUEL_REVEAL_WINDOW); // the creator's ~1 h, as before
    Ok(())
}

#[derive(Accounts)]
pub struct ResolveDuel<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut, close = rent_payer,
        seeds = [SEED_DUEL, duel.creator.as_ref(), duel.nonce.to_le_bytes().as_ref()], bump = duel.bump
    )]
    pub duel: Box<Account<'info, Duel>>,
    #[account(mut, seeds = [SEED_PLAYER, duel.creator.as_ref()], bump = creator_state.bump)]
    pub creator_state: Box<Account<'info, PlayerState>>,
    #[account(mut, seeds = [SEED_PLAYER, duel.opponent.as_ref()], bump = opponent_state.bump)]
    pub opponent_state: Box<Account<'info, PlayerState>>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: draw vault PDA
    #[account(mut, seeds = [SEED_DRAW_VAULT], bump = config.bumps[2])]
    pub draw_vault: UncheckedAccount<'info>,
    /// CHECK: architect wallet
    #[account(mut, address = config.architect @ ForgeError::InvalidTarget)]
    pub architect: UncheckedAccount<'info>,
    /// CHECK: duel creator receives the duel account rent
    #[account(mut, address = duel.rent_payer @ ForgeError::WrongRentPayer)]
    pub rent_payer: UncheckedAccount<'info>,
}

fn pay_duel(a: &mut ResolveDuel, winner: Option<bool>) -> Result<(Pubkey, u64)> {
    let stake = a.duel.stake;
    let pot = stake.checked_mul(2).ok_or(ForgeError::MathOverflow)?;
    a.duel.state = DUEL_DONE;
    let dinfo = a.duel.to_account_info();
    match winner {
        None => {
            credit(&a.creator_state.to_account_info(), &mut a.creator_state, &dinfo, stake)?;
            credit(&a.opponent_state.to_account_info(), &mut a.opponent_state, &dinfo, stake)?;
            Ok((Pubkey::default(), pot))
        }
        Some(opponent_wins) => {
            let rake = split_rake(
                &dinfo,
                &a.reward_vault.to_account_info(),
                &a.architect.to_account_info(),
                &a.draw_vault.to_account_info(),
                pot,
            )?;
            let prize = pot - rake.0 - rake.1 - rake.2;
            let w = if opponent_wins {
                credit(&a.opponent_state.to_account_info(), &mut a.opponent_state, &dinfo, prize)?;
                a.duel.opponent
            } else {
                credit(&a.creator_state.to_account_info(), &mut a.creator_state, &dinfo, prize)?;
                a.duel.creator
            };
            add_rake_stats(&mut a.config, rake);
            a.config.stats.paid_to_players = a.config.stats.paid_to_players.saturating_add(prize);
            Ok((w, pot))
        }
    }
}

#[derive(Accounts)]
pub struct RevealDuel<'info> {
    pub resolve: ResolveDuel<'info>,
    #[account(address = resolve.duel.creator @ ForgeError::Unauthorized)]
    pub creator: Signer<'info>,
}

pub fn reveal_duel(ctx: Context<RevealDuel>, element: u8, salt: [u8; 32]) -> Result<()> {
    let d = &ctx.accounts.resolve.duel;
    require!(d.state == DUEL_JOINED, ForgeError::DuelState);
    require!(d.opponent_element < 4, ForgeError::DuelState); // a sealed join must be opened first
    require!(Clock::get()?.unix_timestamp <= d.deadline, ForgeError::DeadlinePassed);
    require!(element < 4, ForgeError::WrongElement);
    let c = keccak(&[b"MOONFORGE_DUEL", &[element], &salt, d.key().as_ref()]);
    require!(c == d.commitment, ForgeError::BadCommitment);

    let opp_el = d.opponent_element;
    let duel_key = d.key();
    let winner = duel_winner(element, opp_el);
    ctx.accounts.resolve.duel.creator_element = element;
    let (w, pot) = pay_duel(&mut ctx.accounts.resolve, winner)?;
    emit!(DuelResolved { duel: duel_key, creator_element: element, opponent_element: opp_el, winner: w, pot, timeout: false });
    Ok(())
}

/// PERMISSIONLESS after the deadline. A sealed join never opened: the joiner knew nothing the creator did not, so
/// the creator is only refunded and the joiner's stake goes to the reward pool (blocking the open pays nobody,
/// OD-4). Otherwise the creator did not reveal: the opponent wins.
pub fn claim_duel_timeout(ctx: Context<ResolveDuel>) -> Result<()> {
    let d = &ctx.accounts.duel;
    require!(d.state == DUEL_JOINED, ForgeError::DuelState);
    require!(Clock::get()?.unix_timestamp > d.deadline, ForgeError::DeadlineNotReached);
    let (duel_key, opp_el) = (d.key(), d.opponent_element);
    if opp_el == DUEL_ELEMENT_SEALED {
        let a = &mut *ctx.accounts;
        let stake = a.duel.stake;
        a.duel.state = DUEL_DONE;
        let dinfo = a.duel.to_account_info();
        credit(&a.creator_state.to_account_info(), &mut a.creator_state, &dinfo, stake)?;
        move_lamports(&dinfo, &a.reward_vault.to_account_info(), stake)?;
        a.config.stats.penalties_to_pool = a.config.stats.penalties_to_pool.saturating_add(stake);
        emit!(DuelResolved { duel: duel_key, creator_element: 255, opponent_element: 255, winner: Pubkey::default(), pot: stake * 2, timeout: true });
        return Ok(());
    }
    let (w, pot) = pay_duel(ctx.accounts, Some(true))?;
    emit!(DuelResolved { duel: duel_key, creator_element: 255, opponent_element: opp_el, winner: w, pot, timeout: true });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelDuel<'info> {
    #[account(
        mut, close = creator,
        seeds = [SEED_DUEL, duel.creator.as_ref(), duel.nonce.to_le_bytes().as_ref()], bump = duel.bump,
        constraint = duel.creator == creator.key() @ ForgeError::Unauthorized
    )]
    pub duel: Box<Account<'info, Duel>>,
    #[account(mut, seeds = [SEED_PLAYER, creator.key().as_ref()], bump = creator_state.bump)]
    pub creator_state: Box<Account<'info, PlayerState>>,
    #[account(mut)]
    pub creator: Signer<'info>,
}

/// Creator cancels an un-joined duel: stake back to the game balance.
pub fn cancel_duel(ctx: Context<CancelDuel>) -> Result<()> {
    require!(ctx.accounts.duel.state == DUEL_OPEN, ForgeError::DuelState);
    let stake = ctx.accounts.duel.stake;
    let dinfo = ctx.accounts.duel.to_account_info();
    credit(&ctx.accounts.creator_state.to_account_info(), &mut ctx.accounts.creator_state, &dinfo, stake)?;
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// BURN LOTTERY (weekly). Tickets are retired since the final upgrade (OD-27): enter_draw returns LotteryRetired.
// A round open at the upgrade still draws, settles and closes. Prize = 50% of the draw vault at settlement.
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
#[instruction(round_id: u64, entry_index: u32)]
pub struct EnterDraw<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump, constraint = config.draw_round == round_id @ ForgeError::RoundNotOpen)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed, payer = signer, space = 8 + DrawRound::INIT_SPACE,
        seeds = [SEED_DRAW, round_id.to_le_bytes().as_ref()], bump
    )]
    pub round: Box<Account<'info, DrawRound>>,
    #[account(
        init, payer = signer, space = 8 + DrawEntry::INIT_SPACE,
        seeds = [SEED_DRAW_ENTRY, round_id.to_le_bytes().as_ref(), entry_index.to_le_bytes().as_ref()], bump
    )]
    pub entry: Box<Account<'info, DrawEntry>>,
    #[account(mut, seeds = [SEED_PLAYER, player_state.owner.as_ref()], bump = player_state.bump)]
    pub player_state: Box<Account<'info, PlayerState>>,
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
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Retired (OD-27 default (c), ECO-6): no paid lottery without a legal opinion, and its drawing-block producer keeps
/// stake-share control of an uncapped prize. Same ABI, so old clients get a clear error.
pub fn enter_draw(_ctx: Context<EnterDraw>, _round_id: u64, _entry_index: u32, _chips: u64, _tickets: u64) -> Result<()> {
    err!(ForgeError::LotteryRetired)
}

#[derive(Accounts)]
pub struct DrawDraw<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_DRAW, round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, DrawRound>>,
}

/// PERMISSIONLESS after the week ends.
pub fn draw_draw(ctx: Context<DrawDraw>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let round = &mut ctx.accounts.round;
    require!(round.state == ROUND_OPEN, ForgeError::RoundNotOpen);
    require!(now >= round.end_ts, ForgeError::RoundRunning);
    if round.total_weight == 0 {
        round.state = ROUND_SETTLED;
        ctx.accounts.config.draw_round += 1;
        return Ok(());
    }
    round.state = ROUND_DRAWING;
    round.target_slot = Clock::get()?.slot + 1;
    Ok(())
}

#[derive(Accounts)]
pub struct SettleDraw<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_DRAW, round.id.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, DrawRound>>,
    #[account(
        seeds = [SEED_DRAW_ENTRY, round.id.to_le_bytes().as_ref(), entry.index.to_le_bytes().as_ref()], bump = entry.bump
    )]
    pub entry: Box<Account<'info, DrawEntry>>,
    #[account(mut, seeds = [SEED_PLAYER, entry.player.as_ref()], bump = winner_state.bump)]
    pub winner_state: Box<Account<'info, PlayerState>>,
    /// CHECK: draw vault PDA
    #[account(mut, seeds = [SEED_DRAW_VAULT], bump = config.bumps[2])]
    pub draw_vault: UncheckedAccount<'info>,
    /// CHECK: reward vault PDA (receives the prize of a week nobody settled in time)
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar
    #[account(address = SLOT_HASHES_ID @ ForgeError::InvalidTarget)]
    pub slot_hashes: UncheckedAccount<'info>,
}

/// PERMISSIONLESS. Pass the entry holding the winning ticket. If nobody settled before the
/// drawing block left the SlotHashes window, there is no winner this week and the prize goes to
/// the reward pool (any entry can be passed): no re-roll and no roll-over, so waiting never helps.
pub fn settle_draw(ctx: Context<SettleDraw>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(round.state == ROUND_DRAWING, ForgeError::RoundNotDrawing);
    let h = match slot_hash_at_or_after(&ctx.accounts.slot_hashes, round.target_slot)? {
        SlotHashLookup::NotYet => return err!(ForgeError::NotReady),
        SlotHashLookup::Expired => {
            // the would-be prize goes to the burners' reward pool: letting a draw expire can never
            // grow a later prize, so nobody gains anything by withholding a settlement
            let prize = bps(free_balance(&ctx.accounts.draw_vault, 0)?, DRAW_PRIZE_BPS)?;
            move_lamports(&ctx.accounts.draw_vault.to_account_info(), &ctx.accounts.reward_vault.to_account_info(), prize)?;
            round.state = ROUND_SETTLED;
            round.prize = prize;
            let c = &mut ctx.accounts.config;
            c.draw_round += 1;
            c.stats.expired_draws_to_pool = c.stats.expired_draws_to_pool.saturating_add(prize);
            emit!(DrawSettled { round: round.id, winner: Pubkey::default(), prize, total_weight: round.total_weight, winning_ticket: 0 });
            return Ok(());
        }
        SlotHashLookup::Ready(h) => h,
    };
    let ticket = random_u64(&h, round.key().as_ref(), &round.id.to_le_bytes()) % round.total_weight;
    let e = &ctx.accounts.entry;
    require!(ticket >= e.start && ticket < e.start + e.weight, ForgeError::NotWinningEntry);

    let prize = bps(free_balance(&ctx.accounts.draw_vault, 0)?, DRAW_PRIZE_BPS)?;
    round.state = ROUND_SETTLED;
    round.winner = e.player;
    round.winning_ticket = ticket;
    round.prize = prize;
    let vinfo = ctx.accounts.draw_vault.to_account_info();
    credit(&ctx.accounts.winner_state.to_account_info(), &mut ctx.accounts.winner_state, &vinfo, prize)?;
    let c = &mut ctx.accounts.config;
    c.stats.draw_prizes = c.stats.draw_prizes.saturating_add(prize);
    c.draw_round += 1;
    emit!(DrawSettled {
        round: ctx.accounts.round.id,
        winner: ctx.accounts.entry.player,
        prize,
        total_weight: ctx.accounts.round.total_weight,
        winning_ticket: ticket,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseDrawEntry<'info> {
    #[account(seeds = [SEED_DRAW, entry.round.to_le_bytes().as_ref()], bump = round.bump)]
    pub round: Box<Account<'info, DrawRound>>,
    #[account(
        mut, close = rent_payer,
        seeds = [SEED_DRAW_ENTRY, entry.round.to_le_bytes().as_ref(), entry.index.to_le_bytes().as_ref()], bump = entry.bump
    )]
    pub entry: Box<Account<'info, DrawEntry>>,
    /// CHECK: original rent payer
    #[account(mut, address = entry.rent_payer @ ForgeError::WrongRentPayer)]
    pub rent_payer: UncheckedAccount<'info>,
}

pub fn close_draw_entry(ctx: Context<CloseDrawEntry>) -> Result<()> {
    require!(ctx.accounts.round.state == ROUND_SETTLED, ForgeError::RoundNotSettled);
    Ok(())
}
