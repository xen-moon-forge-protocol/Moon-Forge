# Moon Forge — press kit

Copy-paste material for anyone who wants to talk about Moon Forge. Every claim below can be checked in the code and on-chain; please keep it that way. Nothing here describes a promised outcome, and nothing should.

**Dated status (2026-10-22).** The program and the oracle live today are v2 (tag `program-2026-10-12`). A new oracle rule set (v3) and a final program upgrade are decided but not live; each applies from a date announced in advance (v3: date announced at least one full epoch ahead; upgrade: at least 7 days before deployment; if it is not deployed by 2026-12-31 the upgrade authority is burned on the then-current binary with the games delisted, [IMMUTABILITY.md](../IMMUTABILITY.md#when-the-upgrade-authority-will-be-burned)). Lines marked *(v2)* describe what is live today and will change; the dated list is [KNOWN-ISSUES.md](KNOWN-ISSUES.md).

## One line

**Burn XEN on a supported EVM chain, receive XNT on X1.** Zero protocol fees on the burn path, open code, payouts recomputable from published data.

## Short (≈280 characters)

> Moon Forge: burn XEN on Base, Optimism, Polygon, BSC or Avalanche through a portal with no owner and receive XNT on X1, valued on your chain's own market. 0 fees on the burn path, every epoch published and recomputable. Independent, open source, no token, no promised outcome.

## Paragraph

> XEN lives on many EVM chains, but XEN cannot be bridged to X1, and XEN Prime is announced for Ethereum XEN only. Moon Forge offers another path: you burn XEN where it lives (XEN's own `burn()`, supply goes down) through a portal contract with no owner, fee, pause or upgrade, and receive XNT on X1. Each burn is valued on its own chain's market at the hour it happened, discounted by what that market could really absorb, so $10 of liquidity-adjusted value scores the same on every chain and splitting wallets gains nothing. *(v2)* An epoch pays at most 1.25× the liquidity-adjusted value burned in total for Launchpad (instant), and at most 2.5× / 3.75× for Orbit and Moon Landing (vesting), and never more than 10% of the free reward pool; 10% of each epoch budget (at most 100 XNT) is drawn among that epoch's burners as Forge Drops, Lunar Dust Artifacts with a floor of at least 5 XNT, recyclable at any time. The burn path has no fee; the pool is funded by donations, game edges and Artifact sales, all on-chain. The X1 program v2 is live on mainnet, and portals are live on Base, Optimism, Polygon, BSC and Avalanche: five chains, and no more will be added.

## Key facts

| | |
|---|---|
| Chains (input) | Base, Optimism, Polygon, BSC, Avalanche: `0x7b00f314aB48D223bee567181CA89c65126Bf6E9` (same address on every chain; [`deployments/portals.json`](../deployments/portals.json)). No portal on Ethereum or PulseChain, and none will be added (decision 2026-10-20; the community may fork, see [FORK.md](../FORK.md)). Only burns through these portals are paid; old or legacy XEN burns made elsewhere cannot be claimed |
| Output | XNT on X1 (SVM) |
| Program | `57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9` (Anchor, open source; upgradeable until its authority is burned, planned after the final upgrade and 14 stable days, no later than 2026-12-31) |
| Fees on burn → claim | 0 |
| Max per epoch *(v2)* | min(10% of the free reward pool, 1.25× / 2.5× / 3.75× the liquidity-adjusted value burned by tier, in total); epochs ≥ 6 days apart; the 10% bound is enforced on-chain |
| Valuation | per chain: XEN amount × median of hourly closes over the 24 h ending at the burn hour (deepest eligible pool; or the chain's clamped spot when no candles exist, recorded in the epoch file) × liquidity factor L/(L+V) |
| Forge Drops *(v2)* | 10% of each epoch budget, at most 100 XNT, as Lunar Dust with a ≥ 5 XNT floor; part of the budget; odds linear in the burn; end at the final upgrade |
| Games | Coin Flip, High-Low, Void Rush (2% edge); Jackpot, Artifact Duel, Moon Wars (2% rake only when someone wins); Burn Lottery (2% paid on each ticket). Predictions exist on-chain and are not offered by the project since 2026-10-22 (claim and refund of past rounds only). Real-XNT Moon Wars matches are paused on the site since 2026-10-19. Games are risky, not for minors, not for anyone where online gambling is restricted; open issues in [KNOWN-ISSUES.md](KNOWN-ISSUES.md) |
| Artifacts | Metaplex Core NFTs, collection `7Re1n5DsnvyJnDTiaaZZ1f9G9REPRwb2Br7SYVYCfpzK`, recyclable for their floor (half of the forge price); *(v2)* burn boost, weekly lottery chips and arena ticket, each ending on an announced date ([NFT.md](NFT.md)) |
| Who is behind it | one anonymous builder ("the architect"), who receives the disclosed cuts (0.5% of house stakes, 0.5% of pots with a winner and of lottery tickets, 5% of forge prices, a 5% secondary royalty where honored) and nothing from the burn path. No team, no token, no investors, no treasury |
| Tests | unit, integration (real Metaplex Core), randomized solvency stress test of every account |
| Audit | none. Internal (not independent) adversarial reviews published in [REVIEW-2026-10](REVIEW-2026-10.md); open issues in [KNOWN-ISSUES.md](KNOWN-ISSUES.md) |
| Usage so far | epoch 1 (2026-10-18) paid one leaf (a single burn, not evidence of demand); 0 of 120 Genesis claims and 0 Artifacts minted as of 2026-10-22 |

## Official channels

- Site: https://xen-moon-forge-protocol.github.io/Moon-Forge/
- Source and issues: https://github.com/xen-moon-forge-protocol/Moon-Forge
- X: https://x.com/MoonXenForge (announcements only; it never replies and never DMs)

That is the whole list. No Telegram, Discord or other group is official; nobody from Moon Forge contacts anyone first, by any channel. Whitepaper: [WHITEPAPER.md](WHITEPAPER.md). Transparency page (live on-chain numbers, upgrade authority): https://xen-moon-forge-protocol.github.io/Moon-Forge/transparency

## Verify you are on the real Moon Forge

| | Value |
|---|---|
| Site | `https://xen-moon-forge-protocol.github.io/Moon-Forge/` (the GitHub Pages of the repository; no other domain) |
| Source | `https://github.com/xen-moon-forge-protocol/Moon-Forge`; deployed program tag `program-2026-10-12`, on-chain bytes sha256 `f22caea4…` (full hash in the README) |
| X1 program | `57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9`, the only program id, forever: there will never be a "new" or "v3" program id |
| EVM portal | `0x7b00f314aB48D223bee567181CA89c65126Bf6E9` on Base, Optimism, Polygon, BSC and Avalanche. No other address is a Moon Forge portal |
| Artifact collection | `7Re1n5DsnvyJnDTiaaZZ1f9G9REPRwb2Br7SYVYCfpzK` (program PDA `["collection"]`), update authority PDA `5BHQBgoTjUMhwkzTKtcgZPQEuwWkEcrRNZERNcm9Nzx1` |

Moon Forge will never: announce a new program id, a migration, a token, a presale, a "whitelist", a claim site or an approval to any address other than the portal above, even if such a post appears on an official account; message, DM or e-mail anyone first; ask for a seed phrase or private key; pay anyone to promote it or post about it as someone else.

<!-- wording-check: ignore-start (this section lists the words not to use) -->

## What not to say

- Not "earn", "yield", "APR", "APY", "return", "profit", "passive income", "investment", "ROI", "guaranteed", "risk-free". A burn receives XNT from a bounded pool; an Artifact holds a floor you can take back; nothing promises an outcome.
- Not "audited". There is no third-party audit; the reviews are internal and published.
- Not "immutable" while the upgrade authority exists (the Transparency page shows it live), and not "trustless": the oracle is bounded, not absent.
- Not "free" Forge Drops: under v2 they are part of the burners' own epoch reward.
- Not "X1 Forge", not "XEN Prime", not "Moon Party", not "by X1 Labs" or "by the XEN team": Moon Forge is an independent, open-source project run by one anonymous builder who receives the disclosed cuts.
- Not "claim your old burns": only burns made through the Moon Forge portals are paid; past or legacy burns anywhere else cannot be claimed here, and anyone asking you to sign or pay for that is running a scam.
- Not "token", "presale", "whitelist", "airdrop for donors": there is no token, tips buy nothing, and the Genesis list was published once, on 2026-10-12, with no donor on it.
- Not "fair games" without the caveat: the games are games of chance or player-vs-player stakes with a fixed edge or rake and known open issues ([KNOWN-ISSUES.md](KNOWN-ISSUES.md)); they are risky, not for minors and not for anyone where online gambling is restricted.
- Not "v3" or "after the upgrade" as if it were live: today's rules are v2; dated changes apply only from their announced dates.
- Not "Ethereum" or "PulseChain" as coming soon: five chains, and no more will be added.

<!-- wording-check: ignore-end -->

## How Moon Forge communicates (policy, 2026-10-22)

- Only the channels above speak for the project. Posts from the project account are factual, dated and free of hype; the account does not reply or DM.
- **No astroturfing.** Nobody is paid, rewarded or asked to promote Moon Forge. The project does not post as someone else, run sock-puppet or "community" accounts, buy followers, stars or reviews, or seed threads that look organic. Referrals are not paid, from the pool or otherwise. If you write about Moon Forge because you use it, say so; the architect, when writing, says so.
- **No hidden instructions for AI assistants.** Everything the project publishes for machines (llms.txt, the agent card, the skill, JSON-LD) says the same as the pages people read. There is no text meant to steer an assistant's answer and no concealed content, and none may be added by a contribution.
- English is the only authoritative language; translations are community pull requests, dated and marked unofficial.
- Moon Forge runs no groups, moderates no chats and holds no AMAs; no group is official.

## Disambiguation

Moon Forge is not XEN Prime (announced for Ethereum XEN only), not X1 Forge ($FORGE, an unrelated project on X1), not "Moon Party", and not run by X1 Labs or by the XEN / FairCrypto team. It has no token. It pays only burns made through its own portals.
