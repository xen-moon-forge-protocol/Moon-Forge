//! Moon Wars — the card battle of the free practice, played for real XNT, player vs player.
//!
//! create_war  : creator stakes XNT (from the game wallet), shows a live Artifact (any tier) as the
//!               ticket, and names the key allowed to sign its moves (its own wallet, or a key
//!               generated in its own browser so each move needs no wallet pop-up).
//! join_war    : an opponent matches the stake (same ticket rule). The match commits to the next slot.
//! start_war   : PERMISSIONLESS once that slot exists: both 10-card decks are shuffled with its hash
//!               (public to both players — perfect information, like chess) and each side draws 3.
//! moves       : war_summon / war_attack / war_end_turn, signed by the player's move key, validated
//!               by the program with exactly the rules of the practice engine (see constants.rs).
//! timeout     : PERMISSIONLESS — a player who does not end its turn in time loses.
//! settle_war  : PERMISSIONLESS once finished: winner gets both stakes minus the 2% P2P rake
//!               (1% pool, 0.5% architect, 0.5% lottery); a draw refunds both stakes in full.

use anchor_lang::prelude::*;

use crate::constants::*;
use crate::core_cpi::live_asset_owner;
use crate::errors::ForgeError;
use crate::events::*;
use crate::instructions::games::debit_balance;
use crate::instructions::p2p::{add_rake_stats, credit};
use crate::state::*;
use crate::utils::*;

// ═══════════════════════════════════════════════════════════════════════════
// Game rules (pure functions, unit-tested; mirror frontend/src/lib/games/MoonWarsEngine.ts)
// ═══════════════════════════════════════════════════════════════════════════

fn power(element: u8) -> i8 {
    WAR_CARDS[element as usize].0
}

fn shuffle(seed: &[u8; 32], side: u8) -> [u8; 10] {
    let mut d = WAR_DECK;
    for i in (1..d.len()).rev() {
        let r = random_u64(seed, b"MOONFORGE_WAR_DECK", &[side, i as u8]);
        let j = (r % (i as u64 + 1)) as usize;
        d.swap(i, j);
    }
    d
}

fn draw(s: &mut WarSide) {
    if s.deck_left == 0 {
        s.health = s.health.saturating_sub(1); // fatigue
        return;
    }
    if (s.hand_len as usize) < WAR_HAND_MAX {
        s.hand[s.hand_len as usize] = s.deck[s.deck_left as usize - 1];
        s.hand_len += 1;
    }
    // a card drawn with a full hand is burned (never happens with a 10-card deck and 10 slots)
    s.deck_left -= 1;
}

/// Sets up both sides from the seed. Creator moves first with 1 mana.
pub fn war_setup(w: &mut War, seed: &[u8; 32]) {
    for side in 0..2u8 {
        let s = &mut w.sides[side as usize];
        *s = WarSide { health: WAR_START_HP, mana: 1, deck: shuffle(seed, side), deck_left: 10, ..Default::default() };
        for _ in 0..3 {
            draw(s);
        }
    }
    w.turn = 0;
    w.round = 1;
    w.state = WAR_ACTIVE;
}

/// Ends the match if someone is at 0 HP. Returns true when finished.
fn check_end(w: &mut War) -> bool {
    let (a, b) = (w.sides[0].health <= 0, w.sides[1].health <= 0);
    if !a && !b {
        return false;
    }
    w.state = WAR_DONE;
    if a && b {
        w.draw = true;
    } else {
        w.winner = if a { w.opponent } else { w.creator };
    }
    true
}

pub fn war_summon(w: &mut War, hand_index: u8) -> Result<()> {
    let me = w.turn as usize;
    let s = &mut w.sides[me];
    let i = hand_index as usize;
    require!(i < s.hand_len as usize, ForgeError::InvalidMove);
    require!((s.field_len as usize) < WAR_FIELD_MAX, ForgeError::InvalidMove);
    let element = s.hand[i];
    let (_, defense, cost) = WAR_CARDS[element as usize];
    require!(s.mana >= cost, ForgeError::NotEnoughMana);
    s.mana -= cost;
    for k in i..(s.hand_len as usize - 1) {
        s.hand[k] = s.hand[k + 1];
    }
    s.hand_len -= 1;
    s.hand[s.hand_len as usize] = 0;
    s.field[s.field_len as usize] = WarUnit { element, defense, ready: false }; // summoning sickness
    s.field_len += 1;
    if element == 2 {
        let foe = &mut w.sides[1 - me];
        foe.health = foe.health.saturating_sub(WAR_SOLAR_BURN);
    }
    check_end(w);
    Ok(())
}

fn remove_unit(s: &mut WarSide, i: usize) {
    for k in i..(s.field_len as usize - 1) {
        s.field[k] = s.field[k + 1];
    }
    s.field_len -= 1;
    s.field[s.field_len as usize] = WarUnit::default();
}

/// target = 255 attacks the enemy player directly (only when its field is empty).
pub fn war_attack(w: &mut War, attacker: u8, target: u8) -> Result<()> {
    let me = w.turn as usize;
    let a = attacker as usize;
    require!(a < w.sides[me].field_len as usize, ForgeError::InvalidMove);
    let unit = w.sides[me].field[a];
    require!(unit.ready, ForgeError::InvalidMove);
    let atk = power(unit.element);
    if target == 255 {
        require!(w.sides[1 - me].field_len == 0, ForgeError::InvalidMove);
        let foe = &mut w.sides[1 - me];
        foe.health = foe.health.saturating_sub(atk);
        w.sides[me].field[a].ready = false;
    } else {
        let t = target as usize;
        require!(t < w.sides[1 - me].field_len as usize, ForgeError::InvalidMove);
        let def_unit = w.sides[1 - me].field[t];
        let target_left = def_unit.defense.saturating_sub(atk);
        let attacker_left = unit.defense.saturating_sub(power(def_unit.element));
        w.sides[1 - me].field[t].defense = target_left;
        w.sides[me].field[a].defense = attacker_left;
        w.sides[me].field[a].ready = false;
        if target_left <= 0 {
            remove_unit(&mut w.sides[1 - me], t);
        }
        if attacker_left <= 0 {
            remove_unit(&mut w.sides[me], a);
        }
    }
    check_end(w);
    Ok(())
}

pub fn war_next_turn(w: &mut War, now: i64) {
    let next = 1 - w.turn as usize;
    w.turn = next as u8;
    w.round = w.round.saturating_add(1);
    let s = &mut w.sides[next];
    s.mana = ((w.round as u32 + 1) / 2 + 1).min(10) as u8; // min(10, ceil(round/2) + 1)
    for k in 0..s.field_len as usize {
        s.field[k].ready = true;
    }
    draw(s);
    w.deadline = now.saturating_add(WAR_TURN_TIMEOUT);
    if !check_end(w) && w.round > WAR_MAX_ROUNDS {
        w.state = WAR_DONE;
        w.draw = true;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Instructions
// ═══════════════════════════════════════════════════════════════════════════

fn check_ticket(asset: &AccountInfo, record: &ArtifactRecord, collection: &Pubkey, who: &Pubkey) -> Result<()> {
    require_keys_eq!(record.asset, asset.key(), ForgeError::InvalidArtifact);
    let owner = live_asset_owner(asset, collection).ok_or(ForgeError::InvalidArtifact)?;
    require_keys_eq!(owner, *who, ForgeError::NotArtifactOwner);
    Ok(())
}

#[derive(Accounts)]
pub struct CreateWar<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut, seeds = [SEED_PLAYER, owner.key().as_ref()], bump = creator_state.bump,
        constraint = creator_state.owner == owner.key() @ ForgeError::Unauthorized
    )]
    pub creator_state: Box<Account<'info, PlayerState>>,
    #[account(
        init, payer = owner, space = 8 + War::INIT_SPACE,
        seeds = [SEED_WAR, owner.key().as_ref(), creator_state.nonce.to_le_bytes().as_ref()], bump
    )]
    pub war: Box<Account<'info, War>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: Core asset held by the creator (arena ticket), validated in the handler
    pub asset: UncheckedAccount<'info>,
    #[account(seeds = [SEED_ARTIFACT, asset.key().as_ref()], bump = record.bump)]
    pub record: Box<Account<'info, ArtifactRecord>>,
    /// CHECK: collection PDA
    #[account(seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn create_war(ctx: Context<CreateWar>, stake: u64, move_key: Pubkey) -> Result<()> {
    require!(stake >= WAR_MIN_STAKE, ForgeError::AmountTooSmall);
    check_ticket(&ctx.accounts.asset, &ctx.accounts.record, &ctx.accounts.collection.key(), &ctx.accounts.owner.key())?;
    let nonce = ctx.accounts.creator_state.nonce;
    debit_balance(&mut ctx.accounts.creator_state, stake)?;
    ctx.accounts.creator_state.nonce += 1;
    move_lamports(&ctx.accounts.creator_state.to_account_info(), &ctx.accounts.war.to_account_info(), stake)?;
    let w = &mut ctx.accounts.war;
    w.creator = ctx.accounts.owner.key();
    w.nonce = nonce;
    w.stake = stake;
    w.state = WAR_OPEN;
    w.keys = [if move_key == Pubkey::default() { w.creator } else { move_key }, Pubkey::default()];
    w.rent_payer = w.creator;
    w.bump = ctx.bumps.war;
    Ok(())
}

#[derive(Accounts)]
pub struct CancelWar<'info> {
    #[account(
        mut, close = creator,
        seeds = [SEED_WAR, war.creator.as_ref(), war.nonce.to_le_bytes().as_ref()], bump = war.bump,
        constraint = war.creator == creator.key() @ ForgeError::Unauthorized
    )]
    pub war: Box<Account<'info, War>>,
    #[account(mut, seeds = [SEED_PLAYER, creator.key().as_ref()], bump = creator_state.bump)]
    pub creator_state: Box<Account<'info, PlayerState>>,
    #[account(mut)]
    pub creator: Signer<'info>,
}

/// Creator cancels a match nobody joined: stake back to the game balance.
pub fn cancel_war(ctx: Context<CancelWar>) -> Result<()> {
    require!(ctx.accounts.war.state == WAR_OPEN, ForgeError::WarState);
    let stake = ctx.accounts.war.stake;
    let winfo = ctx.accounts.war.to_account_info();
    credit(&ctx.accounts.creator_state.to_account_info(), &mut ctx.accounts.creator_state, &winfo, stake)
}

#[derive(Accounts)]
pub struct JoinWar<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_WAR, war.creator.as_ref(), war.nonce.to_le_bytes().as_ref()], bump = war.bump)]
    pub war: Box<Account<'info, War>>,
    #[account(
        mut, seeds = [SEED_PLAYER, opponent.key().as_ref()], bump = opponent_state.bump,
        constraint = opponent_state.owner == opponent.key() @ ForgeError::Unauthorized
    )]
    pub opponent_state: Box<Account<'info, PlayerState>>,
    pub opponent: Signer<'info>,
    /// CHECK: Core asset held by the opponent (arena ticket)
    pub asset: UncheckedAccount<'info>,
    #[account(seeds = [SEED_ARTIFACT, asset.key().as_ref()], bump = record.bump)]
    pub record: Box<Account<'info, ArtifactRecord>>,
    /// CHECK: collection PDA
    #[account(seeds = [SEED_COLLECTION], bump = config.bumps[3])]
    pub collection: UncheckedAccount<'info>,
}

pub fn join_war(ctx: Context<JoinWar>, move_key: Pubkey) -> Result<()> {
    let w = &ctx.accounts.war;
    require!(w.state == WAR_OPEN, ForgeError::WarState);
    require!(ctx.accounts.opponent.key() != w.creator, ForgeError::SelfDuel);
    check_ticket(&ctx.accounts.asset, &ctx.accounts.record, &ctx.accounts.collection.key(), &ctx.accounts.opponent.key())?;
    let stake = w.stake;
    debit_balance(&mut ctx.accounts.opponent_state, stake)?;
    move_lamports(&ctx.accounts.opponent_state.to_account_info(), &ctx.accounts.war.to_account_info(), stake)?;
    let w = &mut ctx.accounts.war;
    w.opponent = ctx.accounts.opponent.key();
    w.keys[1] = if move_key == Pubkey::default() { w.opponent } else { move_key };
    w.state = WAR_STARTING;
    w.target_slot = Clock::get()?.slot + 1;
    Ok(())
}

#[derive(Accounts)]
pub struct StartWar<'info> {
    #[account(mut, seeds = [SEED_WAR, war.creator.as_ref(), war.nonce.to_le_bytes().as_ref()], bump = war.bump)]
    pub war: Box<Account<'info, War>>,
    /// CHECK: SlotHashes sysvar (address checked when read)
    pub slot_hashes: UncheckedAccount<'info>,
}

/// PERMISSIONLESS. If the committed block left the SlotHashes window, a new one is committed
/// (the draw order is public to both players, and either of them can start, so nobody gains by waiting).
pub fn start_war(ctx: Context<StartWar>) -> Result<()> {
    let key = ctx.accounts.war.key();
    let w = &mut ctx.accounts.war;
    require!(w.state == WAR_STARTING, ForgeError::WarState);
    match slot_hash_at_or_after(&ctx.accounts.slot_hashes, w.target_slot)? {
        SlotHashLookup::NotYet => err!(ForgeError::NotReady),
        SlotHashLookup::Expired => {
            w.target_slot = Clock::get()?.slot + 1;
            Ok(())
        }
        SlotHashLookup::Ready(h) => {
            let seed = keccak(&[b"MOONFORGE_WAR", &h, key.as_ref()]);
            war_setup(w, &seed);
            w.deadline = Clock::get()?.unix_timestamp.saturating_add(WAR_TURN_TIMEOUT);
            emit!(WarStarted { war: key, seed });
            Ok(())
        }
    }
}

#[derive(Accounts)]
pub struct WarMove<'info> {
    #[account(mut, seeds = [SEED_WAR, war.creator.as_ref(), war.nonce.to_le_bytes().as_ref()], bump = war.bump)]
    pub war: Box<Account<'info, War>>,
    pub signer: Signer<'info>,
}

fn check_mover(w: &War, signer: &Pubkey, now: i64) -> Result<()> {
    require!(w.state == WAR_ACTIVE, ForgeError::WarState);
    require!(now <= w.deadline, ForgeError::DeadlinePassed);
    let owner = if w.turn == 0 { w.creator } else { w.opponent };
    require!(*signer == w.keys[w.turn as usize] || *signer == owner, ForgeError::NotYourTurn);
    Ok(())
}

pub fn war_summon_ix(ctx: Context<WarMove>, hand_index: u8) -> Result<()> {
    check_mover(&ctx.accounts.war, &ctx.accounts.signer.key(), Clock::get()?.unix_timestamp)?;
    war_summon(&mut ctx.accounts.war, hand_index)
}

pub fn war_attack_ix(ctx: Context<WarMove>, attacker: u8, target: u8) -> Result<()> {
    check_mover(&ctx.accounts.war, &ctx.accounts.signer.key(), Clock::get()?.unix_timestamp)?;
    war_attack(&mut ctx.accounts.war, attacker, target)
}

pub fn war_end_turn_ix(ctx: Context<WarMove>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    check_mover(&ctx.accounts.war, &ctx.accounts.signer.key(), now)?;
    war_next_turn(&mut ctx.accounts.war, now);
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimWarTimeout<'info> {
    #[account(mut, seeds = [SEED_WAR, war.creator.as_ref(), war.nonce.to_le_bytes().as_ref()], bump = war.bump)]
    pub war: Box<Account<'info, War>>,
}

/// PERMISSIONLESS: the player to move let its turn time run out — the other player wins.
pub fn claim_war_timeout(ctx: Context<ClaimWarTimeout>) -> Result<()> {
    let w = &mut ctx.accounts.war;
    require!(w.state == WAR_ACTIVE, ForgeError::WarState);
    require!(Clock::get()?.unix_timestamp > w.deadline, ForgeError::DeadlineNotReached);
    w.state = WAR_DONE;
    w.timeout = true;
    w.winner = if w.turn == 0 { w.opponent } else { w.creator };
    Ok(())
}

#[derive(Accounts)]
pub struct SettleWar<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut, close = rent_payer,
        seeds = [SEED_WAR, war.creator.as_ref(), war.nonce.to_le_bytes().as_ref()], bump = war.bump
    )]
    pub war: Box<Account<'info, War>>,
    #[account(mut, seeds = [SEED_PLAYER, war.creator.as_ref()], bump = creator_state.bump)]
    pub creator_state: Box<Account<'info, PlayerState>>,
    #[account(mut, seeds = [SEED_PLAYER, war.opponent.as_ref()], bump = opponent_state.bump)]
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
    /// CHECK: receives the match account rent
    #[account(mut, address = war.rent_payer @ ForgeError::WrongRentPayer)]
    pub rent_payer: UncheckedAccount<'info>,
}

/// PERMISSIONLESS once the match is finished: pays the winner (or refunds both on a draw) and closes it.
pub fn settle_war(ctx: Context<SettleWar>) -> Result<()> {
    let a = &mut *ctx.accounts;
    require!(a.war.state == WAR_DONE, ForgeError::WarState);
    let stake = a.war.stake;
    let pot = stake.checked_mul(2).ok_or(ForgeError::MathOverflow)?;
    let winfo = a.war.to_account_info();
    let war_key = a.war.key();
    if a.war.draw {
        credit(&a.creator_state.to_account_info(), &mut a.creator_state, &winfo, stake)?;
        credit(&a.opponent_state.to_account_info(), &mut a.opponent_state, &winfo, stake)?;
        emit!(WarFinished { war: war_key, winner: Pubkey::default(), pot, prize: 0, timeout: a.war.timeout });
        return Ok(());
    }
    let rake = split_rake(&winfo, &a.reward_vault.to_account_info(), &a.architect.to_account_info(), &a.draw_vault.to_account_info(), pot)?;
    let prize = pot - rake.0 - rake.1 - rake.2;
    let winner = a.war.winner;
    if winner == a.war.creator {
        credit(&a.creator_state.to_account_info(), &mut a.creator_state, &winfo, prize)?;
    } else {
        credit(&a.opponent_state.to_account_info(), &mut a.opponent_state, &winfo, prize)?;
    }
    add_rake_stats(&mut a.config, rake);
    a.config.stats.paid_to_players = a.config.stats.paid_to_players.saturating_add(prize);
    emit!(WarFinished { war: war_key, winner, pot, prize, timeout: a.war.timeout });
    Ok(())
}

#[cfg(test)]
mod war_tests {
    use super::*;

    fn war() -> War {
        War {
            creator: Pubkey::new_unique(), opponent: Pubkey::new_unique(), nonce: 0, stake: 0, state: WAR_STARTING, target_slot: 0,
            turn: 0, round: 0, deadline: 0, keys: [Pubkey::default(); 2], sides: [WarSide::default(); 2], winner: Pubkey::default(),
            draw: false, timeout: false, rent_payer: Pubkey::default(), bump: 0,
        }
    }

    #[test]
    fn decks_are_permutations_of_the_same_ten_cards() {
        for s in 0..20u8 {
            for side in 0..2 {
                let mut d = shuffle(&[s; 32], side);
                d.sort();
                assert_eq!(d, [0, 0, 0, 0, 1, 1, 1, 2, 2, 3]);
            }
        }
    }

    #[test]
    fn setup_draws_three_and_creator_starts_with_one_mana() {
        let mut w = war();
        war_setup(&mut w, &[7; 32]);
        for s in &w.sides {
            assert_eq!((s.health, s.hand_len, s.deck_left), (20, 3, 7));
        }
        assert_eq!((w.turn, w.round, w.sides[0].mana, w.state), (0, 1, 1, WAR_ACTIVE));
    }

    #[test]
    fn mana_ramps_like_the_practice_engine() {
        let mut w = war();
        war_setup(&mut w, &[1; 32]);
        let mut seen = vec![];
        for _ in 0..12 {
            war_next_turn(&mut w, 0);
            seen.push(w.sides[w.turn as usize].mana);
        }
        // round 2..13 → min(10, ceil(r/2)+1)
        assert_eq!(seen, vec![2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8]);
    }

    #[test]
    fn summon_attack_rules_and_solar_burn() {
        let mut w = war();
        war_setup(&mut w, &[3; 32]);
        // put a Solar and a Lunar in creator's hand, give mana
        w.sides[0].hand = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        w.sides[0].hand_len = 2;
        w.sides[0].mana = 4;
        war_summon(&mut w, 0).unwrap(); // Solar: burns 2
        assert_eq!(w.sides[1].health, 18);
        assert_eq!(w.sides[0].mana, 1);
        assert!(war_summon(&mut w, 5).is_err()); // invalid index
        war_summon(&mut w, 0).unwrap(); // Lunar
        assert!(war_summon(&mut w, 0).is_err()); // hand empty now
        // summoning sickness
        assert!(war_attack(&mut w, 0, 255).is_err());
        war_next_turn(&mut w, 0); // opponent
        war_next_turn(&mut w, 0); // creator again: units ready
        war_attack(&mut w, 0, 255).unwrap(); // Solar hits face for 6
        assert_eq!(w.sides[1].health, 12);
        assert!(war_attack(&mut w, 0, 255).is_err()); // once per turn
    }

    #[test]
    fn must_clear_the_field_before_hitting_the_player_and_trades_resolve() {
        let mut w = war();
        war_setup(&mut w, &[4; 32]);
        w.sides[0].field[0] = WarUnit { element: 1, defense: 3, ready: true }; // Cosmic 4/3
        w.sides[0].field_len = 1;
        w.sides[1].field[0] = WarUnit { element: 0, defense: 2, ready: false }; // Lunar 2/2
        w.sides[1].field_len = 1;
        assert!(war_attack(&mut w, 0, 255).is_err());
        war_attack(&mut w, 0, 0).unwrap();
        assert_eq!(w.sides[1].field_len, 0); // Lunar destroyed
        assert_eq!(w.sides[0].field[0].defense, 1); // Cosmic took 2
    }

    #[test]
    fn lethal_ends_the_match_and_fatigue_eventually_ends_any_game() {
        let mut w = war();
        war_setup(&mut w, &[5; 32]);
        w.sides[1].health = 2;
        w.sides[0].field[0] = WarUnit { element: 0, defense: 2, ready: true };
        w.sides[0].field_len = 1;
        war_attack(&mut w, 0, 255).unwrap();
        assert_eq!(w.state, WAR_DONE);
        assert_eq!(w.winner, w.creator);

        // nobody plays: decks run out and fatigue ends the game before the round cap
        let mut w = war();
        war_setup(&mut w, &[6; 32]);
        let mut turns = 0;
        while w.state == WAR_ACTIVE {
            war_next_turn(&mut w, 0);
            turns += 1;
            assert!(turns < 500);
        }
        assert!(w.round <= WAR_MAX_ROUNDS);
    }
}
