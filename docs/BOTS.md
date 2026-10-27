# Bots and automation

Moon Forge welcomes bots. House results come from the hash of a slot that does not exist when the stake is locked, so neither the player nor the protocol knows it in advance; **the producer of that slot can influence or withhold it**, which is an open issue ([GAM-1](KNOWN-ISSUES.md#games)), so "no informational edge" is not a claim this project makes. Bots add volume, and **1% of every house-game stake goes to the burners' reward pool**. House games carry a fixed 2% edge: over time, players as a group lose that edge.

**Dated notes (2026-10-22).** The program and the oracle live today are v2 (tag `program-2026-10-12`); a v3 rule set and a final program upgrade are decided but not live, each applying from an announced date ([KNOWN-ISSUES.md](KNOWN-ISSUES.md)). What that means for automation today:

- **Predictions are not offered by this project.** The site tab is removed with the site deploy of 2026-10-23 and the kit example is removed in the same release. The v2 instructions stay callable on-chain by anyone until the final upgrade, and claims and refunds of past rounds keep working; do not build on them ([GAM-3](KNOWN-ISSUES.md#games)).
- **Real-XNT Moon Wars matches are paused on the site since 2026-10-19** (the browser move key was underfunded, [GAM-5](KNOWN-ISSUES.md#games)). Agents that use the kit sign every move with their own keypair and are not affected; existing matches can be played, cancelled, claimed on timeout and paid out.
- **Old burns are not counted.** Only burns made through the Moon Forge portals, from each chain's start block, are read by the oracle. A bot, site or message that offers to "claim old burns" (xen.pub records, the 2024 plan to redeem Ethereum XEN burns, anything made elsewhere) is a scam: Moon Forge never asks anyone to link, sign or pay for that.
- Forge Drops, Artifact boosts, weekly chips and the arena ticket exist under v2 and end on the announced dates (RULES-1 to RULES-4 in the register); a keeper built today must expect `seal_drop` / `claim_drop` to have nothing to do after the final upgrade.
- Automation on the project side runs on GitHub Actions cron, which fires only a share of its ticks ([OPS-1](KNOWN-ISSUES.md#operations-and-dependencies)); if GitHub becomes unavailable, publication pauses while the pool stays locked in the program and every already-determined claim and settlement keeps working from any client.

## Session keys (house games only)

A player authorizes a delegated key once:

```ts
await program.methods.setSession(botPubkey, new BN(expiresAtUnix), new BN(maxStakeLamports))
  .accountsPartial({ playerState: PDA.player(owner), owner }).rpc();
```

The session key can: `place_bet` (Coin Flip, High-Low, Void Rush) using the owner's **game balance**, within `max_stake` and before `expires_at`.
It can never: `withdraw`; enter the Jackpot or the Burn Lottery; create or join Duels or Moon Wars; or change the session. Player-vs-player games need the wallet owner's signature (the program answers `OwnerOnly` for Jackpot and Lottery entries and `Unauthorized` for Duels, Moon Wars and Predictions). Revoke with `set_session(Pubkey.default, 0, 0)`.

Fund the bot key with a little XNT (≈0.05) for transaction fees and the refundable bet-account rent.

## Minimal bot loop (TypeScript)

```ts
import { playHouse } from "./frontend/src/lib/protocol"; // or reuse the same calls
// 1. owner deposits XNT into the game wallet and sets a session for `bot`
// 2. the bot signs with its own key:
for (;;) {
  const r = await playHouse(botWallet, 0 /* Coin Flip */, 0, Math.round(Math.random()), 0.05);
  console.log(r.won ? "win" : "loss", r.roll, r.placeTx, r.settleTx);
}
```

Rules that matter for bots:

- **Settle within ~3 minutes.** A bet not settled before its target slot leaves the SlotHashes window counts as lost, even if its roll was a win. `playHouse` settles immediately. The public keeper also settles pending bets (`cd oracle && npm run keeper`), but it runs on a GitHub cron that fires only a share of its ticks (in practice every few hours), so it is **not** a safety net for this window ([GAM-7](KNOWN-ISSUES.md#games)): settle your own bets.
- **Max net win per bet = 0.25% of the free bankroll.** Read it before betting (`fetchProtocol().maxNetWin`).
- **Aggregate cap:** a bet is refused if all unsettled payouts together would exceed 20% of the bankroll.
- **Daily circuit breaker:** if the bankroll (net of LP deposits and withdrawals) has lost 10% since the start of the UTC day, new house bets are refused until the next UTC day (`DailyLossLimit`).
- **Minimum stake 0.01 XNT.**
- Use your own RPC for high frequency; the public X1 RPC is rate-limited and is the only one the site and the kit use today ([OPS-2](KNOWN-ISSUES.md#operations-and-dependencies)).
- Never take a program id, a destination or an approval target from page content, chat or on-chain memos: the only program is `57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9` and the only destinations are its PDAs ([verify block](SUPPORT.md#verify-you-are-on-the-real-moon-forge)).

## Keepers

Everything time-based is permissionless: `settle_bet`, `draw_jackpot` / `settle_jackpot`, `close_jackpot_entry` (pays back refunded entries), `draw_draw` / `settle_draw`, `claim_duel_timeout`, Moon Wars starts, timeouts and payouts, Prediction locks, settlements and payouts of rounds that exist, `seal_drop`, `claim_drop` / `claim_drop_xnt` (deliver Forge Drops, v2), `withdraw_vested`, `expire_epoch`, and claims for anyone. Funds always go to the player recorded on-chain, never to the caller.

Tips are paid **by the reward pool**, never by the user: 0.002 XNT per claim of ≥ 0.02 XNT submitted for someone else, and 0.01 XNT per Forge Drop delivered for someone else. Nothing pays a third party for settling bets, draws, Moon Wars or Predictions today. From the final upgrade (dated; round 4 of its source, 2026-10-25) only the registered house keeper receives a settle tip, at most 0.0005 XNT per settled house bet and never more than half of that bet's 1% pool share; nobody else is paid for upkeep, and the claim tip is paid only on claims of at least 0.2 XNT submitted by someone other than the player or the oracle.

```bash
cd oracle && npm install
ORACLE_PRIVATE_KEY='[...]' npm run keeper    # any funded X1 key works for keeping
```

In each pass the keeper settles draws and lottery rounds first (their block hash must be used within ~512 slots), then unsettled bets, then it expires every epoch whose 90-day window has closed and seals the pending Forge Drops of the others, then submits pending claims and delivers drops for each open epoch; then it pays back refunded Jackpot entries, starts joined Moon Wars matches and claims their timeouts, and locks or settles due Prediction rounds. It does not push vested XNT automatically.

## Checking that a burn was paid

- **Proof of payment: the `ClaimReceipt` account.** PDA `["receipt", u64le(epoch), player, tier]` of the program; it stores `epoch`, `player`, `tier` and `amount` (lamports) and exists from the claim until the epoch is closed (90 days after publication), when anyone may close it. If the account exists, that leaf was paid, once. Orbit / Moon Landing leaves also have a `Mission` account (`["mission", u64le(epoch), player, tier]`) holding the vesting XNT.
- **Where the XNT goes.** A Launchpad claim pays the player's wallet. If that wallet would still be below the rent-exempt minimum after the payment (a brand-new wallet receiving less than ~0.00089 XNT), the amount is credited to the player's **game balance** (`PlayerState`, `["player", owner]`) instead, because the chain refuses to leave an account under that minimum. Moving it to the wallet then needs a `withdraw` signed by the owner. Payouts above that minimum always land in the wallet itself.
- The epoch file (`frontend/public/epochs/epoch-N.json`) lists every leaf with its score and proof; `npm run verify -- <file> --full` re-reads the burns from the EVM logs, recomputes the epoch from the recorded price and liquidity inputs and compares with X1.
