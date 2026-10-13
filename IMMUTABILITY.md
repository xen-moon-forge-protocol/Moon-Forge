# What is fixed and what is not

| Item | Where | Changeable? |
|---|---|---|
| All fees, splits, tiers, penalties, budget bounds, odds, exposure caps, circuit breaker, keeper tips, NFT supplies | `programs/moon-forge/src/constants.rs` (compile-time) | Only by a program upgrade — no longer possible once the upgrade authority is burned |
| Artifact base prices and price rules (Lunar Dust 10 XNT fixed; Cosmic Shard / Solar Core / Void Anomaly base 25 / 60 / 200 XNT, +5% per forge, ÷1.05 per full week without a forge, never below base, never above 100× base) | `constants.rs` | Same as above |
| Current Artifact price of each dynamic tier | `Config` (on-chain state) | Moves **only by the rule above** (forges and elapsed weeks); nobody can set it. Buyers sign a max price, so a move can only make a forge fail |
| Architect address | constant | same as above |
| Oracle key | `Config.oracle` | Only by the current oracle (two-step hand-over) |
| Airdrop list | `Config.airdrop_root` | Set once by the architect, never again |
| Artifact metadata (names, images, utility text) | `METADATA_BASE_URI` in `constants.rs`: a folder on Arweave (permanent storage), see `deployments/nft-arweave.json` | The URI is a compile-time constant: each Artifact gets it when created, and `refresh_collection_uri` (permissionless) can only point the collection at that same value |
| Program code | upgradeable during the public test period | To be frozen (`solana program set-upgrade-authority --final`) on the conditions below; until then the upgrade authority can replace it |
| EVM portals | `contracts/MoonForgePortal.sol` (Base, Optimism, Polygon, BSC and Avalanche: `0x7b00f314aB48D223bee567181CA89c65126Bf6E9`; other chains to follow — `deployments/portals.json`) | No owner, admin, fee, pause or upgrade function — the code cannot be changed after deploy |
| Oracle policy (K = 1.25, price rules, quote-asset allowlist, finality depths) | `oracle/src/config.ts`, `oracle/src/pricing.ts` | Off-chain. A changed policy cannot push a budget above 10% of the free pool, and every epoch records its inputs so anyone can recompute its `rate_cap` with `npm run verify` |
| Frontend | GitHub Pages | Anyone can host their own copy (MIT) |

Check the live upgrade authority yourself:

```bash
solana program show 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 -u https://rpc.mainnet.x1.xyz
```

The Transparency page of the site reads the same value directly from the chain.

## When the upgrade authority will be burned

Not before **Sunday 2026-11-01**, and only once all of these hold:

1. Two consecutive weekly epochs with real burns were published on time, and each one passes `npm run verify -- <epoch file> --full`.
2. The main flows have run on mainnet: burn → claim → vesting withdrawal and early exit, house games, Be the House (deposit and withdrawal), a Predictions round, and an Artifact forge and recycle.
3. The Artifact metadata lives on Arweave and the collection points at it (`refresh_collection_uri`).
4. No code change has been needed for 14 days.

Before the burn, the on-chain program bytes are compared with a build of the published source. The transaction is then announced on the project's channels, and this page and the Transparency page will show it. After that, nothing in the program can change; only the off-chain parts listed above (oracle policy, frontend, new EVM portals, the oracle key hand-over) can.
