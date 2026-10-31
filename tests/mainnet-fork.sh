#!/usr/bin/env bash
# SPEC-UPGRADE-v2 8.6 mainnet-fork rehearsal of S6/S7 (Linux / WSL). Read-only against X1 mainnet: it only READS the
# program's accounts and binary (getProgramAccounts / getAccountInfo / program dump) and never sends a transaction there.
#   1. census: every account the live program owns + the Core collection, saved as validator account files;
#   2. a local validator starts with the LIVE binary (dumped from mainnet) as an upgradeable program whose upgrade
#      authority is a throwaway local key, the cloned accounts and the X1 Core binary;
#   3. S6 in place: `solana program extend` by NEW - OLD, then `solana program deploy --program-id` of the NEW binary;
#   4. tests/fork-rehearsal.mjs: every cloned account byte-compares; the 6.3 step-1 simulations; expire_epoch / void_epoch
#      on the newest cloned epoch; the S7 first-run steps (permissionless ones sent, signed ones simulated without
#      signature verification); the census shows the new PDAs.
# Usage: MAINNET_SO=<mainnet build> bash tests/mainnet-fork.sh
#   MAINNET_SO must be a MAINNET-feature build (cargo build-sbf, no --features localnet); the script refuses a localnet
#   build. Until OD-25 / OD-16 / the Arweave manifest are filled, only a throwaway-value mainnet build exists (it is
#   rehearsal-only and must never be deployed).
#   A throwaway build: MF_THROWAWAY_OUT=<dir> bash tests/check-mainnet-guards.sh, then MAINNET_SO=<dir>/moon_forge.throwaway-NEVER-DEPLOY.so
#   FORK_KEEPER_KEY=<dir>/throwaway-keeper.json bash tests/mainnet-fork.sh (arm_keeper is then sent by that key).
set -euo pipefail
cd "$(dirname "$0")/.."
RPC="${MAINNET_RPC:-https://rpc.mainnet.x1.xyz}"
PROGRAM=57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9
CORE=CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d
SO="${MAINNET_SO:-target/deploy/moon_forge.so}"
WORK="${FORK_DIR:-/tmp/moonforge-fork}"
LOCAL=http://127.0.0.1:8899

if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE ':(8899|9900) '; then
  echo "a validator is already listening on 8899/9900: stop it first" >&2; exit 1
fi
[ -f "$SO" ] || { echo "no mainnet binary at $SO (MAINNET_SO=...)" >&2; exit 1; }
[ -f tests/fixtures/mpl_core.so ] || solana program dump -u "$RPC" "$CORE" tests/fixtures/mpl_core.so
(cd tests && [ -d node_modules ] || npm install --no-audit --no-fund)
node tests/fork-rehearsal.mjs guard "$SO" # refuses a --features localnet binary (test oracle key inside)

rm -rf "$WORK"; mkdir -p "$WORK/accounts"
solana program dump -u "$RPC" "$PROGRAM" "$WORK/live.so"
node tests/fork-rehearsal.mjs census "$RPC" "$WORK"   # writes accounts/*.json + census.json (read-only RPC)
solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/upgrade-authority.json"
solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/payer.json"
ACCOUNTS=()
for f in "$WORK"/accounts/*.json; do ACCOUNTS+=(--account "$(basename "$f" .json)" "$f"); done

solana-test-validator --reset --quiet --ledger "$WORK/ledger" \
  --upgradeable-program "$PROGRAM" "$WORK/live.so" "$WORK/upgrade-authority.json" \
  --bpf-program "$CORE" tests/fixtures/mpl_core.so "${ACCOUNTS[@]}" &
VALIDATOR=$!
trap 'kill $VALIDATOR 2>/dev/null || true' EXIT
until solana -u "$LOCAL" cluster-version >/dev/null 2>&1; do sleep 1; done
solana -u "$LOCAL" airdrop 100 "$WORK/payer.json" >/dev/null
solana -u "$LOCAL" airdrop 100 "$WORK/upgrade-authority.json" >/dev/null

# before the upgrade: the LIVE binary answers on the cloned state exactly as on mainnet
node tests/fork-rehearsal.mjs before "$LOCAL" "$WORK" "$WORK/payer.json"

# S6 (9.2): extend by NEW - OLD, then deploy the new binary through a buffer, in place
OLD=$(( $(solana program show -u "$LOCAL" "$PROGRAM" --output json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).dataLen))') ))
NEW=$(stat -c %s "$SO")
echo "ProgramData: old $OLD B, new $NEW B, extend $(( NEW - OLD )) B = $(( (NEW - OLD) * 6960 )) lamports at 6,960 lamports/B"
[ "$NEW" -gt "$OLD" ] && solana program extend -u "$LOCAL" -k "$WORK/upgrade-authority.json" "$PROGRAM" $(( NEW - OLD ))
solana program deploy -u "$LOCAL" -k "$WORK/payer.json" --program-id "$PROGRAM" \
  --upgrade-authority "$WORK/upgrade-authority.json" "$SO"
solana program dump -u "$LOCAL" "$PROGRAM" "$WORK/deployed.so"
[ "$(head -c "$NEW" "$WORK/deployed.so" | sha256sum | cut -d' ' -f1)" = "$(sha256sum "$SO" | cut -d' ' -f1)" ] \
  || { echo "deployed bytes differ from $SO" >&2; exit 1; }
sleep 1 # the upgrade takes effect in the next slot (6.3 step 1)

node tests/fork-rehearsal.mjs after "$LOCAL" "$WORK" "$WORK/payer.json"
echo "mainnet-fork rehearsal OK"
