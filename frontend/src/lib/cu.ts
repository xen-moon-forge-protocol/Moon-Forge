/**
 * Compute-unit limits for every transaction the site sends (closure-matrix T4-17).
 *
 * Rule: a limit is MEASURED, never a global number.
 *   1. Before signing, the exact transaction is simulated (`simulateTransaction`, unsigned, read-only) and the
 *      units the runtime reports become the limit, with a 25% margin.
 *   2. Only when that simulation fails (state changed, RPC without `unitsConsumed`) the static value measured
 *      for that instruction in CU_MEASURED is used, with the same margin.
 *   3. An instruction that was never measured gets NO limit (the runtime default applies): a number is never
 *      applied to a path that was not measured.
 *
 * CU_MEASURED comes from simulateTransaction on X1 mainnet (read-only, no key, sigVerify off) against ONE binary:
 * program CU_MEASURED_PROGRAM whose ProgramData last-deploy slot was CU_MEASURED_DEPLOY_SLOT. The final upgrade
 * replaces the binary in place under the same program id, so the id alone proves nothing: the table is applied only
 * while (a) the program id matches, (b) INTERIM.programUpgraded is still false and (c) the live ProgramData
 * last-deploy slot, read from X1, equals the recorded one. Any other answer, or a failed read, means no static limit:
 * only the runtime simulation applies until the table is re-measured on the new binary.
 * Measurement script and table: scripts/measure-cu.mjs → scripts/CU-MEASUREMENTS.md + cu-measurements.json
 * (`npm run measure:cu`; after every program upgrade, re-run it and update CU_MEASURED_PROGRAM / CU_MEASURED_DEPLOY_SLOT).
 */
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { PROGRAM_ID_B58 } from './constants';
import { INTERIM } from '../content/interim';

/** Program the static table was measured against (rules 2 binary, 2026-10-22). */
export const CU_MEASURED_PROGRAM = '57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9';
/**
 * ProgramData last-deploy slot of that binary (read from X1 on 2026-10-22: deployed 2026-10-12 12:59:36 UTC, before the
 * measurement run of 2026-10-22 13:21 UTC; scripts/cu-measurements.json `programDataSlot`).
 */
export const CU_MEASURED_DEPLOY_SLOT = 85_429_880;

/** Units reported by simulateTransaction for ONE transaction of ONE instruction, as the site sends them. */
export const CU_MEASURED: Readonly<Record<string, number>> = {
  cancel_duel: 10_455,
  claim_airdrop: 80_648, // proof depth 9 (444-leaf Genesis tree)
  claim_artifact_chips: 21_383,
  create_duel: 29_359,
  deposit: 8_566,
  donate: 16_743,
  enter_draw: 48_467,
  enter_jackpot: 36_548,
  'forge_artifact:t0': 83_417,
  'forge_artifact:t1': 85_543,
  'forge_artifact:t2': 90_016,
  'forge_artifact:t3': 83_820,
  house_deposit: 30_004,
  house_request_withdraw: 5_650,
  join_duel: 23_260,
  open_player: 13_928,
  'place_bet:coinflip': 39_489,
  'place_bet:highlow': 39_511,
  'place_bet:voidrush': 39_510,
  recycle_artifact: 32_679,
  reveal_duel: 32_495,
  set_session: 6_143,
  system_transfer: 150, // Moon Wars move-key funding and sweep
  withdraw: 6_140,
};

/** Margin over the measured units. */
export const CU_MARGIN = 1.25;
/** Two ComputeBudget builtin instructions at 150 CU each: ours plus one a wallet may inject (priority fee). */
export const CU_BUILTIN_RESERVE = 300;
/** Runtime maximum per transaction. */
export const CU_MAX = 1_400_000;

export const cuLimit = (units: number): number => Math.min(CU_MAX, Math.ceil(units * CU_MARGIN) + CU_BUILTIN_RESERVE);

/** Static value for one instruction, or null when it was never measured (or measured for another program). Callers
 *  must also check measuredBinaryLive(): the program id survives an in-place upgrade, the numbers do not. */
export function cuFallback(name: string): number | null {
  if (PROGRAM_ID_B58 !== CU_MEASURED_PROGRAM || INTERIM.programUpgraded) return null;
  const u = CU_MEASURED[name];
  return typeof u === 'number' && u > 0 ? u : null;
}

let binaryCheck: Promise<boolean> | null = null;
/**
 * True only while the live program is the binary the table was measured on: same program id, the upgrade flag not
 * flipped, and the ProgramData last-deploy slot equal to CU_MEASURED_DEPLOY_SLOT. A definite answer is cached for the
 * page load; a failed read returns false (no static limit) and is retried on the next call.
 */
export async function measuredBinaryLive(connection: Connection): Promise<boolean> {
  if (PROGRAM_ID_B58 !== CU_MEASURED_PROGRAM || INTERIM.programUpgraded) return false;
  if (!binaryCheck) {
    binaryCheck = (async () => {
      const prog = await connection.getAccountInfo(new PublicKey(PROGRAM_ID_B58));
      if (!prog || prog.data.length < 36) return false;
      const programData = new PublicKey(prog.data.subarray(4, 36));
      const pd = await connection.getAccountInfo(programData, { dataSlice: { offset: 0, length: 12 } });
      if (!pd || pd.data.length < 12) return false;
      const slot = Number(new DataView(pd.data.buffer, pd.data.byteOffset + 4, 8).getBigUint64(0, true));
      return slot === CU_MEASURED_DEPLOY_SLOT;
    })().catch(() => { binaryCheck = null; return false; });
  }
  return binaryCheck;
}

/** Units the runtime reports for `tx` (unsigned, fee payer set, signatures not verified), or null when the
 *  simulation fails or the RPC does not report them. Existing ComputeBudget instructions are left out of the probe. */
export async function simulateUnits(connection: Connection, tx: Transaction, feePayer: PublicKey): Promise<number | null> {
  try {
    const probe = new Transaction();
    probe.feePayer = feePayer;
    probe.instructions = tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
    if (probe.instructions.length === 0) return null;
    const { value } = await connection.simulateTransaction(probe);
    if (value.err || typeof value.unitsConsumed !== 'number' || value.unitsConsumed <= 0) return null;
    return value.unitsConsumed;
  } catch {
    return null;
  }
}

/** The ComputeBudget instruction to put first in `tx`, or null when neither a simulation nor a measurement exists. */
export async function cuInstruction(connection: Connection, tx: Transaction, feePayer: PublicKey, name: string): Promise<TransactionInstruction | null> {
  let units = await simulateUnits(connection, tx, feePayer);
  // Static fallback only for the measured binary (R8): after an in-place upgrade the table is never applied.
  if (units === null && (await measuredBinaryLive(connection))) units = cuFallback(name);
  return units === null ? null : ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit(units) });
}

/** Adds the limit to a hand-built transaction (move-key paths) and returns it. */
export async function applyCu(connection: Connection, tx: Transaction, feePayer: PublicKey, name: string): Promise<Transaction> {
  const ix = await cuInstruction(connection, tx, feePayer, name);
  if (ix) tx.instructions.unshift(ix);
  return tx;
}

/** The part of an Anchor MethodsBuilder this module needs. */
export interface CuBuilder {
  transaction(): Promise<Transaction>;
  preInstructions(ixs: TransactionInstruction[], prepend?: boolean): CuBuilder;
  rpc(): Promise<string>;
}

/** Sends an Anchor builder with a measured compute-unit limit (see the module header for the three rules). */
export async function withCu(builder: CuBuilder, name: string, feePayer: PublicKey, connection: Connection): Promise<string> {
  const tx = await builder.transaction();
  const ix = await cuInstruction(connection, tx, feePayer, name);
  return (ix ? builder.preInstructions([ix], true) : builder).rpc();
}
