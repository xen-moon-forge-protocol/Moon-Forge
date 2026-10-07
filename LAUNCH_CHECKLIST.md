# Launch checklist (v2)

Details for every step: [DEPLOY.md](DEPLOY.md).

## Before mainnet
- [ ] `cargo test -p moon-forge --lib` passes
- [ ] `bash tests/run-local.sh` passes (local validator + real Metaplex Core)
- [ ] `npx hardhat test` passes (portal)
- [ ] `cd oracle && npm test` passes
- [ ] `cd frontend && npm run build` passes
- [ ] Mainnet binary built **without** `--features localnet`; SHA-256 published in the release notes

## X1
- [ ] Upgrade-authority wallet holds ≈ 9.2 XNT at deploy time (3.27 permanent extension + 5.89 buffer refunded in the same deploy)
- [ ] `solana program deploy` (upgrade, auto-extends) + `anchor idl upgrade`
- [ ] `npm run init` (initialize_v2, init_artifacts, sweep_legacy)
- [ ] Transparency page shows config, vaults and the upgrade authority

## EVM
- [ ] Portals deployed on the chosen chains (priority: BSC, Polygon, Avalanche, Optimism, Base, PulseChain; Ethereum optional — XEN Prime serves ETH-XEN)
- [ ] Portal addresses in `frontend/src/lib/constants.ts`; `PORTAL_*` / `START_*` repository variables set
- [ ] Contracts verified on explorers
- [ ] Test burn of a small amount on one chain

## Oracle / keeper
- [ ] Oracle key funded (~1 XNT); secret `ORACLE_PRIVATE_KEY`; variable `ORACLE_ENABLED=true`
- [ ] Dry run of the "Oracle epoch" workflow
- [ ] First real epoch published; `cd oracle && npm run verify -- ../frontend/public/epochs/epoch-1.json --full` passes
- [ ] Keeper: variable `KEEPER_ENABLED=true` + secret `KEEPER_PRIVATE_KEY` (GitHub Actions), and preferably `npm run keeper` on an always-on machine (GitHub runs can be delayed)

## Pools & NFTs
- [ ] Bankroll seeded (Be the House)
- [ ] Reward pool seeded (Donate)
- [ ] Genesis airdrop list rebuilt with Genesis supporters (validators + donors/LPs ≥ 5 XNT + upgrade funders ≥ 1 XNT) and `set_airdrop_root` called once (final)

## Communication
- [ ] Post in XEN/X1 communities: "XEN Prime is for ETH-XEN; BSC, Polygon, Avalanche, Optimism, Base and PulseChain XEN → Moon Forge (ETH-XEN can use either)"; official links only; warn about clones
- [ ] Announce the test period and the date the upgrade authority will be burned

## End of test period
- [ ] `solana program set-upgrade-authority … --final`
