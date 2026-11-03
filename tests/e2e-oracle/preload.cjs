// Preload for the REAL oracle CLI in tests/e2e-oracle-v3.sh: `node -r <this file> src/index.ts <command> ...`, run from
// an oracle directory (the worktree's oracle/, or main's oracle for the v2 comparison). It does three things, all
// switched by environment variables, and changes no logic of the oracle:
//  1. registers ts-node (transpile only), as `ts-node src/index.ts` does for the npm scripts;
//  2. E2E_FAKE_WORLD=<url>: the hosts the oracle hard-codes (GeckoTerminal, x1report, XDEX, and the project site the
//     health check reads) are answered by the fake world (fake-world.mjs). The EVM chains and X1 are reached through the oracle's own environment variables
//     (<CHAIN>_RPC_URL, X1_RPC_URL), so nothing else is redirected;
//  3. E2E_LOCALNET=1: the oracle's time unit follows the program's `--features localnet` build (constants.rs: DAY = 1 s,
//     KEEPER_STALL_SLOTS = 40, PRED_V1_HORIZON = 20, EXTRA_WEEK_SLACK = DAY / 4 = 0). The mainnet values are replaced in
//     the source text at load time, each by an exact match that must occur exactly once (a changed line fails the run
//     instead of silently testing something else). The files on disk are never changed, so engineSha256Of() (which
//     hashes rewards.ts as written) still names the mainnet engine. The weekly slot of epochDue() (a Sunday rule on the
//     wall clock) becomes the compressed 7-s week. E2E_V3_FIRST_EPOCH=<n> pins the switch epoch the way the reviewed
//     commit pins V3_FIRST_EPOCH in rewards.ts.
const fs = require("fs");
const path = require("path");
const Module = require("module");

const oracleDir = process.env.E2E_ORACLE_DIR || process.cwd();
const req = Module.createRequire(path.join(oracleDir, "package.json"));
const tsnode = req("ts-node");
const service = tsnode.register({ transpileOnly: true, project: path.join(oracleDir, "tsconfig.json") });

// ── 3. the localnet time profile ───────────────────────────────────────────────────────────────────────────────────
const SUBS = {
  "index.ts": [
    ["const WEEK = 7 * 86_400;", "const WEEK = 7;"],
    ["const SUNDAY_0 = 3 * 86_400;", "const SUNDAY_0 = 3;"],
    ["return now - slot < 2 * 86_400 && lastPublishTs < slot;", "return now - slot < 7 && lastPublishTs < slot;"],
  ],
  "rewards.ts": [
    ["export const DAY = 86_400;", "export const DAY = 1;"],
    // D-13 (round 4): the statistic buckets HOURLY samples into days; with DAY = 1 s every sample (the build's own reading
    // included) fell outside the 7 "days" and the build threw "the liquidity statistic has no sample". The buckets keep
    // real days here (a run lasts minutes: every sample is on day 0), the rule itself is unchanged (r4-fix)
    ["const d = Math.floor((endTs - s.hour * HOUR) / DAY);", "const d = Math.floor((endTs - s.hour * HOUR) / 86_400);"],
  ],
  "keeper-v3.ts": [
    ["export const DAY = 86_400;", "export const DAY = 1;"],
    ["export const KEEPER_STALL_SLOTS = 235_000n;", "export const KEEPER_STALL_SLOTS = 40n;"],
    ["export const PRED_V1_HORIZON = 86_400;", "export const PRED_V1_HORIZON = 20;"],
  ],
  "extra.ts": [["export const NEED_WEEK_SLACK = MAX_PUBLISH_LAG;", "export const NEED_WEEK_SLACK = 0;"]],
  // W2-4: the live binary's ProgramData deploy slot. A local validator loads the old binary at genesis (slot 0), the
  // localnet twin of mainnet's 85,429,880: the upgrade then lands at a later slot, as on mainnet
  "x1-v3.ts": [["export const LIVE_DEPLOY_SLOT = 85_429_880;", "export const LIVE_DEPLOY_SLOT = 0;"]],
  "health-rules.ts": [
    ["export const KEEPER_STALL_SLOTS = 235_000;", "export const KEEPER_STALL_SLOTS = 40;"],
    ["export const KEEPER_DEAD_DELAY_S = 28 * 86_400;", "export const KEEPER_DEAD_DELAY_S = 28;"],
    // the breaker's day (constants.rs DAY_SECONDS_FOR_BREAKER = DAY): Config.bankroll_day counts 1-s days on localnet;
    // 1 copy in main's oracle, 2 in the final one (bankrollDayVerdict + bankrollDayVerdictV3)
    ["const today = Math.floor(now / 86_400);", "const today = Math.floor(now / 1);", [1, 2]],
    ["new Date(bankrollDay * 86_400_000)", "new Date(bankrollDay * 1_000)", [1, 2]],
    // r4-fix: the "our epochs voided" row: an epoch closed before its 90-day (90-s) window, published in the last 30 days (30 s)
    ["export const CLAIM_WINDOW_S = 90 * 86_400;", "export const CLAIM_WINDOW_S = 90;"],
    ["export const VOIDED_LOOKBACK_S = 30 * 86_400;", "export const VOIDED_LOOKBACK_S = 30;"],
  ],
};
if (process.env.E2E_V3_FIRST_EPOCH) {
  const n = Number(process.env.E2E_V3_FIRST_EPOCH);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`E2E_V3_FIRST_EPOCH=${process.env.E2E_V3_FIRST_EPOCH}`);
  SUBS["rewards.ts"].push(["export const V3_FIRST_EPOCH: number | null = null;", `export const V3_FIRST_EPOCH: number | null = ${n};`]);
}
// with the fake world, the 30-requests-a-minute spacing of GeckoTerminal's public API (pricing.ts getJson) is not needed
// (round 4 added the v3 reader getJsonV3 with the same pacing line: both are replaced; main's v2 oracle has only one)
const WORLD_SUBS = { "pricing.ts": [["const wait = lastCall + 2100 - Date.now();", "const wait = 0;", [1, 2]]] }; // 1 in main's oracle
const active = {};
for (const [on, table] of [[process.env.E2E_LOCALNET === "1", SUBS], [!!process.env.E2E_FAKE_WORLD, WORLD_SUBS]]) {
  if (on) for (const [f, list] of Object.entries(table)) active[f] = [...(active[f] || []), ...list];
}
const srcDir = path.join(path.resolve(oracleDir), "src") + path.sep;
const tsHandler = require.extensions[".ts"];
if (Object.keys(active).length) {
  require.extensions[".ts"] = function (module, filename) {
    const subs = filename.startsWith(srcDir) && path.dirname(filename) + path.sep === srcDir ? active[path.basename(filename)] : null;
    if (!subs) return tsHandler(module, filename);
    let code = fs.readFileSync(filename, "utf8");
    for (const [from, to, times = 1] of subs) {
      const n = code.split(from).length - 1;
      const allowed = Array.isArray(times) ? times : [times];
      if (!allowed.includes(n)) throw new Error(`e2e localnet profile: "${from}" occurs ${n} times in ${filename} (expected ${allowed.join(" or ")}): update tests/e2e-oracle/preload.cjs`);
      code = code.split(from).join(to);
    }
    module._compile(service.compile(code, filename), filename);
  };
}

// ── 2. the price hosts ─────────────────────────────────────────────────────────────────────────────────────────────
const world = process.env.E2E_FAKE_WORLD;
if (world) {
  const MAP = [
    ["https://api.geckoterminal.com/", `${world}/gt/`],
    ["https://x1report.com/", `${world}/x1report/`],
    ["https://api.xdex.xyz/", `${world}/xdex/`],
    // the project site the health check reads (health.ts SITE): the fake world serves the test's pushed epochs and feed
    ["https://xen-moon-forge-protocol.github.io/Moon-Forge/", `${world}/site/`],
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const [from, to] of MAP) if (url.startsWith(from)) return realFetch(to + url.slice(from.length), init);
    return realFetch(input, init);
  };
}
