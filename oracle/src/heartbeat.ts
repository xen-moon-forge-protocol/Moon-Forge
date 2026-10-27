/**
 * Repository heartbeat (npx ts-node src/heartbeat.ts [file], default ../ops/heartbeat.json).
 *
 * Writes a small JSON file with the UTC time, the last epoch and the pool / wallet balances read from X1. The
 * oracle workflow commits it with the GITHUB_TOKEN about once a week, whether or not an epoch is due. The commit
 * itself is the point: GitHub disables every scheduled workflow of a public repository after 60 days without a
 * commit, and weeks without burns produce none. Nothing here signs anything, and nothing here needs a person.
 *
 * Never fails: when the RPC is down the file still gets the time and the error, so the commit still happens.
 */
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { X1_RPC } from "./config";
import { connect, fetchConfig, PDA } from "./x1";
import { x1Connection } from "./x1-rpc";

/** Wallets the automation pays fees from (also watched by the health check). */
export const WALLETS: { name: string; address: string; minXnt: number }[] = [
  { name: "keeper wallet", address: "XjMMmtbDN1zFiVoihyRjwdFXiyxXX5wegNWeeSQ2YFN", minXnt: 0.05 },
  { name: "oracle wallet", address: "J5CU45Didfq7ng9JHXyxYqN7TwAGjMgEyhUcrV7Aixba", minXnt: 0.1 },
];

const XNT = 1e9;
const xnt = (lamports: number | bigint) => Number((Number(lamports) / XNT).toFixed(9));

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${what}: timed out after ${ms / 1000}s`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** Everything read from chain, in one object; throws when the RPC is unusable. */
export async function snapshot(): Promise<Record<string, unknown>> {
  const c = x1Connection("confirmed");
  const { program } = connect();
  const cfg = await fetchConfig(program);
  const vaults = { rewardVault: PDA.rewardVault(), bankrollVault: PDA.bankrollVault(), drawVault: PDA.drawVault() };
  const infos = await c.getMultipleAccountsInfo(Object.values(vaults));
  const pool = infos[0];
  const rent = pool ? await c.getMinimumBalanceForRentExemption(pool.data.length) : 0;
  const reserved = Number(cfg.rewardReserved ?? 0);
  const free = Math.max(0, (pool?.lamports ?? 0) - rent - reserved);
  const wallets: Record<string, unknown> = {};
  for (const w of WALLETS) wallets[w.name.replace(" wallet", "")] = { address: w.address, xnt: xnt(await c.getBalance(new PublicKey(w.address))) };
  const lastPublishTs = Number(cfg.lastPublishTs ?? 0);
  return {
    lastEpoch: Number(cfg.lastEpoch ?? 0),
    lastEpochPublishedAt: lastPublishTs ? new Date(lastPublishTs * 1000).toISOString() : null,
    rewardPool: { freeXnt: xnt(free), reservedXnt: xnt(reserved), rentXnt: xnt(rent) },
    bankrollVaultXnt: xnt(infos[1]?.lamports ?? 0),
    drawVaultXnt: xnt(infos[2]?.lamports ?? 0),
    genesisClaimed: Number(cfg.airdropClaimed ?? 0),
    wallets,
  };
}

async function main() {
  const file = process.argv[2] || path.join("..", "ops", "heartbeat.json");
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  const out: Record<string, unknown> = {
    utc: new Date().toISOString(),
    why: "Written about once a week by the oracle workflow (.github/workflows/oracle.yml) and committed with the GITHUB_TOKEN, so the repository stays active: GitHub disables every scheduled workflow of a public repository after 60 days without a commit. No person is involved.",
    run: GITHUB_REPOSITORY && GITHUB_RUN_ID ? `${GITHUB_SERVER_URL || "https://github.com"}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : null,
    // the host only: the file is committed to a public repository, and an RPC URL may carry a key
    rpc: (() => { try { return new URL(X1_RPC).host; } catch { return "invalid X1_RPC_URL"; } })(),
  };
  try {
    Object.assign(out, await withTimeout(snapshot(), 90_000, "X1 read"));
  } catch (e) {
    out.error = String(e).slice(0, 200);
    console.error(`chain read failed (the heartbeat is still written): ${out.error}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${file}`);
  console.log(JSON.stringify(out));
}

if (require.main === module) {
  main().catch((e) => {
    // last resort: even a bug in the writer must not stop the commit
    console.error(e);
    process.exitCode = 0;
  });
}
