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
| `npm run refresh-collection` | anyone: point the Artifact collection at the program's `METADATA_BASE_URI` (idempotent) |
| `npm run propose-oracle -- <pubkey>` / `npm run accept-oracle` | hand the oracle role to a new key (see below) |
| `npm test` | unit tests (no network) |

## Automation (GitHub Actions): what runs, when, and without whom

Everything the protocol needs runs in this repository's GitHub Actions. The runs sign with two wallet keys kept as repository secrets (`ORACLE_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`) and with each run's own `GITHUB_TOKEN`. No step uses a personal access token, a person's machine or a paid service, so everything keeps working if nobody touches the repository again. Switches: the repository variables `ORACLE_ENABLED`, `KEEPER_ENABLED` and `ANNOUNCE_ENABLED` (`true` to run).

| Workflow | When | What it does | Signs with |
|---|---|---|---|
| `oracle.yml` | Sundays 00:00 UTC, and whenever the keeper or the health check starts it | Job `epoch`: `npm run epoch` (build, publish, auto-claim; 60 minutes at most for that step), keeps the epoch files as a run artifact, commits `frontend/public/epochs/` (rebase and retry, never force) and starts the site deploy; the artifact and the commit happen whatever the publish step did (failed, timed out, cancelled). The unit tests run first but do not block (CI is where they do). The announcement is made only by the run that committed something, so a late cron tick after the keeper already published repeats nothing. Job `heartbeat`: writes and commits `ops/heartbeat.json` after every scheduled or real run, epoch or not, at most once a day (see below); if the epoch job published but could not push, this job commits the epoch files from the run artifact and starts the site deploy | `ORACLE_PRIVATE_KEY`, `GITHUB_TOKEN` |
| `keeper.yml` | every 15 minutes on paper; in practice GitHub fires only a few percent of the cron ticks of a public repository, so a run every 2–10 hours | Loops for 14 minutes (a pass every 15 s), stays up to 5.5 h more while a Prediction lock, a draw or a Moon Wars turn is due, and hands over to a new run (dispatch, five attempts) when such work remains. Before the loop it starts the oracle run if the weekly epoch is due and nothing is published yet (never while an oracle run is queued, pending or running, and not within 4 h of the last oracle run, so a week with a dead chain RPC leads to a retry every 4 h rather than one per keeper run), asks for a heartbeat if the last commit is 6 or more days old, and starts the daily health check if the last one is older than 22 h. After the loop it checks the weekly epoch once more (a long run can cross Sunday 00:00). A scheduled run whose loop failed retries once after 5 minutes; a dispatched one does not, so a persistent failure cannot chain forever | `KEEPER_PRIVATE_KEY` only, never `ORACLE_PRIVATE_KEY`: without that secret the loop does not run and the run fails (red, so the health check reports it), while the steps that need no key (starting the oracle run, the heartbeat, the health check) still run; `GITHUB_TOKEN` |
| `health.yml` | daily, 12:30 UTC, and started by the keeper when the last run is older than 22 h | Read-only: the weekly epoch against the burns waiting for it, wallet runway, vault solvency and 24 h drops, the reserve accounting, XNT price sources, every EVM RPC per chain, the epoch files on Pages against the chain, keeper freshness and the schedule variables, the oracle key and the program authority, overdue upkeep, the last run of every workflow, repository activity, site and agent card (see "Daily health check"). Red when something needs attention; GitHub then emails the account. Afterwards, whatever it found: asks for a heartbeat if the last commit is 7 or more days old, and re-enables five workflows through the API (listed below) | `GITHUB_TOKEN` |
| `announce.yml` | Mondays 15:00 UTC | Weekly state-of-the-forge post on the project's channels, only with `ANNOUNCE_ENABLED=true` and the channel secrets; otherwise the text is printed in the log | channel keys |
| `deploy-frontend.yml` | on a push that touches `frontend/**`, and dispatched by the oracle after every epoch commit | Builds the site and deploys it to GitHub Pages | OIDC token of the run |
| `ci.yml` | on push and pull request | Hardhat tests, oracle unit tests plus the health-rule tests and `tsc`, `cargo test` for the program, frontend build | nothing |
| `wording.yml` | on push and pull request | The public-text wording check (`scripts/wording-check.mjs`, rules in `docs/WORDING.md`) | nothing |
| `nft-arweave.yml` | manual, plus a daily gateway check at 04:41 UTC that does nothing until the upload record exists | One-off upload of the Artifact metadata to Arweave; afterwards the daily check that every file still serves on the gateways (seven consecutive passing days are needed before the address is compiled into the program) | a throwaway key made in the run (upload only); the check signs nothing |
| `program-tests.yml` | pull requests that touch the program, its tests or the agent kit; weekly; manual | The full program test suite on a local validator (`tests/run-local.sh` + the agent kit's end-to-end test); **required before any upgrade**, see below | nothing |

Costs: only the epoch and the keeper passes spend XNT (the oracle wallet pays each epoch's account rent and claim fees; the keeper wallet pays fees and receives the pool's keeper rebates). The heartbeat, the health check and the announcements cost nothing on-chain.

### Why the repository commits to itself

GitHub disables **every** scheduled workflow of a public repository after 60 days without a commit, including the health check that would re-enable the others, and weeks without burns produce no commit. So the `heartbeat` job of the oracle workflow commits `ops/heartbeat.json` (UTC time, last epoch, reward pool, bankroll and draw vaults, wallet balances) about once a week with the `GITHUB_TOKEN`, as `github-actions[bot]`. `ops/` is outside `frontend/`, and pushes made with the `GITHUB_TOKEN` start no workflow, so the commit never triggers a site deploy or CI. When X1 cannot be read the file still gets the time and the error: the commit is the point, not the numbers.

Three things request the heartbeat, because GitHub drops most cron ticks:

1. the oracle's own Sunday schedule: the heartbeat job runs after the epoch job, whether that one succeeded, failed or was skipped (`ORACLE_ENABLED` unset);
2. every keeper run, when the last commit on the branch is 6 or more days old (`gh workflow run oracle.yml -f heartbeat=true`, skipped while an oracle run is already queued or running);
3. the daily health check, when it is 7 or more days old.

A heartbeat-only run skips the `epoch` job entirely; the health check judges the oracle workflow by the runs where that job ran, so heartbeats never mask a failed epoch. A manual dry run (`dry=true`, the default) makes no commit at all.

Second layer: at the end of every health run, five workflows (`oracle.yml`, `keeper.yml`, `announce.yml`, `health.yml` and `program-tests.yml`) are re-enabled through the Actions API (the daily gateway check of `nft-arweave.yml` matters only until the metadata address is compiled in, so it is not on that list). The health table also reports "repository activity" (warn from 21 days, red from 40), so a broken heartbeat is visible long before day 60.

### What happens if GitHub stops anyway

- **Cron ticks dropped for hours** (normal): the keeper's backup dispatch starts the oracle once the Sunday slot has opened and nothing has been published; the keeper hands over to itself while time-sensitive upkeep is due; nothing is lost except game deadlines (next section).
- **A run fails**: the epoch files are kept as a run artifact before publishing and committed even when the publish step fails, times out or the run is cancelled, so an epoch that is on-chain never loses its proofs; if that commit cannot be pushed either, the heartbeat job of the same run commits the files from the artifact (second push path) and starts the site deploy; the next weekly slot retries the epoch; a failed scheduled keeper retries once, then waits for the next tick. Expired rounds are never re-drawn (they refund).
- **GitHub disables the schedules (60 days without a commit)**: this cannot self-heal, because a disabled workflow cannot be dispatched either; the heartbeat exists to prevent it. If it still happens, any push to `main` or "Enable workflow" on each disabled workflow brings everything back (write access to the repository, no secret needed). Meanwhile the portals keep accepting burns and every published epoch stays claimable from the site until its 90-day window ends; only new epochs and the keeper's upkeep stop.
- **GitHub Actions or Pages gone for good** (account, terms of service): the oracle and the keeper are plain `npm run epoch` and `npm run keeper` on any machine that has the keys (see Commands); the epoch files are in the git history and in every oracle run's artifact, and `npm run verify` recomputes them.

### Secrets, variables and the owner's token

Secrets: `ORACLE_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`, optional `X_*` channel keys (the `TELEGRAM_*` path in `oracle/src/announce.ts` is unused: Moon Forge has no Telegram channel, group or bot). Variables: `ORACLE_ENABLED`, `KEEPER_ENABLED`, `ANNOUNCE_ENABLED`, `PORTAL_<CHAIN>` and `START_<CHAIN>` per deployed portal, `PAT_EXPIRES`. The automation never uses a personal access token: `PAT_EXPIRES` (YYYY-MM-DD) only records when the token the owner uses for pushes from a person's machine expires, and the health check shows it as information. An expired token never turns the check red and stops nothing that runs here.

House bets must be settled within ~3 minutes or they count as lost, which GitHub Actions cannot guarantee (see the keeper's cadence above). The site settles each bet immediately; for extra safety run `npm run keeper` on any always-on machine (any funded X1 key works — keeping is permissionless). If a run is delayed and a draw expires, it is never re-drawn: the Jackpot round is refunded entry by entry, and the lottery round has no winner — its would-be prize (50% of the vault) goes to the burners' reward pool.

### Daily health check

`npm run health` (`.github/workflows/health.yml`, 12:30 UTC and on demand) is read-only, signs nothing, prints no secret and needs no person: the run's `GITHUB_TOKEN` and public RPCs only. The run goes **red** (GitHub emails the account) when something needs a human; everything merely worth knowing is a **warning** and never turns it red. The rules are pure functions in `oracle/src/health-rules.ts`, pinned by `oracle/test/health.test.ts` (run by CI); `oracle/src/health.ts` feeds them live data.

| Check | Red when | Note |
|---|---|---|
| weekly epoch | the weekly slot (Sundays 00:00 UTC) opened more than 48 h ago, nothing was published since, a portal registered burns after the last paid mission (`totalMissions` − the last paid `missionId`), **and** no oracle run with the epoch job succeeded since the slot opened | a late slot with no burn waiting is a quiet week (the program refuses empty epochs): warning only. Burns waiting after a *successful* run that published nothing also only warn: either the oracle saw them and found no value to pay (dust, a tier it does not pay, a chain with no market; such burns stay "waiting" until a paying burn lands on that chain) or they landed after that run and the next slot pays them |
| oracle wallet | below 0.05 XNT, or below 4 epochs of runway at the cost measured on the last 4 publications (fees and rent, net of refunds and tips) | warns below 12 epochs; while nothing is measured the cost is assumed at 0.02 XNT |
| keeper wallet | below 0.05 XNT | warns below 0.15; it receives tips from the pool |
| reward pool, bankroll vault, lottery vault | below rent, or lamports − rent < what the program reserved (`reward_reserved`, `bankroll_reserved`) | |
| reserved accounting | `Config.reward_reserved` is more than 1% (or 0.001 XNT) away from Σ open epochs (budget − claimed + unpaid drop reserve) | a smaller drift warns |
| reward pool 24h, bankroll 24h, lottery vault 24h | a drop of more than 20% since the previous snapshot that the lifetime counters (claims, drops, tips, prizes, house payouts, LP exits) do not explain | needs a snapshot younger than 36 h; the first run, or a missed day, compares nothing |
| bankroll today | the bankroll lost more than 20% since the start of the UTC day (the program's own breaker reference) | the breaker itself (10%) warns |
| XNT price sources | x1report, the XDEX API, the XDEX on-chain 15-minute TWAP and the GeckoTerminal candle in USDC.X (never its USD, which is wrong for X1) are more than 5% away from their median | fewer than two answering sources warns |
| rpc <chain> | no RPC of a live chain is fresh (head younger than 15 min) **and** serves the portal's code | a fallback in use, or a single survivor, warns and names the endpoint |
| pages epochs | `epochs/index.json` on GitHub Pages lists an epoch with a different root or data hash than the chain, misses one, lists one that is not on-chain, or the newest `epoch-N.json` is not served or differs | |
| keeper freshness | no keeper run (queued, running or finished; cancelled ones excluded) in the last 24 h | warns from 12 h; GitHub leaves gaps of several hours between keeper runs |
| keeper schedule, oracle schedule | the repository variable `KEEPER_ENABLED` / `ORACLE_ENABLED` is set to something other than `true` (a typo stops everything silently) | a variable that is not set at all is a deliberate stop: warning only |
| Keeper, Oracle, CI, Site deploy | the last completed run on the default branch (pull-request runs excluded, so a stranger's failing fork PR cannot turn CI red; for the oracle: the last run where the epoch job ran) did not succeed | Announce only warns |
| oracle key | `Config.oracle` is not the expected key (`ORACLE_PUBKEY` variable, else the built-in one), or a hand-over is pending | a leaked key would start with a `propose_oracle` |
| program authority | the upgrade authority is neither the architect nor burned, or it changed since the previous snapshot | a redeploy (new last-deploy slot) warns |
| keeper backlog | upkeep that already cost someone money and says the keeper is not passing: expired house bets still open more than 12 h after their target slot, a drawn Jackpot or Lottery round not settled inside its hash window, a Forge Drop seed not sealed | late items warn: bets past the ~3-minute settle window but younger than 12 h (lost for the player either way; the keeper closes them on its next pass), bets waiting, rounds, wars, Predictions, epochs past expiry |
| repository activity | the last commit is older than 40 days | warns from 21 (GitHub disables the schedules at 60) |
| site, agent card | not HTTP 200 (the card must be JSON) | |
| publishing token | never | `PAT_EXPIRES` is information only |

Where to read it: the run's **job summary** (one table, red first), the console log, and the artifact `health-snapshot` (`ops/health-latest.json`, kept 30 days: the rows plus the vault balances, lifetime counters and program authority the next run compares against). A chain read that fails is reported as "could not check" (a warning), never as a false alarm; only the X1 RPC itself being down is red on its own. Nothing is committed by this workflow.

Optional repository variables: `X1_RPC_URL`, `ORACLE_PUBKEY` and `KEEPER_PUBKEY` (set them after a key rotation, or the check watches the old wallet), plus the `PORTAL_<CHAIN>` the oracle already uses.

## Program tests (required before any upgrade)

`.github/workflows/program-tests.yml` runs the whole program test suite on a GitHub runner, exactly what `tests/run-local.sh` does by hand (it runs that script): cargo unit tests, IDL, the `--features localnet` build, the real Metaplex Core program dumped from X1 mainnet, a local validator, `tests/moon-forge.test.ts`, the randomized stress / solvency audit (`tests/stress.test.ts`) and, on a fresh validator, the agent kit's end-to-end test (`agents/kit/test/e2e-local.mjs`). Toolchain pinned to the versions of the README: Agave solana-cli 3.1.11, anchor-cli 0.32.1 (prebuilt release binary with a pinned sha256; built from the tag if that binary is ever gone), Node 22. No secrets, no token, nothing to renew.

It runs on every pull request that touches `programs/`, `tests/`, `agents/kit/` or the Cargo / Anchor files, once a week on the default branch (best effort, like every schedule), and by hand: Actions → Program tests → Run workflow, on any branch (`STRESS_SEED` / `STRESS_ROUNDS` reproduce a failed stress run). Each run uploads two artifacts: `program-tests-logs` (test output, validator logs) and `program-build` (`moon_forge.json` IDL, `moon_forge.so` = the mainnet binary rebuilt at the end of the script, `moon_forge_localnet.so`, and their sha256).

**Before any program upgrade ([DEPLOY.md](DEPLOY.md) step 1): run this workflow on the exact commit you intend to deploy and wait for green. A red or missing run means no upgrade.** Then compare the sha256 of `target/deploy/moon_forge.so` in the `program-build` artifact with the sha256 of the binary you are about to write to the buffer: they must match (same source, same toolchain; if they differ, find out why before deploying). The localnet binary must never be deployed.

A warm run (cargo, the Solana toolchain and the Core dump cached) takes roughly 25–45 minutes, a cold one up to about an hour; the job times out after 150 minutes. Public repositories get GitHub-hosted runners for free, so this costs nothing. The synthetic XDEX observation ring (`tests/fixtures/make-observation.cjs`) covers about 24 minutes from the validator start and the Predictions tests need it, so the unattended weekly run uses `STRESS_ROUNDS=5`; a weekly run that fails only in a Predictions test on a slow runner is that ring running out, not the program: run it again by hand (10 rounds) before reading anything into it.

**After the upgrade, before walking away: re-validate the health check against the new program.** `oracle/src/health-rules.ts` encodes what `Config.reward_reserved` must equal (`expectedReserved`: Σ over open epochs of budget − claimed, plus the unpaid drop reserve while the drop is pending or sealed) and the thresholds of the other rows. If the upgrade changes what the program reserves or how an epoch is accounted (per-chain capacity, Forge Right, a new drop reserve formula), run `cd oracle && npm run health` against the upgraded program (on localnet right after `tests/run-local.sh`, then on mainnet right after the deploy) and update `expectedReserved` and `oracle/test/health.test.ts` until "reserved accounting" is green. Otherwise the daily check stays red on that row for good, with nobody left to adjust it, and every real alert after it drowns in the noise.

## The oracle key

The oracle key is the one role that stays alive after the upgrade authority is burned, so treat it as the most important secret of the protocol.

- **Only the current oracle key can publish epochs and hand the role over.** Nobody else can replace it through the program as it is. Until the upgrade authority is burned, a program upgrade could; after that, nothing can.
- **If it is lost, the burn path stops paying for good.** Epochs that are already published can still be claimed until their 90-day windows end, but no new epoch can be published.
- **If it leaks,** whoever holds it can publish epochs. The program still caps each one at 10% of the free pool and at least 6 days apart, but those payouts could go to the wrong wallets. Hand the role to a fresh key at once.
- **Backups:** keep at least two offline copies of the key file in different places (for example two encrypted USB drives) in addition to the `ORACLE_PRIVATE_KEY` secret. Restore one of them once to make sure it works.

Hand-over to a new key (two steps, so a typo cannot lock the role away):

```bash
cd oracle
solana-keygen new -o new-oracle.json                    # or any Solana/SVM keypair; fund it with ~1 XNT
npm run propose-oracle -- <new pubkey>                  # signed by the current key (ORACLE_PRIVATE_KEY)
NEW_ORACLE_PRIVATE_KEY="$(cat new-oracle.json)" npm run accept-oracle   # signed by the new key
```

Then replace the `ORACLE_PRIVATE_KEY` secret (and `oracle/.env`) with the new key. Until `accept-oracle` runs, the current key keeps the role, and a new `propose-oracle` replaces a mistaken proposal.

## Safety rules built into the oracle

- reads only blocks older than each chain's finality depth;
- aborts the whole epoch if any block range cannot be read (never skips blocks);
- deduplicates events by (chain, tx hash, log index) and checks the portal address and chain id;
- prices only from pools quoted in an allowlisted liquid asset, using the deepest pool and the median of hourly closes, clamped against recent epochs (see the whitepaper);
- writes the epoch file **before** publishing, and refuses to continue if an on-chain epoch has no local file;
- self-verifies each epoch (recomputes leaves, root, data hash and `rate_cap`) before publishing.
