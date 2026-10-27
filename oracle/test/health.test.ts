/**
 * Health-check rules (no network): weekly epoch timing, wallet runway, vault solvency and 24 h drops,
 * reserved accounting, price divergence, RPC probes, keeper freshness, Pages consistency, privileged state.
 *   npx ts-node test/health.test.ts
 */
import assert from "assert";
import bs58 from "bs58";
import {
  authorityVerdict, automationVerdict, backlogVerdict, bankrollDayVerdict, divergence, EpochAccount, epochOverdue, epochVerdict, expectedReserved,
  EXPIRED_BET_RED_H, keeperFreshnessVerdict, keeperWalletVerdict, LAMPORTS, lpExitExplained, oracleRoleVerdict, oracleWalletVerdict, pagesVerdict,
  parseProgramData, patVerdict, priceVerdict, reservedVerdict, rpcVerdict, runway, slotAgeH, slotStart, solvencyVerdict, statsDelta, vaultDropVerdict,
  chainHeadOf, detectionVerdict, dispatchVerdict, EpochFileRef, EpochOnChain, escrowVerdict, ExtraEpochView, extraPotVerdicts, ExtraStateView,
  K5History, k5Verdict, KEEPER_DEAD_DELAY_S, KEEPER_STALL_SLOTS, keeperBondVerdict, keeperSeatVerdict, keeperSlaVerdict, LIVE_PROGRAM_TAG,
  naUntilUpgrade, oracleSeatVerdict, parseIdlAuthority, parseRulesMarker, pinVerdict, reconcileVerdict, SITE_GRACE_S, siteRulesVerdict,
  streakVerdict, utcDay, VerificationFile, verificationVerdict, x1RpcVerdict, keeperRevealVerdict, REVEAL_STALL_RED_SLOTS, REVEAL_STALL_WARN_SLOTS,
  epochCostsOf,
} from "../src/health-rules";
import { keccak } from "../src/merkle";

const X = LAMPORTS;
const X_ = 1_000_000_000n;
const SUNDAY = Date.UTC(2026, 9, 18) / 1000; // 2026-10-18 00:00 UTC, a Sunday
let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log(`  ok  ${name}`); };

// ── weekly epoch ─────────────────────────────────────────────────────────────
t("slotStart is the Sunday 00:00 UTC that contains now", () => {
  assert.equal(slotStart(SUNDAY), SUNDAY);
  assert.equal(slotStart(SUNDAY + 3 * 86_400 + 5), SUNDAY);
  assert.equal(slotStart(SUNDAY + 7 * 86_400), SUNDAY + 7 * 86_400);
});
t("overdue only after 48 h into a slot with nothing published since it opened", () => {
  assert.equal(epochOverdue(SUNDAY - 1, SUNDAY + 47 * 3600), false, "inside the grace window");
  assert.equal(epochOverdue(SUNDAY - 1, SUNDAY + 49 * 3600), true, "past the grace window");
  assert.equal(epochOverdue(SUNDAY + 5000, SUNDAY + 49 * 3600), false, "published in this slot");
  assert.equal(epochOverdue(0, SUNDAY + 49 * 3600), true, "never published");
});
t("late epoch with burns waiting is red; a quiet week only warns; unknown warns", () => {
  const late = SUNDAY + 60 * 3600;
  assert.equal(epochVerdict(1, SUNDAY - 1, late, 3, "Optimism (3)").state, "fail");
  assert.match(epochVerdict(1, SUNDAY - 1, late, 3, "Optimism (3)").detail, /3 burn\(s\) waiting on Optimism.*no oracle run finished in this slot/);
  assert.equal(epochVerdict(1, SUNDAY - 1, late, 0).state, "warn");
  assert.equal(epochVerdict(1, SUNDAY - 1, late, null).state, "warn");
  assert.equal(epochVerdict(1, SUNDAY - 1, SUNDAY + 10 * 3600, 5).state, "ok", "burns waiting but the slot is young");
});
t("burns waiting that a successful oracle run of this slot left unpaid (dust, no market) only warn", () => {
  const late = SUNDAY + 60 * 3600;
  const ok = { ok: true, at: SUNDAY + 2 * 3600 }, failed = { ok: false, at: SUNDAY + 2 * 3600 }, lastWeek = { ok: true, at: SUNDAY - 3 * 86_400 };
  assert.equal(epochVerdict(1, SUNDAY - 1, late, 1, "Base (1)", ok).state, "warn", "the oracle saw them and published nothing");
  assert.match(epochVerdict(1, SUNDAY - 1, late, 1, "Base (1)", ok).detail, /published nothing/);
  assert.equal(epochVerdict(1, SUNDAY - 1, late, 1, "Base (1)", failed).state, "fail", "the run in this slot failed");
  assert.match(epochVerdict(1, SUNDAY - 1, late, 1, "Base (1)", failed).detail, /run in this slot failed/);
  assert.equal(epochVerdict(1, SUNDAY - 1, late, 1, "Base (1)", lastWeek).state, "fail", "last week's run does not count");
  assert.equal(epochVerdict(1, SUNDAY - 1, late, 0, "", ok).state, "warn", "quiet week");
});

// ── wallets ──────────────────────────────────────────────────────────────────
t("runway uses the mean of the measured costs, else the fallback", () => {
  assert.deepEqual(runway(1 * X, [0.01 * X, 0.03 * X], 0.1 * X), { epochs: 50, cost: 0.02 * X });
  assert.deepEqual(runway(1 * X, [0, 0], 0.1 * X), { epochs: 10, cost: 0.1 * X });
});
t("oracle wallet: red below 4 epochs or the 0.05 XNT floor, warn below 12", () => {
  assert.equal(oracleWalletVerdict(0.49 * X, [0.008 * X], 0.05 * X).state, "ok");
  assert.equal(oracleWalletVerdict(0.08 * X, [0.008 * X], 0.05 * X).state, "warn", "10 epochs of runway");
  assert.equal(oracleWalletVerdict(0.03 * X, [0.001 * X], 0.05 * X).state, "fail", "below the floor");
  assert.equal(oracleWalletVerdict(0.3 * X, [0.1 * X], 0.05 * X).state, "fail", "3 epochs of runway");
  assert.match(oracleWalletVerdict(0.3 * X, [], 0.05 * X).detail, /estimated/);
});
t("epoch costs: weekly publications keep the fixed [−1 h, +6 h] window; plain transfers never count", () => {
  const W = 7 * 86_400, T0 = SUNDAY + 3600;
  const pubs = [{ epoch: 1, at: T0 }, { epoch: 2, at: T0 + W }, { epoch: 3, at: T0 + 2 * W }];
  const tx = (dt: number, spent: number, program = true) => ({ blockTime: T0 + W + dt, spent, program });
  const costs = epochCostsOf(pubs, [
    tx(-3600, 10), tx(-3601, 1_000), // 1 h before epoch 2: counted; a second earlier: no publication run
    tx(0, 2_331_600), tx(60, 5_000), tx(6 * 3600, 7), tx(6 * 3600 + 1, 100_000), // the run, its last second, then nothing
    tx(120, 49_000_000_000, false), tx(130, -230_000_000, false), // a withdrawal and a top-up: the balance, not the cost
  ], [2, 3]);
  assert.deepEqual(costs, [10 + 2_331_600 + 5_000 + 7, 0]);
  // the same transactions under the old rule (every transaction inside [createdAt − 1 h, createdAt + 6 h]) minus the transfers
  const old = (at: number, list: { blockTime: number; spent: number; program: boolean }[]) =>
    list.filter((x) => x.program && x.blockTime >= at - 3600 && x.blockTime <= at + 6 * 3600).reduce((s, x) => s + x.spent, 0);
  const list = [tx(-3600, 10), tx(0, 2_331_600), tx(60, 5_000), tx(6 * 3600, 7)];
  assert.equal(epochCostsOf(pubs, list, [2])[0], old(T0 + W, list), "identical to the fixed window when publications are a week apart");
});
t("epoch costs on a local validator (epochs seconds apart): each run keeps only its own transactions, once", () => {
  // e2e-oracle-v3.sh: epochs 2-5 published within ~6 minutes; the harness sweeps and refills the wallet with plain transfers
  const pubs = [{ epoch: 1, at: 1000 }, { epoch: 2, at: 1240 }, { epoch: 3, at: 1300 }, { epoch: 4, at: 1500 }, { epoch: 5, at: 1600 }];
  const txs = [
    { blockTime: 1100, spent: 5_000, program: true }, // a keeper helper after epoch 1: epoch 1's run, not counted below
    { blockTime: 1230, spent: 49_745_000_000, program: false }, // the harness sweep before epoch 2
    { blockTime: 1240, spent: -49_995_000, program: true }, // epoch 2's publish with the D-47 allowance
    { blockTime: 1301, spent: -49_995_000, program: true }, { blockTime: 1310, spent: 2_000_000, program: true }, // epoch 3 + extra
    { blockTime: 1490, spent: -225_000_000, program: false }, // the harness top-up before epoch 4
    { blockTime: 1500, spent: -19_995_000, program: true }, { blockTime: 1601, spent: -19_995_000, program: true },
  ];
  const costs = epochCostsOf(pubs, txs, [2, 3, 4, 5]);
  assert.deepEqual(costs, [-49_995_000, -47_995_000, -19_995_000, -19_995_000]);
  // no positive sample: the runway falls back to the estimate (self-funded by D-47), never to a sweep of 49.7 XNT
  assert.equal(oracleWalletVerdict(0.2556 * X, costs, 0.02 * X).state, "ok");
  assert.match(oracleWalletVerdict(0.2556 * X, costs, 0.02 * X).detail, /estimated/);
  // a real cost still turns it red: a run that spends 0.1 XNT on a 0.2556 XNT wallet is under 4 epochs of runway
  assert.equal(oracleWalletVerdict(0.2556 * X, epochCostsOf(pubs, [{ blockTime: 1601, spent: 100_000_000, program: true }], [5]), 0.02 * X).state, "fail");
});
t("keeper wallet thresholds", () => {
  assert.equal(keeperWalletVerdict(0.04 * X).state, "fail");
  assert.equal(keeperWalletVerdict(0.1 * X).state, "warn");
  assert.equal(keeperWalletVerdict(0.5 * X).state, "ok");
});

// ── vaults ───────────────────────────────────────────────────────────────────
t("solvency: lamports − rent must cover the reserve; below rent is red", () => {
  assert.equal(solvencyVerdict("reward pool", 10 * X, 0.001 * X, 1 * X).state, "ok");
  assert.equal(solvencyVerdict("reward pool", 1 * X, 0.001 * X, 1 * X).state, "fail");
  assert.equal(solvencyVerdict("lottery vault", 0.0005 * X, 0.001 * X, 0).state, "fail");
});
t("reserved accounting: exact match ok, small drift warns, larger drift fails", () => {
  assert.equal(reservedVerdict(5n * 10n ** 9n, 5n * 10n ** 9n).state, "ok");
  assert.equal(reservedVerdict(5n * 10n ** 9n, 5n * 10n ** 9n + 10_000_000n).state, "warn", "0.2% off");
  assert.equal(reservedVerdict(5n * 10n ** 9n, 6n * 10n ** 9n).state, "fail");
  assert.equal(reservedVerdict(0n, 500_000n).state, "warn", "0.0005 XNT off at zero expected");
});
t("24 h drop: red above 20% unexplained, ok when claims/prizes explain it or no fresh snapshot", () => {
  const prev = { lamports: 10 * X, at: 1000 };
  const now = 1000 + 24 * 3600;
  assert.equal(vaultDropVerdict("reward pool 24h", 7 * X, prev, 0, now).state, "fail");
  assert.equal(vaultDropVerdict("reward pool 24h", 7 * X, prev, 2.5 * X, now).state, "ok", "claims explain 2.5 XNT");
  assert.equal(vaultDropVerdict("reward pool 24h", 8.5 * X, prev, 0, now).state, "ok", "15% drop");
  assert.equal(vaultDropVerdict("reward pool 24h", 1 * X, prev, 0, 1000 + 40 * 3600).state, "ok", "snapshot too old to compare");
  assert.equal(vaultDropVerdict("reward pool 24h", 1 * X, null, 0, now).state, "ok");
  assert.equal(vaultDropVerdict("reward pool 24h", 12 * X, prev, 0, now).state, "ok", "growth");
});
t("bankroll day reference: 10% = breaker (warn), 20% = red, other day = ok", () => {
  const now = 1_800_000_000;
  const today = Math.floor(now / 86_400);
  assert.equal(bankrollDayVerdict(0.95 * X, 1 * X, today, now).state, "ok");
  assert.equal(bankrollDayVerdict(0.85 * X, 1 * X, today, now).state, "warn");
  assert.equal(bankrollDayVerdict(0.7 * X, 1 * X, today, now).state, "fail");
  assert.equal(bankrollDayVerdict(0.7 * X, 1 * X, today - 1, now).state, "ok");
});

// ── prices ───────────────────────────────────────────────────────────────────
t("divergence is the largest deviation from the median", () => {
  assert.ok(Math.abs(divergence([1, 1, 1.1]) - 0.1) < 1e-9, `${divergence([1, 1, 1.1])} should be 0.1`); // float: (1.1 - 1) / 1 is not exactly 0.1
  assert.equal(divergence([0.19]), 0);
  assert.equal(divergence([0.19, 0, 0.19]), 0, "zeros are ignored");
});
t("price sources: >5% apart is red, one source only warns, 4 agreeing sources ok", () => {
  assert.equal(priceVerdict({ a: 0.185, b: 0.186, c: 0.184, d: 0.1855 }).state, "ok");
  assert.equal(priceVerdict({ a: 0.185, b: 0.266, c: 0.184 }).state, "fail", "GeckoTerminal USD bug (+37%)");
  assert.equal(priceVerdict({ a: 0.185, b: null, c: null }).state, "warn");
  assert.match(priceVerdict({ a: 0.185, b: null, c: 0.186 }).detail, /unavailable: b/);
});

// ── EVM RPCs ─────────────────────────────────────────────────────────────────
t("rpc verdict: fresh primary ok, fallback in use warns, single survivor warns, none red, stale red", () => {
  const ok = (host: string, ageS = 10) => ({ host, ok: true, ageS, code: true });
  const down = (host: string) => ({ host, ok: false, error: "ECONNREFUSED" });
  assert.equal(rpcVerdict("Base", [ok("a"), ok("b")]).state, "ok");
  assert.equal(rpcVerdict("Base", [down("a"), ok("b")]).state, "warn");
  assert.match(rpcVerdict("Base", [down("a"), ok("b")]).detail, /fallback #2 b/);
  assert.equal(rpcVerdict("Base", [ok("a"), down("b")]).state, "warn", "only one answers");
  assert.equal(rpcVerdict("Base", [down("a"), down("b")]).state, "fail");
  assert.equal(rpcVerdict("Base", [ok("a", 3600), down("b")]).state, "fail", "stale head");
  assert.equal(rpcVerdict("Base", [{ host: "a", ok: true, ageS: 5, code: false }]).state, "fail", "no portal code");
  assert.equal(rpcVerdict("Avalanche", [ok("a")]).state, "ok", "single configured RPC that works");
});

// ── automation ───────────────────────────────────────────────────────────────
t("keeper freshness: ok under 12 h, warn to 24 h (cron gaps of hours are normal), red after", () => {
  assert.equal(keeperFreshnessVerdict(11).state, "ok");
  assert.equal(keeperFreshnessVerdict(13).state, "warn");
  assert.equal(keeperFreshnessVerdict(25).state, "fail");
});
t("expired house bets: hours since the target slot at 400 ms per slot; red only past the keeper's usual gap", () => {
  assert.equal(slotAgeH(9000, 0), 1);
  assert.equal(slotAgeH(100, 200), 0, "target in the future");
  assert.ok(slotAgeH(13 * 9000, 0) > EXPIRED_BET_RED_H);
  assert.ok(slotAgeH(2 * 9000, 0) < EXPIRED_BET_RED_H, "two hours: the keeper has simply not passed yet");
});
t("PAT expiry never fails", () => {
  assert.equal(patVerdict(undefined, 0), null);
  assert.equal(patVerdict("2026-11-06", Date.UTC(2026, 10, 1) / 1000)!.state, "warn");
  assert.equal(patVerdict("2026-11-06", Date.UTC(2026, 9, 1) / 1000)!.state, "ok");
  assert.equal(patVerdict("soon", 0)!.state, "warn");
});

// ── Pages vs chain ───────────────────────────────────────────────────────────
t("pages: every on-chain epoch indexed with the same root/dataHash and the newest file served", () => {
  const e1 = { epoch: 1, root: "aa", dataHash: "bb" }, e2 = { epoch: 2, root: "cc", dataHash: "dd" };
  assert.equal(pagesVerdict([e1, e2], [e1, e2], e2).state, "ok");
  assert.equal(pagesVerdict([e1, e2], [e1], e2).state, "fail", "epoch 2 missing from index");
  assert.equal(pagesVerdict([e1, e2], [e1, { ...e2, root: "xx" }], e2).state, "fail", "root differs");
  assert.equal(pagesVerdict([e1, e2], [e1, e2], null).state, "fail", "file not served");
  assert.equal(pagesVerdict([e1, e2], [e1, e2], { ...e2, dataHash: "zz" }).state, "fail", "served file differs");
  assert.equal(pagesVerdict([e1], null, e1).state, "fail", "no index");
  assert.equal(pagesVerdict([e1], [e1, e2], e1).state, "fail", "index lists an epoch not on-chain");
  assert.equal(pagesVerdict([], [], null).state, "ok", "nothing published yet");
});

// ── privileged state ─────────────────────────────────────────────────────────
t("oracle key and hand-over", () => {
  const D = "11111111111111111111111111111111";
  assert.equal(oracleRoleVerdict("J5", "J5", D, D).state, "ok");
  assert.equal(oracleRoleVerdict("Ev", "J5", D, D).state, "fail");
  assert.equal(oracleRoleVerdict("J5", "J5", "New", D).state, "fail");
});
t("program authority: architect or none ok; change red; redeploy warns", () => {
  const A = "7PuG";
  assert.equal(authorityVerdict({ authority: A, lastDeploySlot: 1 }, null, A).state, "ok");
  assert.equal(authorityVerdict({ authority: null, lastDeploySlot: 1 }, null, A).state, "ok", "burned");
  assert.equal(authorityVerdict({ authority: "Mallory", lastDeploySlot: 1 }, null, A).state, "fail");
  assert.equal(authorityVerdict({ authority: null, lastDeploySlot: 1 }, { authority: A, lastDeploySlot: 1 }, A).state, "fail", "changed since yesterday (even to none)");
  assert.equal(authorityVerdict({ authority: A, lastDeploySlot: 2 }, { authority: A, lastDeploySlot: 1 }, A).state, "warn", "redeployed");
});
t("keeper backlog: money-losing items red, late items warn", () => {
  assert.equal(backlogVerdict([], []).state, "ok");
  assert.equal(backlogVerdict([], ["war x waiting to start"]).state, "warn");
  assert.equal(backlogVerdict(["2 house bet(s) past their settle window"], []).state, "fail");
});

// ── automation switches ──────────────────────────────────────────────────────
t("schedule variables: not judged outside Actions, true ok, unset (deliberate stop) warns, anything else red", () => {
  assert.equal(automationVerdict("keeper schedule", undefined), null);
  assert.equal(automationVerdict("keeper schedule", "true")!.state, "ok");
  assert.equal(automationVerdict("keeper schedule", "")!.state, "warn");
  assert.equal(automationVerdict("oracle schedule", "false")!.state, "fail");
  assert.equal(automationVerdict("oracle schedule", "True")!.state, "fail", "a typo would silently stop everything");
});

// ── reserved accounting input ────────────────────────────────────────────────
t("expected reserve: unpaid budget of open epochs plus the unpaid drop reserve while pending or sealed", () => {
  const e = (o: Partial<EpochAccount>): EpochAccount => ({ closed: false, budget: 100n, claimed: 40n, dropReserve: 10n, dropPaid: 0n, dropState: 2, ...o });
  assert.equal(expectedReserved([e({})]), 70n);
  assert.equal(expectedReserved([e({ dropState: 1 })]), 70n, "pending");
  assert.equal(expectedReserved([e({ dropState: 3 })]), 60n, "cancelled drop: reserve already released");
  assert.equal(expectedReserved([e({ dropState: 0, dropReserve: 0n })]), 60n, "no drop");
  assert.equal(expectedReserved([e({ dropPaid: 15n })]), 60n, "luck paid beyond the reserve");
  assert.equal(expectedReserved([e({ claimed: 120n })]), 10n, "over-claimed budget counts 0");
  assert.equal(expectedReserved([e({ closed: true })]), 0n);
  assert.equal(expectedReserved([e({}), e({ claimed: 100n, dropState: 1 })]), 80n);
});

// ── explained outflows ───────────────────────────────────────────────────────
t("stats delta sums only growth; LP exits explain their share of the previous value", () => {
  assert.equal(statsDelta({ a: "10", b: 5 }, { a: "25", b: 3 }, ["a", "b"]), 15);
  assert.equal(statsDelta({ a: "10" }, { a: "10", c: "7" }, ["a", "c"]), 7, "counter new since the snapshot");
  assert.equal(statsDelta(undefined, { a: 1 }, ["a"]), 0);
  assert.equal(lpExitExplained(100, 75, 4 * X), 1 * X);
  assert.equal(lpExitExplained(100, 120, 4 * X), 0, "deposits explain nothing");
  assert.equal(lpExitExplained(0, 0, 4 * X), 0);
});

// ── programdata parsing ──────────────────────────────────────────────────────
t("programdata: tag, last deploy slot, optional upgrade authority", () => {
  const A = "7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd";
  const buf = Buffer.alloc(45 + 100);
  buf.writeUInt32LE(3, 0);
  buf.writeBigUInt64LE(85_429_880n, 4);
  buf[12] = 1;
  Buffer.from(bs58.decode(A)).copy(buf, 13);
  assert.deepEqual(parseProgramData(buf), { authority: A, lastDeploySlot: 85_429_880 });
  const none = Buffer.alloc(13);
  none.writeUInt32LE(3, 0);
  none.writeBigUInt64LE(7n, 4);
  assert.deepEqual(parseProgramData(none), { authority: null, lastDeploySlot: 7 }, "burned");
  assert.throws(() => parseProgramData(Buffer.alloc(45)), /not a ProgramData/);
  assert.throws(() => parseProgramData(Buffer.alloc(4)), /too short/);
});

// ═══ stable-count rows (IMMUTABILITY.md item 3) ═════════════════════════════════════════════════════════════════════
const NOW = Date.UTC(2026, 10, 20, 12) / 1000; // 2026-11-20 12:00 UTC
const D = "11111111111111111111111111111111";

t("rows that need the upgrade: n/a (ok) on the v2 binary, warn when unknown, null (checked) when upgraded", () => {
  assert.deepEqual(naUntilUpgrade("x", "legacy"), { check: "x", state: "ok", detail: "n/a until upgrade (the live v2 binary is detected)" });
  assert.equal(naUntilUpgrade("x", "unknown")!.state, "warn");
  assert.equal(naUntilUpgrade("x", "upgraded"), null);
  assert.equal(detectionVerdict("legacy", 85_429_880).state, "ok");
  assert.equal(detectionVerdict("upgraded", 90_000_000).state, "ok");
  assert.equal(detectionVerdict("unknown", null, ["half-done"]).state, "warn", "never red before detection");
  // every v3 row on the v2 binary: ok, never fail
  const legacy = [
    oracleSeatVerdict("legacy", null), keeperBondVerdict("legacy", null, 5n * 10n ** 9n), keeperSeatVerdict("legacy", null, NOW),
    k5Verdict("legacy", null, null, "2026-11-20").row, ...extraPotVerdicts("legacy", null, [], null),
  ];
  for (const r of legacy) assert.equal(r.state, "ok", `${r.check} on v2`);
  assert.deepEqual(extraPotVerdicts("legacy", null, [], null).map((r) => r.check), ["extra vault", "extra accounting", "extra bound"]);
});

t("X1 RPCs: all on mainnet ok; a listed one down or on another cluster warns; none usable red", () => {
  assert.equal(x1RpcVerdict([{ host: "a", ok: true, genesisOk: true }, { host: "rpc.mainnet.x1.xyz", ok: true, genesisOk: true }]).state, "ok");
  assert.equal(x1RpcVerdict([{ host: "a", ok: false }, { host: "rpc.mainnet.x1.xyz", ok: true, genesisOk: true }]).state, "warn");
  assert.match(x1RpcVerdict([{ host: "t", ok: true, genesisOk: false }, { host: "m", ok: true, genesisOk: true }]).detail, /t:other cluster/);
  assert.equal(x1RpcVerdict([{ host: "a", ok: false }, { host: "m", ok: false }]).state, "fail");
  // R-8: an entry with a path or a query (a key in a public run log) warns, even when every endpoint is fine
  const keyed = x1RpcVerdict([{ host: "a", ok: true, genesisOk: true }, { host: "m", ok: true, genesisOk: true }], 1);
  assert.equal(keyed.state, "warn");
  assert.match(keyed.detail, /public run logs.*keyless/);
});

t("R-4: an anchored bet waiting at the next keeper position: ok for minutes, amber after ~10 min, red after ~1 h; n/a on v2", () => {
  const seat = { revealed: 7, nextIndex: 9 };
  assert.equal(keeperRevealVerdict("legacy", null, null, 0).state, "ok");
  assert.equal(keeperRevealVerdict("upgraded", null, null, 100).detail, "no keeper seat yet");
  assert.equal(keeperRevealVerdict("upgraded", seat, null, 100).state, "ok");
  assert.equal(keeperRevealVerdict("upgraded", seat, { anchorSlot: 1_000 }, 1_000 + REVEAL_STALL_WARN_SLOTS).state, "ok");
  assert.equal(keeperRevealVerdict("upgraded", seat, { anchorSlot: 1_000 }, 1_001 + REVEAL_STALL_WARN_SLOTS).state, "warn");
  const red = keeperRevealVerdict("upgraded", seat, { anchorSlot: 1_000 }, 1_001 + REVEAL_STALL_RED_SLOTS);
  assert.equal(red.state, "fail");
  assert.match(red.detail, /position 7 .*cannot derive the seat's chain \(R-4\)/);
});

t("vault invariants: every escrow covers what it owes, a short one is red", () => {
  const ok = [{ name: "game wallet A", lamports: 2 * X, rent: 0.002 * X, owed: 1 * X }, { name: "jackpot round 4", lamports: 0.5 * X, rent: 0.002 * X, owed: 0.4 * X }];
  assert.equal(escrowVerdict("game escrows", ok).state, "ok");
  assert.equal(escrowVerdict("game escrows", []).state, "ok", "nothing open");
  const bad = escrowVerdict("game escrows", [...ok, { name: "game wallet B", lamports: 1 * X, rent: 0.002 * X, owed: 1 * X }]);
  assert.equal(bad.state, "fail");
  assert.match(bad.detail, /1 of 3 account\(s\) cannot cover.*game wallet B/);
});

t("epoch reconciliation: claimed + unclaimed + expired = budget, files match the chain, forge_paid = Σ claimed", () => {
  const e = (o: Partial<EpochOnChain> = {}): EpochOnChain => ({ id: 1, budget: 388_359_377n, claimed: 388_359_377n, claims: 1, leaves: 1, closed: false, root: "r1", dataHash: "h1", totalScore: 63_918n, ...o });
  const f = (o: Partial<EpochFileRef> = {}): EpochFileRef => ({ epoch: 1, root: "r1", dataHash: "h1", leaves: 1, totalScore: "63918", budget: "388359377", ...o });
  const good = reconcileVerdict([e()], [f()], 388_359_377n);
  assert.equal(good.state, "ok");
  assert.match(good.detail, /budget 0\.3884 XNT = claimed 0\.3884 XNT \+ unclaimed 0\.0000 XNT \+ expired 0\.0000 XNT/);
  const two = reconcileVerdict([e(), e({ id: 2, budget: 10n * X_, claimed: 4n * X_, closed: true, root: "r2", dataHash: "h2" })], [f(), f({ epoch: 2, root: "r2", dataHash: "h2", budget: "10000000000" })], 388_359_377n + 4n * X_);
  assert.equal(two.state, "ok");
  assert.match(two.detail, /expired 6\.0000 XNT/);
  assert.equal(reconcileVerdict([e({ claimed: 400_000_000n })], [f()], 400_000_000n).state, "fail", "claimed above budget");
  assert.equal(reconcileVerdict([e({ claims: 2 })], [f()], 388_359_377n).state, "fail", "more claims than leaves");
  assert.equal(reconcileVerdict([e()], [], 388_359_377n).state, "fail", "file missing from git");
  assert.equal(reconcileVerdict([e()], [f({ dataHash: "zz" })], 388_359_377n).state, "fail", "file differs");
  assert.equal(reconcileVerdict([e()], [f({ budget: "1" })], 388_359_377n).state, "fail", "recorded budget differs");
  assert.equal(reconcileVerdict([e()], [f({ budget: null })], 388_359_377n).state, "ok", "a file without a recorded budget is compared on the rest");
  assert.equal(reconcileVerdict([e()], [f(), f({ epoch: 2 })], 388_359_377n).state, "fail", "file without an Epoch account");
  assert.match(reconcileVerdict([e()], [f()], 1n).detail, /forge_paid/, "the lifetime counter drifted");
  assert.equal(reconcileVerdict([], [], 0n).state, "ok", "nothing published");
});

t("oracle cadence: seat liveness maps ok / warn / critical / dead; a resigned seat warns", () => {
  const l = (state: "ok" | "warn" | "critical" | "dead") => ({ deadAt: NOW + 86_400, publishBy: NOW - 86_400, state, detail: `seat ${state}` });
  const s = (state: "ok" | "warn" | "critical" | "dead", openSince = 0) => ({ liveness: l(state), openSince, generation: 1 });
  assert.equal(oracleSeatVerdict("upgraded", s("ok")).state, "ok");
  assert.equal(oracleSeatVerdict("upgraded", s("warn")).state, "warn");
  assert.equal(oracleSeatVerdict("upgraded", s("critical")).state, "fail", "an epoch published now can no longer save it");
  assert.equal(oracleSeatVerdict("upgraded", s("dead")).state, "fail");
  assert.equal(oracleSeatVerdict("upgraded", s("ok", NOW - 3600)).state, "warn", "open (resigned)");
  assert.equal(oracleSeatVerdict("upgraded", null).state, "fail", "upgraded but no seat decodes");
  assert.equal(oracleSeatVerdict("unknown", null).state, "warn");
});

t("keeper service level: oldest unsettled bet vs KEEPER_STALL_SLOTS (235,000, the program's constant)", () => {
  // the mirror check needs the program source of the final upgrade (it has instructions/keeper.rs); a tree that still
  // carries the live v2 source (main before the review commit) skips that one line and says so
  const progDir = require("path").join(__dirname, "../../programs/moon-forge/src");
  if (require("fs").existsSync(require("path").join(progDir, "instructions/keeper.rs"))) {
    const src = require("fs").readFileSync(require("path").join(progDir, "constants.rs"), "utf8");
    assert.ok(src.includes(`pub const KEEPER_STALL_SLOTS: u64 = 235_000;`), "mirrors constants.rs (mainnet build)");
  } else console.log("  (the live v2 program source is in this tree: the KEEPER_STALL_SLOTS mirror line is skipped)");
  assert.equal(KEEPER_STALL_SLOTS, 235_000);
  assert.equal(keeperSlaVerdict(null, 0).state, "ok");
  assert.equal(keeperSlaVerdict({ ageSlots: 900, key: "Bet1" }, 1).state, "ok");
  assert.equal(keeperSlaVerdict({ ageSlots: 120_000, key: "Bet1" }, 1).state, "warn", "past half the limit");
  assert.equal(keeperSlaVerdict({ ageSlots: 235_001, key: "Bet1" }, 3).state, "fail", "past the stall limit");
  assert.match(keeperSlaVerdict({ ageSlots: 235_001, key: "Bet1" }, 3).detail, /3 unsettled bet\(s\); oldest Bet1 is 235,001 slots/);
});

t("keeper bond cover (K-3): bond >= bankroll_reserved + jackpot_reserved", () => {
  assert.equal(keeperBondVerdict("upgraded", { bond: 20n * X_, jackpotReserved: 5n * X_ }, 15n * X_).state, "ok", "exactly covered");
  assert.equal(keeperBondVerdict("upgraded", { bond: 20n * X_, jackpotReserved: 5n * X_ }, 15n * X_ + 1n).state, "fail");
  assert.equal(keeperBondVerdict("upgraded", null, 0n).state, "ok", "no seat yet, nothing reserved");
  assert.equal(keeperBondVerdict("upgraded", null, 1n).state, "fail", "payouts reserved without a seat");
});

t("keeper seat: alive ok; 10 days before death, or a withdrawal notice, warns; dead or a hand-over pending is red", () => {
  const seat = (o: Partial<{ keeper: string; pendingKeeper: string; lastActiveTs: number; withdrawTs: number }> = {}) => ({ keeper: "XjMMmtbD", pendingKeeper: D, lastActiveTs: NOW - 86_400, withdrawTs: 0, ...o });
  assert.equal(keeperSeatVerdict("upgraded", seat(), NOW).state, "ok");
  assert.equal(keeperSeatVerdict("upgraded", null, NOW).state, "ok", "no seat yet");
  assert.equal(keeperSeatVerdict("upgraded", seat({ lastActiveTs: NOW - KEEPER_DEAD_DELAY_S + 5 * 86_400 }), NOW).state, "warn");
  assert.equal(keeperSeatVerdict("upgraded", seat({ withdrawTs: NOW - 3600 }), NOW).state, "warn");
  assert.equal(keeperSeatVerdict("upgraded", seat({ lastActiveTs: NOW - KEEPER_DEAD_DELAY_S }), NOW).state, "fail", "dead");
  assert.equal(keeperSeatVerdict("upgraded", seat({ pendingKeeper: "Mallory" }), NOW).state, "fail");
});

t("site current: the served marker equals the detection", () => {
  const llms = "Moon Forge\nRules described: program tag program-2026-10-12, oracle v2, valid from 2026-10-12 (texts checked on 2026-10-22). Dated notices: x";
  assert.deepEqual(parseRulesMarker(llms), { program: LIVE_PROGRAM_TAG, oracle: "v2" });
  assert.equal(parseRulesMarker("nothing here"), null);
  const v2 = { program: LIVE_PROGRAM_TAG, oracle: "v2" }, v3 = { program: "program-2026-11-11", oracle: "v3" };
  const none = { program: null, oracle: null };
  assert.equal(siteRulesVerdict(v2, "legacy", 2, none, NOW).state, "ok", "today");
  assert.equal(siteRulesVerdict({ program: "program-2026-11-11", oracle: "v2" }, "legacy", 2, none, NOW).state, "fail", "future rules shown as live");
  assert.equal(siteRulesVerdict({ program: LIVE_PROGRAM_TAG, oracle: "v3" }, "legacy", 2, none, NOW).state, "fail", "v3 oracle rules cannot be live on the v2 binary");
  assert.equal(siteRulesVerdict(v2, "upgraded", 2, { program: NOW - 3600, oracle: null }, NOW).state, "warn", "upgrade an hour ago: grace");
  assert.equal(siteRulesVerdict(v2, "upgraded", 2, { program: NOW - SITE_GRACE_S - 1, oracle: null }, NOW).state, "fail", "stale after the grace");
  assert.equal(siteRulesVerdict({ program: "program-2026-11-11", oracle: "v2" }, "upgraded", 2, none, NOW).state, "ok", "switched site, v2 epochs");
  assert.equal(siteRulesVerdict({ program: "program-2026-11-11", oracle: "v3" }, "upgraded", 2, none, NOW).state, "warn", "boundary passed before the first v3 file");
  assert.equal(siteRulesVerdict(v3, "upgraded", 3, none, NOW).state, "ok");
  assert.equal(siteRulesVerdict({ program: "program-2026-11-11", oracle: "v2" }, "upgraded", 3, { program: null, oracle: NOW - SITE_GRACE_S - 1 }, NOW).state, "fail", "v3 file live, site still says v2");
  assert.equal(siteRulesVerdict(null, "legacy", 2, none, NOW).state, "warn", "marker unreadable");
  assert.equal(siteRulesVerdict(v2, "unknown", 2, none, NOW).state, "warn");
});

t("verification green: the newest on-chain epoch has a green --full verification of exactly its file", () => {
  const newest = { epoch: 2, dataHash: "h2", publishedAt: NOW - 3 * 86_400 };
  const entry = (o: Partial<VerificationFile["results"][0]> = {}) => ({ file: "epoch-2.json", kind: "epoch" as const, epoch: 2, dataHash: "h2", status: "ok" as const, detail: "", at: "2026-11-18T01:00:00Z", ...o });
  const vf = (...results: VerificationFile["results"]): VerificationFile => ({ at: "2026-11-20T01:00:00Z", results });
  assert.equal(verificationVerdict(vf(entry()), newest, NOW).state, "ok");
  assert.equal(verificationVerdict(vf(entry({ status: "failed", detail: "root differs" })), newest, NOW).state, "fail");
  assert.equal(verificationVerdict(vf(entry({ status: "error", detail: "RPC timeout" })), newest, NOW).state, "warn", "could not finish: retried");
  assert.equal(verificationVerdict(vf(entry({ epoch: 1, file: "epoch-1.json", dataHash: "h1" })), newest, NOW).state, "fail", "newest not verified 3 days after publication");
  assert.equal(verificationVerdict(vf(entry({ epoch: 1, file: "epoch-1.json", dataHash: "h1" })), { ...newest, publishedAt: NOW - 3600 }, NOW).state, "warn", "inside the grace");
  assert.equal(verificationVerdict(vf(entry({ dataHash: "other" })), newest, NOW).state, "fail", "a different file was verified");
  assert.equal(verificationVerdict(null, newest, NOW).state, "fail", "no verification.json 3 days after publication");
  assert.equal(verificationVerdict(null, null, NOW).state, "ok", "nothing published");
  assert.equal(verificationVerdict(vf(entry(), entry({ kind: "extra", file: "extra-2.json", status: "failed", detail: "x" })), newest, NOW).state, "fail", "a failed extra file is red too");
});

t("privileged-change pins: equal ok, changed red, none expected, not pinned warns; IDL authority parsing", () => {
  assert.equal(pinVerdict("pin: upgrade authority", "7PuG", "7PuG").state, "ok");
  assert.equal(pinVerdict("pin: upgrade authority", "Mallory", "7PuG").state, "fail");
  assert.equal(pinVerdict("pin: upgrade authority", null, null).state, "ok", "burned, as pinned after the freeze");
  assert.equal(pinVerdict("pin: upgrade authority", "7PuG", null).state, "fail", "an authority where none is expected");
  assert.equal(pinVerdict("pin: upgrade authority", null, "7PuG").state, "fail", "burned while the pin still expects it");
  assert.equal(pinVerdict("pin: seat cold key", "Cold", undefined).state, "warn");
  assert.equal(pinVerdict("pin: seat cold key", "Cold", "").state, "warn");
  const A = "7PuG8ELKXzvZqVLawFnmjDJqq4KEyRhssKQEq7aQM6Qd";
  const idl = Buffer.alloc(8 + 32 + 4 + 10);
  Buffer.from(bs58.decode(A)).copy(idl, 8);
  assert.equal(parseIdlAuthority(idl), A);
  assert.throws(() => parseIdlAuthority(Buffer.alloc(20)), /too short/);
});

t("K-5: a new chain overlapping an earlier one is red, wherever the overlap is; the tip must hash back to its head", () => {
  // a chain: x_L = seed, x_{k} = keccak(x_{k+1}), head x_0; the k-th reveal is x_k
  const chain = (seed: number, len: number) => { const xs: Buffer[] = [Buffer.alloc(32, seed)]; for (let i = 0; i < len; i++) xs.unshift(keccak(xs[0])); return xs; };
  const A = chain(1, 40), B = chain(2, 40);
  const hA = A[0].toString("hex");
  assert.equal(chainHeadOf(A[7], 7).toString("hex"), hA, "seven reveals: the tip hashes back to the head");
  const today = "2026-11-20";
  const first = k5Verdict("upgraded", { tip: A[3], revealed: 3, length: 40, armedSlot: 100 }, null, today);
  assert.equal(first.row.state, "warn", "history starts today");
  assert.deepEqual(first.history!.chains, [{ armedSlot: 100, head: hA, length: 40, revealedSeen: 3 }]);
  const same = k5Verdict("upgraded", { tip: A[9], revealed: 9, length: 40, armedSlot: 100 }, first.history, today);
  assert.equal(same.row.state, "ok");
  assert.equal(same.history!.chains[0].revealedSeen, 9);
  assert.equal(k5Verdict("upgraded", { tip: B[2], revealed: 9, length: 40, armedSlot: 100 }, first.history, today).row.state, "fail", "same armed slot, tip no longer on its chain");
  const fresh = k5Verdict("upgraded", { tip: B[1], revealed: 1, length: 40, armedSlot: 200 }, same.history, today);
  assert.equal(fresh.row.state, "ok", "an unrelated new chain");
  assert.equal(fresh.history!.chains.length, 2);
  // re-arm with an old revealed value of A (x_5): its next reveals x_6.. are already public
  const reuse = k5Verdict("upgraded", { tip: A[5], revealed: 0, length: 35, armedSlot: 300 }, fresh.history, today);
  assert.equal(reuse.row.state, "fail");
  assert.match(reuse.row.detail, /armed at slot 300 lies on the chain armed at slot 100 \(position 5/);
  // re-arm with A's old head itself
  assert.equal(k5Verdict("upgraded", { tip: A[0], revealed: 0, length: 40, armedSlot: 300 }, fresh.history, today).row.state, "fail");
  // a new chain that extends BELOW an old one: the old chain's revealed values are the new chain's future reveals
  const longer = [keccak(A[0]), ...A]; // head keccak(x_0 of A): A's head is position 1 of the new chain
  const below = k5Verdict("upgraded", { tip: longer[0], revealed: 0, length: 41, armedSlot: 300 }, fresh.history, today);
  assert.equal(below.row.state, "fail");
  assert.match(below.row.detail, /chain armed at slot 100 lies on the chain armed at slot 300 \(position 1\)/);
  assert.equal(k5Verdict("upgraded", null, fresh.history, today).row.state, "ok", "no seat");
});

t("extra pot: vault covers the pot, accounted = in − paid, reserved = Σ open, budget within 8% of X", () => {
  const x = (o: Partial<ExtraStateView> = {}): ExtraStateView => ({ accounted: 96n * X_, reserved: 4n * X_, totalIn: 100n * X_, totalPaid: 4n * X_, totalReturned: 0n, lastEpoch: 2, ...o });
  const ep = (o: Partial<ExtraEpochView> = {}): ExtraEpochView => ({ id: 2, budget: 8n * X_, claimed: 4n * X_, closed: false, freeBefore: 100n * X_, ...o });
  const vault = { lamports: 96 * X + 1_000_000, rent: 1_000_000 };
  const ok = extraPotVerdicts("upgraded", x(), [ep()], vault);
  assert.deepEqual(ok.map((r) => [r.check, r.state]), [["extra vault", "ok"], ["extra accounting", "ok"], ["extra bound", "ok"]]);
  assert.equal(extraPotVerdicts("upgraded", x(), [ep()], { lamports: 95 * X, rent: 1_000_000 })[0].state, "fail", "vault below the accounted pot");
  assert.equal(extraPotVerdicts("upgraded", x({ accounted: 97n * X_ }), [ep()], { lamports: 98 * X, rent: 0 })[1].state, "fail", "accounted ≠ in − paid");
  assert.equal(extraPotVerdicts("upgraded", x({ reserved: 5n * X_ }), [ep()], vault)[1].state, "fail", "reserved ≠ Σ open");
  assert.equal(extraPotVerdicts("upgraded", x({ reserved: 0n }), [ep({ closed: true })], vault)[1].state, "ok", "a closed epoch reserves nothing");
  assert.equal(extraPotVerdicts("upgraded", x(), [ep({ budget: 9n * X_, claimed: 5n * X_ })], vault)[2].state, "fail", "budget above 8% of X");
  assert.equal(extraPotVerdicts("upgraded", x({ reserved: 0n }), [ep({ claimed: 9n * X_ })], vault)[2].state, "fail", "claimed above budget");
  assert.equal(extraPotVerdicts("upgraded", null, [], null)[0].state, "fail", "upgraded but unreadable");
});

t("stable-days streak: consecutive UTC days of runs with no FAIL, from the day after the last deploy", () => {
  const runs = (spec: [string, boolean][]) => spec.map(([day, ok]) => ({ day, ok }));
  const today = "2026-11-20";
  const green = runs([["2026-11-19", true], ["2026-11-18", true], ["2026-11-18", true], ["2026-11-17", true]]);
  assert.match(streakVerdict(green, today, true, "2026-11-11").detail, /^4 consecutive day\(s\) with no FAIL \(since 2026-11-17\); 14 needed.*no health run on 2026-11-16/);
  assert.match(streakVerdict(runs([["2026-11-19", true], ["2026-11-18", false]]), today, true, null).detail, /^2 consecutive.*a FAIL on 2026-11-18/);
  assert.match(streakVerdict(runs([["2026-11-18", true], ["2026-11-18", false]]), "2026-11-19", true, null).detail, /^1 consecutive.*a FAIL on 2026-11-18/, "one red run spoils its day");
  assert.match(streakVerdict(green, today, false, null).detail, /^0 consecutive.*a FAIL today/);
  assert.match(streakVerdict(runs([["2026-11-20", false]]), today, true, null).detail, /^0 consecutive.*a FAIL today/, "an earlier red run today");
  assert.match(streakVerdict(green, today, true, "2026-11-18").detail, /^2 consecutive.*the day after the last program deploy \(2026-11-18\)/, "a redeploy restarts the count");
  assert.match(streakVerdict(green, today, true, today).detail, /^0 consecutive.*deployed today/);
  const fourteen = runs(Array.from({ length: 13 }, (_, i) => [utcDay(Date.parse(`${today}T00:00:00Z`) / 1000 - (i + 1) * 86_400), true] as [string, boolean]));
  assert.match(streakVerdict(fourteen, today, true, "2026-11-06").detail, /^14 consecutive day\(s\) with no FAIL \(since 2026-11-07\)/);
  assert.equal(streakVerdict(null, today, true, null).state, "warn", "run history unreadable");
  for (const r of [streakVerdict(green, today, false, null), streakVerdict(green, today, true, null)]) assert.equal(r.state, "ok", "the streak row itself never fails (a FAIL row already says why)");
});

t("dispatch token (DISPATCH_EXPIRES) is information only, like the publishing token", () => {
  assert.equal(dispatchVerdict(undefined, 0), null);
  assert.equal(dispatchVerdict("", 0), null);
  assert.equal(dispatchVerdict("2027-10-27", Date.UTC(2026, 9, 27) / 1000)!.state, "ok");
  assert.equal(dispatchVerdict("2026-11-06", Date.UTC(2026, 10, 1) / 1000)!.state, "warn");
  assert.equal(dispatchVerdict("2026-10-01", Date.UTC(2026, 10, 1) / 1000)!.state, "warn", "expired: still only a warning");
  assert.equal(dispatchVerdict("next year", 0)!.state, "warn");
  assert.equal(dispatchVerdict("2026-11-06", 0)!.check, "dispatch token");
});

t("health-verify: ok / failed / error from the verifier's exit and output; the newest published file and its extra file", () => {
  const { classify, newestFiles } = require("../src/health-verify");
  assert.equal(classify(0, "✅ epoch 1 verified: 1 leaves, root d277", false).status, "ok");
  const failed = classify(1, "loading\n❌ VERIFICATION FAILED\n - on-chain root differs\n", false);
  assert.deepEqual([failed.status, failed.detail], ["failed", "- on-chain root differs"]);
  assert.equal(classify(1, "Error: 503 Service Unavailable", false).status, "error", "an RPC outage is not a mismatch");
  assert.equal(classify(null, "", true).status, "error", "timeout");
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-hv-"));
  try {
    assert.deepEqual(newestFiles(dir), []);
    fs.writeFileSync(path.join(dir, "epoch-1.json"), JSON.stringify({ epoch: 1, dataHash: "h1", publish: { tx: "t1" } }));
    fs.writeFileSync(path.join(dir, "epoch-2.json"), JSON.stringify({ epoch: 2, dataHash: "h2", publish: { tx: "t2" } }));
    fs.writeFileSync(path.join(dir, "epoch-3.json"), JSON.stringify({ epoch: 3, dataHash: "h3" })); // built, never published
    fs.writeFileSync(path.join(dir, "extra-2.json"), JSON.stringify({ kind: "extra", epoch: 2, dataHash: "x2" }));
    assert.deepEqual(newestFiles(dir), [{ kind: "epoch", file: "epoch-2.json", epoch: 2, dataHash: "h2" }, { kind: "extra", file: "extra-2.json", epoch: 2, dataHash: "x2" }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`health rules: ${n} tests passed`);
