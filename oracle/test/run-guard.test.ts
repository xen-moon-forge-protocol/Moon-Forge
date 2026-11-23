/**
 * The process-level run guard (src/run-guard.ts): a run whose event loop empties before main() settles exits non-zero
 * with a message (it used to exit 0, silently: the 2026-11-22 dry v3 build that stopped after the Optimism read), and a
 * run that settles keeps its normal exit. Real child processes, no network.
 *   npx ts-node test/run-guard.test.ts
 */
import assert from "assert";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { guardRun, GuardProcess, prematureExitMessage, RUN_GUARD_EXIT_CODE } from "../src/run-guard";

let n = 0;
const tests: [string, () => Promise<void> | void][] = [];
const t = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const GUARD = path.resolve(__dirname, "../src/run-guard.ts").replace(/\\/g, "/");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-guard-"));
/** runs `body` (the script's main) under guardRun in a child Node process; returns its exit code and output */
function child(body: string, env: Record<string, string> = {}) {
  const file = path.join(dir, `c${n}-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(file, `import { guardRun } from "${GUARD}";\nguardRun("epoch", async () => {\n${body}\n});\n`);
  const r = spawnSync(process.execPath, ["-r", "ts-node/register/transpile-only", file], {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 60_000, env: { ...process.env, GITHUB_ACTIONS: "", ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

t("an await that nothing can settle (no handle left): exit code RUN_GUARD_EXIT_CODE and the message, not a silent 0", () => {
  const r = child(`console.log("before the read");\nawait new Promise(() => {});\nconsole.log("after the read");`);
  assert.strictEqual(r.code, RUN_GUARD_EXIT_CODE, r.out);
  assert(r.out.includes("before the read") && !r.out.includes("after the read"), r.out);
  assert(/the epoch run ended before it finished/.test(r.out), r.out);
});

t("the same with the resolver kept only by an unref'd timer (the shape of a dropped request timeout)", () => {
  const r = child(`await new Promise((res) => setTimeout(res, 5_000).unref());\nconsole.log("never");`);
  assert.strictEqual(r.code, RUN_GUARD_EXIT_CODE, r.out);
  assert(!r.out.includes("never"), r.out);
});

t("a main() that resolves exits 0, and keeps the exit code the command set", () => {
  const ok = child(`await new Promise((res) => setTimeout(res, 50));\nconsole.log("done");`);
  assert.strictEqual(ok.code, 0, ok.out);
  assert(ok.out.includes("done") && !/ended before it finished/.test(ok.out), ok.out);
  const set = child(`process.exitCode = 1;`);
  assert.strictEqual(set.code, 1, set.out);
  assert(!/ended before it finished/.test(set.out), set.out);
});

t("a main() that rejects prints the error and exits 1, as main().catch did", () => {
  const r = child(`await new Promise((res) => setTimeout(res, 20));\nthrow new Error("every RPC failed");`);
  assert.strictEqual(r.code, 1, r.out);
  assert(r.out.includes("every RPC failed") && !/ended before it finished/.test(r.out), r.out);
});

t("on GitHub Actions the premature end is also an ::error:: annotation", () => {
  const r = child(`await new Promise(() => {});`, { GITHUB_ACTIONS: "true" });
  assert.strictEqual(r.code, RUN_GUARD_EXIT_CODE, r.out);
  assert(/::error::the epoch run ended before it finished/.test(r.out), r.out);
});

t("in-process: the guard exits once, with the open resources, and never after main() settled", async () => {
  const fake = () => {
    let listener: (() => void) | null = null;
    const exits: number[] = [];
    const proc: GuardProcess = { once: (_e, l) => (listener = l as () => void), exit: (c) => void exits.push(c), getActiveResourcesInfo: () => ["TCPSocketWrap"] };
    return { proc, exits, fire: () => listener?.() };
  };
  const a = fake();
  const logs: string[] = [];
  void guardRun("epoch", () => new Promise(() => {}), { proc: a.proc, log: (m) => logs.push(m) });
  a.fire();
  a.fire();
  assert.deepStrictEqual(a.exits, [RUN_GUARD_EXIT_CODE]);
  assert(logs.length === 1 && logs[0].includes("TCPSocketWrap"), logs.join("\n"));
  const b = fake();
  await guardRun("epoch", async () => 1, { proc: b.proc, log: () => {} });
  b.fire();
  assert.deepStrictEqual(b.exits, [], "a settled run is not touched by beforeExit");
  const c = fake();
  await guardRun("epoch", async () => { throw new Error("x"); }, { proc: c.proc, log: () => {}, onError: () => {} });
  assert.deepStrictEqual(c.exits, [1]);
  assert(prematureExitMessage("feed", null).includes("Still open at exit: unknown"));
});

t("the CLI entry points run under the guard (index.ts, announce.ts)", () => {
  const src = (f: string) => fs.readFileSync(path.resolve(__dirname, "../src", f), "utf8");
  assert(/\nguardRun\([^\n]*main\);/.test(src("index.ts")), "index.ts runs main() under guardRun");
  assert(!/\nmain\(\)\.catch/.test(src("index.ts")), "index.ts no longer runs a bare main().catch");
  assert(/require\.main === module\) guardRun\("announce", main\)/.test(src("announce.ts")), "announce.ts runs main() under guardRun");
});

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    n++;
    console.log(`  ok  ${name}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`run guard: ${n} tests passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
