# Moon Forge Protocol

![Moon Forge](branding/assets/hero/hero_launch.png)

> **Any XEN, on any supported chain → XNT on X1.** Zero protocol fees on the burn path. Rules public, payouts recomputable from published data.

🌐 **Site:** https://xen-moon-forge-protocol.github.io/Moon-Forge/

Moon Forge lets XEN holders on Base, Optimism, Polygon, BSC and Avalanche burn their XEN (for real, through XEN's own `burn()`) and receive **XNT on X1**. XEN cannot be bridged to X1, and XEN Prime accepts only Ethereum XEN — Moon Forge is a path for side-chain holders. Portals are **live on Base, Optimism, Polygon, BSC and Avalanche** at the same address on every chain (`0x7b00f314aB48D223bee567181CA89c65126Bf6E9`). Ethereum and PulseChain have no portal, and none is planned by this project.

---

## Status (October 2026)

| Component | Status |
|---|---|
| X1 program `57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9` | **v2 live on mainnet** since 2026-10-07 (slot 84,304,402); upgraded 2026-10-12 (slot 85,429,880) with real Moon Wars, Predictions and the Genesis-claim deadline. The bytes on-chain are identical to the tested build (sha256 of the `solana program dump` output, 992,168 bytes, the same as the build of the tag: `f22caea492e0431457864d02129b5ce8e0746bed4279330a569f7169902f8198`), built from tag [`program-2026-10-12`](https://github.com/xen-moon-forge-protocol/Moon-Forge/tree/program-2026-10-12) (commit be03ad8); later commits on main add code that is not deployed yet. It replaced v1, which had critical bugs and was never used. |
| EVM portals v2 | **Live on Base, Optimism, Polygon, BSC and Avalanche** at `0x7b00f314aB48D223bee567181CA89c65126Bf6E9` (same address on every chain; source verified on Sourcify, exact match; see [deployments/portals.json](deployments/portals.json)). Ethereum and PulseChain: no portal, none planned by this project |
| Oracle, keeper, announcements | Running from GitHub Actions: the oracle is scheduled for Sundays 00:00 UTC and can start late (epoch 1 was published at 01:38 UTC after a backup trigger; weeks without burns publish nothing); the public keeper is scheduled every 15 minutes, but GitHub fires only a share of those ticks (in practice a run every few hours, [OPS-1](docs/KNOWN-ISSUES.md#operations-and-dependencies)), so upkeep with a deadline (draws, Moon Wars turns, house bets) can be missed: settle your own bets; weekly state-of-the-forge and epoch receipts on the project's own channels. Anyone can run the same commands. **Late-run rule (today):** the oracle publishes only inside the 48 h after a Sunday 00:00 UTC slot opens; if no run happens in that window, nothing is published that week — burns are not lost (the next published epoch values them by the same rules) but their burners wait a week. The epoch-2 window is 2026-10-25 00:00 → 10-27 00:00 UTC; epoch 2 is published only if a new burn exists. Details: [DEPLOY.md §4](DEPLOY.md#4-oracle), [OPERATORS.md](OPERATORS.md) |
| Epochs | Epoch 1 published 2026-10-18 (tx `4XyLDE…`): one burn on Optimism, which exercised the whole path with real funds and was paid by the same rules as any burn (0.388 XNT). A single burn is not evidence of demand. See the [interim notice](#interim-notice-2026-10-22) |
| Frontend | Live at the site above; every number is read from chain or public price sources (Start here, Fair Value Engine, Transparency) |
| Upgrade authority | Held by the architect wallet (one key held by the anonymous operator outside GitHub, never in its secrets; it moves to an offline signer from the final upgrade to the freeze) during the test period, used only for the announced final upgrade (earliest 2026-11-11) and then **burned**: earliest 2026-11-25, once the final upgrade is live with its announced hash, the mainnet proof plan is complete, 14 consecutive daily health runs show no failure — with or without external users — and the Artifact metadata is on Arweave; no later than 2026-12-31 ([IMMUTABILITY.md](IMMUTABILITY.md#when-the-upgrade-authority-will-be-burned); shown live on the Transparency page) |
| Third-party audit | None. Internal (not independent: single author, AI-assisted) reviews: [docs/REVIEW-2026-10.md](docs/REVIEW-2026-10.md), method and scope at its top |

---

## Interim notice (2026-10-22)

Everything in "How it works", "Fees" and "What's inside" below describes the **v2 program and oracle that are live today**. Two dated changes are decided and not yet live; neither changes a burn already made or a floor already paid:

| What | Today (v2, live) | From the first v3 epoch — planned for **November 2026** (the date and the last v2 publish transaction are announced at least one full epoch ahead) | After the final program upgrade — earliest **2026-11-11**, announced at least 7 days ahead with the binary hash |
|---|---|---|---|
| Artifact burn boost | +5% / +10% / +20% / +50% for an Artifact held at two consecutive epoch snapshots | **Ends.** Boosts no longer enter the scoring (an oracle-policy change, inside the on-chain bounds); the scoring rule itself changes and is published with the switch notice, a full epoch ahead | — |
| Forge Drops | 10% of each epoch budget (at most 100 XNT) drawn as Lunar Dust with a floor | Not changed by the switch; they end with the final upgrade | **End.** No drop reserve on epochs published by the new binary; epoch 1's unused reserve returns to the pool when that epoch expires (after 2027-01-16) |
| Chips (lottery weight) | Credited by burns, house games and Artifacts (weekly) | Unchanged | **End.** No chips from any source; existing chips become inert; new Burn Lottery tickets are retired (the lottery's share of rakes goes to the reward pool instead) and rounds already open are settled or refunded under their own rules |
| Artifact as the ticket to Duels and Moon Wars | Required | Unchanged | **Ends.** Duels and Moon Wars need no Artifact; the old entry points are retired |
| Genesis Lunar Dust (airdrop, 0 of 120 claimed) | Same utilities as a forged Lunar Dust, no floor | Unchanged | A free collectible with a cosmetic badge: no boost, chips, ticket or floor; the claim deadline is planned to move from 2026-12-31 to 2027-03-31 |
| Forge split and Artifact prices | 50% floor / 40% pool / 5% lottery / 5% architect; dynamic tier prices | Unchanged | Change (published with the upgrade announcement). The refundable floor of any Artifact forged before the upgrade is not reduced |

The site pauses forging and Genesis claims until the final upgrade (frontend change scheduled for 2026-10-23); the program keeps accepting both, so anyone forging through another client before the upgrade does so under today's attribute texts, which the upgrade plans to refresh on-chain. The upgrade authority is burned only after the upgrade, the mainnet proof plan and 14 stable days: [IMMUTABILITY.md](IMMUTABILITY.md#when-the-upgrade-authority-will-be-burned).

**Epoch 1 had a single burn.** Epoch 1 (published 2026-10-18, tx `4XyLDE…`) contains exactly one burn, on Optimism (mission 1); it exercised the whole path — burn → oracle → publish → claim — with real funds. It was valued and paid by the same rules as any burn (0.388 XNT, the whole cash part of the budget, as the only leaf); its 0.043 XNT drop reserve drew no winner and returns to the pool at expiry. A single burn is not evidence of demand. From the v3 switch, project-operated wallets follow a published operator policy with no priority over other burners.

## How it works

```
[1] Burn XEN on a supported EVM chain   → MoonForgePortal calls XEN.burn() (supply ↓) and emits MissionStarted
[2] Oracle (weekly, Sundays 00:00 UTC)  → values burns at market price, publishes a Merkle root + rate cap on X1
[3] Claim (permissionless)              → Launchpad: XNT lands in your X1 wallet; Orbit / Moon Landing: vesting starts
                                          (the public keeper usually submits claims for you when it is running)
```

**Payout:** your share of the epoch budget.

- `value = XEN burned × burn-hour price of that chain's XEN × L / (L + V)` — the price is the median of the hourly closes over the 24 h ending at the burn hour, in that chain's deepest eligible XEN pool (only pools quoted in an allowlisted liquid asset count); `L / (L + V)` is a liquidity discount (L = XEN-side USD liquidity of the chain's eligible pools, V = everything burned on that chain in the epoch). When the price pool has no hourly candles for that hour, the oracle falls back to the chain's reserve-weighted spot price (clamped like any price) and records it in that burn's `priceSource` in the epoch file; epoch 1's single burn was priced from the candles (`median24h`).
- `score = value × tier multiplier × (1 + Artifact boost)`
- `budget = min(10% of the free reward pool, 1.25 × Σ(value × tier multiplier) converted to XNT)`

Boosts are excluded from the cap, so an epoch pays at most 1.25× / 2.5× / 3.75× the liquidity-adjusted value burned (Launchpad / Orbit / Moon Landing), Forge Drops included, and a boost only shifts shares between burners of the same epoch. The program computes the `min()` on-chain; the oracle supplies the cap as `rate_cap` and anyone can recompute it from the epoch file. Linear (splitting wallets gains nothing), each chain valued on its own market, never more than the pool can pay. Live per-chain numbers: `cd oracle && npm run market`.

**Forge Drops:** 10% of every epoch budget (at most 100 XNT) is drawn among that epoch's burners as **Lunar Dust Artifacts holding a floor equal to the drop value (≥ 5 XNT)**. Drops are part of the burners' own epoch reward, not extra. Your chance is your expected drop value ÷ 5 XNT (linear: splitting never changes your expected drop value); at or above 5 XNT you always receive it. Recycle it at once for the XNT, or keep it for +5% on future burns, weekly lottery chips and Duel access. Paid in XNT if Lunar Dust is sold out; must be received within the epoch's 90-day window. The seed is the hash of a block produced after the epoch is published. For small and side-chain holders, whose XEN is hard to sell, this turns a tiny pro-rata share into a chance at a whole 5 XNT Artifact.

| Tier | Multiplier | Paid | Early-exit penalty (on the unvested part, 100% back to the pool) |
|---|---|---|---|
| 🚀 Launchpad | 1× | instantly | — |
| 🛸 Orbit | 2× | over 45 days | 60% |
| 🌙 Moon Landing | 3× | over 180 days | 75% |

Vesting starts when the leaf is claimed. Vested XNT is **not** pushed automatically: use **Withdraw vested** in Mission Control (anyone can push it for you). Ejecting at once pays 0.80× (Orbit) / 0.75× (Moon Landing) of the Launchpad equivalent in XNT — up to ~0.92× / ~0.975× counting Forge Drops — always less than choosing Launchpad.

## Fees

| | Protocol fee | Architect |
|---|---|---|
| Burn → claim → vesting → Forge Drops, donations, Be the House | **0** | **0** |
| House games (Coin Flip, High-Low, Void Rush) | 2% edge: 1% → reward pool, 0.5% → bankroll | 0.5% of stakes |
| Jackpot, Artifact Duel | 2% rake only when someone wins: 1% → pool, 0.5% → lottery | 0.5% |
| Burn Lottery tickets | 2% paid at purchase: 1% → pool, 0.5% → back to the prize vault | 0.5% |
| Artifact forge | 50% floor (refundable), 40% → pool, 5% → lottery | 5% |

Keeper tips (0.002 XNT per claim of ≥ 0.02 XNT submitted for someone else, 0.01 XNT per Forge Drop delivered for someone else) are paid by the reward pool, never by the player.

## What's inside

- **Games, all on-chain:** Coin Flip, High-Low, Void Rush (house); Jackpot, Artifact Duel, Burn Lottery (P2P); Moon Wars (free practice and real-XNT player-vs-player matches); Predictions (XNT up/down, priced by the XDEX on-chain TWAP) — exists on-chain and is not offered by this project since 2026-10-22 (claim and refund of past rounds only); real-XNT Moon Wars matches are paused on the site since 2026-10-19 ([docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md#games) GAM-3, GAM-5). House games use the hash of the next slot (not known to the player or the protocol when the bet is placed; the producer of that block can influence it — see [SECURITY.md](SECURITY.md)); Duels use commit-reveal. Settlement is permissionless; a house bet not settled within ~3 minutes counts as lost (the site settles immediately); draws that nobody settles in time are never re-drawn (Jackpot refunded, lottery prize sent to the reward pool). The bankroll cannot be over-committed and new house bets pause for the rest of the UTC day if it loses 10% in a day. Anyone can **Be the House** (shares priced against the depositor in both directions, with slippage limits).
- **Artifacts (Metaplex Core NFTs):** Lunar Dust / Cosmic Shard / Solar Core / Void Anomaly — burn boosts (held at two consecutive epoch snapshots; only the best one per wallet), weekly lottery chips, the ticket to Artifact Duel and Moon Wars, a refundable floor (half of the price paid when forged), recyclable. Rarer tiers have a dynamic price (+5% per forge, −4.76% per quiet week, never below base). Lunar Dust can also be won by burning (Forge Drops).
- **For AI agents:** an agent can play Moon Wars and back the bankroll with its own keypair. Skill file (Conway Automaton format), JavaScript kit with examples and an end-to-end test in [agents/](agents/); agent card at `/agent-card.json` and `/llms.txt` on the site.
- **Testing:** unit tests, integration tests against the real Metaplex Core program, and a randomized stress test that checks every account's obligations after every round — see [docs/REVIEW-2026-10.md](docs/REVIEW-2026-10.md) (internal: single author, AI-assisted; method and scope at its top). No third-party audit.
- **Chips:** lottery weight credited by burning (1 per XNT received), playing house games (1 per 10 XNT wagered) and holding Artifacts (weekly).
- **Bots welcome:** session keys can play house games only and can never withdraw or enter P2P games — see [docs/BOTS.md](docs/BOTS.md).

## Verify everything

```bash
# Recompute any published epoch from public data and compare with X1 (epoch 1 was published on 2026-10-18)
cd oracle && npm install
npm run verify -- ../frontend/public/epochs/epoch-1.json --full

# Run the program tests (local validator + real Metaplex Core) and the randomized solvency stress test
bash tests/run-local.sh

# Portal tests
npm install && npx hardhat test
```

## Repository

```
programs/moon-forge   Anchor program (X1) — the protocol
contracts/            MoonForgePortal.sol (EVM burn portal) + test mock
oracle/               Epoch builder, publisher, keeper, verifier (TypeScript)
frontend/             React + Vite site (GitHub Pages); public/epochs = published epoch data
tests/                Program integration tests
docs/                 Whitepaper, review notes, bots, NFTs, operations
```

## Documentation

**[Help launch Moon Forge](docs/SUPPORT.md)** · [Whitepaper](docs/WHITEPAPER.md) · [Worked examples](docs/EXAMPLES.md) · [Security & trust model](SECURITY.md) · [What is fixed and what is not](IMMUTABILITY.md) · [Deploy](DEPLOY.md) · [Operators (oracle/keeper)](OPERATORS.md) · [Bots](docs/BOTS.md) · [Artifacts](docs/NFT.md) · [Architect compensation](ARCHITECT.md) · [Internal review 2026-10](docs/REVIEW-2026-10.md) · [Press kit](docs/PRESS-KIT.md) · [Known issues](docs/KNOWN-ISSUES.md) · [Wording standard](docs/WORDING.md) · [Claims register](docs/CLAIMS.md) · [Fork](FORK.md)

## Who controls what, and what depends on GitHub

- **Immutable today:** the five EVM portals (no owner, admin, fee, pause or upgrade). **Fixed under the live program** (no instruction can change them; only a program upgrade could, until the freeze): the airdrop root (set once on 2026-10-12) and every published epoch (root and data hash on-chain, file in git). **Upgradeable today:** the whole X1 program, by one key held by the anonymous operator outside GitHub (never in its secrets), used only for the announced final upgrade and the freeze.
- **The oracle** can publish one epoch per ≥ 6 days with a root it chooses and a budget the program caps at 10% of the free pool, and hand its role over; it cannot move vault funds. **The community** can verify every epoch, run the keeper, host the site, build epochs in dry mode and fork; it cannot publish an epoch or upgrade the program.
- **GitHub:** the site, the scheduled runs and the epoch-file feed live in this GitHub account. If it falls, they stop; new epochs pause until the oracle operator runs the same code elsewhere; published epochs stay claimable from any clone; the pool stays locked in the program — nobody can take it, and it pays nothing until an epoch is published. No mirror exists yet (planned before the v3 switch).
- The builder is anonymous and will leave after the freeze: no routine action is taken after it. What remains possible, today and after the freeze, is listed in [IMMUTABILITY.md](IMMUTABILITY.md#who-can-do-what-status-today-and-after-the-freeze).

## Disclaimer

Experimental software, MIT licensed, no team allocation, no token, no promised payouts. XNT is volatile and illiquid. Only use what you can afford to lose. Moon Forge is not affiliated with X1 Labs, XEN/FairCrypto, XEN Prime or X1 Forge ($FORGE), and has no token. Only burns made through the Moon Forge portals are paid: past or legacy XEN burns made elsewhere cannot be claimed, and nobody acting for Moon Forge will ask you to sign or pay to "claim old burns".

*Don't wait for the party. Forge it.*
