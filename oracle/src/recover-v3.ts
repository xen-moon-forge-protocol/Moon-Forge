/**
 * The missing-file trap (r9 fix-up b): every build continues from the file of the newest epoch on chain, so while that
 * file is missing locally, or the local file is not the one the program recorded, `npm run epoch` must refuse (a build
 * on a wrong previous file would skip or repeat burns). This module gives the two safe answers:
 *
 *   1. prevMismatchV3 (used by `npm run epoch`): the local previous file must carry the data hash the program recorded
 *      for that epoch (Epoch.data_hash, read raw). A local file that differs (an honest build whose publication lost the
 *      race to someone else's, or a hand-edited file) is refused: building on it would treat its burns as paid.
 *   2. `npm run recover-epoch -- <n> [--from <file|dir> ...] [--yes]`: finds a copy of epoch-<n>.json whose data hash is
 *      the one the program recorded (and equals its own recomputation): the git history of every branch, the copy GitHub
 *      Pages serves, and any files or run-artifact folders given with --from (a copy anyone kept). It restores that copy
 *      only with --yes. Nothing else is ever accepted: a restored file is byte-for-byte what the chain committed to, so
 *      the next build continues exactly where the published history stands, with no burn paid twice or dropped.
 *
 * What is NOT automated, and why (OPERATORS.md "When something breaks", row "epoch file missing"): when no copy of the
 * published file exists anywhere (an epoch published by someone else and never made public), the next file's state
 * (chain cursors, curves, liquidity, references, counters, the extra pot's base) cannot be derived. Continuing from the
 * file before it would pay that epoch's window again if its leaves were real burners who already claimed; continuing
 * from a later cursor would drop burns. Only voiding inside the 48-hour hold protects against such an epoch; the safe
 * continuation after a void (nothing of a voided epoch can ever be claimed) is a rules release, described there.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { dataHash as dataHashV2, EpochBody } from "./epoch";
import { dataHashV3, EpochBodyV3 } from "./rewards";

/** where GitHub Pages serves the epoch files of this instance (EPOCHS_URL overrides it for a fork or a mirror) */
export const PAGES_EPOCHS_URL = process.env.EPOCHS_URL || "https://xen-moon-forge-protocol.github.io/Moon-Forge/epochs/";

/** Epoch account layout (same in both IDLs): disc 8 | id u64 | root 32 | data_hash 32 | … | published_at i64 at 141. */
const DATA_HASH_AT = 8 + 8 + 32;

/** The data hash the program recorded for an epoch, from the raw Epoch account (pure); null when it is not an Epoch of `programId`. */
export function epochDataHashOfAccountV3(info: { owner: PublicKey; data: Buffer | Uint8Array } | null, programId: PublicKey): string | null {
  if (!info || !info.owner.equals(programId) || info.data.length < DATA_HASH_AT + 32) return null;
  return Buffer.from(info.data.subarray(DATA_HASH_AT, DATA_HASH_AT + 32)).toString("hex");
}

/** A file's data hash recomputed by its own version's rule (v2: epoch.ts, v3: rewards.ts); null for anything else. */
export function recomputedDataHashV3(f: unknown): string | null {
  const v = (f as { version?: unknown } | null)?.version;
  try {
    if (v === 2) return dataHashV2(f as EpochBody);
    if (v === 3) return dataHashV3(f as EpochBodyV3);
  } catch {
    return null;
  }
  return null;
}

/**
 * Pure: why the local previous file cannot be built on (null: it is the file the program recorded). `onChainHex` null =
 * the Epoch account could not be read: refused (a build on an unchecked previous file is never attempted).
 */
export function prevMismatchV3(local: { epoch: number; dataHash?: unknown } | null, n: number, onChainHex: string | null): string | null {
  const recover = `restore the published file: npm run recover-epoch -- ${n} (then --yes); see OPERATORS.md "epoch file missing"`;
  if (!local) return `epoch-${n}.json is missing locally: ${recover}`;
  if (onChainHex === null) return `Epoch(${n}) could not be read: the local epoch-${n}.json cannot be checked against the data hash the program recorded (re-run)`;
  if (local.dataHash !== onChainHex) return `epoch-${n}.json (data hash ${String(local.dataHash)}) is not the file the program recorded for epoch ${n} (${onChainHex}): building on it would treat other burns as paid; ${recover}`;
  if (recomputedDataHashV3(local) !== onChainHex) return `epoch-${n}.json does not match its own data hash: ${recover}`;
  return null;
}

/** One copy found somewhere: where, and its text. */
export interface RecoverCandidateV3 {
  origin: string;
  text: string;
}

/** Pure: whether a candidate is THE published file of epoch n (its number, its own data hash, the program's). */
export function candidateVerdictV3(c: RecoverCandidateV3, n: number, onChainHex: string): { ok: boolean; file: any | null; reason: string } {
  let f: any;
  try {
    f = JSON.parse(c.text);
  } catch {
    return { ok: false, file: null, reason: "not JSON" };
  }
  if (!f || typeof f !== "object" || f.epoch !== n) return { ok: false, file: null, reason: `not epoch ${n}` };
  const own = recomputedDataHashV3(f);
  if (own === null) return { ok: false, file: null, reason: `unknown version ${String(f.version)}` };
  if (own !== f.dataHash) return { ok: false, file: null, reason: "does not match its own data hash" };
  if (own !== onChainHex) return { ok: false, file: null, reason: `data hash ${own} is not the program's ${onChainHex}` };
  return { ok: true, file: f, reason: `data hash ${own} = the program's record` };
}

/** Copies of `name` in a file or a folder (and its sub-folders, 4 levels: an unpacked run artifact), read-only. */
export function candidatesFromPathV3(p: string, name: string, depth = 4): RecoverCandidateV3[] {
  if (!fs.existsSync(p)) return [];
  const st = fs.statSync(p);
  if (st.isFile()) return [{ origin: p, text: fs.readFileSync(p, "utf8") }];
  if (!st.isDirectory() || depth < 0) return [];
  const out: RecoverCandidateV3[] = [];
  for (const e of fs.readdirSync(p)) {
    const q = path.join(p, e);
    if (e === name && fs.statSync(q).isFile()) out.push({ origin: q, text: fs.readFileSync(q, "utf8") });
    else if (fs.statSync(q).isDirectory() && e !== "node_modules" && e !== ".git") out.push(...candidatesFromPathV3(q, name, depth - 1));
  }
  return out;
}

/** Every version of `file` in the git history of every branch (newest first, at most `max`), read-only; [] outside a repository. */
export function candidatesFromGitV3(file: string, max = 200, run: (args: string[], cwd: string) => string = gitRun): RecoverCandidateV3[] {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  let root: string;
  try {
    root = run(["rev-parse", "--show-toplevel"], dir).trim();
  } catch {
    return [];
  }
  const rel = path.relative(root, abs).split(path.sep).join("/");
  let revs: string[];
  try {
    revs = run(["log", "--all", `--max-count=${max}`, "--format=%H", "--", rel], root).split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
  const out: RecoverCandidateV3[] = [];
  for (const r of revs) {
    try {
      out.push({ origin: `git ${r.slice(0, 12)}:${rel}`, text: run(["show", `${r}:${rel}`], root) });
    } catch {
      /* deleted in that commit: nothing to read */
    }
  }
  return out;
}

function gitRun(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
}

/** The copy GitHub Pages (or EPOCHS_URL) serves, if any (read-only, 20 s). */
export async function candidateFromPagesV3(name: string, base = PAGES_EPOCHS_URL, fetcher: typeof fetch = fetch): Promise<RecoverCandidateV3 | null> {
  const url = `${base.replace(/\/?$/, "/")}${name}`;
  try {
    const r = await fetcher(url, { signal: AbortSignal.timeout(20_000) });
    return r.ok ? { origin: url, text: await r.text() } : null;
  } catch {
    return null;
  }
}

export interface RecoverIoV3 {
  /** the program's data hash of epoch n (null: no such Epoch, or unreadable) */
  onChain(n: number): Promise<string | null>;
  /** the publish transaction of epoch n (for a copy kept before its publication, which has no publish record) */
  publishTx(n: number): Promise<string | null>;
  local(n: number): any | null;
  candidates(n: number, from: string[]): Promise<RecoverCandidateV3[]>;
  /** write the restored file (and the index); move a different local file out of the epochs folder, returning where */
  write(n: number, f: any): void;
  moveAside(n: number): string;
  log(s: string): void;
}

/** `npm run recover-epoch -- <n> [--from <file|dir> ...] [--yes]`: true when the published file is (now) in place. */
export async function recoverEpochCli(n: number, from: string[], yes: boolean, io: RecoverIoV3): Promise<boolean> {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("usage: recover-epoch <epoch> [--from <file|dir> ...] [--yes]");
  const want = await io.onChain(n);
  if (want === null) throw new Error(`Epoch(${n}) does not exist on chain or could not be read: nothing to recover against`);
  const local = io.local(n);
  if (local && prevMismatchV3(local, n, want) === null) {
    io.log(`epoch-${n}.json is already the file the program recorded (data hash ${want}): nothing to do`);
    return true;
  }
  if (local) io.log(`the local epoch-${n}.json (data hash ${String(local.dataHash)}) is not the published file (${want})`);
  const cands = await io.candidates(n, from);
  let found: { c: RecoverCandidateV3; file: any } | null = null;
  for (const c of cands) {
    const v = candidateVerdictV3(c, n, want);
    io.log(`  ${c.origin}: ${v.ok ? "MATCH" : "no"} (${v.reason})`);
    if (v.ok && !found) found = { c, file: v.file };
  }
  if (!found) {
    io.log(`no copy of epoch-${n}.json carries the data hash the program recorded (${want}) among ${cands.length} copies read (git history of every branch, GitHub Pages${from.length ? ", the --from paths" : ""}).`);
    io.log(`  Ask anyone who kept the epoch files (an oracle run artifact "epochs-<run id>", a clone, a mirror) and re-run with --from <path>. If no copy exists, see OPERATORS.md "epoch file missing": nothing in this repository builds past it safely.`);
    return false;
  }
  const f = found.file;
  if (!f.publish || typeof f.publish.tx !== "string") {
    const tx = await io.publishTx(n);
    if (tx) f.publish = { tx };
  }
  io.log(`restore epoch-${n}.json from ${found.c.origin}${f.publish ? ` (publish tx ${f.publish.tx})` : " (no publish transaction found: verify will look it up)"}`);
  if (!yes) {
    io.log("  dry: nothing written (add --yes to restore it)");
    return false;
  }
  if (local) io.log(`  the local file that is not the published one was moved to ${io.moveAside(n)} (keep it for the record; it was never paid)`);
  io.write(n, f);
  io.log(`  restored. Next: npm run verify -- <epochs dir>/epoch-${n}.json, commit it, then npm run epoch`);
  return true;
}
