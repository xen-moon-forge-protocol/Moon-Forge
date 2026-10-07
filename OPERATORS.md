# Running the oracle and the keeper

The oracle is stateless: its memory is the epoch files in `frontend/public/epochs/` (committed to git, served by GitHub Pages). Anyone can verify them; only the oracle key can publish.

## Setup

```bash
cd oracle
npm install
cp .env.example .env     # ORACLE_PRIVATE_KEY (Solana keypair JSON array or Base58), PORTAL_<CHAIN>, START_<CHAIN>
```

The oracle wallet pays one epoch account rent (~0.002 XNT) per epoch and, when auto-claiming, the rent of claim receipts / missions (refunded after the epoch closes / when the mission ends) plus fees. Like any keeper it receives tips from the reward pool — never from the player: 0.002 XNT per claim of ≥ 0.02 XNT it submits for someone else, and 0.01 XNT per Forge Drop it delivers for someone else. Keep ~1 XNT in it.

## Commands

| Command | What it does |
|---|---|
| `npm run epoch -- --dry` | build the next epoch and print it, publish nothing |
| `npm run epoch` | build → write `epoch-N.json` → `publish_epoch` → auto-claim every leaf |
| `npm run claim -- <file>` | re-submit pending claims of an epoch |
| `npm run keeper` | loop every 15 s, in this order: close, draw and settle Jackpot and Burn Lottery rounds; settle house bets; seal and deliver Forge Drops; submit pending claims; pay back refunded Jackpot entries; expire epochs (`--once` = single pass, `--for <s>` = loop for s seconds). It does **not** push vested XNT — Orbit / Moon Landing burners use "Withdraw vested" (anyone can push it) |
| `npm run verify -- <file> [--full]` | anyone: recompute an epoch (including its `rate_cap`) and compare with X1 (`--full` also re-reads the EVM logs) |
| `npm run market` | print the current per-chain XEN price and eligible liquidity |
| `npm test` | unit tests (no network) |

## Weekly automation (GitHub Actions)

`.github/workflows/oracle.yml` runs `npm run epoch` every Sunday at 00:00 UTC (the program enforces ≥ 6 days between epochs) and commits the new epoch file, which redeploys the site. It runs only when the repository variable `ORACLE_ENABLED=true`. Secret: `ORACLE_PRIVATE_KEY`. Variables: `ORACLE_ENABLED`, plus `PORTAL_<CHAIN>` and `START_<CHAIN>` for each deployed portal. A manual run defaults to a dry run. A failed run publishes nothing; the next run retries.

`.github/workflows/keeper.yml` starts every 15 minutes and loops for 14 minutes (a pass every 15 s), so draws are normally settled within seconds — inside the ~3-minute block-hash window. GitHub can delay or skip scheduled runs, so this is best effort. It runs only when the repository variable `KEEPER_ENABLED=true`, and uses the secret `KEEPER_PRIVATE_KEY` (falling back to `ORACLE_PRIVATE_KEY`). It does everything `npm run keeper` does, so the protocol can keep running with no server. If a run is delayed and a draw expires, it is never re-drawn: the Jackpot round is refunded entry by entry, and the lottery round has no winner — its would-be prize (50% of the vault) goes to the burners' reward pool.

House bets must be settled within ~3 minutes or they count as lost, which GitHub Actions cannot guarantee. The site settles each bet immediately; for extra safety run `npm run keeper` on any always-on machine (any funded X1 key works — keeping is permissionless).

## Safety rules built into the oracle

- reads only blocks older than each chain's finality depth;
- aborts the whole epoch if any block range cannot be read (never skips blocks);
- deduplicates events by (chain, tx hash, log index) and checks the portal address and chain id;
- prices only from pools quoted in an allowlisted liquid asset, using the deepest pool and the median of hourly closes, clamped against recent epochs (see the whitepaper);
- writes the epoch file **before** publishing, and refuses to continue if an on-chain epoch has no local file;
- self-verifies each epoch (recomputes leaves, root, data hash and `rate_cap`) before publishing.
