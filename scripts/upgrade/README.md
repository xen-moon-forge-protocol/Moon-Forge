# Upgrade-day tools

Node scripts for the final program upgrade (`deployments/upgrade-v3-signoff.md`, SPEC-UPGRADE-v2 sections 6.3 and 9).
They hold no key material: every keypair file is named by path when the command runs, and only public keys are printed.

Rules shared by every script:

- **Dry run by default.** A script reads the chain, prints every account and every amount it would move, and simulates
  the transactions without signatures. Nothing is signed or sent without `--send`.
- **Mainnet needs two flags.** On X1 mainnet (recognised by its genesis hash), `--send` is refused unless `--mainnet` is
  also given. A command meant for a test validator can never land on mainnet.
- **Key files must match the sheet.** Each key file must hold the public key the sign-off sheet names, given as a flag
  (`--payee`, `--keeper`, `--deploy-key`, ...). Any other key is refused before anything is sent.
- **Safe to re-run.** Every step re-reads the chain first and is skipped when already done. The sender never resends a
  transaction: after a timeout, run the script again.
- **Exit codes.** 0 = green, 1 = a check or step failed, 2 = usage error, 3 = refused before sending.

Dependencies come from `oracle/node_modules` (else `tests/node_modules`): run `npm ci --ignore-scripts` in `oracle/` first.

| Stage (sign-off sheet) | Command |
|---|---|
| S5, at S6 − 30 min (section 4, "S5 census") | `node scripts/upgrade/census.mjs --stage s5 --keeper-wallet <OD-25> --deploy-at <planned start, ISO UTC> --out census-s5.json` |
| S2, after the published hash (section 2, "`UPGRADED_ELF` pin") | `node scripts/upgrade/pin-elf.mjs --elf target/deploy/moon_forge.so --expect-sha <S2 sha256>`, then the same with `--write`, in a reviewed commit before S7 |
| S6, after step 10 | `node scripts/upgrade/census.mjs --stage s6 --deploy-key <OD-32> --keeper-wallet <OD-25> --seat-cold <OD-16> --expect-deploy-slot <new slot>` |
| S6 step 11 | `node scripts/upgrade/pins.mjs --stage s6 --deploy-key <OD-32>`, then with `--write` |
| S7 | `node scripts/upgrade/s7.mjs --payee <OD-22> --keeper <OD-25> --seat-cold <OD-16> --seat-refund <OD-20> --deploy-key <OD-32> --metadata-base <METADATA_BASE_URI>`: dry run first; then add `--deploy-wallet-key <file> --payee-key <file> --send --mainnet`. No keeper key file: the house keeper is not armed at S7 (F1-b) |
| S7, after the first run | `node scripts/upgrade/census.mjs --stage s7 --payee <OD-22> --keeper-wallet <OD-25> --seat-cold <OD-16> --seat-refund <OD-20> --deploy-key <OD-32> --expect-deploy-slot <S6 slot> --metadata-base <METADATA_BASE_URI>` (it expects no HouseKeeper) |
| S9 | `node scripts/upgrade/s9.mjs --deploy-key <OD-32> --expect-deploy-slot <S6 slot>`: dry run first; then add `--deploy-key-file <file> --send --mainnet` |
| S9, after the freeze | `node scripts/upgrade/census.mjs --stage s9 --payee <OD-22> --deploy-key <OD-32> --expect-deploy-slot <S6 slot>` (it expects no HouseKeeper) |
| LATER, not part of the upgrade: the day a keeper has run continuously for at least 24 hours with the INITIAL_KEEPER key, outside GitHub Actions | `node scripts/upgrade/s7.mjs --arm-keeper --payee <OD-22> --keeper <OD-25> --continuous-keeper-since <its start, ISO UTC> --keeper-key <file>`: dry run first; then add `--send --mainnet`. Then the census of the current stage with `--keeper-armed`. Before or after S9: `arm_keeper` needs no upgrade authority |

**Why the house keeper is not armed at S7 (F1-b, owner answer of 2026-10-25).** While no keeper runs, anyone could place
house bets that nobody anchors: each is refunded in full, and the keeper bond pays the edge and forfeits the stake, so a
bond posted with no keeper running could be drained at no cost to the bettor. Without a keeper seat the program takes no house bet, and a Jackpot round that ends is
refunded to every entry, so nothing can be drained. House games and the Jackpot stay hidden on the site until a
continuous keeper has met the published service levels for a week (D-39): `--arm-keeper` starts that week, and a later
site release lists the games once it is met. No keeper bond is funded for the upgrade.

## What each script does

**`census.mjs`** (read-only, never sends) lists every program account by kind and every in-flight one: pending bets,
Jackpot and lottery rounds, prediction rounds, duels, wars, LP withdrawal requests, missions and epochs. It also checks
the gates of its stage:

- **s5:** the live binary's deploy slot and data length; both authorities equal the deploy wallet; no Jackpot round
  DRAWING; no prediction round locking or settling near the window. The planned window must not touch 12:00 / 14:00 UTC
  ± 30 min or Sunday 00:00 UTC ± 6 h. Any epoch younger than 48 hours is noted. It reports the deploy-wallet and
  INITIAL_KEEPER balances (the keeper needs only its fees, `--min-keeper` 0.1 XNT by default: no keeper bond at S7), the
  free pool and the seat bond, and it simulates `init_seat` to show that the old binary does not know it.
- **s6:** a new deploy slot; the deployed ELF equals the S2 build (`--elf`, or the `UPGRADED_ELF` pin); INITIAL_KEEPER
  and SEAT_COLD_INITIAL are compiled in; both authorities equal the DEPLOY_KEY; the on-chain IDL equals
  `moon_forge.v3.json`; the SPEC 6.3 step-1 simulations pass.
- **s7:** everything of s6, plus `Config.architect` = the payee, the Royalties plugin locked (500 bps, payee 100%), the
  OracleSeat with the expected cold and refund keys, ExtraState and extra_vault, and NO HouseKeeper (a seat found at
  S7 is red). With `--keeper-armed` it expects instead the HouseKeeper of the later arm: armed by INITIAL_KEEPER with a
  bond of at least 20 XNT and no withdrawal requested.
- **s9:** no upgrade authority, the IDL authority erased, and the binary and IDL unchanged since S6; the HouseKeeper as
  in s7 (absent, unless `--keeper-armed`).

`--out` writes the census as JSON and prints its sha256 for the sheet.

**`s7.mjs`** runs the S7 steps in order, one transaction each:

1. `refresh_collection_uri`.
2. `set_architect`, signed by the deploy wallet and the payee.
3. `lock_collection_royalties`, signed by the payee. The script refuses unless `Config.architect` is the payee, and it
   tops the payee up to 0.001 XNT from the deploy wallet in the same transaction: Core charges the collection's rent
   difference to the payee.
4. `init_seat`, with a bond of max(1 XNT, 10% of the free pool).
5. `init_extra`. Its transaction and block time are printed: they are the OD-9 boundary.
6. The health pins: the payee and the seat keys. The keeper pin stays unpinned, because no HouseKeeper exists.

No step sends `arm_keeper` or `take_keeper` at S7. `--steps arm-keeper` and the keeper flags (`--keeper-key`,
`--deposit`, `--continuous-keeper-since`) are refused there. `--keeper` is still checked: it must be the key compiled
into the deployed binary, because INITIAL_KEEPER stays the only key that can ever create the keeper seat.

Before step 1, the script checks the deployed ELF, the IDL, both authorities, the compiled-in keys, that the roles use
distinct keys and the step-1 simulations, and it reports whether a HouseKeeper exists (one that exists already was
armed outside this plan: a warning, and the run leaves it alone; the S7 census then shows it red).

**`s7.mjs --arm-keeper`** is the later step, for the day a keeper has run continuously (an always-on loop outside GitHub
Actions) with the INITIAL_KEEPER key for at least 24 hours. It never runs together with the S7 steps. It refuses unless
`--continuous-keeper-since` (a UTC time) is at least 24 hours before the chain time, and it reads no key but the
INITIAL_KEEPER key file. It sends `arm_keeper` with a bond of at least 20 XNT through the oracle's own `keeper-arm`, so
the chain is the one every keeper run derives from that key, then sets the keeper pin (`pins.mjs --stage keeper`). It
prints the start of the service-level week: house games and the Jackpot stay hidden on the site until that keeper has
met the published service levels (anchors within 150 slots, reveals within 10 minutes) for 7 days, and a site release
then lists them (`KEEPER_SLA_MET`). A hand-over to another keeper key is the oracle's `keeper-take`, never this script.

**`s9.mjs`** sends one transaction that erases the IDL authority and sets the upgrade authority to none, so both go
together or neither does. Before that, it checks:

- the date (not before `--not-before`, default 2026-11-25 00:00 UTC);
- the S6 deploy slot and the pinned ELF;
- both authorities equal the DEPLOY_KEY;
- the on-chain IDL equals the final file (if it does not, the script prints the `anchor idl upgrade` command to run
  first);
- the S7 accounts exist (OracleSeat, ExtraState), and `Config.architect` equals the pinned payee. The HouseKeeper is
  only reported: the freeze does not change who can arm it later.

After a verified freeze, it moves the health pins to "none" and "erased".

**`pins.mjs`** updates `oracle/src/health-pins.json`. It sets a pin only to a key that both the chain shows and the
sheet names, and it writes the file only with `--write`. Stages: `s6`, `s7` (the keeper pin is left as it is while no
HouseKeeper exists), `s9`, and `keeper` (the keeper pin only, after the later arm).

**`pin-elf.mjs`** hashes the S2 build and checks it against the published hash and, with `--rpc`, against the deployed
program. It refuses a `--features localnet` build. It prints the `UPGRADED_ELF` line for `oracle/src/x1-v3.ts` and
writes it only with `--write`.

## Rehearsal

`bash tests/run-upgrade-tooling.sh` runs on a local validator, on the path of `tests/run-upgrade.sh`:

1. The old binary first, with in-flight accounts.
2. The S5 census.
3. S6 by the sheet's commands.
4. The pin, the S6 census and the pins.
5. The S7 dry run, the S7 send (no `arm_keeper`) and a re-run.
6. The S7 census (no HouseKeeper).
7. The S9 dry run and the S9 send.
8. The S9 census (no HouseKeeper).
9. The later `--arm-keeper` after the freeze: its dry runs, its send, a re-run, the S9 census with `--keeper-armed` and
   the keeper pin.

The rehearsal also runs refused cases: a wrong window, a wrong key, a wrong hash, a missing key file, `--mainnet` on a
test validator, a freeze before the date, `arm-keeper` at S7, the keeper key file at S7, and `--arm-keeper` without a
continuous keeper of at least 24 hours. It also checks that every dry run and every refused run left every account
untouched.
