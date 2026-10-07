/**
 * Daily health check (npm run health). Exits non-zero when something needs a human, so the scheduled GitHub
 * workflow fails and GitHub emails the account that owns it. Read-only: it signs nothing.
 *
 * Checks: keeper / oracle wallet balances (they pay transaction fees), the latest run of every automation
 * workflow, keeper freshness, the site and its agent card, the burn portals' code, and how long the access
 * token used to publish the repository still has (repository variable PAT_EXPIRES, YYYY-MM-DD).
 */
import * as fs from "fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { CHAINS, X1_RPC } from "./config";
import { withFailover } from "./evm";
import { connect, fetchConfig, PDA } from "./x1";

const SITE = "https://xen-moon-forge-protocol.github.io/Moon-Forge/";
const WALLETS: [string, string, number][] = [
  ["keeper wallet", "XjMMmtbDN1zFiVoihyRjwdFXiyxXX5wegNWeeSQ2YFN", 0.05],
  ["oracle wallet", "J5CU45Didfq7ng9JHXyxYqN7TwAGjMgEyhUcrV7Aixba", 0.1],
];
const WORKFLOWS: [string, string][] = [["Keeper", "keeper.yml"], ["Oracle", "oracle.yml"], ["CI", "ci.yml"], ["Site deploy", "deploy-frontend.yml"]];

type Row = { check: string; state: "ok" | "warn" | "fail"; detail: string };
const rows: Row[] = [];
const add = (check: string, state: Row["state"], detail: string) => rows.push({ check, state, detail });

async function x1Checks() {
  const c = new Connection(X1_RPC, "confirmed");
  try {
    await c.getSlot();
  } catch (e) {
    add("X1 RPC", "fail", String(e).slice(0, 120));
    return;
  }
  for (const [name, addr, min] of WALLETS) {
    const xnt = (await c.getBalance(new PublicKey(addr))) / 1e9;
    add(name, xnt >= min ? "ok" : "fail", `${xnt.toFixed(4)} XNT (alert below ${min})`);
  }
  const { program } = connect();
  const cfg = await fetchConfig(program);
  const pool = await c.getAccountInfo(PDA.rewardVault());
  const rent = pool ? await c.getMinimumBalanceForRentExemption(pool.data.length) : 0;
  const free = Math.max(0, (pool?.lamports ?? 0) - rent - Number(cfg.rewardReserved)) / 1e9;
  add("reward pool", "ok", `${free.toFixed(3)} XNT free, epoch budget ${(free * 0.1).toFixed(3)} XNT, ${Number(cfg.airdropClaimed)}/120 Genesis claims`);
}

async function githubChecks() {
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    add("workflows", "warn", "GITHUB_REPOSITORY / GITHUB_TOKEN not set: skipped");
    return;
  }
  const H = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "moonforge-health" };
  for (const [label, file] of WORKFLOWS) {
    const j: any = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${file}/runs?per_page=10&status=completed`, { headers: H }).then((r) => r.json());
    // a queued run superseded by a newer one in the same concurrency group ends "cancelled": not a failure
    const last = j.workflow_runs?.find((r: any) => r.conclusion !== "cancelled" && r.conclusion !== "skipped");
    if (!last) { add(label, "warn", "no completed run"); continue; }
    const ageH = (Date.now() - Date.parse(last.updated_at)) / 3_600_000;
    add(label, last.conclusion === "success" ? "ok" : "fail", `last run ${last.conclusion}, ${ageH.toFixed(1)} h ago (${last.event})`);
    if (file === "keeper.yml" && ageH > 24) add("keeper freshness", "fail", `no keeper run finished in ${ageH.toFixed(0)} h`);
  }
  const exp = process.env.PAT_EXPIRES;
  if (exp) {
    const days = Math.floor((Date.parse(`${exp}T00:00:00Z`) - Date.now()) / 86_400_000);
    add("publishing token", days > 14 ? "ok" : "fail", `expires ${exp} (${days} days left; renew it before, then update PAT_EXPIRES)`);
  }
}

async function webChecks() {
  for (const [label, url, json] of [["site", SITE, false], ["agent card", `${SITE}agent-card.json`, true]] as const) {
    try {
      const r = await fetch(url);
      if (!r.ok) { add(label, "fail", `HTTP ${r.status}`); continue; }
      if (json) JSON.parse(await r.text());
      add(label, "ok", `HTTP ${r.status}`);
    } catch (e) {
      add(label, "fail", String(e).slice(0, 120));
    }
  }
  for (const c of CHAINS.filter((c) => c.portal)) {
    try {
      const code: string = await withFailover(c, "code", (p) => p.getCode(c.portal));
      add(`portal ${c.name}`, code.length > 2 ? "ok" : "fail", code.length > 2 ? `${(code.length - 2) / 2} bytes of code` : "no code at the portal address");
    } catch (e) {
      add(`portal ${c.name}`, "warn", `RPC unavailable: ${String(e).slice(0, 80)}`);
    }
  }
}

async function main() {
  await Promise.all([x1Checks().catch((e) => add("X1 checks", "fail", String(e).slice(0, 120))), githubChecks(), webChecks()]);
  const icon = { ok: "OK  ", warn: "WARN", fail: "FAIL" };
  for (const r of rows) console.log(`${icon[r.state]} ${r.check.padEnd(18)} ${r.detail}`);
  const fails = rows.filter((r) => r.state === "fail");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = ["| | Check | Detail |", "|---|---|---|", ...rows.map((r) => `| ${r.state === "ok" ? "✅" : r.state === "warn" ? "⚠️" : "❌"} | ${r.check} | ${r.detail} |`)].join("\n");
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Moon Forge health\n\n${md}\n`);
  }
  console.log(fails.length ? `${fails.length} problem(s) need attention` : "all checks passed");
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
