/**
 * Daily health check (npm run health). Exits non-zero when something needs a human, so the scheduled GitHub
 * workflow fails and GitHub emails the account that owns it. Read-only: it signs nothing and prints no secret.
 *
 * Red (fail) when: the weekly epoch is late with burns waiting for it and no oracle run succeeded in the slot;
 * the oracle wallet cannot pay about four more epochs (cost measured on the last four) or the keeper wallet is
 * below its floor; a vault is below rent or cannot cover what the program reserved, or Config.reward_reserved
 * drifts from the open epochs; a vault fell more than 20% since yesterday for no recorded reason, or the
 * bankroll lost more than 20% today; the XNT price sources disagree by more than 5%; a live chain has no fresh
 * RPC serving the portal; the epoch files on GitHub Pages differ from the chain; no keeper run in 24 h, or a
 * schedule variable is set to something other than "true"; the oracle key, a pending hand-over or the program's
 * upgrade authority changed; upkeep that costs players money is overdue beyond the keeper's usual gap.
 * Everything else (an RPC fallback in use, a quiet week, the owner's PAT expiring) only warns.
 *
 * The rules live in health-rules.ts (pure, tested); this file feeds them live data. Results go to the console,
 * the job summary and a JSON snapshot (HEALTH_JSON; the workflow keeps it as an artifact). The previous run's
 * snapshot (HEALTH_PREV) gives the 24 h comparisons and the memory of the program authority.
 *
 * Stable-count rows (IMMUTABILITY.md item 3, red only where noted in health-rules.ts): program version (detection),
 * X1 RPCs, game escrows, epoch reconciliation, oracle seat, oracle publications (every epoch in its 48-h hold is the
 * repository's file; a foreign publisher is red with the void command), keeper service level, keeper bond cover, keeper seat, site
 * current, verification (VERIFY_JSON, written by src/health-verify.ts), the pins of src/health-pins.json, K-5 chain
 * history (carried in the snapshot), extra vault / accounting / bound, the stable-days streak (the previous health
 * runs, from the Actions API) and the dispatch token (DISPATCH_EXPIRES). Rows that need the upgraded program print
 * "n/a until upgrade" while the live v2 binary is detected.
 */
import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { ethers } from "ethers";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { CHAINS, EPOCHS_DIR } from "./config";
import { withFailover } from "./evm";
import { WALLETS } from "./heartbeat";
import { xntTwapOnChain } from "./pricing";
import { ARCHITECT, connect, fetchConfig, PDA, programId } from "./x1";
import { PDA_V3, programV3, readUpgradeProbeV3, upgradeVerdictV3 } from "./x1-v3";
import { allAs, BET_ANCHORED, BET_KEEPER, betUnpack, decodeAs, readOracleSeatLivenessV3, seatOf } from "./keeper-v3";
import { openPublicationsV3, voidedPublicationsV3 } from "./seat-v3";
import { rpcHost, x1Connection, x1RpcIgnored, x1RpcList, x1RpcWithPath, X1_MAINNET_GENESIS } from "./x1-rpc";
import PINS from "./health-pins.json";
import { FEED_PATH } from "./feed-v3";
import { rewardsVersionGatedV3, v2ClosedV3 } from "./flow-v3";
import * as R from "./health-rules";

const SITE = "https://xen-moon-forge-protocol.github.io/Moon-Forge/";
/** XDEX WXNT/USDC.X pool: the one x1report quotes and the program's Predictions read. */
const XNT_POOL = "CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR";
const ORACLE_PUBKEY = process.env.ORACLE_PUBKEY || WALLETS.find((w) => w.name === "oracle wallet")!.address;
const KEEPER_PUBKEY = process.env.KEEPER_PUBKEY || WALLETS.find((w) => w.name === "keeper wallet")!.address;
/** Per-epoch cost assumed while no publication could be measured (Epoch rent, a few claims and fees). */
const FALLBACK_EPOCH_COST = 0.02 * R.LAMPORTS;
/** Workflows judged by their last completed run; a non-critical one never turns the check red. */
const WORKFLOWS: [label: string, file: string, critical: boolean][] = [
  ["Keeper", "keeper.yml", true], ["Oracle", "oracle.yml", true], ["CI", "ci.yml", true], ["Site deploy", "deploy-frontend.yml", true], ["Announce", "announce.yml", false],
];
/** GitHub disables the schedules of a public repository after 60 days without a commit; the oracle workflow commits weekly. */
const ACTIVITY_WARN_DAYS = 21, ACTIVITY_FAIL_DAYS = 40;
/** Slots after a bet's or a drawn round's target during which its block hash can still be read (~3 min). */
const HASH_WINDOW_SLOTS = 512;

const rows: R.Row[] = [];
const add = (check: string, state: R.State, detail: string) => rows.push({ check, state, detail });
const push = (r: R.Row | null) => { if (r) rows.push(r); };
const short = (e: unknown, n = 120) => String(e).replace(/\s+/g, " ").slice(0, n);
const hex = (a: number[] | Uint8Array) => Buffer.from(a).toString("hex");
const big = (x: any) => BigInt(x?.toString?.() ?? 0);
const num = (x: any) => Number(x?.toString?.() ?? 0);

/** What one run leaves for the next (HEALTH_PREV in, HEALTH_JSON out). */
interface Snapshot {
  at: number;
  vaults?: { reward: number; bankroll: number; draw: number };
  stats?: R.Counters;
  houseTotalShares?: number;
  program?: R.ProgramAuth;
  /** UTC day of the last program deploy (the stable-days count restarts after it) */
  deploy?: { slot: number; day: string };
  /** K-5: every chain the keeper seat armed since `since` (the chain itself keeps no history of past heads) */
  k5?: R.K5History | null;
}
const next: Snapshot = { at: Math.floor(Date.now() / 1000) };
/** Inputs of the weekly-epoch verdict, judged after both the X1 and the GitHub groups have run (see main). */
let epochInput: { lastEpoch: number; lastPublishTs: number; unpaid: number | null; where: string } | null = null;
/** The newest completed oracle run whose epoch job ran (null until the GitHub group read it, or when it could not). */
let oracleRun: R.OracleRun | null = null;
/** The W2-4 detection (x1-v3.ts upgradeVerdictV3); "unknown" until read. */
let detection: R.Detection = "unknown";
/** Completed health runs of the default branch before this one, per UTC day (null = not readable). */
let healthRuns: { day: string; ok: boolean }[] | null = null;
/** Pins of the privileged keys (src/health-pins.json): a string, null (none expected) or "" (not pinned yet). */
const PIN = PINS as unknown as Record<string, string | null | undefined>;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${what}: timed out after ${ms / 1000}s`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/** A group of checks; a thrown error (or a hang) becomes one row instead of ending the run. */
async function group(name: string, fn: () => Promise<void>, onError: R.State = "warn", ms = 300_000) {
  try {
    await withTimeout(fn(), ms, name);
  } catch (e) {
    add(name, onError, `could not run: ${short(e)}`);
  }
}

/** One check inside a group: a read failure is reported as unknown (warn), never as a false alarm. */
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    add(name, "warn", `could not check: ${short(e)}`);
  }
}

async function getJson(url: string, ms = 20_000): Promise<any> {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}

function readPrev(): Snapshot | null {
  const p = process.env.HEALTH_PREV || (process.env.GITHUB_ACTIONS ? "prev/health-latest.json" : "");
  if (!p || !fs.existsSync(p)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(p, "utf8"))?.snapshot;
    return s && typeof s.at === "number" ? (s as Snapshot) : null;
  } catch {
    return null;
  }
}

interface EpochFileLite {
  epoch: number; createdAt: string; version?: number; root?: string; dataHash?: string; totalScore?: string; leaves?: unknown[] | number;
  burns?: { chainId: number; missionId: string }[];
  publish?: { tx: string; budget?: string; claims?: { tipped: number; dust: number; claimed?: number; failed?: number } };
}

/** The published epoch files of this checkout (the oracle's only memory, committed to git). */
function readEpochFiles(): EpochFileLite[] {
  if (!fs.existsSync(EPOCHS_DIR)) return [];
  return fs.readdirSync(EPOCHS_DIR)
    .filter((f) => /^epoch-\d+\.json$/.test(f))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(EPOCHS_DIR, f), "utf8")) as EpochFileLite; } catch { return null; } })
    .filter((e): e is EpochFileLite => !!e && !!e.publish)
    .sort((a, b) => a.epoch - b.epoch);
}

// ── X1 ───────────────────────────────────────────────────────────────────────

async function x1Checks(prev: Snapshot | null) {
  const now = next.at;
  const c = x1Connection("confirmed"); // X1_RPC_URLS first when set, the default endpoint last (x1-rpc.ts)
  try {
    await withTimeout(c.getSlot(), 30_000, "getSlot");
  } catch (e) {
    add("X1 RPC", "fail", `${x1RpcList().map(rpcHost).join(", ")}: ${short(e)}`);
    return;
  }
  const { program } = connect();
  const acc = program.account as any;
  const cfg = await fetchConfig(program);
  const lastEpoch = num(cfg.lastEpoch), lastPublishTs = num(cfg.lastPublishTs);
  const files = readEpochFiles();

  // which binary runs (the W2-4 probe of the oracle and keeper): the v3 rows switch on by themselves once it says
  // "upgraded"; until then they print "n/a until upgrade"
  const v3 = programV3(new anchor.AnchorProvider(c, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  let deploySlot: number | null = null;
  await step("program version", async () => {
    const probe = await readUpgradeProbeV3(c, "confirmed");
    const v = upgradeVerdictV3(probe, v3);
    detection = v.status;
    deploySlot = v.deploySlot;
    push(R.detectionVerdict(v.status, v.deploySlot, v.reasons));
  });
  const upgraded = () => detection === "upgraded";

  // wallets: the oracle pays every epoch (Epoch rent, the seal, auto-claims); the keeper pays the upkeep and earns tips
  await step("oracle wallet", async () => {
    const bal = await c.getBalance(new PublicKey(ORACLE_PUBKEY));
    const costs = await epochCosts(c, files, lastEpoch).catch(() => [] as number[]);
    push(R.oracleWalletVerdict(bal, costs, FALLBACK_EPOCH_COST));
  });
  await step("keeper wallet", async () => push(R.keeperWalletVerdict(await c.getBalance(new PublicKey(KEEPER_PUBKEY)))));
  // A12 (P11): the last v3 epoch's actual claims (failed ones, and the dust claims the oracle pays rent for)
  const lastV3 = [...files].reverse().find((f) => f.version === 3);
  if (lastV3) push(R.claimsVerdict(lastV3.epoch, lastV3.publish?.claims));

  // vaults: solvency against what the program promised, the reserve accounting, the day breaker, 24 h drops
  let epochs: any[] = [];
  await step("vaults", async () => {
    const infos = await c.getMultipleAccountsInfo([PDA.rewardVault(), PDA.bankrollVault(), PDA.drawVault()]);
    const lam = infos.map((i) => i?.lamports ?? 0);
    const rents = await Promise.all(infos.map((i) => c.getMinimumBalanceForRentExemption(i?.data.length ?? 0)));
    push(R.solvencyVerdict("reward pool", lam[0], rents[0], num(cfg.rewardReserved)));
    push(R.solvencyVerdict("bankroll vault", lam[1], rents[1], num(cfg.bankrollReserved)));
    push(R.solvencyVerdict("lottery vault", lam[2], rents[2], 0));
    epochs = await acc.epoch.all();
    push(R.reservedVerdict(big(cfg.rewardReserved), R.expectedReserved(epochs.map((e) => ({
      closed: !!e.account.closed, budget: big(e.account.budget), claimed: big(e.account.claimed),
      dropReserve: big(e.account.dropReserve), dropPaid: big(e.account.dropPaid), dropState: Number(e.account.dropState),
    })))));
    push(R.bankrollDayVerdict(Math.max(0, lam[1] - rents[1]), num(cfg.bankrollDayStart), num(cfg.bankrollDay), now));
    // since yesterday's snapshot, net of what the lifetime counters explain (claims, drops, tips, prizes, LP exits)
    const stats: R.Counters = {};
    for (const [k, v] of Object.entries(cfg.stats ?? {})) stats[k] = String(v);
    const shares = num(cfg.houseTotalShares);
    const pv = (k: "reward" | "bankroll" | "draw"): R.VaultPrev | null => (prev?.vaults ? { lamports: prev.vaults[k], at: prev.at } : null);
    const explained = {
      reward: R.statsDelta(prev?.stats, stats, ["forgePaid", "dropPaid", "keeperTips"]),
      bankroll: R.statsDelta(prev?.stats, stats, ["paidToPlayers", "edgeToPool", "toArchitect", "toDraw"])
        + R.lpExitExplained(prev?.houseTotalShares ?? 0, shares, Math.max(0, (prev?.vaults?.bankroll ?? 0) - rents[1])),
      draw: R.statsDelta(prev?.stats, stats, ["drawPrizes", "expiredDrawsToPool"]),
    };
    push(R.vaultDropVerdict("reward pool 24h", lam[0], pv("reward"), explained.reward, now));
    push(R.vaultDropVerdict("bankroll 24h", lam[1], pv("bankroll"), explained.bankroll, now));
    push(R.vaultDropVerdict("lottery vault 24h", lam[2], pv("draw"), explained.draw, now));
    next.vaults = { reward: lam[0], bankroll: lam[1], draw: lam[2] };
    next.stats = stats;
    next.houseTotalShares = shares;
  });

  // vault invariants beyond the three vaults: every game wallet, open Jackpot / Prediction pot and seat bond
  await step("game escrows", async () => push(R.escrowVerdict("game escrows", await escrows(c, acc, v3))));
  // every published epoch: claimed + unclaimed + expired = budget, its file in git = the chain, forge_paid = Σ claimed
  await step("epoch reconciliation", async () => push(R.reconcileVerdict(
    epochs.map((e) => ({
      id: num(e.account.id), budget: big(e.account.budget), claimed: big(e.account.claimed), claims: num(e.account.claims), leaves: num(e.account.leaves),
      closed: !!e.account.closed, root: hex(e.account.root), dataHash: hex(e.account.dataHash), totalScore: big(e.account.totalScore),
    })),
    files.map((f) => ({
      epoch: f.epoch, root: String(f.root ?? ""), dataHash: String(f.dataHash ?? ""), totalScore: String(f.totalScore ?? "0"),
      leaves: Array.isArray(f.leaves) ? f.leaves.length : Number(f.leaves ?? 0), budget: f.publish?.budget ?? null,
    })),
    big(cfg.stats?.forgePaid),
  )));

  // privileged state: the oracle key, a pending hand-over, the upgrade authority and redeploys, and the pinned keys
  await step("oracle key", async () => push(R.oracleRoleVerdict(cfg.oracle.toBase58(), ORACLE_PUBKEY, cfg.pendingOracle.toBase58(), PublicKey.default.toBase58())));
  await step("program authority", async () => {
    const auth = await programAuthority(c);
    push(R.authorityVerdict(auth, prev?.program ?? null, ARCHITECT.toBase58()));
    push(R.pinVerdict("pin: upgrade authority", auth.authority, PIN.upgradeAuthority));
    next.program = auth;
    // the stable-days count restarts after a deploy: its day from the block time, else remembered from the snapshot
    const t = await c.getBlockTime(auth.lastDeploySlot).catch(() => null);
    next.deploy = t ? { slot: auth.lastDeploySlot, day: R.utcDay(t) }
      : prev?.deploy && prev.deploy.slot === auth.lastDeploySlot ? prev.deploy
        : prev?.program && prev.program.lastDeploySlot !== auth.lastDeploySlot ? { slot: auth.lastDeploySlot, day: R.utcDay(now) } : undefined;
  });
  await step("pin: Config.architect", async () => push(R.pinVerdict("pin: Config.architect", cfg.architect.toBase58(), PIN.architect)));
  await step("pin: IDL authority", async () => {
    const base = PublicKey.findProgramAddressSync([], programId)[0];
    const info = await c.getAccountInfo(await PublicKey.createWithSeed(base, "anchor:idl", programId));
    push(R.pinVerdict("pin: IDL authority", info ? R.parseIdlAuthority(info.data) : null, PIN.idlAuthority));
  });

  // the upgraded program's seats and pot (n/a until the upgrade is detected)
  await step("oracle seat", async () => {
    if (!upgraded()) {
      push(R.oracleSeatVerdict(detection, null));
      for (const k of ["pin: seat cold key", "pin: seat refund", "pin: keeper seat key"]) push(R.naUntilUpgrade(k, detection));
      return;
    }
    const raw = await c.getAccountInfo(PDA_V3.oracleSeat());
    const d = raw ? decodeAs(v3, "OracleSeat", Buffer.from(raw.data)) : null;
    const liveness = await readOracleSeatLivenessV3(c, v3, now);
    push(R.oracleSeatVerdict(detection, d && liveness ? { liveness, openSince: num(d.openSince), generation: num(d.generation) } : null));
    push(R.pinVerdict("pin: seat cold key", d ? d.cold.toBase58() : null, PIN.seatCold));
    push(R.pinVerdict("pin: seat refund", d ? d.refund.toBase58() : null, PIN.seatRefund));
  });
  // round 4: every base / extra epoch still inside its 48-h hold against the repository's files: a foreign publisher
  // (a stolen hot key, a taken seat) is red with the deadline and the void command (seat-v3.ts)
  await step("oracle publications", async () => {
    if (!upgraded()) return void push(R.oraclePublicationsVerdict(detection, [], now));
    push(R.oraclePublicationsVerdict(detection, await openPublicationsV3(c, v3), now));
  });
  // r4-fix (review r4 finding 12): GATE_BLOCK (the repository variable oracle.yml and keeper.yml read) is amber while set
  await step("anomaly gate block", async () => push(R.gateBlockVerdict(process.env.GATE_BLOCK)));
  // r4-fix (review r4 finding 3): an epoch of ours voided (a heartbeat squatter, a stolen key) is red with the voider
  await step("our epochs voided", async () => {
    if (!upgraded()) return void push(R.ourVoidedVerdict(detection, [], now));
    push(R.ourVoidedVerdict(detection, await voidedPublicationsV3(c, v3, now), now));
  });
  await step("keeper seat", async () => {
    if (!upgraded()) {
      push(R.keeperSeatVerdict(detection, null, now));
      push(R.keeperBondVerdict(detection, null, big(cfg.bankrollReserved)));
      const k5 = R.k5Verdict(detection, null, prev?.k5 ?? null, R.utcDay(now));
      push(k5.row);
      next.k5 = k5.history;
      push(R.keeperRevealVerdict(detection, null, null, 0));
      return;
    }
    const raw = await c.getAccountInfo(PDA_V3.houseKeeper());
    const seat = raw ? seatOf(decodeAs(v3, "HouseKeeper", Buffer.from(raw.data))) : null;
    push(R.keeperSeatVerdict(detection, seat && { keeper: seat.keeper.toBase58(), pendingKeeper: seat.pendingKeeper.toBase58(), lastActiveTs: seat.lastActiveTs, withdrawTs: seat.withdrawTs }, now));
    push(R.keeperBondVerdict(detection, seat && { bond: seat.bond, jackpotReserved: seat.jackpotReserved }, big(cfg.bankrollReserved)));
    push(seat ? R.pinVerdict("pin: keeper seat key", seat.keeper.toBase58(), PIN.keeperSeat) : { check: "pin: keeper seat key", state: "ok", detail: "no keeper seat yet" });
    const k5 = R.k5Verdict(detection, seat && { tip: seat.tip, revealed: Number(seat.revealed), length: Number(seat.length), armedSlot: Number(seat.armedSlot) }, prev?.k5 ?? null, R.utcDay(now));
    push(k5.row);
    next.k5 = k5.history;
    // R-4: an anchored bet waiting at the next position long after its anchor block: the holder is down or cannot derive its chain
    let waiting: { anchorSlot: number } | null = null;
    if (seat && seat.revealed < seat.nextIndex) {
      const bets = (await allAs(c, v3, "Bet")).items.filter((b) => (Number(b.acc.game) & BET_KEEPER) !== 0 && (Number(b.acc.game) & BET_ANCHORED) !== 0);
      const at = bets.map((b) => betUnpack(BigInt(b.acc.targetSlot.toString()))).find((u) => u.index === seat.revealed);
      if (at) waiting = { anchorSlot: Number(at.anchor) };
    }
    push(R.keeperRevealVerdict(detection, seat && { revealed: Number(seat.revealed), nextIndex: Number(seat.nextIndex) }, waiting, await c.getSlot("confirmed")));
  });
  await step("extra pot", async () => {
    if (!upgraded()) return void rows.push(...R.extraPotVerdicts(detection, null, [], null));
    const [xs, xv] = await c.getMultipleAccountsInfo([PDA_V3.extraState(), PDA_V3.extraVault()]);
    const d = xs ? decodeAs(v3, "ExtraState", Buffer.from(xs.data)) : null;
    const x: R.ExtraStateView | null = d && {
      accounted: big(d.accounted), reserved: big(d.reserved), totalIn: big(d.totalIn), totalPaid: big(d.totalPaid), totalReturned: big(d.totalReturned), lastEpoch: num(d.lastEpoch),
    };
    const list: any[] = await (v3.account as any).extraEpoch.all();
    const ex: R.ExtraEpochView[] = list.map((e) => ({ id: num(e.account.id), budget: big(e.account.budget), claimed: big(e.account.claimed), closed: !!e.account.closed, freeBefore: big(e.account.freeBefore) }));
    const vault = xv ? { lamports: xv.lamports, rent: await c.getMinimumBalanceForRentExemption(xv.data.length) } : null;
    rows.push(...R.extraPotVerdicts(detection, x, ex, vault));
  });

  // the weekly epoch: late matters when burns are waiting and the oracle did not get to judge them (the live program
  // refuses empty epochs, and a successful run that published nothing found no value in them; the upgraded one takes
  // the weekly heartbeat, round 4); the verdict is made in main, once the GitHub group has read the oracle's runs
  await step("weekly epoch", async () => {
    const { unpaid, where } = await burnsWaiting(files);
    epochInput = { lastEpoch, lastPublishTs, unpaid, where };
  });

  // upkeep the keeper should already have done, and its service level (oldest unsettled bet vs KEEPER_STALL_SLOTS)
  await step("keeper backlog", async () => {
    const r = await backlog(c, acc, cfg, epochs, now);
    rows.push(...r);
  });

  // the public epoch files must be the ones on-chain
  let newestServed: { version: number | null; createdAt: number | null } = { version: null, createdAt: null };
  await step("pages epochs", async () => {
    const r = await pagesCheck(epochs);
    newestServed = r.newest;
    push(r.row);
  });

  // the site describes the rules the chain runs (the served llms.txt marker vs the detection and the newest file)
  await step("site current", async () => {
    const text = await fetch(`${SITE}llms.txt?t=${Date.now()}`, { signal: AbortSignal.timeout(20_000) }).then((r) => (r.ok ? r.text() : "")).catch(() => "");
    const upgradedAt = upgraded() && deploySlot !== null ? await c.getBlockTime(deploySlot).catch(() => null) : null;
    push(R.siteRulesVerdict(R.parseRulesMarker(text), detection, newestServed.version, { program: upgradedAt, oracle: newestServed.version === 3 ? newestServed.createdAt : null }, now));
  });

  // the hourly week-so-far feed the site and the kit quote from (rewards v3 only; n/a before)
  await step("week-so-far feed", async () => {
    const prevFile = files.find((f) => f.epoch === lastEpoch) ?? null;
    // R-3: live exactly when the next epoch is built under the v3 rules (the same gate as the oracle)
    let live = false;
    try {
      live = upgraded() && !!prevFile && rewardsVersionGatedV3(lastEpoch + 1, prevFile, detection).version === 3;
    } catch {
      live = false;
    }
    let seen: R.FeedSeen | null = null;
    if (live) {
      const j: any = await fetch(`${SITE}${FEED_PATH}?t=${Date.now()}`, { signal: AbortSignal.timeout(20_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (j && typeof j === "object") seen = { kind: j.kind, version: j.version, rules: j.rules, epoch: j.epoch, prevDataHash: j.prevEpoch?.dataHash ?? j.prevDataHash ?? null, asOf: j.asOf, readingsHour: j.readings?.hour ?? null };
    }
    push(R.feedVerdict(detection, live, seen, prevFile && prevFile.dataHash ? { epoch: prevFile.epoch, dataHash: prevFile.dataHash } : null, now));
  });

  // the newest epoch has a green `verify --full` (ops/verification.json, written by src/health-verify.ts)
  await step("verification", async () => {
    const newest = epochs.reduce((m: any, e: any) => (!m || num(e.account.id) > num(m.account.id) ? e : m), null);
    push(R.verificationVerdict(readVerification(), newest ? { epoch: num(newest.account.id), dataHash: hex(newest.account.dataHash), publishedAt: num(newest.account.publishedAt) } : null, now));
  });
}

/** VERIFY_JSON (default ops/verification.json in Actions): the latest verification, or null when absent or unreadable. */
function readVerification(): R.VerificationFile | null {
  const p = process.env.VERIFY_JSON || (process.env.GITHUB_ACTIONS ? "../ops/verification.json" : "");
  if (!p || !fs.existsSync(p)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(p, "utf8"));
    return v && Array.isArray(v.results) ? (v as R.VerificationFile) : null;
  } catch {
    return null;
  }
}

/**
 * Vault invariants beyond the three vaults: every player game wallet (lamports − rent ≥ balance), every OPEN or DRAWING
 * Jackpot round (≥ its total), every OPEN or LOCKED Prediction round (≥ both sides' totals) and, on the upgraded program,
 * the oracle-seat and keeper-seat bonds. Moon Wars and Duels are not listed (their stakes are judged by the keeper rows).
 */
async function escrows(c: Connection, acc: any, v3: anchor.Program): Promise<R.Escrow[]> {
  const out: R.Escrow[] = [];
  const rentOf = new Map<number, number>();
  const rent = async (len: number) => { if (!rentOf.has(len)) rentOf.set(len, await c.getMinimumBalanceForRentExemption(len)); return rentOf.get(len)!; };
  const add = async (items: { publicKey: PublicKey; owed: number; name: string }[]) => {
    for (let i = 0; i < items.length; i += 100) {
      const chunk = items.slice(i, i + 100);
      const infos = await c.getMultipleAccountsInfo(chunk.map((x) => x.publicKey));
      for (let j = 0; j < chunk.length; j++) {
        const info = infos[j];
        if (!info) continue; // closed between the list and the read
        out.push({ name: chunk[j].name, lamports: info.lamports, rent: await rent(info.data.length), owed: chunk[j].owed });
      }
    }
  };
  const players: any[] = await acc.playerState.all();
  await add(players.map((p) => ({ publicKey: p.publicKey, owed: num(p.account.balance), name: `game wallet ${p.account.owner.toBase58().slice(0, 8)}…` })));
  const jackpots: any[] = await acc.jackpotRound.all();
  await add(jackpots.filter((r) => r.account.state === 0 || r.account.state === 1).map((r) => ({ publicKey: r.publicKey, owed: num(r.account.total), name: `jackpot round ${num(r.account.id)}` })));
  const preds: any[] = await acc.predRound.all();
  await add(preds.filter((r) => r.account.state === 0 || r.account.state === 1).map((r) => ({ publicKey: r.publicKey, owed: num(r.account.totals[0]) + num(r.account.totals[1]), name: `prediction ${num(r.account.id)}` })));
  if (detection === "upgraded") {
    const [seat, keeper] = await c.getMultipleAccountsInfo([PDA_V3.oracleSeat(), PDA_V3.houseKeeper()]);
    if (seat) out.push({ name: "oracle seat bond", lamports: seat.lamports, rent: await rent(seat.data.length), owed: num(decodeAs(v3, "OracleSeat", Buffer.from(seat.data)).bond) });
    if (keeper) out.push({ name: "keeper seat bond", lamports: keeper.lamports, rent: await rent(keeper.data.length), owed: num(decodeAs(v3, "HouseKeeper", Buffer.from(keeper.data)).bond) });
  }
  return out;
}

/** Slots since a bet's clock started: its anchor slot (upgraded keeper bets, packed in target_slot) or its target slot. */
function betAgeSlots(b: any, slot: number): number {
  const ts = big(b.account.targetSlot);
  const start = (Number(b.account.game) & BET_KEEPER) !== 0 ? Number(betUnpack(ts).anchor) : Number(ts);
  return Math.max(0, slot - start);
}

/**
 * Lamports the oracle wallet spent in each of the last four publication runs (fees and rent, net of refunds, tips and
 * the D-47 allowance), on the chain clock: R.epochCostsOf attributes each Moon Forge transaction of the wallet to one
 * publication, anchored on the block time of its publish transaction (the file's createdAt when that is not listed).
 */
async function epochCosts(c: Connection, files: EpochFileLite[], lastEpoch: number): Promise<number[]> {
  const recent = files.filter((f) => f.epoch > lastEpoch - 4 && f.epoch <= lastEpoch && f.createdAt);
  if (!recent.length) return [];
  const oracle = new PublicKey(ORACLE_PUBKEY);
  const sigs = await c.getSignaturesForAddress(oracle, { limit: 1000 });
  const sigTime = new Map(sigs.filter((s) => s.blockTime).map((s) => [s.signature, s.blockTime as number]));
  const pubs: R.PublicationTime[] = files
    .filter((f) => f.createdAt || (f.publish?.tx && sigTime.has(f.publish.tx)))
    .map((f) => ({ epoch: f.epoch, at: (f.publish?.tx && sigTime.get(f.publish.tx)) || Math.floor(Date.parse(f.createdAt) / 1000) }));
  const mineAt = pubs.filter((p) => recent.some((f) => f.epoch === p.epoch)).map((p) => p.at);
  const t0 = Math.min(...mineAt) - R.EPOCH_COST_BEFORE_S, t1 = Math.max(...mineAt) + R.EPOCH_COST_AFTER_S;
  // transactions inspected at most, to spare the RPC (the newest first)
  const mine = sigs.filter((s) => !s.err && s.blockTime && s.blockTime >= t0 && s.blockTime <= t1).slice(0, 120);
  const txs: R.WalletTx[] = [];
  for (const s of mine) {
    const tx = await c.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) continue;
    const keys = tx.transaction.message.staticAccountKeys;
    const i = keys.findIndex((k) => k.equals(oracle));
    if (i < 0) continue;
    txs.push({ blockTime: tx.blockTime ?? (s.blockTime as number), spent: tx.meta.preBalances[i] - tx.meta.postBalances[i], program: keys.some((k) => k.equals(programId)) });
  }
  return R.epochCostsOf(pubs, txs, recent.map((f) => f.epoch));
}

/** Burns the portals registered after the last paid mission of each chain (portal.totalMissions − last paid id). */
async function burnsWaiting(files: EpochFileLite[]): Promise<{ unpaid: number | null; where: string }> {
  const live = CHAINS.filter((c) => c.portal);
  if (!live.length) return { unpaid: 0, where: "" };
  const paid = new Map<number, number>();
  for (const f of files) for (const b of f.burns ?? []) paid.set(b.chainId, Math.max(paid.get(b.chainId) ?? 0, Number(b.missionId)));
  let total = 0, failed = 0;
  const parts: string[] = [];
  await Promise.all(live.map(async (chain) => {
    try {
      const n: bigint = await withTimeout(
        withFailover(chain, "totalMissions", (p) => new ethers.Contract(chain.portal, ["function totalMissions() view returns (uint256)"], p).totalMissions()),
        60_000, `${chain.name} totalMissions`,
      );
      const waiting = Math.max(0, Number(n) - (paid.get(chain.chainId) ?? 0));
      if (waiting > 0) { total += waiting; parts.push(`${chain.name} (${waiting})`); }
    } catch {
      failed++;
    }
  }));
  if (failed && total === 0) return { unpaid: null, where: "" };
  return { unpaid: total, where: parts.join(", ") };
}

/** Upgrade authority and last deploy slot from the BPF upgradeable loader's ProgramData account. */
async function programAuthority(c: Connection): Promise<R.ProgramAuth> {
  const prog = await c.getAccountInfo(programId);
  if (!prog || prog.data.length < 36) throw new Error("program account not found");
  const pd = await c.getAccountInfo(new PublicKey(prog.data.subarray(4, 36)));
  if (!pd) throw new Error("programdata account not found");
  return R.parseProgramData(pd.data);
}

/** Bets past their window, drawn rounds not settled, pending drop seals, open epochs past expiry, stuck wars and predictions. */
async function backlog(c: Connection, acc: any, cfg: any, epochs: any[], now: number): Promise<R.Row[]> {
  const slot = await c.getSlot("confirmed");
  const lost: string[] = [], late: string[] = [];
  const bets: any[] = await acc.bet.all();
  // service level: a Bet account exists until it is settled or refunded, so the oldest one is the oldest unsettled bet
  const oldest = bets.reduce((m: { ageSlots: number; key: string } | null, b) => {
    const ageSlots = betAgeSlots(b, slot);
    return !m || ageSlots > m.ageSlots ? { ageSlots, key: b.publicKey.toBase58().slice(0, 8) + "…" } : m;
  }, null);
  const sla = R.keeperSlaVerdict(oldest, bets.length);
  // a bet past its hash window is lost for the player whether or not the keeper has closed it yet; the keeper
  // closes it on its next pass (gaps of hours between passes are normal), so only one left open for longer
  // than that says something about the keeper
  const expired = bets.filter((b) => num(b.account.targetSlot) + HASH_WINDOW_SLOTS < slot);
  const stale = expired.filter((b) => R.slotAgeH(slot, num(b.account.targetSlot)) > R.EXPIRED_BET_RED_H).length;
  const pending = bets.filter((b) => { const t = num(b.account.targetSlot); return t + 150 < slot && t + HASH_WINDOW_SLOTS >= slot; }).length;
  if (stale) lost.push(`${stale} expired house bet(s) still open more than ${R.EXPIRED_BET_RED_H} h after their target slot (the keeper has not passed)`);
  if (expired.length - stale) late.push(`${expired.length - stale} house bet(s) past the settle window (lost for the player; the keeper closes them on its next pass)`);
  if (pending) late.push(`${pending} bet(s) waiting to be settled`);
  for (const [kind, id] of [["jackpot", num(cfg.jackpotRound)], ["lottery", num(cfg.drawRound)]] as const) {
    const r = await (kind === "jackpot" ? acc.jackpotRound.fetchNullable(PDA.jackpot(id)) : acc.drawRound.fetchNullable(PDA.draw(id)));
    if (!r) continue;
    if (r.state === 0 && num(r.endTs) > 0 && now > num(r.endTs) + 600) late.push(`${kind} round ${id} ended ${Math.round((now - num(r.endTs)) / 60)} min ago and is not drawn`);
    if (r.state === 1) {
      if (slot > num(r.targetSlot) + HASH_WINDOW_SLOTS) lost.push(`${kind} round ${id} drawn but not settled inside the hash window (refund, or prize to the pool)`);
      else late.push(`${kind} round ${id} waiting to be settled`);
    }
  }
  for (const e of epochs) {
    const id = num(e.account.id);
    if (e.account.closed) continue;
    if (now >= num(e.account.expiresAt) + 86_400) late.push(`epoch ${id} past its claim window and not expired`);
    if (Number(e.account.dropState) === 1) {
      const age = now - num(e.account.publishedAt);
      if (age > 600) lost.push(`epoch ${id} Forge Drop seed not sealed ${Math.round(age / 60)} min after publication (window ~3 min)`);
      else late.push(`epoch ${id} drop seed to seal`);
    }
  }
  for (const w of await acc.war.all()) {
    const k = w.publicKey.toBase58().slice(0, 8), s = w.account.state;
    if (s === 1) late.push(`war ${k} waiting to start`);
    if (s === 2 && now > num(w.account.deadline) + 600) late.push(`war ${k} turn timer ran out ${Math.round((now - num(w.account.deadline)) / 60)} min ago`);
    if (s === 3) late.push(`war ${k} to pay out`);
  }
  for (const r of await acc.predRound.all()) {
    const id = num(r.account.id), s = r.account.state;
    if (s === 0 && now > num(r.account.lockTs) + 600) late.push(`prediction ${id} not locked ${Math.round((now - num(r.account.lockTs)) / 60)} min after its time`);
    if (s === 1 && now > num(r.account.endTs) + 600) late.push(`prediction ${id} not settled ${Math.round((now - num(r.account.endTs)) / 60)} min after its end`);
    if (s === 2 || s === 3) late.push(`prediction ${id} payouts pending`);
  }
  return [R.backlogVerdict(lost, late), sla];
}

async function pagesCheck(epochs: any[]): Promise<{ row: R.Row; newest: { version: number | null; createdAt: number | null } }> {
  const onChain: R.EpochRef[] = epochs.map((e) => ({ epoch: num(e.account.id), root: hex(e.account.root), dataHash: hex(e.account.dataHash) }));
  const bust = `?t=${Date.now()}`; // Pages ignores the query; the CDN caches per URL
  const index = await getJson(`${SITE}epochs/index.json${bust}`).catch(() => null);
  const listed: R.EpochRef[] | null = index && Array.isArray(index.epochs)
    ? index.epochs.map((x: any) => ({ epoch: Number(x.epoch), root: String(x.root), dataHash: String(x.dataHash) }))
    : null;
  const newest = onChain.reduce((m, e) => Math.max(m, e.epoch), 0);
  let served: { version: number | null; createdAt: number | null } = { version: null, createdAt: null };
  const latest = newest
    ? await getJson(`${SITE}epochs/epoch-${newest}.json${bust}`).then((f: any) => {
      served = { version: Number(f.version) || null, createdAt: f.createdAt ? Math.floor(Date.parse(String(f.createdAt)) / 1000) : null };
      return { epoch: Number(f.epoch), root: String(f.root), dataHash: String(f.dataHash) };
    }).catch(() => null)
    : null;
  return { row: R.pagesVerdict(onChain, listed, latest), newest: served };
}

// ── Prices ───────────────────────────────────────────────────────────────────

/** The same pool read four ways: a reader bug (GeckoTerminal's USD for X1) or a dead feed shows as divergence or absence. */
async function priceChecks() {
  const sources: Record<string, number | null> = {};
  const read = async (name: string, fn: () => Promise<number>) => {
    try { sources[name] = await withTimeout(fn(), 30_000, name); } catch { sources[name] = null; }
  };
  await Promise.all([
    read("x1report", async () => { const j = await getJson("https://x1report.com/api/xnt"); return Number(j?.priceUsd ?? j?.price ?? j?.usd ?? j?.data?.price); }),
    read("XDEX API", async () => {
      const j = await getJson("https://api.xdex.xyz/api/xendex/pool/list?network=X1%20Mainnet");
      const pools: any[] = j?.data?.list || j?.data || [];
      const main = pools.find((p) => String(p.pool_address || p.address) === XNT_POOL);
      return Number(main?.token1_price ?? main?.price);
    }),
    read("XDEX on-chain TWAP", () => xntTwapOnChain()),
    read("GeckoTerminal candle", async () => {
      // currency=token: XNT in USDC.X (1 USDC.X = $1); GeckoTerminal's own USD for X1 tokens is wrong
      const j = await getJson(`https://api.geckoterminal.com/api/v2/networks/x1-network/pools/${XNT_POOL}/ohlcv/hour?aggregate=1&limit=1&token=base&currency=token`);
      return Number(j?.data?.attributes?.ohlcv_list?.[0]?.[4]);
    }),
  ]);
  push(R.priceVerdict(sources, 5));
}

// ── EVM RPCs ─────────────────────────────────────────────────────────────────

/** Every RPC of every live chain: head age and the portal's code; the verdict names the fallback in use. */
async function rpcChecks() {
  const now = Math.floor(Date.now() / 1000);
  await Promise.all(CHAINS.filter((c) => c.portal).map(async (chain) => {
    const probes = await Promise.all(chain.rpcs.map(async (rpc): Promise<R.RpcProbe> => {
      const host = new URL(rpc).host;
      const p = new ethers.JsonRpcProvider(rpc, chain.chainId, { staticNetwork: true });
      try {
        const [block, code] = await withTimeout(Promise.all([p.getBlock("latest"), p.getCode(chain.portal)]), 20_000, host);
        if (!block) return { host, ok: false, error: "no latest block" };
        return { host, ok: true, ageS: Math.max(0, now - Number(block.timestamp)), code: code.length > 2 };
      } catch (e) {
        return { host, ok: false, error: short(e, 80) };
      } finally {
        p.destroy();
      }
    }));
    push(R.rpcVerdict(chain.name, probes));
  }));
}

// ── X1 RPCs ──────────────────────────────────────────────────────────────────

/** Every X1 endpoint the oracle and keeper may use (X1_RPC_URLS, then the default): it answers, and on X1 mainnet. */
async function x1RpcChecks() {
  const genesis = process.env.X1_GENESIS_HASH || X1_MAINNET_GENESIS;
  const call = async (url: string, method: string) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j: any = await r.json();
    if (j?.error) throw new Error(String(j.error?.message ?? "RPC error").slice(0, 60));
    return j?.result;
  };
  const probes = await Promise.all(x1RpcList().map(async (url): Promise<R.X1RpcProbe> => {
    const host = rpcHost(url);
    try {
      const [g] = await Promise.all([call(url, "getGenesisHash"), call(url, "getSlot")]);
      return { host, ok: true, genesisOk: g === genesis };
    } catch (e) {
      return { host, ok: false, error: short(e, 60) };
    }
  }));
  // an X1_RPC_URLS entry that is not an http(s) URL is never used (x1-rpc.ts): reported here as an endpoint that is down
  const ignored = x1RpcIgnored();
  if (ignored) probes.unshift({ host: `${ignored} X1_RPC_URLS entr${ignored === 1 ? "y" : "ies"} not an http(s) URL`, ok: false });
  push(R.x1RpcVerdict(probes, x1RpcWithPath()));
}

// ── GitHub ───────────────────────────────────────────────────────────────────

async function githubChecks() {
  push(R.automationVerdict("keeper schedule", process.env.KEEPER_ENABLED));
  push(R.automationVerdict("oracle schedule", process.env.ORACLE_ENABLED));
  push(R.patVerdict(process.env.PAT_EXPIRES, next.at));
  push(R.dispatchVerdict(process.env.DISPATCH_EXPIRES, next.at));
  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    add("workflows", "warn", "GITHUB_REPOSITORY / GITHUB_TOKEN not set: skipped");
    return;
  }
  const H = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "moonforge-health" };
  const api = async (p: string): Promise<any> => {
    const r = await fetch(`https://api.github.com/repos/${repo}/${p}`, { headers: H, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`GitHub API ${p.split("?")[0]}: HTTP ${r.status}`);
    return r.json();
  };
  // only runs of the default branch, and never pull_request runs: CI also runs on pull requests from anyone's
  // fork, and after the last push to the default branch one failing outside PR would otherwise be "the last run"
  const branch: string = await api("").then((j) => j.default_branch || "main").catch(() => "main");
  for (const [label, file, critical] of WORKFLOWS) {
    try {
      const j = await api(`actions/workflows/${file}/runs?branch=${encodeURIComponent(branch)}&per_page=10`);
      // a queued run superseded by a newer one in the same concurrency group ends "cancelled": not a failure
      let runs: any[] = (j.workflow_runs ?? []).filter((r: any) =>
        r.conclusion !== "cancelled" && r.conclusion !== "skipped" && r.event !== "pull_request" && r.event !== "pull_request_target");
      if (file === "keeper.yml") {
        const newest = runs[0];
        if (!newest) add("keeper freshness", "fail", "no keeper run among the last 10 (all cancelled or skipped)");
        else push(R.keeperFreshnessVerdict(newest.status !== "completed" ? 0 : (Date.now() - Date.parse(newest.updated_at)) / 3_600_000));
      }
      runs = runs.filter((r: any) => r.status === "completed");
      // the oracle workflow also makes heartbeat-only runs (epoch job skipped): judge it by the runs where the epoch job ran
      if (file === "oracle.yml") {
        const real: any[] = [];
        for (const r of runs) {
          const jobs: any[] = (await api(`actions/runs/${r.id}/jobs?per_page=20`)).jobs ?? [];
          const ep = jobs.find((x) => x.name === "epoch");
          if (ep && ep.conclusion !== "skipped") real.push({ ...r, conclusion: ep.conclusion });
        }
        runs = real;
        if (runs[0]) oracleRun = { ok: runs[0].conclusion === "success", at: Math.floor(Date.parse(runs[0].updated_at) / 1000) };
      }
      const last = runs[0];
      if (!last) { add(label, critical ? "fail" : "warn", `no completed run on ${branch} among the last 10`); continue; }
      const ageH = (Date.now() - Date.parse(last.updated_at)) / 3_600_000;
      add(label, last.conclusion === "success" ? "ok" : critical ? "fail" : "warn", `last run ${last.conclusion}, ${ageH.toFixed(1)} h ago (${last.event})`);
    } catch (e) {
      add(label, "warn", `could not read the runs: ${short(e, 80)}`);
    }
  }
  // the previous health runs of the default branch (this run is still in progress, so it is not among them): the
  // stable-days streak counts UTC days whose completed runs all succeeded (a cancelled or skipped run says nothing)
  try {
    const j = await api(`actions/workflows/health.yml/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=100`);
    healthRuns = (j.workflow_runs ?? [])
      .filter((r: any) => r.conclusion !== "cancelled" && r.conclusion !== "skipped" && r.event !== "pull_request" && r.event !== "pull_request_target" && String(r.id) !== String(process.env.GITHUB_RUN_ID ?? ""))
      .map((r: any) => ({ day: String(r.run_started_at ?? r.created_at).slice(0, 10), ok: r.conclusion === "success" }));
  } catch (e) {
    healthRuns = null;
    add("stable-days streak", "warn", `could not read the previous health runs: ${short(e, 80)}`);
  }
  try {
    const date = (await api(`commits/${branch}`)).commit?.committer?.date;
    if (!date) throw new Error("no commit date");
    const days = Math.floor((Date.now() - Date.parse(date)) / 86_400_000);
    add("repository activity", days < ACTIVITY_WARN_DAYS ? "ok" : days < ACTIVITY_FAIL_DAYS ? "warn" : "fail",
      `last commit on ${branch} ${days} days ago (GitHub disables every schedule after 60 days without one; the oracle workflow commits ops/heartbeat.json weekly)`);
  } catch (e) {
    add("repository activity", "warn", `could not read the last commit: ${short(e, 80)}`);
  }
}

// ── Site ─────────────────────────────────────────────────────────────────────

async function webChecks() {
  for (const [label, url, json] of [["site", SITE, false], ["agent card", `${SITE}agent-card.json`, true]] as const) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) { add(label, "fail", `HTTP ${r.status}`); continue; }
      if (json) JSON.parse(await r.text());
      add(label, "ok", `HTTP ${r.status}`);
    } catch (e) {
      add(label, "fail", short(e));
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const prev = readPrev();
  await Promise.all([
    group("X1 checks", () => x1Checks(prev), "fail"),
    group("GitHub checks", githubChecks),
    group("XNT price sources", priceChecks),
    group("EVM RPCs", rpcChecks),
    group("X1 RPCs", x1RpcChecks),
    group("site", webChecks),
  ]);
  // needs both groups: the burns waiting (X1 + portals) and whether the oracle already judged them in this slot (GitHub)
  if (epochInput) push(R.epochVerdict(epochInput.lastEpoch, epochInput.lastPublishTs, next.at, epochInput.unpaid, epochInput.where, oracleRun, detection === "upgraded", v2ClosedV3(next.at)));
  // last: today counts as a stable day only when no other row of this run is red
  if (!rows.some((r) => r.check === "stable-days streak")) {
    push(R.streakVerdict(healthRuns, R.utcDay(next.at), !rows.some((r) => r.state === "fail"), next.deploy?.day ?? null));
  }
  const order = { fail: 0, warn: 1, ok: 2 };
  rows.sort((a, b) => order[a.state] - order[b.state]);
  const icon = { ok: "OK  ", warn: "WARN", fail: "FAIL" };
  for (const r of rows) console.log(`${icon[r.state]} ${r.check.padEnd(24)} ${r.detail}`);
  const fails = rows.filter((r) => r.state === "fail").length, warns = rows.filter((r) => r.state === "warn").length;
  const overall: R.State = fails ? "fail" : warns ? "warn" : "ok";
  const utc = new Date().toISOString();
  if (process.env.GITHUB_STEP_SUMMARY) {
    const mark = { ok: "✅", warn: "⚠️", fail: "❌" };
    const md = ["| | Check | Detail |", "|---|---|---|", ...rows.map((r) => `| ${mark[r.state]} | ${r.check} | ${r.detail.replace(/\|/g, "\\|")} |`)].join("\n");
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Moon Forge health: ${overall.toUpperCase()}\n\n${utc}: ${fails} red, ${warns} warning(s), ${rows.length} checks${prev ? "" : " (no previous snapshot: 24 h comparisons skipped)"}\n\n${md}\n`);
  }
  const out = process.env.HEALTH_JSON || (process.env.GITHUB_ACTIONS ? "../ops/health-latest.json" : "");
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ utc, overall, fails, warns, rows, snapshot: next }, null, 2) + "\n");
    console.log(`snapshot written to ${out}`);
  }
  console.log(fails ? `${fails} problem(s) need attention` : warns ? `no problem, ${warns} warning(s)` : "all checks passed");
  process.exitCode = fails ? 1 : 0;
  // an RPC client that keeps a socket open must not keep the job alive
  setTimeout(() => process.exit(fails ? 1 : 0), 3000).unref();
}

main().catch((e) => { console.error(e); process.exit(1); });
