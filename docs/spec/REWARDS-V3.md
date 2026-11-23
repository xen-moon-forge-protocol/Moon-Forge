# Rewards v3: the oracle rules

**Status.** Applies to every burn not paid in the epoch published by transaction `4XyLDEHiP4upPW7SEiMCDQrNrRjHGAiPjw6cKv7wN4we9uFGrByEmXtDGto5edJniVT16rQ8SprwXQRVNVCWSDrY` (epoch 1, the last epoch under the v2 rules, published at 2026-10-18 01:38 UTC). These burns are paid in the first v3 epoch (the first file with `"version": 3`), published on or after 2026-11-29, and only by the upgraded program: the final program upgrade, announced for 2026-11-25 ([UPGRADE-2026-11.md](../UPGRADE-2026-11.md)). If the upgrade comes later, so does that epoch, and the burns keep their time. Every program rule cited below (the 48-hour hold, the keeper-tip minimum, the extra pot, no drop reserve) is a rule of that upgraded program, the only one that publishes v3 epochs. Epoch files of version 2 keep verifying forever under the v2 rules; versions never go backwards.

**Source of truth.** The code that builds and verifies the files: `oracle/src/rewards.ts` (base pot), `oracle/src/extra.ts` (extra pot) and `oracle/src/flow-v3.ts` (the plumbing between the chains and the engine), at commit `65c6d61`. This document restates that code in words and formulas. If the two ever differ, the published files and the code that verifies them decide, and the difference is handled as an erratum ([POLICY-CHANGES.md](../../POLICY-CHANGES.md#errata)). Code comments carry short tags (A1, A8, A13.2 …); they are the design-change labels the code was written under and are cited below only to help find the place in the code.

**What the program enforces and what is oracle policy.** The upgraded X1 program enforces the outer bounds: an epoch budget plus the oracle's operating allowance of at most 10% of the free reward pool (claim tips are paid on top from the free pool, section 8), at least 6 days between epochs, a 48-hour hold before any claim, claims that can never exceed the epoch budget, the extra pot's own bounds, and the vesting and eject rules. Everything else in this document (prices, the curve, capacity, the order of burns, the extra-pot formula) is **oracle policy**: off-chain, public, recomputable by anyone, and changeable only by a versioned change announced at least two epochs ahead ([POLICY-CHANGES.md](../../POLICY-CHANGES.md)). It is calculated under the oracle policy and paid only if the oracle publishes; it is not enforced by the program.

---

## 1. Units and notation

- Amounts of XNT are integers in lamports (1 XNT = 10^9 lamports). Amounts of US dollars are integers in µUSD (1 USD = 10^6 µUSD). Prices are USD × 10^18 per token ("E18").
- `⌊x⌋` is the floor. Every division in the engine floors once, at the place written below.
- All instants are Unix seconds on the X1 clock unless stated otherwise.
- Constants are listed in section 15 with their names in the code.

## 2. The window

| Item | Rule | Code |
|---|---|---|
| Start | `window.startTs` = the on-chain `published_at` of epoch n−1 (read from its `EpochPublished` transaction and Epoch account) | `computeEpochV3`, `assembleInputsV3` |
| End | `window.endTs` = the X1 block time of the snapshot slot (the context slot of the finalized Artifact record list). A slot with no block time is re-read at another finalized slot; the runner's clock is never used | `snapshotWindowEnd` |
| Minimum length | `MIN_WINDOW` = 6 days − 6 hours. A shorter window is never built for publication; a dry run prints it labelled `provisional` and nothing can publish such a file | `publishableError`, `provisionalError` |
| Build-time clock | `createdAt` (the runner's clock, ISO-8601 UTC) must be within `CLOCK_SKEW_MAX` = 1 hour of `endTs` | `computeEpochV3` |
| Late burns | a burn stamped more than 1 hour after `endTs` on its own chain's clock makes that chain's read invalid (the chain is skipped this week, section 11) | `checkBurn` |
| Days | a burn's tranche day is `max(0, ⌊(timestamp − startTs) / 86,400⌋)`: whole days since the previous publication, never since the build | `dayOf` |

The previous publication is the anchor: the daily tranches of section 6 are known as soon as epoch n−1 is published, and a late publication only moves the next window's start; it never blocks the next epoch.

## 3. Inputs

For each epoch the oracle reads, in this order: the Artifact snapshot and its slot (the window end); epoch n−1's publication (`startTs` and `F_ref`); every configured chain on its own; the free reward pool at one finalized read; the XNT build price. The chains are read independently: a chain whose RPC, portal counter, head or XEN market fails is **skipped** for the week with its block cursor kept (section 11). Everything read is recorded in the epoch file.

## 4. Valuation of a burn

Each burn is valued on its own chain's XEN market, at its own hour, then converted to XNT at its own XNT price.

**4.1 XEN price.** For burn i on chain c, with `median` = the median of the 24 closed hourly closes before the burn's hour and `last` = the last closed hourly close before it, on the chain's price pool:

```
cap_c   = 1.25 × ref_c
price_i = min(median, last, cap_c)                 when candles exist   (rule "median", "last" or "cap")
price_i = min(spot_c, cap_c)                       when no candles exist (rule "spot", source "fallback")
ref_c   = median of the chain's reference values of the last (up to) 4 epochs;
          the aggregator token price while the chain has no history
spot_i  = amount × price_i                          (µUSD)
```

`spot_c` is the chain's build-time spot. A chain whose burn has no price at all (no candles and a spot of 0) is skipped for the week, never valued at 0 (`NoXenPriceError`). The reference recorded for the next epochs is `min(spot_c, cap_c)`.

**4.2 The per-chain curve with memory.** A thin market cannot absorb much XEN, and a burn should not count for more than the market could pay. For each chain, with `L` its liquidity and `S` its curve state:

```
f(x)            = L·x / (L + x)                         what a market of depth L pays for x of spot value
value_i         = ⌊ L² · spot_i / ((L + S)(L + S + V)) ⌋   for the burns of one (chain, hour) group,
                                                        V = Σ spot of that group
S after a group = S + V
S between hours = S × 2^(−h/336)                        half-life 14 days (336 hours)
```

- Burns on the **same chain in the same hour** share that hour's pot pro rata: a later burn in that hour lowers the value of the earlier ones. That is one reason a quote is only an upper bound ("at most") until the epoch is built. The others: the chain's price pool (4.1) is read again at the build, and a lower reading there lowers every burn of the week on that chain (without candles a burn is priced at the build spot, 4.1); and an earlier burn the site had not seen when it quoted (on another chain, or a skipped chain's backlog, section 11) takes capacity first (section 7). `L` is not one of them: it is fixed for the whole week (below).
- A large burn raises `S`, so later burns on that chain count for less while `S` decays (half after 14 days), so a large burn still lowers what later burns on that chain count for a month later. Splitting a burn across wallets or transactions in the same hour gives the same total; splitting it over hours gives each piece the curve as it stands.
- `L` is fixed for the whole week at epoch n−1's build (that file's `L.next`), so the quote uses the same `L` from the week's first hour, and nothing read at this week's build changes it. Each build computes the next week's `L` from this week's hourly readings (a reading is the lower of GeckoTerminal's and the on-chain XEN-side USD depth of the chain's eligible pools): `stat` = the minimum, over the last 7 days counted back from the window end, of each day's median reading (full days only, at least 4 recorded samples, when there is one; the build's own reading only when no sample is recorded at all); then `L_next = max(50% × L, min(stat, 1.1 × L + $50))`, so the next week's `L` can fall at most 50% and rise at most 10% + $50 per week; the additive $50 lets a chain recover from a low or zero reading. A chain with no `L` yet takes `min(stat, $500 + $50 per whole day of its price pool's age, at most 90 days)`. A valued chain whose hourly samples are missing or thin (fewer than 4 recorded samples on more than 2 of the 7 days, or none at all) carries its `L` (`L_next = L`), and the anomaly gate holds that epoch (section 10). The switch window is valued at the median of the chain's last (up to) 4 v2 liquidity readings. Without a market (`L = 0`) a burn's value is 0 and the chain never blocks the others (`liquidityRuleV3`, `nextLiquidityV3`, `liquidityStatOfV3`, `liquidityCarriedV3`, `firstLiquidityCapV3`).
- The decay factor is computed by square-and-multiply over the bits of h from the most significant one, flooring after every product (`decayFactor`); an independent verifier must use exactly that order.

**4.3 The XNT price of a burn.** With the same closed-candle rule on the XNT/USDC.X pool (1 USDC.X = $1):

```
x_i = max(median, last, 0.6 × x_prev)        when candles exist
x_i = max(build price, 0.6 × x_prev)          when none exist (build price = max(XDEX TWAP, API price))
x_prev = the previous epoch's XNT reference = the value-weighted median of its burns' 24-hour XNT medians
```

So a burn is converted at the XNT price of its hour: the higher of its 24-hour median and its last hourly close, never below 60% of the previous epoch's XNT reference. When USDC.X reads more than 3% above $1 (x1report's USD price against the pool's TWAP), every XNT reading of the pool is raised by that factor, so a USDC.X premium never pays anyone more XNT; a reading more than 3% below $1 needs nothing (`xntPegV3`); either reading trips the anomaly gate (section 10). Taking the higher XNT reading means a pumped XNT candle cannot raise anyone's XNT amount. The floor `0.6 × x_prev` protects the pool: **in an XNT crash of more than 40% within a week, burners are credited at the floor**, which gives fewer XNT than the market route.

## 5. Entitlement

```
base_i = value_i converted to lamports at x_i                 (lamportsOf: ⌊value × 10^21 / x⌋)
lp_i   = ⌊base_i × 12,500 / 10,000⌋                           the Launchpad layer, K = 1.25
ent_i  = ⌊base_i × 12,500 × m / 10,000⌋                       m = 1 (Launchpad), 2 (Orbit), 3 (Moon Landing)
band_i = ent_i − lp_i                                         the vesting band (0 for Launchpad)
```

The amount in XNT is fixed by the burn's own prices; nothing that happens to the XNT price after the burn changes it. A vesting mission locks its XNT and vests it on-chain over 45 days (Orbit) or 180 days (Moon Landing) from its claim; an early eject sends 60% (Orbit) or 75% (Moon Landing) of the unvested part to the reward pool (program rule).

## 6. Capacity

```
F_ref    = the free reward pool right after epoch n−1 was published
           (EpochPublished.free_pool_before − budget), fixed for the whole week
C        = min(⌊F_ref × 800 / 10,000⌋, 7 × ⌊R × 200 / 10,000⌋)   the week's cash capacity: 8% of F_ref, and a day's
           slice at most 2% of R, the XDEX pool's XNT reserve read at epoch n−1's build (that build's own
           cap reserve when it read none; the switch window has no such cap)
τ        = ⌊C / 7⌋                                          the daily release; the first (C mod 7) days release τ + 1 lamport
cap(d)   = cumulative release after day d = τ × (d + 1) + min(d + 1, C mod 7)    for d = 0 … 6
cap(d)   = C                                                for d ≥ 7 (a longer window: the whole C is open)
```

- Capacity opens in **daily tranches**, counted from the previous publication (not from UTC midnight). Unused capacity of a day rolls forward to the next days of the same week; nothing carries over to the next week.
- A week in which nothing is published does not add capacity: the next window is longer, its capacity is still one C, and after day 6 all of it is open first come first served.
- Inflows during the week (forges, game edges, market fees, donations, penalties) raise the **next** week's `F_ref`, never this week's C.
- The program's 10% bound stays the outer cap (section 8). The XDEX cap (`trancheCapV3`, the rules block's `priceRules.xntTranche`) keeps a day's slice at most 2% of the XDEX pool's XNT reserve read at the previous build (at most 7 × 2% a week).
- **Scale (dated).** On 2026-11-02 the reward pool held about 6.5 XNT, so a whole week could pay all burners together at most about 0.5 XNT (about 0.07 XNT a day). The site shows the live numbers before you burn.

## 7. Allocation: first come, first served

**7.1 Order.** Burns are ordered by their timestamp, each on its own chain's clock. Burns stamped the same second are ordered by keccak256(txHash ‖ logIndex) (`globalOrder`; the `tieBreak` of the rules block), so no chain comes first by its id. Two kinds of burn rank after every other burn of the window: a skipped chain's backlog (section 11) and the burns of the operator's listed wallets (7.6).

**7.2 Arrival claims.** In that order, each burn claims at its arrival:

```
claim_i = min(want_i, max(0, cap(day_i) − Σ senior of the burns before it))
want_i  = lp_i              for Launchpad
want_i  = lp_i + band_i     for Orbit and Moon Landing
```

- **Launchpad:** it is paid `claim_i` (its `senior`).
- **A vesting burn that fits whole** (`claim_i = lp_i + band_i`) locks its whole mission at its multiplier.
- **A vesting burn that fits in part** locks exactly the piece its claim covers, at its full multiplier: `band₁ = ⌊claim × band / (lp + band)⌋`, `lp₁ = ⌈band₁ × lp / band⌉`; the locked piece `lp₁ + band₁` vests on its tier; the rest of its Launchpad layer (`lp − lp₁`) is a Launchpad piece, paid only from the leftover (7.3); the rest of the band is not paid (`lockPiece`).
- **Dust and conversion:** a vesting burn whose whole entitlement, or whose covered piece, is below 0.02 XNT (`VEST_MIN_ENT`) does not lock: it is paid as a Launchpad burn (`converted: true`). A vesting burn that arrives when the day's capacity is used up is converted too.
- A burn always consumes what it is paid at arrival, and nothing a later burn does changes an earlier burn's arrival outcome (with the same-chain-same-hour exception of 4.2). A later burn can use capacity that would otherwise have paid an earlier burn's unpaid part from the week's leftover (7.3).

**7.3 The leftover pass.** At the window's end, what the week's schedule left unused (`C − Σ senior`) pays the unmet Launchpad layers (Launchpad burns and the Launchpad pieces of split or converted missions), in the same order, until it runs out. No band is ever paid from the leftover. The leftover is never promised: it depends on the burns that come later in the week. What remains after the leftover pass stays in the reward pool (`capacity.left`).

**7.4 Leaves.** For each X1 wallet and tier the targets are summed: the locked pieces on their tier (1 or 2), every Launchpad part on tier 0. All burns of one X1 address in one tier and epoch are paid as one leaf.

**7.5 Artifacts never enter the base pot.** The Artifact snapshot is recorded in the base file for the extra pot and for the public; nothing in sections 4 to 9 reads it. A holder and a non-holder receive exactly the same base allocation for the same burn, and every leaf, root and capacity is the same whatever Artifacts exist and whoever holds them.

**7.6 Operator wallets.** The X1 wallets the operator controls are listed in the rules block (`operatorWallets`) before their first burn. Their burns are flagged in the file (`operator: true`) and rank after every other burn of the window, the backlog included, both at arrival (they claim only what the window's capacity still holds after all other burns, on the window's last day) and in the leftover pass. The one exception is the mainnet proof plan: its wallets are listed as a named exception with a start and an end time, published in [POLICY-CHANGES.md](../../POLICY-CHANGES.md#operator-policy) before the first of its burns; inside that window their burns rank like any other burn and carry the exception's name (`exception`).

## 8. The build limit and a shortfall

```
bound         = ⌊⌊F_build × 9,950 / 10,000⌋ × 1,000 / 10,000⌋        10% of the free pool at build, less a 0.5% drift margin
build limit   = bound − min(0.0523316 XNT, ⌊bound / 10⌋)              less the most publish_epoch can pay the oracle (its allowance)
planned outflow = Σ score + 0.002 XNT × (leaves of at least 0.2 XNT)
```

The 0.2 XNT is the program's tip minimum (`KEEPER_TIP_MIN_CLAIM`, mirrored in `rewards.ts`; section 12). The program's own 10% bound covers the epoch's budget plus the oracle's operating allowance (`forge.rs` `oracle_allowance`: the Epoch account's rent back plus a top-up of at most 0.05 XNT, never above what the bound leaves after the budget nor above a tenth of the bound); claim tips are paid on top from the free pool. Keeping the leaves, the tips and the largest allowance inside the 10% is the oracle's policy: this build limit (`buildLimit`, `oracleAllowanceMax`). Every claim is counted as if a third-party keeper submitted it, the most the program can pay out of the free pool for the epoch's claims; a tip set aside and not paid (a claim submitted by the player or the oracle) stays in the pool.

The planned outflow must fit in the build limit. Normally it fits with room to spare, because C is 8% of `F_ref` and the pool rarely falls during a week. If it does not fit (a **shortfall**), the claims are cut **literally from the latest one backwards**: the claims are booked in the order they are made (all arrival claims in the global order, then the leftover top-ups, which are made at the window's end); the first claim that does not fit takes the room left after a keeper tip is set aside for each leaf it can bring to the tip minimum (an arrival claim: its wallet's Launchpad leaf, and one tier leaf as soon as the claim is at least 0.02 XNT, counted whatever the burn's tier; a leftover top-up: the Launchpad leaf) (a mission locks the smaller piece that room covers, or converts when that piece would be dust); every later claim of the week is 0. So in a shortfall the leftover top-ups are cut first, then the latest arrival claims. C and the daily tranches stay as quoted, and no later burn can lower what an earlier burn is paid at its arrival. The record `capacity.shortfall = {stage, kept, wanted, claim, planned}` says where the cut fell (`fitClaim`, `limitGate`, `allocateBurns`).

## 9. Encoding and the on-chain budget

- Leaf `score` = its target in lamports; `rate_cap` = 1; `totalScore` = Σ score.
- The upgraded program writes no drop reserve for the epochs it publishes, so the on-chain budget is `min(10% of the free pool, totalScore)` = `totalScore` and every claim `⌊score × budget / totalScore⌋` is exactly its target.
- Leaf bytes: `keccak("MOONFORGE_V2_CLAIM" ‖ epoch u64 LE ‖ wallet 32 B ‖ tier u8 ‖ score u64 LE)`; the tree hashes sorted pairs, an odd node is promoted unchanged (`oracle/src/merkle.ts`, the same tree as v2).
- The data hash committed on-chain is the SHA-256 of the canonical JSON of the whole file (keys sorted) except `dataHash`, `proofs` and `publish` (`dataHashV3`).
- **Rules block.** Every v3 file records one hashed rules block (`rulesBlock`) inside the data hash: `programRules`, `programHash`, `rulesId`, `tipMin`, `autoClaimMin`, `dustRule`, `tieBreak`, `backlogRule`, `operatorWallets`, `priceRules` (the liquidity rule, the XDEX tranche cap, the USDC.X guard, the orphan rule, the XNT price-pool switch and the anomaly gate's thresholds). `npm run verify` rebuilds a file only under the block it records; a later rules change gets a new `rulesId` ([POLICY-CHANGES.md](../../POLICY-CHANGES.md), commitment 4).

## 10. Publication

- An epoch is built at the weekly run (scheduled for Sundays 00:00 UTC; GitHub's scheduler often starts it late) once the window is at least `MIN_WINDOW` long. A run is due only inside the 48 hours after a Sunday 00:00 UTC slot opens and when nothing was published since that slot (`epochDue`); a week with no run in that window publishes nothing, and its burns are paid in the next epoch with their own time. If no burn has value (`T = 0`), no paying epoch is published; the oracle publishes an empty base epoch instead (no leaves, nothing paid), which the upgraded program accepts and which keeps the oracle seat alive once it survives its hold.
- The file is written before `publish_epoch` is sent. Just before sending, the free pool is re-read: if it moved by more than 0.5% since the build, or the planned outflow no longer fits 10% of it, or the build and its snapshot are older than 6 hours (`MAX_PUBLISH_LAG`, the publish-age guard), the build is redone (at most three times) or nothing is published in that run. An unknown X1 clock fails closed (`rebuildReason`, `publishGateV3`).
- **Anomaly gate.** Before publishing, the oracle checks each built epoch against published thresholds (one wallet above 60% of the week's capacity; a leaf count above 5× or a total score above 3× the recent median; more than half the burns priced by a fallback; a chain's first epoch; a change of the XNT price source or a USDC.X depeg; a chain whose liquidity samples are missing). Any hit holds the publication up to 24 hours; then a fresh rebuild is published unless an operator sets `GATE_BLOCK`. An empty base epoch is never held. The thresholds are in the rules block (`priceRules.gate`) and the hold record is published (`anomalyGateV3`, `gateDecisionV3`).
- A v3 epoch is published only by the upgraded program (no drop reserve); the switch epoch is pinned in the code (`V3_FIRST_EPOCH`) only after the first v3 publication.
- After the publication the file records `publish = {tx, slot, budget, …, claims}`; this record is outside the data hash and is written by the publish run (the epoch-file format page, `docs/EPOCH-FILES.md`, is published with the first v3 epoch).
- **After a void.** The program does not free a voided epoch's number: the next epoch is n + 1. The oracle code at `65c6d61` builds it on the voided file as its previous file, so the voided epoch's cursors and mission ids count as already read and its burns are not paid in a later epoch; after an epoch published by a stolen key, whose file is not in the repository, the code cannot build the next epoch until it is fixed (residual 8). Paying a voided epoch's burns later needs a carry-forward rule, published under [POLICY-CHANGES.md](../../POLICY-CHANGES.md).
- **GitHub.** If the GitHub account falls, the site, the oracle, the keeper and the epoch files stop; payouts pause; the pools stay locked in the program; once the final upgrade is live and no epoch has survived its hold for 28 days, the largest voider can take the oracle seat from day 28 and anyone from day 29, with a bond ([SECURITY.md](../../SECURITY.md#what-depends-on-github), [UPGRADE-2026-11.md](../UPGRADE-2026-11.md#32-the-oracle-seat)).

## 11. Chains, cursors and backlog

- Each chain is read from the previous file's `toBlock` (or its configured start block the first time) to its final head, from one RPC whose own head was checked, with the portal's mission counter. Mission ids must run contiguously from the last id already paid; a gap, a duplicate, a short read or a counter below what was paid skips the chain (`missionContinuity`).
- A skipped chain is carried in the file with `skipped: true`, its cursor, liquidity and curve unchanged; its burns are read the next time it answers, from the same block. No block is skipped, none is read twice.
- **Orphaned chain (in force).** A chain with no eligible market for 4 epochs in a row (a failed read does not count) is orphaned, announced one epoch ahead in its record: its burns are then valued at 50% of its last reference price, its liquidity reading is 0, so its frozen `L` keeps halving each week; a chain valued on a market again ends the orphaning (`ORPHAN_SKIPS`, `ORPHAN_PRICE_BPS`).
- **Backlog order:** a skipped chain's burns keep their own timestamps for their prices and the curve, but in the next epoch they rank after every burn of the current window at arrival and first in the leftover pass (7.3); the file flags them `backlog: true` (the `backlogRule` of the rules block). From the first v3 epoch on, the site and the kit show, before you burn, which chains were skipped in the latest epoch (a v2 build has no skipped chain: one failed chain stopped the whole build).

## 12. Claims and the dust rule

- **48-hour hold (rule of the upgraded program).** No claim of an epoch is accepted before 48 hours after its publication; during that window anyone can check the file, and a wrong epoch can be voided under the program's bonded rules ([UPGRADE-2026-11.md](../UPGRADE-2026-11.md#32-the-oracle-seat)).
- **Every leaf is claimed for its burner.** The publish run submits no claim inside the hold; it records when the hold ends (`claims.heldUntil`). After the hold, the keeper (and a publish run that only happens after the hold) submits the claim of every leaf, dust included, paying the network fee and the receipt rent itself; the burner never has to act on X1. The publish record counts the leaves whose claim pays a keeper tip when a third-party keeper submits it (at least 0.2 XNT, `claims.tipped`; `keeperTipDue`) and the others (`claims.dust`); only a publish run that submits the claims itself adds how many were claimed and how many failed. Claims made later by the keeper are not written back into the file: each one is visible on X1 (its claim receipt, or the mission account of a vesting leaf) (`claimPlanV3`, `publishRecordV3`; `index.ts`, `keeper-v3.ts`). Payouts depend on that GitHub-run oracle and keeper (section 10, "GitHub").
- **Keeper tips (rule of the upgraded program; the program before it tips from 0.02 XNT).** A claim of at least 0.2 XNT submitted by someone other than the player or the oracle pays that submitter a tip of 0.002 XNT from the reward pool; smaller claims carry no tip. Anyone can claim their own leaf at any time in the 90-day window (receipt rent refunded after the epoch closes).
- A payout to a brand-new X1 wallet smaller than the rent-exempt minimum is credited to that wallet's game balance instead (program rule).
- After 90 days an epoch can be expired by anyone; its unclaimed budget returns to the reward pool.

## 13. The extra pot (Artifact Burn Rebate)

The extra pot is a separate program vault, created by the final upgrade and funded **only** by 25% of every forge of origin FORGED, its own unclaimed leaves and its own unpaid releases. It never receives game edges, rakes, royalties, market fees, donations, orphan floors or base-pot money, and it never pays the base pot. It pays forged Artifacts a weekly rebate tied to their holder's burns; it is calculated under the oracle policy, it can be small or zero, and it can stop.

One extra file per published base epoch, `extra-n.json`, built right after base file n (`computeExtraEpoch`):

```
S(n)        = every live Artifact (Core owner + ArtifactRecord) at the first X1 slot with block time ≥ base window end
eligible e  = origin FORGED and forged after the upgrade (after the extra pot's creation, init_extra; an Artifact
              forged before it is excluded, "pre-upgrade"), alive in S(n−1) and S(n) with the same owner w, forged
              less than 52 weeks before the base window start. Genesis and Drop Artifacts (price 0) are never eligible; an Artifact bought, received or
              forged during the week counts from the next week; the first extra epoch has no S(n−1) and pays nothing
need_e      = ⌊2 × backing_e × 100 / 10,000⌋                1% of the price paid per week (price paid = 2 × floor)
              (Lunar Dust 0.10, Cosmic Shard 0.25, Solar Core 0.60, Void Anomaly 2.00 XNT at base prices)
need_w      = k × Σ need_e over w's eligible Artifacts         k = the 7-day weeks of the base window, 1 ≤ k ≤ 13
use_w       = Σ over w's burns in base file n of ⌊base_b × (lp_b − basePaid_b) / lp_b⌋
              (the part of the burn's Launchpad layer the base pot did NOT pay; band, vesting and tier ignored)
counted_w   = min(use_w, need_w);  W = Σ counted_w
R           = ⌊X × 800 / 10,000⌋   X = the extra pot's free balance after the previous extra publication
B           = min(R, ⌊W × 20,000 / 10,000⌋, k × ⌊Σ backing(eligible) × 400 / 10,000⌋);  B = 0 when W = 0
pay_w       = ⌊counted_w × B / W⌋, and 0 when below 0.001 XNT
```

- The rate `B / W` is at most 2 and is the same for every tier and every wallet. A wallet only receives a rebate in a week in which it burned XEN that the base pot did not fully pay (for example after the day's capacity was used up).
- Each week's total is at most 8% of the extra pot's free balance, so the pot shrinks if no new Artifacts are forged. What is not paid stays in the extra pot.
- Leaf bytes: `keccak("MOONFORGE_V3_EXTRA" ‖ epoch u64 LE ‖ index u32 LE ‖ wallet 32 B ‖ amount u64 LE)`, leaves sorted by wallet, the same sorted-pair tree; an epoch with nothing to pay has the all-zero root.
- Heartbeat: an extra epoch is published for every published base epoch, with budget 0 when nothing is paid. A week whose extra file cannot be built is published as a **skip heartbeat** (budget 0, empty snapshot, the reason recorded); the history continues from it.
- Program bounds on `publish_extra_epoch`: total ≤ 8% of the extra pot's free balance and ≤ weeks × 4% of the live backing of Artifacts forged after the upgrade; at most 1,000 leaves; at least 6 days since the previous paying extra epoch. Claims: after the same 48-hour hold, within 90 days, no keeper tip, anyone may submit and the XNT always goes to the wallet in the leaf. After 90 days the unclaimed part returns to the extra pot.

## 14. The switch from v2

- The first v3 epoch builds on the last v2 file: each chain's cursor, liquidity reading and a curve state rebuilt from the v2 file's burns; the XNT reference from the v2 file; each chain's last (up to) 4 v2 price readings as its reference history (`switchRefs`, recorded in the first v3 file only).
- Its window starts at the last v2 epoch's `published_at`, so the burns made after that publication (and any burn made after the v2 build's cursors, a few minutes before it) are paid under v3.
- A v2 file is never rebuilt or re-verified under v3 rules; a v3 history can only start at the pinned switch epoch, and a v2 file can never follow a v3 file.

## 15. Constants

| Name in the code | Value | Kind |
|---|---|---|
| `PLAN_BPS` | 800 (C = 8% of F_ref) | oracle policy |
| `EPOCH_DAYS` | 7 | oracle policy |
| `K_BPS` | 12,500 (K = 1.25) | oracle policy |
| `TIER_MULTIPLIER` | 1 / 2 / 3 | oracle policy |
| `PRICE_CAP_BPS` | 12,500 (cap = 1.25 × reference) | oracle policy |
| `HALF_LIFE_HOURS`, `DECAY_Q` | 336; 2^(−1/336) floored in 10^18 fixed point | oracle policy |
| `L_GROWTH_BPS`, `L_STEP_MICRO` | 11,000 (×1.1); $50 | oracle policy |
| `L_DROP_BPS`, `L_STAT_DAYS`, `L_MIN_SAMPLES_PER_DAY`, `L_MAX_THIN_DAYS` | 5,000 (the next L at least 50% of L); 7; 4; 2 | oracle policy |
| `L_FIRST_BASE_MICRO`, `L_FIRST_PER_DAY_MICRO`, `L_FIRST_MAX_DAYS` | $500; $50; 90 | oracle policy |
| `XDEX_TRANCHE_BPS` | 200 (a day's slice at most 2% of the XDEX XNT reserve) | oracle policy |
| `PEG_GUARD_BPS` | 300 (USDC.X more than 3% from $1) | oracle policy |
| `ORPHAN_SKIPS`, `ORPHAN_PRICE_BPS` | 4; 5,000 (50% of the reference) | oracle policy |
| `GATE_WALLET_SHARE_BPS`, `GATE_LEAF_COUNT_X`, `GATE_SCORE_X`, `GATE_FALLBACK_SHARE_BPS`, `GATE_HISTORY_EPOCHS`, `GATE_HOLD_SECONDS` | 6,000; 5; 3; 5,000; 4; 24 h | oracle policy |
| `XNT_FLOOR_BPS` | 6,000 (0.6 × previous reference) | oracle policy |
| `VEST_MIN_ENT` | 0.02 XNT (10 × `KEEPER_TIP`), a constant of its own, not tied to the tip minimum | oracle policy: the dust rule of 7.2 |
| `REBUILD_DRIFT_BPS` | 50 (0.5%) | oracle policy |
| `MAX_PUBLISH_LAG`, `CLOCK_SKEW_MAX` | 6 h; 1 h | oracle policy |
| `NEED_BPS`, `RHO_MAX_BPS`, `MIN_PAY`, `SEASON_WEEKS` | 100 (1%/week); 20,000 (2×); 0.001 XNT; 52 | oracle policy (extra pot) |
| `EPOCH_BUDGET_BPS` | 1,000 (10% of the free pool) | program |
| `MIN_EPOCH_INTERVAL` | 6 days | program |
| `ORACLE_TOPUP_TARGET`, `ORACLE_TOPUP_MAX`, `ORACLE_ALLOWANCE_BOUND_BPS` | 0.25 XNT; 0.05 XNT; 1,000 (a tenth of the 10% bound) | program (mirrored in `rewards.ts`: section 8 plans with it) |
| `CLAIM_HOLD`, `CLAIM_WINDOW` | 48 hours (new with the final upgrade); 90 days | program |
| `KEEPER_TIP`, `KEEPER_TIP_MIN_CLAIM` | 0.002 XNT; 0.2 XNT (0.02 XNT before the final upgrade) | program (mirrored in `rewards.ts`: section 8 plans with it) |
| `TIER_DURATION`, `TIER_PENALTY_BPS` | 0 / 45 / 180 days; 0 / 60% / 75% of the unvested part | program |
| `EXTRA_RELEASE_BPS`, `EXTRA_BACKING_BOUND_BPS`, `EXTRA_MAX_LEAVES`, `EXTRA_MAX_WEEKS` | 800; 400; 1,000; 13 | program (new with the final upgrade) |

## 16. Properties, and what they do not cover

Properties tested by `oracle/test/rewards.test.ts`, `oracle/test/fairness.test.ts` (500 random worlds), `oracle/test/extra.test.ts` and `oracle/test/flow.test.ts`:

- **The pool never breaks (I1):** Σ score + keeper tips + the largest oracle allowance ≤ 10% of the free pool at build less 0.5%; across the 500 worlds the planned outflow stayed at or below 9.950% of the free pool.
- **First come, first served (I2, prefix-stability):** what a burn is paid at its arrival depends only on the burns before it, C and the build limit, in shortfall weeks too, for every prefix that ends at a chain-hour boundary.
- **No later burn lowers an earlier one, whatever its tier (I7, A9 late burn),** except inside the same chain-hour (4.2).
- **Every claim is exactly its target (I9)** on the upgraded program.
- **Nothing locks below its multiplier (I10);** a mission split into several transactions sized to the capacity locks the same as the whole mission.
- **The base pot never depends on any Artifact (NFT-1); a holder and a non-holder get the same base allocation for the same burn (NFT-2).**
- **Determinism (I11):** the same inputs in any order give the same file.

Residuals (they are design limits, disclosed here; from the first v3 epoch also in the plain-language risk page, `docs/RISKS.md`):

1. A quote is "at most" until the epoch is built: same-chain-same-hour burns share the hour's pot; an earlier burn the site had not seen (on another chain) takes capacity first; the build-time reading of the price pool can be lower than when the quote was shown (`L` is fixed for the week, 4.2).
2. The leftover is never promised; the binding part of a quote is the arrival claim only.
3. A skipped chain's backlog waits: it ranks after the current window's burns at arrival and first in the leftover (section 11), so it can take the leftover that later Launchpad layers of that week would otherwise receive.
4. In a shortfall week, keeper tips can cost earlier burns a few thousandths of an XNT of leftover; and a larger C (from an inflow) can leave less room for the latest burns, which are cut first.
5. The XNT floor (4.3) credits fewer XNT than the market route in a crash of more than 40% in a week.
6. Scripted burns can take a tranche the moment it opens; the tranches open every 24 hours from the previous publication, at times known in advance.
7. The oracle can still publish a wrong file; the program bounds it (10% of the free pool per epoch, 8% of the extra pot per extra epoch) and the 48-hour hold gives everyone time to verify and void it.
8. A voided epoch's burns are not paid in a later epoch by this code (section 10, "After a void"), and an epoch published by a stolen key stops the build until the code is fixed.
9. The anomaly gate only delays: a held epoch is published after 24 hours with a fresh rebuild unless an operator sets `GATE_BLOCK` (section 10).
10. A chain with no eligible market for 4 epochs in a row is orphaned: its burns are valued at 50% of its last reference price and its `L` keeps halving (section 11).

## 17. Clause → code → test

| Clause | Code (oracle/src) | Tests (oracle/test) |
|---|---|---|
| 2 window, clock, MIN_WINDOW | `rewards.ts` `computeEpochV3`, `snapshotWindowEnd`, `dayOf`, `publishableError`, `provisionalError` | rewards: "F2: the window start is pinned …", "A8: a null block time never anchors a window …", "A8: a burn stamped after the window end …", "F-DAYORIGIN …", "window: 7 fixed daily tranches …" |
| 4.1 XEN price | `xenPrice`, `priceReadings`, `medianE18` | rewards: "burn price = min(median, last close, 1.25 × ref) (A5) …", "SC-9: a candle price of 0 is refused …" |
| 4.2 curve, L rule | `runCurve`, `curve`, `curvePot`, `decay`, `decayFactor`, `liquidityRuleV3`, `nextLiquidityV3`, `liquidityStatOfV3`, `liquidityCarriedV3`, `firstLiquidityCapV3` | price-rules: "D-13: the next window's L stays within [50% × L, 110% × L + $50] …", "D-13 (a): the L of a window is known at its first hour …"; f5-carried: "F5: thin = fewer than 4 samples in a day …"; rewards: "curve f(x) …", "curve: same-hour pot shared pro rata …", "curve memory: a whale lowers later burns …", "L growth clamp …", "decay constant is the exact floor …", "SC-6: decayFactor squares from the most significant bit …" |
| 4.3 the XNT price and reference | `xntPrice`, `xntReference`, `xntPegV3` | price-rules: "D-22 (c): the depeg guard …"; rewards: "XNT per burn (A1, A3.2, A5) …", "F-XREF …" |
| 5 entitlement | `lamportsOf`, `computeEpochV3` | rewards: "lamportsOf …" |
| 6 capacity, tranches, XDEX cap | `allocateBurns` (release), `computeEpochV3` (C), `trancheCapV3` | price-rules: "D-22 (a): the week's cap is 7 daily tranches of 2% of the XDEX XNT reserve …"; rewards: "FCFS daily tranches …", "SC-2 / RE-3 …", "RE-3 regression …", "A2: the week …" |
| 7.1 order | `globalOrder` | rewards: "global order … is total (S16)" |
| 7.2 arrival, lock piece, conversion | `allocateBurns`, `settleArrival`, `lockPiece` | rewards: "A12 mission lock piece (RE-2) …", "RE-2 regression …", "F6: a vesting burn entitled to less than 0.02 XNT is paid as Launchpad …", "A9 (replaces F5) …" |
| 7.3 leftover | `allocateBurns` | rewards: "leftover pass pays the week …" |
| 7.5 Artifacts never in the base | `computeEpochV3`, `retiredBaseTerms` | rewards: "A13.1: the base pot never depends on any Artifact …", "A13.1: a holder and a non-holder get the same base allocation …" |
| 8 build limit, shortfall | `buildLimit`, `oracleAllowanceMax`, `limitGate`, `fitClaim`, `plannedOutflow` | rewards: "D-47: the build keeps the oracle allowance …", "F-SHORTFALL (A13.2) …", "A13.2 prefix-stability …", "A13.2 own size and own tier …", "A13.2 the pool never breaks …", "A13.2 epoch level …" |
| 9 encoding | `encodeLeaves`, `programClaims`, `dataHashV3`; `merkle.ts` | rewards: "encoding (A13.1) …", "SC-7: verify proves I9 …" |
| 10 publication, anomaly gate | `rebuildReason`, `publishGateV3`, `publishRecordV3`, `anomalyGateV3`; `flow-v3.ts` `gateDecisionV3` | f5-carried: "F5 gate: the hold is a plain D-17 hold …"; rewards: "rebuildReason (A13.1) …", "F-DRIFT / R2-1 …", "RE-1 regression …"; flow |
| 10 after a void | none: `index.ts` `runEpoch` takes the on-chain last epoch's file as the previous file | none (residual 8) |
| 11 chains, skip, continuity, orphaned chain | `flow-v3.ts` `assembleInputsV3`, `missionContinuity`; `computeEpochV3SkippingUnpriced`; ORPHAN_SKIPS, ORPHAN_PRICE_BPS | price-rules: "golden d21-orphaned-chain …"; rewards: "a skipped chain keeps its cursor …", "R2-SC-3 …", "R2-SC-5 …"; flow (chain skipping, mission-id gaps) |
| 12 claims, dust | `claimPlanV3`, `publishRecordV3` | flow (publish record, claims counts) |
| 13 extra pot | `extra.ts` `computeExtraEpoch`, `uncovered`, `needOf`, `budgetMaxOf`, `backingBoundOf`, `needWeeksOf`, `skipExtraEpoch`, `verifyExtraFile` | extra: "price paid and weekly need per tier …", "uncovered use …", "release and budget max …", "eligibility …", "season …", "MIN_PAY …", "heartbeat …", "A13.3 …", "A13.6 (N6) …", "real engine …" |
| 14 switch | `prevState`, `applySwitchRefs`, `switchRefsFromV2`, `pinnedSwitchError`, `verifyAny` | rewards: "v2 → v3: the switch epoch maps L, x, the curve and the snapshot …", "SC-10: the switch epoch …", "version chain …" |
| 16 verification | `verifyEpochV3`, `verifyAny`, `verifyPublishedV3`; `extra.ts` `verifyExtraFile` | rewards: "verify: round trip passes, and every tampering is reported", "verifyPublishedV3 …"; extra: "verify: round trip, then every tamper is caught …" |

Run them: `cd oracle && npm ci && npm test`. How to recompute a v3 file (`docs/VERIFY.md`), the v3 file format (`docs/EPOCH-FILES.md`) and worked v3 numbers (`docs/EXAMPLES.md`, which until then holds the v2 examples) are published with the first v3 epoch.
