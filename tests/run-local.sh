#!/usr/bin/env bash
# Full local test run of the X1 program (Linux / WSL / macOS).
# Requires: solana-cli >= 2.x, anchor-cli 0.32.1, Rust, Node 20+.
#  1. builds the program with `--features localnet` (test keys, days compressed into seconds)
#  2. dumps the real Metaplex Core program from X1 mainnet
#  3. starts a local validator with both programs and a synthetic XDEX price account
#  4. runs the integration tests and the randomized stress / solvency audit
set -euo pipefail
cd "$(dirname "$0")/.."

# A validator left over from an earlier run would answer on 8899 and the tests would hit its old program.
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE ':(8899|9900) '; then
  echo "a validator is already listening on 8899/9900: stop it first" >&2
  exit 1
fi

# fail fast: the SPEC-UPGRADE-v2 8.1 grep guards and the ECO-3 chips guard over the program source (seconds, no build)
bash tests/grep-guards.sh

cargo test -p moon-forge --lib
mkdir -p target/idl
# --no-docs: the IDL uploaded on-chain and copied to oracle/ and frontend/ is built this way (SPEC-UPGRADE-v2 5, OD-29)
anchor idl build -p moon_forge --no-docs -o target/idl/moon_forge.json
node tests/idl-size.cjs target/idl/moon_forge.json --strict
# build-sbf can reuse the artifact of the other feature set (mainnet keys in a "localnet" build):
# touching a source file forces a real rebuild before each of the two builds.
touch programs/moon-forge/src/constants.rs
cargo build-sbf --manifest-path programs/moon-forge/Cargo.toml --features localnet
# mv, never cp: target/deploy/moon_forge.so must never hold a `--features localnet` build
mv target/deploy/moon_forge.so target/deploy/moon_forge_localnet.so
mkdir -p tests/fixtures
[ -f tests/fixtures/mpl_core.so ] || solana program dump -u https://rpc.mainnet.x1.xyz \
  CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d tests/fixtures/mpl_core.so

# test dependencies first: the observation ring below starts its ~24-minute clock when it is written
(cd tests && npm install --no-audit --no-fund)
# Appendix A vectors recomputed in JS must equal the committed file the Rust test vectors_match_the_clients reads
node tests/spec-vectors-v2.cjs --check

# a synthetic XDEX price-observation account (rising price) for the Predictions tests
node tests/fixtures/make-observation.cjs
# MF_LEDGER_DIR (optional): where the validator keeps its ledger (default /tmp/moonforge-ledger). r6-fix, 2026-10-31: on a
# host whose disk is slow (a WSL disk at 70 % I/O pressure) the validator stalls on its ledger and snapshot writes, and
# the compressed localnet windows (the 40-slot keeper stall window, the 4-s duel reveal windows, the 60-s LP window)
# then fail on time, differently on every run. A RAM-backed folder (for example /dev/shm/moonforge-ledger) removes those
# stalls: the whole run's ledger reached 3.9 GB there, more than the default /dev/shm of a WSL VM with 8 GB (half its
# memory), so raise that cap first (as root: mount -o remount,size=5800M /dev/shm). It is not deleted here: the caller
# removes it after the run.
LEDGER="${MF_LEDGER_DIR:-/tmp/moonforge-ledger}"
solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --bpf-program 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 target/deploy/moon_forge_localnet.so \
  --bpf-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d tests/fixtures/mpl_core.so \
  --account 4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ tests/fixtures/xdex-observation.json &
VALIDATOR=$!
trap 'kill $VALIDATOR' EXIT
until solana -u http://127.0.0.1:8899 cluster-version >/dev/null 2>&1; do sleep 1; done

# all suites run even when one fails, so one run reports every failure; the script exits non-zero if any did.
# One mocha process, in this order: the B-13 coverage recorder (tests/v3-helpers.ts) is shared by the three files, and
# v3-gaps.test.ts (the cases round 2 left out) ends with the B-13 ASSERTION over everything the run observed.
set +e
(cd tests && TS_NODE_PROJECT=./tsconfig.json npx mocha -r ts-node/register -t 900000 moon-forge.test.ts stress.test.ts v3-gaps.test.ts)
RC_MOCHA=$?
(cd agents/kit && npm install --no-audit --no-fund >/dev/null && IDL="$PWD/../../target/idl/moon_forge.json" node test/e2e-local.mjs)
RC_KIT=$?
# optional, E2E_ORACLE=1: the REAL oracle CLI end to end across the upgrade (tests/e2e-oracle-v3.sh, ~10 min). It starts
# its own validators (the old binary, then the in-place upgrade to the build above), so this one stops first.
RC_E2E=0
if [ "${E2E_ORACLE:-0}" = 1 ]; then
  kill $VALIDATOR 2>/dev/null; wait $VALIDATOR 2>/dev/null; trap - EXIT
  bash tests/e2e-oracle-v3.sh; RC_E2E=$?
fi
set -e
echo "suites: mocha (moon-forge + stress + v3-gaps) exit $RC_MOCHA, kit e2e-local exit $RC_KIT${E2E_ORACLE:+, oracle e2e exit $RC_E2E}"

# Rebuild the mainnet binary afterwards (the localnet build must never be deployed). Until OD-25 / OD-16 / the
# Arweave manifest (S2) are filled, the compile guards block it: accepted only when the placeholder guards are
# the ONLY errors ("mainnet build blocked by OD-25/OD-16/S2 placeholders (expected)"); any other error fails.
bash tests/check-mainnet-guards.sh --quick
[ "$RC_MOCHA" -eq 0 ] && [ "$RC_KIT" -eq 0 ] && [ "$RC_E2E" -eq 0 ]
