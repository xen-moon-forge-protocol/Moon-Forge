# Help Moon Forge

Moon Forge has no investors, no token and no treasury. The code is open and tested locally (no third-party audit); what keeps it running is a few XNT in its vaults and the community. Everything below is either enforced by the program or verifiable on-chain. Nothing you send buys priority, a place on any list, or anything else.

**Dated facts (2026-10-22).** The live program and oracle are v2. A new reward rule set (v3) and a final program upgrade are decided but not live; each applies from a date announced in advance (v3: date announced at least one full epoch ahead; upgrade: at least 7 days before it is deployed; if it is not deployed by 2026-12-31 the upgrade authority is burned on the then-current binary with the games delisted, [IMMUTABILITY.md](../IMMUTABILITY.md#when-the-upgrade-authority-will-be-burned)). Where this page says "today" it means v2 as deployed. The dated list of what changes is [KNOWN-ISSUES.md](KNOWN-ISSUES.md).

## What is needed

| Need | Who can do it |
|---|---|
| Reward pool (pays XEN burners) | anyone, via `donate` on the site (reward pool), Artifact forges, game volume |
| Game bankroll | anyone, via Be the House (shares the bankroll's part of the house edge **and its risk**) |
| Keeping (claims, settlements, draws, expiries) | anyone: `cd oracle && npm run keeper` with any funded X1 key; the pool pays small tips |
| Verification | anyone: `npm run verify -- <epoch file> --full` recomputes an epoch from public data |
| Program upgrades | no supporter funding is requested. The v2 upgrades (2026-10-07, 2026-10-12) are paid; the final upgrade is funded by the architect |
| EVM portals | all five are deployed and need nothing; no chain will be added (see below) |

## Funding history (dated)

- 2026-10-07: the v2 upgrade was funded by the architect and executed (program slot 84,304,402; on-chain bytes identical to the tested build). Everything left over went on-chain: 4 XNT to the game bankroll, 1.86 XNT to the reward pool, 0.5 XNT to the oracle key and 0.2 XNT to the keeper key (visible on the Transparency page and in the explorer).
- 2026-10-12: second v2 upgrade (slot 85,429,880), funded the same way.
- 2026-10-18: epoch 1 was published and paid. **It contained a single burn**, which exercised burn → oracle → epoch → claim on mainnet; a single burn is not evidence of demand.
- No outside wallet has funded the project. The final upgrade will be funded by the architect, not by supporters.

## Tips and donations are different things

- **Donations** go through `donate` on the site: 100% to the vault you choose (reward pool, bankroll or Burn Lottery). WXNT can be donated directly; the site unwraps it in the same transaction. Donations to the reward pool are paid to XEN burners through future epochs (and fund the keeper tips of those claims).
- **Tips** are plain transfers to the architect address (the `architect` field of the program's config, shown live on the Transparency page). They are tips and nothing more: **no airdrop, no Genesis slot, no priority, no allocation, nothing in exchange.** No earlier promise of that kind stands: the Genesis list was published final on 2026-10-12 and no donor is on it (see below). After the final upgrade, tips are received by a program-owned vault instead of a wallet; the address shown on the Transparency page changes accordingly.
- Moon Forge never asks for either. Anyone who asks you to send XNT "to secure a slot", "to be added to a list" or "to claim" is running a scam.

## Ways to help

### 1. Forge an Artifact (paused on the site from 2026-10-23 until the final upgrade; half of the price stays yours)
Of the forge price you pay today (v2): 50% stays inside your NFT as a floor you can take back at any time by recycling it, 40% goes to the burners' reward pool, 5% to the Burn Lottery and 5% to the architect. The non-refundable half is a real cost. While you hold it, under the rules live today, it carries a burn boost (if held at two consecutive epoch snapshots; it shifts shares within an epoch, never the total), weekly lottery chips and access to the Duel and Moon Wars arenas. **Those utilities end on announced dates** (dated notice in [NFT.md](NFT.md#notice-2026-10-22-what-changes-for-artifacts-and-genesis)); the floor does not change. From 2026-10-23 the site pauses forging and the Genesis claim until the final upgrade; the program still accepts both through other clients, under today's v2 attribute texts ([README, Interim notice](../README.md#interim-notice-2026-10-22)).

### 2. Be the House
Deposit XNT into the game bankroll. You share the bankroll's 0.5% of every house stake and its variance: **you can lose part of your deposit if players win.** Deposits are priced as if every pending bet loses and withdrawals as if every pending bet wins; a large pending bet opened just before your withdrawal lowers your quote (known issue [GAM-2](KNOWN-ISSUES.md#games)). Withdrawing needs a 24-hour cooldown; the price is set when you withdraw (not when you request), and a new request replaces the old one and restarts the timer. Games are risky, not for minors, and not for anyone where online gambling is restricted.

### 3. Donate
`donate` sends 100% to the vault you choose (reward pool, bankroll, Burn Lottery), as above.

### 4. Run a keeper or verify an epoch
`cd oracle && npm run keeper` with any funded X1 key submits claims, settlements and draws for everyone (funds always go to the player recorded on-chain, never to the caller; the pool pays small tips). `npm run verify -- frontend/public/epochs/epoch-N.json --full` recomputes an epoch. See [BOTS.md](BOTS.md) and [OPERATORS.md](../OPERATORS.md).

### 5. Review, report, translate
Read the code and the [internal review notes](REVIEW-2026-10.md), report what you find ([SECURITY.md](../SECURITY.md#reporting-a-vulnerability)), or open a pull request. Community translations are welcome as pull requests, dated and marked unofficial; English is the only authoritative text.

## Chains: five, and no more

Portals are live on Base, Optimism, Polygon, BSC and Avalanche, at the same address on each chain, listed in [`deployments/portals.json`](../deployments/portals.json). **Only burns through those addresses are paid.** Decision of 2026-10-20: Ethereum and PulseChain are left to the community, and no chain will be added to this instance, before or after the upgrade authority is burned. A portal contract has no owner, so anyone can deploy one on another chain, but this oracle will not read it: run your own instance instead ([FORK.md](../FORK.md)) and never reuse this instance's portals. Burns made before the portals existed, or anywhere else, are not counted and cannot be claimed here.

## Genesis airdrop (published; final under the live program)

The Genesis airdrop list was published on-chain on 2026-10-12 with `set_airdrop_root` (one time; final under the live program, which has no instruction to change it): transaction `2k9UyuQNgNqB1uY9dtkkGdLiqeymxGcDthtYdofZecV687Y6CBzVwkadYxcGsAsDRatdc6E56GvrFgVjzfEWtofF`, root `ec3e6ae5bba79664bc86c77d3ad8a9b2e7e20b233adeb7a4686058f96019f171`.

It holds 444 wallets: the withdraw authorities of the active X1 validator vote accounts on 2026-10-07 (`scripts/airdrop/collect-validators.mjs`), foundation-scale accounts excluded. The plan had been to add outside supporters as well (wallets that donated or deposited at least 5 XNT, and wallets that funded the upgrade); at publication every donation and all upgrade funding had come from the project's own launch funding, so no outside wallet qualified and the validator list was published as it was. **Nothing anyone sends now changes that list.**

Each listed wallet can claim one Lunar Dust with no floor, at least until 31 December 2026 (the live program closes the claim at 00:00 UTC on 2027-01-01; the final upgrade plans to extend it to 2027-03-31, see the notice below): only the first 120 claims succeed, the claimant pays the account rent, and a Lunar Dust slot must be free (supply cap). The published file is `frontend/public/airdrop/airdrop.json`; anyone can recompute its root and check it against the on-chain config. **As of 2026-10-22, 0 of 120 claims have been made** (`airdrop_claimed` in the program config). From 2026-10-23 the site pauses the Genesis claim (and forging) until the final upgrade; the program still accepts both through other clients, under today's v2 attribute texts ([README, Interim notice](../README.md#interim-notice-2026-10-22)).

### Notice (2026-10-22): what a Genesis Lunar Dust is

Published before the first claim, so nobody claims on an outdated promise. A Genesis Lunar Dust **is and stays** a free Metaplex Core collectible of the official collection, origin "Genesis Airdrop", with no floor (recycling gives back only the account rent). Under the rules live today (v2) it also carries the Lunar Dust utilities: a +5% burn boost once held at two consecutive snapshots, 5 weekly chips, and the arena ticket. **Those utilities end:** the boost with the switch to the v3 reward rules (date announced at least one full epoch ahead), chips and the arena ticket with the final program upgrade (planned for November 2026, announced at least 7 days ahead). After that a Genesis Lunar Dust is a collectible with a cosmetic holder badge and nothing more, and nothing in Moon Forge requires one to play, burn or claim. The claim stays open at least until 31 December 2026: the live program closes it on 2026-12-31 (00:00 UTC 2027-01-01), and the final upgrade plans to extend it to 2027-03-31 by the length of the pause, announced before 2027-01-01. The only claim page this project publishes is this site's Artifacts page (paused from 2026-10-23 until the final upgrade, see above), and a claim is always signed by the listed wallet itself; Moon Forge never contacts listed wallets first, so any message, DM or link about "your Genesis claim" is not from the project. Details in [NFT.md](NFT.md#genesis-airdrop).

## Verify you are on the real Moon Forge

Anyone can copy the name and the artwork. These values cannot be copied; check them before you sign anything.

| | Value |
|---|---|
| Site | `https://xen-moon-forge-protocol.github.io/Moon-Forge/` (the GitHub Pages of the repository below; no other domain) |
| Source | `https://github.com/xen-moon-forge-protocol/Moon-Forge`; deployed program tag `program-2026-10-12`, on-chain bytes sha256 `f22caea4…` (full hash in the README) |
| X1 program | `57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9`, the only program id, forever: there will never be a "new" or "v3" program id |
| EVM portal | `0x7b00f314aB48D223bee567181CA89c65126Bf6E9`, the same address on Base, Optimism, Polygon, BSC and Avalanche, listed in `deployments/portals.json`. No other address is a Moon Forge portal |
| Artifact collection | Metaplex Core collection `7Re1n5DsnvyJnDTiaaZZ1f9G9REPRwb2Br7SYVYCfpzK` (program PDA `["collection"]`), update authority PDA `5BHQBgoTjUMhwkzTKtcgZPQEuwWkEcrRNZERNcm9Nzx1` (`["artifact_authority"]`). An asset outside this collection is not a Moon Forge Artifact |

Moon Forge will never: announce a new program id, a migration, a token, a presale, a "whitelist", a claim site or an approval to any address other than the portal above, even if such a post appears on an official account; message, DM or e-mail anyone first; ask for a seed phrase or private key; pay anyone to promote it or post about it as someone else.

## Official channels

- Site: https://xen-moon-forge-protocol.github.io/Moon-Forge/
- Source and issues: https://github.com/xen-moon-forge-protocol/Moon-Forge
- X: https://x.com/MoonXenForge (announcements only; it never replies and never DMs)

That is the whole list. No Telegram, Discord or other group is official, and nobody from Moon Forge contacts anyone first, by any channel. Security reports go to the project mailbox ([SECURITY.md](../SECURITY.md#reporting-a-vulnerability)); GitHub's private advisory form is not enabled. Support is self-serve: the documentation, the Transparency page and GitHub issues, answered in batches; there is no live chat.
