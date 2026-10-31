#!/usr/bin/env bash
# SPEC-UPGRADE-v2 8.1 grep guards (and the ECO-3 chips guard) over the program's NON-TEST code (test modules and
# comment lines removed). Run first by tests/run-local.sh and by the CI guard job; exits 1 with the offending lines.
#   1. B-1 / 2.7 item 6: `config.architect` is the only architect read: the ARCHITECT constant appears only in
#      initialize_v2 (forge.rs) and init_artifacts (artifacts.rs).
#   2. ECO-3: no instruction writes PlayerState.chips, CHIP_PER_* have no consumer, grant_claim_chips returns 0.
#   3. `.game` masked: every v2 read of Bet.game (keeper.rs) masks with BET_GAME_MASK or tests a flag bit; any other
#      reader of `.game` is a legacy path gated on `BET_KEEPER == 0`.
#   4. `target_slot` branches: every function that touches a `.target_slot` is a known one and carries its marker check
#      (Bet: BET_KEEPER; JackpotRound: winning_ticket vs u64::MAX; War: is_v2 / WAR_V2; the retired lottery has one
#      meaning only). A new reader fails until it is reviewed and listed here.
#   5. `winning_ticket` only in the jackpot functions (draw_jackpot, settle_jackpot, settle_jackpot_v2), where the v3
#      marker u64::MAX lives; settle_draw writes the retired Burn Lottery's own DrawRound.winning_ticket (another account).
#   6. no instruction in seat.rs / extra.rs / keeper.rs moves lamports OUT of reward_vault (take_keeper's bond refund
#      leaves the keeper seat, not the vault), with ONE reviewed exception (G-2, round 4): keeper.rs settle_bet_v2 pays
#      the settle tip, exactly once, as `tip` to `keeper_info` (the registered keeper wallet: has_one = keeper), after
#      settle_tip (min(KEEPER_SETTLE_TIP, half the bet's pool share, the free pool)) and tip_payable.
#   7. review F4 (round 4): the dead DRAW_ANCHOR_SLOTS stays deleted, and the retired lottery's draw_draw fixes the next
#      slot as its drawing block.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=programs/moon-forge/src
DUMP="$(mktemp)"
trap 'rm -f "$DUMP"' EXIT

# file|fn|line|code for every non-test, non-comment line; fn = the innermost fn / struct seen so far in the file
awk '
FNR == 1 { fn = "-"; skip = 0; pend = 0 }
pend { pend = 0; if ($0 !~ /^[[:space:]]*(pub(\(crate\))?[[:space:]]+)?mod[[:space:]]+[A-Za-z0-9_]+;/) skip = 1 }
skip { if ($0 ~ /^}/) skip = 0; next }
/^#\[cfg\(test\)\]/ { pend = 1; next }
/^[[:space:]]*\/\// { next }
match($0, /^[[:space:]]*(pub(\(crate\))?[[:space:]]+)?(const[[:space:]]+)?fn[[:space:]]+[A-Za-z0-9_]+/) { s = substr($0, RSTART, RLENGTH); sub(/.*fn[[:space:]]+/, "", s); fn = s }
match($0, /^[[:space:]]*(pub(\(crate\))?[[:space:]]+)?struct[[:space:]]+[A-Za-z0-9_]+/) { s = substr($0, RSTART, RLENGTH); sub(/.*struct[[:space:]]+/, "", s); fn = "struct " s }
{ line = $0; sub(/[[:space:]]\/\/.*$/, "", line); n = split(FILENAME, p, "/"); print p[n] "|" fn "|" FNR "|" line }
' "$SRC"/*.rs "$SRC"/instructions/*.rs >"$DUMP"
[ "$(wc -l <"$DUMP")" -gt 5000 ] || { echo "grep guards: the source dump looks truncated ($(wc -l <"$DUMP") lines)" >&2; exit 1; }

FAIL=0
fail() { echo "grep guard FAILED: $1" >&2; shift; local l; for l in "$@"; do if [ -n "$l" ]; then echo "  $l" >&2; fi; done; FAIL=1; return 0; }
code_matching() { grep -E "^[^|]*\|[^|]*\|[0-9]+\|.*$1" "$DUMP" || true; }      # lines whose code matches $1
body() { awk -F'|' -v f="$1" -v g="$2" '$1 == f && $2 == g' "$DUMP" | cut -d'|' -f4- | tr '\n' ' '; } # one fn's code, joined
fns_matching() { code_matching "$1" | cut -d'|' -f1,2 | sort -u; }                 # file|fn pairs

# 1. the ARCHITECT constant
mapfile -t BAD < <(code_matching '(^|[^_A-Za-z0-9])ARCHITECT([^_A-Za-z0-9]|$)' \
  | grep -vE '^(constants\.rs\||forge\.rs\|initialize_v2\||artifacts\.rs\|init_artifacts\|)')
[ "${#BAD[@]}" -eq 0 ] || fail "ARCHITECT read outside initialize_v2 / init_artifacts (use config.architect)" "${BAD[@]}"

# 2. ECO-3
mapfile -t BAD < <(code_matching '[.]chips[[:space:]]*([-+*/|&]?=[^=]|[.](saturating|checked|wrapping)_add)')
[ "${#BAD[@]}" -eq 0 ] || fail "ECO-3: PlayerState.chips is written" "${BAD[@]}"
mapfile -t BAD < <(code_matching 'CHIP_PER_' | grep -v '^constants\.rs|')
[ "${#BAD[@]}" -eq 0 ] || fail "ECO-3: CHIP_PER_* has a consumer" "${BAD[@]}"
GCC="$(body forge.rs grant_claim_chips)"
echo "$GCC" | grep -qE '\{[[:space:]]*0[[:space:]]*\}' || fail "ECO-3: grant_claim_chips must return 0" "$GCC"

# 3. `.game` masked
mapfile -t BAD < <(code_matching '[.]game([^_A-Za-z0-9]|$)' | grep '^keeper\.rs|' | grep -vE 'BET_GAME_MASK|BET_KEEPER|BET_ANCHORED')
[ "${#BAD[@]}" -eq 0 ] || fail "Bet.game read in keeper.rs without BET_GAME_MASK or a flag test" "${BAD[@]}"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  body "${f%%|*}" "${f#*|}" | grep -qE 'BET_KEEPER[[:space:]]*==[[:space:]]*0' || fail "\`.game\` read by $f, which is not gated on BET_KEEPER == 0"
done < <(fns_matching '[.]game([^_A-Za-z0-9]|$)' | grep -v '^keeper\.rs|')

# 4. `target_slot` branches: file|fn -> the marker its body must carry
declare -A MARK=(
  ["keeper.rs|place_bet_v2"]='BET_KEEPER'
  ["keeper.rs|anchor_bet"]='BET_KEEPER[[:space:]]*!=[[:space:]]*0'
  ["keeper.rs|settle_bet_v2"]='BET_KEEPER[[:space:]]*!=[[:space:]]*0'
  ["keeper.rs|refund_stalled_bet"]='BET_KEEPER[[:space:]]*!=[[:space:]]*0'
  ["games.rs|settle_bet"]='BET_KEEPER[[:space:]]*==[[:space:]]*0'
  ["p2p.rs|draw_jackpot"]='winning_ticket[[:space:]]*=[[:space:]]*u64::MAX'
  ["p2p.rs|settle_jackpot"]='winning_ticket[[:space:]]*!=[[:space:]]*u64::MAX'
  ["p2p.rs|settle_jackpot_v2"]='winning_ticket[[:space:]]*==[[:space:]]*u64::MAX'
  ["p2p.rs|draw_draw"]='.'
  ["p2p.rs|settle_draw"]='.'
  ["wars.rs|is_v2"]='WAR_V2'
  ["wars.rs|clock_bank"]='.'
  ["wars.rs|set_clock_bank"]='.'
  ["wars.rs|create_war_sealed"]='target_slot[[:space:]]*=[[:space:]]*WAR_V2'
  ["wars.rs|reveal_war"]='is_v2\(w\)'
  ["wars.rs|start_war"]='!is_v2\(w\)'
)
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if [ -z "${MARK[$f]+x}" ]; then fail "\`.target_slot\` touched by $f, which is not a reviewed branch (add it to tests/grep-guards.sh with its marker)"; continue; fi
  body "${f%%|*}" "${f#*|}" | grep -qE -- "${MARK[$f]}" || fail "\`.target_slot\` in $f without its marker /${MARK[$f]}/"
done < <(fns_matching '[.]target_slot')

# 5. winning_ticket
mapfile -t BAD < <(code_matching 'winning_ticket' | grep -vE '^(state\.rs|events\.rs)\|' \
  | grep -vE '^p2p\.rs\|(draw_jackpot|settle_jackpot|settle_jackpot_v2|settle_draw)\|')
[ "${#BAD[@]}" -eq 0 ] || fail "winning_ticket outside the jackpot functions" "${BAD[@]}"

# 6. reward_vault outflows in seat.rs / extra.rs / keeper.rs (source = 1st argument of move_lamports / pay_from_seat,
#    2nd of pay_in, `from:` of a system transfer; `pool` / `reward_info` are keeper.rs's locals for reward_vault)
VAULT='reward_vault|reward_info|(^|[^_A-Za-z0-9])pool([^_A-Za-z0-9]|$)'
TIP6='keeper.rs|settle_bet_v2'
while IFS= read -r f; do
  [ -n "$f" ] || continue
  b="$(body "${f%%|*}" "${f#*|}")"
  srcs="$( { echo "$b" | grep -oE '(move_lamports|pay_from_seat)\([[:space:]]*[^,]*,' || true
             echo "$b" | grep -oE 'pay_in\([[:space:]]*[^,]*,[[:space:]]*[^,]*,' | sed -E 's/^pay_in\([^,]*,//' || true
             echo "$b" | grep -oE 'from:[[:space:]]*[^,}]*' || true; } )"
  bad="$(echo "$srcs" | grep -E "$VAULT" || true)"
  if [ "$f" = "$TIP6" ] && [ -n "$bad" ]; then
    # the G-2 settle tip: one outflow, `tip` to the registered keeper wallet, computed by settle_tip + tip_payable
    n="$(echo "$bad" | grep -c . || true)"
    if [ "$n" -ne 1 ] \
      || ! echo "$b" | grep -qE 'move_lamports\(&ctx\.accounts\.reward_vault\.to_account_info\(\),[[:space:]]*&keeper_info,[[:space:]]*tip\)' \
      || ! echo "$b" | grep -qE 'let keeper_info = ctx\.accounts\.keeper\.to_account_info\(\)' \
      || ! echo "$b" | grep -qE 'tip_payable\([[:space:]]*settle_tip\('; then
      fail "settle_bet_v2: the only reward_vault outflow must be the G-2 settle tip (tip_payable(settle_tip(..)) to keeper_info)" "$bad"
    fi
    bad=""
  fi
  [ -z "$bad" ] || fail "lamports leave reward_vault in $f" "$bad"
  if echo "$b" | grep -qE "($VAULT)[^;]*try_borrow_mut_lamports"; then fail "direct lamport write on reward_vault in $f"; fi
done < <(grep -E '^(seat|extra|keeper)\.rs\|' "$DUMP" | cut -d'|' -f1,2 | sort -u)

# 6 (tip size): settle_tip stays min(KEEPER_SETTLE_TIP, half the pool share, the free pool), and the keeper account of
#   SettleBetV2 is the seat's registered wallet (has_one = keeper)
body keeper.rs settle_tip | grep -qE 'KEEPER_SETTLE_TIP\.min\(bps\(stake,[[:space:]]*EDGE_TO_POOL_BPS\)\?[[:space:]]*/[[:space:]]*2\)\.min\(free\)' \
  || fail "settle_tip must be KEEPER_SETTLE_TIP.min(bps(stake, EDGE_TO_POOL_BPS)? / 2).min(free)" "$(body keeper.rs settle_tip)"
body keeper.rs "struct SettleBetV2" | grep -qE 'has_one[[:space:]]*=[[:space:]]*keeper[[:space:]]*@' \
  || fail "SettleBetV2.keeper_seat must carry has_one = keeper (the tip goes to the registered keeper wallet only)"

# 7. review F4: DRAW_ANCHOR_SLOTS stays deleted; draw_draw fixes the next slot
mapfile -t BAD < <(code_matching 'DRAW_ANCHOR_SLOTS')
[ "${#BAD[@]}" -eq 0 ] || fail "DRAW_ANCHOR_SLOTS is back (review F4: no instruction reads it)" "${BAD[@]}"
body p2p.rs draw_draw | grep -qE 'target_slot[[:space:]]*=[[:space:]]*Clock::get\(\)\?\.slot[[:space:]]*\+[[:space:]]*1' \
  || fail "draw_draw must fix the next slot as the drawing block (review F4)"

[ "$FAIL" -eq 0 ] || exit 1
echo "grep guards OK (8.1: architect, ECO-3 chips, .game masked, target_slot branches, winning_ticket, reward_vault outflows + the G-2 tip; 7: F4 draw slot)"
