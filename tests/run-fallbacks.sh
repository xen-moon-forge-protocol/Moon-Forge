#!/usr/bin/env bash
# r9 fallbacks end to end (tests/fallbacks.ts): the SlotHashes time fallback and the Core-closed hatch, on a validator of
# their own (it needs Core as an UPGRADEABLE program and a restart warped past SLOT_HASH_MAX_AGE).
#   1. a fresh validator with the localnet build and Core loaded upgradeable with a throwaway authority; `prepare`
#      leaves an unanchored house bet, a DRAWING Jackpot round and three Artifacts;
#   2. once a full snapshot holds that state, the validator stops and restarts from it warped to
#      max(anchor) + SLOT_HASH_MAX_AGE + 100 slots (the warp keeps the SlotHashes window of the snapshot);
#   3. `check` runs both fallbacks and closes Core itself.
# Needs target/deploy/moon_forge_localnet.so, target/idl/moon_forge.json and tests/fixtures/mpl_core.so (run-local.sh
# builds and dumps them), ports 8899 / 9900 free. MF_FALLBACK_DIR: work folder (default /tmp/moonforge-fallbacks),
# removed at the end.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
WORK="${MF_FALLBACK_DIR:-/tmp/moonforge-fallbacks}"
LEDGER="$WORK/ledger"
SLOT_HASH_MAX_AGE=2000 # constants.rs, localnet
if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE ':(8899|9900) '; then
  echo "a validator is already listening on 8899/9900: stop it first" >&2
  exit 1
fi
for f in target/deploy/moon_forge_localnet.so target/idl/moon_forge.json tests/fixtures/mpl_core.so; do
  [ -f "$f" ] || { echo "missing $f (run tests/run-local.sh first)" >&2; exit 1; }
done
rm -rf "$WORK"
mkdir -p "$WORK"
solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/core-authority.json" >/dev/null
VALIDATOR=""
stop() { if [ -n "$VALIDATOR" ]; then kill "$VALIDATOR" 2>/dev/null || true; wait "$VALIDATOR" 2>/dev/null || true; VALIDATOR=""; fi; }
trap 'stop; rm -rf "$WORK"' EXIT
up() { for _ in $(seq 1 120); do solana -u http://127.0.0.1:8899 cluster-version >/dev/null 2>&1 && return 0; sleep 1; done; echo "validator did not start" >&2; return 1; }

solana-test-validator --reset --quiet --ledger "$LEDGER" \
  --bpf-program 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9 target/deploy/moon_forge_localnet.so \
  --upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d tests/fixtures/mpl_core.so "$WORK/core-authority.json" &
VALIDATOR=$!
up
(cd tests && TS_NODE_PROJECT=./tsconfig.json npx ts-node fallbacks.ts prepare "$WORK/state.json")
PREP=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).slot)' "$WORK/state.json")
# a full snapshot taken at or after the prepared slot (the test validator writes one every 100 slots)
snap() { find "$LEDGER" -maxdepth 2 -name 'snapshot-*.tar*' 2>/dev/null | sed -E 's/.*snapshot-([0-9]+)-.*/\1/' | sort -n | tail -1; }
for _ in $(seq 1 240); do s=$(snap); [ -n "$s" ] && [ "$s" -ge "$PREP" ] && break; sleep 1; done
s=$(snap)
[ -n "$s" ] && [ "$s" -ge "$PREP" ] || { echo "no snapshot at or after slot $PREP" >&2; exit 1; }
stop
WARP=$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const a=[BigInt(s.bet.anchor),BigInt(s.jackpot.anchor)].reduce((x,y)=>x>y?x:y);console.log(String(a+BigInt(process.argv[2])+100n))' "$WORK/state.json" "$SLOT_HASH_MAX_AGE")
echo "snapshot at slot $s (prepared at $PREP); restarting warped to slot $WARP"
solana-test-validator --quiet --ledger "$LEDGER" --warp-slot "$WARP" &
VALIDATOR=$!
up
(cd tests && TS_NODE_PROJECT=./tsconfig.json npx ts-node fallbacks.ts check "$WORK/state.json" "$WORK/core-authority.json")
stop
echo "fallbacks: green"
