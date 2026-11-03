# How Moon Forge works

*A plain guide for XEN holders, players and anyone who wants to check. Written 2026-11-02.*

**The real scale first.** On 2026-11-02 the reward pool that pays every burner held about **6.5 XNT** (read on X1). One week can pay at most about **0.65 XNT to all burners together** under today's rules (10% of the free pool) and about **0.5 XNT** (about 0.074 XNT a day) under the v3 rules (8%), however much is burned. **No payout is promised.** Every worked example in this guide is illustrative: it assumes a pool hundreds of times larger, to show how the rules work. The live figure is on the [Start page](https://xen-moon-forge-protocol.github.io/Moon-Forge/start/) ("Most this epoch can pay, to everyone together") and the [Transparency page](https://xen-moon-forge-protocol.github.io/Moon-Forge/transparency/).

**Which rules are live.** Today the X1 program is v2 (tag `program-2026-10-12`) and the oracle pays burns under the v2 reward rules ("rules 2"). The final program upgrade is planned for **Wednesday 2026-11-18, 16:00–20:00 UTC** (the same hours a week later if a gate is not green), and the first weekly payout under the v3 reward rules ("rules 3") for **Sunday 2026-11-22**. Every paragraph marked *From the final upgrade* or *Rules 3* describes those planned rules: it is a plan until the transactions exist. Burns made after the last v2 payout is published (planned Sunday 2026-11-15) are paid under rules 3. The switch to the v3 rules is announced at least one full week ahead with the last v2 transaction; after it, any change to the reward rules needs a new rule set announced at least two weeks ahead, never applied backwards. Sources: [UPGRADE-2026-11.md](UPGRADE-2026-11.md) (the program changelog), `oracle/src/rewards.ts` (rules 3), [CLAIMS.md](CLAIMS.md) (every public claim with its evidence).

**Words used here.**

- **Epoch**: one weekly payout round. Its data file is public and its fingerprint is stored on X1.
- **Free pool**: the XNT in the reward pool that no published payout has reserved yet.
- **Counted value**: what your burn is worth after your chain's market depth is taken into account (about what selling it on that market would bring).
- **Launchpad, Orbit, Moon Landing**: the three payout tiers you choose when you burn: paid at once, released over 45 days, released over 180 days.
- **Slice**: one seventh of a week's capacity; a new one opens every day.
- **Leftover**: capacity nobody used by the end of the week.
- **Keeper**: a public bot, which anyone can run, that claims payouts for burners and runs game steps. The **house keeper** is the one bonded account that draws house-game results.
- **Void**: cancelling a published payout during its 48-hour hold. **Hold**: the 48 hours after publication before anyone can claim (from the final upgrade).
- **Floor**: the half of an Artifact's price that stays inside it and comes back when you recycle it.
- **Rent**: a small refundable deposit X1 asks for every account.

Contents: [1. What it is](#1-what-moon-forge-is) · [2. Where the XNT comes from](#2-where-the-xnt-comes-from) · [3. Your burn → XNT](#3-your-burn--xnt) · [4. Artifacts](#4-artifacts-receiving-more-or-less-with-or-without-one) · [5. Games](#5-games-i-only-want-to-play) · [6. Legacy Pilot](#6-legacy-pilot) · [7. Chains](#7-chains) · [8. Nobody in control](#8-nobody-in-control-after-the-freeze) · [9. Check it yourself](#9-check-it-yourself) · [10. Risks](#10-risks-honestly) · [11. How the community keeps it running](#11-how-the-community-keeps-it-running)

---

## 1. What Moon Forge is

**In one sentence:** you burn XEN on Base, Optimism, Polygon, BSC or Avalanche through XEN's own `burn()`, and receive XNT on X1 from a public reward pool, valued by one public market rule, with no new token.

**In about 60 words:** X1 and XNT grew out of the XEN community. Moon Forge adds one more path, alongside the others: burn XEN on Base, Optimism, Polygon, BSC or Avalanche through XEN's own `burn()` and receive XNT on X1 (under rules 3, planned from 2026-11-22: 1.25× the burn's counted market value at the claim, 2.5× over 45 days or 3.75× over 180) from a public pool, while weekly capacity lasts. No new token. No payout is promised, and the pool is small: on 2026-11-02 a whole week could pay all burners together about 0.5 XNT.

**Only XEN and XNT.** You burn XEN, the chain's own XEN token. You receive XNT, X1's native coin. Moon Forge has no token, no token airdrop, no presale, no whitelist and no team allocation; any "Moon Forge token" or claim page is not Moon Forge. The only airdrop is the Genesis airdrop: up to 120 Lunar Dust NFTs with no floor for the X1 validator withdraw authorities published on 2026-10-12 (section 4). Artifacts are optional NFTs bought with XNT. **Burning needs no NFT and no game: those are optional.**

**One path among several.** Everyone around XEN and X1 wants the same thing: a real use for XEN. Not everyone takes the same path. Moon Forge is one more way, alongside the others; holders can use several with different parts of their XEN (each XEN can be burned only once). Moon Forge is independent and open source, run by one anonymous builder who receives the disclosed cuts (section 8). It is separate from X1 Labs, the XEN team and every other XEN or X1 project; each has its own rules, and none speaks for the others. Moon Forge and X1 Forge are separate projects with similar names.

**The path in three steps.**

1. Your XEN in a wallet you control on one of the five chains, plus a little of that chain's gas token. XEN on an exchange, locked in a stake or a XENFT, or wrapped or bridged, does not count until it is liquid XEN in your own wallet on one of the five chains.
2. An X1 address whose key you hold (X1 Wallet, or Backpack with the X1 RPC). You need no XNT to receive.
3. Burn on [The Forge](https://xen-moon-forge-protocol.github.io/Moon-Forge/forge/): one approval for exactly the amount, then the burn. After the weekly payout round, the project's keeper (or anyone) claims for you.

A burn cannot be undone. Do a small test burn first.

---

## 2. Where the XNT comes from

Every XNT a burner receives comes out of one program account on X1, the **reward pool** (`reward_vault`, `CScsBfpj63Mppem9Bmddmfi87bkcAfeLevdSauYMDsHR`). The program cannot create XNT: XNT is X1's native coin and the program has no token code. It can only pay what people put into the pool.

**What fills the reward pool**

| Source | Today (v2) | From the final upgrade (planned 2026-11-18) |
|---|---|---|
| Artifact forge price | 40% | 20% |
| Sale of an Artifact on the native market | (no native market) | 2% of the price |
| House games (Coin Flip, High-Low, Void Rush) | 1% of every stake | 1% of every stake, minus the house keeper's settle tip (at most 0.0005 XNT per bet, at most half of that 1%) |
| Jackpot, Duel, Moon Wars, only when someone wins | 1% of the pot | 1.5% of the pot |
| Predictions (not on the site or in the kit; entries sent to the program directly), only when someone wins | 1% of the pot | 1.5% of the pot |
| Burn Lottery tickets | 1% of each ticket | retired (no new tickets) |
| Early exit from Orbit / Moon Landing | 60% / 75% of the part not yet released | the same |
| Donations | 100% | 100% |
| Penalties and bonds | — | a Duel joiner's stake when it never reveals; a keeper's bond when a Jackpot round is not settled in time; void bonds; forfeited oracle-seat bonds |
| Artifacts burned outside Moon Forge | their floor | their floor |
| The architect's cuts while its wallet would sit below rent | 100% | 100%, and every cut after the payee renounces for good |

The first funding came from the project's own launch funding, sent as donations. Unclaimed payouts never leave the pool: after 90 days they become free again for later weeks.

From the final upgrade there is also a second, separate pot, the **extra pot** (`GRGxMQDjNg4DwoL69y2p1x14fSzeaKeCHVLkAb67Z9d2`). It does not exist before the upgrade. Its **only** source is 25% of every Artifact forge price, and it pays only Artifact holders who burn (section 4). The two pots never pay each other.

**What nobody can withdraw.** No instruction lets anyone take XNT out of either pot: not the builder, not the oracle, not the architect. Until the freeze (section 8) the upgrade key could still replace the program's code, including code that moves the pools; after the freeze nobody can. XNT leaves the reward pool only through the program's own rules: claims of published payouts; a 0.002 XNT tip to whoever claims for someone else (for claims of at least 0.02 XNT today, at least 0.2 XNT from the final upgrade); Forge Drops of payouts published by the v2 program; and, from the final upgrade, two small running costs: an allowance to the oracle key at each publication (the new payout account's rent plus at most 0.05 XNT toward 0.25 XNT) and the house keeper's settle tip. These running costs go to the oracle key and to whoever runs a keeper; the architect payee receives nothing from the pool. Moon Forge never buys XNT or XEN on the market.

**The pool is small.** On 2026-11-02 it held about 6.5 XNT. About 6.9 XNT was free when epoch 1 was published (2026-10-18); its single burn was capped at 1.25× its value (0.43 XNT, of which 0.388 XNT in cash and the rest as a Forge Drop reserve). The pool grows only with Artifact sales, game fees, penalties and donations. The live balance is on the [Transparency page](https://xen-moon-forge-protocol.github.io/Moon-Forge/transparency/); what the published payouts set aside is in [counter.json](https://xen-moon-forge-protocol.github.io/Moon-Forge/counter.json) (from the next site release).

---

## 3. Your burn → XNT

### 3.1 Today (rules 2, live)

Each weekly payout round has a budget that the program computes: at most 10% of the free pool, and at most 1.25× the burns' value in XNT (Orbit counts 2× and Moon Landing 3×). A tenth of the budget is drawn at random among that week's burners as Forge Drops (Lunar Dust NFTs with a floor of at least 5 XNT; a random draw, 18+ and only where legal); the rest is paid in XNT. Each burn is valued at its chain's XEN price in its hour, with a liquidity discount L/(L+V) (L = the chain's XEN-side market depth, V = everything burned on that chain in the whole week, so a large burn on your chain in the same week lowers the value of every burn there), converted at one XNT price for the whole round, and every burner receives a share of the budget in proportion to that value. Details: [WHITEPAPER.md](WHITEPAPER.md), [EXAMPLES.md](EXAMPLES.md). Burns made after the last v2 publication (planned Sunday 2026-11-15) wait for the first rules-3 payout and keep their own time.

### 3.2 Rules 3: how one burn is valued (planned from the payout of 2026-11-22)

Five steps, the same for every wallet and every chain:

1. **XEN price** of your chain, at your burn's hour: the lowest of the 24-hour median of hourly closes, the last closed hourly close, and 1.25× the chain's recent reference price. (If GeckoTerminal cannot answer, the oracle re-reads the chain's known pools on-chain, priced through Chainlink, and every burn of that chain takes the build's spot price, never above the same cap.)
2. **Spot value** = XEN burned × that price.
3. **Counted value** through your chain's liquidity curve: `counted = spot × L² / ((L + S) × (L + S + V))`, where L is the chain's XEN market depth in USD (fixed at the previous weekly build, so it is known before you burn), S the chain's recent burned value (it halves every 14 days), and V everything burned on that chain in the same hour. This is about what selling that XEN into its own market could fetch, so nobody is paid full price for XEN that its market could not absorb.
4. **Convert to XNT** at the XNT price of your burn's hour: the highest of the XNT 24-hour median, the last close and 0.6× the previous round's reference. A brief XNT dip never gives you more XNT.
5. **Tier:** Launchpad receives **1.25×** the counted value in XNT at the claim; Orbit **2.5×**, released over 45 days; Moon Landing **3.75×**, released over 180 days. Only the part that fits the week's capacity (3.4) is paid at arrival.

**Worked example** (illustrative: market numbers are assumptions and XNT is taken at $0.25): 1,000,000,000,000 XEN on BSC. Price: median $1.02e-10, last close $1.00e-10, cap $1.3125e-10 → **$1.00e-10**. Spot **$100**. BSC depth L = $3,600, no recent BSC burns (S = 0), nobody else that hour (V = $100) → counted 3,600² × 100 / (3,600 × 3,700) = **$97.30**. In XNT: 97.30 / 0.25 = 389.19 → Launchpad **486.49 XNT** if the week had room, Orbit 972.97 over 45 days, Moon Landing 1,459.46 over 180 days. **At today's pool this burn could receive at most about 0.074 XNT when it arrives on the first day and at most about 0.52 XNT in the whole week**: the example assumes a week with hundreds of times today's capacity.

| Same market, other cases (illustrative) | Counted value | Launchpad XNT if the week had room |
|---|---|---|
| 1 trillion XEN ($100) | $97.30 | 486.49 |
| 2 trillion XEN in one burn ($200) | $189.47 (1.947×, not 2×) | 947.37 |
| Two burners of 1 trillion each, same hour | $94.74 each | 473.68 each |
| A second 1 trillion one hour later | $92.19 | 460.93 |
| A second 1 trillion one week later | $93.63 | 468.17 |
| $100 of XEN into a $100,000-deep market | $99.90 | 499.50 |

Splitting a burn across wallets gains nothing: burns on the same chain in the same hour share that hour's value at the same rate. An Artifact changes nothing in this calculation (section 4).

**Why 1.25×?** The counted value is about what selling that XEN on its own market would bring, before pool fees, moving funds to X1 and buying XNT. Within the week's capacity, the rule aims to pay about what selling would bring; before you sign, the site shows both numbers side by side. Nothing is promised. K = 1.25 is published oracle policy, changed only with the notice described at the top of this guide.

### 3.3 "What do I get for 20 billion XEN when others burn trillions?"

The same rule as everyone. Per XEN, a small burn counts closer to its full market value than a huge one. Illustrative example on Base, depth L = $2,000, XEN at $2.5e-9, XNT at $0.25, Launchpad:

| | Spot | Counted | Launchpad XNT if the week had room | XNT per billion XEN |
|---|---|---|---|---|
| You: 20,000,000,000 XEN, nobody before you on Base | $50 | $48.78 (97.6%) | 243.90 | 12.20 |
| A whale: 2,000,000,000,000 XEN in one burn | $5,000 | $1,428.57 (28.6%) | 7,142.86 | 3.57 |

The whale burned 100× more XEN and is counted for about 29× more. Both numbers are far above what a week can pay today (about 0.5 XNT for everyone together), so in practice both are limited by the capacity. That capacity opens in daily slices (3.4): a giant burn on the first day can take only that day's slice; burns that arrive on later days claim the new slices when they arrive, and the whale receives more only from what is left at the end of the week.

The honest limits, all from the same rule:

- **Order matters.** A later burn never lowers what an earlier burn is paid when it arrives, except burns on the same chain in the same hour, which share that hour's value (if you and the whale burn on Base in the same hour, your 20 billion counts $14.18, 70.92 XNT). A later burn can, however, use capacity that would otherwise have paid an earlier burn's unpaid part from the leftover.
- **Scripts are fast.** Scripts can burn the moment a day's slice opens. If the day is full, your burn waits for the week's leftover, which may be nothing. There is no deadline: capacity nobody uses stays in the pool for later weeks.
- **The curve remembers.** If the whale burns on Base before you, Base's memory S jumps to $5,000 and halves every 14 days: your same 20 billion XEN two days later counts $4.66 (23.28 XNT), 14 days later $9.77 (48.84 XNT), 28 days later $18.65 (93.24 XNT). That is what a sale would fetch after the whale sold into the same thin market. Burns on the other four chains are not affected.
- **Operator wallets come last.** Wallets that the published rules list as the operator's are paid after every other burn.

### 3.4 The weekly capacity (rules 3)

- **How much a week can pay:** C = 8% of the free pool measured right after the previous round was published (about 0.5 XNT on 2026-11-02), and never more than seven times 2% of the XNT reserve of the XDEX WXNT/USDC.X pool. The program never lets a round's budget, with the oracle's allowance, go above 10% of the free pool; the oracle also keeps the claim tips inside that limit (an oracle rule, not a program rule).
- **When it opens:** in seven daily slices of C/7, counted from the previous publication (not from Sunday). The first day has C/7 open, the second day 2 × C/7 in total, and so on; a slice nobody uses rolls into the next day; on the seventh day the whole week is open.
- **Who is paid:** first come, first served, in the order of the burns' timestamps (two burns in the same second are ordered by a hash of their transaction, never by chain). Each burn claims its full amount against what is open when it arrives. An Orbit or Moon Landing burn that fits in part locks the part that fits at its full multiplier; the rest of its Launchpad part can come only from the leftover.
- **The leftover:** at the end of the week, capacity nobody used pays the unpaid **Launchpad** parts, in the same order (never the vesting extra). What is still unpaid is **not queued and not carried** to a later week. Capacity still unused stays in the pool and raises next week's C.
- A longer gap between two rounds is not a double week: C stays one week's 8%.

**A busy week** (imagined numbers: a pool of 4,000 XNT, about 600 times today's, so C = 320 XNT and slices of 45.71 XNT; counted values converted at $0.25, Launchpad = 5 XNT per counted dollar):

| Order | Burner | Day | Tier | Full amount | At arrival | From the leftover | Total |
|---|---|---|---|---|---|---|---|
| 1 | C | first | Launchpad | 30 | 30 | — | **30** |
| 2 | D | first | Launchpad | 40 | 15.71 (the first day is full) | 24.29 | **40** |
| 3 | E | third | Orbit | 100 | 91.43 locked on Orbit | 4.29 as Launchpad | **95.71** |
| 4 | F | sixth | Launchpad | 100 | 100 | — | **100** |

54.29 XNT nobody needed stays in the pool. Had F burned three times more (full amount 300), F would receive 137.14 at arrival plus 17.14 from the leftover, **154.29 of 300**; the other 145.71 XNT is not paid by any later week. Had F burned enough to use every remaining slice, the leftover would have been empty and D would have kept 15.71 and E 91.43. Under rules 2 the same week would instead have cut every burner pro rata.

### 3.5 Timeline (rules 3)

| Step | When |
|---|---|
| Burn | any time; the portal accepts it at once |
| Final on its chain | after 120 blocks (Base, Optimism), 30 (BSC, Avalanche), 256 (Polygon); a burn not final at the build falls into the next week |
| Round built | weekly, scheduled Sunday 00:00 UTC and often later; at least 6 days after the previous round |
| Anomaly check | if a published threshold trips (one wallet above 60% of C, unusual payouts, a chain's first week, a price-source problem), publication waits up to 24 hours and is rebuilt |
| Published | the round's fingerprint goes on-chain and its data file on the site |
| 48-hour hold | from the final upgrade, nothing can be claimed for 48 hours; anyone can recompute the round and void a wrong one |
| Claimed | the project's keeper (or the oracle, or anyone) claims every payout for its burner, even very small ones, and pays the fee; you can always claim your own |
| Paid | Launchpad: XNT in your X1 wallet. Orbit / Moon Landing: release starts at the claim; use "Withdraw vested" (anyone can push it) |
| Expiry | claims close 90 days after publication; the unclaimed rest goes back to the free pool |

Expect about 2 to 9 days from a burn to a Launchpad payout. If a round is voided during its hold, its burns are not paid by a later round.

### 3.6 A quote before you sign (rules 3)

No file quotes a burn today: under the current rules the estimator on The Forge shows an estimate only. From the first rules-3 window, the site and the agent kit compute a **binding quote** before you sign: for the part of your burn that fits today's remaining capacity, the most the round pays for it, at your burn's own prices, if the oracle publishes. It is "at most" until the round is built (a later burn on the same chain in the same hour, an earlier burn the site had not seen yet, or the USDC.X check at the build can lower it); the part beyond today's capacity is paid only from the leftover, which is not promised and can be less than selling. When no quote can be computed (no fresh feed, a skipped chain, a chain in its first week), the site and the kit do not offer the burn; the portal itself still accepts it.

The quote reads an hourly file, the **week-so-far feed**, served with the site at `https://xen-moon-forge-protocol.github.io/Moon-Forge/feed/week-so-far.json` (rewritten every hour from the first rules-3 window; before that it does not exist). It holds the week's capacity (`capacity.cash` = C, `capacity.senior` = what this week's burns already took), each chain's current price readings (`readings.xen[chainId]` = [24-hour median, last close], USD × 10^18 per XEN), its price cap (`capE18`), its curve memory (`S` and `hourSpot` at hour `hour`, in millionths of a dollar) and the XNT readings (`readings.xnt`, `xnt.floorE18`). The chain's depth L for the week is in the previous round's data file. The agent kit's `quoteBurn()` (`agents/kit/burn.mjs`) does the whole calculation and refuses a feed that does not continue the newest data file.

---

## 4. Artifacts: receiving more or less, with or without one

An Artifact is an optional NFT (Metaplex Core) that you forge on X1 with XNT. **You do not need one to burn or to play.** It is an optional purchase, not a source of income: half of its price is spent the day you forge it.

**Today (v2, live):** a held Artifact raises its holder's share of a payout round (+5% / +10% / +20% / +50% by tier, inside the same budget), grants weekly lottery chips, and is the ticket to Duels and Moon Wars; the forge price splits 50% floor / 40% reward pool / 5% Burn Lottery / 5% architect. Forging and the Genesis claim are paused on the site until the final upgrade; recycling works.

**From the final upgrade (planned 2026-11-18):**

| Tier | Max alive | Base price | Price moves | Minimum | Maximum |
|---|---|---|---|---|---|
| Lunar Dust | 600 | 10 XNT | +2% per forge, −1 step per quiet day | 3 XNT | 100 XNT |
| Cosmic Shard | 300 | 25 XNT | +5% per forge, −1 step per 3 quiet days | 12.5 XNT | 250 XNT |
| Solar Core | 90 | 60 XNT | +5% per forge, −1 step per 7 quiet days | 30 XNT | 600 XNT |
| Void Anomaly | 10 | 200 XNT | +5% per forge, −1 step per 14 quiet days | 100 XNT | 2,000 XNT |

- **Where the forge price goes:** 50% stays inside the Artifact as its **floor**, 20% to the reward pool (every burner benefits), 25% to the extra pot, 5% to the architect. A tier never forged starts at its base price on 2026-11-25 00:00 UTC and falls from then.
- **Floor and recycle:** recycling through Moon Forge destroys the NFT and gives you back its floor (half of the price you paid) plus the record's rent, at any time, no fee, no waiting. The slot is freed and anyone can forge into it again at the current price, which sends another 20% to the reward pool and 25% to the extra pot. Burning an Artifact in a wallet app instead sends its floor to the reward pool.
- **No boost, no chips, no game ticket.** An Artifact never changes what the reward pool pays for a burn: a holder and a non-holder are paid exactly the same for the same burn (the oracle's property tests NFT-1 and NFT-2 check this on randomized cases).
- **What it can add: a weekly rebate from the extra pot**, tied to the holder's own burns (oracle policy, limited on-chain). Only for a forged Artifact (not Genesis, not a Forge Drop, not one forged before the upgrade), held by the same wallet at two weekly snapshots in a row, in the first 52 weeks after its forge; only for burns whose X1 destination is the wallet that holds it; only for the part of those burns the reward pool did **not** pay. Counted use is at most 1% of the price paid per Artifact per week, and the rebate at most 2 XNT per counted XNT, so at most **2% of the price paid per Artifact per week**, while the pot lasts. It is not promised and can stop. Nothing is eligible in the first extra week, so the earliest rebate comes with the second rules-3 payout.
- **Native market:** escrow-free; 93% to the seller (never below the floor), 5% to the architect, 2% to the reward pool. Other marketplaces may honor the collection's 5% royalty.

**As a group, forgers get back less than they pay.** Of every 100 XNT forged, at most 75 XNT can ever come back to forgers as a group: 50 XNT of floors when they recycle, plus at most the 25 XNT that go to the extra pot (paid out only as capped rebates, at most 8% of the pot a week). 20 XNT go to all burners and 5 XNT to the architect.

**Receiving more or less, three cases** (illustrative: one burn counted at 8 XNT, so its Launchpad part is 10 XNT; a Solar Core forged at 60 XNT: floor 30, counted use capped at 0.6 XNT a week, rebate at most 1.2 XNT a week). A week in which the reward pool pays the whole 10 XNT needs a free pool of at least 125 XNT; on 2026-11-02 it held about 6.5 XNT, and the extra pot does not exist before the upgrade.

| | (a) Burner, no Artifact | (b) Same burner, holding the Solar Core | (c) Holder who does not burn |
|---|---|---|---|
| Quiet week (the reward pool pays the whole 10 XNT) | 10 | 10 (the Artifact adds nothing) | 0 |
| Busy week (the reward pool pays only 4 XNT) | 4 | 4 + 1.2 rebate = 5.2, if the extra pot has enough (a Void Anomaly instead: 4 + 4 = 8) | 0 |
| Cost | the XEN | the XEN + half the forge price (the other half is the floor you can take back) + small rents | half the forge price + small rents |

**The limit of the rebate.** The rebate can only partly offset the half of the price you spend, and only in weeks in which your own burns were not fully paid. Even at the maximum rate it would take 25 such weeks in the 52-week season to match that half; below about 0.48× the maximum rate (0.96% of the price a week) the season can never match it. The ratio is the same for every tier and price.

**The Core dependency and the hatch.** Recycling burns the Artifact through Metaplex Core, an upgradeable program on X1 that Moon Forge does not control (on 2026-11-02 its upgrade authority is `X1CoGMN7cayVJzu1q71Qkeivcv745JvRtbd696nDuCf` and it was last deployed at slot 40,582,994). From the final upgrade, if Core is **closed while it is still owned by the upgradeable loader** (its ProgramData account gone), recycling still pays the floor to the holder without Core (the holder adds Core's ProgramData account; the agent kit does it by itself). A Core first moved to another loader and then closed opens no hatch. If Core is instead upgraded so that its burn or its asset layout breaks while it still runs, floors wait until Core works again, and after the freeze nothing in Moon Forge can change that ([KNOWN-ISSUES.md](KNOWN-ISSUES.md) OPS-6).

**Genesis Lunar Dust** (the only airdrop: up to 120, for the 444 X1 validator withdraw authorities published on 2026-10-12; claims through 2026-12-31 under the live program and through 2027-03-31 from the final upgrade): a collectible with no floor and no rebate. Details: [NFT.md](NFT.md).

---

## 5. Games: "I only want to play"

**Adults only (18+, or the legal age for games of chance where you live), and only where such games are legal.** Every game can lose the whole stake. House games have a built-in edge, so players as a group lose. If it stops being fun, stop.

**Steps**

1. Read the play notice on the [Games page](https://xen-moon-forge-protocol.github.io/Moon-Forge/games/) (a one-time, self-attested 18+ and jurisdiction check stored only in your browser; nobody verifies it).
2. Get an X1 wallet (X1 Wallet, or Backpack with the X1 RPC) and some XNT for the stake, fees and rents. Everything inside Moon Forge is XNT: no chips, no token.
3. Deposit XNT into your game wallet (the first deposit creates it, about 0.0018 XNT of rent that is not refunded).
4. Play. Wins, refunds and payouts land in your game balance.
5. Withdraw your game balance to your wallet at any time (only you can).

**What you can play**

| | Today (v2, live) | From the final upgrade (planned 2026-11-18) |
|---|---|---|
| House games: Coin Flip, High-Low, Void Rush | open; the result comes from the hash of the block after the bet; a bet not settled within about 3 minutes counts as lost (settle your own bet) | shown on the site **only while the chain shows a live house keeper**, read from X1 on every visit: seat armed, a bond of at least 20 XNT, active within 28 days, no bond withdrawal announced, no more than 32 draws waiting for a reveal, and its service levels kept on the bets pending now (anchor within 150 slots, reveal within about 10 minutes). No keeper is armed at the upgrade, and none is scheduled: this may never happen |
| Jackpot | open | the same live-keeper condition; pot at most 20 XNT a round |
| Artifact Duel | a live Artifact is the ticket (forging is paused on the site) | sealed choices on the site, **no Artifact and no keeper needed** |
| Moon Wars (card game, both sides see everything) | real-XNT matches paused on the site; free practice open | sealed real-XNT matches on the site under a chess clock, no Artifact and no keeper needed; free practice open |
| Burn Lottery | open | no new entries; a round open at the upgrade still settles |
| Predictions | not on the site or in the kit; the program still accepts entries sent to it directly and takes a 2% rake when someone wins | the same, with the rake split 1.5% reward pool / 0.5% architect |

**Player against player, or against the house.** In the **Duel** and **Moon Wars** you play another person (or another person's bot) for equal stakes of at least 0.1 XNT; the program takes 2% of the pot only when someone wins (from the final upgrade: 1.5% to the reward pool, 0.5% to the architect); a draw is refunded in full. The **Duel** is like rock-paper-scissors with four elements (Lunar beats Void, Void beats Solar, Solar beats Cosmic, Cosmic beats Lunar; same or opposite element is a draw). From the final upgrade both choices are sealed: the joiner must open its choice within 10 minutes, or the creator is refunded and the joiner's stake goes to the reward pool; the creator must reveal within about an hour, or the joiner wins the pot. **Moon Wars** is a game of skill: both decks are public once the match starts, every move is checked by the program, and from the final upgrade each side has 30 free seconds per turn plus a 300-second bank. In the **Jackpot** the winner is drawn in proportion to what each entered. In **house games** you play the bankroll.

**Odds and edge (house games).** The edge is built into the odds: on average a player gets back 98 XNT per 100 XNT staked at Coin Flip and High-Low, and a little less at most Void Rush targets; no strategy, setting or bot changes that.

| Game | You choose | Win chance | Pays |
|---|---|---|---|
| Coin Flip | a side | 50% | 1.96× |
| High-Low | a chance from 1% to 95% | as chosen | 0.98 ÷ chance (25% → 3.92×) |
| Void Rush | a target from 1.05× to 100× | 98% ÷ target, rounded down to 0.01% | the target; because of the rounding, most targets pay back slightly under 98% (the worst 97.01%, at 98.99×) |

**Limits that protect the bankroll** (from the final upgrade; a refused bet takes nothing): minimum stake 0.01 XNT; a bet can win at most 0.25% of the free bankroll; all pending payouts at most 5% of it; counting every open bet as won, the bankroll may lose at most 3% per UTC day and 15% over 7 days. "Bankroll cannot cover this bet" means the stake is too large for today's bankroll; a smaller one may pass.

**The keeper, and what happens if it fails** (from the final upgrade). House results come from a chain of secret values the keeper commits to before any bet, mixed with the hash of the block after your bet: neither you, nor the keeper, nor the block producer alone knows the result when you stake. Anyone can anchor a bet (mix in that block hash) and trigger refunds; only the keeper, which holds the secrets, can settle. One residual is disclosed: a keeper that colludes with (or is) that block's producer can influence a result, bounded by the limits above and borne by the bankroll. If the keeper does not reveal an anchored bet within about one day, the bet is **paid to you as a win** from the keeper's bond; a bet nobody anchored within about 3 minutes is refunded in full. If the SlotHashes sysvar ever stopped working, the same expiries still happen after about a day instead of never. Until 2026-12-16 00:00 UTC only the key compiled into the build can create the keeper seat; from then, if no seat was ever created, **anyone** can create it with its own chain of secrets and a bond of at least 20 XNT, at the risk of that bond. A keeper with no arm, reveal or settle for 28 days can be replaced by anyone with nothing pending and a bond of at least 20 XNT.

**Honest expected value.** House games: on average you lose 2 to 3 XNT per 100 XNT staked, depending on the game and the target. Luck in the short run is real: after 100 one-XNT coin flips the expected result is −2 XNT with a typical swing of ±9.8 XNT, and about 38% of players would be ahead; after 1,000 flips only about 25%. Duel with random choices: half the duels are draws, and on average you lose about 1% of the stake. Jackpot: −2% of what you entered. Moon Wars: a game of skill between two players, minus 2% of decided pots and move fees. Network fees matter on small stakes.

**Be the House** (deposit at least 1 XNT into the bankroll): you share the bankroll's wins and losses and can lose part of your deposit. Nothing is promised. Withdraw by request, then wait 24 hours (from the final upgrade the withdrawal must then be made within the next 24 hours, or requested again). While no house keeper is live, a deposit sees no house bets.

---

## 6. Legacy Pilot

*Planned, dated: applies from the first rules-3 payout (planned 2026-11-22) only if the public list of addresses is built and its hash pinned in the oracle before that payout is built. As of 2026-11-02 the list is not built yet, so the rule is not in force.*

**What it is.** A one-time recognition for people who burned XEN before Moon Forge's final rules. **Eligible:** any EVM address that burned XEN (a transfer to the zero address recorded by XEN's own contract) on Ethereum, Base, Optimism, Polygon, BSC or Avalanche before **2026-11-01 00:00 UTC**. Old burns are still not paid as burns; the Legacy Pilot adds to new ones:

1. **A top-up on a new burn.** The first new burn of a listed address through a Moon Forge portal (from the same EVM address, on one of the five chains) that is paid under the rule receives **up to 50% more than the normal rules pay that burn**, as Launchpad XNT to the X1 wallet the burn names. Burns paid under the current rules do not count. A top-up of any size, even a partial one, uses the address up; a burn that receives no top-up leaves the address eligible for a later burn.
2. **A rebate on a new Artifact** (from the final upgrade): an X1 wallet named in a burn of a listed address receives **20% of the forge price** of the first new Artifact (forged after the upgrade, in the week of such a burn or later) that it holds at a weekly snapshot; once per wallet and once per address.

Nothing to claim, sign or pay: the oracle applies it to the payout files, and the keeper claims as for any payout. Nobody acting for Moon Forge will ever ask you to sign or pay for it.

**Where the money comes from (disclosure).** Top-ups come only from the week's capacity left over after every normal payout, at most 25% of that leftover, and none in a week the pool falls short; when that is short, earlier burns are served first (one may be paid in part). Nobody receives less in the week a top-up is paid: every burn's payout, the week's capacity and every other payout are the same as without the rule (the oracle's test LEGACY-1). But that leftover would otherwise stay in the pool, and each week's capacity is 8% of the pool, so the pool grows a little more slowly and some later weeks can have a slightly lower capacity. Artifact rebates come only from what the extra pot's weekly release leaves after the normal holder rebates, inside the program's limits (8% of the pot, and 4% a week of the floors of Artifacts forged after the upgrade); what a week cannot pay is paid in later weeks, oldest claim first (test LEGACY-2: no other holder receives less that week). In the project's 104-week simulation (`oracle/test/regression-104.test.ts`, totals over the 104 weeks), the rule paid 140.75 XNT: 4.75 XNT of burn top-ups and about 136 XNT of Artifact rebates from the extra pot; later burners received 4.27 XNT less and holders 0.04 XNT more, with changes in 64 later weeks; the test checks that what everyone else together receives less never exceeds what the rule paid. No payout is promised.

**Check your address.** The list will be `deployments/legacy-burners.json` in this repository (its `addresses`, lowercase, sorted), built on GitHub by the "Legacy Pilot snapshot" workflow from public reads of XEN's contracts. `node scripts/legacy/build-snapshot.mjs check deployments/legacy-burners.json` recomputes its sha256; anyone can rebuild it, and the same reads give the same bytes. Every payout file built under the rule records the rule, the list's sha256, the listed addresses of its burns and every top-up, and `npm run verify -- <file> --full` checks them.

---

## 7. Chains

| Chain | Chain id | XEN contract | Portal |
|---|---|---|---|
| Base | 8453 | `0xffcbF84650cE02DaFE96926B37a0ac5E34932fa5` | `0x7b00f314aB48D223bee567181CA89c65126Bf6E9` |
| Optimism | 10 | `0xeB585163DEbB1E637c6D617de3bEF99347cd75c8` | same address |
| Polygon | 137 | `0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e` | same address |
| BNB Chain (BSC) | 56 | `0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e` | same address |
| Avalanche | 43114 | `0xC0C5AA69Dbe4d6DDdfBc89c0957686ec60F24389` | same address |

The portal is the same contract on all five, deployed 2026-10-07, source verified on Sourcify (exact match): no owner, admin, fee, pause or upgrade. It calls XEN's own `burn()`, so the XEN leaves that chain's supply for good and the burn is credited to your EVM address in XEN's own `userBurns` ledger, which anyone can read. Each chain's XEN is valued on its own market by the same rule. **Never send or approve XEN to that address on any other chain:** the address is only ours on these five.

**Fresh burns only.** Only burns made through these portals, from each chain's start block, are paid. Burns made before, or anywhere else, are not counted here (the Legacy Pilot of section 6 is a separate, one-time recognition on new burns). A burn here is paid only under Moon Forge's rules; Moon Forge does not promise that it counts in any other program, so check each program's own rules before you choose where to burn which XEN.

**Can I burn Ethereum XEN here? No.** Moon Forge launched with XEN on five side chains. Ethereum XEN already has its own path in the XEN ecosystem. Ethereum and PulseChain have no Moon Forge portal (project decision of 2026-10-20), and none is planned by this project; Moonbeam XEN is not supported either (it has no XEN market to value burns against). If other XEN or X1 programs open paths for these chains, holders can use them too.

**How the community could add a chain.** This project adds no chain to this instance, before or after the freeze. The community route is a separate instance: the code is MIT-licensed and the portal contract has no owner, so anyone can deploy portals on another chain with a priced XEN market and run their own program, oracle and pool ([FORK.md](../FORK.md); running an oracle: [OPERATORS.md](../OPERATORS.md)). For readers who check: the X1 program itself has no list of chains; the list lives in the open-source oracle settings, every payout file names the chains it read, and under the v3 rules a checker running the published verifier flags any chain it does not know ("not a configured chain").

---

## 8. Nobody in control after the freeze

**Today** the X1 program can still be replaced by one upgrade key, held by the anonymous builder; until the freeze that key could replace the code, including code that moves the pools. From the final upgrade it moves to a new deploy key, kept offline and never in GitHub, used once more for the **freeze**: the upgrade authority and the IDL authority are burned, earliest **2026-12-02**, after the mainnet proof plan and 14 stable days, and no later than **2026-12-31** ([IMMUTABILITY.md](../IMMUTABILITY.md)). The builder leaves after the freeze. The portals are already immutable.

**After the freeze, no key can:**

- take XNT out of the reward pool, the extra pot, the bankroll, a game pot or an Artifact's floor, except by the program's own rules (claims of published payouts, the tips and allowance above, game settlements and refunds, Be the House withdrawals, recycles);
- create XNT, or change any fee, split, odd, price rule, limit, delay or bond (they are fixed in the program's code);
- pause the program (there is no pause);
- let anyone claim before 48 hours after a round's publication, or publish a round above 10% of the free pool or sooner than 6 days after the previous one;
- send a payout to anyone but the wallet named in it;
- veto anything: there is no veto instruction, neither against a void during a round's hold nor against the takeover of a dead oracle seat;
- make the oracle key and the architect payee the same key;
- change the Genesis list or, through Moon Forge, the collection royalty;
- change the EVM portals, or upgrade the program.

**What remains, and how it is limited:** an **oracle seat** whose hot key publishes the weekly rounds within the limits above; anyone can void a round during its 48-hour hold by paying a bond into the pool (10% of its budget, at least 0.05 XNT; 1 XNT for an empty round), whether the round was right or wrong; a **cold key** that can replace a stolen hot key and void for free; a **house keeper**, once someone arms one; and the **architect payee**, which can only move or renounce its own address. The oracle's valuation rules stay off-chain policy, changed only with the notice described at the top of this guide and always inside the on-chain limits. Honest limits: a wrong round that nobody voids within 48 hours pays out like a real one (at most 10% of the free pool), and a stolen cold key is worse than a stolen hot key.

**Fees: who receives what** (from the final upgrade; fixed in the program's code)

| Activity | Reward pool | Extra pot | Architect | Others |
|---|---|---|---|---|
| Burn → claim → release → withdrawal | pays out | — | **0** | — |
| House games (2% edge in the odds) | 1% of the stake | — | 0.5% | 0.5% stays in the bankroll |
| Jackpot, Duel, Moon Wars, Predictions (only when someone wins) | 1.5% of the pot | — | 0.5% | — |
| Artifact forge | 20% | 25% | 5% | 50% floor, back to whoever recycles |
| Native market sale | 2% | — | 5% | 93% to the seller |
| Donations | 100% to the chosen vault | never | 0 | — |

**Zero protocol fee on the burn path**, today and after the upgrade. The architect payee receives nothing from burns, claims or either pot: only the disclosed cuts of optional activity above (today: 0.5% of house stakes, 0.5% of decided player-versus-player and Predictions pots and of Burn Lottery tickets, 5% of forge prices, and a 5% royalty where marketplaces honor it). There is no architect vault: each cut is paid straight to the payee wallet in the same transaction (to the reward pool instead if that wallet would sit below rent); from the final upgrade the payee can also renounce for good by naming the reward pool. Built for the community, by one anonymous builder who receives these disclosed cuts. The pool's running costs (claim tips; from the final upgrade also the oracle allowance and the house keeper's settle tip) go to the oracle key and to whoever runs a keeper, never out of your payout.

---

## 9. Check it yourself

Each check below needs only public data and open tools, not the project's word. What you still have to trust is listed in section 10.

- **Who can change the program:** open the program on the [X1 explorer](https://explorer.mainnet.x1.xyz/address/57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9), or run `solana program show 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 -u https://rpc.mainnet.x1.xyz`. Today it shows an upgrade authority; after the freeze it shows none. The Start and Transparency pages read it live.
- **The deployed bytes are the published source:** at the build commit (tag `program-2026-11-18`, published at least 48 hours before the upgrade with its hashes), run `cargo test -p moon-forge --lib`, `bash tests/check-mainnet-guards.sh --final`, `SOURCE_DATE_EPOCH=0 cargo build-sbf --manifest-path programs/moon-forge/Cargo.toml`, then compare `sha256sum target/deploy/moon_forge.so` and `solana-verify get-executable-hash target/deploy/moon_forge.so` with the published values; after the deploy, `solana-verify get-program-hash -u https://rpc.mainnet.x1.xyz 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9` must print the same executable hash ([UPGRADE-2026-11.md §2](UPGRADE-2026-11.md#2-source-binary-and-how-to-check-the-hash)).
- **Every weekly payout:** `cd oracle && npm install && npm run verify -- ../frontend/public/epochs/epoch-N.json --full` recomputes every payout and the round's fingerprint from the burns on the five chains and compares them with X1. The portals' addresses and start blocks come from `deployments/portals.json`, so no setting is needed.
- **The portals:** Sourcify exact match on [Base](https://repo.sourcify.dev/8453/0x7b00f314aB48D223bee567181CA89c65126Bf6E9), [Optimism](https://repo.sourcify.dev/10/0x7b00f314aB48D223bee567181CA89c65126Bf6E9), [Polygon](https://repo.sourcify.dev/137/0x7b00f314aB48D223bee567181CA89c65126Bf6E9), [BSC](https://repo.sourcify.dev/56/0x7b00f314aB48D223bee567181CA89c65126Bf6E9), [Avalanche](https://repo.sourcify.dev/43114/0x7b00f314aB48D223bee567181CA89c65126Bf6E9); list in [deployments/portals.json](../deployments/portals.json).
- **The burns are real:** each portal's `getStats()`, and XEN's own `userBurns(address)` on that chain.
- **The public counter:** [counter.json](https://xen-moon-forge-protocol.github.io/Moon-Forge/counter.json) (from the next site release) gives the XEN removed from supply through Moon Forge per chain and the XNT the published payouts set aside, computed only from the payout files and rebuilt at every site build.
- **Where the money is:** the reward pool [`CScsBfpj63Mppem9Bmddmfi87bkcAfeLevdSauYMDsHR`](https://explorer.mainnet.x1.xyz/address/CScsBfpj63Mppem9Bmddmfi87bkcAfeLevdSauYMDsHR) on the X1 explorer, and the Transparency page.
- **What is known to be wrong or risky:** [KNOWN-ISSUES.md](KNOWN-ISSUES.md); every public claim and its evidence: [CLAIMS.md](CLAIMS.md).

**Signs of a scam** (none of these is Moon Forge): a new program id, token, presale, token airdrop or claim page; anyone who messages you first; any request to sign or pay to "claim old burns" or the Legacy Pilot; an approval for more than the burn amount. Official places: the site, the GitHub repository and the X account [@MoonXenForge](https://x.com/MoonXenForge), which plans no posts; no chat group is official.

---

## 10. Risks, honestly

- **The pool is small.** On 2026-11-02 it held about 6.5 XNT: one week can pay at most about 0.5 to 0.65 XNT to all burners together.
- **A burn cannot be undone.** The XEN is gone for good.
- **The payout can be less than selling**, late, or nothing: a week's capacity is limited, the part beyond it is not carried over, scripts can take a day's slice first, and if no round is published nothing new is paid.
- **XNT is volatile and thin.** You receive a fixed number of XNT; its dollar value later can differ. Orbit and Moon Landing lock XNT whose value can fall; leaving early costs 60% or 75% of the part not yet released.
- **No third-party audit.** The reviews are internal (single author, AI-assisted) and public. Bugs are possible, none can be fixed after the freeze, and the builder leaves then.
- **The oracle is trusted within limits.** A wrong round that nobody voids within 48 hours pays out like a real one (at most 10% of the free pool). Every void by anyone but the seat's cold key pays its bond into the pool, whether the round was right or wrong, and a voided round's burns are not paid later.
- **The rules can change** (valuation, capacity, the rebate): they are oracle policy, changed only with the notice described at the top of this guide, never backwards, always inside the on-chain limits. Until the freeze, the program itself can still be replaced.
- **GitHub dependence.** If the GitHub account falls, the site, the oracle, the keeper and the payout files stop; payouts pause; the pools stay locked in the program; from the final upgrade, once no round has survived its hold for 28 days, the largest voider can take the oracle seat from day 28 and anyone from day 29, with a bond.
- **Outside programs.** Artifact floors depend on Metaplex Core (OPS-6); the whole program depends on X1 continuing to run its binary and its runtime features (OPS-7); house bets and draws depend on the SlotHashes sysvar, with a one-day fallback from the final upgrade (OPS-8). After the freeze, only X1 and Core can fix a break in them.
- **Prices come from markets.** XEN prices come from GeckoTerminal, with an on-chain fallback; XNT from the XDEX pool and x1report. A thin or manipulated market moves valuations within the published caps.
- **Games are games of chance or player-versus-player stakes.** 18+ and only where legal. You can lose the whole stake; Be the House can lose part of a deposit; house games may stay hidden on the site for good.
- **Taxes and local law** are your own responsibility.
- **Usage so far:** epoch 1 had a single burn. It is not evidence of demand.

The full register: [KNOWN-ISSUES.md](KNOWN-ISSUES.md).

---

## 11. How the community keeps it running

Moon Forge is built so that nobody has to ask permission to keep it going. Today anyone can run the keeper, recompute every payout and host the site; publishing a payout round still needs the oracle key. From the final upgrade:

- **Run the keeper:** `cd oracle && npm run keeper` with any funded X1 key claims every payout for its burner, runs game steps and closes old rounds. Funds always go to the player named on-chain; the pool pays small tips for claims made for others.
- **Check and void:** anyone can recompute each round with `npm run verify` during its 48-hour hold and void a wrong one by paying a bond (`npm run void-epoch`).
- **Take over a silent oracle:** if no round survives its hold for 28 days, the largest voider can take the oracle seat from day 28 and anyone from day 29 (`npm run take-seat`), with a bond of 10% of the free pool (at least 1 XNT), and keep publishing with the same open code on the same pools. Nobody can veto it. A quiet week does not count against a working oracle: it publishes an empty round.
- **Become the house keeper:** from 2026-12-16 00:00 UTC anyone can create a keeper seat that was never created, with a bond of at least 20 XNT (`npm run keeper-arm`); a keeper with no arm, reveal or settle for 28 days can be replaced by anyone with nothing pending and the same bond (`npm run keeper-take`).
- **Host the site and the payout files:** the code is MIT-licensed; the agent kit reads payout files from any mirror and checks every payout against the fingerprint stored on X1, so a mirror cannot forge payouts.

There is no on-chain rule that pays the pools without an oracle: if nobody ever takes the seat, the pools stay in the program, unpaid. Commands, schedules, keep-alive rules and what to do when something breaks: [OPERATORS.md](../OPERATORS.md). A separate instance: [FORK.md](../FORK.md).
