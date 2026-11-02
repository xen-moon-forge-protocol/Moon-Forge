/**
 * Per chain: `verify --full` per chain (pure helpers; index.ts verifyV3 and health-verify.ts use them).
 *
 * A v3 `verify <file> --full` re-reads each chain's burns and portal counters from that chain's RPCs. One chain's RPC
 * failure used to end the whole run, so a single bad endpoint left every other chain unverified, and the run took as
 * long as the slowest chain (24 min for epoch 1). Now:
 *   - `--chain=<id>[,<id>…]` limits the re-read to those chains (the file-level checks still run: the publication, the
 *     chain link, the snapshot time, the recomputation);
 *   - each chain is checked on its own: an RPC failure is that chain's "error", a disagreement its "failed"; the others
 *     are still checked;
 *   - the run prints one machine-readable line, `VERIFY-CHAINS {"<chainId>": {"status", "detail"}, …}`, and exits
 *     0 (every chain ok), 1 (VERIFICATION FAILED: a disagreement, file-level or on a chain) or 2 (VERIFICATION
 *     INCOMPLETE: no disagreement, but a chain or a file-level read (the publication, the snapshot block time) could
 *     not be read; the next run retries it; verifyOutcomeV3).
 * health-verify.ts runs one `--chain=<id>` process per chain, each with its own time limit, keeps a chain verified
 * green while the file's data hash is unchanged, and re-runs only the chains that did not finish.
 * v2 files keep their own verifier unchanged (the live path stays byte-identical).
 */

export type ChainStatus = "ok" | "failed" | "error";
export interface ChainResult {
  status: ChainStatus;
  detail: string;
}
export const CHAIN_LINE = "VERIFY-CHAINS ";
export const DETAIL_MAX = 300;

/** `--chain=<id>[,<id>…]` from argv: null when absent (every chain); a malformed value throws. */
export function chainsArg(argv: string[]): number[] | null {
  const args = argv.filter((a) => a === "--chain" || a.startsWith("--chain="));
  if (!args.length) return null;
  if (args.length > 1) throw new Error("--chain given more than once");
  const v = args[0].slice("--chain=".length);
  if (!/^\d+(,\d+)*$/.test(v)) throw new Error(`--chain=${v}: expected chain ids, e.g. --chain=56 or --chain=10,56`);
  return [...new Set(v.split(",").map(Number))];
}

/** The chains a v3 `--full` run re-reads: listed, not skipped, with a block range (the order of the file). */
export function chainsToVerify(f: { chains: { chainId: number; skipped?: boolean; toBlock: number; fromBlockExclusive: number }[] }): number[] {
  return f.chains.filter((c) => !c.skipped && c.toBlock > c.fromBlockExclusive).map((c) => c.chainId);
}

/** The machine-readable line of a run, keys sorted. */
export function chainLine(results: Record<string, ChainResult>): string {
  const sorted = Object.fromEntries(Object.keys(results).sort((a, b) => Number(a) - Number(b)).map((k) => [k, { status: results[k].status, detail: results[k].detail.slice(0, DETAIL_MAX) }]));
  return CHAIN_LINE + JSON.stringify(sorted);
}

/**
 * the file-level reads of a run that returned nothing (verifyOutcomeV3's `unreadable`), printed as one
 * machine-readable line, `VERIFY-UNREADABLE ["…", …]`, whenever there is one. health-verify.ts never counts a chain as
 * green from such a run, and turns a miss that lasts into red (health-rules.ts UNREADABLE_RED_S).
 */
export const UNREADABLE_LINE = "VERIFY-UNREADABLE ";
export function unreadableLine(unreadable: string[]): string {
  return UNREADABLE_LINE + JSON.stringify(unreadable.map((s) => s.slice(0, DETAIL_MAX)));
}
/** The reads of the last VERIFY-UNREADABLE line of a run's output; null when there is none. A malformed line still counts as a miss. */
export function parseUnreadableLine(output: string): string[] | null {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith(UNREADABLE_LINE));
  if (!lines.length) return null;
  try {
    const v = JSON.parse(lines[lines.length - 1].slice(UNREADABLE_LINE.length));
    if (Array.isArray(v) && v.length) return v.map((s) => String(s).slice(0, DETAIL_MAX));
  } catch {
    // fall through: fail closed
  }
  return ["a file-level read returned nothing (unparsed VERIFY-UNREADABLE line)"];
}

/** The last VERIFY-CHAINS line of a run's output (null when there is none or it is malformed). */
export function parseChainLine(output: string): Record<string, ChainResult> | null {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith(CHAIN_LINE));
  if (!lines.length) return null;
  try {
    const v = JSON.parse(lines[lines.length - 1].slice(CHAIN_LINE.length));
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out: Record<string, ChainResult> = {};
    for (const [k, r] of Object.entries(v as Record<string, { status?: unknown; detail?: unknown }>)) {
      if (!/^\d+$/.test(k) || !r || !["ok", "failed", "error"].includes(String(r.status))) return null;
      out[k] = { status: r.status as ChainStatus, detail: String(r.detail ?? "").slice(0, DETAIL_MAX) };
    }
    return out;
  } catch {
    return null;
  }
}

/** One status for a set of per-chain results: failed if any chain failed, else error if any could not finish, else ok. */
export function combineChains(results: Record<string, ChainResult>): { status: ChainStatus; detail: string } {
  const ids = Object.keys(results).sort((a, b) => Number(a) - Number(b));
  const by = (s: ChainStatus) => ids.filter((k) => results[k].status === s);
  const failed = by("failed");
  const error = by("error");
  const ok = by("ok");
  const status: ChainStatus = failed.length ? "failed" : error.length ? "error" : "ok";
  const parts: string[] = [];
  if (failed.length) parts.push(`failed on chain ${failed.map((k) => `${k} (${results[k].detail.slice(0, 120)})`).join(", ")}`);
  if (error.length) parts.push(`could not finish on chain ${error.map((k) => `${k} (${results[k].detail.slice(0, 120)})`).join(", ")}`);
  if (ok.length) parts.push(`verified on chain ${ok.join(", ")}`);
  return { status, detail: (parts.join("; ") || "no chain to re-read").slice(0, DETAIL_MAX) };
}

/**
 * Checks each chain on its own (index.ts verifyV3 --full): `check` pushes the chain's disagreements to `errors` and
 * throws when the chain cannot be read. A chain with new errors is "failed" (also when it then threw: a disagreement
 * found is never downgraded), one that threw first is "error" (its RPC; the others are still checked), else "ok".
 * Only the chains of `reread` (and of `only`, when given) are checked, in the file's order.
 */
export async function checkChains<C extends { chainId: number; name: string }>(
  chains: C[], reread: number[], only: number[] | null, errors: string[], check: (c: C) => Promise<void>, log: (s: string) => void = () => undefined,
): Promise<Record<string, ChainResult>> {
  const out: Record<string, ChainResult> = {};
  for (const c of chains) {
    if (!reread.includes(c.chainId) || (only && !only.includes(c.chainId))) continue;
    const before = errors.length;
    try {
      await check(c);
      out[c.chainId] = errors.length > before ? { status: "failed", detail: errors.slice(before).join("; ").slice(0, DETAIL_MAX) } : { status: "ok", detail: `${c.name}: logs and counters agree` };
    } catch (e) {
      const why = String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 200);
      if (errors.length > before) out[c.chainId] = { status: "failed", detail: [...errors.slice(before), `then: ${why}`].join("; ").slice(0, DETAIL_MAX) };
      else out[c.chainId] = { status: "error", detail: `${c.name}: ${why}` };
      log(`(${c.name}: could not be re-read to the end: ${why}; the other chains are still checked)`);
    }
  }
  return out;
}

/** The exit code of a run: 1 = a disagreement (file-level errors or a failed chain), 2 = a chain could not finish, 0 = verified. */
export function chainsExitCode(fileErrors: number, results: Record<string, ChainResult>): 0 | 1 | 2 {
  const s = combineChains(results).status;
  if (fileErrors > 0 || s === "failed") return 1;
  return s === "error" ? 2 : 0;
}

/**
 * The outcome of a v3 `verify` run (index.ts verifyV3; pure, tested). `errors` are disagreements: the file and what
 * was read differ (exit 1, VERIFICATION FAILED, red). `unreadable` are file-level reads that returned nothing: the
 * publication transaction, the previous epoch's publication, the snapshot slot's block time. An RPC node that does not
 * have them answers null, which proves nothing, so they are exit 2 (VERIFICATION INCOMPLETE, warn, retried by the
 * next run), never red on their own. A chain that could not be read is exit 2 as well.
 */
export function verifyOutcomeV3(errors: string[], unreadable: string[], results: Record<string, ChainResult>): { exit: 0 | 1 | 2; detail: string } {
  const exit = chainsExitCode(errors.length, results);
  if (exit === 1) return { exit, detail: errors.join("; ") || combineChains(results).detail };
  const c = combineChains(results);
  const parts = [...unreadable, ...(c.status === "error" ? [c.detail] : [])];
  if (parts.length) return { exit: 2, detail: parts.join("; ") };
  return { exit: 0, detail: "" };
}
