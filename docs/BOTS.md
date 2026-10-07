# Bots and automation

Moon Forge welcomes bots. They cannot gain an informational edge — house results come from the hash of a slot that does not exist when the stake is locked (the block producer of that slot could in theory influence it; see [SECURITY.md](../SECURITY.md#randomness)) — but they add volume, and **1% of every house-game stake goes to the burners' reward pool**.

## Session keys (house games only)

A player authorizes a delegated key once:

```ts
await program.methods.setSession(botPubkey, new BN(expiresAtUnix), new BN(maxStakeLamports))
  .accountsPartial({ playerState: PDA.player(owner), owner }).rpc();
```

The session key can: `place_bet` (Coin Flip, High-Low, Void Rush) using the owner's **game balance**, within `max_stake` and before `expires_at`.
It can never: `withdraw`; enter the Jackpot or the Burn Lottery; create or join Duels; or change the session. Player-vs-player games need the wallet owner's signature (the program returns `OwnerOnly`). Revoke with `set_session(Pubkey.default, 0, 0)`.

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

- **Settle within ~3 minutes.** A bet not settled before its target slot leaves the SlotHashes window counts as lost, even if its roll was a win. `playHouse` settles immediately; the public keeper, when running, also settles pending bets (`cd oracle && npm run keeper`), but it is a safety net, not a guarantee.
- **Max net win per bet = 0.25% of the free bankroll.** Read it before betting (`fetchProtocol().maxNetWin`).
- **Aggregate cap:** a bet is refused if all unsettled payouts together would exceed 20% of the bankroll.
- **Daily circuit breaker:** if the bankroll (net of LP deposits and withdrawals) has lost 10% since the start of the UTC day, new house bets are refused until the next UTC day (`DailyLossLimit`).
- **Minimum stake 0.01 XNT.**
- Use your own RPC for high frequency; the public X1 RPC is rate-limited.

## Keepers

Everything time-based is permissionless: `settle_bet`, `draw_jackpot` / `settle_jackpot`, `close_jackpot_entry` (pays back refunded entries), `draw_draw` / `settle_draw`, `claim_duel_timeout`, `seal_drop`, `claim_drop` / `claim_drop_xnt` (deliver Forge Drops), `withdraw_vested`, `expire_epoch`, and claims for anyone. Funds always go to the player recorded on-chain, never to the caller.

Tips are paid **by the reward pool**, never by the user: 0.002 XNT per claim of ≥ 0.02 XNT submitted for someone else, and 0.01 XNT per Forge Drop delivered for someone else.

```bash
cd oracle && npm install
ORACLE_PRIVATE_KEY='[...]' npm run keeper    # any funded X1 key works for keeping
```

The keeper settles rounds first, then bets, seals and delivers Forge Drops, submits pending claims, pays back refunded Jackpot entries and expires epochs. It does not push vested XNT automatically.
