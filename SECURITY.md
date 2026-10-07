# Security & Trust Model

## Who can do what (complete)

Source of truth: the header of [`programs/moon-forge/src/lib.rs`](programs/moon-forge/src/lib.rs) and the account constraints of each instruction.

| Actor | Can | Cannot |
|---|---|---|
| Anyone | donate; submit any claim (XNT always goes to the player in the leaf); seal Forge Drop seeds (`seal_drop`) and deliver Forge Drops (`claim_drop` / `claim_drop_xnt` — the Artifact or XNT always goes to the player in the leaf); push vested XNT (`withdraw_vested`, paid to the mission owner); settle bets, Jackpot rounds and lottery draws; pay back refunded Jackpot entries (`close_jackpot_entry`); resolve duels after the reveal timeout; expire epochs (`expire_epoch`); sweep v1 accounts; reclaim orphan Artifacts (floor → reward pool); create the collection | move any vault funds to themselves. The only payments to a caller are keeper tips from the reward pool: 0.002 XNT per claim of ≥ 0.02 XNT submitted for someone else, 0.01 XNT per Forge Drop delivered for someone else |
| Player (wallet owner) | game wallet (deposit/withdraw), house games, Jackpot, Duel (create/join/reveal), Burn Lottery, Be the House, forge/recycle Artifacts, eject from own missions, set a session key | touch another player's balance or mission |
| Session key | place house-game bets (Coin Flip, High-Low, Void Rush) from its owner's game balance, within expiry and max stake | withdraw; enter Jackpot or Burn Lottery; create or join Duels; change the session (the program returns `OwnerOnly` for P2P actions) |
| Oracle key | `publish_epoch` (root, data hash, total score, mandatory `rate_cap` > 0), hand its role to a new key (two-step) | push an epoch budget above 10% of the free pool, publish more than once per 6 days, move funds |
| Architect key | `set_airdrop_root` once | anything else in the program |
| Upgrade authority | replace the program (test period only; currently the same wallet as the architect) | — see below |

## Bounded oracle

The oracle is the main off-chain trust: it reports which burns happened and at what price. The program limits the damage of a wrong or compromised oracle:

- the budget of an epoch is computed **on-chain** as `min(10% of the free pool, total_score × rate_cap)`. The oracle supplies `rate_cap` (the program refuses 0); a wrong `rate_cap` can lower the budget or raise it up to — never above — the 10% bound. Anyone can recompute the correct `rate_cap` from the epoch file;
- Forge Drops are part of that budget. Luck can make winners' floors exceed the drop reserve; the overrun comes from the free pool and is bounded (winners beyond reserve + max(reserve, 15 XNT) are refused), so one epoch can move at most 10% of the free pool plus max(reserve, 15 XNT), with the reserve itself capped at 100 XNT;
- epochs are ≥ 6 days apart → worst case ≈ 10% of the pool (plus that bounded overrun) per 6 days, visible to everyone;
- price inputs follow fixed oracle rules (allowlisted quote assets, deepest pool by liquidity, median of hourly closes, ±50% clamps against recent epochs) that make single-pool or single-hour manipulation expensive — see the whitepaper;
- each epoch's full data (block ranges, events, prices, liquidity, Artifact snapshots) is published, hashed on-chain and reproducible with `npm run verify -- epoch-N.json --full`.

## Upgrade authority

During the public test period the program upgrade authority is the architect wallet `7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd`, so that bugs found by the community can be fixed. **It is planned to be burned** at the end of the test period:

```bash
solana program set-upgrade-authority 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 --final -u https://rpc.mainnet.x1.xyz
```

Until then, treat the program as upgradeable: whoever holds that key can replace the code, including fees and vault logic. The Transparency page reads the current authority directly from the chain.

## Randomness

**House games** use two steps: the stake is locked first, then the bet is settled with the SlotHashes entry of a slot that did not exist when the stake was locked, combined with a per-bet seed and the bet address. That hash is not known to the player or the protocol when the bet is placed. Settlement is permissionless, and a bet not settled within ~3 minutes counts as **lost** even if its roll was a win, so results cannot be skipped (the site settles immediately; the keeper is a safety net). Bets must be top-level instructions (`get_stack_height` check).

**Residual risk (disclosed):** the block producer of the target slot could in theory influence or withhold that slot's hash. X1 has no VRF today. Mitigations: max net win per bet = 0.25% of the free bankroll; all unsettled payouts together ≤ 20% of the bankroll; and a **circuit breaker** — if the bankroll (net of LP deposits and withdrawals) has lost 10% since the start of the UTC day, new house bets are refused until the next UTC day.

**Duels** use commit-reveal: the creator commits to a hidden element, the opponent joins with theirs, and the creator must reveal within 1 hour or the opponent wins.

**Draws** (Jackpot, Burn Lottery) and **Forge Drop seeds** use a future block hash. If nobody settles within the window they are never re-drawn: the Jackpot round is refunded entry by entry, the lottery round has no winner and its would-be prize goes to the burners' reward pool, and unsealed Forge Drops are cancelled with the reserve returned to the pool. Waiting never helps anyone. The keeper settles draws first in each pass.

## Solvency invariants (checked in tests)

- `reward_vault ≥ rent + Σ open epoch budgets not yet claimed`
- `bankroll_vault ≥ rent + Σ payouts of pending bets`
- P2P pots are held in the round/duel accounts themselves.
- Every Artifact record holds its own floor.

These are checked by the randomized stress test; that is testing, not a proof, and no third-party audit has been done.

## Reporting a vulnerability

Open a private security advisory on GitHub (Security → Report a vulnerability) or an issue titled `SECURITY` without exploit details. Please allow time for a fix before disclosure. There is no paid bug bounty; reporters will be credited.
