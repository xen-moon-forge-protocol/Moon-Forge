# Moon Forge Bot

A small program you run on your own computer that does the routine Moon Forge chores for you, under rules you write:

- **Burn strategist.** Every few minutes it reads the hourly week-so-far feed and the day's capacity slice, asks the agent kit for a quote on every chain, and burns XEN through the Moon Forge portal only when your rule is met (enough XNT per XEN, at least what selling would bring, a slice still open, your daily caps and your gas caps). One decision line per chain per tick says what it did and why.
- **Claimer.** It finds your XNT leaves in the published epoch files and claims them once the 48-hour hold is over and while the 90-day window is open; after the final upgrade it also claims the extra-pot rebates of your Artifacts.
- **Games (optional, off by default, 18+ only and only where legal).** Sealed Duel and sealed Moon Wars within a stake cap and a total loss budget; house games only while the house keeper seat is live on X1. You can lose the whole stake.
- **Artifacts (optional).** Alerts about the Artifacts you hold; recycling or listing only the assets you name, a few per day at most.
- **A2A.** An agent card ([`agent-card.json`](agent-card.json)) and a local HTTP/JSON interface, off by default, so another agent can ask it for a quote or a plan. It never signs on request.

It is community software under the MIT license, built on the Moon Forge [agent kit](../../agents/kit). Anyone may copy it, change it and share improvements. **Each user tunes it to their own reality**: their chains, their XEN, their gas budget, their schedule.

> **Real scale first.** On 2026-11-02 the reward pool held about 6.5 XNT, so one week can pay at most about 0.65 XNT to all burners together under the current rules (about 0.5 XNT under the v3 rules). No payout is promised. A bot does not make the pool bigger; it only acts on your rules faster than you would by hand.

## What it does today (dated 2026-11-08)

The binding quote exists only from the v3 switch epoch (planned for November 2026, announced at least one full epoch ahead). Until the week-so-far feed is published, every tick logs `decision=WAIT reason="no week-so-far feed published yet ..."` and **the bot does not burn**: the kit fails closed, and the bot never burns without the kit's quote. Claims work today (the bot finds and claims leaves of published epochs). Sealed games, the extra-pot rebates and Artifact listings need the final upgrade (planned, earliest 2026-11-25); the bot reads the rules from X1 and waits until then.

## How a burn decision is made

On every tick, for every chain in [`deployments/portals.json`](../../deployments/portals.json):

1. **Chain check.** The chain must also be in the kit's portal list with the same portal and XEN addresses (a config file is never trusted over code), enabled in your config, and have an RPC.
2. **Kill switch and in-flight check.** Nothing happens while the kill switch is on, or while an earlier transaction on that chain is not final.
3. **Gas check.** The current max fee per gas must be under your cap for that chain.
4. **Room.** How much XEN your limits leave: per burn, per UTC day, the number of burns per day, and the wallet's XEN balance (whole XEN only).
5. **Quote and rule.** The kit quotes the burn on the feed (`quoteBurn`). The bot looks for the largest amount that the kit accepts **and** your rule accepts: today's slice has at least `minRemainingTodayXnt` left, the burn takes at most `maxShareOfRemainingBps` of it (the kit's own maximum is half), XNT per 1,000,000,000 XEN is at least `minXntPerBillionXen`, and the quote is at least `minQuoteOverMarketBps` of what selling the XEN would fetch (10000 = the same as selling).
6. **Pick.** Of the chains that pass, the one paying the most XNT per XEN burns first (`maxBurnsPerTick`, default 1). The others log `WAIT` with the reason.
7. **Send (only with `--live`).** The kit's `burnXen` re-checks the destination and the oracle on X1, approves the **exact** amount (never unlimited), re-quotes, and calls `enterForge`. Every transaction goes through the bot's guard: a simulation first (a call that would revert is never sent), a fresh gas estimate with headroom, the fee cap and the cost cap, a native-coin reserve kept in the wallet, the nonce read from the chain and never reused, the signed transaction written to the journal **before** it is broadcast, a broadcast error looked up by hash before anything is reported, and the confirmations awaited with a timeout. A transaction still unknown after the timeout stays in the journal, and the next tick settles it before sending anything else.

A decision line looks like this:

```
2026-11-30T14:05:00Z DECISION tick=12 mode=dry-run chain=Base(8453) decision=BURN reason="rule met" amountXen=25000000 quoteXnt=0.004100 xntPer1e9Xen=0.164000 leftTodayXnt=0.051000 sellXnt=0.003900
2026-11-30T14:05:00Z DECISION tick=12 mode=dry-run chain=Optimism(10) decision=WAIT reason="another chain pays more per XEN this tick" ...
2026-11-30T14:05:00Z DECISION tick=12 mode=dry-run chain=BSC(56) decision=WAIT reason="gas price 4.1 gwei is above the cap of 3 gwei"
```

The numbers above are illustrative: they assume a week with burns and a pool of the size stated above.

## Setup

Requirements: Node 22 or later, and this repository (the bot imports the kit from `../../agents/kit`).

```bash
git clone https://github.com/xen-moon-forge-protocol/Moon-Forge.git
cd Moon-Forge/agents/kit && npm ci --ignore-scripts          # the kit, from its committed lockfile
cd ../../bots/moon-forge-bot && npm ci --ignore-scripts      # one dependency: ethers, to sign EVM transactions
cp config.example.json config.json                           # config.json is git-ignored
node bin/moon-forge-bot.mjs check                            # validates the config, prints the notices and the chains
```

Pin the repository commit you reviewed and do not auto-update a funded bot. Install only from the committed lockfiles (`npm ci --ignore-scripts`, never `npm install`).

### Keys

- **EVM key** (burns): the wallet that holds the XEN and pays the gas. Put it in a file (`keys.evm.file`) or in the environment variable named by `keys.evm.env` (default `MFBOT_EVM_KEY`). It is needed only with `--live`.
- **X1 key** (claims, games, Artifacts): pays the claim fee and the receipt rent; the XNT of a claim always goes to the wallet in the leaf. Without it the bot connects read-only and plans, never sends. File or `MFBOT_X1_KEY`.
- **X1 destination** (`x1Destination`): the X1 wallet that receives the XNT of every burn. Type its last 6 characters in `x1DestinationConfirm`; the bot refuses to start a burn when they differ.

Keys never go in `config.json` (the config check refuses a `value` field). Every log line is scrubbed of anything that looks like a key, a seed phrase or an RPC URL path. Use a separate wallet for the bot, funded only with what it may spend.

## Config

Everything the bot may do is in `config.json`. The main parts (see [`config.example.json`](config.example.json) for all of them):

| Setting | Meaning |
|---|---|
| `burn.rule.minXntPerBillionXen` | Burn only when the quote pays at least this many XNT per 1,000,000,000 XEN. |
| `burn.rule.minQuoteOverMarketBps` | Burn only when the quote is at least this share of what selling would fetch (10000 = the same; 0 turns the comparison off, not advised). |
| `burn.rule.minRemainingTodayXnt` | Burn only while today's slice has at least this much left. |
| `burn.rule.maxShareOfRemainingBps` | One burn takes at most this share of what is left today (default 2500 = 25%). |
| `burn.limits.maxXenPerBurn`, `maxXenPerDay`, `maxBurnsPerDay` | Hard caps (whole XEN, UTC days). Both XEN caps must be set. |
| `burn.gas.maxFeePerGasGwei`, `maxGasCostNative`, `keepNativeReserve` | Gas caps per transaction and the coin kept for later. Override per chain in `burn.chains["<chainId>"].gas`. |
| `burn.gas.extraFeeNative` | Added to the cost estimate for chains that charge a separate data fee (Base, Optimism). |
| `burn.chains["<chainId>"]` | `rpcs` (your endpoints first), `enabled`, gas and `limits.maxXenPerBurn` overrides. |
| `burn.tier` | 0 Launchpad (default). 1 Orbit and 2 Moon Landing lock a vesting mission for 45 or 180 days. |
| `claims` | `base`, `extra` (rebates after the final upgrade), `withdrawVested`, `minClaimXnt`, `owner` (default `x1Destination`). |
| `games` | Off. `ageConfirmed18Plus`, `lossBudgetXnt` (total, measured on the wallets), `maxStakeXnt`, `maxGamesPerDay`, and each game's switch. |
| `artifacts` | `alerts`; `recycle.assets` and `listing.items` name exactly what the bot may touch. |
| `a2a` | Off. Host (127.0.0.1), port, token variable, `allowActions`. |
| `killSwitchFile` | Create this file (or set `MFBOT_STOP=1`) and the bot sends nothing and leaves its loop. |

### Examples of rules

- *"Burn on whichever chain pays best, but never below selling, at most 50,000,000 XEN a day"*: `minQuoteOverMarketBps: 10000`, `maxXenPerDay: "50000000"`, every chain with an RPC.
- *"Only Base, small slices, only cheap gas"*: set `enabled: false` on the other chains, `maxShareOfRemainingBps: 1000`, `burn.chains["8453"].gas.maxFeePerGasGwei: 0.05`.
- *"Claims only"*: `burn.enabled: false`, `claims.enabled: true`, an X1 key that pays the claim fees.

## Dry run, then live

```bash
node bin/moon-forge-bot.mjs once                    # one tick, dry run: decisions only, nothing signed
node bin/moon-forge-bot.mjs run                     # a dry-run loop every tickSeconds
node bin/moon-forge-bot.mjs quote --chain 10 --xen 1000000
node bin/moon-forge-bot.mjs once --only claims      # one part only: burn, claims, games, artifacts
```

Run it dry for at least a few days and read the decision lines. When they match what you want:

1. set `"acceptRiskNotice": true` after reading the notice `check` prints;
2. start with small caps (`maxXenPerBurn`, `maxXenPerDay`) and a small gas budget;
3. `node bin/moon-forge-bot.mjs run --live`.

Stop it at any time with Ctrl+C or the kill switch. The journal (`state/journal.json`) is the bot's memory of what it burned per day and of every transaction it signed: keep it with the bot, and do not delete it while a transaction is not final.

## A2A interface

With `a2a.enabled: true`, `run` also serves on `127.0.0.1:8787`:

| Request | Answer |
|---|---|
| `GET /.well-known/agent-card.json` | The bot's agent card. |
| `GET /status` | Mode, kill switch, chains, the last tick's decisions. |
| `POST /quote {"chainId":10,"amountXen":"1000000"}` | The kit's quote and your rule's verdict. Read-only. |
| `POST /plan` | A dry-run tick of the strategist. Read-only. |
| `POST /tick` | One normal tick within every limit; 403 unless `a2a.allowActions` is true; sends only if the bot runs with `--live`. |

Any host other than loopback needs a bearer token, read from the environment variable named in `a2a.tokenEnv`.

## Fork and adapt

The code is short on purpose; read it before you fund it.

| File | What to change there |
|---|---|
| `src/strategy.mjs` | Your burn rule: thresholds, the amount search, which chain goes first. Pure functions with tests. |
| `src/burner.mjs` | The order of checks in a tick. |
| `src/evm-guard.mjs` | Gas, nonce and confirmation policy. |
| `src/claimer.mjs`, `src/games.mjs`, `src/artifacts.mjs` | The other jobs. |
| `src/kit.mjs` | The one file that points at the kit. In a fork that keeps only this folder, copy `agents/kit` next to it and change the paths there. |

Run `npm test` after every change (`node --test`, no network: strategy decisions, config validation, chain discovery, the guard, dry-run ticks with a mocked feed and RPC, and one tick through the kit's real quote on a golden feed).

## Add a chain

When a chain is added to Moon Forge ([OPERATORS.md, "Add a chain"](../../OPERATORS.md#add-a-chain)), its portal appears in `deployments/portals.json` and the bot lists it on the next start with `SKIP` and the reason. To burn there:

1. update the kit to a reviewed version that lists the new portal (the kit's quote refuses any chain it does not know, and the bot refuses an address that differs between the file and the kit);
2. add `burn.chains["<chainId>"]` with your `rpcs` and gas caps for that chain;
3. `check`, then a dry run.

## Risks

- **A burn cannot be undone.** The XEN is destroyed on its chain; the payout is XNT on X1 under the rules of the epoch the burn falls in. The quote is "at most" until the epoch is built; the part beyond today's capacity is paid only from the week's leftover, which is not promised. XNT is volatile and thin.
- **The pool is small** (see the scale note above) and no payout is promised. If the GitHub account falls, the site, the oracle, the keeper and the epoch files stop; payouts pause; the reward pool stays locked in the program.
- **Other bots are fast.** Scripts can take a day's slice the moment it opens; your rule may simply never be met.
- **Software risk.** This bot, the kit, the RPCs and your machine can fail. A transaction can land after an error; the journal and the hash look-ups exist for that, but check the explorer when in doubt.
- **Games** are games of chance or player-versus-player stakes: you can lose the whole stake; house games carry a fixed 2% edge; your opponent may be another automated agent. Not for anyone under 18, and not where such games are prohibited.
- **Keys.** Whoever reads your key files controls the wallets. Keep them on your machine, outside any synced folder, with the bot's wallets holding only what it may spend.
- **Old burns are not counted.** Only burns made through the Moon Forge portals are paid. Never sign, link or pay anything to "claim old burns".

Moon Forge is independent and is not run by the XEN or X1 teams or any other XEN program. You run this bot and hold its keys: you are responsible for what it does.

## License

MIT, the same as the Moon Forge repository: see [LICENSE](LICENSE).
