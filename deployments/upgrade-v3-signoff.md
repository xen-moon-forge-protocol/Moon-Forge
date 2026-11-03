# Moon Forge v3 upgrade: sign-off sheet for S6

Status: **DRAFT, 2026-10-23; dates and the IDL order revised 2026-10-24 to the order of 2026-10-23; revised 2026-10-25
for the round-4 defaults; re-synced 2026-10-25 (round 5) with the r4-fix program, its IDL and the upgrade-day tools in
`scripts/upgrade/`; revised 2026-10-26 (round 6) for F1-b, the owner answer of 2026-10-25: the house keeper is not
armed at S7 and no keeper bond is posted**; revised 2026-11-02 for the schedule change (`docs/UPGRADE-2026-11.md`)
(S6 earliest Wednesday 2026-11-18, 16:00-20:00 UTC, moved from 2026-11-11 on 2026-11-02, S7 the same day; the
first v3 epoch is the first Sunday after a green S6; `docs/UPGRADE-2026-11.md` published at least 7 days before S6 and
the binary hash at least 48 hours before it; house games and the Jackpot stay hidden on the site from S7 until a
continuous keeper has met the published service levels for a week, D-39).
Revised 2026-10-31 (round 7): the S0 decisions are recorded on the public decision sheet (no signature), and no token
is revoked at S9. Nothing on this sheet is signed yet. Every `____` is filled in at the stage named beside it.
The binding text is `SPEC-UPGRADE-v2` revision v2.2 (sections 6.3, 8.5-8.7, 9 and 10). This sheet is the operator's checklist
for S6: what is deployed, what it costs, the exact commands, the checks before each step, when to abort, and what is
signed. It holds no secret: keypair files are named by path, and only public keys are written here.

## 1. Program and authorities

| Item | Value | Filled at |
|---|---|---|
| Program id | `57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9` | fixed |
| ProgramData last-deploy slot before S6 | 85,429,880 (re-read at S5; any other value = STOP) | S5 |
| ProgramData data length before S6 | 992,168 B (re-read at S5) | S5 |
| Live executable hash (zero padding stripped) | `7a990932739954802d4df9bc9b284a71e6ab430b123b94d4135f542c71f86a1d` (equal to a fresh build of tag program-2026-10-12 / be03ad8) | measured 2026-10-23 |
| Upgrade authority and IDL authority before S6 | `7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd` (the deploy wallet, also today's architect payee) | S5 |
| On-chain IDL account | `CCt3yKzEbfZ1tV9cBVqsryGGSXGojMCtJZhYKHRfxszP`, 16,258 B (16,214 B usable) | measured 2026-10-23 |
| OD-32 DEPLOY_KEY (new upgrade + IDL authority from S6 to S9), public key | ____ | S0 |
| OD-25 INITIAL_KEEPER, public key (K-4 default of 2026-10-25: today's keeper key, the one in the `KEEPER_PRIVATE_KEY` repository secret; never the oracle, deploy, cold or payee key; a new key only if the S0 decision sheet records one). It is compiled into the S2 binary and is the only key that can create the keeper seat until 2026-12-16 00:00 UTC (from then anyone with a bond of at least 20 XNT may create a never-armed seat), so it is named at S0 even though it is **not armed at S7** (F1-b, owner answer of 2026-10-25): no keeper bond is posted, because while no keeper runs anyone could place house bets that nobody anchors, have each refunded in full and make the bond pay the edge and forfeit the stake, so a posted bond could be drained at no cost. The seat is armed later, by `s7.mjs --arm-keeper` (section 5, "Later"), only once a keeper has run continuously with this key for at least 24 hours, as an always-on loop outside GitHub Actions (SPEC 9.5); house games and the Jackpot stay hidden on the site until that keeper has met the published service levels for a week (D-39). keeper.yml keeps running with this key without a seat (role "no-seat"), so the R-1 hand-over risk of a seat held by keeper.yml does not arise | ____ | S0 |
| OD-16 SEAT_COLD_INITIAL (cold key, kept offline), public key | ____ | S0 |
| OD-20 SEAT_REFUND_INITIAL, public key | ____ | S0 |
| OD-22 architect payee (kept offline), public key | ____ | S0 |

## 2. The binary and the IDL

| Item | Value | Filled at |
|---|---|---|
| Source commit (tag) | ____ | S2 |
| `METADATA_BASE_URI` | `https://turbo-gateway.com/____/` or `https://ar-io.dev/____/` (D-32): the URI on the READY line of `scripts/nft-metadata/check-gateways.mjs`, that is 7 consecutive passing UTC days with 27/27 files served with a matching sha256 on turbo-gateway.com, ar-io.dev and Arweave L1; if both sets are READY, turbo-gateway.com; it must equal that set's `metadataBaseUri` in `deployments/nft-arweave-final.json`. arweave.net cannot be chosen (no set uses it) | S2 |
| `PRICE_LAUNCH_TS` | ____ (= planned S7 + 7 days: 1,795,564,800 = 2026-11-25 00:00 UTC for S7 on 2026-11-18, the schedule of 2026-11-02; it was 1,794,960,000 = 2026-11-18 for S7 on 2026-11-11; the source of 2026-10-31 holds 1,795,478,400 = 2026-11-24, set for the earlier 11-17 window, so change it at S2 unless the amended review source already holds 1,795,564,800) | S2 |
| `bash tests/check-mainnet-guards.sh --final` | ____ (must print "S2 gate OK") | S2 |
| Binary size NEW (bytes) | ____ (last measure: 1,401,200 B on 2026-10-25 with throwaway values, on the round-4 program with the r4-fix, two byte-identical builds by `tests/repro-build.sh`; 1,396,712 B before round 4; real keys and a 43-character Arweave id do not change it, any later program change does) | S2 |
| sha256 of `target/deploy/moon_forge.so`, clean clone 1 | ____ | S2 |
| sha256, clean clone 2 at another path (`bash tests/repro-build.sh`) | ____ (must equal clone 1) | S2 |
| Executable hash (`solana-verify get-executable-hash`, or the zero-stripped sha256 that `tests/repro-build.sh` prints) | ____ | S2 |
| Same hash recorded in SECURITY.md before the deploy (8.7 item 7) | ____ (commit) | S2 |
| IDL file `target/idl/moon_forge.json` (`anchor idl build --no-docs`), sha256 | ____ (candidate: `9617cd5eaf80168026957ae77396fc72497e9c154de2f55432b0f571e793a72f`, the round-4 IDL with the r4-fix, 2026-10-25, byte-identical to both `moon_forge.v3.json` copies and to the s7 spec tables; before round 4 it was `d94c087d…5228349`; an ABI change before the review commit of 2026-10-30 changes it again, and then the kit's `idl.mjs` pin and the spec tables move with it) | S2 |
| IDL compressed size (zlib level 6, what anchor-cli writes) | ____ (candidate `9617cd5e…`: 11,887 B; 11,870 B before round 4; the account holds 16,214 B, so no resize is needed) | S2 |
| `UPGRADED_ELF` pin (R-7): sha256 and byte length of the S2 build in `oracle/src/x1-v3.ts`, in a reviewed commit between the published hash and S7, written by `node scripts/upgrade/pin-elf.mjs --elf target/deploy/moon_forge.so --expect-sha <S2 sha256>` (then the same with `--write`; it refuses a `--features localnet` build); until then a rollback reads as "upgraded" | commit ____ | after S2, before S7 |

## 3. Funding (SPEC 9.3 formulas at the measured size)

The figures use NEW = 1,401,200 B, the mainnet-feature size measured on 2026-10-25 with throwaway values (the round-4
program with the r4-fix) and measured again on 2026-10-26 on the current source (1,401,200 B; the localnet twin
1,401,160 B), and the rent of 6,960 lamports per byte (rent-exempt minimum = (data length + 128) × 6,960 lamports;
1 XNT = 10^9 lamports). Re-compute them with the S2 size. Δ = NEW − 992,168 = 409,032 B.

**F1-b (owner answer of 2026-10-25): no keeper bond at S7.** The `arm_keeper` line of SPEC 9.3 (bond 20 XNT +
HouseKeeper rent 0.0024, from the INITIAL_KEEPER wallet) is not part of the upgrade any more, and neither is the
20.1 XNT that funded it. It is funded only on the later day of `s7.mjs --arm-keeper` (section 5, "Later").

| Item | Arithmetic | Paid by | XNT | Comes back? |
|---|---|---|---|---|
| ProgramData extension | Δ × 6,960 = 409,032 × 6,960 = 2,846,862,720 lamports | deploy wallet | 2.8469 | no |
| Deploy buffer | (NEW + 37 + 128) × 6,960 = 1,401,365 × 6,960 = 9,753,500,400 lamports | deploy wallet | 9.7535 | yes, when the deploy succeeds (or on `solana program close`) |
| Fees and the IDL buffer (the IDL buffer rent is about 0.084) | SPEC 9.3 allowance | deploy wallet | 0.2 | partly |
| `init_seat` bond + OracleSeat rent | max(1 XNT, 10% of the free pool at S7) + (157 + 128) × 6,960 = 1 XNT + 1,983,600 lamports | deploy wallet (or the operator) | 1.0020 if the free pool is below 10 XNT (re-read at S5) | the bond, on a graceful resign to SEAT_REFUND_INITIAL |
| `init_extra` rents | ExtraState (90 + 128) × 6,960 = 1,517,280 + extra_vault (8 + 128) × 6,960 = 946,560 = 2,463,840 lamports | deploy wallet | 0.0025 | no |
| `refresh_collection_uri`, `set_architect`, `lock_collection_royalties` (with the payee top-up to 0.001 XNT) | fees + 1,000,000 lamports at most | deploy wallet | < 0.01 | no |
| **Deploy wallet peak = total peak** | 2.8469 + 9.7535 + 0.2 + 1.0020 + 0.0025 + 0.01 = 13.8149 (the deploy alone: 2.8469 + 9.7535 + 0.2 = 12.8004) | | **≈ 13.81** (≈ 12.80 for the deploy alone) | ≈ 10.75 (9.7535 + the 1-XNT seat bond) |
| `arm_keeper` bond + HouseKeeper rent | not at S7 (F1-b); later: ≥ 20 XNT + (213 + 128) × 6,960 = 2,373,360 lamports, from the INITIAL_KEEPER wallet | — | **0 at S7** (was 20.0024; the total peak was ≈ 33.82) | — |

Fund at least 15 XNT on the deploy wallet before S6 (the ≈ 13.81 peak plus a margin for fees and a retry). The
INITIAL_KEEPER wallet needs only its transaction fees, at least 0.1 XNT (the S5 census default): no keeper bond is
posted at S7. Re-read both balances at S5. Any bankroll seed is separate and never comes from either amount (OD-28): it is
funded only by outside LPs or by project income moved from role to role; until then the house games stay hidden.

The funding needed before S6, line by line, with the balances read on chain on 2026-10-26
(slot 88,705,396: deploy wallet 2.2127 XNT, oracle wallet 0.4904 XNT, INITIAL_KEEPER wallet 0.2000 XNT):

| Line | Arithmetic | XNT |
|---|---|---|
| Deploy wallet, up to ≥ 15 | 15 − 2.2127 | 12.79 |
| INITIAL_KEEPER wallet, fees only (no bond: F1-b) | + 0.1 | 0.10 |
| Proof-plan test wallets | about 18 (about 12 come back) | 18 |
| Oracle wallet | + 1 | 1 |
| Keeper bond (20.1 before F1-b) and bankroll seed (OD-28: only from outside LPs or project income moved from role to role, never from this transfer) | not sent | 0 |
| **Total** | 12.79 + 0.10 + 18 + 1 = 31.89 | **≈ 32** |

The EVM gas for the proof-plan burns is separate and not in this total. The operator re-computes the total the day
before, with the balances of that day and the S2 size. The earlier totals (≈ 55-60 XNT, ≈ 52 and
≈ 90 XNT in earlier plans) included the 20.1 XNT keeper line (52 − 20.1 ≈ 32) and no longer apply.

| Balance check at S5 | Value |
|---|---|
| Deploy wallet `7PuG8…` balance | ____ XNT (≥ 15) |
| INITIAL_KEEPER wallet balance | ____ XNT (≥ 0.1, fees only: no keeper bond at S7, F1-b) |
| Free pool (reward vault − rent − `reward_reserved`), and the resulting seat bond | ____ XNT, bond ____ XNT |

## 4. Gates before S6 (every line must be "yes")

| Gate | Evidence | Yes / no |
|---|---|---|
| Section 10 decisions recorded (S0) | the public decision sheet | ____ |
| `cargo test -p moon-forge --lib` green, incl. the frozen errors 6000-6100 (8.7 item 1) | log ____ | ____ |
| Integration B-1 … B-14 green twice in a row (8.7 item 2) | logs ____ | ____ |
| Stress green for 3 seeds (8.7 item 3) | logs ____ | ____ |
| Upgrade rehearsal 8.5 green with the merged binary, modes a and b (`REHEARSAL_MODE=a|b bash tests/run-upgrade.sh`) | logs ____ | ____ |
| Mainnet-fork rehearsal 8.6 green with the S2 mainnet build (`MAINNET_SO=target/deploy/moon_forge.so bash tests/mainnet-fork.sh`) | log ____ | ____ |
| Reproducible build: two clean clones, same sha256 (8.7 item 7) | section 2 | ____ |
| 8.7 item 6 as changed by the order of 2026-10-23: no v3 epoch can be published before S6 (the oracle refuses a v3 publish on the old binary), so before S6 the dual-mode oracle publishes the 2026-11-15 epoch under v2 and `verify --full` passes on it, and a dry v3 build of the same week (base + extra heartbeat) runs without error. The real base + extra pair is checked at the first v3 epoch, the first Sunday after S6 (2026-11-22 if S6 is 2026-11-18). **accepted by the order of 2026-10-23** | epoch ____ (v2), dry log ____ | ____ |
| New keeper ran ≥ 24 h on mainnet against the old program (S4) | ____ | ____ |
| S5 census at S6 − 30 min: `node scripts/upgrade/census.mjs --stage s5 --keeper-wallet <OD-25> --deploy-at <planned start, ISO UTC> --out census-s5.json` (read-only, never sends; written and rehearsed on localnet on 2026-10-25 by `tests/run-upgrade-tooling.sh`, and run read-only on mainnet the same day, where every program gate was green and only the deploy-wallet balance was short before the funding; the S6, S7 and S9 stages of the same script follow those steps, `scripts/upgrade/README.md`): every in-flight account listed; last-deploy slot 85,429,880; both authorities 7PuG8…; no jackpot round DRAWING; no v1 PredRound within 30 min of 12:00 / 14:00 UTC; any epoch published < 48 h ago noted (its remaining claims wait once); the window refused within 30 min of 12:00 / 14:00 UTC or 6 h of Sunday 00:00 UTC; both balances and the seat bond reported (the INITIAL_KEEPER balance only has to cover its fees, ≥ 0.1 XNT by default: no keeper bond at S7, F1-b) | census file and its sha256 (printed by `--out`) ____ | ____ |
| `docs/UPGRADE-2026-11.md` published with the review commit (tag `upgrade-review-2026-11`, 9d63e9f, 2026-11-02 08:35 UTC; a published tag is never moved) and the amended source (new tag `upgrade-review-2026-11-amended`) at least 7 days before S6 (by Wednesday 2026-11-11 16:00 UTC for 2026-11-18), and the S2 build commit with its hashes published in it at least 48 hours before S6 (by Monday 2026-11-16 16:00 UTC); a later hash moves S6 by a week | commits ____ | ____ |
| Boundary notice and the site release that names the last v2 publish transaction (`V3_BOUNDARY`): Monday 2026-11-16 06:00 UTC, right after the quiet period (2026-11-09 before the schedule change of 2026-11-02). Burns made after the last v2 publish wait for the first v3 epoch; the site's Forge holds new burns from 00:00 UTC of the boundary date until that release, and the notice says so. If S6 slips, the oracle publishes no v2 epoch with those burns: they wait for the first v3 epoch (C-14) | notice commit ____ | ____ |
| Window (order of 2026-10-23, moved by the schedule change of 2026-11-02): Wednesday 2026-11-18 at the earliest, 16:00-20:00 UTC, once S1-S5 are green; if a gate is not green (for example the 7-day metadata gateway check is not READY by the S2 deadline, Monday 2026-11-16 16:00 UTC), S2 and S6 move to the next Wednesday, 2026-11-25, same hours, and every later date moves by a week; never within ±6 h of Sunday 00:00 UTC, within 30 min of 12:00 / 14:00 UTC, or between an epoch build and its publish | start time ____ UTC | ____ |

## 5. S6 commands (one session)

Shell variables for the session (the paths are examples; no key material is written into any file of the repo):

```bash
RPC=https://rpc.mainnet.x1.xyz
PROGRAM=57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9
WALLET=~/.config/solana/deploy-wallet.json   # 7PuG8…, the current upgrade + IDL authority
SO=target/deploy/moon_forge.so               # the S2 binary, built from the S2 tag
S2_SHA=____                                  # section 2
NEW=$(stat -c %s "$SO")                      # must equal section 2
DEPLOY_KEY=____                              # OD-32 public key (section 1)
DEPLOY_KEY_FILE=____                         # a copy of the deploy key file in RAM only (/dev/shm in WSL), made from its offline copy for steps 9-10; never on a disk
```

| # | Command | Check before the step | Check after the step |
|---|---|---|---|
| 0 | `sha256sum "$SO"`; `solana program show "$PROGRAM" -u "$RPC"`; `solana balance -k "$WALLET" -u "$RPC"` | the operator reads the repository variable `KEEPER_ENABLED` through the API with the project token (Variables read and write), so step 4 can switch it; no GitHub web step at S6 or S7 | sha256 = `$S2_SHA`; size = NEW; last-deploy slot 85,429,880; authority 7PuG8…; data length 992,168; balance ≥ 15 XNT |
| 1 | `solana program extend "$PROGRAM" $((NEW-992168)) -k "$WALLET" -u "$RPC"` | step 0 all yes | `solana program show` data length = NEW. The extension is permanent but harmless: the old code keeps running |
| 2 | `solana-keygen new --no-bip39-passphrase -o /tmp/buf.json` then `solana program write-buffer "$SO" --buffer /tmp/buf.json --buffer-authority "$WALLET" -k "$WALLET" -u "$RPC"` | step 1 done | the buffer address is printed: `BUF=<address>` |
| 3 | `solana program dump "$BUF" /tmp/buf.so -u "$RPC"`; `head -c "$NEW" /tmp/buf.so \| sha256sum`; `tail -c +$((NEW+1)) /tmp/buf.so \| tr -d '\0' \| wc -c` | | the sha256 = `$S2_SHA` and the remainder count is 0. Any mismatch: ABORT (section 6) |
| 4 | `solana program deploy --buffer "$BUF" --program-id "$PROGRAM" --upgrade-authority "$WALLET" -k "$WALLET" -u "$RPC"` | steps 0-3 all yes; the S5 census is < 30 min old; no jackpot round DRAWING right now; the repository variable `KEEPER_ENABLED` is off for the deploy minutes (set by the operator through the API with the project token, which has Variables write; no GitHub web session at S6) and no keeper run is in progress | a signature is printed; the buffer rent is back on the wallet |
| 5 | `solana program show "$PROGRAM" -u "$RPC"`; `solana program dump "$PROGRAM" /tmp/live.so -u "$RPC"`; `head -c "$NEW" /tmp/live.so \| sha256sum`; `solana-verify get-program-hash -u "$RPC" "$PROGRAM"` (or the zero-stripped sha256 of /tmp/live.so) | | a new last-deploy slot; sha256 = `$S2_SHA`; executable hash = section 2. A mismatch: STOP, nothing else runs (section 6) |
| 6 | Wait ≥ 1 slot. Simulations of SPEC 6.3 step 1: `init_seat` (not custom error 101), `create_war` (SealedJoinRequired), `place_bet` (KeeperRequired) | step 5 all yes | the three expected answers |
| 7 | `anchor idl upgrade --filepath target/idl/moon_forge.json "$PROGRAM" --provider.cluster "$RPC" --provider.wallet "$WALLET"` then `anchor idl fetch "$PROGRAM" --provider.cluster "$RPC" > /tmp/idl.json` | the IDL file sha256 = section 2 | `/tmp/idl.json` equals the file as JSON (the rehearsal compares them the same way) |
| 8 | `anchor idl set-authority --program-id "$PROGRAM" --new-authority "$DEPLOY_KEY" --provider.cluster "$RPC" --provider.wallet "$WALLET"`; `anchor idl authority "$PROGRAM" --provider.cluster "$RPC"` | step 7 green | the IDL authority = `$DEPLOY_KEY` |
| 9 | `solana program set-upgrade-authority "$PROGRAM" --upgrade-authority "$WALLET" --new-upgrade-authority "$DEPLOY_KEY_FILE" -u "$RPC"` (the new key signs, so a typo cannot hand the program to an unknown key; never use `--skip-new-upgrade-authority-signer-check`) | steps 5-8 green | `solana program show`: authority = `$DEPLOY_KEY` |
| 10 | Delete the session copy of the deploy key file (`rm -f "$DEPLOY_KEY_FILE"`; it lived in /dev/shm, so it never reached a disk). `solana program show "$PROGRAM" -u "$RPC"`; `anchor idl authority "$PROGRAM" --provider.cluster "$RPC"` | | both authorities = `$DEPLOY_KEY`; the hot wallet 7PuG8… holds no upgrade or IDL power from here to S9 (it stays the architect payee until `set_architect` runs at S7) |
| 11 | Update `health-pins.json` (the expected upgrade and IDL authority = `$DEPLOY_KEY`) with `node scripts/upgrade/pins.mjs --stage s6 --deploy-key "$DEPLOY_KEY"`, then the same with `--write`, in the same session and a reviewed commit; then `node scripts/upgrade/census.mjs --stage s6 --deploy-key "$DEPLOY_KEY" --keeper-wallet <OD-25> --seat-cold <OD-16> --expect-deploy-slot <new slot>` | step 10 green | the next health run shows the pin rows OK, so the stable-days streak does not restart |

Then S7 starts, the same day (operator; SPEC 6.3 steps 3-10 in that order except step 8, `arm_keeper`, which F1-b
moves to a later day; the IDL upgrade being already done at
step 7 above: `refresh_collection_uri`, `set_architect` with both
signatures, `lock_collection_royalties` by the OD-22 payee (the client refuses unless `config.architect` equals the
OD-22 key of section 1), `init_seat`, `init_extra` before any forge is announced, releases, announcement; **no
`arm_keeper` and no `take_keeper`: the house keeper is not armed at S7 and no keeper bond is posted**, F1-b, owner answer
of 2026-10-25). **S7 needs two signatures:** `set_architect` is signed by the deploy
wallet 7PuG8… and the new OD-22 payee together, and `lock_collection_royalties` by the OD-22 payee; the payee key file is
copied from its offline copy for these two transactions only. The S7 mainnet client is `scripts/upgrade/s7.mjs`:
SPEC 6.3 steps 3-7, one transaction each (`refresh_collection_uri`; `set_architect`; `lock_collection_royalties`, which
also tops the payee up to 0.001 XNT from the deploy wallet, because Metaplex Core charges the collection's rent
difference to the payee; `init_seat`; `init_extra`, whose transaction and block time it prints as the OD-9 boundary),
then the health pins. By default it sends no `arm_keeper` and no `take_keeper`: `--steps arm-keeper` and the keeper key
file are refused at S7, and `--keeper <OD-25>` is only checked against the key compiled into the deployed binary. With
it: `scripts/upgrade/census.mjs` (the S5, S6, S7 and S9 censuses; at S7 and S9 it expects NO HouseKeeper),
`scripts/upgrade/pins.mjs` (the health pins at S6 step 11, S7 and S9; the keeper pin stays unpinned),
`scripts/upgrade/pin-elf.mjs` (the `UPGRADED_ELF` pin, section 2) and `scripts/upgrade/s9.mjs` (the freeze: one
transaction that erases the IDL authority and removes the upgrade authority, so both go together or neither does).
Each is a dry run by default, sends only with `--send` (and `--mainnet` on X1 mainnet), refuses any key file whose
public key differs from section 1, and skips a step already done, so a re-run resumes. All of them were rehearsed on
localnet with the upgrade-day key layout (the DEPLOY_KEY and the payee fresh keys in a separate key folder, the payee at
0 XNT): `tests/run-upgrade-tooling.sh`, 64 checks green twice on 2026-10-25 with the arm at S7, and again in round 6
(2026-10-26) with the F1-b steps and the later arm after the freeze (section 8). The command of each stage is in
`scripts/upgrade/README.md`. S7 command: `node scripts/upgrade/s7.mjs --payee <OD-22> --keeper <OD-25> --seat-cold
<OD-16> --seat-refund <OD-20> --deploy-key <OD-32> --metadata-base <METADATA_BASE_URI>` (dry run), then the same with
`--deploy-wallet-key <file> --payee-key <file> --send --mainnet`.

S7 also, in this order after the transactions: `health-pins.json` moved to the new architect payee and the seat keys;
the keeper pin stays unpinned, because no HouseKeeper exists (reviewed commit, same session); `node
scripts/upgrade/census.mjs --stage s7 ...` green, with its "HouseKeeper not armed (F1-b)" row; `npm run keeper -- --once`
reports the role "no-seat"; `KEEPER_ENABLED` back on (set by the operator through the API with the project token, as at step 4); the site constants `S7_PROGRAM_TAG` and `S7_VALID_FROM` set, and
the prerendered pages, `llms.txt`, `llms-full.txt`, the JSON-LD and the agent card regenerated (`V3_BOUNDARY` was set at
the boundary release). **House games and the Jackpot stay hidden on the site from S7 (D-39, F1-b):** Coin Flip,
High-Low, Void Rush and the Jackpot are listed on the site only after a continuous keeper has met the published service
levels (anchors within 150 slots, reveals within 10 minutes, SPEC 9.5) for a week, in a site release
(`KEEPER_SLA_MET`). Why: until a keeper runs continuously, a posted bond could be drained at no cost (house bets that
nobody anchors are refunded in full, and the bond pays the edge and forfeits the stake), so no bond is posted, and
without a keeper seat the program takes no house bet and a Jackpot round that ends refunds every entry. The exits of
bets and entries already made stay available.

**Later (not part of the upgrade, and not before a keeper runs continuously): arming the house keeper.** On the day a
keeper has run continuously for at least 24 hours with the INITIAL_KEEPER key, as an always-on loop outside GitHub
Actions (SPEC 9.5; the S4 gate of a new keeper), and only then:
0. check first that the live site still gates the Jackpot on `KEEPER_SLA_MET` as well as on the bond (fixed in round 6:
   `frontend/src/v3/keeper.ts` `jackpotOffered` needs both, and `KEEPER_SLA_MET` is false until the release that ends
   the service-level week; at S7 it is hidden anyway, because no seat exists);
1. fund the INITIAL_KEEPER wallet with the bond (at least 20 XNT) + 0.1 XNT for the seat rent and fees, from project
   wallets only (the architect payee's income or the deploy wallet's O-10 reserve, moved from role to role in public):
   no owner money goes into the project after the single funding before S6, and none is planned for this; if project
   wallets do not hold it, the keeper is not armed and house games and the Jackpot stay hidden on the site (BOND-GRIEF,
   disclosed);
2. `node scripts/upgrade/s7.mjs --arm-keeper --payee <OD-22> --keeper <OD-25> --continuous-keeper-since <its start, ISO UTC> --keeper-key <file>`
   (dry run; it refuses a start less than 24 hours before the chain time, any other key file, and the S7 steps), then
   the same with `--send --mainnet`: `arm_keeper` through the oracle's own `keeper-arm`, then the keeper pin
   (`pins.mjs --stage keeper`, reviewed commit). `arm_keeper` needs no upgrade authority, so this works before or after S9;
3. `node scripts/upgrade/census.mjs --stage s7|s9 ... --keeper-armed` green, and `npm run keeper -- --once` on that
   keeper reports the role "holder" (R-4);
4. the service-level week starts at the arm (the script prints its earliest end). The site lists house games and the
   Jackpot only after 7 days of the published service levels, by a release that sets `KEEPER_SLA_MET` and is announced.

Order of the IDL upgrade (order of 2026-10-23). SPEC 6.3 listed `anchor idl upgrade` as S7 step 2, signed by the
DEPLOY_KEY after the authority move, while SPEC 9.1 says the owner signs nothing at S7. The order of 2026-10-23
settles it: the IDL upgrade runs in the S6 session, at step 7, still under 7PuG8…, before the authorities move (steps
8-9). The DEPLOY_KEY is then needed only once at S6 (step 9) and once at S9. This is recorded on the S0 decision
sheet (row "OD-32 (order)").

## 6. Abort and rollback rules

- **Before step 4 (the deploy)**, any failed check means ABORT. Run `solana program show --buffers -k "$WALLET" -u "$RPC"`
  and then `solana program close "$BUF" -k "$WALLET" -u "$RPC"`, which returns about 9.75 XNT. The program is unchanged.
  The extension of step 1 stays and costs nothing more. Retry another day from step 0.
- **Step 4 fails** (the transaction errors or times out): the program is unchanged until the deploy succeeds. Check with
  `solana program show`: if the last-deploy slot is still 85,429,880, close the buffer as above. Never deploy twice
  without that check.
- **Step 5 hash mismatch** (the live bytes are not the S2 binary): STOP. Do not run steps 6-10 or S7. The authority is
  still 7PuG8…, so a corrected deploy from a fresh buffer is possible after diagnosis.
- **Steps 6-8 show a defect**: do not move the authorities yet. Keep the site paused (house games closed, no forge
  announced) and decide between a fix-forward (back to S1, a corrective upgrade with the full rehearsal) and an
  emergency rollback.
- **Step 7 refused with RequireGteViolated** (custom error 0x9ca: the compressed IDL is larger than the 16,214 B the
  account holds; the S2 IDL should be about 11.9 KB, so this is not expected): the on-chain IDL is unchanged. Run
  `anchor idl close "$PROGRAM"` and then `anchor idl init --filepath target/idl/moon_forge.json "$PROGRAM"`, both with
  `--provider.cluster "$RPC" --provider.wallet "$WALLET"` and before step 8. The account is re-created at the same
  address with twice the compressed size (about 0.17 XNT rent for 12 KB). Then fetch and compare again. anchor-cli
  0.32.1 has no resize command, and the program's IdlInstruction::Resize only works on an empty IDL account.
- **Emergency rollback** (before S7 step 6): redeploy the dumped live ELF (zero-stripped sha256
  `7a990932…86a1d`) through a fresh buffer. This is possible because no account changed size or field order; v3-only
  PDAs created meanwhile are left unused. After `init_seat` / `init_extra`, fix-forward only (no `arm_keeper` runs at
  S7: F1-b).
- **Account state is never rolled back.** After S9 (`--final`, `erase-authority`) nothing can be changed.
- Any step not listed here, any unexpected prompt, or a balance below section 3: ABORT before step 4, and after step 4
  STOP before the next step.

## 7. What is signed

Each item is recorded with its date and UTC time:

1. **S0**: the section 10 decisions of SPEC-UPGRADE-v2 (the default or the chosen alternative for each OD), the public
   keys of section 1 and the funding of section 3 are recorded on the public decision sheet (no signature).
2. **S6**, before step 4: the sha256 and the executable hash of section 2 and the IDL sha256. The hashes are signed
   with the DEPLOY_KEY as an off-chain message, which proves that the signer holds that key:
   `solana sign-offchain-message -k "$DEPLOY_KEY_FILE" "Moon Forge v3 S6: binary sha256 <S2_SHA>, executable hash <HASH>, IDL sha256 <IDL_SHA>"`.
   The signature goes in the table below and in SECURITY.md.
3. **S6**, after step 10: that both authorities are the DEPLOY_KEY and that the deploy matched the hashes.
4. **S9** (the third signature): the freeze, on its own sheet. The order after the freeze transaction: publish first (the
   signatures and the hashes in SECURITY.md, IMMUTABILITY.md, README.md, `llms.txt` / `llms-full.txt` and the agent
   card); then delete the repository variable `PAT_EXPIRES` through the API, so the health check shows no lasting warning
   about the token. No token is revoked at S9: the push token is no longer used and expires by itself 90 days after
   its creation; the sealed emergency token stays sealed.

| Signature | Text signed | Signature / commit | Date (UTC) |
|---|---|---|---|
| S0 decisions (public decision sheet) | section 10 table + sections 1 and 3 | ____ | ____ |
| S6 hashes (DEPLOY_KEY off-chain message) | the line of item 2 | ____ | ____ |
| S6 completed | "deployed `<S2_SHA>`, last-deploy slot ____, authorities = DEPLOY_KEY" | ____ | ____ |

## 8. Rehearsal evidence available on 2026-10-23 (local only, nothing sent to mainnet)

| Rehearsal | Binary | Result |
|---|---|---|
| 8.6 mainnet fork (`tests/mainnet-fork.sh`) | throwaway-value MAINNET build, 1,395,600 B, sha256 `681a7ff9…1c5a` (fresh keys for that run, never deployable) | green: 12/12 cloned mainnet accounts byte-identical before and after; `init_seat` simulated (not 101); `create_war` SealedJoinRequired; `place_bet` KeeperRequired; `expire_epoch(1)` ClaimWindowOpen; `void_epoch(1)` HoldOver; S7 steps sent or simulated; four new PDAs present |
| 8.5 upgrade (`tests/run-upgrade.sh`), mode a | be03ad8 `--features localnet` twin (the be03ad8 mainnet build matches the live ELF, `7a990932…86a1d`), upgraded in place to the merged localnet build (1,395,560 B, sha256 `84d24682…ac06`) | green: 65 checks + deploy bytes + IDL steps, 355 s. Every Phase-A account kind exits as SPEC 6.1 says; the hold epoch is voided inside its hold in the first post-upgrade transaction |
| 8.5 upgrade, mode b | same | green: 62 checks + deploy bytes + IDL steps, 553 s. An old-style DRAWING jackpot settles through the legacy `settle_jackpot`; the hold epoch gets ClaimOnHold, then pays |
| IDL steps (both modes) | merged IDL `ffb85076…3789` (2026-10-23; mode a re-run green on 2026-10-25 with `d94c087d…`, 65 checks) | `anchor idl upgrade` + fetch = the file (compared as key-sorted JSON). An IDL larger than the account is REFUSED by `anchor idl upgrade` (RequireGteViolated); the working resize path is `anchor idl close` + `anchor idl init`. Mode a green again on 2026-10-25 with the round-4 IDL `9617cd5e…` (r4-confirm, 65 checks); mode b not yet re-run with it |
| Upgrade-day tools (`tests/run-upgrade-tooling.sh`, 2026-10-25, before F1-b: `arm_keeper` was still an S7 step) | the round-4 localnet build, 1,400,632 B, sha256 `2d17a98f…00aa`, IDL `9617cd5e…` | green twice, 64 ok and 0 failed: the S5 census on the old binary, S6 by this sheet's commands, `pin-elf`, `pins` and the S6 census, the S7 dry runs and send, a re-run that skips all six steps, the S7 census, the S9 dry run, send and census, and the DEPLOY_KEY refused after the freeze; every refused case and every dry run left the accounts byte-identical |
| Upgrade-day tools with F1-b (round 6, 2026-10-26: the F1-b version of `tests/run-upgrade-tooling.sh`) | the round-4 localnet build, 1,401,160 B, sha256 `bb3ef795…585d`, IDL `9617cd5e…` | green: 107 ok and 0 failed (481 s). S7 sends no `arm_keeper` (refused with `--steps arm-keeper` and with the keeper key file), the re-run skips all five steps, no HouseKeeper after S7, the keeper pin stays unpinned, the S7 and S9 censuses expect no HouseKeeper (`--keeper-armed` red); after the freeze the later `s7.mjs --arm-keeper` refuses a continuous keeper younger than 24 h, a non-UTC time, the deploy-wallet key file, another keeper key and a send without the key file, its dry runs change no account, its send arms the seat through the oracle's `keeper-arm` (bond 20 XNT), its re-run reports done, then the S9 census with `--keeper-armed` is green and without it red. An earlier run the same day (101 ok, 5 failed) lost only the oracle's own 30-s confirmation of the arm on a loaded host; the arm had landed, and the re-run reported it done and wrote the keeper pin |
| Reproducible build, round 4 + r4-fix (`tests/repro-build.sh`, 2026-10-25, r4-confirm) | two copies at different paths, mainnet feature set, throwaway values | byte-identical: 1,401,200 B, sha256 `4f5d6c2b…`; Cargo.lock unchanged. Not the S2 hash |
| Reproducible build (`tests/repro-build.sh`) | two copies at different paths, mainnet feature set, the same throwaway values in both | byte-identical: 1,395,600 B, sha256 `c2169723…4911`, executable hash `2b77217f…fa88` (equal to `solana-verify get-executable-hash`, v0.5.2). Not the S2 hash: re-run at S2 with the real values. `cargo build-sbf` rewrites Cargo.lock (one dependency edge): commit the rewritten lock before S2 |
