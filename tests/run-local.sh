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

cargo test -p moon-forge --lib
mkdir -p target/idl
anchor idl build -p moon_forge -o target/idl/moon_forge.json
# build-sbf can reuse the artifact of the other feature set (mainnet keys in a "localnet" build):
# touching a source file forces a real rebuild before each of the two builds.
touch programs/moon-forge/src/constants.rs
cargo build-sbf --manifest-path programs/moon-forge/Cargo.toml --features localnet
cp target/deploy/moon_forge.so target/deploy/moon_forge_localnet.so
mkdir -p tests/fixtures
[ -f tests/fixtures/mpl_core.so ] || solana program dump -u https://rpc.mainnet.x1.xyz \
  CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d tests/fixtures/mpl_core.so

# a synthetic XDEX price-observation account (rising price) for the Predictions tests
node tests/fixtures/make-observation.cjs
solana-test-validator --reset --quiet --ledger /tmp/moonforge-ledger \
  --bpf-program 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 target/deploy/moon_forge_localnet.so \
  --bpf-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d tests/fixtures/mpl_core.so \
  --account 4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ tests/fixtures/xdex-observation.json &
VALIDATOR=$!
trap 'kill $VALIDATOR' EXIT
until solana -u http://127.0.0.1:8899 cluster-version >/dev/null 2>&1; do sleep 1; done

cd tests
npm install --no-audit --no-fund
TS_NODE_PROJECT=./tsconfig.json npx mocha -r ts-node/register -t 900000 moon-forge.test.ts stress.test.ts

# Rebuild the mainnet binary afterwards (the localnet build must never be deployed)
cd .. && touch programs/moon-forge/src/constants.rs && cargo build-sbf --manifest-path programs/moon-forge/Cargo.toml
