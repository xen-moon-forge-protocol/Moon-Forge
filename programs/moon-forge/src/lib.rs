//! ═══════════════════════════════════════════════════════════════════════════
//!                 MOON FORGE PROTOCOL v2 — ANCHOR PROGRAM (X1 SVM)
//! ═══════════════════════════════════════════════════════════════════════════
//!
//! Burn XEN on any EVM chain → receive XNT on X1. Zero protocol fees on that path.
//!
//! WHO CAN DO WHAT (complete list — verify it in this file):
//!   • Anyone       : donate, claim burns for anyone (XNT goes to the player in the leaf),
//!                    seal and deliver Forge Drops (the Artifact goes to the player in the leaf),
//!                    push vested XNT, settle bets/rounds/draws, expire epochs, sweep v1
//!                    accounts, reclaim orphan artifacts, init accounts.
//!   • Players      : game wallet, house games, Jackpot, Duel, Burn Lottery, Be the House,
//!                    forge/recycle Artifacts, eject early from a vesting mission.
//!   • Oracle key   : publish_epoch (budget computed ON-CHAIN, max 10% of the free pool,
//!                    at most once per 6 days) and hand its role to a new key. Nothing else.
//!   • Architect    : set_airdrop_root ONCE. Nothing else. It receives only: 0.5% of house-game
//!                    stakes, 0.5% of P2P pots/tickets, 5% of forge price (+5% secondary royalty
//!                    on marketplaces that honor Core royalties). NOTHING from burns or claims.
//!   • Upgrade authority: held during the test period, to be burned afterwards (see SECURITY.md).
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
}
