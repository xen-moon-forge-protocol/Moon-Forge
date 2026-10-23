# What is fixed and what is not

*Status as of 2026-10-22. The program and the oracle running today are v2. The v3 oracle rules and the final program upgrade are decided but not live: everything below that is marked "planned" is dated and not yet true on-chain.*

| Item | Where | Changeable? |
|---|---|---|
| All fees, splits, vesting durations, eject penalties, budget bounds, odds, exposure caps, circuit breaker, keeper tips, NFT supplies | `programs/moon-forge/src/constants.rs` (compile-time) | Only by a program upgrade — no longer possible once the upgrade authority is burned |
| Artifact base prices and price rules (Lunar Dust 10 XNT fixed; Cosmic Shard / Solar Core / Void Anomaly base 25 / 60 / 200 XNT, +5% per forge, ÷1.05 per full week without a forge, never below base, never above 100× base) | `constants.rs` | Same as above |
| Current Artifact price of each dynamic tier | `Config` (on-chain state) | Moves **only by the rule above** (forges and elapsed weeks); nobody can set it. Buyers sign a max price, so a move can only make a forge fail |
| Architect address | constant | same as above |
| Oracle key | `Config.oracle` | Only by the current oracle (two-step hand-over) |
| Airdrop list | `Config.airdrop_root` | Set once by the architect (2026-10-12); the live program has no instruction to set it again, so only a program upgrade could change it, until the freeze |
| Artifact metadata (names, images, utility text) | `METADATA_BASE_URI` in `constants.rs`: today the site's GitHub Pages folder `/nft/`. A permanent Arweave copy is planned for the final program upgrade; the earlier upload recorded in `deployments/nft-arweave.json` does not serve every file from every gateway; its JSON (v2 utility texts) will not be used, and its images are reused only if every file serves from the chosen gateway with a matching hash, otherwise re-uploaded | A compile-time constant: each Artifact gets it when created. After the final upgrade, `refresh_collection_uri` (permissionless) can only point the collection at the same value |
| Program code | upgradeable during the public test period | To be frozen (`anchor idl erase-authority` + `solana program set-upgrade-authority --final`) on the conditions below; until then the upgrade authority can replace it |
| EVM portals | `contracts/MoonForgePortal.sol` on exactly five chains — Base, Optimism, Polygon, BSC and Avalanche: `0x7b00f314aB48D223bee567181CA89c65126Bf6E9` (`deployments/portals.json`). No further portal is planned by this project; Ethereum and PulseChain are left to the community, as forks ([FORK.md](FORK.md)): a portal on another chain is not read by this oracle, and no chain will be added after the freeze | No owner, admin, fee, pause or upgrade function — the code cannot be changed after deploy |
| Oracle policy (K = 1.25, **tier multipliers 1× / 2× / 3×, Artifact boost sizes**, price rules, quote-asset allowlist, finality depths) | `oracle/src/config.ts`, `oracle/src/pricing.ts`, `oracle/src/epoch.ts` (v2, live today) | Off-chain: the program never reads these values, so they stay changeable even after the upgrade authority is burned, always with notice and always inside the on-chain bounds. A changed policy cannot push a budget above 10% of the free pool, and every epoch records its inputs so anyone can recompute it with `npm run verify`. **Dated notice:** the v3 policy replaces this one from the switch epoch (planned for November 2026; the date and the last v2 publish transaction are announced at least one full epoch ahead); from then on Artifact boosts no longer enter the scoring. See the interim notice in the [README](README.md#interim-notice-2026-10-22) |
| Frontend | GitHub Pages | Anyone can host their own copy (MIT) |

Check the live upgrade authority yourself:

```bash
solana program show 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 -u https://rpc.mainnet.x1.xyz
```

The Transparency page of the site reads the same value directly from the chain.

## Who can do what: status today and after the freeze

This block is the plain statement of what is immutable, what the bounded oracle still does, what the community can run without the project, and what depends on GitHub. The "after the freeze" column is the plan as decided on 2026-10-22; the exact list of remaining powers is published with the final-upgrade announcement (at least 7 days before the upgrade) and finalised in the freeze record with both signatures.

| | Status today (2026-10-22, v2 live) | After the freeze (planned; earliest 2026-11-25) |
|---|---|---|
| **Immutable** | The five EVM portals (no owner, admin, fee, pause or upgrade). **Fixed under the live program** (no instruction can change them; only a program upgrade could, until the freeze): the airdrop root (set once on 2026-10-12) and every published epoch (its root and data hash are on-chain and its file is in git). | The program itself: no upgrade authority, IDL authority erased, so every constant, split, odd and vault rule is frozen. Plus everything in the left column. |
| **Who can change the program** | One upgrade authority (the architect wallet), held by the anonymous operator outside GitHub and never in its secrets; it moves to an offline signer from the final upgrade to the freeze. It is used only twice more: the announced final upgrade and the freeze. If that key were lost before the freeze, nobody could upgrade or burn the authority: the program would stay as deployed, with an authority nobody holds. | Nobody. |
| **What the oracle can do** | Publish one epoch per ≥ 6 days with a Merkle root it chooses, a data hash, a total score and a `rate_cap`; the program computes the budget as `min(10% of the free pool, total_score × rate_cap)` and refuses more. Hand its role to a new key (two-step). It cannot move vault funds, pay anyone outside a published leaf, or change a rule on-chain. The policy behind each root (prices, multipliers, boosts) is off-chain, versioned in this repository, and every epoch's inputs are published so anyone can recompute the root. | Exactly the same bounded publish power and hand-over. The final upgrade adds a bounded operating allowance paid from the pool inside the same 10% assertion and a recovery path if the oracle goes silent; both are described in the upgrade announcement, not here, until they are live. No oracle power ever gains control of vault funds. |
| **What the community can run** | `npm run verify` on every epoch file; the keeper (`npm run keeper`: claims, settlements, Forge Drop delivery, expiry — permissionless, tipped by the pool); the site, from any host (MIT); the oracle build in dry mode (`npm run epoch -- --dry`, which builds and prints the next epoch without publishing); a fork with its own program id and portals ([FORK.md](FORK.md)). It cannot publish an epoch (that needs the oracle key) or upgrade the program. | The same, plus the keeper for the games. No new chain will be added by this project; a portal elsewhere is a fork. The oracle code itself can be run by a community operator if the oracle key is handed over (two-step, on-chain). |
| **What depends on GitHub** | The site (Pages), the scheduled oracle, keeper and health runs (Actions) and the epoch-file feed (git + Pages). **If the account falls:** the site, the scheduled runs and the feed stop; new epochs pause until the oracle operator runs the same code elsewhere; already-published epochs stay claimable by anyone who holds the file (any clone) and an RPC; **the pool stays locked in the program** — nobody can take it, and it pays nothing until an epoch is published. No mirror exists yet; an Arweave mirror of every epoch file is planned before the v3 switch. | Still GitHub-hosted, with the same consequences, reduced by the mirrors (epoch files on Arweave, a docs manifest). No routine action will ever be taken by the owner after the freeze; emergency off-chain fixes remain possible (one sealed credential kept offline with the key backups). A fork with a new oracle key cannot continue the same pool. |
| **Idle vaults** | Never staked, never lent. | Same, permanently: no staking path is added by the final upgrade. |
| **Owner actions left** | Fund the final upgrade once (2026-11); sign the final upgrade (earliest 2026-11-11); sign the freeze (earliest 2026-11-25, no later than 2026-12-31); the dated decision sheet. | None routine. |

## When the upgrade authority will be burned

Earliest **2026-11-25**, and only once all of these hold:

1. The final program upgrade is deployed with the hash announced at least 7 days earlier (`docs/UPGRADE-2026-11.md`, to be published with the announcement, at least 7 days before the upgrade: source commit, reproducible build procedure, changelog).
2. The **mainnet proof plan** is complete, with a transaction link for every row: every front exercised once on mainnet by the project's own labelled test wallets with small amounts — burn on each of the five chains and each tier → epoch under the new binary → claim → vesting withdrawal and early exit; forge and recycle in each tier; every game once; Be the House deposit and withdrawal; the recovery path proposed and cancelled. **With or without external users:** the freeze does not wait for third-party burns.
3. **14 consecutive daily health runs with no FAIL** after the last proof-plan row — the measurable meaning of "stable": vault invariants, reconciliation of every epoch, oracle cadence, keeper backlog within its service levels, site current, verification green, privileged-change rows unchanged. The rows not yet in the health check, and a "stable-days streak" row, are added with the operations update, before the count starts; any fix to the program resets the count.
4. The Artifact metadata lives on Arweave and the collection points at it (`refresh_collection_uri`).

Then, in one session: `anchor idl erase-authority` and `solana program set-upgrade-authority … --final`. Before signing, the on-chain program bytes are compared with a reproducible build of the published source. Both transactions are announced on the project's channels and recorded in this file, SECURITY.md, the README and the site's Transparency page.

**No later than 2026-12-31.** If the final upgrade has not been deployed by then, the authority is burned on the then-current binary, with the games delisted from the site (disclosed), or a later fixed date is published with the same rule. The freeze cannot slip without a date.

After the freeze, nothing in the program can change; only the off-chain parts listed above (oracle policy inside the on-chain bounds, the frontend, the oracle key hand-over) can. No new EVM portal will be added.
