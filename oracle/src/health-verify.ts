/**
 * Verification for the daily health check (npm run health-verify; IMMUTABILITY.md "verification green").
 *
 * Runs `npm run verify -- <file> --full` (index.ts verify: recomputes the epoch from public data and compares it with
 * X1) on the NEWEST published epoch file of EPOCHS_DIR, and on its extra file when there is one, and writes the result
 * to VERIFY_JSON (default ../ops/verification.json in Actions). A file the previous result (VERIFY_PREV) already
 * verified green with the same data hash is carried over without a new run (VERIFY_FORCE=true re-runs it), so the full
 * run happens about once a week, after each publication.
 *
 * Per chain: a v3 epoch file is verified one chain at a time (`verify <file> --full --chain=<id>`, one process
 * each, each with its own time limit VERIFY_CHAIN_TIMEOUT_MS inside the run's VERIFY_TIMEOUT_MS), and the result is kept
 * per chain (`chains` of the entry). One chain's RPC failure no longer blocks the others: that chain is "error" and the
 * next run re-runs only the chains that are not green yet (a green chain is carried over while the data hash is
 * unchanged). v2 files and extra files are verified whole, as before.
 *
 * Per file: "ok" (exit 0), "failed" (the verifier printed VERIFICATION FAILED: the file and the chain disagree), or
 * "error" (it could not finish: an RPC outage, a timeout, a file-level read that returned nothing; the next run retries).
 * In a per-chain run a failure on the file itself (not on a chain) is red only when the previous run on the same data
 * hash failed on the file too; a first one is "error". A chain is green only from a run that was green
 * as a whole (a run that could not read the publication data never carries a chain over). A file-level read
 * that returns nothing (the VERIFY-UNREADABLE line) is counted run after run on the same data hash (`unreadableSince`,
 * `unreadableRuns`); health-rules.ts turns it red after UNREADABLE_RED_RUNS runs and UNREADABLE_RED_S.
 * Read-only: no key, no transaction.
 * Always exits 0: the health check (health.ts "verification" row) judges the result.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { EPOCHS_DIR } from "./config";
import type { VerificationChain, VerificationEntry, VerificationFile } from "./health-rules";
import { ChainResult, chainsToVerify, combineChains, parseChainLine, parseUnreadableLine } from "./verify-chains";

const OUT = process.env.VERIFY_JSON || (process.env.GITHUB_ACTIONS ? "../ops/verification.json" : "verification.json");
const PREV = process.env.VERIFY_PREV || (process.env.GITHUB_ACTIONS ? "prev-verify/verification.json" : "");
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 40 * 60_000);
/** Per chain: the most one chain's run may take (a hung RPC costs that chain only) */
const CHAIN_TIMEOUT_MS = Number(process.env.VERIFY_CHAIN_TIMEOUT_MS || 20 * 60_000);
/** a chain run is not started with less than this left in the run's budget (it is "error: not run", retried next time) */
const MIN_RUN_MS = 2 * 60_000;
/** the part of the run's budget the per-chain runs leave to the extra file, verified after them */
const EXTRA_RESERVE_MS = Number(process.env.VERIFY_EXTRA_RESERVE_MS || 5 * 60_000);

/** The newest published epoch file and its extra file, when present (the files the site serves). */
export function newestFiles(dir: string): { kind: "epoch" | "extra"; file: string; epoch: number; dataHash: string }[] {
  if (!fs.existsSync(dir)) return [];
  const read = (f: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
  const epochs = fs.readdirSync(dir).filter((f) => /^epoch-\d+\.json$/.test(f)).map((f) => ({ f, j: read(f) })).filter((x) => x.j && x.j.publish && Number.isSafeInteger(x.j.epoch));
  if (!epochs.length) return [];
  const top = epochs.reduce((m, x) => (x.j.epoch > m.j.epoch ? x : m));
  const out: { kind: "epoch" | "extra"; file: string; epoch: number; dataHash: string }[] = [{ kind: "epoch", file: top.f, epoch: top.j.epoch, dataHash: String(top.j.dataHash) }];
  const xf = `extra-${top.j.epoch}.json`;
  const x = fs.existsSync(path.join(dir, xf)) ? read(xf) : null;
  if (x && x.kind === "extra") out.push({ kind: "extra", file: xf, epoch: Number(x.epoch), dataHash: String(x.dataHash ?? "") });
  return out;
}

/** Per chain: the chains a v3 epoch file is verified on one by one; null for a v2 or extra file (verified whole) or an unreadable one. */
export function chainsOfFile(dir: string, file: string): number[] | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    if (!j || j.version !== 3 || j.kind === "extra" || !Array.isArray(j.chains)) return null;
    return chainsToVerify(j);
  } catch {
    return null;
  }
}

/** "ok" / "failed" / "error" from the verifier's exit status and output (pure; tested). `timeoutMs`: the limit the run had. */
export function classify(status: number | null, output: string, timedOut: boolean, timeoutMs: number = TIMEOUT_MS): { status: VerificationEntry["status"]; detail: string } {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (status === 0 && !timedOut) return { status: "ok", detail: (lines.find((l) => /verified/.test(l)) ?? "verified").slice(0, 300) };
  const i = lines.findIndex((l) => /VERIFICATION FAILED/.test(l));
  if (i >= 0) return { status: "failed", detail: lines.slice(i + 1, i + 6).join(" ").slice(0, 300) || "VERIFICATION FAILED" };
  if (timedOut) return { status: "error", detail: `timed out after ${Math.max(1, Math.round(timeoutMs / 60_000))} min` };
  const incomplete = lines.find((l) => /VERIFICATION INCOMPLETE/.test(l));
  if (incomplete) return { status: "error", detail: incomplete.slice(0, 300) };
  return { status: "error", detail: (lines.filter((l) => /error|Error|ECONN|timed out|429|503/.test(l)).slice(-2).join(" ") || `exit ${status}`).slice(0, 300) };
}

/**
 * Per chain (pure; tested): one chain's result from its own run. The chain's line wins when the run printed one; a run that
 * FAILED while its own chain agreed failed on the file itself (`fileFailure`); a run with no line is that chain's outcome.
 */
export function chainOutcome(chainId: number, run: { status: VerificationEntry["status"]; detail: string }, output: string): { chain: ChainResult; fileFailure: string | null } {
  const line = parseChainLine(output)?.[String(chainId)];
  if (run.status === "failed" && (!line || line.status === "ok")) return { chain: line ?? { status: "error", detail: "not checked: the file itself failed" }, fileFailure: run.detail };
  // Fail closed: a chain is green only from a run that was green as a whole. A run that agreed on the chain but
  // could not finish (a file-level read returned nothing, a timeout after the line) leaves the chain "error", so it is
  // not carried over and the next run reads the file-level data again.
  if (line && line.status === "ok" && run.status !== "ok") return { chain: { status: "error", detail: `the chain agreed, but the run was incomplete: ${run.detail}`.slice(0, 300) }, fileFailure: null };
  if (line) return { chain: line, fileFailure: null };
  return { chain: { status: run.status, detail: run.detail }, fileFailure: null };
}

/**
 * Per chain (pure; tested): the entry of a per-chain verification. A chain that disagrees is red at once. A file-level
 * failure (defence in depth) is red only when the previous run's entry for the same file and data hash
 * (`prevFileFailure`) also failed on the file; a first one is "error" (warn), so a passing RPC miss that still reaches
 * VERIFICATION FAILED never turns the row red on its own; a real disagreement is red on the next daily run. Else error if
 * a chain could not finish, ok when every chain is green.
 */
export function chainsEntry(base: Omit<VerificationEntry, "status" | "detail" | "chains" | "fileFailure">, chains: Record<string, VerificationChain>, fileFailure: string | null, prevFileFailure: string | null = null): VerificationEntry {
  const c = combineChains(chains);
  if (c.status === "failed") return { ...base, status: "failed", detail: c.detail, chains, ...(fileFailure ? { fileFailure: fileFailure.slice(0, 300) } : {}) };
  if (fileFailure) {
    const ff = fileFailure.slice(0, 300);
    if (prevFileFailure) return { ...base, status: "failed", detail: `the file, in two runs in a row: ${fileFailure}`.slice(0, 300), chains, fileFailure: ff };
    return { ...base, status: "error", detail: `the file failed once (red if the next run fails it again): ${fileFailure}`.slice(0, 300), chains, fileFailure: ff };
  }
  return { ...base, status: c.status, detail: c.detail, chains };
}

/**
 * Pure; tested: the file-level miss of one daily run, from the outputs of the processes it started (one per
 * chain, or one for the whole file). The run missed the publication data when a process printed VERIFY-UNREADABLE and
 * no process read it (a VERIFY-CHAINS line without VERIFY-UNREADABLE, or a green exit). null when nothing missed, or
 * when no process ran (`outputs` empty: the streak is then carried unchanged, see unreadableTrack).
 */
export function runUnreadable(runs: { status: VerificationEntry["status"]; output: string }[]): string | null {
  const missed = runs.map((r) => parseUnreadableLine(r.output)).filter((u): u is string[] => !!u);
  if (!missed.length) return null;
  const read = runs.some((r) => !parseUnreadableLine(r.output) && (r.status === "ok" || parseChainLine(r.output) !== null));
  return read ? null : [...new Set(missed.flat())].join("; ").slice(0, 300);
}

/**
 * Pure; tested: the streak fields of the new entry. A miss continues the previous entry's streak on the same
 * file and data hash (or starts one at `at`); a run that read the data ends it; a run that started no process carries
 * the previous streak unchanged.
 */
export function unreadableTrack(prev: VerificationEntry | undefined, unreadable: string | null, ran: boolean, at: string): Pick<VerificationEntry, "unreadable" | "unreadableSince" | "unreadableRuns"> {
  if (!ran) return prev?.unreadableSince ? { unreadable: prev.unreadable, unreadableSince: prev.unreadableSince, unreadableRuns: prev.unreadableRuns } : {};
  if (!unreadable) return {};
  return { unreadable, unreadableSince: prev?.unreadableSince ?? at, unreadableRuns: (prev?.unreadableRuns ?? 0) + 1 };
}

/** Pure: the streak is kept only on an entry that could not finish ("ok" and "failed" end it). */
export function withUnreadable(e: VerificationEntry, track: Pick<VerificationEntry, "unreadable" | "unreadableSince" | "unreadableRuns">): VerificationEntry {
  return e.status === "error" && track.unreadableSince ? { ...e, ...track } : e;
}

function readPrev(): VerificationFile | null {
  if (!PREV || !fs.existsSync(PREV)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(PREV, "utf8"));
    return v && Array.isArray(v.results) ? v : null;
  } catch {
    return null;
  }
}

function runVerify(file: string, chain: number | null, timeoutMs: number): { status: VerificationEntry["status"]; detail: string; output: string } {
  const args = [require.resolve("ts-node/dist/bin.js"), "src/index.ts", "verify", path.join(EPOCHS_DIR, file), "--full", ...(chain === null ? [] : [`--chain=${chain}`])];
  const r = spawnSync(process.execPath, args, {
    cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true" },
  });
  const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  process.stdout.write(output.split(/\r?\n/).slice(-15).join("\n") + "\n");
  return { ...classify(r.status, output, !!r.error && /ETIMEDOUT/.test(String(r.error)), timeoutMs), output };
}

function main() {
  const prev = readPrev();
  const deadline = Date.now() + TIMEOUT_MS;
  const results: VerificationEntry[] = [];
  const files = newestFiles(EPOCHS_DIR);
  // the per-chain runs leave EXTRA_RESERVE_MS of the run's budget to the extra file verified after them
  const reserveMs = files.some((x) => x.kind === "extra") ? EXTRA_RESERVE_MS : 0;
  for (const f of files) {
    const carried = prev?.results.find((r) => r.file === f.file && r.dataHash === f.dataHash && r.status === "ok");
    if (carried && process.env.VERIFY_FORCE !== "true") {
      console.log(`${f.file}: verified green at ${carried.at}, same data hash: carried over`);
      results.push(carried);
      continue;
    }
    const perChain = f.kind === "epoch" ? chainsOfFile(EPOCHS_DIR, f.file) : null;
    if (perChain && perChain.length) {
      // per chain: one run per chain; a chain verified green on the same file is carried over
      const prevEntry = prev?.results.find((r) => r.file === f.file && r.dataHash === f.dataHash);
      // after a file-level failure no chain is carried over, so the file-level checks run again
      const before = prevEntry?.fileFailure ? {} : prevEntry?.chains ?? {};
      const chains: Record<string, VerificationChain> = {};
      let fileFailure: string | null = null;
      const runs: { status: VerificationEntry["status"]; output: string }[] = [];
      for (const id of perChain) {
        const was = before[String(id)];
        if (was && was.status === "ok" && process.env.VERIFY_FORCE !== "true") {
          console.log(`${f.file} chain ${id}: verified green at ${was.at}, same data hash: carried over`);
          chains[String(id)] = was;
          continue;
        }
        const left = deadline - reserveMs - Date.now();
        if (left < MIN_RUN_MS) {
          chains[String(id)] = { status: "error", detail: "not run: this run's time budget is spent (the next run retries)", at: new Date().toISOString() };
          continue;
        }
        console.log(`${f.file} chain ${id}: npm run verify -- ${f.file} --full --chain=${id} …`);
        const r = runVerify(f.file, id, Math.min(CHAIN_TIMEOUT_MS, left));
        runs.push(r);
        const o = chainOutcome(id, r, r.output);
        if (o.fileFailure && !fileFailure) fileFailure = o.fileFailure;
        chains[String(id)] = { ...o.chain, at: new Date().toISOString() };
        console.log(`${f.file} chain ${id}: ${o.chain.status} (${o.chain.detail})`);
      }
      const at = new Date().toISOString();
      const e = withUnreadable(chainsEntry({ file: f.file, kind: f.kind, epoch: f.epoch, dataHash: f.dataHash, at }, chains, fileFailure, prevEntry?.fileFailure ?? null), unreadableTrack(prevEntry, runUnreadable(runs), runs.length > 0, at));
      results.push(e);
      console.log(`${f.file}: ${e.status} (${e.detail})`);
      continue;
    }
    console.log(`${f.file}: npm run verify -- ${f.file} --full …`);
    const r = runVerify(f.file, null, Math.max(MIN_RUN_MS, Math.min(TIMEOUT_MS, deadline - Date.now())));
    const at = new Date().toISOString();
    const prevWhole = prev?.results.find((x) => x.file === f.file && x.dataHash === f.dataHash);
    results.push(withUnreadable({ file: f.file, kind: f.kind, epoch: f.epoch, dataHash: f.dataHash, status: r.status, detail: r.detail, at }, unreadableTrack(prevWhole, runUnreadable([r]), true, at)));
    console.log(`${f.file}: ${r.status}${r.detail ? ` (${r.detail})` : ""}`);
  }
  const out: VerificationFile = { at: new Date().toISOString(), results };
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`verification written to ${OUT}: ${results.map((r) => `${r.file} ${r.status}`).join(", ") || "no published epoch"}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    // never red here: a missing file makes the health check's verification row say so
    console.error(`health-verify could not run: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
  }
  process.exit(0);
}
