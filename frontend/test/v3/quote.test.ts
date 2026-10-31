/**
 * lib/quote.ts against the oracle's v3 engine (oracle/src/rewards.ts computeEpochV3, imported read-only from this
 * checkout when oracle/node_modules exists) on seeded worlds, plus the committed golden vectors
 * (test/v3/golden/quote-vectors.json) that the kit and the oracle can share. Every burn's arrival outcome (value, base,
 * lp, band, senior, band paid, locked piece, leaf tier, conversion) must be identical.
 *
 * UPDATE_GOLDEN=1 npx vitest run test/v3/quote.test.ts   rewrites the golden file from the engine.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { applyBurn, decayFactor, dayCap, globalOrder, quoteBurn, release, type QuoteInput, type QuoteWeekState } from '../../src/lib/quote';

const ORACLE = path.resolve(__dirname, '../../../oracle');
const oracleReady = fs.existsSync(path.join(ORACLE, 'node_modules', '@solana', 'web3.js')) && fs.existsSync(path.join(ORACLE, 'src', 'rewards.ts'));
const GOLDEN = path.join(__dirname, 'golden', 'quote-vectors.json');

// ── seeded worlds (xorshift64) ────────────────────────────────────────────────────────────────────────────────
function rng(seed: bigint) {
    let x = seed;
    const M = (1n << 64n) - 1n;
    return () => { x ^= (x << 13n) & M; x ^= x >> 7n; x ^= (x << 17n) & M; return x; };
}
const pk = (r: () => bigint) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i += 8) new DataView(b.buffer).setBigUint64(i, r()); return new PublicKey(b).toBase58(); };

interface World { inputs: any }
function world(seed: number, nBurns: number): World {
    const r = rng(BigInt(seed) * 0x9E3779B97F4A7C15n + 1n);
    const pick = (n: number) => Number(r() % BigInt(n));
    const endTs = 1_800_000_000 + pick(86_400);
    const startTs = endTs - 7 * 86_400;
    const chainIds = [10, 56, 8453];
    const wallets = Array.from({ length: 4 }, () => pk(r));
    const usedHours = new Set<string>();
    const chains = chainIds.map((chainId) => ({
        chainId, name: `c${chainId}`, portal: '0x7b00f314aB48D223bee567181CA89c65126Bf6E9', fromBlockExclusive: 100, toBlock: 1_000_000,
        market: { spotE18: String(1_000_000n + r() % 9_000_000n), refUsdE18: String(1_000_000n + r() % 9_000_000n), priceSource: 'test', pools: [] },
        liquidityNowMicro: String(1_000_000_000n + r() % 50_000_000_000n), totalSupply: '1', burns: [] as any[],
    }));
    for (let i = 0; i < nBurns; i++) {
        const c = chains[pick(chains.length)];
        // one burn per (chain, hour): prefix-exact quotes (same-hour burns share a pot, A13.12)
        let ts = startTs + pick(7 * 86_400);
        while (usedHours.has(`${c.chainId}:${Math.floor(ts / 3600)}`)) ts = startTs + pick(7 * 86_400);
        usedHours.add(`${c.chainId}:${Math.floor(ts / 3600)}`);
        const mag = 10n ** BigInt(20 + pick(10)); // 100 … 10^11 XEN
        c.burns.push({
            chainId: c.chainId, txHash: `0x${i.toString(16).padStart(64, '0')}`, logIndex: 0, blockNumber: 101 + i, missionId: String(i + 1), pilot: '0x' + '11'.repeat(20),
            amountWei: String(mag + r() % mag), tier: pick(3), x1: wallets[pick(wallets.length)], timestamp: ts,
            medianE18: String(1_000_000n + r() % 9_000_000n), lastCloseE18: String(1_000_000n + r() % 9_000_000n), priceSource: 'candles',
            xntMedianE18: String(150_000_000_000_000_000n + r() % 100_000_000_000_000_000n), xntLastCloseE18: String(150_000_000_000_000_000n + r() % 100_000_000_000_000_000n), xntSource: 'candles',
        });
    }
    for (const c of chains) {
        c.burns.sort((a: any, b: any) => a.timestamp - b.timestamp);
        c.burns.forEach((b: any, k: number) => { b.blockNumber = 101 + k; });
    }
    const pool = String(5_000_000_000n + r() % 500_000_000_000n);
    return {
        inputs: {
            programId: '57UE1U1t23ztg2noLp8pcpGW1B1Xw25rLH6ra9Mchea9', epoch: 1, createdAt: new Date(endTs * 1000).toISOString(),
            window: { startTs, endTs }, chains, snapshot: { slot: 1, records: [] }, freePool: { lamports: pool, slot: 1, open: null },
            xnt: { twapE18: '190000000000000000', apiE18: '191000000000000000', source: 'test' }, switchRefs: null,
        },
    };
}

/** The mirror's state at the start of a first-epoch week built from the same inputs. */
function startState(inp: any): QuoteWeekState {
    const chains = new Map();
    for (const c of inp.chains) {
        const first = [...c.burns].sort((a: any, b: any) => a.timestamp - b.timestamp)[0];
        const ref = BigInt(c.market.refUsdE18);
        chains.set(c.chainId, {
            chainId: c.chainId, Lprev: null, Lnow: BigInt(c.liquidityNowMicro), S: 0n, hour: first ? Math.floor(first.timestamp / 3600) : 0, hourSpot: 0n,
            capE18: (ref * 12_500n) / 10_000n, spotE18: BigInt(c.market.spotE18),
        });
    }
    const xBuild = [BigInt(inp.xnt.twapE18), BigInt(inp.xnt.apiE18)].reduce((a, b) => (a > b ? a : b));
    return { epoch: 1, startTs: inp.window.startTs, C: (BigInt(inp.freePool.lamports) * 800n) / 10_000n, senior: 0n, xFloorE18: 0n, xBuildE18: xBuild, chains, asOf: inp.window.endTs, skipped: [] };
}

const FIELDS = ['valueMicro', 'base', 'lp', 'ent', 'band', 'senior', 'bandPaid', 'lockedLp'] as const;
/** Runs the mirror over the burns in global order and returns, per burn, the fields the engine records. */
function mirror(inp: any) {
    let s = startState(inp);
    // D-14: the engine's global order, (timestamp, keccak256(txHash ‖ logIndex)), then chainId, block, log index
    const burns = inp.chains.flatMap((c: any) => c.burns).sort(globalOrder);
    return burns.map((b: any) => {
        const q: QuoteInput = {
            chainId: b.chainId, amountWei: BigInt(b.amountWei), tier: b.tier, timestamp: b.timestamp,
            xen: [BigInt(b.medianE18), BigInt(b.lastCloseE18)], xnt: [BigInt(b.xntMedianE18), BigInt(b.xntLastCloseE18)],
        };
        const r = quoteBurn(s, q, s.asOf);
        if (!r.ok) throw new Error(r.reason);
        s = applyBurn(s, q, r);
        return {
            tx: b.txHash, valueMicro: r.value.toString(), base: r.base.toString(), lp: r.lp.toString(), ent: r.ent.toString(), band: r.band.toString(),
            senior: (r.basePaid + r.bandPaid).toString(), bandPaid: r.bandPaid.toString(), lockedLp: r.lockedLp.toString(), leafTier: r.leafTier, converted: r.converted,
        };
    });
}

const SEEDS: [number, number][] = [[1, 6], [2, 25], [3, 60], [4, 120], [5, 3]];

describe('v3 quote: the engine functions', () => {
    it('decay factor matches the published 40-digit reference at 1 h and halves at 336 h', () => {
        expect(decayFactor(1)).toBe(997_939_188_356_834_408n);
        const half = decayFactor(336);
        expect(half <= 500_000_000_000_000_000n && half > 499_999_999_999_999_000n).toBe(true);
    });
    it('daily tranches: the first C mod 7 days release one extra lamport; day 7+ opens the whole week', () => {
        expect(release(700n, 1)).toBe(100n);
        expect(release(703n, 3)).toBe(303n);
        expect(release(703n, 7)).toBe(703n);
        expect(dayCap(703n, 9)).toBe(703n);
    });
    it('fail-closed: no state, a stale state, a skipped chain, a missing price', () => {
        const s = startState(world(9, 4).inputs);
        const b: QuoteInput = { chainId: 10, amountWei: 10n ** 24n, tier: 0, timestamp: s.startTs + 10, xen: [2_000_000n, 2_000_000n], xnt: null };
        expect(quoteBurn(null, b).ok).toBe(false);
        expect(quoteBurn(s, b, s.asOf + 3 * 3600).ok).toBe(false);
        expect(quoteBurn({ ...s, skipped: [10] }, b, s.asOf).ok).toBe(false);
        expect(quoteBurn(s, { ...b, chainId: 137 }, s.asOf).ok).toBe(false);
        expect(quoteBurn({ ...s, xBuildE18: 0n }, b, s.asOf).ok).toBe(false);
        expect(quoteBurn(s, { ...b, amountWei: 0n }, s.asOf).ok).toBe(false);
        const ok = quoteBurn(s, b, s.asOf);
        expect(ok.ok).toBe(true);
    });
    it('a burn beyond today\'s capacity is quoted as paid nothing at arrival', () => {
        const s = startState(world(9, 4).inputs);
        const full = { ...s, senior: dayCap(s.C, 0) };
        const r = quoteBurn(full, { chainId: 10, amountWei: 10n ** 26n, tier: 2, timestamp: s.startTs + 10, xen: [2_000_000n, 2_000_000n], xnt: null }, s.asOf);
        expect(r.ok && r.beyondCapacity && r.paidAtArrival === 0n && r.junior === r.lp).toBe(true);
    });
    it('same chain-hour: the quote is an upper bound (a later burn in the hour lowers it)', () => {
        const s = startState(world(9, 4).inputs);
        const b: QuoteInput = { chainId: 10, amountWei: 10n ** 32n, tier: 0, timestamp: s.startTs - (s.startTs % 3600) + 7200, xen: [2_000_000n, 2_000_000n], xnt: null };
        const r1 = quoteBurn(s, b, s.asOf);
        if (!r1.ok) throw new Error(r1.reason);
        const s2 = applyBurn(s, b, r1);
        const r2 = quoteBurn(s2, { ...b, timestamp: b.timestamp + 10 }, s.asOf);
        expect(r2.ok && r2.value < r1.value).toBe(true);
    });
});

describe.skipIf(!oracleReady)('v3 quote == oracle engine (computeEpochV3, live cross-check)', () => {
    it('every burn of every seeded world', async () => {
        const R = await import('../../../oracle/src/rewards');
        const out: any[] = [];
        for (const [seed, n] of SEEDS) {
            const w = world(seed, n);
            const body = R.computeEpochV3(w.inputs, null);
            expect(body).toBeTruthy();
            const engine = body!.burns.map((b: any) => ({ tx: b.txHash, ...Object.fromEntries(FIELDS.map((f) => [f, b[f]])), leafTier: b.leafTier, converted: b.converted }));
            const m = mirror(w.inputs);
            const first = m.findIndex((x: any, i: number) => JSON.stringify(x) !== JSON.stringify(engine[i]));
            expect(first, first >= 0 ? `seed ${seed} burn ${first}: mirror ${JSON.stringify(m[first])} engine ${JSON.stringify(engine[first])}` : '').toBe(-1);
            out.push({ seed, burns: n, inputs: w.inputs, expected: engine });
        }
        if (process.env.UPDATE_GOLDEN === '1') {
            fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
            fs.writeFileSync(GOLDEN, JSON.stringify({ about: 'v3 quote golden vectors: inputs of oracle/src/rewards.ts computeEpochV3 and each burn’s arrival outcome; shared by the site (lib/quote.ts) and the kit', engine: 'oracle/src/rewards.ts', worlds: out }, null, 1) + '\n');
        } else if (fs.existsSync(GOLDEN)) {
            const g = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
            expect(g.worlds.map((x: any) => x.expected)).toEqual(out.map((x) => x.expected));
        }
    }, 120_000);
    it('the leaf encodings equal the oracle\'s (merkle.ts claimLeaf, extra.ts extraLeaf)', async () => {
        const M = await import('../../../oracle/src/merkle');
        const E = await import('../../../oracle/src/extra');
        const V = await import('../../src/lib/verify-leaf');
        const r = rng(77n);
        for (let i = 0; i < 20; i++) {
            const w = pk(r);
            const amt = r() % (1n << 60n);
            expect(V.toHex(V.baseLeaf(i + 1, w, i % 3, amt))).toBe(M.claimLeaf(BigInt(i + 1), w, i % 3, amt).toString('hex'));
            expect(V.toHex(V.extraLeaf(i + 1, i, w, amt))).toBe(E.extraLeaf(i + 1, i, w, amt).toString('hex'));
        }
        const leaves = Array.from({ length: 5 }, (_, i) => ({ index: i, wallet: pk(r), amount: String(1_000_000 + i) }));
        const t = E.extraTree(3, leaves);
        for (const l of leaves) expect(V.verifyExtraLeaf({ epoch: 3, index: l.index, wallet: l.wallet, amount: l.amount, proof: t.proofs[l.wallet], root: t.root }).ok).toBe(true);
    }, 60_000); // r7 re-run F3: the first import of the oracle modules took longer than the 5 s default on a loaded host
});

describe.skipIf(!fs.existsSync(GOLDEN))('v3 quote == golden vectors (no oracle needed)', () => {
    it('every committed world', () => {
        const g = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
        expect(g.worlds.length).toBeGreaterThan(0);
        for (const w of g.worlds) expect(mirror(w.inputs)).toEqual(w.expected);
    });
});
