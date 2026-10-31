#!/usr/bin/env bash
# Rehearsal of the upgrade-day tools (scripts/upgrade/: census.mjs, pins.mjs, pin-elf.mjs, s7.mjs, s9.mjs) on a local
# validator, on the tests/run-upgrade.sh path: the OLD binary (be03ad8 --features localnet twin) runs first as an
# upgradeable program whose upgrade authority is the deploy wallet's twin (tests/fixtures/test-architect.json, also the
# localnet Config.architect and the IDL authority, as 7PuG8… is on mainnet); then S5 census, S6 by the CLI commands of
# deployments/upgrade-v3-signoff.md section 5 (extend, write-buffer, byte check, deploy, IDL upgrade, both authorities
# to the DEPLOY_KEY), the pin helper, S6 / S7 census, S7 first run, S9 freeze, then the LATER house-keeper arm after the
# freeze. Key layout as on upgrade day: the DEPLOY_KEY and the payee are fresh keys on an "offline medium" directory, passed
# by path; the INITIAL_KEEPER is the localnet's compiled-in test keeper; the payee holds no lamports. Every dry run is
# checked to leave every account untouched. F1-b (owner answer of 2026-10-25): S7 does not arm the house keeper and posts no
# keeper bond; the S7 and S9 censuses expect no HouseKeeper; `s7.mjs --arm-keeper` (the later day, after the freeze here) arms
# it through the oracle's keeper-arm, and the S9 census with --keeper-armed checks it.
# Usage: bash tests/run-upgrade-tooling.sh   (needs target/deploy/moon_forge_localnet.so + target/idl/moon_forge.json from
#        tests/run-local.sh, or NEW_SO / NEW_IDL; the old binary from OLD_SO, OLD_SRC_TAR or `git archive $OLD_REF`)
# Env: TOOLING_DIR (default /tmp/moonforge-tooling), TOOLING_LOGS (default $TOOLING_DIR/logs), MPL_CORE_SO.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
PROGRAM=57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9
CORE=CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d
OBS=4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ
ERASED=11111111111111111111111111111111
OLD_REF="${OLD_REF:-be03ad8}"
NEW_SO="${NEW_SO:-target/deploy/moon_forge_localnet.so}"
NEW_IDL="${NEW_IDL:-target/idl/moon_forge.json}"
WORK="${TOOLING_DIR:-/tmp/moonforge-tooling}"
LOG="${TOOLING_LOGS:-$WORK/logs}"
OLD_TARGET="${OLD_TARGET:-$HOME/.cache/mf-old-target}"
LOCAL=http://127.0.0.1:8899
U="node scripts/upgrade"

if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE ':(8899|9900) '; then echo "a validator is already listening on 8899/9900: stop it first" >&2; exit 1; fi
[ -f "$NEW_SO" ] || { echo "no localnet binary at $NEW_SO (tests/run-local.sh)" >&2; exit 1; }
[ -f "$NEW_IDL" ] || { echo "no $NEW_IDL (anchor idl build --no-docs)" >&2; exit 1; }
cmp -s <(node -e 'const s=(x)=>Array.isArray(x)?x.map(s):x&&typeof x==="object"?Object.fromEntries(Object.keys(x).sort().map(k=>[k,s(x[k])])):x;process.stdout.write(JSON.stringify(s(require(process.argv[1]))))' "$ROOT/$NEW_IDL") \
          <(node -e 'const s=(x)=>Array.isArray(x)?x.map(s):x&&typeof x==="object"?Object.fromEntries(Object.keys(x).sort().map(k=>[k,s(x[k])])):x;process.stdout.write(JSON.stringify(s(require(process.argv[1]))))' "$ROOT/oracle/src/idl/moon_forge.v3.json") \
  || { echo "$NEW_IDL is not oracle/src/idl/moon_forge.v3.json: rebuild or regenerate first" >&2; exit 1; }
(cd tests && [ -d node_modules ] || npm install --no-audit --no-fund)
(cd oracle && [ -d node_modules ] || npm ci --ignore-scripts --no-audit --no-fund)
rm -rf "$WORK/ledger" "$WORK/usb" "$WORK/run"; mkdir -p "$WORK/usb" "$WORK/run" "$LOG"
CORE_SO="${MPL_CORE_SO:-tests/fixtures/mpl_core.so}"
[ -f "$CORE_SO" ] || { CORE_SO="$WORK/mpl_core.so"; [ -f "$CORE_SO" ] || solana program dump -u https://rpc.mainnet.x1.xyz "$CORE" "$CORE_SO" >/dev/null; }

PASS=0; FAILN=0
# expect <exit code> <name> <log> <command...>: runs the command, logs its output, counts the result
expect() {
  local want=$1 name=$2 log=$3; shift 3
  set +e; "$@" >"$LOG/$log" 2>&1; local rc=$?; set -e
  if [ "$rc" = "$want" ]; then PASS=$((PASS+1)); echo "  ok   $name (exit $rc) [$log]"
  else FAILN=$((FAILN+1)); echo "  FAIL $name: exit $rc, expected $want [$log]"; tail -20 "$LOG/$log" | sed 's/^/       | /'; fi
}
# has <name> <log> <extended regex>: the log contains the pattern
has() {
  if grep -qE -- "$3" "$LOG/$2"; then PASS=$((PASS+1)); echo "  ok   $1"; else FAILN=$((FAILN+1)); echo "  FAIL $1: /$3/ not in $2"; fi
}
same() { expect 0 "$1" "$2" node tests/upgrade-tooling-rehearsal.mjs same "$3" "$4"; }
snap() { node tests/upgrade-tooling-rehearsal.mjs snapshot "$LOCAL" "$1" >/dev/null; }

# --- old binary ---------------------------------------------------------------------------------------------------
if [ -n "${OLD_SO:-}" ]; then cp "$OLD_SO" "$WORK/old.so"
else
  SRC="$WORK/old-src"; rm -rf "$SRC"; mkdir -p "$SRC"
  if [ -n "${OLD_SRC_TAR:-}" ]; then tar -xf "$OLD_SRC_TAR" -C "$SRC"; else git archive "$OLD_REF" Cargo.toml Cargo.lock programs tests/fixtures/make-observation.cjs | tar -x -C "$SRC"; fi
  (cd "$SRC" && CARGO_TARGET_DIR="$OLD_TARGET" cargo build-sbf --manifest-path programs/moon-forge/Cargo.toml --features localnet --sbf-out-dir "$WORK/old-localnet") >"$LOG/old-build.log" 2>&1
  cp "$WORK/old-localnet/moon_forge.so" "$WORK/old.so"
fi
node tests/fork-rehearsal.mjs guard "$WORK/old.so" >/dev/null 2>&1 && { echo "old.so carries mainnet keys: the rehearsal needs the --features localnet twin" >&2; exit 1; }
echo "old.so $(stat -c %s "$WORK/old.so") B, new $(stat -c %s "$NEW_SO") B sha256 $(sha256sum "$NEW_SO" | cut -d' ' -f1)"

# --- keys: the deploy wallet twin, the offline medium (DEPLOY_KEY, payee), the compiled-in keeper and seat keys ------
ARCH=tests/fixtures/test-architect.json; ARCH_PUB=$(solana-keygen pubkey "$ARCH")
KEEPER=tests/fixtures/test-keeper.json; KEEPER_PUB=$(solana-keygen pubkey "$KEEPER")
COLD_PUB=$(solana-keygen pubkey tests/fixtures/test-cold.json)
DK="$WORK/usb/deploy-key.json"; PAYEE="$WORK/usb/payee.json"
solana-keygen new --no-bip39-passphrase --silent --force -o "$DK"; solana-keygen new --no-bip39-passphrase --silent --force -o "$PAYEE"
DK_PUB=$(solana-keygen pubkey "$DK"); PAYEE_PUB=$(solana-keygen pubkey "$PAYEE")
echo "keys: deploy wallet $ARCH_PUB, DEPLOY_KEY $DK_PUB, payee $PAYEE_PUB, INITIAL_KEEPER $KEEPER_PUB, seat cold $COLD_PUB, seat refund $ERASED (the pool)"

# --- validator with the old binary ----------------------------------------------------------------------------------
mkdir -p "$WORK/obs"; cp tests/fixtures/make-observation.cjs "$WORK/obs/"; [ -f "$WORK/old-src/tests/fixtures/make-observation.cjs" ] && cp "$WORK/old-src/tests/fixtures/make-observation.cjs" "$WORK/obs/"
node "$WORK/obs/make-observation.cjs" >/dev/null
solana-test-validator --reset --quiet --ledger "$WORK/ledger" \
  --upgradeable-program "$PROGRAM" "$WORK/old.so" "$ARCH" \
  --bpf-program "$CORE" "$CORE_SO" \
  --account "$OBS" "$WORK/obs/xdex-observation.json" &
VALIDATOR=$!
trap 'kill $VALIDATOR 2>/dev/null || true; wait $VALIDATOR 2>/dev/null || true; rm -rf "$WORK/ledger"' EXIT
until solana -u "$LOCAL" cluster-version >/dev/null 2>&1; do sleep 1; done
START=$(date +%s)
for k in "$ARCH:100" "$KEEPER:25" "$DK:1"; do solana -u "$LOCAL" airdrop "${k##*:}" "${k%:*}" >/dev/null; done
ANCHOR_ARCH=(--provider.cluster "$LOCAL" --provider.wallet "$ARCH")
anchor idl init "${ANCHOR_ARCH[@]}" --filepath tests/fixtures/idl-onchain-v2.json "$PROGRAM" >"$LOG/idl-init-old.log" 2>&1
node tests/upgrade-tooling-rehearsal.mjs setup "$LOCAL" "$ARCH" | tee "$LOG/setup.log"
OLD_LEN=$(solana program show -u "$LOCAL" "$PROGRAM" --output json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).dataLen))')
OLD_SLOT=$(solana program show -u "$LOCAL" "$PROGRAM" --output json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).lastDeploySlot))')
echo "old binary: data length $OLD_LEN B, last-deploy slot $OLD_SLOT (the localnet twin of 992,168 B / 85,429,880)"

# --- S5: census on the old binary -----------------------------------------------------------------------------------
echo "S5 census"
C5=(--rpc "$LOCAL" --stage s5 --expect-deploy-slot "$OLD_SLOT" --expect-data-len "$OLD_LEN" --deploy-wallet "$ARCH_PUB" --keeper-wallet "$KEEPER_PUB" --deploy-at 2026-11-11T16:00:00Z)
expect 0 "census s5 green on the old binary" census-s5.log $U/census.mjs "${C5[@]}" --out "$WORK/run/census-s5.json"
has "census s5 lists the pending legacy bet" census-s5.log 'legacy bet of'
has "census s5 lists the OPEN Jackpot round" census-s5.log 'round [0-9]+: OPEN'
has "census s5 lists the OPEN war and the LP withdrawal request" census-s5.log 'withdrawal of [0-9]+ unlocking'
has "census s5: init_seat unknown to the old binary (programRules 2)" census-s5.log 'ok   init_seat on the live binary: InstructionFallbackNotFound'
has "census s5: the seat bond is 10% of the free pool (above the 1-XNT floor)" census-s5.log 'init_seat bond now ([2-9]|[1-9][0-9])\.[0-9]+ XNT = max'
expect 1 "census s5 refuses a window touching 12:00 UTC" census-s5-noon.log $U/census.mjs "${C5[@]/2026-11-11T16:00:00Z/2026-11-11T11:50:00Z}"
expect 1 "census s5 refuses a window within 6 h of Sunday 00:00 UTC" census-s5-sunday.log $U/census.mjs "${C5[@]/2026-11-11T16:00:00Z/2026-11-15T03:00:00Z}"
expect 1 "census s5 refuses another upgrade authority" census-s5-auth.log $U/census.mjs "${C5[@]/$ARCH_PUB/$PAYEE_PUB}"
expect 1 "census s5 refuses a short INITIAL_KEEPER balance" census-s5-keeper.log $U/census.mjs "${C5[@]}" --min-keeper 30
has "census s5: the INITIAL_KEEPER needs only its fees (default 0.1 XNT, F1-b)" census-s5.log 'ok   INITIAL_KEEPER balance: [1-9A-HJ-NP-Za-km-z]+: [0-9.]+ XNT >= 0\.100000000 XNT'
snap "$WORK/run/snap-s5.json"
S7=(--rpc "$LOCAL" --deploy-wallet "$ARCH_PUB" --payee "$PAYEE_PUB" --keeper "$KEEPER_PUB" --seat-cold "$COLD_PUB" --seat-refund "$ERASED" --deploy-key "$DK_PUB" --elf "$NEW_SO" --legacy-deploy-slot "$OLD_SLOT" --metadata-base https://arweave.net/ARWEAVE_MANIFEST_ID_TBD/ --pins "$WORK/run/health-pins.json" --localnet-oracle)
cp oracle/src/health-pins.json "$WORK/run/health-pins.json"
expect 3 "s7 refuses on the old binary (preflight), sends nothing" s7-before-s6.log $U/s7.mjs "${S7[@]}" --deploy-wallet-key "$ARCH" --payee-key "$PAYEE" --send
has "s7 on the old binary: refused by the preflight" s7-before-s6.log 'S6 has not landed'
snap "$WORK/run/snap-s5b.json"; same "nothing changed by the refused s7" same-s5.log "$WORK/run/snap-s5.json" "$WORK/run/snap-s5b.json"

# --- S6: the sign-off sheet's commands, steps 1-10 ------------------------------------------------------------------
echo "S6 (sign-off section 5 commands)"
NEW=$(stat -c %s "$NEW_SO"); S2_SHA=$(sha256sum "$NEW_SO" | cut -d' ' -f1)
run1() { echo "+ $*"; "$@" || { echo "FAILED: $*"; return 1; }; }
s6_cli() { # each line must succeed; the first failure stops S6 (as the sheet's abort rules say)
  run1 solana program extend "$PROGRAM" $((NEW-OLD_LEN)) -k "$ARCH" -u "$LOCAL" &&
  run1 solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/run/buf.json" &&
  run1 solana program write-buffer "$NEW_SO" --buffer "$WORK/run/buf.json" --buffer-authority "$ARCH" -k "$ARCH" -u "$LOCAL" &&
  BUF=$(solana-keygen pubkey "$WORK/run/buf.json") &&
  run1 solana program dump "$BUF" "$WORK/run/buf.so" -u "$LOCAL" &&
  [ "$(head -c "$NEW" "$WORK/run/buf.so" | sha256sum | cut -d' ' -f1)" = "$S2_SHA" ] && [ "$(tail -c +$((NEW+1)) "$WORK/run/buf.so" | tr -d '\0' | wc -c)" = 0 ] &&
  echo "buffer $BUF = the build byte for byte, zero remainder" &&
  run1 solana program deploy --buffer "$BUF" --program-id "$PROGRAM" --upgrade-authority "$ARCH" -k "$ARCH" -u "$LOCAL" &&
  sleep 2 &&
  run1 solana program dump "$PROGRAM" "$WORK/run/live.so" -u "$LOCAL" &&
  [ "$(head -c "$NEW" "$WORK/run/live.so" | sha256sum | cut -d' ' -f1)" = "$S2_SHA" ] && echo "deployed bytes = the build" &&
  run1 anchor idl upgrade "${ANCHOR_ARCH[@]}" --filepath "$NEW_IDL" "$PROGRAM" &&
  run1 anchor idl set-authority "${ANCHOR_ARCH[@]}" --program-id "$PROGRAM" --new-authority "$DK_PUB" &&
  run1 solana program set-upgrade-authority "$PROGRAM" --upgrade-authority "$ARCH" --new-upgrade-authority "$DK" -u "$LOCAL" &&
  run1 solana program show "$PROGRAM" -u "$LOCAL" &&
  run1 anchor idl authority "${ANCHOR_ARCH[@]}" "$PROGRAM"
}
if s6_cli >"$LOG/s6-cli.log" 2>&1; then PASS=$((PASS+1)); echo "  ok   S6 steps 1-10 by the CLI (extend, buffer byte check, deploy, IDL upgrade, both authorities to the DEPLOY_KEY) [s6-cli.log]"
else FAILN=$((FAILN+1)); echo "  FAIL S6 CLI steps [s6-cli.log]"; tail -20 "$LOG/s6-cli.log"; echo "S6 failed: the rest cannot run" >&2; exit 1; fi
S6_SLOT=$(solana program show -u "$LOCAL" "$PROGRAM" --output json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).lastDeploySlot))')
echo "  S6 deploy slot $S6_SLOT"

# --- the UPGRADED_ELF pin helper (on a copy of oracle/src/x1-v3.ts) -------------------------------------------------
echo "UPGRADED_ELF pin"
cp oracle/src/x1-v3.ts "$WORK/run/x1-v3.ts"
expect 3 "pin-elf refuses a --features localnet build for the real pin" pin-localnet.log $U/pin-elf.mjs --elf "$NEW_SO"
expect 3 "pin-elf refuses a hash that is not the published S2 hash" pin-wrong.log $U/pin-elf.mjs --elf "$NEW_SO" --allow-localnet --expect-sha "$(echo x | sha256sum | cut -d' ' -f1)"
expect 0 "pin-elf dry run: chain = build, prints the line, writes nothing" pin-dry.log $U/pin-elf.mjs --elf "$NEW_SO" --allow-localnet --expect-sha "$S2_SHA" --rpc "$LOCAL" --legacy-deploy-slot "$OLD_SLOT" --file "$WORK/run/x1-v3.ts"
cmp -s oracle/src/x1-v3.ts "$WORK/run/x1-v3.ts" && { PASS=$((PASS+1)); echo "  ok   the dry run left the file unchanged"; } || { FAILN=$((FAILN+1)); echo "  FAIL the dry run changed the file"; }
expect 1 "pin-elf --check before the pin: not pinned" pin-check0.log $U/pin-elf.mjs --elf "$NEW_SO" --allow-localnet --check --file "$WORK/run/x1-v3.ts"
expect 0 "pin-elf --write (the copy)" pin-write.log $U/pin-elf.mjs --elf "$NEW_SO" --allow-localnet --expect-sha "$S2_SHA" --rpc "$LOCAL" --legacy-deploy-slot "$OLD_SLOT" --file "$WORK/run/x1-v3.ts" --write
expect 0 "pin-elf --check after the pin" pin-check1.log $U/pin-elf.mjs --elf "$NEW_SO" --allow-localnet --check --rpc "$LOCAL" --legacy-deploy-slot "$OLD_SLOT" --file "$WORK/run/x1-v3.ts"
[ "$(diff oracle/src/x1-v3.ts "$WORK/run/x1-v3.ts" | grep -c '^[<>]')" = 2 ] && grep -q "UPGRADED_ELF: { sha256: string; bytes: number } | null = { sha256: \"$S2_SHA\", bytes: $NEW };" "$WORK/run/x1-v3.ts" \
  && { PASS=$((PASS+1)); echo "  ok   the pin changed exactly one line, to { sha256: \"$S2_SHA\", bytes: $NEW }"; } || { FAILN=$((FAILN+1)); echo "  FAIL the pinned copy differs by more than the pin line"; }

# --- S6 census, pins ------------------------------------------------------------------------------------------------
echo "S6 census and pins"
CK=(--rpc "$LOCAL" --deploy-wallet "$ARCH_PUB" --keeper-wallet "$KEEPER_PUB" --deploy-key "$DK_PUB" --seat-cold "$COLD_PUB" --seat-refund "$ERASED" --legacy-deploy-slot "$OLD_SLOT" --expect-deploy-slot "$S6_SLOT" --pin-file "$WORK/run/x1-v3.ts")
expect 0 "census s6 green (ELF = the pin, authorities = DEPLOY_KEY, IDL = v3, 6.3 step-1 simulations)" census-s6.log $U/census.mjs --stage s6 "${CK[@]}" --out "$WORK/run/census-s6.json"
has "census s6: create_war SealedJoinRequired, place_bet KeeperRequired" census-s6.log 'ok   place_bet \(SPEC 6.3 step 1\): KeeperRequired'
has "census s6: INITIAL_KEEPER and SEAT_COLD_INITIAL compiled in" census-s6.log 'ok   SEAT_COLD_INITIAL compiled in'
expect 0 "pins s6 dry" pins-s6-dry.log $U/pins.mjs --stage s6 --rpc "$LOCAL" --deploy-key "$DK_PUB" --pins "$WORK/run/health-pins.json"
cmp -s oracle/src/health-pins.json "$WORK/run/health-pins.json" && { PASS=$((PASS+1)); echo "  ok   pins dry run wrote nothing"; } || { FAILN=$((FAILN+1)); echo "  FAIL pins dry run wrote"; }
expect 1 "pins s6 refuses a DEPLOY_KEY the chain does not show" pins-s6-wrong.log $U/pins.mjs --stage s6 --rpc "$LOCAL" --deploy-key "$PAYEE_PUB" --pins "$WORK/run/health-pins.json" --write
expect 0 "pins s6 --write (S6 step 11, on the copy)" pins-s6.log $U/pins.mjs --stage s6 --rpc "$LOCAL" --deploy-key "$DK_PUB" --pins "$WORK/run/health-pins.json" --write

# --- S7 -------------------------------------------------------------------------------------------------------------
echo "S7 first run"
S7+=(--pin-file "$WORK/run/x1-v3.ts")
snap "$WORK/run/snap-s6.json"
expect 0 "s7 dry run (no key files): every step planned and simulated" s7-dry-nokeys.log $U/s7.mjs "${S7[@]}"
expect 0 "s7 dry run with the key files" s7-dry.log $U/s7.mjs "${S7[@]}" --deploy-wallet-key "$ARCH" --payee-key "$PAYEE"
has "s7 dry run simulates lock_collection_royalties together with set_architect" s7-dry.log 'simulated together with: set_architect'
has "s7 dry run prints the seat bond (10% of the free pool)" s7-dry.log '-> bond ([2-9]|[1-9][0-9])\.[0-9]+ XNT = max\(1 XNT, 10% of free\)'
has "s7 dry run: no arm_keeper at S7 (F1-b)" s7-dry.log 'arm-keeper: not at S7 \(F1-b\)'
[ "$(grep -c '== arm_keeper' "$LOG/s7-dry.log")" = 0 ] && { PASS=$((PASS+1)); echo "  ok   s7 dry run plans no arm_keeper"; } || { FAILN=$((FAILN+1)); echo "  FAIL s7 dry run planned arm_keeper"; }
snap "$WORK/run/snap-s6b.json"; same "the s7 dry runs changed no account" same-s6.log "$WORK/run/snap-s6.json" "$WORK/run/snap-s6b.json"
expect 3 "s7 --send refuses set-architect without the payee key file" s7-nopayee.log $U/s7.mjs "${S7[@]}" --deploy-wallet-key "$ARCH" --steps set-architect --send
expect 3 "s7 refuses a payee key file that is not the sign-off payee" s7-wrongpayee.log $U/s7.mjs "${S7[@]}" --deploy-wallet-key "$ARCH" --payee-key "$DK" --send
expect 3 "s7 refuses --mainnet on a local validator" s7-mainnetflag.log $U/s7.mjs "${S7[@]}" --send --mainnet
expect 3 "s7 refuses an S2 hash that is not the deployed ELF" s7-wrongelf.log $U/s7.mjs "${S7[@]/$NEW_SO/$WORK/old.so}" --deploy-wallet-key "$ARCH" --payee-key "$PAYEE" --send
has "s7 wrong ELF: refused by the preflight" s7-wrongelf.log 'STOP, nothing runs'
# F1-b: arm_keeper cannot be reached at S7, and the later flag refuses without its continuous-keeper statement
expect 3 "s7 refuses --steps arm-keeper at S7 (F1-b)" s7-arm-at-s7.log $U/s7.mjs "${S7[@]}" --steps arm-keeper --send
has "s7 --steps arm-keeper: the F1-b refusal" s7-arm-at-s7.log 'NOT armed at S7 \(F1-b'
expect 3 "s7 refuses the keeper key file at S7 (F1-b)" s7-keeperkey-at-s7.log $U/s7.mjs "${S7[@]}" --deploy-wallet-key "$ARCH" --payee-key "$PAYEE" --keeper-key "$KEEPER" --send
expect 3 "s7 --arm-keeper refuses the S7 steps" s7-arm-mixed.log $U/s7.mjs "${S7[@]}" --arm-keeper --continuous-keeper-since 2026-01-01T00:00:00Z --steps init-seat,arm-keeper
expect 3 "s7 --arm-keeper refuses without --continuous-keeper-since" s7-arm-nosince.log $U/s7.mjs "${S7[@]}" --arm-keeper --keeper-key "$KEEPER"
snap "$WORK/run/snap-s6c.json"; same "the refused s7 runs changed no account" same-s6c.log "$WORK/run/snap-s6.json" "$WORK/run/snap-s6c.json"
expect 0 "s7 --send: refresh_collection_uri, set_architect, lock_collection_royalties, init_seat, init_extra, pins (no arm_keeper: F1-b)" s7-send.log $U/s7.mjs "${S7[@]}" --deploy-wallet-key "$ARCH" --payee-key "$PAYEE" --send
has "s7: Config.architect = the payee" s7-send.log "ok   Config.architect = $PAYEE_PUB"
has "s7: Royalties locked to the payee" s7-send.log "ok   Royalties 500 bps, $PAYEE_PUB 100%, rule set None, plugin authority None"
has "s7: the seat carries the compiled cold key" s7-send.log "ok   OracleSeat generation 1, cold $COLD_PUB"
has "s7: the init_extra block time is printed (OD-9)" s7-send.log 'OD-9 boundary \(pool.init\): tx [1-9A-HJ-NP-Za-km-z]+, block time [0-9]+'
has "s7: no arm_keeper sent (F1-b)" s7-send.log 'arm-keeper: not at S7 \(F1-b\)'
has "s7: INITIAL_KEEPER checked as compiled in" s7-send.log 'ok   INITIAL_KEEPER compiled in'
has "s7: the keeper pin stays unpinned (no HouseKeeper)" s7-send.log 'keeperSeat: no HouseKeeper on chain'
has "s7: pins written" s7-send.log 'written .*health-pins.json'
[ -z "$(solana account -u "$LOCAL" Hb8Er2uoJKEWDgkJPncFQa5sVidqr34NEatqEDqnhj85 --output json 2>/dev/null)" ] && { PASS=$((PASS+1)); echo "  ok   no HouseKeeper account after S7"; } || { FAILN=$((FAILN+1)); echo "  FAIL a HouseKeeper exists after S7"; }
expect 0 "s7 --send again: every step is skipped (idempotent)" s7-again.log $U/s7.mjs "${S7[@]}" --deploy-wallet-key "$ARCH" --payee-key "$PAYEE" --send
[ "$(grep -c 'done already' "$LOG/s7-again.log")" = 5 ] && { PASS=$((PASS+1)); echo "  ok   five steps report done already"; } || { FAILN=$((FAILN+1)); echo "  FAIL s7 re-run did not skip all five steps"; }
expect 0 "census s7 green (payee, Royalties locked, seat, extra, no HouseKeeper: F1-b)" census-s7.log $U/census.mjs --stage s7 "${CK[@]}" --payee "$PAYEE_PUB" --metadata-base https://arweave.net/ARWEAVE_MANIFEST_ID_TBD/ --out "$WORK/run/census-s7.json"
has "census s7: HouseKeeper not armed (F1-b)" census-s7.log 'ok   HouseKeeper not armed \(F1-b\)'
expect 1 "census s7 --keeper-armed is red while no keeper is armed" census-s7-armed.log $U/census.mjs --stage s7 "${CK[@]}" --payee "$PAYEE_PUB" --keeper-armed
expect 0 "pins s7 dry: the file already holds the S7 pins" pins-s7.log $U/pins.mjs --stage s7 --rpc "$LOCAL" --deploy-key "$DK_PUB" --payee "$PAYEE_PUB" --seat-cold "$COLD_PUB" --seat-refund "$ERASED" --keeper "$KEEPER_PUB" --pins "$WORK/run/health-pins.json"
has "pins s7 unchanged on a re-run" pins-s7.log 'already holds these pins'
grep -q '"keeperSeat": ""' "$WORK/run/health-pins.json" && { PASS=$((PASS+1)); echo "  ok   keeperSeat still unpinned after S7"; } || { FAILN=$((FAILN+1)); echo "  FAIL keeperSeat was pinned at S7"; }
expect 1 "pins --stage keeper is red while no keeper is armed" pins-keeper-early.log $U/pins.mjs --stage keeper --rpc "$LOCAL" --keeper "$KEEPER_PUB" --pins "$WORK/run/health-pins.json"

# --- S9 -------------------------------------------------------------------------------------------------------------
echo "S9 freeze"
S9B=(--rpc "$LOCAL" --deploy-key "$DK_PUB" --elf "$NEW_SO" --pins "$WORK/run/health-pins.json")
S9=("${S9B[@]}" --expect-deploy-slot "$S6_SLOT")
snap "$WORK/run/snap-s7.json"
expect 1 "s9 dry run before 2026-11-25 is red (date gate)" s9-date.log $U/s9.mjs "${S9[@]}"
expect 0 "s9 dry run green (rehearsal date gate moved)" s9-dry.log $U/s9.mjs "${S9[@]}" --not-before 2026-10-01T00:00:00Z
expect 3 "s9 --send refuses before the date" s9-send-date.log $U/s9.mjs "${S9[@]}" --deploy-key-file "$DK" --send
expect 3 "s9 refuses a key file that is not the DEPLOY_KEY" s9-wrongkey.log $U/s9.mjs "${S9[@]}" --deploy-key-file "$PAYEE" --not-before 2026-10-01T00:00:00Z --send
expect 3 "s9 refuses without the key file" s9-nokey.log $U/s9.mjs "${S9[@]}" --not-before 2026-10-01T00:00:00Z --send
expect 1 "s9 dry run refuses another S6 slot" s9-slot.log $U/s9.mjs "${S9B[@]}" --expect-deploy-slot $((S6_SLOT+1)) --not-before 2026-10-01T00:00:00Z
snap "$WORK/run/snap-s7b.json"; same "the s9 dry and refused runs changed no account" same-s7.log "$WORK/run/snap-s7.json" "$WORK/run/snap-s7b.json"
expect 0 "s9 --send: IDL authority erased + upgrade authority none, one transaction" s9-send.log $U/s9.mjs "${S9[@]}" --deploy-key-file "$DK" --not-before 2026-10-01T00:00:00Z --send
solana program show "$PROGRAM" -u "$LOCAL" >"$LOG/s9-program-show.log" 2>&1 || true
anchor idl authority "${ANCHOR_ARCH[@]}" "$PROGRAM" >"$LOG/s9-idl-authority.log" 2>&1 || true
has "solana program show: Authority none" s9-program-show.log '^Authority: none'
has "anchor idl authority: erased" s9-idl-authority.log "$ERASED"
expect 0 "census s9 green (frozen, binary and IDL unchanged)" census-s9.log $U/census.mjs --stage s9 "${CK[@]}" --payee "$PAYEE_PUB" --out "$WORK/run/census-s9.json"
has "census s9: HouseKeeper not armed (F1-b)" census-s9.log 'ok   HouseKeeper not armed \(F1-b\)'
has "s9 dry run: the HouseKeeper is only reported (absent, F1-b)" s9-dry.log 'info HouseKeeper: absent: not armed \(F1-b\)'
has "pins s9 written (upgradeAuthority null, IDL erased)" s9-send.log 'SET  upgradeAuthority +"[1-9A-HJ-NP-Za-km-z]+" -> null'
expect 0 "s9 again: already frozen, nothing to send" s9-again.log $U/s9.mjs "${S9[@]}" --not-before 2026-10-01T00:00:00Z
set +e; solana program set-upgrade-authority "$PROGRAM" --upgrade-authority "$DK" --new-upgrade-authority "$ARCH" -u "$LOCAL" >"$LOG/s9-after.log" 2>&1; RC=$?; set -e
[ "$RC" != 0 ] && { PASS=$((PASS+1)); echo "  ok   after the freeze the DEPLOY_KEY cannot set an upgrade authority (exit $RC) [s9-after.log]"; } || { FAILN=$((FAILN+1)); echo "  FAIL the DEPLOY_KEY could still act after the freeze"; }
cp "$WORK/run/health-pins.json" "$LOG/health-pins.after-s9.json"

# --- LATER (F1-b): the house keeper armed after the freeze, on the day a continuous keeper has run >= 24 h -------------
echo "Later house-keeper arm (after the freeze; arm_keeper needs no upgrade authority)"
SINCE_OK=$(date -u -d '-25 hours' +%Y-%m-%dT%H:%M:%SZ); SINCE_NEW=$(date -u -d '-1 hours' +%Y-%m-%dT%H:%M:%SZ)
AK=(--rpc "$LOCAL" --arm-keeper --payee "$PAYEE_PUB" --keeper "$KEEPER_PUB" --seat-cold "$COLD_PUB" --elf "$NEW_SO" --legacy-deploy-slot "$OLD_SLOT" --pins "$WORK/run/health-pins.json" --localnet-oracle)
snap "$WORK/run/snap-s9.json"
expect 3 "arm-keeper refuses a continuous keeper younger than 24 h" ak-young.log $U/s7.mjs "${AK[@]}" --continuous-keeper-since "$SINCE_NEW" --keeper-key "$KEEPER" --send
has "arm-keeper: the 24-h refusal" ak-young.log 'less than 24 h before the chain time'
expect 3 "arm-keeper refuses a start time that is not UTC" ak-tz.log $U/s7.mjs "${AK[@]}" --continuous-keeper-since "${SINCE_OK%Z}+02:00" --keeper-key "$KEEPER"
expect 3 "arm-keeper refuses the deploy-wallet key file (not used later)" ak-deploykey.log $U/s7.mjs "${AK[@]}" --continuous-keeper-since "$SINCE_OK" --keeper-key "$KEEPER" --deploy-wallet-key "$ARCH"
expect 3 "arm-keeper refuses a keeper key file that is not INITIAL_KEEPER" ak-wrongkey.log $U/s7.mjs "${AK[@]}" --continuous-keeper-since "$SINCE_OK" --keeper-key "$PAYEE" --send
expect 3 "arm-keeper --send refuses without the keeper key file" ak-nokey.log $U/s7.mjs "${AK[@]}" --continuous-keeper-since "$SINCE_OK" --send
expect 0 "arm-keeper dry run without the key file (placeholder chain)" ak-dry-nokey.log $U/s7.mjs "${AK[@]}" --continuous-keeper-since "$SINCE_OK"
expect 0 "arm-keeper dry run with the key file (the oracle's keeper-arm plan)" ak-dry.log $U/s7.mjs "${AK[@]}" --continuous-keeper-since "$SINCE_OK" --keeper-key "$KEEPER"
has "arm-keeper dry: the continuous-keeper gate is green" ak-dry.log 'ok   continuous keeper \(--continuous-keeper-since\)'
has "arm-keeper dry: the service-level week is printed (D-39)" ak-dry.log 'info service-level week \(D-39\)'
has "arm-keeper dry: the oracle's own plan ran" ak-dry.log 'running the oracle: keeper-arm --deposit 20\.000000000 \(its dry plan\)'
snap "$WORK/run/snap-s9b.json"; same "the arm-keeper dry and refused runs changed no account" same-s9.log "$WORK/run/snap-s9.json" "$WORK/run/snap-s9b.json"
expect 0 "arm-keeper --send: arm_keeper by INITIAL_KEEPER through the oracle's keeper-arm, then the keeper pin" ak-send.log $U/s7.mjs "${AK[@]}" --continuous-keeper-since "$SINCE_OK" --keeper-key "$KEEPER" --send
has "arm-keeper: the oracle's keeper-arm armed a derivable chain" ak-send.log "is derived by this key"
has "arm-keeper: HouseKeeper armed by INITIAL_KEEPER with the bond" ak-send.log "ok   HouseKeeper keeper $KEEPER_PUB, chain [0-9]+ armed at slot [0-9]+, bond 2[0-9]\.[0-9]+ XNT"
has "arm-keeper: the service-level week starts (D-39)" ak-send.log 'service-level week \(D-39\): from '
has "arm-keeper: the keeper pin written" ak-send.log "SET  keeperSeat +\"\" -> \"$KEEPER_PUB\""
expect 0 "arm-keeper again: done already (idempotent)" ak-again.log $U/s7.mjs "${AK[@]}" --continuous-keeper-since "$SINCE_OK" --keeper-key "$KEEPER" --send
has "arm-keeper re-run: done already" ak-again.log 'done already: HouseKeeper armed by'
has "arm-keeper re-run: the service-level week counts from the arm" ak-again.log 'service-level week \(D-39\): from .* \(the arm\)'
expect 1 "census s9 without --keeper-armed is red once a keeper is armed" census-s9-noarm.log $U/census.mjs --stage s9 "${CK[@]}" --payee "$PAYEE_PUB"
expect 0 "census s9 --keeper-armed green (armed by INITIAL_KEEPER, bond >= 20 XNT)" census-s9-armed.log $U/census.mjs --stage s9 "${CK[@]}" --payee "$PAYEE_PUB" --keeper-armed --out "$WORK/run/census-s9-armed.json"
expect 0 "pins --stage keeper dry: the file already holds the keeper pin" pins-keeper.log $U/pins.mjs --stage keeper --rpc "$LOCAL" --keeper "$KEEPER_PUB" --pins "$WORK/run/health-pins.json"
has "pins keeper unchanged on a re-run" pins-keeper.log 'already holds these pins'
cp "$WORK/run/health-pins.json" "$LOG/health-pins.after-arm.json"; cp "$WORK/run/census-"*.json "$LOG/" 2>/dev/null || true
diff "$WORK/run/x1-v3.ts" oracle/src/x1-v3.ts >"$LOG/pin-diff.txt" || true

echo "upgrade tooling rehearsal: $PASS ok, $FAILN failed in $(( $(date +%s) - START )) s"
[ "$FAILN" = 0 ]
