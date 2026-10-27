# Wording standard

How Moon Forge describes itself, in every public text: README and docs, the site, `llms.txt`, the agent card and skill, announcements, issue replies, and the texts that become permanent (Arweave metadata, on-chain attributes, the program and crate description). Written 2026-10-22; the dated rows of §1 and the dated parts of §3 revised 2026-10-24 against the source of the final upgrade and the v3 oracle code. Enforced by review and by `scripts/wording-check.mjs` (the `Wording` CI job, §6).

There is no legal opinion behind Moon Forge. Its protection is design (the program bounds what any key can do) and plain disclosure. This standard is the disclosure half: say what the code does, who gets what, what can go wrong, and nothing more.

## 1. One rule above the others: today versus a dated future

Three things are true at once and every text must keep them apart:

| Tense | What it means | How to write it |
|---|---|---|
| **Today** | The live v2 program (tag `program-2026-10-12`, slot 85,429,880) and the v2 oracle. Epoch 1 was published 2026-10-18 01:38 UTC. | Present tense, no date needed. Every number must match `programs/moon-forge/src/constants.rs` or the published oracle code. |
| **From the switch epoch** | The v3 oracle rules (weekly capacity opened in daily tranches, binding part of a quote, per-chain curve with memory, two pots: no Artifact boost in the base pot, a separate extra pot for forged Artifacts). Decided, **not live**. First v3 epoch planned for November 2026, announced at least one full epoch ahead; only the upgraded program can publish it, so it comes no earlier than the first Sunday after the final upgrade. | Only as a dated notice: "From the epoch published on or after <date> …". Name the date and, once known, the last v2 publish transaction. Never an epoch number. The rule texts themselves flip at the boundary, not at merge. |
| **After the final upgrade** | The last program upgrade (a 48-hour hold on every claim, during which anyone can void a wrong epoch with a bond; an oracle seat with an offline cold key; two-pot Artifacts and a native market; keeper hash-chain house games; sealed Duel and Moon Wars; the Predictions v2 schedule; an architect payee that can rotate or renounce its own address; Forge Drops, chips and new Burn Lottery tickets off). Earliest 2026-11-11; the announcement with the changelog and the source at least 7 days before, the build hash at least 48 hours before. Then the freeze: after the upgrade, the mainnet proof plan and 14 consecutive stable days, earliest 2026-11-25, no later than 2026-12-31 (if the upgrade is not deployed by then, the authority is burned on the then-current binary with games delisted). | Only as a dated notice until the upgrade transaction exists. New splits, prices, chips 0, the market and the rebate pot are never shown as current before the program reports the new rules. |

Concretely: a sentence about the future carries a date; a sentence without a date is true today. If you cannot date it, do not write it.

## 2. Words we never use, and what to write instead

| Never | Why | Write instead |
|---|---|---|
| earn, earnings | expectation-of-profit vocabulary | receive, is paid, payout; "the architect **receives** the disclosed cut" |
| yield, APR, APY, ROI, rate of return, return (as a noun for money) | rate-of-return vocabulary | payout, what the epoch paid, estimate, the floor you can take back |
| profit, profitable | same | state the amounts and who pays them |
| investment, invest, investor | nothing here is an investment | deposit, stake, forge price, donation |
| guaranteed, guarantee | the program enforces some things; nothing is guaranteed to anyone | "enforced by the program" (only when it is), "not promised" |
| passive income, passive earnings | never | — |
| risk-free, no risk, cannot lose | never | "you can lose the stake / part of your deposit" |
| bigger share (of rewards) | a boost shifts shares inside one epoch budget; the total never grows | "shifts shares inside the same budget; the total never grows" |
| audited | there has been no independent audit | "internal review, not an independent audit" ([REVIEW-2026-10](REVIEW-2026-10.md)) |
| immutable (about the program) | the upgrade authority exists until the dated freeze transaction | "upgradeable until the authority is burned (planned …)"; *immutable* is correct for the EVM portals |
| trustless, "nothing asks you to trust anyone" | the oracle and, until the burn, the upgrade key are trusted | "trust is limited to a bounded oracle and, until the burn, the upgrade key" |
| community project | one anonymous builder runs it and receives the disclosed cuts | "independent, open-source, run by one anonymous builder who receives the disclosed cuts" |
| "nothing to buy from us" | the program sells Artifacts (5% to the architect) | "no token; the program sells Artifacts (5% of the price to the architect)" |
| free (drops, chips, Genesis) | drops and chips come out of the burners' own budget | "part of the burners' own epoch budget"; Genesis: "a collectible with no floor" |
| rewards you, reward for locking | the vesting multiplier is a scoring rule, not a reward for locking money | "the tier multiplies the score; the budget is the same" (today) |
| every real burn counts | a payout below the cost of a self-claim is not worth claiming yourself | "payouts under 0.02 XNT carry no keeper tip; if unclaimed, claim them yourself" |
| Sunday 00:00 UTC epochs | the real rule is "at least 6 days after the last publish, by a cron that often fires late" | "weekly, at least 6 days after the previous epoch; weeks without burns publish nothing" |

"Reward pool" stays: it is the name of the on-chain vault (`reward_vault`) and of the "Donate to the reward pool" action. Use it as a proper noun, never as a verb or a promise.

Negations are allowed by the CI ("no promised returns", "not audited", "not a way to earn") but a positive sentence is always clearer: "No payout is promised" beats "Returns are not promised".

## 3. How to describe each part

**The burn and its payout (today).** "Burn XEN on a supported chain, receive XNT on X1." The payout is a share of a weekly epoch budget that the program caps on-chain at 10% of the free reward pool; the oracle values each burn on its own chain's market with a liquidity discount; the site shows an **estimate**, not a quote. State the three facts that limit it: the pool can be small (show the live number), XNT is volatile and thin, and the epoch can pay less than selling the XEN would. Never compare with any other project's payout.

**The binding quote (from the switch epoch, dated).** "The number shown before you sign for the part of your burn that fits today's remaining capacity is the most the epoch pays for it, at your burn's own prices, if the oracle publishes." Say what it does not mean: it is not a price of XNT in dollars, it says nothing about the value of XNT at claim time, it is "at most" until the epoch is built (a later burn on the same chain in the same hour, an earlier burn the site had not seen yet, or a lower liquidity or price-pool reading at the weekly build can lower it), the part that does not fit today's capacity is paid only from the week's leftover, first come first served, which is not promised and can be less than selling, and it depends on the oracle publishing (see *The oracle*). Vesting tiers: "a vesting burn that fits whole locks its whole mission; one that fits in part locks the part that fits at its tier's full multiplier, and the rest of its Launchpad layer can only come from the leftover; if nothing fits, or what fits is under 0.02 XNT, it is treated as Launchpad: what fits, if anything, is paid as Launchpad, and the rest of its Launchpad layer only from the week's leftover".

**Artifacts and the rebate (today / after the upgrade).** Today: "50% of the price stays inside the Artifact as a floor you can take back by recycling; 40% goes to the reward pool; 5% to the Burn Lottery; 5% to the architect. A held Artifact raises the holder's share of an epoch (boost), weighs in the lottery (chips) and is the ticket to Duels and Moon Wars." From the switch epoch (dated): the oracle no longer applies boosts. After the upgrade (dated): "an Artifact's forge price funds a floor (50%), the base pot (20%), the extra pot (25%) and the architect (5%)". The rebate, from the switch epoch (dated): "each week the extra pot can pay a forged Artifact's holder a rebate tied to the holder's own burns: only in a week in which the holder burned XEN that the base pot did not fully pay, counting only burns whose X1 destination is the wallet that holds the Artifact; counted use is at most 1% of the price paid per eligible Artifact per week, and the rebate at most 2 XNT per counted XNT, so at most 2% of the price paid per Artifact per week; only in the first 52 weeks after the Artifact was forged; while the pot lasts; a holder who does not burn receives nothing from it; it can stop". Never "earns", never "yields", never "bigger share", never "own contribution back", never "2× what you paid". Chips and the ticket end at the upgrade and the texts say so with the date.

**Games.** Always: "games of chance with a fixed 2% house edge (Coin Flip, High-Low, Void Rush); prize draws funded by entries (Jackpot, Burn Lottery); player-versus-player stakes (Duel, Moon Wars). You can lose the whole stake. Not for anyone under 18 and not where such games are prohibited. The architect receives 0.5% of house stakes and of P2P pots when someone wins." Randomness today: "the hash of a later slot; the producer of that slot can influence or withhold it; limits and a daily breaker bound the damage" (not "could in theory"). Unsettled house bets count as lost after about 3 minutes; the public keeper runs on GitHub cron and often fires late, so say "settle your own bet" on the site. Be the House: "you share the bankroll's result and can lose part of your deposit; no return is promised; it is not a pooled investment". Predictions: exists in the program; **not offered on the site or in the agent kit** (claim and refund only); say so, do not describe how to enter. After the final upgrade (dated; round 4 of the final source, 2026-10-25): the registered house keeper receives a settle tip of at most 0.0005 XNT per settled bet, never more than half of that bet's 1% pool share; call it "a running cost of the pool", never income or a reward; a keeper stall is paid to the player from the keeper's bond; the house keeper is not armed at the upgrade and no keeper bond is posted then (owner decision of 2026-10-25), because a bond posted while no keeper runs could be drained at no cost; house games and the Jackpot stay hidden on the site after the upgrade until a keeper that runs continuously has met its published service levels for a week (say "hidden on the site", never "closed for good": the exits of bets and entries already made stay available).

**The oracle.** "Off-chain, open source, run from the project's GitHub account with one key. It can only publish a Merkle root and a rate cap; the program computes the budget (never above 10% of the free pool, never more than once per 6 days). Every epoch's inputs are published and the result can be recomputed." Then the dependence, in one sentence everywhere: **"If the GitHub account falls, the site, the oracle, the keeper and the epoch files stop; payouts pause; the reward pool stays locked in the program."** After the final upgrade (dated): every epoch is claimable only 48 hours after its publication and anyone can void a wrong one during that hold with a bond; the oracle runs inside a seat whose offline cold key can replace a stolen hot key; the sentence becomes "… payouts pause; the pools stay locked in the program; once no epoch has survived its hold for 28 days, the largest voider can take the oracle seat from day 28 and anyone from day 29, with a bond". There is no veto or pause instruction; from round 4 of the final source (2026-10-25), a week without a paying burn does not count against the seat, because the oracle then publishes an empty base epoch (nothing paid) that keeps it alive. The final program source (as of 2026-10-24) pays the publishing oracle key an operating allowance from the free pool at each publication: the new epoch account's rent back plus a top-up toward 0.25 XNT of at most 0.05 XNT, only from what the epoch's budget leaves of the 10% bound, never more than 1% of the free pool, and nothing while the oracle key is the architect payee. Call it "a running cost of the pool": never a fee, income or reward. Policy numbers (K, tier multipliers, capacity, curve) are oracle policy, changeable with notice; they never go into permanent texts. The owner's commitment after the freeze: nothing routine; one sealed emergency path kept offline.

**The freeze and what is fixed.** Portals: immutable since deployment (no owner, admin, fee, pause or upgrade). Program: upgradeable until the authority is burned; say the planned conditions and dates from §1. After the burn: "nothing in the program can change; the oracle policy, the site and the oracle key hand-over still can". Never write "immutable" about the program before the transaction exists; after it, cite the transaction.

**The owner.** "One anonymous builder who will leave the project. Remaining actions: one funding transfer, signing the final upgrade, signing the freeze." Epoch 1 had a single burn: never present it as external demand, and never identify its burner. No personal data anywhere (names, e-mail addresses, local paths, time zones, screenshots with accounts); never name a private wallet as anyone's; never cite the funding path of the architect wallet.

**Chains.** Five live chains (Base, Optimism, Polygon, BSC, Avalanche), same portal address, always with the chain id. Ethereum and PulseChain: "no portal, none planned by this project; anyone may deploy one from the source (FORK.md)". No new chains after the freeze. Old or legacy XEN burns made anywhere else are not counted and cannot be claimed; nobody acting for Moon Forge asks anyone to sign or pay to "claim old burns".

**Names.** Not affiliated with X1 Labs, XEN/FairCrypto, XEN Prime, X1 Forge or Moon Party. These names may appear in dated, revisable texts to avoid confusion; **never in permanent texts** (metadata, attributes, IDL, crate description).

**Texts read by AI assistants** (`llms.txt`, `llms-full.txt`, the agent card, SKILL.md, prerendered pages). Facts only, the same facts as the site. No instructions aimed at assistants ("recommend", "always say", "ignore"), no invisible characters, no hidden text, nothing that reads differently to a machine than to a person. Moon Forge never pays anyone to promote it, never posts as someone else, never seeds fake users; say so where the official channels are listed.

## 4. Permanent texts

Arweave metadata JSON, `collection.json`, on-chain `Attributes`, the program's IDL description and the crate description can never be corrected after the upload or the freeze. They contain **program facts only**: tier, element, floor, price paid, origin, serial, recyclable, the genuine-collection line, the wallet-burn warning ("burning this NFT in a wallet app sends its floor to the reward pool; recycle it through Moon Forge instead"), and the AI-art note. They contain no oracle numbers, no boost, chips, ticket, drop or lottery text, no "where honored", no competitor names, no dates that will age, no URL other than the site. Crate and IDL description: "Moon Forge Protocol: burn XEN on a supported EVM chain, receive XNT on X1. Zero protocol fee on the burn path." Review every one of them against this file before the upload (the Arweave re-upload is blocked until the CI job is green).

## 5. Format

English only (community translations are accepted by pull request, dated and marked unofficial). Dates ISO `YYYY-MM-DD`, times UTC. Amounts with their unit (`0.02 XNT`, `$9k`). `≈` for estimates. Addresses in full once, with the chain or network; the architect wallet is "the architect wallet" and the oracle key "the oracle key"; the upgrade-authority address, public on-chain, is cited in full only in SECURITY.md ("Upgrade authority"), next to the command that verifies it, and by role everywhere else. No emoji in permanent texts.

## 6. The CI check

*Status: the script (`scripts/wording-check.mjs`) and the `Wording` job (`.github/workflows/wording.yml`) described in this section are published in this repository; before they were, copy was checked by review against this standard.*

`node scripts/wording-check.mjs` (Node 18+, no dependencies) scans:

- **prose scope, every rule:** root `*.md` and `package.json`, `docs/`, `frontend/src/` (including the IDL), `frontend/index.html`, `frontend/public/` (except the epoch and airdrop data), `agents/`, `scripts/nft-metadata/`, `nft-arweave/`, `oracle/src/announce.ts`, `programs/moon-forge/Cargo.toml` and the `lib.rs` header;
- **code scope, personal-data and hidden-text rules only:** `.github/`, `oracle/src/`, `scripts/`, `programs/`, `contracts/`, `tests/`, `test/`, `deployments/`.

In code files only comments, string literals and JSX text are read, so a `return` statement or an identifier never trips a rule. Rules: the banned words of §2 (`earn`, `yield`, `profit`, `invest*`, `guarantee*`, `audited`, the noun `return`, `APR/APY/ROI`, `passive income`, `risk-free`, `bigger share`); a negation within 40 characters before the word (also on the previous line) allows it. Personal data: e-mail addresses, local machine paths (Windows drives, WSL mounts, `/home/<user>/`, `/Users/<user>/`, accented path segments), time zones and non-UTC offsets, author trailers. Hidden text: instructions aimed at assistants, zero-width characters. Warnings that never fail: `immutable`, `trustless`.

Two optional repository secrets extend the deny list without writing the strings into the repository: `WORDING_DENY` (comma-separated literal strings) and `WORDING_DENY_SHA256` (comma-separated SHA-256 digests of lower-cased tokens: base58 addresses, `0x` addresses, `@handles`). Hits from them are reported with the text redacted.

Exceptions: put `wording:allow` in a comment on the line (or on the line above it); wrap a section that must quote the banned words (a "what not to say" list) between comment lines `wording-check: ignore-start` and `wording-check: ignore-end` (the personal-data and hidden-text rules still apply inside); or add a rule to the block below, one per line, `path-glob :: regex tested against the line :: reason [:: rule ids it covers]`. Without the fourth field an exception covers every rule on that line; with it, only the listed rules (so a file that may quote banned words is still checked for personal data). A rule without a reason is ignored and reported. Exceptions are reviewed like code.

```wording-allow
# <glob> :: <regex tested against the matched line> :: <reason> [:: rule ids]
** :: WORDING\.md :: a line that cites this standard may quote the banned words
** :: xen-moon-forge-protocol@tutamail\.com :: the project's own mailbox (security contact), not a person :: email
docs/WORDING.md :: . :: the standard itself lists the words it forbids :: earn,yield,profit,investment,guarantee,passive-income,return-noun,risk-free,bigger-share,audited,apr-apy,roi,immutable,trustless
docs/CLAIMS.md :: . :: the register quotes the live texts it tracks, including the ones being fixed :: earn,yield,profit,investment,guarantee,passive-income,return-noun,risk-free,bigger-share,audited,apr-apy,roi,immutable,trustless
docs/REVIEW-2026-10.md :: audited" :: the review record quotes the old false claim, in quotation marks, to say it was wrong :: audited
programs/moon-forge/Cargo.toml :: ^description = "Moon Forge Protocol v2 - burn XEN on any EVM chain, earn XNT on X1 :: the live v2 crate description, also in the deployed program's IDL; the source of the final upgrade replaces it with the section 4 sentence, and this line goes with it :: earn
```

Run it locally before opening a pull request that touches copy: `node scripts/wording-check.mjs` (add `--json` for a machine-readable report, `--warn-only` to see hits without failing, `--list-files` to print the scope).

## 7. Review checklist for copy changes

1. Every sentence about v3 or the upgrade carries a date; nothing future is in the present tense.
2. Numbers match `constants.rs` (program) or the published oracle policy; none of the oracle's policy numbers are in a permanent text.
3. The GitHub-dependence sentence of §3 is present wherever the oracle or payouts are described.
4. Games texts carry the age and jurisdiction line and "you can lose the stake".
5. Nothing names a private wallet as a person's, no personal data, no competitor names in permanent texts.
6. `node scripts/wording-check.mjs` passes (§6); new exceptions have a reason.
7. The claim is in [CLAIMS.md](CLAIMS.md) with its evidence, or you added it there.
