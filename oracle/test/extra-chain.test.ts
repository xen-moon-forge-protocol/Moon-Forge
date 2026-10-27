/**
 * Extra-pot chain plumbing and the v3 keeper-tip mirror (r3 A2), no network:
 *   - the keeper-tip rule of the upgraded program for v3 files (0.2 XNT, never when the oracle submits) and the live
 *     rule for v2 files (0.02 XNT), in keeperTipDue, claimPlanV3 and plannedOutflow;
 *   - the A10.11 per-asset reader (coreOwnershipOfV3, assetStateAtV3): the owner AT the snapshot slot, from the account
 *     when nothing changed after it, else from the asset's own history; every gap throws;
 *   - the ExtraEpochPublished reader (account + event, weeks), the chain's first extra epoch, X at init_extra, X of
 *     every extra file (extraOpenV3);
 *   - the run's pot detection (extraPotRunV3: replaces EXTRA_POT_LIVE / EXTRA_FIRST_EPOCH), the per-epoch liveness, the
 *     publish-extra order and the A10.11 durability gate (index wiring).
 *   npm test
 */
import assert from "assert";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { KEEPER_TIP, KEEPER_TIP_MIN_CLAIM, KEEPER_TIP_MIN_CLAIM_LIVE, keeperTipDue, plannedOutflow, VEST_MIN_ENT } from "../src/rewards";
import { claimPlanV3, durableExtraErrorV3, extraInitV3, extraOpenV3, potLiveForV3, publishExtraRefusalsV3 } from "../src/flow-v3";
import { dataHashExtra } from "../src/extra";
import { extraPotRunV3 } from "../src/sources-v3";
import { MPL_CORE, PDA } from "../src/x1";
import {
  artifactSnapshotV3, AssetHistoryRpcV3, assetStateAtV3, CORE_IX, coreOwnershipOfV3, extraFirstEpochOnChainV3, extraPublishedFromLogsV3, initExtraXV3, PDA_V3, programV3,
  readExtraPublishedV3, TxIxV3, V3_IDL,
} from "../src/x1-v3";

let passed = 0;
let failed = 0;
const queue: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => queue.push([name, fn]);

const XNT = 1_000_000_000n;
const key = (i: number) => new PublicKey(Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? i & 255 : j === 1 ? (i >> 8) & 255 : j === 31 ? 5 : 0))).toBase58();
const sigOf = (i: number) => bs58.encode(Uint8Array.from({ length: 64 }, (_, j) => (j === 0 ? i & 255 : j === 1 ? (i >> 8) & 255 : j === 63 ? 4 : 0)));

// ── 1. the keeper-tip mirror ─────────────────────────────────────────────────────────────────────
test("tip mirror: v3 files pay a tip from 0.2 XNT and never to the oracle; v2 files keep the live 0.02 XNT rule", () => {
  assert.deepStrictEqual([KEEPER_TIP, KEEPER_TIP_MIN_CLAIM, KEEPER_TIP_MIN_CLAIM_LIVE, VEST_MIN_ENT], [2_000_000n, 200_000_000n, 20_000_000n, 20_000_000n]);
  const [pl, or, k] = [key(1), key(2), key(3)];
  const v3 = (payer: string | null, claim: bigint, oracle: string | null = or) => keeperTipDue({ version: 3, payer, player: pl, oracle, claim });
  const v2 = (payer: string | null, claim: bigint) => keeperTipDue({ version: 2, payer, player: pl, oracle: or, claim });
  assert.deepStrictEqual([v3(k, KEEPER_TIP_MIN_CLAIM), v3(k, KEEPER_TIP_MIN_CLAIM - 1n), v3(null, KEEPER_TIP_MIN_CLAIM), v3(or, 10n * XNT), v3(pl, 10n * XNT)], [true, false, true, false, false]);
  assert.strictEqual(v3(k, KEEPER_TIP_MIN_CLAIM, null), true, "a third party with the oracle unknown");
  assert.deepStrictEqual([v2(k, KEEPER_TIP_MIN_CLAIM_LIVE), v2(k, KEEPER_TIP_MIN_CLAIM_LIVE - 1n), v2(or, KEEPER_TIP_MIN_CLAIM_LIVE), v2(pl, XNT)], [true, false, true, false], "the live binary tips the oracle too");
});

test("tip mirror: claimPlanV3 and plannedOutflow count a tip only where the program pays one", () => {
  // budget = totalScore (the plan): each claim is its score in lamports
  const scores = [300_000_000n, 200_000_000n, 100_000_000n, 30_000_000n, 10_000_000n];
  const leaves = scores.map((s, i) => ({ player: key(10 + i), tier: 0, score: s.toString() }));
  const total = scores.reduce((a, b) => a + b, 0n).toString();
  const f = { leaves, totalScore: total } as never;
  const n = (p: { tipped: unknown[]; dust: unknown[] }) => [p.tipped.length, p.dust.length];
  assert.deepStrictEqual(n(claimPlanV3(f)), [2, 3], "v3 by default: 0.3 and 0.2 XNT tipped, below 0.2 dust");
  assert.deepStrictEqual(n(claimPlanV3(f, { payer: key(2), oracle: key(2) })), [0, 5], "the oracle submitting: no tip at all");
  assert.deepStrictEqual(n(claimPlanV3(f, { payer: key(3), oracle: key(2) })), [2, 3]);
  assert.deepStrictEqual(n(claimPlanV3({ ...(f as object), version: 2 } as never)), [4, 1], "a v2 file: the live 0.02 XNT rule");
  const sum = scores.reduce((a, b) => a + b, 0n);
  assert.strictEqual(plannedOutflow(scores, sum), sum + 2n * KEEPER_TIP, "the engine reserves one tip per claim of at least 0.2 XNT");
});

// ── 2. the A10.11 per-asset reader ───────────────────────────────────────────────────────────────
const CORE = MPL_CORE.toBase58();
const A = key(100);
const coll = PDA.collection().toBase58();
const ix = (kind: number, accounts: string[], program = CORE): TxIxV3 => ({ program, accounts, data: Buffer.from([kind, 0, 0]) });
const create = (owner: string | null, payer = key(201)) => ix(CORE_IX.CREATE_V1, [A, coll, key(200), payer, owner ?? CORE]);
const transfer = (to: string) => ix(CORE_IX.TRANSFER_V1, [A, coll, key(201), key(202), to]);
const burn = () => ix(CORE_IX.BURN_V1, [A, coll, key(201)]);

test("A10.11: coreOwnershipOfV3 reads create / transfer / burn of the asset, the last one wins", () => {
  const [X, Y] = [key(150), key(151)];
  assert.deepStrictEqual(coreOwnershipOfV3([create(X)], A), { kind: "create", owner: X });
  assert.deepStrictEqual(coreOwnershipOfV3([create(null, Y)], A), { kind: "create", owner: Y }, "no owner: the payer owns it");
  assert.deepStrictEqual(coreOwnershipOfV3([{ ...create(X), data: Buffer.from([CORE_IX.CREATE_V2]) }], A), { kind: "create", owner: X });
  assert.deepStrictEqual(coreOwnershipOfV3([create(X), transfer(Y)], A), { kind: "transfer", owner: Y });
  assert.deepStrictEqual(coreOwnershipOfV3([transfer(Y), burn()], A), { kind: "burn", owner: null });
  assert.strictEqual(coreOwnershipOfV3([ix(5, [A, coll])], A), null, "a plugin change keeps the owner");
  assert.strictEqual(coreOwnershipOfV3([transfer(Y)], key(101)), null, "another asset");
  assert.strictEqual(coreOwnershipOfV3([{ ...transfer(Y), program: key(9) }], A), null, "another program");
  assert.throws(() => coreOwnershipOfV3([create(null, CORE)], A), /no owner and no payer/);
  assert.throws(() => coreOwnershipOfV3([ix(CORE_IX.TRANSFER_V1, [A, coll, key(1), key(2), CORE])], A), /no new owner/);
});

const S = 1_000;
const coreInfo = (owner: string) => {
  const d = Buffer.alloc(66);
  d[0] = 1;
  new PublicKey(owner).toBuffer().copy(d, 1);
  d[33] = 2;
  PDA.collection().toBuffer().copy(d, 34);
  return { owner: MPL_CORE, data: d };
};
const rpcOf = (sigs: { signature: string; slot: number; err?: unknown }[], txs: Record<string, TxIxV3[] | null>): AssetHistoryRpcV3 => ({
  assets: async () => ({ slot: S, infos: [] }),
  signatures: async (_a, before) => (before === undefined ? sigs.map((s) => ({ err: null, ...s })) : []),
  instructions: async (s) => (s in txs ? txs[s] : null),
});
const at = (rpc: AssetHistoryRpcV3, current: { owner: PublicKey; data: Buffer } | null, slot = S + 50) => assetStateAtV3(rpc, new PublicKey(A), S, { slot, info: current });

test("A10.11: assetStateAtV3 gives the owner AT the slot, deterministic, and fails closed", async () => {
  const [X, Y, Z] = [key(150), key(151), key(152)];
  const [c1, p2, t2, t3, b3] = [sigOf(1), sigOf(2), sigOf(3), sigOf(4), sigOf(5)];
  assert.deepStrictEqual(await at(rpcOf([{ signature: c1, slot: 900 }], {}), coreInfo(X)), { live: true, owner: X, signature: c1, via: "current" }, "nothing after S: the account read is the state at S");
  assert.deepStrictEqual(await at(rpcOf([{ signature: t2, slot: 1_100 }, { signature: c1, slot: 900 }], { [c1]: [create(X)] }), coreInfo(Y)), { live: true, owner: X, signature: c1, via: "history" }, "transferred after S: recorded as it was at S");
  assert.deepStrictEqual(await at(rpcOf([{ signature: b3, slot: 1_200 }, { signature: t3, slot: 950 }, { signature: c1, slot: 900 }], { [t3]: [transfer(Z)], [c1]: [create(X)] }), null), { live: true, owner: Z, signature: t3, via: "history" }, "recycled after S: still live at S");
  assert.deepStrictEqual(await at(rpcOf([{ signature: c1, slot: 1_100 }], { [c1]: [create(X)] }), coreInfo(X)), { live: false, owner: null, signature: null, via: "history" }, "forged after S: not in S");
  assert.deepStrictEqual(await at(rpcOf([{ signature: b3, slot: 990 }, { signature: c1, slot: 900 }], {}), null), { live: false, owner: null, signature: b3, via: "current" }, "burned at or before S");
  assert.deepStrictEqual(await at(rpcOf([{ signature: t2, slot: 1_100, err: { InstructionError: [0, "x"] } }, { signature: c1, slot: 900 }], {}), coreInfo(X)), { live: true, owner: X, signature: c1, via: "current" }, "a failed transaction changes nothing");
  assert.deepStrictEqual(await at(rpcOf([{ signature: t2, slot: 1_100 }, { signature: p2, slot: 950 }, { signature: c1, slot: 900 }], { [p2]: [ix(5, [A, coll])], [c1]: [create(X)] }), coreInfo(Y)), { live: true, owner: X, signature: p2, via: "history" }, "a plugin change at S keeps the owner; its signature is the asset's last at S");
  await assert.rejects(at(rpcOf([], {}), coreInfo(X)), /lagging signature index/);
  await assert.rejects(at(rpcOf([{ signature: t2, slot: 1_100 }, { signature: c1, slot: 900 }], { [c1]: null }), coreInfo(Y)), /cannot be read/);
  assert.deepStrictEqual(await at(rpcOf([{ signature: t2, slot: 1_100 }, { signature: p2, slot: 950 }], { [p2]: [ix(5, [A, coll])] }), coreInfo(Y)), { live: false, owner: null, signature: p2, via: "history" }, "a whole history without a create: not live at S");
});

test("A10.11 / X-015: the snapshot is read per asset from two RPCs; a forge or recycle between the reads is decided by history; any disagreement refuses", async () => {
  const S2 = 5_000;
  const T = 1_792_000_000;
  const [X, Y] = [key(160), key(161)];
  const [a1, a2, a3] = [key(171), key(172), key(173)];
  const recData = (asset: string, forgedAt: number) => program.coder.accounts.encode("artifactRecord", {
    asset: new PublicKey(asset), tier: 0, serial: 1, backing: new anchor.BN(5_000_000_000), origin: 0, forgedAt: new anchor.BN(forgedAt), lastChipWeek: new anchor.BN(0), bump: 255,
  });
  const listConn = async (assets: [string, number][], slot: number) => {
    const datas = await Promise.all(assets.map(([a, at]) => recData(a, at)));
    return {
      getProgramAccounts: async () => ({ context: { slot }, value: datas.map((data) => ({ pubkey: PublicKey.unique(), account: { data, owner: program.programId, lamports: 1, executable: false } })) }),
      getBlockTime: async (sl: number) => T + sl,
    };
  };
  type Hist = { info: { owner: PublicKey; data: Buffer } | null; sigs: { signature: string; slot: number; err?: unknown }[]; txs: Record<string, TxIxV3[]> };
  const rpcFrom = (h: Record<string, Hist>, slot: number): AssetHistoryRpcV3 => ({
    assets: async (keys) => ({ slot, infos: keys.map((k) => h[k.toBase58()]?.info ?? null) }),
    signatures: async (a, before) => (before === undefined ? (h[a.toBase58()]?.sigs ?? []).map((x) => ({ err: null, ...x })) : []),
    instructions: async (sg) => {
      for (const v of Object.values(h)) if (sg in v.txs) return v.txs[sg];
      return null;
    },
  });
  const createOf = (asset: string, owner: string): TxIxV3 => ({ program: CORE, accounts: [asset, coll, key(200), key(201), owner], data: Buffer.from([CORE_IX.CREATE_V1]) });
  const hist = (): Record<string, Hist> => ({
    [a1]: { info: coreInfo(X), sigs: [{ signature: sigOf(11), slot: 4_000 }], txs: {} },
    // recycled after S: burned at S + 5, so the account is gone now; at S it was X's
    [a2]: { info: null, sigs: [{ signature: sigOf(22), slot: S2 + 5 }, { signature: sigOf(21), slot: 4_100 }], txs: { [sigOf(21)]: [createOf(a2, X)] } },
    // forged after S (at S + 7): listed by the second RPC only, not in S
    [a3]: { info: coreInfo(Y), sigs: [{ signature: sigOf(31), slot: S2 + 7 }], txs: { [sigOf(31)]: [createOf(a3, Y)] } },
  });
  const first = await listConn([[a1, T + 4_000], [a2, T + 4_100]], S2);
  const second = await listConn([[a1, T + 4_000], [a3, T + S2 + 7]], S2 + 10);
  const snap = await artifactSnapshotV3(first as never, program, "", { first: rpcFrom(hist(), S2 + 1), second: rpcFrom(hist(), S2 + 10), secondConnection: second as never });
  assert.deepStrictEqual([snap.slot, snap.blockTime, snap.records.map((r) => [r.asset, r.owner, r.forgedAt])], [S2, T + S2, [[a1, X, T + 4_000], [a2, X, T + 4_100]].sort((p, q) => (p[0] < q[0] ? -1 : 1))]);
  // the second RPC sees another owner for a1 at S: refused
  const h2 = hist();
  h2[a1] = { ...h2[a1], info: coreInfo(Y) };
  await assert.rejects(artifactSnapshotV3(first as never, program, "", { first: rpcFrom(hist(), S2 + 1), second: rpcFrom(h2, S2 + 10), secondConnection: second as never }), /two X1 RPCs disagree on asset/);
  // the second RPC holds another forged_at for a1: refused
  const secondBad = await listConn([[a1, T + 4_001], [a3, T + S2 + 7]], S2 + 10);
  await assert.rejects(artifactSnapshotV3(first as never, program, "", { first: rpcFrom(hist(), S2 + 1), second: rpcFrom(hist(), S2 + 10), secondConnection: secondBad as never }), /disagree on the ArtifactRecord/);
  // the second RPC answering before S: refused
  const early = await listConn([[a1, T + 4_000]], S2 - 1);
  await assert.rejects(artifactSnapshotV3(first as never, program, "", { first: rpcFrom(hist(), S2 + 1), second: rpcFrom(hist(), S2 + 10), secondConnection: early as never }), /before the snapshot slot/);
  // an asset live at S (its history) that the first list omits: refused
  const thin = await listConn([[a1, T + 4_000]], S2);
  const h3 = hist();
  h3[a2] = { info: coreInfo(X), sigs: [{ signature: sigOf(21), slot: 4_100 }], txs: {} };
  const second3 = await listConn([[a1, T + 4_000], [a2, T + 4_100]], S2 + 10);
  await assert.rejects(artifactSnapshotV3(thin as never, program, "", { first: rpcFrom(h3, S2 + 1), second: rpcFrom(h3, S2 + 10), secondConnection: second3 as never }), /omits it/);
});

// ── 3. the extra pot on chain: published epochs, first epoch, X ───────────────────────────────────
const program = programV3(new anchor.AnchorProvider({} as never, new anchor.Wallet(Keypair.generate()), {}));
const coder = new anchor.BorshCoder(V3_IDL);
const evDisc = Buffer.from((V3_IDL.events ?? []).find((e) => e.name === "ExtraEpochPublished")!.discriminator);
const evLogs = (o: { epoch: number; total: bigint; before: bigint; leaves?: number; weeks?: number; root?: string; dataHash?: string }) => {
  const data = coder.types.encode("ExtraEpochPublished", {
    epoch: new anchor.BN(o.epoch), root: Array.from(Buffer.from(o.root ?? "ab".repeat(32), "hex")), data_hash: Array.from(Buffer.from(o.dataHash ?? "cd".repeat(32), "hex")),
    total: new anchor.BN(o.total.toString()), leaves: o.leaves ?? 2, free_before: new anchor.BN(o.before.toString()), free_after: new anchor.BN((o.before - o.total).toString()), weeks: o.weeks ?? 1,
  });
  const id = program.programId.toBase58();
  return [`Program ${id} invoke [1]`, `Program data: ${Buffer.concat([evDisc, data]).toString("base64")}`, `Program ${id} success`];
};

/** the logs of a plain lamport transfer to the PDA (the System program only) */
const SYSTEM_TRANSFER_LOGS = ["Program 11111111111111111111111111111111 invoke [1]", "Program 11111111111111111111111111111111 success"];

test("ExtraEpochPublished: the event is decoded with its weeks", () => {
  assert.deepStrictEqual(extraPublishedFromLogsV3(program, evLogs({ epoch: 7, total: 5n * XNT, before: 100n * XNT, weeks: 2 })), {
    epoch: 7, root: "ab".repeat(32), dataHash: "cd".repeat(32), total: (5n * XNT).toString(), leaves: 2, freeBefore: (100n * XNT).toString(), freeAfter: (95n * XNT).toString(), weeks: 2,
  });
  assert.strictEqual(extraPublishedFromLogsV3(program, SYSTEM_TRANSFER_LOGS), null, "a lamport transfer carries no event");
});

/** a read-only fake X1 for readExtraPublishedV3: the ExtraEpoch account (or none) and the PDA's transactions */
async function fakeX1(o: { account?: Record<string, unknown> | null; txs?: { signature: string; logs: string[] | null; err?: unknown }[] }) {
  const acc = o.account ? await program.coder.accounts.encode("extraEpoch", {
    id: new anchor.BN(7), root: Array(32).fill(0xab), dataHash: Array(32).fill(0xcd), budget: new anchor.BN((5n * XNT).toString()), claimed: new anchor.BN(0), leaves: 2,
    publishedAt: new anchor.BN(1_800_000_000), freeBefore: new anchor.BN((100n * XNT).toString()), closed: false, bump: 255, rentPayer: new PublicKey(key(3)), bitmap: Array(125).fill(0), ...o.account,
  }) : null;
  const info = acc ? { data: acc, owner: program.programId, lamports: 1, executable: false } : null;
  const txs = o.txs ?? [];
  const connection = {
    getAccountInfo: async () => info,
    getAccountInfoAndContext: async () => ({ context: { slot: 5 }, value: info }),
    getSignaturesForAddress: async (_a: PublicKey, cfg: { before?: string }) => (cfg?.before ? [] : [...txs].reverse().map((t, i) => ({ signature: t.signature, slot: 100 + txs.length - i, err: t.err ?? null }))),
    getTransaction: async (s: string) => {
      const t = txs.find((x) => x.signature === s)!;
      return { slot: 100 + txs.indexOf(t) + 1, meta: { err: null, logMessages: t.logs ?? [] } };
    },
  };
  const p = programV3(new anchor.AnchorProvider(connection as never, new anchor.Wallet(Keypair.generate()), {}));
  return { connection: connection as never, p };
}

test("ExtraEpochPublished reader: account and event agree, or the read throws; never a guess", async () => {
  const none = await fakeX1({});
  assert.strictEqual(await readExtraPublishedV3(none.connection, none.p, 7), null, "never published");
  const pub = sigOf(70);
  const ok = await fakeX1({ account: {}, txs: [{ signature: sigOf(69), logs: SYSTEM_TRANSFER_LOGS }, { signature: pub, logs: evLogs({ epoch: 7, total: 5n * XNT, before: 100n * XNT, weeks: 3 }) }] });
  const r = await readExtraPublishedV3(ok.connection, ok.p, 7);
  assert.deepStrictEqual([r!.freeAfter, r!.weeks, r!.tx, r!.publishedAt, r!.closed], [(95n * XNT).toString(), 3, pub, 1_800_000_000, false], "the event is found past a transfer to the PDA");
  const bad = await fakeX1({ account: {}, txs: [{ signature: pub, logs: evLogs({ epoch: 7, total: 4n * XNT, before: 100n * XNT }) }] });
  await assert.rejects(readExtraPublishedV3(bad.connection, bad.p, 7), /differs from the account/);
  const closed = await fakeX1({ txs: [{ signature: pub, logs: evLogs({ epoch: 7, total: 5n * XNT, before: 100n * XNT, weeks: 2 }) }] });
  const c = await readExtraPublishedV3(closed.connection, closed.p, 7);
  assert.deepStrictEqual([c!.freeAfter, c!.weeks, c!.publishedAt, c!.closed], [(95n * XNT).toString(), 2, null, null], "a closed epoch is read from its event");
  const blind = await fakeX1({ txs: [{ signature: pub, logs: SYSTEM_TRANSFER_LOGS }] });
  await assert.rejects(readExtraPublishedV3(blind.connection, blind.p, 7), /unknown, never assumed unpublished/);
  const wrongId = await fakeX1({ account: { id: new anchor.BN(8) } });
  await assert.rejects(readExtraPublishedV3(wrongId.connection, wrongId.p, 7), /holds id 8/);
});

test("the chain's first extra epoch is derived, never pinned by hand", async () => {
  const pub = (set: number[]) => async (e: number) => (set.includes(e) ? {} : null);
  assert.strictEqual(await extraFirstEpochOnChainV3({ lastEpoch: 0n }, pub([])), 1);
  assert.strictEqual(await extraFirstEpochOnChainV3({ lastEpoch: 5n }, pub([])), 6, "init_extra after base epoch 5: the first extra epoch is 6");
  assert.strictEqual(await extraFirstEpochOnChainV3({ lastEpoch: 5n }, pub([3, 4, 5])), 3, "walked back");
  assert.strictEqual(await extraFirstEpochOnChainV3({ lastEpoch: 5n }, pub([3, 4, 5]), 3), 3, "the history's own claim, confirmed");
  await assert.rejects(extraFirstEpochOnChainV3({ lastEpoch: 5n }, pub([3, 4, 5]), 4), /starts earlier/);
  await assert.rejects(extraFirstEpochOnChainV3({ lastEpoch: 5n }, pub([4, 5]), 3), /never published/);
  await assert.rejects(extraFirstEpochOnChainV3({ lastEpoch: 5n }, pub([5]), 6), /outside/);
  await assert.rejects(extraFirstEpochOnChainV3({ lastEpoch: 5n }, pub([1, 2, 3, 4, 5]), null, 2), /more than 2/);
});

test("X of the first extra epoch is read from init_extra (0, checked), and every later X from the previous publication", async () => {
  const state = (lastEpoch: bigint, freeAfter: bigint) => ({ live: true, verdict: "upgraded" as const, state: { lastEpoch, lastPublishTs: 0n, accounted: 0n, reserved: 0n, liveForgedBacking: 0n, outSincePublish: 0n, freeAfter } });
  assert.throws(() => initExtraXV3({ live: false, verdict: "legacy", state: null }, 6), /not live/);
  assert.strictEqual(initExtraXV3(state(5n, 0n), 6), "0");
  assert.throws(() => initExtraXV3(state(5n, 7n), 6), /refusing to guess X/);
  assert.strictEqual(initExtraXV3(state(9n, 3n * XNT), 6), "0", "after publications the first epoch's X is still init_extra's 0");
  const prev = { epoch: 6 } as never;
  const src = (v: { freeAfter: string } | null) => ({ publishedExtra: async () => (v ? { dataHash: "x", ...v } : null) });
  assert.strictEqual(await extraOpenV3(7, prev, { live: false, firstX: null }, src(null)), "0", "pot not live: a heartbeat");
  assert.strictEqual(await extraOpenV3(7, prev, { live: true, firstX: null }, src({ freeAfter: "123" })), "123");
  await assert.rejects(extraOpenV3(7, prev, { live: true, firstX: null }, src(null)), /could not be read/);
  await assert.rejects(extraOpenV3(7, prev, { live: true, firstX: null }, src({ freeAfter: "12a" })), /not an amount/);
  await assert.rejects(extraOpenV3(6, null, { live: true, firstX: null }, src(null)), /not read/);
  assert.strictEqual(await extraOpenV3(6, null, { live: true, firstX: "0" }, src(null)), "0");
  void PDA_V3;
});

// ── 4. the run's wiring: detection, publish order, durability ─────────────────────────────────────
const MARK = { ts: 1_790_000_000, tx: sigOf(900) };
const potState = (lastEpoch: bigint, freeAfter = 0n) => ({ lastEpoch, lastPublishTs: 0n, accounted: 0n, reserved: 0n, liveForgedBacking: 0n, outSincePublish: 0n, freeAfter });

test("detection: before the upgrade nothing is read; on the upgraded binary the first epoch, X and the mark come from the chain", async () => {
  let reads = 0;
  const legacy = await extraPotRunV3({ pot: async () => ({ live: false, verdict: "legacy", state: null }), published: async () => { reads++; return null; }, init: async () => { reads++; return MARK; } });
  assert.deepStrictEqual([legacy, reads], [{ live: false, liveFrom: null, firstX: null, init: null }, 0], "legacy: exactly as before");
  const live = await extraPotRunV3({ pot: async () => ({ live: true, verdict: "upgraded", state: potState(5n) }), published: async () => null, init: async () => MARK });
  assert.deepStrictEqual(live, { live: true, liveFrom: 6, firstX: "0", init: MARK });
  const later = await extraPotRunV3({ pot: async () => ({ live: true, verdict: "upgraded", state: potState(8n, 3n * XNT) }), published: async (e) => (e >= 6 ? {} : null), init: async () => MARK });
  assert.deepStrictEqual([later.liveFrom, later.firstX], [6, "0"], "after publications the first epoch is still found");
  await assert.rejects(extraPotRunV3({ pot: async () => { throw new Error("the extra pot cannot be detected (unknown)"); }, published: async () => null, init: async () => MARK }), /unknown/);
  await assert.rejects(extraPotRunV3({ pot: async () => ({ live: true, verdict: "upgraded", state: potState(5n) }), published: async () => null, init: async () => null }), /init_extra transaction was not found/);
  await assert.rejects(extraPotRunV3({ pot: async () => ({ live: true, verdict: "upgraded", state: potState(5n, 7n) }), published: async () => null, init: async () => MARK }), /refusing to guess X/);
});

test("per-epoch liveness: an extra epoch before the chain's first one stays a heartbeat; the first one takes X and the mark from the chain", async () => {
  const pot = { live: true, liveFrom: 6 };
  assert.deepStrictEqual([potLiveForV3(5, pot), potLiveForV3(6, pot), potLiveForV3(9, pot), potLiveForV3(9, { live: false, liveFrom: 6 }), potLiveForV3(9, { live: true })], [false, true, true, false, true]);
  const prev5 = { epoch: 5, pool: { init: null } } as never;
  const prev6 = { epoch: 6, pool: { init: MARK } } as never;
  const src = (v: { freeAfter: string } | null) => ({ publishedExtra: async () => (v ? { dataHash: "x", ...v } : null) });
  assert.strictEqual(await extraOpenV3(5, { epoch: 4 } as never, { ...pot, firstX: "0" }, src(null)), "0", "before the pot: X 0, nothing read");
  assert.strictEqual(await extraOpenV3(6, prev5, { ...pot, firstX: "0" }, src(null)), "0", "the first live epoch: X at init_extra, though extra-5.json exists (never published)");
  assert.strictEqual(await extraOpenV3(7, prev6, { ...pot, firstX: "0" }, src({ freeAfter: "44" })), "44");
  assert.strictEqual(extraInitV3(5, null, { ...pot, init: MARK }), null);
  assert.deepStrictEqual(extraInitV3(6, prev5, { ...pot, init: MARK }), MARK, "a pre-pot file without the mark lets the first mark in");
  assert.deepStrictEqual(extraInitV3(7, prev6, { ...pot }), MARK);
});

test("publish order: publish-extra refuses a file the chain would not take, or one built on another X or mark", () => {
  const f = (o: { epoch: number; open?: string; init?: typeof MARK | null }) => ({ epoch: o.epoch, pool: { open: o.open ?? "0", lamports: o.open ?? "0", slot: 1, init: o.init === undefined ? MARK : o.init } }) as never;
  const pot = { live: true, liveFrom: 6, firstX: "0", init: MARK };
  assert.deepStrictEqual(publishExtraRefusalsV3(f({ epoch: 6 }), pot, null), []);
  assert.deepStrictEqual(publishExtraRefusalsV3(f({ epoch: 7, open: "44" }), pot, { freeAfter: "44" }), []);
  assert.match(publishExtraRefusalsV3(f({ epoch: 7, open: "44" }), pot, null)[0], /published in order/);
  assert.match(publishExtraRefusalsV3(f({ epoch: 7, open: "45" }), pot, { freeAfter: "44" })[0], /free_after 44/);
  assert.match(publishExtraRefusalsV3(f({ epoch: 6, open: "1" }), pot, null)[0], /X at init_extra/);
  assert.match(publishExtraRefusalsV3(f({ epoch: 5 }), pot, null)[0], /before the chain's first extra epoch/);
  assert.match(publishExtraRefusalsV3(f({ epoch: 6, init: null }), pot, null)[0], /OD-9/);
  assert.match(publishExtraRefusalsV3(f({ epoch: 6, init: { ts: MARK.ts, tx: sigOf(901) } }), pot, null)[0], /OD-9/);
  assert.match(publishExtraRefusalsV3(f({ epoch: 6 }), { live: false, liveFrom: null, firstX: null, init: null }, null)[0], /not live/);
});

test("durability (A10.11): the exact file must be in the pushed history before publish_extra_epoch", () => {
  const body = { kind: "extra", version: 1, epoch: 6, totals: { budget: "0" } } as Record<string, unknown>;
  const local = { ...body, dataHash: dataHashExtra(body as never) } as never as { epoch: number; dataHash: string };
  const ref = "origin/main";
  assert.strictEqual(durableExtraErrorV3(local as never, JSON.stringify(local, null, 2), ref), null);
  assert.match(durableExtraErrorV3(local as never, null, ref)!, /not in origin\/main: commit and push it first/);
  assert.match(durableExtraErrorV3(local as never, "{", ref)!, /not JSON/);
  assert.match(durableExtraErrorV3(local as never, JSON.stringify({ ...local, dataHash: "ff".repeat(32) }), ref)!, /push the file being published/);
  assert.match(durableExtraErrorV3(local as never, JSON.stringify({ ...local, epoch: 99 }), ref)!, /does not match its own data hash/, "same claimed hash, other content");
});

(async () => {
  for (const [name, fn] of queue) {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      console.error(`FAIL ${name}\n  ${(e as Error).stack ?? String(e)}`);
    }
  }
  console.log(`extra chain tests: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
