#!/usr/bin/env bash
# End to end on a local validator with the REAL oracle CLI (oracle/src/index.ts commands, not mocks), across the final
# program upgrade (Linux / WSL; one validator at a time):
#   stage v2      the OLD binary (OLD_REF, default be03ad8 = the deployed source, --features localnet) with the X1 Core
#                 dump: `init`, a v2 `epoch` (publish + seal + auto-claim + Forge Drops) and a v2 `keeper --once` pass.
#                 With E2E_V2_COMPARE=1 (default) the same steps run first with MAIN's oracle (MAIN_REF, default main; or
#                 MAIN_ORACLE_TAR) on a fresh validator, and the epoch file and the program state must be identical.
#   stage upgrade the in-place upgrade from a buffer (the run-upgrade.sh path: extend, write-buffer, byte check, upgrade),
#                 then the S7 first-run steps with throwaway keys: refresh_collection_uri, set_architect (both payee keys),
#                 lock_collection_royalties, init_seat, init_extra, the first arm_keeper with a bond (`keeper-arm`), and
#                 take_keeper with a bond by a second keeper key.
#   stage v3      no setting changed by hand: the keeper's W2-4 detection flips by itself; the v3 keeper exits the Burn
#                 Lottery round left OPEN by the old binary, settles place_bet_v2 bets, draws and settles a Jackpot,
#                 refunds a stalled bet (a helper anchors, nobody reveals), is killed mid-chain and restarted (the chain
#                 is rebuilt from the seat); the oracle publishes the switch epoch (pinned like the reviewed commit pins
#                 V3_FIRST_EPOCH), a 2-week epoch and, after a quiet period, a long-window epoch whose extra file is a
#                 heartbeat; every extra file is published by `publish-extra` once "pushed"; the keeper claims base
#                 leaves with the v3 tip rule and pays the extra leaves; `verify --full` passes on every file; the D-47
#                 top-up is checked on each publication (wallet never above 0.25 XNT); the week-so-far `feed` is live and
#                 agrees with the epoch built from the same window; `health` runs against the local state.
# The outside world is simulated, the oracle is not: tests/e2e-oracle/fake-world.mjs serves the EVM chain (portal logs,
# counters) and the price APIs; tests/e2e-oracle/preload.cjs points the oracle's hard-coded price hosts at it and
# applies the localnet time unit of `--features localnet` (DAY = 1 s) to the oracle (see that file); a `git` stand-in
# serves the "pushed history" publish-extra checks. driver.ts plays the players and the owner's S7 steps.
# Needs: target/deploy/moon_forge_localnet.so (+ target/idl) from tests/run-local.sh, or NEW_SO=...; the old binary
# (OLD_SO=..., OLD_SRC_TAR=..., or `git archive $OLD_REF`); solana-cli, node 20+.
# Usage: bash tests/e2e-oracle-v3.sh            E2E_STAGES=v2,upgrade,v3 (default all)  E2E_WORK=/tmp/mf-e2e-oracle
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
PROGRAM=57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9
CORE=CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d
OBS=4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ
LOCAL=http://127.0.0.1:8899
WORK="${E2E_WORK:-/tmp/mf-e2e-oracle}"
NEW_SO="${NEW_SO:-target/deploy/moon_forge_localnet.so}"
OLD_REF="${OLD_REF:-be03ad8}"
MAIN_REF="${MAIN_REF:-main}"
WORLD_PORT="${E2E_WORLD_PORT:-8546}"
WORLD="http://127.0.0.1:$WORLD_PORT"
PORTAL=0x00000000000000000000000000000000000E2e01
PRELOAD="$ROOT/tests/e2e-oracle/preload.cjs"
DRIVER="$ROOT/tests/e2e-oracle/driver.ts"
FAILS=0; PASSES=0; T0=$(date +%s)
ok() { PASSES=$((PASSES + 1)); echo "  ok   [$(( $(date +%s) - T0 ))s] $*"; }
bad() { FAILS=$((FAILS + 1)); echo "  FAIL [$(( $(date +%s) - T0 ))s] $*"; }
stage() { echo; echo "=== $* ($(( $(date +%s) - T0 )) s)"; }
has() { [[ ",${E2E_STAGES:-v2,upgrade,v3}," == *",$1,"* ]]; }

if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE ":(8899|9900|$WORLD_PORT) "; then
  echo "a validator or the fake world is already listening on 8899/9900/$WORLD_PORT: stop it first" >&2; exit 1
fi
[ -f "$NEW_SO" ] || { echo "no merged localnet binary at $NEW_SO (run tests/run-local.sh first)" >&2; exit 1; }
[ -f tests/fixtures/mpl_core.so ] || solana program dump -u https://rpc.mainnet.x1.xyz "$CORE" tests/fixtures/mpl_core.so
(cd oracle && [ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null)
chmod +x tests/e2e-oracle/bin/git 2>/dev/null # a checkout made on Windows may drop the mode bit
rm -rf "$WORK"; mkdir -p "$WORK/logs"
VALIDATOR=""; WORLDPID=""; KEEPERPID=""
cleanup() {
  [ -n "$KEEPERPID" ] && kill "$KEEPERPID" 2>/dev/null
  [ -n "$VALIDATOR" ] && kill "$VALIDATOR" 2>/dev/null && wait "$VALIDATOR" 2>/dev/null
  [ -n "$WORLDPID" ] && kill "$WORLDPID" 2>/dev/null
  rm -rf "$WORK"/ledger-* 2>/dev/null
  true
}
trap cleanup EXIT

# ── the old binary (as run-upgrade.sh) ──────────────────────────────────────────────────────────────────────────────
if [ -n "${OLD_SO:-}" ]; then cp "$OLD_SO" "$WORK/old.so"
else
  SRC="$WORK/old-src"; mkdir -p "$SRC"
  if [ -n "${OLD_SRC_TAR:-}" ]; then tar -xf "$OLD_SRC_TAR" -C "$SRC"; else git archive "$OLD_REF" Cargo.toml Cargo.lock programs | tar -x -C "$SRC"; fi
  touch "$SRC/programs/moon-forge/src/constants.rs"
  (cd "$SRC" && CARGO_TARGET_DIR="${OLD_TARGET:-$HOME/.cache/mf-old-target}" cargo build-sbf --manifest-path programs/moon-forge/Cargo.toml --features localnet --sbf-out-dir "$WORK/old-localnet") >"$WORK/logs/old-build.log" 2>&1 \
    || { echo "old build failed (see $WORK/logs/old-build.log)" >&2; exit 1; }
  cp "$WORK/old-localnet/moon_forge.so" "$WORK/old.so"
fi
node tests/fork-rehearsal.mjs guard "$WORK/old.so" >/dev/null 2>&1 && { echo "old.so carries mainnet keys: the test needs the --features localnet twin" >&2; exit 1; }
echo "old.so $(sha256sum "$WORK/old.so" | cut -c1-16)…, new $(sha256sum "$NEW_SO" | cut -c1-16)…"

# ── the oracle's environment: only local endpoints; every other chain empty (a local oracle/.env cannot add one) ────
oracle_env() { # $1 = tag of the work tree
  local top="$WORK/$1"
  echo X1_RPC_URL=$LOCAL X1_RPC_URLS= X1_RPC_2= EPOCHS_DIR="$top/epochs" BASE_RPC_URL="$WORLD/evm/8453" PORTAL_BASE=$PORTAL START_BASE=1001 \
    PORTAL_ETH= PORTAL_OP= PORTAL_BSC= PORTAL_POLYGON= PORTAL_AVAX= PORTAL_PULSE= PORTAL_MOONBEAM= XNT_USD_OVERRIDE= REWARDS_VERSION= V3_FIRST_EPOCH= \
    KEEPER_PRIVATE_KEY= NEW_ORACLE_PRIVATE_KEY= GITHUB_OUTPUT= GITHUB_STEP_SUMMARY= GITHUB_ACTIONS= \
    E2E_FAKE_WORLD=$WORLD E2E_LOCALNET=1 E2E_GIT_TOP="$top" E2E_PUSHED="$WORK/pushed-$1" EXTRA_DURABLE_REF=origin/main \
    E2E_RPC=$LOCAL E2E_FIXTURES="$ROOT/tests/fixtures" E2E_DIR="$top/driver" \
    FEED_URL="$WORLD/site/feed/week-so-far.json" V2_BOUNDARY_TS=99999999999
  # FEED_URL: the D-13 samples come from the test's own site (the preload also maps the site host; this names it).
  # V2_BOUNDARY_TS: the v2 stage of this rehearsal runs whatever the calendar says (C-14 closes v2 on 2026-11-09 06:00
  # UTC on mainnet; flow-v3.ts v2BoundaryTsV3, rehearsals only). r4-fix, review r4 finding 10 (c) and finding 2.
}
N=0
# oracle <tag> <oracle dir> <key name|-> <log name> <args...>: one real CLI command; its log in $WORK/logs
oracle() {
  local tag=$1 dir=$2 key=$3 name=$4; shift 4
  N=$((N + 1)); local log="$WORK/logs/$(printf %02d $N)-$tag-$name.log"
  local k=""; [ "$key" != "-" ] && k="$(cat "$WORK/keys/$key.json")"
  (cd "$dir" && env $(oracle_env "$tag") E2E_ORACLE_DIR="$dir" ORACLE_PRIVATE_KEY="$k" PATH="$ROOT/tests/e2e-oracle/bin:$PATH" ${ORACLE_EXTRA_ENV:-} \
    node -r "$PRELOAD" src/index.ts "$@") >"$log" 2>&1
  local rc=$?
  sed "s/^/    | /" "$log" | cut -c1-260
  LAST_LOG="$log"; LAST_RC=$rc; return $rc
}
# drv <tag> <idl live|v3> <command...>: the players / owner steps / checks (driver.ts), from the worktree's oracle
drv() {
  local tag=$1 idl=$2; shift 2
  (cd "$ROOT/oracle" && env $(oracle_env "$tag") E2E_ORACLE_DIR="$ROOT/oracle" E2E_IDL="$idl" node -r "$PRELOAD" "$DRIVER" "$@") 2>&1 | tee -a "$WORK/logs/driver.log"
  local rc=${PIPESTATUS[0]}
  [ "$rc" -eq 0 ] || FAILS=$((FAILS + 1))
  return "$rc"
}
# drvq: the same, for a poll inside a wait loop (a "not yet" is not a failure)
drvq() { local tag=$1 idl=$2; shift 2; (cd "$ROOT/oracle" && env $(oracle_env "$tag") E2E_ORACLE_DIR="$ROOT/oracle" E2E_IDL="$idl" node -r "$PRELOAD" "$DRIVER" "$@") >/dev/null 2>&1; }
expect() { # expect <pattern> <message>: in the last oracle log
  if grep -qE -- "$1" "$LAST_LOG"; then ok "$2"; else bad "$2 (no /$1/ in $(basename "$LAST_LOG"))"; fi
}
# expect_verified <message>: the last `verify` run exited 0 AND said "verified", with no INCOMPLETE or FAILED verdict
# (a per-chain run can print an agreeing chain and still end INCOMPLETE, exit 2)
expect_verified() {
  if [ "${LAST_RC:-1}" -eq 0 ] && grep -qE -- "verified" "$LAST_LOG" && ! grep -qE -- "INCOMPLETE|VERIFICATION FAILED" "$LAST_LOG"; then ok "$1"
  else bad "$1 (exit ${LAST_RC:-?}; see $(basename "$LAST_LOG"))"; fi
}
push() { mkdir -p "$WORK/pushed-$1/epochs"; cp "$WORK/$1/epochs/"*.json "$WORK/pushed-$1/epochs/" 2>/dev/null; true; } # oracle.yml: commit + push
# epoch_step <tag> <name>: the weekly `epoch` run of the worktree's oracle with the oracle key. A run the anomaly gate
# held (D-17; GATE_HOLD_SECONDS is 1 s in the localnet profile) is run again after the hold, as the next oracle run
# would, and all its logs are checked together (r4-fix, review r4 finding 10 d). r6-review 6: the hold is timed on the X1
# clock, and a loaded localnet's block time can lag the wall clock by several seconds, so a fixed `sleep` could re-run
# while the chain still held the epoch ("is held by the anomaly gate until ..."); and every paying epoch of the localnet
# profile trips F5 (all the feed's samples fall on one real day), so a rebuild that adds a new kind of reason is held once
# more (F4). Each re-run now waits 3 s of CHAIN time first, up to 4 re-runs, and stops at a block (an operator decision).
epoch_step() {
  local tag=$1 name=$2 n=0
  oracle "$tag" "$ROOT/oracle" oracle "$name" epoch
  local all="$WORK/logs/$name.all.log"
  cp "$LAST_LOG" "$all"
  while grep -q "held by the anomaly gate\|held again by the anomaly gate" "$LAST_LOG" && ! grep -q "nothing is published until" "$LAST_LOG" && [ "$n" -lt 4 ]; do
    n=$((n + 1))
    echo "  note $name: held by the anomaly gate ($(grep -oE 'anomaly gate: [a-z-]+' "$all" | sort -u | tr '\n' ' '| sed 's/ *$//')): run again after the hold (re-run $n, after 3 s of chain time)"
    drvq "$tag" v3 wait-chain 3 || sleep 3
    oracle "$tag" "$ROOT/oracle" oracle "$name-release$n" epoch
    cat "$LAST_LOG" >> "$all"
  done
  [ "$n" -gt 0 ] && LAST_LOG="$all"
  true
}

# publish_extra_step <tag> <name> <n>: the oracle.yml publish-extra step. r6-confirm (red 3, run 1): on a loaded host the
# publish transaction can land after the CLI's 30-s confirmation wait (TransactionExpiredTimeoutError); the next run then
# finds it on-chain ("is already published: nothing sent"). One re-run after the chain is final, as the next oracle run
# would; any other failure is reported as it is.
publish_extra_step() {
  local tag=$1 name=$2 x=$3
  oracle "$tag" "$ROOT/oracle" oracle "$name" publish-extra
  if ! grep -qE "extra epoch $x (is already )?published" "$LAST_LOG" && grep -qiE "TransactionExpired|not confirmed|block height exceeded|timed? ?out" "$LAST_LOG"; then
    local first="$LAST_LOG"
    echo "  note $name: the publish confirmation timed out: run again once the chain is final"
    drvq "$tag" v3 wait-final || sleep 5
    oracle "$tag" "$ROOT/oracle" oracle "$name-again" publish-extra
    cat "$first" "$LAST_LOG" > "$LAST_LOG.both"; LAST_LOG="$LAST_LOG.both"
  fi
}

start_world() { # $1 tag
  # the site the health check reads: the pushed epochs directory (what the Pages deploy serves) and the keeper's feed
  mkdir -p "$WORK/$1/site/feed" "$WORK/pushed-$1/epochs"; ln -sfn "$WORK/pushed-$1/epochs" "$WORK/$1/site/epochs"
  node tests/e2e-oracle/fake-world.mjs "$WORLD_PORT" "$ROOT/oracle" "$WORK/$1/world.json" "$WORK/$1/site" >"$WORK/logs/world-$1.log" 2>&1 &
  WORLDPID=$!
  until curl -s -X POST "$WORLD/ctl/state" >/dev/null 2>&1; do sleep 0.3; done
}
start_validator() { # $1 tag
  # the XDEX observation ring at a flat $0.50 per XNT (the oracle reads its 15-min TWAP as a second XNT price)
  node tests/e2e-oracle/make-observation.cjs "$WORK/obs.json" 0.5 >/dev/null
  [ -f "$WORK/upgrade-authority.json" ] || solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/upgrade-authority.json"
  # --limit-ledger-size: the default test-validator ledger purges old blocks during a ~9-min run, and the oracle reads
  # them back (the init_extra mark of ExtraState, the deploy slot's block time, verify --full): keep the whole run
  solana-test-validator --reset --quiet --ledger "$WORK/ledger-$1" --limit-ledger-size 50000000 \
    --upgradeable-program $PROGRAM "$WORK/old.so" "$WORK/upgrade-authority.json" \
    --bpf-program $CORE tests/fixtures/mpl_core.so --account $OBS "$WORK/obs.json" >"$WORK/logs/validator-$1.log" 2>&1 &
  VALIDATOR=$!
  until solana -u $LOCAL cluster-version >/dev/null 2>&1; do sleep 1; done
  solana -u $LOCAL airdrop 100 "$WORK/upgrade-authority.json" >/dev/null
}
stop_all() {
  [ -n "$VALIDATOR" ] && kill "$VALIDATOR" 2>/dev/null && wait "$VALIDATOR" 2>/dev/null; VALIDATOR=""
  [ -n "$WORLDPID" ] && kill "$WORLDPID" 2>/dev/null; WORLDPID=""
  rm -rf "$WORK"/ledger-*
}
mkdir -p "$WORK/keys"
for k in payer oracle keeper keeper2; do (cd oracle && E2E_FIXTURES="$ROOT/tests/fixtures" node -r "$PRELOAD" "$DRIVER" keyfile $k "$WORK/keys/$k.json") || exit 1; done

# ── stage v2: the old binary with the v2 oracle (main's and the worktree's) ──────────────────────────────────────────
BURN_TS=1792152000 # 2026-10-15 12:00 UTC: fixed, so both runs read the same candles (the v2 rules have no window)
v2_run() { # $1 tag, $2 oracle dir
  local tag=$1 dir=$2
  mkdir -p "$WORK/$tag/epochs"
  start_world "$tag"; start_validator "$tag"
  drv "$tag" live fund >/dev/null
  oracle "$tag" "$dir" payer init init; expect "initialize_v2:" "[$tag] init: initialize_v2"; expect "init_artifacts:" "[$tag] init: init_artifacts"
  drv "$tag" live v2-setup $PORTAL && drv "$tag" live save-lottery
  E2E_BURN_TS=$BURN_TS drv "$tag" live burns v2 "40,25,60:1,12"
  # the epoch's Artifact snapshot reads the slot and the asset accounts at "finalized" (x1.ts artifactSnapshot): wait
  # until the v2-setup forge is final, so main's run and this run always list the same holders (a localnet lags about
  # 32 slots; without the wait one run in four or so saw the forge and the other did not)
  drvq "$tag" live wait-final || sleep 20
  oracle "$tag" "$dir" oracle epoch epoch; expect "published:" "[$tag] v2 epoch 1 published"; expect "auto-claimed" "[$tag] v2 auto-claims ran"
  oracle "$tag" "$dir" oracle keeper keeper --once; [ $? -eq 0 ] && ok "[$tag] v2 keeper --once pass" || bad "[$tag] v2 keeper pass exited non-zero"
  drv "$tag" live summary "$WORK/$tag/summary.json"
  oracle "$tag" "$dir" - verify verify "$WORK/$tag/epochs/epoch-1.json" --full; expect "epoch 1 verified" "[$tag] verify --full of its own epoch-1.json"
  if [ "$tag" = v2 ] && [ -d "$WORK/main/oracle" ]; then
    oracle "$tag" "$WORK/main/oracle" - verify-by-main verify "$WORK/$tag/epochs/epoch-1.json" --full; expect "epoch 1 verified" "[$tag] main's verifier accepts the worktree's epoch-1.json against the chain"
  fi
}
# createdAt, the snapshot slot and the publication differ per run, and the data hash covers them; each run's data hash
# is checked by `verify` instead (by both oracles)
norm_epoch() { node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1]));delete f.createdAt;delete f.dataHash;if(f.publish){delete f.publish.tx;delete f.publish.slot}if(f.artifacts)delete f.artifacts.slot;console.log(JSON.stringify(f,null,1))' "$1"; }
# Forge Drop lines aside: the drop seed is a block hash after the publication (a different draw on every run)
norm_log() { grep -v "Forge Drop" "$1" | sed -E 's/[1-9A-HJ-NP-Za-km-z]{64,90}/<sig>/g; s/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/<time>/g; s/slot [0-9]+/slot <n>/g'; }

if has v2; then
  if [ "${E2E_V2_COMPARE:-1}" = 1 ]; then
    stage "v2 on the old binary with MAIN's oracle ($MAIN_REF)"
    mkdir -p "$WORK/main"
    if [ -n "${MAIN_ORACLE_TAR:-}" ]; then tar -xf "$MAIN_ORACLE_TAR" -C "$WORK/main"; else git archive "$MAIN_REF" oracle | tar -x -C "$WORK/main"; fi
    ln -s "$ROOT/oracle/node_modules" "$WORK/main/oracle/node_modules"
    v2_run v2main "$WORK/main/oracle"
    stop_all
  fi
  stage "v2 on the old binary with the worktree's oracle"
  v2_run v2 "$ROOT/oracle"
  if [ "${E2E_V2_COMPARE:-1}" = 1 ]; then
    if diff <(norm_epoch "$WORK/v2main/epochs/epoch-1.json") <(norm_epoch "$WORK/v2/epochs/epoch-1.json") >"$WORK/logs/v2-epoch.diff"; then
      ok "v2 epoch-1.json identical to main's (createdAt, publish tx/slot and snapshot slot aside)"; else bad "v2 epoch-1.json differs from main's: $WORK/logs/v2-epoch.diff"; fi
    if diff "$WORK/v2main/summary.json" "$WORK/v2/summary.json" >"$WORK/logs/v2-state.diff"; then
      ok "v2 program state identical to main's run (epochs, receipts, burner balances, drop receipts, reward vault)"; else bad "v2 program state differs from main's: $WORK/logs/v2-state.diff"; fi
    for s in epoch keeper; do
      a=$(ls "$WORK"/logs/*-v2main-$s.log | head -1); b=$(ls "$WORK"/logs/*-v2-$s.log | head -1)
      if diff <(norm_log "$a") <(norm_log "$b") >"$WORK/logs/v2-$s-log.diff"; then ok "v2 $s log identical to main's (signatures, slots and times aside)"
      else echo "  note v2 $s log differs from main's (see $WORK/logs/v2-$s-log.diff):"; sed 's/^/    /' "$WORK/logs/v2-$s-log.diff" | head -20; fi
    done
  fi
fi

# ── stage upgrade: in place from a buffer, then the S7 first run ─────────────────────────────────────────────────────
if has upgrade; then
  stage "in-place upgrade (extend, write-buffer, upgrade) and the S7 first-run steps"
  oracle v2 "$ROOT/oracle" keeper2 keeper-before keeper --once && ok "keeper before the upgrade: the v2 pass ran (exit 0)" || bad "keeper before the upgrade exited non-zero"
  grep -q "running the v3 keeper" "$LAST_LOG" && bad "the keeper switched to v3 before the upgrade" || ok "no v3 keeper on the old binary"
  OLD=$(solana program show -u $LOCAL $PROGRAM --output json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).dataLen))')
  NEW=$(stat -c %s "$NEW_SO")
  [ "$NEW" -gt "$OLD" ] && solana program extend -u $LOCAL -k "$WORK/upgrade-authority.json" $PROGRAM $(( NEW - OLD )) >/dev/null
  solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/buffer.json"
  solana program write-buffer -u $LOCAL -k "$WORK/upgrade-authority.json" --buffer "$WORK/buffer.json" "$NEW_SO" >/dev/null
  BUF=$(solana-keygen pubkey "$WORK/buffer.json")
  drv v2 live lottery-open   # the old binary: a round OPEN at the upgrade (the v3 keeper must exit it)
  solana program dump -u $LOCAL "$BUF" "$WORK/buffer.so" >/dev/null
  [ "$(head -c "$NEW" "$WORK/buffer.so" | sha256sum | cut -d' ' -f1)" = "$(sha256sum "$NEW_SO" | cut -d' ' -f1)" ] && ok "buffer holds the merged build byte for byte" || bad "buffer bytes differ"
  if solana program upgrade -u $LOCAL -k "$WORK/upgrade-authority.json" "$BUF" $PROGRAM --upgrade-authority "$WORK/upgrade-authority.json" >"$WORK/logs/upgrade.log" 2>&1 \
     || solana program deploy -u $LOCAL -k "$WORK/upgrade-authority.json" --buffer "$WORK/buffer.json" --program-id $PROGRAM --upgrade-authority "$WORK/upgrade-authority.json" >>"$WORK/logs/upgrade.log" 2>&1; then
    ok "program upgraded in place from the buffer"; else bad "upgrade failed: $(tail -2 "$WORK/logs/upgrade.log")"; fi
  solana program dump -u $LOCAL $PROGRAM "$WORK/deployed.so" >/dev/null
  [ "$(head -c "$NEW" "$WORK/deployed.so" | sha256sum | cut -d' ' -f1)" = "$(sha256sum "$NEW_SO" | cut -d' ' -f1)" ] && ok "deployed ProgramData = the merged build" || bad "deployed bytes differ"
  # a half-done upgrade (new binary, no ExtraState / OracleSeat yet): the W2-4 verdict is "unknown", nothing v3 runs
  ORACLE_EXTRA_ENV="E2E_V3_FIRST_EPOCH=2" oracle v2 "$ROOT/oracle" - gate-half feed --gate-only
  expect "dormant.*(unknown|ExtraState)" "upgraded binary without ExtraState/OracleSeat: W2-4 says not upgraded (the feed gate, read-only)"
  drv v2 v3 s7
  oracle v2 "$ROOT/oracle" keeper keeper-arm-dry keeper-arm --deposit 20; expect "dry: nothing sent" "keeper-arm without --yes only prints the plan"
  oracle v2 "$ROOT/oracle" keeper keeper-arm keeper-arm --deposit 20 --yes; expect "armed:" "S7: keeper-arm, the first arm_keeper of INITIAL_KEEPER with a 20-XNT bond"
  drv v2 v3 take-keeper
fi

# ── stage v3: everything switches on by itself ───────────────────────────────────────────────────────────────────────
if has v3; then
  stage "v3: detection, the house keeper, the Burn Lottery exit"
  drv v2 v3 house
  # alice's Artifacts, forged after init_extra (OD-9) and long before the switch epoch's snapshot: eligible for the extra
  # pot from the second extra epoch on (alive in S(n-1) and S(n) with the same owner)
  drv v2 v3 forge alice 0; drv v2 v3 forge alice 0
  K2() { oracle v2 "$ROOT/oracle" keeper2 "$@"; }   # the seat holder (keeper2)
  HELP() { oracle v2 "$ROOT/oracle" oracle "$@"; }  # a helper: the oracle key, not the seat holder
  K2 keeper-detect keeper --once; expect "running the v3 keeper" "detection flips by itself: the v3 keeper runs on the upgraded binary"
  for i in 1 2 3 4; do drvq v2 v3 lottery-exited && break; drvq v2 v3 wait-slots 30; K2 keeper-lottery keeper --once >/dev/null; done
  drv v2 v3 lottery-exited

  stage "v3: place_bet_v2 bets settled by the holder; a restart mid-chain"
  drv v2 v3 bets alice 3 a
  for i in 1 2 3 4 5; do drvq v2 v3 bets-gone a settled && break; K2 keeper-bets keeper --once >/dev/null; done
  drv v2 v3 bets-gone a settled
  drv v2 v3 seat
  R0=$(node -e 'console.log(require(process.argv[1]).revealed)' "$WORK/v2/driver/seat.json")
  L0=$(node -e 'console.log(require(process.argv[1]).length)' "$WORK/v2/driver/seat.json")
  # a long keeper run, killed while bets are pending, then a fresh process continues the same chain
  (cd oracle && env $(oracle_env v2) ORACLE_PRIVATE_KEY="$(cat "$WORK/keys/keeper2.json")" node -r "$PRELOAD" src/index.ts keeper --for 600 --max 600 >"$WORK/logs/keeper-long.log" 2>&1) &
  KEEPERPID=$!
  drv v2 v3 bets bob 2 b
  for i in $(seq 1 60); do grep -q "settled bet" "$WORK/logs/keeper-long.log" 2>/dev/null && break; sleep 1; done
  kill -9 $KEEPERPID 2>/dev/null; wait $KEEPERPID 2>/dev/null; KEEPERPID=""
  pkill -9 -f "src/index.ts keeper --for 600" 2>/dev/null
  ok "the long keeper run was killed (SIGKILL) after $(grep -c 'settled bet' "$WORK/logs/keeper-long.log") settle(s), with a bet still open"
  # a fresh process at once (an anchored bet stalls after KEEPER_STALL_SLOTS = 40 slots on localnet: then only a refund)
  K2 keeper-restart keeper --once >/dev/null
  drv v2 v3 bets dave 2 c
  for i in 1 2 3 4 5; do drvq v2 v3 bets-gone c settled && drvq v2 v3 bets-gone b settled && break; K2 keeper-restart keeper --once >/dev/null; done
  drv v2 v3 bets-gone b settled; drv v2 v3 bets-gone c settled
  grep -q "BadReveal" "$WORK"/logs/*keeper-restart*.log && bad "a restarted keeper sent a wrong reveal" || ok "the restarted keeper rebuilt the chain from the seat: no BadReveal"
  drv v2 v3 seat
  R1=$(node -e 'console.log(require(process.argv[1]).revealed)' "$WORK/v2/driver/seat.json")
  L1=$(node -e 'console.log(require(process.argv[1]).length)' "$WORK/v2/driver/seat.json")
  if [ $((R1 - R0)) -eq 4 ] && [ "$L1" = "$L0" ]; then ok "the seat revealed 4 more positions across the kill and the restart ($R0 -> $R1)"
  # KEEPALIVE_AFTER is 7 days = 7 s on localnet: a restart pass that finds nothing pending after 7 s idle re-arms a new
  # chain (keeper-v3.ts armDecision), a legitimate keeper step on a slow host (r5 run 3). Continuity is then shown by the
  # checks above (every bet settled with the keeper's reveal, no BadReveal); the new chain counts from 0.
  elif [ "$L1" != "$L0" ] && [ "$R1" -le 4 ]; then ok "the restarted keeper re-armed a new chain by its keepalive rule (length $L0 -> $L1, revealed $R1 on it); every bet settled, no BadReveal"
  else bad "seat revealed $R0 -> $R1 (length $L0 -> $L1), expected +4 on the same chain"; fi

  stage "v3: a stalled bet refunded; the Jackpot drawn and settled"
  drv v2 v3 bets carol 1 s
  for i in 1 2 3 4 5; do HELP keeper-helper keeper --once >/dev/null; drvq v2 v3 bets-anchored s && break; drvq v2 v3 wait-slots 3; done
  drv v2 v3 bets-anchored s
  drv v2 v3 wait-slots 45 >/dev/null
  HELP keeper-helper-refund keeper --once
  drv v2 v3 bets-gone s refunded
  K2 keeper-skip keeper --once >/dev/null
  drv v2 v3 seat
  node -e 'const s=require(process.argv[1]);process.exit(s.revealed===s.nextIndex&&s.pendingBets==="0"?0:1)' "$WORK/v2/driver/seat.json" \
    && ok "the holder skipped the refunded position (reveal_keeper): revealed = next_index, nothing pending" || bad "seat not caught up after the refund"
  drv v2 v3 jackpot
  for i in 1 2 3 4 5 6; do drvq v2 v3 jackpot-settled && break; drvq v2 v3 wait-chain 2; K2 keeper-jackpot keeper --once >/dev/null; done
  drv v2 v3 jackpot-settled

  stage "v3: the switch epoch (base + first extra), D-47, claims with the tip rule"
  T=v2; EP="$WORK/$T/epochs"
  LAST=$(node -e 'const fs=require("fs");console.log(Math.max(...fs.readdirSync(process.argv[1]).filter(f=>/^epoch-\d+\.json$/.test(f)).map(f=>+f.match(/\d+/)[0])))' "$EP")
  S=$((LAST + 1)); export ORACLE_EXTRA_ENV="E2E_V3_FIRST_EPOCH=$S"
  # forges right before the build move the live pool after the finalized read: the publish gate must wait for them to be
  # final (the finalized pool is ~13 s behind the live one publish_epoch records), else verify refuses the file forever
  drv $T v3 forge bob 1; drv $T v3 forge dave 0
  E2E_BURNER_BASE=10 drv $T v3 burns s "30,250,20"
  drv $T v3 oracle-balance 5000000; drv $T v3 oracle-wallet pre$S
  epoch_step $T epoch$S; expect "published:" "epoch $S (the switch, rules v3) published by the oracle CLI"
  # a D-47 stop of the oracle's own claims is expected here (the reserve); a problem with the publication is not
  if grep -qE "^ - publication:" "$LAST_LOG"; then bad "epoch $S: publication problem: $(grep -E '^ - publication:' "$LAST_LOG" | head -2 | tr '\n' ' ')"
  else ok "epoch $S: no publication problem (the file's F is the published free pool, within the rebuild drift)"; fi
  grep -q "the live pool moved after the finalized read" "$LAST_LOG" && echo "  note epoch $S: the publish gate saw the forges in the live pool, waited for finality and rebuilt on it"
  expect "extra epoch $S: .*written" "extra-$S.json written (the first extra epoch: X from init_extra)"
  drv $T v3 d47 $S pre$S
  push $T   # oracle.yml commits and pushes; its publish-extra step "fails" here: the next run publishes extra-$S as pending
  drv $T v3 wait-final >/dev/null
  oracle $T "$ROOT/oracle" - verify$S verify "$EP/epoch-$S.json" --full; expect_verified "verify --full epoch-$S.json"
  # the D-47 reserve stopped the oracle's own claims (0.05 XNT reserve + one claim): the seat holder claims, with the tip rule
  K2 keeper-claims$S keeper --once
  drv $T v3 base-claims $S keeper2

  stage "v3: a 2-week window (k = 2), the pending extra published first, a paying extra epoch"
  # alice holds Artifacts forged before S($S) and burns more than the base pot pays: the extra pot pays part of the rest
  ALICE=$(node -e 'console.log(require(process.argv[1]).alice)' "$WORK/$T/driver/keys.json")
  E2E_BURNER_BASE=20 drv $T v3 burns k2 "40,15"
  E2E_BURN_X1=$ALICE drv $T v3 burns k2a "300"
  # the window of epoch S+1 runs from epoch S's published_at to the finalized slot the build reads: start it once that
  # slot's block time is 15 s (2 compressed weeks + 1 s) after the publication, so the extra epoch carries k = 2
  drv $T v3 wait-final-time $S 15 >/dev/null
  drv $T v3 oracle-wallet pre$((S+1))
  epoch_step $T epoch$((S+1)); expect "published:" "epoch $((S+1)) published"
  expect "extra epoch $S published" "extra-$S published by the next run first (pending and durable), then waited for until final"
  expect "extra epoch $((S+1)): .*written" "extra-$((S+1)).json built in the same run on X = ExtraEpochPublished($S).free_after"
  drv $T v3 d47 $((S+1)) pre$((S+1))
  # the base leaves are claimed right after the 2-s hold: the localnet claim window is 90 s (CLAIM_WINDOW, DAY = 1 s) and
  # the publish-extra and verify steps below can take longer than that on a slow host (r5 run 1: epoch $((S+1)) expired
  # unclaimed after 107 s). The keeper run after publish-extra pays the extra leaves. base-claims is checked at once: a
  # later keeper pass expires the epoch after its window and closes its receipts (the close_receipt sweep; r5 run 5).
  drv $T v3 wait-chain 3 >/dev/null
  HELP keeper-claims$((S+1))-base keeper --once >/dev/null
  drv $T v3 base-claims $((S+1)) oracle
  push $T
  drv $T v3 wait-final >/dev/null
  publish_extra_step $T publish-extra$((S+1)) $((S+1)); expect "extra epoch $((S+1)) (is already )?published" "publish-extra: extra-$((S+1)) published once pushed"
  W=$(node -e 'const f=require(process.argv[1]);console.log(f.window.weeks)' "$EP/extra-$((S+1)).json" 2>/dev/null)
  # the e2e aims at k = 2; the run's start time sets it (the pending extra published first and waited for until final, R-2,
  # adds its own seconds), so any multi-week window counts
  if [ "${W:-0}" -ge 2 ] 2>/dev/null; then ok "extra-$((S+1)) carries a multi-week window (k = $W >= 2)"; else echo "  note extra-$((S+1)) window weeks = $W (the e2e aims at 2: the run's start time sets it)"; fi
  drv $T v3 wait-final >/dev/null
  for f in epoch-$((S+1)) extra-$S extra-$((S+1)); do oracle $T "$ROOT/oracle" - verify-$f verify "$EP/$f.json" --full; expect_verified "verify --full $f.json"; done
  # the oracle key as the keeper (keeper.yml's default key): it claims without the tip; the D-47 reserve now allows it
  drv $T v3 extra-snap $((S+1))
  HELP keeper-claims$((S+1)) keeper --once
  drv $T v3 extra-claims $((S+1))

  stage "v3: a quiet window publishes the heartbeat base epoch; the week-so-far feed; a long window with a heartbeat extra"
  # r4-fix (review r4 finding 10 b): on the upgraded program a publishable window with no burn publishes the HEARTBEAT
  # base epoch (budget 0, no leaf) that keeps the oracle seat alive, so the paying epoch after the quiet period is the
  # next one. The window must first reach the 6-day interval (6 s here) after epoch S+1.
  H=$((S+2)); P=$((S+3))
  drv $T v3 wait-final-time $((S+1)) 8 >/dev/null
  drv $T v3 oracle-balance 230000000
  epoch_step $T epoch-quiet
  for i in 1 2 3; do grep -q "published:" "$LAST_LOG" && break; drv $T v3 wait-chain 3 >/dev/null; epoch_step $T epoch-quiet$i; done
  expect "heartbeat: " "a quiet window builds the heartbeat base epoch $H (it keeps the oracle seat alive)"
  expect "published:" "heartbeat epoch $H published (budget 0) by the oracle CLI"
  if node -e 'const f=require(process.argv[1]);process.exit(f.heartbeat===true&&f.leaves.length===0&&f.totalScore==="0"&&f.rateCap==="0"?0:1)' "$EP/epoch-$H.json"; then
    ok "epoch-$H.json is a heartbeat (no leaf, total score 0, rate cap 0)"; else bad "epoch-$H.json is not a heartbeat"; fi
  push $T
  drv $T v3 wait-final >/dev/null
  publish_extra_step $T publish-extra$H $H; expect "extra epoch $H (is already )?published" "publish-extra: the heartbeat's extra-$H published once pushed"
  drv $T v3 wait-final >/dev/null
  for f in epoch-$H extra-$H; do oracle $T "$ROOT/oracle" - verify-$f verify "$EP/$f.json" --full; expect_verified "verify --full $f.json"; done
  # the seat client prices a stranger's void of a heartbeat at SEAT_BOND_MIN (review r4 finding 3; a dry run as keeper2's
  # public key: nothing is signed or sent)
  K2PUB=$(node -e 'console.log(require(process.argv[1]).keeper2)' "$WORK/$T/driver/keys.json")
  oracle $T "$ROOT/oracle" - void-hb void-epoch $H --as "$K2PUB"; expect "required 1\.0000 XNT" "void-epoch --as: a heartbeat's void bond is SEAT_BOND_MIN for a non-cold voider (dry run, nothing sent)"
  expect "nothing signed, nothing sent|not simulated, nothing sent" "void-epoch without --yes sends nothing"
  drv $T v3 wait-chain 95 >/dev/null   # > 13 compressed weeks: the next extra epoch is capped at EXTRA_MAX_WEEKS
  E2E_BURNER_BASE=30 drv $T v3 burns q "35"
  drv $T v3 mine 5 >/dev/null   # a real chain always has new blocks; the fake one moves on demand
  oracle $T "$ROOT/oracle" - feed feed --out "$WORK/$T/feed.json"; expect "week-so-far feed for epoch $P" "feed: live after the upgrade, for the open window of epoch $P"
  drv $T v3 oracle-balance 230000000; drv $T v3 oracle-wallet pre$P
  epoch_step $T epoch$P; expect "published:" "epoch $P published after the quiet period"
  drv $T v3 d47 $P pre$P
  # as for epoch S+1: the seat holder claims the base leaves right after the 2-s hold, well inside the 90-s window
  drv $T v3 wait-chain 3 >/dev/null
  K2 keeper-claims$P keeper --once >/dev/null
  drv $T v3 base-claims $P keeper2
  drv $T v3 feed-check "$WORK/$T/feed.json" $P
  if node -e 'const f=require(process.argv[1]);process.exit(f.totals.budget==="0"&&f.leaves.length===0?0:1)' "$EP/extra-$P.json"; then
    ok "extra-$P is a heartbeat (budget 0, no leaf) after the quiet period"; else bad "extra-$P is not a heartbeat"; fi
  W=$(node -e 'const f=require(process.argv[1]);console.log(f.window.weeks)' "$EP/extra-$P.json")
  if [ "$W" = 13 ]; then ok "its window carries EXTRA_MAX_WEEKS = 13 weeks"; else bad "extra-$P weeks = $W, expected 13"; fi
  push $T
  drv $T v3 wait-final >/dev/null
  publish_extra_step $T publish-extra$P $P; expect "extra epoch $P (is already )?published" "publish-extra: the heartbeat extra-$P published (the program accepts its 13 weeks)"
  drv $T v3 wait-final >/dev/null
  for f in epoch-$P extra-$P; do oracle $T "$ROOT/oracle" - verify-$f verify "$EP/$f.json" --full; expect_verified "verify --full $f.json"; done
  K2 keeper-final keeper --once >/dev/null
  stage "health against the local state"
  # the keeper workflow writes the feed of the window that opened with epoch $P: the site serves it with the epochs
  drv $T v3 mine 5 >/dev/null
  oracle $T "$ROOT/oracle" - feed-next feed --out "$WORK/$T/site/feed/week-so-far.json"; expect "week-so-far feed for epoch $((P+1))" "feed for the next window (epoch $((P+1))), deployed with the site"; expect "skipped \[\]" "the next-window feed values every chain (none skipped)"
  push $T
  GEN=$(drv $T v3 genesis | tail -1)
  (cd oracle && env $(oracle_env $T) $ORACLE_EXTRA_ENV X1_GENESIS_HASH="$GEN" KEEPER_ENABLED=true ORACLE_ENABLED=true HEALTH_JSON="$WORK/$T/health.json"     ORACLE_PUBKEY="$(node -e 'console.log(require(process.argv[1]).oracle)' "$WORK/$T/driver/keys.json")"     KEEPER_PUBKEY="$(node -e 'console.log(require(process.argv[1]).keeper2)' "$WORK/$T/driver/keys.json")"     PATH="$ROOT/tests/e2e-oracle/bin:$PATH" node -r "$PRELOAD" src/health.ts) >"$WORK/logs/health.log" 2>&1
  echo "    health exit $?"; sed 's/^/    | /' "$WORK/logs/health.log" | cut -c1-200
  # rows that MUST be OK on the local state; rows allowed to fail only because this is a local validator with test keys:
  # the mainnet pins and upgrade authority (health-pins.json), and the two seats (28 s without activity is 28 days here)
  node -e '
    const t = require("fs").readFileSync(process.argv[1], "utf8").split(String.fromCharCode(10));
    const row = (n) => t.find((l) => l.slice(5).startsWith(n + " ") || l.slice(5).trim() === n);
    const must = ["rpc Base", "X1 RPCs", "XNT price sources", "program version", "reward pool", "bankroll vault", "reserved accounting", "game escrows",
      "epoch reconciliation", "keeper bond cover", "extra vault", "extra accounting", "extra bound", "keeper backlog", "keeper service level", "oracle key", "oracle wallet", "pages epochs", "week-so-far feed", "auto-claims"];
    const localOnly = ["program authority", "pin: upgrade authority", "pin: Config.architect", "pin: IDL authority", "oracle seat", "keeper seat"];
    let bad = 0;
    for (const n of must) { const l = row(n); if (!l || !l.startsWith("OK")) { bad++; console.log("  FAIL health row " + n + ": " + (l || "missing")); } else console.log("  ok   health row " + n + ": " + l.slice(30, 150)); }
    for (const l of t.filter((l) => l.startsWith("FAIL"))) { const n = l.slice(5, 29).trim(); if (!localOnly.includes(n)) { bad++; console.log("  FAIL unexpected red health row: " + l.slice(0, 160)); } else console.log("  note red only on a local validator with test keys: " + l.slice(0, 140)); }
    process.exit(bad ? 1 : 0);
  ' "$WORK/logs/health.log" || FAILS=$((FAILS + 1))
fi

echo
echo "e2e oracle v3: $PASSES ok, $FAILS failed in $(( $(date +%s) - T0 )) s (logs: $WORK/logs)"
[ "$FAILS" -eq 0 ]
