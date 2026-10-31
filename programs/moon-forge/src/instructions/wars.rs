//! Moon Wars — the card battle of the free practice, played for real XNT, player vs player.
//!
//! Since the final upgrade every match starts sealed; no block hash and no Artifact ticket are involved:
//! create_war_sealed : creator stakes XNT (from the game wallet), names its move key (its wallet or a key made in
//!                     its own browser) and commits keccak("MOONFORGE_WAR_ENTROPY" ‖ entropy ‖ war). The offer is
//!                     joinable for P2P_OFFER_TTL; cancel_war refunds it while nobody joined.
//! join_war_sealed   : an opponent matches the stake and commits keccak("MOONFORGE_WAR_JOIN" ‖ secret ‖ war ‖
//!                     opponent ‖ move_key). The creator can no longer cancel.
//! seed_war          : the creator opens its entropy within WAR_SEED_WINDOW (else the match is a draw: refund).
//! reveal_war        : the joiner opens its secret within WAR_REVEAL_WINDOW (else the creator wins). The seed
//!                     keccak("MOONFORGE_WAR_V2" ‖ entropy ‖ secret ‖ war) shuffles both decks (public to both —
//!                     perfect information, like chess) and draws the first mover.
//! moves             : war_summon / war_attack / war_end_turn under a chess clock: the first WAR_TURN_FREE s of a
//!                     turn are free, beyond that a turn draws on the mover's WAR_TIME_BANK; the creator's first
//!                     turn is a WAR_FIRST_TURN_GRACE it did not choose. Same rules as the practice engine.
//! timeout           : PERMISSIONLESS — the player whose action is awaited lets its time run out and loses.
//! settle_war        : PERMISSIONLESS once finished: winner gets both stakes minus the 2% P2P rake (1.5% pool,
//!                     0.5% architect); a draw refunds both stakes in full.
//! Matches joined before the upgrade keep their block-hash start (start_war, creator first; an expired block is a
//! draw, never a re-roll) and fixed WAR_TURN_TIMEOUT turns; create_war / join_war are retired.

use anchor_lang::prelude::*;

use crate::constants::*;
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

/// Sets up both sides from the seed; `first` (0 = creator, 1 = opponent) moves first with 1 mana.
pub fn war_setup(w: &mut War, seed: &[u8; 32], first: u8) {
    for side in 0..2u8 {
        let s = &mut w.sides[side as usize];
        *s = WarSide { health: WAR_START_HP, mana: 1, deck: shuffle(seed, side), deck_left: 10, ..Default::default() };
        for _ in 0..3 {
            draw(s);
        }
    }
    w.turn = first;
    w.round = 1;
    w.state = WAR_ACTIVE;
}

// ─── sealed start and chess clock (WAR_V2 = bit 63 of target_slot) ─────────

/// Created by the final-upgrade binary (sealed start). Older matches hold 0 or a real slot number (< 2^63).
pub fn is_v2(w: &War) -> bool {
    w.target_slot & WAR_V2 != 0
}
/// Chess-clock seconds left for player p (0 = creator, bits 16..31; 1 = opponent, bits 0..15).
fn clock_bank(w: &War, p: usize) -> i64 {
    (if p == 0 { (w.target_slot >> 16) as u16 } else { w.target_slot as u16 }) as i64
}
fn set_clock_bank(w: &mut War, p: usize, secs: i64) {
    let v = secs.clamp(0, u16::MAX as i64) as u64;
    w.target_slot = if p == 0 { (w.target_slot & !(0xFFFF_u64 << 16)) | (v << 16) } else { (w.target_slot & !0xFFFF_u64) | v };
}
/// The creator's first turn (round 1 or 2): it did not choose when the match started.
fn grace_turn(w: &War) -> bool {
    w.turn == 0 && w.round <= 2
}
/// Seconds allowed for the running turn (the mover's bank does not change while its turn runs).
pub fn turn_allot(w: &War) -> i64 {
    if grace_turn(w) {
        WAR_FIRST_TURN_GRACE
    } else if !is_v2(w) {
        WAR_TURN_TIMEOUT
    } else {
        WAR_TURN_FREE + clock_bank(w, w.turn as usize).min(WAR_TURN_TIMEOUT - WAR_TURN_FREE)
    }
}
/// Chess clock: what the ending turn used beyond WAR_TURN_FREE comes out of the mover's bank.
fn charge_clock(w: &mut War, now: i64) {
    if !is_v2(w) || grace_turn(w) {
        return;
    }
    let p = w.turn as usize;
    let started = w.deadline.saturating_sub(turn_allot(w));
    let over = now.saturating_sub(started).saturating_sub(WAR_TURN_FREE).max(0);
    set_clock_bank(w, p, clock_bank(w, p) - over);
}
/// 0 = creator moves first, 1 = opponent. A fair coin from the sealed seed.
pub fn first_mover(seed: &[u8; 32]) -> u8 {
    (random_u64(seed, b"MOONFORGE_WAR_FIRST", &[]) & 1) as u8
}
/// keccak("MOONFORGE_WAR_ENTROPY" ‖ entropy ‖ war): the creator's commitment at create.
pub fn war_entropy_commitment(entropy: &[u8; 32], war: &Pubkey) -> [u8; 32] {
    keccak(&[b"MOONFORGE_WAR_ENTROPY", entropy, war.as_ref()])
}
/// keccak("MOONFORGE_WAR_JOIN" ‖ secret ‖ war ‖ opponent ‖ move_key): the joiner's commitment at join.
pub fn war_join_commitment(secret: &[u8; 32], war: &Pubkey, opponent: &Pubkey, move_key: &Pubkey) -> [u8; 32] {
    keccak(&[b"MOONFORGE_WAR_JOIN", secret, war.as_ref(), opponent.as_ref(), move_key.as_ref()])
}
/// keccak("MOONFORGE_WAR_V2" ‖ entropy ‖ secret ‖ war): decks and first mover of a sealed match.
pub fn war_seed_v2(entropy: &[u8; 32], secret: &[u8; 32], war: &Pubkey) -> [u8; 32] {
    keccak(&[b"MOONFORGE_WAR_V2", entropy, secret, war.as_ref()])
}
/// Lapse routing of claim_war_timeout. ACTIVE: the player to move loses. STARTING (sealed): turn 0 = the creator
/// never seeded — it knew nothing, so the match is a draw (full refund, OD-4); turn 1 = the joiner never revealed —
/// the creator wins.
pub fn war_timeout(w: &mut War) -> Result<()> {
    let sealed_start = w.state == WAR_STARTING && is_v2(w);
    require!(w.state == WAR_ACTIVE || sealed_start, ForgeError::WarState);
    w.state = WAR_DONE;
    w.timeout = true;
    if sealed_start && w.turn == 0 {
        w.draw = true;
        w.winner = Pubkey::default();
    } else {
        w.winner = if w.turn == 0 { w.opponent } else { w.creator };
    }
    Ok(())
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
    charge_clock(w, now);
    let next = 1 - w.turn as usize;
    w.turn = next as u8;
    w.round = w.round.saturating_add(1);
    let s = &mut w.sides[next];
    s.mana = ((w.round as u32 + 1) / 2 + 1).min(10) as u8; // min(10, ceil(round/2) + 1)
    for k in 0..s.field_len as usize {
        s.field[k].ready = true;
    }
    draw(s);
    w.deadline = now.saturating_add(turn_allot(w));
    if !check_end(w) && w.round > WAR_MAX_ROUNDS {
        w.state = WAR_DONE;
        w.draw = true;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Instructions
// ═══════════════════════════════════════════════════════════════════════════

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
    /// CHECK: unused since v3 (ticket removed): pass the system program
    pub asset: UncheckedAccount<'info>,
    /// CHECK: unused since v3 (ticket removed): pass the system program
    pub record: UncheckedAccount<'info>,
    /// CHECK: unused since v3 (ticket removed): pass the system program
    pub collection: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Retired (same 48-byte ABI): matches start sealed since the final upgrade.
pub fn create_war(_ctx: Context<CreateWar>, _stake: u64, _move_key: Pubkey) -> Result<()> {
    err!(ForgeError::SealedJoinRequired)
}

/// entropy_commitment = keccak("MOONFORGE_WAR_ENTROPY" ‖ entropy ‖ war): the creator's half of the seed is fixed now,
/// so a dropped or retried transaction cannot change it later.
pub fn create_war_sealed(ctx: Context<CreateWar>, stake: u64, move_key: Pubkey, entropy_commitment: [u8; 32]) -> Result<()> {
    require!(entropy_commitment != [0u8; 32], ForgeError::BadCommitment);
    require!(stake >= WAR_MIN_STAKE, ForgeError::AmountTooSmall);
    let nonce = ctx.accounts.creator_state.nonce;
    debit_balance(&mut ctx.accounts.creator_state, stake)?;
    ctx.accounts.creator_state.nonce += 1;
    move_lamports(&ctx.accounts.creator_state.to_account_info(), &ctx.accounts.war.to_account_info(), stake)?;
    let w = &mut ctx.accounts.war;
    w.creator = ctx.accounts.owner.key();
    w.nonce = nonce;
    w.stake = stake;
    w.state = WAR_OPEN;
    w.target_slot = WAR_V2;
    w.keys = [if move_key == Pubkey::default() { w.creator } else { move_key }, Pubkey::default()];
    w.winner = Pubkey::new_from_array(entropy_commitment);
    w.deadline = Clock::get()?.unix_timestamp.saturating_add(P2P_OFFER_TTL);
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
    /// CHECK: unused since v3 (ticket removed): pass the system program
    pub asset: UncheckedAccount<'info>,
    /// CHECK: unused since v3 (ticket removed): pass the system program
    pub record: UncheckedAccount<'info>,
    /// CHECK: unused since v3 (ticket removed): pass the system program
    pub collection: UncheckedAccount<'info>,
}

/// Retired: pre-upgrade OPEN matches leave through cancel_war (full refund).
pub fn join_war(_ctx: Context<JoinWar>, _move_key: Pubkey) -> Result<()> {
    err!(ForgeError::SealedJoinRequired)
}

/// commitment = keccak("MOONFORGE_WAR_JOIN" ‖ secret ‖ war ‖ opponent ‖ move_key): the join tells nobody anything
/// about the seed, so the creator cannot answer it with a cancel; the joiner's move key is installed at its reveal.
pub fn join_war_sealed(ctx: Context<JoinWar>, commitment: [u8; 32]) -> Result<()> {
    require!(commitment != [0u8; 32], ForgeError::BadCommitment);
    let now = Clock::get()?.unix_timestamp;
    let w = &ctx.accounts.war;
    require!(w.state == WAR_OPEN && is_v2(w), ForgeError::WarState);
    require!(now <= w.deadline, ForgeError::DeadlinePassed); // offer TTL
    require!(ctx.accounts.opponent.key() != w.creator, ForgeError::SelfDuel);
    let stake = w.stake;
    debit_balance(&mut ctx.accounts.opponent_state, stake)?;
    move_lamports(&ctx.accounts.opponent_state.to_account_info(), &ctx.accounts.war.to_account_info(), stake)?;
    let w = &mut ctx.accounts.war;
    w.opponent = ctx.accounts.opponent.key();
    w.keys[1] = Pubkey::new_from_array(commitment);
    w.state = WAR_STARTING;
    w.turn = 0; // awaiting the creator's entropy
    w.deadline = now.saturating_add(WAR_SEED_WINDOW);
    Ok(())
}

#[derive(Accounts)]
pub struct StartWar<'info> {
    #[account(mut, seeds = [SEED_WAR, war.creator.as_ref(), war.nonce.to_le_bytes().as_ref()], bump = war.bump)]
    pub war: Box<Account<'info, War>>,
    /// CHECK: SlotHashes sysvar (address checked when read)
    pub slot_hashes: UncheckedAccount<'info>,
}

/// PERMISSIONLESS, matches joined before the final upgrade only (block-hash seed, creator first). An expired seed
/// block is a draw (full refund through settle_war): a fresh block would be a free re-roll for a player who
/// dislikes the known shuffle.
pub fn start_war(ctx: Context<StartWar>) -> Result<()> {
    let key = ctx.accounts.war.key();
    let w = &mut ctx.accounts.war;
    require!(w.state == WAR_STARTING && !is_v2(w), ForgeError::WarState);
    match slot_hash_at_or_after(&ctx.accounts.slot_hashes, w.target_slot)? {
        SlotHashLookup::NotYet => err!(ForgeError::NotReady),
        SlotHashLookup::Expired => {
            w.state = WAR_DONE;
            w.draw = true;
            Ok(())
        }
        SlotHashLookup::Ready(h) => {
            let seed = keccak(&[b"MOONFORGE_WAR", &h, key.as_ref()]);
            war_setup(w, &seed, 0); // original rules: the creator moves first
            w.deadline = Clock::get()?.unix_timestamp.saturating_add(turn_allot(w)); // the creator's grace turn
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

/// The creator (or its move key) opens its entropy, after the joiner's half is sealed: it cannot know the seed, so it
/// cannot steer it. The entropy must match the commitment made at create.
pub fn seed_war(ctx: Context<WarMove>, entropy: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let key = ctx.accounts.war.key();
    let signer = ctx.accounts.signer.key();
    let w = &mut ctx.accounts.war;
    require!(w.state == WAR_STARTING && is_v2(w) && w.turn == 0, ForgeError::WarState);
    require!(now <= w.deadline, ForgeError::DeadlinePassed);
    require!(signer == w.creator || signer == w.keys[0], ForgeError::Unauthorized);
    require!(entropy != [0u8; 32] && war_entropy_commitment(&entropy, &key) == w.winner.to_bytes(), ForgeError::BadCommitment);
    w.winner = Pubkey::new_from_array(entropy);
    w.turn = 1; // awaiting the joiner's reveal
    w.deadline = now.saturating_add(WAR_REVEAL_WINDOW);
    Ok(())
}

/// The joiner (or the move key it committed to) opens its secret and the match starts: the seed decides both
/// shuffles and the first mover. No block hash is involved.
pub fn reveal_war(ctx: Context<WarMove>, secret: [u8; 32], move_key: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let key = ctx.accounts.war.key();
    let signer = ctx.accounts.signer.key();
    let w = &mut ctx.accounts.war;
    require!(w.state == WAR_STARTING && is_v2(w) && w.turn == 1, ForgeError::WarState);
    require!(now <= w.deadline, ForgeError::DeadlinePassed);
    require!(war_join_commitment(&secret, &key, &w.opponent, &move_key) == w.keys[1].to_bytes(), ForgeError::BadCommitment);
    require!(signer == w.opponent || (move_key != Pubkey::default() && signer == move_key), ForgeError::Unauthorized);
    let entropy = w.winner.to_bytes();
    let seed = war_seed_v2(&entropy, &secret, &key);
    let first = first_mover(&seed);
    w.keys[1] = if move_key == Pubkey::default() { w.opponent } else { move_key };
    w.winner = Pubkey::default();
    war_setup(w, &seed, first);
    w.target_slot = WAR_V2 | ((WAR_TIME_BANK as u64) << 16) | WAR_TIME_BANK as u64;
    w.deadline = now.saturating_add(turn_allot(w));
    emit!(WarStarted { war: key, seed });
    emit!(WarSeedOpened { war: key, creator_entropy: entropy, joiner_secret: secret, first });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimWarTimeout<'info> {
    #[account(mut, seeds = [SEED_WAR, war.creator.as_ref(), war.nonce.to_le_bytes().as_ref()], bump = war.bump)]
    pub war: Box<Account<'info, War>>,
}

/// PERMISSIONLESS: the player whose action is awaited let its time run out (see `war_timeout` for the routing).
pub fn claim_war_timeout(ctx: Context<ClaimWarTimeout>) -> Result<()> {
    let w = &mut ctx.accounts.war;
    let sealed_start = w.state == WAR_STARTING && is_v2(w);
    require!(w.state == WAR_ACTIVE || sealed_start, ForgeError::WarState);
    require!(Clock::get()?.unix_timestamp > w.deadline, ForgeError::DeadlineNotReached);
    war_timeout(w)
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
        war_setup(&mut w, &[7; 32], 0);
        for s in &w.sides {
            assert_eq!((s.health, s.hand_len, s.deck_left), (20, 3, 7));
        }
        assert_eq!((w.turn, w.round, w.sides[0].mana, w.state), (0, 1, 1, WAR_ACTIVE));
    }

    #[test]
    fn mana_ramps_like_the_practice_engine() {
        let mut w = war();
        war_setup(&mut w, &[1; 32], 0);
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
        war_setup(&mut w, &[3; 32], 0);
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
        war_setup(&mut w, &[4; 32], 0);
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
        war_setup(&mut w, &[5; 32], 0);
        w.sides[1].health = 2;
        w.sides[0].field[0] = WarUnit { element: 0, defense: 2, ready: true };
        w.sides[0].field_len = 1;
        war_attack(&mut w, 0, 255).unwrap();
        assert_eq!(w.state, WAR_DONE);
        assert_eq!(w.winner, w.creator);

        // nobody plays: decks run out and fatigue ends the game before the round cap
        let mut w = war();
        war_setup(&mut w, &[6; 32], 0);
        let mut turns = 0;
        while w.state == WAR_ACTIVE {
            war_next_turn(&mut w, 0);
            turns += 1;
            assert!(turns < 500);
        }
        assert!(w.round <= WAR_MAX_ROUNDS);
    }

    fn hex32(s: &str) -> [u8; 32] {
        let mut o = [0u8; 32];
        for i in 0..32 {
            o[i] = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
        }
        o
    }
    fn war_v2() -> War {
        let mut w = war();
        w.target_slot = WAR_V2 | ((WAR_TIME_BANK as u64) << 16) | WAR_TIME_BANK as u64;
        w
    }

    #[test]
    fn vectors_match_the_clients() {
        // Appendix A: war 0x03×32, entropy 0x11×32, secret 0x22×32, opponent 0x02×32, move key 0x05×32
        let (war_key, opp, mk) = (Pubkey::new_from_array([3; 32]), Pubkey::new_from_array([2; 32]), Pubkey::new_from_array([5; 32]));
        assert_eq!(
            war_entropy_commitment(&[0x11; 32], &war_key),
            hex32("e378a43ae0a14034a945d26c989404d4fdeef6bc9f55a88dc5ac25b4d6b5c47e")
        );
        assert_eq!(
            war_join_commitment(&[0x22; 32], &war_key, &opp, &mk),
            hex32("9b626ddbfe0a5a98d56d34f1bd17e240cda294693fc47bd3a4f211a60597c4ca")
        );
        assert_eq!(
            war_join_commitment(&[0x22; 32], &war_key, &opp, &Pubkey::default()),
            hex32("30a7c218735b2adf3d68246cc4bf597f1e6f0761e1b05de96d86eb27403efa7d")
        );
        let seed = war_seed_v2(&[0x11; 32], &[0x22; 32], &war_key);
        assert_eq!(seed, hex32("68a32bd6dbee1110f0c0483b611d5aaebe22f342361234bd08f2898b58f890f7"));
        assert_eq!(first_mover(&seed), 1);
        assert_eq!(shuffle(&seed, 0), [2, 2, 1, 0, 1, 3, 1, 0, 0, 0]);
        assert_eq!(shuffle(&seed, 1), [0, 1, 0, 0, 1, 3, 2, 0, 2, 1]);
        // clock words: mainnet 0x80000000012c012c (300 s each), localnet 0x80000000000c000c (12 s)
        #[cfg(not(feature = "localnet"))]
        assert_eq!(war_v2().target_slot, 0x8000_0000_012c_012c);
        #[cfg(feature = "localnet")]
        assert_eq!(war_v2().target_slot, 0x8000_0000_000c_000c);
    }

    #[test]
    fn first_mover_is_a_fair_coin() {
        let ones: u32 = (0..10_000u32).map(|i| first_mover(&keccak(&[&i.to_le_bytes()])) as u32).sum();
        assert!((4_800..5_200).contains(&ones), "{ones}");
    }

    #[test]
    fn setup_honours_the_first_mover() {
        let mut w = war_v2();
        war_setup(&mut w, &[7; 32], 1);
        assert_eq!((w.turn, w.round, w.state), (1, 1, WAR_ACTIVE));
        assert_eq!((w.sides[0].mana, w.sides[1].mana, w.sides[0].hand_len, w.sides[1].hand_len), (1, 1, 3, 3));
        assert_eq!(turn_allot(&w), WAR_TURN_FREE + WAR_TIME_BANK.min(WAR_TURN_TIMEOUT - WAR_TURN_FREE));
        w.deadline = 100 + turn_allot(&w);
        war_next_turn(&mut w, 101); // the opponent ends quickly; the creator now plays its first turn: grace
        assert_eq!((w.turn, w.round, w.deadline), (0, 2, 101 + WAR_FIRST_TURN_GRACE));
    }

    #[test]
    fn grace_is_free_and_the_clock_charges_only_beyond_the_free_seconds() {
        let mut w = war_v2();
        war_setup(&mut w, &[7; 32], 0);
        assert_eq!(turn_allot(&w), WAR_FIRST_TURN_GRACE);
        w.deadline = 1_000 + WAR_FIRST_TURN_GRACE;
        war_next_turn(&mut w, 1_000 + WAR_FIRST_TURN_GRACE); // used the whole grace
        assert_eq!(clock_bank(&w, 0), WAR_TIME_BANK);
        let start = 1_000 + WAR_FIRST_TURN_GRACE;
        war_next_turn(&mut w, start + WAR_TURN_FREE + 3); // opponent: 3 s beyond the free part
        assert_eq!(clock_bank(&w, 1), WAR_TIME_BANK - 3);
        assert_eq!(w.target_slot & WAR_V2, WAR_V2);
        set_clock_bank(&mut w, 1, 0);
        w.turn = 1;
        w.round = 9;
        assert_eq!(turn_allot(&w), WAR_TURN_FREE); // empty bank: only the free seconds
    }

    #[test]
    fn older_matches_keep_fixed_turns_and_their_target_slot() {
        let mut w = war();
        w.target_slot = 777;
        war_setup(&mut w, &[1; 32], 0);
        assert_eq!(turn_allot(&w), WAR_FIRST_TURN_GRACE); // the creator's first turn (start_war)
        war_next_turn(&mut w, 50);
        assert_eq!((w.deadline, w.target_slot), (50 + WAR_TURN_TIMEOUT, 777));
        war_next_turn(&mut w, 60);
        assert_eq!(w.deadline, 60 + WAR_TURN_TIMEOUT);
    }

    #[test]
    fn stalling_is_bounded() {
        for first in 0..2u8 {
            let mut w = war_v2();
            war_setup(&mut w, &[8; 32], first);
            let mut now = 0i64;
            w.deadline = turn_allot(&w);
            let (mut used, mut turns) = ([0i64; 2], [0i64; 2]);
            while w.state == WAR_ACTIVE {
                let p = w.turn as usize;
                used[p] += w.deadline - now;
                turns[p] += 1;
                now = w.deadline; // every turn ends at the last allowed second
                war_next_turn(&mut w, now);
            }
            assert!(w.round <= 56, "round {}", w.round);
            assert!(used[0] <= WAR_FIRST_TURN_GRACE + WAR_TIME_BANK + (turns[0] - 1) * WAR_TURN_FREE);
            assert!(used[1] <= WAR_TIME_BANK + turns[1] * WAR_TURN_FREE);
        }
    }

    #[test]
    fn a_lapsed_seed_is_a_draw_and_a_lapsed_reveal_loses() {
        // the creator never seeded (STARTING, turn 0): draw, both refunded
        let mut w = war_v2();
        w.target_slot = WAR_V2;
        w.state = WAR_STARTING;
        w.turn = 0;
        w.winner = Pubkey::new_from_array([9; 32]); // the entropy commitment
        war_timeout(&mut w).unwrap();
        assert!(w.draw && w.timeout && w.state == WAR_DONE && w.winner == Pubkey::default());
        // the joiner never revealed (STARTING, turn 1): the creator wins
        let mut w = war_v2();
        w.target_slot = WAR_V2;
        w.state = WAR_STARTING;
        w.turn = 1;
        w.winner = Pubkey::new_from_array([0x11; 32]); // the creator's opened entropy
        war_timeout(&mut w).unwrap();
        assert!(!w.draw && w.winner == w.creator);
        // ACTIVE: the player to move loses
        let mut w = war_v2();
        war_setup(&mut w, &[2; 32], 1);
        war_timeout(&mut w).unwrap();
        assert_eq!(w.winner, w.creator);
        // a legacy STARTING match has no seed step to time out (start_war handles it), nor has an OPEN one
        let mut w = war();
        assert!(war_timeout(&mut w).is_err());
        let mut w = war_v2();
        w.state = WAR_OPEN;
        assert!(war_timeout(&mut w).is_err());
    }
}
