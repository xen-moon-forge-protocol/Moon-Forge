# Worked examples (v2 math)

Assumptions for the examples: XNT = $0.20, K = 1.25, free reward pool = 50,000 XNT → the epoch budget can be at most 5,000 XNT (10%).
"Value" below is the liquidity-adjusted value of a burn (XEN × burn-hour price of that chain's XEN × L/(L+V)); "score" = value × tier multiplier × (1 + boost).
Without boosts, `rate_cap` = 1.25 × (1 / 0.20) XNT per USD = **6.25 XNT per $1 of score**. With boosts the oracle scales it by base_score / total_score (base_score = score without boosts), so boosts never raise the budget.
Forge Drop reserve = 10% of the budget, capped at 100 XNT; it is part of the budget. Each leaf receives `score / total_score` of the remaining XNT budget, and has an expected drop value of `score / total_score × reserve`.

## 1. A quiet week: the rate cap binds

| Burner | Burn | Value | Tier | Score ($) |
|---|---|---|---|---|
| A | 1 T BSC-XEN | ~$96 | Launchpad 1× | 96 |
| B | 10 B ETH-XEN | ~$60 | Moon Landing 3× | 180 |
| C | 5 T Polygon-XEN | ~$145 | Orbit 2× | 290 |

Total score 566 → `total × rate_cap` = 3,537.5 XNT < 5,000 → **budget = 3,537.5 XNT** (the other 1,462.5 stay in the pool). Drop reserve = min(10% × 3,537.5, 100) = **100 XNT**, so 3,437.5 XNT are paid as XNT shares.

| Burner | Share | XNT | Expected drop value | Total |
|---|---|---|---|---|
| A | 16.96% | 583.04, instantly | 16.96 → always wins (≥ 5 XNT): a Lunar Dust with a 16.96 XNT floor | 600 XNT ($120 for $96 = 1.25×) |
| B | 31.80% | 1,093.20, vesting over 180 days | 31.80 → always wins | 1,125 XNT (3.75× of $60) |
| C | 51.24% | 1,761.26, vesting over 45 days | 51.24 → always wins | 1,812.5 XNT (2.5× of $145) |

A burner whose expected drop value is below 5 XNT instead wins a 5 XNT-floor Lunar Dust with probability (value ÷ 5 XNT) — same expected value, more variance.

Selling instead (routes as of 2026-10-07): reaching XNT from ~$96 of BSC-XEN would mean selling it on a side-chain DEX, bridging to Solana, crossing the Warp USDC corridor (~$1 fee) and buying through a ~$10k XNT pool — roughly 40–90% of spot after fees and slippage.

## 2. A busy week: the 10% budget binds

Total score $10,000 (no boosts) → `total × rate_cap` = 62,500 XNT > 5,000 → **budget = 5,000 XNT**. Drop reserve = min(500, 100) = 100 XNT, so every burner gets 0.49 XNT per $1 of score in XNT plus 0.01 XNT per $1 as expected drop value — 0.5 XNT per $1 in total, the same rate for everyone. The free pool keeps the other 45,000 XNT.

## 3. Splitting wallets does nothing

A burns $1,000 from one wallet or $10 from 100 wallets: the total score is $1,000 either way (linear), and so is the total expected drop value. Under the square-root formula of an earlier design, the split version scored 10× more.

## 4. Ejecting early (Moon Landing, 3,000 XNT allocated)

Vesting starts when the leaf is claimed. After 36 days (20% vested): vested 600, unvested 2,400 → penalty 75% × 2,400 = 1,800 back to the pool → you receive 600 + 600 = **1,200 XNT** (and 1,200 chips — chips are earned only on XNT actually received, never on the penalty). Ejecting on day 0 pays 750 XNT: 0.75× of the 1,000 XNT a Launchpad burn would have received (up to ~0.975× counting the Forge Drop the leaf keeps), always below Launchpad, so the tier choice is honest.

## 5. Artifact boost (shifts shares, never the total)

B holds a Solar Core (+20%) at both the previous and the current epoch snapshot: score 180 × 1.2 = 216. Total score becomes 602, but `rate_cap` is scaled by 566 / 602, so the **budget stays 3,537.5 XNT**. B's share rises from 31.80% to 35.88%:

| Burner | Share | XNT | Expected drop value | Total |
|---|---|---|---|---|
| A | 15.95% | 548.17 | 15.95 | 564.12 XNT (was 600) |
| B | 35.88% | 1,233.39 | 35.88 | 1,269.27 XNT (was 1,125) |
| C | 48.17% | 1,655.94 | 48.17 | 1,704.11 XNT (was 1,812.5) |

B gains 144.27 XNT-equivalent, taken from A and C. If B were the only burner, the boost would change nothing: 1,125 XNT either way. A Solar Core bought at its 60 XNT base price paid 24 XNT to the reward pool when forged and keeps a 30 XNT floor (half of what was paid), refundable at any time by recycling it.

## 6. House game

A 10 XNT coin flip: 0.10 → reward pool, 0.05 → architect, 9.85 → bankroll. Win: 19.60 XNT credited to the player's game balance (net +9.60). The site settles the bet immediately; a bet not settled within ~3 minutes counts as lost. With a 4,000 XNT free bankroll the largest accepted net win is 10 XNT (0.25%); new bets are refused if all unsettled payouts would exceed 20% of the bankroll, or for the rest of the UTC day once the bankroll has lost 10% since the day began.
