/**
 * Moon Forge program errors (IDL `errors`, program 57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9, IDL 2.0.0) with a
 * plain-language text and the next step for an agent. Error numbers 6000-6063 are the live program's and are frozen;
 * the final upgrade appends 6064-6100 (PROGRAM_ERRORS_V3), so an unknown code above 6100 is "a newer program than this
 * kit knows", never a mismatch.
 *
 *   import { errorMessage, programErrorName } from './errors.mjs';
 *   try { await mf.houseWithdraw(); } catch (e) { console.error(errorMessage(e)); if (programErrorName(e) === 'WithdrawLocked') ... }
 */

/** code -> { name, text (the program's message), next (what to do) } */
export const PROGRAM_ERRORS = Object.freeze({
  6000: { name: 'MathOverflow', text: 'Math overflow', next: 'Amount too large for the program; use a smaller amount.' },
  6001: { name: 'OnlyOracle', text: 'Only the oracle can do this', next: 'Oracle-only instruction; not for agents.' },
  6002: { name: 'NotPendingOracle', text: 'Only the pending oracle can accept', next: 'Oracle-only instruction; not for agents.' },
  6003: { name: 'OnlyArchitect', text: 'Only the architect can do this', next: 'Architect-only instruction; not for agents.' },
  6004: { name: 'BadEpochNumber', text: 'Epoch must be exactly last_epoch + 1', next: 'Oracle-only instruction; not for agents.' },
  6005: { name: 'EpochTooSoon', text: 'Too early: minimum interval between epochs not reached', next: 'Oracle-only instruction; not for agents.' },
  6006: { name: 'EmptyEpoch', text: 'Epoch has no score', next: 'Oracle-only instruction; not for agents.' },
  6007: { name: 'PoolEmpty', text: 'Reward pool has no free balance', next: 'The reward pool is empty; nothing to claim now.' },
  6008: { name: 'InvalidProof', text: 'Invalid Merkle proof', next: 'The leaf or proof does not match the published epoch file; re-download the epoch file from the site or a mirror.' },
  6009: { name: 'InvalidTier', text: 'Invalid tier', next: 'Tiers are 0..3.' },
  6010: { name: 'BudgetExhausted', text: 'Epoch budget exhausted', next: 'This epoch has paid its whole budget; nothing left to claim from it.' },
  6011: { name: 'ClaimWindowClosed', text: 'Claim window closed', next: 'The 90-day claim window of that epoch has ended; the leaf cannot be claimed any more.' },
  6012: { name: 'ClaimWindowOpen', text: 'Claim window still open', next: 'Closing/expiring is only possible after the 90-day claim window.' },
  6013: { name: 'EpochClosed', text: 'Epoch already closed', next: 'Nothing more to do on that epoch.' },
  6014: { name: 'NothingVested', text: 'Nothing to withdraw yet', next: 'The mission has not vested anything since the last withdrawal; wait.' },
  6015: { name: 'WrongPlayer', text: 'Wrong player account', next: 'Pass the PlayerState PDA of the wallet that owns the bet/entry (PDA.player(owner)).' },
  6016: { name: 'WrongRentPayer', text: 'Wrong rent payer account', next: 'Pass the rent_payer recorded in the account (the kit reads it for you).' },
  6017: { name: 'AmountTooSmall', text: 'Amount too small', next: 'Below the minimum: 0.01 XNT per house bet, 0.1 XNT Moon Wars stake, 1 XNT Be the House deposit.' },
  6018: { name: 'InsufficientBalance', text: 'Insufficient game balance', next: 'Deposit into the game wallet first (mf.deposit(xnt)).' },
  6019: { name: 'Unauthorized', text: 'Signer is neither the owner nor an active session key', next: 'Sign with the wallet that owns the PlayerState.' },
  6020: { name: 'SessionLimit', text: 'Stake above the session limit', next: 'Session keys have a per-bet limit; sign with the owner key or lower the stake.' },
  6021: { name: 'InvalidGame', text: 'Invalid game parameters', next: 'Check game / param / choice: Coin Flip param 0 choice 0|1, High-Low param = win chance in bps, Void Rush param = target multiplier in bps (> 10000).' },
  6022: { name: 'BankrollTooSmall', text: 'Bankroll cannot cover this bet', next: 'Lower the stake: one bet may win at most 0.25% of the free bankroll and all pending payouts together at most 20% of it.' },
  6023: { name: 'NotReady', text: 'Randomness not available yet, retry in a moment', next: 'The target slot has not passed; wait a second and retry (the kit retries for you).' },
  6024: { name: 'RoundNotOpen', text: 'Round is not open', next: 'That round is not taking entries.' },
  6025: { name: 'RoundRunning', text: 'Round is still running', next: 'Wait for the round to end, then settle.' },
  6026: { name: 'RoundNotDrawing', text: 'Round is not drawing', next: 'The round is not in its draw state.' },
  6027: { name: 'NotWinningEntry', text: 'This entry does not hold the winning ticket', next: 'Only the winning entry can be paid; close the entry to recover its rent.' },
  6028: { name: 'RoundNotSettled', text: 'Round not settled yet', next: 'Settle the round first (permissionless), then claim.' },
  6029: { name: 'DuelState', text: 'Duel is not in the expected state', next: 'Re-read the duel account; it moved on (joined, revealed, cancelled or expired).' },
  6030: { name: 'SelfDuel', text: 'Cannot duel yourself', next: 'Join a duel created by another wallet.' },
  6031: { name: 'BadCommitment', text: 'Commitment does not match', next: 'The reveal does not match the commitment: use the exact secret committed at creation.' },
  6032: { name: 'DeadlineNotReached', text: 'Reveal deadline not reached', next: 'Wait for the deadline before claiming the timeout.' },
  6033: { name: 'DeadlinePassed', text: 'Reveal deadline passed', next: 'Too late to reveal; the counterparty may claim the timeout.' },
  6034: { name: 'NotEnoughChips', text: 'Not enough chips', next: 'Lottery chips come from wagering and weekly Artifact claims; not enough for this entry.' },
  6035: { name: 'WithdrawLocked', text: 'Withdraw still locked', next: 'The 24 h Be the House cooldown has not ended; wait until houseShare().unlockTs.' },
  6036: { name: 'NoPendingWithdraw', text: 'No pending withdraw', next: 'Call houseRequestWithdraw(shares) first, then houseWithdraw() after the cooldown.' },
  6037: { name: 'NotEnoughShares', text: 'Not enough shares', next: 'Request at most houseShare().shares.' },
  6038: { name: 'SoldOut', text: 'Artifact tier sold out', next: 'No slot left in that tier; wait for a recycle or pick another tier.' },
  6039: { name: 'InvalidArtifact', text: 'Not a valid Moon Forge artifact', next: 'The asset is not a live Artifact of the Moon Forge collection (already recycled, or not minted by the program).' },
  6040: { name: 'NotArtifactOwner', text: 'You do not own this artifact', next: 'Only the current holder of the NFT can recycle or use it; check which wallet holds it.' },
  6041: { name: 'WrongElement', text: 'Artifact element does not match', next: 'The Artifact tier/element does not match what the duel expects.' },
  6042: { name: 'ChipsAlreadyClaimed', text: 'Chips already claimed for this artifact this week', next: 'One chips claim per Artifact per week; try next week.' },
  6043: { name: 'ArtifactAlive', text: 'Artifact still exists', next: 'reclaim_orphan is only for assets burned outside the program; a live Artifact must be recycled by its holder.' },
  6044: { name: 'AirdropRootSet', text: 'Airdrop root already set', next: 'Architect-only instruction; not for agents.' },
  6045: { name: 'AirdropNotSet', text: 'Airdrop not configured', next: 'The Genesis airdrop root is not set.' },
  6046: { name: 'AirdropExhausted', text: 'Airdrop allocation exhausted', next: 'All Genesis Artifacts are claimed.' },
  6047: { name: 'InvalidTarget', text: 'Invalid target account', next: 'A counter moved between your read and the send (someone forged/entered first) or an account address is wrong; re-read the counter and retry once (the kit does this for forges). Under the final upgrade (round 4), propose_oracle and accept_oracle also refuse the architect payee as the new oracle key.' },
  6048: { name: 'DropNotPending', text: 'Forge Drop seed is not pending', next: 'Nothing to seal for this epoch.' },
  6049: { name: 'DropNotSealed', text: 'Forge Drop seed not sealed yet', next: 'The keeper seals the drop after the epoch is published; try later.' },
  6050: { name: 'NoDrop', text: 'This leaf did not win a Forge Drop', next: 'Nothing to claim as a drop for this leaf.' },
  6051: { name: 'NotSoldOut', text: 'Lunar Dust is not sold out: claim the Artifact itself', next: 'Use claim_drop (the Artifact) instead of claim_drop_xnt.' },
  6052: { name: 'DropCapReached', text: "This epoch's Forge Drops are exhausted", next: 'No drop left in this epoch.' },
  6053: { name: 'SlippageExceeded', text: 'Price moved beyond your limit', next: 'Be the House: the share value moved more than your limit (pending bets reserve part of the bankroll: wait for them to settle, or pass force:true). Forge: re-quote the price.' },
  6054: { name: 'DailyLossLimit', text: 'The bankroll lost 10% today: house games resume tomorrow', next: 'Daily circuit breaker tripped; house bets reopen after 00:00 UTC.' },
  6055: { name: 'OwnerOnly', text: 'Only the wallet owner can enter player-vs-player games', next: 'Sign P2P entries with the owner key, not a session key.' },
  6056: { name: 'WarState', text: 'This Moon Wars match is not in the right state', next: 'Re-read the match: it may have started, finished, been cancelled or settled already.' },
  6057: { name: 'NotYourTurn', text: 'It is not your turn', next: 'Wait for the opponent; poll the match account.' },
  6058: { name: 'InvalidMove', text: 'Invalid move', next: 'Pick a move from legalMoves(w) on the current state.' },
  6059: { name: 'NotEnoughMana', text: 'Not enough mana', next: 'That card costs more mana than you have this turn.' },
  6060: { name: 'PredState', text: 'This prediction round is not in the right state', next: 'Re-read the round; it moved on (locked, settled or refunded).' },
  6061: { name: 'BadPriceAccount', text: 'Invalid XDEX price account', next: 'Pass the XDEX observation account the program expects (XDEX_OBSERVATION).' },
  6062: { name: 'PotFull', text: "This round's pot is full", next: 'The 200 XNT pot cap is reached; no more entries this round.' },
  6063: { name: 'AirdropClosed', text: 'The Genesis airdrop claim period has ended', next: 'The claim deadline has passed.' },
});

/**
 * Codes the final upgrade appends (6064-6100; frozen IDL `errors` of frontend/src/idl/moon_forge.v3.json) and the two
 * live codes whose message it rewords (6054, 6062). The live program never returns 6064 or above; the kit reads these
 * only to explain the upgraded program's refusals.
 */
export const PROGRAM_ERRORS_V3 = Object.freeze({
  6054: { name: 'DailyLossLimit', text: 'Counting every unsettled bet as won, the bankroll would lose more than 3% today: house games resume tomorrow (UTC)', next: 'Daily circuit breaker; house bets reopen after 00:00 UTC.' },
  6062: { name: 'PotFull', text: "This round's pot, or this side of it, is full", next: 'The Jackpot pot is capped at 20 XNT (a Predictions side at 100 XNT); no more entries this round.' },
  6064: { name: 'WithdrawExpired', text: 'This withdrawal request has expired: request again', next: 'A Be the House request can be used for 24 h after its cooldown; call houseRequestWithdraw(shares) again.' },
  6065: { name: 'SealedJoinRequired', text: 'This game now uses sealed instructions (create_war_sealed, join_war_sealed, join_duel_sealed): update your client', next: 'Use createWarSealed / joinWarSealed / joinDuelSealed.' },
  6066: { name: 'ClaimOnHold', text: 'Claims open 48 h after the epoch is published', next: 'Wait until 48 h after the epoch was published (the public can check it in that window), then claim.' },
  6067: { name: 'HoldOver', text: 'The 48-h hold has ended: this epoch can no longer be voided', next: 'Nothing to do: the epoch stands.' },
  6068: { name: 'OnlyCold', text: "Only the oracle seat's cold key can do this", next: 'Oracle-seat instruction; not for agents.' },
  6069: { name: 'SeatAlive', text: 'The oracle seat is alive: an epoch survived its hold in the last 28 days, or the seat changed hands less than 28 days ago', next: 'The seat can be taken only after 28 days without a surviving epoch.' },
  6070: { name: 'SeatDead', text: 'The oracle seat is dead: it can only be taken, not resigned', next: 'Oracle-seat instruction; not for agents.' },
  6071: { name: 'BadEpochWindow', text: 'Pass the Epoch and ExtraEpoch accounts of every epoch of the last 28 days, newest first, down to the first older one', next: 'Oracle-seat or extra-pot publication instruction; not for agents.' },
  6072: { name: 'SeatPriority', text: 'Only the priority taker can take the seat during its 24-h window', next: 'Wait for the 24-h priority window to end.' },
  6073: { name: 'SeatOpen', text: 'The seat is already open', next: 'Oracle-seat instruction; not for agents.' },
  6074: { name: 'BondTooSmall', text: 'Bond below the required minimum', next: 'Raise the bond to the required minimum.' },
  6075: { name: 'ExtraBudgetExceeded', text: 'Extra budget above 8% of the pot or 4% of the live forged floors', next: 'Oracle-only instruction; not for agents.' },
  6076: { name: 'ExtraEpochOrder', text: 'Extra epochs follow base epochs one by one, at least 6 days apart', next: 'Oracle-only instruction; not for agents.' },
  6077: { name: 'ExtraBaseEpochMissing', text: 'No base epoch with this id', next: 'That extra epoch is not published yet; read extra-<n>.json again later.' },
  6078: { name: 'ExtraClaimWindow', text: 'This extra epoch is closed or its 90-day window ended', next: 'The 90-day claim window of that extra epoch has ended.' },
  6079: { name: 'ExtraAlreadyClaimed', text: 'This extra leaf was already claimed', next: 'Nothing to do: the rebate was already paid to the leaf wallet.' },
  6080: { name: 'ListingBelowFloor', text: "The seller would receive less than this Artifact's floor (or the price is below 0.1 XNT): recycle it instead", next: 'List at or above minimumListPrice(backing), or recycle the Artifact for its floor.' },
  6081: { name: 'InvalidExpiry', text: 'Expiry must be in the future and at most 90 days away', next: 'Pick an expiry between now and 90 days from now.' },
  6082: { name: 'ListingExpired', text: 'This listing has expired', next: 'The listing ended; anyone can close it (closeListing) and the seller can list again.' },
  6083: { name: 'ListingReserved', text: 'This listing is reserved for another buyer', next: 'Only the reserved wallet can buy it.' },
  6084: { name: 'ListingStale', text: 'The seller no longer holds this Artifact', next: 'The listing is stale; anyone can close it (closeListing).' },
  6085: { name: 'ListingPriceChanged', text: 'The listing price changed: review it again', next: 'Re-read the listing (artifactInfo) and decide again at the new price.' },
  6086: { name: 'ListingActive', text: 'This listing is still valid: only the seller can close it', next: 'Only the seller can delist a live listing before it expires.' },
  6087: { name: 'SelfPurchase', text: 'Buyer and seller are the same wallet', next: 'Delist instead of buying your own listing.' },
  6088: { name: 'KeeperRequired', text: 'House bets use place_bet_v2 and the keeper chain since the final upgrade', next: 'Use placeBetV2 (the keeper reveals the bet); a pending keeper bet waits with waitBet(bet).' },
  6089: { name: 'KeeperNotArmed', text: 'The house keeper has no chain positions left: wait for it to re-arm', next: 'Wait for the keeper to re-arm (houseKeeper().armed).' },
  6090: { name: 'BadReveal', text: 'Reveal does not match the chain head, it is out of order, or the new tip repeats the current head', next: 'Keeper instruction; not for agents.' },
  6091: { name: 'OnlyKeeper', text: 'Only the house keeper can do this', next: 'Keeper instruction; not for agents.' },
  6092: { name: 'BetNotStalled', text: 'This bet is not stalled yet', next: 'Wait: a never-anchored bet is refundable 512 slots after placement, an anchored one about a day later (betStatus(bet)).' },
  6093: { name: 'KeeperBusy', text: 'Bets or a Jackpot round are pending: settle or refund them first', next: 'Keeper instruction; not for agents.' },
  6094: { name: 'KeeperBondTooSmall', text: 'The keeper bond does not cover the pending payouts', next: 'The keeper bond is full for now: wait for pending bets to settle, or lower the stake.' },
  6095: { name: 'WeeklyLossLimit', text: 'The bankroll would lose more than 15% over 7 days: house games resume when the window rolls', next: 'Weekly limit reached; house bets reopen when the 7-day window rolls.' },
  6096: { name: 'KeeperNotice', text: 'The 7-day keeper notice (hand-over or bond withdrawal) has not elapsed', next: 'Keeper instruction; not for agents.' },
  6097: { name: 'KeeperAlive', text: 'The keeper seat is alive: it was active in the last 28 days', next: 'A keeper seat can be taken only after 28 days of inactivity.' },
  // the program's frozen message is quoted verbatim in `text` (it is the IDL's); errorMessage() shows `display` instead
  6098: { name: 'ChipsRetired', text: 'Weekly chips are retired since the final upgrade', next: 'Weekly chips are retired since the final upgrade; nothing to claim.' }, // wording:allow (the program's frozen IDL message)
  6099: { name: 'BetStalled', text: 'This bet is stalled (block gone, reveal overdue or position skipped): refund it with refund_stalled_bet', next: 'Call refundStalledBet(bet) (permissionless).' },
  6100: { name: 'LotteryRetired', text: 'Burn Lottery tickets are retired since the final upgrade', next: 'Nothing to enter; open rounds still settle and their entries close.' },
});

/**
 * The refusal the kit raises (nothing sent) for a live-program call that the upgraded program retired: it carries the
 * program's code and name, so programErrorName(e) / errorMessage(e) read it like the on-chain refusal it avoids.
 */
export function retiredError(name, what, hint = null) {
  const entry = Object.entries(PROGRAM_ERRORS_V3).find(([, v]) => v.name === name);
  const code = entry ? Number(entry[0]) : null;
  const e = new Error(`${what}: the upgraded program retired this call (${name}${code ? `, ${code}` : ''}): ${hint ?? entry?.[1].next ?? 'update the call'}. Nothing was sent.`);
  if (code) e.code = code;
  e.retired = true;
  return e;
}

const HEX_RE = /custom program error: 0x([0-9a-f]+)/i;
const ANCHOR_RE = /Error Code: (\w+)\. Error Number: (\d+)\./;

/** The program error number carried by an error, or null (AnchorError, SendTransactionError logs, RPC strings, {err:{InstructionError}}). */
export function programErrorNumber(e) {
  if (e == null) return null;
  if (typeof e === 'number') return Number.isInteger(e) ? e : null;
  const n = e?.error?.errorCode?.number ?? e?.errorCode?.number ?? e?.code;
  if (Number.isInteger(n) && n >= 6000) return n;
  const logs = e?.logs ?? e?.transactionLogs ?? e?.error?.logs;
  if (Array.isArray(logs)) {
    for (const l of logs) {
      const m = ANCHOR_RE.exec(l);
      if (m) return Number(m[2]);
      const h = HEX_RE.exec(l);
      if (h) return parseInt(h[1], 16);
    }
  }
  const s = typeof e === 'string' ? e : String(e?.message ?? '');
  const m = ANCHOR_RE.exec(s);
  if (m) return Number(m[2]);
  const h = HEX_RE.exec(s);
  if (h) return parseInt(h[1], 16);
  const custom = e?.err?.InstructionError?.[1]?.Custom ?? e?.InstructionError?.[1]?.Custom;
  if (Number.isInteger(custom)) return custom;
  return null;
}

/** The program error name ('InvalidTarget', 'SlippageExceeded', ...) or null. */
export function programErrorName(e) {
  const n = programErrorNumber(e);
  if (n == null) return null;
  return PROGRAM_ERRORS[n]?.name ?? PROGRAM_ERRORS_V3[n]?.name ?? e?.error?.errorCode?.code ?? null;
}

/** URLs inside an RPC error text, cut to their origin (a private endpoint's key in a path or query stays out of logs). */
export const redactUrls = (s) => s.replace(/\b(?:https?|wss?):\/\/[^\s'"<>()]+/gi, (u) => { try { return new URL(u).origin; } catch { return '(url)'; } });
const LANDED_HINT = /may have landed|may still land|already processed/i;

/**
 * One line a human or an agent can act on, for any error the kit may throw (program, RPC, pre-flight, timeout).
 * An error that carries `mayHaveLanded` (a send that failed in transit, a relayed refusal) always ends with the
 * signature to check before sending again.
 */
export function errorMessage(e, { rules = 2 } = {}) {
  const text = describe(e, rules);
  if (e?.mayHaveLanded && e?.signature && !LANDED_HINT.test(text)) {
    return `${text} The transaction may have landed anyway: check the signature ${e.signature} on the explorer before sending again.`;
  }
  return text;
}

function describe(e, rules = 2) {
  if (e == null) return 'Unknown error';
  const n = programErrorNumber(e);
  if (n != null) {
    const known = (rules === 3 && PROGRAM_ERRORS_V3[n]) || PROGRAM_ERRORS[n] || PROGRAM_ERRORS_V3[n];
    if (known) return e?.retired ? String(e.message) : `${known.display ?? known.text} (${known.name}, ${n}). ${known.next}`;
    if (n >= 6101 && n < 7000) return `Program error ${n}: this kit does not know it (a newer program than the kit; update the kit).`;
    if (n < 6000) return `Custom error ${n} of another program in the transaction (System, Compute Budget or Metaplex Core): ${String(e?.message ?? '').slice(0, 160)}`;
  }
  const fw = e?.error?.errorCode?.number;
  if (Number.isInteger(fw) && fw < 6000) return `Anchor framework error ${fw}${e.error.errorMessage ? `: ${e.error.errorMessage}` : ''} (wrong account, seed or signer; check the accounts you passed).`;
  if (e?.error?.errorMessage) return `${e.error.errorMessage}${e.error.errorCode?.code ? ` (${e.error.errorCode.code})` : ''}`;
  const msg = redactUrls(typeof e === 'string' ? e : String(e?.message ?? e));
  const sig = typeof e?.signature === 'string' && e.signature ? e.signature : null;
  if (/already been processed|AlreadyProcessed/i.test(msg)) {
    return `The network already processed this transaction: it landed or is landing. Do not send it again${sig ? `; check the signature ${sig} on the explorer` : ''}.`;
  }
  if (/insufficient (lamports|funds)|debit an account but found no record/i.test(msg)) return 'Not enough XNT in the wallet for the fee, rent or amount. Top up the wallet first.';
  if (/blockhash not found/i.test(msg)) return 'The transaction expired before it was processed (stale blockhash). Nothing was spent; retry.';
  if (/was not confirmed|TransactionExpired|block height exceeded|Timed out|timeout/i.test(msg)) return 'The network did not confirm the transaction in time. Check its signature on the explorer before sending again: it may still land.';
  if (/429|Too Many Requests/i.test(msg)) return 'The RPC is rate-limiting you (429). Slow down or use your own RPC (connect({ rpcs: [...] }) or X1_RPC_URLS).';
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|socket hang up/i.test(msg)) {
    return sig
      ? `RPC unreachable (${msg.slice(0, 80)}) after the transaction was signed: it may have landed: check the signature ${sig} on the explorer before sending again.`
      : `RPC unreachable (${msg.slice(0, 80)}). The kit fails over to the next endpoint when you configure more than one.`;
  }
  if (/Unknown action/.test(msg)) return 'The transaction failed on-chain because the state changed after the preview (a round closed, a counter moved, a price moved). Only the fee was spent; refresh and retry.';
  if (/Signature verification failed/i.test(msg)) return 'Signature verification failed: the wallet that signed is not the one the instruction expects.';
  return msg.slice(0, 300);
}
