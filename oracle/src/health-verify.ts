/**
 * Verification for the daily health check (npm run health-verify; IMMUTABILITY.md "verification green").
 *
 * Runs `npm run verify -- <file> --full` (index.ts verify: recomputes the epoch from public data and compares it with
 * X1) on the NEWEST published epoch file of EPOCHS_DIR, and on its extra file when there is one, and writes the result
 * to VERIFY_JSON (default ../ops/verification.json in Actions). A file the previous result (VERIFY_PREV) already
 * verified green with the same data hash is carried over without a new run (VERIFY_FORCE=true re-runs it), so the full
 * run happens about once a week, after each publication.
 *
 * Per file: "ok" (exit 0), "failed" (the verifier printed VERIFICATION FAILED: the file and the chain disagree), or
 * "error" (it could not finish: an RPC outage, a timeout; the next run retries). Read-only: no key, no transaction.
 * Always exits 0: the health check (health.ts "verification" row) judges the result.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { EPOCHS_DIR } from "./config";
import type { VerificationEntry, VerificationFile } from "./health-rules";

const OUT = process.env.VERIFY_JSON || (process.env.GITHUB_ACTIONS ? "../ops/verification.json" : "verification.json");
const PREV = process.env.VERIFY_PREV || (process.env.GITHUB_ACTIONS ? "prev-verify/verification.json" : "");
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 40 * 60_000);

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

/** "ok" / "failed" / "error" from the verifier's exit status and output (pure; tested). */
export function classify(status: number | null, output: string, timedOut: boolean): { status: VerificationEntry["status"]; detail: string } {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (status === 0 && !timedOut) return { status: "ok", detail: (lines.find((l) => /verified/.test(l)) ?? "verified").slice(0, 300) };
  const i = lines.findIndex((l) => /VERIFICATION FAILED/.test(l));
  if (i >= 0) return { status: "failed", detail: lines.slice(i + 1, i + 6).join(" ").slice(0, 300) || "VERIFICATION FAILED" };
  if (timedOut) return { status: "error", detail: `timed out after ${Math.round(TIMEOUT_MS / 60_000)} min` };
  return { status: "error", detail: (lines.filter((l) => /error|Error|ECONN|timed out|429|503/.test(l)).slice(-2).join(" ") || `exit ${status}`).slice(0, 300) };
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

function main() {
  const prev = readPrev();
  const results: VerificationEntry[] = [];
  for (const f of newestFiles(EPOCHS_DIR)) {
    const carried = prev?.results.find((r) => r.file === f.file && r.dataHash === f.dataHash && r.status === "ok");
    if (carried && process.env.VERIFY_FORCE !== "true") {
      console.log(`${f.file}: verified green at ${carried.at}, same data hash: carried over`);
      results.push(carried);
      continue;
    }
    console.log(`${f.file}: npm run verify -- ${f.file} --full …`);
    const r = spawnSync(process.execPath, [require.resolve("ts-node/dist/bin.js"), "src/index.ts", "verify", path.join(EPOCHS_DIR, f.file), "--full"], {
      cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true" },
    });
    const output = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    process.stdout.write(output.split(/\r?\n/).slice(-15).join("\n") + "\n");
    const c = classify(r.status, output, !!r.error && /ETIMEDOUT/.test(String(r.error)));
    results.push({ file: f.file, kind: f.kind, epoch: f.epoch, dataHash: f.dataHash, status: c.status, detail: c.detail, at: new Date().toISOString() });
    console.log(`${f.file}: ${c.status}${c.detail ? ` (${c.detail})` : ""}`);
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
