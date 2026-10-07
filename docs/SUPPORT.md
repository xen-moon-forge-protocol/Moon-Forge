# Help launch Moon Forge

Moon Forge has no investors, no token and no treasury. The v2 code is written and tested locally (no third-party audit); what turns it on is a few XNT and the community. Most ways to help below are enforced by the program or verifiable on-chain. The exception is funding the upgrade: it relies on the architect's public commitment, checkable afterwards on-chain, to donate the leftover to the reward pool.

## What is needed

| Need | Amount | Who can do it |
|---|---|---|
| Program upgrades | the whole binary's rent as a temporary buffer (≈ 6.9 XNT at the current size), returned in the same deploy, plus the permanent rent of any growth: net ≈ 3.3 XNT on 2026-10-07 and ≈ 1.0 XNT on 2026-10-12 | only the upgrade-authority wallet, so supporters send XNT to it |
| EVM portals (one per chain) | gas: BSC ≈ $0.02, Polygon ≈ $0.03, Avalanche ≈ $0.05, Optimism/Base ≈ $0, PulseChain ≈ $0.01 (estimates as of 2026-10-07) | **anyone** — the portal has no owner |
| Reward pool (pays XEN burners) | any amount | anyone, via `donate`, Artifact forges, game volume |
| Game bankroll | any amount | anyone, via Be the House (shares the bankroll's part of the house edge, and its risk) |

## Ways to help

### 1. Fund the upgrade — done (2026-10-07)

The v2 upgrade was funded and executed on 2026-10-07 (program slot 84,304,402; on-chain bytes identical to the tested build). Everything left over went on-chain: 4 XNT donated to the bankroll, 1.86 XNT to the reward pool, 0.5 XNT to the oracle key and 0.2 XNT to the keeper key (all visible on the Transparency page and in the explorer). Transfers to the architect address are now tips.
Send XNT to the architect wallet `7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd`. Every transfer is public. Until the v2 upgrade, transfers to this address are treated as upgrade funding: after the upgrade, everything left over (including the refunded buffer) is donated **on-chain** to the reward pool with `donate`, so it can be checked on the Transparency page. This step requires trusting the architect to do that. Senders of ≥ 1 XNT are added to the Genesis airdrop list. **After the v2 upgrade, transfers to this address are tips to the architect**, not pool funding — to support burners, use Donate → Reward pool instead.

### 2. Deploy a portal yourself
The portal has no owner, admin, fee, pause or upgrade function, so who deploys it does not matter.

```bash
git clone https://github.com/xen-moon-forge-protocol/Moon-Forge && cd Moon-Forge
npm install && npx hardhat test
PRIVATE_KEY=<your gas-only key> npx hardhat run scripts/deploy_portal.ts --network bsc
npx hardhat verify --network bsc <portal> 0x2AB0e9e4eE70FFf1fB9D67031E44F6410170d00e
```

Open a GitHub issue with the address. It is added to the oracle once its verified source matches this repository and its constructor argument is the official XEN of that chain.

### 3. Forge an Artifact (refundable half)
Of the forge price you pay: 50% stays inside your NFT as a floor you can recover at any time by recycling it, 40% goes to the burners' reward pool, 5% to the Burn Lottery, 5% to the architect. While you hold it you keep its utilities: a burn boost (if held at two consecutive epoch snapshots; it shifts shares within an epoch, never the total), weekly lottery chips, and access to Artifact Duels. The non-refundable half is a real cost.

### 4. Be the House
Deposit XNT into the game bankroll. You share the bankroll's 0.5% of every house stake and its variance — **you can lose part of your deposit if players win**. Deposits are priced as if every pending bet loses and withdrawals as if every pending bet wins. Withdrawing needs a 24-hour cooldown; the price is set when you withdraw (not when you request), and a new request replaces the old one and restarts the timer.

### 5. Donate
`donate` sends 100% to the vault you choose (reward pool, bankroll, Burn Lottery). WXNT can be donated directly; the site unwraps it in the same transaction.

## Genesis airdrop (published)
The Genesis airdrop list was published on-chain on 2026-10-12 with `set_airdrop_root` (one time and final): transaction `2k9UyuQNgNqB1uY9dtkkGdLiqeymxGcDthtYdofZecV687Y6CBzVwkadYxcGsAsDRatdc6E56GvrFgVjzfEWtofF`, root `ec3e6ae5bba79664bc86c77d3ad8a9b2e7e20b233adeb7a4686058f96019f171`.

It holds 444 wallets: the withdraw authorities of the active X1 validator vote accounts on 2026-10-07 (`scripts/airdrop/collect-validators.mjs`), foundation-scale accounts excluded. The plan was to also add outside supporters (wallets that donated or deposited at least 5 XNT into Be the House, and wallets that funded the upgrade). At publication every donation and the upgrade funding had come from the project's own launch funding, so no outside wallet qualified and the validator list was published as it was.

Each listed wallet can claim one Lunar Dust with no floor on the Artifacts page until 31 December 2026: only the first 120 claims succeed, the claimant pays the account rent, and a Lunar Dust slot must be free (supply cap). The published file is `frontend/public/airdrop/airdrop.json`; anyone can recompute its root and check it against the on-chain config.
