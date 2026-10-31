use anchor_lang::prelude::*;

use crate::constants::*;

/// Global protocol state. Created once by the permissionless `initialize_v2`
/// with values taken from compile-time constants (nothing can be front-run).
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub bump: u8,
    pub oracle: Pubkey,
    /// Two-step oracle hand-over. Pubkey::default() = none pending.
    pub pending_oracle: Pubkey,
    /// The architect PAYEE (@74). set_architect rotates it or renounces it to the reward vault. Never an authority.
    pub architect: Pubkey,
    /// bumps of [reward_vault, bankroll_vault, draw_vault, collection, artifact_authority]
    pub bumps: [u8; 5],

    // ── Forge ──
    pub last_epoch: u64,
    pub last_publish_ts: i64,
    /// Sum over open epochs of (budget - claimed). Not part of the free pool.
    pub reward_reserved: u64,

    // ── Games ──
    /// Sum of the gross payouts of all unsettled house bets; a new bet is refused above 5% of the bankroll.
    pub bankroll_reserved: u64,
    pub house_total_shares: u64,
    /// Shares minted to the protocol for value that existed before the first LP.
    /// They are never withdrawable: a permanent bankroll floor.
    pub house_protocol_shares: u64,
    pub jackpot_round: u64,
    pub draw_round: u64,

    // ── Artifacts ──
    pub artifacts_alive: [u16; 4],
    pub artifacts_minted: [u32; 4],
    pub airdrop_root: [u8; 32],
    pub airdrop_root_set: bool,
    pub airdrop_claimed: u16,
    /// PX price per tier left by the last forge (0 = never forged: the base price decays from PRICE_LAUNCH_TS).
    pub artifact_price: [u64; 4],
    /// Start of the tier's decay clock: the last forge, or the release of a slot from a full tier.
    pub artifact_price_ts: [i64; 4],
    /// Circuit breaker: current day and the OPTIMISTIC bankroll value (unsettled bets counted as lost) at the
    /// day's first bet, adjusted by LP flows.
    pub bankroll_day: i64,
    pub bankroll_day_start: u64,

    pub stats: Stats,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Stats {
    pub donated_reward: u64,
    pub donated_bankroll: u64,
    pub donated_draw: u64,
    pub forge_paid: u64,
    pub forge_claims: u64,
    /// Eject penalties, and oracle-seat / keeper bonds forfeited to the pool.
    pub penalties_to_pool: u64,
    pub keeper_tips: u64,
    pub wagered: u64,
    pub bets: u64,
    pub paid_to_players: u64,
    pub edge_to_pool: u64,
    pub to_architect: u64,
    pub to_draw: u64,
    pub artifact_to_pool: u64,
    pub draw_prizes: u64,
    pub drops: u64,
    pub drop_paid: u64,
    /// Lottery prizes of weeks nobody settled in time, sent to the reward pool.
    pub expired_draws_to_pool: u64,
}

/// One per published epoch. Seeds: ["epoch", epoch_id_le]
#[account]
#[derive(InitSpace)]
pub struct Epoch {
    pub id: u64,
    pub root: [u8; 32],
    /// sha256 of the full epoch JSON published by the oracle (every burn, every score).
    pub data_hash: [u8; 32],
    pub total_score: u128,
    pub leaves: u32,
    /// Max lamports paid per score unit (mandatory, > 0). It can only LOWER the budget:
    /// budget = min(10% of free pool, total_score * rate_cap). Prevents mint-and-burn farming
    /// windfalls; whatever is not distributed simply stays in the pool.
    pub rate_cap: u64,
    /// Paid pro-rata to the leaves (the epoch budget minus `drop_reserve`).
    pub budget: u64,
    pub claimed: u64,
    pub claims: u32,
    pub published_at: i64,
    pub expires_at: i64,
    /// expired, or voided during its 48-h hold
    pub closed: bool,
    /// Forge Drops (legacy epochs only): share of the epoch budget paid as random Lunar Dust. Always 0 since
    /// the final upgrade.
    pub drop_reserve: u64,
    /// Floors given to drop winners (can exceed the reserve by luck; the excess comes from the free pool).
    pub drop_paid: u64,
    pub drops: u32,
    pub drop_slot: u64,
    pub drop_seed: [u8; 32],
    /// DROP_NONE / DROP_PENDING / DROP_SEALED / DROP_CANCELLED (always DROP_NONE since the final upgrade)
    pub drop_state: u8,
    pub bump: u8,
}

/// Anti double-drop. Seeds: ["drop", epoch_le, player, tier]
#[account]
#[derive(InitSpace)]
pub struct DropReceipt {
    pub epoch: u64,
    pub player: Pubkey,
    pub tier: u8,
    /// Pubkey::default() when the drop was paid in XNT (Lunar Dust sold out)
    pub asset: Pubkey,
    pub value: u64,
    pub bump: u8,
}

/// Anti double-claim. Seeds: ["receipt", epoch_le, player, tier]. Closable only after
/// the epoch is closed (claims are impossible then), refunding rent to whoever paid it.
#[account]
#[derive(InitSpace)]
pub struct ClaimReceipt {
    pub epoch: u64,
    pub player: Pubkey,
    pub tier: u8,
    pub amount: u64,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

/// Vesting position for Orbit / Moon Landing. Holds its own XNT.
/// Seeds: ["mission", epoch_le, player, tier]
#[account]
#[derive(InitSpace)]
pub struct Mission {
    pub player: Pubkey,
    pub epoch: u64,
    pub tier: u8,
    pub total: u64,
    pub withdrawn: u64,
    pub start: i64,
    pub end: i64,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

/// Game wallet of a player. Lamports held = rent + `balance`.
/// Seeds: ["player", owner]
#[account]
#[derive(InitSpace)]
pub struct PlayerState {
    pub owner: Pubkey,
    pub balance: u64,
    /// Non-transferable Burn Lottery chips. Retired: nothing grants them since the final upgrade.
    pub chips: u64,
    /// Optional delegated key (bots / auto-play). Can bet, can never withdraw.
    pub session_key: Pubkey,
    pub session_expires: i64,
    pub session_max_stake: u64,
    pub nonce: u64,
    pub total_wagered: u64,
    pub total_won: u64,
    pub bump: u8,
}

/// A pending house bet. Seeds: ["bet", player_state, nonce_le]
#[account]
#[derive(InitSpace)]
pub struct Bet {
    pub player_state: Pubkey,
    pub owner: Pubkey,
    pub rent_payer: Pubkey,
    /// bits 0-5 game id (readers mask with BET_GAME_MASK); bit 6 BET_ANCHORED; bit 7 BET_KEEPER (v3 keeper bet)
    pub game: u8,
    pub choice: u8,
    pub chance_bps: u64,
    pub stake: u64,
    pub payout: u64,
    /// the player's seed until anchor_bet; then keccak("MOONFORGE_ANCHOR" ‖ seed ‖ hash(anchor_slot))
    pub seed: [u8; 32],
    /// legacy bet (bit 7 clear) = the drawing slot; v2 bet = index << 40 | anchor_slot (bet_pack), where
    /// anchor_slot = placement slot + 1 and index = the keeper-chain position reserved for it
    pub target_slot: u64,
    pub nonce: u64,
    pub bump: u8,
}

/// Bankroll LP position. Seeds: ["house", owner]
#[account]
#[derive(InitSpace)]
pub struct HouseShare {
    pub owner: Pubkey,
    pub shares: u64,
    pub pending_shares: u64,
    /// usable in [unlock_ts, unlock_ts + HOUSE_WITHDRAW_WINDOW)
    pub unlock_ts: i64,
    pub bump: u8,
}

pub const ROUND_OPEN: u8 = 0;
pub const ROUND_DRAWING: u8 = 1;
pub const ROUND_SETTLED: u8 = 2;
/// The drawing block left the SlotHashes window before anyone settled: every entry is
/// refunded (a re-roll would let a losing player wait for a better block).
pub const ROUND_REFUND: u8 = 3;

/// Multiplayer pot. Holds the pot lamports. Seeds: ["jackpot", round_le]
#[account]
#[derive(InitSpace)]
pub struct JackpotRound {
    pub id: u64,
    pub total: u64,
    pub entries: u32,
    pub first_player: Pubkey,
    pub multi_player: bool,
    pub end_ts: i64,
    /// legacy draw = the drawing slot; v3 draw = bet_pack(index, slot + 1) with the keeper-chain position reserved at draw
    pub target_slot: u64,
    pub state: u8,
    pub winner: Pubkey,
    /// while DRAWING: u64::MAX = drawn by the v3 binary (settle_jackpot_v2); anything else = drawn by v2 (settle_jackpot)
    pub winning_ticket: u64,
    pub bump: u8,
}

/// Seeds: ["jp_entry", round_le, index_le]
#[account]
#[derive(InitSpace)]
pub struct JackpotEntry {
    pub round: u64,
    pub index: u32,
    pub player: Pubkey,
    pub start: u64,
    pub amount: u64,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

pub const PRED_OPEN: u8 = 0;
pub const PRED_LOCKED: u8 = 1;
pub const PRED_SETTLED: u8 = 2;
pub const PRED_REFUND: u8 = 3;
pub const SIDE_DOWN: u8 = 0;
pub const SIDE_UP: u8 = 1;

/// "XNT up or down" round. Holds the pot. Seeds: ["pred", round_id_le]
/// v1 schedule when end_ts − lock_ts == PRED_V1_HORIZON; v2 otherwise.
#[account]
#[derive(InitSpace)]
pub struct PredRound {
    pub id: u64,
    pub lock_ts: i64,
    pub end_ts: i64,
    /// [down, up] totals
    pub totals: [u64; 2],
    pub entries: u32,
    pub state: u8,
    pub start_price_x32: u128,
    pub end_price_x32: u128,
    pub outcome: u8,
    /// pot minus rake, shared by the winning side
    pub prize_pool: u64,
    /// entries already paid out / closed; the round closes once every entry is claimed
    pub claimed: u32,
    /// paid the round account rent (the first entrant); gets it back when the round closes
    pub rent_payer: Pubkey,
    pub bump: u8,
}

/// Seeds: ["pred_entry", round_id_le, player]
#[account]
#[derive(InitSpace)]
pub struct PredEntry {
    pub round: u64,
    pub player: Pubkey,
    pub side: u8,
    pub amount: u64,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

pub const WAR_OPEN: u8 = 0;
pub const WAR_STARTING: u8 = 1; // joined; waiting for the seed block
pub const WAR_ACTIVE: u8 = 2;
pub const WAR_DONE: u8 = 3; // finished; waiting for settle_war (payout)

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Debug)]
pub struct WarUnit {
    pub element: u8,
    pub defense: i8,
    pub ready: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Debug)]
pub struct WarSide {
    pub health: i8,
    pub mana: u8,
    /// shuffled deck; cards are drawn from the end (deck[deck_left - 1])
    pub deck: [u8; 10],
    pub deck_left: u8,
    pub hand: [u8; 10],
    pub hand_len: u8,
    pub field: [WarUnit; 6],
    pub field_len: u8,
}

/// Moon Wars match. Holds both stakes. Seeds: ["war", creator, nonce_le]
#[account]
#[derive(InitSpace)]
pub struct War {
    pub creator: Pubkey,
    pub opponent: Pubkey,
    pub nonce: u64,
    pub stake: u64,
    pub state: u8,
    /// 0 or a real slot = legacy; bit 63 = v2 (sealed start), see WAR_V2 (clock banks once ACTIVE/DONE)
    pub target_slot: u64,
    /// 0 = creator to move, 1 = opponent to move; while STARTING v2: 0 = waiting for the creator's entropy,
    /// 1 = waiting for the joiner's reveal
    pub turn: u8,
    pub round: u16,
    /// the player to move loses after this time; OPEN v2 = offer expiry; STARTING v2 = deadline of the awaited step
    pub deadline: i64,
    /// keys allowed to sign moves (the owner, or a key generated in the player's own browser);
    /// keys[1] while STARTING v2 = the joiner's commitment
    pub keys: [Pubkey; 2],
    /// meaningless while state < 2
    pub sides: [WarSide; 2],
    /// OPEN v2 / STARTING v2 turn 0 = the entropy commitment; STARTING v2 turn 1 = the creator's entropy; DONE = the winner
    pub winner: Pubkey,
    pub draw: bool,
    pub timeout: bool,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

pub const DUEL_OPEN: u8 = 0;
pub const DUEL_JOINED: u8 = 1;
pub const DUEL_DONE: u8 = 2;
/// opponent_element while the joiner's element is still sealed (join_duel_sealed)
pub const DUEL_ELEMENT_SEALED: u8 = 255;

/// Artifact Duel (commit-reveal PvP; no Artifact needed since the final upgrade). Holds both stakes.
/// Seeds: ["duel", creator, nonce_le]
#[account]
#[derive(InitSpace)]
pub struct Duel {
    pub creator: Pubkey,
    pub nonce: u64,
    pub stake: u64,
    pub commitment: [u8; 32],
    pub opponent: Pubkey,
    pub opponent_element: u8,
    pub creator_element: u8,
    pub state: u8,
    /// OPEN created by v3 = offer expiry (0 = legacy, no expiry); JOINED sealed and unopened = the joiner's open
    /// deadline; JOINED opened = the creator's reveal deadline
    pub deadline: i64,
    /// @131: the joiner's commitment while opponent_element == DUEL_ELEMENT_SEALED, zero otherwise
    /// (was `winner`, which was never persisted)
    pub opponent_commitment: [u8; 32],
    pub rent_payer: Pubkey,
    pub bump: u8,
}

/// Weekly Burn Lottery. Seeds: ["draw", round_le]
#[account]
#[derive(InitSpace)]
pub struct DrawRound {
    pub id: u64,
    pub start_ts: i64,
    pub end_ts: i64,
    pub total_weight: u64,
    pub entries: u32,
    /// non-zero while OPEN = drawing block fixed at open (v3); zero while OPEN = a pre-upgrade round
    pub target_slot: u64,
    pub state: u8,
    pub winning_ticket: u64,
    pub winner: Pubkey,
    pub prize: u64,
    pub bump: u8,
}

/// Seeds: ["draw_entry", round_le, index_le]
#[account]
#[derive(InitSpace)]
pub struct DrawEntry {
    pub round: u64,
    pub index: u32,
    pub player: Pubkey,
    pub start: u64,
    pub weight: u64,
    pub rent_payer: Pubkey,
    pub bump: u8,
}

pub const ORIGIN_FORGED: u8 = 0;
pub const ORIGIN_AIRDROP: u8 = 1;
pub const ORIGIN_DROP: u8 = 2;

/// Moon Forge side-car for each Core asset. Holds the artifact's floor (backing) in lamports.
/// Seeds: ["artifact", asset]
#[account]
#[derive(InitSpace)]
pub struct ArtifactRecord {
    pub asset: Pubkey,
    pub tier: u8,
    pub serial: u32,
    pub backing: u64,
    pub origin: u8,
    pub forged_at: i64,
    /// retired (chips are never granted since the final upgrade); kept for the layout
    pub last_chip_week: i64,
    pub bump: u8,
}

/// Seeds: ["airdrop", claimant]
#[account]
#[derive(InitSpace)]
pub struct AirdropReceipt {
    pub claimant: Pubkey,
    pub asset: Pubkey,
    pub bump: u8,
}

// ─── final upgrade (v3): new accounts, appended; nothing existing changes ───

/// The oracle seat. Seeds: ["oracle_seat"]. Holds its bond as lamports above rent.
/// Config.oracle is the seat's HOT key (publishes). `cold` may rotate it and void for free. Nobody can veto.
#[account]
#[derive(InitSpace)]
pub struct OracleSeat {
    pub generation: u64,    // @8   1 at init_seat, +1 per take_seat
    pub cold: Pubkey,       // @16  Pubkey::default() = no cold key
    pub refund: Pubkey,     // @48  receives the bond on a graceful resign (default = the pool)
    pub bond: u64,          // @80  lamports held above rent
    pub taken_at: i64,      // @88  init / take time; the seat cannot die before taken_at + 28 d
    pub open_since: i64,    // @96  0 = not open; else the resign time (bond already returned)
    pub priority: Pubkey,   // @104 largest void bond of this generation, or the successor named at resign
    pub priority_bond: u64, // @136
    pub voids: u32,         // @144 lifetime count of voids (base + extra)
    pub to_pool: u64,       // @148 lifetime void bonds + forfeits sent to reward_vault
    pub bump: u8,           // @156
}

/// Extra pot state (nft-extra). Seeds: ["extra_state"]. Counters, never lamport reads: stray transfers are ignored.
#[account]
#[derive(InitSpace)]
pub struct ExtraState {
    pub last_epoch: u64,          // @8   last extra epoch published (== base epoch id)
    pub last_publish_ts: i64,     // @16
    pub accounted: u64,           // @24  forge inflows − paid (returned budgets only leave reserved; the pot as the program knows it)
    pub reserved: u64,            // @32  Σ (budget − claimed) over open extra epochs
    pub free_after: u64,          // @40  accounted − reserved right after the last publish (the next week's X)
    pub live_forged_backing: u64, // @48  Σ backing of live FORGED Artifacts
    pub out_since_publish: u64,   // @56  backing that left (recycle/orphan) since the last publish
    pub total_in: u64,            // @64  lifetime 25% forge inflows
    pub total_paid: u64,          // @72
    pub total_returned: u64,      // @80  unclaimed + voided budgets returned to the pot
    pub vault_bump: u8,           // @88
    pub bump: u8,                 // @89
}

/// One per extra epoch. Seeds: ["extra_epoch", id_le]. Claims are bits, not receipts.
#[account]
#[derive(InitSpace)]
pub struct ExtraEpoch {
    pub id: u64,             // @8
    pub root: [u8; 32],      // @16
    pub data_hash: [u8; 32], // @48  sha256 of extra-<id>.json
    pub budget: u64,         // @80  Σ leaf amounts (B)
    pub claimed: u64,        // @88
    pub leaves: u32,         // @96
    pub published_at: i64,   // @100
    pub free_before: u64,    // @108 X at publish (verifiable: R = 8% of it)
    pub closed: bool,        // @116 expired or voided
    pub bump: u8,            // @117
    pub rent_payer: Pubkey,  // @118 the oracle key that paid the rent (X-2): close_extra_epoch refunds it
    pub bitmap: [u8; 125],   // @150..275, bit i = leaf i claimed (literal length, LB-8)
}
const _: () = assert!(EXTRA_BITMAP_BYTES == 125);

/// One open sale offer per Artifact. The NFT never leaves the seller's wallet: Core's TransferDelegate is
/// delegated to THIS account's address, which signs the transfer only inside buy_artifact, after payment.
/// Seeds: ["listing", asset]. 130 B, rent 1,795,680 lamports (X1), paid by the seller, refunded on buy/delist/close.
#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub asset: Pubkey,  // @8
    pub seller: Pubkey, // @40  (memcmp "my listings")
    /// Pubkey::default() = anyone; otherwise only this wallet can buy (private sale, self-move between own wallets)
    pub reserved_buyer: Pubkey, // @72
    /// lamports the buyer pays; fees are deducted from the seller
    pub price: u64,      // @104
    pub created_at: i64, // @112
    pub expires_at: i64, // @120
    pub tier: u8,        // @128 (memcmp filter)
    pub bump: u8,        // @129
}

/// The house keeper seat (hash-chain randomness for house bets and the Jackpot). Seeds: ["house_keeper"].
/// Holds its bond as lamports above rent (plus every reason-0 forfeit, owed to nobody: r4-fix). Config.bankroll_reserved
/// stays the sum of pending payouts.
#[account]
#[derive(InitSpace)]
pub struct HouseKeeper {
    pub keeper: Pubkey,           // @8   may arm, withdraw, propose
    pub pending_keeper: Pubkey,   // @40  default = none
    pub pending_ts: i64,          // @72
    pub tip: [u8; 32],            // @80  current chain head: keccak(next reveal) == tip
    pub length: u64,              // @112 reveals available on this chain
    pub next_index: u64,          // @120 next chain position to hand out (bets and jackpot settles)
    pub revealed: u64,            // @128 positions already revealed
    pub bond: u64,                // @136 lamports above rent
    pub pending_bets: u32,        // @144 v2 bets placed and not yet settled or refunded, PLUS v3 Jackpot rounds DRAWING (K-2)
    pub last_active_ts: i64,      // @148 arm / reveal / settle; the seat is dead 28 d after it
    pub armed_slot: u64,          // @156 slot of the last arm; every anchor must be later
    pub week_start_ts: i64,       // @164
    pub week_start_bankroll: u64, // @172 optimistic bankroll at the window start
    pub week_net_loss: i64,       // @180 realized bankroll outflow − inflow on v2 bets this window
    pub penalties: u64,           // @188 lifetime bond penalties: Jackpot expiries (to reward_vault) + house stalls (reason 1: the stake the bankroll keeps; reason 0, r4-fix: the stake − edge forfeited to nobody, left in this account above `bond`)
    pub jackpot_reserved: u64,    // @196 Σ round.total of v3 Jackpot rounds now DRAWING (K-3): the bond covers them too
    pub withdraw_ts: i64,         // @204 keeper_withdraw request time, 0 = none (K-4: 7-day notice before money leaves)
    pub bump: u8,                 // @212
}

// ─── Layout freeze: no account ever changes size (the upgrade authority is burned after this upgrade) ───
const _: () = assert!(8 + Config::INIT_SPACE == 458);
const _: () = assert!(8 + Epoch::INIT_SPACE == 207);
const _: () = assert!(8 + ClaimReceipt::INIT_SPACE == 90);
const _: () = assert!(8 + DropReceipt::INIT_SPACE == 90);
const _: () = assert!(8 + Mission::INIT_SPACE == 114);
const _: () = assert!(8 + PlayerState::INIT_SPACE == 129);
const _: () = assert!(8 + Bet::INIT_SPACE == 179);
const _: () = assert!(8 + HouseShare::INIT_SPACE == 65);
const _: () = assert!(8 + JackpotRound::INIT_SPACE == 119);
const _: () = assert!(8 + JackpotEntry::INIT_SPACE == 101);
const _: () = assert!(8 + PredRound::INIT_SPACE == 131);
const _: () = assert!(8 + PredEntry::INIT_SPACE == 90);
const _: () = assert!(8 + War::INIT_SPACE == 325);
const _: () = assert!(8 + Duel::INIT_SPACE == 196);
const _: () = assert!(8 + DrawRound::INIT_SPACE == 102);
const _: () = assert!(8 + DrawEntry::INIT_SPACE == 101);
const _: () = assert!(8 + ArtifactRecord::INIT_SPACE == 71);
const _: () = assert!(8 + AirdropReceipt::INIT_SPACE == 73);
const _: () = assert!(8 + OracleSeat::INIT_SPACE == 157);
const _: () = assert!(8 + ExtraState::INIT_SPACE == 90);
const _: () = assert!(8 + ExtraEpoch::INIT_SPACE == 275);
const _: () = assert!(8 + Listing::INIT_SPACE == 130);
const _: () = assert!(8 + HouseKeeper::INIT_SPACE == 213);

#[cfg(test)]
mod layout_tests {
    use super::*;
    use anchor_lang::Discriminator;

    fn hex(d: &[u8]) -> String {
        d.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// discs-v2.out.txt: the 18 live account discriminators and the 5 new ones.
    #[test]
    fn account_discriminators_are_frozen() {
        let all: [(&[u8], &str); 23] = [
            (Config::DISCRIMINATOR, "9b0caae01efacc82"), (Epoch::DISCRIMINATOR, "5d537859978a986c"),
            (ClaimReceipt::DISCRIMINATOR, "dfe90be57ca5cf1c"), (DropReceipt::DISCRIMINATOR, "5a63725239acc420"),
            (Mission::DISCRIMINATOR, "aa38744b180b6d0c"), (PlayerState::DISCRIMINATOR, "38033c56ae10f4c3"),
            (Bet::DISCRIMINATOR, "9317233b0f4b9b20"), (HouseShare::DISCRIMINATOR, "d3c0994e185d0453"),
            (JackpotRound::DISCRIMINATOR, "1387628193288715"), (JackpotEntry::DISCRIMINATOR, "73bfa34a0e0e6338"),
            (PredRound::DISCRIMINATOR, "22d829fcda742a9d"), (PredEntry::DISCRIMINATOR, "727a63e976a6a888"),
            (War::DISCRIMINATOR, "361fe5721d1dd441"), (Duel::DISCRIMINATOR, "7ee5d23cb1877ce0"),
            (DrawRound::DISCRIMINATOR, "6c472df8b8901d04"), (DrawEntry::DISCRIMINATOR, "9a67914db9e40fc7"),
            (ArtifactRecord::DISCRIMINATOR, "2d74f42ee467870e"), (AirdropReceipt::DISCRIMINATOR, "6c4edd03400edb5f"),
            (OracleSeat::DISCRIMINATOR, "23df920b26094fb8"), (ExtraState::DISCRIMINATOR, "ee1f1b1bec696daa"),
            (ExtraEpoch::DISCRIMINATOR, "22c8264cc3930863"), (Listing::DISCRIMINATOR, "da2032492b861a3a"),
            (HouseKeeper::DISCRIMINATOR, "00b138e7b7a5538e"),
        ];
        for (d, want) in all {
            assert_eq!(hex(d), want);
        }
    }

    fn ser<T: AnchorSerialize + Discriminator>(v: &T) -> Vec<u8> {
        let mut out = T::DISCRIMINATOR.to_vec();
        v.serialize(&mut out).unwrap();
        out
    }
    fn u64_at(b: &[u8], o: usize) -> u64 {
        u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
    }
    fn i64_at(b: &[u8], o: usize) -> i64 {
        i64::from_le_bytes(b[o..o + 8].try_into().unwrap())
    }

    /// Golden offsets the clients memcmp on (LB-5 and the packed fields of SPEC-UPGRADE-v2 §2.2).
    #[test]
    fn golden_offsets() {
        let mut c = Config {
            version: 2, bump: 0, oracle: Pubkey::new_unique(), pending_oracle: Pubkey::new_unique(), architect: Pubkey::new_unique(),
            bumps: [0; 5], last_epoch: 0, last_publish_ts: 0, reward_reserved: 0, bankroll_reserved: 0, house_total_shares: 0,
            house_protocol_shares: 0, jackpot_round: 0, draw_round: 0, artifacts_alive: [0; 4], artifacts_minted: [0; 4],
            airdrop_root: [0; 32], airdrop_root_set: false, airdrop_claimed: 0, artifact_price: [0; 4], artifact_price_ts: [0; 4],
            bankroll_day: 0, bankroll_day_start: 0, stats: Stats::default(),
        };
        c.architect = Pubkey::new_from_array([7; 32]);
        let b = ser(&c);
        assert_eq!(b.len(), 458);
        assert_eq!(&b[74..106], &[7u8; 32]);
        assert_eq!(&b[10..42], c.oracle.as_ref());
        assert_eq!(&b[42..74], c.pending_oracle.as_ref());

        let r = JackpotRound {
            id: 1, total: 2, entries: 3, first_player: Pubkey::default(), multi_player: true, end_ts: 4, target_slot: 0x0500000F4240,
            state: ROUND_DRAWING, winner: Pubkey::default(), winning_ticket: u64::MAX, bump: 0,
        };
        let b = ser(&r);
        assert_eq!(b.len(), 119);
        assert_eq!(u64_at(&b, 69), 5_497_559_138_880);
        assert_eq!(u64_at(&b, 110), u64::MAX);

        let k = HouseKeeper {
            keeper: Pubkey::default(), pending_keeper: Pubkey::default(), pending_ts: 0, tip: [0; 32], length: 0, next_index: 0,
            revealed: 0, bond: 11, pending_bets: 0, last_active_ts: 0, armed_slot: 0, week_start_ts: 0, week_start_bankroll: 0,
            week_net_loss: -1, penalties: 0, jackpot_reserved: 12, withdraw_ts: 13, bump: 9,
        };
        let b = ser(&k);
        assert_eq!(b.len(), 213);
        assert_eq!(u64_at(&b, 136), 11);
        assert_eq!(i64_at(&b, 180), -1);
        assert_eq!(u64_at(&b, 196), 12);
        assert_eq!(i64_at(&b, 204), 13);
        assert_eq!(b[212], 9);

        let e = ExtraEpoch {
            id: 7, root: [1; 32], data_hash: [2; 32], budget: 3, claimed: 4, leaves: 5, published_at: 6, free_before: 8, closed: true,
            bump: 9, rent_payer: Pubkey::new_from_array([3; 32]), bitmap: [0xAB; 125],
        };
        let b = ser(&e);
        assert_eq!(b.len(), 275);
        assert_eq!(b[116], 1);
        assert_eq!(b[117], 9);
        assert_eq!(&b[118..150], &[3u8; 32]);
        assert_eq!(&b[150..275], &[0xABu8; 125]);

        let d = Duel {
            creator: Pubkey::default(), nonce: 0, stake: 0, commitment: [0; 32], opponent: Pubkey::default(), opponent_element: DUEL_ELEMENT_SEALED,
            creator_element: 0, state: DUEL_JOINED, deadline: 0, opponent_commitment: [5; 32], rent_payer: Pubkey::default(), bump: 0,
        };
        let b = ser(&d);
        assert_eq!(b.len(), 196);
        assert_eq!(&b[131..163], &[5u8; 32]);

        let bet = Bet {
            player_state: Pubkey::default(), owner: Pubkey::default(), rent_payer: Pubkey::default(), game: BET_KEEPER | BET_ANCHORED | GAME_VOIDRUSH,
            choice: 0, chance_bps: 0, stake: 0, payout: 0, seed: [4; 32], target_slot: 0x0500000F4240, nonce: 0, bump: 0,
        };
        let b = ser(&bet);
        assert_eq!(b.len(), 179);
        assert_eq!(b[104], 0xC2);
        assert_eq!(&b[130..162], &[4u8; 32]);
        assert_eq!(u64_at(&b, 162), 5_497_559_138_880);

        let s = OracleSeat {
            generation: 1, cold: Pubkey::default(), refund: Pubkey::default(), bond: 0, taken_at: 0, open_since: 0, priority: Pubkey::default(),
            priority_bond: 0, voids: 2, to_pool: 3, bump: 4,
        };
        let b = ser(&s);
        assert_eq!(b.len(), 157);
        assert_eq!(u32::from_le_bytes(b[144..148].try_into().unwrap()), 2);
        assert_eq!(u64_at(&b, 148), 3);
        assert_eq!(b[156], 4);

        let x = ExtraState {
            last_epoch: 0, last_publish_ts: 0, accounted: 0, reserved: 0, free_after: 0, live_forged_backing: 0, out_since_publish: 0,
            total_in: 0, total_paid: 0, total_returned: 1, vault_bump: 2, bump: 3,
        };
        let b = ser(&x);
        assert_eq!(b.len(), 90);
        assert_eq!(u64_at(&b, 80), 1);
        assert_eq!((b[88], b[89]), (2, 3));

        let l = Listing {
            asset: Pubkey::default(), seller: Pubkey::default(), reserved_buyer: Pubkey::default(), price: 5, created_at: 0, expires_at: 0, tier: 2, bump: 1,
        };
        let b = ser(&l);
        assert_eq!(b.len(), 130);
        assert_eq!(u64_at(&b, 104), 5);
        assert_eq!((b[128], b[129]), (2, 1));
    }

    /// Every account the live mainnet program holds (census of slot 87,867,236: Config, Epoch 1, its one ClaimReceipt,
    /// one PlayerState, plus three 8-B vaults and the IDL account) decodes with the upgraded layouts and re-encodes to the
    /// SAME bytes, and the spec 3.1 / Appendix C offsets read the live values. Recapture at S5 (tests/fixtures/golden).
    fn round_trip<T: AccountDeserialize + AccountSerialize>(live: &[u8]) -> T {
        let v = T::try_deserialize(&mut &live[..]).unwrap();
        let mut out = Vec::with_capacity(live.len());
        v.try_serialize(&mut out).unwrap();
        assert_eq!(out, live, "re-encoding changed the live bytes");
        v
    }

    #[test]
    fn live_accounts_round_trip() {
        let live = include_bytes!("../../../tests/fixtures/golden/config.bin");
        assert_eq!(live.len(), 458);
        let c: Config = round_trip(live);
        assert_eq!((c.version, c.bump), (2, 255));
        assert_eq!(c.architect, pubkey!("7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd"));
        assert_eq!(&live[74..106], c.architect.as_ref()); // LB-5: architect@74
        assert_eq!(c.oracle, pubkey!("J5CU45Didfq7ng9JHXyxYqN7TwAGjMgEyhUcrV7Aixba"));
        assert_eq!(c.bumps, [255, 255, 253, 254, 255]);
        assert_eq!(c.last_epoch, 1);
        assert_eq!(u64_at(live, 111), 1);
        assert_eq!(c.reward_reserved, 43_151_041); // epoch 1's sealed-and-lost drop reserve (Appendix C)
        assert_eq!(c.artifact_price, [0; 4]); // 0 = never forged: Lunar decays from PRICE_LAUNCH_TS (6.1)
        assert!(c.airdrop_root_set);
        assert_eq!(c.stats.forge_paid, 388_359_377);

        let live = include_bytes!("../../../tests/fixtures/golden/epoch-1.bin");
        assert_eq!(live.len(), 207);
        let e: Epoch = round_trip(live);
        assert_eq!(e.id, 1);
        assert_eq!(e.budget + e.drop_reserve, 431_510_418); // Appendix C budget, reserve 43,151,041
        assert_eq!(e.drop_reserve, 43_151_041);
        assert_eq!(u64_at(live, 145), 43_151_041);
        assert_eq!((e.claimed, e.claims, e.leaves), (e.budget, 1, 1)); // one leaf, fully claimed
        assert_eq!(e.drop_state, DROP_SEALED);
        assert!(!e.closed);
        assert_eq!(i64_at(live, 128), 1_792_287_484);
        assert_eq!(e.published_at, c.last_publish_ts);

        let live = include_bytes!("../../../tests/fixtures/golden/claim-receipt.bin");
        assert_eq!(live.len(), 90);
        let r: ClaimReceipt = round_trip(live);
        assert_eq!((r.epoch, r.amount), (1, e.claimed));
        assert_eq!(r.rent_payer, c.oracle);

        let live = include_bytes!("../../../tests/fixtures/golden/player-state.bin");
        assert_eq!(live.len(), 129);
        let p: PlayerState = round_trip(live);
        assert_eq!(p.owner, r.player);
        assert_eq!(p.chips, 0);
    }
}
