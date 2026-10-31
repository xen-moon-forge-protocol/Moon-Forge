#!/usr/bin/env bash
# Reproducible-build check (SPEC-UPGRADE-v2 8.7 item 7, X-013 / X-119; S2 records the hashes). Linux / WSL.
# Builds the MAINNET feature set (`cargo build-sbf`, never --features localnet) from TWO fresh copies of the source tree
# at two different paths (different lengths and depths), each with its own empty CARGO_TARGET_DIR, then compares:
#   - sha256 of the two moon_forge.so files (byte identity);
#   - the executable hash (sha256 of the ELF without its trailing zero bytes, the value `solana-verify
#     get-executable-hash` prints and the one `get-program-hash` gives for the deployed ProgramData);
#   - the Cargo.lock each build ended with (cargo must not resolve anything differently).
# The copies are what a fresh clone of the commit holds: Cargo.toml, Cargo.lock, programs/moon-forge (no target/), with
# CRLF line endings normalized to LF as git stores them (REPRO_KEEP_EOL=1 copies the bytes as they are).
#
# Values: at S2 constants.rs holds the real INITIAL_KEEPER / SEAT_COLD_INITIAL / METADATA_BASE_URI and nothing is
# substituted. While any placeholder guard still fires, the script substitutes the SAME throwaway values into both
# copies (fresh keypairs made for this run, a dummy Arweave id; the binaries are rehearsal-only, never deployable) so
# the reproducibility of everything else is still proven. REPRO_FORCE_THROWAWAY=1 substitutes even when green.
#   REPRO_SRC   source tree (default: this repo's working tree)
#   REPRO_OUT   directory outside the repo that receives the log, the two hashes and (REPRO_KEEP=1) the binaries
#   REPRO_LOCKED=1  passes --locked to cargo (fails if Cargo.lock would have to change)
# Exit 0 only if both builds are green and byte-identical.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
SRC="$(realpath "${REPRO_SRC:-$ROOT}")"
OUT="${REPRO_OUT:-$(mktemp -d /tmp/mf-repro-out.XXXXXX)}"
mkdir -p "$OUT"
case "$(realpath -m "$OUT")" in "$ROOT"/*) echo "REPRO_OUT must be outside the repo" >&2; exit 2 ;; esac
command -v cargo-build-sbf >/dev/null || { echo "cargo-build-sbf not on PATH (Agave toolchain)" >&2; exit 2; }

BASE_A="$(mktemp -d /tmp/mfra.XXXXXX)"
BASE_B="$(mktemp -d "${HOME}/.cache/mf-repro-b.XXXXXX")"
trap 'rm -rf "$BASE_A" "$BASE_B"' EXIT
A="$BASE_A/src"
B="$BASE_B/a/much/longer/and/deeper/build/path/moon-forge-src"

copy_tree() { # $1 = destination
  mkdir -p "$1/programs"
  cp "$SRC/Cargo.toml" "$SRC/Cargo.lock" "$1/"
  (cd "$SRC/programs" && tar --exclude=target -cf - moon-forge) | (cd "$1/programs" && tar -xf -)
  if [ "${REPRO_KEEP_EOL:-0}" != 1 ]; then
    find "$1" -type f \( -name '*.rs' -o -name '*.toml' -o -name 'Cargo.lock' -o -name '*.json' -o -name '*.md' \) -exec sed -i 's/\r$//' {} +
  fi
}
copy_tree "$A"
copy_tree "$B"
diff -r "$A" "$B" >/dev/null || { echo "the two copies differ before the build" >&2; exit 1; }
echo "source: $SRC -> $A and $B ($(find "$A" -type f | wc -l) files; tree sha256 $(cd "$A" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)...)"

# placeholder check: one quick mainnet build of copy A decides whether throwaway values are needed
build() { # $1 = tree, $2 = log; uses its own target dir inside the tree's base
  local tgt; tgt="$(dirname "$1")/target"
  local locked=(); [ "${REPRO_LOCKED:-0}" = 1 ] && locked=(-- --locked)
  (cd "$1" && CARGO_TARGET_DIR="$tgt" SOURCE_DATE_EPOCH=0 cargo build-sbf --manifest-path programs/moon-forge/Cargo.toml \
     --sbf-out-dir "$(dirname "$1")/deploy" "${locked[@]}") >"$2" 2>&1
}
THROWAWAY=0
if [ "${REPRO_FORCE_THROWAWAY:-0}" = 1 ] || grep -qE 'pubkey!\("11111111111111111111111111111111"\)|ARWEAVE_MANIFEST_ID_TBD' "$A/programs/moon-forge/src/constants.rs"; then
  THROWAWAY=1
  solana-keygen new --no-bip39-passphrase --silent --force -o "$BASE_A/k.json" >/dev/null
  solana-keygen new --no-bip39-passphrase --silent --force -o "$BASE_A/c.json" >/dev/null
  K="$(solana-keygen pubkey "$BASE_A/k.json")"; C="$(solana-keygen pubkey "$BASE_A/c.json")"
  for T in "$A" "$B"; do
    F="$T/programs/moon-forge/src/constants.rs"
    sed -i -e "s|^pub const INITIAL_KEEPER: Pubkey = pubkey!(\"[1-9A-HJ-NP-Za-km-z]*\");|pub const INITIAL_KEEPER: Pubkey = pubkey!(\"$K\");|" \
           -e "s|^pub const SEAT_COLD_INITIAL: Pubkey = pubkey!(\"[1-9A-HJ-NP-Za-km-z]*\");|pub const SEAT_COLD_INITIAL: Pubkey = pubkey!(\"$C\");|" \
           -e 's|"https://arweave.net/ARWEAVE_MANIFEST_ID_TBD/"|"https://arweave.net/abcdefghijklmnopqrstuvwxyz0123456789ABCDE-_/"|' "$F"
    grep -qF "pubkey!(\"$K\")" "$F" && grep -qF "pubkey!(\"$C\")" "$F" || { echo "substitution failed in $F" >&2; exit 1; }
  done
  rm -f "$BASE_A/k.json" "$BASE_A/c.json" # the binaries are never deployable: the keys are not kept
  echo "placeholders present: the SAME throwaway keeper/cold keys and a dummy Arweave id substituted in both copies (rehearsal binaries, NEVER DEPLOY)"
fi

t0=$(date +%s)
build "$A" "$OUT/build-a.log" || { echo "build A failed: see $OUT/build-a.log" >&2; grep -E '^error' "$OUT/build-a.log" | head >&2; exit 1; }
t1=$(date +%s)
build "$B" "$OUT/build-b.log" || { echo "build B failed: see $OUT/build-b.log" >&2; grep -E '^error' "$OUT/build-b.log" | head >&2; exit 1; }
t2=$(date +%s)
SO_A="$BASE_A/deploy/moon_forge.so"; SO_B="$BASE_B/a/much/longer/and/deeper/build/path/deploy/moon_forge.so"
exe_hash() { node -e 'const b=require("fs").readFileSync(process.argv[1]);let n=b.length;while(n>0&&b[n-1]===0)n--;process.stdout.write(require("crypto").createHash("sha256").update(b.subarray(0,n)).digest("hex"))' "$1"; }
HA=$(sha256sum "$SO_A" | cut -d' ' -f1); HB=$(sha256sum "$SO_B" | cut -d' ' -f1)
EA=$(exe_hash "$SO_A"); EB=$(exe_hash "$SO_B")
LOCK_A=$(sha256sum "$A/Cargo.lock" | cut -d' ' -f1); LOCK_B=$(sha256sum "$B/Cargo.lock" | cut -d' ' -f1)
LOCK_SRC=$(sed 's/\r$//' "$SRC/Cargo.lock" | sha256sum | cut -d' ' -f1)
{
  echo "build A: $A ($((t1 - t0)) s)  $(stat -c %s "$SO_A") B  sha256 $HA  executable hash $EA"
  echo "build B: $B ($((t2 - t1)) s)  $(stat -c %s "$SO_B") B  sha256 $HB  executable hash $EB"
  echo "toolchain: $(cargo-build-sbf --version 2>/dev/null | tr '\n' ' ')"
  echo "Cargo.lock after build: A $LOCK_A, B $LOCK_B, source (LF) $LOCK_SRC$([ "$LOCK_A" = "$LOCK_SRC" ] && echo ' (unchanged)' || echo ' (cargo rewrote it: commit the rewritten lock)')"
  if command -v solana-verify >/dev/null; then
    echo "solana-verify $(solana-verify --version 2>/dev/null | head -1): get-executable-hash A $(solana-verify get-executable-hash "$SO_A" 2>/dev/null | tail -1), B $(solana-verify get-executable-hash "$SO_B" 2>/dev/null | tail -1)"
  else echo "solana-verify not on PATH: executable hash computed as the zero-stripped sha256 (the same definition)"; fi
  [ "$THROWAWAY" = 1 ] && echo "values: throwaway substitution (placeholders still in constants.rs): hashes are NOT the S2 hashes"
} | tee "$OUT/repro.txt"
[ "$LOCK_A" = "$LOCK_B" ] || { echo "the two builds resolved different Cargo.lock files" | tee -a "$OUT/repro.txt"; exit 1; }
if [ "${REPRO_KEEP:-0}" = 1 ]; then cp "$SO_A" "$OUT/moon_forge.a.so"; cp "$SO_B" "$OUT/moon_forge.b.so"; fi
if [ "$HA" = "$HB" ]; then echo "REPRODUCIBLE: the two mainnet builds are byte-identical" | tee -a "$OUT/repro.txt"
else echo "NOT REPRODUCIBLE: the two builds differ" | tee -a "$OUT/repro.txt"; cmp -l "$SO_A" "$SO_B" | head -20 >> "$OUT/repro.txt"; exit 1; fi
