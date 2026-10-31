#!/usr/bin/env bash
# SPEC-UPGRADE-v2 8.5 upgrade rehearsal (Linux / WSL), on a local validator only:
#   1. baseline: builds the OLD program (OLD_REF, default be03ad8 = "Moon Forge Protocol v2", the deployed source) twice:
#      without features (its sha256 is printed beside the live mainnet ELF's, read-only `solana program dump`;
#      REQUIRE_BASELINE=1 makes a mismatch fatal) and with `--features localnet` (old.so, test keys and compressed time);
#   2. a validator starts with old.so as an UPGRADEABLE program (throwaway local upgrade authority), the X1 Core binary
#      and a fresh XDEX observation fixture made by the OLD fixture generator (the v1 Predictions schedule);
#   3. the OLD IDL (tests/fixtures/idl-onchain-v2.json, the one on chain today) is put on chain with `anchor idl init`;
#   4. S6 preparation (9.2): `solana program extend` by NEW - OLD and `solana program write-buffer` of the merged
#      localnet build into a fresh buffer, whose bytes are checked against the file;
#   5. tests/upgrade-rehearsal.mjs run: Phase A on the old binary, then the buffer is deployed IN PLACE in the same
#      transaction as the last old-binary publish (the hold case), then Phase B on the new binary (see that file);
#   6. the deployed bytes equal the merged build; `anchor idl upgrade` with the merged IDL (fetch + compare), then once
#      more with an IDL padded past the IDL account's size (the resize path, SPEC-UPGRADE-v2 5 / OD-29).
# REHEARSAL_MODE=a|b (default a), see tests/upgrade-rehearsal.mjs. Sources of the old program, first match wins:
# OLD_SO (a prebuilt --features localnet binary), OLD_SRC_TAR (a `git archive <ref> Cargo.toml Cargo.lock programs
# tests/fixtures/make-observation.cjs` tarball), else `git archive $OLD_REF` of this repo.
# Usage: bash tests/run-upgrade.sh   (needs target/deploy/moon_forge_localnet.so + target/idl/moon_forge.json from
#        tests/run-local.sh, or NEW_SO=... NEW_IDL=...)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
PROGRAM=57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9
CORE=CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d
OBS=4oUvUgziz4S6VXxMkjqorjgPrgT3wrxXN9kDuja8pkPZ
OLD_REF="${OLD_REF:-be03ad8}"
NEW_SO="${NEW_SO:-target/deploy/moon_forge_localnet.so}"
NEW_IDL="${NEW_IDL:-target/idl/moon_forge.json}"
WORK="${UPGRADE_DIR:-/tmp/moonforge-upgrade}"
OLD_TARGET="${OLD_TARGET:-$HOME/.cache/mf-old-target}" # outside the repo: the old build never lands in target/deploy
LOCAL=http://127.0.0.1:8899

if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE ':(8899|9900) '; then
  echo "a validator is already listening on 8899/9900: stop it first" >&2; exit 1
fi
[ -f "$NEW_SO" ] || { echo "no merged localnet binary at $NEW_SO (run tests/run-local.sh first)" >&2; exit 1; }
[ -f "$NEW_IDL" ] || { echo "no $NEW_IDL (anchor idl build --no-docs)" >&2; exit 1; }
[ -f tests/fixtures/mpl_core.so ] || solana program dump -u https://rpc.mainnet.x1.xyz "$CORE" tests/fixtures/mpl_core.so
(cd tests && [ -d node_modules ] || npm install --no-audit --no-fund)
rm -rf "$WORK"; mkdir -p "$WORK"

# --- 1. old binaries ----------------------------------------------------------------------------------------------
SRC="$WORK/old-src"; mkdir -p "$SRC"
if [ -n "${OLD_SRC_TAR:-}" ]; then tar -xf "$OLD_SRC_TAR" -C "$SRC"
elif [ -z "${OLD_SO:-}" ]; then git archive "$OLD_REF" Cargo.toml Cargo.lock programs tests/fixtures/make-observation.cjs | tar -x -C "$SRC"; fi
if [ -n "${OLD_SO:-}" ]; then
  cp "$OLD_SO" "$WORK/old.so"
else
  (cd "$SRC" && CARGO_TARGET_DIR="$OLD_TARGET" cargo build-sbf --manifest-path programs/moon-forge/Cargo.toml --sbf-out-dir "$WORK/old-mainnet") >"$WORK/old-mainnet.log" 2>&1
  touch "$SRC/programs/moon-forge/src/constants.rs"
  (cd "$SRC" && CARGO_TARGET_DIR="$OLD_TARGET" cargo build-sbf --manifest-path programs/moon-forge/Cargo.toml --features localnet --sbf-out-dir "$WORK/old-localnet") >"$WORK/old-localnet.log" 2>&1
  cp "$WORK/old-localnet/moon_forge.so" "$WORK/old.so"
  # baseline: the live ELF hash ignores the zero padding of the ProgramData account
  if solana program dump -u https://rpc.mainnet.x1.xyz "$PROGRAM" "$WORK/live.so" >/dev/null 2>&1; then
    strip0() { node -e 'const b=require("fs").readFileSync(process.argv[1]);let n=b.length;while(n>0&&b[n-1]===0)n--;process.stdout.write(require("crypto").createHash("sha256").update(b.subarray(0,n)).digest("hex"))' "$1"; }
    LIVE=$(strip0 "$WORK/live.so"); OLDM=$(strip0 "$WORK/old-mainnet/moon_forge.so")
    echo "baseline: live ELF sha256 (zero padding stripped) $LIVE; $OLD_REF mainnet build $OLDM ($([ "$LIVE" = "$OLDM" ] && echo MATCH || echo 'differs'))"
    if [ "${REQUIRE_BASELINE:-0}" = 1 ] && [ "$LIVE" != "$OLDM" ]; then echo "REQUIRE_BASELINE=1: baseline mismatch" >&2; exit 1; fi
  fi
fi
node tests/fork-rehearsal.mjs guard "$WORK/old.so" >/dev/null 2>&1 && { echo "old.so carries mainnet keys: the rehearsal needs the --features localnet twin" >&2; exit 1; }
echo "old.so $(stat -c %s "$WORK/old.so") B sha256 $(sha256sum "$WORK/old.so" | cut -c1-16)...; new $(stat -c %s "$NEW_SO") B sha256 $(sha256sum "$NEW_SO" | cut -c1-16)..."

# --- 2. validator with the old binary, upgradeable; the observation ring of the OLD tests (one every 15 s) ----------
mkdir -p "$WORK/obs"
if [ -f "$SRC/tests/fixtures/make-observation.cjs" ]; then cp "$SRC/tests/fixtures/make-observation.cjs" "$WORK/obs/"; else cp tests/fixtures/make-observation.cjs "$WORK/obs/"; fi
node "$WORK/obs/make-observation.cjs"
solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/upgrade-authority.json"
solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/buffer.json"
solana-test-validator --reset --quiet --ledger "$WORK/ledger" \
  --upgradeable-program "$PROGRAM" "$WORK/old.so" "$WORK/upgrade-authority.json" \
  --bpf-program "$CORE" tests/fixtures/mpl_core.so \
  --account "$OBS" "$WORK/obs/xdex-observation.json" &
VALIDATOR=$!
trap 'kill $VALIDATOR 2>/dev/null || true' EXIT
until solana -u "$LOCAL" cluster-version >/dev/null 2>&1; do sleep 1; done
solana -u "$LOCAL" airdrop 200 "$WORK/upgrade-authority.json" >/dev/null
START=$(date +%s)
ANCHOR_P=(--provider.cluster "$LOCAL" --provider.wallet "$WORK/upgrade-authority.json")

# --- 3. the old IDL on chain (as on mainnet: IDL authority = upgrade authority) ---------------------------------------
anchor idl init "${ANCHOR_P[@]}" --filepath tests/fixtures/idl-onchain-v2.json "$PROGRAM" | tail -2
IDL_ACC=$(cd tests && node -e 'const {PublicKey}=require("@solana/web3.js");const p=new PublicKey(process.argv[1]);PublicKey.createWithSeed(PublicKey.findProgramAddressSync([],p)[0],"anchor:idl",p).then(k=>console.log(k.toBase58()))' "$PROGRAM")
idl_len() { solana account -u "$LOCAL" "$IDL_ACC" --output json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).account.data[0],"base64").length))'; }
echo "old IDL on chain: account $IDL_ACC, $(idl_len) B"

# --- 4. extend + write the buffer (9.2), before Phase A: the old program keeps running meanwhile -----------------------
OLD=$(solana program show -u "$LOCAL" "$PROGRAM" --output json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).dataLen))')
NEW=$(stat -c %s "$NEW_SO")
echo "ProgramData: old $OLD B, new $NEW B, extend $(( NEW - OLD )) B ($(( (NEW - OLD) * 6960 )) lamports at 6,960 lamports/B)"
[ "$NEW" -gt "$OLD" ] && solana program extend -u "$LOCAL" -k "$WORK/upgrade-authority.json" "$PROGRAM" $(( NEW - OLD )) | grep -v '^$'
solana program write-buffer -u "$LOCAL" -k "$WORK/upgrade-authority.json" --buffer "$WORK/buffer.json" "$NEW_SO" | grep -v '^$'
BUF=$(solana-keygen pubkey "$WORK/buffer.json")
solana program dump -u "$LOCAL" "$BUF" "$WORK/buffer.so" >/dev/null
[ "$(head -c "$NEW" "$WORK/buffer.so" | sha256sum | cut -d' ' -f1)" = "$(sha256sum "$NEW_SO" | cut -d' ' -f1)" ] \
  || { echo "buffer bytes differ from $NEW_SO" >&2; exit 1; }
echo "buffer $BUF holds the merged build byte for byte"

# --- 5. Phase A, the in-place upgrade, Phase B ----------------------------------------------------------------------
set +e
UPGRADE_BUFFER="$BUF" UPGRADE_AUTHORITY="$WORK/upgrade-authority.json" node tests/upgrade-rehearsal.mjs run "$LOCAL" "$WORK"
RC=$?
set -e

# --- 6. deployed bytes; IDL upgrade and the resize path -------------------------------------------------------------
solana program dump -u "$LOCAL" "$PROGRAM" "$WORK/deployed.so" >/dev/null
if [ "$(head -c "$NEW" "$WORK/deployed.so" | sha256sum | cut -d' ' -f1)" = "$(sha256sum "$NEW_SO" | cut -d' ' -f1)" ]; then
  echo "  ok   deployed ProgramData = the merged build ($NEW B) + zero padding"
else echo "  FAIL deployed bytes differ from $NEW_SO"; RC=1; fi
idl_same() { # $1 = local IDL file: fetch the on-chain IDL and compare as JSON (anchor-cli re-serializes: key order differs)
  anchor idl fetch "${ANCHOR_P[@]}" "$PROGRAM" > "$WORK/idl-fetched.json"
  node -e 'const f=require("fs");const s=(x)=>Array.isArray(x)?x.map(s):x&&typeof x==="object"?Object.fromEntries(Object.keys(x).sort().map(k=>[k,s(x[k])])):x;const a=JSON.stringify(s(JSON.parse(f.readFileSync(process.argv[1]))));const b=JSON.stringify(s(JSON.parse(f.readFileSync(process.argv[2]))));process.exit(a===b?0:1)' "$1" "$WORK/idl-fetched.json"
}
BEFORE=$(idl_len)
anchor idl upgrade "${ANCHOR_P[@]}" --filepath "$NEW_IDL" "$PROGRAM" | tail -1
if idl_same "$NEW_IDL"; then echo "  ok   anchor idl upgrade with the merged IDL: fetched IDL = $NEW_IDL (IDL account $BEFORE -> $(idl_len) B)"; else echo "  FAIL fetched IDL differs from $NEW_IDL"; RC=1; fi
# padded IDL: incompressible docs on the first instruction until the zlib-6 size exceeds the IDL account's capacity
CAP=$(( $(idl_len) - 44 ))
node tests/idl-pad.cjs "$NEW_IDL" "$WORK/idl-padded.json" "$CAP"
# anchor-cli 0.32.1 `idl upgrade` never resizes: set_buffer requires capacity >= the new length (RequireGteViolated 2506),
# and the program's IdlInstruction::Resize only accepts an account whose stored IDL is empty (IdlAccountNotEmpty). The
# working path is `anchor idl close` + `anchor idl init`: the account is re-created at the same address with twice the
# compressed size (both signed by the upgrade authority = IDL authority; impossible after S9's erase-authority).
if anchor idl upgrade "${ANCHOR_P[@]}" --filepath "$WORK/idl-padded.json" "$PROGRAM" > "$WORK/idl-padded.log" 2>&1; then
  echo "  note anchor idl upgrade of the padded IDL succeeded directly"
else
  if grep -q 'custom program error: 0x9ca' "$WORK/idl-padded.log"; then
    echo "  ok   anchor idl upgrade of an IDL larger than the account is refused (RequireGteViolated, $(grep -oE 'Left: [0-9]+|Right: [0-9]+' "$WORK/idl-padded.log" | sort -u | paste -sd' ')): the on-chain IDL is unchanged"
  else echo "  FAIL padded upgrade failed unexpectedly: $(tail -3 "$WORK/idl-padded.log")"; RC=1; fi
  idl_same "$NEW_IDL" && echo "  ok   the merged IDL is still on chain after the refused upgrade" || { echo "  FAIL on-chain IDL changed by the refused upgrade"; RC=1; }
  if anchor idl close "${ANCHOR_P[@]}" "$PROGRAM" > "$WORK/idl-close.log" 2>&1 && anchor idl init "${ANCHOR_P[@]}" --filepath "$WORK/idl-padded.json" "$PROGRAM" > "$WORK/idl-reinit.log" 2>&1 && idl_same "$WORK/idl-padded.json"; then
    echo "  ok   resize path (OD-29): anchor idl close + anchor idl init re-created the IDL account with the padded IDL (IDL account -> $(idl_len) B), fetched = padded file"
  else echo "  FAIL resize path (close + init): $(tail -3 "$WORK/idl-close.log" "$WORK/idl-reinit.log" 2>/dev/null)"; RC=1; fi
fi
if anchor idl upgrade "${ANCHOR_P[@]}" --filepath "$NEW_IDL" "$PROGRAM" >/dev/null && idl_same "$NEW_IDL"; then
  echo "  ok   merged IDL restored on chain (IDL account $(idl_len) B)"
else echo "  FAIL merged IDL not restored"; RC=1; fi
echo "upgrade rehearsal (mode ${REHEARSAL_MODE:-a}) $([ "$RC" -eq 0 ] && echo OK || echo FAILED) in $(( $(date +%s) - START )) s"
exit "$RC"
