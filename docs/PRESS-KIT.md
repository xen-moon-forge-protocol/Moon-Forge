# Moon Forge — press kit

Copy-paste material for anyone who wants to talk about Moon Forge. Every claim below can be checked in the code and on-chain; please keep it that way (no promises of returns).

## One line

**Burn XEN on a supported EVM chain, receive XNT on X1.** Zero protocol fees on the burn path, open code, payouts recomputable from published data.

## Short (≈280 characters)

> Moon Forge: burn XEN on BSC, Polygon, Avalanche, Optimism, Base, PulseChain or Ethereum and receive XNT on X1. Each burn valued on its own chain's market, 0 fees on the burn path, part of each epoch's reward drawn as Lunar Dust NFTs with a 5 XNT+ floor. Live on Base and Optimism; other chains soon.

## Paragraph

> XEN lives on many EVM chains, but XEN cannot be bridged to X1, and XEN Prime will only accept Ethereum XEN. Moon Forge offers another path: you burn XEN where it lives (XEN's own `burn()`, supply goes down) and receive XNT on X1. Each burn is valued on its own chain's market at the hour it happened, discounted by what that market could really absorb, so $10 of liquidity-adjusted value scores the same on every chain and splitting wallets gains nothing. An epoch pays at most 1.25× the liquidity-adjusted value burned in total for Launchpad (instant), and at most 2.5× / 3.75× for Orbit and Moon Landing (vesting) — and never more than 10% of the free reward pool. 10% of each epoch budget (at most 100 XNT) is drawn among that epoch's burners as Forge Drops: Lunar Dust Artifacts holding a floor of at least 5 XNT, recyclable at any time. The burn path has no fee; the pool is funded by donations, game edges and Artifact sales, all on-chain. The X1 program v2 is live on mainnet; portals are live on Base and Optimism and the other chains follow.

## Key facts

| | |
|---|---|
| Chains (input) | Ethereum, BSC, Polygon, Avalanche, Optimism, Base, PulseChain (XEN must have a market). Portals live on Base and Optimism: `0x7b00f314aB48D223bee567181CA89c65126Bf6E9` (same address on every chain); other chains soon |
| Output | XNT on X1 (SVM) |
| Program | `57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9` (Anchor, open source, upgradeable during the test period) |
| Fees on burn → claim | 0 |
| Max per epoch | min(10% of the free reward pool, 1.25× / 2.5× / 3.75× the liquidity-adjusted value burned by tier, in total); epochs ≥ 6 days apart; the 10% bound is enforced on-chain |
| Valuation | per chain: XEN amount × median of hourly closes over the 24 h ending at the burn hour (deepest eligible pool) × liquidity factor L/(L+V) |
| Forge Drops | 10% of each epoch budget, at most 100 XNT, as Lunar Dust with a ≥ 5 XNT floor; part of the budget; odds linear in the burn |
| Games | Coin Flip, High-Low, Void Rush (2% edge); Jackpot and Artifact Duel (2% rake when someone wins); Burn Lottery (2% paid on each ticket at purchase) |
| Artifacts | Metaplex Core NFTs, recyclable for their floor, burn boost, weekly lottery chips, Duel ticket |
| Tests | unit, integration (real Metaplex Core), randomized solvency stress test of every account |
| Audit | none. Internal (not independent) adversarial reviews published in [AUDIT-2026-10](AUDIT-2026-10.md) |

## Links

- Site: https://xen-moon-forge-protocol.github.io/Moon-Forge/
- Code: https://github.com/xen-moon-forge-protocol/Moon-Forge
- Whitepaper: [WHITEPAPER.md](WHITEPAPER.md)
- Transparency page (live on-chain numbers, upgrade authority): https://xen-moon-forge-protocol.github.io/Moon-Forge/transparency

## What not to say

- Not "guaranteed returns", not "risk-free", not "audited by" anyone. The pool pays what it holds; XNT is volatile.
- Not "immutable" while the upgrade authority exists (the Transparency page shows it live).
- Not "free" Forge Drops: they are part of the burners' own epoch reward.
