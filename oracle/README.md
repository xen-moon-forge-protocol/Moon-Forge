# Moon Forge oracle v2

Reads final `MissionStarted` burns from the EVM portals, values them at market price with a liquidity discount, builds one Merkle tree per epoch, publishes the root and the epoch `rate_cap` on X1 (the program applies `budget = min(10% of the free pool, total_score × rate_cap)` itself), auto-claims for burners and runs the permissionless keeper. Every epoch file can be re-verified by anyone, including the `rate_cap`.

```bash
npm install
npm test                                   # unit tests (no network)
npm run verify -- ../frontend/public/epochs/epoch-1.json --full   # anyone
npm run epoch -- --dry                     # build without publishing
npm run epoch                              # oracle key only
npm run keeper                             # any funded key
npm run keeper-arm -- --deposit 20         # upgraded program only: the first arm of the house-keeper seat (S7 owner step; dry without --yes)
npm run keeper-take -- --deposit 20        # upgraded program only: take the seat (named successor after the notice, or a dead seat) on a chain this key derives (owner step; dry without --yes)
npm run publish-extra -- [<n>]             # upgraded program only: publish extra-<n>.json once it is pushed (oracle key)
npm run rebuild-extra -- <n>               # rebuild a lost extra-<n>.json byte for byte (read-only)
npm run init                               # one-time v2 setup after the program upgrade
npm run health                             # read-only daily health check (no key)
npm run health-verify                      # read-only: verify --full of the newest epoch file → verification.json
npm run feed -- --out <file>               # rewards v3 only: the hourly week-so-far feed (read-only, no key; nothing before the switch)
npm run seat                               # upgraded program only, read-only: the oracle seat, its liveness, every epoch in its 48-h hold vs this repository
npm run void-epoch -- <n> [--extra]        # upgraded program only: dry run (decide, build, simulate) of void_epoch / void_extra_epoch; --yes sends it (VOIDER_PRIVATE_KEY)
npm run take-seat -- --hot <pk> --cold <pk> --refund <pk>   # upgraded program only: dry run of take_seat; --yes sends it (TAKER_PRIVATE_KEY)
```

**X1 endpoints.** Every X1 connection (oracle, keeper, heartbeat, health) goes through `src/x1-rpc.ts`. With
`X1_RPC_URLS` unset it is `new Connection(X1_RPC_URL or https://rpc.mainnet.x1.xyz)`, exactly as before. With
`X1_RPC_URLS=url1,url2` (a repository variable in the workflows) the listed endpoints are tried first and the default
one last: a transport error, a 30-s timeout, HTTP 429 or 5xx moves a request to the next endpoint; a listed endpoint is
used only after its genesis hash matched X1 mainnet's; the websocket (transaction confirmations) stays on the default
endpoint. Only the host of an endpoint is ever printed by this code, but GitHub prints the env of every step in the
run logs, which are public here: put only KEYLESS endpoints in the X1_RPC_URLS variable (a keyed one belongs in the
X1_RPC_URL secret); the health row warns about an entry with a path or a query (R-8). A listed endpoint serves
availability, never trust: the reads that release a keeper preimage or decide the upgrade verdict always go to the
default endpoint (`trustedConnectionFor`, R-5).

**Health check.** `npm run health` prints one row per check and exits 1 when one is red. The rows IMMUTABILITY.md
requires before the 14-day stable count (vault invariants, reconciliation of every epoch, oracle cadence and seat,
keeper service levels and bond, site current, verification green, privileged keys against `src/health-pins.json`, the
K-5 chain history, the extra pot, the stable-days streak) answer "n/a until upgrade" while the live v2 binary is
detected and switch on by themselves after it. `src/health-pins.json` holds the expected privileged keys: change a pin
only in a reviewed commit, in the same session as the change it expects (the upgrade authority at the final upgrade and
at the freeze, the seat keys once the seats exist).

`npm run keeper` picks its pass by itself: the v2 pass (`x1.ts keeperPass`, unchanged) while the live binary runs, the
v3 pass (`keeper-v3.ts`) once the upgraded program is detected on chain (last-deploy slot after 85,429,880 and the
ExtraState / OracleSeat accounts only the upgraded program creates). With the key that holds the house-keeper seat it
also reveals the seat's hash chain in order; every other key anchors bets, refunds stalled ones and runs every other
permissionless upkeep. The chain is derived from the key (domain-separated HMAC, chain id read back from the seat), so a
restarted runner continues it and no preimage is ever stored; the security argument is in the header of `keeper-v3.ts`.
The loop never posts a bond and never takes a seat (keeper-arm / keeper-take are the owner's commands; both check
after landing that the seat holds a chain this key derives, and every pass of a holder that cannot derive its chain
raises an ALERT, R-4). A v3 Jackpot round drawn by anyone is settled at once: the holder checks the round after every
step and every 10 sends of a pass and every 5 s between passes, and walks up to it on its own budget, up to four
positions (anchor + settle) per transaction (R-1).

**Rewards version (R-3).** `npm run epoch` builds under the v3 rules only on the upgraded program: it reads the W2-4
verdict once (default endpoint, finalized). On the live v2 binary it builds v2 exactly as on main, with a warning when
`V3_FIRST_EPOCH` (or the environment) already asks for v3 (S6 late). On the upgraded binary it builds v3, by detection when
nothing is pinned; a v2 epoch on the upgraded binary is refused (re-pin `V3_FIRST_EPOCH` to that epoch); an unknown
verdict never builds v3. The feed and the health row use the same rule.

**Extra pot (upgraded program only).** The weekly run builds `extra-<n>.json` right after base epoch n. Before the
upgrade it is a budget-0 heartbeat, exactly as before. Once the upgraded program is detected, the run reads the chain's
first extra epoch, X (the free extra pot at init_extra, then each `ExtraEpochPublished.free_after`) and the init_extra
transaction; nothing of this is set by hand. `npm run publish-extra` sends `publish_extra_epoch` only when the file
verifies, the same file is already in the pushed history (A10.11: durable first; `EXTRA_DURABLE_REF`, default
`origin/<branch>`) and the chain agrees on X and the order. The keeper claims every extra leaf after the 48-h hold.

- **OD-9 (default):** an Artifact forged before the upgrade (before the init_extra transaction's block time) never enters
  the extra pot; it is listed as excluded with the reason `pre-upgrade`. One constant reverts it:
  `EXTRA_EXCLUDE_PRE_UPGRADE` in `src/extra.ts` (decide before the first extra epoch: the value is recorded in every file).
- **D-47 (order):** the automatic claims paid by the oracle key stop while its wallet would keep less than
  `ORACLE_PUBLISH_RESERVE` (0.05 XNT, `src/x1-v3.ts`) after one more claim; publication keeps that reserve. A key that
  is not the oracle is never held back. Burners can always claim their own leaf.
- **D-47 (allowance, upgraded program only):** `publish_epoch` refunds the new Epoch account's rent and tops the oracle
  wallet up toward 0.25 XNT by at most 0.05 XNT per epoch, from what the epoch's budget leaves of the 10% bound and
  never more than 1% of the free pool (a running cost of the pool, booked in `stats.keeper_tips`; nothing while the
  oracle key is the architect payee). `publishEpochV3` sends the reward vault writable to receive it. The build keeps
  that room: `buildLimit` subtracts `oracleAllowanceMax` and `rebuildReason` adds it, so Σ score + keeper tips + the
  allowance fit in 10% of the free pool.

**Quiet weeks and the oracle seat (round 4, upgraded program only).** The seat dies 28 days after its newest epoch that
survived its 48-h hold, so a month without burns used to hand it to whoever bonds first. The upgraded program accepts a
HEARTBEAT base epoch (forge.rs `epoch_shape`: total score 0, no leaves, rate cap 0, the all-zero root; budget 0, nothing
reserved, no claim), and the weekly run publishes one when the window valued no burn at all (every chain read had none,
or was skipped with its cursor kept): `epoch-<n>.json` is an ordinary v3 file (cursors, curves, L, snapshot and capacity
carried forward as a paying build records them) with `burns`, `targets` and `leaves` empty, `totalScore` "0", `rateCap`
"0", `root` 64 zeros and `heartbeat: true`; the extra epoch of the same id is built after it as usual (budget 0: no burn
to count). A window with a valued burn that pays nothing (an empty pool) is never a heartbeat: that burn waits, as
before. The heartbeat is tried only when the paying build is empty and the live verdict (read again) is "upgraded"; the
live v2 binary would refuse it (EmptyEpoch) and never sees it. `verify` accepts a heartbeat only if it recomputes as one.
A heartbeat that someone voids does not count, so a stolen hot key cannot keep a seat alive with heartbeats.

**The oracle seat's client (round 4).** `npm run seat` (read-only) prints the seat, when it can be taken, and every base
and extra epoch still inside its 48-h hold against this repository's files. `npm run void-epoch -- <n> [--extra]` and
`npm run take-seat -- --hot <pk> --cold <pk> --refund <pk>` are DRY by default: they read, decide (the seat.rs rules:
the void bond max(0.05 XNT, 10% of the full budget), free for the cold key, which also waives the 6-day interval once; a
take only of a dead seat, the largest voider from day 28 and anyone from day 29, or of an open one), build the exact
transaction and simulate it as the signing key, or as `--as <pubkey>` (no secret on the machine); `--yes` sends it. A
void of an epoch the repository holds with the same data hash is refused unless `--even-if-ours`. The keys are their
own (`VOIDER_PRIVATE_KEY`, `TAKER_PRIVATE_KEY`), never `ORACLE_PRIVATE_KEY`, and nothing here runs in a workflow. The
health row "oracle publications" turns red for an epoch in its hold that the repository does not hold (a foreign
publisher: a stolen hot key or a taken seat), with the deadline and the void command; amber for one published in the
last 2 h whose file is not committed yet.

**Keeper and the bond-paid stalls (round 4, review F1; final split of r4-fix).** On the upgraded program every house
stall costs the keeper bond, never the bankroll: an anchored bet the keeper does not reveal in time is paid as a win
from the bond (the bankroll keeps the stake), and an unanchored bet whose block leaves SlotHashes (512 slots, about
3 min) is refunded in full (the bankroll returns the stake minus the 1.5% placement edge, the bond pays that edge and
forfeits the rest to nobody), so it costs the bond the whole stake. The keeper therefore treats an anchor like a Jackpot settle: besides each pass's
anchors, the in-pass urgent check and the loop's 5-s check (`houseDueV3`) run the house duty at once for a keeper bet
waiting for its anchor (never for a holder that cannot derive its chain: a bet it anchored and never revealed would cost
the bond the payout). The holder's `settle_bet_v2` carries the reward vault and the keeper wallet (`seat.keeper`), which
receives the G-2 settle tip (`BetSettled.keeper_tip`).

**Week-so-far feed (rewards v3 only).** `npm run feed -- --out <file>` writes the state of the epoch being built, the
file the site and the agent kit quote a v3 burn from (FEED CONTRACT v1 in `agents/kit/burn.mjs`): the capacity C and
Σ senior so far, the XNT build price and floor, and per chain the burns read so far (exactly the records the epoch file
will hold), the market, this hour's liquidity reading, the curve state and the current hour's closed-candle readings,
plus `rules: 3` and the engine's sha256. Every derived number comes from `windowStateV3` in `src/rewards.ts`, the function
the weekly build itself runs (`test/feed.test.ts`: the feed equals the kit's `supersetFeed()` on its recorded window, and
the epoch build's numbers on the same inputs). It writes nothing while the next epoch is built under the v2 rules or the
live program is not the upgraded binary. The keeper workflow writes it once an hour and deploys it with the site, at
`<site>/feed/week-so-far.json`; it is never committed. Liquidity: the build reads each chain's L once, at the build; the
feed gives this hour's reading and the previous epoch's L, so a quote uses the L the engine would use if the window
closed now. The feed also carries `rulesBlock` (the rules the epoch is built under) and its Σ senior counts only the
window's own burns, the ones a new burn of the window claims after.

**Rules block (rewards v3, round 4).** Every v3 file records one hashed `rulesBlock`: `programRules` 3, `programHash`
(the pinned S2 binary, `UPGRADED_ELF`; null while nothing is pinned), `rulesId`, `tipMin` (the program's 0.2 XNT
keeper-tip minimum, final), `autoClaimMin` "0" (every leaf is claimed for its burner), `dustRule.vestMinEnt` (0.02 XNT),
`tieBreak`, `backlogRule` and `operatorWallets`. `src/rules-v3.ts` holds the versions in force (append-only, a new
`rulesId` for every change); the build takes the block from there, and the self-check, `verify` and `publishEpochV3`
refuse a file whose block is not the one in force for its epoch on the pinned binary. The engine reads from it:
- **D-14 tie-break:** burns stamped the same second are ordered by keccak256(32-byte tx hash ‖ 32-byte big-endian log
  index), whatever their chains (`tieKeyV3`).
- **D-12 backlog:** the burns of a chain the previous file skipped (or did not list) stamped before the window start are
  `backlog: true`: they claim after every burn of the window, on the window's end day, and come first in the leftover.
- **D-18 operator wallets:** a listed wallet's burns are `operator: true` and claim after every other claim of the week,
  top-ups included. A dated, named exception (PROOF_BURN_RULE option c: `{name, wallets, fromTs, untilTs, published}`)
  makes a burn inside its range an ordinary one, recorded with `exception: name`. No wallet is listed today.
- **X-010 counters:** each chain read records `missionsAt` / `burnedAt` (`portal.totalMissions()` / `totalBurned()` at
  toBlock); they must match the burns and continue the previous record, and a second provider must read the same values
  (a mismatch skips the chain; none answering is a warning). `verify --full` reads them again, also from a second provider.
- **T1-34:** a failed `totalSupply` read is recorded as null with `totalSupplyError`, never as "0".
- **CF-22:** `publishEpochV3` reads X1's clock right before sending and refuses a build more than 6 h old (or an
  unreadable clock); the run's gate rebuilds it instead.

**Price, liquidity and gate rules (rewards v3, round 4 part B).** Their parameters are the rules block's `priceRules`
(pinned: a change is a new `rulesId`):
- **D-13 liquidity L, frozen for the window (the feed's option a).** A window is valued at the L its previous file
  froze at its build (`L.next`), so it is known from the window's first hour and the site's quote is exact. Each build
  freezes the next window's: `stat` = the minimum over the last 7 days (counted back from the window end) of each day's
  median hourly reading, a reading being min(GeckoTerminal, the pools' XEN balances read on-chain × the spot); the hourly
  readings come from the week-so-far feed (`liquiditySamples`, recorded in the file) plus the build's own; then
  `next` = max(50% × L, min(stat, 1.1 × L + $50)). The switch window takes the v2 file's reading; a chain with no L in
  the previous file takes min(stat, $500 + $50 per day of its price pool's age, at most 90 days).
- **D-22 (a) tranche cap.** C = min(8% of F_ref, 7 × 2% of the XDEX pool's WXNT reserve read at epoch n−1's build).
  Every v3 file records `xdex.atBuild` (the pool's vaults less the fees owed, `src/xdex-v3.ts`) and `xdex.capReserve`.
- **D-22 (b) XNT price pool.** Every build records the TVL of each candidate XNT/USDC.X pool (`xdex-v3.ts`
  `XNT_POOL_CANDIDATES_V3`, one pool today) in `xntPool`; a candidate whose median TVL over the last 4 builds is more than
  2× the active pool's for 2 builds in a row is announced (`xntPool.next`) and its candles are read from the next epoch on.
  The 15-minute TWAP stays on the program's Predictions pool. A switch trips the anomaly gate.
- **D-22 (c) USDC.X guard.** x1report's USD price over the XDEX TWAP in USDC.X reads USDC.X in USD: above $1.03 every pool
  reading (candles and TWAP) is raised by that factor (pool-safe), below $0.97 it is flagged (`xnt.peg`).
- **D-21 orphaned chain.** A chain skipped 4 epochs in a row for lack of an eligible market (`noMarket`; a read failure
  does not count) is announced orphaned one epoch ahead (`orphan.from`); its burns are then valued at half the reference
  it had when the run began, with its frozen L (which halves each week). A market again ends it.
- **A5-c quote USD.** At the build, GeckoTerminal's USD price of the price pool's quote token must agree with Chainlink's
  (`CHAINLINK_QUOTE_FEEDS_V3`, checked read-only 2026-10-25) within 3%, or the chain is skipped this epoch.
- **D-23 (phase 1) price sidecar.** Every build writes `epoch-<n>.prices.json` next to the file (the closes and raw
  candles each burn was priced from with their URL, each chain's on-chain depth and route, the XDEX reading, the A5-c
  checks), hashed into the file (`sidecar`); `verify` re-derives every burn's readings from it offline.
- **D-17 anomaly gate.** Before a publication: one wallet above 60% of C, more than 5× the median leaf count of the last 4
  files, a total score above 3× the median of the last 4 v3 files, more than 50% of the burns at a clamp or a fallback,
  a chain's first epoch, a change of the XNT source or a USDC.X depeg. A hit writes the public hold record
  `gate/epoch-<n>.json` and publishes nothing; the first run 24 h later publishes a fresh rebuild, unless the repository
  variable `GATE_BLOCK` is "true". `due` says "not due" while it holds; the feed says `flags.anomalyHold`.
- **Feed.** Each chain carries its `liquiditySamples`, `liquidityOnChainMicro`, `poolCreatedAt` and `route` (the price
  pool's reserves, the bridge fee and minimum); the feed carries `xdex` and `flags`; an orphaned chain is "sunset".

**Readers (round 4).** The v3 EVM reader fails over per chunk keeping what it read (a rate limit is a failover, a range
refusal halves the chunk); GeckoTerminal's Retry-After is honoured; the BSC list tries the keyless endpoints before the
shared NodeReal key; Ethereum, PulseChain and Moonbeam are no longer configured (D-53). The keeper simulates every
transaction and sends it with that compute-unit measurement × 1.2 (KEEPER-INCOME.md), about 8× cheaper than the default.

Golden vectors for all of it: `test/fixtures/rules-v3-vectors.json` (`npx ts-node test/fixtures/make-rules-vectors.ts`),
asserted byte for byte by `test/rules-v3.test.ts` and `test/price-rules.test.ts`.

| File | Role |
|---|---|
| `src/config.ts` | chains, portals, finality depths, payout policy (K = 1.25) |
| `src/evm.ts` | final-block log reader (abort instead of skip, dedup) |
| `src/pricing.ts` | XEN prices per chain (GeckoTerminal): only pools quoted in an allowlisted liquid asset (wrapped native, USDC/USDT/DAI, WETH); price pool = deepest eligible pool by XEN-side liquidity; burn price = median of its hourly closes over the 24 h ending at the burn hour; clamped to ±50% of the chain's 4-epoch median reference. XNT price (x1report / XDEX), clamped to ±50% of the previous epoch's |
| `src/epoch.ts` | pure scoring, tree, canonical data hash, verification |
| `src/merkle.ts` | sorted-pair keccak tree, identical to the program's verifier |
| `src/x1.ts` | Anchor client, Artifact snapshot, publish, claims, keeper |
| `src/extra.ts` | the extra epoch (two-pot model): pure build, skip heartbeat, verification, OD-9 pre-upgrade rule |
| `src/x1-v3.ts` | the upgraded program's client: snapshot reader (per asset, two RPCs), publish / claim builders, ExtraEpochPublished and init_extra readers, detection, D-47 claim guard |
| `src/keeper-v3.ts` | the keeper of the upgraded program: house-keeper seat and hash chain, house bets, Jackpot, stall refunds, exits, claims after the 48-h hold, oracle-seat liveness |
| `src/feed-v3.ts` | the week-so-far feed v1: raw part, derived fields by the engine, the writer's assembly, the dormant gate |
| `src/rules-v3.ts` | the v3 rules blocks in force by version (T2-RULES), the in-force check, the portal-counter presence check |
| `src/seat-v3.ts` | the oracle seat's client: read-only status, void_epoch / void_extra_epoch and take_seat (dry by default, simulated), the seat.rs mirrors |
| `src/xdex-v3.ts` | the XDEX WXNT/USDC.X pool reader (D-22 a, the feed's `xdex`) |
| `src/x1-rpc.ts` | the X1 connection: optional `X1_RPC_URLS` before the default endpoint, failover, genesis check |
| `src/health.ts`, `src/health-rules.ts` | the daily health check: live reads, and the pure rules with their thresholds (tested) |
| `src/health-verify.ts`, `src/health-pins.json` | the verification the health check reads, and the pinned privileged keys |
| `src/index.ts` | CLI |

Operations guide: [../OPERATORS.md](../OPERATORS.md).
