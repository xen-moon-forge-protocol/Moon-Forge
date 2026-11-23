/**
 * The process-level guard of the oracle commands (index.ts, announce.ts).
 *
 * Node ends a process with exit code 0 when its event loop empties, even if an `await` is still pending: a promise whose
 * resolve or reject would only be called by an event that can no longer come (a socket that went away without an error,
 * an unref'd timer) leaves nothing to keep the process alive. A command run that way stops in the middle of its work and
 * looks green: the weekly epoch run would publish nothing and its workflow step would still pass.
 *
 * `guardRun` marks the run complete only when `main()` settles. If Node is about to exit before that ('beforeExit' with
 * the run still pending), it prints what was still open and exits with RUN_GUARD_EXIT_CODE, so the step fails loudly. A
 * run that settles keeps its normal ending: a resolved `main()` exits with `process.exitCode` (0 unless the command set
 * it), a rejected one prints the error and exits 1, as the plain `main().catch(...)` did before.
 */

/** The exit code of a run that ended because the event loop emptied before main() settled. */
export const RUN_GUARD_EXIT_CODE = 3;

/** What guardRun needs from `process` (tests inject a fake). */
export interface GuardProcess {
  once(event: "beforeExit", listener: (code: number) => void): unknown;
  exit(code: number): void;
  getActiveResourcesInfo?: () => string[];
}

/** The message printed when the event loop emptied before the run settled (pure). */
export function prematureExitMessage(command: string, resources: string[] | null): string {
  const open = resources === null ? "unknown" : resources.length ? resources.join(", ") : "none";
  return (
    `the ${command} run ended before it finished: Node's event loop emptied while the run was still waiting on a promise ` +
    `that nothing can settle any more (a dropped request or timer). Nothing after the last line above ran. ` +
    `Exiting with code ${RUN_GUARD_EXIT_CODE} so the run is red, not green. Still open at exit: ${open}.`
  );
}

/**
 * Runs `main` under the guard. The returned promise settles once the outcome is handled (tests await it; the CLI does
 * not need to). `log` prints the premature-exit message, `onError` a rejection (default: console.error, as before).
 */
export function guardRun(
  command: string,
  main: () => Promise<unknown>,
  o: { proc?: GuardProcess; log?: (m: string) => void; onError?: (e: unknown) => void } = {},
): Promise<void> {
  const proc: GuardProcess = o.proc ?? (process as unknown as GuardProcess);
  const log = o.log ?? ((m: string) => console.error(m));
  const onError = o.onError ?? ((e: unknown) => console.error(e));
  let settled = false;
  proc.once("beforeExit", () => {
    if (settled) return;
    settled = true;
    let resources: string[] | null = null;
    try {
      resources = proc.getActiveResourcesInfo ? proc.getActiveResourcesInfo() : null;
    } catch {
      resources = null;
    }
    const msg = prematureExitMessage(command, resources);
    log(msg);
    if (process.env.GITHUB_ACTIONS) console.log(`::error::${msg}`);
    proc.exit(RUN_GUARD_EXIT_CODE);
  });
  let run: Promise<unknown>;
  try {
    run = Promise.resolve(main());
  } catch (e) {
    run = Promise.reject(e);
  }
  return run.then(
    () => {
      settled = true;
    },
    (e) => {
      if (settled) return;
      settled = true;
      onError(e);
      proc.exit(1);
    },
  );
}
