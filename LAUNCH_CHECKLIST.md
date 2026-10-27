# Launch checklist (v2)

Details for every step: [DEPLOY.md](DEPLOY.md). Status as of 2026-10-22. The v2 launch is done; the open items below belong to the final program upgrade and the freeze, whose dates and conditions are in [IMMUTABILITY.md](IMMUTABILITY.md#when-the-upgrade-authority-will-be-burned).

## Before mainnet
- [x] `cargo test -p moon-forge --lib` passes
- [x] `bash tests/run-local.sh` passes (local validator + real Metaplex Core)
- [x] `npx hardhat test` passes (portal)
- [x] `cd oracle && npm test` passes
- [x] `cd frontend && npm run build` passes
- [x] Mainnet binary built **without** `--features localnet`; SHA-256 published (README status table)

## X1
- [x] Upgrade-authority wallet holds ≈ 9.2 XNT at deploy time (3.27 permanent extension + 5.89 buffer refunded in the same deploy)
- [x] `solana program deploy` (upgrade, auto-extends) + `anchor idl upgrade` (2026-10-07; second upgrade 2026-10-12, tag `program-2026-10-12`)
- [x] `npm run init` (initialize_v2, init_artifacts, sweep_legacy)
- [x] Transparency page shows config, vaults and the upgrade authority
- [ ] Artifact metadata on Arweave: the upload recorded in `deployments/nft-arweave.json` does not serve every file from every gateway; its JSON (v2 utility texts) will not be used, and its images are reused only if every file serves from the chosen gateway with a matching hash, otherwise re-uploaded; re-upload the final texts, check every file on two gateways for 7 days, then set `METADATA_BASE_URI` in the final upgrade and run `npm run refresh-collection`

## EVM
- [x] Portals deployed on exactly five chains: Base, Optimism, Polygon, BSC, Avalanche (2026-10-07). Ethereum and PulseChain: no portal, none planned by this project (left to the community as forks, [FORK.md](FORK.md)); no chain is added after the freeze
- [x] Portal addresses in `frontend/src/lib/constants.ts`; `PORTAL_*` / `START_*` repository variables set
- [x] Contracts verified (Sourcify, exact match)
- [x] A small burn on one chain went through burn → epoch → claim on mainnet: Optimism (mission 1), paid in epoch 1

## Oracle / keeper
- [x] Oracle key funded; secret `ORACLE_PRIVATE_KEY`; variable `ORACLE_ENABLED=true`
- [x] Dry run of the "Oracle epoch" workflow (and real runs: they read every live chain and publish nothing while there are no burns)
- [x] First epoch published (epoch 1, 2026-10-18; one burn) and matched against the on-chain epoch account; `cd oracle && npm run verify -- ../frontend/public/epochs/epoch-1.json --full`
- [x] Keeper: variable `KEEPER_ENABLED=true` + secret `KEEPER_PRIVATE_KEY` (GitHub Actions)
- [ ] A keeper that meets the games' deadlines for a week (GitHub cron fires only a few percent of its ticks; house games stay on the site behind the known-issues notice today; delisting them until a keeper meets its service level for a week is planned with the final upgrade)
- [ ] Late-run rule rehearsed: the oracle publishes only inside the 48 h after a Sunday 00:00 UTC slot; the epoch-2 window was 2026-10-25 00:00 → 10-27 00:00 UTC (the oracle ran inside it at 00:26 and 02:46 UTC on 10-25; no new burn, so nothing was published) (see [DEPLOY.md §4](DEPLOY.md#4-oracle) and [OPERATORS.md](OPERATORS.md))

## Pools & NFTs
- [x] Bankroll seeded (Be the House)
- [x] Reward pool seeded (Donate)
- [x] Genesis airdrop list rebuilt and `set_airdrop_root` called once (2026-10-12; final under the live program)
- [ ] Genesis notice published before the first of the 120 claims (what a Genesis Lunar Dust is after the final upgrade: a collectible with no floor and a cosmetic badge; the claimant pays the account rent)

## Communication
- [ ] Post in XEN communities of the five supported chains: "XEN Prime is for ETH-XEN; Base, Optimism, Polygon, BSC and Avalanche XEN → Moon Forge"; official links only; warn about clones; no paid promotion, nobody posting as someone else
- [x] Test period and the conditions for burning the upgrade authority published ([IMMUTABILITY.md](IMMUTABILITY.md#when-the-upgrade-authority-will-be-burned)); rewritten on 2026-10-22 (proof plan + 14 stable days, with or without external users; no later than 2026-12-31)
- [ ] v3 switch notice: the date of the first v3 epoch (planned for November 2026) and the last v2 publish transaction, published at least one full epoch ahead
- [ ] Final-upgrade announcement ≥ 7 days before the upgrade (`docs/UPGRADE-2026-11.md`: commit, hash procedure, changelog)
- [ ] Before any release of copy: `node scripts/wording-check.mjs` passes (the `Wording` CI job: [docs/WORDING.md §6](docs/WORDING.md#6-the-ci-check)) and every new public claim has a row in [docs/CLAIMS.md](docs/CLAIMS.md)

## Final upgrade and freeze
- [ ] Final upgrade deployed with the announced hash (earliest 2026-11-11)
- [ ] Mainnet proof plan complete with transaction links (every front once, small amounts, with or without external users)
- [ ] 14 consecutive daily health runs with no FAIL
- [ ] `anchor idl erase-authority` + `solana program set-upgrade-authority … --final` in one session (earliest 2026-11-25; no later than 2026-12-31 on the then-current binary); both signatures recorded in SECURITY.md, IMMUTABILITY.md and the README
