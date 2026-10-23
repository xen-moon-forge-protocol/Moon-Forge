# Security & Trust Model

*Status as of 2026-10-22: the program and the oracle running today are v2 (binary from tag `program-2026-10-12`, commit be03ad8). The v3 oracle rules and the final program upgrade are decided but not live; every "planned" item below is dated. The internal review record is [docs/REVIEW-2026-10.md](docs/REVIEW-2026-10.md) (not an audit; its method and scope are stated at the top of that file).*

## Who can do what (complete, v2 live today)

Source of truth: the header of [`programs/moon-forge/src/lib.rs`](programs/moon-forge/src/lib.rs) and the account constraints of each instruction.

| Actor | Can | Cannot |
|---|---|---|
| Anyone | donate; submit any claim (XNT always goes to the player in the leaf); seal Forge Drop seeds (`seal_drop`) and deliver Forge Drops (`claim_drop` / `claim_drop_xnt` — the Artifact or XNT always goes to the player in the leaf); push vested XNT (`withdraw_vested`, paid to the mission owner); settle bets, Jackpot rounds and lottery draws; pay back refunded Jackpot entries (`close_jackpot_entry`); resolve duels after the reveal timeout; expire epochs (`expire_epoch`); sweep v1 accounts; reclaim orphan Artifacts (floor → reward pool); create the collection | move any vault funds to themselves. The only payments to a caller are keeper tips from the reward pool: 0.002 XNT per claim of ≥ 0.02 XNT submitted for someone else, 0.01 XNT per Forge Drop delivered for someone else |
| Player (wallet owner) | game wallet (deposit/withdraw), house games, Jackpot, Duel (create/join/reveal), Burn Lottery, Be the House, forge/recycle Artifacts, eject from own missions, set a session key | touch another player's balance or mission |
| Session key | place house-game bets (Coin Flip, High-Low, Void Rush) from its owner's game balance, within expiry and max stake | withdraw; enter Jackpot or Burn Lottery; create or join Duels; change the session (the program returns `OwnerOnly` for Jackpot and Burn Lottery entries and `Unauthorized` for Duels, Moon Wars and Predictions) |
| Oracle key | `publish_epoch` (root, data hash, total score, mandatory `rate_cap` > 0), hand its role to a new key (two-step) | push an epoch budget above 10% of the free pool, publish more than once per 6 days, move funds |
| Architect key | `set_airdrop_root` once (done on 2026-10-12) | anything else in the program |
| Upgrade authority | replace the program (test period only; currently the same wallet as the architect) | — see below |

*Dated note (2026-10-22): the Forge Drop, Artifact-boost, chips and Duel-ticket rows above are true of the live v2 program and oracle. Boosts stop entering the scoring from the v3 switch epoch (planned for November 2026), and Forge Drops, chips and the Artifact ticket end at the final program upgrade (earliest 2026-11-11). Details and dates: the [interim notice in the README](README.md#interim-notice-2026-10-22).*

The plain statement of what is immutable, what the oracle can still do, what the community can run and what depends on GitHub — today and after the freeze — is kept in one place: [IMMUTABILITY.md, "Who can do what: status today and after the freeze"](IMMUTABILITY.md#who-can-do-what-status-today-and-after-the-freeze).

## Bounded oracle

The oracle is the main off-chain trust: it reports which burns happened and at what price. The program limits the damage of a wrong or compromised oracle:

- the budget of an epoch is computed **on-chain** as `min(10% of the free pool, total_score × rate_cap)`. The oracle supplies `rate_cap` (the program refuses 0); a wrong `rate_cap` can lower the budget or raise it up to — never above — the 10% bound. Anyone can recompute the correct `rate_cap` from the epoch file;
- Forge Drops are part of that budget. Luck can make winners' floors exceed the drop reserve; the overrun comes from the free pool and is bounded (winners beyond reserve + max(reserve, 15 XNT) are refused), so one epoch can move at most 10% of the free pool plus max(reserve, 15 XNT), with the reserve itself capped at 100 XNT. Keeper tips (0.002 XNT per claim submitted for someone else, 0.01 XNT per drop delivered) are paid by the pool outside that budget;
- epochs are ≥ 6 days apart → worst case ≈ 10% of the pool (plus that bounded overrun) per 6 days, visible to everyone;
- price inputs follow fixed oracle rules (allowlisted quote assets, deepest pool by liquidity, median of hourly closes or the clamped spot when candles are missing, ±50% clamps against recent epochs) that make single-pool or single-hour manipulation expensive — see the whitepaper;
- each epoch's full data (block ranges, events, prices, liquidity, Artifact snapshots) is published, hashed on-chain and reproducible with `npm run verify -- epoch-N.json --full` (`--full` re-reads the burn logs from the chains; prices, liquidity and the snapshot are recomputed from the inputs recorded in the file).

A dishonest oracle could still direct up to one epoch's budget to false burns; the verifier would show it, and the published file is the evidence.

## Upgrade authority

During the public test period the program upgrade authority is the architect wallet `7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd`, so that bugs found by the community can be fixed. **It will be burned** on the published conditions — the final upgrade deployed with its announced hash, the mainnet proof plan complete, 14 consecutive daily health runs with no FAIL, the Artifact metadata on Arweave — earliest **2026-11-25** and **no later than 2026-12-31** (on that date the authority is burned on the then-current binary, with the games delisted, or a later fixed date is published with the same rule). Conditions in full: [IMMUTABILITY.md](IMMUTABILITY.md#when-the-upgrade-authority-will-be-burned). The freeze is two transactions in one session:

```bash
anchor idl erase-authority --program-id 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 --provider.cluster https://rpc.mainnet.x1.xyz
solana program set-upgrade-authority 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 --final -u https://rpc.mainnet.x1.xyz
```

Until then, treat the program as upgradeable: whoever holds that key can replace the code, including fees and vault logic. The Transparency page reads the current authority directly from the chain.

**Custody.** The upgrade key is held by the anonymous operator: it is never stored in GitHub secrets or on any machine the automation uses, it is used only to sign the announced final upgrade and the freeze, and from the final upgrade to the freeze it is kept offline. If it were lost before the freeze, nobody could upgrade or burn the authority: the program would stay as deployed, with an authority nobody holds. The oracle and keeper keys are separate hot keys kept as repository secrets; they can be rotated (two-step `propose-oracle` / `accept-oracle` for the oracle; the keeper is permissionless).

## What depends on GitHub

The site (GitHub Pages), the scheduled oracle, keeper and health runs (GitHub Actions) and the epoch-file feed (git + Pages) all live in this repository's GitHub account. **If that account falls**, the site, the scheduled runs and the feed stop; new epochs pause until the oracle operator runs the same code elsewhere; already-published epochs stay claimable by anyone who holds the epoch file (any clone of the repository) and an RPC; **the pool stays locked in the program** — nobody can take it, and it pays nothing until an epoch is published. This dependence is disclosed, not removed. As of 2026-10-22 there is no mirror; an Arweave copy of every epoch file is planned before the v3 switch.

## Randomness

**House games** use two steps: the stake is locked first, then the bet is settled with the SlotHashes entry of a slot that did not exist when the stake was locked, combined with a per-bet seed and the bet address. That hash is not known to the player or the protocol when the bet is placed. Settlement is permissionless, and a bet not settled within ~3 minutes counts as **lost** even if its roll was a win, so results cannot be skipped (the site settles immediately; the keeper is a safety net). Bets must be top-level instructions (`get_stack_height` check).

**Residual risk (disclosed):** the block producer of the target slot can influence or withhold that slot's hash. X1 has no VRF today. Mitigations: max net win per bet = 0.25% of the free bankroll; all unsettled payouts together ≤ 20% of the bankroll; and a **circuit breaker** — if the bankroll (net of LP deposits and withdrawals) has lost 10% since the start of the UTC day, new house bets are refused until the next UTC day.

**Duels** use commit-reveal: the creator commits to a hidden element, the opponent joins with theirs, and the creator must reveal within 1 hour or the opponent wins.

**Draws** (Jackpot, Burn Lottery) and **Forge Drop seeds** use a future block hash. If nobody settles within the window they are never re-drawn: the Jackpot round is refunded entry by entry, the lottery round has no winner and its would-be prize goes to the burners' reward pool, and unsealed Forge Drops are cancelled with the reserve returned to the pool. Waiting never helps a player; the producer of the target slot can still influence or withhold it (GAM-1 below). The keeper settles draws first in each pass.

## Open findings (until the final upgrade)

Known, unfixed on the live v2 binary, disclosed here and, from the site deploy of 2026-10-23, on the site's game panels; each one is fixed or removed by the final upgrade (earliest 2026-11-11). Ids are those of [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md), the public register where every id resolves; `REV-2026-10-…` ids also refer to [docs/REVIEW-2026-10.md](docs/REVIEW-2026-10.md).

| Id | What | Status today |
|---|---|---|
| REV-2026-10-H3 / GAM-1 | A block producer can influence or withhold the hash that settles a house bet, a draw or a Forge Drop seed (no VRF on X1) | Bounded (caps and circuit breaker above); the final upgrade moves draws to a keeper hash-chain |
| GAM-5 | Moon Wars (real XNT): the move key generated in the browser is funded for only two moves, after which the player loses the match by timeout | The site no longer starts new real-XNT matches (since 2026-10-19); free practice stays. Fixed at the final upgrade |
| GAM-3 | Predictions: the on-chain TWAP rule can be satisfied by a single read, and the product is not offered by this project since 2026-10-22 | The site tab is removed with the site deploy of 2026-10-23 (claim and refund of existing entries stay reachable); the kit example is removed in the same release; on-chain rule rewritten at the final upgrade |
| V2-DROP | Forge Drop size vs. the pool: with today's small free pool, one 5 XNT drop win would take most of it (≈ 1% chance per epoch at the epoch-1 size), delaying later epochs' budgets | Accepted and disclosed until the final upgrade ends drops; no code push before the final upgrade |

Known issues of the oracle and the automation (single RPC per chain, GitHub cron cadence, GitHub dependence, hot oracle key, one failed chain read aborting the whole epoch build) are OPS-1 to OPS-5 in [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md#operations-and-dependencies); operating detail in [OPERATORS.md](OPERATORS.md).

## Solvency invariants (checked in tests)

- `reward_vault ≥ rent + Σ open epoch budgets not yet claimed`
- `bankroll_vault ≥ rent + Σ payouts of pending bets`
- P2P pots are held in the round/duel accounts themselves.
- Every Artifact record holds its own floor.

These are checked by the randomized stress test; that is testing, not a proof, and no third-party audit has been done.

## Reporting a vulnerability

Send vulnerability reports to the project mailbox, xen-moon-forge-protocol@tutamail.com (also named in [security.txt](https://xen-moon-forge-protocol.github.io/Moon-Forge/.well-known/security.txt)). GitHub's private vulnerability reporting is not enabled on this repository. For anything that is not sensitive, an issue titled `SECURITY` without exploit details also works. Please allow time for a fix before disclosure. There is no paid bug bounty today; reporters will be credited. Whether a small bounty from the architect vault funds an independent review of the final upgrade is an owner decision due by 2026-11-04 (see the review record).
