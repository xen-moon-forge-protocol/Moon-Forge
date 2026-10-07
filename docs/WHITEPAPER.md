# Moon Forge Protocol — Whitepaper v2.0

> **Any XEN, on any supported chain → XNT on X1.** Zero protocol fees on the burn path. Recomputable by anyone.

*October 2026. This document replaces whitepaper v12.0, which described mechanisms that were never implemented and contained claims (immutability, NFT boosts, game fairness) that were not true of the code. See [AUDIT-2026-10](AUDIT-2026-10.md).*

---

## 1. Why

XEN exists on many EVM chains. X1 (an SVM chain whose token is XNT) was widely discussed in the XEN community as a future home for XEN, including a proposed "Moon Party" for XEN burners; as of 2026-10-07 no such event has taken place. Market facts as of 2026-10-07:

- **XEN cannot be bridged to X1.** X1's official Warp Bridge connects only Solana and X1, and no XEN of any kind is bridged. Reaching XNT means selling XEN, bridging USD and buying through thin pools.
- **XEN Prime (announced June 2026, not launched)** will accept only **Ethereum** XEN. Holders on BSC, Polygon, Avalanche, Optimism, Base and PulseChain are excluded. (Moonbeam XEN is excluded too, and Moon Forge does not support it either: it has no XEN market to value burns against.)
- **Buying XNT is hard.** The main XNT/USDC.X pool holds ~$10–14k. A holder with less than ~$11 of XEN cannot practically reach XNT through the market (the USDC bridge needs $10 minimum plus a $1 fee and has a $10k daily cap); larger holders get roughly 40–90% of spot after fees and slippage.
- **Side-chain XEN is hard to sell even when its price rises.** Its pools are thin: a holder who sells a real amount moves the price against themselves, then still has to bridge to reach X1.

Moon Forge offers another path: **burn XEN where it lives, receive XNT on X1**, with rules enforced by code and data anyone can re-check. It complements XEN Prime rather than competing with it: ETH-XEN holders can choose either; for the other supported chains (BSC, Polygon, Avalanche, Optimism, Base, PulseChain) Moon Forge is an option where XEN Prime is not. Portals are live on Base, Optimism, Polygon, BSC and Avalanche (`0x7b00f314aB48D223bee567181CA89c65126Bf6E9`, the same address on every chain); the other chains follow as their deploy gas is funded.

## 2. Flow

```
EVM chain                       Oracle (public code, public data)            X1 (Anchor program 57UE1U…)
─────────                       ─────────────────────────────────            ───────────────────────────
XEN.approve(portal)
portal.enterForge(amount,       reads MissionStarted after finality   ──►   publish_epoch(root, data_hash,
  tier, x1Pubkey)                values burns, builds Merkle tree,           total_score, rate_cap)
 └─ XEN.burn(you) ✔ supply ↓     writes epoch-N.json (GitHub Pages)          budget = min(…) computed ON-CHAIN
 └─ MissionStarted event                                                    claim (permissionless) → XNT
```

1. **Burn.** `MoonForgePortal` calls XEN's own `burn()` through the official `IBurnRedeemable` callback (the same mechanism XEN Prime uses): XEN's total supply decreases and the burn is recorded in XEN's own `userBurns` ledger. The portal has no owner, admin, fee, pause, upgrade or trusted forwarder. The X1 destination is the raw 32-byte public key, so an EVM address can never be used by mistake.
2. **Epoch.** Weekly (Sundays 00:00 UTC; the program requires at least 6 days between epochs) the oracle reads every `MissionStarted` event after finality, values each burn, and publishes one Merkle root per epoch together with the epoch `rate_cap`. Every input (block ranges, events, prices, liquidity, Artifact snapshot) is saved in `epochs/epoch-N.json`, whose SHA-256 is stored on-chain.
3. **Claim.** Claims are permissionless: a keeper (or anyone) submits them and the XNT always goes to the X1 key inside the Merkle leaf. When the public keeper is running, Launchpad burners usually receive XNT without doing anything on X1. For Orbit / Moon Landing, the claim starts the vesting; vested XNT is withdrawn with "Withdraw vested" (anyone can push it; the keeper does not do it automatically).

## 3. Scoring and payout

Every chain has its own XEN contract with its own supply, price and liquidity, so **each burn is valued on its own chain's market, at the hour it happened**:

```
spot_value(burn)   = XEN amount × burn-hour price of THAT chain's XEN
                     (median of the hourly closes over the 24 h ending at the burn hour,
                      in that chain's eligible pool with the largest XEN-side liquidity)
V_chain            = Σ spot_value of all burns on that chain in the epoch
L_chain            = XEN-side USD liquidity of that chain's eligible pools
real_value(burn)   = spot_value × L_chain / (L_chain + V_chain)        (liquidity-adjusted value)
score(player,tier) = Σ real_value × tier_multiplier × (1 + best eligible Artifact boost of the player)
base_score         = Σ real_value × tier_multiplier                    (the same, without boosts)
rate_cap           = K × (XNT per USD) × base_score / total_score,  K = 1.25
                     (supplied by the oracle, must be > 0, recomputed by the verifier from the epoch file)
budget(epoch)      = min( 10% of the FREE reward pool , total_score × rate_cap )   ← computed on-chain
drop_reserve       = min( 10% of budget , 100 XNT )                    (Forge Drops, section 3.1 — part of the budget)
payout(leaf)       = score × (budget − drop_reserve) / total_score
```

- **Price rules.** Only pools whose other token is a liquid quote asset on an explicit per-chain allowlist (the wrapped native token, USDC/USDT/DAI, WETH) count, both for price and for liquidity. The price pool is the eligible pool with the largest XEN-side liquidity (not the most traded). The burn price is the median of that pool's hourly closes over the 24 hours ending at the burn hour — current, but not movable by a one-block or one-hour pump. Each chain's prices are clamped to ±50% of the median of that chain's reference price over the last 4 epochs (in a chain's first epoch: ±50% of the aggregator token price), and the XNT price is clamped to ±50% of the previous epoch's. Prices come from public DEX data (GeckoTerminal); each chain's total supply is recorded in the epoch file.
- **Real weight, not paper weight.** The liquidity factor is the constant-product AMM formula. With liquidity as of 2026-10-07: burning $100 of BSC-XEN (≈$3.6k of liquidity) counts ≈$97; burning $1,000 of Avalanche-XEN (≈$0.5k of liquidity) counts ≈$333. Deep markets (Ethereum) count ≈ spot. A chain with no eligible XEN market counts zero (the UI says so before you burn).
- **Linear and sybil-neutral.** The liquidity factor is the same for every burn of a chain in an epoch, so splitting a burn across wallets never increases the total. (v12 used √XEN, which paid ~10× more to anyone who split 1 burn into 100 wallets.)
- **Same scale on every chain.** $10 of liquidity-adjusted value scores the same on every chain.
- **Better than selling, but not farmable.** In total, an epoch pays at most **1.25× the liquidity-adjusted value** burned at Launchpad (instant), 2.5× at Orbit (45-day vesting) and 3.75× at Moon Landing (180-day vesting), Forge Drops included: at least 90% of it in XNT, the rest as expected Forge Drop value. XEN can be minted forever, so a larger premium would be captured by mint-and-burn farmers; whatever is not distributed stays in the pool for later epochs. Artifact boosts move share between burners of the same epoch but never raise its total (the cap is scaled by base_score / total_score), so a burner alone gains nothing from a boost and a farmer holding the best Artifact still cannot get more than K × value out of an epoch on their own.
- **Spending bounds.** Each epoch can reserve at most 10% of the free pool; epochs are at least 6 days apart; the program refuses any claim that would exceed the epoch budget; no leaf can weigh more than the whole epoch (`score ≤ total_score`). The only possible excess is Forge Drop luck, which is bounded (section 3.1).

Only the `min()` is computed by the program; `rate_cap` is an oracle input, which anyone can recompute with `npm run verify -- epoch-N.json --full`.

### Tiers

| Tier | Multiplier | Paid | Eject early | Eject immediately pays (of the Launchpad equivalent) |
|---|---|---|---|---|
| 🚀 Launchpad | 1× | instantly | — | — |
| 🛸 Orbit | 2× | linear over 45 days | 60% penalty on the **unvested** part | 0.80× in XNT (up to ~0.92× counting Forge Drops) |
| 🌙 Moon Landing | 3× | linear over 180 days | 75% penalty on the **unvested** part | 0.75× in XNT (up to ~0.975× counting Forge Drops) |

Vesting starts when the leaf is claimed (by the player or a keeper). Penalties go **100% back to the reward pool**, and ejecting at once always pays less than choosing Launchpad. (v12's 20%/50% penalties let anyone pick 3× and eject at once for 1.5×.)

### Claim windows

Claims and Forge Drops stay open for 90 days. After that `expire_epoch` (callable by anyone, run by the keeper) returns the unclaimed budget and the unpaid drop reserve to the pool.

### 3.1 Forge Drops — the Artifact in your hand

10% of every epoch budget, capped at 100 XNT (20 × 5 XNT), is not paid pro-rata in XNT: it is drawn among that epoch's burners as **Lunar Dust Artifacts that hold a floor** equal to the drop value (at least 5 XNT, the recycle value of a forged Lunar Dust). It is part of the burners' own epoch reward, not extra. The rules, all in `drops.rs`:

```
expected drop value of a leaf = score × drop_reserve / total_score
value ≥ 5 XNT  → always wins; the whole value becomes the Artifact's floor
value < 5 XNT  → wins a 5 XNT-floor Lunar Dust with probability value / 5 XNT
seed           = keccak("MOONFORGE_DROP" ‖ hash of the first block ≥ publish slot + 4 ‖ epoch)
roll(leaf)     = keccak("MOONFORGE_RNG" ‖ seed ‖ player ‖ tier) mod 5 XNT
```

- **Linear.** The chance is linear in what you burned, so splitting a burn across wallets never changes your expected drop value. The oracle signs the epoch before the seed block exists, so it cannot predict or choose the seed (the producer of that block could in theory influence it — see section 9). Anyone can recompute every outcome.
- **Bounded.** The drops come out of the same epoch budget: in expectation the pool pays exactly the same. Luck can draw more winners than expected; the excess comes from the free pool and is capped — winners beyond `reserve + max(reserve, 15 XNT)` are refused. Sealing is permissionless; if nobody seals the seed within ~512 slots the drops are cancelled and the reserve returns to the pool — never re-rolled.
- **Why it matters.** Small and side-chain holders, whose XEN is hard to sell, get a chance at a whole 5 XNT Artifact instead of a few cents of XNT. The Artifact is not a promise: recycle it at once for its floor, or keep it — +5% boost on future burns (once held at two consecutive epoch snapshots), 5 lottery chips a week, the ticket to Artifact Duels, tradable on marketplaces.
- **Delivery.** Permissionless: anyone can deliver the Artifact to the winner (it always goes to the player in the leaf; a keeper doing it for someone else receives a 0.01 XNT tip from the pool); the winner can also receive it in Mission Control. It must be received within the epoch's 90-day window. If all 600 Lunar Dust are alive, the same value is paid in XNT instead.

## 4. Where the XNT comes from

The reward pool is funded only by real flows, all visible on-chain:

| Source | Share to the reward pool |
|---|---|
| Donations (`donate`) | 100% |
| House games (Coin Flip, High-Low, Void Rush) | 1% of every stake |
| Jackpot, Artifact Duel | 1% of the pot, when someone wins |
| Burn Lottery tickets | 1% of every ticket, at purchase |
| Artifact forging | 40% of the price paid |
| Early-exit penalties | 100% |
| Unclaimed / expired epoch budgets, unused or cancelled drop reserves | 100% |
| Expired lottery draws (no winner) | the would-be prize (50% of the prize vault) |
| Artifacts burned outside Moon Forge (orphans) | their floor |
| v1 program accounts (one-time sweep) | 100% |
| Architect's cut, when the architect wallet is below rent exemption | 100% |

Outflows: epoch claims, Forge Drops, keeper tips (0.002 XNT per claim of ≥ 0.02 XNT submitted for someone else, 0.01 XNT per Forge Drop delivered for someone else).

There is no token, no inflation and no promise of a return. If nobody funds the pool, burns earn nothing — the UI shows the live pool and the maximum next budget before you burn.

## 5. Games

All games are on-chain and settle in XNT.

**House-game randomness.** The bet locks the stake and commits to the **next slot**; settlement (anyone can do it) uses `keccak("MOONFORGE_RNG" ‖ slot_hash ‖ bet ‖ player_seed)`. The result is not known to the player or the protocol when the stake is locked; the block producer of that slot could in theory influence it (disclosed; see section 9). Nobody can choose to skip a result: a bet not settled within ~3 minutes (the SlotHashes window) counts as **lost**, even if its roll was a win. The site settles your bet immediately; the public keeper, when running, makes a pass every 15 seconds as a safety net, but GitHub Actions runs can be delayed. Bets must be top-level instructions (no wrapping program can revert a loss).

**Expired draws are never re-drawn.** A Jackpot whose drawing block left the window before anyone settled it is **refunded in full**, entry by entry. A lottery round in the same situation has **no winner**: its would-be prize (50% of the vault) goes to the burners' reward pool — never rolled over — and that round's chips and tickets are spent. A re-draw would let a losing player simply wait for a better block. The keeper settles rounds first in each pass.

| Game | Type | Odds / rules |
|---|---|---|
| Coin Flip | house | 50%, pays 1.96× |
| High-Low | house | choose 1–95% win chance, over/under; pays 0.98 / chance |
| Void Rush | house | choose 1.05×–100×; win chance = 98% / target |
| Jackpot | P2P | a round starts at the first entry and closes 10 min later; winner drawn ∝ amount; single-player rounds fully refunded |
| Artifact Duel | P2P | a live Artifact of any tier is the ticket (checked when creating and when joining); each player chooses any of the 4 elements — the creator's is hidden by commit-reveal and does not depend on which Artifacts they hold; Lunar > Void > Solar > Cosmic > Lunar; same or opposite element (Lunar–Solar, Cosmic–Void) = draw, full refund, no rake; the creator must reveal within 1 h or the opponent wins |
| Burn Lottery | P2P | a round lasts 7 days from its first entry; weight = chips + 1-XNT tickets; the winner takes 50% of the prize vault, the other half stays in the vault for later rounds |
| Moon Wars | P2P (next program upgrade) + free practice | both players stake the same amount and show a live Artifact as the ticket; the same 10-card deck each (4 Lunar Dust, 3 Cosmic Shard, 2 Solar Core, 1 Void Anomaly), shuffled by the hash of a block produced after both joined, so the draw order is public to both (perfect information); 20 HP, mana = min(10, ⌈round/2⌉ + 1), field limit 6, Solar Core burns 2 HP on entry, empty deck = 1 fatigue damage; every move is validated by the program; 2 min per turn (out of time = loss); 100 rounds max (then a draw, full refund). Moves can be signed by a key generated in the player's browser. The free practice uses the same rules |
| Predictions | P2P (next program upgrade) | pari-mutuel "XNT up or down": round k opens at k × 24 h UTC, takes entries for 12 h (one per wallet), start price = 15-minute TWAP ending at the lock, end price = 15-minute TWAP 24 h later, both read from the observation account the XDEX WXNT/USDC.X pool keeps on-chain; winners share the pot (capped at 200 XNT) pro-rata; a tie, an empty side, or price data that is missing (no swap for 24 h) or has left the on-chain window refunds everyone in full |

**House edge: 2%, split 1% reward pool / 0.5% architect / 0.5% bankroll.** Jackpot, Duel, Moon Wars and Predictions rake: 2% of the pot only when someone wins (1% pool / 0.5% architect / 0.5% lottery). Burn Lottery tickets pay 2% at purchase (1% pool / 0.5% architect / 0.5% back to the prize vault), so 98.5% of each ticket goes to the prize vault.

**Only the wallet owner can enter P2P games.** Jackpot, Burn Lottery, Duels, Moon Wars and Predictions require the owner's signature; session keys cannot enter them.

**Bankroll limits.** A bet is accepted only if the bankroll can pay its full payout on top of every pending bet (reserved liabilities). The max net win per bet is 0.25% of the free bankroll, and all unsettled payouts together can never exceed 20% of the bankroll. (Only 0.5% of the edge stays in the bankroll, so above ~0.5% per bet the bankroll's long-run growth would turn negative.) **Circuit breaker:** if the bankroll (net of LP deposits and withdrawals) has lost 10% since the start of the UTC day, new house bets are refused until the next UTC day.

**Be the House.** Anyone can deposit XNT into the bankroll and share its 0.5% of stakes and its variance — **you can lose part of your deposit if players win**. Shares are priced against the depositor in both directions — deposits as if every pending bet loses, withdrawals as if every pending bet wins — so nobody can buy shares cheaply while bets are open or leave with money owed to winners; the app applies a 1% slippage limit. Withdrawals need a 24-hour cooldown and are priced when you withdraw (not when you request); a new request replaces the old one and restarts the timer. The first deposit mints permanent protocol shares so the share price cannot be inflated; bankroll donations made before the first LP also become permanent protocol shares, and afterwards they raise the value of existing shares.

**Bots.** A player can authorize a *session key* (with expiry and a max stake per bet) that can play **house games only** from the player's game balance. It can never withdraw, and cannot enter the Jackpot, the Burn Lottery or Duels. Bots get no informational edge — they only add volume, and 1% of all house volume feeds burners. See [BOTS.md](BOTS.md).

## 6. Artifacts (Metaplex Core NFTs)

| Tier | Max alive | Base price | Pricing | Floor (refunded on recycle) | Burn boost | Weekly chips |
|---|---|---|---|---|---|---|
| Lunar Dust | 600 | 10 XNT | fixed | 5 XNT when forged; the drop value (≥ 5 XNT) from a Forge Drop; none from the Genesis airdrop | +5% | 5 |
| Cosmic Shard | 300 | 25 XNT | dynamic | half of the price paid | +10% | 15 |
| Solar Core | 90 | 60 XNT | dynamic | half of the price paid | +20% | 40 |
| Void Anomaly | 10 | 200 XNT | dynamic | half of the price paid | +50% | 150 |

"Max alive" is a cap on Artifacts alive at the same time; Artifacts do not exist until minted (the collection is created by `init_artifacts` after the upgrade).

**Dynamic price.** Every forge of a dynamic tier raises its price by 5% for the next buyer; every full week without a forge lowers it by ÷1.05 (−4.76%), never below the base price and never above 100× it. The buyer signs a maximum price, so a price move can only make the transaction fail, never cost more. Because the floor is half of what each buyer paid, forging and recycling at once always loses half the price: price moves cannot be farmed through the forge, and every forge funds the pool (40%) and the lottery (5%).

- **Forge:** of the price actually paid, 50% stays inside the NFT as its floor, 40% → reward pool, 5% → lottery, 5% → architect.
- **Recycle:** burn the NFT, get its floor back; the supply slot is freed and can be forged again (each new forge pays the split again). Recycling does not change the forge price; only forges (up) and quiet weeks (down) do.
- **Boost:** at each epoch the oracle snapshots live holders. Only an Artifact held by the **same owner at both the previous and the current epoch snapshot** counts (no flash forging or renting for the snapshot; no boost in the first epoch), and only the best one per wallet — boosts do not stack. A boost shifts share between burners of the same epoch and never raises the epoch total.
- **Other uses:** weekly lottery chips; the ticket to Artifact Duels (any tier; the element played is chosen freely and is not tied to the Artifacts you hold); readable on-chain attributes so other X1 projects can integrate them.
- **Forge Drops:** Lunar Dust won by burners (section 3.1); its floor is the drawn value (≥ 5 XNT) and shows as the on-chain "Floor XNT" attribute, with origin "Forge Drop".
- **Genesis airdrop:** up to 120 Lunar Dust (no floor), via a Merkle list published once and finally with `set_airdrop_root`. The current draft lists 444 X1 validator withdraw authorities and will be rebuilt to add Genesis supporters before it is published. Only the first 120 claims succeed; the claimant pays the rent and needs a free Lunar Dust slot.
- **Secondary sales:** the collection declares a 5% royalty (Core Royalties plugin), paid only where marketplaces honor it.

## 7. Chips

Non-transferable, used only as Burn Lottery weight at no cost:

- **Burns:** 1 per XNT actually received — Launchpad at claim; Orbit / Moon Landing as vested XNT is withdrawn or at eject, never on the part lost to a penalty.
- **House games:** 1 per 10 XNT wagered.
- **Artifacts:** 5 / 15 / 40 / 150 per Artifact per week by tier, claimed by the holder. Weeks are `unix time / 604800` (they reset on Thursdays 00:00 UTC); a missed week does not accumulate.

Chips entered in a lottery round are spent with that round, whether or not it has a winner. This is the bridge between the fronts: burners can join the lottery without paying for tickets.

## 8. Fees and the architect

| Path | Protocol fee | Architect |
|---|---|---|
| Burn → claim → vesting → Forge Drops | **0** | **0** |
| Donations, Be the House | 0 | 0 |
| House games | 2% edge (in the odds): 1% pool, 0.5% bankroll | 0.5% of stakes |
| Jackpot, Artifact Duel, Moon Wars, Predictions | 2% rake only when someone wins: 1% pool, 0.5% lottery | 0.5% of the pot |
| Burn Lottery tickets | 2% at purchase: 1% pool, 0.5% back to the prize vault | 0.5% of each ticket |
| Artifact forge | 50% floor (refundable), 40% pool, 5% lottery | 5% of the price paid |
| Artifact secondary sales | — | 5% royalty, where honored |
| Keeper tips | paid by the reward pool, never by the player | 0 |

These numbers are compile-time constants (`programs/moon-forge/src/constants.rs`). If paying a cut would leave the architect wallet below rent exemption, that cut goes to the reward pool instead, so play can never be blocked by it.

## 9. Trust model (read this)

| Component | Power | Bound |
|---|---|---|
| **Oracle key** | Publishes epoch roots and the epoch `rate_cap`; can hand its role to a new key | ≤ 10% of the free pool per epoch (Forge Drops included, plus a luck overrun bounded by max(reserve, 15 XNT)), ≥ 6 days between epochs, no leaf above the epoch total, `rate_cap` must be > 0; every epoch's data published and hash-committed; anyone can recompute it, including `rate_cap` (`npm run verify -- epoch-N.json --full`); it cannot predict the drop seed. A dishonest oracle could still direct up to an epoch's budget to false burns; the verifier would show it |
| **Architect key** | Sets the airdrop list once | Nothing else in the program |
| **Upgrade authority** | Held by the architect wallet during the public test period; can replace the program | Planned to be burned (`solana program set-upgrade-authority --final`) after the test period; the Transparency page reads it live |
| **Keeper** | Submits claims, settlements, Forge Drop deliveries, Moon Wars starts / timeouts / payouts and Prediction locks / settlements / payouts | Permissionless; anyone can run it; it can only trigger outcomes that are already determined; funds always go to the player recorded on-chain |
| **Session keys** | Play house games from the owner's game balance | Cannot withdraw, cannot enter P2P games or Duels, limited by expiry and max stake |
| **EVM portals** | None — no owner, admin, fee, pause or upgrade function | Code fixed at deploy; see `deployments/portals.json` |

Residual risks: the oracle reporting false burns or wrong prices (bounded as above; price rules in section 3); the block producer of a target slot influencing or withholding its hash to change one house result (X1 has no VRF; bounded by the 0.25% per-bet cap, the 20% aggregate cap and the 10% daily circuit breaker); keeper downtime or GitHub scheduling delays (a draw nobody settles within ~3 minutes is refunded or its prize sent to the reward pool, never re-drawn; an unsettled house bet counts as lost, so the site settles bets itself); smart-contract bugs (the code is open and has unit, integration and randomized solvency tests and three internal adversarial passes — not independent; no third-party audit); the upgrade authority until it is burned.

## 10. Status (October 2026)

- Program v2 written and tested locally: unit tests, integration tests against the real Metaplex Core binary, a randomized stress test that checks every account's obligations after every round, and internal adversarial reviews (not independent; no third-party audit) — see [AUDIT-2026-10](AUDIT-2026-10.md). **Live on X1 mainnet since 2026-10-07** (slot 84,304,402; on-chain bytes identical to the tested build).
- Portals v2: live at `0x7b00f314aB48D223bee567181CA89c65126Bf6E9` on Base (block 52,302,281), Optimism (block 157,898,892), Polygon (block 95,131,060), BSC (block 126,311,331) and Avalanche (block 96,979,937), 2026-10-07, Sourcify exact match; the other chains follow. Supported chains: Ethereum, BSC, Polygon, Avalanche, Optimism, Base, PulseChain. Moonbeam is not supported (no XEN market).
- Oracle v2 + keeper: written; the oracle runs weekly (GitHub Actions or any machine); the keeper is permissionless.
- Moon Wars (real XNT) and Predictions: written and tested (integration tests and the randomized solvency audit); live with the next program upgrade. The practice mode of Moon Wars is live.
- Practical notes: a payout to a brand-new wallet smaller than the rent-exempt minimum is credited to the player's game balance instead. Game wallet and Be-the-House share account rent is not refundable; claim receipt rent is refunded after the epoch closes, and mission rent when the mission ends.

Returns are not promised. XNT is volatile. Use only what you can afford to lose.
