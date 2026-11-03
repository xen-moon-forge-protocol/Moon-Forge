/**
 * Compute-unit limits for every transaction the oracle sends (X1-V4-AUDIT MED-2, LOW-2, LOW-5).
 *
 * X1 charges a fee per compute unit REQUESTED: 10 lamports per unit plus 1,500 for the limit instruction
 * (agents/kit/moonforge.mjs feeLamports). Without a limit every instruction requests the runtime default of 200,000
 * units, about 0.002 XNT per instruction, three to ten times what a measured limit costs. Priority fees read as zero on
 * X1 (getRecentPrioritizationFees), so nothing here ever sets a compute-unit price.
 *
 * The rule, for every transaction (sendWithCuV3):
 *   1. simulate the exact instructions at "confirmed" (nothing signed, nothing sent) and request the units it consumed
 *      × 1.2, rounded up to 1,000 (the kit's limitFor); a simulation the program refuses is reported as that refusal,
 *      with no fee spent;
 *   2. when the node cannot simulate (an RPC error, a client without the method), request an explicit FALLBACK: per
 *      program instruction, the most this process measured for that instruction × 1.5 (rounded up to 1,000), or the
 *      runtime default of 200,000 units for one never measured (the suites prove every v3 instruction fits under it);
 *      capped at 1,400,000. Never "no limit": the fee is then known before sending (feeOfLimitV3);
 *   3. a send refused for compute exhaustion (a state that grew between the measurement and the send) is retried ONCE
 *      with the runtime default per instruction. The refused attempt was rejected by the pre-flight simulation or rolled
 *      back on chain, so a retry can never execute anything twice.
 */
import type * as anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, PublicKey, Signer, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

/** the runtime's maximum per transaction, and the limit every measuring simulation runs with */
export const CU_SIM_UNITS = 1_400_000;
/** the runtime's default per instruction when a transaction requests no limit */
export const CU_DEFAULT_PER_IX = 200_000;
/** X1's fee model (kit feeLamports): lamports per requested unit, and the cost of the limit instruction itself */
export const LAMPORTS_PER_CU = 10n;
export const CU_LIMIT_IX_LAMPORTS = 1_500n;
/** margin of a fallback built from an earlier measurement of the same instruction in this process (basis points) */
export const CU_FALLBACK_MARGIN_BPS = 15_000;

/** The limit to request for `consumed` measured units: × 1.2, rounded up to 1,000, between 1,000 and 1.4M. */
export function cuLimitForV3(consumed: number): number {
  return Math.min(CU_SIM_UNITS, Math.max(1_000, Math.ceil((consumed * 1.2) / 1_000) * 1_000));
}
/** the limit instruction a transaction carries (and what the size check counts for it: its data does not depend on the units) */
export const cuIxV3 = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });

/**
 * X1's fee of one transaction (lamports, pure): 1,500 + 10 × the requested limit; with no limit instruction at all,
 * 10 × the runtime default per program instruction (2,000,000 each, capped at the 1.4M-unit maximum). LOW-2.
 */
export function feeOfLimitV3(units: number | null, programIxs = 1): bigint {
  if (units === null) return LAMPORTS_PER_CU * BigInt(Math.min(CU_SIM_UNITS, CU_DEFAULT_PER_IX * Math.max(1, programIxs)));
  return CU_LIMIT_IX_LAMPORTS + LAMPORTS_PER_CU * BigInt(units);
}

/** The units the instructions consume, by a simulation at "confirmed" (null: the node cannot simulate); throws on a program refusal. */
export async function measureCuV3(connection: Connection, payer: PublicKey, ixs: TransactionInstruction[]): Promise<number | null> {
  const sim = (connection as { simulateTransaction?: unknown }).simulateTransaction;
  if (typeof sim !== "function") return null;
  let r: Awaited<ReturnType<Connection["simulateTransaction"]>>;
  try {
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: [cuIxV3(CU_SIM_UNITS), ...ixs] }).compileToV0Message();
    r = await connection.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  } catch {
    return null;
  }
  if (r.value.err) {
    const why = (r.value.logs ?? []).find((l) => /Error Code|failed|insufficient/i.test(l)) ?? JSON.stringify(r.value.err);
    throw new Error(`refused in simulation (nothing was sent): ${why.slice(0, 200)}`);
  }
  return typeof r.value.unitsConsumed === "number" && r.value.unitsConsumed > 0 ? r.value.unitsConsumed : null;
}

const isCuIx = (ix: TransactionInstruction) => ix.programId.equals(ComputeBudgetProgram.programId);
/** an instruction's identity for the fallback memory: its program and its 8-byte discriminator */
export const cuKeyOfV3 = (ix: TransactionInstruction) => `${ix.programId.toBase58()}:${Buffer.from(ix.data.subarray(0, 8)).toString("hex")}`;

/**
 * Per-process memory of measured units (LOW-5: the fallback of a node that cannot simulate). Single-instruction
 * transactions record their instruction; every transaction also records its exact instruction list.
 */
export class CuMemoV3 {
  private readonly one = new Map<string, number>();
  private readonly list = new Map<string, number>();
  record(ixs: TransactionInstruction[], consumed: number): void {
    const prog = ixs.filter((ix) => !isCuIx(ix));
    if (!prog.length || !(consumed > 0)) return;
    const lk = prog.map(cuKeyOfV3).join(",");
    this.list.set(lk, Math.max(this.list.get(lk) ?? 0, consumed));
    if (prog.length === 1) this.one.set(lk, Math.max(this.one.get(lk) ?? 0, consumed));
  }
  /** the most measured for exactly this instruction list, else null */
  ofList(ixs: TransactionInstruction[]): number | null {
    return this.list.get(ixs.filter((ix) => !isCuIx(ix)).map(cuKeyOfV3).join(",")) ?? null;
  }
  /** the most measured for this instruction alone, else null */
  ofOne(ix: TransactionInstruction): number | null {
    return this.one.get(cuKeyOfV3(ix)) ?? null;
  }
  clear(): void {
    this.one.clear();
    this.list.clear();
  }
}
/** the process-wide memory every send records into */
export const CU_MEMO = new CuMemoV3();

const withMargin = (units: number) => Math.ceil((units * CU_FALLBACK_MARGIN_BPS) / 10_000 / 1_000) * 1_000;

/**
 * The fallback limit of instructions nobody could simulate now (pure given the memory): the exact list measured
 * earlier × 1.5; else per instruction its own earlier measurement × 1.5 or the runtime default 200,000; capped at 1.4M.
 */
export function cuFallbackV3(ixs: TransactionInstruction[], memo: CuMemoV3 = CU_MEMO): number {
  const prog = ixs.filter((ix) => !isCuIx(ix));
  const whole = memo.ofList(prog);
  if (whole !== null) return Math.min(CU_SIM_UNITS, Math.max(1_000, withMargin(whole)));
  const sum = prog.reduce((s, ix) => {
    const m = memo.ofOne(ix);
    return s + (m === null ? CU_DEFAULT_PER_IX : withMargin(m));
  }, 0);
  return Math.min(CU_SIM_UNITS, Math.max(1_000, sum));
}

/** What a transaction will request: `units`, and whether they come from a measurement of these very instructions. */
export interface CuPlanV3 {
  units: number;
  measured: boolean;
}

/** The plan for `ixs`: measured × 1.2 when the node simulates (recorded in `memo`), else the explicit fallback. Throws on a refusal. */
export async function cuPlanV3(connection: Connection, payer: PublicKey, ixs: TransactionInstruction[], memo: CuMemoV3 = CU_MEMO): Promise<CuPlanV3> {
  const prog = ixs.filter((ix) => !isCuIx(ix));
  const consumed = await measureCuV3(connection, payer, prog);
  if (consumed !== null) {
    memo.record(prog, consumed);
    return { units: cuLimitForV3(consumed), measured: true };
  }
  return { units: cuFallbackV3(prog, memo), measured: false };
}

/** A plan from a simulation the caller already ran (seat-v3 dry runs): its units × 1.2, else the fallback. */
export function cuPlanOfUnitsV3(consumed: number | null | undefined, ixs: TransactionInstruction[], memo: CuMemoV3 = CU_MEMO): CuPlanV3 {
  const prog = ixs.filter((ix) => !isCuIx(ix));
  if (typeof consumed === "number" && consumed > 0) {
    memo.record(prog, consumed);
    return { units: cuLimitForV3(consumed), measured: true };
  }
  return { units: cuFallbackV3(prog, memo), measured: false };
}

/** True when a send failed because the requested compute-unit limit was too low (pre-flight or on chain). */
export function cuExhaustedV3(e: unknown): boolean {
  const x = e as { message?: unknown; logs?: unknown; transactionLogs?: unknown } | null;
  const logs = [x?.logs, x?.transactionLogs].flatMap((l) => (Array.isArray(l) ? l.map(String) : []));
  const text = [String(x?.message ?? e ?? ""), ...logs].join("\n");
  return /exceeded CUs meter|ComputationalBudgetExceeded|Computational budget exceeded|exceeded maximum compute/i.test(text);
}

export interface SendCuOptsV3 {
  /** the fee payer the simulation runs as (default: the provider's wallet, else the first signer) */
  payer?: PublicKey;
  /** a plan made by the caller (the upkeep guard priced it first); else measured here */
  plan?: CuPlanV3;
  memo?: CuMemoV3;
  /** told when the one retry for compute exhaustion happens */
  log?: (s: string) => void;
}

/**
 * Sends `ixs` (any ComputeBudget instruction among them is replaced) with the plan's limit first, through
 * `provider.sendAndConfirm`; on compute exhaustion, once more with the runtime default per instruction. Returns the
 * signature. A simulation the program refuses throws before anything is signed.
 */
export async function sendWithCuV3(provider: anchor.Provider, ixs: TransactionInstruction[], signers: Signer[] = [], o: SendCuOptsV3 = {}): Promise<string> {
  const prog = ixs.filter((ix) => !isCuIx(ix));
  if (!prog.length) throw new Error("sendWithCuV3: no instruction to send");
  const payer = o.payer ?? provider.publicKey ?? signers[0]?.publicKey;
  if (!payer) throw new Error("sendWithCuV3: no fee payer");
  const memo = o.memo ?? CU_MEMO;
  const plan = o.plan ?? (await cuPlanV3(provider.connection, payer, prog, memo));
  const send = (units: number) => provider.sendAndConfirm!(new Transaction().add(cuIxV3(units), ...prog), signers);
  try {
    return await send(plan.units);
  } catch (e) {
    const wider = Math.min(CU_SIM_UNITS, CU_DEFAULT_PER_IX * prog.length);
    if (!cuExhaustedV3(e) || wider <= plan.units) throw e;
    o.log?.(`  the compute-unit limit ${plan.units} was too low for this state: retrying once with ${wider}`);
    return send(wider);
  }
}

/** An Anchor methods builder sent with a compute-unit limit (its pre- and post-instructions included). */
export async function rpcWithCuV3(builder: { transaction(): Promise<Transaction> }, provider: anchor.Provider, signers: Signer[] = [], o: SendCuOptsV3 = {}): Promise<string> {
  const tx = await builder.transaction();
  return sendWithCuV3(provider, tx.instructions, signers, o);
}
