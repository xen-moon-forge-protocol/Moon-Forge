//! SPEC-UPGRADE-v2 Appendix A: the on-chain functions give exactly the values the clients compute.
//! tests/spec-vectors-v2.cjs computes every vector in plain JS (keccak-256 from @noble/hashes, BigInt arithmetic, no Rust)
//! and writes tests/fixtures/spec-vectors-v2.out.json; this test reads that file at compile time. The base SPEC's
//! duel / war commitments, decks, clock words and the `random_u64` pin stay in `wars::war_tests::vectors_match_the_clients`
//! and `utils::rng_tests`.

use crate::constants::*;
use crate::instructions::artifacts::{current_price, next_price};
use crate::instructions::extra::extra_leaf;
use crate::state::{Config, Stats};
use crate::utils::{bet_pack, bet_unpack, keccak, market_split, random_u64};
use anchor_lang::prelude::Pubkey;

const VECTORS: &str = include_str!("../../../tests/fixtures/spec-vectors-v2.out.json");

fn v(key: &str) -> &'static str {
    let pat = format!("\"{key}\": \"");
    let line = VECTORS.lines().find(|l| l.trim_start().starts_with(&pat)).unwrap_or_else(|| panic!("vector {key} missing"));
    let rest = &line.trim_start()[pat.len()..];
    &rest[..rest.find('"').unwrap()]
}
fn n(key: &str) -> u64 {
    v(key).parse().unwrap()
}
fn list(key: &str) -> Vec<u64> {
    v(key).split(',').map(|x| x.parse().unwrap()).collect()
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn config(price: [u64; 4], ts: [i64; 4], alive: [u16; 4]) -> Config {
    Config {
        version: 2, bump: 0, oracle: Pubkey::default(), pending_oracle: Pubkey::default(), architect: Pubkey::default(),
        bumps: [0; 5], last_epoch: 0, last_publish_ts: 0, reward_reserved: 0, bankroll_reserved: 0, house_total_shares: 0,
        house_protocol_shares: 0, jackpot_round: 0, draw_round: 0, artifacts_alive: alive, artifacts_minted: [0; 4],
        airdrop_root: [0; 32], airdrop_root_set: false, airdrop_claimed: 0, artifact_price: price, artifact_price_ts: ts,
        bankroll_day: 0, bankroll_day_start: 0, stats: Stats::default(),
    }
}

/// Mainnet constants only (the JS file uses the mainnet PRICE_LAUNCH_TS and day lengths).
#[cfg(not(feature = "localnet"))]
#[test]
fn vectors_match_the_clients() {
    const DAY: i64 = 86_400;
    assert_eq!(PRICE_DECAY_PERIOD[0], DAY);
    // keeper chain: seed 0x0a×32, length 8; x_8 = seed, x_k = keccak(x_{k+1}), x_0 = the armed tip
    let mut chain = vec![[0x0au8; 32]];
    for _ in 0..8 {
        let next = keccak(&[&chain[0]]);
        chain.insert(0, next);
    }
    for (i, x) in chain.iter().enumerate() {
        assert_eq!(hex(x), v(&format!("keeper_chain_x{i}")), "x_{i}");
    }
    for i in 0..8 {
        assert!(crate::instructions::keeper::chain_next_ok(&chain[i], &chain[i + 1]));
    }
    // anchor_bet mixing (keeper.rs) and the v2 roll (settle_bet_v2: random_u64(reveal, bet, mixed) % BPS)
    let mixed = keccak(&[b"MOONFORGE_ANCHOR", &[0x08; 32], &[0x07; 32]]);
    assert_eq!(hex(&mixed), v("anchor_mixed_seed"));
    assert_eq!(random_u64(&chain[1], &[0x07; 32], &mixed) % BPS, n("v2_roll_reveal_x1_bet_07"));
    // packed keeper position + anchor slot
    assert_eq!(bet_pack(5, 1_000_000), n("bet_pack_5_1000000"));
    assert_eq!(bet_unpack(n("bet_pack_5_1000000")), (5, 1_000_000));
    // extra-pot leaf
    let leaf = extra_leaf(7, 3, &Pubkey::new_from_array([2; 32]), 123_456_789);
    assert_eq!(hex(&leaf), v("extra_leaf_e7_i3_w02_a123456789"));
    // market split of a 10 XNT sale
    let (r, p, s) = market_split(10 * XNT).unwrap();
    assert_eq!(vec![r, p, s], list("market_split_10xnt"));
    // PX (mainnet constants: PRICE_LAUNCH_TS 1,795,564,800, periods 1/3/7/14 days)
    let never = config([0; 4], [0; 4], [0; 4]);
    assert_eq!(current_price(&never, 0, PRICE_LAUNCH_TS), n("px_lunar_never_forged_at_launch"));
    assert_eq!(current_price(&never, 0, PRICE_LAUNCH_TS + DAY), n("px_lunar_never_forged_plus_1d"));
    assert_eq!(current_price(&never, 0, PRICE_LAUNCH_TS + 177 * DAY), n("px_lunar_never_forged_plus_177d"));
    assert_eq!(next_price(next_price(ARTIFACT_PRICE[1], 1), 1), n("px_cosmic_after_2_forges"));
    let walk = config([100 * XNT, 0, 0, 0], [1_000, 0, 0, 0], [0; 4]);
    assert_eq!(current_price(&walk, 0, 1_000 + 177 * DAY), n("px_lunar_from_100xnt_177_periods"));
    assert_eq!(current_price(&walk, 0, 1_000 + 178 * DAY), n("px_lunar_from_100xnt_178_periods"));
    let full = config([ARTIFACT_PRICE[0], 0, 0, 0], [1_000, 0, 0, 0], ARTIFACT_SUPPLY);
    assert_eq!(current_price(&full, 0, 1_000 + 400 * DAY), n("px_full_tier_never_decays"));
    let caps: Vec<u64> = (0..4).map(|t| next_price(ARTIFACT_PRICE[t] * MAX_PRICE_MULTIPLE, t)).collect();
    assert_eq!(caps, list("px_next_price_cap"));
    // steps from the 10× cap to the minimum, walked by current_price itself; PRICE_MAX_STEPS covers the largest
    let steps = list("px_steps_cap_to_min");
    for t in 0..4 {
        let min = ARTIFACT_PRICE[t] * MIN_PRICE_BPS[t] / BPS;
        let mut price = [0u64; 4];
        price[t] = ARTIFACT_PRICE[t] * MAX_PRICE_MULTIPLE;
        let c = config(price, [1_000; 4], [0; 4]);
        let at = |k: u64| current_price(&c, t, 1_000 + k as i64 * PRICE_DECAY_PERIOD[t]);
        assert_eq!(at(steps[t]), min, "tier {t}");
        assert!(at(steps[t] - 1) > min, "tier {t}");
        assert!(steps[t] <= PRICE_MAX_STEPS);
    }
}
