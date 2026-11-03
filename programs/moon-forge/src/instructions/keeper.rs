//! House keeper seat: hash-chain randomness for house bets and the Jackpot (final upgrade, SPEC-UPGRADE-v2 2.9).
//!
//! At placement the program fixes the anchor block (slot + 1), whose producer does not know the keeper's preimage.
//! Within 512 slots anyone mixes that block's hash into the bet (anchor_bet). Afterwards the keeper reveals the next
//! preimage of its committed chain; roll = random_u64(reveal, bet, mixed seed) % 10_000 (utils.rs, frozen).
//!   arm_keeper        : the keeper commits a chain head (tip) with a bond (>= 20 XNT); only with nothing pending. The
//!                       first arm creates the seat: INITIAL_KEEPER only before KEEPER_OPEN_TS, any signer from then on
//!   place_bet_v2      : a house bet, given the next chain position; the bond must cover every pending payout
//!   anchor_bet        : PERMISSIONLESS: mixes the anchor block's hash into the bet's seed
//!   settle_bet_v2     : the next preimage, in chain order; PERMISSIONLESS for whoever holds it (a leaked reveal can
//!                       only produce the true outcome of the bet at position `revealed`)
//!   reveal_keeper     : KEEPER ONLY: skips a position (refunded bet, expired Jackpot round) with its preimage
//!   refund_stalled_bet: PERMISSIONLESS. Every stall costs the keeper's BOND the whole stake or more (round 4, review
//!                       F1). Anchored and not revealed within KEEPER_STALL_SLOTS (or skipped): the player is paid as a
//!                       WIN by the bond, and the bankroll keeps the stake exactly as for a lost bet. Never anchored and
//!                       its block left SlotHashes: the player is made whole (the bankroll returns stake_in, the bond
//!                       pays the edge) and the bond forfeits stake_in to nobody (it stays in the seat above `bond`;
//!                       review r4 finding 1: nobody, an LP included, gains from a bet left unanchored). So a keeper that
//!                       bets on itself loses its whole stake on any bet it leaves unanchored or unrevealed: selective
//!                       anchoring or settling never pays.
//!   keeper_withdraw   : 0 = request / cancel; > 0 after KEEPER_NOTICE, with nothing pending
//!   propose_keeper / take_keeper: hand-over after KEEPER_NOTICE, or anyone after KEEPER_DEAD_DELAY without
//!                       keeper activity. Nobody can veto.
//! The keeper can never re-arm while a bet or a v3 Jackpot round is pending, and a stall always costs its bond at
//! least what revealing would have cost the bankroll, so stalling never pays, whatever LP share it holds.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
use anchor_lang::system_program::{transfer, Transfer};

use crate::constants::*;
use crate::errors::ForgeError;
use crate::events::*;
use crate::instructions::games::{authorize_play, bet_edge, bet_limits, debit_balance, game_odds, is_win};
use crate::state::*;
use crate::utils::*;

// ═══════════════════════════════════════════════════════════════════════════
// Pure rules (unit-tested)
// ═══════════════════════════════════════════════════════════════════════════

/// keccak(reveal) == tip: `reveal` is the next preimage of the committed chain (x_k = keccak(x_{k+1}), tip = x_0).
pub fn chain_next_ok(tip: &[u8; 32], reveal: &[u8; 32]) -> bool {
    keccak(&[reveal]) == *tip
}

/// A new chain head (arm_keeper, take_keeper): non-zero, not the current head (K-5), 1 ..= KEEPER_MAX_CHAIN reveals.
pub fn check_new_chain(current: &[u8; 32], tip: &[u8; 32], length: u64) -> Result<()> {
    require!(*tip != [0u8; 32] && tip != current, ForgeError::BadReveal);
    require!((1..=KEEPER_MAX_CHAIN).contains(&length), ForgeError::InvalidTarget);
    Ok(())
}

/// Installs an armed chain: every position from 0, nothing revealed, anchors must come after `slot`.
pub fn install_chain(k: &mut HouseKeeper, tip: [u8; 32], length: u64, slot: u64, now: i64) {
    k.tip = tip;
    k.length = length;
    k.next_index = 0;
    k.revealed = 0;
    k.armed_slot = slot;
    k.last_active_ts = now;
}

/// Starts a new 7-day loss window at the bankroll's current optimistic value once the old one is over.
pub fn roll_week(k: &mut HouseKeeper, now: i64, vault: u64) {
    if now >= k.week_start_ts.saturating_add(WEEK_WINDOW) {
        k.week_start_ts = now;
        k.week_start_bankroll = vault;
        k.week_net_loss = 0;
    }
}

/// Base of the 7-day loss limit: the window-start bankroll, lowered by whatever left the bankroll since without
/// being booked as a v2 bet result (LP withdrawals, legacy-bet wins). `vault + week_net_loss` is the window-start
/// bankroll plus every inflow since (pending stakes, deposits) minus those outflows, so min() never raises the base
/// (a deposit does not enlarge the current window) and follows any exit (finding L2: after a 50% LP exit the weekly
/// term no longer allows 30% of what remains).
pub fn week_base(week_start: u64, vault: u64, week_net_loss: i64) -> u64 {
    let flow_adjusted = (vault as i128 + week_net_loss as i128).max(0);
    (week_start as i128).min(flow_adjusted) as u64
}

/// Realized bankroll loss of a settled v2 bet (negative = the bankroll gained).
pub fn bet_net_loss(won: bool, stake_in: u64, payout: u64) -> i64 {
    if won {
        payout.saturating_sub(stake_in).min(i64::MAX as u64) as i64
    } else {
        -(stake_in.min(i64::MAX as u64) as i64)
    }
}

/// Why a v2 bet is refundable (BetRefunded.reason), or None if it is not stalled.
/// 1 = the keeper skipped its position (index < revealed), or it was anchored and not revealed by
///     anchor + KEEPER_STALL_SLOTS: only the keeper could have revealed it and it knew the outcome, so it is a WIN;
/// 0 = never anchored and its anchor block left SlotHashes (anyone could have anchored it): a refund. SlotHashes reads
///     carry the r9 time fallback (utils.rs age_limited): past SLOT_HASH_MAX_AGE the anchor counts as gone even if the
///     sysvar stopped answering for it.
pub fn stall_reason(anchored: bool, index: u64, anchor: u64, revealed: u64, slot: u64, anchor_expired: bool) -> Option<u8> {
    if index < revealed || (anchored && slot > anchor.saturating_add(KEEPER_STALL_SLOTS)) {
        Some(1)
    } else if !anchored && anchor_expired {
        Some(0)
    } else {
        None
    }
}

/// (from the bond to the player on top of `stake_in`, stake the bankroll keeps paid by the bond, bond forfeited to
/// nobody) of a stalled bet. Round 4 (review F1, s6-minus-7 MANIFEST §4 item 8) and r4-fix (review r4 finding 1):
///   - reason 1 (anchored and not revealed, or skipped): booked by the house exactly as a LOST bet. The bankroll keeps
///     `stake_in` and the keeper's bond pays the player everything: the player gets `payout` (paid as a win).
///   - reason 0 (never anchored): the bankroll returns `stake_in` (it never carried the bet: the bet is undone for
///     the house) and the bond pays the player the edge, so the player gets its whole stake back (made whole). The
///     bond ALSO forfeits `stake_in` to nobody: those lamports stay in the keeper seat, above `bond`, and no instruction
///     ever pays them out (take_keeper / keeper_withdraw pay only `bond`). So an unanchored bet costs the bond the
///     whole stake (edge + stake_in), as in round 4, while nobody gains from it: not the bankroll (an LP that places
///     bets it never anchors while no keeper runs would earn its bankroll share of every stake: review r4 finding 1),
///     not the pool (a dominant burner would), not the architect, not the player (made whole, never more).
/// The pool and the architect keep the placement edge, as for any bet, and get nothing more. A keeper betting on
/// itself that leaves its losers unanchored loses exactly its stake, what it loses when it settles them, minus the
/// settle tip and its share of the bankroll's gain: selective anchoring never pays.
/// A short bond pays the player first, then the bankroll's kept stake (reason 1), then the forfeit (reason 0); the
/// bankroll returns the part of `stake_in` the bond could not cover (bet_limits keeps the bond >= every pending
/// payout >= what any stall needs, so it is never short).
pub fn stall_split(reason: u8, stake_in: u64, edge: u64, payout: u64, bond: u64) -> (u64, u64, u64) {
    if reason == 0 {
        let to_player = edge.min(bond);
        (to_player, 0, stake_in.min(bond - to_player))
    } else {
        let to_player = payout.saturating_sub(stake_in).min(bond);
        (to_player, stake_in.min(bond - to_player), 0)
    }
}

/// Reserves the next chain position for a v3 Jackpot draw if the keeper can take it (a position is left, at most
/// JACKPOT_MAX_BACKLOG earlier positions are still unrevealed, and the bond covers every pending payout, every
/// DRAWING pot and this one); returns the packed target_slot. None = refund at once (reason 3, no penalty): nothing
/// about the outcome exists at draw time, so a refund here cannot be steered. The backlog cap keeps a flood of
/// cheap bets right before the draw from making the keeper miss the 512-slot settle window (an expiry costs its
/// bond the pot).
pub fn jackpot_draw(k: &mut HouseKeeper, bankroll_reserved: u64, total: u64, slot: u64) -> Option<u64> {
    let need = bankroll_reserved.saturating_add(k.jackpot_reserved).saturating_add(total);
    let backlog = k.next_index.saturating_sub(k.revealed);
    if k.next_index >= k.length || backlog > JACKPOT_MAX_BACKLOG || k.bond < need {
        return None;
    }
    let target = bet_pack(k.next_index, slot.saturating_add(1));
    k.next_index += 1;
    k.pending_bets = k.pending_bets.saturating_add(1);
    k.jackpot_reserved = k.jackpot_reserved.saturating_add(total);
    Some(target)
}

/// Winning ticket of a v3 Jackpot round: the legacy formula on keccak("MOONFORGE_JACKPOT_V2" ‖ block hash ‖ reveal).
pub fn jackpot_ticket_v2(h: &[u8; 32], reveal: &[u8; 32], round: &Pubkey, id: u64, total: u64) -> u64 {
    let h2 = keccak(&[b"MOONFORGE_JACKPOT_V2", h, reveal]);
    random_u64(&h2, round.as_ref(), &id.to_le_bytes()) % total
}

/// keeper_withdraw(amount > 0): what stays is 0 or >= KEEPER_BOND_MIN; the 7-day notice has run; nothing pending.
pub fn withdraw_check(bond: u64, amount: u64, withdraw_ts: i64, pending: u32, now: i64) -> Result<()> {
    let left = bond.checked_sub(amount).ok_or(ForgeError::KeeperBondTooSmall)?;
    require!(left == 0 || left >= KEEPER_BOND_MIN, ForgeError::KeeperBondTooSmall);
    require!(withdraw_ts != 0 && now >= withdraw_ts.saturating_add(KEEPER_NOTICE), ForgeError::KeeperNotice);
    require!(pending == 0, ForgeError::KeeperBusy);
    Ok(())
}

/// take_keeper: 0 = the named successor after KEEPER_NOTICE, 1 = anyone after KEEPER_DEAD_DELAY without activity.
pub fn take_keeper_gate(k: &HouseKeeper, taker: &Pubkey, now: i64) -> Result<u8> {
    let named = k.pending_keeper != Pubkey::default() && *taker == k.pending_keeper;
    if named && now >= k.pending_ts.saturating_add(KEEPER_NOTICE) {
        return Ok(0);
    }
    if now >= k.last_active_ts.saturating_add(KEEPER_DEAD_DELAY) {
        return Ok(1);
    }
    if named {
        err!(ForgeError::KeeperNotice)
    } else {
        err!(ForgeError::KeeperAlive)
    }
}

/// Who becomes the keeper when arm_keeper creates the seat (r9 dated opening): INITIAL_KEEPER before KEEPER_OPEN_TS,
/// the signer from then on (the seat was never armed: anyone may start it with its own chain and bond, the same trust
/// as take_keeper by anyone after KEEPER_DEAD_DELAY). An existing seat is never affected.
pub fn first_keeper(signer: Pubkey, now: i64) -> Pubkey {
    if now >= KEEPER_OPEN_TS {
        signer
    } else {
        INITIAL_KEEPER
    }
}

/// The keeper seat's bond as lamports above its rent.
fn pay_from_seat(seat: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    move_lamports(seat, to, amount)
}

// ═══════════════════════════════════════════════════════════════════════════
// Keeper seat
// ═══════════════════════════════════════════════════════════════════════════

#[derive(Accounts)]
pub struct HouseKeeperOnly<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_HOUSE_KEEPER], bump = keeper_seat.bump)]
    pub keeper_seat: Box<Account<'info, HouseKeeper>>,
    #[account(mut, address = keeper_seat.keeper @ ForgeError::OnlyKeeper)]
    pub keeper: Signer<'info>,
    /// CHECK: bankroll vault PDA
    #[account(mut, seeds = [SEED_BANKROLL_VAULT], bump = config.bumps[1])]
    pub bankroll_vault: UncheckedAccount<'info>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Same accounts as HouseKeeperOnly; the seat is created on the first arm (its keeper is then INITIAL_KEEPER, or from
/// KEEPER_OPEN_TS whoever signs that first arm: first_keeper).
#[derive(Accounts)]
pub struct ArmKeeper<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        init_if_needed, payer = keeper, space = 8 + HouseKeeper::INIT_SPACE,
        seeds = [SEED_HOUSE_KEEPER], bump
    )]
    pub keeper_seat: Box<Account<'info, HouseKeeper>>,
    /// The seat's keeper (checked in the handler: the seat may not exist yet). Pays the seat rent and the deposit.
    #[account(mut)]
    pub keeper: Signer<'info>,
    /// CHECK: bankroll vault PDA
    #[account(mut, seeds = [SEED_BANKROLL_VAULT], bump = config.bumps[1])]
    pub bankroll_vault: UncheckedAccount<'info>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Commits a new chain (tip = x_0, `length` reveals) and adds `deposit` to the bond. Only with nothing pending
/// (no v2 bet and no DRAWING v3 Jackpot round): a committed chain can never be swapped under a pending outcome.
pub fn arm_keeper(ctx: Context<ArmKeeper>, tip: [u8; 32], length: u64, deposit: u64) -> Result<()> {
    let clock = Clock::get()?;
    let signer = ctx.accounts.keeper.key();
    {
        let k = &mut ctx.accounts.keeper_seat;
        if k.keeper == Pubkey::default() {
            k.keeper = first_keeper(signer, clock.unix_timestamp);
            k.bump = ctx.bumps.keeper_seat;
        }
        require_keys_eq!(signer, k.keeper, ForgeError::OnlyKeeper);
        require!(k.pending_bets == 0, ForgeError::KeeperBusy);
        check_new_chain(&k.tip, &tip, length)?;
    }
    if deposit > 0 {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer { from: ctx.accounts.keeper.to_account_info(), to: ctx.accounts.keeper_seat.to_account_info() },
            ),
            deposit,
        )?;
    }
    let k = &mut ctx.accounts.keeper_seat;
    k.bond = k.bond.checked_add(deposit).ok_or(ForgeError::MathOverflow)?;
    require!(k.bond >= KEEPER_BOND_MIN, ForgeError::KeeperBondTooSmall);
    install_chain(k, tip, length, clock.slot, clock.unix_timestamp);
    emit!(KeeperArmed { keeper: k.keeper, tip, length, bond: k.bond, armed_slot: clock.slot });
    Ok(())
}

/// amount == 0: toggles the withdrawal request (the seat stays armed and keeps taking bets). amount > 0: after the
/// 7-day notice, with nothing pending, leaving 0 or at least KEEPER_BOND_MIN (K-4).
pub fn keeper_withdraw(ctx: Context<HouseKeeperOnly>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let k = &mut ctx.accounts.keeper_seat;
    if amount == 0 {
        k.withdraw_ts = if k.withdraw_ts == 0 { now } else { 0 };
        return Ok(());
    }
    withdraw_check(k.bond, amount, k.withdraw_ts, k.pending_bets, now)?;
    k.bond -= amount;
    k.withdraw_ts = 0;
    pay_from_seat(&ctx.accounts.keeper_seat.to_account_info(), &ctx.accounts.keeper.to_account_info(), amount)
}

#[derive(Accounts)]
pub struct RevealKeeper<'info> {
    #[account(mut, seeds = [SEED_HOUSE_KEEPER], bump = keeper_seat.bump)]
    pub keeper_seat: Box<Account<'info, HouseKeeper>>,
    /// The seat's keeper. A reveal is visible before it lands (the leader sees the keeper's pending settle, a failed
    /// or out-of-order settle puts it in the ledger): a permissionless skip would let anyone holding x_{p+1} turn a
    /// losing bet p into a stall refund paid as a WIN, or block the Ready path of a DRAWING Jackpot round.
    #[account(address = keeper_seat.keeper @ ForgeError::OnlyKeeper)]
    pub keeper: Signer<'info>,
}

/// KEEPER ONLY (finding H1; the spec's "permissionless" assumed only the keeper ever holds a preimage): consumes the
/// next preimage without settling anything. Skips the position of a refunded bet or of an expired Jackpot round.
/// Skipping a still-pending bet only harms the keeper: that bet becomes refundable at once as a WIN.
/// settle_bet_v2 / settle_jackpot_v2 stay permissionless: a leaked reveal there yields only the true outcome.
pub fn reveal_keeper(ctx: Context<RevealKeeper>, reveal: [u8; 32]) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let k = &mut ctx.accounts.keeper_seat;
    require!(chain_next_ok(&k.tip, &reveal), ForgeError::BadReveal);
    require!(k.revealed < k.next_index, ForgeError::BadReveal);
    k.tip = reveal;
    k.revealed += 1;
    k.last_active_ts = now;
    Ok(())
}

/// Names a successor; it may take the seat after KEEPER_NOTICE. Pubkey::default() cancels.
pub fn propose_keeper(ctx: Context<HouseKeeperOnly>, new_keeper: Pubkey) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let k = &mut ctx.accounts.keeper_seat;
    k.pending_keeper = new_keeper;
    k.pending_ts = if new_keeper == Pubkey::default() { 0 } else { now };
    Ok(())
}

#[derive(Accounts)]
pub struct TakeKeeper<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_HOUSE_KEEPER], bump = keeper_seat.bump)]
    pub keeper_seat: Box<Account<'info, HouseKeeper>>,
    /// CHECK: the outgoing keeper: gets its whole remaining bond back
    #[account(mut, address = keeper_seat.keeper @ ForgeError::InvalidTarget)]
    pub old_keeper: UncheckedAccount<'info>,
    /// The new keeper: pays the deposit.
    #[account(mut)]
    pub taker: Signer<'info>,
    /// CHECK: reward vault PDA (receives the old bond only if the old keeper's wallet could not hold it)
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// The named successor after the notice, or anyone once the seat is dead (28 days without arm / reveal / settle).
/// Needs nothing pending: stalled bets refund and DRAWING rounds settle or expire permissionlessly, so a dead
/// keeper never blocks its own replacement. The old bond goes back in full; the taker arms its own chain.
pub fn take_keeper(ctx: Context<TakeKeeper>, tip: [u8; 32], length: u64, deposit: u64) -> Result<()> {
    let clock = Clock::get()?;
    let taker = ctx.accounts.taker.key();
    let (by, old, old_bond) = {
        let k = &ctx.accounts.keeper_seat;
        let by = take_keeper_gate(k, &taker, clock.unix_timestamp)?;
        require!(k.pending_bets == 0, ForgeError::KeeperBusy);
        check_new_chain(&k.tip, &tip, length)?;
        (by, k.keeper, k.bond)
    };
    // The deposit CPI comes BEFORE the direct lamport move of the old bond: a move from the seat (carried by the CPI)
    // to the old keeper or the pool (not carried) would leave the caller unbalanced at the CPI boundary, and the
    // runtime refuses the whole instruction (UnbalancedInstruction; found by the v3 integration suite, B-2).
    if deposit > 0 {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer { from: ctx.accounts.taker.to_account_info(), to: ctx.accounts.keeper_seat.to_account_info() },
            ),
            deposit,
        )?;
    }
    {
        let seat = ctx.accounts.keeper_seat.to_account_info();
        let old_info = ctx.accounts.old_keeper.to_account_info();
        let pool = ctx.accounts.reward_vault.to_account_info();
        // a wallet emptied below rent exemption cannot take a dust bond: then it goes to the pool (liveness)
        let dest = architect_or_pool(&old_info, &pool, old_bond)?;
        pay_from_seat(&seat, dest, old_bond)?;
    }
    let k = &mut ctx.accounts.keeper_seat;
    k.bond = deposit;
    require!(k.bond >= KEEPER_BOND_MIN, ForgeError::KeeperBondTooSmall);
    k.keeper = taker;
    k.pending_keeper = Pubkey::default();
    k.pending_ts = 0;
    k.withdraw_ts = 0;
    install_chain(k, tip, length, clock.slot, clock.unix_timestamp);
    emit!(KeeperChanged { old_keeper: old, new_keeper: taker, by, bond: k.bond });
    emit!(KeeperArmed { keeper: taker, tip, length, bond: k.bond, armed_slot: clock.slot });
    Ok(())
}

// ═══════════════════════════════════════════════════════════════════════════
// House bets on the chain
// ═══════════════════════════════════════════════════════════════════════════

/// PlaceBet + keeper_seat. No SlotHashes account: the anchor is only fixed here, never read.
#[derive(Accounts)]
pub struct PlaceBetV2<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_PLAYER, player_state.owner.as_ref()], bump = player_state.bump)]
    pub player_state: Box<Account<'info, PlayerState>>,
    #[account(
        init, payer = signer, space = 8 + Bet::INIT_SPACE,
        seeds = [SEED_BET, player_state.key().as_ref(), player_state.nonce.to_le_bytes().as_ref()], bump
    )]
    pub bet: Box<Account<'info, Bet>>,
    /// CHECK: bankroll vault PDA
    #[account(mut, seeds = [SEED_BANKROLL_VAULT], bump = config.bumps[1])]
    pub bankroll_vault: UncheckedAccount<'info>,
    /// CHECK: reward vault PDA
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: architect payee (config.architect)
    #[account(mut, address = config.architect @ ForgeError::InvalidTarget)]
    pub architect: UncheckedAccount<'info>,
    /// Owner or session key. Pays the (refundable) bet account rent.
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
    #[account(mut, seeds = [SEED_HOUSE_KEEPER], bump = keeper_seat.bump)]
    pub keeper_seat: Box<Account<'info, HouseKeeper>>,
}

pub fn place_bet_v2(ctx: Context<PlaceBetV2>, game: u8, param: u64, choice: u8, stake: u64, seed: [u8; 32]) -> Result<()> {
    // Bets must be top-level instructions: no program can wrap them.
    require!(get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT, ForgeError::Unauthorized);
    require!(stake >= MIN_STAKE, ForgeError::AmountTooSmall);
    authorize_play(&ctx.accounts.player_state, &ctx.accounts.signer.key(), stake)?;

    let (chance_bps, payout_bps) = game_odds(game, param, choice)?;
    let payout = mul_div(stake, payout_bps, BPS)?;
    require!(payout > stake, ForgeError::InvalidGame);
    // 1% -> burners' pool, 0.5% -> architect, the rest -> bankroll (which then owes the full payout on a win)
    let mut to_pool = bps(stake, EDGE_TO_POOL_BPS)?;
    let mut to_arch = bps(stake, EDGE_TO_ARCHITECT_BPS)?;
    let edge = to_pool + to_arch;
    let stake_in = stake - edge;

    let clock = Clock::get()?;
    let (now, slot) = (clock.unix_timestamp, clock.slot);
    let today = now / DAY_SECONDS_FOR_BREAKER;
    let reserved = ctx.accounts.config.bankroll_reserved;
    let vault = free_balance(&ctx.accounts.bankroll_vault, 0)?;
    {
        let k = &mut ctx.accounts.keeper_seat;
        require!(k.next_index < k.length, ForgeError::KeeperNotArmed);
        roll_week(k, now, vault);
        let c = &mut ctx.accounts.config;
        if c.bankroll_day != today {
            c.bankroll_day = today;
            c.bankroll_day_start = vault; // OPTIMISTIC baseline (unsettled bets counted as lost)
        }
        let week_start = week_base(k.week_start_bankroll, vault, k.week_net_loss);
        bet_limits(vault, reserved, stake_in, stake, payout, c.bankroll_day_start, k.week_net_loss, week_start, k.bond, k.jackpot_reserved)?;
    }

    debit_balance(&mut ctx.accounts.player_state, stake)?;
    let ps_info = ctx.accounts.player_state.to_account_info();
    let reward_info = ctx.accounts.reward_vault.to_account_info();
    let arch_info = ctx.accounts.architect.to_account_info();
    if architect_or_pool(&arch_info, &reward_info, to_arch)?.key == reward_info.key {
        to_pool += to_arch;
        to_arch = 0;
    }
    move_lamports(&ps_info, &reward_info, to_pool)?;
    move_lamports(&ps_info, &arch_info, to_arch)?;
    move_lamports(&ps_info, &ctx.accounts.bankroll_vault.to_account_info(), stake_in)?;
    // backstop: the bankroll can pay this bet on top of everything already reserved
    require!(free_balance(&ctx.accounts.bankroll_vault, reserved)? >= payout, ForgeError::BankrollTooSmall);

    let bet_key = ctx.accounts.bet.key();
    let ps_key = ctx.accounts.player_state.key();
    let owner = ctx.accounts.player_state.owner;
    let nonce = ctx.accounts.player_state.nonce;
    let k = &mut ctx.accounts.keeper_seat;
    let target_slot = bet_pack(k.next_index, slot + 1);
    k.next_index += 1;
    k.pending_bets = k.pending_bets.checked_add(1).ok_or(ForgeError::MathOverflow)?;

    let b = &mut ctx.accounts.bet;
    b.player_state = ps_key;
    b.owner = owner;
    b.rent_payer = ctx.accounts.signer.key();
    b.game = game | BET_KEEPER;
    b.choice = choice;
    b.chance_bps = chance_bps;
    b.stake = stake;
    b.payout = payout;
    b.seed = seed;
    b.target_slot = target_slot;
    b.nonce = nonce;
    b.bump = ctx.bumps.bet;

    let ps = &mut ctx.accounts.player_state;
    ps.nonce += 1;
    ps.total_wagered = ps.total_wagered.saturating_add(stake); // statistics only: no chips (ECO-3)

    let c = &mut ctx.accounts.config;
    c.bankroll_reserved = c.bankroll_reserved.checked_add(payout).ok_or(ForgeError::MathOverflow)?;
    c.stats.wagered = c.stats.wagered.saturating_add(stake);
    c.stats.bets = c.stats.bets.saturating_add(1);
    c.stats.edge_to_pool = c.stats.edge_to_pool.saturating_add(to_pool);
    c.stats.to_architect = c.stats.to_architect.saturating_add(to_arch);

    emit!(BetPlaced {
        owner,
        bet: bet_key,
        game: game | BET_KEEPER,
        choice,
        chance_bps,
        stake,
        payout,
        target_slot,
        to_pool,
        to_architect: to_arch,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AnchorBet<'info> {
    #[account(mut, seeds = [SEED_BET, bet.player_state.as_ref(), bet.nonce.to_le_bytes().as_ref()], bump = bet.bump)]
    pub bet: Box<Account<'info, Bet>>,
    /// CHECK: SlotHashes sysvar
    #[account(address = SLOT_HASHES_ID @ ForgeError::InvalidTarget)]
    pub slot_hashes: UncheckedAccount<'info>,
}

/// PERMISSIONLESS (the player's page sends it ~2 s after placing; the keeper and anyone else may too): mixes the
/// anchor block's hash into the seed. The block exists only after the placement, its producer never sees the
/// keeper's preimage, and the keeper's chain was committed before the bet.
pub fn anchor_bet(ctx: Context<AnchorBet>) -> Result<()> {
    let b = &mut ctx.accounts.bet;
    require!(b.game & BET_KEEPER != 0, ForgeError::KeeperRequired);
    require!(b.game & BET_ANCHORED == 0, ForgeError::InvalidTarget); // already anchored
    let (_, anchor) = bet_unpack(b.target_slot);
    match slot_hash_at_or_after(&ctx.accounts.slot_hashes, anchor)? {
        SlotHashLookup::NotYet => err!(ForgeError::NotReady),
        SlotHashLookup::Expired => err!(ForgeError::BetStalled),
        SlotHashLookup::Ready(h) => {
            b.seed = keccak(&[b"MOONFORGE_ANCHOR", &b.seed, &h]);
            b.game |= BET_ANCHORED;
            Ok(())
        }
    }
}

/// SettleBet + keeper_seat.
#[derive(Accounts)]
pub struct SettleBetV2<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut, close = rent_payer,
        seeds = [SEED_BET, bet.player_state.as_ref(), bet.nonce.to_le_bytes().as_ref()], bump = bet.bump
    )]
    pub bet: Box<Account<'info, Bet>>,
    #[account(mut, address = bet.player_state @ ForgeError::WrongPlayer)]
    pub player_state: Box<Account<'info, PlayerState>>,
    /// CHECK: bankroll vault PDA
    #[account(mut, seeds = [SEED_BANKROLL_VAULT], bump = config.bumps[1])]
    pub bankroll_vault: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar
    #[account(address = SLOT_HASHES_ID @ ForgeError::InvalidTarget)]
    pub slot_hashes: UncheckedAccount<'info>,
    /// CHECK: receives the bet rent back
    #[account(mut, address = bet.rent_payer @ ForgeError::WrongRentPayer)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_HOUSE_KEEPER], bump = keeper_seat.bump, has_one = keeper @ ForgeError::OnlyKeeper)]
    pub keeper_seat: Box<Account<'info, HouseKeeper>>,
    /// CHECK: reward vault PDA (G-2: pays the settle tip from its free balance)
    #[account(mut, seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
    /// CHECK: the registered keeper wallet (`keeper_seat.keeper`, has_one above; G-2: receives the settle tip), never
    /// whoever sent the reveal: copying a broadcast reveal gains nothing. Not a signer: settling stays permissionless.
    #[account(mut)]
    pub keeper: UncheckedAccount<'info>,
}

/// G-2 (round 4, KEEPER-INCOME option 1): the settle tip of one settled bet: min(KEEPER_SETTLE_TIP, half of the bet's
/// pool share = EDGE_TO_POOL_BPS / 2 of the stake, the free pool). The burners keep at least half of every pool share.
pub fn settle_tip(stake: u64, free: u64) -> Result<u64> {
    Ok(KEEPER_SETTLE_TIP.min(bps(stake, EDGE_TO_POOL_BPS)? / 2).min(free))
}

/// The tip actually sent: 0 when the keeper wallet would stay below its rent minimum with it (an emptied wallet
/// cannot take a dust credit, and a refused credit would block the settle, i.e. turn the bet into a stall).
pub fn tip_payable(tip: u64, wallet_lamports: u64, wallet_rent_min: u64) -> u64 {
    if wallet_lamports.saturating_add(tip) >= wallet_rent_min {
        tip
    } else {
        0
    }
}

/// PERMISSIONLESS for whoever holds the next preimage. Chain order; a stalled or skipped bet is refund-only (K-2):
/// the keeper cannot settle late losers while late winners get refunded.
pub fn settle_bet_v2(ctx: Context<SettleBetV2>, reveal: [u8; 32]) -> Result<()> {
    let clock = Clock::get()?;
    let bet = &ctx.accounts.bet;
    require!(bet.game & BET_KEEPER != 0, ForgeError::KeeperRequired);
    require!(bet.game & BET_ANCHORED != 0, ForgeError::NotReady); // anchor_bet first
    let (index, anchor) = bet_unpack(bet.target_slot);
    {
        let k = &ctx.accounts.keeper_seat;
        require!(clock.slot <= anchor.saturating_add(KEEPER_STALL_SLOTS) && index >= k.revealed, ForgeError::BetStalled);
        require!(index == k.revealed, ForgeError::BadReveal);
        require!(chain_next_ok(&k.tip, &reveal), ForgeError::BadReveal);
    }
    let game = bet.game & BET_GAME_MASK;
    let roll = random_u64(&reveal, bet.key().as_ref(), &bet.seed) % BPS;
    let won = is_win(game, bet.choice, bet.chance_bps, roll);
    let (payout, stake, owner, bet_key) = (bet.payout, bet.stake, bet.owner, bet.key());
    let stake_in = stake - bet_edge(stake)?;

    let c = &mut ctx.accounts.config;
    c.bankroll_reserved = c.bankroll_reserved.saturating_sub(payout);
    if won {
        move_lamports(&ctx.accounts.bankroll_vault.to_account_info(), &ctx.accounts.player_state.to_account_info(), payout)?;
        let ps = &mut ctx.accounts.player_state;
        ps.balance = ps.balance.checked_add(payout).ok_or(ForgeError::MathOverflow)?;
        ps.total_won = ps.total_won.saturating_add(payout);
        c.stats.paid_to_players = c.stats.paid_to_players.saturating_add(payout);
    }
    let k = &mut ctx.accounts.keeper_seat;
    k.tip = reveal;
    k.revealed += 1;
    k.pending_bets = k.pending_bets.saturating_sub(1);
    k.last_active_ts = clock.unix_timestamp;
    k.week_net_loss = k.week_net_loss.saturating_add(bet_net_loss(won, stake_in, payout));
    // G-2: the settle tip, from the FREE pool (reserved epoch budgets are never touched), to the registered keeper wallet
    let keeper_info = ctx.accounts.keeper.to_account_info();
    let tip = tip_payable(
        settle_tip(stake, free_balance(&ctx.accounts.reward_vault, c.reward_reserved)?)?,
        keeper_info.lamports(),
        rent_min(&keeper_info)?,
    );
    move_lamports(&ctx.accounts.reward_vault.to_account_info(), &keeper_info, tip)?;
    c.stats.keeper_tips = c.stats.keeper_tips.saturating_add(tip);
    emit!(BetSettled {
        owner,
        bet: bet_key,
        game,
        roll,
        won,
        expired: false,
        stake,
        payout: if won { payout } else { 0 },
        keeper_tip: tip,
    });
    Ok(())
}

/// SettleBet + keeper_seat + reward_vault (SettleBet already carries slot_hashes).
#[derive(Accounts)]
pub struct RefundStalledBet<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(
        mut, close = rent_payer,
        seeds = [SEED_BET, bet.player_state.as_ref(), bet.nonce.to_le_bytes().as_ref()], bump = bet.bump
    )]
    pub bet: Box<Account<'info, Bet>>,
    #[account(mut, address = bet.player_state @ ForgeError::WrongPlayer)]
    pub player_state: Box<Account<'info, PlayerState>>,
    /// CHECK: bankroll vault PDA
    #[account(mut, seeds = [SEED_BANKROLL_VAULT], bump = config.bumps[1])]
    pub bankroll_vault: UncheckedAccount<'info>,
    /// CHECK: SlotHashes sysvar
    #[account(address = SLOT_HASHES_ID @ ForgeError::InvalidTarget)]
    pub slot_hashes: UncheckedAccount<'info>,
    /// CHECK: receives the bet rent back
    #[account(mut, address = bet.rent_payer @ ForgeError::WrongRentPayer)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_HOUSE_KEEPER], bump = keeper_seat.bump)]
    pub keeper_seat: Box<Account<'info, HouseKeeper>>,
    /// CHECK: reward vault PDA. Kept so the account list is unchanged; read-only since round 4: no stall pays the pool
    /// (the bankroll keeps the stake, stall_split).
    #[account(seeds = [SEED_REWARD_VAULT], bump = config.bumps[0])]
    pub reward_vault: UncheckedAccount<'info>,
}

/// The lamport moves of a stall (pure): (bankroll → player, bond → player). The player always ends with
/// `stake_in + to_player`; the bond pays `to_player + house_kept` and the bankroll returns only what the bond did not
/// cover, so with a full bond the bankroll pays nothing on reason 1 and keeps the stake (booked as a lost bet). On
/// reason 0 `house_kept` is 0: the bankroll returns stake_in (the bet is undone) and the bond's forfeit moves nothing.
pub fn stall_moves(stake_in: u64, to_player: u64, house_kept: u64) -> (u64, u64) {
    (stake_in - house_kept.min(stake_in), to_player + house_kept.min(stake_in))
}

/// PERMISSIONLESS. See `stall_reason` / `stall_split`. The position of a refunded bet whose index >= revealed
/// stays unrevealed until reveal_keeper skips it.
pub fn refund_stalled_bet(ctx: Context<RefundStalledBet>) -> Result<()> {
    let slot = Clock::get()?.slot;
    let bet = &ctx.accounts.bet;
    require!(bet.game & BET_KEEPER != 0, ForgeError::KeeperRequired);
    let (index, anchor) = bet_unpack(bet.target_slot);
    let anchored = bet.game & BET_ANCHORED != 0;
    let expired = !anchored && matches!(slot_hash_at_or_after(&ctx.accounts.slot_hashes, anchor)?, SlotHashLookup::Expired);
    let reason = stall_reason(anchored, index, anchor, ctx.accounts.keeper_seat.revealed, slot, expired)
        .ok_or(ForgeError::BetNotStalled)?;
    let (payout, stake, owner, bet_key) = (bet.payout, bet.stake, bet.owner, bet.key());
    let edge = bet_edge(stake)?;
    let stake_in = stake - edge;
    let (to_player, house_kept, forfeit) = stall_split(reason, stake_in, edge, payout, ctx.accounts.keeper_seat.bond);
    let (from_bankroll, from_bond) = stall_moves(stake_in, to_player, house_kept);

    let ps_info = ctx.accounts.player_state.to_account_info();
    let seat_info = ctx.accounts.keeper_seat.to_account_info();
    move_lamports(&ctx.accounts.bankroll_vault.to_account_info(), &ps_info, from_bankroll)?;
    pay_from_seat(&seat_info, &ps_info, from_bond)?;
    let ps = &mut ctx.accounts.player_state;
    ps.balance = ps.balance.checked_add(stake_in + to_player).ok_or(ForgeError::MathOverflow)?;

    let k = &mut ctx.accounts.keeper_seat;
    // the forfeit (reason 0) leaves the bond but no lamport moves: it stays in the seat above `bond`, owed to nobody
    k.bond -= from_bond + forfeit;
    k.penalties = k.penalties.saturating_add(house_kept + forfeit);
    k.pending_bets = k.pending_bets.saturating_sub(1);
    // the bankroll kept `house_kept` of the stake (reason 1): in the 7-day loss window that is a lost bet's realized
    // gain; reason 0 undoes the bet for the bankroll (stake_in back), so it books nothing
    k.week_net_loss = k.week_net_loss.saturating_add(bet_net_loss(false, house_kept, 0));
    let c = &mut ctx.accounts.config;
    c.bankroll_reserved = c.bankroll_reserved.saturating_sub(payout);
    emit!(BetRefunded { bet: bet_key, player: owner, stake, penalty: house_kept + forfeit, reason });
    Ok(())
}

#[cfg(test)]
mod keeper_tests {
    use super::*;
    use anchor_lang::error::ERROR_CODE_OFFSET;

    const X: u64 = XNT;

    fn code<T>(r: Result<T>) -> Option<u32> {
        match r {
            Err(Error::AnchorError(e)) => Some(e.error_code_number - ERROR_CODE_OFFSET),
            _ => None,
        }
    }
    /// x_N = seed, x_k = keccak(x_{k+1}); returns [x_0 (= tip), x_1, …, x_N].
    fn chain(seed: [u8; 32], n: usize) -> Vec<[u8; 32]> {
        let mut v = vec![seed];
        for _ in 0..n {
            let next = keccak(&[v.last().unwrap()]);
            v.push(next);
        }
        v.reverse();
        v
    }
    fn seat() -> HouseKeeper {
        HouseKeeper {
            keeper: Pubkey::new_unique(),
            pending_keeper: Pubkey::default(),
            pending_ts: 0,
            tip: [0; 32],
            length: 0,
            next_index: 0,
            revealed: 0,
            bond: 0,
            pending_bets: 0,
            last_active_ts: 0,
            armed_slot: 0,
            week_start_ts: 0,
            week_start_bankroll: 0,
            week_net_loss: 0,
            penalties: 0,
            jackpot_reserved: 0,
            withdraw_ts: 0,
            bump: 255,
        }
    }

    #[test]
    fn chain_reveal_order() {
        let c = chain([0x0a; 32], 1_000);
        let mut tip = c[0];
        for k in 1..=1_000 {
            assert!(chain_next_ok(&tip, &c[k]), "reveal {k}");
            if k + 1 <= 1_000 {
                assert!(!chain_next_ok(&tip, &c[k + 1]), "a skipped reveal must fail ({k})");
            }
            assert!(!chain_next_ok(&tip, &tip)); // the head itself is not its own preimage
            tip = c[k];
        }
        // re-arming with the current head is refused (K-5); a zero head or an empty / too long chain too
        assert_eq!(code(check_new_chain(&tip, &tip, 10)), Some(ForgeError::BadReveal as u32));
        assert_eq!(code(check_new_chain(&tip, &[0; 32], 10)), Some(ForgeError::BadReveal as u32));
        assert_eq!(code(check_new_chain(&tip, &c[0], 0)), Some(ForgeError::InvalidTarget as u32));
        assert_eq!(code(check_new_chain(&tip, &c[0], KEEPER_MAX_CHAIN + 1)), Some(ForgeError::InvalidTarget as u32));
        assert!(check_new_chain(&tip, &c[0], KEEPER_MAX_CHAIN).is_ok());
    }

    /// SPEC §12 K-5 (narrowed): arm_keeper (re-arm) and take_keeper (both through check_new_chain) refuse the CURRENT
    /// head of the chain, before and after reveals move it; any other non-zero head is accepted, an older revealed
    /// value included (the disclosed collusion bound: no on-chain history, the health job watches the tip / reveal
    /// history; 2.9 item 1, 9.5, 11.4).
    #[test]
    fn k5_rearm_refuses_the_current_tip() {
        let c = chain([0x0b; 32], 16);
        let mut k = seat();
        install_chain(&mut k, c[0], 16, 100, 1_000);
        assert_eq!(code(check_new_chain(&k.tip, &c[0], 16)), Some(ForgeError::BadReveal as u32));
        // reveals move the head (reveal_keeper / settle_bet_v2 write k.tip = reveal): the new head is refused
        for (i, x) in c.iter().enumerate().take(6).skip(1) {
            assert!(chain_next_ok(&k.tip, x), "reveal {i}");
            k.tip = *x;
            k.revealed += 1;
        }
        let head = k.tip;
        assert_eq!(head, c[5]);
        for len in [1, 16, KEEPER_MAX_CHAIN] {
            assert_eq!(code(check_new_chain(&k.tip, &head, len)), Some(ForgeError::BadReveal as u32));
        }
        // an older revealed value, a later preimage or a fresh chain: accepted (only the current head is detectable)
        for other in [c[0], c[4], c[6]] {
            assert!(check_new_chain(&k.tip, &other, 16).is_ok());
        }
        let fresh = chain([0x0c; 32], 16);
        check_new_chain(&k.tip, &fresh[0], 16).unwrap();
        install_chain(&mut k, fresh[0], 16, 200, 2_000);
        assert_eq!((k.tip, k.length, k.next_index, k.revealed, k.armed_slot), (fresh[0], 16, 0, 0, 200));
        assert_eq!(code(check_new_chain(&k.tip, &fresh[0], 16)), Some(ForgeError::BadReveal as u32));
    }

    #[test]
    fn keeper_chain_vector() {
        // Appendix A: seed 0x0a×32, length 8. Printed for spec-vectors-v2.out.json (run with --nocapture).
        let c = chain([0x0a; 32], 8);
        for (k, x) in c.iter().enumerate() {
            println!("x_{k} = {}", x.iter().map(|b| format!("{b:02x}")).collect::<String>());
        }
        assert_eq!(c[8], [0x0a; 32]);
        for k in 0..8 {
            assert_eq!(keccak(&[&c[k + 1]]), c[k]);
        }
        // mixed seed of seed 0x08×32 with block hash 0x07×32, and a v2 roll with it
        let mixed = keccak(&[b"MOONFORGE_ANCHOR", &[0x08; 32], &[0x07; 32]]);
        println!("mixed = {}", mixed.iter().map(|b| format!("{b:02x}")).collect::<String>());
        println!("roll = {}", random_u64(&c[1], &[0x07; 32], &mixed) % BPS);
    }

    /// (stake, stake_in, edge, payout) of a bet at payout_bps.
    fn bet(stake: u64, payout_bps: u64) -> (u64, u64, u64, u64) {
        let edge = bet_edge(stake).unwrap();
        (stake, stake - edge, edge, mul_div(stake, payout_bps, BPS).unwrap())
    }

    #[test]
    fn stall_refund_arithmetic() {
        let flip = game_odds(GAME_COINFLIP, 0, 0).unwrap().1;
        let (stake, stake_in, edge, payout) = bet(X, flip);
        // reason 0 (r4-fix, review r4 finding 1): the player is made whole (the bankroll returns stake_in, the bond
        // pays the edge) and the bond forfeits stake_in to nobody: the bond loses the whole stake, the bankroll nothing
        let (p, kept, lost) = stall_split(0, stake_in, edge, payout, 20 * X);
        assert_eq!((stake_in + p, kept, lost), (stake, 0, stake_in));
        assert_eq!(stall_moves(stake_in, p, kept), (stake_in, edge), "the bankroll returns stake_in, the bond pays the edge");
        assert_eq!(p + kept + lost, stake, "the bond loses the whole stake");
        // a short bond pays the player first, then the forfeit; the bankroll always returns stake_in on reason 0
        assert_eq!(stall_split(0, stake_in, edge, payout, edge + 1), (edge, 0, 1));
        assert_eq!(stall_split(0, stake_in, edge, payout, edge / 2), (edge / 2, 0, 0));
        assert_eq!(stall_moves(stake_in, edge / 2, 0), (stake_in, edge / 2));
        // reason 1: the player holds exactly payout, all of it from the bond; the bankroll keeps stake_in; no forfeit
        let (p, kept, lost) = stall_split(1, stake_in, edge, payout, 20 * X);
        assert_eq!((stake_in + p, kept, p + kept, lost), (payout, stake_in, payout, 0));
        assert_eq!(stall_moves(stake_in, p, kept), (0, payout));
        // a short bond on reason 1: the player first, then the kept stake; the bankroll returns what is left uncovered
        assert_eq!(stall_split(1, stake_in, edge, payout, payout - stake_in + 1), (payout - stake_in, 1, 0));
        assert_eq!(stall_moves(stake_in, payout - stake_in, 1), (stake_in - 1, payout - stake_in + 1));
        // the bond bet_limits demands (>= every pending payout) always covers it, whatever the mix of reasons
        for (bond, pending) in [(payout, 1u64), (5 * payout, 5)] {
            let mut b = bond;
            for i in 0..pending {
                let (p, q, f) = stall_split((i % 2) as u8, stake_in, edge, payout, b);
                assert_eq!(p + q + f, if i % 2 == 0 { stake } else { payout });
                let (from_bankroll, _) = stall_moves(stake_in, p, q);
                assert_eq!(from_bankroll, if i % 2 == 0 { stake_in } else { 0 }, "never short: the bankroll returns only an undone stake");
                b -= p + q + f;
            }
            assert!(b <= bond - pending * stake);
        }
    }

    /// Round 4, review F1 (s6-minus-7 MANIFEST §4 item 8): the expected value of a keeper that bets on its own house,
    /// for every game (each odds class) and stake class, under EVERY strategy, computed exactly from the program's own
    /// rules (game_odds, is_win over all 10,000 rolls, bet_edge, stall_split, stall_moves, the G-2 settle tip at its
    /// largest). Once the anchor block exists the keeper knows the outcome (it holds the preimage); for each outcome
    /// (win, loss) it picks one action: settle, anchor and never reveal (reason 1), never anchor (reason 0, only if
    /// nobody else anchors), or skip the position with reveal_keeper (reason 1): 4 × 4 = 16 policies, plus the 3 × 3 = 9
    /// left when someone else anchored.
    ///   - A pure bettor-keeper: EV ≤ −edge (bet_edge: the 1.5% the pool and the architect take) under every policy;
    ///     before round 4, "settle winners, leave losers unanchored" was about +0.465 × stake on a Coin Flip.
    ///   - With any share f of the bankroll and g of the reward pool's releases: every deviation pays at most what
    ///     honest settling pays, outcome by outcome (a stall is a lost bet for the bankroll; nothing goes to the pool).
    ///   - Honest players keep their protection: an unanchored bet comes back whole, an anchored stall pays the payout.
    /// Rolls are taken uniform, as utils.rs documents; the modulo bias of random_u64 % 10,000 (1,616 rolls carry one
    /// extra 2^-64) moves any of these EVs by less than 0.001 lamport, which the last assertion bounds.
    #[test]
    fn self_betting_keeper_never_beats_minus_the_edge() {
        let total_w: i128 = BPS as i128; // uniform rolls: one weight per roll, out of BPS

        #[derive(Clone, Copy, Debug, PartialEq)]
        enum Act { Settle, StallAnchored, NeverAnchor, Skip }
        const ALL: [Act; 4] = [Act::Settle, Act::StallAnchored, Act::NeverAnchor, Act::Skip];
        const ANCHORED_BY_OTHERS: [Act; 3] = [Act::Settle, Act::StallAnchored, Act::Skip];

        let mut odds = vec![(GAME_COINFLIP, 0u64, 0u8), (GAME_COINFLIP, 0, 1)];
        for chance in [MIN_CHANCE_BPS, 2_500, 5_000, 9_000, MAX_CHANCE_BPS] {
            odds.push((GAME_HIGHLOW, chance, 0));
            odds.push((GAME_HIGHLOW, chance, 1));
        }
        for target in [MIN_TARGET_BPS, 20_000, 100_000, MAX_TARGET_BPS] {
            odds.push((GAME_VOIDRUSH, target, 0));
        }
        let mut worst_bps = i128::MIN; // the best EV any policy reaches, in bps of the stake
        let mut coin_flip_before = 0i128;
        let mut max_value = 0i128; // the largest |outcome| of any bet above, in lamports (bias bound)
        for &(game, param, choice) in &odds {
            let (chance, pbps) = game_odds(game, param, choice).unwrap();
            let win_w = (0..BPS).filter(|r| is_win(game, choice, chance, *r)).count() as i128;
            let loss_w = total_w - win_w;
            for stake in [MIN_STAKE, MIN_STAKE + 7, X / 10, X, 7 * X + 3] {
                let (stake, stake_in, edge, payout) = bet(stake, pbps);
                let tip = settle_tip(stake, u64::MAX).unwrap(); // the largest G-2 tip (a pool that never binds)
                assert!(2 * tip <= bps(stake, EDGE_TO_POOL_BPS).unwrap(), "at most half of the bet's pool share");
                max_value = max_value.max(payout as i128 + stake as i128);
                // (player, bond + keeper wallet, bankroll, pool) deltas of one outcome, the placement included
                let place = (-(stake as i128), 0i128, stake_in as i128, (stake - stake_in) as i128);
                let flows = |act: Act, won: bool| -> (i128, i128, i128, i128) {
                    let (mut pl, mut kp, mut bk, mut po) = place;
                    match act {
                        Act::Settle => {
                            if won {
                                pl += payout as i128;
                                bk -= payout as i128;
                            }
                            kp += tip as i128; // settle_bet_v2 pays the registered keeper wallet from the pool
                            po -= tip as i128;
                        }
                        _ => {
                            let reason = if act == Act::NeverAnchor { 0 } else { 1 };
                            let (to_player, kept, forfeit) = stall_split(reason, stake_in, edge, payout, u64::MAX);
                            let (from_bankroll, from_bond) = stall_moves(stake_in, to_player, kept);
                            assert_eq!(from_bankroll + from_bond, stake_in + to_player, "the player gets both moves");
                            pl += (from_bankroll + from_bond) as i128;
                            kp -= (from_bond + forfeit) as i128; // the forfeit leaves the bond, to nobody
                            bk -= from_bankroll as i128;
                            // honest players' protection: whole, or the payout
                            assert_eq!(stake_in + to_player, if reason == 0 { stake } else { payout });
                            // a stall never costs the bankroll: it keeps the stake (reason 1) or the bet is undone (0)
                            assert_eq!(from_bankroll, if reason == 0 { stake_in } else { 0 });
                            assert_eq!(from_bond + forfeit, if reason == 0 { stake } else { payout }, "the bond's loss");
                        }
                    }
                    (pl, kp, bk, po)
                };
                // value to an entity holding the bet, the keeper seat and wallet, a share f of the bankroll, g of the pool
                let value = |act: Act, won: bool, f: i128, g: i128| -> i128 {
                    let (pl, kp, bk, po) = flows(act, won);
                    (pl + kp) * BPS as i128 + (bk * f + po * g)
                }; // scaled by BPS (f, g in bps)
                let ev = |w: Act, l: Act, f: i128, g: i128| (win_w * value(w, true, f, g) + loss_w * value(l, false, f, g));
                let minus_edge = -(edge as i128) * BPS as i128 * total_w;
                for (set, others) in [(&ALL[..], false), (&ANCHORED_BY_OTHERS[..], true)] {
                    for &w in set {
                        for &l in set {
                            let e = ev(w, l, 0, 0);
                            assert!(e <= minus_edge, "{game}/{param}/{choice} stake {stake} ({w:?}, {l:?}, others {others}): EV above −edge");
                            // before its own settle tip, the keeper never beats −2% (HOUSE_EDGE_BPS): the tip (≤ half
                            // the 1% pool share) is the only thing that comes back, hence the −edge (1.5%) bound above
                            let settled_w = (if w == Act::Settle { win_w } else { 0 }) + (if l == Act::Settle { loss_w } else { 0 });
                            let e_no_tip = e - settled_w * tip as i128 * BPS as i128;
                            assert!(e_no_tip <= -(stake as i128) * HOUSE_EDGE_BPS as i128 * total_w, "{game}/{param} stake {stake} ({w:?}, {l:?}): above −2% before the tip");
                            worst_bps = worst_bps.max(e / (total_w * stake as i128));
                            for f in [0i128, 2_500, 5_000, 10_000] {
                                for g in [0i128, 2_500, 5_000, 10_000] {
                                    // outcome by outcome, a deviation never beats settling
                                    assert!(value(w, true, f, g) <= value(Act::Settle, true, f, g), "win {w:?} f {f} g {g}");
                                    assert!(value(l, false, f, g) <= value(Act::Settle, false, f, g), "loss {l:?} f {f} g {g}");
                                }
                            }
                        }
                    }
                }
                if game == GAME_COINFLIP && stake == X {
                    // the exploit the fix removes, priced with the pre-round-4 reason-0 split (bond: edge to the player,
                    // edge to the pool; the bankroll returns stake_in): settle winners, leave losers unanchored
                    let old_loss = (-(stake as i128) + stake_in as i128 + edge as i128) - 2 * edge as i128;
                    let old = win_w * (payout as i128 - stake as i128 + tip as i128) + loss_w * old_loss;
                    coin_flip_before = old * 1_000 / (total_w * stake as i128); // per mille of the stake
                }
            }
        }
        // every policy, every game and stake: at best about −1.5% of the stake (the honest 0.01-XNT bet with its tip)
        assert!(worst_bps <= -149, "best EV over all policies: {worst_bps} bps of the stake");
        assert!((464..=466).contains(&coin_flip_before), "the old selective-anchoring EV was ≈ +0.465 × stake ({coin_flip_before} ‰)");
        // the modulo bias: (2^64 mod 10,000) rolls weigh 2^-64 more, so an EV moves by < 1,616 × max_value / 2^64 lamports
        let rem = (1u128 << 64) % BPS as u128;
        assert!(rem * (max_value as u128) * 1_000 < 1u128 << 64, "bias effect below 0.001 lamport");
    }

    /// The Jackpot side of review F1 (no program change): a keeper holding a share of a decided round's tickets that
    /// settles only when it wins and lets the round expire when it loses (every entry refunded, its bond pays the pot to
    /// the pool: K-3 keeps the bond >= every DRAWING pot) never beats −(the rake on its own entries), for every share.
    /// Disclosed residual (DEVIATIONS r4-program): a keeper that ALSO expects most of the pool's future releases gets
    /// part of that penalty back.
    #[test]
    fn self_betting_keeper_jackpot_never_beats_minus_the_rake() {
        for pot in [2 * MIN_STAKE, X, 7 * X + 3, JACKPOT_MAX_POT] {
            let rake = {
                let (to_pool, to_arch) = rake_parts(pot).unwrap();
                to_pool + to_arch
            };
            let prize = (pot - rake) as i128;
            for share_bps in [1u64, 100, 2_500, 5_000, 9_000, 9_999] {
                let mine = (pot as u128 * share_bps as u128 / BPS as u128) as i128; // the keeper's tickets
                let (win, lose) = (mine, pot as i128 - mine); // ticket-weighted outcomes
                let settle_win = prize - mine;
                let settle_loss = -mine;
                let expire = -(pot.min(KEEPER_BOND_MIN) as i128); // entries back (mine too), the bond pays the pot
                for (w, l) in [(settle_win, settle_loss), (settle_win, expire), (expire, settle_loss), (expire, expire)] {
                    let ev = win * w + lose * l; // × pot
                    let bound = -(mine * rake as i128); // −(rake on the keeper's own entries) × pot
                    assert!(ev <= bound, "pot {pot} share {share_bps}: EV {ev} above {bound}");
                }
            }
        }
    }

    /// G-2 option 1 (KEEPER-INCOME.md item 5): the settle tip of a 0.01-XNT stake is 0.00005 XNT, of a 1-XNT stake
    /// 0.0005 XNT, 0 from an empty free pool; over 100k stakes it never exceeds half of the bet's pool share, the
    /// constant or the free pool. tip_payable: an emptied keeper wallet below its rent minimum gets 0, never a refused
    /// credit that would block the settle.
    #[test]
    fn settle_tip_cases() {
        assert_eq!(KEEPER_SETTLE_TIP, 500_000);
        assert_eq!(settle_tip(X / 100, u64::MAX).unwrap(), 50_000);
        assert_eq!(settle_tip(X, u64::MAX).unwrap(), 500_000);
        assert_eq!(settle_tip(7 * X, u64::MAX).unwrap(), 500_000);
        assert_eq!(settle_tip(X, 0).unwrap(), 0);
        assert_eq!(settle_tip(X, 123).unwrap(), 123);
        assert_eq!(settle_tip(MIN_STAKE, u64::MAX).unwrap(), 50_000);
        let mut seed = 0x6_2026_1025u64;
        for _ in 0..100_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let stake = MIN_STAKE + seed % (1_000 * X);
            let free = (seed >> 7) % (2 * KEEPER_SETTLE_TIP);
            let t = settle_tip(stake, free).unwrap();
            assert!(2 * t <= bps(stake, EDGE_TO_POOL_BPS).unwrap() && t <= KEEPER_SETTLE_TIP && t <= free);
        }
        let rent0 = 890_880u64;
        assert_eq!(tip_payable(500_000, 0, rent0), 0, "an emptied wallet takes no dust credit");
        assert_eq!(tip_payable(500_000, rent0 - 500_000, rent0), 500_000);
        assert_eq!(tip_payable(500_000, rent0 - 500_001, rent0), 0);
        assert_eq!(tip_payable(500_000, 2 * rent0, rent0), 500_000);
        assert_eq!(tip_payable(0, 0, rent0), 0);
    }

    #[test]
    fn stall_reasons() {
        let (anchor, s) = (1_000u64, KEEPER_STALL_SLOTS);
        // anchored, not yet stalled / stalled
        assert_eq!(stall_reason(true, 3, anchor, 3, anchor + s, false), None);
        assert_eq!(stall_reason(true, 3, anchor, 3, anchor + s + 1, false), Some(1));
        // skipped by the keeper: at once, anchored or not
        assert_eq!(stall_reason(true, 2, anchor, 3, anchor + 1, false), Some(1));
        assert_eq!(stall_reason(false, 2, anchor, 3, anchor + 1, false), Some(1));
        // never anchored: refundable only once its block left SlotHashes
        assert_eq!(stall_reason(false, 3, anchor, 3, anchor + 600, false), None);
        assert_eq!(stall_reason(false, 3, anchor, 3, anchor + 600, true), Some(0));
        // an unanchored bet is never a win for being late (no payout-sized refund for declining to anchor)
        assert_eq!(stall_reason(false, 3, anchor, 3, anchor + s + 10, true), Some(0));
    }

    /// For any LP share s ≤ 1, stalling an anchored winner of ANOTHER player costs the keeper at least what revealing it
    /// costs: revealing, the bankroll pays payout − stake_in (the keeper's share s of it); stalling, the bond pays the
    /// payout and the bankroll keeps stake_in (the keeper gets s of it back): the difference is payout × (1 − s) ≥ 0.
    #[test]
    fn stall_never_profitable_for_lp() {
        for target in [1_000_000u64, 100_000, 30_000] {
            // Void Rush 100x, 10x, 3x
            let pbps = game_odds(GAME_VOIDRUSH, target, 0).unwrap().1;
            for stake in [MIN_STAKE, X / 10, X, 7 * X] {
                let (_, stake_in, edge, payout) = bet(stake, pbps);
                for s_bps in [0u64, 2_500, 5_000, 9_000, 10_000] {
                    let s = s_bps as i128;
                    // revealing the win: the bankroll pays payout after receiving stake_in; the keeper owns s of it
                    let reveal_cost = (payout - stake_in) as i128 * s;
                    // stalling: the bond pays the player the payout, the bankroll keeps stake_in (s of it is the keeper's)
                    let (p, kept, forfeit) = stall_split(1, stake_in, edge, payout, u64::MAX);
                    let (from_bankroll, from_bond) = stall_moves(stake_in, p, kept);
                    assert_eq!((from_bankroll, from_bond, forfeit), (0, payout, 0));
                    let stall_cost = from_bond as i128 * BPS as i128 - kept as i128 * s;
                    assert!(stall_cost >= reveal_cost, "target {target} stake {stake} share {s_bps}");
                    assert_eq!(stall_cost - reveal_cost, payout as i128 * (BPS as i128 - s));
                }
            }
        }
    }

    /// SR-2 (security review r2), as changed by round 4 (review F1) and r4-fix (review r4 finding 1). A never-anchored
    /// bet whose anchor block left SlotHashes (reason 0) is never a profit for its player: it gets back exactly its
    /// stake (the bankroll returns stake_in, the bond pays the edge). The bond also forfeits stake_in to nobody, so the
    /// bond's loss per such bet is its STAKE (it was 2 · edge before round 4), still less than the payout bet_limits
    /// reserved for it and less than a reason-1 stall of it. So from the smallest bond bet_limits accepts, any run of
    /// reason-0 refunds keeps the bond covering every other pending payout and DRAWING pot (K-3): an honest bet that
    /// later stalls (reason 1) is still paid its full payout, and the drain of one full set of pending bets is at most
    /// their stakes. The price of closing F1: a keeper that leaves bets unanchored for > 512 slots loses their stakes
    /// (the forfeit stays in the seat; disclosed: the keeper must anchor every bet, and a griefer can burn the bond
    /// while no keeper runs, at no gain to anyone).
    #[test]
    fn reason0_refund_drain_is_bounded() {
        let mut odds = vec![game_odds(GAME_COINFLIP, 0, 0).unwrap().1];
        for chance in [MIN_CHANCE_BPS, 5_000, MAX_CHANCE_BPS] {
            odds.push(game_odds(GAME_HIGHLOW, chance, 0).unwrap().1);
        }
        for target in [MIN_TARGET_BPS, 30_000, MAX_TARGET_BPS] {
            odds.push(game_odds(GAME_VOIDRUSH, target, 0).unwrap().1);
        }
        for &pbps in &odds {
            for stake in [MIN_STAKE, MIN_STAKE + 1, X / 10 + 7, X, 7 * X + 3] {
                let (stake, stake_in, edge, payout) = bet(stake, pbps);
                let (p, q, f) = stall_split(0, stake_in, edge, payout, u64::MAX);
                assert_eq!((stake_in + p, q, f), (stake, 0, stake_in), "made whole, never more (pbps {pbps} stake {stake})");
                assert_eq!(p + q + f, stake, "the bond loses the whole stake; the bankroll returns stake_in");
                assert_eq!(stall_moves(stake_in, p, q), (stake_in, edge));
                assert!(p + q + f < payout, "cheaper than the obligation it removes (pbps {pbps} stake {stake})");
                let (p1, q1, f1) = stall_split(1, stake_in, edge, payout, u64::MAX);
                assert!(p + q + f < p1 + q1 + f1);
            }
        }
        // Fill the keeper's capacity through bet_limits itself (the bond is what binds), then refund every second bet
        // with reason 0 (the griefer's) and the others with reason 1 (honest bets the keeper then failed to reveal).
        let (vault, mut filled) = (10_000 * X, 0usize);
        for &pbps in &odds {
            for (stake, jackpot_reserved) in [(MIN_STAKE, 0u64), (X / 10, 5 * X), (3 * MIN_STAKE, JACKPOT_MAX_POT - X)] {
                let (_, stake_in, edge, payout) = bet(stake, pbps);
                let (mut bond, mut v, mut reserved, mut n) = (KEEPER_BOND_MIN, vault, 0u64, 0u64);
                let last = loop {
                    match bet_limits(v, reserved, stake_in, stake, payout, vault, 0, vault, bond, jackpot_reserved) {
                        Ok(()) => (v, reserved, n) = (v + stake_in, reserved + payout, n + 1),
                        Err(e) => break e,
                    }
                };
                if n == 0 {
                    continue;
                }
                filled += 1;
                assert_eq!(code::<()>(Err(last)), Some(ForgeError::KeeperBondTooSmall as u32), "pbps {pbps} stake {stake}");
                let (mut drained, mut griefed) = (0u64, 0u64);
                for i in 0..n {
                    let reason = if i % 2 == 0 { 0 } else { 1 };
                    let (p, q, f) = stall_split(reason, stake_in, edge, payout, bond);
                    assert_eq!(p + q + f, if reason == 0 { stake } else { payout }, "never short (pbps {pbps} i {i})");
                    bond -= p + q + f;
                    reserved -= payout;
                    if reason == 0 {
                        drained += p + q + f;
                        griefed += 1;
                    }
                    assert!(bond >= reserved + jackpot_reserved, "K-3 cover kept (pbps {pbps} stake {stake} i {i})");
                }
                assert_eq!(reserved, 0);
                assert_eq!(drained, griefed * stake, "a reason-0 run drains exactly the stakes, to nobody");
            }
        }
        assert!(filled >= odds.len(), "every game filled the bond at least once ({filled})");
    }

    /// r4-fix (review r4 finding 1): a third party that holds a share f of the bankroll and NEVER holds the keeper seat
    /// places Coin Flips it never anchors while no keeper runs, refunds each once its block left SlotHashes (reason 0)
    /// and starts again, gap after gap, until the bond cannot cover a bet. Priced with the round-4 split (the bond paid
    /// the whole stake back, the bankroll kept stake_in), the review's numbers (38 XNT seed bankroll + a 300-XNT
    /// deposit, f ≈ 0.89, the minimum 20-XNT bond) earned it about 17 XNT out of the bond. With this split it gains
    /// exactly nothing for every f (its stake comes back whole, the bankroll ends where it started), while the bond
    /// still loses every stake, which keeps the self-bet deterrent (self_betting_keeper_never_beats_minus_the_edge).
    /// Disclosed residual: the bond still burns at no gain to the griefer (a keeper-liveness gate is an owner item),
    /// and the placement edge (1% pool, 0.5% payee) of each such bet is reimbursed to the player by the bond.
    #[test]
    fn lp_attacker_gains_nothing_from_unanchored_bets() {
        let flip = game_odds(GAME_COINFLIP, 0, 0).unwrap().1;
        let (seed_bankroll, deposit) = (38 * X, 300 * X);
        let f_review = deposit as i128 * BPS as i128 / (seed_bankroll + deposit) as i128; // ≈ 0.8876, in bps
        assert!((8_870..=8_880).contains(&f_review));
        let (stake, stake_in, edge, payout) = bet(8 * X / 10, flip); // under the 0.25% net-win cap of a 338-XNT bankroll
        assert!(bet_limits(seed_bankroll + deposit, 0, stake_in, stake, payout, seed_bankroll + deposit, 0, seed_bankroll + deposit, KEEPER_BOND_MIN, 0).is_ok());
        // the round-4 reason-0 split: (bond → player on top of stake_in, stake_in the bankroll keeps paid by the bond)
        let round4 = |bond: u64| {
            let to_player = edge.min(bond);
            (to_player, stake_in.min(bond - to_player), 0u64)
        };
        // (the attacker's gain at bankroll share f, ×BPS; the bond's loss; bets refunded)
        let run = |old: bool, f: i128| -> (i128, u64, u64) {
            let (mut vault, mut bond, mut gain, mut bets) = (seed_bankroll + deposit, KEEPER_BOND_MIN, 0i128, 0u64);
            loop {
                let (mut v, mut reserved, mut placed) = (vault, 0u64, 0u64);
                while bet_limits(v, reserved, stake_in, stake, payout, vault, 0, vault, bond, 0).is_ok() {
                    (v, reserved, placed) = (v + stake_in, reserved + payout, placed + 1);
                }
                if placed == 0 {
                    break;
                }
                for _ in 0..placed {
                    let (to_player, kept, forfeit) = if old { round4(bond) } else { stall_split(0, stake_in, edge, payout, bond) };
                    let (from_bankroll, from_bond) = stall_moves(stake_in, to_player, kept);
                    gain += ((from_bankroll + from_bond) as i128 - stake as i128) * BPS as i128; // as the player
                    gain += (stake_in as i128 - from_bankroll as i128) * f; // as an LP: its share of what the bankroll kept
                    bond -= from_bond + forfeit;
                    v -= from_bankroll;
                    bets += 1;
                }
                vault = v;
            }
            (gain, KEEPER_BOND_MIN - bond, bets)
        };
        let (old_gain, old_lost, old_bets) = run(true, f_review);
        assert!(old_gain > 15 * X as i128 * BPS as i128, "the review's drain: about +17 XNT ({} lamports)", old_gain / BPS as i128);
        assert!(old_lost + payout > KEEPER_BOND_MIN && old_bets > 20, "the old run emptied the bond ({old_lost}, {old_bets} bets)");
        for f in [0i128, 1, 2_500, 5_000, f_review, 9_999, 10_000] {
            let (gain, lost, bets) = run(false, f);
            assert_eq!(gain, 0, "f {f}: an LP gains nothing from a bet it never anchored");
            assert_eq!(lost, bets * stake, "f {f}: the bond still loses every stake (the self-bet deterrent)");
            assert!(lost + payout > KEEPER_BOND_MIN, "f {f}: the griefing residual (disclosed): the bond burns, to nobody");
        }
    }

    #[test]
    fn jackpot_position_fixed_at_draw() {
        let c = chain([0x0b; 32], 32);
        let mut k = seat();
        install_chain(&mut k, c[0], 32, 100, 0);
        k.bond = 100 * X;
        for _ in 0..3 {
            k.next_index += 1; // three bets before the draw take positions 0..2
            k.pending_bets += 1;
        }
        let target = jackpot_draw(&mut k, 10 * X, 20 * X, 500).unwrap();
        assert_eq!(bet_unpack(target), (3, 501));
        assert_eq!((k.next_index, k.pending_bets, k.jackpot_reserved), (4, 4, 20 * X));
        let (h, round, id, total) = ([0x07u8; 32], Pubkey::new_from_array([0x09; 32]), 42u64, 20 * X);
        let winner = jackpot_ticket_v2(&h, &c[4], &round, id, total); // position 3 is revealed by x_4
        // keeper self-bets after the draw only take later positions: the round's reveal never changes
        for _ in 0..10 {
            k.next_index += 1;
        }
        assert_eq!(k.next_index, 14);
        let (index, _) = bet_unpack(target);
        assert_eq!(jackpot_ticket_v2(&h, &c[index as usize + 1], &round, id, total), winner);
        assert!(winner < total);
        // a different position would have given another ticket (the position is what is fixed, not the outcome)
        assert_ne!(jackpot_ticket_v2(&h, &c[6], &round, id, total), winner);
    }

    #[test]
    fn jackpot_draw_needs_capacity() {
        let mut k = seat();
        install_chain(&mut k, [1; 32], 2, 0, 0);
        k.bond = 40 * X;
        // the bond covers pending payouts + DRAWING pots + this pot
        assert!(jackpot_draw(&mut k, 20 * X, 20 * X + 1, 1).is_none());
        assert!(jackpot_draw(&mut k, 20 * X, 20 * X, 1).is_some());
        assert!(jackpot_draw(&mut k, 20 * X, 1, 1).is_none()); // 40 XNT already covers 20 pending + 20 drawing
        k.bond = 100 * X;
        assert!(jackpot_draw(&mut k, 0, 1, 1).is_some());
        assert!(jackpot_draw(&mut k, 0, 1, 1).is_none()); // chain exhausted (length 2)
        assert_eq!((k.pending_bets, k.jackpot_reserved), (2, 20 * X + 1));
    }

    /// Finding M1: a flood of cheap bets right before the draw cannot push the round's position more than
    /// JACKPOT_MAX_BACKLOG reveals behind; such a draw refunds at once (reason 3) and leaves the seat untouched.
    #[test]
    fn jackpot_draw_caps_the_backlog() {
        let mut k = seat();
        install_chain(&mut k, [1; 32], 10_000, 0, 0);
        k.bond = 1_000 * X;
        k.next_index = JACKPOT_MAX_BACKLOG + 1; // 33 positions handed out, none revealed
        k.pending_bets = JACKPOT_MAX_BACKLOG as u32 + 1;
        let before = (k.next_index, k.revealed, k.pending_bets, k.jackpot_reserved, k.bond);
        assert!(jackpot_draw(&mut k, 0, 20 * X, 7).is_none());
        assert_eq!((k.next_index, k.revealed, k.pending_bets, k.jackpot_reserved, k.bond), before, "a refused draw changes nothing");
        k.revealed = 1; // the keeper catches up by one: exactly the cap is still drawable
        let target = jackpot_draw(&mut k, 0, 20 * X, 7).unwrap();
        assert_eq!(bet_unpack(target), (JACKPOT_MAX_BACKLOG + 1, 8));
        assert_eq!((k.next_index, k.jackpot_reserved), (JACKPOT_MAX_BACKLOG + 2, 20 * X));
        // the round's own position now counts: the next draw is over the cap until the keeper reveals
        assert!(jackpot_draw(&mut k, 0, 20 * X, 8).is_none());
    }

    /// Finding M2: draw_jackpot reads and writes the seat by hand because it may not exist yet; the round trip is
    /// exact, and the account list is unchanged (keeper_seat 4th, writable, not a signer).
    #[test]
    fn draw_jackpot_seat_by_hand() {
        use anchor_lang::{AccountDeserialize, AccountSerialize, ToAccountMetas};
        let mut k = seat();
        install_chain(&mut k, [3; 32], 50, 9, 1);
        k.bond = 40 * X;
        let mut buf = vec![0u8; 8 + HouseKeeper::INIT_SPACE];
        k.try_serialize(&mut &mut buf[..]).unwrap();
        assert_eq!(&buf[..8], HouseKeeper::DISCRIMINATOR);
        let mut back = HouseKeeper::try_deserialize(&mut &buf[..]).unwrap();
        let target = jackpot_draw(&mut back, 0, 20 * X, 100).unwrap();
        back.try_serialize(&mut &mut buf[..]).unwrap();
        let again = HouseKeeper::try_deserialize(&mut &buf[..]).unwrap();
        assert_eq!(bet_unpack(target), (0, 101));
        assert_eq!((again.next_index, again.pending_bets, again.jackpot_reserved, again.bond), (1, 1, 20 * X, 40 * X));
        assert_eq!((again.tip, again.length, again.armed_slot), ([3; 32], 50, 9));
        // a missing seat (zeroed / empty data) is never mistaken for one
        assert!(HouseKeeper::try_deserialize(&mut &vec![0u8; buf.len()][..]).is_err());
        let metas = crate::accounts::DrawJackpot {
            config: Pubkey::new_unique(),
            round: Pubkey::new_unique(),
            first_player_state: Pubkey::new_unique(),
            keeper_seat: Pubkey::new_unique(),
        }
        .to_account_metas(None);
        assert_eq!(metas.len(), 4);
        assert!(metas.iter().all(|m| m.is_writable && !m.is_signer));
    }

    /// Finding L2: the weekly base follows LP exits and legacy wins, never grows inside a window.
    #[test]
    fn week_base_follows_exits_only() {
        let s = 1_000 * X;
        assert_eq!(week_base(s, s, 0), s); // window just opened
        assert_eq!(week_base(s, s + 10 * X, 0), s); // pending stakes / deposits never raise it
        assert_eq!(week_base(s, s - 120 * X, (120 * X) as i64), s); // a realized v2 loss is not an exit
        assert_eq!(week_base(s, s + 50 * X, -((50 * X) as i64)), s); // nor a realized gain
        assert_eq!(week_base(s, s / 2, 0), s / 2); // a 50% LP exit halves it
        assert_eq!(week_base(s, 0, -((10 * X) as i64)), 0); // clamped, never wraps
        // with the exit, 15% binds on what remains: realized 74 + 1.96 pending > 15% of 500 (literal base 1,000: ok)
        let (stake, payout) = (X, 1_960_000_000u64);
        let stake_in = stake - bet_edge(stake).unwrap();
        let (vault, loss) = (426 * X, (74 * X) as i64); // 1,000 - 500 exit - 74 realized
        let base = week_base(s, vault, loss);
        assert_eq!(base, 500 * X);
        let lim = |ws: u64| code(bet_limits(vault, 0, stake_in, stake, payout, vault, loss, ws, 1_000 * X, 0));
        assert_eq!(lim(base), Some(ForgeError::WeeklyLossLimit as u32));
        assert_eq!(lim(s), None);
        assert!(bet_limits(vault, 0, stake_in, stake, payout, vault, (70 * X) as i64, base, 1_000 * X, 0).is_ok());
    }

    /// Finding H1: reveal_keeper carries the keeper as a (read-only) signer after the seat; data stays 40 B.
    #[test]
    fn reveal_keeper_is_keeper_signed() {
        use anchor_lang::{InstructionData, ToAccountMetas};
        let metas = crate::accounts::RevealKeeper { keeper_seat: Pubkey::new_unique(), keeper: Pubkey::new_unique() }
            .to_account_metas(None);
        assert_eq!(metas.len(), 2);
        assert!(metas[0].is_writable && !metas[0].is_signer);
        assert!(metas[1].is_signer && !metas[1].is_writable);
        let data = crate::instruction::RevealKeeper { reveal: [0; 32] }.data();
        assert_eq!((data.len(), &data[..8]), (40, &[0xf8, 0x06, 0x99, 0x6e, 0xd2, 0x73, 0xd1, 0x4d][..]));
    }

    #[test]
    fn withdraw_needs_notice_nothing_pending_and_a_valid_remainder() {
        let (bond, ts) = (25 * X, 1_000);
        assert_eq!(code(withdraw_check(bond, 5 * X, 0, 0, 10_000_000)), Some(ForgeError::KeeperNotice as u32));
        assert_eq!(code(withdraw_check(bond, 5 * X, ts, 0, ts + KEEPER_NOTICE - 1)), Some(ForgeError::KeeperNotice as u32));
        assert_eq!(code(withdraw_check(bond, 5 * X, ts, 1, ts + KEEPER_NOTICE)), Some(ForgeError::KeeperBusy as u32));
        assert!(withdraw_check(bond, 5 * X, ts, 0, ts + KEEPER_NOTICE).is_ok()); // down to 20
        assert_eq!(code(withdraw_check(bond, 6 * X, ts, 0, ts + KEEPER_NOTICE)), Some(ForgeError::KeeperBondTooSmall as u32));
        assert_eq!(code(withdraw_check(bond, bond + 1, ts, 0, ts + KEEPER_NOTICE)), Some(ForgeError::KeeperBondTooSmall as u32));
        assert!(withdraw_check(bond, bond, ts, 0, ts + KEEPER_NOTICE).is_ok()); // to 0: parked
    }

    #[test]
    fn take_keeper_after_notice_or_dead_seat() {
        let mut k = seat();
        k.last_active_ts = 1_000;
        let (named, stranger) = (Pubkey::new_unique(), Pubkey::new_unique());
        k.pending_keeper = named;
        k.pending_ts = 2_000;
        assert_eq!(code(take_keeper_gate(&k, &named, 2_000 + KEEPER_NOTICE - 1)), Some(ForgeError::KeeperNotice as u32));
        assert_eq!(take_keeper_gate(&k, &named, 2_000 + KEEPER_NOTICE).unwrap(), 0);
        assert_eq!(code(take_keeper_gate(&k, &stranger, 1_000 + KEEPER_DEAD_DELAY - 1)), Some(ForgeError::KeeperAlive as u32));
        assert_eq!(take_keeper_gate(&k, &stranger, 1_000 + KEEPER_DEAD_DELAY).unwrap(), 1);
        k.pending_keeper = Pubkey::default(); // cancelled: the default key is never a successor
        assert_eq!(code(take_keeper_gate(&k, &Pubkey::default(), 2_000 + KEEPER_NOTICE)), Some(ForgeError::KeeperAlive as u32));
    }

    /// r9 dated opening: the first arm creates the seat for INITIAL_KEEPER only, up to the second before KEEPER_OPEN_TS
    /// (2026-12-16 00:00:00 UTC = the 2026-11-18 upgrade window + 28 days); from KEEPER_OPEN_TS for whoever signs it.
    /// arm_keeper then requires signer == keeper, so before the date a stranger's first arm fails exactly as before.
    #[test]
    fn keeper_seat_opens_to_anyone_on_the_date() {
        #[cfg(not(feature = "localnet"))]
        {
            assert_eq!(KEEPER_OPEN_TS, 1_797_379_200);
            assert_eq!(KEEPER_OPEN_TS, PRICE_LAUNCH_TS + 21 * 86_400); // PRICE_LAUNCH_TS (2026-11-25) + 21 days
            assert_eq!(KEEPER_OPEN_TS, 1_794_960_000 + KEEPER_DEAD_DELAY); // 2026-11-18 00:00 UTC + 28 days
        }
        let stranger = Pubkey::new_unique();
        for now in [i64::MIN, 0, 1_793_000_000, KEEPER_OPEN_TS - 1] {
            if now < KEEPER_OPEN_TS {
                assert_eq!(first_keeper(stranger, now), INITIAL_KEEPER, "before the date: {now}");
                assert_eq!(first_keeper(INITIAL_KEEPER, now), INITIAL_KEEPER);
            }
        }
        for now in [KEEPER_OPEN_TS, KEEPER_OPEN_TS + 1, i64::MAX] {
            assert_eq!(first_keeper(stranger, now), stranger, "from the date: {now}");
            assert_eq!(first_keeper(INITIAL_KEEPER, now), INITIAL_KEEPER, "INITIAL_KEEPER may still create it");
        }
    }

    #[test]
    fn weekly_window_rolls_and_books_settles() {
        let mut k = seat(); // week_start_ts 0: the first v2 bet opens the first window
        let t0 = 1_800_000_000i64;
        roll_week(&mut k, t0, 1_000 * X);
        assert_eq!((k.week_start_ts, k.week_start_bankroll, k.week_net_loss), (t0, 1_000 * X, 0));
        k.week_net_loss += bet_net_loss(true, 985, 1_960) + bet_net_loss(false, 985, 1_960);
        assert_eq!(k.week_net_loss, 975 - 985);
        roll_week(&mut k, t0 + WEEK_WINDOW - 1, 5 * X);
        assert_eq!((k.week_start_bankroll, k.week_net_loss), (1_000 * X, -10));
        roll_week(&mut k, t0 + WEEK_WINDOW, 5 * X);
        assert_eq!((k.week_start_ts, k.week_start_bankroll, k.week_net_loss), (t0 + WEEK_WINDOW, 5 * X, 0));
    }
}
