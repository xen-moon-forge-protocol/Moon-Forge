# Launch checklist (v2)

Details for every step: [DEPLOY.md](DEPLOY.md). Status as of 2026-10-14.

## Before mainnet
- [x] `cargo test -p moon-forge --lib` passes
- [x] `bash tests/run-local.sh` passes (local validator + real Metaplex Core)
- [x] `npx hardhat test` passes (portal)
- [x] `cd oracle && npm test` passes
- [x] `cd frontend && npm run build` passes
- [x] Mainnet binary built **without** `--features localnet`; SHA-256 published (README status table)

## X1
- [x] Upgrade-authority wallet holds ≈ 9.2 XNT at deploy time (3.27 permanent extension + 5.89 buffer refunded in the same deploy)
- [x] `solana program deploy` (upgrade, auto-extends) + `anchor idl upgrade`
- [x] `npm run init` (initialize_v2, init_artifacts, sweep_legacy)
- [x] Transparency page shows config, vaults and the upgrade authority
- [ ] Artifact metadata on Arweave: upload done (`deployments/nft-arweave.json`); program upgrade with the new `METADATA_BASE_URI`, then `npm run refresh-collection`

## EVM
- [x] Portals deployed on the chosen chains: Base, Optimism, Polygon, BSC, Avalanche (PulseChain and Ethereum follow when their deploy gas is funded)
- [x] Portal addresses in `frontend/src/lib/constants.ts`; `PORTAL_*` / `START_*` repository variables set
- [x] Contracts verified (Sourcify, exact match)
- [ ] Test burn of a small amount on one chain

## Oracle / keeper
- [x] Oracle key funded; secret `ORACLE_PRIVATE_KEY`; variable `ORACLE_ENABLED=true`
- [x] Dry run of the "Oracle epoch" workflow (and real runs: they read every live chain and publish nothing while there are no burns)
- [ ] First real epoch published; `cd oracle && npm run verify -- ../frontend/public/epochs/epoch-1.json --full` passes
- [x] Keeper: variable `KEEPER_ENABLED=true` + secret `KEEPER_PRIVATE_KEY` (GitHub Actions)
- [ ] Preferably `npm run keeper` on an always-on machine too (GitHub runs can be delayed)

## Pools & NFTs
- [x] Bankroll seeded (Be the House)
- [x] Reward pool seeded (Donate)
- [x] Genesis airdrop list rebuilt and `set_airdrop_root` called once (final)

## Communication
- [ ] Post in XEN/X1 communities: "XEN Prime is for ETH-XEN; BSC, Polygon, Avalanche, Optimism, Base and PulseChain XEN → Moon Forge (ETH-XEN can use either)"; official links only; warn about clones
- [x] Test period and the conditions for burning the upgrade authority published ([IMMUTABILITY.md](IMMUTABILITY.md#when-the-upgrade-authority-will-be-burned))

## End of test period
- [ ] `solana program set-upgrade-authority … --final`
