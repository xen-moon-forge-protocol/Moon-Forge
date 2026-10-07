# Moon Forge Protocol

![Moon Forge](branding/assets/hero/hero_launch.png)

> **Any XEN, on any supported chain → XNT on X1.** Zero protocol fees on the burn path. Rules public, payouts recomputable from published data.

🌐 **Site:** https://xen-moon-forge-protocol.github.io/Moon-Forge/

Moon Forge lets XEN holders on Ethereum, Optimism, BSC, Polygon, Avalanche, Base and PulseChain burn their XEN (for real, through XEN's own `burn()`) and receive **XNT on X1**. XEN cannot be bridged to X1, and XEN Prime accepts only Ethereum XEN — Moon Forge is a path for everyone else, and an alternative for ETH-XEN holders. Portals are **live on Base and Optimism** at the same address on every chain (`0x7b00f314aB48D223bee567181CA89c65126Bf6E9`); the other chains follow as their deploy gas is funded.

---

## Status (October 2026)

| Component | Status |
|---|---|
| X1 program `57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9` | **v2 live on mainnet** since 2026-10-07 (slot 84,304,402). The bytes on-chain are identical to the tested build (sha256 `424d4bef…`). It replaced v1, which had critical bugs and was never used. |
| EVM portals v2 | **Live on Base and Optimism** at `0x7b00f314aB48D223bee567181CA89c65126Bf6E9` (same address on every chain; source verified on Sourcify, exact match; see [deployments/portals.json](deployments/portals.json)). BSC, Polygon, Avalanche, PulseChain, Ethereum: launching as deploy gas is funded |
| Oracle + keeper v2 | Written — the oracle runs weekly once portals are live |
| Frontend | Wired to the v2 program; actions activate once v2 is on mainnet |
| Upgrade authority | Held by the architect wallet during the test period, **to be burned** afterwards (shown live on the Transparency page) |
| Third-party audit | None. Internal (not independent) reviews: [docs/AUDIT-2026-10.md](docs/AUDIT-2026-10.md) |

---

## How it works

```
[1] Burn XEN on a supported EVM chain   → MoonForgePortal calls XEN.burn() (supply ↓) and emits MissionStarted
[2] Oracle (weekly, Sundays 00:00 UTC)  → values burns at market price, publishes a Merkle root + rate cap on X1
[3] Claim (permissionless)              → Launchpad: XNT lands in your X1 wallet; Orbit / Moon Landing: vesting starts
                                          (the public keeper usually submits claims for you when it is running)
```

**Payout:** your share of the epoch budget.

- `value = XEN burned × burn-hour price of that chain's XEN × L / (L + V)` — the price is the median of the hourly closes over the 24 h ending at the burn hour, in that chain's deepest eligible XEN pool (only pools quoted in an allowlisted liquid asset count); `L / (L + V)` is a liquidity discount (L = XEN-side USD liquidity of the chain's eligible pools, V = everything burned on that chain in the epoch).
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

- **Games, all on-chain:** Coin Flip, High-Low, Void Rush (house); Jackpot, Artifact Duel, Burn Lottery (P2P); Moon Wars (free practice). House games use the hash of the next slot (not known to the player or the protocol when the bet is placed; the producer of that block could in theory influence it — see [SECURITY.md](SECURITY.md)); Duels use commit-reveal. Settlement is permissionless; a house bet not settled within ~3 minutes counts as lost (the site settles immediately); draws that nobody settles in time are never re-drawn (Jackpot refunded, lottery prize sent to the reward pool). The bankroll cannot be over-committed and new house bets pause for the rest of the UTC day if it loses 10% in a day. Anyone can **Be the House** (shares priced against the depositor in both directions, with slippage limits).
- **Artifacts (Metaplex Core NFTs):** Lunar Dust / Cosmic Shard / Solar Core / Void Anomaly — burn boosts (held at two consecutive epoch snapshots; only the best one per wallet), weekly lottery chips, the ticket to Artifact Duels, a refundable floor (half of the price paid when forged), recyclable. Rarer tiers have a dynamic price (+5% per forge, −4.76% per quiet week, never below base). Lunar Dust can also be won by burning (Forge Drops).
- **Testing:** unit tests, integration tests against the real Metaplex Core program, and a randomized stress test that checks every account's obligations after every round — see [docs/AUDIT-2026-10.md](docs/AUDIT-2026-10.md). No third-party audit.
- **Chips:** lottery weight earned by burning (1 per XNT received), playing house games (1 per 10 XNT wagered) and holding Artifacts (weekly).
- **Bots welcome:** session keys can play house games only and can never withdraw or enter P2P games — see [docs/BOTS.md](docs/BOTS.md).

## Verify everything

```bash
# Recompute any published epoch from public data and compare with X1 (once epoch 1 is published)
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

**[Help launch Moon Forge](docs/SUPPORT.md)** · [Whitepaper](docs/WHITEPAPER.md) · [Worked examples](docs/EXAMPLES.md) · [Security & trust model](SECURITY.md) · [What is fixed and what is not](IMMUTABILITY.md) · [Deploy](DEPLOY.md) · [Operators (oracle/keeper)](OPERATORS.md) · [Bots](docs/BOTS.md) · [Artifacts](docs/NFT.md) · [Architect compensation](ARCHITECT.md) · [Internal review 2026-10](docs/AUDIT-2026-10.md) · [Press kit](docs/PRESS-KIT.md) · [Fork](FORK.md)

## Disclaimer

Experimental software, MIT licensed, no team allocation, no token, no promised returns. XNT is volatile and illiquid. Only use what you can afford to lose. Moon Forge is not affiliated with X1 Labs, XEN/FairCrypto or XEN Prime.

*Don't wait for the party. Forge it.*
