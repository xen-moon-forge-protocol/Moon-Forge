# Running the oracle and the keeper

The oracle is stateless: its memory is the epoch files in `frontend/public/epochs/` (committed to git, served by GitHub Pages). Anyone can verify them; only the oracle key can publish.

This page is written so that the community can keep Moon Forge running with nobody from the project around: [When something breaks](#when-something-breaks) · [Community takeover runbook](#community-takeover-runbook) · [Becoming the house keeper](#becoming-the-house-keeper) · [Add a chain](#add-a-chain) · [Fork or continue](FORK.md#fork-or-continue).

**Two programs, one page.** Until the final upgrade (planned Wednesday 2026-11-18, 16:00–20:00 UTC: [docs/UPGRADE-2026-11.md](docs/UPGRADE-2026-11.md)) the v2 program runs. Everything this page says about the oracle seat, voids, the 48-hour claim hold, the house keeper seat and the Artifact floor hatch applies from that upgrade on; the seat commands refuse to run against the v2 program.

## Setup

```bash
cd oracle
npm install
cp .env.example .env     # ORACLE_PRIVATE_KEY (Solana keypair JSON array or Base58); every other setting is optional
```

No other setting is needed: the program id, the X1 endpoint and the five portals with their deploy blocks are built in (`oracle/src/config.ts` takes the portals from `deployments/portals.json`), so `npm run verify` and every read-only command work on a fresh clone. The workflows read the portals from that file only; `PORTAL_<CHAIN>` and `START_<CHAIN>` environment overrides remain for local tests (a portal set to an empty value skips that chain), so leave them unset.

The oracle wallet pays one epoch account rent (~0.002 XNT) per epoch plus fees; until the final upgrade the publish run also auto-claims and pays the rent of claim receipts / missions (refunded after the epoch closes / when the mission ends). Keep ~1 XNT in it. Like any keeper it receives tips from the reward pool, never from the player. Today: 0.002 XNT per claim of ≥ 0.02 XNT it submits for someone else, and 0.01 XNT per Forge Drop it delivers for someone else. From the final upgrade: claims open 48 hours after publication and the keeper (not the publish run) submits them; the tip is 0.002 XNT per claim of at least 0.2 XNT, never when the submitter is the player or the oracle key; Forge Drops are off for new epochs; and each publication pays the publishing key an operating allowance from the free pool (the new epoch account's rent back plus at most 0.05 XNT toward a balance of 0.25 XNT).

## Commands

| Command | What it does |
|---|---|
| `npm run epoch -- --dry` | build the next epoch and print it, publish nothing |
| `npm run epoch` | build → write `epoch-N.json` → `publish_epoch` → auto-claim every leaf |
| `npm run claim -- <file>` | re-submit pending claims of an epoch |
| `npm run keeper` | loop every 15 s, in this order: close, draw and settle Jackpot and Burn Lottery rounds; settle house bets; seal and deliver Forge Drops; submit pending claims; pay back refunded Jackpot entries; expire epochs (`--once` = single pass, `--for <s>` = loop for s seconds). On the upgraded program it also pushes vested XNT to Orbit / Moon Landing burners (`withdraw_vested`: once 30 days' worth has vested, and at completion, which returns the mission rent to whoever paid it) and reclaims Artifact records whose Core asset is gone (`reclaim_orphan`: only an absent asset or Core's one-byte burn tombstone; the floor goes to the reward pool), at most 20 and 10 per pass, each simulated first so nothing the program would refuse is sent. Both are permissionless: any funded key may run them |
| `npm run keeper-arm -- --deposit <XNT> [--yes]` | arm the house keeper seat with a chain this key derives (dry without `--yes`: the plan and the program's verdict, simulated); the first arm creates the seat (see "Becoming the house keeper") |
| `npm run keeper-take -- --deposit <XNT> [--yes]` | take the house keeper seat (its named successor after the notice, or anyone once it has been idle 28 days), with this key's own bond of at least 20 XNT |
| `npm run verify -- <file> [--full]` | anyone: recompute an epoch (including its `rate_cap`) and compare with X1 (`--full` also re-reads the EVM logs) |
| `npm run seat` | read-only, final program: the oracle seat, its liveness clock (days since the last epoch that survived its hold) and every epoch in its 48-hour hold, compared with the repository's files |
| `npm run void-epoch -- <n> [--extra] [--yes]` | anyone, during an epoch's 48-hour hold: void it with a bond paid to the reward pool (dry without `--yes`: the verdict, simulated; signed by `VOIDER_PRIVATE_KEY`, free when that is the seat's cold key; refuses the repository's own file unless `--even-if-ours`) |
| `npm run take-seat -- --hot <pk> --cold <pk> --refund <pk> [--yes]` | anyone, once the oracle seat is dead or open: take it with a bond, naming the new hot, cold and refund keys (dry without `--yes`; signed by `TAKER_PRIVATE_KEY`; `--as <pk>` simulates as a key whose secret is not on the machine) |
| `npm run rotate-hot -- --new-hot <pk> [--as <cold pk>] [--yes]` | the seat's cold key: replace the oracle hot key at once and wipe any pending hand-over (the theft response). Dry without `--yes` (the plan and the program's verdict, simulated as the cold key, or as `--as` without its secret); signed by `COLD_PRIVATE_KEY`, never in a workflow |
| `npm run resign-seat -- --successor <pk>\|none [--as <cold pk>] [--yes]` | the seat's cold key: hand the oracle seat back (its bond to the refund key, the seat open, the successor first for 24 hours, then anyone with `take-seat`); only a seat with an epoch that survived its hold in the last 28 days. Dry without `--yes`; `COLD_PRIVATE_KEY` |
| `npm run keeper-withdraw -- --notice start\|cancel [--yes]` / `-- --amount <XNT> [--yes]` | the house keeper: start or cancel the 7-day withdrawal notice (the program's toggle, named so a second call never cancels by accident), then withdraw from the bond with nothing pending, leaving 0 or at least 20 XNT. Dry without `--yes`; `KEEPER_PRIVATE_KEY` |
| `npm run propose-keeper -- <pk>\|none [--yes]` | the house keeper: name a successor, who may take the seat with `keeper-take` 7 days later; `none` cancels. Dry without `--yes`; `KEEPER_PRIVATE_KEY` |
| `npm run recover-epoch -- <n> [--from <file\|dir> ...] [--yes]` | anyone, no key: restore `epoch-<n>.json` from any copy whose data hash is the one the program recorded (the git history of every branch, GitHub Pages, the `--from` paths: a run artifact, a clone, a mirror); nothing else is ever accepted. Dry without `--yes` (see "epoch file missing" under When something breaks) |
| `npm run publish-extra [-- <n>]` | final program: publish the week's extra epoch; refuses unless the same file is already in the pushed history (`origin/<branch>`, or `EXTRA_DURABLE_REF`) |
| `npm run health` | the daily health check (read-only; see below) |
| `npm run market` | print the current per-chain XEN price and eligible liquidity |
| `npm run refresh-collection` | anyone: point the Artifact collection at the program's `METADATA_BASE_URI` (idempotent) |
| `npm run propose-oracle -- <pubkey>` / `npm run accept-oracle` | hand the oracle role to a new key (see below) |
| `npm test` | unit tests (no network) |

## Automation (GitHub Actions): what runs, when, and without whom

Everything the protocol needs runs in this repository's GitHub Actions. The runs sign with two wallet keys kept as repository secrets (`ORACLE_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`) and with each run's own `GITHUB_TOKEN`. No step uses a personal access token, a person's machine or a paid service, so everything keeps working if nobody touches the repository again. Switches: the repository variables `ORACLE_ENABLED`, `KEEPER_ENABLED` and `ANNOUNCE_ENABLED` (`true` to run).

| Workflow | When | What it does | Signs with |
|---|---|---|---|
| `oracle.yml` | Sundays 00:00 UTC, and whenever the keeper or the health check starts it | Job `epoch`: `npm run epoch` (build, publish, auto-claim; 150 minutes at most for that step: a read after weeks without a valued burn spans several weeks of blocks), keeps the epoch files as a run artifact, commits `frontend/public/epochs/` (rebase and retry, never force) and starts the site deploy; the artifact and the commit happen whatever the publish step did (failed, timed out, cancelled). The unit tests run first but do not block (CI is where they do). The announcement is made only by the run that committed something, so a late cron tick after the keeper already published repeats nothing. Job `heartbeat`: writes and commits `ops/heartbeat.json` after every scheduled or real run, epoch or not, at most once a day (see below); if the epoch job published but could not push, this job commits the epoch files from the run artifact and starts the site deploy | `ORACLE_PRIVATE_KEY`, `GITHUB_TOKEN` |
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
- **GitHub Actions or Pages gone for good** (account, terms of service): the oracle and the keeper are plain `npm run epoch` and `npm run keeper` on any machine that has the keys (see Commands); the epoch files are in the git history and in every oracle run's artifact, and `npm run verify` recomputes them. Without the keys: anyone runs the keeper at once, and from the final upgrade anyone can take the oracle seat once no epoch has survived its hold for 28 days ([Community takeover runbook](#community-takeover-runbook)).

### Secrets, variables and the owner's token

Secrets: `ORACLE_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`, optional `X_*` channel keys (Moon Forge has no Telegram channel, group or bot, and the announcer has no Telegram code). Variables: `ORACLE_ENABLED`, `KEEPER_ENABLED`, `ANNOUNCE_ENABLED`, `PAT_EXPIRES`, and the optional endpoint overrides in the table below. The portals and their deploy blocks are not variables: every workflow takes them from `deployments/portals.json` (GitHub passes a variable that is not set as an empty value, and an empty portal would skip that chain), so a `PORTAL_<CHAIN>` or `START_<CHAIN>` repository variable has no effect. The automation never uses a personal access token: `PAT_EXPIRES` (YYYY-MM-DD) only records when the token the owner uses for pushes from a person's machine expires, and the health check shows it as information. An expired token never turns the check red and stops nothing that runs here.

Five more settings, each read by the workflows but normally absent. Only the operator sets or deletes them, through the GitHub API; none of them needs a web session.

| Setting | State to keep | What it does |
|---|---|---|
| `X1_RPC_URLS` (variable) | **unset** | An optional comma list of X1 endpoints, tried before the default one by the oracle, the keeper and the health check (`oracle/src/x1-rpc.ts`). Unset means exactly the default endpoint. GitHub prints a step's environment in the public run logs, so it may only ever hold endpoints that carry no key; the health check warns about an entry with a path or a query. |
| `X1_RPC_URL` (variable) | **unset** while the built-in endpoint answers | Replaces the default X1 endpoint itself (`https://rpc.mainnet.x1.xyz`, `oracle/src/config.ts`), the one the keeper's reveals and the upgrade check trust: set it when that endpoint is dead or renamed, no code edit needed. Every workflow step that reads X1 passes it (oracle, keeper, heartbeat, health, verify, announcements). Public in the run logs like the variable above: a keyless endpoint only. Empty means the built-in one. |
| `OP_RPC_URL`, `BSC_RPC_URL`, `POLYGON_RPC_URL`, `AVAX_RPC_URL`, `BASE_RPC_URL` (variables) | **unset** while the built-in lists answer | A comma list that replaces that chain's EVM endpoint list (tried in order) for the epoch build, the week-so-far feed, the health check, the verify job and the announcements. Set one when the health row `rpc <chain>` turns red. Public in the run logs: keyless endpoints only. Empty means the built-in list. |
| `GATE_BLOCK` (variable) | **must stay unset** | `true` holds an epoch whose anomaly-gate hold has run out until an operator clears it (D-17). It is set only while one specific epoch is held, and deleted right after. The health check is amber while it is set. |
| `oracle` (environment) | exists, deployments from `main` only, no reviewers, no wait timer | Declared by the `epoch` job of `oracle.yml` only. It holds no secret: `ORACLE_PRIVATE_KEY` and `KEEPER_PRIVATE_KEY` stay repository secrets. Reviewers or a timer would delay the Sunday run, so none is set. |

`DISPATCH_EXPIRES` is not used: no outside scheduler starts these workflows, so leave it unset; the health check would only show it as information.

**Today (v2 program):** house bets must be settled within ~3 minutes or they count as lost, which GitHub Actions cannot guarantee (see the keeper's cadence above). The site settles each bet immediately; for extra safety run `npm run keeper` on any always-on machine (any funded X1 key works — keeping is permissionless). If a run is delayed and a draw expires, it is never re-drawn: the Jackpot round is refunded entry by entry, and the lottery round has no winner — its would-be prize (50% of the vault) goes to the burners' reward pool.

**From the final upgrade (planned 2026-11-18):** an unsettled bet no longer counts as lost. A house bet is anchored to the next block by anyone (the site does it about 2 seconds after placing); a bet nobody anchors within 512 slots (about 3 minutes) is refunded in full, and an anchored bet the house keeper does not reveal within 235,000 slots (about a day) is paid to the player as a win from the keeper's bond. A Jackpot round the keeper does not settle in time refunds every entry. No new Burn Lottery round can open (a round open at the upgrade settles under its old rule), and a donation to its prize vault is refused. `npm run keeper` (any funded key) anchors bets and sends every refund and settlement that is due.

### Becoming the house keeper

House bets and the Jackpot need one house keeper: the key that holds the keeper seat, posts its bond and reveals its hash chain (`oracle/src/keeper-v3.ts`). Any always-on machine with that key runs `npm run keeper`; the GitHub keeper only helps. Anyone can become the keeper in one of two ways, with their own bond of at least 20 XNT (every stalled bet is paid from it, and it comes back in full when the seat changes hands):

1. **The seat was never created.** Until 2026-12-16 00:00 UTC (`KEEPER_OPEN_TS`) only the program's `INITIAL_KEEPER` can create it. From that time, if nobody has, any key can:
   ```
   cd oracle
   KEEPER_PRIVATE_KEY=<your key> npm run keeper-arm -- --deposit 20        # dry: the plan and the program's verdict
   KEEPER_PRIVATE_KEY=<your key> npm run keeper-arm -- --deposit 20 --yes  # creates the seat with you as its keeper
   ```
2. **The seat exists but its keeper went quiet.** After 28 days without an arm, a reveal or a settle (`KEEPER_DEAD_DELAY`), anyone can take it; the old bond goes back to the old keeper:
   ```
   KEEPER_PRIVATE_KEY=<your key> npm run keeper-take -- --deposit 20        # dry: the plan
   KEEPER_PRIVATE_KEY=<your key> npm run keeper-take -- --deposit 20 --yes
   ```

After either, run the keeper with the same key (`npm run keeper` signs with `ORACLE_PRIVATE_KEY`, as `keeper.yml` passes it): `ORACLE_PRIVATE_KEY=<your key> npm run keeper -- --once` must show `role holder`; then keep `ORACLE_PRIVATE_KEY=<your key> npm run keeper` running on a machine that is always on (it re-arms the seat itself with deposit 0 when the chain runs low or the seat has been idle 7 days). Whoever holds that key learns each anchored bet's outcome first, so it stays on that machine. Both commands refuse to send anything the program would refuse (they simulate first) and say why.

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
| bankroll today | the bankroll lost more than 20% since the start of the UTC day (the program's own breaker reference) | v2 program: a loss of 10% warns (its breaker). Final program: the row uses its limit, so it warns once the bankroll, counting every open bet as won, is 3% under the day's start (new house bets are then refused until 00:00 UTC) |
| bankroll 7 days | never | final program only: warns once the keeper seat's 7-day window has used its limit (realized net loss plus every open payout above 15% of the window base): new house bets are refused until the window ends |
| payee wallet | never | warns while the architect payee wallet (`Config.architect`) holds less than rent exemption + 0.01 XNT: a cut that would leave it under rent goes to the reward pool instead (send it a little XNT); ok when the payee is the reward vault (renounced) |
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

More rows, each explained where it can go wrong in [When something breaks](#when-something-breaks): "X1 RPC" and "X1 RPCs" (the X1 endpoints), "XEN price sources" (GeckoTerminal or the on-chain pools, per chain), "nft metadata gateway", "program version", and, printing "n/a until upgrade" while the v2 program runs, "oracle seat" (days since the last epoch that survived its hold), "oracle publications" (an epoch in its hold that is not the repository's file is red and the row prints the void command), "our epochs voided", "verify" (`verify --full` of the newest files), "keeper seat", "keeper service level", "keeper bond cover", the extra-pot rows and the "pin:" rows (`oracle/src/health-pins.json`).

Where to read it: the run's **job summary** (one table, red first), the console log, and the artifact `health-snapshot` (`ops/health-latest.json`, kept 30 days: the rows plus the vault balances, lifetime counters and program authority the next run compares against). A chain read that fails is reported as "could not check" (a warning), never as a false alarm; only the X1 RPC itself being down is red on its own. Nothing is committed by this workflow.

Optional repository variables the check reads: `X1_RPC_URLS` and `X1_RPC_URL` (the X1 endpoints it probes, the same ones the oracle and the keeper use), `OP_RPC_URL`, `BSC_RPC_URL`, `POLYGON_RPC_URL`, `AVAX_RPC_URL` and `BASE_RPC_URL` (each chain's EVM endpoint list, the same ones the oracle uses; the verify job reads them too), `ORACLE_PUBKEY` and `KEEPER_PUBKEY` (set them after a key rotation, or the check watches the old wallet). An unset or empty endpoint variable means the default in `oracle/src/config.ts`; the portals it checks are those of `deployments/portals.json`, as for the oracle.

## When something breaks

Find the row by what you see: a red or amber row of the daily health check (its name in quotes, as printed by `npm run health` and in the job summary of each `health.yml` run, which anyone can open in the repository's Actions tab), or what a user sees. Commands run in `oracle/` unless said otherwise; `gh` is GitHub's command-line tool, run in a clone of the repository. Rows about the oracle seat, voids, the house keeper seat, SlotHashes and the floor hatch apply from the final upgrade (planned 2026-11-18).

Who can apply the fix: **anyone** = any funded X1 key, no permission needed; **repo writer** = write access to this GitHub repository (after the freeze the builder plans no routine action, so without a writer the same fix is made in a fork: [Community takeover runbook](#community-takeover-runbook)); **seat holder** = the oracle seat's hot key; **cold-key holder** = the seat's cold key; **house keeper** = the key that holds the house keeper seat; **X1** = X1's core developers and validators (with Metaplex for its Core program).

| # | Symptom (health row, or what a user sees) | Likely cause | Fix | Who |
|---|---|---|---|---|
| 1 | "weekly epoch" red; "Oracle" (last run) red; no new epoch for 8 days or more | the oracle workflow failed or is switched off (`ORACLE_ENABLED` not `true`); the oracle wallet is empty; an X1 or EVM endpoint or a price source is dead; the hot key is lost | open the failed `oracle.yml` run and read the failing step, then: rows 11-12 (workflows), 13 (wallet), 7-10 (endpoints, prices). A lost hot key: the cold-key holder replaces it with `rotate_hot` (row 2); before the upgrade only the current key can hand the role over. Deadline from the upgrade: an epoch must survive its 48-hour hold at least once every 28 days, or the seat dies (row 3); a quiet week publishes an empty base epoch, which counts | seat holder or repo writer; cold-key holder; then anyone (row 3) |
| 2 | "oracle publications" red (an epoch in its hold that is not the repository's file; the row prints the void command); "verify" red; "our epochs voided" | a stolen hot key, a bug or a wrong input | inside the 48-hour hold: `VOIDER_PRIVATE_KEY=<key> npm run void-epoch -- <n>` (dry: the program's verdict), then the same with `--yes` (`--extra` for an extra epoch). Bond max(0.05 XNT, 10% of its budget; for an extra epoch, of the larger of its budget and the same week's base budget), 1 XNT for an empty epoch, paid to the reward pool; nothing in a held epoch can be claimed. The cold-key holder voids for free with the same command (`VOIDER_PRIVATE_KEY=<cold key>`) and replaces the hot key with `COLD_PRIVATE_KEY=<cold key> npm run rotate-hot -- --new-hot <pk>` (then `--yes`), then replaces the `ORACLE_PRIVATE_KEY` secret. An epoch that was not voided in time and whose file nobody has: row 23 | anyone, within 48 h; cold-key holder |
| 3 | "oracle seat" red: no epoch published in the last 28 days has survived its hold | nobody runs the oracle any more (keys, account or operator gone) | the seat is dead: the largest voider since the last take may take it from day 28, anyone from day 29, with a bond of max(1 XNT, 10% of the free reward pool), and publish again with the same code on the same pools ([Community takeover runbook](#community-takeover-runbook)). Meanwhile published epochs stay claimable for 90 days and unclaimed budgets return to the pool (`expire_epoch`, sent by any keeper) | anyone |
| 4 | "keeper freshness" or "keeper backlog" red; claims arrive late; bets, rounds or matches wait for upkeep | GitHub fires the keeper only every few hours; the keeper wallet is empty | `ORACLE_PRIVATE_KEY=<any funded key> npm run keeper` on an always-on machine: it claims for everyone after the hold, settles, refunds stalled bets and rounds, pushes vested XNT, reclaims orphaned floors and expires old epochs, tipped by the pool for claims; fund the keeper wallet (row 13) | anyone |
| 5 | the site says house games and the Jackpot are hidden ("no live house keeper") and names the failing check; "keeper seat", "keeper service level" | no house keeper seat yet, or its keeper stopped revealing | until 2026-12-16 00:00 UTC only `INITIAL_KEEPER` can create the seat; from then anyone: `KEEPER_PRIVATE_KEY=<your key> npm run keeper-arm -- --deposit 20 --yes`; a seat idle for 28 days: `KEEPER_PRIVATE_KEY=<your key> npm run keeper-take -- --deposit 20 --yes` ([Becoming the house keeper](#becoming-the-house-keeper)). The site shows the games again by itself once the chain shows a live keeper (read from X1 every 30 seconds). Bets already made keep their exits: `npm run keeper` (anyone) sends the refunds and the stall payouts from the bond | anyone, with a bond of at least 20 XNT; house keeper |
| 6 | bets cannot be anchored and Jackpot rounds being drawn do not settle, on a chain that otherwise works; "keeper backlog" grows | X1 stopped serving the SlotHashes sysvar | nothing can be sent early. After 235,000 slots (about one day) the program treats each such bet or round as expired, and `npm run keeper` refunds it (an unanchored bet in full; a Jackpot round entry by entry). Report it to X1 with a stuck bet's account | anyone; X1 |
| 7 | "X1 RPC" red (the only row that is red on its own); "X1 RPCs" names the failing endpoint; the site's data does not load | the default endpoint `https://rpc.mainnet.x1.xyz` is down, renamed or rate-limited | `gh variable set X1_RPC_URL --body https://<keyless X1 endpoint>` replaces the default endpoint, the one keeper reveals and the upgrade check trust; `gh variable set X1_RPC_URLS --body "https://a,https://b"` adds endpoints tried first (each must report X1 mainnet's genesis hash). Keyless endpoints only: the run logs are public. On your own machine set the same names in `oracle/.env`. Site: change `X1_RPC` in `frontend/src/lib/protocol.ts` and redeploy; kit users pass `connect({ rpc })` | repo writer; anyone (own machine, kit) |
| 8 | "rpc <chain>" red: no endpoint of that chain is fresh and serves the portal's code (amber while a fallback is in use) | public EVM endpoints retired or rate-limited | `gh variable set BASE_RPC_URL --body "https://a,https://b"` (likewise `OP_RPC_URL`, `BSC_RPC_URL`, `POLYGON_RPC_URL`, `AVAX_RPC_URL`): keyless endpoints that serve `eth_getLogs` over week-old blocks; or change the default list in `oracle/src/config.ts`. Meanwhile that chain is skipped with its cursor kept: its burns wait and are paid later; nothing is lost | repo writer; anyone (own machine) |
| 9 | "XEN price sources" amber ("on-chain pools only"), or red ("NO SOURCE" for a chain through 2 weekly runs); epochs pay nothing on that chain | GeckoTerminal down, rate-limited or changed | amber: nothing to do; the oracle prices that chain from the XEN pools it already knew, read on-chain at the build (reserves times the Chainlink price of the quote token, the same eligibility rules), and `verify --full` re-reads the same pools. Red: fix the GeckoTerminal client in `oracle/src/pricing.ts`, or the chain's endpoint list (row 8), which the on-chain read uses. An unpriced chain is skipped with its cursor kept | repo writer |
| 10 | "XNT price sources" red (sources more than 5% apart) or amber (fewer than two answer) | a price API died, changed or misprices | update its client in `oracle/src/pricing.ts` and `oracle/src/health.ts`; the XDEX on-chain 15-minute TWAP needs no API; never use GeckoTerminal's USD figure for X1 (use its USDC.X candle) | repo writer |
| 11 | "repository activity" amber from 21 days, red from 40; after 60 days no workflow runs at all, the health check included | GitHub disables every scheduled workflow of a public repository after 60 days without a commit; the heartbeat commit stopped | any push to the default branch, or Actions → each disabled workflow → Enable workflow (`gh workflow enable oracle.yml`, then `keeper.yml`, `health.yml`, `announce.yml`, `program-tests.yml`). A disabled workflow cannot be started by another one, so this cannot heal by itself | repo writer; without one, anyone runs the keeper and, once the seat dies, row 3 |
| 12 | no new runs, `ops/heartbeat.json` getting old, GitHub's failure e-mails; jobs fail at "Set up job" or inside a pinned action | GitHub retired the runner label (`ubuntu-24.04`), the Node version (`22`, end of life April 2027) or the runtime of a pinned action | in `.github/workflows/*.yml` move `runs-on`, `node-version` and every SHA-pinned action to a supported version (keep pinning by commit SHA, the version in the comment); run CI and `cd oracle && npm test`. The health check stops with the others, so check the Actions tab by hand | repo writer |
| 13 | "oracle wallet" red (below 0.05 XNT or under 4 epochs of runway); "keeper wallet" red (below 0.05 XNT) | fees and rent spent | send XNT to the address the row prints | anyone |
| 14 | "site", "agent card" or "pages epochs" red; the repository or GitHub Pages unavailable | a Pages outage; the account suspended or gone | host a copy of the site anywhere and serve the epoch files from any clone or the oracle run artifacts (kept 90 days), each checked against the data hash stored on-chain with `npm run verify -- <file> --full` ([runbook step 6](#6-host-the-epoch-files-and-the-site)); the kit reads epoch files from any directory or URL. Published epochs stay claimable for 90 days | anyone |
| 15 | "nft metadata gateway" red (the files missed on 3 runs over 48 hours); wallets show broken Artifact images | the gateway host compiled into the program's `METADATA_BASE_URI` stopped serving | the on-chain address cannot change (`refresh_collection_uri` only points the collection at the compiled value). The files stay on Arweave under the manifest id recorded in `deployments/nft-arweave-final.json`, readable through any Arweave gateway, and the site keeps its own copy; publish the working gateway URL in the docs. Floors, recycling and the market do not depend on the images | nobody on-chain; repo writer (docs) |
| 16 | forging, listing, buying and recycling all fail; `solana program show CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d -u https://rpc.mainnet.x1.xyz` shows the program closed (its ProgramData account gone) | Metaplex Core was closed on X1 | recycle anyway: `recycle_artifact` pays the floor to the holder without Core when the holder passes Core's ProgramData account `9ZC25KLUrfgSoFVgjE1rrydZBbZns58UXi8A8ZhTdGfr` as one extra account; the site and the agent kit add it by themselves. Forging and the market stay stopped (they hold no XNT) | each holder |
| 17 | Core errors on forge, recycle or the market while Core is not closed (its last-deploy slot is new) | an incompatible upgrade of Metaplex Core | nothing in Moon Forge can fix it: floors wait until Core works again. Report a failing transaction to X1 and to Core's maintainers. Do not burn Artifacts in a wallet app meanwhile: the floor of an Artifact burned outside Moon Forge goes to the reward pool (`reclaim_orphan`), not to its holder | X1 / Metaplex |
| 18 | every transaction to the program `57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9` fails after an X1 network upgrade with a runtime error (the program does not start, a syscall is missing), not a program error | an X1 feature gate stopped executing this program's SBPF v0 binary or a syscall it uses (keccak for every claim proof) | nothing in this repository can fix it, and after the freeze no key can. Report to X1's core developers: the program id, one failing transaction signature, the output of `solana cluster-version -u https://rpc.mainnet.x1.xyz` and `solana feature status -u https://rpc.mainnet.x1.xyz`, and ask for the gate to be reverted or for old binaries to be re-enabled. Every XNT stays in the program's accounts meanwhile | X1 |
| 19 | the architect payee wallet's balance stops growing while forges, sales and games go on (the Transparency page's architect counter keeps counting the cut, wherever it went) | the payee wallet's balance plus a cut is below the rent-exempt minimum of an empty account, so the program sends that cut to the reward pool instead | send at least 0.01 XNT to the payee wallet (`Config.architect`) with a plain transfer; the health row "payee wallet" warns while it holds less than rent exemption + 0.01 XNT. Nothing is lost: cuts already redirected stay in the burners' pool | anyone |
| 20 | the keeper reveals late after an X1 change of slot time; the site's service-level check fails more often; stalls are refunded sooner or later than about a day | X1 changed its slot time (the program counts keeper windows in slots) | update the off-chain slot constants: `SLOT_SECONDS_FAST` in `oracle/src/keeper-v3.ts`, `X1_SLOT_SECONDS` in `oracle/src/flow-v3.ts` and the slot-to-minutes conversions in `frontend/src/v3/keeper.ts`; the house keeper reveals faster. Nothing locks: the windows only shrink or stretch | repo writer; house keeper |
| 21 | "bankroll today" red (more than 20% lost since the UTC day started) or "bankroll 24h" red; amber "bankroll today" or "bankroll 7 days" on the final program (its own limits reached: −3% in a UTC day counting every open bet as won, or −15% over the keeper seat's 7-day window; new house bets are refused until the day or the window ends) | a losing streak, an aimed bet or a keeper fault | check the pending bets and the keeper rows; the program itself stops new house bets at its daily and 7-day limits; Be the House depositors can always withdraw their free share (a 24-hour request, then 24 hours to use it) | anyone |
| 22 | every Prediction refunds | XDEX changed its accounts, or nobody swapped | expected: every failed price read refunds. Predictions are not offered on the site or in the kit | nobody |
| 23 | **epoch file missing**: `npm run epoch` refuses ("epoch-N.json is missing locally" or "is not the file the program recorded for epoch N"); the weekly epoch stops | the file of the newest epoch on chain was lost (the commit and its run artifact both failed), or that epoch was published by someone else (a stolen hot key) and its file was never made public | (1) `npm run recover-epoch -- N`: it searches the git history of every branch and GitHub Pages and lists every copy with its verdict; add `--from <path>` for any other copy (an oracle run's artifact `epochs-<run id>`, unzipped; a clone; a mirror), then `--yes`. Only a copy whose data hash equals the one the program recorded is restored, so the next build continues exactly where the published history stands. (2) If no copy exists and the epoch is still inside its 48-hour hold: void it (row 2). (3) If no copy exists at all, nothing in this repository builds past it, by design: the next file's state (each chain's block cursor, curve, liquidity and price reference, the portal counters, the extra pot's base) is defined by that file. Rebuilding from the file before it would pay that epoch's burns again to burners its leaves already paid; skipping its window would drop burns. A voided epoch paid nothing (no claim is possible inside the hold), so continuing after a void is safe in principle, but it is a rules change: the next file must record the voided epoch it skips (hashed), take its window start and pool from the file before it, and `verify` and the agent kit must check that gap against the chain's `EpochVoided` record. It is published like any rules change, two epochs ahead (POLICY-CHANGES.md), by whoever holds the oracle seat; until then the seat can be taken (row 3) but not continued | anyone (1, 2); the seat holder, with a rules release (3) |

**What never needs anyone.** Game-wallet withdrawals, Be the House exits, claims of published epochs (by the burner, or by anyone for the burner), vesting withdrawals and early exits, recycling, closing expired listings, timeouts, refunds of stalled bets and rounds, and epoch expiry are permissionless instructions of the program: they keep working from the site, a copy of it, the agent kit or any client with the IDL, with nobody running anything. The portals keep accepting burns forever; a burn waits until an epoch pays it.

## Community takeover runbook

*Applies from the final upgrade (planned Wednesday 2026-11-18): the oracle seat, voids and the house keeper seat do not exist in the v2 program that runs until then.*

How anyone, starting from a fork or a clone of the public repository and holding none of the project's secrets, keeps Moon Forge running on the same program and the same pools. Nothing here needs anyone's permission, and nobody can veto it.

**What you can do:** run the keeper (claims for everyone, settlements, refunds, vested pushes, orphan reclaims, expiries); verify any epoch; void a wrong epoch during its 48-hour hold; take a dead oracle seat; create the house keeper seat from 2026-12-16 00:00 UTC if it was never created, or take it after 28 idle days; host the site and the epoch files. **What you cannot do:** move pool money except by the program's rules; publish an epoch without holding the seat; change any rule, fee or split; publish to this repository's GitHub Pages.

### 1. Your keys

```bash
solana-keygen new -o ~/keys/keeper.json   # signs keeper passes; fund it with at least 0.2 XNT
solana-keygen new -o ~/keys/hot.json      # the oracle hot key after a take; about 1 XNT
solana-keygen new -o ~/keys/taker.json    # signs take_seat and pays the seat bond
solana-keygen new -o ~/keys/cold.json     # the seat's cold key: offline, never on the oracle machine, never in GitHub
```

Solana/SVM keypairs only, never an EVM key. The refund key (`--refund`) is the wallet that receives the seat bond back after a graceful resign: any address you control. Use different keys for the keeper and the hot key (a claim sent by the oracle key receives no tip). Keep two offline copies of every key and restore one once to prove it works.

### 2. Set up and verify first

```bash
git clone https://github.com/<you>/Moon-Forge && cd Moon-Forge/oracle   # your fork, or a clone of the original
npm ci --ignore-scripts
npm run seat                                                         # the seat, its liveness clock, the epochs in their hold
npm run verify -- ../frontend/public/epochs/epoch-<N>.json --full     # the newest file: it must verify, not "VERIFICATION FAILED"
npm run epoch -- --dry                                               # builds the next epoch from the files and the chains, publishes nothing
ORACLE_PRIVATE_KEY="$(cat ~/keys/keeper.json)" npm run keeper -- --once   # one keeper pass; prints its role
solana program show 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 -u https://rpc.mainnet.x1.xyz   # after the freeze: no authority
```

No setting is needed: the program id, the X1 endpoint and the five portals with their deploy blocks are built in. Each build continues from the file of the newest epoch on chain, and `npm run epoch` refuses to run while that file is missing or is not the one the program recorded (its data hash), so work from a clone with the complete `frontend/public/epochs/`; `npm run recover-epoch -- <n>` restores a missing file from any copy the chain confirms. If the newest epoch on chain has no public file at all (for example one published by a stolen key), see row 23 of [When something breaks](#when-something-breaks).

### 3. Run the keeper (anyone, any time, no seat needed)

```bash
ORACLE_PRIVATE_KEY="$(cat ~/keys/keeper.json)" npm run keeper
```

The command reads its signer from `ORACLE_PRIVATE_KEY` (the name is historical; give it the keeper key). Run it on a machine that is always on; it does everything listed under Commands and simulates each transaction first, so it never sends what the program would refuse.

### 4. Take the oracle seat after it dies

**When:** `npm run seat` shows that no epoch published in the last 28 days has survived its 48-hour hold. From day 28 only the largest voider since the last take may take it; from day 29 (28 days + 24 hours) anyone. A resigned (open) seat goes to its named successor for 24 hours, then to anyone. **Bond:** max(1 XNT, 10% of the free reward pool), paid by the taker, forfeited to the pool if your seat later dies, returned to the refund key only by a graceful resign of a living seat; with a free pool of 10,000 XNT that is 1,000 XNT. The old keys lose every power in the same transaction.

```bash
TAKER_PRIVATE_KEY="$(cat ~/keys/taker.json)" npm run take-seat -- --hot <hot pubkey> --cold <cold pubkey> --refund <refund pubkey>        # dry: the plan and the program's verdict
TAKER_PRIVATE_KEY="$(cat ~/keys/taker.json)" npm run take-seat -- --hot <hot pubkey> --cold <cold pubkey> --refund <refund pubkey> --yes
```

### 5. Publish every week

```bash
ORACLE_PRIVATE_KEY="$(cat ~/keys/hot.json)" npm run epoch            # the base epoch; in a week without a paying burn, the empty base epoch
git add ../frontend/public/epochs && git commit -m "Epoch <N>" && git push   # the files must be public before the extra epoch
ORACLE_PRIVATE_KEY="$(cat ~/keys/hot.json)" npm run publish-extra    # the week's extra epoch; refuses until its file is in origin/main
```

Run `npm run epoch` from a scheduler every few hours: it publishes only when the epoch is due (the weekly slot opens Sundays 00:00 UTC, and the program needs at least 6 days between epochs). Never skip a week: an empty base epoch that survives its hold keeps the seat alive, and 28 days without one kill it. Claims open 48 hours after publication; your keeper (step 3) submits them. During each hold anyone can recompute your epoch and void it if it is wrong, so publish only what `npm run verify -- <file> --full` confirms. Keep the cold key off this machine.

### 6. Host the epoch files and the site

The project's GitHub Pages belongs to the project's account, so publish your copies where anyone can read them:

- **Epoch files:** commit them to your fork's `frontend/public/epochs/` (step 5); any public git or static host works. A copy cannot forge payouts: the program stored each epoch's root and data hash when it was published, `npm run verify -- <file> --full` recomputes the file from the burns, and the agent kit checks every leaf against the chain. Kit users read your copy with `connect({ ..., epochs: { url: 'https://<your host>/epochs/' } })` or `{ dir: '<a clone>/frontend/public/epochs' }`.
- **Site:** set `base` in `frontend/vite.config.ts` to the path you serve from (`/Moon-Forge/` for a fork's GitHub Pages under that name, `/` at a domain root), then `cd frontend && npm ci --ignore-scripts && npm run build` (the build checks the program id) and upload `dist/` to any static host. The site reads `epochs/index.json` and the epoch files from its own origin, so your build serves your files. Say on it that it is an unofficial copy, and never show another program id.
- **Tell users where it is:** in your fork's README and, if the original repository still accepts them, in an issue there. Users check any copy against the chain, not against a name.

### 7. GitHub Actions in your fork (optional)

The workflows run unchanged in a fork once it is set up:

1. Enable Actions in the fork (its Actions tab: a fork starts with workflows switched off) and GitHub Pages with "GitHub Actions" as the source.
2. Secrets: `ORACLE_PRIVATE_KEY` (the hot key) and `KEEPER_PRIVATE_KEY` (the keeper key): `gh secret set ORACLE_PRIVATE_KEY < ~/keys/hot.json`. Never the cold key.
3. Variables: `ORACLE_ENABLED` and `KEEPER_ENABLED` = `true`; `ORACLE_PUBKEY` and `KEEPER_PUBKEY` = your two wallets (or the health check watches the old ones). No portal variable: the workflows read the five portals and their deploy blocks from `deployments/portals.json`, which a continuation keeps unchanged.
   Optional: the endpoint overrides of [Secrets, variables and the owner's token](#secrets-variables-and-the-owners-token). Leave `GATE_BLOCK` and `ANNOUNCE_ENABLED` unset.
4. In one reviewed commit, set `seatCold`, `seatRefund` and `keeperSeat` in `oracle/src/health-pins.json` to your keys and `SITE` in `oracle/src/health.ts` to your site, or the health check stays red on those rows.
5. The heartbeat job keeps the fork's schedules alive (row 11 of the table above).

### 8. Become the house keeper

See [Becoming the house keeper](#becoming-the-house-keeper): from 2026-12-16 00:00 UTC create the seat if it was never created, or take it after 28 idle days, with a bond of at least 20 XNT, and run `npm run keeper` with that key on an always-on machine. The site lists house games and the Jackpot only while the chain shows a live keeper, re-read from X1 every 30 seconds, so no site release is needed for them to appear.

### 9. After a take

- `npm run seat` shows your hot key; with the keeper seat key, `npm run keeper -- --once` reports the role `holder`.
- Your first epoch survives its 48-hour hold; check it yourself with `npm run verify -- <file> --full`.
- Your site and epoch-file URL are public, and the health check watches your wallets and keys.

## Add a chain

**The position.** Moon Forge launches with five chains, Base (8453), Optimism (10), Polygon (137), BNB Chain (56) and Avalanche (43114), all through the portal `0x7b00f314aB48D223bee567181CA89c65126Bf6E9`, and this project adds none. The X1 program has no list of chains: the chains are open-source oracle configuration (`oracle/src/config.ts`), so whoever holds the oracle seat could add one to this instance. A community operator that adds a chain announces it publicly at least two epochs before the first epoch that reads it, like any change of the oracle's rules (POLICY-CHANGES.md, published with the reward-rules notice, commitment 1). That notice is a commitment, not a code rule: the chain list is not in the hashed rules block of the epoch files. What anyone can check is that every epoch file lists the chains it read, and that `npm run verify` with the published settings fails on an epoch that reads a chain those settings do not know ("chain N is not a configured chain"). A separate instance with its own program, portals and pool is a fork ([FORK.md](FORK.md)).

**What a new chain changes for the others.** No budget is reserved per chain: the program's bound (at most 10% of the free pool per epoch) and the weekly capacity are shared by every chain's burns in one first-come, first-served order. Valuation stays per chain: a new chain's burns do not move another chain's price, liquidity or curve, but they use the same capacity.

**Steps**, as the code stands:

1. **Market first.** The chain's XEN needs pools quoted in an allowlisted asset (wrapped native coin, USDC, USDT, WETH), each holding at least $50 and trading within 3× of the aggregator price; without a market a burn there is valued at nothing. After step 3, `npm run market` prints it.
2. **Deploy the portal.** `npx hardhat run scripts/deploy_portal.ts --network <network>` (the XEN address comes from the script's map or `XEN_ADDRESS=0x...`; a new network needs an entry in `hardhat.config.ts`). The constructor only checks that the XEN address holds code, so confirm it is that chain's real XEN and that it supports `burn(user, amount)` with the `onTokenBurned` callback, or every burn reverts. Verify the source (`npx hardhat verify --network <network> <portal> <xen>`, and Sourcify), and add the address and its deploy block to `deployments/portals.json`. The address equals `0x7b00…` only if the original deployer's nonce 0 is still unused on that chain; anyone else gets another address.
3. **Oracle entry.** Add one object to `RAW_CHAINS` in `oracle/src/config.ts`: `chainId`, `name`, `rpcs` (keyless endpoints that serve `eth_getLogs` over week-old blocks, through `rpcList("<X>_RPC_URL", ...)`), `portal` and `startBlock` through `portalOf` / `startOf` (so `deployments/portals.json` is their default), `confirmations` (the chain's finality depth), `logChunk`, `xen` and `gecko` (the GeckoTerminal network slug).
4. **Workflows.** Add `<X>_RPC_URL: ${{ vars.<X>_RPC_URL }}` to the env lists of `.github/workflows/oracle.yml`, `keeper.yml`, `health.yml` and `announce.yml` (each lists every name by hand). The portal and its start block need nothing there: the workflows read them from `deployments/portals.json` (step 2). Do not pass `PORTAL_<X>` or `START_<X>` from repository variables: an unset variable arrives as an empty value, which skips the chain.
5. **Price rules.** Add the chain to `QUOTE_ALLOWLIST` in `oracle/src/pricing.ts` and the same list in `frontend/src/lib/market.ts`, and its quote tokens to `CHAINLINK_QUOTE_FEEDS_V3` in `oracle/src/pricing.ts`: without a feed the 3% quote check is skipped with a warning, and the on-chain price fallback cannot price that chain.
6. **What then happens by itself.** The first read starts at the start block; the price reference is the aggregator price (the build price is capped at 1.25× of it); the first liquidity is capped at $500 plus $50 per day of the price pool's age (at most $5,000); the curve's memory starts empty; the first epoch that reads the chain trips the anomaly gate ("first-chain"): it is held up to 24 hours, then a fresh rebuild is published unless `GATE_BLOCK` is set.
7. **Site, kit and texts.** `frontend/src/lib/constants.ts` (the chain entry with its portal), `frontend/src/facts.ts` and the texts generated from it, `frontend/public/llms.txt` and `llms-full.txt`, the agent cards and `links.json`; the kit's portal list and refusal message in `agents/kit/burn.mjs` and its quote vectors, then a kit release; every document that says "five chains". Then publish the notice (two epochs ahead) and, after the first epoch that reads the chain, run `npm run verify -- <file> --full`.

**Must not:**

- add a chain without a liquid XEN market on an allowlisted quote asset (its burns would score nothing, then be valued at half its last reference once orphaned);
- change a live chain's portal, start block or cursor, lower its confirmations below the chain's finality depth, or remove from `deployments/portals.json` a chain that has ever been read (the next build fails its self-check and publishes nothing);
- put two portals on one chain id, or reuse another instance's portals (their burns belong to that instance);
- present `0x7b00f314aB48D223bee567181CA89c65126Bf6E9` as a portal on any chain where it was not deployed (anyone can deploy a contract at that address on another chain), or ask anyone to "claim old burns".

**Checks built into the oracle:** blocks are read only past each chain's finality depth; events count only from the configured portal and with the configured chain id; duplicates are removed by (chain, transaction hash, log index); mission ids and the portal's counters must be contiguous and agree with the previous file, and a second provider reads the same counters (a mismatch skips the chain); a failing chain is skipped with its cursor kept, never skipping blocks; the chain set must match the previous file; market eligibility, the Chainlink quote check and the anomaly gate apply as above.

## Program tests (required before any upgrade)

`.github/workflows/program-tests.yml` runs the whole program test suite on a GitHub runner, exactly what `tests/run-local.sh` does by hand (it runs that script): cargo unit tests, IDL, the `--features localnet` build, the real Metaplex Core program dumped from X1 mainnet, a local validator, `tests/moon-forge.test.ts`, the randomized stress / solvency audit (`tests/stress.test.ts`) and, on a fresh validator, the agent kit's end-to-end test (`agents/kit/test/e2e-local.mjs`). Toolchain pinned to the versions of the README: Agave solana-cli 3.1.11, anchor-cli 0.32.1 (prebuilt release binary with a pinned sha256; built from the tag if that binary is ever gone), Node 22. No secrets, no token, nothing to renew.

It runs on every pull request that touches `programs/`, `tests/`, `agents/kit/` or the Cargo / Anchor files, once a week on the default branch (best effort, like every schedule), and by hand: Actions → Program tests → Run workflow, on any branch (`STRESS_SEED` / `STRESS_ROUNDS` reproduce a failed stress run). Each run uploads two artifacts: `program-tests-logs` (test output, validator logs) and `program-build` (`moon_forge.json` IDL, `moon_forge.so` = the mainnet binary rebuilt at the end of the script, `moon_forge_localnet.so`, and their sha256).

A second job, **guards** ("Mainnet compile guards and unit tests"), runs next to the validator suite in every run and needs no validator: the grep guards (`tests/grep-guards.sh`), the Rust unit tests with the mainnet constants, and `tests/check-mainnet-guards.sh`. That script must find the in-place mainnet build green or blocked only by the placeholder guards of the keys and the metadata address that are filled at the S2 build; a mainnet build with throwaway keys must be green; and the published test keys of `tests/fixtures` must be refused as mainnet keys. The job recognises the final program source by `programs/moon-forge/src/instructions/seat.rs`; on that source a missing guard script fails the run. Its logs are the artifact `program-guards-logs`; it uploads no binary.

A manual run can also tick **e2e_oracle**: the localnet job then fetches the full history and runs `tests/e2e-oracle-v3.sh` too (the real oracle command line on local validators across the upgrade, about 10 minutes more plus the build of the deployed binary). Pull requests and the weekly run never run it.

**Before any program upgrade ([DEPLOY.md](DEPLOY.md) step 1): run this workflow on the exact commit you intend to deploy and wait for green. A red or missing run means no upgrade.** Then compare the sha256 of `target/deploy/moon_forge.so` in the `program-build` artifact with the sha256 of the binary you are about to write to the buffer: they must match (same source, same toolchain; if they differ, find out why before deploying). The localnet binary must never be deployed.

A warm run (cargo, the Solana toolchain and the Core dump cached) takes roughly 25–45 minutes, a cold one up to about an hour; the job times out after 150 minutes. Public repositories get GitHub-hosted runners for free, so this costs nothing. The synthetic XDEX observation ring (`tests/fixtures/make-observation.cjs`) covers about 24 minutes from the validator start and the Predictions tests need it, so the unattended weekly run uses `STRESS_ROUNDS=5`; a weekly run that fails only in a Predictions test on a slow runner is that ring running out, not the program: run it again by hand (10 rounds) before reading anything into it.

**After the upgrade, before walking away: re-validate the health check against the new program.** `oracle/src/health-rules.ts` encodes what `Config.reward_reserved` must equal (`expectedReserved`: Σ over open epochs of budget − claimed, plus the unpaid drop reserve while the drop is pending or sealed) and the thresholds of the other rows. If the upgrade changes what the program reserves or how an epoch is accounted (per-chain capacity, Forge Right, a new drop reserve formula), run `cd oracle && npm run health` against the upgraded program (on localnet right after `tests/run-local.sh`, then on mainnet right after the deploy) and update `expectedReserved` and `oracle/test/health.test.ts` until "reserved accounting" is green. Otherwise the daily check stays red on that row for good, with nobody left to adjust it, and every real alert after it drowns in the noise.

## The oracle key

The oracle key is the one role that stays alive after the upgrade authority is burned, so treat it as the most important secret of the protocol.

**Today (v2 program, until the final upgrade planned for 2026-11-18):**

- **Only the current oracle key can publish epochs and hand the role over.** Nobody else can replace it through the v2 program; until the upgrade, only a program upgrade could.
- **If it is lost,** no new epoch can be published until the final upgrade; epochs that are already published can still be claimed until their 90-day windows end.
- **If it leaks,** whoever holds it can publish epochs. The program still caps each one at 10% of the free pool and at least 6 days apart, but those payouts could go to the wrong wallets. Hand the role to a fresh key at once.

**From the final upgrade:** the oracle key becomes the hot key of an oracle seat. Every epoch is held 48 hours before any claim, and anyone can void a wrong one during the hold with a bond; the seat's cold key can replace a lost or stolen hot key; and a seat with no epoch that survived its hold for 28 days is dead and can be taken by anyone with a bond, with no veto ([When something breaks](#when-something-breaks), rows 1–3; [Community takeover runbook](#community-takeover-runbook)). This section is replaced by the seat version on upgrade day.
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
