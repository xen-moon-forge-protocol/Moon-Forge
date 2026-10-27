/**
 * Golden vectors of the v3 rules block (round 4, 2026-10-25): D-12 backlog ranking, D-14 keccak tie-break, D-18 operator
 * wallets with a PROOF_BURN_RULE (c) dated exception, X-010 portal counters and T1-34 totalSupply. Each world is a chain
 * of epoch inputs; every file is built by the real computeEpochV3 and recorded whole, so the oracle, the site
 * (frontend/src/lib/quote.ts) and the kit (agents/kit/quote-v3.mjs) can assert the same numbers.
 *   npx ts-node test/fixtures/make-rules-vectors.ts      (rewrites test/fixtures/rules-v3-vectors.json)
 * test/rules-v3.test.ts rebuilds every file from the recorded inputs and requires byte equality.
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { AnyEpochFile, buildEpochFileV3, BurnInputV3, DEFAULT_RULES_V3, EpochFileV3, EpochInputsV3, RulesBlockV3, XdexReadingV3 } from "../../src/rewards";

const PROGRAM = "57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9";
const XNT = 1_000_000_000n;
const XEN = 10n ** 18n;
const DAY = 86_400;
const HOUR = 3_600;
const WEEK = 7 * DAY;
const T0 = 1_795_478_400; // 2026-11-24 00:00 UTC (a fixed test origin, no live meaning)
/** XEN at $0.000001 and XNT at $1: a burn of N whole XEN is worth N µUSD */
const P6 = 10n ** 12n;
const X1 = 10n ** 18n;
const BIG_L = 10n ** 30n;

export const wallet = (tag: number) => {
  const b = new Uint8Array(32);
  b[0] = 0x5e;
  b[1] = tag;
  b[31] = 1;
  return new PublicKey(b).toBase58();
};
const blockAt = (ts: number) => ts - T0 + 10_000;
const iso = (ts: number) => new Date(ts * 1000).toISOString();

let seq = 0;
/** each chain's portal numbers its missions 1, 2, … in the order they are made (the worlds below make them in time order) */
const missions = new Map<number, number>();
function burn(chainId: number, x1: string, ts: number, xen: bigint, tier = 0): BurnInputV3 {
  seq++;
  const missionId = (missions.get(chainId) ?? 0) + 1;
  missions.set(chainId, missionId);
  return {
    chainId, txHash: "0x" + createHash("sha256").update(`rules-v3-vector:${seq}`).digest("hex"), logIndex: seq % 7, blockNumber: blockAt(ts),
    missionId: String(missionId), pilot: "0x" + "ab".repeat(20), amountWei: (xen * XEN).toString(), tier, x1, timestamp: ts,
    medianE18: P6.toString(), lastCloseE18: P6.toString(), priceSource: "candles", xntMedianE18: X1.toString(), xntLastCloseE18: X1.toString(), xntSource: "candles",
  };
}

interface ChainSpec {
  chainId: number;
  burns: BurnInputV3[];
  missionsAt?: string | null;
  burnedAt?: string | null;
  totalSupply?: string | null;
  totalSupplyError?: string;
  /** D-13: GeckoTerminal's reading (default BIG_L), the on-chain one, the hourly samples, the price pool's creation */
  L?: bigint;
  onChain?: bigint | null;
  samples?: { hour: number; micro: string }[];
  poolCreatedAt?: number | null;
  /** D-21: valued as orphaned (no market: its burns at the orphan price) */
  orphan?: true;
}

function inputs(o: {
  epoch: number; endTs: number; startTs: number; F: bigint; open: bigint | null; chains: ChainSpec[]; prev: AnyEpochFile | null; rules?: RulesBlockV3;
  /** D-22 (a): the XDEX reading of the build; D-22 (c): the two XNT build prices (default $1 each) */
  xdex?: XdexReadingV3 | null; twap?: bigint; api?: bigint; xntCandle?: bigint;
  /** D-21: the chains skipped this epoch for lack of an eligible market */
  noMarket?: number[];
  /** D-22 (b): the candidate XNT pools' TVL at the build */
  xntPools?: { pool: string; tvlMicro: string }[];
}): EpochInputsV3 {
  return {
    programId: PROGRAM, epoch: o.epoch, createdAt: iso(o.endTs), window: { startTs: o.startTs, endTs: o.endTs },
    chains: o.chains.map((c) => {
      const from = o.prev?.chains.find((x) => x.chainId === c.chainId)?.toBlock ?? 0;
      return {
        chainId: c.chainId, name: `chain-${c.chainId}`, portal: "0xportal", fromBlockExclusive: from, toBlock: blockAt(o.endTs),
        market: c.orphan ? { spotE18: "0", refUsdE18: "0", priceSource: "orphan: no eligible market (D-21)", pools: [] } : { spotE18: P6.toString(), refUsdE18: P6.toString(), priceSource: "vector", pools: [] },
        liquidityNowMicro: c.orphan ? "0" : (c.L ?? BIG_L).toString(),
        ...(c.orphan ? { orphan: true as const } : {}),
        ...(c.onChain !== undefined ? { liquidityOnChainMicro: c.onChain === null ? null : c.onChain.toString() } : {}),
        ...(c.samples !== undefined ? { liquiditySamples: c.samples } : {}),
        ...(c.poolCreatedAt !== undefined ? { poolCreatedAt: c.poolCreatedAt } : {}),
        totalSupply: c.totalSupply === undefined ? "1000000000000000000000000000000" : c.totalSupply,
        ...(c.totalSupplyError !== undefined ? { totalSupplyError: c.totalSupplyError } : {}),
        ...(c.missionsAt !== undefined ? { missionsAt: c.missionsAt } : {}),
        ...(c.burnedAt !== undefined ? { burnedAt: c.burnedAt } : {}),
        burns: c.burns
          .filter((b) => b.blockNumber > from && b.blockNumber <= blockAt(o.endTs))
          .map((b) => (o.xntCandle === undefined ? b : { ...b, xntMedianE18: o.xntCandle.toString(), xntLastCloseE18: o.xntCandle.toString() }))
          .map((b) => (c.orphan ? { ...b, medianE18: "0", lastCloseE18: "0", priceSource: "orphan" } : b)),
      };
    }),
    snapshot: { slot: 9_000 + o.epoch, records: [] },
    freePool: { lamports: o.F.toString(), slot: 8_999 + o.epoch, open: o.open === null ? null : o.open.toString() },
    xnt: { twapE18: (o.twap ?? X1).toString(), apiE18: (o.api ?? X1).toString(), source: "vector" },
    switchRefs: null,
    ...(o.rules ? { rulesBlock: o.rules } : {}),
    ...(o.xdex !== undefined ? { xdex: o.xdex } : {}),
    ...(o.noMarket ? { noMarket: o.noMarket } : {}),
    ...(o.xntPools ? { xntPools: o.xntPools } : {}),
  };
}

/** D-13: hourly samples of `micro` for the hours [fromHour, toHour), with `patch` overriding single hours */
export function hourlySamples(fromHour: number, toHour: number, micro: bigint, patch: Record<number, bigint> = {}): { hour: number; micro: string }[] {
  const out: { hour: number; micro: string }[] = [];
  for (let h = fromHour; h < toHour; h++) out.push({ hour: h, micro: (patch[h] ?? micro).toString() });
  return out;
}

const counters = (burns: BurnInputV3[], prevAt = 0n, prevBurned = 0n) => ({
  missionsAt: (prevAt + BigInt(burns.length)).toString(),
  burnedAt: burns.reduce((s, b) => s + BigInt(b.amountWei), prevBurned).toString(),
});

export interface VectorWorld {
  name: string;
  about: string;
  epochs: { inputs: EpochInputsV3; file: EpochFileV3 }[];
}

function chainOf(name: string, about: string, steps: ((prev: EpochFileV3 | null) => EpochInputsV3)[]): VectorWorld {
  const epochs: VectorWorld["epochs"] = [];
  let prev: EpochFileV3 | null = null;
  for (const step of steps) {
    const inp = step(prev);
    const file = buildEpochFileV3(JSON.parse(JSON.stringify(inp)), prev);
    if (!file) throw new Error(`${name}: epoch ${inp.epoch} is empty`);
    epochs.push({ inputs: inp, file: JSON.parse(JSON.stringify(file)) });
    prev = epochs[epochs.length - 1].file;
  }
  return { name, about, epochs };
}

/** the window start of epoch n+1: 60 s after epoch n's snapshot (its on-chain published_at in these vectors) */
const nextStart = (f: EpochFileV3) => f.window.endTs + 60;
/** F_ref after a publication: the pool before less the budget (= totalScore here) */
const openAfter = (F: bigint, f: EpochFileV3) => F - BigInt(f.totalScore);

export function vectorWorlds(): VectorWorld[] {
  seq = 0;
  const W = [1, 2, 3, 4, 5, 6, 7, 8].map(wallet);
  const world = () => missions.clear();
  const worlds: VectorWorld[] = [];

  world();
  // D-14: five burns stamped the same second on four chains (two in one block of chain 10), a day-0 tranche (C/7 = 0.009
  // XNT) that serves the first one in full and the second in part: the order is the hash order, whatever the chain or block
  {
    const ts = T0 + 2 * HOUR;
    const bs = [burn(10, W[0], ts, 5_000n), burn(10, W[1], ts, 5_000n), burn(56, W[2], ts, 5_000n), burn(137, W[3], ts, 5_000n), burn(8453, W[4], ts, 5_000n, 1)];
    worlds.push(chainOf("d14-same-second", "D-14: same-second burns ordered by keccak256(txHash ‖ logIndex) (32-byte hash, 32-byte big-endian log index)", [
      () => inputs({ epoch: 1, endTs: T0 + WEEK, startTs: T0, F: 787_500_000n, open: null, prev: null, chains: [10, 56, 137, 8453].map((id) => ({ chainId: id, burns: bs.filter((b) => b.chainId === id), ...counters(bs.filter((b) => b.chainId === id)) })) }),
    ]));
  }

  world();
  // D-12: chain 56 is skipped in epoch 2 (its burn waits), read again in epoch 3: that burn is backlog (after every burn of
  // window 3 at the arrival, first in the leftover); window 3 (5.8 days, so its end day releases 6/7 of C at the arrival)
  // has a day-0 mission on chain 10 and a day-3 burn on chain 56; C = 0.175 XNT
  {
    const F = 600n * XNT;
    const F3 = 2_500_000_000n;
    const open3 = 2_187_500_000n;
    const e1 = [burn(10, W[0], T0 + DAY, 2_000n), burn(56, W[1], T0 + DAY + HOUR, 2_000n)];
    const late56 = burn(56, W[2], T0 + WEEK + 2 * DAY, 100_000n, 2);
    const e2 = [burn(10, W[3], T0 + WEEK + DAY, 3_000n)];
    const e3 = [burn(10, W[4], T0 + 2 * WEEK + HOUR, 20_000n, 1), burn(56, W[5], T0 + 2 * WEEK + 3 * DAY, 4_000n)];
    worlds.push(chainOf("d12-backlog", "D-12: a skipped chain's burn ranks after the window's burns at the arrival and first in the leftover (backlog: true, day = the window's end day)", [
      () => inputs({ epoch: 1, endTs: T0 + WEEK, startTs: T0, F, open: null, prev: null, chains: [{ chainId: 10, burns: e1.filter((b) => b.chainId === 10), ...counters(e1.filter((b) => b.chainId === 10)) }, { chainId: 56, burns: e1.filter((b) => b.chainId === 56), ...counters(e1.filter((b) => b.chainId === 56)) }] }),
      (p) => inputs({ epoch: 2, endTs: T0 + 2 * WEEK, startTs: nextStart(p!), F, open: openAfter(F, p!), prev: p, chains: [{ chainId: 10, burns: e2, missionsAt: "2", burnedAt: (BigInt(e1[0].amountWei) + BigInt(e2[0].amountWei)).toString() }] }),
      (p) => inputs({
        epoch: 3, endTs: nextStart(p!) + 501_120, startTs: nextStart(p!), F: F3, open: open3, prev: p,
        chains: [
          { chainId: 10, burns: [e3[0]], missionsAt: "3", burnedAt: (BigInt(e1[0].amountWei) + BigInt(e2[0].amountWei) + BigInt(e3[0].amountWei)).toString() },
          { chainId: 56, burns: [late56, e3[1]], missionsAt: "3", burnedAt: (BigInt(e1[1].amountWei) + BigInt(late56.amountWei) + BigInt(e3[1].amountWei)).toString() },
        ],
      }),
    ]));
  }

  world();
  // D-18 + PROOF_BURN_RULE (c): W[6] is an operator wallet (its day-0 burn claims after every other claim, top-ups
  // included); W[7] is a proof-plan wallet with a dated, named exception covering day 1 only: its day-1 burn competes like
  // any other burn, its day-3 burn (outside the range) ranks last as an operator burn; C = 0.021 XNT
  {
    const rules: RulesBlockV3 = {
      ...DEFAULT_RULES_V3,
      operatorWallets: {
        rule: "rank-last", wallets: [W[6]],
        exceptions: [{ name: "proof plan 2026-11", wallets: [W[7]], fromTs: T0 + DAY, untilTs: T0 + 2 * DAY, published: iso(T0).slice(0, 10) }],
      },
    };
    const bs = [burn(10, W[6], T0 + 60, 8_000n), burn(10, W[0], T0 + 2 * HOUR, 4_000n), burn(10, W[7], T0 + DAY + HOUR, 4_000n), burn(10, W[1], T0 + DAY + 2 * HOUR, 4_000n, 1), burn(10, W[7], T0 + 3 * DAY, 4_000n)];
    worlds.push(chainOf("d18-operator-exception", "D-18: operator wallets rank last in both passes (operator: true); a dated, named exception (PROOF_BURN_RULE c) makes a burn inside its range ordinary (exception: name)", [
      () => inputs({ epoch: 1, endTs: T0 + WEEK, startTs: T0, F: 262_500_000n, open: null, prev: null, rules, chains: [{ chainId: 10, burns: bs, ...counters(bs) }] }),
    ]));
  }

  world();
  // X-010 + T1-34: the counters continue from the previous record (a skipped chain carries them), and a failed totalSupply
  // read is recorded as null with its reason
  {
    const F = 500n * XNT;
    const a1 = [burn(10, W[0], T0 + DAY, 1_000n), burn(10, W[1], T0 + DAY + HOUR, 1_000n)];
    const b1 = [burn(56, W[2], T0 + 2 * DAY, 1_000n)];
    const a2 = [burn(10, W[3], T0 + WEEK + DAY, 1_000n)];
    worlds.push(chainOf("x010-counters-t134-supply", "X-010: missionsAt / burnedAt recorded and continued (carried by a skipped chain); T1-34: totalSupply null with totalSupplyError", [
      () => inputs({ epoch: 1, endTs: T0 + WEEK, startTs: T0, F, open: null, prev: null, chains: [{ chainId: 10, burns: a1, ...counters(a1) }, { chainId: 56, burns: b1, ...counters(b1), totalSupply: null, totalSupplyError: "totalSupply at block 614800 could not be read: every RPC failed" }] }),
      (p) => inputs({ epoch: 2, endTs: T0 + 2 * WEEK, startTs: nextStart(p!), F, open: openAfter(F, p!), prev: p, chains: [{ chainId: 10, burns: a2, ...counters(a2, 2n, a1.reduce((s, b) => s + BigInt(b.amountWei), 0n)) }] }),
    ]));
  }

  world();
  // D-13 + the feed's option (a): chain 10 at $2,000 of depth. Epoch 1 (genesis) samples every hour, one 10-minute pull
  // reading 0: the daily medians ignore it. Epoch 2: a JIT deposit of $100k at the build (GeckoTerminal $102k, on-chain
  // $101k): the window is valued at the L frozen at epoch 1's build, and the JIT reading is one sample among 24 of its
  // day, so the next window's L does not move either. Chain 56 appears in epoch 2 (a pool 10 days old: the first-reading
  // cap is $500 + 10 × $50 = $1,000, against a reading of $50k). Epoch 3: chain 10's pool is pulled to $200 for a whole
  // day: the window is still valued at the frozen $2,000 and the next window's L falls by the 50% clamp only
  {
    const F = 2_000n * XNT;
    const L0 = 2_000_000_000n;
    const e1End = T0 + WEEK;
    const h = (ts: number) => Math.floor(ts / HOUR);
    const a1 = [burn(10, W[0], T0 + DAY, 3_000_000n), burn(10, W[1], T0 + 3 * DAY, 1_000_000n, 2)];
    const s1 = hourlySamples(h(T0) + 1, h(e1End), L0, { [h(T0 + 2 * DAY + 5 * HOUR)]: 0n });
    const e2Start = e1End + 60;
    const e2End = T0 + 2 * WEEK;
    const a2 = [burn(10, W[2], e2Start + DAY, 3_000_000n)];
    const b2 = [burn(56, W[3], e2Start + 2 * DAY, 3_000_000n)];
    const s2 = hourlySamples(h(e2Start) + 1, h(e2End), L0);
    const e3Start = e2End + 60;
    const e3End = T0 + 3 * WEEK;
    const a3 = [burn(10, W[4], e3Start + DAY, 3_000_000n)];
    const pull: Record<number, bigint> = {};
    for (let x = h(e3Start + 4 * DAY); x < h(e3Start + 4 * DAY) + 24; x++) pull[x] = 200_000_000n;
    const s3 = hourlySamples(h(e3Start) + 1, h(e3End), L0, pull);
    worlds.push(chainOf("d13-frozen-l", "D-13 (a): the window's L is frozen at epoch n−1's build; stat = min of the daily medians of min(GeckoTerminal, on-chain); next = within [50%, 110% + $50]; first-reading cap $500 + $50/day of pool age", [
      () => inputs({ epoch: 1, endTs: e1End, startTs: T0, F, open: null, prev: null, chains: [{ chainId: 10, burns: a1, ...counters(a1), L: L0, onChain: L0, samples: s1 }] }),
      (p) => inputs({
        epoch: 2, endTs: e2End, startTs: e2Start, F, open: openAfter(F, p!), prev: p,
        chains: [
          { chainId: 10, burns: a2, ...counters(a2, 2n, a1.reduce((s, b) => s + BigInt(b.amountWei), 0n)), L: 102_000_000_000n, onChain: 101_000_000_000n, samples: s2 },
          { chainId: 56, burns: b2, ...counters(b2), L: 50_000_000_000n, onChain: null, poolCreatedAt: e2Start - 10 * DAY },
        ],
      }),
      (p) => inputs({
        epoch: 3, endTs: e3End, startTs: e3Start, F, open: openAfter(F, p!), prev: p,
        chains: [{ chainId: 10, burns: a3, ...counters(a3, 3n, [...a1, ...a2].reduce((s, b) => s + BigInt(b.amountWei), 0n)), L: L0, onChain: L0, samples: s3 }],
      }),
    ]));
  }

  world();
  // D-22 (a) + (c): epoch 1 reads the XDEX pool at its build (5 XNT of WXNT): epoch 2's tranches are at most 2% of it a day,
  // so C = 7 × 0.1 XNT = 0.7 XNT instead of 8% of F_ref (8 XNT). Epoch 2's x1report price is 5% above the XDEX TWAP in
  // USDC.X: the guard reads USDC.X at $1.05 and prices every pool reading (the candles at 1.00 USDC.X) at $1.05
  {
    const F = 100n * XNT;
    const xdex: XdexReadingV3 = { pool: "CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR", slot: 77_000, wxntReserveLamports: (5n * XNT).toString(), usdcReserveMicro: "5000000", feeBps: 25 };
    const a1 = [burn(10, W[5], T0 + DAY, 1_000_000n)];
    const a2 = [burn(10, W[6], T0 + WEEK + DAY, 400_000n), burn(10, W[7], T0 + WEEK + DAY + HOUR, 400_000n)];
    worlds.push(chainOf("d22-tranche-cap-peg", "D-22 (a): C ≤ 7 × 2% of the XDEX XNT reserve read at epoch n−1's build; (c): USDC.X above $1.03 (x1report / TWAP) raises every pool reading to the pool-safe price", [
      () => inputs({ epoch: 1, endTs: T0 + WEEK, startTs: T0, F, open: null, prev: null, xdex, chains: [{ chainId: 10, burns: a1, ...counters(a1) }] }),
      (p) => inputs({
        epoch: 2, endTs: T0 + 2 * WEEK, startTs: nextStart(p!), F, open: openAfter(F, p!), prev: p, xdex: null, api: (X1 * 105n) / 100n,
        chains: [{ chainId: 10, burns: a2, ...counters(a2, 1n, a1.reduce((s, b) => s + BigInt(b.amountWei), 0n)) }],
      }),
    ]));
  }

  world();
  // D-21: chain 56 is valued in epoch 1 (its reference: $0.000001), then has no eligible market for 4 epochs in a row (2-5;
  // epoch 3's is a read failure, which neither grows nor ends the run, so the 4th no-market skip is epoch 6). Epoch 6's
  // record announces the orphaning from epoch 7; epoch 7 values its burn of the skipped weeks at half the reference
  // ($0.0000005) with the frozen L. Chain 10 burns every week (each epoch pays somebody)
  {
    const F = 500n * XNT;
    const b56 = [burn(56, W[0], T0 + DAY, 1_000_000n)];
    const late56 = burn(56, W[1], T0 + 3 * WEEK + DAY, 2_000_000n);
    const tens = [1, 2, 3, 4, 5, 6, 7].map((e) => burn(10, W[2 + (e % 3)], T0 + (e - 1) * WEEK + DAY, 1_000_000n));
    let burned10 = 0n;
    const steps: ((p: EpochFileV3 | null) => EpochInputsV3)[] = [];
    for (let e = 1; e <= 7; e++) {
      const ten = [tens[e - 1]];
      const prevAt = BigInt(e - 1);
      const prevBurned = burned10;
      burned10 += BigInt(ten[0].amountWei);
      steps.push((p) => {
        const chains: ChainSpec[] = [{ chainId: 10, burns: ten, ...counters(ten, prevAt, prevBurned) }];
        if (e === 1) chains.push({ chainId: 56, burns: b56, ...counters(b56) });
        if (e === 7) chains.push({ chainId: 56, burns: [late56], ...counters([late56], 1n, BigInt(b56[0].amountWei)), orphan: true });
        const noMarket = e >= 2 && e <= 6 && e !== 3 ? [56] : undefined;
        return inputs({ epoch: e, endTs: T0 + e * WEEK, startTs: e === 1 ? T0 : nextStart(p!), F, open: e === 1 ? null : openAfter(F, p!), prev: p, chains, noMarket });
      });
    }
    worlds.push(chainOf("d21-orphaned-chain", "D-21: 4 skips in a row for lack of a market (a read failure does not count) announce the orphaning one epoch ahead; the orphaned chain's burns are valued at half its reference", steps));
  }

  world();
  // D-22 (b): the active XNT pool A ($9k) and a candidate B. B's median TVL passes 2× A's at epoch 2 (its readings 15k
  // and 30k: median 22.5k > 18k) and stays above at epoch 3: epoch 3 announces the switch, epoch 4 reads B's candles
  {
    const A = "CAJeVEoSm1QQZccnCqYu9cnNF7TTD2fcUA3E5HQoxRvR";
    const B = wallet(77);
    const F = 500n * XNT;
    const tvl = [[9_000, 15_000], [9_000, 30_000], [9_000, 40_000], [9_000, 40_000], [9_000, 40_000]];
    const ten = [1, 2, 3, 4, 5].map((e) => burn(10, W[e % 3], T0 + (e - 1) * WEEK + DAY, 1_000_000n));
    let burned = 0n;
    const steps: ((p: EpochFileV3 | null) => EpochInputsV3)[] = [];
    for (let e = 1; e <= 5; e++) {
      const prevBurned = burned;
      burned += BigInt(ten[e - 1].amountWei);
      steps.push((p) => inputs({
        epoch: e, endTs: T0 + e * WEEK, startTs: e === 1 ? T0 : nextStart(p!), F, open: e === 1 ? null : openAfter(F, p!), prev: p,
        chains: [{ chainId: 10, burns: [ten[e - 1]], ...counters([ten[e - 1]], BigInt(e - 1), prevBurned) }],
        xntPools: [{ pool: A, tvlMicro: (BigInt(tvl[e - 1][0]) * 1_000_000n).toString() }, { pool: B, tvlMicro: (BigInt(tvl[e - 1][1]) * 1_000_000n).toString() }],
      }));
    }
    worlds.push(chainOf("d22b-pool-switch", "D-22 (b): a candidate pool more than 2× the active one's median TVL for 2 builds is announced (next) and read from the next epoch on", steps));
  }
  return worlds;
}

if (require.main === module) {
  const out = path.join(__dirname, "rules-v3-vectors.json");
  const engine = createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", "..", "src", "rewards.ts"), "utf8").replace(/\r\n/g, "\n")).digest("hex");
  const doc = {
    kind: "rules-v3-vectors", version: 1,
    note: "Built by test/fixtures/make-rules-vectors.ts with rewards.ts computeEpochV3; asserted byte for byte by test/rules-v3.test.ts. Mirrors (site lib/quote.ts, kit quote-v3.mjs) assert burns[] order and the allocation fields.",
    engineSha256: engine,
    worlds: vectorWorlds(),
  };
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  console.log(`wrote ${out}: ${doc.worlds.length} worlds, ${doc.worlds.reduce((s, w) => s + w.epochs.length, 0)} files, engine ${engine.slice(0, 16)}…`);
}
