# Final program upgrade, November 2026

*Published with the commit tagged `upgrade-review-2026-11` (the publication time is when that commit reached the repository's `main` branch, UTC, as GitHub's public event log shows), by 2026-11-04 16:00 UTC, at least 7 days before the upgrade. Planned upgrade window: Wednesday 2026-11-11, 16:00–20:00 UTC (the earliest date; the same hours a week later, 2026-11-18, if a gate is not green). Until the upgrade transaction exists, everything in this file under "after the upgrade" is a plan, not the program that runs. Today the program is v2 (tag `program-2026-10-12`, last deployed at slot 85,429,880) and the oracle runs the v2 reward rules.*

This is the announcement of the last upgrade of the Moon Forge program `57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9` on X1. It gives the source to review, the procedure to rebuild the binary and check its hash, the full list of changes, what happens to every kind of account that exists today, and the review window. After this upgrade the program is observed on mainnet and then frozen (earliest 2026-11-25, no later than 2026-12-31: [IMMUTABILITY.md](../IMMUTABILITY.md#when-the-upgrade-authority-will-be-burned)). The technical specification is published with the upgrade as `docs/spec/UPGRADE-2026-11.md`.

What this upgrade does not change: the reward rules the oracle applies. The v3 reward rules are a separate, off-chain change with their own dated notice, published in POLICY-CHANGES.md with the announcement; the first epoch under them can only be published by the upgraded program, so it comes no earlier than the first Sunday after this upgrade is deployed and checked, and it is announced at least one full epoch ahead with the last v2 publish transaction. The program id, the five EVM portals and the burn path do not change. Zero protocol fee on the burn path stays.

## 1. In one table

| | Today (v2) | After the upgrade |
|---|---|---|
| Claims | open as soon as an epoch is published | open **48 hours** after publication; during those 48 hours anyone can check the epoch and void a wrong one (section 3.2) |
| Oracle key | publishes; can hand its role to a new key; nothing can remove it | the same, inside an **oracle seat**: an offline cold key can replace a stolen hot key, and a seat with no surviving epoch for 28 days is dead and can be taken with a bond (section 3.2, rules 3 and 4); a week without burns does not count against it (an empty base epoch keeps it alive); nobody can veto; the publishing key receives a small operating allowance from the free pool (section 3.1) |
| Forge Drops | 10% of each epoch budget drawn as Lunar Dust | off for every epoch published by the new program; drops of earlier epochs stay claimable |
| Forge price split | 50% floor / 40% reward pool / 5% Burn Lottery / 5% architect | 50% floor / 20% reward pool (base pot) / 25% extra pot / 5% architect / 0% lottery |
| Artifact prices | Lunar Dust fixed at 10 XNT; others +5% per forge, ÷1.05 per quiet week, never below base, at most 100× | every tier moves: up per forge, down per quiet period, down to a fixed minimum (30% of base for Lunar Dust, 50% for the others), at most 10× base |
| Artifact utilities | burn boost (oracle), weekly chips, arena ticket | no chips, no ticket; under the v3 oracle rules (first epoch announced separately), wallets that hold a forged Artifact and burn XEN can receive a weekly usage rebate from the extra pot, which only forges fund, computed by the oracle and bounded on-chain (section 3.3); until that epoch the extra pot only receives |
| Native Artifact market | none | escrowless listings: the buyer pays the price, 93% to the seller (never below the floor), 5% to the architect, 2% to the base pot |
| House games randomness | hash of a later slot | a keeper hash chain with a 20 XNT bond; a bet the keeper does not reveal is paid to the player from the keeper's bond; the keeper receives a small settle tip per settled bet from that bet's own pool share (section 3.5) |
| House limits | 0.25% per bet, 20% pending, −10% daily breaker | 0.25% per bet, 5% pending, −3% daily breaker counting open bets as won, −15% over 7 days |
| Jackpot | uncapped pot, future-slot draw | at most 20 XNT per round, drawn on the keeper chain, refunded if the keeper fails |
| House games and the Jackpot on the site | house games and the Jackpot offered | no keeper is armed at the upgrade, so both stay hidden on the site until a keeper that runs continuously has met its published service levels for a week (section 3.5) |
| Burn Lottery | tickets and chips | new tickets retired; a round open at the upgrade still draws and settles |
| Duel, Moon Wars | an Artifact is the ticket; plain joins | no ticket; sealed joins (commit, then reveal), offers expire after 24 hours, chess clock in Moon Wars |
| Predictions | v1 rounds; not offered by this project | v2 schedule with a side cap, a 20-minute average price window and a no-contest band; still not offered by this project |
| Be the House | 24-hour cooldown, request never expires | 24-hour cooldown, then the request must be used within 24 hours |
| Keeper tip on claims | 0.002 XNT per claim of at least 0.02 XNT submitted for someone else | 0.002 XNT per claim of at least 0.2 XNT, never when the submitter is the player or the oracle |
| Architect payee | fixed at initialization | can be rotated (old and new key sign) or renounced to the reward pool for good |

## 2. Source, binary and how to check the hash

| Item | Value |
|---|---|
| Source to review | the commit tagged `upgrade-review-2026-11`, the one that publishes this file: the complete program, with the build-time values still placeholders in `constants.rs` |
| Build commit | tag `program-2026-11-11` (`program-2026-11-18` if the window moves by a week); the commit itself is published at S2, by Monday 2026-11-09 16:00 UTC, at least 48 hours before the upgrade (earlier notices said 7 days: section 3.9) |
| What the build commit adds | only the values that must be fixed at build time, in `programs/moon-forge/src/constants.rs`: `INITIAL_KEEPER`, `SEAT_COLD_INITIAL`, `SEAT_REFUND_INITIAL`, `METADATA_BASE_URI`, `PRICE_LAUNCH_TS`, plus the `Cargo.lock` that `cargo build-sbf` writes. `git diff upgrade-review-2026-11 program-2026-11-11` shows nothing else |
| Binary | `target/deploy/moon_forge.so`; its size and sha256 are published at S2 |
| Executable hash | published at S2 (sha256 of the binary without its trailing zero bytes; what `solana-verify get-executable-hash` prints and what `solana-verify get-program-hash` reads from the chain after the deploy) |
| IDL | `anchor idl build --no-docs`, sha256 `9617cd5eaf80168026957ae77396fc72497e9c154de2f55432b0f571e793a72f`, 11,887 bytes compressed (the on-chain IDL account holds 16,214); the same file as `frontend/src/idl/moon_forge.v3.json` and `oracle/src/idl/moon_forge.v3.json` of this commit. The build-time values are not in the IDL, so the build commit must give the same hash; it is confirmed at S2 |
| Signed statement | the three hashes above, signed off-chain by the key that becomes the upgrade authority at the upgrade (its address is published in [SECURITY.md](../SECURITY.md) at S2, next to the command that checks the authority): published at S2 |

**Toolchain:** Agave solana-cli / `cargo build-sbf` 3.1.11, anchor-cli 0.32.1, Rust 1.94.0 for the host tests, on Linux (or WSL) in a path without non-ASCII characters. The mainnet build never uses `--features localnet`.

**Rebuild and compare (anyone):**

```bash
git clone https://github.com/xen-moon-forge-protocol/Moon-Forge && cd Moon-Forge
git checkout program-2026-11-11                                  # the build commit, published at S2
cargo test -p moon-forge --lib                                   # unit tests, mainnet constants
bash tests/check-mainnet-guards.sh --final                       # prints "S2 gate OK": no placeholder, no test key
SOURCE_DATE_EPOCH=0 cargo build-sbf --manifest-path programs/moon-forge/Cargo.toml
sha256sum target/deploy/moon_forge.so                            # = the sha256 published at S2
solana-verify get-executable-hash target/deploy/moon_forge.so    # = the executable hash published at S2
```

`bash tests/repro-build.sh` does the same from two fresh copies of the tree at two different paths, each with its own empty target directory, and fails unless both binaries are byte-identical. It was last run on 2026-10-25 with throwaway values in place of the build-time keys and URI: byte-identical (1,401,200 bytes), which shows the build does not depend on the path; the real hash exists only from the build commit.

**After the deploy (anyone):**

```bash
solana program show 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 -u https://rpc.mainnet.x1.xyz   # new last-deploy slot
solana-verify get-program-hash -u https://rpc.mainnet.x1.xyz 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9   # = the executable hash published at S2
```

If the deployed hash differs from the published one, nothing else runs: the deploy is stopped and diagnosed in public (section 7).

## 3. Changelog

Every number below is a compile-time constant in `programs/moon-forge/src/constants.rs` of the build commit; after the freeze none of them can change.

### 3.1 The burn path and base claims

- **48-hour claim hold.** No claim (Launchpad, mission, legacy drop, extra) is accepted before an epoch's publication time + 48 hours (`CLAIM_HOLD`). The 90-day claim window is unchanged, so 88 days of claims remain. Missions start vesting when they are claimed.
- **Forge Drops off.** `publish_epoch` keeps its exact interface and always writes a drop reserve of 0. The drop instructions (`seal_drop`, `claim_drop`, `claim_drop_xnt`) stay only for epochs published by the v2 program, under their published cap.
- **Keeper tip.** The pool pays 0.002 XNT to whoever submits a claim for someone else, now only for claims of at least 0.2 XNT, and never when the submitter is the player or the oracle key. The player's amount never changes.
- **Oracle operating allowance.** `publish_epoch` pays the publishing oracle key from the free reward pool: the new epoch account's rent back plus a top-up toward 0.25 XNT of at most 0.05 XNT, only from what the epoch's budget leaves of the 10% bound, never more than 1% of the free pool, and nothing while the oracle key is the architect payee (`ORACLE_TOPUP_TARGET`, `ORACLE_TOPUP_MAX`, `ORACLE_ALLOWANCE_BOUND_BPS`). It is paid only when the transaction passes the reward vault as writable, so an older client still publishes and receives nothing. The amount is booked with the keeper tips and reported in a new trailing field of `EpochPublished` (`oracle_allowance`). It is a running cost of the pool: not a fee on the burn path and never architect income.
- **Chips.** No instruction grants chips any more: not claims, not vesting withdrawals, not ejects, not bets.
- Unchanged: the on-chain budget (at most 10% of the free reward pool per epoch, budget and allowance together, at least 6 days apart, `total_score × rate_cap`), the Merkle leaves, vesting (45 / 180 days), eject penalties (60% / 75% of the unvested part to the pool), the 90-day window, `expire_epoch`, `close_receipt`.

### 3.2 The oracle seat

The oracle key keeps the publishing power it has today, plus the extra epochs of section 3.3, and gains no other power. New: one account, `OracleSeat` (`["oracle_seat"]`, address `EQ5BTUsYou2ndMw8SXdJVwNSz4nLABSuX6WxwT2doVGq`), created once by `init_seat` (anyone; the keys come from constants), and six instructions: `init_seat`, `rotate_hot`, `resign_seat`, `take_seat`, `void_epoch`, `void_extra_epoch`. The rules:

1. Every epoch waits **48 hours** after publication before anyone can claim from it. The epoch file, the root and the burn logs are public during that time, and `npm run verify` recomputes it from the five chains.
2. During those 48 hours, **anyone** can void the epoch by paying a bond of **10% of its full budget** (budget plus any drop reserve; minimum 0.05 XNT; for an extra epoch, 10% of the larger of its budget and the base epoch's) into the burners' reward pool. The epoch's money goes back to its pot. Nobody ever gets a bond back and nobody is paid for voiding. The seat's cold key voids for free; a cold void of a base epoch (given the previous epoch's account) lets the next base epoch be published at once instead of 6 days later, once per 6-day slot. A voided extra epoch with a budget still delays the next extra epoch with a budget by 6 days.
3. The seat is **dead** when no epoch published in the last **28 days** has survived its hold (silence, or every epoch voided; an epoch still in its hold does not count) and the seat was taken more than 28 days ago. A week without a paying burn does not count against the seat: the program accepts an empty base epoch (no leaves, budget 0), which the oracle publishes in such a week and which keeps the seat alive once it survives its hold like any other epoch. Anyone can then take it by posting a seat bond of **10% of the free reward pool** (minimum 1 XNT) and naming new keys, once the same is true over the last 29 days (28 days + 24 hours), even if nobody ever voided. The old key loses its powers in that transaction. **No one can veto**: not the old oracle, not the architect, not the owner.
4. Whoever paid the single largest void bond in the seat's lifetime (since it was last taken) has **24 hours of priority**: it can take the dead seat from day 28, everyone else from day 29.
5. A seat holder gets the bond back, to the refund address named when the seat was taken (the reward pool when none was named), only by **resigning from a living seat** (one with an epoch that survived its hold, published since the seat was taken and within the last 28 days). A seat that dies under its holder forfeits the bond to the reward pool.
6. The seat has a **cold key** (offline, never in GitHub) that can swap the hot key at any time and void for free. It cannot veto anything, and the hot key cannot change it. Whoever holds the cold key holds the oracle's power in effect: it can install a hot key of its own and, on a living seat, resign naming its own successor.
7. The hot key keeps its old self-rotation (`propose_oracle` / `accept_oracle`). It gains nothing by using it. Like `rotate_hot`, `take_seat` and `set_architect`, `propose_oracle` and `accept_oracle` refuse the architect payee, so the oracle key and the payee are never the same key.
8. The architect payee has **no** oracle power of its own. Its program actions are `set_airdrop_root` (used once on 2026-10-12, never again), `lock_collection_royalties` (once, at the upgrade) and `set_architect` (its own payee address only).

A stolen hot key therefore cannot be paid anything during the hold, and the cold key removes it in one transaction. A stolen cold key is worse: the thief can install its own hot key and publish within the bounds, void honest epochs for free and, while the seat is alive, resign it naming itself and take it with its own keys; only voids by others during each hold and the dead-seat rule stop it. Without the cold key, one person who runs `npm run verify` and pays about 1% of the pool per fake epoch stops it, and that money lands in the pool. If nobody checks within 48 hours, a fake epoch pays out like a real one (at most 10% of the free pool, 8% of the extra pot); the chain never knows which epoch is true. Quiet weeks alone do not make the seat takeable: in a week without a paying burn the oracle publishes an empty base epoch, so a healthy oracle keeps its seat; only silence or voids do.

### 3.3 The extra pot (two pots for Artifacts)

- **New vault** `extra_vault` (`GRGxMQDjNg4DwoL69y2p1x14fSzeaKeCHVLkAb67Z9d2`) and counter account `ExtraState` (`FF4CHxw1XgCMYv9Q48yB8qX4W19oDcGK2wrqZhEEvYrE`), created once by `init_extra` (anyone) before the first forge under the new program; forging is refused until it exists.
- **Only source:** 25% of every forge price. Never game edges, rakes, royalties, donations, penalties or base-pot money. The counters ignore any XNT sent to the vault by other means.
- **One extra epoch per base epoch**, published by the oracle right after it (`publish_extra_epoch`), at least 6 days after the previous one with money in it (a 0-budget heartbeat needs no interval), bounded **on-chain** by the smaller of 8% of the pot's free balance and, per 7-day week of the base window (at most 13), 4% of the floors of the live forged Artifacts plus the floors that left since the last publication. At most 1,000 leaves.
- **Claims** (`claim_extra`) wait the same 48 hours, pay the wallet in the leaf directly, are recorded as bits (no receipt account), can never exceed the epoch's published total, and close after 90 days (`close_extra_epoch`), when the unclaimed rest returns to the extra pot and the account rent to the oracle key that paid it.
- **Who receives it** is oracle policy (the v3 rules, from their first epoch), computed off-chain and published with every extra epoch: wallets holding a forged Artifact across two weekly snapshots, within 52 weeks of its forge, that burned XEN that week; only the part of a burn the base pot did not pay counts, capped at 1% of the Artifact's forge price per week, and the rebate is at most 2× the counted use (so at most 2% of the forge price per week), at the same rate for every tier: at most 2 XNT for each XNT of counted use, while the pot lasts. It is shared from one pot funded only by forges, it is not a return, and it can be zero in any week or stop. Model and numbers: `docs/NFT-MODEL.md`, published with the upgrade. These policy numbers are not program constants; the on-chain bound above is.
- The base pot (`reward_vault`) never pays the extra pot and the extra pot never pays the base pot. The architect receives nothing from either.

### 3.4 Artifacts

- **Forge split:** 50% floor kept inside the Artifact's record, 20% to the reward pool (base pot), 25% to the extra pot, 5% to the architect, 0% to the Burn Lottery. A compile-time assert checks that the shares sum to 100%.
- **Prices (every tier moves).** A forge multiplies the tier's price by the step; each full period without a forge divides it by the same step, down to the minimum; the price never exceeds 10× base; it does not fall while the tier is full (all slots alive). A tier with no forge yet starts at its base price on 2026-11-18 00:00 UTC (`PRICE_LAUNCH_TS`: the upgrade date + 7 days, set in the build commit; this source still holds 2026-11-24, and the value moves by a week with the window) and falls from then. The buyer signs a maximum price, so a move can only make a forge fail.

  | Tier | Max alive | Base | Step per forge | Down one step after | Minimum | Maximum |
  |---|---|---|---|---|---|---|
  | Lunar Dust | 600 | 10 XNT | +2% | 1 day | 3 XNT | 100 XNT |
  | Cosmic Shard | 300 | 25 XNT | +5% | 3 days | 12.5 XNT | 250 XNT |
  | Solar Core | 90 | 60 XNT | +5% | 7 days | 30 XNT | 600 XNT |
  | Void Anomaly | 10 | 200 XNT | +5% | 14 days | 100 XNT | 2,000 XNT |

- **Floor:** still 50% of the price actually paid, given back by `recycle_artifact`. Forging at a lower price gives a lower floor.
- **Attributes written at mint:** Tier, Element, Floor XNT, Forge Price XNT (2 × floor for a forged Artifact, 0 for Genesis and Forge Drops), Origin, Serial, Recyclable. No Burn Boost and no Weekly Chips attribute. Artifacts minted before the upgrade keep the attributes they were minted with: this binary has no instruction to rewrite them (0 existed on 2026-10-31; the census before the upgrade re-reads it).
- **Chips retired:** `claim_artifact_chips` returns `ChipsRetired`.
- **No arena ticket:** Duels and Moon Wars no longer require an Artifact.
- **Native market** (new: `list_artifact`, `update_listing`, `delist_artifact`, `buy_artifact`, `close_listing`): the Artifact never leaves the seller's wallet until it is sold; the listing account is its transfer delegate. The buyer pays the price exactly: 93% to the seller, 5% to the architect, 2% to the base pot (never to the extra pot). The seller's 93% may never be below the Artifact's floor, the price never below 0.1 XNT, and a listing expires after at most 90 days. Anyone can close a listing whose Artifact moved, was recycled or expired; the rent goes back to the seller. Every new Artifact is minted with the transfer-delegate plugin.
- **Royalty lock** (`lock_collection_royalties`, once): writes the collection's 5% Core royalty with the architect payee as its only creator, then locks the plugin so that nobody can change it through Moon Forge or Core's own instructions; an upgrade of Metaplex Core could. Marketplaces outside Moon Forge may still ignore royalties.
- **Orphans:** `reclaim_orphan` accepts only proof that an Artifact is gone (burned, closed, or no longer owned by Metaplex Core); a live or unreadable asset is refused.
- **Metadata:** the program points new Artifacts and, through `refresh_collection_uri`, the collection at an Arweave address published at S2 (one of the two sets of the permanent upload recorded in `deployments/nft-arweave-final.json`), checked for 7 consecutive days on two gateways before the build. The GitHub Pages copy stays online for the site.
- **Genesis airdrop:** unchanged list and rules (first 120 claims, no floor, origin "Genesis Airdrop"); claims stay open through 2027-03-31 (they close at 2027-04-01 00:00 UTC, `AIRDROP_DEADLINE` = 1,806,537,600; the deployed program closes them at 2027-01-01 00:00 UTC until the upgrade).

### 3.5 House games (Coin Flip, High-Low, Void Rush)

- **Keeper hash chain.** A keeper commits a chain of hashes with a bond (`arm_keeper`, at least 20 XNT, held in the `HouseKeeper` account `Hb8Er2uoJKEWDgkJPncFQa5sVidqr34NEatqEDqnhj85`). A bet (`place_bet_v2`) reserves the next position of the chain; the block after placement is mixed into the bet's seed by `anchor_bet` (anyone; the site does it about 2 seconds after placing); the keeper then reveals that position and the bet settles (`settle_bet_v2`, anyone with the reveal). The order is fixed so that neither the block producer nor the keeper alone knows the outcome before the anchor block exists. One residual remains: a keeper colluding with that block's producer, bounded by the limits below and borne by the bankroll. A keeper that bets itself, or shares its next reveal with a player, knows the outcome once the anchor block exists, but gains nothing from choosing which bets to anchor, reveal or let stall: every stall costs the keeper's own bond, never the bankroll, and the program's unit tests check that such a keeper's expected value is at most minus 1.5% of the stake under every strategy (the 1.5% that the pool and the architect take at placement; minus 2% before the keeper's own settle tip). That bound does not hold for a keeper that is also the X1 block producer of a bet's anchor block: it can build several versions of that block and keep the one whose hash makes its own bet win, because it knows its next reveal; mixing a second, later block hash would not help, because the producer of the last mixed block could grind it the same way. Anyone can anchor any bet.
- **If the keeper fails** (`refund_stalled_bet`, anyone): an anchored bet not revealed within about one day (235,000 slots), or a position the keeper skipped, is paid to the player as a **win** from the keeper's bond; the bankroll keeps the stake, as for a lost bet, and nothing goes to the pool. A bet nobody anchored within 512 slots (about 3 minutes) is refunded in full: the bankroll returns the stake minus the 1.5% taken at placement for the pool and the architect, and the keeper's bond pays that 1.5%; the bond also loses the stake minus that 1.5%, which nobody receives (it stays in the keeper account, and no instruction pays it out). So while no keeper is running, anyone can place house bets, leave them unanchored and have them refunded: nobody gains, but it burns the keeper's bond at no cost to whoever does it, until the bond no longer covers a bet and house games stop. The keeper's protection is to run continuously and anchor every bet within 3 minutes. The bond must cover every pending payout before a bet is accepted.
- **Keeper seat:** the keeper can withdraw its bond only after a 7-day notice and with nothing pending, and a hand-over to a new keeper also waits 7 days; a keeper with no arm, reveal or settle for 28 days can be replaced by anyone who arms a new chain with the minimum bond (`take_keeper`). While no keeper is armed, no house bet is accepted. A keeper that stays active keeps the seat even while it does not serve (no chain, a chain of one position, or a bond too small for new payouts), and then house bets and Jackpot draws stop.
- **No keeper at the upgrade (owner decision of 2026-10-25):** the house keeper is not armed at the upgrade and no keeper bond is posted, because of the residual above: a bond posted while no keeper runs could be drained at no cost. Without a keeper seat the program accepts no house bet, and a Jackpot round that ends refunds every entry, so there is nothing to drain. Only `INITIAL_KEEPER`, the key compiled into the build, can create the seat; it is armed only once a keeper has run continuously with that key (an always-on loop outside GitHub Actions) for at least 24 hours. **House games and the Jackpot stay hidden on the site until that keeper has met the published service levels (anchor within 150 slots, reveal within 10 minutes) for a week**, announced in a site release. No such keeper is scheduled: the project's own keeper runs on GitHub Actions, which is not continuous, and the bond can come only from project wallets (the architect payee's income or the deploy wallet's reserve), never from new owner money. If neither holds it, house games and the Jackpot stay hidden on the site, possibly for good. Either way, the exits of bets and entries made before stay available.
- **Settle tip:** for each bet settled by `settle_bet_v2`, the reward pool pays the registered keeper wallet the smallest of 0.0005 XNT (`KEEPER_SETTLE_TIP`), half of that bet's own pool share (0.5% of the stake) and the free pool; never on a refund, a stall or a skipped position. It goes to the registered keeper whoever sends the reveal, is booked with the keeper tips and is reported in a new trailing field of `BetSettled` (`keeper_tip`). It comes out of the 1% of the stake that the bet sends to the reward pool, so it lowers that inflow by at most half; it is a running cost of the pool, never architect income.
- **Limits:** at most 0.25% of the free bankroll per bet (unchanged); all pending payouts at most 5% of the bankroll (was 20%); the bankroll may lose at most 3% per UTC day, counting every open bet as won (was 10%, counted before open bets); and at most 15% over a rolling 7 days.
- **Legacy:** `place_bet` returns `KeeperRequired`; bets placed before the upgrade settle with `settle_bet` under the old rule (an unsettled bet still counts as lost after about 3 minutes).
- Unchanged: the 2% edge (1% to the reward pool, of which the settle tip above takes at most half; 0.5% to the architect; 0.5% to the bankroll), odds, minimum stake 0.01 XNT.

### 3.6 Jackpot, Burn Lottery, Duel, Moon Wars, Predictions

- **Jackpot:** a round's pot is capped at 20 XNT; the draw reserves a keeper-chain position (`draw_jackpot`, which now takes the keeper account) and the winner is fixed by the keeper's reveal (`settle_jackpot_v2`); a round the keeper does not settle within 512 slots refunds every entry and costs the keeper's bond the pot; a draw with more than 32 unrevealed positions ahead, or without keeper capacity, refunds at once without penalty; single-entrant rounds refund. Rounds drawn by the v2 program settle with the old `settle_jackpot`.
- **Burn Lottery:** `enter_draw` returns `LotteryRetired`. A round open at the upgrade draws, settles and closes under its own rules. The P2P rake's lottery share goes to the reward pool instead, so a 2% rake now splits 1.5% pool / 0.5% architect.
- **Duel:** joins are sealed (`join_duel_sealed`, then `reveal_duel_join` within 10 minutes; a joiner who never reveals forfeits its stake to the reward pool and the creator is refunded); the creator cannot cancel after a join; offers created after the upgrade can be joined for 24 hours; the creator still reveals within 1 hour. `join_duel` returns `SealedJoinRequired`. No Artifact needed.
- **Moon Wars:** new matches are sealed (`create_war_sealed`, `join_war_sealed`, `seed_war`, `reveal_war`): the decks and the first mover come from both players' secrets, with no block hash; a chess clock gives 30 seconds per turn free and a 300-second bank; lapses are settled by fixed rules (a joiner who never reveals loses; a creator who never seeds makes a draw). `create_war` and `join_war` return `SealedJoinRequired`. Matches started before the upgrade keep their 2-minute turns.
- **Predictions:** rounds created after the upgrade use the v2 schedule: entries 00:00–13:35 UTC, the start price is the 20-minute XDEX average ending at 14:00 UTC, the end price the one ending at 12:00 UTC the next day; each side of the pot is capped at 100 XNT; a move below 1%, a gap in the price record or a changed XDEX account refunds everyone. **Predictions stay off the site and out of the agent kit**; only claim and refund exits are offered.

### 3.7 Be the House, session keys, the architect

- **Be the House:** after the 24-hour cooldown, a withdrawal request must be used within 24 hours, then renewed (`WithdrawExpired`). Shares, deposits and pricing are unchanged (deposits priced as if every open bet loses, withdrawals as if every open bet wins).
- **Session keys:** unchanged (expiry and max stake set by the owner; house bets only, now through `place_bet_v2`).
- **Architect payee:** `set_architect` lets the payee move its own address (old and new key both sign) or renounce for good by naming the reward pool; it has no other power. At the upgrade the payee moves from the architect wallet to a key generated offline (its address published at S2), before the royalty lock writes it into the collection.
- **What the architect receives:** the same shares as today of house stakes (0.5%), decided P2P pots (0.5%) and forge prices (5%); new: 5% of native market sales (the same 5% the collection royalty declares); ended: 0.5% of Burn Lottery tickets. Nothing from burns, claims or either pot.

### 3.8 Interface totals

- Instructions: 92 = the 59 of today + 33 new. Six of today's instructions keep their discriminator and accounts but only return an error (`place_bet`, `enter_draw`, `join_duel`, `create_war`, `join_war`, `claim_artifact_chips`); `draw_jackpot`, `forge_artifact`, `recycle_artifact` and `reclaim_orphan` take additional accounts.
- Accounts: 23 (18 of today, none of which grows by a byte or moves a field; 5 new: `OracleSeat`, `ExtraState`, `ExtraEpoch`, `Listing`, `HouseKeeper`), plus the `extra_vault` lamport vault.
- Errors: 101, codes 6000–6100 (6000–6063 unchanged). Events: 39 (the 21 of today, two of which gain one trailing field each, `EpochPublished.oracle_allowance` and `BetSettled.keeper_tip`, which decoders of today's layout still read; 18 new).
- The full tables are published with the upgrade in `docs/spec/UPGRADE-2026-11.md`, generated from the IDL of this commit (`frontend/src/idl/moon_forge.v3.json`).

### 3.9 Announced earlier, not in this binary

Earlier dated notices planned a few items that this binary does not contain. They are listed so nobody relies on them:

| Earlier notice | What this binary does instead |
|---|---|
| "A recovery path if the oracle goes silent", "an oracle heartbeat", "a program-owned architect vault" (SECURITY.md, KNOWN-ISSUES OPS-4, SUPPORT.md) | the oracle seat (section 3.2: the empty base epoch of a quiet week is the only heartbeat) and `set_architect` (section 3.7); the architect payee is a wallet, not a program vault |
| "Upkeep tips from the architect's game cut" for third-party keepers (BOTS.md) | not from the architect's cut: the registered house keeper receives the settle tip from each settled bet's own pool share (section 3.5); third parties are tipped only for claims (section 3.1) |
| "A permissionless refresh for Artifacts minted before the upgrade" (KNOWN-ISSUES META-2, README) | none (0 such Artifacts on 2026-10-31; re-read by the census before the upgrade) |
| The binary hash published at least 7 days before the upgrade (README, `llms-full.txt`, REVIEW-2026-10.md, IMMUTABILITY.md) | the source commit, this changelog and the rebuild procedure at least 7 days before; the build commit and its hashes at least 48 hours before (section 2). The build commit fixes the Arweave metadata address, which is chosen only after its 7-day two-gateway check |

### 3.10 Powers that remain after the upgrade

One line per key, from the sections above. No key can pause the program or veto an epoch outside its hold.

- **Upgrade and IDL authority:** the offline DEPLOY_KEY, from the upgrade to the freeze (section 5). Until then it can deploy a corrective upgrade, announced the same way (section 7); the freeze removes both authorities in one transaction.
- **Oracle seat hot key:** publishes base and extra epochs within the on-chain bounds (sections 3.1-3.3) and keeps its self-rotation (`propose_oracle` / `accept_oracle`, section 3.2, item 7); nothing else.
- **Seat cold key:** replaces the hot key (`rotate_hot`), voids an epoch in its hold for free and resigns a living seat (`resign_seat`), naming a successor (section 3.2, item 6).
- **Architect payee:** moves its own payee address or renounces it (`set_architect`) and locks the collection royalties once, at the upgrade (`lock_collection_royalties`); `set_airdrop_root` was used once on 2026-10-12 and never again; no oracle power (section 3.2, item 8; section 3.7).
- **INITIAL_KEEPER:** the only key that can create the keeper seat (`arm_keeper`), with a bond of at least 20 XNT (section 3.5).
- **The house keeper, once armed:** reveals its hash chain, withdraws its bond after a 7-day notice with nothing pending, and hands over to a new keeper after 7 days (section 3.5).
- **Anyone:** voids an epoch in its hold with a bond, takes a dead oracle seat or a dead keeper seat with a bond, anchors and settles bets, refunds stalled bets and Jackpot rounds, and claims for others (sections 3.1, 3.2 and 3.5).

## 4. What happens to each kind of account (exit windows)

Nothing is taken from anyone by the upgrade, no account changes size, and every exit that exists today keeps working; recycling and orphan reclaims wait for `init_extra`, which runs in the first run, within about 2 hours of the deploy (section 5). Where a rule changes, the table says what to do before the upgrade if you prefer the old rule. Deadlines are relative to the upgrade window (Wednesday 2026-11-11, 16:00–20:00 UTC, or the same hours a week later if a gate slips); the site and the kit keep every exit open throughout.

| Account or position | Before the upgrade | After the upgrade | If you want out under today's rules |
|---|---|---|---|
| Unclaimed base leaf (any epoch) | claimable now | claimable until its 90-day window ends; an epoch published less than 48 hours before the upgrade waits once until its publication time + 48 hours | nothing to do: the amount does not change. Leaves under 0.2 XNT carry no keeper tip from the upgrade; whether the project's keeper still submits them for you is keeper policy ([OPERATORS.md](../OPERATORS.md)); you can always claim yourself |
| `ClaimReceipt` | closable after the epoch closes | unchanged | — |
| Vesting mission (`Mission`, Orbit / Moon Landing) | `withdraw_vested`, `eject` | unchanged (same vesting, same penalties); no chips credited | — |
| Forge Drop of an epoch published by the v2 program | seal and deliver within the epoch's window | unchanged, under the epoch's published cap; new epochs carry no drop | — |
| Game balance (`PlayerState`) | deposit, withdraw | unchanged; existing chips stay on the account but no instruction uses them | withdraw at any time |
| Session key | house bets within its limits | unchanged, but bets must use `place_bet_v2`, which needs an armed keeper | revoke at any time (`set_session` with the default key) |
| Open house bet (placed with `place_bet`) | settle within about 3 minutes | settles with `settle_bet` under the same rule | settle it (the site does it for you) |
| Be the House share (`HouseShare`) | request, wait 24 hours, withdraw any time after | request, wait 24 hours, withdraw within the next 24 hours; a request that matured more than 24 hours before the upgrade must be renewed. The new bankroll limits (5% pending, −3% a day, −15% a week) apply to new bets | request at least 24 hours before the window and withdraw before it |
| Jackpot round open | enter, draw, settle | entries capped at a 20 XNT pot; the draw and the winner use the keeper chain (refund if the keeper fails); the upgrade is never started while a round is drawing | stop entering; any round drawn before the upgrade settles under today's rule |
| `JackpotEntry` of a refunded round | `close_jackpot_entry` | unchanged | — |
| Burn Lottery round open (`DrawRound`, `DrawEntry`) | enter with chips or tickets | no new entries; the round draws, settles and closes under its own rules | enter before the upgrade if you want to; afterwards only settlement |
| Duel open (created before the upgrade) | joinable with a ticket; cancellable | joinable only with a sealed join (no ticket); the creator can cancel until someone joins | cancel it, or reveal and finish it |
| Duel joined | creator reveals within 1 hour, else the joiner claims | unchanged | — |
| Moon Wars offer open (created before the upgrade) | joinable with a ticket; cancellable | only `cancel_war` (no new plain joins) | cancel it to get the stake back, or let it be cancelled after |
| Moon Wars match started | 2-minute turns, timeouts, payout | unchanged for that match | — |
| Prediction round and entries | claim and refund of past rounds (not offered by this project) | unchanged for v1 rounds, with a 100 XNT side cap on new entries and a refund if the price account is gone | claim or refund at any time |
| Artifact (`ArtifactRecord`; 0 on 2026-10-31, re-read by the census before the upgrade) | recycle for its floor | recycle unchanged, from the moment `init_extra` has run (between the deploy and the first run, recycles and orphan reclaims are refused because the new `ExtraState` account they read does not exist yet); the attributes it was minted with stay; it can be listed on the native market (the first listing adds the transfer-delegate plugin) | recycle at any time, except during that gap |
| Genesis claim (`AirdropReceipt`) | open (the site's claim button is paused until the upgrade; other clients work) | open through 2027-03-31 (closes at 2027-04-01 00:00 UTC); a claimed Genesis Lunar Dust has no floor and origin "Genesis Airdrop" | — |
| Donations | to the reward pool, the bankroll or the Burn Lottery prize vault | the same three targets are accepted, but no new Burn Lottery round can open, so once the round open at the upgrade (if any; none was open on 2026-10-23) has settled, the prize vault can never pay anything again: XNT donated there after the upgrade stays there for good. Donate to the reward pool | — |
| Epoch 1 | fully claimed; its drop reserve (43,151,041 lamports) is held | unchanged: `expire_epoch` returns the reserve to the pool after 2027-01-16 01:38 UTC | — |

Clients built for today's program get readable errors for the retired paths (`KeeperRequired`, `SealedJoinRequired`, `LotteryRetired`, `ChipsRetired`); nothing hangs. The site and the agent kit are updated the same day.

## 5. Upgrade day

| Step | When (UTC) | Who | What you will see |
|---|---|---|---|
| Census | about 30 minutes before the window | the operator, read-only | a list of every open account on the program, published with the record |
| Deploy | Wednesday 2026-11-11, 16:00–20:00 (a week later if a gate slips) | the upgrade authority signs: extend the program account, write the buffer, check the buffer's hash, deploy | a new last-deploy slot on the explorer |
| Checks | right after | anyone | `solana-verify get-program-hash` = the executable hash published at S2; simulations show the new instructions; the IDL is upgraded and compared with the published one |
| Authorities | same session | the upgrade authority | the upgrade authority and the IDL authority move to an offline key (its address is published in [SECURITY.md](../SECURITY.md) at S2, next to the command that checks the authority), used once more at the freeze; the wallet that holds them today keeps no upgrade or IDL power, and stops being the architect payee when `set_architect` runs in the first run (below) |
| First run | within about 2 hours | the operator (permissionless, or signed by the architect wallet and the new payee for `set_architect`, and by the new payee for `lock_collection_royalties`) | `refresh_collection_uri`, `set_architect`, `lock_collection_royalties`, `init_seat`, `init_extra`; no `arm_keeper`: the house keeper is not armed and no keeper bond is posted (section 3.5); until `init_extra` runs, recycles and orphan reclaims are refused (section 4) |
| Site and kit | after the first run | — | forging and the Genesis claim reopen and the native market appears on the site; new sealed Duels and Moon Wars matches are available through the agent kit, while the site keeps their exits and the free Moon Wars practice; house games (Coin Flip, High-Low, Void Rush) and the Jackpot stay hidden on the site until a keeper that runs continuously has met its published service levels for a week (section 3.5: a bond posted while no keeper runs could be drained at no cost, so none is posted until then) |

The window avoids Sunday 00:00 UTC by at least 6 hours, the Prediction times 12:00 and 14:00 UTC by at least 30 minutes, any Jackpot round being drawn, and any epoch between its build and its publication.

## 6. Cost

Paid by the wallet that holds the upgrade authority; nothing is paid from any pool. No house keeper bond is posted at the upgrade (section 3.5).

| Item | XNT | Back? |
|---|---|---|
| Program account extension ((binary size − 992,168) bytes × 6,960 lamports) | published at S2 (≈ 2.85 for the rehearsal binary below) | no (it is the program's rent) |
| Deploy buffer | published at S2 (≈ 9.75 for the rehearsal binary below) | yes, when the deploy succeeds or the buffer is closed |
| Fees and the IDL buffer | ≈ 0.2 | partly |
| Oracle seat bond (max(1 XNT, 10% of the free reward pool at that moment)) + rent | 1 + 0.002 while the free reward pool is under 10 XNT (the exact bond at S7) | only on a graceful resign, and then to `SEAT_REFUND_INITIAL` (the reward pool, the default of this source, OD-20; the build commit can name another address, published at S2); if that is the reward pool, the bond never comes back to the wallet that paid it; forfeited to the reward pool if the seat dies |
| `init_extra` rents | 0.0025 | no |
| House keeper bond + rent | 0 at the upgrade (not armed, section 3.5); later, from the keeper wallet: at least 20 + 0.0024 | after a 7-day notice with nothing pending; reduced by any stall it pays |

Measured with the rehearsal binary of 2026-10-31 (1,401,200 bytes, this source built for mainnet with throwaway build-time values, never deployable): extension ≈ 2.85 XNT, buffer ≈ 9.75 XNT, deploy-wallet peak ≈ 13.81 XNT. The figures of the real binary are published at S2.

## 7. Review window

- **Source review: from the publication of this file to the upgrade window.** The source commit above is complete. Read it, run the tests, rebuild. Send findings to the project mailbox, xen-moon-forge-protocol@tutamail.com, or open a GitHub issue titled `SECURITY` without exploit details. Reports are answered in batches; every report and its outcome is recorded in [REVIEW-2026-10.md](REVIEW-2026-10.md) under "Final upgrade review".
- **Hash check: from Monday 2026-11-09 16:00 UTC at the latest (at least 48 hours before the window; earlier notices said 7 days, section 3.9).** Rebuild the build commit and compare with section 2.
- **What stops the deploy:** a finding that would lose or lock anyone's funds, let a key do more than this file says, or make the hash irreproducible. The fix goes into a new build commit; the window moves to the next possible weekday, and the new hash is published at least 48 hours before it; a change of behaviour also restarts the 7-day notice with an updated changelog.
- **After the deploy:** the mainnet proof plan and at least 14 consecutive stable days run before the freeze, and any defect found then is fixed by a corrective upgrade, announced the same way, which restarts the 14 days. No fix after the freeze is possible.
- There is no third-party audit. Earlier reviews were internal ([REVIEW-2026-10.md](REVIEW-2026-10.md)). The review path of this upgrade is this public window, from the publication of this file to the freeze (at least 14 days), with no bounty and no named reviewer ([REVIEW-2026-10.md](REVIEW-2026-10.md)).

If anything goes wrong during the deploy, the procedure stops before the next step: before the deploy transaction the program is unchanged and the buffer is closed; if the deployed hash is not the published one, nothing else runs and the next step is decided in public; before the first-run accounts exist, the dumped v2 binary can be redeployed. Account state is never rolled back.

## 8. Execution record

*Filled in on the upgrade day: every value below is published at S7.*

| Item | Value |
|---|---|
| Census (read-only, before the deploy) | at S7 |
| Deploy transaction | at S7 (transaction and new last-deploy slot) |
| Deployed executable hash | at S7 (it must equal the executable hash published at S2) |
| IDL upgrade | at S7 |
| Upgrade authority moved | at S7 |
| IDL authority moved | at S7 |
| `refresh_collection_uri` | at S7 |
| `set_architect` | at S7 |
| `lock_collection_royalties` | at S7 |
| `init_seat` | at S7 (transaction and bond) |
| `init_extra` | at S7 |
| `arm_keeper` | not sent at the upgrade (section 3.5); armed later, once a keeper has run continuously for at least 24 hours, and announced then |

Dependence on GitHub, unchanged by this upgrade: if the project's GitHub account falls, the site, the oracle, the keeper and the epoch files stop and payouts pause; the reward pool stays locked in the program. After the upgrade, already-published epochs stay claimable from any client and, once no epoch published in the last 28 days has survived its hold, the oracle seat can be taken (by the largest voider from day 28, by anyone from day 29) and publication resumed.
