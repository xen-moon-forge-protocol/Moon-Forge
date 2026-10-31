#!/usr/bin/env bash
# Mainnet compile-guard check (SPEC-UPGRADE-v2 8.1: "a mainnet cargo build-sbf FAILS while _TBD or a placeholder
# pubkey is present or SEAT_COLD_INITIAL is the default"). Linux / WSL / CI. Needs cargo-build-sbf and solana-keygen
# on PATH (both ship with the Agave toolchain).
#
#   (no flag)  1. builds the MAINNET feature set in place. Accepted results: green (every placeholder filled), or a
#                 failure whose only errors are the placeholder guards below. Any other error fails the script.
#                 target/deploy/moon_forge.so is removed first, so it can only ever hold a real mainnet build.
#              2. copies the workspace manifests + programs/ to a temp dir, substitutes THROWAWAY values for the
#                 placeholders (keeper and cold key = fresh keypairs made for this run, never the published test keys,
#                 which the guards of step 3 refuse) and requires a green mainnet build there: the rest of the
#                 mainnet build compiles. The throwaway binary and the copy are deleted; the repo tree is never modified.
#              3. in the same temp copy, the PUBLISHED test keys of tests/fixtures (test-keeper.json HUvv7…,
#                 test-cold.json 36qX…) as INITIAL_KEEPER / SEAT_COLD_INITIAL, in both roles: each build must FAIL with
#                 exactly the two "is a published test key" guards and nothing else.
#   --quick    step 1 only (the tail of tests/run-local.sh).
#   --final    S2 gate: step 1 must be GREEN (no guard fires) and the TRANSITIONAL aliases PRED_BET_WINDOW /
#              PRED_MAX_DELAY must be gone from programs/moon-forge/src.
#
#   MF_GUARD_TARGET   target dir of the temp builds (default: inside the temp copy; never inside the repo).
#   MF_THROWAWAY_OUT  if set (a directory outside the repo): step 2 keeps its binary there as
#                     moon_forge.throwaway-NEVER-DEPLOY.so with throwaway-keeper.json, for tests/mainnet-fork.sh
#                     (MAINNET_SO=<dir>/moon_forge.throwaway-NEVER-DEPLOY.so FORK_KEEPER_KEY=<dir>/throwaway-keeper.json).
#                     A rehearsal binary only: it must never be deployed.
#
# Placeholder guards (constants.rs). A subset is accepted so the owner can fill OD-25 / OD-16 / the Arweave manifest
# one at a time; "SEAT_COLD_INITIAL must not be the keeper key" counts as a placeholder only while BOTH keys are
# still the zero placeholder. The misconfiguration guards (cold == oracle, cold == architect, keeper == oracle,
# cold == keeper with real keys, a published test key) always fail the script.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
MODE="${1:-full}"
case "$MODE" in full|--quick|--final) ;; *) echo "usage: $0 [--quick|--final]" >&2; exit 2 ;; esac

G_KEEPER="INITIAL_KEEPER still holds the placeholder (OD-25)"
G_COLD="SEAT_COLD_INITIAL is mandatory on mainnet (OD-16, S-2)"
G_COLD_KEEPER="SEAT_COLD_INITIAL must not be the keeper key"
G_URI="METADATA_BASE_URI still holds the Arweave placeholder"
G_TEST_KEEPER="INITIAL_KEEPER is a published test key (tests/fixtures)"
G_TEST_COLD="SEAT_COLD_INITIAL is a published test key (tests/fixtures)"
LOGDIR="${MF_GUARD_LOGDIR:-$ROOT/target/guard-check}"
mkdir -p "$LOGDIR"

# rustc error lines of a build log, except the final "could not compile" summary
errors_of() { grep -E '^error(\[E[0-9]+\])?:' "$1" | grep -vE '^error: could not compile' || true; }

# --- step 1: in-place mainnet build ------------------------------------------------------------------------------
LOG1="$LOGDIR/mainnet-inplace.log"
rm -f target/deploy/moon_forge.so
touch programs/moon-forge/src/constants.rs # build-sbf may otherwise reuse the other feature set's artifact
set +e
cargo build-sbf --manifest-path programs/moon-forge/Cargo.toml >"$LOG1" 2>&1
RC=$?
set -e

if [ "$RC" -eq 0 ]; then
  [ -f target/deploy/moon_forge.so ] || { echo "mainnet build green but no target/deploy/moon_forge.so" >&2; exit 1; }
  echo "mainnet build GREEN: no placeholder guard fired ($(stat -c %s target/deploy/moon_forge.so) B, sha256 $(sha256sum target/deploy/moon_forge.so | cut -c1-16)...)"
  STATE=green
else
  rm -f target/deploy/moon_forge.so
  mapfile -t ERRS < <(errors_of "$LOG1")
  if [ "${#ERRS[@]}" -eq 0 ]; then
    echo "mainnet build failed (exit $RC) without a rustc error: see $LOG1" >&2; tail -20 "$LOG1" >&2; exit 1
  fi
  # match on the error lines only (rustc also echoes the guard's source line, message included)
  has() { printf '%s\n' "${ERRS[@]}" | grep -qF -- "$1"; }
  FIRED=()
  for m in "$G_KEEPER" "$G_COLD" "$G_COLD_KEEPER" "$G_URI"; do has "$m" && FIRED+=("$m"); done
  if has "$G_COLD_KEEPER" && ! { has "$G_KEEPER" && has "$G_COLD"; }; then
    echo "SEAT_COLD_INITIAL == INITIAL_KEEPER with real keys (misconfiguration, not a placeholder)" >&2; exit 1
  fi
  N_E0080=$(printf '%s\n' "${ERRS[@]}" | grep -c '^error\[E0080\]' || true)
  if [ "${#ERRS[@]}" -ne "${#FIRED[@]}" ] || [ "$N_E0080" -ne "${#FIRED[@]}" ]; then
    echo "mainnet build failed with errors other than the placeholder guards (see $LOG1):" >&2
    printf '  %s\n' "${ERRS[@]}" >&2
    exit 1
  fi
  echo "mainnet build blocked by OD-25/OD-16/S2 placeholders (expected): ${#FIRED[@]} guard(s)"
  printf '  - %s\n' "${FIRED[@]}"
  STATE=blocked
fi

if [ "$MODE" = "--quick" ]; then exit 0; fi

if [ "$MODE" = "--final" ]; then
  [ "$STATE" = green ] || { echo "--final: the mainnet build must be green at S2" >&2; exit 1; }
  if grep -rnE 'PRED_BET_WINDOW|PRED_MAX_DELAY' programs/moon-forge/src; then
    echo "--final: TRANSITIONAL aliases still present (delete with the SPEC 2.10 predictions rewrite)" >&2; exit 1
  fi
  echo "S2 gate OK: mainnet build green, no TRANSITIONAL aliases"
  exit 0
fi

# --- step 2: throwaway-value mainnet build in a temp copy ----------------------------------------------------------
command -v solana-keygen >/dev/null || { echo "solana-keygen not on PATH (Agave toolchain)" >&2; exit 2; }
if grep -rqE 'PRED_BET_WINDOW|PRED_MAX_DELAY' programs/moon-forge/src; then
  echo "note: TRANSITIONAL aliases PRED_BET_WINDOW / PRED_MAX_DELAY still present (must be gone before S2: --final)"
fi
OUT="${MF_THROWAWAY_OUT:-}"
if [ -n "$OUT" ]; then
  case "$(realpath -m "$OUT")" in "$ROOT"|"$ROOT"/*) echo "MF_THROWAWAY_OUT must be outside the repo" >&2; exit 2 ;; esac
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cp Cargo.toml Cargo.lock "$TMP/"
mkdir -p "$TMP/programs"
cp -r programs/moon-forge "$TMP/programs/"
rm -rf "$TMP/programs/moon-forge/target"
SRC="$ROOT/programs/moon-forge/src/constants.rs"
F="$TMP/programs/moon-forge/src/constants.rs"
T="${MF_GUARD_TARGET:-$TMP/target}"
case "$(realpath -m "$T")" in "$ROOT"/*) echo "MF_GUARD_TARGET must be outside the repo" >&2; exit 2 ;; esac

# fresh throwaway keys for this run (worthless, deleted with the temp dir unless MF_THROWAWAY_OUT keeps the keeper)
solana-keygen new --no-bip39-passphrase --silent --force -o "$TMP/throwaway-keeper.json" >/dev/null
solana-keygen new --no-bip39-passphrase --silent --force -o "$TMP/throwaway-cold.json" >/dev/null
K_THROW="$(solana-keygen pubkey "$TMP/throwaway-keeper.json")"
C_THROW="$(solana-keygen pubkey "$TMP/throwaway-cold.json")"
# the published test keys (private keys in the public repo)
K_TEST="$(solana-keygen pubkey tests/fixtures/test-keeper.json)"
C_TEST="$(solana-keygen pubkey tests/fixtures/test-cold.json)"
[ "$K_TEST" = HUvv7t99FhH7oxgAwjiBweqQGA7V6fpsuF4U7ExMoSRt ] && [ "$C_TEST" = 36qXRZdsTVnsmRVjY6j8vnZqu12ePSNh7uuQ9tw1u81q ] \
  || { echo "tests/fixtures test-keeper.json / test-cold.json are not the keys constants.rs lists ($K_TEST, $C_TEST)" >&2; exit 1; }

# writes $F = constants.rs with the given INITIAL_KEEPER / SEAT_COLD_INITIAL (every line, so filled real values are
# replaced too) and a dummy Arweave id for the placeholder; fails unless both keys were substituted
variant() {
  local keeper="$1" cold="$2"
  sed -e "s|^pub const INITIAL_KEEPER: Pubkey = pubkey!(\"[1-9A-HJ-NP-Za-km-z]*\");|pub const INITIAL_KEEPER: Pubkey = pubkey!(\"$keeper\");|" \
      -e "s|^pub const SEAT_COLD_INITIAL: Pubkey = pubkey!(\"[1-9A-HJ-NP-Za-km-z]*\");|pub const SEAT_COLD_INITIAL: Pubkey = pubkey!(\"$cold\");|" \
      -e 's|"https://arweave.net/ARWEAVE_MANIFEST_ID_TBD/"|"https://arweave.net/abcdefghijklmnopqrstuvwxyz0123456789ABCDE-_/"|' \
      "$SRC" >"$F"
  grep -qF "pub const INITIAL_KEEPER: Pubkey = pubkey!(\"$keeper\");" "$F" \
    && grep -qF "pub const SEAT_COLD_INITIAL: Pubkey = pubkey!(\"$cold\");" "$F" \
    || { echo "could not substitute INITIAL_KEEPER / SEAT_COLD_INITIAL in the temp copy" >&2; exit 1; }
}
build_variant() { # log -> exit code
  set +e
  (cd "$TMP" && touch programs/moon-forge/src/constants.rs && CARGO_TARGET_DIR="$T" cargo build-sbf \
    --manifest-path programs/moon-forge/Cargo.toml --sbf-out-dir "$TMP/deploy") >"$1" 2>&1
  local rc=$?
  set -e
  return $rc
}

variant "$K_THROW" "$C_THROW"
diff "$SRC" "$F" >"$LOGDIR/throwaway.diff" || true
LOG2="$LOGDIR/mainnet-throwaway.log"
RC2=0; build_variant "$LOG2" || RC2=$?
if [ "$RC2" -ne 0 ] || [ ! -f "$TMP/deploy/moon_forge.so" ]; then
  echo "throwaway-value mainnet build FAILED (exit $RC2): see $LOG2" >&2
  grep -E '^error' "$LOG2" | head -20 >&2 || true
  exit 1
fi
if [ -n "$OUT" ]; then
  mkdir -p "$OUT"
  mv "$TMP/deploy/moon_forge.so" "$OUT/moon_forge.throwaway-NEVER-DEPLOY.so"
  cp "$TMP/throwaway-keeper.json" "$OUT/throwaway-keeper.json"
  echo "throwaway-value mainnet build GREEN ($(stat -c %s "$OUT/moon_forge.throwaway-NEVER-DEPLOY.so") B), kept for the fork rehearsal: $OUT (NEVER DEPLOY)"
else
  echo "throwaway-value mainnet build GREEN ($(stat -c %s "$TMP/deploy/moon_forge.so") B); binary deleted"
  rm -f "$TMP/deploy/moon_forge.so"
fi

# --- step 3: the published test keys are refused as INITIAL_KEEPER / SEAT_COLD_INITIAL ------------------------------
i=0
for pair in "$K_TEST $C_TEST" "$C_TEST $K_TEST"; do
  i=$((i + 1))
  set -- $pair
  variant "$1" "$2"
  LOG3="$LOGDIR/mainnet-testkeys-$i.log"
  RC3=0; build_variant "$LOG3" || RC3=$?
  if [ "$RC3" -eq 0 ] || [ -f "$TMP/deploy/moon_forge.so" ]; then
    rm -f "$TMP/deploy/moon_forge.so"
    echo "mainnet build with the published test keys (keeper $1, cold $2) was NOT refused: see $LOG3" >&2; exit 1
  fi
  mapfile -t ERRS3 < <(errors_of "$LOG3")
  N3=$(printf '%s\n' "${ERRS3[@]}" | grep -c '^error\[E0080\]' || true)
  if [ "${#ERRS3[@]}" -ne 2 ] || [ "$N3" -ne 2 ] \
     || ! printf '%s\n' "${ERRS3[@]}" | grep -qF -- "$G_TEST_KEEPER" \
     || ! printf '%s\n' "${ERRS3[@]}" | grep -qF -- "$G_TEST_COLD"; then
    echo "published-test-key build (keeper $1, cold $2) failed with other errors than the two test-key guards (see $LOG3):" >&2
    printf '  %s\n' "${ERRS3[@]}" >&2
    exit 1
  fi
  echo "published test keys refused (keeper ${1:0:4}…, cold ${2:0:4}…): exactly the 2 test-key guards fired"
done
