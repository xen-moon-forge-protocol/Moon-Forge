/**
 * Automatic announcements for the project's own channels (X @MoonXenForge, an optional Telegram channel).
 *
 *   npm run announce -- weekly [--dry]     state of the forge: pool, this epoch's budget, fair burn capacity
 *   npm run announce -- epoch [--dry]      receipt of the epoch just published (burns, wallets, drops, how to verify)
 *
 * Rules, by design: original posts only (never replies, mentions or DMs), facts read from chain and public
 * price sources, no price predictions, no promises of returns. Posting needs the account's own keys as
 * environment variables; without them the text is only printed, so the job never fails for lack of keys.
 *   X:        X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET  (OAuth 1.0a user context, read+write app)
 *   Telegram: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID                         (bot added as admin of the channel)
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { CHAINS, EPOCHS_DIR } from "./config";
import { withFailover } from "./evm";
import { xenMarket, xntUsd } from "./pricing";
import { connect, fetchConfig, PDA } from "./x1";

const SITE = "https://xen-moon-forge-protocol.github.io/Moon-Forge/";
const XNT = 1e9;

// ─── facts ─────────────────────────────────────────────────────────────────

function publishedEpochs(): any[] {
  if (!fs.existsSync(EPOCHS_DIR)) return [];
  return fs.readdirSync(EPOCHS_DIR).filter((f) => /^epoch-\d+\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(EPOCHS_DIR, f), "utf8")))
    .sort((a, b) => a.epoch - b.epoch);
}

async function poolFacts() {
  const { connection, program } = connect();
  const cfg = await fetchConfig(program);
  const info = await connection.getAccountInfo(PDA.rewardVault());
  const rent = info ? await connection.getMinimumBalanceForRentExemption(info.data.length) : 0;
  const free = Math.max(0, (info?.lamports ?? 0) - rent - Number(cfg.rewardReserved));
  return { cfg, poolXnt: free / XNT, budgetXnt: Math.floor(free * 0.1) / XNT, genesisClaimed: Number(cfg.airdropClaimed) };
}

/** Counted (liquidity-adjusted) USD value burned this week on the live portals, as the site computes it. */
async function weekCounted(): Promise<{ countedUsd: number; liveChains: string[] }> {
  const already = new Map<number, bigint>();
  for (const e of publishedEpochs()) for (const b of e.burns ?? []) already.set(b.chainId, (already.get(b.chainId) ?? 0n) + BigInt(b.amountWei));
  let countedUsd = 0;
  const liveChains: string[] = [];
  for (const c of CHAINS.filter((c) => c.portal)) {
    liveChains.push(c.name);
    const total: bigint = await withFailover(c, "totalBurned", (p) => new ethers.Contract(c.portal, ["function totalBurned() view returns (uint256)"], p).totalBurned());
    const week = total - (already.get(c.chainId) ?? 0n);
    if (week <= 0n) continue;
    const m = await xenMarket(c);
    const v = Number(ethers.formatUnits(week, 18)) * m.spotUsd;
    countedUsd += (v * m.liquidityUsd) / (m.liquidityUsd + v);
  }
  return { countedUsd, liveChains };
}

const usd = (v: number) => (v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);
const short = (name: string) => (name === "Optimism" ? "OP" : name);
const xnt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3));

// ─── messages ──────────────────────────────────────────────────────────────

async function weeklyText(): Promise<string> {
  const [pool, price, week] = await Promise.all([poolFacts(), xntUsd(), weekCounted()]);
  const budgetUsd = pool.budgetXnt * price.usd;
  const left = Math.max(0, budgetUsd - week.countedUsd);
  const head = `Moon Forge · week of ${new Date().toISOString().slice(0, 10)}`;
  const core = [
    `• Pool ${xnt(pool.poolXnt)} XNT; this epoch pays at most ${xnt(pool.budgetXnt)} XNT (${usd(budgetUsd)}) in total`,
    left >= 1 ? `• Fair burn capacity left: ${usd(left)}` : `• Small pool: games, Artifacts and donations grow it`,
  ];
  // optional lines, dropped from the end if the post would exceed X's limit
  const optional = [`• Live on ${week.liveChains.map(short).join(", ")}`, `• Genesis claims: ${pool.genesisClaimed}/120`];
  const tail = `On-chain numbers: ${SITE}start`;
  let lines = [head, ...core, ...optional, tail];
  while (xLength(lines.join("\n")) > 280 && optional.length) { optional.pop(); lines = [head, ...core, ...optional, tail]; }
  return lines.join("\n");
}

async function epochText(): Promise<string | null> {
  const last = publishedEpochs().pop();
  if (!last?.publish?.tx) return null;
  const ageH = (Date.now() - Date.parse(last.createdAt)) / 3_600_000;
  if (ageH > 36) return null; // only right after publication
  const chains = [...new Set((last.burns ?? []).map((b: any) => CHAINS.find((c) => c.chainId === b.chainId)?.name).filter(Boolean))];
  const budget = last.publish.budget ? Number(BigInt(last.publish.budget)) / XNT : null;
  return [
    `Epoch ${last.epoch} published on X1.`,
    `• ${(last.burns ?? []).length} burns on ${chains.map((n) => short(String(n))).join(", ") || "-"}, ${(last.leaves ?? []).length} entries${budget !== null ? `, budget ${xnt(budget)} XNT` : ""}`,
    `• Root and data hash on-chain; anyone can recompute the public file`,
    `Check your claim: ${SITE}missions`,
  ].join("\n");
}

// ─── channels ──────────────────────────────────────────────────────────────

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

async function postX(text: string): Promise<string> {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) return "X: no keys, skipped";
  const url = "https://api.x.com/2/tweets";
  const oauth: Record<string, string> = {
    oauth_consumer_key: X_API_KEY, oauth_nonce: crypto.randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_token: X_ACCESS_TOKEN, oauth_version: "1.0",
  };
  // JSON bodies are not part of the OAuth 1.0a signature base string
  const params = Object.keys(oauth).sort().map((k) => `${enc(k)}=${enc(oauth[k])}`).join("&");
  const base = `POST&${enc(url)}&${enc(params)}`;
  oauth.oauth_signature = crypto.createHmac("sha1", `${enc(X_API_SECRET)}&${enc(X_ACCESS_SECRET)}`).update(base).digest("base64");
  const header = "OAuth " + Object.keys(oauth).sort().map((k) => `${enc(k)}="${enc(oauth[k])}"`).join(", ");
  const r = await fetch(url, { method: "POST", headers: { Authorization: header, "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  const body = await r.text();
  if (!r.ok) throw new Error(`X: HTTP ${r.status} ${body.slice(0, 300)}`);
  return `X: posted ${JSON.parse(body)?.data?.id ?? ""}`;
}

async function postTelegram(text: string): Promise<string> {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return "Telegram: no keys, skipped";
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  });
  if (!r.ok) throw new Error(`Telegram: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return "Telegram: posted";
}

/** X counts every link as 23 characters. */
const xLength = (t: string) => t.replace(/https?:\/\/\S+/g, "x".repeat(23)).length;

async function main() {
  const [kind] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const dry = process.argv.includes("--dry");
  const text = kind === "weekly" ? await weeklyText() : kind === "epoch" ? await epochText() : null;
  if (kind !== "weekly" && kind !== "epoch") throw new Error("usage: announce weekly|epoch [--dry]");
  if (!text) { console.log("nothing to announce"); return; }
  console.log(`--- ${kind} (${xLength(text)}/280) ---\n${text}\n---`);
  if (xLength(text) > 280) throw new Error("post longer than 280 characters");
  if (dry) return;
  for (const send of [postX, postTelegram]) {
    try { console.log(await send(text)); } catch (e) { console.error(String(e)); process.exitCode = 1; }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
