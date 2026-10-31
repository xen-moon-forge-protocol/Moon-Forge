//! ═══════════════════════════════════════════════════════════════════════════
//!                 MOON FORGE PROTOCOL v2 — ANCHOR PROGRAM (X1 SVM)
//! ═══════════════════════════════════════════════════════════════════════════
//!
//! Burn XEN on any EVM chain → receive XNT on X1. Zero protocol fees on that path.
//!
//! WHO CAN DO WHAT (complete list — verify it in this file):
//!   • Anyone       : donate; claim burns and extra rebates for anyone (XNT goes to the wallet in the leaf) once
//!                    the 48-h hold is over; anchor bets; settle, refund stalled bets and rounds; time out and pay
//!                    out matches; lock, settle, pay out and close Prediction rounds; expire epochs; sweep v1
//!                    accounts; reclaim orphan Artifacts; init accounts (init_seat, init_extra); void an epoch
//!                    during its hold for a bond paid to the pool; take a dead oracle seat (28 days without a
//!                    surviving epoch) or a dead keeper seat (28 days inactive) for a bond; close stale listings.
//!   • Players      : game wallet, house bets through the keeper chain, Jackpot, sealed Duel and Moon Wars (no NFT
//!                    needed), Predictions, Be the House, forge / recycle / list / buy Artifacts. (Burn Lottery
//!                    tickets are retired, OD-27.)
//!   • Oracle (hot key): publish_epoch and publish_extra_epoch, each bounded on-chain and claimable only 48 h
//!                    later (a week with nothing to pay publishes a heartbeat base epoch: no leaves, budget 0, which
//!                    keeps the seat alive); hand its role to a new key, never to the architect payee. Nothing else.
//!                    No veto exists. The pool pays it one
//!                    running cost, the D-47 operating allowance of publish_epoch: the Epoch rent back + a top-up
//!                    toward 0.25 XNT of at most 0.05 XNT per epoch, inside the 10% bound after the budget, never
//!                    above 1% of the free pool, never to the architect.
//!   • Oracle seat (cold key, mandatory for the first seat): rotate the hot key; void for free (which also lets
//!                    the new hot key republish at once); resign gracefully.
//!   • House keeper : arm its hash chain with a bond, reveal (skipping a position, reveal_keeper, is keeper-only),
//!                    withdraw after a 7-day notice when nothing is pending, hand over with a 7-day notice. A
//!                    stalled bet costs the bond (keeper.rs stall_split, nothing goes to the pool): anchored and not
//!                    revealed in time, or skipped, the bond pays the player the full payout, as a win, and the
//!                    bankroll keeps the stake, as for a lost bet; never anchored, the bankroll returns stake − edge,
//!                    the bond pays the edge (the player gets its whole stake back) and the bond also forfeits
//!                    stake − edge to nobody (it stays in the seat above `bond`). A stalled Jackpot refunds every entry
//!                    and costs the bond the pot, paid to the pool. Its one income: the settle tip of settle_bet_v2
//!                    (G-2: at most 0.0005 XNT and half of the bet's pool share, from the free pool, to the registered
//!                    keeper wallet).
//!   • Architect    : set_airdrop_root ONCE (already used); lock_collection_royalties once (writes its own address
//!                    as the Core royalty creator, then locks it); set_architect (change or renounce its own payee
//!                    address). It receives only 0.5% of house stakes, 0.5% of decided P2P pots, 5% of forge
//!                    prices and 5% of native sales. NOTHING from burns, claims or either pot.
//!   • Upgrade authority and IDL authority: burned after the observation period (SECURITY.md, IMMUTABILITY.md).
//!
//! The v1 program (same id) had critical bugs (cross-epoch replay, drainable games,
//! unbounded oracle). v2 replaces it completely; v1 never processed a single claim.

use anchor_lang::prelude::*;

pub mod constants;
pub mod core_cpi;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;
pub mod utils;
#[cfg(test)]
mod vectors;

use instructions::*;

declare_id!("57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9");

#[program]
pub mod moon_forge {
    use super::*;

    // ── Setup ──────────────────────────────────────────────────────────────
    pub fn initialize_v2(ctx: Context<InitializeV2>) -> Result<()> {
        forge::initialize_v2(ctx)
    }
    pub fn init_artifacts(ctx: Context<InitArtifacts>) -> Result<()> {
        artifacts::init_artifacts(ctx)
    }
    pub fn refresh_collection_uri(ctx: Context<RefreshCollectionUri>) -> Result<()> {
        artifacts::refresh_collection_uri(ctx)
    }
    pub fn sweep_legacy(ctx: Context<SweepLegacy>) -> Result<()> {
        forge::sweep_legacy(ctx)
    }

    // ── Pools ──────────────────────────────────────────────────────────────
    /// target: 0 = reward pool (burners), 1 = bankroll (games), 2 = Burn Lottery prize
    pub fn donate(ctx: Context<Donate>, target: u8, amount: u64) -> Result<()> {
        forge::donate(ctx, target, amount)
    }

    // ── Oracle ─────────────────────────────────────────────────────────────
    pub fn publish_epoch(
        ctx: Context<PublishEpoch>,
        epoch_id: u64,
        root: [u8; 32],
        data_hash: [u8; 32],
        total_score: u128,
        leaves: u32,
        rate_cap: u64,
    ) -> Result<()> {
        forge::publish_epoch(ctx, epoch_id, root, data_hash, total_score, leaves, rate_cap)
    }
    pub fn propose_oracle(ctx: Context<OracleOnly>, new_oracle: Pubkey) -> Result<()> {
        forge::propose_oracle(ctx, new_oracle)
    }
    pub fn accept_oracle(ctx: Context<OracleOnly>) -> Result<()> {
        forge::accept_oracle(ctx)
    }

    // ── Forge claims ───────────────────────────────────────────────────────
    pub fn claim_instant(ctx: Context<ClaimInstant>, epoch_id: u64, tier: u8, score: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        forge::claim_instant(ctx, epoch_id, tier, score, proof)
    }
    pub fn claim_mission(ctx: Context<ClaimMission>, epoch_id: u64, tier: u8, score: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        forge::claim_mission(ctx, epoch_id, tier, score, proof)
    }
    pub fn withdraw_vested(ctx: Context<WithdrawVested>) -> Result<()> {
        forge::withdraw_vested(ctx)
    }
    pub fn eject(ctx: Context<Eject>) -> Result<()> {
        forge::eject(ctx)
    }
    pub fn expire_epoch(ctx: Context<ExpireEpoch>) -> Result<()> {
        forge::expire_epoch(ctx)
    }
    pub fn close_receipt(ctx: Context<CloseReceipt>) -> Result<()> {
        forge::close_receipt(ctx)
    }

    // ── Forge Drops (random Lunar Dust for burners) ────────────────────────
    pub fn seal_drop(ctx: Context<SealDrop>) -> Result<()> {
        drops::seal_drop(ctx)
    }
    pub fn claim_drop(ctx: Context<ClaimDrop>, epoch_id: u64, tier: u8, serial: u32, score: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        drops::claim_drop(ctx, epoch_id, tier, serial, score, proof)
    }
    pub fn claim_drop_xnt(ctx: Context<ClaimDropXnt>, epoch_id: u64, tier: u8, score: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        drops::claim_drop_xnt(ctx, epoch_id, tier, score, proof)
    }

    // ── Game wallet ────────────────────────────────────────────────────────
    pub fn open_player(ctx: Context<OpenPlayer>) -> Result<()> {
        games::open_player(ctx)
    }
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        games::deposit(ctx, amount)
    }
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        games::withdraw(ctx, amount)
    }
    pub fn set_session(ctx: Context<SetSession>, session_key: Pubkey, expires_at: i64, max_stake: u64) -> Result<()> {
        games::set_session(ctx, session_key, expires_at, max_stake)
    }

    // ── House games: 0 Coin Flip, 1 High-Low, 2 Void Rush ──────────────────
    pub fn place_bet(ctx: Context<PlaceBet>, game: u8, param: u64, choice: u8, stake: u64, seed: [u8; 32]) -> Result<()> {
        games::place_bet(ctx, game, param, choice, stake, seed)
    }
    pub fn settle_bet(ctx: Context<SettleBet>) -> Result<()> {
        games::settle_bet(ctx)
    }

    // ── Be the House ───────────────────────────────────────────────────────
    pub fn house_deposit(ctx: Context<HouseDeposit>, amount: u64, min_shares: u64) -> Result<()> {
        games::house_deposit(ctx, amount, min_shares)
    }
    pub fn house_request_withdraw(ctx: Context<HouseRequestWithdraw>, shares: u64) -> Result<()> {
        games::house_request_withdraw(ctx, shares)
    }
    pub fn house_withdraw(ctx: Context<HouseWithdraw>, min_lamports: u64) -> Result<()> {
        games::house_withdraw(ctx, min_lamports)
    }

    // ── Jackpot ────────────────────────────────────────────────────────────
    pub fn enter_jackpot(ctx: Context<EnterJackpot>, round_id: u64, entry_index: u32, amount: u64) -> Result<()> {
        p2p::enter_jackpot(ctx, round_id, entry_index, amount)
    }
    pub fn draw_jackpot(ctx: Context<DrawJackpot>) -> Result<()> {
        p2p::draw_jackpot(ctx)
    }
    pub fn settle_jackpot(ctx: Context<SettleJackpot>) -> Result<()> {
        p2p::settle_jackpot(ctx)
    }
    pub fn close_jackpot_entry(ctx: Context<CloseJackpotEntry>) -> Result<()> {
        p2p::close_jackpot_entry(ctx)
    }

    // ── Artifact Duel ──────────────────────────────────────────────────────
    pub fn create_duel(ctx: Context<CreateDuel>, stake: u64, commitment: [u8; 32]) -> Result<()> {
        p2p::create_duel(ctx, stake, commitment)
    }
    pub fn join_duel(ctx: Context<JoinDuel>, element: u8) -> Result<()> {
        p2p::join_duel(ctx, element)
    }
    pub fn reveal_duel(ctx: Context<RevealDuel>, element: u8, salt: [u8; 32]) -> Result<()> {
        p2p::reveal_duel(ctx, element, salt)
    }
    pub fn claim_duel_timeout(ctx: Context<ResolveDuel>) -> Result<()> {
        p2p::claim_duel_timeout(ctx)
    }
    pub fn cancel_duel(ctx: Context<CancelDuel>) -> Result<()> {
        p2p::cancel_duel(ctx)
    }

    // ── Moon Wars (PvP card battle with stakes) ─────────────────────────────
    pub fn create_war(ctx: Context<CreateWar>, stake: u64, move_key: Pubkey) -> Result<()> {
        wars::create_war(ctx, stake, move_key)
    }
    pub fn cancel_war(ctx: Context<CancelWar>) -> Result<()> {
        wars::cancel_war(ctx)
    }
    pub fn join_war(ctx: Context<JoinWar>, move_key: Pubkey) -> Result<()> {
        wars::join_war(ctx, move_key)
    }
    pub fn start_war(ctx: Context<StartWar>) -> Result<()> {
        wars::start_war(ctx)
    }
    pub fn war_summon(ctx: Context<WarMove>, hand_index: u8) -> Result<()> {
        wars::war_summon_ix(ctx, hand_index)
    }
    /// target 255 = the enemy player (only when its field is empty)
    pub fn war_attack(ctx: Context<WarMove>, attacker: u8, target: u8) -> Result<()> {
        wars::war_attack_ix(ctx, attacker, target)
    }
    pub fn war_end_turn(ctx: Context<WarMove>) -> Result<()> {
        wars::war_end_turn_ix(ctx)
    }
    pub fn claim_war_timeout(ctx: Context<ClaimWarTimeout>) -> Result<()> {
        wars::claim_war_timeout(ctx)
    }
    pub fn settle_war(ctx: Context<SettleWar>) -> Result<()> {
        wars::settle_war(ctx)
    }

    // ── Predictions ("XNT up or down", priced by the XDEX on-chain TWAP) ────
    /// side: 0 = down, 1 = up
    pub fn enter_prediction(ctx: Context<EnterPrediction>, round_id: u64, side: u8, amount: u64) -> Result<()> {
        predictions::enter_prediction(ctx, round_id, side, amount)
    }
    pub fn lock_prediction(ctx: Context<LockPrediction>) -> Result<()> {
        predictions::lock_prediction(ctx)
    }
    pub fn settle_prediction(ctx: Context<SettlePrediction>) -> Result<()> {
        predictions::settle_prediction(ctx)
    }
    pub fn claim_prediction(ctx: Context<ClaimPrediction>) -> Result<()> {
        predictions::claim_prediction(ctx)
    }

    pub fn close_prediction_round(ctx: Context<ClosePredictionRound>) -> Result<()> {
        predictions::close_prediction_round(ctx)
    }

    // ── Burn Lottery ───────────────────────────────────────────────────────
    pub fn enter_draw(ctx: Context<EnterDraw>, round_id: u64, entry_index: u32, chips: u64, tickets: u64) -> Result<()> {
        p2p::enter_draw(ctx, round_id, entry_index, chips, tickets)
    }
    pub fn draw_draw(ctx: Context<DrawDraw>) -> Result<()> {
        p2p::draw_draw(ctx)
    }
    pub fn settle_draw(ctx: Context<SettleDraw>) -> Result<()> {
        p2p::settle_draw(ctx)
    }
    pub fn close_draw_entry(ctx: Context<CloseDrawEntry>) -> Result<()> {
        p2p::close_draw_entry(ctx)
    }

    // ── Artifacts ──────────────────────────────────────────────────────────
    /// max_price: the buyer never pays more than this (the dynamic price may have moved).
    pub fn forge_artifact(ctx: Context<ForgeArtifact>, tier: u8, serial: u32, max_price: u64) -> Result<()> {
        artifacts::forge_artifact(ctx, tier, serial, max_price)
    }
    pub fn recycle_artifact(ctx: Context<RecycleArtifact>) -> Result<()> {
        artifacts::recycle_artifact(ctx)
    }
    pub fn reclaim_orphan(ctx: Context<ReclaimOrphan>) -> Result<()> {
        artifacts::reclaim_orphan(ctx)
    }
    pub fn claim_artifact_chips(ctx: Context<ClaimArtifactChips>) -> Result<()> {
        artifacts::claim_artifact_chips(ctx)
    }
    pub fn set_airdrop_root(ctx: Context<SetAirdropRoot>, root: [u8; 32]) -> Result<()> {
        artifacts::set_airdrop_root(ctx, root)
    }
    pub fn claim_airdrop(ctx: Context<ClaimAirdrop>, serial: u32, proof: Vec<[u8; 32]>) -> Result<()> {
        artifacts::claim_airdrop(ctx, serial, proof)
    }

    // ═══ Final upgrade (v3): new entries, SPEC-UPGRADE-v2 §2.17 order ═══

    // ── Sealed Duel and Moon Wars ──────────────────────────────────────────
    /// commitment = keccak("MOONFORGE_DUEL_JOIN" ‖ element ‖ salt ‖ duel ‖ opponent)
    pub fn join_duel_sealed(ctx: Context<JoinDuel>, commitment: [u8; 32]) -> Result<()> {
        p2p::join_duel_sealed(ctx, commitment)
    }
    pub fn reveal_duel_join(ctx: Context<RevealDuelJoin>, element: u8, salt: [u8; 32]) -> Result<()> {
        p2p::reveal_duel_join(ctx, element, salt)
    }
    /// entropy_commitment = keccak("MOONFORGE_WAR_ENTROPY" ‖ entropy ‖ war)
    pub fn create_war_sealed(ctx: Context<CreateWar>, stake: u64, move_key: Pubkey, entropy_commitment: [u8; 32]) -> Result<()> {
        wars::create_war_sealed(ctx, stake, move_key, entropy_commitment)
    }
    /// commitment = keccak("MOONFORGE_WAR_JOIN" ‖ secret ‖ war ‖ opponent ‖ move_key)
    pub fn join_war_sealed(ctx: Context<JoinWar>, commitment: [u8; 32]) -> Result<()> {
        wars::join_war_sealed(ctx, commitment)
    }
    pub fn seed_war(ctx: Context<WarMove>, entropy: [u8; 32]) -> Result<()> {
        wars::seed_war(ctx, entropy)
    }
    pub fn reveal_war(ctx: Context<WarMove>, secret: [u8; 32], move_key: Pubkey) -> Result<()> {
        wars::reveal_war(ctx, secret, move_key)
    }

    // ── Oracle seat ────────────────────────────────────────────────────────
    pub fn init_seat(ctx: Context<InitSeat>) -> Result<()> {
        seat::init_seat(ctx)
    }
    pub fn rotate_hot(ctx: Context<ColdOnly>, new_hot: Pubkey) -> Result<()> {
        seat::rotate_hot(ctx, new_hot)
    }
    /// Only a seat with an epoch published since max(now - 28 d, its take) that survived its hold (G2-R1).
    /// remaining accounts: the (Epoch, ExtraEpoch) pairs of that window, newest first
    pub fn resign_seat(ctx: Context<ResignSeat>, successor: Pubkey) -> Result<()> {
        seat::resign_seat(ctx, successor)
    }
    /// remaining accounts: the (Epoch, ExtraEpoch) pairs of the dead-seat walk, newest first (ignored for an open seat)
    pub fn take_seat(ctx: Context<TakeSeat>, new_hot: Pubkey, new_cold: Pubkey, new_refund: Pubkey) -> Result<()> {
        seat::take_seat(ctx, new_hot, new_cold, new_refund)
    }
    /// remaining account 0 (optional, cold voids of epoch id > 1): the Epoch of id - 1. With it the cold void also
    /// waives the 6-day interval (S-2); without it the void still succeeds, without the waiver; a wrong account fails
    pub fn void_epoch(ctx: Context<VoidEpoch>, epoch_id: u64, bond: u64) -> Result<()> {
        seat::void_epoch(ctx, epoch_id, bond)
    }
    pub fn void_extra_epoch(ctx: Context<VoidExtraEpoch>, epoch_id: u64, bond: u64) -> Result<()> {
        seat::void_extra_epoch(ctx, epoch_id, bond)
    }

    // ── Extra pot ──────────────────────────────────────────────────────────
    pub fn init_extra(ctx: Context<InitExtra>) -> Result<()> {
        extra::init_extra(ctx)
    }
    pub fn publish_extra_epoch(
        ctx: Context<PublishExtraEpoch>,
        epoch_id: u64,
        root: [u8; 32],
        data_hash: [u8; 32],
        total: u64,
        leaves: u32,
        weeks: u8,
    ) -> Result<()> {
        extra::publish_extra_epoch(ctx, epoch_id, root, data_hash, total, leaves, weeks)
    }
    pub fn claim_extra(ctx: Context<ClaimExtra>, epoch_id: u64, index: u32, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        extra::claim_extra(ctx, epoch_id, index, amount, proof)
    }
    pub fn close_extra_epoch(ctx: Context<CloseExtraEpoch>) -> Result<()> {
        extra::close_extra_epoch(ctx)
    }

    // ── Artifact Market (escrowless: the NFT stays in the seller's wallet, TransferDelegate = the Listing PDA) ──
    pub fn list_artifact(
        ctx: Context<ListArtifact>,
        price: u64,
        expires_at: i64,
        reserved_buyer: Pubkey,
        add_plugin: bool,
    ) -> Result<()> {
        market::list_artifact(ctx, price, expires_at, reserved_buyer, add_plugin)
    }
    pub fn update_listing(ctx: Context<UpdateListing>, price: u64, expires_at: i64, reserved_buyer: Pubkey) -> Result<()> {
        market::update_listing(ctx, price, expires_at, reserved_buyer)
    }
    pub fn delist_artifact(ctx: Context<DelistArtifact>) -> Result<()> {
        market::delist_artifact(ctx)
    }
    /// The buyer pays `price` exactly: 93% to the seller (never below the floor), 5% to the architect, 2% to the pool.
    pub fn buy_artifact(ctx: Context<BuyArtifact>, price: u64) -> Result<()> {
        market::buy_artifact(ctx, price)
    }
    /// Permissionless: closes a stale (moved / recycled) or expired listing; the rent goes back to the seller.
    pub fn close_listing(ctx: Context<CloseListing>) -> Result<()> {
        market::close_listing(ctx)
    }
    pub fn lock_collection_royalties(ctx: Context<LockCollectionRoyalties>) -> Result<()> {
        market::lock_collection_royalties(ctx)
    }

    // ── House keeper (hash-chain randomness for house bets and the Jackpot) ─
    pub fn arm_keeper(ctx: Context<ArmKeeper>, tip: [u8; 32], length: u64, deposit: u64) -> Result<()> {
        keeper::arm_keeper(ctx, tip, length, deposit)
    }
    /// amount 0 = request / cancel a withdrawal; > 0 = withdraw after the 7-day notice
    pub fn keeper_withdraw(ctx: Context<HouseKeeperOnly>, amount: u64) -> Result<()> {
        keeper::keeper_withdraw(ctx, amount)
    }
    pub fn reveal_keeper(ctx: Context<RevealKeeper>, reveal: [u8; 32]) -> Result<()> {
        keeper::reveal_keeper(ctx, reveal)
    }
    pub fn place_bet_v2(ctx: Context<PlaceBetV2>, game: u8, param: u64, choice: u8, stake: u64, seed: [u8; 32]) -> Result<()> {
        keeper::place_bet_v2(ctx, game, param, choice, stake, seed)
    }
    pub fn anchor_bet(ctx: Context<AnchorBet>) -> Result<()> {
        keeper::anchor_bet(ctx)
    }
    pub fn settle_bet_v2(ctx: Context<SettleBetV2>, reveal: [u8; 32]) -> Result<()> {
        keeper::settle_bet_v2(ctx, reveal)
    }
    pub fn refund_stalled_bet(ctx: Context<RefundStalledBet>) -> Result<()> {
        keeper::refund_stalled_bet(ctx)
    }
    pub fn propose_keeper(ctx: Context<HouseKeeperOnly>, new_keeper: Pubkey) -> Result<()> {
        keeper::propose_keeper(ctx, new_keeper)
    }
    pub fn take_keeper(ctx: Context<TakeKeeper>, tip: [u8; 32], length: u64, deposit: u64) -> Result<()> {
        keeper::take_keeper(ctx, tip, length, deposit)
    }
    pub fn settle_jackpot_v2(ctx: Context<SettleJackpotV2>, reveal: [u8; 32]) -> Result<()> {
        p2p::settle_jackpot_v2(ctx, reveal)
    }

    // ── Architect payee ────────────────────────────────────────────────────
    pub fn set_architect(ctx: Context<SetArchitect>, new_architect: Pubkey) -> Result<()> {
        forge::set_architect(ctx, new_architect)
    }
}
