# Contributing to Moon Forge

Moon Forge is MIT-licensed open-source software. There was no outside funding, no VC and no team token allocation. Contributions from anyone are welcome.

## Facts to keep in mind

- **Architect compensation:** the architect receives nothing from burns, claims, vesting or Forge Drops. Their only income is a disclosed share of optional activities (0.5% of house-game stakes, 0.5% of Jackpot/Duel pots when someone wins and of every lottery ticket, 5% of the Artifact forge price, and a 5% royalty on secondary Artifact sales where marketplaces honor it). See [ARCHITECT.md](ARCHITECT.md). These are compile-time constants in `programs/moon-forge/src/constants.rs`.
- **Upgradeable during the test period:** the program upgrade authority is held by the architect wallet during the public test period and is planned to be burned afterwards. Until then the program (including fees) can be replaced by an upgrade. See [SECURITY.md](SECURITY.md) and [IMMUTABILITY.md](IMMUTABILITY.md).
- **What is on-chain and what is not:** payouts, budgets, games, Artifacts and fees are enforced by the X1 program. The oracle that reads EVM burns and prices them runs off-chain; its output is bounded by the program and every epoch can be recomputed with `npm run verify` (see [OPERATORS.md](OPERATORS.md)).
- **Donations:** donations to the reward pool go 100% to burners through future epochs. Tips sent to the architect address go to the architect, not to the pool.
- **Forks:** if you fork the project, your version is yours — you can keep, change or remove the architect address and every parameter. See [FORK.md](FORK.md).

## Principles

1. **Privacy:** contributions are recognized by their code and impact; you do not need to reveal your identity.
2. **Transparency:** every rule should be checkable — in the program source, in published epoch files, or live on the Transparency page.
3. **Accuracy over marketing:** documentation must describe what the code does today, including its risks and limits.

## How to contribute

- **Code:** fork the repository and open a pull request for bug fixes, optimizations or features.
- **Documentation:** improve the guides, whitepaper and site copy (English).
- **Tools:** build analytics, bots (see [docs/BOTS.md](docs/BOTS.md)), keepers or alternative frontends.
- **Review:** read the code and the [internal review notes](docs/AUDIT-2026-10.md) and report what you find. Security issues: follow [SECURITY.md](SECURITY.md#reporting-a-vulnerability).
- **Discussion:** use GitHub issues for questions and proposals.

## Development process

1. Fork the repository.
2. Create a branch for your change.
3. Add or update tests (`cargo test -p moon-forge --lib`, `bash tests/run-local.sh`, `npx hardhat test`, `cd oracle && npm test`, `cd frontend && npm run build`).
4. Open a pull request with a clear description.

## Rewards

There is no treasury and no grant program. Contributions are unpaid; contributors are credited in the repository history and, for security reports, in the fix notes.
