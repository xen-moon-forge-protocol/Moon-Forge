# What is fixed and what is not

| Item | Where | Changeable? |
|---|---|---|
| All fees, splits, tiers, penalties, budget bounds, odds, exposure caps, circuit breaker, keeper tips, NFT supplies | `programs/moon-forge/src/constants.rs` (compile-time) | Only by a program upgrade — no longer possible once the upgrade authority is burned |
| Artifact base prices and price rules (Lunar Dust 10 XNT fixed; Cosmic Shard / Solar Core / Void Anomaly base 25 / 60 / 200 XNT, +5% per forge, ÷1.05 per full week without a forge, never below base, never above 100× base) | `constants.rs` | Same as above |
| Current Artifact price of each dynamic tier | `Config` (on-chain state) | Moves **only by the rule above** (forges and elapsed weeks); nobody can set it. Buyers sign a max price, so a move can only make a forge fail |
| Architect address | constant | same as above |
| Oracle key | `Config.oracle` | Only by the current oracle (two-step hand-over) |
| Airdrop list | `Config.airdrop_root` | Set once by the architect, never again |
| Program code | upgradeable during the public test period | **Planned** to be frozen (`solana program set-upgrade-authority --final`); until then the upgrade authority can replace it |
| EVM portals | `contracts/MoonForgePortal.sol` (Base, Optimism, Polygon, BSC and Avalanche: `0x7b00f314aB48D223bee567181CA89c65126Bf6E9`; other chains to follow — `deployments/portals.json`) | No owner, admin, fee, pause or upgrade function — the code cannot be changed after deploy |
| Oracle policy (K = 1.25, price rules, quote-asset allowlist, finality depths) | `oracle/src/config.ts`, `oracle/src/pricing.ts` | Off-chain. A changed policy cannot push a budget above 10% of the free pool, and every epoch records its inputs so anyone can recompute its `rate_cap` with `npm run verify` |
| Frontend | GitHub Pages | Anyone can host their own copy (MIT) |

Check the live upgrade authority yourself:

```bash
solana program show 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 -u https://rpc.mainnet.x1.xyz
```

The Transparency page of the site reads the same value directly from the chain.
